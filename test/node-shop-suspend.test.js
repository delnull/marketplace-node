/**
 * 节点管理员暂停/恢复店铺接单。
 *
 * 判据：
 *   · 暂停必须给原因（给店主看），恢复时清空原因；
 *   · 暂停后公开目录/详情按"不接单"处理，但店主自己仍能读设置并处理在途订单；
 *   · 非节点管理员（买家）不能调用；
 *   · 动作留在**节点级**审计（shop_code NULL），节点主能在节点审计里看到。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const code = shopRef.value;
const path = `/api/shops/admin/${code}/listing`;

test('暂停店铺：原因必填、公开面隐藏、店主仍可读设置；恢复后清空原因并留审计', async () => {
  const token = (await login(ctx, owner)).token;
  const auth = { Authorization: `Bearer ${token}` };

  const admin = await request(app).get('/api/shops/admin/all').set(auth).expect(200);
  const adminRow = admin.body.data.shops.find((s) => s.code === code);
  assert.match(String(adminRow.createdAt), /^\d{4}-\d{2}-\d{2}T/, '管理面要下发开店时刻');

  const bad = await request(app).patch(path).set(auth).send({ listed: false });
  assert.equal(bad.status, 400, '暂停必须给原因');
  assert.match(String(bad.body.message), /原因/);

  const suspended = await request(app)
    .patch(path)
    .set(auth)
    .send({ listed: false, reason: '售假投诉成立' })
    .expect(200);
  assertOk(suspended);
  assert.equal(suspended.body.data.listed, false);
  assert.equal(suspended.body.data.listedReason, '售假投诉成立');

  const publicList = await request(app).get('/api/shops').expect(200);
  assert.equal(
    publicList.body.data.shops.some((s) => s.code === code),
    false,
    '暂停店不能出现在公开目录'
  );
  const publicDetail = await request(app).get(`/api/shops/${code}`).expect(200);
  assert.equal(publicDetail.body.data.listed, false, '暂停店仍可读身份，但明确标为暂停');
  assert.match(String(publicDetail.body.data.listedReason), /售假投诉成立/);

  const settings = await request(app)
    .get('/api/shop/settings')
    .set(auth)
    .set('X-Mk-Shop', code)
    .expect(200);
  assert.equal(settings.body.data.listed, false, '店主仍能读设置（处理在途订单）');
  assert.equal(settings.body.data.listedReason, '售假投诉成立', '原因必须让店主看到');

  const audit = await db.get(
    "SELECT action, shop_code, target_id, detail FROM audit_logs WHERE action = 'shop.suspend' ORDER BY id DESC LIMIT 1"
  );
  assert.ok(audit, '暂停必须留审计');
  assert.equal(audit.shop_code, null, '店铺处置是节点级动作（shop_code 为 NULL）');
  assert.equal(audit.target_id, code);

  const scoped = await request(app)
    .get(`/api/shop/audit/node?targetShop=${code}`)
    .set(auth)
    .expect(200);
  assert.ok(
    scoped.body.data.items.some((i) => i.action === 'shop.suspend' && i.targetId === code),
    '店铺详情要能按 targetShop 读到这家店的暂停记录'
  );

  const badTarget = await request(app)
    .get('/api/shop/audit/node?targetShop=not-a-code')
    .set(auth);
  assert.equal(badTarget.status, 400, 'targetShop 形状非法要 400，不把抄错的编号当成 0 条');

  const resumed = await request(app).patch(path).set(auth).send({ listed: true }).expect(200);
  assertOk(resumed);
  assert.equal(resumed.body.data.listed, true);
  assert.equal(resumed.body.data.listedReason, '', '恢复后旧原因清空');

  const visible = await request(app).get(`/api/shops/${code}`).expect(200);
  assert.equal(visible.body.data.listed, true);

  const resumeAudit = await db.get(
    "SELECT action FROM audit_logs WHERE action = 'shop.resume' ORDER BY id DESC LIMIT 1"
  );
  assert.ok(resumeAudit, '恢复也必须留审计');
});

test('非节点管理员不能暂停店铺', async () => {
  const token = (await login(ctx, buyer)).token;
  const res = await request(app)
    .patch(path)
    .set('Authorization', `Bearer ${token}`)
    .send({ listed: false, reason: '越权尝试' });
  assert.equal(res.status, 403);
});
