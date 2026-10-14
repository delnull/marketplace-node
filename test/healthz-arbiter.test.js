/**
 * `/healthz` 必须能看见"仲裁人读数读不到"（2026-10-14）。
 *
 * 背景：`getArbiterAddress()` 在**读不到**时返回 `null`（= 谁都不是仲裁人），这是刻意的安全方向
 * ——否则 RPC 故障期间一把**已被轮换掉**的旧仲裁人密钥仍能读到收货信息、交付码与双方售后陈述。
 * 但那个方向的代价是「合法的仲裁人在抖动期间也进不来」，而在此之前这个状态**只能靠翻日志**看：
 * `/healthz` 一切正常、仲裁人只看到自己被拒，运维无从区分"你不是仲裁人"与"节点读不到"。
 *
 * 判据（两半）：① 读不到时 `known=false` 且 `arbiter=null`（不得显示成某个地址）；
 *              ② 确证读到时 `known=true` 且给出那个地址。
 *
 * 装配注记：`chain.getProvider()` 是**惰性单例**（`config.chain.rpcUrl` 只在首次取用时生效），
 * 所以本文件只起**一台**假 RPC、靠一个可变开关切换"这次读得到/读不到"，
 * 而不是每条例用一条新 URL（那样第二条会继续打旧地址，测的是缓存而不是本题）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Wallet, Interface } from 'ethers';
import { makeCtx, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;

const arbiter = Wallet.createRandom();
const arbiterOnchain = arbiter.address.toLowerCase();

const { ESCROW_ABI, getArbiterAddress, __resetArbiterCacheForTest } = await import('../src/chain.js');
const config = (await import('../src/config.js')).default;
const iface = new Interface(ESCROW_ABI);
const SEL_ARBITER = iface.getFunction('arbiter').selector;

/** true = 这一轮模拟"RPC 读不到 arbiter()" */
let readFails = true;

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      parsed = {};
    }
    const one = (j) => {
      if (j?.method === 'eth_chainId') return { result: `0x${Number(config.chain.chainId).toString(16)}` };
      if (j?.method === 'eth_call' && String(j?.params?.[0]?.data || '').slice(0, 10).toLowerCase() === SEL_ARBITER) {
        return readFails
          ? { error: { code: -32000, message: 'unit-test: RPC 读不到 arbiter()' } }
          : { result: iface.encodeFunctionResult('arbiter', [arbiterOnchain]) };
      }
      return { error: { code: -32601, message: `unit-test: 未预期的 RPC 方法 ${j?.method}` } };
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
after(() => {
  rpcServer.close();
  __resetArbiterCacheForTest();
});

const health = async () => {
  const r = await request(app).get('/healthz').expect(200);
  assertOk(r);
  return r.body.data;
};

test('/healthz：仲裁人读不到时必须显式说"读不到"（known=false, arbiter=null）', async () => {
  readFails = true;
  __resetArbiterCacheForTest();

  // 先走一次真实的读取路径（鉴权点就是这么读的）：读到的是"不知道"
  assert.equal(await getArbiterAddress(), null, '读不到 ⇒ null（谁都不是仲裁人）');

  const h = await health();
  assert.ok(h.arbiter, 'healthz 必须有 arbiter 这一块（否则运维只能翻日志）');
  assert.equal(h.arbiter.known, false, '读不到 ⇒ known=false（这是一个独立结论，不是某个地址）');
  assert.equal(h.arbiter.arbiter, null, '读不到时不得显示成某个具体地址');
  assert.equal(h.arbiter.lastOk, null, '从未成功读到过 ⇒ 没有"最后一次成功读数"');
});

test('/healthz：确证读到仲裁人时给出地址与 known=true', async () => {
  readFails = false;
  __resetArbiterCacheForTest();
  assert.equal(await getArbiterAddress(), arbiterOnchain, '确证读到');

  const h = await health();
  assert.equal(h.arbiter.known, true, '确证 ⇒ known=true');
  assert.equal(h.arbiter.arbiter, arbiterOnchain);
  assert.equal(h.arbiter.lastOk?.addr, arbiterOnchain, '最后一次成功读数可查（排障线索）');
});
