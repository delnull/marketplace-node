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
import { makeCtx, shopRef, insertOrder as insertOrderRow } from './setup.mjs';

const ctx = await makeCtx();
const { db } = ctx;
// 注意：须在 makeCtx（注入测试 env）之后动态 import，config 单例才会读到测试店主地址
const { applyEvent } = await import('../src/escrowWatcher.js');
const { appendOrderCreatedEvent } = await import('../src/routes/orders.js');

let seq = 0;

/**
 * 插入一条订单（链上单号每单唯一），返回 `{ orderId, orderNo, escrowOrderId }`。
 * 行形状交给 setup.mjs 的 insertOrder：`paid_tx_hash` / `escrow_order_id` 住在 `order_chain`。
 */
async function insertOrder(status = 'draft', paidTxHash = null) {
  seq += 1;
  return await insertOrderRow(db, {
    status,
    productSlug: 'p-x',
    buyer: '0x00000000000000000000000000000000000000aa',
    seller: '0x00000000000000000000000000000000000000bb',
    amountWei: '1000000000000000000',
    usdtMicro: 1000000,
    btyUsdtRate: '0.1',
    escrowOrderId: `0x${String(seq).padStart(64, '0')}`,
    paidTxHash,
  });
}

async function rowOf(orderId) {
  return await db.get('SELECT * FROM v_orders WHERE order_id = ?', orderId);
}

// ── DB 层：唯一索引 ──

/*
  `paid_tx_hash` 现在住在 `order_chain`（链上镜像表），索引叫 `uq_chain_paid`。
  旧形状那条 `uq_orders_paid_tx` 靠 `IF(paid_tx_hash IS NULL OR paid_tx_hash = '', NULL, …)` 的
  函数索引把空串折成 NULL——**那条技巧整条删掉了**：新 schema 用 NULL 表示"未支付"，
  而 MySQL 的唯一索引本来就不约束 NULL，所以一个普通 UNIQUE 就够，不必再折。
*/
test('唯一索引 uq_chain_paid 存在（NULL = 未支付，不参与唯一约束）', async () => {
  const idx = await db.get(
    `SELECT INDEX_NAME AS name FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_chain'
        AND INDEX_NAME = 'uq_chain_paid' AND NON_UNIQUE = 0`
  );
  assert.ok(idx, '应存在 order_chain.paid_tx_hash 唯一索引');
});

test('同一 paid_tx_hash 不能落两个订单（一笔链上支付只能确认一单）', async () => {
  const a = await insertOrder('draft');
  await db.run("UPDATE order_chain SET paid_tx_hash = ? WHERE order_id = ?", '0x' + 'a'.repeat(64), a.orderId);

  const b = await insertOrder('draft');
  await assert.rejects(
    async () => await db.run("UPDATE order_chain SET paid_tx_hash = ? WHERE order_id = ?", '0x' + 'a'.repeat(64), b.orderId),
    /Duplicate entry/i,
    '第二个订单写入同一支付哈希应被唯一索引拒绝'
  );
});

test('paid_tx_hash 为 NULL（未支付单）不受唯一约束，可多单并存', async () => {
  const a = await insertOrder('draft');
  const b = await insertOrder('draft');
  const c = await insertOrder('escrowed');
  assert.equal((await rowOf(a.orderId)).paid_tx_hash, null);
  assert.equal((await rowOf(b.orderId)).paid_tx_hash, null);
  assert.equal((await rowOf(c.orderId)).paid_tx_hash, null);
});

// ── watcher 路径：OrderCreated 回写同步落支付哈希 ──

test('OrderCreated 带链上 txHash：回写 escrowed 同时落 paid_tx_hash（与事件史同值）', async () => {
  const a = await insertOrder('draft');
  const txHash = '0x' + 'c'.repeat(64);
  assert.equal(await applyEvent('OrderCreated', { orderId: a.escrowOrderId }, { txHash, block: 100 }), 1);
  const row = await rowOf(a.orderId);
  assert.equal(row.status, 'escrowed');
  assert.equal(row.paid_tx_hash, txHash, '回写时同步落链上规范哈希作支付凭证');
  // 与事件史首条（OrderCreated）哈希一致，详情页两处可互证
  const events = row.onchain_events;
  assert.equal(events[0].txHash, txHash);
});

test('OrderCreated 缺 meta（单测直调/兼容旧调用）：仅推进状态，paid_tx_hash 保持空', async () => {
  const a = await insertOrder('draft');
  assert.equal(await applyEvent('OrderCreated', { orderId: a.escrowOrderId }), 1);
  assert.equal((await rowOf(a.orderId)).status, 'escrowed');
  assert.equal((await rowOf(a.orderId)).paid_tx_hash, null);
});

test('paid 快路径先落哈希后 watcher 事件后到：COALESCE 不覆盖已落库哈希', async () => {
  const a = await insertOrder('draft');
  // 模拟 POST /:id/paid 已先写入规范哈希 D（库内唯一，避免与其他用例撞唯一索引）
  await db.run("UPDATE order_chain SET paid_tx_hash = ? WHERE order_id = ?", '0x' + 'd'.repeat(64), a.orderId);
  // watcher 轮询到 OrderCreated（同为该链上交易的日志哈希，理论同值；异值亦不得覆盖）
  assert.equal(await applyEvent('OrderCreated', { orderId: a.escrowOrderId }, { txHash: '0x' + 'e'.repeat(64), block: 7 }), 1);
  assert.equal((await rowOf(a.orderId)).paid_tx_hash, '0x' + 'd'.repeat(64), '已落库哈希不得被 watcher 覆盖');
});

// ── paid 快路径事件史补写（凭证链完整性，见 orders.js appendOrderCreatedEvent）──

test('paid 快路径补写 OrderCreated 事件史：凭证链完整（详情页/信誉画像同口径）', async () => {
  const a = await insertOrder('escrowed'); // 模拟 paid 已置 escrowed（watcher 事件不再迁移）
  const txHash = '0x' + '1'.repeat(64); // 库内唯一哈希（避免与其他用例撞唯一索引）
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE order_id = ?', txHash, a.orderId);
  await appendOrderCreatedEvent(a.orderId, { txHash, block: 42 });
  const events = (await rowOf(a.orderId)).onchain_events;
  assert.equal(events.length, 1, '补写一条 OrderCreated');
  assert.equal(events[0].name, 'OrderCreated');
  assert.equal(events[0].txHash, txHash, '与支付凭证同哈希，两处可互证');
  assert.equal(events[0].block, 42);
});

test('补写幂等：watcher 已记录 OrderCreated 或重复调用不重复追加', async () => {
  // watcher 已先行记录（状态由 watcher 迁移，事件史完整）
  const b = await insertOrder('draft');
  const txHash = '0x' + 'e'.repeat(64);
  assert.equal(await applyEvent('OrderCreated', { orderId: b.escrowOrderId }, { txHash, block: 7 }), 1);
  await appendOrderCreatedEvent(b.orderId, { txHash, block: 99 });
  let events = (await rowOf(b.orderId)).onchain_events;
  assert.equal(events.filter((x) => x.name === 'OrderCreated').length, 1, 'watcher 已记不重复');
  // 重复补写（paid 主路径与 notePaidTxHash 双调用点都走同一函数）
  await appendOrderCreatedEvent(b.orderId, { txHash, block: 99 });
  events = (await rowOf(b.orderId)).onchain_events;
  assert.equal(events.length, 1, '重复补写幂等');
});
