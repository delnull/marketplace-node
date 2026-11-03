/**
 * 开店申请队列的**节点级容量上限**（MK_MAX_PENDING_APPLICATIONS）。
 *
 * 判据不是"顺序提交时能挡住"（那样先查后插就够了），而是**并发提交也不能超卖**：
 * 上限判据与 INSERT 必须在同一事务、同一把 `node` 行锁下，否则 N 个请求各自看到
 * "还没满"就一起插进去。容量释放（审批一条）后新申请应重新可提交。
 */
process.env.MK_MAX_PENDING_APPLICATIONS = '2';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;
const ownerToken = (await login(ctx, owner)).token;

test('并发提交也不能超过待审批上限；审批释放容量后可再提交', async () => {
  const wallets = Array.from({ length: 4 }, () => Wallet.createRandom());
  const tokens = [];
  for (const w of wallets) tokens.push((await login(ctx, w)).token);

  const results = await Promise.all(
    tokens.map((token, i) =>
      request(app)
        .post('/api/shops/applications')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `容量测试 ${i}` })
    )
  );
  const accepted = results.filter((r) => r.status === 200);
  const rejected = results.filter((r) => r.status === 503);
  assert.equal(accepted.length, 2, `并发提交必须恰好收下 2 条，实际 ${accepted.length}`);
  assert.equal(rejected.length, 2, `其余必须 503，实际 ${rejected.length}`);
  assert.match(String(rejected[0].body.message), /队列已满/);

  const pending = await db.get("SELECT COUNT(*) AS c FROM shop_applications WHERE status = 'pending'");
  assert.equal(Number(pending.c), 2, '库里不能超过上限');

  // 审批一条 ⇒ 待审批降到 1，容量释放
  const queue = await request(app)
    .get('/api/shops/applications/list')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const first = queue.body.data.applications[0];
  const approved = await request(app)
    .post(`/api/shops/applications/${first.id}/review`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'approve' })
    .expect(200);
  assert.equal(approved.body.code, 0);

  const lateWallet = Wallet.createRandom();
  const lateToken = (await login(ctx, lateWallet)).token;
  const late = await request(app)
    .post('/api/shops/applications')
    .set('Authorization', `Bearer ${lateToken}`)
    .send({ name: '容量释放后的申请' });
  assert.equal(late.status, 200, '释放一个位置后新申请必须能进来');
  assert.equal(late.body.code, 0);
});
