/**
 * 后台任务分布式锁：同一时刻只有一个进程能执行扫描；任务抛错也必须释放锁。
 * 测试用内存假 Redis 走真实的 SET NX PX + Lua 释放调用路径（生产协议同形）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { __setRedisClientForTest, withRedisLock } from '../src/redis.js';
import { createFakeRedis } from './fakeRedis.mjs';

after(() => __setRedisClientForTest(createFakeRedis()));

test('分布式锁：同名锁互斥；任务结束/抛错后释放', async () => {
  __setRedisClientForTest(createFakeRedis());
  let concurrent = false;
  const first = await withRedisLock('test-job', 10_000, async () => {
    concurrent = true;
    const second = await withRedisLock('test-job', 10_000, async () => 'nested');
    assert.equal(second.acquired, false);
    return 'first';
  });
  assert.deepEqual(first, { acquired: true, value: 'first' });
  assert.equal(concurrent, true);

  await assert.rejects(
    withRedisLock('test-job', 10_000, async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  const afterFailure = await withRedisLock('test-job', 10_000, async () => 'after');
  assert.deepEqual(afterFailure, { acquired: true, value: 'after' });
});

test('分布式锁：Redis 故障 fail-closed，不执行任务', async () => {
  __setRedisClientForTest({
    isReady: true,
    async set() {
      const e = new Error('redis down');
      e.code = 'REDIS_UNAVAILABLE';
      throw e;
    },
    async eval() {
      return 0;
    },
  });
  let ran = false;
  await assert.rejects(
    withRedisLock('test-job', 10_000, async () => {
      ran = true;
    }),
    /redis down/
  );
  assert.equal(ran, false);
});
