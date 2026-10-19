/**
 * 店铺员工是**链下名单**，而链上角色互斥（owner/仲裁人/节点主/员工）看不到它。
 * 这里钉住两条边界：
 *   · 名单命中还不够——`roleOf` 每请求再问一次 `isProtocolGovernance`（当前届仲裁人或四份治理 owner）；
 *   · 链上读不到时按 `user`（fail-closed），不是把店员权限放行。
 * 用 `setProtocolGovernanceReader` 注入三种现场，判据与控制流仍是被测的真实代码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { db, app, request, owner } = ctx;
const staff = Wallet.createRandom().address.toLowerCase();

const { roleOf, addShopOperator } = await import('../src/auth.js');
const { setProtocolGovernanceReader } = await import('../src/chain.js');

const CODE = '0000GOV11';

test('店铺员工命中后仍要过链上治理判据；读不到时 fail-closed', async () => {
  await db.run(
    `INSERT INTO shops (code, seller, name, notice, listed, commission_bps)
     VALUES (?, ?, '', '', 1, 0) ON DUPLICATE KEY UPDATE seller = seller`,
    CODE,
    Wallet.createRandom().address.toLowerCase()
  );
  await addShopOperator(CODE, staff);

  try {
    setProtocolGovernanceReader(async () => false);
    assert.equal(await roleOf(staff, CODE), 'staff', '普通地址仍是店员');

    setProtocolGovernanceReader(async (addr) => addr === staff);
    assert.equal(await roleOf(staff, CODE), 'user', '当前届仲裁人/治理 owner 不能凭链下名单拿到店员权限');

    setProtocolGovernanceReader(async () => null);
    assert.equal(await roleOf(staff, CODE), 'user', '读不到链上治理身份 ⇒ 不冒充店员（fail-closed）');
  } finally {
    setProtocolGovernanceReader(async () => false);
  }
});

test('PUT /shop/staff：治理身份或读不到都拒绝，普通地址才放行', async () => {
  const token = (await login(ctx, owner)).token;
  const target = Wallet.createRandom().address.toLowerCase();
  const put = (addr) =>
    request(app)
      .put('/api/shop/staff')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Mk-Shop', shopRef.value)
      .send({ action: 'add', address: addr });

  try {
    setProtocolGovernanceReader(async () => true);
    let res = await put(target).expect(200);
    assert.notEqual(res.body.code, 0, '治理 owner/当前届仲裁人不能加入店员名单');

    setProtocolGovernanceReader(async () => null);
    res = await put(target).expect(200);
    assert.notEqual(res.body.code, 0, '链上治理身份读不到 ⇒ 拒绝登记（fail-closed）');

    setProtocolGovernanceReader(async () => false);
    res = await put(target).expect(200);
    assert.equal(res.body.code, 0, '确认不是治理身份后才放行');
  } finally {
    setProtocolGovernanceReader(async () => false);
  }
});
