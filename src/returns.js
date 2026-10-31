/**
 * 退货单数据层（P0-4，纯本地数据面——链上资金流不变）：
 *
 * 用途：已交付订单（有物流单号或交付行）退款时的线下追回协调——
 * 卖家建退货单（地址/说明）→ 买家回填退回物流单号 → 卖家确认收到/放弃追索 →
 * 该单占位才被回补（防「钱退了货没回，容量却被再售」）。
 *
 * 与释放机制的关系（见 stockHold.js）：
 *  - 未交付的退款单：refunded 终局即自动释放（原语义）；
 *  - 已交付且退货 received_at 非空：refunded 终局自动释放（releaseRefundedEscrow 升级判据）；
 *  - 已交付未确认收货：占位保留；卖家 receive/waive 时若订单已 refunded 则当场释放
 *    （watcher/sync 事件在 receive 之后到达时由 releaseRefundedEscrow 覆盖——released_at 幂等）；
 *  - D1 例外：成交终局态（settled/confirmed/expired——资金判给卖家）但退货已确认收货/放弃追索
 *    （received_at 非空，货已实际回到卖家侧可再售）：终局迁移（watcher/sync）或 receive/waive
 *    动作当场由 releaseHoldsForReturnReceived 回补占位（released_at 幂等）。
 *
 * 建单窗口与售后案件的关系（2026-10）：窗口 = 退款协调相关状态（escrowed/shipped/disputed/refunded）
 * **∪ 有在途售后案件**（after_sale_status='open'，即确认收货后买家在链上开的案件）。
 * 后者是"货要寄回、需要留痕"的唯一凭据（已钱货两清的单没有它就没有追索依据），
 * 详见 createReturn 的说明——但**占位回补语义不变**：仍只认 received_at。
 *
 * ## 键与形状
 *
 *  - `order_returns.order_id` 是**订单内部键**（外键 → `orders.id`，并带 UNIQUE：一单一退货单），
 *    不是对外单号 `orders.order_no`。本模块的 `order` 入参是读模型 `v_orders` 的行，
 *    内部键在那里叫 `order_id`（没有 `id`——`row.id` 是 undefined，拿它当键会在绑定参数处
 *    直接抛错，而不是悄悄查不到）。
 *  - `status` 是 ENUM('open','shipped','received')；`tracking_no` / `carrier` / `received_at`
 *    三态一律 NULL = 未记录（**不是空串**），`carrier` 的归一在 src/shipping.js。
 *  - 时间列是 DATETIME(3)：写入口一律让**服务器**盖章（`CURRENT_TIMESTAMP(3)`，会话 time_zone
 *    已在 db.js 钉成 '+00:00'）。不传 `Date.now()`：毫秒整数会被 MySQL 当成数字字面量解析成
 *    一个荒谬的时刻，而且不报错。
 */
import { getDb, withTransaction, abortTx } from './db.js';
import { releaseReturnedUnits } from './stockHold.js';
// 确认收货后的售后案件：在途判据的唯一实现（见 createReturn 的窗口说明）
import { isAfterSaleOpen } from './afterSale.js';
// 承运方名称的归一（与发货侧同一实现）：退回件与寄出件必须是同一种形状
import { normalizeCarrier } from './shipping.js';

/** 订单是否有交付事实（发货标记 shipped_at / 物流单号 / 交付行任一）。
 *  shipped_at 覆盖「自提/线下交付」空物流单号形态此前漏判致退款误释放占位，
 *  且已交付自提单无法创建退货单追回）。
 *  ⚠️ 入参必须是读模型行（要有 `order_id`）：子表 `order_delivery_items.order_id` 是内部键。 */
export async function hasDelivered(order) {
  if (!order) return false;
  if (order.shipped_at) return true;
  if (order.tracking_no) return true;
  const row = await getDb().get('SELECT COUNT(*) AS c FROM order_delivery_items WHERE order_id = ?', order.order_id);
  return row.c > 0;
}

/** 读取订单退货单（无则 null）。`orderId` = 订单内部键（`v_orders.order_id`） */
export async function fetchReturnByOrder(orderId) {
  return await getDb().get('SELECT * FROM order_returns WHERE order_id = ?', orderId) || null;
}

/**
 * 卖家填写/修改退货地址（买家发起退货申请后）。
 * 只允许 open 状态；已寄出/已收货再改地址没有意义，反而会让买家按旧地址寄丢。
 */
export async function setReturnAddress({ returnRow, address }) {
  if (!returnRow) return { error: '退货单不存在（请先由买家发起退货申请）' };
  const addr = String(address ?? '').trim().slice(0, 300);
  if (!addr) return { error: '退货地址不能为空' };
  const moved = (await getDb().run(
    "UPDATE order_returns SET address = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'open'",
    addr,
    returnRow.id
  )).changes;
  if (moved !== 1) return { error: '退货单状态已变化（已寄出/已收货），不能再改地址' };
  return { ok: true, data: await fetchReturnByOrder(returnRow.order_id) };
}

/**
 * 买家发起退货申请：仅创建一条 open 的空地址退货单，地址由卖家补。
 * 门控复用 createReturn（已交付 + 退款/售后窗口），这里只补买家身份。
 */
export async function requestReturn({ order, buyer, note, quantity }) {
  if (!order) return { error: '订单不存在', notFound: true };
  if (String(order.buyer || '').toLowerCase() !== String(buyer || '').toLowerCase()) {
    return { error: '仅买家本人可发起退货申请', forbidden: true };
  }
  return createReturn({
    order,
    address: '',
    note: `买家申请退货：${String(note ?? '').trim().slice(0, 500)}`,
    quantity,
  });
}

/** 对外字段（时间列是 Date → JSON 给出 ISO-8601；NULL 的三态原样透出为 null） */
export function returnToPublic(r) {
  if (!r) return null;
  return {
    status: r.status,
    waived: !!r.waived,
    /*
      本次退货覆盖的件数。多件订单可只退一部分；占位释放按这个数，而不是按整单 hold_qty。
      对外必须下发：卖家在确认收货前要能核对"退回来的是几件"。
    */
    quantity: Number(r.quantity) || 1,
    address: r.address || '',
    note: r.note || '',
    trackingNo: r.tracking_no || null,
    /*
      退回件的承运方名称（买家填，可空）。与订单侧的 `orders.carrier` **同一口径与同一归一实现**
      （src/shipping.js）：只有运单号时查件只能靠单号前缀猜，纯数字号段的快递完全猜不出；
      NULL = 未填（三态：不是空串）。退货这条路与发货那条路必须是同一种形状，否则
      "同一个运单号，卖家寄出时能查、买家寄回时查不了"。
    */
    carrier: r.carrier || null,
    receivedAt: r.received_at || null,
    createdAt: r.created_at,
  };
}

/**
 * 店主创建退货单（同单唯一；已存在则幂等返回既有单）。
 * 门控：订单已交付；状态窗口 = escrowed（部分交付）/ shipped / disputed / refunded
 * （即退款协调相关阶段）**或有在途售后案件**（确认收货后的售后案件，见下）；未交付单直接走退款即可。
 *
 * 为什么终局单只对"有在途售后案件"开放（**不要顺手放宽成"终局都可建"**）：
 * 退货单在本仓是有资金后果的凭据——卖家 receive/waive 会经 `releaseHoldsForReturnReceived`
 * 回补库存占位（D1 口径：货已实际回到卖家侧/卖家放弃追索，额度才能再售）。对一笔**已钱货两清**
 * 的终局单，唯一能证明"货要寄回、需要留痕"的链上事实就是售后案件（买家在窗口内 openAfterSale）；
 * 没有案件却允许建单，等于凭空给终局单补一条不存在的追索依据，而占位回补会跟着它走。
 * 有案件时反而必须放行：案件主张的正是"货有问题"，货要寄回、流程要留痕（谁寄的、寄到哪、
 * 卖家何时确认收到），否则双方只能在线下口头约定，占位与退货事实都无从对账。
 *
 * ⚠️ 与本文件既有纪律一致：这里只**放行建单**，绝不改占位回补语义——已交付单不因建单/结案
 * 自动回补，仍以 `received_at` 为唯一凭据（见 releaseHoldsForReturnReceived）。
 *
 * @param {{order: object, address?: string, note?: string}} p order = 读模型行（需 order_id/status/…）
 */
export async function createReturn({ order, address, note, quantity }) {
  if (!order) return { error: '订单不存在', notFound: true };
  const existing = await fetchReturnByOrder(order.order_id);
  if (existing) return { ok: true, data: existing }; // 幂等：返回既有单
  if (order.pii_erased_at != null) {
    return { error: '该订单的个人信息已按请求擦除：擦除是终态，不能再新建退货单写入退货地址/备注' };
  }
  if (!(await hasDelivered(order))) {
    return { error: '该订单尚无交付记录（未发货/未交付），无需退货单——可直接同意退款，库存将自动回补' };
  }
  const afterSaleOpen = isAfterSaleOpen(order);
  if (!['escrowed', 'shipped', 'disputed', 'refunded'].includes(order.status) && !afterSaleOpen) {
    return {
      error:
        `当前状态(${order.status})不可创建退货单：仅退款协商中（escrowed / shipped / disputed / refunded）` +
        '或**有在途售后案件**（确认收货后由买家在链上 openAfterSale 开案）的订单可建单——' +
        '已终局且无售后案件的订单钱货两清，无需退货单（如需追回请线下协商或先开售后案件）',
    };
  }
  const maxQty = Number(order.quantity) || 0;
  /*
    退货件数是**占位释放的计量单位**：多件订单只退回一件时，只能释放一件的 committed，
    否则剩下仍在买家手里的货会立刻变成"可再售"（超卖）。缺省 = 整单全部退回；
    卖家要部分退货必须显式给 quantity（或后续 PATCH /return/quantity 改小）。
  */
  const qtyRaw = quantity === undefined || quantity === null || quantity === '' ? maxQty : Number(quantity);
  if (!Number.isSafeInteger(qtyRaw) || qtyRaw < 1 || qtyRaw > maxQty) {
    return { error: `退货件数需为 1..${maxQty} 的整数（本单共 ${maxQty} 件）` };
  }
  const addr = String(address ?? '').trim().slice(0, 300);
  const noteText = String(note ?? '').trim().slice(0, 1000);
  /*
    `order_id` 上的 UNIQUE 就是幂等键：撞键 = 另一次请求（或同一次重试）已经建过单，
    那不是错误，是"已经在了"。所以用 `ON DUPLICATE KEY UPDATE order_id = order_id`
    （db.js 文件头第 4 条的家法），**不是** `INSERT IGNORE`——外键违规（订单不存在）
    与数据截断仍然照常报错，被折叠掉的只有撞唯一键这一件。
    代价如实写：mysql2 带 CLIENT_FOUND_ROWS，这条语句在"撞键"时报告 `changes = 1`
    （命中行数），**因此不能拿 changes 判断"这次到底插进去了没有"**——所以这里不再有
    "changes === 0 就去重读"的分支：两种结果要求的下一个动作本来就相同（读回那一行）。
    created_at / updated_at 不传：由列的 DEFAULT CURRENT_TIMESTAMP(3) 盖章。
  */
  await getDb().run(
    `INSERT INTO order_returns (order_id, status, quantity, address, note)
     VALUES (?, 'open', ?, ?, ?)
     ON DUPLICATE KEY UPDATE order_id = order_id`,
    order.order_id, qtyRaw, addr, noteText
  );
  return { ok: true, data: await fetchReturnByOrder(order.order_id) };
}

/**
 * 修改退货件数（仅 open；卖家在确认收到前按实际退回数量修正）。
 *
 * 买家发起退货时默认整单；卖家实际只收到部分时必须在点 receive 之前改小——
 * `settleReturn` 按这里的数字释放占位，写大了就是把买家仍持有的货变成可再售。
 */
export async function setReturnQuantity({ order, returnRow, quantity }) {
  if (!returnRow) return { error: '退货单不存在' };
  if (returnRow.status !== 'open') return { error: `退货单当前状态(${returnRow.status})不可修改件数（已寄出/已确认）` };
  const maxQty = Number(order?.quantity) || 0;
  const qty = Number(quantity);
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > maxQty) {
    return { error: `退货件数需为 1..${maxQty} 的整数（本单共 ${maxQty} 件）` };
  }
  const moved = (await getDb().run(
    "UPDATE order_returns SET quantity = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'open'",
    qty,
    returnRow.id
  )).changes;
  if (moved !== 1) return { error: '退货单状态已变化，请刷新后重试' };
  return { ok: true, data: await fetchReturnByOrder(returnRow.order_id) };
}

/**
 * 买家回填退回物流单号（可带承运方名称）：open → shipped。
 * `carrier` 的归一与上限走 src/shipping.js（与发货侧**同一实现**）：空串/未填 → NULL，
 * 不留空串、也不编"其他"——它是"买家有没有告诉我们寄的是哪家"这个事实本身。
 *
 * **必须检查 `changes`**（2026-10-14 补齐，与同文件 `settleReturn` 同一形状）：UPDATE 带的
 * `AND status = 'open'` 是竞态守卫，而买家提交单号与卖家「确认收到 / 放弃追索」改的是同一行。
 * 不看 changes 就会在写了 0 行的前提下回"已记录退回物流单号"——买家以为寄回凭据已登记，
 * 卖家那边状态早已是 received、单号仍是 NULL，退回件的唯一凭据静默丢失。
 *
 * @param {{order: object, returnRow: object, buyer: string, trackingNo?: string, carrier?: unknown}} p
 *   order = 读模型行（校验买家身份）；returnRow = order_returns 行（`id` 是退货单自己的内部键）
 */
export async function setReturnTracking({ order, returnRow, buyer, trackingNo, carrier }) {
  if (!returnRow) return { error: '退货单不存在（请先联系卖家创建退货单）' };
  if (String(order.buyer || '').toLowerCase() !== String(buyer || '').toLowerCase()) {
    return { error: '仅买家本人可填写退回物流单号', forbidden: true };
  }
  const no = String(trackingNo ?? '').trim();
  if (!no) return { error: '退回物流单号不能为空' };
  if (no.length > 100) return { error: '退回物流单号不能超过 100 字符' };
  if (returnRow.status !== 'open') return { error: `退货单当前状态(${returnRow.status})不可再填单号（已寄出/已确认）` };
  const moved = (await getDb().run("UPDATE order_returns SET status = 'shipped', tracking_no = ?, carrier = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'open'", no, normalizeCarrier(carrier), returnRow.id)).changes;
  if (moved !== 1) {
    return { error: '退货单状态已变化（可能已被卖家处理），请刷新后重试——单号没有记录，请确认当前状态后再填' };
  }
  return { ok: true, data: await fetchReturnByOrder(order.order_id) };
}

/**
 * 店主确认收到退货（receive）或放弃追索（waive→received+waived）。
 * 订单已 refunded 时当场释放占位（releaseHoldsForOrderIds 幂等）；未 refunded 时等待
 * watcher/sync 终局迁移后由 releaseRefundedEscrow 释放。
 *
 * `received_at` 是**占位释放的唯一凭据**，所以它与释放写在同一个事务里（见下）。
 * @param {{order: object, returnRow: object, waived?: boolean}} p
 */
export async function settleReturn({ order, returnRow, waived }) {
  if (!returnRow) return { error: '退货单不存在' };
  if (!['open', 'shipped'].includes(returnRow.status)) {
    return { error: `退货单当前状态(${returnRow.status})已终局（收到/放弃后不可重复操作）` };
  }
  /*
    收货落定 + 占位释放同事务（防进程中断半写：received_at 已置而占位未回补 → 货已回库
    但额度永久滞留）。`withTransaction` 的回调就是事务的作用域：中途 `return`/抛错都必然回滚，
    不会留下"状态改了、占位没放"的中间态。释放函数内部的事务在这里降级为 SAVEPOINT（嵌套，见 db.js）。
  */
  const result = await withTransaction(async () => {
    /*
      检查 `changes`（源码审计 2026-09 复审，P3）：UPDATE 带 `status IN ('open','shipped')` 守卫，
      竞态下第二次调用会改 0 行——旧实现不看 changes，仍然 `return { ok:true }` 并再跑一次释放
      （释放本身幂等，所以当前无害，但"该报错却报成功"会让调用方以为第一次的收货没落库、
      再点一次、再拿一次成功）。
    */
    const moved = (await getDb().run("UPDATE order_returns SET status = 'received', waived = ?, received_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status IN ('open','shipped')", waived ? 1 : 0, returnRow.id)).changes;
    if (moved !== 1) return abortTx({ error: '退货单状态已变化（可能已被处理），请刷新后重试' });
    /*
      事务内重读并锁订单状态：路由入口读到的是旧快照，事务提交前 watcher 可能已把订单
      推到 refunded。用旧快照分支会两支都不命中，`received_at` 落了而占位永久滞留。
    */
    const fresh = await getDb().get('SELECT status FROM orders WHERE id = ? FOR UPDATE', order.order_id);
    if (!fresh) return abortTx({ error: '订单不存在' });
    // 事务内重读退货件数：入口拿到的 returnRow 可能是改件数之前的快照；释放必须按落库值。
    const freshReturn = await getDb().get('SELECT quantity FROM order_returns WHERE id = ? FOR UPDATE', returnRow.id);
    const returnedQty = Number(freshReturn?.quantity) || 0;
    /*
      退货已确认收到 ⇒ 只释放**这次退回的件数**（多件订单的部分退货不能整单清零）。
      状态覆盖面：refunded（全额退款终局）与成交终局（settled/confirmed/expired，D1 口径）。
      顺序无关：先收货后终局、先终局后收货都由 `released_qty` 幂等保证只释放一次。
    */
    if (['refunded', 'settled', 'confirmed', 'expired'].includes(fresh.status) && returnedQty > 0) {
      await releaseReturnedUnits(order.order_id, returnedQty, returnRow.id);
    }
    return { ok: true };
  });
  if (result.error) return result;
  return { ok: true, data: await fetchReturnByOrder(order.order_id) };
}
