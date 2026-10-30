/**
 * 买家收藏：GET 公开按地址读；PUT/DELETE 必须登录，身份取令牌地址（不认 body 的 address）。
 * 收藏分店铺与商品两类；商品键带店铺编号，避免同节点多店同名 slug 相撞。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner, buyer } = ctx;

let buyerToken;
let product;

before(async () => {
  const buyerLogin = await login(ctx, buyer);
  buyerToken = buyerLogin.token;
  assert.ok(buyerToken);

  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '收藏测试商品' }))
    .expect(200);
  assertOk(res);
  product = res.body.data;
});

function putFavorite(body, token = buyerToken) {
  const req = request(app).put('/api/favorites').send(body);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req;
}

test('收藏：读公开；写必须登录', async () => {
  const empty = await request(app).get(`/api/favorites?address=${buyer.address.toLowerCase()}`).expect(200);
  assertOk(empty);
  assert.deepEqual(empty.body.data, { shops: [], products: [] });

  await putFavorite({ kind: 'product', code: shopRef.value, slug: product.slug }, null).expect(401);

  const added = await putFavorite({ kind: 'product', code: shopRef.value, slug: product.slug }).expect(200);
  assertOk(added);
  assert.equal(added.body.data.favorite, true);

  const read = await request(app).get(`/api/favorites?address=${buyer.address.toLowerCase()}`).expect(200);
  assertOk(read);
  assert.deepEqual(read.body.data.products, [{ code: shopRef.value, slug: product.slug }]);
  assert.deepEqual(read.body.data.shops, []);
});

test('收藏：店铺与商品分开；删除只删自己的那一类', async () => {
  await putFavorite({ kind: 'shop', code: shopRef.value }).expect(200);

  const read = await request(app).get(`/api/favorites?address=${buyer.address.toLowerCase()}`).expect(200);
  assertOk(read);
  assert.deepEqual(read.body.data.shops, [shopRef.value]);
  assert.deepEqual(read.body.data.products, [{ code: shopRef.value, slug: product.slug }]);

  await request(app)
    .delete('/api/favorites')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ kind: 'product', code: shopRef.value, slug: product.slug })
    .expect(200);

  const after = await request(app).get(`/api/favorites?address=${buyer.address.toLowerCase()}`).expect(200);
  assertOk(after);
  assert.deepEqual(after.body.data.products, []);
  assert.deepEqual(after.body.data.shops, [shopRef.value]);

  await request(app)
    .delete('/api/favorites')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ kind: 'shop', code: shopRef.value })
    .expect(200);
});

test('收藏：写入身份取令牌，不认 body 里的 address', async () => {
  await putFavorite({ kind: 'shop', code: shopRef.value, address: owner.address }).expect(200);
  const mine = await request(app).get(`/api/favorites?address=${buyer.address.toLowerCase()}`).expect(200);
  assertOk(mine);
  assert.deepEqual(mine.body.data.shops, [shopRef.value]);
  const spoofed = await request(app)
    .get(`/api/favorites?address=${owner.address.toLowerCase()}`)
    .expect(200);
  assertOk(spoofed);
  assert.deepEqual(spoofed.body.data.shops, []);
  await request(app)
    .delete('/api/favorites')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ kind: 'shop', code: shopRef.value })
    .expect(200);
});

test('收藏：地址/形状/商品存在性校验', async () => {
  await request(app).get('/api/favorites?address=not-an-address').expect(400);
  await putFavorite({ kind: 'nope', code: shopRef.value }).expect(400);
  await putFavorite({ kind: 'product', code: shopRef.value }).expect(400);
  await putFavorite({ kind: 'product', code: shopRef.value, slug: '__missing__' }).expect(404);
  await putFavorite({ kind: 'shop', code: shopRef.value, slug: 'x' }).expect(400);
});

test('收藏：重复 PUT 幂等、DELETE 不存在也成功、地址大小写不敏感', async () => {
  await putFavorite({ kind: 'product', code: shopRef.value, slug: product.slug }).expect(200);
  await putFavorite({ kind: 'product', code: shopRef.value, slug: product.slug }).expect(200);
  const upper = await request(app)
    .get(`/api/favorites?address=0x${buyer.address.slice(2).toUpperCase()}`)
    .expect(200);
  assertOk(upper);
  assert.equal(upper.body.data.products.length, 1, '地址十六进制大小写不敏感');

  const lower = await request(app)
    .get(`/api/favorites?address=${buyer.address.toLowerCase()}`)
    .expect(200);
  assertOk(lower);
  assert.equal(lower.body.data.products.length, 1, '重复 PUT 不应产生两条');

  await request(app)
    .delete('/api/favorites')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ kind: 'product', code: shopRef.value, slug: product.slug })
    .expect(200);
  await request(app)
    .delete('/api/favorites')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ kind: 'product', code: shopRef.value, slug: product.slug })
    .expect(200);
});
