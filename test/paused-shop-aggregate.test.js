/**
 * P0：**暂停接单的店铺，公开聚合端点必须拒绝，不能静默放大成全节点合计**。
 *
 * 旧实现 `optionalShop` 在 `listed !== 1` 时把 `req.shop = null`，而 null 的语义是
 * "没有 X-Mk-Shop 头 ⇒ 该节点全部在售店铺"。于是挂起店页面上的
 * `/api/shop/reputation`、`/api/shop/reviews/stats`、`/api/shop/claims` 拿到的是
 * **别人家/全节点**的数字，HTTP 200 + code:0，前端无从分辨。
 *
 * 现在三态显式：没有头（全节点）/ 可售店 / 不可售店。聚合端点用 `listedShopScope`，
 * 第三态以 409 + 可读拒因拒绝；"全节点合计"只由**没有头**进入。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

let ownerToken;
let product;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '暂停店聚合探针' }))
    .expect(200);
  assertOk(res);
  product = res.body.data;
});

after(async () => {
  // 本文件把店铺置为"暂停接单"；同一进程里的后续用例不该继承这个状态
  await db.run('UPDATE shops SET listed = 1 WHERE code = ?', shopRef.value);
});

test('挂起店铺的聚合端点被拒（409 + 唯一拒因）；无头仍可拿全节点合计', async () => {
  // 前置：在售时三个聚合端点都正常，且它们本来就允许（这里是"全节点合计"）
  const beforePause = await request(app).get('/api/shop/reputation').expect(200);
  assertOk(beforePause);

  await db.run('UPDATE shops SET listed = 0 WHERE code = ?', shopRef.value);

  for (const path of ['/api/shop/reputation', '/api/shop/reviews/stats', '/api/shop/claims']) {
    const res = await request(app).get(path).set('X-Mk-Shop', shopRef.value);
    assert.equal(res.status, 409, `${path}：指到暂停接单的店必须拒绝（不能返回 200 + 全节点合计）`);
    assert.notEqual(res.body.code, 0, `${path}：拒绝必须是业务失败，不是 code:0`);
    assert.match(String(res.body.message), /暂停接单/, `${path}：拒因必须是"暂停接单"（同一份文案）`);
  }

  // "全节点合计"只由没有头进入：同一条路径不带 X-Mk-Shop 仍然 200/code:0
  for (const path of ['/api/shop/reputation', '/api/shop/reviews/stats', '/api/shop/claims']) {
    const res = await request(app).get(path).expect(200);
    assertOk(res);
  }

  /*
    公开商品详情仍按"可读原因"回答（不是 404、也不是聚合的 409）：
    买家点进已发出的链接时要能知道"这家店暂时不接单了"，这是与聚合统计不同的语义。
  */
  const detail = await request(app).get(`/api/products/${product.slug}`).expect(200);
  /*
    商品详情刻意沿用既有语义：HTTP 200、业务码非 0（`fail(..., 200, 200)`），
    与聚合统计的 409 是两种不同的失败面——这里只钉住"仍可读、原因没变"。
  */
  assert.notEqual(detail.body.code, 0);
  assert.match(String(detail.body.message), /暂停接单/);

  /*
    匿名 `/api/shop` 仍把暂停店按不存在处理（不返回 shop 对象），与旧口径一致；
    它不会把别家的数字冒充成这一家的（这里只有节点级信息与在售店铺列表）。
  */
  const shopInfo = await request(app).get('/api/shop').set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(shopInfo);
  assert.equal(shopInfo.body.data.shop, undefined, '暂停店在匿名视角下按不存在处理');
});
