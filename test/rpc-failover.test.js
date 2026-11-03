/**
 * RPC 多端点：解析、顺序故障转移、启动链 ID 自检。
 *
 * 这里钉住两件事：
 *   · 端点列表是**按顺序尝试**的，前面的失败必须轮到后面的（watcher/合约读数不能因
 *     单个公共 RPC 抖动停摆）；
 *   · 启动自检允许"一条腿不可达"，但**不允许**把另一条链的端点混进列表——那会让
 *     收据/日志校验的信任根指向错误的链。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import config, { parseRpcUrls } from '../src/config.js';
import { rpcRequest, assertChainId } from '../src/chain.js';

const realFetch = globalThis.fetch;
const realUrls = config.chain.rpcUrls;

after(() => {
  globalThis.fetch = realFetch;
  config.chain.rpcUrls = realUrls;
});

const json = (result) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('MK_RPC_URL 解析：逗号分隔、去空白、去重、保留顺序；空值用三个公共端点', () => {
  assert.deepEqual(
    parseRpcUrls(' https://a.example/eth , https://b.example/eth ,https://a.example/eth '),
    ['https://a.example/eth', 'https://b.example/eth']
  );
  const defaults = parseRpcUrls('');
  assert.equal(defaults.length, 3);
  assert.match(defaults[0], /bityuan\.com\/eth$/);
  assert.throws(() => parseRpcUrls('ftp://a.example/eth'), /http\/https/);
  assert.throws(() => parseRpcUrls('not a url'), /非法 URL/);
});

test('rpcRequest 按顺序故障转移：第一个端点网络失败，第二个返回结果', async () => {
  config.chain.rpcUrls = ['https://bad.example/eth', 'https://good.example/eth'];
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('bad.example')) throw new Error('connect ECONNREFUSED');
    return json('0x123');
  };
  assert.equal(await rpcRequest('eth_blockNumber', []), '0x123');
  assert.deepEqual(seen, ['https://bad.example/eth', 'https://good.example/eth']);

  // 全部失败：错误里要能看出每个端点都试过
  globalThis.fetch = async () => { throw new Error('down'); };
  await assert.rejects(() => rpcRequest('eth_blockNumber', []), /所有 RPC 端点均失败（2 个）/);
});

test('assertChainId：一个端点不可达仍通过；可达但 chainId 不符 ⇒ 拒绝启动', async () => {
  config.chain.rpcUrls = ['https://down.example/eth', 'https://good.example/eth'];
  globalThis.fetch = async (url) => {
    if (String(url).includes('down.example')) throw new Error('timeout');
    return json('0xbb7'); // 2999
  };
  assert.equal(await assertChainId(), 2999);

  globalThis.fetch = async (url) => {
    if (String(url).includes('down.example')) throw new Error('timeout');
    return json('0x1'); // 另一条链
  };
  await assert.rejects(() => assertChainId(), /RPC 链 ID 不匹配/);

  // 全部不可达 ⇒ 拒绝启动（不是"没有读数也算通过"）
  globalThis.fetch = async () => { throw new Error('down'); };
  await assert.rejects(() => assertChainId(), /所有 RPC 端点都不可用/);
});
