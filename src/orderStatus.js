/**
 * 订单状态集合的**唯一出处**（源码评审 2026-09）。
 *
 * 为什么要有这个模块：`orders.status` 的权威定义在 `db.js` 的建表 CHECK 里，但**用**到这个枚举的地方
 * 散在十几个文件：有的写内联字面量（`status IN ('escrowed','shipped','disputed')`）、有的写模板常量
 * （`escrowWatcher.js` 的 `FROM_SET`）、有的导出了自己的数组（`INCOME_STATUS` / `REVIEWABLE_STATUS` /
 * `EVIDENCE_OPEN_STATUS` / `PII_ERASABLE_STATUS`）。同一套语义的集合被抄了多份，改一处漏一处**全是静默的**：
 *   · 状态名拼错 ⇒ 那条 SQL 永远匹配 0 行（事件照扫、状态照旧、不报错）；
 *   · 新增状态漏进某个集合 ⇒ 某些单永远迁移不到。
 * 现在集合在这里命名一次，业务代码引用常量；`test/status-set-consistency.test.js` 负责确认
 * "每个集合都 ⊆ db.js 的 CHECK 约束"，并继续拦住残留在 SQL 里的字面量拼写错误。
 *
 * 纪律：本模块**只放集合与拼 SQL 的小工具**，不放任何业务判断——判断留在各自的唯一实现里。
 */

/** 与 `db.js` 建表语句里 `CHECK (status IN …)` **逐字同源**的权威顺序 */
export const ORDER_STATUS = Object.freeze([
  'draft',
  'escrowed',
  'shipped',
  'confirmed',
  'disputed',
  'settled',
  'refunded',
  'expired',
  'cancelled',
]);

/** 在途（资金已上链且未终局）：卖家要发货、买家可确认/退款/争议 */
export const ACTIVE_STATUS = Object.freeze(['escrowed', 'shipped', 'disputed']);

/** 已付款但在途（含卖家尚未发货）——`/paid` 与 watcher 回写允许的来源集 */
export const PRE_PAID_STATUS = Object.freeze(['draft', 'escrowed', 'shipped']);

/** 草稿 + 在途：商品维度的"在途需求"核算、库存占位计数用 */
export const DRAFT_OR_ACTIVE_STATUS = Object.freeze(['draft', 'escrowed', 'shipped', 'disputed']);

/** 入账口径（钱已到卖家手里）：看板 GMV / 流水 / 趋势 / CSV 的钱流窗口 */
export const INCOME_STATUS = Object.freeze(['confirmed', 'settled', 'expired']);

/** 可擦除个人信息的状态（资金流已终结）；与 PII_PROTECTED_STATUS 互斥且并集 = ORDER_STATUS */
export const PII_ERASABLE_STATUS = Object.freeze(['confirmed', 'settled', 'refunded', 'expired', 'cancelled']);

/** 禁止擦除的状态（在途，卖家要按地址发货） */
export const PII_PROTECTED_STATUS = Object.freeze(['draft', 'escrowed', 'shipped', 'disputed']);

/**
 * 集合 → SQL 的 `IN (...)` 片段（**唯一拼法**）。
 * 只在**常量集合**上用：任何用户输入都不得进这里（全仓 SQL 一律参数化，见 http.js/routes 的纪律）。
 */
export function sqlIn(statuses) {
  return `(${statuses.map((s) => `'${s}'`).join(',')})`;
}

/** 上列集合的 SQL `IN (...)` 片段（拼法唯一；只在常量集合上用） */
export const ACTIVE_IN = sqlIn(ACTIVE_STATUS);
export const PRE_PAID_IN = sqlIn(PRE_PAID_STATUS);
export const DRAFT_OR_ACTIVE_IN = sqlIn(DRAFT_OR_ACTIVE_STATUS);
export const INCOME_IN = sqlIn(INCOME_STATUS);