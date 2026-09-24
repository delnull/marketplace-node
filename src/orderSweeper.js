/**
 * 草稿订单清扫器：锁定未支付的 draft 订单超过 TTL（MK_DRAFT_TTL_MINUTES，
 * 默认 30 分钟）自动关闭为 cancelled——防草稿无限滞留占位（确定性 orderId
 * 与买家待处理视图均依赖及时收敛）。
 *
 * 超时判据**不信任墙上时钟的跳变**（src/monotonicClock.js）：`created_at` 是下单那一刻的墙上时间，
 * 而"这单过了多久"由**单调锚点**决定——草稿行同时记下 `created_boot`（下单时的进程启动标识）与
 * `created_mono`（那一刻的单调读数）。于是：
 *   · 同一次运行内创建的草稿：年龄 = 单调流逝，墙钟向前跳（NTP step、快照恢复、手改时间、宿主迁移）
 *     **不会**把它们判成过期（那是真实故障：取消买家正在付款的单子 + 提前回补限量占位 ⇒ 超卖）；
 *     向后跳也不会让它们无限滞留（单调钟不倒退）。
 *   · 上一次运行留下的行：单调读数跨进程不可比，退回 `created_at` 的墙钟比较（见下方注释）。
 * 仅处理本地 draft（未上链，无链上状态冲突）；escrowed 及以上状态由
 * watcher/链上事件驱动，不在此范围。幂等：重复清扫只更新仍在 draft 的行。
 */
import config from './config.js';
import { getDb, txBegin, txCommit, txRollback } from './db.js';
import { releaseHoldsForOrderIds } from './stockHold.js';
import { bootId, monotonicNow } from './monotonicClock.js';

const SWEEP_INTERVAL_MS = 60_000; // 每 60s 检查一次

/**
 * 执行一轮清扫，返回本次关闭的草稿数量（测试可直接调用）。
 * @param {object} [opts]
 * @param {() => number} [opts.now] 单调时刻来源，默认进程单调时钟；单测注入假时钟以构造跳变场景
 * @param {string} [opts.boot] 本次运行标识，默认当前进程；单测注入以构造"上一次运行留下的行"
 */
export function sweepExpiredDrafts({ now = monotonicNow, boot = bootId } = {}) {
  const db = getDb();
  const ttlMs = config.draftTtlMinutes * 60_000;
  /*
    两条判据按"这一行有没有可用的单调锚点"分流（列说明见 db.js 的 created_boot/created_mono）：

    ① 本次运行创建的草稿（created_boot = 当前 boot）：年龄完全由单调流逝决定，**不看墙钟**。
    ② 上一次运行留下的行（boot 不同，含旧版本写的空值）：单调读数跨进程不可比，只能退回
       `created_at` 的墙钟比较——这是本机制唯一照不到的角落（若在墙钟跳变**之后**重启，
       这些行仍可能被一次性误判为过期）。写在这里而不是藏着：要堵掉它得把单调基准持久化，
       而那会引入"基准文件与数据库不同步"的新失败面，代价大于收益。
  */
  const monoCutoff = now() - ttlMs;
  const wallCutoff = Date.now() - ttlMs;
  const inBoot = 'status = ? AND created_boot = ? AND created_mono IS NOT NULL AND created_mono <= ?';
  const legacy = 'status = ? AND created_boot <> ? AND created_at <= ?';
  // 先取候选（限量商品占位的草稿）：关闭后整批聚合回补占位（见 stockHold.js 释放单点契约）
  const rows = [
    ...db.prepare(`SELECT id FROM orders WHERE ${inBoot}`).all('draft', boot, monoCutoff),
    ...db.prepare(`SELECT id FROM orders WHERE ${legacy}`).all('draft', boot, wallCutoff),
  ];
  if (!rows.length) return 0;
  // 批量置 cancelled + 整批释放同事务（防进程中断半写：状态已取消而占位未回补 →
  // 幻影占额永久滞留；释放内部事务经 SAVEPOINT 自动降级嵌套）
  txBegin();
  let changes = 0;
  try {
    /*
      `updated_at` 写**墙上时间**（Date.now()），不写单调读数：它是全库公认的墙上时间列，
      消费者拿它与"此刻的墙钟"相减（PII 保留期锚点 COALESCE(pii_erased_at, updated_at)、
      对账 min-age、报表分窗）。写单调值会在墙钟跳变后让这一列与其它行、与消费者的 now 不同源，
      而 PII 保留期是**不可逆**动作——宁可让它按墙钟看"还没到期"，也不要提前擦掉。
      也就是说：**判据**必须免疫跳变（上面两条 cutoff），**记录**必须保持墙钟口径（这里）。
    */
    const at = Date.now();
    changes =
      db
        .prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE ${inBoot}`)
        .run('cancelled', at, 'draft', boot, monoCutoff).changes +
      db
        .prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE ${legacy}`)
        .run('cancelled', at, 'draft', boot, wallCutoff).changes;
    if (changes > 0) {
      // 单写者同步执行：候选即受影响行（同一条件），整批一次调用即完成全部回补
      releaseHoldsForOrderIds(rows.map((r) => r.id));
    }
    txCommit();
  } catch (e) {
    txRollback();
    throw e;
  }
  if (changes > 0) {
    console.log(`[sweeper] 自动关闭 ${changes} 个超时未支付的草稿订单（TTL ${config.draftTtlMinutes} 分钟）`);
  }
  return changes;
}

/** 启动周期清扫（server 入口调用；幂等，重复调用仅多一个定时器）。
 *  tick 包 try/catch：清扫异常不得击穿进程（WAL 保证不脏数据，仅可用性防护）。 */
export function startOrderSweeper() {
  const tick = () => {
    try {
      sweepExpiredDrafts();
    } catch (e) {
      console.error('[sweeper] 本轮清扫异常（下轮重试）:', e?.message || e);
    }
  };
  tick();
  setInterval(tick, SWEEP_INTERVAL_MS);
}
