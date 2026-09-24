/**
 * API 集成单测：SIWE 认证 / 商品 CRUD / 订单草稿与状态推进 / 汇率降级。
 * 覆盖计划验收项"node：接口单测（supertest）+ SIWE 签名集成测试（ethers 私钥签名）"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOk, login, makeCtx, productPayload, rowLikeOf } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

// ── 店铺与健康检查 ──

test('店铺信息与健康检查公开可读', async () => {
  const shop = await request(app).get('/api/shop').expect(200);
  assertOk(shop);
  assert.equal(shop.body.data.owner.toLowerCase(), owner.address.toLowerCase());
  assert.ok(shop.body.data.escrowAddress);

  const health = await request(app).get('/healthz').expect(200);
  assertOk(health);
  assert.equal(health.body.data.owner.toLowerCase(), owner.address.toLowerCase());
});

// ── SIWE 认证 ──

test('SIWE：店主登录 isOwner=true，买家登录 isOwner=false，令牌可鉴权', async () => {
  const ownerLogin = await login(ctx, owner);
  assert.equal(ownerLogin.isOwner, true);
  assert.equal(ownerLogin.address.toLowerCase(), owner.address.toLowerCase());
  assert.ok(ownerLogin.token.includes('.'));

  const buyerLogin = await login(ctx, buyer);
  assert.equal(buyerLogin.isOwner, false);
});

test('SIWE：地址参数非法被拒', async () => {
  const res = await request(app).get('/api/auth/nonce?address=not-an-address').expect(200);
  assert.notEqual(res.body.code, 0);
});

test('SIWE：签名原文一次性使用（重放被拒）', async () => {
  const nonce = await request(app).get(`/api/auth/nonce?address=${buyer.address}`).expect(200);
  const { message } = nonce.body.data;
  const signature = await buyer.signMessage(message);
  const first = await request(app)
    .post('/api/auth/login')
    .send({ address: buyer.address, message, signature })
    .expect(200);
  assertOk(first);
  /*
    重放被拒 —— 而且必须是 **401 + 可读原因**（源码审计 2026-09 复审）：
    `verifySiwe` 用抛异常表达业务失败，旧实现在生产环境下被 `wrap` 折叠成"服务内部错误"，
    用户既不知道要重新获取签名原文，还把正常事件刷进了"未捕获异常"日志。
  */
  const second = await request(app)
    .post('/api/auth/login')
    .send({ address: buyer.address, message, signature })
    .expect(401);
  assert.notEqual(second.body.code, 0); // nonce 已消费
  assert.match(String(second.body.message || ''), /nonce|签名原文/);
});

test('SIWE：签名地址与声明地址不一致被拒', async () => {
  const nonce = await request(app).get(`/api/auth/nonce?address=${buyer.address}`).expect(200);
  const { message } = nonce.body.data;
  const otherSig = await owner.signMessage(message); // 用 owner 签
  const res = await request(app)
    .post('/api/auth/login')
    .send({ address: buyer.address, message, signature: otherSig })
    .expect(401);
  assert.notEqual(res.body.code, 0);
  assert.match(String(res.body.message || ''), /签名地址|不一致/);
});

// ── 商品 CRUD ──

let productSlug;
let productHash;

test('上架鉴权：未登录 401，普通买家 403', async () => {
  await request(app).post('/api/products').send(productPayload()).expect(401);
  const buyerLogin = await login(ctx, buyer);
  await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .send(productPayload())
    .expect(403);
});

test('店主上架成功：返回快照哈希（keccak256 0x 前缀）', async () => {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send(productPayload())
    .expect(200);
  assertOk(res);
  const p = res.body.data;
  assert.ok(/^0x[0-9a-f]{64}$/.test(p.snapshotHash), 'snapshotHash 应为 64 位 hex');
  assert.equal(p.priceCny, '88.00');
  assert.equal(p.kind, 'digital');
  productSlug = p.slug;
  productHash = p.snapshotHash;
});

test('上架参数校验：非法 kind / 非正价格被拒', async () => {
  const ownerLogin = await login(ctx, owner);
  const badKind = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send(productPayload({ kind: 'ghost' }))
    .expect(200);
  assert.notEqual(badKind.body.code, 0);
  const badPrice = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send(productPayload({ priceCnyFen: -1 }))
    .expect(200);
  assert.notEqual(badPrice.body.code, 0);
});

test('商品列表与详情：分页、快照一致性（算法可复算）', async () => {
  const list = await request(app).get('/api/products').expect(200);
  assertOk(list);
  assert.equal(list.body.data.products.length, 1);
  assert.equal(list.body.data.products[0].slug, productSlug);
  assert.ok(list.body.data.rates && list.body.data.rates.stale === true, '汇率走兜底应标记 stale');

  const detail = await request(app).get(`/api/products/${productSlug}`).expect(200);
  assertOk(detail);
  const p = detail.body.data;

  // 复算快照：与前端 utils/snapshot.ts 相同的规范化算法（见 products.js 注释）
  const { snapshotObject, computeSnapshotHash } = await import('../src/routes/products.js');
  const rowLike = rowLikeOf(p);
  const obj = snapshotObject(rowLike);
  assert.equal(computeSnapshotHash(obj), p.snapshotHash, '快照哈希应可由公开字段复算');
  assert.deepEqual(obj.images, p.images);
});

test('改价后快照哈希变化；下架后不出现在公开列表', async () => {
  const ownerLogin = await login(ctx, owner);
  const repriced = await request(app)
    .patch(`/api/products/${productSlug}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ skus: [{ key: '', priceCnyFen: 9900, capacity: null }] })
    .expect(200);
  assertOk(repriced);
  assert.notEqual(repriced.body.data.snapshotHash, productHash, '改价应重算快照哈希');

  const off = await request(app)
    .patch(`/api/products/${productSlug}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ active: false })
    .expect(200);
  assertOk(off);
  const list = await request(app).get('/api/products').expect(200);
  assert.equal(list.body.data.products.length, 0, '下架商品不应出现在公开列表');
  // 恢复上架供后续下单测试
  await request(app)
    .patch(`/api/products/${productSlug}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ active: true, skus: [{ key: '', priceCnyFen: 8800, capacity: null }] })
    .expect(200);
});

// ── 订单：草稿 → 托管 → 发货 ──

let orderId;
let escrowOrderId;

test('买家创建订单草稿：锁定快照、汇率与应付金额（BTY wei 向上取整）', async () => {
  const buyerLogin = await login(ctx, buyer);
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .send({ productSlug })
    .expect(200);
  assertOk(res);
  const o = res.body.data;
  orderId = o.id;
  escrowOrderId = o.escrowOrderId;
  assert.equal(o.status, 'draft');
  assert.ok(/^0x[0-9a-f]{64}$/.test(escrowOrderId));
  assert.equal(o.quantity, 1, '缺省数量为 1');
  assert.equal(o.snapshotHash, productHash, '订单锁定下单时刻的商品快照哈希');
  assert.equal(o.seller.toLowerCase(), owner.address.toLowerCase());
  assert.equal(o.buyer.toLowerCase(), buyer.address.toLowerCase());
  assert.equal(o.cnyFen, 8800);
  // 兜底汇率 1 BTY=0.1USDT、1 USDT=7.2CNY → 1 CNY=1.388888…BTY → ¥88 ≈ 122.22 BTY
  const bty = Number(o.amountWei) / 1e18;
  assert.ok(Math.abs(bty - 88 / 0.72) < 1e-9, `应付 BTY 应≈122.22，实际 ${bty}`);
  assert.ok(o.amountDecimal.length > 0);
});

test('订单草稿未托管时店主不可发货', async () => {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post(`/api/orders/${orderId}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({})
    .expect(200);
  assert.notEqual(res.body.code, 0);
});

test('支付确认鉴权：未登录 401，非买家 403', async () => {
  await request(app).post(`/api/orders/${orderId}/paid`).send({ txHash: '0x' + 'a'.repeat(64) }).expect(401);
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post(`/api/orders/${orderId}/paid`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ txHash: '0x' + 'a'.repeat(64) })
    .expect(403); // 非买家
});

test('支付确认：txHash 格式非法被拒', async () => {
  const buyerLogin = await login(ctx, buyer);
  const res = await request(app)
    .post(`/api/orders/${orderId}/paid`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .send({ txHash: 'not-a-hash' })
    .expect(200);
  assert.notEqual(res.body.code, 0);
});

test('买家订单列表 / 店主 seller 列表可见该订单', async () => {
  const list = await request(app).get(`/api/orders?address=${buyer.address}`).expect(200);
  assertOk(list);
  assert.equal(list.body.data.total, 1);
  assert.equal(list.body.data.orders[0].id, orderId);

  const ownerLogin = await login(ctx, owner);
  const sellerView = await request(app)
    .get('/api/orders/seller?status=draft')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assertOk(sellerView);
  assert.equal(sellerView.body.data.total, 1);

  // 买家视角无鉴权拦截（仅按 address 过滤自身订单）
  const otherView = await request(app).get(`/api/orders?address=${owner.address}`).expect(200);
  assertOk(otherView);
  assert.equal(otherView.body.data.total, 0);
});

test('托管成功（模拟 watcher 回写）后店主可发货，买家可见 shipped', async () => {
  // 模拟 escrowWatcher 收到 OrderCreated 事件后的 DB 状态（回写同步落链上规范哈希作支付凭证）
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run('0x' + 'f'.repeat(64), Date.now(), orderId);

  const ownerLogin = await login(ctx, owner);
  // 数字商品：trackingNo 字段兼容为"手动交付内容"（写入 deliveryCode，码池外的直发模式）
  const ship = await request(app)
    .post(`/api/orders/${orderId}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ trackingNo: 'SF1234567890' })
    .expect(200);
  assertOk(ship);
  assert.equal(ship.body.data.status, 'shipped');
  assert.equal(ship.body.data.deliveries.length, 1, '数字商品交付内容应写入交付行');
  assert.equal(ship.body.data.deliveries[0].value, 'SF1234567890', '交付行内容为卖家填写内容');
  assert.equal(ship.body.data.trackingNo, null, '数字商品不写物流单号');

  // 买家列表带登录令牌可见交付码；未登录则隐藏（防未登录探码）
  const buyerLogin = await login(ctx, buyer);
  const mine = await request(app)
    .get(`/api/orders?address=${buyer.address}&status=shipped`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(200);
  assertOk(mine);
  assert.equal(mine.body.data.total, 1);
  assert.equal(mine.body.data.orders[0].deliveries[0].value, 'SF1234567890');

  const anon = await request(app).get(`/api/orders?address=${buyer.address}&status=shipped`).expect(200);
  assertOk(anon);
  assert.deepEqual(anon.body.data.orders[0].deliveries, [], '未登录查询不应暴露交付码');

  // 详情同样按登录身份决定码可见性
  const detailAnon = await request(app).get(`/api/orders/${orderId}`).expect(200);
  assert.deepEqual(detailAnon.body.data.deliveries, []);
  const detailOwner = await request(app)
    .get(`/api/orders/${orderId}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .expect(200);
  assert.equal(detailOwner.body.data.deliveries[0].value, 'SF1234567890', '店主详情应始终可见交付码');
});

// ── 汇率 ──

test('汇率接口：公网不可用时回退兜底并标记 stale', async () => {
  const res = await request(app).get('/api/rates').expect(200);
  assertOk(res);
  assert.equal(res.body.data.available, true);
  assert.equal(res.body.data.stale, true);
  assert.equal(res.body.data.btyUsdt, 0.1);
  assert.equal(res.body.data.usdtCny, 7.2);
  // 换算系数 1 CNY = 1/(0.1*7.2) BTY
  assert.ok(Math.abs(res.body.data.cnyToBty - 1 / 0.72) < 1e-12);
});

// ── 未定义路由 ──

test('未知接口 404', async () => {
  const res = await request(app).get('/api/no-such-endpoint').expect(404);
  assert.notEqual(res.body.code, 0);
});
