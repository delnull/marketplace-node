/**
 * 开店申请审批：节点管理页的「通过并开店 / 驳回」两个动作。
 *
 * 判据：
 *   · 通过 ⇒ 同一个事务里建店并分配编号，申请人立即能在这家店里操作；
 *   · 驳回 ⇒ 记原因，pending 队列清空（申请人可改名再申请）；
 *   · 审批只对 nodeAdmin 开放（买家 403）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner } = ctx;

test('通过开店申请：建店 + 分配编号 + 申请人立即可用', async () => {
  const applicant = Wallet.createRandom();
  const applicantToken = (await login(ctx, applicant)).token;
  const submitted = await request(app)
    .post('/api/shops/applications')
    .set('Authorization', `Bearer ${applicantToken}`)
    .send({ name: '审批测试店', notice: '申请公告' })
    .expect(200);
  assertOk(submitted);
  const id = submitted.body.data.id;

  const ownerToken = (await login(ctx, owner)).token;
  const queue = await request(app)
    .get('/api/shops/applications/list')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.ok(queue.body.data.applications.some((a) => a.id === id), '待审批队列必须包含这条申请');

  const approved = await request(app)
    .post(`/api/shops/applications/${id}/review`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'approve' })
    .expect(200);
  assertOk(approved);
  const code = approved.body.data.shop.code;
  /*
    编号形状：8 位数据 + 1 位校验，校验位可以是扩展符号 `-._~,`（对应校验值 32..36）。
    这里曾经只收数据字母表，13% 的合法编号会被判成"形状不对"——随机通过的假绿比失败更难查。
    完整校验（形状 + 加权和）的唯一实现在 shared/shopCode.js，由 test/shopCode.test.js 对拍。
  */
  assert.match(code, /^[0-9A-HJKMNP-TV-Z._~,-]{9}$/i);

  const settings = await request(app)
    .get('/api/shop/settings')
    .set('Authorization', `Bearer ${applicantToken}`)
    .set('X-Mk-Shop', code)
    .expect(200);
  assert.equal(settings.body.data.code, code, '申请人通过后立即成为该店店主');

  const mine = await request(app)
    .get('/api/shops/applications/mine?all=1')
    .set('Authorization', `Bearer ${applicantToken}`)
    .expect(200);
  const mineRow = mine.body.data.applications.find((a) => a.id === id);
  assert.equal(mineRow.status, 'approved');
  assert.equal(mineRow.shopCode, code, '申请人必须能从自己的申请记录里读到开出的店铺编号');

  const scoped = await request(app)
    .get(`/api/shop/audit/node?targetShop=${code}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.ok(
    scoped.body.data.items.some(
      (i) => i.action === 'shop.application.approve' && i.detail.code === code
    ),
    '店铺详情要能按 detail.code 读到这家店的开店审批记录'
  );
});

test('驳回开店申请：原因落库、pending 队列清空；买家不能审批', async () => {
  const applicant = Wallet.createRandom();
  const applicantToken = (await login(ctx, applicant)).token;
  const submitted = await request(app)
    .post('/api/shops/applications')
    .set('Authorization', `Bearer ${applicantToken}`)
    .send({ name: '待驳回店' })
    .expect(200);
  const id = submitted.body.data.id;

  const ownerToken = (await login(ctx, owner)).token;
  const rejected = await request(app)
    .post(`/api/shops/applications/${id}/review`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'reject', reason: '店名与经营内容不符' })
    .expect(200);
  assertOk(rejected);
  assert.equal(rejected.body.data.status, 'rejected');
  assert.equal(rejected.body.data.rejectReason, '店名与经营内容不符');
  assert.equal(rejected.body.data.shopCode, null, '驳回的申请没有开出店铺');

  const mine = await request(app)
    .get('/api/shops/applications/mine?all=1')
    .set('Authorization', `Bearer ${applicantToken}`)
    .expect(200);
  const mineRow = mine.body.data.applications.find((a) => a.id === id);
  assert.equal(mineRow.status, 'rejected');
  assert.equal(mineRow.rejectReason, '店名与经营内容不符', '申请人读得到驳回原因');
  assert.equal(mineRow.shopCode, null);

  const queue = await request(app)
    .get('/api/shops/applications/list')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(queue.body.data.applications.some((a) => a.id === id), false, '已驳回的申请不再出现在待审批队列');

  const buyer = Wallet.createRandom();
  const buyerToken = (await login(ctx, buyer)).token;
  const forbidden = await request(app)
    .post(`/api/shops/applications/${id}/review`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ action: 'approve' });
  assert.equal(forbidden.status, 403);
});

test('申请队列分页：total / page / pageSize；待审批按先来先审排序', async () => {
  const created = [];
  for (const name of ['分页申请 A', '分页申请 B', '分页申请 C']) {
    const wallet = Wallet.createRandom();
    const token = (await login(ctx, wallet)).token;
    const res = await request(app)
      .post('/api/shops/applications')
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(200);
    assertOk(res);
    created.push(res.body.data.id);
  }

  const ownerToken = (await login(ctx, owner)).token;
  const page1 = await request(app)
    .get('/api/shops/applications/list?page=1&pageSize=2')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(page1.body.data.total, 3);
  assert.equal(page1.body.data.page, 1);
  assert.equal(page1.body.data.pageSize, 2);
  assert.deepEqual(
    page1.body.data.applications.map((a) => a.id),
    created.slice(0, 2),
    '待审批按 id 升序（先来先审）'
  );

  const page2 = await request(app)
    .get('/api/shops/applications/list?page=2&pageSize=2')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(page2.body.data.total, 3);
  assert.deepEqual(page2.body.data.applications.map((a) => a.id), created.slice(2));

  // 越界页返回空列表，但 total 仍是真实值（不把"没这一页"说成"没有申请"）
  const beyond = await request(app)
    .get('/api/shops/applications/list?page=9&pageSize=2')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(beyond.body.data.total, 3);
  assert.deepEqual(beyond.body.data.applications, []);
});

test('申请队列搜索：店名/店主地址大小写不敏感，% 按字面量匹配', async () => {
  const wallet = Wallet.createRandom();
  const token = (await login(ctx, wallet)).token;
  const name = 'SearchCase%店';
  const submitted = await request(app)
    .post('/api/shops/applications')
    .set('Authorization', `Bearer ${token}`)
    .send({ name })
    .expect(200);
  assertOk(submitted);
  const id = submitted.body.data.id;

  const ownerToken = (await login(ctx, owner)).token;
  const auth = { Authorization: `Bearer ${ownerToken}` };

  const byName = await request(app)
    .get(`/api/shops/applications/list?q=${encodeURIComponent('searchcase%店')}`)
    .set(auth)
    .expect(200);
  assert.equal(byName.body.data.total, 1, '店名搜索必须大小写不敏感');
  assert.equal(byName.body.data.applications[0].id, id);

  const bySeller = await request(app)
    .get(`/api/shops/applications/list?q=${wallet.address.toUpperCase()}`)
    .set(auth)
    .expect(200);
  assert.equal(bySeller.body.data.total, 1, '店主地址搜索必须大小写不敏感');
  assert.equal(bySeller.body.data.applications[0].id, id);

  // `%` 是 LIKE 的通配符；不转义的话这里会把前面几条 pending 全部搜出来
  const literalPercent = await request(app)
    .get(`/api/shops/applications/list?q=${encodeURIComponent('%')}`)
    .set(auth)
    .expect(200);
  assert.equal(literalPercent.body.data.total, 1);
  assert.equal(literalPercent.body.data.applications[0].id, id);

  const noMatch = await request(app)
    .get('/api/shops/applications/list?q=no-such-shop-name')
    .set(auth)
    .expect(200);
  assert.equal(noMatch.body.data.total, 0);
  assert.deepEqual(noMatch.body.data.applications, []);
});
