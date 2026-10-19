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
 * **模块加载期唯一的前置判据：这棵树里有没有可比对的对象。**
 *
 * 本守卫要同时读三棵树：`contracts/src`（真值）、`node/src`、`frontend/src`（消费端）。
 * 三者在完整仓库里同在，在公开节点仓里同缺——公开节点仓把 `node/**` 摊到仓库根，`ROOT` 指向它的
 * 上一级，所以 `contracts/src` 必然不存在。那种布局下"这棵树里跑不了"与"契约漂移"是两件事：
 * 整组用例用 `skip` 注册（`npm test` 不能变成 ENOENT）。
 *
 * 判据只此一处，**所有文件读取都只经过下面的 `loadSourceTree()`**。为什么不能在每个读取点
 * 各判一次（`existsSync ? read : ''`）：读取点有多少个就有多少个漏点，而模块顶层那一个漏点
 * 会把"跳过"变成"整份测试文件加载失败"——正是这次要删掉的形状。
 * 判据用**目录**而不是某个文件名：目录在、文件却改名了，那是真的要修守卫（读取会当场 ENOENT），
 * 不该被当成"这棵树里没有可比对的对象"而静默跳过。
 */
const FULL_TREE = ['contracts/src', 'node/src', 'frontend/src'].every((d) =>
  fs.existsSync(path.join(ROOT, d))
);
const guard = FULL_TREE ? test : test.skip;

/** 抽某个 .sol 里声明的全部 `error Name(...)` 名（去重、排序） */
const errorsOf = (sol) =>
  [...new Set([...sol.matchAll(/^\s*error\s+(\w+)\s*\(/gm)].map((m) => m[1]))].sort();

/** 抽某份 ABI 文本里声明的 `error Name(...)` 名（去重、排序） */
const abiErrorsOf = (text) => [...new Set([...text.matchAll(/error\s+(\w+)\s*\(/g)].map((m) => m[1]))].sort();

/**
 * 把守卫要读的东西**一次读齐**（整份文件唯一的模块顶层 I/O）。
 *
 * **合约集从 `contracts/src/*.sol` 派生**（2026-10-15 重构）：这条守卫守的是"合约声明了
 * 什么、消费端就得认什么"，而**新增一个合约**恰恰是最需要它生效的时刻——写死之后，新合约
 * 的函数与错误不在白名单里，于是同一个文件里同时出现两类假报告：前端的合法声明被判成
 * "死声明"、合约的真实错误被判成"前端漏声明"（本仓刚加 `Blocklist.sol` 时两条都撞上了）。
 * 判据的形状必须是"**有哪些合约**由目录回答"，而不是由一行常量回答。
 *
 * `contracts/*.sol` 现在一个文件一个合约（`ShopCode.sol` 是 library，没有 error、只有
 * internal 成员，进集合无副作用）。将来一个文件放多个合约时，这里的"文件名 = 合约名"
 * 假设会失效——那时按下面自检用例的报错改这一处即可。
 */
function loadSourceTree() {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const contractNames = fs
    .readdirSync(path.join(ROOT, 'contracts/src'))
    .filter((f) => f.endsWith('.sol'))
    .map((f) => f.replace(/\.sol$/, ''))
    .sort();
  const sol = Object.fromEntries(contractNames.map((n) => [n, read(`contracts/src/${n}.sol`)]));
  return {
    read,
    contractNames,
    sol,
    /** 全集合的 error 名并集（"反向：死声明"那一类判据共用） */
    allErrors: new Set(contractNames.flatMap((n) => errorsOf(sol[n]))),
    nodeChain: read('node/src/chain.js'),
    feChain: read('frontend/src/chain.ts'),
    registerScript: read('node/scripts/register-node.mjs'),
  };
}
/**
 * 树不在时是 `null`：任何漏了 `guard` 的访问都会在这里**当场 TypeError**
 * （而不是读到空串、再对着一句"契约漂移"的断言发呆）。
 */
const SOURCE = FULL_TREE ? loadSourceTree() : null;

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

/** 守卫自己的前置：合约集必须是从目录派生出来的、看得出形状的那一组（不是空集/半个目录） */
guard('守卫自检：合约集由 contracts/src 派生（不是写死的一张名单）', () => {
  assert.ok(
    SOURCE.contractNames.length >= 5 &&
      SOURCE.contractNames.includes('Escrow') &&
      SOURCE.contractNames.includes('Blocklist'),
    `contracts/src 里只认出 ${SOURCE.contractNames.length} 个合约（${SOURCE.contractNames.join(', ')}）——目录结构变了，先修守卫`
  );
});

/**
 * **前端必须声明合约的每一个自定义错误**——它是唯一会把 revert 展示给用户的一端
 * （ethers v6 只有 ABI 里声明过的 error 才解得出来，否则只剩 `unknown custom error`）。
 * 一条用例覆盖全部合约：漏声明的报错里带着"哪个合约的哪个错误"，而把每个合约拆成一条
 * 只会让同一份 `chain.ts` 被反复解析 N 次。
 */
guard('前端 ABI 声明了每一个合约的每一个自定义错误', () => {
  const known = new Set(abiErrorsOf(SOURCE.feChain));
  const missing = SOURCE.contractNames.flatMap((n) =>
    errorsOf(SOURCE.sol[n])
      .filter((e) => !known.has(e))
      .map((e) => `${n}.${e}`)
  );
  assert.deepEqual(
    missing,
    [],
    `frontend/src/chain.ts 未声明这些自定义错误（用户只会看到 "unknown custom error"）：${missing.join(', ')}`
  );
});

/** 反向：合约里删掉的 error 不该在前端留下"永远不会命中"的死声明 */
guard('反向：前端 ABI 里的自定义错误都还在合约里（Ownable 等库错误除外）', () => {
  const declared = SOURCE.allErrors;
  const libraryErrors = new Set([
    'OwnableUnauthorizedAccount',
    'OwnableInvalidOwner',
    'ReentrancyGuardReentrantCall',
  ]);
  const stale = abiErrorsOf(SOURCE.feChain).filter((e) => !declared.has(e) && !libraryErrors.has(e));
  assert.deepEqual(stale, [], `前端 ABI 里这些自定义错误在合约里已不存在（死声明）：${stale.join(', ')}`);
});
/**
 * `Staking.IEscrowMinimal.Order` 必须与 `Escrow.Order` **逐字段同名同序**：
 * 跨合约静态调用按位置解码，字段错位不报错、只读到错的字。
 */
guard('Staking.IEscrowMinimal.Order 与 Escrow.Order 字段顺序一致', () => {
  const fields = structFields(SOURCE.sol.Escrow, 'Order');
  assert.ok(fields.length >= 10, `Escrow.Order 只解析出 ${fields.length} 个字段：${fields.join(',')}`);
  const minimal = structFields(SOURCE.sol.Staking, 'Order');
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
  const fields = structFields(SOURCE.sol.MarketplaceRegistry, 'NodeInfo');
  assert.ok(fields.includes('code'), `NodeInfo 应含 code 字段，实际：${fields.join(',')}`);
  // 前端把 tuple 抽成了常量（NODE_TUPLE），先把它取出来再比对
  const c = SOURCE.feChain.match(/const NODE_TUPLE\s*=\s*'([^']*)'/);
  assert.ok(c, 'frontend/src/chain.ts 里找不到 NODE_TUPLE 常量');
  for (const f of fields) {
    assert.ok(
      new RegExp(`\\b${f}\\b`).test(c[1]),
      `前端 NODE_TUPLE 少了 NodeInfo 字段 ${f}（末尾字段缺失不会报错，只会恒为 undefined）`
    );
  }
});

guard('NodeInfo 的字段全部出现在登记脚本的 tuple 声明里', () => {
  const fields = structFields(SOURCE.sol.MarketplaceRegistry, 'NodeInfo');
  const tuple = tupleFieldsOf(SOURCE.registerScript, 'getActiveNodes');
  for (const f of fields) {
    assert.ok(new RegExp(`\\b${f}\\b`).test(tuple), `登记脚本的 tuple 少了字段 ${f}（当前声明：${tuple}）`);
  }
});

/** 与 `structFields` 同源，但**带上类型**（`['address host', …]`）：类型错了名字是对的，只有比类型才看得见 */
function structTypedFields(sol, structName) {
  const m = sol.match(new RegExp(`struct ${structName} \\{([\\s\\S]*?)\\n {4}\\}`));
  assert.ok(m, `没能从源码里切出 struct ${structName}`);
  return m[1]
    .split('\n')
    /*
      先 trim 再剥注释（顺序要紧）：源码是 CRLF，行尾还留着 `\r`，而 `.` 不匹配 `\r`
      ⇒ `//.*$` 匹配不上，注释整段留在行里，后面的"以 `;` 结尾"形状判据就把该字段丢掉
      （实测症状：PendingTerms 只解析出 2 个字段，报出来像是合约少写了两个）。
    */
    .map((l) => l.trim().replace(/\/\/.*$/, '').trim())
    .filter((l) => l && !l.startsWith('/*') && !l.startsWith('*'))
    .map((l) => l.match(/^(.+?)\s+(\w+)\s*;$/))
    .filter(Boolean)
    .map((mm) => `${mm[1].trim().replace(/\s+/g, ' ')} ${mm[2]}`);
}

/** 把 `'(address a, uint16 b)'` 这样的元组文本切成 `['address a', 'uint16 b']` */
const splitTuple = (s) =>
  s
    .split(',')
    .map((x) => x.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

/**
 * **`ShopInfo` / `PendingTerms` 的字段与类型必须与节点 `REGISTRY_ABI` 的元组逐字段一致**（2026-10-15 补）。
 *
 * 为什么必须比**类型**而不只是比名字（它守的是一次真实故障）：`ShopInfo.code` 在合约里是
 * `bytes32`（`_mintShopCode` 的返回值，只有事件里才 `_codeString` 成 9 位字符串），而节点把它
 * 声明成了 `string`。字段名一个不差，只是类型错——后果不是报错，而是**整族读法静默失效**：
 *   · `getShopBySeller` 每次抛 `could not decode result data`；
 *   · `termsReconciler` 对单店读失败的处理是"本轮跳过"（读不到 ≠ 已暂停，见该模块）⇒
 *     **链上佣金条款与在售状态的镜像从来没有同步过一次**，而 `lastOkAt` 照常刷新、读数看起来正常；
 *   · 于是节点主在链上 `suspendShop` 之后，节点的下单闸（读本地 `shops.listed`）照旧放行。
 * 名字守卫抓不到它，所以这里逐字段比"类型 + 名字"。
 */
guard('ShopInfo 的字段与类型与节点 REGISTRY_ABI 的元组一致', () => {
  const typed = structTypedFields(SOURCE.sol.MarketplaceRegistry, 'ShopInfo');
  assert.ok(typed.includes('bytes32 code'), `ShopInfo.code 应为 bytes32（合约里是 _mintShopCode 的返回值），实际：${typed.join(', ')}`);
  const m = SOURCE.nodeChain.match(/const SHOP_TUPLE =\s*\n?\s*'\(([^)]*)\)'/);
  assert.ok(m, '没能从 node/src/chain.js 里切出 SHOP_TUPLE 常量');
  assert.deepEqual(
    splitTuple(m[1]),
    typed,
    'node/src/chain.js 的 SHOP_TUPLE 必须与 MarketplaceRegistry.ShopInfo 逐字段同型同序（错型 ⇒ 解码抛错、整族链上对账静默失效）'
  );
});

guard('Registry 读店铺的入参形状是 bytes32（不是 string）', () => {
  const m = SOURCE.nodeChain.match(/function getShopByCode\(([^)]*)\)/);
  assert.ok(m, 'node/src/chain.js 里找不到 getShopByCode 的声明');
  assert.ok(
    /^\s*bytes32\s+\w+\s*$/.test(m[1]),
    `getShopByCode 的入参必须是 bytes32（合约形状），当前声明：${m[1].trim()}`
  );
});

/**
 * **"哪一家店"必须靠 `(店主, 节点)` 或编号回答**（2026-10-16 补，店铺身份改造的配套守卫）。
 *
 * 店铺的身份是 `(seller, host)` 这一对：一个店主钱包可以在多个节点下各开一家店。于是
 * "只给店主地址"的两种声明都**不再有唯一答案**——`getShopBySeller(address)` 不知道问的是哪一家，
 * `shopListed(address)` 更危险：它会把"这个钱包在**某个**节点下的店"当成"这个钱包的店"，
 * 而 `termsReconciler` 正是拿它写本地 `listed`。声明成不存在的形状，ethers 不会报"函数不对"，
 * 只会在链上 revert 或解出垃圾，而"读不到"在这条链路上等于**静默跳过**。
 *
 * 所以这里把三条形状钉死：`shopListed` 收编号、`getShop` 收两个人、旧的单参形式**不许存在**。
 */
guard('Registry 店铺读法的形状与"店 = 店主 × 节点"一致（旧的单参形式不得残留）', () => {
  const listed = SOURCE.nodeChain.match(/function shopListed\(([^)]*)\)/);
  assert.ok(listed, 'node/src/chain.js 里找不到 shopListed 的声明');
  assert.ok(/^\s*bytes32\s+\w+\s*$/.test(listed[1]), `shopListed 的入参必须是编号（bytes32），当前：${listed[1].trim()}`);

  const getShop = SOURCE.nodeChain.match(/function getShop\(([^)]*)\)/);
  assert.ok(getShop, 'node/src/chain.js 里找不到 getShop 的声明');
  const args = splitTuple(getShop[1]);
  assert.deepEqual(args, ['address seller', 'address host'], `getShop 必须是 (seller, host) 两个地址，当前：${getShop[1].trim()}`);

  // 反向：按地址单参读店/取编号的旧形状必须删净（留着就会在运行时静默失败）。
  // 判据落在**声明**上（`function X(`），不是"文件里出现过这个词"——注释里说明历史时应当允许提到它。
  for (const dead of ['getShopBySeller', 'shopCodeOfSeller']) {
    assert.ok(
      !new RegExp(`function\\s+${dead}\\s*\\(`).test(SOURCE.nodeChain),
      `node/src/chain.js 里不该再声明 ${dead}（店由 (店主, 节点) 或编号定位）`
    );
  }
});

/**
 * **watcher 必须能解析它要扫的每一个事件**：`escrowWatcher` 用
 * `escrow.queryFilter(escrow.filters[name]())` 拉日志——ABI 里没声明的事件名会让
 * `filters[name]` 直接是 undefined，抛在轮询里，该事件**永远扫不到**且不会有人发现。
 * 判据取 watcher 自己的 `EVENTS` 清单（清单本身漏挂会先被它自己的用例拦下）。
 */
/**
 * **`createOrder` 的五个参数必须在四个消费端逐字一致**（2026-10-15 补）。
 *
 * 为什么单挑这一个函数：它是全系统唯一"买家自己构造、把**分账条款**带进链上"的入口，
 * 而 2026-10 的多店改造给它加了第 5 个参数（`ShopTerms`）。合约、节点 ABI、dev 脚本同批改了，
 * **前端那一份漏了**——后果不是"少扣一笔抽成"，而是**浏览器根本发不出托管交易**：
 * 4 参签名算出的选择器在合约里不存在，调用落空直接 revert，买家看到一句解不出名字的错误。
 * 而演示栈走的是 dev 脚本自己的 ABI，所以这条断裂在整条链路上**没有任何可观察对象**。
 *
 * 判据取"参数类型序列"而不是整行文本：名字可以不一样（`orderId` vs `id`），
 * 但类型序列错一位就是**选择器变了**（调用根本到不了那个函数）。
 */
function paramTypesOf(sig) {
  // `tuple(address a, uint16 b) t` → `tuple(address,uint16)`；其余取类型词
  const types = [];
  let depth = 0;
  let cur = '';
  for (const ch of sig) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      types.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) types.push(cur);
  return types
    .map((raw) =>
      raw
        .trim()
        .replace(/^tuple\s*\(([\s\S]*)\)\s*[\w[\]]*$/i, (_m, inner) => `tuple(${paramTypesOf(inner).join(',')})`)
        .replace(/\s+(memory|calldata|storage)\b/g, '')
        .split(/\s+/)[0]
        .toLowerCase()
    )
    .filter(Boolean);
}
/** 从一段含 `createOrder(...)` 的源码里取出它的参数类型序列（第一个匹配即可） */
function createOrderTypes(text, label) {
  const m = text.match(/createOrder\s*\(([\s\S]*?)\)\s*(?:payable|external|view|;|')/);
  assert.ok(m, `${label} 里找不到 createOrder 的声明`);
  return paramTypesOf(m[1]);
}

guard('createOrder 的参数序列在合约/节点/前端/dev 脚本四处一致（漏一个 ⇒ 选择器不存在）', () => {
  const sol = SOURCE.sol.Escrow.match(/function createOrder\(([\s\S]*?)\)\s*external\s*payable/) || [];
  assert.ok(sol[1], '没能从 Escrow.sol 里切出 createOrder 的签名');
  /*
    合约侧写的是**具名结构体** `ShopTerms calldata terms`，而各端 ABI 里是内联元组
    `tuple(address commissionTo, uint16 commissionBps)`——两者在选择器上等价，所以先把
    结构体按它的字段类型展开，再与四端逐字比对（顺带把结构体字段类型也钉住）。
  */
  const tupleOfStruct = (structName) =>
    `tuple(${structTypedFields(SOURCE.sol.Escrow, structName)
      .map((f) => f.split(/\s+/)[0].toLowerCase())
      .join(',')})`;
  const want = paramTypesOf(sol[1]).map((t) => (t === 'shopterms' ? tupleOfStruct('ShopTerms') : t));
  assert.deepEqual(want, ['bytes32', 'address', 'uint256', 'uint64', 'tuple(address,uint16)'], `合约侧参数序列变了：${want.join(',')}`);
  for (const [label, text] of [
    ['node/src/chain.js', SOURCE.nodeChain],
    ['frontend/src/chain.ts', SOURCE.feChain],
    ['scripts/dev/dev-orders.mjs', SOURCE.read('scripts/dev/dev-orders.mjs')],
    ['scripts/dev/dev-scenarios.mjs', SOURCE.read('scripts/dev/dev-scenarios.mjs')],
  ]) {
    assert.deepEqual(
      createOrderTypes(text, label),
      want,
      `${label} 的 createOrder 参数序列与 Escrow.sol 不一致（少一个参数 ⇒ 前端算出的选择器在合约里不存在，交易必然 revert）`
    );
  }
});

/**
 * **店铺读法的形状要在合约 / 节点 / 前端 / 场景矩阵四处一致**（2026-10-16 补）。
 *
 * 为什么单独立一条（它守的是同一类错误在本仓已经发生过两次）：`ShopInfo.code` 是 `bytes32`，
 * 而"编号"在别处是 9 位字符串——声明成 `string` 时**连选择器都不一样**，每次调用都打到不存在的
 * 函数上直接 revert（节点 2026-10-15 栽过一次，前端 2026-10-16 才发现自己那一半从来没修）。
 * 另外"店的身份 = `(店主, 节点)`"之后，只给地址的单参读法**不再有唯一答案**：
 * 留着它不会报错，只会在运行时读成"别家节点下的另一家店"。
 * 所以这里把三件事一次钉住：`shopListed` 收编号、`getShop` 收两个人、旧单参形式不得残留。
 */
guard('店铺读法的形状在合约/节点/前端/矩阵四处一致（bytes32 编号 + 双键 + 无旧单参）', () => {
  const sol = SOURCE.sol.MarketplaceRegistry;
  assert.match(sol, /function shopListed\(bytes32\s+\w+\)/, '合约的 shopListed 必须收编号（bytes32）');
  assert.match(sol, /function getShop\(address\s+\w+,\s*address\s+\w+\)/, '合约的 getShop 必须收 (seller, host)');
  assert.ok(!/function getShopBySeller\(/.test(sol), '合约里不该再有 getShopBySeller（店由 (店主, 节点) 或编号定位）');

  for (const [label, text] of [
    ['node/src/chain.js', SOURCE.nodeChain],
    ['frontend/src/chain.ts', SOURCE.feChain],
    ['scripts/dev/dev-scenarios.mjs', SOURCE.read('scripts/dev/dev-scenarios.mjs')],
    ['scripts/dev/dev-chain-seed.mjs', SOURCE.read('scripts/dev/dev-chain-seed.mjs')],
  ]) {
    assert.match(text, /shopListed\(\s*bytes32/, `${label} 的 shopListed 必须收编号（bytes32）`);
    assert.match(text, /getShop\(\s*(address|bytes32)?[^)]*address[^)]*,\s*(address|\w+)[^)]*\)|getShop\(address, address\)/, `${label} 的 getShop 必须收两个参数`);
    assert.ok(!/function\s+getShopBySeller\s*\(/.test(text), `${label} 里不该再声明 getShopBySeller`);
    assert.ok(!/function\s+shopCodeOfSeller\s*\(/.test(text), `${label} 里不该再声明 shopCodeOfSeller`);
  }
});

/**
 * **`order.commission` 的形状是 `{ to, bps }`**（2026-10-15 补）。
 *
 * 这一条守的是"DTO 的形状由**读它的那一端**决定"：`frontend/src/types.ts` 的
 * `Order.commission` 声明成 `{ to: string|null; bps: number }`，结算页/收据/订单详情/下单签名
 * 四处都按它读；而节点一度直接下发内部形状 `{ commissionTo, commissionBps }`
 * ⇒ 四处读到 `undefined` ⇒ 界面不显示抽成、**签名时带 0 抽成**，每一处日志都正常。
 */
guard('节点 DTO 的 order.commission 形状与前端类型一致（{ to, bps }）', () => {
  const fe = SOURCE.read('frontend/src/types.ts').match(/commission\?:\s*\{([^}]*)\}/);
  assert.ok(fe, 'frontend/src/types.ts 里找不到 `commission?: { … }` 的声明');
  const keys = [...fe[1].matchAll(/(\w+)\s*[:?]/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['to', 'bps'], `前端 Order.commission 的键变了：${keys.join(',')}`);
  const dto = SOURCE.read('node/src/routes/orders.js');
  assert.match(
    dto,
    /commission:\s*\(\(\)\s*=>\s*\{[\s\S]{0,600}?return\s*\{\s*to:/,
    'routes/orders.js 的 DTO 没有按 { to, bps } 下发 commission（内部形状 commissionTo/commissionBps 直接下发会让前端静默读成"不抽成"）'
  );
});

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
  const ACTIONS = SOURCE.read('frontend/src/pages/authority/actions.ts');
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
    ...SOURCE.contractNames.flatMap((c) => writeEntriesOf(SOURCE.sol[c]).map((n) => `${c}.${n}`)),
    // 继承来的两个写入口只属于有 Ownable 的合约（ReviewNotary 没有 Ownable）
    ...SOURCE.contractNames.filter((c) => /Ownable/.test(SOURCE.sol[c])).flatMap((c) =>
      INHERITED_WRITES.map((n) => `${c}.${n}`)
    ),
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

  /*
    ── 第二半：**"登记过"不等于"有出口"** ──────────────────────────────
    上面那条只检查"这个名字在不在 actions.ts 里"。于是有一个它挡不住的形状（2026-10 实际存在过）：
    某条入口在 `OPS_INDEX` 里登记着，而 `where` 写的是"当前无界面出口"——
    它**过得了守卫**，却正好是"能力在链上、按钮不在网页上"的那个缺口。
    `suspendShop` / `unsuspendShop` 就是这样躺了很久（见 `pages/nodes/ShopSuspendCard.tsx` 的说明）。
    判据因此补成：声明自己**没有出口**的行，必须用 `missing: true` 明说，且 `where` 里要出现
    「没有界面出口」这几个字（让读表的人和这条守卫看的是同一句话）。
    这样"漏给界面"与"决定不给界面"在数据上仍然长得不一样，而"没有出口"不再能伪装成一条普通登记。
  */
  const rows = [...ACTIONS.matchAll(/\{\s*contract:\s*'(\w+)',\s*fn:\s*'(\w+)'[^}]*where:\s*'([^']*)'([^}]*)\}/g)].map(
    (m) => ({ contract: m[1], fn: m[2], where: m[3], rest: m[4] })
  );
  assert.ok(rows.length >= 54, `从 actions.ts 只解析出 ${rows.length} 行索引（结构变了？）`);
  const noExitMarker = '没有界面出口';
  const badNoExit = rows.filter((r) => {
    // 「没有出口」的两种写法都要能被认出来：`missing: true` 或 where 里明写那句话
    const declaredMissing = /missing:\s*true/.test(r.rest);
    const saysNoExit = r.where.includes(noExitMarker);
    if (declaredMissing && !saysNoExit) return true; // 声明了没出口，却不写清在哪都找不到 ⇒ 读表的人会以为有
    if (saysNoExit && !declaredMissing) return true; // 写了没出口，却没打标 ⇒ 界面上的筛选漏掉它
    return false;
  });
  assert.deepEqual(
    badNoExit.map((r) => `${r.contract}.${r.fn}`),
    [],
    `这些行的"有没有界面出口"没被完整声明：声明没有出口必须同时 \`missing: true\` **且** ` +
      `where 里出现「${noExitMarker}」（否则「只看没有入口的」那个筛选看不见它）：` +
      badNoExit.map((r) => `${r.contract}.${r.fn}（where=${r.where}）`).join('；')
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
    ...SOURCE.contractNames.flatMap((c) => allEntriesOf(SOURCE.sol[c])),
    ...SOURCE.contractNames.flatMap((c) => publicGettersOf(SOURCE.sol[c])),
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
    const text = SOURCE.read(rel);
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
  const missing = EVENTS.filter((e) => !new RegExp(`event\\s+${e}\\s*\\(`).test(SOURCE.nodeChain));
  assert.deepEqual(
    missing,
    [],
    `node/src/chain.js 未声明 watcher 要扫的事件：${missing.join(', ')}（queryFilter 会拿到 undefined 过滤器）`
  );
});

/**
 * 开店票据摘要：节点与**合约 fixture**逐字相等（三端同构里的中间那一层）。
 *
 * 这是纯文本契约守不住的那一类：`shopTicketDigest` 在**三端**各有一份实现
 * （合约 `MarketplaceRegistry._shopTicketDigest`、节点 `shops.shopTicketDigest`、
 * 前端 `chain.shopTicketDigest`），三份必须产出**同一个 32 字节**。
 * 对不上的症状是链上 `BadSignature`（英文 revert）或节点回「签名者不是登录地址」
 * —— 两者都指不到"是某一端少算了一层哈希"。
 *
 * fixture 的 `inner` 与 `digest` 是**从合约算出来的**（`forge test` 打印；
 * 算式 = `keccak256(abi.encode(host, seller, bps, deadline, chainId, registry))`
 * `.toEthSignedMessageHash()`，见 `_shopTicketDigest`），不是从任何一份 JS 实现抄的。
 * 前端那一份此前**确实错了**（只算内层、把 EIP-191 前缀留给签名处补），
 * 同款 fixture 也钉在 `frontend/test/shopTicketDigest.test.ts`。
 *
 * ⚠️ 不能靠"读合约源码再比一遍文本"来守：字段顺序、类型宽度（uint16 vs uint256）与
 * EIP-191 前缀是**哈希进结果里的**，只有拿真值算一遍才拦得住。
 */
guard('开店票据摘要：节点实现与合约 fixture 逐字相等（含 EIP-191 那一层）', async () => {
  const HOST = '0x1111111111111111111111111111111111111111';
  const SELLER = '0x2222222222222222222222222222222222222222';
  const DEADLINE_SEC = 1_800_000_000;
  /** 内层哈希 = 钱包 `personal_sign` 的原文（合约不直接用它，但它是签名的对象） */
  const EXPECTED_INNER = '0xdb7f2a5eb71c1e344d490b4f93f8d70228ecc9584bf76a16c2e192cdccdaf0ce';
  /** 合约 `_shopTicketDigest` 的返回值（= 内层 + EIP-191）——`digest.recover` 要验的值 */
  const EXPECTED_DIGEST = '0xd96174c1fab980f0d6684fcade2171b72ed825a7973ef09ea99d800aea36dd3b';

  /*
    chainId 与 Registry 地址是**显式入参**（`shopTicketDigest` 是纯函数，理由见它的注释）——
    这正是把 fixture 喂进去的前提：若它在这里读 config（那在 import 时就固化了 env），
    改 env 也没用，这一条对拍就写不出来。
  */
  const { shopTicketDigest, recoverTicketSigner } = await import('../src/shops.js');
  const { digest, innerHash } = shopTicketDigest({
    host: HOST,
    seller: SELLER,
    commissionBps: 250,
    deadline: new Date(DEADLINE_SEC * 1000),
    chainId: 31337,
    registry: '0x000000000000000000000000000000000000dEaD',
  });
  assert.equal(innerHash, EXPECTED_INNER, '内层哈希与合约不一致（字段顺序 / 类型宽度 / 编码方式）');
  assert.equal(digest, EXPECTED_DIGEST, '摘要（两层）与合约不一致 —— EIP-191 那一层没算或算了两遍');

  /*
    ## 端到端：钱包做得到的那一步，链上与节点都必须认

    名词对齐（这一步最容易搞错，我在这一处连错过三次，所以把三种 API 的语义写在测试里）：
      · `vm.sign(key, X)` / `signingKey.sign(X)` = **对 X 本体裸签**，不再哈希；
      · 钱包的 `personal_sign(X)` = 对 `hashMessage(X)` 裸签（**总会**加 EIP-191 前缀）；
      · 合约 `digest.recover(sig)` = 对 `digest` 做**裸恢复**（前缀已在 digest 里）；
      · ethers 的 `verifyMessage(msg, sig)` **不是**上面那条：它把 msg 当**原文**，
        对 32 字节的 msg 会**再哈希一层** ⇒ 与链上要验的不是同一个值（这正是旧实现的缺陷）。

    ⇒ 签名要落在**内层**（`personal_sign(inner)`），验签要喂**两层**（`digest`）并且走裸恢复。
    三种组合里只有这一种成立；另两种分别对应"少包一层"与"多包一层"，都在下面反向断言里。
  */
  const { Wallet, hashMessage, getBytes, recoverAddress } = await import('ethers');
  const w = Wallet.createRandom();
  // 钱包的动作：personal_sign(inner) —— 注意签的是 inner，不是 digest
  const sig = w.signingKey.sign(hashMessage(getBytes(innerHash))).serialized;
  assert.equal(recoverTicketSigner(digest, sig), w.address.toLowerCase(), '节点验签必须恢复出那个钱包');
  // 链上的动作：digest.recover(sig) —— 与节点验签必须是同一条路径
  assert.equal(recoverAddress(digest, sig), w.address, '链上与节点必须恢复出同一个地址');
  // 反向 ①：把**内层**当摘要喂进去 = 多包一层前缀 ⇒ 恢复出别人（"摘要少算一层"的形状）
  assert.notEqual(recoverTicketSigner(innerHash, sig), w.address.toLowerCase(), '喂内层 = 多包一层，必然验不过');
  // 反向 ②：签**两层**那个值 = 多包一层 ⇒ 同样恢复出别人（"签名多算一层"的形状）
  const doublePrefixed = w.signingKey.sign(hashMessage(getBytes(digest))).serialized;
  assert.notEqual(recoverTicketSigner(digest, doublePrefixed), w.address.toLowerCase(), '签两层必然验不过');
});