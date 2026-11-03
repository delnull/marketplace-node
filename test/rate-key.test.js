/**
 * 限流键必须是**路由形状**，不能是实际 URL：否则换一个订单号就换一个桶，匿名防刷失效。
 * 这里直接驱动 simpleRateLimit，用假 Redis 记录 INCR 键。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// 只为 db-isolation 的“库名先于业务模块”契约：http 会间接 import shops/db。
import './setup.mjs';
import { simpleRateLimit } from '../src/http.js';
import { __setRedisClientForTest } from '../src/redis.js';

test('限流键按方法 + 路由形状，不按实际订单号分桶', async () => {
  const keys = [];
  __setRedisClientForTest({
    isReady: true,
    on() {},
    async eval(_script, { keys: ks = [] } = {}) {
      keys.push(String(ks[0] || ''));
      return [1, 60_000];
    },
  });
  const mw = simpleRateLimit({ windowMs: 60_000, max: 10 });
  const run = (id) => new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      baseUrl: '/api/orders',
      route: { path: '/:id' },
      path: `/api/orders/${id}`,
      headers: {},
      ip: '203.0.113.7',
    };
    const res = { setHeader() {}, status() { return this; }, json() {} };
    mw(req, res, resolve);
    setTimeout(() => reject(new Error('middleware 未调用 next')), 500);
  });
  await run('A');
  await run('B');
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], '不同订单号必须落在同一个限流桶');
  assert.match(keys[0], /GET \/api\/orders\/:id/);
  assert.doesNotMatch(keys[0], /orders\/A/);
});
