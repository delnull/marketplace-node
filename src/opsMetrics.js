/**
 * 卖家运营读数（**唯一实现**）：待办队列（计数 + 最久等待）、托管超时、链上挂账余额、
 * 对账读数、SLA 清单与发货时长。
 *
 * 为什么单列一个模块，而不是在路由里各写一遍 SQL：
 *  1. **同一批谓词有两个消费方**。「待处理退款」「在途售后案件」「待仲裁争议」「可发货」
 *     既出现在店主徽标（`GET /api/orders/seller/status-counts`）与列表筛选（`/seller?refund=…`），
 *     也出现在本模块的运营读数与 SLA 清单里。谓词抄成两份的后果是**静默漂移**：
 *     徽标说 3 单、列表翻出 4 单，店主以为统计坏了（这正是 `/seller` 里那段注释记着的旧事）。
 *     所以谓词常量（PENDING_REFUND_SQL / SHIP_READY_SQL）在此定义一次，徽标、筛选、读数、清单共用。
 *  2. **"最久等待"只有一份算法**：`queueWait` 原先长在 `routes/arbitration.js` 里（仲裁队列用），
 *     运营读数要的是同一件事（待办几单 + 最久等了多久）。同一读数两处实现必然给出两个答案，
 *     故移到这里，仲裁路由改为 import。
 *  3. **链上读数不新起真相源**：对账读数取 `chainReconcile.js` 的只读快照（`chainReconcileStatus()`，
 *     由路由取好后传进来，见 reconcileReading 的说明）；收费方地址取 `fees.js` 的唯一实现
 *     （含它自己的 60s 缓存与"读不到沿用上次真值"的语义），不配第二个环境变量。
 *
 * 三态纪律（本仓硬要求：读不到 ≠ 0 ≠ 缺失）——本模块把三类"读不到"分别表达：
 *  · 链上读不到（RPC 不可达/合约未升级）：`available:false` + `reason`，**数值字段一律 null**，
 *    并且把"本地本来就知道的候选数"照给（那是本地事实，与链上读数分开）；
 *  · 单笔读不到：计入 `unknown` 而不是"未超时"（`checked + unknown = 候选数`是恒等式）；
 *  · 挂账余额按地址计：读不到主体（未配店主地址 / 收费方未知）就说清"没有可读的主体"，
 *    绝不下发一个看起来像 0 的数字。
 */
import { getDb } from './db.js';
import config from './config.js';
import { getEscrow, getProvider, isZeroAddress, weiToDecimal } from './chain.js';
import { ACTIVE_IN, ESCROW_RELEASABLE_IN, INCOME_IN, ORDER_STATUS } from './orderStatus.js';
import { AFTER_SALE_OPEN_SQL } from './afterSale.js';
import { refreshFeeCollector, feeStatus } from './fees.js';
import { reputationSummary, DELIVERY_MIN_SAMPLES, parseOnchainEvents, escrowedAtOf } from './reputation.js';

/* ══════════════════════════════════════════════════════════════════════
   待办谓词（**唯一拼法**）——徽标、列表筛选、运营读数、SLA 清单共用
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 待处理的退款申请。**必须带 `status IN ACTIVE_IN`**：`refund_status` 是"申请/拒绝"的镜像，
 * 终局迁移会把它复位成 'none'，但 `/cancel` 之类的本地终局路径历史上留过残影——
 * 只按 refund_status 筛会把"已经退完款/已取消"的单也拉进"待处理"，于是徽标 0 单、列表 1 单。
 * 能由店主表态的只有 escrowed / shipped / disputed 三种在途状态（见 routes/orders.js 的说明）。
 */
export const PENDING_REFUND_SQL = `refund_status = 'requested' AND status IN ${ACTIVE_IN}`;

/**
 * 可发货 = 待发货 ∧ 有链上支付凭证 ∧ 未被退款申请冻结。
 * 三个条件缺一不可：无凭证的 escrowed 是异常行（要先同步或取消，发出去就是无凭据发货）；
 * 退款申请待决的单 `/ship` 与批量发货都会拒（发货等于把钱货关系搅浑），计入就是徽标虚高。
 */
export const SHIP_READY_SQL = "status = 'escrowed' AND paid_tx_hash IS NOT NULL AND refund_status != 'requested'";

/** 待仲裁争议（本地 disputed） */
export const DISPUTED_SQL = "status = 'disputed'";

/* ══════════════════════════════════════════════════════════════════════
   队列读数
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 队列等待读数（**待办计数 + 最久等待时长**）——仲裁列表与运营读数共用的唯一实现。
 *
 * 为什么要"最久等待"：光有总数看不出**积压**——3 单里有 1 单已经压了 11 个月，
 * 与 3 单都是今天进来的，是完全不同的两件事，而列表本身只按时间倒序翻页，看不出这一点。
 * 口径：等待起点 = 该队列"进入待办状态"的那一刻（争议 = updated_at 即 disputedAt；
 * 案件 = after_sale_opened_at；退款申请 = refund_requested_at），时长 = now − 最早那一单的起点。
 * 空队列返回 { count: 0, oldestAt: null, oldestWaitingMs: null }（**不是 0**：没有等待中的单
 * 与"等了 0 毫秒"不是一件事）。锚点列全为 NULL（异常数据）时同样是 `count>0 + oldestAt:null`——
 * 计数是事实，起点读不到就如实留空。
 *
 * ⚠️ where/timeCol 只接受**调用方写死的字面常量/本模块导出的谓词**（不是用户输入）——
 * 全仓 SQL 一律参数化，这里拼的是列名/固定谓词，没有任何外部字符串进来。
 */
export function queueWait({ where, timeCol }) {
  const row = getDb().prepare(`SELECT COUNT(*) AS c, MIN(${timeCol}) AS oldest FROM orders WHERE ${where}`).get();
  const oldestAt = row?.oldest || null;
  return {
    count: row?.c || 0,
    oldestAt,
    oldestWaitingMs: oldestAt ? Math.max(0, Date.now() - Number(oldestAt)) : null,
  };
}

/**
 * 店主待办计数（**唯一实现**：卖家面板徽标 `GET /api/orders/seller/status-counts` 与
 * `GET /api/shop/metrics` 共用）。单表聚合毫秒级。
 */
export function sellerTodoCounts() {
  const db = getDb();
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM orders GROUP BY status').all();
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.c]));
  const pendingRefund = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE ${PENDING_REFUND_SQL}`).get().c;
  // 可发货：谓词见 SHIP_READY_SQL（无凭证异常行不计入、退款冻结行不可发）
  const shipReady = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE ${SHIP_READY_SQL}`).get().c;
  const pendingDispute = byStatus.disputed || 0;
  /*
    在途**售后案件**（确认收货后开案）计数：与 disputed 并列进店主徽标。
    为什么必须给：案件在途意味着"这笔已结清的钱可能被仲裁人从保证金里罚没给买家"，
    而订单状态仍是终局（settled/confirmed/expired）——只按 status 分组的徽标永远看不见它，
    店主会一直以为这单已经了结。判据与仲裁队列/退货门控同一处（afterSale.js）。
  */
  const pendingAfterSale = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE ${AFTER_SALE_OPEN_SQL}`).get().c;
  // P 评审扩展（卖家待办聚合）：退货回收 / 待回复评价 / 低库存
  const pendingReturns = db.prepare("SELECT COUNT(*) AS c FROM order_returns WHERE status IN ('open','shipped')").get().c;
  const returnsToConfirm = db.prepare("SELECT COUNT(*) AS c FROM order_returns WHERE status = 'shipped'").get().c;
  const pendingReviewReply = db
    .prepare(
      `SELECT COUNT(*) AS c FROM reviews r JOIN orders o ON o.id = r.order_id WHERE r.reply_content = '' AND o.status IN ${INCOME_IN}`
    )
    .get().c;
  // 低库存按「商品」计数：任一组合余量 ≤ 商品级阈值即计入（卖家务必要一并看那些组合）
  const lowStockProducts = db
    .prepare(
      `SELECT COUNT(DISTINCT s.product_id) AS c
         FROM product_skus s
         JOIN products p ON p.id = s.product_id
        WHERE s.capacity IS NOT NULL AND p.stock_alert_at IS NOT NULL
          AND (s.capacity - s.committed) <= p.stock_alert_at`
    )
    .get().c;
  return {
    byStatus,
    shipReady,
    pendingRefund,
    pendingDispute,
    pendingAfterSale,
    pendingReturns,
    returnsToConfirm,
    pendingReviewReply,
    lowStockProducts,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   对账读数
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 最近一轮链上状态对账的读数（**唯一事实源**：`chainReconcile.js` 的运行状态快照，
 * `/healthz` 读的是同一份——运营读数不自己重算，也不落第二份计数）。
 *
 * 快照由调用方传入（`chainReconcileStatus()`）而不是本模块 import：`chainReconcile.js`
 * 反过来 import 了 `routes/orders.js`，而 `routes/orders.js` 要用本模块的待办计数——
 * 三边一连就是循环依赖。快照本身仍只有一个来源，这里只做**形状与三态标注**。
 *
 * 「差异数」= repaired + missing：
 *  · repaired = 本轮发现"链上已终局/已争议而本地仍停在非终态"并修好的单；
 *  · missing  = 本轮发现"本地有单、链上查无此单"的单（告警）。
 * `failed`（读不到：RPC 抖动/异常）**单列、不计入差异数**——把"没读到"算成"有差异"，
 * 等于让 RPC 故障冒充账目不一致。
 *
 * `available:false` 的两种含义都在 `reason` 里写明：从未跑完一轮（刚启动/每轮都失败）、
 * 或对账根本没启用（未配置托管合约）——此时 `differences` 为 null，绝不写 0。
 */
export function reconcileReading(s) {
  if (!s || typeof s !== 'object') {
    throw new Error('opsMetrics.reconcileReading 需要 chainReconcileStatus() 的快照（见本函数说明）');
  }
  const ranOk = s.lastOkAt !== null && s.lastOkAt !== undefined;
  let reason = null;
  if (!s.enabled) {
    reason = '链上状态对账未启用（未配置 MK_ESCROW_ADDRESS，或本进程未启动对账任务）：没有可比对的链上事实';
  } else if (!ranOk) {
    reason = '对账已启动但尚未跑完一轮（或每一轮都在异常里结束）：最近一轮的读数与差异数读不到';
  }
  return {
    available: ranOk,
    reason,
    enabled: s.enabled,
    intervalMs: s.intervalMs,
    lastRunAt: s.lastRunAt,
    lastOkAt: s.lastOkAt,
    lastError: s.lastError,
    scanned: s.lastScanned,
    repaired: s.lastRepaired,
    missing: s.lastMissing,
    failed: s.lastFailed,
    differences: ranOk ? s.lastRepaired + s.lastMissing : null,
    afterSaleScanned: s.lastAfterSaleScanned,
    afterSaleRepaired: s.lastAfterSaleRepaired,
    minAgeHours: s.minAgeHours,
    afterSaleScanDays: s.afterSaleScanDays,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   托管超时（链上判据）
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 单次读数最多读多少单的链上释放阈值。
 * 数值依据：候选面是"待发货 + 已发货未确认"的在途单，一家店的这个队列通常在个位数到几十；
 * 100 同时是 ethers v6 一批 JSON-RPC 的默认合并上限（batchMaxCount），即这批读在网络上
 * 仍然是**一次往返**。超出的单如实标 `truncated` 并计入 `unknown`，不假装核过了。
 */
const MAX_THRESHOLD_READS = 100;

/** 链上读数失败的统一文案（截断防把 RPC 内部结构整段回给客户端） */
const chainErrText = (e) => String(e?.message || e).slice(0, 160);

/**
 * 「托管中 / 已超时」读数（链上判据，**唯一实现**：运营读数与卖家 SLA 清单共用）。
 *
 * 判据是**合约自己**的 `releaseNotBeforeBlock(orderId)`：`latestBlock > 该阈值` 时，
 * 任何人都能调 `releaseExpired` 把钱判给卖家。刻意不自己用 `createdAtBlock + timeoutBlocks`
 * 算——合约在那之上还叠了"卖家拒绝退款后的释放静置期"（加固 A），自算会把静置期内的单
 * 误报成"已超时"（店主被叫去抢救一笔其实还有窗口的单）。
 * 同样刻意不自己估块时间（BTY ≈5s/块只是经验值）：估出来的"超时"没有链上事实对应。
 *
 * 两类单压根不读阈值：
 *  · `refund_status='requested'`（退款申请待决）：合约 `releaseExpired` 直接 revert
 *    `RefundPending`，**永久**不可释放——既不是"已超时"，也不该白占一次链上读；
 *  · `draft`/`disputed`：见 orderStatus.js 的 ESCROW_RELEASABLE_STATUS 说明。
 *
 * @param {{wantItems?: boolean, limit?: number, now?: number}} opts
 *        wantItems = 是否返回超时清单（最久的在前，SLA 用）；limit = 清单条数上限
 * @returns {Promise<object>} 见下方各字段注释；读不到链上时 `overdue` 为 **null**（不是 0）
 */
export async function escrowOverdueReading({ wantItems = false, limit = 0, now = Date.now() } = {}) {
  const db = getDb();
  const activeOrders = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status IN ${ACTIVE_IN}`).get().c;
  const rows = db
    .prepare(
      `SELECT id, product_slug, escrow_order_id, refund_status, timeout_blocks, onchain_events, created_at
         FROM orders
        WHERE status IN ${ESCROW_RELEASABLE_IN} AND escrow_order_id IS NOT NULL AND paid_tx_hash IS NOT NULL
        ORDER BY created_at ASC`
    )
    .all();
  const blocked = rows.filter((r) => String(r.refund_status) === 'requested');
  const candidates = rows.filter((r) => String(r.refund_status) !== 'requested');
  const base = {
    // available 只描述**链上那一半**（释放阈值与块高）；下面的本地计数与它无关，照给
    available: false,
    reason: null,
    latestBlock: null,
    activeOrders,
    candidateCount: candidates.length,
    refundBlockedCount: blocked.length,
    checked: 0,
    unknown: candidates.length,
    overdue: null,
    truncated: candidates.length > MAX_THRESHOLD_READS,
    checkedAt: null,
    items: [],
  };
  if (!config.chain.escrowAddress) {
    return { ...base, reason: '未配置 MK_ESCROW_ADDRESS：读不到链上释放阈值（本地只能给出托管中与候选单数）' };
  }
  if (!candidates.length) {
    // 没有候选就不需要任何链上读数（也就没有"读不到"可言）：0 是**确证的 0**
    return { ...base, available: true, unknown: 0, overdue: 0, checkedAt: now };
  }
  const checkedRows = candidates.slice(0, MAX_THRESHOLD_READS);
  try {
    const escrow = getEscrow();
    // 块高与逐单阈值：ethers v6 会把同一 tick 发出的调用合并成一次 JSON-RPC 批量请求
    const latestBlock = Number(await getProvider().getBlockNumber());
    const thresholds = new Map();
    await Promise.all(
      checkedRows.map(async (r) => {
        try {
          const t = Number(await escrow.releaseNotBeforeBlock(r.escrow_order_id));
          /*
            阈值必须 > 0 才算"读到了"：合约对**未知 orderId** 的 getter 返回全 0
            （`createdAtBlock + timeoutBlocks` 都是 0），把它当成阈值就会得出
            `latestBlock > 0 ⇒ 已超时` 的假警报。真单的 `timeoutBlocks` 有合约下限保证，恒 > 0。
            所以 0 按"这次没读到"处理（进 unknown），而不是按"已超时"。
          */
          if (t > 0) thresholds.set(r.id, t);
        } catch {
          // 单笔读失败：留在 unknown 里（**不**当成"未超时"——那会把一笔随时可能被释放的单说成没事）
        }
      })
    );
    const overdueRows = checkedRows.filter((r) => thresholds.has(r.id) && latestBlock > thresholds.get(r.id));
    const items = wantItems
      ? overdueRows
          .map((r) => {
            // 等待时长锚点 = 托管入账近似时刻（OrderCreated 落库时刻，唯一判据在 reputation.js）；
            // 读不到就是 null（不拿 created_at 顶替——那是草稿创建时刻，是另一个口径）
            const escrowedAt = escrowedAtOf(parseOnchainEvents(r.onchain_events));
            return {
              orderId: r.id,
              productSlug: r.product_slug,
              escrowOrderId: r.escrow_order_id,
              escrowedAt,
              waitingMs: escrowedAt ? Math.max(0, now - escrowedAt) : null,
              timeoutBlocks: r.timeout_blocks || null,
              releaseNotBeforeBlock: thresholds.get(r.id),
              blocksLeft: Math.max(0, thresholds.get(r.id) - latestBlock),
            };
          })
          // 最久的在前；等待时长读不到（null）的排在最后，但**照样列出**（它们确实已超时）
          .sort((a, b) => (b.waitingMs ?? -1) - (a.waitingMs ?? -1))
          .slice(0, Math.max(1, Number(limit) || overdueRows.length))
      : [];
    return {
      ...base,
      available: true,
      reason:
        thresholds.size < candidates.length
          ? `有 ${candidates.length - thresholds.size} 单的释放阈值没读到（本轮未纳入结论，下轮重试）`
          : null,
      latestBlock,
      checked: thresholds.size,
      unknown: candidates.length - thresholds.size,
      overdue: overdueRows.length,
      checkedAt: now,
      items,
    };
  } catch (e) {
    console.warn('[opsMetrics] 托管超时读数失败:', e?.message || e);
    return {
      ...base,
      reason: `链上读取失败（RPC 不可达，或合约未升级到含 releaseNotBeforeBlock 的版本）：${chainErrText(e)}`,
    };
  }
}

/* ══════════════════════════════════════════════════════════════════════
   链上挂账余额
   ══════════════════════════════════════════════════════════════════════ */

/** 一项挂账读数的形状（读不到时数值字段全为 null + reason，绝不用 0 冒充"没有挂账"） */
const accruedSlot = (reason = null) => ({ available: false, reason, address: null, wei: null, decimal: null });

/**
 * 挂账余额（`Escrow.accruedPayouts` / `accruedFees`）：`_settle` 派发失败时钱会记在收款方名下，
 * 由其自行 `withdrawPayout()` / `withdrawFees()` 领走——**挂在链上、没人提醒**，所以要有读数。
 *
 * 两处**按地址**读，主体各不相同，因此各自独立降级（一项读不到不影响另一项）：
 *  · payouts 读**店主地址**（MK_SHOP_OWNER）：托管金派发给卖家时挂的账；
 *  · fees    读**当前全局 feeCollector**：平台费挂的账。地址走 `fees.js` 的唯一实现
 *    （60s 缓存、读不到沿用上次真值），不另配环境变量（配错就是第二个真相源）。
 *    已知边界（如实写）：合约按**每单创建时快照**的收取方扣费，历史收取方名下的挂账
 *    不在这两个读数里——本读数只回答"现在的收款主体有多少可领"。
 */
export async function accruedReading() {
  const note =
    '挂账是**按地址**计的余额：这里只读当前店主地址与当前全局 feeCollector 名下的挂账；' +
    '合约按每单创建时快照的收取方扣费，历史收取方名下的挂账不在本读数内。';
  if (!config.chain.escrowAddress) {
    const reason = '未配置 MK_ESCROW_ADDRESS：读不到链上挂账余额';
    return { payouts: accruedSlot(reason), fees: accruedSlot(reason), note };
  }
  // 收费方地址：唯一实现在 fees.js（读不到时它给出 known=false / 上次真值，不猜）
  await refreshFeeCollector();
  const st = feeStatus();
  const seller = String(config.shop.owner || '').toLowerCase();
  const collector = String(st.feeCollector || '').toLowerCase();
  const escrow = getEscrow();
  /*
    两个主体各自独立 try/catch：payouts 与 fees 是**两个不同的映射**，
    一个读失败不代表另一个没有挂账（也不代表它是 0）。
  */
  const readPayouts = async () => {
    if (!/^0x[0-9a-f]{40}$/.test(seller)) {
      return accruedSlot('本节点未配置店主地址（MK_SHOP_OWNER）：挂账按收款地址计，没有主体就没有读数');
    }
    try {
      const wei = BigInt(await escrow.accruedPayouts(seller)).toString();
      return { available: true, reason: null, address: seller, wei, decimal: weiToDecimal(wei) };
    } catch (e) {
      return accruedSlot(`链上读取失败（RPC 不可达或合约未升级到含 accruedPayouts 的版本）：${chainErrText(e)}`);
    }
  };
  const readFees = async () => {
    if (!st.feeCollectorKnown) {
      return accruedSlot('读不到链上平台费收取方（feeCollector()：RPC 不可达或合约已移除该函数）：挂账按地址计，主体未知就没有读数');
    }
    if (!collector || isZeroAddress(collector)) {
      return accruedSlot('本店合约未配置平台费收取方（feeCollector 为零地址）：没有可读的挂账主体');
    }
    try {
      const wei = BigInt(await escrow.accruedFees(collector)).toString();
      return { available: true, reason: null, address: collector, wei, decimal: weiToDecimal(wei) };
    } catch (e) {
      return accruedSlot(`链上读取失败（RPC 不可达或合约未升级到含 accruedFees 的版本）：${chainErrText(e)}`);
    }
  };
  const [payouts, fees] = await Promise.all([readPayouts(), readFees()]);
  return { payouts, fees, note };
}

/* ══════════════════════════════════════════════════════════════════════
   组装：运营指标端点
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 运营指标（`GET /api/shop/metrics`，ownerOnly 只读）。
 *
 * 全部读数都来自**已有的唯一实现**：待办谓词与徽标同源、队列读数走 queueWait、
 * 对账走 `chainReconcileStatus()` 的快照（调用方传入）、收费方走 fees.js、托管超时走
 * escrowOverdueReading——本函数只做组装与三态标注，不新建任何账本。
 *
 * 响应形状的另一端（前端）：`frontend/src/types.ts` 的 `ShopMetrics` 与
 * `frontend/src/utils/opsBoard.ts`（读不到 ≠ 0：`accrued*Wei` / `reconcileMismatches` 为 null 时
 * 界面说"读不到"，绝不印 0）。前端不消费的**附加字段**（reason / unknown / note 等）
 * 是同一批读数的来源说明，不是第二份数值。
 *
 * `refundsOldestWaitingMs` 与另两格**同一口径**：等待起点 = `refund_requested_at`
 * （链上 RefundRequested 的本地镜像时刻，与 SLA 清单的 ageMs 同一列），空队列 = null。
 * ⚠️ 前端 `utils/opsBoard.ts` 的退款那一行目前把"最久等待"写死成"本接口未提供"
 * （`missingField: true`）——本字段下发后，那一行要改成读 `refundsOldestWaitingMs`，
 * 否则界面会与接口说的不一致（接口给了、界面说没有）。
 *
 * @param {{now?: number, reconcile: object}} opts reconcile = `chainReconcileStatus()` 的返回值（必填）
 */
export async function opsMetrics({ now = Date.now(), reconcile } = {}) {
  const todos = sellerTodoCounts();
  const [escrow, accrued] = await Promise.all([escrowOverdueReading({ now }), accruedReading()]);
  const refunds = queueWait({ where: PENDING_REFUND_SQL, timeCol: 'refund_requested_at' });
  const afterSale = queueWait({ where: AFTER_SALE_OPEN_SQL, timeCol: 'after_sale_opened_at' });
  const disputes = queueWait({ where: DISPUTED_SQL, timeCol: 'updated_at' });
  const rec = reconcileReading(reconcile);
  /*
    订单各状态计数：键集合取 ORDER_STATUS（状态名拼错的唯一防线），**缺的状态补 0**——
    这里是"本店确实没有该状态的单"（本地表的全量计数），不是"读不到"：
    读不到的形状是 null / available:false，见 accrued*Wei、overdueCount、reconcileMismatches。
  */
  const byStatus = Object.fromEntries(ORDER_STATUS.map((s) => [s, todos.byStatus[s] || 0]));
  return {
    // ===== 前端契约字段（ShopMetrics）=====
    refundsPending: refunds.count,
    /*
      待处理退款的**最久等待**：起点 = `refund_requested_at`（链上 RefundRequested 的本地镜像时刻，
      与 SLA 清单的 ageMs 同一列、与另两格同一算法 queueWait）。空队列 = null（不是 0 毫秒）。
      "读不到"这一档在本列上表现为 count>0 而 oldestAt 为空（历史脏数据：镜像的申请时刻缺失），
      此时 oldestWaitingMs 同样是 null——界面据"有没有数"自行区分，读数本身不编造。
    */
    refundsOldestWaitingMs: refunds.oldestWaitingMs,
    afterSaleOpen: afterSale.count,
    afterSaleOldestWaitingMs: afterSale.oldestWaitingMs, // 空队列 = null（"没有等待中的单" ≠ "等了 0 毫秒"）
    disputesPending: disputes.count,
    disputesOldestWaitingMs: disputes.oldestWaitingMs,
    reconcileLastRunAt: rec.lastRunAt,
    reconcileMismatches: rec.differences, // 读不到 = null（不是 0 处）
    accruedPayoutsWei: accrued.payouts.available ? accrued.payouts.wei : null,
    accruedFeesWei: accrued.fees.available ? accrued.fees.wei : null,
    ordersByStatus: byStatus,
    escrowedCount: escrow.activeOrders, // 在途托管（escrowed/shipped/disputed，本地口径，恒可读）
    overdueCount: escrow.overdue, // 链上判据：读不到 = null（不是 0 单）
    generatedAt: now,
    // ===== 三态与口径（附加字段：读不到的原因、未核完的单数、口径说明）=====
    overdueUnknown: escrow.unknown,
    overdueCheckedAt: escrow.checkedAt,
    overdueTruncated: escrow.truncated, // 候选超过单轮上限：只核了前 MAX_THRESHOLD_READS 单（其余计入 unknown）
    escrowReason: escrow.reason,
    refundBlockedCount: escrow.refundBlockedCount, // 退款申请待决：合约永久拒绝超时释放
    reconcileReason: rec.reason,
    reconcileFailed: rec.failed, // 读不到（异常）的单数，不计入差异数
    accruedPayoutsReason: accrued.payouts.available ? null : accrued.payouts.reason,
    accruedFeesReason: accrued.fees.available ? null : accrued.fees.reason,
    accruedNote: accrued.note,
    note:
      '口径与来源：待办计数与 /api/orders/seller/status-counts 徽标同一实现（谓词只有一份）；' +
      '对账读数取 chainReconcile 的运行状态快照（/healthz 同源），差异数 = 修复 + 链上缺失，' +
      '读不到（failed）单列不计入；托管超时以合约 releaseNotBeforeBlock 为准（不按块时间估算）；' +
      '挂账余额按地址读（店主地址 / 当前 feeCollector）。读不到一律 null + reason。',
  };
}

/* ══════════════════════════════════════════════════════════════════════
   组装：卖家 SLA 读数
   ══════════════════════════════════════════════════════════════════════ */

/** SLA 清单的单次条数上限（面板一屏够用；要全量请走各业务列表端点） */
export const SLA_LIMIT_MAX = 100;
export const SLA_LIMIT_DEFAULT = 20;

/**
 * SLA 清单条目（前端契约 `SlaItem`）。
 * `ageMs` = 该条已等待毫秒数；**读不到就整个键不下发**（不是 null、更不是 0）——
 * 前端的 `rowsOf` 对缺失值渲染"读不到已等待时长"，而 `null` 会被 `Number(null)=0` 渲染成
 * "不到 1 分钟"（一句与事实相反的断言）。三态纪律在跨语言边界上也要成立。
 */
function slaItem(orderId, ageMs, extra = {}) {
  return Number.isFinite(ageMs) && ageMs >= 0 ? { orderId, ageMs, ...extra } : { orderId, ...extra };
}

/**
 * 卖家 SLA 读数（`GET /api/shop/sla`，ownerOnly 只读）：三份待办清单 + 发货时长分布。
 *
 * 三份清单的判据都**不是**新写的：未发货超期走 escrowOverdueReading（与 metrics 同一个读数）、
 * 待回复退款走 PENDING_REFUND_SQL、在途案件走 AFTER_SALE_OPEN_SQL。
 *
 * 发货时长（中位数/P90）取 `reputation.js` 的 delivery 读数（同一批样本、同一基准：
 * OrderCreated 落库时刻 → 交付时刻，实物单兜底 shipped_at），**不在这里另算一遍**。
 * 与 `/api/shop/reputation` 的唯一差别是**显示策略**：SLA 读数在样本 < DELIVERY_MIN_SAMPLES 时
 * 把中位数与 P90 一并置 null（P90 在 n<5 时等于最大值，摆在 SLA 面板上会被读成"典型最慢"），
 * 原始样本量照给（shipSampleCount）；`/reputation` 是公开画像的原始分布读数，中位数照给。
 *
 * 响应形状的另一端（前端）：`frontend/src/types.ts` 的 `ShopSla` 与 `utils/opsBoard.ts`。
 */
export async function slaReading({ limit = SLA_LIMIT_DEFAULT, now = Date.now() } = {}) {
  const n = Math.min(SLA_LIMIT_MAX, Math.max(1, Number(limit) || SLA_LIMIT_DEFAULT));
  const db = getDb();
  const unshipped = await escrowOverdueReading({ wantItems: true, limit: n, now });

  // 待店主回复的退款申请：谓词与徽标/SLA 计数同源；按申请时刻升序 = 最久的在前
  const refundRows = db
    .prepare(
      `SELECT id, refund_requested_at FROM orders WHERE ${PENDING_REFUND_SQL} ORDER BY refund_requested_at ASC LIMIT ?`
    )
    .all(n);
  // 店主已提交的"退款回复"条数：一次聚合取回，避免逐行 COUNT（详情时间线的老坑：N+1）
  const replyCounts = new Map(
    db
      .prepare("SELECT order_id, COUNT(*) AS c FROM dispute_evidence WHERE role = 'seller' AND phase = 'refund_reply' GROUP BY order_id")
      .all()
      .map((r) => [r.order_id, r.c])
  );
  const refundWait = queueWait({ where: PENDING_REFUND_SQL, timeCol: 'refund_requested_at' });

  // 在途售后案件：判据 after_sale_status='open'；排序锚点是**开案时刻**（案件不动 updated_at）
  const caseRows = db
    .prepare(`SELECT id, after_sale_opened_at FROM orders WHERE ${AFTER_SALE_OPEN_SQL} ORDER BY after_sale_opened_at ASC LIMIT ?`)
    .all(n);
  const caseWait = queueWait({ where: AFTER_SALE_OPEN_SQL, timeCol: 'after_sale_opened_at' });

  // 发货时长：唯一实现在 reputation.js（这里只读它的 delivery 桶，并按 SLA 的样本阈值决定发不发数）
  const delivery = reputationSummary().delivery;
  const pick = (key) => {
    const b = delivery?.[key] || { count: 0, medianMs: null, p90Ms: null, sampleTooSmall: true };
    return {
      count: b.count,
      sampleTooSmall: !!b.sampleTooSmall,
      medianMs: b.sampleTooSmall ? null : b.medianMs,
      p90Ms: b.sampleTooSmall ? null : b.p90Ms,
    };
  };
  const ship = pick('d30');

  return {
    // ===== 前端契约字段（ShopSla）=====
    unshippedOverdue: unshipped.items.map((i) => slaItem(i.orderId, i.waitingMs)),
    refundAwaitingReply: refundRows.map((r) =>
      slaItem(r.id, r.refund_requested_at ? now - Number(r.refund_requested_at) : undefined, {
        // 店主已提交的回复条数：0 = 完全没回（这才是"待回复"里最紧的那批）
        sellerReplyCount: replyCounts.get(r.id) || 0,
      })
    ),
    afterSaleOpen: caseRows.map((r) =>
      slaItem(r.id, r.after_sale_opened_at ? now - Number(r.after_sale_opened_at) : undefined)
    ),
    shipMedianMs: ship.medianMs,
    shipP90Ms: ship.p90Ms,
    // ===== 三态与口径（附加字段）=====
    unshippedOverdueAvailable: unshipped.available,
    unshippedOverdueReason: unshipped.reason,
    unshippedOverdueUnknown: unshipped.unknown,
    unshippedOverdueCandidates: unshipped.candidateCount,
    unshippedOverdueRefundBlocked: unshipped.refundBlockedCount,
    unshippedOverdueTruncated: unshipped.truncated,
    unshippedOverdueTotal: unshipped.overdue, // = 清单条数上限之外的**真实**超期总数（读不到时 null）
    unshippedOverdueCheckedAt: unshipped.checkedAt,
    refundAwaitingReplyTotal: refundWait.count,
    refundAwaitingReplyOldestWaitingMs: refundWait.oldestWaitingMs,
    afterSaleOpenTotal: caseWait.count,
    afterSaleOpenOldestWaitingMs: caseWait.oldestWaitingMs,
    shipSampleCount: ship.count,
    shipSampleTooSmall: ship.sampleTooSmall,
    shipMinSamples: DELIVERY_MIN_SAMPLES,
    shipWindow: 'd30',
    shipBasis: 'OrderCreated 事件落库时刻 → 交付时刻（交付行最晚时刻；实物单兜底 shipped_at）',
    shipWindows: Object.fromEntries(Object.keys(delivery || {}).map((k) => [k, pick(k)])),
    generatedAt: now,
    limit: n,
    note:
      '本读数只覆盖**本店**：清单与时长全部来自本节点镜像的订单（不向联邦其它节点查询任何买家/店铺）。' +
      '"超期"的判据是链上（合约 releaseNotBeforeBlock 已被当前块高跨过）而非本地估算；' +
      '链上读不到时 unshippedOverdue 为空数组且 unshippedOverdueAvailable=false —— ' +
      '"读不到"不等于"没有超期单"（界面必须看这个字段，别把空清单读成"一切正常"）。' +
      `发货耗时是**本地账**（节点自述，非链上事实），口径与 /api/shop/reputation 的 delivery 完全一致；` +
      `差别只在显示策略：本读数在样本 < ${DELIVERY_MIN_SAMPLES} 时中位数与 P90 一律 null，样本量照给。`,
  };
}
