/**
 * 上传字节额度的**Redis 预留内核**。
 *
 * 预留必须在开始读请求体之前原子完成；Redis Lua 保证多后端并发请求不会都读到旧合计。
 * 这里用假 Redis 走同一套 eval 路径（不是生产回退）：判上限、下调、释放、窗口过期。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __setRedisClientForTest } from '../src/redis.js';
import { createFakeRedis } from './fakeRedis.mjs';
import { reserveUploadBytes, commitUploadBytes, releaseUploadBytes } from '../src/uploadBudget.js';

__setRedisClientForTest(createFakeRedis());

const LIMIT = 100;
const WINDOW = 1_000;

test('预留是原子判据：并发的第二笔不可能越过上限', async () => {
  const a = await reserveUploadBytes('alice', 60, LIMIT, WINDOW);
  assert.equal(a.ok, true);
  const c = await reserveUploadBytes('alice', 60, LIMIT, WINDOW);
  assert.equal(c.ok, false, '60 + 60 > 100，第二笔必须失败');
  assert.equal(c.used, 60, '被拒的预留不得留下占位');
  // 别人的额度不受影响
  assert.equal((await reserveUploadBytes('bob', 100, LIMIT, WINDOW)).ok, true);
});

test('commit 下调为实际字节；只减不增，异常大的实际值被夹在预留内', async () => {
  const r = await reserveUploadBytes('carol', 80, LIMIT, WINDOW);
  assert.equal(r.ok, true);
  await commitUploadBytes(r.reservation, 10);
  assert.equal((await reserveUploadBytes('carol', 90, LIMIT, WINDOW)).ok, true, '10 + 90 = 100 恰好允许');
  assert.equal((await reserveUploadBytes('carol', 1, LIMIT, WINDOW)).ok, false);

  const r2 = await reserveUploadBytes('dave', 40, LIMIT, WINDOW);
  await commitUploadBytes(r2.reservation, 9_999);
  const r3 = await reserveUploadBytes('dave', 60, LIMIT, WINDOW);
  assert.equal(r3.ok, true, '实际值再大也只能占预留的 40，剩余 60 仍可用');
});

test('release 全额归还；失败的上传不吃额度', async () => {
  const r = await reserveUploadBytes('erin', 100, LIMIT, WINDOW);
  assert.equal((await reserveUploadBytes('erin', 1, LIMIT, WINDOW)).ok, false);
  await releaseUploadBytes(r.reservation);
  assert.equal((await reserveUploadBytes('erin', 100, LIMIT, WINDOW)).ok, true);
});

test('窗口过期后额度自动归零（TTL 由 Redis 负责）', async () => {
  const r = await reserveUploadBytes('frank', 100, LIMIT, 20);
  assert.equal(r.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await reserveUploadBytes('frank', 100, LIMIT, WINDOW)).ok, true);
});

test('参数防线：限定额/预留字节非法时响亮失败', async () => {
  for (const bad of [0, -1, NaN, undefined, 'abc']) {
    await assert.rejects(() => reserveUploadBytes('alice', bad, LIMIT, WINDOW), /bytes/);
  }
  await assert.rejects(() => reserveUploadBytes('alice', 1, 0, WINDOW), /limitBytes/);
});
