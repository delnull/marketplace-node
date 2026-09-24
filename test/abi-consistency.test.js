/**
 * **跨语言契约守卫**：`contracts/src/*.sol` 是唯一真值，消费端的手写 ABI 必须跟着它走。
 *
 * 为什么需要（源码审计 2026-09 复审）：本仓的 ABI 声明是手写的（合约 sol / `node/src/chain.js` /
 * `frontend/src/chain.ts` / `node/scripts/register-node.mjs`），它们之间的漂移**全是静默的**：
 *   · `Escrow.Order` 加一个字段而 `Staking.IEscrowMinimal.Order` 漏改 ⇒ 跨合约静态调用按**位置**
 *     解码，字段错位不报错，只会读到错的字（历史上真发生过：所有罚没测试报 OrderNotFinal）；
 *   · 前端 ABI 少写一个 `error X()` ⇒ ethers v6 解不出自定义错误，用户拿到
 *     `execution reverted (unknown custom error)` 而不是中文提示；
 *   · `MarketplaceRegistry.NodeInfo` 加一个 `string code` 而登记脚本漏改 ⇒ 末尾字段恒 undefined
 *     （少写末尾字段**不会**报错，这正是它危险的地方）；
 *   · watcher 要扫的事件名在 ABI 里没声明 ⇒ `filters[name]` 是 undefined，抛在轮询里，该事件永远扫不到。
 *
 * 这些都是**纯文本契约**：不需要起链、不需要编译就能守，所以放在测试套件里每次 `npm test` 都跑。
 * 判据只有一条：**合约声明了什么，真正消费它的那一端就得认什么**（谁消费、谁才需要声明——
 * 节点不广播交易，就不要求它声明一堆只在钱包侧才会看到的 revert 名）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/**
 * 本守卫需要"整套代码都在这棵树里"：它要同时读 `contracts/src/*.sol`（真值）、节点的 ABI 与前端 `chain.ts`。
 * 只有节点这一份代码时没有可比对的对象——那时**跳过而不是失败**（失败会把"这棵树里跑不了"
 * 说成"契约漂移"）。判据用文件存在性，两种目录布局下这行代码都不用改。
 */
const FULL_TREE =
  fs.existsSync(path.join(ROOT, 'contracts/src/Escrow.sol')) && fs.existsSync(path.join(ROOT, 'node/src/chain.js'));
const guard = FULL_TREE ? test : test.skip;
const read = (rel) =>
  fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : '';

const ESCROW_SOL = read('contracts/src/Escrow.sol');
const REGISTRY_SOL = read('contracts/src/MarketplaceRegistry.sol');
const STAKING_SOL = read('contracts/src/Staking.sol');
const NODE_CHAIN = read('node/src/chain.js');
const FE_CHAIN = read('frontend/src/chain.ts');
const REGISTER_SCRIPT = read('node/scripts/register-node.mjs');

/** 抽某个 .sol 里声明的全部 `error Name(...)` 名（去重、排序） */
const errorsOf = (sol) =>
  [...new Set([...sol.matchAll(/^\s*error\s+(\w+)\s*\(/gm)].map((m) => m[1]))].sort();

/** 抽某份 ABI 文本里声明的 `error Name(...)` 名（去重、排序） */
const abiErrorsOf = (text) => [...new Set([...text.matchAll(/error\s+(\w+)\s*\(/g)].map((m) => m[1]))].sort();

/** 抽一个 Solidity 结构体里的字段名（按声明顺序；忽略注释与空行） */
function structFields(sol, structName) {
  const m = sol.match(new RegExp(`struct ${structName} \\{([\\s\\S]*?)\\n {4}\\}`));
  assert.ok(m, `没能从源码里切出 struct ${structName}`);
  return m[1]
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => l && !l.startsWith('/*') && !l.startsWith('*'))
    .map((l) => l.match(/^(\S+\s+)*?(\w+)\s*;/)?.[2])
    .filter(Boolean);
}

/**
 * **前端必须声明合约的每一个自定义错误**——它是唯一会把 revert 展示给用户的一端
 * （ethers v6 只有 ABI 里声明过的 error 才解得出来，否则只剩 `unknown custom error`）。
 */
guard('前端 ABI 声明了 Escrow 的每一个自定义错误', () => {
  const declared = errorsOf(ESCROW_SOL);
  assert.ok(declared.length >= 20, `只从 Escrow.sol 抽到 ${declared.length} 个 error，正则或文件结构变了`);
  const known = new Set(abiErrorsOf(FE_CHAIN));
  const missing = declared.filter((e) => !known.has(e));
  assert.deepEqual(
    missing,
    [],
    `frontend/src/chain.ts 未声明这些 Escrow 错误（用户只会看到 "unknown custom error"）：${missing.join(', ')}`
  );
});

guard('前端 ABI 声明了 MarketplaceRegistry 的每一个自定义错误', () => {
  const declared = errorsOf(REGISTRY_SOL);
  assert.ok(declared.length >= 15, `只从 MarketplaceRegistry.sol 抽到 ${declared.length} 个 error`);
  const known = new Set(abiErrorsOf(FE_CHAIN));
  const missing = declared.filter((e) => !known.has(e));
  assert.deepEqual(missing, [], `frontend/src/chain.ts 未声明：${missing.join(', ')}`);
});

/** 反向：合约里删掉的 error 不该在前端留下"永远不会命中"的死声明 */
guard('反向：前端 ABI 里的自定义错误都还在合约里（Ownable 等库错误除外）', () => {
  const declared = new Set([...errorsOf(ESCROW_SOL), ...errorsOf(REGISTRY_SOL)]);
  const libraryErrors = new Set([
    'OwnableUnauthorizedAccount',
    'OwnableInvalidOwner',
    'ReentrancyGuardReentrantCall',
  ]);
  const stale = abiErrorsOf(FE_CHAIN).filter((e) => !declared.has(e) && !libraryErrors.has(e));
  assert.deepEqual(stale, [], `前端 ABI 里这些自定义错误在合约里已不存在（死声明）：${stale.join(', ')}`);
});

/**
 * `Staking.IEscrowMinimal.Order` 必须与 `Escrow.Order` **逐字段同名同序**：
 * 跨合约静态调用按位置解码，字段错位不报错、只读到错的字。
 */
guard('Staking.IEscrowMinimal.Order 与 Escrow.Order 字段顺序一致', () => {
  const fields = structFields(ESCROW_SOL, 'Order');
  assert.ok(fields.length >= 10, `Escrow.Order 只解析出 ${fields.length} 个字段：${fields.join(',')}`);
  const minimal = structFields(STAKING_SOL, 'Order');
  assert.deepEqual(
    minimal,
    fields,
    'IEscrowMinimal.Order 必须与 Escrow.Order 逐字段同名同序（漏一个 ⇒ 罚没门槛读到随机字节）'
  );
});

/** 取一段 ABI 文本里 `returns (tuple(...))` 的字段列表（要求显式 `tuple(`，避免误匹配函数参数表） */
function tupleFieldsOf(text, fnName) {
  const m = text.match(new RegExp(`${fnName}\\(\\) view returns \\(tuple\\(([^)]*)\\)`));
  assert.ok(m, `${fnName} 的 tuple 声明没找到`);
  return m[1];
}

/**
 * `MarketplaceRegistry.NodeInfo` 的字段必须全部出现在**读它**的那些 tuple 声明里。
 * 缺末尾字段不会立刻报错（ethers 仍能解码前面的），只会让该字段恒为 undefined。
 */
guard('NodeInfo 的字段全部出现在前端的 tuple 声明里', () => {
  const fields = structFields(REGISTRY_SOL, 'NodeInfo');
  assert.ok(fields.includes('code'), `NodeInfo 应含 code 字段，实际：${fields.join(',')}`);
  // 前端把 tuple 抽成了常量（NODE_TUPLE），先把它取出来再比对
  const c = FE_CHAIN.match(/const NODE_TUPLE\s*=\s*'([^']*)'/);
  assert.ok(c, 'frontend/src/chain.ts 里找不到 NODE_TUPLE 常量');
  for (const f of fields) {
    assert.ok(
      new RegExp(`\\b${f}\\b`).test(c[1]),
      `前端 NODE_TUPLE 少了 NodeInfo 字段 ${f}（末尾字段缺失不会报错，只会恒为 undefined）`
    );
  }
});

guard('NodeInfo 的字段全部出现在登记脚本的 tuple 声明里', () => {
  const fields = structFields(REGISTRY_SOL, 'NodeInfo');
  const tuple = tupleFieldsOf(REGISTER_SCRIPT, 'getActiveNodes');
  for (const f of fields) {
    assert.ok(new RegExp(`\\b${f}\\b`).test(tuple), `登记脚本的 tuple 少了字段 ${f}（当前声明：${tuple}）`);
  }
});

/**
 * **watcher 必须能解析它要扫的每一个事件**：`escrowWatcher` 用
 * `escrow.queryFilter(escrow.filters[name]())` 拉日志——ABI 里没声明的事件名会让
 * `filters[name]` 直接是 undefined，抛在轮询里，该事件**永远扫不到**且不会有人发现。
 * 判据取 watcher 自己的 `EVENTS` 清单（清单本身漏挂会先被它自己的用例拦下）。
 */
guard('escrowWatcher 的 EVENTS 清单都能在节点 ABI 里解析出过滤器', async () => {
  const { EVENTS } = await import('../src/escrowWatcher.js');
  assert.ok(EVENTS.length >= 9, `EVENTS 只有 ${EVENTS.length} 项，清单疑似被改坏`);
  const missing = EVENTS.filter((e) => !new RegExp(`event\\s+${e}\\s*\\(`).test(NODE_CHAIN));
  assert.deepEqual(
    missing,
    [],
    `node/src/chain.js 未声明 watcher 要扫的事件：${missing.join(', ')}（queryFilter 会拿到 undefined 过滤器）`
  );
});
