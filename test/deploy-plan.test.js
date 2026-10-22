/**
 * `scripts/lib/deployPlan.cjs` 的回归测试（node:test；不联网、不广播）。
 *
 * 这一条防线对应源码评审 2026-09 的 P0-1：旧脚本在「已设 MK_ESCROW_ADDRESS」时**照样再部署
 * 一个 Escrow**（只要没加 --skip-escrow），于是链上出现两个实例、节点只认新的那个，
 * 旧实例里的在途托管单永久停在非终态（订单行不存合约地址，见 node/src/db.js）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

/** `node/` 目录（部署常量与 Foundry 产物的相对基准都从这里算） */
const NODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** `node/` 的上一级：完整仓库根。公开节点仓把 `node/**` 摊到仓库根，所以那里它指向仓库外面 */
const REPO_ROOT = path.resolve(NODE_DIR, '..');

const require = createRequire(import.meta.url);
/**
 * **模块加载期唯一的前置判据：整棵源码树在不在。**
 *
 * 本文件断言的是"**本批**合约 + 部署脚本 + 节点配置三者对齐"，而这三样只在完整仓库里同时成立：
 * 公开节点仓只发布 `node/**`（仓库根就是节点），`scripts/`、`contracts/`、`deploy/`、
 * `frontend/` 都不存在。那种布局下"这棵树里跑不了"与"部署面漂移"是两件事，
 * 所以整组用例用 `skip` 注册（`npm test` 不能变成 ENOENT）。
 *
 * 为什么是**一条**判据、覆盖整份文件，而不是"需要 scripts/ 的那组看 scripts/、跨仓那组看 deploy/"：
 * 那就是两套真相（本文件此前正是这么坏的——`deployPlan` 那组看一个文件、跨仓那组看另两个目录），
 * 而模块顶层还要读 `deploy.sh` / `deploy-constants.json`，它们不属于任何一组，少判一个就是
 * "跳过"退化成"加载即失败"。判据用**目录**：目录在、文件却改名了，那是真要修守卫（读取会当场
 * ENOENT），不该被当成"这棵树里没有"而静默跳过。
 *
 * 代价：公开节点仓里这份文件的 node 本地断言也一起跳过——它们断言的是"本批部署面与合约槽位对齐"，
 * 而公开节点仓里没有"这一批合约"可对齐，跳过是如实表态。
 */
const FULL_TREE =
  fs.existsSync(path.join(REPO_ROOT, 'scripts', 'lib', 'deployPlan.cjs')) &&
  fs.existsSync(path.join(REPO_ROOT, 'contracts', 'src')) &&
  fs.existsSync(path.join(REPO_ROOT, 'deploy')) &&
  fs.existsSync(path.join(REPO_ROOT, 'frontend', 'src'));
const guard = FULL_TREE ? test : test.skip;

/**
 * `scripts/lib/deployPlan.cjs` 属于**合约部署工具**（仓库根 `scripts/` 下）。
 * 树不在时是 `null`：用例已全部 skip，任何漏了判据的访问都会当场 TypeError；
 * 而 require 本身不再吞进 try/catch ——"这个文件在不在"只有一个答案，就是上面的判据。
 */
const deployPlan = FULL_TREE ? require('../../scripts/lib/deployPlan.cjs') : null;

const ADDR = '0xAbC0000000000000000000000000000000000001';

guard('给了地址但没给 --new-escrow ⇒ 拒绝执行（默认不再部署第二个 Escrow）', () => {
  const p = deployPlan.planEscrowDeploy({ envAddress: ADDR });
  assert.equal(p.action, 'error');
  assert.equal(p.address, null);
  // 报错信息必须能指导下一步：给出两条出路（复用 / 显式换新）
  assert.match(p.reason, /MK_ESCROW_ADDRESS 已设置/);
  assert.match(p.reason, /--skip-escrow/);
  assert.match(p.reason, /--new-escrow/);
});

guard('--skip-escrow + 地址 ⇒ 复用，不进入部署分支', () => {
  const p = deployPlan.planEscrowDeploy({ envAddress: ADDR, skipEscrow: true });
  assert.equal(p.action, 'reuse');
  assert.equal(p.address, ADDR);
});

guard('--skip-escrow 但没有地址 ⇒ 报错（而不是走到后面才炸）', () => {
  const p = deployPlan.planEscrowDeploy({ envAddress: '', skipEscrow: true });
  assert.equal(p.action, 'error');
  assert.match(p.reason, /需要同时设置 MK_ESCROW_ADDRESS/);
});

guard('--new-escrow 是唯一的换新实例方式（会提示处置旧实例）', () => {
  const p = deployPlan.planEscrowDeploy({ envAddress: ADDR, newEscrow: true });
  assert.equal(p.action, 'deploy');
  const warn = deployPlan.newEscrowWarning(ADDR);
  assert.match(warn, /正在部署\*\*新的\*\* Escrow 实例/);
  assert.match(warn, /重建节点库/);
});

guard('什么都没设 ⇒ 首次部署；空串/空白地址按"未设置"处理', () => {
  for (const envAddress of ['', '   ', undefined, null]) {
    const p = deployPlan.planEscrowDeploy({ envAddress });
    assert.equal(p.action, 'deploy', `envAddress=${String(envAddress)}`);
    assert.equal(p.address, null);
  }
});

guard('地址两侧空白被裁剪（env 里常见的手抄空格不该改变判定）', () => {
  const p = deployPlan.planEscrowDeploy({ envAddress: `  ${ADDR}  `, skipEscrow: true });
  assert.equal(p.action, 'reuse');
  assert.equal(p.address, ADDR);
});

/**
 * `planStakingGas` —— 2026-09 真机踩到的那条：**全新部署时脚本必然 FATAL**。
 *
 * `Staking` 构造函数有 `if (escrow_.code.length == 0) revert ZeroAddress()` 守卫，
 * 而旧实现拿占位地址（`0x1111…`）在广播之前估算 Staking 的 gas ⇒
 * `FATAL: eth_estimateGas: execution reverted`，四个合约一个都发不出去。
 * 这一组测试钉死"什么时候才允许估算"：**只有 escrow 地址确实有代码（复用既有实例）时**。
 */
guard('Staking gas：复用既有 Escrow 时才就地估算（地址必须是那个真实地址）', () => {
  const p = deployPlan.planStakingGas({ escrowAction: 'reuse', escrowAddress: ADDR });
  assert.equal(p.estimate, true);
  assert.equal(p.escrowAddress, ADDR);
  assert.match(p.note, /就地估算/);
});

guard('Staking gas：首次部署不估算（占位地址必然 revert，脚本会在广播前整条退出）', () => {
  const p = deployPlan.planStakingGas({ escrowAction: 'deploy', escrowAddress: '' });
  assert.equal(p.estimate, false);
  // 关键：绝不能给出一个"可用来估算"的地址——占位地址就是旧实现那个坑
  assert.equal(p.escrowAddress, null);
  assert.equal(p.gasLimit, deployPlan.STAKING_FALLBACK_GAS);
  assert.match(p.note, /占位地址估算必然 revert/);
});

guard('Staking gas：--new-escrow 时即便 env 里有旧地址也不拿它估算', () => {
  const p = deployPlan.planStakingGas({ escrowAction: 'deploy', escrowAddress: ADDR });
  assert.equal(p.estimate, false);
  assert.equal(p.escrowAddress, null);
});

guard('Staking gas：回退值可覆盖，非 bigint 输入也能归一', () => {
  assert.equal(deployPlan.planStakingGas({ escrowAction: 'deploy', fallbackGas: 9_000_000n }).gasLimit, 9_000_000n);
  assert.equal(deployPlan.planStakingGas({ escrowAction: 'deploy', fallbackGas: '9000000' }).gasLimit, 9_000_000n);
  /*
    默认回退值的判据是「**够**且**准**」，不是「够大」：
      · 够：主网真机实测 Staking 部署 gasUsed = 3_184_180；
      · 准：它同时被预检的余额门禁用来算预估费用（见 deployPlan 里 STAKING_FALLBACK_GAS 的长注释），
        虚高会在钱够的时候拒绝部署 —— 旧值 6_000_000 就把 0.1075 BTY 的余额判成了不够。
    所以下界钉「实测 × 110%」，上界钉「实测 × 2」，两头都是防回归。
  */
  const MEASURED_MAINNET_GAS = 3_184_180n;
  assert.ok(
    deployPlan.STAKING_FALLBACK_GAS >= (MEASURED_MAINNET_GAS * 110n) / 100n,
    `回退 gasLimit 覆盖不了实测用量：${deployPlan.STAKING_FALLBACK_GAS} < ${MEASURED_MAINNET_GAS} × 110%`
  );
  assert.ok(
    deployPlan.STAKING_FALLBACK_GAS <= MEASURED_MAINNET_GAS * 2n,
    `回退 gasLimit 虚高（预检余额门禁会误报）：${deployPlan.STAKING_FALLBACK_GAS} > 实测 ${MEASURED_MAINNET_GAS} × 2`
  );
});

/**
 * `resolveRejectGraceBlocks` —— 2026-10 加固 A 的构造参数预检。
 *
 * `Escrow` 构造函数对**低于下界**与**超上限**的值直接 `revert InvalidRejectGrace()`，而部署是
 * **真实交易**：本地预检拦掉，省一笔 gas。判据本身只有合约一处，这里与它**同批判同一个值域**——
 * 2026-10-14 起下界是 1 天（`Escrow.MIN_REJECT_GRACE_BLOCKS` = 17 280 块），不再是"非 0"：
 * 1 与 0 的客观效果相同（静置期的唯一目的是给买家一段插入争议的时间，而这段窗口里买家没有机会），
 * 旧口径（只拒 0）会让一条"看起来只是把窗口调到最小"的治理交易把加固 A 静默关掉。
 */
guard('静置期：未设置 ⇒ 默认 1 天（17 280 块），且不是错误', () => {
  for (const v of ['', '   ', undefined, null]) {
    const r = deployPlan.resolveRejectGraceBlocks(v);
    assert.equal(r.ok, true, `env=${String(v)}`);
    assert.equal(r.level, 'default');
    assert.equal(r.blocks, 17_280n);
    assert.match(r.reason, /≈1 天/);
  }
});

guard('静置期：低于下界一律拒绝（含 0 与 1——两者客观效果相同），下界本身放行', () => {
  const MIN = 17_280n;
  assert.equal(deployPlan.resolveRejectGraceBlocks(String(MIN)).ok, true, '下界本身必须是合法值');
  assert.match(deployPlan.resolveRejectGraceBlocks(String(MIN)).reason, /17280 块/);
  for (const v of ['0', ' 0 ', 0, '1', 1, '12', String(MIN - 1n)]) {
    const r = deployPlan.resolveRejectGraceBlocks(v);
    assert.equal(r.ok, false, `env=${String(v)}`);
    assert.equal(r.blocks, null);
    assert.match(r.reason, /低于合约下界/);
    assert.match(r.reason, /InvalidRejectGrace/);
  }
});

guard('静置期：超上限（10 天）⇒ 拒绝；上限值本身通过', () => {
  const over = deployPlan.resolveRejectGraceBlocks('172801');
  assert.equal(over.ok, false);
  assert.match(over.reason, /超过合约上限/);

  const atCap = deployPlan.resolveRejectGraceBlocks('172800');
  assert.equal(atCap.ok, true);
  assert.equal(atCap.blocks, 172_800n);
});

guard('静置期：非十进制整数 ⇒ 拒绝（含小数/负数/十六进制/带单位）', () => {
  for (const v of ['1.5', '-1', '0x10', '17280 blocks', 'abc']) {
    const r = deployPlan.resolveRejectGraceBlocks(v);
    assert.equal(r.ok, false, `env=${v}`);
    assert.match(r.reason, /必须是十进制整数/);
  }
});

guard('静置期：下界之上的合法值原样透传（含前导空白）', () => {
  const r = deployPlan.resolveRejectGraceBlocks(' 43200 ');
  assert.equal(r.ok, true);
  assert.equal(r.level, 'set');
  assert.equal(r.blocks, 43_200n);
  assert.match(r.reason, /43200 块/);
});

/**
 * `resolveMinTimeoutBlocks` / `resolveAfterSaleWindowBlocks` —— 2026-10 新增的两个构造参数预检
 * （`minTimeoutBlocks` / `afterSaleWindowBlocks`）。
 *
 * 与静置期同一类风险：两个值都决定资金出口条件。**2026-10-14 起两者的值域完全一致**——
 * 下界都是 1 天（`Escrow.MIN_ORDER_TIMEOUT_BLOCKS` / `MIN_AFTER_SALE_WINDOW_BLOCKS` = 17 280 块），
 * 上限各自是 30 天（518 400）与 360 天（6 220 800）。旧口径里 `MIN_TIMEOUT_BLOCKS` 的 **0 合法**
 * （"显式不设下限"，本地演示链用）已被推翻：`minTimeoutBlocks = 0` 的实际含义是"卖方节点可以把
 * `timeoutBlocks` 写成 1"，买家付款后约一个块就能被 `releaseExpired` 判给卖家；1 与 0 的客观效果
 * 相同，所以下界统一成"一段真人来得及动作的时间"。
 */
guard('最小超时窗口：未设置 ⇒ 默认 1 天（17 280 块）；低于下界一律拒绝（含 0 与 1）', () => {
  for (const v of ['', '   ', undefined, null]) {
    const r = deployPlan.resolveMinTimeoutBlocks(v);
    assert.equal(r.ok, true, `env=${String(v)}`);
    assert.equal(r.level, 'default');
    assert.equal(r.blocks, 17_280n);
    assert.match(r.reason, /≈1 天/);
  }
  const MIN = 17_280n;
  assert.equal(deployPlan.resolveMinTimeoutBlocks(String(MIN)).ok, true, '下界本身必须是合法值');
  // 0 不再是合法值：它等于"节点可以写 timeoutBlocks = 1"，而 1 与 0 客观效果相同
  for (const v of ['0', ' 0 ', 0, '1', 1, '12', String(MIN - 1n)]) {
    const r = deployPlan.resolveMinTimeoutBlocks(v);
    assert.equal(r.ok, false, `env=${String(v)}`);
    assert.equal(r.blocks, null);
    assert.match(r.reason, /低于合约下界/);
    assert.match(r.reason, /InvalidMinTimeout/);
  }
});

guard('最小超时窗口：上限（30 天 = MAX_TIMEOUT_BLOCKS）本身通过，超上限/非整数 ⇒ 拒绝', () => {
  const atCap = deployPlan.resolveMinTimeoutBlocks('518400');
  assert.equal(atCap.ok, true);
  assert.equal(atCap.blocks, 518_400n);

  const over = deployPlan.resolveMinTimeoutBlocks('518401');
  assert.equal(over.ok, false);
  assert.equal(over.blocks, null);
  assert.match(over.reason, /超过合约上限/);
  assert.match(over.reason, /InvalidMinTimeout/);

  for (const v of ['1.5', '-1', '0x10', '17280 blocks', 'abc']) {
    const r = deployPlan.resolveMinTimeoutBlocks(v);
    assert.equal(r.ok, false, `env=${v}`);
    assert.match(r.reason, /必须是十进制整数/);
  }
});

guard('售后窗口：未设置 ⇒ 默认 180 天；低于下界（含 0 与 1）一律拒绝——0 与 1 的效果相同', () => {
  for (const v of ['', '   ', undefined, null]) {
    const r = deployPlan.resolveAfterSaleWindowBlocks(v);
    assert.equal(r.ok, true, `env=${String(v)}`);
    assert.equal(r.level, 'default');
    assert.equal(r.blocks, 3_110_400n);
    assert.match(r.reason, /180 天/);
  }
  /*
    2026-10-14：下界是 **1 天**，不是"非 0"。旧判据只拒 0，而 `1`（乃至几块）在客观效果上与 0 相同——
    都要求买家在结算当块就开案 ⇒ 等于把唯一救济入口静默关闭，而"不接受 0"那条理由对它同样成立。
    所以这里逐个钉住下界之下的取值（含 1 与下界-1），以及下界本身必须放行。
  */
  const MIN = 17_280n;
  assert.equal(deployPlan.resolveAfterSaleWindowBlocks(String(MIN)).ok, true, '下界本身必须是合法值');
  assert.match(deployPlan.resolveAfterSaleWindowBlocks(String(MIN)).reason, /17280 块/);
  for (const v of ['0', ' 0 ', 0, '1', 1, '1440', String(MIN - 1n)]) {
    const r = deployPlan.resolveAfterSaleWindowBlocks(v);
    assert.equal(r.ok, false, `env=${String(v)}`);
    assert.equal(r.blocks, null);
    assert.match(r.reason, /静默关闭/);
    assert.match(r.reason, /InvalidAfterSaleWindow/);
  }
});

guard('售后窗口：上限（360 天 = 6 220 800 块）本身通过，超上限/非整数 ⇒ 拒绝', () => {
  const atCap = deployPlan.resolveAfterSaleWindowBlocks('6220800');
  assert.equal(atCap.ok, true, '上限本身必须是合法值');
  assert.equal(atCap.blocks, 6_220_800n);
  assert.match(atCap.reason, /6220800 块/);

  // 默认值（180 天 = 3 110 400）也必须是合法值：合约上限若被调小，默认值会先撞上限
  const atDefault = deployPlan.resolveAfterSaleWindowBlocks('3110400');
  assert.equal(atDefault.ok, true);
  assert.equal(atDefault.blocks, 3_110_400n);

  const over = deployPlan.resolveAfterSaleWindowBlocks('6220801');
  assert.equal(over.ok, false);
  assert.match(over.reason, /超过合约上限/);

  for (const v of ['1.5', '-1', '0x10', '518400 blocks', 'abc']) {
    const r = deployPlan.resolveAfterSaleWindowBlocks(v);
    assert.equal(r.ok, false, `env=${v}`);
    assert.match(r.reason, /必须是十进制整数/);
  }
});

/**
 * `deploy-constants.json` 的**在位一致性**：常量里说"接的是本批合约"，就必须能拿本地编译产物验。
 *
 * 为什么必须有这条（2026-10-16，一个真实发生过的静默失败）：那份文件里曾经长期钉着一代
 * **已作废**的 Escrow 地址与起始块，而仓库里**没有任何机器判据**能发现它过期——
 *   ① 地址是链上事实，单测碰不到；
 *   ② 于是它一路漂到"当前源码的节点接上去会被启动期代次自检直接拒绝"
 *      （实测：主网那一代缺 `commissionTermsAtCreate` / `commissionAtSettle` 两个读法，
 *      探针返回 `ok:false`），而部署常量本身看起来完全正常；
 *   ③ 症状是**部署出去的节点起不来**，而定位它要先想到"仓库里记的地址是不是上一代的"。
 *
 * 判据的形状刻意如此：**如实填了才检查，留空是合法状态**。
 *   · `escrow`/`registry`/`startBlock` 是**本批部署产物**（只有真部署才知道），
 *     所以仓库里留空 = "本批尚未部署"，这不是错误；
 *   · 但一旦填了地址，`escrowCodeHash` 就**必须**在，且必须等于本地编译产物的
 *     `keccak256(deployedBytecode)` —— 与 `Registry.CANONICAL_ESCROW_CODE_HASH` /
 *     `Staking.CANONICAL_ESCROW_CODE_HASH` 是**同一个值、同一条纪律**（地址 + 哈希互验）。
 *   于是"改了 **Escrow** 却没换批"这件事会在**本测试**里当场变红，而不是等部署上线后由节点
 *   自检发现。判据只覆盖 Escrow：Registry / Blocklist / Staking 的部署身份没有可离线复算的
 *   代码锚（Registry 的 immutable 地址在部署时被写进运行时字节码，拿编译产物算不出链上哈希），
 *   它们的换批靠当批部署提交回填 `contracts` 五项。
 *
 * `contracts/out/**` 是 Foundry 的构建产物（`forge build` 生成、不进 git）：
 * 不在时**跳过而不是失败**——判据是"有没有编译产物可比"，不是"必须编译过"。
 */
function loadTree() {
  const readText = (p) => fs.readFileSync(p, 'utf8');
  const escrowArtifact = path.join(REPO_ROOT, 'contracts', 'out', 'Escrow.sol', 'Escrow.json');
  return {
    readText,
    constants: JSON.parse(readText(path.join(NODE_DIR, 'deploy-constants.json'))),
    deploySh: readText(path.join(NODE_DIR, 'deploy.sh')),
    deployPs: readText(path.join(NODE_DIR, 'deploy.ps1')),
    nodeEnvExample: readText(path.join(NODE_DIR, '.env.example')),
    escrowArtifact,
    escrowArtifactExists: fs.existsSync(escrowArtifact),
  };
}
/**
 * 树在时**一次读齐**（整份文件唯一的模块顶层 I/O）；树不在时是 `null` ——
 * 用例已全部 skip，任何漏了判据的访问都会当场 TypeError。
 */
const TREE = FULL_TREE ? loadTree() : null;

/**
 * 部署面契约：`contracts` 的每个键 → 它必须出现的配置键。
 *
 * 这张表是**唯一**的槽位声明：`contracts` 多一个键而这里没写，下面的"键集一致"断言当场变红；
 * 写进来了，下面的断言就会逐个检查 `node/.env.example`、`deploy.sh`（含结构门禁与 MANAGED_KEYS）、
 * `deploy.ps1`、`deploy/node.env`、`deploy/deploy-node.ps1`、前端三处与 `frontend/src/config.ts`。
 *
 * 为什么把代价挂在**这一层**：2026-10 的 Blocklist 就是"代码里必需、但所有文档化配置路径上都没有槽位"
 * ——照文档发布出来的正式站上，Shop/Product/Address 三类屏蔽整体不生效，而且没有任何报错。
 * 只补一个键只能救这一批；下一批再加一个合约地址时，漏一条路径同样会静默 fail-open。
 * 所以判据不是"blocklist 补上了吗"，而是"新增合约地址时，不可能只补一半"。
 *
 * `shell` / `ps` 是两条部署脚本里的变量名（结构门禁与 `.env` 生成用）。
 * `escrowCodeHash` 没有槽位：节点的启动期代次自检不读它，它只用于仓库与本地编译产物对拍。
 */
const CONTRACT_SLOTS = {
  escrow: { node: 'MK_ESCROW_ADDRESS', frontend: 'VITE_ESCROW_ADDRESS', shell: 'ESCROW', ps: 'Escrow' },
  registry: { node: 'MK_REGISTRY_ADDRESS', frontend: 'VITE_REGISTRY_ADDRESS', shell: 'REGISTRY', ps: 'Registry' },
  blocklist: { node: 'MK_BLOCKLIST_ADDRESS', frontend: 'VITE_BLOCKLIST_ADDRESS', shell: 'BLOCKLIST', ps: 'Blocklist' },
  startBlock: { node: 'MK_ESCROW_START_BLOCK', shell: 'START_BLOCK', ps: 'StartBlock', numeric: true },
  escrowCodeHash: {},
};

/** `deploy/` 与 `frontend/` 的位置（树在时它们必然在，跨仓断言直接跑，不再有第二个判据） */
const REPO_DEPLOY_DIR = path.join(REPO_ROOT, 'deploy');
const REPO_FRONTEND_DIR = path.join(REPO_ROOT, 'frontend');

function managedKeysSh() {
  const m = /MANAGED_KEYS='([^']*)'/.exec(TREE.deploySh);
  assert.ok(m, 'deploy.sh 里找不到 MANAGED_KEYS（重跑时原样保留的键清单）');
  return m[1].split(/\s+/).filter(Boolean);
}
function managedKeysPs() {
  const start = TREE.deployPs.indexOf('$MANAGED = @(');
  assert.ok(start > 0, 'deploy.ps1 里找不到 $MANAGED（重跑时原样保留的键清单）');
  const end = TREE.deployPs.indexOf(')', start);
  return [...TREE.deployPs.slice(start, end).matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
}
/** deploy.sh 的构建期硬门禁那一段（从注释标题到 `MODE=install` 之前） */
function deployShGate() {
  const start = TREE.deploySh.indexOf('构建期硬门禁');
  assert.ok(start > 0, 'deploy.sh 里找不到构建期硬门禁');
  const end = TREE.deploySh.indexOf('\nMODE=install', start);
  assert.ok(end > start, 'deploy.sh 的结构门禁没有在 MODE 解析之前收口');
  return TREE.deploySh.slice(start, end);
}

guard('contracts 的键集 == 部署槽位表：新增合约地址而不声明落点会当场变红', () => {
  assert.deepEqual(
    Object.keys(TREE.constants.contracts).sort(),
    Object.keys(CONTRACT_SLOTS).sort(),
    'contracts 多了一个没有声明部署槽位的键（或槽位表里有已删掉的键）。' +
      '在 node/test/deploy-plan.test.js 的 CONTRACT_SLOTS 里写清它必须进哪条部署路径——' +
      '漏一条路径的后果是静默 fail-open，不是报错'
  );
  // 只有 escrowCodeHash 可以不注入 .env（节点的启动期代次自检不读它）。新增键写个空槽位就想蒙过去 = 红。
  assert.deepEqual(
    Object.entries(CONTRACT_SLOTS).filter(([, slot]) => !slot.node).map(([k]) => k),
    ['escrowCodeHash'],
    'contracts 里只有 escrowCodeHash 允许"不注入 .env"；其余每个键都必须在 CONTRACT_SLOTS 里声明 node 槽位'
  );
});

guard('每个合约键在节点部署面都有槽位：.env.example + deploy.sh + deploy.ps1（含 .env 与管理键清单）', () => {
  for (const [key, slot] of Object.entries(CONTRACT_SLOTS)) {
    if (!slot.node) continue;
    assert.match(TREE.nodeEnvExample, new RegExp(`^${slot.node}=`, 'm'), `node/.env.example 缺 ${slot.node}（模板是店主唯一能看到的配置清单）`);
    assert.ok(TREE.deploySh.includes(`"$(const ${key})"`), `deploy.sh 没有从 deploy-constants.json 读 contracts.${key}`);
    assert.match(TREE.deploySh, new RegExp(`^${slot.node}=\\$${slot.shell}$`, 'm'), `deploy.sh 没有把 ${slot.node} 写进生成的 .env`);
    assert.ok(TREE.deployPs.includes(`Get-Const 'contracts.${key}'`), `deploy.ps1 没有从 deploy-constants.json 读 contracts.${key}`);
    assert.ok(TREE.deployPs.includes(`"${slot.node}=$${slot.ps}"`), `deploy.ps1 没有把 ${slot.node} 写进生成的 .env`);
    // 重跑时"原样保留"的键清单：漏进去会让旧 .env 里的值被当成本机自配项再追加一遍（两套值并存）
    assert.ok(managedKeysSh().includes(slot.node), `deploy.sh 的 MANAGED_KEYS 缺 ${slot.node}`);
    assert.ok(managedKeysPs().includes(slot.node), `deploy.ps1 的 $MANAGED 缺 ${slot.node}`);
  }
});

guard('deploy.sh 的结构门禁覆盖每一个要注入的合约键：空值/坏形状必须当场拒绝执行', () => {
  const gate = deployShGate();
  for (const [key, slot] of Object.entries(CONTRACT_SLOTS)) {
    if (!slot.node) continue;
    const found = new RegExp(`printf '%s' "\\$${slot.shell}" \\| grep -Eq '([^']+)'`).exec(gate);
    assert.ok(found, `deploy.sh 的结构门禁没有校验 $${slot.shell}（${slot.node}）——"少配一个也能启动"正是它要挡的`);
    const pattern = new RegExp(found[1]);
    if (slot.numeric) {
      assert.ok(pattern.test('12345'), `起始块的门禁正则 ${pattern} 拒绝了合法值`);
      assert.ok(!pattern.test(''), `起始块的门禁正则 ${pattern} 必须拒绝空值`);
      assert.match(gate, new RegExp(`\\[ "\\$${slot.shell}" = '0' \\]`), '起始块还必须拒绝 0（0 = 从最新块开始 ⇒ 漏扫历史事件且不报错）');
    } else {
      assert.ok(pattern.test(`0x${'a'.repeat(40)}`), `门禁正则 ${pattern} 拒绝了合法地址`);
      assert.ok(!pattern.test(''), `门禁正则 ${pattern} 必须拒绝空值——留空等于"少配一个也能启动"`);
      assert.ok(!pattern.test('0x1234'), `门禁正则 ${pattern} 必须拒绝形状不对的地址`);
    }
  }
});

guard('代部署与前端构建也有槽位：deploy/node.env、deploy-node.ps1、前端三处 + config.ts', () => {
  const NODE_ENV_VALUES = TREE.readText(path.join(REPO_DEPLOY_DIR, 'node.env'));
  const DEPLOY_NODE_PS = TREE.readText(path.join(REPO_DEPLOY_DIR, 'deploy-node.ps1'));
  const FEDMALL_ENV = TREE.readText(path.join(REPO_DEPLOY_DIR, 'fedmall.env'));
  const DEPLOY_FEDMALL_PS = TREE.readText(path.join(REPO_DEPLOY_DIR, 'deploy-fedmall.ps1'));
  const FRONTEND_ENV_EXAMPLE = TREE.readText(path.join(REPO_FRONTEND_DIR, '.env.example'));
  const FRONTEND_CONFIG = TREE.readText(path.join(REPO_FRONTEND_DIR, 'src', 'config.ts'));

  for (const [key, slot] of Object.entries(CONTRACT_SLOTS)) {
    if (!slot.node) continue;
    assert.match(NODE_ENV_VALUES, new RegExp(`^${slot.node}=`, 'm'), `deploy/node.env 缺 ${slot.node}（代部署发布前要核对的本批真值）`);
    assert.ok(DEPLOY_NODE_PS.includes(slot.node), `deploy/deploy-node.ps1 没有读取/校验 ${slot.node}`);
  }
  for (const [key, slot] of Object.entries(CONTRACT_SLOTS)) {
    if (!slot.frontend) continue;
    assert.match(FRONTEND_ENV_EXAMPLE, new RegExp(`^${slot.frontend}=`, 'm'), `frontend/.env.example 缺 ${slot.frontend}`);
    assert.match(FEDMALL_ENV, new RegExp(`^${slot.frontend}=`, 'm'), `deploy/fedmall.env 缺 ${slot.frontend}`);
    assert.ok(DEPLOY_FEDMALL_PS.includes(slot.frontend), `deploy/deploy-fedmall.ps1 没有注入 ${slot.frontend}`);
    assert.ok(FRONTEND_CONFIG.includes(`env.${slot.frontend}`), `frontend/src/config.ts 没有读取 ${slot.frontend}（槽位写了但没人用）`);
  }
  /*
    名单地址在**前端发布链**上不能"空着照发"：空值照样能构建、能上传，而界面上三类屏蔽整体不生效
    （正是这次要修的那个 fail-open）。所以 deploy-fedmall.ps1 必须对空名单地址明确停下。
  */
  assert.match(
    DEPLOY_FEDMALL_PS,
    /if \(-not \$Blk\)[\s\S]{0,400}?\bDie\b/,
    'deploy-fedmall.ps1 必须拒绝空的 VITE_BLOCKLIST_ADDRESS（空值 = 正式站 fail-open 且没有报错）'
  );
});

/**
 * **通用向导 `scripts/deploy.mjs` 也必须带同样的槽位**（2026-10-17）。
 *
 * 这是"下一次漏配会红"的落点：CONTRACT_SLOTS 里每新增一个合约地址，上面几条会把
 * `deploy.sh` / `deploy.ps1` / 代部署 / 前端发布链逐个点一遍，而 `scripts/deploy.mjs`
 * （交互式一键向导，`scripts/deploy-linux.sh` 背后跑的就是它）曾经整条漏掉——它不问也不写
 * `MK_BLOCKLIST_ADDRESS` / `VITE_BLOCKLIST_ADDRESS`，于是走它部署出去的节点与前端在正式站上
 * 三类屏蔽整体静默失效（fail-open：构建、发布、页面全都成功，只是什么都不挡）。
 *
 * 判据按形状而不是按行号：每个**地址**槽位都必须有一条"从 `field()` 收 → `validAddress()` 拒 →
 * 写进生成的 .env → all 模式跨端对账"的链。起始块（numeric）不在向导职责内
 * （由 deploy.sh 从 deploy-constants.json 注入），所以不要求。
 */
guard('通用向导 scripts/deploy.mjs：每个合约地址槽位都被收集、被校验拒绝、被写入 .env，并在 all 模式核对', () => {
  const WIZARD = TREE.readText(path.join(REPO_ROOT, 'scripts', 'deploy.mjs'));
  for (const [key, slot] of Object.entries(CONTRACT_SLOTS)) {
    if (!slot.node || slot.numeric) continue;
    const sides = [['后端', slot.node]];
    if (slot.frontend) sides.push(['前端', slot.frontend]); // 只有节点侧的合约不要求前端向导问一遍
    for (const [side, envKey] of sides) {
      const collected = new RegExp(`const\\s+(\\w+)\\s*=\\s*\\(await field\\('${envKey}'`).exec(WIZARD);
      assert.ok(
        collected,
        `scripts/deploy.mjs 没有收集 ${envKey}（${side}）——通用向导少问一项，走它部署出去的机器就少一项配置且不报错`
      );
      const v = collected[1];
      assert.match(
        WIZARD,
        new RegExp(`if \\(!validAddress\\(${v}\\)\\) throw new Error\\('[^']*${envKey}`),
        `${envKey} 必须被 validAddress() 拒绝：空值/非法地址写进 .env 等于静默 fail-open（不能"留空也能继续"）`
      );
      assert.ok(WIZARD.includes(`['${envKey}', ${v}]`), `${envKey} 被收集了却没有写进生成的 .env`);
    }
    if (!slot.frontend) continue; // 只有节点侧的合约没有"前后端对账"这回事
    assert.match(
      WIZARD,
      new RegExp(`shared\\.${key}\\.toLowerCase\\(\\) !== fe\\.${key}\\.toLowerCase\\(\\)`),
      `all 模式没有核对 ${key}：前后端必须读同一套地址（Blocklist 是 Registry 的 immutable，错一份就是三类屏蔽静默失效）`
    );
  }
});

guard('deploy-constants 的形状：每个契约键俱全（可以为空，但不许缺键）', () => {
  for (const k of Object.keys(CONTRACT_SLOTS)) {
    assert.ok(k in TREE.constants.contracts, `contracts.${k} 必须在（留空表示"本批尚未部署"，但不许连键都没有）`);
  }
});

guard('deploy-constants：填了 Escrow 地址就必须填 codeHash（否则"接的是哪一代"无法机械核验）', () => {
  const { escrow, escrowCodeHash } = TREE.constants.contracts;
  const addr = String(escrow || '').trim();
  const hash = String(escrowCodeHash || '').trim();
  if (!addr) {
    assert.equal(hash, '', '未部署时 codeHash 必须为空（留一个旧哈希等于在说一句没有依据的话）');
    return;
  }
  assert.match(addr, /^0x[0-9a-fA-F]{40}$/, 'Escrow 必须是合法地址');
  assert.match(hash, /^0x[0-9a-fA-F]{64}$/, '填了地址就必须给出该批 Escrow 的运行时字节码哈希');
});

guard('deploy-constants 的 codeHash：必须等于**本地编译产物**（改了合约就必须换批）', { skip: FULL_TREE && !TREE.escrowArtifactExists ? '没有 contracts/out（未 forge build）' : false }, () => {
  const declared = String(TREE.constants.contracts.escrowCodeHash || '').trim();
  if (!declared) return; // 本批尚未部署：没有可核验的声明（上一条已保证这种情形下它必须为空）
  const artifact = JSON.parse(TREE.readText(TREE.escrowArtifact));
  const bytecode = artifact.deployedBytecode?.object || artifact.bytecode?.object || '';
  assert.ok(bytecode.startsWith('0x'), '编译产物里没有字节码：先跑 `cd contracts && forge build`');
  const local = ethers.keccak256(bytecode);
  assert.equal(
    declared.toLowerCase(),
    local.toLowerCase(),
    'deploy-constants.json 的 escrowCodeHash 与本地编译产物不一致 —— ' +
      '说明合约改过但部署常量没换批（或填错了哈希）。' +
      '请按当批部署结果更新 contracts 四项（Escrow / Registry / startBlock / escrowCodeHash），不要改这条断言。'
  );
});

/**
 * **容器的停机宽限期必须大于节点自己的排空上限**（2026-10-17）。
 *
 * 这是一条**纯数值关系**，而它错了的症状很隐蔽：宽限期一到，Docker 发 SIGKILL，
 * 优雅关闭被截断 —— 而节点那边**已经打过** `已关闭（原因：SIGTERM…` 那一行，
 * 于是日志看起来一切正常，没人会去查"关到一半被杀"。
 *
 * 两条边各自都有地方管：`MK_SHUTDOWN_DRAIN_MS` 由 `src/config.js` 解析（进 `.env.example`
 * 与 `deploy.sh` 生成的 `.env`），`runtime.stopGraceSeconds` 由 `deploy.sh` 传给
 * `docker run --stop-timeout`、由 `deploy.ps1` 传给 `docker run`。
 * **没有任何地方会替你把它们比一遍** —— 所以在这里比。
 *
 * 实测（192.168.122.11 的真容器，PID 1 收 SIGTERM）：整套关闭耗时 **382 ms**、退出码 0，
 * 所以默认 30s 宽限 / 10s 排空有极大余量；这条判据防的是**有人把排空调到 30s 以上**
 * 却没同步调宽限期。
 */
guard('运行时常量：容器停机宽限期必须 > 节点排空上限（相等就会正好被 SIGKILL 截断）', () => {
  const graceSec = Number(TREE.constants.runtime?.stopGraceSeconds);
  const drainMs = Number(TREE.constants.appDefaults?.MK_SHUTDOWN_DRAIN_MS);
  assert.ok(Number.isFinite(graceSec) && graceSec > 0, `runtime.stopGraceSeconds 必须是正数（当前 ${graceSec}）`);
  assert.ok(Number.isFinite(drainMs) && drainMs > 0, `appDefaults.MK_SHUTDOWN_DRAIN_MS 必须是正数（当前 ${drainMs}）`);
  assert.ok(
    graceSec * 1000 > drainMs,
    `宽限期 ${graceSec}s 必须严格大于排空上限 ${drainMs}ms —— 否则宽限期一到 SIGKILL 就把优雅关闭截断，` +
      `而日志里已经打了"已关闭"（看起来正常）`
  );
});