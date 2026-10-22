/**
 * P1：**日志的发布者必须在本地再验一次。**
 *
 * ethers 的 `queryFilter` 只是把 address 放进 `eth_getLogs` 的 filter —— 那是一个由 RPC 执行的
 * **承诺**，不是返回值的性质。一个错误/被劫持的 RPC 可以返回任意合约发出的同 topic 日志；如果
 * watcher 只按 topic 解码，就会用"别人的合约"的事件推进本地订单（退款/结算/发码）。
 * 收据路径（routes/orders.js）与 Registry 日志路径都已核对 `log.address`，本用例钉住 watcher 这一条。
 *
 * 用真 `pollOnce` + 本地假 JSON-RPC：同一批 OrderCreated 日志里，一条来自托管地址、一条来自
 * 陌生地址；只有前者能把本地 draft 推进为 escrowed。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';
import { makeCtx, insertOrder } from './setup.mjs';

process.env.MK_ESCROW_FINALITY_BLOCKS = '0';

const ctx = await makeCtx();
const { db, buyer, owner } = ctx;

const config = (await import('../src/config.js')).default;
const { pollOnce } = await import('../src/escrowWatcher.js');

const EVENT_IFACE = new Interface([
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, address host, uint256 amount)',
]);
const createdEvent = EVENT_IFACE.getEvent('OrderCreated');

const HEAD = 100;
const AMOUNT = '1000000000000000000';
const CANONICAL = String(config.chain.escrowAddress).toLowerCase();
const FOREIGN = `0x${'33'.repeat(20)}`;
const canonicalOrderId = `0x${'01'.repeat(32)}`;
const foreignOrderId = `0x${'02'.repeat(32)}`;

function logFor(orderId) {
  const encoded = EVENT_IFACE.encodeEventLog(createdEvent, [
    orderId,
    buyer.address,
    owner.address,
    owner.address,
    BigInt(AMOUNT),
  ]);
  return { topics: encoded.topics, data: encoded.data };
}

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const one = (j) => {
      switch (j?.method) {
        case 'eth_chainId':
          return { result: `0x${Number(config.chain.chainId).toString(16)}` };
        case 'eth_blockNumber':
          return { result: `0x${HEAD.toString(16)}` };
        case 'eth_getLogs': {
          const f = j.params?.[0] || {};
          const topic0 = String(f.topics?.[0] || '').toLowerCase();
          if (topic0 !== createdEvent.topicHash.toLowerCase()) return { result: [] };
          return {
            result: [
              {
                ...logFor(foreignOrderId),
                address: FOREIGN,
                blockNumber: '0x32',
                blockHash: `0x${'aa'.repeat(32)}`,
                transactionHash: `0x${'0a'.repeat(32)}`,
                transactionIndex: '0x0',
                logIndex: '0x0',
                removed: false,
              },
              {
                ...logFor(canonicalOrderId),
                address: CANONICAL,
                blockNumber: '0x32',
                blockHash: `0x${'aa'.repeat(32)}`,
                transactionHash: `0x${'0b'.repeat(32)}`,
                transactionIndex: '0x0',
                logIndex: '0x1',
                removed: false,
              },
            ],
          };
        }
        default:
          return { error: { code: -32601, message: `unit-test: 未预期的 RPC 方法 ${j?.method}` } };
      }
    };
    const out = Array.isArray(parsed)
      ? parsed.map((j) => ({ jsonrpc: '2.0', id: j?.id ?? 1, ...one(j) }))
      : { jsonrpc: '2.0', id: parsed?.id ?? 1, ...one(parsed) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;

after(async () => {
  rpcServer.close();
});

test('watcher 丢掉非托管合约地址的 OrderCreated 日志，只应用托管地址那条', async () => {
  const foreign = await insertOrder(db, {
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    status: 'draft',
    amountWei: AMOUNT,
    escrowOrderId: foreignOrderId,
  });
  const canonical = await insertOrder(db, {
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    status: 'draft',
    amountWei: AMOUNT,
    escrowOrderId: canonicalOrderId,
  });
  await db.run('UPDATE node SET watcher_block = 0, watcher_hash = NULL WHERE id = 1');

  const r = await pollOnce();
  assert.ok(!r.skipped, `节点必须已接入托管合约：${JSON.stringify(r)}`);

  const foreignRow = await db.get('SELECT status FROM orders WHERE id = ?', foreign.orderId);
  assert.equal(foreignRow.status, 'draft', '陌生地址发出的同 topic 日志不得推进本地订单');
  const canonicalRow = await db.get('SELECT status FROM orders WHERE id = ?', canonical.orderId);
  assert.equal(canonicalRow.status, 'escrowed', '托管地址发出的日志仍必须正常应用');
});
