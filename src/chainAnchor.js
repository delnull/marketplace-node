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
 *   · 首次启动：把地址记进 `node.escrow_address`（单例行，由 db.js 的 initDb() 在启动时建立）；
 *   · 地址没变：什么都不做（正常路径）；
 *   · 地址变了且**本地没有在途链上单**：记新地址 + 大声告警（可以继续启动）；
 *   · 地址变了且**本地还有在途链上单**：默认**拒绝启动**，除非显式 `MK_ESCROW_CHANGE_ACK=1`
 *     （处置步骤写在报错里：先在旧合约上了结这些单，再重建库/换地址）。
 *
 * 判据本体是纯函数 `anchorVerdict`（有单测）；读库/写 `node` 那一行的接线很薄。
 * 本项目为 greenfield（数据可弃、库可重建），所以"拒绝启动"的代价是几分钟，
 * 而它拦住的是"以为换了个地址就完事、其实一批在途单再也没人管"。
 *
 * ⚠️ 地址锚的**家变了**（2026-10 MySQL 重设计）：旧形状存在 kv（`mk:escrow_address`），
 * 现在是 `node` 单例行的 `escrow_address` 列——节点自身的几个已知单例（合约地址锚、两个轮询
 * 游标、隔离事件清单）各有带类型的列，不再塞进一张键值表。行的**建立**只有一处
 * （`db.js` 的 `initDb()` → `ensureNodeRow()`）；本模块只读它、只写这一列，
 * 行不存在时**如实返回"拒绝"**而不是假装记下了地址（"记不下"与"记下了"在链上后果完全不同）。
 */
import { getDb } from './db.js';
// node 单例行的唯一读入口（行由 db.js 的 initDb() 在启动期建立）
import { nodeRow } from './shops.js';
import { ACTIVE_IN } from './orderStatus.js';

/** 本地还有多少**链上已有单**的在途订单（这些单的托管资金在当时的那个合约实例上） */
export async function inflightChainOrders() {
  /*
    链上单号住在 `order_chain`（1:1 子表），`orders` 表里已经没有这一列——
    所以"这一单有没有上链"只能靠 JOIN 子表来问。INNER JOIN 即"有链上镜像行"，
    而 `order_chain.escrow_order_id` 是 NOT NULL 的（草稿期就生成，见 routes/orders.js），
    所以这里不需要再叠一个 `IS NOT NULL` 谓词。
  */
  const row = await getDb().get(
    `SELECT COUNT(*) AS c FROM orders o JOIN order_chain c ON c.order_id = o.id WHERE o.status IN ${ACTIVE_IN}`
  );
  return Number(row?.c) || 0;
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
        '   ② 本项目为 greenfield：确认这批数据可弃 ⇒ **重建节点库**（DROP DATABASE 后重启，节点会重新记录新地址）；\n' +
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

/**
 * 启动期执行锚定：读 `node.escrow_address` → 判定 → 必要时写回。返回判定结果（不自己退出，由调用方决定）
 *
 * ⚠️ **必须 await**（2026-10 MySQL 迁移）：读库与在途单计数都是异步调用。旧实现下
 * （SQLite 同步执行）这三步是同步的，照抄下来会得到 `stored = Promise`、`inflight = Promise`：
 *   · `String(promise)` 恒为 `"[object Promise]"` ⇒ 每次启动都判定成"**换址**"（warn），
 *     于是首次启动记不进锚点、也没人能拿它比对；
 *   · `inflightCount` 是 Promise，`Number(Promise)` = NaN ⇒ `n > 0` 恒 false ⇒
 *     **有在途单时的"拒绝启动"这道闸整段失效**，真正的换址会被静默接受。
 * 调用方（server.js）同样必须 await，否则 `anchor.ok` 读的是 Promise（恒真），
 * `process.exit(1)` 那条分支永远走不到。
 */
export async function applyEscrowAnchor({ envAddress, ack = false } = {}) {
  const row = await nodeRow();
  /*
    `node` 单例行不存在 ⇒ **拒绝**（不是"当作首次记录"）：这一行的 `owner` 是 NOT NULL，
    db.js 的 `initDb()` 本该已经建立它（`ensureNodeRow()`，`MK_SHOP_OWNER` 缺失时直接拒绝启动）。
    少了它，下面那条 `UPDATE … WHERE id = 1` 会命中 0 行——而"命中 0 行"与"记下了"在返回值上同形，
    现象是每次启动都判成"首次记录"、地址锚永远没有值（换址门禁随之整段失效）。
    所以这里把"行不存在"当成判定结果说出来，由 server.js 拒绝启动。
  */
  if (!row) {
    const reason =
      'node 单例行（id=1）不存在：合约地址锚没有地方记账（链上事件游标也一样）。' +
      '处置：确认 MK_SHOP_OWNER 已配置（db.js 的 initDb() 会据此建立这一行），再重启。';
    lastAnchor = { at: Date.now(), level: 'refuse', reason, address: null, previous: null, inflight: 0 };
    return { level: 'refuse', ok: false, action: 'none', reason, previous: null, inflight: 0 };
  }
  const stored = row.escrow_address ? String(row.escrow_address).trim().toLowerCase() : '';
  const env = String(envAddress || '').trim().toLowerCase();
  const inflight = env ? await inflightChainOrders() : 0;
  const verdict = anchorVerdict({ envAddress, storedAddress: stored, inflightCount: inflight, ack });
  if (verdict.action === 'record') {
    // `updated_at` 由**服务器**盖章（不接应用端时钟，见 db.js 的时间口径）
    const r = await getDb().run(
      'UPDATE node SET escrow_address = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1',
      env
    );
    if (r.changes !== 1) {
      // 行在上面读过、这里却写不到：只可能是并发删库/清表。响亮失败，不留"以为记下了"的假象。
      throw new Error('写入 node.escrow_address 未命中任何行（node 单例行在读与写之间消失了）');
    }
  }
  lastAnchor = {
    at: Date.now(),
    level: verdict.level,
    reason: verdict.reason,
    address: verdict.action === 'record' ? env : stored || null,
    previous: stored || null,
    inflight,
  };
  return { ...verdict, previous: stored || null, inflight };
}

/** /healthz 用的锚点状态（如实反映"这次的判定是什么"） */
export function escrowAnchorStatus() {
  return { ...lastAnchor };
}
