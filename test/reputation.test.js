/**
 * 店铺履约画像端点（/api/shop/reputation，链下信誉索引）：
 *  - 集成：造 9 单覆盖全部终局（确认/超时/判买家/判卖家/未决争议 + 500 天前老单），
 *    断言四时间窗事件计数、比率（4 位小数）、发货中位数与样本阈值（争议 5 ≥ 5 正常出率）；
 *  - 单元：computeReputation 纯函数喂小样本（争议 <5）断言争议相关率置 null + sampleTooSmall，
 *    并验证中位数（偶数均值）与 0 争议/空库边界。
 * 状态推进不经真实链上（单测无 RPC）——与 watcher/仲裁测试同款：直调 applyEvent。
 */
import { test, before } from 'node:test';

/** 全额退款事件参数（Escrow.Arbitrated/RefundApproved 现带 refundWei）：测试内订单金额恒为 1e18 */
const FULL_REFUND = '1000000000000000000';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef, insertOrder as insertOrderRow } from './setup.mjs';

const ctx = await makeCtx();
const { app, db, owner, buyer } = ctx;

let ownerToken;
let buyerToken;
let slug;

const { applyEvent } = await import('../src/escrowWatcher.js');
const { computeReputation, reputationSummary } = await import('../src/reputation.js');
const { default: appConfig } = await import('../src/config.js');

const DAY_MS = 24 * 3600 * 1000;

// 每单一个独立买家地址造单（v2 无防重，此处仅保持事件序列清晰可数）
const buyerAddrs = Array.from({ length: 9 }, () => Wallet.createRandom().address);
// 模拟链上规范哈希：OrderCreated 事件必带交易哈希（watcher 回写落为支付凭证，发货防呆要求）
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

/** 造单后按事件序列推进（OrderCreated 先行，其余按序）；店主代买家下单 */
async function createOrder(buyerAddr) {
  const res = await ctx.request(ctx.app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, buyer: buyerAddr })
    .expect(200);
  assertOk(res);
  return res.body.data;
}
async function ev(order, name, args = {}, meta = {}) {
  // 真实链上事件必然带交易哈希：OrderCreated 一并落为支付凭证（与 watcher 回写语义一致）
  const m = name === 'OrderCreated' ? { txHash: payHash(), block: 1, ...meta } : meta;
  assert.equal(await applyEvent(name, { orderId: order.escrowOrderId, ...args }, m), 1, `${name} 应推进`);
}
async function ship(order) {
  const res = await ctx.request(ctx.app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ deliveryCode: 'REP-CODE' })
    .expect(200);
  assertOk(res);
}

/** 把订单事件史的时刻整体前移（模拟历史单：只进 all 窗不进 d365/d90/d30） */
async function backdate(order, days) {
  const row = await db.get('SELECT onchain_events FROM v_orders WHERE order_no = ?', order.id);
  const list = (row.onchain_events || []).map((e) => ({ ...e, at: e.at - days * DAY_MS }));
  await db.run('UPDATE order_chain SET events = ? WHERE order_id = (SELECT id FROM orders WHERE order_no = ?)', JSON.stringify(list), order.id);
}

// ── 顶层 before 需串行完成登录与造单（node:test 多个顶层 before 存在并发交错，见仓库测试惯例）──
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  assert.ok(ownerToken && buyerToken);

  const listed = await ctx.request(ctx.app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'digital', title: '信誉-画像样本', capacity: null }))
    .expect(200);
  assertOk(listed);
  slug = listed.body.data.slug;

  // 近窗 8 单（d30/d90/d365 同口径）
  const t1 = await createOrder(buyerAddrs[0]); await ev(t1, 'OrderCreated'); await ev(t1, 'ReceiptConfirmed'); // 买家确认
  const t2 = await createOrder(buyerAddrs[1]); await ev(t2, 'OrderCreated'); await ship(t2); await ev(t2, 'ReceiptConfirmed'); // 已交付后确认（发货样本）
  const t3 = await createOrder(buyerAddrs[2]); await ev(t3, 'OrderCreated'); await ev(t3, 'DisputeRequested'); await ev(t3, 'Arbitrated', { refundWei: t3.amountWei }); // 判买家
  const t4 = await createOrder(buyerAddrs[3]); await ev(t4, 'OrderCreated'); await ship(t4); await ev(t4, 'DisputeRequested'); await ev(t4, 'Arbitrated', { refundWei: 0n }); // 判卖家（样本）
  const t5 = await createOrder(buyerAddrs[4]); await ev(t5, 'OrderCreated'); await ev(t5, 'OrderExpiredReleased'); // 超时释放
  const t6 = await createOrder(buyerAddrs[5]); await ev(t6, 'OrderCreated'); await ev(t6, 'DisputeRequested'); // 未裁决争议
  const t7 = await createOrder(buyerAddrs[6]); await ev(t7, 'OrderCreated'); await ev(t7, 'ReceiptConfirmed'); await backdate(t7, 500); // 老单：仅进 all
  const t8 = await createOrder(buyerAddrs[7]); await ev(t8, 'OrderCreated'); await ev(t8, 'DisputeRequested'); await ev(t8, 'Arbitrated', { refundWei: t8.amountWei }); // 判买家 #2
  const t9 = await createOrder(buyerAddrs[8]); await ev(t9, 'OrderCreated'); await ship(t9); await ev(t9, 'DisputeRequested'); await ev(t9, 'Arbitrated', { refundWei: 0n }); // 判卖家 #2（样本）
  void t1; void t2; void t5; void t6; void t7; void t8; void t9;
});

async function reputation() {
  const res = await ctx.request(ctx.app).get('/api/shop/reputation').expect(200);
  assertOk(res);
  return res.body.data;
}

test('履约画像：近窗事件计数与比率全对（5 争议 ≥ 样本阈值正常出率）', async () => {
  const r = await reputation();
  const w = r.windows.d30;

  // 近窗 8 单：确认 2、超时 1、争议 5（判买家 2 / 判卖家 2 / 未决 1）
  assert.equal(w.orders, 8);
  assert.equal(w.confirmed, 2);
  assert.equal(w.timeouts, 1);
  assert.equal(w.disputes, 5);
  assert.equal(w.settledToSeller, 2, '判卖家 2（终局 settled 反推）');
  assert.equal(w.refundedToBuyer, 2, '判买家 2（终局 refunded 反推）');
  assert.equal(w.sampleTooSmall, false, '5 争议达样本阈值');
  assert.equal(w.confirmRate, 0.25);
  assert.equal(w.timeoutRate, 0.125);
  assert.equal(w.disputeRate, 0.625, '5/8');
  assert.equal(w.refundRate, 0.4, '判买家 2/5（卖家过错近似）');

  // d30/d90/d365 口径一致（老单 500 天前只进 all）
  assert.equal(r.windows.d90.orders, 8);
  assert.equal(r.windows.d365.orders, 8);
  assert.equal(r.windows.all.orders, 9, 'all 含 500 天前老单');
  assert.equal(r.windows.all.confirmed, 3);
  assert.equal(r.windows.all.confirmRate, 0.3333, '3/9 舍入 4 位小数');
  assert.equal(r.windows.all.refundRate, 0.4);

  /*
    重复交易对信号也随响应下发（端点走 reputationSummary，buyer/seller 两列必须真的被查出来——
    少一列的话这里会静默变成"0 个交易对 / 全无重复"）。本 fixture 每单一个独立买家地址 ⇒ 无重复。
  */
  assert.equal(w.sybil.distinctPairs, 8, '近窗 8 单 = 8 个不同交易对（各买家各一单）');
  assert.equal(w.sybil.repeatOrders, 0);
  assert.equal(w.sybil.repeatPairShare, 0, '样本够且确实没有重复 ⇒ 0（不是 null）');
  assert.equal(r.windows.all.sybil.distinctPairs, 9, 'all 含 500 天前老单（另一个买家）');

  // 发货耗时（本地账 ⚠）：3 单有交付记录（t2/t4/t9），中位数为非负毫秒数
  assert.equal(r.delivery.d30.count, 3);
  assert.equal(typeof r.delivery.d30.medianMs, 'number');
  assert.ok(r.delivery.d30.medianMs >= 0);
  assert.equal(r.delivery.all.count, 3, '老单无交付记录不进入样本');

  // 运营起点：最早 OrderCreated（老单前移后）
  // `firstOrderAt` 对外是 **ISO-8601 串**（全仓只有这一种时刻表示），比较前先 Date.parse；
  // 直接拿字符串与数字比会恒假——那种"形状变了而断言没变"在别处表现为静默的假绿，这里表现为假红。
  assert.ok(Date.parse(r.firstOrderAt) <= Date.now() - 400 * DAY_MS, 'firstOrderAt 来自最早托管事件');

  // 隐私口径：不下发单笔订单字段
  assert.ok(!('orders' in r), '顶层不得直接挂订单列表');
  assert.ok(r.note && r.note.length > 0, '口径诚实标注（数据源/可审计性）');
});

test('单元：paid 快路径订单（OrderCreated 由 paid 补写）参与单量/确认率统计', async () => {
  const now = Date.now();
  // 真实可达的行都带链上支付凭证（paid_tx_hash）——画像是**按它证明托管发生过**的（2026-10-15）
  const mk = (status, events, over = {}) => ({ status, delivered_at: null, paid_tx_hash: '0x' + 'ab'.repeat(32), created_at: 1, onchain_events: events, ...over });
  const e = (name, at) => ({ name, txHash: '0x' + 'f'.repeat(64), block: 1, at });
  // paid 快路径（watcher 不迁移该单）：OrderCreated 由 paid/sync 补写（见 orders.js
  // appendOrderCreatedEvent），ReceiptConfirmed 由 watcher 回写——两事件齐全才能计单
  const r = computeReputation([
    mk('confirmed', [e('OrderCreated', now - 2000), e('ReceiptConfirmed', now - 1000)]),
    mk('confirmed', [e('OrderCreated', now - 1500), e('ReceiptConfirmed', now - 500)]),
  ], now);
  assert.equal(r.windows.all.orders, 2, '补写后订单基数完整');
  assert.equal(r.windows.all.confirmed, 2);
  assert.equal(r.windows.all.confirmRate, 1, '2/2');
  assert.equal(r.windows.d30.orders, 2, '事件时刻均在近窗');
});

test('单元：争议 <5 样本不足时争议率/判买家率置 null（防小样本误导）', async () => {
  const now = Date.now();
  const mk = (status, events, delivered_at = null) => ({
    status,
    delivered_at,
    // 托管证明（画像按它计入单量，见 computeReputation 的说明）+ OrderCreated 被挤掉时的锚点兜底
    paid_tx_hash: '0x' + 'ab'.repeat(32),
    created_at: 1,
    onchain_events: events,
  });
  const e = (name, at) => ({ name, txHash: null, block: null, at });

  // 3 单：1 确认 + 2 争议（1 判买家 1 未决）→ 争议样本不足
  const small = computeReputation([
    mk('confirmed', [e('OrderCreated', now - 1000), e('ReceiptConfirmed', now - 500)]),
    mk('disputed', [e('OrderCreated', now - 900), e('DisputeRequested', now - 400)]),
    mk('refunded', [
      e('OrderCreated', now - 800),
      e('DisputeRequested', now - 300),
      e('Arbitrated', now - 200),
    ]),
  ], now);
  assert.equal(small.windows.all.orders, 3);
  assert.equal(small.windows.all.disputes, 2);
  assert.equal(small.windows.all.sampleTooSmall, true);
  assert.equal(small.windows.all.disputeRate, null, '争议率隐藏');
  assert.equal(small.windows.all.refundRate, null, '判买家率隐藏');
  assert.equal(small.windows.all.confirmRate, 0.3333, '1/3 舍入 4 位小数——非争议指标不受样本阈值影响');
  assert.equal(small.windows.all.refundedToBuyer, 1, '原始计数仍输出（供前端标注 n 笔）');
});

test('单元：中位数（偶数均值）与 0 争议/空库/无事件行边界', async () => {
  const now = Date.now();
  const e = (name, at) => ({ name, txHash: null, block: null, at });

  // 发货样本 1000ms 与 3000ms → 中位数 2000ms（偶数均值）
  const rows = [
    {
      status: 'confirmed',
      delivered_at: now - 1000,
      paid_tx_hash: '0x' + 'ab'.repeat(32),
      created_at: now - 2000,
      onchain_events: [e('OrderCreated', now - 2000), e('ReceiptConfirmed', now - 1000)],
    },
    {
      status: 'confirmed',
      delivered_at: now - 3000,
      paid_tx_hash: '0x' + 'ab'.repeat(32),
      created_at: now - 6000,
      onchain_events: [e('OrderCreated', now - 6000), e('ReceiptConfirmed', now - 3000)],
    },
  ];
  const r = computeReputation(rows, now);
  assert.equal(r.delivery.all.count, 2);
  assert.equal(r.delivery.all.medianMs, 2000);
  assert.equal(r.delivery.d30.count, 2, '交付在近窗内');

  // 分窗归属：交付于 40 天前 → 只进 all 不进 d30（与事件分窗同规则）
  const old = computeReputation(
    [
      {
        status: 'confirmed',
        delivered_at: now - 40 * DAY_MS,
        paid_tx_hash: '0x' + 'ab'.repeat(32),
        created_at: now - 50 * DAY_MS,
        onchain_events: [e('OrderCreated', now - 50 * DAY_MS), e('ReceiptConfirmed', now - 40 * DAY_MS)],
      },
    ],
    now
  );
  assert.equal(old.delivery.all.count, 1);
  assert.equal(old.delivery.d30.count, 0, '老交付不进 d30');
  assert.equal(old.delivery.d30.medianMs, null);

  // 0 争议 = 健康而非样本问题：disputeRate 0、refundRate null（无争议可判）
  const clean = computeReputation([
    {
      status: 'confirmed',
      delivered_at: null,
      paid_tx_hash: '0x' + 'ab'.repeat(32),
      created_at: now - 1000,
      onchain_events: [e('OrderCreated', now - 1000), e('ReceiptConfirmed', now - 500)],
    },
  ], now);
  assert.equal(clean.windows.all.disputes, 0);
  assert.equal(clean.windows.all.sampleTooSmall, false);
  assert.equal(clean.windows.all.disputeRate, 0);
  assert.equal(clean.windows.all.refundRate, null);

  // 空库 / 无链上事件行（草稿/取消）：零输出不报错
  const empty = computeReputation([], now);
  assert.equal(empty.windows.all.orders, 0);
  assert.equal(empty.firstOrderAt, null);
  assert.equal(empty.delivery.all.medianMs, null);
  const drafts = computeReputation([{ status: 'draft', delivered_at: null, onchain_events: [] }], now);
  assert.equal(drafts.windows.all.orders, 0);
});

/* ══════════════════════════════════════════════════════════════════════
   重复交易对（女巫）信号：同一 buyer↔seller 交易对的重复成交占总成交的比例。
   它是**可疑信号、不是结论**（真实复购与刷量在数据上完全同形），所以本用例只钉
   "口径可算、可复算、小样本不输出"，不钉任何"判定刷量"的行为。
   ══════════════════════════════════════════════════════════════════════ */

test('单元：重复交易对占比 =（总成交 − 不同交易对数）/ 总成交；小样本置 null 而非 0', () => {
  const now = Date.now();
  const e = (name, at) => ({ name, txHash: null, block: null, at });
  const row = (buyer, seller, at) => ({
    status: 'confirmed',
    buyer,
    seller,
    delivered_at: null,
    paid_tx_hash: '0x' + 'ab'.repeat(32),
    created_at: at,
    onchain_events: [e('OrderCreated', at), e('ReceiptConfirmed', at + 10)],
  });
  const A = '0x' + 'aa'.repeat(20);
  const B = '0x' + 'bb'.repeat(20);
  const row3 = '0x' + 'dd'.repeat(20);
  const SHOP = '0x' + 'cc'.repeat(20);

  // 6 单：A 买 4 次、B 买 1 次、C 买 1 次 → 不同交易对 3、重复成交 3（A 的第 2~4 笔）
  const r = computeReputation(
    [
      row(A, SHOP, now - 6000),
      row(A, SHOP, now - 5000),
      row(A, SHOP, now - 4000),
      row(A, SHOP, now - 3000),
      row(B, SHOP, now - 2000),
      row(row3, SHOP, now - 1000),
    ],
    now
  );
  const s = r.windows.all.sybil;
  assert.equal(r.windows.all.orders, 6);
  assert.equal(s.distinctPairs, 3, '同一买家 + 同一家店 = 同一个交易对');
  assert.equal(s.repeatOrders, 3, '6 单 − 3 对 = 第 2 笔及以后的 3 笔');
  assert.equal(s.repeatPairShare, 0.5, '3/6');
  assert.equal(s.topPairShare, 0.6667, '最大的一对占 4/6（集中度，4 位小数）');
  assert.equal(s.sampleTooSmall, false);
  // 口径诚实标注：它是信号不是结论，且说明可由第三方扫链复算
  assert.match(r.sybilNote, /可疑信号/);
  assert.match(r.sybilNote, /OrderCreated/);

  // 每个买家各买一次（无重复）→ 重复成交 0、比率 0（**不是 null**：样本够但确实没有重复）
  const clean = computeReputation(
    [row(A, SHOP, now - 6000), row(B, SHOP, now - 5000), row('0x' + 'dd'.repeat(20), SHOP, now - 4000)],
    now
  );
  assert.equal(clean.windows.all.sybil.repeatOrders, 0);

  // 小样本（<5 单）：比率置 null（"3 单里 2 单同一个人"读起来像 67% 的异常，其实什么都说明不了）
  const tiny = computeReputation([row(A, SHOP, now - 2000), row(A, SHOP, now - 1000)], now);
  assert.equal(tiny.windows.all.orders, 2);
  assert.equal(tiny.windows.all.sybil.sampleTooSmall, true);
  assert.equal(tiny.windows.all.sybil.repeatPairShare, null);
  assert.equal(tiny.windows.all.sybil.topPairShare, null);
  assert.equal(tiny.windows.all.sybil.distinctPairs, 1, '原始计数照常输出（读者可自行判断）');

  // 分窗同源：交易对计数与成交计数归属同一个窗（老单不进 d30）
  const old = computeReputation(
    [row(A, SHOP, now - 400 * DAY_MS), row(A, SHOP, now - 400 * DAY_MS + 10), row(B, SHOP, now - 400 * DAY_MS + 20)],
    now
  );
  assert.equal(old.windows.all.sybil.repeatOrders, 1);
  assert.equal(old.windows.d30.orders, 0);
  assert.equal(old.windows.d30.sybil.repeatOrders, 0, '分子分母同源：窗外单不会在窗内冒出重复笔数');
});

/* ══════════════════════════════════════════════════════════════════════
   争议口径：**一个判据、两个消费方**（2026-10-15 修 D1/D2）
   ──────────────────────────────────────────────────────────────────────
   病：公开画像只在事件名恰好是 `DisputeRequested` 时计争议，而镜像会被 `/sync` 与后台对账
   按链上真值修好（那一路写的事件名是 `Sync:disputed`）⇒ 争议读成 0；同一时刻 buyerSignal
   用"状态 ∨ 事件"读出 7 单 —— 同一批单两个答案。且判向计数是按**行**数的、分母是按**事件**
   数的，混合口径能算出 `refundRate = 1.4`（公开页会印「争议 5 笔中判买家 7 笔」）。
   药：判据收进 `orderFacts.rowEverDisputed`（状态 ∨ DisputeRequested ∨ Arbitrated），
   两处共用；分子分母都以**本行**为单位。
   ══════════════════════════════════════════════════════════════════════ */

test('争议计数：被 /sync 或对账修好的争议（事件名 Sync:disputed）也必须计入', async () => {
  const now = Date.now();
  const e = (name, at) => ({ name, txHash: null, block: null, at });
  // 真实可达的行都带链上支付凭证（paid_tx_hash）——画像是**按它证明托管发生过**的（2026-10-15）
  const mk = (status, events, over = {}) => ({ status, delivered_at: null, paid_tx_hash: '0x' + 'ab'.repeat(32), created_at: 1, onchain_events: events, ...over });
  /*
    5 单争议：镜像 status='disputed'、事件史里**没有** DisputeRequested（只有 Sync:disputed 这种修复痕迹）。
    旧实现给 disputes=0 且 sampleTooSmall=false ⇒ 公开页印「争议率 0%」——一个**看起来确证的健康 0**。
  */
  const rows = [
    mk('disputed', [e('OrderCreated', now - 5000), e('Sync:disputed', now - 4000)]),
    mk('disputed', [e('OrderCreated', now - 4900), e('Sync:disputed', now - 3900)]),
    mk('disputed', [e('OrderCreated', now - 4800), e('Sync:disputed', now - 3800)]),
    mk('disputed', [e('OrderCreated', now - 4700), e('Sync:disputed', now - 3700)]),
    mk('disputed', [e('OrderCreated', now - 4600), e('Sync:disputed', now - 3600)]),
  ];
  const r = computeReputation(rows, now);
  assert.equal(r.windows.all.disputes, 5, '状态为 disputed 的单必须计入争议（不许因为事件名不同就漏掉）');
  assert.equal(r.windows.all.disputeRate, 1, '5/5');
  assert.equal(r.windows.all.sampleTooSmall, false, '这 5 单是确证发生过争议，不该被当成"样本不足"');
});

test('判向比率：分子分母同源 ⇒ refundRate ≤ 1（不再出现"争议 5 笔中判买家 7 笔"）', async () => {
  const now = Date.now();
  const e = (name, at) => ({ name, txHash: null, block: null, at });
  // 真实可达的行都带链上支付凭证（paid_tx_hash）——画像是**按它证明托管发生过**的（2026-10-15）
  const mk = (status, events, over = {}) => ({ status, delivered_at: null, paid_tx_hash: '0x' + 'ab'.repeat(32), created_at: 1, onchain_events: events, ...over });
  const rows = [
    // 7 单"有 Arbitrated、但没有 DisputeRequested"（事件被挤掉/漏扫后镜像推进到 refunded）
    ...Array.from({ length: 7 }, (_, i) =>
      mk('refunded', [e('OrderCreated', now - 5000 + i), e('Arbitrated', now - 4000 + i)])
    ),
    // 另加 5 单正常争议，把事件口径的分母抬过小样本阈值
    ...Array.from({ length: 5 }, (_, i) =>
      mk('disputed', [e('OrderCreated', now - 3000 + i), e('DisputeRequested', now - 2000 + i)])
    ),
  ];
  const w = computeReputation(rows, now).windows.all;
  assert.equal(w.disputes, 12, '7 单仲裁 + 5 单在途争议 = 12 单"争过"');
  assert.equal(w.refundedToBuyer, 7);
  assert.ok(w.refundRate !== null && w.refundRate <= 1, `判买家率必须 ≤ 1（实际 ${w.refundRate}）`);
  assert.ok(
    w.refundedToBuyer + w.settledToSeller <= w.disputes,
    '判向计数是分母的子集——分子不许脱离分母（这正是旧口径算出 1.4 的原因）'
  );
});

test('托管证明是耐久凭据：OrderCreated 被 20 条可重复事件挤掉，这一单也不会从画像里消失', async () => {
  const now = Date.now();
  const e = (name, at) => ({ name, txHash: null, block: null, at });
  const mk = (status, events, over = {}) => ({ status, delivered_at: null, paid_tx_hash: '0x' + 'ab'.repeat(32), created_at: 1, onchain_events: events, ...over });
  /*
    病（2026-10-15 审计 D3）：`onchain_events` 只留最近 20 条（`slice(-20)`），
    而 `PartialRefundAccepted` 是**可重复**事件（买家每授权一次记一条）——20 次授权即可把
    `OrderCreated` 挤出去，而旧口径的判据正是"事件史里找得到 OrderCreated"：
    那一单于是**整单消失**（连它自己的争议/确认一起消失），店铺页印「新店：还没有任何托管记录」。
    药：证明换成 `paid_tx_hash`（链上支付凭证，发货闸用的也是它，写入与事件裁剪无关），
    锚点退回本行 `created_at`；单量**每行只加一次**，所以"分子 ≤ 分母"是结构上成立的，
    不再靠"跳过整单"来回避。
  */
  const spammed = [
    // 这一单的 OrderCreated 被 20 条 PartialRefundAccepted 挤掉了，但凭证在、争议也在
    mk('refunded', [e('PartialRefundAccepted', now - 100), e('DisputeRequested', now - 200), e('Arbitrated', now - 150)], {
      buyer: '0x' + 'a1'.repeat(20),
      seller: '0x' + 'c1'.repeat(20),
    }),
    mk('confirmed', [e('OrderCreated', now - 800), e('ReceiptConfirmed', now - 700)], {
      buyer: '0x' + 'b1'.repeat(20),
      seller: '0x' + 'c1'.repeat(20),
    }),
  ];
  const w = computeReputation(spammed, now).windows.all;
  assert.equal(w.orders, 2, '凭证在 ⇒ 这一单必须计入（不许因为事件被挤掉就整单消失）');
  assert.equal(w.disputes, 1, '它争过，争议也要计');
  assert.equal(w.refundedToBuyer, 1, '判向按行数，与争议同源');
  assert.equal(w.confirmed, 1);
  assert.equal(w.confirmRate, 0.5, '1/2——分母含它，分子自然也含得住');
  assert.equal(w.sybil.distinctPairs, 2, '交易对计数同样不因事件裁剪而丢（重复交易对信号的分母）');

  /*
    极端情形：事件史**被清空**（不是挤掉一条，而是整列没有内容）。
    "这单托管过"的凭据是 `paid_tx_hash`，所以它照样进画像——分子那些计数自然是 0，
    而单量照计；这正是"一家有 20 单记录的老店不会因为镜像被清空就显示成新店"。
  */
  const emptied = computeReputation(
    [
      mk('confirmed', [], { buyer: '0x' + 'a2'.repeat(20), seller: '0x' + 'c2'.repeat(20) }),
      mk('confirmed', [], { buyer: '0x' + 'b2'.repeat(20), seller: '0x' + 'c2'.repeat(20) }),
    ],
    now
  ).windows.all;
  assert.equal(emptied.orders, 2, '事件史为空但凭证在 ⇒ 仍然计入单量（老店不会变新店）');
  assert.equal(emptied.confirmed, 0, '事件没了，确认计数自然是 0（分子不凭空出现）');
  assert.equal(emptied.confirmRate, 0, '0/2 = 0——是"确实没有确认记录"，不是 null');
});

test('没有链上支付凭证的行不进画像（证明在哪一层，计数就在哪一层）', async () => {
  const now = Date.now();
  const e = (name, at) => ({ name, txHash: null, block: null, at });
  const mk = (status, events, over = {}) => ({ status, delivered_at: null, onchain_events: events, ...over });
  const rows = [
    // 有事件、没凭证：历史异常行（也不是"托管发生过"的证明）⇒ 不进画像
    mk('confirmed', [e('OrderCreated', now - 1000), e('ReceiptConfirmed', now - 900)]),
    mk('confirmed', [e('OrderCreated', now - 800), e('ReceiptConfirmed', now - 700)], { paid_tx_hash: '0x' + 'cd'.repeat(32), created_at: now - 800 }),
  ];
  const w = computeReputation(rows, now).windows.all;
  assert.equal(w.orders, 1, '只有带凭证的那一单进画像');
  assert.equal(w.confirmed, 1);
  assert.equal(w.confirmRate, 1, '分子分母同源 ⇒ 不会 > 1');
});

test('三个比率恒 ∈ [0,1]（口径承诺的机器判据）', async () => {
  const now = Date.now();
  const e = (name, at) => ({ name, txHash: null, block: null, at });
  const mk = (status, events, delivered_at = null) => ({ status, delivered_at, paid_tx_hash: '0x' + 'ab'.repeat(32), created_at: 1, onchain_events: events });
  const rows = [
    mk('confirmed', [e('OrderCreated', now - 9000), e('ReceiptConfirmed', now - 8000)], now - 7000),
    mk('settled', [e('OrderCreated', now - 6000), e('DisputeRequested', now - 5500), e('Arbitrated', now - 5000)]),
    mk('refunded', [e('OrderCreated', now - 4000), e('DisputeRequested', now - 3500), e('Arbitrated', now - 3000)]),
    mk('expired', [e('OrderCreated', now - 2000), e('OrderExpiredReleased', now - 1000)]),
    mk('disputed', [e('OrderCreated', now - 900), e('Sync:disputed', now - 800)]),
    mk('settled', [e('OrderCreated', now - 700), e('PartialRefundAccepted', now - 650), e('Arbitrated', now - 600)]),
  ];
  for (const key of ['all', 'd30']) {
    const w = computeReputation(rows, now).windows[key];
    for (const [name, v] of [
      ['disputeRate', w.disputeRate],
      ['refundRate', w.refundRate],
      ['confirmRate', w.confirmRate],
      ['timeoutRate', w.timeoutRate],
    ]) {
      if (v === null) continue;
      assert.ok(v >= 0 && v <= 1, `${key}.${name} = ${v} 超出 [0,1]`);
    }
    assert.ok(
      w.refundedToBuyer + w.settledToSeller <= w.disputes,
      `${key}：判向计数（${w.refundedToBuyer}+${w.settledToSeller}）不得超过争议数（${w.disputes}）`
    );
  }
});
/* ══════════════════════════════════════════════════════════════════════
   seller 过滤：画像必须只算**指定的那一家店**的单（2026-10-15 修 D6；2026-10 多店改造改传参）
   ──────────────────────────────────────────────────────────────────────
   `orders.seller` 是逐行写入的（= 该单所属店铺的 shops.seller），而旧查询不带任何 WHERE：
   一台节点上有多家店、或店铺转手/换绑钱包之后，**别家店**的订单会被算进这一家的公开画像
   （单量、确认率、发货耗时一起被稀释/抬高）——而这份画像正是买家用来判断靠不靠谱的。
   多店改造把"哪一家店"从**可变的全局常量**换成**显式入参**：调用方漏传即抛错，
   于是"忘了按店过滤"不再可能悄悄发生（旧写法里只要有人改了全局，过滤条件就整体失效）。
   ══════════════════════════════════════════════════════════════════════ */
test('seller 过滤：只算指定那家店的单；显式 null 才是"全部在售店铺"', async () => {
  const A = '0x' + 'a1'.repeat(20);
  const B = '0x' + 'b2'.repeat(20);
  const at = Date.now() - 1000;
  const insert = async (seq) =>
    await insertOrderRow(db, {
      status: 'confirmed',
      productSlug: 'p-rep-f',
      // 这一行**刻意不指向任何真实店铺**：本用例钉的是"画像按 seller 过滤"，
      // 而 seller 列没有外键（它是逐行写入的事实），所以这里可以放两个不同的钱包
      buyer: '0x' + 'b'.repeat(40),
      seller: seq.seller,
      amountWei: '1000',
      usdtMicro: 1000000,
      btyUsdtRate: '0.1',
      escrowOrderId: `0x${String(seq.n).padStart(64, '0')}`,
      paidTxHash: `0x${String(seq.n).padStart(63, 'a')}a`,
      updatedAt: new Date(at),
    });
  await insert({ n: 1, seller: A });
  await insert({ n: 2, seller: A });
  await insert({ n: 3, seller: B });

  assert.equal((await reputationSummary(A)).windows.all.orders, 2, '只算 A 店的单');
  assert.equal((await reputationSummary(B)).windows.all.orders, 1, '只算 B 店的单');
  /*
    漏传（undefined）⇒ **抛错**，不是"退化成全部"。这是刻意的：默认成"全部"就是一次静默的
    跨店混算，表现是"画像数字看起来正常、只是把别人家的生意算进来了"——最难查的一类。
  */
  await assert.rejects(async () => await reputationSummary(undefined), /需要显式的 seller/, '漏传店铺必须响亮失败');
  /*
    显式 `null` = "该节点全部在售店铺的合计"（只有节点级读数才这么用）。
    期望值按**同一条证明判据**从库里算出来——本文件别的用例也往这个内存库插过单。
  */
  const proven = (await db.get("SELECT COUNT(1) AS c FROM v_orders WHERE paid_tx_hash IS NOT NULL")).c;
  assert.equal((await reputationSummary(null)).windows.all.orders, proven, 'null = 不过滤（节点级合计）');
  assert.ok(proven > 3, `前置：库里除本用例这 3 单还有别的行（实际 ${proven}）——上一条断言才有意义`);
});
