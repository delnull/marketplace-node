/**
 * 给不建数据库的纯单元测试注入假 Redis：生产代码没有内存回退，测试用同一套命令。
 * 只设置 Redis，不碰 MySQL；需要 app/DB 的测试请用 setup.mjs。
 */
process.env.MK_REDIS_URL = process.env.MK_REDIS_URL || 'redis://test';
const { __setRedisClientForTest } = await import('../src/redis.js');
const { createFakeRedis } = await import('./fakeRedis.mjs');
__setRedisClientForTest(createFakeRedis());
