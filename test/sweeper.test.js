/**
 * 草稿订单自动超时关闭（Stage 2.1）：锁定未支付超过 TTL（默认 30 分钟）的
 * draft 被清扫为 cancelled；未超时草稿不受影响；清扫幂等。
 *
 * 另有四条「墙上时钟跳变 / 跨运行遗留」用例（防真实故障类：宿主时钟向前跳 →
 * 在途草稿被误判过期、取消掉买家正在付款的单子并提前回补限量占位 → 超卖；向后跳 →
 * 草稿无限滞留；前跳之后下单的行 created_at 落在"未来" → TTL 被静默关闭）。
 *
 * 判据取自**单调锚点**（src/monotonicClock.js）：草稿行记下创建时的进程 boot 与单调读数，
 * 同一次运行内的行用单调年龄判定（免疫墙钟跳变），跨运行的行退回墙钟比较。
 * 这些用例在「判据改回 Date.now()」「只比 created_at」「忽略 created_mono」时会分别变红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, skuInv, ageDrafts } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

/** 上架商品 → 买家下单草稿，返回订单 */
async function createDraft(overrides = {}) {
  const ownerLogin = await login(ctx, owner);
  const listed = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send(productPayload({ title: '清扫测试商品', ...overrides }))
    .expect(200);
  assertOk(listed);
  const slug = listed.body.data.slug;
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ productSlug: slug, buyer: buyer.address })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 商品可售余量（capacity − committed）；限量占位是否回补看它 */
const availOf = (slug) => {
  const inv = skuInv(db, slug);
  return inv.capacity === null ? null : inv.capacity - inv.committed;
};

const orderRow = (id) =>
  db
    .prepare('SELECT status, created_at, updated_at, created_boot, created_mono, released_at FROM orders WHERE id = ?')
    .get(id);

/**
 * 把一单"做旧" ms 毫秒（共享实现见 setup.mjs）：同时回拨 created_at（墙钟口径）与
 * created_mono（单调锚点）。清扫判据对**本次运行创建的行**只看 created_mono，
 * 所以做旧必须动它——只改 created_at 的旧写法在新判据下不再等于"这单很老"。
 */
const ageDraft = (id, ms) => ageDrafts(db, id, ms);

const { sweepExpiredDrafts } = await import('../src/orderSweeper.js');
const { createClock, bootId } = await import('../src/monotonicClock.js');

const MIN = 60_000;
const YEAR = 365 * 24 * 3600_000;
const PREV_BOOT = 'boot-of-previous-run';

/**
 * 假时间源（与 test/monotonicClock.test.js 同形）：墙钟与单调钟各自手动推进。
 * 基准取此刻真实墙钟，这样订单行里的单调锚点（`monotonicNow()`，与 Date.now() 同口径）
 * 与新时钟可比。**注意 `performance.now()` 不受 `Date.now` 补丁影响**，所以
 * `withWallClock` 期间创建的草稿会得到「created_at 已被跳变污染、created_mono 仍真实」
 * 的形状——这正是墙钟跳变之后下单的真实形状。
 */
function fakeTime() {
  const s = { wall: Date.now(), mono: 0 };
  return { s, wallNow: () => s.wall, monoNow: () => s.mono };
}

/**
 * 在「墙上时钟已被跳到 jumpedTo」的世界里执行 fn（同步或异步）：临时把全局 Date.now 换成
 * 跳变后的读数。这样即便有人把清扫判据改回 Date.now()（回归），本文件的跳变用例也会变红——
 * 被清扫/未被清扫的结果必须由**单调锚点**决定，而不是由跑测试这台机器的真实墙钟决定。
 */
async function withWallClock(jumpedTo, fn) {
  const real = Date.now;
  Date.now = () => jumpedTo;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test('超时草稿自动关闭为 cancelled，未超时草稿保留', async () => {
  const stale = await createDraft();
  ageDraft(stale.id, 2 * 3600_000); // 做旧 2 小时（超过默认 TTL 30 分钟）

  const fresh = await createDraft();

  const closed = sweepExpiredDrafts();
  assert.equal(closed, 1, '只关闭超时的那一单');

  const list = await request(app)
    .get(`/api/orders?address=${buyer.address}`)
    .expect(200);
  assertOk(list);
  const byId = Object.fromEntries(list.body.data.orders.map((o) => [o.id, o.status]));
  assert.equal(byId[stale.id], 'cancelled', '超时草稿应为已取消');
  assert.equal(byId[fresh.id], 'draft', '新草稿不应被误杀');

  // 幂等：再次清扫无新关闭
  assert.equal(sweepExpiredDrafts(), 0);
});

test('escrowed 及以上状态不受清扫影响（仅 draft）', async () => {
  const o = await createDraft();
  db.prepare("UPDATE orders SET status = 'escrowed' WHERE id = ?").run(o.id);
  ageDraft(o.id, 2 * 3600_000);
  assert.equal(sweepExpiredDrafts(), 0, '已托管订单不参与草稿清扫');
});

test('墙钟向前跳一年：单调意义上只过 5 分钟的新草稿不得被清扫，库存占位保持', async () => {
  const o = await createDraft({ title: '向前跳测试商品', capacity: 1 });
  assert.equal(availOf(o.productSlug), 0, '限量 1 件已被草稿占位');

  const src = fakeTime();
  const clock = createClock(src);
  src.s.mono += 5 * MIN; // 单调：真的只过了 5 分钟（< TTL 30 分钟）
  src.s.wall += YEAR; // 墙钟：向前跳一年（NTP step / 快照恢复 / 运维手改时间）

  // 关键：判据必须由单调锚点决定 ⇒ 这一轮不得关掉任何草稿
  const closed = await withWallClock(src.s.wall, () => sweepExpiredDrafts({ now: () => clock.now() }));
  assert.equal(closed, 0, '墙钟向前跳不得清扫任何草稿（否则在途付款单被误取消）');

  const row = orderRow(o.id);
  assert.equal(row.status, 'draft', '草稿仍在，等着买家付款');
  assert.equal(row.released_at, null, '不得释放占位');
  assert.equal(availOf(o.productSlug), 0, '限量库存占位必须保持（否则同一件商品可再卖一次 → 超卖）');
});

test('墙钟向后跳：单调意义上已过 TTL 的草稿照样清扫并回补占位', async () => {
  const o = await createDraft({ title: '向后跳测试商品', capacity: 1 });
  assert.equal(availOf(o.productSlug), 0, '限量 1 件已被草稿占位');

  const src = fakeTime();
  const clock = createClock(src);
  src.s.mono += 31 * MIN; // 单调：真的过了 TTL（30 分钟）+ 1 分钟
  src.s.wall -= 2 * 3600_000; // 墙钟：向后跳 2 小时（纯墙钟判据下这一单会一直不清扫）

  const wallAtSweep = src.s.wall;
  const closed = await withWallClock(wallAtSweep, () => sweepExpiredDrafts({ now: () => clock.now() }));
  assert.ok(closed >= 1, `单调意义上过了 TTL 的草稿必须被清扫（实际关闭 ${closed}）`);

  const row = orderRow(o.id);
  assert.equal(row.status, 'cancelled', '超时草稿必须收敛为已取消（不得因墙钟回拨而无限滞留）');
  /*
    `updated_at` 写的是**墙钟**（Date.now()），不是判据用的单调读数 —— 这是刻意的分工：
    该列是全库公认的墙上时间列（PII 保留期锚点 COALESCE(pii_erased_at, updated_at)、
    对账 min-age、报表分窗都拿它与"此刻的墙钟"相减），写单调值会让它与其它行、与消费者用的
    now 不同源，而 PII 保留期是**不可逆**动作——宁可让它按墙钟看"还没到期"，也不要提前擦。
  */
  assert.equal(row.updated_at, wallAtSweep, 'updated_at 必须仍是墙钟口径（不是判据用的单调读数）');
  assert.notEqual(row.released_at, null, '释放标记已置（幂等凭据）');
  assert.equal(availOf(o.productSlug), 1, '占位已回补，额度可再售');
});

test('前跳之后下单的草稿：created_at 落在"未来"，仍按单调年龄到期（TTL 不得被静默关闭）', async () => {
  // 跳变之后下单的真实形状：created_at 被跳变污染（比单调时间线快一年），created_mono 仍真实
  const jumpedWall = Date.now() + YEAR;
  const o = await withWallClock(jumpedWall, () => createDraft({ title: '前跳后下单商品', capacity: 1 }));
  const row0 = orderRow(o.id);
  assert.equal(row0.created_at, jumpedWall, '前提：created_at 已落在单调时间线的一年之后');
  assert.ok(row0.created_mono < jumpedWall, '前提：created_mono 不受墙钟跳变影响（仍在本时间线）');

  const src = fakeTime();
  const clock = createClock(src);
  src.s.mono += 31 * MIN; // 单调：真的过了 TTL + 1 分钟
  const closed = await withWallClock(jumpedWall, () => sweepExpiredDrafts({ now: () => clock.now() }));

  assert.ok(closed >= 1, '前跳后创建的草稿必须照样按单调年龄到期（否则草稿 TTL 等于被静默关闭）');
  assert.equal(orderRow(o.id).status, 'cancelled');
  assert.equal(availOf(o.productSlug), 1, '占位已回补');
});

test('跨运行遗留的草稿（boot 不同）：只认"可证明的年龄下界"，绝不退回墙钟（**推翻了旧断言**）', async () => {
  const oldOne = await createDraft({ title: '上次运行遗留·老', capacity: 1 });
  const newOne = await createDraft({ title: '上次运行遗留·新', capacity: 1 });
  assert.notEqual(PREV_BOOT, bootId, '前提：注入的 boot 必须与当前进程不同');
  db.prepare('UPDATE orders SET created_boot = ? WHERE id IN (?, ?)').run(PREV_BOOT, oldOne.id, newOne.id);
  // 墙钟把它说成"两小时前"——跨运行的 created_at 不具备可比性（可能被跳变污染），这正是旧判据的危险处
  db.prepare('UPDATE orders SET created_at = created_at - ? WHERE id = ?').run(2 * 3600_000, oldOne.id);

  const src = fakeTime();
  const clock = createClock(src);
  const bootStart = clock.now();

  /*
    ① 本进程刚起来（单调运行 5 分钟 < TTL 30 分钟）⇒ 这一行没有**可证明**的年龄下界。
    旧实现在这里用墙钟比，于是墙钟跳变之后重启可能误关**正在付款**的草稿并提前回补占位（⇒ 超卖）。
    2026-10 生产化清理后：读不到年龄就不判过期，本轮跳过并告警。
  */
  src.s.mono += 5 * MIN;
  sweepExpiredDrafts({ now: () => clock.now(), boot: bootId, bootStart });
  assert.equal(orderRow(oldOne.id).status, 'draft', '墙钟说它老不作数：没有可证明的下界就不扫');
  assert.equal(orderRow(newOne.id).status, 'draft');

  // ② 本进程已单调运行 31 分钟 ≥ TTL ⇒ 下界成立（"这行至少在进程启动前就存在，而进程已活了 > TTL"）⇒ 关闭
  src.s.mono += 26 * MIN;
  const closed = sweepExpiredDrafts({ now: () => clock.now(), boot: bootId, bootStart });
  assert.ok(closed >= 1, `进程运行满 TTL 后遗留行必须被清扫（实际关闭 ${closed}）`);
  assert.equal(orderRow(oldOne.id).status, 'cancelled');
  assert.equal(availOf(oldOne.productSlug), 1, '占位已回补，额度可再售');
  /*
    代价如实钉住：下界是**本进程运行时长**（所有遗留行共享），所以同一批遗留行会在满 TTL 的
    那一轮**一起**收敛——包括这一单"新的"。换来的是"任何一次关闭都建立在'这一行确实老过 TTL'
    的证明上"，而不是"墙钟说它老"；最多晚一个 TTL，不会滞留。见 src/orderSweeper.js 文件头。
  */
  assert.equal(orderRow(newOne.id).status, 'cancelled', '同批遗留行共享下界 ⇒ 同轮收敛（刻意的代价）');
});
