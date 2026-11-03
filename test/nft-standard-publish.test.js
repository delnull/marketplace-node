/**
 * 发布 NFT 商品时，节点必须把卖家选择的标准与链上 ERC165 检测结果核对；
 * 错配不能落库（否则买家付款后才发现交付事件对不上）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner } = ctx;
let ownerToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  assert.ok(ownerToken);
});

function nftPayload(overrides = {}) {
  return productPayload({
    kind: 'nft',
    nftContract: '0x' + 'ab'.repeat(20),
    nftStandard: 'erc721',
    ...overrides,
  });
}

test('发布/编辑 NFT：创建与身份变化才做链上检测，普通标题编辑不打 RPC', async () => {
  const { setNftStandardCheck } = await import('../src/nftStandard.js');
  const calls = [];
  setNftStandardCheck(async ({ contract, declared }) => {
    calls.push({ contract, declared });
    return { ok: true, standard: declared };
  });

  const created = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send(nftPayload({ title: '检测链路商品' }))
    .expect(200);
  assert.equal(created.body.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].contract, '0x' + 'ab'.repeat(20));
  assert.equal(calls[0].declared, 'erc721');

  const titleOnly = await request(app)
    .patch(`/api/products/${created.body.data.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send({ title: '只改标题' })
    .expect(200);
  assert.equal(titleOnly.body.code, 0);
  assert.equal(calls.length, 1, '只改标题不得再打链');

  const changed = await request(app)
    .patch(`/api/products/${created.body.data.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send({ nftStandard: 'erc1155' })
    .expect(200);
  assert.equal(changed.body.code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].declared, 'erc1155');
});

test('编辑 NFT：PATCH 标准错配同样拒绝，且不落库', async () => {
  const { setNftStandardCheck } = await import('../src/nftStandard.js');
  setNftStandardCheck(async ({ declared }) => ({
    ok: true,
    standard: declared,
  }));
  const created = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send(nftPayload({ title: 'PATCH 错配商品' }))
    .expect(200);
  assert.equal(created.body.code, 0);

  setNftStandardCheck(async () => ({
    ok: false,
    retryable: false,
    standard: 'erc721',
    reason: '该合约实际为 ERC721，与选择的 ERC1155 不一致——请按合约实际标准重新选择',
  }));
  const res = await request(app)
    .patch(`/api/products/${created.body.data.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send({ nftStandard: 'erc1155' })
    .expect(400);
  assert.match(res.body.message, /实际为 ERC721/);
});

test('编辑 NFT：PATCH 检测 RPC 读不到 ⇒ 503 fail-closed', async () => {
  const { setNftStandardCheck } = await import('../src/nftStandard.js');
  setNftStandardCheck(async () => ({
    ok: true,
    standard: 'erc721',
  }));
  const created = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send(nftPayload({ title: 'PATCH RPC 商品' }))
    .expect(200);
  assert.equal(created.body.code, 0);

  setNftStandardCheck(async () => ({
    ok: false,
    retryable: true,
    reason: '读取 NFT 合约标准失败：RPC timeout',
  }));
  const res = await request(app)
    .patch(`/api/products/${created.body.data.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send({ nftStandard: 'erc1155' })
    .expect(503);
  assert.match(res.body.message, /RPC/);
});

test('发布前的标准预检接口：返回实际标准，不替卖家做发布决定', async () => {
  const { setNftStandardCheck } = await import('../src/nftStandard.js');
  setNftStandardCheck(async () => ({
    ok: false,
    retryable: false,
    standard: 'erc1155',
    reason: '该合约实际为 ERC1155',
  }));
  const res = await request(app)
    .get('/api/products/nft-standard?contract=' + '0x' + 'ab'.repeat(20) + '&standard=erc721')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.equal(res.body.code, 0);
  assert.equal(res.body.data.standard, 'erc1155');
  assert.equal(res.body.data.matches, false);
});

test('发布 NFT：链上实际为 ERC1155 而声明 ERC721 ⇒ 明确拒绝，不落库', async () => {
  const { setNftStandardCheck } = await import('../src/nftStandard.js');
  setNftStandardCheck(async () => ({
    ok: false,
    retryable: false,
    standard: 'erc1155',
    reason: '该合约实际为 ERC1155，与选择的 ERC721 不一致——请按合约实际标准重新选择',
  }));
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send(nftPayload())
    .expect(400);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /实际为 ERC1155/);
});

test('发布 NFT：RPC 读不到 ⇒ 503 fail-closed，不把未知当通过', async () => {
  const { setNftStandardCheck } = await import('../src/nftStandard.js');
  setNftStandardCheck(async () => ({
    ok: false,
    retryable: true,
    reason: '读取 NFT 合约标准失败：RPC timeout',
  }));
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send(nftPayload())
    .expect(503);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /RPC/);
});
