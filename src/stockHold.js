/**
 * 有限库存占位/释放（防超卖）——逐单占位记账：
 *
 * - product_skus.capacity 列 = 该组合的总量（NULL=不限量）；
 * - product_skus.committed 列 = 该组合的销量/已占位（件数口径）；
 *   定位键是 (product_id, sku_key) —— 无规格商品的 sku_key 为 ''；
 * - orders.hold_qty（TINYINT UNSIGNED）= 该订单「应占位件数」：下单事务内商品限量且占位成功
 *   → quantity，不限量/池式商品 → 0。随订单行存续，是释放/恢复的唯一记账依据——
 *   商品任意切换限量/不限量都不会产生账目漂移：
 *   - 从未占位（hold_qty=0）的订单取消/退款 → 释放扣 0，不误扣 committed；
 *   - 限量期下单（hold_qty>0）后卖家改不限量 → 释放照常回补（卖家放开的是承诺上限，不是已占位）；
 *   - 取消后恢复（sync/watcher 自动复活）→ restockOrder 按 hold_qty 条件重新占位。
 * - orders.released_at（DATETIME(3) NULL）= 释放幂等标记（非空即已释放）：释放 = 置 released_at
 *   + 回补 committed，重复触发不再二次扣减（同一订单只能被释放一次，即使状态迁移被两条路径竞争触发）。
 *
 * ## 键：内部键是数字，对外标识是 order_no
 *
 * 订单拆成三张表之后，内部键是 `orders.id`（BIGINT UNSIGNED，向子表做外键的就是它），
 * 读模型里它叫 `v_orders.order_id`；对外标识是 `orders.order_no`（CHAR(21)，URL 与通知里用的那个）。
 * 本模块的入参**一律是内部键**，而且是 **number**（不是旧形状里的字符串主键）。传错形状不会静默：
 * `undefined` 会被 mysql2 直接拒绝，`NaN`/`order_no` 这类值会在 `assertInternalOrderIds` 上抛错
 * ——刻意如此。旧实现那套 `String(x)` 会把"传了对外单号"悄悄变成一个永不命中的 `IN (...)`，
 * 于是占位永不回补、而调用方看到的是成功。
 *
 * ## 时间：DATETIME(3)，由服务器盖章
 *
 * `released_at` 写的是 `CURRENT_TIMESTAMP(3)`（会话 time_zone 已在 db.js 钉成 '+00:00'），
 * 不是 `Date.now()`：毫秒整数会被 MySQL 当成数字字面量解析成一个荒谬的时刻，而且**不报错**。
 * 服务器盖章还顺带免疫应用端时钟偏移。
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
 * 原子性说明：写事务由 `withTransaction` 界定作用域（回调即事务）。**2026-10-16 起没有全局写锁了**
 * （见 db.js 文件头）：本模块靠的是**行级**判据——需要"本批到底是哪些行"的地方（releaseCore）用
 * `SELECT … FOR UPDATE` 先锁候选行再改，MySQL 没有 `UPDATE … RETURNING`，锁住的集合就是本轮
 * 的原子凭据；占位本身是带守卫的条件 UPDATE（`committed + qty <= capacity`），
 * 释放靠 `released_at` 的认领（`changes === 1` 才算本批释放的）。
 * 占位失败发生在调用方事务内（回滚后无残留副作用）。
 *
 * ⚠️ 池式商品（码池/NFT 池）的占位**不在本模块**：它们没有 capacity 列可比，占位记在
 * `products.reserved_codes/reserved_tokens` 上（加量见 src/poolQuota.js，减量与"恢复时占回来"
 * 见 db.js 的 TRIGGER_DDL）。所以本模块里 `hold_qty = 0` 的订单分两种：
 * 不限量商品（不占位）与池式商品（占位记在别处）——`restockOrder` 对两者都无需动作，
 * 池式订单的恢复由触发器在状态迁移那一条语句里完成。
 */
import { getDb, withTransaction, abortTx } from './db.js';
import { INCOME_IN, INCOME_STATUS, DRAFT_OR_ACTIVE_IN } from './orderStatus.js';

/**
 * 订单内部键的入参校验（**唯一实现**，见文件头"键"一段）。
 *
 * 为什么必须显式校验、而不是"能转成数字就用"：本模块的每个判定都作用在
 * `WHERE id IN (…)` 上，而 `NaN`/对外单号这类值在 SQL 里是**合法参数**——它们只是永远不命中。
 * 于是"传错键"的表现是"释放成功但什么都没释放"（占位永久滞留、限量 SKU 被钉死），
 * 没有任何错误码。这里直接抛，让调用点在第一次跑就现形。
 */
function assertInternalOrderIds(orderIds) {
  const ids = [...new Set((orderIds || []).map((v) => Number(v)))];
  for (const n of ids) {
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(`stockHold：需要订单内部键（orders.id / v_orders.order_id 的安全整数），收到 ${JSON.stringify(orderIds)}`);
    }
  }
  return ids;
}

/** 占位：该组合销量 +quantity（默认 1），成功返回 true
 *  （committed + qty ≤ capacity 校验失败、或该组合不限量时返回 false——不限量不占位）
 *  skuKey 为 '' 表示无规格商品的唯一组合。 */
export async function holdStock(productId, skuKey = '', quantity = 1) {
  const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const { changes } = await getDb().run('UPDATE product_skus SET committed = committed + ? WHERE product_id = ? AND sku_key = ? AND capacity IS NOT NULL AND committed + ? <= capacity', qty, productId, String(skuKey ?? ''), qty);
  return changes === 1;
}

/**
 * 「还有占位在册」的 SQL 谓词（**唯一拼法**）。
 *
 * 新形状以 `released_qty < hold_qty` 为准（支持多件订单部分退货）；`released_qty = 0 AND
 * released_at IS NOT NULL` 是旧行/夹具的兼容读数：旧实现只有"整单已释放"布尔位，
 * 读到非空即视为整单释放。两条并集之外才是"仍有占位"。
 */
function hasOutstandingHoldSql(alias = 'o') {
  return `(${alias}.hold_qty > 0 AND NOT (${alias}.released_qty >= ${alias}.hold_qty OR (${alias}.released_qty = 0 AND ${alias}.released_at IS NOT NULL)))`;
}

/** 释放内核：把给定「已离开占用态」的本地订单内部键集合中**本次新释放**的件数记账，
 *  并按 (商品, 组合) 聚合回补 committed。
 *
 *  - `quantities` 缺省 = 释放该行剩余全部占位（取消/超时等整单释放）；
 *  - 传入 Map<orderId, qty> 时只释放指定件数（多件订单的部分退货），不会把整单占位清零；
 *  - 幂等：`released_qty` 是唯一账本；已释放完的行不在候选里，重复触发不会二次扣减。
 *  - `released_at` 只在**整单释放完成**时置位，保留"整单释放时刻"的审计读数；
 *    部分释放的行 `released_at` 仍为 NULL，靠 `released_qty < hold_qty` 表达"还有占位"。
 *  状态白名单由各调用方按其业务语义提供——常规释放集为 cancelled/refunded/expired，
 *  D1 例外（货已回卖家侧的成交终局）另行传入 settled/confirmed（见 releaseHoldsForReturnReceived），
 *  防止误把仍占用/成交中的行释放。
 *  刻意**不动 `updated_at`**：释放是账目动作，不是订单状态迁移——`updated_at` 是入账窗口与
 *  列表排序的锚点，把它挪动等于让同一笔成交额在两个窗口里各出现一次。 */
async function releaseCore(orderIds, statuses, quantities = null) {
  const ids = assertInternalOrderIds(orderIds);
  if (!ids.length) return 0;
  const marks = ids.map(() => '?').join(',');
  const statusMarks = (statuses || []).map(() => '?').join(',');
  // 标记（写 released_qty/released_at）与回补（减 committed）同事务：防进程中断造成「已标记未回补」的永久泄漏。
  // 本函数可被调用方已在的分组（cancel/sweeper/watcher/sync）再包一层——嵌套由 withTransaction 降级为 SAVEPOINT。
  return await withTransaction(async () => {
    const db = getDb();
    /*
      先锁候选行，再按锁到的集合记账。MySQL 没有 `UPDATE … RETURNING`，而"本批实际释放了
      哪几件"必须是一个原子事实，不能靠事后回查重建（同一毫秒的两批会互相认领）。
      `FOR UPDATE` 锁住候选行，从 SELECT 到 UPDATE 之间没有写者能插进来。
    */
    const candidates = await db.all(`SELECT id, product_id, sku_key, hold_qty, released_qty
           FROM orders
          WHERE id IN (${marks}) AND status IN (${statusMarks}) AND ${hasOutstandingHoldSql('orders')}
          FOR UPDATE`, ...ids, ...statuses);
    if (!candidates.length) return 0;
    /** (product_id, sku_key) → 本批释放件数 */
    const perSku = new Map();
    let touched = 0;
    for (const row of candidates) {
      const hold = Number(row.hold_qty) || 0;
      const released = Number(row.released_qty) || 0;
      const remaining = Math.max(0, hold - released);
      if (remaining === 0) continue;
      const wantRaw = quantities && quantities.has(Number(row.id)) ? Number(quantities.get(Number(row.id))) : remaining;
      const qty = Math.min(remaining, Number.isFinite(wantRaw) && wantRaw > 0 ? Math.floor(wantRaw) : 0);
      if (qty <= 0) continue;
      const next = released + qty;
      await db.run(
        'UPDATE orders SET released_qty = ?, released_at = IF(?, CURRENT_TIMESTAMP(3), released_at) WHERE id = ?',
        next,
        next >= hold ? 1 : 0,
        row.id
      );
      const key = `${row.product_id}\u0000${row.sku_key ?? ''}`;
      perSku.set(key, (perSku.get(key) || 0) + qty);
      touched += 1;
    }
    if (touched === 0) return 0;
    /*
      ⚠️ `CAST(committed AS SIGNED)` 是**必需**的，不是防御性写法：
      `committed` 是 `INT UNSIGNED`，而无符号数相减在 MySQL 里**结果仍是无符号**——
      "减到负数"会在 `GREATEST` 看到它之前就抛 `BIGINT UNSIGNED value is out of range`，
      整条释放语句随之失败（取消订单 / 交付 / 退款释放全走这条路）。
      也就是说：**本意是夹到 0，实际是抛错**。实测于 192.168.122.11（见 db.js 触发器的同一条说明）。
    */
    for (const [key, qty] of perSku) {
      const [productId, skuKey] = key.split('\u0000');
      await db.run(
        'UPDATE product_skus SET committed = GREATEST(0, CAST(committed AS SIGNED) - ?) WHERE product_id = ? AND sku_key = ?',
        qty,
        productId,
        skuKey
      );
    }
    return touched;
  });
}

/**
 * 「交付行」计数子查询（**唯一拼法**）：`isDelivered` 读的就是它给出的列名 `delivered_items`。
 *
 * 为什么把子查询与列名一起导出：`isDelivered` 需要"这一单有没有交付行"这个事实，
 * 而它由**调用方的 SELECT** 提供（`orders` 表里没有这一列）。旧形状下 watcher 写
 * `… AS items`、opsMetrics 写 `… AS delivered_items`，同一个事实有两个列名，
 * 而 `isDelivered` 里用 `delivered_items || items` 两边都认——那是**两个真相**：
 * 任何一个调用方改名都不会报错，只会让"已交付"静默变成"从未交付"（货物已发出的单被回补占位 ⇒ 超卖）。
 * 现在列名只在这里出现一次，调用方用 `${deliveredItemsSql('o')}` 取列，改一处即全改。
 *
 * @param {string} alias `orders` 表的别名（**不是**读模型 v_orders：视图里没有 orders.id 这个名字）
 */
export function deliveredItemsSql(alias = 'o') {
  return `(SELECT COUNT(*) FROM order_delivery_items d WHERE d.order_id = ${alias}.id) AS delivered_items`;
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
 *
 * ⚠️ 行必须带 `delivered_items` 列（由 {@link deliveredItemsSql} 产出）。缺这一列是**编程错误**
 * 而不是数据状态（`undefined` 在这里会被读成"没有交付行"——正是超卖方向），所以直接抛：
 * 少一列的调用方第一次跑就会现形，而不是在某个买家的订单上静默生效。
 */
export function isDelivered(row) {
  if (!row) return false;
  if (row.delivered_items === undefined) {
    throw new Error(`stockHold.isDelivered：行里没有 delivered_items 列——请用 deliveredItemsSql(别名) 取它（收到：${Object.keys(row).join(',')}）`);
  }
  return !!(
    row.shipped_at ||
    row.tracking_no ||
    Number(row.delivered_items) > 0 ||
    String(row.status || '') === 'shipped'
  );
}

/**
 * 「**这一单的库存承诺还没结清**」的 SQL 谓词（**唯一实现**；2026-10-14 审计新增）。
 *
 * 判据是两个出口的**并集**，两个方向都故意取安全侧：
 *   · `o.status IN (在途集合)` —— 订单生命还没走完（草稿/托管中/已发货/争议中）；
 *   · 或者 `(o.hold_qty > o.released_qty AND 退货未把剩余件数全部收回)` ——
 *     生命走完了但**占位还押着**，且货没回到店主手里。
 *
 * 第二个出口就是本次修的那个洞：**已交付后退款**（`status = 'refunded'`）的单
 * `releaseRefundedEscrow` **刻意不释放**（货在买家手里，需线下回收）。旧的状态白名单
 * `status IN DRAFT_OR_ACTIVE_IN` 看不见它们——于是店主把规格选项名从「红」改成「深红」时，
 * `saveSkus` 按**同 key** 继承 `committed` 继承不到，那一行的已占位数静默归零，
 * 同一件实物可被再卖一次（**超卖**，受害方是下一个买家，且无任何错误码或审计痕迹）。
 *
 * 为什么要并上"在途集合"（而不是只留第二个出口）：在途但**曾释放过占位**的行
 * （`released_qty` 已推进，例如取消后又恢复的单）同样是未结清的承诺，必须继续挡住改名。
 * 方向是安全的：多算 ⇒ 更容易拒绝这次规格变更，而不是把 `committed` 记成偏小（那才会超卖）。
 *
 * 用法：`WHERE ${stockPromiseSql('o')}`。
 * ⚠️ 别名必须落在 **`orders` 表**上（本谓词用 `${alias}.id` 关联 `order_returns.order_id`，
 * 那两侧都是内部键）。读模型 `v_orders` 里内部键叫 `order_id`，拿视图别名进来会直接报
 * "Unknown column"——这是刻意的，见文件头。
 */
export function stockPromiseSql(alias = 'o') {
  return `(${alias}.status IN ${DRAFT_OR_ACTIVE_IN} OR ${hasOutstandingHoldSql(alias)})`;
}

/**
 * 「**还押着占位**」的 SQL 谓词：`released_qty < hold_qty`（旧行 `released_at` 非空也算已释放）。
 *
 * 与 `stockPromiseSql` 的分工：这个回答"占位还在不在册"（释放/回补类判据用它），
 * 那个回答"承诺结清了没有"（规格改名这类**拒绝性**判据用它，取并集更安全）。
 * 两个条件缺一不可，而且**状态列不是判据**：一条订单可以走到任何状态而占位仍在。
 */
export function occupyingSql(alias = 'o') {
  return hasOutstandingHoldSql(alias);
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
 * @param {number[]} orderIds 订单**内部键**（`orders.id` / `v_orders.order_id`），不是 order_no
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
 *
 * @param {string} escrowOrderId 链上托管单号（keccak256 hex）
 */
export async function releaseHoldsForReturnReceived(escrowOrderId) {
  const db = getDb();
  const rows = await db.all(`SELECT o.id, o.hold_qty, o.released_qty, r.id AS return_id, r.quantity AS return_quantity
       FROM orders o
       JOIN order_chain c ON c.order_id = o.id
       JOIN order_returns r ON r.order_id = o.id
       WHERE c.escrow_order_id = ? AND r.received_at IS NOT NULL AND r.released_at IS NULL
         AND o.status IN ${INCOME_IN}
         AND ${hasOutstandingHoldSql('o')}`, String(escrowOrderId || '').toLowerCase());
  let changed = 0;
  for (const r of rows) {
    changed += await releaseReturnedUnits(r.id, Number(r.return_quantity) || 0, r.return_id);
  }
  return changed;
}

/**
 * 退货单**已确认收到**时按该单的件数释放占位（多件订单的部分退货只释放退回的件数）。
 *
 * 这是 `settleReturn` 与两条终局回填路径共用的**唯一**入口：状态白名单覆盖 refunded 与
 * 成交终局（settled/confirmed/expired），具体状态不影响"只释放退货件数"这条判据。
 * `released_qty` 保证重复触发（先收货后终局、或终局先到后收货）只释放一次。
 *
 * @param {number|string} orderId 订单内部键
 * @param {number} quantity 本次确认收到的件数（来自 `order_returns.quantity`）
 */
export async function releaseReturnedUnits(orderId, quantity, returnId = null) {
  const [id] = assertInternalOrderIds([orderId]);
  const qty = Number(quantity);
  if (!Number.isSafeInteger(qty) || qty <= 0) return 0;
  /*
    **一次性认领**：watcher 的终局回填与卖家 receive 动作都会走这里；没有 return 级标记时，
    多件订单会被退一次却回补两次（released_qty 只防"整单重复"，防不了两条路径各释放同一个
    return.quantity）。标记与释放同一事务：释放失败（容量不足）时标记回滚，下次还能重试。
  */
  if (returnId !== null && returnId !== undefined) {
    return await withTransaction(async () => {
      // 已没有可释放的占位（例如另一条路径已整单释放）：不要留下 released_at 假标记
      const state = await getDb().get(
        `SELECT ${hasOutstandingHoldSql('o')} AS outstanding FROM orders o WHERE o.id = ? FOR UPDATE`,
        id
      );
      if (!state || !Number(state.outstanding)) return 0;
      const claimed = await getDb().run(
        'UPDATE order_returns SET released_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND released_at IS NULL AND received_at IS NOT NULL',
        returnId
      );
      if (claimed.changes !== 1) return 0;
      const n = await releaseCore([id], ['refunded', 'settled', 'confirmed', 'expired'], new Map([[id, qty]]));
      if (n === 0) {
        // 容量不足等瞬时原因：回滚认领，下一次（占位腾出后）还能重试；不能把"没释放"写成已释放。
        await getDb().run('UPDATE order_returns SET released_at = NULL WHERE id = ?', returnId);
      }
      return n;
    });
  }
  return releaseCore([id], ['refunded', 'settled', 'confirmed', 'expired'], new Map([[id, qty]]));
}

/**
 * 退款终局（refunded）的占位回补：释放集 = 「从未交付」的行 ∪ 「已交付但退货已确认收到
 * （order_returns.received_at 非空，含卖家放弃追索 waived）」的行。
 * 「已交付事实」= `shipped_at`（发货标记，含自提/线下交付等空物流单号形态）∨ tracking_no ∨
 * 交付行存在——此前仅以 tracking_no/交付行判已交付，空单号发货（自提当面交付）被
 * 误判为从未交付而自动回补，货在买家侧即额度释放 → 超卖；且退货单无法创建（hasDelivered
 * 同漏）。已交付且退货未确认收到 → 不释放（货在买家侧，防同一批实物/资源被再次承诺；等待
 * 卖家 receive/waive 后由动作路径释放——released_at 幂等记账保证只回补一次）。
 * 码/NFT 交付行本身不回池复用（买家可能已用），receive/waive 只解锁限量容量的占位。
 *
 * 链上单号在 `order_chain` 那一行上（1:1，随订单级联删除），所以这里是 JOIN 而不是同表谓词。
 *
 * @param {string} escrowOrderId 链上托管单号（keccak256 hex）
 */
export async function releaseRefundedEscrow(escrowOrderId) {
  const db = getDb();
  const rows = await db.all(`SELECT o.id, o.shipped_at, o.tracking_no, o.hold_qty, o.released_qty, ${deliveredItemsSql('o')},
              (SELECT id FROM order_returns r WHERE r.order_id = o.id) AS return_id,
              (SELECT received_at FROM order_returns r WHERE r.order_id = o.id) AS return_received_at,
              (SELECT released_at FROM order_returns r WHERE r.order_id = o.id) AS return_released_at,
              (SELECT quantity FROM order_returns r WHERE r.order_id = o.id) AS return_quantity
       FROM orders o
       JOIN order_chain c ON c.order_id = o.id
       WHERE c.escrow_order_id = ? AND o.status = 'refunded'`, String(escrowOrderId || '').toLowerCase());
  const undelivered = [];
  let changed = 0;
  for (const r of rows) {
    if (!isDelivered(r)) {
      // 从未交付：整单退款，释放该行**剩余**占位（缺省 amount = 剩余全部）
      undelivered.push(r.id);
      continue;
    }
    // 已交付：只有退货已确认收到且该退货单的件数尚未释放过，才释放；只释放退货覆盖的件数
    if (r.return_received_at != null && r.return_released_at == null) {
      changed += await releaseReturnedUnits(r.id, Number(r.return_quantity) || 0, r.return_id);
    }
  }
  if (undelivered.length) changed += await releaseCore(undelivered, ['refunded'], null);
  return changed;
}

/**
 * 恢复占位（sync/watcher 将 cancelled 恢复为 escrowed 前调用）：
 *  - 从未占位（hold_qty=0）且当前组合仍不限量（含池式商品）→ 无需恢复，成功；
 *  - 从未占位、但组合在取消后被改为限量 → **按当前容量补占位**（不补就是 committed 少记 ⇒ 超卖）；
 *  - 商品/SKU 已不存在 → 不能把"没有库存行"当成功（那会让调用方静默放过一次无法履行的付款）；
 *  - 商品仍限量 → 条件占位 hold_qty 件，容量不足（取消期间被卖完）返回 false，由调用方告警。
 * 恢复成功后清空 released_at（该行回到占用态，将来可再次正常释放）；从未占位的行没有
 * released_at 可清，靠 `hold_qty = 0 → quantity` 的条件更新做原子认领。
 *
 * @param {number} orderId 订单**内部键**（`orders.id` / `v_orders.order_id`）
 */
export async function restockOrder(orderId) {
  const [id] = assertInternalOrderIds([orderId]);
  // 三处读（订单行、组合容量）都必须在**事务内**：它们是后面判据与占位所依据的读数，
  // 事务外读到的是别人也能改的快照（取消期与恢复期并发的两条路径都会走这里）。
  return await withTransaction(async () => {
    const db = getDb();
    // FOR UPDATE：同一单的两个恢复入口（watcher / sync / 对账）必须串行，否则 hold_qty=0 的
    // 补占位会各加一次 committed（幻影占额，和漏占一样是账目错误）。
    const row = await db.get(
      'SELECT id, product_id, sku_key, quantity, hold_qty, released_qty, released_at FROM orders WHERE id = ? FOR UPDATE',
      id
    );
    if (!row || row.product_id == null) return false; // 商品已删：没有可占的库存行，由调用方告警
    const hold = Number(row.hold_qty) || 0;
    let released = Number(row.released_qty) || 0;
    /*
      旧行/夹具只有 `released_at` 布尔位（released_qty 仍为 0）：读到非空即视为整单已释放。
      新行部分退货时 `released_at` 仍为 NULL，只有 `released_qty` 表达已退件数。
    */
    if (released === 0 && row.released_at != null) released = hold;
    if (hold > 0 && released === 0) return true; // 一件都没释放：本来就在占用态，无需恢复
    const skuKey = String(row.sku_key ?? '');
    const p = await db.get('SELECT capacity FROM product_skus WHERE product_id = ? AND sku_key = ?', row.product_id, skuKey);
    if (!p) return false; // 组合已不存在：不能静默当成“没库存可占”
    if (hold <= 0) {
      /*
        从未占位（下单时该组合不限量）→ 取消/恢复期间卖家把它改成了限量。
        此刻必须按**当前**容量补占位；否则 committed 少记，后续同组合还能再卖，形成超卖。
        池式商品（码/NFT）的 capacity 恒 NULL，走下面的“不限量”分支，不在这里占。
      */
      if (p.capacity === null) return true;
      const qty = Number(row.quantity) || 0;
      if (qty <= 0) return false;
      const held = await db.run(
        'UPDATE product_skus SET committed = committed + ? WHERE product_id = ? AND sku_key = ? AND capacity IS NOT NULL AND committed + ? <= capacity',
        qty, row.product_id, skuKey, qty
      );
      if (held.changes !== 1) return abortTx(false);
      const marked = await db.run(
        'UPDATE orders SET hold_qty = ?, released_qty = 0, released_at = NULL WHERE id = ? AND hold_qty = 0',
        qty,
        row.id
      );
      if (marked.changes !== 1) return abortTx(false);
      return true;
    }
    if (p.capacity === null) {
      // 该组合已改为不限量：旧占位作废，标记该行无需再恢复（仍保持 released 语义）
      await db.run('UPDATE orders SET hold_qty = 0, released_qty = 0, released_at = NULL WHERE id = ?', row.id);
      return true;
    }
    /*
      恢复 = **认领（把已释放件数清零）+ 按已释放件数重新占位**，同一事务。
        · 认领在前：`released_qty` 是本次恢复的原子凭据，两个并发恢复（watcher 托管事件与
          sync 兜底各来一次）里只有一个能成功，绝不会各自 `committed + released` 一次；
        · 只补**已释放的件数**：部分退货后行里仍有剩余占位，重复按整单 hold 补会多占。
      容量不足（取消期间被卖完）时 abortTx 把认领一并回滚，该行保持原状，由调用方告警。
    */
    const claimed = await db.run(
      `UPDATE orders SET released_qty = 0, released_at = NULL
        WHERE id = ? AND (released_qty = ? OR (released_qty = 0 AND released_at IS NOT NULL))`,
      row.id,
      released
    );
    if (claimed.changes !== 1) return abortTx(false);
    if (released > 0 && !(await holdStock(row.product_id, skuKey, released))) return abortTx(false);
    return true;
  });
}
