/**
 * 汇率回归：**唯一一条腿** —— 官方 /tapi/ticker 的 BTY-USDT 行情。
 *
 * 标价单位 2026-10 由 CNY（分）改为 USDT（微 USDT）之后，「USDT→CNY」那条法币腿
 * （Coinbase / er-api / frankfurter 三源 + 中位数 + 合理性区间 + 各自的 TTL 与兜底汇率）
 * 已随 `orders.usdt_cny_rate` 快照列一起整条删除——标价本身就是 USDT，法币汇率与定价无关。
 * 本文件因此只覆盖：真实响应结构的解析、TTL、负缓存、single-flight、兜底值与 stale、
 * 以及「微 USDT → 应付 wei」的向上取整与整数运算。
 *
 * 上半部分是纯函数（不需要上游），下半部分把 `globalThis.fetch` 换成可编排的假上游，
 * 每个场景用一个带 query 的动态 import 拿全新模块实例（rates.js 的缓存是模块级状态，
 * 不清干净就互相污染）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import cfg from '../src/config.js';
import { parseBtyTicker, usdtMicroToPayWei, isPayableAmount } from '../src/rates.js';

/* ══════════════════════════════════════════════════════════════════════
   建单前的闸：折算结果为 0 的草稿**永远付不掉**（链上 Escrow.createOrder 有
   `if (amount == 0) revert InvalidAmount()`），却会占着库存占位与「同买家 10 张草稿」
   的额度直到 TTL 清扫。三态：'0'（退化）/ 非法串 / 正的整数 wei 串。
   ══════════════════════════════════════════════════════════════════════ */
test('isPayableAmount：0 与非法串一律不可建单，正的整数 wei 串可建单（三态）', () => {
  // ① 退化态：折算不出正数
  assert.equal(isPayableAmount('0'), false, "折算结果 '0' 是链上必然 revert 的死草稿");
  assert.equal(isPayableAmount(0), false);
  assert.equal(isPayableAmount(''), false);
  assert.equal(isPayableAmount(null), false);
  assert.equal(isPayableAmount(undefined), false);
  // ② 非法态：不是 wei 整数串
  assert.equal(isPayableAmount('abc'), false);
  assert.equal(isPayableAmount('1e3'), false, '科学计数法不是 wei 串');
  assert.equal(isPayableAmount('-1'), false);
  assert.equal(isPayableAmount('1.5'), false, 'wei 必须是整数串');
  // ③ 可用态：最小 1 wei 也是合法应付（向上取整的产物）
  assert.equal(isPayableAmount('1'), true);
  assert.equal(isPayableAmount('1000000000000000000'), true);
});

test('usdtMicroToPayWei：向上取整（绝不少付 1 wei），且整条链路走整数运算', () => {
  // 能被整除的锚点：1 BTY = 0.1 USDT ⇒ 1 USDT = 10 BTY = 1e19 wei
  assert.equal(usdtMicroToPayWei(1_000_000, { btyUsdt: 0.1 }), (10n ** 19n).toString());
  // 最小标价单位 1 微 USDT = 1e-6 USDT = 1e-5 BTY = 1e13 wei（无余数）
  assert.equal(usdtMicroToPayWei(1, { btyUsdt: 0.1 }), (10n ** 13n).toString());
  assert.equal(usdtMicroToPayWei(0, { btyUsdt: 0.1 }), '0');
  assert.equal(usdtMicroToPayWei(-5, { btyUsdt: 0.1 }), '0', '负数没有应付语义');

  // 除不尽的汇率：ceil 的定义就是「不小于精确值的最小整数」——用两条不等式钉住，
  // 而不是在测试里把实现重抄一遍。
  //   精确值 = micro/1e6 USDT ÷ btyUsdt BTY/USDT × 1e18 wei
  //   汇率在实现里被放大成整数 scaled = round(btyUsdt × 1e8)（保留 8 位有效精度，
  //   远超行情源实际精度），于是精确值 = micro × 1e20 / scaled。
  const rate = 0.022778;
  const scaled = BigInt(Math.round(rate * 1e8));
  for (const micro of [1, 3, 999_999, 12_345_678, 88_000_000, 10n ** 15n]) {
    const wei = BigInt(usdtMicroToPayWei(micro, { btyUsdt: rate }));
    const num = BigInt(micro) * 10n ** 20n;
    assert.ok(wei * scaled >= num, `${micro} 微 USDT：向上取整不得少付`);
    assert.ok((wei - 1n) * scaled < num, `${micro} 微 USDT：不得比"最小可行整数"再多付 1 wei`);
  }

  /*
    大额不丢精度：1e15 微 = 1e9 USDT（单价上限）× 10 BTY/USDT = 1e10 BTY = 1e28 wei。
    走 double 的旧实现在这个量级会先损失有效位（1e28 超出 Number 的整数精度），
    整数串逐位相等正是"没有经过浮点"的证据。
  */
  assert.equal(usdtMicroToPayWei(10n ** 15n, { btyUsdt: 0.1 }), (10n ** 28n).toString());
});

test('usdtMicroToPayWei：汇率退化（0 / 负数 / NaN / 缺失 / 非数字）时返回 0', () => {
  assert.ok(BigInt(usdtMicroToPayWei(1_000_000, { btyUsdt: 0.022 })) > 0n, '正常汇率能折出正的 wei');
  for (const bad of [{ btyUsdt: 0 }, { btyUsdt: -0.1 }, { btyUsdt: NaN }, { btyUsdt: undefined }, { btyUsdt: 'abc' }, {}, null]) {
    const wei = usdtMicroToPayWei(1_000_000, bad);
    assert.equal(wei, '0', `退化汇率 ${JSON.stringify(bad)} 应返回 '0'`);
    assert.equal(isPayableAmount(wei), false, '并因此被建单闸拦住');
  }
});

/* ── 官方 ticker 的响应解析（2026-09-08 实测结构）── */

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
   取数链路（TTL / 负缓存 / single-flight / 兜底与 stale）——把 globalThis.fetch
   换成可编排的假上游；每个场景一个新模块实例。
   ══════════════════════════════════════════════════════════════════════ */

const TICKER_BODY = { code: 0, msg: 'success', data: { data: { USDT: { BTY: { last: '0.022778' } } } } };

/**
 * 装假上游：只认官方 ticker；`down` 时一律抛网络错（模拟上游不可达）。
 * @returns {{calls: {ticker: number}, restore: () => void}}
 */
function installFetch(down = false) {
  const calls = { ticker: 0 };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes('mainnet.bityuan.com'), `测试没有覆盖这个上游：${url}`);
    calls.ticker += 1;
    if (down) throw new Error('mock: 官方 ticker 不可达');
    return { ok: true, status: 200, json: async () => TICKER_BODY };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

/** 每个场景一个新实例：带递增 query 的动态 import（模块级缓存必须隔离） */
let seq = 0;
async function freshRates() {
  seq += 1;
  return import(`../src/rates.js?scenario=${seq}`);
}

/**
 * 每个场景先把配置按"最容易暴露问题"的方向固定下来：
 *   · 手工兜底汇率清零 —— 要验证的是"取不到就是取不到"，别让兜底值把断言糊过去；
 *   · TTL 设 0（每次请求都刷新）—— 否则上一轮的缓存会让"全挂"场景根本不打上游，
 *     测出来的绿色是缓存的绿色。缓存行为本身由下面显式设定 TTL 的用例验证。
 * @returns {() => void} 还原
 */
function isolate() {
  const savedTtl = cfg.rates.btyTtlMs;
  const savedFallback = cfg.rates.fallback.btyUsdt;
  cfg.rates.btyTtlMs = 0;
  cfg.rates.fallback.btyUsdt = 0;
  return () => {
    cfg.rates.btyTtlMs = savedTtl;
    cfg.rates.fallback.btyUsdt = savedFallback;
  };
}

test('TTL 生效：缓存期内重复调用一个上游请求都不发（"调大 TTL 防封杀"就是靠这条）', async () => {
  const net = installFetch();
  const restoreCfg = isolate();
  cfg.rates.btyTtlMs = 60_000;
  try {
    const { getRates } = await freshRates();
    const first = await getRates();
    assert.equal(first.btyUsdt, 0.022778, 'BTY-USDT 走官方 ticker');
    assert.equal(first.usdtToBty, 1 / 0.022778, 'usdtToBty = 1 USDT = x BTY');
    assert.equal(first.stale, false);
    assert.equal(first.error, null);
    assert.equal(net.calls.ticker, 1);
    for (let i = 0; i < 5; i += 1) await getRates();
    assert.equal(net.calls.ticker, 1, '5 次后续调用都命中缓存');
  } finally {
    restoreCfg(); net.restore();
  }
});

test('负缓存：从未取到值且无兜底 → getRates() 返回 null，30 秒内不重复打上游', async () => {
  const net = installFetch(true);
  const restoreCfg = isolate();
  try {
    const { getRates } = await freshRates();
    assert.equal(await getRates(), null, '没有任何可用值 → null，路由回 available:false');
    assert.equal(net.calls.ticker, 1);
    assert.equal(await getRates(), null);
    assert.equal(await getRates(), null);
    assert.equal(net.calls.ticker, 1, '负缓存期内不得再打上游（否则故障时每请求打满一次上游）');
  } finally {
    restoreCfg(); net.restore();
  }
});

test('single-flight：并发取汇率只打一轮上游（缓存过期的瞬间最容易被放大）', async () => {
  const net = installFetch();
  const restoreCfg = isolate();
  try {
    const { getRates } = await freshRates();
    const rs = await Promise.all(Array.from({ length: 8 }, () => getRates()));
    assert.equal(net.calls.ticker, 1, '8 个并发请求合并成 1 轮刷新');
    for (const r of rs) assert.equal(r.btyUsdt, 0.022778);
  } finally {
    restoreCfg(); net.restore();
  }
});

test('force：跳过新鲜度检查重新拉一次，但**不绕过单飞**（并发 force 也只打一轮）', async () => {
  const net = installFetch();
  const restoreCfg = isolate();
  cfg.rates.btyTtlMs = 60_000; // 正常 TTL 内不会自己刷新
  try {
    const { getRates, refreshRates } = await freshRates();
    await getRates();
    assert.equal(net.calls.ticker, 1);
    await getRates();
    assert.equal(net.calls.ticker, 1, 'TTL 内普通调用命中缓存');

    await refreshRates(true);
    assert.equal(net.calls.ticker, 2, 'force 跳过新鲜度检查，真的去取了一次');

    // 并发 force：single-flight 的 `.finally` 必须自比较后再清空，否则先结束的一轮
    // 会把后一轮的句柄清成 null，后面来的调用又起一轮（cache 后写覆盖先写）
    const before = net.calls.ticker;
    await Promise.all([refreshRates(true), refreshRates(true), refreshRates(true)]);
    assert.equal(net.calls.ticker, before + 1, '3 个并发 force 合并成 1 轮上游请求');
  } finally {
    restoreCfg(); net.restore();
  }
});

test('上游挂但有实时旧值：保留旧值 + stale=true + error 记明来源（绝不假装是实时价）', async () => {
  const net = installFetch();
  const restoreCfg = isolate(); // TTL = 0：每一轮都要真的去打上游，才能看到"这一轮失败了"
  try {
    const { getRates } = await freshRates();
    const good = await getRates();
    assert.equal(good.stale, false);
    assert.equal(net.calls.ticker, 1);

    net.restore();
    const dead = installFetch(true);
    const r = await getRates();
    assert.equal(dead.calls.ticker, 1, 'TTL=0 → 这一轮确实去打上游了，也确实失败了');
    assert.equal(r.btyUsdt, good.btyUsdt, '失败不丢旧值：上一轮的实时值仍比"没有价格"强');
    assert.equal(r.stale, true);
    assert.match(r.error, /BTY-USDT/, '错误必须指出是哪条腿——这是运维唯一的线索');
    assert.ok(r.updatedAt >= good.updatedAt, '失败的这一轮也要更新"上次尝试时刻"');
    dead.restore();
  } finally {
    restoreCfg(); net.restore();
  }
});

test('兜底汇率：全挂且从未成功过时回退 MK_FALLBACK_BTY_USDT 并标 stale=true', async () => {
  const net = installFetch(true);
  const restoreCfg = isolate();
  cfg.rates.fallback.btyUsdt = 0.1; // 1 BTY = 0.1 USDT
  try {
    const { getRates } = await freshRates();
    const r = await getRates();
    assert.ok(r, '配了兜底值就不该返回 null（店还能按手工汇率下单）');
    assert.equal(r.btyUsdt, 0.1, '行情源全挂时回退到手工兜底汇率');
    assert.equal(r.usdtToBty, 10);
    assert.equal(r.stale, true, '兜底值不是实时价，必须标 stale');
    assert.match(r.error, /BTY-USDT/);
  } finally {
    restoreCfg(); net.restore();
  }
});

/**
 * 兜底汇率**不是**"有实时值"：它必须按负缓存（30 秒）的节奏重试真实源。
 * 旧实现把兜底值直接写进 `cache.btyUsdt`，于是 `legDue()` 认为"有值" ⇒ 要等一个完整 TTL
 * （默认 60 秒，运维调大后可能是几十分钟）才重试 —— 上游只是抖一下，门店却按一个手工数字定价。
 */
test('兜底值按负缓存节奏重试真实源（而不是被当成"有值"睡满一个 TTL）', async (t) => {
  /*
    假时钟要给一个**真实起点**：Node 的 mock Date 默认从 0（1970）起，而 `at = 0` 是"从未取过"
    的哨兵值——两者混在一起就分不出"刚取过"和"没取过"（`legDue()` 里显式判 `!at` 正是为此）。
  */
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const net = installFetch(true); // 上游全挂
  const restoreCfg = isolate();
  cfg.rates.btyTtlMs = 3_600_000; // 该腿 TTL = 1 小时（用它和 30 秒负缓存做区分）
  cfg.rates.fallback.btyUsdt = 0.1;
  try {
    const { getRates, refreshRates } = await freshRates();
    const r1 = await getRates();
    assert.equal(r1.btyUsdt, 0.1, '行情源全挂时应回退到手工兜底汇率');
    assert.equal(r1.stale, true, '兜底值必须标 stale（它不是实时价）');
    const first = net.calls.ticker;

    // 31 秒后（> 负缓存 30 秒、< TTL 1 小时）：必须已经重试过上游
    t.mock.timers.tick(31_000);
    await refreshRates();
    assert.ok(
      net.calls.ticker > first,
      `兜底值到期应重试真实源（负缓存 30 秒），实际 ticker 调用 ${first} → ${net.calls.ticker}`
    );
  } finally {
    restoreCfg(); net.restore(); t.mock.timers.reset();
  }
});
