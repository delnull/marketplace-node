/**
 * 卖家经营看板统计（P1-①）：口径验证——入账净额（毛额 − 已退买家）与退款并列、
 * 数量/买家/复购去重、时间窗口与趋势补零、商品排行排序/分页、权限。
 *
 * 零费模型：没有平台费、没有节点抽成，净额只有一条式子 `amount_wei − refunded_amount_wei`。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

let ownerToken;
let buyerToken;
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
});

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug, qty = 1, paymentToken = null) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, buyer: buyer.address, quantity: qty, ...(paymentToken ? { paymentToken } : {}) })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/**
 * 直接落终局（模拟 watcher）；at 可指定入账时刻；refundedWei 落已退金额（部分/全额退款）。
 *
 * 一张订单的写入分居两表：事实在 orders，链上镜像（退款额、支付凭证）在 order_chain。
 * 时间列是 DATETIME(3)：传毫秒整数会被 MySQL 当数字字面量写进一个荒谬的时间（且不报错）。
 */
async function settle(id, status, at = Date.now(), refundedWei = null) {
  await db.run('UPDATE orders SET status = ?, updated_at = ? WHERE order_no = ?', status, new Date(at), id);
  /*
    ⚠️ 别名必须**声明**才可用：`UPDATE order_chain SET … c.paid_tx_hash …` 里的 c 没有被声明，
    MySQL 报 Unknown column —— 而 settle() 是每个用例都要走的。这里保留别名形态
    （UPDATE order_chain c），因为 EXISTS 子查询要按 c.order_id 关联。
    另外：这条**只写一张表**（order_chain），另一张表的条件写成 EXISTS ——
    多表 UPDATE 的 affectedRows 是各表命中行数之和，会让所有 changes === 1 的守卫静默失效。
  */
  await db.run(
    `UPDATE order_chain c SET c.refunded_amount_wei = COALESCE(?, c.refunded_amount_wei), c.paid_tx_hash = COALESCE(c.paid_tx_hash, ?) WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = c.order_id AND o.order_no = ?)`,
    refundedWei === null ? null : String(refundedWei), payHash(), id
  );
}

test('跨资产退款折算：原生按 BTY 锁定汇率、ERC20 按 token 精度/锁定行情折算微 USDT', async () => {
  const { refundUsdtMicroOfRow } = await import('../src/stats.js');
  assert.equal(
    refundUsdtMicroOfRow({
      refunded_amount_wei: '1000000000000000000',
      payment_token: '0x0000000000000000000000000000000000000000',
      bty_usdt_rate: '2.5000000000',
    }).toString(),
    '2500000'
  );
  assert.equal(
    refundUsdtMicroOfRow({
      refunded_amount_wei: '1500000',
      payment_token: '0x1111111111111111111111111111111111111111',
      payment_symbol: 'USDT',
      payment_decimals: 6,
      token_usdt_micro_per_token: '2000000',
    }).toString(),
    '3000000'
  );
});

test('overview：入账净额与退款并列、件数/买家/复购去重、确认率', async () => {
  const p1 = await listProduct(productPayload({ kind: 'physical', title: '看板A', capacity: 99, priceUsdtMicro: 100_000_000 }));
  const p2 = await listProduct(productPayload({ kind: 'digital', title: '看板B', priceUsdtMicro: 200_000_000 }));
  // p1 两单（qty 2 + 1）→ confirmed + expired；p2 一单 confirmed
  const a1 = await createDraft(p1.slug, 2);
  const a2 = await createDraft(p1.slug);
  const b1 = await createDraft(p2.slug);
  await settle(a1.id, 'confirmed', Date.now() - 2 * 24 * 3600_000);
  await settle(a2.id, 'expired');
  await settle(b1.id, 'confirmed');
  // 退款单（不入 GMV）
  const r1 = await createDraft(p2.slug);
  await settle(r1.id, 'refunded', Date.now(), r1.amountWei); // 全额退款：已退金额入列
  // 窗口外（31 天前）
  const old = await createDraft(p2.slug);
  await settle(old.id, 'confirmed', Date.now() - 31 * 24 * 3600_000);

  const o30 = await request(app).get('/api/shop/stats/overview?days=30').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(o30);
  const s = o30.body.data;
  assert.equal(s.orders, 3, '窗口内入账 3 单（confirmed×2+expired×1）');
  assert.ok(s.units >= 4, '件数 = 2+1+1');
  assert.equal(s.refundOrders, 1);
  assert.equal(s.buyers, 1, '同买家去重');
  assert.equal(s.repeatBuyers, 1, '成交 ≥2 单 → 复购');
  assert.equal(s.confirmRate, 0.6667, '确认率 4 位小数（2/3）');
  // GMV 净额 = 三单 amount 之和（没有退款、没有费腿）
  const amtOf = async (orderNo) => BigInt((await db.get('SELECT amount_wei FROM v_orders WHERE order_no = ?', orderNo)).amount_wei);
  const expectNet = (await amtOf(a1.id)) + (await amtOf(a2.id)) + (await amtOf(b1.id));
  assert.equal(BigInt(s.gmvNetWei), expectNet, '净额 = 毛额（零费模型，无退款）');
  const expectRefund = BigInt((await db.get('SELECT amount_wei FROM v_orders WHERE order_no = ?', r1.id)).amount_wei);
  assert.equal(BigInt(s.refundWei), expectRefund);
  assert.ok(s.activeProducts >= 2 && s.soldProducts === 2);

  // 全量口径（days=0）含窗口外单
  const oAll = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assert.equal(oAll.body.data.orders, 4, '全量含 31 天前单');
});

test('部分退款：净额 = 毛额 − 已退买家（缺退款读数时那一行不算净额）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '部分退款商品', capacity: 9 }));
  const o = await createDraft(p.slug);
  const amt = BigInt(o.amountWei);
  const refunded = amt / 4n; // 25% 拆分退款
  await settle(o.id, 'settled', Date.now(), refunded);

  const res = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(res);
  const row = (await db.get('SELECT amount_wei, refunded_amount_wei, amount_net_wei FROM v_orders WHERE order_no = ?', o.id));
  assert.equal(BigInt(row.amount_net_wei).toString(), (amt - refunded).toString(), '视图里的净额 = 毛额 − 已退');
  assert.ok(BigInt(res.body.data.gmvNetWei) >= amt - refunded, '汇总净额含本单的拆分结果');
  assert.ok(BigInt(res.body.data.refundWei) >= refunded, '退款合计含本单已退金额');
});

test('trend：按天补零、退款额并入对应日', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '趋势商品', capacity: 99 }));
  const day = await createDraft(p.slug);
  const yest = await createDraft(p.slug);
  const ref = await createDraft(p.slug);
  const now = Date.now();
  await settle(day.id, 'confirmed', now - 1 * 3600_000);
  await settle(yest.id, 'expired', now - 26 * 3600_000);
  await settle(ref.id, 'refunded', now - 26 * 3600_000, ref.amountWei);

  const res = await request(app).get('/api/shop/stats/trend?days=7').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(res);
  const items = res.body.data.items;
  assert.equal(items.length, 7, '7 天补零');
  const keyOf = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const today = items.find((i) => i.day === keyOf(now));
  const yesterday = items.find((i) => i.day === keyOf(now - 26 * 3600_000));
  assert.ok(today && today.orders >= 1, '今日入账单计入');
  assert.ok(yesterday && yesterday.orders >= 1, '昨日入账单计入（含本测试单）');
  assert.ok(BigInt(yesterday.refundWei) > 0n, '退款额并入对应日');
  assert.equal(items.every((i) => i.day.length === 10), true);
});

test('products 排行：排序与分页；越权拒绝', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '排行商品', capacity: 99, priceUsdtMicro: 50_000_000 }));
  for (let i = 0; i < 3; i++) {
    const o = await createDraft(p.slug);
    await settle(o.id, 'confirmed');
  }
  const res = await request(app)
    .get('/api/shop/stats/products?days=0&sort=orders&page=1&pageSize=5')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(res);
  const { products, total } = res.body.data;
  assert.ok(total >= 1);
  const mine = products.find((x) => x.slug === p.slug);
  assert.ok(mine && mine.orders === 3 && mine.units === 3);
  assert.equal(mine.buyers, 1);

  // 越权：匿名/买家
  await request(app).get('/api/shop/stats/overview').expect(401);
  const asBuyer = await request(app).get('/api/shop/stats/overview').set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value);
  assert.equal(asBuyer.status, 403);
});

test('D7 days 参数归一：缺省=默认档、0=全量、非法拒绝、越界钳制', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'D7钳制商品', capacity: 99 }));
  // 一单 40 天前（默认 30 与全量 0 的口径分界）
  const old = await createDraft(p.slug);
  await settle(old.id, 'confirmed', Date.now() - 40 * 24 * 3600_000);

  const def = await request(app).get('/api/shop/stats/overview').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  const d30 = await request(app)
    .get('/api/shop/stats/overview?days=30')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  const all = await request(app)
    .get('/api/shop/stats/overview?days=0')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  const big = await request(app)
    .get('/api/shop/stats/overview?days=99999')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  const cap = await request(app)
    .get('/api/shop/stats/overview?days=400')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(def);
  assert.equal(def.body.data.orders, d30.body.data.orders, '缺省 days = 默认 30（不再被 ||0 吞成全量）');
  assert.equal(big.body.data.orders, cap.body.data.orders, '超大 days 钳制到 366（400 亦钳制）——两者同界');
  assert.ok(all.body.data.orders >= big.body.data.orders, '全量(0) ≥ 366 天钳制窗');
  assert.ok(big.body.data.orders >= d30.body.data.orders, '366 天窗口 ≥ 30 天窗口');

  // 非法：负数 / 非数字 / trend=0
  const neg = await request(app).get('/api/shop/stats/overview?days=-1').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value);
  assert.notEqual(neg.body.code, 0);
  const nan = await request(app).get('/api/shop/stats/products?days=abc').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value);
  assert.notEqual(nan.body.code, 0);
  const t0 = await request(app).get('/api/shop/stats/trend?days=0').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value);
  assert.notEqual(t0.body.code, 0);
});

test('D6 趋势自然日对齐：窗口与桶同界（今天零点起 days 个完整日），窗口外行不进桶', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'D6对齐商品', capacity: 99 }));
  const startOfToday = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  // 今天零点 −6 天（7 日窗口首日）+1s：应在第一个桶
  const inWin = await createDraft(p.slug);
  await settle(inWin.id, 'confirmed', startOfToday - 6 * 24 * 3600_000 + 1000);
  // 今天零点 −7 天：窗口（7 个自然日）外一整日，不得计入任何桶
  const outWin = await createDraft(p.slug);
  await settle(outWin.id, 'confirmed', startOfToday - 7 * 24 * 3600_000 + 1000);

  const res = await request(app).get('/api/shop/stats/trend?days=7').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(res);
  const items = res.body.data.items;
  assert.equal(items.length, 7, '7 个自然日桶');
  const sumForProduct = items.reduce((acc, i) => acc + i.orders, 0);
  /*
    ⚠️ 对照查询的边界**必须是 `Date`**：`startOfToday - 6*24*3600_000` 是毫秒**整数**，
    而 MySQL 拿一个数字去比 `DATETIME(3)` 时会把日期折成 `YYYYMMDDHHMMSS` 再按数值比
    （`20261010000000`)——一个 13 位毫秒数在它面前**恒小**，于是这条 WHERE 静默变成"全表"，
    把窗口外（31 天/40 天前）的单也数进来。症状是"桶合计比 DB 少 3"，看起来像趋势实现漏了单，
    实际是这里的对照口径根本没生效。这正是本仓"绝不把 Date.now() 传进 SQL"那条纪律的现场。
  */
  const winStart = new Date(startOfToday - 6 * 24 * 3600_000);
  const dbIn = (await db.get(`SELECT COUNT(*) AS c FROM v_orders WHERE status IN ('confirmed','settled','expired') AND updated_at >= ?`, winStart)).c;
  assert.equal(sumForProduct, dbIn, '桶合计 = 自然日窗口内入账单数（窗口外单不进任何桶）');
});

test('overview：ERC20 单进入微 USDT 汇总，不把 token 单位混进 BTY 净额', async () => {
  const token = '0x1111111111111111111111111111111111111111';
  const { upsertPaymentToken, deletePaymentToken } = await import('../src/paymentTokens.js');
  await upsertPaymentToken({
    address: token,
    symbol: 'USDT',
    decimals: 6,
    mode: 'fixed',
    fixedUsdtMicroPerToken: '1000000',
  });
  try {
    const p = await listProduct(productPayload({ kind: 'digital', title: 'ERC20 看板', priceUsdtMicro: 12_500_000 }));
    const before = (await request(app).get('/api/shop/stats/overview?days=0')
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200)).body.data;
    const o = await createDraft(p.slug, 1, token);
    assert.equal(o.paymentToken, token);
    await settle(o.id, 'confirmed');
    const after = (await request(app).get('/api/shop/stats/overview?days=0')
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200)).body.data;
    assert.equal(
      BigInt(after.gmvNetUsdtMicro) - BigInt(before.gmvNetUsdtMicro),
      12_500_000n,
      'ERC20 单的净额按锁定 USDT 金额进入跨资产口径'
    );

    await settle(o.id, 'settled', Date.now(), o.amountWei);
    const refunded = (await request(app).get('/api/shop/stats/overview?days=0')
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200)).body.data;
    assert.equal(
      BigInt(refunded.refundUsdtMicro) - BigInt(after.refundUsdtMicro),
      12_500_000n,
      'ERC20 退款按 token 精度/锁定行情折回微 USDT'
    );
  } finally {
    await deletePaymentToken(token);
  }
});
