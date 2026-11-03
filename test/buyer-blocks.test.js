/**
 * 买家屏蔽名单（节点后端持久化）。
 *
 * 口径：
 *  - 只对当前节点生效，不写 localStorage；
 *  - 屏蔽店铺后 `/api/shops`（同一买家 token）过滤该店；匿名列表不受影响；
 *  - 同一个 (buyer,targetType,target) 幂等；只允许删除自己的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, buyer } = ctx;

test('未登录不能读写屏蔽名单', async () => {
  const get = await request(app).get('/api/me/blocks');
  assert.equal(get.status, 401);
  const post = await request(app).post('/api/me/blocks').send({ targetType: 'shop', target: shopRef.value });
  assert.equal(post.status, 401);
});

test('屏蔽店铺：节点后端持久化、幂等、按买家隔离，并过滤 /api/shops', async () => {
  const { token } = await login(ctx, buyer);

  const anonBefore = await request(app).get('/api/shops').expect(200);
  assert.ok(anonBefore.body.data.shops.some((s) => s.code === shopRef.value), '匿名列表仍应有该店');

  const add = await request(app)
    .post('/api/me/blocks')
    .set('Authorization', `Bearer ${token}`)
    .send({ targetType: 'shop', target: shopRef.value, reason: '假货' })
    .expect(200);
  assertOk(add);
  assert.equal(add.body.data.targetType, 'shop');
  assert.equal(add.body.data.shopCode, shopRef.value);

  const again = await request(app)
    .post('/api/me/blocks')
    .set('Authorization', `Bearer ${token}`)
    .send({ targetType: 'shop', target: shopRef.value, reason: '更新原因' })
    .expect(200);
  assertOk(again);
  assert.equal(again.body.data.id, add.body.data.id, '同一目标只保留一条（幂等）');

  const mine = await request(app)
    .get('/api/me/blocks')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assert.equal(mine.body.data.blocks.length, 1);
  assert.equal(mine.body.data.blocks[0].reason, '更新原因');

  const filtered = await request(app)
    .get('/api/shops')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assert.equal(filtered.body.data.shops.some((s) => s.code === shopRef.value), false, '登录买家不应看到被自己屏蔽的店');
  assert.equal(filtered.body.data.hiddenBlocked, 1);

  const anonAfter = await request(app).get('/api/shops').expect(200);
  assert.ok(anonAfter.body.data.shops.some((s) => s.code === shopRef.value), '其他买家/匿名不受影响');

  const other = Wallet.createRandom();
  const { token: otherToken } = await login(ctx, other);
  const otherList = await request(app)
    .get('/api/me/blocks')
    .set('Authorization', `Bearer ${otherToken}`)
    .expect(200);
  assert.equal(otherList.body.data.blocks.length, 0, '屏蔽按买家隔离');

  const del = await request(app)
    .delete(`/api/me/blocks/${add.body.data.id}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assertOk(del);
  const back = await request(app)
    .get('/api/shops')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assert.ok(back.body.data.shops.some((s) => s.code === shopRef.value), '解除后恢复显示');
});

test('非法/不存在的目标被拒绝；只能删自己的', async () => {
  const { token } = await login(ctx, buyer);
  const badType = await request(app)
    .post('/api/me/blocks')
    .set('Authorization', `Bearer ${token}`)
    .send({ targetType: 'owner', target: shopRef.value });
  assert.equal(badType.status, 400);

  const missing = await request(app)
    .post('/api/me/blocks')
    .set('Authorization', `Bearer ${token}`)
    .send({ targetType: 'shop', target: 'ZZZZZZZZ~' });
  assert.equal(missing.status, 404);

  const seller = await request(app)
    .post('/api/me/blocks')
    .set('Authorization', `Bearer ${token}`)
    .send({ targetType: 'seller', target: '0x' + '12'.repeat(20) })
    .expect(200);
  assertOk(seller);

  const other = Wallet.createRandom();
  const { token: otherToken } = await login(ctx, other);
  const nope = await request(app)
    .delete(`/api/me/blocks/${seller.body.data.id}`)
    .set('Authorization', `Bearer ${otherToken}`);
  assert.equal(nope.status, 404, '不能删除别人的屏蔽');
});
