/**
 * 链上黑名单在**节点侧**的两条行为：`Address` 类挡住下单、`Product` 类挡住聚合列表。
 *
 * 为什么要有这组用例（2026-10 自审）：`addressBlocked` / `blockedProductSlugs` 与
 * `orderGate` 的第一道闸、公开列表的 `NOT IN` 过滤都是新代码，而它们的失败形态**全是静默的**——
 * 名单读不到时若被当成"名单里没有他"，被冻结的地址照常下单、被冻结的商品照常出现在聚合页，
 * 而日志里一个字都没有。本文件把三件事钉住：
 *   ① `Address` 命中 ⇒ 拒单；未命中 ⇒ 放行（**两个方向都要**，只测命中会把"恒拒单"当绿）；
 *   ② 名单**读不到** ⇒ 拒单（fail-closed），不是放行；
 *   ③ `Product` 命中 ⇒ 该商品从公开列表消失、同店其它商品照常，且名单读不到时**不出列表**。
 *
 * 怎么伪造链上名单：走 `chain.setBlocklistReader` 注入点（与 `setChainOrderFetcher` 同款），
 * **不起假 JSON-RPC 服务器**——本组要验证的是判据与控制流，而不是 ethers 的批量解码。
 * （第一版用假 RPC 桩，结果在"桩编码/解码"上绕了一圈，症状看起来像实现问题。）
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeCtx, login, shopRef, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, buyer, owner } = ctx;
const chain = await import('../src/chain.js');
const config = (await import('../src/config.js')).default;

const BUYER = buyer.address.toLowerCase();
/** 置真 ⇒ 名单读取抛错（验证 fail-closed） */
let chainDown = false;
/** 当前"链上名单"：地址集合与商品集合 */
let blockedAddrs = new Set();
let blockedSlugs = new Set();

beforeEach(() => {
  chainDown = false;
  blockedAddrs = new Set();
  blockedSlugs = new Set();
  // 本文件把"链上名单"整条换成注入实现：它只回答取值，判据与控制流仍是被测的真实代码
  config.chain.blocklistAddress = '0x00000000000000000000000000000000000000b1';
  /*
    ⚠️ 注入点必须是 **async**（2026-10-15 修）：真实读取本来就是 async
    （`await getBlocklist().isBlocked(...)`），而这里的桩此前是**同步**的——
    于是 `chain.addressBlocked` 里"忘了 await 就 `!!`"这个错（`!!Promise` 恒为真 ⇒
    **任何地址都被判成已冻结** ⇒ 配了名单的节点一张单也接不了）在两种路径下结论相反：
    桩走同步分支得到正确布尔、真链走 async 分支得到 `true`，而测试全绿。
    桩与真实实现的**同步性**也是被测形状的一部分，不能只对齐返回值。
  */
  chain.setBlocklistReader({
    addressBlocked: async (addr) => {
      if (chainDown) throw new Error('unit-test: 名单读不到');
      return blockedAddrs.has(String(addr).toLowerCase());
    },
    blockedProducts: async () => {
      if (chainDown) throw new Error('unit-test: 名单读不到');
      return [...blockedSlugs];
    },
  });
});

after(() => {
  chain.setBlocklistReader(null);
});

/**
 * **真实路径的形状守卫**：`!!` 不得直接作用在合约调用上。
 *
 * 为什么需要一条"读源码"的用例（而不是再造一个桩）：上面那组用例走的是**注入路径**，
 * 而 2026-10-15 修掉的那个 P0 在**另一条分支**上——`chain.js` 的
 * `return !!getBlocklist().isBlocked(...)` 少了 `await`，`!!` 作用在 Promise 上（恒为真）
 * ⇒ 配了 `MK_BLOCKLIST_ADDRESS` 的节点把**每一位买家**都判成"全网冻结地址"、一张单也接不了。
 * 注入桩无论同步还是异步都碰不到那一行，所以"用桩测判据"这条纪律在这里有一个盲区，
 * 而盲区里恰好藏着"换条分支就完全不同"的错。
 *
 * 判据取形状（`!!` + 合约读取器必须带 `await`）而不是行为：它不需要链、每次 `npm test` 都跑，
 * 且**重新写成那个错就会红**。它只覆盖本文件关心的这条纪律，不是通用 lint。
 */
test('地址名单读取：`!!` 必须作用在 await 之后（!!Promise 恒为真）', () => {
  const raw = readFileSync(new URL('../src/chain.js', import.meta.url), 'utf8');
  /*
    先把注释剥掉再扫：本用例的说明与 `chain.js` 里那段"为什么修"的注释里都**原样写着**
    那个错表达式，不剥就会把自己的说明判成违规（实测踩过——守卫红在自己的注释上）。
  */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const readers = /getBlocklist|getEscrow|getRegistry/;
  const bad = [...src.matchAll(/!!\s*([^\n;]*)/g)]
    .map((m) => m[1])
    // 正确形状是 `!!(await getX()…)`：`await` 紧跟在括号里 ⇒ 不是违规；其余命中读取器的才算
    .filter((tail) => readers.test(tail) && !/^\(\s*await\b/.test(tail));
  assert.deepEqual(
    bad,
    [],
    `chain.js 里有"!! 直接作用在合约调用上"的表达式（Promise 恒为真，会让判据恒为"命中"）：${bad.join(' ｜ ')}`
  );
  assert.match(
    src,
    /!!\(await getBlocklist\(\)\.isBlocked\(/,
    '没找到 `!!(await getBlocklist().isBlocked(...))`——地址名单的真实读取路径不该消失'
  );
});

/* ── 工具 ──────────────────────────────────────────────────────────────── */

async function createDraft(token, slug) {
  return request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, quantity: 1 });
}

async function publishProduct(token, title) {
  const r = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title }));
  assertOk(r);
  return r.body.data.slug;
}

/* ── ① Address 类：命中拒单、未命中放行 ─────────────────────────────────── */

test('Address 类：链上名单命中该买家 ⇒ 建草稿被拒且理由可读', async () => {
  const { token } = await login(ctx, owner);
  const slug = await publishProduct(token, '黑名单用例商品A');
  const { token: buyerToken } = await login(ctx, buyer);

  blockedAddrs = new Set([BUYER]);
  const r = await createDraft(buyerToken, slug);
  assert.equal(r.status, 403, '命中名单必须拒单');
  assert.match(String(r.body?.message || ''), /冻结名单/, '拒因必须说清是名单拦的，而不是"商品不存在"');
  assert.equal((await db.get('SELECT COUNT(*) c FROM v_orders WHERE buyer = ?', BUYER)).c, 0, '拒单不得留下订单行');
});

test('Address 类：未命中 ⇒ 照常建草稿（防"恒拒单"被当成绿）', async () => {
  const { token } = await login(ctx, owner);
  const slug = await publishProduct(token, '黑名单用例商品B');
  const { token: buyerToken } = await login(ctx, buyer);

  blockedAddrs = new Set(['0x1111111111111111111111111111111111111111']);
  const r = await createDraft(buyerToken, slug);
  assertOk(r);
  assert.equal(r.body.data.buyer, BUYER);
});

/* ── ② 名单读不到 ⇒ fail-closed ────────────────────────────────────────── */

test('名单读不到 ⇒ 拒单（fail-closed），绝不按"名单里没有他"放行', async () => {
  const { token } = await login(ctx, owner);
  const slug = await publishProduct(token, '黑名单用例商品C');
  const { token: buyerToken } = await login(ctx, buyer);

  chainDown = true;
  const r = await createDraft(buyerToken, slug);
  assert.equal(r.status, 403, '读不到名单必须拒单');
  assert.match(String(r.body?.message || ''), /读不到链上黑名单/, '必须如实说是"读不到"，不是"你被封了"');
});

/* ── ③ Product 类：单件过滤，同店其它照常 ──────────────────────────────── */

test('Product 类：命中的商品不进公开列表，同店其它商品照常', async () => {
  const { token } = await login(ctx, owner);
  const kept = await publishProduct(token, '黑名单用例商品D');
  const killed = await publishProduct(token, '黑名单用例商品E');

  blockedSlugs = new Set([killed]);
  const r = await request(app).get('/api/products?pageSize=100');
  assertOk(r);
  const slugs = r.body.data.products.map((p) => p.slug);
  assert.ok(!slugs.includes(killed), '命中的商品必须从公开列表消失');
  assert.ok(slugs.includes(kept), '同店其它商品必须照常出现（单品级，不是连店封）');

  // 详情页：命中的商品同样读不到（否则"列表看不到、直链能买"就是半个过滤）
  const d = await request(app).get(`/api/products/${killed}`);
  assert.equal(d.status, 404, '命中名单的商品详情必须不可读');
});

test('Product 类：名单读不到 ⇒ 公开列表拒绝返回（绝不返回未过滤的列表）', async () => {
  chainDown = true;
  const r = await request(app).get('/api/products?pageSize=10');
  assert.notEqual(r.status, 200, '读不到名单时宁可不出列表');
  assert.match(String(r.body?.message || ''), /读不到链上黑名单/);
});
