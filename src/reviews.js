/**
 * 买家评价数据层（P0-1）：成交订单一单一评 + 店主单次回复 + 商品/店铺聚合。
 *
 * 口径（见 docs/ARCHITECTURE.md §3.1）：
 *  - 资格：status ∈ (confirmed/settled/expired) 且（now - updated_at）≤ MK_REVIEW_TTL_DAYS；
 *    refunded/cancelled 不可评（与收款流水成交口径一致）；
 *  - 一次一单：reviews.order_id UNIQUE 硬约束（DB 兜底 + 应用层预检给友好错误）；
 *  - 公开面：列表只出聚合与买家短地址（0x1234…abcd），不下发完整地址/金额；
 *  - 防刷局限（自买自评）与履约画像同权：仅作参考信号，不设平台审核。
 */
import { getDb } from './db.js';
import config from './config.js';
import { INCOME_STATUS as ORDER_INCOME_STATUS } from './orderStatus.js';

/** 可评价（成交）状态：与收款流水 INCOME_STATUS 同口径 */
export const REVIEWABLE_STATUS = ORDER_INCOME_STATUS; // 与入账口径同源：钱到卖家手里才可评价

/** 买家短地址展示（0x1234…abcd） */
export function shortBuyer(address) {
  const a = String(address || '');
  return a.length <= 10 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** 订单当前是否在可评价窗口（TTL 从终局迁移时刻 updated_at 起算） */
export function reviewableAt(order, nowMs = Date.now()) {
  if (!order) return false;
  if (!REVIEWABLE_STATUS.includes(order.status)) return false;
  const ttlMs = config.review.ttlDays * 24 * 3600 * 1000;
  return Number(order.updated_at || 0) > 0 && nowMs - Number(order.updated_at) <= ttlMs;
}

/** 读取订单既有评价（含店主回复）；无则 null */
export function findReviewByOrder(orderId) {
  return getDb().prepare('SELECT * FROM reviews WHERE order_id = ?').get(String(orderId || '')) || null;
}

/**
 * 买家提交评价。返回 {ok, error?} 语义（错误信息由调用方转 fail）。
 */
export function submitReview({ order, buyer, rating, content }) {
  const now = Date.now();
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) return { error: 'rating 需为 1..5 的整数' };
  const text = String(content ?? '').trim();
  if (text.length > 1000) return { error: '评价内容不能超过 1000 字' };
  if (String(order.buyer || '').toLowerCase() !== String(buyer || '').toLowerCase()) {
    return { error: '仅买家本人可评价该订单', forbidden: true };
  }
  if (!REVIEWABLE_STATUS.includes(order.status)) {
    return { error: `当前状态(${order.status})不可评价——仅成交终局（确认收货/仲裁判付/超时释放）订单可评` };
  }
  if (!reviewableAt(order, now)) return { error: '已超过可评价期限（成交后 TTL 内有效）' };
  const db = getDb();
  try {
    db.prepare(
      'INSERT INTO reviews (order_id, product_id, buyer, rating, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(order.id, order.product_id, String(buyer).toLowerCase(), r, text, now, now);
  } catch (e) {
    if (/SQLITE_CONSTRAINT|UNIQUE constraint/i.test(String(e.code || '') + ' ' + String(e.message || ''))) {
      return { error: '该订单已评价过（一单一评）' };
    }
    throw e;
  }
  return { ok: true };
}

/** 店主回复评价（单次）。 */
export function replyReview({ order, owner, content }) {
  const text = String(content ?? '').trim();
  if (!text) return { error: '回复内容不能为空' };
  if (text.length > 1000) return { error: '回复内容不能超过 1000 字' };
  const now = Date.now();
  const changed = getDb()
    .prepare(
      "UPDATE reviews SET reply_content = ?, reply_at = ?, updated_at = ? WHERE order_id = ? AND reply_at IS NULL AND reply_content = ''"
    )
    .run(text, now, now, order.id).changes;
  if (changed === 0) {
    return { error: '该评价已回复过或不存在（单次回复）' };
  }
  return { ok: true };
}

/** 公开单条评价（匿名短地址；不含买家完整地址与订单金额） */
export function reviewToPublic(row) {
  return {
    id: row.id,
    rating: row.rating,
    content: row.content || null,
    buyerShort: shortBuyer(row.buyer),
    reply: row.reply_content || null,
    replyAt: row.reply_at || null,
    createdAt: row.created_at,
  };
}

/**
 * 商品评价聚合（count/avg；详情页与评价列表共用）。
 *
 * 刻意**不下发评分分布**：界面只在商品卡与详情页用「平均分 + 条数」这一个概览，
 * 分布直方图已经移除。多算一条 GROUP BY 查询、多传一份没人用的数据没有意义，
 * 而且分布本身在小样本下极易被误读（3 条评价的柱状图什么也说明不了）。
 */
export function productReviewSummary(productId) {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(rating),0) AS s FROM reviews WHERE product_id = ?')
    .get(productId);
  return {
    count: row.c,
    avg: row.c > 0 ? Math.round((row.s / row.c) * 10) / 10 : null,
  };
}

/**
 * 商品评价列表（服务端筛选 + 排序 + 分页）。
 *
 * **筛选与排序必须在服务端做**：它们如果只作用于"这一页已加载的 10 条"，
 * 用户点「差评」看到的其实只是"最近 10 条里的差评"——差评在更早的页里就直接消失了，
 * 这种"看起来筛了、其实只筛了一页"是最坏的一种界面谎言（评价数据尤其敏感）。
 *
 * @param {'all'|'good'|'bad'} filter 全部 / 好评（≥4 星）/ 差评（≤3 星）
 * @param {'new'|'old'|'high'|'low'} sort 最新 / 最早 / 评分高→低 / 评分低→高
 */
export function productReviews(slug, page, pageSize, filter = 'all', sort = 'new') {
  const db = getDb();
  const product = db.prepare('SELECT id FROM products WHERE slug = ?').get(String(slug || ''));
  if (!product) return null;

  // 白名单拼 SQL（不把用户输入带进语句；只有这三个片段可能出现在 WHERE 里）
  const where =
    filter === 'good' ? ' AND rating >= 4' : filter === 'bad' ? ' AND rating <= 3' : '';
  const order =
    sort === 'old'
      ? 'created_at ASC'
      : sort === 'high'
        ? 'rating DESC, created_at DESC'
        : sort === 'low'
          ? 'rating ASC, created_at DESC'
          : 'created_at DESC';

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM reviews WHERE product_id = ?${where}`)
    .get(product.id).c;
  const rows = db
    .prepare(`SELECT * FROM reviews WHERE product_id = ?${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(product.id, pageSize, (page - 1) * pageSize);
  return {
    // summary 始终是**全量**聚合（与筛选无关）：它是"这个商品总体怎么样"，筛选只影响列表
    summary: productReviewSummary(product.id),
    total,
    /** 全部评价条数（未筛选）——用于"筛选后 N 条 / 共 M 条"的文案 */
    totalAll: db.prepare('SELECT COUNT(*) AS c FROM reviews WHERE product_id = ?').get(product.id).c,
    filter,
    sort,
    page,
    pageSize,
    items: rows.map(reviewToPublic),
  };
}

/** 店铺级评价聚合（公开） */
export function shopReviewStats() {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(rating),0) AS s FROM reviews').get();
  return { count: row.c, avg: row.c > 0 ? Math.round((row.s / row.c) * 10) / 10 : null };
}
