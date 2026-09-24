/**
 * 汇率取数的**端到端**回归（rates.test.js 测的是纯函数，这里测真实链路）。
 *
 * 为什么要这一组：USDT 行情是**商品价格的关键**——CNY 标价 → BTY 应付金额全靠它折算。
 * 而它依赖的是三个**免密钥公共接口**，随时可能被限速、改结构或下线（2026-09 实测：OKX 的
 * USDT-CNY 交易对已下线，HTX/CoinEx 根本没有该交易对）。纯函数测试保证不了"少一条腿时
 * 还能不能出价"、"全挂了会不会把上一轮的旧价格当成新的发出去"、"TTL 调大之后是不是真的
 * 不再打上游"——这三件事只能在 fetch 层验证。
 *
 * 做法：把 globalThis.fetch 换成**可编排的上游**，每个场景用一个带 query 的动态 import
 * 拿到全新的模块实例（rates.js 的缓存/告警状态是模块级的，不清干净就互相污染）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import cfg from '../src/config.js';

/** 上游 URL → 关键词（用关键词匹配，避免把完整 URL 抄进测试里跟着实现一起改） */
const KEYS = {
  ticker: 'mainnet.bityuan.com',
  coinbase: 'api.coinbase.com',
  erapi: 'open.er-api.com',
  frankfurter: 'api.frankfurter.dev',
};

const TICKER_BODY = { code: 0, msg: 'success', data: { data: { USDT: { BTY: { last: '0.022778' } } } } };
const COINBASE_BODY = { data: { currency: 'USDT', rates: { CNY: '6.70' } } }; // 故意不给 USD → 锚定价按 1
const ERAPI_BODY = { result: 'success', rates: { CNY: 6.71 } };
const FRANKFURTER_BODY = { amount: 1, base: 'USD', rates: { CNY: 6.72 } };

/**
 * 装一个假的上游：`down` 里的源一律抛网络错，其余返回各自的真实响应形态。
 * @returns {{calls: Record<string, number>, total: () => number, restore: () => void}}
 */
function installFetch(down = []) {
  const calls = {};
  const bodies = { ticker: TICKER_BODY, coinbase: COINBASE_BODY, erapi: ERAPI_BODY, frankfurter: FRANKFURTER_BODY };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = Object.keys(KEYS).find((k) => String(url).includes(KEYS[k]));
    assert.ok(key, `测试没有覆盖这个上游：${url}`);
    calls[key] = (calls[key] || 0) + 1;
    if (down.includes(key)) throw new Error(`mock: ${key} unreachable`);
    return { ok: true, status: 200, json: async () => bodies[key] };
  };
  return {
    calls,
    total: () => Object.values(calls).reduce((a, b) => a + b, 0),
    restore: () => { globalThis.fetch = orig; },
  };
}

/** 每个场景一个新实例：带递增 query 的动态 import（模块级缓存/告警状态必须隔离） */
let seq = 0;
async function freshRates() {
  seq += 1;
  return import(`../src/rates.js?scenario=${seq}`);
}

/** 抓 console.warn，用来断言"冗余掉光"没有被静默吞掉 */
function captureWarn() {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  return { warns, restore: () => { console.warn = orig; } };
}

/**
 * 每个场景先把汇率配置按"最容易暴露问题"的方向固定下来：
 *   · 手工兜底汇率清零 —— 要验证的是"取不到就是取不到"，别让兜底值把断言糊过去；
 *   · 两条腿的 TTL 都设 0（每次请求都刷新）—— 否则上一轮的缓存会让"全挂"场景根本不打上游，
 *     测出来的绿色是缓存的绿色，不是降级逻辑的绿色。
 * 缓存行为本身由后面几个用例显式设定 TTL 来验证。
 * @returns {() => void} 还原
 */
function isolate() {
  const saved = { ...cfg.rates.fallback };
  const savedBtyTtl = cfg.rates.btyTtlMs;
  const savedCnyTtl = cfg.rates.usdtCnyTtlMs;
  cfg.rates.fallback.btyUsdt = 0;
  cfg.rates.fallback.usdtCny = 0;
  cfg.rates.btyTtlMs = 0;
  cfg.rates.usdtCnyTtlMs = 0;
  return () => {
    Object.assign(cfg.rates.fallback, saved);
    cfg.rates.btyTtlMs = savedBtyTtl;
    cfg.rates.usdtCnyTtlMs = savedCnyTtl;
  };
}

test('三源齐活：legs=3、取中位数、不告警', async () => {
  const net = installFetch();
  const warn = captureWarn();
  const restoreCfg = isolate();
  try {
    const { getRates } = await freshRates();
    const r = await getRates();
    assert.equal(r.usdtCnyLegs, 3);
    assert.equal(r.usdtCny, 6.71, '三源 6.70/6.71/6.72 的中位数');
    assert.match(r.usdtCnySource, /^median\(/);
    assert.equal(r.stale, false);
    assert.equal(r.error, null);
    assert.equal(r.btyUsdt, 0.022778, 'BTY-USDT 走官方 ticker');
    assert.equal(net.calls.ticker, 1);
    assert.deepEqual(warn.warns, [], '三条腿都在，不该有冗余告警');
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

test('降级①直接源挂：靠 USD→CNY×锚定价仍能定价，且如实报 legs=2', async () => {
  const net = installFetch(['coinbase']);
  const warn = captureWarn();
  const restoreCfg = isolate();
  try {
    const { getRates } = await freshRates();
    const r = await getRates();
    assert.equal(r.usdtCnyLegs, 2, 'er-api + frankfurter 两条腿');
    assert.equal(r.usdtCny, 6.715, '(6.71+6.72)/2');
    assert.equal(r.stale, false, '只挂了一个源，但仍拿到了实时值 → 不算降级（但不该静默）');
    assert.equal(warn.warns.length, 1, '必须有一条冗余告警，运维才知道冗余已经掉了一条');
    assert.match(warn.warns[0], /冗余不足/);
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

test('降级②USD 源全挂：只剩 Coinbase 一条腿也照样出价（legs=1）', async () => {
  const net = installFetch(['erapi', 'frankfurter']);
  const warn = captureWarn();
  const restoreCfg = isolate();
  try {
    const { getRates } = await freshRates();
    const r = await getRates();
    assert.equal(r.usdtCnyLegs, 1);
    assert.equal(r.usdtCny, 6.70);
    assert.equal(r.usdtCnySource, 'coinbase');
    assert.equal(warn.warns.length, 1);
    assert.match(warn.warns[0], /仅 1 个源可用/);
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

test('降级③全挂但有历史值：保留旧价并标 stale=true + error（绝不假装是实时价）', async () => {
  const net = installFetch();
  const warn = captureWarn();
  const restoreCfg = isolate();
  try {
    const { getRates } = await freshRates();
    const good = await getRates();
    assert.equal(good.stale, false);

    net.restore();
    const dead = installFetch(['ticker', 'coinbase', 'erapi', 'frankfurter']);
    const r = await getRates();
    assert.equal(r.usdtCny, good.usdtCny, '旧值保留，前端不会突然没有价格');
    assert.equal(r.btyUsdt, good.btyUsdt);
    assert.equal(r.stale, true);
    assert.match(r.error, /BTY-USDT/);
    assert.match(r.error, /USDT-CNY/);
    dead.restore();
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

test('降级④全挂且从未成功过：getRates() 返回 null（调用方降级为"仅 CNY 标价"），且负缓存不重复打上游', async () => {
  const net = installFetch(['ticker', 'coinbase', 'erapi', 'frankfurter']);
  const warn = captureWarn();
  const restoreCfg = isolate();
  try {
    const { getRates } = await freshRates();
    assert.equal(await getRates(), null, '没有任何可用值 → null，路由回 available:false');
    const afterFirst = net.total();
    assert.equal(afterFirst, 4, '一轮刷新 = ticker + 3 个 USDT 源');
    assert.equal(await getRates(), null);
    assert.equal(net.total(), afterFirst, '30s 负缓存内不得再打上游（否则故障时每请求 4 个上游全打满）');
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

test('TTL 生效：缓存期内重复调用只打一轮上游（"调大 TTL 防封杀"就是靠这条）', async () => {
  const net = installFetch();
  const warn = captureWarn();
  const restoreCfg = isolate();
  cfg.rates.btyTtlMs = 60_000; // isolate() 已把两条腿都设为 0（每次刷新），这里要测的正是 TTL 命中
  cfg.rates.usdtCnyTtlMs = 60_000;
  try {
    const { getRates } = await freshRates();
    await getRates();
    assert.equal(net.total(), 4);
    for (let i = 0; i < 5; i += 1) await getRates();
    assert.equal(net.total(), 4, '5 次后续调用都命中缓存，一个上游请求都不发');
    assert.equal(net.calls.coinbase, 1);
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

/* ══════════════════════════════════════════════════════════════════════
   两条腿的 TTL 独立（2026-09 拆分）：
   BTY-USDT 要跟得紧（官方端点，直接决定买家付多少 BTY）；
   USDT→CNY 要缓存久（三家免密钥公共接口，缓存就是可用性）。
   下面两条用例分别锁定"只刷该刷的那条腿"——这正是拆分的目的，
   合用一个 TTL 时这两条都会失败。
   ══════════════════════════════════════════════════════════════════════ */

test('只刷该刷的腿①：BTY 过期、USDT-CNY 还在缓存期 → 只打官方 ticker，一个公共接口都不碰', async () => {
  const net = installFetch();
  const warn = captureWarn();
  const restoreCfg = isolate();
  cfg.rates.btyTtlMs = 0; // BTY 每次都要刷新
  cfg.rates.usdtCnyTtlMs = 60_000; // USDT→CNY 缓存 1 分钟
  try {
    const { getRates } = await freshRates();
    await getRates();
    assert.deepEqual(
      { ticker: net.calls.ticker, usdtSources: net.calls.coinbase + net.calls.erapi + net.calls.frankfurter },
      { ticker: 1, usdtSources: 3 },
      '第一轮：两条腿都要拉'
    );
    for (let i = 0; i < 4; i += 1) await getRates();
    assert.equal(net.calls.ticker, 5, 'BTY 每次都跟新（4 次后续调用各打一次官方 ticker）');
    assert.equal(net.calls.coinbase, 1, 'USDT→CNY 仍在缓存期内：Coinbase 只被打过 1 次');
    assert.equal(net.calls.erapi, 1);
    assert.equal(net.calls.frankfurter, 1);
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

test('只刷该刷的腿②：BTY 还在缓存期、USDT-CNY 过期 → 只打三个公共汇率源', async () => {
  const net = installFetch();
  const warn = captureWarn();
  const restoreCfg = isolate();
  cfg.rates.btyTtlMs = 60_000; // BTY 缓存 1 分钟
  cfg.rates.usdtCnyTtlMs = 0; // USDT→CNY 每次都要刷新
  try {
    const { getRates } = await freshRates();
    await getRates();
    for (let i = 0; i < 3; i += 1) await getRates();
    assert.equal(net.calls.ticker, 1, 'BTY 没到期：官方 ticker 只被打过 1 次');
    assert.equal(net.calls.coinbase, 4, 'USDT→CNY 每次都刷');
    assert.equal(net.calls.erapi, 4);
    assert.equal(net.calls.frankfurter, 4);
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

test('两条腿各自记错：BTY 挂了不影响 USDT→CNY 的取数，反之亦然', async () => {
  const net = installFetch();
  const warn = captureWarn();
  const restoreCfg = isolate();
  cfg.rates.btyTtlMs = 60_000;
  cfg.rates.usdtCnyTtlMs = 60_000;
  try {
    const { getRates } = await freshRates();
    const good = await getRates();
    assert.equal(good.stale, false);
    assert.equal(good.usdtCnyLegs, 3);

    // 只让官方 ticker 挂掉，并让 BTY 立刻算"过期"（USDT→CNY 仍在 TTL 内，不该被重拉）
    cfg.rates.btyTtlMs = 0;
    net.restore();
    const dead = installFetch(['ticker']);
    const r = await getRates();
    assert.equal(r.btyUsdt, good.btyUsdt, 'BTY 保留旧值');
    assert.equal(r.usdtCnyLegs, 3, 'USDT→CNY 照常上报三条腿');
    assert.equal(r.stale, true, '整体标 stale —— 有一条腿没有新值，就不能说"都是实时价"');
    assert.match(r.error, /BTY-USDT/);
    assert.ok(!/USDT-CNY/.test(r.error), '没挂的那条腿不该被记错');
    assert.ok(r.btyUpdatedAt >= good.btyUpdatedAt, '失败的这一轮也要更新"上次尝试时刻"');
    assert.equal(r.usdtUpdatedAt, good.usdtUpdatedAt, 'USDT→CNY 还在 TTL 内，取数时刻不变');
    assert.equal(r.updatedAt, Math.min(r.btyUpdatedAt, r.usdtUpdatedAt), 'updatedAt 报两条腿里较旧的那一半');

    // 从未取到值的腿进负缓存：连着调两次 refreshRates，官方 ticker 只被打一次
    const net2 = installFetch(['ticker']);
    const { refreshRates } = await freshRates(); // 新实例：BTY 从未成功过
    await refreshRates();
    const after1 = net2.calls.ticker;
    await refreshRates();
    assert.equal(net2.calls.ticker, after1, 'BTY 无值 → 30 秒负缓存内不重复打官方 ticker（否则故障时每请求一次）');
    net2.restore();
    dead.restore();
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

test('single-flight：并发取汇率只打一轮上游（缓存过期的瞬间最容易被放大）', async () => {
  const net = installFetch();
  const warn = captureWarn();
  const restoreCfg = isolate();
  try {
    const { getRates } = await freshRates();
    const rs = await Promise.all(Array.from({ length: 8 }, () => getRates()));
    assert.equal(net.total(), 4, '8 个并发请求合并成 1 轮刷新');
    for (const r of rs) assert.equal(r.usdtCny, 6.71);
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

test('single-flight 不吞掉"我要的腿"：正在刷 USDT-CNY 时，BTY 过期仍会另起一轮去拉', async () => {  const net = installFetch();
  const warn = captureWarn();
  const restoreCfg = isolate();
  cfg.rates.btyTtlMs = 60_000;
  cfg.rates.usdtCnyTtlMs = 0; // 每次都要刷 USDT→CNY
  try {
    const { getRates } = await freshRates();
    await getRates(); // 两条腿都拿到值
    // 之后把 BTY 的"上一次取数时刻"改成很久以前 → 只有 BTY 过期
    const r1 = await getRates();
    const btyBefore = net.calls.ticker;
    cfg.rates.btyTtlMs = 0; // 让 BTY 也算过期
    const [a, b] = await Promise.all([getRates(), getRates()]);
    assert.equal(a.btyUsdt, 0.022778);
    assert.equal(b.btyUsdt, 0.022778);
    assert.ok(net.calls.ticker > btyBefore, 'BTY 过期时不会因为"别人在刷 USDT"就被跳过');
    assert.equal(net.calls.ticker, btyBefore + 1, '两个并发调用也只补拉一次（不重复打上游）');
    assert.equal(r1.usdtCnyLegs, 3);
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

/* ══════════════════════════════════════════════════════════════════════
   源码评审 2026-09 补齐的三条（都是"边界/并发"，此前没有被任何用例钉住）
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 兜底汇率**不是**"有实时值"：它必须按负缓存（30 秒）的节奏重试真实源。
 * 旧实现把兜底值直接写进 `cache.usdtCny`，于是这条腿在 `legDue()` 看来"有值" ⇒
 * 要等一个完整 TTL（默认 30 分钟）才重试 —— 上游只是抖一下，门店按手工数字定价半小时。
 */
test('兜底汇率按负缓存节奏重试真实源（而不是睡满一个 TTL）', async (t) => {
  /*
    假时钟要给一个**真实起点**：Node 的 mock Date 默认从 0（1970）起，而 `at = 0` 是"从未取过"
    的哨兵值——两者混在一起就分不出"刚取过"和"没取过"（`legDue()` 里显式判 `!at` 正是为此）。
  */
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const net = installFetch(['coinbase', 'erapi', 'frankfurter']); // 三个源全挂
  const warn = captureWarn();
  const restoreCfg = isolate();
  cfg.rates.usdtCnyTtlMs = 3_600_000; // 该腿 TTL = 1 小时（用它和 30 秒负缓存做区分）
  cfg.rates.fallback.usdtCny = 7.2; // 配了兜底汇率
  try {
    const { getRates, refreshRates } = await freshRates();
    await refreshRates(); // bty 也挂 → 用兜底值补齐两条腿
    const r1 = await getRates();
    assert.equal(r1.usdtCny, 7.2, '行情源全挂时应回退到手工兜底汇率');
    assert.equal(r1.stale, true, '兜底值必须标 stale（它不是实时价）');
    const first = net.calls.coinbase;

    // 31 秒后（> 负缓存 30 秒、< 该腿 TTL 1 小时）：必须已经重试过上游
    t.mock.timers.tick(31_000);
    await refreshRates();
    assert.ok(
      net.calls.coinbase > first,
      `兜底值到期应重试真实源（负缓存 30 秒），实际 coinbase 调用 ${first} → ${net.calls.coinbase}`
    );
  } finally {
    warn.restore(); restoreCfg(); net.restore(); t.mock.timers.reset();
  }
});

/**
 * `force = true` 的语义必须**独立于轮次**：并发场景下"别人正在刷另一条腿"时，
 * 旧写法会在第 1 轮丢掉 force 并直接返回缓存（"两条腿都拉一遍"静默失效）。
 */
test('force：并发遇到"只刷另一条腿"的那一轮，仍要把我这条腿拉一次', async () => {
  const net = installFetch();
  const warn = captureWarn();
  const restoreCfg = isolate();
  cfg.rates.btyTtlMs = 60_000; // BTY 新鲜 → 不会被 due 判成需要
  cfg.rates.usdtCnyTtlMs = 0; // USDT→CNY 每轮都刷
  try {
    const { getRates, refreshRates } = await freshRates();
    await getRates(); // 两条腿都拿到值
    const tickerBefore = net.calls.ticker;

    // 先起一轮"只覆盖 USDT→CNY"的刷新（BTY 还新鲜），再并发一次 force
    const p1 = getRates();
    const p2 = refreshRates(true);
    await Promise.all([p1, p2]);

    assert.ok(
      net.calls.ticker > tickerBefore,
      `force 必须真的去取一次 BTY（即使别人正在刷 USDT），实际 ticker ${tickerBefore} → ${net.calls.ticker}`
    );
  } finally {
    warn.restore(); restoreCfg(); net.restore();
  }
});

/* ══════════════════════════════════════════════════════════════════════
   单飞协作的判定（planRefresh / starvedLegs）
   为什么抽出来测：`refreshRates()` 里"3 轮都用尽、我要的腿始终没被覆盖"那条路径，
   在真实定时器下几乎构造不出来——它要求连续 3 轮都恰好排成"只覆盖另一条腿"的在途刷新
   （而 due 是全局的：只要我的腿过期了，任何**新起**的一轮都会带上它）。
   源码评审指出这条路径**没有任何用例**，而它正是 `snapshot().stale` 的第二个来源：
   判错就会拿一个比 TTL 更旧的价、却对买家声称 stale=false（静默失准）。
   于是把判定抽成纯函数、直接钉死；执行部分由上面几条端到端用例覆盖。
   ══════════════════════════════════════════════════════════════════════ */

test('planRefresh：别人这一轮已经覆盖过的腿，不再重复拉（单飞语义）', async () => {
  const { planRefresh } = await freshRates();
  const { need, want } = planRefresh({
    due: { bty: true, cny: true },
    force: false,
    covered: { bty: false, cny: true },
  });
  assert.deepEqual(need, { bty: true, cny: true }, '两条腿都过期了，就都算"需要"');
  assert.deepEqual(want, { bty: true, cny: false }, 'USDT 已被在途轮次覆盖过 → 只补 BTY');
});

test('planRefresh：force 独立于轮次（覆盖过的不重复拉，没覆盖的必须拉）', async () => {
  const { planRefresh } = await freshRates();
  // 第 1 轮之后的典型状态：别人那一轮只覆盖了 USDT（BTY 还新鲜），所以 due 全为 false
  const { want } = planRefresh({ due: { bty: false, cny: false }, force: true, covered: { bty: false, cny: true } });
  assert.deepEqual(want, { bty: true, cny: false }, 'force 仍要拉 BTY；覆盖过的 USDT 不重复拉（单飞语义不变）');
  // 两条腿都被覆盖过 → 无事可做（调用方据此直接返回缓存）
  const idle = planRefresh({ due: { bty: false, cny: false }, force: true, covered: { bty: true, cny: true } });
  assert.deepEqual(idle.want, { bty: false, cny: false });
});

test('starvedLegs：3 轮用尽 → 没被覆盖的腿必须如实标记（这就是 stale 的第二个来源）', async () => {
  const { starvedLegs } = await freshRates();
  // 极端并发：连续 3 轮都是"只覆盖 USDT"的在途刷新，而 BTY 确实该刷
  const starved = starvedLegs({ due: { bty: true, cny: false }, force: false, covered: { bty: false, cny: true } });
  assert.deepEqual(starved, { bty: true, cny: false }, 'BTY 该刷却没被任何一轮覆盖 → 必须报 stale，不能装作是新的');
  // 覆盖到了就不算 starved（否则正常并发会被误报成 stale）
  const fine = starvedLegs({ due: { bty: true, cny: false }, force: false, covered: { bty: true, cny: false } });
  assert.deepEqual(fine, { bty: false, cny: false });
  // 本来就不需要它（TTL=0 排障配置下 due 恒真，这条判据是"需要但没被覆盖"，不是"过期了"）
  const notNeeded = starvedLegs({ due: { bty: false, cny: false }, force: false, covered: { bty: false, cny: false } });
  assert.deepEqual(notNeeded, { bty: false, cny: false });
});