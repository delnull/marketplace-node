/**
 * 节点级审计 CSV 导出（hostOnly）。
 *
 * 判据：
 *   · 只出 `shop_code IS NULL` 的行——店铺级审计不属于节点主的那一份，不能混进文件；
 *   · `action` / `actor` 过滤生效（与列表同一组参数）；
 *   · `%` 之类的值由 CSV 转义处理（这里是 `detail` 的 JSON，不需要额外公式前缀，
 *     `csvEscape` 已对含逗号/引号/换行的字段加引号）；
 *   · 导出动作本身留一条节点级审计（`export.node_audit`），但不在本次文件里（先读后写）；
 *   · 非节点主 403。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const ownerToken = (await login(ctx, owner)).token;
const auth = { Authorization: `Bearer ${ownerToken}` };

test('节点级审计 CSV：hostOnly、只出节点级行、action/actor 过滤、导出留审计', async () => {
  // 一条店铺级（不应出现）+ 两条节点级（应出现）
  const shopUpdate = await request(app)
    .put('/api/shop')
    .set(auth)
    .set('X-Mk-Shop', shopRef.value)
    .send({ notice: 'CSV 测试前的店铺公告' });
  assert.equal(shopUpdate.body.code, 0, JSON.stringify(shopUpdate.body));
  const nodeUpdate = await request(app)
    .put('/api/shop/node')
    .set(auth)
    .send({ notice: 'CSV 测试节点公告' });
  assert.equal(nodeUpdate.body.code, 0, JSON.stringify(nodeUpdate.body));
  const suspend = await request(app)
    .patch(`/api/shops/admin/${shopRef.value}/listing`)
    .set(auth)
    .send({ listed: false, reason: '审计 CSV 测试' });
  assert.equal(suspend.body.code, 0, JSON.stringify(suspend.body));

  const csv = await request(app).get('/api/shop/audit/node.csv').set(auth).expect(200);
  assert.match(String(csv.headers['content-type']), /text\/csv/);
  assert.match(String(csv.headers['content-disposition']), /node-audit-/);
  const text = String(csv.text || '');
  assert.ok(text.startsWith('\uFEFFid,at,actor,actor_role,action,target_type,target_id,detail,ip\r\n'), 'CSV 头与 BOM');
  assert.ok(text.includes('node.update'));
  assert.ok(text.includes('shop.suspend'));
  assert.equal(text.includes('shop.update'), false, '店铺级审计行不属于节点级导出');

  const filtered = await request(app)
    .get('/api/shop/audit/node.csv?action=node.update')
    .set(auth)
    .expect(200);
  const filteredText = String(filtered.text || '');
  assert.ok(filteredText.includes('node.update'));
  assert.equal(filteredText.includes('shop.suspend'), false, 'action 过滤必须作用于导出');

  const byActor = await request(app)
    .get(`/api/shop/audit/node.csv?actor=${owner.address}`)
    .set(auth)
    .expect(200);
  assert.ok(String(byActor.text || '').includes('node.update'), 'actor 过滤必须作用于导出（大小写不敏感）');

  const buyerToken = (await login(ctx, buyer)).token;
  const forbidden = await request(app)
    .get('/api/shop/audit/node.csv')
    .set('Authorization', `Bearer ${buyerToken}`);
  assert.equal(forbidden.status, 403, '节点级审计导出只对节点主开放');

  const exportAudit = await db.get(
    "SELECT shop_code, detail FROM audit_logs WHERE action = 'export.node_audit' ORDER BY id DESC LIMIT 1"
  );
  assert.ok(exportAudit, '导出动作本身要留节点级审计');
  assert.equal(exportAudit.shop_code, null);
  assert.equal(typeof exportAudit.detail.rows, 'number');
});
