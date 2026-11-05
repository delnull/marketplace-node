/**
 * 评价图逐图下架 / PII 擦除 / 孤儿媒体清扫。
 */
import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { storeMediaBuffer, uploadsDir } = await import('../src/productMedia.js');
const { app, request, db, owner, buyer } = ctx;
const ownerToken = (await login(ctx, owner)).token;
const buyerToken = (await login(ctx, buyer)).token;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function confirmedOrder(title) {
  const p = await request(app).post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title })).expect(200);
  assertOk(p);
  const o = await request(app).post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: p.body.data.slug }).expect(200);
  assertOk(o);
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", new Date(), o.body.data.id);
  return o.body.data.id;
}

async function uploadAndSubmit(orderNo) {
  const up = await request(app).post(`/api/orders/${orderNo}/review/images`)
    .set('Authorization', `Bearer ${buyerToken}`).set('Content-Type', 'image/png').send(PNG).expect(200);
  assertOk(up);
  const url = up.body.data.url;
  const sub = await request(app).post(`/api/orders/${orderNo}/review`)
    .set('Authorization', `Bearer ${buyerToken}`).send({ rating: 5, content: '带图', images: [url] }).expect(200);
  assertOk(sub);
  return url;
}

test('逐图下架：节点管理员删一张，JSON 与磁盘同时消失', async () => {
  const orderNo = await confirmedOrder('逐图下架商品');
  const url = await uploadAndSubmit(orderNo);
  const disk = `${uploadsDir()}/${url.split('/').pop()}`;
  assert.equal(fs.existsSync(disk), true);

  const listed = await request(app).get(`/api/orders/${orderNo}/review/images`)
    .set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(listed);
  assert.deepEqual(listed.body.data.review, [url]);

  const r = await request(app).delete(`/api/orders/${orderNo}/review/images`)
    .set('Authorization', `Bearer ${ownerToken}`).send({ kind: 'review', url }).expect(200);
  assertOk(r);
  assert.equal(r.body.data.remaining, 0);
  assert.equal(fs.existsSync(disk), false, '下架必须删盘，不能只改 JSON');

  /*
    节点治理动作必须落在**节点级审计**里（2026-11-04 修）。
    旧实现走店铺级 `audit` + `roleOf(addr, order.shop_code)`：租户店上节点主/员工算 'user'，
    `logAudit` 直接 return——删了图，一条审计都没有。这里钉住三件事：
    行是节点级、角色是 host/staff、目标店写在 detail 里（店铺详情靠它回看治理记录）。
  */
  const audit = await db.get("SELECT * FROM audit_logs WHERE action = 'review.image.remove' ORDER BY id DESC LIMIT 1");
  assert.ok(audit, '评价图下架必须留审计（不能因为操作者不是该店店主就静默丢掉）');
  assert.equal(audit.shop_code, null, '这是节点治理动作，不属于那家店');
  assert.equal(audit.actor_role, 'host');
  assert.equal(audit.detail.shopCode, shopRef.value, '目标店写在 detail 里，auditWhere 的 targetShop 用它归属');
  const byShop = await request(app)
    .get(`/api/shop/audit/node?targetShop=${shopRef.value}&pageSize=100`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.ok(byShop.body.data.items.some((i) => i.id === audit.id), '店铺详情的治理记录要能按 targetShop 找到这一行');

  const o = await request(app).get(`/api/orders/${orderNo}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.deepEqual(o.body.data.review.images, []);
});

test('PII 擦除清评价图并删盘，评价正文保留', async () => {
  const orderNo = await confirmedOrder('PII 评价图商品');
  const url = await uploadAndSubmit(orderNo);
  const disk = `${uploadsDir()}/${url.split('/').pop()}`;
  const r = await request(app).post(`/api/shop/orders/${orderNo}/erase-pii`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(r);
  assert.equal(r.body.data.erased.reviewImages, 1);
  assert.equal(fs.existsSync(disk), false);
  const row = await db.get('SELECT content, images FROM reviews WHERE order_id = (SELECT id FROM orders WHERE order_no = ?)', orderNo);
  assert.equal(row.content, '带图');
  assert.deepEqual(row.images, []);
});

test('孤儿媒体清扫：只删无引用且超 TTL 的文件', async () => {
  const old = storeMediaBuffer(PNG).url;
  const disk = `${uploadsDir()}/${old.split('/').pop()}`;
  const t = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(disk, t, t);
  const r = await request(app).post('/api/shop/media/sweep-orphans')
    .set('Authorization', `Bearer ${ownerToken}`).send({ olderThanDays: 7 }).expect(200);
  assertOk(r);
  assert.ok(r.body.data.removed >= 1);
  assert.equal(fs.existsSync(disk), false);
});
