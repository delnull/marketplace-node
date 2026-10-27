/**
 * 买家发起退货 → 卖家填退货地址 → 买家回填回寄单号。
 * 与卖家直接建退货单共用同一张 order_returns；发起权归买家，地址仍由卖家给。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
let ownerToken;
let buyerToken;
let orderNo;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  const p = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'physical', title: '退货申请测试', capacity: 5 }))
    .expect(200);
  assertOk(p);
  const o = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: p.body.data.slug, quantity: 1, shipping: { name: '买家', phone: '13800138000', address: '测试地址' } })
    .expect(200);
  assertOk(o);
  orderNo = o.body.data.id;
  await db.run(
    "UPDATE orders SET status = 'shipped', shipped_at = CURRENT_TIMESTAMP(3), tracking_no = 'SF-SELL-1' WHERE order_no = ?",
    orderNo
  );
});

test('买家发起退货申请 → 卖家填地址 → 买家填回寄单号', async () => {
  const req = await request(app)
    .post(`/api/orders/${orderNo}/return/request`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ note: '尺码不合适' })
    .expect(200);
  assertOk(req);
  assert.equal(req.body.data.address, '', '买家申请时不应自带卖家仓库地址');

  const addr = await request(app)
    .patch(`/api/orders/${orderNo}/return/address`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ address: '退货仓 A' })
    .expect(200);
  assertOk(addr);
  assert.equal(addr.body.data.address, '退货仓 A');

  const track = await request(app)
    .post(`/api/orders/${orderNo}/return/tracking`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ trackingNo: 'SF-RET-BUYER-1', carrier: 'SF' })
    .expect(200);
  assertOk(track);
  assert.equal(track.body.data.status, 'shipped');
});

test('非买家不能发起退货申请', async () => {
  const r = await request(app)
    .post(`/api/orders/${orderNo}/return/request`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ note: '不是买家' })
    .expect(403);
  assert.equal(r.body.code, 403);
});
