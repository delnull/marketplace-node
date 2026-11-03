/**
 * P0：**审计写失败不得让节点进程退出**。
 *
 * 旧形状有两个叠在一起的缺陷：
 *  1. 三个商品写入口（PATCH /batch、POST /:slug/codes、POST /:slug/tokens）先 `ok()` 再
 *     `await audit(...)`。`logAudit` 只在少数"调用方写错"的错上抛（shop_code 指向不存在的店、
 *     漏给归属）——那类错一旦发生，`wrap` 的 catch 会再写一次响应，抛
 *     `ERR_HTTP_HEADERS_SENT`；它发生在 catch 里，没有下一层接住 ⇒ unhandledRejection ⇒
 *     shutdown.js 的 `process.exit(1)`。一个店的审计写失败把整台节点停掉。
 *  2. `wrap` 的 catch 不判 `res.headersSent`。
 *
 * 本文件钉住两半：响应已发出时只销毁连接（不再二次写响应）；审计失败发生在响应之前，
 * 请求得到一个明确的失败（`code != 0`），而不是 200 假装成功，也不是进程退出。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;
// 业务模块必须在 makeCtx 之后动态取：config 在模块求值期固化 env（setup.mjs 头注释）
const { wrap } = await import('../src/http.js');

let ownerToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  assert.ok(ownerToken);
});

const create = async (body) => {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(body)
    .expect(200);
  assertOk(res);
  return res.body.data;
};

const asOwner = (r) =>
  r.set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value);

/**
 * 让**审计 INSERT** 抛一个 `logAudit` 会 rethrow 的错（外键缺失是它刻意不吞的那一档）。
 * 其余 SQL 原样走真实库——这个桩只改"审计"这一件事。
 */
async function withFailingAudit(fn) {
  const original = db.run;
  let attempts = 0;
  db.run = async function (sql, ...params) {
    if (/INSERT INTO audit_logs/i.test(String(sql))) {
      attempts += 1;
      const e = new Error('unit-test: 审计写入失败（模拟外键缺失）');
      e.code = 'ER_NO_REFERENCED_ROW_2';
      throw e;
    }
    return original.call(this, sql, ...params);
  };
  try {
    await fn();
  } finally {
    db.run = original;
  }
  assert.ok(attempts > 0, '前置：审计 INSERT 必须真的被调用过（否则这条用例测的不是审计失败）');
}

test('wrap：响应已发出后抛错只销毁连接，不再二次写响应', async () => {
  const calls = [];
  const res = {
    headersSent: false,
    status() {
      calls.push('status');
      return this;
    },
    json() {
      calls.push('json');
      return this;
    },
    destroy() {
      calls.push('destroy');
    },
  };
  const handler = wrap(async (_req, response) => {
    response.headersSent = true; // 模拟"已经 ok() 过"
    throw new Error('unit-test: 响应之后的异常');
  });
  const origError = console.error;
  console.error = () => {};
  try {
    handler({ method: 'GET', originalUrl: '/unit-test' }, res);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    console.error = origError;
  }
  // 只允许 destroy：再写一次响应就是 ERR_HTTP_HEADERS_SENT（旧路径会这样把进程带下去）
  assert.deepEqual(calls, ['destroy']);
});

test('审计失败：三个"响应后再审计"的入口都得到明确失败，进程不退出', async () => {
  const digital = await create(productPayload({ title: '审计失败-码池' }));
  const nft = await create(
    productPayload({
      kind: 'nft',
      title: '审计失败-token 池',
      nftContract: '0x1111111111111111111111111111111111111111',
      nftStandard: 'erc721',
    })
  );

  await withFailingAudit(async () => {
    const batch = await asOwner(request(app).patch('/api/products/batch')).send({
      slugs: [digital.slug],
      patch: { priceUsdtMicro: 90_000_000 },
    });
    assert.equal(batch.status, 200);
    assert.notEqual(batch.body.code, 0, '批量改价：审计失败必须得到明确的失败结论，而不是 200 + code:0');

    const codes = await asOwner(
      request(app).post(`/api/products/${digital.slug}/codes`)
    ).send({ codes: ['AUDIT-1', 'AUDIT-2'] });
    assert.equal(codes.status, 200);
    assert.notEqual(codes.body.code, 0, '码池导入：审计失败必须得到明确的失败结论');

    const tokens = await asOwner(
      request(app).post(`/api/products/${nft.slug}/tokens`)
    ).send({ tokens: ['1', '2'] });
    assert.equal(tokens.status, 200);
    assert.notEqual(tokens.body.code, 0, 'token 池导入：审计失败必须得到明确的失败结论');
  });

  // 进程仍然活着：还能继续服务下一个请求（若发生 unhandledRejection，测试进程已经倒了）
  const health = await request(app).get('/healthz').expect(200);
  assertOk(health);
});
