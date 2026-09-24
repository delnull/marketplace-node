/**
 * 卖家收款流水（Stage 2）：已入账订单（confirmed 买家确认 / settled 仲裁判付 /
 * expired 超时释放）的汇总与列表；refunded 等未入账状态不计入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
// 同买家同商品可多次购买（v2）——多买家仅用于多单并发
const buyers = [buyer, Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
// 模拟链上规范哈希（escrowed 必有支付凭证，发货防呆要求）
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

/** 上架商品（¥66.00）→ 店主代买家下单 → 模拟 watcher/paid 回写 escrowed（落支付凭证），返回 { slug, order } */
async function settledEscrow(slug, who = buyer.address) {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ productSlug: slug, buyer: who })
    .expect(200);
  assertOk(res);
  const o = res.body.data;
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), o.id);
  return o;
}

test('收款流水鉴权：未登录 401，普通买家 403', async () => {
  await request(app).get('/api/orders/seller/ledger').expect(401);
  const buyerLogin = await login(ctx, buyer);
  await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(403);
});

let productSlug;
const createdWei = [];

test('买家确认收货后计入流水（confirmed）', async () => {
  const ownerLogin = await login(ctx, owner);
  const listed = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send(productPayload({ title: '流水测试商品A', priceCnyFen: 6600 }))
    .expect(200);
  assertOk(listed);
  productSlug = listed.body.data.slug;

  const o = await settledEscrow(productSlug, buyers[0].address);
  createdWei.push(o.amountWei);

  // 卖家发货（数字：手动交付内容）
  const ship = await request(app)
    .post(`/api/orders/${o.id}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ deliveryCode: 'LEDGER-CODE-1' })
    .expect(200);
  assertOk(ship);

  // 买家确认收货（模拟 watcher ReceiptConfirmed：escrowed/shipped → confirmed）
  db.prepare("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE id = ?").run(Date.now(), o.id);

  const ledger = await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assertOk(ledger);
  const { summary, orders, total } = ledger.body.data;
  assert.equal(total, 1);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, o.id);
  assert.equal(orders[0].status, 'confirmed');
  assert.equal(summary.count, 1);
  assert.equal(summary.cnyFen, 6600);
  assert.equal(summary.amountWei, o.amountWei, '累计金额应等于本单应付 wei（字符串精确）');
  assert.deepEqual(Object.keys(summary.byStatus), ['confirmed']);
  assert.equal(summary.byStatus.confirmed.count, 1);
  assert.equal(summary.byStatus.confirmed.amountWei, o.amountWei);
});

test('超时释放计入流水（expired），退款订单不计入', async () => {
  const ownerLogin = await login(ctx, owner);
  // 第二单：escrowed → expired（模拟 watcher OrderExpiredReleased）
  const o2 = await settledEscrow(productSlug, buyers[1].address);
  db.prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ?").run(Date.now(), o2.id);

  // 第三单：escrowed → ship → 买家发起争议 → 仲裁退款（不计入）
  const o3 = await settledEscrow(productSlug, buyers[2].address);
  await request(app)
    .post(`/api/orders/${o3.id}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ deliveryCode: 'REFUND-CODE' })
    .expect(200);
  db.prepare("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?").run(Date.now(), o3.id);

  const ledger = await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assertOk(ledger);
  const { summary } = ledger.body.data;
  assert.equal(summary.count, 2, 'confirmed + expired 两单入账，refunded 不计入');
  assert.equal(summary.cnyFen, 6600 * 2);
  assert.equal(summary.amountWei, (BigInt(createdWei[0]) + BigInt(o2.amountWei)).toString());
  assert.equal(summary.byStatus.expired.count, 1);
  assert.equal(summary.byStatus.expired.amountWei, o2.amountWei);
});

test('仲裁判卖家计入流水（settled），分页返回按入账时间倒序', async () => {
  const ownerLogin = await login(ctx, owner);
  // 第四单：escrowed → ship → disputed → 仲裁判卖家（模拟 watcher Arbitrated）
  const o4 = await settledEscrow(productSlug, buyers[3].address);
  await request(app)
    .post(`/api/orders/${o4.id}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ deliveryCode: 'ARBITRATE-CODE' })
    .expect(200);
  db.prepare("UPDATE orders SET status = 'disputed', updated_at = ? WHERE id = ?").run(Date.now(), o4.id);
  db.prepare("UPDATE orders SET status = 'settled', updated_at = ? WHERE id = ?").run(Date.now(), o4.id);

  const ledger = await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assertOk(ledger);
  const { summary, orders } = ledger.body.data;
  assert.equal(summary.count, 3);
  assert.equal(summary.byStatus.settled.count, 1);
  assert.ok(Object.keys(summary.byStatus).includes('confirmed'));
  assert.ok(Object.keys(summary.byStatus).includes('expired'));
  // 倒序：settled 最后入账应排最前（updated_at 最新）
  assert.equal(orders[0].id, o4.id);

  // 分页：pageSize=1 只回一页且 summary 不受分页影响
  const paged = await request(app)
    .get('/api/orders/seller/ledger?page=1&pageSize=1')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assertOk(paged);
  assert.equal(paged.body.data.orders.length, 1);
  assert.equal(paged.body.data.total, 3);
  assert.equal(paged.body.data.summary.count, 3, 'summary 为全量统计，与分页无关');
});

test('订单级 feeBps 快照折算净额：feeWei/amountWeiNet 与毛额口径分离', async () => {
  const ownerLogin = await login(ctx, owner);
  // 第五单：escrowed → confirmed，并补录订单级费率快照 fee_bps=100（1%）
  const o5 = await settledEscrow(productSlug, buyers[0].address);
  db.prepare("UPDATE orders SET fee_bps = 100 WHERE id = ?").run(o5.id);
  db.prepare("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE id = ?").run(Date.now(), o5.id);

  const amt = BigInt(o5.amountWei);
  const fee = (amt * 100n) / 10000n; // 1%
  const ledger = await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assertOk(ledger);
  const { summary, orders } = ledger.body.data;
  assert.equal(orders[0].id, o5.id);
  assert.equal(orders[0].feeBps, 100);
  assert.equal(orders[0].feeWei, fee.toString(), '行级平台费 = 金额 × feeBps 快照');
  assert.equal(orders[0].amountWeiNet, (amt - fee).toString(), '行级净额 = 金额 − 平台费');
  // summary：毛额/净额/费用三项齐全且互相自洽（其余已入账单 fee_bps=0，不产生费用）
  const gross = BigInt(summary.amountWei);
  assert.ok(gross > amt, '毛额包含历史全部已入账单（本单叠加）');
  assert.equal(summary.feeWei, fee.toString());
  assert.equal(summary.amountWeiNet, (gross - BigInt(summary.feeWei)).toString(), '净额 = 毛额 − 费用（自洽）');
  assert.equal(summary.byStatus.confirmed.feeWei, fee.toString());
});
