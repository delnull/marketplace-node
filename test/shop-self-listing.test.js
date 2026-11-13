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

/**
 * 店主面板的店铺行必须读**节点现读**的 `operatedShops`。
 *
 * 暂停店不进公开在售列表，旧前端因此拿登录回执补目录缺口——回执是登录那一刻的快照，
 * 于是歇业后仍显示"经营中"、头像还被拼丢。本用例钉住节点这一侧的事实形状：
 * 同一个钱包的同一家店，`shops`（公开）里没有它，`operatedShops` 里有且带暂停状态与头像。
 */
test('GET /api/shops：operatedShops 现读暂停状态与头像，未登录为 null', async () => {
  const avatar = `/api/uploads/${'a'.repeat(64)}.png`;
  await db.run('UPDATE shops SET avatar_url = ? WHERE code = ?', avatar, shopRef.value);
  await call(false, '今天休息').expect(200);

  const asOwner = await request(app)
    .get('/api/shops')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assertOk(asOwner);
  const row = asOwner.body.data.operatedShops.find((s) => s.code === shopRef.value);
  assert.ok(row, 'operatedShops 必须包含暂停接单的店（否则店主面板进不了自己的店）');
  assert.equal(row.listed, false, '回执/目录必须给现读的接单状态');
  assert.match(row.listedReason, /^店主歇业：/, '暂停原因随店铺行下发');
  assert.equal(row.avatarUrl, avatar, '头像等展示字段不能在这个入口丢');
  assert.equal(row.role, 'owner');
  assert.equal(
    asOwner.body.data.shops.some((s) => s.code === shopRef.value),
    false,
    '公开在售列表仍然不含暂停店（两条口径不混）'
  );

  const anon = await request(app).get('/api/shops').expect(200);
  assert.equal(anon.body.data.operatedShops, null, '没有令牌时节点不替任何人断言"你有哪些店"');

  await call(true).expect(200);
  const resumed = await request(app)
    .get('/api/shops')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  const fresh = resumed.body.data.operatedShops.find((s) => s.code === shopRef.value);
  assert.ok(fresh, '复业后 operatedShops 仍须有这家店');
  assert.equal(fresh.listed, true);
  assert.equal(fresh.listedReason, '');
});
