/**
 * 店铺履约画像统计（公开只读，链下信誉索引——docs/ARCHITECTURE.md §3.9）。
 *
 * 口径（每项标注数据源与可审计性）：
 *  - 事件计数（托管单量/买家确认/超时释放/争议/仲裁判向）取自订单 onchain_events——
 *    watcher 对 Escrow 链上事件的**本地位移镜像**（每事件含 txHash/块号，可链上对账），
 *    节点虚报统计可被第三方重算戳穿；at 为节点轮询落库时刻（近似事件时刻，诚实标注）。
 *  - 仲裁判向不在事件史字段内（Arbitrated 参数未落库），以订单**终局状态**反推：
 *    refunded = 判买家 / settled = 判卖家（只统计**含 Arbitrated 事件**的行）。
 *    注意 refunded/settled 两态**也可由 `RefundApproved` 产生**（卖家同意退款 / 争议中和解，
 *    含部分退款——那类单没有 Arbitrated 事件，因此不计入判向统计）；拆分裁决按 settled
 *    计入判卖家侧（要区分"拆分"需另读 refundedAmountWei，见 docs/ARCHITECTURE.md §3.9）；
 *  - 发货耗时中位数 = delivered_at − OrderCreated.at，本地账 ⚠ 节点自述（可交叉抽样）；
 *  - 样本阈值：窗口内争议 < 5 笔时争议率/判买家率置 null（sampleTooSmall 标记），防小样本误导；
 *  - 隐私口径：只出聚合统计，不下发单笔订单（买家地址/商品/金额均不出现）。
 *
 * 量级：单节点一家店，全表扫描 + 行内 JSON 解析为毫秒级，公开只读低频端点不做缓存。
 */
import { getDb } from './db.js';

/** 时间窗（键按 JSON 输出；days=0 表示累计全量） */
const WINDOWS = [
  { key: 'all', days: 0 },
  { key: 'd365', days: 365 },
  { key: 'd90', days: 90 },
  { key: 'd30', days: 30 },
];

/** 争议样本阈值：低于该数的窗口争议相关率不展示（防小样本误导） */
const DISPUTE_SAMPLE_MIN = 5;

const DAY_MS = 24 * 3600 * 1000;

/** 纯统计函数（行：orders 表 status/onchain_events/delivered_at 三列；nowMs 供测试注入） */
export function computeReputation(rows, nowMs = Date.now()) {
  // 每窗聚合桶（事件计数 + 发货耗时样本）
  const win = {};
  for (const w of WINDOWS) {
    win[w.key] = {
      orders: 0, confirmed: 0, timeouts: 0, disputes: 0,
      settledToSeller: 0, refundedToBuyer: 0,
      deliveries: [], // 发货耗时样本（ms）
    };
  }
  let firstOrderAt = null;

  /** 事件 at 落入窗口？all 恒含；有界窗按落库时刻过滤 */
  const inWindow = (w, at) => w.days === 0 || at >= nowMs - w.days * DAY_MS;

  for (const row of rows) {
    let events = [];
    try {
      const parsed = JSON.parse(row.onchain_events || '[]');
      events = Array.isArray(parsed) ? parsed : [];
    } catch {
      events = [];
    }
    if (!events.length) continue;

    // 交付时刻（本地账：卖家发货写入）
    const deliveredAt = Number(row.delivered_at || 0) || null;
    let escrowedAt = null; // OrderCreated 落库时刻（托管入账近似）

    // ── 同源口径（评审修正，防 >100% 失真）──
    // 每笔订单以「OrderCreated 落库时刻」归属窗口（窗口语义 = 近 N 天创建的托管单），
    // 该单其后所有事件（确认/争议/仲裁/超时…）全部计入同一批窗口——
    // 比率分子分母同源：窗内不会出现「窗外创建的旧单在窗内确认/裁决」的孤儿分子，
    // confirmRate/disputeRate/refundRate 恒 ∈ [0,1]。
    for (const ev of events) {
      const at = Number(ev && ev.at) || 0;
      if (!at) continue; // 事件无时刻（异常数据）不参与统计
      if (ev.name === 'OrderCreated' && escrowedAt === null) escrowedAt = at;
    }
    /*
      **历史里找不到 `OrderCreated` 就整单跳过**（源码审计 2026-09 复审，P2）。
      `orders.onchain_events` 上限 20 条且保留**最后** 20 条（`slice(-20)`），而
      `PartialRefundAccepted` 是**可重复事件**（每次不同授权额各记一条）——买家对自己的一单
      调 20 次授权，就能把 `OrderCreated` 挤出历史。此时上面的兜底会把窗口锚点落到
      **最早的那些事件**上，于是这一单 `orders += 0` 而 `confirmed/disputes += 1`：
      比率的分母不含它、分子含它 ⇒ `confirmRate`/`disputeRate` **可以 > 1**（与上面那句
      "恒 ∈ [0,1]" 的承诺矛盾），而且是一个**低成本的画像操纵面**。
      宁可少统计一笔（画像本来只是参考信号），也不要让分子脱离分母。
    */
    if (escrowedAt === null) continue;
    const anchorAt = escrowedAt;
    if (!anchorAt) continue; // 全部事件无时刻：无法归属窗口
    const orderWindows = WINDOWS.filter((w) => inWindow(w, anchorAt));

    for (const ev of events) {
      const at = Number(ev && ev.at) || 0;
      if (!at) continue;
      if (ev.name === 'OrderCreated') {
        for (const w of orderWindows) win[w.key].orders += 1;
        if (firstOrderAt === null || at < firstOrderAt) firstOrderAt = at;
      } else if (ev.name === 'ReceiptConfirmed') {
        for (const w of orderWindows) win[w.key].confirmed += 1;
      } else if (ev.name === 'OrderExpiredReleased') {
        for (const w of orderWindows) win[w.key].timeouts += 1;
      } else if (ev.name === 'DisputeRequested') {
        for (const w of orderWindows) win[w.key].disputes += 1;
      } else if (ev.name === 'Arbitrated') {
        // 判向以终局状态反推（refunded=买家 / settled=卖家）；异常终局不计入判向
        if (row.status === 'refunded') {
          for (const w of orderWindows) win[w.key].refundedToBuyer += 1;
        } else if (row.status === 'settled') {
          for (const w of orderWindows) win[w.key].settledToSeller += 1;
        }
      }
    }

    // 发货耗时样本：按订单创建归属窗口（与事件计数同源；有交付记录且能取到托管时刻）
    if (deliveredAt && escrowedAt) {
      const span = deliveredAt - escrowedAt;
      for (const w of orderWindows) win[w.key].deliveries.push(span);
    }
  }

  /** 中位数（偶数取均值）；空样本返回 null */
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };

  /** 比率（分母 0 返回 null；4 位小数防浮点尾巴） */
  const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : null);

  const windows = {};
  const delivery = {};
  for (const w of WINDOWS) {
    const b = win[w.key];
    const disputes = b.disputes;
    const sampleTooSmall = disputes > 0 && disputes < DISPUTE_SAMPLE_MIN;
    windows[w.key] = {
      orders: b.orders,
      confirmed: b.confirmed,
      timeouts: b.timeouts,
      disputes,
      settledToSeller: b.settledToSeller,
      refundedToBuyer: b.refundedToBuyer,
      // 样本不足：争议相关率不展示（其余字段照常，窗内 0 争议视为健康而非样本问题）
      disputeRate: sampleTooSmall ? null : ratio(disputes, b.orders),
      refundRate: sampleTooSmall ? null : ratio(b.refundedToBuyer, disputes),
      confirmRate: ratio(b.confirmed, b.orders),
      timeoutRate: ratio(b.timeouts, b.orders),
      sampleTooSmall,
    };
    delivery[w.key] = { count: b.deliveries.length, medianMs: median(b.deliveries) };
  }

  return {
    windows,
    delivery,
    firstOrderAt,
    note: '事件计数源自节点对 Escrow 链上事件的镜像（txHash/块号可重算对账）；发货耗时为本地账（节点自述）。',
  };
}

/** 路由用便捷入口：全表统计（订单行含草稿/取消，无链上事件则自动跳过）。
 * 交付时刻已随 v2 数量模型迁至 order_delivery_items 子表（一单多行交付）：
 * 聚合取最晚交付行时刻，语义与原 delivered_at 列一致（发货耗时口径不变）。
 * **实物单兜底取 shipped_at**：实物单没有交付行（子表只记码/NFT），
 * 不兜底的话已发货的实物单会被算成"从未交付"，发货耗时中位数会丢掉这一大块样本。 */
export function reputationSummary() {
  const rows = getDb()
    .prepare(
      `SELECT o.status, o.onchain_events,
              COALESCE(
                (SELECT MAX(created_at) FROM order_delivery_items WHERE order_id = o.id),
                o.shipped_at
              ) AS delivered_at
       FROM orders o`
    )
    .all();
  return computeReputation(rows, Date.now());
}
