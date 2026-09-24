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
 *  - 候选集比单轮批量大时靠 kv 游标轮转复查（见 reconcileChainOnce），不改动 orders.updated_at
 *    ——那一列是入账/争议时刻的口径。
 *
 * 单一实现：链上终局 → 本地状态的映射**不在这里重写**，而是复用 watcher 导出的
 * `mapChainTerminal`（快照路径的唯一判据，/sync 手动同步同款）与 `settleByRefundSplit`
 * （RefundApproved/Arbitrated 的同一函数，含 refunded_amount_wei 与占位回补）、
 * `markEscrowDisputed`（DisputeRequested 的同一 SQL），防两处口径漂移；
 * 防"诱饵单"的买家/卖家/金额比对同样复用 watcher 的 `chainParamsMatch`。
 * 事件史用 orders.js 的 `appendSyncMirrorEvent`（与手动 /sync 同一条 `Sync:<状态>` 镜像）。
 *
 * 安全边界（宁可不动，也不乱动）：
 *  - 已终态的行绝不触碰；
 *  - 链上返回 None（查不到该单）而本地 escrowed + 有支付凭证时**不改状态**——那更可能是
 *    节点侧 RPC 读到了错误的链/合约或接口异常，把真金白银的单判成"从未托管"后果不可逆；
 *    只记日志 + 告警店主（order.chain_missing）一次，交人工排查；
 *  - 链上真值与本地锁定的买家/卖家/金额不一致（他人对同一 orderId 的诱饵单）→ 整单跳过。
 *
 * 幂等：修完的行已成终态，不会再被选中；重复运行不重复迁移（状态前置条件守卫）、不重复写
 * 事件史（appendSyncMirrorEvent 自带幂等）；告警用 kv 标记（按本地订单 id）保证每单至多一次。
 */
import config from './config.js';
import { getDb, kvGet, kvSet, txBegin, txCommit, txRollback } from './db.js';
import { fetchOrderFor } from './chainOrder.js';
import { getEscrow } from './chain.js';
import { settleByRefundSplit, markEscrowDisputed, chainParamsMatch, mapChainTerminal } from './escrowWatcher.js';
import { appendSyncMirrorEvent, appendOrderCreatedEvent, applyRefundFlags } from './routes/orders.js';
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
 * 已告警标记的 kv 前缀（键 = 前缀 + 事件类型 + 本地订单 id；与 poolAlert/hold_missing 同款
 * 一次性告警）。按**事件类型**分键：同一单先"链上查不到"、后来真被修复，是两件不同的事实，
 * 各自都该让店主知道一次（共用一把键会让后一条被前一条静默吞掉）。
 */
const NOTIFIED_KEY_PREFIX = 'mk:chain_reconcile_notified:';
/**
 * 复查游标（kv，值 = JSON {ts,id}）：上一轮复查到的位置，保证候选集大于单轮批量时
 * 每一单最终都会被复查到（详见 reconcileChainOnce 的说明）。
 */
const CURSOR_KEY = 'mk:chain_reconcile_cursor';

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
 * 纯决策函数（不触库、不触链；单测直调）：链上状态 + 本地行 → 该做的修复动作。
 * @param {object} local orders 行（需 status/amount_wei/paid_tx_hash）
 * @param {object} onchain fetchOnchainOrder 形状 {status, refundedAmount, ...}
 * @returns {{action:'none', reason:string}
 *          |{action:'repair', to:'disputed'|'settled'|'refunded', refundedAmountWei:string, reason:string}
 *          |{action:'missing', reason:string}}
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
  if (chainStatus === 'Disputed') {
    if (localStatus === 'disputed') return { action: 'none', reason: 'match' };
    return { action: 'repair', to: 'disputed', refundedAmountWei, reason: '链上已进入争议（资金冻结）而本地仍非争议态' };
  }
  if (chainStatus === 'Refunded' || chainStatus === 'Settled') {
    // 本地应有状态由**唯一实现** mapChainTerminal 决定（与 /sync 手动同步、与事件路径同判据）：
    // 全额退 → refunded；否则（含 refundedAmount=0 = 全额判卖家、部分退款/拆分裁决）→ settled。
    // 部分金额有两条链上来源：仲裁人 arbitrate（任意比例，无需买家授权）与
    // approveRefund == acceptedPartialRefund[orderId]（**买家精确授权过**的部分退款；
    // 2026-09 契约：其它金额一律 RefundAmountNotAccepted，旧的 RefundNotFull 已删除），
    // 所以本节里"部分金额"既可能来自裁决、也可能来自双方谈拢后的卖家执行。
    let refundedWei = 0n;
    try {
      refundedWei = BigInt(refundedAmountWei);
    } catch {
      refundedWei = 0n; // 脏字段按 0 处理（mapChainTerminal 内部同样容错，这里只为保留报告字段形状）
    }
    const to = mapChainTerminal(chainStatus, refundedWei, local.amount_wei);
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
function applyRefundFlagsIfKnown(orderIdHex, onchain) {
  if (!onchain) return 0;
  if (onchain.refundRequested === undefined && onchain.refundRejected === undefined) return 0;
  return applyRefundFlags(orderIdHex, onchain);
}

/**
 * 一次性告警（kv 标记按「事件类型 + 本地订单 id」；**投递成功后才写标记**，见 alertAck.js） */
function alertOnce(orderId, type, data) {
  return alertOnceDelivered({
    ackKey: `${NOTIFIED_KEY_PREFIX}${type}:${orderId}`,
    label: '[chainReconcile]',
    what: `（${type}，order=${String(orderId).slice(0, 8)}…）`,
    send: () => notifyRaw(type, data),
  });
}

/**
 * 修复单个滞留订单（决策 + 落库 + 事件史 + 告警）。
 * 状态迁移与事件史同事务（与 watcher/sync 同原子形态：防进程中断后"状态变了但没人知道为什么"）。
 * @returns {Promise<'repaired'|'missing'|'none'|'skipped'>}（异常向上抛，由轮询逐行兜住）
 */
export async function reconcileOrder(row) {
  const db = getDb();
  let onchain;
  try {
    onchain = await fetchOrderFor(row.escrow_order_id);
  } catch (e) {
    // RPC 读取失败**不是**"链上没有"：本轮跳过，下一轮再试（绝不据此改状态）
    console.warn(
      `[chainReconcile] 链上状态读取失败（order=${String(row.id).slice(0, 8)}…）：本轮跳过，下轮重试`,
      e?.message || e
    );
    return 'skipped';
  }
  // 防"诱饵单"（与 watcher/sync 同规则）：orderId 自草稿起公开，链上真值的买家/卖家/金额
  // 必须与本行锁定值一致；不一致说明这是别人对同一 orderId 的单，不能据它改本地状态
  if (onchain && onchain.status && onchain.status !== 'None') {
    if (!chainParamsMatch(row, { buyer: onchain.buyer, seller: onchain.seller, amount: onchain.amount })) {
      console.warn(
        `[chainReconcile] 跳过与链上真值不符的订单（order=${String(row.id).slice(0, 8)}…）：买家/卖家/金额与本地锁定不一致（疑似诱饵单）`
      );
      return 'skipped';
    }
  }
  const plan = planChainRepair(row, onchain);
  if (plan.action === 'none') return 'none';
  if (plan.action === 'missing') {
    console.warn(
      `[chainReconcile] 订单 ${String(row.id).slice(0, 8)}… 本地为 ${row.status} 且有支付凭证，链上却查不到该托管单——保留本地状态待人工核实（escrow=${String(row.escrow_order_id).slice(0, 18)}…）`
    );
    alertOnce(row.id, 'order.chain_missing', {
      orderId: row.id,
      escrowOrderId: row.escrow_order_id || null,
      reason: plan.reason,
    });
    return 'missing';
  }
  let changed = 0;
  txBegin();
  try {
    if (plan.action === 'restore') {
      /*
        链上 Created + 本地 draft/cancelled：补回占位并置 escrowed（与 watcher 的
        「恢复已取消订单」同一形状）。占位恢复失败（= 取消期间限量库存已被别人买走）不改结果：
        链上资金真实存在，订单必须恢复，差额交店主人工核账扩容——所以只告警不中断。
        补 paid_tx_hash：取消路径不允许带凭证取消，所以这里用链上创建块反查的凭证在后面
        /sync 兜底补；此处先不编造哈希（宁可空着，也不写一个假凭证）。
      */
      if (plan.to !== undefined) throw new Error('restore 分支不应带 to');
      const restored = db
        .prepare(
          "UPDATE orders SET status = 'escrowed', updated_at = ? WHERE escrow_order_id = ? AND status IN ('draft','cancelled')"
        )
        .run(Date.now(), row.escrow_order_id).changes;
      if (restored > 0) {
        if (!restockOrder(row.id)) {
          console.error(
            `[chainReconcile] 恢复订单 ${String(row.id).slice(0, 8)}… 的库存占位失败（限量库存不足），请店主核账扩容`
          );
          alertOnce(row.id, 'order.hold_missing', {
            orderId: row.id,
            escrowOrderId: row.escrow_order_id || null,
            reason: '对账恢复订单时占位失败（取消期间限量库存已被他人买走）——请核对该商品余量并扩容或退款处理',
          });
        }
        appendSyncMirrorEvent(row.id, 'escrowed', { block: onchain?.createdAtBlock || null });
        changed = restored;
        /*
          补落支付凭证：发货路径要求"有链上支付凭证"（空哈希拒发），所以恢复出来的单必须拿到哈希，
          否则店主看着一张 `escrowed` 却发不了货。做法与 `/sync` **同一条**：按链上订单的创建块
          单块反查 `OrderCreated` 日志，取规范交易哈希。RPC 异常不阻断恢复主流程
          （状态已恢复=买家资金可被正确处理，凭证交给下一次 /sync 或 watcher 重扫补）。
          先补哈希再回填退款标记：两者互不依赖，但哈希是发货闸的判据，失败面更小。
        */
        if (onchain?.createdAtBlock) {
          try {
            const escrow = getEscrow();
            const logs = await escrow.queryFilter(
              escrow.filters.OrderCreated(row.escrow_order_id),
              onchain.createdAtBlock,
              onchain.createdAtBlock
            );
            if (logs.length) {
              const txHash = String(logs[0].transactionHash).toLowerCase();
              const wrote = db
                .prepare("UPDATE orders SET paid_tx_hash = ? WHERE id = ? AND paid_tx_hash IS NULL AND status = 'escrowed'")
                .run(txHash, row.id).changes;
              if (wrote === 1) appendOrderCreatedEvent(row.id, { txHash, block: onchain.createdAtBlock });
            }
          } catch (e) {
            console.warn(
              `[chainReconcile] 恢复订单 ${String(row.id).slice(0, 8)}… 时补落支付凭证失败（不阻断恢复，下次 /sync 可补）：`,
              e?.message || e
            );
          }
        }
        /*
          退款冻结闸：链上 Created 态还要把 refundRequested/refundRejected 回填到本地镜像
          （源码审计 2026-09 复审，P1）。`fetchOnchainOrder` 每次都取回这两个字段，
          而此前全文只用 refundedAmount——漏扫 RefundRequested 时本地 refund_status 永久停在
          'none'，而它是多个资金闸的判据（能否超时释放、能否发货、能否同意退款）：
          店主看不到"买家已在链上冻结本单"，照常发货后同意退款 = 钱货两空。
          applyRefundFlags 是 /sync 用的同一实现（唯一实现）。
        */
        applyRefundFlagsIfKnown(row.escrow_order_id, onchain);
      }
    } else if (plan.to === 'disputed') {
      // 争议态同样要把退款冻结标记回填（链上 Disputed 之前必然经过 requestRefund/rejectRefund）
      changed = markEscrowDisputed(db, row.escrow_order_id);
      if (changed > 0) applyRefundFlagsIfKnown(row.escrow_order_id, onchain);
    } else {
      // 终局映射复用 watcher 的实现（唯一实现）：拆分结算走 settleByRefundSplit（内含
      // refunded_amount_wei 落库与占位回补）
      changed = settleByRefundSplit(db, row.escrow_order_id, plan.refundedAmountWei);
    }
    if (changed > 0 && plan.action !== 'restore') {
      // `Sync:<状态>` 镜像（与 /sync 同一条）：UI 时间线上能看出"这一步不是链上事件推的，
      // 而是节点对账改的"，并附上链上创建块（getOrder 无事件块号，与 /sync 同款降级）
      appendSyncMirrorEvent(row.id, plan.to, { block: onchain?.createdAtBlock || null });
    }
    txCommit();
  } catch (e) {
    txRollback();
    throw e;
  }
  if (changed === 0) return 'none'; // 状态已被 watcher/其它路径修好（竞态）：无事可做
  const toLabel = plan.action === 'restore' ? 'escrowed' : plan.to;
  console.warn(
    `[chainReconcile] 修复滞留订单 ${String(row.id).slice(0, 8)}…：${row.status} → ${toLabel}（${plan.reason}）`
  );
  alertOnce(row.id, 'order.chain_repaired', {
    orderId: row.id,
    escrowOrderId: row.escrow_order_id || null,
    from: row.status,
    to: toLabel,
    refundedAmountWei: plan.refundedAmountWei,
    reason: plan.reason,
  });
  return 'repaired';
}

/**
 * 执行一轮对账（无链上配置时跳过）。可按参数覆盖阈值/批量（测试与运维脚本用）。
 * @param {{now?:number, minAgeMs?:number, batch?:number}} opts
 * @returns {Promise<{skipped?:boolean, reason?:string, scanned?:number, repaired?:number,
 *                    missing?:number, skippedRows?:number, failed?:number}>}
 */
export async function reconcileChainOnce({ now = Date.now(), minAgeMs = MIN_AGE_MS, batch = BATCH_SIZE } = {}) {
  if (!config.chain.escrowAddress) {
    return { skipped: true, reason: 'MK_ESCROW_ADDRESS 未配置' };
  }
  const db = getDb();
  const cutoff = now - minAgeMs;
  const marks = NON_TERMINAL.map(() => '?').join(',');
  /*
    候选：本地非终态 + 有链上单号 + 静置超过阈值（刚动过的单由 watcher/paid 主路径处理），
    按 (updated_at, id) 升序 —— 滞留最久的先复查。
    游标（kv，不进 orders 表）：候选集里**总会**有一批"正常但在途"的单（例如买家迟迟不确认收货、
    等链上超时释放，几天都停在 escrowed）。若每轮都从最旧的一批重新取 LIMIT batch，这批行会永远
    占满批量，后面的滞留单永远复查不到（对账等于失效）。也不能拿 orders.updated_at 当轮转锚点：
    那一列是**入账时刻**（收款流水/看板/CSV 导出按它归属）与争议起始时刻（仲裁列表 disputedAt）
    的口径，为了轮转去改它等于篡改账目时间。故游标单独存 kv，只表示"上一轮复查到哪儿"；
    一轮取不满一批说明已到候选集末尾 → 下轮回绕到开头，保证没有订单被永久跳过。
  */
  const readCursor = () => {
    try {
      const v = JSON.parse(kvGet(CURSOR_KEY, '') || 'null');
      if (v && Number.isFinite(Number(v.ts)) && typeof v.id === 'string') return { ts: Number(v.ts), id: v.id };
    } catch {
      /* 游标损坏：当作没有游标（从头开始），不影响正确性 */
    }
    return null;
  };
  const pick = (cursor, limit) => {
    const after = cursor ? ' AND (updated_at > ? OR (updated_at = ? AND id > ?))' : '';
    const tail = cursor ? [cursor.ts, cursor.ts, cursor.id] : [];
    return db
      .prepare(
        `SELECT id, status, escrow_order_id, paid_tx_hash, buyer, seller, amount_wei, updated_at
           FROM orders
          WHERE status IN (${marks}) AND escrow_order_id IS NOT NULL AND updated_at <= ?${after}
          ORDER BY updated_at ASC, id ASC LIMIT ?`
      )
      .all(...NON_TERMINAL, cutoff, ...tail, limit);
  };
  let cursor = readCursor();
  let rows = pick(cursor, batch);
  let wrapped = false;
  if (!rows.length && cursor) {
    // 游标已到候选集末尾：回绕到开头（本轮从头复查，下一轮继续往后推进）
    cursor = null;
    wrapped = true;
    rows = pick(null, batch);
  }
  if (rows.length && (rows.length < batch || wrapped)) {
    // 取不满一批（或刚回绕过）⇒ 本轮已覆盖到候选集末尾：清空游标，下轮从最旧的开始
    kvSet(CURSOR_KEY, '');
  } else if (rows.length) {
    const last = rows[rows.length - 1];
    kvSet(CURSOR_KEY, JSON.stringify({ ts: Number(last.updated_at), id: String(last.id) }));
  }
  let repaired = 0;
  let missing = 0;
  let skippedRows = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const r = await reconcileOrder(row);
      if (r === 'repaired') repaired += 1;
      else if (r === 'missing') missing += 1;
      else if (r === 'skipped') skippedRows += 1;
    } catch (e) {
      // 单行异常不打断整轮（其余滞留单仍应被修复）；游标已越过该行，下轮/回绕后重试（修复幂等）
      failed += 1;
      console.error(`[chainReconcile] 订单 ${String(row.id).slice(0, 8)}… 对账异常（下轮重试）:`, e?.message || e);
    }
  }
  if (rows.length && (repaired || missing || failed)) {
    console.log(
      `[chainReconcile] 本轮复查 ${rows.length} 单：修复 ${repaired}、链上缺失告警 ${missing}、跳过 ${skippedRows}、异常 ${failed}`
    );
  }
  return { scanned: rows.length, repaired, missing, skippedRows, failed };
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
};

/** 只读快照（/healthz 用） */
export function chainReconcileStatus() {
  return {
    ...reconcileStatus,
    minAgeMs: MIN_AGE_MS,
    batch: BATCH_SIZE,
    /** 静置多久算「可能漏扫」（小时）——展示用，避免运维心算 */
    minAgeHours: Math.round(MIN_AGE_MS / 3_600_000),
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
    `[chainReconcile] 链上状态对账已启动：每 ${Math.round(config.reconcile.intervalMs / 60000)} 分钟复查静置超过 ${MIN_AGE_MS / 3600000} 小时的未终局订单（每轮至多 ${BATCH_SIZE} 单）`
  );
  return timer;
}
