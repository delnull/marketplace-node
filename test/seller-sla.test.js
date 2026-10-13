/**
 * 卖家 SLA 读数（`GET /api/shop/sla`）——**链上不可达**时的三态，以及三份清单与发货时长。
 *
 * 本文件的 RPC 指向必然拒绝的端口（setup.mjs 的默认值），所以：
 *  1. 「未发货超期」的**链上那一半**（释放阈值）读不到 ⇒ `unshippedOverdue` 为空数组 +
 *     `unshippedOverdueAvailable:false` + `unshippedOverdueReason`，而**本地那一半**
 *     （候选数、被退款冻结的单）照给——这正是三态纪律："读不到"要说清是哪里读不到，
 *     界面也必须看这个字段，别把空清单读成"一切正常"；
 *  2. 链上可达时的超时清单/边界在 test/ops-metrics.test.js 覆盖（那里起了假 JSON-RPC）；
 *  3. 待回复退款、在途售后案件、发货时长分布三份读数**不依赖链**，必须照常可用；
 *  4. 发货时长的样本阈值（<5 不下发分位数）与口径来源（复用 reputation 的同一批样本）。
 *
 * 形状契约：`frontend/src/types.ts` 的 `ShopSla`（SlaItem = {orderId, ageMs}）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const { SLA_LIMIT_DEFAULT } = await import('../src/opsMetrics.js');
const { DELIVERY_MIN_SAMPLES } = await import('../src/reputation.js');

const SELLER = owner.address.toLowerCase();
const HOUR = 3600 * 1000;

let ownerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
});

let seq = 0;
const ev = (name, at) => ({ name, txHash: '0x' + 'f'.repeat(64), block: 1, at });

/** 直接插订单行（本文件关心读数口径）；`shipSpanMs` 用于造发货耗时样本 */
function insertOrder({
  key,
  status = 'escrowed',
  escrow = true,
  refundStatus = 'none',
  refundRequestedAt = null,
  afterSaleStatus = 'none',
  afterSaleOpenedAt = null,
  createdAt = null,
  shipSpanMs = null,
} = {}) {
  seq += 1;
  const id = `sla-${seq}`;
  const now = Date.now();
  const escrowOrderId = escrow ? `0x${String(seq).padStart(64, '0')}` : null;
  const created = createdAt ?? now;
  // 发货耗时样本 = 交付时刻 − OrderCreated 落库时刻（reputation.shipLatencySpan 的唯一口径）
  const escrowedAtForRow = shipSpanMs === null ? created - 60_000 : created - shipSpanMs;
  const shippedAt = shipSpanMs === null ? null : created;
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, usdt_micro, bty_usdt_rate, status, escrow_order_id, paid_tx_hash, shipped_at,
       refund_status, refund_requested_at, after_sale_status, after_sale_opened_at, onchain_events, created_at, updated_at)
     VALUES (?, ?, '{}', '0x00', '', ?, ?, '1000', 1000000, '0.1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    key,
    buyer.address.toLowerCase(),
    SELLER,
    status,
    escrowOrderId,
    escrow ? `0x${String(seq).padStart(64, 'a')}` : null,
    shippedAt,
    refundStatus,
    refundRequestedAt,
    afterSaleStatus,
    afterSaleOpenedAt,
    JSON.stringify([ev('OrderCreated', escrowedAtForRow)]),
    created,
    now
  );
  return { id, escrowOrderId };
}

const F = {};
before(() => {
  // 未发货候选（都会计入候选数；链上不可达 ⇒ 结论读不到）
  F.shipA = insertOrder({ key: 'shipA', status: 'escrowed', createdAt: Date.now() - 3 * HOUR });
  F.shipB = insertOrder({ key: 'shipB', status: 'escrowed', createdAt: Date.now() - 2 * HOUR });
  F.shipC = insertOrder({ key: 'shipC', status: 'shipped', createdAt: Date.now() - HOUR });
  // 退款申请待决：**不占**链上读数（合约永久拒绝释放），单列
  F.frozen = insertOrder({ key: 'frozen', status: 'escrowed', refundStatus: 'requested', refundRequestedAt: Date.now() - 4 * HOUR });
  // 待回复的退款申请（escrowed + disputed 各一，谓词与徽标同源）
  F.refundA = insertOrder({ key: 'refundA', status: 'escrowed', refundStatus: 'requested', refundRequestedAt: Date.now() - 5 * HOUR });
  F.refundB = insertOrder({ key: 'refundB', status: 'disputed', refundStatus: 'requested', refundRequestedAt: Date.now() - 2 * HOUR });
  // 在途售后案件（案件不动 orders.status）
  F.caseA = insertOrder({ key: 'caseA', status: 'confirmed', afterSaleStatus: 'open', afterSaleOpenedAt: Date.now() - 6 * HOUR });
  F.caseB = insertOrder({ key: 'caseB', status: 'settled', afterSaleStatus: 'open', afterSaleOpenedAt: Date.now() - HOUR });
  insertOrder({ key: 'caseClosed', status: 'settled', afterSaleStatus: 'closed', afterSaleOpenedAt: Date.now() - 9 * HOUR });
  // 已提交过一条"退款回复"：清单要能区分"已回但未在链上处理"与"完全没回"
  db.prepare('INSERT INTO dispute_evidence (order_id, role, phase, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
    F.refundA.id,
    'seller',
    'refund_reply',
    '已回复：同意退款，请在链上确认',
    Date.now() - 4 * HOUR
  );
  // 发货耗时样本（4 条 ⇒ 低于阈值；后一个用例再补第 5 条）
  [1000, 2000, 3000, 4000].forEach((ms) => insertOrder({ key: `lat${ms}`, status: 'confirmed', shipSpanMs: ms }));
});

const sla = async (qs = '') =>
  request(app).get(`/api/shop/sla${qs}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);

test('未发货超期：链上读不到时清单为空 + available:false + reason，但本地候选数照给（三态）', async () => {
  const res = await sla();
  assertOk(res);
  const d = res.body.data;
  assert.equal(d.unshippedOverdueAvailable, false, '释放阈值读不到 ⇒ 这一半标不可用');
  assert.equal(d.unshippedOverdueTotal, null, '读不到 ≠ 0：绝不写成"没有超期单"');
  assert.deepEqual(d.unshippedOverdue, [], '没有结论就没有清单（不拿"候选"冒充"超期"）');
  assert.match(d.unshippedOverdueReason, /链上读取失败|RPC 不可达/);
  assert.equal(d.unshippedOverdueCandidates, 3, '本地事实照给：3 张在途可释放候选（shipA/shipB/shipC）');
  assert.equal(d.unshippedOverdueRefundBlocked, 2, '退款冻结单（frozen/refundA）：合约 releaseExpired 会 revert');
  assert.equal(d.unshippedOverdueUnknown, 3, '候选全部没读到结论 ⇒ unknown = 候选数');
  assert.equal(d.unshippedOverdueTruncated, false);
  assert.match(d.note, /不等于"没有超期单"/, '口径说明要把"读不到"这条讲清楚（前端必须看这个字段）');
});

test('待店主回复的退款申请清单：谓词与徽标同源、最久的在前、带 ageMs 与已回复条数', async () => {
  const d = (await sla()).body.data;
  assert.equal(d.refundAwaitingReplyTotal, 3, 'refundA + refundB + 退款冻结的 frozen（谓词 = refund_status=requested ∧ 在途）');
  assert.equal(d.refundAwaitingReply.length, 3);
  assert.deepEqual(
    d.refundAwaitingReply.map((i) => i.orderId),
    [F.refundA.id, F.frozen.id, F.refundB.id],
    '按申请时刻升序 = 最久的在最前'
  );
  const first = d.refundAwaitingReply[0];
  assert.ok(first.ageMs > 4.9 * HOUR, `最久等待≈5 小时，实际 ${first.ageMs}`);
  assert.equal(first.sellerReplyCount, 1, '已提交过一条退款回复');
  assert.equal(d.refundAwaitingReply[1].sellerReplyCount, 0, '完全没回的照样列出（0 = 没回过）');
  assert.ok(d.refundAwaitingReplyOldestWaitingMs >= first.ageMs, '队列级"最久等待"与清单第一条同源');
});

test('在途售后案件清单：只列 open、按开案时刻升序、带 ageMs', async () => {
  const d = (await sla()).body.data;
  assert.equal(d.afterSaleOpenTotal, 2, 'closed 的案件不进在途队列');
  assert.deepEqual(
    d.afterSaleOpen.map((i) => i.orderId),
    [F.caseA.id, F.caseB.id]
  );
  assert.ok(d.afterSaleOpen[0].ageMs > 5.9 * HOUR);
  assert.ok(d.afterSaleOpenOldestWaitingMs >= d.afterSaleOpen[0].ageMs, '"最久等待"与清单第一条同源（同一列）');
});

test('发货时长：样本不足时分位数一律 null（样本量照给），样本够了才出中位数/P90', async () => {
  const l1 = (await sla()).body.data;
  assert.equal(l1.shipMinSamples, DELIVERY_MIN_SAMPLES);
  assert.equal(l1.shipWindow, 'd30');
  assert.equal(l1.shipSampleCount, 4);
  assert.equal(l1.shipSampleTooSmall, true);
  assert.equal(l1.shipMedianMs, null, '样本 <5 不下发中位数');
  assert.equal(l1.shipP90Ms, null, 'P90 在 n<5 时等于最大值：更不该下发');
  assert.match(l1.shipBasis, /OrderCreated/);
  assert.deepEqual(Object.keys(l1.shipWindows).sort(), ['all', 'd30', 'd365', 'd90'], '四个窗口与履约画像同源');

  // 补第 5 条样本：中位数 3000、P90（最近秩法，⌈0.9×5⌉=5）5000
  insertOrder({ key: 'lat5000', status: 'confirmed', shipSpanMs: 5000 });
  const l2 = (await sla()).body.data;
  assert.equal(l2.shipSampleCount, 5);
  assert.equal(l2.shipSampleTooSmall, false);
  assert.equal(l2.shipMedianMs, 3000, '中位数（升序第 3 个）');
  assert.equal(l2.shipP90Ms, 5000, 'P90 = 最近秩法第 ⌈0.9n⌉ 个样本');
  assert.match(l2.note, /显示策略/);
});

test('limit 作用于三份清单；缺省 20、上限 100（越界拒绝，不静默截断）', async () => {
  const d = (await sla()).body.data;
  assert.equal(d.limit, SLA_LIMIT_DEFAULT);
  const one = (await sla('?limit=1')).body.data;
  assert.equal(one.refundAwaitingReply.length, 1);
  assert.equal(one.afterSaleOpen.length, 1);
  assert.equal(one.refundAwaitingReplyTotal, 3, 'limit 只影响清单条数，不影响计数');
  const bad = await request(app).get('/api/shop/sla?limit=0').set('Authorization', `Bearer ${ownerToken}`);
  assert.notEqual(bad.body.code, 0);
});

test('口径声明：读数只覆盖本店、超期判据是链上阈值而非本地估算', async () => {
  const d = (await sla()).body.data;
  assert.match(d.note, /只覆盖\*\*本店\*\*/);
  assert.match(d.note, /链上/);
  assert.match(d.note, /releaseNotBeforeBlock/);
});
