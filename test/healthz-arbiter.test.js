/**
 * `/healthz` 必须能看见"委员会读数读不到"（2026-10-14 起；2026-10-18 改为多仲裁人）。
 *
 * 背景：`getCommittee()` 在**读不到**时返回 `null`（= 谁都不是仲裁人），这是刻意的安全方向
 * ——否则 RPC 故障期间一把**已被解除**的旧仲裁人密钥仍能读到收货信息、交付码与双方售后陈述。
 * 但那个方向的代价是「合法的仲裁人在抖动期间也进不来」，而在此之前这个状态**只能靠翻日志**看：
 * `/healthz` 一切正常、仲裁人只看到自己被拒，运维无从区分"你不是仲裁人"与"节点读不到"。
 *
 * 判据（两半）：① 读不到时 `known=false` 且 `committee=null`（不得显示成某几个人）；
 *              ② 确证读到时 `known=true` 且给出当前届名单与阈值。
 *
 * 装配注记：用 `chain.setCommitteeReader` 注入点替换**取值**（与 `setBlocklistReader` 同款），
 * 判据与控制流仍是被测的真实代码；不需要假 JSON-RPC，也就不存在"provider 单例指向旧地址"那一类问题。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, assertOk, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;

const arbiter = Wallet.createRandom();
const arbiterOnchain = arbiter.address.toLowerCase();
const arbiter2 = Wallet.createRandom().address.toLowerCase();

const {
  setCommitteeReader,
  getCommittee,
  committeeStatus,
  __resetCommitteeCacheForTest,
} = await import('../src/chain.js');

/** true = 这一轮模拟"RPC 读不到委员会" */
let readFails = true;

setCommitteeReader(async () => {
  if (readFails) throw new Error('unit-test: RPC 读不到委员会');
  return { arbiters: [arbiterOnchain, arbiter2], threshold: 2, epoch: 3 };
});

after(() => {
  setCommitteeReader(null);
  __resetCommitteeCacheForTest();
});

const health = async () => {
  const r = await request(app).get('/healthz').expect(200);
  assertOk(r);
  return r.body.data;
};

test('/healthz：委员会读不到时必须显式说"读不到"（known=false, committee=null）', async () => {
  readFails = true;
  __resetCommitteeCacheForTest();

  // 先走一次真实的读取路径（鉴权点就是这么读的）：读到的是"不知道"
  assert.equal(await getCommittee(), null, '读不到 ⇒ null（谁都不是仲裁人）');

  const h = await health();
  assert.ok(h.committee, 'healthz 必须有 committee 这一块（否则运维只能翻日志）');
  assert.equal(h.committee.known, false, '读不到 ⇒ known=false（这是一个独立结论，不是某个地址）');
  assert.equal(h.committee.committee, null, '读不到时不得显示成某个具体名单');
  assert.equal(h.committee.lastOk, null, '从未成功读到过 ⇒ 没有"最后一次成功读数"');
});

test('/healthz：确证读到委员会时给出名单/阈值与 known=true', async () => {
  readFails = false;
  __resetCommitteeCacheForTest();
  const c = await getCommittee();
  assert.deepEqual(c, { arbiters: [arbiterOnchain, arbiter2], threshold: 2, epoch: 3 }, '确证读到');

  const h = await health();
  assert.equal(h.committee.known, true, '确证 ⇒ known=true');
  assert.deepEqual(h.committee.committee.arbiters, [arbiterOnchain, arbiter2]);
  assert.equal(h.committee.committee.threshold, 2);
  assert.equal(h.committee.committee.epoch, 3);
  assert.equal(h.committee.lastOk?.threshold, 2, '最后一次成功读数可查（排障线索）');
  assert.deepEqual(committeeStatus().committee.arbiters, [arbiterOnchain, arbiter2]);
});

/**
 * `/healthz` 也要能看见"下单超时窗口这次没校验成"（2026-10-14 独立评审后补）。
 *
 * 背景：`checkOrderTimeoutBounds` 在启动期只跑一次，而它的 `unknown` 档
 * （读不到链上界 / 配置值非法）**刻意不阻断启动**——否则一次 RPC 抖动就能停掉一个配置正确的节点。
 * 代价是"这次没校验成"必须有个地方能看见，否则它随启动日志一起丢了；
 * 而真越界的配置会让**每一笔下单**都在买家钱包里 revert（店面看起来完全正常）。
 */
test('/healthz：暴露下单超时窗口自检结论（含"没校验成"这一档）', async () => {
  const { setOrderTimeoutSelfCheck } = await import('../src/chain.js');

  // 未跑过（例如未配置 MK_ESCROW_ADDRESS 的分支）⇒ null，不是"通过"
  setOrderTimeoutSelfCheck(null);
  assert.equal((await health()).orderTimeout, null, '没跑过就是 null，不得伪装成 ok');

  // unknown 档：如实转达，且**不是** ok
  setOrderTimeoutSelfCheck({
    verdict: 'unknown',
    reason: 'unreadable',
    configured: 120960,
    min: null,
    max: null,
    message: '读不到链上下单超时窗口的上下界',
  });
  const unknown = (await health()).orderTimeout;
  assert.equal(unknown.verdict, 'unknown');
  assert.equal(unknown.reason, 'unreadable');
  assert.notEqual(unknown.verdict, 'ok', '没校验成不得显示为通过');

  // blocked 档：结论要能被运维直接看到（真越界时节点的下单会全灭）
  setOrderTimeoutSelfCheck({
    verdict: 'blocked',
    reason: 'too-low',
    configured: 1000,
    min: 17280,
    max: 518400,
    message: 'MK_ESCROW_TIMEOUT_BLOCKS=1000 低于链上下界 17280',
  });
  const blocked = (await health()).orderTimeout;
  assert.equal(blocked.verdict, 'blocked');
  assert.equal(blocked.configured, 1000);
  assert.equal(blocked.min, 17280);
});
