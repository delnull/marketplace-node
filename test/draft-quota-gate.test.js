/**
 * 两道免费草稿闸的**并发边界**（同买家活跃草稿 ≤10、同买家同商品草稿占位 ≤99）——
 * "全局写锁删掉之后它们仍然成立"的证据。
 *
 * 为什么这些用例必须存在：加锁时期它们**也**是绿的（串行化免费给的），只有锁真删掉之后
 * 仍然绿，才说明闸自己站得住。所以判据一律是**边界上的确切数字**（恰好 10 张 / 恰好 80 件）
 * 与**计数器的确切终值**，而不是"没报错"。
 *
 * 三件事一起被钉住：
 *   · 加量：`src/draftQuota.js` 的守卫 UPDATE（`changes === 1` 才算占到位）；
 *   · 减量：`orders` 上的触发器（`db.js` 的 TRIGGER_DDL）——**用不经应用的路径也要还回来**
 *     （下面有一条用例直改 status：watcher / 链上对账 / 测试夹具走的正是那条路，
 *     漏了它"测试世界"与"生产世界"的计数器口径就分家了）；
 *   · 建行：新买家的第一张必须被放行（行不存在时守卫 UPDATE 静默命中 0 行，按"changes === 1"
 *     读就会把每一张都拒掉——这是实测踩过的第一个坑）。
 *
 * ⚠️ 并发度：`.env.test` 把池压到 2 条连接（几十个测试文件并行跑，怕撞 max_connections）。
 * 本文件要的是**真的并发**（池只有 2 条时事务会排队，闸的原子性就没被真正压过），
 * 所以在 `makeCtx()` 之前把本进程的池调大到 8——库名/别的一切仍走 setup.mjs 的那一套。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, insertProduct, insertOrder, login, assertOk, productPayload, shopRef } from './setup.mjs';

process.env.MK_DB_POOL_SIZE = '8'; // 必须在 makeCtx()（→ initDb → 建池）之前

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;
const { withTransaction, abortTx, getDb } = await import('../src/db.js');
const { reserveDraftQuota, MAX_ACTIVE_DRAFTS, MAX_DRAFT_UNITS_PER_PRODUCT } = await import('../src/draftQuota.js');

const ownerToken = (await login(ctx, owner)).token;

/** 并发跑 n 次，返回 { ok, errors }（不 await 单个：让它们在守卫 UPDATE 处真正相撞） */
async function burst(n, fn) {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
  return {
    ok: results.filter((r) => r.status === 'fulfilled' && r.value === 'ok').length,
    errors: results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.code || r.reason?.message)),
    values: results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
  };
}

/** 走**应用的那条加量路径**（守卫 UPDATE）+ 落一张草稿：拒单必须整体回滚（abortTx） */
async function attemptDraft(buyer, productId, units) {
  return await withTransaction(async () => {
    const quota = await reserveDraftQuota({ buyer, productId, units });
    if (quota?.fail) return abortTx({ fail: quota.fail });
    await insertOrder(db, { buyer, seller: owner.address.toLowerCase(), productId, quantity: units });
    return 'ok';
  });
}

/**
 * 走**店主代客下单**那条路径：额度记在店主名下，订单行 + 代客标记同一事务。
 * 与生产路由（routes/orders.js）同一形状——marker 缺了，触发器就会去减买家的额度。
 */
async function attemptProxyDraft(seller, buyer, productId, units) {
  return await withTransaction(async () => {
    const quota = await reserveDraftQuota({ buyer, productId, units, proxySeller: seller });
    if (quota?.fail) return abortTx({ fail: quota.fail });
    const { orderId } = await insertOrder(db, { buyer, seller, productId, quantity: units });
    await db.run('INSERT INTO proxy_drafts (order_id) VALUES (?)', orderId);
    return 'ok';
  });
}

const counterOf = async (buyer) => (await db.get('SELECT active_drafts FROM buyer_draft_quota WHERE buyer = ?', buyer))?.active_drafts ?? null;
const unitsOf = async (buyer, productId) => (await db.get('SELECT units FROM buyer_product_quota WHERE buyer = ? AND product_id = ?', buyer, productId))?.units ?? null;
const draftRows = async (buyer) => await db.all("SELECT id, quantity FROM orders WHERE buyer = ? AND status = 'draft'", buyer);

test('闸 1：新买家 40 并发 → 恰好 10 张（8 轮复现，含"行还不存在"的第一张必须放行）', async () => {
  const p = await insertProduct(db, { kind: 'physical', title: '并发草稿上限' });
  const rounds = 3; // 每轮一个新买家：第一轮压在"行不存在"那条路径上，后几轮压"行已存在"
  for (let round = 0; round < rounds; round++) {
    const buyer = Wallet.createRandom().address.toLowerCase();
    assert.equal(await counterOf(buyer), null, '新买家此刻还没有计数器行（正是要压的那个前提）');
    const { ok, errors } = await burst(40, () => attemptDraft(buyer, p.productId, 1));
    assert.deepEqual(errors, [], `第 ${round + 1} 轮不得有异常（死锁/超时都会在这里现形）：${errors.join(' / ')}`);
    assert.equal(ok, MAX_ACTIVE_DRAFTS, `第 ${round + 1} 轮：40 并发只应有 ${MAX_ACTIVE_DRAFTS} 张通过（实际 ${ok}）`);
    assert.equal(await counterOf(buyer), MAX_ACTIVE_DRAFTS, '计数器必须恰好等于通过数');
    assert.equal((await draftRows(buyer)).length, MAX_ACTIVE_DRAFTS, '库里的 draft 行数与通过数一致（不多不少）');
    // 第 11 张被闸挡住，且拒因是这一条闸（不是别的拒绝）
    const extra = await attemptDraft(buyer, p.productId, 1);
    assert.match(String(extra?.fail || ''), /草稿过多/, `超限必须被"草稿过多"这条闸拒掉（实际：${JSON.stringify(extra)}）`);
    assert.equal(await counterOf(buyer), MAX_ACTIVE_DRAFTS, '被拒的那次不得改动计数器');
  }
});

test('闸 2：同买家同商品 20 件 × 20 并发 → 恰好 4 张 / 80 件；拒因带确切读数', async () => {
  const p = await insertProduct(db, { kind: 'physical', title: '并发草稿占位', skus: [{ key: '', priceUsdtMicro: 1_000_000, capacity: 500 }] });
  const buyer = Wallet.createRandom().address.toLowerCase();
  const { ok, errors } = await burst(20, () => attemptDraft(buyer, p.productId, 20));
  assert.deepEqual(errors, [], `不得有异常：${errors.join(' / ')}`);
  assert.equal(ok, 4, `20 并发 × 20 件：只应 4 张通过（80 件；实际 ${ok}）`);
  assert.equal(await unitsOf(buyer, p.productId), 80, '计数器必须是 80 件');
  assert.equal(
    (await draftRows(buyer)).reduce((s, r) => s + Number(r.quantity), 0),
    80,
    '库里草稿的件数合计必须与计数器一致'
  );
  const extra = await attemptDraft(buyer, p.productId, 20);
  assert.match(String(extra?.fail || ''), /合计已达 80\/99/, '拒因要给出"现在是多少"');
  assert.equal(await unitsOf(buyer, p.productId), 80, '被拒的那次不得改动计数器');
});

test('减量：走应用的取消路径与**不经应用**的直改 status 都要把两份额度还回来', async () => {
  const p = await insertProduct(db, { kind: 'physical', title: '释放口径' });
  const buyer = Wallet.createRandom().address.toLowerCase();
  assert.equal((await burst(11, () => attemptDraft(buyer, p.productId, 1))).ok, MAX_ACTIVE_DRAFTS);
  const rows = await draftRows(buyer);
  assert.equal(rows.length, MAX_ACTIVE_DRAFTS);

  // ① 走应用的取消端点（5 张）
  for (const r of rows.slice(0, 5)) {
    const res = await request(app)
      .post(`/api/orders/${(await db.get('SELECT order_no FROM orders WHERE id = ?', r.id)).order_no}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Mk-Shop', shopRef.value)
      .expect(200);
    assertOk(res);
  }
  assert.equal(await counterOf(buyer), 5, '取消 5 张 ⇒ 只剩 5 份草稿额度');
  assert.equal(await unitsOf(buyer, p.productId), 5, '件数合计同样要回落');

  // ② 不经应用、直改 status（watcher / 链上对账 / 测试夹具走的就是这条路）
  await db.run("UPDATE orders SET status = 'cancelled' WHERE id IN (?, ?, ?, ?, ?)", ...rows.slice(5).map((r) => r.id));
  assert.equal(await counterOf(buyer), 0, '直改 status 也必须结清（触发器就是为这条路存在的）');
  assert.equal(await unitsOf(buyer, p.productId), 0, '件数合计同样结清');
  assert.equal((await attemptDraft(buyer, p.productId, 1)), 'ok', '额度回来了就必须能再下单');
});

test('端到端：HTTP 40 并发代客下单 → 恰好 10 个成功，且不占买家自己的额度', async () => {
  const listed = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'physical', title: '并发下单端到端', capacity: 500 }))
    .expect(200);
  assertOk(listed);
  const slug = listed.body.data.slug;
  const buyer = Wallet.createRandom();
  const buyerToken = (await login(ctx, buyer)).token;

  const bodies = await Promise.all(
    Array.from({ length: 40 }, () =>
      request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
        .send({ productSlug: slug, quantity: 1, buyer: buyer.address })
        .expect(200)
        .then((r) => r.body)
    )
  );
  const ok = bodies.filter((b) => b.code === 0).length;
  assert.equal(ok, MAX_ACTIVE_DRAFTS, `HTTP 40 并发也只应有 ${MAX_ACTIVE_DRAFTS} 个成功（实际 ${ok}）`);
  assert.match(
    bodies.filter((b) => b.code !== 0).map((b) => b.message).join(' '),
    /草稿过多/,
    '被拒的必须是"草稿过多"这条闸（而不是库存/风控等别的拒绝）'
  );
  /*
    代客单的额度属于**发起人（店主）**：店主被自己的代客上限挡住，而不是把买家的额度占满。
    旧实现把十张代客草稿记在 buyer 上，这位买家自己一张也建不出来。
  */
  assert.equal(
    Number((await db.get(
      'SELECT active_drafts AS v FROM seller_proxy_draft_quota WHERE seller = ? AND buyer = ?',
      owner.address.toLowerCase(),
      buyer.address.toLowerCase()
    ))?.v ?? 0),
    MAX_ACTIVE_DRAFTS,
    '代客额度按 (店主, 买家) 记账'
  );
  assert.equal(await counterOf(buyer.address.toLowerCase()), null, '买家自己的额度不能被动用');

  const own = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, quantity: 1 })
    .expect(200);
  assertOk(own, '买家自己的第一张草稿必须不受别人代客草稿影响');
  assert.equal(await counterOf(buyer.address.toLowerCase()), 1);
});

test('闸 2 的两侧边界：80 + 19 = 99 放行；再加 1 件被拒且拒因带 99/99', async () => {
  const p = await insertProduct(db, { kind: 'physical', title: '合计边界', skus: [{ key: '', priceUsdtMicro: 1_000_000, capacity: 200 }] });
  const buyer = Wallet.createRandom().address.toLowerCase();
  for (let i = 0; i < 4; i++) assert.equal(await attemptDraft(buyer, p.productId, 20), 'ok'); // 合计 80
  assert.equal(await attemptDraft(buyer, p.productId, 19), 'ok', '80 + 19 = 99 必须放行（边界含等号）');
  assert.equal(await unitsOf(buyer, p.productId), 99);
  const over = await attemptDraft(buyer, p.productId, 1);
  assert.match(String(over?.fail || ''), /合计已达 99\/99/, `99 之上哪怕 1 件也要拒（实际：${JSON.stringify(over)}）`);
  assert.equal(await unitsOf(buyer, p.productId), 99, '被拒的那次不得改动计数器');
});

test('不变量：计数器恒等于"该买家 draft 行数"与"该商品 draft 件数合计"', async () => {
  const p = await insertProduct(db, { kind: 'physical', title: '不变量对拍' });
  const buyer = Wallet.createRandom().address.toLowerCase();
  await attemptDraft(buyer, p.productId, 7);
  await attemptDraft(buyer, p.productId, 3);
  const truth = await db.get(
    "SELECT COUNT(*) AS c, COALESCE(SUM(quantity),0) AS u FROM orders WHERE buyer = ? AND status = 'draft'",
    buyer
  );
  assert.equal(await counterOf(buyer), Number(truth.c), 'active_drafts 必须等于 draft 行数');
  assert.equal(await unitsOf(buyer, p.productId), Number(truth.u), 'units 必须等于 draft 件数合计');
  assert.ok(MAX_DRAFT_UNITS_PER_PRODUCT === 99, '上限口径写死在这里：改它就要同批改这两条断言');
});

test('删除代客草稿：按 (店主, 买家) 还额度，并在四本账处理完之后删掉 marker', async () => {
  const p = await insertProduct(db, { kind: 'digital', title: '代客删除回补' });
  const buyer = Wallet.createRandom().address.toLowerCase();
  const seller = owner.address.toLowerCase();
  const made = await attemptProxyDraft(seller, buyer, p.productId, 2);
  assert.equal(made, 'ok');
  const proxyCounter = async () =>
    Number((await db.get(
      'SELECT active_drafts AS v FROM seller_proxy_draft_quota WHERE seller = ? AND buyer = ?',
      seller,
      buyer
    ))?.v ?? 0);
  assert.equal(await proxyCounter(), 1);

  const row = await db.get("SELECT id FROM orders WHERE buyer = ? AND status = 'draft'", buyer);
  await db.run('DELETE FROM orders WHERE id = ?', row.id);

  assert.equal(await proxyCounter(), 0, '删除代客草稿必须还回代客额度');
  assert.equal(
    Number((await db.get('SELECT COUNT(*) AS c FROM proxy_drafts WHERE order_id = ?', row.id)).c),
    0,
    'marker 必须在四本账处理完之后删掉（否则下一单会误减买家账）'
  );
});
