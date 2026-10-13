/**
 * 运营指标（`GET /api/shop/metrics`）与卖家 SLA 的**链上可达**路径。
 *
 * 本文件起一个本地假 JSON-RPC（按生产 `ESCROW_ABI` 的 selector 分发，与
 * test/order-sync-paths.test.js / after-sale.test.js 同款），专门覆盖"读得到"的那些读数：
 *  1. 待办三队列的计数与**最久等待**，并与店主徽标 `/api/orders/seller/status-counts` **逐项相等**
 *     （两处读的是同一份 opsMetrics.sellerTodoCounts——徽标与指标各写一遍 SQL 必然漂移）；
 *  2. 托管超时：链上阈值取自合约 `releaseNotBeforeBlock`（不是本地按块时间估算），
 *     边界是 `latestBlock > 阈值`；单笔阈值读失败进 `unknown`（**不是**"未超时"）；
 *     `refund_status='requested'` 的单被合约永久拒绝释放，既不算超时也不占链上读；
 *  3. 挂账余额：payouts 读店主地址、fees 读当前 feeCollector（**读不到时字段为 null 而不是 '0'**）；
 *  4. 订单各状态计数（含 0）；
 *  5. SLA 未发货超期清单（最久的在前、limit 生效、带 orderId 与 ageMs）。
 *
 * 响应形状与前端契约一致（`frontend/src/types.ts` 的 ShopMetrics / ShopSla）；
 * 链上**不可达**时的三态在 test/seller-sla.test.js 覆盖（那个文件的 RPC 指向必然拒绝的端口）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';
import { makeCtx, login, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const { ESCROW_ABI } = await import('../src/chain.js');
const { reconcileReading, queueWait, sellerTodoCounts, escrowOverdueReading, PENDING_REFUND_SQL } = await import('../src/opsMetrics.js');
const { resetFeeCache } = await import('../src/fees.js');
const config = (await import('../src/config.js')).default;

const SELLER = owner.address.toLowerCase();
const COLLECTOR = '0x' + 'cc'.repeat(20);
const ZERO = '0x' + '0'.repeat(40);

// ── 假 JSON-RPC：块高 + 逐单释放阈值 + 两个挂账映射 + feeCollector ──
const iface = new Interface(ESCROW_ABI);
/** 当前链上状态（各用例自行改写；thresholds 里没有的 escrowOrderId = 读失败） */
const chain = {
  blockNumber: 1000n,
  thresholds: new Map(), // escrowOrderId(小写) → bigint
  payouts: '0',
  fees: '0',
  feeCollector: COLLECTOR,
};

function handleRpc(j) {
  try {
    if (j.method === 'eth_blockNumber') return { result: '0x' + chain.blockNumber.toString(16) };
    const to = String(j.params?.[0]?.to || '').toLowerCase();
    if (j.method !== 'eth_call' || to !== String(config.chain.escrowAddress).toLowerCase()) {
      return { error: { code: -32601, message: `unit-test: 未预期的 RPC 调用 ${j.method}` } };
    }
    const data = String(j.params?.[0]?.data || '');
    const selector = data.slice(0, 10);
    const fn = (name) => iface.getFunction(name).selector;
    if (selector === fn('releaseNotBeforeBlock')) {
      const [orderId] = iface.decodeFunctionData('releaseNotBeforeBlock', data);
      const key = String(orderId).toLowerCase();
      if (!chain.thresholds.has(key)) return { error: { code: -32000, message: 'unit-test: 阈值读取失败' } };
      return { result: iface.encodeFunctionResult('releaseNotBeforeBlock', [chain.thresholds.get(key)]) };
    }
    if (selector === fn('accruedPayouts')) {
      const [addr] = iface.decodeFunctionData('accruedPayouts', data);
      const v = String(addr).toLowerCase() === SELLER ? chain.payouts : '0';
      return { result: iface.encodeFunctionResult('accruedPayouts', [BigInt(v)]) };
    }
    if (selector === fn('accruedFees')) {
      const [addr] = iface.decodeFunctionData('accruedFees', data);
      const v = String(addr).toLowerCase() === COLLECTOR ? chain.fees : '0';
      return { result: iface.encodeFunctionResult('accruedFees', [BigInt(v)]) };
    }
    if (selector === fn('feeCollector')) return { result: iface.encodeFunctionResult('feeCollector', [chain.feeCollector]) };
    if (selector === fn('arbiter')) return { result: iface.encodeFunctionResult('arbiter', [ZERO]) };
    return { error: { code: -32601, message: `unit-test: 未预期的 selector ${selector}` } };
  } catch (e) {
    return { error: { code: -32000, message: String(e?.message || e) } };
  }
}

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const out = Array.isArray(parsed)
      ? parsed.map((j) => ({ jsonrpc: '2.0', id: j?.id ?? 1, ...handleRpc(j) }))
      : { jsonrpc: '2.0', id: parsed?.id ?? 1, ...handleRpc(parsed) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});
after(() => rpcServer.close());

let ownerToken;
let buyerToken;
/** 夹具的订单 id（断言用） */
const F = {};

const HOUR = 3600 * 1000;
let seq = 0;
const ev = (name, at) => ({ name, txHash: '0x' + 'f'.repeat(64), block: 1, at });

/** 直接插订单行（本文件关心读数口径，不走下单流程）；threshold = 假链上给出的释放阈值 */
function insertOrder({
  key,
  status = 'escrowed',
  escrow = true,
  threshold = null,
  refundStatus = 'none',
  refundRequestedAt = null,
  afterSaleStatus = 'none',
  afterSaleOpenedAt = null,
  escrowedAt = null,
} = {}) {
  seq += 1;
  const id = `om-${seq}`;
  const now = Date.now();
  const escrowOrderId = escrow ? `0x${String(seq).padStart(64, '0')}` : null;
  if (escrowOrderId && threshold !== null) chain.thresholds.set(escrowOrderId.toLowerCase(), threshold);
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, usdt_micro, bty_usdt_rate, status, escrow_order_id, paid_tx_hash,
       refund_status, refund_requested_at, after_sale_status, after_sale_opened_at, onchain_events, created_at, updated_at)
     VALUES (?, ?, '{}', '0x00', '', ?, ?, '1000', 1000000, '0.1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    key,
    buyer.address.toLowerCase(),
    SELLER,
    status,
    escrowOrderId,
    escrow ? `0x${String(seq).padStart(64, 'a')}` : null,
    refundStatus,
    refundRequestedAt,
    afterSaleStatus,
    afterSaleOpenedAt,
    escrowedAt === null ? null : JSON.stringify([ev('OrderCreated', escrowedAt)]),
    now,
    now
  );
  F[key] = { id, escrowOrderId };
  return id;
}

before(async () => {
  await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
  config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
  resetFeeCache();
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;

  // 待办夹具（覆盖九种状态 + 三队列）
  insertOrder({ key: 'draft', status: 'draft', escrow: false });
  insertOrder({ key: 'shipReady', status: 'escrowed', threshold: 500n, escrowedAt: Date.now() - 10 * HOUR }); // 已超时（1000 > 500）
  insertOrder({ key: 'refundFrozen', status: 'escrowed', threshold: 500n, refundStatus: 'requested', refundRequestedAt: Date.now() - 2 * HOUR });
  insertOrder({ key: 'refundOnShipped', status: 'shipped', threshold: 900n, refundStatus: 'requested', refundRequestedAt: Date.now() - 1 * HOUR });
  insertOrder({ key: 'disputed', status: 'disputed', threshold: 500n });
  insertOrder({ key: 'afterSaleOpen', status: 'confirmed', threshold: 500n, afterSaleStatus: 'open', afterSaleOpenedAt: Date.now() - 3 * HOUR, escrowedAt: Date.now() - 4 * HOUR });
  insertOrder({ key: 'afterSaleClosed', status: 'settled', threshold: 500n, afterSaleStatus: 'closed', afterSaleOpenedAt: Date.now() - 5 * HOUR });
  insertOrder({ key: 'refunded', status: 'refunded', threshold: 500n });
  insertOrder({ key: 'expired', status: 'expired', threshold: 500n });
  insertOrder({ key: 'cancelled', status: 'cancelled', escrow: false });
  // 托管超时读数的其余候选：未超时 / 阈值读失败 / 另一个已超时（排序用）
  insertOrder({ key: 'notOverdue', status: 'escrowed', threshold: 2000n, escrowedAt: Date.now() - 6 * HOUR });
  insertOrder({ key: 'thresholdFail', status: 'shipped', threshold: null, escrowedAt: Date.now() - 5 * HOUR });
  insertOrder({ key: 'overdueOld', status: 'escrowed', threshold: 400n, escrowedAt: Date.now() - 8 * HOUR });
});

const metrics = async (token = ownerToken) =>
  request(app).get('/api/shop/metrics').set('Authorization', `Bearer ${token}`).expect(200);

test('ownerOnly：无令牌 401、买家令牌 403（运营读数不进公开面）', async () => {
  await request(app).get('/api/shop/metrics').expect(401);
  const r = await request(app).get('/api/shop/metrics').set('Authorization', `Bearer ${buyerToken}`);
  assert.equal(r.body.code, 403);
});

test('订单各状态计数：九个状态键恒在（缺的补 0），合计 = 本地订单行数', async () => {
  const d = (await metrics()).body.data;
  assert.deepEqual(Object.keys(d.ordersByStatus), ['draft', 'escrowed', 'shipped', 'confirmed', 'disputed', 'settled', 'refunded', 'expired', 'cancelled']);
  assert.equal(d.ordersByStatus.draft, 1);
  assert.equal(d.ordersByStatus.cancelled, 1);
  assert.equal(d.ordersByStatus.refunded, 1);
  assert.equal(d.ordersByStatus.expired, 1);
  assert.ok(d.ordersByStatus.escrowed >= 4, 'escrowed = shipReady + refundFrozen + notOverdue + overdueOld');
  const total = Object.values(d.ordersByStatus).reduce((a, b) => a + b, 0);
  assert.equal(total, db.prepare('SELECT COUNT(*) AS c FROM orders').get().c, '0 是"确实没有该状态的单"，不是"读不到"');
});

test('待办三队列：计数 + 最久等待（锚点与徽标同源；空队列是 null 而不是 0 毫秒）', async () => {
  const d = (await metrics()).body.data;

  // 待处理退款：谓词 = refund_status='requested' ∧ status ∈ 在途（含 disputed）
  assert.equal(d.refundsPending, 2);
  // 在途售后案件：判据 after_sale_status='open'（案件不动 orders.status）
  assert.equal(d.afterSaleOpen, 1);
  assert.ok(d.afterSaleOldestWaitingMs > 2.9 * HOUR, `最久等待应≈3 小时，实际 ${d.afterSaleOldestWaitingMs}`);
  const openedAt = db.prepare('SELECT after_sale_opened_at AS t FROM orders WHERE id = ?').get(F.afterSaleOpen.id).t;
  assert.ok(
    Math.abs(d.afterSaleOldestWaitingMs - (Date.now() - openedAt)) < 2000,
    '读数 = now − after_sale_opened_at（锚点列，与仲裁队列同一实现）'
  );
  // 待仲裁争议
  assert.equal(d.disputesPending, 1);
  assert.ok(d.disputesOldestWaitingMs >= 0);

  // 退款队列的最久等待：与另两格**同一算法、同一锚点列**（refund_requested_at）
  const oldestRefundAt = db.prepare(`SELECT MIN(refund_requested_at) AS t FROM orders WHERE ${PENDING_REFUND_SQL}`).get().t;
  assert.ok(
    Math.abs(d.refundsOldestWaitingMs - (Date.now() - oldestRefundAt)) < 2000,
    '退款最久等待 = now − refund_requested_at（与 SLA 清单的 ageMs 同一列）'
  );
  assert.ok(d.refundsOldestWaitingMs > 1.9 * HOUR);

  // 空队列的形状：计数 0 时"最久等待"必须是 null（没有等待中的单 ≠ 等了 0 毫秒）
  const empty = queueWait({ where: "status = 'no-such-status'", timeCol: 'updated_at' });
  assert.deepEqual(empty, { count: 0, oldestAt: null, oldestWaitingMs: null });
});

test('待处理退款为空时：refundsPending 0 且 refundsOldestWaitingMs 为 null（不是 0 毫秒）', async () => {
  // 临时清掉"退款申请待决"的标记（本用例只关心空队列的形状），结束后还原
  const ids = db.prepare(`SELECT id FROM orders WHERE ${'refund_status = \'requested\''}`).all().map((r) => r.id);
  assert.ok(ids.length > 0, '前置：夹具里本来有待处理退款');
  const marks = ids.map(() => '?').join(',');
  db.prepare(`UPDATE orders SET refund_status = 'none' WHERE id IN (${marks})`).run(...ids);
  try {
    const d = (await metrics()).body.data;
    assert.equal(d.refundsPending, 0);
    assert.equal(d.refundsOldestWaitingMs, null, '没有等待中的单 ≠ 等了 0 毫秒');
  } finally {
    db.prepare(`UPDATE orders SET refund_status = 'requested' WHERE id IN (${marks})`).run(...ids);
  }
  const back = (await metrics()).body.data;
  assert.equal(back.refundsPending, ids.length, '还原后照旧');
  assert.ok(back.refundsOldestWaitingMs > 0);
});

test('与店主徽标**同一实现**：三个计数与 /orders/seller/status-counts 逐项相等', async () => {
  const m = (await metrics()).body.data;
  const b = await request(app).get('/api/orders/seller/status-counts').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(b);
  const badge = b.body.data;
  assert.equal(m.refundsPending, badge.pendingRefund, '待处理退款：徽标与指标必须同数');
  assert.equal(m.disputesPending, badge.pendingDispute, '待仲裁争议：徽标与指标必须同数');
  assert.equal(m.afterSaleOpen, badge.pendingAfterSale, '在途售后案件：徽标与指标必须同数');
  for (const [k, v] of Object.entries(badge.byStatus)) {
    assert.equal(m.ordersByStatus[k], v, `状态 ${k} 的计数与徽标一致`);
  }
  // 直接调同一实现，确认路由只是转出（没有第二份 SQL）
  const direct = sellerTodoCounts();
  assert.equal(direct.pendingRefund, m.refundsPending);
  assert.equal(
    direct.shipReady,
    db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'escrowed' AND paid_tx_hash IS NOT NULL AND refund_status != 'requested'").get().c
  );
});

test('托管中/已超时：候选 = 在途可释放单（退款冻结单被合约永久拒绝，单列不计也不算超时）', async () => {
  const d = (await metrics()).body.data;
  assert.equal(d.overdueCount, 2, 'shipReady(阈值 500) 与 overdueOld(阈值 400) 均已越过（块高 1000）');
  assert.equal(d.overdueUnknown, 1, '阈值读失败的单计入 unknown——**不是**"未超时"');
  assert.match(String(d.escrowReason), /1 单的释放阈值没读到/);
  assert.equal(d.refundBlockedCount, 2, '退款申请待决：合约 releaseExpired 会 revert RefundPending');
  assert.ok(d.escrowedCount >= 6, '托管中 = 在途（escrowed/shipped/disputed），含被退款冻结的单');

  // 明细读数（SLA 与 metrics 共用同一个 escrowOverdueReading）
  const e = await escrowOverdueReading({ now: Date.now() });
  assert.equal(e.available, true);
  assert.equal(e.latestBlock, 1000);
  assert.equal(e.candidateCount, 4); // shipReady / notOverdue / thresholdFail / overdueOld
  assert.equal(e.refundBlockedCount, 2);
  assert.equal(e.checked, 3);
  assert.equal(e.unknown, 1);
  assert.equal(e.checked + e.unknown, e.candidateCount, '恒等式：没读到的单一定有去处');
  assert.equal(e.truncated, false);
});

test('托管超时读数的边界就是链上阈值：latestBlock > 阈值 才算超时（等于不算）', async () => {
  const before = await escrowOverdueReading({ now: Date.now() });
  // 把 notOverdue 的阈值设成"恰好等于块高"：合约的判据是 block.number <= createdAt+timeout 时仍不可释放
  chain.thresholds.set(F.notOverdue.escrowOrderId.toLowerCase(), 1000n);
  const atBoundary = await escrowOverdueReading({ now: Date.now() });
  assert.equal(atBoundary.overdue, before.overdue, 'latestBlock == 阈值 ⇒ 仍不可释放，不计入超时');
  chain.thresholds.set(F.notOverdue.escrowOrderId.toLowerCase(), 999n);
  const past = await escrowOverdueReading({ now: Date.now() });
  assert.equal(past.overdue, before.overdue + 1, 'latestBlock > 阈值 ⇒ 任何人可 releaseExpired');
  chain.thresholds.set(F.notOverdue.escrowOrderId.toLowerCase(), 2000n); // 还原
});

test('未发货超期清单（SLA）：最久的在前、带 orderId 与 ageMs、limit 生效', async () => {
  const res = await request(app).get('/api/shop/sla').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(res);
  const d = res.body.data;
  assert.equal(d.unshippedOverdueAvailable, true);
  assert.equal(d.unshippedOverdueTotal, 2);
  assert.equal(d.unshippedOverdue.length, 2);
  assert.deepEqual(
    d.unshippedOverdue.map((i) => i.orderId),
    [F.shipReady.id, F.overdueOld.id],
    '按等待时长倒序：shipReady（10 小时）在 overdueOld（8 小时）之前'
  );
  assert.ok(d.unshippedOverdue[0].ageMs > d.unshippedOverdue[1].ageMs, '最久的在前');
  assert.ok(d.unshippedOverdue[0].ageMs > 9.9 * HOUR);
  assert.equal(typeof d.unshippedOverdue[0].orderId, 'string');

  const limited = await request(app).get('/api/shop/sla?limit=1').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.equal(limited.body.data.unshippedOverdue.length, 1);
  assert.equal(limited.body.data.unshippedOverdue[0].orderId, F.shipReady.id);
  assert.equal(limited.body.data.limit, 1);
});

test('SLA limit 参数：0/负数/超上限/非整数一律明确拒绝（不静默截断）', async () => {
  for (const bad of ['0', '-1', '101', 'abc', '1.5']) {
    const r = await request(app).get(`/api/shop/sla?limit=${bad}`).set('Authorization', `Bearer ${ownerToken}`);
    assert.notEqual(r.body.code, 0, `limit=${bad} 必须被拒`);
    assert.match(r.body.message, /limit 需为 1\.\.100/);
  }
  await request(app).get('/api/shop/sla').expect(401);
  const asBuyer = await request(app).get('/api/shop/sla').set('Authorization', `Bearer ${buyerToken}`);
  assert.equal(asBuyer.body.code, 403, 'SLA 是经营面读数：买家令牌不得读');
});

test('挂账余额：payouts 读店主地址、fees 读当前 feeCollector；读不到时字段是 null 而不是 0', async () => {
  chain.payouts = '1234567890000000000';
  chain.fees = '777000';
  chain.feeCollector = COLLECTOR;
  resetFeeCache();
  const d = (await metrics()).body.data;
  assert.equal(d.accruedPayoutsWei, '1234567890000000000');
  assert.equal(d.accruedFeesWei, '777000');
  assert.equal(d.accruedPayoutsReason, null);
  assert.match(d.accruedNote, /\*\*按地址\*\*计/, '口径说明随响应下发（按地址读、历史收取方不在读数内）');
  assert.match(d.accruedNote, /历史收取方/, '已知边界如实写明');

  // 收费方为零地址：没有可读主体 ⇒ 该字段 null + 可读原因（不是 '0'）
  chain.feeCollector = ZERO;
  resetFeeCache();
  const zero = (await metrics()).body.data;
  assert.equal(zero.accruedFeesWei, null, '读不到 ≠ 0：绝不写 "0" 让界面印成"合约里没钱"');
  assert.match(zero.accruedFeesReason, /零地址/);
  assert.equal(zero.accruedPayoutsWei, '1234567890000000000', '两个映射互相独立：收费方缺失不影响店主挂账读数');
  chain.feeCollector = COLLECTOR;
  resetFeeCache();
});

test('对账读数：未跑完一轮时差异数为 null + reason；跑过则差异数 = 修复 + 链上缺失', async () => {
  // 集成：本进程没启动对账任务 ⇒ 快照 enabled=false，读数必须如实标"读不到"
  const d = (await metrics()).body.data;
  assert.equal(d.reconcileMismatches, null, '读不到 ≠ 0 差异');
  assert.equal(d.reconcileLastRunAt, null);
  assert.ok(d.reconcileReason && d.reconcileReason.length > 0);
  // 单元：形状与三态标注（快照来自 chainReconcile.chainReconcileStatus 的唯一事实源）
  const okSnap = reconcileReading({
    enabled: true,
    intervalMs: 600000,
    lastRunAt: 111,
    lastOkAt: 222,
    lastError: null,
    lastScanned: 10,
    lastRepaired: 2,
    lastMissing: 1,
    lastFailed: 3,
    lastAfterSaleScanned: 4,
    lastAfterSaleRepaired: 1,
    minAgeHours: 6,
    afterSaleScanDays: 360,
  });
  assert.equal(okSnap.available, true);
  assert.equal(okSnap.lastRunAt, 111, '最近一轮时间');
  assert.equal(okSnap.differences, 3, '差异数 = repaired 2 + missing 1');
  assert.equal(okSnap.failed, 3, 'failed（读不到）单列，绝不计入差异数');
  const never = reconcileReading({ enabled: false, intervalMs: 0, lastRunAt: null, lastOkAt: null, lastError: null });
  assert.equal(never.available, false);
  assert.equal(never.differences, null);
  assert.match(never.reason, /未启用/);
  assert.throws(() => reconcileReading(undefined), /chainReconcileStatus/, '缺快照是接线错误，必须响亮失败');
});

test('阈值全读不到时：overdue 仍是"确证的 0"，但 unknown = 候选数（checked + unknown 恒等于候选数）', async () => {
  const saved = new Map(chain.thresholds);
  chain.thresholds.clear(); // 候选非空、块高读得到，但每个候选的阈值都读失败
  const r = await escrowOverdueReading({ now: Date.now() });
  assert.equal(r.available, true, 'available 只描述链上那一半：块高读到了');
  assert.equal(r.overdue, 0, '确实**没有读到**超时的单（0 只描述读到的那部分）');
  assert.equal(r.checked, 0);
  assert.equal(r.unknown, r.candidateCount, '全部候选读不到 ⇒ unknown = 候选数，绝不写成"未超时"');
  assert.match(String(r.reason), /没读到/);
  for (const [k, v] of saved) chain.thresholds.set(k, v);
});
