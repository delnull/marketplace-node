/**
 * 交付一致性体检（源码评审 2026-09，P0-2 的"防线"那一半）。
 *
 * 它查的是**"从旧备份恢复"这一类故障**留下的痕：`orders.status` 与交付行的演进都发生在
 * 备份点**之后**时，恢复旧库会把它们一起回退——而回退的后果不是"少几条记录"，是**同一个码
 * 被再发一次**（`product_codes.status` 回到 `unused`、`order_id` 变回 NULL），或者反过来：
 * 交付行还在、码池却说它没被用过。链上资金是真的，链下这两张表一旦对不上，谁都说不清
 * "这个码到底给过谁"。
 *
 * 三条判据（只读，不改任何数据；返回结构化结果，CLI 在 node/scripts/check-integrity.js）：
 *   ① 已交付的码/NFT（`order_delivery_items`）在池里**不是 used 或指向别的订单**
 *      ⇒ 恢复后码回未用（双交付风险），或交付被挂到了别的单上；
 *   ② 池里标了 `used` 却**找不到对应交付行** ⇒ 交付记录被回退掉了（收据/证据链断裂）；
 *   ③ 交付行所属订单的 `product_id` 与码池行不一致 ⇒ 串商品（导入/恢复错位）。
 *
 * 为什么是"体检"而不是"自动修复"：修复要为每一处不一致决定"以谁为准"（链上已交付 vs 池内状态），
 * 而这两者各有各的证据强度——这种判断不该由脚本替人做。工具的职责是把它们**列出来**。
 *
 * 报告里的 `orderId` 给的是**对外订单号**（`orders.order_no`，CHAR(21)）：内部键 `orders.id` 只
 * 在库内流通（读模型里叫 `order_id`），拿它印在人看的报告里，下一个人会以为那是可以搜的单号
 * （见 db.js 的 v_orders 说明）。池里那一侧（`product_codes.order_id`）是内部键，所以下面要
 * JOIN 一次 `orders` 才拿得到单号。
 *
 * 另有一项（⑤）**管理审计哈希链**：上面四条查的是"从旧备份恢复"（记录被整体回退），
 * 这一条查的是"拿到磁盘写权限的人事后改审计"——审计行带 prev_hash/entry_hash，重算对不上就是
 * 被改过。判据、三态纪律与"能查出什么/查不出什么"全在 `src/auditChain.js` 的文件头；
 * 这里只做两件事：断裂逐条进 `issues`（带 `auditId`）、**未哈希的历史行只进计数**——
 * "升级前的行没有哈希"不是篡改证据，不该被报成不一致（那会让真正的断裂淹没在噪声里）。
 *
 * 还有一项（⑥）**四个计数器的不变量**：`products.reserved_codes/reserved_tokens`、
 * `product_skus.committed`、`orders.hold_qty`。它们是"先读计数再写"落成可条件更新计数器之后
 * 新增的状态，漂移是静默的（超卖/卖不出去/按错的数量释放），只能靠对拍发现。判据与口径见
 * `checkReservationCounters`；**对不出来的行如实报 `counter-not-comparable`，不折成 0**。
 */
import { getDb } from './db.js';
import { verifyAuditChain } from './auditChain.js';

/**
 * @param {{get: Function, all: Function}} [db] 查询门面（默认 `getDb()`）
 * @returns {Promise<{issues: Array<{kind:string, detail:string, orderId?:string|null, resource?:string|null, auditId?:number}>,
 *            counts: {codeDeliveredNotUsed:number, codeUsedWithoutDelivery:number, nftDeliveredNotUsed:number,
 *                     nftUsedWithoutDelivery:number, auditChainBroken:number,
 *                     reservedCodesDrift:number, reservedTokensDrift:number, committedDrift:number,
 *                     holdQtyMismatch:number, holdWithoutSku:number, counterNotComparable:number},
 *            checked: {deliveryItems:number, codesUsed:number, nftUsed:number, auditEntries:number, auditUnhashed:number,
 *                      productCounters:number, skuCounters:number, ordersWithHold:number},
 *            auditChain: Awaited<ReturnType<typeof verifyAuditChain>>}}
 */
export async function findIntegrityIssues(db = getDb()) {
  const issues = [];

  // ① 已交付的码：池里不是 used，或 order_id 指向别的单
  //    归属比较用 **NULL 安全不等** `NOT (a <=> b)`：`a != b` 在任一侧为 NULL 时结果是 NULL
  //    （既不真也不假），会把"池里 order_id 为 NULL（未分配）却已交付"这一档静默漏掉。
  //
  //    ⚠️ **匹配键也必须 NULL 安全**（2026-10-16 修，与 ④ 是同一类假阳性）：
  //    `pc.product_id = o.product_id` 在 `o.product_id IS NULL` 时恒为 NULL ⇒ 永不匹配 ⇒
  //    `pc.id IS NULL` 成立 ⇒ 一条**完全自洽**的交付被报成"该商品的码池里没有这个码"，
  //    而本工具的处置建议是"优先重建库"（见 ④ 的长注释：一个会导致**误删正常数据**的
  //    假阳性比不报更糟）。`orders.product_id` 被设计成可空（商品删除后置 NULL，
  //    快照仍在，见 db.js 的列注释），所以这条路径是正常数据会走到的。
  const codeDeliveredNotUsed = await db.all(`SELECT di.order_id AS orderId, o.order_no AS orderNo, di.value AS code, o.product_id AS orderProductId,
              pc.id AS codeId, pc.status AS codeStatus, pc.order_id AS codeOrderId, pc.product_id AS codeProductId
         FROM order_delivery_items di
         JOIN orders o ON o.id = di.order_id
    LEFT JOIN product_codes pc ON pc.product_id <=> o.product_id AND pc.code = di.value
        WHERE di.kind = 'code'
          AND (pc.id IS NULL OR pc.status != 'used' OR NOT (pc.order_id <=> di.order_id))`);
  for (const r of codeDeliveredNotUsed) {
    issues.push({
      kind: pcKind(r),
      orderId: r.orderNo,
      resource: r.code,
      detail:
        r.codeId == null
          ? `订单 ${r.orderNo} 有交付行（码 ${mask(r.code)}），但该商品的码池里**没有这个码**——池被重建/导入丢了，或交付行来自另一个商品`
          : `订单 ${r.orderNo} 已交付码 ${mask(r.code)}，但池里它是 status=${r.codeStatus}、order_id=${r.codeOrderId ?? 'NULL'}——**恢复旧库后码回未用是最危险的一种**：它会被再发给别的买家`,
    });
  }

  // ② 池里 used 但没有对应交付行（交付记录被回退）
  const codeUsedWithoutDelivery = await db.all(`SELECT pc.product_id AS productId, pc.code AS code, pc.order_id AS orderId, o.order_no AS orderNo
         FROM product_codes pc
    LEFT JOIN order_delivery_items di ON di.order_id = pc.order_id AND di.kind = 'code' AND di.value = pc.code
    LEFT JOIN orders o ON o.id = pc.order_id
        WHERE pc.status = 'used' AND di.id IS NULL`);
  for (const r of codeUsedWithoutDelivery) {
    issues.push({
      kind: 'code-used-without-delivery',
      orderId: r.orderNo || null,
      resource: r.code,
      detail: `码池说码 ${mask(r.code)} 已分配给订单 ${r.orderNo || '（无）'}，但该订单**没有对应的交付行**——交付记录疑似被回退（收据/举证链断裂）`,
    });
  }

  // ③ NFT 交付同样两条（tokenId 池）；匹配键同样 NULL 安全，理由逐字同 ①
  const nftDeliveredNotUsed = await db.all(`SELECT di.order_id AS orderId, o.order_no AS orderNo, di.value AS tokenId, o.product_id AS orderProductId,
              pt.id AS tokenRowId, pt.status AS tokenStatus, pt.order_id AS tokenOrderId
         FROM order_delivery_items di
         JOIN orders o ON o.id = di.order_id
    LEFT JOIN product_nft_tokens pt ON pt.product_id <=> o.product_id AND pt.token_id = di.value
        WHERE di.kind = 'nft'
          AND (pt.id IS NULL OR pt.status != 'used' OR NOT (pt.order_id <=> di.order_id))`);
  for (const r of nftDeliveredNotUsed) {
    issues.push({
      kind: r.tokenRowId == null ? 'nft-delivered-without-pool-row' : 'nft-delivered-not-used',
      orderId: r.orderNo,
      resource: r.tokenId,
      detail:
        r.tokenRowId == null
          ? `订单 ${r.orderNo} 有 NFT 交付行（tokenId ${r.tokenId}），但该商品的 tokenId 池里没有这一行`
          : `订单 ${r.orderNo} 已交付 tokenId ${r.tokenId}，但池里它是 status=${r.tokenStatus}、order_id=${r.tokenOrderId ?? 'NULL'}——它会再次出现在可交付池里（同一枚 NFT 双交付）`,
    });
  }

  const nftUsedWithoutDelivery = await db.all(`SELECT pt.product_id AS productId, pt.token_id AS tokenId, pt.order_id AS orderId, o.order_no AS orderNo
         FROM product_nft_tokens pt
    LEFT JOIN order_delivery_items di ON di.order_id = pt.order_id AND di.kind = 'nft' AND di.value = pt.token_id
    LEFT JOIN orders o ON o.id = pt.order_id
        WHERE pt.status = 'used' AND di.id IS NULL`);
  for (const r of nftUsedWithoutDelivery) {
    issues.push({
      kind: 'nft-used-without-delivery',
      orderId: r.orderNo || null,
      resource: r.tokenId,
      detail: `tokenId 池说 ${r.tokenId} 已交付给订单 ${r.orderNo || '（无）'}，但该订单没有对应的交付行`,
    });
  }

  /*
    ④「交付行所属订单的商品与码池行的商品不一致（串商品）」——**已删除**（源码审计 2026-09 复审，P2）。

    旧 SQL 是 `JOIN product_codes pc ON pc.code = di.value WHERE pc.product_id != o.product_id`：
    它没限定 `pc.product_id = o.product_id`，因此只要**任何一个别商品的池**里有同名字符串的码，
    这条判据就会命中——而 `db.js` 的码唯一约束是 `(product_id, code)`，同一个码串存在于两个商品池
    是 schema **允许**的正常数据。结果是自洽的数据被判成 `code-product-mismatch`、
    `check:integrity` 退出码变 2，而该工具给出的处置建议是"优先重建库"——一个会导致
    **误删正常数据**的假阳性，比不报更糟。
    它想查的"串商品"真阳性（交付行指到一个不属于该商品池的码）已由判据①覆盖：
    ① 用 `LEFT JOIN ... ON pc.product_id = o.product_id`，`pc.id IS NULL` 正是"本商品的池里没有这个码"。
  */

  const countOf = (k) => issues.filter((i) => i.kind === k).length;

  /*
    ⑥ 四个**计数器**的对拍（2026-10-17 新增）。

    这四列是"先读计数再写入"落成"可条件更新的计数器"之后新增的状态（见 db.js 的建表注释与
    TRIGGER_DDL），它们的不变量此前**没有任何校验器**——`integrity.js` 零命中。漂移的症状是
    静默的：`reserved_codes` 偏大 ⇒ 商品卖不出去；偏小 ⇒ 超卖；`committed` 偏大 ⇒ 少卖；
    `hold_qty` 与 quantity 不一致 ⇒ 释放/恢复时按错的数量加减。没有一条会报错，只能对拍。

    为什么在 integrity 里：它是**唯一能读全表**的地方（节点运行时各条闸只看自己那一行/那一批）。

    口径（与 db.js 的触发器逐字同源，不另写一套）：
      · products.reserved_codes = Σ 该商品「在途四态（draft/escrowed/shipped/disputed）订单
        尚未交付的件数」，每单先按 0 夹逼——与触发器 ④/⑤ 的 GREATEST(...) 同一个算式；
        reserved_tokens 同理（kind 决定哪一列该有值，另一列期望 0）。
      · product_skus.committed = Σ 该 (商品, 组合) 仍押着的占位（released_qty < hold_qty；
        旧行 released_at 非空视为整单已释放）。
      · orders.hold_qty 只可能是 0 或 quantity（占位成功写 quantity，否则 0；切回限量时补记 quantity）。
      · orders.released_qty 只可能是 0..hold_qty（多件订单部分退货时逐件推进）。
      · 押着占位却找不到对应 SKU 行 / 商品行已删 ⇒ **不可对拍**，如实报出来而不是折成 0。
    SQL 里的 CAST(quantity AS SIGNED) 不能省：quantity 是 UNSIGNED，无符号减法在负数上会抛错
    （与触发器那边同一条坑）。
  */
  const counter = await checkReservationCounters(db);
  issues.push(...counter.issues);

  // ⑤ 管理审计哈希链（2026-09 新增）：审计行有没有被事后改过/删过。
  //    断裂逐条入 issues（kind 直接用 auditChain.js 的三种形状，避免两处各起一套名字）；
  //    未哈希行**不入 issues**——它们是三态里的"早于哈希链、无法校验"，报成不一致等于把
  //    历史行说成篡改（见 auditChain.js 三态纪律），只从计数与 auditChain 块里提示。
  const auditChain = await verifyAuditChain(db);
  for (const b of auditChain.broken) {
    issues.push({ kind: b.kind, auditId: b.id, detail: b.detail });
  }

  return {
    issues,
    counts: {
      codeDeliveredNotUsed: countOf('code-delivered-not-used') + countOf('code-delivered-without-pool-row'),
      codeUsedWithoutDelivery: countOf('code-used-without-delivery'),
      nftDeliveredNotUsed: countOf('nft-delivered-not-used') + countOf('nft-delivered-without-pool-row'),
      nftUsedWithoutDelivery: countOf('nft-used-without-delivery'),
      auditChainBroken:
        countOf('audit-hash-mismatch') + countOf('audit-prev-hash-mismatch') + countOf('audit-entry-hash-missing'),
      reservedCodesDrift: countOf('reserved-codes-drift'),
      reservedTokensDrift: countOf('reserved-tokens-drift'),
      committedDrift: countOf('committed-drift'),
      holdQtyMismatch: countOf('hold-qty-mismatch'),
      holdWithoutSku: countOf('hold-without-sku'),
      counterNotComparable: countOf('counter-not-comparable'),
    },
    checked: {
      deliveryItems: (await db.get('SELECT COUNT(*) AS c FROM order_delivery_items')).c,
      codesUsed: (await db.get("SELECT COUNT(*) AS c FROM product_codes WHERE status = 'used'")).c,
      nftUsed: (await db.get("SELECT COUNT(*) AS c FROM product_nft_tokens WHERE status = 'used'")).c,
      auditEntries: auditChain.entries,
      auditUnhashed: auditChain.unhashedCount,
      productCounters: counter.checked.productCounters,
      skuCounters: counter.checked.skuCounters,
      ordersWithHold: counter.checked.ordersWithHold,
    },
    auditChain,
  };
}

/** 在途四态：池占位覆盖的订单状态集（与 db.js 的 TRIGGER_DDL ④/⑧ 是同一个集合） */
const IN_FLIGHT_STATUS_SQL = "('draft','escrowed','shipped','disputed')";

/**
 * 四个计数器的对拍（见 `findIntegrityIssues` 里 ⑥ 的说明）。
 *
 * 返回 `{ issues, checked }`：`checked` 是"真的对拍了多少行"，`issues` 里的
 * `counter-not-comparable` 是"这一行查不出来"——**不折成 0**。
 */
async function checkReservationCounters(db) {
  const issues = [];
  const checked = { productCounters: 0, skuCounters: 0, ordersWithHold: 0 };

  /*
    A. 池占位的真值：按"在途四态订单的未交付件数"逐单算，再按商品求和。
    delivered 计数先按 kind 分组一次（两个 LEFT JOIN），避免对每张订单跑相关子查询。
  */
  const demand = await db.all(`SELECT o.product_id AS productId,
              SUM(GREATEST(CAST(o.quantity AS SIGNED) - COALESCE(dc.cnt, 0), 0)) AS codeNeed,
              SUM(GREATEST(CAST(o.quantity AS SIGNED) - COALESCE(dn.cnt, 0), 0)) AS tokenNeed
         FROM orders o
    LEFT JOIN (SELECT order_id, COUNT(*) AS cnt FROM order_delivery_items WHERE kind = 'code' GROUP BY order_id) dc
           ON dc.order_id = o.id
    LEFT JOIN (SELECT order_id, COUNT(*) AS cnt FROM order_delivery_items WHERE kind = 'nft' GROUP BY order_id) dn
           ON dn.order_id = o.id
        WHERE o.status IN ${IN_FLIGHT_STATUS_SQL}
        GROUP BY o.product_id`);
  const demandByProduct = new Map(demand.map((r) => [String(r.productId), r]));
  for (const r of demand) {
    if (r.productId != null) continue;
    const codeNeed = Number(r.codeNeed || 0);
    const tokenNeed = Number(r.tokenNeed || 0);
    if (codeNeed > 0 || tokenNeed > 0) {
      // 商品行没了（orders.product_id 被置 NULL），这份需求没有任何 products 行可以与之对拍
      issues.push({
        kind: 'counter-not-comparable',
        detail: `有 ${codeNeed} 件兑换码 / ${tokenNeed} 枚 NFT 的在途未交付需求属于 product_id=NULL 的订单——商品行已删，无法与任何 reserved_* 计数器对拍`,
      });
    }
  }

  const products = await db.all(`SELECT p.id AS productId, p.slug AS slug, p.kind AS kind,
              p.reserved_codes AS reservedCodes, p.reserved_tokens AS reservedTokens
         FROM products p ORDER BY p.id`);
  for (const p of products) {
    const d = demandByProduct.get(String(p.productId));
    // kind 决定哪一列该有值；改动商品类型会让另一列上的旧占位永远无人结清 ⇒ 也要报
    const codeTruth = p.kind === 'digital' ? Number(d?.codeNeed || 0) : 0;
    const tokenTruth = p.kind === 'nft' ? Number(d?.tokenNeed || 0) : 0;
    checked.productCounters += 1;
    const codes = Number(p.reservedCodes);
    if (codes !== codeTruth) {
      issues.push({
        kind: 'reserved-codes-drift',
        resource: p.slug,
        detail:
          `商品 ${p.slug}（${p.kind}）的 reserved_codes=${codes}，而按在途订单尚未交付的件数算出来是 ${codeTruth}` +
          `（差 ${codes - codeTruth > 0 ? '+' : ''}${codes - codeTruth}）——偏大 ⇒ 有件数永远卖不出去，偏小 ⇒ 超卖`,
      });
    }
    const tokens = Number(p.reservedTokens);
    if (tokens !== tokenTruth) {
      issues.push({
        kind: 'reserved-tokens-drift',
        resource: p.slug,
        detail:
          `商品 ${p.slug}（${p.kind}）的 reserved_tokens=${tokens}，而按在途订单尚未交付的枚数算出来是 ${tokenTruth}` +
          `（差 ${tokens - tokenTruth > 0 ? '+' : ''}${tokens - tokenTruth}）`,
      });
    }
  }

  /*
    B. product_skus.committed 的真值：该 (商品, 组合) 仍押着的占位合计
    （`released_qty < hold_qty`，与 stockHold.occupyingSql 同一条谓词——
    状态列不是判据：一条订单可以走到任何状态而占位仍在；部分退货只释放 released_qty 件）。
  */
  const held = await db.all(`SELECT product_id AS productId, sku_key AS skuKey, SUM(hold_qty - released_qty) AS held
         FROM orders
        WHERE hold_qty > released_qty AND NOT (released_qty = 0 AND released_at IS NOT NULL) AND product_id IS NOT NULL
        GROUP BY product_id, sku_key`);
  const heldBySku = new Map(held.map((r) => [skuKeyOf(r.productId, r.skuKey), Number(r.held || 0)]));
  const skus = await db.all(`SELECT s.product_id AS productId, s.sku_key AS skuKey, s.committed AS committed, p.slug AS slug
         FROM product_skus s JOIN products p ON p.id = s.product_id
        ORDER BY s.product_id, s.sku_key`);
  for (const s of skus) {
    checked.skuCounters += 1;
    const truth = heldBySku.get(skuKeyOf(s.productId, s.skuKey)) ?? 0;
    const counter = Number(s.committed);
    if (counter !== truth) {
      issues.push({
        kind: 'committed-drift',
        resource: s.slug,
        detail:
          `商品 ${s.slug} 组合「${s.skuKey || '默认'}」的 committed=${counter}，而仍押着的占位合计是 ${truth}` +
          `（差 ${counter - truth > 0 ? '+' : ''}${counter - truth}）——它正是"还剩几件"的唯一读数`,
      });
    }
  }

  // C. 押着占位却找不到 SKU 行（商品被删/组合键被改名）：这份占位不会被任何 committed 计入
  const unpaired = await db.all(`SELECT o.id AS orderId, o.order_no AS orderNo, o.product_id AS productId,
              o.sku_key AS skuKey, o.hold_qty AS holdQty
         FROM orders o
    LEFT JOIN product_skus s ON s.product_id = o.product_id AND s.sku_key = o.sku_key
        WHERE o.hold_qty > o.released_qty AND NOT (o.released_qty = 0 AND o.released_at IS NOT NULL)
          AND o.product_id IS NOT NULL AND s.id IS NULL`);
  for (const r of unpaired) {
    issues.push({
      kind: 'hold-without-sku',
      orderId: r.orderNo,
      detail:
        `订单 ${r.orderNo} 仍押着 ${r.holdQty} 件占位，但 (商品 ${r.productId}, 组合「${r.skuKey || '默认'}」) 的 SKU 行已不存在` +
        '——这份占位不属于任何 committed 计数器（释放时也匹配不到库存行）',
    });
  }

  /*
    D. orders.hold_qty 的形状：只可能是 0 或 quantity。
    占位成功写 quantity、不限量/池式写 0、"不限量 → 限量"补记时写 quantity（见 routes/orders.js）。
    任何第三个值都意味着某条写入路径按错的数量加减过 committed。
  */
  const badHolds = await db.all(`SELECT id AS orderId, order_no AS orderNo, quantity, hold_qty AS holdQty
         FROM orders WHERE hold_qty <> 0 AND hold_qty <> quantity`);
  for (const r of badHolds) {
    issues.push({
      kind: 'hold-qty-mismatch',
      orderId: r.orderNo,
      detail: `订单 ${r.orderNo} 的 hold_qty=${r.holdQty}，但 quantity=${r.quantity}——占位只可能是 0 或 quantity（这个值会让释放/恢复按错的数量加减 committed）`,
    });
  }

  // E. 押着占位却连商品归属都没有（product_id 为 NULL）：无法与任何 SKU 行对拍，如实报
  const unattributable = await db.all(`SELECT id AS orderId, order_no AS orderNo, hold_qty AS holdQty
         FROM orders WHERE hold_qty > released_qty AND NOT (released_qty = 0 AND released_at IS NOT NULL)
          AND product_id IS NULL`);
  for (const r of unattributable) {
    issues.push({
      kind: 'counter-not-comparable',
      orderId: r.orderNo,
      detail: `订单 ${r.orderNo} 仍押着 ${r.holdQty} 件占位，但 product_id 为 NULL（商品行已删）——无法与任何 SKU 的 committed 对拍`,
    });
  }

  checked.ordersWithHold = (await db.get('SELECT COUNT(*) AS c FROM orders WHERE hold_qty > 0')).c;
  return { issues, checked };
}

/** (商品, 组合) 的复合键：sku_key 允许为空串，所以不能用分隔符拼字符串（空串会与"没有 key"同形） */
function skuKeyOf(productId, skuKey) {
  return `${String(productId)}\u0000${String(skuKey ?? '')}`;
}

/** 池里根本没有这一行 ⇒ 与"有行但状态不对"是两种不同的故障，分开报 */
function pcKind(r) {
  return r.codeId == null ? 'code-delivered-without-pool-row' : 'code-delivered-not-used';
}

/** 码/tokenId 是敏感资源：报告里只留前 6 位 + 长度，够定位、不够直接用 */
function mask(v) {
  const s = String(v ?? '');
  return s.length <= 8 ? `${s.slice(0, 2)}…(${s.length})` : `${s.slice(0, 6)}…(${s.length})`;
}
