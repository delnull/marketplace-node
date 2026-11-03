/**
 * 草稿订单清扫器：锁定未支付的 draft 订单超过 TTL（MK_DRAFT_TTL_MINUTES，
 * 默认 30 分钟）自动关闭为 cancelled——防草稿无限滞留占位（确定性 orderId
 * 与买家待处理视图均依赖及时收敛）。
 *
 * **年龄判据只有数据库时钟一处**：`orders.created_at` 由 MySQL 的
 * `DEFAULT CURRENT_TIMESTAMP(3)` 在插入时盖章，清扫在 SQL 里与 `CURRENT_TIMESTAMP(3)`
 * 相减。应用进程的墙上时钟/单调钟都不参与这个判断。
 *
 * 为什么不是"应用进程单调钟 + 进程启动标识"（旧实现）：
 *   那个锚点只在**同一进程**内可比。一个节点有多个后端时，A 后端创建的草稿对 B 后端
 *   来说"启动标识不同"，B 会把它当"上次运行遗留"处理；更糟的是 B 只要自己运行满
 *   TTL，就会把 A **刚刚创建**的草稿一起判过期——取消买家正在付款的单子并回补占位
 *   ⇒ 超卖。多后端下根本不存在"本进程启动前创建"这种全局事实。
 *
 * 数据库时钟是共享的单一权威：应用宿主机时钟跳变（NTP step、快照恢复、手改时间）
 * 不再影响判据；能影响它的是 MySQL 服务器自己的时钟，那是运维/NTP 层的事，
 * 而且所有后端看到的是同一个值。代价如实写：DB 时钟若向前跳，仍可能提前关闭草稿；
 * 这是"共享权威"的边界，不是本模块能靠应用侧时钟修掉的。
 *
 * 只处理本地 draft（未上链，无链上状态冲突）；escrowed 及以上状态由
 * watcher/链上事件驱动，不在此范围。幂等：重复清扫只更新仍在 draft 的行。
 */
import config from './config.js';
import { withRedisLock } from './redis.js';
import { fetchOrderFor } from './chainOrder.js';
import { finalizedBlockTag } from './chain.js';
import { getDb, withTransaction } from './db.js';
import { releaseHoldsForOrderIds } from './stockHold.js';

const SWEEP_INTERVAL_MS = 60_000; // 每 60s 检查一次
/** 单轮最多处理多少条：积压时把长事务/长串 RPC 切成多轮，而不是一轮锁住所有草稿。 */
const SWEEP_BATCH = 50;

/**
 * 执行一轮清扫，返回本次关闭的草稿数量（测试可直接调用）。
 *
 * 所有即将被取消的草稿都在取消前做一次有界链上探测；本地 paid_tx_hash 只能证明
 * “watcher 已经看到支付”，看不到“支付已上链、OrderCreated 还没被应用”的窗口。
 * 读不到/读链失败一律先不取消（fail-closed），下一轮再判。
 */
export async function sweepExpiredDrafts() {
  const db = getDb();
  const ttlMinutes = config.draftTtlMinutes;
  const dueSql = `o.created_at <= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? MINUTE)`;
  const paidGuard = 'AND NOT EXISTS (SELECT 1 FROM order_chain c WHERE c.order_id = o.id AND c.paid_tx_hash IS NOT NULL)';
  const probeRows = async (rows) => {
    if (!rows.length) return [];
    let blockTag;
    try {
      blockTag = await finalizedBlockTag();
    } catch {
      return rows.map((r) => r.id);
    }
    /*
      链上探测是网络 I/O：逐单串行会让一页 50 单的延迟叠加到分钟级，而它发生在
      取消事务**之前**（不持锁）。这里用有界并发（5）缩短清扫延迟，同时不给公共
      RPC 造成无界扇出；每一单仍然独立 fail-closed。
    */
    const held = new Array(rows.length).fill(false);
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= rows.length) return;
        const r = rows[i];
        try {
          const onchain = await fetchOrderFor(r.escrow_order_id, { blockTag });
          if (onchain?.status && onchain.status !== 'None') held[i] = true;
        } catch {
          // 可能已支付但 watcher 未应用：本轮不取消，避免把真单摘出本地生命周期。
          held[i] = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, rows.length) }, worker));
    return rows.filter((_, i) => held[i]).map((r) => r.id);
  };
  const staleRows = await db.all(
    `SELECT o.id, c.escrow_order_id
       FROM orders o
       JOIN order_chain c ON c.order_id = o.id
      WHERE o.status = 'draft'
        AND ${dueSql}
        AND c.escrow_order_id IS NOT NULL
        ${paidGuard}
      ORDER BY o.id
      LIMIT ?`,
    ttlMinutes,
    SWEEP_BATCH
  );
  const heldIds = await probeRows(staleRows);
  if (!staleRows.length) return 0;
  /*
    取消集合必须是**探测集合的子集**：只按 staleRows 里的 id 取消，绝不因为
    `LIMIT` 在排除 heldIds 后又把排名 51+、尚未探测的行拉进来。
    代价：单轮最多取消 50 条（staleRows 本身有界）；积压拆下一轮。
  */
  const probeIds = staleRows.map((r) => r.id);
  const probeSql = ` AND o.id IN (${probeIds.map(() => '?').join(',')})`;
  const holdSql = heldIds.length ? ` AND o.id NOT IN (${heldIds.map(() => '?').join(',')})` : '';
  /*
    候选的读**在事务之内**且带 `FOR UPDATE`（2026-10，MySQL 迁移）。

    为什么不能像旧实现那样"先在事务外读候选、再按候选批量 UPDATE + 释放占位"：候选读与写
    之间隔着一次网络往返，而**买家可以在这一瞬间付款**——那一行随即变成 escrowed，UPDATE
    的 `status = 'draft'` 守卫不会命中它（对，它不会被误取消），但"受影响行数 > 0"仍然成立，
    于是旧写法会把**它的占位也一起回补**（`rows` 是事务外读到的那批 id，不是真正被取消的那批）
    ⇒ 一笔正在付款的单子被释放了额度 ⇒ 同一件货可以再卖一次（超卖）。
    旧实现是单写者同步执行时不会有这个问题：单写者同步执行，读候选与写之间没有任何窗口。
    现在把读搬进事务并锁住候选行：id 集合就是真正被取消的集合，"读到谁就释放谁"重新成立。
    代价如实写：候选行在本次事务提交前被排他锁住（它们本来就要被改，不是额外代价）。
  */
  const foundRows = await withTransaction(async () => {
    const rows = await db.all(
      `SELECT o.id FROM orders o
        WHERE o.status = 'draft'
          AND ${dueSql}
          ${paidGuard}${probeSql}${holdSql}
        ORDER BY o.id
        FOR UPDATE`,
      ttlMinutes,
      ...probeIds,
      ...heldIds
    );
    if (!rows.length) return 0;
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    /*
      `updated_at` 写**墙上时间**，而且由**服务器**盖章（`CURRENT_TIMESTAMP(3)`），不写单调读数、
      也不接应用端时钟：它是全库公认的墙上时间列，消费者拿它与"此刻的墙钟"相减
      （PII 保留期锚点 COALESCE(pii_erased_at, updated_at)、对账 min-age、报表分窗）。
      写单调值会在墙钟跳变后让这一列与其它行、与消费者的 now 不同源，而 PII 保留期是
      **不可逆**动作——宁可让它按墙钟看"还没到期"，也不要提前擦掉。
      也就是说：**判据**与**记录**都保持数据库时钟口径，应用端时钟不参与。
    */
    const moved = (await db.run(
      `UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
        WHERE id IN (${marks})
          AND NOT EXISTS (SELECT 1 FROM order_chain c WHERE c.order_id = orders.id AND c.paid_tx_hash IS NOT NULL)`,
      'cancelled',
      ...ids
    )).foundRows;
    // 释放与取消同事务（防进程中断半写：状态已取消而占位未回补 → 幻影占额永久滞留；
    // 释放内部事务经 SAVEPOINT 自动降级嵌套，见 stockHold.js 的释放单点契约）
    if (moved > 0) {
      await releaseHoldsForOrderIds(ids);
    }
    return moved;
  });
  if (foundRows > 0) {
    console.log(`[sweeper] 自动关闭 ${foundRows} 个超时未支付的草稿订单（TTL ${ttlMinutes} 分钟）`);
  }
  return foundRows;
}

/** 启动周期清扫（server 入口调用；幂等，重复调用仅多一个定时器）。
 *  tick 是 async 且 await：`sweepExpiredDrafts` 现在全是异步库调用，不 await 的话
 *  这个 try/catch 永远接不到异常（失败会变成 unhandled rejection，而定时器照常继续跑）。 */
export function startOrderSweeper() {
  const tick = async () => {
    try {
      await withRedisLock('order-sweeper', 60_000, () => sweepExpiredDrafts(), { renewMs: 20_000 });
    } catch (e) {
      console.error('[sweeper] 本轮清扫异常（下轮重试）:', e?.message || e);
    }
  };
  tick();
  setInterval(tick, SWEEP_INTERVAL_MS);
}
