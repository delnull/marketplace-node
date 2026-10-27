/**
 * 支付资产配置（节点库 `payment_tokens`）：
 *  - 固定价向上取整、精度按 token decimals；
 *  - 公开列表只含配置过的 token，未知地址返回 null；
 *  - oracle 失败时用 fixed 兜底并标记 stale；
 *  - 非法配置在写入口/启动自检直接报错，不静默降级。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { clearPaymentRateCache, listPaymentMethods, quotePaymentToken, upsertPaymentToken, validatePaymentTokens } = await import(
  '../src/paymentTokens.js'
);

const TOKEN = '0x1111111111111111111111111111111111111111';

beforeEach(async () => {
  await ctx.db.run('DELETE FROM payment_tokens');
  await upsertPaymentToken({
    address: TOKEN,
    symbol: 'USDT',
    decimals: 6,
    mode: 'fixed',
    fixedUsdtMicroPerToken: '1000000',
  });
  await upsertPaymentToken({
    address: '0x2222222222222222222222222222222222222222',
    symbol: 'T18',
    decimals: 18,
    mode: 'fixed',
    fixedUsdtMicroPerToken: '2500000',
  });
  clearPaymentRateCache();
});

test('paymentTokens：固定值报价向上取整，精度按 token decimals', async () => {
  const q = await quotePaymentToken(TOKEN, 1_000_001);
  assert.equal(q.symbol, 'USDT');
  assert.equal(q.amountWei, '1000001');
  assert.equal(q.usdtMicroPerToken, '1000000');

  const q18 = await quotePaymentToken('0x2222222222222222222222222222222222222222', 1_000_000);
  assert.equal(q18.amountWei, '400000000000000000'); // ceil(1e6 * 1e18 / 2.5e6)
});

test('paymentTokens：列表只含已配置 token，未知地址返回 null', async () => {
  const list = await listPaymentMethods(2_000_000);
  assert.equal(list.length, 2);
  assert.equal(list[0].amountWei, '2000000');
  assert.equal(await quotePaymentToken('0x3333333333333333333333333333333333333333', 1_000_000), null);
});

test('paymentTokens：oracle 不可用时 marked stale，不能冒充行情源报价', async () => {
  await upsertPaymentToken({
    address: TOKEN,
    symbol: 'USDT',
    decimals: 6,
    mode: 'oracle',
    priceUrl: 'https://price.invalid/usdt',
    fixedUsdtMicroPerToken: '1000000',
  });
  clearPaymentRateCache();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    const q = await quotePaymentToken(TOKEN, 1_000_000);
    assert.equal(q.stale, true);
    assert.equal(q.usdtMicroPerToken, '1000000');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('paymentTokens：配置非法时直接报错（不静默降级）', async () => {
  await assert.rejects(
    () => upsertPaymentToken({ address: 'nope', symbol: 'X', decimals: 6, mode: 'fixed', fixedUsdtMicroPerToken: '1' }),
    /地址非法/
  );
  await assert.rejects(
    () => upsertPaymentToken({ address: TOKEN, symbol: 'X', decimals: 6, mode: 'fixed', fixedUsdtMicroPerToken: '0' }),
    /正整数/
  );
});

test('paymentTokens：启动自检从库行归一化也能读到 fixed（camel/snake 两种形状）', async () => {
  const rows = await validatePaymentTokens();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fixed, '1000000');
  assert.equal(rows[1].decimals, 18);
});
