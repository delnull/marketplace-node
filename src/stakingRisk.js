/**
 * 本节点保证金状况的只读读数（治理/运维用，`GET /api/shop/staking`）。
 *
 * 节点不读取任何 Registry：这里只回答"本节点 Staking 的池子还够不够覆盖它自己的出金下限"。
 * `Staking.payoutFloors(operator)` 是那条下限的唯一实现（exposure = 在途售后 + 在途提货争议
 * 敞口，required = max(exposure, minRetainedStake)）。池子低于它时，出金会被链上拒绝，
 * 而节点日志里一个字都不会说——所以需要一个只读读数。
 *
 * 事实源与取舍：
 *  - 保证金合约取本节点配置的 `MK_STAKING_ADDRESS`；`poolOf` / `payoutFloors` 都从它读。
 *  - 未配置 Staking、RPC 不可达、合约读不到时返回 `available:false` + reason，
 *    **不下发任何"看起来像结论"的数字**——"读不到"绝不能显示成"池子够用"。
 *  - 复算：本读数完全由链上状态推出，第三方可独立复算。
 */
import { ethers } from 'ethers';
import config from './config.js';
import { getProvider, weiToDecimal } from './chain.js';

const STAKING_ABI = [
  'function poolOf(address operator) view returns (uint256)',
  'function payoutFloors(address operator) view returns (uint256 exposure, uint256 required)',
];

/** 读数缓存时长：池额/敞口都是低频变化量，面板轮询不该每次都打一轮 RPC */
const TTL_MS = 30_000;

/**
 * 纯函数：池额与出金下限的缺口（**不触链、可单测**）。
 *
 * 判据与链上 `_revertIfBelowFloor` 逐字同口径：`pool < required` 才算出金会被拒
 * （等于下限**通过**）。池额/下限读不到时由调用方给 `available:false`——这里不做兜底。
 *
 * @param {string|bigint} poolWei 在池担保额
 * @param {string|bigint} requiredWei 出金下限
 * @returns {{below: boolean, shortfallWei: string}}
 */
export function shortfallOf(poolWei, requiredWei) {
  const pool = BigInt(poolWei);
  const required = BigInt(requiredWei);
  const short = pool < required ? required - pool : 0n;
  return { below: short > 0n, shortfallWei: short.toString() };
}

/** 未配置/不可读时的统一形状（**不含任何金额字段**：读不到 ≠ 池子够用） */
function unavailable(reason) {
  return {
    available: false,
    reason,
    stakingAddress: config.chain.stakingAddress || null,
    operator: null,
    poolWei: null,
    poolDecimal: null,
    exposureWei: null,
    exposureDecimal: null,
    requiredWei: null,
    requiredDecimal: null,
    belowFloor: null,
    shortfallWei: null,
    shortfallDecimal: null,
    checkedAt: null,
  };
}

let cache = { at: 0, value: null };

/** 仅供测试：清空缓存 */
export function resetStakingRiskCache() {
  cache = { at: 0, value: null };
}

/**
 * 读取本节点保证金状况（带 30s 缓存；任何一步读不到都返回 available:false + reason）。
 * @param {{force?: boolean}} opts force = 忽略缓存（巡检脚本/测试用）
 */
export async function stakingShortfall({ force = false } = {}) {
  const stakingAddress = String(config.chain.stakingAddress || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(stakingAddress)) {
    return unavailable('MK_STAKING_ADDRESS 未配置：本节点没有保证金层，无从读取池额与出金下限');
  }
  const operator = String(config.shop.owner || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(operator)) {
    return unavailable('MK_SHOP_OWNER 未配置：没有 operator 地址可读');
  }
  if (!force && cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const staking = new ethers.Contract(stakingAddress, STAKING_ABI, getProvider());
    const [poolRaw, floors] = await Promise.all([staking.poolOf(operator), staking.payoutFloors(operator)]);
    const poolWei = BigInt(poolRaw).toString();
    const exposureWei = BigInt(floors?.exposure ?? 0).toString();
    const requiredWei = BigInt(floors?.required ?? 0).toString();
    const { below, shortfallWei } = shortfallOf(poolWei, requiredWei);
    const value = {
      available: true,
      reason: null,
      stakingAddress,
      operator,
      poolWei,
      poolDecimal: weiToDecimal(poolWei),
      exposureWei,
      exposureDecimal: weiToDecimal(exposureWei),
      requiredWei,
      requiredDecimal: weiToDecimal(requiredWei),
      belowFloor: below,
      shortfallWei,
      shortfallDecimal: weiToDecimal(shortfallWei),
      checkedAt: Date.now(),
    };
    cache = { at: Date.now(), value };
    return value;
  } catch (e) {
    return unavailable(`读不到本节点 Staking（${e?.message || e}）：这不是"没有缺口"，请稍后重试`);
  }
}
