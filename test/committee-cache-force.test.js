/**
 * 委员会缓存的 force / 单飞 / watcher 失效（2026-10-18）。
 *
 * 背景：仲裁人鉴权（订单详情的交付码、证据附件下载）读的是委员会名单。旧实现两处缺陷：
 *   ① 60s 正缓存对**读 PII** 的路径也生效：换届/撤权之后，缓存里的旧名单最多还能放行 60s；
 *   ② 并发读各自发一轮链上调用，**慢的失败**可以把**快的成功**从缓存里覆盖成 null
 *      （同一批请求有的放行有的拒绝）。
 *
 * 本文件用本地假 JSON-RPC 走生产路径（`getCommittee` / `committeeForOrder` / `pollOnce`）：
 *   · `{force:true}` 跳过缓存立刻重读（仲裁详情路径用）；
 *   · 并发 `getCommittee()` 只打一次链（单飞）；
 *   · 失败只负缓存 5s，`force` 可立刻重试；
 *   · watcher 扫到 `CommitteeUpdated`/`ArbiterRevoked` 时让缓存失效。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Interface, Wallet } from 'ethers';

// 证据附件目录必须在业务模块首次求值前指向临时目录（见 setup.mjs 对 import 顺序的说明）
process.env.MK_ATTACH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-committee-cache-'));
const { makeCtx, login, assertOk, productPayload, shopRef } = await import('./setup.mjs');

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const { ESCROW_ABI } = await import('../src/chain.js');
const {
  getCommittee,
  isArbiterForOrder,
  isArbiterAddress,
  committeeStatus,
  setForceClosedReader,
  __resetCommitteeCacheForTest,
  __expireCommitteeCacheForTest,
} = await import('../src/chain.js');
const { pollOnce } = await import('../src/escrowWatcher.js');
const { applyEvent } = await import('../src/escrowWatcher.js');
const config = (await import('../src/config.js')).default;

const iface = new Interface(ESCROW_ABI);
const ESCROW = config.chain.escrowAddress.toLowerCase();
const HEAD = 1000;
const FINALITY = Number(config.escrow.finalityBlocks || 0);

const arbiterA = Wallet.createRandom();
const arbiterB = Wallet.createRandom();
const A = arbiterA.address.toLowerCase();
const B = arbiterB.address.toLowerCase();

/** 链上当前届（读取器模拟 Registry/Escrow 的读法） */
let members = [A];
let epoch = 1;
/** true = 委员会读取失败（模拟 RPC 故障） */
let committeeFails = false;
/** 统计 `arbiters()` 被调了几次（单飞用例的判据） */
let arbitersCalls = 0;
/** 下一次 eth_getLogs 要伪造的 CommitteeUpdated 日志（null = 空日志） */
let committeeLog = null;
/** 被紧急吊销的成员（`revokedArbiter` 返回 true）；资格判据必须把他们排除 */
const revoked = new Set();
/** 被强制关闭的成员（由注入的 isForceClosed 读数回答，见 forceClosed 用例） */
let forceClosedSet = new Set();

function encodeCall(name, value) {
  return iface.encodeFunctionResult(name, [value]);
}

function handleRpc(j) {
  try {
    if (j.method === 'eth_call' && String(j.params?.[0]?.to || '').toLowerCase() === ESCROW) {
      if (committeeFails) return { error: { code: -32601, message: 'unit-test: 委员会 RPC 不可达' } };
      const data = String(j.params?.[0]?.data || '');
      const selector = data.slice(0, 10);
      if (selector === iface.getFunction('revokedArbiter').selector) {
        const [who] = iface.decodeFunctionData('revokedArbiter', data);
        return { result: encodeCall('revokedArbiter', revoked.has(String(who).toLowerCase())) };
      }
      if (selector === iface.getFunction('arbiters').selector) {
        arbitersCalls += 1;
        return { result: encodeCall('arbiters', members) };
      }
      if (selector === iface.getFunction('arbiterThreshold').selector) return { result: encodeCall('arbiterThreshold', 1) };
      if (selector === iface.getFunction('committeeEpoch').selector) return { result: encodeCall('committeeEpoch', epoch) };
      if (selector === iface.getFunction('orderEpoch').selector) return { result: encodeCall('orderEpoch', 0) };
      if (selector === iface.getFunction('orderArbiters').selector) return { result: encodeCall('orderArbiters', members) };
      if (selector === iface.getFunction('orderThreshold').selector) return { result: encodeCall('orderThreshold', 1) };
      return { error: { code: -32601, message: `unit-test: 未预期 selector ${selector}` } };
    }
    if (j.method === 'eth_blockNumber') return { result: `0x${HEAD.toString(16)}` };
    if (j.method === 'eth_getLogs') {
      const topic0 = String(j.params?.[0]?.topics?.[0] || '').toLowerCase();
      if (!committeeLog || topic0 !== committeeLog.topic) return { result: [] };
      return { result: [committeeLog.log] };
    }
    return { error: { code: -32601, message: `unit-test: 未预期 RPC 方法 ${j.method}` } };
  } catch (e) {
    return { error: { code: -32000, message: String(e?.message || e) } };
  }
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const out = Array.isArray(parsed)
      ? parsed.map((x) => ({ jsonrpc: '2.0', id: x?.id ?? 1, ...handleRpc(x) }))
      : { jsonrpc: '2.0', id: parsed?.id ?? 1, ...handleRpc(parsed) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
config.chain.rpcUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  if (server.listening) server.close();
  fs.rmSync(process.env.MK_ATTACH_DIR, { recursive: true, force: true });
});

let ownerToken;
let buyerToken;
let aToken;
let bToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  aToken = (await login(ctx, arbiterA)).token;
  bToken = (await login(ctx, arbiterB)).token;
});

const detailAs = async (token, orderNo) => {
  const r = await request(app).get(`/api/orders/${orderNo}`).set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(r);
  return r.body.data;
};

/** 造一张 disputed 单（含交付码），用于"仲裁人能否读到码"的 HTTP 判据 */
async function disputedOrderWithCode(title) {
  const created = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ title }))
    .expect(200);
  assertOk(created);
  const draft = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: created.body.data.slug, buyer: buyer.address })
    .expect(200);
  assertOk(draft);
  const order = draft.body.data;
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), order.id);
  await db.run(
    `UPDATE order_chain SET paid_tx_hash = ?
      WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)`,
    '0x' + String(Math.floor(Math.random() * 1e12)).padStart(64, 'a'),
    order.id
  );
  const shipped = await request(app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ deliveryCode: 'CARD-900' })
    .expect(200);
  assertOk(shipped);
  assert.equal(await applyEvent('DisputeRequested', { orderId: order.escrowOrderId }), 1);
  return order;
}

test('getCommittee 单飞：并发读只打一次链，两个调用都拿到成功名单', async () => {
  __resetCommitteeCacheForTest();
  members = [A];
  epoch = 1;
  committeeFails = false;
  arbitersCalls = 0;

  const [c1, c2] = await Promise.all([getCommittee(), getCommittee()]);
  assert.deepEqual(c1, { arbiters: [A], threshold: 1, epoch: 1 });
  assert.deepEqual(c2, c1);
  assert.equal(arbitersCalls, 1, '并发读必须共享同一次链上读（否则慢失败会覆盖快成功）');

  // 缓存命中的读不再打链
  assert.deepEqual(await getCommittee(), c1);
  assert.equal(arbitersCalls, 1, '正缓存内不得重复读链');
});

test('读不到只负缓存 5s；force 立刻重读（一次 RPC 抖动不会锁死一分钟）', async () => {
  __resetCommitteeCacheForTest();
  members = [A];
  committeeFails = true;
  assert.equal(await getCommittee(), null);
  assert.equal(committeeStatus().known, false);

  // 负缓存内：链恢复了也不自动重读（这是 5s 抖动保护）
  committeeFails = false;
  assert.equal(await getCommittee(), null);
  // force 跳过负缓存，立刻拿到成功名单
  assert.deepEqual(await getCommittee({ force: true }), { arbiters: [A], threshold: 1, epoch: 1 });
  assert.equal(committeeStatus().known, true);
});

test('换届后：旧名单允许（缓存未失效），仲裁详情/证据下载 force 重读后拒绝，新届成员可读', async () => {
  /*
    先确证能读到 A（避免"因为根本没读到过"而侥幸通过）。
    对照段用 **非 force** 的 `isArbiterForOrder` 证明缓存里确实是 A（旧实现会放行）；
    随后 HTTP 详情/附件下载走 `force:true`（routes/orders.js 与 routes/evidenceFiles.js 的
    as='arbiter' 判定），必须拒绝 A。
  */
  __resetCommitteeCacheForTest();
  members = [A];
  epoch = 1;
  committeeFails = false;
  assert.deepEqual(await getCommittee(), { arbiters: [A], threshold: 1, epoch: 1 });

  const order = await disputedOrderWithCode('换届后仲裁详情');
  // 一条带真实磁盘附件的争议陈述（附件下载是另一条读 PII 的路径）
  const internal = await db.get('SELECT order_id FROM v_orders WHERE order_no = ?', order.id);
  const evidence = await db.run(
    "INSERT INTO dispute_evidence (order_id, role, phase, content) VALUES (?, 'buyer', 'arbitration', '换届附件')",
    internal.order_id
  );
  const dir = path.join(process.env.MK_ATTACH_DIR, String(internal.order_id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stored.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const file = await db.run(
    'INSERT INTO evidence_files (evidence_id, order_id, filename, stored_name, mime, size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)',
    evidence.insertId,
    internal.order_id,
    'proof.png',
    'stored.png',
    'image/png',
    8,
    '0'.repeat(64)
  );
  const filePath = `/api/orders/${order.id}/evidence/${evidence.insertId}/files/${file.insertId}`;
  const download = (token) => request(app).get(filePath).set('Authorization', `Bearer ${token}`);

  assert.equal((await detailAs(aToken, order.id)).deliveries[0]?.value, 'CARD-900', '确证为仲裁人时交付码开放');
  await download(aToken).expect(200);

  // 换届：缓存里仍是 A（没有 watcher 事件/显式失效；60s 正缓存未过期）
  members = [B];
  epoch = 2;
  assert.equal(await isArbiterForOrder(A, order.escrowOrderId), true, '前置：非 force 读仍命中旧名单');

  const denied = await detailAs(aToken, order.id);
  assert.deepEqual(denied.deliveries, [], '换届后旧仲裁人读详情必须被拒（内部 force 重读链上名单）');
  await download(aToken).expect(404); // 换届后旧仲裁人下载证据附件必须被拒（同一 force 判据）
  assert.equal((await detailAs(bToken, order.id)).deliveries[0]?.value, 'CARD-900', '新届成员可以读到');
  await download(bToken).expect(200); // 新届成员可以下载证据附件
});

/**
 * **被强制关闭 / 被紧急吊销的成员不得留在"有资格的仲裁人"名单里**（2026-10-18）。
 *
 * 链上 `arbiters()` / `orderArbiters()` 返回原始名单：被 forceClose 的成员不会消失，
 * `_castVote` 才拒绝他。节点若直接拿原始名单当 PII 读权限，被关闭的仲裁人仍能打开
 * 买家详情与证据附件、还会在仲裁台显示成投票人。资格判据必须与撤权判据合并、
 * 且读不到就排除（fail-closed）。
 */
test('被强制关闭/被吊销的仲裁人：不进委员会、读不到详情/附件、也不能被当投票人', async () => {
  __resetCommitteeCacheForTest();
  members = [A, B];
  epoch = 1;
  revoked.clear();
  forceClosedSet = new Set();
  setForceClosedReader(async (addr) => forceClosedSet.has(addr));
  try {
    // 先确证读到 A（此时未关闭）⇒ `isForceClosed(A)` 的 15s false 缓存就此建立
    assert.deepEqual(await getCommittee({ force: true }), { arbiters: [A, B], threshold: 1, epoch: 1 });
    // 链上刚把 A 强制关闭（不调用 setForceClosedReader：那会清缓存，就测不到 force 是否穿透缓存）
    forceClosedSet = new Set([A]);
    assert.deepEqual(
      await getCommittee({ force: true }),
      { arbiters: [B], threshold: 1, epoch: 1 },
      '读 PII 的强制刷新必须绕过 isForceClosed 的 15s 缓存（否则刚被关闭的成员还能读最多 15s）'
    );
    assert.equal(await isArbiterAddress(A, { force: true }), false);
    assert.equal(await isArbiterForOrder(A, `0x${'11'.repeat(32)}`, { force: true }), false, '订单级资格同样不得放行');

    // HTTP 面：详情里的交付码与证据附件都是 PII/敏感资源（同一判据）
    const order = await disputedOrderWithCode('强制关闭仲裁人');
    const internal = await db.get('SELECT order_id FROM v_orders WHERE order_no = ?', order.id);
    const ev = await db.run(
      "INSERT INTO dispute_evidence (order_id, role, phase, content) VALUES (?, 'buyer', 'arbitration', '强制关闭附件')",
      internal.order_id
    );
    const dir = path.join(process.env.MK_ATTACH_DIR, String(internal.order_id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fc.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const file = await db.run(
      'INSERT INTO evidence_files (evidence_id, order_id, filename, stored_name, mime, size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ev.insertId,
      internal.order_id,
      'proof.png',
      'fc.png',
      'image/png',
      8,
      '0'.repeat(64)
    );
    const download = (token) =>
      request(app)
        .get(`/api/orders/${order.id}/evidence/${ev.insertId}/files/${file.insertId}`)
        .set('Authorization', `Bearer ${token}`);

    assert.deepEqual((await detailAs(aToken, order.id)).deliveries, [], '被强制关闭的仲裁人读不到交付码');
    await download(aToken).expect(404);
    assert.equal((await detailAs(bToken, order.id)).deliveries[0]?.value, 'CARD-900', '控制组：有资格的成员仍可读');
    await download(bToken).expect(200);

    // revoked 仍然排除（两条判据合并，不是用 forceClosed 取代它）
    setForceClosedReader(async () => false);
    forceClosedSet = new Set();
    revoked.add(B);
    assert.deepEqual(await getCommittee({ force: true }), { arbiters: [A], threshold: 1, epoch: 1 }, '被紧急吊销的 B 必须被排除');

    // 读不到 = 不能确认有资格 ⇒ 排除（fail-closed）
    revoked.clear();
    setForceClosedReader(async () => null);
    assert.deepEqual(await getCommittee({ force: true }), { arbiters: [], threshold: 1, epoch: 1 }, '强制关闭状态读不到时不得放行任何人');
  } finally {
    revoked.clear();
    forceClosedSet = new Set();
    setForceClosedReader(async () => false);
  }
});

test('watcher 扫到 CommitteeUpdated ⇒ 委员会缓存立即失效（不靠 60s 自然过期）', async () => {
  __resetCommitteeCacheForTest();
  members = [A];
  epoch = 1;
  committeeFails = false;
  await getCommittee(); // 缓存 A

  members = [B];
  epoch = 2;
  const encoded = iface.encodeEventLog(iface.getEvent('CommitteeUpdated'), [epoch, members, 1]);
  committeeLog = {
    topic: iface.getEvent('CommitteeUpdated').topicHash.toLowerCase(),
    log: {
      address: config.chain.escrowAddress,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber: `0x${(HEAD - 50).toString(16)}`,
      blockHash: '0x' + 'ab'.repeat(32),
      transactionHash: '0x' + 'cd'.repeat(32),
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed: false,
    },
  };
  // 游标设在日志块之前，本轮窗口能覆盖它
  await db.run('UPDATE node SET watcher_block = ?, watcher_hash = NULL WHERE id = 1', HEAD - 100);
  await pollOnce();

  // 缓存已失效 ⇒ 非 force 读也会拿到新届
  assert.deepEqual(await getCommittee(), { arbiters: [B], threshold: 1, epoch: 2 });
});
