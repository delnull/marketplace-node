/**
 * 订单状态迁移的**唯一认领内核**（跨 watcher / sync / 对账）。
 *
 * 为什么需要它：链上终局事件到达时，"这一单在迁移前是什么状态"决定了要不要补库存占位
 * （`cancelled` 的占位在取消时已经释放；`draft` 从未占过位则不用补）。旧实现先做一次普通
 * `SELECT` 拿快照，再执行 `UPDATE ... WHERE status IN (...)`，然后用**快照里的 status** 决定
 * 是否 `restockOrder`。并发下（草稿清扫器/买家取消在两次语句之间提交）UPDATE 会命中
 * `cancelled` 并成功，而 JS 分支拿到的仍是 `draft` —— 占位永远不补，限量商品因此可被再卖一次
 * （静默超卖，`integrity` 只能事后报 committed-drift）。
 *
 * 判据必须与迁移发生在**同一把行锁**下：`SELECT ... FOR UPDATE` 读到的 `from` 就是这次
 * `UPDATE` 真正认领的前一状态。调用方必须在 `withTransaction` 内调用（本仓的
 * `getDb()` 会经 AsyncLocalStorage 落到事务连接上）；事务外调用时更新守卫仍能防止覆盖，
 * 但 `from` 可能与真正提交的状态不同——所以本模块的契约就是"事务内使用"。
 *
 * @param {{get:Function, all:Function, run:Function}} db 查询门面（事务内应指向同一连接）
 * @param {number|string} orderId 订单**内部键** `orders.id`
 * @param {string[]} fromStatuses 允许迁移的源状态（空数组 = 不限制，仅供调用方明确表达）
 * @param {string} toStatus 目标状态
 * @param {{touchUpdatedAt?: boolean}} [opts] 默认写 `updated_at`（它是入账/窗口锚点）
 * @returns {Promise<{changed:number, from:string|null}>} `from` = 本次认领的前一状态；
 *   未命中时为当前状态（行不存在/不满足 from 集合时 `changed=0`）。
 */
export async function claimOrderState(db, orderId, fromStatuses, toStatus, { touchUpdatedAt = true } = {}) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`claimOrderState：需要订单内部键（orders.id 的安全整数），收到 ${JSON.stringify(orderId)}`);
  }
  // 锁定读：它返回的是本事务真正看到的当前版本，后续 UPDATE 与库存判断都基于这个值。
  const row = await db.get('SELECT id, status FROM orders WHERE id = ? FOR UPDATE', id);
  if (!row) return { changed: 0, from: null };
  const from = String(row.status);
  if (fromStatuses.length > 0 && !fromStatuses.includes(from)) {
    return { changed: 0, from };
  }
  const sql = touchUpdatedAt
    ? 'UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = ?'
    : 'UPDATE orders SET status = ? WHERE id = ? AND status = ?';
  const changed = (await db.run(sql, toStatus, id, from)).changes;
  return { changed, from };
}
