/**
 * 金额换算判据（`src/chain.js` 的 `weiToDecimal` / `decimalToWei`）的回归测试。
 *
 * 守的是"**读不到 ≠ 0**"这条纪律在**展示口径**上的最后一环（2026-10 生产化清理）：
 * `weiToDecimal` 曾经对任何解析失败返回 `'0'`，而这些 `*Decimal` 字段直接进 DTO 给界面显示——
 * 于是"读不到"会被印成 `0 BTY`（一个看着正常的假数字）。它的输入里有一半是**从 RPC 解出来的值**
 * （`stakingRisk` 的 minStakeToRegister/pool/shortfall、`opsMetrics` 的费率），
 * 没有库层 `NOT NULL` 那种门禁兜着 ⇒ 这一类在别处照样可表达，所以判据本身要有钉子。
 *
 * 同一判据在前端是 `utils/arbiterMoney.weiBig`（返回 `bigint | null`），
 * 在链上金额侧是 `escrowWatcher.readRefundedWei`（返回 `bigint | null`）——三者同一条纪律。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalToWei, weiToDecimal } from '../src/chain.js';

test('weiToDecimal：只有纯十进制 wei 才换算，其余一律 null（**不许返回 "0"**）', () => {
  assert.equal(weiToDecimal('0'), '0.0', "'0' 是确证为 0（一个具体结论，必须换算得出来）");
  assert.equal(weiToDecimal('1000000000000000000'), '1.0');
  assert.equal(weiToDecimal(10n ** 18n), '1.0', 'bigint 直接可用');
  assert.equal(weiToDecimal(' 250000000000000000 '), '0.25', '两侧空白照旧容忍');
  assert.equal(weiToDecimal('1000000000000000000', 6), '1000000000000.0', 'decimals 参数照旧生效');
  for (const bad of [undefined, null, '', '   ', 'garbage', '0x10', '-1', '1.5', '1e18', {}]) {
    assert.equal(weiToDecimal(bad), null, `${String(bad)} 是"读不到"，不是 0`);
  }
});

test('decimalToWei：与 weiToDecimal 互逆（合法入参逐位一致，不丢精度）', () => {
  for (const wei of ['0', '1', '250000000000000000', '1000000000000000000', '123456789012345678901234567890']) {
    const dec = weiToDecimal(wei);
    assert.equal(decimalToWei(dec), wei, `${wei} → ${dec} → 应逐位回到原值`);
  }
});
