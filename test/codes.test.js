/**
 * 兑换码交付（Stage 2）：码池导入/查看/删除、发货自动分配、买家侧可见性与脱敏。
 * 覆盖：数字商品码池模式；实物不受影响；未登录/非店主不可读写码池。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
// 同买家同商品可多次购买（v2：orderId 含 UUID 随机化，无共享单号/防重概念）
const buyer2 = Wallet.createRandom();
const buyer3 = Wallet.createRandom();
// 模拟链上规范哈希（escrowed 必有支付凭证，见 orders.js 头注释）
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

/** 上架商品并返回 { ownerToken, slug } */
async function listDigital(overrides = {}) {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send(productPayload(overrides))
    .expect(200);
  assertOk(res);
  return { ownerToken: ownerLogin.token, slug: res.body.data.slug };
}

/** 订单推进到 escrowed（模拟 watcher/paid 回写并落支付凭证），返回 orderId；店主代买家下单 */
async function escrowedOrder(slug, who = buyer.address) {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ productSlug: slug, buyer: who })
    .expect(200);
  assertOk(res);
  const oid = res.body.data.id;
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), oid);
  return oid;
}

// ── 码池读写鉴权 ──

let slug;

test('码池读写鉴权：未登录 401，普通买家 403', async () => {
  const created = await listDigital();
  slug = created.slug;
  const buyerLogin = await login(ctx, buyer);
  await request(app).post(`/api/products/${slug}/codes`).send({ codes: ['X1'] }).expect(401);
  await request(app).get(`/api/products/${slug}/codes`).expect(401);
  await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .send({ codes: ['X1'] })
    .expect(403);
  await request(app).delete(`/api/products/${slug}/codes/1`).expect(401);
});

test('导入校验：physical 商品拒绝、非法入参拒绝', async () => {
  const { ownerToken, slug: physSlug } = await listDigital({ kind: 'physical', priceCnyFen: 100 });
  const onPhys = await request(app)
    .post(`/api/products/${physSlug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['X1'] })
    .expect(200);
  assert.notEqual(onPhys.body.code, 0);

  const noArr = await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: 'X1' })
    .expect(200);
  assert.notEqual(noArr.body.code, 0);
  const empty = await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: [] })
    .expect(200);
  assert.notEqual(empty.body.code, 0);
});

// ── 导入与统计 ──

test('导入码池：去空白/去重/超长过滤，返回统计', async () => {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ codes: [' ABC-001 ', 'ABC-002', 'ABC-002', '', '   ', 'A'.repeat(300)] })
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.imported, 2, '应导入 2 个有效码（去空白后 1 重复跳过、超长过滤）');
  assert.equal(res.body.data.skipped, 1);
  assert.deepEqual(res.body.data.stats, { total: 2, unused: 2, used: 0 });

  // 重复再导：全部跳过
  const dup = await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ codes: ['ABC-001', 'ABC-002'] })
    .expect(200);
  assertOk(dup);
  assert.equal(dup.body.data.imported, 0);
  assert.deepEqual(dup.body.data.stats, { total: 2, unused: 2, used: 0 });
});

test('查看码池：默认未用列表，all 含已用', async () => {
  const ownerLogin = await login(ctx, owner);
  const view = await request(app)
    .get(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assertOk(view);
  assert.equal(view.body.data.stats.unused, 2);
  assert.equal(view.body.data.total, 2);
  assert.deepEqual(view.body.data.codes.map((c) => c.code).sort(), ['ABC-001', 'ABC-002']);
});

// ── 发货自动分配 ──

let poolOrderId;
let poolOrder2Id;

test('码池分配：在途需求占用池额度（并发草稿不得超卖）；两单不重码；池空后新单被拒、发货可手动兑底', async () => {
  const ownerLogin = await login(ctx, owner);
  /*
    池内 2 个码。源码审计 2026-09 修复：下单时可用量口径 = 未用码 − **在途订单尚未交付的需求**
    （此前只 COUNT 未用码，2 个码可以建 3 张草稿，第 3 单付款后必然无码可发）。
    故这里：前 2 张正好占满额度，第 3 张在下单阶段即被拒。
  */
  const o1 = await escrowedOrder(slug);
  const o2 = await escrowedOrder(slug, buyer2.address);

  const oversell = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ productSlug: slug, buyer: buyer3.address })
    .expect(200);
  assert.notEqual(oversell.body.code, 0, '未被在途订单占用的额度已用尽，新单应被拒（防付款后无码可发）');
  assert.match(oversell.body.message, /兑换码不足/);

  const s1 = await request(app)
    .post(`/api/orders/${o1}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({})
    .expect(200);
  assertOk(s1);
  assert.equal(s1.body.data.status, 'shipped');
  assert.equal(s1.body.data.deliveries.length, 1, '数量 1 应交付 1 行');
  assert.ok(['ABC-001', 'ABC-002'].includes(s1.body.data.deliveries[0].value), '发货应自动分配码池内未用码');
  poolOrderId = o1;

  const s2 = await request(app)
    .post(`/api/orders/${o2}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({})
    .expect(200);
  assertOk(s2);
  assert.notEqual(s1.body.data.deliveries[0].value, s2.body.data.deliveries[0].value, '两个码不应重复发放');

  // 池已耗尽（unused=0）：新订单创建被拒（视为售罄，防付款后无码可发）
  const blocked = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ productSlug: slug, buyer: buyer.address })
    .expect(200);
  assert.notEqual(blocked.body.code, 0, '码池已兑完应拒绝新单');
  assert.match(blocked.body.message, /兑换码不足/);

  /*
    在途单发货时遇池空 → 自动分配拒绝，可手动交付兑底。
    构造方式（真实形态）：下单时池里有码（额度校验通过），发货前店主把那个未用码删掉
    （删码/换批次都是真会发生的操作）——此时自动分配必失败，但订单仍可手动交付。
  */
  const add = await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ codes: ['TMP-MANUAL'] })
    .expect(200);
  assertOk(add);
  const o3 = await escrowedOrder(slug, buyer3.address);
  const list = await request(app)
    .get(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  const tmpCodeId = list.body.data.codes.find((c) => c.code === 'TMP-MANUAL').id;
  const del = await request(app)
    .delete(`/api/products/${slug}/codes/${tmpCodeId}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assertOk(del);

  const s3 = await request(app)
    .post(`/api/orders/${o3}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({})
    .expect(200);
  assert.notEqual(s3.body.code, 0, '码池空应拒绝自动分配');
  assert.match(s3.body.message, /未用码不足/);
  const manual = await request(app)
    .post(`/api/orders/${o3}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ deliveryCode: 'MANUAL-KEY-1' })
    .expect(200);
  assertOk(manual);
  assert.equal(manual.body.data.deliveries[0].value, 'MANUAL-KEY-1');
  poolOrder2Id = o3;
});

test('码池查看：已分配码标记 used 并记录订单号；未登录探码失败', async () => {
  const ownerLogin = await login(ctx, owner);
  const view = await request(app)
    .get(`/api/products/${slug}/codes?status=all`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assertOk(view);
  assert.deepEqual(view.body.data.stats, { total: 2, unused: 0, used: 2 });
  const used = view.body.data.codes.filter((c) => c.status === 'used');
  assert.equal(used.length, 2);
  assert.ok(used.some((c) => c.orderId === poolOrderId));

  // 敏感资源：匿名/买家均不可读码池
  await request(app).get(`/api/products/${slug}/codes`).expect(401);
  const buyerLogin = await login(ctx, buyer);
  await request(app)
    .get(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(403);
});

// ── 买家侧可见性与状态联动 ──

test('买家订单：shipped 后凭登录令牌可见码，refunded 后码隐藏', async () => {
  const buyerLogin = await login(ctx, buyer);
  const shipped = await request(app)
    .get(`/api/orders?address=${buyer.address}&status=shipped`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(200);
  assertOk(shipped);
  const mine = shipped.body.data.orders.find((o) => o.id === poolOrderId);
  assert.ok(mine, '发货单应在买家列表');
  assert.ok(mine.deliveries.length > 0, '买家本人登录应可见交付码');
  assert.ok(mine.deliveredAt > 0);

  // 买家确认收货（模拟 watcher ReceiptConfirmed）后码仍可见
  db.prepare("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE id = ?").run(Date.now(), poolOrderId);
  const confirmed = await request(app)
    .get(`/api/orders/${poolOrderId}`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(200);
  assert.equal(confirmed.body.data.deliveries[0].value, mine.deliveries[0].value);

  // 退款后码对买家隐藏（码已随交付发放，业务上由卖家自行追索/作废）
  db.prepare("UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?").run(Date.now(), poolOrderId);
  const refunded = await request(app)
    .get(`/api/orders/${poolOrderId}`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(200);
  assert.deepEqual(refunded.body.data.deliveries, [], '退款后买家不应再看到交付码');

  // 店主视角仍可见（追索依据）
  const ownerLogin = await login(ctx, owner);
  const ownerView = await request(app)
    .get(`/api/orders/${poolOrderId}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assert.equal(ownerView.body.data.deliveries[0].value, mine.deliveries[0].value, '店主详情应始终可见码');
});

// ── 删除 ──

test('删除未用码成功、已用码拒绝；码池删空后新单回到手动交付模式', async () => {
  const ownerLogin = await login(ctx, owner);
  // 补充一个未用码后删除它
  const add = await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ codes: ['TMP-DEL'] })
    .expect(200);
  assertOk(add);
  const list = await request(app)
    .get(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  const tmpId = list.body.data.codes.find((c) => c.code === 'TMP-DEL').id;
  const del = await request(app)
    .delete(`/api/products/${slug}/codes/${tmpId}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assertOk(del);
  assert.deepEqual(del.body.data.stats, { total: 2, unused: 0, used: 2 });

  // 已用码不可删
  const usedView = await request(app)
    .get(`/api/products/${slug}/codes?status=used`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  const usedId = usedView.body.data.codes[0].id;
  const delUsed = await request(app)
    .delete(`/api/products/${slug}/codes/${usedId}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assert.notEqual(delUsed.body.code, 0);
});

test('实物订单发货写 trackingNo 且不受码池逻辑影响', async () => {
  const ownerLogin = await login(ctx, owner);
  const created = await listDigital({ kind: 'physical', priceCnyFen: 6600 });
  const oid = await escrowedOrder(created.slug);
  const ship = await request(app)
    .post(`/api/orders/${oid}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ trackingNo: 'YT-998877' })
    .expect(200);
  assertOk(ship);
  assert.equal(ship.body.data.status, 'shipped');
  assert.equal(ship.body.data.trackingNo, 'YT-998877');
  assert.deepEqual(ship.body.data.deliveries, [], '实物发货不携带交付码');
});
