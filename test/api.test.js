/**
 * API 集成单测：SIWE 认证 / 商品 CRUD / 订单草稿与状态推进 / 汇率降级。
 * 覆盖计划验收项"node：接口单测（supertest）+ SIWE 签名集成测试（ethers 私钥签名）"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOk, login, makeCtx, productPayload, rowLikeOf, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

/** 期望 wei：与节点同源（rates.usdtMicroToPayWei），避免在测试里手抄一遍汇率算式 */
async function expectWei(usdtMicro) {
  const { getRates, usdtMicroToPayWei } = await import('../src/rates.js');
  return usdtMicroToPayWei(usdtMicro, await getRates());
}

// ── 店铺与健康检查 ──

test('店铺信息与健康检查公开可读', async () => {
  const shop = await request(app).get('/api/shop').expect(200);
  assertOk(shop);
  assert.equal(shop.body.data.host.toLowerCase(), owner.address.toLowerCase());
  assert.ok(shop.body.data.escrowAddress);

  const health = await request(app).get('/healthz').expect(200);
  assertOk(health);
  assert.equal(health.body.data.host.toLowerCase(), owner.address.toLowerCase());
});

// ── SIWE 认证 ──

test('SIWE：节点主登录 isHost=true、店主身份按 shops[] 给出；买家两者都不是，令牌可鉴权', async () => {
  const ownerLogin = await login(ctx, owner);
  assert.equal(ownerLogin.isHost, true);
  /*
    登录是**节点级**的：回执回答"这个地址是谁"（`isHost`）与"他在这台机器上能经营哪些店、
    各自什么角色"（`shops[]`），而不是"这次登录针对哪家店"——所以"我是不是店主"这件事
    没有节点级答案，只有**逐店**答案（见 src/routes/auth.js）。旧形状的 `role`/`isOwner`/
    `isStaff` 正是那个已删掉的"针对哪家店"的结论，回执里不再有它们。
  */
  assert.equal(ownerLogin.shops.find((s) => s.code === shopRef.value)?.role, 'owner', '店主身份由 shops[] 里那家店的 role 回答');
  assert.equal(ownerLogin.address.toLowerCase(), owner.address.toLowerCase());
  assert.ok(ownerLogin.token.includes('.'));

  // 买家：登录照样成功（一次登录即可买本节点任何一家店的东西），只是没有可经营的店
  const buyerLogin = await login(ctx, buyer);
  assert.equal(buyerLogin.isHost, false);
  assert.deepEqual(buyerLogin.shops, [], '买家在这台机器上没有可经营的店铺');
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
    .set('Authorization', `Bearer ${buyerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload())
    .expect(403);
});

test('店主上架成功：返回快照哈希（keccak256 0x 前缀）', async () => {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload())
    .expect(200);
  assertOk(res);
  const p = res.body.data;
  assert.ok(/^0x[0-9a-f]{64}$/.test(p.snapshotHash), 'snapshotHash 应为 64 位 hex');
  assert.equal(p.priceUsdt, '88', '展示串去净尾零：88 USDT 写作 88（不是 88.00）');
  assert.equal(p.kind, 'digital');
  productSlug = p.slug;
  productHash = p.snapshotHash;
});

test('上架参数校验：非法 kind / 非正价格被拒', async () => {
  const ownerLogin = await login(ctx, owner);
  const badKind = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'ghost' }))
    .expect(200);
  assert.notEqual(badKind.body.code, 0);
  const badPrice = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ priceUsdtMicro: -1 }))
    .expect(200);
  assert.notEqual(badPrice.body.code, 0);
});

test('商品列表与详情：分页、快照一致性（算法可复算）', async () => {
  const list = await request(app).get('/api/products').expect(200);
  assertOk(list);
  assert.equal(list.body.data.products.length, 1);
  assert.equal(list.body.data.products[0].slug, productSlug);
  assert.equal(
    list.body.data.products[0].shopCode,
    shopRef.value,
    '商品行必须带店铺编号：聚合页靠它解析店名与 /product/<店铺编号>/<slug> 链接'
  );
  assert.ok(list.body.data.rates && list.body.data.rates.stale === true, '汇率走兜底应标记 stale');

  const detail = await request(app).get(`/api/products/${productSlug}`).expect(200);
  assertOk(detail);
  const p = detail.body.data;
  assert.equal(p.shopCode, shopRef.value, '详情与列表使用同一个字段回答“这件商品属于哪家店”');

  // 复算快照：与前端 utils/snapshot.ts 相同的规范化算法（见 products.js 注释）
  const { snapshotObject, computeSnapshotHash } = await import('../src/routes/products.js');
  const rowLike = rowLikeOf(p);
  const obj = snapshotObject(rowLike);
  assert.equal(computeSnapshotHash(obj), p.snapshotHash, '快照哈希应可由公开字段复算');
  assert.deepEqual(obj.media, p.media);
});

test('改价后快照哈希变化；下架后不出现在公开列表', async () => {
  const ownerLogin = await login(ctx, owner);
  const repriced = await request(app)
    .patch(`/api/products/${productSlug}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({ skus: [{ key: '', priceUsdtMicro: 99_000_000, capacity: null }] })
    .expect(200);
  assertOk(repriced);
  assert.notEqual(repriced.body.data.snapshotHash, productHash, '改价应重算快照哈希');

  const off = await request(app)
    .patch(`/api/products/${productSlug}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({ active: false })
    .expect(200);
  assertOk(off);
  const list = await request(app).get('/api/products').expect(200);
  assert.equal(list.body.data.products.length, 0, '下架商品不应出现在公开列表');
  // 恢复上架供后续下单测试
  await request(app)
    .patch(`/api/products/${productSlug}`)
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({ active: true, skus: [{ key: '', priceUsdtMicro: 88_000_000, capacity: null }] })
    .expect(200);
});

// ── 订单：草稿 → 托管 → 发货 ──

let orderId;
let escrowOrderId;

test('买家创建订单草稿：锁定快照、汇率与应付金额（BTY wei 向上取整）', async () => {
  const buyerLogin = await login(ctx, buyer);
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerLogin.token}`).set('X-Mk-Shop', shopRef.value)
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
  assert.equal(o.usdtMicro, 88_000_000, '商品单价（微 USDT）× 数量');
  /*
    应付 wei 与节点同源折算（不在这里手抄一遍汇率算式）：兜底汇率 1 BTY = 0.1 USDT
    ⇒ 88 USDT = 880 BTY。向上取整的产物由 rates.usdtMicroToPayWei 负责。
  */
  assert.equal(o.amountWei, await expectWei(o.usdtMicro));
  const bty = Number(o.amountWei) / 1e18;
  assert.ok(Math.abs(bty - 880) < 1e-9, `应付 BTY 应≈880，实际 ${bty}`);
  assert.ok(o.amountDecimal.length > 0);
});

test('订单草稿未托管时店主不可发货', async () => {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post(`/api/orders/${orderId}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({})
    .expect(200);
  assert.notEqual(res.body.code, 0);
});

test('支付确认鉴权：未登录 401，非买家 403', async () => {
  await request(app).post(`/api/orders/${orderId}/paid`).send({ txHash: '0x' + 'a'.repeat(64) }).expect(401);
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post(`/api/orders/${orderId}/paid`)
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({ txHash: '0x' + 'a'.repeat(64) })
    .expect(403); // 非买家
});

test('支付确认：txHash 格式非法被拒', async () => {
  const buyerLogin = await login(ctx, buyer);
  const res = await request(app)
    .post(`/api/orders/${orderId}/paid`)
    .set('Authorization', `Bearer ${buyerLogin.token}`).set('X-Mk-Shop', shopRef.value)
    .send({ txHash: 'not-a-hash' })
    .expect(200);
  assert.notEqual(res.body.code, 0);
});

test('买家订单列表 / 店主 seller 列表可见该订单', async () => {
  const buyerLogin = await login(ctx, buyer);
  const list = await request(app)
    .get(`/api/orders?address=${buyer.address}`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(200);
  assertOk(list);
  assert.equal(list.body.data.total, 1);
  assert.equal(list.body.data.orders[0].id, orderId);

  // 匿名列表不再出现草稿行（否则 order_no → 匿名详情 → 草稿 escrowOrderId）
  const anonList = await request(app).get(`/api/orders?address=${buyer.address}`).expect(200);
  assert.equal(anonList.body.data.total, 0);

  const ownerLogin = await login(ctx, owner);
  const sellerView = await request(app)
    .get('/api/orders/seller?status=draft')
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
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
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), orderId);
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', '0x' + 'f'.repeat(64), orderId);

  const ownerLogin = await login(ctx, owner);
  // 数字商品：trackingNo 字段兼容为"手动交付内容"（写入 deliveryCode，码池外的直发模式）
  const ship = await request(app)
    .post(`/api/orders/${orderId}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
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
    .set('Authorization', `Bearer ${buyerLogin.token}`).set('X-Mk-Shop', shopRef.value)
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
    .set('Authorization', `Bearer ${ownerLogin.token}`).set('X-Mk-Shop', shopRef.value)
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
  // 换算系数 1 USDT = 1 / 0.1 = 10 BTY
  assert.ok(Math.abs(res.body.data.usdtToBty - 10) < 1e-12);
  /*
    `fallback:true` = 这个数**不是行情**，是 setup.mjs 配的 MK_FALLBACK_BTY_USDT 手工值。
    它与"缓存里上一轮的实时值"对买家的含义完全不同（一个是店主填的数、一个是旧行情），
    所以必须单独报出来——只报 `stale` 会让前端把两者写成同一句"缓存值（可能滞后）"
    （源码评审 2026-10，P1）。
  */
  assert.equal(res.body.data.fallback, true, '手工兜底值必须与"缓存行情"分开报');
  // 法币腿（USDT→CNY）已随标价单位改为 USDT 整条删除：对外快照里不该再有任何 CNY 字段
  assert.deepEqual(
    Object.keys(res.body.data).sort(),
    ['available', 'btyUsdt', 'error', 'fallback', 'stale', 'updatedAt', 'usdtToBty'],
    '只返回单腿 BTY-USDT 契约'
  );
  /*
    降级分支（完全取不到行情）必须返回**同一组键**：形状随分支变化时，任何读 `error`/`stale`
    的消费方会拿到 undefined 而毫无察觉，而前端 types 把这几项声明为非可选（源码评审 2026-10，P2）。
    断言写成"两组键相等"而不是再抄一遍字面量：以后加字段只改一处。
  */
  const { UNAVAILABLE } = await import('../src/routes/rates.js');
  assert.deepEqual(
    Object.keys(UNAVAILABLE).sort(),
    Object.keys(res.body.data).sort(),
    '可用/不可用两个分支的键集合必须一致'
  );
  assert.equal(UNAVAILABLE.available, false);
  assert.equal(UNAVAILABLE.stale, true);
  assert.equal(UNAVAILABLE.btyUsdt, null);
  assert.equal(UNAVAILABLE.usdtToBty, null);
});

// ── 未定义路由 ──

test('未知接口 404', async () => {
  const res = await request(app).get('/api/no-such-endpoint').expect(404);
  assert.notEqual(res.body.code, 0);
});
