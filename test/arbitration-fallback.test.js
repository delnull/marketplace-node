/**
 * 仲裁人视角安全降级：节点读不到链上委员会时，详情接口不把任何登录地址视为仲裁人，
 * 宁可拒绝开放视角（交付码不泄露），店主兜底视角不受影响。
 *
 * 2026-10-14 补第二条：**"读到过一次、之后读不到"**也必须拒绝。
 * 旧实现在失败时回退"上一次成功读到的地址" ⇒ 只要 RPC 一直不可用，它就一直把旧地址
 * 当成当前仲裁人。两个消费方都是鉴权（详情开码 `routes/orders.js` 与附件下载
 * `routes/evidenceFiles.js`），于是一次换届之后，**被解除的密钥在 RPC 故障期间仍能读到
 * 收货信息、交付码与双方售后陈述**。
 *
 * 2026-10-18：单仲裁人 → 多仲裁人 + 阈值，"当前是谁"变成"当前届名单"。
 * 本文件用 `chain.setCommitteeReader` 注入取值的三种现场（读到/读不到/换届后读不到），
 * 判据与控制流仍是被测的真实代码。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const arbiter = Wallet.createRandom();
const arbiterOnchain = arbiter.address.toLowerCase();

const {
  setCommitteeReader,
  getCommittee,
  isArbiterAddress,
  committeeStatus,
  __resetCommitteeCacheForTest,
  __expireCommitteeCacheForTest,
} = await import('../src/chain.js');

/** true = 模拟"读不到链上委员会" */
let readFails = false;
/** 当前届名单（换届用例会替换它） */
let members = [arbiterOnchain];

setCommitteeReader(async () => {
  if (readFails) throw new Error('unit-test: RPC 读不到委员会');
  return { arbiters: members, threshold: 1, epoch: 1 };
});
after(() => {
  setCommitteeReader(null);
  __resetCommitteeCacheForTest();
});

let ownerToken;
let arbiterToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  arbiterToken = (await login(ctx, arbiter)).token;
  assert.ok(ownerToken && arbiterToken);
});

const { applyEvent } = await import('../src/escrowWatcher.js');

/** 造一张"已交付码 + 已进入争议"的单（码仅在确证仲裁人后开放） */
let paySeq = 0;
async function disputedOrderWithCode(title) {
  const res0 = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title }))
    .expect(200);
  assertOk(res0);
  const draftRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: res0.body.data.slug, buyer: buyer.address })
    .expect(200);
  assertOk(draftRes);
  const order = draftRes.body.data;
  // 模拟 watcher/paid 回写：escrowed 必落链上支付凭证（发货防呆要求，见 orders.js 头注释）。
  // 哈希必须**逐单不同**：paid_tx_hash 上有唯一索引（同一笔链上托管只能确认一单）。
  paySeq += 1;
  const paidTxHash = `0x${String(paySeq).padStart(64, 'e')}`;
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), order.id);
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', paidTxHash, order.id);
  // 卖家手动交付码后买家发起争议（shipped → disputed，含码的争议单）
  const shipRes = await request(app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ deliveryCode: 'CARD-888' })
    .expect(200);
  assertOk(shipRes);
  assert.equal(await applyEvent('DisputeRequested', { orderId: order.escrowOrderId }), 1);
  return order;
}

/** 取详情并断言 code=0 */
async function detailAs(token, id) {
  const r = await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(r);
  return r.body.data;
}

test('RPC 读不到委员会：仲裁人登录也不开放交付码（安全降级）', async () => {
  __resetCommitteeCacheForTest(); // 每个用例从"没读到过"开始（60s 缓存是生产语义，用例不该互相继承）
  readFails = true; // 本用例的现场：读不到
  members = [arbiterOnchain];
  const order = await disputedOrderWithCode('降级仲裁数字商品');

  // 待仲裁列表正常公开（降级只影响「仲裁人视角」的数据开放，不影响公开摘要）
  const pendRes = await request(app).get('/api/arbitration/pending').expect(200);
  assertOk(pendRes);
  assert.equal(pendRes.body.data.total, 1);
  assert.equal(pendRes.body.data.disputes[0].delivered, true);

  // 仲裁人令牌访问详情：读不到委员会 → 无法确证其为当前届成员 → 码不开放
  const arbDetail = await detailAs(arbiterToken, order.id);
  assert.equal(arbDetail.status, 'disputed', '公开字段仍可读');
  assert.deepEqual(arbDetail.deliveries, [], '未确证仲裁人身份前不泄露码');

  // 店主兜底不受影响（卖家本来持有码，追索/回收权限不依赖仲裁人判定）
  const ownerDetail = await detailAs(ownerToken, order.id);
  assert.equal(ownerDetail.deliveries[0].value, 'CARD-888', '店主视角不受降级影响');
});

/**
 * 这条是 2026-10-14 修的缺陷的回归闸：**"读到过一次、之后读不到"不得沿用旧值**。
 * 三段断言缺一不可：
 *   ① 确证能读到 A 时 A 确实开放（否则这条用例可能因为"根本没读到过"而侥幸通过）；
 *   ② 换届（A 被解除）+ 读不到之后，A 不再被当成仲裁人（旧实现在这里仍然开放）；
 *   ③ 诊断读数如实说"读不到"，而不是把它显示成某个具体名单。
 */
test('读到过一次之后 RPC 故障：不得把上一届成员当成当前仲裁人', async () => {
  __resetCommitteeCacheForTest();
  readFails = false;
  members = [arbiterOnchain];
  const order = await disputedOrderWithCode('换届后降级数字商品');

  assert.deepEqual(await getCommittee(), { arbiters: [arbiterOnchain], threshold: 1, epoch: 1 }, '确证能读到');
  assert.equal(await isArbiterAddress(arbiterOnchain), true, '当前届成员');
  const confirmed = await detailAs(arbiterToken, order.id);
  assert.equal(confirmed.deliveries[0]?.value, 'CARD-888', '确证为仲裁人时，争议单的码对它开放');

  /*
    现场 ②：先让 60s 正缓存自然过期**而不清史**（`lastOk` 必须留着），再让读取开始持续失败。
    顺序是关键：这条用例要验证的正是"缓存跨过一次成功、一次失败之后"的表现。
  */
  __expireCommitteeCacheForTest();
  readFails = true;

  // ② 读不到 ⇒ 谁都不是仲裁人（旧实现在这里会拿 ① 的地址顶上，仍然开放）
  assert.equal(await getCommittee(), null, '读不到 ⇒ 判定值必须是 null，不是上次成功值');
  assert.equal(await isArbiterAddress(arbiterOnchain), false, '读不到 ⇒ 不把任何人当仲裁人');
  const afterFail = await detailAs(arbiterToken, order.id);
  assert.deepEqual(afterFail.deliveries, [], '旧成员密钥在 RPC 故障期间不得再读到交付码');

  // ③ 诊断读数：known=false；lastOk 只作"最后读到过谁"的排障线索，不参与判定
  const st = committeeStatus();
  assert.equal(st.known, false, '读不到必须能作为一个独立结论被看见');
  assert.equal(st.committee, null, '判定值不得显示成某个具体名单');
  assert.deepEqual(st.lastOk?.arbiters, [arbiterOnchain], '最后一次成功读数留作排障线索');
});
