/**
 * 提货争议的链上终态对账（周期任务）。
 *
 * 为什么需要它：`ClaimClosed` 是零赔付结案的唯一事件；如果 watcher 漏扫/进程在
 * `ClaimDisputeOpened` 与 `ClaimClosed` 之间退出，本地 `nft_claims` 会停在 opened，
 * `uq_claims_active_token` 继续占槽，后来持有人永远无法再声明。`ClaimPaid` 已在
 * escrowWatcher 里自愈“有赔付”的路径；本模块只补零赔付：
 *
 *   链上 `claimCase.closed` + `claimPaidByOrder` 仍等于开案快照
 *   ⇒ 本次争议没有产生任何提货赔付
 *   ⇒ 本地置 rejected/closed，释放声明槽。
 *
 * 为什么必须比较 `claimPaidByOrder` 而不是只看 `closed`：`closed` 也可能是已赔付；
 * 若把已赔付误判成 rejected，会释放 active-token 槽，新的持有人可再次开案，存在二次赔付。
 * 快照 `claim_paid_at_open` 在开案参数生成时写入（事件到达时会用当前本地镜像刷新），
 * 所以“链上累计仍等于开案前”是零赔付的充分条件；若链上更大则可能是本 claim 已赔付，
 * 也可能是别的 claim 的累计，宁可保持 opened 等 ClaimPaid 事件/人工处理，绝不自作主张释放。
 *
 * **两次读数必须固定在同一高度**：`claimCase` 与 `claimPaidByOrder` 都是独立 eth_call，
 * 不固定 blockTag 时负载均衡 RPC / 重组可能让“closed=true”与“尚未赔付”来自不同高度，
 * 从而把已赔付误判为零赔付。这里先解析一个 finalized 高度，两次调用都带同一个数值 blockTag。
 *
 * 代价：`ClaimPaid` 与 `ClaimClosed` 都漏扫、且链上确实有赔付时，本模块不会释放槽位
 * （保守方向正确）；需要事件重放/人工核对，但不会造成二次赔付。
 *
 * ## "零赔付结案"有两种，不能写成同一种
 *
 * `claimCase.closed` 只说明"结了"，结的方式有两个：委员会票决判店主无责（`ClaimClosed(0)`），
 * 或节点主撤销了争议（`ClaimDisputeCancelled`）。**两种的本地终态不同**：前者是
 * `rejected/closed`（判店主无责），后者是 `cancelled/cancelled`（双方和解、不是判决）。
 * 只看 `closed + 零赔付` 会把撤销写成"判店主无责"（演示栈实际撞到过：watcher 还没消费
 * 撤销事件，这一轮先把它写成了 rejected）。所以本函数每轮先扫一次 `ClaimDisputeCancelled`
 * 日志，按**撤销证据**决定写哪一种；日志读不到就推迟本轮，不猜。
 */
import config from './config.js';
import { getDb } from './db.js';
import { getEscrow, finalizedBlockNumber } from './chain.js';
import { withRedisLock } from './redis.js';
import { expireOverdueClaims } from './nftClaim.js';

/** 间隔可配（`MK_CLAIM_RECONCILE_MS`）：演示栈要它几秒一轮才能当场看到"窗口已过→expired" */
const INTERVAL_MS = config.claimReconcile.intervalMs;
const MIN_AGE_MS = 60_000;
const LIMIT = 20;
const RPC_TIMEOUT_MS = 15_000;

/**
 * 每轮从上次的 id 之后继续，而不是永远取 `id ASC LIMIT 20`。
 * 链上仍 open（claim 截止最长 90 天）或尚未广播的行会一直满足条件；固定取前 20
 * 会让第 21 条以后的行永远轮不到——那正是“永久占槽”要治的病。
 */
let cursor = 0;

function bigintOf(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  try {
    return BigInt(String(v));
  } catch {
    return null;
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`claimReconcile RPC timeout > ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

let claimScanWarned = false;

/** 起点未配置时只提示一次（每轮都喊会把日志刷满） */
function claimScanWarnOnce() {
  if (claimScanWarned) return;
  claimScanWarned = true;
  console.warn(
    '[claimReconcile] 未配置 MK_ESCROW_START_BLOCK：无法用有界范围证明"没有撤销事件"，' +
      '零赔付结案只走事件路径（本地槽位暂不释放）。要恢复兜底，把它设成节点部署块。'
  );
}

/**
 * 本轮"链上撤销过"的 claimId 集合（`ClaimDisputeCancelled` 日志）。
 *
 * 每轮只扫一次、只读这一个事件的 topic：候选行每轮至多 20 条，逐行查日志会把 RPC 次数
 * 放大 20 倍。起点取 `MK_ESCROW_START_BLOCK`（节点自己的部署块），与 watcher 的扫描面一致。
 *
 * 读失败**抛错**：调用方据此推迟本轮，而不是把"没读到撤销证据"当成"确实不是撤销"。
 */
async function readCancelledClaimIds(chain, toBlock, fromBlock) {
  const logs = await withTimeout(
    chain.queryFilter(chain.filters.ClaimDisputeCancelled(), fromBlock, toBlock),
    RPC_TIMEOUT_MS
  );
  const ids = new Set();
  for (const log of logs) {
    const id = String(log?.args?.[0] ?? '').toLowerCase();
    if (/^0x[0-9a-f]{64}$/.test(id)) ids.add(id);
  }
  return ids;
}

async function selectBatch(db, afterId, cutoff, limit) {
  return await db.all(
    `SELECT n.id, n.dispute_claim_id, n.order_id, n.claim_paid_at_open,
            oc.escrow_order_id AS escrowOrderId
       FROM nft_claims n
       LEFT JOIN order_chain oc ON oc.order_id = n.order_id
      WHERE n.dispute_claim_id IS NOT NULL
        AND n.dispute_state IN ('none','opened')
        AND n.status IN ('requested','approved','shipped')
        AND (n.dispute_opened_at IS NULL OR n.dispute_opened_at <= ?)
        AND n.id > ?
      ORDER BY n.id ASC
      LIMIT ?`,
    cutoff,
    afterId,
    limit
  );
}

/**
 * 对一批本地未结/待开案的 claim 做一次链上终态核对。
 * 导出供周期任务与单测使用；传入 escrow 可替换链上读数，blockTag 可让测试跳过 RPC head。
 *
 * @param {{escrow?: object, now?: number, limit?: number, minAgeMs?: number, blockTag?: number|string}} [opts]
 * @returns {Promise<{checked:number, closed:number, unreadable:number, missingSnapshot:number}>}
 */
export async function reconcileClaims({
  escrow = null,
  now = Date.now(),
  limit = LIMIT,
  minAgeMs = MIN_AGE_MS,
  blockTag = null,
} = {}) {
  const db = getDb();
  /* 先清过期的未处理声明：纯本地状态、不依赖链上读数；失败不阻断下面的链上对账 */
  try {
    await expireOverdueClaims({ now });
  } catch (e) {
    console.error(`[claimReconcile] 过期提货声明标记失败：${e?.message || e}`);
  }
  const cutoff = new Date(now - minAgeMs);
  const take = Math.max(1, Math.min(200, Number(limit) || LIMIT));
  let rows = await selectBatch(db, cursor, cutoff, take);
  if (!rows.length && cursor !== 0) {
    cursor = 0;
    rows = await selectBatch(db, 0, cutoff, take);
  }
  if (!rows.length) return { checked: 0, closed: 0, unreadable: 0, missingSnapshot: 0 };
  cursor = rows[rows.length - 1].id;

  const chain = escrow || getEscrow();
  const pinned = blockTag ?? (await finalizedBlockNumber());
  const overrides = { blockTag: pinned };
  /*
    撤销证据（本轮只需一份）：`queryFilter` 只有真合约才有——注入的 escrow（单测的替身）没有事件能力，
    那种情况下按老判据走（把它们当"判店主无责"），不把"替身不支持"误解成"链上读不到"。

    扫描起点必须是**有界**的：`MK_ESCROW_START_BLOCK`（节点自己的部署块）。
    起点为 0 表示"没有配置"，此时**不猜**——扫全史会被 RPC 按范围拒绝/超时，而"没扫到撤销"
    与"确实不是撤销"在没有证据时不可区分；这种部署只让事件路径写终态（槽位暂不释放，游标回放会补）。
  */
  let cancelledIds = null;
  let cancelScanFailed = false;
  const logScanFrom = Number(config.escrow.startBlock || 0);
  if (typeof chain.queryFilter === 'function' && typeof chain.filters?.ClaimDisputeCancelled === 'function') {
    if (logScanFrom <= 0) {
      cancelScanFailed = true;
      claimScanWarnOnce();
    } else {
      try {
        cancelledIds = await readCancelledClaimIds(chain, pinned, logScanFrom);
      } catch (e) {
        cancelScanFailed = true;
        console.warn(`[claimReconcile] 本轮读不到撤销事件（零赔付结案推迟到下一轮）：${e?.message || e}`);
      }
    }
  }
  let closed = 0;
  let unreadable = 0;
  let missingSnapshot = 0;
  for (const row of rows) {
    const snapshot = bigintOf(row.claim_paid_at_open);
    if (snapshot === null) {
      // 旧列没有历史值，无法证明“开案前累计 = 0”；不猜、不释放，只计数暴露给运维。
      missingSnapshot += 1;
      continue;
    }
    try {
      const caseInfo = await withTimeout(chain.claimCase(row.dispute_claim_id, overrides), RPC_TIMEOUT_MS);
      if (!caseInfo?.closed) continue;
      if (
        !row.escrowOrderId ||
        String(caseInfo.orderId || '').toLowerCase() !== String(row.escrowOrderId).toLowerCase()
      ) {
        // chain 返回的订单与本地 claim 不指向同一单：中间状态，不做终态写入。
        unreadable += 1;
        continue;
      }
      const chainPaid = bigintOf(
        await withTimeout(chain.claimPaidByOrder(caseInfo.orderId, overrides), RPC_TIMEOUT_MS)
      );
      if (chainPaid === null || chainPaid !== snapshot) continue;

      /*
        零赔付结案有两种（见文件头）：判店主无责 → rejected/closed；节点主撤销 → cancelled/cancelled。
        撤销证据只在事件里（合约只留 closed 一个布尔），所以这里按 claimId 查本轮的撤销集合。
        读不到撤销集合（cancelScanFailed）就**推迟**：写错一种就再也改不回来（终态）。
      */
      const wasCancelled = cancelledIds ? cancelledIds.has(String(row.dispute_claim_id).toLowerCase()) : false;
      if (!wasCancelled && cancelScanFailed) {
        unreadable += 1;
        continue;
      }
      const changed = wasCancelled
        ? (await db.run(
            `UPDATE nft_claims
                SET status = 'cancelled',
                    dispute_state = 'cancelled',
                    dispute_closed_at = CURRENT_TIMESTAMP(3),
                    claim_amount_wei = NULL
              WHERE id = ?
                AND dispute_state IN ('none','opened')
                AND status IN ('requested','approved','shipped')`,
            row.id
          )).foundRows
        : (await db.run(
            `UPDATE nft_claims
                SET status = 'rejected',
                    dispute_state = 'closed',
                    dispute_closed_at = CURRENT_TIMESTAMP(3),
                    claim_amount_wei = NULL
              WHERE id = ?
                AND dispute_state IN ('none','opened')
                AND status IN ('requested','approved','shipped')`,
            row.id
          )).foundRows;
      if (changed > 0) closed += 1;
    } catch {
      // 单条读不到/链上暂时异常：保持本地原状，下一轮再试；不把异常解读成零赔付
      unreadable += 1;
    }
  }
  return { checked: rows.length, closed, unreadable, missingSnapshot };
}

/** 启动周期核对（失败只告警，不影响主流程）。 */
export function startClaimReconciler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!config.chain.escrowAddress) return;
      const run = await withRedisLock('claim-reconcile', 60_000, () => reconcileClaims(), { renewMs: 20_000 });
      if (!run.acquired) return;
      const r = run.value;
      if (r.closed || r.unreadable || r.missingSnapshot) {
        console.log(
          `[claimReconcile] checked=${r.checked} closed=${r.closed} unreadable=${r.unreadable} missingSnapshot=${r.missingSnapshot}`
        );
      }
    } catch (e) {
      console.error('[claimReconcile] 本轮核对异常（下轮重试）:', e?.shortMessage || e?.message || e);
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
