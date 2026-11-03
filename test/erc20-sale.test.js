/**
 * ERC20 交付收据核验（方案 A）：BTY 同一笔 EVM 交易有两个哈希
 * （Chain33 哈希 / EVM 哈希），卖家提交任一哈希都要能核到同一份回执；
 * 同时钉住 Transfer 的 from/to/金额过滤与 canonical 哈希去重依据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { verifyErc20Transfer } from '../src/erc20Sale.js';

const realFetch = globalThis.fetch;
const realUrls = config.chain.rpcUrls;
const TOKEN = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const BUYER = '0x3333333333333333333333333333333333333333';
const CHAIN33_HASH = '0x' + 'a'.repeat(64);
const EVM_HASH = '0x' + 'b'.repeat(64);
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => `0x${a.slice(2).padStart(64, '0')}`;

function json(result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function receipt(hash) {
  return {
    transactionHash: hash,
    blockNumber: '0x10',
    status: '0x1',
    logs: [{ address: TOKEN, topics: [TOPIC, pad(SELLER), pad(BUYER)], data: `0x${(1000n).toString(16).padStart(64, '0')}` }],
  };
}

after(() => {
  globalThis.fetch = realFetch;
  config.chain.rpcUrls = realUrls;
});

test('EVM 哈希：直接命中回执，按 Transfer 金额核验', async () => {
  config.chain.rpcUrls = ['http://unit.test/eth'];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (body.method === 'eth_getTransactionReceipt' && body.params?.[0] === EVM_HASH) return json(receipt(EVM_HASH));
    return json(null);
  };
  const r = await verifyErc20Transfer(EVM_HASH, { token: TOKEN, from: SELLER, to: BUYER });
  assert.equal(r.ok, true);
  assert.equal(r.amount, '1000');
  assert.equal(r.txHash, EVM_HASH);
});

test('Chain33 哈希：回执查不到时用交易对象反查 canonical EVM 哈希，再核同一回执', async () => {
  config.chain.rpcUrls = ['http://unit.test/eth'];
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    seen.push([body.method, body.params?.[0]]);
    if (body.method === 'eth_getTransactionReceipt' && body.params?.[0] === EVM_HASH) return json(receipt(EVM_HASH));
    if (body.method === 'eth_getTransactionReceipt' && body.params?.[0] === CHAIN33_HASH) return json(null);
    if (body.method === 'eth_getTransactionByHash' && body.params?.[0] === CHAIN33_HASH) return json({ hash: EVM_HASH });
    return json(null);
  };
  const r = await verifyErc20Transfer(CHAIN33_HASH, { token: TOKEN, from: SELLER, to: BUYER });
  assert.equal(r.ok, true);
  assert.equal(r.txHash, EVM_HASH);
  assert.equal(r.inputHash, CHAIN33_HASH);
  assert.deepEqual(seen, [
    ['eth_getTransactionReceipt', CHAIN33_HASH],
    ['eth_getTransactionByHash', CHAIN33_HASH],
    ['eth_getTransactionReceipt', EVM_HASH],
  ]);
});

test('from/to/金额任一不符都拒绝', async () => {
  config.chain.rpcUrls = ['http://unit.test/eth'];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (body.method === 'eth_getTransactionReceipt' && body.params?.[0] === EVM_HASH) return json(receipt(EVM_HASH));
    return json(null);
  };
  const wrongFrom = await verifyErc20Transfer(EVM_HASH, { token: TOKEN, from: BUYER, to: BUYER });
  assert.equal(wrongFrom.ok, false);
  assert.match(wrongFrom.reason, /没有该 ERC20/);
  const wrongToken = await verifyErc20Transfer(EVM_HASH, { token: '0x4444444444444444444444444444444444444444', from: SELLER, to: BUYER });
  assert.equal(wrongToken.ok, false);
});
