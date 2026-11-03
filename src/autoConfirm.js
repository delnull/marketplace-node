/**
 * 自动确认（keeper）的纯判据：链上 `Escrow.releaseExpired` 的唯一前置。
 *
 * 合约只允许在 `status == Created` 且 `block.number > releaseNotBeforeBlock` 时释放；
 * `releaseNotBeforeBlock` 已经把 createdAt+timeout、退款拒绝后的静置期都算好了。
 * **是严格大于**（合约 `block.number <= at` 时 revert），等于阈值那一块仍不可释放；
 * 旧的 `latest < at` 把边界写成"等于即可"，keeper 会在那一块白付一次 gas（有界、但判据错）。
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
  if (latest <= at) {
    return { eligible: false, reason: 'not-yet', remainingBlocks: Number(at - latest + 1n) };
  }
  return { eligible: true, reason: 'ready', remainingBlocks: 0 };
}
