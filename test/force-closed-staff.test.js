/**
 * **被强制关闭的员工**不能继续以任何经营/管理身份通过鉴权（2026-10-18）。
 *
 * 链上 `MarketplaceRegistry._forceClose` 会把 `staffNode[who]` 那一行清掉，但节点侧还有
 * 两个**链下**事实源：`shop_operators`（店铺员工名单）与 15s 缓存。只查治理身份
 * （`Escrow.isProtocolGovernance`）挡不住这类地址——被 forceClose 的员工不是 owner/仲裁人，
 * 该读法返回 false，于是 `roleOf` 会照旧给出 `staff`。链上对被强制关闭的当前届仲裁人也返回
 * `isProtocolGovernance=false`，所以"用治理判据顺便挡 forceClose"是不成立的。
 *
 * 本文件用注入点（与 setProtocolGovernanceReader 同款）证明三条出口都 fail-closed：
 *   ① `roleOf` 的 shop_operators 分支 / 节点员工自营店分支；
 *   ② `isNodeAdmin`（节点主被关闭、员工被关闭/读不到）；
 *   ③ `PUT /api/shop/staff` 的加入入口（true 拒绝、null 也拒绝）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, shopRef, TEST_SHOP_CODE } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

const forceClosed = Wallet.createRandom();
const unreadable = Wallet.createRandom();
const normal = Wallet.createRandom();

const { setNodeStaffReader, setForceClosedReader } = await import('../src/chain.js');
const { roleOf, isNodeAdmin, isHost, addShopOperator } = await import('../src/auth.js');

/**
 * 员工名单：forceClosed 是"本节点员工"（因此会命中 roleOf 的节点员工分支）。
 * 这刻意让两条分支都可能命中——这样才能证明**每一条**都独立问了 forceClosed，
 * 而不是一条挡、另一条漏。
 */
setNodeStaffReader(async (addr) =>
  addr === forceClosed.address.toLowerCase() ? owner.address.toLowerCase() : ''
);
setForceClosedReader(async (addr) => {
  if (addr === forceClosed.address.toLowerCase()) return true;
  if (addr === unreadable.address.toLowerCase()) return null; // 读不到 ≠ 没被关闭
  return false;
});

let ownerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
});

const addStaff = (address) =>
  request(app)
    .put('/api/shop/staff')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send({ action: 'add', address });

test('被强制关闭的节点员工在自营店拿不到 staff 档（forceClosed 单独判，不靠治理身份）', async () => {
  assert.equal(await roleOf(forceClosed.address, TEST_SHOP_CODE), 'user', '被强制关闭 ⇒ user');
  assert.equal(await roleOf(normal.address, TEST_SHOP_CODE), 'user', '普通人仍不是员工（控制组）');
  // 节点主自己不受这条影响（他没被关闭）
  assert.equal(await roleOf(owner.address, TEST_SHOP_CODE), 'owner');
});

test('被强制关闭的地址即使出现在 shop_operators 里也只是 user（链下名单清不掉链上状态）', async () => {
  await addShopOperator(TEST_SHOP_CODE, forceClosed.address.toLowerCase());
  assert.equal(await roleOf(forceClosed.address, TEST_SHOP_CODE), 'user', 'shop_operators 命中 + forceClosed ⇒ user');
  // 读不到同样不能给权限
  await addShopOperator(TEST_SHOP_CODE, unreadable.address.toLowerCase());
  assert.equal(await roleOf(unreadable.address, TEST_SHOP_CODE), 'user', 'forceClosed 读不到 ⇒ user（fail-closed）');
});

test('PUT /staff：强制关闭 ⇒ 拒绝；读不到 ⇒ 拒绝；正常地址可通过（控制组）', async () => {
  // 上一条用例直接往 shop_operators 插过（模拟"链下名单里的残留"）；这里先清掉，
  // 才能证明本条"拒绝时不得落库"验的是**本次写入**而不是那条残留。
  for (const a of [forceClosed.address, unreadable.address]) {
    await db.run('DELETE FROM shop_operators WHERE shop_code = ? AND address = ?', shopRef.value, a.toLowerCase());
  }
  const closed = await addStaff(forceClosed.address).expect(200);
  assert.notEqual(closed.body.code, 0);
  assert.match(String(closed.body.message), /强制关闭/);
  assert.equal(
    (await db.get('SELECT 1 AS hit FROM shop_operators WHERE shop_code = ? AND address = ?', shopRef.value, forceClosed.address.toLowerCase())),
    undefined,
    '拒绝时不得落库'
  );

  const unknown = await addStaff(unreadable.address).expect(200);
  assert.notEqual(unknown.body.code, 0);
  assert.match(String(unknown.body.message), /读不到/);
  assert.equal(
    (await db.get('SELECT 1 AS hit FROM shop_operators WHERE shop_code = ? AND address = ?', shopRef.value, unreadable.address.toLowerCase())),
    undefined,
    '读不到时同样不得落库'
  );

  assertOk(await addStaff(normal.address).expect(200));
});

test('isNodeAdmin：被强制关闭的员工不是管理员；节点主被强制关闭时整台机器的节点级权限失效', async () => {
  assert.equal(await isNodeAdmin(forceClosed.address, { force: true }), false, '员工被 forceClose ⇒ 非管理员');
  assert.equal(await isNodeAdmin(owner.address, { force: true }), true, '控制组：节点主正常');

  // 节点主被强制关闭：连他自己也不再是节点管理员（读不到/被关闭都 fail-closed）
  setForceClosedReader(async (addr) => (addr === owner.address.toLowerCase() ? true : false));
  try {
    assert.equal(await isNodeAdmin(owner.address, { force: true }), false);
  } finally {
    setForceClosedReader(async (addr) => {
      if (addr === forceClosed.address.toLowerCase()) return true;
      if (addr === unreadable.address.toLowerCase()) return null;
      return false;
    });
  }
});

test('HTTP 面：被强制关闭的员工令牌调 nodeAdmin 端点 ⇒ 403（不是只挡在函数里）', async () => {
  const token = (await login(ctx, forceClosed)).token;
  const denied = await request(app).get('/api/shop/node').set('Authorization', `Bearer ${token}`);
  assert.equal(denied.status, 403);
});

test('HTTP 面：节点主被 forceClose 后 hostOnly 的审计/PII 入口也必须 403', async () => {
  setForceClosedReader(async (addr) => addr === owner.address.toLowerCase());
  try {
    assert.equal(await isHost(owner.address, { force: true }), false);
    const auditDenied = await request(app)
      .get('/api/shop/audit/node')
      .set('Authorization', `Bearer ${ownerToken}`);
    assert.equal(auditDenied.status, 403, '节点审计是 hostOnly，不能被已撤销节点主读取');
    const piiDenied = await request(app)
      .post('/api/shop/retention/run')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ days: 1 });
    assert.equal(piiDenied.status, 403, '跨租户不可逆 PII 擦除是 hostOnly，不能被已撤销节点主触发');
  } finally {
    setForceClosedReader(async (addr) => {
      if (addr === forceClosed.address.toLowerCase()) return true;
      if (addr === unreadable.address.toLowerCase()) return null;
      return false;
    });
  }
});
