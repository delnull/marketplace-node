/**
 * 跨店信任集成测试：同一节点两家店，商品自身成交/评价完全一样（都没有），
 * 唯一差异是店铺 90 天成交记录——有记录的那家店，商品必须排在前面。
 *
 * 这是 productRank.js 里 shop trust 那一段 SQL 的唯一 API 级判据：纯函数测试
 * 只能证明公式方向，证明不了“店铺聚合真的按 shop_code 分组”。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, TEST_SHOP_CODE, insertProduct, insertOrder } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner, db } = ctx;

const SHOP_B = '0000SHB9G';
const sellerB = `0x${String(9000).padStart(40, '0')}`;
const buyerOf = (n) => `0x${String(n).padStart(40, '0')}`;

let ownerToken;
let productA; // 有店铺信任、无自身成交
let productB; // 无店铺信任、无自身成交

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  assert.ok(ownerToken);

  // 第二家店：直接写目录行（测试夹具没有“用另一把钱包开店”的入口；商品/订单仍走同一套表约束）
  await db.run(
    'INSERT INTO shops (code, seller, name, listed) VALUES (?, ?, ?, 1)',
    SHOP_B,
    sellerB,
    '跨店信任测试 B 店'
  );

  const ts = new Date(Date.now() - 86_400_000);
  const skus = [{ key: '', priceMicro: 1_000_000, capacity: 10, committed: 0 }];
  const product = (shopCode, title) =>
    insertProduct(db, {
      shopCode,
      title,
      description: '跨店信任测试商品',
      kind: 'physical',
      priceCurrency: 'USDT',
      publishedAt: ts,
      createdAt: ts,
      updatedAt: ts,
      skus,
    });

  productA = await product(TEST_SHOP_CODE, '跨店信任测试 A1');
  const booster = await product(TEST_SHOP_CODE, '跨店信任测试 A-boost');
  productB = await product(SHOP_B, '跨店信任测试 B1');

  /*
    给 A 店的“另一件商品”造 3 笔成交，只抬高**店铺**信任；A1 自己仍然没有成交/评价。
    B 店一笔都没有。这样 A1 与 B1 的差只剩店铺聚合。
  */
  for (let i = 0; i < 3; i += 1) {
    await insertOrder(db, {
      buyer: buyerOf(9100 + i),
      seller: owner.address.toLowerCase(),
      shopCode: TEST_SHOP_CODE,
      productId: booster.productId,
      productSlug: booster.slug,
      status: 'confirmed',
      quantity: 1,
      amountWei: '1000000',
      priceMicro: 1000000,
      updatedAt: new Date(),
    });
  }
});

test('composite：同商品、同新鲜度时，有店铺成交记录的商品排在无记录之前', async () => {
  const res = await request(app)
    .get(`/api/products?sort=composite&q=${encodeURIComponent('跨店信任测试')}&pageSize=50`)
    .expect(200);
  assertOk(res);
  const slugs = res.body.data.products.map((p) => p.slug);
  const a = slugs.indexOf(productA.slug);
  const b = slugs.indexOf(productB.slug);
  assert.ok(a >= 0, 'A 店商品必须在结果里');
  assert.ok(b >= 0, 'B 店商品必须在结果里');
  assert.ok(a < b, `A 店有成交记录，应排在 B 店之前（A=${a} B=${b}）`);
});
