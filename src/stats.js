/**
 * 卖家经营看板统计（P1-①，ownerOnly 私域）。
 *
 * 口径（见 docs/ARCHITECTURE.md §3.1）：
 *  - 入账（GMV）= confirmed/settled/expired 的净额（金额 − 订单级 feeBps 折算，与收款流水一致）；
 *  - 退款额 = refunded 单托管毛额合计（单独口径，不与 GMV 净混合）；
 *  - 买家/复购按 address 去重计数（成交 ≥1 / ≥2 单）；
 *  - 时间窗口按本地入账时刻（orders.updated_at 终局迁移时间）归属；days=0 表示全量；
 *    overview/products 用滚动窗（最近 days×24h），trend 用自然日窗（本地今天零点起
 *    days 个完整日，见 trendStats——D6 对齐）；days 参数缺省/非法/越界统一归一
 *    （normalizeStatsDays：缺省给默认、0=全量、>366 钳制、非整数/负值拒绝——D7）；
 *  - 趋势按天补零；全部 BigInt 精确累加（与 ledger 同模式，不依赖 SQLite SUM 精度）。
 */
import { getDb } from './db.js';
import { feeOf as feeOfChain, netOf as netOfChain } from './fees.js';

const INCOME = ['confirmed', 'settled', 'expired'];

const DAY_MS = 24 * 3600 * 1000;
/** 看板窗口天数上限（含默认档；0=全量单列语义，不受此限） */
export const STATS_MAX_DAYS = 366;

// 平台费/净额一律走 src/fees.js（**唯一实现**；判据是**每单**的创建时收取方快照
// fee_collector_at_create——合约只读快照，全局 feeCollector() 事后可改，不能替代它）
const feeOf = (amountWei, feeBps, feeCollectorAtCreate) => feeOfChain(amountWei, feeBps, feeCollectorAtCreate);
const netOf = (amountWei, feeBps, feeCollectorAtCreate) => netOfChain(amountWei, feeBps, feeCollectorAtCreate);

/**
 * 看板 days 参数归一（D7：缺省/非法/越界统一钳制——此前 overview 缺省被 ||0 吞成全量、
 * products 负 days 直接给空看板，口径分裂）：
 *  - 缺省（undefined/''）→ def（路由默认：overview/products 30、trend 14）；
 *  - 显式 0 → 全量（单列语义，返回 0）；
 *  - 非整数/负值 → null（调用方报 days 无效）；
 *  - > STATS_MAX_DAYS → 钳制到 STATS_MAX_DAYS（一年窗口封顶；真全量请用 0）。
 */
export function normalizeStatsDays(raw, def) {
  if (raw === undefined || raw === '') return Number.isInteger(def) && def > 0 ? def : 0;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n === 0) return 0;
  if (n < 0) return null;
  return Math.min(n, STATS_MAX_DAYS);
}

/** 时间窗口过滤表达式片段与参数（按最近 days 天；days=0 全量） */
function windowWhere(days, prefix = 'o.') {
  if (!days) return { where: '', params: [] };
  const from = Date.now() - days * DAY_MS;
  return { where: ` AND ${prefix}updated_at >= ?`, params: [from] };
}

/** 本地时区「今天零点」（趋势/窗口对齐基准——桶与 SQL 用同一零点，避免滚动 now 错位） */
function startOfToday(nowMs = Date.now()) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 入账单行（窗口内）；退款金额随行取（upd 2026-09：支持部分退款，退款额不再等于整单金额）；
 *  平台费按行的 fee_collector_at_create（创建时收取方快照）判定，故该列必须取出 */
function incomeRows(days) {
  const db = getDb();
  const marks = INCOME.map(() => '?').join(',');
  const w = windowWhere(days);
  return db
    .prepare(`SELECT id, buyer, product_id, quantity, amount_wei, fee_bps, fee_collector_at_create, refunded_amount_wei, status, updated_at
              FROM orders o WHERE o.status IN (${marks})${w.where}`)
    .all(...INCOME, ...w.params);
}

/**
 * 退款行（窗口内）：**所有**有退款的行（含拆分结算的成交单），退款额取 `refunded_amount_wei`
 * 而不是整单金额——部分退款后按整额统计会把退款额虚增（源码审计 2026-09）。
 */
function refundedRows(days) {
  const w = windowWhere(days);
  return getDb()
    .prepare(
      `SELECT amount_wei, refunded_amount_wei, updated_at FROM orders o
        WHERE refunded_amount_wei IS NOT NULL AND refunded_amount_wei != '0'${w.where}`
    )
    .all(...w.params);
}

/** 汇总卡（days=0 全量；默认 30 由路由层给） */
export function overviewStats(days) {
  const rows = incomeRows(days);
  const refunds = refundedRows(days);
  let gmvNetWei = 0n;
  let refundWei = 0n;
  let units = 0;
  let confirmed = 0;
  const buyers = new Set();
  const buyerOrders = new Map();
  const soldProducts = new Set();
  for (const r of rows) {
    // 净额 = 托管额 − 已退买家 − 平台费（部分退款后只对未退部分计费，与链上 Escrow._settle 一致；
    // 平台费按该单的创建时收取方快照判定）
    const refunded = BigInt(r.refunded_amount_wei || '0');
    const base = BigInt(r.amount_wei || '0') - refunded;
    gmvNetWei += netOf(base > 0n ? base : 0n, Number(r.fee_bps || 0), r.fee_collector_at_create);
    units += r.quantity || 1;
    confirmed += r.status === 'confirmed' ? 1 : 0;
    buyers.add(r.buyer);
    buyerOrders.set(r.buyer, (buyerOrders.get(r.buyer) || 0) + 1);
    soldProducts.add(r.product_id);
  }
  // 退款总额 = Σ 实际退回买家的金额（含拆分结算的成交单；不再按整单金额统计）
  for (const r of refunds) refundWei += BigInt(r.refunded_amount_wei || '0');
  const repeatBuyers = [...buyerOrders.values()].filter((n) => n >= 2).length;
  const activeProducts = getDb().prepare('SELECT COUNT(*) AS c FROM products WHERE active = 1').get().c;
  return {
    orders: rows.length,
    units,
    gmvNetWei: gmvNetWei.toString(),
    refundOrders: refunds.length,
    refundWei: refundWei.toString(),
    buyers: buyers.size,
    repeatBuyers,
    confirmRate: rows.length > 0 ? Math.round((confirmed / rows.length) * 10000) / 10000 : null,
    soldProducts: soldProducts.size,
    activeProducts,
  };
}

/**
 * 最近 N 天趋势（按本地入账时刻分日；补零）。
 * D6 对齐：桶与 SQL 窗口同用「本地今天零点 − (days−1) 天」的自然日起点（而非
 * 滚动 now−days×24h）——旧实现窗口比桶宽一天且随运行时刻漂移：午夜前后同一笔单
 * 可能落错日/被静默丢弃（桶外行 add 无门直接忽略），第 0 桶实际只覆盖半日。
 * days<=0 时按最近 31 个自然日（兼容旧直调形态；路由层已归一为正数）。
 */
export function trendStats(days) {
  const db = getDb();
  const eff = days > 0 ? days : 31;
  const start = startOfToday() - (eff - 1) * DAY_MS; // 本地今天零点起往前 eff 天（含今天）
  const dayKey = (ms) => {
    const d = new Date(Number(ms));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  // 窗口 = [start, 现在]：与 eff 个自然日桶严格同界（桶 key 由同一 start 逐日 +DAY 生成，
  // 与行归属同公式，杜绝滚动窗口的日界错位/漏日）
  const marks = INCOME.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT amount_wei, fee_bps, fee_collector_at_create, updated_at FROM orders o
       WHERE o.status IN (${marks}) AND o.updated_at >= ?`
    )
    .all(...INCOME, start);
  const refunds = db
    .prepare(
      `SELECT amount_wei, refunded_amount_wei, updated_at FROM orders o
        WHERE o.refunded_amount_wei IS NOT NULL AND o.refunded_amount_wei != '0' AND o.updated_at >= ?`
    )
    .all(start);

  const buckets = new Map();
  for (let i = 0; i < eff; i++) {
    const key = dayKey(start + i * DAY_MS);
    buckets.set(key, { day: key, orders: 0, netWei: '0', refundWei: '0' });
  }
  const add = (key, field, v) => {
    const b = buckets.get(key);
    if (!b) return;
    if (field === 'orders') b.orders += v;
    else b[field] = (BigInt(b[field]) + v).toString();
  };
  for (const r of rows) {
    const b = buckets.get(dayKey(r.updated_at));
    if (b) {
      b.orders += 1;
      const base = BigInt(r.amount_wei || '0') - BigInt(r.refunded_amount_wei || '0');
      b.netWei = (BigInt(b.netWei) + netOf(base > 0n ? base : 0n, Number(r.fee_bps || 0), r.fee_collector_at_create)).toString();
    }
  }
  for (const r of refunds) add(dayKey(r.updated_at), 'refundWei', BigInt(r.refunded_amount_wei || '0'));
  return [...buckets.values()];
}

/** 商品维度排行（窗口内入账聚合；sort=gmv|orders|refund；退款列与窗口口径一致） */
export function productStats(days, sort = 'gmv', page = 1, pageSize = 20) {
  const rows = incomeRows(days);
  // 退款毛额与退款单数统一按窗口过滤（与 overview/trend 同口径）
  const marks = windowWhere(days);
  const refundRows = getDb()
    .prepare(
      `SELECT product_id, amount_wei, refunded_amount_wei, COUNT(*) OVER (PARTITION BY product_id) AS order_count
       FROM orders o WHERE o.refunded_amount_wei IS NOT NULL AND o.refunded_amount_wei != '0' AND o.product_id IS NOT NULL${marks.where}`
    )
    .all(...marks.params);
  const refundWeiByProduct = new Map();
  const refundCountByProduct = new Map();
  for (const r of refundRows) {
    refundWeiByProduct.set(r.product_id, (refundWeiByProduct.get(r.product_id) || 0n) + BigInt(r.refunded_amount_wei || '0'));
    refundCountByProduct.set(r.product_id, r.order_count);
  }
  const agg = new Map(); // product_id -> {...}
  for (const r of rows) {
    const key = r.product_id;
    if (key == null) continue;
    const a = agg.get(key) || { units: 0, orders: 0, netWei: 0n, buyers: new Set(), lastSaleAt: 0 };
    a.orders += 1;
    a.units += r.quantity || 1;
    const baseP = BigInt(r.amount_wei || '0') - BigInt(r.refunded_amount_wei || '0');
    a.netWei += netOf(baseP > 0n ? baseP : 0n, Number(r.fee_bps || 0), r.fee_collector_at_create);
    a.buyers.add(r.buyer);
    a.lastSaleAt = Math.max(a.lastSaleAt, Number(r.updated_at || 0));
    agg.set(key, a);
  }
  const db = getDb();
  const rowsOut = [];
  for (const [productId, a] of agg) {
    const p = db.prepare('SELECT slug, title, active FROM products WHERE id = ?').get(productId);
    rowsOut.push({
      productId,
      slug: p ? p.slug : `#${productId}`,
      title: p ? p.title : '(商品已删除)',
      active: p ? !!p.active : false,
      orders: a.orders,
      units: a.units,
      netWei: a.netWei.toString(),
      refundWei: (refundWeiByProduct.get(productId) || 0n).toString(),
      refunds: refundCountByProduct.get(productId) || 0,
      buyers: a.buyers.size,
      lastSaleAt: a.lastSaleAt || null,
    });
  }

  // 稳定排序：相等返回 0此前恒 -1 使等值项顺序依赖引擎、JS sort 不稳）
  const byNetDesc = (a, b) => {
    const d = BigInt(b.netWei) - BigInt(a.netWei);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  };
  const cmp = {
    gmv: byNetDesc,
    orders: (a, b) => b.orders - a.orders,
    refund: (a, b) => {
      const d = BigInt(b.refundWei) - BigInt(a.refundWei);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    },
  }[sort] || byNetDesc;
  rowsOut.sort(cmp);
  const total = rowsOut.length;
  const paged = rowsOut.slice((page - 1) * pageSize, page * pageSize);
  return { products: paged, total, page, pageSize };
}
