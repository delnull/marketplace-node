/**
 * P1：**重组回退到创世块不能被当成"首启"。**
 *
 * 旧实现把 `watcher_block` 的 `null`（没有游标）与 `0`（游标在创世块）压成同一个数，
 * 再用 `if (!from)` 判首启。于是游标 ≤64 时一次重组回退把 `from` 变成 0，紧接着被改写成
 * `latest - 1`：新分叉上 `[回退点, latest-2]` 的事件**永不重放**——订单永远停在旧状态，
 * 日志里只有一句"检测到链重组"。
 *
 * 本用真 `pollOnce` + 本地假 JSON-RPC：游标放在块 5 且哈希与链上不一致（触发重组），
 * 链上在块 2 有一个 OrderCreated 日志。修好后回退到块 1 重扫，日志被应用（draft → escrowed）；
 * 旧实现会从 `latest-1` 开始扫，块 2 的日志看不到。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';
import { makeCtx, insertOrder, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { db, buyer, owner } = ctx;

const { pollOnce } = await import('../src/escrowWatcher.js');
const config = (await import('../src/config.js')).default;

const EVENT_IFACE = new Interface([
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, uint256 amount)',
]);
const createdEvent = EVENT_IFACE.getEvent('OrderCreated');
/** watcher 的 OrderCreated 预取会读 getOrder + orderToken（原生单） */
const CHAIN_IFACE = new Interface([
  'function getOrder(bytes32) view returns (address buyer, address seller, uint256 amount, uint64 timeoutBlocks, uint64 createdAtBlock, bool refundRequested, bool refundRejected, uint256 refundedAmount, uint8 status, bool buyerConfirmed)',
  'function orderToken(bytes32) view returns (address)',
]);

const HEAD = 100;
const FINALITY = Number(config.escrow.finalityBlocks || 0);
const LATEST = HEAD - FINALITY;
const CURSOR = 5;
const AMOUNT = '1000000000000000000';
const escrowOrderId = `0x${'ab'.repeat(32)}`;
/** 本次 pollOnce 的 eth_getLogs 区间（用于断言"确实从回退点重扫"） */
const logRanges = [];

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
        case 'eth_call': {
          const data = String(j.params?.[0]?.data || '');
          const sel = data.slice(0, 10);
          if (sel === CHAIN_IFACE.getFunction('orderToken').selector) {
            return {
              result: CHAIN_IFACE.encodeFunctionResult('orderToken', ['0x0000000000000000000000000000000000000000']),
            };
          }
          if (sel === CHAIN_IFACE.getFunction('getOrder').selector) {
            return {
              result: CHAIN_IFACE.encodeFunctionResult('getOrder', [
                buyer.address,
                owner.address,
                BigInt(AMOUNT),
                120960n,
                2n,
                false,
                false,
                0n,
                1, // Created
                false,
              ]),
            };
          }
          return { error: { code: -32601, message: `unit-test: 未预期的 eth_call selector ${sel}` } };
        }
        case 'eth_getBlockByNumber': {
          const n = Number(BigInt(j.params?.[0] ?? '0x0'));
          // 游标块 5 的链上哈希与库里记的（aa…）不一致 ⇒ 重组；其余块给一个稳定哈希
          const hash = n === CURSOR ? `0x${'bb'.repeat(32)}` : `0x${'dd'.repeat(32)}`;
          return { result: { number: `0x${n.toString(16)}`, hash } };
        }
        case 'eth_getLogs': {
          const f = j.params?.[0] || {};
          logRanges.push({ from: Number(BigInt(f.fromBlock ?? '0x0')), to: Number(BigInt(f.toBlock ?? '0x0')) });
          const topic0 = String(f.topics?.[0] || '').toLowerCase();
          if (topic0 !== createdEvent.topicHash.toLowerCase()) return { result: [] };
          const log = EVENT_IFACE.encodeEventLog(createdEvent, [
            escrowOrderId,
            buyer.address,
            owner.address,
            BigInt(AMOUNT),
          ]);
          return {
            result: [
              {
                address: config.chain.escrowAddress,
                topics: log.topics,
                data: log.data,
                blockNumber: '0x2',
                blockHash: `0x${'ee'.repeat(32)}`,
                transactionHash: `0x${'12'.repeat(32)}`,
                transactionIndex: '0x0',
                logIndex: '0x0',
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

/*
  `blockHashOf` 走原始 `fetch`，而 setup 默认把 globalThis.fetch 禁掉（防触网）。
  这里换成一个只服务上面那台本地假 RPC 的最小实现。
*/
globalThis.fetch = async (_url, init) => {
  const payload = JSON.parse(String(init?.body || '{}'));
  const response = await new Promise((resolve, reject) => {
    const req = http.request(
      config.chain.rpcUrl,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
  return { json: async () => JSON.parse(response.text) };
};

after(async () => {
  rpcServer.close();
});

test('游标 ≤64 的重组：回退到创世块之后重扫，分叉上的事件被重放（不是跳到链头）', async () => {
  const order = await insertOrder(db, {
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    status: 'draft',
    amountWei: AMOUNT,
    escrowOrderId,
  });

  // 游标在块 5、哈希记为 aa…，与链上块 5 的 bb… 不同 ⇒ 本回应判定为重组
  await db.run(
    "UPDATE node SET watcher_block = ?, watcher_hash = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1",
    CURSOR,
    `0x${'aa'.repeat(32)}`
  );

  const r = await pollOnce();
  assert.ok(!r.skipped, `节点必须已接入托管合约：${JSON.stringify(r)}`);
  assert.ok(
    logRanges.some((x) => x.from === 1),
    `重组后必须从回退点重扫（期望 fromBlock=1，实际区间 ${JSON.stringify(logRanges)}）`
  );

  const row = await db.get('SELECT status FROM orders WHERE id = ?', order.orderId);
  assert.equal(row.status, 'escrowed', '回退区间内块 2 的 OrderCreated 必须被重放（旧实现会永远跳过它）');

  const node = await db.get('SELECT watcher_block FROM node WHERE id = 1');
  assert.equal(Number(node.watcher_block), LATEST, '扫到本轮链头（finality 深度之后）后游标推进');
});

test('"没有游标"（NULL）与"游标在 0"仍然是两件事：只有 NULL 走首启', async () => {
  await db.run('UPDATE node SET watcher_block = NULL, watcher_hash = NULL WHERE id = 1');
  await db.run("UPDATE orders SET status = 'draft' WHERE id = (SELECT order_id FROM order_chain WHERE escrow_order_id = ?)", escrowOrderId);
  logRanges.length = 0;
  const r = await pollOnce();
  assert.ok(!r.skipped);
  // 首启（未配 START_BLOCK）从 latest-1 开始：所有事件过滤器都只扫 [latest, latest] 这一段
  assert.ok(logRanges.length > 0, '必须真的发起日志查询');
  assert.ok(
    logRanges.every((x) => x.from === LATEST && x.to === LATEST),
    `首启仍按原口径从链头开始（实际 ${JSON.stringify(logRanges)}）`
  );
});

test('追平链头后隔一轮重扫游标块：head 刚可见的日志不会因游标已推进而永久丢失', async () => {
  await db.run(
    'UPDATE node SET watcher_block = ?, watcher_hash = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1',
    LATEST,
    `0x${'dd'.repeat(32)}`
  );
  logRanges.length = 0;
  const first = await pollOnce();
  assert.equal(first.upToDate, true, '第一轮只标记待重扫，不应把游标块当成新块');
  assert.equal(logRanges.length, 0, '追平后的第一轮不重复扫块');

  const second = await pollOnce();
  assert.ok(!second.upToDate, '第二轮应重扫游标块（表现为落后 1 块）');
  assert.equal(second.scanned.from, LATEST, '第二轮必须重扫最新块');
  assert.equal(second.scanned.to, LATEST, '第二轮重扫范围只到链头');
});
