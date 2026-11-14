/**
 * 标识读入口的**归一化接线**：抄来/粘来的编号（小写、首尾空白、Crockford 的 `O`/`I`/`L`）
 * 必须和库里那个大写标识查到同一行。
 *
 * 为什么值得单独一组：归一化本身是纯函数（`ids.test.js` 已钉住），但**接线**才是会漏的地方——
 * 订单/商品/提货/收藏/批量处置各有自己的读入口，任何一个漏掉 `normalizeId` 都会让
 * "从聊天里复制单号"变成"订单不存在"，而现象看起来像数据丢了。
 *
 * 固定夹具（`B000…` / `P000…` / `C000…`）是刻意的：别名腿必须**每次**都真的改写标识，
 * 否则 `aliasOf` 偶尔返回原值，那条断言就成了空转（商品标识 10 位随机里约一半既无 0 也无 1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, insertOrder, insertProduct, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const seller = owner.address.toLowerCase();

/** 把一个合法标识改写成"人能抄错"的形状（固定夹具保证 0 存在） */
function aliasOf(id) {
  if (id.includes('0')) return id.replace('0', 'O');
  if (id.includes('1')) return id.replace('1', 'I');
  return id;
}

test('订单号：小写 / 首尾空白 / Crockford 别名都读到同一单（读入口 + HTTP）', async () => {
  const orderNo = `B${'0'.repeat(20)}`;
  await insertOrder(db, { buyer: buyer.address.toLowerCase(), seller, orderNo });
  const { findOrderByNo, findOrderInShop } = await import('../src/orderScope.js');

  const variants = [orderNo.toLowerCase(), `  ${orderNo.toLowerCase()}  `, aliasOf(orderNo)];
  for (const v of variants) {
    assert.equal((await findOrderByNo(v))?.order_no, orderNo, `裸读没归一化：${JSON.stringify(v)}`);
    assert.equal((await findOrderInShop(v, shopRef.value))?.order_no, orderNo, `店铺作用域读没归一化：${JSON.stringify(v)}`);
  }

  const r = await request(app).get(`/api/orders/${encodeURIComponent(variants[0])}`).expect(200);
  assert.equal(r.body.data.id, orderNo, 'HTTP 详情页也要认小写单号');
});

test('商品标识：小写 / Crockford 别名都读到同一件商品（读入口 + HTTP）', async () => {
  const slug = `P${'0'.repeat(10)}`;
  await insertProduct(db, { shopCode: shopRef.value, slug });
  const { productRowBySlug } = await import('../src/productLookup.js');

  for (const v of [slug.toLowerCase(), aliasOf(slug)]) {
    assert.equal((await productRowBySlug(v))?.slug, slug, `商品读入口没归一化：${JSON.stringify(v)}`);
  }

  const r = await request(app).get(`/api/products/${encodeURIComponent(slug.toLowerCase())}`).expect(200);
  assert.equal(r.body.data.slug, slug, 'HTTP 商品页也要认小写标识');
});

test('提货声明号：小写 / Crockford 别名读到同一行，店主面 HTTP 也认', async () => {
  const orderNo = `B${'1'.repeat(20)}`;
  const { orderId } = await insertOrder(db, { buyer: buyer.address.toLowerCase(), seller, orderNo });
  const { productId, slug } = await insertProduct(db, { shopCode: shopRef.value, slug: `P${'1'.repeat(10)}` });
  const claimNo = `C${'0'.repeat(20)}`;
  await db.run(
    `INSERT INTO nft_claims
       (claim_no, shop_code, product_id, product_slug, order_id, order_no, seller,
        token_contract, token_id, claimant)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    claimNo,
    shopRef.value,
    productId,
    slug,
    orderId,
    orderNo,
    seller,
    `0x${'11'.repeat(20)}`,
    '1',
    buyer.address.toLowerCase()
  );

  const { claimRowByNo } = await import('../src/nftClaim.js');
  for (const v of [claimNo.toLowerCase(), aliasOf(claimNo)]) {
    assert.equal((await claimRowByNo(v))?.claim_no, claimNo, `提货读入口没归一化：${JSON.stringify(v)}`);
  }

  const ownerToken = (await login(ctx, owner)).token;
  const r = await request(app)
    .post(`/api/claims/nft/${encodeURIComponent(claimNo.toLowerCase())}/seller`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'approve' })
    .expect(200);
  assertOk(r);
  assert.equal(r.body.data.id, claimNo, '店主动作也要用规范声明号回报');

  const searched = await request(app)
    .get(`/api/claims/nft/seller?q=${encodeURIComponent(claimNo.toLowerCase())}&pageSize=5`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.ok(
    searched.body.data.claims.some((c) => c.id === claimNo),
    '提货列表搜索也要认小写声明号'
  );
});

test('收藏：小写商品标识能收藏、读回规范标识、也能取消', async () => {
  const slug = `P${'2'.repeat(10)}`;
  await insertProduct(db, { shopCode: shopRef.value, slug });
  const buyerToken = (await login(ctx, buyer)).token;

  await request(app)
    .put('/api/favorites')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ kind: 'product', code: shopRef.value, slug: slug.toLowerCase() })
    .expect(200);

  const listed = await request(app).get(`/api/favorites?address=${buyer.address.toLowerCase()}`).expect(200);
  const row = listed.body.data.products.find((p) => p.slug === slug);
  assert.ok(row, '收藏行必须按规范标识回读');

  await request(app)
    .delete('/api/favorites')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ kind: 'product', code: shopRef.value, slug: slug.toLowerCase() })
    .expect(200);

  const after = await request(app).get(`/api/favorites?address=${buyer.address.toLowerCase()}`).expect(200);
  assert.equal(after.body.data.products.some((p) => p.slug === slug), false, '小写标识也要能取消收藏');
});

test('节点主批量强制下架：小写商品标识也能命中（内核归一化）', async () => {
  const slug = `P${'3'.repeat(10)}`;
  await insertProduct(db, { shopCode: shopRef.value, slug });
  const ownerToken = (await login(ctx, owner)).token;

  const r = await request(app)
    .patch('/api/products/admin/moderation')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ slugs: [slug.toLowerCase()], hidden: true, reason: '归一化测试' })
    .expect(200);
  assertOk(r);
  assert.deepEqual(r.body.data.updated, [slug], '批量处置必须用库里的规范标识回报');
});

test('下单幂等回放：同一 key 用小写 slug 重试，仍返回同一张草稿', async () => {
  const ownerToken = (await login(ctx, owner)).token;
  const buyerToken = (await login(ctx, buyer)).token;
  const created = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send(productPayload())
    .expect(200);
  assertOk(created);
  const slug = created.body.data.slug;

  const send = () =>
    request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('X-Mk-Shop', shopRef.value)
      .send({ productSlug: slug.toLowerCase(), quantity: 1, buyer: buyer.address, idempotencyKey: 'idem-lower-001' })
      .expect(200);

  const first = await send();
  const second = await send();
  assert.equal(first.body.data.id, second.body.data.id, '同一幂等键必须回放同一张草稿');
  assert.equal(second.body.data.replayed, true, '第二次必须是回放，而不是 409');
});
