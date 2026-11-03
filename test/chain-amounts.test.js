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
import { chainParamsMatch, orderCreatedMatches } from '../src/chainOrder.js';

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

test('orderCreatedMatches：orderId/买家/卖家/金额/支付资产全部属于本单才通过', () => {
  const zero = '0x0000000000000000000000000000000000000000';
  const order = {
    escrow_order_id: `0x${'aa'.repeat(32)}`,
    buyer: '0x0000000000000000000000000000000000000002',
    seller: '0x0000000000000000000000000000000000000003',
    amount_wei: '1000',
    payment_token: zero,
  };
  const args = {
    orderId: `0x${'aa'.repeat(32)}`,
    buyer: order.buyer.toUpperCase().replace('0X', '0x'),
    seller: order.seller,
    amount: 1000n,
  };
  assert.equal(orderCreatedMatches(order, args, order.escrow_order_id, zero), true, '同一单（地址大小写不敏感）必须通过');
  for (const bad of [
    { ...args, orderId: `0x${'bb'.repeat(32)}` },
    { ...args, buyer: '0x0000000000000000000000000000000000000004' },
    { ...args, seller: '0x0000000000000000000000000000000000000005' },
    { ...args, amount: 999n },
    { ...args, amount: 'not-a-number' },
    {},
  ]) {
    assert.equal(
      orderCreatedMatches(order, bad, order.escrow_order_id, zero),
      false,
      `伪造/缺字段必须拒绝：${String(bad.amount ?? '')} ${String(bad.orderId ?? '')}`
    );
  }

  // P0：token 单的金额与原生单相同，不能只看金额。链上 token 与本地报价不一致即拒绝。
  const tokenOrder = { ...order, payment_token: '0x00000000000000000000000000000000000000ff' };
  assert.equal(
    orderCreatedMatches(tokenOrder, args, tokenOrder.escrow_order_id, zero),
    false,
    'token 单不能由原生 OrderCreated 认领'
  );
  assert.equal(
    orderCreatedMatches(order, args, order.escrow_order_id, tokenOrder.payment_token),
    false,
    '原生单不能由 token OrderCreated 认领'
  );
  assert.equal(
    orderCreatedMatches(tokenOrder, args, tokenOrder.escrow_order_id, tokenOrder.payment_token),
    true,
    '同资产 token 单必须通过'
  );
  assert.equal(orderCreatedMatches(order, args), false, '没有链上 token 读数时必须 fail-closed');
});

test('chainParamsMatch：买家/卖家/金额/验货窗口/支付资产任一项不符即拒绝', () => {
  const zero = '0x0000000000000000000000000000000000000000';
  const local = {
    buyer: '0x0000000000000000000000000000000000000002',
    seller: '0x0000000000000000000000000000000000000003',
    amount_wei: '1000',
    timeout_blocks: 10,
    payment_token: zero,
  };
  const p = {
    buyer: local.buyer,
    seller: local.seller,
    amount: '1000',
    timeoutBlocks: 10,
    token: zero,
  };
  assert.equal(chainParamsMatch(local, p), true);
  assert.equal(chainParamsMatch(local, { ...p, buyer: '0x0000000000000000000000000000000000000009' }), false);
  assert.equal(chainParamsMatch(local, { ...p, seller: '0x0000000000000000000000000000000000000009' }), false);
  assert.equal(chainParamsMatch(local, { ...p, amount: '999' }), false);
  // 验货窗口也是身份的一部分：同一对当事人、同一金额、不同窗口的诱饵单同样不该驱动本地状态
  assert.equal(chainParamsMatch(local, { ...p, timeoutBlocks: 11 }), false);
  // 支付资产：同数字的 token 单不能驱动原生单
  assert.equal(chainParamsMatch(local, { ...p, token: '0x00000000000000000000000000000000000000ff' }), false);
});
