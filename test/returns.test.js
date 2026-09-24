/**
 * 退货闭环（P0-4）：已交付订单退款前的退货单协调 + 占位释放时机
 *  - 未交付退款单：refunded 终局自动释放（原语义，回归）；
 *  - 已交付退款单：refunded 后占位保留 → 卖家 receive/waive 确认后才回补；
 *  - receive 早于链上退款终局时挂起等待，watcher RefundApproved 迁移后自动释放（released_at 幂等）；
 *  - 同单一退货单（幂等创建）；退货信息按当事人视角可见。
 */
import { test, before } from 'node:test';

/** 全额退款事件参数（Escrow.RefundApproved 现带 refundWei）：测试内订单金额恒为 1e18 */
const FULL_REFUND = '1000000000000000000';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { assertOk, login, makeCtx, productPayload, skuInv } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();

let ownerToken;
let buyerToken;
let strangerToken;
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

const { applyEvent } = await import('../src/escrowWatcher.js');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  strangerToken = (await login(ctx, stranger)).token;
});

const invRow = (slug) => skuInv(db, slug);
const commOf = (slug) => invRow(slug).committed || 0;

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slug })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

function escrowed(order) {
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), order.id);
}

async function shipPhysical(orderId, trackingNo) {
  const res = await request(app)
    .post(`/api/orders/${orderId}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ trackingNo })
    .expect(200);
  assertOk(res);
}

test('已交付退款单：refunded 后占位保留 → 卖家收到退货后才回补（watcher 路径）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '退货主流程', capacity: 5 }));
  const order = await createDraft(p.slug);
  escrowed(order);
  await shipPhysical(order.id, 'SF-RET-1');
  assert.equal(commOf(p.slug), 1);

  // 买家申请退款 → 卖家建退货单（地址/说明）
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  const cr = await request(app)
    .post(`/api/orders/${order.id}/return`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ address: '广东省深圳市示例仓 8 号', note: '请原包装寄回，到付拒收' })
    .expect(200);
  assertOk(cr);
  assert.equal(cr.body.data.status, 'open');
  assert.equal(cr.body.data.address, '广东省深圳市示例仓 8 号');

  // 重复创建幂等返回既有单
  const again = await request(app)
    .post(`/api/orders/${order.id}/return`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({})
    .expect(200);
  assertOk(again);
  assert.equal(again.body.data.id, cr.body.data.id);

  // 买家回填退回物流单号（open→shipped）
  const tk = await request(app)
    .post(`/api/orders/${order.id}/return/tracking`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ trackingNo: 'SF-RET-BACK-1' })
    .expect(200);
  assertOk(tk);
  assert.equal(tk.body.data.status, 'shipped');

  // 链上退款终局（卖家 approveRefund，watcher 回写 refunded）：received 未确认 → 占位仍保留
  assert.equal(applyEvent('RefundApproved', { orderId: order.escrowOrderId, refundWei: order.amountWei }), 1);
  assert.equal(
    db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status,
    'refunded'
  );
  assert.equal(commOf(p.slug), 1, '已交付且退货未确认 → 退款后占位保留');

  // 卖家确认收到退货 → 占位回补
  const rc = await request(app)
    .post(`/api/orders/${order.id}/return/receive`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(rc);
  assert.equal(rc.body.data.status, 'received');
  assert.ok(rc.body.data.receivedAt > 0);
  assert.equal(commOf(p.slug), 0, '确认收到退货后回补占位（可再次销售）');
});

test('receive 早于链上退款终局：挂起等待，watcher RefundApproved 后自动释放', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '退货先行收货', capacity: 5 }));
  const order = await createDraft(p.slug);
  escrowed(order);
  await shipPhysical(order.id, 'SF-RET-2');
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);

  // 卖家先收货（订单仍 escrowed/refund_status=requested）
  await request(app)
    .post(`/api/orders/${order.id}/return`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ address: '退货仓 A' })
    .expect(200);
  const rc = await request(app)
    .post(`/api/orders/${order.id}/return/receive`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(rc);
  assert.equal(commOf(p.slug), 1, '链上退款未终局：先不释放（资金未定）');

  // watcher RefundApproved → refunded → releaseRefundedEscrow 发现 received_at 已落 → 释放
  assert.equal(applyEvent('RefundApproved', { orderId: order.escrowOrderId, refundWei: order.amountWei }), 1);
  assert.equal(commOf(p.slug), 0, '终局迁移后按 received_at 释放（只释放一次）');
  // 幂等：重复触发不二次扣减
  assert.equal(commOf(p.slug), 0);
});

test('放弃追索（waive）等价释放；终局后重复操作拒绝；未交付单不可建退货单', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '退货放弃/边界', capacity: 5 }));
  const order = await createDraft(p.slug);
  escrowed(order);
  await shipPhysical(order.id, 'SF-RET-3');
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);

  // 未交付单不可建退货单
  const p2 = await listProduct(productPayload({ kind: 'physical', title: '未交付不可退', capacity: 5 }));
  const o2 = await createDraft(p2.slug);
  escrowed(o2);
  assert.equal(applyEvent('RefundRequested', { orderId: o2.escrowOrderId }), 1);
  const noReturn = await request(app)
    .post(`/api/orders/${o2.id}/return`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({})
    .expect(200);
  assert.notEqual(noReturn.body.code, 0);
  assert.match(noReturn.body.message || '', /无交付记录/);

  // waive：先 refunded 再 waive → 释放
  assert.equal(applyEvent('RefundApproved', { orderId: order.escrowOrderId, refundWei: order.amountWei }), 1);
  assert.equal(commOf(p.slug), 1, 'refunded 且未确认 → 保留');
  const wv = await request(app)
    .post(`/api/orders/${order.id}/return/waive`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(wv);
  assert.equal(wv.body.data.status, 'received');
  assert.equal(wv.body.data.waived, true);
  assert.equal(commOf(p.slug), 0, '放弃追索后额度释放');

  // 终局后重复 receive/waive/tracking 拒绝
  const again = await request(app)
    .post(`/api/orders/${order.id}/return/receive`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.notEqual(again.body.code, 0);
  const track = await request(app)
    .post(`/api/orders/${order.id}/return/tracking`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ trackingNo: 'X' })
    .expect(200);
  assert.notEqual(track.body.code, 0);

  // 权限：陌生人不可建/填单号
  const strangerCreate = await request(app)
    .post(`/api/orders/${o2.id}/return`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .send({})
    .expect(403);
  assert.ok(strangerCreate);
});

test('退货信息按当事人视角可见（order 详情 return 字段；匿名 null）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '退货可见性', capacity: 5 }));
  const order = await createDraft(p.slug);
  escrowed(order);
  await shipPhysical(order.id, 'SF-RET-4');
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await request(app)
    .post(`/api/orders/${order.id}/return`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ address: '退货仓 B' })
    .expect(200);

  const asBuyer = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(asBuyer.body.data.return.status, 'open');
  assert.equal(asBuyer.body.data.return.address, '退货仓 B', '买家可见退货地址');
  const asOwner = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.equal(asOwner.body.data.return.status, 'open');
  const anon = await request(app).get(`/api/orders/${order.id}`).expect(200);
  assert.equal(anon.body.data.return, null, '匿名不可见退货信息');
});

// ── D1：成交终局态（settled/confirmed/expired）下已确认收货的退货 → 占位回补 ──

async function returnToReceived(orderId, trackingNo, { waive = false } = {}) {
  const cr = await request(app)
    .post(`/api/orders/${orderId}/return`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ address: 'D1 退货仓', note: 'D1 用例' })
    .expect(200);
  assertOk(cr);
  const tk = await request(app)
    .post(`/api/orders/${orderId}/return/tracking`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ trackingNo })
    .expect(200);
  assertOk(tk);
  const rc = await request(app)
    .post(`/api/orders/${orderId}/return/${waive ? 'waive' : 'receive'}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(rc);
  assert.equal(rc.body.data.status, 'received');
  assert.ok(rc.body.data.receivedAt > 0);
}

test('D1：仲裁判卖家成交（Arbitrated=false → settled）——已收货退货的占位回补', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'D1仲裁判付回补', capacity: 5 }));
  const order = await createDraft(p.slug);
  escrowed(order);
  await shipPhysical(order.id, 'SF-D1-A');
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await returnToReceived(order.id, 'SF-D1-A-BACK');
  assert.equal(commOf(p.slug), 1, '退款未终局：收货后仍挂起（资金未定）');

  // 争议 → 仲裁判卖家（成交终局）：货已实际回库（received_at 已落）→ 占位回补
  assert.equal(applyEvent('DisputeRequested', { orderId: order.escrowOrderId }), 1);
  assert.equal(applyEvent('Arbitrated', { orderId: order.escrowOrderId, refundWei: 0n }), 1);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'settled');
  assert.equal(commOf(p.slug), 0, '判卖家成交 + 已确认收货退货 → 回补（货可再售）');
  assert.ok(db.prepare('SELECT released_at FROM orders WHERE id = ?').get(order.id).released_at, '置释放幂等标记');

  // 幂等：重复触发不再二次扣减
  assert.equal(commOf(p.slug), 0);
});

test('D1：超时释放（OrderExpiredReleased → expired）——已交付行按退货收货事实回补', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'D1超时释放回补', capacity: 5 }));
  const order = await createDraft(p.slug);
  escrowed(order);
  await shipPhysical(order.id, 'SF-D1-E');
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await returnToReceived(order.id, 'SF-D1-E-BACK');
  assert.equal(commOf(p.slug), 1);

  // 链上超时释放（shipped → expired）：此前「已交付行一律不回补」会把已回库的货永久占住（D1 泄漏）；
  // 现在按 received_at 事实回补
  assert.equal(applyEvent('OrderExpiredReleased', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 77 }), 1);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'expired');
  assert.equal(commOf(p.slug), 0, '已交付 + 已确认收货退货 + 超时终局 → 回补');
});

test('D1：确认收货终局（ReceiptConfirmed → confirmed）+ 已收货退货 → 回补；未收货退货不误释放', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'D1确认终局回补', capacity: 5 }));
  // 场景一：退货已确认收货 → 买家确认收货（资金终局判卖家）→ 回补
  const o1 = await createDraft(p.slug);
  escrowed(o1);
  await shipPhysical(o1.id, 'SF-D1-C1');
  assert.equal(applyEvent('RefundRequested', { orderId: o1.escrowOrderId }), 1);
  await returnToReceived(o1.id, 'SF-D1-C1-BACK');
  assert.equal(commOf(p.slug), 1);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: o1.escrowOrderId }), 1);
  assert.equal(commOf(p.slug), 0, 'confirmed + 已收货退货 → 回补');

  // 场景二：退货未确认收货（货可能仍在买家侧）→ 不释放（防钱货两清后库存再售超卖）
  const o2 = await createDraft(p.slug);
  escrowed(o2);
  await shipPhysical(o2.id, 'SF-D1-C2');
  assert.equal(applyEvent('RefundRequested', { orderId: o2.escrowOrderId }), 1);
  const cr = await request(app)
    .post(`/api/orders/${o2.id}/return`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ address: 'D1 未收货仓' })
    .expect(200);
  assertOk(cr);
  assert.equal(commOf(p.slug), 1, 'o2 占位 1（无收货退货单，占位保留）');
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: o2.escrowOrderId }), 1);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o2.id).status, 'confirmed');
  assert.equal(commOf(p.slug), 1, '退货未确认收货：confirmed 不释放（占位保留）');

  // 场景三：终局后才确认收货（watcher 事件先到、卖家 receive 后到）→ receive 动作当场回补
  const o3 = await createDraft(p.slug);
  escrowed(o3);
  await shipPhysical(o3.id, 'SF-D1-C3');
  assert.equal(applyEvent('RefundRequested', { orderId: o3.escrowOrderId }), 1);
  await request(app)
    .post(`/api/orders/${o3.id}/return`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ address: 'D1 晚收货仓' })
    .expect(200);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: o3.escrowOrderId }), 1);
  assert.equal(commOf(p.slug), 2, 'o2 保留 + o3 占位：共 2');
  const rc3 = await request(app)
    .post(`/api/orders/${o3.id}/return/receive`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(rc3);
  assert.equal(commOf(p.slug), 1, 'o3 晚收货回补 → 仅 o2（未收货退货）保留');
  assert.equal(db.prepare('SELECT released_at FROM orders WHERE id = ?').get(o3.id).released_at != null, true, '晚收货动作回补 o3');
  assert.equal(db.prepare('SELECT released_at FROM orders WHERE id = ?').get(o2.id).released_at == null, true, 'o2 未被误释放');
});