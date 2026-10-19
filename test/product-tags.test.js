/**
 * 商品标签（类目）与店内检索：`src/tags.js`（唯一判据）+ `products.tags`（JSON 列：`[{key, display}]`）
 * + `GET /api/products?tag=` / `GET /api/products/tags`。
 *
 * 覆盖五组：
 *  ① **纯归一化**：键（`tagKeyOf`：控制字符→空格、零宽→删除、空白折叠、trim、ASCII 折小写）
 *     与展示形（`normalizeTags`：同一套清洗但**不折大小写**）的关系；按**键**去重；
 *     单标签 ≤24 字 / 最多 8 个，超限与非法**报可读中文错**（绝不静默截断）；列解析恒为数组；
 *  ② **两个写入入口**：上架 POST 与编辑 PATCH 都写 `products.tags` 那一列（键与展示形同批写入，
 *     所以"只更新了一处"在形状上不可表达）；
 *  ③ **店内检索**：`?tag=` 把**任意写法**（展示形、手输小写、多打空格）归一成同一个键再精确匹配，
 *     与既有 `?q=` 关键词搜索（标题+描述 ASCII 大小写不敏感包含）及 kind/分页正交；
 *     非法/超长标签按"查不到"处理**并说明**；
 *  ④ **展示形选取规则**：一个键下多种写法时取"出现次数最多者、并列取字典序最小者"，
 *     且会随次数变化（1:1 并列 → 多数出现）；列表里同一个键**只有一项**（不会按大小写分叉）；
 *  ⑤ **在库标签清单**：只统计上架商品、count 降序 / 同 count 按键升序、limit 截断时
 *     `truncated:true` 且 `total` 仍是按键去重后的总数（形状是对象不是裸数组）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner, db } = ctx;

const { normalizeTags, parseTagsColumn, tagKeyOf, TAG_MAX_LEN, TAGS_MAX } = await import('../src/tags.js');

let ownerToken;

// 造数（在 before 里一次完成：node:test 多个顶层 before 会交错，见 products-search.test.js 的注释）
let pA; // physical，tags 提交 ['GPU',' 二手 '] → 展示形 ['GPU','二手']
let pB; // digital， tags 提交 ['gpu','GPU']   → 按键去重后 ['gpu']
let pC; // physical，tags 提交 ['二手']
let pD; // digital， tags 提交 ['gpu']，随后下架

// 展示形规则（④）用的商品：在一个键下造出多种写法，后续用例复用（测试按声明顺序串行）
let p1; // tags ['iPhone 15']
let p2; // tags ['iphone 15']
let p3; // tags ['iphone 15']（使小写写法成为多数）
let p4; // 同一商品内三种写法（验同商品按键去重）

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  assert.ok(ownerToken);
  pA = await createProduct(productPayload({ title: '标签测试 显卡 A', kind: 'physical', tags: ['GPU', ' 二手 '] }));
  pB = await createProduct(productPayload({ title: '标签测试 显示器 B', kind: 'digital', tags: ['gpu', 'GPU'] }));
  pC = await createProduct(productPayload({ title: '标签测试 键盘 C', kind: 'physical', tags: ['二手'] }));
  pD = await createProduct(productPayload({ title: '标签测试 下架 D', kind: 'digital', tags: ['gpu'] }));
  await request(app)
    .patch(`/api/products/${pD.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ active: false })
    .expect(200);
});

async function createProduct(payload) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(payload)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

async function patchProduct(slug, body) {
  return request(app).patch(`/api/products/${slug}`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send(body);
}

async function list(query = '') {
  const res = await request(app).get(`/api/products${query}`).expect(200);
  assertOk(res);
  return res.body.data;
}

/**
   * 库里的标签读数（**只有一处**：`products.tags` JSON 列，形如 `[{key, display}]`）。
   *
   * 旧形状是"列 + 一张 `product_tags` 镜像表"，本助手当时读两份并逐个比对；
   * 新 schema 把镜像表删了——key 与 display **在同一列里同批写入**，
   * 于是"两处漂移"这件事在形状上不可表达（旧形状要靠"记得同批写"来维持）。
   * 这份读数因此只剩一份，但它比原来更硬：任何漏写/写歪都只能出现在这一列上。
   */
  async function tagsOf(slug) {
    const row = await db.get('SELECT tags FROM products WHERE slug = ?', slug);
    return row ? row.tags : null;
  }

/** 本店在用标签清单（公开只读） */
async function tagList(query = '') {
  const res = await request(app).get(`/api/products/tags${query}`).expect(200);
  assertOk(res);
  return res.body.data;
}

// ── ① 纯归一化（src/tags.js：唯一实现）──

test('键与展示形：同一套清洗（控制/零宽/空白折叠/trim），只有键折 ASCII 小写', () => {
  // 展示形保留店主写的原样（大小写不丢），键折 ASCII 小写
  assert.equal(tagKeyOf(' RTX 5090 '), 'rtx 5090');
  /*
    `normalizeTags` 返回的是**落库形状** `[{key, display}]`（products.tags 那一列的内容），
    不再是展示形字符串数组——键与展示形必须在同一列里同批写入，"两处漂移"才是不可表达的
    （旧形状：展示形一列 + product_tags 镜像表，靠"记得同批写"维持）。所以下面全部按对象断言。
  */
  assert.deepEqual(normalizeTags([' RTX 5090 ']), [{ key: 'rtx 5090', display: 'RTX 5090' }]);
  // 空白多少是输入噪声：多打的空格折成一个（键相同），但大小写是书写风格（展示形保留）
  assert.equal(tagKeyOf('RTX  5090'), 'rtx 5090');
  assert.deepEqual(normalizeTags(['RTX  5090']), [{ key: 'rtx 5090', display: 'RTX 5090' }]);
  // 控制字符（含制表/换行）折成空格；零宽字符直接删（前端 utils/productTags 的 normTag 同口径）
  assert.equal(tagKeyOf('RTX\t5090'), 'rtx 5090');
  assert.equal(tagKeyOf('RTX\u200b5090'), 'rtx5090');
  assert.equal(tagKeyOf('\ufeffGPU'), 'gpu');
  // 只折 ASCII：全角/其它语系原样（口径是"ASCII 大小写不敏感、中文原样"，不是 toLowerCase 一把梭）
  assert.equal(tagKeyOf('ＧＰＵ'), 'ＧＰＵ');
  assert.equal(tagKeyOf('Привет'), 'Привет');
});

test('按**键**去重：同商品里 GPU/gpu/Gpu 只留首次出现的写法；空串项丢弃', () => {
  assert.deepEqual(normalizeTags(['GPU', 'gpu', 'Gpu']), [{ key: 'gpu', display: 'GPU' }], '去重保留首次出现的展示形');
  assert.deepEqual(normalizeTags([' GPU ', 'gpu', 'GPU\u0000', '二手', '   ', '\u0001\u0002', '中文标签']), [
    { key: 'gpu', display: 'GPU' },
    { key: '二手', display: '二手' },
    { key: '中文标签', display: '中文标签' },
  ]);
  assert.deepEqual(normalizeTags(['gp\u200bu', '\ufeffgpu', 'g\u200dpu']), [{ key: 'gpu', display: 'gpu' }], '零宽字符清洗后同键');
  // 未提交 = 无标签（不是错误）
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags([]), []);
});

test(`上限与非法：单标签 ≤${TAG_MAX_LEN} 字、最多 ${TAGS_MAX} 个，超限/非法报可读中文错（不静默截断）`, () => {
  // 恰好到上限：合法
  const max = 'a'.repeat(TAG_MAX_LEN);
  assert.deepEqual(normalizeTags([max]), [{ key: max, display: max }]);
  // 超一个字：报错（按**码点**计数，中文一个字就是 1 字）
  const long = '标'.repeat(TAG_MAX_LEN + 1);
  assert.throws(() => normalizeTags([long]), (e) => {
    assert.match(e.message, new RegExp(`超过 ${TAG_MAX_LEN} 字上限`));
    assert.match(e.message, /请拆成更短更具体的标签/);
    return true;
  });
  // 去重之后仍超 8 个才报错（9 个不同键；报错文案里的计数是去重后的 9）
  const nine = Array.from({ length: 9 }, (_, i) => `t${i}`);
  assert.throws(() => normalizeTags(nine), /最多 8 个标签（去重后当前 9 个）/);
  // 8 个合法；9 个里只多一个大小写变体 → 去重后 8 个，合法
  assert.equal(normalizeTags([...nine.slice(0, 8), 'T0']).length, 8, 'T0 与 t0 是同一个键');
  // 非数组 / 元素非字符串：报错而不是猜意图
  assert.throws(() => normalizeTags('gpu'), /需为字符串数组/);
  assert.throws(() => normalizeTags([123]), /每一项都必须是字符串/);
});

test('列解析（收的是驱动读回的值）：空数组 = 无标签，不是 null；形状不对一律 []；列原文必须响亮拒绝', () => {
  assert.deepEqual(
    parseTagsColumn([{ key: 'gpu', display: 'GPU' }, { key: '二手', display: '二手' }]),
    ['GPU', '二手'],
    '下发的是展示形（原样大小写）'
  );
  assert.deepEqual(parseTagsColumn(null), [], 'NULL 行（LEFT JOIN 没命中）⇒ 无标签');
  assert.deepEqual(parseTagsColumn([]), []);
  assert.deepEqual(parseTagsColumn({ a: 1 }), [], '不是数组 ⇒ 无标签');
  /*
    缺键的元素**丢掉**：那种元素只能显示、不能被筛选，正是本设计要消灭的"显示得出但搜不到"；
    非字符串 display 同理（不下发脏值）。上半段的 `{不是 JSON` / `'{"a":1}'` 两条旧断言随
    TEXT 列一起消失——JSON 列由驱动解析，"列原文"这个形状在读取路径上不再存在。
    但**传进来**仍然可能（调用方手里拿着别处的原文），那种情况必须响亮失败而不是静默当空：
    静默当空 = 快照里少一份标签，两端哈希不一致而没人知道是谁漏的。
  */
  assert.deepEqual(parseTagsColumn([{ key: 'gpu', display: 'GPU' }, { key: '', display: 'x' }, null, { display: '无键' }]), ['GPU']);
  assert.throws(() => parseTagsColumn('["GPU","二手"]'), /JSON 列由驱动解析/);
});

// ── ② 两个写入入口（上架 / 编辑）都写同一列 ──

test('上架 POST：DTO 下发**原样大小写**的展示形，键与展示形同列落库', async () => {
  assert.deepEqual(pA.tags, ['GPU', '二手'], '提交 ["GPU"," 二手 "] → 展示形保留原样');
  assert.deepEqual(
    await tagsOf(pA.slug),
    [
      { key: 'gpu', display: 'GPU' },
      { key: '二手', display: '二手' },
    ],
    '同一列里存键与展示形（键 ASCII 小写、中文原样）——没有第二处可漂移'
  );
  // 按键去重：提交 ['gpu','GPU'] 只落一条，展示形是首次出现的 'gpu'
  assert.deepEqual(pB.tags, ['gpu']);
  assert.deepEqual(await tagsOf(pB.slug), [{ key: 'gpu', display: 'gpu' }]);
});

test('无标签商品：tags 恒为空数组（不是 null），库里也不留任何标签项', async () => {
  const p = await createProduct(productPayload({ title: '标签测试 无标签 E' }));
  assert.ok(Array.isArray(p.tags), 'tags 必须是数组');
  assert.deepEqual(p.tags, [], '空数组 = 无标签（不是 null——标签本来就是可选项）');
  assert.deepEqual(await tagsOf(p.slug), []);
  // 详情端点同样恒为数组（DTO 只有一处实现，故两个入口自动一致）
  const detail = await request(app).get(`/api/products/${p.slug}`).expect(200);
  assertOk(detail);
  assert.deepEqual(detail.body.data.tags, []);
});

test('编辑 PATCH：标签变更时整列**同批**替换（旧标签项必须消失）', async () => {
  const p = await createProduct(productPayload({ title: '标签测试 改标签 F', tags: ['旧标签'] }));
  const res = await patchProduct(p.slug, { tags: ['新标签', 'GPU'] });
  assertOk(res);
  assert.deepEqual(res.body.data.tags, ['新标签', 'GPU'], '改标签同样保留展示形');
  /*
    整列同批替换，顺序 = **本次提交的顺序**（`normalizeTags` 的输出就是列的内容，不再按 key 重排）：
    列里只有一份数据，所以"顺序"这件事只有提交这一个出处，读取侧不再替它排序。
  */
  assert.deepEqual(await tagsOf(p.slug), [
    { key: '新标签', display: '新标签' },
    { key: 'gpu', display: 'GPU' },
  ]);
  // 清空：提交 [] = 显式清空（与 media 同款三态：未提交=不动）→ 整列为空
  const cleared = await patchProduct(p.slug, { tags: [] });
  assertOk(cleared);
  assert.deepEqual(cleared.body.data.tags, []);
  assert.deepEqual(await tagsOf(p.slug), []);
});

test('编辑 PATCH：未提交 tags → 列保持原值（不被清空、也不被重算）', async () => {
  const before = await tagsOf(pC.slug);
  const res = await patchProduct(pC.slug, { title: '标签测试 键盘 C（改名）' });
  assertOk(res);
  assert.deepEqual(res.body.data.tags, ['二手']);
  assert.deepEqual(await tagsOf(pC.slug), before, '只改标题不该动标签');
});

test('编辑 PATCH：非法标签整体拒绝，列里不留半写状态', async () => {
  const before = await tagsOf(pC.slug);
  const res = await patchProduct(pC.slug, { tags: ['ok', 'x'.repeat(TAG_MAX_LEN + 1)] });
  assert.notEqual(res.body.code, 0, '超长标签必须整体拒绝');
  assert.match(res.body.message, new RegExp(`超过 ${TAG_MAX_LEN} 字上限`));
  assert.deepEqual(await tagsOf(pC.slug), before, '拒绝之后列必须与拒绝前逐字相同');

  const tooMany = await patchProduct(pC.slug, { tags: Array.from({ length: 9 }, (_, i) => `t${i}`) });
  assert.notEqual(tooMany.body.code, 0);
  assert.match(tooMany.body.message, /最多 8 个标签/);
  assert.deepEqual(await tagsOf(pC.slug), before);
});

// ── ③ 店内检索：?tag= 任意写法归一成键；?q= 复用既有实现 ──

test('?tag= 精确匹配（按键）：只出上架商品，展示形/大小写/多空格都命中同一批', async () => {
  const d = await list('?tag=gpu');
  assert.deepEqual(d.products.map((p) => p.slug), [pA.slug, pB.slug], '下架商品不进筛选结果');
  assert.equal(d.tag, 'gpu', '回显的是本次真正用于匹配的**键**');
  assert.equal(d.tagError, null);

  const upper = await list('?tag=GPU'); // 大写写法 → 归一成同一个键
  assert.deepEqual(upper.products.map((p) => p.slug), [pA.slug, pB.slug]);
  assert.equal(upper.tag, 'gpu');

  const cn = await list(`?tag=${encodeURIComponent('二手')}`);
  assert.deepEqual(cn.products.map((p) => p.slug), [pA.slug, pC.slug], '中文标签原样匹配');
});

test('三态纪律：缺省/空白标签 = 不筛选；查不到的标签 = 空结果但无错；非法标签 = 空结果 + 说明', async () => {
  const all = await list('?pageSize=100');
  assert.ok(all.products.length >= 4);
  assert.equal(all.tag, null, '没传 tag：tag 为 null（= 未按标签过滤）');
  assert.equal(all.tagError, null);

  const blank = await list('?tag=%20%20');
  assert.equal(blank.products.length, all.products.length, '纯空白 = 与没传同义（不筛选）');
  assert.equal(blank.tagError, null);

  const missing = await list('?tag=not-a-real-tag');
  assert.deepEqual(missing.products, [], '查不到就是空结果');
  assert.equal(missing.tag, 'not-a-real-tag');
  assert.equal(missing.tagError, null, '"查不到"不是"标签非法"——两者必须能区分');

  const tooLongRes = await request(app).get(`/api/products?tag=${'x'.repeat(TAG_MAX_LEN + 1)}`).expect(200);
  assertOk(tooLongRes);
  const tooLong = tooLongRes.body.data;
  assert.deepEqual(tooLong.products, [], '非法标签按"查不到"处理（空结果）');
  assert.equal(tooLong.tag, null);
  assert.match(tooLong.tagError, new RegExp(`超过 ${TAG_MAX_LEN} 字上限`), '并且必须说明原因');
  assert.match(tooLongRes.body.message, /标签未生效/, 'message 里也说明，避免调用方只看 data');
  // 形状与正常路径一致（不是 500、也不是少字段）
  assert.equal(tooLong.nextCursor, null);
  assert.ok('rates' in tooLong && 'products' in tooLong);

  const control = await list('?tag=%01%02');
  assert.deepEqual(control.products, []);
  assert.match(control.tagError, /去掉控制字符与空白后为空/);

  // 重复给多个 tag（Express 给的是数组）：必须明说"一次只能一个"，
  // 否则会被当成一个名叫 "gpu,二手" 的标签而静默查不到
  const multi = await list('?tag=gpu&tag=%E4%BA%8C%E6%89%8B');
  assert.deepEqual(multi.products, []);
  assert.match(multi.tagError, /一次只能给一个/);
});

test('?tag= 与既有 ?q= 关键词搜索、kind 分面、光标分页**正交**（AND 组合，每页都是过滤结果）', async () => {
  // q 复用既有实现（标题/描述 ASCII 大小写不敏感包含匹配）：两者同时给出时取交集
  const combo = await list('?tag=GPU&q=%E6%98%BE%E7%A4%BA%E5%99%A8'); // q=显示器
  assert.deepEqual(combo.products.map((p) => p.slug), [pB.slug]);

  const byKind = await list('?tag=gpu&kind=physical');
  assert.deepEqual(byKind.products.map((p) => p.slug), [pA.slug], 'kind 分面与标签取交集');

  const page1 = await list('?tag=gpu&pageSize=1');
  assert.equal(page1.products.length, 1);
  assert.notEqual(page1.nextCursor, null, '还有第 2 条 → 非空');
  const page2 = await list(`?tag=gpu&pageSize=1&cursor=${page1.nextCursor}`);
  assert.equal(page2.products.length, 1);
  assert.equal(page2.nextCursor, null);
  assert.deepEqual(
    [page1.products[0].slug, page2.products[0].slug].sort(),
    [pA.slug, pB.slug].sort(),
    '两页合起来恰好是全部命中，不掺别的标签'
  );
  assert.equal(page2.tag, 'gpu', '翻页时标签条件不丢');

  // order=desc（最新上架优先）与标签同样正交
  const desc = await list('?tag=gpu&order=desc');
  assert.deepEqual(desc.products.map((p) => p.slug), [pB.slug, pA.slug]);
});

test('店主全量列表（/all）同样带 tags（DTO 只有一处实现）', async () => {
  const res = await request(app)
    .get('/api/products/all?pageSize=100')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(res);
  const off = res.body.data.products.find((p) => p.slug === pD.slug);
  assert.ok(off, '下架商品在店主列表里');
  assert.deepEqual(off.tags, ['gpu']);
});

// ── ④ 展示形选取规则（一个键，多种写法）──

test('展示形原样下发 + 多种写法命中同一批（大小写与多余空格都不影响命中）', async () => {
  p1 = await createProduct(productPayload({ title: '展示形测试 手机 X1', tags: ['iPhone 15'] }));
  p2 = await createProduct(productPayload({ title: '展示形测试 手机 X2', tags: ['iphone 15'] }));

  // DTO 是**原样**：谁写的就显示谁写的（不做小写折叠）
  assert.deepEqual(p1.tags, ['iPhone 15']);
  assert.deepEqual(p2.tags, ['iphone 15']);

  for (const q of ['iPhone 15', 'iphone 15', 'IPHONE 15', 'iPhone  15', 'iphone   15']) {
    const d = await list(`?tag=${encodeURIComponent(q)}`);
    assert.deepEqual(
      d.products.map((x) => x.slug).sort(),
      [p1.slug, p2.slug].sort(),
      `?tag=${q} 应命中同一批（先归一成键再匹配）`
    );
    assert.equal(d.tag, 'iphone 15', '回显的键与写法无关');
  }
});

test('`?tag=` 三种写法命中同一批（展示形 / 手输小写 / 多打空格），商品 DTO 保持原样大小写', async () => {
  // 店主写的是 'RTX 5090'：DTO 必须原样下发（不能被折成 'rtx 5090'）
  const card = await createProduct(productPayload({ title: '展示形测试 显卡 Y1', tags: ['RTX 5090'] }));
  assert.deepEqual(card.tags, ['RTX 5090']);
  // 三种入参都归一成同一个键 'rtx 5090'，命中同一批
  for (const q of ['rtx 5090', 'RTX 5090', 'RTX  5090']) {
    const d = await list(`?tag=${encodeURIComponent(q)}`);
    assert.deepEqual(d.products.map((p) => p.slug), [card.slug], `?tag=${q} 应命中`);
    assert.equal(d.tag, 'rtx 5090', '回显的键与入参写法无关');
    assert.equal(d.tagError, null);
  }
  // 清理：下架，避免影响后面的清单计数用例
  assertOk(await patchProduct(card.slug, { active: false }));
});

test('同一个键只产生一项；展示形取"次数最多者，并列取字典序最小者"，并随次数变化', async () => {
  // 上一条用例造了两条商品：'iPhone 15' 与 'iphone 15' → 1:1 并列
  const tie = await tagList();
  const row1 = tie.tags.filter((t) => t.key === 'iphone 15');
  assert.equal(row1.length, 1, '同一个键只有一个条目（不会按大小写分叉成两项）');
  assert.equal(row1[0].count, 2, 'count = 用到该键的上架商品数');
  assert.equal(row1[0].tag, 'iPhone 15', '并列时取字典序最小的写法（UTF-8 字节序：大写字母排在小写之前）');

  // 再加一条 'iphone 15' → 多数写法变成小写那条，展示形随之改变（"最多数"优先于字典序）
  p3 = await createProduct(productPayload({ title: '展示形测试 手机 X3', tags: ['iphone 15'] }));
  const majority = await tagList();
  const row2 = majority.tags.find((t) => t.key === 'iphone 15');
  assert.equal(row2.tag, 'iphone 15', '出现 2 次的小写写法压过 1 次的大写写法');
  assert.equal(row2.count, 3);

  // 同键的不同展示形允许并存（每个商品各写自己那份）；**同一商品内**按键去重只落一项。
  // 这里用多值索引的谓词（`? MEMBER OF (tags->'$[*].key')`）数——它正是库里用来筛标签的那条路，
  // 而不是另写一条 LIKE 去找（那会变成第二套判据）。
  const rows = await db.all("SELECT slug FROM products WHERE ? MEMBER OF (tags->'$[*].key')", 'iphone 15');
  assert.equal(rows.length, 3, '三个商品各一项（同一商品内按键去重）');
  p4 = await createProduct(productPayload({ title: '展示形测试 手机 X4', tags: ['iPhone 15', 'iphone 15', 'IPHONE 15'] }));
  assert.deepEqual(p4.tags, ['iPhone 15'], '同一商品内按键去重，只留首次出现的写法');
  assert.deepEqual(await tagsOf(p4.slug), [{ key: 'iphone 15', display: 'iPhone 15' }]);
  // 清理：把这四条下架，避免影响后面的清单计数用例
  for (const s of [p1.slug, p2.slug, p3.slug, p4.slug]) {
    const res = await patchProduct(s, { active: false });
    assertOk(res);
  }
});

// ── ⑤ 在库标签清单 GET /api/products/tags ──

test('标签清单：只统计上架商品；count 降序、同 count 按键升序；每项带 key 与展示形', async () => {
  const d = await tagList();
  // 上架商品的在用标签：键 gpu（pA 写 'GPU'、pB 写 'gpu'）、键 二手（pA、pC）
  // pD 已下架，它的 gpu 不计入；gpu 键两种写法 1:1 并列 → 展示形取字典序最小的 'GPU'
  assert.deepEqual(
    d.tags,
    [
      { tag: 'GPU', key: 'gpu', count: 2 },
      { tag: '二手', key: '二手', count: 2 },
    ],
    '同 count 按键升序（UTF-8 字节序：g < 二）'
  );
  assert.equal(d.total, 2, 'total = 按键去重后的在用标签总数');
  assert.equal(d.truncated, false);
});

test('标签清单：count 随上下架真实变化（下架商品不再贡献计数，展示形随之转移）', async () => {
  const res = await request(app)
    .patch(`/api/products/${pB.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ active: false })
    .expect(200);
  assertOk(res);
  const d = await tagList();
  assert.deepEqual(
    d.tags,
    [
      { tag: '二手', key: '二手', count: 2 },
      // pB（写 'gpu' 的那条）下架后，gpu 键只剩 pA 的 'GPU' ⇒ 计数与展示形同时变
      { tag: 'GPU', key: 'gpu', count: 1 },
    ],
    'count 降序：二手 2 在前；gpu 掉到 1'
  );
  // 复原，避免影响后续用例
  await patchProduct(pB.slug, { active: true });
});

test('标签清单：limit 截断时 truncated=true、total 仍是全量（不静默少报）；非法 limit 明确拒绝', async () => {
  const one = await tagList('?limit=1');
  assert.deepEqual(one.tags, [{ tag: 'GPU', key: 'gpu', count: 2 }]);
  assert.equal(one.total, 2, 'total 是全量去重数，不是返回条数');
  assert.equal(one.truncated, true);

  const bad = await request(app).get('/api/products/tags?limit=0').expect(200);
  assert.notEqual(bad.body.code, 0, '非法 limit 明确拒绝而不是静默钳制');
  assert.match(bad.body.message, /limit 需为 1\.\.200 的整数/);

  const tooBig = await request(app).get('/api/products/tags?limit=999').expect(200);
  assert.notEqual(tooBig.body.code, 0);
});
