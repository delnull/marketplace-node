/**
 * P1-② 批量操作与 CSV 导出：
 *  - batch-ship：仅实物+escrowed+有凭证+非冻结；条件矩阵与逐单通知；
 *  - PATCH /products/batch：字段非法整体拒、个别 slug 不存在跳过、价格变更重算快照哈希；
 *  - 导出：orders/products/codes.csv 列白名单与 BOM/权限（codes.csv 仅 owner）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();

let ownerToken;
let buyerToken;
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
});

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ productSlug: slug, buyer: buyer.address })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

function escrowed(order) {
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), order.id);
}

test('batch-ship：实物多单同单号发货；拒绝数字/无凭证/退款冻结/不存在', async () => {
  const ph = await listProduct(productPayload({ kind: 'physical', title: '批量实物', capacity: 50 }));
  const dg = await listProduct(productPayload({ kind: 'digital', title: '批量数字' }));
  const o1 = await createDraft(ph.slug);
  const o2 = await createDraft(ph.slug);
  escrowed(o1);
  escrowed(o2);
  const d1 = await createDraft(dg.slug);
  escrowed(d1);
  const noReceipt = await createDraft(ph.slug); // 无凭证异常单（escrowed 但 paid_tx_hash 为空）
  db.prepare("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE id = ?").run(Date.now(), noReceipt.id);
  const frozen = await createDraft(ph.slug);
  escrowed(frozen);
  db.prepare("UPDATE orders SET refund_status = 'requested' WHERE id = ?").run(frozen.id);

  const res = await request(app)
    .post('/api/orders/seller/batch-ship')
    .set('Authorization', `Bearer ${ownerToken}`)
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
  const st1 = db.prepare('SELECT status, tracking_no FROM orders WHERE id = ?').get(o1.id);
  assert.equal(st1.status, 'shipped');
  assert.equal(st1.tracking_no, 'BATCH-001');
});

test('PATCH /products/batch：非法字段整体拒；不存在 slug 跳过；价格变更重算快照', async () => {
  const p1 = await listProduct(productPayload({ title: '批量商品1', priceCnyFen: 1000 }));
  const p2 = await listProduct(productPayload({ title: '批量商品2', priceCnyFen: 2000 }));
  const hash1 = p1.snapshotHash;

  // 非法字段 → 整体拒绝（无半写）
  const bad = await request(app)
    .patch('/api/products/batch')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ slugs: [p1.slug, p2.slug], patch: { priceCnyFen: -5 } })
    .expect(200);
  assert.notEqual(bad.body.code, 0);
  const unchanged = await request(app).get(`/api/products/${p1.slug}`).expect(200);
  assert.equal(unchanged.body.data.priceCnyFen, 1000);

  // 个别 slug 不存在 → failed 跳过，其余更新 + 价格快照重算 + 上下架
  const res = await request(app)
    .patch('/api/products/batch')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ slugs: [p1.slug, p2.slug, 'p-not-exist'], patch: { priceCnyFen: 3000, active: false } })
    .expect(200);
  assertOk(res);
  assert.deepEqual(res.body.data.updated, [p1.slug, p2.slug]);
  assert.equal(res.body.data.failed.length, 1);
  // 下架商品详情：匿名 404（防探测），店主令牌可预览
  const after1 = await request(app).get(`/api/products/${p1.slug}`).expect(404);
  const preview = await request(app)
    .get(`/api/products/${p1.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(preview.body.data.priceCnyFen, 3000);
  assert.equal(preview.body.data.active, false);
  assert.notEqual(preview.body.data.snapshotHash, hash1, '价格变更重算快照哈希');
});

test('CSV 公式注入防护：外部可控文本字段（收货姓名）以 = 开头时加前缀；码原文原样', async () => {
  const ph = await listProduct(productPayload({ kind: 'physical', title: '公式注入商品', capacity: 10 }));
  const o = await createDraft(ph.slug);
  escrowed(o);
  db.prepare("UPDATE orders SET status = 'confirmed', shipping_name = '=1+1', updated_at = ? WHERE id = ?")
    .run(Date.now(), o.id);
  const csv = await request(app)
    .get('/api/shop/export/orders.csv?status=confirmed')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.ok(csv.text.includes("'=1+1"), '公式前缀已加（外部输入不触发 Excel 执行）');
  // 码原文以 = 开头时不加前缀（值完整性优先——店主持有资源，非买家可控）
  const dg = await listProduct(productPayload({ kind: 'digital', title: '公式码商品' }));
  await request(app)
    .post(`/api/products/${dg.slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['=X1'] })
    .expect(200);
  const codes = await request(app)
    .get(`/api/shop/export/codes.csv?slug=${dg.slug}&status=unused`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.ok(codes.text.includes(',=X1,') || codes.text.includes('\n=X1,'), '码导出不加公式前缀');
});

test('导出：orders.csv 列白名单与 BOM；权限（匿名 401）；codes.csv 仅 owner', async () => {
  const ph = await listProduct(productPayload({ kind: 'physical', title: '导出商品', capacity: 10 }));
  const o = await createDraft(ph.slug);
  escrowed(o);
  db.prepare("UPDATE orders SET status = 'confirmed', shipping_name = '张三', updated_at = ? WHERE id = ?").run(Date.now(), o.id);

  const csvRes = await request(app)
    .get('/api/shop/export/orders.csv?status=confirmed')
    .set('Authorization', `Bearer ${ownerToken}`)
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
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['CSV-KEY-1', 'CSV,K-EY-2'] })
    .expect(200);
  const codes = await request(app)
    .get(`/api/shop/export/codes.csv?slug=${dg.slug}&status=unused`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.ok(codes.text.includes('CSV-KEY-1'));
  assert.ok(codes.text.includes('"CSV,K-EY-2"'), '含逗号字段加引号转义');
  const asBuyer = await request(app)
    .get(`/api/shop/export/codes.csv?slug=${dg.slug}`)
    .set('Authorization', `Bearer ${buyerToken}`);
  assert.equal(asBuyer.status, 403, '码原文导出仅 owner');
  // 非数字商品 codes.csv 404
  await request(app)
    .get(`/api/shop/export/codes.csv?slug=${ph.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(404);
});
