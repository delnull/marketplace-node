/**
 * 托管合约地址的**启动锚点**（源码评审 2026-09，P0 的运行时那一半）。
 *
 * 为什么需要它：订单行只存 `escrow_order_id`（`db.js` 不存合约地址），节点只认单一
 * `MK_ESCROW_ADDRESS`。于是把 env 改成**另一个** Escrow 时，本地那些指向旧合约的订单
 * 不会报错、也不会被清理——它们只是永远查不到（`chainReconcile` 会告警 `order.chain_missing`
 * 但不改状态），店主看到的是"待发货"、买家看到的是"待收货"，而钱在旧合约里。
 * 合约不可升级（无代理）、`Registry` 又把 canonical 地址与字节码哈希钉成 immutable，
 * 所以"换址"从来不是无害操作：它意味着旧实例里的在途单只能靠双方在旧合约上自行了结。
 *
 * 本模块把这件事变成**启动期可见的判定**：
 *   · 首次启动：把地址记进 kv（不用迁移框架，见 DECISIONS「不留兼容垫片」）；
 *   · 地址没变：什么都不做（正常路径）；
 *   · 地址变了且**本地没有在途链上单**：记新地址 + 大声告警（可以继续启动）；
 *   · 地址变了且**本地还有在途链上单**：默认**拒绝启动**，除非显式 `MK_ESCROW_CHANGE_ACK=1`
 *     （处置步骤写在报错里：先在旧合约上了结这些单，再重建库/换地址）。
 *
 * 判据本体是纯函数 `anchorVerdict`（有单测）；读库/写 kv 的接线很薄。
 * 本项目为 greenfield（数据可弃、库可重建），所以"拒绝启动"的代价是几分钟，
 * 而它拦住的是"以为换了个地址就完事、其实一批在途单再也没人管"。
 */
import { getDb, kvGet, kvSet } from './db.js';
import { ACTIVE_IN } from './orderStatus.js';

/** kv 键：上次启动时用的托管合约地址（小写） */
const KEY = 'mk:escrow_address';

/** 本地还有多少**链上已有单**的在途订单（这些单的托管资金在当时的那个合约实例上） */
export function inflightChainOrders() {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM orders WHERE escrow_order_id IS NOT NULL AND status IN ${ACTIVE_IN}`
    )
    .get().c;
}

/**
 * 纯决策：给定 env 地址、上次记录的地址、在途链上单数与显式确认开关，返回该做什么。
 * @returns {{level:'skip'|'record'|'ok'|'warn'|'ack'|'refuse', ok:boolean, action:'none'|'record', reason:string}}
 */
export function anchorVerdict({ envAddress = '', storedAddress = '', inflightCount = 0, ack = false } = {}) {
  const env = String(envAddress || '').trim().toLowerCase();
  const stored = String(storedAddress || '').trim().toLowerCase();
  if (!env) {
    return { level: 'skip', ok: true, action: 'none', reason: '未配置 MK_ESCROW_ADDRESS：无链上托管（仅展示模式），不做地址锚定' };
  }
  if (!stored) {
    return { level: 'record', ok: true, action: 'record', reason: `首次记录托管合约地址 ${env}` };
  }
  if (env === stored) {
    return { level: 'ok', ok: true, action: 'none', reason: `托管合约地址未变（${env}）` };
  }
  const n = Number(inflightCount) || 0;
  if (n > 0 && !ack) {
    return {
      level: 'refuse',
      ok: false,
      action: 'none',
      reason:
        `MK_ESCROW_ADDRESS 从 ${stored} 改成了 ${env}，而本地还有 ${n} 笔**已上链的在途订单**（escrowed/shipped/disputed）。\n` +
        '  这些单的托管资金在**旧合约实例**上：换个地址后它们查不到、也对不了账，店主会一直看到"待发货"。\n' +
        '  处置（任选其一）：\n' +
        '   ① 先把旧实例上的这些单了结（确认收货 / 退款 / 争议裁决 / 超时释放），再改地址；\n' +
        '   ② 本项目为 greenfield：确认这批数据可弃 ⇒ **重建节点库**（删掉 db 文件后重启，节点会重新记录新地址）；\n' +
        '   ③ 确实知道后果仍要继续 ⇒ 显式设 MK_ESCROW_CHANGE_ACK=1 再启动（本次会记下新地址）。',
    };
  }
  if (n > 0) {
    return {
      level: 'ack',
      ok: true,
      action: 'record',
      reason: `MK_ESCROW_CHANGE_ACK=1：明知有 ${n} 笔在途链上单仍改址为 ${env}（旧实例上的单需人工了结）`,
    };
  }
  return {
    level: 'warn',
    ok: true,
    action: 'record',
    reason: `MK_ESCROW_ADDRESS 从 ${stored} 改为 ${env}（本地没有在途链上单，已记下新地址）`,
  };
}

/** 最近一次锚定判定的结果（供 /healthz 与排查；进程内状态） */
let lastAnchor = { at: null, level: null, reason: null, address: null, previous: null, inflight: 0 };

/** 启动期执行锚定：读 kv → 判定 → 必要时写回。返回判定结果（不自己退出，由调用方决定） */
export function applyEscrowAnchor({ envAddress, ack = false } = {}) {
  const stored = kvGet(KEY, '') || '';
  const inflight = envAddress ? inflightChainOrders() : 0;
  const verdict = anchorVerdict({ envAddress, storedAddress: stored, inflightCount: inflight, ack });
  if (verdict.action === 'record') kvSet(KEY, String(envAddress).trim().toLowerCase());
  lastAnchor = {
    at: Date.now(),
    level: verdict.level,
    reason: verdict.reason,
    address: verdict.action === 'record' ? String(envAddress).trim().toLowerCase() : stored || null,
    previous: stored || null,
    inflight,
  };
  return { ...verdict, previous: stored || null, inflight };
}

/** /healthz 用的锚点状态（如实反映"这次的判定是什么"） */
export function escrowAnchorStatus() {
  return { ...lastAnchor };
}
