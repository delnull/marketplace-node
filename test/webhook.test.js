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
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

// 重试退避调小：仅此项仍为 env（运维参数），须在 makeCtx 之前设置（config 模块求值时读取）
process.env.MK_WEBHOOK_RETRY_MS = '20';

const ctx = await makeCtx();
/*
  ⚠️ webhook url/secret 是**一对**，必须在**同一次调用**里给全：`setWebhookConfig` 用一条
  `INSERT … ON DUPLICATE KEY UPDATE` 写这两列（"半套配置"在形状上不可表达，见 src/webhook.js），
  所以没给的项一律写成空串。旧写法是"先设 url、再设 secret"两次调用——第二次把 url 清成了空串，
  于是整份用例的世界里"这家店从没配过通知地址"，所有投递断言都收不到东西（而现象看起来像投递坏了）。
  路由层 `PUT /api/shop/webhook` 的做法是**读-改-写合成完整一对**再传进来；测试同样照这个口径写。
*/
const HOOK_URL = 'https://93.184.216.34/hook/order';
const HOOK_SECRET = 'test-webhook-secret';
const { setWebhookConfig } = await import('../src/webhook.js');
await setWebhookConfig(shopRef.value, { url: HOOK_URL, secret: HOOK_SECRET });
const { app, request, db, owner, buyer } = ctx;
let ownerToken;
let buyerToken;
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');
const { applyEvent } = await import('../src/escrowWatcher.js');
const {
  setWebhookSender,
  notify,
  notifyRaw,
  sendTestEvent,
  webhookStatus,
  resetWebhookStatus,
  typeForChainEvent,
} = await import('../src/webhook.js');
/**
 * 链上真值注入点（唯一实现见 src/chainOrder.js）：watcher 的 OrderCreated 路径从 2026-10-13 起
 * 会**先读一次链上真值**（`status == Created` 且未申请退款）才自动发码——本用例要测的是
 * 事件顺序，所以把链上桩设成"仍在托管、未冻结"。
 */
const { setChainOrderFetcher } = await import('../src/chainOrder.js');

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

/**
 * 等"通知真的投递完"（有界轮询）。
 *
 * 为什么不能用一个固定 sleep：`notify` 是 fire-and-forget，但它在投递前要**异步**走
 * 组装 payload（读订单行）、读通知配置（kv）、SSRF 目标校验这几步——MySQL 迁移后这些
 * 全是真异步（旧实现下 SQLite 同步执行，调用点返回时投递已经发起）。固定 sleep 在整套
 * 测试并行跑时不够，断言就会在"通知还在路上"时读到旧数组，而实现完全正确。
 * 判据是**结果**（捕获到的投递），不是时长：等不到就如实红。
 */
async function waitForDeliveries(pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

/** 建草稿（extra 用于附带发票信息/年龄确认等——验证它们不会顺着 payload 外泄） */
async function createDraft(slug, extra = {}) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, ...extra })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

async function escrowed(order) {
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), order.id);
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', payHash(), order.id);
}

test('watcher 迁移触发通知（order.escrowed→refund.requested→refund.approved→order.refunded）且 payload 无隐私字段', async () => {
  sent.length = 0;
  setWebhookSender(makeSender());
  const p = await listProduct(productPayload({ kind: 'physical', title: '通知商品', capacity: 3 }));
  const order = await createDraft(p.slug);
  await escrowed(order);
  assert.equal(await applyEvent('OrderCreated', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 1 }), 0, '已 escrowed 不重复迁移');
  // 直接用 draft→escrowed 的等价路径：先建草稿再走事件
  const order2 = await createDraft(p.slug);
  assert.equal(await applyEvent('OrderCreated', { orderId: order2.escrowOrderId }, { txHash: payHash(), block: 2 }), 1);

  // 付款后自动交付数字码会触发 shipped（此处为 physical，无自动交付）
  assert.equal(await applyEvent('RefundRequested', { orderId: order2.escrowOrderId }), 1);
  assert.equal(await applyEvent('RefundApproved', { orderId: order2.escrowOrderId, refundWei: order2.amountWei }), 1);

  // notify 为 fire-and-forget，且投递前需经异步的 payload 组装/配置读取/SSRF 目标校验
  // （2026-09 修复；MySQL 迁移后这几步都是真异步）——等**三条投递**落定，不赌时长
  assert.ok(
    await waitForDeliveries(() => sent.length >= 3),
    `三条通知都要送达，实收：${JSON.stringify(sent.map((s) => s.body.type))}`
  );

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
    productPayload({ kind: 'physical', title: '通知运费/发票商品', capacity: 3, shippingFeeUsdtMicro: 9_000_000, ageRestricted: true })
  );
  const order = await createDraft(p.slug, {
    ageAck: true,
    invoice: { needed: true, title: '某某科技有限公司', taxNo: '91310000MA1K35XXXX' },
  });
  await escrowed(order);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 3 }), 1);
  assert.ok(await waitForDeliveries(() => sent.length >= 1), '确认收货通知必须投递落定');

  assert.deepEqual(sent.map((s) => s.body.type), ['order.confirmed']);
  const body = sent[0].body;
  const flat = JSON.stringify(body);
  assert.ok(!flat.includes('某某科技'), 'payload 不得含发票抬头');
  assert.ok(!flat.includes('91310000MA1K35XXXX'), 'payload 不得含税号');
  assert.ok(!('age_ack' in body) && !('ageAck' in body), 'payload 不得含年龄确认留痕');
  for (const k of noPrivacyKeys) assert.ok(!(k in body), `payload 不应含 ${k}`);
  // 金额口径：amountWei 是「商品 + 运费」的总额（运费按单收取一次）
  assert.equal(body.amountWei, order.amountWei);
  assert.equal(order.goodsUsdtMicro, 88_000_000, '商品金额 = productPayload 默认单价（88 USDT）');
  assert.equal(order.shippingFeeUsdtMicro, 9_000_000);
  assert.equal(order.usdtMicro, order.goodsUsdtMicro + 9_000_000, '应付 = 商品 88 + 运费 9 = 97 USDT');
});

test('本地动作触发：发货（手动交付）通知 order.shipped；取消通知 order.cancelled；评价 review.created', async () => {
  sent.length = 0;
  setWebhookSender(makeSender());

  // digital 手动发货
  const p = await listProduct(productPayload({ kind: 'digital', title: '通知发货商品' }));
  const order = await createDraft(p.slug);
  await escrowed(order);
  await request(app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ deliveryCode: 'NOTIFY-CODE-1' })
    .expect(200);
  // 先等投递落定（见 waitForDeliveries 的说明），再按"恰好一条"断言：既验通知发得出去，
  // 也验同一个动作不会双发（promise 序列化那种静默失败也在这里现形）
  assert.ok(await waitForDeliveries(() => sent.length >= 1), '发货通知必须投递落定');
  assert.deepEqual(sent.map((s) => s.body.type), ['order.shipped']);

  // 取消草稿
  sent.length = 0;
  const order2 = await createDraft(p.slug);
  await request(app)
    .post(`/api/orders/${order2.id}/cancel`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.ok(await waitForDeliveries(() => sent.length >= 1), '取消通知必须投递落定');
  assert.deepEqual(sent.map((s) => s.body.type), ['order.cancelled']);

  // 评价通知（数字单：escrowed→ship 手动 → confirmed）
  sent.length = 0;
  const p2 = await listProduct(productPayload({ kind: 'digital', title: '通知评价商品' }));
  const order3 = await createDraft(p2.slug);
  await escrowed(order3);
  await request(app)
    .post(`/api/orders/${order3.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ deliveryCode: 'REVIEW-CODE' })
    .expect(200);
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", new Date(), order3.id);
  await request(app)
    .post(`/api/orders/${order3.id}/review`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ rating: 5 })
    .expect(200);
  // 两条通知各自异步（组装 payload / 读配置 / SSRF 校验三步都在投递之前）：等两条都落定再断言
  const types3 = () => sent.map((s) => s.body.type);
  assert.ok(
    await waitForDeliveries(() => types3().includes('order.shipped') && types3().includes('review.created')),
    `发货与评价两条通知都要送达，实收：${JSON.stringify(types3())}`
  );
});

test('失败重试：首次失败后按退避重试成功；未配置 URL 零调用；最终失败记录不无限重试', async () => {
  sent.length = 0;
  const order = await createDraft((await listProduct(productPayload({ kind: 'digital', title: '通知重试商品' }))).slug);
  setWebhookSender(makeSender({ failTimes: 1 }));
  /*
    `notify` 返回**最终结算**（成功 true / 重试耗尽 false，见 webhook.js 的 deliver），
    直接 await 它，就不必再赌"退避 20ms 够不够"——固定的 80ms sleep 在整套并行跑时
    既可能太短（断言早于重试成功）也可能太长（掩盖重试次数错误）。
  */
  assert.equal(await notify('order.escrowed', order.id), true, '首次失败后重试成功');
  assert.equal(sent.length, 1, '重试后成功送达');
  assert.equal(sent[0].body.type, 'order.escrowed');

  // 最终失败（连续 3 次失败）后不再有更多尝试：结算为 false，且不产生任何送达记录
  sent.length = 0;
  setWebhookSender(makeSender({ failTimes: 99 }));
  assert.equal(await notify('refund.requested', order.id), false, '两次重试耗尽 ⇒ 结算失败（不无限重试）');
  assert.equal(sent.length, 0, '持续失败不产生送达记录（最终 console.error）');

  // 未配置 URL：一次都不投（连发送器都不该被调用），并如实结算 false
  // （只清 url，密钥照旧——"只改其中一项"由调用方合成完整一对，见文件头的说明）
  await setWebhookConfig(shopRef.value, { url: '', secret: HOOK_SECRET });
  sent.length = 0;
  let calls = 0;
  setWebhookSender(async (url, init) => {
    calls += 1;
    return makeSender()(url, init);
  });
  assert.equal(await notify('order.escrowed', order.id), false, '未配置 URL ⇒ 未投递');
  assert.equal(calls, 0, '未配置 URL 时零调用（配置是动态读取的，不该有任何连接尝试）');
  await setWebhookConfig(shopRef.value, { url: HOOK_URL, secret: HOOK_SECRET }); // 恢复：后续用例依赖已配置状态
});

test('SSRF 防护：webhook 指向内网/回环/链路本地地址被拒绝投递（2026-09 修复）', async () => {
  const order = await createDraft((await listProduct(productPayload({ kind: 'digital', title: 'SSRF 防护商品' }))).slug);
  for (const bad of ['http://127.0.0.1:8545/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1/hook', 'http://[::1]:8080/']) {
    sent.length = 0;
    await setWebhookConfig(shopRef.value, { url: bad, secret: HOOK_SECRET });
    // await 结算 = 覆盖完整的重试窗口（被 SSRF 拦下也会重试到耗尽），不需要再猜时长
    assert.equal(await notify('order.escrowed', order.id), false, `${bad} 必须结算为未投递`);
    assert.equal(sent.length, 0, `${bad} 不得产生任何投递`);
  }
  // 恢复公网 URL（同文件后续用例依赖）
  await setWebhookConfig(shopRef.value, { url: HOOK_URL, secret: HOOK_SECRET });
});

test('自动交付路径事件顺序：order.escrowed 先于 order.shipped（watcher 触发）', async () => {
  sent.length = 0;
  setWebhookSender(makeSender());
  const p = await listProduct(productPayload({ kind: 'digital', title: '顺序商品', capacity: null }));
  await request(app)
    .post(`/api/products/${p.slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ codes: ['SEQ-1', 'SEQ-2'] })
    .expect(200);
  const order = await createDraft(p.slug);
  // watcher 真实路径：draft 行 + OrderCreated 事件 → escrowed → 自动交付（码池有码）。
  // 链上桩：仍在托管、未申请退款 ⇒ 允许自动交付；交付本身是异步的（先读链上真值），故轮询等落定。
  setChainOrderFetcher(async (orderIdHex) => {
    const row = await db.get(
      `SELECT commission_quoted_to, commission_quoted_bps, timeout_blocks
         FROM v_orders WHERE escrow_order_id = ?`,
      String(orderIdHex || '').toLowerCase()
    );
    return {
      status: 'Created',
      refundRequested: false,
      refundRejected: false,
      refundedAmount: '0',
      timeoutBlocks: Number(row?.timeout_blocks),
      // 订单身份的一部分（顶层）：交付闸的 chainParamsMatch 读它，桩必须与真实读取器同形
      commissionTo: String(row?.commission_quoted_to ?? '').toLowerCase(),
      commissionTerms: {
        commissionTo: String(row?.commission_quoted_to ?? '').toLowerCase(),
        commissionBps: Number(row?.commission_quoted_bps) || 0,
      },
    };
  });
  assert.equal(await applyEvent('OrderCreated', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 3 }), 1);
  const t0 = Date.now();
  while (Date.now() - t0 < 800 && (await db.get('SELECT status FROM v_orders WHERE order_no = ?', order.id)).status !== 'shipped') {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(
    (await db.get('SELECT status FROM v_orders WHERE order_no = ?', order.id)).status,
    'shipped',
    '码池有码应自动交付'
  );
  setChainOrderFetcher(null);
  // notify 为 fire-and-forget（投递前要组装 payload / 读配置 / 校验目标）——等两条都落定
  assert.ok(await waitForDeliveries(() => sent.length >= 2), `escrowed 与 shipped 都要送达，实收：${JSON.stringify(sent.map((s) => s.body.type))}`);
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
  await escrowed(o2);
  await db.run("UPDATE orders SET status = 'disputed' WHERE order_no = ?", o2.id);
  const o3 = await createDraft(p3.slug); // escrowed+paid，退款待决 → 计入待退款、不计可发货（冻结）
  await escrowed(o3);
  assert.equal(await applyEvent('RefundRequested', { orderId: o3.escrowOrderId }), 1);
  const o4 = await createDraft(p4.slug); // escrowed+paid，无退款申请 → 计入可发货
  await escrowed(o4);
  void o1;
  const res = await request(app)
    .get('/api/orders/seller/status-counts')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(res);
  const { byStatus, pendingRefund, pendingDispute, shipReady } = res.body.data;
  // 口径一致性（与后端 SQL 谓词逐一对齐；此前绝对计数把测试耦合到同文件其它用例的残留行）
  assert.ok(byStatus.disputed >= 1, '存在争议单');
  assert.equal(pendingDispute, byStatus.disputed, '待处理争议数 = 争议状态行数');
  const refundPred = (await db.get("SELECT COUNT(*) AS c FROM v_orders WHERE refund_status = 'requested' AND status IN ('escrowed','shipped','disputed')")).c;
  assert.equal(pendingRefund, refundPred, '待退款与 /seller?refund=requested 同谓词（含 disputed 行）');
  assert.ok(pendingRefund >= 1, 'o3 退款待决计入');
  const readyPred = (await db.get("SELECT COUNT(*) AS c FROM v_orders WHERE status = 'escrowed' AND paid_tx_hash IS NOT NULL AND refund_status != 'requested'")).c;
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
  // notify 返回**最终结算**：await 它 = 投递记录已经落进 deliveries（记录在 resolve 之前写）
  assert.equal(await notify('order.shipped', o9.id), true, '投递成功');
  let res = await request(app)
    .get('/api/shop/webhook-status')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
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
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.equal(res.body.data.ok, false);
  assert.match(String(res.body.data.error), /ECONNREFUSED/);
  assert.match(String(res.body.message), /失败/);

  // 失败也留痕，页面能看到"最近一次失败 + 原因"
  res = await request(app)
    .get('/api/shop/webhook-status')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.equal(res.body.data.last.ok, false);
  assert.match(String(res.body.data.last.error), /ECONNREFUSED/);
  assert.ok(res.body.data.failCount >= 1);

  // 非店主不可见/不可发
  await request(app).get('/api/shop/webhook-status').expect(401);
  await request(app)
    .get('/api/shop/webhook-status')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(403);
  await request(app)
    .post('/api/shop/webhook-test')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
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
/**
 * **P2-3：notify / notifyRaw / deliver 永不 reject**。
 *
 * 调用点大量是 fire-and-forget；而 `shutdown.js` 把任何 `unhandledRejection` 当致命错误
 * `exit(1)`。所以 DB 池超时（`webhookConfig` / `buildPayload` 的读）与发送器抛错都必须
 * 在投递内核里被收口成 `false` + 一条投递日志，而不是抛给调用方。
 */
test('notify / notifyRaw 遇到发送器抛错或 DB 读失败时 resolve(false)，不产生 unhandledRejection', async () => {
  const order = await createDraft((await listProduct(productPayload({ kind: 'digital', title: '投递韧性商品' }))).slug);

  // ① 发送器持续抛错：重试耗尽后 resolve(false)，不 reject
  setWebhookSender(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:9');
  });
  assert.equal(await notify('order.escrowed', order.id), false);
  assert.equal(await notifyRaw('order.pool_empty', { shopCode: shopRef.value, orderId: order.id }), false);

  // ② 通知配置/订单读取本身抛错（模拟 DB 连接池超时）：同样只能 resolve(false)
  resetWebhookStatus();
  const origGet = db.get.bind(db);
  db.get = async () => {
    throw new Error('pool timeout: acquire connection');
  };
  try {
    assert.equal(await notify('order.escrowed', order.id), false, 'buildPayload 读库失败不得 reject');
    assert.equal(
      await notifyRaw('order.pool_empty', { shopCode: shopRef.value, orderId: order.id }),
      false,
      'webhookConfig 读库失败不得 reject'
    );
  } finally {
    db.get = origGet;
  }
  // 失败必须留痕（不是静默吞掉）
  const status = await webhookStatus('');
  assert.ok(status.recent.some((r) => !r.ok && /pool timeout/.test(String(r.error))), 'DB 失败要进投递日志');

  setWebhookSender(makeSender());
});

/**
 * **P3-4：投递日志记实际状态码**，不是恒 200，也不是失败时恒 null。
 * **P3-5：结算类事件的 type 必须与本地 status 一致**（部分退款不能映射成 order.refunded）。
 */
test('投递日志记实际状态码；结算类事件类型与状态一致（0/全额/部分退款）', async () => {
  resetWebhookStatus();
  const order = await createDraft((await listProduct(productPayload({ kind: 'digital', title: '状态码商品' }))).slug);

  // 成功但状态码不是 200（201）：日志必须记 201
  setWebhookSender(async () => ({ status: 201 }));
  assert.equal(await notify('order.escrowed', order.id), true);
  assert.equal((await webhookStatus(shopRef.value)).last.status, 201, '成功投递记实际状态码');

  // 失败：记实际 503（旧实现恒 null）
  resetWebhookStatus();
  setWebhookSender(async () => ({ status: 503 }));
  assert.equal(await notify('order.escrowed', order.id), false);
  const failed = (await webhookStatus(shopRef.value)).last;
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 503, '失败投递同样记实际状态码');
  assert.match(String(failed.error), /503/);

  // 测试事件同步返回实际状态码
  setWebhookSender(async () => ({ status: 202 }));
  const tested = await sendTestEvent(shopRef.value);
  assert.equal(tested.ok, true);
  assert.equal(tested.status, 202, 'sendTestEvent 返回接收端实际状态码');
  assert.equal((await webhookStatus(shopRef.value)).last.status, 202);
  setWebhookSender(makeSender());

  // 类型推导：0 = 全额判卖家；等于 amount = 全额退款；0 < x < amount = 部分退款（本地 settled）
  const AMOUNT = '1000000000000000000';
  assert.equal(typeForChainEvent('ReceiptConfirmed', {}), 'order.confirmed');
  assert.equal(typeForChainEvent('Arbitrated', { refundWei: 0n }, { amountWei: AMOUNT }), 'order.settled');
  assert.equal(typeForChainEvent('Arbitrated', { refundWei: AMOUNT }, { amountWei: AMOUNT }), 'order.refunded');
  assert.equal(
    typeForChainEvent('Arbitrated', { refundWei: BigInt(AMOUNT) / 2n }, { amountWei: AMOUNT }),
    'order.settled',
    '部分退款本地落 settled ⇒ 通知类型也必须是 order.settled（旧实现给 order.refunded，与 payload.status 矛盾）'
  );
  assert.equal(typeForChainEvent('RefundApproved', { refundWei: AMOUNT }, { amountWei: AMOUNT }), 'order.refunded');
  assert.equal(
    typeForChainEvent('RefundApproved', { refundWei: '1' }, { amountWei: AMOUNT }),
    'order.settled',
    '拆分和解按部分退款处理'
  );
  assert.equal(
    typeForChainEvent('Arbitrated', { refundWei: '1' }, {}),
    null,
    '托管额读不到 ⇒ 不猜类型（宁可不通知）'
  );
});

test('投递判定按状态码：默认发送器只回 {status}（无 ok 字段）也必须判成功', async () => {
  const shapes = [];
  setWebhookSender(async (url, init) => {
    shapes.push(url);
    return { status: 200 }; // ← postPinned 的真实形状
  });
  let r = await request(app)
    .post('/api/shop/webhook-test')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.equal(r.body.data.ok, true, '无 ok 字段的 200 必须算投递成功');
  assert.equal(shapes.length, 1, '成功即止：不得触发重试');

  // 非 2xx 仍然要判失败（修复不能把失败路径一起放过）
  setWebhookSender(async () => ({ status: 500 }));
  r = await request(app)
    .post('/api/shop/webhook-test')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.equal(r.body.data.ok, false, 'HTTP 500 必须判失败');
  assert.match(String(r.body.data.error), /500/);

  setWebhookSender(makeSender());
});