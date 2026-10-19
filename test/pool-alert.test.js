/**
 * 池式商品「已收款但无货可交」主动告警（order.pool_empty）单测：
 *  - 判定口径与卖家面板 poolEmpty **同一实现**（poolShortfallOf/isPoolEmpty）；
 *  - 托管落定（watcher 的 OrderCreated 分支；paid 快路径调同一函数）后池内资源不足 → 推店主；
 *  - 每单至多一次（order_alerts 里的一行）；池子够 / 非池式 / 已交付的行不告警；
 *  - payload 无 PII（只有订单号/链上单号/原因）；
 *  - 2026-09 修复：**投递失败 ⇒ 不留下幂等标记**（下一轮复查仍会重试，at-least-once，见 src/alertAck.js）；
 *    形状是"先预占那一行、失败再释放、成功改写 sent_at"——所以"投递未结算期间的重复调用不重复推"
 *    也由同一行回答（见最后一条用例）。
 *
 * 说明：poolEmpty 面板字段的既有行为由 stock.test.js 覆盖（本文件只补"主动告警"这一侧）；
 * paid 路由（POST /:id/paid）的成功路径需要链上收据桩，本仓库未提供该注入点，
 * 故其"调用同一函数"由代码审查保证（见 routes/orders.js 的 alertPoolEmptyForOrder 调用点）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

// 重试退避调小（运维参数，config 顶层求值时读取——须在 makeCtx 之前设置）
process.env.MK_WEBHOOK_RETRY_MS = '20';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

// 通知走同一套 webhook（URL 存 kv；注入捕获型 sender）
const { setWebhookConfig } = await import('../src/webhook.js');
await setWebhookConfig(shopRef.value, { url: 'https://93.184.216.34/hook/pool' });
const { setWebhookSender } = await import('../src/webhook.js');
const { applyEvent } = await import('../src/escrowWatcher.js');
const { isPoolEmpty, poolShortfallOf, alertPoolEmptyForOrder, resetPoolAlertFlag } = await import('../src/poolAlert.js');

const sent = [];
setWebhookSender(async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200 };
});
/** notifyRaw 为 fire-and-forget（投递前还有异步 SSRF 校验）：断言前让出微任务 */
const flushDeliveries = () => new Promise((r) => setTimeout(r, 40));
/** 有界轮询等待（投递结算是异步的：固定 sleep 在整套测试并行跑时会偶发不够） */
async function waitUntil(pred, ms = 3000) {
  const t0 = Date.now();
  while (!(await pred()) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  return await pred();
}
/**
 * 该单的告警**去重行**（`order_alerts(order_id, kind='pool_empty')`）。
 *
 * 它的语义是"这条告警已经由我投递过（或正在投递）"：`alertAck.js` 先 INSERT 预占，
 * 投递失败就把行删掉（下一轮复查重投），成功则改写 `sent_at`。
 * 所以"等它出现"= 等投递**结算完成**（成功那一支）——这正是断言前要等的那个"果"。
 *
 * 为什么断言前等它、而不是 `flushDeliveries()`（2026-10-14 修一条 flaky 用例）：
 * 那条 `order.pool_empty` 的投递链上挂着一次链上真值读取（`tryAutoDeliverByEscrowOrder`，
 * 单测里 `MK_RPC_URL=127.0.0.1:1` ⇒ 每次都要走一遍真实的连接失败）与 SSRF 校验，
 * 40ms 的固定 sleep 在 node --test 并行跑整套时**偶发不够**：断言读到 0 条告警就红，
 * 而实现完全正确（实测 5 次全套 1 次红、单跑该文件 5 次全绿）。
 * 等标记 = 等"这件事真的结算完了"——它是投递成功的**果**，不是又一次拍脑袋的时长。
 */
/*
  标记是 `order_alerts(order_id, kind='pool_empty')` 的一行（主键去重，见 src/alertAck.js）：
  `order_id` 是**内部数字主键**，不是订单号、也不是链上单号。
*/
const alertDelivered = async (orderNo) =>
  !!(await db.get('SELECT 1 AS one FROM order_alerts WHERE order_id = ? AND kind = ?', await orderIdOf(orderNo), 'pool_empty'));

const NFT_CONTRACT = '0x' + '9'.repeat(40);
const nftPayload = (overrides = {}) => ({
  title: '告警测试 NFT',
  description: 'NFT 池缺货告警单测商品。',
  media: [{ type: 'image', url: 'https://example.com/n.jpg' }],
  kind: 'nft',
  nftContract: NFT_CONTRACT,
  specs: [],
  skus: [{ key: '', priceUsdtMicro: 66_000_000, capacity: null }],
  ...overrides,
});

let ownerToken;
let buyerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
});

let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');
/** 按**对外订单号**读整单（createDraft 返回的 id 就是它）；读模型见 src/db.js 的 v_orders */
const rowOf = async (orderNo) => await db.get('SELECT * FROM v_orders WHERE order_no = ?', orderNo);
/**
  内部主键（orders.id / _orders.order_id）：告警去重表 order_alerts.order_id 与子表外键
  都用它，而接口给的 id 是订单号——两者刻意不互相顶替（见 src/poolAlert.js 的键形状说明）。
*/
const orderIdOf = async (orderNo) => (await db.get('SELECT order_id FROM v_orders WHERE order_no = ?', orderNo)).order_id;
const statusOf = async (id) => (await rowOf(id)).status;

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug, extra = {}) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, ...extra })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 本地镜像"买家已托管"（链上校验不在单测范围，仅置状态与凭证） */
async function escrowed(order) {
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), order.id);
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', payHash(), order.id);
}

async function importCodes(slug, codes) {
  const res = await request(app).post(`/api/products/${slug}/codes`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send({ codes }).expect(200);
  assertOk(res);
}

async function importTokens(slug, tokens) {
  const res = await request(app).post(`/api/products/${slug}/tokens`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send({ tokens }).expect(200);
  assertOk(res);
}

test('poolShortfallOf/isPoolEmpty：与卖家面板 poolEmpty 同口径（数字按 quantity、NFT 扣已交付、实物与非托管态不成立）', async () => {
  // autoDeliver=0：本用例只验判定口径，不被"补货即自动补发"改变订单状态
  const p = await listProduct(productPayload({ title: '缺货告警数字商品', autoDeliver: 0 }));
  const d = await createDraft(p.slug);
  await escrowed(d);
  // 未建池 = 可用 0 → 缺货
  assert.deepEqual(await poolShortfallOf(await rowOf(d.id)), { poolBacked: true, kind: 'digital', need: 1, available: 0, short: true });
  assert.equal(await isPoolEmpty(await rowOf(d.id)), true);
  // 面板字段与之一致（同一实现的消费方）
  const detail = await request(app).get(`/api/orders/${d.id}`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(detail);
  assert.equal(detail.body.data.poolEmpty, true);
  // 导入 1 个码 → 够本单，不再缺
  await importCodes(p.slug, ['ALERT-1']);
  assert.equal(await isPoolEmpty(await rowOf(d.id)), false);
  const detailFull = await request(app).get(`/api/orders/${d.id}`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assert.equal(detailFull.body.data.poolEmpty, false);

  // 多件订单：需求 = quantity（草稿先建、货后补，故此处才建 2 件的单）
  const p2 = await listProduct(productPayload({ title: '缺货告警数字商品2', autoDeliver: 0 }));
  const d2 = await createDraft(p2.slug, { quantity: 2 });
  await escrowed(d2);
  await importCodes(p2.slug, ['ALERT-2']);
  const s2 = await poolShortfallOf(await rowOf(d2.id));
  assert.equal(s2.need, 2);
  assert.equal(s2.available, 1);
  assert.equal(s2.short, true, '需 2 个只有 1 个 → 仍缺');

  // NFT：需求 = quantity − 已交付行数（分批交付）
  const n = await listProduct(nftPayload());
  const dn = await createDraft(n.slug, { quantity: 2 });
  await escrowed(dn);
  assert.equal((await poolShortfallOf(await rowOf(dn.id))).need, 2, '未交付时需求 = quantity');
  await importTokens(n.slug, ['42']);
  assert.equal((await poolShortfallOf(await rowOf(dn.id))).short, true, '1 枚 tokenId 不够 2 件');
  await db.run("INSERT INTO order_delivery_items (order_id, kind, value, tx_hash) VALUES (?, 'nft', '7', NULL)", await orderIdOf(dn.id));
  const filled = await poolShortfallOf(await rowOf(dn.id));
  assert.equal(filled.need, 1, '已交付 1 枚：剩余需求 1');
  assert.equal(filled.available, 1);
  assert.equal(filled.short, false);

  // 实物：非池式，恒不成立
  const ph = await listProduct(productPayload({ kind: 'physical', title: '告警对照实物', capacity: 3 }));
  const dp = await createDraft(ph.slug);
  await escrowed(dp);
  assert.equal((await poolShortfallOf(await rowOf(dp.id))).poolBacked, false);

  // 非 escrowed（已交付）：池语义不适用
  await db.run("UPDATE orders SET status = 'shipped' WHERE order_no = ?", d.id);
  assert.equal((await poolShortfallOf(await rowOf(d.id))).poolBacked, false);
  assert.equal(await statusOf(d.id), 'shipped');
});

test('alertPoolEmptyForOrder：池空每单只告警一次；payload 无 PII；池够/已交付不告警', async () => {
  const p = await listProduct(productPayload({ title: '告警发送数字商品', autoDeliver: 0 }));
  const d = await createDraft(p.slug);
  await escrowed(d);

  sent.length = 0;
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(d.id)), true, '本地 id 命中并发告警');
  assert.ok(await waitUntil(async () => await alertDelivered(d.id)), '投递结算完成（标记已写）才断言');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.type, 'order.pool_empty');
  assert.equal(sent[0].body.orderId, d.id);
  assert.equal(sent[0].body.escrowOrderId, d.escrowOrderId);
  assert.match(sent[0].body.reason, /仍需 1 个/);
  assert.match(sent[0].body.reason, /补货|退款/);
  for (const k of ['address', 'shipping', 'buyer', 'note', 'phone', 'name', 'tracking']) {
    assert.ok(!(k in sent[0].body), `payload 不应含 ${k}`);
  }

  // 第二次：幂等标记拦住（池空是持续状态，每轮轮询都推会把店主的机器人刷爆）
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(d.id)), false);
  await flushDeliveries();
  assert.equal(sent.length, 1);

  // 重置标记后可再发一次：入参始终是**内部主键**（order_alerts.order_id 是外键指向它的那一列）
  await resetPoolAlertFlag(await orderIdOf(d.id));
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(d.id)), true);
  assert.ok(await waitUntil(async () => await alertDelivered(d.id)), '第二投也结算完成');
  assert.equal(sent.length, 2);

  // 池子够：不告警
  const full = await listProduct(productPayload({ title: '告警不发数字商品', autoDeliver: 0 }));
  await importCodes(full.slug, ['FULL-1']);
  const df = await createDraft(full.slug);
  await escrowed(df);
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(df.id)), false);
  // 已交付（非 escrowed）：不告警
  await db.run("UPDATE orders SET status = 'shipped' WHERE order_no = ?", df.id);
  await resetPoolAlertFlag(await orderIdOf(df.id));
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(df.id)), false);
  await flushDeliveries();
  // 只断言"这两单没被推"（此时同进程里没有别的告警在途，`sent` 长度即全量）
  assert.equal(sent.filter((s) => s.body.orderId === df.id).length, 0, '池够 + 已交付：都不发');
  assert.equal(sent.filter((s) => s.body.type === 'order.pool_empty').length, 2, '全程只发过前两条');
});

test('watcher 路径：OrderCreated 回写为 escrowed 时池内不足 → 自动告警一次（重复事件不再发）', async () => {
  const p = await listProduct(productPayload({ title: '告警 watcher 商品', autoDeliver: 0 }));
  const order = await createDraft(p.slug);
  sent.length = 0;
  // 本地 draft + 链上 OrderCreated：状态推进与告警同一条事件路径（applyEvent 的 afterCommit）
  assert.equal(await applyEvent('OrderCreated', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 3 }), 1);
  assert.equal(await statusOf(order.id), 'escrowed');
  /*
    这条投递链比别的用例更长：`afterCommit` → `tryAutoDeliverByEscrowOrder`（**一次链上真值读取**，
    单测里必然连接失败）→ `.finally(alert)` → 告警。原先用固定 40ms sleep 等它，在整套并行跑时
    偶发不够（实测 5 次全套 1 次红），断言读到 0 条就误报。现在等"投递成功"这个**结果**。
  */
  assert.ok(await waitUntil(async () => await alertDelivered(order.id)), '投递应结算完成');
  const alerts = sent.filter((s) => s.body.type === 'order.pool_empty');
  assert.equal(alerts.length, 1, '托管落定即告警（无需卖家去看面板）');
  assert.equal(alerts[0].body.orderId, order.id);

  // 幂等重放（事件重扫 changed=0）：不得再次推送。
  // 这里**不需要**任何等待：`changed === 0` ⇒ `applyEventCore` 根本不会压入 afterCommit，
  // 而本用例此刻没有别的告警在途 —— 少一个"等多久"的拍脑袋数字，就少一处 flaky。
  sent.length = 0;
  assert.equal(await applyEvent('OrderCreated', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 3 }), 0);
  assert.equal(sent.filter((s) => s.body.type === 'order.pool_empty').length, 0);
});

/**
 * 投递失败不得把幂等标记写死（2026-09 修复）。
 * 旧实现是「先写 kv 里的 ackKey 再 notifyRaw(...)」：URL 写错 / 被 SSRF 拦下 / 店主服务器 5xx /
 * 超时，标记都已写死 ⇒ **永远不会**重试，而这条告警是"买家钱已上链、卖家却无货可交"。
 * 现在幂等标记是 order_alerts 的一行（主键 (order_id, kind) 去重，见 src/alertAck.js），
 * 只在投递成功后写：失败 ⇒ 行被删掉 ⇒ 下一轮复查仍会投（at-least-once）。
 */
test('投递失败不写幂等标记（下一轮仍会重试）；投递成功才写标记且不再重复告警', async () => {
  const p = await listProduct(productPayload({ title: '告警失败重试数字商品', autoDeliver: 0 }));
  const d = await createDraft(p.slug);
  await escrowed(d);
  // 幂等标记是 order_alerts 的一行（主键 (order_id, kind) 去重，见 src/alertAck.js）
  const flagOf = async () => !!(await db.get('SELECT 1 AS one FROM order_alerts WHERE order_id = ? AND kind = ?', await orderIdOf(d.id), 'pool_empty'));

  // 1) 总是失败的发送器（等价于 URL 写错 / 被 SSRF 拦下 / 店主服务器 500 / 超时）
  let attempts = 0;
  setWebhookSender(async () => {
    attempts += 1;
    throw new Error('connect ECONNREFUSED');
  });
  sent.length = 0;
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(d.id)), true, '本次已发起投递');
  assert.ok(await waitUntil(() => attempts === 3), '投递方重试 2 次（共 3 次尝试）后结算失败');
  /*
    "第 3 次尝试抛错"与"预占行已被删掉"是**两个时刻**：释放发生在投递 promise 结算之后的
    `.then` 里（`alertAck` 的失败分支要 await 一条 DELETE）。断言必须等**那个事实**落定，
    而不是等重试计数——后者在整套并行跑时会先到（实测：全量跑红、单跑绿）。
    等的仍然是"标记必须消失"这件事本身，只是给它一个有界的收敛窗口（同 `waitUntil` 的一贯理由）。
  */
  assert.ok(await waitUntil(async () => !(await flagOf())), '投递失败：不得写幂等标记（写死 = 店主永远收不到这条告警）');

  // 2) 下一轮复查（同一入口，如 watcher 再扫一遍）：没写标记 ⇒ 仍会投递 —— 这就是 at-least-once
  sent.length = 0;
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(d.id)), true, '没写标记 → 下一轮仍会重试投递');
  assert.ok(await waitUntil(() => attempts === 6), '第二轮同样重试到结算');
  assert.ok(await waitUntil(async () => !(await flagOf())), '仍未送达 ⇒ 仍未写标记');

  // 3) 店主服务器恢复：投递成功 ⇒ 写标记；此后再调用不再重复告警
  setWebhookSender(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  });
  sent.length = 0;
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(d.id)), true, '仍未成功送达 ⇒ 再投一次');
  assert.ok(await waitUntil(() => sent.length === 1), '这次送达了');
  assert.ok(await waitUntil(flagOf), '投递成功后才写幂等标记');
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(d.id)), false, '已成功告警过：不再重复推');
  await flushDeliveries();
  assert.equal(sent.length, 1, '第二次调用不得再发');
});

test('投递未结算期间的重复调用不重复推（paid 快路径与 watcher 事件同一单并发）', async () => {
  const p = await listProduct(productPayload({ title: '告警并发去重数字商品', autoDeliver: 0 }));
  const d = await createDraft(p.slug);
  await escrowed(d);
  const flagOf = async () => !!(await db.get('SELECT 1 AS one FROM order_alerts WHERE order_id = ? AND kind = ?', await orderIdOf(d.id), 'pool_empty'));

  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  setWebhookSender(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    await gate; // 挂住投递：模拟店主服务器响应慢
    return { ok: true, status: 200 };
  });
  sent.length = 0;
  const claimAt = async () =>
    (await db.get('SELECT sent_at FROM order_alerts WHERE order_id = ? AND kind = ?', await orderIdOf(d.id), 'pool_empty'))?.sent_at ?? null;
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(d.id)), true, '首次发起');
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(d.id)), false, '投递进行中：不再推第二条');
  /*
    去重判据是**预占行**（`alertAck.js` 的"先预占、失败再释放"），所以投递还在路上时这一行**已经在了**
    ——"标记只在成功后写"那条承诺的可观察半边是"失败 ⇒ 行被删掉 ⇒ 下一轮重投"（见上一条用例）；
    "送达"写的是同一行上的 `sent_at`。旧断言（此刻行为空）守的是"预占不存在"这个实现细节，
    在预占形状下必然为假。这里改成守**新形状的两个实测点**，比原来更硬：
      ① 行已在 ⇒ 并发的重复调用推不出第二条（就是上一行那条断言）；
      ② `sent_at` 是**结算之后**才改写的那个时刻——只写了预占就当成送达，正是这条告警最不能出的错。
  */
  const claim = await claimAt();
  assert.ok(claim instanceof Date, '投递进行中：预占行已在（它就是"不再推第二条"的判据）');
  await new Promise((r) => setTimeout(r, 30)); // 让"预占时刻"与"送达时刻"在 DATETIME(3) 上可分辨
  release();
  /*
    等的是"送达时刻真的被改写"这个事实（有界轮询）——**不能等行出现**：预占形状下那一行本来就在，
    等它等于立刻返回，随后读到的是**预占时刻**（实测：全量并行跑时这一条会红）。
  */
  const claimMs = claim.getTime();
  await waitUntil(async () => (await claimAt())?.getTime() > claimMs);
  const delivered = await claimAt();
  assert.ok(
    delivered.getTime() > claimMs,
    'sent_at 是投递结算之后才改写的那个时刻（预占时刻不是送达时刻）'
  );
  assert.equal(sent.length, 1, '整个过程只推了一条');
  assert.equal(await alertPoolEmptyForOrder(await orderIdOf(d.id)), false, '已有标记：不再推');
  await flushDeliveries();
  assert.equal(sent.length, 1);
});
