/**
 * 买家「精确金额授权」的部分退款（契约 2026-09 新增）在节点侧的全部落地路径。
 *
 * 契约变更（纯增量）：卖家原先能单方面指定部分退款额（`approveRefund(orderId, 1)` 就能让买家
 * 只拿 1 wei 且此后无任何链上救济路径）——现在 `approveRefund` 只接受两种金额：
 *   · `refundWei == amount`（全额认赔，不需要授权）；
 *   · `refundWei == acceptedPartialRefund[orderId]`（买家**对具体金额**点头过的那个数）。
 * 其它一律 `RefundAmountNotAccepted`（旧的 `RefundNotFull` 已删除）。新增
 * `acceptPartialRefund(orderId, refundWei)`（仅买家；Created/Disputed；`0 < refundWei < amount`；
 * 重复授权覆盖）与只读 `acceptedPartialRefund(orderId)`（0 = 未授权），
 * 事件 `PartialRefundAccepted(bytes32 indexed orderId, uint256 refundWei)`；
 * `arbitrate(orderId, refundWei)` **未变**（仲裁人任意比例、无需授权）。
 *
 * 本文件钉住节点侧四件事（每条都能证伪：把对应修复回退掉就会变红）：
 *  1. **watcher 真的收到这个事件**：`EVENTS` 清单含 `PartialRefundAccepted`（漏挂 = 永远扫不到），
 *     且通过**真实 `pollOnce` + 本地假 JSON-RPC** 的事件日志路径把授权额写进订单行与事件史；
 *     同一事件重放（重组回退/失败重试）不重复记账。
 *  2. **链上视图经 ethers 解出的值能落库**：`POST /:id/sync` 读 `acceptedPartialRefund(orderId)` 后落
 *     `accepted_partial_refund_wei`（用**生产 ABI**（`chain.js` 的 ESCROW_ABI）编码，故 ABI 少一行即红）。
 *  3. **DTO 下发**：订单详情与待仲裁列表都带 `acceptedPartialRefundWei`/`acceptedPartialRefundDecimal`
 *     （wei 字符串 + `weiToDecimal` 展示，与 refundedAmountWei/Decimal 同款：未授权时 wei 侧 `'0'`、
 *     decimal 侧 `'0.0'`；前端判"是否已授权"看 wei 字段）。
 *  4. **手动同步兜底**（`POST /:id/sync`）：事件漏扫时手动同步也能补上授权额；读不到（旧合约/ABI 未同步/RPC 抖动）
 *     时保持本地原值且**不阻断同步**；链上权威值为 0 时如实归零。
 * 另含回归：`RefundApproved` 按额分流（部分金额仍落 `settled` 并写 `refunded_amount_wei`）、
 * `PartialRefundAccepted` 不改订单状态、不派发 webhook 通知类型。
 *
 * 链上读取怎么伪造：与 test/order-sync-paths.test.js 同款——ethers v6 在 Node 下用 node:http 发
 * JSON-RPC（不走 globalThis.fetch），故起一个本地假 JSON-RPC 服务器（按 selector/topic0 分发），
 * 把 config.chain.rpcUrl 指过去。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';
import { makeCtx, login, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, buyer, owner } = ctx;

const { applyEvent, pollOnce, EVENTS, applyAcceptedPartialRefund } = await import('../src/escrowWatcher.js');
// **生产 ABI**（不是测试自带副本）：下面所有 eth_call/日志编码都走它，所以 chain.js 少一行
// `acceptedPartialRefund` / `PartialRefundAccepted` 声明，本文件在模块求值阶段就会失败
const { ESCROW_ABI } = await import('../src/chain.js');
const { typeForChainEvent } = await import('../src/webhook.js');
const { kvSet } = await import('../src/db.js');
const config = (await import('../src/config.js')).default;

const BUYER = buyer.address.toLowerCase();
const SELLER = owner.address.toLowerCase();
const ESCROW = config.chain.escrowAddress;
const AMOUNT = '1000000000000000000';
const ACCEPTED = '250000000000000000'; // 买家授权 25%（0.25 BTY）
const STATUS_INDEX = { None: 0, Created: 1, Disputed: 2, Settled: 3, Refunded: 4 };
/** 假 RPC 里事件日志所在块（= head(1000) − finality(12)，正是本轮扫描窗口内的块） */
const LOG_BLOCK = '0x3dc';

const iface = new Interface(ESCROW_ABI);
/**
 * 从**生产 ABI** 取函数/事件的入口：少声明一行时给出可读的前置失败信息
 *（而不是 `Cannot read properties of null (reading 'selector')` 这种看不出所以然的错），
 * 让"ABI 漂移"这条回归立即指向 chain.js。
 */
function mustFunction(name) {
  const f = iface.getFunction(name);
  assert.ok(f, `ESCROW_ABI 必须声明函数 ${name}（node/src/chain.js，须与 contracts/src/Escrow.sol 对齐）`);
  return f;
}
function mustEvent(name) {
  const e = iface.getEvent(name);
  assert.ok(e, `ESCROW_ABI 必须声明事件 ${name}（watcher 的事件清单只认 ABI 里的声明）`);
  return e;
}
const SEL_GET_ORDER = mustFunction('getOrder').selector;
const SEL_ACCEPTED = mustFunction('acceptedPartialRefund').selector;
const TOPIC_PARTIAL = mustEvent('PartialRefundAccepted').topicHash.toLowerCase();

/** 当前用例的链上真值：getOrder 元组（/sync 与 watcher 预取都读它） */
let chainOrder = null;
/** 当前用例的链上真值：acceptedPartialRefund(orderId)（0 = 未授权） */
let acceptedRefund = '0';
/** 让 acceptedPartialRefund 读取失败（模拟旧合约无此函数 / RPC 抖动） */
let acceptedRefundError = false;
/** watcher 轮询（eth_getLogs）要伪造的 PartialRefundAccepted 日志 */
let emitPartialLog = null;

/** 单个 JSON-RPC 请求 → { result } | { error }（ethers 会把并发请求打成一个 batch，外层拆包） */
function handleRpc(j) {
  try {
    const method = j.method;
    if (method === 'eth_call' && String(j.params?.[0]?.to || '').toLowerCase() === ESCROW.toLowerCase()) {
      const selector = String(j.params?.[0]?.data || '').slice(0, 10).toLowerCase();
      if (selector === SEL_ACCEPTED) {
        if (acceptedRefundError) {
          return { error: { code: 3, message: 'execution reverted: unit-test 读不到授权额' } };
        }
        return { result: iface.encodeFunctionResult('acceptedPartialRefund', [BigInt(acceptedRefund)]) };
      }
      if (selector === SEL_GET_ORDER && chainOrder) {
        const o = chainOrder;
        return {
          result: iface.encodeFunctionResult('getOrder', [
            o.buyer,
            o.seller,
            BigInt(o.amount),
            BigInt(o.feeBps || 0),
            100n,
            BigInt(o.createdAtBlock || 900),
            !!o.refundRequested,
            !!o.refundRejected,
            BigInt(o.refundedAmount || '0'),
            STATUS_INDEX[o.status],
            o.feeCollectorAtCreate || '0x' + '0'.repeat(40),
            false,
          ]),
        };
      }
      return { error: { code: -32601, message: `unit-test: 未预期的 eth_call selector ${selector}` } };
    }
    if (method === 'eth_blockNumber') return { result: '0x3e8' }; // 1000
    if (method === 'eth_getLogs') {
      const want = String(j.params?.[0]?.topics?.[0] || '').toLowerCase();
      if (emitPartialLog && want === TOPIC_PARTIAL) {
        const encoded = iface.encodeEventLog(iface.getEvent('PartialRefundAccepted'), [
          emitPartialLog.orderId,
          BigInt(emitPartialLog.refundWei),
        ]);
        return {
          result: [
            {
              address: ESCROW,
              topics: encoded.topics,
              data: encoded.data,
              blockNumber: LOG_BLOCK,
              blockHash: '0x' + 'ab'.repeat(32),
              transactionHash: '0x' + 'ee'.repeat(32),
              transactionIndex: '0x0',
              logIndex: '0x1',
              removed: false,
            },
          ],
        };
      }
      return { result: [] };
    }
    if (method === 'eth_getBlockByNumber') {
      return { result: { number: j.params?.[0], hash: '0x' + 'ab'.repeat(32) } };
    }
    return { error: { code: -32601, message: `unit-test: 未预期的 RPC 方法 ${method}` } };
  } catch (e) {
    return { error: { code: -32000, message: String(e?.message || e) } };
  }
}

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const out = Array.isArray(parsed)
      ? parsed.map((j) => ({ jsonrpc: '2.0', id: j?.id ?? 1, ...handleRpc(j) }))
      : { jsonrpc: '2.0', id: parsed?.id ?? 1, ...handleRpc(parsed) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
after(() => rpcServer.close());

let buyerToken;
before(async () => {
  buyerToken = (await login(ctx, buyer)).token;
});

let seq = 0;
/** 直接插本地订单行（照 test/order-sync-paths.test.js 的骨架；买家/卖家/金额与链上真值一致） */
function insertOrder({ status = 'escrowed', accepted = null, events = null } = {}) {
  seq += 1;
  const id = `prc-${seq}`;
  const escrowOrderId = `0x${String(seq).padStart(64, '0')}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, cny_fen, bty_usdt_rate, usdt_cny_rate, status, escrow_order_id, paid_tx_hash,
       accepted_partial_refund_wei, onchain_events, created_at, updated_at)
     VALUES (?, 'p-prc', '{}', '0x00', '', ?, ?, ?, 100, '0.1', '7.2', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    BUYER,
    SELLER,
    AMOUNT,
    status,
    escrowOrderId,
    `0x${String(seq).padStart(64, 'f')}`,
    accepted === null ? '0' : String(accepted),
    events ? JSON.stringify(events) : null,
    now,
    now
  );
  return { id, escrowOrderId };
}

const rowOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const eventsOf = (id) => JSON.parse(rowOf(id).onchain_events || '[]');

/** 链上真值（getOrder 形状）：与本文件插入的订单行逐项一致 */
const chainTruth = (status = 'Created') => ({
  buyer: BUYER,
  seller: SELLER,
  amount: AMOUNT,
  refundedAmount: '0',
  createdAtBlock: 900,
  status,
});

// ── ① ABI 与事件清单：契约侧新增的三项必须在生产 ABI 里，且事件必须挂进轮询清单 ──

test('事件声明/视图/写函数都在生产 ABI 里，且 PartialRefundAccepted 挂进 watcher 的 EVENTS 清单', () => {
  // 视图与写函数（漏一行：卖家部分退款在节点侧无从知晓，/sync 也读不到授权额）
  mustFunction('acceptPartialRefund');
  assert.equal(mustFunction('acceptedPartialRefund').outputs.length, 1, '只读视图返回单个 uint256（0 = 未授权）');
  assert.deepEqual(
    mustFunction('acceptedPartialRefund').inputs.map((i) => i.type),
    ['bytes32'],
    '视图入参是 orderId（与 getOrder 同一个键）'
  );
  // topic0 与契约侧 Events.t.sol 钉死的值一致（事件签名写错 → 轮询过滤器永远匹配不到日志）
  assert.equal(
    TOPIC_PARTIAL,
    '0x3b93bd8f82d9d17bb643b68d1fe18d34d33c6c28906786c7a2a2ef485e6c0c6d',
    'PartialRefundAccepted 的 topic0 必须与合约事件签名一致'
  );
  /*
    **事件漏挂**是本仓反复出问题的一类缺陷：事件不在 EVENTS 里，pollOnce 就永远不为它发
    queryFilter——链上发生了、本地毫无痕迹、且没有任何报错。这条断言就是防止那一行被删掉。
  */
  assert.ok(EVENTS.includes('PartialRefundAccepted'), `EVENTS 清单必须含 PartialRefundAccepted：${EVENTS.join(',')}`);
  // 也不能变成"挂了个拼错的影子事件"：清单里每一项都必须真的能在 ABI 里找到（否则 pollOnce 直接抛）
  for (const name of EVENTS) mustEvent(name);
  assert.equal(mustEvent('PartialRefundAccepted').inputs.length, 2);
  // 授权事件不派发 webhook：它不是状态通知（订单状态/资金都没动），授权额由 DTO 下发
  assert.equal(typeForChainEvent('PartialRefundAccepted', { refundWei: ACCEPTED }), null);
});

// ── ② 事件路径：授权额落订单行 + 事件史，且不改订单状态；重放不重复记账 ──

test('PartialRefundAccepted：写授权额与事件史、不动 status；同值重放幂等、改授权额覆盖并再留痕', () => {
  const o = insertOrder({ status: 'escrowed' });
  const meta = { txHash: '0x' + '1'.repeat(64), block: 55 };
  const updatedAtBefore = rowOf(o.id).updated_at;

  assert.equal(applyEvent('PartialRefundAccepted', { orderId: o.escrowOrderId, refundWei: ACCEPTED }, meta), 1);
  let row = rowOf(o.id);
  assert.equal(row.accepted_partial_refund_wei, ACCEPTED, '授权额必须落库（卖家 UI 给出可执行金额的唯一依据）');
  assert.equal(row.status, 'escrowed', '授权不迁移订单状态（不转移资金、不冻结订单）');
  assert.equal(row.refund_status, 'none', '授权也不动售后镜像');
  assert.equal(
    row.updated_at,
    updatedAtBefore,
    '不动 updated_at：它是统计窗口（stats.js 按天聚合入账/退款）与列表排序的依据，' +
      '一个迟到的事件把已终局的行挪进更晚的窗口 = 报表里同一笔钱出现两次'
  );
  assert.deepEqual(
    eventsOf(o.id).map((e) => e.name),
    ['PartialRefundAccepted'],
    '事件史留痕：否则"链上授权过"在订单详情里查不到任何凭证'
  );
  assert.equal(eventsOf(o.id)[0].txHash, '0x' + '1'.repeat(64), '事件史带链上凭证');
  assert.equal(eventsOf(o.id)[0].block, 55);

  // 幂等：同值重放（重组回退重扫 / 失败事件重试）changes=0 且不重复记账
  assert.equal(applyEvent('PartialRefundAccepted', { orderId: o.escrowOrderId, refundWei: ACCEPTED }), 0);
  assert.equal(eventsOf(o.id).length, 1, '重放不追加重复事件史');
  assert.equal(rowOf(o.id).accepted_partial_refund_wei, ACCEPTED);

  // 买家改授权额（合约允许重复调用覆盖）：本地随之覆盖，并留下新的链上凭证
  assert.equal(applyEvent('PartialRefundAccepted', { orderId: o.escrowOrderId, refundWei: '400000000000000000' }), 1);
  row = rowOf(o.id);
  assert.equal(row.accepted_partial_refund_wei, '400000000000000000');
  assert.equal(row.status, 'escrowed');
  assert.deepEqual(eventsOf(o.id).map((e) => e.name), ['PartialRefundAccepted', 'PartialRefundAccepted']);

  // 脏参数（ABI 漂移/字段缺失）：不落地——宁可保持"未授权"，也不写一个骗店主去调链上交易的假数字
  const bad = insertOrder({ status: 'escrowed', accepted: ACCEPTED });
  assert.equal(applyEvent('PartialRefundAccepted', { orderId: bad.escrowOrderId }), 0);
  assert.equal(applyEvent('PartialRefundAccepted', { orderId: bad.escrowOrderId, refundWei: '' }), 0);
  assert.equal(applyEvent('PartialRefundAccepted', { orderId: bad.escrowOrderId, refundWei: 'not-a-number' }), 0);
  assert.equal(rowOf(bad.id).accepted_partial_refund_wei, ACCEPTED, '解析失败时保持原值，不写脏数据');
  assert.equal(rowOf(bad.id).onchain_events, null, '不落地的分支不写事件史');
  // 本地无此单：不抛错、不越权（与其它事件同口径）
  assert.equal(applyEvent('PartialRefundAccepted', { orderId: '0x' + 'f'.repeat(64), refundWei: ACCEPTED }), 0);
});

// ── ③ watcher 轮询（真实 pollOnce + 假 RPC 的 eth_getLogs）：事件确实被扫到并应用 ──
//
// 本用例同时钉住"非 OrderCreated 事件会先预取 getOrder 做防伪比对"这条路径：
// pollOnce 里那个 await 必须真的能拿到链上真值（曾因漏 import fetchOnchainOrder 而
// 每轮抛 ReferenceError → 事件被判"真值未取到" → 重试 3 次后隔离，链上镜像静默停摆）。
// 因此下面的假 RPC 必须同时回答 getOrder 与 acceptedPartialRefund。

test('pollOnce 真的扫到 PartialRefundAccepted（事件日志 → 授权额落库 + 事件史），重扫不重复记账', async () => {
  const o = insertOrder({ status: 'escrowed' });
  chainOrder = chainTruth('Created'); // watcher 对非 OrderCreated 事件预取 getOrder 做防伪比对
  acceptedRefund = ACCEPTED;
  emitPartialLog = { orderId: o.escrowOrderId, refundWei: ACCEPTED };

  const r = await pollOnce();
  assert.ok(!r.skipped, `节点必须已接入托管合约：${JSON.stringify(r)}`);
  assert.ok(r.events >= 1, `本轮应扫到 PartialRefundAccepted：${JSON.stringify(r)}`);
  assert.equal(r.failed, 0, '不得有事件应用失败');
  const row = rowOf(o.id);
  assert.equal(row.accepted_partial_refund_wei, ACCEPTED, '轮询路径把授权额写进订单行');
  assert.equal(row.status, 'escrowed', '事件不迁移状态');
  assert.deepEqual(eventsOf(o.id).map((e) => e.name), ['PartialRefundAccepted']);
  assert.equal(eventsOf(o.id)[0].txHash, '0x' + 'ee'.repeat(32), '事件史带链上凭证（txHash 来自日志）');

  // 重组回退/失败重试会回退游标重扫同一段区间：同值重放必须 changes=0、不重复记账
  kvSet('mk:escrow_last_block', String(Number(BigInt(LOG_BLOCK)) - 1));
  const again = await pollOnce();
  assert.ok(again.events >= 1, '游标回退后同一条日志应被重扫到');
  assert.equal(rowOf(o.id).accepted_partial_refund_wei, ACCEPTED);
  assert.equal(eventsOf(o.id).length, 1, '重扫不重复追加事件史（幂等）');

  emitPartialLog = null;
});

// ── ④ /sync 兜底：链上 acceptedPartialRefund 经 ethers 解出后落库 ──

test('/sync 兜底：读 acceptedPartialRefund(orderId) 落库；读不到不阻断同步且不抹掉本地授权额', async () => {
  // 事件漏扫的现场：本地一行、授权额仍是 0（PartialRefundAccepted 从没被扫到）
  const o = insertOrder({ status: 'escrowed' });
  assert.equal(rowOf(o.id).accepted_partial_refund_wei, '0');
  chainOrder = chainTruth('Created');
  acceptedRefund = ACCEPTED;

  const res = await request(app)
    .post(`/api/orders/${o.id}/sync`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({})
    .expect(200);
  assertOk(res);
  assert.equal(
    rowOf(o.id).accepted_partial_refund_wei,
    ACCEPTED,
    '手动同步必须补上授权额（事件漏扫时的兜底）——ethers 解出的值原样落库'
  );
  assert.equal(rowOf(o.id).status, 'escrowed', '授权额回填不改订单状态（链上仍是 Created）');

  // 重复同步幂等
  const again = await request(app)
    .post(`/api/orders/${o.id}/sync`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({})
    .expect(200);
  assertOk(again);
  assert.equal(rowOf(o.id).accepted_partial_refund_wei, ACCEPTED);

  // 链上权威值为 0（从未授权）→ 本地如实归零
  acceptedRefund = '0';
  const zeroed = await request(app)
    .post(`/api/orders/${o.id}/sync`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({})
    .expect(200);
  assertOk(zeroed);
  assert.equal(rowOf(o.id).accepted_partial_refund_wei, '0', '链上 0 = 未授权：本地收敛为该事实');

  // 读取失败（旧合约没有该函数 / RPC 抖动）：保持本地原值 + **不阻断同步**
  const kept = insertOrder({ status: 'escrowed', accepted: ACCEPTED });
  acceptedRefundError = true;
  const degraded = await request(app)
    .post(`/api/orders/${kept.id}/sync`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({})
    .expect(200);
  assertOk(degraded);
  assert.equal(
    rowOf(kept.id).accepted_partial_refund_wei,
    ACCEPTED,
    '读不到时绝不写 0——那会把面板上一条有效授权抹掉（宁可暂缺，不可错报）'
  );
  acceptedRefundError = false;

  // 纯函数口径（单测直调）：0 = 有该行但未变；无该单 = 0；不可解析 = 0（都不写脏数据）
  assert.equal(applyAcceptedPartialRefund(o.escrowOrderId, 0), 0, '值未变 → changes=0（不产生噪音写）');
  assert.equal(applyAcceptedPartialRefund('0x' + '9'.repeat(64), ACCEPTED), 0, '本地无此单 → 0');
  assert.equal(applyAcceptedPartialRefund(kept.escrowOrderId, null), 0, '不可解析 → 0 且保持原值');
  assert.equal(rowOf(kept.id).accepted_partial_refund_wei, ACCEPTED);
});

// ── ⑤ DTO 下发：订单详情 + 待仲裁列表（公开只读） ──

test('DTO：订单详情与待仲裁列表都下发 acceptedPartialRefundWei/Decimal（未授权 wei 为 0）', async () => {
  const authorized = insertOrder({ status: 'escrowed', accepted: ACCEPTED });
  const never = insertOrder({ status: 'disputed' });

  // 订单详情（公开只读接口）：授权额是经济事实，不在收货信息那类可见矩阵里
  const detail = await request(app).get(`/api/orders/${authorized.id}`).expect(200);
  assertOk(detail);
  assert.equal(detail.body.data.acceptedPartialRefundWei, ACCEPTED, 'wei 字符串（防精度丢失）');
  assert.equal(detail.body.data.acceptedPartialRefundDecimal, '0.25', 'BTY 小数展示（与 refundedAmountDecimal 同款）');
  assert.equal(typeof detail.body.data.acceptedPartialRefundWei, 'string');

  // 未授权：wei 侧 '0'；decimal 侧与 refundedAmountDecimal/amountDecimal **同款**——weiToDecimal(0)
  // 的展示形就是 '0.0'，前端判"是否已授权"要看 wei 字段，decimal 只用于展示
  const d0 = await request(app).get(`/api/orders/${never.id}`).expect(200);
  assertOk(d0);
  assert.equal(d0.body.data.acceptedPartialRefundWei, '0');
  assert.equal(d0.body.data.acceptedPartialRefundDecimal, '0.0');
  assert.equal(d0.body.data.acceptedPartialRefundDecimal, d0.body.data.refundedAmountDecimal, '与同类字段同口径');

  // 待仲裁列表（公开只读）：仲裁人需要知道双方谈到哪一步（买家已点头的金额）
  const pend = await request(app).get('/api/arbitration/pending?pageSize=100').expect(200);
  assertOk(pend);
  const disputed = pend.body.data.disputes.find((d) => d.id === never.id);
  assert.ok(disputed, '争议单入待仲裁列表');
  assert.equal(disputed.acceptedPartialRefundWei, '0', '未授权 → 0');
  assert.equal(disputed.acceptedPartialRefundDecimal, '0.0', '与 refundedAmount 同款的小数口径（weiToDecimal(0)）');
  assert.ok('refundedAmountWei' in disputed, '与 refundedAmountWei 同级（公开只读、不含个人信息）');

  // 授权后的争议单：列表如实带出授权额（用事件路径写入，同一行）
  assert.equal(applyEvent('PartialRefundAccepted', { orderId: never.escrowOrderId, refundWei: ACCEPTED }), 1);
  const pend2 = await request(app).get('/api/arbitration/pending?pageSize=100').expect(200);
  assertOk(pend2);
  const row2 = pend2.body.data.disputes.find((d) => d.id === never.id);
  assert.equal(row2.acceptedPartialRefundWei, ACCEPTED);
  assert.equal(row2.acceptedPartialRefundDecimal, '0.25');
});

// ── ⑥ 回归：全额/部分的分流与仲裁路径不变（本轮没有改本地状态机的判据） ──

test('回归：买家授权额 → 卖家 approveRefund 同额落 settled 并记已退金额；全额落 refunded；仲裁不受授权限制', () => {
  // ① 双方谈拢的部分退款：买家授权 → 卖家 approveRefund(授权额) 的链上事件
  const partial = insertOrder({ status: 'escrowed' });
  assert.equal(applyEvent('PartialRefundAccepted', { orderId: partial.escrowOrderId, refundWei: ACCEPTED }), 1);
  assert.equal(applyEvent('RefundApproved', { orderId: partial.escrowOrderId, refundWei: ACCEPTED }), 1);
  const pRow = rowOf(partial.id);
  assert.equal(pRow.status, 'settled', '部分金额仍按「拆分结算」落 settled（成交向终态）');
  assert.equal(pRow.refunded_amount_wei, ACCEPTED, '已退金额必须落库（账本净额/UI 依据）');
  assert.equal(pRow.refund_status, 'none', '终局复位售后镜像');
  assert.equal(
    pRow.accepted_partial_refund_wei,
    ACCEPTED,
    '授权额是历史事实，终局后仍可查（面板要能解释这笔结算的依据）'
  );

  // ② 全额认赔（不需要任何授权）
  const full = insertOrder({ status: 'escrowed' });
  assert.equal(applyEvent('RefundApproved', { orderId: full.escrowOrderId, refundWei: AMOUNT }), 1);
  assert.equal(rowOf(full.id).status, 'refunded');
  assert.equal(rowOf(full.id).refunded_amount_wei, AMOUNT);

  // ③ 仲裁人：任意比例拆分，**无需买家授权**（未授权也必须照常落地）
  const arb = insertOrder({ status: 'disputed' });
  assert.equal(rowOf(arb.id).accepted_partial_refund_wei, '0', '前置：无授权');
  assert.equal(
    applyEvent('Arbitrated', { orderId: arb.escrowOrderId, refundWei: '333000000000000000' }, { chainParams: chainTruth('Disputed') }),
    1
  );
  const aRow = rowOf(arb.id);
  assert.equal(aRow.status, 'settled');
  assert.equal(aRow.refunded_amount_wei, '333000000000000000');
});
