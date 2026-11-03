import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { releaseExpiredDecision } from '../src/autoConfirm.js';

test('releaseExpiredDecision：必须严格越过释放块（合约 block.number <= at 仍 revert）', () => {
  assert.deepEqual(releaseExpiredDecision(100n, 99n), {
    eligible: false,
    reason: 'not-yet',
    remainingBlocks: 2,
  });
  // 等于阈值那一块仍不可释放：合约是 `block.number <= at` revert
  assert.deepEqual(releaseExpiredDecision(100n, 100n), {
    eligible: false,
    reason: 'not-yet',
    remainingBlocks: 1,
  });
  assert.equal(releaseExpiredDecision(100n, 101n).eligible, true);
});

test('releaseExpiredDecision：releaseNotBeforeBlock=0 表示链上不是 Created/不可释放', () => {
  assert.deepEqual(releaseExpiredDecision(0n, 999n), {
    eligible: false,
    reason: 'not-created-or-not-timed',
  });
});

test('releaseExpiredDecision：非法读数按不可释放处理（不猜）', () => {
  assert.equal(releaseExpiredDecision('nope', 1n).eligible, false);
  assert.equal(releaseExpiredDecision(null, null).eligible, false);
});

test('BTY gas：keeper 与主网 E2E 的写调用都显式给 gasLimit（估算对 >10 万 gas 失效）', () => {
  /*
    BTY 的 eth_estimateGas 对 >10 万 gas 固定返回 -32000 且无 revert data；
    keeper 的 releaseExpired / releaseSellerFunds 实测约 13 万 / 12.5 万，
    E2E 的 createOrder / confirmReceipt 约 19.5 万 / 16 万，都不能再靠估算。
  */
  const root = path.resolve(import.meta.dirname, '..');
  const keeper = fs.readFileSync(path.join(root, 'scripts/auto-confirm.mjs'), 'utf8');
  assert.match(keeper, /releaseExpired\(orderId, \{ gasLimit: GAS_RELEASE_EXPIRED \}\)/);
  assert.match(keeper, /releaseSellerFunds\(orderId, \{ gasLimit: GAS_RELEASE_SELLER_FUNDS \}\)/);

  const e2e = fs.readFileSync(path.join(root, 'scripts/e2e-mainnet.mjs'), 'utf8');
  assert.match(e2e, /gasLimit: GAS_CREATE_ORDER/);
  assert.match(e2e, /gasLimit: GAS_CONFIRM_RECEIPT/);
});
