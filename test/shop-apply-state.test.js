/**
 * 「钱包在本节点已有店铺 / 有待审批申请 ⇒ 不能再申请」——节点侧的判据与下发形状。
 *
 * 运行期约束由 `shops.uq_shops_seller` 与 `uq_applications_open` 兜底；本文件钉的是
 * 界面赖以做决定的**同一份事实**：
 *   · `GET /api/shops` 的 `mine`：未登录 = null（未知），登录后 = {shop, pendingApplication}；
 *     `shop` 必须包含**暂停接单**的店（公开在售列表里没有它，只靠那个列表会误判成"没开店"）；
 *   · `GET /api/shops/applications/mine` 的 `mine` 与上面同形（申请页与节点卡共用一套规则）；
 *   · 状态机：pending ⇒ 再提交 409；rejected ⇒ 可重新提交；approved（店铺存在）⇒ 再提交 409。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;
const ownerToken = (await login(ctx, owner)).token;

function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

function submit(token, name) {
  return request(app)
    .post('/api/shops/applications')
    .set(authed(token))
    .send({ name });
}

function review(id, body) {
  return request(app)
    .post(`/api/shops/applications/${id}/review`)
    .set(authed(ownerToken))
    .send(body);
}

async function shopsAs(token) {
  const res = await request(app).get('/api/shops').set(authed(token)).expect(200);
  assertOk(res);
  return res.body.data;
}

async function mineAs(token) {
  const res = await request(app)
    .get('/api/shops/applications/mine?all=1')
    .set(authed(token))
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 走真实流程开一家店（提交 → 节点主审批），返回编号；不绕过 routes 直接插 shops */
async function openShop(wallet) {
  const token = (await login(ctx, wallet)).token;
  const submitted = await submit(token, '状态测试店');
  assertOk(submitted);
  const approved = await review(submitted.body.data.id, { action: 'approve' }).expect(200);
  assertOk(approved);
  return { token, code: approved.body.data.shop.code, applicationId: submitted.body.data.id };
}

test('mine：未登录是 null（未知，不是"没有店"）；登录后未开店是两个都空', async () => {
  const anon = await request(app).get('/api/shops').expect(200);
  assert.equal(anon.body.data.mine, null, '没有令牌时节点不能替任何人断言开店状态');

  const wallet = Wallet.createRandom();
  const token = (await login(ctx, wallet)).token;
  assert.deepEqual((await shopsAs(token)).mine, { shop: null, pendingApplication: null });
  assert.deepEqual((await mineAs(token)).mine, { shop: null, pendingApplication: null });
});

test('pending ⇒ 不能再申请；rejected ⇒ 可重新申请；approved ⇒ 不能再申请', async () => {
  const wallet = Wallet.createRandom();
  const token = (await login(ctx, wallet)).token;

  const first = await submit(token, '第一版').expect(200);
  assertOk(first);
  const firstId = first.body.data.id;

  // 待审批：第二次提交被库的唯一键挡下，并给出可照着做的 409
  const dup = await submit(token, '第二版').expect(409);
  assert.match(String(dup.body.message), /待审批/);
  assert.deepEqual((await shopsAs(token)).mine.pendingApplication.id, firstId);
  assert.deepEqual((await mineAs(token)).mine.pendingApplication.id, firstId);

  // 驳回：缺了一条未终结申请，可以改名重提
  await review(firstId, { action: 'reject', reason: '店名与经营内容不符' }).expect(200);
  const rejected = await mineAs(token);
  assert.equal(rejected.mine.shop, null);
  assert.equal(rejected.mine.pendingApplication, null);
  assert.equal(rejected.applications.find((a) => a.id === firstId).status, 'rejected');
  const second = await submit(token, '改过的店').expect(200);
  assertOk(second);

  // 通过：建店与申请状态同一事务提交，mine 从 pending 直接变成 shop
  const approved = await review(second.body.data.id, { action: 'approve' }).expect(200);
  assertOk(approved);
  const code = approved.body.data.shop.code;
  const after = await mineAs(token);
  assert.equal(after.mine.pendingApplication, null);
  assert.equal(after.mine.shop.code, code);
  assert.equal(after.mine.shop.listed, true);

  // 已有店铺：再申请必须 409，且说清是哪一家店
  const again = await submit(token, '第三版').expect(409);
  assert.match(String(again.body.message), /已有店铺/);
  assert.ok(String(again.body.message).includes(code), '错误信息必须点名已有的店铺编号');
  const count = await db.get('SELECT COUNT(*) AS c FROM shop_applications WHERE seller = ?', wallet.address.toLowerCase());
  assert.equal(Number(count.c), 2, '被拒绝的申请不能落库');
});

test('暂停接单的店不在公开在售列表里，但 mine 仍报"已有店铺"并挡住再申请', async () => {
  const wallet = Wallet.createRandom();
  const { token, code } = await openShop(wallet);
  await db.run(
    'UPDATE shops SET listed = 0, listed_reason = ?, listed_at = CURRENT_TIMESTAMP(3) WHERE code = ?',
    '节点主暂停',
    code
  );

  const anon = await request(app).get('/api/shops').expect(200);
  assert.equal(
    anon.body.data.shops.some((s) => s.code === code),
    false,
    '公开目录只出在售店（这是既有的公开口径）'
  );
  const publicShops = await shopsAs(token);
  assert.equal(publicShops.shops.some((s) => s.code === code), false);
  assert.equal(publicShops.mine.shop.code, code, 'mine 必须包含暂停店，否则界面会误判"还没有店铺"');
  assert.equal(publicShops.mine.shop.listed, false);

  const mine = await mineAs(token);
  assert.equal(mine.mine.shop.code, code);
  assert.equal(mine.mine.shop.listed, false);

  const again = await submit(token, '暂停后再申请').expect(409);
  assert.match(String(again.body.message), /已有店铺/);
});

test('mine 只报当前登录钱包自己的店，不串到别人', async () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  await openShop(a);
  const bToken = (await login(ctx, b)).token;
  assert.deepEqual((await shopsAs(bToken)).mine, { shop: null, pendingApplication: null });
});

test('审批与再次提交并发：后到的申请一定 409，不会留下"已有店铺 + 待审批申请"', async () => {
  const wallet = Wallet.createRandom();
  const token = (await login(ctx, wallet)).token;
  const first = await submit(token, '并发审批中的店').expect(200);
  assertOk(first);

  /*
    两个请求并发：节点主批第一条 / 同一钱包再提交一条。
    锁顺序（node → shop_applications）保证二者只能有一方看到"还没有店铺"：
      · 审批先拿到锁 ⇒ 建店并提交，再提交者读到店铺 ⇒ 409；
      · 再提交先拿到锁 ⇒ 第一条仍是 pending，uq_applications_open 拒绝第二条 ⇒ 409。
    任何交错下都不允许出现"店铺已存在 + 一条 pending"——那条 pending 永远批不出来。
  */
  const [approved, second] = await Promise.all([
    review(first.body.data.id, { action: 'approve' }),
    submit(token, '并发第二版'),
  ]);
  assert.equal(approved.status, 200);
  assert.equal(second.status, 409, '同一钱包在第一条 pending/店铺已存在时不可能再插入第二条申请');

  const pending = await db.get(
    "SELECT COUNT(*) AS c FROM shop_applications WHERE seller = ? AND status = 'pending'",
    wallet.address.toLowerCase()
  );
  assert.equal(Number(pending.c), 0, '审批通过后不能再留下 pending 申请');
  const shops = await db.get('SELECT code FROM shops WHERE seller = ?', wallet.address.toLowerCase());
  assert.ok(shops?.code);
  assert.equal((await shopsAs(token)).mine.shop.code, shops.code);
});
