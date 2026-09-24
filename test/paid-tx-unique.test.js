/**
 * 支付交易哈希唯一性：
 *  - orders.paid_tx_hash 唯一索引（idx_orders_paid_tx，部分索引：仅非空行受约束）——
 *    同一笔链上支付不得确认两个订单；
 *  - watcher OrderCreated 回写同步落 paid_tx_hash（取链上规范哈希 log.transactionHash；
 *    BTY 双哈希归一，见 escrowWatcher.js / orders.js verifyPaidReceipt 注释），
 *    COALESCE 保证 paid 快路径先落库时不覆盖、缺 meta（单测直调）时保持不变。
 *
 * paid 路由本身的收据校验/归一化依赖真实链 provider（端到端冒烟范围），
 * 此处覆盖 DB 约束与 watcher 落哈希两条可离线验证的路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { db } = ctx;
// 注意：须在 makeCtx（注入测试 env）之后动态 import，config 单例才会读到测试店主地址
const { applyEvent } = await import('../src/escrowWatcher.js');
const { appendOrderCreatedEvent } = await import('../src/routes/orders.js');

let seq = 0;

/** 插入一条订单（escrow_order_id 唯一生成），返回订单行 */
function insertOrder(status = 'draft', paidTxHash = null) {
  seq += 1;
  const id = `ptx-${seq}`;
  const orderIdHex = `0x${String(seq).padStart(64, '0')}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, cny_fen, bty_usdt_rate, usdt_cny_rate, status, escrow_order_id,
       paid_tx_hash, created_at, updated_at)
     VALUES (?, 'p-x', '{}', '0x00', '', '0x00000000000000000000000000000000000000aa', '0x00000000000000000000000000000000000000bb',
       '1000000000000000000', 100, '0.1', '7.2', ?, ?, ?, ?, ?)`
  ).run(id, status, orderIdHex, paidTxHash, now, now);
  return { id, orderIdHex };
}

function rowOf(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

// ── DB 层：唯一索引 ──

test('唯一索引 idx_orders_paid_tx 存在（部分索引：仅 paid_tx_hash 非空行受约束）', () => {
  const idx = db
    .prepare("SELECT name FROM pragma_index_list('orders') WHERE name = 'idx_orders_paid_tx' AND \"unique\" = 1")
    .get();
  assert.ok(idx, '应存在 paid_tx_hash 唯一索引');
});

test('同一 paid_tx_hash 不能落两个订单（一笔链上支付只能确认一单）', () => {
  const a = insertOrder('draft');
  db.prepare("UPDATE orders SET paid_tx_hash = ? WHERE id = ?").run('0x' + 'a'.repeat(64), a.id);

  const b = insertOrder('draft');
  assert.throws(
    () => db.prepare("UPDATE orders SET paid_tx_hash = ? WHERE id = ?").run('0x' + 'a'.repeat(64), b.id),
    /UNIQUE constraint failed/i,
    '第二个订单写入同一支付哈希应被唯一索引拒绝'
  );
});

test('paid_tx_hash 为空（未支付单）不受唯一约束，可多单并存', () => {
  const a = insertOrder('draft');
  const b = insertOrder('draft');
  const c = insertOrder('escrowed');
  assert.equal(rowOf(a.id).paid_tx_hash, null);
  assert.equal(rowOf(b.id).paid_tx_hash, null);
  assert.equal(rowOf(c.id).paid_tx_hash, null);
});

// ── watcher 路径：OrderCreated 回写同步落支付哈希 ──

test('OrderCreated 带链上 txHash：回写 escrowed 同时落 paid_tx_hash（与事件史同值）', () => {
  const a = insertOrder('draft');
  const txHash = '0x' + 'c'.repeat(64);
  assert.equal(applyEvent('OrderCreated', { orderId: a.orderIdHex }, { txHash, block: 100 }), 1);
  const row = rowOf(a.id);
  assert.equal(row.status, 'escrowed');
  assert.equal(row.paid_tx_hash, txHash, '回写时同步落链上规范哈希作支付凭证');
  // 与事件史首条（OrderCreated）哈希一致，详情页两处可互证
  const events = JSON.parse(row.onchain_events);
  assert.equal(events[0].txHash, txHash);
});

test('OrderCreated 缺 meta（单测直调/兼容旧调用）：仅推进状态，paid_tx_hash 保持空', () => {
  const a = insertOrder('draft');
  assert.equal(applyEvent('OrderCreated', { orderId: a.orderIdHex }), 1);
  assert.equal(rowOf(a.id).status, 'escrowed');
  assert.equal(rowOf(a.id).paid_tx_hash, null);
});

test('paid 快路径先落哈希后 watcher 事件后到：COALESCE 不覆盖已落库哈希', () => {
  const a = insertOrder('draft');
  // 模拟 POST /:id/paid 已先写入规范哈希 D（库内唯一，避免与其他用例撞唯一索引）
  db.prepare("UPDATE orders SET paid_tx_hash = ? WHERE id = ?").run('0x' + 'd'.repeat(64), a.id);
  // watcher 轮询到 OrderCreated（同为该链上交易的日志哈希，理论同值；异值亦不得覆盖）
  assert.equal(applyEvent('OrderCreated', { orderId: a.orderIdHex }, { txHash: '0x' + 'e'.repeat(64), block: 7 }), 1);
  assert.equal(rowOf(a.id).paid_tx_hash, '0x' + 'd'.repeat(64), '已落库哈希不得被 watcher 覆盖');
});

// ── paid 快路径事件史补写（凭证链完整性，见 orders.js appendOrderCreatedEvent）──

test('paid 快路径补写 OrderCreated 事件史：凭证链完整（详情页/信誉画像同口径）', () => {
  const a = insertOrder('escrowed'); // 模拟 paid 已置 escrowed（watcher 事件不再迁移）
  const txHash = '0x' + '1'.repeat(64); // 库内唯一哈希（避免与其他用例撞唯一索引）
  db.prepare('UPDATE orders SET paid_tx_hash = ? WHERE id = ?').run(txHash, a.id);
  appendOrderCreatedEvent(a.id, { txHash, block: 42 });
  const events = JSON.parse(rowOf(a.id).onchain_events);
  assert.equal(events.length, 1, '补写一条 OrderCreated');
  assert.equal(events[0].name, 'OrderCreated');
  assert.equal(events[0].txHash, txHash, '与支付凭证同哈希，两处可互证');
  assert.equal(events[0].block, 42);
});

test('补写幂等：watcher 已记录 OrderCreated 或重复调用不重复追加', () => {
  // watcher 已先行记录（状态由 watcher 迁移，事件史完整）
  const b = insertOrder('draft');
  const txHash = '0x' + 'e'.repeat(64);
  assert.equal(applyEvent('OrderCreated', { orderId: b.orderIdHex }, { txHash, block: 7 }), 1);
  appendOrderCreatedEvent(b.id, { txHash, block: 99 });
  let events = JSON.parse(rowOf(b.id).onchain_events);
  assert.equal(events.filter((x) => x.name === 'OrderCreated').length, 1, 'watcher 已记不重复');
  // 重复补写（paid 主路径与 notePaidTxHash 双调用点都走同一函数）
  appendOrderCreatedEvent(b.id, { txHash, block: 99 });
  events = JSON.parse(rowOf(b.id).onchain_events);
  assert.equal(events.length, 1, '重复补写幂等');
});
