/**
 * 店主自助歇业/复业：与节点管理员暂停是两条路径。
 * 关键边界：管理员暂停的店，店主不能自己恢复（否则平台风控可被绕过）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;
let token;

before(async () => {
  token = (await login(ctx, owner)).token;
});

function call(listed, reason) {
  return request(app)
    .patch('/api/shop/listing')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Mk-Shop', shopRef.value)
    .send({ listed, ...(reason ? { reason } : {}) });
}

test('店主可以歇业并复业，复业清空原因', async () => {
  const off = await call(false, '今天休息').expect(200);
  assertOk(off);
  let row = await db.get('SELECT listed, listed_reason FROM shops WHERE code = ?', shopRef.value);
  assert.equal(Number(row.listed), 0);
  assert.match(row.listed_reason, /^店主歇业：/);

  const on = await call(true).expect(200);
  assertOk(on);
  row = await db.get('SELECT listed, listed_reason FROM shops WHERE code = ?', shopRef.value);
  assert.equal(Number(row.listed), 1);
  assert.equal(row.listed_reason, '');
});

test('管理员暂停的店不能被店主自助恢复', async () => {
  await db.run("UPDATE shops SET listed = 0, listed_reason = '平台风控暂停' WHERE code = ?", shopRef.value);
  const r = await call(true).expect(403);
  assert.equal(r.body.code, 403);
  assert.match(r.body.message, /节点管理员/);
  const row = await db.get('SELECT listed FROM shops WHERE code = ?', shopRef.value);
  assert.equal(Number(row.listed), 0);
});

test('重复操作是 409，不会静默成功', async () => {
  await db.run("UPDATE shops SET listed = 1, listed_reason = '' WHERE code = ?", shopRef.value);
  const r = await call(true).expect(409);
  assert.equal(r.body.code, 409);
});
