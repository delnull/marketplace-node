/**
 * `POST /api/orders/:id/chain-event`：把一笔**已上链的终局事件**即时回写。
 *
 * 这条路径补的是 `/sync` 的语义缺口：`/sync` 读 `Settled` 快照，分不清"买家确认收货 /
 * 超时释放 / 仲裁判付"，只能落 `settled`；本接口按 txHash 验证收据里的
 * `ReceiptConfirmed` / `OrderExpiredReleased`，再调用 watcher 的**唯一事件处理器**
 * `applyEvent`，直接落 `confirmed` / `expired`。
 *
 * 单测用假 JSON-RPC 只回答 `eth_getTransactionReceipt`；`fetchOrderFor` 走 setup 里
 * 现成的"按本地行回显链上参数"桩（见 setup.mjs），因此不需要伪造 getOrder 的 ABI 返回值。
 * 确认边界在 setup 里已钉成 `latest`，这里再把 finality 设 0，避免假 RPC 还要实现块高。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface, Wallet } from 'ethers';
import { assertOk, insertOrder, login, makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

const config = (await import('../src/config.js')).default;
const { ESCROW_ABI, setFinalizedBlockTagReader } = await import('../src/chain.js');
const { setChainOrderFetcher } = await import('../src/chainOrder.js');

const iface = new Interface(ESCROW_ABI);
const ESCROW = config.chain.escrowAddress;

/*
  收据按 **txHash** 存在 Map 里，而不是靠全局变量切换：Node 测试文件之间的并行
  不会共享进程，但同一文件里调试/并发执行时全局变体仍会互相踩；按请求键取收据
  可以让每笔交易独立决定 orderId / 事件名 / 变体。
*/
let txSeq = 0;
const newTxHash = () => '0x' + String(++txSeq).padStart(64, 'f');
const rpcReceipts = new Map();

/** 收据变体：覆盖 canonical 地址 / 执行失败 / 无事件 / 双事件等拒绝分支 */
function receiptFor(txHash) {
  const key = String(txHash).toLowerCase();
  const spec = rpcReceipts.get(key);
  if (!spec) return null;
  const { orderId, eventName = 'ReceiptConfirmed', variant = 'ok' } = spec;
  const base = {
    transactionHash: key,
    transactionIndex: '0x0',
    blockHash: '0x' + 'b'.repeat(64),
    blockNumber: '0x1',
    from: owner.address,
    to: ESCROW,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    contractAddress: null,
    logs: [
      {
        address: ESCROW,
        topics: [iface.getEvent(eventName).topicHash, orderId],
        data: '0x',
        blockNumber: '0x1',
        blockHash: '0x' + 'b'.repeat(64),
        transactionHash: key,
        transactionIndex: '0x0',
        removed: false,
        logIndex: '0x0',
      },
    ],
    logsBloom: '0x' + '0'.repeat(512),
    status: '0x1',
    type: '0x2',
    effectiveGasPrice: '0x1',
  };
  if (variant === 'bad-status') base.status = '0x0';
  if (variant === 'wrong-address') base.logs[0].address = '0x' + 'd'.repeat(40);
  if (variant === 'empty-logs') base.logs = [];
  if (variant === 'double-event') base.logs.push({ ...base.logs[0], logIndex: '0x1' });
  return base;
}
const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const batch = Array.isArray(parsed);
    const list = batch ? parsed : [parsed];
    const responses = list.map((j) => {
      const id = j.id ?? 1;
      if (j.method === 'eth_getTransactionReceipt') {
        return { jsonrpc: '2.0', id, result: receiptFor(j.params?.[0]) };
      }
      if (j.method === 'eth_chainId') return { jsonrpc: '2.0', id, result: '0xbb7' };
      if (j.method === 'eth_blockNumber') return { jsonrpc: '2.0', id, result: '0x100' };
      return { jsonrpc: '2.0', id, result: null };
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(batch ? responses : responses[0]));
  });
});
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
config.chain.rpcUrls = [`http://127.0.0.1:${rpcServer.address().port}`];
config.escrow.finalityBlocks = 0;
after(() => rpcServer.close());

let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, 'b');

/** 已上链、已交付待确认的单（本地状态 shipped；链上事件尚未被 watcher 扫到） */
async function shippedOrder() {
  const buyerWallet = Wallet.createRandom();
  const buyerToken = (await login(ctx, buyerWallet)).token;
  const made = await insertOrder(db, {
    buyer: buyerWallet.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    status: 'shipped',
    amountWei: '1000000000000000000',
    timeoutBlocks: 120,
    paidTxHash: payHash(),
  });
  return { ...made, buyerWallet, buyerToken };
}

test('chain-event：验证 ReceiptConfirmed 后直接落 confirmed，幂等重放不再迁移', async () => {
  const { orderNo, escrowOrderId, buyerToken } = await shippedOrder();
  const txHash = newTxHash();
  rpcReceipts.set(txHash, { orderId: escrowOrderId });
  const res = await request(app)
    .post(`/api/orders/${orderNo}/chain-event`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ txHash })
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.status, 'confirmed');
  assert.deepEqual(res.body.data.chainEvent, { name: 'ReceiptConfirmed', applied: true });
  const row = await db.get('SELECT status FROM orders WHERE order_no = ?', orderNo);
  assert.equal(row.status, 'confirmed');

  const again = await request(app)
    .post(`/api/orders/${orderNo}/chain-event`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ txHash })
    .expect(200);
  assertOk(again);
  assert.deepEqual(again.body.data.chainEvent, { name: 'ReceiptConfirmed', applied: false });
  assert.equal((await db.get('SELECT status FROM orders WHERE order_no = ?', orderNo)).status, 'confirmed');
});

test('chain-event：OrderExpiredReleased 落 expired（不先落 settled）', async () => {
  const { orderNo, escrowOrderId, buyerToken } = await shippedOrder();
  const txHash = newTxHash();
  rpcReceipts.set(txHash, { orderId: escrowOrderId, eventName: 'OrderExpiredReleased' });
  const res = await request(app)
    .post(`/api/orders/${orderNo}/chain-event`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ txHash })
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.status, 'expired');
  assert.deepEqual(res.body.data.chainEvent, { name: 'OrderExpiredReleased', applied: true });
});

test('chain-event：事件 orderId 不属于本单 ⇒ 拒绝，不能拿别单的确认来推进', async () => {
  const a = await shippedOrder();
  const b = await shippedOrder();
  const txHash = newTxHash();
  rpcReceipts.set(txHash, { orderId: a.escrowOrderId });
  const res = await request(app)
    .post(`/api/orders/${b.orderNo}/chain-event`)
    .set('Authorization', `Bearer ${b.buyerToken}`)
    .send({ txHash })
    .expect(400);
  assert.notEqual(res.body.code, 0);
  assert.equal((await db.get('SELECT status FROM orders WHERE order_no = ?', b.orderNo)).status, 'shipped');
});

test('chain-event：缺少支付凭证的草稿单拒绝回写（避免 confirmed 无凭证）', async () => {
  const buyerWallet = Wallet.createRandom();
  const buyerToken = (await login(ctx, buyerWallet)).token;
  const made = await insertOrder(db, {
    buyer: buyerWallet.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    status: 'draft',
    escrowOrderId: '0x' + 'c'.repeat(64),
    amountWei: '1000000000000000000',
    timeoutBlocks: 120,
  });
  const txHash = newTxHash();
  rpcReceipts.set(txHash, { orderId: made.escrowOrderId });
  const res = await request(app)
    .post(`/api/orders/${made.orderNo}/chain-event`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ txHash })
    .expect(409);
  assert.notEqual(res.body.code, 0);
  assert.equal((await db.get('SELECT status FROM orders WHERE order_no = ?', made.orderNo)).status, 'draft');
});

for (const [variant, status] of [
  ['bad-status', 400],
  ['wrong-address', 400],
  ['empty-logs', 400],
  ['double-event', 400],
]) {
  test(`chain-event：收据 ${variant} 拒绝且不改状态`, async () => {
    const o = await shippedOrder();
    const txHash = newTxHash();
    rpcReceipts.set(txHash, { orderId: o.escrowOrderId, variant });
    const res = await request(app)
      .post(`/api/orders/${o.orderNo}/chain-event`)
      .set('Authorization', `Bearer ${o.buyerToken}`)
      .send({ txHash })
      .expect(status);
    assert.notEqual(res.body.code, 0);
    assert.equal((await db.get('SELECT status FROM orders WHERE order_no = ?', o.orderNo)).status, 'shipped');
  });
}

test('chain-event：未达确认深度拒绝且不改状态', async () => {
  const o = await shippedOrder();
  const txHash = newTxHash();
  rpcReceipts.set(txHash, { orderId: o.escrowOrderId });
  config.escrow.finalityBlocks = 1;
  setFinalizedBlockTagReader(async () => 0);
  try {
    const res = await request(app)
      .post(`/api/orders/${o.orderNo}/chain-event`)
      .set('Authorization', `Bearer ${o.buyerToken}`)
      .send({ txHash })
      .expect(409);
    assert.notEqual(res.body.code, 0);
    assert.equal((await db.get('SELECT status FROM orders WHERE order_no = ?', o.orderNo)).status, 'shipped');
  } finally {
    config.escrow.finalityBlocks = 0;
    setFinalizedBlockTagReader(async () => 'latest');
  }
});

test('chain-event：非买家/非店员拒绝；非法哈希拒绝', async () => {
  const { orderNo, escrowOrderId, buyerToken } = await shippedOrder();
  const txHash = newTxHash();
  rpcReceipts.set(txHash, { orderId: escrowOrderId });
  const stranger = Wallet.createRandom();
  const strangerToken = (await login(ctx, stranger)).token;
  const forbidden = await request(app)
    .post(`/api/orders/${orderNo}/chain-event`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .send({ txHash })
    .expect(403);
  assert.notEqual(forbidden.body.code, 0);

  const bad = await request(app)
    .post(`/api/orders/${orderNo}/chain-event`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ txHash: '0x1234' })
    .expect(200);
  assert.notEqual(bad.body.code, 0);
});

test('chain-event：链上订单参数与本单不一致拒绝，不改本地状态', async () => {
  const o = await shippedOrder();
  const txHash = newTxHash();
  rpcReceipts.set(txHash, { orderId: o.escrowOrderId });
  setChainOrderFetcher(async () => ({
    status: 'Settled',
    buyer: o.buyerWallet.address.toLowerCase(),
    // 同 orderId 的诱饵单：店主不同 ⇒ chainParamsMatch 必须拒绝
    seller: '0x' + 'e'.repeat(40),
    amount: '1',
    timeoutBlocks: 120,
    token: '0x' + '0'.repeat(40),
    refundRequested: false,
    refundRejected: false,
    refundedAmount: '0',
  }));
  const res = await request(app)
    .post(`/api/orders/${o.orderNo}/chain-event`)
    .set('Authorization', `Bearer ${o.buyerToken}`)
    .send({ txHash })
    .expect(400);
  assert.notEqual(res.body.code, 0);
  assert.equal((await db.get('SELECT status FROM orders WHERE order_no = ?', o.orderNo)).status, 'shipped');
});
