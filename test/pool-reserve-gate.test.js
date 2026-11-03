/**
 * 池式商品占位闸（`products.reserved_codes` / `reserved_tokens`）的**并发边界**用例。
 *
 * 口径：占位 = 该商品「在途订单（draft/escrowed/shipped/disputed）尚未交付的件数」，
 * 可用量 = 池内 unused − 占位。加量在应用（`src/poolQuota.js` 的守卫 UPDATE），
 * 减量与"恢复时占回来"在 `orders` / `order_delivery_items` 上的触发器（`db.js` 的 TRIGGER_DDL）。
 *
 * 这条闸的意义是"付款后必有货可发"：旧实现是下单时现算一遍 `COUNT(unused) − SUM(需求)`，
 * 靠全局写锁才成立；锁删掉之后，两个并发草稿会各自看到"还剩 1 个码"。
 * 所以这里的判据是**确切数字**（30 并发对 10 个码 → 恰好 10；交付 5 件后新占位必须被拒），
 * 以及**计数器与真值的对拍**（不变量）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, insertProduct, insertOrder, login, assertOk, productPayload, shopRef } from './setup.mjs';

process.env.MK_DB_POOL_SIZE = '8'; // 必须在 makeCtx()（→ initDb → 建池）之前（同 draft-quota-gate）

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;
const { withTransaction, abortTx } = await import('../src/db.js');
const { reservePoolUnits } = await import('../src/poolQuota.js');
const { deliverDigitalFromPool } = await import('../src/autoDeliver.js');

const ownerToken = (await login(ctx, owner)).token;

async function burst(n, fn) {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
  return {
    ok: results.filter((r) => r.status === 'fulfilled' && r.value === 'ok').length,
    errors: results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.code || r.reason?.message)),
  };
}

/** 占位 + 落一张草稿（与下单路由同一个形状：同一个事务里占位与插单） */
async function attemptDraft(buyer, product, units = 1) {
  return await withTransaction(async () => {
    if (!(await reservePoolUnits(product.productId, product.kind, units))) return abortTx({ fail: 'pool_empty' });
    await insertOrder(db, { buyer, seller: owner.address.toLowerCase(), productId: product.productId, quantity: units });
    return 'ok';
  });
}

/** 上架一件池式商品（`insertProduct` 返回的没有 kind，用例自己带上——闸按 kind 选池） */
async function insertPoolProduct(spec) {
  const p = await insertProduct(db, { skus: [{ key: '', priceUsdtMicro: 1_000_000 }], ...spec });
  return { ...p, kind: spec.kind };
}

const reservedOf = async (productId, col = 'reserved_codes') =>
  Number((await db.get(`SELECT ${col} AS v FROM products WHERE id = ?`, productId)).v);
const unusedOf = async (productId, table = 'product_codes') =>
  Number((await db.get(`SELECT COUNT(*) AS c FROM ${table} WHERE product_id = ? AND status = 'unused'`, productId)).c);

/** 池内资源（直接落行：本用例关心的是计数器，不是导入接口） */
async function fillPool(productId, n, kind = 'digital') {
  const table = kind === 'digital' ? 'product_codes' : 'product_nft_tokens';
  const col = kind === 'digital' ? 'code' : 'token_id';
  for (let i = 0; i < n; i++) await db.run(`INSERT INTO ${table} (product_id, ${col}) VALUES (?, ?)`, productId, `R-${i}`);
}

/** 该商品当前"真值"：在途订单尚未交付的件数合计（旧实现现算的那个量） */
async function pendingTruth(productId, itemKind = 'code') {
  const r = await db.get(
    `SELECT COALESCE(SUM(GREATEST(o.quantity - (
              SELECT COUNT(*) FROM order_delivery_items d WHERE d.order_id = o.id AND d.kind = ?), 0)), 0) AS need
       FROM orders o WHERE o.product_id = ? AND o.status IN ('draft','escrowed','shipped','disputed')`,
    itemKind,
    productId
  );
  return Number(r.need);
}

test('池占位：10 个码 / 30 并发 → 恰好 10 个成功，计数器 = 10 = 真值', async () => {
  const p = await insertPoolProduct({ kind: 'digital', title: '并发池占位' });
  await fillPool(p.productId, 10);
  const { ok, errors } = await burst(30, () => attemptDraft(Wallet.createRandom().address.toLowerCase(), p));
  assert.deepEqual(errors, [], `不得有异常：${errors.join(' / ')}`);
  assert.equal(ok, 10, `30 并发对 10 个未用码：只应 10 个成功（实际 ${ok}）`);
  assert.equal(await reservedOf(p.productId), 10, '占位计数必须恰好 10');
  assert.equal(await reservedOf(p.productId), await pendingTruth(p.productId), '计数器必须等于旧口径现算出来的在途需求');
  assert.equal(await unusedOf(p.productId), 10, '占位不动池里的行（只是"留出来"）');
});

test('交付一件减一件：交付 5 件后（池剩 5）新占位必须被拒，且拒因是"兑换码不足"', async () => {
  const listed = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'digital', title: '交付释放占位', capacity: null }))
    .expect(200);
  assertOk(listed);
  const slug = listed.body.data.slug;
  const productId = Number((await db.get('SELECT id FROM products WHERE slug = ?', slug)).id);
  const imported = await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ codes: ['K1', 'K2', 'K3', 'K4', 'K5'] })
    .expect(200);
  assertOk(imported);

  // 5 个买家各占 1 件（走 HTTP：端到端确认路由也用同一个守卫）
  for (let i = 0; i < 5; i++) {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
      .send({ productSlug: slug, quantity: 1, buyer: Wallet.createRandom().address })
      .expect(200);
    assertOk(res);
  }
  assert.equal(await reservedOf(productId), 5, '5 张单各占 1 件');
  // 池被占满：第 6 张在下单阶段就被拒（付款后无码可发是这条闸要防的事）
  const oversell = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, quantity: 1, buyer: Wallet.createRandom().address })
    .expect(200);
  assert.notEqual(oversell.body.code, 0, '池里没有被在途订单占用的余量了，新单必须被拒');
  assert.match(oversell.body.message, /兑换码不足/);

  // 交付 3 件（走真实交付函数：它插交付行 ⇒ 触发器按件释放占位）
  const drafts = await db.all("SELECT id, order_no FROM orders WHERE product_id = ? AND status = 'draft' ORDER BY id", productId);
  for (const d of drafts.slice(0, 3)) {
    await db.run("UPDATE orders SET status = 'escrowed' WHERE id = ?", d.id); // escrowed ∈ 在途集合：不触发结清
    const r = await deliverDigitalFromPool({ order_id: d.id, order_no: d.order_no, product_id: productId, quantity: 1 });
    assert.ok(r.codes, `交付应成功：${JSON.stringify(r)}`);
  }
  assert.equal(await unusedOf(productId), 2, '交付 3 件后池里只剩 2 个未用码');
  assert.equal(await reservedOf(productId), 2, '占位同样减 3（交付掉的件不再需要留着）');
  assert.equal(await reservedOf(productId), await pendingTruth(productId), '计数器与真值仍然一致');

  // 池已被掏空到"刚好覆盖剩余在途需求"：新占位仍然被拒（余量 = 2 − 2 = 0）
  const stillBlocked = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, quantity: 1, buyer: Wallet.createRandom().address })
    .expect(200);
  assert.notEqual(stillBlocked.body.code, 0, '可用量为 0 时必须拒绝');
});

test('取消把占位还回来；恢复（cancelled→escrowed）再占回去', async () => {
  const p = await insertPoolProduct({ kind: 'digital', title: '占位的释放与恢复' });
  await fillPool(p.productId, 3);
  const buyer = Wallet.createRandom().address.toLowerCase();
  assert.equal(await attemptDraft(buyer, p), 'ok');
  assert.equal(await reservedOf(p.productId), 1);

  // 取消（不经应用，直接改状态）：结清触发器
  const row = await db.get("SELECT id FROM orders WHERE product_id = ? AND status = 'draft'", p.productId);
  await db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", row.id);
  assert.equal(await reservedOf(p.productId), 0, '取消必须把占位还回来（不然这张商品再也卖不出去）');

  // 恢复（买家在草稿被取消之后才完成支付——watcher / sync / 对账都走这一条迁移）
  await db.run("UPDATE orders SET status = 'escrowed' WHERE id = ? AND status = 'cancelled'", row.id);
  assert.equal(await reservedOf(p.productId), 1, '恢复必须把占位占回来（不然余量虚高 ⇒ 超卖）');
  assert.equal(await reservedOf(p.productId), await pendingTruth(p.productId));
});

test('期货不变量：计数器恒等于"在途订单尚未交付的件数"（交付/取消/恢复混合后仍成立）', async () => {
  const p = await insertPoolProduct({ kind: 'digital', title: '不变量对拍' });
  await fillPool(p.productId, 6);
  const buyers = Array.from({ length: 4 }, () => Wallet.createRandom().address.toLowerCase());
  for (const b of buyers) assert.equal(await attemptDraft(b, p, 1), 'ok');
  const rows = await db.all('SELECT id, order_no FROM orders WHERE product_id = ? ORDER BY id', p.productId);
  // 一张交付、一张取消、一张恢复（先取消再恢复）
  await db.run("UPDATE orders SET status = 'escrowed' WHERE id = ?", rows[0].id);
  await deliverDigitalFromPool({ order_id: rows[0].id, order_no: rows[0].order_no, product_id: p.productId, quantity: 1 });
  await db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", rows[1].id);
  await db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", rows[2].id);
  await db.run("UPDATE orders SET status = 'escrowed' WHERE id = ? AND status = 'cancelled'", rows[2].id);
  assert.equal(await reservedOf(p.productId), await pendingTruth(p.productId), '计数器与真值必须逐件一致');
});

test('池未建（一个资源行都没有）时不拦：卖家手动交付那种形态仍然能下单', async () => {
  const p = await insertPoolProduct({ kind: 'digital', title: '无池数字商品' });
  const buyer = Wallet.createRandom().address.toLowerCase();
  for (let i = 0; i < 3; i++) {
    assert.equal(await attemptDraft(buyer, p), 'ok', '池未建时不该拦（旧语义：卖家手动交付/自由文本）');
  }
  assert.equal(await reservedOf(p.productId), 3, '不拦不等于不记账：这 3 件的需求仍然记在计数器上');
  assert.equal(await reservedOf(p.productId), await pendingTruth(p.productId));
});

test('取消后直接进入 disputed（链上支付晚到/OrderCreated 漏扫）必须把池占位补回来', async () => {
  const p = await insertPoolProduct({ kind: 'digital', title: '取消后争议复活' });
  await fillPool(p.productId, 1);
  const buyer = Wallet.createRandom().address.toLowerCase();
  assert.equal(await attemptDraft(buyer, p, 1), 'ok');
  const row = await db.get('SELECT id FROM orders WHERE product_id = ? ORDER BY id DESC LIMIT 1', p.productId);

  await db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", row.id);
  assert.equal(await reservedOf(p.productId), 0, '取消必须释放池占位');

  await db.run("UPDATE orders SET status = 'disputed' WHERE id = ?", row.id);
  assert.equal(await reservedOf(p.productId), 1, '取消后被链上争议复活必须重新占位，否则会超卖');
  assert.equal(await reservedOf(p.productId), await pendingTruth(p.productId));
});

test('NFT 池同理：3 并发对 2 枚 → 恰好 2；取消一枚即还回一枚', async () => {
  const p = await insertPoolProduct({
    kind: 'nft',
    title: 'NFT 并发占位',
    nftContract: '0x' + 'ab'.repeat(20),
    nftStandard: 'erc721',
  });
  await fillPool(p.productId, 2, 'nft');
  const { ok } = await burst(3, () => attemptDraft(Wallet.createRandom().address.toLowerCase(), p));
  assert.equal(ok, 2, `3 并发对 2 枚：只应 2 个成功（实际 ${ok}）`);
  assert.equal(await reservedOf(p.productId, 'reserved_tokens'), 2);
  const row = await db.get('SELECT id FROM orders WHERE product_id = ? ORDER BY id LIMIT 1', p.productId);
  await db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", row.id);
  assert.equal(await reservedOf(p.productId, 'reserved_tokens'), 1, '取消一枚即还回一枚');
  assert.equal(await reservedOf(p.productId, 'reserved_tokens'), await pendingTruth(p.productId, 'nft'));
});
