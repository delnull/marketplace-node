/**
 * 多 SKU（规格组合）单测：组合键、校验、按 SKU 定价与占位、编辑保留销量、快照覆盖。
 *
 * 模型要点：**每个商品恒有 ≥1 个组合**；无规格商品 = 唯一组合 sku_key=''。
 * 这里既测多规格，也测无规格走同一条路径（回归：别把无规格做成另一个分支）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { assertOk, login, makeCtx, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;
const ownerToken = (await login(ctx, owner)).token;

const post = (body) =>
  request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send(body);

/** 颜色 × 尺寸 = 4 个组合 */
const SPECS = [
  { name: '颜色', options: ['黑', '白'] },
  { name: '尺寸', options: ['65', '80'] },
];
const SKUS = [
  { key: '黑|65', priceUsdtMicro: 100_000_000, capacity: 2 },
  { key: '黑|80', priceUsdtMicro: 110_000_000, capacity: 3 },
  { key: '白|65', priceUsdtMicro: 120_000_000, capacity: null },
  { key: '白|80', priceUsdtMicro: 130_000_000, capacity: 1 },
];

const skuRow = async (slug, key) =>
  await db.get('SELECT s.* FROM product_skus s JOIN products p ON p.id = s.product_id WHERE p.slug = ? AND s.sku_key = ?', slug, key);

/** 新买家下单（每次独立钱包，避免草稿上限互相干扰） */
async function draftAs(who, slug, skuKey) {
  const token = (await login(ctx, who)).token;
  const body = { productSlug: slug };
  if (skuKey !== undefined) body.skuKey = skuKey;
  return request(app).post('/api/orders').set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value).send(body);
}
const newBuyer = () => Wallet.createRandom();

/** 期望 wei：与节点同源（rates.usdtMicroToPayWei），避免在测试里手抄一遍汇率算式 */
async function expectWei(usdtMicro) {
  const { getRates, usdtMicroToPayWei } = await import('../src/rates.js');
  return usdtMicroToPayWei(usdtMicro, await getRates());
}

// ── 组合键与校验 ──

test('规格组合：笛卡尔积落库，key 按 specs 声明顺序拼接', async () => {
  const res = await post(productPayload({ title: '多规格商品', kind: 'physical', specs: SPECS, skus: SKUS }));
  assertOk(res);
  const p = res.body.data;
  assert.deepEqual([...p.skus.map((s) => s.key)].sort(), ['白|65', '白|80', '黑|65', '黑|80'].sort(), '2×2 = 4 个组合，按 key 升序');
  assert.deepEqual(p.specs, SPECS);
  assert.equal((await skuRow(p.slug, '黑|65')).price_usdt_micro, 100_000_000, '逐组合定价落库（微 USDT）');
  assert.deepEqual((await skuRow(p.slug, '黑|65')).specs_json, { 颜色: '黑', 尺寸: '65' });
});

test('SKU 必须恰好覆盖全部组合：少一个 / 多一个 / 键不属于规格 都拒绝', async () => {
  const missing = await post(productPayload({ specs: SPECS, skus: SKUS.slice(0, 3) }));
  assert.notEqual(missing.body.code, 0);
  assert.match(missing.body.message, /覆盖全部规格组合/);

  const extra = await post(
    productPayload({ specs: SPECS, skus: [...SKUS, { key: '红|65', priceUsdtMicro: 90_000_000, capacity: 1 }] })
  );
  assert.notEqual(extra.body.code, 0);

  const wrongKey = await post(
    productPayload({ specs: SPECS, skus: [{ ...SKUS[0], key: '紫|99' }, ...SKUS.slice(1)] })
  );
  assert.notEqual(wrongKey.body.code, 0);
  assert.match(wrongKey.body.message, /不属于当前规格/);
});

test('规格定义边界：单维少于 2 个选项 / 超过 3 维 → 拒绝', async () => {
  const one = await post(
    productPayload({ specs: [{ name: '颜色', options: ['黑'] }], skus: [{ key: '黑', priceUsdtMicro: 1_000_000 }] })
  );
  assert.notEqual(one.body.code, 0);
  assert.match(one.body.message, /至少需要 2 个选项/);

  const four = await post(
    productPayload({
      specs: ['a', 'b', 'c', 'd'].map((n) => ({ name: n, options: ['1', '2'] })),
      skus: [],
    })
  );
  assert.notEqual(four.body.code, 0);
  assert.match(four.body.message, /最多 3 个维度/);
});

test("无规格商品 = 唯一组合 sku_key=''（与多规格同一条路径）", async () => {
  const res = await post(productPayload({ title: '无规格商品' }));
  assertOk(res);
  const p = res.body.data;
  assert.deepEqual(p.specs, []);
  assert.equal(p.skus.length, 1);
  assert.equal(p.skus[0].key, '', '无规格商品的组合键为空串');
  assert.deepEqual(p.skus[0].specs, {});
});

// ── 定价 ──

test('价格汇总：商品级 priceUsdtMicro 取各组合最低价（列表页「起价」）', async () => {
  const res = await post(productPayload({ title: '起价商品', specs: SPECS, skus: SKUS }));
  assertOk(res);
  assert.equal(res.body.data.priceUsdtMicro, 100_000_000, 'min(100,110,120,130 USDT)');
  assert.equal(res.body.data.priceUsdt, '100', '展示串去净尾零：100 USDT 写作 100（不是 100.00）');
});

test('按所选 SKU 定价：不同组合不同价，与商品级「起价」无关', async () => {
  const p = (await post(productPayload({ title: '按 SKU 定价', specs: SPECS, skus: SKUS }))).body.data;

  const a = (await draftAs(newBuyer(), p.slug, '黑|65')).body.data;
  assert.equal(a.usdtMicro, 100_000_000, '黑|65 单价 100 USDT');
  // 期望 wei 取自节点自己的折算函数（兜底汇率 1 BTY = 0.1 USDT，向上取整）
  assert.equal(a.amountWei, await expectWei(a.usdtMicro), '按 SKU 单价折算 wei');
  const frozen = await db.get('SELECT sku_key, sku_specs FROM v_orders WHERE order_no = ?', a.id);
  assert.equal(frozen.sku_key, '黑|65', '订单记录所选组合');
  assert.deepEqual(frozen.sku_specs, { 颜色: '黑', 尺寸: '65' }, '订单冻结所选规格');

  const b = (await draftAs(newBuyer(), p.slug, '白|80')).body.data;
  assert.equal(b.usdtMicro, 130_000_000, '白|80 单价 130 USDT');
  assert.notEqual(a.amountWei, b.amountWei, '不同组合应付金额不同');
});

test('多规格商品必须指定 skuKey；单组合商品可省略', async () => {
  const multi = (await post(productPayload({ title: '需选规格', specs: SPECS, skus: SKUS }))).body.data;
  const single = (await post(productPayload({ title: '单组合' }))).body.data;

  const noKey = await draftAs(newBuyer(), multi.slug);
  assert.equal(noKey.status, 400);
  assert.match(noKey.body.message, /需指定 skuKey/);

  const badKey = await draftAs(newBuyer(), multi.slug, '不存在');
  assert.equal(badKey.status, 400);
  assert.match(badKey.body.message, /所选规格不存在/);

  const auto = await draftAs(newBuyer(), single.slug);
  assertOk(auto);
  assert.equal(
    (await db.get('SELECT sku_key FROM v_orders WHERE order_no = ?', auto.body.data.id)).sku_key,
    '',
    '单组合自动选中，落库为空串'
  );
});

// ── 占位与释放 ──

test('占位按 SKU：A 组合售罄不影响 B 组合；不限量组合不占位', async () => {
  const p = (await post(productPayload({ title: '按 SKU 占位', specs: SPECS, skus: SKUS }))).body.data;

  // 黑|65 容量 2：两单占满
  assertOk(await draftAs(newBuyer(), p.slug, '黑|65'));
  assertOk(await draftAs(newBuyer(), p.slug, '黑|65'));
  assert.equal((await skuRow(p.slug, '黑|65')).committed, 2);

  // 第三单同组合 → 售罄
  const soldOut = await draftAs(newBuyer(), p.slug, '黑|65');
  assert.notEqual(soldOut.body.code, 0);
  assert.match(soldOut.body.message, /所选规格已售罄/);

  // 白|80 容量 1 → 仍可下单（A 售罄不影响 B）
  assertOk(await draftAs(newBuyer(), p.slug, '白|80'));
  assert.equal((await skuRow(p.slug, '白|80')).committed, 1);

  // 白|65 不限量 → 不占位
  assertOk(await draftAs(newBuyer(), p.slug, '白|65'));
  assert.equal((await skuRow(p.slug, '白|65')).committed, 0, '不限量组合不占位');
});

test('取消只回补该组合的占位', async () => {
  const p = (await post(productPayload({ title: '取消回补', specs: SPECS, skus: SKUS }))).body.data;
  const buyerA = newBuyer();
  const buyerB = newBuyer();

  const d1 = (await draftAs(buyerA, p.slug, '黑|65')).body.data;
  await draftAs(buyerB, p.slug, '黑|65');
  await draftAs(buyerB, p.slug, '黑|80');
  assert.equal((await skuRow(p.slug, '黑|65')).committed, 2);
  assert.equal((await skuRow(p.slug, '黑|80')).committed, 1);

  const tokenA = (await login(ctx, buyerA)).token;
  assertOk(await request(app).post(`/api/orders/${d1.id}/cancel`).set('Authorization', `Bearer ${tokenA}`).set('X-Mk-Shop', shopRef.value).expect(200));
  assert.equal((await skuRow(p.slug, '黑|65')).committed, 1, '只回补被取消的那单');
  assert.equal((await skuRow(p.slug, '黑|80')).committed, 1, '其它组合不受影响');
});

// ── 编辑 ──

test('编辑商品：同 key 组合的销量保留；改价不影响占位', async () => {
  const p = (await post(productPayload({ title: '编辑保留销量', specs: SPECS, skus: SKUS }))).body.data;
  await draftAs(newBuyer(), p.slug, '黑|65');
  assert.equal((await skuRow(p.slug, '黑|65')).committed, 1);

  const edited = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ specs: SPECS, skus: SKUS.map((s) => (s.key === '黑|65' ? { ...s, priceUsdtMicro: 99_000_000 } : s)) })
    .expect(200);
  assertOk(edited);
  const row = await skuRow(p.slug, '黑|65');
  assert.equal(row.price_usdt_micro, 99_000_000, '改价生效');
  assert.equal(row.committed, 1, '改价不触碰占位');
});

test('编辑：总量不得小于该组合已占位（校验先于写入）；SKU 支持只提交库存', async () => {
  const p = (await post(productPayload({ title: '总量下限', specs: SPECS, skus: SKUS }))).body.data;
  await draftAs(newBuyer(), p.slug, '黑|65');

  const tooSmall = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ skus: [{ key: '黑|65', capacity: 0 }] })
    .expect(200);
  assert.notEqual(tooSmall.body.code, 0);
  assert.match(tooSmall.body.message, /不能小于已占位/);
  assert.equal((await skuRow(p.slug, '黑|65')).capacity, 2, '被拒后库存不变——校验必须先于写入');

  const onlyCap = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ skus: [{ key: '黑|65', capacity: 7 }] })
    .expect(200);
  assertOk(onlyCap);
  const row = await skuRow(p.slug, '黑|65');
  assert.equal(row.capacity, 7);
  assert.equal(row.price_usdt_micro, 100_000_000, '未提交价格时沿用原价');
});

/**
 * **规格键变更必须被拦住**（源码审计 2026-09 复审，P1）。
 *
 * `sku_key` 由规格选项值拼接，改一个选项名就换了一把键；而 `saveSkus` 按**同 key** 继承
 * `committed`——旧键那一行的已占位/已售被静默丢弃，在途订单仍持旧键（容量校验与在途核算
 * 都只看同名键）⇒ `capacity=2 / committed=0` 而 3 张在途单各持 1 件，再卖 2 件就是
 * 5 件承诺对 2 件容量（超卖）。这正是文件下方那段注释要防的事，只是被"换键"从旁边绕过了。
 */
test('编辑规格：改选项名（换 sku_key）时若仍有在途单占着旧组合 ⇒ 拒绝并说明处置办法', async () => {
  const p = (await post(productPayload({ title: '换键守卫', specs: SPECS, skus: SKUS }))).body.data;
  const wallet = newBuyer();
  const buyerToken = (await login(ctx, wallet)).token;
  const draft = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: p.slug, skuKey: '黑|65' });
  assertOk(draft);
  assert.equal((await skuRow(p.slug, '黑|65')).committed, 1, '前提：旧组合已有占位');

  // 把「黑」改成「纯黑」：key 从 黑|65 变成 纯黑|65 —— 旧组合即将消失，但还有在途单占着
  const renamed = SPECS.map((s) => (s.name === '颜色' ? { ...s, options: ['纯黑', '白'] } : s));
  const renamedSkus = SKUS.map((s) => ({ ...s, key: s.key.replace('黑', '纯黑') }));
  const r = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ specs: renamed, skus: renamedSkus })
    .expect(200);
  assert.notEqual(r.body.code, 0, '更换规格键而旧键仍有在途单时必须拒绝');
  assert.match(String(r.body.message || ''), /在途订单|规格组合将被删除/);
  assert.equal((await skuRow(p.slug, '黑|65')).committed, 1, '被拒后旧组合的账目完好');
  assert.equal(await skuRow(p.slug, '纯黑|65'), undefined, '被拒后不得落新组合');

  // 在途单取消（占位释放）之后，同样的改名就被放行
  assertOk(
    await request(app)
      .post(`/api/orders/${draft.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
      .expect(200)
  );
  const ok = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ specs: renamed, skus: renamedSkus })
    .expect(200);
  assertOk(ok);
  assert.equal((await skuRow(p.slug, '纯黑|65')).committed, 0, '新键从 0 起算（旧占位已随取消释放）');
});

/**
 * **未显式提交 per-SKU `active` 的 PATCH 不得把「已停售组合」重新上架**（源码审计 2026-09 复审，P1）。
 * 前端的下架/上架按钮只发 `{active:false}` / `{active:true}`，而部分更新的 base 与整体更新
 * 都曾丢掉 per-sku 的 active ⇒ 卖家"单独停售某规格"的决策被一次上下架静默撤销。
 */
test('编辑商品：整体上下架不得把已停售的单个组合重新上架', async () => {
  const p = (await post(productPayload({ title: '停售保持', specs: SPECS, skus: SKUS }))).body.data;

  // 单独停售「黑|65」
  assertOk(
    await request(app)
      .patch(`/api/products/${p.slug}`)
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
      .send({ skus: [{ key: '黑|65', active: false }] })
      .expect(200)
  );
  assert.equal((await skuRow(p.slug, '黑|65')).active, 0);

  // 只改商品级 active（= 前端下架按钮的真实请求体）
  assertOk(
    await request(app)
      .patch(`/api/products/${p.slug}`)
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
      .send({ active: false })
      .expect(200)
  );
  assert.equal((await skuRow(p.slug, '黑|65')).active, 0, '整体下架后该组合仍为停售');

  // 再上架回来，per-sku 的停售决策同样必须保持
  assertOk(
    await request(app)
      .patch(`/api/products/${p.slug}`)
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
      .send({ active: true })
      .expect(200)
  );
  assert.equal((await skuRow(p.slug, '黑|65')).active, 0, '重新上架商品不得撤销单个组合的停售');
  assert.equal((await skuRow(p.slug, '白|65')).active, 1, '其它组合不受影响');

  // 只改价（同样不提交 active）
  assertOk(
    await request(app)
      .patch(`/api/products/${p.slug}`)
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
      .send({ skus: [{ key: '黑|65', priceUsdtMicro: 123_450_000 }] })
      .expect(200)
  );
  assert.equal((await skuRow(p.slug, '黑|65')).active, 0, '改价同样不得改回上架');
  assert.equal((await skuRow(p.slug, '黑|65')).price_usdt_micro, 123_450_000);
});

// ── 快照 ──


test('快照覆盖规格与逐组合单价，且可复算；改任一组合价格哈希必变', async () => {
  const { snapshotObject, computeSnapshotHash } = await import('../src/routes/products.js');
  const p = (await post(productPayload({ title: '快照', specs: SPECS, skus: SKUS }))).body.data;

  /*
    JSON 列（media/specs）**不 stringify**：投影只收驱动解析好的数组/对象，
    传字符串会被 `assertParsedJsonColumn` 响亮拒绝（见 setup.mjs 的 rowLikeOf）。
  */
  const snap = snapshotObject({
    slug: p.slug,
    title: p.title,
    description: p.description,
    media: p.media,
    kind: p.kind,
    specs: p.specs,
    skus: p.skus.map((s) => ({ sku_key: s.key, price_usdt_micro: s.priceUsdtMicro })),
  });
  assert.deepEqual(snap.specs, SPECS, '快照含规格定义');
  assert.deepEqual(
    snap.skus,
    [...SKUS].sort((a, b) => (a.key < b.key ? -1 : 1)).map((s) => [s.key, s.priceUsdtMicro]),
    '快照含逐组合单价（按 key 升序，保证哈希确定）'
  );
  assert.equal(computeSnapshotHash(snap), p.snapshotHash, '哈希可复算');

  await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ skus: SKUS.map((s) => (s.key === '白|80' ? { ...s, priceUsdtMicro: 1 } : s)) })
    .expect(200);
  const after = (await request(app).get(`/api/products/${p.slug}`).expect(200)).body.data;
  assert.notEqual(after.snapshotHash, p.snapshotHash, '组合改价应重算快照哈希');
});

// ── 停售 ──

test('SKU 停售：该组合不可下单，但不影响其它组合；与「售罄」是两回事', async () => {
  const p = (await post(productPayload({ title: '停售组合', specs: SPECS, skus: SKUS }))).body.data;

  // 把「黑|65」停售（库存仍有 2，区别于点它售罄）
  const off = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ skus: [{ key: '黑|65', active: false }] })
    .expect(200);
  assertOk(off);
  assert.equal((await skuRow(p.slug, '黑|65')).active, 0, '停售落库');
  assert.equal((await skuRow(p.slug, '黑|65')).capacity, 2, '停售不动库存（是「不卖了」不是「卖完了」）');
  assert.equal((await skuRow(p.slug, '黑|80')).active, 1, '其它组合不受影响');

  const buyer = newBuyer();
  const blocked = await draftAs(buyer, p.slug, '黑|65');
  assert.notEqual(blocked.body.code, 0);
  assert.match(blocked.body.message, /已停售/);

  // 其它组合照常可买
  assertOk(await draftAs(buyer, p.slug, '黑|80'));

  // 恢复上架
  const on = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ skus: [{ key: '黑|65', active: true }] })
    .expect(200);
  assertOk(on);
  assert.equal((await skuRow(p.slug, '黑|65')).active, 1);
  assertOk(await draftAs(newBuyer(), p.slug, '黑|65'));
});

test('停售的 SKU 在对外 DTO 里 skus[i].active=false，全部停售时 outOfStock=true', async () => {
  const p = (await post(productPayload({ title: '全停售', specs: SPECS, skus: SKUS }))).body.data;
  const off = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ skus: SKUS.map((s) => ({ key: s.key, active: false })) })
    .expect(200);
  assertOk(off);
  assert.equal(off.body.data.outOfStock, true, '全部停售 = 不可购');
  assert.ok(off.body.data.skus.every((s) => s.active === false));

  const detail = (await request(app).get(`/api/products/${p.slug}`).expect(200)).body.data;
  assert.equal(detail.outOfStock, true);
  assert.ok(detail.skus.every((s) => s.active === false), '公开详情也如实反映停售');
});

test('编辑保留同 key 的销量且不误改停售状态', async () => {
  const p = (await post(productPayload({ title: '保留状态', specs: SPECS, skus: SKUS }))).body.data;
  await draftAs(newBuyer(), p.slug, '黑|65');
  assert.equal((await skuRow(p.slug, '黑|65')).committed, 1);

  await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ skus: [{ key: '黑|65', active: false }, { key: '黑|80' }] })
    .expect(200);
  const row = await skuRow(p.slug, '黑|65');
  assert.equal(row.active, 0, '停售生效');
  assert.equal(row.committed, 1, '未提交 committed，销量保留');
});