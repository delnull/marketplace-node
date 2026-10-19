/**
 * 质押跌破注册门槛的清单（治理只读读数，`GET /api/shop/staking`）。
 *
 * 覆盖三件容易静默出错的事：
 *  1. **纯判据**（`pickUnderStaked`）：`poolOf < minStakeToRegister` 才入列（等于门槛**不算**跌破，
 *     与合约 `_checkMinStake` 的 `<` 同口径）；缺口从大到小；门槛为 0 时"跌破"不成立；
 *     池额读不到的店**不进清单**（不凭空指控）。
 *  2. **降级语义**：未配 registry / 门槛>0 但保证金合约未链接 / RPC 读失败 ⇒ `available:false`
 *     + reason，且 **shortfall 为空但绝不是"没有跌破门槛的店"**——调用方必须看 available。
 *  3. **链上路径**：用本地假 JSON-RPC 回答 Registry/Staking 的四个只读调用，验证
 *     "1 次活跃店主列表 + N 次 poolOf" 真的能算出清单，并验证 30s 记忆化（面板轮询不放大 RPC）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';
import { makeCtx, assertOk, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;

const { pickUnderStaked, stakingShortfall, resetStakingRiskCache } = await import('../src/stakingRisk.js');
const config = (await import('../src/config.js')).default;

const REGISTRY = '0x' + 'aa'.repeat(20);
const STAKING = '0x' + 'bb'.repeat(20);
const OP_A = '0x' + '11'.repeat(20);
const OP_B = '0x' + '22'.repeat(20);
const OP_C = '0x' + '33'.repeat(20);

// ── ① 纯判据 ──

test('pickUnderStaked：严格小于门槛才入列、按缺口排序、门槛为 0 时清单为空', () => {
  const pools = new Map([
    [OP_A, '1500'],
    [OP_B, '400'],
    [OP_C, '0'],
  ]);
  const under = pickUnderStaked([OP_A, OP_B, OP_C], '1000', pools);
  assert.deepEqual(under, [
    { operator: OP_C, poolWei: '0', shortfallWei: '1000' },
    { operator: OP_B, poolWei: '400', shortfallWei: '600' },
  ]);
  // 等于门槛 = 达标（合约判据是 `<`，这里必须逐字同口径，否则会误报一家合规的店）
  assert.deepEqual(pickUnderStaked([OP_A], '1500', pools), []);
  // 门槛 0 = 无门槛：不产生任何"缺口"
  assert.deepEqual(pickUnderStaked([OP_C], '0', pools), []);
  // 池额缺失（读失败）按 0 处理——宁可报出来让人核对，也不要静默漏掉一家
  assert.deepEqual(pickUnderStaked([OP_A, '0x' + '44'.repeat(20)], '1000', { [OP_A]: '1500' }), [
    { operator: '0x' + '44'.repeat(20), poolWei: '0', shortfallWei: '1000' },
  ]);
  // 普通对象与大小写：operator 一律归一小写
  assert.deepEqual(pickUnderStaked([OP_B.toUpperCase()], '1000', { [OP_B]: 400n }), [
    { operator: OP_B, poolWei: '400', shortfallWei: '600' },
  ]);
});

// ── ② 降级：未配置 / 读不到 ──

test('未配置 MK_REGISTRY_ADDRESS：available=false + reason，且不下发任何"像结论"的清单', async () => {
  resetStakingRiskCache();
  const saved = config.chain.registryAddress;
  config.chain.registryAddress = '';
  try {
    const res = await request(app).get('/api/shop/staking').expect(200);
    assertOk(res);
    const d = res.body.data;
    assert.equal(d.available, false);
    assert.match(d.reason, /MK_REGISTRY_ADDRESS/);
    assert.deepEqual(d.shortfall, [], '读不到就是空清单 + available=false（绝不是"没有跌破门槛的店"）');
    assert.equal(d.minStakeToRegisterWei, null);
  } finally {
    config.chain.registryAddress = saved;
    resetStakingRiskCache();
  }
});

// ── ③ 链上路径（假 JSON-RPC） ──

const REGISTRY_ABI = new Interface([
  'function minStakeToRegister() view returns (uint256)',
  'function stakingContract() view returns (address)',
  // 只声明被测模块会读的那一个（模块侧同款纪律）：`getActiveNodes()` 取 operator 字段
  'function getActiveNodes() view returns (tuple(address operator, string endpoint, address escrowAddress, uint64 registeredAtBlock, uint64 updatedAtBlock, bool active, bool suspended, string code)[])',
]);
const STAKING_ABI = new Interface(['function poolOf(address operator) view returns (uint256)']);

/** 用例设定的链上状态 */
let chain = {
  minStakeWei: '1000',
  staking: STAKING,
  operators: [OP_A, OP_B, OP_C],
  pools: { [OP_A]: '1500', [OP_B]: '400', [OP_C]: '0' }, // 缺失的 operator = 读失败
};
let poolCalls = 0;

function handleRpc(j) {
  const to = String(j.params?.[0]?.to || '').toLowerCase();
  const data = String(j.params?.[0]?.data || '');
  const selector = data.slice(0, 10);
  if (j.method !== 'eth_call') return { error: { code: -32601, message: `unit-test: ${j.method}` } };
  if (to === REGISTRY.toLowerCase()) {
    if (selector === REGISTRY_ABI.getFunction('minStakeToRegister').selector) {
      return { result: REGISTRY_ABI.encodeFunctionResult('minStakeToRegister', [BigInt(chain.minStakeWei)]) };
    }
    if (selector === REGISTRY_ABI.getFunction('stakingContract').selector) {
      return { result: REGISTRY_ABI.encodeFunctionResult('stakingContract', [chain.staking]) };
    }
    if (selector === REGISTRY_ABI.getFunction('getActiveNodes').selector) {
      // 本读数的判据是"谁在册"，所以只有 operator 字段需要有值；其余按空串/零填
      const rows = chain.operators.map((op) => [
        op,
        '',
        '0x0000000000000000000000000000000000000000',
        1n,
        1n,
        true,
        false,
        '',
      ]);
      return { result: REGISTRY_ABI.encodeFunctionResult('getActiveNodes', [rows]) };
    }
  }
  if (to === STAKING.toLowerCase() && selector === STAKING_ABI.getFunction('poolOf').selector) {
    poolCalls += 1;
    const arg = '0x' + data.slice(10 + 24, 10 + 64); // 地址在 32 字节槽的低 20 字节
    const key = arg.toLowerCase();
    if (!(key in chain.pools)) return { error: { code: -32000, message: 'unit-test: poolOf 读取失败' } };
    return { result: STAKING_ABI.encodeFunctionResult('poolOf', [BigInt(chain.pools[key])]) };
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
/*
  链上读数与 provider 必须在 **before() 里**接上：node:test 在本文件还没求值完就可能开始跑已注册的
  用例，顶层的 `config.chain.*` 赋值会与用例体交错（第一次 `await` 时被写进来/写回去）——
  曾经的故障形态正是"用例把 registry 置空、却在 await 期间被顶层赋值覆盖回去"，看起来像实现有 bug。
*/
before(async () => {
  await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
  config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
  config.chain.registryAddress = REGISTRY;
});
after(() => rpcServer.close());

test('链上读数：列出跌破门槛的店主（1 次活跃列表 + N 次 poolOf），并按缺口排序', async () => {
  resetStakingRiskCache();
  poolCalls = 0;
  const res = await request(app).get('/api/shop/staking').expect(200);
  assertOk(res);
  const d = res.body.data;
  assert.equal(d.available, true);
  assert.equal(d.reason, null);
  assert.equal(d.minStakeToRegisterWei, '1000');
  assert.equal(d.stakingAddress, STAKING);
  assert.equal(d.total, 3);
  assert.equal(d.checked, 3);
  assert.equal(d.truncated, false);
  assert.equal(d.shortfallCount, 2, 'B(400) 与 C(0) 跌破 1000；A(1500) 达标');
  assert.deepEqual(d.shortfall.map((s) => s.operator), [OP_C, OP_B], '缺口最大的在前');
  assert.equal(d.shortfall[0].shortfallWei, '1000');
  assert.equal(d.shortfall[0].poolWei, '0');
  assert.ok(d.shortfall[0].shortfallDecimal.length > 0, '同时给人类可读的 BTY 小数（weiToDecimal 唯一实现）');
  assert.equal(poolCalls, 3, '每个活跃店主恰好一次 poolOf（不重复打 RPC）');

  // 30s 记忆化：面板轮询/巡检脚本不会把 RPC 放大成每次请求 N+1 次
  poolCalls = 0;
  const again = await request(app).get('/api/shop/staking').expect(200);
  assertOk(again);
  assert.equal(poolCalls, 0, '缓存期内不再打链上');
  assert.equal(again.body.data.shortfallCount, 2);
});

test('门槛为 0（默认无门槛）时不下发缺口清单，也不去打 poolOf', async () => {
  resetStakingRiskCache();
  const saved = chain.minStakeWei;
  chain.minStakeWei = '0';
  poolCalls = 0;
  try {
    const res = await request(app).get('/api/shop/staking?refresh=1').expect(200);
    assertOk(res);
    const d = res.body.data;
    assert.equal(d.available, true);
    assert.equal(d.minStakeToRegisterWei, '0');
    assert.equal(d.shortfallCount, 0, '无门槛 ⇒ 不可能"跌破"');
    assert.equal(poolCalls, 0, '连一次 poolOf 都不该发（省 RPC）');
  } finally {
    chain.minStakeWei = saved;
    resetStakingRiskCache();
  }
});

test('门槛 >0 但 Registry 未链接保证金合约 ⇒ available=false（读不到位，不是"没有跌破的店"）', async () => {
  resetStakingRiskCache();
  const saved = chain.staking;
  chain.staking = '0x' + '0'.repeat(40);
  try {
    const res = await request(app).get('/api/shop/staking?refresh=1').expect(200);
    assertOk(res);
    assert.equal(res.body.data.available, false);
    assert.match(res.body.data.reason, /未链接保证金合约/);
    assert.equal(res.body.data.shortfallCount, 0);
  } finally {
    chain.staking = saved;
    resetStakingRiskCache();
  }
});

test('单个店主 poolOf 读失败：不进清单，但在 reason 里如实说明（不静默吞掉）', async () => {
  resetStakingRiskCache();
  const saved = { ...chain.pools };
  delete chain.pools[OP_B]; // B 的 poolOf revert（比如合约异常）
  try {
    const res = await request(app).get('/api/shop/staking?refresh=1').expect(200);
    assertOk(res);
    const d = res.body.data;
    assert.equal(d.available, true);
    assert.match(d.reason, /读取失败/);
    assert.deepEqual(d.shortfall.map((s) => s.operator), [OP_C], 'B 读不到 ⇒ 不入清单（不凭空指控）');
  } finally {
    chain.pools = saved;
    resetStakingRiskCache();
  }
});
