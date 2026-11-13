/**
 * RPC 多端点：解析、顺序故障转移、启动链 ID 自检。
 *
 * 这里钉住两件事：
 *   · 端点列表是**按顺序尝试**的，前面的失败必须轮到后面的（watcher/合约读数不能因
 *     单个公共 RPC 抖动停摆）；
 *   · 启动自检允许"一条腿不可达"，但**不允许**把另一条链的端点混进列表——那会让
 *     收据/日志校验的信任根指向错误的链。
 *
 * 链上读现在走 `rpcRequest`（node:http + AbortSignal），不再经过 `globalThis.fetch`；
 * 所以这里用本地假 JSON-RPC 服务器 + 一个"连上就断"的坏端点，而不是 stub fetch。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import config, { parseRpcUrls } from '../src/config.js';
import { rpcRequest, assertChainId } from '../src/chain.js';

const realUrls = config.chain.rpcUrls;

after(() => {
  config.chain.rpcUrls = realUrls;
});

const servers = [];
after(() => {
  for (const s of servers) s.close();
});

async function startRpc(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j = {};
      try {
        j = JSON.parse(body || '{}');
      } catch {}
      const out = handler(j);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 1, ...out }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/** 坏端点：TCP 连上后立刻断开（模拟公共 RPC 抖动/黑洞），不依赖端口竞态 */
async function startBadRpc() {
  const server = http.createServer((req) => {
    req.socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/** 半截响应端点：先写一段 JSON 再断开（模拟连接在 body 中途被 RST） */
async function startPartialRpc() {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"jsonrpc":"2.0","id":1,"res');
      setTimeout(() => res.destroy(), 20);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

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
  const bad = await startBadRpc();
  const good = await startRpc(() => ({ result: '0x123' }));
  config.chain.rpcUrls = [bad, good];
  assert.equal(await rpcRequest('eth_blockNumber', []), '0x123');

  // 全部失败：错误里要能看出每个端点都试过
  const bad2 = await startBadRpc();
  config.chain.rpcUrls = [bad, bad2];
  await assert.rejects(() => rpcRequest('eth_blockNumber', []), /所有 RPC 端点均失败（2 个）/);
});

test('rpcAt：响应写到一半被 RST 时立即失败，而不是等满超时', async () => {
  const partial = await startPartialRpc();
  config.chain.rpcUrls = [partial];
  const started = Date.now();
  await assert.rejects(
    () => rpcRequest('eth_blockNumber', [], { timeoutMs: 10_000 }),
    /所有 RPC 端点均失败（1 个）/
  );
  assert.ok(
    Date.now() - started < 2_000,
    `连接中途断开应立即失败，实际耗时 ${Date.now() - started}ms（等满 10s = 没监听 res error/aborted）`
  );
});

test('assertChainId：一个端点不可达仍通过；可达但 chainId 不符 ⇒ 拒绝启动', async () => {
  const bad = await startBadRpc();
  const good = await startRpc((j) => ({ result: j.method === 'eth_chainId' ? '0xbb7' : null }));
  config.chain.rpcUrls = [bad, good];
  assert.equal(await assertChainId(), 2999);

  const wrong = await startRpc((j) => ({ result: j.method === 'eth_chainId' ? '0x1' : null }));
  config.chain.rpcUrls = [bad, wrong];
  await assert.rejects(() => assertChainId(), /RPC 链 ID 不匹配/);

  // 全部不可达 ⇒ 拒绝启动（不是"没有读数也算通过"）
  const bad2 = await startBadRpc();
  config.chain.rpcUrls = [bad, bad2];
  await assert.rejects(() => assertChainId(), /所有 RPC 端点都不可用/);
});
