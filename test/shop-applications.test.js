/**
 * 节点内开店的四步流程（`/api/shops/applications*`）——端到端往返。
 *
 * 当前角色边界：**抽成由节点主设置**，不是店主在申请里自报：
 *   ① 店主提交申请（不签名、不填抽成）；
 *   ② 节点主审批时设置 `commissionBps`，节点回一张票据；
 *   ③ 店主对这张票据签名（接受节点主设置的条款）；
 *   ④ 节点主/员工签同一张票据，再广播 `registerShop`。
 *
 * 判据是**签名链**，不是“接口返回 200”：
 *   · 店主签错地址/换条款复用旧签名必须被拒；
 *   · 节点主在店主签名前不能签，店主签名后节点主也不能改抽成；
 *   · 最终 `call.args` 里的两半签名必须各自恢复出正确地址。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

process.env.MK_REGISTRY_ADDRESS = '0x000000000000000000000000000000000000dEaD';
process.env.MK_CHAIN_ID = '31337';

const { makeCtx, login, assertOk } = await import('./setup.mjs');
const ctx = await makeCtx();
const { app, request, owner, db } = ctx;

const { recoverTicketSigner } = await import('../src/shops.js');

const newWallet = () => Wallet.createRandom();

async function tokenFor(wallet) {
  const data = await login(ctx, wallet);
  assert.ok(data?.token, '登录回执里必须有 token');
  return data.token;
}

const hostToken = await tokenFor(owner);

const walletSign = async (wallet, digest) => wallet.signingKey.sign(digest).serialized;

function submit(token, { name = '测试店', notice = '' } = {}) {
  return request(app)
    .post('/api/shops/applications')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, notice });
}

function approve(id, commissionBps) {
  return request(app)
    .post(`/api/shops/applications/${id}/review`)
    .set('Authorization', `Bearer ${hostToken}`)
    .send({ action: 'approve', commissionBps });
}

function sellerSign(id, sellerToken, sellerSig) {
  return request(app)
    .post(`/api/shops/applications/${id}/seller-sign`)
    .set('Authorization', `Bearer ${sellerToken}`)
    .send({ sellerSig });
}

function hostSign(id, hostSig) {
  return request(app)
    .post(`/api/shops/applications/${id}/sign`)
    .set('Authorization', `Bearer ${hostToken}`)
    .send({ hostSig });
}

/** 提交 + 节点主设置抽成 + 店主签 + 节点主签，返回完整回执 */
async function fullFlow(seller, bps = 300) {
  const submitted = await submit(await tokenFor(seller), { name: '双签店' }).expect(200);
  assertOk(submitted);
  const id = submitted.body.data.id;

  const approved = await approve(id, bps).expect(200);
  assertOk(approved);
  const application = approved.body.data.application;
  assert.ok(application.digest, '审批后必须下发当前票据摘要');

  assertOk(await sellerSign(id, await tokenFor(seller), await walletSign(seller, application.digest)).expect(200));
  const signed = await hostSign(id, await walletSign(owner, application.digest)).expect(200);
  assertOk(signed);
  return { id, application, signed };
}

test('① 抽成由节点主设置：店主提交时没有抽成、没有签名', async () => {
  const seller = newWallet();
  const res = await submit(await tokenFor(seller), { name: '无签名提交' }).expect(200);
  assertOk(res);
  const a = res.body.data;
  assert.equal(a.status, 'pending');
  assert.equal(a.commissionBps, 0, '申请阶段不填抽成');
  assert.equal(a.hasSellerSig, false, '申请阶段不需要店主签名');
  assert.equal(a.commissionTo, '', 'bps=0 时没有收款腿');
  assert.equal(a.host.toLowerCase(), owner.address.toLowerCase());
});

test('② 完整顺序：节点主设置抽成 → 店主签 → 节点主签 ⇒ call.args 两半签名都对', async () => {
  const seller = newWallet();
  const { application, signed } = await fullFlow(seller, 300);
  const args = signed.body.data.call?.args;
  assert.ok(Array.isArray(args) && args.length === 5, 'call.args 必须是 registerShop 的五个参数');
  assert.equal(String(args[0]).toLowerCase(), seller.address.toLowerCase(), '第 1 项：店主');
  assert.equal(args[1], 300, '第 2 项：节点主设置的抽成');
  assert.equal(args[2], Math.floor(new Date(application.deadline).getTime() / 1000), '第 3 项：unix 秒');
  assert.equal(recoverTicketSigner(application.digest, args[3]), owner.address.toLowerCase(), '节点主签名');
  assert.equal(recoverTicketSigner(application.digest, args[4]), seller.address.toLowerCase(), '店主签名');
});

test('③ 节点主设置前店主不能签；节点主在店主签之前也不能签', async () => {
  const seller = newWallet();
  const token = await tokenFor(seller);
  const submitted = await submit(token).expect(200);
  const id = submitted.body.data.id;

  const early = await request(app)
    .post(`/api/shops/applications/${id}/seller-sign`)
    .set('Authorization', `Bearer ${token}`)
    .send({ sellerSig: '0x' + '11'.repeat(65) })
    .expect(409);
  assert.match(String(early.body.message), /审批/);

  const approved = await approve(id, 100).expect(200);
  const digest = approved.body.data.application.digest;
  const hostTooEarly = await hostSign(id, await walletSign(owner, digest)).expect(409);
  assert.match(String(hostTooEarly.body.message), /等待店主签署条款/);

  // 店主签完节点主才能签
  assertOk(await sellerSign(id, token, await walletSign(seller, digest)).expect(200));
  assertOk(await hostSign(id, await walletSign(owner, digest)).expect(200));
});

test('④ 店主签名者必须是申请人本人；节点主设置的抽成不能是店主的自报值', async () => {
  const seller = newWallet();
  const submitted = await submit(await tokenFor(seller)).expect(200);
  const id = submitted.body.data.id;
  const approved = await approve(id, 250).expect(200);
  const application = approved.body.data.application;

  const attacker = newWallet();
  const wrong = await request(app)
    .post(`/api/shops/applications/${id}/seller-sign`)
    .set('Authorization', `Bearer ${await tokenFor(attacker)}`)
    .send({ sellerSig: await walletSign(attacker, application.digest) })
    .expect(403);
  assert.match(String(wrong.body.message), /申请人/);

  const wrongSigner = await request(app)
    .post(`/api/shops/applications/${id}/seller-sign`)
    .set('Authorization', `Bearer ${await tokenFor(seller)}`)
    .send({ sellerSig: await walletSign(attacker, application.digest) })
    .expect(200);
  assert.notEqual(wrongSigner.body.code, 0, '签名者不是申请人时必须拒绝');
});

test('⑤ 店主签完后节点主不能再改抽成；要改只能驳回重来', async () => {
  const seller = newWallet();
  const submitted = await submit(await tokenFor(seller)).expect(200);
  const id = submitted.body.data.id;
  const approved = await approve(id, 200).expect(200);
  const digest = approved.body.data.application.digest;
  assertOk(await sellerSign(id, await tokenFor(seller), await walletSign(seller, digest)).expect(200));

  const res = await approve(id, 900).expect(409);
  assert.match(String(res.body.message), /已经对当前条款签名/);
  const row = await db.get('SELECT commission_bps FROM shop_applications WHERE id = ?', id);
  assert.equal(Number(row.commission_bps), 200, '已签条款不能被覆盖');
});

test('⑥ 篡改 seller_sig 后节点主签名/核验都必须拒绝', async () => {
  const seller = newWallet();
  const submitted = await submit(await tokenFor(seller)).expect(200);
  const id = submitted.body.data.id;
  const approved = await approve(id, 150).expect(200);
  const application = approved.body.data.application;
  assertOk(await sellerSign(id, await tokenFor(seller), await walletSign(seller, application.digest)).expect(200));

  const wrong = await walletSign(newWallet(), application.digest);
  await db.run('UPDATE shop_applications SET seller_sig = ? WHERE id = ?', wrong, id);

  const hostRes = await hostSign(id, await walletSign(owner, application.digest)).expect(409);
  assert.match(String(hostRes.body.message), /店主签名/);

  const verifyRes = await request(app)
    .post(`/api/shops/applications/${id}/verify-onchain`)
    .set('Authorization', `Bearer ${await tokenFor(owner)}`)
    .send({ txHash: '0x' + 'ab'.repeat(32) })
    .expect(409);
  assert.match(String(verifyRes.body.message), /店主签名/);
});

test('⑦ 自营店（店主 = 节点主）节点主设置抽成 >0 必须被拒', async () => {
  /*
    `makeCtx` 里 owner 已经有一家自营店，正常提交会被“已有店铺”挡在更早一步；
    这里直接造一条 pending 申请，专测审批时的自营店抽成判据。
  */
  const id = Number(
    (
      await db.run(
        `INSERT INTO shop_applications (seller, host, name, notice, commission_bps, deadline, status)
         VALUES (?, ?, '自营', '', 0, ?, 'pending')`,
        owner.address.toLowerCase(),
        owner.address.toLowerCase(),
        new Date(Date.now() + 3600_000)
      )
    ).insertId
  );
  const res = await approve(id, 1).expect(200);
  assert.notEqual(res.body.code, 0);
  assert.match(String(res.body.message), /自营店/);
});

test('⑧ 审批必须显式设置合法 commissionBps', async () => {
  const submitted = await submit(await tokenFor(newWallet())).expect(200);
  const id = submitted.body.data.id;
  const hostToken = await tokenFor(owner);

  const missing = await request(app)
    .post(`/api/shops/applications/${id}/review`)
    .set('Authorization', `Bearer ${hostToken}`)
    .send({ action: 'approve' })
    .expect(200);
  assert.notEqual(missing.body.code, 0);
  assert.match(String(missing.body.message), /commissionBps/);

  const tooHigh = await request(app)
    .post(`/api/shops/applications/${id}/review`)
    .set('Authorization', `Bearer ${hostToken}`)
    .send({ action: 'approve', commissionBps: 1001 })
    .expect(200);
  assert.notEqual(tooHigh.body.code, 0);
});

test('⑨ 队列 hostOnly；「我的申请」按登录地址收窄，含驳回原因', async () => {
  const seller = newWallet();
  const token = await tokenFor(seller);
  const submitted = await submit(token, { name: '待驳回' }).expect(200);
  const id = submitted.body.data.id;

  const denied = await request(app).get('/api/shops/applications/list').set('Authorization', `Bearer ${token}`);
  assert.equal(denied.status, 403, '非节点主读队列必须 403');

  assertOk(
    await request(app)
      .post(`/api/shops/applications/${id}/review`)
      .set('Authorization', `Bearer ${await tokenFor(owner)}`)
      .send({ action: 'reject', reason: '条款再谈谈' })
      .expect(200)
  );

  const all = await request(app)
    .get('/api/shops/applications/mine?all=1')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  const row = all.body.data.applications.find((a) => a.id === id);
  assert.ok(row);
  assert.equal(row.status, 'rejected');
  assert.equal(row.rejectReason, '条款再谈谈');

  const other = await request(app)
    .get('/api/shops/applications/mine?all=1')
    .set('Authorization', `Bearer ${await tokenFor(newWallet())}`)
    .expect(200);
  assert.deepEqual(other.body.data.applications, []);
});

test('⑩ 一个地址只能有一条未终结申请；墓碑店可重新申请', async () => {
  const seller = newWallet();
  const token = await tokenFor(seller);
  assertOk(await submit(token, { name: '第一条' }).expect(200));
  const second = await submit(token, { name: '第二条' }).expect(409);
  assert.match(String(second.body.message), /已有一条未终结的开店申请/);

  const tombSeller = newWallet();
  await db.run(
    `INSERT INTO shops (code, seller, name, notice, listed, commission_bps, registered_at_block, exited_at_block)
     VALUES (?, ?, '', '', 0, 0, 10, 20)`,
    '0000TOMB1',
    tombSeller.address.toLowerCase()
  );
  await db.run(
    `INSERT INTO shop_applications (seller, host, name, notice, commission_bps, deadline, status)
     VALUES (?, ?, '', '', 0, ?, 'registered')`,
    tombSeller.address.toLowerCase(),
    owner.address.toLowerCase(),
    new Date(Date.now() + 3600_000)
  );
  const res = await submit(await tokenFor(tombSeller), { name: '重开' }).expect(200);
  assertOk(res);
  assert.equal(res.body.data.status, 'pending');
});

test.after(async () => {
  await db.run('SELECT 1');
});
