/**
 * 自动确认（keeper）的纯判据：链上 `Escrow.releaseExpired` 的唯一前置。
 *
 * 合约只允许在 `status == Created` 且 `block.number >= releaseNotBeforeBlock` 时释放；
 * `releaseNotBeforeBlock` 已经把 createdAt+timeout、退款拒绝后的静置期都算好了。
 * 所以 keeper 不自己用本地 `updated_at + timeout` 推算（那会和链上错开），只消费这个读数。
 */
export function releaseExpiredDecision(releaseNotBeforeBlock, latestBlock) {
  let at;
  let latest;
  try {
    at = BigInt(releaseNotBeforeBlock ?? 0);
    latest = BigInt(latestBlock ?? 0);
  } catch {
    return { eligible: false, reason: 'block-read-unavailable' };
  }
  if (at <= 0n) return { eligible: false, reason: 'not-created-or-not-timed' };
  if (latest < at) {
    return { eligible: false, reason: 'not-yet', remainingBlocks: Number(at - latest) };
  }
  return { eligible: true, reason: 'ready', remainingBlocks: 0 };
}
