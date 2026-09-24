/**
 * 卡密自动交付：数字商品订单进入 escrowed（买家托管成功，链上 OrderCreated）
 * 后自动从码池分配一个未用码并置 shipped——卡密/兑换码类无需卖家手动发货。
 *
 * 触发路径：escrowWatcher 轮询回写（权威）与 POST /:id/paid 即时确认（快路径）
 * 均调用本模块；幂等（仅 escrowed 状态可交付，码分配走条件 UPDATE 防并发）。
 * 自动交付不覆盖的场景保持 escrowed 等卖家手动交付：
 *  - 实物商品（无码池语义，需物流单号）；
 *  - 数字商品但码池为空 / 未建池（MK_AUTO_DELIVER='0' 时全局关闭）。
 */
import config from './config.js';
import { getDb, txBegin, txCommit, txRollback } from './db.js';
import { notify } from './webhook.js';
import { fetchOrderFor } from './chainOrder.js';

/**
 * 事务内从码池分配 quantity 个未用码并置订单 shipped（ship 手动发货与自动交付共用；
 * 交付行写入 order_delivery_items 子表）。
 * 返回 { codes: [..] } 或 { error: 'pool_empty' | 'conflict' | 'not_escrowed' }。
 * 整批分配：池未用不足 quantity 直接失败（不半交付）。
 */
export function deliverDigitalFromPool(order) {
  const db = getDb();
  const qty = order.quantity || 1;
  const codes = db
    .prepare("SELECT id, code FROM product_codes WHERE product_id = ? AND status = 'unused' ORDER BY id ASC LIMIT ?")
    .all(order.product_id, qty);
  if (codes.length < qty) return { error: 'pool_empty' };
  const now = Date.now();
  txBegin();
  try {
    const claimed = db
      .prepare("UPDATE product_codes SET status = 'used', order_id = ?, used_at = ? WHERE id = ? AND status = 'unused'")
      .run(order.id, now, codes[0].id).changes;
    if (claimed !== 1) {
      txRollback();
      return { error: 'conflict' };
    }
    // 条件占用其余码：任一冲突（并发）整批回滚
    for (const c of codes.slice(1)) {
      const ch = db
        .prepare("UPDATE product_codes SET status = 'used', order_id = ?, used_at = ? WHERE id = ? AND status = 'unused'")
        .run(order.id, now, c.id).changes;
      if (ch !== 1) {
        txRollback();
        return { error: 'conflict' };
      }
    }
    const moved = db
      .prepare("UPDATE orders SET status = 'shipped', shipped_at = COALESCE(shipped_at, ?), updated_at = ? WHERE id = ? AND status = 'escrowed'")
      .run(now, now, order.id);
    if (moved.changes !== 1) {
      txRollback();
      return { error: 'not_escrowed' };
    }
    const ins = db.prepare('INSERT INTO order_delivery_items (order_id, kind, value, created_at) VALUES (?, ?, ?, ?)');
    for (const c of codes) ins.run(order.id, 'code', c.code, now);
    txCommit();
    /*
      通知放在 try/catch **之外**（源码审计 2026-09 复审，P3）：`notify` 是 fire-and-forget，
      但它自己（或将来某个包装）抛错时，会落到下面那个 catch 里执行 `txRollback()` —— 而事务
      **已经 COMMIT 了**：真错会被替换成"无活动事务"，交付已生效却返回 500；更糟的是，
      若将来有调用方在本函数外层还开着事务，这次 `txRollback` 会回滚**调用方**的事务。
      提交后的副作用一律不许再碰事务，这是本仓反复强调的 `afterCommit` 纪律。
    */
    notify('order.shipped', order.id); // 卖家通知（P0-3）：自动交付完成
    return { codes: codes.map((c) => c.code) };
  } catch (e) {
    txRollback();
    throw e;
  }
}

/** 商品级自动交付开关（P1-③）：-1=跟随全局 MK_AUTO_DELIVER / 0=关 / 1=开 */
export function autoDeliverEnabledForProduct(productId) {
  const row = getDb().prepare('SELECT auto_deliver FROM products WHERE id = ?').get(Number(productId) || 0);
  if (!row) return config.autoDeliver; // 商品不存在（订单残留）：跟随全局
  if (row.auto_deliver === 0) return false;
  if (row.auto_deliver === 1) return true;
  return config.autoDeliver;
}

/** 单订单自动交付尝试（幂等；结果只影响本地订单，不抛错） */
export function tryAutoDeliverOrder(order) {
  if (!order || order.status !== 'escrowed') return false;
  // 退款冻结期拒发（与 /ship、/nft-deliveries、batch-ship 门控一致）：
  // 码池导入补跑/paid 快路径/watcher 回写都经本函数——买家链上申请退款（requested，
  // 资金冻结）后不得再自动发码，否则卖家随后 approveRefund = 钱退+码送出双损。
  if (order.refund_status === 'requested') return false;
  let snap = {};
  try {
    snap = JSON.parse(order.product_snapshot || '{}');
  } catch {
    snap = {};
  }
  if (snap.kind !== 'digital') return false;
  if (!autoDeliverEnabledForProduct(order.product_id)) return false;
  const r = deliverDigitalFromPool(order);
  if (r.codes) {
    console.log(`[autoDeliver] 订单 ${order.id.slice(0, 8)}… ${r.codes.length} 个卡密已自动交付给买家`);
    return true;
  }
  if (r.error === 'pool_empty') {
    console.log(`[autoDeliver] 订单 ${order.id.slice(0, 8)}… 码池无未用码（需 ${order.quantity || 1} 个），等待卖家手动交付`);
  }
  return false;
}

/** 按本地订单 id 尝试自动交付（paid 即时确认路径） */
export function tryAutoDeliverById(id) {
  const order = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(String(id || ''));
  return tryAutoDeliverOrder(order);
}

/** 按链上 escrow orderId 尝试自动交付（watcher 回写路径）。
 *  仅交付已落链上支付凭证（paid_tx_hash 非空）的 escrowed 行：凭证防呆——无凭证行（支付未回写/
 *  竞态残留）不自动发码，保留 escrowed 由卖家面板标注/发货防呆拦截（见 orders.js /ship）。 */
export function tryAutoDeliverByEscrowOrder(orderIdHex) {
  const order = getDb()
    .prepare(
      "SELECT * FROM orders WHERE escrow_order_id = ? AND status = 'escrowed' AND paid_tx_hash IS NOT NULL"
    )
    .get(String(orderIdHex || '').toLowerCase());
  return tryAutoDeliverOrder(order);
}

/**
 * 码池补货后的待交付补跑（码池导入路由调用）：把该商品「已托管且有支付凭证、自动交付开启、
 * 但此前因池空滞留 escrowed」的订单逐单再尝试自动交付——店主导入新码后无需手动逐单发货。
 * 返回本次成功补跑的订单数（幂等：不满足条件/池仍不足的订单保持 escrowed 等手动交付）。
 *
 * **必须先做链上复核**（源码评审 2026-09，P1）：本函数原先只看本地镜像
 * （`tryAutoDeliverOrder` 里的 `order.refund_status === 'requested'`），而镜像有 15s 轮询 +
 * 12 块确认深度的滞后窗口：买家已经在链上 `requestRefund`、watcher 还没落地的这段时间里，
 * 店主一导入码就会把码发给一个**即将退款**的买家（钱退回去、货也送出去）。
 * 同文件的 `flushAutoDeliverPending` 早就在做这件事（`fetchOnchainOrder` + 仅
 * `status=Created(1) 且 refundRequested=false` 才发），本函数是唯一漏网的那条自动交付入口。
 * 复核失败（RPC 读不到）时**不发**：自动交付是"锦上添花"，宁可留给卖家面板手动交付，
 * 也不要在看不清链上状态时把码发出去（与 flush 的取舍一致）。
 */
export async function tryAutoDeliverPendingForProduct(productId) {
  const rows = getDb()
    .prepare(
      "SELECT * FROM orders WHERE product_id = ? AND status = 'escrowed' AND paid_tx_hash IS NOT NULL ORDER BY created_at ASC LIMIT 50"
    )
    .all(Number(productId) || 0);
  let delivered = 0;
  for (const o of rows) {
    // 无链上单号的行没有可复核的对象（理论上不会出现：paid 回写必然带单号）——交给手动交付
    if (!o.escrow_order_id) continue;
    let cur = null;
    try {
      cur = await fetchOrderFor(o.escrow_order_id);
    } catch {
      continue; // RPC 不可达：本轮跳过（下次补货/回放时再试），不冒险发码
    }
    const statusOk = String(cur?.status || '') === 'Created';
    if (!statusOk || cur?.refundRequested) continue;
    if (tryAutoDeliverOrder(o)) delivered += 1;
  }
  return delivered;
}

/**
 * 追赶回放收尾后的待交付冲刷跨批回放残留——OrderCreated 与其后的
 * RefundApproved 分属两个 SCAN_LIMIT 窗口时，前窗回放已把码发出、后窗才把单置 refunded，
 * 已退款买家免费得码）。回放期间 pollOnce 对未达链头的窗口抑制自动交付（behind 抑制），
 * 全部窗口追平后调用本函数：对仍 escrowed+有凭证的数字自动交付单逐单以**链上当前真值**
 * （getOrder）复核——仅 status=Created(1) 且 refundRequested=false 才补交付；
 * 已终局/退款冻结的行由后续事件迁移置终态，不发码。
 * 返回本次补交付的订单数（幂等：行守卫由 tryAutoDeliverOrder/deliverDigitalFromPool 承担）。
 */
export async function flushAutoDeliverPending() {
  const rows = getDb()
    .prepare(
      "SELECT o.* FROM orders o JOIN products p ON p.id = o.product_id WHERE o.status = 'escrowed' AND o.paid_tx_hash IS NOT NULL AND p.kind = 'digital' AND o.escrow_order_id IS NOT NULL"
    )
    .all();
  let delivered = 0;
  let checked = 0;
  for (const o of rows) {
    checked += 1;
    try {
      const cur = await fetchOrderFor(o.escrow_order_id);
      const statusOk = String(cur?.status || '') === 'Created';
      if (statusOk && !cur.refundRequested) {
        if (tryAutoDeliverOrder(o)) delivered += 1;
      }
    } catch {
      // RPC 不可达：保留 escrowed 待手动交付/下次冲刷，不阻断收尾
      console.warn(`[autoDeliver] 冲刷 ${o.id.slice(0, 8)}… 链上真值读取失败，保留待手动交付`);
    }
  }
  if (checked > 0) console.log(`[autoDeliver] 追赶收尾冲刷完成：复核 ${checked} 单，补交付 ${delivered} 单`);
  return delivered;
}
