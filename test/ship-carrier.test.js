/**
 * 承运方名称（`carrier`）——订单 DTO / 三个写入入口 / 退货单 / CSV 导出。
 *
 * 为什么要有这个字段：只有运单号时，"拼一个能查件的链接"只能靠单号前缀猜，
 * 而中通/圆通/申通/韵达这类**纯数字单号完全猜不出**（前端 `utils/shipTrack` 的判据是
 * "数据里填的名称优先、单号自身号段其次"）。所以节点侧必须如实存下店主/买家填的名称。
 *
 * 本文件钉住四件事：
 *  1. **三态**：没填 = `null`（不是空串、更不是"其他"）；空串/纯空白一律按未填处理；
 *  2. **一处归一**（src/shipping.js）：单笔发货 / 批量发货 / 退货回填三个入口共用同一实现，
 *     长度上限一致（超长截断，不是各写一遍）；
 *  3. **可见矩阵与 trackingNo 同源**：匿名与第三人拿不到（它是"能被用来反查收件人"的半条信息）；
 *  4. **别留半条**：退货单（买家寄回）与 CSV 导出也要有同一个字段。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();

const { normalizeCarrier, CARRIER_MAX_LEN } = await import('../src/shipping.js');

let ownerToken;
let buyerToken;
let strangerToken;
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  strangerToken = (await login(ctx, stranger)).token;
});

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

/** 直接置为"已托管且有支付凭证"（本文件不测支付链路，与 returns.test.js 同款） */
function escrowed(order) {
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?").run(payHash(), Date.now(), order.id);
}

const ship = (orderId, body, token = ownerToken) =>
  request(app).post(`/api/orders/${orderId}/ship`).set('Authorization', `Bearer ${token}`).send(body);
const rowOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

test('归一（唯一实现）：未填/空白 → null；去控制字符与首尾空白；超长截断', () => {
  assert.equal(normalizeCarrier(undefined), null, '缺省 = 未填');
  assert.equal(normalizeCarrier(null), null);
  assert.equal(normalizeCarrier(''), null, '空串 = 未填（不是 ""，更不是"其他"）');
  assert.equal(normalizeCarrier('   \t  '), null, '纯空白 = 未填');
  assert.equal(normalizeCarrier('  顺丰速运  '), '顺丰速运', '首尾空白去掉');
  assert.equal(normalizeCarrier('顺丰\u0000速运'), '顺丰 速运', '控制字符换成空格（不可见差异不许进 JSON）');
  assert.equal(normalizeCarrier(123), '123', '非字符串按字面处理，不抛错');
  const long = '承'.repeat(CARRIER_MAX_LEN + 20);
  assert.equal(normalizeCarrier(long).length, CARRIER_MAX_LEN, `超长截断到 ${CARRIER_MAX_LEN}（与 tracking_no 同款：截断而不是拒绝）`);
});

test('单笔发货：carrier 随运单号一起落库并回显；未填时 DTO 是 null 而不是空串', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '承运方-单笔', capacity: 9 }));
  const o1 = await createDraft(p.slug);
  escrowed(o1);
  const res = await ship(o1.id, { trackingNo: 'SF1234567890', carrier: ' 顺丰速运 ' });
  assertOk(res);
  assert.equal(res.body.data.carrier, '顺丰速运', '返回体里给归一后的名称（已 trim）');
  assert.equal(rowOf(o1.id).carrier, '顺丰速运');

  // 详情按**买家本人**视角读（匿名视角拿不到 carrier，见下一个用例的可见矩阵）
  const detail = await request(app).get(`/api/orders/${o1.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(detail.body.data.carrier, '顺丰速运');

  // 未填：落 NULL、DTO null（三态：不是空串）
  const o2 = await createDraft(p.slug);
  escrowed(o2);
  assertOk(await ship(o2.id, { trackingNo: 'ZTO99887766' }));
  assert.equal(rowOf(o2.id).carrier, null);
  const d2 = await request(app).get(`/api/orders/${o2.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(d2.body.data.carrier, null);
  assert.equal((await ship(o1.id, { carrier: 'x' })).body.code !== 0, true, '同一单不可重复发货（状态守卫仍在）');

  // 空串/纯空白：按未填处理（**不是**存一个空串）
  const o3 = await createDraft(p.slug);
  escrowed(o3);
  assertOk(await ship(o3.id, { trackingNo: 'YT11223344', carrier: '   ' }));
  assert.equal(rowOf(o3.id).carrier, null);
  const d3 = await request(app).get(`/api/orders/${o3.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(d3.body.data.carrier, null);

  // 超长：截断到上限（不是拒绝发货）
  const o4 = await createDraft(p.slug);
  escrowed(o4);
  const longName = '承'.repeat(CARRIER_MAX_LEN + 15);
  const r4 = await ship(o4.id, { trackingNo: 'JD55667788', carrier: longName });
  assertOk(r4);
  assert.equal(r4.body.data.carrier.length, CARRIER_MAX_LEN);
  assert.equal(rowOf(o4.id).carrier.length, CARRIER_MAX_LEN);
});

test('可见矩阵与 trackingNo 同源：匿名/第三人拿不到 carrier（它是能反查收件人的半条信息）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '承运方-可见矩阵', capacity: 3 }));
  const o = await createDraft(p.slug);
  escrowed(o);
  assertOk(await ship(o.id, { trackingNo: 'SF000011112222', carrier: '顺丰速运' }));

  const anon = await request(app).get(`/api/orders/${o.id}`).expect(200);
  assert.equal(anon.body.data.carrier, null, '匿名详情不暴露承运方');
  assert.equal(anon.body.data.trackingNo, null, '（同一矩阵：运单号也不暴露）');
  const asStranger = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${strangerToken}`).expect(200);
  assert.equal(asStranger.body.data.carrier, null, '第三人不暴露');
  const asBuyer = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(asBuyer.body.data.carrier, '顺丰速运', '买家本人可见（要拿它去查件）');
  const asOwner = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.equal(asOwner.body.data.carrier, '顺丰速运', '店主可见');
  const list = await request(app).get(`/api/orders?address=${buyer.address}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(list.body.data.orders.find((x) => x.id === o.id).carrier, '顺丰速运', '列表同样带出');
  const listAnon = await request(app).get(`/api/orders?address=${buyer.address}`).expect(200);
  assert.equal(listAnon.body.data.orders.find((x) => x.id === o.id).carrier, null, '匿名列表为 null');
});

test('批量发货：与单笔发货同一归一，整批写同一个承运方（留空同样落 NULL）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '承运方-批量', capacity: 9 }));
  const a = await createDraft(p.slug);
  const b = await createDraft(p.slug);
  escrowed(a);
  escrowed(b);
  const res = await request(app)
    .post('/api/orders/seller/batch-ship')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ ids: [a.id, b.id], trackingNo: 'ZTO123123123', carrier: ' 中通快递 ' })
    .expect(200);
  assertOk(res);
  assert.deepEqual(res.body.data.shipped.sort(), [a.id, b.id].sort());
  assert.equal(rowOf(a.id).carrier, '中通快递');
  assert.equal(rowOf(b.id).carrier, '中通快递', '整批同一承运方');
  assert.equal((await request(app).get(`/api/orders/${a.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200)).body.data.carrier, '中通快递');
});

test('退货单那条路：买家回填退回运单号时可带承运方，形状与发货侧一致（别留半条）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '承运方-退货', capacity: 5 }));
  const o = await createDraft(p.slug);
  escrowed(o);
  assertOk(await ship(o.id, { trackingNo: 'SF-RET-OUT-1', carrier: '顺丰速运' }));

  // 退款申请 → 店主建退货单（退货运单由买家回填）
  const { applyEvent } = await import('../src/escrowWatcher.js');
  assert.equal(applyEvent('RefundRequested', { orderId: o.escrowOrderId }), 1);
  const cr = await request(app)
    .post(`/api/orders/${o.id}/return`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ address: '广东省深圳市示例仓 8 号', note: '原包装寄回' })
    .expect(200);
  assertOk(cr);
  assert.equal(cr.body.data.carrier, null, '还没寄回时是 null（不是空串）');

  const tk = await request(app)
    .post(`/api/orders/${o.id}/return/tracking`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ trackingNo: 'ZTO-RET-BACK-9', carrier: ' 中通快递 ' })
    .expect(200);
  assertOk(tk);
  assert.equal(tk.body.data.carrier, '中通快递', '归一后回显');
  assert.equal(tk.body.data.trackingNo, 'ZTO-RET-BACK-9');
  assert.equal(db.prepare('SELECT carrier FROM order_returns WHERE order_id = ?').get(o.id).carrier, '中通快递');

  // 退货单随订单详情下发（可见矩阵同收货信息/运单号）
  const detail = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(detail.body.data.return.carrier, '中通快递');
  const anon = await request(app).get(`/api/orders/${o.id}`).expect(200);
  assert.equal(anon.body.data.return, null, '退货单整体对匿名不可见（承运方随之）');

  // 另一单：只填单号不填承运方 → null（不能编一个"其他"出来）
  const o2 = await createDraft(p.slug);
  escrowed(o2);
  assertOk(await ship(o2.id, { trackingNo: 'SF-RET-OUT-2', carrier: '顺丰速运' }));
  assert.equal(applyEvent('RefundRequested', { orderId: o2.escrowOrderId }), 1);
  assertOk(await request(app).post(`/api/orders/${o2.id}/return`).set('Authorization', `Bearer ${ownerToken}`).send({ address: '示例仓' }).expect(200));
  const tk2 = await request(app)
    .post(`/api/orders/${o2.id}/return/tracking`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ trackingNo: 'YT-RET-BACK-8' })
    .expect(200);
  assertOk(tk2);
  assert.equal(tk2.body.data.carrier, null);
});

test('CSV 导出带上同一列（店主对账时不必回页面抄承运方）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '承运方-CSV', capacity: 3 }));
  const o = await createDraft(p.slug);
  escrowed(o);
  assertOk(await ship(o.id, { trackingNo: 'EMS123456789CN', carrier: '中国邮政' }));
  const res = await request(app)
    .get('/api/shop/export/orders.csv')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const text = String(res.text || '');
  const header = text.split('\n')[0];
  assert.match(header, /(^|,)carrier(,|$)/, '表头含 carrier');
  const line = text.split('\n').find((l) => l.startsWith(o.id));
  assert.ok(line, '能找到本单那一行');
  assert.match(line, /EMS123456789CN/, '运单号在同一行');
  assert.match(line, /中国邮政/, '承运方与运单号同列相邻（对账时一眼能看清是哪家）');
});
