/**
 * 启动期**下单超时窗口自检**（`chain.checkOrderTimeoutBounds`）——2026-10-14 新增。
 *
 * 为什么必须有这一条：`MK_ESCROW_TIMEOUT_BLOCKS` 是**本节点自己**填进订单草稿的值
 * （买家只是照签），而合约对它另有常量上下界。配越界时 `Escrow.createOrder` 会以
 * `TimeoutTooShort` / `InvalidTimeout` 回滚，而节点**绿灯启动、店面看起来在营业**——
 * 运营方看到的现象是"没人下单"，与真实原因（一个环境变量）相隔十万八千里。
 * 本仓对"配置错误型 DoS"一律在入口拦掉（库结构/密钥/风控闸/合约代次都是这么做的），
 * 这一条此前是唯一漏网的。
 *
 * 本文件用本地假 JSON-RPC 回答 `minTimeoutBlocks()` / `MAX_TIMEOUT_BLOCKS()`，
 * 覆盖"界内通过 / 太低 / 太高 / 读不到（不得说成越界）"四种结论。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { ESCROW_ABI, checkOrderTimeoutBounds } = await import('../src/chain.js');
const config = (await import('../src/config.js')).default;
const iface = new Interface(ESCROW_ABI);

const SEL_MIN = iface.getFunction('minTimeoutBlocks').selector;
const SEL_MAX = iface.getFunction('MAX_TIMEOUT_BLOCKS').selector;

/** 假链上的读数；`null` = 该读法直接报错（模拟旧一代合约 / RPC 抖动） */
let chainBounds = { min: 17_280n, max: 518_400n };

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
      if (j?.method === 'eth_call') {
        const sel = String(j?.params?.[0]?.data || '').slice(0, 10).toLowerCase();
        if (sel === SEL_MIN) {
          return chainBounds.min === null
            ? { error: { code: -32000, message: 'unit-test: 读不到 minTimeoutBlocks()' } }
            : { result: iface.encodeFunctionResult('minTimeoutBlocks', [chainBounds.min]) };
        }
        if (sel === SEL_MAX) {
          return chainBounds.max === null
            ? { error: { code: -32000, message: 'unit-test: 读不到 MAX_TIMEOUT_BLOCKS()' } }
            : { result: iface.encodeFunctionResult('MAX_TIMEOUT_BLOCKS', [chainBounds.max]) };
        }
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
after(() => rpcServer.close());

/** 用给定的配置值与链上读数跑一次自检（配置是模块级单例，用完还原） */
async function runWith(configured, bounds) {
  const prev = config.escrow.timeoutBlocks;
  chainBounds = bounds;
  config.escrow.timeoutBlocks = configured;
  try {
    return await checkOrderTimeoutBounds();
  } finally {
    config.escrow.timeoutBlocks = prev;
    chainBounds = { min: 17_280n, max: 518_400n };
  }
}

test('界内通过：默认 7 天（120960）落在链上 [17280, 518400] 之间', async () => {
  const r = await runWith(120_960, { min: 17_280n, max: 518_400n });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.min, 17_280);
  assert.equal(r.max, 518_400);
  assert.match(r.message, /120960/);
});

test('边界值本身通过（等于下界 / 等于上限都不算越界）', async () => {
  assert.equal((await runWith(17_280, { min: 17_280n, max: 518_400n })).ok, true, '恰好等于下界');
  assert.equal((await runWith(518_400, { min: 17_280n, max: 518_400n })).ok, true, '恰好等于上限');
});

test('配得太低：必须判 too-low 并给出可照做的下一值（TimeoutTooShort 的现场）', async () => {
  const r = await runWith(1_000, { min: 17_280n, max: 518_400n });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-low');
  assert.equal(r.min, 17_280);
  assert.match(r.message, /TimeoutTooShort/, '要说清链上会以哪个错误拒绝（否则只看到"没人下单"）');
  assert.match(r.message, /17280/, '要给出该改成什么值');
});

test('配得太高：必须判 too-high（InvalidTimeout 的现场）', async () => {
  const r = await runWith(999_999, { min: 17_280n, max: 518_400n });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-high');
  assert.equal(r.max, 518_400);
  assert.match(r.message, /InvalidTimeout/);
});

test('下界随治理调整：合约把 minTimeoutBlocks 提到 7 天后，原来合法的 1 天就变成 too-low', async () => {
  // 同一个配置值 17280，在两个不同的链上读数下结论相反 —— 证明判据取自链上而不是抄来的常量
  assert.equal((await runWith(17_280, { min: 17_280n, max: 518_400n })).ok, true);
  const raised = await runWith(17_280, { min: 120_960n, max: 518_400n });
  assert.equal(raised.ok, false);
  assert.equal(raised.reason, 'too-low');
  assert.match(raised.message, /120960/);
});

test('读不到链上读数：判 unknown，**不得**说成越界（"读不到"与"越界"是两件事）', async () => {
  for (const bounds of [
    { min: null, max: 518_400n },
    { min: 17_280n, max: null },
    { min: null, max: null },
  ]) {
    const label = `min=${String(bounds.min)} max=${String(bounds.max)}`;
    const r = await runWith(120_960, bounds);
    assert.equal(r.ok, false, `读不到必须不放行：${label}`);
    assert.equal(r.reason, 'unknown', `读不到不得报成越界：${label}`);
    assert.equal(r.min, null);
    assert.match(r.message, /读不到/);
  }
});

test('配置值本身非法（0 / 负数 / 非数字）：判 unknown 而不是默默用它下单', async () => {
  for (const bad of [0, -1, Number.NaN]) {
    const r = await runWith(bad, { min: 17_280n, max: 518_400n });
    assert.equal(r.ok, false, `非法配置必须拦下：${String(bad)}`);
    assert.equal(r.reason, 'unknown');
    assert.match(r.message, /不是正整数/);
  }
});
