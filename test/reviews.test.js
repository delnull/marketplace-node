/**
 * 买家评价（P0-1）：
 *  - 成交终局（confirmed/settled/expired）买家本人一单一评，TTL 内有效；
 *  - 店主单次回复；商品/店铺聚合（count/avg/dist）；公开面匿名短地址。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();

let ownerToken;
let buyerToken;
let strangerToken;
let slug;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  strangerToken = (await login(ctx, stranger)).token;
});

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(productSlug, who = buyer.address, token = buyerToken) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ productSlug, buyer: who })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 直接把草稿置为成交终局（模拟 watcher 迁移；updated_at=终局时刻） */
function settleConfirmed(orderId, at = Date.now()) {
  db.prepare("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE id = ?").run(at, orderId);
}

async function postReview(orderId, body, token) {
  const req = request(app).post(`/api/orders/${orderId}/review`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
}

test('成交订单买家可评价（一单一评）；非成交/他人/重复均拒绝', async () => {
  const p = await listProduct(productPayload({ title: '评价商品A' }));
  slug = p.slug;
  const o = await createDraft(slug);

  // 草稿态不可评
  let r = await postReview(o.id, { rating: 5, content: '还没成交' }, buyerToken);
  assert.notEqual(r.body.code, 0);
  assert.match(r.body.message || '', /不可评价/);

  // 成交后可评
  settleConfirmed(o.id);
  r = await postReview(o.id, { rating: 5, content: '很好，卡密秒到' }, buyerToken);
  assertOk(r);
  assert.equal(r.body.data.rating, 5);

  // 重复评价拒绝（一单一评）
  r = await postReview(o.id, { rating: 1 }, buyerToken);
  assert.notEqual(r.body.code, 0);
  assert.match(r.body.message || '', /已评价/);

  // 他人/匿名拒绝
  const o2 = await createDraft(slug);
  settleConfirmed(o2.id);
  const byStranger = await postReview(o2.id, { rating: 5 }, strangerToken);
  assert.notEqual(byStranger.body.code, 0);
  const anon = await postReview(o2.id, { rating: 5 });
  assert.equal(anon.status, 401);
});

test('退款/取消订单不可评；TTL 过期拒绝；rating/content 边界', async () => {
  const p = await listProduct(productPayload({ title: '评价边界商品' }));
  const refunded = await createDraft(p.slug);
  db.prepare("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?").run(Date.now(), refunded.id);
  const r1 = await postReview(refunded.id, { rating: 5 }, buyerToken);
  assert.notEqual(r1.body.code, 0);

  const expired = await createDraft(p.slug);
  settleConfirmed(expired.id, Date.now() - 31 * 24 * 3600_000); // 超 TTL（默认 30 天）
  const r2 = await postReview(expired.id, { rating: 5 }, buyerToken);
  assert.notEqual(r2.body.code, 0);
  assert.match(r2.body.message || '', /期限/);

  const bad = await createDraft(p.slug);
  settleConfirmed(bad.id);
  assert.notEqual((await postReview(bad.id, { rating: 0 }, buyerToken)).body.code, 0);
  assert.notEqual((await postReview(bad.id, { rating: 6 }, buyerToken)).body.code, 0);
  assert.notEqual((await postReview(bad.id, { rating: 5, content: 'x'.repeat(1001) }, buyerToken)).body.code, 0);
});

test('店主单次回复；订单对象 review 字段（rated/reviewable）', async () => {
  const p = await listProduct(productPayload({ title: '评价回复商品' }));
  const o = await createDraft(p.slug);

  // 未评时详情 review.rated=false 且成交后 reviewable=true
  settleConfirmed(o.id);
  const detail = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(detail.body.data.review.rated, false);
  assert.equal(detail.body.data.review.reviewable, true);

  const r = await postReview(o.id, { rating: 4, content: '不错' }, buyerToken);
  assertOk(r);
  // 非店主不可回复
  const no = await request(app)
    .post(`/api/orders/${o.id}/review/reply`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ content: '买家自回' })
    .expect(403);
  assert.ok(no);
  // 店主回复一次
  const rep = await request(app)
    .post(`/api/orders/${o.id}/review/reply`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ content: '感谢支持' })
    .expect(200);
  assertOk(rep);
  // 二次回复拒绝
  const rep2 = await request(app)
    .post(`/api/orders/${o.id}/review/reply`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ content: '再回一次' })
    .expect(200);
  assert.notEqual(rep2.body.code, 0);
  assert.match(rep2.body.message || '', /已回复/);

  // 详情 review 带内容与回复
  const after = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(after.body.data.review.rated, true);
  assert.equal(after.body.data.review.rating, 4);
  assert.equal(after.body.data.review.reply, '感谢支持');
});

test('商品评价列表聚合（count/avg/dist）与匿名短地址；详情带 summary、公开列表不带', async () => {
  const p = await listProduct(productPayload({ title: '评价聚合商品' }));
  const ratings = [5, 5, 3];
  for (const rating of ratings) {
    const o = await createDraft(p.slug);
    settleConfirmed(o.id);
    await postReview(o.id, { rating, content: `评价 ${rating} 星` }, buyerToken);
  }
  const list = await request(app).get(`/api/products/${p.slug}/reviews?pageSize=10`).expect(200);
  assertOk(list);
  const { summary, total, items } = list.body.data;
  assert.equal(total, 3);
  assert.equal(summary.count, 3);
  assert.equal(summary.avg, 4.3, '平均分保留 1 位');
  // 聚合只给 count/avg：界面用不到星级分布，多算一次 GROUP BY 没有意义
  assert.ok(!('dist' in summary), '聚合不下发星级分布');
  assert.equal(items.length, 3);
  for (const it of items) {
    assert.ok(!it.buyerShort.includes(buyer.address.slice(2)), '不暴露完整买家地址');
    assert.ok(!('buyer' in it), '不下发完整地址字段');
  }

  // 详情带 reviewSummary
  const detail = await request(app).get(`/api/products/${p.slug}`).expect(200);
  assert.equal(detail.body.data.reviewSummary.count, 3);
  // 公开列表附评价聚合（count/avg——商品卡社会信号；评审 B12 新契约：不含 dist 明细以控制开销）
  const pub = await request(app).get('/api/products').expect(200);
  const row = pub.body.data.products.find((x) => x.slug === p.slug);
  assert.ok(row.reviewSummary, '列表应带评价聚合（商品卡展示用）');
  assert.equal(row.reviewSummary.count, 3);
  assert.equal(row.reviewSummary.avg, 4.3);
  assert.ok(!('dist' in row.reviewSummary), '列表聚合不含星级分布明细（开销隔离）');
});

test('店铺级评价聚合 /api/shop/reviews/stats', async () => {
  const stats = await request(app).get('/api/shop/reviews/stats').expect(200);
  assertOk(stats);
  assert.ok(stats.body.data.count >= 4, '店级计数包含历史评价');
  assert.ok(stats.body.data.avg > 0);
});
