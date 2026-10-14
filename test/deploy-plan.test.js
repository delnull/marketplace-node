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

const require = createRequire(import.meta.url);
/**
 * `scripts/lib/deployPlan.cjs` 属于**合约部署工具**（仓库根 `scripts/` 下）。
 * 只有节点这一份代码时它不在，于是整组用例**跳过而不是失败**——判据是"这个文件在不在"，
 * 两种目录布局下同一份代码都不用改。
 */
let deployPlan = {};
try {
  deployPlan = require('../../scripts/lib/deployPlan.cjs');
} catch {
  /* 这棵树里没有合约部署脚本：跳过 */
}
const {
  planEscrowDeploy,
  newEscrowWarning,
  planStakingGas,
  resolveRejectGraceBlocks,
  resolveMinTimeoutBlocks,
  resolveAfterSaleWindowBlocks,
  STAKING_FALLBACK_GAS,
} = deployPlan;
const guard = deployPlan.planEscrowDeploy ? test : test.skip;

const ADDR = '0xAbC0000000000000000000000000000000000001';

guard('给了地址但没给 --new-escrow ⇒ 拒绝执行（默认不再部署第二个 Escrow）', () => {
  const p = planEscrowDeploy({ envAddress: ADDR });
  assert.equal(p.action, 'error');
  assert.equal(p.address, null);
  // 报错信息必须能指导下一步：给出两条出路（复用 / 显式换新）
  assert.match(p.reason, /MK_ESCROW_ADDRESS 已设置/);
  assert.match(p.reason, /--skip-escrow/);
  assert.match(p.reason, /--new-escrow/);
});

guard('--skip-escrow + 地址 ⇒ 复用，不进入部署分支', () => {
  const p = planEscrowDeploy({ envAddress: ADDR, skipEscrow: true });
  assert.equal(p.action, 'reuse');
  assert.equal(p.address, ADDR);
});

guard('--skip-escrow 但没有地址 ⇒ 报错（而不是走到后面才炸）', () => {
  const p = planEscrowDeploy({ envAddress: '', skipEscrow: true });
  assert.equal(p.action, 'error');
  assert.match(p.reason, /需要同时设置 MK_ESCROW_ADDRESS/);
});

guard('--new-escrow 是唯一的换新实例方式（会提示处置旧实例）', () => {
  const p = planEscrowDeploy({ envAddress: ADDR, newEscrow: true });
  assert.equal(p.action, 'deploy');
  const warn = newEscrowWarning(ADDR);
  assert.match(warn, /正在部署\*\*新的\*\* Escrow 实例/);
  assert.match(warn, /重建节点库/);
});

guard('什么都没设 ⇒ 首次部署；空串/空白地址按"未设置"处理', () => {
  for (const envAddress of ['', '   ', undefined, null]) {
    const p = planEscrowDeploy({ envAddress });
    assert.equal(p.action, 'deploy', `envAddress=${String(envAddress)}`);
    assert.equal(p.address, null);
  }
});

guard('地址两侧空白被裁剪（env 里常见的手抄空格不该改变判定）', () => {
  const p = planEscrowDeploy({ envAddress: `  ${ADDR}  `, skipEscrow: true });
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
  const p = planStakingGas({ escrowAction: 'reuse', escrowAddress: ADDR });
  assert.equal(p.estimate, true);
  assert.equal(p.escrowAddress, ADDR);
  assert.match(p.note, /就地估算/);
});

guard('Staking gas：首次部署不估算（占位地址必然 revert，脚本会在广播前整条退出）', () => {
  const p = planStakingGas({ escrowAction: 'deploy', escrowAddress: '' });
  assert.equal(p.estimate, false);
  // 关键：绝不能给出一个"可用来估算"的地址——占位地址就是旧实现那个坑
  assert.equal(p.escrowAddress, null);
  assert.equal(p.gasLimit, STAKING_FALLBACK_GAS);
  assert.match(p.note, /占位地址估算必然 revert/);
});

guard('Staking gas：--new-escrow 时即便 env 里有旧地址也不拿它估算', () => {
  const p = planStakingGas({ escrowAction: 'deploy', escrowAddress: ADDR });
  assert.equal(p.estimate, false);
  assert.equal(p.escrowAddress, null);
});

guard('Staking gas：回退值可覆盖，非 bigint 输入也能归一', () => {
  assert.equal(planStakingGas({ escrowAction: 'deploy', fallbackGas: 9_000_000n }).gasLimit, 9_000_000n);
  assert.equal(planStakingGas({ escrowAction: 'deploy', fallbackGas: '9000000' }).gasLimit, 9_000_000n);
  /*
    默认回退值的判据是「**够**且**准**」，不是「够大」：
      · 够：主网真机实测 Staking 部署 gasUsed = 3_184_180；
      · 准：它同时被预检的余额门禁用来算预估费用（见 deployPlan 里 STAKING_FALLBACK_GAS 的长注释），
        虚高会在钱够的时候拒绝部署 —— 旧值 6_000_000 就把 0.1075 BTY 的余额判成了不够。
    所以下界钉「实测 × 110%」，上界钉「实测 × 2」，两头都是防回归。
  */
  const MEASURED_MAINNET_GAS = 3_184_180n;
  assert.ok(
    STAKING_FALLBACK_GAS >= (MEASURED_MAINNET_GAS * 110n) / 100n,
    `回退 gasLimit 覆盖不了实测用量：${STAKING_FALLBACK_GAS} < ${MEASURED_MAINNET_GAS} × 110%`
  );
  assert.ok(
    STAKING_FALLBACK_GAS <= MEASURED_MAINNET_GAS * 2n,
    `回退 gasLimit 虚高（预检余额门禁会误报）：${STAKING_FALLBACK_GAS} > 实测 ${MEASURED_MAINNET_GAS} × 2`
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
    const r = resolveRejectGraceBlocks(v);
    assert.equal(r.ok, true, `env=${String(v)}`);
    assert.equal(r.level, 'default');
    assert.equal(r.blocks, 17_280n);
    assert.match(r.reason, /≈1 天/);
  }
});

guard('静置期：低于下界一律拒绝（含 0 与 1——两者客观效果相同），下界本身放行', () => {
  const MIN = 17_280n;
  assert.equal(resolveRejectGraceBlocks(String(MIN)).ok, true, '下界本身必须是合法值');
  assert.match(resolveRejectGraceBlocks(String(MIN)).reason, /17280 块/);
  for (const v of ['0', ' 0 ', 0, '1', 1, '12', String(MIN - 1n)]) {
    const r = resolveRejectGraceBlocks(v);
    assert.equal(r.ok, false, `env=${String(v)}`);
    assert.equal(r.blocks, null);
    assert.match(r.reason, /低于合约下界/);
    assert.match(r.reason, /InvalidRejectGrace/);
  }
});

guard('静置期：超上限（10 天）⇒ 拒绝；上限值本身通过', () => {
  const over = resolveRejectGraceBlocks('172801');
  assert.equal(over.ok, false);
  assert.match(over.reason, /超过合约上限/);

  const atCap = resolveRejectGraceBlocks('172800');
  assert.equal(atCap.ok, true);
  assert.equal(atCap.blocks, 172_800n);
});

guard('静置期：非十进制整数 ⇒ 拒绝（含小数/负数/十六进制/带单位）', () => {
  for (const v of ['1.5', '-1', '0x10', '17280 blocks', 'abc']) {
    const r = resolveRejectGraceBlocks(v);
    assert.equal(r.ok, false, `env=${v}`);
    assert.match(r.reason, /必须是十进制整数/);
  }
});

guard('静置期：下界之上的合法值原样透传（含前导空白）', () => {
  const r = resolveRejectGraceBlocks(' 43200 ');
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
    const r = resolveMinTimeoutBlocks(v);
    assert.equal(r.ok, true, `env=${String(v)}`);
    assert.equal(r.level, 'default');
    assert.equal(r.blocks, 17_280n);
    assert.match(r.reason, /≈1 天/);
  }
  const MIN = 17_280n;
  assert.equal(resolveMinTimeoutBlocks(String(MIN)).ok, true, '下界本身必须是合法值');
  // 0 不再是合法值：它等于"节点可以写 timeoutBlocks = 1"，而 1 与 0 客观效果相同
  for (const v of ['0', ' 0 ', 0, '1', 1, '12', String(MIN - 1n)]) {
    const r = resolveMinTimeoutBlocks(v);
    assert.equal(r.ok, false, `env=${String(v)}`);
    assert.equal(r.blocks, null);
    assert.match(r.reason, /低于合约下界/);
    assert.match(r.reason, /InvalidMinTimeout/);
  }
});

guard('最小超时窗口：上限（30 天 = MAX_TIMEOUT_BLOCKS）本身通过，超上限/非整数 ⇒ 拒绝', () => {
  const atCap = resolveMinTimeoutBlocks('518400');
  assert.equal(atCap.ok, true);
  assert.equal(atCap.blocks, 518_400n);

  const over = resolveMinTimeoutBlocks('518401');
  assert.equal(over.ok, false);
  assert.equal(over.blocks, null);
  assert.match(over.reason, /超过合约上限/);
  assert.match(over.reason, /InvalidMinTimeout/);

  for (const v of ['1.5', '-1', '0x10', '17280 blocks', 'abc']) {
    const r = resolveMinTimeoutBlocks(v);
    assert.equal(r.ok, false, `env=${v}`);
    assert.match(r.reason, /必须是十进制整数/);
  }
});

guard('售后窗口：未设置 ⇒ 默认 180 天；低于下界（含 0 与 1）一律拒绝——0 与 1 的效果相同', () => {
  for (const v of ['', '   ', undefined, null]) {
    const r = resolveAfterSaleWindowBlocks(v);
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
  assert.equal(resolveAfterSaleWindowBlocks(String(MIN)).ok, true, '下界本身必须是合法值');
  assert.match(resolveAfterSaleWindowBlocks(String(MIN)).reason, /17280 块/);
  for (const v of ['0', ' 0 ', 0, '1', 1, '1440', String(MIN - 1n)]) {
    const r = resolveAfterSaleWindowBlocks(v);
    assert.equal(r.ok, false, `env=${String(v)}`);
    assert.equal(r.blocks, null);
    assert.match(r.reason, /静默关闭/);
    assert.match(r.reason, /InvalidAfterSaleWindow/);
  }
});

guard('售后窗口：上限（360 天 = 6 220 800 块）本身通过，超上限/非整数 ⇒ 拒绝', () => {
  const atCap = resolveAfterSaleWindowBlocks('6220800');
  assert.equal(atCap.ok, true, '上限本身必须是合法值');
  assert.equal(atCap.blocks, 6_220_800n);
  assert.match(atCap.reason, /6220800 块/);

  // 默认值（180 天 = 3 110 400）也必须是合法值：合约上限若被调小，默认值会先撞上限
  const atDefault = resolveAfterSaleWindowBlocks('3110400');
  assert.equal(atDefault.ok, true);
  assert.equal(atDefault.blocks, 3_110_400n);

  const over = resolveAfterSaleWindowBlocks('6220801');
  assert.equal(over.ok, false);
  assert.match(over.reason, /超过合约上限/);

  for (const v of ['1.5', '-1', '0x10', '518400 blocks', 'abc']) {
    const r = resolveAfterSaleWindowBlocks(v);
    assert.equal(r.ok, false, `env=${v}`);
    assert.match(r.reason, /必须是十进制整数/);
  }
});
