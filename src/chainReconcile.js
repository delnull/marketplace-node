/**
 * 链上状态对账：把「链上已终局、本地却停在非终态」的订单自动修回来（2026-09）。
 *
 * 为什么需要它：escrowWatcher 只做**正向回放**——它扫日志、把本地状态往前推，但从不回滚、
 * 也不会因为"链上已经终局了而这个单还停在 escrowed"而做任何事。于是只要事件漏扫一次
 * （RPC 抖动、进程停机跨过 SCAN_LIMIT 窗口、起始块配错、事件被隔离清单跳过），这一单就会
 * **永久**停在非终态：买家看到"待发货"，卖家面板上挂着"待处理"，而链上资金早已结清或退回。
 * 手动 /sync 能救，但要有人知道去点它——这正是本模块要补的：后台定时复查滞留单并自动修复。
 *
 * 与其它模块的分工（本模块刻意只做兜底，不抢主路径）：
 *  - 正常收敛由 escrowWatcher 事件回写负责（秒级）；
 *  - 本模块只挑**很久没动过**的非终态单（默认 6 小时；刚变动的单由 watcher/paid 路径处理），
 *    每轮最多 20 单、最旧的先修，且只在 MK_ESCROW_ADDRESS 已配置时运行；
 *  - 候选集比单轮批量大时靠 `node` 上的键集游标轮转复查（见 reconcileChainOnce），
 *    不改动 orders.updated_at——那一列是入账/争议时刻的口径。
 *
 * 单一实现：链上终局 → 本地状态的映射**不在这里重写**，而是复用 watcher 导出的
 * `mapChainTerminal`（快照路径的唯一判据，/sync 手动同步同款）与 `settleByRefundSplit`
 * （RefundApproved/Arbitrated 的同一函数，含 refunded_amount_wei 与占位回补）、
 * `markEscrowDisputed`（DisputeRequested 的同一 SQL），防两处口径漂移；
 * 防"诱饵单"的买家/卖家/金额比对同样复用 `chainOrder.chainParamsMatch`（交付闸与 watcher 也在用）。
 * 事件史用 routes/orders.js 的 `appendSyncMirrorEvent`（与手动 /sync 同一条 `Sync:<状态>` 镜像）。
 *
 * 售后案件（2026-10 第二批）同样走这条纪律：链上真值由 `chainOrder.fetchAfterSaleCase`（与 /sync
 * 同一个读取器）取回，落列由 `afterSale.applyAfterSaleFromChain`（唯一写入口）决定；
 * 本模块只负责"哪些行该复查、不一致时怎么告警"。候选面见 reconcileAfterSaleOnce。
 *
 * ## 表与键（2026-10 MySQL 重设计）
 *
 *  - 整单读走读模型 `v_orders`；状态写 `orders`、链上镜像列写 `order_chain`——
 *    `afterSaleSql.js` 的两个谓词（AFTER_SALE_OPEN_SQL / AFTER_SALE_NOT_OPEN_SQL）**不带别名**，
 *    就是为读模型写的（`NOT_OPEN` 里的 `IS NULL` 分支只在 LEFT JOIN 出的空镜像行上成立）；
 *  - 子表写入与 `appendSyncMirrorEvent` / `restockOrder` 一律用**内部键** `order_id`，
 *    日志、告警 payload 与 `/healthz` 用**对外单号** `order_no`（旧形状里两者同名 `orders.id`，
 *    现在它只指内部键，见 db.js 的 v_orders 说明）；
 *  - 两个轮转游标是 `(updated_at, id)` **键集分页对**（`node.reconcile_at` +
 *    `node.reconcile_order_id`、`node.reconcile_after_sale_at` + `node.reconcile_after_sale_order_id`），
 *    与 `ORDER BY updated_at, id` 同序；**NULL = 从未对账过**（不是 0：0 会被读成"从时间原点开始"，
 *    那是一次全表扫描）。两列一起才是"上次读到哪儿"的完整答案：updated_at 可以相同
 *    （同一毫秒改了两单），只记时间会漏单或重复，只记 id 又用不上时间索引。
 *  - 时间列一律 `Date`（`DATETIME(3)`）：比较阈值传 `Date`，**绝不传毫秒整数**（MySQL 会把数字
 *    当字面量解析成一个与真实时刻无关的时间，而且不报错）。
 *
 * 安全边界（宁可不动，也不乱动）：
 *  - 已终态的行绝不触碰；
 *  - 链上返回 None（查不到该单）而本地 escrowed + 有支付凭证时**不改状态**——那更可能是
 *    节点侧 RPC 读到了错误的链/合约或接口异常，把真金白银的单判成"从未托管"后果不可逆；
 *    只记日志 + 告警店主（order.chain_missing）一次，交人工排查；
 *  - 链上真值与本地锁定的买家/卖家/金额不一致（他人对同一 orderId 的诱饵单）→ 整单跳过。
 *
 * 幂等：修完的行已成终态，不会再被选中；重复运行不重复迁移（状态前置条件守卫）、不重复写
 * 事件史（appendSyncMirrorEvent 自带幂等）；持续状态的告警用 `order_alerts(order_id, kind)`
 * 的主键去重（每单至多一次成功投递，见 alertAck.js）。
 */
import config from './config.js';
import { getDb, withTransaction } from './db.js';
// node 单例行的唯一读入口（游标落在它上面；行由 db.js 的 initDb() 在启动期建立）
import { nodeRow } from './shops.js';
import { fetchOrderFor, fetchAfterSaleCase, chainParamsMatch, orderCreatedMatches } from './chainOrder.js';
import { getEscrow, finalizedBlockTag } from './chain.js';
import {
  settleByRefundSplit,
  markEscrowDisputed,
  mapChainTerminal,
  readRefundedWei,
  isCanonicalEscrowLog,
} from './escrowWatcher.js';
import { appendSyncMirrorEvent, appendOrderCreatedEvent, applyRefundFlags } from './routes/orders.js';
// 售后案件本地镜像的唯一判据层（事件/sync/对账三条路径同源，见 src/afterSale.js）
import { AFTER_SALE_OPEN_SQL, AFTER_SALE_NOT_OPEN_SQL } from './afterSaleSql.js';
import { AFTER_SALE_ELIGIBLE_STATUS, applyAfterSaleFromChain } from './afterSale.js';
// 集合 → SQL IN 片段的唯一拼法（见 src/orderStatus.js）
import { sqlIn } from './orderStatus.js';
import { restockOrder } from './stockHold.js';
import { notifyRaw } from './webhook.js';
import { alertOnceDelivered } from './alertAck.js';

/**
 * 只处理本地仍非终态的订单（链上终局修复的候选面）。
 *
 * 含 `cancelled`（源码审计 2026-09 补齐）：草稿被清扫/取消之后买家才完成支付，是真实存在的
 * 竞态（watcher 靠 OrderCreated 事件把订单救回来）。若那次扫描也漏了，本地行会停在
 * cancelled 而链上那笔钱仍在托管/争议里——终局与冻结两条修复路径都必须能碰到它，
 * 否则这个死角没有任何自动兜底。cancelled 行取消时已释放占位，迁移无占位副作用。
 */
const NON_TERMINAL = ['draft', 'escrowed', 'shipped', 'disputed', 'cancelled'];
/** 静置阈值：updated_at 比这更新说明订单刚动过（watcher/paid 正在处理），不插队 */
const MIN_AGE_MS = 6 * 3600_000;
/** 单轮批量上限（最旧的先修；对账是兜底路径，不追求一轮清空） */
const BATCH_SIZE = 20;

/**
 * 售后案件扫描的单轮批量与候选窗口（见 reconcileAfterSaleOnce）：
 *  - `AFTER_SALE_SCAN_MS` = 360 天 = 合约允许的**最长**售后窗口（`MAX_AFTER_SALE_WINDOW_BLOCKS`，生产默认 180 天）。
 *    取上限而不是默认值：部署方可以把窗口配到 360 天，而"链上有案件"必须能被扫到——用默认值会让
 *    180~360 天那一段的单永远进不了候选面（漏扫就永久分叉）。代价只是候选面更大，靠游标轮转摊平。
 *  - `AFTER_SALE_BATCH` 与主对账同量级（一轮 20 单）：这条路是兜底，不抢主路径的 RPC 配额。
 *  - 游标单独一对列：两条候选面的排序锚点不同（主对账 = updated_at 的非终态行，
 *    本路 = 终局成交单），共用一对会把彼此的位置覆盖掉。
 */
const AFTER_SALE_SCAN_MS = 360 * 24 * 3600_000;
const AFTER_SALE_BATCH = 20;

/**
 * 链上订单读取器（测试注入点，与 netguard.setLookupAll / webhook.setWebhookSender 同款）：
 * 对账的决策与修复逻辑要能在**没有链**的情况下单测（见 test/chain-reconcile.test.js）。
 *
 * 2026-09 复审把它挪进了共享模块 `chainOrder.js`：码池补货后的自动交付补跑也要按链上真值决定
 * 发不发码，两处各留一个注入钩子就是"同一个东西两套实现"。这里继续**再导出**同名函数，
 * 既有测试与调用方无需改动。
 */
export { setChainOrderFetcher } from './chainOrder.js';
/**
 * 售后案件读数的注入点（测试用；与 setChainOrderFetcher 同款、同住 chainOrder.js）。
 * 再导出只为让"对账的售后案件那一路"能像主对账一样**在没有链的情况下**被单测覆盖。
 */
export { setAfterSaleCaseFetcher } from './chainOrder.js';

/* ─────────────────── node 单例行上的两对游标（读写口）─────────────────── */

/** 主对账游标落库（`(null, null)` = 清空：本轮已覆盖到候选集末尾，下轮从头开始） */
async function setReconcileCursor(at, id) {
  await getDb().run(
    'UPDATE node SET reconcile_at = ?, reconcile_order_id = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1',
    at,
    id
  );
}

/** 售后案件对账游标落库（同上，独立一列对） */
async function setAfterSaleCursor(at, id) {
  await getDb().run(
    'UPDATE node SET reconcile_after_sale_at = ?, reconcile_after_sale_order_id = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1',
    at,
    id
  );
}

/**
 * 读一对游标：**两列都在**才算有游标（NULL = 从未对账过）。
 * `at` 从库里出来就是 `Date`（DATETIME(3)）；不是 Date（列被写坏）时按"没有游标"处理——
 * 拿一个畸形值去比 `updated_at > ?` 只会得到空候选集，而"对账什么都没扫"与"候选集本来就空"
 * 在读数上同形，那比重新从最旧的开始扫一遍贵得多。
 */
function cursorOf(row) {
  const at = row?.at;
  const id = row?.id;
  if (!(at instanceof Date) || id === null || id === undefined) return null;
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0 ? { at, id: n } : null;
}

/**
 * 纯决策函数（不触库、不触链；单测直调）：链上状态 + 本地行 → 该做的修复动作。
 * @param {object} local 读模型行（需 status/amount_wei/paid_tx_hash）
 * @param {object} onchain fetchOnchainOrder 形状 {status, refundedAmount, ...}
 * @returns {{action:'none', reason:string, unreadable?:true}
 *          |{action:'repair', to:'disputed'|'settled'|'refunded', refundedAmountWei:string, reason:string}
 *          |{action:'missing', reason:string}}
 *   `unreadable: true` = **不是"已一致"，而是"还不知道"**（链上已退金额读不到 / 终态判不了）：
 *   调用方必须把它说出来（告警），否则静默跳过会被读成"对账覆盖到了这一单"。
 *
 * 映射口径与 watcher 事件一一对应：
 *  - 链上 Disputed            → disputed（对应 DisputeRequested；争议尚未结算，故**不动**
 *    refunded_amount_wei，与 /sync 的 Disputed 分支同口径）
 *  - 链上 Refunded / Settled  → 按退款额拆分（对应 RefundApproved / Arbitrated：全额退 → refunded；
 *    判卖家或仲裁拆分 → settled）。链上状态本身无法区分"买家确认收货 / 超时释放 / 仲裁判卖家"
 *    （三者都是 Settled），故不猜事件名——本地统一落 `settled`
 *    （成交流水口径 INCOME_STATUS 已含它），refunded_amount_wei 以链上真值为准。
 *    本地状态的判定与 /sync 手动同步共用 watcher 的 `mapChainTerminal`（**唯一实现**），
 *    防止"同一笔单走事件回写还是走兜底同步得到两种说法"。
 *  - 链上 None                → 本地 escrowed 且有支付凭证时只告警不改（见文件头安全边界）；
 *    其余（draft 从未上链等）不动。
 *  - 链上 Created             → 本地镜像在途，不动。
 */
export function planChainRepair(local, onchain) {
  if (!local) return { action: 'none', reason: 'no-local-row' };
  const localStatus = String(local.status || '');
  // 终态是既成事实：即便链上仍在途也不回退（本地无反向迁移路径，回退会复活已释放的占位）
  if (!NON_TERMINAL.includes(localStatus)) return { action: 'none', reason: 'local-terminal' };
  if (!onchain) return { action: 'none', reason: 'no-chain-data' };
  const chainStatus = String(onchain.status || 'None');
  const refundedAmountWei = String(onchain.refundedAmount ?? '0');
  /* 判据用它：`'0'` 是"确证为 0"，`undefined` 才是"读不到"——两者不能先被 `?? '0'` 抹平 */
  const refundedRaw = onchain.refundedAmount;
  if (chainStatus === 'Disputed') {
    if (localStatus === 'disputed') return { action: 'none', reason: 'match' };
    return { action: 'repair', to: 'disputed', refundedAmountWei, reason: '链上已进入争议（资金冻结）而本地仍非争议态' };
  }
  if (chainStatus === 'Refunded' || chainStatus === 'Settled') {
    // 本地应有状态由**唯一实现** mapChainTerminal 决定（与 /sync 手动同步、与事件路径同判据）：
    // 全额退 → refunded；否则（含 refundedAmount=0 = 全额判卖家、部分退款/拆分裁决）→ settled。
    // 部分金额有两条链上来源：仲裁人 voteSettlement 票决（任意比例，无需买家授权）与
    // approveRefund == acceptedPartialRefund[orderId]（**买家精确授权过**的部分退款；
    // 2026-09 契约：其它金额一律 RefundAmountNotAccepted，旧的 RefundNotFull 已删除），
    // 所以本节里"部分金额"既可能来自裁决、也可能来自双方谈拢后的卖家执行。
    //
    // **退款额只认读得到的值**（2026-10 生产化清理）：脏字段此前按 0 处理，于是"不知道"被写成
    // "全额判卖家"，还把 refunded_amount_wei 一起改成 0——账目不可逆地记反，且事后两边同错。
    // 现在读不到就**这一轮不修**（reason 里写明，下一轮重试），绝不拿一个 0 去补。
    const refundedWei = readRefundedWei(refundedRaw);
    if (refundedWei === null) {
      return { action: 'none', unreadable: true, reason: `链上已退金额读不到（refundedAmount=${String(refundedRaw)}）：不推进终态，等下一轮` };
    }
    const to = mapChainTerminal(chainStatus, refundedWei, local.amount_wei);
    if (to === null) {
      return { action: 'none', unreadable: true, reason: '链上终态判不了（状态与金额都不足以判定）：不推进终态，等下一轮' };
    }
    if (localStatus === to) return { action: 'none', reason: 'match' };
    return {
      action: 'repair',
      to,
      refundedAmountWei: refundedWei.toString(),
      reason: chainStatus === 'Refunded' ? '链上已退款而本地仍在途' : '链上资金已结算给卖家而本地仍在途',
    };
  }
  if (chainStatus === 'None') {
    // 链上查不到：本地 escrowed + 有支付凭证 = 最可疑的组合（钱可能真在链上）——
    // 不改状态、不释放占位，只告警人工核实（可能只是 RPC 读到了别的链/合约）
    if (localStatus === 'escrowed' && local.paid_tx_hash) {
      return { action: 'missing', reason: '链上查不到该托管单，但本地有支付凭证（疑似 RPC/节点侧异常，需人工核实）' };
    }
    return { action: 'none', reason: 'chain-none' };
  }
  /*
    链上 Created（钱真在托管里）而本地却停在 draft/cancelled —— **必须修回来**
    （源码审计 2026-09 复审，P1）。

    这一类是"付款已上链、`OrderCreated` 漏扫"的残镜像：漏扫之后草稿 TTL 清扫器
    （或买家手动 /cancel）把行置成 cancelled，而 cancelled 行的 `paid_tx_hash` 按规矩必为空
    （取消路径不允许带凭证取消），所以连 `order.chain_missing`（要求有凭证）都进不去。
    旧实现在这里统一 `action:'none'`，于是这一单**没有任何自动路径能救**：
      · 买家资金锁在托管里最长一个超时窗口（默认约 7 天），页面却显示"已取消"；
      · 占位已被释放 ⇒ 同一件限量商品可以再卖给别人（超卖）；
      · 店主面板根本没有这张单；
      · 零告警；超时释放后本地落 `expired`，而 `expired ∈ INCOME_STATUS` ——
        等于为一笔"已取消"的账记进卖家流水。
    修回来与 watcher 的"恢复已取消订单"（escrowWatcher 的 OrderCreated/cancelled 分支）
    是同一个形状：补占位 → 置 escrowed → 由后续事件/对账继续推进。
  */
  if (chainStatus === 'Created' && (localStatus === 'draft' || localStatus === 'cancelled')) {
    return {
      action: 'restore',
      reason: '链上资金仍在托管而本地停在未托管态（OrderCreated 漏扫后被清扫/取消的残镜像）',
    };
  }
  return { action: 'none', reason: `chain-${chainStatus}` };
}

/**
 * 退款冻结标记回填（**仅供本模块内部使用**）：只在链上确实带回了这两个字段时调用。
 * `applyRefundFlags` 的语义是"两个标记都没有 ⇒ 把本地残留清回 none"，所以拿一个
 * **缺字段**的读数去调它等于"断言链上从未申请过退款"——那会把一条真实的冻结标记抹掉。
 * 生产路径（chain.js 的 fetchOnchainOrder）恒带这两项；这里加门禁是为了防测试桩/未来实现漏字段。
 */
async function applyRefundFlagsIfKnown(orderIdHex, onchain) {
  if (!onchain) return 0;
  if (onchain.refundRequested === undefined && onchain.refundRejected === undefined) return 0;
  return await applyRefundFlags(orderIdHex, onchain);
}

/**
 * 持续状态的一次性告警（`order_alerts` 主键去重；**投递成功后才留下标记**，见 alertAck.js）。
 * `alertOnceDelivered` 是 async（预占与释放都碰库）：不 await 的话它抛出的错会变成
 * unhandled rejection，而调用方以为"已经告过警了"——这里一律 await。
 *
 * 只有 `chain_missing` 走它：`order_alerts.kind` 的 ENUM 只收三类**持续状态**
 * （pool_empty / chain_missing / hold_missing），而"已按链上真值修好某单"是一次性通知——
 * 它天然不会重复（修完之后那一行不再是候选，条件不再成立），所以下面两处修复告警直接
 * `notifyRaw`（旧形状给它们各配了一个 kv 标记，而那种标记在新 schema 里没有家，也不需要）。
 */
async function alertChainMissingOnce(order, data) {
  return await alertOnceDelivered({
    orderId: order.order_id,
    kind: 'chain_missing',
    label: '[chainReconcile]',
    what: `（order.chain_missing，order=${String(order.order_no).slice(0, 8)}…）`,
    // ⚠️ `shopCode` 必填：`webhook.deliver()` 按 `payload.shopCode` 查 `shop_webhook`（一行一店）；
    // 缺了它投递会一次都不发就 resolve(false)，而日志写"未配置通知地址"（误导）。
    send: () => notifyRaw('order.chain_missing', { ...data, shopCode: order.shop_code }),
  });
}

/**
 * 修复单个滞留订单（决策 + 落库 + 事件史 + 告警）。
 * 状态迁移与事件史同事务（与 watcher/sync 同原子形态：防进程中断后"状态变了但没人知道为什么"）。
 * @param {object} row 读模型行（`v_orders`）：需 order_id / order_no / status / escrow_order_id /
 *        paid_tx_hash / buyer / seller / amount_wei
 * @returns {Promise<'repaired'|'missing'|'none'|'skipped'>}（异常向上抛，由轮询逐行兜住）
 */
export async function reconcileOrder(row, { blockTag = 'latest' } = {}) {
  const db = getDb();
  let onchain;
  try {
    onchain = await fetchOrderFor(row.escrow_order_id, { blockTag });
  } catch (e) {
    // RPC 读取失败**不是**"链上没有"：本轮跳过，下一轮再试（绝不据此改状态）
    console.warn(
      `[chainReconcile] 链上状态读取失败（order=${String(row.order_no).slice(0, 8)}…）：本轮跳过，下轮重试`,
      e?.message || e
    );
    return 'skipped';
  }
  // 防"诱饵单"（与 watcher/sync 同规则）：草稿的 orderId 对拿到详情链接的人可见，链上真值的
  // 买家/卖家/金额/验货窗口必须与本行锁定值一致；不一致说明这是别人对同一 orderId 的单
  // （含同一卖家在另一个节点下的店），不能据它改本地状态。
  // 传**整份链上读数**而不是手挑的四个字段：`chainParamsMatch` 的身份判据以后再加一项时，
  // 手挑对象的调用点会静默漏掉它。
  if (onchain && onchain.status && onchain.status !== 'None') {
    if (!chainParamsMatch(row, onchain)) {
      console.warn(
        `[chainReconcile] 跳过与链上真值不符的订单（order=${String(row.order_no).slice(0, 8)}…）：买家/卖家/金额/验货窗口与本地锁定不一致（疑似诱饵单）`
      );
      return 'skipped';
    }
  }
  const plan = planChainRepair(row, onchain);
  if (plan.action === 'none') {
    /* "这一轮不修"里有一类必须**说出来**：链上金额读不到 / 终态判不了（unreadable）。
       它不是"已一致"，静默跳过会让运维以为这一单被对账覆盖过了。 */
    if (plan.unreadable) {
      console.warn(`[chainReconcile] 订单 ${String(row.order_no).slice(0, 8)}… 本轮无法判定终态：${plan.reason}`);
    }
    return 'none';
  }
  if (plan.action === 'missing') {
    console.warn(
      `[chainReconcile] 订单 ${String(row.order_no).slice(0, 8)}… 本地为 ${row.status} 且有支付凭证，链上却查不到该托管单——保留本地状态待人工核实（escrow=${String(row.escrow_order_id).slice(0, 18)}…）`
    );
    await alertChainMissingOnce(row, {
      orderId: row.order_no,
      escrowOrderId: row.escrow_order_id || null,
      reason: plan.reason,
    });
    return 'missing';
  }
  /*
    补落支付凭证要的那次链上读（单块反查 OrderCreated 日志）**必须在事务之前**完成。

    为什么：事务期间持有**行锁**（MySQL 里锁不是随连接走的，而是随事务到提交为止），
    把 `await escrow.queryFilter(...)` 放进事务区段，就是让这几行在被锁住的同时等一次网络往返——
    一次 RPC 抖动（默认重试 + 超时可达十几秒）会让**同一批行**上的所有写全部堵在那儿。
    这是全仓唯一一处曾经把 RPC 放进事务的地方，2026-10 迁移时按同一条纪律搬了出来。
    代价（如实写）：`restore` 分支的每一单都会先花掉一次只读 RPC，而其中一部分最终并不会恢复
    （状态已被 watcher/别的路径改掉 ⇒ `restored = 0`）。这是刻意的方向：宁可多一次只读调用，
    也不能把网络 I/O 放进持有行锁的区段。读失败只告警、不阻断恢复——凭证由下一次 /sync 或
    watcher 重扫补上（凭证是发货闸的判据，缺它只是"暂时发不了货"，而状态不恢复是钱在链上、
    本地却显示已取消）。
  */
  let paidTxHash = null;
  if (plan.action === 'restore' && onchain?.createdAtBlock) {
    try {
      const escrow = getEscrow();
      const logs = await escrow.queryFilter(
        escrow.filters.OrderCreated(row.escrow_order_id),
        onchain.createdAtBlock,
        onchain.createdAtBlock
      );
      /*
        `queryFilter` 的 address 过滤是 RPC 的承诺，不是返回值的性质：与 /paid、/sync 同一判据，
        只把**真的由本托管合约发出、且字段属于本单**的 OrderCreated 当作支付凭证。
        归属核对（orderCreatedMatches：orderId/buyer/seller/amount/host）不能省：只按地址过滤时，
        同一卖家在另一个节点下的店可以用同一 orderId 建单，它的 txHash 会被写成本单的支付凭证
        （2026-10-22 复审）。`orderCreatedMatches` 缺字段一律 false（凭证动作，读不到就不落库）。
      */
      const canonical = logs.filter(
        (l) => isCanonicalEscrowLog(l, config.chain.escrowAddress) && orderCreatedMatches(row, l.args, row.escrow_order_id, onchain.token)
      );
      if (canonical.length) paidTxHash = String(canonical[0].transactionHash).toLowerCase();
    } catch (e) {
      console.warn(
        `[chainReconcile] 恢复订单 ${String(row.order_no).slice(0, 8)}… 前补落支付凭证的链上读失败（不阻断恢复，下次 /sync 可补）：`,
        e?.message || e
      );
    }
  }
  let changed = 0;
  await withTransaction(async () => {
    if (plan.action === 'restore') {
      /*
        链上 Created + 本地 draft/cancelled：补回占位并置 escrowed（与 watcher 的
        「恢复已取消订单」同一形状）。占位恢复失败（= 取消期间限量库存已被别人买走）不改结果：
        链上资金真实存在，订单必须恢复，差额交店主人工核账扩容——所以只告警不中断。
        补 paid_tx_hash：取消路径不允许带凭证取消，所以凭证由上面那次**事务外**的链上读带回；
        读不到就先空着（宁可空着，也不写一个假凭证）。
      */
      if (plan.to !== undefined) throw new Error('restore 分支不应带 to');
      const restored = (await db.run(
        "UPDATE orders SET status = 'escrowed', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status IN ('draft','cancelled')",
        row.order_id
      )).changes;
      if (restored > 0) {
        if (!(await restockOrder(row.order_id))) {
          console.error(
            `[chainReconcile] 恢复订单 ${String(row.order_no).slice(0, 8)}… 的库存占位失败（限量库存不足），请店主核账扩容`
          );
          await alertOnceDelivered({
            orderId: row.order_id,
            kind: 'hold_missing',
            label: '[chainReconcile]',
            what: `（order.hold_missing，order=${String(row.order_no).slice(0, 8)}…，对账恢复时占位失败）`,
            send: () =>
              notifyRaw('order.hold_missing', {
                shopCode: row.shop_code,
                orderId: row.order_no,
                escrowOrderId: row.escrow_order_id || null,
                reason: '对账恢复订单时占位失败（取消期间限量库存已被他人买走）——请核对该商品余量并扩容或退款处理',
              }),
          });
        }
        await appendSyncMirrorEvent(row.order_id, 'escrowed', { block: onchain?.createdAtBlock || null });
        changed = restored;
        /*
          补落支付凭证：发货路径要求"有链上支付凭证"（空哈希拒发），所以恢复出来的单必须拿到哈希，
          否则店主看着一张 `escrowed` 却发不了货。哈希来自**事务之前**那次单块反查（见上），
          这里只做写入；条件 `paid_tx_hash IS NULL` 保证与 /sync、watcher 抢同一条记录时只写一次
          （凭证列住在 `order_chain`，状态刚刚在同一事务里置成了 escrowed，所以不必再判状态）。
        */
        if (paidTxHash) {
          const wrote = (await db.run(
            'UPDATE order_chain SET paid_tx_hash = ? WHERE order_id = ? AND paid_tx_hash IS NULL',
            paidTxHash,
            row.order_id
          )).changes;
          if (wrote === 1) await appendOrderCreatedEvent(row.order_id, { txHash: paidTxHash, block: onchain.createdAtBlock });
        }
        /*
          退款冻结闸：链上 Created 态还要把 refundRequested/refundRejected 回填到本地镜像
          （源码审计 2026-09 复审，P1）。`fetchOnchainOrder` 每次都取回这两个字段，
          而此前全文只用 refundedAmount——漏扫 RefundRequested 时本地 refund_status 永久停在
          'none'，而它是多个资金闸的判据（能否超时释放、能否发货、能否同意退款）：
          店主看不到"买家已在链上冻结本单"，照常发货后同意退款 = 钱货两空。
          applyRefundFlags 是 /sync 用的同一实现（唯一实现）。
        */
        await applyRefundFlagsIfKnown(row.escrow_order_id, onchain);
      }
    } else if (plan.to === 'disputed') {
      // 争议态同样要把退款冻结标记回填（链上 Disputed 之前必然经过 requestRefund/rejectRefund）
      changed = await markEscrowDisputed(db, row.escrow_order_id);
      if (changed > 0) await applyRefundFlagsIfKnown(row.escrow_order_id, onchain);
    } else {
      // 终局映射复用 watcher 的实现（唯一实现）：拆分结算走 settleByRefundSplit（内含
      // 状态、refunded_amount_wei 与占位回补，两列分住 orders/order_chain，见那里的说明）
      changed = await settleByRefundSplit(db, row.escrow_order_id, plan.refundedAmountWei);
    }
    if (changed > 0 && plan.action !== 'restore') {
      // `Sync:<状态>` 镜像（与 /sync 同一条）：UI 时间线上能看出"这一步不是链上事件推的，
      // 而是节点对账改的"，并附上链上创建块（getOrder 无事件块号，与 /sync 同款降级）
      await appendSyncMirrorEvent(row.order_id, plan.to, { block: onchain?.createdAtBlock || null });
    }
  });
  if (changed === 0) return 'none'; // 状态已被 watcher/其它路径修好（竞态）：无事可做
  const toLabel = plan.action === 'restore' ? 'escrowed' : plan.to;
  console.warn(
    `[chainReconcile] 修复滞留订单 ${String(row.order_no).slice(0, 8)}…：${row.status} → ${toLabel}（${plan.reason}）`
  );
  /*
    修复本身**不需要去重行**（见 alertChainMissingOnce 的说明）：修完之后这一行不再是候选，
    同一条通知不会再产生。代价如实写：投递失败就是这一次通知丢了（状态已经修好，
    没有"下一轮重试"的载体）——与旧形状一致（旧形状的 kv 标记同样只在投递成功后写，
    而那时行也已不再是候选）。要它可重试就得给 `order_alerts.kind` 加取值，
    而那会把"持续状态的待办"与"一次性回执"混进同一张表。
  */
  await notifyRaw('order.chain_repaired', {
      shopCode: row.shop_code,
    orderId: row.order_no,
    escrowOrderId: row.escrow_order_id || null,
    from: row.status,
    to: toLabel,
    refundedAmountWei: plan.refundedAmountWei,
    reason: plan.reason,
  });
  return 'repaired';
}

/**
 * 售后案件（确认收货后开的案）的对账复查——本模块的**第二路**候选，与上面那条候选面并列。
 *
 * 为什么必须单独一路：主对账的候选是"**非终态**订单"（`NON_TERMINAL`，靠链上终局把它们推平），
 * 而售后案件按定义只存在于**终局**单上（链上要求 Settled + buyerConfirmed + refundedAmount == 0；
 * 本地候选面是 confirmed/settled/expired 的**超集**，最终由链上 afterSaleOpen 回答，见 afterSale.js）。
 * 主对账永远碰不到它们，于是事件漏扫时会出现两种静默分叉：
 *   · 链上有案件、本地 `none` ⇒ 仲裁台队列看不见这一单、售后陈述被门控拒掉、退货单建不了
 *     （买家的救济路径整条失效，且没有任何告警）；
 *   · 链上已结案、本地 `open` ⇒ 队列永远挂着幽灵待办，店主以为随时可能被罚没。
 * 人工 `POST /:id/sync` 能即时救急，但没人知道要去点它——这一路就是那个自动兜底。
 *
 * 两段候选：
 *  ① **在途案件复核**（本地 open 且未结案）：读链上 afterSaleOpen 复核，链上已结则本地结案
 *     （note 为 null——链上只读视图没有结案说明，说明只存在于 AfterSaleClosed 事件里，如实留空）。
 *     这一段总是很小（= 在途案件数），每轮全查也不贵。
 *  ② **漏扫开案扫描**（本地非 open 的**终局成交单**）：读链上 afterSaleOpen，为真则本地补开案。
 *     这一段没有本地谓词能"预知"哪一单被开了案（那正是漏扫的含义），只能用"链上可能的载体"
 *     当候选面并按**游标轮转**复查（与主对账同款：一轮取不满即回绕，保证没有单被永久跳过）。
 *
 * 成本（如实写明，这是本路径的已知代价）：候选面 = 静置在 `AFTER_SALE_SCAN_MS`（= 合约允许的
 * 最长窗口 360 天）内的终局成交单，每单一次 RPC 读取，单轮上限 `AFTER_SALE_BATCH` 单。
 * 单店量级下每轮 10 分钟 20 单，几天滚完一遍窗口内历史；量特别大时它只是"慢"，不会拖垮进程
 * （每轮 RPC 次数封顶），而且**永远不影响**正常收敛（正常收敛由 watcher 事件负责，秒级）。
 *
 * 安全边界与主对账一致：链上真值与本地锁定的买家/卖家/金额不一致（他人对同一 orderId 的诱饵单）
 * ⇒ 整单跳过；RPC 读不到 ⇒ 跳过本轮（绝不据此改状态）。
 *
 * @param {{now?:number, batch?:number}} opts
 * @returns {Promise<{scanned:number, repaired:number, skippedRows:number, failed:number}>}
 */
export async function reconcileAfterSaleOnce({ now = Date.now(), batch = AFTER_SALE_BATCH, blockTag = 'latest' } = {}) {
  if (!config.chain.escrowAddress) return { scanned: 0, repaired: 0, skippedRows: 0, failed: 0 };
  const db = getDb();
  let scanned = 0;
  let repaired = 0;
  let skippedRows = 0;
  let failed = 0;

  /** 单行复查：读链上真值 → 与本地比 → 需要就落库（判据/写入口都在 src/afterSale.js） */
  const checkRow = async (row) => {
    let truth;
    try {
      truth = await fetchAfterSaleCase(row.escrow_order_id, { blockTag });
    } catch (e) {
      // 读不到**不是**"没有案件"：本轮跳过，下一轮再试（与主对账同口径，绝不据此改状态）
      console.warn(
        `[chainReconcile] 售后案件链上读取失败（order=${String(row.order_no).slice(0, 8)}…）：本轮跳过，下轮重试`,
        e?.message || e
      );
      skippedRows += 1;
      return;
    }
    /*
      链上查不到该托管单（status='None'）时整行跳过：这更可能是 RPC 指错链/合约或接口异常，
      而不是"案件不存在"——据它把本地 open 关掉，就等于用一个读不到的事实抹掉一条真实案件
      （与主对账对"链上 None"的安全边界同款：宁可不动，交人工排查）。
    */
    if (String(truth.status || 'None') === 'None') {
      console.warn(
        `[chainReconcile] 售后案件跳过：链上查不到该托管单（order=${String(row.order_no).slice(0, 8)}…）——疑似 RPC/合约配置异常，需人工核实`
      );
      skippedRows += 1;
      return;
    }
    const localOpen = String(row.after_sale_status) === 'open';
    // 只在"链上已结案而本地仍 open"或"链上有案件而本地非 open"两种分歧下动手；
    // 一致（都开/都没开）时不写库——避免每轮复查都把行改一遍（噪音写 + 无意义的告警）
    if (!!truth.open === localOpen) return;
    /*
      防诱饵单：比对照旧要本行的 buyer/seller/amount_wei（它们在 orders 上），
      所以按内部键补读一次——候选查询是从读模型取的，能直接带上就带上（见下面的 SELECT）。
    */
    if (!chainParamsMatch(row, truth)) {
      console.warn(
        `[chainReconcile] 跳过与链上真值不符的售后案件（order=${String(row.order_no).slice(0, 8)}…）：买家/卖家/金额与本地锁定不一致（疑似诱饵单）`
      );
      skippedRows += 1;
      return;
    }
    let changed = 0;
    await withTransaction(async () => {
      changed = (await applyAfterSaleFromChain(row.escrow_order_id, truth)).changed;
      if (changed > 0) {
        // 与 /sync 同一条镜像形状：UI 时间线上能看出"这一步不是链上事件推的，而是节点对账改的"
        await appendSyncMirrorEvent(row.order_id, truth.open ? 'after_sale_open' : 'after_sale_close', {
          block: truth.openedAtBlock || null,
        });
      }
    });
    if (changed === 0) return;
    repaired += 1;
    console.warn(
      `[chainReconcile] 售后案件对账回填 ${String(row.order_no).slice(0, 8)}…：after_sale ${row.after_sale_status} → ${truth.open ? 'open' : 'closed'}（事件漏扫兜底）`
    );
    // 同上：一次性回执，不需要去重行（`order_alerts.kind` 也没有它的取值）
    await notifyRaw('order.after_sale_repaired', {
      shopCode: row.shop_code,
      orderId: row.order_no,
      escrowOrderId: row.escrow_order_id || null,
      afterSale: truth.open ? 'open' : 'closed',
      afterSaleOpenedBlock: truth.openedAtBlock || null,
      reason: '链上售后案件状态与本地镜像不一致（事件漏扫），已按链上真值回填',
    });
  };

  // ① 在途案件复核（最旧的先查：等待最久的案件最可能因停机漏掉了结案事件）
  const openRows = await db.all(`SELECT o.order_id, o.order_no, o.status, o.escrow_order_id, o.after_sale_status,
              o.after_sale_opened_at, o.buyer, o.seller, o.shop_code, o.amount_wei, o.payment_token
         FROM v_orders o WHERE ${AFTER_SALE_OPEN_SQL} AND o.escrow_order_id IS NOT NULL
        ORDER BY o.after_sale_opened_at ASC LIMIT ?`, batch);
  for (const row of openRows) {
    scanned += 1;
    try {
      await checkRow(row);
    } catch (e) {
      failed += 1;
      console.error(`[chainReconcile] 售后案件复查异常（order=${String(row.order_no).slice(0, 8)}…，下轮重试）:`, e?.message || e);
    }
  }

  // ② 漏扫开案扫描（终局成交单 + 游标轮转；见上方成本说明）
  const cutoff = new Date(now - AFTER_SALE_SCAN_MS);
  const node = await nodeRow();
  if (!node) throw new Error('chainReconcile: node 单例行（id=1）不存在——对账游标没有地方记账（行由 db.js 的 initDb() 建立）');
  const cursor = cursorOf({ at: node.reconcile_after_sale_at, id: node.reconcile_after_sale_order_id });
  /*
    候选读走读模型：`AFTER_SALE_ELIGIBLE_STATUS` 与两个谓词常量都**不带别名**，正是为它写的
    （`AFTER_SALE_NOT_OPEN_SQL` 里的 `IS NULL` 分支只在 LEFT JOIN 出的空镜像行上成立）。
    `o.order_id` 既是对账要用的内部键，也是下面回写进子表/事件史的那个键。
  */
  const pick = async (cur, limit) => {
    const after = cur ? ' AND (o.updated_at > ? OR (o.updated_at = ? AND o.order_id > ?))' : '';
    const tail = cur ? [cur.at, cur.at, cur.id] : [];
    return await db.all(`SELECT o.order_id, o.order_no, o.status, o.escrow_order_id, o.after_sale_status,
              o.after_sale_opened_at, o.buyer, o.seller, o.shop_code, o.amount_wei, o.payment_token, o.updated_at
           FROM v_orders o
          WHERE o.status IN ${sqlIn(AFTER_SALE_ELIGIBLE_STATUS)}
            AND o.escrow_order_id IS NOT NULL
            AND ${AFTER_SALE_NOT_OPEN_SQL}
            AND o.updated_at >= ?${after}
          ORDER BY o.updated_at ASC, o.order_id ASC LIMIT ?`, cutoff, ...tail, limit);
  };
  let rows = await pick(cursor, batch);
  let wrapped = false;
  if (!rows.length && cursor) {
    wrapped = true;
    rows = await pick(null, batch); // 游标已到候选集末尾：回绕到开头（与主对账同款）
  }
  if (rows.length && (rows.length < batch || wrapped)) {
    // 取不满一批（或刚回绕过）⇒ 本轮已覆盖到候选集末尾：清空游标，下轮从最旧的开始
    await setAfterSaleCursor(null, null);
  } else if (rows.length) {
    const last = rows[rows.length - 1];
    await setAfterSaleCursor(last.updated_at, last.order_id);
  }
  for (const row of rows) {
    scanned += 1;
    try {
      await checkRow(row);
    } catch (e) {
      failed += 1;
      console.error(`[chainReconcile] 售后案件扫描异常（order=${String(row.order_no).slice(0, 8)}…，下轮重试）:`, e?.message || e);
    }
  }
  return { scanned, repaired, skippedRows, failed };
}

/**
 * 执行一轮对账（无链上配置时跳过）。可按参数覆盖阈值/批量（测试与运维脚本用）。
 * 两条候选面共用本入口：主对账（非终态滞留单）+ 售后案件（终局单上的在途案件，见
 * reconcileAfterSaleOnce 的说明）；返回值里的 afterSale* 字段是后者的读数。
 * @param {{now?:number, minAgeMs?:number, batch?:number}} opts
 * @returns {Promise<{skipped?:boolean, reason?:string, scanned?:number, repaired?:number,
 *                    missing?:number, skippedRows?:number, failed?:number,
 *                    afterSaleScanned?:number, afterSaleRepaired?:number}>}
 */
export async function reconcileChainOnce({ now = Date.now(), minAgeMs = MIN_AGE_MS, batch = BATCH_SIZE } = {}) {
  if (!config.chain.escrowAddress) {
    return { skipped: true, reason: 'MK_ESCROW_ADDRESS 未配置' };
  }
  /*
    终态只能从**确认过的区块**读：watcher 等 head−finality，对账不能读 latest 就写 settled/refunded。
    确定不了确认边界时整轮跳过（下轮重试），不退回 latest。
  */
  let blockTag;
  try {
    blockTag = await finalizedBlockTag();
  } catch (e) {
    return { skipped: true, reason: `确认边界读取失败：${e?.message || e}` };
  }
  const db = getDb();
  const cutoff = new Date(now - minAgeMs);
  const marks = NON_TERMINAL.map(() => '?').join(',');
  /*
    候选：本地非终态 + 有链上单号 + 静置超过阈值（刚动过的单由 watcher/paid 主路径处理），
    按 (updated_at, id) 升序 —— 滞留最久的先复查。
    游标存在 `node` 单行上（**不在 orders 表里**）：候选集里**总会**有一批"正常但在途"的单
    （例如买家迟迟不确认收货、等链上超时释放，几天都停在 escrowed）。若每轮都从最旧的一批
    重新取 LIMIT batch，这批行会永远占满批量，后面的滞留单永远复查不到（对账等于失效）。
    也不能拿 orders.updated_at 当轮转锚点：那一列是**入账时刻**（收款流水/看板/CSV 导出按它归属）
    与争议起始时刻（仲裁列表 disputedAt）的口径，为了轮转去改它等于篡改账目时间。
    故游标单独存，只表示"上一轮复查到哪儿"；一轮取不满一批说明已到候选集末尾 → 下轮回绕到开头，
    保证没有订单被永久跳过。
    候选读走读模型 `v_orders`：`escrow_order_id` / `paid_tx_hash` 住在 `order_chain`（链上镜像，
    watcher 独占写），buyer/seller/amount_wei 仍在 `orders` 上——视图一次给全。
  */
  const node = await nodeRow();
  if (!node) throw new Error('chainReconcile: node 单例行（id=1）不存在——对账游标没有地方记账（行由 db.js 的 initDb() 建立）');
  const cursor = cursorOf({ at: node.reconcile_at, id: node.reconcile_order_id });
  const pick = async (cur, limit) => {
    const after = cur ? ' AND (o.updated_at > ? OR (o.updated_at = ? AND o.order_id > ?))' : '';
    const tail = cur ? [cur.at, cur.at, cur.id] : [];
    return await db.all(`SELECT o.order_id, o.order_no, o.status, o.escrow_order_id, o.paid_tx_hash,
              o.buyer, o.seller, o.shop_code, o.amount_wei, o.payment_token, o.updated_at
           FROM v_orders o
          WHERE o.status IN (${marks}) AND o.escrow_order_id IS NOT NULL AND o.updated_at <= ?${after}
          ORDER BY o.updated_at ASC, o.order_id ASC LIMIT ?`, ...NON_TERMINAL, cutoff, ...tail, limit);
  };
  let rows = await pick(cursor, batch);
  let wrapped = false;
  if (!rows.length && cursor) {
    // 游标已到候选集末尾：回绕到开头（本轮从头复查，下一轮继续往后推进）
    wrapped = true;
    rows = await pick(null, batch);
  }
  if (rows.length && (rows.length < batch || wrapped)) {
    // 取不满一批（或刚回绕过）⇒ 本轮已覆盖到候选集末尾：清空游标，下轮从最旧的开始
    await setReconcileCursor(null, null);
  } else if (rows.length) {
    const last = rows[rows.length - 1];
    await setReconcileCursor(last.updated_at, last.order_id);
  }
  let repaired = 0;
  let missing = 0;
  let skippedRows = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const r = await reconcileOrder(row, { blockTag });
      if (r === 'repaired') repaired += 1;
      else if (r === 'missing') missing += 1;
      else if (r === 'skipped') skippedRows += 1;
    } catch (e) {
      // 单行异常不打断整轮（其余滞留单仍应被修复）；游标已越过该行，下轮/回绕后重试（修复幂等）
      failed += 1;
      console.error(`[chainReconcile] 订单 ${String(row.order_no).slice(0, 8)}… 对账异常（下轮重试）:`, e?.message || e);
    }
  }
  if (rows.length && (repaired || missing || failed)) {
    console.log(
      `[chainReconcile] 本轮复查 ${rows.length} 单：修复 ${repaired}、链上缺失告警 ${missing}、跳过 ${skippedRows}、异常 ${failed}`
    );
  }
  /*
    售后案件那一路（终局单上的在途案件，见 reconcileAfterSaleOnce）：候选面与上面完全不同，
    所以是**并列的一路**而不是塞进同一个循环。它自己不抛错（逐行包了 try/catch），
    这里再包一层只为"这条路整体出问题也不能让主对账的结果丢掉"。
  */
  let afterSale = { scanned: 0, repaired: 0, skippedRows: 0, failed: 0 };
  try {
    afterSale = await reconcileAfterSaleOnce({ now, batch, blockTag });
  } catch (e) {
    console.error('[chainReconcile] 售后案件对账整体异常（下轮重试）:', e?.message || e);
  }
  return {
    scanned: rows.length,
    repaired,
    missing,
    skippedRows,
    failed,
    afterSaleScanned: afterSale.scanned,
    afterSaleRepaired: afterSale.repaired,
  };
}

/**
 * 对账任务运行状态（在 /healthz 暴露，与 watcher/pii 同款）：本对账是「事件漏扫 / 短重组 /
 * 节点停机」的自动兜底，静默失效等于镜像永久错位而无人知晓——日志在容器里最容易丢，
 * 所以把最近一轮的结果摆到 /healthz 上。
 */
const reconcileStatus = {
  enabled: false,
  intervalMs: 0,
  lastRunAt: null,
  lastOkAt: null,
  lastError: null,
  lastScanned: 0,
  lastRepaired: 0,
  lastMissing: 0,
  lastFailed: 0,
  // 售后案件那一路的读数（终局单上的在途案件；静默失效同样等于镜像永久分叉）
  lastAfterSaleScanned: 0,
  lastAfterSaleRepaired: 0,
};

/** 只读快照（/healthz 用） */
export function chainReconcileStatus() {
  return {
    ...reconcileStatus,
    minAgeMs: MIN_AGE_MS,
    batch: BATCH_SIZE,
    /** 静置多久算「可能漏扫」（小时）——展示用，避免运维心算 */
    minAgeHours: Math.round(MIN_AGE_MS / 3_600_000),
    /*
      售后案件那一路的扫描窗口与批量（见 reconcileAfterSaleOnce）：运维要能一眼看出
      "这条兜底到底扫多大范围"——窗口取合约允许的最长售后窗口，所以它是天级的慢兜底，
      而不是秒级的实时修复（实时由 watcher 事件负责）。
    */
    afterSaleScanDays: Math.round(AFTER_SALE_SCAN_MS / 86_400_000),
    afterSaleBatch: AFTER_SALE_BATCH,
  };
}

/**
 * 启动周期对账（server 入口调用；MK_ESCROW_ADDRESS 未配置时不启动——没有链就没有对账）。
 * busy 互斥与 watcher 同款：单轮超时不叠加并发扫描。tick 包 try/catch 不击穿进程。
 */
export function startChainReconcile() {
  if (!config.chain.escrowAddress) {
    console.warn('[chainReconcile] MK_ESCROW_ADDRESS 未配置：跳过链上状态对账（仅本地/展示模式）');
    return null;
  }
  reconcileStatus.enabled = true;
  reconcileStatus.intervalMs = config.reconcile.intervalMs;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    reconcileStatus.lastRunAt = Date.now();
    try {
      const r = await reconcileChainOnce();
      reconcileStatus.lastOkAt = Date.now();
      reconcileStatus.lastError = null;
      reconcileStatus.lastScanned = r?.scanned ?? 0;
      reconcileStatus.lastRepaired = r?.repaired ?? 0;
      reconcileStatus.lastMissing = r?.missing ?? 0;
      reconcileStatus.lastFailed = r?.failed ?? 0;
      reconcileStatus.lastAfterSaleScanned = r?.afterSaleScanned ?? 0;
      reconcileStatus.lastAfterSaleRepaired = r?.afterSaleRepaired ?? 0;
    } catch (e) {
      reconcileStatus.lastError = String(e?.message || e);
      console.error('[chainReconcile] 本轮对账异常（下轮重试）:', e?.message || e);
    } finally {
      busy = false;
    }
  };
  tick();
  const timer = setInterval(tick, config.reconcile.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(
    `[chainReconcile] 链上状态对账已启动：每 ${Math.round(config.reconcile.intervalMs / 60000)} 分钟复查静置超过 ${MIN_AGE_MS / 3600000} 小时的未终局订单（每轮至多 ${BATCH_SIZE} 单）；并复查确认收货后的售后案件（在途案件全量复核 + 每轮至多 ${AFTER_SALE_BATCH} 单的终局单开案扫描，窗口 ${Math.round(AFTER_SALE_SCAN_MS / 86_400_000)} 天）`
  );
  return timer;
}
