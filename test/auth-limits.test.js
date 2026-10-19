/**
 * 认证卫生项：nonce/login 匿名接口限流（防表膨胀/验签滥用）与过期 nonce 清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, assertOk, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db } = ctx;
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

test('cleanupExpiredSiwe：过期 nonce 被清理，未过期保留', async () => {
  const { issueSiwe, cleanupExpiredSiwe } = await import('../src/auth.js');
  const a = Wallet.createRandom().address.toLowerCase();
  const b = Wallet.createRandom().address.toLowerCase();
  await issueSiwe(a);
  await issueSiwe(b);
  // 把 a 的 nonce 置为已过期
  await db.run('UPDATE siwe SET expires_at = ? WHERE address = ?', new Date(Date.now() - 1000), a);
  const before = (await db.get('SELECT COUNT(*) AS c FROM siwe')).c;
  assert.ok(before >= 2, '清理前存在 nonce 行');
  const removed = await cleanupExpiredSiwe();
  assert.equal(removed, 1, '只清理过期行');
  const rowB = await db.get('SELECT * FROM siwe WHERE address = ?', b);
  assert.ok(rowB, '未过期 nonce 保留');
});
