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
import { verifyToken, roleOf } from '../auth.js';
import { fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { sendCsv } from '../csv.js';
import { logAudit } from '../audit.js';
import {
  refreshFeeCollector,
  commissionTermsReadOf,
  feeSnapshotReadOf,
  feeChargeableForOrder,
  feeBasisOf,
  settlementReadOf,
} from '../fees.js';
// 入账口径与订单状态集合的唯一出处（与流水页/看板/可评价同源，见 src/orderStatus.js）
import { INCOME_STATUS as ORDER_INCOME_STATUS, ORDER_STATUS } from '../orderStatus.js';

const router = Router();
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true });

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
 * 一行的「平台费口径三件套」——**唯一实现**（ledger.csv 与 orders.csv 共用，两处必须逐字同源）。
 *
 * 为什么要把判据本身也导出来：只给 `fee_wei` / `net_wei` 时，店主拿它对账**无法自证**这个费是怎么来的
 * ——按本单快照扣的？还是因为快照缺失、按全局保守口径折算的？两者在同一个文件里长得一模一样，
 * 而后者**可能**与链上实际扣费相反（见 src/fees.js 文件头的两个方向）。所以把 `fee_bps`（费率快照）、
 * `fee_chargeable`（这一单判不判扣费）、`fee_basis`（判据来源：snapshot / fallback）
 * 一并落盘：任何一行都能在 Excel 里手算复核 net = amount − refunded − fee − commission。
 *
 * **三态**：`fee_bps` 那一列是 `NOT NULL DEFAULT 0`，"没补录过"与"快照就是 0"分不开
 * （判据见 src/fees.js 的 feeSnapshotReadOf）。快照未回填时这一行的费与净额**算不出来**
 * ——三个金额单元格一律留**空**（Excel 里是"没有值"），`fee_basis` 那列写 `fallback` 说明原因。
 * 写 0 等于在月结文件里替链上宣布"这单不扣费"。
 * @returns {{bps:number|'', chargeable:0|1, basis:'snapshot'|'fallback'}}
 */
function feeCellsOf(o) {
  const snap = feeSnapshotReadOf(o);
  return {
    bps: snap.known ? snap.feeBps : '',
    chargeable: feeChargeableForOrder(o.fee_collector_at_create) ? 1 : 0,
    basis: feeBasisOf(o.fee_collector_at_create),
  };
}

/**
 * 导出限流（四路 CSV 共用一把窗口）：
 * 导出是最重的读路径——orders/ledger/products 都是**全表** SELECT（不带分页）并在 JS 侧
 * 逐行折算，codes.csv 还会把码原文整体吐出；`await refreshFeeCollector()` 另有一次链上读。
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
    actorRole: await roleOf(req.auth?.address || '', req.shop.code),
    // 四条 CSV 全是 ownerOnly + 本店作用域（查询里 `WHERE shop_code = ?`，见下方说明）：归属恒为本店
    shopCode: req.shop.code,
    action,
    targetType: 'export',
    targetId,
    detail,
  });

/**
 * 订单全量导出列。
 * 金额块：只给 `amount_net_wei` 时店主算不回它（只能回去翻页面）。补齐
 * refunded/fee/commission/费率/判据来源后，一行即可自证
 * `amount_net_wei = amount_wei − refunded_wei − fee_wei − commission_wei`
 * （且可知每条腿是按快照还是兜底算的）。
 * `accepted_partial_refund_wei` 同 ledger.csv 的理由：分辨"部分退款是仲裁拆分还是买家授权"。
 */
const ORDER_COLUMNS = [
  'order_no', 'product_slug', 'status', 'quantity', 'amount_wei', 'refunded_wei', 'fee_wei', 'commission_wei',
  'amount_net_wei',
  'fee_bps', 'fee_chargeable', 'fee_basis', 'commission_bps', 'commission_basis',
  'accepted_partial_refund_wei',
  'usdt_micro', 'shipping_fee_usdt_micro', 'invoice_needed',
  'buyer', 'shipping_name', 'shipping_phone', 'shipping_address', 'shipping_edited', 'note', 'escrow_order_id',
  'paid_tx_hash', 'refund_status', 'tracking_no', 'carrier', 'created_at', 'updated_at',
];

/**
 * 抽成判据三件套（与 `feeCellsOf` 对称）：`basis` 说明这一行的抽成是**按本单成交条款快照**
 * 算的还是**根本没补录**（`missing`）。三态与 `src/fees.js` 的 `commissionTermsReadOf` 同款：
 * 空串 = 从未补录 = 未知（那时抽成与净额两列留空，**不写 0**）。
 */
function commissionCellsOf(o) {
  const snap = commissionTermsReadOf(o);
  return { bps: snap.known ? snap.bps : '', basis: snap.known ? 'snapshot' : 'missing' };
}

/** 收款流水导出（ownerOnly；入账口径与流水页一致 = 订单 updated_at 末次迁移时刻；
 *  列含 **毛额 / 已退买家 / 平台费 / 节点抽成 / 净额** 五列——月结对账免逐页人工加总；
 *  另有**按单的判据三件套**与**买家已授权的部分退款额**；`?from=&to=` 为 ISO-8601） */
router.get('/ledger.csv', ownerOnly, exportLimiter, wrap(async (req, res) => {
  const db = getDb();
  // 平台费**按单**判定（创建时收费方快照，见 src/fees.js）；这里刷新全局口径只为
  // "本单没有快照"的兜底行与披露字段（feeCollectorKnown），保持与流水页同源。
  await refreshFeeCollector();
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
      · 钱流五列（amount/refunded/fee/commission/net）必须在**同一行内自洽**，月结时能在 Excel 里手算复核；
      · `fee_*` / `commission_*` = 各腿的判据三件套，缺一列店主就无法自证那些钱是按本单快照算的
        还是按全局兜底折算的（两者可能相反，见 src/fees.js 文件头）；
      · `accepted_partial_refund_wei` = 买家在链上**授权过**的部分退款额。
        契约起 `approveRefund` 只接受「全额」或「买家精确授权过的那个数」，于是「这单退给买家 X」
        在链上有两个来源——仲裁拆分（无需同意）与双方谈拢（买家授权）。只导 refunded_wei 时，
        店主对着一笔部分退款无法分辨是哪一种，也就无从复核"这笔结算有没有买家点头"。
  */
  const headers = [
    'order_no', 'product_slug', 'income_status', 'quantity', 'amount_wei', 'refunded_wei', 'fee_wei',
    'commission_wei', 'net_wei',
    'fee_bps', 'fee_chargeable', 'fee_basis', 'commission_bps', 'commission_basis',
    'accepted_partial_refund_wei',
    'usdt_micro', 'income_at', 'buyer', 'escrow_order_id', 'paid_tx_hash',
  ];
  const csvRows = rows.map((o) => {
    /*
      四腿口径（与 `Escrow._settle` 逐字同源，算术只有 `src/fees.js` 一处实现）：
        净额 = 毛额 − 已退买家 − 平台费 − **节点抽成**
      平台费按**该单的创建时收取方快照**判定（合约只读快照；全局 feeCollector() 事后可改，
      用它会让导出与链上在途单的口径相反）；抽成按**该单的成交条款快照**。
      任一条腿的快照未回填 ⇒ 该腿与净额三列一律留空（判据列 `*_basis` 说明原因），
      **绝不写 0**：那会让月结对账把"算不出来"当成"没扣/没抽"。
    */
    const rd = settlementReadOf(o);
    const fc = feeCellsOf(o);
    const cc = commissionCellsOf(o);
    return [
      o.order_no, o.product_slug, o.status, o.quantity || 1, o.amount_wei,
      // 链上镜像列来自 LEFT JOIN：NULL = **这一单还没有链上镜像行**（尚未托管），
      // 而 '0' = 确证没退过款。两者在月结里必须长得不一样，所以 NULL 留空、不折成 0。
      o.refunded_amount_wei ?? '',
      !rd.ok || rd.feeWei === null ? '' : rd.feeWei,
      !rd.ok || rd.commissionWei === null ? '' : rd.commissionWei,
      !rd.ok || rd.netWei === null ? '' : rd.netWei,
      fc.bps, fc.chargeable, fc.basis, cc.bps, cc.basis, o.accepted_partial_refund_wei ?? '',
      o.usdt_micro, isoCell(o.updated_at), o.buyer, o.escrow_order_id || '', o.paid_tx_hash || '',
    ];
  });
  await auditExport(req, 'export.ledger', '-', { rows: rows.length, from: req.query.from || 'all', to: req.query.to || 'all' });
  sendCsv(res, 'ledger.csv', headers, csvRows);
}));

router.get('/orders.csv', ownerOnly, exportLimiter, wrap(async (req, res) => {
  const db = getDb();
  /*
    平台费口径必须与 ledger.csv **逐字同源**：`fees.js` 的**全局** feeCollector 缓存是进程级的、
    只由请求触发，而这里原先没有 `refreshFeeCollector()`。于是节点刚起来、**先**导 orders.csv 时
    `cache.known === false` ⇒ 兜底口径判为"会扣费" ⇒ 按订单级 feeBps 扣费；随后导 ledger.csv
    （它 await 了刷新）才读到全局 `feeCollector == 0` ⇒ 兜底不扣。同一单在两个 CSV 里的
    `amount_net_wei` / `net_wei` 相差一个费额，店主的月结对账对不上。
  */
  await refreshFeeCollector();
  /*
    店铺维度**直接写进语句**（而不是塞进下面那个动态拼接的 `where` 数组）：
    动态数组里的第一个条件很容易在某次重构中被改掉/挪走，而这条过滤是**安全边界**不是筛选条件。
    写死在 SQL 文本里，`shop_code = ?` 就不可能"顺手"丢。
  */
  const where = [];
  const params = [String(req.shop.code)];
  if (req.query.status) {
    const st = String(req.query.status);
    // 状态全集取 src/orderStatus.js（唯一出处；与 db.js 的 ENUM 取值同源）
    const valid = ORDER_STATUS;
    if (!valid.includes(st)) return fail(res, `status 无效（可选：${valid.join('/')}）`);
    where.push('status = ?');
    params.push(st);
  }
  // from/to 校验同 ledger.csv（防静默忽略/from>to 空集误导）
  const fromP = timeParamOf(req.query.from, 'from');
  if (fromP.error) return fail(res, fromP.error);
  const toP = timeParamOf(req.query.to, 'to');
  if (toP.error) return fail(res, toP.error);
  if (fromP.value && toP.value && fromP.value.getTime() > toP.value.getTime()) return fail(res, 'from 不得晚于 to');
  if (fromP.value) {
    where.push('created_at >= ?');
    params.push(fromP.value);
  }
  if (toP.value) {
    where.push('created_at <= ?');
    params.push(toP.value);
  }
  const rows = await db.all(`SELECT * FROM v_orders WHERE shop_code = ?${where.length ? ' AND ' + where.join(' AND ') : ''} ORDER BY created_at ASC`, ...params);
  const csvRows = rows.map((o) => {
    /* 与 ledger.csv 同一口径（五腿、按单快照判定；两处必须逐字同源） */
    const rd = settlementReadOf(o);
    const fc = feeCellsOf(o);
    const cc = commissionCellsOf(o);
    return [
      o.order_no, o.product_slug, o.status, o.quantity || 1, o.amount_wei,
      o.refunded_amount_wei ?? '',
      !rd.ok || rd.feeWei === null ? '' : rd.feeWei,
      !rd.ok || rd.commissionWei === null ? '' : rd.commissionWei,
      !rd.ok || rd.netWei === null ? '' : rd.netWei,
      fc.bps, fc.chargeable, fc.basis, cc.bps, cc.basis, o.accepted_partial_refund_wei ?? '',
      o.usdt_micro, o.shipping_fee_usdt_micro ?? 0, o.invoice_needed ? 1 : 0,
      o.buyer, o.shipping_name, o.shipping_phone, o.shipping_address, o.shipping_edit_count ? '1' : '0', o.note || '',
      o.escrow_order_id || '', o.paid_tx_hash || '', o.refund_status || 'none',
      o.tracking_no || '', o.carrier || '', isoCell(o.created_at), isoCell(o.updated_at),
    ];
  });
  await auditExport(req, 'export.orders', '-', { rows: rows.length, status: req.query.status || 'all' });
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
