/**
 * 单调时钟：判「过了多久」只看**进程内单调流逝**，不看墙上时钟的跳变。
 *
 * 为什么需要它（真实故障类，不是洁癖）：
 *   `Date.now()` 是墙上时钟，NTP step 校正、虚拟机快照恢复、运维手改时间、容器宿主机
 *   迁移都会让它**瞬间跳变**（几十秒到几年不等）。以草稿清扫器为例：
 *     cutoff = Date.now() - TTL;   SELECT id FROM orders WHERE status='draft' AND created_at <= cutoff;
 *   宿主机时钟向前跳一年之后，所有在途草稿——包括买家**正在链上付款**的那一单——会立刻
 *   「看起来早就过期」⇒ 被置 cancelled 并回补限量库存占位 ⇒ 同一件限量商品可以再卖给别人
 *   （超卖），或链上资金已付而本地单已被取消（escrowWatcher 里那段「恢复已取消订单 +
 *   占位失败告警」正是这种竞态的补丁）。反向跳（向后）则让草稿无限滞留、白占额度。
 *
 * 做法：进程启动时记一对基准 `{ wall: Date.now(), mono: performance.now() }`，
 * 之后 `now() = 基准 wall + 单调流逝`（与 Date.now() 同口径的毫秒数，可直接与库里的墙上
 * 时间戳比较）：
 *   - 时间正常流逝 → 跟着走；
 *   - 墙上时钟**向前跳** → 不跟跳：本时钟落后于墙上时钟，超时只会**更晚**触发，
 *     方向安全（绝不把还在付款途中的单子判死、绝不提前回补占位）；
 *   - 墙上时钟**向后跳** → 不倒退：同一进程内 `now()` 单调不减，已到期的草稿照样按期收敛，
 *     不会因墙钟回拨而无限滞留；
 *   - 单调不减是**构造保证**：`now()` 返回历史最大值，底层单调读数抖动/非有限值都不会让它回退，
 *     也不会返回 NaN（`created_at <= NaN` 恒为 false ⇒ 占位永久滞留）。
 *
 * 设计上的刻意取舍：`now()` 的热路径**从不读墙上时钟**（墙钟只在建立基准与诊断 `driftMs()`
 * 时被读）。也就是说「向前跳导致误判过期」这个故障在结构上不可能发生，而不是靠某个比较
 * 把它挡住——后者只要有人改错方向就会复发。
 *
 * 代价（必须知情，别把它当万能药）：
 *   1) **长跑漂移**：本时钟与墙上时钟各走各的。墙上时钟会被 NTP **slew**（渐进微调）、
 *      或本身就走得比真实时间快/慢，而单调钟不跟着校正 ⇒ 进程跑得越久，两者差值越大
 *      （典型几十 ppm，一天几十毫秒~几秒；发生 NTP step 时可达跳变量级）。方向是安全的：
 *      以本时钟判定的「过期时刻」相对真实墙上时间最多**偏晚**，绝不偏早——代价是草稿可能
 *      比 TTL 多活一点（另有「同买家活跃草稿 ≤10」等闸兜底，不会无限堆积）。
 *   2) **跨进程不可比**：本时钟只在**本进程内**有意义，进程重启后重新与墙上时钟对齐
 *      （新基准 = 重启那一刻的 Date.now()）。库里 `created_at` 仍是下单时的墙上时间，
 *      所以「重启后拿库内墙上时间戳与墙上时钟比较」这一步是单调钟救不了的：如果在跳变之后
 *      重启，陈旧草稿仍可能被一次扫掉。真要把这半也堵上得靠运维层保证时钟稳定
 *      （或把单调基准持久化），本模块只负责「进程存活期间不受墙钟跳变影响」。
 *
 * 单测注入：`createClock({ wallNow, monoNow })` 传假时间源即可构造跳变场景（见
 * test/monotonicClock.test.js 与 test/sweeper.test.js），无需 jest/假计时器。
 */
import { randomUUID } from 'node:crypto';

/** 墙上时钟源：只用于建立基准与诊断，热路径不读它（见文件头「设计上的刻意取舍」） */
const wallClock = () => Date.now();
/** 单调时间源：Node ≥16 的全局 performance.now()（进程内单调，不受系统时间调整影响） */
const monoClock = () => performance.now();

/**
 * 非有限读数一律回退到给定值：防 NaN 传播进 SQL 比较（`<= NaN` 恒 false）与时间戳写入。
 *
 * **必须判"是不是一个有限的 number"而不是 `Number.isFinite(Number(v))`**（源码审计 2026-09 复审，P3）：
 * 后者会把 `null` / `''` / `false` / `[]` 一律 `Number()` 成 **0** 并判为"有限"——
 * 于是一个返回空串的墙钟源会让 `anchorWall = 0`（1970 年），本 boot 写入的草稿**永不超时**，
 * 而文件头承诺的"非有限读数回退"在这类输入上根本没生效。
 */
const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * 建立一个单调时钟。
 * @param {object} [opts]
 * @param {() => number} [opts.wallNow] 墙上时钟读数（默认 Date.now；注入仅用于单测/诊断）
 * @param {() => number} [opts.monoNow] 单调计时器读数（默认 performance.now；注入仅用于单测）
 * @returns {{ now: () => number, driftMs: () => number, anchorWall: number, anchorMono: number }}
 *   `now()` 单调不减、整数毫秒、与 Date.now() 同口径；`driftMs()` 是**诊断**读数
 *   （正 = 墙钟领先，例如向前跳已被忽略；负 = 墙钟落后），不参与任何判断。
 */
export function createClock({ wallNow = wallClock, monoNow = monoClock } = {}) {
  const anchorWall = Math.floor(finite(wallNow(), Date.now()));
  const anchorMono = finite(monoNow(), monoClock());
  let last = anchorWall;
  return {
    now() {
      const mono = finite(monoNow(), anchorMono);
      const elapsed = mono - anchorMono;
      // 取历史最大值 ⇒ 单调不减：墙钟跳变与单调读数抖动都无法让它回退或前跳
      const projected = Math.floor(anchorWall + (elapsed > 0 ? elapsed : 0));
      if (projected > last) last = projected;
      return last;
    },
    driftMs() {
      return Math.floor(finite(wallNow(), anchorWall)) - last;
    },
    anchorWall,
    anchorMono,
  };
}

/** 进程级时钟：在模块首次求值时建立基准（≈ 进程启动/首次使用时刻） */
export const processClock = createClock();

/**
 * 本次运行的标识（随机 uuid，进程内恒定）。
 *
 * 用途：单调读数只有**在同一次运行内**才可比。把「下单时的单调读数」落库后，清扫器必须先知道
 * 这一行是不是本次运行写的——`created_boot === bootId` 才敢用单调年龄，否则退回墙钟比较
 * （见 `src/orderSweeper.js` 与 `orders.created_boot/created_mono` 的列说明）。
 */
export const bootId = randomUUID();

/** 进程级单调「当前时刻」（毫秒，与 Date.now() 同口径）——业务超时判据统一用它 */
export function monotonicNow() {
  return processClock.now();
}
