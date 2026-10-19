/**
 * 节点员工（2026-10-18）在**店铺面**的两条边界：
 *
 *  ① 员工的"隐式自营店"（`seller == node.owner`）必须进 `operatedShopCodes` 的**唯一实现**，
 *     于是 `X-Mk-Shop` 可以完全不带：只经营这一家时它就是唯一答案；同时被租户店列入店员时
 *     变成"多于一家" ⇒ 400（不静默选租户店，也不静默选自营店）。
 *  ② 节点员工与节点主同权限**不等于**能读全节点审计 / 触发跨租户 PII 擦除：
 *     那两件是 hostOnly（节点主本人），员工一律 403。审计里的 actorRole 要如实记 staff。
 *
 * 员工名单的事实源在链上（`Registry.staffNode`），本文件用 `setNodeStaffReader` 注入取值
 * （与 setCommitteeReader 同款）：判据与控制流仍是被测的真实代码。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, shopRef, insertOrder } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const staff = Wallet.createRandom();
const applicant = Wallet.createRandom();
const tenantSeller = Wallet.createRandom();
/** 租户店编号（9 位大写；与本进程 fixture 的自营店编号不同） */
const TENANT_SHOP = '0000STAF1';

const { setNodeStaffReader } = await import('../src/chain.js');
const { addShopOperator } = await import('../src/auth.js');
setNodeStaffReader(async (addr) => (addr === staff.address.toLowerCase() ? owner.address.toLowerCase() : ''));

let ownerToken;
let staffToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  staffToken = (await login(ctx, staff)).token;
});

const ACTOR_ROLE = (action, actor) =>
  db.get('SELECT actor_role FROM audit_logs WHERE action = ? AND actor = ? ORDER BY id DESC LIMIT 1', action, actor);

test('员工的隐式自营店进 operatedShopCodes：登录回执列出它，且不带 X-Mk-Shop 也能进 /api/orders/seller', async () => {
  // 自营店（seller = node.owner）由 setup.mjs 造好；再给员工造一张自营店订单，列表才有可断言的行
  const order = await insertOrder(db, {
    status: 'confirmed',
    shopCode: shopRef.value,
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    amountWei: '1000',
    usdtMicro: 1_000_000,
    btyUsdtRate: '0.1',
  });

  const loginData = await login(ctx, staff);
  const selfShop = loginData.shops.find((s) => s.code === shopRef.value);
  assert.ok(selfShop, '员工登录回执必须列出本节点自营店（复用 operatedShopCodes，不另补一次）');
  assert.equal(selfShop.role, 'staff', '员工在自营店里是 staff 档（不是 owner）');

  // ⚠️ 不带 X-Mk-Shop：员工只经营这一家 ⇒ 中间件必须自动选中它
  const res = await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${staffToken}`).expect(200);
  assertOk(res);
  assert.ok(
    res.body.data.orders.some((o) => o.id === order.orderNo),
    '不带请求头时默认店铺必须是自营店（员工的店铺面来自 operatedShopCodes）'
  );
});

test('员工同时是租户店店员：不带 X-Mk-Shop ⇒ 400（多于一家，不静默选任何一家）', async () => {
  await db.run(
    `INSERT INTO shops (code, seller, name, notice, listed, commission_bps)
     VALUES (?, ?, '', '', 1, 0) ON DUPLICATE KEY UPDATE seller = seller`,
    TENANT_SHOP,
    tenantSeller.address.toLowerCase()
  );
  await addShopOperator(TENANT_SHOP, staff.address.toLowerCase());

  const res = await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${staffToken}`).expect(400);
  assert.notEqual(res.body.code, 0);
  assert.match(String(res.body.message), /可经营 2 家店铺/, '必须如实说是"可经营多家"，并点出两个编号');
  assert.match(String(res.body.message), new RegExp(shopRef.value));
  assert.match(String(res.body.message), new RegExp(TENANT_SHOP));

  // 带上请求头就恢复：租户店也能进（员工是那家店的店员）
  assertOk(
    await request(app)
      .get('/api/orders/seller')
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Mk-Shop', TENANT_SHOP)
      .expect(200)
  );
});

test('nodeAdmin 扩到员工后：节点审计与保留期擦除仍是 hostOnly（员工 403、节点主 200）', async () => {
  await request(app).get('/api/shop/audit/node').set('Authorization', `Bearer ${staffToken}`).expect(403);
  await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${staffToken}`).send({}).expect(403);

  assertOk(await request(app).get('/api/shop/audit/node').set('Authorization', `Bearer ${ownerToken}`).expect(200));
  assertOk(
    await request(app)
      .post('/api/shop/retention/run')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ days: 180 })
      .expect(200)
  );

  const retention = await ACTOR_ROLE('retention.run', owner.address.toLowerCase());
  assert.equal(retention?.actor_role, 'host', 'hostOnly 动作由节点主触发 ⇒ actor_role=host');
});

test('员工做 nodeAdmin 动作：review/reconcile 入审计且 actor_role=staff（不是硬编码 host）', async () => {
  // 造一条待审申请（review 只读该行的条款；签名在 /sign 那一步才重验，这里不广播）
  const deadline = new Date(Date.now() + 3600_000);
  const ins = await db.run(
    `INSERT INTO shop_applications (seller, host, name, notice, commission_to, commission_bps, deadline, status)
     VALUES (?, ?, '', '', NULL, 250, ?, 'pending')`,
    applicant.address.toLowerCase(),
    owner.address.toLowerCase(),
    deadline
  );
  const id = Number(ins.insertId);

  assertOk(
    await request(app)
      .post(`/api/shops/applications/${id}/review`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ action: 'reject', reason: '员工驳回测试' })
      .expect(200)
  );
  assertOk(await request(app).post('/api/shops/reconcile').set('Authorization', `Bearer ${staffToken}`).expect(200));

  const approve = await ACTOR_ROLE('shop.application.reject', staff.address.toLowerCase());
  assert.equal(approve?.actor_role, 'staff', '员工审批开店必须记 staff（记成 host 就是错的责任主体）');
  const reconcile = await ACTOR_ROLE('shops.terms.reconcile', staff.address.toLowerCase());
  assert.equal(reconcile?.actor_role, 'staff', '员工手动对账同样记 staff');
});

test('nodeAdmin 不再因请求头解析失败而 404：带未知 X-Mk-Shop 调 /api/shop/node 仍 200', async () => {
  // 未知但形状合法的编号 ⇒ shopContextOf 返回 unresolved；节点级动作只把它当"回声"，不消费
  const res = await request(app)
    .get('/api/shop/node')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', 'ZZZZZZZZ1')
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.host, owner.address.toLowerCase());
});
