/**
 * 开店申请**批量审批**：节点管理页一次处理多条申请。
 *
 * 判据：
 *   · 通过 ⇒ 每条申请各开一家店、编号互不相同，申请人立即能进自己的店；
 *   · 驳回 ⇒ 同一句原因记到每条申请上，pending 队列清空；
 *   · 批量是**整批**的：任一条不存在/已处理/钱包已有店 ⇒ 整批不写（404/409）；
 *   · 与单品共用同一个内核：驳回原因必填，单条也必须给；
 *   · 只有 nodeAdmin 能审批（买家 403）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner } = ctx;
const ownerToken = (await login(ctx, owner)).token;

async function submitApplication(wallet, name) {
  const token = (await login(ctx, wallet)).token;
  const res = await request(app)
    .post('/api/shops/applications')
    .set('Authorization', `Bearer ${token}`)
    .send({ name })
    .expect(200);
  assertOk(res);
  return { token, id: res.body.data.id };
}

function batchReview(token, body) {
  return request(app)
    .post('/api/shops/applications/batch-review')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

test('批量通过：每条各建一家店、编号唯一、申请人立即可用、审计逐条留痕', async () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  const appA = await submitApplication(a, '批量通过 A');
  const appB = await submitApplication(b, '批量通过 B');

  const res = await batchReview(ownerToken, { ids: [appA.id, appB.id], action: 'approve' }).expect(200);
  assertOk(res);
  assert.equal(res.body.data.action, 'approve');
  assert.equal(res.body.data.approved.length, 2);
  assert.deepEqual(res.body.data.rejected, []);
  const codes = res.body.data.approved.map((x) => x.code);
  assert.equal(new Set(codes).size, 2, '同一批里两条申请必须拿到不同编号');
  for (const code of codes) assert.match(code, /^[0-9A-HJKMNP-TV-Z.\-_~,]{9}$/i);

  for (const [wallet, code] of [
    [a, codes[0]],
    [b, codes[1]],
  ]) {
    const token = (await login(ctx, wallet)).token;
    const settings = await request(app)
      .get('/api/shop/settings')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Mk-Shop', code)
      .expect(200);
    assert.equal(settings.body.data.code, code, '申请人通过后立即成为该店店主');
  }

  const queue = await request(app)
    .get('/api/shops/applications/list')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(
    queue.body.data.applications.some((x) => x.id === appA.id || x.id === appB.id),
    false,
    '已通过的申请不再出现在待审批队列'
  );

  const audit = await request(app)
    .get('/api/shop/audit/node?pageSize=100')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const rows = audit.body.data.items.filter(
    (it) => it.action === 'shop.application.approve' && codes.includes(it.detail.code)
  );
  assert.equal(rows.length, 2, '批量通过必须每条申请各留一条审计');
  for (const row of rows) {
    assert.equal(row.detail.batch, true);
    assert.equal(row.detail.batchSize, 2);
    assert.equal(row.targetType, 'shop_application');
  }
});

test('批量驳回：同一原因记到每条、队列清空；驳回原因必填（单条与批量）', async () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  const appA = await submitApplication(a, '批量驳回 A');
  const appB = await submitApplication(b, '批量驳回 B');
  const reason = '店名与经营内容不符';

  const res = await batchReview(ownerToken, {
    ids: [appA.id, appB.id],
    action: 'reject',
    reason,
  }).expect(200);
  assertOk(res);
  assert.equal(res.body.data.action, 'reject');
  assert.deepEqual(res.body.data.approved, []);
  assert.deepEqual(res.body.data.rejected.sort(), [appA.id, appB.id].sort());

  const rows = await ctx.db.all(
    'SELECT status, reject_reason FROM shop_applications WHERE id IN (?, ?)',
    Number(appA.id),
    Number(appB.id)
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, 'rejected');
    assert.equal(row.reject_reason, reason);
  }

  const pending = await submitApplication(Wallet.createRandom(), '缺原因');
  const noReason = await batchReview(ownerToken, { ids: [pending.id], action: 'reject' }).expect(400);
  assert.equal(noReason.body.code, 400);
  const stillPending = await ctx.db.get('SELECT status FROM shop_applications WHERE id = ?', Number(pending.id));
  assert.equal(stillPending.status, 'pending', '缺原因的驳回必须整批不写');

  const single = await request(app)
    .post(`/api/shops/applications/${pending.id}/review`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'reject' })
    .expect(400);
  assert.equal(single.body.code, 400);
});

test('批量审批是整批的：一条不满足就整批不写；非 nodeAdmin 403', async () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  const appA = await submitApplication(a, '已处理 A');
  const appB = await submitApplication(b, '待处理 B');

  const single = await request(app)
    .post(`/api/shops/applications/${appA.id}/review`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'approve' })
    .expect(200);
  assertOk(single);

  // A 已通过：整批里只要带上它，B 也不能被顺带处理
  const stale = await batchReview(ownerToken, { ids: [appB.id, appA.id], action: 'approve' }).expect(409);
  assert.equal(stale.body.code, 409);
  assert.equal(
    (await ctx.db.get('SELECT status FROM shop_applications WHERE id = ?', Number(appB.id))).status,
    'pending'
  );
  assert.equal(
    await ctx.db.get('SELECT code FROM shops WHERE seller = ?', b.address.toLowerCase()),
    undefined,
    '整批未执行时不能给 B 建店'
  );

  // 不存在的编号：同样整批不写
  await batchReview(ownerToken, { ids: [appB.id, 999999], action: 'approve' }).expect(404);
  assert.equal(
    (await ctx.db.get('SELECT status FROM shop_applications WHERE id = ?', Number(appB.id))).status,
    'pending'
  );

  // 驳回也必须整批：A 已通过，B 不能被单独驳回
  await batchReview(ownerToken, { ids: [appB.id, appA.id], action: 'reject', reason: '整批拒绝' }).expect(409);
  assert.equal(
    (await ctx.db.get('SELECT status FROM shop_applications WHERE id = ?', Number(appB.id))).status,
    'pending'
  );

  /*
    钱包已有店（申请先于店铺存在，比如店主由另一条路径先建了店）：通过也必须拒绝，
    而且申请保持 pending——不能出现"申请批了、店却建不出来"的半截状态。
  */
  const c = Wallet.createRandom();
  const appC = await submitApplication(c, '已有店铺');
  await ctx.db.run(
    'INSERT INTO shops (code, seller, name, notice, listed) VALUES (?, ?, ?, ?, 1)',
    '0000EXST1',
    c.address.toLowerCase(),
    '既有店铺',
    ''
  );
  const exists = await batchReview(ownerToken, { ids: [appC.id], action: 'approve' }).expect(409);
  assert.equal(exists.body.code, 409);
  assert.equal(
    (await ctx.db.get('SELECT status FROM shop_applications WHERE id = ?', Number(appC.id))).status,
    'pending'
  );

  // 形状错误：非法编号 / 空数组（不去猜、不静默丢弃）
  await batchReview(ownerToken, { ids: [appB.id, 'oops'], action: 'approve' }).expect(400);
  await batchReview(ownerToken, { ids: [], action: 'approve' }).expect(400);

  const buyer = Wallet.createRandom();
  const buyerToken = (await login(ctx, buyer)).token;
  const forbidden = await batchReview(buyerToken, { ids: [appB.id], action: 'approve' });
  assert.equal(forbidden.status, 403);
});
