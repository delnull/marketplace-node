/**
 * 售罄惩罚集成测试：两件商品成交/评价/新鲜度完全一样，一件限量库存耗尽、一件有货；
 * 综合排序必须把有货的排在前面。纯函数 `applyAvailability` 只证明封顶，证明不了
 * “SQL 真的把 product_skus 的 exhausted 读出来了”。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, TEST_SHOP_CODE, insertProduct, insertOrder } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner, db } = ctx;

const buyerOf = (n) => `0x${String(n).padStart(40, '0')}`;
let available;
let soldOut;

before(async () => {
  const ownerToken = (await login(ctx, owner)).token;
  assert.ok(ownerToken);

  const ts = new Date(Date.now() - 86_400_000);
  const create = (title) =>
    insertProduct(db, {
      shopCode: TEST_SHOP_CODE,
      title,
      description: '售罄惩罚测试商品',
      kind: 'physical',
      priceCurrency: 'USDT',
      publishedAt: ts,
      createdAt: ts,
      updatedAt: ts,
      skus: [{ key: '', priceMicro: 1_000_000, capacity: 5, committed: 0 }],
    });

  available = await create('售罄惩罚测试 有货');
  soldOut = await create('售罄惩罚测试 已售罄');

  // 两件商品造完全相同的成交 + 评价，商品分只差库存状态
  for (const [idx, p] of [available, soldOut].entries()) {
    for (let i = 0; i < 3; i += 1) {
      const buyer = buyerOf(9200 + idx * 10 + i);
      const o = await insertOrder(db, {
        buyer,
        seller: owner.address.toLowerCase(),
        shopCode: TEST_SHOP_CODE,
        productId: p.productId,
        productSlug: p.slug,
        status: 'confirmed',
        quantity: 1,
        amountWei: '1000000',
        priceMicro: 1000000,
        updatedAt: new Date(),
      });
      if (i === 0) {
        await db.run(
          'INSERT INTO reviews (order_id, product_id, buyer, rating, content) VALUES (?, ?, ?, ?, ?)',
          o.orderId,
          p.productId,
          buyer,
          5,
          '好评'
        );
      }
    }
  }

  // 限量库存耗尽（订单夹具不经过 stockHold 的 committed 更新，直接写列）
  await db.run('UPDATE product_skus SET committed = capacity WHERE product_id = ?', soldOut.productId);
});

test('composite：同成交同评价时，售罄商品被封顶在有货商品之后', async () => {
  const res = await request(app)
    .get(`/api/products?sort=composite&q=${encodeURIComponent('售罄惩罚测试')}&pageSize=20`)
    .expect(200);
  assertOk(res);
  const rows = res.body.data.products;
  const ids = rows.map((p) => p.slug);
  const a = ids.indexOf(available.slug);
  const b = ids.indexOf(soldOut.slug);
  assert.ok(a >= 0 && b >= 0, '两件商品都应在结果里');
  assert.ok(a < b, `有货商品应排在售罄商品之前（available=${a} soldOut=${b}）`);
  assert.equal(rows.find((p) => p.slug === soldOut.slug).outOfStock, true);
});
