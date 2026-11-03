/**
 * 节点管理员读取**全部**店铺（含暂停接单）——节点主恢复店铺的唯一入口。
 *
 * 公开 `/api/shops` 只出在售店（暂停店在公开面按不存在处理）。如果管理面也拿这份列表，
 * 节点主把一家店暂停后，刷新页面就再也看不到它，也就没有入口恢复。
 * 本用例钉住三件事：公开面仍隐藏、无令牌拒绝、节点管理员拿到含 `listed=false` 的行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

test('节点管理员能看到暂停店；公开列表看不到，匿名调管理端点被拒', async () => {
  const token = (await login(ctx, owner)).token;
  await db.run('UPDATE shops SET listed = 0 WHERE code = ?', shopRef.value);
  try {
    const publicList = await request(app).get('/api/shops').expect(200);
    assertOk(publicList);
    assert.equal(
      publicList.body.data.shops.some((s) => s.code === shopRef.value),
      false,
      '公开列表不能列出暂停店'
    );

    const anonymous = await request(app).get('/api/shops/admin/all');
    assert.equal(anonymous.status, 401, '匿名不能读管理面全部店铺');

    const admin = await request(app)
      .get('/api/shops/admin/all')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assertOk(admin);
    const row = admin.body.data.shops.find((s) => s.code === shopRef.value);
    assert.ok(row, '节点管理员必须能看到暂停店');
    assert.equal(row.listed, false, 'listed=false 要如实下发，恢复按钮的判据不能丢');
  } finally {
    await db.run('UPDATE shops SET listed = 1 WHERE code = ?', shopRef.value);
  }
});
