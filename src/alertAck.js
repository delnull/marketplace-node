/**
 * 一次性告警的「**投递成功才落幂等标记**」（2026-09 修复）——唯一实现。
 *
 * 问题：poolAlert 的 `order.pool_empty`、chainReconcile 的 `order.chain_missing` /
 * `order.chain_repaired`、escrowWatcher 的 `order.hold_missing` 三条告警原来都是
 * 「先 `kvSet(ackKey,'1')` 写幂等标记，再 `notifyRaw(...)`（fire-and-forget）」。
 * 投递一失败（URL 写错、被 SSRF 拦下、店主服务器 5xx、超时）标记却已经写死，
 * 于是**永久不再重试**——而这三条恰恰是"钱已经收了但货发不出""超卖需核账""链上查不到该单"，
 * 是店主必须至少收到一次的东西。静默丢失比不告警更糟：店主以为自己没有待办。
 *
 * 修法：标记只在 webhook.deliver 的**最终结算为 true**（对方确实收到）后写入；
 * 未配置 URL（deliver 返回 false）或两次内存重试耗尽（false）⇒ **不写标记**，下一次复查
 * （下一轮轮询 / 下一轮对账 / 事件重放）自然再投一次——这就是 at-least-once。
 *
 * 两条不变量：
 *  - **不阻塞调用方**：`alertPoolEmptyForOrder` 在 HTTP 请求处理链上（POST /:id/paid），
 *    await 投递会把响应拖到对方服务器应答为止，所以这里立即返回，标记在后台 `.then` 里落库；
 *    返回的布尔值语义是"本次是否已发起告警"（是否真送达看返回值之后的日志/kv 标记）。
 *  - **同进程内不重复推**：同一 ackKey 在投递尚未结算期间的再次调用（paid 快路径与 watcher
 *    事件同一单会同时触发）由内存 pending 集合挡住；结算（成功/失败）后即放开——失败路径
 *    要允许下次重试，这正是本模块的目的。
 */
import { kvGet, kvSet } from './db.js';

/** 投递结算前已发起的告警键（进程内；重启即空——重启后按 kv 标记判断） */
const pending = new Set();

/**
 * 一次性告警：投递成功才写 kv 幂等标记。
 * @param {object} o
 * @param {string} o.ackKey kv 幂等键（已告警过 = 值为 '1'）
 * @param {() => Promise<boolean>} o.send 投递函数（webhook.notifyRaw 的返回值；true = 对方已收到）
 * @param {string} [o.label] 日志前缀（如 '[poolAlert]'）
 * @param {string} [o.what] 日志里的对象说明（如 '（order=ab12cd34…）'）
 * @returns {boolean} 本次是否已发起告警（false = 已告警过 / 正在投递中 / 投递无法发起）
 */
export function alertOnceDelivered({ ackKey, send, label = '[alert]', what = '' }) {
  try {
    if (kvGet(ackKey, '') === '1') return false; // 已成功告警过：不重复推（池空/超卖都是持续状态）
  } catch (e) {
    // 读不到标记（无库）：按"未告警过"继续，宁可多推一次也不静默丢失
    console.error(`${label} 读取告警标记失败，按未告警处理${what}：`, e?.message || e);
  }
  if (pending.has(ackKey)) return false; // 投递未结算：同一单的并发/重入不再推一条
  pending.add(ackKey);
  const release = () => pending.delete(ackKey);

  let sent;
  try {
    sent = send();
  } catch (e) {
    release();
    console.error(`${label} 告警发送异常（未写幂等标记，下次复查会重试）${what}：`, e?.message || e);
    return false;
  }
  Promise.resolve(sent)
    .then((ok) => {
      if (!ok) {
        // 未配置通知地址，或重试耗尽：**不写标记**，下一轮复查再投（at-least-once）
        console.warn(`${label} 告警未送达（未配置通知地址或重试后仍失败）${what}——不写幂等标记，下次复查会重试`);
        return;
      }
      try {
        kvSet(ackKey, '1');
      } catch (e) {
        // 标记写失败：下次复查会再推一次（重复告警可接受，静默丢失不可接受）
        console.error(`${label} 告警标记写入失败（下次复查可能重复告警）${what}：`, e?.message || e);
        return;
      }
      console.warn(`${label} 已告警店主${what}`);
    })
    .catch((e) => {
      console.error(`${label} 告警投递异常（未写幂等标记，下次复查会重试）${what}：`, e?.message || e);
    })
    .finally(release);
  return true;
}
