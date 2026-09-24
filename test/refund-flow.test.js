/**
 * 两级退货退款流程（B4，链上强制、本地镜像）：
 *  - watcher 四事件回写：RefundRequested → refund_status=requested（资金冻结）；
 *    RefundRejected → rejected（解锁争议资格）；PartialRefundAccepted → 只记买家授权的部分退款额
 *    （不动状态，契约 2026-09 新增，端到端见 test/partial-refund-consent.test.js）；
 *    RefundApproved（全额，或**买家已精确授权过的那个部分金额**）→ refunded/settled 终态（占位回补）。
 *  - 陈述数据面：POST /api/orders/:id/evidence（refund_request 买家理由 / refund_reply 店主回复 /
 *    arbitration 争议陈述），阶段 × 身份 × 状态约束；详情按身份（buyer/owner/arbiter）附时间线。
 *  - 待仲裁摘要携带售后流程镜像（refundStatus/时间戳/evidenceCount）。
 *  - applyRefundFlags：sync 反查按链上 getOrder 退款标记权威回填（事件漏扫兜底）。
 * 链上动作不经真实网络（单测无 RPC）——与 watcher.test 同款：直调 applyEvent。
 */
import { test, before } from 'node:test';

/** 全额退款事件参数（Escrow.RefundApproved 现带 refundWei）：测试内订单金额恒为 1e18 */
const FULL_REFUND = '1000000000000000000';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { assertOk, login, makeCtx, productPayload, skuInv } from './setup.mjs';

// 必须在 makeCtx 之前设置（config 模块求值时读取，见 setup.mjs 头注释）
const arbiter = Wallet.createRandom();
process.env.MK_ARBITER_ADDRESS = arbiter.address;

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();

let ownerToken;
let buyerToken;
let strangerToken;
let arbiterToken;
// 模拟链上规范哈希（escrowed 必有支付凭证，发货防呆要求）
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

const { applyEvent } = await import('../src/escrowWatcher.js');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  strangerToken = (await login(ctx, stranger)).token;
  arbiterToken = (await login(ctx, arbiter)).token;
  assert.ok(ownerToken && buyerToken && strangerToken && arbiterToken);
});

async function listProduct(payload) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(payload)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 买家本人下单，返回订单 */
async function createDraft(slug, quantity = 1) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slug, quantity, buyer: buyer.address })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

function escrowed(order) {
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), order.id);
}

async function getDetail(id, token) {
  const req = request(app).get(`/api/orders/${id}`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  const res = await req.expect(200);
  assertOk(res);
  return res.body.data;
}

async function postEvidence(id, body, token) {
  // 拒绝分支含 HTTP 403（鉴权语义）与 200+code!=0（状态语义）两种，统一由调用方断言 body.code
  const req = request(app).post(`/api/orders/${id}/evidence`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
}

const blocked = (res) => {
  assert.notEqual(res.body.code, 0, '应被拒');
  return res.body.message || '';
};

// ── 两级售后端到端（限量实物商品：占位 → 申请 → 理由/回复 → 拒绝 → 争议 → 卖家和解退款）──

test('两级售后端到端：申请冻结→双方陈述→拒绝解锁→争议陈述→卖家同意退款（占位回补）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '两级售后实物', capacity: 5, priceCnyFen: 8800 }));
  const order = await createDraft(p.slug, 2);
  assert.equal(
    skuInv(db, p.slug).committed,
    2,
    '下单占位 2 件'
  );
  escrowed(order);
  const oid = order.id;
  const eid = order.escrowOrderId;

  // ── 阶段门控：未链上申请前提交退款理由被拒 ──
  const early = await postEvidence(oid, { phase: 'refund_request', content: '还没申请就想退' }, buyerToken);
  assert.match(blocked(early), /refund_status=requested/);

  // 买家链上 requestRefund（watcher 回写）
  assert.equal(applyEvent('RefundRequested', { orderId: eid }), 1);
  const afterReq = await getDetail(oid, buyerToken);
  assert.equal(afterReq.refundStatus, 'requested');
  assert.ok(afterReq.refundRequestedAt > 0, '详情携带申请时刻');
  assert.equal(afterReq.status, 'escrowed', '资金仍冻结在托管，等待卖家决策');

  // ── 陈述时间线：买家理由（可追加）→ 店主回复；角色/阶段严格校验 ──
  const r1 = await postEvidence(oid, { phase: 'refund_request', content: '收到实物与描述不符，申请退款' }, buyerToken);
  assertOk(r1);
  const r2 = await postEvidence(oid, { phase: 'refund_request', content: '补充：开箱视频已发邮箱' }, buyerToken);
  assertOk(r2);
  const reply = await postEvidence(oid, { phase: 'refund_reply', content: '请寄回商品后我同意退款' }, ownerToken);
  assertOk(reply);

  // 陌生人：不可提交（非当事人）
  const byStranger = await postEvidence(oid, { phase: 'refund_reply', content: '路人甲' }, strangerToken);
  assert.equal(blocked(byStranger), '仅本单买家或店主/操作员可提交陈述');
  // 买家不可替卖家回复；卖家不可提退款理由
  const buyerReply = await postEvidence(oid, { phase: 'refund_reply', content: '替卖家回复' }, buyerToken);
  assert.match(blocked(buyerReply), /仅店主可提交/);
  const ownerAsk = await postEvidence(oid, { phase: 'refund_request', content: '卖家申请退款？' }, ownerToken);
  assert.match(blocked(ownerAsk), /仅买家可提交/);
  // content 边界
  const emptyC = await postEvidence(oid, { phase: 'refund_reply', content: '   ' }, ownerToken);
  assert.match(blocked(emptyC), /content/);
  const overC = await postEvidence(oid, { phase: 'refund_reply', content: 'x'.repeat(2001) }, ownerToken);
  assert.match(blocked(overC), /content/);
  const badPhase = await postEvidence(oid, { phase: 'refund_chargeback', content: 'x' }, ownerToken);
  assert.match(blocked(badPhase), /phase/);

  // 匿名详情不带 evidence（私人陈述不随公开字段泄露）
  const anonDetail = await getDetail(oid);
  assert.ok(!('evidence' in anonDetail), '匿名不可见陈述');
  const strangerDetail = await getDetail(oid, strangerToken);
  assert.ok(!('evidence' in strangerDetail), '第三人不可见陈述');

  // ── 卖家拒绝（链上 rejectRefund）：解锁争议入口；申请阶段的陈述不再受理 ──
  assert.equal(applyEvent('RefundRejected', { orderId: eid }), 1);
  const afterRej = await getDetail(oid, ownerToken);
  assert.equal(afterRej.refundStatus, 'rejected');
  assert.ok(afterRej.refundRejectedAt >= afterReq.refundRequestedAt);
  const postReject = await postEvidence(oid, { phase: 'refund_request', content: '被拒后补理由' }, buyerToken);
  assert.match(blocked(postReject), /待卖家处理/);
  const arbEarly = await postEvidence(oid, { phase: 'arbitration', content: '先仲裁为敬' }, buyerToken);
  assert.match(blocked(arbEarly), /争议中/);

  // ── 买家链上 requestDispute（被拒后获得资格）→ 双方仲裁陈述 ──
  assert.equal(applyEvent('DisputeRequested', { orderId: eid }), 1);
  const arbB = await postEvidence(oid, { phase: 'arbitration', content: '商品与描述严重不符，诉求全额退款' }, buyerToken);
  assertOk(arbB);
  const arbS = await postEvidence(oid, { phase: 'arbitration', content: '买家未按约定寄回，我不同意仅退款' }, ownerToken);
  assertOk(arbS);

  // 待仲裁摘要携带售后镜像（仲裁人判断两级流程是否走完）
  const pend = await request(app).get('/api/arbitration/pending?pageSize=100').expect(200);
  assertOk(pend);
  const row = pend.body.data.disputes.find((d) => d.id === oid);
  assert.ok(row, '争议单入待仲裁列表');
  assert.equal(row.refundStatus, 'rejected');
  assert.ok(row.refundRequestedAt > 0 && row.refundRejectedAt > 0);
  assert.equal(row.evidenceCount, 5, '2 条买家理由 + 1 条店主回复 + 2 条仲裁陈述');

  // 仲裁人详情可见完整时间线（5 条已提交）
  const arbDetail = await getDetail(oid, arbiterToken);
  assert.equal(arbDetail.evidence.length, 5);
  assert.deepEqual(
    arbDetail.evidence.map((e) => e.role),
    ['buyer', 'buyer', 'seller', 'buyer', 'seller'],
    '按提交顺序形成时间线'
  );
  assert.equal(arbDetail.evidence[3].phase, 'arbitration');
  assert.equal(arbDetail.evidence[4].phase, 'arbitration');

  // 争议中卖家链上 approveRefund 和解（资金退买家）
  assert.equal(applyEvent('RefundApproved', { orderId: eid, refundWei: order.amountWei }), 1);
  const done = await getDetail(oid, buyerToken);
  assert.equal(done.status, 'refunded');
  assert.equal(done.refundStatus, 'none', '终态售后标记复位');
  assert.equal(
    skuInv(db, p.slug).committed,
    0,
    '退款后占位库存回补（可再售）'
  );
  // 终态后陈述不可再提交——注意拒绝理由来自**订单状态门控**（先于阶段门控）：
  // 终局的单连"售后陈述"这个面都不再受理（此前只报"仲裁陈述仅限争议中"，语义上少了一层：
  // 已退款/已取消的单根本不该再被写入新的个人数据，见 evidenceStatusError）
  const afterDone = await postEvidence(oid, { phase: 'arbitration', content: '还吵' }, buyerToken);
  assert.match(blocked(afterDone), /不接受新的售后陈述/);
  // 证据时间线保留可溯（事件史 + 陈述均在）
  const finalDetail = await getDetail(oid, buyerToken);
  assert.equal(finalDetail.evidence.length, 5, '退款后陈述仍可追溯（处理依据）');
});

// ── applyRefundFlags（sync 反查核心）：按链上退款标记权威回填/清除 ──

test('退款申请待决期间拒绝发货（ship 门控）：先链上拒绝申请或同意退款', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '冻结发货门控', capacity: 5 }));
  const order = await createDraft(p.slug);
  escrowed(order);
  const eid = order.escrowOrderId;

  // 买家链上申请退款（watcher 回写 requested）→ 卖家发货被拒
  assert.equal(applyEvent('RefundRequested', { orderId: eid }), 1);
  const ship = await request(app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ trackingNo: 'SF-001' })
    .expect(200);
  assert.notEqual(ship.body.code, 0);
  assert.match(ship.body.message || '', /退款申请待处理/);
  assert.equal(
    db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status,
    'escrowed',
    '冻结期发货被拒，状态不变'
  );

  // 卖家链上拒绝退款（rejectRefund）→ 恢复可发货
  assert.equal(applyEvent('RefundRejected', { orderId: eid }), 1);
  const ok = await request(app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ trackingNo: 'SF-002' })
    .expect(200);
  assertOk(ok);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'shipped');
});

test('已交付（shipped 有物流单号）后退款：不自动回补占位（货在买家侧，需线下回收）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '交付后退款不释放', capacity: 5 }));
  const order = await createDraft(p.slug);
  escrowed(order);
  const eid = order.escrowOrderId;
  assert.equal(
    skuInv(db, p.slug).committed,
    1,
    '下单占位 1 件'
  );

  // 卖家发货（物流单号=交付证据）→ 买家申请退款 → 卖家同意退款（链上 RefundApproved）
  const ship = await request(app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ trackingNo: 'SF-003' })
    .expect(200);
  assertOk(ship);
  assert.equal(applyEvent('RefundRequested', { orderId: eid }), 1);
  assert.equal(applyEvent('RefundApproved', { orderId: eid, refundWei: order.amountWei }), 1);
  assert.equal(
    db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status,
    'refunded'
  );

  // 已交付行退款 → 占位不回补（与 shipped→expired 不释放同口径；防同一批实物被再次承诺）
  assert.equal(
    skuInv(db, p.slug).committed,
    1,
    '已交付后退款不自动回补占位'
  );
  // 对照：未交付的 escrowed 退款应回补（见上方端到端用例 committed→0）
});

test('applyRefundFlags：sync 反查按链上 getOrder 标记回填/清除 refund_status', async () => {
  const { applyRefundFlags } = await import('../src/routes/orders.js');
  // 手工构造 escrowed 单（escrow_order_id 唯一），模拟 sync case Created 的本地镜像
  const id = 'rf-1';
  const eid = '0x' + 'ab'.repeat(32);
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, cny_fen, bty_usdt_rate, usdt_cny_rate, status, escrow_order_id, paid_tx_hash, created_at, updated_at)
     VALUES (?, 'p-x', '{}', '0x00', '', ?, ?, '1000000000000000000', 100, '0.1', '7.2', 'escrowed', ?, ?, ?, ?)`
  ).run(id, buyer.address.toLowerCase(), owner.address.toLowerCase(), eid, payHash(), now, now);

  // 链上 refundRequested=true → 本地 requested（首次时刻保留）
  assert.equal(applyRefundFlags(eid, { refundRequested: true, refundRejected: false }), 1);
  let row = db.prepare('SELECT refund_status, refund_requested_at FROM orders WHERE id = ?').get(id);
  assert.equal(row.refund_status, 'requested');
  const firstAt = row.refund_requested_at;
  assert.ok(firstAt > 0);
  // 幂等：重复同步不重复迁移
  assert.equal(applyRefundFlags(eid, { refundRequested: true, refundRejected: false }), 0);

  // 链上翻转（卖家拒绝）→ rejected
  assert.equal(applyRefundFlags(eid, { refundRequested: false, refundRejected: true }), 1);
  row = db.prepare('SELECT refund_status, refund_rejected_at FROM orders WHERE id = ?').get(id);
  assert.equal(row.refund_status, 'rejected');
  assert.ok(row.refund_rejected_at >= firstAt);

  // 链上两者皆无（从未申请/已重置）→ 本地残留标记清除
  assert.equal(applyRefundFlags(eid, { refundRequested: false, refundRejected: false }), 1);
  row = db.prepare('SELECT refund_status FROM orders WHERE id = ?').get(id);
  assert.equal(row.refund_status, 'none');

  // 终态订单（refunded）不触碰
  db.prepare("UPDATE orders SET status = 'refunded', refund_status = 'requested' WHERE id = ?").run(id);
  assert.equal(applyRefundFlags(eid, { refundRequested: true, refundRejected: false }), 0);
  assert.equal(
    db.prepare('SELECT refund_status FROM orders WHERE id = ?').get(id).refund_status,
    'requested',
    '终态订单的镜像由 watcher/sync 主状态推进负责，标记函数不越权'
  );
});

test('自提交付（空物流单号发货）后退款：不回补占位；可开退货单，确认收到后回补（复审 P1 shipped_at）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '自提交付退款不释放', capacity: 5 }));
  const order = await createDraft(p.slug);
  escrowed(order);
  const eid = order.escrowOrderId;
  assert.equal(skuInv(db, p.slug).committed, 1, '下单占位 1 件');

  // 空物流单号发货（自提/线下交付——前端明确支持留空）：shipped_at 须落发货标记
  const ship = await request(app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ trackingNo: '' })
    .expect(200);
  assertOk(ship);
  const shippedRow = db.prepare('SELECT status, shipped_at, tracking_no FROM orders WHERE id = ?').get(order.id);
  assert.equal(shippedRow.status, 'shipped');
  assert.equal(shippedRow.tracking_no, '');
  assert.ok(shippedRow.shipped_at > 0, '发货标记 shipped_at 已写入（自提交付的交付证据）');

  // 退款终局（链上 RefundApproved）
  assert.equal(applyEvent('RefundRequested', { orderId: eid }), 1);
  assert.equal(applyEvent('RefundApproved', { orderId: eid, refundWei: order.amountWei }), 1);
  assert.equal(
    skuInv(db, p.slug).committed,
    1,
    '自提交付后退款不自动回补占位（货已当面交付，需先线下回收）——修复前按空单号误判未交付提前释放'
  );

  // 已交付（shipped_at）可创建退货单（修复前 hasDelivered 漏判会拒：'尚无交付记录'）
  const ret = await request(app)
    .post(`/api/orders/${order.id}/return`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ address: '回收地址 A', note: '自提商品追回' })
    .expect(200);
  assertOk(ret);
  assert.equal(ret.body.data.status, 'open', '退货单创建成功（open）');

  // 店主确认收到退货 → 占位回补（released_at 幂等）
  const rec = await request(app)
    .post(`/api/orders/${order.id}/return/receive`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({})
    .expect(200);
  assertOk(rec);
  assert.equal(
    skuInv(db, p.slug).committed,
    0,
    '退货确认收到后占位回补，容量可再售'
  );
});