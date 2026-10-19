import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

/**
 * 卖家列表的「资料是否齐全」：筛选（`?incomplete=1`）与逐行 `missing` 必须**同源**。
 *
 * 判据只有一处（`routes/products.js` 的 `COMPLETENESS_MISSING_SQL`）。这个文件钉的是：
 *  1. 缺什么就报什么（主图 / 说明 / 参数 / 实物承诺发货时效），齐全时是空数组；
 *  2. **筛选出来的条数 = 带 missing 的条数**（两者若各判一次，就会出现"筛出 3 条、其中 1 条说不缺"）；
 *  3. 数字/NFT 商品**不因"没承诺发货时效"被判不全**（它们没有"发货"这件事）；
 *  4. 与"上架与否"无关：草稿照样能被检查（补资料时它正是最该被提醒的那批）。
 */
const ctx = await makeCtx();
const { app, request, owner } = ctx;
let ownerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
});

const create = async (body) => {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send(body).expect(200);
  assertOk(res);
  return res.body.data;
};
const all = async (query = '') => {
  const res = await request(app).get(`/api/products/all${query}`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(res);
  return res.body.data.products;
};
const bySlug = async (slug) => (await all()).find((p) => p.slug === slug);

test('齐全 = 空数组；缺什么报什么（四种键）', async () => {
  const full = await create(
    productPayload({
      kind: 'physical',
      title: '资料齐全甲',
      description: '有说明',
      media: [{ type: 'image', url: 'https://a/b.png' }],
      attributes: [{ name: '成色', value: '全新未拆封' }],
      terms: { handling_days: 2 },
      capacity: 5,
    })
  );
  assert.deepEqual((await bySlug(full.slug)).missing, [], '四样都有 ⇒ 齐全');

  const bare = await create(productPayload({ kind: 'physical', title: '资料缺项乙', description: '', media: [], capacity: 5 }));
  const missing = (await bySlug(bare.slug)).missing;
  assert.ok(missing.includes('media'), '没有主图');
  assert.ok(missing.includes('description'), '没有说明');
  assert.ok(missing.includes('attributes'), '没有参数');
  assert.ok(missing.includes('handling_days'), '实物商品没承诺发货时效');
});

test('数字/NFT 不因"没承诺发货时效"被判不全（没有发货这件事）', async () => {
  const d = await create(
    productPayload({
      kind: 'digital',
      title: '数字商品丙',
      description: '有说明',
      media: [{ type: 'image', url: 'https://a/b.png' }],
      attributes: [{ name: '面额', value: '100 元' }],
      capacity: 5,
    })
  );
  assert.deepEqual((await bySlug(d.slug)).missing, [], '数字商品齐全时不该被 handling_days 拖成不全');
});

test('筛选与行内提示同源：?incomplete=1 出来的每一条都真的不全，齐全的一条都不出现', async () => {
  const rows = await all('?incomplete=1&pageSize=100');
  assert.ok(rows.length > 0, '本文件造过缺项商品');
  for (const r of rows) assert.ok(r.missing.length > 0, `${r.title} 出现在"资料不全"里却没有缺失项`);
  const full = await all('?pageSize=100');
  const incompleteSlugs = new Set(rows.map((r) => r.slug));
  for (const r of full) {
    if (r.missing.length === 0) assert.ok(!incompleteSlugs.has(r.slug), `${r.title} 资料齐全却出现在筛选结果里`);
    else assert.ok(incompleteSlugs.has(r.slug), `${r.title} 有缺失项却没被筛出来`);
  }
});

test('与上架与否无关：草稿照样能被检查出来（补资料队列里最该有它）', async () => {
  const draft = await create(productPayload({ kind: 'physical', title: '草稿缺项丁', description: '', media: [], capacity: 5, active: false }));
  const rows = await all('?incomplete=1&pageSize=100');
  assert.ok(rows.some((r) => r.slug === draft.slug), '草稿也应出现在资料不全的队列里');
  assert.equal((await all()).find((p) => p.slug === draft.slug).active, false, '它仍然是未上架');
});
