/**
 * P1-② 批量操作与 CSV 导出：
 *  - batch-ship：仅实物+escrowed+有凭证+非冻结；条件矩阵与逐单通知；
 *  - PATCH /products/batch：字段非法整体拒、个别 slug 不存在跳过、价格变更重算快照哈希；
 *  - 导出：orders/products/codes.csv 列白名单与 BOM/权限（codes.csv 仅 owner）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();

/**
 * 交付闸读的是**链上真值**（见 chainOrder.deliveryGate）：本文件只关心批量筛选的语义，
 * 所以默认链上"这一单在托管中且未申请退款"；需要"链上已冻结"的单显式加进 `frozenOnChain`。
 * （镜像滞后于链上那个窗口本身由 test/delivery-gate.test.js 钉住。）
 */
const { setChainOrderFetcher } = await import('../src/chainOrder.js');
const frozenOnChain = new Set();
setChainOrderFetcher(async (orderIdHex) => {
  const id = String(orderIdHex || '').toLowerCase();
  const row = await db.get(
    `SELECT buyer, seller, amount_wei, timeout_blocks
       FROM v_orders WHERE escrow_order_id = ?`,
    id
  );
  if (!row) throw new Error('unit-test 链上桩：链上没有这一单');
  return {
    status: 'Created',
    refundRequested: frozenOnChain.has(id),
    refundRejected: false,
    refundedAmount: '0',
    buyer: row.buyer,
    seller: row.seller,
    amount: row.amount_wei,
    timeoutBlocks: Number(row.timeout_blocks),
  };
});

let ownerToken;
let buyerToken;
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
});

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, buyer: buyer.address })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

async function escrowed(order) {
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), order.id);
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', payHash(), order.id);
}

test('batch-ship：实物多单同单号发货；拒绝数字/无凭证/退款冻结/不存在', async () => {
  const ph = await listProduct(productPayload({ kind: 'physical', title: '批量实物', capacity: 50 }));
  const dg = await listProduct(productPayload({ kind: 'digital', title: '批量数字' }));
  const o1 = await createDraft(ph.slug);
  const o2 = await createDraft(ph.slug);
  await escrowed(o1);
  await escrowed(o2);
  const d1 = await createDraft(dg.slug);
  await escrowed(d1);
  const noReceipt = await createDraft(ph.slug); // 无凭证异常单（escrowed 但 paid_tx_hash 为空）
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), noReceipt.id);
  const frozen = await createDraft(ph.slug);
  await escrowed(frozen);
  await db.run("UPDATE order_chain SET refund_status = 'requested' WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)", frozen.id);
  // 镜像与链上一致：链上也确实冻结（交付闸判的是链上那个真值）
  frozenOnChain.add(String(frozen.escrowOrderId).toLowerCase());

  const res = await request(app)
    .post('/api/orders/seller/batch-ship')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ ids: [o1.id, o2.id, d1.id, noReceipt.id, frozen.id, 'missing-id'], trackingNo: 'BATCH-001' })
    .expect(200);
  assertOk(res);
  const { shipped, failed } = res.body.data;
  assert.deepEqual(shipped.sort(), [o1.id, o2.id].sort(), '仅两张实物正常单');
  const reasons = Object.fromEntries(failed.map((f) => [f.id, f.reason]));
  assert.match(reasons[d1.id] || '', /非实物/);
  assert.match(reasons[noReceipt.id] || '', /凭证/);
  assert.match(reasons[frozen.id] || '', /退款申请/);
  assert.match(reasons['missing-id'] || '', /不存在/);
  const st1 = await db.get('SELECT status, tracking_no FROM v_orders WHERE order_no = ?', o1.id);
  assert.equal(st1.status, 'shipped');
  assert.equal(st1.tracking_no, 'BATCH-001');
});

test('PATCH /products/batch：非法字段整体拒；不存在 slug 跳过；价格变更重算快照', async () => {
  const p1 = await listProduct(productPayload({ title: '批量商品1', priceUsdtMicro: 10_000_000 }));
  const p2 = await listProduct(productPayload({ title: '批量商品2', priceUsdtMicro: 20_000_000 }));
  const hash1 = p1.snapshotHash;

  // 非法字段 → 整体拒绝（无半写）
  const bad = await request(app)
    .patch('/api/products/batch')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ slugs: [p1.slug, p2.slug], patch: { priceUsdtMicro: -5 } })
    .expect(200);
  assert.notEqual(bad.body.code, 0);
  const unchanged = await request(app).get(`/api/products/${p1.slug}`).expect(200);
  assert.equal(unchanged.body.data.priceUsdtMicro, 10_000_000);

  // 个别 slug 不存在 → failed 跳过，其余更新 + 价格快照重算 + 上下架
  const res = await request(app)
    .patch('/api/products/batch')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ slugs: [p1.slug, p2.slug, 'p-not-exist'], patch: { priceUsdtMicro: 30_000_000, active: false } })
    .expect(200);
  assertOk(res);
  assert.deepEqual(res.body.data.updated, [p1.slug, p2.slug]);
  assert.equal(res.body.data.failed.length, 1);
  // 下架商品详情：匿名 404（防探测），店主令牌可预览
  const after1 = await request(app).get(`/api/products/${p1.slug}`).expect(404);
  const preview = await request(app)
    .get(`/api/products/${p1.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.equal(preview.body.data.priceUsdtMicro, 30_000_000);
  assert.equal(preview.body.data.active, false);
  assert.notEqual(preview.body.data.snapshotHash, hash1, '价格变更重算快照哈希');
});

test('CSV 公式注入防护：外部可控文本字段（收货姓名）以 = 开头时加前缀；码原文原样', async () => {
  const ph = await listProduct(productPayload({ kind: 'physical', title: '公式注入商品', capacity: 10 }));
  const o = await createDraft(ph.slug);
  await escrowed(o);
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", new Date(), o.id);
  await db.run('UPDATE order_shipping SET name = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_shipping.order_id AND o.order_no = ?)', '=1+1', o.id);
  const csv = await request(app)
    .get('/api/shop/export/orders.csv?status=confirmed')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.ok(csv.text.includes("'=1+1"), '公式前缀已加（外部输入不触发 Excel 执行）');
  // 码原文以 = 开头时不加前缀（值完整性优先——店主持有资源，非买家可控）
  const dg = await listProduct(productPayload({ kind: 'digital', title: '公式码商品' }));
  await request(app)
    .post(`/api/products/${dg.slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ codes: ['=X1'] })
    .expect(200);
  const codes = await request(app)
    .get(`/api/shop/export/codes.csv?slug=${dg.slug}&status=unused`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.ok(codes.text.includes(',=X1,') || codes.text.includes('\n=X1,'), '码导出不加公式前缀');
});

test('导出：orders.csv 列白名单与 BOM；权限（匿名 401）；codes.csv 仅 owner', async () => {
  const ph = await listProduct(productPayload({ kind: 'physical', title: '导出商品', capacity: 10 }));
  const o = await createDraft(ph.slug);
  await escrowed(o);
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", new Date(), o.id);
  await db.run('UPDATE order_shipping SET name = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_shipping.order_id AND o.order_no = ?)', '张三', o.id);

  const csvRes = await request(app)
    .get('/api/shop/export/orders.csv?status=confirmed')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.match(csvRes.headers['content-type'], /text\/csv/);
  const text = csvRes.text;
  assert.ok(text.startsWith('\uFEFF'), 'UTF-8 BOM');
  assert.ok(text.includes(o.id) && text.includes('张三'), '含订单与收货信息（店主私域）');
  assert.ok(text.includes('amount_net_wei'));
  // 匿名拒绝
  await request(app).get('/api/shop/export/orders.csv').expect(401);

  // codes.csv：数字商品有码才能导出；陌生买家登录（非 owner）403
  const dg = await listProduct(productPayload({ kind: 'digital', title: '导出码商品' }));
  await request(app)
    .post(`/api/products/${dg.slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ codes: ['CSV-KEY-1', 'CSV,K-EY-2'] })
    .expect(200);
  const codes = await request(app)
    .get(`/api/shop/export/codes.csv?slug=${dg.slug}&status=unused`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.ok(codes.text.includes('CSV-KEY-1'));
  assert.ok(codes.text.includes('"CSV,K-EY-2"'), '含逗号字段加引号转义');
  const asBuyer = await request(app)
    .get(`/api/shop/export/codes.csv?slug=${dg.slug}`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value);
  assert.equal(asBuyer.status, 403, '码原文导出仅 owner');
  // 非数字商品 codes.csv 404
  await request(app)
    .get(`/api/shop/export/codes.csv?slug=${ph.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(404);
});
