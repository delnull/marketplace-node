/**
 * 卖家收款流水：已入账订单（confirmed 买家确认 / settled 仲裁判付 / expired 超时释放）的
 * 汇总与列表；refunded 等未入账状态不计入。
 *
 * 零费模型：净额 = 毛额 − 已退买家（没有平台费/节点抽成两条腿）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef, insertOrder } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
// 同买家同商品可多次购买（v2）——多买家仅用于多单并发
const buyers = [buyer, Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
// 模拟链上规范哈希（escrowed 必有支付凭证，发货防呆要求）
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

/**
 * 上架商品（66 USDT）→ 店主代买家下单 → 模拟 watcher/paid 回写 escrowed（落支付凭证），
 * 返回订单草稿 DTO。
 */
async function settledEscrow(slug, who = buyer.address) {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, buyer: who })
    .expect(200);
  assertOk(res);
  const o = res.body.data;
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), o.id);
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', payHash(), o.id);
  return o;
}

test('收款流水鉴权：未登录 401，普通买家 403', async () => {
  await request(app).get('/api/orders/seller/ledger').expect(401);
  const buyerLogin = await login(ctx, buyer);
  await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${buyerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .expect(403);
});

let productSlug;
const createdWei = [];

test('买家确认收货后计入流水（confirmed）', async () => {
  const ownerLogin = await login(ctx, owner);
  const listed = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title: '流水测试商品A', priceUsdtMicro: 66_000_000 }))
    .expect(200);
  assertOk(listed);
  productSlug = listed.body.data.slug;

  const o = await settledEscrow(productSlug, buyers[0].address);
  createdWei.push(o.amountWei);

  // 卖家发货（数字：手动交付内容）
  const ship = await request(app)
    .post(`/api/orders/${o.id}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({ deliveryCode: 'LEDGER-CODE-1' })
    .expect(200);
  assertOk(ship);

  // 买家确认收货（模拟 watcher ReceiptConfirmed：escrowed/shipped → confirmed）
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", new Date(new Date()), o.id);

  const ledger = await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(ledger);
  const { summary, orders, total } = ledger.body.data;
  assert.equal(total, 1);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, o.id);
  assert.equal(orders[0].status, 'confirmed');
  assert.equal(orders[0].amountWeiNet, o.amountWei, '没有退款 ⇒ 行级净额 = 毛额');
  assert.equal(summary.count, 1);
  /*
    微 USDT 汇总现在是**字符串**（与 wei 侧同款：节点用 BigInt 累加后 toString()）——
    Number 累加在 9.007e15 以上 ulp 变成 2…16，而这是要拿去对账的整数金额（源码评审 2026-10，P2）。
    断言用 `String(...)` 比较，这样"哪天有人又改回 Number"时这里只会在超出安全整数时红——
    真正钉住的是**逐值相等**：66000000 微 = 66.00 USDT。
  */
  assert.equal(String(summary.usdtMicro), '66000000');
  assert.equal(summary.amountWei, o.amountWei, '累计金额应等于本单应付 wei（字符串精确）');
  assert.deepEqual(Object.keys(summary.byStatus), ['confirmed']);
  assert.equal(summary.byStatus.confirmed.count, 1);
  assert.equal(String(summary.byStatus.confirmed.usdtMicro), '66000000');
  assert.equal(summary.byStatus.confirmed.amountWei, o.amountWei);
  /*
    ⚠️ **分桶的金额腿必须是"合计"而不是"拼接"**（2026-10-16 修一个静默的形状缺陷）：
    分桶初值此前被写成字符串 `'0'`，而累加函数 `addLeg` 的契约是 BigInt 累加器 ⇒
    `'0' + BigInt(v)` 走**字符串拼接**：接口照常 200，而 `amountWeiNet` 返回 N 个十进制串
    首尾相接（实测长度 1359）。判据取"**形状 + 逐值相等**"，两条都要：
      · 形状：只可能是十进制数字串（拼接串里会混进 `'0'` 前缀与多段数字，长度也会翻倍）；
      · 逐值：与顶层总计相等（本用例只有一单，所以两者必须**逐字相同**）。
    只断言"非空/能转 BigInt"是抓不住的——`BigInt('0123…')` 照样转得出来。
  */
  for (const leg of ['amountWei', 'refundedWei', 'amountWeiNet']) {
    const v = summary.byStatus.confirmed[leg];
    assert.equal(typeof v, 'string', `byStatus.confirmed.${leg} 必须是字符串（DECIMAL 的对外口径）`);
    assert.match(v, /^(0|[1-9]\d*)$/, `byStatus.confirmed.${leg} 必须是十进制数字串（拼接串会带前导 0 或多段），实际：${v}`);
  }
  assert.equal(summary.byStatus.confirmed.amountWei, summary.amountWei, '同一状态下毛额分桶必须与顶层总计逐字相等');
  assert.equal(summary.byStatus.confirmed.amountWeiNet, summary.amountWeiNet, '净额同理（拼接串在这里必然不等）');
});

test('超时释放计入流水（expired），退款订单不计入', async () => {
  const ownerLogin = await login(ctx, owner);
  // 第二单：escrowed → expired（模拟 watcher OrderExpiredReleased）
  const o2 = await settledEscrow(productSlug, buyers[1].address);
  await db.run("UPDATE orders SET status = 'expired', updated_at = ? WHERE order_no = ?", new Date(new Date()), o2.id);

  // 第三单：escrowed → ship → 买家发起争议 → 仲裁退款（不计入）
  const o3 = await settledEscrow(productSlug, buyers[2].address);
  await request(app)
    .post(`/api/orders/${o3.id}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({ deliveryCode: 'REFUND-CODE' })
    .expect(200);
  await db.run("UPDATE orders SET status = 'refunded', updated_at = ? WHERE order_no = ?", new Date(new Date()), o3.id);

  const ledger = await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(ledger);
  const { summary } = ledger.body.data;
  assert.equal(summary.count, 2, 'confirmed + expired 两单入账，refunded 不计入');
  assert.equal(String(summary.usdtMicro), String(66_000_000 * 2), '微 USDT 汇总同样是字符串（BigInt 累加）');
  assert.equal(summary.amountWei, (BigInt(createdWei[0]) + BigInt(o2.amountWei)).toString());
  assert.equal(summary.amountWeiNet, summary.amountWei, '这批单都没有退款 ⇒ 净额 = 毛额');
  assert.equal(summary.byStatus.expired.count, 1);
  assert.equal(summary.byStatus.expired.amountWei, o2.amountWei);
});

test('仲裁判卖家计入流水（settled），分页返回按入账时间倒序', async () => {
  const ownerLogin = await login(ctx, owner);
  // 第四单：escrowed → ship → disputed → 仲裁判卖家（模拟 watcher Arbitrated）
  const o4 = await settledEscrow(productSlug, buyers[3].address);
  await request(app)
    .post(`/api/orders/${o4.id}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({ deliveryCode: 'ARBITRATE-CODE' })
    .expect(200);
  await db.run("UPDATE orders SET status = 'disputed', updated_at = ? WHERE order_no = ?", new Date(new Date()), o4.id);
  await db.run("UPDATE orders SET status = 'settled', updated_at = ? WHERE order_no = ?", new Date(new Date()), o4.id);

  const ledger = await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
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
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(paged);
  assert.equal(paged.body.data.orders.length, 1);
  assert.equal(paged.body.data.total, 3);
  assert.equal(paged.body.data.summary.count, 3, 'summary 为全量统计，与分页无关');
});

test('混合资产：ERC20 单不进 wei 汇总，mixedAssets=true 让调用方知道 wei 只是原生口径', async () => {
  const ownerLogin = await login(ctx, owner);
  const ledger = () =>
    request(app)
      .get('/api/orders/seller/ledger')
      .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
      .expect(200);

  const before = (await ledger()).body.data.summary;
  const o = await insertOrder(db, {
    buyer: buyers[0].address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    status: 'confirmed',
    amountWei: '5000000',
    usdtMicro: '5000000',
  });
  await db.run(
    "UPDATE orders SET payment_token = ?, payment_symbol = ?, payment_decimals = ? WHERE order_no = ?",
    '0x00000000000000000000000000000000000000aa',
    'MOCK',
    6,
    o.orderNo
  );
  const after = (await ledger()).body.data.summary;
  assert.equal(after.mixedAssets, true);
  assert.equal(after.amountWei, before.amountWei, 'wei 汇总不得把 6 位 token 单位加进 18 位原生口径');
  assert.equal(BigInt(after.usdtMicro) - BigInt(before.usdtMicro), 5000000n, '跨资产总额只走微 USDT');
});

test('部分退款：行级与汇总净额 = 毛额 − 已退买家（退款列单独给出）', async () => {
  const ownerLogin = await login(ctx, owner);
  const o5 = await settledEscrow(productSlug, buyers[0].address);
  const amt = BigInt(o5.amountWei);
  const refunded = amt / 4n; // 25% 拆分退款
  await db.run("UPDATE orders SET status = 'settled', updated_at = ? WHERE order_no = ?", new Date(Date.now() + 5), o5.id);
  await db.run('UPDATE order_chain SET refunded_amount_wei = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', refunded.toString(), o5.id);

  const ledger = await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(ledger);
  const { summary, orders } = ledger.body.data;
  const mine = orders.find((o) => o.id === o5.id);
  assert.equal(mine.refundedWei, refunded.toString(), '行级已退金额原样给出');
  assert.equal(mine.amountWeiNet, (amt - refunded).toString(), '行级净额 = 毛额 − 已退');

  const gross = BigInt(summary.amountWei);
  assert.ok(gross > amt, '毛额包含历史全部已入账单（本单叠加）');
  assert.equal(
    summary.amountWeiNet,
    (gross - BigInt(summary.refundedWei)).toString(),
    '净额 = 毛额 − 已退买家（零费模型只有这两条腿）'
  );
});
