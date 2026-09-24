/**
 * 托管合约地址锚点（`src/chainAnchor.js`）的回归测试。
 *
 * 对应源码评审 2026-09 的 P0-1 运行时那一半：订单行**不存**合约地址，节点只认单一
 * `MK_ESCROW_ADDRESS`；把地址改成另一个 Escrow 时，本地指向旧实例的在途单不会报错，
 * 只是永远查不到（钱还在旧合约里，店主以为在等发货）。所以"换址"必须在启动期变成可见判定：
 * 有在途链上单就默认拒绝启动，除非显式 MK_ESCROW_CHANGE_ACK=1。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { db, owner, buyer } = ctx;

const { anchorVerdict, applyEscrowAnchor, escrowAnchorStatus, inflightChainOrders } = await import('../src/chainAnchor.js');
const { kvGet } = await import('../src/db.js');

const A1 = '0x' + 'aa'.repeat(20);
const A2 = '0x' + 'bb'.repeat(20);
const KEY = 'mk:escrow_address';

/** 造一笔"链上已有单"的在途订单（直接插行：本用例测的是地址锚定，不是下单流程） */
function insertInflight(seq, status = 'escrowed') {
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       quantity, hold_qty, amount_wei, cny_fen, status, escrow_order_id, paid_tx_hash, created_at, updated_at)
     VALUES (?, 'anchor-slug', '{}', '0x' + '00', '', ?, ?, 1, 0, '1000000000000000000', 100, ?, ?, ?, ?, ?)`
  ).run(
    `anchor-order-${seq}`,
    buyer.address.toLowerCase(),
    owner.address.toLowerCase(),
    status,
    '0x' + String(seq).padStart(64, '0'),
    '0x' + String(seq + 100).padStart(64, '0'),
    Date.now(),
    Date.now()
  );
}

/* ── 纯决策 ─────────────────────────────────────────────────────────── */

test('anchorVerdict：未配置地址 / 首次记录 / 地址未变 / 大小写与空白不算变化', () => {
  assert.equal(anchorVerdict({ envAddress: '' }).level, 'skip');
  assert.equal(anchorVerdict({ envAddress: A1 }).level, 'record');
  assert.equal(anchorVerdict({ envAddress: A1, storedAddress: A1 }).level, 'ok');
  // env 手抄进来的大小写/空格不该被当成"换址"（否则每次启动都要拒绝一次）
  assert.equal(anchorVerdict({ envAddress: `  ${A1.toUpperCase()}  `, storedAddress: A1 }).level, 'ok');
});

test('anchorVerdict：换址且本地没有在途链上单 ⇒ 允许启动（warn + 记新址）', () => {
  const v = anchorVerdict({ envAddress: A2, storedAddress: A1, inflightCount: 0 });
  assert.equal(v.level, 'warn');
  assert.equal(v.ok, true);
  assert.equal(v.action, 'record');
  assert.match(v.reason, /改为/);
});

test('anchorVerdict：换址且本地还有在途链上单 ⇒ 默认拒绝启动，报错必须给出处置步骤', () => {
  const v = anchorVerdict({ envAddress: A2, storedAddress: A1, inflightCount: 3 });
  assert.equal(v.level, 'refuse');
  assert.equal(v.ok, false, '有在途单时不得静默换址');
  assert.equal(v.action, 'none', '拒绝时不得写新地址（否则真重启一次就把锚点覆盖了）');
  // 三条出路都要说清楚：旧合约上了结 / 重建库 / 显式 ack
  assert.match(v.reason, /先把旧实例上的这些单了结/);
  assert.match(v.reason, /重建节点库/);
  assert.match(v.reason, /MK_ESCROW_CHANGE_ACK=1/);
});

test('anchorVerdict：显式 ack ⇒ 明知有在途单仍换址（ok + 记新址 + 措辞写明后果）', () => {
  const v = anchorVerdict({ envAddress: A2, storedAddress: A1, inflightCount: 3, ack: true });
  assert.equal(v.level, 'ack');
  assert.equal(v.ok, true);
  assert.equal(v.action, 'record');
  assert.match(v.reason, /明知有 3 笔在途链上单/);
});

/* ── 接线（kv + 库） ───────────────────────────────────────────────── */

test('首次启动记录地址；同一地址再启动不重复写；换址且无在途单则更新', () => {
  db.prepare('DELETE FROM kv WHERE key = ?').run(KEY);
  const first = applyEscrowAnchor({ envAddress: A1 });
  assert.equal(first.level, 'record');
  assert.equal(kvGet(KEY, null), A1, '首次启动必须把地址落进 kv（否则下次换址没人能比）');

  const again = applyEscrowAnchor({ envAddress: A1 });
  assert.equal(again.level, 'ok');
  const other = applyEscrowAnchor({ envAddress: A2 });
  assert.equal(other.level, 'warn');
  assert.equal(kvGet(KEY, null), A2);
  assert.equal(escrowAnchorStatus().level, 'warn', '/healthz 要能看到最近一次判定');
  assert.equal(escrowAnchorStatus().previous, A1);
});

test('有在途链上单时换址 ⇒ 拒绝且**不改写** kv；ack 后才允许换', () => {
  db.prepare('DELETE FROM kv WHERE key = ?').run(KEY);
  applyEscrowAnchor({ envAddress: A1 });
  insertInflight(1, 'escrowed');
  insertInflight(2, 'shipped');
  insertInflight(3, 'confirmed'); // 终态不算在途
  assert.equal(inflightChainOrders(), 2, '只数 escrowed/shipped/disputed（终态与草稿不算）');

  const refused = applyEscrowAnchor({ envAddress: A2 });
  assert.equal(refused.ok, false);
  assert.equal(kvGet(KEY, null), A1, '拒绝启动时绝不能把新地址写进 kv');

  const acked = applyEscrowAnchor({ envAddress: A2, ack: true });
  assert.equal(acked.ok, true);
  assert.equal(acked.level, 'ack');
  assert.equal(kvGet(KEY, null), A2);
});

test('草稿（未上链）与无单号行不计入在途链上单', () => {
  db.prepare('DELETE FROM kv WHERE key = ?').run(KEY);
  db.prepare("DELETE FROM orders WHERE id LIKE 'anchor-order-%'").run();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       quantity, hold_qty, amount_wei, cny_fen, status, escrow_order_id, created_at, updated_at)
     VALUES ('anchor-draft', 'anchor-slug', '{}', '0x' + '00', '', ?, ?, 1, 0, '1', 1, 'draft', NULL, ?, ?)`
  ).run(buyer.address.toLowerCase(), owner.address.toLowerCase(), Date.now(), Date.now());
  assert.equal(inflightChainOrders(), 0, '草稿从没上链，换址与它无关（不该拦启动）');
  db.prepare("DELETE FROM orders WHERE id LIKE 'anchor-%'").run();
});
