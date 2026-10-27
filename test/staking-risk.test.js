/**
 * 本节点保证金状况的只读读数（`GET /api/shop/staking`）。
 *
 * 节点不读取任何 Registry：这里只覆盖
 *  1. 纯判据 `shortfallOf`（pool < required 才算跌破，等于下限通过）；
 *  2. 未配 Staking / RPC 读失败 ⇒ available:false + reason，且不下发任何像结论的金额；
 *  3. Staking 链上路径：池额/下限/缺口可算，30s 记忆化。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';
import { makeCtx, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;

const { shortfallOf, stakingShortfall, resetStakingRiskCache } = await import('../src/stakingRisk.js');
const config = (await import('../src/config.js')).default;

const STAKING = '0x' + 'bb'.repeat(20);
const OP = String(config.shop.owner).toLowerCase();

test('shortfallOf：严格小于下限才算跌破；等于下限通过；缺口 = required − pool', () => {
  assert.deepEqual(shortfallOf('400', '1000'), { below: true, shortfallWei: '600' });
  assert.deepEqual(shortfallOf('1000', '1000'), { below: false, shortfallWei: '0' });
  assert.deepEqual(shortfallOf('1500', '1000'), { below: false, shortfallWei: '0' });
  assert.deepEqual(shortfallOf(0n, 0n), { below: false, shortfallWei: '0' });
});

test('未配置 MK_STAKING_ADDRESS：available=false（没有保证金层就谈不上池额）', async () => {
  resetStakingRiskCache();
  const saved = config.chain.stakingAddress;
  config.chain.stakingAddress = '';
  try {
    const d = await stakingShortfall({ force: true });
    assert.equal(d.available, false);
    assert.match(d.reason, /MK_STAKING_ADDRESS/);
    assert.equal(d.poolWei, null);
  } finally {
    config.chain.stakingAddress = saved;
    resetStakingRiskCache();
  }
});

const STAKING_ABI = new Interface([
  'function poolOf(address operator) view returns (uint256)',
  'function payoutFloors(address operator) view returns (uint256 exposure, uint256 required)',
]);

let chain = {
  poolWei: '400',
  exposureWei: '300',
  requiredWei: '1000',
  floorsReadable: true,
};
let poolCalls = 0;

function handleRpc(j) {
  const to = String(j.params?.[0]?.to || '').toLowerCase();
  const data = String(j.params?.[0]?.data || '');
  const selector = data.slice(0, 10);
  if (j.method !== 'eth_call') return { error: { code: -32601, message: `unit-test: ${j.method}` } };
  if (to === STAKING.toLowerCase()) {
    if (selector === STAKING_ABI.getFunction('poolOf').selector) {
      poolCalls += 1;
      return { result: STAKING_ABI.encodeFunctionResult('poolOf', [BigInt(chain.poolWei)]) };
    }
    if (selector === STAKING_ABI.getFunction('payoutFloors').selector) {
      if (!chain.floorsReadable) return { error: { code: -32000, message: 'unit-test: payoutFloors 读取失败' } };
      return {
        result: STAKING_ABI.encodeFunctionResult('payoutFloors', [
          BigInt(chain.exposureWei),
          BigInt(chain.requiredWei),
        ]),
      };
    }
  }
  return { error: { code: -32601, message: `unit-test: 未预期的调用 ${to} ${selector}` } };
}

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const out = Array.isArray(parsed)
      ? parsed.map((j) => ({ jsonrpc: '2.0', id: j?.id ?? 1, ...handleRpc(j) }))
      : { jsonrpc: '2.0', id: parsed?.id ?? 1, ...handleRpc(parsed) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});

before(async () => {
  await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
  config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
  config.chain.stakingAddress = STAKING;
});
after(() => rpcServer.close());

test('链上读数：池额/下限/缺口，并按 30s 缓存省 RPC', async () => {
  resetStakingRiskCache();
  poolCalls = 0;
  const res = await request(app).get('/api/shop/staking').expect(200);
  assertOk(res);
  const d = res.body.data;
  assert.equal(d.available, true);
  assert.equal(d.reason, null);
  assert.equal(d.stakingAddress, STAKING);
  assert.equal(d.operator, OP);
  assert.equal('registryAddress' in d, false, '节点读数不得再依赖 Registry');
  assert.equal(d.poolWei, '400');
  assert.equal(d.exposureWei, '300');
  assert.equal(d.requiredWei, '1000');
  assert.equal(d.belowFloor, true);
  assert.equal(d.shortfallWei, '600');
  assert.ok(d.shortfallDecimal.length > 0, '同时给人类可读的 BTY 小数');
  assert.equal(poolCalls, 1, 'poolOf 只读一次');

  poolCalls = 0;
  const again = await request(app).get('/api/shop/staking').expect(200);
  assertOk(again);
  assert.equal(poolCalls, 0, '缓存期内不再打链上');
  assert.equal(again.body.data.shortfallWei, '600');
});

test('RPC 读不到 payoutFloors：available=false，不把读不到当"没有缺口"', async () => {
  resetStakingRiskCache();
  chain.floorsReadable = false;
  try {
    const d = await stakingShortfall({ force: true });
    assert.equal(d.available, false);
    assert.match(d.reason, /读不到本节点 Staking/);
    assert.equal(d.poolWei, null);
  } finally {
    chain.floorsReadable = true;
    resetStakingRiskCache();
  }
});
