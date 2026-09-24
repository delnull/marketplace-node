/**
 * 店铺 CSV 导出（P1-②，ownerOnly 私域；无第三方依赖）：
 *  - GET /api/shop/export/orders.csv?status=&from=&to=（订单全量；含收货信息——店主私域）
 *  - GET /api/shop/export/products.csv（商品 + 池口径）
 *  - GET /api/shop/export/codes.csv?slug=&status=（码池含码原文——仅 owner，资源敏感）
 * 行列白名单化；UTF-8 BOM + CRLF（src/csv.js）。
 */
import { Router } from 'express';
import { getDb } from '../db.js';
import { verifyToken, roleOf } from '../auth.js';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { sendCsv } from '../csv.js';
import { logAudit } from '../audit.js';
import { refreshFeeCollector, feeOf, feeChargeableForOrder, feeBasisOf } from '../fees.js';
// 入账口径的唯一出处（与流水页/看板/可评价同源，见 src/orderStatus.js）
import { INCOME_STATUS as ORDER_INCOME_STATUS } from '../orderStatus.js';

const router = Router();
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true });

/**
 * 一行的「平台费口径三件套」——**唯一实现**（ledger.csv 与 orders.csv 共用，两处必须逐字同源）。
 *
 * 为什么要把判据本身也导出来（源码审计 2026-09 续）：此前两个 CSV 只给 `fee_wei` / `net_wei`，
 * 店主拿它对账时**无法自证**这个费是怎么来的——按本单快照扣的？还是因为快照缺失、
 * 按全局保守口径折算的？两者在同一个文件里长得一模一样，而后者**可能**与链上实际扣费相反
 * （见 src/fees.js 文件头的两个方向）。所以把 `fee_bps`（费率快照）、
 * `fee_chargeable`（这一单判不判扣费）、`fee_basis`（判据来源：snapshot / fallback）
 * 一并落盘：任何一行都能在 Excel 里手算复核 net = amount − refunded − fee。
 * @returns {{bps:number, chargeable:0|1, basis:'snapshot'|'fallback'}}
 */
function feeCellsOf(o) {
  return {
    bps: Number(o.fee_bps) || 0,
    chargeable: feeChargeableForOrder(o.fee_collector_at_create) ? 1 : 0,
    basis: feeBasisOf(o.fee_collector_at_create),
  };
}

/**
 * 导出限流（四路 CSV 共用一把窗口；此前**无任何限流**）：
 * 导出是最重的读路径——orders/ledger/products 都是**全表** SELECT（不带分页）并在 JS 侧
 * 逐行折算，codes.csv 还会把码原文整体吐出；`await refreshFeeCollector()` 另有一次链上读。
 * 数值依据：真实用法是月结/盘点时点几下（一次会话 1~4 个文件），20 次/分已远超需要；
 * 重导出给得比其它只读端点紧，正是因为它单次成本高一个量级。
 * 四路共用同一实例 = 共享额度（"总导出量"才是要挡的东西，逐路径各给 20 会放大 4 倍）。
 */
const exportLimiter = simpleRateLimit({ windowMs: 60_000, max: 20, message: '导出过于频繁（每分钟至多 20 次）：请稍后再试' });

/** 已入账状态（与 orders.js ledger 同口径：买家确认/仲裁判付/超时释放） */
const INCOME_STATUS = ORDER_INCOME_STATUS; // 唯一出处：src/orderStatus.js（与流水页同源）

/** 敏感导出审计（ownerOnly 端点均记录：谁在何时导出了什么） */
const auditExport = (req, action, targetId, detail) =>
  logAudit({ req, actor: req.auth?.address, actorRole: roleOf(req.auth?.address || ''), action, targetType: 'export', targetId, detail });

/**
 * 订单全量导出列。
 * 金额块（源码审计 2026-09 续）：原先只有 `amount_wei` + `amount_net_wei`，中间的
 * **已退买家**与**平台费**两笔都没有——店主拿到一行 `amount_net_wei` 却算不回它，
 * 只能回去翻页面。补齐 refunded/fee/费率/判据来源后，一行即可自证
 * `amount_net_wei = amount_wei − refunded_wei − fee_wei`（且可知 fee 是按快照还是兜底算的）。
 * `accepted_partial_refund_wei` 同 ledger.csv 的理由：分辨"部分退款是仲裁拆分还是买家授权"。
 */
const ORDER_COLUMNS = [
  'id', 'product_slug', 'status', 'quantity', 'amount_wei', 'refunded_wei', 'fee_wei', 'amount_net_wei',
  'fee_bps', 'fee_chargeable', 'fee_basis', 'accepted_partial_refund_wei',
  'cny_fen', 'shipping_fee_cny_fen', 'invoice_needed',
  'buyer', 'shipping_name', 'shipping_phone', 'shipping_address', 'shipping_edited', 'note', 'escrow_order_id',
  'paid_tx_hash', 'refund_status', 'tracking_no', 'created_at', 'updated_at',
];

/** 收款流水导出（ownerOnly；入账口径与流水页一致 = 订单 updated_at 末次迁移时刻；
 *  列含 **毛额 / 已退买家 / 平台费 / 净额** 四列（净额 = 毛额 − 已退 − 平台费）——月结对账免逐页人工加总；
 *  另有**按单的平台费口径三件套**（fee_bps / fee_chargeable / fee_basis）与
 *  **买家已授权的部分退款额**（accepted_partial_refund_wei）——见下方 headers 处说明；
 *  ?from=&to= 毫秒过滤） */
router.get('/ledger.csv', ownerOnly, exportLimiter, wrap(async (req, res) => {
  const db = getDb();
  // 平台费**按单**判定（创建时收费方快照，见 src/fees.js）；这里刷新全局口径只为
  // "本单没有快照"的兜底行与披露字段（feeCollectorKnown），保持与流水页同源。
  await refreshFeeCollector(); // 平台费口径见 src/fees.js
  const marks = INCOME_STATUS.map(() => '?').join(',');
  const params = [...INCOME_STATUS];
  const range = [];
  // 非法/from>to 显式拒绝（此前静默忽略可能导出全量）
  const rawFrom = req.query.from;
  const rawTo = req.query.to;
  const fromV = rawFrom === undefined || rawFrom === '' ? null : Number(rawFrom);
  const toV = rawTo === undefined || rawTo === '' ? null : Number(rawTo);
  if (fromV !== null && (!Number.isFinite(fromV) || fromV <= 0)) return fail(res, 'from 需为毫秒时间戳');
  if (toV !== null && (!Number.isFinite(toV) || toV <= 0)) return fail(res, 'to 需为毫秒时间戳');
  if (fromV !== null && toV !== null && fromV > toV) return fail(res, 'from 不得晚于 to');
  if (fromV !== null) {
    range.push('updated_at >= ?');
    params.push(fromV);
  }
  if (toV !== null) {
    range.push('updated_at <= ?');
    params.push(toV);
  }
  const rows = db
    .prepare(
      `SELECT * FROM orders WHERE status IN (${marks})${range.length ? ` AND ${range.join(' AND ')}` : ''} ORDER BY updated_at DESC`
    )
    .all(...params);
  /*
    列口径（源码审计 2026-09 续）：
      · 钱流四列（amount/refunded/fee/net）必须在**同一行内自洽**，月结时能在 Excel 里手算复核；
      · `fee_bps` / `fee_chargeable` / `fee_basis` = 平台费判据三件套，缺一列店主就无法自证
        fee_wei 是按本单快照扣的还是按全局兜底折算的（两者可能相反，见 src/fees.js 文件头）；
      · `accepted_partial_refund_wei` = 买家在链上**授权过**的部分退款额（0 = 未授权）。
        为什么放进流水：契约层 2026-09 起 `approveRefund` 只接受「全额」或「买家精确授权过的
        那个数」，于是「这单退给买家 X」这件事在链上有两个来源——仲裁拆分（无需同意）与
        双方谈拢（买家授权）。只导 refunded_wei 时，店主对着一笔部分退款无法分辨是哪一种，
        也就无从复核"这笔结算有没有买家点头"。授权额正是那个可查的凭据。
  */
  const headers = [
    'order_id', 'product_slug', 'income_status', 'quantity', 'amount_wei', 'refunded_wei', 'fee_wei', 'net_wei',
    'fee_bps', 'fee_chargeable', 'fee_basis', 'accepted_partial_refund_wei',
    'cny_fen', 'income_at_ms', 'buyer', 'escrow_order_id', 'paid_tx_hash',
  ];
  const csvRows = rows.map((o) => {
    // 已退金额参与净额：净额 = amount − refunded − fee（部分退款后只对未退部分计费）
    // 平台费按**该单**的创建时收取方快照判定（合约只读快照；全局 feeCollector() 事后可改，
    // 用它会让导出与链上在途单的口径相反——见 src/fees.js 文件头）
    const refunded = BigInt(o.refunded_amount_wei || '0');
    const base = BigInt(o.amount_wei || '0') - refunded;
    const fee = feeOf(base > 0n ? base : 0n, Number(o.fee_bps) || 0, o.fee_collector_at_create);
    const fc = feeCellsOf(o);
    return [
      o.id, o.product_slug, o.status, o.quantity || 1, o.amount_wei, refunded.toString(), fee.toString(),
      (base - fee).toString(),
      fc.bps, fc.chargeable, fc.basis, String(o.accepted_partial_refund_wei || '0'),
      o.cny_fen, o.updated_at, o.buyer, o.escrow_order_id || '', o.paid_tx_hash || '',
    ];
  });
  auditExport(req, 'export.ledger', '-', { rows: rows.length, from: req.query.from || 'all', to: req.query.to || 'all' });
  sendCsv(res, 'ledger.csv', headers, csvRows);
}));

router.get('/orders.csv', ownerOnly, exportLimiter, wrap(async (req, res) => {
  const db = getDb();
  /*
    平台费口径必须与 ledger.csv **逐字同源**（源码审计 2026-09 修复）：
    `fees.js` 的**全局** feeCollector 缓存是进程级的、只由请求触发，而这里原先没有
    `refreshFeeCollector()`。于是节点刚起来、**先**导 orders.csv 时 `cache.known === false`
    ⇒ 兜底口径判为"会扣费" ⇒ 按订单级 feeBps 扣费；随后导 ledger.csv（它 await 了刷新）
    才读到全局 `feeCollector == 0` ⇒ 兜底不扣。同一单在两个 CSV 里的 `amount_net_wei` /
    `net_wei` 相差一个费额，店主的月结对账对不上——而 fees.js 文件头那条「面板说扣了、
    钱包没少」正是要消灭的现象。
    注：契约层 2026-09 起扣费判据是**每单**的创建时快照（orders.fee_collector_at_create），
    全局值只对"没有快照的行"兜底；刷新仍要保留——否则兜底口径又会在两个 CSV 间漂移。
  */
  await refreshFeeCollector();
  const where = [];
  const params = [];
  if (req.query.status) {
    const st = String(req.query.status);
    const valid = ['draft', 'escrowed', 'shipped', 'confirmed', 'disputed', 'settled', 'refunded', 'expired', 'cancelled'];
    if (!valid.includes(st)) return fail(res, `status 无效（可选：${valid.join('/')}）`);
    where.push('status = ?');
    params.push(st);
  }
  // from/to 校验同 ledger.csv（防静默忽略/from>to 空集误导）
  const rawFrom = req.query.from;
  const rawTo = req.query.to;
  const fromV = rawFrom === undefined || rawFrom === '' ? null : Number(rawFrom);
  const toV = rawTo === undefined || rawTo === '' ? null : Number(rawTo);
  if (fromV !== null && (!Number.isFinite(fromV) || fromV <= 0)) return fail(res, 'from 需为毫秒时间戳');
  if (toV !== null && (!Number.isFinite(toV) || toV <= 0)) return fail(res, 'to 需为毫秒时间戳');
  if (fromV !== null && toV !== null && fromV > toV) return fail(res, 'from 不得晚于 to');
  if (fromV !== null) {
    where.push('created_at >= ?');
    params.push(fromV);
  }
  if (toV !== null) {
    where.push('created_at <= ?');
    params.push(toV);
  }
  const rows = db
    .prepare(`SELECT * FROM orders${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ASC`)
    .all(...params);
  const csvRows = rows.map((o) => {
    const refunded = BigInt(o.refunded_amount_wei || '0');
    const base = BigInt(o.amount_wei || '0') - refunded;
    // 与 ledger.csv 同一口径（按单快照判定；两处必须逐字同源，见上方 orders.csv 的说明）
    const fee = feeOf(base > 0n ? base : 0n, Number(o.fee_bps) || 0, o.fee_collector_at_create);
    const fc = feeCellsOf(o);
    return [
      o.id, o.product_slug, o.status, o.quantity || 1, o.amount_wei,
      refunded.toString(), fee.toString(), (base - fee).toString(),
      fc.bps, fc.chargeable, fc.basis, String(o.accepted_partial_refund_wei || '0'),
      o.cny_fen, o.shipping_fee_cny_fen ?? 0, o.invoice_needed ? 1 : 0,
      o.buyer, o.shipping_name, o.shipping_phone, o.shipping_address, o.shipping_edit_count ? '1' : '0', o.note || '',
      o.escrow_order_id || '', o.paid_tx_hash || '', o.refund_status || 'none',
      o.tracking_no || '', o.created_at, o.updated_at,
    ];
  });
  auditExport(req, 'export.orders', '-', { rows: rows.length, status: req.query.status || 'all' });
  sendCsv(res, 'orders.csv', ORDER_COLUMNS, csvRows);
}));

router.get('/products.csv', ownerOnly, exportLimiter, wrap(async (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM product_codes c WHERE c.product_id = p.id) AS codes_built,
         (SELECT COUNT(*) FROM product_codes c WHERE c.product_id = p.id AND c.status = 'unused') AS codes_unused,
         (SELECT COUNT(*) FROM product_nft_tokens t WHERE t.product_id = p.id) AS tokens_built,
         (SELECT COUNT(*) FROM product_nft_tokens t WHERE t.product_id = p.id AND t.status = 'unused') AS tokens_unused
       FROM products p ORDER BY p.id ASC`
    )
    .all();
  // 商品 CSV 按「商品 × SKU」展开：一行一个规格组合 —— 价格与库存本来就逐组合不同，
  // 压成一行会让「哪个组合还剩几件」在导出里彻底丢失。无规格商品即 sku_key 为空的那一行。
  const skuRows = getDb().prepare('SELECT * FROM product_skus ORDER BY product_id, sku_key').all();
  const skuByProduct = new Map();
  for (const s of skuRows) {
    if (!skuByProduct.has(s.product_id)) skuByProduct.set(s.product_id, []);
    skuByProduct.get(s.product_id).push(s);
  }
  const headers = ['slug', 'title', 'kind', 'shipping_fee_cny_fen', 'age_restricted', 'specs', 'sku_key', 'sku_specs', 'price_cny_fen', 'capacity', 'committed', 'available', 'sku_active', 'active', 'auto_deliver', 'stock_alert_at', 'snapshot_hash', 'created_at', 'updated_at', 'codes_built', 'codes_unused', 'tokens_built', 'tokens_unused'];
  const csvRows = [];
  for (const r of rows) {
    const skus = skuByProduct.get(r.id) || [];
    let specs = '[]';
    try {
      specs = JSON.stringify(JSON.parse(r.specs || '[]'));
    } catch {
      specs = '[]';
    }
    // 商品没有任何 SKU 行（异常数据）：仍导出一行、sku 列留空，便于排查
    const list = skus.length ? skus : [null];
    for (const s of list) {
      csvRows.push([
        r.slug, r.title, r.kind, r.shipping_fee_cny_fen ?? 0, r.age_restricted ? 1 : 0, specs,
        s ? s.sku_key : '', s ? s.specs_json : '',
        s ? s.price_cny_fen : '', s ? (s.capacity ?? '') : '', s ? s.committed || 0 : '',
        s ? (s.capacity === null ? '' : Math.max(0, s.capacity - (s.committed || 0))) : '',
        s ? (s.active ? 1 : 0) : '',
        r.active ? 1 : 0, r.auto_deliver, r.stock_alert_at ?? '', r.snapshot_hash,
        r.created_at, r.updated_at, r.codes_built, r.codes_unused, r.tokens_built, r.tokens_unused,
      ]);
    }
  }
  auditExport(req, 'export.products', '-', { rows: rows.length });
  sendCsv(res, 'products.csv', headers, csvRows);
}));

router.get('/codes.csv', ownerOnly, exportLimiter, wrap(async (req, res) => {  const db = getDb();
  const slug = String(req.query.slug || '');
  const product = db.prepare('SELECT id FROM products WHERE slug = ? AND kind = ?').get(slug, 'digital');
  if (!product) return fail(res, '数字商品不存在', 404, 404);
  const where = ['product_id = ?'];
  const params = [product.id];
  if (req.query.status) {
    if (!['unused', 'used', 'all'].includes(String(req.query.status))) return fail(res, 'status 需为 unused/used/all');
    if (req.query.status !== 'all') {
      where.push('status = ?');
      params.push(String(req.query.status));
    }
  }
  const rows = db.prepare(`SELECT code, status, order_id, created_at, used_at FROM product_codes WHERE ${where.join(' AND ')} ORDER BY id ASC`).all(...params);
  auditExport(req, 'export.codes', slug, { rows: rows.length, status: req.query.status || 'all' });
  // 码为店主持有资源：关闭公式前缀（码值原样导出，值完整性优先；来源非买家可控）
  sendCsv(res, `${slug}-codes.csv`, ['code', 'status', 'order_id', 'created_at', 'used_at'],
    rows.map((r) => [r.code, r.status, r.order_id || '', r.created_at, r.used_at || '']), { formulaGuard: false });
}));

export default router;
