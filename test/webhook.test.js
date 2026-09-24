/**
 * 卖家通知（P0-3）：
 *  - watcher 状态迁移/本地动作成功后触发 webhook（注入 sender 捕获）；
 *  - payload 不含隐私字段；配置 secret 时带 X-MK-Signature；
 *  - 失败重试（retryBaseMs 调小）后成功；最终失败不再重试；
 *  - 未配置 URL 零调用；status-counts 徽标口径。
 */
import { test, before } from 'node:test';

/** 全额退款事件参数（Escrow.RefundApproved 现带 refundWei）：测试内订单金额恒为 1e18 */
const FULL_REFUND = '1000000000000000000';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

// 重试退避调小：仅此项仍为 env（运维参数），须在 makeCtx 之前设置（config 模块求值时读取）
process.env.MK_WEBHOOK_RETRY_MS = '20';

const ctx = await makeCtx();
// webhook url/secret 已改 kv 配置（卖家面板「店铺设置」写入；webhook.js 每次发送实时读取）
const { kvSet } = await import('../src/db.js');
kvSet('mk:webhook_url', 'https://93.184.216.34/hook/order');
kvSet('mk:webhook_secret', 'test-webhook-secret');
const { app, request, db, owner, buyer } = ctx;
let ownerToken;
let buyerToken;
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');
const { applyEvent } = await import('../src/escrowWatcher.js');
const { setWebhookSender, notify } = await import('../src/webhook.js');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
});

/** 捕获型 sender：record {url, headers, body}；可按需抛错 */
const sent = [];
const makeSender = (opts = {}) => async (url, init) => {
  if (opts.failTimes > 0) {
    opts.failTimes -= 1;
    throw new Error('send fail');
  }
  const body = JSON.parse(init.body);
  sent.push({ url, headers: init.headers, body });
  return { ok: true, status: 200 };
};

/**
 * payload 黑名单（键名**包含**即算泄露）：收货信息三列 / 买家备注 / 交付码 /
 * 发票抬头与税号（C 机制：个人信息，只能走面板与订单详情）/ 年龄确认留痕。
 * 逐条按名字挡，是因为 payload 是店主自接的机器人/群，一旦抄送出去就收不回来。
 */
const noPrivacyKeys = ['address', 'tracking', 'delivery', 'shipping', 'buyer', 'note', 'invoice', 'age_ack'];

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

/** 建草稿（extra 用于附带发票信息/年龄确认等——验证它们不会顺着 payload 外泄） */
async function createDraft(slug, extra = {}) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slug, ...extra })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

function escrowed(order) {
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), order.id);
}

test('watcher 迁移触发通知（order.escrowed→refund.requested→refund.approved→order.refunded）且 payload 无隐私字段', async () => {
  sent.length = 0;
  setWebhookSender(makeSender());
  const p = await listProduct(productPayload({ kind: 'physical', title: '通知商品', capacity: 3 }));
  const order = await createDraft(p.slug);
  escrowed(order);
  assert.equal(applyEvent('OrderCreated', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 1 }), 0, '已 escrowed 不重复迁移');
  // 直接用 draft→escrowed 的等价路径：先建草稿再走事件
  const order2 = await createDraft(p.slug);
  assert.equal(applyEvent('OrderCreated', { orderId: order2.escrowOrderId }, { txHash: payHash(), block: 2 }), 1);

  // 付款后自动交付数字码会触发 shipped（此处为 physical，无自动交付）
  assert.equal(applyEvent('RefundRequested', { orderId: order2.escrowOrderId }), 1);
  assert.equal(applyEvent('RefundApproved', { orderId: order2.escrowOrderId, refundWei: order2.amountWei }), 1);

  // notify 为 fire-and-forget，且投递前需经异步的 SSRF 目标校验（2026-09 修复）——等待投递落定
  await new Promise((r) => setTimeout(r, 40));

  const types = sent.map((s) => s.body.type);
  assert.deepEqual(types, ['order.escrowed', 'refund.requested', 'order.refunded']);
  // payload 形状与无隐私字段
  for (const s of sent) {
    assert.equal(s.url, 'https://93.184.216.34/hook/order');
    assert.match(s.headers['x-mk-signature'], /^[0-9a-f]{64}$/, '带 HMAC 签名');
    for (const k of noPrivacyKeys) assert.ok(!(k in s.body), `payload 不应含 ${k}`);
    assert.ok(s.body.orderId && s.body.amountWei && s.body.at);
  }
});

/**
 * 新增字段的隐私边界（C 机制）：发票抬头/税号是个人信息，年龄确认是买家声明留痕，
 * 两者都不能出现在 webhook payload 里（payload 是店主自接的机器人/群，抄送出去收不回来）。
 * 顺带覆盖运费：运费进的是金额（amountWei 已含运费），不需要、也不该单列成新字段。
 */
test('webhook payload 不含发票信息与年龄确认（新增个人字段不外泄）', async () => {
  sent.length = 0;
  setWebhookSender(makeSender());
  const p = await listProduct(
    productPayload({ kind: 'physical', title: '通知运费/发票商品', capacity: 3, shippingFeeCnyFen: 900, ageRestricted: true })
  );
  const order = await createDraft(p.slug, {
    ageAck: true,
    invoice: { needed: true, title: '某某科技有限公司', taxNo: '91310000MA1K35XXXX' },
  });
  escrowed(order);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 3 }), 1);
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(sent.map((s) => s.body.type), ['order.confirmed']);
  const body = sent[0].body;
  const flat = JSON.stringify(body);
  assert.ok(!flat.includes('某某科技'), 'payload 不得含发票抬头');
  assert.ok(!flat.includes('91310000MA1K35XXXX'), 'payload 不得含税号');
  assert.ok(!('age_ack' in body) && !('ageAck' in body), 'payload 不得含年龄确认留痕');
  for (const k of noPrivacyKeys) assert.ok(!(k in body), `payload 不应含 ${k}`);
  // 金额口径：amountWei 是「商品 + 运费」的总额（运费按单收取一次）
  assert.equal(body.amountWei, order.amountWei);
  assert.equal(order.goodsCnyFen, 8800, '商品金额 = productPayload 默认单价（¥88.00）');
  assert.equal(order.shippingFeeCnyFen, 900);
  assert.equal(order.cnyFen, order.goodsCnyFen + 900, '应付 = 商品 + 运费');
});

test('本地动作触发：发货（手动交付）通知 order.shipped；取消通知 order.cancelled；评价 review.created', async () => {
  sent.length = 0;
  setWebhookSender(makeSender());

  // digital 手动发货
  const p = await listProduct(productPayload({ kind: 'digital', title: '通知发货商品' }));
  const order = await createDraft(p.slug);
  escrowed(order);
  await request(app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ deliveryCode: 'NOTIFY-CODE-1' })
    .expect(200);
  assert.deepEqual(sent.map((s) => s.body.type), ['order.shipped']);

  // 取消草稿
  sent.length = 0;
  const order2 = await createDraft(p.slug);
  await request(app)
    .post(`/api/orders/${order2.id}/cancel`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  assert.deepEqual(sent.map((s) => s.body.type), ['order.cancelled']);

  // 评价通知（数字单：escrowed→ship 手动 → confirmed）
  sent.length = 0;
  const p2 = await listProduct(productPayload({ kind: 'digital', title: '通知评价商品' }));
  const order3 = await createDraft(p2.slug);
  escrowed(order3);
  await request(app)
    .post(`/api/orders/${order3.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ deliveryCode: 'REVIEW-CODE' })
    .expect(200);
  db.prepare("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE id = ?").run(Date.now(), order3.id);
  await request(app)
    .post(`/api/orders/${order3.id}/review`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ rating: 5 })
    .expect(200);
  const types3 = sent.map((s) => s.body.type);
  assert.ok(types3.includes('order.shipped') && types3.includes('review.created'));
});

test('失败重试：首次失败后按退避重试成功；未配置 URL 零调用；最终失败记录不无限重试', async () => {
  sent.length = 0;
  const order = await createDraft((await listProduct(productPayload({ kind: 'digital', title: '通知重试商品' }))).slug);
  setWebhookSender(makeSender({ failTimes: 1 }));
  notify('order.escrowed', order.id);
  await new Promise((r) => setTimeout(r, 80)); // retryBase=20ms：首次失败 → 20ms 后重试成功
  assert.equal(sent.length, 1, '重试后成功送达');
  assert.equal(sent[0].body.type, 'order.escrowed');

  // 最终失败（连续 3 次失败）后不再有更多尝试：等待 ~ (20+100)ms 后断言计数仍为 1 次成功前的失败数？
  sent.length = 0;
  setWebhookSender(makeSender({ failTimes: 99 }));
  notify('refund.requested', order.id);
  await new Promise((r) => setTimeout(r, 400)); // 覆盖 2 次重试窗口（20 + 100 ms + 余量）
  assert.equal(sent.length, 0, '持续失败不产生送达记录（最终 console.error）');
});

test('SSRF 防护：webhook 指向内网/回环/链路本地地址被拒绝投递（2026-09 修复）', async () => {
  const order = await createDraft((await listProduct(productPayload({ kind: 'digital', title: 'SSRF 防护商品' }))).slug);
  for (const bad of ['http://127.0.0.1:8545/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1/hook', 'http://[::1]:8080/']) {
    sent.length = 0;
    kvSet('mk:webhook_url', bad);
    notify('order.escrowed', order.id);
    await new Promise((r) => setTimeout(r, 320)); // 覆盖 2 次重试窗口（retryBase=20ms）
    assert.equal(sent.length, 0, `${bad} 不得产生任何投递`);
  }
  // 恢复公网 URL（同文件后续用例依赖）
  kvSet('mk:webhook_url', 'https://93.184.216.34/hook/order');
});

test('自动交付路径事件顺序：order.escrowed 先于 order.shipped（watcher 触发）', async () => {
  sent.length = 0;
  setWebhookSender(makeSender());
  const p = await listProduct(productPayload({ kind: 'digital', title: '顺序商品', capacity: null }));
  await request(app)
    .post(`/api/products/${p.slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['SEQ-1', 'SEQ-2'] })
    .expect(200);
  const order = await createDraft(p.slug);
  // watcher 真实路径：draft 行 + OrderCreated 事件 → escrowed → 自动交付（码池有码）
  assert.equal(applyEvent('OrderCreated', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 3 }), 1);
  assert.equal(
    db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status,
    'shipped',
    '码池有码应自动交付'
  );
  // notify 为 fire-and-forget，且投递前需经异步的 SSRF 目标校验（2026-09 修复）——等待投递落定
  await new Promise((r) => setTimeout(r, 40));
  const types = sent.map((s) => s.body.type);
  assert.deepEqual(types, ['order.escrowed', 'order.shipped'], 'escrowed 必须早于 shipped（不双发 escrowed）');
  assert.ok(sent.every((s) => typeof s.body.eventId === 'string' && s.body.eventId.length > 0), 'payload 带 eventId');
});

test('GET /orders/seller/status-counts 徽标口径', async () => {
  // 防 sybil 锁库存：同买家同（限量）商品未支付草稿合计 ≤99 件——四个状态样本各用独立商品
  const p1 = await listProduct(productPayload({ kind: 'physical', title: '徽标商品1', capacity: 10 }));
  const p2 = await listProduct(productPayload({ kind: 'physical', title: '徽标商品2', capacity: 10 }));
  const p3 = await listProduct(productPayload({ kind: 'physical', title: '徽标商品3', capacity: 10 }));
  const p4 = await listProduct(productPayload({ kind: 'physical', title: '徽标商品4', capacity: 10 }));
  const o1 = await createDraft(p1.slug); // draft
  const o2 = await createDraft(p2.slug); // draft→escrowed→disputed（无退款申请）
  escrowed(o2);
  db.prepare("UPDATE orders SET status = 'disputed' WHERE id = ?").run(o2.id);
  const o3 = await createDraft(p3.slug); // escrowed+paid，退款待决 → 计入待退款、不计可发货（冻结）
  escrowed(o3);
  assert.equal(applyEvent('RefundRequested', { orderId: o3.escrowOrderId }), 1);
  const o4 = await createDraft(p4.slug); // escrowed+paid，无退款申请 → 计入可发货
  escrowed(o4);
  void o1;
  const res = await request(app)
    .get('/api/orders/seller/status-counts')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(res);
  const { byStatus, pendingRefund, pendingDispute, shipReady } = res.body.data;
  // 口径一致性（与后端 SQL 谓词逐一对齐；此前绝对计数把测试耦合到同文件其它用例的残留行）
  assert.ok(byStatus.disputed >= 1, '存在争议单');
  assert.equal(pendingDispute, byStatus.disputed, '待处理争议数 = 争议状态行数');
  const refundPred = db
    .prepare("SELECT COUNT(*) AS c FROM orders WHERE refund_status = 'requested' AND status IN ('escrowed','shipped','disputed')")
    .get().c;
  assert.equal(pendingRefund, refundPred, '待退款与 /seller?refund=requested 同谓词（含 disputed 行）');
  assert.ok(pendingRefund >= 1, 'o3 退款待决计入');
  const readyPred = db
    .prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'escrowed' AND paid_tx_hash IS NOT NULL AND refund_status != 'requested'")
    .get().c;
  assert.equal(shipReady, readyPred, '可发货 = escrowed+有凭证+非退款冻结（冻结行不计）');
  assert.ok(shipReady >= 1, 'o4 计入可发货');
  // 匿名/买家不可见
  await request(app).get('/api/orders/seller/status-counts').expect(401);
});

/**
 * 投递状态（2026-09 新增）：店主在设置页要能看到"我的机器人到底收到没有"。
 *  1. 每次投递（成功/最终失败）都留痕，`/api/shop/webhook-status` 暴露最近记录；
 *  2. 「发送测试事件」同步返回结果，失败原因可读；
 *  3. 这两个接口都是 ownerOnly。
 */
test('webhook-status / webhook-test：投递留痕与测试事件', async () => {
  const { resetWebhookStatus } = await import('../src/webhook.js');
  resetWebhookStatus();
  // 本用例自建一张草稿单（notify 只按 id 组装 payload，草稿足够）
  const p9 = await listProduct(productPayload({ kind: 'physical', title: '投递状态商品', capacity: 3 }));
  const o9 = await createDraft(p9.slug);
  setWebhookSender(makeSender({}));
  notify('order.shipped', o9.id);
  // 注入的 sender 立即 resolve，等一个宏任务让它落进投递记录
  await new Promise((r) => setTimeout(r, 30));
  let res = await request(app)
    .get('/api/shop/webhook-status')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.configured, true);
  assert.equal(res.body.data.hasSecret, true);
  assert.equal(res.body.data.last.ok, true, '成功投递被记录');
  assert.ok(res.body.data.recent.length >= 1);

  // 测试事件：sender 抛错 → 接口仍 200，但结果里带失败原因（页面直接显示）
  setWebhookSender(async () => {
    throw new Error('connect ECONNREFUSED');
  });
  res = await request(app)
    .post('/api/shop/webhook-test')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(res.body.data.ok, false);
  assert.match(String(res.body.data.error), /ECONNREFUSED/);
  assert.match(String(res.body.message), /失败/);

  // 失败也留痕，页面能看到"最近一次失败 + 原因"
  res = await request(app)
    .get('/api/shop/webhook-status')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(res.body.data.last.ok, false);
  assert.match(String(res.body.data.last.error), /ECONNREFUSED/);
  assert.ok(res.body.data.failCount >= 1);

  // 非店主不可见/不可发
  await request(app).get('/api/shop/webhook-status').expect(401);
  await request(app)
    .get('/api/shop/webhook-status')
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(403);
  await request(app)
    .post('/api/shop/webhook-test')
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(403);
});

/**
 * **P1 回归：生产默认发送器的返回形状**（源码审计 2026-09 复审）。
 *
 * 默认发送器是钉住实现 `postPinned`，它只结算 `{ status }`（没有 fetch 的 `ok` 访问器），
 * 而 `sendOnce` 旧写法是 `if (!res.ok) throw new Error(...)` —— 字段不存在 ⇒ 恒为真 ⇒
 * **真实 HTTP 200 也被判投递失败**。后果是一整条通知链静默失效：每次通知白重试 2 次；
 * `alertAck` 只在投递结算为 true 时写幂等标记，于是 `order.pool_empty` / `order.hold_missing` /
 * `order.chain_missing` / `order.chain_repaired` 永不写标记、**每轮无限重发**；
 * 设置页「发送测试事件」永远显示失败。
 *
 * 既有用例全部注入 `{ok:true,status:200}`，永远走不到这个形状，所以本用例专门把
 * **默认发送器的真实返回形状**喂进去（不注入 `ok` 字段）。
 */
test('投递判定按状态码：默认发送器只回 {status}（无 ok 字段）也必须判成功', async () => {
  const shapes = [];
  setWebhookSender(async (url, init) => {
    shapes.push(url);
    return { status: 200 }; // ← postPinned 的真实形状
  });
  let r = await request(app)
    .post('/api/shop/webhook-test')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(r.body.data.ok, true, '无 ok 字段的 200 必须算投递成功');
  assert.equal(shapes.length, 1, '成功即止：不得触发重试');

  // 非 2xx 仍然要判失败（修复不能把失败路径一起放过）
  setWebhookSender(async () => ({ status: 500 }));
  r = await request(app)
    .post('/api/shop/webhook-test')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(r.body.data.ok, false, 'HTTP 500 必须判失败');
  assert.match(String(r.body.data.error), /500/);

  setWebhookSender(makeSender());
});