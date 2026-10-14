/**
 * 确认收货后的**售后案件**（契约 2026-10 第二批）——本地镜像的**唯一判据层**。
 *
 * 链上语义（事实源 `contracts/src/Escrow.sol`，只读参考）：
 *  - 买家在**订单终局（链上 Settled = 钱全额判给卖家）之后**、窗口内（开案窗口取该单**结算时的快照**，
 *    自 `settledAtBlock` 起算，生产默认 180 天、上限 360 天）调 `openAfterSale(orderId)` 开案；
 *    入口形状（2026-10-13 收紧）：`status == Settled && buyerConfirmed && refundedAmount == 0`
 *    —— 执行过部分退款/仲裁拆分的单不再能开案（那是"谈拢的和解"，不是"收货后新发现的问题"）；
 *  - 只有买家能开案，且每个单同时只能有一个在途案件（`afterSaleOpenedAtBlock != 0` ⇒ 再开 revert
 *    `AfterSaleAlreadyOpen`）；结案会**清空**该槽位 ⇒ 窗口内买家可以再次开案（open→closed→open）；
 *  - `closeAfterSale(orderId, note)` 由买家撤诉或仲裁人结案，`note` 是**用户填的文本**；
 *  - 它**不动托管资金**（那笔钱早已结清），补偿只能来自卖家保证金 `Staking.penalize` 或卖家线下转账；
 *    也因此**不阻塞卖家出金**（出金下限只读 `Escrow.sellerOpenExposure` = 退款待决 + 争议中的
 *    Σ amount，售后案件不计入）。
 *
 * ⚠️ 为什么**不改 `orders.status`**（本仓纪律，改这一行之前先读这段）：
 * 链上 `Escrow.Order.status` 在售后案件全程都停在 `Settled` —— 案件是**叠加在终局之上的第二层**。
 * 本地 `orders.status` 是"这笔钱现在到哪一步"的口径，它同时喂着收款流水/看板 GMV 窗口
 * （`INCOME_STATUS`）、库存占位释放（`stockHold`）、发货与退款闸、（`/api/arbitration/pending` 的）
 * 争议队列。把有案件的单改写成 `disputed` 就等于把一笔**已经结清**的钱重新拉回在途：
 * 金额会在两个窗口里各记一次、占位/流水/徽标全部跟着错位，而且链上根本没有对应的 `DisputeRequested`
 * 事件可以自证。所以售后案件只写本模块管的这几列，`orders.status` 一个字节都不动。
 *
 * 三条路径必须同源（本模块就是那个"源"）：
 *  1. 事件路径：`escrowWatcher` 的 `AfterSaleOpened` / `AfterSaleClosed` 分支；
 *  2. 人工同步：`POST /api/orders/:id/sync` 读链上 `afterSaleOpen` / `afterSaleOpenedAtBlock` 回填；
 *  3. 后台对账：`chainReconcile` 的售后案件复查（在途案件复核 + 终局单窗口内扫描）。
 * 三者共用本模块的写入口，任何"该不该算在途""该怎么落列"的判断都不许在调用点重写。
 */
import { getDb } from './db.js';

/**
 * 列的取值域（与 `db.js` 建表语句里的 `CHECK (after_sale_status IN …)` **逐字同源**）：
 *  - `none`   从未开过案；
 *  - `open`   有在途案件（售后陈述受理、退货单窗口、仲裁队列、保留期保护都看它）；
 *  - `closed` 已结案（同窗口内买家仍可重开新案 → 回到 `open`）。
 */
export const AFTER_SALE_STATUS = Object.freeze(['none', 'open', 'closed']);

/**
 * 链上**可能**存在售后案件的本地终局状态：契约要求 `status == Settled && refundedAmount < amount`
 * 且 `settledAtBlock != 0`。本地与之对应的三种终局：
 *  - `confirmed`（买家确认收货 → 链上 Settled，refundedAmount=0）、
 *  - `settled`  （仲裁判卖家 / 双方谈拢的部分退款 / 争议中撤诉放款 → 链上 Settled）、
 *  - `expired`  （超时释放 → 链上也是 Settled 且钱判给卖家，settledAtBlock 有值）。
 * `refunded`（全额退回买家）**永不**可能有售后案件——契约会 revert `NotSettledForAfterSale`。
 * 用途只有一个：后台对账扫描"漏扫了 AfterSaleOpened"的候选面（见 chainReconcile）。
 */
export const AFTER_SALE_ELIGIBLE_STATUS = Object.freeze(['confirmed', 'settled', 'expired']);

/**
 * SQL 判据片段（**唯一拼法**）：列名与状态值只在这里出现一次，避免各调用点各写一份字符串
 * （本仓反复踩过的"同一判据抄多份、改一处漏一处全都不报错"）。
 * 两个方向都给：`AFTER_SALE_OPEN_SQL`（在途，用于队列/徽标/门控）
 * 与 `AFTER_SALE_NOT_OPEN_SQL`（无在途，用于"漏扫开案"扫描与保留期让路的候选面）。
 * ⚠️ 不要把前者拼成 `… = 0`：SQLite 里 `after_sale_status = 'open' = 0` 虽能算出想要的结果
 * （布尔按 0/1 参与比较），但那是靠引擎语义巧合成立的写法，换引擎就错，读的人也看不懂。
 */
export const AFTER_SALE_OPEN_SQL = "after_sale_status = 'open'";
export const AFTER_SALE_NOT_OPEN_SQL = "after_sale_status != 'open'";

/**
 * 结案说明（链上 `AfterSaleClosed` 的 `note`）的长度上限。
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
 *  - `open` + 开案时刻/区块；**同时清掉上一次结案的痕迹**（closed_at/note）——链上重开案是一个
 *    全新案件（槽位被清空过），把上一条结案说明留在行上会让面板显示"在途案件，结案说明=上次撤诉"；
 *  - 重开案会覆盖 `after_sale_opened_block`（"最久等待"必须按**本次**开案算）；
 *  - **不动 `orders.status`、不动 `updated_at`**（见文件头：它不改变资金/入账口径；`updated_at` 是
 *    入账窗口与列表排序的锚点，一个售后事件把行挪进更晚的窗口就等于让成交额在两个窗口各出现一次）；
 *  - 幂等：已是 `open` **且开案区块相同**时 changes=0（重复扫描/重组回放不重复记账、不重复写事件史）；
 *    "开案区块不同"要更新（链上重开案会换一个区块；事件/对账两条路径都据此把陈旧的区块号纠正过来
 *    ——`IS NOT` 而非 `!=`：SQLite 里 `NULL != 100` 是 NULL，会把"区块未知 → 补上区块"这条路径吞掉）；
 *  - 本地无此单（orderId 未知/本地已删）⇒ 0 行，与其它事件分支同口径（不猜、不建行）。
 *
 * @param {string} orderIdHex 链上托管单号
 * @param {{block?: number|null, at?: number}} opts block = 链上开案区块（拿不到时留 null）
 * @returns {number} 受影响行数
 */
export function applyAfterSaleOpened(orderIdHex, { block = null, at = Date.now() } = {}) {
  /*
    开案区块只在**能安全表示**时才落库（`Number.isSafeInteger`）：
    这一列是 INTEGER，而 node:sqlite 默认把整数读成 JS number——一旦写进 > 2^53 的值，
    此后任何 `SELECT *`（订单详情、对账、导出都这么读）都会当场抛
    `Value is too large to be represented as a JavaScript number`，等于把整张单的读路径打死。
    非法值只可能来自 ABI 解码错位/脏事件（真实区块号远小于 2^53），所以这里如实落 null
    （"区块未知"），而不是把一个读不回来的数字塞进库里。
  */
  const n = Number(block);
  const blockValue = Number.isSafeInteger(n) && n > 0 ? n : null;
  return getDb()
    .prepare(
      `UPDATE orders
          SET after_sale_status = 'open',
              after_sale_opened_at = ?,
              after_sale_opened_block = ?,
              after_sale_closed_at = NULL,
              after_sale_note = NULL
        WHERE escrow_order_id = ? AND (after_sale_status != 'open' OR after_sale_opened_block IS NOT ?)`
    )
    .run(at, blockValue, String(orderIdHex).toLowerCase(), blockValue).changes;
}

/**
 * 结案落库（**唯一写入口**）。
 *
 * 与开案不对称的两点，都是刻意的：
 *  - 幂等守卫用 `after_sale_status != 'closed'`（而不是 `= 'open'`）：**本地漏扫了开案事件**时，
 *    结案事件仍应把"曾开过案 + 结案说明"记下来（否则本地永远停在 `none`，一条真实的结案事实
 *    连同用户填的说明一起丢掉）；反过来，重复投递的同一条结案事件不会覆盖已有的说明与时刻。
 *  - 本地无此单 ⇒ 0 行（同其它分支）。
 *
 * 同样**不动 `orders.status` 与 `updated_at`**。
 *
 * @param {string} orderIdHex 链上托管单号
 * @param {{note?: string|null, at?: number}} opts note = 链上事件里的结案说明（截断见 AFTER_SALE_NOTE_MAX）
 * @returns {number} 受影响行数
 */
export function applyAfterSaleClosed(orderIdHex, { note = null, at = Date.now() } = {}) {
  return getDb()
    .prepare(
      `UPDATE orders
          SET after_sale_status = 'closed',
              after_sale_closed_at = ?,
              after_sale_note = ?
        WHERE escrow_order_id = ? AND after_sale_status != 'closed'`
    )
    .run(at, normalizeNote(note), String(orderIdHex).toLowerCase()).changes;
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
 * @param {{open: boolean, openedAtBlock?: number|null, at?: number}} truth 链上真值
 * @returns {{changed: number, to: 'open'|'closed'|null}} to = 实际落成的状态（未变时为 null）
 */
export function applyAfterSaleFromChain(orderIdHex, { open, openedAtBlock = null, at = Date.now() } = {}) {
  const id = String(orderIdHex).toLowerCase();
  if (open) {
    const changed = applyAfterSaleOpened(id, { block: openedAtBlock, at });
    return { changed, to: changed > 0 ? 'open' : null };
  }
  const local = getDb().prepare('SELECT after_sale_status FROM orders WHERE escrow_order_id = ?').get(id);
  if (!local || String(local.after_sale_status) !== 'open') return { changed: 0, to: null };
  const changed = applyAfterSaleClosed(id, { note: null, at });
  return { changed, to: changed > 0 ? 'closed' : null };
}

/**
 * DTO 字段（**唯一出处**：订单详情与仲裁队列两条下发路径共用）。
 *
 * `afterSaleNote` 是用户文本 → 只在 JSON 里下发、由前端按纯文本渲染（见 AFTER_SALE_NOTE_MAX）。
 * `afterSaleOpenedBlock` 一并给出：仲裁人/运维能拿它去链上核对（区块号是公开可查的事实），
 * 而 `afterSaleOpenedAt` 是**节点落库时刻**（近似开案时刻，与事件史里的 `at` 同口径）。
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
