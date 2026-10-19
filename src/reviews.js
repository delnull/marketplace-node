/**
 * 买家评价数据层（P0-1）：成交订单一单一评 + 店主单次回复 + 商品/店铺聚合。
 *
 * 口径：
 *  - 资格：status ∈ (confirmed/settled/expired) 且（now − updated_at）≤ MK_REVIEW_TTL_DAYS；
 *    refunded/cancelled 不可评（与收款流水成交口径一致）；
 *  - 一次一单：`reviews.order_id` UNIQUE 硬约束（DB 兜底 + 应用层预检给友好错误）；
 *  - 公开面：列表只出聚合与买家短地址（0x1234…abcd），不下发完整地址/金额；
 *  - 防刷局限（自买自评）与履约画像同权：仅作参考信号，不设平台审核。
 *
 * ## 键、时间与聚合三件事（本文件最容易写错的地方）
 *
 *  - `reviews.order_id` 是**订单内部键**（外键 → `orders.id`，并带 UNIQUE = 一单一评），
 *    不是对外单号 `orders.order_no`。本模块的 `order` 入参是读模型 `v_orders` 的行，
 *    内部键在那里叫 `order_id`（**没有 `id`**：旧写法 `order.id` 会拿到 undefined，
 *    在绑定参数处直接抛错，而不是静默插一条指向别处的评价）。
 *  - 时间是 `DATETIME(3)`，读出来是 `Date`，比较也在 `Date` 上做（见 `reviewableAt`）。
 *    写入口一律让**服务器**盖章（`CURRENT_TIMESTAMP(3)`）：不传 `Date.now()`——毫秒整数会被
 *    MySQL 当成数字字面量解析成一个荒谬的时刻，而且不报错。
 *  - **聚合值必须显式 `Number(...)`**：`SUM()` 在 MySQL 里返回 DECIMAL，而驱动是
 *    `decimalNumbers: false`（见 db.js：wei 金额必须保持字符串），于是 SUM 也以字符串回来。
 *    除法靠 JS 隐式转换恰好也能算对，但那是"碰巧"——凡是聚合结果当数字用，这里都显式表态。
 *    代价如实写：这是刻意选的（金额宁可响亮地失败），代价落在每一个消费聚合的调用点。
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

/**
 * 订单当前是否在可评价窗口（TTL 从终局迁移时刻 `orders.updated_at` 起算）。
 *
 * 两处都是 `Date`（库里的 DATETIME(3)）：拿不回一个 Date 就没有"终局时刻"，窗口无从起算，
 * 一律判为不可评——旧写法 `Number(order.updated_at) > 0` 在新形状下恒为 NaN 比较，
 * 会把"有终局时刻"整类判成假（静默）。
 */
export function reviewableAt(order, now = new Date()) {
  if (!order) return false;
  if (!REVIEWABLE_STATUS.includes(order.status)) return false;
  const settledAt = order.updated_at;
  if (!(settledAt instanceof Date)) return false;
  const ttlMs = config.review.ttlDays * 24 * 3600 * 1000;
  return now.getTime() - settledAt.getTime() <= ttlMs;
}

/** 读取订单既有评价（含店主回复）；无则 null。`orderId` = 订单内部键（`v_orders.order_id`） */
export async function findReviewByOrder(orderId) {
  return await getDb().get('SELECT * FROM reviews WHERE order_id = ?', orderId) || null;
}

/**
 * 买家提交评价。返回 {ok, error?} 语义（错误信息由调用方转 fail）。
 * @param {{order: object, buyer: string, rating: number|string, content?: string}} p
 */
export async function submitReview({ order, buyer, rating, content }) {
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
  if (!reviewableAt(order)) return { error: '已超过可评价期限（成交后 TTL 内有效）' };
  const db = getDb();
  try {
    // created_at / updated_at 不传：由列的 DEFAULT CURRENT_TIMESTAMP(3) 盖章
    await db.run('INSERT INTO reviews (order_id, product_id, buyer, rating, content) VALUES (?, ?, ?, ?, ?)', order.order_id, order.product_id, String(buyer).toLowerCase(), r, text);
  } catch (e) {
    // 唯一键冲突（MySQL：ER_DUP_ENTRY）折成"一单一评"的业务结论；其它错误原样上抛
    if (e && (e.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(String(e.message || '')))) {
      return { error: '该订单已评价过（一单一评）' };
    }
    throw e;
  }
  return { ok: true };
}

/**
 * 店主回复评价（单次）。
 *
 * 签名只吃 `order` 与 `content`（2026-10-14 移除一个 `owner` 形参）：它被解构出来后**从未使用**——
 * 一个"看起来函数内会校验店主"的参数，实际鉴权全在调用点（路由的 `staffOnly`）。
 * 留着它，下一个调用点就会以为这里已经校验过了。
 *
 * @param {{order: object, content?: string}} p order = 读模型行（需要 order_id）
 */
export async function replyReview({ order, content }) {
  const text = String(content ?? '').trim();
  if (!text) return { error: '回复内容不能为空' };
  if (text.length > 1000) return { error: '回复内容不能超过 1000 字' };
  const changed = (await getDb().run("UPDATE reviews SET reply_content = ?, reply_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE order_id = ? AND reply_at IS NULL AND reply_content = ''", text, order.order_id)).changes;
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
export async function productReviewSummary(productId) {
  const db = getDb();
  const row = await db.get('SELECT COUNT(*) AS c, COALESCE(SUM(rating),0) AS s FROM reviews WHERE product_id = ?', productId);
  // COUNT 是整数（安全范围内直接是 number）；SUM 是 DECIMAL → 驱动给字符串，必须显式转
  const total = Number(row.c);
  return {
    count: total,
    avg: total > 0 ? Math.round((Number(row.s) / total) * 10) / 10 : null,
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
export async function productReviews(slug, page, pageSize, filter = 'all', sort = 'new') {
  const db = getDb();
  const product = await db.get('SELECT id FROM products WHERE slug = ?', String(slug || ''));
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

  const total = Number((await db.get(`SELECT COUNT(*) AS c FROM reviews WHERE product_id = ?${where}`, product.id)).c);
  const rows = await db.all(`SELECT * FROM reviews WHERE product_id = ?${where} ORDER BY ${order} LIMIT ? OFFSET ?`, product.id, pageSize, (page - 1) * pageSize);
  return {
    // summary 始终是**全量**聚合（与筛选无关）：它是"这个商品总体怎么样"，筛选只影响列表
    summary: await productReviewSummary(product.id),
    total,
    /** 全部评价条数（未筛选）——用于"筛选后 N 条 / 共 M 条"的文案 */
    totalAll: Number((await db.get('SELECT COUNT(*) AS c FROM reviews WHERE product_id = ?', product.id)).c),
    filter,
    sort,
    page,
    pageSize,
    items: rows.map(reviewToPublic),
  };
}

/**
 * 店铺级评价聚合（公开）。
 *
 * 参数三态（与 reputationSummary 同款，理由同款：不给默认值，让"忘了传"不可表达）：
 * `undefined` ⇒ 抛错；`null` ⇒ 该节点全部在售店铺的合计；地址 ⇒ 只算那一家。
 * 过滤走 `orders.seller`（评价行本身没有卖家列，它挂在订单上）——`reviews.product_id`
 * 不足以定位店铺：多店之后商品属于店铺，但评价的归属应当与订单一致。
 *
 * 关联两侧都是内部键：`reviews.order_id` → `orders.id`（外键）。比较用 `lower()`：
 * 库级排序规则现在是 `utf8mb4_0900_as_cs`（区分大小写），而地址的归一在**写入侧**——
 * 比较侧不再折一次，带校验和的写法就会落到另一行（本仓踩过：节点不认自己的店铺地址）。
 * @param {string|null|undefined} seller
 */
export async function shopReviewStats(seller) {
  if (seller === undefined) {
    throw new Error('shopReviewStats 需要显式的 seller（null = 全部在售店铺）；漏传会静默跨店混算');
  }
  const db = getDb();
  const sel = seller === null ? '' : String(seller).toLowerCase();
  const row = sel
    ? await db.get(`SELECT COUNT(*) AS c, COALESCE(SUM(r.rating),0) AS s
             FROM reviews r JOIN orders o ON o.id = r.order_id
            WHERE lower(o.seller) = ?`, sel)
    : await db.get('SELECT COUNT(*) AS c, COALESCE(SUM(rating),0) AS s FROM reviews');
  const total = Number(row.c);
  return { count: total, avg: total > 0 ? Math.round((Number(row.s) / total) * 10) / 10 : null };
}
