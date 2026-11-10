/**
 * 节点内「综合」排序：按商品成交、评价、新鲜度与**店铺可信度**打分。
 *
 * 为什么在节点侧算、而不是前端：首页/店铺页的「综合」是默认流，分页必须按同一个
 * 顺序跨页推进；前端对“已加载的那一页”重排只能得到这一页里的相对顺序，第二页会
 * 和第一页打架。
 *
 * 为什么不落库/不建表：节点的 `db.js` 对 schema 做指纹门禁（多一列/一张表就拒绝启动，
 * 见 docs/OPERATIONS.md 的“数据库结构”），本仓不提供结构迁移。因此这里每次请求
 * 从既有表读事实、在内存里算分；**无筛选的默认流**用 Redis 共享快照（15 秒 TTL，
 * 只缓存排好序的 ID）兜住热路径，筛选组合仍实时计算。真到瓶颈再加长快照时间。
 *
 * 分数只用于**展示顺序**，不参与付款、托管、信任徽标或任何资金判断。
 */
import crypto from 'node:crypto';
import { getDb } from './db.js';
import { redisGetJson, redisSetJson } from './redis.js';
import { productPublicSql } from './shops.js';

const DAY_MS = 86400_000;
const SCALE = 1_000_000;

/** 售罄商品的天花板：可以留在列表里，但不能压过有货的商品 */
const SOLD_OUT_CAP = 200_000;
/** 综合排序快照：只缓存无筛选的默认流；15 秒内翻页稳定，之后重算 */
const RANK_CACHE_TTL_MS = 15_000;
const RANK_CACHE_MAX_IDS = 5_000;

/** 商品分：成交 50% + 质量 25% + 新鲜度 10% + 店铺可信度 15% */
const W_DEMAND = 0.50;
const W_QUALITY = 0.25;
const W_FRESH = 0.10;
const W_SHOP = 0.15;

/** 店铺可信度：成交面 55% + 退款可靠度 35% + 店龄 10% */
const W_SHOP_DEMAND = 0.55;
const W_SHOP_RELIABILITY = 0.35;
const W_SHOP_TENURE = 0.10;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(n) {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

/** 对数封顶：v 达到 at 时记 1，再高不再加分（防止大户/爆单把其余信号压成 0） */
function capLog(v, at) {
  const n = num(v);
  if (n <= 0) return 0;
  return Math.min(1, Math.log1p(n) / Math.log1p(at));
}

/**
 * 店铺可信度（0..1）。只读节点自己的事实：
 *  - 近 90 天成交单/买家（`confirmed/settled` 且未退款）——有没有真实的交易记录；
 *  - 退款率——记录是否可靠；
 *  - 店龄——老店本身就是可核实的经营历史。
 *
 * 新店（0 单、0 年龄）得 0；一个 90 天/30 单/20 买家/无退款的老店接近 1。
 * 不用评价做先验：评价已经在商品质量里，重复计会把“会刷评价的店”放大两次。
 */
export function shopTrustOf({ orders90, buyers90, refunded90, completed90, ageDays }) {
  const orders = num(orders90);
  const buyers = num(buyers90);
  const refunded = num(refunded90);
  const completed = num(completed90);
  const demand = 0.60 * capLog(orders, 30) + 0.40 * capLog(buyers, 20);
  const refundRate = refunded / Math.max(1, completed);
  const reliability = (1 - clamp01(refundRate / 0.20)) * capLog(orders, 10);
  const tenure = 1 - Math.exp(-Math.max(0, num(ageDays)) / 90);
  return clamp01(W_SHOP_DEMAND * demand + W_SHOP_RELIABILITY * reliability + W_SHOP_TENURE * tenure);
}

/**
 * 商品分（0..1_000_000 的整数）。
 *
 * 成交：单数/买家数/件数都取近 30 天，分别封顶在 20 单/15 买家/30 件；
 * 质量：贝叶斯平均（先验 4.0★、5 条权重）+ 退款可靠度；
 * 新鲜度：**首次上架时刻**（`published_at`，无则回退 `created_at`）的 30 天半衰；
 * 店铺可信度：见 `shopTrustOf`。
 *
 * 自买、退款、超时释放等剔除在 SQL 侧（见 rankProductRows），这里只拿已清洗的计数。
 */
export function productScoreOf({
  orders30,
  buyers30,
  units30,
  reviews,
  ratingSum,
  orders90,
  refunded90,
  ageDays,
  shopTrust,
}) {
  const demand =
    0.50 * capLog(orders30, 20) +
    0.30 * capLog(buyers30, 15) +
    0.20 * capLog(units30, 30);

  const n = num(reviews);
  const bayes = (num(ratingSum) + 4.0 * 5) / (n + 5);
  const rating = clamp01((bayes - 3) / 2);
  const reviewConf = capLog(n, 20);
  const orderConf = capLog(orders90, 10);
  const refundRate = num(refunded90) / Math.max(1, num(orders90));
  const reliability = (1 - clamp01(refundRate / 0.20)) * orderConf;
  const quality = 0.70 * rating * reviewConf + 0.30 * reliability;

  const fresh = Math.exp(-Math.max(0, num(ageDays)) / 30);

  const score = W_DEMAND * demand + W_QUALITY * quality + W_FRESH * fresh + W_SHOP * clamp01(shopTrust);
  return Math.round(clamp01(score) * SCALE);
}

/** 列值 → 天数。读不到/非法时不凭空给新鲜度或店龄（product 用大年龄，shop 用 0）。 */
function ageDaysOf(value, now, fallbackDays) {
  const raw = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  if (!Number.isFinite(raw)) return fallbackDays;
  return Math.max(0, (now - raw) / DAY_MS);
}

/**
 * 售罄判据：只看**有库存来源且来源已耗尽**的商品。
 *  - SKU：有行且没有一行 `capacity IS NULL || committed < capacity` ⇒ 限量售罄；
 *  - digital：有码池且全部 used ⇒ 售罄；无码池 = 手动交付，不判售罄；
 *  - nft：有 token 池且全部 used ⇒ 售罄；无池不判售罄。
 * 没有库存来源（0 行）不判售罄：手动交付型商品本来就没有池。
 */
export function isSoldOut({
  kind,
  skuTotal,
  skuAvailable,
  codeTotal,
  codeAvailable,
  tokenTotal,
  tokenAvailable,
}) {
  if (num(skuTotal) > 0 && num(skuAvailable) === 0) return true;
  if (kind === 'digital' && num(codeTotal) > 0 && num(codeAvailable) === 0) return true;
  if (kind === 'nft' && num(tokenTotal) > 0 && num(tokenAvailable) === 0) return true;
  return false;
}

/** 售罄只封顶、不隐藏：让它在有货商品之后，但仍可被搜到/买到（补货后自然回来）。 */
export function applyAvailability(score, soldOut) {
  return soldOut ? Math.min(score, SOLD_OUT_CAP) : score;
}

function rankCacheKey(whereSql, args) {
  const digest = crypto
    .createHash('sha1')
    .update(whereSql)
    .update('\0')
    .update(JSON.stringify(args))
    .digest('hex')
    .slice(0, 24);
  return `rank:ids:${digest}`;
}

/**
 * 返回按综合分排好序的一页商品行（**完整行**，调用方继续走 withSkusBatch/rowToPublic）。
 *
 * `whereSql`/`args` 是路由已经拼好的公开可见性 + 关键词/标签/参数/类型/店铺作用域；
 * 这里不再复制一份筛选逻辑（否则“列表能筛到的”和“排序里算的”迟早不是同一集合）。
 *
 * `cursor` 是 offset（composite 专用）；`nextCursor` 为下一页 offset，到底为 null。
 */
export async function rankProductRows({
  whereSql,
  args,
  shopCode = null,
  offset = 0,
  pageSize = 30,
  cacheable = false,
  now = Date.now(),
}) {
  const db = getDb();
  if (!whereSql) return { rows: [], nextCursor: null };

  /*
    只给**无筛选**的默认流做共享快照：这是首页/店铺页的热路径，也是唯一值得
    用固定 ID 列表稳定翻页的地方。筛选组合数量不可控，直接实时算；Redis 读取/
    写入失败一律回退实时计算——快照是优化，不是列表可用性的前提。
  */
  const cacheKey = cacheable ? rankCacheKey(whereSql, args) : null;
  let idsAll = null;
  if (cacheKey) {
    try {
      const cached = await redisGetJson(cacheKey);
      if (Array.isArray(cached) && cached.every((x) => Number.isSafeInteger(x))) idsAll = cached;
    } catch {
      /* 缓存不可用：继续走实时计算 */
    }
  }

  if (!idsAll) {
    const candidates = await db.all(
      `SELECT id, shop_code, kind, COALESCE(published_at, created_at) AS listed_at
         FROM products WHERE ${whereSql}`,
      ...args
    );
    if (candidates.length === 0) return { rows: [], nextCursor: null };

    const shopCodes = [...new Set(candidates.map((p) => String(p.shop_code)))];
    const shopMarks = shopCodes.map(() => '?').join(',');
    const shopScope = shopCode ? ' AND v.shop_code = ?' : '';
    const shopArgs = shopCode ? [String(shopCode)] : [];

    /*
      订单窗口：近 90 天里**已完成**的单（confirmed/settled/refunded）。
      30 天需求只取 confirmed/settled 且未退款；退款单进 reliability 的分母。
      `expired`（超时释放）与 `disputed`（未终局）一律不进：它们不证明买家满意。
    */
    const [productAggRows, shopAggRows, reviewRows, shopRows, availabilityRows] = await Promise.all([
      db.all(
        `SELECT v.product_id,
            SUM(CASE WHEN v.status IN ('confirmed','settled')
                      AND COALESCE(v.refunded_amount_wei, 0) = 0
                      AND v.updated_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY)
                     THEN 1 ELSE 0 END) AS orders30,
            COUNT(DISTINCT CASE WHEN v.status IN ('confirmed','settled')
                      AND COALESCE(v.refunded_amount_wei, 0) = 0
                      AND v.updated_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY)
                     THEN v.buyer END) AS buyers30,
            SUM(CASE WHEN v.status IN ('confirmed','settled')
                      AND COALESCE(v.refunded_amount_wei, 0) = 0
                      AND v.updated_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY)
                     THEN v.quantity ELSE 0 END) AS units30,
            SUM(CASE WHEN v.status = 'refunded' OR COALESCE(v.refunded_amount_wei, 0) > 0
                     THEN 1 ELSE 0 END) AS refunded90,
            COUNT(*) AS orders90
           FROM v_orders v
          WHERE v.status IN ('confirmed','settled','refunded')
            AND v.updated_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 90 DAY)
            AND v.buyer <> v.seller${shopScope}
          GROUP BY v.product_id`,
        ...shopArgs
      ),
      db.all(
        `SELECT v.shop_code,
            SUM(CASE WHEN v.status IN ('confirmed','settled')
                      AND COALESCE(v.refunded_amount_wei, 0) = 0
                     THEN 1 ELSE 0 END) AS orders90,
            COUNT(DISTINCT CASE WHEN v.status IN ('confirmed','settled')
                      AND COALESCE(v.refunded_amount_wei, 0) = 0
                     THEN v.buyer END) AS buyers90,
            SUM(CASE WHEN v.status = 'refunded' OR COALESCE(v.refunded_amount_wei, 0) > 0
                     THEN 1 ELSE 0 END) AS refunded90,
            COUNT(*) AS completed90
           FROM v_orders v
          WHERE v.status IN ('confirmed','settled','refunded')
            AND v.updated_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 90 DAY)
            AND v.buyer <> v.seller${shopScope}
          GROUP BY v.shop_code`,
        ...shopArgs
      ),
      db.all(
        `SELECT r.product_id, COUNT(*) AS n, COALESCE(SUM(r.rating), 0) AS rating_sum
           FROM reviews r
           JOIN v_orders v ON v.order_id = r.order_id
          WHERE v.status IN ('confirmed','settled')
            AND COALESCE(v.refunded_amount_wei, 0) = 0
            AND v.buyer <> v.seller
            AND r.created_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 365 DAY)${shopScope}
          GROUP BY r.product_id`,
        ...shopArgs
      ),
      db.all(`SELECT code, created_at FROM shops WHERE code IN (${shopMarks})`, ...shopCodes),
      /*
        库存来源：SKU 限量 + 数字码池 + NFT token 池。一次 CTE 候选表，三张来源
        UNION 成一份读数；没有来源（0 行）不判售罄（手动交付型商品本来没有池）。
      */
      db.all(
        `WITH candidates AS (SELECT id FROM products WHERE ${whereSql})
         SELECT 'sku' AS src, s.product_id, COUNT(*) AS total,
                SUM(CASE WHEN s.capacity IS NULL OR s.committed < s.capacity THEN 1 ELSE 0 END) AS available
           FROM product_skus s JOIN candidates c ON c.id = s.product_id
          WHERE s.active = 1
          GROUP BY s.product_id
         UNION ALL
         SELECT 'code', pc.product_id, COUNT(*), SUM(pc.status = 'unused')
           FROM product_codes pc JOIN candidates c ON c.id = pc.product_id
          GROUP BY pc.product_id
         UNION ALL
         SELECT 'token', pt.product_id, COUNT(*), SUM(pt.status = 'unused')
           FROM product_nft_tokens pt JOIN candidates c ON c.id = pt.product_id
          GROUP BY pt.product_id`,
        ...args
      ),
    ]);

    const productAgg = new Map(productAggRows.map((r) => [Number(r.product_id), r]));
    const shopAgg = new Map(shopAggRows.map((r) => [String(r.shop_code), r]));
    const reviewAgg = new Map(reviewRows.map((r) => [Number(r.product_id), r]));
    const shopCreated = new Map(shopRows.map((r) => [String(r.code), r.created_at]));

    const stock = new Map();
    for (const r of availabilityRows) {
      const id = Number(r.product_id);
      const s = stock.get(id) || {
        skuTotal: 0,
        skuAvailable: 0,
        codeTotal: 0,
        codeAvailable: 0,
        tokenTotal: 0,
        tokenAvailable: 0,
      };
      const total = num(r.total);
      const available = num(r.available);
      if (r.src === 'sku') {
        s.skuTotal = total;
        s.skuAvailable = available;
      } else if (r.src === 'code') {
        s.codeTotal = total;
        s.codeAvailable = available;
      } else if (r.src === 'token') {
        s.tokenTotal = total;
        s.tokenAvailable = available;
      }
      stock.set(id, s);
    }

    const scored = candidates.map((p) => {
      const id = Number(p.id);
      const pa = productAgg.get(id) || {};
      const ra = reviewAgg.get(id) || {};
      const shop = shopAgg.get(String(p.shop_code)) || {};
      const trust = shopTrustOf({
        orders90: shop.orders90,
        buyers90: shop.buyers90,
        refunded90: shop.refunded90,
        completed90: shop.completed90,
        ageDays: ageDaysOf(shopCreated.get(String(p.shop_code)), now, 0),
      });
      const soldOut = isSoldOut({ kind: p.kind, ...(stock.get(id) || {}) });
      return {
        id,
        score: applyAvailability(
          productScoreOf({
            orders30: pa.orders30,
            buyers30: pa.buyers30,
            units30: pa.units30,
            reviews: ra.n,
            ratingSum: ra.rating_sum,
            orders90: pa.orders90,
            refunded90: pa.refunded90,
            ageDays: ageDaysOf(p.listed_at, now, 365),
            shopTrust: trust,
          }),
          soldOut
        ),
      };
    });

    // 同分按 id 倒序：分页偏移必须落在确定顺序上，不能依赖 MySQL 的任意返回顺序
    scored.sort((a, b) => b.score - a.score || b.id - a.id);
    idsAll = scored.map((x) => x.id);
    if (cacheKey && idsAll.length <= RANK_CACHE_MAX_IDS) {
      // 写入不阻塞当前响应；失败只意味着下一次还要重算
      void redisSetJson(cacheKey, idsAll, RANK_CACHE_TTL_MS).catch(() => {});
    }
  }

  const page = idsAll.slice(offset, offset + pageSize + 1);
  const hasMore = page.length > pageSize;
  const chosen = hasMore ? page.slice(0, pageSize) : page;
  const ids = chosen;
  if (ids.length === 0) return { rows: [], nextCursor: null };

  const marks = ids.map(() => '?').join(',');
  // 再核一次公开可见性：候选查询与取整行之间商品可能被下架/节点隐藏/店铺暂停。
  // 只补可见性、不重放筛选——筛选变化是另一个请求的代际，交给前端重置。
  const rows = await db.all(
    `SELECT * FROM products WHERE id IN (${marks}) AND ${productPublicSql()}`,
    ...ids
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return {
    rows: ids.map((id) => byId.get(id)).filter(Boolean),
    nextCursor: hasMore ? offset + pageSize : null,
  };
}
