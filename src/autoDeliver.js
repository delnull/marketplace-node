/**
 * 卡密自动交付：数字商品订单进入 escrowed（买家托管成功，链上 OrderCreated）
 * 后自动从码池分配一个未用码并置 shipped——卡密/兑换码类无需卖家手动发货。
 *
 * 触发路径（**三条，全部经 `tryAutoDeliverByEscrowOrder`**——交付的输入一律是链上单号）：
 *  - `escrowWatcher` 轮询到 `OrderCreated` 回写之后（权威路径）；
 *  - `POST /:id/paid` 即时确认之后（快路径）；
 *  - 码池补货后的补跑 / 追赶回放收尾的冲刷（`tryAutoDeliverPendingForProduct`、`flushAutoDeliverPending`）。
 * 幂等（仅 escrowed 状态可交付，码分配走条件 UPDATE 防并发）。
 * 自动交付不覆盖的场景保持 escrowed 等卖家手动交付：
 *  - 实物商品（无码池语义，需物流单号）；
 *  - 数字商品但码池为空 / 未建池（MK_AUTO_DELIVER='0' 时全局关闭）。
 *
 * ## 键与表（本模块最容易写错的两处）
 *
 *  - **整单读**一律走读模型 `v_orders`：它把 orders / order_shipping / order_chain 三张表
 *    合成一张可读的订单。**写**一律直接命中具体那张表——视图带 JOIN，MySQL 里本来就不可更新，
 *    写错表会在 SQL 层当场报错。本模块只写 `orders`（状态与发货时刻）、`product_codes`（码的归属）、
 *    `order_delivery_items`（交付行）。
 *  - 行里**没有 `id`**：读模型的内部键叫 `order_id`（子表外键指向的就是它），对外标识叫
 *    `order_no`（CHAR(21)，URL 与通知里用的那个）。本模块两者都用：子表写入与 orders 自身的
 *    `WHERE id = ?` 用 `order_id`，日志与通知用 `order_no`。
 *
 * ## 时间：DATETIME(3)，由服务器盖章
 *
 * `shipped_at` / `used_at` / `updated_at` 一律写 `CURRENT_TIMESTAMP(3)`（会话 time_zone 已在
 * db.js 钉成 '+00:00'），不传 `Date.now()`——毫秒整数会被 MySQL 当成数字字面量解析成一个荒谬的
 * 时刻，而且不报错。`shipped_at` 用 `COALESCE(shipped_at, CURRENT_TIMESTAMP(3))` 保留首次交付时刻。
 */
import config from './config.js';
import { getDb, withTransaction, abortTx } from './db.js';
import { notify } from './webhook.js';
import { deliveryGate } from './chainOrder.js';

/**
 * 事务内从码池分配 quantity 个未用码并置订单 shipped（ship 手动发货与自动交付共用；
 * 交付行写入 order_delivery_items 子表）。
 * 返回 { codes: [..] } 或 { error: 'pool_empty' | 'conflict' | 'not_escrowed' }。
 * 整批分配：池未用不足 quantity 直接失败（不半交付）。
 *
 * @param {object} order 读模型行（`v_orders`）：需要 order_id / order_no / product_id / quantity
 */
export async function deliverDigitalFromPool(order) {
  const db = getDb();
  const qty = order.quantity || 1;
  /*
    候选码在**事务之前**读：读走连接池（真并发），写才需要串行（见 db.js 文件头）。
    读到的这一批可能已被别人抢走——那由下面每条条件 UPDATE 的 `changes` 判定，
    它才是"这个码现在归谁"的唯一判据（先读后写在这里是安全的，因为写的守卫是条件式的）。
  */
  const codes = await db.all("SELECT id, code FROM product_codes WHERE product_id = ? AND status = 'unused' ORDER BY id ASC LIMIT ?", order.product_id, qty);
  if (codes.length < qty) return { error: 'pool_empty' };
  /*
    整批要么全成、要么全不成：`withTransaction` 的回调就是事务的作用域，中途 `return`
    不会留下半批。`abortTx` 把这个语义写明确：已经算出返回值（一个拒因），但本次写入必须丢弃。
  */
  const result = await withTransaction(async () => {
    // 条件占用：任一码被并发抢走（changes = 0）整批作废
    for (const c of codes) {
      const ch = (await db.run("UPDATE product_codes SET status = 'used', order_id = ?, used_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'unused'", order.order_id, c.id)).changes;
      if (ch !== 1) return abortTx({ error: 'conflict' });
    }
    const moved = await db.run("UPDATE orders SET status = 'shipped', shipped_at = COALESCE(shipped_at, CURRENT_TIMESTAMP(3)), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'escrowed'", order.order_id);
    if (moved.changes !== 1) return abortTx({ error: 'not_escrowed' });
    for (const c of codes) {
      await db.run("INSERT INTO order_delivery_items (order_id, kind, value) VALUES (?, 'code', ?)", order.order_id, c.code);
    }
    return { codes: codes.map((c) => c.code) };
  });
  if (result.error) return result;
  /*
    通知放在**事务回调之外**（提交后的副作用纪律，本条注释此前就在，2026-10-14 才真的搬出来）：
    `notify` 是 fire-and-forget，但它的同步段会碰库（webhook.js 读 shop_webhook 那一行 + 按单号读
    订单，见 buildPayload）。放进事务回调里有两笔代价：① 让这次事务多背一次库读（并把行锁多握一会儿），
    别人的写虽然不再被全局串行化，但仍会被这些行锁挡住；② 它一旦抛错，会把一次**已经全部写完**的交付整个回滚（码重新回到池里、
    订单退回 escrowed），而调用方只看到 500。提交之后再通知，失败最多是"少一条 webhook"。
    参数是**对外单号** order_no（webhook 的接收方按它去查/对账），不是内部键。
  */
  notify('order.shipped', order.order_no); // 卖家通知（P0-3）：自动交付完成
  return result;
}

/** 商品级自动交付开关（P1-③）：-1=跟随全局 MK_AUTO_DELIVER / 0=关 / 1=开 */
export async function autoDeliverEnabledForProduct(productId) {
  const row = await getDb().get('SELECT auto_deliver FROM products WHERE id = ?', productId);
  if (!row) return config.autoDeliver; // 商品不存在（订单残留）：跟随全局
  if (row.auto_deliver === 0) return false;
  if (row.auto_deliver === 1) return true;
  return config.autoDeliver;
}

/**
 * 单订单自动交付尝试（幂等；结果只影响本地订单，不抛错）。
 *
 * **两个 await 都是承重的**（本函数是 async 的原因）：商品级开关与码池分配都读库，
 * 漏掉 await 时 `!Promise` 恒为 false（"没开自动交付"会静默放行）而 `r.codes` 恒为
 * undefined（交付永远不发生，且没有任何日志）——两处都静默，方向还相反。
 *
 * **本函数不再自带"该不该发"的判据**（2026-10-15 删掉了一处镜像判断）：
 * 唯一调用方 `tryAutoDeliverByEscrowOrder` 已经在调它之前过了 `chainOrder.deliveryGate`
 * （链上 `status == Created` 且 `refundRequested == false`，读不到就拒绝）。
 * 这里原本还留着一句 `if (order.refund_status === 'requested') return false;`——
 * 那是**按本地镜像**再判一次，而镜像按 finality 深度滞后：卖家 `rejectRefund` 之后、
 * 或 `RefundRejected` 事件漏扫/被隔离时，镜像会长期停在 `requested`，
 * 于是同一时刻"自动交付拒绝、手动 /ship 放行"，同一个问题又有了两个答案层。
 * 行筛选（escrowed + 有凭证）仍在调用方，与本模块的分工不变。
 */
export async function tryAutoDeliverOrder(order) {
  if (!order || order.status !== 'escrowed') return false;
  let snap = {};
  try {
    snap = JSON.parse(order.product_snapshot || '{}');
  } catch {
    snap = {};
  }
  if (snap.kind !== 'digital') return false;
  if (!(await autoDeliverEnabledForProduct(order.product_id))) return false;
  const r = await deliverDigitalFromPool(order);
  if (r.codes) {
    console.log(`[autoDeliver] 订单 ${String(order.order_no).slice(0, 8)}… ${r.codes.length} 个卡密已自动交付给买家`);
    return true;
  }
  if (r.error === 'pool_empty') {
    console.log(`[autoDeliver] 订单 ${String(order.order_no).slice(0, 8)}… 码池无未用码（需 ${order.quantity || 1} 个），等待卖家手动交付`);
  }
  return false;
}

/**
 * 按链上 escrow orderId 尝试自动交付（**本模块唯一的对外交付入口**）。
 *
 * **为什么必须复核链上**（2026-10-13，源码评审 P1）：判据一旦落在本地镜像
 * （`refund_status === 'requested'`）上，镜像的滞后就是结构性的：watcher 的扫描上界是
 * `head − finalityBlocks`（默认 12 块 ≈ 1 分钟），所以当它第一次看到 `OrderCreated(N)` 时，
 * 买家紧接着在 `N+1…N+12` 发出的 `requestRefund` **不在本批**、也不在"追赶抑制"的判定范围里
 * （`behind=false`）⇒ 码照发。结果是买家拿着全套兑换码、钱还冻在托管里（`refundRequested`
 * 让 `releaseExpired` 一直 revert），卖家只能拒绝 → 争议 → 仲裁——正是本文件
 * `tryAutoDeliverPendingForProduct` 注释里写的"双损"。
 *
 * 判据只有一条，且**只有一处实现**：`chainOrder.deliveryGate` —— 链上 `getOrder` 说
 * `status == Created(1)` 且 `refundRequested == false` 才发；读不到（RPC 不可达/无此单）**不发**
 * ——自动交付是"锦上添花"，宁可留给卖家面板手动交付，也不要在看不清链上状态时把码发出去。
 * 三个手动交付入口（`/ship`、`/seller/batch-ship`、`/:id/nft-deliveries`）走的是**同一个**闸
 * （2026-10-14 收口）：此前它们只看本地镜像，于是同一个"该不该交付"的问题有两个答案层，
 * 而两个答案在 finality 窗口里必然相反。
 *
 * **2026-10-14：这里原本还有一个 `tryAutoDeliverById(id)`**（只读本地镜像、供 `/paid` 快路径用）。
 * 它不是一个"少一层校验"的变体，而是**第二条判据**：同一个"该不该发码"的问题有两个答案层，
 * 于是 `/paid`（买家付款后立刻打的那条、恰好在镜像滞后窗口正中间）按镜像判、watcher 按链上判，
 * 而两者的结论在这 12 块里**必然相反**。实测（临时用例，跑完即删）：链上已 `requestRefund` 时
 * `tryAutoDeliverByEscrowOrder` ⇒ false，`tryAutoDeliverById` ⇒ true，订单被置 shipped、码被占用。
 * 修法不是"给 `/paid` 也补一次链上读"（那会留下两条都要各自维护的路径），而是**把按本地 id
 * 发码这件事整体删掉**：交付的输入是**链上单号**，本地行只是"要不要发"的下游查询条件。
 * 调用方一律 await 本函数（它读链），并在**链上单号已落库之后**调用。
 *
 * 返回 Promise：调用方（`/paid` 快路径、watcher 的 afterCommit）**必须** await 或 catch，
 * 否则失败会变成 unhandled rejection。
 */
export async function tryAutoDeliverByEscrowOrder(orderIdHex) {
  const id = String(orderIdHex || '').toLowerCase();
  if (!id) return false;
  /*
    先取本地行（整单读走读模型 v_orders），再走**交付闸**（`chainOrder.deliveryGate`）——
    判据只有那一处：链上 `status == Created` 且 `refundRequested == false`，读不到则不放行。
    这里不再内联一份"链上 Created 且未申请退款"的判断：三个手动交付入口（/ship、
    /seller/batch-ship、/:id/nft-deliveries）与自动交付必须回答同一个问题、给出同一个答案。
    顺序也顺带是"先看有没有可交付的本地行"：没有就不打这次 RPC。
    `paid_tx_hash IS NOT NULL` 就是"有支付凭证"：链上单号在**草稿期**就已生成
    （见 buyerSignal 的说明），所以只按单号筛会把未付款的草稿也送进交付闸。
  */
  const order = await getDb().get("SELECT * FROM v_orders WHERE escrow_order_id = ? AND status = 'escrowed' AND paid_tx_hash IS NOT NULL", id);
  if (!order) return false;
  const gate = await deliveryGate(order);
  if (!gate.ok) {
    if (gate.code === 'unreadable') {
      console.warn(`[autoDeliver] ${id.slice(0, 18)}… 链上真值读取失败，本轮不自动交付（保留 escrowed 等手动交付/下轮再试）`);
    }
    return false;
  }
  return await tryAutoDeliverOrder(order);
}

/**
 * 码池补货后的待交付补跑（码池导入路由调用）：把该商品「已托管且有支付凭证、自动交付开启、
 * 但此前因池空滞留 escrowed」的订单逐单再尝试自动交付——店主导入新码后无需手动逐单发货。
 * 返回本次成功补跑的订单数（幂等：不满足条件/池仍不足的订单保持 escrowed 等手动交付）。
 *
 * **必须先做链上复核**（源码评审 2026-09，P1）：本函数原先只看本地镜像
 * （`tryAutoDeliverOrder` 里那句 `order.refund_status === 'requested'`，2026-10-15 已删），
 * 而镜像有 15s 轮询 + 12 块确认深度的滞后窗口：买家已经在链上 `requestRefund`、
 * watcher 还没落地的这段时间里，店主一导入码就会把码发给一个**即将退款**的买家
 *（钱退回去、货也送出去）。复核由 `tryAutoDeliverByEscrowOrder` 一处承担（2026-10-14 起；
 * 此前它与 `flushAutoDeliverPending` 各自内联了一份同样的判据）。
 * 复核失败（RPC 读不到）时**不发**：自动交付是"锦上添花"，宁可留给卖家面板手动交付，
 * 也不要在看不清链上状态时把码发出去。
 */
export async function tryAutoDeliverPendingForProduct(productId) {
  const rows = await getDb().all("SELECT * FROM v_orders WHERE product_id = ? AND status = 'escrowed' AND paid_tx_hash IS NOT NULL ORDER BY created_at ASC LIMIT 50", productId);
  let delivered = 0;
  for (const o of rows) {
    /*
      **走唯一入口**，而不是在这里再抄一遍"链上 Created 且未申请退款"那条判据
      （2026-10-14 独立评审指出：本函数与 `flushAutoDeliverPending` 各自内联了一份，
      于是同一问题有三个答案层——正是本次要删掉的那个形状）。
      行筛选仍留在这里（它表达的是"这条补跑路径该管哪些单"），交付判据交给 `ByEscrowOrder`。
    */
    if (await tryAutoDeliverByEscrowOrder(o.escrow_order_id)) delivered += 1;
  }
  return delivered;
}

/**
 * 追赶回放收尾后的待交付冲刷跨批回放残留——OrderCreated 与其后的
 * RefundApproved 分属两个 SCAN_LIMIT 窗口时，前窗回放已把码发出、后窗才把单置 refunded，
 * 已退款买家免费得码）。回放期间 pollOnce 对未达链头的窗口抑制自动交付（behind 抑制），
 * 全部窗口追平后调用本函数：对仍 escrowed+有凭证的数字自动交付单逐单**复核链上当前真值**
 * （由 `tryAutoDeliverByEscrowOrder` 一处负责：仅 status=Created(1) 且 refundRequested=false 才补交付；
 * 读不到就不发）；已终局/退款冻结的行由后续事件迁移置终态，不发码。
 * 返回本次补交付的订单数（幂等：行守卫由 tryAutoDeliverOrder/deliverDigitalFromPool 承担）。
 */
export async function flushAutoDeliverPending() {
  /*
    这里的 `p.kind = 'digital'` 只用来**收窄候选面**（不然要把全部 escrowed 单都拿去打一次链上读）；
    真正"这一单该不该发码"的 kind 判据在 `tryAutoDeliverOrder` 里，它读的是**下单时冻结的快照**
    （`product_snapshot.kind`）——快照才是买家当初买的那个商品。
  */
  const rows = await getDb().all("SELECT v.* FROM v_orders v JOIN products p ON p.id = v.product_id WHERE v.status = 'escrowed' AND v.paid_tx_hash IS NOT NULL AND p.kind = 'digital' AND v.escrow_order_id IS NOT NULL");
  let delivered = 0;
  let checked = 0;
  for (const o of rows) {
    checked += 1;
    // 同 `tryAutoDeliverPendingForProduct`：判据只有 `tryAutoDeliverByEscrowOrder` 一处
    // （链上 Created 且未申请退款才发；读不到就不发）——这里不再内联第二份。
    if (await tryAutoDeliverByEscrowOrder(o.escrow_order_id)) delivered += 1;
  }
  if (checked > 0) console.log(`[autoDeliver] 追赶收尾冲刷完成：复核 ${checked} 单，补交付 ${delivered} 单`);
  return delivered;
}
