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
import { makeCtx, shopRef, insertOrder as insertOrderRow } from './setup.mjs';

const ctx = await makeCtx();
const { db, owner, buyer } = ctx;

const { anchorVerdict, applyEscrowAnchor, escrowAnchorStatus, inflightChainOrders } = await import('../src/chainAnchor.js');

const A1 = '0x' + 'aa'.repeat(20);
const A2 = '0x' + 'bb'.repeat(20);


/**
 * 本文件造过的在途单的**内部主键**（`orders.id`）：`inflightChainOrders()` 是全表计数，
 * 残留行会改变别的用例的结果，所以每条都要能按主键删掉。声明必须在使用它的夹具之前。
 */
const inflightIds = [];

/**
 * 造一笔"链上已有单"的在途订单（直接插行：本用例测的是地址锚定，不是下单流程）。
 *
 * **必须给 `escrowOrderId`**：`inflightChainOrders()` 是按 `orders JOIN order_chain` 数的
 * （链上单号住在 1:1 子表里），没有那一行就不算"链上已有单"——这正是下面"草稿不算在途"的判据。
 */
async function insertInflight(seq, status = 'escrowed') {
  const row = await insertOrderRow(db, {
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    status,
    productSlug: 'anchor-slug',
    amountWei: '1000000000000000000',
    usdtMicro: 100,
    holdQty: 0,
    escrowOrderId: '0x' + String(seq).padStart(64, '0'),
    paidTxHash: '0x' + String(seq + 100).padStart(64, '0'),
  });
  /*
    记下主键：用例之间的清理必须按**内部主键**删（旧形状是 `WHERE id LIKE 'anchor-order-%'`，
    那串字符串 id 已经不存在了）。`orders` 的子表是 ON DELETE CASCADE，删主行即删镜像行。
  */
  inflightIds.push(row.orderId);
  return row;
}

/** 删掉本文件造过的在途单（`inflightChainOrders()` 是全表计数，残留行会改变别的用例的结果） */
const clearInflight = async () => {
  if (inflightIds.length) {
    await db.run(`DELETE FROM orders WHERE id IN (${inflightIds.map(() => '?').join(', ')})`, ...inflightIds);
    inflightIds.length = 0;
  }
};

/** 地址锚的读法（`node` 单例行的列；旧形状是 kv 里的 `mk:escrow_address`） */
const storedAnchor = async () => (await db.get('SELECT escrow_address FROM node WHERE id = 1'))?.escrow_address ?? null;
/** 清掉锚点（模拟"这台机器还没记过地址"） */
const clearAnchor = async () => await db.run('UPDATE node SET escrow_address = NULL WHERE id = 1');

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

/* ── 接线（node 单例行 + 库） ───────────────────────────────────────── */

test('首次启动记录地址；同一地址再启动不重复写；换址且无在途单则更新', async () => {
  await clearAnchor();
  // 锚定要读 node 那一行与在途单计数（异步库调用），所以**必须 await**：不 await 时读到的是 Promise，
  // `String(Promise)` 恒为 "[object Promise]" ⇒ 每次启动都被判成"换址"（见 chainAnchor 的说明）
  const first = await applyEscrowAnchor({ envAddress: A1 });
  assert.equal(first.level, 'record');
  assert.equal(await storedAnchor(), A1, '首次启动必须把地址落进 node.escrow_address（否则下次换址没人能比）');

  const again = await applyEscrowAnchor({ envAddress: A1 });
  assert.equal(again.level, 'ok');
  const other = await applyEscrowAnchor({ envAddress: A2 });
  assert.equal(other.level, 'warn');
  assert.equal(await storedAnchor(), A2);
  assert.equal(escrowAnchorStatus().level, 'warn', '/healthz 要能看到最近一次判定');
  assert.equal(escrowAnchorStatus().previous, A1);
});

test('有在途链上单时换址 ⇒ 拒绝且**不改写** node.escrow_address；ack 后才允许换', async () => {
  await clearAnchor();
  await applyEscrowAnchor({ envAddress: A1 });
  await insertInflight(1, 'escrowed');
  await insertInflight(2, 'shipped');
  await insertInflight(3, 'confirmed'); // 终态不算在途
  assert.equal(await inflightChainOrders(), 2, '只数 escrowed/shipped/disputed（终态与草稿不算）');

  const refused = await applyEscrowAnchor({ envAddress: A2 });
  assert.equal(refused.ok, false);
  assert.equal(await storedAnchor(), A1, '拒绝启动时绝不能把新地址写进 node.escrow_address');

  const acked = await applyEscrowAnchor({ envAddress: A2, ack: true });
  assert.equal(acked.ok, true);
  assert.equal(acked.level, 'ack');
  assert.equal(await storedAnchor(), A2);
});

test('草稿（未上链）与无单号行不计入在途链上单', async () => {
  await clearAnchor();
  await clearInflight();
  /*
    草稿：**显式 `escrowOrderId: null`** ⇒ 连链上镜像行都没有。
    这正是本用例要钉的形状——"有没有上链"在新 schema 里就是"有没有 order_chain 那一行"
    （链上单号住在子表上），凭空给草稿补一行会让它在途计数变成 1，这条断言就失去意义了。
  */
  await insertOrderRow(db, {
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    status: 'draft',
    productSlug: 'anchor-slug',
    amountWei: '1',
    usdtMicro: 1,
    escrowOrderId: null,
  });
  assert.equal(await inflightChainOrders(), 0, '草稿从没上链，换址与它无关（不该拦启动）');
  await clearInflight();
});
