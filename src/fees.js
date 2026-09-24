/**
 * 平台费口径（**唯一实现**）——收款流水/看板/CSV 导出的净额都走这里。
 *
 * 「收不收、按哪个地址收」在**创建订单时快照**（每单一个决定，2026-09 契约变更）：
 * 合约 `Escrow.Order` 新增 `feeCollectorAtCreate`，`_settle` 只读这个快照——
 *   `feeCollectorAtCreate != address(0) && feeBps > 0` 才扣费
 * 为什么不能读全局 `feeCollector()`（源码审计 2026-09 → 契约层修复）：
 * 全局值可被 owner 事后 `setFeeCollector(x)` 改掉，而**费率调整不应影响在途订单**。
 * 于是"实时读全局"必然与链上漂移，且两个方向都错：
 *  · 创建时配了收取方 → 事后被置零：链上照扣（快照），节点账本却报"不扣费"⇒ 净额虚高；
 *  · 创建时为 0 → 事后配了收取方：链上一分不扣，节点账本却按 feeBps 折算 ⇒ 净额虚低。
 * 这正是本文件头要消灭的"面板说扣了、钱包没少"。
 *
 * 读取策略（三级）：
 *  1. **每单快照**（orders.fee_collector_at_create，由 paid / watcher / sync 从链上补录）——
 *     权威，不需要任何 RPC。非空 → 直接按它判（零地址=不扣，非零=扣）；
 *  2. 快照为空（旧数据/补录失败/ABI 尚未同步）= **未知** → 退回全局口径 `feeChargeable()`
 *     （见下），并在响应里如实标注"未知"；
 *  3. 全局口径：`refreshFeeCollector()` 带 60s 缓存读链上全局 `feeCollector()`，读不到
 *     （RPC 不可达/合约已移除该函数）时按 `known=false` 处理——**保持既有口径**（按 feeBps 扣），
 *     因为「少报费用」比「多报费用」更容易让店主误判到账金额；`known=false` 会随响应一起
 *     下发给前端（`feeCollectorKnown`），UI 据此把金额标为「预计」而不是「已扣」。
 */
import { getEscrow } from './chain.js';

/** feeCollector 读取缓存（60s；同进程共享） */
let cache = { at: 0, addr: null, known: false };
const TTL_MS = 60_000;

/** 零地址判定（与 chain.isZeroAddress 同口径；此处内联避免循环依赖） */
function isZeroAddr(a) {
  return !a || String(a).toLowerCase() === '0x0000000000000000000000000000000000000000';
}

/**
 * 刷新链上 feeCollector（带 TTL 缓存）。账本/看板/导出路由在计算前 await 一次即可。
 * 永不抛错（读不到就沿用上次结果；从未成功过则 known=false）。
 *
 * ⚠️ 用途已收窄为**披露与兜底**（每单快照缺失时才参与折算）：链上已改为按订单创建时快照
 * 决定扣费，全局值只是"这家店现在配的收费方"，不再等于任何在途单的实际口径。
 */
export async function refreshFeeCollector() {
  if (cache.at && Date.now() - cache.at < TTL_MS) return cache;
  try {
    const addr = String(await getEscrow().feeCollector()).toLowerCase();
    cache = { at: Date.now(), addr, known: true };
  } catch {
    /*
      读失败**沿用上次的 known**（源码审计 2026-09 复审，P2）：文件头写明"读不到就沿用上次结果"，
      而旧实现把 `known` 一律打成 false —— 一次 RPC 抖动就能把已确证的"零地址=本部署从不扣费"
      翻成"可能扣费"：净额变小、口径由 snapshot 退回 fallback、界面由「已扣」变「预计」。
      `at` 仍刷新（这是"上次尝试读的时刻"，用于 TTL），`addr` 与 `known` 保留上次的真值。
    */
    cache = { at: Date.now(), addr: cache.addr, known: cache.known };
  }
  return cache;
}

/**
 * 当前是否可能扣费：已知 feeCollector 为 0 → 从不扣费；未知 → 按可能扣费处理（保守）。
 * 这是**全局兜底口径**，只用于"该单没有创建时快照"的行（见 feeChargeableForOrder）。
 */
export function feeChargeable() {
  return !(cache.known && isZeroAddr(cache.addr));
}

/**
 * 该订单在创建时是否配置了平台费收取方（链上快照，**权威且不依赖 RPC**）。
 *  - 快照非空 → `快照 !== 零地址`（零地址 = 创建时就没配收取方 ⇒ 这单永不扣费）；
 *  - 快照为空/缺失（'' / null / undefined，旧数据或补录未成功）→ **未知**，
 *    退回全局保守口径 `feeChargeable()`（宁可提示"可能扣费"，也不把不知道说成不扣费）。
 * @param {string|null|undefined} feeCollectorAtCreate orders.fee_collector_at_create（小写地址或 ''）
 */
export function feeChargeableForOrder(feeCollectorAtCreate) {
  const snap = String(feeCollectorAtCreate ?? '').trim();
  if (!snap) return feeChargeable();
  return !isZeroAddr(snap);
}

/**
 * 该单的扣费判据**来自哪里**：`'snapshot'`（创建时收费方快照——链上权威）或
 * `'fallback'`（快照缺失 → 退回全局保守口径，**可能**与链上实际扣费不符）。
 *
 * 为什么必须把它单独说出来（源码审计 2026-09 续）：`feeChargeableForOrder` 在快照缺失时
 * 会给出一个"保守但可能错"的布尔值，而导出/对账只看那个布尔值就分不出两种情况——
 * 「确证按快照不扣费」与「读不到、于是按会扣费折算」。后者正是店主月结时对不上账的常见来源
 * （费率差额不是数据错误，是口径没落盘）。三态纪律：有快照 / 无快照 / 判据本身未知，
 * 前两者都在这里如实标出，绝不让"折算了"冒充"已确证"。
 * @param {string|null|undefined} feeCollectorAtCreate orders.fee_collector_at_create
 * @returns {'snapshot'|'fallback'}
 */
export function feeBasisOf(feeCollectorAtCreate) {
  return String(feeCollectorAtCreate ?? '').trim() ? 'snapshot' : 'fallback';
}

/** 对外披露口径（随账号类接口返回，供 UI 标注「已扣 / 预计」） */
export function feeStatus() {
  return { feeCollector: cache.addr || null, feeCollectorKnown: cache.known, feeChargeable: feeChargeable() };
}

/**
 * 从链上 `getOrder` 结果里取本单的费率与**创建时收取方快照**（唯一实现；paid / watcher / sync
 * 三个补录入口共用）。
 *
 * `feeCollectorAtCreate` 是 `getOrder` 返回元组末尾新增的一项（契约层 2026-09，ABI 已同步）。
 * 字段缺失/为 null 时返回空串 = **未知**（绝不回落成零地址——那等于凭空宣称"这单不扣费"）。
 * @returns {{feeBps:number, feeCollectorAtCreate:string}} feeCollectorAtCreate 小写地址或 ''（未知）
 */
export function feeSnapshotOf(onchain) {
  const raw = onchain?.feeCollectorAtCreate;
  const snap = raw === undefined || raw === null ? '' : String(raw).trim().toLowerCase();
  return {
    feeBps: Number(onchain?.feeBps || 0),
    feeCollectorAtCreate: snap,
  };
}

/**
 * 平台费折算：**结算基数** × feeBps / 10000（与链上同款下取整）；不扣费时恒为 0。
 * 注意 `amountWei` 是**结算基数**，不是托管总额：调用方要传 `amount − refunded`
 * （部分退款/拆分裁决的单，费只对卖家实收的那部分计）。
 *
 * 第三个参数 = 该行的 `orders.fee_collector_at_create`（**按单**判定，见 feeChargeableForOrder）。
 * 不传时退回全局口径（旧行为），便于逐点迁移；账本调用点必须传。
 */
export function feeOf(amountWei, feeBps, feeCollectorAtCreate) {
  const bps = Number(feeBps);
  if (!Number.isInteger(bps) || bps <= 0) return 0n;
  if (!feeChargeableForOrder(feeCollectorAtCreate)) return 0n;
  return (BigInt(amountWei) * BigInt(bps)) / 10000n;
}

/** 卖家实收净额 = **传入的结算基数** − 平台费（调用方传 `amount − refunded`）；
 *  第三个参数同 feeOf（按单的创建时收取方快照）。 */
export function netOf(amountWei, feeBps, feeCollectorAtCreate) {
  return BigInt(amountWei) - feeOf(amountWei, feeBps, feeCollectorAtCreate);
}

/** 仅供测试：清空缓存 */
export function resetFeeCache() {
  cache = { at: 0, addr: null, known: false };
}
