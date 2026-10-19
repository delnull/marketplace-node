/**
 * 确认收货后的**售后案件**（契约 2026-10 第二批）——本地镜像的**唯一判据层**。
 *
 * 链上语义（事实源 `contracts/src/Escrow.sol`，只读参考）：
 *  - 买家在**订单终局（链上 Settled = 钱全额判给卖家）之后**、窗口内（开案窗口取该单**结算时的快照**，
 *    自 `settledAtBlock` 起算，生产默认 180 天、上限 360 天）调 `openAfterSale(orderId)` 开案；
 *    入口形状（2026-10-13 收紧）：`status == Settled && buyerConfirmed && refundedAmount == 0`
 *    —— 执行过部分退款/仲裁拆分的单不再能开案（那是"谈拢的和解"，不是"收货后新发现的问题"）；
 *  - 只有买家能开案，且每个单同时只能有一个在途案件（`afterSaleOpenedAtBlock != 0` ⇒ 再开 revert
 *    `AfterSaleAlreadyOpen`）；**结案是终态**（`afterSaleClosedAtBlock` 不可清除，再开 revert
 *    `AfterSaleCaseClosed`），所以本地 `closed` 不能被任何事件/回填改回 `open`；
 *  - 买家撤诉走 `closeAfterSale(orderId, note)`；仲裁人结案走委员会票决 `voteAfterSale(orderId, 0)`，
 *    票决事件不带文本（`note` 只存在于买家撤诉事件里）；
 *  - 它**不动托管资金**（那笔钱早已结清），补偿只能来自卖家保证金 `Staking.penalize` 或卖家线下转账；
 *    也因此**不阻塞卖家出金**（出金下限只读 `Escrow.sellerOpenExposure` = 退款待决 + 争议中的
 *    Σ amount，售后案件不计入）。
 *
 * ## 案件的列住在 `order_chain` 那一行（链上镜像表，watcher 独占写）
 *
 * 这一批列是从"订单行"搬到链上镜像表的：它们记的是**链上发生过什么**（开案时刻/开案区块/结案说明），
 * 与订单事实（金额、状态、履约）分属两张表。于是本模块的**所有写入只落在 `order_chain`**，
 * 按 `escrow_order_id`（该表上唯一）定位——连带把下面那条纪律变成了**形状上的保证**：
 *
 * ⚠️ 为什么**不改 `orders.status`**（本仓纪律，改这一行之前先读这段）：
 * 链上 `Escrow.Order.status` 在售后案件全程都停在 `Settled` —— 案件是**叠加在终局之上的第二层**。
 * 本地 `orders.status` 是"这笔钱现在到哪一步"的口径，它同时喂着收款流水/看板 GMV 窗口
 * （`INCOME_STATUS`）、库存占位释放（`stockHold`）、发货与退款闸、（`/api/arbitration/pending` 的）
 * 争议队列。把有案件的单改写成 `disputed` 就等于把一笔**已经结清**的钱重新拉回在途：
 * 金额会在两个窗口里各记一次、占位/流水/徽标全部跟着错位，而且链上根本没有对应的 `DisputeRequested`
 * 事件可以自证。所以售后案件只写本模块管的这几列，`orders.status` 一个字节都不动——
 * 同理也**不碰 `orders.updated_at`**（它是入账窗口与列表排序的锚点）。旧形状下这两条靠纪律，
 * 现在靠表：`orders` 那张表里根本没有 after_sale_* 这些列，写错表在 SQL 层当场报错。
 *
 * ## 时间由服务器盖章
 *
 * `after_sale_opened_at` / `after_sale_closed_at` 写 `CURRENT_TIMESTAMP(3)`（会话 time_zone 已在
 * db.js 钉成 '+00:00'）。旧签名里的 `at` 参数已删：它让三个调用方各带一个自己的时钟进来，
 * 而这三个时刻**没有任何一个**需要应用端参与——它们是"节点记下这一刻"，
 * 服务器盖章还顺带免疫应用端时钟偏移（写毫秒整数更糟：MySQL 会把它当数字字面量解析成荒谬的时刻，
 * 且不报错）。
 *
 * 三条路径必须同源（本模块就是那个"源"）：
 *  1. 事件路径：`escrowWatcher` 的 `AfterSaleOpened` / `AfterSaleClosed` 分支；
 *  2. 人工同步：`POST /api/orders/:id/sync` 读链上 `afterSaleOpen` / `afterSaleOpenedAtBlock` 回填；
 *  3. 后台对账：`chainReconcile` 的售后案件复查（在途案件复核 + 终局单窗口内扫描）。
 * 三者共用本模块的写入口，任何"该不该算在途""该怎么落列"的判断都不许在调用点重写。
 */
import { getDb } from './db.js';

/**
 * 列的取值域（与 `db.js` 建表语句里 `after_sale_status ENUM('none','open','closed')` **逐字同源**）：
 *  - `none`   从未开过案；
 *  - `open`   有在途案件（售后陈述受理、退货单窗口、仲裁队列、保留期保护都看它）；
 *  - `closed` 已结案（**终态**：合约 `afterSaleClosedAtBlock` 不可清除，买家不能重开；罚没路径随之关闭）。
 */
export const AFTER_SALE_STATUS = Object.freeze(['none', 'open', 'closed']);

/**
 * 后台对账扫描"漏扫了 AfterSaleOpened"的**候选面**（不是"这些状态一定有案件"）。
 *
 * 链上开案判据（`Escrow.openAfterSale`，2026-10-13 收紧）：
 *   `status == Settled && buyerConfirmed && refundedAmount == 0 && settledAtBlock != 0`。
 * 本地与之对应的：
 *   · `confirmed` —— 买家确认收货事件的镜像（结算时 buyerConfirmed=true、无退款），正常载体；
 *   · `settled`   —— 事件漏扫、经 `/sync` 落 settled 的单，链上仍可能 buyerConfirmed=true 且无退款；
 *   · `expired`   —— `releaseExpired` 的单链上 **buyerConfirmed=false**，实际**不可能**有案件。
 * 把 expired 留在候选面是刻意的**扫描超集**：最终由链上 `afterSaleOpen` 回答（读不到就跳过），
 * 本地状态只决定"要读谁"，不决定"有没有案件"——少扫一类会让漏扫事件永久无补救。
 * `refunded`（全额退回买家）与部分退款/仲裁判付的 `settled` 同样被链上
 * `buyerConfirmed/refundedAmount` 挡掉，但本地无法只凭状态区分，故统一交给链上读数。
 */
export const AFTER_SALE_ELIGIBLE_STATUS = Object.freeze(['confirmed', 'settled', 'expired']);

/**
 * SQL 判据片段（**唯一拼法**）：列名与状态值只在这里出现一次，避免各调用点各写一份字符串
 * （本仓反复踩过的"同一判据抄多份、改一处漏一处全都不报错"）。
 * 两个方向都给：`AFTER_SALE_OPEN_SQL`（在途，用于队列/徽标/门控）
 * 与 `AFTER_SALE_NOT_OPEN_SQL`（无在途，用于"漏扫开案"扫描与保留期让路的候选面）。
 *
 * ⚠️ 两个片段用的是**不加表别名的列名**，所以用到它们的查询必须把 `order_chain` 接进来
 * （售后案件的列在这一张表里）。没接进来会直接报 `Unknown column 'after_sale_status'`——
 * 响亮地失败，不会静默算成"没有案件"。
 *
 * ⚠️ **`NOT_OPEN` 必须显式带上 `IS NULL`**：整单读走的是 `LEFT JOIN order_chain`
 * （没有链上镜像行的订单那一侧全是 NULL），而 `NULL <> 'open'` 在 SQL 里是 NULL——既不真也不假。
 * 漏掉这一支的后果是**静默漏掉一整类候选单**（"从未有过链上单/镜像行缺失"的单永远不进候选面），
 * 与 piiErase 里 `NOT (pc.order_id <=> di.order_id)` 那一课同源。
 *
 * ⚠️ 不要把在途判据拼成 `… = 0` 之类的**数字比较**：MySQL 把 ENUM 与数字比较解读成**枚举下标**
 * （0 不落在 1..3 里）⇒ 那条谓词静默地匹配 0 行。要比就比字符串。
 */
export const AFTER_SALE_OPEN_SQL = "after_sale_status = 'open'";
export const AFTER_SALE_NOT_OPEN_SQL = "(after_sale_status IS NULL OR after_sale_status <> 'open')";

/**
 * 结案说明（链上 `AfterSaleClosed` 的 `note`）的长度上限 —— 与 `order_chain.after_sale_note`
 * 的 `VARCHAR(500)` **同宽**（改一处必须同批改另一处：严格模式下写超长值会让整条语句以 1406 失败，
 * 一个用户填的说明不该让整次状态回填失败）。
 * 为什么必须有上限：它是**用户填的、随事件永久落在订单行上的文本**——不截断就是一个由陌生人
 * 控制长度的字段进了本地库与所有列表响应（存储放大 + 面板渲染成本）。截断写在**唯一写入口**，
 * 而不是让每个读取方各截一次（那样必然有人忘）。
 *
 * ⚠ XSS 面：本模块只把它作为 JSON 字段下发（`orderToPublic` / 仲裁列表），**绝不做 HTML 拼接、
 * 也不做半吊子转义**——渲染端必须按纯文本输出（前端不在本次改动范围，见交付说明的残余项）。
 */
export const AFTER_SALE_NOTE_MAX = 500;

/** 该订单此刻是否有在途售后案件（JS 侧判据；SQL 侧用 AFTER_SALE_OPEN_SQL） */
export function isAfterSaleOpen(order) {
  return String(order?.after_sale_status || 'none') === 'open';
}

/** 结案说明归一：非字符串/空 → null；超长截断（见 AFTER_SALE_NOTE_MAX 的说明） */
function normalizeNote(note) {
  if (note === undefined || note === null) return null;
  const s = String(note);
  if (!s) return null;
  return s.length > AFTER_SALE_NOTE_MAX ? s.slice(0, AFTER_SALE_NOTE_MAX) : s;
}

/**
 * 开案落库（**唯一写入口**，事件路径与链上真值回填共用）。
 *
 * 语义：
 *  - `open` + 开案时刻/区块；清掉上一次结案的痕迹（正常路径下这两列本应为 NULL）；
 *  - **已结案的行不能被开案覆盖**：链上 `afterSaleClosedAtBlock` 是终态，重开案在合约层
 *    直接 `AfterSaleCaseClosed`；节点若允许 `closed → open`，就会显示一个链上不存在的"在途案件"，
 *    并让罚没门槛在本地看起来复活。WHERE 里的 `after_sale_status <> 'closed'` 是这条终态的落点；
 *  - 幂等：已是 `open` **且开案区块相同**时 changes=0（重复扫描/重组回放不重复记账、不重复写事件史）；
 *    "开案区块不同"要更新（事件/对账两条路径纠正陈旧区块号——判据是 **NULL 安全不等**
 *    `NOT (after_sale_opened_block <=> ?)`：`NULL != 100` 在 SQL 里是 NULL，写成 `!=`/`<>`
 *    会把"区块未知 → 补上区块"这条路径整个吞掉）；
 *  - 本地无此单（orderId 未知/本地已删）⇒ 0 行，与其它事件分支同口径（不猜、不建行）。
 *
 * @param {string} orderIdHex 链上托管单号
 * @param {{block?: number|null}} opts block = 链上开案区块（拿不到时留 null）
 * @returns {Promise<number>} 受影响行数
 */
export async function applyAfterSaleOpened(orderIdHex, { block = null } = {}) {
  /*
    开案区块只在**能安全表示**时才落库（`Number.isSafeInteger`）：
    这一列是 BIGINT，而 mysql2 在 `supportBigNumbers: true, bigNumberStrings: false` 下
    （见 db.js 的 baseConnectionOptions）把超过 2^53 的整数**转成字符串**返回——不再像
    node:sqlite 那样抛 RangeError。于是脏值不会当场现形，而是变成"这一列有时是数字、有时是字符串"，
    跟着 `SELECT *` 流进订单详情、对账与导出（`Number(...)` 一算就静默失真）。
    非法值只可能来自 ABI 解码错位/脏事件（真实区块号远小于 2^53），所以这里如实落 null
    （"区块未知"），而不是把一个读不回来的数字塞进库里。
  */
  const n = Number(block);
  const blockValue = Number.isSafeInteger(n) && n > 0 ? n : null;
  return (await getDb().run(`UPDATE order_chain
          SET after_sale_status = 'open',
              after_sale_opened_at = CURRENT_TIMESTAMP(3),
              after_sale_opened_block = ?,
              after_sale_closed_at = NULL,
              after_sale_note = NULL
        WHERE escrow_order_id = ? AND after_sale_status <> 'closed'
          AND (after_sale_status <> 'open' OR NOT (after_sale_opened_block <=> ?))`, blockValue, String(orderIdHex).toLowerCase(), blockValue)).changes;
}

/**
 * 结案落库（**唯一写入口**）。
 *
 * 与开案不对称的两点，都是刻意的：
 *  - 幂等守卫用 `after_sale_status <> 'closed'`（而不是 `= 'open'`）：**本地漏扫了开案事件**时，
 *    结案事件仍应把"曾开过案 + 结案说明"记下来（否则本地永远停在 `none`，一条真实的结案事实
 *    连同用户填的说明一起丢掉）；反过来，重复投递的同一条结案事件不会覆盖已有的说明与时刻。
 *  - 本地无此单 ⇒ 0 行（同其它分支）。
 *
 * 同样**不动 `orders.status` 与 `orders.updated_at`**（写入只落在 `order_chain`）。
 *
 * @param {string} orderIdHex 链上托管单号
 * @param {{note?: string|null}} opts note = 链上事件里的结案说明（截断见 AFTER_SALE_NOTE_MAX）
 * @returns {Promise<number>} 受影响行数
 */
export async function applyAfterSaleClosed(orderIdHex, { note = null } = {}) {
  return (await getDb().run(`UPDATE order_chain
          SET after_sale_status = 'closed',
              after_sale_closed_at = CURRENT_TIMESTAMP(3),
              after_sale_note = ?
        WHERE escrow_order_id = ? AND after_sale_status <> 'closed'`, normalizeNote(note), String(orderIdHex).toLowerCase())).changes;
}

/**
 * 按**链上真值**回填售后案件状态（`/sync` 与后台对账共用的那一个函数）。
 *
 * 链上只有两个读数可用：`afterSaleOpen(orderId)`（bool）与 `afterSaleOpenedAtBlock(orderId)`
 * （uint64，0 = 无在途案件/已结案）。**没有** note——结案说明只存在于 `AfterSaleClosed` 事件里，
 * 所以这条路径关案时 `after_sale_note` 保持 null（如实：节点没拿到说明，不编造），
 * 事件到达时（watcher）才会补上说明与真实时刻。这是本路径已知的信息损失，写在这里免得被当成 bug。
 *
 * **关案方向只对"本地正 open"的行生效**（`open=false` 与本地 `none` 的组合什么都不做）：
 * 一次链上快照分不清"从未开过案"与"开过又结了"（两者都是 afterSaleOpenedAtBlock == 0），
 * 若照写 `closed`，就等于给**每一张普通终局单**盖一条"曾开案、某时刻结案"的假历史
 * （closed_at 有了、note 没有、案件从未存在）——这正是本仓明令禁止的"编造事实"。
 * 代价：漏扫了开案事件、又漏扫了结案事件的行会停在 `none`（事件路径仍会补上带说明的 `closed`）；
 * 宁可少记一条历史，也不造假一条。
 *
 * @param {string} orderIdHex 链上托管单号
 * @param {{open: boolean, openedAtBlock?: number|null}} truth 链上真值
 * @returns {Promise<{changed: number, to: 'open'|'closed'|null}>} to = 实际落成的状态（未变时为 null）
 */
export async function applyAfterSaleFromChain(orderIdHex, { open, openedAtBlock = null } = {}) {
  const id = String(orderIdHex).toLowerCase();
  if (open) {
    const changed = await applyAfterSaleOpened(id, { block: openedAtBlock });
    return { changed, to: changed > 0 ? 'open' : null };
  }
  const local = await getDb().get('SELECT after_sale_status FROM order_chain WHERE escrow_order_id = ?', id);
  if (!local || String(local.after_sale_status) !== 'open') return { changed: 0, to: null };
  const changed = await applyAfterSaleClosed(id, { note: null });
  return { changed, to: changed > 0 ? 'closed' : null };
}

/**
 * DTO 字段（**唯一出处**：订单详情与仲裁队列两条下发路径共用）。
 *
 * `afterSaleNote` 是用户文本 → 只在 JSON 里下发、由前端按纯文本渲染（见 AFTER_SALE_NOTE_MAX）。
 * `afterSaleOpenedBlock` 一并给出：仲裁人/运维能拿它去链上核对（区块号是公开可查的事实），
 * 而 `afterSaleOpenedAt` 是**节点落库时刻**（近似开案时刻，与事件史里的 `at` 同口径）——
 * 三列都是 `Date`（JSON 里给出 ISO-8601）或 null。
 */
export function afterSaleFieldsOf(order) {
  const status = String(order?.after_sale_status || 'none');
  return {
    afterSaleStatus: status,
    afterSaleOpenedAt: order?.after_sale_opened_at || null,
    afterSaleOpenedBlock: order?.after_sale_opened_block || null,
    afterSaleClosedAt: order?.after_sale_closed_at || null,
    afterSaleNote: order?.after_sale_note ?? null,
  };
}

/** 售后案件是否存在（含已结案）——用于面板区分"从未开案"与"开过案已结案" */
export function hasAfterSaleHistory(order) {
  return String(order?.after_sale_status || 'none') !== 'none';
}
