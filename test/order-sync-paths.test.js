/**
 * `POST /api/orders/:id/sync`（链上**快照**兜底路径）的口径单测。
 *
 * 覆盖三件事，都是"同一事实只能有一种说法"这类不变量：
 *  1. **终局映射唯一实现**（T1）：同一 fixture（本地 escrowed、链上 {status:'Settled', refundedAmount:'0'}）
 *     分别走 `/sync` 与 `reconcileOrder`（后台对账），必须得到**同一个**本地状态；且链上 Settled
 *     一律落 `settled`，**不再**落 `confirmed`——`confirmed` 只由真实 ReceiptConfirmed 事件
 *     （买家自己的动作）产生。旧实现让 `/sync` 落 confirmed、事件/对账落 settled，同一单两种说法。
 *  2. **费率/创建时收费方快照由 /sync 补录**（T6）：写 `fee_bps` 的同时写
 *     `fee_collector_at_create`；读不到（字段缺失/脏值）时写**空串=未知**，
 *     绝不写零地址（那等于凭空宣称"这单不扣费"）。
 *  3. **事件史上限**（T5）：`appendOrderCreatedEvent` 与 watcher/镜像两条写入路径一样裁剪到 20。
 *
 * 链上读取怎么伪造：`/sync` 走 chain.js 的 ethers provider，而 **ethers v6 在 Node 下用
 * `node:http` 发 JSON-RPC（不走 globalThis.fetch）**——所以这里起一个本地假 JSON-RPC 服务器，
 * 把 config.chain.rpcUrl 指过去（provider 是惰性单例，本文件此前不触链）。桩只回答 `eth_call`，
 * 返回的形状与**当前 ESCROW_ABI（12 字段 getOrder，末尾两项已随契约层同步）**一致：
 * 要等 ABI 同步后才能解出（见 T6 报告）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';
import { makeCtx, login, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, buyer, owner } = ctx;

const { setChainOrderFetcher, reconcileOrder } = await import('../src/chainReconcile.js');
const { applyEvent, pollOnce } = await import('../src/escrowWatcher.js');
const { appendOrderCreatedEvent } = await import('../src/routes/orders.js');
const { feeSnapshotOf } = await import('../src/fees.js');
const config = (await import('../src/config.js')).default;

const BUYER = buyer.address.toLowerCase();
const SELLER = owner.address.toLowerCase();
const AMOUNT = '1000000000000000000';
const FC_AT_CREATE = '0x4444444444444444444444444444444444444444'; // 链上"创建时收费方"（ABI 同步后可解出）
/**
 * 预置在本地行里的**脏/旧**快照：用来把"补录确实写入了"与"该列仍是默认值/旧值"区分开——
 * 若补录缺失（回退成旧实现），这列会原样留着 STALE，断言即变红。
 */
const STALE_FC = '0xdead000000000000000000000000000000000000';
const STATUS_INDEX = { Created: 1, Disputed: 2, Settled: 3, Refunded: 4 };

/** 当前 ESCROW_ABI 的 getOrder 形状（**字段数必须与 chain.js 逐字一致**，否则 ethers 解析会抛错） */
const GET_ORDER_ABI = [
  'function getOrder(bytes32 orderId) view returns (address buyer, address seller, uint256 amount, uint256 feeBps, uint64 timeoutBlocks, uint64 createdAtBlock, bool refundRequested, bool refundRejected, uint256 refundedAmount, uint8 status, address feeCollectorAtCreate, bool buyerConfirmed)',
];
const iface = new Interface(GET_ORDER_ABI);
/** 事件编码用（本地假 RPC 造日志）：仅测试侧使用，不改动生产 ABI */
const EVENT_IFACE = new Interface([
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, uint256 amount, uint64 timeoutBlocks, uint64 createdAtBlock)',
]);
const createdEvent = () => EVENT_IFACE.getEvent('OrderCreated');

/** 当前用例的链上真值（/sync 经 ethers → 本地假 RPC 读取） */
let chainOrderFor = null;
/** 事件日志开关：watcher 轮询（eth_getLogs）用 */
let emitCreatedLog = null;
/** 收据开关：paid 快路径（eth_getTransactionReceipt）用 */
let receiptFor = null;

/** 单个 JSON-RPC 请求 → { result } | { error }（ethers 会把并发请求打成一个 batch，外层负责拆包） */
function handleRpc(j) {
  try {
    const o = chainOrderFor;
    const method = j.method;
    if (method === 'eth_call' && o && String(j.params?.[0]?.to || '').toLowerCase() === config.chain.escrowAddress.toLowerCase()) {
      return {
        result: iface.encodeFunctionResult('getOrder', [
          o.buyer,
          o.seller,
          BigInt(o.amount),
          BigInt(o.feeBps || 0),
          100n,
          BigInt(o.createdAtBlock || 1),
          !!o.refundRequested,
          !!o.refundRejected,
          BigInt(o.refundedAmount || '0'),
          STATUS_INDEX[o.status],
          // 契约层 2026-09 新增的两项（末尾）：创建时的收取方快照 + 买家是否确认过
          o.feeCollectorAtCreate || '0x' + '0'.repeat(40),
          !!o.buyerConfirmed,
        ]),
      };
    }
    if (method === 'eth_blockNumber') return { result: '0x3e8' }; // 1000
    if (method === 'eth_getLogs' && emitCreatedLog) {
      const topic0 = String(j.params?.[0]?.topics?.[0] || '').toLowerCase();
      const created = EVENT_IFACE.encodeEventLog(createdEvent(), [
        emitCreatedLog.escrowOrderId,
        emitCreatedLog.buyer,
        emitCreatedLog.seller,
        BigInt(emitCreatedLog.amount),
        100n,
        1n,
      ]);
      return {
        result:
          topic0 === createdEvent().topicHash.toLowerCase()
            ? [
                {
                  address: config.chain.escrowAddress,
                  topics: created.topics,
                  data: created.data,
                  blockNumber: '0x3e8',
                  blockHash: '0x' + 'aa'.repeat(32),
                  transactionHash: '0x' + 'ee'.repeat(32),
                  transactionIndex: '0x0',
                  logIndex: '0x0',
                  removed: false,
                },
              ]
            : [],
      };
    }
    if (method === 'eth_getTransactionByHash' && receiptFor) {
      // ethers 解析收据时会顺带补一次交易对象（from/to 等）；这里回最小可用形状
      return {
        result: {
          hash: receiptFor.txHash,
          blockNumber: '0x3e8',
          blockHash: '0x' + 'aa'.repeat(32),
          transactionIndex: '0x0',
          from: receiptFor.buyer,
          to: config.chain.escrowAddress,
          value: '0x0',
          nonce: '0x0',
          gasPrice: '0x0',
          gas: '0x0',
          input: '0x',
          type: '0x0',
          chainId: '0x1',
        },
      };
    }
    if (method === 'eth_getTransactionReceipt' && receiptFor) {
      const created = EVENT_IFACE.encodeEventLog(createdEvent(), [
        receiptFor.escrowOrderId,
        receiptFor.buyer,
        receiptFor.seller,
        BigInt(receiptFor.amount),
        100n,
        1n,
      ]);
      return {
        result: {
          hash: receiptFor.txHash,
          // ethers 的收据格式要求 index（别名 transactionIndex）/cumulativeGasUsed/logsBloom 等字段齐全，
          // 日志行还要求 logIndex/transactionIndex（见 ethers providers/format.ts 的 formatReceiptLog）
          index: '0x0',
          transactionIndex: '0x0',
          blockNumber: '0x3e8',
          blockHash: '0x' + 'aa'.repeat(32),
          logsBloom: '0x' + '00'.repeat(256),
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x1',
          status: '0x1',
          type: '0x0',
          to: config.chain.escrowAddress,
          from: receiptFor.buyer,
          logs: [
            {
              address: config.chain.escrowAddress,
              topics: created.topics,
              data: created.data,
              logIndex: '0x0',
              transactionIndex: '0x0',
              blockNumber: '0x3e8',
              blockHash: '0x' + 'aa'.repeat(32),
              transactionHash: receiptFor.txHash,
            },
          ],
        },
      };
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
    // 单请求 → 单响应；批量（ethers 并发时打包）→ 数组响应
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
/** 直接插本地订单行（/sync 与对账都只关心本地行 + 链上真值） */
function insertOrder({
  status = 'escrowed',
  feeBps = 0,
  feeCollectorAtCreate = '',
  events = null,
  // 占位相关（默认 0/null = 从未占位，与既有用例一致）；限量恢复失败路径需要它们
  productId = null,
  holdQty = 0,
  releasedAt = null,
  // 默认给一个假凭证（既有用例的形态：escrowed 行必有 paid_tx_hash）；补录路径的用例传 null
  paidTxHash = undefined,
} = {}) {
  seq += 1;
  const id = `sync-${seq}`;
  const escrowOrderId = `0x${String(seq).padStart(64, '0')}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, product_id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       quantity, hold_qty, released_at, amount_wei, cny_fen, bty_usdt_rate, usdt_cny_rate, status, escrow_order_id,
       paid_tx_hash, fee_bps, fee_collector_at_create, onchain_events, created_at, updated_at)
     VALUES (?, ?, 'p-sync', '{}', '0x00', '', ?, ?, 1, ?, ?, ?, 100, '0.1', '7.2', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    productId,
    BUYER,
    SELLER,
    holdQty,
    releasedAt,
    AMOUNT,
    status,
    escrowOrderId,
    paidTxHash === undefined ? `0x${String(seq).padStart(64, 'f')}` : paidTxHash,
    feeBps,
    feeCollectorAtCreate,
    events ? JSON.stringify(events) : null,
    now,
    now
  );
  return { id, escrowOrderId };
}

const rowOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const statusOf = (id) => rowOf(id).status;
const eventsOf = (id) => JSON.parse(rowOf(id).onchain_events || '[]');

test('同一链上终局：/sync 与 reconcileOrder 得到同一个本地状态；Settled 不再落 confirmed', async () => {
  const cases = [
    {
      label: 'Settled + refundedAmount=0（确认收货/超时释放/仲裁判卖家三者链上同形）',
      onchain: { status: 'Settled', refundedAmount: '0' },
      expected: 'settled',
    },
    {
      label: 'Settled + 部分退款（仲裁拆分裁决）',
      onchain: { status: 'Settled', refundedAmount: (BigInt(AMOUNT) / 4n).toString() },
      expected: 'settled',
    },
    {
      label: 'Refunded + 全额退款',
      onchain: { status: 'Refunded', refundedAmount: AMOUNT },
      expected: 'refunded',
    },
  ];
  for (const c of cases) {
    const truth = {
      buyer: BUYER,
      seller: SELLER,
      amount: AMOUNT,
      feeBps: 0,
      refundedAmount: c.onchain.refundedAmount,
      createdAtBlock: 7,
      status: c.onchain.status,
    };
    // ① 快照路径 A：POST /:id/sync（HTTP 手动同步；链上读取走 ethers → fetch 桩）
    const viaSync = insertOrder();
    chainOrderFor = truth;
    const res = await request(app)
      .post(`/api/orders/${viaSync.id}/sync`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({})
      .expect(200);
    assertOk(res);
    // ② 快照路径 B：reconcileOrder（后台对账；链上读取走注入点，与 A 同一份链上真值）
    const viaReconcile = insertOrder();
    setChainOrderFetcher(async () => truth);
    assert.equal(await reconcileOrder(rowOf(viaReconcile.id)), 'repaired');

    assert.equal(statusOf(viaSync.id), c.expected, `${c.label}：/sync 的本地终态`);
    assert.equal(
      statusOf(viaReconcile.id),
      statusOf(viaSync.id),
      `${c.label}：两条修复路径必须给出同一个本地终态（这条断言就是本次修复的意义）`
    );
    // 退款额与镜像事件史同样一致（"同一事实同一说法"）
    assert.equal(rowOf(viaReconcile.id).refunded_amount_wei, rowOf(viaSync.id).refunded_amount_wei, c.label);
    assert.deepEqual(
      eventsOf(viaReconcile.id).map((e) => e.name),
      eventsOf(viaSync.id).map((e) => e.name),
      `${c.label}：镜像事件名也必须同形`
    );
  }

  // 反向控制：`confirmed` 只能由真实 ReceiptConfirmed 事件产生（买家自己的动作），
  // /sync 看到链上 Settled 时无从证明该动作，所以刻意不再产出它。
  const evt = insertOrder();
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: evt.escrowOrderId }), 1);
  assert.equal(statusOf(evt.id), 'confirmed', '真实确认事件 → confirmed（界面文案的"你已确认收货"有据可依）');
  assert.ok(
    !cases.some((c) => c.expected === 'confirmed'),
    '/sync 的 Settled 分支不得再产出 confirmed（否则同一链上事实两种说法）'
  );
});

test('费率快照补录：/sync 同时写 fee_bps 与 fee_collector_at_create（读不到写空串=未知，绝不写零地址）', async () => {
  // 行里预置一个**脏/旧**快照：补录若没发生，该列会原样留着它（断言随即变红）
  const o = insertOrder({ feeBps: 0, feeCollectorAtCreate: STALE_FC });
  chainOrderFor = {
    buyer: BUYER,
    seller: SELLER,
    amount: AMOUNT,
    feeBps: 250, // 链上费率：2.5%
    refundedAmount: '0',
    createdAtBlock: 9,
    status: 'Created',
    // 契约层 2026-09：getOrder 末尾新增的创建时收取方快照（ABI 已同步，桩必须给全 12 个字段）
    feeCollectorAtCreate: FC_AT_CREATE,
  };
  const res = await request(app)
    .post(`/api/orders/${o.id}/sync`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({})
    .expect(200);
  assertOk(res);
  const row = rowOf(o.id);
  assert.equal(row.fee_bps, 250, '链上费率快照落库（收款净额口径用）');
  /*
    fee_collector_at_create 由 /sync 从 `getOrder().feeCollectorAtCreate` 补录（契约层 2026-09 末尾新增字段）。
    本断言钉住**语义**：既然桩给的是一个真实的非零收取方，列里就必须是它（小写）——
    证明补录真的发生（行里预置的 STALE_FC 被覆盖），而不是"没读到就留着脏值"。
    另一半"读不到 ⇒ 空串=未知（账本退回全局保守口径）"由 `test/fees-per-order.test.js` 覆盖；
    两者都绝不允许把"不知道"写成 '0'/零地址（那会说成"这单不扣费"）。
  */
  const snap = String(row.fee_collector_at_create ?? '');
  assert.equal(snap, FC_AT_CREATE, `链上快照必须落库（实际 ${JSON.stringify(snap)}）`);
  assert.notEqual(snap, '0');
  assert.notEqual(snap, '0x0000000000000000000000000000000000000000');
  // 订单 DTO 如实下发：空串 → null（前端据此显示"未知/预计"，不猜）
  const detail = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assertOk(detail);
  assert.equal(
    detail.body.data.feeCollectorAtCreate,
    snap === '' ? null : snap,
    'DTO 下发创建时收费方快照（空串→null）'
  );
  assert.equal(typeof detail.body.data.feeChargeable, 'boolean', 'DTO 同时下发**按单**的扣费判定');

  // feeSnapshotOf 是三个补录入口共用的取值口径：ABI 同步后解出的字段必须原样小写落库
  assert.deepEqual(feeSnapshotOf({ feeBps: 250, feeCollectorAtCreate: FC_AT_CREATE.toUpperCase().replace('0X', '0x') }), {
    feeBps: 250,
    feeCollectorAtCreate: FC_AT_CREATE,
  });
  assert.deepEqual(feeSnapshotOf({ feeBps: 250 }), { feeBps: 250, feeCollectorAtCreate: '' }, '字段缺失 ⇒ 空串（未知）');
  assert.deepEqual(
    feeSnapshotOf({ feeBps: 250, feeCollectorAtCreate: null }),
    { feeBps: 250, feeCollectorAtCreate: '' },
    'null ⇒ 空串（未知），不得回落成零地址'
  );
});

test('paid 快路径与 watcher 轮询同样补录 fee_bps + fee_collector_at_create（三入口同口径）', async () => {
  /*
    三个补录入口（paid 快路径 / watcher 的 FEE_FILL_EVENTS / /sync）必须写同样的两列——
    只补 fee_bps 会让账本退回全局口径，与这单的链上事实可能相反（见 src/fees.js）。
    本用例让 paid 与 watcher 各自走一遍真实路径（收据/日志/ getOrder 都由本地假 RPC 提供），
    断言与 /sync 相同的语义：费率落库；创建时收费方要么是链上地址（ABI 同步后），
    要么是空串=未知——绝不写零地址。
  */
  const snapOk = (v) => v !== STALE_FC && (v === '' || v === FC_AT_CREATE);

  // ── ① paid 快路径（draft → 校验收据 → escrowed → 补录费率快照）──
  const draft = insertOrder({ status: 'draft', feeBps: 0, feeCollectorAtCreate: STALE_FC });
  const txHash = '0x' + 'cd'.repeat(32);
  chainOrderFor = { buyer: BUYER, seller: SELLER, amount: AMOUNT, feeBps: 250, refundedAmount: '0', createdAtBlock: 5, status: 'Created', feeCollectorAtCreate: FC_AT_CREATE };
  receiptFor = { txHash, escrowOrderId: draft.escrowOrderId, buyer: BUYER, seller: SELLER, amount: AMOUNT };
  const paid = await request(app)
    .post(`/api/orders/${draft.id}/paid`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ txHash })
    .expect(200);
  assertOk(paid);
  const paidRow = rowOf(draft.id);
  assert.equal(paidRow.status, 'escrowed');
  assert.equal(paidRow.fee_bps, 250, 'paid 路径补录链上费率');
  assert.equal(paidRow.fee_collector_at_create, FC_AT_CREATE, 'paid 路径写入链上的创建时收取方快照（小写归一）');

  // ── ② watcher 轮询（OrderCreated 事件 → escrowed → FEE_FILL_EVENTS 补录）──
  const watched = insertOrder({ status: 'draft', feeBps: 0, feeCollectorAtCreate: STALE_FC });
  chainOrderFor = { buyer: BUYER, seller: SELLER, amount: AMOUNT, feeBps: 300, refundedAmount: '0', createdAtBlock: 6, status: 'Created', feeCollectorAtCreate: FC_AT_CREATE };
  emitCreatedLog = { escrowOrderId: watched.escrowOrderId, buyer: BUYER, seller: SELLER, amount: AMOUNT };
  const r = await pollOnce();
  assert.ok(r.events >= 1, `本轮应扫到 OrderCreated：${JSON.stringify(r)}`);
  const wRow = rowOf(watched.id);
  assert.equal(wRow.status, 'escrowed', 'watcher 把 draft 推进为 escrowed');
  assert.equal(wRow.fee_bps, 300, 'watcher 路径补录链上费率');
  assert.equal(wRow.fee_collector_at_create, FC_AT_CREATE, 'watcher 路径同样写入链上快照（与 paid 同口径）');
  emitCreatedLog = null;
  receiptFor = null;
});

test('事件史上限：appendOrderCreatedEvent 裁剪到 20（与 watcher/镜像同口径）', () => {
  // 构造"事件史已超限且缺 OrderCreated"的脏状态（老版本无上限时期的形态）
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `Sync:mirror${i}`, txHash: null, block: null, at: Date.now() }));
  const o = insertOrder({ events: many });
  assert.equal(eventsOf(o.id).length, 25, '前置：25 条历史事件');
  appendOrderCreatedEvent(o.id, { txHash: '0x' + 'a'.repeat(64), block: 3 });
  const list = eventsOf(o.id);
  assert.equal(list.length, 20, '事件史上限 20（超出丢最旧，与 recordEvent/appendSyncMirrorEvent 同口径）');
  assert.equal(list[list.length - 1].name, 'OrderCreated', '新补的 OrderCreated 必须留下（凭证链/信誉画像要它）');
  assert.ok(!list.some((e) => e.name === 'Sync:mirror0'), '最旧的被裁掉');
  // 幂等：已有 OrderCreated 时不重复追加（原行为不变）
  appendOrderCreatedEvent(o.id, { txHash: '0x' + 'b'.repeat(64), block: 4 });
  assert.equal(eventsOf(o.id).filter((e) => e.name === 'OrderCreated').length, 1);
  assert.equal(eventsOf(o.id).length, 20);
});

test('/sync 恢复失败（限量售罄）时**不**把支付凭证写进 cancelled 行（否则 watcher 的自动恢复被永久跳过）', async () => {
  /*
    这条钉的是源码审计 2026-09 的一处 P1：`/sync` 补录支付哈希时缺少状态守卫
    （规范写法 `notePaidTxHash` 有 `status IN ('draft','escrowed','shipped')`）。
    竞态是真实存在的：草稿被清扫成 cancelled → 限量库存被别人买走 → 买家**随后**才真的完成链上支付
    → 点「同步链上状态」。旧实现先把哈希 COMMIT 进那一行，随后 `restockOrder` 因售罄失败并回滚迁移
    ——于是本地行变成「cancelled + 有凭证 + 链上资金真实存在」，而 watcher 的 OrderCreated 恢复分支
    以「cancelled **且无凭证**」为前置 ⇒ **这一单永远不会再被自动恢复**：买家钱在链上、页面显示已取消，
    只能等店主扩容后再手动同步一次。
    现在 cancelled 行的凭证改由「迁移成功那一刻」在同一事务内补写，失败则保持无凭证。
  */
  // 造一个「限量 1 件且已售罄」的 SKU：restockOrder 的去占位条件 UPDATE 必然影响 0 行
  const now = Date.now();
  const prod = db
    .prepare("INSERT INTO products (slug, title, kind, snapshot_hash, created_at, updated_at) VALUES (?, ?, 'physical', '0x00', ?, ?)")
    .run(`p-soldout-${seq}`, '已售罄的限量商品', now, now);
  const productId = Number(prod.lastInsertRowid);
  db.prepare(
    "INSERT INTO product_skus (product_id, sku_key, specs_json, price_cny_fen, capacity, committed, created_at, updated_at) VALUES (?, '', '{}', 100, 1, 1, ?, ?)"
  ).run(productId, now, now);

  // 草稿已被清扫成 cancelled（占位已释放），买家随后才完成链上支付；凭证此时为空
  const o = insertOrder({ status: 'cancelled', productId, holdQty: 1, releasedAt: now, paidTxHash: null });
  assert.equal(rowOf(o.id).paid_tx_hash, null, '前置：该行无支付凭证');
  chainOrderFor = { buyer: BUYER, seller: SELLER, amount: AMOUNT, feeBps: 0, refundedAmount: '0', createdAtBlock: 7, status: 'Created' };
  // 链上确有 OrderCreated 日志 ⇒ 补录路径**会**被走到（否则这条用例是空转的）
  emitCreatedLog = { escrowOrderId: o.escrowOrderId, buyer: BUYER, seller: SELLER, amount: AMOUNT };

  const res = await request(app)
    .post(`/api/orders/${o.id}/sync`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({});
  emitCreatedLog = null;

  // 注：本 API 的失败语义是 HTTP 200 + body.code !== 0（`http.fail` 的约定），不是 4xx
  assert.equal(res.status, 200);
  assert.notEqual(res.body.code, 0, '限量售罄 ⇒ 恢复失败，同步必须明确报错而不是假装成功');
  assert.match(String(res.body.message || ''), /恢复失败/, '错误信息要说清是恢复失败（可行动）');
  const row = rowOf(o.id);
  assert.equal(row.status, 'cancelled', '迁移被回滚：状态仍是 cancelled');
  assert.equal(
    row.paid_tx_hash,
    null,
    '**关键**：凭证必须保持为空 —— watcher 的自动恢复以「cancelled 且无凭证」为前置，一旦写进去就永久恢复不了'
  );

  // 反向控制：库存放出后 watcher 的自动恢复必须仍然能救回这一单（这正是上一条断言在保护的能力）
  // 注：txHash 不能与其它用例重复——`paid_tx_hash` 上有唯一索引（同一笔链上支付只能确认一个订单）
  const recoverHash = '0x' + 'ef'.repeat(32);
  db.prepare('UPDATE product_skus SET capacity = 5, committed = 0 WHERE product_id = ?').run(productId);
  const recovered = applyEvent('OrderCreated', { orderId: o.escrowOrderId, buyer: BUYER, seller: SELLER, amount: AMOUNT }, { txHash: recoverHash, block: 7 });
  assert.equal(recovered, 1, 'watcher 应能自动恢复该单');
  assert.equal(statusOf(o.id), 'escrowed');
  assert.equal(rowOf(o.id).paid_tx_hash, recoverHash, '恢复时补上凭证');
});

test('/sync 把 cancelled 恢复为 escrowed 时**在同一事务内**补写支付凭证（否则卖家必须同步两次才能发货）', async () => {
  /*
    这条钉的是源码审计 2026-09 复审的一处 P1：`/sync` 的 `movedToEscrowed` 分支此前只 append 镜像事件，
    **没有**补写 `paid_tx_hash`——而同一段代码的注释与 `docs/ARCHITECTURE.md` 都承诺
    "cancelled 行的凭证改由迁移成功那一刻补写"，`orders.js` 第 55 行还声明了
    「escrowed 及以上状态必有 paid_tx_hash」这条不变量。实际后果是一条可复现的坏路径：
      ① 限量商品下单 → draft；② 未付款被清扫成 cancelled；③ 买家**随后**才在链上完成支付；
      ④ `/sync` 报成功（cancelled → escrowed）但凭证仍为空；⑤ `/ship` 被拒
      （「该订单缺少链上支付凭证…请先对该订单执行同步补齐凭证」）——卖家照提示**再同步一次**才拿到凭证。
    更糟的是中间那句文案与运维手册的"仍空则取消清理"会把人往**取消**上引，而这一行同时是
    `/cancel` 认定的「escrowed 无凭证异常单」：RPC 抖动时真被取消，本地回到 cancelled 而链上资金仍在，
    且此后没有任何自动路径能救（watcher 只对新日志反应、chainReconcile 对链上 Created 是 action:'none'）。
  */
  const now = Date.now();
  const prod = db
    .prepare("INSERT INTO products (slug, title, kind, snapshot_hash, created_at, updated_at) VALUES (?, ?, 'physical', '0x00', ?, ?)")
    .run(`p-recoverable-${seq}`, '可恢复库存商品', now, now);
  const productId = Number(prod.lastInsertRowid);
  // 库存仍有额度（committed=1 且 capacity 足够）⇒ restockOrder 能成功，迁移会真的发生
  db.prepare(
    "INSERT INTO product_skus (product_id, sku_key, specs_json, price_cny_fen, capacity, committed, created_at, updated_at) VALUES (?, '', '{}', 100, 5, 1, ?, ?)"
  ).run(productId, now, now);

  const o = insertOrder({ status: 'cancelled', productId, holdQty: 1, releasedAt: now, paidTxHash: null });
  assert.equal(rowOf(o.id).paid_tx_hash, null, '前置：该行无支付凭证');
  chainOrderFor = { buyer: BUYER, seller: SELLER, amount: AMOUNT, feeBps: 0, refundedAmount: '0', createdAtBlock: 8, status: 'Created' };
  emitCreatedLog = { escrowOrderId: o.escrowOrderId, buyer: BUYER, seller: SELLER, amount: AMOUNT };

  const res = await request(app)
    .post(`/api/orders/${o.id}/sync`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({});
  emitCreatedLog = null;

  assert.equal(res.status, 200);
  assert.equal(res.body.code, 0, `库存可恢复 ⇒ 同步应成功：${JSON.stringify(res.body)}`);
  const row = rowOf(o.id);
  assert.equal(row.status, 'escrowed', '迁移已发生');
  // **本用例的核心断言**：迁移成功的那一刻凭证必须已在同一事务内写好
  assert.ok(
    row.paid_tx_hash && /^0x[0-9a-f]{64}$/.test(row.paid_tx_hash),
    `**关键**：恢复成功即补写凭证（escrowed 及以上必有 paid_tx_hash 这条不变量）——实得 ${row.paid_tx_hash}`
  );
  // 本分支按设计追加的是 `Sync:` 镜像事件（不是 OrderCreated——那是另一条按块反查的分支）
  assert.ok(
    eventsOf(o.id).some((e) => String(e.name).startsWith('Sync:')),
    '恢复成功应留下一条 Sync: 镜像事件（时间线要它）'
  );

  /*
    卖家视角的后果（**不调 `/ship` 本身**：那条端点在本测试夹具里会走真实的链上/通知路径而挂住，
    与本用例要证明的事无关）。`/ship` 的拒绝条件就是这一条判据：
      `if (!order.paid_tx_hash) return fail(res, '该订单缺少链上支付凭证…')` —— 见 routes/orders.js。
    所以"同步一次之后就能发货"等价于"这一行此刻已有凭证"，直接断它更准、也更快。
  */
  assert.ok(
    rowOf(o.id).paid_tx_hash,
    '同步一次之后该行即满足发货前置（旧实现这里为空 ⇒ /ship 被拒，逼卖家再同步一次）'
  );
});



