/**
 * 下单风控闸（可选、默认关闭）单测：
 *  - 默认关闭：未配置 URL 时建单行为与从前完全一致（草稿照建、零外呼）；
 *  - 放行：{allow:true} → 建单成功，且发给风控服务的 payload 只含交易要素（无收货信息/备注/发票）；
 *  - 拒单：{allow:false,reason} → HTTP 403 + 理由透传 + **无订单行、不占库存**；
 *  - fail-closed：不可达/超时/非 JSON/非 200/allow 缺失一律拒单（含实际 HTTP 状态），清空 URL 即恢复；
 *  - SSRF：内网字面量与「域名解析到内网」都拒单且不外呼（每次校验，URL 运行期可改）；
 *  - 签名：配置 secret 才有 x-mk-signature，且等于请求体原文的 HMAC-SHA256（与 webhook 同方案）。
 *
 * 全程用 setOrderGateSender 注入 sender 捕获请求——单测禁网，真实网络路径不在覆盖范围。
 * 注意：风控三键都是 getter（动态读取），用例内可直接改 env；每个用例用完恢复。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { makeCtx, login, assertOk, productPayload, skuInv } from './setup.mjs';

// 先清干净：保证"默认关闭"是真的默认（本机 env 残留不应影响判定）
delete process.env.MK_ORDER_GATE_URL;
delete process.env.MK_ORDER_GATE_SECRET;
delete process.env.MK_ORDER_GATE_TIMEOUT_MS;

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const { setOrderGateSender, resetOrderGate, checkOrderGate, orderGateEnabled } = await import('../src/orderGate.js');
const { setLookupAll } = await import('../src/netguard.js');

/** 公网字面量地址（免 DNS；与 webhook.test.js 同款写法） */
const GATE_URL = 'https://93.184.216.34/check';
/** netguard 的默认解析器（测试注入后必须还原，避免污染同文件后续用例） */
const defaultLookup = (h) => dns.promises.lookup(h, { all: true, verbatim: true });

let ownerToken;
let buyerToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
});

/** 捕获型 sender：记录 {url, headers, body(原始字符串), init}，应答由 responder 决定 */
const calls = [];
let responder = async () => ({ status: 200, json: async () => ({ allow: true }) });
const recordingSender = async (url, init) => {
  calls.push({ url, headers: init.headers, body: init.body, init });
  return responder(url, init);
};
setOrderGateSender(recordingSender);

/** 上架商品（owner） */
async function listProduct(payload) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(payload)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 下单（买家本人登录）；expectStatus 用于断言拒单时的 HTTP 状态 */
async function draftAttempt(slug, extra = {}, expectStatus = 200) {
  return request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slug, ...extra })
    .expect(expectStatus);
}

/** 该商品的订单行数（拒单断言：必须为 0） */
const orderCount = (slug) => db.prepare('SELECT COUNT(*) AS c FROM orders WHERE product_slug = ?').get(slug).c;

/** 断言"被风控拒单"的统一形状：HTTP 403 + 消息带前缀与原因 */
function assertGateDenied(res, patterns) {
  assert.equal(res.body.code, 403, '业务码 403');
  assert.match(res.body.message, /^本店风控未放行：/, '消息前缀说明是本店风控（不是平台/链上拒绝）');
  for (const re of patterns) assert.match(res.body.message, re);
}

// ── (a) 默认关闭 ──

test('默认关闭：未配置 URL 时建单与从前一致（草稿照建、库存照占、零外呼）', async () => {
  calls.length = 0;
  responder = async () => {
    throw new Error('未启用风控时不得有任何外呼');
  };
  assert.equal(orderGateEnabled(), false, '未配置 = 未启用');
  assert.deepEqual(await checkOrderGate({ productSlug: 'whatever' }), { ok: true }, '未启用时直接放行');

  const p = await listProduct(productPayload({ kind: 'physical', title: '风控默认关闭商品', capacity: 5 }));
  const res = await draftAttempt(p.slug);
  assertOk(res);
  assert.equal(calls.length, 0, '零开销：连一次 HTTP 调用都没有');
  assert.equal(res.body.data.status, 'draft');
  assert.ok(db.prepare('SELECT id FROM orders WHERE id = ?').get(res.body.data.id), '草稿确实落库');
  assert.equal(skuInv(db, p.slug).committed, 1, '库存照常占位（行为与从前一致）');

  // 非法 URL（拼错/缺 scheme）不算"开启"——否则会变成每次下单都被 fail-closed 拒掉的静默故障
  process.env.MK_ORDER_GATE_URL = 'gate.example.com/check';
  assert.equal(orderGateEnabled(), false, '非法 URL 一律视为未开启');
  assert.deepEqual(await checkOrderGate({ productSlug: p.slug }), { ok: true });
  delete process.env.MK_ORDER_GATE_URL;
});

// ── (b) 放行 + payload 无 PII ──

test('放行：{allow:true} 建单成功，payload 只含交易要素（收货信息/备注不外发）', async () => {
  process.env.MK_ORDER_GATE_URL = GATE_URL;
  process.env.MK_ORDER_GATE_SECRET = 'gate-test-secret';
  calls.length = 0;
  responder = async () => ({ status: 200, json: async () => ({ allow: true }) });

  const p = await listProduct(
    productPayload({ kind: 'physical', title: '风控放行商品', priceCnyFen: 8800, capacity: 5, shippingFeeCnyFen: 900 })
  );
  const res = await draftAttempt(p.slug, {
    quantity: 2,
    shipping: { name: '张三', phone: '13800138000', address: '上海市浦东新区某某路 1 号' },
    note: '买家备注：请在工作日送达',
    invoice: { needed: true, title: '某某科技有限公司', taxNo: '91310000MA1K35XXXX' },
  });
  assertOk(res);
  const draft = res.body.data;

  assert.equal(orderGateEnabled(), true);
  assert.equal(calls.length, 1, '建单前恰好问一次');
  const c = calls[0];
  assert.equal(c.url, GATE_URL);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.redirect, 'manual', '禁止跟随重定向（与 webhook 同款）');
  assert.ok(c.init.signal, '带 AbortController 信号（超时可中断）');
  /*
    接线的关键一根（2026-09 续）：**校验通过的地址必须交给发送器**。
    风控 URL 是公网字面量（GATE_URL），netguard 的字面量分支会把"它自己"放进 addresses；
    默认发送器 `pinnedGateSender` 拿它写进 socket 的 lookup。若少了这根线，默认路径就退回
    "连接时再解析一次"——被控 DNS 可以先回公网过校验、再回 127.0.0.1（DNS rebinding）。
    钉住逻辑本身的端到端证明在 pinned-request.test.js（真实本地服务器），这里只钉接线。
  */
  assert.deepEqual(c.init.addresses, ['93.184.216.34'], '校验通过的地址必须原样传给发送器（钉住）');
  assert.ok(c.init.timeoutMs > 0, '超时预算也交给发送器（默认发送器自己管定时器）');

  // 字段白名单：恰好这些键，多一个都算越界
  const body = JSON.parse(c.body);
  assert.deepEqual(Object.keys(body).sort(), [
    'amountWei',
    'at',
    'buyer',
    'cnyFen',
    'event',
    'productSlug',
    'quantity',
    'seller',
    'shippingFeeCnyFen',
    'skuKey',
  ]);
  assert.equal(body.event, 'order.gate');
  assert.equal(body.productSlug, p.slug);
  assert.equal(body.skuKey, '');
  assert.equal(body.buyer, draft.buyer);
  assert.equal(body.buyer, buyer.address.toLowerCase());
  assert.equal(body.seller, owner.address.toLowerCase());
  assert.equal(body.quantity, 2);
  assert.equal(body.cnyFen, draft.cnyFen, '锁定金额口径与订单一致（8800×2 + 900 运费）');
  assert.equal(body.cnyFen, 8800 * 2 + 900);
  assert.equal(body.shippingFeeCnyFen, 900);
  assert.equal(body.amountWei, draft.amountWei, '链上应付 wei 与订单一致');
  assert.ok(Number.isFinite(body.at));

  // PII 双查：键名不含，值里也不含（风控服务不得成为个人信息外流通道）
  for (const k of ['shipping', 'name', 'phone', 'address', 'note', 'invoice', 'age_ack']) {
    assert.ok(!(k in body), `payload 不应含 ${k}`);
  }
  const flat = JSON.stringify(body);
  for (const secret of ['张三', '13800138000', '上海市浦东新区某某路 1 号', '请在工作日送达', '某某科技有限公司', '91310000MA1K35XXXX']) {
    assert.ok(!flat.includes(secret), `payload 不得含「${secret}」`);
  }

  // 草稿照建、库存照占（放行 = 与没有风控时一致）
  assert.equal(skuInv(db, p.slug).committed, 2);
  process.env.MK_ORDER_GATE_URL = '';
  delete process.env.MK_ORDER_GATE_SECRET;
});

// ── (c) 拒单 ──

test('拒单：{allow:false,reason} → HTTP 403 + 理由透传 + 无订单行 + 不占库存', async () => {
  process.env.MK_ORDER_GATE_URL = GATE_URL;
  calls.length = 0;
  responder = async () => ({ status: 200, json: async () => ({ allow: false, reason: '该地区暂不发货（店主内部风控）' }) });

  const p = await listProduct(productPayload({ kind: 'physical', title: '风控拒单商品', capacity: 5 }));
  const res = await draftAttempt(p.slug, { quantity: 2 }, 403);
  assertGateDenied(res, [/该地区暂不发货（店主内部风控）/]);

  assert.equal(orderCount(p.slug), 0, '拒单不得留下订单行');
  assert.equal(skuInv(db, p.slug).committed, 0, '拒单不得占库存（闸在事务之前）');
  assert.equal(orderCount(p.slug), 0, '（复核）仍然没有行');

  // allow:false 但没给理由 → 通用中文文案（不能把 undefined 甩给买家）
  responder = async () => ({ status: 200, json: async () => ({ allow: false }) });
  const res2 = await draftAttempt(p.slug, {}, 403);
  assertGateDenied(res2, [/本店暂不销售该订单/]);
  assert.equal(orderCount(p.slug), 0);

  // 放行后同一商品仍可下单：拒单没把商品/库存锁死
  responder = async () => ({ status: 200, json: async () => ({ allow: true }) });
  const res3 = await draftAttempt(p.slug, { quantity: 2 });
  assertOk(res3);
  assert.equal(skuInv(db, p.slug).committed, 2);
  process.env.MK_ORDER_GATE_URL = '';
});

// ── (d) fail-closed：不可达 / 超时 ──

test('fail-closed：风控服务不可达或超时 → 拒单（清空 URL 即恢复销售）', async () => {
  process.env.MK_ORDER_GATE_URL = GATE_URL;
  const p = await listProduct(productPayload({ kind: 'physical', title: '风控不可达商品', capacity: 5 }));

  // 连接失败
  calls.length = 0;
  responder = async () => {
    throw new Error('connect ECONNREFUSED 93.184.216.34:443');
  };
  const r1 = await draftAttempt(p.slug, {}, 403);
  assertGateDenied(r1, [/风控服务不可达/, /ECONNREFUSED/]);
  assert.equal(orderCount(p.slug), 0, '风控挂了就不卖（fail-closed）');
  assert.equal(skuInv(db, p.slug).committed, 0);

  // 超时：sender 挂到注入的 signal 上，真实走 AbortController + MK_ORDER_GATE_TIMEOUT_MS
  process.env.MK_ORDER_GATE_TIMEOUT_MS = '30';
  responder = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  const t0 = Date.now();
  const r2 = await draftAttempt(p.slug, {}, 403);
  assertGateDenied(r2, [/风控服务不可达（请求超时/, /30ms/]);
  assert.ok(Date.now() - t0 >= 25, '确实等到了超时时刻才拒单');
  assert.equal(orderCount(p.slug), 0);
  delete process.env.MK_ORDER_GATE_TIMEOUT_MS;

  // 逃生通道：清空 URL = 关闭风控，立即恢复正常销售（fail-closed 的前提是店主能一键退出）
  process.env.MK_ORDER_GATE_URL = '';
  const r3 = await draftAttempt(p.slug, {});
  assertOk(r3);
  assert.equal(skuInv(db, p.slug).committed, 1);
});

// ── (e) 应答异常 ──

test('应答异常：非 JSON / 非 200 / 3xx / allow 缺失或非布尔 → 拒单并带出实际 HTTP 状态', async () => {
  process.env.MK_ORDER_GATE_URL = GATE_URL;
  const p = await listProduct(productPayload({ kind: 'physical', title: '风控应答异常商品', capacity: 5 }));
  const cases = [
    {
      name: '非 JSON 应答',
      respond: () => ({
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      }),
      patterns: [/非 JSON/, /HTTP 200/],
    },
    { name: 'HTTP 500', respond: () => ({ status: 500, json: async () => ({ allow: true }) }), patterns: [/HTTP 500/] },
    { name: 'HTTP 302 重定向', respond: () => ({ status: 302, json: async () => ({ allow: true }) }), patterns: [/HTTP 302/, /重定向/] },
    { name: 'HTTP 204 空应答', respond: () => ({ status: 204, json: async () => null }), patterns: [/HTTP 204/] },
    { name: 'allow 缺失', respond: () => ({ status: 200, json: async () => ({ ok: true }) }), patterns: [/无法识别/, /HTTP 200/] },
    { name: 'allow 非布尔（真值字符串也不认）', respond: () => ({ status: 200, json: async () => ({ allow: 'yes' }) }), patterns: [/无法识别/, /HTTP 200/] },
  ];
  for (const c of cases) {
    calls.length = 0;
    responder = c.respond;
    const res = await draftAttempt(p.slug, {}, 403);
    assertGateDenied(res, c.patterns);
    assert.equal(calls.length, 1, `${c.name}：确实问了风控服务`);
  }
  assert.equal(orderCount(p.slug), 0, '全部异常分支都不得留下订单行');
  assert.equal(skuInv(db, p.slug).committed, 0);
  process.env.MK_ORDER_GATE_URL = '';
});

// ── (f) 签名 ──

test('签名：配置 secret 才有 x-mk-signature，且为请求体原文的 HMAC-SHA256', async () => {
  process.env.MK_ORDER_GATE_URL = GATE_URL;
  responder = async () => ({ status: 200, json: async () => ({ allow: true }) });
  const p = await listProduct(productPayload({ kind: 'digital', title: '风控签名商品' }));

  // 配置 secret → 带头，且与 webhook 同一套方案（店主只需实现一个校验器）
  process.env.MK_ORDER_GATE_SECRET = 'gate-secret-1';
  calls.length = 0;
  assertOk(await draftAttempt(p.slug, {}));
  assert.equal(calls.length, 1);
  const expected = crypto.createHmac('sha256', 'gate-secret-1').update(calls[0].body).digest('hex');
  assert.equal(calls[0].headers['x-mk-signature'], expected, '签名 = HMAC-SHA256(secret, body 原文)');
  assert.match(calls[0].headers['x-mk-signature'], /^[0-9a-f]{64}$/);
  assert.equal(calls[0].headers['content-type'], 'application/json');

  // 未配置 secret → 不带该头（不能拿空密钥签一个假签名让接收端误判"已签名"）
  delete process.env.MK_ORDER_GATE_SECRET;
  calls.length = 0;
  assertOk(await draftAttempt(p.slug, {}));
  assert.equal(calls.length, 1);
  assert.ok(!('x-mk-signature' in calls[0].headers), '无密钥则不带签名头');
  process.env.MK_ORDER_GATE_URL = '';
});

// ── (g) SSRF（复用 netguard，每次校验） ──

test('SSRF：内网字面量与「解析到内网」都拒单且不外呼（URL 运行期可改，故每次重校验）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '风控 SSRF 商品', capacity: 5 }));

  // 1) 字面量内网/回环/云元数据：不需要 DNS 就能判
  for (const bad of ['http://127.0.0.1:9000/gate', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1/gate']) {
    process.env.MK_ORDER_GATE_URL = bad;
    calls.length = 0;
    const res = await draftAttempt(p.slug, {}, 403);
    assertGateDenied(res, [/风控目标校验未通过/]);
    assert.equal(calls.length, 0, `${bad} 不得产生任何外呼`);
  }

  // 2) 域名解析到内网（DNS rebinding 形态）：URL 从公网换成域名后必须重新校验
  process.env.MK_ORDER_GATE_URL = 'https://gate.example.com/check';
  setLookupAll(async () => [{ address: '10.0.0.6' }]);
  try {
    calls.length = 0;
    const res = await draftAttempt(p.slug, {}, 403);
    assertGateDenied(res, [/风控目标校验未通过/, /内网|保留/]);
    assert.equal(calls.length, 0, '解析到内网则一次都不发');
  } finally {
    setLookupAll(defaultLookup); // 还原 netguard 默认解析器（同文件后续用例不受影响）
  }

  assert.equal(orderCount(p.slug), 0);
  assert.equal(skuInv(db, p.slug).committed, 0);
  process.env.MK_ORDER_GATE_URL = '';

  // 还原注入的 sender（本文件共用）；顺带覆盖 resetOrderGate 契约：置空后未启用即直接放行
  resetOrderGate();
  assert.deepEqual(await checkOrderGate({ productSlug: p.slug }), { ok: true });
  setOrderGateSender(recordingSender);
});
