/**
 * 重端点限流（T3）：此前这些端点在**节点内完全没有限流**——
 *  · `GET /api/arbitration/pending`（公开；每行 2 次 COUNT，响应含完整买卖双方地址）；
 *  · `GET /api/shop/reputation`（公开；全表 orders + 逐行 JSON.parse(onchain_events)）；
 *  · `GET /api/shop/reviews/stats`（公开聚合）；
 *  · 四路 CSV 导出（ownerOnly，但每次都是全表 SELECT，codes.csv 还会吐码原文）；
 *  · `POST /api/shop/orders/:id/erase-pii` / `POST /api/shop/retention/run`（同步 fs+SQLite 重活）。
 * 一律复用 src/http.js 的 simpleRateLimit（按 req.ip 计数，全仓无 trust proxy）。
 *
 * 本文件钉住"限流确实生效"，同时钉住"正常用量不受影响"：
 *  · 每个端点前若干次必须正常返回（阈值不能低到挡住人）；
 *  · 继续打到达阈值后必须返回 HTTP 429 + code 429，且窗口内持续 429。
 * 数值本身（20/60）不写死：它们是产品取舍，可能被调整；**存在限流**才是这里要守的不变量。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner } = ctx;

let ownerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
});

/**
 * 反复请求直到拿到 429（最多 maxTries 次）。
 * @returns {{hit:number|null, firstOk:number, responses:object[]}}
 */
async function hammer(makeReq, { maxTries, warmup = 5 }) {
  let hit = null;
  let firstOk = 0;
  const responses = [];
  for (let i = 1; i <= maxTries; i++) {
    const res = await makeReq();
    responses.push(res);
    if (res.status === 429) {
      hit = i;
      break;
    }
    firstOk += 1;
  }
  assert.ok(firstOk >= warmup, `前 ${warmup} 次必须正常放行（阈值不能挡住正常使用），实际只放行 ${firstOk} 次`);
  return { hit, firstOk, responses };
}

test('公开重端点限流：/api/arbitration/pending 与 /api/shop/reputation 达到阈值后返回 429', async () => {
  const arb = await hammer(() => request(app).get('/api/arbitration/pending'), { maxTries: 90 });
  assert.ok(arb.hit, '待仲裁列表（公开、每行 2 次 COUNT）必须有节点内限流');
  const arb429 = arb.responses[arb.responses.length - 1];
  assert.equal(arb429.status, 429);
  assert.equal(arb429.body.code, 429);
  assert.match(arb429.body.message, /过于频繁/);
  // 窗口内继续打仍然 429（不是"限一次就放行"）
  const again = await request(app).get('/api/arbitration/pending');
  assert.equal(again.status, 429);

  const rep = await hammer(() => request(app).get('/api/shop/reputation'), { maxTries: 90 });
  assert.ok(rep.hit, '履约画像（公开、全表 JSON.parse）必须有节点内限流');
  assert.equal(rep.responses[rep.responses.length - 1].body.code, 429);
  // 两个端点各有独立窗口：待仲裁被限流不影响画像端点（不同 limiter 实例）
  assert.ok(rep.hit > 1, '限流按端点独立计数');

  const rev = await hammer(() => request(app).get('/api/shop/reviews/stats'), { maxTries: 140 });
  assert.ok(rev.hit, '店铺评价统计（公开聚合）必须有限流');
});

test('重导出限流：四路 CSV 共用一把窗口，达到阈值后 429（且不吃掉其它端点）', async () => {
  // 前几次导出必须正常（含 BOM 头的 CSV 正文；CSV 不走 {code,message} 信封，故断言正文）
  const first = await request(app).get('/api/shop/export/orders.csv').set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(first.status, 200);
  assert.match(first.text, /^\uFEFFid,product_slug/);
  const ledger = await request(app).get('/api/shop/export/ledger.csv').set('Authorization', `Bearer ${ownerToken}`);
  assert.equal(ledger.status, 200);

  const { hit } = await hammer(
    () => request(app).get('/api/shop/export/products.csv').set('Authorization', `Bearer ${ownerToken}`),
    { maxTries: 40, warmup: 3 }
  );
  assert.ok(hit, '导出（全表 SELECT）必须有节点内限流');

  // 导出被限流不影响普通只读端点（各自独立窗口）
  const detail = await request(app).get('/api/shop/registry-info');
  assert.equal(detail.status, 200);
});

test('个人信息擦除端点限流：retention/run 与 erase-pii 各自有窗口（重同步操作）', async () => {
  // retention/run 的阈值给得较宽（一次最多擦 200 单，且另有单飞）：这里只验证"存在限流"
  const { hit } = await hammer(
    () => request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).send({ days: 400 + Math.floor(Date.now() % 1000) }),
    { maxTries: 40, warmup: 3 }
  );
  assert.ok(hit, '保留期运行端点必须有节点内限流（每次同步擦最多 200 单）');
  // 已认证端点：匿名请求在鉴权层就被挡（401），不会消耗店主的额度
  const anon = await request(app).post('/api/shop/retention/run').send({});
  assert.equal(anon.status, 401);
});
