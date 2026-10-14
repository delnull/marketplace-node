/**
 * 有限库存占位/释放（防超卖）——逐单占位记账（v2 greenfield 模型）：
 *
 * - product_skus.capacity 列 = 该组合的总量（NULL=不限量）；
 * - product_skus.committed 列 = 该组合的销量/已占位（件数口径）；
 *   定位键是 (product_id, sku_key) —— 无规格商品的 sku_key 为 ''；
 * - orders.hold_qty = 该订单「应占位件数」：下单事务内商品限量且占位成功 → quantity，
 *   不限量/池式商品 → 0。随订单行存续，是释放/恢复的唯一记账依据——
 *   商品任意切换限量/不限量都不会产生账目漂移：
 *   - 从未占位（hold_qty=0）的订单取消/退款 → 释放扣 0，不误扣 committed；
 *   - 限量期下单（hold_qty>0）后卖家改不限量 → 释放照常回补（卖家放开的是承诺上限，不是已占位）；
 *   - 取消后恢复（sync/watcher 自动复活）→ restockOrder 按 hold_qty 条件重新占位。
 * - orders.released_at = 释放幂等标记（非空即已释放）：释放 = 置 released_at + 回补 committed，
 *   重复触发不再二次扣减（同一订单只能被释放一次，即使状态迁移被两条路径竞争触发）。
 *
 * 释放单点契约（防漏挂）：订单从占用态（draft/escrowed/shipped/disputed）迁出到
 * 释放态（cancelled/refunded/expired——终结且未成交）的状态迁移成功后，
 * **必须且仅需**调用本模块释放入口一次：批量路径 releaseHoldsForOrderIds，
 * 退款终局路径 releaseRefundedEscrow（仅未交付行）。
 * 已成交（confirmed/settled）默认不释放（货已承诺/已交付），但**"从未交付"是例外**
 * （见 releaseHoldsForReturnReceived：那类单的占位滞留纯属账目错误，会把限量 SKU 永久钉住一件货）；
 * 已交付后退款（shipped/部分交付 → refunded）同样不自动回补（货在买家侧，需线下回收，
 * 与 shipped → expired 不释放同口径防超卖）——见 releaseRefundedEscrow。
 *
 * D1 例外（releaseHoldsForReturnReceived）：终局「成交向」状态（confirmed/settled/expired）里，
 * 货**不在买家手里**的两种情形（从未交付 / 退货已确认收到或卖家放弃追索）都回补占位。
 * 覆盖 watcher 三条终局事件（ReceiptConfirmed / Arbitrated 判卖家 / OrderExpiredReleased）
 * 与 sync Settled 兜底、receive/waive 晚于终局迁移的动作路径（settleReturn）。
 *
 * 原子性说明：SQLite 单写者连接 + 同步执行，条件 UPDATE 天然串行；
 * 占位失败发生在调用方事务内（ROLLBACK 后无残留副作用）。
 */
import { getDb, txBegin, txCommit, txRollback } from './db.js';
import { INCOME_IN, INCOME_STATUS, DRAFT_OR_ACTIVE_IN } from './orderStatus.js';

/** 占位：该组合销量 +quantity（默认 1），成功返回 true
 *  （committed + qty ≤ capacity 校验失败、或该组合不限量时返回 false——不限量不占位）
 *  skuKey 为 '' 表示无规格商品的唯一组合。 */
export function holdStock(productId, skuKey = '', quantity = 1) {
  const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const { changes } = getDb()
    .prepare(
      'UPDATE product_skus SET committed = committed + ? WHERE product_id = ? AND sku_key = ? AND capacity IS NOT NULL AND committed + ? <= capacity'
    )
    .run(qty, productId, String(skuKey ?? ''), qty);
  return changes === 1;
}

/** 释放内核：把给定「已离开占用态」的本地订单 id 集合中**本次新释放**的行（status 命中调用方
 * 传入的终局状态白名单 且 released_at 为空 且 hold_qty > 0）置 released_at，
 * 并按 (商品, 组合) 聚合回补 committed（一次 UPDATE，仅扣真实占位的 hold_qty）。
 * 幂等：已置 released_at 的行（先前释放过/恢复后又释放）不会二次扣减。
 * 状态白名单由各调用方按其业务语义提供——常规释放集为 cancelled/refunded/expired，
 * D1 例外（货已回卖家侧的成交终局）另行传入 settled/confirmed（见 releaseHoldsForReturnReceived），
 * 防止误把仍占用/成交中的行释放。
 */
function releaseCore(orderIds, statuses) {
  const ids = [...new Set((orderIds || []).map((x) => String(x)).filter(Boolean))];
  if (!ids.length) return 0;
  const marks = ids.map(() => '?').join(',');
  const statusMarks = (statuses || []).map(() => '?').join(',');
  const db = getDb();
  // 标记（置 released_at）与回补（减 committed）同事务：防进程中断造成「已标记未回补」的永久泄漏；
  // SAVEPOINT 嵌套：本函数可被调用方已在的显式分组（cancel/sweeper/watcher/sync）再包一层
  txBegin();
  try {
    /*
      1) 先标记本次新释放的行，并**用 RETURNING 精确取回本批实际命中的 id**。

      为什么不再用"批次号 + released_at = batch 聚合"（源码审计 2026-09 复审，本次修正）：
        · 旧实现的批次号是**进程内**计数器（重启从 1 开始）却写进**持久**的 `released_at`，
          于是"上一轮进程写过 released_at = 1 的行"与新进程的 batch = 1 **数值相同**；
          只要某次调用的 id 集合里同时含"本轮新标记的行"与"上一轮遗留的行"，
          第 2 步的子查询就会把后者也算进本批，`committed` 被**多减**——多出来的额度变成可售库存（超卖）。
          （当前四个调用点都不会构造这种混合集合，属潜伏缺陷；但"靠调用点自觉"不是防线。）
        · 它同时让 `released_at` 的取值变成 1/2/3… 的批次号，与 `db.js` 里该列声明的
          "占位释放时刻"相反——一个字段两种含义，读代码的人只能靠猜。
      现在两个问题一起消失：命中集合由 RETURNING 给出（进程间天然唯一），
      `released_at` 回归"释放时刻"的语义。
    */
    const marked = db
      .prepare(
        `UPDATE orders SET released_at = ? WHERE id IN (${marks})
           AND status IN (${statusMarks}) AND hold_qty > 0 AND released_at IS NULL
         RETURNING id`
      )
      .all(Date.now(), ...ids, ...statuses);
    if (!marked.length) {
      txCommit();
      return 0;
    }
    // 2) 只对本批**实际标记**的那些行按 (商品, 组合) 聚合回补（marked 即本轮的原子凭据）
    const markedIds = marked.map((r) => r.id);
    const markedMarks = markedIds.map(() => '?').join(',');
    const { changes } = db
      .prepare(
        `UPDATE product_skus SET committed = MAX(0, committed - (
           SELECT COALESCE(SUM(o.hold_qty), 0) FROM orders o
           WHERE o.product_id = product_skus.product_id
             AND o.sku_key = product_skus.sku_key
             AND o.id IN (${markedMarks})
         ))
         WHERE (product_id, sku_key) IN (
           SELECT product_id, sku_key FROM orders WHERE id IN (${markedMarks})
         )`
      )
      .run(...markedIds, ...markedIds);
    txCommit();
    return changes;
  } catch (e) {
    txRollback();
    throw e;
  }
}

/**
 * 「**已交付事实**」的**唯一判据**（2026-10-13 收口；四处共用：本模块的三个释放入口 + watcher 的超时释放）。
 *
 * 已交付 = `shipped_at`（发货标记，含自提/线下交付这种空物流单号形态）∨ `tracking_no` ∨ 存在交付行
 *          ∨ 本地状态已是 `shipped`。
 *
 * 为什么必须只有一处判据：这四个地方的结论方向相反却共用同一个事实——
 *   · 释放占位时它回答"货还在不在买家手里"（判错=把已经交出去的货重新变成可售 ⇒ 超卖）；
 *   · 退款终局时它回答"要不要等退货"（判错=货在买家侧就回补了额度 ⇒ 超卖）；
 *   · 而"从未交付"这一侧此前**没有任何入口**（见 `releaseHoldsForReturnReceived`）⇒ 占位永久滞留。
 * 口径只要有一处不同，同一单就会在不同路径上得到相反待遇。
 */
export function isDelivered(row) {
  if (!row) return false;
  return !!(
    row.shipped_at ||
    row.tracking_no ||
    row.delivered_items ||
    row.items ||
    String(row.status || '') === 'shipped'
  );
}

/**
 * 「**这一单的库存承诺还没结清**」的 SQL 谓词（**唯一实现**；2026-10-14 审计新增）。
 *
 * 判据是两个出口的**并集**，两个方向都故意取安全侧：
 *   · `o.status IN (在途集合)` —— 订单生命还没走完（草稿/托管中/已发货/争议中）；
 *   · 或者 `(o.hold_qty > 0 AND o.released_at IS NULL AND 退货未确认收到)` ——
 *     生命走完了但**占位还押着**，且货没回到店主手里。
 *
 * 第二个出口就是本次修的那个洞：**已交付后退款**（`status = 'refunded'`）的单
 * `releaseRefundedEscrow` **刻意不释放**（货在买家手里，需线下回收）。旧的状态白名单
 * `status IN DRAFT_OR_ACTIVE_IN` 看不见它们——于是店主把规格选项名从「红」改成「深红」时，
 * `saveSkus` 按**同 key** 继承 `committed` 继承不到，那一行的已占位数静默归零，
 * 同一件实物可被再卖一次（**超卖**，受害方是下一个买家，且无任何错误码或审计痕迹）。
 *
 * 为什么要并上"在途集合"（而不是只留第二个出口）：在途但**曾释放过占位**的行
 * （`released_at` 非空，例如取消后又恢复的单）同样是未结清的承诺，必须继续挡住改名。
 * 方向是安全的：多算 ⇒ 更容易拒绝这次规格变更，而不是把 `committed` 记成偏小（那才会超卖）。
 *
 * 用法：`WHERE ${stockPromiseSql('o')}`（表别名可换，默认 `o`）。
 */
export function stockPromiseSql(alias = 'o') {
  return `(${alias}.status IN ${DRAFT_OR_ACTIVE_IN} OR (${alias}.hold_qty > 0 AND ${alias}.released_at IS NULL AND NOT EXISTS (SELECT 1 FROM order_returns r WHERE r.order_id = ${alias}.id AND r.received_at IS NOT NULL)))`;
}

/**
 * 「**还押着占位**」的 SQL 谓词：`hold_qty > 0` ∧ `released_at IS NULL`。
 *
 * 与 `stockPromiseSql` 的分工：这个回答"占位还在不在册"（释放/回补类判据用它），
 * 那个回答"承诺结清了没有"（规格改名这类**拒绝性**判据用它，取并集更安全）。
 * 两个条件缺一不可，而且**状态列不是判据**：一条订单可以走到任何状态而占位仍在。
 */
export function occupyingSql(alias = 'o') {
  return `${alias}.hold_qty > 0 AND ${alias}.released_at IS NULL`;
}

/**
 * 「**还没记进 `committed` 的承诺量**」的 SQL 谓词：`hold_qty = 0`。
 * 用于"不限量 → 限量"切换时的**补记**核算（不限量期间下的单从未占位，承诺量没记进 `committed`）。
 *
 * 为什么它必须是 `hold_qty = 0`：`committed` 只统计**占位在册**的行；把 `hold_qty > 0` 的行
 * 也当成"未记入的承诺"，补记时会**重复计入**（`committed` 记两遍 ⇒ 虚高 ⇒ 该商品卖不出去）。
 */
export function uncommittedPromiseSql(alias = 'o') {
  return `${alias}.hold_qty = 0`;
}

/**
 * 常规批量释放入口（终局且未成交：cancelled/refunded/expired）
 */

export function releaseHoldsForOrderIds(orderIds) {
  return releaseCore(orderIds, ['cancelled', 'refunded', 'expired']);
}

/**
 * 终局「成交向」订单的占位回补：**仅当货已实际回到卖家侧**（原 D1 口径，2026-10-13 复核后保留）。
 *
 * 场景：订单已交付 → 退货协调中卖家已确认收到退货（`order_returns.received_at` 非空，含放弃追索
 * waived）→ 链上终局却是非退款路径（ReceiptConfirmed→confirmed / Arbitrated 判卖家→settled /
 * OrderExpiredReleased→expired）——实物可再售，占位不再有"防超卖"意义，应当回补。
 *
 * **为什么"从未交付的成交向单"刻意不在这里自动释放**（2026-10-13 评估结论，推翻当天早些时候的改动）：
 * 本地唯一能回答"货在不在买家手里"的证据就是交付记录，而**没有交付记录 ≠ 没交付**——
 * 线下交付/自提/卖家漏记都会产生"已成交且无任何交付痕迹"的行；而 `confirmed` 恰恰是**买家自己**
 * 说"我收到了"。在这种行上自动回补，等于把一个**不可判定**的事实当成"货没出去"，
 * 后果是把已经交到买家手里的货重新变成可售 ⇒ 超卖（比占位滞留贵得多：买家拿不到货 + 争议 + 赔付）。
 * 代价是：一笔"真没发货、却被仲裁判了卖家"的单会把 `committed` 永久钉住一件——这是**账目**
 * 问题，店主可经商品编辑扩容解决，且方向安全。**要真正消除它，正确做法是把这种行暴露给店主**
 * （谁发货谁最清楚），而不是让节点替他在两个方向里猜一个。
 *
 * 判据：status ∈ 终局成交态 ∧ 存在 received_at 非空的退货单 ∧ 尚未释放。
 * `released_at` 幂等保证与 refunded 终局路径先后触发只回补一次。
 */
export function releaseHoldsForReturnReceived(escrowOrderId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT o.id
       FROM orders o
       JOIN order_returns r ON r.order_id = o.id
       WHERE o.escrow_order_id = ? AND r.received_at IS NOT NULL
         AND o.status IN ${INCOME_IN}
         AND o.hold_qty > 0 AND o.released_at IS NULL`
    )
    .all(String(escrowOrderId || '').toLowerCase());
  return rows.length ? releaseCore(rows.map((r) => r.id), [...INCOME_STATUS]) : 0;
}

/**
 * 退款终局（refunded）的占位回补：释放集 = 「从未交付」的行 ∪ 「已交付但退货已确认收到
 * （order_returns.received_at 非空，含卖家放弃追索 waived）」的行。
 * 「已交付事实」= shipped_at（发货标记，含自提/线下交付等空物流单号形态）∨ tracking_no ∨
 * 交付行存在——此前仅以 tracking_no/交付行判已交付，空单号发货（自提当面交付）被
 * 误判为从未交付而自动回补，货在买家侧即额度释放 → 超卖；且退货单无法创建（hasDelivered
 * 同漏）。已交付且退货未确认收到 → 不释放（货在买家侧，防同一批实物/资源被再次承诺；等待
 * 卖家 receive/waive 后由动作路径释放——released_at 幂等记账保证只回补一次）。
 * 码/NFT 交付行本身不回池复用（买家可能已用），receive/waive 只解锁限量容量的占位。
 */
export function releaseRefundedEscrow(escrowOrderId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT o.id, o.shipped_at, o.tracking_no,
              (SELECT COUNT(*) FROM order_delivery_items d WHERE d.order_id = o.id) AS delivered_items,
              (SELECT received_at FROM order_returns r WHERE r.order_id = o.id) AS return_received_at
       FROM orders o WHERE o.escrow_order_id = ? AND o.status = 'refunded'`
    )
    .all(String(escrowOrderId || '').toLowerCase());
  const releaseIds = rows
    .filter((r) => !isDelivered(r) || r.return_received_at != null)
    .map((r) => r.id);
  return releaseIds.length ? releaseHoldsForOrderIds(releaseIds) : 0;
}

/**
 * 恢复占位（sync/watcher 将 cancelled 恢复为 escrowed 前调用）：
 *  - 从未占位（hold_qty=0，不限量期下单）→ 无需恢复，成功；
 *  - 商品已改为不限量 → 旧占位作废（与释放守卫同口径），标记已释放并成功；
 *  - 商品仍限量 → 条件占位 hold_qty 件，容量不足（取消期间被卖完）返回 false，由调用方告警。
 * 恢复成功后清空 released_at（该行回到占用态，将来可再次正常释放）。
 */
export function restockOrder(orderId) {
  const db = getDb();
  const row = db.prepare('SELECT id, product_id, sku_key, quantity, hold_qty, released_at FROM orders WHERE id = ?').get(String(orderId || ''));
  if (!row || row.product_id == null) return true; // 商品已删：无库存可占，视为成功
  const hold = row.hold_qty || 0;
  if (hold <= 0) return true; // 从未占位（不限量期下单），无可恢复
  if (row.released_at == null) return true; // 未释放过（未被取消流程回补），无需恢复
  const skuKey = String(row.sku_key ?? '');
  const p = db.prepare('SELECT capacity FROM product_skus WHERE product_id = ? AND sku_key = ?').get(row.product_id, skuKey);
  if (!p) return true; // 组合已不存在（商品被改规格/删除）：无可占库存，视为成功
  // 恢复 = 占位 + 清释放标记，两语句同事务（防进程中断半写：已占位未清标记 → 该行既占额
  // 又被视为已释放，后续取消不再回补 → 永久幻影占额）
  txBegin();
  try {
    if (p.capacity === null) {
      // 该组合已改为不限量：旧占位作废，标记该行无需再恢复（仍保持 released 语义）
      db.prepare('UPDATE orders SET hold_qty = 0 WHERE id = ?').run(row.id);
      txCommit();
      return true;
    }
    if (!holdStock(row.product_id, skuKey, hold)) {
      txRollback();
      return false;
    }
    db.prepare('UPDATE orders SET released_at = NULL WHERE id = ?').run(row.id);
    txCommit();
    return true;
  } catch (e) {
    txRollback();
    throw e;
  }
}
