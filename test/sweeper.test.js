/**
 * 草稿订单自动超时关闭（Stage 2.1）：锁定未支付超过 TTL（默认 30 分钟）的
 * draft 被清扫为 cancelled；未超时草稿不受影响；清扫幂等。
 *
 * 判据是**数据库时钟**（`created_at` 由 MySQL 盖章，与 `CURRENT_TIMESTAMP(3)` 相减），
 * 不是应用进程的 Date.now/单调钟。这里用「把全局 Date.now 拨快/拨慢」来钉住这一点：
 * 无论应用宿主时钟怎么跳，清扫结果只由数据库里的 `created_at` 决定。
 *
 * 多后端的关键回归：一个后端**刚刚创建**的草稿（`created_at` 是此刻）不得因为
 * "另一个后端已经运行满 TTL"而被关闭——旧实现用进程 boot 区分"本轮/遗留"，
 * 多后端下会把这个后端的新草稿当遗留行误杀。现在没有 boot 判据，只有共享的 DB 时间。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, skuInv, ageDrafts, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

/** 上架商品 → 买家下单草稿，返回订单 */
async function createDraft(overrides = {}) {
  const ownerLogin = await login(ctx, owner);
  const listed = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '清扫测试商品', ...overrides }))
    .expect(200);
  assertOk(listed);
  const slug = listed.body.data.slug;
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, buyer: buyer.address })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 商品可售余量（capacity − committed）；限量占位是否回补看它 */
const availOf = async (slug) => {
  const inv = await skuInv(db, slug);
  return inv.capacity === null ? null : inv.capacity - inv.committed;
};

const orderRow = async (id) =>
  await db.get('SELECT status, created_at, updated_at, released_at FROM v_orders WHERE order_no = ?', id);

const ageDraft = async (id, ms) => await ageDrafts(db, id, ms);

const { sweepExpiredDrafts } = await import('../src/orderSweeper.js');
const { setChainOrderFetcher } = await import('../src/chainOrder.js');
// 每个 sweeper 用例自己决定链上结果；默认按"链上没有该单"构造，避免依赖其它用例的全局桩。
setChainOrderFetcher(async () => ({ status: 'None' }));

const MIN = 60_000;
const YEAR = 365 * 24 * 3600_000;

/** 在「应用宿主时钟被拨到 jumpedTo」的世界里执行 fn（只影响 Date.now，不影响 MySQL 的 NOW）。 */
async function withWallClock(jumpedTo, fn) {
  const real = Date.now;
  Date.now = () => jumpedTo;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test('近 TTL 草稿：链上已托管但本地尚未镜像时先不取消', async () => {
  const d = await createDraft();
  await ageDraft(d.id, 31 * 60_000); // 刚过默认 30 分钟 TTL，落在 2 分钟探测带
  setChainOrderFetcher(async () => ({ status: 'escrowed' }));
  try {
    assert.equal(await sweepExpiredDrafts(), 0);
    assert.equal((await orderRow(d.id)).status, 'draft');
  } finally {
    setChainOrderFetcher(async () => ({ status: 'None' }));
    // 清掉这条仍 draft 的测试行，避免后续用例把它当本轮新候选。
    await db.run("UPDATE orders SET status = 'cancelled' WHERE order_no = ?", d.id);
  }
});

test('超时草稿已有支付凭证：sweeper 不得把它当未支付草稿取消', async () => {
  const d = await createDraft();
  await ageDraft(d.id, 2 * 3600_000);
  await db.run(
    'UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)',
    '0x' + 'ab'.repeat(32),
    d.id
  );
  const closed = await sweepExpiredDrafts();
  assert.equal(closed, 0);
  assert.equal((await orderRow(d.id)).status, 'draft');
});

test('超时草稿自动关闭为 cancelled，未超时草稿保留', async () => {
  const stale = await createDraft();
  await ageDraft(stale.id, 2 * 3600_000); // 做旧 2 小时（超过默认 TTL 30 分钟）

  const fresh = await createDraft();

  const closed = await sweepExpiredDrafts();
  assert.equal(closed, 1, '只关闭超时的那一单');

  const list = await request(app)
    .get(`/api/orders?address=${buyer.address}`)
    .set('Authorization', `Bearer ${(await login(ctx, buyer)).token}`)
    .expect(200);
  assertOk(list);
  const byId = Object.fromEntries(list.body.data.orders.map((o) => [o.id, o.status]));
  assert.equal(byId[stale.id], 'cancelled', '超时草稿应为已取消');
  assert.equal(byId[fresh.id], 'draft', '新草稿不应被误杀');

  // 幂等：再次清扫无新关闭
  assert.equal(await sweepExpiredDrafts(), 0);
});

test('escrowed 及以上状态不受清扫影响（仅 draft）', async () => {
  const o = await createDraft();
  await db.run("UPDATE orders SET status = 'escrowed' WHERE order_no = ?", o.id);
  await ageDraft(o.id, 2 * 3600_000);
  assert.equal(await sweepExpiredDrafts(), 0, '已托管订单不参与草稿清扫');
});

test('应用宿主时钟向前跳一年：数据库里刚创建的草稿不得被清扫，库存占位保持', async () => {
  const o = await createDraft({ title: '向前跳测试商品', capacity: 1 });
  assert.equal(await availOf(o.productSlug), 0, '限量 1 件已被草稿占位');

  const closed = await withWallClock(Date.now() + YEAR, async () => await sweepExpiredDrafts());
  assert.equal(closed, 0, '应用墙钟向前跳不得清扫任何草稿（判据是 DB 时钟）');

  const row = await orderRow(o.id);
  assert.equal(row.status, 'draft', '草稿仍在，等着买家付款');
  assert.equal(row.released_at, null, '不得释放占位');
  assert.equal(await availOf(o.productSlug), 0, '限量库存占位必须保持（否则同一件商品可再卖一次 → 超卖）');
});

test('应用宿主时钟向后跳：数据库里已过 TTL 的草稿照样清扫并回补占位', async () => {
  const o = await createDraft({ title: '向后跳测试商品', capacity: 1 });
  assert.equal(await availOf(o.productSlug), 0, '限量 1 件已被草稿占位');
  await ageDraft(o.id, 31 * MIN);

  const realNow = Date.now();
  const closed = await withWallClock(realNow - 2 * 3600_000, async () => await sweepExpiredDrafts());
  assert.ok(closed >= 1, `DB 时间上过了 TTL 的草稿必须被清扫（实际关闭 ${closed}）`);

  const row = await orderRow(o.id);
  assert.equal(row.status, 'cancelled', '超时草稿必须收敛为已取消（不得因应用墙钟回拨而无限滞留）');
  assert.ok(row.updated_at instanceof Date, 'updated_at 是 DATETIME(3)（读回来是 Date）');
  assert.ok(
    row.updated_at.getTime() >= realNow - 60_000 && row.updated_at.getTime() <= Date.now() + 60_000,
    `updated_at 必须是数据库真实墙钟口径：实际 ${row.updated_at.toISOString()}`
  );
  assert.notEqual(row.released_at, null, '释放标记已置（幂等凭据）');
  assert.equal(await availOf(o.productSlug), 1, '占位已回补，额度可再售');
});

test('created_at 落在"未来"的草稿不会被提前清扫；拨回 TTL 之前后才清扫', async () => {
  /*
    形状：历史行/手工改过的行可能把 created_at 写成未来。判据是
    `created_at <= NOW - TTL`，未来时间不满足 ⇒ 不扫。把应用墙钟也拨到那个未来时刻
    仍然不扫（证明判据不读应用时钟）；只有数据库里的 created_at 真的过了 TTL 才扫。
  */
  const o = await createDraft({ title: '未来时间商品', capacity: 1 });
  await db.run('UPDATE orders SET created_at = created_at + INTERVAL ? MICROSECOND WHERE order_no = ?', YEAR * 1000, o.id);
  const row0 = await orderRow(o.id);
  assert.ok(row0.created_at.getTime() > Date.now() + 300 * 24 * 3600_000, '前提：created_at 已落在一年之后');

  assert.equal(await withWallClock(row0.created_at.getTime(), async () => await sweepExpiredDrafts()), 0);
  assert.equal((await orderRow(o.id)).status, 'draft', '未来时间不算过期');

  await db.run('UPDATE orders SET created_at = CURRENT_TIMESTAMP(3) - INTERVAL 31 MINUTE WHERE order_no = ?', o.id);
  const closed = await sweepExpiredDrafts();
  assert.ok(closed >= 1, 'DB 里确实过了 TTL 之后必须清扫');
  assert.equal((await orderRow(o.id)).status, 'cancelled');
  assert.equal(await availOf(o.productSlug), 1, '占位已回补');
});
