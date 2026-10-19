/**
 * 商品写入口的三件事（批次一，2026-10-15）：
 *
 *  1. **草稿**：`POST /api/products` 采纳请求体里的 `active`（缺省 1）。
 *     `active=false` 的商品：店主（staff）看得到、买家看不到（公开列表不含、匿名详情 404），
 *     点「上架」（PATCH active=true）后立即出现在公开列表。草稿与"已下架"是**同一个列的两个取值**，
 *     不引入新状态——所以这里也顺带钉住"下架商品匿名 404、staff 可见"这条既有口径。
 *
 *  2. **未知字段拒绝**（`PRODUCT_WRITE_KEYS` / `PRODUCT_BATCH_PATCH_KEYS`）：
 *     三个写入口（上架 / 编辑 / 批量）都必须**带字段名**拒绝不认识的键。
 *     判据的历史：`capacity` 与 `priceUsdtMicro` 曾是"提交了但被静默忽略"的两个真实字段
 *     （商品级价与库存都是各组合的只读汇总），本仓对这种失败的口径是"绝不静默"。
 *     这里同时验**反例不会扩大**：认识的键照常通过（否则这道门会变成"什么都存不进去"）。
 *
 *  3. **卖家列表搜索 `q` 与在途承诺读数**（`GET /api/products/all`）：
 *     搜索在**服务端**（面板分页拉，前端过滤只能搜到已加载的几页）；`%`/`_` 按字面量处理。
 *     `pendingPromises` = 各组合上"库存承诺还没结清"的读数（判据是 `stockHold.stockPromiseSql`
 *     的唯一实现），用途是商品编辑表单在改规格选项名之前先提醒店主——所以这里钉住
 *     "下单占位后出现、取消后消失"，而不是钉住某个数字形状。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner, buyer } = ctx;

let ownerToken;
let buyerToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  assert.ok(ownerToken && buyerToken);
});

const create = async (body) => {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(body)
    .expect(200);
  assertOk(res);
  return res.body.data;
};

const publicSlugs = async () => {
  const res = await request(app).get('/api/products?pageSize=100').expect(200);
  assertOk(res);
  return res.body.data.products.map((p) => p.slug);
};

const allProducts = async (q = '') => {
  const res = await request(app)
    .get(`/api/products/all${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(res);
  return res.body.data.products;
};

/** PATCH 成功则返回规范化后的商品（失败直接抛出服务端可读原因） */
const patch = async (slug, body) => {
  const res = await request(app)
    .patch(`/api/products/${slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(body)
    .expect(200);
  if (res.body.code !== 0) throw new Error(res.body.message);
  return res.body.data;
};

test('草稿：POST 采纳 active=false；买家看不到、店主看得到；上架后立即公开', async () => {
  const draft = await create(productPayload({ kind: 'physical', title: '草稿商品·未发布', active: false }));
  assert.equal(draft.active, false, 'POST 必须采纳请求体里的 active（此前硬编码为 1，永远建不出草稿）');

  assert.ok(!(await publicSlugs()).includes(draft.slug), '草稿不得出现在公开列表');
  await request(app).get(`/api/products/${draft.slug}`).expect(404); // 匿名：下架/草稿一律 404
  const staffView = await request(app)
    .get(`/api/products/${draft.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(staffView);
  assert.equal(staffView.body.data.active, false, '店主看得到自己的草稿');

  const all = await allProducts();
  assert.ok(all.some((p) => p.slug === draft.slug), '店主列表（/all）必须含草稿，否则草稿等于丢了');

  const up = await request(app)
    .patch(`/api/products/${draft.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ active: true })
    .expect(200);
  assertOk(up);
  assert.ok((await publicSlugs()).includes(draft.slug), '上架后立即出现在公开列表');
});

test('编辑不带 active 时不改变发布状态（下架中的商品不会被顺手改回在售）', async () => {
  const p = await create(productPayload({ title: '下架中商品', active: false }));
  const edited = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ title: '下架中商品（改过标题）' })
    .expect(200);
  assertOk(edited);
  assert.equal(edited.body.data.active, false, '未提交 active = 不改发布状态');
});

/**
 * 「首次上架时刻」（`published_at`）是**事实**不是状态：可见性只看 `active`，
 * 这一列只回答"这件商品有没有发布过"。判据是"写一次、此后永不清空"——
 * 它一旦被下架改写，列表就会把卖过的商品说成"从未发布"（那是关于这家店的假话）。
 *
 * 形状：库列是 `DATETIME(3)` → DTO 出参是 **ISO-8601 字符串**（`Date.prototype.toJSON`），
 * 所以"有没有值"与"是不是同一时刻"都要先 `Date.parse`——`Number.isInteger` 在字符串上恒 false，
 * 那会让"第一次上架写入时刻"这条断言永远红（而不是永远绿，这是它还算诚实的地方）。
 */
test('首次上架时刻：草稿中没有；第一次上架写入；下架保留；再上架不改写', async () => {
  const draft = await create(productPayload({ title: '发布时刻·草稿', active: false }));
  assert.equal(draft.publishedAt, null, '草稿 = 从未发布（NULL，不是 0）');

  const live = await patch(draft.slug, { active: true });
  assert.ok(Number.isFinite(Date.parse(live.publishedAt)), '第一次上架写入时刻');
  const firstAt = live.publishedAt;

  const down = await patch(draft.slug, { active: false });
  assert.equal(down.publishedAt, firstAt, '下架**不清空**：卖过这件事不因撤下而消失');

  // 再上架：保留首次时刻（不是"最后一次上架"）
  await new Promise((r) => setTimeout(r, 5));
  const again = await patch(draft.slug, { active: true });
  assert.equal(again.publishedAt, firstAt, '再上架不改写（它回答的是"有没有发布过"）');

  // 直接建成在售的商品：创建即发布，时刻非空
  const direct = await create(productPayload({ title: '发布时刻·直接上架' }));
  assert.ok(Number.isFinite(Date.parse(direct.publishedAt)), '建单即上架 ⇒ 首次上架时刻就是创建时刻');

  // 批量上架同样走同一条规则（三处写入口套的是同一个表达式）
  const draft2 = await create(productPayload({ title: '发布时刻·批量上架', active: false }));
  assert.equal(draft2.publishedAt, null);
  const batch = await request(app)
    .patch('/api/products/batch')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ slugs: [draft2.slug], patch: { active: true } })
    .expect(200);
  assertOk(batch);
  const after = await allProducts('发布时刻·批量上架');
  assert.ok(Number.isFinite(Date.parse(after[0].publishedAt)), '批量上架也要写首次上架时刻（漏一处就是列表里的假话）');
});

test('未知字段被拒绝：上架 / 编辑 / 批量三个入口，错误里带字段名与接受集', async () => {
  // ① 上架：多一个服务端不处理的键（`capacity` 就是曾经的实例）
  const badCreate = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ ...productPayload({ title: '带未知字段的商品' }), capacity: 5 })
    .expect(200);
  assert.equal(badCreate.body.code, 1, '不认识的字段必须拒绝，而不是 200 + 静默忽略');
  assert.match(String(badCreate.body.message), /capacity/, '错误必须点名是哪个字段');
  assert.match(String(badCreate.body.message), /skus/, '并给出本接口接受的字段，店主才知道该写在哪');

  // 认识的键照常通过（这道门不能变成"什么都存不进去"）
  const okCreate = await create(productPayload({ title: '认识的字段照常通过' }));
  assert.equal(okCreate.title, '认识的字段照常通过');

  // ② 编辑：商品级 priceUsdtMicro 是只读汇总（各组合最低价），不是可写字段
  const badPatch = await request(app)
    .patch(`/api/products/${okCreate.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ priceUsdtMicro: 1_000_000 })
    .expect(200);
  assert.equal(badPatch.body.code, 1);
  assert.match(String(badPatch.body.message), /priceUsdtMicro/);

  // ③ 批量：patch 的键集更小（批量不展开规格）
  const badBatch = await request(app)
    .patch('/api/products/batch')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ slugs: [okCreate.slug], patch: { tags: ['春茶'] } })
    .expect(200);
  assert.equal(badBatch.body.code, 1);
  assert.match(String(badBatch.body.message), /tags/);
});

test('卖家列表搜索 q：标题/标识/描述/参数/承诺都命中；% 按字面量；仅 staff', async () => {
  const a = await create(productPayload({ title: '专测甲：USB 数据线' }));
  const b = await create(productPayload({ title: '专测乙：话费卡 100% 通用券' }));
  /*
    店主侧的搜索面比买家侧宽（他在自己店里找"那一件"，线索可能是描述里的一句话或参数里的值）。
    这两种线索都存在 JSON 列里，所以这里连"值出现在列文本里"一起钉住。
  */
  const c = await create(
    productPayload({
      kind: 'physical',
      title: '专测丙：普通外壳',
      description: '原厂彩盒 + 防震填充，适合长途运输',
      attributes: [{ name: '成色', value: '全新未拆封' }],
      terms: { handling_days: 3 },
      capacity: 5,
    })
  );

  assert.deepEqual((await allProducts('专测甲')).map((p) => p.slug), [a.slug]);
  assert.deepEqual((await allProducts('专测乙')).map((p) => p.slug), [b.slug]);
  // 标识（对外 slug）也参与搜索：店主手里常常只有一条分享链接
  assert.deepEqual((await allProducts(a.slug)).map((p) => p.slug), [a.slug]);
  // 描述里的一句话
  assert.deepEqual((await allProducts('防震填充')).map((p) => p.slug), [c.slug]);
  // 参数里的值（"上次那件成色全新未拆封的"）
  assert.deepEqual((await allProducts('全新未拆封')).map((p) => p.slug), [c.slug]);
  // `%` 是 LIKE 通配符：不转义的话它会命中全部商品（"没搜到"与"搜到一堆"是两种错法）
  assert.deepEqual((await allProducts('%')).map((p) => p.slug), [b.slug]);
  assert.deepEqual((await allProducts('不存在的词xyz')), []);

  // 鉴权两档各自说清：匿名 401（没令牌）、买家 403（有令牌但不是 staff）
  await request(app).get('/api/products/all?q=x').expect(401);
  await request(app).get('/api/products/all?q=x').set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(403);
});

test('在途承诺读数：下单占位后出现，取消后消失（改规格前提示的判据）', async () => {
  const p = await create(productPayload({ kind: 'physical', title: '限量一件·在途承诺', capacity: 1 }));
  const before = (await allProducts('限量一件')).find((x) => x.slug === p.slug);
  assert.deepEqual(before.pendingPromises, [], '还没有订单：无在途承诺');

  const draft = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: p.slug })
    .expect(200);
  assertOk(draft);

  const held = (await allProducts('限量一件')).find((x) => x.slug === p.slug);
  assert.deepEqual(
    held.pendingPromises,
    [{ key: '', orders: 1, units: 1 }],
    '下单即占位：无规格商品的组合键是空串，读数按组合给出'
  );

  const cancelled = await request(app)
    .post(`/api/orders/${draft.body.data.id}/cancel`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(cancelled);
  const released = (await allProducts('限量一件')).find((x) => x.slug === p.slug);
  assert.deepEqual(released.pendingPromises, [], '取消释放占位后承诺结清，读数回到空');
});
