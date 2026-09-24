/**
 * 汇率解析回归。
 *
 * 两组：
 *  ① 官方 /tapi/ticker（BTY-USDT）真实响应结构（2026-09-08 实测，与交易所行情端点同源同构）：
 *       {"code":0,"data":{"data":{"USDT":{"BTY":{"last":"0.022778",…}}}},"msg":"success"}
 *     旧源 taste /tickerApi（code:200 + 数值直取 + 多形态兼容）已移除；
 *  ② USDT→CNY 的**多源取数**（2026-09 重做）：OKX 的 CNY 交易对已下线、HTX/CoinEx 也没有该交易对，
 *     于是改成"多源并行 + 合理性区间 + 中位数"，这组用例锁定它的纯决策部分。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBtyTicker, cnyFenToPayWei, isPayableAmount,
  parseCoinbaseRates, parseUsdCny, pickUsdtCny, median, inUsdtCnyBand,
  USDT_CNY_MIN, USDT_CNY_MAX,
} from '../src/rates.js';

/**
 * 建单前的最后一道闸（源码评审 2026-09，P1）：折算结果为 0 的草稿**永远付不掉**——
 * 链上 `Escrow.createOrder` 有 `if (amount == 0) revert InvalidAmount()`，而草稿会一直占着
 * 库存占位与「同买家 10 张草稿」额度直到 TTL 清扫。所以路由必须能在建单前认出这种情况。
 */
test('isPayableAmount：0 / 空 / 非数字 / 负数一律不可建单', () => {
  assert.equal(isPayableAmount('0'), false, "折算结果 '0' 是链上必然 revert 的死草稿");
  assert.equal(isPayableAmount(0), false);
  assert.equal(isPayableAmount(''), false);
  assert.equal(isPayableAmount(null), false);
  assert.equal(isPayableAmount(undefined), false);
  assert.equal(isPayableAmount('abc'), false);
  assert.equal(isPayableAmount('1e3'), false, '科学计数法不是 wei 串');
  assert.equal(isPayableAmount('-1'), false);
  assert.equal(isPayableAmount('1.5'), false, 'wei 必须是整数串');
  assert.equal(isPayableAmount('1'), true, '最小 1 wei 也是合法应付（向上取整的产物）');
  assert.equal(isPayableAmount('1000000000000000000'), true);
});

test('cnyFenToPayWei：汇率退化（0 / NaN / 缺失）时返回 0 —— 与上面的闸正好接上', () => {
  const ok = { btyUsdt: 0.022, usdtCny: 7.2 };
  assert.ok(BigInt(cnyFenToPayWei(100, ok)) > 0n, '正常汇率能折出正的 wei');
  for (const bad of [
    { btyUsdt: 0, usdtCny: 7.2 },
    { btyUsdt: 0.022, usdtCny: 0 },
    { btyUsdt: NaN, usdtCny: 7.2 },
    { btyUsdt: undefined, usdtCny: 7.2 },
    { btyUsdt: 'abc', usdtCny: 7.2 },
  ]) {
    const wei = cnyFenToPayWei(100, bad);
    assert.equal(wei, '0', `退化汇率 ${JSON.stringify(bad)} 应返回 '0'`);
    assert.equal(isPayableAmount(wei), false, '并因此被建单闸拦住');
  }
});

test('实测结构：code==0 内层 USDT.BTY.last 字符串取价', () => {
  const j = {
    code: 0,
    msg: 'success',
    data: {
      data: {
        USDT: {
          BTY: { last: '0.022778', open: '0.022778', high: '0.022778', low: '0.022778', vol: '', range: '0', ty: 3, date: '2026-09-08 03:27:44' },
        },
      },
    },
  };
  assert.equal(parseBtyTicker(j), 0.022778);
});

test('业务码非 0 返回 null（HTTP 200 但业务失败）', () => {
  assert.equal(parseBtyTicker({ code: 1, msg: 'fail', data: {} }), null);
  assert.equal(parseBtyTicker({ code: 200, data: { data: { USDT: { BTY: { last: '1' } } } } }), null);
});

test('嵌套缺失 / 缺 last 字段返回 null', () => {
  assert.equal(parseBtyTicker({ code: 0, data: {} }), null);
  assert.equal(parseBtyTicker({ code: 0, data: { data: {} } }), null);
  assert.equal(parseBtyTicker({ code: 0, data: { data: { USDT: {} } } }), null);
  assert.equal(parseBtyTicker({ code: 0, data: { data: { USDT: { BTY: { open: '0.1' } } } } }), null);
});

test('非法数值（0/负/非数字字符串）返回 null', () => {
  assert.equal(parseBtyTicker({ code: 0, data: { data: { USDT: { BTY: { last: '0' } } } } }), null);
  assert.equal(parseBtyTicker({ code: 0, data: { data: { USDT: { BTY: { last: '-1' } } } } }), null);
  assert.equal(parseBtyTicker({ code: 0, data: { data: { USDT: { BTY: { last: 'abc' } } } } }), null);
});

test('非对象 / null 返回 null（触发兜底降级而非抛解析错）', () => {
  assert.equal(parseBtyTicker(null), null);
  assert.equal(parseBtyTicker(''), null);
  assert.equal(parseBtyTicker(123), null);
});

/* ══════════════════════════════════════════════════════════════════════
   USDT→CNY 多源取数（2026-09 重做：OKX 的 CNY 交易对已下线，只靠单一源
   等于把全站定价挂在别人的可用性上 → 多源并行 + 合理性区间 + 中位数）
   ══════════════════════════════════════════════════════════════════════ */

test('parseCoinbaseRates：取 CNY，并顺带取 USDT/USD 锚定价', () => {
  const j = { data: { currency: 'USDT', rates: { CNY: '6.7032043685', USD: '0.99985' } } };
  assert.deepEqual(parseCoinbaseRates(j), { usdtCny: 6.7032043685, usdtUsd: 0.99985 });
  // 锚定价缺失/异常：CNY 仍可用，锚定价记 null（调用方按 1 处理）
  assert.deepEqual(parseCoinbaseRates({ data: { rates: { CNY: '6.7' } } }), { usdtCny: 6.7, usdtUsd: null });
  assert.deepEqual(parseCoinbaseRates({ data: { rates: { CNY: '6.7', USD: '0' } } }), { usdtCny: 6.7, usdtUsd: null });
  // 形态异常一律 null（触发降级，而不是把 NaN 传下去）
  for (const bad of [null, '', 123, {}, { data: {} }, { data: { rates: {} } }, { data: { rates: { CNY: 'abc' } } }]) {
    assert.equal(parseCoinbaseRates(bad), null, JSON.stringify(bad));
  }
});

test('parseUsdCny：er-api 与 frankfurter 两种真实形态都能取，业务失败返回 null', () => {
  // er-api（2026-09 实测）：{result:'success', provider:…, rates:{CNY:6.71347}}
  assert.equal(parseUsdCny({ result: 'success', rates: { CNY: 6.71347 } }), 6.71347);
  // frankfurter：{amount:1, base:'USD', date:…, rates:{CNY:'7.1'}}
  assert.equal(parseUsdCny({ amount: 1, base: 'USD', rates: { CNY: '7.1' } }), 7.1);
  // er-api 的业务失败（HTTP 200 但 result !== 'success'）必须当失败
  assert.equal(parseUsdCny({ result: 'error', 'error-type': 'quota', rates: { CNY: 6.7 } }), null);
  for (const bad of [null, '', 123, {}, { rates: {} }, { rates: { CNY: '0' } }, { rates: { CNY: '-1' } }]) {
    assert.equal(parseUsdCny(bad), null, JSON.stringify(bad));
  }
});

test('合理性区间：挡住"上游返回垃圾"，但覆盖任何现实汇率', () => {
  assert.equal(inUsdtCnyBand(6.7), true);
  assert.equal(inUsdtCnyBand(USDT_CNY_MIN), true);
  assert.equal(inUsdtCnyBand(USDT_CNY_MAX), true);
  for (const bad of [1, 0.99, 70, 0, -6.7, NaN, Infinity, undefined, null, '6.7']) {
    assert.equal(inUsdtCnyBand(bad), false, `应判为不合理：${String(bad)}`);
  }
});

test('median：奇数取中位、偶数取中间均值、非有限值不参与', () => {
  assert.equal(median([3]), 3);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([NaN, undefined]), null);
  assert.equal(median([5, NaN, 7]), 6);
});

test('pickUsdtCny：三源齐活时取中位数（单个离群不带走价格）', () => {
  const r = pickUsdtCny({ direct: 6.7, usdCny: [{ name: 'erapi', value: 6.71 }, { name: 'frankfurter', value: 6.72 }], peg: 1 });
  assert.equal(r.legs, 3);
  assert.equal(r.value, 6.71);
  assert.match(r.source, /median/);
  // 其中一个源抽风成 60：被区间挡掉，不进中位数
  const r2 = pickUsdtCny({ direct: 6.7, usdCny: [{ name: 'erapi', value: 60 }], peg: 1 });
  assert.equal(r2.legs, 1);
  assert.equal(r2.value, 6.7);
  assert.deepEqual(r2.rejected, ['erapi=60']);
});

test('pickUsdtCny：缺 Coinbase 时，USD→CNY 乘 USDT/USD 锚定价仍可定价', () => {
  const r = pickUsdtCny({ direct: null, usdCny: [{ name: 'erapi', value: 6.71347 }], peg: 0.99985 });
  assert.equal(r.legs, 1);
  assert.ok(Math.abs(r.value - 6.71347 * 0.99985) < 1e-9, `实际 ${r.value}`);
  assert.match(r.source, /erapi×peg/, '来源里要能看出乘了锚定价');
  // 锚定价离谱（不在 0.9~1.1）时不采用——否则一个坏锚定价会把 CNY 价格整体拉偏
  const r2 = pickUsdtCny({ direct: null, usdCny: [{ name: 'erapi', value: 6.71347 }], peg: 5 });
  assert.ok(Math.abs(r2.value - 6.71347) < 1e-9);
});

test('pickUsdtCny：全部不可用（或全部超出区间）时返回 null，绝不编造数字', () => {
  assert.deepEqual(pickUsdtCny({}), { value: null, source: '', legs: 0, rejected: [] });
  const r = pickUsdtCny({ direct: 70, usdCny: [{ name: 'erapi', value: 1 }], peg: 1 });
  assert.equal(r.value, null);
  assert.equal(r.legs, 0);
  assert.deepEqual(r.rejected, ['coinbase=70', 'erapi=1']);
});

/**
 * 源名必须由调用方传入：`usdtCnySource` 会出现在 /api/rates、告警和运维排查里，
 * 写死 'coinbase' 意味着换源/加源后对外报出一个**错误的来源**——诊断信息比没有更糟。
 */
test('pickUsdtCny：直接源的名称跟着调用方走，不写死 coinbase', () => {
  assert.equal(pickUsdtCny({ direct: 6.7, directName: 'kraken' }).source, 'kraken');
  assert.deepEqual(pickUsdtCny({ direct: 70, directName: 'kraken' }).rejected, ['kraken=70']);
  // 三源齐活时，来源串里也要是真实源名
  const r = pickUsdtCny({ direct: 6.7, directName: 'kraken', usdCny: [{ name: 'erapi', value: 6.71 }] });
  assert.equal(r.source, 'median(kraken,erapi)');
});
