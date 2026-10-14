/**
 * 代次探针清单的**漂移守卫**（2026-10-14）。
 *
 * 背景（真实发生过的失效）：`assertEscrowGeneration` 曾经把三个探针内联写死，于是"链上有这三个读法、
 * 却没有 `sellerOpenExposure`"的 Escrow 能让节点**绿灯启动**，然后在运行时把四条出金路径整体弄死。
 * 修法是把探针收口成唯一清单 `ESCROW_GENERATION_PROBES`，本文件守它不掉队。
 *
 * 守三条（每条都对应一种"静默失效"）：
 *   ① 清单里的形状必须真的出现在节点自己的 `ESCROW_ABI` 里——否则探针会以
 *      "本节点 ABI 里没有这个片段" 报错，运维看到的是"合约不对"，真因却是清单/ABI 漂移；
 *   ② 清单里的形状必须与**合约源码**里真实存在的函数同名——否则探针探的是一个不存在的读法，
 *      它会永远失败 ⇒ 节点永远拒绝启动（配置期锁死，比运行期死掉好，但仍然是错）；
 *   ③ 清单必须覆盖"合约伙伴会调、而旧一代没有"的那几个读法（`sellerOpenExposure` /
 *      `sellerNetAtSettle` / `totalOpenExposure`）——它们是 `Staking` 的出金与罚没判据，
 *      漏掉就等于把"店主提不出钱"这种状态放行。
 *
 * 判据来源是**文本对拍**（合约源码 + 本包 ABI 字符串），与 `abi-consistency.test.js` 同款：
 * 跨语言镜像只能靠对拍守，靠注释是守不住的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESCROW_GENERATION_PROBES } from '../src/chain.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAIN_SRC = readFileSync(path.join(HERE, '..', 'src', 'chain.js'), 'utf8');
const ESCROW_SOL = readFileSync(path.join(HERE, '..', '..', 'contracts', 'src', 'Escrow.sol'), 'utf8');

/** 从 `ESCROW_ABI` 数组字面量里抽出所有 `function <name>(...)` 的名字（与运行时 ABI 同源） */
function abiFunctionNames() {
  const start = CHAIN_SRC.indexOf('const ESCROW_ABI');
  assert.ok(start > 0, '找不到 ESCROW_ABI 声明——本守卫需要按文件结构更新');
  const end = CHAIN_SRC.indexOf('\n];', start);
  assert.ok(end > start, '找不到 ESCROW_ABI 的结束位置');
  const seg = CHAIN_SRC.slice(start, end);
  return new Set([...seg.matchAll(/'function\s+(\w+)\s*\(/g)].map((m) => m[1]));
}

/** 合约源码里声明的 public/external 函数名（含 public mapping 生成的 getter） */
function solFunctionNames() {
  return new Set([...ESCROW_SOL.matchAll(/\bfunction\s+(\w+)\s*\(/g)].map((m) => m[1]));
}

/** 合约源码里 `public` 的 mapping/变量（会生成同名 getter，探针读的就是它们） */
function solPublicGetterNames() {
  return new Set(
    [...ESCROW_SOL.matchAll(/\b(?:mapping\s*\([^)]*\)|uint\d*|address|bool|bytes32)\s+public\s+(\w+)/g)].map(
      (m) => m[1]
    )
  );
}

test('代次探针：每个形状都在本节点的 Escrow ABI 里有对应片段', () => {
  const abi = abiFunctionNames();
  const missing = ESCROW_GENERATION_PROBES.filter((p) => !abi.has(p.shape.split('(')[0])).map((p) => p.shape);
  assert.deepEqual(missing, [], `探针形状在 ESCROW_ABI 里找不到（清单与 ABI 漂移）：${missing.join(', ')}`);
});

test('代次探针：每个形状在 Escrow.sol 里都真实存在（函数或 public getter）', () => {
  const fns = solFunctionNames();
  const getters = solPublicGetterNames();
  const missing = ESCROW_GENERATION_PROBES.filter((p) => {
    const n = p.shape.split('(')[0];
    return !fns.has(n) && !getters.has(n);
  }).map((p) => p.shape);
  assert.deepEqual(missing, [], `探针形状在 Escrow.sol 里不存在（探一个不存在的读法 = 节点永远拒绝启动）：${missing.join(', ')}`);
});

test('代次探针：必须覆盖合约伙伴会调、而旧一代没有的那几个读法', () => {
  /*
    这三项不是"节点自己调"的，而是 `Staking` 调的：
      · `sellerOpenExposure` ⇒ `payoutFloors`（四条出金路径的前置）——缺它 = 店主提不出钱；
      · `sellerNetAtSettle`  ⇒ `_penaltyBase`（罚没单笔上限基准）——缺它 = 罚没 fail-closed 上限 0；
      · `totalOpenExposure`  ⇒ `Staking._probeEscrow` 的形状判据。
    把它们算进本节点的代次门禁，是因为缺任一项的表现都是"店主资金动不了而日志无声"。
  */
  const names = new Set(ESCROW_GENERATION_PROBES.map((p) => p.shape.split('(')[0]));
  for (const required of ['sellerOpenExposure', 'sellerNetAtSettle', 'totalOpenExposure']) {
    assert.ok(names.has(required), `代次探针清单必须包含 ${required}（否则那种"自检通过但出金死掉"的状态又能进来）`);
  }
});

test('代次探针：zeroArg 种类合法，且每个形状的参数个数与零值种类一致', () => {
  const expectedArity = { none: 0, address: 1, bytes32: 1 };
  for (const { shape, zeroArg } of ESCROW_GENERATION_PROBES) {
    assert.ok(zeroArg in expectedArity, `${shape} 的 zeroArg=${zeroArg} 不是已知种类`);
    const argsStr = shape.slice(shape.indexOf('(') + 1, shape.lastIndexOf(')')).trim();
    const arity = argsStr === '' ? 0 : argsStr.split(',').length;
    assert.equal(arity, expectedArity[zeroArg], `${shape} 的参数个数与 zeroArg=${zeroArg} 不一致`);
  }
});
