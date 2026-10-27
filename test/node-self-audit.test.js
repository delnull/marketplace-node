/**
 * 「自己的」节点级操作记录（`GET /api/shop/audit/node/self`）。
 *
 * 判据：
 *   · nodeAdmin（节点主 ∪ 员工）能读到**自己**的节点级行（actor=登录地址，shop_code NULL）；
 *   · 查询参数里的 actor 不能改范围（否则员工可以读所有人）；
 *   · 员工仍然读不到全节点审计（`/node` hostOnly 不变）；
 *   · 节点主用同一个端点看到的是自己的行，不是员工的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner, buyer } = ctx;
const staff = Wallet.createRandom();
const ownerToken = (await login(ctx, owner)).token;
const ownerAuth = { Authorization: `Bearer ${ownerToken}` };

test('员工能读自己的节点级操作；读不到别人的、也读不到全节点', async () => {
  const added = await request(app)
    .put('/api/shop/node-staff')
    .set(ownerAuth)
    .send({ action: 'add', address: staff.address })
    .expect(200);
  assert.equal(added.body.code, 0);

  const staffToken = (await login(ctx, staff)).token;
  const staffAuth = { Authorization: `Bearer ${staffToken}` };

  const suspended = await request(app)
    .patch(`/api/shops/admin/${shopRef.value}/listing`)
    .set(staffAuth)
    .send({ listed: false, reason: '员工自审测试' })
    .expect(200);
  assert.equal(suspended.body.code, 0);

  const ownerUpdate = await request(app)
    .put('/api/shop/node')
    .set(ownerAuth)
    .send({ notice: '节点主公告（员工不可见）' })
    .expect(200);
  assert.equal(ownerUpdate.body.code, 0);

  const self = await request(app)
    .get('/api/shop/audit/node/self?pageSize=100')
    .set(staffAuth)
    .expect(200);
  assert.ok(self.body.data.total >= 1);
  const actions = self.body.data.items.map((i) => i.action);
  assert.ok(actions.includes('shop.suspend'), '员工要能回看自己的暂停动作');
  assert.equal(actions.includes('node.update'), false, '节点主的节点资料修改不属于员工');
  assert.equal(actions.includes('node.staff.add'), false, '节点主添加员工的动作不属于员工');
  for (const row of self.body.data.items) {
    assert.equal(row.actor, staff.address.toLowerCase(), '范围必须由令牌决定');
  }

  // 查询参数里的 actor 不能扩大范围
  const spoof = await request(app)
    .get(`/api/shop/audit/node/self?actor=${owner.address}`)
    .set(staffAuth)
    .expect(200);
  assert.equal(
    spoof.body.data.items.every((i) => i.actor === staff.address.toLowerCase()),
    true,
    'actor 查询参数必须被服务端覆盖'
  );

  // 全节点审计仍只对节点主开放
  const full = await request(app).get('/api/shop/audit/node').set(staffAuth);
  assert.equal(full.status, 403);

  const ownerSelf = await request(app)
    .get('/api/shop/audit/node/self?pageSize=100')
    .set(ownerAuth)
    .expect(200);
  const ownerActions = ownerSelf.body.data.items.map((i) => i.action);
  assert.ok(ownerActions.includes('node.update'));
  assert.ok(ownerActions.includes('node.staff.add'));
  assert.equal(ownerActions.includes('shop.suspend'), false, '节点主看不到员工的动作（那是员工自己的）');

  const buyerToken = (await login(ctx, buyer)).token;
  const forbidden = await request(app)
    .get('/api/shop/audit/node/self')
    .set('Authorization', `Bearer ${buyerToken}`);
  assert.equal(forbidden.status, 403);

  // 员工不能用审批权给自己开收款店铺
  const application = await request(app)
    .post('/api/shops/applications')
    .set(staffAuth)
    .send({ name: '员工自批店' })
    .expect(200);
  assert.equal(application.body.code, 0);
  const selfReview = await request(app)
    .post(`/api/shops/applications/${application.body.data.id}/review`)
    .set(staffAuth)
    .send({ action: 'approve' });
  assert.equal(selfReview.status, 409);
  assert.match(String(selfReview.body.message), /不能审批自己的开店申请/);
});
