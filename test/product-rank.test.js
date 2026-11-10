/**
 * 节点内「综合」排序（src/productRank.js）。
 *
 * 这里锁两件事：
 *  1. 纯评分函数的方向性（成交/评价/店铺可信度抬高，退款降低，新品只有新鲜度）；
 *  2. API 真的按这个顺序返回，且 composite 的 offset 分页不重不漏。
 *
 * 不测“具体权重数值”——那是产品参数，改了不该让一堆积木式断言跟着红；测的是
 * “更高成交/更好评价/更高店铺信任 ⇒ 不应排更后”这类方向性判据。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef, TEST_SHOP_CODE, insertOrder } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner, db } = ctx;
// `productRank.js` 会经 db.js 读 config；必须在 makeCtx 把 MK_SHOP_OWNER 等写进 env 之后再导入。
const { productScoreOf, shopTrustOf, isSoldOut, applyAvailability } = await import('../src/productRank.js');

let ownerToken;
let a; // 有成交 + 评价
let b; // 纯新品
let aFirstOrder;

const buyerOf = (n) => `0x${String(n).padStart(40, '0')}`;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;

  const create = async (title) => {
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Mk-Shop', shopRef.value)
      .send(productPayload({ title, description: `${title} 的说明` }))
      .expect(200);
    assertOk(res);
    const slug = res.body.data.slug;
    const row = await db.get('SELECT id FROM products WHERE slug = ?', slug);
    return { id: Number(row.id), slug };
  };

  a = await create('综合排序 A');
  b = await create('综合排序 B');

  for (let i = 0; i < 3; i += 1) {
    const buyer = buyerOf(1000 + i);
    const o = await insertOrder(db, {
      buyer,
      seller: owner.address.toLowerCase(),
      shopCode: TEST_SHOP_CODE,
      productId: a.id,
      productSlug: a.slug,
      status: 'confirmed',
      quantity: 1,
      amountWei: '1000000',
      priceMicro: 1000000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (i === 0) aFirstOrder = { order: o, buyer };
  }

  await db.run(
    'INSERT INTO reviews (order_id, product_id, buyer, rating, content) VALUES (?, ?, ?, ?, ?)',
    aFirstOrder.order.orderId,
    a.id,
    aFirstOrder.buyer,
    5,
    '好评'
  );

  /*
    给 B 造两类“不该加分”的单：
      · 自买（buyer = seller）；
      · 退款单。
    它们既不该让 B 超过 A，也不该把 A 挤下去。
  */
  await insertOrder(db, {
    buyer: owner.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    shopCode: TEST_SHOP_CODE,
    productId: b.id,
    productSlug: b.slug,
    status: 'confirmed',
    quantity: 10,
    amountWei: '10000000',
    priceMicro: 1000000,
    updatedAt: new Date(),
  });
  await insertOrder(db, {
    buyer: buyerOf(2000),
    seller: owner.address.toLowerCase(),
    shopCode: TEST_SHOP_CODE,
    productId: b.id,
    productSlug: b.slug,
    status: 'refunded',
    quantity: 1,
    amountWei: '1000000',
    priceMicro: 1000000,
    refundedAmountWei: '1000000',
    updatedAt: new Date(),
  });
});

async function list(query) {
  const res = await request(app).get(`/api/products?${query}`).expect(200);
  assertOk(res);
  return res.body.data;
}

test('productRank.shopTrustOf: 新店 0，有真实成交/低退款/店龄抬高，高退款降低', () => {
  assert.equal(shopTrustOf({ orders90: 0, buyers90: 0, refunded90: 0, completed90: 0, ageDays: 0 }), 0);

  const good = shopTrustOf({ orders90: 30, buyers90: 20, refunded90: 0, completed90: 30, ageDays: 365 });
  assert.ok(good > 0.95, `30 单/20 买家/无退款/一年应接近满分，实际 ${good}`);

  const refunded = shopTrustOf({ orders90: 30, buyers90: 20, refunded90: 6, completed90: 30, ageDays: 365 });
  assert.ok(refunded < good, '退款率 20% 必须低于无退款');
});

test('productRank.isSoldOut: 只有“有来源且来源耗尽”才算售罄', () => {
  const base = {
    kind: 'physical',
    skuTotal: 0,
    skuAvailable: 0,
    codeTotal: 0,
    codeAvailable: 0,
    tokenTotal: 0,
    tokenAvailable: 0,
  };
  assert.equal(isSoldOut(base), false, '没有任何库存来源 ⇒ 手动交付，不判售罄');
  assert.equal(isSoldOut({ ...base, skuTotal: 3, skuAvailable: 0 }), true, '限量 SKU 全耗尽');
  assert.equal(isSoldOut({ ...base, skuTotal: 3, skuAvailable: 1 }), false, '还有一件就不算售罄');
  assert.equal(isSoldOut({ ...base, kind: 'digital', codeTotal: 2, codeAvailable: 0 }), true, '码池全 used');
  assert.equal(isSoldOut({ ...base, kind: 'digital', codeTotal: 0 }), false, '无码池 = 手动交付');
  assert.equal(isSoldOut({ ...base, kind: 'nft', tokenTotal: 1, tokenAvailable: 0 }), true, 'NFT token 池耗尽');
});

test('productRank.applyAvailability: 售罄只封顶、不隐藏', () => {
  assert.equal(applyAvailability(800_000, true), 200_000);
  assert.equal(applyAvailability(50_000, true), 50_000, '低分不被抬到天花板');
  assert.equal(applyAvailability(800_000, false), 800_000);
});

test('productRank.productScoreOf: 成交/评价/店铺信任抬高，退款降低；新品只有新鲜度', () => {
  const freshOnly = productScoreOf({
    orders30: 0, buyers30: 0, units30: 0, reviews: 0, ratingSum: 0,
    orders90: 0, refunded90: 0, ageDays: 0, shopTrust: 0,
  });
  assert.equal(freshOnly, 100_000, '只有 10% 新鲜度');

  const established = productScoreOf({
    orders30: 20, buyers30: 15, units30: 30, reviews: 20, ratingSum: 100,
    orders90: 20, refunded90: 0, ageDays: 30, shopTrust: 0.8,
  });
  assert.ok(established > freshOnly, '成交/评价/店铺信任齐全的商品必须高于纯新品');

  const refunded = productScoreOf({
    orders30: 20, buyers30: 15, units30: 30, reviews: 20, ratingSum: 100,
    orders90: 20, refunded90: 8, ageDays: 30, shopTrust: 0.8,
  });
  assert.ok(refunded < established, '退款率 40% 必须拉低质量分');

  const noShopTrust = productScoreOf({
    orders30: 20, buyers30: 15, units30: 30, reviews: 20, ratingSum: 100,
    orders90: 20, refunded90: 0, ageDays: 30, shopTrust: 0,
  });
  assert.ok(established > noShopTrust, '同商品在更高信任店铺里应更高分');
});

test('composite: 有成交/评价的商品排在纯新品前；newest 仍按创建倒序', async () => {
  const composite = await list('sort=composite&pageSize=10');
  assert.equal(composite.products[0].slug, a.slug, 'A 有成交与评价，应排第一');
  assert.equal(composite.sort, 'composite');

  const newest = await list('sort=newest&pageSize=10');
  assert.equal(newest.products[0].slug, b.slug, 'newest 下后创建的 B 在前');

  const oldest = await list('sort=oldest&pageSize=10');
  assert.equal(oldest.products[0].slug, a.slug, 'oldest 下先创建的 A 在前');
});

test('composite: offset 分页不重不漏，nextCursor 到底为 null', async () => {
  const p1 = await list('sort=composite&pageSize=1');
  assert.equal(p1.products.length, 1);
  assert.equal(p1.products[0].slug, a.slug);
  assert.equal(p1.nextCursor, 1, 'offset 游标指向下一条');

  const p2 = await list(`sort=composite&pageSize=1&cursor=${p1.nextCursor}`);
  assert.equal(p2.products.length, 1);
  assert.equal(p2.products[0].slug, b.slug, '第二页不得重复第一页');
  assert.equal(p2.nextCursor, null, '已到底');
});

test('composite: 与关键词筛选正交；非法 sort 响亮拒绝', async () => {
  const filtered = await list(`sort=composite&q=${encodeURIComponent('综合排序 A')}`);
  assert.deepEqual(filtered.products.map((p) => p.slug), [a.slug]);

  await request(app).get('/api/products?sort=hot').expect(400);
});

test('composite: 店铺作用域仍然生效（X-Mk-Shop）', async () => {
  const r = await request(app)
    .get('/api/products?sort=composite&pageSize=10')
    .set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(r);
  assert.deepEqual(r.body.data.products.map((p) => p.slug).sort(), [a.slug, b.slug].sort());
});
