/**
 * 卖家收款流水（Stage 2）：已入账订单（confirmed 买家确认 / settled 仲裁判付 /
 * expired 超时释放）的汇总与列表；refunded 等未入账状态不计入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

/** 本文件夹具的抽成快照常量：零地址 = 确证这一单不抽成（与 fees.js 的三态判据同款） */
const COMMISSION_NONE = '0x0000000000000000000000000000000000000000';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
// 同买家同商品可多次购买（v2）——多买家仅用于多单并发
const buyers = [buyer, Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
// 模拟链上规范哈希（escrowed 必有支付凭证，发货防呆要求）
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

/**
 * 上架商品（66 USDT）→ 店主代买家下单 → 模拟 watcher/paid 回写 escrowed（落支付凭证），返回 { slug, order }。
 *
 * **同时落费率快照的两列**（`fee_bps` + `fee_collector_at_create`）：真实的 /paid、watcher、/sync
 * 三处都是成对补录的，而账本的平台费是**三态**的——`fee_collector_at_create` 为空 = 费率未知
 * ⇒ 费与净额下发 null（见 node/src/fees.js 的 feeSnapshotReadOf）。这里模拟"链上费率 0、
 * 创建时未配收取方"（零地址 = 这单确证不扣费）。
 */
const ZERO_COLLECTOR = '0x0000000000000000000000000000000000000000';
async function settledEscrow(slug, who = buyer.address) {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, buyer: who })
    .expect(200);
  assertOk(res);
  const o = res.body.data;
  await db.run("UPDATE orders SET status = 'escrowed', fee_bps = 0, fee_collector_at_create = ?, commission_to = ?, updated_at = ? WHERE order_no = ?", ZERO_COLLECTOR, COMMISSION_NONE, new Date(), o.id);
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
  assert.equal(summary.count, 1);
  /*
    微 USDT 汇总现在是**字符串**（与 wei 侧同款：节点用 BigInt 累加后 toString()）——
    Number 累加在 9.007e15 以上 ulp 变成 2…16，而这是要拿去对账的整数金额（源码评审 2026-10，P2）。
    断言用 `String(...)` 比较，这样"哪天有人又改回 Number"时这里只会在超出安全整数时红——
    真正钉住的是**逐值相等**：132000000 微 = 132.00 USDT。
  */
  assert.equal(String(summary.usdtMicro), '66000000');
  assert.equal(summary.amountWei, o.amountWei, '累计金额应等于本单应付 wei（字符串精确）');
  assert.deepEqual(Object.keys(summary.byStatus), ['confirmed']);
  assert.equal(summary.byStatus.confirmed.count, 1);
  assert.equal(String(summary.byStatus.confirmed.usdtMicro), '66000000');
  assert.equal(summary.byStatus.confirmed.amountWei, o.amountWei);
  /*
    ⚠️ **分桶的四条金额腿必须是"合计"而不是"拼接"**（2026-10-16 修一个静默的形状缺陷）：
    分桶初值此前被写成字符串 `'0'`，而累加函数 `addLeg` 的契约是 BigInt 累加器 ⇒
    `'0' + BigInt(v)` 走**字符串拼接**：接口照常 200，而 `amountWeiNet` 返回 N 个十进制串
    首尾相接（实测长度 1359）。判据取"**形状 + 逐值相等**"，两条都要：
      · 形状：只可能是十进制数字串（拼接串里会混进 `'0'` 前缀与多段数字，长度也会翻倍）；
      · 逐值：与顶层总计相等（本用例只有一单，所以两者必须**逐字相同**）。
    只断言"非空/能转 BigInt"是抓不住的——`BigInt('0123…')` 照样转得出来。
  */
  for (const leg of ['amountWei', 'refundedWei', 'feeWei', 'commissionWei', 'amountWeiNet']) {
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

test('订单级 feeBps 快照折算净额：feeWei/amountWeiNet 与毛额口径分离', async () => {
  const ownerLogin = await login(ctx, owner);
  /*
    第五单：escrowed → confirmed，并补录订单级费率快照。
    **两列必须成对写**（`fee_bps` + `fee_collector_at_create`）：账本的平台费是**三态**的，
    `fee_collector_at_create` 为空 = 两列都没补录过 = 费率未知 ⇒ 费与净额下发 null
    （见 node/src/fees.js 的 feeSnapshotReadOf）。真实系统里 /paid、watcher、/sync 也都是成对写。
    这里用非零收取方 ⇒ 这单确证扣 1%。
  */
  const FEE_COLLECTOR = '0x1111111111111111111111111111111111111111';
  const o5 = await settledEscrow(productSlug, buyers[0].address);
  await db.run('UPDATE orders SET fee_bps = 100, fee_collector_at_create = ?, commission_to = ? WHERE order_no = ?', FEE_COLLECTOR, COMMISSION_NONE, o5.id);
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", new Date(new Date()), o5.id);

  const amt = BigInt(o5.amountWei);
  const fee = (amt * 100n) / 10000n; // 1%
  const ledger = await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(ledger);
  const { summary, orders } = ledger.body.data;
  assert.equal(orders[0].id, o5.id);
  assert.equal(orders[0].feeBps, 100);
  assert.equal(orders[0].feeWei, fee.toString(), '行级平台费 = 金额 × feeBps 快照');
  assert.equal(orders[0].commissionBps, 0, '成交条款快照是零地址 ⇒ 确证本单不抽成（不是"读不到"）');
  assert.equal(orders[0].commissionWei, '0');
  assert.equal(orders[0].amountWeiNet, (amt - fee).toString(), '行级净额 = 金额 − 平台费 − 抽成(0)');
  /*
    summary 的**自洽式**（多店改造后是三条腿）：
      净额 = 毛额 − 已退买家 − 平台费 − 节点抽成
    此前这里断言的是两腿版本（净额 = 毛额 − 费用）。改成"逐行求和再相减"而不是写死一个数，
    是为了让这条断言在**任何**抽成组合下都成立——包括下面那条真正抽成的用例
    （写死数字的话，一旦有抽成，这条断言会因为"少减一条腿"而红，而它红了恰恰说明代码对了）。
  */
  const gross = BigInt(summary.amountWei);
  assert.ok(gross > amt, '毛额包含历史全部已入账单（本单叠加）');
  const perRowFee = BigInt(summary.feeWei);
  const perRowCommission = BigInt(summary.commissionWei);
  assert.equal(perRowFee.toString(), fee.toString());
  assert.equal(perRowCommission, 0n, '本组数据里没有抽成的店');
  assert.equal(
    summary.amountWeiNet,
    (gross - BigInt(summary.refundedWei) - perRowFee - perRowCommission).toString(),
    '净额 = 毛额 − 已退买家 − 平台费 − 节点抽成（与链上 _settle 同式）'
  );
});

test('抽成腿：抽成 > 0 的行，净额必须减掉抽成（面板报的数才等于链上打给店主的钱）', async () => {
  const ownerLogin = await login(ctx, owner);
  /*
    这一条是**多店改造的核心账目判据**：抽成 > 0 的店里，`净额 = 毛额 − 平台费` 是**错的**，
    而错的方向是"报多了"——店主拿它对自己的钱包，永远差着节点抽走的那一截。
    补录的四列（费两列 + 抽成两列）由 `writeFeeSnapshot` 一条 UPDATE 成对写，这里照做。
  */
  const FEE_COLLECTOR = '0x2222222222222222222222222222222222222222';
  const COMMISSION_PAYEE = '0x3333333333333333333333333333333333333333';
  const o7 = await settledEscrow(productSlug, buyers[1].address);
  await db.run('UPDATE orders SET fee_bps = 100, fee_collector_at_create = ?, commission_bps = 800, commission_to = ? WHERE order_no = ?', FEE_COLLECTOR, COMMISSION_PAYEE, o7.id);
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", new Date(Date.now() + 2), o7.id);

  const amt = BigInt(o7.amountWei);
  const fee = (amt * 100n) / 10000n; // 1%
  const commission = (amt * 800n) / 10000n; // 8%
  const ledger = await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(ledger);
  const mine = ledger.body.data.orders.find((o) => o.id === o7.id);
  assert.equal(mine.feeBps, 100);
  assert.equal(mine.commissionBps, 800, '成交条款快照的基点原样下发（不是"在售条款"）');
  assert.equal(mine.feeWei, fee.toString());
  assert.equal(mine.commissionWei, commission.toString(), '抽成 = 同一基数 × 8%（与平台费同款取整）');
  assert.equal(
    mine.amountWeiNet,
    (amt - fee - commission).toString(),
    '净额必须把抽成减掉——只减平台费的旧式子在抽成 > 0 的店上会多报一整条腿'
  );
  assert.notEqual(mine.amountWeiNet, (amt - fee).toString(), '两腿式子必须**不等于**这个数（否则本用例没有守到东西）');
});

test('费率快照未回填的行：该行费/净额与汇总都是 null（不是 0），并给出未知行数', async () => {
  const ownerLogin = await login(ctx, owner);
  // 一行"四列都没补录过"的入账单：fee_bps 是列默认值 0、fee_collector_at_create 为 NULL = 未知；
  // 抽成两列同理（`commission_to` 为 NULL = 从未补录，
  // 所以这一行同时是"两条腿都没补录"的最坏形状，正是要守的那个形状）。
  const o6 = await settledEscrow(productSlug, buyers[0].address);
  // "未知"档是 NULL（不是空串）：空串在新 schema 里既不是未知也不是确证值
  await db.run('UPDATE orders SET fee_bps = 0, fee_collector_at_create = NULL, commission_bps = 0, commission_to = NULL WHERE order_no = ?', o6.id);
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", new Date(Date.now() + 1), o6.id);
  const row = await db.get('SELECT fee_bps, fee_collector_at_create, commission_bps, commission_to FROM v_orders WHERE order_no = ?', o6.id);
  assert.equal(Number(row.fee_bps), 0, '前置：费率列是默认值（分不开"没补录"与"就是 0"）');
  assert.equal(row.fee_collector_at_create, null, '前置：收取方快照为 NULL = 两列都没补录过 = 未知');
  assert.equal(row.commission_to, null, '前置：抽成条款同样为 NULL = 从未补录 = 未知（不是"不抽成"）');

  const ledger = await request(app)
    .get('/api/orders/seller/ledger')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(ledger);
  const { summary, orders } = ledger.body.data;
  const mine = orders.find((o) => o.id === o6.id);
  assert.equal(mine.feeBps, null, '费率未知 ⇒ null（绝不落成 0："快照为 0" 是对链上的断言）');
  assert.equal(mine.feeWei, null, '平台费算不出来 ⇒ null（不是 0）');
  assert.equal(mine.amountWeiNet, null, '净额随之未知 ⇒ null（不按"不扣费"报净额）');
  /*
    汇总里只要有一行未知，**三条腿与净额**都不是确证的总计（见 routes/orders.js 的 addLeg）：
    只把"未知"标在费用上、净额却照算，就等于用一个偏大的净额糊弄店主。
  */
  assert.equal(summary.feeWei, null, '累计已扣平台费不是确证的总计');
  assert.equal(summary.commissionWei, null, '累计节点抽成同上（两列由同一条 UPDATE 成对补录）');
  assert.equal(summary.amountWeiNet, null);
  assert.ok(summary.termsUnknownCount >= 1, '如实给出未知行数，界面据此说明原因');
  assert.ok(BigInt(summary.amountWei) > 0n, '毛额不受影响（它与费率无关，仍是确证的）');
});
