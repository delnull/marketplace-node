/**
 * escrowWatcher 状态迁移单测：直接对 applyEvent 覆盖各事件 → 本地订单状态映射分支。
 * （真实链上轮询（eth_getLogs）属于端到端冒烟范围，见 final-verify）
 */
import { test } from 'node:test';

/** 全额退款事件参数（Escrow.Arbitrated/RefundApproved 现带 refundWei）：测试内订单金额恒为 1e18 */
const FULL_REFUND = '1000000000000000000';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

// 重试退避调小（运维参数，config 顶层求值时读取——须在 makeCtx 之前设置）
process.env.MK_WEBHOOK_RETRY_MS = '20';

const ctx = await makeCtx();
const { db } = ctx;
const { applyEvent } = await import('../src/escrowWatcher.js');

let seq = 0;

/** 插入一条订单（escrow_order_id 唯一生成），返回订单行 */
function insertOrder(status = 'draft') {
  seq += 1;
  const id = `w-${seq}`;
  const orderIdHex = `0x${String(seq).padStart(64, '0')}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, cny_fen, bty_usdt_rate, usdt_cny_rate, status, escrow_order_id, created_at, updated_at)
     VALUES (?, 'p-x', '{}', '0x00', '', '0x00000000000000000000000000000000000000aa', '0x00000000000000000000000000000000000000bb',
       '1000000000000000000', 100, '0.1', '7.2', ?, ?, ?, ?)`
  ).run(id, status, orderIdHex, now, now);
  return { id, orderIdHex };
}

function statusOf(id) {
  return db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status;
}

test('OrderCreated：draft → escrowed；已 shipped 不回退', () => {
  const a = insertOrder('draft');
  assert.equal(applyEvent('OrderCreated', { orderId: a.orderIdHex }), 1);
  assert.equal(statusOf(a.id), 'escrowed');

  const b = insertOrder('shipped'); // 事件迟到（订单早已本地推进）
  assert.equal(applyEvent('OrderCreated', { orderId: b.orderIdHex }), 0);
  assert.equal(statusOf(b.id), 'shipped');
});

test('ReceiptConfirmed：escrowed/shipped → confirmed（买家确认收货释放）；disputed → confirmed（买家撤诉放款）', () => {
  const a = insertOrder('escrowed');
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: a.orderIdHex }), 1);
  assert.equal(statusOf(a.id), 'confirmed');

  const b = insertOrder('shipped');
  applyEvent('ReceiptConfirmed', { orderId: b.orderIdHex });
  assert.equal(statusOf(b.id), 'confirmed');

  // v2+：Escrow.confirmReceipt 扩 Disputed 态（仲裁/卖家失能时买家撤诉放款出口）
  const d = insertOrder('disputed');
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: d.orderIdHex }), 1);
  assert.equal(statusOf(d.id), 'confirmed', '争议中买家撤诉 → confirmed 终局');
  const row = db.prepare('SELECT refund_status FROM orders WHERE id = ?').get(d.id);
  assert.equal(row.refund_status, 'none', '撤诉终局复位售后镜像');
});

test('DisputeRequested：escrowed/shipped → disputed（买家发起争议冻结）', () => {
  const a = insertOrder('shipped');
  assert.equal(applyEvent('DisputeRequested', { orderId: a.orderIdHex }), 1);
  assert.equal(statusOf(a.id), 'disputed');
});

test('Arbitrated：disputed → refunded（判买家）/ settled（判卖家）', () => {
  const a = insertOrder('disputed');
  assert.equal(applyEvent('Arbitrated', { orderId: a.orderIdHex, refundWei: FULL_REFUND }), 1);
  assert.equal(statusOf(a.id), 'refunded');

  const b = insertOrder('disputed');
  applyEvent('Arbitrated', { orderId: b.orderIdHex, refundWei: 0n });
  assert.equal(statusOf(b.id), 'settled');
});

// ── 两级售后（v2）：RefundRequested / RefundRejected / RefundApproved 事件回写 ──

function refundRowOf(id) {
  return db.prepare('SELECT status, refund_status, refund_requested_at, refund_rejected_at FROM orders WHERE id = ?').get(id);
}

test('RefundRequested：escrowed/shipped → 同状态 + refund_status=requested（资金冻结等待卖家）', () => {
  const a = insertOrder('escrowed');
  assert.equal(applyEvent('RefundRequested', { orderId: a.orderIdHex }), 1);
  const row = refundRowOf(a.id);
  assert.equal(row.status, 'escrowed', '状态不变：钱仍在托管，等待卖家 approve/reject');
  assert.equal(row.refund_status, 'requested');
  assert.ok(row.refund_requested_at > 0, '落申请时刻');

  const b = insertOrder('shipped');
  assert.equal(applyEvent('RefundRequested', { orderId: b.orderIdHex }), 1);
  assert.equal(refundRowOf(b.id).refund_status, 'requested', '已交付单同样可申请退款');

  // 幂等：重复事件不重复迁移（changes=0，不重复记账事件史）
  assert.equal(applyEvent('RefundRequested', { orderId: a.orderIdHex }), 0);
});

test('RefundRejected：requested → rejected（解锁争议资格；合约不接受被拒后重复申请）', () => {
  const a = insertOrder('escrowed');
  applyEvent('RefundRequested', { orderId: a.orderIdHex });
  assert.equal(applyEvent('RefundRejected', { orderId: a.orderIdHex }), 1);
  let row = refundRowOf(a.id);
  assert.equal(row.status, 'escrowed', '拒绝不改资金状态（解锁争议资格）');
  assert.equal(row.refund_status, 'rejected');
  assert.ok(row.refund_rejected_at >= row.refund_requested_at);

  // 合约已禁止被拒后重复申请（防无限冻结循环，见 Escrow.sol requestRefund）——
  // 本地镜像保持事件映射能力（幂等），但真实链上不会再出现 requested→rejected→requested
  assert.equal(applyEvent('RefundRequested', { orderId: a.orderIdHex }), 1, '镜像层仍按事件翻转（防御性兼容）');
  row = refundRowOf(a.id);
  assert.equal(row.refund_status, 'requested');
});

test('RefundApproved：escrowed/shipped/disputed → refunded 终态（售后标记复位）', () => {
  // 申请后卖家同意退款
  const a = insertOrder('shipped');
  applyEvent('RefundRequested', { orderId: a.orderIdHex });
  assert.equal(applyEvent('RefundApproved', { orderId: a.orderIdHex, refundWei: FULL_REFUND }), 1);
  const rowA = refundRowOf(a.id);
  assert.equal(rowA.status, 'refunded');
  assert.equal(rowA.refund_status, 'none', '终态后售后标记复位（结果由订单状态表达）');

  // 争议中卖家主动和解退款（disputed → refunded，链上 RefundApproved 同事件）
  const b = insertOrder('disputed');
  assert.equal(applyEvent('RefundApproved', { orderId: b.orderIdHex, refundWei: FULL_REFUND }), 1);
  assert.equal(statusOf(b.id), 'refunded');

  // 终态不回退：confirmed 订单不受影响
  const c = insertOrder('confirmed');
  assert.equal(applyEvent('RefundApproved', { orderId: c.orderIdHex, refundWei: FULL_REFUND }), 0);
  assert.equal(statusOf(c.id), 'confirmed');

  // 事件史：三事件成功迁移均留痕（供仲裁/信誉溯源）
  const d = insertOrder('escrowed');
  applyEvent('RefundRequested', { orderId: d.orderIdHex }, { txHash: '0x' + '1'.repeat(64), block: 60 });
  applyEvent('RefundApproved', { orderId: d.orderIdHex, refundWei: FULL_REFUND }, { txHash: '0x' + '2'.repeat(64), block: 61 });
  const events = JSON.parse(db.prepare('SELECT onchain_events FROM orders WHERE id = ?').get(d.id).onchain_events);
  assert.deepEqual(events.map((e) => e.name), ['RefundRequested', 'RefundApproved']);
});

test('OrderExpiredReleased：draft/escrowed/shipped → expired（超时释放给卖家）', () => {
  const a = insertOrder('escrowed');
  assert.equal(applyEvent('OrderExpiredReleased', { orderId: a.orderIdHex }), 1);
  assert.equal(statusOf(a.id), 'expired');

  const b = insertOrder('draft'); // paid 前即被超时释放（事件区间漏扫兜底）
  applyEvent('OrderExpiredReleased', { orderId: b.orderIdHex });
  assert.equal(statusOf(b.id), 'expired');

  // 已发货（shipped）后买家拖单不确认，链上超时释放同样落地为 expired（钱货两清）
  const c = insertOrder('shipped');
  applyEvent('OrderExpiredReleased', { orderId: c.orderIdHex });
  assert.equal(statusOf(c.id), 'expired');

  // 审计 P3-1：超时即终局，售后镜像复位（此前若带 rejected 残留则一并清掉）
  const d = insertOrder('escrowed');
  db.prepare("UPDATE orders SET refund_status = 'rejected', refund_rejected_at = ? WHERE id = ?").run(Date.now(), d.id);
  applyEvent('OrderExpiredReleased', { orderId: d.orderIdHex });
  const rd = db.prepare('SELECT status, refund_status FROM orders WHERE id = ?').get(d.id);
  assert.equal(rd.status, 'expired');
  assert.equal(rd.refund_status, 'none', '超时终局复位售后镜像残留');
});

test('审计 P2-2：被焊成 confirmed 的镜像可被真实超时事件纠正为 expired', () => {
  /*
    场景：链上实际超时释放，但本地先被**别的路径**焊成 confirmed（历史数据：旧版 /sync 把链上
    Settled 一律落 confirmed，占位保留），真实 OrderExpiredReleased 事件随后到达——此前 from 集
    无 confirmed 而永久错标。
    注：/sync 自 2026-09 收敛后不再产出 confirmed（链上快照无从证明"买家确认收货"这个动作），
    但**历史行**仍可能停在 confirmed，故本 from 集必须保留它。
  */
  const a = insertOrder('confirmed');
  // confirmed 镜像无交付行（未发货被误标）：事件到达应纠正为 expired（真实确认后
  // 链上不会再发本事件，纳入 confirmed 无回退风险）
  assert.equal(applyEvent('OrderExpiredReleased', { orderId: a.orderIdHex }), 1);
  assert.equal(statusOf(a.id), 'expired');
});

test('审计 P1-2：同批追赶回放中 OrderCreated 带 skipAutoDeliver 不自动交付', async () => {
  // 需要在数字商品上验证码未被分配——用真实路由建码池与订单（auto-deliver.test 基建较重），
  // 此处验证 watcher 迁移语义 + meta 传递：skipAutoDeliver=true 时 OrderCreated 仍正常
  // 推进 escrowed（迁移与交付解耦），且随后的终局事件正常生效。
  const a = insertOrder('draft');
  assert.equal(applyEvent('OrderCreated', { orderId: a.orderIdHex, buyer: GOOD_BUYER, seller: GOOD_SELLER, amount: GOOD_AMOUNT }, { txHash: '0x' + '1'.repeat(64), block: 5, skipAutoDeliver: true }), 1);
  assert.equal(statusOf(a.id), 'escrowed', '跳过自动交付不影响迁移');
  // 同批后续 RefundApproved：终局照常应用（码未发，无「已退款仍得码」）
  applyEvent('RefundRequested', { orderId: a.orderIdHex });
  assert.equal(applyEvent('RefundApproved', { orderId: a.orderIdHex, refundWei: FULL_REFUND }, { txHash: '0x' + '2'.repeat(64), block: 6 }), 1);
  assert.equal(statusOf(a.id), 'refunded');
});

test('终态不回退：confirmed 订单不受 DisputeRequested/ReceiptConfirmed 影响', () => {
  const a = insertOrder('confirmed');
  assert.equal(applyEvent('DisputeRequested', { orderId: a.orderIdHex }), 0);
  assert.equal(applyEvent('Arbitrated', { orderId: a.orderIdHex, refundWei: FULL_REFUND }), 0);
  assert.equal(statusOf(a.id), 'confirmed');
});

test('未知订单事件 changes=0（本地无对应 escrow_order_id）', () => {
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: '0x' + 'f'.repeat(64) }), 0);
});

test('事件史：迁移成功记录 {name,txHash,block,at}，失败/无凭证不落脏数据', () => {
  const a = insertOrder('draft');
  applyEvent('OrderCreated', { orderId: a.orderIdHex }, { txHash: '0x' + 'a'.repeat(64), block: 42 });
  applyEvent('OrderExpiredReleased', { orderId: a.orderIdHex }, { txHash: '0x' + 'b'.repeat(64), block: 43 });
  const events = JSON.parse(db.prepare('SELECT onchain_events FROM orders WHERE id = ?').get(a.id).onchain_events);
  assert.equal(events.length, 2, '每次成功迁移应追加一条事件史');
  assert.equal(events[0].name, 'OrderCreated');
  assert.equal(events[0].txHash, '0x' + 'a'.repeat(64));
  assert.equal(events[0].block, 42);
  assert.ok(events[0].at > 0);
  assert.equal(events[1].name, 'OrderExpiredReleased');

  // 状态不匹配（changes=0）与未知订单不记录
  const b = insertOrder('confirmed');
  applyEvent('OrderCreated', { orderId: b.orderIdHex }, { txHash: '0x' + 'c'.repeat(64), block: 50 });
  assert.equal(db.prepare('SELECT onchain_events FROM orders WHERE id = ?').get(b.id).onchain_events, null);

  // 不带 meta（如单测直调）时仍记录事件名，txHash/block 为 null
  const c = insertOrder('draft');
  applyEvent('OrderCreated', { orderId: c.orderIdHex });
  const ev0 = JSON.parse(db.prepare('SELECT onchain_events FROM orders WHERE id = ?').get(c.id).onchain_events)[0];
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
    amount: GOOD_AMOUNT,
    ...overrides,
  };
}

test('防伪：金额不符的托管事件不推进（0 金额/少付均拒）', () => {
  const a = insertOrder('draft');
  assert.equal(applyEvent('OrderCreated', createdArgs(a.orderIdHex, { amount: 1n })), 0);
  assert.equal(
    db.prepare('SELECT status FROM orders WHERE id = ?').get(a.id).status,
    'draft'
  );
});

test('防伪：卖家不符的托管事件不推进', () => {
  const a = insertOrder('draft');
  assert.equal(applyEvent('OrderCreated', createdArgs(a.orderIdHex, { seller: '0x' + '2'.repeat(40) })), 0);
  assert.equal(
    db.prepare('SELECT status FROM orders WHERE id = ?').get(a.id).status,
    'draft'
  );
});

test('防伪：金额/卖家全部匹配的真实托管事件正常推进', () => {
  const a = insertOrder('draft');
  assert.equal(applyEvent('OrderCreated', createdArgs(a.orderIdHex), { txHash: '0x' + 'd'.repeat(64), block: 9 }), 1);
  const row = db.prepare('SELECT status, onchain_events, paid_tx_hash FROM orders WHERE id = ?').get(a.id);
  assert.equal(row.status, 'escrowed');
  assert.equal(row.paid_tx_hash, '0x' + 'd'.repeat(64));
  assert.ok(row.onchain_events);
});

test('防伪：买家不符的托管事件不推进（他人钱包代付不得确认本单/触发交付）', () => {
  const a = insertOrder('draft');
  const stranger = '0x' + '3'.repeat(40);
  assert.equal(applyEvent('OrderCreated', createdArgs(a.orderIdHex, { buyer: stranger })), 0);
  assert.equal(
    db.prepare('SELECT status FROM orders WHERE id = ?').get(a.id).status,
    'draft'
  );
});

test('cancelled 行自动恢复：草稿超时关闭后链上托管落定 → watcher 复活为 escrowed（落凭证）', () => {
  const a = insertOrder('draft');
  // 模拟 sweeper 关单（草稿 → cancelled，无凭证）
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(a.id);
  assert.equal(
    applyEvent('OrderCreated', createdArgs(a.orderIdHex), { txHash: '0x' + 'e'.repeat(64), block: 10 }),
    1,
    '已取消行收到匹配的真实托管事件应自动恢复'
  );
  const row = db.prepare('SELECT status, paid_tx_hash FROM orders WHERE id = ?').get(a.id);
  assert.equal(row.status, 'escrowed');
  assert.equal(row.paid_tx_hash, '0x' + 'e'.repeat(64));
});

test('cancelled 行不匹配事件不复活（金额/买家不符的伪造事件不能恢复取消单）', () => {
  const a = insertOrder('cancelled');
  assert.equal(applyEvent('OrderCreated', createdArgs(a.orderIdHex, { amount: 1n })), 0);
  assert.equal(
    db.prepare('SELECT status FROM orders WHERE id = ?').get(a.id).status,
    'cancelled'
  );
});

// ── 按退款额拆分结算（2026-09：能给出部分金额的有两条出口——仲裁人的 `arbitrate(orderId, refundWei)`
//    （任意比例、无需授权）与卖家 `approveRefund(orderId, refundWei)` 且 refundWei **恰好等于买家
//    `acceptPartialRefund` 授权过的那个数**；其它金额一律 RefundAmountNotAccepted，旧的 RefundNotFull 已删除。
//    本文件只钉"按额分流"本身，买家授权链路的端到端见 test/partial-refund-consent.test.js）──

test('拆分结算：部分退款（refundWei < amount）落 settled 并记录已退金额', () => {
  const a = insertOrder('disputed');
  const changed = applyEvent('Arbitrated', { orderId: a.orderIdHex, refundWei: '400000000000000000' }, {
    txHash: '0x' + '7'.repeat(64),
    block: 70,
    chainParams: {
      buyer: '0x00000000000000000000000000000000000000aa',
      seller: '0x00000000000000000000000000000000000000bb',
      amount: '1000000000000000000',
    },
  });
  assert.equal(changed, 1);
  const row = db.prepare('SELECT status, refund_status, refunded_amount_wei FROM orders WHERE id = ?').get(a.id);
  assert.equal(row.status, 'settled', '部分退款属「拆分结算」→ 成交向终态 settled');
  assert.equal(row.refunded_amount_wei, '400000000000000000', '已退金额必须落库（账本净额/UI 依据）');
  assert.equal(row.refund_status, 'none', '终局复位售后镜像');
});

test('拆分结算：refundWei = amount 落 refunded（全额退款），0 落 settled（全额判卖家）', () => {
  const full = insertOrder('disputed');
  applyEvent('Arbitrated', { orderId: full.orderIdHex, refundWei: '1000000000000000000' });
  assert.equal(statusOf(full.id), 'refunded');
  assert.equal(
    db.prepare('SELECT refunded_amount_wei FROM orders WHERE id = ?').get(full.id).refunded_amount_wei,
    '1000000000000000000'
  );

  const none = insertOrder('disputed');
  applyEvent('Arbitrated', { orderId: none.orderIdHex, refundWei: 0n });
  assert.equal(statusOf(none.id), 'settled');
  assert.equal(
    db.prepare('SELECT refunded_amount_wei FROM orders WHERE id = ?').get(none.id).refunded_amount_wei,
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
test('按额判定：RefundApproved 带部分金额（历史/ABI 容错）同样落 settled + 已退金额', () => {
  const a = insertOrder('shipped');
  applyEvent('RefundApproved', { orderId: a.orderIdHex, refundWei: '250000000000000000' });
  const row = db.prepare('SELECT status, refunded_amount_wei FROM orders WHERE id = ?').get(a.id);
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

test('防伪（终局事件）：链上买家与本单买家不符的 OrderExpiredReleased 不得把未付款草稿改成 expired', () => {
  const a = insertOrder('draft');
  const changed = applyEvent('OrderExpiredReleased', { orderId: a.orderIdHex }, {
    txHash: '0x' + 'a'.repeat(64),
    block: 100,
    // pollOnce 预取的链上真值：买家是攻击者、金额 1 wei（诱饵单）
    chainParams: { buyer: OTHER_BUYER, seller: '0x' + 'b'.repeat(40), amount: '1' },
  });
  assert.equal(changed, 0, '与链上真值不符的终局事件不推进');
  assert.equal(statusOf(a.id), 'draft', '受害者草稿保持未支付');
  const row = db.prepare('SELECT onchain_events FROM orders WHERE id = ?').get(a.id);
  assert.ok(!row.onchain_events || !String(row.onchain_events).includes('OrderExpiredReleased'), '伪造事件不得进入事件史');
});

test('防伪（终局事件）：链上真值一致时正常推进（真实超时释放不受影响）', () => {
  const a = insertOrder('escrowed');
  const changed = applyEvent('OrderExpiredReleased', { orderId: a.orderIdHex }, {
    txHash: '0x' + 'c'.repeat(64),
    block: 101,
    chainParams: {
      buyer: '0x00000000000000000000000000000000000000aa',
      seller: '0x00000000000000000000000000000000000000bb',
      amount: '1000000000000000000',
    },
  });
  assert.equal(changed, 1);
  assert.equal(statusOf(a.id), 'expired');
});

test('防伪（仲裁/退款类事件）：链上金额不符的 Arbitrated 不得推进', () => {
  const a = insertOrder('disputed');
  const changed = applyEvent('Arbitrated', { orderId: a.orderIdHex, refundWei: FULL_REFUND }, {
    chainParams: {
      buyer: '0x00000000000000000000000000000000000000aa',
      seller: '0x00000000000000000000000000000000000000bb',
      amount: '1', // 诱饵单金额
    },
  });
  assert.equal(changed, 0);
  assert.equal(statusOf(a.id), 'disputed');

  const b = insertOrder('disputed');
  const done = applyEvent('Arbitrated', { orderId: b.orderIdHex, refundWei: FULL_REFUND }, {
    chainParams: {
      buyer: '0x00000000000000000000000000000000000000aa',
      seller: '0x00000000000000000000000000000000000000bb',
      amount: '1000000000000000000',
    },
  });
  assert.equal(done, 1);
  assert.equal(statusOf(b.id), 'refunded');
});

// ── 源码审计 2026-09：终局事件的 from 集与 /sync 口径对齐（防流水漏计） ──

test('终局 from 集对齐 /sync：cancelled 残镜像收到超时释放/仲裁/退款事件后收敛（卖家流水不再漏计）', () => {
  // 草稿被清扫（cancelled）后链上才落定并终局——此前这些行永远停在 cancelled，
  // INCOME_STATUS 计不到，卖家实际收到的钱不出现在账本里（/sync 早已支持该口径）
  const a = insertOrder('cancelled');
  assert.equal(applyEvent('OrderExpiredReleased', { orderId: a.orderIdHex }), 1, 'cancelled → expired');
  assert.equal(statusOf(a.id), 'expired');

  const b = insertOrder('cancelled');
  assert.equal(applyEvent('RefundApproved', { orderId: b.orderIdHex, refundWei: FULL_REFUND }), 1, 'cancelled → refunded');
  assert.equal(statusOf(b.id), 'refunded');

  const c = insertOrder('cancelled');
  assert.equal(applyEvent('Arbitrated', { orderId: c.orderIdHex, refundWei: 0n }), 1, 'cancelled → settled');
  assert.equal(statusOf(c.id), 'settled');
});

test('漏扫 OrderCreated 的 draft 残镜像：收到确认/争议事件后收敛到对应状态', () => {
  const a = insertOrder('draft');
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: a.orderIdHex }), 1, 'draft → confirmed（链上确已结算）');
  assert.equal(statusOf(a.id), 'confirmed');

  const b = insertOrder('draft');
  assert.equal(applyEvent('DisputeRequested', { orderId: b.orderIdHex }), 1, 'draft → disputed');
  assert.equal(statusOf(b.id), 'disputed');
});

test('冻结路径的 from 集也接受 cancelled：取消后才支付的单不会永久停在 cancelled', () => {
  /*
    竞态：草稿被清扫成 cancelled → 买家随后真的完成了支付（watcher 靠 OrderCreated 救回），
    但若那次扫描也漏了，之后买家申请退款、被拒、发起争议时——本地行必须能迁到 disputed，
    否则链上那笔钱已被冻结，本地却显示"已取消"（三条修复路径都碰不到它，没有任何兜底）。
    终局路径（expired/refunded/settled）早已接受 cancelled，冻结路径此前漏了。
  */
  const a = insertOrder('cancelled');
  assert.equal(applyEvent('DisputeRequested', { orderId: a.orderIdHex }), 1, 'cancelled → disputed');
  assert.equal(statusOf(a.id), 'disputed');
});

// ── 源码审计 2026-09：webhook 副作用移出事务（回滚不得通知「已托管」） ──

test('副作用时序：迁移抛错回滚时不发通知，成功时通知在提交后发出', async () => {
  const sent = [];
  const { setWebhookSender, resetWebhookStatus } = await import('../src/webhook.js');
  const { kvSet } = await import('../src/db.js');
  kvSet('mk:webhook_url', 'https://example.com/hook');
  resetWebhookStatus();
  setWebhookSender(async (url, opts) => {
    sent.push(JSON.parse(opts.body).type);
    return { ok: true, status: 200 };
  });

  const a = insertOrder('draft');
  applyEvent('OrderCreated', createdArgs(a.orderIdHex), { txHash: '0x' + 'f'.repeat(64), block: 12 });
  /*
    通知是 fire-and-forget（投递前还有一次 SSRF 校验，其中含**真实 DNS 解析**），固定 20ms 的
    等待在整套测试并行跑（多个测试文件同时占 CPU + 解析 example.com）时会偶发不够——等待改成
    有界轮询：断言不变（必须发出 order.escrowed），只是不再假设一个固定的墙钟时间。
  */
  const until = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
    return pred();
  };
  assert.ok(await until(() => sent.includes('order.escrowed')), '提交成功后应发出 order.escrowed');
});

// ── 源码审计 2026-09 续：一次性告警的「投递成功才写幂等标记」 ──

/** 有界轮询等待（投递结算是异步的：固定 sleep 在整套测试并行跑时会偶发不够） */
async function waitUntil(pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  return pred();
}

/**
 * `order.hold_missing`（取消期间限量库存已被他人买走、订单被恢复但未重新占位）是核账告警：
 * 原来它是「先 kvSet(ackKey,'1') 再 notifyRaw(...)」——投递一失败（URL 写错 / 被 SSRF 拦下 /
 * 店主服务器 5xx / 超时）标记已写死，店主**永远**收不到"存在超卖，请扩容或退款"这条。
 * 现在标记只在投递成功后写（见 src/alertAck.js）：失败 ⇒ 不写 ⇒ 事件重放（重启/重组重扫同一
 * OrderCreated）时重试；成功 ⇒ 写标记 ⇒ 再重放不再重复推。
 */
test('order.hold_missing：投递失败不写标记（事件重放会重试）；投递成功才写标记且不再重复', async () => {
  const { setWebhookSender } = await import('../src/webhook.js');
  const { kvSet } = await import('../src/db.js');
  kvSet('mk:webhook_url', 'https://93.184.216.34/hook/hold');
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
  */
  const now = Date.now();
  seq += 1;
  const id = `w-held-${seq}`;
  const orderIdHex = `0x${String(seq).padStart(64, '0')}`;
  const slug = `w-held-product-${seq}`;
  const productId = Number(
    db
      .prepare("INSERT INTO products (slug, title, kind, snapshot_hash, created_at, updated_at) VALUES (?, '占位恢复失败商品', 'physical', '0x00', ?, ?)")
      .run(slug, now, now).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO product_skus (product_id, sku_key, specs_json, price_cny_fen, capacity, committed, created_at, updated_at)
     VALUES (?, '', '{}', 8800, 1, 1, ?, ?)`
  ).run(productId, now, now);
  db.prepare(
    `INSERT INTO orders (id, product_id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       quantity, hold_qty, released_at, amount_wei, cny_fen, bty_usdt_rate, usdt_cny_rate, status, escrow_order_id, paid_tx_hash, created_at, updated_at)
     VALUES (?, ?, ?, '{}', '0x00', '', '${GOOD_BUYER}', '${GOOD_SELLER}',
       1, 1, ?, '1000000000000000000', 100, '0.1', '7.2', 'cancelled', ?, NULL, ?, ?)`
  ).run(id, productId, slug, now, orderIdHex, now, now);

  const ackKey = `mk:escrow_hold_missing:${id}`;
  const flagged = () => ((db.prepare('SELECT value FROM kv WHERE key = ?').get(ackKey) || {}).value || '') === '1';
  const replay = () => applyEvent('OrderCreated', createdArgs(orderIdHex), { txHash: '0x' + '9'.repeat(64), block: 20 });
  /** 事件重放：把行放回"取消且无凭证"的初始态（watcher 重启/短重组重扫同一事件即如此） */
  const rewind = () => db.prepare("UPDATE orders SET status = 'cancelled', paid_tx_hash = NULL WHERE id = ?").run(id);

  try {
    // 1) 投递总是失败：不得写标记
    assert.equal(replay(), 1, '恢复为 escrowed（链上资金真实存在，不得因本地账目卡住）');
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'escrowed');
    assert.ok(await waitUntil(() => failed.hold_missing >= 3), '投递方重试 2 次后结算失败');
    assert.equal(flagged(), false, '投递失败：不得写幂等标记（写死 = 店主永远收不到这条核账告警）');

    // 2) 事件重放（同一 OrderCreated 再扫一遍）：没写标记 ⇒ 仍会投递 —— at-least-once
    rewind();
    sent.length = 0;
    assert.equal(replay(), 1, '重放同样恢复订单');
    assert.ok(await waitUntil(() => failed.hold_missing >= 6), '第二轮同样重试到结算');
    assert.equal(flagged(), false, '仍未送达 ⇒ 仍未写标记');

    // 3) 店主服务器恢复：送达后写标记；再重放不再重复告警
    setWebhookSender(capture);
    rewind();
    sent.length = 0;
    assert.equal(replay(), 1);
    assert.ok(await waitUntil(() => sent.some((s) => s.body.type === 'order.hold_missing')), '这次送达了');
    assert.match(sent[0].body.reason, /扩容|退款/);
    assert.ok(await waitUntil(flagged), '投递成功后才写幂等标记');
    rewind();
    sent.length = 0;
    assert.equal(replay(), 1);
    await waitUntil(() => false, 60); // 让可能的投递落定（有界短等，失败也只是断言更严）
    assert.equal(sent.filter((s) => s.body.type === 'order.hold_missing').length, 0, '已成功告警过：不再重复推');
  } finally {
    setWebhookSender(capture);
  }
});
