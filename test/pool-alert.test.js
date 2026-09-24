/**
 * 池式商品「已收款但无货可交」主动告警（order.pool_empty）单测：
 *  - 判定口径与卖家面板 poolEmpty **同一实现**（poolShortfallOf/isPoolEmpty）；
 *  - 托管落定（watcher 的 OrderCreated 分支；paid 快路径调同一函数）后池内资源不足 → 推店主；
 *  - 每单至多一次（kv 标记）；池子够 / 非池式 / 已交付的行不告警；
 *  - payload 无 PII（只有订单号/链上单号/原因）；
 *  - 2026-09 修复：幂等标记**只在投递成功后**才写（投递失败/未配置通知地址 ⇒ 不写，下一轮复查
 *    仍会重试，见 src/alertAck.js）；投递未结算期间的重复调用不重复推。
 *
 * 说明：poolEmpty 面板字段的既有行为由 stock.test.js 覆盖（本文件只补"主动告警"这一侧）；
 * paid 路由（POST /:id/paid）的成功路径需要链上收据桩，本仓库未提供该注入点，
 * 故其"调用同一函数"由代码审查保证（见 routes/orders.js 的 alertPoolEmptyForOrder 调用点）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

// 重试退避调小（运维参数，config 顶层求值时读取——须在 makeCtx 之前设置）
process.env.MK_WEBHOOK_RETRY_MS = '20';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

// 通知走同一套 webhook（URL 存 kv；注入捕获型 sender）
const { kvSet } = await import('../src/db.js');
kvSet('mk:webhook_url', 'https://93.184.216.34/hook/pool');
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
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  return pred();
}

const NFT_CONTRACT = '0x' + '9'.repeat(40);
const nftPayload = (overrides = {}) => ({
  title: '告警测试 NFT',
  description: 'NFT 池缺货告警单测商品。',
  images: ['https://example.com/n.jpg'],
  kind: 'nft',
  nftContract: NFT_CONTRACT,
  specs: [],
  skus: [{ key: '', priceCnyFen: 6600, capacity: null }],
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
const rowOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const statusOf = (id) => rowOf(id).status;

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug, extra = {}) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slug, ...extra })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 本地镜像"买家已托管"（链上校验不在单测范围，仅置状态与凭证） */
function escrowed(order) {
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), order.id);
}

async function importCodes(slug, codes) {
  const res = await request(app).post(`/api/products/${slug}/codes`).set('Authorization', `Bearer ${ownerToken}`).send({ codes }).expect(200);
  assertOk(res);
}

async function importTokens(slug, tokens) {
  const res = await request(app).post(`/api/products/${slug}/tokens`).set('Authorization', `Bearer ${ownerToken}`).send({ tokens }).expect(200);
  assertOk(res);
}

test('poolShortfallOf/isPoolEmpty：与卖家面板 poolEmpty 同口径（数字按 quantity、NFT 扣已交付、实物与非托管态不成立）', async () => {
  // autoDeliver=0：本用例只验判定口径，不被"补货即自动补发"改变订单状态
  const p = await listProduct(productPayload({ title: '缺货告警数字商品', autoDeliver: 0 }));
  const d = await createDraft(p.slug);
  escrowed(d);
  // 未建池 = 可用 0 → 缺货
  assert.deepEqual(poolShortfallOf(rowOf(d.id)), { poolBacked: true, kind: 'digital', need: 1, available: 0, short: true });
  assert.equal(isPoolEmpty(rowOf(d.id)), true);
  // 面板字段与之一致（同一实现的消费方）
  const detail = await request(app).get(`/api/orders/${d.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(detail);
  assert.equal(detail.body.data.poolEmpty, true);
  // 导入 1 个码 → 够本单，不再缺
  await importCodes(p.slug, ['ALERT-1']);
  assert.equal(isPoolEmpty(rowOf(d.id)), false);
  const detailFull = await request(app).get(`/api/orders/${d.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.equal(detailFull.body.data.poolEmpty, false);

  // 多件订单：需求 = quantity（草稿先建、货后补，故此处才建 2 件的单）
  const p2 = await listProduct(productPayload({ title: '缺货告警数字商品2', autoDeliver: 0 }));
  const d2 = await createDraft(p2.slug, { quantity: 2 });
  escrowed(d2);
  await importCodes(p2.slug, ['ALERT-2']);
  const s2 = poolShortfallOf(rowOf(d2.id));
  assert.equal(s2.need, 2);
  assert.equal(s2.available, 1);
  assert.equal(s2.short, true, '需 2 个只有 1 个 → 仍缺');

  // NFT：需求 = quantity − 已交付行数（分批交付）
  const n = await listProduct(nftPayload());
  const dn = await createDraft(n.slug, { quantity: 2 });
  escrowed(dn);
  assert.equal(poolShortfallOf(rowOf(dn.id)).need, 2, '未交付时需求 = quantity');
  await importTokens(n.slug, ['42']);
  assert.equal(poolShortfallOf(rowOf(dn.id)).short, true, '1 枚 tokenId 不够 2 件');
  db.prepare("INSERT INTO order_delivery_items (order_id, kind, value, tx_hash, created_at) VALUES (?, 'nft', '7', NULL, ?)")
    .run(dn.id, Date.now());
  const filled = poolShortfallOf(rowOf(dn.id));
  assert.equal(filled.need, 1, '已交付 1 枚：剩余需求 1');
  assert.equal(filled.available, 1);
  assert.equal(filled.short, false);

  // 实物：非池式，恒不成立
  const ph = await listProduct(productPayload({ kind: 'physical', title: '告警对照实物', capacity: 3 }));
  const dp = await createDraft(ph.slug);
  escrowed(dp);
  assert.equal(poolShortfallOf(rowOf(dp.id)).poolBacked, false);

  // 非 escrowed（已交付）：池语义不适用
  db.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(d.id);
  assert.equal(poolShortfallOf(rowOf(d.id)).poolBacked, false);
  assert.equal(statusOf(d.id), 'shipped');
});

test('alertPoolEmptyForOrder：池空每单只告警一次；payload 无 PII；池够/已交付不告警', async () => {
  const p = await listProduct(productPayload({ title: '告警发送数字商品', autoDeliver: 0 }));
  const d = await createDraft(p.slug);
  escrowed(d);

  sent.length = 0;
  assert.equal(alertPoolEmptyForOrder(d.id), true, '本地 id 命中并发告警');
  await flushDeliveries();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.type, 'order.pool_empty');
  assert.equal(sent[0].body.orderId, d.id);
  assert.equal(sent[0].body.escrowOrderId, d.escrowOrderId);
  assert.match(sent[0].body.reason, /仍需 1 个/);
  assert.match(sent[0].body.reason, /补货|退款/);
  for (const k of ['address', 'shipping', 'buyer', 'note', 'phone', 'name', 'tracking']) {
    assert.ok(!(k in sent[0].body), `payload 不应含 ${k}`);
  }

  // 第二次：kv 标记拦住（池空是持续状态，每轮轮询都推会把店主的机器人刷爆）
  assert.equal(alertPoolEmptyForOrder(d.id), false);
  await flushDeliveries();
  assert.equal(sent.length, 1);

  // watcher 路径按链上单号定位：重置标记后可再发一次（证明两种入参都能命中）
  resetPoolAlertFlag(d.id);
  assert.equal(alertPoolEmptyForOrder(d.escrowOrderId), true);
  await flushDeliveries();
  assert.equal(sent.length, 2);

  // 池子够：不告警
  const full = await listProduct(productPayload({ title: '告警不发数字商品', autoDeliver: 0 }));
  await importCodes(full.slug, ['FULL-1']);
  const df = await createDraft(full.slug);
  escrowed(df);
  assert.equal(alertPoolEmptyForOrder(df.id), false);
  // 已交付（非 escrowed）：不告警
  db.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(df.id);
  resetPoolAlertFlag(df.id);
  assert.equal(alertPoolEmptyForOrder(df.id), false);
  await flushDeliveries();
  assert.equal(sent.length, 2, '以上两种情形都不发');
});

test('watcher 路径：OrderCreated 回写为 escrowed 时池内不足 → 自动告警一次（重复事件不再发）', async () => {
  const p = await listProduct(productPayload({ title: '告警 watcher 商品', autoDeliver: 0 }));
  const order = await createDraft(p.slug);
  sent.length = 0;
  // 本地 draft + 链上 OrderCreated：状态推进与告警同一条事件路径（applyEvent 的 afterCommit）
  assert.equal(applyEvent('OrderCreated', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 3 }), 1);
  assert.equal(statusOf(order.id), 'escrowed');
  await flushDeliveries();
  const alerts = sent.filter((s) => s.body.type === 'order.pool_empty');
  assert.equal(alerts.length, 1, '托管落定即告警（无需卖家去看面板）');
  assert.equal(alerts[0].body.orderId, order.id);

  // 幂等重放（事件重扫 changed=0）：不得再次推送
  sent.length = 0;
  assert.equal(applyEvent('OrderCreated', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 3 }), 0);
  await flushDeliveries();
  assert.equal(sent.filter((s) => s.body.type === 'order.pool_empty').length, 0);
});

/**
 * 投递失败不得把幂等标记写死（2026-09 修复）。
 * 原实现是「先 kvSet(ackKey,'1') 再 notifyRaw(...)」：URL 写错 / 被 SSRF 拦下 / 店主服务器 5xx /
 * 超时，标记都已写死 ⇒ **永远不会**重试，而这条告警是"买家钱已上链、卖家却无货可交"。
 * 现在标记只在投递成功后写（见 src/alertAck.js）：失败 ⇒ 不写 ⇒ 下一轮复查仍会投（at-least-once）。
 */
test('投递失败不写幂等标记（下一轮仍会重试）；投递成功才写标记且不再重复告警', async () => {
  const p = await listProduct(productPayload({ title: '告警失败重试数字商品', autoDeliver: 0 }));
  const d = await createDraft(p.slug);
  escrowed(d);
  // 键前缀见 poolAlert.js 的 ALERT_KEY_PREFIX（此处按值断言，不让用例与实现自证）
  const ackKey = `mk:order_pool_empty:${d.id}`;
  const flagOf = () => (db.prepare('SELECT value FROM kv WHERE key = ?').get(ackKey) || {}).value ?? '';

  // 1) 总是失败的发送器（等价于 URL 写错 / 被 SSRF 拦下 / 店主服务器 500 / 超时）
  let attempts = 0;
  setWebhookSender(async () => {
    attempts += 1;
    throw new Error('connect ECONNREFUSED');
  });
  sent.length = 0;
  assert.equal(alertPoolEmptyForOrder(d.id), true, '本次已发起投递');
  assert.ok(await waitUntil(() => attempts === 3), '投递方重试 2 次（共 3 次尝试）后结算失败');
  assert.equal(flagOf(), '', '投递失败：不得写幂等标记（写死 = 店主永远收不到这条告警）');

  // 2) 下一轮复查（同一入口，如 watcher 再扫一遍）：没写标记 ⇒ 仍会投递 —— 这就是 at-least-once
  sent.length = 0;
  assert.equal(alertPoolEmptyForOrder(d.id), true, '没写标记 → 下一轮仍会重试投递');
  assert.ok(await waitUntil(() => attempts === 6), '第二轮同样重试到结算');
  assert.equal(flagOf(), '', '仍未送达 ⇒ 仍未写标记');

  // 3) 店主服务器恢复：投递成功 ⇒ 写标记；此后再调用不再重复告警
  setWebhookSender(async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  });
  sent.length = 0;
  assert.equal(alertPoolEmptyForOrder(d.id), true, '仍未成功送达 ⇒ 再投一次');
  assert.ok(await waitUntil(() => sent.length === 1), '这次送达了');
  assert.ok(await waitUntil(() => flagOf() === '1'), '投递成功后才写幂等标记');
  assert.equal(alertPoolEmptyForOrder(d.id), false, '已成功告警过：不再重复推');
  await flushDeliveries();
  assert.equal(sent.length, 1, '第二次调用不得再发');
});

test('投递未结算期间的重复调用不重复推（paid 快路径与 watcher 事件同一单并发）', async () => {
  const p = await listProduct(productPayload({ title: '告警并发去重数字商品', autoDeliver: 0 }));
  const d = await createDraft(p.slug);
  escrowed(d);
  const ackKey = `mk:order_pool_empty:${d.id}`;
  const flagOf = () => (db.prepare('SELECT value FROM kv WHERE key = ?').get(ackKey) || {}).value ?? '';

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
  assert.equal(alertPoolEmptyForOrder(d.id), true, '首次发起');
  assert.equal(alertPoolEmptyForOrder(d.id), false, '投递进行中：不再推第二条');
  assert.equal(flagOf(), '', '尚未结算：标记还没写（标记只在成功后写）');
  release();
  assert.ok(await waitUntil(() => flagOf() === '1'), '结算成功后才写标记');
  assert.equal(sent.length, 1, '整个过程只推了一条');
  assert.equal(alertPoolEmptyForOrder(d.id), false, '已有标记：不再推');
  await flushDeliveries();
  assert.equal(sent.length, 1);
});
