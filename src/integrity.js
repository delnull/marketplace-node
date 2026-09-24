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
 * 另有一项（⑤）**管理审计哈希链**：上面四条查的是"从旧备份恢复"（记录被整体回退），
 * 这一条查的是"拿到磁盘写权限的人事后改审计"——审计行带 prev_hash/entry_hash，重算对不上就是
 * 被改过。判据、三态纪律与"能查出什么/查不出什么"全在 `src/auditChain.js` 的文件头；
 * 这里只做两件事：断裂逐条进 `issues`（带 `auditId`）、**未哈希的历史行只进计数**——
 * "升级前的行没有哈希"不是篡改证据，不该被报成不一致（那会让真正的断裂淹没在噪声里）。
 */
import { getDb } from './db.js';
import { verifyAuditChain } from './auditChain.js';

/**
 * @param {import('node:sqlite').DatabaseSync} [db]
 * @returns {{issues: Array<{kind:string, detail:string, orderId?:string|null, resource?:string|null, auditId?:number}>,
 *            counts: {codeDeliveredNotUsed:number, codeUsedWithoutDelivery:number, nftDeliveredNotUsed:number,
 *                     nftUsedWithoutDelivery:number, productMismatch:number, auditChainBroken:number},
 *            checked: {deliveryItems:number, codesUsed:number, nftUsed:number, auditEntries:number, auditUnhashed:number},
 *            auditChain: ReturnType<typeof verifyAuditChain>}}
 */
export function findIntegrityIssues(db = getDb()) {
  const issues = [];

  // ① 已交付的码：池里不是 used，或 order_id 指向别的单
  const codeDeliveredNotUsed = db
    .prepare(
      `SELECT di.order_id AS orderId, di.value AS code, o.product_id AS orderProductId,
              pc.id AS codeId, pc.status AS codeStatus, pc.order_id AS codeOrderId, pc.product_id AS codeProductId
         FROM order_delivery_items di
         JOIN orders o ON o.id = di.order_id
    LEFT JOIN product_codes pc ON pc.product_id = o.product_id AND pc.code = di.value
        WHERE di.kind = 'code'
          AND (pc.id IS NULL OR pc.status != 'used' OR pc.order_id IS NOT di.order_id)`
    )
    .all();
  for (const r of codeDeliveredNotUsed) {
    issues.push({
      kind: pcKind(r),
      orderId: r.orderId,
      resource: r.code,
      detail:
        r.codeId == null
          ? `订单 ${r.orderId} 有交付行（码 ${mask(r.code)}），但该商品的码池里**没有这个码**——池被重建/导入丢了，或交付行来自另一个商品`
          : `订单 ${r.orderId} 已交付码 ${mask(r.code)}，但池里它是 status=${r.codeStatus}、order_id=${r.codeOrderId || 'NULL'}——**恢复旧库后码回未用是最危险的一种**：它会被再发给别的买家`,
    });
  }

  // ② 池里 used 但没有对应交付行（交付记录被回退）
  const codeUsedWithoutDelivery = db
    .prepare(
      `SELECT pc.product_id AS productId, pc.code AS code, pc.order_id AS orderId
         FROM product_codes pc
    LEFT JOIN order_delivery_items di ON di.order_id = pc.order_id AND di.kind = 'code' AND di.value = pc.code
        WHERE pc.status = 'used' AND di.id IS NULL`
    )
    .all();
  for (const r of codeUsedWithoutDelivery) {
    issues.push({
      kind: 'code-used-without-delivery',
      orderId: r.orderId || null,
      resource: r.code,
      detail: `码池说码 ${mask(r.code)} 已分配给订单 ${r.orderId || '（无）'}，但该订单**没有对应的交付行**——交付记录疑似被回退（收据/举证链断裂）`,
    });
  }

  // ③ NFT 交付同样两条（tokenId 池）
  const nftDeliveredNotUsed = db
    .prepare(
      `SELECT di.order_id AS orderId, di.value AS tokenId, o.product_id AS orderProductId,
              pt.id AS tokenRowId, pt.status AS tokenStatus, pt.order_id AS tokenOrderId
         FROM order_delivery_items di
         JOIN orders o ON o.id = di.order_id
    LEFT JOIN product_nft_tokens pt ON pt.product_id = o.product_id AND pt.token_id = di.value
        WHERE di.kind = 'nft'
          AND (pt.id IS NULL OR pt.status != 'used' OR pt.order_id IS NOT di.order_id)`
    )
    .all();
  for (const r of nftDeliveredNotUsed) {
    issues.push({
      kind: r.tokenRowId == null ? 'nft-delivered-without-pool-row' : 'nft-delivered-not-used',
      orderId: r.orderId,
      resource: r.tokenId,
      detail:
        r.tokenRowId == null
          ? `订单 ${r.orderId} 有 NFT 交付行（tokenId ${r.tokenId}），但该商品的 tokenId 池里没有这一行`
          : `订单 ${r.orderId} 已交付 tokenId ${r.tokenId}，但池里它是 status=${r.tokenStatus}、order_id=${r.tokenOrderId || 'NULL'}——它会再次出现在可交付池里（同一枚 NFT 双交付）`,
    });
  }

  const nftUsedWithoutDelivery = db
    .prepare(
      `SELECT pt.product_id AS productId, pt.token_id AS tokenId, pt.order_id AS orderId
         FROM product_nft_tokens pt
    LEFT JOIN order_delivery_items di ON di.order_id = pt.order_id AND di.kind = 'nft' AND di.value = pt.token_id
        WHERE pt.status = 'used' AND di.id IS NULL`
    )
    .all();
  for (const r of nftUsedWithoutDelivery) {
    issues.push({
      kind: 'nft-used-without-delivery',
      orderId: r.orderId || null,
      resource: r.tokenId,
      detail: `tokenId 池说 ${r.tokenId} 已交付给订单 ${r.orderId || '（无）'}，但该订单没有对应的交付行`,
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

  // ⑤ 管理审计哈希链（2026-09 新增）：审计行有没有被事后改过/删过。
  //    断裂逐条入 issues（kind 直接用 auditChain.js 的三种形状，避免两处各起一套名字）；
  //    未哈希行**不入 issues**——它们是三态里的"早于哈希链、无法校验"，报成不一致等于把
  //    历史行说成篡改（见 auditChain.js 三态纪律），只从计数与 auditChain 块里提示。
  const auditChain = verifyAuditChain(db);
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
    },
    checked: {
      deliveryItems: db.prepare('SELECT COUNT(*) AS c FROM order_delivery_items').get().c,
      codesUsed: db.prepare("SELECT COUNT(*) AS c FROM product_codes WHERE status = 'used'").get().c,
      nftUsed: db.prepare("SELECT COUNT(*) AS c FROM product_nft_tokens WHERE status = 'used'").get().c,
      auditEntries: auditChain.entries,
      auditUnhashed: auditChain.unhashedCount,
    },
    auditChain,
  };
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
