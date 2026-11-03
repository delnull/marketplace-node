/**
 * 认证卫生项：nonce/login 匿名接口限流（防验签滥用）。
 *
 * SIWE 挑战现在住 Redis（`SET NX PX`），过期由 TTL 自动完成，不再有"清理过期 nonce"
 * 的定时器/表；防覆盖与一次性消费由 Redis 原子命令保证（见 auth.js / redis.js）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;
const addr = Wallet.createRandom().address;

test('GET /api/auth/nonce 超过窗口上限（120/分/IP）后返回 429', async () => {
  let lastCode = 0;
  for (let i = 0; i < 122; i++) {
    const res = await request(app).get(`/api/auth/nonce?address=${addr}`);
    lastCode = res.status;
    if (res.status === 429) break;
    assertOk(res);
  }
  assert.equal(lastCode, 429, '超出限流窗口应被拒绝');
  // 429 响应体为统一 {code,message}
  const check = await request(app).get(`/api/auth/nonce?address=${addr}`).expect(429);
  assert.notEqual(check.body.code, 0);
  assert.match(check.body.message || '', /频繁/);
});
