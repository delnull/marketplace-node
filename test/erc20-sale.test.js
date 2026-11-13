/**
 * ERC20 交付收据核验（方案 A）：BTY 同一笔 EVM 交易有两个哈希
 * （Chain33 哈希 / EVM 哈希），店主提交任一哈希都要能核到同一份回执；
 * 同时钉住 Transfer 的 from/to/金额过滤与 canonical 哈希去重依据。
 *
 * 链上读现在走 `rpcRequest`（node:http + AbortSignal），不再是 `globalThis.fetch`；
 * 这里用本地假 JSON-RPC 服务器，与 siwe-1271 / committee-rpc 同一套做法。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import config from '../src/config.js';
import { verifyErc20Transfer } from '../src/erc20Sale.js';

const realUrls = config.chain.rpcUrls;
const TOKEN = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const BUYER = '0x3333333333333333333333333333333333333333';
const CHAIN33_HASH = '0x' + 'a'.repeat(64);
const EVM_HASH = '0x' + 'b'.repeat(64);
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => `0x${a.slice(2).padStart(64, '0')}`;

function receipt(hash) {
  return {
    transactionHash: hash,
    blockNumber: '0x10',
    status: '0x1',
    logs: [{ address: TOKEN, topics: [TOPIC, pad(SELLER), pad(BUYER)], data: `0x${(1000n).toString(16).padStart(64, '0')}` }],
  };
}

after(() => {
  config.chain.rpcUrls = realUrls;
});

/** 起一个本地假 RPC：handler(j) 返回 {result} / {error}；返回 stop 与 seen */
async function startRpc(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j = {};
      try {
        j = JSON.parse(body || '{}');
      } catch {}
      seen.push([j.method, j.params?.[0]]);
      const out = handler(j);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 1, ...out }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.chain.rpcUrls = [`http://127.0.0.1:${server.address().port}`];
  return {
    seen,
    stop: () => new Promise((r) => server.close(r)),
  };
}

test('EVM 哈希：直接命中回执，按 Transfer 金额核验', async () => {
  const rpc = await startRpc((j) => ({
    result: j.method === 'eth_getTransactionReceipt' && j.params?.[0] === EVM_HASH ? receipt(EVM_HASH) : null,
  }));
  try {
    const r = await verifyErc20Transfer(EVM_HASH, { token: TOKEN, from: SELLER, to: BUYER });
    assert.equal(r.ok, true);
    assert.equal(r.amount, '1000');
    assert.equal(r.txHash, EVM_HASH);
  } finally {
    await rpc.stop();
  }
});

test('Chain33 哈希：回执查不到时用交易对象反查 canonical EVM 哈希，再核同一回执', async () => {
  const rpc = await startRpc((j) => {
    if (j.method === 'eth_getTransactionReceipt' && j.params?.[0] === EVM_HASH) return { result: receipt(EVM_HASH) };
    if (j.method === 'eth_getTransactionReceipt' && j.params?.[0] === CHAIN33_HASH) return { result: null };
    if (j.method === 'eth_getTransactionByHash' && j.params?.[0] === CHAIN33_HASH) return { result: { hash: EVM_HASH } };
    return { result: null };
  });
  try {
    const r = await verifyErc20Transfer(CHAIN33_HASH, { token: TOKEN, from: SELLER, to: BUYER });
    assert.equal(r.ok, true);
    assert.equal(r.txHash, EVM_HASH);
    assert.equal(r.inputHash, CHAIN33_HASH);
    assert.deepEqual(rpc.seen, [
      ['eth_getTransactionReceipt', CHAIN33_HASH],
      ['eth_getTransactionByHash', CHAIN33_HASH],
      ['eth_getTransactionReceipt', EVM_HASH],
    ]);
  } finally {
    await rpc.stop();
  }
});

test('from/to/金额任一不符都拒绝', async () => {
  const rpc = await startRpc((j) => ({
    result: j.method === 'eth_getTransactionReceipt' && j.params?.[0] === EVM_HASH ? receipt(EVM_HASH) : null,
  }));
  try {
    const wrongFrom = await verifyErc20Transfer(EVM_HASH, { token: TOKEN, from: BUYER, to: BUYER });
    assert.equal(wrongFrom.ok, false);
    assert.match(wrongFrom.reason, /没有该 ERC20/);
    const wrongToken = await verifyErc20Transfer(EVM_HASH, { token: '0x4444444444444444444444444444444444444444', from: SELLER, to: BUYER });
    assert.equal(wrongToken.ok, false);
  } finally {
    await rpc.stop();
  }
});
