/**
 * 卖家经营看板统计（P1-①）：口径验证——入账净额（feeBps 折算）与退款并列、
 * 数量/买家/复购去重、时间窗口与趋势补零、商品排行排序/分页、权限。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

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
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug, qty = 1) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ productSlug: slug, buyer: buyer.address, quantity: qty })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 直接落终局（模拟 watcher）；at 可指定入账时刻；refundedWei 落已退金额（部分/全额退款，2026-09 起退款额入列） */
function settle(id, status, at = Date.now(), feeBps = 0, refundedWei = null) {
  db.prepare(
    "UPDATE orders SET status = ?, fee_bps = ?, updated_at = ?, refunded_amount_wei = COALESCE(?, refunded_amount_wei), paid_tx_hash = COALESCE(paid_tx_hash, ?) WHERE id = ?"
  ).run(status, feeBps, at, refundedWei === null ? null : String(refundedWei), payHash(), id);
}

test('overview：入账净额与退款并列、件数/买家/复购去重、确认率', async () => {
  const p1 = await listProduct(productPayload({ kind: 'physical', title: '看板A', capacity: 99, priceCnyFen: 10000 }));
  const p2 = await listProduct(productPayload({ kind: 'digital', title: '看板B', priceCnyFen: 20000 }));
  // p1 两单（qty 2 + 1，费率 100bps 一单）→ confirmed + expired；p2 一单 confirmed
  const a1 = await createDraft(p1.slug, 2);
  const a2 = await createDraft(p1.slug);
  const b1 = await createDraft(p2.slug);
  settle(a1.id, 'confirmed', Date.now() - 2 * 24 * 3600_000, 100);
  settle(a2.id, 'expired');
  settle(b1.id, 'confirmed');
  // 退款单（不入 GMV）
  const r1 = await createDraft(p2.slug);
  settle(r1.id, 'refunded', Date.now(), 0, r1.amountWei); // 全额退款：已退金额入列
  // 窗口外（31 天前）
  const old = await createDraft(p2.slug);
  settle(old.id, 'confirmed', Date.now() - 31 * 24 * 3600_000);

  const o30 = await request(app).get('/api/shop/stats/overview?days=30').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(o30);
  const s = o30.body.data;
  // p1: 100元×2=200 元与 100 元（qty=1），费率 100bps 仅 a1 → a1 净额 198 元? priceCnyFen 10000=100元; a1 qty2 → 金额 2×(汇率换算…) 固定支付 0.001 忽略：金额与 fee 由 amount/fee 决定——用 DB 精确断言太绕，改用关系断言：
  assert.equal(s.orders, 3, '窗口内入账 3 单（confirmed×2+expired×1）');
  assert.ok(s.units >= 4, '件数 = 2+1+1');
  assert.equal(s.refundOrders, 1);
  assert.equal(s.buyers, 1, '同买家去重');
  assert.equal(s.repeatBuyers, 1, '成交 ≥2 单 → 复购');
  assert.equal(s.confirmRate, 0.6667, '确认率 4 位小数（2/3）');
  // GMV 净额 = 三单 amount 之和 − a1 fee（与实现同语义：floor(amount×bps/10000)）
  const amtOf = (id) => BigInt(db.prepare('SELECT amount_wei FROM orders WHERE id = ?').get(id).amount_wei);
  const expectNet = amtOf(a1.id) - (amtOf(a1.id) * 100n) / 10000n + amtOf(a2.id) + amtOf(b1.id);
  assert.equal(BigInt(s.gmvNetWei), expectNet, '净额按订单级 feeBps 折算');
  const expectRefund = BigInt(db.prepare('SELECT amount_wei FROM orders WHERE id = ?').get(r1.id).amount_wei);
  assert.equal(BigInt(s.refundWei), expectRefund);
  assert.ok(s.activeProducts >= 2 && s.soldProducts === 2);

  // 全量口径（days=0）含窗口外单
  const oAll = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.equal(oAll.body.data.orders, 4, '全量含 31 天前单');
});

test('trend：按天补零、退款额并入对应日', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '趋势商品', capacity: 99 }));
  const day = await createDraft(p.slug);
  const yest = await createDraft(p.slug);
  const ref = await createDraft(p.slug);
  const now = Date.now();
  const d = 24 * 3600_000;
  settle(day.id, 'confirmed', now - 1 * 3600_000);
  settle(yest.id, 'expired', now - 26 * 3600_000);
  settle(ref.id, 'refunded', now - 26 * 3600_000, 0, ref.amountWei);

  const res = await request(app).get('/api/shop/stats/trend?days=7').set('Authorization', `Bearer ${ownerToken}`).expect(200);
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
  const p = await listProduct(productPayload({ kind: 'physical', title: '排行商品', capacity: 99, priceCnyFen: 5000 }));
  for (let i = 0; i < 3; i++) {
    const o = await createDraft(p.slug);
    settle(o.id, 'confirmed');
  }
  const res = await request(app)
    .get('/api/shop/stats/products?days=0&sort=orders&page=1&pageSize=5')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(res);
  const { products, total } = res.body.data;
  assert.ok(total >= 1);
  const mine = products.find((x) => x.slug === p.slug);
  assert.ok(mine && mine.orders === 3 && mine.units === 3);
  assert.equal(mine.buyers, 1);

  // 越权：匿名/买家
  await request(app).get('/api/shop/stats/overview').expect(401);
  const asBuyer = await request(app).get('/api/shop/stats/overview').set('Authorization', `Bearer ${buyerToken}`);
  assert.equal(asBuyer.status, 403);
});

test('D7 days 参数归一：缺省=默认档、0=全量、非法拒绝、越界钳制', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'D7钳制商品', capacity: 99 }));
  // 一单 40 天前（默认 30 与全量 0 的口径分界）
  const old = await createDraft(p.slug);
  settle(old.id, 'confirmed', Date.now() - 40 * 24 * 3600_000);

  const def = await request(app).get('/api/shop/stats/overview').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  const d30 = await request(app)
    .get('/api/shop/stats/overview?days=30')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const all = await request(app)
    .get('/api/shop/stats/overview?days=0')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const big = await request(app)
    .get('/api/shop/stats/overview?days=99999')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const cap = await request(app)
    .get('/api/shop/stats/overview?days=400')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(def);
  assert.equal(def.body.data.orders, d30.body.data.orders, '缺省 days = 默认 30（不再被 ||0 吞成全量）');
  assert.equal(big.body.data.orders, cap.body.data.orders, '超大 days 钳制到 366（400 亦钳制）——两者同界');
  assert.ok(all.body.data.orders >= big.body.data.orders, '全量(0) ≥ 366 天钳制窗');
  assert.ok(big.body.data.orders >= d30.body.data.orders, '366 天窗口 ≥ 30 天窗口');

  // 非法：负数 / 非数字 / trend=0
  const neg = await request(app).get('/api/shop/stats/overview?days=-1').set('Authorization', `Bearer ${ownerToken}`);
  assert.notEqual(neg.body.code, 0);
  const nan = await request(app).get('/api/shop/stats/products?days=abc').set('Authorization', `Bearer ${ownerToken}`);
  assert.notEqual(nan.body.code, 0);
  const t0 = await request(app).get('/api/shop/stats/trend?days=0').set('Authorization', `Bearer ${ownerToken}`);
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
  settle(inWin.id, 'confirmed', startOfToday - 6 * 24 * 3600_000 + 1000);
  // 今天零点 −7 天：窗口（7 个自然日）外一整日，不得计入任何桶
  const outWin = await createDraft(p.slug);
  settle(outWin.id, 'confirmed', startOfToday - 7 * 24 * 3600_000 + 1000);

  const res = await request(app).get('/api/shop/stats/trend?days=7').set('Authorization', `Bearer ${ownerToken}`).expect(200);
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
  const dbIn = db
    .prepare('SELECT COUNT(*) AS c FROM orders WHERE status IN (\'confirmed\',\'settled\',\'expired\') AND updated_at >= ?')
    .get(startOfToday - 6 * 24 * 3600_000).c;
  assert.equal(sumForProduct, dbIn, '桶合计 = 自然日窗口内入账单数（窗口外单不进任何桶）');
});