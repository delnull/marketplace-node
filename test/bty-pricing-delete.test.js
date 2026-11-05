/**
 * BTY 直接定价 + 商品/订单软删除（2026-11 新项目形状）。
 *
 * 这里钉的是三条**形状级**承诺：
 *  1. BTY 定价商品的应付金额直接由微 BTY × 1e12 得出（`payment_rate_source='none'`，
 *     `bty_usdt_rate=0`），**不经过任何行情**；只能原生 BTY 支付。
 *  2. 商品软删除（店主 / 节点主）后退出公开面、店主管理列表与下单闸；历史订单仍可按快照成立。
 *  3. 订单软删除只允许 cancelled/expired；店主与买家各有一个独立标记——
 *     店主删只影响本店列表，买家删只影响自己的列表/详情，双方的历史与流水不受对方影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertOk,
  insertOrder,
  login,
  makeCtx,
  productPayload,
  shopRef,
} from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const ownerLogin = await login(ctx, owner);
const buyerLogin = await login(ctx, buyer);
/** supertest 的 `.set()` 只在选定 HTTP 方法后存在：先 `.post/.get/.delete`，再过这个包装 */
const asOwner = (t) => t.set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value);

async function createProduct(over = {}) {
  const res = await asOwner(request(app).post('/api/products')).send(productPayload(over)).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug, extra = {}) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .send({ productSlug: slug, ...extra })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

test('BTY 定价商品：价格直接成 wei，不读行情；拒绝 ERC20 支付', async () => {
  const p = await createProduct({
    title: 'BTY 直接定价',
    priceCurrency: 'BTY',
    skus: [{ key: '', priceMicro: 1_500_000 }],
  });
  assert.equal(p.priceCurrency, 'BTY');
  assert.equal(p.priceMicro, 1_500_000);
  assert.equal(p.price, '1.5');
  assert.equal(p.snapshotHash.length, 66);

  const d = await createDraft(p.slug);
  assert.equal(d.priceCurrency, 'BTY');
  assert.equal(d.priceMicro, 1_500_000);
  assert.equal(d.amountWei, '1500000000000000000', '1.5 BTY = 1.5e18 wei');
  assert.equal(d.paymentRateSource, 'none', 'BTY 定价没有行情腿');
  assert.equal(Number(d.btyUsdtRate), 0);
  assert.equal(d.productSnapshot.price_currency, 'BTY');
  assert.equal(d.productSnapshot.shipping_fee_micro, 0);
  assert.equal(d.productSnapshot.skus[0][1], 1_500_000);

  const bad = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .send({ productSlug: p.slug, paymentToken: '0x5555555555555555555555555555555555555555' })
    .expect(400);
  assert.notEqual(bad.body.code, 0);
  assert.match(bad.body.message, /BTY 定价|原生 BTY/);
});

test('BTY 定价商品：数量与运费都按微 BTY 直接折算', async () => {
  const p = await createProduct({
    title: 'BTY 实物带运费',
    kind: 'physical',
    priceCurrency: 'BTY',
    shippingFeeMicro: 250_000,
    skus: [{ key: '', priceMicro: 2_000_000, capacity: 10 }],
  });
  const d = await createDraft(p.slug, { quantity: 3 });
  assert.equal(d.priceMicro, 3 * 2_000_000 + 250_000);
  assert.equal(d.amountWei, '6250000000000000000'); // 6.25 BTY
  assert.equal(Number(d.shippingFeeMicro), 250_000);
});

test('BTY 大额定价：CHECK 不得用 BIGINT 乘法（20.5 BTY 会溢出）', async () => {
  const p = await createProduct({
    title: 'BTY 大额实物',
    kind: 'physical',
    priceCurrency: 'BTY',
    shippingFeeMicro: 500_000,
    skus: [{ key: '', priceMicro: 20_000_000, capacity: 10 }],
  });
  const d = await createDraft(p.slug);
  assert.equal(d.priceMicro, 20_500_000);
  assert.equal(d.amountWei, '20500000000000000000');
});

test('BTY 定价支付方式：只列原生 BTY，金额直接按 1e12 折算，不读行情', async () => {
  const r = await request(app)
    .get('/api/shop/payment-methods?priceMicro=2500000&priceCurrency=BTY')
    .expect(200);
  assertOk(r);
  assert.equal(r.body.data.tokens.length, 0, 'BTY 定价不列任何 ERC20（列出即意味着跨币种换算）');
  assert.equal(r.body.data.native.symbol, 'BTY');
  assert.equal(r.body.data.native.amountWei, '2500000000000000000');
  assert.equal(r.body.data.native.payable, true);
});

test('商品软删除：店主删除后公开面/下单/管理列表都不再出现，重复删除 404', async () => {
  const p = await createProduct({ title: '待删除商品', skus: [{ key: '', priceMicro: 1_000_000 }] });

  const del = await asOwner(request(app).delete(`/api/products/${p.slug}?confirm=1`)).expect(200);
  assertOk(del);

  const pub = await request(app).get(`/api/products/${p.slug}`).expect(404);
  assert.notEqual(pub.body.code, 0);

  const order = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .send({ productSlug: p.slug })
    .expect(404);
  assert.notEqual(order.body.code, 0);

  const all = await asOwner(request(app).get('/api/products/all')).expect(200);
  assert.ok(!all.body.data.products.some((x) => x.slug === p.slug));

  const batch = await asOwner(
    request(app).patch('/api/products/batch').send({ slugs: [p.slug], patch: { priceMicro: 2_000_000 } })
  ).expect(200);
  assert.ok(!batch.body.data.updated.includes(p.slug), '批量更新不得写入已删除商品');
  assert.match(batch.body.data.failed[0].reason, /已删除/);

  const again = await asOwner(request(app).delete(`/api/products/${p.slug}?confirm=1`)).expect(404);
  assert.notEqual(again.body.code, 0);
});

test('节点主强制删除：需原因；删除后默认管理列表不含，deleted=1 可复核原因', async () => {
  const p = await createProduct({ title: '节点强制删除', skus: [{ key: '', priceMicro: 1_000_000 }] });

  const noReason = await request(app)
    .delete(`/api/products/admin/${p.slug}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({})
    .expect(400);
  assert.notEqual(noReason.body.code, 0);

  const del = await request(app)
    .delete(`/api/products/admin/${p.slug}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ reason: '侵权内容' })
    .expect(200);
  assertOk(del);

  const all = await request(app)
    .get('/api/products/admin/all')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assert.ok(!all.body.data.products.some((x) => x.slug === p.slug));

  const deleted = await request(app)
    .get('/api/products/admin/all?deleted=1')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  const row = deleted.body.data.products.find((x) => x.slug === p.slug);
  assert.ok(row, 'deleted=1 应能复核已删除项');
  assert.equal(row.deletedReason, '侵权内容');

  const detail = await request(app)
    .get(`/api/products/admin/${p.slug}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assert.equal(detail.body.data.product.deleted, true, '节点主复核已删除商品时应能打开详情');
  assert.equal(detail.body.data.product.deletedReason, '侵权内容');
});

test('批量改价拒绝跨币种：同一个数字在 USDT 与 BTY 下不是一回事', async () => {
  const usdt = await createProduct({ title: '批量 USDT', skus: [{ key: '', priceMicro: 1_000_000 }] });
  const bty = await createProduct({
    title: '批量 BTY',
    priceCurrency: 'BTY',
    skus: [{ key: '', priceMicro: 1_000_000 }],
  });
  const r = await asOwner(
    request(app).patch('/api/products/batch').send({
      slugs: [usdt.slug, bty.slug],
      patch: { priceMicro: 2_000_000 },
    })
  ).expect(200);
  assert.notEqual(r.body.code, 0);
  assert.match(r.body.message, /计价币种不同/);

  const unchanged = await request(app).get(`/api/products/${usdt.slug}`).expect(200);
  assert.equal(unchanged.body.data.priceMicro, 1_000_000, '整批拒绝，不得写一半');
});

test('BTY 退款微单位向下取整：不足 1 微 BTY 的 wei 不进入统计', async () => {
  const { refundPriceMicroOfRow } = await import('../src/stats.js');
  assert.equal(refundPriceMicroOfRow({ price_currency: 'BTY', refunded_amount_wei: '999999999999' }), 0n);
  assert.equal(refundPriceMicroOfRow({ price_currency: 'BTY', refunded_amount_wei: '1000000000000' }), 1n);
  assert.equal(refundPriceMicroOfRow({ price_currency: 'BTY', refunded_amount_wei: '1999999999999' }), 1n);
});

test('订单软删除：只允许已取消/已超时；卖家列表移除而买家记录与详情保留', async () => {
  const p = await createProduct({ title: '订单删除', skus: [{ key: '', priceMicro: 1_000_000 }] });
  const draft = await createDraft(p.slug);

  // 未取消的草稿不可删
  const early = await asOwner(request(app).delete(`/api/orders/${draft.id}`)).expect(400);
  assert.notEqual(early.body.code, 0);

  const cancelled = await request(app)
    .post(`/api/orders/${draft.id}/cancel`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(200);
  assertOk(cancelled);

  const del = await asOwner(request(app).delete(`/api/orders/${draft.id}`)).expect(200);
  assertOk(del);

  const sellerList = await asOwner(request(app).get('/api/orders/seller?status=cancelled&pageSize=100')).expect(200);
  assert.ok(!sellerList.body.data.orders.some((o) => o.id === draft.id), '店主列表不应再出现已删除订单');

  const buyerList = await request(app).get(`/api/orders?address=${buyer.address.toLowerCase()}&pageSize=100`).expect(200);
  assert.ok(buyerList.body.data.orders.some((o) => o.id === draft.id), '买家自己的记录不因店主删除而消失');

  const detail = await request(app).get(`/api/orders/${draft.id}`).expect(200);
  assertOk(detail);
});

test('买家软删除：只影响自己的列表与详情；店主列表、详情与流水不受影响', async () => {
  const p = await createProduct({ title: '买家删除订单', skus: [{ key: '', priceMicro: 1_000_000 }] });
  const draft = await createDraft(p.slug);
  await request(app)
    .post(`/api/orders/${draft.id}/cancel`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(200);

  const del = await request(app)
    .delete(`/api/orders/${draft.id}/buyer`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(200);
  assertOk(del);

  const anonDetail = await request(app).get(`/api/orders/${draft.id}`).expect(404);
  assert.notEqual(anonDetail.body.code, 0, '匿名也不能按订单号绕过买家侧的删除');

  const buyerList = await request(app).get(`/api/orders?address=${buyer.address.toLowerCase()}&pageSize=100`).expect(200);
  assert.ok(!buyerList.body.data.orders.some((o) => o.id === draft.id), '买家自己的列表应隐藏已删除订单');

  const sellerList = await asOwner(request(app).get('/api/orders/seller?status=cancelled&pageSize=100')).expect(200);
  assert.ok(sellerList.body.data.orders.some((o) => o.id === draft.id), '买家删除不应影响店主列表');

  const detailBuyer = await request(app)
    .get(`/api/orders/${draft.id}`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(404);
  assert.notEqual(detailBuyer.body.code, 0);

  const detailSeller = await asOwner(request(app).get(`/api/orders/${draft.id}`)).expect(200);
  assertOk(detailSeller);
});

test('订单从终局恢复时清除双方软删除标记，恢复后的订单重新可见', async () => {
  const p = await createProduct({ title: '恢复删除订单', skus: [{ key: '', priceMicro: 1_000_000 }] });
  const draft = await createDraft(p.slug);
  await request(app)
    .post(`/api/orders/${draft.id}/cancel`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(200);

  await asOwner(request(app).delete(`/api/orders/${draft.id}`)).expect(200);
  await request(app)
    .delete(`/api/orders/${draft.id}/buyer`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(200);

  const deleted = await db.get(
    'SELECT seller_deleted_at, buyer_deleted_at FROM orders WHERE order_no = ?',
    draft.id
  );
  assert.ok(deleted.seller_deleted_at, '卖家删除标记应写入');
  assert.ok(deleted.buyer_deleted_at, '买家删除标记应写入');

  // watcher / 对账 / sync 都会走同一条直接 UPDATE：状态离开终局时触发器必须清标记
  await db.run("UPDATE orders SET status = 'escrowed' WHERE order_no = ?", draft.id);
  const revived = await db.get(
    'SELECT status, seller_deleted_at, buyer_deleted_at FROM orders WHERE order_no = ?',
    draft.id
  );
  assert.equal(revived.status, 'escrowed');
  assert.equal(revived.seller_deleted_at, null);
  assert.equal(revived.buyer_deleted_at, null);

  const sellerList = await asOwner(request(app).get('/api/orders/seller?status=escrowed&pageSize=100')).expect(200);
  assert.ok(sellerList.body.data.orders.some((o) => o.id === draft.id), '恢复后的订单必须回到卖家列表');
  const buyerList = await request(app).get(`/api/orders?address=${buyer.address.toLowerCase()}&pageSize=100`).expect(200);
  assert.ok(buyerList.body.data.orders.some((o) => o.id === draft.id), '恢复后的订单必须回到买家列表');
});

test('订单软删除：在途订单不能删（不提供删除入口）', async () => {
  const order = await insertOrder(db, {
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    skuKey: '',
    status: 'escrowed',
    priceMicro: 1_000_000,
    amountWei: '1000000000000000000',
  });
  const r = await asOwner(request(app).delete(`/api/orders/${order.orderNo}`)).expect(400);
  assert.notEqual(r.body.code, 0);
});
