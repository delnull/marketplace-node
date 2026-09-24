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
 */
import { getDb, txBegin, txCommit, txRollback } from './db.js';
import { releaseHoldsForOrderIds, releaseHoldsForReturnReceived } from './stockHold.js';

/** 订单是否有交付事实（发货标记 shipped_at / 物流单号 / 交付行任一）。
 *  shipped_at 覆盖「自提/线下交付」空物流单号形态此前漏判致退款误释放占位，
 *  且已交付自提单无法创建退货单追回）。 */
export function hasDelivered(order) {
  if (!order) return false;
  if (order.shipped_at) return true;
  if (order.tracking_no) return true;
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM order_delivery_items WHERE order_id = ?')
    .get(order.id);
  return row.c > 0;
}

/** 读取订单退货单（无则 null） */
export function fetchReturnByOrder(orderId) {
  return getDb().prepare('SELECT * FROM order_returns WHERE order_id = ?').get(String(orderId || '')) || null;
}

/** 对外字段 */
export function returnToPublic(r) {
  if (!r) return null;
  return {
    status: r.status,
    waived: !!r.waived,
    address: r.address || '',
    note: r.note || '',
    trackingNo: r.tracking_no || null,
    receivedAt: r.received_at || null,
    createdAt: r.created_at,
  };
}

/**
 * 店主创建退货单（同单唯一；已存在则幂等返回既有单）。
 * 门控：订单已交付；状态窗口 = escrowed（部分交付）/ shipped / disputed / refunded
 * （即退款协调相关阶段）；未交付单直接走退款即可，无需退货单。
 */
export function createReturn({ order, address, note }) {
  if (!order) return { error: '订单不存在', notFound: true };
  const existing = fetchReturnByOrder(order.id);
  if (existing) return { ok: true, data: existing }; // 幂等：返回既有单
  if (!hasDelivered(order)) {
    return { error: '该订单尚无交付记录（未发货/未交付），无需退货单——可直接同意退款，库存将自动回补' };
  }
  if (!['escrowed', 'shipped', 'disputed', 'refunded'].includes(order.status)) {
    return { error: `当前状态(${order.status})不可创建退货单` };
  }
  const addr = String(address ?? '').trim().slice(0, 300);
  const noteText = String(note ?? '').trim().slice(0, 1000);
  const now = Date.now();
  const { changes } = getDb()
    .prepare(
      `INSERT OR IGNORE INTO order_returns (order_id, status, address, note, created_at, updated_at)
       VALUES (?, 'open', ?, ?, ?, ?)`
    )
    .run(order.id, addr, noteText, now, now);
  if (changes === 0) {
    const again = fetchReturnByOrder(order.id);
    if (again) return { ok: true, data: again };
    return { error: '退货单创建冲突，请重试' };
  }
  return { ok: true, data: fetchReturnByOrder(order.id) };
}

/** 买家回填退回物流单号：open → shipped */
export function setReturnTracking({ order, returnRow, buyer, trackingNo }) {
  if (!returnRow) return { error: '退货单不存在（请先联系卖家创建退货单）' };
  if (String(order.buyer || '').toLowerCase() !== String(buyer || '').toLowerCase()) {
    return { error: '仅买家本人可填写退回物流单号', forbidden: true };
  }
  const no = String(trackingNo ?? '').trim();
  if (!no) return { error: '退回物流单号不能为空' };
  if (no.length > 100) return { error: '退回物流单号不能超过 100 字符' };
  if (returnRow.status !== 'open') return { error: `退货单当前状态(${returnRow.status})不可再填单号（已寄出/已确认）` };
  getDb()
    .prepare("UPDATE order_returns SET status = 'shipped', tracking_no = ?, updated_at = ? WHERE id = ? AND status = 'open'")
    .run(no, Date.now(), returnRow.id);
  return { ok: true, data: fetchReturnByOrder(order.id) };
}

/**
 * 店主确认收到退货（receive）或放弃追索（waive→received+waived）。
 * 订单已 refunded 时当场释放占位（releaseHoldsForOrderIds 幂等）；未 refunded 时等待
 * watcher/sync 终局迁移后由 releaseRefundedEscrow 释放。
 */
export function settleReturn({ order, returnRow, waived }) {
  if (!returnRow) return { error: '退货单不存在' };
  if (!['open', 'shipped'].includes(returnRow.status)) {
    return { error: `退货单当前状态(${returnRow.status})已终局（收到/放弃后不可重复操作）` };
  }
  const now = Date.now();
  // 收货落定 + 占位释放同事务（防进程中断半写：received_at 已置而占位未回补 → 货已回库
  // 但额度永久滞留；释放函数内部事务经 SAVEPOINT 自动降级嵌套）
  txBegin();
  try {
    /*
      检查 `changes`（源码审计 2026-09 复审，P3）：UPDATE 带 `status IN ('open','shipped')` 守卫，
      竞态下第二次调用会改 0 行——旧实现不看 changes，仍然 `return { ok:true }` 并再跑一次释放
      （释放本身幂等，所以当前无害，但"该报错却报成功"会让调用方以为第一次的收货没落库、
      再点一次、再拿一次成功）。
    */
    const moved = getDb()
      .prepare(
        "UPDATE order_returns SET status = 'received', waived = ?, received_at = ?, updated_at = ? WHERE id = ? AND status IN ('open','shipped')"
      )
      .run(waived ? 1 : 0, now, now, returnRow.id).changes;
    if (moved !== 1) {
      txRollback();
      return { error: '退货单状态已变化（可能已被处理），请刷新后重试' };
    }
    // 链上退款已终局（refunded）→ 占位回补；未终局由 releaseRefundedEscrow 在事件迁移时兜底
    if (order && order.status === 'refunded') {
      releaseHoldsForOrderIds([order.id]);
    }
    // D1：订单已终局为成交态（settled/confirmed/expired——资金判给卖家）时才 receive/waive
    // （watcher 事件先到、卖家收货动作后到的顺序）：货已实际回到卖家侧/放弃追回 → 当场回补占位
    // （released_at 幂等；releaseHoldsForReturnReceived 判据含 received_at 非空，此处刚落库即命中）
    else if (order && ['settled', 'confirmed', 'expired'].includes(order.status)) {
      releaseHoldsForReturnReceived(order.escrow_order_id);
    }
    txCommit();
  } catch (e) {
    txRollback();
    throw e;
  }
  return { ok: true, data: fetchReturnByOrder(order.id) };
}
