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
 *  3. 全局口径：`refreshFeeCollector()` 带 60s 缓存读链上全局 `feeCollector()`；**读不到就是读不到**
 *     （RPC 不可达/合约已移除该函数）⇒ `known=false`、`feeCollector=null`，随响应一起下发
 *     （`feeCollectorKnown` / `feeCollector`），UI 据此把金额标为「预计」而不是「已扣」。
 *     读不到时**绝不**拿上一次成功读到的地址冒充"当前的真值"：那会让一次 RPC 抖动把口径说反
 *     （"零地址=本部署从不扣费"与"读不到"在响应里曾是同一个形状——见 refreshFeeCollector 的注释）。
 */
import { getEscrow } from './chain.js';

/**
 * feeCollector 读取缓存（60s；同进程共享）。
 *  `at`      最后一次**尝试**读的时刻（只用于 TTL：读失败也刷新，避免每次请求都去戳不可达的 RPC）
 *  `addr`    本次（TTL 窗口内）**确证**读到的收取方；读不到时恒 null（= 读不到，不是"零地址"）
 *  `known`   本次是否**确证**（true 才有资格谈 addr 的含义：零地址 = 从不扣费）
 *  `lastOk`  最后一次**成功**读数 `{ at, addr }`，只作诊断/日志用（"最后一次成功读数"），
 *            **绝不**参与任何判定——它与"当前是否已确证"是两件事，故分开放。
 */
let cache = { at: 0, addr: null, known: false, lastOk: null };
const TTL_MS = 60_000;

/** 零地址判定（与 chain.isZeroAddress 同口径；此处内联避免循环依赖） */
function isZeroAddr(a) {
  return !a || String(a).toLowerCase() === '0x0000000000000000000000000000000000000000';
}

/**
 * 刷新链上 feeCollector（带 TTL 缓存）。账本/看板/导出路由在计算前 await 一次即可。
 * 永不抛错。
 *
 * ⚠️ 用途已收窄为**披露与兜底**（每单快照缺失时才参与折算）：链上已改为按订单创建时快照
 * 决定扣费，全局值只是"这家店现在配的收费方"，不再等于任何在途单的实际口径。
 */
export async function refreshFeeCollector() {
  if (cache.at && Date.now() - cache.at < TTL_MS) return cache;
  try {
    const addr = String(await getEscrow().feeCollector()).toLowerCase();
    const at = Date.now();
    cache = { at, addr, known: true, lastOk: { at, addr } };
    return cache;
  } catch (e) {
    /*
      读失败 ⇒ **如实标成"读不到"**（2026-10，推翻 2026-09 复审的"沿用上次的 known"）。
      "读不到"与"确证是某个值"是两件事：旧实现把 `addr`/`known` 保留上次的成功读数，
      于是一次 RPC 抖动就能把口径**说反**——上一次读到零地址（=本部署从不扣费）之后读不到，
      响应里仍旧写着"已知、零地址"，面板继续按"已扣/不扣"报数，而当前真相是"不知道"。
      现在：本次窗口内一律 `known=false`、`addr=null`（读不到），`feeChargeable()` 随之
      按"可能扣费"保守折算并在响应里标「预计」（与本文件头的三级策略一致）。
      上次成功读数只留在 `lastOk` 里供日志/诊断说明"最后读到的是什么"，**不参与判定**。
      `at` 仍刷新（"上次尝试读的时刻"）：读不到时也不要在每个请求上重打不可达的 RPC。
    */
    const prev = cache.lastOk;
    cache = { at: Date.now(), addr: null, known: false, lastOk: prev };
    console.warn(
      `[fees] 读不到链上全局 feeCollector()（${e?.message || e}）——本次披露按"读不到"（feeCollectorKnown=false、feeCollector=null）、` +
        `无快照的行按"可能扣费"保守折算并标注为预计；${
          prev ? `最后一次成功读数是 ${prev.addr}（${new Date(prev.at).toISOString()}）` : '此前从未成功读到过'
        }`
    );
    return cache;
  }
}

/**
 * 当前是否可能扣费：已知 feeCollector 为 0 → 从不扣费；**读不到** → 按可能扣费处理（保守）。
 * 这是**全局兜底口径**，只用于"该单没有创建时快照"的行（见 feeChargeableForOrder）。
 * 注意三态：`true` 有两种来源——"确证非零地址"与"读不到（估算）"。要分清它们看
 * `feeStatus().feeCollectorKnown`（false = 读不到，金额只能当预计），不要把这个布尔当链上事实。
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

/**
 * 对外披露口径（随账号类接口返回，供 UI 标注「已扣 / 预计」）：
 *  `feeCollector`      本次确证读到的收取方；**读不到时为 null**（不再是上次的值）
 *  `feeCollectorKnown` false = 本次读不到 ⇒ 界面必须按「预计」呈现（三态：确证扣/确证不扣/读不到）
 *  `feeChargeable`     全局兜底布尔（读不到时按"可能扣费"保守取值，见上）
 * 三个字段语义不变（前端 utils/arbiterMoney.feeCollectorFromNodeFlags 已按这三态消费）。
 */
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

/** 仅供测试：清空缓存（含"最后一次成功读数"——用例之间不得互相看见对方的读数） */
export function resetFeeCache() {
  cache = { at: 0, addr: null, known: false, lastOk: null };
}
