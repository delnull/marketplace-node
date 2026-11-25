/**
 * 评价图逐图下架 / PII 擦除 / 孤儿媒体清扫。
 */
import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { storeMediaBuffer, uploadsDir } = await import('../src/productMedia.js');
const { app, request, db, owner, buyer } = ctx;
const ownerToken = (await login(ctx, owner)).token;
const buyerToken = (await login(ctx, buyer)).token;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function confirmedOrder(title) {
  const p = await request(app).post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title })).expect(200);
  assertOk(p);
  const o = await request(app).post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: p.body.data.slug }).expect(200);
  assertOk(o);
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", new Date(), o.body.data.id);
  return o.body.data.id;
}

async function uploadAndSubmit(orderNo) {
  const up = await request(app).post(`/api/orders/${orderNo}/review/images`)
    .set('Authorization', `Bearer ${buyerToken}`).set('Content-Type', 'image/png').send(PNG).expect(200);
  assertOk(up);
  const url = up.body.data.url;
  const sub = await request(app).post(`/api/orders/${orderNo}/review`)
    .set('Authorization', `Bearer ${buyerToken}`).send({ rating: 5, content: '带图', images: [url] }).expect(200);
  assertOk(sub);
  return url;
}

async function reviewRowOf(orderNo) {
  return await db.get('SELECT id FROM reviews WHERE order_id = (SELECT id FROM orders WHERE order_no = ?)', orderNo);
}

test('逐图下架：节点管理员删一张，JSON 与磁盘同时消失', async () => {
  const orderNo = await confirmedOrder('逐图下架商品');
  const url = await uploadAndSubmit(orderNo);
  const disk = `${uploadsDir()}/${url.split('/').pop()}`;
  assert.equal(fs.existsSync(disk), true);
  const review = await reviewRowOf(orderNo);
  assert.ok(review, '提交评价后必须有一行 reviews');

  /* 评价级读取：队列行已带图，打开详情时再读一次最新值（不含订单号/买家/正文） */
  const listed = await request(app).get(`/api/shop/reviews/${review.id}/images`)
    .set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(listed);
  assert.deepEqual(listed.body.data.images, [url]);
  assert.deepEqual(listed.body.data.followup, []);
  assert.equal(JSON.stringify(listed.body.data).includes(orderNo), false, '详情不得下发订单号');

  /* 原因必填：没有原因不能下架（否则审计里只剩"删了"，没有"为什么"） */
  const noReason = await request(app).delete(`/api/shop/reviews/${review.id}/images`)
    .set('Authorization', `Bearer ${ownerToken}`).send({ kind: 'review', url }).expect(400);
  assert.notEqual(noReason.body.code, 0);
  assert.equal(fs.existsSync(disk), true, '被拒绝的请求不能删图');

  const badKind = await request(app).delete(`/api/shop/reviews/${review.id}/images`)
    .set('Authorization', `Bearer ${ownerToken}`).send({ kind: 'image', url, reason: '测试' }).expect(400);
  assert.notEqual(badKind.body.code, 0);

  const r = await request(app).delete(`/api/shop/reviews/${review.id}/images`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ kind: 'review', url, reason: '测试下架' }).expect(200);
  assertOk(r);
  assert.equal(r.body.data.remaining, 0);
  assert.equal(fs.existsSync(disk), false, '下架必须删盘，不能只改 JSON');

  /*
    节点治理动作必须落在**节点级审计**里（2026-11 改为评价级路由，审计形状不变）。
    这里钉住：行是节点级、角色是 host/staff、目标店写在 detail 里（店铺详情靠它回看治理记录），
    并且下架原因与评价 id 都进审计。
  */
  const audit = await db.get("SELECT * FROM audit_logs WHERE action = 'review.image.remove' ORDER BY id DESC LIMIT 1");
  assert.ok(audit, '评价图下架必须留审计');
  assert.equal(audit.shop_code, null, '这是节点治理动作，不属于那家店');
  assert.equal(audit.actor_role, 'host');
  assert.equal(audit.detail.shopCode, shopRef.value, '目标店写在 detail 里，auditWhere 的 targetShop 用它归属');
  assert.equal(Number(audit.detail.reviewId), Number(review.id));
  assert.equal(audit.detail.reason, '测试下架');
  assert.equal(audit.detail.url, url);
  const byShop = await request(app)
    .get(`/api/shop/audit/node?targetShop=${shopRef.value}&pageSize=100`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.ok(byShop.body.data.items.some((i) => i.id === audit.id), '店铺详情的治理记录要能按 targetShop 找到这一行');

  /* 旧订单级路由必须已经删除（不保留兼容入口） */
  await request(app).get(`/api/orders/${orderNo}/review/images`)
    .set('Authorization', `Bearer ${ownerToken}`).expect(404);

  const after = await request(app).get(`/api/shop/reviews/${review.id}/images`)
    .set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.deepEqual(after.body.data.images, []);

  const o = await request(app).get(`/api/orders/${orderNo}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.deepEqual(o.body.data.review.images, []);
});

test('评价图队列：只出有图评价，可按店铺/商品/订单号筛选，且不下发订单号', async () => {
  const orderNo = await confirmedOrder('队列商品');
  const url = await uploadAndSubmit(orderNo);
  const review = await reviewRowOf(orderNo);
  const order = await db.get('SELECT product_slug FROM orders WHERE order_no = ?', orderNo);

  const q = await request(app).get('/api/shop/review-images?pageSize=100')
    .set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(q);
  const item = q.body.data.items.find((i) => i.reviewId === Number(review.id));
  assert.ok(item, '有图评价必须进队列');
  assert.deepEqual(item.images, [url]);
  assert.equal(item.shop.code, shopRef.value);
  assert.equal(item.product.slug, order.product_slug);
  assert.equal(JSON.stringify(item).includes(orderNo), false, '队列项不得下发订单号');
  assert.equal(JSON.stringify(item).includes(ctx.buyer.address.toLowerCase()), false, '队列项不得下发买家地址');

  const byOrder = await request(app).get(`/api/shop/review-images?orderNo=${orderNo}`)
    .set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(byOrder);
  assert.equal(byOrder.body.data.total, 1);
  assert.equal(byOrder.body.data.items[0].reviewId, Number(review.id));

  const byShop = await request(app).get(`/api/shop/review-images?shopCode=${shopRef.value}&pageSize=100`)
    .set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(byShop);
  assert.ok(byShop.body.data.items.some((i) => i.reviewId === Number(review.id)));

  const byProduct = await request(app).get(`/api/shop/review-images?productSlug=${order.product_slug}&pageSize=100`)
    .set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(byProduct);
  assert.ok(byProduct.body.data.items.some((i) => i.reviewId === Number(review.id)));

  /* 没有图的评价不进队列：否则翻页只是在看空行 */
  const noImgOrder = await confirmedOrder('无图评价商品');
  const submitted = await request(app).post(`/api/orders/${noImgOrder}/review`)
    .set('Authorization', `Bearer ${buyerToken}`).send({ rating: 5, content: '无图' }).expect(200);
  assertOk(submitted);
  const none = await request(app).get(`/api/shop/review-images?orderNo=${noImgOrder}`)
    .set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(none);
  assert.equal(none.body.data.total, 0);

  /* 店铺编号形状/校验位错必须 400，而不是"没有记录" */
  await request(app).get('/api/shop/review-images?shopCode=BAD')
    .set('Authorization', `Bearer ${ownerToken}`).expect(400);

  /*
    清掉本用例的图：评价图按内容去重，同一张 PNG 若留在这里，后面的 PII 擦除用例
    会因"文件仍被这条评价引用"而删不掉盘（计数为 0）——那是共享内容的正确行为，
    不是被测对象；用例之间必须各自收尾。
  */
  const cleanup = await request(app).delete(`/api/shop/reviews/${review.id}/images`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ kind: 'review', url, reason: '测试清理' }).expect(200);
  assertOk(cleanup);
});

test('并发下架同一组的两张图：行锁下两次删除都生效（不丢更新）', async () => {
  const orderNo = await confirmedOrder('并发下架商品');
  const submitted = await request(app).post(`/api/orders/${orderNo}/review`)
    .set('Authorization', `Bearer ${buyerToken}`).send({ rating: 5, content: '并发用例' }).expect(200);
  assertOk(submitted);
  const review = await reviewRowOf(orderNo);
  /* 用两个形状合法、盘上不存在的 URL：本用例只验 JSON 的读-改-写，不验删盘 */
  const u1 = `/api/uploads/${'a'.repeat(64)}.png`;
  const u2 = `/api/uploads/${'b'.repeat(64)}.png`;
  await db.run('UPDATE reviews SET images = ? WHERE id = ?', JSON.stringify([u1, u2]), review.id);

  const [r1, r2] = await Promise.all([
    request(app).delete(`/api/shop/reviews/${review.id}/images`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ kind: 'review', url: u1, reason: '并发下架 1' }).expect(200),
    request(app).delete(`/api/shop/reviews/${review.id}/images`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ kind: 'review', url: u2, reason: '并发下架 2' }).expect(200),
  ]);
  assertOk(r1);
  assertOk(r2);
  const row = await db.get('SELECT images FROM reviews WHERE id = ?', review.id);
  assert.deepEqual(row.images, [], '两次删除都必须生效；行锁缺失时后写会覆盖先写');
});

test('追评图：队列/详情认 followup 一组，下架按 kind 精确到那一组', async () => {
  const orderNo = await confirmedOrder('追评图商品');
  /* 首评不带图，图只出现在追评：队列的 `followup_images` 半边是唯一入口 */
  const submitted = await request(app).post(`/api/orders/${orderNo}/review`)
    .set('Authorization', `Bearer ${buyerToken}`).send({ rating: 5, content: '无图首评' }).expect(200);
  assertOk(submitted);
  const up = await request(app).post(`/api/orders/${orderNo}/review/images`)
    .set('Authorization', `Bearer ${buyerToken}`).set('Content-Type', 'image/png').send(PNG).expect(200);
  assertOk(up);
  const url = up.body.data.url;
  const disk = `${uploadsDir()}/${url.split('/').pop()}`;
  const followup = await request(app).post(`/api/orders/${orderNo}/review/followup`)
    .set('Authorization', `Bearer ${buyerToken}`).send({ content: '追评图', images: [url] }).expect(200);
  assertOk(followup);
  const review = await reviewRowOf(orderNo);

  const q = await request(app).get(`/api/shop/review-images?orderNo=${orderNo}`)
    .set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(q);
  assert.equal(q.body.data.total, 1);
  assert.deepEqual(q.body.data.items[0].images, []);
  assert.deepEqual(q.body.data.items[0].followup, [url]);

  const removed = await request(app).delete(`/api/shop/reviews/${review.id}/images`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ kind: 'followup', url, reason: '追评图下架' }).expect(200);
  assertOk(removed);
  assert.equal(removed.body.data.remaining, 0);
  assert.equal(fs.existsSync(disk), false);

  const after = await request(app).get(`/api/shop/review-images?orderNo=${orderNo}`)
    .set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(after);
  assert.equal(after.body.data.total, 0);
});

test('PII 擦除清评价图并删盘，评价正文保留', async () => {
  const orderNo = await confirmedOrder('PII 评价图商品');
  const url = await uploadAndSubmit(orderNo);
  const disk = `${uploadsDir()}/${url.split('/').pop()}`;
  const r = await request(app).post(`/api/shop/orders/${orderNo}/erase-pii`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(r);
  assert.equal(r.body.data.erased.reviewImages, 1);
  assert.equal(fs.existsSync(disk), false);
  const row = await db.get('SELECT content, images FROM reviews WHERE order_id = (SELECT id FROM orders WHERE order_no = ?)', orderNo);
  assert.equal(row.content, '带图');
  assert.deepEqual(row.images, []);
});

test('评价图删盘失败 → 进入待清理队列；下一轮重试删净并清标记', async () => {
  const orderNo = await confirmedOrder('PII 删盘重试商品');
  const url = await uploadAndSubmit(orderNo);
  const disk = `${uploadsDir()}/${url.split('/').pop()}`;
  assert.equal(fs.existsSync(disk), true);

  // 只让第一次 unlink 失败一次（mediaSweep 用的是同一个 fs 默认导出对象）
  const originalUnlink = fs.unlinkSync;
  let failOnce = true;
  fs.unlinkSync = (p, ...rest) => {
    if (failOnce) {
      failOnce = false;
      const e = new Error('unit-test: busy');
      e.code = 'EBUSY';
      throw e;
    }
    return originalUnlink.call(fs, p, ...rest);
  };
  let first;
  try {
    first = await request(app).post(`/api/shop/orders/${orderNo}/erase-pii`)
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.notEqual(first.body.code, 0, '删盘失败不能被报成"已擦干净"');
  assert.equal(first.body.data.cleanupPending, true);
  assert.equal(fs.existsSync(disk), true, '失败的这一份必须还在盘上（不能假装删了）');

  const orderKey = await db.get('SELECT id FROM orders WHERE order_no = ?', orderNo);
  let pending = await db.get('SELECT COUNT(*) AS c FROM pii_pending_media WHERE order_id = ?', orderKey.id);
  assert.equal(Number(pending.c), 1, '待删 URL 必须落库，否则下一轮找不回来');
  let flag = await db.get('SELECT pii_cleanup_pending FROM orders WHERE order_no = ?', orderNo);
  assert.equal(Number(flag.pii_cleanup_pending), 1, '必须挂上待清理标记');

  // 再走**保留期重试**（不是手动再点一次）：候选 SQL 必须凭 pii_pending_media/cleanup_pending 选中它
  const { runPiiRetention } = await import('../src/piiErase.js');
  const run = await runPiiRetention({ days: 9999, limit: 10 });
  assert.ok(run.erased >= 1, '待清理的媒体必须让这一单重新入选保留期扫描');
  assert.equal(fs.existsSync(disk), false, '重试必须把文件删掉');
  pending = await db.get('SELECT COUNT(*) AS c FROM pii_pending_media WHERE order_id = ?', orderKey.id);
  assert.equal(Number(pending.c), 0);
  flag = await db.get('SELECT pii_cleanup_pending FROM orders WHERE order_no = ?', orderNo);
  assert.equal(Number(flag.pii_cleanup_pending), 0);
});

test('孤儿媒体清扫：只删无引用且超 TTL 的文件', async () => {
  const old = storeMediaBuffer(PNG).url;
  const disk = `${uploadsDir()}/${old.split('/').pop()}`;
  const t = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(disk, t, t);
  const r = await request(app).post('/api/shop/media/sweep-orphans')
    .set('Authorization', `Bearer ${ownerToken}`).send({ olderThanDays: 7 }).expect(200);
  assertOk(r);
  assert.ok(r.body.data.removed >= 1);
  assert.equal(fs.existsSync(disk), false);
});

test('共享内容：仍被商品引用时不删，引用清掉后才删', async () => {
  const bytes = Buffer.concat([PNG, Buffer.from(' shared-delete-probe')]);
  const { url } = storeMediaBuffer(bytes);
  const disk = `${uploadsDir()}/${url.split('/').pop()}`;

  const created = await request(app).post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '共享媒体删除', media: [{ type: 'image', url }] })).expect(200);
  assertOk(created);

  const { removeMediaUrls } = await import('../src/mediaSweep.js');
  assert.equal((await removeMediaUrls([url])).removed, 0, '商品还在引用，不能按一处引用删掉共享文件');
  assert.equal(fs.existsSync(disk), true);

  const patched = await request(app).patch(`/api/products/${created.body.data.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ media: [] }).expect(200);
  assertOk(patched);
  assert.equal((await removeMediaUrls([url])).removed, 1, '全库已无引用，才真正删盘');
  assert.equal(fs.existsSync(disk), false);
});
