/**
 * 匿名可枚举他人草稿的链上单号（支付参数）——判据只在 `orderToPublic` 一处。
 *
 * `GET /api/orders?address=<任意买家>` 是公开只读，而草稿的 `escrowOrderId` 是
 * `Escrow.createOrder` 的键：泄露之后，任何人可以先拿它建一笔 1 wei 的托管单占位，
 * 真实买家付款将永久 `OrderExists` revert（代码自己在 routes/orders.js 里承认过这条路径）。
 * 已托管之后它由链上 OrderCreated 日志公开，藏也没意义。
 *
 * 边界（刻意写在这里，防以后 "干脆全藏"）：
 *   · 匿名/第三人的**列表**（按地址可枚举）→ 草稿行**整行不出现**；
 *   · 匿名**详情**（以不可枚举的订单号为键，50 bit 随机段）→ 仍给，买家不登录也能付款；
 *   · 带买家令牌的列表 → 给（`as` 非空 = 已证明当事人）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

let ownerToken;
let buyerToken;
let draft;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  const product = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '草稿支付参数可见性' }))
    .expect(200);
  assertOk(product);

  const created = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: product.body.data.slug })
    .expect(200);
  assertOk(created);
  draft = created.body.data;
  assert.match(String(draft.escrowOrderId), /^0x[0-9a-f]{64}$/, '前置：建单响应必须给买家支付参数');
});

test('匿名/第三人列表不含草稿行；匿名详情/买家本人列表仍能拿到（不堵死付款）', async () => {
  const anonList = await request(app).get(`/api/orders?address=${buyer.address}`).expect(200);
  assertOk(anonList);
  const anonRow = anonList.body.data.orders.find((o) => o.id === draft.id);
  assert.equal(anonRow, undefined, '匿名列表不得出现草稿行（否则 order_no → 详情 → escrowOrderId）');
  assert.equal(anonList.body.data.total, 0, '分页总数也不能把草稿算进去');

  // 详情以不可枚举的订单号为键：握着这个 URL 本身就是"这一单的钥匙"，匿名买家据此签名付款
  const anonDetail = await request(app).get(`/api/orders/${draft.id}`).expect(200);
  assertOk(anonDetail);
  assert.equal(anonDetail.body.data.escrowOrderId, draft.escrowOrderId, '匿名详情必须仍能拿到它（否则未登录买家付不了款）');

  // 买家令牌 = 已证明当事人：列表给
  const buyerList = await request(app)
    .get(`/api/orders?address=${buyer.address}`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  assertOk(buyerList);
  const buyerRow = buyerList.body.data.orders.find((o) => o.id === draft.id);
  assert.equal(buyerRow.escrowOrderId, draft.escrowOrderId, '带令牌的列表必须给（付款流程依赖）');
});

test('已托管后 escrowOrderId 是链上公开事实：匿名列表照常下发', async () => {
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), draft.id);
  const anonList = await request(app).get(`/api/orders?address=${buyer.address}`).expect(200);
  assertOk(anonList);
  const row = anonList.body.data.orders.find((o) => o.id === draft.id);
  assert.equal(row.status, 'escrowed');
  assert.equal(row.escrowOrderId, draft.escrowOrderId, '非草稿的链上单号不再算秘密');
});
