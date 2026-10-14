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
const NOTARY_SOL = read('contracts/src/ReviewNotary.sol');
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

/**
 * **Staking 也要走同一条判据**（2026-10 补）：前端会把保证金合约的 revert 展示给店主与管理员
 * （申请/批准/驳回/直接释放、罚没、冻结），所以这些错误名同样必须在 ABI 里声明得出中文语义。
 * 此前这条守卫的真值集只收了 Escrow + Registry，于是"前端声明了 Staking 错误"会被反向检查
 * 误判成**死声明**——那是守卫的缺口，不是前端的错。
 */
guard('前端 ABI 声明了 Staking 的每一个自定义错误', () => {
  const declared = errorsOf(STAKING_SOL);
  assert.ok(declared.length >= 15, `只从 Staking.sol 抽到 ${declared.length} 个 error，正则或文件结构变了`);
  const known = new Set(abiErrorsOf(FE_CHAIN));
  const missing = declared.filter((e) => !known.has(e));
  assert.deepEqual(
    missing,
    [],
    `frontend/src/chain.ts 未声明这些 Staking 错误（店主/管理员只会看到 "unknown custom error"）：${missing.join(', ')}`
  );
});

/** 反向：合约里删掉的 error 不该在前端留下"永远不会命中"的死声明 */
guard('反向：前端 ABI 里的自定义错误都还在合约里（Ownable 等库错误除外）', () => {
  const declared = new Set([...errorsOf(ESCROW_SOL), ...errorsOf(REGISTRY_SOL), ...errorsOf(STAKING_SOL)]);
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
/**
 * **契约的每一个"状态改变入口"要么在网页上能操作，要么在一张带理由的例外表里显式声明**。
 *
 * 产品口径（2026-10-14 明确）：写入口存在的意义是**让用户/运营更方便地达成某个目的**；
 * 没有这种意义的写入口**不要求**有界面。所以这条守卫不是"一律必须有按钮"，而是要求
 * **这件事被显式决定过**——"漏给界面出口"与"决定不给界面"在代码上必须长得不一样：
 *   · 已登记 = 出现在 `frontend/src/pages/authority/actions.ts`（它既是行为动作表、又是
 *     「全操作索引」的真值，`where` 字段写明在哪一页/在哪一步）；
 *   · 例外 = 写进下面的 `EXEMPT`，**每条必须带理由**，且理由不许被写成空话（断言里同时检查
 *     例外名仍然真实存在，防止表烂掉）。
 * 判据来源：`contracts/src/*.sol` 里 external/public 且非 view/pure 的函数名
 * （加上 Ownable2Step 继承来的 `transferOwnership` / `acceptOwnership`）。
 * **只读接口不受此约束**：其中相当一部分是合约之间互相调用的
 * （`IEscrowMinimal.arbiter/getOrder/sellerOpenExposure/sellerNetAtSettle/totalOpenExposure/
 * afterSaleOpen`、`IStakingPool.poolOf`），本来就不需要界面出口。
 */
const EXEMPT = [
  // { name: 'someWriteEntry', reason: '为什么它没有界面也不影响任何人达成目的（一句话说清）' },
];
const writeEntriesOf = (sol) =>
  [
    ...new Set(
      [...sol.matchAll(/\bfunction\s+(\w+)\s*\([^)]*\)([^;{]*)[;{]/g)]
        .filter((m) => /\b(external|public)\b/.test(m[2]) && !/\b(view|pure)\b/.test(m[2]))
        .map((m) => m[1])
    ),
  ].sort();

guard('每个状态改变入口都有出口或在例外表里带理由声明（漏给界面 ⇒ 红）', () => {
  const ACTIONS = read('frontend/src/pages/authority/actions.ts');
  assert.ok(ACTIONS.length > 1000, 'frontend/src/pages/authority/actions.ts 读不到或结构变了');
  const registered = new Set([...ACTIONS.matchAll(/fn:\s*'(\w+)'/g)].map((m) => m[1]));
  /*
    三个 Ownable2Step 合约各有**两个从库继承来的**写入口（源码里没有重新声明，所以上面那段
    正则抽不到）：`transferOwnership`（两步转让第一步）与 `acceptOwnership`（接收）。
    写成常量而不是"去读 lib/openzeppelin-contracts"：库的路径随包管理器/子模块布局变，
    而这两个名字是**本仓契约的一部分**（文档与链上权限台都按它写）。ReviewNotary 没有 Ownable，
    故不补。`renounceOwnership` 三个合约都在源码里 override 了（禁用），上面已经抽到。
  */
  const INHERITED_WRITES = ['transferOwnership', 'acceptOwnership'];
  const entries = [
    ...writeEntriesOf(ESCROW_SOL).flatMap((n) => [`Escrow.${n}`]),
    ...writeEntriesOf(STAKING_SOL).flatMap((n) => [`Staking.${n}`]),
    ...writeEntriesOf(REGISTRY_SOL).flatMap((n) => [`MarketplaceRegistry.${n}`]),
    ...writeEntriesOf(NOTARY_SOL).map((n) => `ReviewNotary.${n}`),
    ...['Escrow', 'Staking', 'MarketplaceRegistry'].flatMap((c) => INHERITED_WRITES.map((n) => `${c}.${n}`)),
  ];
  /*
    下限（不是精确值）：它守的是"正则或文件结构变了，于是抽不出入口"这一类静默失效——
    精确值会让每一次合法的入口增删都要改这里，反而训练人去调数字。
    2026-10-14 由 55 下调到 54：Staking 的 `proposeEscrow` / `cancelEscrowChange` / `applyEscrow`
    三个写入口**被整条删除**（事实源改为 immutable 双锚定，理由见 contracts/src/Staking.sol），
    54 = 55 − 3 + 2（新增 `unfreeze` 的守卫不产生新入口；这 2 是本次同批新增的
    `NotFrozen`/`EscrowCodeHashMismatch` **错误**，不计入写入口——故此值按实测写死）。
    下调数字本身不构成"把断言改软"：下面两条**集合级**判据（例外表不许有不存在项、
    每个入口必须已登记或有理由）一字未动，它们才是这条守卫的实质。
  */
  assert.ok(
    entries.length >= 54,
    `只从 4 个合约里抽出 ${entries.length} 个状态改变入口（样例：${entries.slice(0, 4).join(', ')}）——正则或文件结构变了，先修守卫`
  );
  // 例外表的两条纪律：① 每条必须有**能读懂的理由**（不是占位符）；② 名字必须在上面真实存在，
  // 否则例外就成了"永远为真"的空条款（与"旧路径同批删净"同一条纪律）。
  const badReason = EXEMPT.filter((e) => typeof e.reason !== 'string' || e.reason.trim().length < 8);
  assert.deepEqual(badReason.map((e) => e.name), [], `例外必须写清理由（${EXEMPT.length} 条例外里有的理由是空的）`);
  const allNames = new Set(entries.map((e) => e.split('.')[1]));
  const stale = EXEMPT.filter((e) => !allNames.has(e.name)).map((e) => e.name);
  assert.deepEqual(stale, [], `例外表里有已经不存在的入口（旧例外要同批删掉）：${stale.join(', ')}`);

  const exempt = new Set(EXEMPT.map((e) => e.name));
  const missing = entries.filter((e) => {
    const n = e.split('.')[1];
    return !registered.has(n) && !exempt.has(n);
  });
  assert.deepEqual(
    missing,
    [],
    `这些状态改变入口既没有网页出口、也没在守卫的例外表里声明（要么给它一个有意义的入口，` +
      `要么在 node/test/abi-consistency.test.js 的 EXEMPT 里写清"为什么不需要"）：${missing.join(', ')}`
  );
});

/**
 * **反向：手写 ABI 里声明的每一个函数都还必须真的存在**（2026-10-14 补）。
 *
 * 为什么需要它：上一条守卫只管"合约有、网页没有"这一个方向，而**反方向**的残留是静默的——
 * 合约删掉一个入口（本仓刚删过 `proposeEscrow` / `cancelEscrowChange` / `applyEscrow` 与两个
 * `pendingEscrow*` 读法），前端 ABI 里那几行字符串却还留着：合约能跑、测试全绿、
 * 类型检查也过（ABI 是 `string[]`，写错名字没人管），只有真去调它才会 `unknown function`。
 * 与既有的"反向：前端 ABI 里的自定义错误都还在合约里"（错误那一半）成对：
 * **错误靠它守，函数靠这一条守**。
 *
 * 判据：声明处里出现的 `'function <name>('` 必须落在"四个合约的函数名并集 ∪ Ownable2Step 继承名"
 * 之内。声明处是白名单（下面 `ABI_SITES`）而不是全仓扫描——`shopCode.js`/`stakingRisk.js`
 * 这类文件里也有 `'function ...'` 片段，但它们不是合约 ABI 的声明处，混进来会把守卫变成噪声源。
 */
const ABI_SITES = [
  'frontend/src/chain.ts',
  'frontend/src/utils/contractAuthority.ts',
  'frontend/src/utils/notary.ts',
  'node/src/chain.js',
];
/** Ownable2Step/Ownable 提供的名字：本仓合约的 ABI 里有，但源码里查不到声明（继承来的） */
const INHERITED_ABI_NAMES = [
  'owner',
  'pendingOwner',
  'transferOwnership',
  'acceptOwnership',
  'renounceOwnership',
  // 收到原生转账的钩子（本仓四个合约都没有；留着是为了让"新增 receive"只报一次、报在正确的地方）
  'receive',
  'fallback',
];

guard('反向：前端/节点 ABI 里声明的函数都还在合约里（删了入口忘删声明 ⇒ 红）', () => {
  /** 某个 .sol 里所有 external/public 的函数名（含 view/pure；写法与 writeEntriesOf 同源） */
  const allEntriesOf = (sol) =>
    [
      ...new Set(
        [...sol.matchAll(/\bfunction\s+(\w+)\s*\([^)]*\)([^;{]*)[;{]/g)]
          .filter((m) => /\b(external|public)\b/.test(m[2]))
          .map((m) => m[1])
      ),
    ];
  /**
   * **public 状态变量的自动 getter**——它们同样是 ABI 里的函数，但源码里没有 `function` 关键字
   * （`arbiter` / `feeBps` / `nodes` / `notarizedCount` / `MIN_UNLOCK_DELAY` …）。
   * 漏掉这一半会把"合法声明"误判成残留（实测第一版就漏了 30 个），所以必须一起抽：
   * 形状是 `<类型> public [immutable|constant] <名字> [= 初值] ;`，类型里可能含 `mapping(...)`。
   */
  const publicGettersOf = (sol) =>
    [
      ...new Set(
        [...sol.matchAll(/[\w\[\]().,=>\s]+?\bpublic\s+(?:immutable\s+|constant\s+)?(\w+)\s*(?:=|;)/g)].map(
          (m) => m[1]
        )
      ),
    ];
  const known = new Set([
    ...allEntriesOf(ESCROW_SOL),
    ...allEntriesOf(STAKING_SOL),
    ...allEntriesOf(REGISTRY_SOL),
    ...allEntriesOf(NOTARY_SOL),
    ...publicGettersOf(ESCROW_SOL),
    ...publicGettersOf(STAKING_SOL),
    ...publicGettersOf(REGISTRY_SOL),
    ...publicGettersOf(NOTARY_SOL),
    ...INHERITED_ABI_NAMES,
  ]);
  // 与 `contracts/out/*.json` 实测对齐（2026-10-14）：四个合约的 ABI 函数名**并集 = 125**
  // （Escrow 55 / Staking 54 / Registry 28 / Notary 5，互相重叠的部分去重后 125）；
  // 本条抽取含 Ownable 继承名与两个钩子名 ⇒ 127（实测 ⊇ 125，差集为空）。
  // 阈值取 120 留一点余量：它只用来抓"正则或文件结构被改坏"，不是精确断言。
  assert.ok(
    known.size >= 120,
    `四个合约只抽出 ${known.size} 个函数名（函数 + public getter + 继承；实测应为 127）——正则或文件结构变了，先修守卫`
  );

  const stale = [];
  for (const rel of ABI_SITES) {
    const text = read(rel);
    assert.ok(text.length > 0, `ABI 声明处读不到：${rel}`);
    for (const m of text.matchAll(/'function\s+(\w+)\s*\(/g)) {
      if (!known.has(m[1])) stale.push(`${rel} → ${m[1]}`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `这些 ABI 声明在合约里已经不存在（删入口时必须同批删声明）：${stale.join(', ')}`
  );
});

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
