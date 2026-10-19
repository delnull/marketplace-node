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
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { makeCtx, login, assertOk, shopRef, insertOrder as insertOrderRow, insertProduct } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const { ESCROW_ABI } = await import('../src/chain.js');
const { reconcileReading, queueWait, sellerTodoCounts, escrowOverdueReading, promiseSlaReading, PENDING_REFUND_SQL } = await import('../src/opsMetrics.js');
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
async function insertOrder({
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
  const escrowOrderId = escrow ? `0x${String(seq).padStart(64, '0')}` : null;
  if (escrowOrderId && threshold !== null) chain.thresholds.set(escrowOrderId.toLowerCase(), threshold);
  const row = await insertOrderRow(db, {
    // slug 是 CHAR(11)：key 只是本文件的标签（可能比 11 长），所以交给夹具生成
    // （用例按 F[key] 找单，从不按 slug 找）
    buyer: buyer.address.toLowerCase(),
    seller: SELLER,
    amountWei: '1000',
    usdtMicro: 1000000,
    btyUsdtRate: '0.1',
    status,
    /*
      "没有链上镜像行"这一档要**整块不传**链上字段：夹具的门禁拒绝
      `escrowOrderId: null` 与任何链上字段（哪怕值是 null）同时出现——那种组合在 schema 里
      不可表达（order_chain.escrow_order_id 是 NOT NULL），逐个传 null 只会让它响亮失败。
    */
    ...(escrow
      ? {
          escrowOrderId,
          paidTxHash: `0x${String(seq).padStart(64, 'a')}`,
          refundStatus,
          // 时间列只收 Date：调用方传的是毫秒（便于做算术），在这里折一次
          refundRequestedAt: refundRequestedAt === null ? null : new Date(refundRequestedAt),
          afterSaleStatus,
          afterSaleOpenedAt: afterSaleOpenedAt === null ? null : new Date(afterSaleOpenedAt),
          // 事件史里的 at 是**毫秒读数**（不是 DATETIME 列）
          events: escrowedAt === null ? null : [ev('OrderCreated', escrowedAt)],
        }
      : {}),
  });
  F[key] = { orderId: row.orderId, orderNo: row.orderNo, escrowOrderId: row.escrowOrderId };
  return row.orderNo;
}

before(async () => {
  await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
  config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
  resetFeeCache();
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;

  // 待办夹具（覆盖九种状态 + 三队列）
  await insertOrder({ key: 'draft', status: 'draft', escrow: false });
  await insertOrder({ key: 'shipReady', status: 'escrowed', threshold: 500n, escrowedAt: Date.now() - 10 * HOUR }); // 已超时（1000 > 500）
  await insertOrder({ key: 'refundFrozen', status: 'escrowed', threshold: 500n, refundStatus: 'requested', refundRequestedAt: Date.now() - 2 * HOUR });
  await insertOrder({ key: 'refundOnShipped', status: 'shipped', threshold: 900n, refundStatus: 'requested', refundRequestedAt: Date.now() - 1 * HOUR });
  await insertOrder({ key: 'disputed', status: 'disputed', threshold: 500n });
  await insertOrder({ key: 'afterSaleOpen', status: 'confirmed', threshold: 500n, afterSaleStatus: 'open', afterSaleOpenedAt: Date.now() - 3 * HOUR, escrowedAt: Date.now() - 4 * HOUR });
  await insertOrder({ key: 'afterSaleClosed', status: 'settled', threshold: 500n, afterSaleStatus: 'closed', afterSaleOpenedAt: Date.now() - 5 * HOUR });
  await insertOrder({ key: 'refunded', status: 'refunded', threshold: 500n });
  await insertOrder({ key: 'expired', status: 'expired', threshold: 500n });
  await insertOrder({ key: 'cancelled', status: 'cancelled', escrow: false });
  // 托管超时读数的其余候选：未超时 / 阈值读失败 / 另一个已超时（排序用）
  await insertOrder({ key: 'notOverdue', status: 'escrowed', threshold: 2000n, escrowedAt: Date.now() - 6 * HOUR });
  await insertOrder({ key: 'thresholdFail', status: 'shipped', threshold: null, escrowedAt: Date.now() - 5 * HOUR });
  await insertOrder({ key: 'overdueOld', status: 'escrowed', threshold: 400n, escrowedAt: Date.now() - 8 * HOUR });
});

const metrics = async (token = ownerToken) =>
  request(app).get('/api/shop/metrics').set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value).expect(200);

test('ownerOnly：无令牌 401、买家令牌 403（运营读数不进公开面）', async () => {
  await request(app).get('/api/shop/metrics').expect(401);
  const r = await request(app).get('/api/shop/metrics').set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value);
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
  assert.equal(total, (await db.get('SELECT COUNT(*) AS c FROM v_orders')).c, '0 是"确实没有该状态的单"，不是"读不到"');
});

test('待办三队列：计数 + 最久等待（锚点与徽标同源；空队列是 null 而不是 0 毫秒）', async () => {
  const d = (await metrics()).body.data;

  // 待处理退款：谓词 = refund_status='requested' ∧ status ∈ 在途（含 disputed）
  assert.equal(d.refundsPending, 2);
  // 在途售后案件：判据 after_sale_status='open'（案件不动 orders.status）
  assert.equal(d.afterSaleOpen, 1);
  assert.ok(d.afterSaleOldestWaitingMs > 2.9 * HOUR, `最久等待应≈3 小时，实际 ${d.afterSaleOldestWaitingMs}`);
  // 时间列读回来是 Date（不再是毫秒整数）：比时刻要显式 .getTime()
  const openedAt = (await db.get('SELECT after_sale_opened_at AS t FROM v_orders WHERE order_no = ?', F.afterSaleOpen.orderNo)).t.getTime();
  assert.ok(
    Math.abs(d.afterSaleOldestWaitingMs - (Date.now() - openedAt)) < 2000,
    '读数 = now − after_sale_opened_at（锚点列，与仲裁队列同一实现）'
  );
  // 待仲裁争议
  assert.equal(d.disputesPending, 1);
  assert.ok(d.disputesOldestWaitingMs >= 0);

  // 退款队列的最久等待：与另两格**同一算法、同一锚点列**（refund_requested_at）
  // MIN() 对 DATETIME 返回 Date（对 DECIMAL 才会返回字符串）
  const oldestRefundAt = (await db.get(`SELECT MIN(refund_requested_at) AS t FROM v_orders WHERE ${PENDING_REFUND_SQL}`)).t.getTime();
  assert.ok(
    Math.abs(d.refundsOldestWaitingMs - (Date.now() - oldestRefundAt)) < 2000,
    '退款最久等待 = now − refund_requested_at（与 SLA 清单的 ageMs 同一列）'
  );
  assert.ok(d.refundsOldestWaitingMs > 1.9 * HOUR);

  // 空队列的形状：计数 0 时"最久等待"必须是 null（没有等待中的单 ≠ 等了 0 毫秒）
  const empty = await queueWait({ where: "status = 'no-such-status'", timeCol: 'updated_at', seller: null });
  assert.deepEqual(empty, { count: 0, oldestAt: null, oldestWaitingMs: null });
});

test('待处理退款为空时：refundsPending 0 且 refundsOldestWaitingMs 为 null（不是 0 毫秒）', async () => {
  // 临时清掉"退款申请待决"的标记（本用例只关心空队列的形状），结束后还原
  const ids = (await db.all(`SELECT order_id FROM v_orders WHERE ${'refund_status = \'requested\''}`)).map((r) => r.order_id);
  assert.ok(ids.length > 0, '前置：夹具里本来有待处理退款');
  const marks = ids.map(() => '?').join(',');
  await db.run(`UPDATE order_chain SET refund_status = 'none' WHERE order_id IN (${marks})`, ...ids);
  try {
    const d = (await metrics()).body.data;
    assert.equal(d.refundsPending, 0);
    assert.equal(d.refundsOldestWaitingMs, null, '没有等待中的单 ≠ 等了 0 毫秒');
  } finally {
    await db.run(`UPDATE order_chain SET refund_status = 'requested' WHERE order_id IN (${marks})`, ...ids);
  }
  const back = (await metrics()).body.data;
  assert.equal(back.refundsPending, ids.length, '还原后照旧');
  assert.ok(back.refundsOldestWaitingMs > 0);
});

test('与店主徽标**同一实现**：三个计数与 /orders/seller/status-counts 逐项相等', async () => {
  const m = (await metrics()).body.data;
  const b = await request(app).get('/api/orders/seller/status-counts').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(b);
  const badge = b.body.data;
  assert.equal(m.refundsPending, badge.pendingRefund, '待处理退款：徽标与指标必须同数');
  assert.equal(m.disputesPending, badge.pendingDispute, '待仲裁争议：徽标与指标必须同数');
  assert.equal(m.afterSaleOpen, badge.pendingAfterSale, '在途售后案件：徽标与指标必须同数');
  for (const [k, v] of Object.entries(badge.byStatus)) {
    assert.equal(m.ordersByStatus[k], v, `状态 ${k} 的计数与徽标一致`);
  }
  // 直接调同一实现，确认路由只是转出（没有第二份 SQL）
  const direct = await sellerTodoCounts(null);
  assert.equal(direct.pendingRefund, m.refundsPending);
  assert.equal(
    direct.shipReady,
    (await db.get("SELECT COUNT(*) AS c FROM v_orders WHERE status = 'escrowed' AND paid_tx_hash IS NOT NULL AND refund_status != 'requested'")).c
  );
});

test('托管中/已超时：候选 = 在途可释放单（退款冻结单被合约永久拒绝，单列不计也不算超时）', async () => {
  const d = (await metrics()).body.data;
  assert.equal(d.overdueCount, 2, 'shipReady(阈值 500) 与 overdueOld(阈值 400) 均已越过（块高 1000）');
  assert.equal(d.overdueUnknown, 1, '阈值读失败的单计入 unknown——**不是**"未超时"');
  assert.match(String(d.escrowReason), /1 单的释放阈值没读到/);
  /*
    ⚠️ 那句原因的**下半句必须说实话**（2026-10-16 收口）：候选多于单轮读取上限时，超出的部分
    **每一轮都会被同一个上限截断**——它们不是"这次没读到、下轮重试"，而是**永远不会被读到**。
    旧文案把两者混成一句"下轮重试"，运维照着反复重试永远不收敛（而 `truncated` 字段早就在返回里）。
    本用例的 4 个候选都在上限（100）之内，所以这一条同时钉住"**别把没超限的也说成超限**"。
  */
  assert.doesNotMatch(String(d.escrowReason), /超出单轮读取上限/, '候选没超限时不得声称被截断');
  assert.doesNotMatch(String(d.escrowReason), /每轮都不会读到/, '同上：截断那句话只在真的截断时出现');
  assert.equal(d.refundBlockedCount, 2, '退款申请待决：合约 releaseExpired 会 revert RefundPending');
  assert.ok(d.escrowedCount >= 6, '托管中 = 在途（escrowed/shipped/disputed），含被退款冻结的单');

  // 明细读数（SLA 与 metrics 共用同一个 escrowOverdueReading）
  const e = await escrowOverdueReading({ now: Date.now(), seller: null });
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
  const before = await escrowOverdueReading({ now: Date.now(), seller: null });
  // 把 notOverdue 的阈值设成"恰好等于块高"：合约的判据是 block.number <= createdAt+timeout 时仍不可释放
  chain.thresholds.set(F.notOverdue.escrowOrderId.toLowerCase(), 1000n);
  const atBoundary = await escrowOverdueReading({ now: Date.now(), seller: null });
  assert.equal(atBoundary.overdue, before.overdue, 'latestBlock == 阈值 ⇒ 仍不可释放，不计入超时');
  chain.thresholds.set(F.notOverdue.escrowOrderId.toLowerCase(), 999n);
  const past = await escrowOverdueReading({ now: Date.now(), seller: null });
  assert.equal(past.overdue, before.overdue + 1, 'latestBlock > 阈值 ⇒ 任何人可 releaseExpired');
  chain.thresholds.set(F.notOverdue.escrowOrderId.toLowerCase(), 2000n); // 还原
});

test('未发货超期清单（SLA）：最久的在前、带 orderId 与 ageMs、limit 生效', async () => {
  const res = await request(app).get('/api/shop/sla').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(res);
  const d = res.body.data;
  assert.equal(d.unshippedOverdueAvailable, true);
  assert.equal(d.unshippedOverdueTotal, 2);
  assert.equal(d.unshippedOverdue.length, 2);
  assert.deepEqual(
    d.unshippedOverdue.map((i) => i.orderId),
    [F.shipReady.orderNo, F.overdueOld.orderNo],
    '按等待时长倒序：shipReady（10 小时）在 overdueOld（8 小时）之前'
  );
  assert.ok(d.unshippedOverdue[0].ageMs > d.unshippedOverdue[1].ageMs, '最久的在前');
  assert.ok(d.unshippedOverdue[0].ageMs > 9.9 * HOUR);
  assert.equal(typeof d.unshippedOverdue[0].orderId, 'string');

  const limited = await request(app).get('/api/shop/sla?limit=1').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assert.equal(limited.body.data.unshippedOverdue.length, 1);
  assert.equal(limited.body.data.unshippedOverdue[0].orderId, F.shipReady.orderNo);
  assert.equal(limited.body.data.limit, 1);
});

test('SLA limit 参数：0/负数/超上限/非整数一律明确拒绝（不静默截断）', async () => {
  for (const bad of ['0', '-1', '101', 'abc', '1.5']) {
    const r = await request(app).get(`/api/shop/sla?limit=${bad}`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value);
    assert.notEqual(r.body.code, 0, `limit=${bad} 必须被拒`);
    assert.match(r.body.message, /limit 需为 1\.\.100/);
  }
  await request(app).get('/api/shop/sla').expect(401);
  const asBuyer = await request(app).get('/api/shop/sla').set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value);
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
  const r = await escrowOverdueReading({ now: Date.now(), seller: null });
  assert.equal(r.available, true, 'available 只描述链上那一半：块高读到了');
  assert.equal(r.overdue, 0, '确实**没有读到**超时的单（0 只描述读到的那部分）');
  assert.equal(r.checked, 0);
  assert.equal(r.unknown, r.candidateCount, '全部候选读不到 ⇒ unknown = 候选数，绝不写成"未超时"');
  assert.match(String(r.reason), /没读到/);
  for (const [k, v] of saved) chain.thresholds.set(k, v);
});

test('店铺维度读数：走 shopWhere(seller, "sh.") 的前缀参数（低库存与承诺对账都不做 o.→sh. 文本替换）', async () => {
  /*
    这两条读数要 JOIN shops（商品行只有 shop_code，而入参是 seller，见 shopWhere），
    表别名是 `sh`。旧实现把 `s.where` 里的第一个 `o.` 用字符串替换改成 `sh.`——
    谓词今天只有一个 `o.`，所以它"恰好"正确；将来谓词里出现第二个 `o.` 时会静默拼错别名，
    而 SQL 只在运行时报"列不存在"。现在前缀由 shopWhere 的形参给：两个消费点各自显式传 `sh.`，
    这里用**非 null seller** 真跑一遍（漏传前缀的查询会当场 Unknown column）。
  */
  const product = await insertProduct(db, {
    title: '低库存 + 承诺对账商品',
    shopCode: shopRef.value,
    // 余量 1 ≤ 阈值 2 ⇒ 计入低库存
    skus: [{ key: '', priceUsdtMicro: 5_000_000, capacity: 1, committed: 0 }],
    stockAlertAt: 2,
    terms: { handling_days: 2 },
  });

  const todos = await sellerTodoCounts(SELLER);
  assert.ok(todos.lowStockProducts >= 1, `低库存必须按本店 seller 过滤并计数（实际 ${todos.lowStockProducts}）`);
  const otherSeller = '0x' + '34'.repeat(20);
  assert.equal((await sellerTodoCounts(otherSeller)).lowStockProducts, 0, '别家店不得看到本店低库存商品');

  const promises = await promiseSlaReading(Date.now(), 30, SELLER);
  assert.ok(promises.some((p) => p.slug === product.slug), '承诺对账按 sh.seller 过滤出本店商品');
  assert.equal(
    (await promiseSlaReading(Date.now(), 30, otherSeller)).some((p) => p.slug === product.slug),
    false,
    '别家店不得看到本店承诺对账行'
  );

  // 徽标端点消费的也是同一个 sellerTodoCounts（本店 seller 由中间件解析，见 routes/orders.js）
  const badge = await request(app)
    .get('/api/orders/seller/status-counts')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.ok(badge.body.data.lowStockProducts >= 1, '徽标里的低库存同样来自 sh.seller 过滤');

  // 形状守卫：别名前缀只能由 shopWhere 的形参给——代码里不再有"把 o. 文本替换成 sh."这条路径
  // （行为测试抓不到它：谓词里今天只有一个 `o.`，替换"恰好"正确；第二个 `o.` 出现时才会静默拼错）。
  // 注释里的举例不算代码：去掉注释再扫。
  const codeOnly = readFileSync(new URL('../src/opsMetrics.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /\.where\.replace\(/, '不得再用字符串替换改 SQL 别名');
});
