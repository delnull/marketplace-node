/**
 * 评价图片与追评（节点本地图片；一单一评 + 一次追评）。
 *
 * 判据：
 *   · 只有该订单买家能上传评价图；图只收图片（字节判定），最多 3 张；
 *   · 评价提交带图，公开列表/订单详情都能读到同一组节点相对 URL；
 *   · 追评一次（文字/图片至少一项），重复追评拒绝；
 *   · `%`/外链/不存在的 URL 不能混进评价图。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const ownerToken = (await login(ctx, owner)).token;
const buyerToken = (await login(ctx, buyer)).token;
const stranger = Wallet.createRandom();
const strangerToken = (await login(ctx, stranger)).token;

/** 1x1 PNG（真实字节，够类型嗅探） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function makeOrder(title) {
  const p = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title }))
    .expect(200);
  assertOk(p);
  const o = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: p.body.data.slug })
    .expect(200);
  assertOk(o);
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", new Date(), o.body.data.id);
  return { slug: p.body.data.slug, orderNo: o.body.data.id };
}

async function uploadImage(orderNo, token) {
  return await request(app)
    .post(`/api/orders/${orderNo}/review/images`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'image/png')
    .send(PNG);
}

test('评价图：买家上传、随评价公开；外链/他人/非图片拒绝', async () => {
  const { slug, orderNo } = await makeOrder('评价图商品');

  const strangerUp = await uploadImage(orderNo, strangerToken);
  assert.equal(strangerUp.status, 403, '非买家不能上传该单评价图');

  const pdf = await request(app)
    .post(`/api/orders/${orderNo}/review/images`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .set('Content-Type', 'application/pdf')
    .send(Buffer.from('%PDF-1.7 not really'));
  assert.notEqual(pdf.body.code, 0);
  assert.match(String(pdf.body.message), /评价图.*只收|无法识别/);

  const up = await uploadImage(orderNo, buyerToken);
  assertOk(up);
  assert.equal(up.body.data.kind, 'image');
  assert.match(up.body.data.url, /^\/api\/uploads\/[0-9a-f-]{36}\.png$/);
  const url = up.body.data.url;

  // 外链/不存在的本地文件不能混进评价图
  const external = await request(app)
    .post(`/api/orders/${orderNo}/review`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ rating: 5, content: '带图', images: ['https://example.com/a.png'] });
  assert.notEqual(external.body.code, 0);
  assert.match(String(external.body.message), /\/api\/uploads/);

  const missing = await request(app)
    .post(`/api/orders/${orderNo}/review`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({
      rating: 5,
      content: '带图',
      images: ['/api/uploads/00000000-0000-4000-8000-000000000000.png'],
    });
  assert.notEqual(missing.body.code, 0);
  assert.match(String(missing.body.message), /不存在/);

  const submitted = await request(app)
    .post(`/api/orders/${orderNo}/review`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ rating: 5, content: '图评', images: [url] })
    .expect(200);
  assertOk(submitted);
  assert.deepEqual(submitted.body.data.images, [url]);

  const detail = await request(app)
    .get(`/api/orders/${orderNo}`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  assert.deepEqual(detail.body.data.review.images, [url]);

  const list = await request(app).get(`/api/products/${slug}/reviews?pageSize=10`).expect(200);
  const row = list.body.data.items.find((r) => r.images.includes(url));
  assert.ok(row, '公开评价列表必须带评价图');
});

test('追评：一次，可只发文字或只发图；重复与陌生人拒绝', async () => {
  const { orderNo } = await makeOrder('追评商品');
  const up = await uploadImage(orderNo, buyerToken);
  assertOk(up);
  const url = up.body.data.url;
  await request(app)
    .post(`/api/orders/${orderNo}/review`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ rating: 4, content: '首评', images: [url] })
    .expect(200);

  const strangerFollow = await request(app)
    .post(`/api/orders/${orderNo}/review/followup`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .send({ content: '越权' });
  assert.equal(strangerFollow.status, 403);

  const empty = await request(app)
    .post(`/api/orders/${orderNo}/review/followup`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({});
  assert.notEqual(empty.body.code, 0);

  const follow = await request(app)
    .post(`/api/orders/${orderNo}/review/followup`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ content: '用了一周，仍然很好', images: [url] })
    .expect(200);
  assertOk(follow);
  assert.equal(follow.body.data.followup.content, '用了一周，仍然很好');
  assert.deepEqual(follow.body.data.followup.images, [url]);

  const again = await request(app)
    .post(`/api/orders/${orderNo}/review/followup`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ content: '再追一次' });
  assert.notEqual(again.body.code, 0);
  assert.match(String(again.body.message), /已追评/);
});

test('评价图最多 3 张', async () => {
  const { orderNo } = await makeOrder('评价图上限商品');
  const urls = [];
  for (let i = 0; i < 4; i += 1) {
    const up = await uploadImage(orderNo, buyerToken);
    assertOk(up);
    urls.push(up.body.data.url);
  }
  const res = await request(app)
    .post(`/api/orders/${orderNo}/review`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ rating: 5, images: urls });
  assert.notEqual(res.body.code, 0);
  assert.match(String(res.body.message), /最多 3 张/);
});
