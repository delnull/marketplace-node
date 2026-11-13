/**
 * 委员会**真实读链路径**（不注入 `setCommitteeReader`）：原始 JSON-RPC + ABI 编解码 + 资格过滤。
 *
 * 背景：委员会读数现在走 `rpcRequest`（node:http + deadline），不再用 ethers provider 的
 * `withTimeout` race。本文件起一个本地假 RPC，只回答 4 个 `eth_call` 选择器，
 * 断言"读到名单 / 阈值 / 届次 / 撤销成员被排除"这条真实路径没有在编解码处错位。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';

import cfg from '../src/config.js';
const { ESCROW_ABI, getCommittee, setCommitteeReader, invalidateCommitteeCache } = await import('../src/chain.js');

const IFACE = new Interface(ESCROW_ABI);
const ARB1 = '0x1000000000000000000000000000000000000001';
const ARB2 = '0x2000000000000000000000000000000000000002';
const sel = (fn) => IFACE.getFunction(fn).selector;

const handles = {
  [sel('arbiters')]: () => IFACE.encodeFunctionResult('arbiters', [[ARB1, ARB2]]),
  [sel('arbiterThreshold')]: () => IFACE.encodeFunctionResult('arbiterThreshold', [2]),
  [sel('committeeEpoch')]: () => IFACE.encodeFunctionResult('committeeEpoch', [3]),
  [sel('revokedArbiter')]: (data) => {
    const tx = IFACE.parseTransaction({ data });
    const revoked = String(tx.args[0]).toLowerCase() === ARB2;
    return IFACE.encodeFunctionResult('revokedArbiter', [revoked]);
  },
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j = {};
    try {
      j = JSON.parse(body || '{}');
    } catch {}
    let out;
    if (j.method === 'eth_call') {
      const data = String(j.params?.[0]?.data || '');
      const fn = handles[data.slice(0, 10)];
      out = fn ? { result: fn(data) } : { error: { code: -32601, message: `unexpected selector ${data.slice(0, 10)}` } };
    } else if (j.method === 'eth_chainId') {
      out = { result: '0xbb7' };
    } else if (j.method === 'eth_blockNumber') {
      out = { result: '0x1' };
    } else {
      out = { error: { code: -32601, message: `unexpected method ${j.method}` } };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 1, ...out }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const savedUrls = cfg.chain.rpcUrls;
const savedEscrow = cfg.chain.escrowAddress;
cfg.chain.rpcUrls = [`http://127.0.0.1:${server.address().port}`];
cfg.chain.escrowAddress = '0x2222222222222222222222222222222222222222';
setCommitteeReader(null);
invalidateCommitteeCache();

after(() => {
  cfg.chain.rpcUrls = savedUrls;
  cfg.chain.escrowAddress = savedEscrow;
  invalidateCommitteeCache();
  server.close();
});

test('getCommittee 真实读链：读到名单/阈值/届次，撤销成员被排除', async () => {
  const c = await getCommittee({ force: true });
  assert.deepEqual(c, { arbiters: [ARB1], threshold: 2, epoch: 3 });
  /* 第二次走成功缓存：不再打 RPC（本文件不断言调用次数，只确认结果一致） */
  assert.deepEqual(await getCommittee(), { arbiters: [ARB1], threshold: 2, epoch: 3 });
});
