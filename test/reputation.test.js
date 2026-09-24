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
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, db, owner, buyer } = ctx;

let ownerToken;
let buyerToken;
let slug;

const { applyEvent } = await import('../src/escrowWatcher.js');
const { computeReputation } = await import('../src/reputation.js');

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
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ productSlug: slug, buyer: buyerAddr })
    .expect(200);
  assertOk(res);
  return res.body.data;
}
function ev(order, name, args = {}, meta = {}) {
  // 真实链上事件必然带交易哈希：OrderCreated 一并落为支付凭证（与 watcher 回写语义一致）
  const m = name === 'OrderCreated' ? { txHash: payHash(), block: 1, ...meta } : meta;
  assert.equal(applyEvent(name, { orderId: order.escrowOrderId, ...args }, m), 1, `${name} 应推进`);
}
async function ship(order) {
  const res = await ctx.request(ctx.app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ deliveryCode: 'REP-CODE' })
    .expect(200);
  assertOk(res);
}

/** 把订单事件史的时刻整体前移（模拟历史单：只进 all 窗不进 d365/d90/d30） */
function backdate(order, days) {
  const row = db.prepare('SELECT onchain_events FROM orders WHERE id = ?').get(order.id);
  const list = JSON.parse(row.onchain_events).map((e) => ({ ...e, at: e.at - days * DAY_MS }));
  db.prepare('UPDATE orders SET onchain_events = ? WHERE id = ?').run(JSON.stringify(list), order.id);
}

// ── 顶层 before 需串行完成登录与造单（node:test 多个顶层 before 存在并发交错，见仓库测试惯例）──
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  assert.ok(ownerToken && buyerToken);

  const listed = await ctx.request(ctx.app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ kind: 'digital', title: '信誉-画像样本', capacity: null }))
    .expect(200);
  assertOk(listed);
  slug = listed.body.data.slug;

  // 近窗 8 单（d30/d90/d365 同口径）
  const t1 = await createOrder(buyerAddrs[0]); ev(t1, 'OrderCreated'); ev(t1, 'ReceiptConfirmed'); // 买家确认
  const t2 = await createOrder(buyerAddrs[1]); ev(t2, 'OrderCreated'); await ship(t2); ev(t2, 'ReceiptConfirmed'); // 已交付后确认（发货样本）
  const t3 = await createOrder(buyerAddrs[2]); ev(t3, 'OrderCreated'); ev(t3, 'DisputeRequested'); ev(t3, 'Arbitrated', { refundWei: t3.amountWei }); // 判买家
  const t4 = await createOrder(buyerAddrs[3]); ev(t4, 'OrderCreated'); await ship(t4); ev(t4, 'DisputeRequested'); ev(t4, 'Arbitrated', { refundWei: 0n }); // 判卖家（样本）
  const t5 = await createOrder(buyerAddrs[4]); ev(t5, 'OrderCreated'); ev(t5, 'OrderExpiredReleased'); // 超时释放
  const t6 = await createOrder(buyerAddrs[5]); ev(t6, 'OrderCreated'); ev(t6, 'DisputeRequested'); // 未裁决争议
  const t7 = await createOrder(buyerAddrs[6]); ev(t7, 'OrderCreated'); ev(t7, 'ReceiptConfirmed'); await backdate(t7, 500); // 老单：仅进 all
  const t8 = await createOrder(buyerAddrs[7]); ev(t8, 'OrderCreated'); ev(t8, 'DisputeRequested'); ev(t8, 'Arbitrated', { refundWei: t8.amountWei }); // 判买家 #2
  const t9 = await createOrder(buyerAddrs[8]); ev(t9, 'OrderCreated'); await ship(t9); ev(t9, 'DisputeRequested'); ev(t9, 'Arbitrated', { refundWei: 0n }); // 判卖家 #2（样本）
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

  // 发货耗时（本地账 ⚠）：3 单有交付记录（t2/t4/t9），中位数为非负毫秒数
  assert.equal(r.delivery.d30.count, 3);
  assert.equal(typeof r.delivery.d30.medianMs, 'number');
  assert.ok(r.delivery.d30.medianMs >= 0);
  assert.equal(r.delivery.all.count, 3, '老单无交付记录不进入样本');

  // 运营起点：最早 OrderCreated（老单前移后）
  assert.ok(r.firstOrderAt <= Date.now() - 400 * DAY_MS, 'firstOrderAt 来自最早托管事件');

  // 隐私口径：不下发单笔订单字段
  assert.ok(!('orders' in r), '顶层不得直接挂订单列表');
  assert.ok(r.note && r.note.length > 0, '口径诚实标注（数据源/可审计性）');
});

test('单元：paid 快路径订单（OrderCreated 由 paid 补写）参与单量/确认率统计', async () => {
  const now = Date.now();
  const mk = (status, events) => ({ status, delivered_at: null, onchain_events: JSON.stringify(events) });
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
    onchain_events: JSON.stringify(events),
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
      onchain_events: JSON.stringify([e('OrderCreated', now - 2000), e('ReceiptConfirmed', now - 1000)]),
    },
    {
      status: 'confirmed',
      delivered_at: now - 3000,
      onchain_events: JSON.stringify([e('OrderCreated', now - 6000), e('ReceiptConfirmed', now - 3000)]),
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
        onchain_events: JSON.stringify([e('OrderCreated', now - 50 * DAY_MS), e('ReceiptConfirmed', now - 40 * DAY_MS)]),
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
      onchain_events: JSON.stringify([e('OrderCreated', now - 1000), e('ReceiptConfirmed', now - 500)]),
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
  const drafts = computeReputation([{ status: 'draft', delivered_at: null, onchain_events: '[]' }], now);
  assert.equal(drafts.windows.all.orders, 0);
});