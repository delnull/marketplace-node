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
import { makeCtx, login, assertOk, shopRef, insertOrder as insertOrderRow, insertProduct } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, buyer, owner } = ctx;

const { setChainOrderFetcher, reconcileOrder } = await import('../src/chainReconcile.js');
const { applyEvent, pollOnce } = await import('../src/escrowWatcher.js');
const { appendOrderCreatedEvent } = await import('../src/routes/orders.js');
const { feeSnapshotOf } = await import('../src/fees.js');
const config = (await import('../src/config.js')).default;
/**
 * 通知捕获：`/sync` 只在状态真的迁移时 `notify()`（fire-and-forget）。把发送器换成捕获桩，
 * 才能证明"终态吸附"那次同步**没有**重发通知（真实默认发送器会去打公网）。
 */
const { setWebhookConfig, setWebhookSender } = await import('../src/webhook.js');
const syncSent = [];
await setWebhookConfig(shopRef.value, { url: 'https://93.184.216.34/hook/sync-test', secret: '' });
setWebhookSender(async (url, init) => {
  syncSent.push(JSON.parse(init.body));
  return { status: 200 };
});

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

/**
 * 当前 ESCROW_ABI 里 /sync 会用到的三个只读函数（**字段数必须与 chain.js 逐字一致**，否则 ethers 解析会抛错）。
 * 桩必须**按 selector 分发**：只回 getOrder 的元组时，后面两个调用会把那份编码当成自己的返回值解出垃圾
 * （表现为 `commission_bps` 被写进一个"地址当 uint"的数 ⇒ ck_orders_bps 当场拒绝，而报错完全指不到桩）。
 */
const GET_ORDER_ABI = [
  'function getOrder(bytes32 orderId) view returns (address buyer, address seller, uint256 amount, uint256 feeBps, uint64 timeoutBlocks, uint64 createdAtBlock, bool refundRequested, bool refundRejected, uint256 refundedAmount, uint8 status, address feeCollectorAtCreate, bool buyerConfirmed)',
  'function commissionTermsAtCreate(bytes32 orderId) view returns (address payee, uint16 bps)',
  'function acceptedPartialRefund(bytes32 orderId) view returns (uint256)',
];
const iface = new Interface(GET_ORDER_ABI);
/** 事件编码用（本地假 RPC 造日志）：仅测试侧使用，不改动生产 ABI */
const EVENT_IFACE = new Interface([
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, address host, uint256 amount)',
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
    if (method === 'eth_call' && String(j.params?.[0]?.to || '').toLowerCase() === config.chain.escrowAddress.toLowerCase()) {
      const selector = String(j.params?.[0]?.data || '').slice(0, 10);
      // 创建时的抽成条款：本文件不验它 ⇒ 确证"不抽成"（零地址 + 0 bps），别让它变成未知档
      if (selector === iface.getFunction('commissionTermsAtCreate').selector) {
        return { result: iface.encodeFunctionResult('commissionTermsAtCreate', ['0x' + '0'.repeat(40), 0]) };
      }
      // 买家精确金额授权：本文件不验它 ⇒ 0（未授权）
      if (selector === iface.getFunction('acceptedPartialRefund').selector) {
        return { result: iface.encodeFunctionResult('acceptedPartialRefund', [0n]) };
      }
      if (selector !== iface.getFunction('getOrder').selector) {
        return { error: { code: -32601, message: `unit-test: 未预期的 eth_call selector ${selector}` } };
      }
      if (!o) return { error: { code: -32601, message: 'unit-test: 本用例没有设置链上真值' } };
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
        emitCreatedLog.host ?? emitCreatedLog.seller,
        BigInt(emitCreatedLog.amount),
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
                  /*
                    用本单的 escrowOrderId 当交易哈希：一单一号且天然唯一。
                    旧写法是固定 '0xee…'——同一文件里两条用例都走"按创建块反查并补录凭证"时，
                    第二条会撞 `order_chain.uq_chain_paid`（唯一索引），报成服务内部错误。
                  */
                  transactionHash: String(emitCreatedLog.escrowOrderId).toLowerCase(),
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
        receiptFor.host ?? receiptFor.seller,
        BigInt(receiptFor.amount),
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
          // 256 字节的 bloom = `0x` + 512 个 hex 字符。**不能写成 `'0x00'.repeat(256)`**：
          // 那串出来的是 `0x000x00…`（不是合法 hex），ethers 在 formatTransactionReceipt
          // 处直接抛 INVALID_ARGUMENT ⇒ paid 路径 500，而报错是在 ethers 内部，
          // 现场只看到一句"服务内部错误"（这条用例曾经因此红过）。
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
async function insertOrder({
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
  const row = await insertOrderRow(db, {
    productId,
    productSlug: 'p-sync',
    buyer: BUYER,
    seller: SELLER,
    quantity: 1,
    holdQty,
    releasedAt,
    amountWei: AMOUNT,
    usdtMicro: 1000000,
    btyUsdtRate: '0.1',
    status,
    escrowOrderId: `0x${String(seq).padStart(64, '0')}`,
    paidTxHash: paidTxHash === undefined ? `0x${String(seq).padStart(64, 'f')}` : paidTxHash,
    feeBps,
    feeCollectorAtCreate,
    events,
  });
  return { orderId: row.orderId, orderNo: row.orderNo, escrowOrderId: row.escrowOrderId };
}

const rowOf = async (orderId) => await db.get('SELECT * FROM v_orders WHERE order_id = ?', orderId);
const statusOf = async (orderId) => (await rowOf(orderId)).status;
// 事件史是 JSON 列：驱动读回来**已是数组**（旧形状是 TEXT，那时才需要 JSON.parse）
  const eventsOf = async (orderId) => (await rowOf(orderId)).onchain_events || [];

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
    const viaSync = await insertOrder();
    chainOrderFor = truth;
    const res = await request(app)
      .post(`/api/orders/${viaSync.orderNo}/sync`)
      .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
      .send({})
      .expect(200);
    assertOk(res);
    // ② 快照路径 B：reconcileOrder（后台对账；链上读取走注入点，与 A 同一份链上真值）
    const viaReconcile = await insertOrder();
    setChainOrderFetcher(async () => truth);
    assert.equal(await reconcileOrder(await rowOf(viaReconcile.orderId)), 'repaired');

    assert.equal(await statusOf(viaSync.orderId), c.expected, `${c.label}：/sync 的本地终态`);
    assert.equal(
      await statusOf(viaReconcile.orderId),
      await statusOf(viaSync.orderId),
      `${c.label}：两条修复路径必须给出同一个本地终态（这条断言就是本次修复的意义）`
    );
    // 退款额与镜像事件史同样一致（"同一事实同一说法"）
    assert.equal((await rowOf(viaReconcile.orderId)).refunded_amount_wei, (await rowOf(viaSync.orderId)).refunded_amount_wei, c.label);
    assert.deepEqual(
      (await eventsOf(viaReconcile.orderId)).map((e) => e.name),
      (await eventsOf(viaSync.orderId)).map((e) => e.name),
      `${c.label}：镜像事件名也必须同形`
    );
  }

  // 反向控制：`confirmed` 只能由真实 ReceiptConfirmed 事件产生（买家自己的动作），
  // /sync 看到链上 Settled 时无从证明该动作，所以刻意不再产出它。
  const evt = await insertOrder();
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: evt.escrowOrderId }), 1);
  assert.equal(await statusOf(evt.orderId), 'confirmed', '真实确认事件 → confirmed（界面文案的"你已确认收货"有据可依）');
  assert.ok(
    !cases.some((c) => c.expected === 'confirmed'),
    '/sync 的 Settled 分支不得再产出 confirmed（否则同一链上事实两种说法）'
  );
});

test('费率快照补录：/sync 同时写 fee_bps 与 fee_collector_at_create（读不到写空串=未知，绝不写零地址）', async () => {
  // 行里预置一个**脏/旧**快照：补录若没发生，该列会原样留着它（断言随即变红）
  const o = await insertOrder({ feeBps: 0, feeCollectorAtCreate: STALE_FC });
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
    .post(`/api/orders/${o.orderNo}/sync`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({})
    .expect(200);
  assertOk(res);
  const row = await rowOf(o.orderId);
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
  const detail = await request(app).get(`/api/orders/${o.orderNo}`).set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(detail);
  assert.equal(
    detail.body.data.feeCollectorAtCreate,
    snap === '' ? null : snap,
    'DTO 下发创建时收费方快照（空串→null）'
  );
  assert.equal(typeof detail.body.data.feeChargeable, 'boolean', 'DTO 同时下发**按单**的扣费判定');

  /*
    feeSnapshotOf 是三个补录入口共用的取值与三态判据：ABI 同步后解出的字段必须原样小写落库，
    并且**两个字段都读到才算读到**（`known`）——`known:false` 时调用方一个字节都不许写，
    否则"没补录过"会被写成"确证不扣费"（写入点是 fees.writeFeeSnapshot，见 fee-snapshot-write.test.js）。
  */
  assert.deepEqual(feeSnapshotOf({ feeBps: 250, feeCollectorAtCreate: FC_AT_CREATE.toUpperCase().replace('0X', '0x') }), {
    known: true,
    feeBps: 250,
    feeCollectorAtCreate: FC_AT_CREATE,
  });
  assert.deepEqual(
    feeSnapshotOf({ feeBps: 250 }),
    { known: false, feeBps: 0, feeCollectorAtCreate: '' },
    '字段缺失 ⇒ 未知（known:false），占位值不得写库'
  );
  assert.deepEqual(
    feeSnapshotOf({ feeBps: 250, feeCollectorAtCreate: null }),
    { known: false, feeBps: 0, feeCollectorAtCreate: '' },
    'null ⇒ 未知，不得回落成零地址'
  );
  assert.deepEqual(
    feeSnapshotOf({ feeBps: 0, feeCollectorAtCreate: '0x' + '0'.repeat(40) }),
    { known: true, feeBps: 0, feeCollectorAtCreate: '0x' + '0'.repeat(40) },
    '零地址是**确证不扣费**（known:true），与"没读到"不是一回事'
  );
});

test('paid 快路径与 watcher 轮询同样补录 fee_bps + fee_collector_at_create（三入口同口径）', async () => {
  /*
    三个补录入口（paid 快路径 / watcher 的 FEE_FILL_EVENTS / /sync）必须写同样的两列——
    只补 fee_bps 会让账本退回全局口径，与这单的链上事实可能相反（见 src/fees.js）。
    本用例让 paid 与 watcher 各自走一遍真实路径（收据/日志/getOrder 都由本地假 RPC 提供），
    断言与 /sync 相同的语义：费率落库、收费方快照落链上地址，绝不写零地址。

    ⚠️ 夹具必须是**从未补录**（`feeCollectorAtCreate: null`）：watcher 的补录门槛是
    `fee_collector_at_create IS NULL`（见 escrowWatcher 的 needsFeeFill 判据），预置一个非空值
    等于告诉它"这单已经补录过"——它会（刻意）跳过，于是这条断言验的就不再是补录。
    "不覆盖已有的确证快照"由 fee-snapshot-write.test.js 的 writeFeeSnapshot 用例覆盖。
  */
  const snapOk = (v) => v !== STALE_FC && (v === '' || v === FC_AT_CREATE);

  // ── ① paid 快路径（draft → 校验收据 → escrowed → 补录费率快照）──
  const draft = await insertOrder({ status: 'draft', feeBps: 0, feeCollectorAtCreate: null });
  const txHash = '0x' + 'cd'.repeat(32);
  chainOrderFor = { buyer: BUYER, seller: SELLER, amount: AMOUNT, feeBps: 250, refundedAmount: '0', createdAtBlock: 5, status: 'Created', feeCollectorAtCreate: FC_AT_CREATE };
  receiptFor = { txHash, escrowOrderId: draft.escrowOrderId, buyer: BUYER, seller: SELLER, amount: AMOUNT };
  const paid = await request(app)
    .post(`/api/orders/${draft.orderNo}/paid`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ txHash })
    .expect(200);
  assertOk(paid);
  const paidRow = await rowOf(draft.orderId);
  assert.equal(paidRow.status, 'escrowed');
  assert.equal(paidRow.fee_bps, 250, 'paid 路径补录链上费率');
  assert.equal(paidRow.fee_collector_at_create, FC_AT_CREATE, 'paid 路径写入链上的创建时收取方快照（小写归一）');

  // ── ② watcher 轮询（OrderCreated 事件 → escrowed → FEE_FILL_EVENTS 补录）──
  const watched = await insertOrder({ status: 'draft', feeBps: 0, feeCollectorAtCreate: null });
  chainOrderFor = { buyer: BUYER, seller: SELLER, amount: AMOUNT, feeBps: 300, refundedAmount: '0', createdAtBlock: 6, status: 'Created', feeCollectorAtCreate: FC_AT_CREATE };
  emitCreatedLog = { escrowOrderId: watched.escrowOrderId, buyer: BUYER, seller: SELLER, amount: AMOUNT };
  const r = await pollOnce();
  assert.ok(r.events >= 1, `本轮应扫到 OrderCreated：${JSON.stringify(r)}`);
  const wRow = await rowOf(watched.orderId);
  assert.equal(wRow.status, 'escrowed', 'watcher 把 draft 推进为 escrowed');
  assert.equal(wRow.fee_bps, 300, 'watcher 路径补录链上费率');
  assert.equal(wRow.fee_collector_at_create, FC_AT_CREATE, 'watcher 路径同样写入链上快照（与 paid 同口径）');
  emitCreatedLog = null;
  receiptFor = null;
});

test('事件史上限：appendOrderCreatedEvent 裁剪到 20（与 watcher/镜像同口径）', async () => {
  // 构造"事件史已超限且缺 OrderCreated"的脏状态（老版本无上限时期的形态）
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `Sync:mirror${i}`, txHash: null, block: null, at: Date.now() }));
  const o = await insertOrder({ events: many });
  assert.equal((await eventsOf(o.orderId)).length, 25, '前置：25 条历史事件');
  await appendOrderCreatedEvent(o.orderId, { txHash: '0x' + 'a'.repeat(64), block: 3 });
  const list = await eventsOf(o.orderId);
  assert.equal(list.length, 20, '事件史上限 20（超出丢最旧，与 recordEvent/appendSyncMirrorEvent 同口径）');
  assert.equal(list[list.length - 1].name, 'OrderCreated', '新补的 OrderCreated 必须留下（凭证链/信誉画像要它）');
  assert.ok(!list.some((e) => e.name === 'Sync:mirror0'), '最旧的被裁掉');
  // 幂等：已有 OrderCreated 时不重复追加（原行为不变）
  await appendOrderCreatedEvent(o.orderId, { txHash: '0x' + 'b'.repeat(64), block: 4 });
  assert.equal((await eventsOf(o.orderId)).filter((e) => e.name === 'OrderCreated').length, 1);
  assert.equal((await eventsOf(o.orderId)).length, 20);
});

/**
 * **P2-1：快照路径必须让 `expired` 保持吸收态**。
 *
 * 旧实现 Settled 分支的 from 集含 `expired`：一张超时释放的旧单被 /sync 看到链上 Settled
 * 后会被改写成 settled——重盖 updated_at（入账窗口/PII 保留期锚点）、重发 order.settled、
 * 并把 `refunded_amount_wei` 无条件改写。链上事实没有变化，变的只是本地账。
 * 纠正 expired 只能走**事件路径**（watcher 知道事件名；快照只有 status+refundedAmount）。
 */
test('链上 Settled 不得改写已 expired 的单：状态/updated_at/退款额/通知都不动', async () => {
  const oldUpdatedAt = new Date(Date.now() - 10 * 86400_000);
  const o = await insertOrder({ status: 'expired' });
  await db.run('UPDATE orders SET updated_at = ? WHERE id = ?', oldUpdatedAt, o.orderId);
  const before = await rowOf(o.orderId);
  assert.equal(before.status, 'expired');
  assert.equal(String(before.refunded_amount_wei), '0', '前置：本单没有退款镜像');

  chainOrderFor = {
    buyer: BUYER,
    seller: SELLER,
    amount: AMOUNT,
    feeBps: 0,
    refundedAmount: (BigInt(AMOUNT) / 4n).toString(), // 若旧实现写这一列，值会变成 25%
    createdAtBlock: 11,
    status: 'Settled',
  };
  syncSent.length = 0;
  const res = await request(app)
    .post(`/api/orders/${o.orderNo}/sync`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({})
    .expect(200);
  assertOk(res);

  const after = await rowOf(o.orderId);
  assert.equal(after.status, 'expired', 'expired 是终态，快照路径不得改写');
  assert.equal(String(after.refunded_amount_wei), '0', '状态没迁移时不得改写退款金额（同一个 claim）');
  assert.equal(
    new Date(after.updated_at).getTime(),
    oldUpdatedAt.getTime(),
    'updated_at 是入账窗口/PII 锚点，终态吸附不得重盖'
  );
  assert.match(String(res.body.message), /已是终态 expired/, '文案必须如实说"快照不覆盖终态"');
  assert.doesNotMatch(String(res.body.message), /无需变更/, '本地 expired 与链上 Settled 不是"一致"');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(syncSent.length, 0, '没有发生状态迁移 ⇒ 不得重发通知');
});

/**
 * **P2-1b：状态没变但补录发生了 ⇒ 文案必须说"只补录了 X"**。
 * 旧实现一律回"本次无需变更"，店主无法判断自己刚点的同步是否真的补上了凭证。
 */
test('状态不变但补录了支付凭证 ⇒ 成功文案报"只补录了…"，不再说"无需变更"', async () => {
  const o = await insertOrder({ status: 'escrowed', paidTxHash: null });
  chainOrderFor = {
    buyer: BUYER,
    seller: SELLER,
    amount: AMOUNT,
    feeBps: 0,
    refundedAmount: '0',
    createdAtBlock: 12,
    status: 'Created',
  };
  // 链上有 OrderCreated 日志 ⇒ /sync 的"按创建块反查凭证"会真的补上哈希
  emitCreatedLog = { escrowOrderId: o.escrowOrderId, buyer: BUYER, seller: SELLER, amount: AMOUNT };
  let res;
  try {
    res = await request(app)
      .post(`/api/orders/${o.orderNo}/sync`)
      .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
      .send({})
      .expect(200);
  } finally {
    emitCreatedLog = null;
  }
  assertOk(res);
  assert.ok((await rowOf(o.orderId)).paid_tx_hash, '前置：凭证确实被补录了');
  assert.equal(res.body.data.syncBackfill.paidTxHash, 'recovered');
  assert.match(String(res.body.message), /只补录了/, '文案必须报告实际写入');
  assert.match(String(res.body.message), /支付凭证/);
  assert.doesNotMatch(String(res.body.message), /本次无需变更/);
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
  // 商品与 SKU 由 insertProduct 一次造出（slug 是 CHAR(11)，时间列由服务器盖章）
  const { productId } = await insertProduct(db, {
    title: '已售罄的限量商品',
    kind: 'physical',
    skus: [{ key: '', priceUsdtMicro: 100, capacity: 1, committed: 1 }],
  });

  // 草稿已被清扫成 cancelled（占位已释放），买家随后才完成链上支付；凭证此时为空
  const o = await insertOrder({ status: 'cancelled', productId, holdQty: 1, releasedAt: new Date(now), paidTxHash: null });
  assert.equal((await rowOf(o.orderId)).paid_tx_hash, null, '前置：该行无支付凭证');
  chainOrderFor = { buyer: BUYER, seller: SELLER, amount: AMOUNT, feeBps: 0, refundedAmount: '0', createdAtBlock: 7, status: 'Created' };
  // 链上确有 OrderCreated 日志 ⇒ 补录路径**会**被走到（否则这条用例是空转的）
  emitCreatedLog = { escrowOrderId: o.escrowOrderId, buyer: BUYER, seller: SELLER, amount: AMOUNT };

  const res = await request(app)
    .post(`/api/orders/${o.orderNo}/sync`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({});
  emitCreatedLog = null;

  // 注：本 API 的失败语义是 HTTP 200 + body.code !== 0（`http.fail` 的约定），不是 4xx
  assert.equal(res.status, 200);
  assert.notEqual(res.body.code, 0, '限量售罄 ⇒ 恢复失败，同步必须明确报错而不是假装成功');
  assert.match(String(res.body.message || ''), /恢复失败/, '错误信息要说清是恢复失败（可行动）');
  const row = await rowOf(o.orderId);
  assert.equal(row.status, 'cancelled', '迁移被回滚：状态仍是 cancelled');
  assert.equal(
    row.paid_tx_hash,
    null,
    '**关键**：凭证必须保持为空 —— watcher 的自动恢复以「cancelled 且无凭证」为前置，一旦写进去就永久恢复不了'
  );

  // 反向控制：库存放出后 watcher 的自动恢复必须仍然能救回这一单（这正是上一条断言在保护的能力）
  // 注：txHash 不能与其它用例重复——`paid_tx_hash` 上有唯一索引（同一笔链上支付只能确认一个订单）
  const recoverHash = '0x' + 'ef'.repeat(32);
  await db.run('UPDATE product_skus SET capacity = 5, committed = 0 WHERE product_id = ?', productId);
  const recovered = await applyEvent('OrderCreated', { orderId: o.escrowOrderId, buyer: BUYER, seller: SELLER, amount: AMOUNT }, { txHash: recoverHash, block: 7 });
  assert.equal(recovered, 1, 'watcher 应能自动恢复该单');
  assert.equal(await statusOf(o.orderId), 'escrowed');
  assert.equal((await rowOf(o.orderId)).paid_tx_hash, recoverHash, '恢复时补上凭证');
});

test('/sync 把 cancelled 恢复为 escrowed 时**在同一事务内**补写支付凭证（否则卖家必须同步两次才能发货）', async () => {
  /*
    这条钉的是源码审计 2026-09 复审的一处 P1：`/sync` 的 `movedToEscrowed` 分支此前只 append 镜像事件，
    **没有**补写 `paid_tx_hash`——而同一段代码的注释承诺
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
  // 商品与 SKU 由 insertProduct 一次造出（slug 是 CHAR(11)，时间列由服务器盖章）
  const { productId } = await insertProduct(db, {
    title: '可恢复库存商品',
    kind: 'physical',
    // 库存仍有额度（committed=1 且 capacity 足够）⇒ restockOrder 能成功，迁移会真的发生
    skus: [{ key: '', priceUsdtMicro: 100, capacity: 5, committed: 1 }],
  });

  const o = await insertOrder({ status: 'cancelled', productId, holdQty: 1, releasedAt: new Date(now), paidTxHash: null });
  assert.equal((await rowOf(o.orderId)).paid_tx_hash, null, '前置：该行无支付凭证');
  chainOrderFor = { buyer: BUYER, seller: SELLER, amount: AMOUNT, feeBps: 0, refundedAmount: '0', createdAtBlock: 8, status: 'Created' };
  emitCreatedLog = { escrowOrderId: o.escrowOrderId, buyer: BUYER, seller: SELLER, amount: AMOUNT };

  const res = await request(app)
    .post(`/api/orders/${o.orderNo}/sync`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({});
  emitCreatedLog = null;

  assert.equal(res.status, 200);
  assert.equal(res.body.code, 0, `库存可恢复 ⇒ 同步应成功：${JSON.stringify(res.body)}`);
  const row = await rowOf(o.orderId);
  assert.equal(row.status, 'escrowed', '迁移已发生');
  // **本用例的核心断言**：迁移成功的那一刻凭证必须已在同一事务内写好
  assert.ok(
    row.paid_tx_hash && /^0x[0-9a-f]{64}$/.test(row.paid_tx_hash),
    `**关键**：恢复成功即补写凭证（escrowed 及以上必有 paid_tx_hash 这条不变量）——实得 ${row.paid_tx_hash}`
  );
  // 本分支按设计追加的是 `Sync:` 镜像事件（不是 OrderCreated——那是另一条按块反查的分支）
  assert.ok(
    (await eventsOf(o.orderId)).some((e) => String(e.name).startsWith('Sync:')),
    '恢复成功应留下一条 Sync: 镜像事件（时间线要它）'
  );

  /*
    卖家视角的后果（**不调 `/ship` 本身**：那条端点在本测试夹具里会走真实的链上/通知路径而挂住，
    与本用例要证明的事无关）。`/ship` 的拒绝条件就是这一条判据：
      `if (!order.paid_tx_hash) return fail(res, '该订单缺少链上支付凭证…')` —— 见 routes/orders.js。
    所以"同步一次之后就能发货"等价于"这一行此刻已有凭证"，直接断它更准、也更快。
  */
  assert.ok(
    (await rowOf(o.orderId)).paid_tx_hash,
    '同步一次之后该行即满足发货前置（旧实现这里为空 ⇒ /ship 被拒，逼卖家再同步一次）'
  );
});



