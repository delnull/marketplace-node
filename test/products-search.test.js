/**
 * 商品列表查询（GET /api/products）：关键词搜索 + 排序 + 类型分面 + 光标分页。
 *  - 标题/描述 LIKE 匹配（SQLite 大小写不敏感），仅上架商品可搜到；
 *  - %/_ 通配符按字面匹配（ESCAPE 转义），防「q=% 命中全部」式通配放大；
 *  - 与光标分页组合：每页均为过滤结果；
 *  - order=asc|desc：keyset 游标方向随之翻转（desc = 最新上架优先）；
 *  - kind=：服务端真过滤（非法值静默忽略），与搜索/分页正交；
 *  - nextCursor（2026-09 修正）：**仅在确有下一页时非空**——多取一行做前瞻判定，
 *    调用方据此即可准确判底，无需再发一次空请求试探。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner } = ctx;

let ownerToken;

// 标题含关键词
let pGpu;
// 仅描述含关键词（英文大小写混合）
let pMonitor;
// 标题含 % 字面量（转义用例）
let pPercent;
// 下架商品（不得被搜到）
let pOff;

// 单一 before：登录 + 造数合并（node:test 多个顶层 before 存在并发交错，拆分会导致
// 造单时 ownerToken 未就绪而 401——与 arbitration.test.js 同款修正）
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  assert.ok(ownerToken);
  pGpu = await listProduct(productPayload({ title: 'ASUS 显卡 RTX 5090', kind: 'physical', description: '旗舰游戏显卡。' }));
  pMonitor = await listProduct(productPayload({ title: '电竞显示器', description: '4K 144Hz DisplayPort 显示器。' }));
  pPercent = await listProduct(productPayload({ title: '100% 纯棉 T 恤', description: '宽松款。' }));
  // POST 上架恒 active=1（路由硬编码），下架走 PATCH（更贴近真实路径）
  pOff = await listProduct(productPayload({ title: '下架显卡测试' }));
  await request(app)
    .patch(`/api/products/${pOff.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ active: false })
    .expect(200);
});

async function listProduct(payload) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(payload)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

async function search(q, cursor = 0, pageSize = 30, extra = {}) {
  const sp = new URLSearchParams({ q, cursor: String(cursor), pageSize: String(pageSize) });
  for (const [k, v] of Object.entries(extra)) sp.set(k, String(v));
  const res = await request(app).get(`/api/products?${sp.toString()}`).expect(200);
  assertOk(res);
  return res.body.data;
}

test('标题关键词命中；大小写不敏感', async () => {
  const r1 = await search('显卡');
  assert.deepEqual(r1.products.map((p) => p.slug), [pGpu.slug], '标题命中显卡');

  const r2 = await search('ASUS');
  assert.deepEqual(r2.products.map((p) => p.slug), [pGpu.slug], '英文大小写不敏感命中');

  const r3 = await search('asus');
  assert.deepEqual(r3.products.map((p) => p.slug), [pGpu.slug], '小写同样命中');
});

test('描述关键词命中；空串/空白关键词退化为全列表', async () => {
  const r1 = await search('DisplayPort');
  assert.deepEqual(r1.products.map((p) => p.slug), [pMonitor.slug], '描述命中');

  const r2 = await search('');
  assert.equal(r2.products.length, 3, '空关键词 = 无过滤（仅 3 个上架）');
  const r3 = await search('   ');
  assert.equal(r3.products.length, 3, '空白关键词同样无过滤');
});

test('下架商品不可被搜到', async () => {
  const r = await search('下架显卡');
  assert.deepEqual(r.products, [], 'active=0 商品不进搜索');
});

test('%/_ 通配符按字面匹配（转义防通配放大）', async () => {
  const r1 = await search('%');
  assert.deepEqual(r1.products.map((p) => p.slug), [pPercent.slug], 'q=% 只命中标题含 % 字面的商品，不得命中全部');
  const r2 = await search('_');
  assert.equal(r2.products.length, 0, 'q=_ 无字面下划线商品则空（不得当单字符通配）');
});

test('搜索与光标分页组合：每页均为过滤结果', async () => {
  // 追加一个命中关键词的商品，凑 2 条便于分页
  const p2 = await listProduct(productPayload({ title: 'AMD 显卡 RX 9070', kind: 'physical' }));
  const page1 = await search('显卡', 0, 1);
  assert.equal(page1.products.length, 1);
  assert.ok(['ASUS 显卡 RTX 5090', 'AMD 显卡 RX 9070'].includes(page1.products[0].title));
  // 光标分页约定（2026-09 修正）：nextCursor 表示**确有下一页**，
  // 而非旧实现的「末条 id」——旧语义下满页到底仍返回非 null，调用方必须再发一次
  // 空请求才能确认到底，等于每个节点每次翻页多一次往返。
  assert.notEqual(page1.nextCursor, null, '还有第 2 条 → 非空');
  const page2 = await search('显卡', page1.nextCursor, 1);
  assert.equal(page2.products.length, 1);
  assert.equal(page2.nextCursor, null, '已取完最后一条 → 直接判定到底，无需空请求试探');
  const slugs = [page1.products[0].slug, page2.products[0].slug].sort();
  assert.deepEqual(slugs, [pGpu.slug, p2.slug].sort(), '两页合起来 = 全部命中，不掺无关商品');
});

test('整页取满且恰好到底：nextCursor 为 null', async () => {
  // 关键词「显卡」此时命中 2 条；pageSize=2 恰好取满一页且无更多 → 必须为 null
  const r = await search('显卡', 0, 2);
  assert.equal(r.products.length, 2, '整页取满');
  assert.equal(r.nextCursor, null, '满页但仍到底 → null（前瞻一行判定，不能靠"未取满"推断）');
});

test('order=desc：最新上架优先（聚合首屏依赖）', async () => {
  const asc = await search('', 0, 30, { order: 'asc' });
  const desc = await search('', 0, 30, { order: 'desc' });
  assert.equal(desc.products.length, asc.products.length, '两种方向数量一致');
  assert.deepEqual(
    desc.products.map((p) => p.slug),
    [...asc.products].reverse().map((p) => p.slug),
    'desc 与 asc 恰为逆序（id 严格递增，无并列）'
  );
  // 翻页方向同样成立：desc 用 id < cursor
  const d1 = await search('', 0, 1, { order: 'desc' });
  const d2 = await search('', d1.nextCursor, 1, { order: 'desc' });
  assert.notEqual(d2.products[0].slug, d1.products[0].slug, '第二页不得重复第一页');
  assert.ok(
    asc.products.findIndex((p) => p.slug === d2.products[0].slug) <
      asc.products.findIndex((p) => p.slug === d1.products[0].slug),
    'desc 第二页的 id 严格小于第一页'
  );
});

test('kind 过滤：服务端真过滤，且与光标分页正交', async () => {
  const physical = await search('', 0, 30, { kind: 'physical' });
  assert.ok(physical.products.length > 0, '存在实物商品');
  assert.ok(
    physical.products.every((p) => p.kind === 'physical'),
    '结果全部为 physical'
  );

  // 多值：逗号分隔取并集
  const multi = await search('', 0, 30, { kind: 'physical,digital' });
  assert.ok(
    multi.products.every((p) => p.kind === 'physical' || p.kind === 'digital'),
    '多值过滤生效'
  );
  assert.ok(multi.products.length >= physical.products.length, '并集不小于子集');

  // 非法值静默忽略（不得 500，也不得把 kind 当空串条件返回空集）
  const bogus = await search('', 0, 30, { kind: 'not-a-kind' });
  const all = await search('', 0, 30);
  assert.equal(bogus.products.length, all.products.length, '非法 kind 静默忽略 = 不过滤');

  // 与搜索组合
  const combo = await search('显卡', 0, 30, { kind: 'physical' });
  assert.ok(combo.products.every((p) => p.kind === 'physical'));
  assert.ok(combo.products.every((p) => p.title.includes('显卡') || p.description.includes('显卡')));
});
