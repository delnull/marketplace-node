/**
 * 仲裁数据面（Stage 3）：待仲裁单公开摘要 + 订单详情「仲裁人视角」。
 *  - GET /api/arbitration/pending：仅 disputed 单入列（按进入争议时间倒序分页），
 *    摘要含金额/双方/交付证据标志/链上事件史，不含交付内容原文（码/物流/tokenId）；
 *  - 详情码可见性矩阵：匿名与第三人不可见；买家已交付可见；店主可见；
 *    链上仲裁人（当前届委员会；测试注入取值）仅对争议中（disputed）单开放（裁决证据语义——
 *    正常在途单的交付码不属于裁决证据，仲裁人无查看必要，收紧隐私面）；
 *  - 仲裁事件回写后待仲裁列表自动收敛（disputed → settled/refunded 出列）。
 * 状态推进不经真实链上（单测无 RPC）——与 watcher.test 同款：直调 applyEvent。
 */
import { test, before } from 'node:test';

/** 全额退款事件参数（Escrow.Arbitrated/RefundApproved 现带 refundWei）：测试内订单金额恒为 1e18 */
const FULL_REFUND = '1000000000000000000';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

// 必须在 makeCtx 之前设置（config 模块求值时读取，见 setup.mjs 头注释）
const arbiter = Wallet.createRandom();
// 2026-10-18：仲裁人不再是单个环境变量，改为链上当前届名单（测试注入取值）

const ctx = await makeCtx();

// 2026-10-18：仲裁人 = 链上当前届名单（注入取值，避免起假 RPC）
const { setCommitteeReader } = await import('../src/chain.js');
setCommitteeReader(async () => ({ arbiters: [arbiter.address.toLowerCase()], threshold: 1, epoch: 1 }));
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();

let ownerToken;
let arbiterToken;
let strangerToken;
let buyerToken;
// 模拟链上规范哈希（escrowed 必有支付凭证，发货防呆要求，见 orders.js 头注释）
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

const { applyEvent } = await import('../src/escrowWatcher.js');

async function listProduct(payload) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(payload)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug) {
  // 买家本人登录下单（本人=target）；buyerToken 在 before 中先于造单完成登录
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, buyer: buyer.address })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 直接置为 escrowed（模拟 watcher/paid 已回写并落支付凭证，跳过链上） */
async function escrowed(order) {
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), order.id);
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', payHash(), order.id);
}

/** 店主发货（physical 传物流单号 / digital 手动交付码） */
async function ship(order, body) {
  const res = await request(app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(body)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

// ── 造单：5 单（3 争议 + 2 对照），全 capacity null 避免库存纠缠 ──
let d1; // physical 已发货（物流单号）后争议
let d2; // digital 已手动交付（码）后争议 —— 裁决证据码
let d3; // digital 未交付直接争议
let d4; // physical 正常成交（对照：不得入待仲裁列表）
let d5; // digital 已交付（码）但未争议 —— 正常在途单（对照：仲裁人不得开码）

// 顶层 before 需串行完成登录与造单（node:test 多个顶层 before 存在并发交错，见仓库测试惯例）
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  arbiterToken = (await login(ctx, arbiter)).token;
  strangerToken = (await login(ctx, stranger)).token;
  buyerToken = (await login(ctx, buyer)).token;
  assert.ok(ownerToken && arbiterToken && strangerToken && buyerToken);

  const p1 = await listProduct(productPayload({ kind: 'physical', title: '仲裁-实物已发', capacity: null }));
  const p2 = await listProduct(productPayload({ kind: 'digital', title: '仲裁-数字已交付', capacity: null }));
  const p3 = await listProduct(productPayload({ kind: 'digital', title: '仲裁-数字未交付', capacity: null }));
  const p4 = await listProduct(productPayload({ kind: 'physical', title: '仲裁-正常成交', capacity: null }));
  const p5 = await listProduct(productPayload({ kind: 'digital', title: '仲裁-在途正常单', capacity: null }));

  d1 = await createDraft(p1.slug);
  d2 = await createDraft(p2.slug);
  d3 = await createDraft(p3.slug);
  d4 = await createDraft(p4.slug);
  d5 = await createDraft(p5.slug);
  await escrowed(d1);
  await escrowed(d2);
  await escrowed(d3);
  await escrowed(d4);
  await escrowed(d5);

  // 已交付两单：卖家先发货再争议（shipped → disputed）
  await ship(d1, { trackingNo: 'SF-1001' });
  await ship(d2, { deliveryCode: 'CARD-777' });
  // 对照：已交付但未争议（shipped 在途正常单，买家已拿到码）
  await ship(d5, { deliveryCode: 'CARD-555' });
  assert.equal(await applyEvent('DisputeRequested', { orderId: d1.escrowOrderId }), 1);
  assert.equal(await applyEvent('DisputeRequested', { orderId: d2.escrowOrderId }), 1);
  // 未交付争议（escrowed → disputed）
  assert.equal(await applyEvent('DisputeRequested', { orderId: d3.escrowOrderId }), 1);
  // 对照：正常成交（confirmed）不得入待仲裁列表
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: d4.escrowOrderId }), 1);
});

async function pending(page = 1, pageSize = 30) {
  /*
    仲裁台以**已确证的链上仲裁人**身份读队列：匿名行不带本地句柄 `orderNo`（见
    routes/arbitration.js 的隐私口径），而下面的用例要按 orderNo 索引行。
  */
  const res = await request(app)
    .get(`/api/arbitration/pending?page=${page}&pageSize=${pageSize}`)
    .set('Authorization', `Bearer ${arbiterToken}`)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

test('匿名队列不提供本地句柄 orderNo（链上事实仍公开）；非仲裁人令牌同样拿不到', async () => {
  /*
    `orderNo` 是"时间前缀 + 50 bit 随机段"的本地句柄，拿到它就能继续探测订单详情面；
    链上 `escrowOrderId` / 金额 / 双方地址才是这一行对匿名者公开的事实（链上事件里就有）。
    判据只在 disputeToPublic 一处：showLocalHandle = 已确证的链上仲裁人。
  */
  const anon = await request(app).get('/api/arbitration/pending').expect(200);
  assertOk(anon);
  assert.ok(anon.body.data.disputes.length > 0, '前置：队列里有争议单');
  for (const r of anon.body.data.disputes) {
    assert.equal(r.orderNo, null, '匿名行不下发本地句柄');
    assert.match(r.escrowOrderId, /^0x[0-9a-f]{64}$/, '链上事实仍公开（裁决直调需要它）');
    assert.equal(r.buyer, buyer.address.toLowerCase());
  }
  assert.equal(anon.body.data.waiting.count, anon.body.data.total, '等待读数不依赖句柄');

  const third = await request(app)
    .get('/api/arbitration/pending')
    .set('Authorization', `Bearer ${strangerToken}`)
    .expect(200);
  assert.ok(third.body.data.disputes.every((r) => r.orderNo === null), '非仲裁人令牌不是本地句柄的凭证');

  const arb = await pending();
  assert.ok(arb.disputes.every((r) => typeof r.orderNo === 'string' && r.orderNo.length === 21), '仲裁人拿到句柄');
});

test('待仲裁列表：仅 disputed 入列，摘要含裁决要素但不含交付内容原文', async () => {
  const data = await pending();
  assert.equal(data.total, 3, '3 单争议中，成交对照单不入列');
  /*
    摘要里的订单标识是 `orderNo`（对外单号，CHAR(21)）——旧字段 `id` 是内部自增键，
    它不出本节点（换库/重建之后会变，而仲裁台的链接要长期指向同一张单，见 routes/arbitration.js）。
    下面用接口给的 `id`（就是订单号，见 setup.mjs）去索引。
  */
  const byId = Object.fromEntries(data.disputes.map((r) => [r.orderNo, r]));

  const r1 = byId[d1.id];
  const r2 = byId[d2.id];
  const r3 = byId[d3.id];
  assert.ok(r1 && r2 && r3, '三单争议均在待仲裁列表');

  // 裁决要素齐全
  for (const r of [r1, r2, r3]) {
    assert.equal(r.status, undefined, '摘要不返回状态冗余');
    assert.match(r.escrowOrderId, /^0x[0-9a-f]{64}$/, '链上 orderId 供裁决直调');
    assert.equal(r.buyer, buyer.address.toLowerCase());
    assert.equal(r.seller, owner.address.toLowerCase());
    assert.equal(r.usdtMicro, 88_000_000, '本单应付总额（微 USDT）');
    assert.equal(r.usdt, '88', '展示串去净尾零：88 USDT 写作 88（不是 88.00）');
    assert.ok(BigInt(r.amountWei) > 0n, '托管金额可读');
    assert.ok(Array.isArray(r.onchainEvents), '链上事件史可溯源（公开信息）');
    assert.ok(r.onchainEvents.length >= 1, '至少含 DisputeRequested');
    assert.ok(r.onchainEvents.some((e) => e.name === 'DisputeRequested'));
  }

  // 交付证据标志：已发货单 true、未交付单 false（裁决区分「未发货」与「货不对版」）
  assert.equal(r1.delivered, true, '实物已登记物流单号 → delivered');
  assert.equal(r2.delivered, true, '数字已交付码 → delivered');
  assert.equal(r3.delivered, false, 'escrowed 直接争议 → 未交付');

  // 摘要不含交付内容原文（码/物流单号/tokenId 属敏感资源，仅详情按身份返回）
  for (const r of [r1, r2, r3]) {
    assert.ok(!('deliveryCode' in r), '摘要不得含 deliveryCode');
    assert.ok(!('trackingNo' in r), '摘要不得含 trackingNo');
    assert.ok(!('deliveryTokenId' in r), '摘要不得含 deliveryTokenId');
  }

  // 未交付争议单进入争议时间 = 本地状态迁移时刻（updated_at 由 applyEvent 更新）
  assert.ok(r3.disputedAt >= d3.createdAt);
});

/**
 * 平台费三态（源码评审 2026-09，P2）：`fee_bps` 列是 `INTEGER NOT NULL DEFAULT 0`，而它与
 * `fee_collector_at_create` 由同一条 UPDATE 成对补录 ⇒ "快照为空"意味着**两列都没补录过**。
 * 此时若把 `feeBps` 当成 0 下发，仲裁台就会印出"本单费率 0%"（一个链上并不成立的结论），
 * 而链上是按创建时快照扣费的。旧实现 `o.fee_bps || 0` 正是这样把三态压成了两态。
 */
test('待仲裁列表的平台费三态：快照缺失 ⇒ feeBps=null（不是 0）；有快照 ⇒ 如实给数', async () => {
  const { db } = ctx;
  // ① 模拟"补录失败/未补录"的行：收费方列为 NULL（三态里的"从未补录"）
  await db.run('UPDATE orders SET fee_bps = 0, fee_collector_at_create = NULL WHERE order_no = ?', d1.id);
  const data1 = await pending();
  const row1 = data1.disputes.find((r) => r.orderNo === d1.id);
  assert.equal(row1.feeBps, null, '快照缺失时必须是 null（读不到 ≠ 不扣费）');
  assert.equal(row1.feeCollectorAtCreate, null);
  // 兜底判定仍按**保守**口径给 true（"快照缺失 ⇒ 按全局口径假定会扣"是 fees.js 的既定语义），
  // 于是前端拿到的是 (feeBps=null, feeChargeable=true) 这个组合：没数、但按会扣提示 —— 三态齐。
  assert.equal(row1.feeChargeable, true, '快照缺失 ⇒ 保守假定会扣（fees.js 的既定兜底）');

  // ② 有快照（正常行）：如实给数（含"确实是 0 费率"这种合法情况）
  await db.run("UPDATE orders SET fee_bps = 500, fee_collector_at_create = ? WHERE order_no = ?", '0x' + 'ab'.repeat(20),
    d2.id);
  const data2 = await pending();
  const row2 = data2.disputes.find((r) => r.orderNo === d2.id);
  assert.equal(row2.feeBps, 500);
  assert.equal(row2.feeCollectorAtCreate, '0x' + 'ab'.repeat(20));
  assert.equal(row2.feeChargeable, true);

  // ③ 有快照但费率确实是 0：给 0（而不是 null）——"确实不扣"与"读不到"必须分得开
  await db.run("UPDATE orders SET fee_bps = 0, fee_collector_at_create = ? WHERE order_no = ?", '0x' + 'ab'.repeat(20),
    d3.id);
  const data3 = await pending();
  const row3 = data3.disputes.find((r) => r.orderNo === d3.id);
  assert.equal(row3.feeBps, 0, '快照在、费率确实是 0 ⇒ 给 0');
  assert.equal(row3.feeChargeable, true, '收取方非零地址 ⇒ 链上会按 0‰ 扣费（金额为 0，但口径是"会扣"）');
});

test('待仲裁列表分页：倒序分页且 total 恒定', async () => {
  const page1 = await pending(1, 2);
  assert.equal(page1.disputes.length, 2);
  assert.equal(page1.total, 3);
  const page2 = await pending(2, 2);
  assert.equal(page2.disputes.length, 1);
  assert.equal(page2.total, 3);
  const all = [...page1.disputes, ...page2.disputes];
  assert.equal(new Set(all.map((r) => r.orderNo)).size, 3, '两页不重不漏');
  // 倒序：disputedAt 递减
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i - 1].disputedAt >= all[i].disputedAt, '按进入争议时间倒序');
  }
});

test('详情码可见性矩阵：仲裁人对争议单开放裁决证据（码全可见）', async () => {
  const getDetail = async (token) =>
    request(app)
      .get(`/api/orders/${d2.id}`)
      .set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value)
      .expect(200);

  // 匿名与第三人：不可见交付码
  const anon = await request(app).get(`/api/orders/${d2.id}`).expect(200);
  assertOk(anon);
  assert.deepEqual(anon.body.data.deliveries, [], '匿名不可见码');
  assert.equal(anon.body.data.status, 'disputed', '公开字段（状态/金额）仍可读');

  const third = await getDetail(strangerToken);
  assertOk(third);
  assert.deepEqual(third.body.data.deliveries, [], '第三人（非买家/店主/仲裁人）不可见码');

  // 买家本人：已交付（shipped 后争议）可见
  const byBuyer = await getDetail(buyerToken);
  assertOk(byBuyer);
  assert.equal(byBuyer.body.data.deliveries[0].value, 'CARD-777', '买家已交付可见（发货后争议）');

  // 店主：始终可见
  const byOwner = await getDetail(ownerToken);
  assertOk(byOwner);
  assert.equal(byOwner.body.data.deliveries[0].value, 'CARD-777', '店主可见');

  // 链上仲裁人：任意争议单可见（裁决证据）
  const byArbiter = await getDetail(arbiterToken);
  assertOk(byArbiter);
  assert.equal(byArbiter.body.data.deliveries[0].value, 'CARD-777', '仲裁人视角开放裁决证据');
});

test('仲裁视角收紧：非争议单（正常在途 shipped）不对仲裁人开码', async () => {
  // d5 已交付未争议：店主/买家按交付语义可见码；仲裁人无裁决证据需求 → 码不开放
  const anon = await request(app).get(`/api/orders/${d5.id}`).expect(200);
  assertOk(anon);
  assert.deepEqual(anon.body.data.deliveries, [], '匿名不可见码');

  const byBuyer = await request(app)
    .get(`/api/orders/${d5.id}`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(byBuyer);
  assert.equal(byBuyer.body.data.deliveries[0].value, 'CARD-555', '买家已交付可见');

  const byOwner = await request(app)
    .get(`/api/orders/${d5.id}`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(byOwner);
  assert.equal(byOwner.body.data.deliveries[0].value, 'CARD-555', '店主始终可见');

  // 收紧断言：仅 disputed 属裁决证据，仲裁人对正常在途单不开码
  const byArbiter = await request(app)
    .get(`/api/orders/${d5.id}`)
    .set('Authorization', `Bearer ${arbiterToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(byArbiter);
  assert.deepEqual(byArbiter.body.data.deliveries, [], '仲裁人不对正常在途单开码');
});

test('未交付争议单对仲裁人同样开放全字段（含 tracking 证据区）', async () => {
  const res = await request(app)
    .get(`/api/orders/${d1.id}`)
    .set('Authorization', `Bearer ${arbiterToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.status, 'disputed');
  assert.equal(res.body.data.trackingNo, 'SF-1001', '仲裁人可见物流单号（裁决证据）');
  assert.deepEqual(res.body.data.deliveries, [], '实物无交付行');
});

test('仲裁裁决回写后待仲裁列表收敛（disputed → settled/refunded 出列）', async () => {
  // 判付卖家：d1 出列
  assert.equal(await applyEvent('Arbitrated', { orderId: d1.escrowOrderId, refundWei: 0n }), 1);
  // 判退款买家：d3 出列
  assert.equal(await applyEvent('Arbitrated', { orderId: d3.escrowOrderId, refundWei: d3.amountWei }), 1);

  const data = await pending();
  assert.equal(data.total, 1, '仅剩 d2 一单待仲裁');
  const ids = data.disputes.map((r) => r.orderNo);
  assert.ok(ids.includes(d2.id), '未裁决单保留');
  assert.ok(!ids.includes(d1.id), 'settled 出列');
  assert.ok(!ids.includes(d3.id), 'refunded 出列');

  // 状态语义正确（与订单详情联动）
  const detail = await request(app)
    .get(`/api/orders/${d3.id}`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.equal(detail.body.data.status, 'refunded');
});