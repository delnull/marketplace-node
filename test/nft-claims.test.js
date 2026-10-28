/**
 * NFT 提货声明（节点链下数据面 + 提货争议参数生成）。
 *
 * 判据链（见 src/nftClaim.js）：token 在本节点被交付过 → 商品开了提货 → 在窗口内 →
 * 提交人是**当前持有人** → 一枚 token 同时只有一条未完结声明。
 *
 * 链上持有人用注入点模拟（`setNftOwnershipReader`）：单测不起 RPC，否则一切都会卡在
 * "读不到持有人 ⇒ fail-closed"这条正确但测不到主路径的分支上。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, shopRef, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const { setNftOwnershipReader } = await import('../src/nftClaim.js');

const NFT = '0x' + 'ab'.repeat(20);
const buyer2 = Wallet.createRandom();

/** 链上当前持有人（按地址；`null` = 读不到） */
let currentOwner = buyer.address.toLowerCase();
setNftOwnershipReader(async ({ claimant }) => {
  if (currentOwner === null) return { owned: null, detail: 'unit-test: RPC 读不到' };
  return { owned: String(claimant).toLowerCase() === currentOwner, detail: '' };
});

let ownerToken;
let buyerToken;
let buyer2Token;
let slug;
let order;
const tokens = ['1', '2', '3'];

async function createNftProduct({ claimWindowDays, windowDays = 30 } = {}) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(
      productPayload({
        kind: 'nft',
        title: '提货测试 NFT',
        nftContract: NFT,
        nftStandard: 'erc721',
        claimable: true,
        claimType: 'physical',
        claimWindowDays: windowDays,
        claimInstructions: '请提供收货地址，7 个工作日内发出',
      })
    )
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 造一张"已完成且交付了 token"的订单（交付行是提货声明的唯一前置事实） */
async function deliverToken(targetSlug, tokenId, who = buyer.address, ageMs = 3600_000) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: targetSlug, buyer: who })
    .expect(200);
  assertOk(res);
  const o = res.body.data;
  const at = new Date(Date.now() - ageMs);
  await db.run("UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_no = ?", at, o.id);
  await db.run(
    'INSERT INTO order_delivery_items (order_id, kind, value, tx_hash) SELECT id, ?, ?, ? FROM orders WHERE order_no = ?',
    'nft',
    tokenId,
    '0x' + crypto.randomBytes(32).toString('hex'),
    o.id
  );
  return o;
}

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  buyer2Token = (await login(ctx, buyer2)).token;
  const p = await createNftProduct();
  slug = p.slug;
  const imp = await request(app)
    .post(`/api/products/${slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ tokens })
    .expect(200);
  assertOk(imp);
  order = await deliverToken(slug, '1');
});

const submit = (token, body) =>
  request(app).post('/api/claims/nft').set('Authorization', `Bearer ${token}`).send(body);

const body = (tokenId, over = {}) => ({
  nftContract: NFT,
  tokenId,
  shipping: { name: '张三', phone: '13800000000', address: '北京市朝阳区 1 号' },
  ...over,
});

test('提货声明的判据链：未交付的 token 拒绝；非持有人拒绝；未开提货拒绝', async () => {
  const notDelivered = await submit(buyerToken, body('99')).expect(200);
  assert.notEqual(notDelivered.body.code, 0);
  assert.match(notDelivered.body.message, /没有在本节点的已完成订单里交付过/);

  currentOwner = buyer2.address.toLowerCase();
  const notHolder = await submit(buyerToken, body('1')).expect(200);
  assert.notEqual(notHolder.body.code, 0);
  assert.match(notHolder.body.message, /不是这枚 NFT 的当前持有人/);
  currentOwner = buyer.address.toLowerCase();

  // 读不到持有人 ⇒ fail-closed（503，不是放行）
  currentOwner = null;
  const unreadable = await submit(buyerToken, body('1')).expect(200);
  assert.notEqual(unreadable.body.code, 0);
  assert.match(unreadable.body.message, /读不到链上 NFT 持有人/);
  currentOwner = buyer.address.toLowerCase();

  // 商品没开提货 ⇒ 拒绝（另一件 NFT 商品，claimable=false）
  const off = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'nft', title: '无提货 NFT', nftContract: '0x' + 'cd'.repeat(20), nftStandard: 'erc721' }))
    .expect(200);
  assertOk(off);
  await request(app)
    .post(`/api/products/${off.body.data.slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ tokens: ['7'] })
    .expect(200);
  const o = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: off.body.data.slug, buyer: buyer.address })
    .expect(200);
  await db.run("UPDATE orders SET status = 'confirmed' WHERE order_no = ?", o.body.data.id);
  await db.run(
    'INSERT INTO order_delivery_items (order_id, kind, value, tx_hash) SELECT id, ?, ?, ? FROM orders WHERE order_no = ?',
    'nft',
    '7',
    '0x' + '7'.padStart(64, '0'),
    o.body.data.id
  );
  const noClaim = await submit(buyerToken, {
    nftContract: '0x' + 'cd'.repeat(20),
    tokenId: '7',
    shipping: { name: '张三', phone: '13800000000', address: '北京' },
  }).expect(200);
  assert.notEqual(noClaim.body.code, 0);
  assert.match(noClaim.body.message, /没有开启提货兑付/);
});

let claimId;
test('提交 → 公开状态（无 PII）→ 我的提货行 → 一枚 token 只能有一条未完结声明', async () => {
  const res = await submit(buyerToken, body('1')).expect(200);
  assertOk(res);
  claimId = res.body.data.id;
  assert.match(claimId, /^C[0-9A-HJKMNP-TV-Z]{20}$/, '对外声明号与订单号同一套 Crockford 格式');
  assert.equal(res.body.data.status, 'requested');
  assert.equal(res.body.data.nftContract, NFT);
  assert.equal(res.body.data.seller, owner.address.toLowerCase());
  assert.equal(res.body.data.claimant, buyer.address.toLowerCase());
  assert.equal(res.body.data.orderNo, order.id);
  assert.equal(res.body.data.claimId, null, '未开链上争议时 claimId = null');
  assert.equal(res.body.data.tokenRef, (await import('../src/nftClaim.js')).tokenRefOf(NFT, '1'));

  // 公开状态：同一条 token 可匿名查，但**不含收货信息**
  const pub = await request(app).get(`/api/claims/nft?contract=${NFT}&tokenId=1`).expect(200);
  assert.equal(pub.body.data.claims.length, 1);
  const row = pub.body.data.claims[0];
  assert.equal(row.id, claimId);
  assert.equal(row.shipping, null, '公开面绝不下发收货信息');
  assert.equal(row.status, 'requested');

  // 我的提货行（含自己填的收货信息）
  const mine = await request(app).get('/api/claims/nft/mine').set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(mine.body.data.claims.length, 1);
  assert.deepEqual(mine.body.data.claims[0].shipping, { name: '张三', phone: '13800000000', address: '北京市朝阳区 1 号' });

  // 同一枚 token 再来一条 ⇒ 409（库里的函数唯一索引兜底，并发下也拦得住）
  const dup = await submit(buyerToken, body('1')).expect(200);
  assert.notEqual(dup.body.code, 0);
  assert.match(dup.body.message, /未完结的提货声明/);
});

test('卖家动作：approve → ship（发货前复核持有人）→ fulfill；转手则拒绝发货并允许取消', async () => {
  const approve = await request(app)
    .post(`/api/claims/nft/${claimId}/seller`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'approve' })
    .expect(200);
  assertOk(approve);
  assert.equal(approve.body.data.status, 'approved');

  // 发货前 token 被转走：拒绝发货（A-policy：声明绑定提交人，货不能发给已转手的人）
  currentOwner = buyer2.address.toLowerCase();
  const moved = await request(app)
    .post(`/api/claims/nft/${claimId}/seller`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'ship', trackingNo: 'SF123' })
    .expect(200);
  assert.notEqual(moved.body.code, 0);
  assert.match(moved.body.message, /已不在提交人名下/);

  // 卖家取消 ⇒ 让位给新持有人
  const cancel = await request(app)
    .post(`/api/claims/nft/${claimId}/seller`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'cancel' })
    .expect(200);
  assertOk(cancel);
  assert.equal(cancel.body.data.status, 'cancelled');

  // 新持有人可以重新提（唯一索引只压未完结状态）
  currentOwner = buyer2.address.toLowerCase();
  const again = await submit(buyer2Token, body('1')).expect(200);
  assertOk(again);
  const newId = again.body.data.id;
  assert.notEqual(newId, claimId);

  // 正常路径：approve → ship → fulfill
  for (const [action, extra] of [
    ['approve', {}],
    ['ship', { trackingNo: 'SF999' }],
    ['fulfill', {}],
  ]) {
    const r = await request(app)
      .post(`/api/claims/nft/${newId}/seller`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ action, ...extra })
      .expect(200);
    assertOk(r);
    assert.equal(r.body.data.status, action === 'approve' ? 'approved' : action === 'ship' ? 'shipped' : 'fulfilled');
  }

  // 已兑付 ⇒ 同一枚 token 不能再提
  const afterFulfilled = await submit(buyer2Token, body('1')).expect(200);
  assert.notEqual(afterFulfilled.body.code, 0);
  assert.match(afterFulfilled.body.message, /已兑付过/);
});

test('提货窗口：自交付订单终局起算，过期后拒绝（窗口 NULL = 不限期）', async () => {
  const p = await createNftProduct({ windowDays: 1 });
  await request(app)
    .post(`/api/products/${p.slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ tokens: ['5'] })
    .expect(200);
  // 交付行终局时刻 = 3 天前 > 1 天窗口
  await deliverToken(p.slug, '5', buyer.address, 3 * 24 * 3600_000);
  currentOwner = buyer.address.toLowerCase();
  const res = await submit(buyerToken, { nftContract: NFT, tokenId: '5', shipping: { name: '张三', phone: '138', address: '北京' } }).expect(200);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /提货窗口已于/);
});

test('提货争议参数：nodeAdmin 生成 openClaimDispute 的 call（记下 claimId、不广播）', async () => {
  // 用第一枚 token 的"已取消"声明不满足前置（状态不开放）；另造一条 requested 的
  const p = await createNftProduct();
  await request(app)
    .post(`/api/products/${p.slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ tokens: ['6'] })
    .expect(200);
  const o = await deliverToken(p.slug, '6');
  currentOwner = buyer.address.toLowerCase();
  const c = await submit(buyerToken, { nftContract: NFT, tokenId: '6', shipping: { name: '张三', phone: '138', address: '北京' } }).expect(200);
  assertOk(c);

  // 未登录/买家令牌 ⇒ 403（nodeAdmin：节点主或本节点员工）
  const anon = await request(app).post(`/api/claims/nft/${c.body.data.id}/dispute`).send({ amountWei: '1' });
  assert.equal(anon.status, 401);
  const asBuyer = await request(app)
    .post(`/api/claims/nft/${c.body.data.id}/dispute`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ amountWei: '1' });
  assert.equal(asBuyer.status, 403);

  const res = await request(app)
    .post(`/api/claims/nft/${c.body.data.id}/dispute`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ amountWei: o.amountWei })
    .expect(200);
  assertOk(res);
  const call = res.body.data;
  assert.equal(call.fn, 'openClaimDispute');
  assert.equal(call.args.length, 7);
  assert.equal(call.args[0], call.claimId);
  assert.equal(call.args[3], owner.address.toLowerCase(), 'seller');
  assert.equal(call.args[4], buyer.address.toLowerCase(), 'claimant');
  assert.equal(call.args[5], o.amountWei, 'amountWei');
  assert.match(String(call.args[6]), /^\d+$/);

  // claimId 已记进本地行（watcher 之后按它把链上结论写回）
  const row = await db.get('SELECT dispute_claim_id, dispute_state FROM nft_claims WHERE claim_no = ?', c.body.data.id);
  assert.equal(row.dispute_claim_id, call.claimId);
  assert.equal(row.dispute_state, 'none', '还没上链：本地不假装已开案');
});

test('提货争议关闭后不能重新生成参数；ClaimClosed 回写实际赔付额', async () => {
  const p = await createNftProduct();
  await request(app)
    .post(`/api/products/${p.slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ tokens: ['7'] })
    .expect(200);
  const o = await deliverToken(p.slug, '7');
  currentOwner = buyer.address.toLowerCase();
  const c = await submit(buyerToken, { nftContract: NFT, tokenId: '7', shipping: { name: '李四', phone: '139', address: '上海' } }).expect(200);
  assertOk(c);

  const prepared = await request(app)
    .post(`/api/claims/nft/${c.body.data.id}/dispute`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ amountWei: o.amountWei })
    .expect(200);
  assertOk(prepared);
  const claimId = prepared.body.data.claimId;

  await db.run("UPDATE nft_claims SET dispute_state = 'closed' WHERE claim_no = ?", c.body.data.id);
  const closed = await db.get('SELECT dispute_state FROM nft_claims WHERE claim_no = ?', c.body.data.id);
  assert.equal(closed.dispute_state, 'closed');
  const again = await request(app)
    .post(`/api/claims/nft/${c.body.data.id}/dispute`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ amountWei: o.amountWei });
  assert.equal(again.status, 409, '已关闭的争议不得再次生成参数');

  const { applyEvent } = await import('../src/escrowWatcher.js');
  await db.run("UPDATE nft_claims SET dispute_state = 'opened', claim_amount_wei = ? WHERE claim_no = ?", o.amountWei, c.body.data.id);
  await applyEvent('ClaimClosed', { claimId, amountWei: '55', claimant: buyer.address.toLowerCase() });
  const row = await db.get('SELECT claim_amount_wei, dispute_state, status FROM nft_claims WHERE claim_no = ?', c.body.data.id);
  assert.equal(row.dispute_state, 'closed');
  assert.equal(row.status, 'fulfilled', '有赔付的争议必须占住 fulfilled 槽位，防二次兑付');
  assert.equal(String(row.claim_amount_wei), '55', '卖家看到的应是实际赔付额，不是开案请求额');
});

test('提货卖家列表包含本店店员（与处理动作同一授权面）', async () => {
  const staff = Wallet.createRandom();
  const add = await request(app)
    .put('/api/shop/staff')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ action: 'add', address: staff.address })
    .expect(200);
  assertOk(add);

  const p = await createNftProduct();
  await request(app)
    .post(`/api/products/${p.slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ tokens: ['9'] })
    .expect(200);
  await deliverToken(p.slug, '9');
  currentOwner = buyer.address.toLowerCase();
  const c = await submit(buyerToken, { nftContract: NFT, tokenId: '9', shipping: { name: '赵六', phone: '136', address: '深圳' } }).expect(200);
  assertOk(c);

  const staffToken = (await login(ctx, staff)).token;
  const acted = await request(app)
    .post(`/api/claims/nft/${c.body.data.id}/seller`)
    .set('Authorization', `Bearer ${staffToken}`)
    .send({ action: 'approve' })
    .expect(200);
  assertOk(acted);
  const list = await request(app)
    .get('/api/claims/nft/seller')
    .set('Authorization', `Bearer ${staffToken}`)
    .expect(200);
  assertOk(list);
  assert.ok(list.body.data.claims.some((row) => row.id === c.body.data.id), '店员必须看得到本店提货行');

  const removed = await request(app)
    .put('/api/shop/staff')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ action: 'remove', address: staff.address })
    .expect(200);
  assertOk(removed);
  const after = await request(app)
    .get('/api/claims/nft/seller')
    .set('Authorization', `Bearer ${staffToken}`)
    .expect(200);
  assertOk(after);
  assert.ok(!after.body.data.claims.some((row) => row.id === c.body.data.id), '移除店员后立即失去列表可见性');
});

test('零赔付结案/撤销争议必须释放声明占位，不能把 token 永久锁死', async () => {
  const p = await createNftProduct();
  await request(app)
    .post(`/api/products/${p.slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ tokens: ['8'] })
    .expect(200);
  const o = await deliverToken(p.slug, '8');
  currentOwner = buyer.address.toLowerCase();
  const c = await submit(buyerToken, { nftContract: NFT, tokenId: '8', shipping: { name: '王五', phone: '137', address: '广州' } }).expect(200);
  assertOk(c);

  const prepared = await request(app)
    .post(`/api/claims/nft/${c.body.data.id}/dispute`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ amountWei: o.amountWei })
    .expect(200);
  assertOk(prepared);
  const { applyEvent } = await import('../src/escrowWatcher.js');
  await db.run("UPDATE nft_claims SET dispute_state = 'opened' WHERE claim_no = ?", c.body.data.id);
  await applyEvent('ClaimClosed', { claimId: prepared.body.data.claimId, amountWei: '0', claimant: buyer.address.toLowerCase() });

  const row = await db.get('SELECT claim_amount_wei, dispute_state, status FROM nft_claims WHERE claim_no = ?', c.body.data.id);
  assert.equal(row.dispute_state, 'closed');
  assert.equal(row.status, 'rejected', '零赔付结案不得继续占 requested 槽位');
  assert.equal(row.claim_amount_wei, null, 'CHECK(claim_amount_wei > 0) 下零赔付必须写 NULL');

  // 同一枚 token 仍可由当前持有人重新提交（旧案已让位）
  const again = await submit(buyerToken, { nftContract: NFT, tokenId: '8', shipping: { name: '王五', phone: '137', address: '广州' } }).expect(200);
  assertOk(again);
  await db.run("UPDATE nft_claims SET dispute_state = 'opened', dispute_claim_id = ? WHERE claim_no = ?", prepared.body.data.claimId, again.body.data.id);
  await applyEvent('ClaimDisputeCancelled', { claimId: prepared.body.data.claimId, reason: 'settled' });
  const cancelled = await db.get('SELECT claim_amount_wei, status, dispute_state FROM nft_claims WHERE claim_no = ?', again.body.data.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.dispute_state, 'cancelled');
  assert.equal(cancelled.claim_amount_wei, null);
});
