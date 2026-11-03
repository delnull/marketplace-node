/**
 * 店铺 CSV 导出（P1-②，ownerOnly 私域；无第三方依赖）：
 *  - GET /api/shop/export/orders.csv?status=&from=&to=（订单全量；含收货信息——店主私域）
 *  - GET /api/shop/export/products.csv（商品 + 池口径）
 *  - GET /api/shop/export/codes.csv?slug=&status=（码池含码原文——仅 owner，资源敏感）
 * 行列白名单化；UTF-8 BOM + CRLF（src/csv.js）。
 *
 * ## 时间与读模型（2026-10 重设计）
 *
 *  - 过滤参数 `from`/`to` 收 **ISO-8601 字符串**（如 `2026-10-01T00:00:00Z`），非法即拒绝——
 *    旧形状收毫秒整数，而"这个数到底是秒还是毫秒"猜错的症状是一次**静默的全量导出**；
 *  - 单元格里的时刻写成 ISO-8601（`Date.toISOString()`）：Excel 里是文本时间，
 *    但它是**没有歧义**的那一种（旧形状给毫秒整数，任何人拿去手算都要先猜单位）；
 *  - 列的来源是**读模型视图 `v_orders`**（订单事实 + 收货信息 + 链上镜像三表各一份）：
 *    导出是"把一张订单读全"的典型场景，"写哪张表"在这里不存在。
 *    视图里内部主键叫 `order_id`、对外标识叫 `order_no`——CSV 下发**对外单号**
 *    （内部自增键不出本节点：它在换库/重建之后会变，而 CSV 是拿去对账的）。
 */
import { Router } from 'express';
import { getDb } from '../db.js';
import { verifySession, roleOf } from '../auth.js';
import { fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { refundUsdtMicroOfRow } from '../stats.js';
import { sendCsv } from '../csv.js';
import { logAudit } from '../audit.js';
// 入账口径与订单状态集合的唯一出处（与流水页/看板/可评价同源，见 src/orderStatus.js）
import { INCOME_STATUS as ORDER_INCOME_STATUS } from '../orderStatus.js';
import { sellerOrderFilters } from '../sellerOrderFilters.js';

const router = Router();
const ownerOnly = makeAuthMiddleware(verifySession, { ownerOnly: true });

/** 时间单元格：`Date` → ISO-8601；空值 → 空串（"没有这个时刻"） */
const isoCell = (v) => (v instanceof Date ? v.toISOString() : '');

/**
 * JSON 列的单元格：驱动把 `JSON` 列解成对象（db.js 没开 jsonStrings），
 * 所以按**规范文本形**写回（`JSON.stringify`）。这一列的价值就是"与库里那一份一致"，
 * 而在库那一份就是 MySQL 规范化之后的文本——stringify 出来的正是它。
 */
const jsonCell = (v) => (v === null || v === undefined ? '' : JSON.stringify(v));

/**
 * 时间过滤参数：只收 ISO-8601 字符串。
 * 非法/`from > to` 一律显式拒绝（旧实现静默忽略非法值 ⇒ 用户以为筛过了，实际导出全量）。
 */
function timeParamOf(raw, name) {
  if (raw === undefined || raw === '') return { value: null };
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) {
    return { error: `${name} 需为 ISO-8601 时间字符串（如 2026-10-01T00:00:00Z；本接口不再接受毫秒整数）` };
  }
  return { value: d };
}

/**
 * 一行的金额两腿读数（零费模型：**毛额 − 已退买家 = 净额**）。
 *
 * `refunded_amount_wei` 来自 `order_chain`（LEFT JOIN 可能为 NULL）："这一单还没有链上镜像行"
 * 与"'0' = 确证没退过款"在月结文件里必须长得不一样——NULL 单元格留空，不折成 0。
 * 净额算不出来（任一读数缺失）时同样留空：写 0 等于在月结文件里替链上宣布"这单没退过"。
 */
function moneyCellsOf(o) {
  const refunded = o.refunded_amount_wei === null || o.refunded_amount_wei === undefined ? null : BigInt(o.refunded_amount_wei);
  const amount = o.amount_wei === null || o.amount_wei === undefined ? null : BigInt(o.amount_wei);
  const net = refunded === null || amount === null ? null : amount - refunded;
  return {
    refundedWei: refunded === null ? '' : refunded.toString(),
    netWei: net === null ? '' : net.toString(),
    netUsdtMicro: refunded === null ? '' : (BigInt(o.usdt_micro || '0') - refundUsdtMicroOfRow(o)).toString(),
  };
}

/**
 * 导出限流（四路 CSV 共用一把窗口）：
 * 导出是最重的读路径——orders/ledger/products 都是**全表** SELECT（不带分页）并在 JS 侧
 * 逐行折算，codes.csv 还会把码原文整体吐出。
 * 数值依据：真实用法是月结/盘点时点几下（一次会话 1~4 个文件），20 次/分已远超需要；
 * 重导出给得比其它只读端点紧，正是因为它单次成本高一个量级。
 * 四路共用同一实例 = 共享额度（"总导出量"才是要挡的东西，逐路径各给 20 会放大 4 倍）。
 */
const exportLimiter = simpleRateLimit({ windowMs: 60_000, max: 20, message: '导出过于频繁（每分钟至多 20 次）：请稍后再试' });

/** 已入账状态（与 orders.js ledger 同口径：买家确认/仲裁判付/超时释放） */
const INCOME_STATUS = ORDER_INCOME_STATUS; // 唯一出处：src/orderStatus.js（与流水页同源）

/** 敏感导出审计（ownerOnly 端点均记录：谁在何时导出了什么）——async：角色判定要读库，
 *  且审计必须在响应之前落库（导出动作的证据力就在这里） */
const auditExport = async (req, action, targetId, detail) =>
  logAudit({
    req,
    actor: req.auth?.address,
    // 角色按**本店**算：漏传店铺编号会得到 'user'，而 logAudit 对 'user' 直接返回——导出审计静默消失
    actorRole: req.shopRole && req.shopRole !== 'user' ? req.shopRole : await roleOf(req.auth?.address || '', req.shop.code),
    // 四条 CSV 全是 ownerOnly + 本店作用域（查询里 `WHERE shop_code = ?`，见下方说明）：归属恒为本店
    shopCode: req.shop.code,
    action,
    targetType: 'export',
    targetId,
    detail,
  });

/**
 * 订单全量导出列。
 * 金额块：`amount_wei − refunded_wei = amount_net_wei` 必须在同一行内自洽（零费模型只有两条腿），
 * 另加 `accepted_partial_refund_wei` 分辨"部分退款是仲裁拆分还是买家授权"。
 */
const ORDER_COLUMNS = [
  'order_no', 'product_slug', 'status', 'quantity', 'payment_token', 'payment_symbol', 'payment_decimals',
  'payment_rate_source', 'payment_rate_stale', 'payment_rate_quoted_at',
  'amount_wei', 'refunded_wei', 'amount_net_wei', 'net_usdt_micro',
  'accepted_partial_refund_wei',
  'usdt_micro', 'shipping_fee_usdt_micro', 'invoice_needed',
  'buyer', 'shipping_name', 'shipping_phone', 'shipping_address', 'shipping_edited', 'note', 'escrow_order_id',
  'paid_tx_hash', 'refund_status', 'tracking_no', 'carrier', 'created_at', 'updated_at',
];

/** 收款流水导出（ownerOnly；入账口径与流水页一致 = 订单 updated_at 末次迁移时刻；
 *  列含 **毛额 / 已退买家 / 净额** 三列——月结对账免逐页人工加总；
 *  另有**买家已授权的部分退款额**；`?from=&to=` 为 ISO-8601） */
router.get('/ledger.csv', ownerOnly, exportLimiter, wrap(async (req, res) => {
  const db = getDb();
  const marks = INCOME_STATUS.map(() => '?').join(',');
  /*
    ⚠️ **店铺维度是这条查询的安全边界**（四条 CSV 同批）：`ownerOnly` 只回答
    "你是不是请求头那家店的店主"，而查询不带店铺条件 ⇒ 任一店店主能导出
    **整个节点**的订单（含买家姓名/电话/地址）、全部商品、以及**任意数字商品的兑换码原文**。
    这不是"多看了一眼"，是把别店的买家 PII 与卡密交出去。
  */
  const params = [String(req.shop.code), ...INCOME_STATUS];
  const range = [];
  const fromP = timeParamOf(req.query.from, 'from');
  if (fromP.error) return fail(res, fromP.error);
  const toP = timeParamOf(req.query.to, 'to');
  if (toP.error) return fail(res, toP.error);
  if (fromP.value && toP.value && fromP.value.getTime() > toP.value.getTime()) return fail(res, 'from 不得晚于 to');
  if (fromP.value) {
    range.push('updated_at >= ?');
    params.push(fromP.value);
  }
  if (toP.value) {
    range.push('updated_at <= ?');
    params.push(toP.value);
  }
  const rows = await db.all(`SELECT * FROM v_orders WHERE shop_code = ? AND status IN (${marks})${range.length ? ` AND ${range.join(' AND ')}` : ''} ORDER BY updated_at DESC`, ...params);
  /*
    列口径：
      · 钱流三列（amount/refunded/net）必须在**同一行内自洽**，月结时能在 Excel 里手算复核
        （零费模型：没有平台费、没有节点抽成，`net = amount − refunded`）；
      · `accepted_partial_refund_wei` = 买家在链上**授权过**的部分退款额。
        契约起 `approveRefund` 只接受「全额」或「买家精确授权过的那个数」，于是「这单退给买家 X」
        在链上有两个来源——仲裁拆分（无需同意）与双方谈拢（买家授权）。只导 refunded_wei 时，
        店主对着一笔部分退款无法分辨是哪一种，也就无从复核"这笔结算有没有买家点头"。
  */
  const headers = [
    'order_no', 'product_slug', 'income_status', 'quantity', 'payment_token', 'payment_symbol', 'payment_decimals',
    'payment_rate_source', 'payment_rate_stale', 'payment_rate_quoted_at',
    'amount_wei', 'refunded_wei', 'net_wei', 'net_usdt_micro',
    'accepted_partial_refund_wei',
    'usdt_micro', 'income_at', 'buyer', 'escrow_order_id', 'paid_tx_hash',
  ];
  const csvRows = rows.map((o) => {
    const money = moneyCellsOf(o);
    return [
      o.order_no, o.product_slug, o.status, o.quantity || 1,
      o.payment_token || '0x0000000000000000000000000000000000000000',
      o.payment_symbol || 'BTY', o.payment_decimals ?? 18,
      o.payment_rate_source || 'bty', o.payment_rate_stale ? 1 : 0, isoCell(o.payment_rate_quoted_at),
      o.amount_wei,
      // 链上镜像列来自 LEFT JOIN：NULL = **这一单还没有链上镜像行**（尚未托管），
      // 而 '0' = 确证没退过款。两者在月结里必须长得不一样，所以 NULL 留空、不折成 0。
      money.refundedWei,
      money.netWei,
      money.netUsdtMicro,
      o.accepted_partial_refund_wei ?? '',
      o.usdt_micro, isoCell(o.updated_at), o.buyer, o.escrow_order_id || '', o.paid_tx_hash || '',
    ];
  });
  await auditExport(req, 'export.ledger', '-', { rows: rows.length, from: req.query.from || 'all', to: req.query.to || 'all' });
  sendCsv(res, 'ledger.csv', headers, csvRows);
}));

router.get('/orders.csv', ownerOnly, exportLimiter, wrap(async (req, res) => {
  const db = getDb();
  /*
    店铺维度**直接写进语句**（而不是塞进下面那个动态拼接的 `where` 数组）：
    动态数组里的第一个条件很容易在某次重构中被改掉/挪走，而这条过滤是**安全边界**不是筛选条件。
    写死在 SQL 文本里，`shop_code = ?` 就不可能"顺手"丢。
  */
  /*
    与卖家订单列表共用同一份筛选谓词：页面按退款/售后/检索筛出的范围，
    导出必须拿到同一个范围；否则“按当前筛选条件导出”是一句假话。
    时间区间是导出独有的，追加在共用谓词之后。

    ⚠️ 店铺维度**写死在 SQL 文本里**：`sellerOrderFilters` 只返回筛选条件，不返回安全边界。
    这条 `shop_code = ?` 是 ownerOnly 之后的第二道、也是真正回答“哪一家店”的判据；
    把它放进动态片段里，静态守卫与读代码的人都看不出边界还在不在。
  */
  const filters = sellerOrderFilters(req.query);
  if ('error' in filters) return fail(res, filters.error);
  const { where, params } = filters;
  // from/to 校验同 ledger.csv（防静默忽略/from>to 空集误导）
  const fromP = timeParamOf(req.query.from, 'from');
  if (fromP.error) return fail(res, fromP.error);
  const toP = timeParamOf(req.query.to, 'to');
  if (toP.error) return fail(res, toP.error);
  if (fromP.value && toP.value && fromP.value.getTime() > toP.value.getTime()) return fail(res, 'from 不得晚于 to');
  let rangeWhere = where;
  const rangeParams = [String(req.shop.code), ...params];
  if (fromP.value) {
    rangeWhere += ' AND created_at >= ?';
    rangeParams.push(fromP.value);
  }
  if (toP.value) {
    rangeWhere += ' AND created_at <= ?';
    rangeParams.push(toP.value);
  }
  const rows = await db.all(
    `SELECT * FROM v_orders WHERE shop_code = ? AND ${rangeWhere} ORDER BY created_at ASC`,
    ...rangeParams
  );
  const csvRows = rows.map((o) => {
    /* 与 ledger.csv 同一口径（毛额 − 已退买家 = 净额；两处必须逐字同源） */
    const money = moneyCellsOf(o);
    return [
      o.order_no, o.product_slug, o.status, o.quantity || 1,
      o.payment_token || '0x0000000000000000000000000000000000000000',
      o.payment_symbol || 'BTY', o.payment_decimals ?? 18,
      o.payment_rate_source || 'bty', o.payment_rate_stale ? 1 : 0, isoCell(o.payment_rate_quoted_at),
      o.amount_wei,
      money.refundedWei,
      money.netWei,
      money.netUsdtMicro,
      o.accepted_partial_refund_wei ?? '',
      o.usdt_micro, o.shipping_fee_usdt_micro ?? 0, o.invoice_needed ? 1 : 0,
      o.buyer, o.shipping_name, o.shipping_phone, o.shipping_address, o.shipping_edit_count ? '1' : '0', o.note || '',
      o.escrow_order_id || '', o.paid_tx_hash || '', o.refund_status || 'none',
      o.tracking_no || '', o.carrier || '', isoCell(o.created_at), isoCell(o.updated_at),
    ];
  });
  await auditExport(req, 'export.orders', '-', {
    rows: rows.length,
    status: req.query.status || 'all',
    refund: req.query.refund || 'all',
    afterSale: req.query.afterSale || 'all',
    q: req.query.q ? 'filtered' : 'all',
  });
  sendCsv(res, 'orders.csv', ORDER_COLUMNS, csvRows);
}));

router.get('/products.csv', ownerOnly, exportLimiter, wrap(async (req, res) => {
  const db = getDb();
  const rows = await db.all(`SELECT p.*,
         (SELECT COUNT(*) FROM product_codes c WHERE c.product_id = p.id) AS codes_built,
         (SELECT COUNT(*) FROM product_codes c WHERE c.product_id = p.id AND c.status = 'unused') AS codes_unused,
         (SELECT COUNT(*) FROM product_nft_tokens t WHERE t.product_id = p.id) AS tokens_built,
         (SELECT COUNT(*) FROM product_nft_tokens t WHERE t.product_id = p.id AND t.status = 'unused') AS tokens_unused
       FROM products p WHERE p.shop_code = ? ORDER BY p.id ASC`, String(req.shop.code));
  // 商品 CSV 按「商品 × SKU」展开：一行一个规格组合 —— 价格与库存本来就逐组合不同，
  // 压成一行会让「哪个组合还剩几件」在导出里彻底丢失。无规格商品即 sku_key 为空的那一行。
  const skuRows = await getDb().all('SELECT s.* FROM product_skus s JOIN products p ON p.id = s.product_id WHERE p.shop_code = ? ORDER BY s.product_id, s.sku_key', String(req.shop.code));
  const skuByProduct = new Map();
  for (const s of skuRows) {
    if (!skuByProduct.has(s.product_id)) skuByProduct.set(s.product_id, []);
    skuByProduct.get(s.product_id).push(s);
  }
  /*
    列清单 = 商品模型的可导出部分（**含快照里的每一项**：迁移/对账时要能凭它复算出 snapshot_hash）。
    `specs`/`attributes`/`terms` 是 **JSON 列**（驱动解成对象）→ 用 `jsonCell` 按规范文本形写出；
    逐字保持 JSON 原文（不解析后重排键序）：这一列的价值就是"与库里那一份一致"，
    而库里那一份是 MySQL 规范化之后的文本，`JSON.stringify(读回的对象)` 给出的正是它。
  */
  const headers = ['slug', 'title', 'kind', 'shipping_fee_usdt_micro', 'age_restricted', 'specs', 'attributes', 'terms', 'sku_key', 'sku_specs', 'price_usdt_micro', 'sku_image_url', 'capacity', 'committed', 'available', 'sku_active', 'active', 'published_at', 'auto_deliver', 'stock_alert_at', 'snapshot_hash', 'created_at', 'updated_at', 'codes_built', 'codes_unused', 'tokens_built', 'tokens_unused'];
  const csvRows = [];
  for (const r of rows) {
    const skus = skuByProduct.get(r.id) || [];
    // 商品没有任何 SKU 行（异常数据）：仍导出一行、sku 列留空，便于排查
    const list = skus.length ? skus : [null];
    for (const s of list) {
      csvRows.push([
        r.slug, r.title, r.kind, r.shipping_fee_usdt_micro ?? 0, r.age_restricted ? 1 : 0, jsonCell(r.specs),
        jsonCell(r.attributes), jsonCell(r.terms),
        s ? s.sku_key : '', s ? jsonCell(s.specs_json) : '',
        s ? s.price_usdt_micro : '', s ? (s.image_url || '') : '',
        s ? (s.capacity ?? '') : '', s ? s.committed || 0 : '',
        s ? (s.capacity === null ? '' : Math.max(0, s.capacity - (s.committed || 0))) : '',
        s ? (s.active ? 1 : 0) : '',
        r.active ? 1 : 0, isoCell(r.published_at), r.auto_deliver, r.stock_alert_at ?? '', r.snapshot_hash,
        isoCell(r.created_at), isoCell(r.updated_at), r.codes_built, r.codes_unused, r.tokens_built, r.tokens_unused,
      ]);
    }
  }
  await auditExport(req, 'export.products', '-', { rows: rows.length });
  sendCsv(res, 'products.csv', headers, csvRows);
}));

router.get('/codes.csv', ownerOnly, exportLimiter, wrap(async (req, res) => {
  const db = getDb();
  const slug = String(req.query.slug || '');
  const product = await db.get('SELECT id FROM products WHERE slug = ? AND kind = ? AND shop_code = ?', slug, 'digital', String(req.shop.code));
  if (!product) return fail(res, '数字商品不存在', 404, 404);
  const where = ['c.product_id = ?'];
  const params = [product.id];
  if (req.query.status) {
    if (!['unused', 'used', 'all'].includes(String(req.query.status))) return fail(res, 'status 需为 unused/used/all');
    if (req.query.status !== 'all') {
      where.push('c.status = ?');
      params.push(String(req.query.status));
    }
  }
  /*
    `product_codes.order_id` 是**内部订单键**（外键指向 `orders.id`），而导出要的是人能核对的标识：
    这里 JOIN 出 `order_no`（对外单号）。内部自增键在换库/重建之后会变，拿它去对账等于对不上。
  */
  const rows = await db.all(
    `SELECT c.code, c.status, o.order_no, c.created_at, c.used_at
       FROM product_codes c LEFT JOIN orders o ON o.id = c.order_id
      WHERE ${where.join(' AND ')} ORDER BY c.id ASC`,
    ...params
  );
  await auditExport(req, 'export.codes', slug, { rows: rows.length, status: req.query.status || 'all' });
  // 码为店主持有资源：关闭公式前缀（码值原样导出，值完整性优先；来源非买家可控）
  sendCsv(res, `${slug}-codes.csv`, ['code', 'status', 'order_no', 'created_at', 'used_at'],
    rows.map((r) => [r.code, r.status, r.order_no || '', isoCell(r.created_at), isoCell(r.used_at)]), { formulaGuard: false });
}));

export default router;
