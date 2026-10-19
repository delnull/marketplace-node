/**
 * 卖家经营看板统计（P1-①）：口径验证——入账净额（feeBps 折算）与退款并列、
 * 数量/买家/复购去重、时间窗口与趋势补零、商品排行排序/分页、权限。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

/** 本文件夹具的抽成快照常量：零地址 = 确证这一单不抽成（与 fees.js 的三态判据同款） */
const COMMISSION_NONE = '0x0000000000000000000000000000000000000000';
/** 抽成收款人（非零 = 这单确证抽成；抽成 > 0 的店才走得到三级分账的中间那条腿） */
const COMMISSION_PAYEE = '0x2222222222222222222222222222222222222222';

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

async function createDraft(slug, qty = 1) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, buyer: buyer.address, quantity: qty })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/**
 * 直接落终局（模拟 watcher）；at 可指定入账时刻；refundedWei 落已退金额（部分/全额退款，2026-09 起退款额入列）。
 *
 * `feeCollectorAtCreate` **必须**与 feeBps 成对给出（`ZERO` = 这单确证不扣费，非零 = 会扣）：
 * 账本/看板的平台费是**三态**的——`fee_collector_at_create` 为空 = 两列都没补录过 = 费率未知
 * ⇒ 净额是"不知道"（下发 null），而不是按 0 折算（见 node/src/fees.js 的 feeSnapshotReadOf）。
 * 真实系统里这三条写入路径（/paid、watcher、/sync）也都是成对写的。
 */
const ZERO_COLLECTOR = '0x0000000000000000000000000000000000000000';
const FEE_COLLECTOR = '0x1111111111111111111111111111111111111111';
async function settle(id, status, at = Date.now(), feeBps = 0, refundedWei = null, feeCollectorAtCreate = ZERO_COLLECTOR) {
  // 一张订单的写入分居两表：事实/费率在 orders，链上镜像（退款额、支付凭证）在 order_chain。
  // 时间列是 DATETIME(3)：传毫秒整数会被 MySQL 当数字字面量写进一个荒谬的时间（且不报错）。
  await db.run(
    'UPDATE orders SET status = ?, fee_bps = ?, fee_collector_at_create = ?, commission_to = ?, updated_at = ? WHERE order_no = ?',
    status, feeBps, feeCollectorAtCreate, COMMISSION_NONE, new Date(at), id
  );
  /*
    ⚠️ 别名必须**声明**才可用：`UPDATE order_chain SET … c.paid_tx_hash …` 里的 c 没有被声明，
    MySQL 报 Unknown column 'c.paid_tx_hash' in 'field list' —— 而 settle() 是每个用例都要走的，
    所以这一处会让整个文件全红，且报错指向 update 而不指向这条 SQL 本身。
    这里保留别名形态（UPDATE order_chain c），因为 EXISTS 子查询要按 c.order_id 关联。
    另外：这条**只写一张表**（order_chain），另一张表的条件写成 EXISTS ——
    多表 UPDATE 的 affectedRows 是各表命中行数之和，会让所有 changes === 1 的守卫静默失效。
  */
  await db.run(
    `UPDATE order_chain c SET c.refunded_amount_wei = COALESCE(?, c.refunded_amount_wei), c.paid_tx_hash = COALESCE(c.paid_tx_hash, ?) WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = c.order_id AND o.order_no = ?)`,
    refundedWei === null ? null : String(refundedWei), payHash(), id
  );
}

test('overview：入账净额与退款并列、件数/买家/复购去重、确认率', async () => {
  const p1 = await listProduct(productPayload({ kind: 'physical', title: '看板A', capacity: 99, priceUsdtMicro: 100_000_000 }));
  const p2 = await listProduct(productPayload({ kind: 'digital', title: '看板B', priceUsdtMicro: 200_000_000 }));
  // p1 两单（qty 2 + 1，费率 100bps 一单）→ confirmed + expired；p2 一单 confirmed
  const a1 = await createDraft(p1.slug, 2);
  const a2 = await createDraft(p1.slug);
  const b1 = await createDraft(p2.slug);
  await settle(a1.id, 'confirmed', Date.now() - 2 * 24 * 3600_000, 100, null, FEE_COLLECTOR);
  await settle(a2.id, 'expired');
  await settle(b1.id, 'confirmed');
  // 退款单（不入 GMV）
  const r1 = await createDraft(p2.slug);
  await settle(r1.id, 'refunded', Date.now(), 0, r1.amountWei); // 全额退款：已退金额入列
  // 窗口外（31 天前）
  const old = await createDraft(p2.slug);
  await settle(old.id, 'confirmed', Date.now() - 31 * 24 * 3600_000);

  const o30 = await request(app).get('/api/shop/stats/overview?days=30').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(o30);
  const s = o30.body.data;
  /*
    p1 单价 100 USDT、p2 单价 200 USDT；a1 是 p1 的 qty=2 单且费率 100bps。
    金额与手续费都由订单行的 amount_wei / fee_bps 决定，所以这里只做**关系断言**
    （GMV 净额 = 窗口内三单 amount 之和 − a1 的手续费），不手抄汇率与费率算式。
  */
  assert.equal(s.orders, 3, '窗口内入账 3 单（confirmed×2+expired×1）');
  assert.ok(s.units >= 4, '件数 = 2+1+1');
  assert.equal(s.refundOrders, 1);
  assert.equal(s.buyers, 1, '同买家去重');
  assert.equal(s.repeatBuyers, 1, '成交 ≥2 单 → 复购');
  assert.equal(s.confirmRate, 0.6667, '确认率 4 位小数（2/3）');
  // GMV 净额 = 三单 amount 之和 − a1 fee（与实现同语义：floor(amount×bps/10000)）
  const amtOf = async (orderNo) => BigInt((await db.get('SELECT amount_wei FROM v_orders WHERE order_no = ?', orderNo)).amount_wei);
  const expectNet = await amtOf(a1.id) - (await amtOf(a1.id) * 100n) / 10000n + await amtOf(a2.id) + await amtOf(b1.id);
  assert.equal(BigInt(s.gmvNetWei), expectNet, '净额按订单级 feeBps 折算');
  const expectRefund = BigInt((await db.get('SELECT amount_wei FROM v_orders WHERE order_no = ?', r1.id)).amount_wei);
  assert.equal(BigInt(s.refundWei), expectRefund);
  assert.ok(s.activeProducts >= 2 && s.soldProducts === 2);

  // 全量口径（days=0）含窗口外单
  const oAll = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assert.equal(oAll.body.data.orders, 4, '全量含 31 天前单');
});

test('费率快照未回填的行：GMV 是"不知道"（null + feeUnknownCount），不是按 0 折算的数', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '未知费率商品', capacity: 9 }));
  const known = await createDraft(p.slug);
  await settle(known.id, 'confirmed');
  const before = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(before);
  assert.equal(before.body.data.feeUnknownCount, 0, '前置：库里没有费率口径未知的入账单');

  // 一行"两列都没补录过"的入账单（fee_collector_at_create 为空 = 未知，见 src/fees.js）
  const unknown = await createDraft(p.slug);
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", new Date(), unknown.id);
  const after = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(after);
  assert.equal(after.body.data.gmvNetWei, null, '有未知费率的行 ⇒ 净额是"不知道"，不下发一个偏小的数');
  assert.ok(after.body.data.feeUnknownCount >= 1, '并如实给出未知行数（供界面说明原因）');
  assert.ok(Number(after.body.data.orders) > Number(before.body.data.orders), '单数照常统计（它与费率无关，仍是确证的）');

  // 补录两列（真实系统里 /paid、watcher、/sync 都是成对写）之后，数字自己回来——判据是数据，不是开关
  await db.run("UPDATE orders SET fee_bps = 100, fee_collector_at_create = ?, commission_to = ? WHERE order_no = ?", FEE_COLLECTOR, COMMISSION_NONE, unknown.id);
  const healed = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(healed);
  assert.equal(healed.body.data.feeUnknownCount, 0);
  assert.notEqual(healed.body.data.gmvNetWei, null);
});

test('节点抽成腿：看板与趋势的净额都要减掉抽成（只减平台费的旧式子在抽成 > 0 的店上多报一整条腿）', async () => {
  /*
    这条用例钉的是**多店改造最容易漏的一处**：`GMV 净额` 与每日净额此前是"基数 − 平台费"，
    而链上 `_settle` 还会再扣一条**节点抽成**。抽成 > 0 的店里，旧式子给出的净额
    比链上打给店主的钱多出抽成那一截——看板与流水页各自自洽，店主永远查不出差在哪。
    这里用一个**当天**的单（趋势桶与 overview 都覆盖到），把四个数逐一钉死。
  */
  const p = await listProduct(productPayload({ kind: 'physical', title: '抽成腿商品', capacity: 9 }));
  /*
    基线：本文件的用例共用一个库，趋势桶里已经有前面几单（都落在今天）。
    所以判据必须是**差值**——写死一个绝对值只会在别的用例改动时红，而它红了也说明不了本改动。
  */
  const trendOf = async () => {
    const r = await request(app).get('/api/shop/stats/trend?days=1').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
    assertOk(r);
    return r.body.data.items[r.body.data.items.length - 1];
  };
  const before = await trendOf();
  const o = await createDraft(p.slug);
  const now = Date.now();
  const amt = BigInt(o.amountWei);
  const feeBps = 100; // 1% 平台费
  const commissionBps = 800; // 8% 节点抽成
  await db.run(
    "UPDATE orders SET status = 'confirmed', fee_bps = ?, fee_collector_at_create = ?, commission_bps = ?, commission_to = ?, updated_at = ? WHERE order_no = ?",
    feeBps, FEE_COLLECTOR, commissionBps, COMMISSION_PAYEE, new Date(now), o.id
  );
  await db.run('UPDATE order_chain c SET c.paid_tx_hash = COALESCE(c.paid_tx_hash, ?) WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = c.order_id AND o.order_no = ?)', payHash(), o.id);

  const fee = (amt * BigInt(feeBps)) / 10000n;
  const commission = (amt * BigInt(commissionBps)) / 10000n;
  const ov = await request(app).get('/api/shop/stats/overview?days=1').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(ov);
  assert.ok(BigInt(ov.body.data.gmvNetWei) >= amt - fee - commission, '窗口内净额至少含本单的三腿结果');

  const today = await trendOf();
  assert.equal(Number(today.orders), Number(before.orders) + 1, '本单落在今天的桶里');
  assert.equal(today.feeUnknownCount, 0, '条款快照两对都补录了 ⇒ 没有"不知道"的行');
  /*
    这一天的净额**增量**必须逐字等于 毛额 − 平台费 − 抽成。
    两腿式子会得到 `amt − fee`，比这个数大 `commission`——`assert.notEqual` 是这条判据的守门人。
  */
  const delta = BigInt(today.netWei) - BigInt(before.netWei);
  assert.equal(delta.toString(), (amt - fee - commission).toString(), '当日净额增量 = 毛额 − 平台费 − 节点抽成');
  assert.notEqual(delta.toString(), (amt - fee).toString(), '两腿式子（只减平台费）必须不等于它');
});

test('trend：按天补零、退款额并入对应日', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '趋势商品', capacity: 99 }));
  const day = await createDraft(p.slug);
  const yest = await createDraft(p.slug);
  const ref = await createDraft(p.slug);
  const now = Date.now();
  const d = 24 * 3600_000;
  await settle(day.id, 'confirmed', now - 1 * 3600_000);
  await settle(yest.id, 'expired', now - 26 * 3600_000);
  await settle(ref.id, 'refunded', now - 26 * 3600_000, 0, ref.amountWei);

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
  // 本商品窗口内只应有 inWin 一单（outWin 在窗口外；其它测试商品不在本商品维度）
  const mine = items.filter((i) => {
    // orders 为全店维度，无法按商品拆分——用窗口总行数对照 DB 口径
    return i;
  });
  assert.ok(mine.length === 7);
  /*
    ⚠️ 对照查询的边界**必须是 `Date`**：`startOfToday - 6*24*3600_000` 是毫秒**整数**，
    而 MySQL 拿一个数字去比 `DATETIME(3)` 时会把日期折成 `YYYYMMDDHHMMSS` 再按数值比
    （`20261010000000`)——一个 13 位毫秒数在它面前**恒小**，于是这条 WHERE 静默变成"全表"，
    把窗口外（31 天/40 天前）的单也数进来。症状是"桶合计比 DB 少 3"，看起来像趋势实现漏了单，
    实际是这里的对照口径根本没生效。这正是本仓"绝不把 Date.now() 传进 SQL"那条纪律的现场。
  */
  const winStart = new Date(startOfToday - 6 * 24 * 3600_000);
  const dbIn = (await db.get('SELECT COUNT(*) AS c FROM v_orders WHERE status IN (\'confirmed\',\'settled\',\'expired\') AND updated_at >= ?', winStart)).c;
  assert.equal(sumForProduct, dbIn, '桶合计 = 自然日窗口内入账单数（窗口外单不进任何桶）');
});