import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseExpiredDecision } from '../src/autoConfirm.js';

test('releaseExpiredDecision：未到释放块不释放，并给出剩余块数', () => {
  assert.deepEqual(releaseExpiredDecision(100n, 99n), {
    eligible: false,
    reason: 'not-yet',
    remainingBlocks: 1,
  });
  assert.equal(releaseExpiredDecision(100n, 100n).eligible, true);
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
