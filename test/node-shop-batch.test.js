/**
 * 节点管理员批量暂停/恢复店铺接单。
 *
 * 判据：
 *   · 缺一家整批不执行（404），不会留下部分状态；
 *   · 全批存在时一次改完，公开目录同步消失/恢复；
 *   · 暂停必须给原因，已在目标状态计入 unchanged；
 *   · 非 nodeAdmin 不能调用；动作逐店留节点级审计。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const secondCode = '0000TEST2';
const batchPath = '/api/shops/admin/listing';

test('批量暂停/恢复：缺一家整批拒绝；全批存在时一次改完并同步公开目录', async () => {
  const secondSeller = Wallet.createRandom().address.toLowerCase();
  await db.run(
    `INSERT INTO shops (code, seller, name, notice, listed)
     VALUES (?, ?, ?, ?, 1)`,
    secondCode,
    secondSeller,
    '批量测试二号店',
    '',
    1
  );
  const token = (await login(ctx, owner)).token;
  const auth = { Authorization: `Bearer ${token}` };

  const noReason = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ codes: [shopRef.value, secondCode], listed: false });
  assert.equal(noReason.status, 400, '批量暂停同样必须给原因');

  const missing = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ codes: [shopRef.value, 'ZZZZZZZZZ'], listed: false, reason: '批量测试' });
  assert.equal(missing.status, 404, '缺一家应整批拒绝');
  const stillListed = await request(app)
    .get('/api/shops/admin/all')
    .set(auth)
    .expect(200);
  for (const code of [shopRef.value, secondCode]) {
    const row = stillListed.body.data.shops.find((s) => s.code === code);
    assert.equal(row.listed, true, '整批拒绝时不能部分暂停');
  }

  const suspended = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ codes: [shopRef.value, secondCode], listed: false, reason: '批量违规' })
    .expect(200);
  assertOk(suspended);
  assert.deepEqual([...suspended.body.data.updated].sort(), [shopRef.value, secondCode].sort());
  assert.equal(suspended.body.data.unchanged, 0);

  const publicList = await request(app).get('/api/shops').expect(200);
  assert.equal(
    publicList.body.data.shops.some((s) => s.code === shopRef.value || s.code === secondCode),
    false,
    '批量暂停的店不能出现在公开目录'
  );

  const restored = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ codes: [shopRef.value, secondCode], listed: true })
    .expect(200);
  assertOk(restored);
  assert.deepEqual([...restored.body.data.updated].sort(), [shopRef.value, secondCode].sort());
  const publicAgain = await request(app).get('/api/shops').expect(200);
  for (const code of [shopRef.value, secondCode]) {
    assert.ok(
      publicAgain.body.data.shops.some((s) => s.code === code),
      '批量恢复后店铺应重新出现在公开目录'
    );
  }

  const audit = await db.get(
    "SELECT shop_code, detail FROM audit_logs WHERE action = 'shop.suspend' ORDER BY id DESC LIMIT 1"
  );
  assert.ok(audit, '批量暂停必须留审计');
  assert.equal(audit.shop_code, null, '店铺处置是节点级动作（shop_code 为 NULL）');
});

test('非节点管理员不能批量暂停店铺', async () => {
  const token = (await login(ctx, buyer)).token;
  const res = await request(app)
    .patch(batchPath)
    .set('Authorization', `Bearer ${token}`)
    .send({ codes: [shopRef.value], listed: false, reason: '越权尝试' });
  assert.equal(res.status, 403);
});
