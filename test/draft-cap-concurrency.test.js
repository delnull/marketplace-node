/**
 * 「免费草稿锁库存」两道闸的**并发原子性**（2026-09 源码评审修复的回归网）。
 *
 * 背景：这两道闸（同买家活跃草稿 ≤10、同买家同商品草稿占用合计 ≤99）原先读在 `txBegin()` **之前**，
 * 而它们的"读计数"与后面的"插单"之间隔着 `await checkOrderGate(...)`——一次外部外呼。
 * Node 是单线程，但 `await` 会让出执行权：15 个并发请求会**全部**在各自插入之前读到同一份旧计数，
 * 于是两道闸同时失效（本意"单地址同商品最多锁 99 件"实际可以被打成群）。
 * 修法是把闸移进事务（读计数 + 插单在同一段同步代码里），由 SQLite 单写者串行保证原子。
 *
 * 为什么这个文件必须存在：既有的草稿上限用例是**串行**发请求的（`for` + `await`），
 * 那种写法下旧实现也"恰好对"——**它证明不了闸在并发下有效**。这里用一次性并发提交来证伪，
 * 并断言"恰好 N 个成功"这种只有原子化才成立的边界值。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { assertOk, login, makeCtx, productPayload, skuInv } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

let ownerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  assert.ok(ownerToken);
});

/** 上架商品（owner），返回产物 */
async function listProduct(payload) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(payload)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 一次性并发提交 n 个下单请求（**不 await 单个**：让它们在 checkOrderGate 的 await 处交错） */
function burstDrafts(slug, buyerAddr, { n, quantity = 1 }) {
  return Promise.all(
    Array.from({ length: n }, () =>
      request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ productSlug: slug, quantity, buyer: buyerAddr })
        .expect(200)
        .then((r) => r.body)
    )
  );
}

const draftRows = (buyerAddr) =>
  db
    .prepare("SELECT id, quantity FROM orders WHERE buyer = ? AND status = 'draft'")
    .all(String(buyerAddr).toLowerCase());

test('并发下单：同买家活跃草稿上限恰好 10 张（闸在事务内才拦得住）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '并发草稿上限商品', capacity: 500 }));
  const heavy = Wallet.createRandom();

  // 15 个并发请求；没有风控服务时 checkOrderGate 立即返回，但**仍是 await**（会交错）
  const bodies = await burstDrafts(p.slug, heavy.address, { n: 15 });
  const ok = bodies.filter((b) => b.code === 0).length;
  const rejected = bodies.filter((b) => b.code !== 0);

  assert.equal(ok, 10, `并发下同买家只能有 10 张活跃草稿（实际成功 ${ok}）`);
  assert.equal(draftRows(heavy.address).length, 10, '库里的 draft 行数必须与成功数一致（不多不少）');
  assert.match(
    rejected.map((b) => b.message).join(' '),
    /草稿过多/,
    '被拒的必须是"草稿过多"这条闸（而不是库存/风控等别的拒绝）'
  );
});

test('并发下单：同买家同商品草稿占用合计不超过 99 件（边界只在原子化时成立）', async () => {
  // capacity 500 让"合计 99"这一步先于商品库存触顶（本用例只测草稿的合计闸）
  const p = await listProduct(productPayload({ kind: 'physical', title: '并发草稿合计商品', capacity: 500 }));
  const heavy = Wallet.createRandom();

  // 6 个并发请求各 20 件：只有 4 个能过（80 ≤ 99；第 5 个 100 > 99）
  const bodies = await burstDrafts(p.slug, heavy.address, { n: 6, quantity: 20 });
  const ok = bodies.filter((b) => b.code === 0).length;
  const rows = draftRows(heavy.address);
  const units = rows.reduce((s, r) => s + Number(r.quantity || 0), 0);

  assert.equal(ok, 4, `6×20 件并发下只能成功 4 单（实际成功 ${ok}）`);
  assert.equal(units, 80, `草稿占用合计必须是 80（实际 ${units}）`);
  assert.ok(units <= 99, '合计不得超过 99 件——这是该闸存在的全部意义');
  // 库存占位必须与草稿占用同步（置位与释放都走 stockHold 的单点契约）
  const inv = skuInv(db, p.slug);
  assert.equal(Number(inv.committed), 80, `限量占位应与草稿占用一致（实际 ${inv.committed}）`);
  assert.match(
    bodies
      .filter((b) => b.code !== 0)
      .map((b) => b.message)
      .join(' '),
    /合计已达/,
    '被拒的必须是"合计已达 N/99"这条闸'
  );
});
