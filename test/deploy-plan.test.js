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
const { planEscrowDeploy, newEscrowWarning, planStakingGas, STAKING_FALLBACK_GAS } = deployPlan;
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
  // 默认回退值必须够大：Staking 部署产物 8 KiB 级，实测 ~2M gas 量级
  assert.ok(STAKING_FALLBACK_GAS >= 5_000_000n, `回退 gasLimit 太小：${STAKING_FALLBACK_GAS}`);
});
