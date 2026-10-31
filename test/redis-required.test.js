/**
 * Redis 是硬依赖，不是可选缓存：限流计数失败时必须 fail-closed，不能回退进程内 Map。
 *
 * 生产代码没有内存分支；这里注入一个"连得上但 INCR 失败"的客户端，确认请求得到 503
 * 而不是被放行。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { __setRedisClientForTest } = await import('../src/redis.js');
const { createFakeRedis } = await import('./fakeRedis.mjs');

after(() => __setRedisClientForTest(createFakeRedis()));

test('Redis 计数失败：限流入口 503，不回退内存放行', async () => {
  __setRedisClientForTest({
    isReady: true,
    on() {},
    async incr() { throw new Error('redis down'); },
    async pExpire() {},
    async pTTL() { return 60_000; },
  });
  const r1 = await ctx.request(ctx.app).get('/api/shop/payment-methods');
  assert.equal(r1.status, 503);
  assert.equal(r1.body.code, 503);
  const r2 = await ctx.request(ctx.app).get('/api/shop/payment-methods');
  assert.equal(r2.status, 503, '第二次仍必须失败，不能因为"内存里没计数"而放行');
});
