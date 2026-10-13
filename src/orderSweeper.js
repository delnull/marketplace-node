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
 *   · 上一次运行留下的行（`created_boot` 与本进程不同）：跨进程的单调读数不可比，而**墙钟同样不可信**
 *     （跳变可能发生在两次运行之间），所以不再退回 `created_at` 比较（2026-10 修复，见下）。
 * 仅处理本地 draft（未上链，无链上状态冲突）；escrowed 及以上状态由
 * watcher/链上事件驱动，不在此范围。幂等：重复清扫只更新仍在 draft 的行。
 *
 * 遗留行怎么判（2026-10）——用**可证明的年龄下界**，不用墙钟：
 *   任何遗留行的创建时刻都在本进程启动之前，所以它的真实年龄 **≥ 本进程已运行的单调时长**。
 *   这条下界只用单调量（`now() − bootStart`，两个墙钟基准相减后抵消），因此免疫墙钟跳变；
 *   于是遗留行只在"本进程单调运行满 TTL"后才被判过期——那时它的真实年龄**确实** ≥ TTL，
 *   绝不会误关在途草稿，代价是最多晚一个 TTL 收敛（不是永不收敛）。
 *   旧实现直接拿 `created_at` 与墙钟相减：宿主机时钟向前跳一年之后重启，昨天刚建的草稿会被说成
 *   "早就过期"⇒ 买家正在付款的单子被取消 + 限量占位被回补 ⇒ 同款商品可再卖一次（超卖）。
 *   代价（如实写）：重启后"上一轮遗留的草稿"最多要等一个 TTL 才被收走（期间占位仍在），
 *   换来的是"任何一次关闭都建立在'这单确实老过 TTL'的证明上"。
 *   第三种形状（本次运行写入、却缺单调读数：`created_mono IS NULL`）**没有任何年龄下界可用**
 *   （它可能刚建），因此只告警、不扫——读不到年龄就不判过期，交给人工核对（正常写入路径不产生这种行）。
 */
import config from './config.js';
import { getDb, txBegin, txCommit, txRollback } from './db.js';
import { releaseHoldsForOrderIds } from './stockHold.js';
import { bootId, monotonicNow } from './monotonicClock.js';

const SWEEP_INTERVAL_MS = 60_000; // 每 60s 检查一次

/**
 * 本进程启动时刻的单调读数（模块求值时捕获）——遗留行的年龄下界（见文件头）。
 * 与 `now`/`boot` 一样可注入：单测要用**同一个**假时钟源注入 `bootStart` 才能构造"进程已运行 N 分钟"。
 */
const bootStartMono = monotonicNow();

/**
 * 执行一轮清扫，返回本次关闭的草稿数量（测试可直接调用）。
 * @param {object} [opts]
 * @param {() => number} [opts.now] 单调时刻来源，默认进程单调时钟；单测注入假时钟以构造跳变场景
 * @param {string} [opts.boot] 本次运行标识，默认当前进程；单测注入以构造"上一次运行留下的行"
 * @param {number} [opts.bootStart] 本进程启动时的单调读数，默认模块求值那一刻（单测与之同源注入）
 */
export function sweepExpiredDrafts({ now = monotonicNow, boot = bootId, bootStart = bootStartMono } = {}) {
  const db = getDb();
  const ttlMs = config.draftTtlMinutes * 60_000;
  /*
    两条判据按"这一行有没有可证明的年龄下界"分流（列说明见 db.js 的 created_boot/created_mono）：

    ① 本次运行创建的草稿（created_boot = 当前 boot 且 created_mono 非空）：年龄完全由单调流逝决定，
       **不看墙钟**。
    ② 上一次运行留下的行（created_boot <> 当前 boot）：年龄下界 = 本进程已运行的单调时长，
       故只有 `uptime >= TTL` 时才把它们列为候选（理由与代价见文件头）。
  */
  const monoCutoff = now() - ttlMs;
  const uptimeMs = now() - bootStart;
  const leftoverReady = uptimeMs >= ttlMs;
  const inBoot = 'status = ? AND created_boot = ? AND created_mono IS NOT NULL AND created_mono <= ?';
  const leftOver = 'status = ? AND created_boot <> ?';
  const anchorless = 'status = ? AND created_boot = ? AND created_mono IS NULL';
  // 本轮跳过遗留行时把原因与"什么时候能扫到"写清楚（跳过必须是可解释的，不是静默丢弃）
  if (!leftoverReady) {
    const skipped = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE ${leftOver}`).get('draft', boot).c;
    if (skipped) {
      console.warn(
        `[sweeper] 本轮不扫 ${skipped} 个上一次运行遗留的草稿：它们的单调锚点属于上一次运行（跨进程不可比），` +
          `而墙钟在两次运行之间可能已跳变——按墙钟判"过期"会误关正在付款的草稿并提前回补占位（⇒ 超卖）。` +
          `本进程已单调运行 ${Math.round(uptimeMs / 60_000)} 分钟：满 TTL（${config.draftTtlMinutes} 分钟）后` +
          `这些行的真实年龄必然 ≥ TTL，届时按同一条判据（年龄下界 = 本进程运行时长）正常关闭——最多晚一个 TTL，不会滞留。`
      );
    }
  }
  const anchorlessCount = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE ${anchorless}`).get('draft', boot).c;
  if (anchorlessCount) {
    console.warn(
      `[sweeper] ${anchorlessCount} 个草稿没有任何可用的年龄下界（created_boot=本次运行而 created_mono 为空）：` +
        `读不到年龄就不判过期（墙钟不可信），本轮及以后都不自动关闭——请人工核对后取消或让买家完成付款` +
        `（正常写入路径不会产生这种行，出现即说明该行被外部改写）`
    );
  }
  // 先取候选（限量商品占位的草稿）：关闭后整批聚合回补占位（见 stockHold.js 释放单点契约）
  const rows = [
    ...db.prepare(`SELECT id FROM orders WHERE ${inBoot}`).all('draft', boot, monoCutoff),
    ...(leftoverReady ? db.prepare(`SELECT id FROM orders WHERE ${leftOver}`).all('draft', boot) : []),
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
      (leftoverReady
        ? db.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE ${leftOver}`).run('cancelled', at, 'draft', boot).changes
        : 0);
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
