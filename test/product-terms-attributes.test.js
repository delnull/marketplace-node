/**
 * 商品**承诺**（terms）、**参数**（attributes）与**规格图**（product_skus.image_url）：
 * 形状、上限、快照行为与"改一处必变哈希、无关改动不变"的边界。
 *
 * 为什么这三样合在一个文件里：它们的判据是同一条 ——
 * **买家据以付款的东西必须被哈希钉住**（见 routes/products.js 的 snapshotObject 说明）。
 *   · 承诺 = 条款本身（晚发货/不给退这类争议此前在机制内没有客观判据）；
 *   · 参数 = "这东西是什么"（货不对板争议的对照物）；
 *   · 规格图 = "我选的那一档长什么样"（事后换图而哈希不变即所见非所得）。
 *
 * 这里同时也钉住**不**进快照的那些边界：标签仍是检索维度（改它不改哈希），
 * 与三者形成对照——快照里该有什么、不该有什么，两侧各有一个反例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner } = ctx;

const ownerToken = (await login(ctx, owner)).token;

const create = async (body) => {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(body)
    .expect(200);
  if (res.body.code !== 0) throw new Error(res.body.message);
  return res.body.data;
};

/** PATCH 成功则返回规范化后的商品（失败直接抛出服务端的可读原因——用例里不该静默跳过） */
const patch = async (slug, body) => {
  const res = await request(app)
    .patch(`/api/products/${slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(body)
    .expect(200);
  if (res.body.code !== 0) throw new Error(res.body.message);
  return res.body.data;
};

/* ── 承诺 ───────────────────────────────────────────────────────────── */

test('承诺：未声明是"未声明"，不是"不支持退换"；恒为完整对象（DTO 契约）', async () => {
  const p = await create(productPayload({ title: '没有承诺的商品' }));
  assert.deepEqual(
    p.terms,
    { handling_days: null, return_policy: 'unspecified', return_window_days: null, return_freight: null, invoice_supported: null },
    '没填 ≠ 声明了"不退换"——把没表态读成一句承诺，等于替店主说话'
  );
});

test('承诺：声明可退换就必须给窗口；不可退换时窗口与运费承担方都不许填', async () => {
  const missing = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '缺窗口', terms: { return_policy: 'no-reason' } }))
    .expect(200);
  assert.equal(missing.body.code, 1);
  assert.match(String(missing.body.message), /退换窗口/);

  const contradictory = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '自相矛盾', terms: { return_policy: 'none', return_window_days: 7, return_freight: 'seller' } }))
    .expect(200);
  assert.equal(contradictory.body.code, 1);
  assert.match(String(contradictory.body.message), /退换窗口/);

  const bad = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '天数越界', terms: { handling_days: 0 } }))
    .expect(200);
  assert.equal(bad.body.code, 1, '0 天不是承诺（没有可核对的边界）');

  const unknown = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '未知键', terms: { warranty_days: 90 } }))
    .expect(200);
  assert.equal(unknown.body.code, 1, '不认识的承诺字段也要点名拒绝');
  assert.match(String(unknown.body.message), /warranty_days/);
});

test('承诺入快照：改承诺必变哈希；只改标签则不变（检索维度 vs 条款的边界）', async () => {
  const p = await create(
    productPayload({
      title: '承诺影响快照',
      terms: { handling_days: 2, return_policy: 'no-reason', return_window_days: 7, return_freight: 'seller', invoice_supported: null },
    })
  );
  assert.deepEqual(p.terms, {
    handling_days: 2,
    return_policy: 'no-reason',
    return_window_days: 7,
    return_freight: 'seller',
    invoice_supported: null,
  });

  const changed = await patch(p.slug, { terms: { handling_days: 5, return_policy: 'no-reason', return_window_days: 7, return_freight: 'buyer' } });
  assert.notEqual(changed.snapshotHash, p.snapshotHash, '改承诺必须重算快照哈希');

  const relabel = await patch(p.slug, { tags: ['春茶'] });
  assert.equal(relabel.snapshotHash, changed.snapshotHash, '标签不进快照（它只是检索维度）');
});

test('承诺三态：未提交 = 不动；提交完整对象 = 覆盖；显式回到未声明 = 清空', async () => {
  const p = await create(productPayload({ title: '承诺三态', terms: { handling_days: 3 } }));
  assert.equal(p.terms.handling_days, 3);

  // 未提交：只改标题，承诺必须原样留在库里（漏传等于把承诺悄悄抹掉，而买家手里的哈希会立刻对不上）
  const titleOnly = await patch(p.slug, { title: '承诺三态（改标题）' });
  assert.equal(titleOnly.terms.handling_days, 3, '未提交 terms 时沿用现值');

  const cleared = await patch(p.slug, { terms: {} });
  assert.deepEqual(cleared.terms, {
    handling_days: null,
    return_policy: 'unspecified',
    return_window_days: null,
    return_freight: null,
    invoice_supported: null,
  });
});

/* ── 参数 ───────────────────────────────────────────────────────────── */

test('参数：去重按大小写不敏感的键；只写一半报错；超长报错；条数有上限', async () => {
  const p = await create(
    productPayload({
      title: '参数形状',
      attributes: [
        { name: '成色', value: '全新' },
        { name: 'Brand', value: 'A' },
        { name: 'brand', value: 'B' }, // 与上一条同键（ASCII 折小写）→ 只留先出现的那种写法
        { name: '', value: '' }, // 整行没填：丢弃，不是错误
      ],
    })
  );
  assert.deepEqual(p.attributes, [
    { name: '成色', value: '全新' },
    { name: 'Brand', value: 'A' },
  ]);

  const half = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '只写一半', attributes: [{ name: '成色', value: '' }] }))
    .expect(200);
  assert.equal(half.body.code, 1, '只填名称不填值 = 这条参数不存在，必须说出来');
  assert.match(String(half.body.message), /没有填值/);

  const long = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '超长', attributes: [{ name: '说明', value: 'x'.repeat(61) }] }))
    .expect(200);
  assert.equal(long.body.code, 1);
  assert.match(String(long.body.message), /60 字上限/);

  const many = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(
      productPayload({
        title: '太多',
        attributes: Array.from({ length: 21 }, (_, i) => ({ name: `参数${i}`, value: 'v' })),
      })
    )
    .expect(200);
  assert.equal(many.body.code, 1);
  assert.match(String(many.body.message), /最多 20 条/);

  const extraKey = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '多键', attributes: [{ name: '成色', value: '全新', extra: 1 }] }))
    .expect(200);
  assert.equal(extraKey.body.code, 1, '每一行只认 name/value，多一个键就是"提交了不生效"');
});

test('参数入快照：改参数必变哈希；未提交则沿用', async () => {
  const p = await create(productPayload({ title: '参数影响快照', attributes: [{ name: '成色', value: '全新' }] }));
  const same = await patch(p.slug, { title: '参数影响快照（改标题）' });
  assert.deepEqual(same.attributes, [{ name: '成色', value: '全新' }], '未提交 attributes 时沿用现值');

  const changed = await patch(p.slug, { attributes: [{ name: '成色', value: '九成新' }] });
  assert.notEqual(changed.snapshotHash, same.snapshotHash, '改参数必须重算快照哈希');
});

/* ── 规格图 ─────────────────────────────────────────────────────────── */

test('规格图：逐组合可选；进快照只收有图的组合；批量改价不会把它丢掉', async () => {
  const p = await create(
    productPayload({
      title: '多规格带图',
      specs: [{ name: '颜色', options: ['黑', '白'] }],
      skus: [
        { key: '黑', priceUsdtMicro: 10_000_000, imageUrl: 'https://example.com/black.png' },
        { key: '白', priceUsdtMicro: 12_000_000 }, // 没有独立图
      ],
    })
  );
  assert.equal(p.skus.find((s) => s.key === '黑').imageUrl, 'https://example.com/black.png');
  assert.equal(p.skus.find((s) => s.key === '白').imageUrl, '');

  // 快照里的 sku_images 只含有图的组合（空图与"没传过图"对买家同形）
  const { snapshotObject } = await import('../src/routes/products.js');
  const { loadSkus } = await import('../src/routes/products.js');
  const row = await ctx.db.get('SELECT * FROM products WHERE slug = ?', p.slug);
  const snap = snapshotObject({ ...row, skus: await loadSkus(row.id) });
  assert.deepEqual(snap.sku_images, [['黑', 'https://example.com/black.png']]);
  assert.deepEqual(snap.skus, [['白', 12_000_000], ['黑', 10_000_000]], '价格仍在二元组里（形状不变）');

  // 批量改价：整行重算快照，**不许把 image_url 丢掉**（丢了 = 改一次价，所有规格图从快照里消失）
  const batch = await request(app)
    .patch('/api/products/batch')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ slugs: [p.slug], patch: { priceUsdtMicro: 9_000_000 } })
    .expect(200);
  assertOk(batch);
  const after = await request(app)
    .get(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(after);
  assert.equal(
    after.body.data.skus.find((s) => s.key === '黑').imageUrl,
    'https://example.com/black.png',
    '批量改价后规格图必须还在'
  );
  const row2 = await ctx.db.get('SELECT * FROM products WHERE slug = ?', p.slug);
  const snap2 = snapshotObject({ ...row2, skus: await loadSkus(row2.id) });
  assert.deepEqual(snap2.sku_images, [['黑', 'https://example.com/black.png']], '快照里的规格图也必须还在');
  assert.equal(after.body.data.snapshotHash, row2.snapshot_hash, '公开字段可复算（DTO 与快照同源）');
});

test('规格图：非法 URL 被拒（与主图同一套判据）；非法 SKU 字段点名拒绝', async () => {
  const bad = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '坏图', skus: [{ key: '', priceUsdtMicro: 1_000_000, imageUrl: 'javascript:alert(1)' }] }))
    .expect(200);
  assert.equal(bad.body.code, 1);
  assert.match(String(bad.body.message), /http\/https/);

  const extra = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '多键 sku', skus: [{ key: '', priceUsdtMicro: 1_000_000, img: 'x' }] }))
    .expect(200);
  assert.equal(extra.body.code, 1, '组合条目多一个键 = 提交了不生效，同样要点名');
  assert.match(String(extra.body.message), /img/);
});

test('订单快照锁定承诺/参数/规格图（下单时冻结，事后改商品不影响在途单）', async () => {
  const buyer = ctx.buyer;
  const buyerToken = (await login(ctx, buyer)).token;
  const p = await create(
    productPayload({
      kind: 'physical',
      title: '快照冻结',
      attributes: [{ name: '产地', value: '武夷山' }],
      terms: { handling_days: 2 },
      skus: [{ key: '', priceUsdtMicro: 8_000_000, imageUrl: 'https://example.com/only.png' }],
    })
  );
  const created = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: p.slug })
    .expect(200);
  assertOk(created);
  const snap = created.body.data.productSnapshot;
  assert.deepEqual(snap.attributes, [{ name: '产地', value: '武夷山' }]);
  assert.equal(snap.terms.handling_days, 2);
  assert.deepEqual(snap.sku_images, [['', 'https://example.com/only.png']]);

  // 事后改商品：订单里锁定的那一份不动（这正是"承诺是可核验的"的含义）
  const after = await patch(p.slug, { terms: { handling_days: 9 }, attributes: [{ name: '产地', value: '外地' }] });
  assert.equal(after.terms.handling_days, 9);
  const reread = await request(app)
    .get(`/api/orders/${created.body.data.id}`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(reread);
  assert.equal(reread.body.data.productSnapshot.terms.handling_days, 2, '在途单的承诺按快照执行');
  assert.deepEqual(reread.body.data.productSnapshot.attributes, [{ name: '产地', value: '武夷山' }]);
  assert.equal(reread.body.data.snapshotHash, created.body.data.snapshotHash, '快照哈希不变（可复算核验）');
});

test('开票声明：三态（true / false / 未声明），且只认布尔', async () => {
  /*
    为什么这条要单独钉：`invoice_supported` 决定**买家侧有没有开票入口**
    （判据 productSupportsInvoice：只有 true 才算），而且它进快照、仲裁时照着读。
    所以三件事各自成立：true 传 true、false 传 false、没填传 null（**不是 false**——
    把"没填"记成"明确不开"就是替店主说了一句他没说过的话）。
  */
  const yes = await create(productPayload({ kind: 'physical', terms: { invoice_supported: true }, capacity: 5 }));
  assert.equal(yes.terms.invoice_supported, true);
  const no = await create(productPayload({ kind: 'physical', terms: { invoice_supported: false }, capacity: 5 }));
  assert.equal(no.terms.invoice_supported, false);
  const unset = await create(productPayload({ kind: 'physical', terms: { handling_days: 1 }, capacity: 5 }));
  assert.equal(unset.terms.invoice_supported, null, '没填 = 未声明，不许折成 false');

  // 只认布尔：'true' / 1 / 'yes' 一律拒绝（否则"店主声明了什么"变成拼写问题）
  for (const bad of ['true', 1, 'yes']) {
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
      .send(productPayload({ kind: 'physical', terms: { invoice_supported: bad }, capacity: 5 }))
      .expect(200);
    assert.notEqual(res.body.code, 0, `invoice_supported=${JSON.stringify(bad)} 必须被拒`);
    assert.match(String(res.body.message), /invoice_supported/);
  }

  // 改开票声明会改变快照哈希（它是进快照的店主陈述）
  const patched = await request(app)
    .patch(`/api/products/${unset.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ terms: { handling_days: 1, invoice_supported: true } })
    .expect(200);
  assert.equal(patched.body.data.terms.invoice_supported, true);
  assert.notEqual(patched.body.data.snapshotHash, unset.snapshotHash, '开票声明进快照 ⇒ 改它必变哈希');
});
