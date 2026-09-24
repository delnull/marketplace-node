/**
 * Escrow 事件轮询器：定时从链上拉取托管事件，将本地订单状态推进为权威值。
 *
 * 事件 → 本地状态（仅当订单存在且前置状态匹配时迁移，防止回退）：
 *   OrderCreated        draft     → escrowed
 *   ReceiptConfirmed    escrowed/shipped/disputed → confirmed（买家确认收货；争议中=买家撤诉放款）
 *   DisputeRequested    escrowed/shipped → disputed（买家发起争议）
 *   Arbitrated          disputed  → refundWei == amount ? refunded : settled
 *                       （**拆分结算**：refundWei 退买家、余额扣费后判卖家，两者都发生在同一笔里，
 *                        所以状态由退款额决定而不是由"谁赢了"决定；见 settleByRefundSplit）
 *   OrderExpiredReleased draft/escrowed/shipped → expired（超时释放给卖家，refundWei 恒 0）
 *   RefundRequested     escrowed/shipped → 同状态 + refund_status=requested（两级售后第一级：
 *                       买家链上申请退款，资金冻结/超时释放被禁，等待卖家 approve/reject）
 *   RefundRejected      escrowed/shipped → 同状态 + refund_status=rejected（卖家拒绝，
 *                       买家获得 requestDispute 资格——第二级入口；合约不接受被拒后重复申请）
 *   PartialRefundAccepted escrowed/shipped/disputed/… → **状态不变**，只把买家授权的部分退款额
 *                       写进 accepted_partial_refund_wei（授权不转移资金、不冻结订单，见下）
 *   RefundApproved      escrowed/shipped/disputed → refunded（refundWei == amount 全额退回买家，
 *                       或争议中和解）/ settled（refundWei == 买家授权额的部分退款）
 *                       （合约 2026-09 收紧：approveRefund 只接受「全额」或「acceptedPartialRefund
 *                       里买家精确授权过的那个数」，其它一律 `RefundAmountNotAccepted`——旧的
 *                       `RefundNotFull` 已删除。卖家退部分金额**必须**先拿到买家对那个数字的授权，
 *                       而拆分裁决（任意比例、无需授权）仍只归仲裁人 `arbitrate(orderId, refundWei)`。
 *                       占位仅回补「从未交付」的行——交付后退款视为货在买家侧需线下回收，
 *                       不自动回补，与 shipped→expired 不释放同口径）
 *
 * 两级售后为链上强制流程（合约状态机），本地 refund_status 仅为其镜像：
 * 迁移失败（changes=0）的事件不记录事件史，幂等重复扫描不重复记账。
 *
 * ⚠️ 上表的 from 集是**正常路径**；代码里每个分支的 from 集都更宽，用来收敛"节点停机/漏扫"
 * 留下的残镜像（`draft`/`cancelled` 也接受，否则这些单会永远停在非终态、卖家流水漏计）。
 * 以 `applyEventCore`（`case 'ReceiptConfirmed'` / `case 'OrderExpiredReleased'` 里的 FROM_SET）
 * 与 `settleByRefundSplit` / `markEscrowDisputed` 里的实际集合为准
 *（`docs/ARCHITECTURE.md` §3.2 的表是按代码逐行核对的）。
 *
 * 说明：
 *  - BTY EVM 主网无可靠的公共 WebSocket，事件轮询（eth_getLogs 按块区间）是稳妥路径；
 *  - 起始块存 kv（mk:escrow_last_block）；首次启动默认从"当前最新块"开始，
 *    若担心漏扫历史事件，配置 MK_ESCROW_START_BLOCK = Escrow 合约部署块高度；
 *  - 同一轮询内事件按 (blockNumber, logIndex) 排序后逐个应用，状态迁移顺序与链一致。
 */
import config from './config.js';
import { getDb, kvGet, kvSet, txBegin, txCommit, txRollback } from './db.js';
// fetchOnchainOrder：非 OrderCreated 事件的「链上真值预取」（防诱饵单，见 pollOnce 头部说明）——
// **必漏不可**：少了它，pollOnce 里那句 await 会抛 ReferenceError 被当成"链上真值未取到"，
// 于是**所有**退款/争议/仲裁类事件每轮失败、回退重扫 3 次后被隔离，链上镜像静默停摆。
import { getEscrow, getProvider, fetchOnchainOrder } from './chain.js';
import { tryAutoDeliverByEscrowOrder, flushAutoDeliverPending } from './autoDeliver.js';
import { releaseHoldsForOrderIds, releaseHoldsForReturnReceived, releaseRefundedEscrow, restockOrder } from './stockHold.js';
import { notify, notifyRaw, typeForChainEvent } from './webhook.js';
import { alertPoolEmptyForOrder } from './poolAlert.js';
// 一次性告警的「投递成功才写幂等标记」（唯一实现；见 alertAck.js）
import { alertOnceDelivered } from './alertAck.js';
// 费率/创建时收取方快照的取值口径（唯一实现，见 src/fees.js 的 feeSnapshotOf）
import { feeSnapshotOf } from './fees.js';

const LAST_BLOCK_KEY = 'mk:escrow_last_block';
const LAST_HASH_KEY = 'mk:escrow_last_block_hash'; // 游标块哈希（重组检测基准）
/** 追赶回放未追平时抑制自动交付的收尾冲刷标记（见 pollOnce 尾部与 autoDeliver.flushAutoDeliverPending） */
const AUTO_FLUSH_KEY = 'mk:escrow_auto_deliver_flush_pending';
/** 单轮扫描区块数上限（BTY 5 秒/块，2000 块 ≈ 2.8 小时；防 RPC 单次超时） */
const SCAN_LIMIT = 2000;
/**
 * 检测到重组（游标块哈希不一致）时的回退重扫深度：64 块 ≈ 5 分钟，覆盖常见短重组。
 * 2026-09 复核：原 20 块在「贴链头 + 深度 >20 块重组」场景下回退不足——先前已应用的
 * 终局事件（如 RefundApproved）可能在新分叉上不存在而本地镜像滞留终态；64 块覆盖
 * 更深的短重组（BTY 平均出块 5s，超深度重组需 5 分钟以上，概率极低；事件史/对账
 * 仍可人工兜底）。回退只多拉一段日志（幂等重扫），成本可忽略。
 */
const REORG_REWIND_BLOCKS = 64;
/**
 * 同一事件的最大重试轮数（源码审计 2026-09 修复「坏事件永久钉死游标」）：
 * 事件应用失败会把游标回退到该事件前一块重扫（确定性重试）。但若该事件**每轮都失败**
 * （ABI 漂移、脏数据、唯一键冲突），回退 + `to = min(latest, from + SCAN_LIMIT)` 会让扫描窗口
 * 永远停在 `failedFrom + 2000`——链头越过该窗口后，**其后所有订单事件再也不会被拉取**
 *（镜像静默停摆），且 `behind` 恒为 true 令自动交付被永久抑制。
 * 故同一事件连续失败到上限后转入「隔离」：本窗口跳过它继续推进。隔离清单持久化到 kv
 * 并经 /healthz 暴露（事件不静默消失：每轮告警 + 清单可查 + 可人工处理后清理重放）。
 */
const MAX_EVENT_RETRIES = 3;
/** 失败事件隔离清单（kv；键 = block:index:name），防进程重启后重复无限重试 */
const FAILED_EVENTS_KEY = 'mk:escrow_failed_events';
/** 隔离清单条目上限（防无界增长；超出丢最旧） */
const FAILED_EVENTS_MAX = 50;

/**
 * 原始 JSON-RPC 只读调用（块哈希读取专用）：BTY 主网区块含系统交易（to=0x16 的奖励交易
 * nonce≈6e18），ethers v6 的 getBlock 解析会因 nonce 溢出崩溃——凡涉及区块对象的读取
 * 一律走原始 JSON-RPC（与 scripts/deploy-mainnet.cjs 同策略）。
 * 2026-09 复核：显式 15s 超时——RPC 挂起（TCP 黑洞/节点无响应）时若无超时，轮询器将
 * 永久卡在重组检测上，订单状态回写与自动交付全部停摆（fetch 默认无超时）。
 */
async function rpc(method, params) {
  const res = await fetch(config.chain.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error?.message || JSON.stringify(j.error)}`);
  return j.result;
}

/** 读取指定块哈希：`undefined` = RPC 失败（调用方须与原「块不存在」区分对待），`null` = 块不存在 */
async function blockHashOf(height) {
  try {
    const b = await rpc('eth_getBlockByNumber', [`0x${BigInt(height).toString(16)}`, false]);
    return b && b.hash ? String(b.hash).toLowerCase() : null;
  } catch {
    return undefined;
  }
}

/**
 * 轮询器运行状态（供 /healthz 暴露，源码审计 2026-09：此前游标只存在 kv、进展只进控制台，
 * 「游标落后/事件隔离/轮询失败」在运维侧完全不可见——docker healthcheck 照样绿）。
 */
const watcherStatus = {
  startedAt: 0,
  lastPollAt: 0,
  lastOkAt: 0,
  lastError: null,
  cursor: 0,
  latest: 0,
  lagBlocks: 0,
  lastScan: null,
  upToDate: false,
  quarantined: 0,
};

/** 只读快照（/healthz 与运维脚本用） */
export function escrowWatcherStatus() {
  const q = (() => {
    try {
      const m = JSON.parse(kvGet(FAILED_EVENTS_KEY, '') || '{}');
      return m && typeof m === 'object' ? Object.keys(m).length : 0;
    } catch {
      return 0;
    }
  })();
  return {
    configured: !!config.chain.escrowAddress,
    ...watcherStatus,
    quarantined: q,
    /** 落后链头是否已超过单轮扫描上限（= 追赶中；长期 >0 说明轮询跟不上或 RPC 受限） */
    lagBlocks: Math.max(0, Number(watcherStatus.lagBlocks) || 0),
  };
}

/**
 * 事件处理顺序（与状态机一致，合并后按块序应用）。
 *
 * **导出**（2026-09）：这条清单是"事件漏挂"这一整类缺陷的唯一入口——事件不在清单里，
 * `pollOnce` 就**永远不会**为它发 queryFilter，链上发生了、本地毫无痕迹且无任何报错。
 * 导出给单测逐项钉住（新事件必须同时进清单；删掉一行就会有用例变红），见
 * `test/partial-refund-consent.test.js`。运维侧 `/healthz` 不消费它（只读轮询状态）。
 */
export const EVENTS = [
  'OrderCreated',
  'ReceiptConfirmed',
  'DisputeRequested',
  'Arbitrated',
  'OrderExpiredReleased',
  'RefundRequested',
  'RefundRejected',
  // 买家对具体金额的部分退款授权（approveRefund 退部分金额的唯一合法来源）——
  // **漏挂即静默**：卖家面板永远看不到买家授权额，只能拿 RefundAmountNotAccepted 的 revert 试错
  'PartialRefundAccepted',
  'RefundApproved',
];

/** 事件史上限（防单订单无限膨胀；20 条覆盖完整生命周期富余） */
const EVENT_HISTORY_LIMIT = 20;

/** 事件史追加：链上凭证（txHash/块号）落订单，供详情核对与仲裁溯源 */
function recordEvent(escrowOrderId, ev) {
  const db = getDb();
  const row = db.prepare('SELECT onchain_events FROM orders WHERE escrow_order_id = ?').get(escrowOrderId);
  if (!row) return;
  let list = [];
  try {
    list = row.onchain_events ? JSON.parse(row.onchain_events) : [];
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  list.push(ev);
  if (list.length > EVENT_HISTORY_LIMIT) list = list.slice(-EVENT_HISTORY_LIMIT);
  db.prepare('UPDATE orders SET onchain_events = ? WHERE escrow_order_id = ?').run(JSON.stringify(list), escrowOrderId);
}

/**
 * 应用单条链上事件到本地订单（导出以便单测直接覆盖各状态迁移分支）。
 *  meta: { txHash, block, chainParams, skipAutoDeliver }——链上凭证与链上真值；迁移成功
 *  （changes>0）时追加进订单事件史。
 *
 * 原子性（审计 D2/D3 分组）：状态迁移 + 占位释放/恢复 + 事件史同属一个事务——
 * 防进程恰在「状态 UPDATE 已落库、释放/事件史未执行」之间中断：事件幂等重放时
 * 状态不再命中（changed=0），释放会被永久跳过 → 终局单占位滞留。单事件全事务后
 * 中断即整体回滚，游标回退重扫（N1）时事件完整重放。SAVEPOINT 嵌套：内部
 * release 系 / restock / autoDeliver 的事务自动降级为内层保存点。
 *
 * 副作用时序（源码审计 2026-09 修复）：webhook 通知与自动交付原在事务内发出——若后续语句
 * 抛错整体回滚，卖家已收到「订单已托管」而本地仍是 draft（回滚后重扫会再报一次）。
 * 现统一压入 meta.afterCommit，**COMMIT 成功之后**才执行（顺序与原先一致：先 order.escrowed，
 * 后自动交付的 order.shipped）；单个副作用抛错只告警，不影响已提交的状态。
 */
export function applyEvent(name, args, meta = {}) {
  const after = [];
  const m = { ...meta, afterCommit: after };
  txBegin();
  let changed;
  try {
    changed = applyEventCore(name, args, m);
    txCommit();
  } catch (e) {
    txRollback();
    throw e;
  }
  for (const fn of after) {
    try {
      fn();
    } catch (e) {
      console.error(`[escrowWatcher] 提交后副作用失败（状态已落库，不影响一致性）: ${name}`, e?.message || e);
    }
  }
  return changed;
}

/**
 * 链上真值与本地订单锁定参数逐项比对（买家/卖家/金额三者皆不可变）。
 * 缺字段（单测直调/兼容旧调用）时返回 true（跳过比对）。
 * 导出：链上状态对账（chainReconcile）同样必须据此拒绝「他人对同一 orderId 的诱饵单」——
 * orderId 自草稿起公开，不比对就等于让 1 wei 的假单驱动本地状态。
 */
export function chainParamsMatch(local, p) {
  if (!p) return true;
  const buyerOk = !p.buyer || String(p.buyer).toLowerCase() === String(local.buyer || '').toLowerCase();
  const sellerOk = !p.seller || String(p.seller).toLowerCase() === String(local.seller || '').toLowerCase();
  let amountOk = true;
  if (p.amount !== undefined && p.amount !== null) {
    try {
      amountOk = BigInt(p.amount) === BigInt(local.amount_wei || '0');
    } catch {
      amountOk = false;
    }
  }
  return buyerOk && sellerOk && amountOk;
}

/**
 * 链上终局（status + refundedAmount）→ 本地终态（**唯一实现**）。
 *
 * 链上状态本身无法区分"买家确认收货 / 超时释放 / 仲裁判付"（三者都是 Settled），
 * 所以不猜事件名：只有全额退回买家的才是 refunded，其余（含 refundedAmount = 0 = 全判卖家）一律 settled。
 *
 * 判据与链上 `Escrow._settle` 逐字一致：
 *   refundWei == amount → 状态 Refunded（全额退买家，不扣费）
 *   0 ≤ refundWei < amount → 状态 Settled（拆分结算或全额判卖家）
 * 而 `getOrder` 的 `refundedAmount` 正是那个 refundWei 的镜像，故快照路径（chainReconcile 兜底
 * 对账 / `POST /:id/sync` 手动同步）与事件路径必须共用本函数——否则同一笔单走事件回写还是走
 * 快照同步会得到两种说法（历史上 `/sync` 把 refundedAmount=0 的 Settled 落成 `confirmed`，
 * 而事件路径/对账落 `settled`；`confirmed` 的界面文案断言"你已确认收货"，而链上状态无从证明
 * 这个**买家动作**，只有真实 ReceiptConfirmed 事件才能证明）。
 *
 * 解析失败（null/undefined/NaN/非数字字符串/负数溢出等）按 0 处理，**永不抛错**——调用方在
 * HTTP/轮询路径上，不能因为一个脏字段把整条修复链打断。
 *
 * @param {string} chainStatus 链上状态名（'Settled' / 'Refunded' / ...）
 * @param {string|number|bigint} refundedAmountWei 链上已退买家金额
 * @param {string|number|bigint} amountWei 本单托管额（本地锁定值，链上真值经 chainParamsMatch 校验过）
 * @returns {'refunded'|'settled'}
 */
export function mapChainTerminal(chainStatus, refundedAmountWei, amountWei) {
  if (String(chainStatus ?? '') === 'Refunded') return 'refunded';
  const wei = (v) => {
    if (v === undefined || v === null || v === '') return 0n;
    try {
      const n = BigInt(typeof v === 'string' ? v.trim() : v);
      return n > 0n ? n : 0n; // 负数/0 一律按 0（脏数据不外溢成"退款"）
    } catch {
      return 0n;
    }
  };
  const amount = wei(amountWei);
  return amount > 0n && wei(refundedAmountWei) >= amount ? 'refunded' : 'settled';
}

/**
 * 链上「按退款额拆分结算」→ 本地终态（RefundApproved / Arbitrated 共用，**唯一实现**）。
 *
 * 合约侧语义（Escrow._settle）：refundWei 退买家，余额 amount−refundWei 扣费后给卖家；
 *   refundWei == amount → 状态 Refunded（全额退款）
 *   refundWei <  amount → 状态 Settled（拆分：部分退款 + 部分结算，含 refundWei=0 全额判卖家）
 * 本地镜像必须与之一致：全额退 → 'refunded'；拆分/判卖家 → 'settled'。两者都记
 * `refunded_amount_wei`（账本净额 = amount − refunded − 已扣平台费；UI 据此展示拆分）。
 *
 * @param {string|number|bigint} refundWeiArg 事件里的退款额（缺失时回退本地金额，兼容旧事件字段）
 * @returns {number} 受影响行数（0 = 未命中可迁移的行）
 *
 * 导出：链上状态对账（chainReconcile）的终局修复走**同一个函数**——对账若自己写一份
 * "链上 Refunded/Settled → 本地状态 + refunded_amount_wei + 占位回补"的映射，
 * 两处迟早会漂移（这正是本仓库反复强调的"唯一实现"）。
 */
export function settleByRefundSplit(db, orderId, refundWeiArg, meta = {}) {
  const local = db
    .prepare('SELECT id, amount_wei, status FROM orders WHERE escrow_order_id = ?')
    .get(orderId);
  if (!local) return 0;
  let amount = 0n;
  let refunded = 0n;
  try {
    amount = BigInt(local.amount_wei || '0');
    refunded = refundWeiArg === undefined || refundWeiArg === null ? 0n : BigInt(refundWeiArg);
  } catch {
    refunded = 0n;
  }
  // 事件字段缺失（单测直调/兼容旧调用）时按「全额判卖家」处理，与旧版 refundToBuyer=false 等价；
  // 真实链上事件经 ABI 解码必然带 refundWei，且已被 chainParams 校验过订单归属。
  //
  // 与 `mapChainTerminal` 的关系：两者**同一判据**（amount > 0 && refunded >= amount → refunded），
  // 事件路径直接用事件里的 refundWei（信息更全：不必等 getOrder 快照），快照路径只有
  // status + refundedAmount 两个字段，故走 mapChainTerminal。改判据时必须同时改这两处，
  // 否则「同一笔单走事件回写 vs 走兜底同步」会得到两种本地终态。
  const fullRefund = amount > 0n && refunded >= amount;
  const status = fullRefund ? 'refunded' : 'settled';
  const changed = db
    .prepare(
      `UPDATE orders SET status = ?, refund_status = 'none', refunded_amount_wei = ?, updated_at = ?
        WHERE escrow_order_id = ? AND status IN ('draft','cancelled','escrowed','shipped','disputed')`
    )
    .run(status, refunded.toString(), Date.now(), orderId).changes;
  if (changed > 0) {
    if (fullRefund) {
      // 全额退款：占位按「未交付行」口径回补（已交付后退款视为货在买家侧，需线下回收，防超卖）
      releaseRefundedEscrow(orderId);
    } else {
      // 拆分/判卖家：成交向终态——已交付行若退货已确认收货/放弃追索则回补占位（D1 口径）
      releaseHoldsForReturnReceived(orderId);
    }
  }
  return changed;
}

/**
 * 链上 Disputed → 本地 disputed（**唯一实现**）：DisputeRequested 事件与链上状态对账
 * （chainReconcile 按 getOrder 的 Disputed 修复滞留单）共用同一 SQL/from 集，
 * 防两处条件漂移导致「事件能改、对账改不动」（或反之）的静默分歧。
 *
 * from 集含 `cancelled`（源码审计 2026-09 补齐）：终局路径（Refunded/Settled/Expired）
 * 早就接受 cancelled 残镜像，冻结路径却漏了它——于是"买家在草稿被清扫/取消之后才完成支付"
 * 这一竞态留下一个死角：只要 `OrderCreated` 那次扫描也漏了（RPC 抖动/进程停机），
 * 买家随后申请退款、被拒、发起争议时，本地行会**永远停在 cancelled**，
 * 而链上那笔钱已经真的被冻结在 Disputed 里。cancelled 行取消时已释放占位，
 * 迁到 disputed 不产生占位副作用（与终局路径同理）。
 * @returns {number} 受影响行数（0 = 未命中可迁移的行）
 */
export function markEscrowDisputed(db, orderId) {
  return db
    .prepare("UPDATE orders SET status = 'disputed', updated_at = ? WHERE escrow_order_id = ? AND status IN ('draft','escrowed','shipped','cancelled')")
    .run(Date.now(), orderId).changes;
}

/**
 * 买家「已授权的部分退款额」→ 订单列（**唯一实现**）。
 *
 * 两条路径共用本函数：事件路径（`PartialRefundAccepted` 分支）与快照路径
 * （`POST /:id/sync` 读链上只读视图 `acceptedPartialRefund(orderId)` 兜底）——
 * 各写一份 SQL 迟早漂移（一边写 updated_at、一边不写；一边容忍脏值、一边不容忍），
 * 而这一列是卖家给出"链上真的会接受的退款金额"的唯一依据（契约 2026-09：
 * `approveRefund` 只接受「全额」或 `acceptedPartialRefund[orderId]`）。
 *
 * 口径：
 *  - 只写这一列、**不迁移状态、不动 updated_at**（授权不转移资金、不冻结订单；且 updated_at
 *    是统计窗口与列表排序的依据，迟到的事件不该把行挪进更晚的窗口）；
 *  - 幂等：值与本地相同时 changes=0（重扫/重复同步不产生噪音写，也不重复记事件史）；
 *  - 解不出金额（ABI 漂移/字段缺失/脏值）时返回 0 且**保持本地原值**——绝不写 '0'
 *    （那等于断言"买家从未授权"，会抹掉面板上一条有效授权），也绝不写假数字。
 *
 * @param {string} orderIdHex 链上托管单号
 * @param {string|number|bigint} acceptedWei 授权额（0 = 未授权）
 * @returns {number} 受影响行数（0 = 无该单 / 值未变 / 不可解析）
 */
export function applyAcceptedPartialRefund(orderIdHex, acceptedWei) {
  const raw = acceptedWei;
  let wei = null;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    try {
      wei = BigInt(raw).toString();
    } catch {
      wei = null;
    }
  }
  if (wei === null) {
    console.warn(
      `[escrowWatcher] 忽略无法解析的授权额（orderId=${String(orderIdHex).slice(0, 18)}… acceptedWei=${JSON.stringify(raw)}）：保持本地原值`
    );
    return 0;
  }
  return getDb()
    .prepare(
      'UPDATE orders SET accepted_partial_refund_wei = ? WHERE escrow_order_id = ? AND accepted_partial_refund_wei != ?'
    )
    .run(wei, String(orderIdHex).toLowerCase(), wei).changes;
}

function applyEventCore(name, args, meta = {}) {
  const orderId = String(args.orderId).toLowerCase();
  const db = getDb();
  /*
    防伪托管（**全事件**口径，源码审计 2026-09 修复）：此前只有 OrderCreated 分支核对
    金额/卖家/买家，终局与冻结类事件（Expired / Arbitrated / Refund* / DisputeRequested /
    ReceiptConfirmed）**只按 orderId + 本地状态**落地——而 orderId 自草稿起即公开
    （匿名 `GET /api/orders?address=` 就能读到 draft 的 escrowOrderId）。攻击者据此对任意
    **未付款草稿**的 orderId 用 1 wei + timeoutBlocks=1 建一笔自己的链上单，再调
    releaseExpired 触发 OrderExpiredReleased：本地 draft 被改成 expired（库存占位被释放、
    事件史写入攻击者 txHash、并按 INCOME_STATUS 计入卖家流水），此后买家真实支付因
    OrderExists 永久 revert，只能作废重下——每开一张草稿即可被定点打断一次。
    现要求：凡带 meta.chainParams（pollOnce 以 getOrder 预取的链上真值；买家/卖家/金额
    自创建起不可变）的事件，必须先与本行锁定值逐项一致，不一致则整条事件不落地。
    注：单测直调/兼容旧调用不带 chainParams 时跳过（与 OrderCreated 分支同口径）。
  */
  if (name !== 'OrderCreated' && meta.chainParams) {
    const localForCheck = db
      .prepare('SELECT id, buyer, seller, amount_wei FROM orders WHERE escrow_order_id = ?')
      .get(orderId);
    if (localForCheck && !chainParamsMatch(localForCheck, meta.chainParams)) {
      console.warn(
        `[escrowWatcher] 忽略与链上真值不符的事件: ${name} orderId=${orderId} 买家/卖家/金额与本地订单锁定不一致（疑似他人对同一 orderId 的诱饵单）`
      );
      return 0;
    }
  }
  let changed;
  switch (name) {
    case 'OrderCreated': {
      // 防伪托管（与 paid/sync 同规则）：Escrow 仅接受原生 BTY 入金（2026-09 收敛，
      // 不再支持任意 ERC20），但攻击者仍可用 0 金额/错误卖家直调 createOrder 制造
      // 「已托管」假象——仅按 orderId 推进会被骗过而自动发码。事件里的金额/卖家/买家必须
      // 与本地订单锁定值一致（买家比对防「他人钱包代付」锁死资金/误触发交付）；
      // 字段缺失（单测直调/兼容旧调用）时跳过比对——真实链上事件经 ABI 解码必然字段齐全。
      const local = db
        .prepare("SELECT id, status, buyer, seller, amount_wei, paid_tx_hash FROM orders WHERE escrow_order_id = ?")
        .get(orderId);
      if (local) {
        let match = true;
        if (args.seller !== undefined && args.amount !== undefined && args.buyer !== undefined) {
          const sellerOk = String(args.seller).toLowerCase() === String(local.seller || '').toLowerCase();
          const buyerOk = String(args.buyer).toLowerCase() === String(local.buyer || '').toLowerCase();
          let amountOk = false;
          try {
            amountOk = BigInt(args.amount) === BigInt(local.amount_wei || '0');
          } catch {
            amountOk = false;
          }
          match = sellerOk && buyerOk && amountOk;
        }
        // 兜底：事件字段缺失（ABI 漂移）时用 pollOnce 预取的链上真值再比一遍
        if (match && meta.chainParams) match = chainParamsMatch(local, meta.chainParams);
        if (!match) {
          console.warn(
            `[escrowWatcher] 忽略疑似伪造托管事件: orderId=${orderId} 金额/卖家/买家与本地订单锁定不符`
          );
          return 0; // 不推进、不记录事件史、不触发自动交付
        }
      }
      const now = Date.now();
      // 支付哈希统一小写（与 paid/sync 同规约；唯一索引大小写敏感，防同笔支付双形落两单）
      const txHash = meta.txHash ? String(meta.txHash).toLowerCase() : null;
      // watcher 落支付哈希：log.transactionHash 与 paid 路径的 receipt.hash 同为链上规范哈希
      // （BTY 双哈希：广播返回的 hash 可能只是别名，一律归一；COALESCE 保证 paid 快路径
      // 先落库时不覆盖，且单测缺 meta 时保持不变）
      changed = db
        .prepare(
          "UPDATE orders SET status = 'escrowed', paid_tx_hash = COALESCE(paid_tx_hash, ?), updated_at = ? WHERE escrow_order_id = ? AND status = 'draft'"
        )
        .run(txHash, now, orderId).changes;
      if (changed === 0 && local && local.status === 'cancelled' && !local.paid_tx_hash) {
        // 草稿超时被清扫（sweeper）/手动取消后链上托管才落定的竞态恢复：
        // 事件金额/卖家/买家已与本地一致 → 链上资金真实存在。先按逐单占位记账回补占位
        // （restockOrder 失败=取消期间限量库存被卖完，仅记告警——资金已上链，订单优先恢复，
        // 差额由店主人工核账扩容），再置 escrowed 并自动交付。
        if (!restockOrder(local.id)) {
          // 占位恢复失败 = 该单的限量库存在取消期间被卖给了别人：链上资金真实存在、订单
          // 必须恢复（不能因本地账目卡住资金），但本地余量已无法覆盖两笔承诺 → 存在超卖，
          // 需店主人工核账/扩容。仅 console 会静默漏过（源码审计 2026-09 修复）：
          // 同时推店主 webhook + 每个订单只告警一次（用 kv 标记），保证「看得见」。
          console.error(
            `[escrowWatcher] 恢复已取消订单 ${local.id.slice(0, 8)}… 的库存占位失败（限量库存不足），请店主核账扩容`
          );
          try {
            // 标记只在投递成功后写（2026-09 修复）：投递失败/未配置通知地址时不写，
            // 事件重放（重启/重组重扫）会再推一次——"超卖需核账"不能因为一次投递失败就永久丢失
            alertOnceDelivered({
              ackKey: `mk:escrow_hold_missing:${local.id}`,
              label: '[escrowWatcher]',
              what: `（order.hold_missing，order=${local.id.slice(0, 8)}…，取消期间限量库存已被他人买走）`,
              send: () =>
                notifyRaw('order.hold_missing', {
                  orderId: local.id,
                  escrowOrderId: orderId,
                  reason: '取消期间限量库存已被他人买走，订单已恢复但未重新占位——请核对该商品余量并扩容或退款处理',
                }),
            });
          } catch {
            /* 告警失败不影响恢复（console 已留痕） */
          }
        }
        changed = db
          .prepare(
            "UPDATE orders SET status = 'escrowed', paid_tx_hash = COALESCE(paid_tx_hash, ?), updated_at = ? WHERE escrow_order_id = ? AND status = 'cancelled' AND paid_tx_hash IS NULL"
          )
          .run(txHash, now, orderId).changes;
        if (changed > 0) {
          console.warn(`[escrowWatcher] 自动恢复已取消订单 ${local.id.slice(0, 8)}…（链上托管已落定，置回 escrowed）`);
        }
      }
      // 卡密自动交付：数字商品且码池有未用码时，托管成功后直接自动发码置 shipped。
      // 通知顺序保证语义不倒置：先 escrowed（托管成功）再 shipped（自动交付完成）。
      // 追赶回放防误发：同批内该单稍后存在终局事件（退款/仲裁判退/超时）时
      // pollOnce 传 skipAutoDeliver=true → 本轮不自动发码（等待本批终局事件把单置终态），
      // 避免「已退款/已超时买家仍免费得码」；单测直调不带该标记，行为不变。
      if (changed > 0) {
        // 提交后再发（见 applyEvent 说明）：先 escrowed，再自动交付的 shipped
        meta.afterCommit?.push(() => notify('order.escrowed', orderId));
        if (!meta.skipAutoDeliver) meta.afterCommit?.push(() => tryAutoDeliverByEscrowOrder(orderId));
        /*
          池式商品「已收款却无货可交」告警（2026-09）：码池/NFT 池在下单与支付之间被淘空时
          只有面板的 poolEmpty 标着，卖家不看就不知道（而买家钱已上链）。排在自动交付之后
          （交付成功 = 池子里本来够，判定自然不成立），每单至多一次（poolAlert 内 kv 标记）。
        */
        meta.afterCommit?.push(() => alertPoolEmptyForOrder(orderId));
      }
      break;
    }
    case 'ReceiptConfirmed':
      // 买家确认收货可发生在退款申请后（链上 confirmReceipt 不要求未申请）——终局同时复位售后镜像；
      // v2+ 争议中买家撤诉放款同样发本事件（Escrow.confirmReceipt 扩 Disputed 态）→ disputed → confirmed
      // from 集对齐 /sync 的 Settled 口径（源码审计 2026-09）：draft/cancelled 行是「节点漏扫
      // OrderCreated」的残镜像——链上既已收到本事件，说明该单确实托管过且已结算给卖家，
      // 本地必须收敛到成交终局（此前这些行永远停在 draft/cancelled，卖家流水漏计）。
      changed = db
        .prepare("UPDATE orders SET status = 'confirmed', refund_status = 'none', updated_at = ? WHERE escrow_order_id = ? AND status IN ('draft','cancelled','escrowed','shipped','disputed')")
        .run(Date.now(), orderId).changes;
      // D1：已交付行若退货已确认收货/放弃追索（received_at 非空，货已实际回卖家侧/卖家放弃追回），
      // 即使资金终局判给卖家（成交）也不应继续占位——实物已可再售，见 releaseHoldsForReturnReceived
      if (changed > 0) releaseHoldsForReturnReceived(orderId);
      break;
    case 'DisputeRequested':
      // from 集与对账（chainReconcile 按链上 Disputed 修复）共用 markEscrowDisputed（唯一实现）
      changed = markEscrowDisputed(db, orderId);
      break;
    // 两级售后（v2）：买家链上 requestRefund → refund_status=requested（资金冻结、超时释放被禁）；
    // 卖家 rejectRefund → rejected（解锁 requestDispute 资格）。合约不接受被拒后重复申请
    //（防「申请→拒绝→再申请」无限冻结循环，见 Escrow.sol requestRefund），本地镜像随之翻转。
    case 'RefundRequested':
      changed = db
        .prepare(
          "UPDATE orders SET refund_status = 'requested', refund_requested_at = ?, updated_at = ? WHERE escrow_order_id = ? AND status IN ('escrowed','shipped') AND refund_status != 'requested'"
        )
        .run(Date.now(), Date.now(), orderId).changes;
      break;
    case 'RefundRejected':
      changed = db
        .prepare(
          "UPDATE orders SET refund_status = 'rejected', refund_rejected_at = ?, updated_at = ? WHERE escrow_order_id = ? AND status IN ('escrowed','shipped') AND refund_status != 'rejected'"
        )
        .run(Date.now(), Date.now(), orderId).changes;
      break;
    case 'PartialRefundAccepted': {
      /*
        买家对**具体金额**的部分退款授权（契约 2026-09 新增；契约收紧 approveRefund 之后，
        卖家要退部分金额，唯一合法取值就是这里被授权的那个数）。

        本事件**不迁移订单状态**：授权不转移资金、不冻结订单，买家仍可确认收货/发起争议/
        改授权额（重复授权覆盖旧值），所以 status / refund_status 一律不动。

        但"授权额真的写入/变化"必须算作 changed > 0 —— 通用尾部（recordEvent 事件史 +
        typeForChainEvent 通知分派）只在 changed > 0 时才跑，若这里恒返回 0，链上授权了、
        本地订单详情里却查不到任何凭证（而卖家要凭这条金额去调 approveRefund）。
        幂等：`WHERE ... != ?` 让同值重扫（重组回退/失败重试）changes=0，不重复记账
        （与其它分支"changes=0 不写事件史"同口径）。
        重复授权覆盖旧值时被拒的授权不会上链（合约在写映射前 revert），故本列恒等于链上
        `acceptedPartialRefund(orderId)`。

        刻意**不迁移状态、不动 updated_at**（写入逻辑与 /sync 快照路径共用同一实现
        `applyAcceptedPartialRefund`）：授权不改变任何时间线语义，而 updated_at 是统计窗口
        （stats.js 的入账/退款按天聚合）与店主列表排序的依据——一个迟到的事件把已终局的行
        "挪"进更晚的窗口，就等于让成交额在两天的报表里各出现一次。本分支只写这一列，别无副作用。

        通知：不派发 webhook（`typeForChainEvent` 刻意不给它映射）——这不是店主/买家需要
        被叫醒的**状态**通知：订单状态没变、钱没动，卖家用不用这个授权额由他自己决定
        （面板上读 DTO 即可）。给它加 'order.*' 通知只会让店主在"什么都没发生"时收到告警。
      */
      changed = applyAcceptedPartialRefund(orderId, args?.refundWei);
      break;
    }
    case 'RefundApproved':
      // 卖家 approveRefund（申请后同意 / 争议中和解）：合约 2026-09 只接受两种金额 ——
      // refundWei == amount（全额认赔，不需要授权）或 refundWei == 买家已精确授权的
      // acceptedPartialRefund[orderId]（部分退款）；其它一律 RefundAmountNotAccepted
      //（旧的 RefundNotFull 已删除），所以本事件只会是这两档之一；能任意比例拆分的
      // 仍然只有仲裁人 arbitrate（Arbitrated 事件，无需买家授权）。
      // 这里仍走 settleByRefundSplit 的按额判定（而不是硬写 refunded）：ABI 漂移/旧事件字段缺失时
      // 判据与 Arbitrated 完全一致，不会出现"同一笔钱两条事件路径两种终态"。
      // from 集对齐 /sync 的 Refunded 口径（源码审计 2026-09）：补 draft/cancelled——链上已终局
      // 是事实，本地残镜像必须收敛（此前这些行永远停在非终态，买家看不到结果）。
      changed = settleByRefundSplit(db, orderId, args.refundWei, meta);
      break;
    case 'Arbitrated':
      // 仲裁裁决（争议可能带着 requested/rejected 镜像进入）：refundWei 同口径拆分结算；
      // 占位回补（全额退款 = 未交付行口径 / 拆分与判卖家 = D1 退货已回收口径）由 settleByRefundSplit 内部处理
      changed = settleByRefundSplit(db, orderId, args.refundWei, meta);
      break;
    case 'OrderExpiredReleased': {
      // 链上超时释放适用于 Created 单：本地 draft/escrowed（未交付）与 shipped（已交付后买家
      // 拖单不确认）都可能是其镜像；confirmed 亦纳入 from 集（历史上 /sync 把链上
      // Settled 一律焊成 confirmed 后，真实超时事件必须能把该镜像纠正为 expired——真实
      // 买家确认收货后链上不会再发本事件，纳入 confirmed 无回退风险）。释放口径与退款
      // 终局一致（见 releaseRefundedEscrow）：「已交付」（shipped，或 escrowed 但已有交付行/
      // 物流单号的部分交付）一律视为钱货两清、不释放库存占位（防已售出货物回补库存导致
      // 超卖）；从未交付的 draft/escrowed 归还占位额度（货仍在库可再售）。逐行快照判定
      // 释放粒度，避免以单行状态代表整体漏放/多放。超时即终局：售后镜像复位。
      // from 集对齐 /sync 与对账的口径（源码审计 2026-09）：补 cancelled（草稿被清扫后才
      // 落定的链上单，卖家真实收款而本地永不停留在非终态 = 流水漏计）、disputed（链上 Created
      // 单不可能超时释放成 Disputed，本地 disputed 必是漏扫/重组残镜像），
      // 以及 **settled**（2026-09 复审补：/sync 与 chainReconcile 现在把"链上已 Settled 但原因未知"
      // 统一收敛为 settled，其中就包含**超时释放后事件被漏扫**这一种——事件随后被重扫出来时，
      // 必须能把镜像纠正成更准确的 expired，否则买家看到的永远是"已结算"而不是"超时已释放给商家"。
      // 安全性：orderId 一单一号且 createOrder 对已存在单号 revert，故不可能同时存在"真单"与"诱饵单"，
      // 凡是本事件到达且 chainParams 校验通过，本地已终局的行也应当被纠正）。
      const FROM_SET = "('draft','cancelled','escrowed','shipped','disputed','confirmed','settled')";
      const before = db
        .prepare(
          `SELECT o.id, o.status, o.shipped_at, o.tracking_no,
                  (SELECT COUNT(*) FROM order_delivery_items d WHERE d.order_id = o.id) AS items
           FROM orders o
           WHERE o.escrow_order_id = ? AND o.status IN ${FROM_SET}`
        )
        .all(orderId);
      changed = db
        .prepare(`UPDATE orders SET status = 'expired', refund_status = 'none', updated_at = ? WHERE escrow_order_id = ? AND status IN ${FROM_SET}`)
        .run(Date.now(), orderId).changes;
      if (changed > 0) {
        /*
          「已交付事实」= shipped_at ∨ tracking_no ∨ 交付行（与 db.js 的列注释、stockHold.js 的
          释放判据、returns.hasDelivered **同一口径**）。原先只判 `status !== 'shipped'` 与
          tracking_no/交付行，漏了 `shipped_at`——而 `/sync` 会把链上 Settled 焊成 `confirmed`，
          于是「自提/线下交付（空物流单号，只有 shipped_at）」的单走到这里时
          `status === 'confirmed'` 绕过了 `!== 'shipped'`、另两项也空 → **占位被回补**，
          已经交到买家手里的货重新变成可售库存 → 超卖（正是 db.js 里 shipped_at 那一列
          声明要防的事：自提/线下交付也须据此判已交付）。
        */
        const released = before
          .filter((r) => r.status !== 'shipped' && !r.shipped_at && !r.tracking_no && !r.items)
          .map((r) => r.id);
        if (released.length) releaseHoldsForOrderIds(released);
        // D1：已交付行（shipped/有物流/有交付行）超时释放本不自动回补（货在买家侧钱货两清），
        // 但若退货已确认收货/放弃追索（received_at 非空）——货已实际回到卖家侧可再售——占位回补
        releaseHoldsForReturnReceived(orderId);
      }
      break;
    }
    default:
      return 0;
  }
  if (changed > 0) {
    recordEvent(orderId, { name, txHash: meta.txHash || null, block: meta.block || null, at: Date.now() });
    // 卖家通知（P0-3）：状态迁移成功后触发（webhook 内部未配置即零开销）。
    // OrderCreated 已在分支内先行入队（保证 escrowed 早于自动交付的 shipped），此处跳过防双发
    const wtype = typeForChainEvent(name, args);
    if (wtype && name !== 'OrderCreated') meta.afterCommit?.push(() => notify(wtype, orderId));
  }
  return changed;
}

/** 执行一轮扫描，返回统计信息（无链上配置时跳过） */
export async function pollOnce() {
  if (!config.chain.escrowAddress) {
    return { skipped: true, reason: 'MK_ESCROW_ADDRESS 未配置' };
  }
  watcherStatus.lastPollAt = Date.now();
  if (!watcherStatus.startedAt) watcherStatus.startedAt = watcherStatus.lastPollAt;
  const escrow = getEscrow();
  const head = await getProvider().getBlockNumber();
  /*
    确认深度（源码审计 2026-09）：只扫描「链头 − finalityBlocks」之前的区块。
    重组只回放日志、不回滚已落地的终态（本地无反向迁移路径），等 N 块再处理即从源头规避
    「事件先落地、随后被重组掉」造成的永久错位。finalityBlocks=0 时等价于旧行为（见 config.js）。
  */
  const latest = Math.max(0, head - (config.escrow.finalityBlocks || 0));

  let from = Number(kvGet(LAST_BLOCK_KEY, '') || 0);
  let cursorHash = kvGet(LAST_HASH_KEY, '');
  if (from > 0 && cursorHash) {
    // 重组检测（游标已存在且存过哈希）：若该高度的链上哈希与上次记录不一致，说明发生了
    // 重组/回滚——被替换高度上的事件（含自动发码）可能作废，回退一段深度重扫。
    // 迁移幂等（状态前置条件守卫），重扫不会重复记账/重复发码（码分配走条件 UPDATE）。
    // 注：RPC 失败（undefined）与「块不存在」（null）必须区分——源码审计 2026-09：
    // 原实现把两者都当 null 而**静默跳过**检测，窗口照常应用新分叉日志并把游标哈希覆盖成
    // 新链值，重组从此再也检测不出来（孤儿状态永久滞留）。RPC 失败时显式告警。
    const curHash = await blockHashOf(from);
    if (curHash === undefined) {
      console.warn(`[escrowWatcher] 重组检测跳过：游标块 ${from} 哈希读取失败（RPC 异常），本轮不做重组比对`);
    } else if (curHash && curHash !== cursorHash) {
      const rewound = Math.max(1, from - REORG_REWIND_BLOCKS + 1);
      console.warn(
        `[escrowWatcher] 检测到链重组：游标块 ${from} 哈希不一致，回退 ${from - rewound + 1} 块重扫（幂等）`
      );
      from = rewound - 1;
      cursorHash = '';
    }
  }
  if (!from) {
    from = config.escrow.startBlock > 0 ? config.escrow.startBlock - 1 : latest - 1;
    if (config.escrow.startBlock <= 0) {
      console.warn('[escrowWatcher] 首次启动且未配置 MK_ESCROW_START_BLOCK，从最新块开始扫描；历史事件可由 /api/orders/:id/sync 兜底');
    }
  }
  if (from >= latest) {
    // 已追平链头：若此前有跨越多个扫描窗口的追赶回放（期间抑制了自动交付），在此做
    // 一次链上真值冲刷——跨批残留的「OrderCreated 与退款分处两窗」场景由
    // flushAutoDeliverPending 以 getOrder 复核后补交付（仅 Created 且未申请退款的行）
    if (kvGet(AUTO_FLUSH_KEY, '') === '1') {
      try {
        const flushed = await flushAutoDeliverPending();
        kvSet(AUTO_FLUSH_KEY, '');
        if (flushed > 0) {
          console.warn(`[escrowWatcher] 追赶收尾冲刷补交付 ${flushed} 单（此前跨窗抑制）`);
        }
      } catch (e) {
        console.warn(`[escrowWatcher] 追赶收尾冲刷失败：${e?.message || e}（下一轮追平重试）`);
      }
    }
    Object.assign(watcherStatus, {
      cursor: from,
      latest,
      lagBlocks: 0,
      upToDate: true,
      lastOkAt: Date.now(),
      lastError: null,
    });
    return { upToDate: true, from, latest };
  }
  const to = Math.min(latest, from + SCAN_LIMIT);
  watcherStatus.cursor = from;
  watcherStatus.latest = head;
  watcherStatus.lagBlocks = head - from;
  watcherStatus.upToDate = false;
  // 本轮未达链头（仍有 backlog 待下一轮追扫）：回放中的 OrderCreated 一律抑制自动交付——
  // 其后的退款/仲裁/超时事件可能落在后续窗口（跨批预扫看不到），先发码再被置 refunded
  // 即「已退款买家免费得码」。抑制行由追平后的 flushAutoDeliverPending 以链上真值复核补交付
  //（仅 Created 且 refundRequested=false）；终局行由后续事件迁移置终态。
  const behind = to < latest;
  if (behind) kvSet(AUTO_FLUSH_KEY, '1');

  // 并行拉取各事件日志，合并后按 (块号, 日志序号) 排序逐个应用
  const logsByName = await Promise.all(
    EVENTS.map((name) => escrow.queryFilter(escrow.filters[name](), from + 1, to))
  );
  const all = [];
  logsByName.forEach((logs, i) => {
    for (const log of logs) {
      all.push({ name: EVENTS[i], block: log.blockNumber, index: log.index, txHash: log.transactionHash, args: log.args });
    }
  });
  all.sort((a, b) => a.block - b.block || a.index - b.index);

  let updated = 0;
  let failed = 0;
  let failedFrom = 0;
  const db = getDb();
  // 审计 P1-2/追赶回放（停机跨区间后批量重扫）时，若同一 orderId 在本批内
  // OrderCreated 之后还跟着退款冻结/退款/仲裁/超时类事件，OrderCreated 分支若立即自动发码，
  // 稍后事件把单置 requested/refunded/expired 就造成「已退款买家免费得码」。预扫描本批：
  // OrderCreated 在前、后随以下任一事件 → 该 OrderCreated 跳过自动交付。
  // 复审补全：RefundRequested（冻结，同批内此前漏检——资金冻结后码已发出、随后 approveRefund
  // 即双损）与 DisputeRequested（争议冻结）一并纳入。
  const TERMINAL_FOLLOW = new Set(['RefundApproved', 'Arbitrated', 'OrderExpiredReleased', 'RefundRequested', 'DisputeRequested']);
  const skipAutoDeliver = new Set(); // orderId → 本批内 OrderCreated 后有冻结/终局事件，跳过其自动交付
  {
    const orderSeq = new Map(); // orderId → { createdIdx: number|null, terminalAfter: boolean }
    all.forEach((ev, idx) => {
      const oid = String(ev.args?.orderId || '').toLowerCase();
      if (!oid) return;
      let rec = orderSeq.get(oid);
      if (!rec) {
        rec = { createdIdx: null, terminalAfter: false };
        orderSeq.set(oid, rec);
      }
      if (ev.name === 'OrderCreated' && rec.createdIdx === null) rec.createdIdx = idx;
      else if (TERMINAL_FOLLOW.has(ev.name) && rec.createdIdx !== null) rec.terminalAfter = true;
    });
    for (const [oid, rec] of orderSeq) if (rec.terminalAfter) skipAutoDeliver.add(oid);
  }
  // feeBps 快照补录触发事件：创建（OrderCreated）为主；结算类事件（确认/超时释放/仲裁判付/
  // 同意退款）是对创建时补录失败（RPC 抖动静默）的二次机会——收款流水净额口径依赖 fee_bps
  // 落库（见 routes/orders.js ledger），sync 路径还会再补（人工兜底）
  const FEE_FILL_EVENTS = new Set(['OrderCreated', 'ReceiptConfirmed', 'OrderExpiredReleased', 'Arbitrated', 'RefundApproved']);

  /*
    链上真值预取（源码审计 2026-09，防「诱饵单」）：此前只有 OrderCreated 分支核对链上参数，
    攻击者可用他人草稿的 orderId 建 1 wei 单再 releaseExpired，把本地未付款 draft 改成 expired
    （占位被释放、事件史写入攻击者 txHash、按 INCOME_STATUS 计入卖家流水）。这里对**本批内
    涉及本地订单的非 OrderCreated 事件**逐个 orderId 取一次 getOrder（买家/卖家/金额自创建起
    不可变 ⇒ 现取现用恒有效），随 meta.chainParams 传入 applyEvent 逐项比对。
    取不到（RPC 失败）时**不阻断整轮**：该 orderId 记为 unverified，其事件在下面按单条失败处理
    （重试 → 隔离），既不会「无法核对就直接落地」，也不会因一个单拖住整窗扫描。
    每个 orderId 至多一次 RPC；本地无此单的偶发事件不打 RPC。
  */
  const paramsById = new Map(); // orderId → { ok:true, buyer, seller, amount } | { ok:false }
  {
    const needIds = new Set();
    for (const ev of all) {
      if (ev.name === 'OrderCreated') continue;
      const oid = String(ev.args?.orderId || '').toLowerCase();
      if (oid) needIds.add(oid);
    }
    for (const oid of needIds) {
      const local = db.prepare('SELECT id FROM orders WHERE escrow_order_id = ?').get(oid);
      if (!local) continue;
      try {
        const p = await fetchOnchainOrder(oid);
        paramsById.set(oid, { ok: true, buyer: p.buyer, seller: p.seller, amount: p.amount });
      } catch (e) {
        paramsById.set(oid, { ok: false });
        console.warn(
          `[escrowWatcher] 链上真值预取失败（orderId=${oid.slice(0, 18)}…）：涉及该单的事件本轮不落地，下轮重试`,
          e?.message || e
        );
      }
    }
  }

  // 失败事件隔离清单（见 MAX_EVENT_RETRIES）：连续失败到上限的事件本轮跳过，
  // 保证游标能越过坏事件继续前进（否则窗口被钉死在某 2000 块区间内，其后事件永不拉取）
  let quarantined = {};
  try {
    quarantined = JSON.parse(kvGet(FAILED_EVENTS_KEY, '') || '{}') || {};
  } catch {
    quarantined = {};
  }
  const fpOf = (ev) => `${ev.block}:${ev.index}:${ev.name}:${String(ev.args?.orderId || '').slice(0, 10)}`;

  for (const ev of all) {
    const fp = fpOf(ev);
    const seen = quarantined[fp];
    if (seen && Number(seen.tries || 0) >= MAX_EVENT_RETRIES) {
      // 已到重试上限：跳过并只每轮告警一次（清单持久化，可在 /healthz 查看；修复根因后清库即可重放）
      console.error(
        `[escrowWatcher] 跳过隔离中的事件（已连续失败 ${seen.tries} 次）: ${ev.name} block=${ev.block} index=${ev.index} orderId=${String(ev.args?.orderId || '').slice(0, 18)}… 原因: ${seen.error || '未知'}`
      );
      continue;
    }
    try {
      const oidOfEv = String(ev.args?.orderId || '').toLowerCase();
      const prefetched = ev.name === 'OrderCreated' ? undefined : paramsById.get(oidOfEv);
      // 本地有此单但链上真值没取到 → 本条事件按失败处理（重试/隔离），绝不无核对落地
      if (prefetched && prefetched.ok === false) {
        throw new Error('链上真值未取到（RPC 读取失败），本轮不落地该事件（防无法核对即推进）');
      }
      const n = applyEvent(ev.name, ev.args, {
        txHash: ev.txHash,
        block: ev.block,
        // 链上真值（买家/卖家/金额）：非 OrderCreated 事件据此拒绝「他人对同一 orderId 的诱饵单」，
        // 见 applyEventCore 头部说明。OrderCreated 自身已用事件字段比对，无需重复传。
        chainParams: prefetched && prefetched.ok ? { buyer: prefetched.buyer, seller: prefetched.seller, amount: prefetched.amount } : undefined,
        // 本批预扫命中 或 未达链头的跨窗回放（behind）→ OrderCreated 抑制自动交付
        skipAutoDeliver: ev.name === 'OrderCreated' && (skipAutoDeliver.has(oidOfEv) || behind),
      });
      updated += n;
      // 成功即从隔离清单摘除（此前失败可能是暂态：RPC 抖动/竞争窗口）
      if (quarantined[fp]) delete quarantined[fp];
      // 订单级 feeBps 快照补录（链上 getOrder 权威；收款净额口径）：
      // 本地行缺快照（fee_bps 为默认 0）时尝试补录（paid 快路径先行迁移时同样覆盖——
      // paid 路由尽力补录可能失败，此处兜底），RPC 失败静默，sync 路径还会再补
      if (n > 0 && FEE_FILL_EVENTS.has(ev.name)) {
        try {
          const row = db
            .prepare('SELECT id, fee_bps, fee_collector_at_create FROM orders WHERE escrow_order_id = ?')
            .get(String(ev.args.orderId).toLowerCase());
          if (row && !row.fee_bps) {
            const o = await escrow.getOrder(String(ev.args.orderId).toLowerCase());
            // 费率与「创建时收取方」快照一并补录（**唯一实现**的取值函数，见 src/fees.js）：
            // 合约按 feeCollectorAtCreate 决定这单扣不扣费，两列必须同时落库——
            // 只补 fee_bps 会让账本退回全局口径（可能与这单的链上事实相反）。
            // fee_collector_at_create 为空串且快照读不到（ABI 未同步/旧节点）时保持空串 = 未知。
            const snap = feeSnapshotOf(o);
            if (snap.feeBps > 0 || snap.feeCollectorAtCreate) {
              db.prepare('UPDATE orders SET fee_bps = ?, fee_collector_at_create = ? WHERE id = ?')
                .run(snap.feeBps, snap.feeCollectorAtCreate, row.id);
            }
          }
        } catch {
          /* RPC 失败静默：后续结算事件/sync 补录 */
        }
      }
    } catch (e) {
      // 单事件应用失败：记录重试次数并继续处理其余事件（防止个别坏事件阻塞整轮）；
      // 本轮结束后游标回退到最早失败块前——下一轮重扫该区间（迁移幂等、不重复记账）。
      // 连续失败达 MAX_EVENT_RETRIES 后转入隔离（下一轮跳过该事件），保证游标仍能前进——
      // 否则坏事件会把扫描窗口永久钉死在 failedFrom + SCAN_LIMIT 内（其后事件永不拉取）。
      // 资金类终局事件（RefundApproved/Arbitrated 等）不允许静默丢失：每轮告警 + 清单持久化
      // + /healthz 暴露，需人工介入（日志/对账；/sync 仍可即时兜底）。
      failed++;
      if (!failedFrom || ev.block < failedFrom) failedFrom = ev.block;
      const prev = quarantined[fp];
      const tries = Number(prev?.tries || 0) + 1;
      quarantined[fp] = {
        tries,
        name: ev.name,
        block: ev.block,
        index: ev.index,
        orderId: String(ev.args?.orderId || ''),
        error: String(e?.message || e).slice(0, 200),
        at: Date.now(),
      };
      console.error(
        `[escrowWatcher] 应用事件失败（第 ${tries}/${MAX_EVENT_RETRIES} 次，本轮回退重扫）: ${ev.name} ${String(ev.args?.orderId || '').slice(0, 18)}…`,
        e.message || e
      );
    }
  }
  // 隔离清单落库（截断到上限，丢最旧；成功事件已在上面摘除）
  {
    const entries = Object.entries(quarantined)
      .sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0))
      .slice(-FAILED_EVENTS_MAX);
    kvSet(FAILED_EVENTS_KEY, JSON.stringify(Object.fromEntries(entries)));
  }
  if (failed > 0 && failedFrom > 0) {
    // 失败事件的确定性重试：游标退回最早失败事件前一块并清除哈希基准，下轮从头应用
    // （此前成功的迁移幂等跳过，失败事件再次尝试）。连续失败到 MAX_EVENT_RETRIES 的事件
    // 下轮被隔离跳过，因此本回退不会把游标永久钉死（见常量说明）。
    kvSet(LAST_BLOCK_KEY, failedFrom - 1);
    kvSet(LAST_HASH_KEY, '');
    watcherStatus.lastError = `本轮 ${failed} 个事件应用失败，游标回退至 ${failedFrom - 1}`;
    console.error(`[escrowWatcher] 本轮 ${failed} 个事件应用失败，游标回退至 ${failedFrom - 1}，下轮重扫（幂等）；持续失败请排查节点日志`);
    return { scanned: { from: from + 1, to }, events: all.length, updated, failed, rewound: true };
  }
  kvSet(LAST_BLOCK_KEY, to);
  // 记录游标块哈希作为下轮重组检测基准（读取失败**清空**基准：源码审计 2026-09——
  // 原实现失败时保留旧值，于是下轮拿「新高度的哈希」与「旧高度的哈希」比对，必然不等
  // → 每轮误判一次重组并回退 64 块重扫，永不收敛。清空 = 跳过一轮比对，不阻断扫描）
  const h = await blockHashOf(to);
  kvSet(LAST_HASH_KEY, h || '');
  Object.assign(watcherStatus, {
    cursor: to,
    latest: head,
    lagBlocks: Math.max(0, head - to),
    upToDate: to >= latest,
    lastScan: { from: from + 1, to, events: all.length, updated, failed },
    lastOkAt: Date.now(),
    lastError: null,
  });
  return { scanned: { from: from + 1, to }, events: all.length, updated, failed };
}

/**
 * 启动轮询（立即执行一次后按 pollIntervalMs 定时）；进程退出不阻塞。
 * 2026-09 复核：busy 互斥防单轮超时导致的扫描堆积（重叠扫描重复打 RPC 且游标竞争）；
 * 单轮超过 pollInterval×4（默认 60s）仍未完成时告警（RPC 无响应/积压信号），不打断在途轮询。
 */
export function startWatcher() {
  let busy = false;
  const tick = async () => {
    if (busy) return; // 上一轮未完成：跳过本轮（不堆积并发扫描）
    busy = true;
    const guard = setTimeout(() => {
      console.error(
        `[escrowWatcher] 单轮轮询超过 ${config.escrow.pollIntervalMs * 4}ms 未完成（RPC 无响应/日志积压？）——请检查 MK_RPC_URL 与公共 RPC 配额；进程继续运行，在途轮询结束后自动恢复节奏`
      );
    }, config.escrow.pollIntervalMs * 4);
    try {
      await pollOnce();
    } catch (e) {
      watcherStatus.lastError = String(e?.shortMessage || e?.message || e);
      watcherStatus.lastPollAt = Date.now();
      console.error('[escrowWatcher] 轮询失败:', e.shortMessage || e.message);
    } finally {
      clearTimeout(guard);
      busy = false;
    }
  };
  tick();
  const timer = setInterval(tick, config.escrow.pollIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
