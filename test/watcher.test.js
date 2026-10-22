/**
 * escrowWatcher 状态迁移单测：直接对 applyEvent 覆盖各事件 → 本地订单状态映射分支。
 * （真实链上轮询（eth_getLogs）属于端到端冒烟范围，见 final-verify）
 */
import { test } from 'node:test';

/** 全额退款事件参数（Escrow.Arbitrated/RefundApproved 现带 refundWei）：测试内订单金额恒为 1e18 */
const FULL_REFUND = '1000000000000000000';
import assert from 'node:assert/strict';
import { makeCtx, shopRef, insertOrder as insertOrderRow, insertProduct } from './setup.mjs';

// 重试退避调小（运维参数，config 顶层求值时读取——须在 makeCtx 之前设置）
process.env.MK_WEBHOOK_RETRY_MS = '20';

const ctx = await makeCtx();
const { db } = ctx;
const { applyEvent } = await import('../src/escrowWatcher.js');
// 通知配置的写入走唯一入口（键的形状只在 src/webhook.js 里出现）
const { setWebhookConfig } = await import('../src/webhook.js');

let seq = 0;

/**
 * 插入一条订单（链上单号每单唯一），返回 `{ orderId, orderNo, escrowOrderId }`。
 *
 * 买家/卖家取本文件防伪用例锁定的那两个固定地址（见下方 createdArgs），金额同为 1e18 wei。
 * 行形状交给 setup.mjs 的 insertOrder（链上单号住在 order_chain，见 src/db.js 的三表拆分）。
 */
async function insertOrder(status = 'draft') {
  seq += 1;
  return await insertOrderRow(db, {
    status,
    productSlug: 'p-x',
    buyer: '0x00000000000000000000000000000000000000aa',
    seller: '0x00000000000000000000000000000000000000bb',
    amountWei: '1000000000000000000',
    usdtMicro: 1000000,
    btyUsdtRate: '0.1',
    escrowOrderId: `0x${String(seq).padStart(64, '0')}`,
  });
}

async function statusOf(orderId) {
  return (await db.get('SELECT status FROM v_orders WHERE order_id = ?', orderId)).status;
}

test('OrderCreated：draft → escrowed；已 shipped 不回退', async () => {
  const a = await insertOrder('draft');
  assert.equal(await applyEvent('OrderCreated', { orderId: a.escrowOrderId }), 1);
  assert.equal(await statusOf(a.orderId), 'escrowed');

  const b = await insertOrder('shipped'); // 事件迟到（订单早已本地推进）
  assert.equal(await applyEvent('OrderCreated', { orderId: b.escrowOrderId }), 0);
  assert.equal(await statusOf(b.orderId), 'shipped');
});

test('ReceiptConfirmed：escrowed/shipped → confirmed（买家确认收货释放）；disputed → confirmed（买家撤诉放款）', async () => {
  const a = await insertOrder('escrowed');
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: a.escrowOrderId }), 1);
  assert.equal(await statusOf(a.orderId), 'confirmed');

  const b = await insertOrder('shipped');
  await applyEvent('ReceiptConfirmed', { orderId: b.escrowOrderId });
  assert.equal(await statusOf(b.orderId), 'confirmed');

  // v2+：Escrow.confirmReceipt 扩 Disputed 态（仲裁/卖家失能时买家撤诉放款出口）
  const d = await insertOrder('disputed');
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: d.escrowOrderId }), 1);
  assert.equal(await statusOf(d.orderId), 'confirmed', '争议中买家撤诉 → confirmed 终局');
  const row = await db.get('SELECT refund_status FROM v_orders WHERE order_id = ?', d.orderId);
  assert.equal(row.refund_status, 'none', '撤诉终局复位售后镜像');
});

test('DisputeRequested：escrowed/shipped → disputed（买家发起争议冻结）', async () => {
  const a = await insertOrder('shipped');
  assert.equal(await applyEvent('DisputeRequested', { orderId: a.escrowOrderId }), 1);
  assert.equal(await statusOf(a.orderId), 'disputed');
});

test('Arbitrated：disputed → refunded（判买家）/ settled（判卖家）', async () => {
  const a = await insertOrder('disputed');
  assert.equal(await applyEvent('Arbitrated', { orderId: a.escrowOrderId, refundWei: FULL_REFUND }), 1);
  assert.equal(await statusOf(a.orderId), 'refunded');

  const b = await insertOrder('disputed');
  await applyEvent('Arbitrated', { orderId: b.escrowOrderId, refundWei: 0n });
  assert.equal(await statusOf(b.orderId), 'settled');
});

// ── 两级售后（v2）：RefundRequested / RefundRejected / RefundApproved 事件回写 ──

async function refundRowOf(id) {
  return await db.get('SELECT status, refund_status, refund_requested_at, refund_rejected_at FROM v_orders WHERE order_id = ?', id);
}

test('RefundRequested：escrowed/shipped → 同状态 + refund_status=requested（资金冻结等待卖家）', async () => {
  const a = await insertOrder('escrowed');
  assert.equal(await applyEvent('RefundRequested', { orderId: a.escrowOrderId }), 1);
  const row = await refundRowOf(a.orderId);
  assert.equal(row.status, 'escrowed', '状态不变：钱仍在托管，等待卖家 approve/reject');
  assert.equal(row.refund_status, 'requested');
  assert.ok(row.refund_requested_at > 0, '落申请时刻');

  const b = await insertOrder('shipped');
  assert.equal(await applyEvent('RefundRequested', { orderId: b.escrowOrderId }), 1);
  assert.equal((await refundRowOf(b.orderId)).refund_status, 'requested', '已交付单同样可申请退款');

  // 幂等：重复事件不重复迁移（changes=0，不重复记账事件史）
  assert.equal(await applyEvent('RefundRequested', { orderId: a.escrowOrderId }), 0);
});

test('RefundRejected：requested → rejected（解锁争议资格；合约不接受被拒后重复申请）', async () => {
  const a = await insertOrder('escrowed');
  await applyEvent('RefundRequested', { orderId: a.escrowOrderId });
  assert.equal(await applyEvent('RefundRejected', { orderId: a.escrowOrderId }), 1);
  let row = await refundRowOf(a.orderId);
  assert.equal(row.status, 'escrowed', '拒绝不改资金状态（解锁争议资格）');
  assert.equal(row.refund_status, 'rejected');
  assert.ok(row.refund_rejected_at >= row.refund_requested_at);

  // 合约已禁止被拒后重复申请（防无限冻结循环，见 Escrow.sol requestRefund）——
  // 本地镜像保持事件映射能力（幂等），但真实链上不会再出现 requested→rejected→requested
  assert.equal(await applyEvent('RefundRequested', { orderId: a.escrowOrderId }), 1, '镜像层仍按事件翻转（防御性兼容）');
  row = await refundRowOf(a.orderId);
  assert.equal(row.refund_status, 'requested');
});

test('RefundApproved：escrowed/shipped/disputed → refunded 终态（售后标记复位）', async () => {
  // 申请后卖家同意退款
  const a = await insertOrder('shipped');
  await applyEvent('RefundRequested', { orderId: a.escrowOrderId });
  assert.equal(await applyEvent('RefundApproved', { orderId: a.escrowOrderId, refundWei: FULL_REFUND }), 1);
  const rowA = await refundRowOf(a.orderId);
  assert.equal(rowA.status, 'refunded');
  assert.equal(rowA.refund_status, 'none', '终态后售后标记复位（结果由订单状态表达）');

  // 争议中卖家主动和解退款（disputed → refunded，链上 RefundApproved 同事件）
  const b = await insertOrder('disputed');
  assert.equal(await applyEvent('RefundApproved', { orderId: b.escrowOrderId, refundWei: FULL_REFUND }), 1);
  assert.equal(await statusOf(b.orderId), 'refunded');

  // 终态不回退：confirmed 订单不受影响
  const c = await insertOrder('confirmed');
  assert.equal(await applyEvent('RefundApproved', { orderId: c.escrowOrderId, refundWei: FULL_REFUND }), 0);
  assert.equal(await statusOf(c.orderId), 'confirmed');

  // 事件史：三事件成功迁移均留痕（供仲裁/信誉溯源）
  const d = await insertOrder('escrowed');
  await applyEvent('RefundRequested', { orderId: d.escrowOrderId }, { txHash: '0x' + '1'.repeat(64), block: 60 });
  await applyEvent('RefundApproved', { orderId: d.escrowOrderId, refundWei: FULL_REFUND }, { txHash: '0x' + '2'.repeat(64), block: 61 });
  const events = (await db.get('SELECT onchain_events FROM v_orders WHERE order_id = ?', d.orderId)).onchain_events;
  assert.deepEqual(events.map((e) => e.name), ['RefundRequested', 'RefundApproved']);
});

test('OrderExpiredReleased：draft/escrowed/shipped → expired（超时释放给卖家）', async () => {
  const a = await insertOrder('escrowed');
  assert.equal(await applyEvent('OrderExpiredReleased', { orderId: a.escrowOrderId }), 1);
  assert.equal(await statusOf(a.orderId), 'expired');

  const b = await insertOrder('draft'); // paid 前即被超时释放（事件区间漏扫兜底）
  await applyEvent('OrderExpiredReleased', { orderId: b.escrowOrderId });
  assert.equal(await statusOf(b.orderId), 'expired');

  // 已发货（shipped）后买家拖单不确认，链上超时释放同样落地为 expired（钱货两清）
  const c = await insertOrder('shipped');
  await applyEvent('OrderExpiredReleased', { orderId: c.escrowOrderId });
  assert.equal(await statusOf(c.orderId), 'expired');

  // 审计 P3-1：超时即终局，售后镜像复位（此前若带 rejected 残留则一并清掉）
  const d = await insertOrder('escrowed');
  // 售后镜像列住在 order_chain（1:1 子表），订单事实仍在 orders——两条各自命中自己那张表
  await db.run("UPDATE order_chain SET refund_status = 'rejected', refund_rejected_at = ? WHERE order_id = ?", new Date(), d.orderId);
  await applyEvent('OrderExpiredReleased', { orderId: d.escrowOrderId });
  const rd = await db.get('SELECT status, refund_status FROM v_orders WHERE order_id = ?', d.orderId);
  assert.equal(rd.status, 'expired');
  assert.equal(rd.refund_status, 'none', '超时终局复位售后镜像残留');
});

test('审计 P2-2：被焊成 confirmed 的镜像可被真实超时事件纠正为 expired', async () => {
  /*
    场景：链上实际超时释放，但本地先被**别的路径**焊成 confirmed（历史数据：旧版 /sync 把链上
    Settled 一律落 confirmed，占位保留），真实 OrderExpiredReleased 事件随后到达——此前 from 集
    无 confirmed 而永久错标。
    注：/sync 自 2026-09 收敛后不再产出 confirmed（链上快照无从证明"买家确认收货"这个动作），
    但**历史行**仍可能停在 confirmed，故本 from 集必须保留它。
  */
  const a = await insertOrder('confirmed');
  // confirmed 镜像无交付行（未发货被误标）：事件到达应纠正为 expired（真实确认后
  // 链上不会再发本事件，纳入 confirmed 无回退风险）
  assert.equal(await applyEvent('OrderExpiredReleased', { orderId: a.escrowOrderId }), 1);
  assert.equal(await statusOf(a.orderId), 'expired');
});

test('审计 P1-2：同批追赶回放中 OrderCreated 带 skipAutoDeliver 不自动交付', async () => {
  // 需要在数字商品上验证码未被分配——用真实路由建码池与订单（auto-deliver.test 基建较重），
  // 此处验证 watcher 迁移语义 + meta 传递：skipAutoDeliver=true 时 OrderCreated 仍正常
  // 推进 escrowed（迁移与交付解耦），且随后的终局事件正常生效。
  const a = await insertOrder('draft');
  assert.equal(await applyEvent('OrderCreated', { orderId: a.escrowOrderId, buyer: GOOD_BUYER, seller: GOOD_SELLER, amount: GOOD_AMOUNT }, { txHash: '0x' + '1'.repeat(64), block: 5, skipAutoDeliver: true }), 1);
  assert.equal(await statusOf(a.orderId), 'escrowed', '跳过自动交付不影响迁移');
  // 同批后续 RefundApproved：终局照常应用（码未发，无「已退款仍得码」）
  await applyEvent('RefundRequested', { orderId: a.escrowOrderId });
  assert.equal(await applyEvent('RefundApproved', { orderId: a.escrowOrderId, refundWei: FULL_REFUND }, { txHash: '0x' + '2'.repeat(64), block: 6 }), 1);
  assert.equal(await statusOf(a.orderId), 'refunded');
});

test('终态不回退：confirmed 订单不受 DisputeRequested/ReceiptConfirmed 影响', async () => {
  const a = await insertOrder('confirmed');
  assert.equal(await applyEvent('DisputeRequested', { orderId: a.escrowOrderId }), 0);
  assert.equal(await applyEvent('Arbitrated', { orderId: a.escrowOrderId, refundWei: FULL_REFUND }), 0);
  assert.equal(await statusOf(a.orderId), 'confirmed');
});

test('未知订单事件 changes=0（本地无对应 escrow_order_id）', async () => {
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: '0x' + 'f'.repeat(64) }), 0);
});

test('事件史：迁移成功记录 {name,txHash,block,at}，失败/无凭证不落脏数据', async () => {
  const a = await insertOrder('draft');
  await applyEvent('OrderCreated', { orderId: a.escrowOrderId }, { txHash: '0x' + 'a'.repeat(64), block: 42 });
  await applyEvent('OrderExpiredReleased', { orderId: a.escrowOrderId }, { txHash: '0x' + 'b'.repeat(64), block: 43 });
  const events = (await db.get('SELECT onchain_events FROM v_orders WHERE order_id = ?', a.orderId)).onchain_events;
  assert.equal(events.length, 2, '每次成功迁移应追加一条事件史');
  assert.equal(events[0].name, 'OrderCreated');
  assert.equal(events[0].txHash, '0x' + 'a'.repeat(64));
  assert.equal(events[0].block, 42);
  assert.ok(events[0].at > 0);
  assert.equal(events[1].name, 'OrderExpiredReleased');

  // 状态不匹配（changes=0）与未知订单不记录：事件史那一列**不是 NULL 而是空数组**
  // （`order_chain.events` 是 `JSON NOT NULL DEFAULT ('[]')`——"没有事件"就是空数组）
  const b = await insertOrder('confirmed');
  await applyEvent('OrderCreated', { orderId: b.escrowOrderId }, { txHash: '0x' + 'c'.repeat(64), block: 50 });
  assert.deepEqual((await db.get('SELECT onchain_events FROM v_orders WHERE order_id = ?', b.orderId)).onchain_events, []);

  // 不带 meta（如单测直调）时仍记录事件名，txHash/block 为 null
  const c = await insertOrder('draft');
  await applyEvent('OrderCreated', { orderId: c.escrowOrderId });
  const ev0 = (await db.get('SELECT onchain_events FROM v_orders WHERE order_id = ?', c.orderId)).onchain_events[0];
  assert.equal(ev0.txHash, null);
  assert.equal(ev0.block, null);
});

// ── 防伪托管：OrderCreated 事件金额/卖家/买家必须与本地订单锁定一致 ──
// （insertOrder 默认行：buyer=0x…aa、seller=0x…bb、amount_wei=1e18；Escrow 仅原生 BTY 入金后事件
//   不再表达支付代币，0 金额/错误卖家/他人买家直调 createOrder 均不得推进状态）
const GOOD_BUYER = '0x00000000000000000000000000000000000000aa';
const GOOD_SELLER = '0x00000000000000000000000000000000000000bb';
const GOOD_AMOUNT = 1000000000000000000n;

function createdArgs(orderId, overrides = {}) {
  return {
    orderId,
    buyer: GOOD_BUYER,
    seller: GOOD_SELLER,
    // `insertOrder` 的默认报价 host = seller；真实事件必带 host
    host: GOOD_SELLER,
    amount: GOOD_AMOUNT,
    ...overrides,
  };
}

test('防伪：金额不符的托管事件不推进（0 金额/少付均拒）', async () => {
  const a = await insertOrder('draft');
  assert.equal(await applyEvent('OrderCreated', createdArgs(a.escrowOrderId, { amount: 1n })), 0);
  assert.equal(
    (await db.get('SELECT status FROM v_orders WHERE order_id = ?', a.orderId)).status,
    'draft'
  );
});

test('防伪：卖家不符的托管事件不推进', async () => {
  const a = await insertOrder('draft');
  assert.equal(await applyEvent('OrderCreated', createdArgs(a.escrowOrderId, { seller: '0x' + '2'.repeat(40) })), 0);
  assert.equal(
    (await db.get('SELECT status FROM v_orders WHERE order_id = ?', a.orderId)).status,
    'draft'
  );
});

test('防伪：店铺节点不符的托管事件不推进（同一卖家的另一家店）', async () => {
  const a = await insertOrder('draft');
  const quotedHost = '0x' + '4'.repeat(40);
  await db.run('UPDATE orders SET commission_quoted_to = ? WHERE id = ?', quotedHost, a.orderId);

  // 同一卖家、同一金额，但事件 host 是另一家店 ⇒ 不得把本店草稿推进为 escrowed
  assert.equal(
    await applyEvent('OrderCreated', createdArgs(a.escrowOrderId, { host: '0x' + '5'.repeat(40) })),
    0
  );
  assert.equal(
    (await db.get('SELECT status FROM v_orders WHERE order_id = ?', a.orderId)).status,
    'draft'
  );

  // host 对上才推进（避免把正经的自营/租户店误杀）
  assert.equal(await applyEvent('OrderCreated', createdArgs(a.escrowOrderId, { host: quotedHost })), 1);
  assert.equal(
    (await db.get('SELECT status FROM v_orders WHERE order_id = ?', a.orderId)).status,
    'escrowed'
  );
});

test('防伪：金额/卖家全部匹配的真实托管事件正常推进', async () => {
  const a = await insertOrder('draft');
  assert.equal(await applyEvent('OrderCreated', createdArgs(a.escrowOrderId), { txHash: '0x' + 'd'.repeat(64), block: 9 }), 1);
  const row = await db.get('SELECT status, onchain_events, paid_tx_hash FROM v_orders WHERE order_id = ?', a.orderId);
  assert.equal(row.status, 'escrowed');
  assert.equal(row.paid_tx_hash, '0x' + 'd'.repeat(64));
  assert.ok(row.onchain_events);
});

test('防伪：买家不符的托管事件不推进（他人钱包代付不得确认本单/触发交付）', async () => {
  const a = await insertOrder('draft');
  const stranger = '0x' + '3'.repeat(40);
  assert.equal(await applyEvent('OrderCreated', createdArgs(a.escrowOrderId, { buyer: stranger })), 0);
  assert.equal(
    (await db.get('SELECT status FROM v_orders WHERE order_id = ?', a.orderId)).status,
    'draft'
  );
});

test('cancelled 行自动恢复：草稿超时关闭后链上托管落定 → watcher 复活为 escrowed（落凭证）', async () => {
  const a = await insertOrder('draft');
  // 模拟 sweeper 关单（草稿 → cancelled，无凭证）
  await db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", a.orderId);
  assert.equal(
    await applyEvent('OrderCreated', createdArgs(a.escrowOrderId), { txHash: '0x' + 'e'.repeat(64), block: 10 }),
    1,
    '已取消行收到匹配的真实托管事件应自动恢复'
  );
  const row = await db.get('SELECT status, paid_tx_hash FROM v_orders WHERE order_id = ?', a.orderId);
  assert.equal(row.status, 'escrowed');
  assert.equal(row.paid_tx_hash, '0x' + 'e'.repeat(64));
});

test('cancelled 行不匹配事件不复活（金额/买家不符的伪造事件不能恢复取消单）', async () => {
  const a = await insertOrder('cancelled');
  assert.equal(await applyEvent('OrderCreated', createdArgs(a.escrowOrderId, { amount: 1n })), 0);
  assert.equal(
    (await db.get('SELECT status FROM v_orders WHERE order_id = ?', a.orderId)).status,
    'cancelled'
  );
});

// ── 按退款额拆分结算（2026-09：能给出部分金额的有两条出口——仲裁人的 `voteSettlement(orderId, refundWei)`
//    （任意比例、无需授权）与卖家 `approveRefund(orderId, refundWei)` 且 refundWei **恰好等于买家
//    `acceptPartialRefund` 授权过的那个数**；其它金额一律 RefundAmountNotAccepted，旧的 RefundNotFull 已删除。
//    本文件只钉"按额分流"本身，买家授权链路的端到端见 test/partial-refund-consent.test.js）──

test('拆分结算：部分退款（refundWei < amount）落 settled 并记录已退金额', async () => {
  const a = await insertOrder('disputed');
  const changed = await applyEvent('Arbitrated', { orderId: a.escrowOrderId, refundWei: '400000000000000000' }, {
    txHash: '0x' + '7'.repeat(64),
    block: 70,
    chainParams: {
      buyer: '0x00000000000000000000000000000000000000aa',
      seller: '0x00000000000000000000000000000000000000bb',
      amount: '1000000000000000000',
      // 夹具的报价 host 默认就是 seller（见 setup.mjs 的 insertOrderRow）：链上真值必须逐字相等
      commissionTo: '0x00000000000000000000000000000000000000bb',
    },
  });
  assert.equal(changed, 1);
  const row = await db.get('SELECT status, refund_status, refunded_amount_wei FROM v_orders WHERE order_id = ?', a.orderId);
  assert.equal(row.status, 'settled', '部分退款属「拆分结算」→ 成交向终态 settled');
  assert.equal(row.refunded_amount_wei, '400000000000000000', '已退金额必须落库（账本净额/UI 依据）');
  assert.equal(row.refund_status, 'none', '终局复位售后镜像');
});

test('拆分结算：refundWei = amount 落 refunded（全额退款），0 落 settled（全额判卖家）', async () => {
  const full = await insertOrder('disputed');
  await applyEvent('Arbitrated', { orderId: full.escrowOrderId, refundWei: '1000000000000000000' });
  assert.equal(await statusOf(full.orderId), 'refunded');
  assert.equal(
    (await db.get('SELECT refunded_amount_wei FROM v_orders WHERE order_id = ?', full.orderId)).refunded_amount_wei,
    '1000000000000000000'
  );

  const none = await insertOrder('disputed');
  await applyEvent('Arbitrated', { orderId: none.escrowOrderId, refundWei: 0n });
  assert.equal(await statusOf(none.orderId), 'settled');
  assert.equal(
    (await db.get('SELECT refunded_amount_wei FROM v_orders WHERE order_id = ?', none.orderId)).refunded_amount_wei,
    '0'
  );
});

/**
 * 事件字段容错（**不是**在说"卖家可以随便填金额"）：合约侧 approveRefund 的合法取值只有
 * 「全额」与「买家已精确授权的那个数」（其它 RefundAmountNotAccepted，旧 RefundNotFull 已删除）；
 * 这里直调 applyEvent 是为了钉住 settleByRefundSplit 对 `refundWei` 的判定与 Arbitrated 完全一致
 * （ABI 漂移/历史事件/对账兜底都不会出现"同一笔钱两条事件路径两种终态"）。
 * 真实链上同样会产生部分金额的出口见上一条（arbitrate）与 test/partial-refund-consent.test.js
 * （买家 acceptPartialRefund 授权后卖家 approveRefund 同额）。
 */
test('按额判定：RefundApproved 带部分金额（历史/ABI 容错）同样落 settled + 已退金额', async () => {
  const a = await insertOrder('shipped');
  await applyEvent('RefundApproved', { orderId: a.escrowOrderId, refundWei: '250000000000000000' });
  const row = await db.get('SELECT status, refunded_amount_wei FROM v_orders WHERE order_id = ?', a.orderId);
  assert.equal(row.status, 'settled');
  assert.equal(row.refunded_amount_wei, '250000000000000000');
});

// ── 源码审计 2026-09：诱饵单（他人对该 orderId 建 1 wei 单后 releaseExpired）──
//
// orderId 自草稿起公开（匿名 GET /api/orders?address= 即可读到 draft 的 escrowOrderId），
// 攻击者可对任意**未付款草稿**的 orderId 用 1 wei + timeoutBlocks=1 建一笔自己的链上单，
// 再调 releaseExpired 触发 OrderExpiredReleased。修复前该事件只按 orderId + 本地状态落地，
// 会把受害者的 draft 改成 expired（占位被释放、事件史写入攻击者 txHash、按 INCOME_STATUS
// 计入卖家流水），且买家随后真实支付因 OrderExists 永久 revert。
// 修复：非 OrderCreated 事件同样必须与链上 getOrder 真值（买家/卖家/金额）逐项一致。

const OTHER_BUYER = '0x' + '3'.repeat(40);

test('防伪（终局事件）：链上买家与本单买家不符的 OrderExpiredReleased 不得把未付款草稿改成 expired', async () => {
  const a = await insertOrder('draft');
  const changed = await applyEvent('OrderExpiredReleased', { orderId: a.escrowOrderId }, {
    txHash: '0x' + 'a'.repeat(64),
    block: 100,
    // pollOnce 预取的链上真值：买家是攻击者、金额 1 wei（诱饵单）
    chainParams: { buyer: OTHER_BUYER, seller: '0x' + 'b'.repeat(40), amount: '1', commissionTo: '0x' + 'b'.repeat(40) },
  });
  assert.equal(changed, 0, '与链上真值不符的终局事件不推进');
  assert.equal(await statusOf(a.orderId), 'draft', '受害者草稿保持未支付');
  const row = await db.get('SELECT onchain_events FROM v_orders WHERE order_id = ?', a.orderId);
  assert.ok(!row.onchain_events || !String(row.onchain_events).includes('OrderExpiredReleased'), '伪造事件不得进入事件史');
});

test('防伪（终局事件）：店铺节点不符的 OrderExpiredReleased 不得推进（同一卖家另一家店）', async () => {
  const a = await insertOrder('draft');
  const host = '0x' + '4'.repeat(40);
  await db.run('UPDATE orders SET commission_quoted_to = ? WHERE id = ?', host, a.orderId);

  const base = {
    buyer: '0x00000000000000000000000000000000000000aa',
    seller: '0x00000000000000000000000000000000000000bb',
    amount: '1000000000000000000',
  };
  assert.equal(
    await applyEvent('OrderExpiredReleased', { orderId: a.escrowOrderId }, {
      txHash: '0x' + 'a'.repeat(64),
      block: 102,
      chainParams: { ...base, commissionTo: '0x' + '5'.repeat(40) },
    }),
    0,
    '店铺节点不符的终局事件不推进'
  );
  assert.equal(await statusOf(a.orderId), 'draft');
  assert.equal(
    await applyEvent('OrderExpiredReleased', { orderId: a.escrowOrderId }, {
      txHash: '0x' + 'b'.repeat(64),
      block: 103,
      chainParams: { ...base, commissionTo: host },
    }),
    1
  );
  assert.equal(await statusOf(a.orderId), 'expired', '本店 host 匹配时正常推进');
});

test('防伪（终局事件）：链上真值一致时正常推进（真实超时释放不受影响）', async () => {
  const a = await insertOrder('escrowed');
  const changed = await applyEvent('OrderExpiredReleased', { orderId: a.escrowOrderId }, {
    txHash: '0x' + 'c'.repeat(64),
    block: 101,
    chainParams: {
      buyer: '0x00000000000000000000000000000000000000aa',
      seller: '0x00000000000000000000000000000000000000bb',
      amount: '1000000000000000000',
      commissionTo: '0x00000000000000000000000000000000000000bb',
    },
  });
  assert.equal(changed, 1);
  assert.equal(await statusOf(a.orderId), 'expired');
});

test('防伪（仲裁/退款类事件）：链上金额不符的 Arbitrated 不得推进', async () => {
  const a = await insertOrder('disputed');
  const changed = await applyEvent('Arbitrated', { orderId: a.escrowOrderId, refundWei: FULL_REFUND }, {
    chainParams: {
      buyer: '0x00000000000000000000000000000000000000aa',
      seller: '0x00000000000000000000000000000000000000bb',
      amount: '1', // 诱饵单金额
      commissionTo: '0x00000000000000000000000000000000000000bb',
    },
  });
  assert.equal(changed, 0);
  assert.equal(await statusOf(a.orderId), 'disputed');

  const b = await insertOrder('disputed');
  const done = await applyEvent('Arbitrated', { orderId: b.escrowOrderId, refundWei: FULL_REFUND }, {
    chainParams: {
      buyer: '0x00000000000000000000000000000000000000aa',
      seller: '0x00000000000000000000000000000000000000bb',
      amount: '1000000000000000000',
      commissionTo: '0x00000000000000000000000000000000000000bb',
    },
  });
  assert.equal(done, 1);
  assert.equal(await statusOf(b.orderId), 'refunded');
});

// ── 源码审计 2026-09：终局事件的 from 集与 /sync 口径对齐（防流水漏计） ──

test('终局 from 集对齐 /sync：cancelled 残镜像收到超时释放/仲裁/退款事件后收敛（卖家流水不再漏计）', async () => {
  // 草稿被清扫（cancelled）后链上才落定并终局——此前这些行永远停在 cancelled，
  // INCOME_STATUS 计不到，卖家实际收到的钱不出现在账本里（/sync 早已支持该口径）
  const a = await insertOrder('cancelled');
  assert.equal(await applyEvent('OrderExpiredReleased', { orderId: a.escrowOrderId }), 1, 'cancelled → expired');
  assert.equal(await statusOf(a.orderId), 'expired');

  const b = await insertOrder('cancelled');
  assert.equal(await applyEvent('RefundApproved', { orderId: b.escrowOrderId, refundWei: FULL_REFUND }), 1, 'cancelled → refunded');
  assert.equal(await statusOf(b.orderId), 'refunded');

  const c = await insertOrder('cancelled');
  assert.equal(await applyEvent('Arbitrated', { orderId: c.escrowOrderId, refundWei: 0n }), 1, 'cancelled → settled');
  assert.equal(await statusOf(c.orderId), 'settled');
});

test('漏扫 OrderCreated 的 draft 残镜像：收到确认/争议事件后收敛到对应状态', async () => {
  const a = await insertOrder('draft');
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: a.escrowOrderId }), 1, 'draft → confirmed（链上确已结算）');
  assert.equal(await statusOf(a.orderId), 'confirmed');

  const b = await insertOrder('draft');
  assert.equal(await applyEvent('DisputeRequested', { orderId: b.escrowOrderId }), 1, 'draft → disputed');
  assert.equal(await statusOf(b.orderId), 'disputed');
});

test('冻结路径的 from 集也接受 cancelled：取消后才支付的单不会永久停在 cancelled', async () => {
  /*
    竞态：草稿被清扫成 cancelled → 买家随后真的完成了支付（watcher 靠 OrderCreated 救回），
    但若那次扫描也漏了，之后买家申请退款、被拒、发起争议时——本地行必须能迁到 disputed，
    否则链上那笔钱已被冻结，本地却显示"已取消"（三条修复路径都碰不到它，没有任何兜底）。
    终局路径（expired/refunded/settled）早已接受 cancelled，冻结路径此前漏了。
  */
  const a = await insertOrder('cancelled');
  assert.equal(await applyEvent('DisputeRequested', { orderId: a.escrowOrderId }), 1, 'cancelled → disputed');
  assert.equal(await statusOf(a.orderId), 'disputed');
});

// ── 源码审计 2026-09：webhook 副作用移出事务（回滚不得通知「已托管」） ──

test('副作用时序：迁移抛错回滚时不发通知，成功时通知在提交后发出', async () => {
  const sent = [];
  const { setWebhookSender, resetWebhookStatus } = await import('../src/webhook.js');
  /*
    目标用 **IP 字面量**而不是 `example.com`（2026-10-14）：投递前那一步 SSRF 校验会**真的解析
    主机名**，用域名就把一条"提交后才通知"的时序断言绑在了公网 DNS 上——解析抖动（本机实测
    example.com 能解析、443 也通）会让下面那个 3s 上界偶发不够，报出来却是"没发出通知"。
    本文件 :520 与其它文件早就用 IP 字面量，这里跟上；断言不变。
  */
  await setWebhookConfig(shopRef.value, { url: 'https://93.184.216.34/hook' });
  resetWebhookStatus();
  setWebhookSender(async (url, opts) => {
    sent.push(JSON.parse(opts.body).type);
    return { ok: true, status: 200 };
  });

  const a = await insertOrder('draft');
  await applyEvent('OrderCreated', createdArgs(a.escrowOrderId), { txHash: '0x' + 'f'.repeat(64), block: 12 });
  /*
    通知是 fire-and-forget（投递前还有一次 SSRF 校验），固定 20ms 的等待在整套测试并行跑
    （多个测试文件同时占 CPU）时会偶发不够——等待改成有界轮询：断言不变（必须发出
    order.escrowed），只是不再假设一个固定的墙钟时间。
  */
  const until = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (!(await pred()) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
    return pred();
  };
  assert.ok(await until(() => sent.includes('order.escrowed')), '提交成功后应发出 order.escrowed');
});

// ── 源码审计 2026-09 续：一次性告警的「投递成功才写幂等标记」 ──

/** 有界轮询等待（投递结算是异步的：固定 sleep 在整套测试并行跑时会偶发不够） */
async function waitUntil(pred, ms = 3000) {
  const t0 = Date.now();
  while (!(await pred()) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  return await pred();
}

/**
 * `order.hold_missing`（取消期间限量库存已被他人买走、订单被恢复但未重新占位）是核账告警：
 * 旧实现是「先写 kv 里的 ackKey 再 notifyRaw(...)」——投递一失败（URL 写错 / 被 SSRF 拦下 /
 * 店主服务器 5xx / 超时）标记已写死，店主**永远**收不到"存在超卖，请扩容或退款"这条。
 * 现在幂等标记是 `order_alerts` 的一行（主键 (order_id, kind) 去重，见 src/alertAck.js），
 * 只在投递成功后写：失败 ⇒ 行被删掉 ⇒ 事件重放（重启/重组重扫同一 OrderCreated）时重试；
 * 成功 ⇒ 留着那一行 ⇒ 再重放不再重复推。
 */
test('order.hold_missing：投递失败不写标记（事件重放会重试）；投递成功才写标记且不再重复', async () => {
  const { setWebhookSender } = await import('../src/webhook.js');
  await setWebhookConfig(shopRef.value, { url: 'https://93.184.216.34/hook/hold' });
  const sent = [];
  /** 按事件类型计失败次数（同一单的 order.escrowed 通知也在重试：不按类型分会数不清） */
  const failed = { hold_missing: 0 };
  const capture = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  setWebhookSender(async (url, init) => {
    if (JSON.parse(init.body).type === 'order.hold_missing') failed.hold_missing += 1;
    throw new Error('connect ECONNREFUSED');
  });

  /*
    造出"取消期间限量库存被卖完"的局面：商品限量 1、已占满 1，而本单已释放占位（released_at 非空）
    ⇒ restockOrder 重新占位失败 ⇒ 走 hold_missing 告警分支（订单仍会被恢复为 escrowed）。
    商品与 SKU 由 insertProduct 一次造出（`products.slug` 是 CHAR(11)，自己拼的 `w-held-product-N`
    超长会直接插入失败）。
  */
  seq += 1;
  const { productId, slug } = await insertProduct(db, {
    title: '占位恢复失败商品',
    kind: 'physical',
    skus: [{ key: '', priceUsdtMicro: 88_000_000, capacity: 1, committed: 1 }],
  });
  const held = await insertOrderRow(db, {
    status: 'cancelled',
    productId,
    productSlug: slug,
    buyer: GOOD_BUYER,
    seller: GOOD_SELLER,
    amountWei: '1000000000000000000',
    usdtMicro: 1000000,
    btyUsdtRate: '0.1',
    holdQty: 1,
    releasedAt: new Date(),
    escrowOrderId: `0x${String(seq).padStart(64, '0')}`,
  });
  const heldEscrowOrderId = held.escrowOrderId;

  /*
    幂等标记是 order_alerts 的一行（主键 (order_id, kind) 去重，见 src/alertAck.js）；
    `order_id` 是**内部数字主键**，不是订单号、也不是链上单号。
  */
  const flagged = async () => !!(await db.get('SELECT 1 AS one FROM order_alerts WHERE order_id = ? AND kind = ?', held.orderId, 'hold_missing'));
  const replay = async () => await applyEvent('OrderCreated', createdArgs(heldEscrowOrderId), { txHash: '0x' + '9'.repeat(64), block: 20 });
  /** 事件重放：把行放回"取消且无支付凭证"的初始态（watcher 重启/短重组重扫同一事件即如此） */
  const rewind = async () => {
    await db.run("UPDATE orders SET status = 'cancelled' WHERE id = ?", held.orderId);
    await db.run('UPDATE order_chain SET paid_tx_hash = NULL WHERE order_id = ?', held.orderId);
  };

  try {
    // 1) 投递总是失败：不得写标记
    assert.equal(await replay(), 1, '恢复为 escrowed（链上资金真实存在，不得因本地账目卡住）');
    assert.equal((await db.get('SELECT status FROM v_orders WHERE order_id = ?', held.orderId)).status, 'escrowed');
    assert.ok(await waitUntil(() => failed.hold_missing >= 3), '投递方重试 2 次后结算失败');
    /*
      "第 3 次尝试抛错"与"预占行已被删掉"是**两个时刻**：释放发生在投递 promise 结算之后的
      `.then` 里（`alertAck` 的失败分支要 await 一条 DELETE）。断言等的是**那个事实**落定
      （有界轮询），不是重试计数——整套并行跑时计数会先到。
    */
    assert.ok(await waitUntil(async () => !(await flagged())), '投递失败：不得写幂等标记（写死 = 店主永远收不到这条核账告警）');

    // 2) 事件重放（同一 OrderCreated 再扫一遍）：没写标记 ⇒ 仍会投递 —— at-least-once
    await rewind();
    sent.length = 0;
    assert.equal(await replay(), 1, '重放同样恢复订单');
    assert.ok(await waitUntil(() => failed.hold_missing >= 6), '第二轮同样重试到结算');
    assert.ok(await waitUntil(async () => !(await flagged())), '仍未送达 ⇒ 仍未写标记');

    // 3) 店主服务器恢复：送达后写标记；再重放不再重复告警
    setWebhookSender(capture);
    await rewind();
    sent.length = 0;
    assert.equal(await replay(), 1);
    assert.ok(await waitUntil(() => sent.some((s) => s.body.type === 'order.hold_missing')), '这次送达了');
    assert.match(sent[0].body.reason, /扩容|退款/);
    assert.ok(await waitUntil(flagged), '投递成功后才写幂等标记');
    await rewind();
    sent.length = 0;
    assert.equal(await replay(), 1);
    await waitUntil(() => false, 60); // 让可能的投递落定（有界短等，失败也只是断言更严）
    assert.equal(sent.filter((s) => s.body.type === 'order.hold_missing').length, 0, '已成功告警过：不再重复推');
  } finally {
    setWebhookSender(capture);
  }
});

/*
  ── alertAck 的连接归属（2026-10-22 复审）─────────────────────────────────────────────
  告警的预占行与"送达/释放"写在同一笔事务里时，释放必须**看得见**那条尚未提交的 INSERT。
  若实现改用另一条连接（或已归还池子的连接），DELETE 会命中 0 行、预占永久留下——告警此后
  被静默吞掉，正是 alertAck 存在的理由。这条用例把"投递先于提交返回"这个时序钉死：
  `send` 立即结算为失败，然后在事务内轮询预占行是否真的被撤掉。
*/
test('alertAck：投递先于提交返回时，释放写必须走调用方的事务连接', async () => {
  const { alertOnceDelivered } = await import('../src/alertAck.js');
  const { withTransaction } = await import('../src/db.js');
  const a = await insertOrder('escrowed');
  const flagged = async () =>
    !!(await db.get('SELECT 1 AS one FROM order_alerts WHERE order_id = ? AND kind = ?', a.orderId, 'hold_missing'));

  await withTransaction(async () => {
    await alertOnceDelivered({
      orderId: a.orderId,
      kind: 'hold_missing',
      label: '[test]',
      what: '',
      // 立即结算为"未送达"：`.then` 会在本事务提交之前跑
      send: async () => false,
    });
    let gone = false;
    for (let i = 0; i < 100 && !gone; i += 1) {
      gone = !(await flagged());
      if (!gone) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(gone, true, '释放必须在本事务内可见（跨连接写会看不见未提交的预占行）');
  });
  assert.equal(await flagged(), false, '提交后也不得留下预占行（留下 = 永久不再重试）');
});
