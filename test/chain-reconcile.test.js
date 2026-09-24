/**
 * 链上状态对账（chainReconcile）单测——**不触链**：链上订单读取器经 setChainOrderFetcher 注入
 * （与 netguard.setLookupAll / webhook.setWebhookSender 同款测试注入点）。
 *
 * 覆盖：
 *  - planChainRepair 纯函数口径（全额退→refunded / 拆分或判卖家→settled / Disputed→disputed；
 *    本地已终态永不回退）；
 *  - 对账轮：链上已终局而本地滞留 → 改状态 + 回填 refunded_amount_wei + 补 `Sync:` 事件史镜像
 *    + 告警一次（幂等）；链上 None 且本地已有支付凭证 → 只告警不改状态；
 *  - 安全边界：诱饵单（买家/金额不符）跳过、RPC 失败不当成"链上无单"、静置不足与已终态不进候选；
 *  - 批量上限（最旧的先修，其余下轮）与 MK_ESCROW_ADDRESS 未配置时整体跳过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

// 重试退避调小（运维参数，config 顶层求值时读取——须在 makeCtx 之前设置）
process.env.MK_WEBHOOK_RETRY_MS = '20';

const ctx = await makeCtx();
const { db } = ctx;

// 通知走同一套 webhook（URL 存 kv；注入捕获型 sender）
const { kvSet } = await import('../src/db.js');
kvSet('mk:webhook_url', 'https://93.184.216.34/hook/reconcile');
const { setWebhookSender } = await import('../src/webhook.js');
const config = (await import('../src/config.js')).default;
const {
  planChainRepair,
  reconcileChainOnce,
  startChainReconcile,
  setChainOrderFetcher,
} = await import('../src/chainReconcile.js');
// 链上终局 → 本地终态的唯一实现（/sync 与对账共用；本文件直测纯函数口径）
const { mapChainTerminal } = await import('../src/escrowWatcher.js');

const BUYER = '0x00000000000000000000000000000000000000aa';
const SELLER = '0x00000000000000000000000000000000000000bb';
const AMOUNT = '1000000000000000000';
const HOUR = 3600_000;

/** 捕获型 sender（notifyRaw 为 fire-and-forget：投递前还有异步 SSRF 校验，断言前需让出微任务） */
const sent = [];
setWebhookSender(async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200 };
});
const flushDeliveries = () => new Promise((r) => setTimeout(r, 40));
/** 有界轮询等待（投递结算是异步的：固定 sleep 在整套测试并行跑时会偶发不够） */
async function waitUntil(pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  return pred();
}

/** 链上真值桩：orderIdHex → getOrder 形状（'THROW' = RPC 读取失败） */
const chainState = new Map();
const chainOrder = (overrides = {}) => ({
  buyer: BUYER,
  seller: SELLER,
  amount: AMOUNT,
  refundedAmount: '0',
  createdAtBlock: 42,
  status: 'Created',
  ...overrides,
});
setChainOrderFetcher(async (orderIdHex) => {
  const v = chainState.get(orderIdHex);
  if (v === 'THROW') throw new Error('rpc down');
  return v || chainOrder({ status: 'None' });
});

let seq = 0;
/** 直接插本地订单行（跳过下单 API：对账只关心本地行 + 链上真值） */
function insertOrder({ status = 'escrowed', paid = true, ageMs = 12 * HOUR, buyer = BUYER } = {}) {
  seq += 1;
  const id = `rc-${seq}`;
  const escrowOrderId = `0x${String(seq).padStart(64, '0')}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, cny_fen, bty_usdt_rate, usdt_cny_rate, status, escrow_order_id, paid_tx_hash, created_at, updated_at)
     VALUES (?, 'p-x', '{}', '0x00', '', ?, ?, ?, 100, '0.1', '7.2', ?, ?, ?, ?, ?)`
  ).run(
    id,
    buyer,
    SELLER,
    AMOUNT,
    status,
    escrowOrderId,
    paid ? `0x${String(seq).padStart(64, 'f')}` : null,
    now,
    now - ageMs
  );
  return { id, escrowOrderId };
}

const rowOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const statusOf = (id) => rowOf(id).status;
const eventNames = (id) => (JSON.parse(rowOf(id).onchain_events || '[]') || []).map((e) => e.name);
const ageRow = (id, hours) => db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(Date.now() - hours * HOUR, id);

test('planChainRepair：链上终局/争议 → 本地映射（与 watcher 同口径）；本地终态永不回退', () => {
  const local = { status: 'escrowed', amount_wei: AMOUNT, paid_tx_hash: '0xaa' };
  // 判卖家/确认/超时释放都是链上 Settled：链上状态本身无法区分，本地统一落 settled（成交流水口径）
  const settled = planChainRepair(local, { status: 'Settled', refundedAmount: '0' });
  assert.equal(settled.action, 'repair');
  assert.equal(settled.to, 'settled');
  assert.equal(settled.refundedAmountWei, '0');
  // 全额退款 → refunded（与 settleByRefundSplit 同判据：refundWei >= amount）
  assert.equal(planChainRepair(local, { status: 'Refunded', refundedAmount: AMOUNT }).to, 'refunded');
  // 部分退款 → settled，且已退金额原样记录（账本净额口径）。链上能给出中间值的有两条出口：
  // 仲裁人的 arbitrate（任意比例）与 approveRefund==acceptedPartialRefund（买家已精确授权），
  // 所以这种镜像既可能来自裁决，也可能来自双方谈拢后卖家的执行。
  const partial = planChainRepair(local, { status: 'Settled', refundedAmount: '400000000000000000' });
  assert.equal(partial.to, 'settled');
  assert.equal(partial.refundedAmountWei, '400000000000000000');
  // 争议
  assert.equal(planChainRepair(local, { status: 'Disputed' }).to, 'disputed');
  // 已一致 / 链上仍在途 → 不动
  assert.equal(planChainRepair({ ...local, status: 'disputed' }, { status: 'Disputed' }).action, 'none');
  assert.equal(planChainRepair({ ...local, status: 'settled' }, { status: 'Settled', refundedAmount: '0' }).action, 'none');
  assert.equal(planChainRepair(local, { status: 'Created' }).action, 'none');
  // 链上查不到：escrowed + 有支付凭证 → 只告警（missing），绝不改状态
  assert.equal(planChainRepair(local, { status: 'None' }).action, 'missing');
  assert.equal(planChainRepair({ ...local, paid_tx_hash: null }, { status: 'None' }).action, 'none');
  assert.equal(planChainRepair({ ...local, status: 'shipped' }, { status: 'None' }).action, 'none');
  // 本地已终态：链上说什么都不回退（回退会复活已释放的占位/已结算的流水）
  for (const st of ['confirmed', 'settled', 'refunded', 'expired']) {
    assert.equal(planChainRepair({ ...local, status: st }, { status: 'Refunded', refundedAmount: AMOUNT }).action, 'none', `${st} 不回退`);
  }
  /*
    `cancelled` **不是**这一面上的终态（源码审计 2026-09）：草稿被清扫/取消之后买家才完成支付
    是真实竞态，而 watcher 的事件路径早就接受 cancelled → 终态（"卖家流水不再漏计"）。
    对账必须与 watcher 同口径，否则那个竞态里"事件漏扫 + 本地 cancelled"就三条路径都碰不到。
    cancelled 行取消时已释放占位，迁移无占位副作用。
  */
  assert.equal(planChainRepair({ ...local, status: 'cancelled' }, { status: 'Refunded', refundedAmount: AMOUNT }).to, 'refunded');
  assert.equal(planChainRepair({ ...local, status: 'cancelled' }, { status: 'Disputed' }).to, 'disputed');
  // 链上查不到时仍是"不动"：从未支付的取消草稿不会因为这一改动被误改
  assert.equal(planChainRepair({ ...local, status: 'cancelled' }, { status: 'None' }).action, 'none');
});

/**
 * `mapChainTerminal` 是"链上终局 → 本地终态"的**唯一实现**（事件/对账/手动 sync 三条路径共用）。
 * 这里直测纯函数口径：链上状态自报 Refunded 时短路（连金额都不必看），否则按"退给买家的钱是否
 * 等于托管额"分岔；脏数据（NaN/垃圾串/负数/缺字段）一律按 0 处理，永不抛错。
 */
test('mapChainTerminal：链上终局 → 本地终态的唯一实现（含脏数据容错）', () => {
  const A = AMOUNT;
  // 链上自报全额退款：无论金额字段如何都落 refunded（链上状态是权威）
  assert.equal(mapChainTerminal('Refunded', A, A), 'refunded');
  assert.equal(mapChainTerminal('Refunded', '0', A), 'refunded', '状态自报 Refunded 即短路（不看金额）');
  // Settled：只有"全额退给买家"才落 refunded
  assert.equal(mapChainTerminal('Settled', '0', A), 'settled', '0 = 全额判卖家');
  assert.equal(mapChainTerminal('Settled', (BigInt(A) / 2n).toString(), A), 'settled', '仲裁拆分 → 成交向终态');
  assert.equal(mapChainTerminal('Settled', A, A), 'refunded', '退满托管额 = 全额退款');
  assert.equal(mapChainTerminal('Settled', (BigInt(A) + 1n).toString(), A), 'refunded', '超过托管额（脏数据）也按全额退');
  // 参数类型稳健：string / number / bigint 均可
  assert.equal(mapChainTerminal('Settled', 1000, 1000n), 'refunded');
  assert.equal(mapChainTerminal('Settled', BigInt(999), '1000'), 'settled');
  // 解析失败 / 缺字段 / 负数 → 按 0 处理，永不抛错
  for (const bad of ['garbage', '', '  ', NaN, null, undefined, -1, '1.5']) {
    assert.equal(mapChainTerminal('Settled', bad, A), 'settled', `refundedAmount=${String(bad)} 应安全按 0 处理`);
  }
  assert.equal(mapChainTerminal('Settled', A, 'garbage'), 'settled', '托管额脏数据 ⇒ 0 ⇒ 不判全额退');
  assert.equal(mapChainTerminal(undefined, A, A), 'refunded', '状态缺失时仍按金额判定');
  // 与 planChainRepair 同口径（后者就是调它）
  const local = { status: 'escrowed', amount_wei: A, paid_tx_hash: '0xaa' };
  for (const onchain of [
    { status: 'Settled', refundedAmount: '0' },
    { status: 'Settled', refundedAmount: (BigInt(A) / 2n).toString() },
    { status: 'Refunded', refundedAmount: A },
    { status: 'Refunded', refundedAmount: '0' },
  ]) {
    assert.equal(
      planChainRepair(local, onchain).to,
      mapChainTerminal(onchain.status, onchain.refundedAmount, A),
      `planChainRepair 必须直接复用 mapChainTerminal（${onchain.status}/${onchain.refundedAmount}）`
    );
  }
});

test('对账修复：链上已终局而本地滞留 → 改状态 + 记录已退金额 + Sync 镜像 + 每单告警一次（幂等）', async () => {
  sent.length = 0;
  const toSettled = insertOrder({ status: 'escrowed' });
  const toRefunded = insertOrder({ status: 'shipped' });
  const toDisputed = insertOrder({ status: 'escrowed' });
  const alreadyMatched = insertOrder({ status: 'disputed' });
  const chainInFlight = insertOrder({ status: 'escrowed' });
  chainState.set(toSettled.escrowOrderId, chainOrder({ status: 'Settled', refundedAmount: '0' }));
  chainState.set(toRefunded.escrowOrderId, chainOrder({ status: 'Refunded', refundedAmount: AMOUNT }));
  chainState.set(toDisputed.escrowOrderId, chainOrder({ status: 'Disputed' }));
  chainState.set(alreadyMatched.escrowOrderId, chainOrder({ status: 'Disputed' }));
  chainState.set(chainInFlight.escrowOrderId, chainOrder({ status: 'Created' }));

  const r = await reconcileChainOnce();
  assert.equal(r.scanned, 5);
  assert.equal(r.repaired, 3);
  assert.equal(statusOf(toSettled.id), 'settled');
  assert.equal(statusOf(toRefunded.id), 'refunded');
  assert.equal(statusOf(toDisputed.id), 'disputed');
  assert.equal(statusOf(alreadyMatched.id), 'disputed', '本来就一致：不动');
  assert.equal(statusOf(chainInFlight.id), 'escrowed', '链上仍在途：不动（等事件/超时）');
  // 已退金额以链上真值为准（账本净额与退款口径的依据）
  assert.equal(rowOf(toRefunded.id).refunded_amount_wei, AMOUNT);
  assert.equal(rowOf(toSettled.id).refunded_amount_wei, '0');
  // Sync: 镜像：UI 时间线上能看出"这一步是节点对账改的，不是链上事件推的"
  assert.deepEqual(eventNames(toSettled.id), ['Sync:settled']);
  assert.deepEqual(eventNames(toRefunded.id), ['Sync:refunded']);
  assert.deepEqual(eventNames(toDisputed.id), ['Sync:disputed']);
  assert.deepEqual(eventNames(chainInFlight.id), [], '未修复的行不写镜像');

  await flushDeliveries();
  const repairedMsgs = sent.filter((s) => s.body.type === 'order.chain_repaired');
  assert.equal(repairedMsgs.length, 3, '三个修复各告警一次');
  const payload = repairedMsgs.find((s) => s.body.orderId === toRefunded.id).body;
  assert.equal(payload.from, 'shipped');
  assert.equal(payload.to, 'refunded');
  assert.equal(payload.refundedAmountWei, AMOUNT);
  assert.equal(payload.escrowOrderId, toRefunded.escrowOrderId);
  // payload 无 PII（与 webhook.js 的隐私边界一致）
  for (const k of ['address', 'shipping', 'buyer', 'note', 'phone', 'name']) {
    assert.ok(!(k in payload), `告警 payload 不应含 ${k}`);
  }

  // 幂等：已修好的行成为终态，第二轮不再有修复动作（仍非终态的行会被重新读一次链上真值，
  // 但它们的判定是"不动"——这正是游标轮转的预期行为，见 reconcileChainOnce 的游标说明）
  sent.length = 0;
  const r2 = await reconcileChainOnce();
  assert.equal(r2.repaired, 0);
  assert.equal(statusOf(toRefunded.id), 'refunded');
  assert.equal(statusOf(toSettled.id), 'settled');
  await flushDeliveries();
  assert.equal(sent.length, 0);
});

test('链上查不到（None）而本地 escrowed + 有支付凭证：不改状态，只告警一次', async () => {
  sent.length = 0;
  const ghost = insertOrder({ status: 'escrowed' });
  chainState.set(ghost.escrowOrderId, chainOrder({ status: 'None' }));
  const r = await reconcileChainOnce();
  assert.equal(r.missing, 1);
  assert.equal(r.repaired, 0);
  assert.equal(statusOf(ghost.id), 'escrowed', '绝不据"链上查不到"改状态（可能只是 RPC 读到错链/合约）');
  assert.ok(rowOf(ghost.id).paid_tx_hash, '支付凭证原样保留');
  assert.deepEqual(eventNames(ghost.id), []);
  await flushDeliveries();
  assert.deepEqual(sent.map((s) => s.body.type), ['order.chain_missing']);
  assert.match(sent[0].body.reason, /链上查不到/);

  // 再扫一轮（把静置锚点改回旧值）：仍不改状态，且不重复告警（kv 标记，防刷屏）
  sent.length = 0;
  ageRow(ghost.id, 12);
  const r2 = await reconcileChainOnce();
  assert.equal(r2.missing, 1);
  assert.equal(statusOf(ghost.id), 'escrowed');
  await flushDeliveries();
  assert.equal(sent.length, 0, '同一订单只告警一次');

  // 链上真值恢复可见后该单被修复：修复告警照发（两类告警各自"每单一次"，互不吞掉）
  sent.length = 0;
  chainState.set(ghost.escrowOrderId, chainOrder({ status: 'Settled', refundedAmount: '0' }));
  const r3 = await reconcileChainOnce();
  assert.equal(r3.repaired, 1);
  assert.equal(statusOf(ghost.id), 'settled');
  await flushDeliveries();
  assert.deepEqual(sent.map((s) => s.body.type), ['order.chain_repaired'], '缺失告警不吞掉后续的修复告警');
});

test('安全边界：诱饵单跳过、RPC 失败不当成"链上无单"、静置不足与已终态不进候选', async () => {
  sent.length = 0;
  const decoy = insertOrder({ status: 'escrowed' });
  // 他人对同一 orderId 的 1 wei 诱饵单：金额/买家与本地锁定不符
  chainState.set(decoy.escrowOrderId, chainOrder({ status: 'Settled', refundedAmount: '0', buyer: '0x00000000000000000000000000000000000000cc' }));
  const rpcDown = insertOrder({ status: 'escrowed' });
  chainState.set(rpcDown.escrowOrderId, 'THROW');
  const tooFresh = insertOrder({ status: 'escrowed', ageMs: 60_000 }); // 刚动过：交给 watcher/paid
  chainState.set(tooFresh.escrowOrderId, chainOrder({ status: 'Refunded', refundedAmount: AMOUNT }));
  const terminal = insertOrder({ status: 'confirmed', ageMs: 30 * 24 * HOUR }); // 已终态
  chainState.set(terminal.escrowOrderId, chainOrder({ status: 'Refunded', refundedAmount: AMOUNT }));

  const r = await reconcileChainOnce();
  assert.equal(r.repaired, 0);
  assert.equal(r.skippedRows, 2, '诱饵单与 RPC 失败各记一次跳过（其余候选行判定为"不动"）');
  assert.equal(statusOf(decoy.id), 'escrowed', '诱饵单不得驱动本地状态');
  assert.equal(statusOf(rpcDown.id), 'escrowed', 'RPC 失败必须重试，不能当成"链上没有"');
  assert.equal(statusOf(tooFresh.id), 'escrowed', '静置不足的订单不进候选（若进了会被链上 Refunded 改掉）');
  assert.equal(statusOf(terminal.id), 'confirmed', '已终态永不触碰');
  await flushDeliveries();
  assert.equal(sent.length, 0, '边界场景不产生修复/缺失告警');
});

test('单轮批量上限与 kv 游标轮转：最旧的先修，且没有候选会被永久跳过', async () => {
  const { kvSet, kvGet } = await import('../src/db.js');
  // 年龄取得远大于其它用例的行，保证本用例的三单排在候选集最前（与文件内其它用例解耦）
  const oldest = insertOrder({ status: 'escrowed', ageMs: 300 * HOUR });
  const middle = insertOrder({ status: 'escrowed', ageMs: 290 * HOUR });
  const newest = insertOrder({ status: 'escrowed', ageMs: 280 * HOUR });
  for (const o of [oldest, middle, newest]) chainState.set(o.escrowOrderId, chainOrder({ status: 'Settled', refundedAmount: '0' }));
  kvSet('mk:chain_reconcile_cursor', ''); // 用例内自定起点：从候选集开头开始
  const r = await reconcileChainOnce({ batch: 2 });
  assert.equal(r.scanned, 2);
  assert.equal(r.repaired, 2);
  assert.equal(statusOf(oldest.id), 'settled', '最旧的优先');
  assert.equal(statusOf(middle.id), 'settled');
  assert.equal(statusOf(newest.id), 'escrowed', '超出批量：本轮不修');
  // 游标停在上一轮复查到的最后一单：下一轮从它之后继续（不重复打已复查过的单的 RPC）
  assert.equal(JSON.parse(kvGet('mk:chain_reconcile_cursor')).id, middle.id, '游标已推进');
  // 继续轮转（每轮 2 单）直到覆盖到 newest：候选集会被完整走一遍——
  // 若没有游标，"最旧的 2 单"（在途且长时间不变的单）会永远占满批量，后面的单永远复查不到
  let guard = 0;
  while (statusOf(newest.id) === 'escrowed' && guard < 20) {
    await reconcileChainOnce({ batch: 2 });
    guard += 1;
  }
  assert.equal(statusOf(newest.id), 'settled', '轮转最终覆盖全部候选');
  assert.ok(guard < 20, '轮转在有限轮数内推进（不空转）');
});

/**
 * 一次性告警的「投递成功才写幂等标记」（2026-09 修复）。
 * 原来 alertOnce 是「先 kvSet(ackKey,'1') 再 notifyRaw(...)」：投递失败（URL 写错 / 被 SSRF 拦下 /
 * 店主服务器 5xx / 超时）标记也已写死 ⇒ 店主**永远**收不到"链上查不到该托管单、本地却有支付凭证"
 * 这条必须人工核实的告警。现在标记只在投递成功后写：失败 ⇒ 不写 ⇒ 下一轮对账仍会告警（at-least-once）。
 */
test('缺失告警：投递失败不写幂等标记（下一轮对账会重试）；投递成功后写标记且不再重复', async () => {
  const { kvSet } = await import('../src/db.js');
  // 静置取极大值：保证排在候选集最前，不受文件内其它用例与游标影响
  const ghost = insertOrder({ status: 'escrowed', ageMs: 500 * HOUR });
  chainState.set(ghost.escrowOrderId, chainOrder({ status: 'None' }));
  const ackKey = `mk:chain_reconcile_notified:order.chain_missing:${ghost.id}`;
  const flagged = () => ((db.prepare('SELECT value FROM kv WHERE key = ?').get(ackKey) || {}).value || '') === '1';
  const scan = () => {
    kvSet('mk:chain_reconcile_cursor', ''); // 用例内自定起点：每轮都从候选集开头复查
    return reconcileChainOnce();
  };

  // 1) 投递总是失败（等价于 URL 写错 / 被 SSRF 拦下 / 店主服务器 500 / 超时）
  let attempts = 0;
  setWebhookSender(async () => {
    attempts += 1;
    throw new Error('HTTP 500');
  });
  sent.length = 0;
  assert.equal((await scan()).missing, 1, '本地 escrowed + 有凭证、链上查不到 ⇒ 告警场景成立');
  assert.ok(await waitUntil(() => attempts === 3), '投递方重试 2 次（共 3 次尝试）后结算失败');
  assert.equal(flagged(), false, '投递失败：不得写幂等标记（写死 = 店主永远收不到这条告警）');

  // 2) 下一轮对账：没写标记 ⇒ 仍会告警 —— 这就是 at-least-once
  sent.length = 0;
  assert.equal((await scan()).missing, 1, '下一轮仍判定为 missing');
  assert.ok(await waitUntil(() => attempts === 6), '第二轮同样重试到结算');
  assert.equal(flagged(), false, '仍未送达 ⇒ 仍未写标记');

  // 3) 店主服务器恢复：投递成功 ⇒ 写标记；此后再扫不再重复告警
  setWebhookSender(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  });
  sent.length = 0;
  assert.equal((await scan()).missing, 1);
  assert.ok(await waitUntil(() => sent.some((s) => s.body.type === 'order.chain_missing')), '这次送达了');
  assert.ok(await waitUntil(flagged), '投递成功后才写幂等标记');
  sent.length = 0;
  assert.equal((await scan()).missing, 1, '链上仍查不到：每轮都会判定为 missing');
  await flushDeliveries();
  assert.equal(sent.filter((s) => s.body.type === 'order.chain_missing').length, 0, '已成功告警过：不再重复推');
});

test('startChainReconcile：未配置托管合约时不启动（对账同样跳过）；已配置返回定时器', async () => {
  const saved = config.chain.escrowAddress;
  config.chain.escrowAddress = '';
  try {
    assert.equal(startChainReconcile(), null, 'MK_ESCROW_ADDRESS 未配置：没有链就没有对账');
    const r = await reconcileChainOnce();
    assert.equal(r.skipped, true);
    assert.match(r.reason, /MK_ESCROW_ADDRESS/);
  } finally {
    config.chain.escrowAddress = saved;
  }
  const timer = startChainReconcile();
  assert.ok(timer, '已配置托管合约：启动周期对账并立即执行一次');
  clearInterval(timer);
});

/* ══════════════════════════════════════════════════════════════════════
   链上 Created + 本地 draft/cancelled ⇒ **恢复订单**（源码审计 2026-09 复审，P1）

   这一类是"付款已上链、OrderCreated 漏扫"的残镜像：漏扫后草稿 TTL 清扫器
   （或买家 /cancel）把行置 cancelled，而 cancelled 行按规矩 paid_tx_hash 必为空，
   连 order.chain_missing（要求有凭证）都进不去。
   旧实现在这里统一 action:'none' ⇒ 这一单**没有任何自动路径能救**：
   买家资金锁在托管里最长一个超时窗口、页面却显示"已取消"、占位已释放（可再售 → 超卖）、
   店主面板没有这张单、零告警；超时释放后本地落 expired（∈ INCOME_STATUS）——
   等于为一笔"已取消"的账记进卖家流水。
   ══════════════════════════════════════════════════════════════════════ */

test('planChainRepair：链上 Created + 本地 draft/cancelled ⇒ 恢复；在途 escrowed 不动', () => {
  const base = { amount_wei: AMOUNT, paid_tx_hash: null };
  for (const st of ['draft', 'cancelled']) {
    const p = planChainRepair({ ...base, status: st }, { status: 'Created' });
    assert.equal(p.action, 'restore', `链上资金仍在托管而本地是 ${st}：必须恢复`);
    assert.equal(p.to, undefined, 'restore 分支不带 to（目标状态由恢复逻辑自己决定）');
  }
  // 本地已在途（escrowed/shipped/disputed）：链上 Created 就是它的正常镜像，无事可做
  for (const st of ['escrowed', 'shipped', 'disputed']) {
    assert.equal(planChainRepair({ ...base, status: st }, { status: 'Created' }).action, 'none', `${st} 不动`);
  }
  // 本地已终态：绝不回退（回退会复活已释放的占位/已结算的流水）
  for (const st of ['confirmed', 'settled', 'refunded', 'expired']) {
    assert.equal(planChainRepair({ ...base, status: st }, { status: 'Created' }).action, 'none', `${st} 不回退`);
  }
});

test('对账轮：链上 Created + 本地 cancelled ⇒ 置回 escrowed + 补 `Sync:` 镜像 + 告警一次', async () => {
  const { id, escrowOrderId } = insertOrder({ status: 'cancelled', paid: false });
  chainState.set(escrowOrderId, chainOrder({ status: 'Created', refundedAmount: '0' }));

  const r = await reconcileChainOnce({ minAgeMs: 0, batch: 50 });
  assert.ok(r.repaired >= 1, `本轮应修复至少这一单（实际 ${JSON.stringify(r)}）`);
  assert.equal(statusOf(id), 'escrowed', '本地必须从 cancelled 收敛到 escrowed');
  assert.ok(eventNames(id).includes('Sync:escrowed'), '补一条 Sync 镜像（UI 能看出这一步是对账改的）');
  await waitUntil(() => sent.some((s) => s.body.type === 'order.chain_repaired' && s.body.orderId === id));
  assert.ok(
    sent.some((s) => s.body.type === 'order.chain_repaired' && s.body.orderId === id),
    '恢复要推 order.chain_repaired（店主必须知道这张单被救回来了）'
  );

  // 幂等：下一轮不再是候选（已成 escrowed，且链上 Created 对 escrowed 是正常镜像）
  const before = eventNames(id).length;
  await reconcileChainOnce({ minAgeMs: 0, batch: 50 });
  assert.equal(eventNames(id).length, before, '重复对账不重复写事件史');
});

test('对账轮：链上 Created 且 refundRequested ⇒ 一并回填退款冻结标记（否则店主照常发货 = 钱货两空）', async () => {
  const { id, escrowOrderId } = insertOrder({ status: 'cancelled', paid: false });
  chainState.set(
    escrowOrderId,
    chainOrder({ status: 'Created', refundRequested: true, refundRejected: false })
  );

  await reconcileChainOnce({ minAgeMs: 0, batch: 50 });
  assert.equal(statusOf(id), 'escrowed');
  assert.equal(rowOf(id).refund_status, 'requested', '链上已申请退款 ⇒ 本地镜像必须跟上');
  assert.ok(rowOf(id).refund_requested_at, '同时落申请时刻（多个资金闸按它判断）');
});
