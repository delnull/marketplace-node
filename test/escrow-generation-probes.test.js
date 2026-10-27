/**
 * 代次探针清单的**漂移守卫**。
 *
 * 背景（真实发生过的失效）：`assertEscrowGeneration` 曾经把三个探针内联写死，于是"链上有这三个读法、
 * 却没有 `sellerOpenExposure`"的 Escrow 能让节点**绿灯启动**，然后在运行时把四条出金路径整体弄死。
 * 修法是把探针收口成唯一清单 `ESCROW_GENERATION_PROBES`，本文件守它不掉队。
 *
 * 守三条（每条都对应一种"静默失效"）：
 *   ① 清单里的形状必须真的出现在节点自己的 `ESCROW_ABI` 里——否则探针会以
 *      "本节点 ABI 里没有这个片段" 报错，运维看到的是"合约不对"，真因却是清单/ABI 漂移；
 *   ② 清单里的形状必须与**合约源码**里真实存在的函数同名——否则探针探的是一个不存在的读法；
 *   ③ 清单必须覆盖"合约伙伴会调、而旧一代没有"的那几个读法（`sellerOpenExposure` /
 *      `sellerNetAtSettle` / `totalOpenExposure`）、委员会读法与提货争议读法。
 *
 * 判据来源是**文本对拍**（合约源码 + 本包 ABI 字符串）：跨语言镜像只能靠对拍守。
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
  const out = new Set();
  /*
    修饰词顺序不定（`uint64 public constant` / `address public immutable` / `uint64 constant public`）：
    先收整段修饰词，再确认其中有 public，名字取修饰词之后那个标识符。
  */
  for (const m of ESCROW_SOL.matchAll(
    /\b(?:mapping\s*\([^)]*\)|uint\d*|address|bool|bytes32)\s+((?:(?:public|private|internal|constant|immutable|override)\s+)+)(\w+)\s*(?:=|;)/g
  )) {
    if (/\bpublic\b/.test(m[1])) out.add(m[2]);
  }
  return out;
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

test('代次探针：必须覆盖合约伙伴/提货争议/委员会那几组读法', () => {
  /*
    这三项不是"节点自己调"的，而是 `Staking` 调的：
      · `sellerOpenExposure` ⇒ `payoutFloors`（四条出金路径的前置）——缺它 = 店主提不出钱；
      · `sellerNetAtSettle`  ⇒ `_penaltyBase`（罚没单笔上限基准）——缺它 = 罚没 fail-closed 上限 0；
      · `totalOpenExposure`  ⇒ `Staking._probeEscrow` 的形状判据。
  */
  const names = new Set(ESCROW_GENERATION_PROBES.map((p) => p.shape.split('(')[0]));
  for (const required of ['sellerOpenExposure', 'sellerNetAtSettle', 'totalOpenExposure']) {
    assert.ok(names.has(required), `代次探针清单必须包含 ${required}（否则那种"自检通过但出金死掉"的状态又能进来）`);
  }
  // 提货争议读法：缺失时提货声明永远停在"处理中"（watcher 读不到结论），而节点日志里只有一条读不到
  for (const required of ['claimCase', 'sellerClaimExposure', 'claimEpoch']) {
    assert.ok(names.has(required), `代次探针清单必须包含提货争议读法 ${required}`);
  }
  // 委员会读法：缺 `arbiters/arbiterThreshold/committeeEpoch` ⇒ 仲裁人视角整体关闭
  for (const required of ['arbiters', 'arbiterThreshold', 'committeeEpoch', 'orderEpoch', 'orderArbiters', 'orderThreshold']) {
    assert.ok(names.has(required), `代次探针清单必须包含委员会读法 ${required}`);
  }
});

test('代次探针：运行时 getCommittee / committeeForOrder 用到的选择器必须在清单里（源码对拍）', () => {
  /*
    只钉一份"必须包含"的名单还不够：新增一个裁决委员会读法（例如换掉 orderThreshold）时，
    清单与运行时代码会各走各的。这里从 chain.js 的**委员会区段**里抽出所有 `escrow.<name>(`
    调用，再要求它们逐个出现在探针清单里——"清单写着 A、代码调 B"在文本层面就红。
  */
  const start = CHAIN_SRC.indexOf('// ── 委员会');
  const end = CHAIN_SRC.indexOf('// ── 委员会读取结束');
  assert.ok(start > 0 && end > start, 'chain.js 的委员会区段标记变了——本守卫需要同步更新');
  const used = new Set(
    [...CHAIN_SRC.slice(start, end).matchAll(/\bescrow\.(\w+)\s*\(/g)].map((m) => m[1])
  );
  assert.ok(used.size >= 6, `委员会区段至少要读到 6 个选择器（实际 ${[...used].join(', ') || '无'}）`);
  const probed = new Set(ESCROW_GENERATION_PROBES.map((p) => p.shape.split('(')[0]));
  const missing = [...used].filter((name) => !probed.has(name));
  assert.deepEqual(missing, [], `运行时调用的委员会读法不在代次探针清单里：${missing.join(', ')}`);
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
