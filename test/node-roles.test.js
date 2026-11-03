/**
 * 节点级角色的**授权矩阵**：节点主 / 节点员工 / 店铺店主 / 店铺店员 / 买家 / 陌生人 / 匿名。
 *
 * 这些端点在上一轮之前没有页面，也很少被单测同时摆在一张表上：
 *  · nodeAdmin = 节点主 ∪ node_staff（节点资料、员工名单、节点读数）；
 *  · hostOnly  = 仅节点主（PII 保留期、节点级审计）；
 *  · staffOnly = 店铺店主 ∪ 该店店员（经营面）；
 *  · ownerOnly = 店铺店主（财务/敏感面）。
 *
 * 另一条容易漂移的边界：**节点员工不是店铺员工**。他只在节点主的自营店里按 staff 算，
 * 在租户店里什么都不是；店铺店主也不能因为“我在这家店是 owner”就拿到节点级权限。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const nodeStaff = Wallet.createRandom();
const shopStaff = Wallet.createRandom();
const tenantOwner = Wallet.createRandom();
const buyer = Wallet.createRandom();
const stranger = Wallet.createRandom();
const secondStaff = Wallet.createRandom();
const TENANT_SHOP = '0000TEN01';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;
const host = owner; // fixture 把 shop seller 与 node.owner 都设成这个地址

const { addNodeStaff, removeNodeStaff } = await import('../src/auth.js');
const { addShopOperator } = await import('../src/auth.js');
await addNodeStaff(nodeStaff.address.toLowerCase());
await addShopOperator(shopRef.value, shopStaff.address.toLowerCase());
await db.run(
  `INSERT INTO shops (code, seller, name, notice, listed) VALUES (?, ?, '租户店', '', 1)`,
  TENANT_SHOP, tenantOwner.address.toLowerCase()
);

let tokens;
before(async () => {
  tokens = {
    host: (await login(ctx, host)).token,
    nodeStaff: (await login(ctx, nodeStaff)).token,
    shopStaff: (await login(ctx, shopStaff)).token,
    tenantOwner: (await login(ctx, tenantOwner)).token,
    buyer: (await login(ctx, buyer)).token,
    stranger: (await login(ctx, stranger)).token,
  };
});

function as(role, req) {
  return req.set('Authorization', `Bearer ${tokens[role]}`);
}

async function statusFor(role, method, path, { body, shop = shopRef.value } = {}) {
  let req = as(role, request(app)[method](path));
  if (shop) req = req.set('X-Mk-Shop', shop);
  if (body !== undefined) req = req.send(body);
  const res = await req;
  return res.status;
}

test('节点主 / 节点员工 / 店铺角色 / 买家 / 陌生人 / 匿名：节点级与店铺级授权矩阵', async () => {
  /*
    期望表就是角色定义本身；每个端点至少覆盖 6 个角色，避免“只测了匿名”这种假覆盖。
    401 = 没登录；403 = 登录了但角色不够；200 = 该角色确实能做。
  */
  const matrix = [
    // 节点资料读取：nodeAdmin（host ∪ node_staff）；写入是节点身份，hostOnly
    ['GET  /api/shop/node', 'get', '/api/shop/node', { host: 200, nodeStaff: 200, shopStaff: 403, buyer: 403, stranger: 403, anon: 401 }],
    ['PUT  /api/shop/node', 'put', '/api/shop/node', { host: 200, nodeStaff: 403, shopStaff: 403, buyer: 403, stranger: 403, anon: 401 }, { notice: 'role-matrix' }],
    ['GET  /api/shop/node-staff', 'get', '/api/shop/node-staff', { host: 200, nodeStaff: 200, shopStaff: 403, buyer: 403, stranger: 403, anon: 401 }],
    // 节点级不可逆动作：hostOnly
    ['POST /api/shop/retention/run', 'post', '/api/shop/retention/run', { host: 200, nodeStaff: 403, shopStaff: 403, buyer: 403, stranger: 403, anon: 401 }, { days: 0 }],
    ['GET  /api/shop/audit/node', 'get', '/api/shop/audit/node', { host: 200, nodeStaff: 403, shopStaff: 403, buyer: 403, stranger: 403, anon: 401 }],
    // 店铺财务面：ownerOnly
    ['GET  /api/shop/settings', 'get', '/api/shop/settings', { host: 200, nodeStaff: 403, shopStaff: 403, buyer: 403, stranger: 403, anon: 401 }],
    ['GET  /api/orders/seller/ledger', 'get', '/api/orders/seller/ledger', { host: 200, nodeStaff: 403, shopStaff: 403, buyer: 403, stranger: 403, anon: 401 }],
  ];

  for (const [label, method, path, expected, body] of matrix) {
    for (const [role, want] of Object.entries(expected)) {
      const got =
        role === 'anon'
          ? (await (body === undefined ? request(app)[method](path) : request(app)[method](path).send(body))).status
          : await statusFor(role, method, path, { body });
      assert.equal(got, want, `${label} 作为 ${role} 期望 ${want}，实际 ${got}`);
    }
  }
});

test('店铺经营面：host(owner) / shopStaff / nodeStaff 在自营店是 staff，buyer/stranger 只有买家面', async () => {
  // 商品创建是 staffOnly：三种“经营人员”都过，买家/陌生人 403，匿名 401。
  for (const role of ['host', 'shopStaff', 'nodeStaff']) {
    const res = await as(role, request(app).post('/api/products'))
      .set('X-Mk-Shop', shopRef.value)
      .send(productPayload({ title: `role-${role}`, kind: 'physical' }));
    assert.equal(res.status, 200, `${role} 应可上架自营店商品`);
    assertOk(res);
  }
  for (const role of ['buyer', 'stranger']) {
    const res = await as(role, request(app).post('/api/products'))
      .set('X-Mk-Shop', shopRef.value)
      .send(productPayload());
    assert.equal(res.status, 403, `${role} 不得上架`);
  }
  await request(app).post('/api/products').set('X-Mk-Shop', shopRef.value).send(productPayload()).expect(401);

  // 店铺设置/流水仍只属于店主：nodeStaff 只是 staff，不能看。
  await as('nodeStaff', request(app).get('/api/shop/settings')).set('X-Mk-Shop', shopRef.value).expect(403);
  await as('shopStaff', request(app).get('/api/shop/settings')).set('X-Mk-Shop', shopRef.value).expect(403);
});

test('店员只能改公告，不能改店名 / 谈信客服地址', async () => {
  const nameTry = await as('shopStaff', request(app).put('/api/shop'))
    .set('X-Mk-Shop', shopRef.value)
    .send({ name: '被店员改掉的店名' });
  assert.equal(nameTry.status, 403);

  const tanxinTry = await as('shopStaff', request(app).put('/api/shop'))
    .set('X-Mk-Shop', shopRef.value)
    .send({ tanxinAddress: '0x1111111111111111111111111111111111111111' });
  assert.equal(tanxinTry.status, 403);

  const noticeOk = await as('shopStaff', request(app).put('/api/shop'))
    .set('X-Mk-Shop', shopRef.value)
    .send({ notice: '店员维护的公告' });
  assert.equal(noticeOk.status, 200);
  assert.equal(noticeOk.body.data.notice, '店员维护的公告');
});

test('节点员工不是租户店员工：自营店可经营，租户店 403', async () => {
  // 自营店：节点员工按 staff 算
  const self = await as('nodeStaff', request(app).get('/api/orders/seller')).set('X-Mk-Shop', shopRef.value);
  assert.equal(self.status, 200, `节点员工应能经营节点主自营店：${self.status} ${self.body.message || ''}`);

  // 租户店：节点员工/节点主/店铺店员都不是那家店的人；只有该店店主能看
  for (const role of ['nodeStaff', 'host', 'shopStaff']) {
    const res = await as(role, request(app).get('/api/orders/seller')).set('X-Mk-Shop', TENANT_SHOP);
    assert.equal(res.status, 403, `${role} 不得读取租户店经营数据`);
  }
  await as('tenantOwner', request(app).get('/api/orders/seller')).set('X-Mk-Shop', TENANT_SHOP).expect(200);

  // 租户店主也不能借“我是店主”拿节点级权限
  await as('tenantOwner', request(app).get('/api/shop/node')).expect(403);
  await as('tenantOwner', request(app).get('/api/shop/node-staff')).expect(403);
});

test('员工不能互授/扩权；节点主可增删，但不能把节点主加进名单', async () => {
  // 授予权限本身只属于节点主；node_staff 可读名单，但不能改。
  await as('nodeStaff', request(app).put('/api/shop/node-staff'))
    .send({ action: 'add', address: secondStaff.address.toLowerCase() })
    .expect(403);

  const add = await as('host', request(app).put('/api/shop/node-staff'))
    .send({ action: 'add', address: secondStaff.address.toLowerCase() });
  assert.equal(add.status, 200);
  assert.ok(add.body.data.staff.map((s) => s.toLowerCase()).includes(secondStaff.address.toLowerCase()));

  const rm = await as('host', request(app).put('/api/shop/node-staff'))
    .send({ action: 'remove', address: secondStaff.address.toLowerCase() });
  assert.equal(rm.status, 200);

  for (const body of [
    { action: 'add', address: host.address.toLowerCase() },
    { action: 'add', address: '0x0000000000000000000000000000000000000000' },
    { action: 'add', address: 'not-an-address' },
    { action: 'nope', address: secondStaff.address.toLowerCase() },
  ]) {
    const res = await as('host', request(app).put('/api/shop/node-staff')).send(body);
    assert.notEqual(res.body.code, 0, `非法请求应被拒绝：${JSON.stringify(body)}`);
  }
});

test('移除节点员工立即生效（节点级与自营店经营面同时收回）', async () => {
  await removeNodeStaff(nodeStaff.address.toLowerCase());
  await as('nodeStaff', request(app).get('/api/shop/node')).expect(403);
  await as('nodeStaff', request(app).post('/api/products'))
    .set('X-Mk-Shop', shopRef.value)
    .send(productPayload())
    .expect(403);
});
