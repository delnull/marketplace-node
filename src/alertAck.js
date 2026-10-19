/**
 * 一次性告警的「**投递成功才留下幂等标记**」——唯一实现。
 *
 * 问题：poolAlert 的 `order.pool_empty`、chainReconcile 的 `order.chain_missing`、
 * escrowWatcher 的 `order.hold_missing` 三条告警原先都是「先写幂等标记，再 `notifyRaw(...)`
 * （fire-and-forget）」。投递一失败（URL 写错、被 SSRF 拦下、店主服务器 5xx、超时）标记却已经写死，
 * 于是**永久不再重试**——而这三条恰恰是"钱已经收了但货发不出""超卖需核账""链上查不到该单"，
 * 是店主必须至少收到一次的东西。静默丢失比不告警更糟：店主以为自己没有待办。
 *
 * ## 去重就是**一条 INSERT 的成败**（2026-10 MySQL 重设计）
 *
 * 旧形状是 kv 里的 `mk:xxx:<orderId> = '1'` 加一个进程内 Set：判"告警过没有"要**先读再写**，
 * 两次调用之间的窗口要靠调用点自己堵。现在 `order_alerts(order_id, kind)` 的主键
 * 就是那条判据：
 *   · `INSERT INTO order_alerts (order_id, kind) VALUES (?, ?)` 成功 ⇒ **本次由我投递**（预占）；
 *   · 报 `ER_DUP_ENTRY` ⇒ 已经告过（或正在投递中）⇒ 不重复推；
 *   · 投递结算为**失败** ⇒ 把这行**删掉**，下一轮复查自然重投（at-least-once）；
 *   · 投递成功 ⇒ 记下交付时刻（`sent_at`）。
 *
 * 为什么是"先预占、失败再释放"，而不是"投递成功后再 INSERT"：后者要靠调用点先查一次
 * （读-写窗口回来了），而**行在不在**恰好是"有没有送达过"的唯一形状——`sent_at` 只在真的
 * 送出去之后才被改写。两条不变量与旧实现逐字一致：
 *   · **不阻塞调用方**：本函数在 HTTP 请求链上（POST /:id/paid）；`send()` 的投递不 await
 *     （它在后台 `.then` 里结算），返回值语义是"本次是否已发起告警"。
 *   · **同进程/跨路径不重复推**：预占行对所有调用方可见（paid 快路径与 watcher 事件对同一单
 *     会同时触发），失败释放后允许重试——这正是本模块的目的。
 *
 * 代价（如实写）：预占到投递结算之间进程崩掉，会留下一条"已告警"的行，那条告警不再重发。
 * 窗口是一次 webhook 投递（含 2 次重试，默认 ≤ 十几秒），而旧形状的代价是**每一个调用点**
 * 都要先读一次标记、且并发调用之间仍然可能都读到"没告过"。单进程设计（db.js 的实例独占锁）
 * 让"跨进程抢同一条告警"不可表达，这也是能把去重完全交给主键的前提。
 */
import { getDb } from './db.js';

/**
 * 可告警的三类**持续状态**（与 `order_alerts.kind` 的 ENUM 逐字同源）。
 *
 * 为什么只有三种：这一列回答的是"这条**持续存在**的待办有没有告诉过店主"——
 * 池子空了、链上查不到、占位补不回来都会每轮复查命中同一个条件，所以必须有去重行。
 * 一次性通知（如"已按链上真值修好某单"）天然不会重复（条件在修复后不再成立），
 * 不走本模块（见 chainReconcile 里那两处 `notifyRaw` 的说明）。
 */
export const ALERT_KINDS = Object.freeze(['pool_empty', 'chain_missing', 'hold_missing']);

/** 主键冲突（MySQL 1062）= 已经告过：这是**判据**，不是异常路径 */
function isDuplicate(e) {
  return String(e?.code || '') === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(String(e?.message || ''));
}

/**
 * 一次性告警：投递成功才留下幂等标记。
 *
 * **本函数是 async，而它返回得早**：预占（那条 INSERT）必须 await——它是去重判据本体，
 * 不 await 的话两次调用会各自以为自己是第一个；而 `send()` 的投递**不** await
 * （见文件头的不变量一：它可能在 HTTP 请求链上）。
 * @param {object} o
 * @param {number} o.orderId 本地订单**内部键**（`orders.id` / `v_orders.order_id`；
 *        `order_alerts.order_id` 是外键指向它，不是订单号也不是链上单号）
 * @param {'pool_empty'|'chain_missing'|'hold_missing'} o.kind 告警种类（持续状态，见 ALERT_KINDS）
 * @param {() => Promise<boolean>} o.send 投递函数（webhook.notifyRaw 的返回值；true = 对方已收到）
 * @param {string} [o.label] 日志前缀（如 '[poolAlert]'）
 * @param {string} [o.what] 日志里的对象说明（如 '（order=B…）'）
 * @returns {Promise<boolean>} 本次是否已发起告警（false = 已告过 / 正在投递中 / 投递无法发起）
 */
export async function alertOnceDelivered({ orderId, kind, send, label = '[alert]', what = '' }) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    // 传进来的不是内部键（例如误传订单号或链上单号）：说清楚而不是静默不告警
    throw new Error(`${label} 告警需要订单内部键（orders.id），收到 ${JSON.stringify(orderId)}`);
  }
  if (!ALERT_KINDS.includes(kind)) {
    throw new Error(`${label} 未知的告警种类 ${JSON.stringify(kind)}（order_alerts.kind 只接受 ${ALERT_KINDS.join('/')}）`);
  }
  const db = getDb();
  try {
    // 去重：一条 INSERT。`sent_at` 由服务器盖章（预占时刻），成功投递后再改写成交付时刻。
    await db.run('INSERT INTO order_alerts (order_id, kind) VALUES (?, ?)', id, kind);
  } catch (e) {
    if (isDuplicate(e)) return false; // 已经告过（或正在投递中）：不重复推
    /*
      其它错误（外键：订单不存在）**不吞**：那是调用方把 id 传错了，
      折成 false 会让"告警从来没发出去"看起来像"已经告过了"。
    */
    throw e;
  }

  const release = async () => {
    try {
      await db.run('DELETE FROM order_alerts WHERE order_id = ? AND kind = ?', id, kind);
    } catch (e) {
      // 释放失败 ⇒ 这一行会挡住重试（静默丢失）。响亮报出来，让人能手工删那一行。
      console.error(`${label} 告警预占释放失败（${kind}）${what}：`, e?.message || e);
    }
  };

  let sent;
  try {
    sent = send();
  } catch (e) {
    await release();
    console.error(`${label} 告警发送异常（已释放预占，下次复查会重试）${what}：`, e?.message || e);
    return false;
  }
  Promise.resolve(sent)
    .then(async (ok) => {
      if (!ok) {
        // 未配置通知地址，或重试耗尽：**释放预占**，下一轮复查再投（at-least-once）
        await release();
        console.warn(`${label} 告警未送达（未配置通知地址或重试后仍失败）${what}——已释放预占，下次复查会重试`);
        return;
      }
      try {
        /*
          送达时刻由**服务器**盖章（`CURRENT_TIMESTAMP(3)`），不接应用端时钟：
          这一列是"这条告警是什么时候真的送出去的"的唯一落点，而节点时钟偏了不该写进库里
          （会话时区已在 db.js 钉成 '+00:00'，两端的口径一致）。
        */
        await db.run('UPDATE order_alerts SET sent_at = CURRENT_TIMESTAMP(3) WHERE order_id = ? AND kind = ?', id, kind);
      } catch (e) {
        // 只影响这一行的"送达时刻"读数（行本身已在，去重仍然成立）；不改变"已告警"这个事实
        console.error(`${label} 告警送达时刻写入失败（告警已发出，去重行仍在）${what}：`, e?.message || e);
      }
      console.warn(`${label} 已告警店主${what}`);
    })
    .catch(async (e) => {
      await release();
      console.error(`${label} 告警投递异常（已释放预占，下次复查会重试）${what}：`, e?.message || e);
    });
  return true;
}
