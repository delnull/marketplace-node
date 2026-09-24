/**
 * 收货信息（实物履约，选填）：
 *  - 下单草稿可带 shipping {name, phone, address}（不入快照/不影响资金锁定）；
 *  - 隐私可见矩阵：仅买家本人（登录）/店主/仲裁人可见，匿名与第三人恒 null；
 *  - 长度越界明确拒绝；超时清扫不影响（收货信息仅随订单展示）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();
const GOOD_SHIPPING = { name: '张三', phone: '13800138000', address: '北京市朝阳区示例路 1 号' };

let ownerToken;
let buyerToken;
let strangerToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  strangerToken = (await login(ctx, stranger)).token;
  assert.ok(ownerToken && buyerToken && strangerToken);
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

/** 买家本人下单（带收货信息），返回订单 */
async function createDraftWithShipping(slug, shipping, quantity = 1) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slug, quantity, shipping })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

test('实物商品下单携带收货信息：买家本人/店主可见，匿名与第三人不可见', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '收货信息商品', capacity: 5 }));
  const o = await createDraftWithShipping(p.slug, GOOD_SHIPPING);
  assert.deepEqual(o.shipping, GOOD_SHIPPING, '下单返回携带收货信息（本人视角）');

  // 详情按视角返回
  const asBuyer = await request(app)
    .get(`/api/orders/${o.id}`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  assert.deepEqual(asBuyer.body.data.shipping, GOOD_SHIPPING, '买家登录可见收货信息');

  const asOwner = await request(app)
    .get(`/api/orders/${o.id}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.deepEqual(asOwner.body.data.shipping, GOOD_SHIPPING, '店主可见收货信息（发货履约用）');

  const anon = await request(app).get(`/api/orders/${o.id}`).expect(200);
  assert.equal(anon.body.data.shipping, null, '匿名详情不暴露收货信息');

  const asStranger = await request(app)
    .get(`/api/orders/${o.id}`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .expect(200);
  assert.equal(asStranger.body.data.shipping, null, '第三人不可见收货信息');

  // 买家列表（登录本人）同构携带；匿名列表为 null
  const list = await request(app)
    .get(`/api/orders?address=${buyer.address}`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  assert.deepEqual(list.body.data.orders.find((x) => x.id === o.id).shipping, GOOD_SHIPPING);
  const listAnon = await request(app)
    .get(`/api/orders?address=${buyer.address}`)
    .expect(200);
  assert.equal(listAnon.body.data.orders.find((x) => x.id === o.id).shipping, null);

  // 卖家列表（/seller）亦可见
  const sellerList = await request(app)
    .get('/api/orders/seller')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.deepEqual(sellerList.body.data.orders.find((x) => x.id === o.id).shipping, GOOD_SHIPPING);
});

test('收货信息为选填：不传/全空不报错且输出空对象；越界字段明确拒绝', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '收货边界商品', capacity: 10 }));

  // 不传 shipping → 正常下单，输出空收货信息
  const noShip = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: p.slug })
    .expect(200);
  assertOk(noShip);
  assert.deepEqual(noShip.body.data.shipping, { name: '', phone: '', address: '' });

  // 全空对象 → 同不传
  const empty = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: p.slug, shipping: { name: '  ', phone: '', address: '' } })
    .expect(200);
  assertOk(empty);

  // 超长拒绝
  const bad = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: p.slug, shipping: { name: 'x'.repeat(61), phone: '1', address: 'a' } })
    .expect(200);
  assert.notEqual(bad.body.code, 0);
  assert.match(bad.body.message || '', /姓名不能超过 60/);

  const badAddr = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: p.slug, shipping: { name: '张三', phone: '1', address: 'x'.repeat(301) } })
    .expect(200);
  assert.notEqual(badAddr.body.code, 0);
  assert.match(badAddr.body.message || '', /地址不能超过 300/);
});

test('收货信息与快照/金额无关：带 shipping 下单的 orderId 与金额不受收货内容影响（不入快照）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '收货快照无关商品', capacity: 10 }));
  // 同买家同商品两次下单（不同收货信息）→ 各自独立草稿（UUID orderId），金额一致且仅由商品价格×数量决定
  const a = await createDraftWithShipping(p.slug, GOOD_SHIPPING);
  const b = await createDraftWithShipping(p.slug, { name: '李四', phone: '13900139000', address: '上海市浦东新区测试路 2 号' });
  assert.notEqual(a.escrowOrderId, b.escrowOrderId, '草稿独立（UUID）');
  assert.equal(a.amountWei, b.amountWei, '金额与收货信息无关');
  assert.equal(a.snapshotHash, b.snapshotHash, '快照哈希不含收货信息');
});

test('订单备注 note：≤200 字、不入快照、当事人可见；越界截断不报错', async () => {
  const p = await listProduct(productPayload({ kind: 'digital', title: '备注商品' }));
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: p.slug, note: '  请发顺丰 / 发票抬头：测试公司  '.repeat(3).slice(0, 260) })
    .expect(200);
  assertOk(res);
  const o = res.body.data;
  assert.ok(o.note.length <= 200, '备注截断到 200 字');
  assert.ok(o.note.includes('顺丰'), '内容保留');

  // 快照哈希与"无备注下单"一致（不入快照）
  const plain = await createDraftWithShipping(p.slug, { name: '', phone: '', address: '' }); // digital 无收货信息
  const plain2 = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: p.slug })
    .expect(200);
  assertOk(plain2);
  assert.equal(o.snapshotHash, plain2.body.data.snapshotHash, '备注不入快照哈希');

  // 可见矩阵：买家本人/店主可见；匿名与第三人 null
  const asBuyer = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(asBuyer.body.data.note, o.note);
  const asOwner = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.equal(asOwner.body.data.note, o.note, '店主可见买家备注（履约沟通）');
  const anon = await request(app).get(`/api/orders/${o.id}`).expect(200);
  assert.equal(anon.body.data.note, null, '匿名不暴露备注');
  const asStranger = await request(app)
    .get(`/api/orders/${o.id}`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .expect(200);
  assert.equal(asStranger.body.data.note, null, '第三人不可见备注');
  void plain;
});

test('发货前修改收货信息：escrowed 实物单买家可改；发货后/非实物/第三人拒绝', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '改地址商品', capacity: 5 }));
  const o = await createDraftWithShipping(p.slug, GOOD_SHIPPING);
  // 模拟链上托管（escrowed + 支付凭证）
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run('0x' + 'a'.repeat(64), Date.now(), o.id);

  const NEW_SHIP = { name: '王五', phone: '13700137000', address: '广州市天河区新地址 99 号' };
  // 第三人不可改
  const strangerPatch = await request(app)
    .patch(`/api/orders/${o.id}/shipping`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .send(NEW_SHIP)
    .expect(403);
  assert.equal(strangerPatch.body.code, 403);

  // 买家修改成功
  const okRes = await request(app)
    .patch(`/api/orders/${o.id}/shipping`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send(NEW_SHIP)
    .expect(200);
  assertOk(okRes);
  assert.deepEqual(okRes.body.data.shipping, NEW_SHIP, '返回更新后的收货信息');
  assert.equal(okRes.body.data.shippingEdited, true, '修改标记置位');

  // 每单仅可修改一次：第二次修改被拒（防反复改址）
  const second = await request(app)
    .patch(`/api/orders/${o.id}/shipping`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ name: '赵六', phone: '13600136000', address: '深圳市南山区又一次改地址' })
    .expect(200);
  assert.notEqual(second.body.code, 0, '第二次修改被拒');
  assert.match(second.body.message || '', /已修改过一次/);
  const afterSecond = await request(app)
    .get(`/api/orders/${o.id}`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  assert.deepEqual(afterSecond.body.data.shipping, NEW_SHIP, '第二次修改未生效');

  // 发货后不可改（status shipped）
  db.prepare("UPDATE orders SET status = 'shipped', tracking_no = 'SF1', updated_at = ? WHERE id = ?").run(Date.now(), o.id);
  const afterShip = await request(app)
    .patch(`/api/orders/${o.id}/shipping`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send(NEW_SHIP)
    .expect(200);
  assert.notEqual(afterShip.body.code, 0, '发货后不可修改');

  // 数字商品无收货信息不可改
  const dg = await listProduct(productPayload({ kind: 'digital', title: '改址数字商品' }));
  const dgOrder = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: dg.slug })
    .expect(200);
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run('0x' + 'b'.repeat(64), Date.now(), dgOrder.body.data.id);
  const dgPatch = await request(app)
    .patch(`/api/orders/${dgOrder.body.data.id}/shipping`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send(NEW_SHIP)
    .expect(200);
  assert.notEqual(dgPatch.body.code, 0, '非实物单不可改收货信息');
});
