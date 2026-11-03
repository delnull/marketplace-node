import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

/**
 * 商品参数的**筛选与分面**（`?attr=名:值` 与 `GET /api/products/attributes`）。
 *
 * 这一组判据要钉住的是"参数能被用来找东西"这件事的四个面：
 *  1. 写入即完整：`products.attributes` 是被筛选的那一份，`pair`（名键 + \u0000 + 值键）就在同一列里——
 *     同一列里落库，所以"只更新了一处"这种漂移在形状上不可表达（改一次参数不影响另一件商品）；
 *  2. 键匹配：两侧都归一成键，`成色`/`成色 `、`USB-C`/`usb-c` 命中同一批（写法不影响命中）；
 *  3. 三态：没按参数筛（attr=null）／筛了但查不到（结果空、attr 有值）／形状写错（attrError 说清原因），
 *     三者不能混成一句话，且**非法输入不静默**（不返回全量、也不 500）；
 *  4. 分面口径：只数上架商品、按 (名,值) 成对计数、展示形取"多数写法，并列取字典序最小"、排序稳定。
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

const list = async (query) => {
  const res = await request(app).get(`/api/products?${query}`).expect(200);
  assertOk(res);
  return res.body.data;
};

const facets = async (query = '') => {
  const res = await request(app).get(`/api/products/attributes${query}`).expect(200);
  assertOk(res);
  return res.body.data;
};

test('写入即镜像：参数筛选按 (名,值) 全等命中，未声明的商品不命中', async () => {
  await create(
    productPayload({
      kind: 'physical',
      title: '参数筛选甲',
      attributes: [
        { name: '成色', value: '全新未拆封' },
        { name: '产地', value: '中国大陆' },
      ],
      capacity: 5,
    })
  );
  await create(productPayload({ kind: 'physical', title: '参数筛选乙', attributes: [{ name: '成色', value: '九成新' }], capacity: 5 }));
  await create(productPayload({ kind: 'physical', title: '参数筛选丙·无参数', capacity: 5 }));

  const hit = await list('attr=' + encodeURIComponent('成色:全新未拆封'));
  assert.deepEqual(hit.products.map((p) => p.title), ['参数筛选甲']);
  assert.equal(hit.attr.display, '成色:全新未拆封');
  assert.equal(hit.attrError, null);

  // 键匹配：名字与值的写法差异（大小写/空白）都吸收在键里
  const loose = await list('attr=' + encodeURIComponent(' 成色 : 全新未拆封 '));
  assert.deepEqual(loose.products.map((p) => p.title), ['参数筛选甲']);

  // 值里有冒号：按**第一个**冒号切分，不该被切成两个字段
  await create(productPayload({ kind: 'physical', title: '参数筛选丁', attributes: [{ name: '接口', value: 'USB-C: 3.2' }], capacity: 5 }));
  const colon = await list('attr=' + encodeURIComponent('接口:USB-C: 3.2'));
  assert.deepEqual(colon.products.map((p) => p.title), ['参数筛选丁']);
});

test('三态：没筛 / 筛了查不到 / 形状写错，三件事各自说清，且非法输入不静默返回全量', async () => {
  const none = await list('');
  assert.equal(none.attr, null, '没给 attr ⇒ attr 为 null（"没按参数过滤"）');
  assert.equal(none.attrError, null);

  const miss = await list('attr=' + encodeURIComponent('成色:不存在'));
  assert.deepEqual(miss.products, [], '按参数筛了但查不到 ⇒ 空结果');
  assert.ok(miss.attr, '但 attr 仍有值：这不是"没筛"，是"筛了没有"');

  const bad = await list('attr=' + encodeURIComponent('没有冒号'));
  assert.deepEqual(bad.products, [], '形状错误 ⇒ 空结果（绝不返回全量当作"没筛"）');
  assert.match(String(bad.attrError), /参数名:值/);

  const emptySide = await list('attr=' + encodeURIComponent('成色:'));
  assert.match(String(emptySide.attrError), /不能为空/);

  const dup = await request(app).get('/api/products?attr=a:b&attr=c:d').expect(200);
  assert.equal(dup.body.code, 0);
  assert.match(String(dup.body.data.attrError), /一次只能给一个/);
});

test('分面：只数上架商品、展示形取多数写法（并列取字典序最小）、排序稳定', async () => {
  // 同一对键、三种写法：多数写法是 iPhone 15（两次），并列时按字典序兜底
  await create(productPayload({ kind: 'physical', title: '分面甲', attributes: [{ name: '型号', value: 'iPhone 15' }], capacity: 5 }));
  await create(productPayload({ kind: 'physical', title: '分面乙', attributes: [{ name: '型号', value: 'iPhone 15' }], capacity: 5 }));
  await create(productPayload({ kind: 'physical', title: '分面丙', attributes: [{ name: '型号', value: 'iphone 15' }], capacity: 5 }));
  // 下架商品不进分面（否则点进去必然空列表）
  await create(
    productPayload({ kind: 'physical', title: '分面丁·草稿', attributes: [{ name: '型号', value: 'iPhone 15' }], capacity: 5, active: false })
  );

  const first = await facets();
  const row = first.attributes.find((a) => a.nameKey === '型号' && a.valueKey === 'iphone 15');
  assert.ok(row, '同一对键只出一行');
  assert.equal(row.value, 'iPhone 15', '展示形 = 多数写法');
  assert.equal(row.count, 3, '只数上架商品（草稿不计）');

  // 稳定：连查两次逐字相同（展示形会随次数漂移的写法在这里被钉死）
  const second = await facets();
  assert.deepEqual(second.attributes, first.attributes);
  assert.equal(first.truncated, false);
  assert.ok(first.total >= first.attributes.length);
});

test('分面 limit：非法值明确拒绝（不静默钳制），截断时给 total 与 truncated', async () => {
  // 本仓的失败形状是 HTTP 200 + 非 0 code（与 /tags 的 limit 拒绝同一口径）
  const zero = await request(app).get('/api/products/attributes?limit=0').expect(200);
  assert.notEqual(zero.body.code, 0, '非法 limit 明确拒绝而不是静默钳制');
  assert.match(zero.body.message, /limit 需为 1\.\.500 的整数/);
  const abc = await request(app).get('/api/products/attributes?limit=abc').expect(200);
  assert.notEqual(abc.body.code, 0);
  const one = await facets('?limit=1');
  assert.equal(one.attributes.length, 1);
  if (one.total > 1) {
    assert.equal(one.truncated, true);
    assert.ok(one.total > 1, '截断时必须给出总数，前端才知道还有多少没显示');
  }
});
