/**
 * 订单事实的**共用判据**（跨读数模块的唯一实现）。
 *
 * 为什么单开一个模块：同一件事——"这一单有没有发生过争议"——在两个对外读数里各写过一遍，
 * 而两处**判据不同**（公开画像只认 `DisputeRequested` 事件，买家信号认"状态 ∨ 事件"），
 * 于是同一批订单在同一时刻给出两个答案（2026-10-15 审计实测：7 张 `status='disputed'` 的单，
 * 公开画像印「争议率 0%」，而买家信号印「争议 7 单」）。判据散开的典型后果就是这种自相矛盾。
 *
 * 判据本身（三个来源的并集，任一条成立即"发生过争议"）：
 *   ① 当前镜像 `status === 'disputed'` —— 争议**还在进行**的单；
 *   ② 事件史里有 `DisputeRequested` —— 争议发生过、但可能已经终局（镜像已推进到 settled/refunded）；
 *   ③ 事件史里有 `Arbitrated` —— 链上 `voteSettlement` 票决的前置就是 `Disputed`，所以它同样证明争议发生过。
 * ②③ 是针对**镜像会推进**这件事：`status` 只说"此刻还在争议"，而画像要回答的是"这一单争过没有"。
 *
 * ⚠️ 事件史只有最近 20 条（`onchain_events` 的 `slice(-20)`），可重复事件（如
 * `PartialRefundAccepted`）能把老事件挤掉——所以这个判据的下界性质必须如实写在读数旁：
 * 挤掉之后只能靠 `status` 那一支，而它只覆盖"此刻仍在争议"的单。
 * @param {object} row orders 行（只读 `status`）
 * @param {Array<{name?:string}>} events 已解析的事件史
 * @returns {boolean}
 */
export function rowEverDisputed(row, events) {
  if (String(row?.status || '') === 'disputed') return true;
  for (const e of events || []) {
    const name = e && e.name;
    if (name === 'DisputeRequested' || name === 'Arbitrated') return true;
  }
  return false;
}
