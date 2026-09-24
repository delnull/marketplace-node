/**
 * 汇率服务：CNY 计价 → 原生 BTY 支付换算的行情来源。
 *
 * 数据源（两条腿，各自缓存、各自失败）：
 *  1. 官方行情 mainnet.bityuan.com/tapi/ticker（BTY-USDT：code==0 且 data.data.USDT.BTY.last）
 *     —— **缓存短**（默认 60 秒，MK_BTY_TTL_MS）：它直接决定"买家要付多少 BTY"，要跟得住
 *  2. USDT→CNY：**多源并行 + 中位数**（见下方 USDT_CNY_SOURCES 的说明：OKX 的 CNY 交易对已下线，
 *     只靠单一源等于把全站定价挂在别人的可用性上）—— **缓存长**（默认 30 分钟，MK_RATES_TTL_MS）：
 *     三家都是免密钥公共接口，缓存就是可用性
 *  3. config.rates.fallback 手工汇率（全部不可用时回退，标记 stale=true）
 *
 * 汇率仅用于：商品详情展示换算、下单时锁定应付金额（订单快照记录汇率，
 * 实际支付金额由买家签名确认的 wei 数为准）。波动风险由买家签名前确认承担。
 * 支付币种为原生 BTY（2026-09 收敛），不再支持 ERC20 代币路径。
 */
import config from './config.js';

const BTY_TICKER_URL = 'https://mainnet.bityuan.com/tapi/ticker';

/**
 * 两条腿的缓存**各自独立**（2026-09 拆分）。原来的实现是一个 `at` 管两条腿、一个 TTL 管两件事，
 * 结果是"要么把官方 BTY 行情缓存到 15 分钟（价格跟不住），要么为了跟紧 BTY 把三家公共汇率接口
 * 打成每 3 分钟一轮（被限速/封杀）"。这两条腿的上游性质完全不同：
 *   · BTY-USDT（官方 ticker）：我们自己的行情端点，且直接决定"买家要付多少 BTY" → 跟得紧（60 秒）
 *   · USDT→CNY（3 家免密钥公共接口）：缓存就是可用性 → 放长（30 分钟）
 * `atBty` / `atCny` 记的是**上一次尝试时刻**（失败也更新），这样失败的那条腿自然进入负缓存，
 * 不会因为"有个旧值"就每个请求都去打一轮上游。
 */
let cache = {
  btyUsdt: null, // 1 BTY = x USDT
  atBty: 0,
  btyError: null,
  /*
    这条腿当前服务的是**手工兜底值**（不是实时行情）。
    为什么要单独记（源码评审 2026-09）：兜底值一旦写进 `btyUsdt`，这条腿在 `legDue()` 看来就是
    "有值"，于是要等一个完整 TTL（默认 30 分钟）才去重试真实行情源 —— 上游只是抖了一下，
    门店却按一个手工数字定价半小时。旧实现同样是这个模式，只是当时 TTL 是 3 分钟、不明显；
    TTL 抬到 30 分钟后必须把它标出来，让它按负缓存（30 秒）的节奏重试。
  */
  btyFallback: false,
  usdtCny: null, // 1 USDT = x CNY
  atCny: 0,
  cnyError: null,
  cnyFallback: false,
  usdtCnySource: '',
  usdtCnyLegs: 0,
};

/**
 * 失败负缓存 TTL：某条腿**从未取到过值**（或当前服务的是手工兜底值）且上游不可用时，
 * 短时间内不重复打上游。
 * 30 秒（原 15 秒，2026-09 随缓存 TTL 一起放宽）：USDT→CNY 有 3 个源、"全灭"通常意味着
 * 本机出网有问题，这时每 15 秒打一轮 3 个上游纯属加剧问题；30 秒仍能保证恢复后一分钟内用上实时值。
 * （已经有**实时**值的腿按各自的 TTL 走，不受这里影响——旧值比"没有价格"强，但也不该每请求重试。）
 */
const NEGATIVE_TTL_MS = 30_000;

/** 上游一律带上可识别的 UA：公共行情接口普遍对"无 UA/默认 UA"更激进地限速（也便于对方联系我们） */
const UA = 'marketplace-node/0.1 (+https://github.com/delnull/marketplace-node)';

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析官方 /tapi/ticker 响应为 BTY-USDT 价格（2026-09-08 实测结构，与
 * 交易所行情同源）：
 *   {"code":0,"data":{"data":{"USDT":{"BTY":{"last":"0.022778",…}}}},"msg":"success"}
 * 业务码非 0（code===0 才算成功）/ 嵌套缺失 / 非法数值均返回 null（由调用方报错降级）。
 * @returns {number|null}
 */
export function parseBtyTicker(json) {
  if (!json || typeof json !== 'object' || json.code !== 0) return null;
  const raw = json?.data?.data?.USDT?.BTY?.last;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

async function fetchBtyUsdt() {
  const j = await fetchJson(BTY_TICKER_URL);
  const num = parseBtyTicker(j);
  if (num === null) {
    throw new Error(`tapi/ticker 返回异常: ${JSON.stringify(j).slice(0, 120)}`);
  }
  return num;
}

/**
 * 公开 USDT→CNY 行情源。
 *
 * 为什么是"多源 + 中位数"而不是"两条腿谁先回用谁"（2026-09 实测后重做）：
 *   · 原实现是 OKX 与 Coinbase 竞速，而 **OKX 的 USDT-CNY 交易对已下线**（`51001 Instrument ID
 *     does not exist`）、HTX/CoinEx 也没有该交易对（`invalid symbol` / `market not found`）
 *     —— 也就是说"两条腿"实际上早已只剩 Coinbase 一条，链路冗余是假的；
 *   · 单一源意味着"上游一改接口/一被墙，全站定价就没了"（节点会如实报 available:false，
 *     前端降级为"仅 CNY 标价展示"）。而汇率是这个商城里**商品价格的关键**：CNY 标价 → BTY 应付
 *     全靠它折算。
 * 所以这里改成：所有源并行拉取 → 只取落在**合理性区间**内的值 → **取中位数**（单个源抽风/被劫持
 * 不会把价格带偏）→ 一条腿也能用，但会在返回体里如实标出"几条腿活着"并打一条告警。
 */
const USDT_CNY_SOURCES = [
  // 直接给 1 USDT = x CNY
  { name: 'coinbase', url: 'https://api.coinbase.com/v2/exchange-rates?currency=USDT', kind: 'usdt-cny' },
  // USD→CNY（免密钥），再乘 USDT/USD 锚定价
  { name: 'erapi', url: 'https://open.er-api.com/v6/latest/USD', kind: 'usd-cny' },
  { name: 'frankfurter', url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY', kind: 'usd-cny' },
];

/**
 * 合理性区间：1 USDT 兑换多少 CNY。
 * 5–10 覆盖任何现实汇率制度下的取值，同时挡住"上游返回了垃圾"（如 1 或 70）——没有这条，
 * 中位数也可能被两个同时抽风的源带偏。
 */
export const USDT_CNY_MIN = 5;
export const USDT_CNY_MAX = 10;

export function inUsdtCnyBand(v) {
  return Number.isFinite(v) && v >= USDT_CNY_MIN && v <= USDT_CNY_MAX;
}

/** 中位数（偶数个取中间两个的均值）；空数组返回 null */
export function median(values) {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Coinbase：`{data:{currency:'USDT',rates:{CNY:'6.7032…',USD:'0.99985…'}}}` → {usdtCny, usdtUsd} */
export function parseCoinbaseRates(json) {
  const cny = Number(json?.data?.rates?.CNY);
  if (!Number.isFinite(cny) || cny <= 0) return null;
  const usd = Number(json?.data?.rates?.USD);
  return { usdtCny: cny, usdtUsd: Number.isFinite(usd) && usd > 0 ? usd : null };
}

/**
 * USD→CNY 型源 → 数值。
 *   er-api     : `{result:'success', rates:{CNY:6.71347}}`
 *   frankfurter: `{amount:1, base:'USD', rates:{CNY:7.1}}`
 * 两者都是 `rates.CNY`；业务码失败（er-api 的 result !== 'success'）一律返回 null。
 */
export function parseUsdCny(json) {
  if (json && typeof json === 'object' && 'result' in json && json.result !== 'success') return null;
  const cny = Number(json?.rates?.CNY);
  return Number.isFinite(cny) && cny > 0 ? cny : null;
}

/**
 * 从各源结果里挑出 USDT→CNY（**纯函数**，不联网，便于单测）：
 *   · `direct`：直接给的 USDT→CNY（`directName` 是它的源名，只用于上报"这条腿是谁"）
 *   · `usdCny`：USD→CNY 列表（er-api / frankfurter），需乘 `peg`（USDT/USD，取不到按 1）
 *   · 全部候选先过合理性区间，再取中位数；一条腿也接受（如实报告 legs=1）
 * 源名由调用方传入而不是写死：`usdtCnySource` 会出现在 /api/rates 和告警里，
 * 写死的话换源/加源后会对外报出一个**错误的来源**（诊断信息比没有更糟）。
 * @returns {{value:number|null, source:string, legs:number, rejected:string[]}}
 */
export function pickUsdtCny({ direct = null, directName = 'coinbase', usdCny = [], peg = 1 } = {}) {
  const pegSafe = Number.isFinite(peg) && peg > 0.9 && peg < 1.1 ? peg : 1;
  const candidates = [];
  const rejected = [];
  if (direct !== null && direct !== undefined) {
    if (inUsdtCnyBand(direct)) candidates.push({ name: directName, value: direct });
    else rejected.push(`${directName}=${direct}`);
  }
  for (const item of usdCny) {
    const v = Number(item?.value) * pegSafe;
    if (inUsdtCnyBand(v)) candidates.push({ name: pegSafe === 1 ? item.name : `${item.name}×peg`, value: v });
    else rejected.push(`${item?.name}=${item?.value}`);
  }
  if (!candidates.length) return { value: null, source: '', legs: 0, rejected };
  const value = median(candidates.map((c) => c.value));
  return {
    value,
    source: candidates.length === 1 ? candidates[0].name : `median(${candidates.map((c) => c.name).join(',')})`,
    legs: candidates.length,
    rejected,
  };
}

/** 并行拉取所有 USDT→CNY 源，交给 pickUsdtCny 决策 */
async function fetchUsdtCny() {
  const settled = await Promise.allSettled(USDT_CNY_SOURCES.map((s) => fetchJson(s.url)));
  let direct = null;
  let directName = '';
  let peg = 1;
  const usdCny = [];
  const failed = [];
  settled.forEach((r, i) => {
    const src = USDT_CNY_SOURCES[i];
    if (r.status !== 'fulfilled') {
      failed.push(`${src.name}: ${r.reason?.message || 'failed'}`);
      return;
    }
    if (src.kind === 'usdt-cny') {
      const parsed = parseCoinbaseRates(r.value);
      if (!parsed) failed.push(`${src.name}: 响应形态异常`);
      else {
        direct = parsed.usdtCny;
        directName = src.name;
        if (parsed.usdtUsd) peg = parsed.usdtUsd;
      }
      return;
    }
    const v = parseUsdCny(r.value);
    if (v === null) failed.push(`${src.name}: 响应形态异常`);
    else usdCny.push({ name: src.name, value: v });
  });
  const picked = pickUsdtCny({ direct, directName, usdCny, peg });
  if (picked.value === null) {
    const reasons = [...failed, ...picked.rejected.map((r) => `${r} 超出合理区间`)].join('; ');
    throw new Error(`USDT-CNY 行情源均不可用${reasons ? `（${reasons}）` : ''}`);
  }
  return { ...picked, failed, peg };
}

/** 进行中的刷新 Promise（single-flight：TTL 边界并发请求只打一次上游） */
let inflight = null;

/**
 * 上一轮 USDT-CNY 的"几条腿活着"签名：只在**状态变化**时打告警，避免每轮刷新刷屏
 */
let lastLegSignature = '';

/**
 * 上一次 `refreshRates()` 结束时"我要的腿没被覆盖"这件事（源码评审 2026-09 新增）。
 *
 * 为什么需要它：极端并发下（3 轮都撞上"只覆盖另一条腿"的在途刷新）函数会直接 `return cache`，
 * 此时缓存可能比 TTL 还旧，而 `stale` 只看 error ⇒ 会以 `stale=false` 报出去（静默失准）。
 * 判据取**"这一轮确实需要它、但它没被覆盖"**，而不是"它已经过期"：后者在 `MK_*_TTL_MS=0`
 * （每次请求都刷新，排障用）下恒为真，会把正常的 TTL=0 配置报成永远 stale。
 */
let lastStarved = { bty: false, cny: false };

/**
 * 某条腿是否到了该刷新的时刻。
 * 有**实时**值 → 按该腿自己的 TTL；从未取到过值、或当前服务的是**手工兜底值** → 按失败负缓存
 * （NEGATIVE_TTL_MS），否则"上游全挂"会被放大成"每个请求都去打一轮上游"（这正是要防的封杀路径）。
 * 兜底值也走负缓存是有意的：它不代表上游好了，只是"先给个能下单的数"，必须持续重试真实源
 * （见 `cache.btyFallback` 的说明）。
 *
 * `at === 0` 显式判为"没取过"：不要依赖"`Date.now()` 一定远大于 0"这个隐含前提——
 * 一旦时钟从 0 起（测试里的假时钟、或极端环境），`0 - 0 >= TTL` 会算出"还不该刷"，
 * 于是**永远不发起第一次请求**（真实的调试经历：整条腿静默卡死，页面一直是"待汇率"）。
 */
function legDue(at, value, ttlMs, isFallback) {
  if (!at) return true; // 从未尝试过（含时钟从 0 起的场景）
  return Date.now() - at >= (value === null || isFallback ? NEGATIVE_TTL_MS : ttlMs);
}

function dueParts() {
  return {
    bty: legDue(cache.atBty, cache.btyUsdt, config.rates.btyTtlMs, cache.btyFallback),
    cny: legDue(cache.atCny, cache.usdtCny, config.rates.usdtCnyTtlMs, cache.cnyFallback),
  };
}

/**
 * 单飞协作的两步纯计算：这一轮**需要**哪几条腿、以及扣掉"已经等过的在途轮次覆盖过的"之后
 * **还要**哪几条腿。抽成纯函数是为了能直接钉住判定（见 `starvedLegs`）。
 *
 * `force` 必须**独立于轮次**（源码评审 2026-09 修复）：旧写法只在 `attempt === 0` 让它生效，
 * 于是"别人正好在刷另一条腿"时（第 0 轮 await 完 inflight 后 continue 到第 1 轮）force 被丢掉、
 * `due` 又为 false ⇒ 直接返回缓存，"两条腿都拉一遍"静默失效。
 * 现在 force 只是把两条腿都标成"需要"，覆盖过的照样不重复拉（单飞语义不变）。
 *
 * @param {{due:{bty:boolean,cny:boolean}, force:boolean, covered:{bty:boolean,cny:boolean}}} p
 */
export function planRefresh({ due, force, covered }) {
  const need = { bty: force || due.bty, cny: force || due.cny };
  const want = { bty: need.bty && !covered.bty, cny: need.cny && !covered.cny };
  return { need, want };
}

/**
 * 3 轮用尽时"我要的腿**始终没被覆盖**"的判定 —— 它就是 `snapshot().stale` 的第二个来源。
 *
 * 为什么要单独抽出来：这条路径在真实定时器下几乎构造不出来（要极端并发把连续 3 轮都排成
 * "只覆盖另一条腿"的在途刷新），于是**没测到就等于没写**——评审提过这一点。判定与执行分开之后，
 * 判定本身可以用一个纯函数钉死（`rates-sources.test.js` 里那三条）。
 */
export function starvedLegs({ due, force, covered }) {
  const { need } = planRefresh({ due, force, covered });
  return { bty: need.bty && !covered.bty, cny: need.cny && !covered.cny };
}

/**
 * 冗余告警：USDT-CNY 现在有 3 个源，但**"只剩一条腿"以前是静默的**——/api/rates 里
 * stale=false、error=null，运维完全看不出冗余已经掉光，直到那唯一一条也不可达才突然
 * 全站没有汇率。这里在"腿数变化/有源失败"时打一条告警，且**只在状态变化时打**，
 * 避免每轮刷新刷屏（journalctl 里一条就够定位）。
 */
function warnIfRedundant(v) {
  const sig = `${v.legs}|${v.failed.join(',')}`;
  if (sig === lastLegSignature) return;
  lastLegSignature = sig;
  if (v.legs <= 1 || v.failed.length) {
    console.warn(
      `[rates] USDT-CNY 冗余不足：仅 ${v.legs} 个源可用（${v.source}），` +
        `${v.failed.length} 个源失败${v.failed.length ? `（${v.failed.join('; ')}）` : ''}` +
        `；peg=${v.peg}`
    );
  }
}

/**
 * 刷新缓存（带 TTL，两条腿各自判断）。
 *
 * · 只拉**该拉的那条腿**：BTY 过期就只打官方 ticker，USDT-CNY 还在缓存期内就一个公共接口都不碰
 *   （这正是"USDT 缓存久一点、BTY 跟紧一点"能同时成立的原因）；
 * · 单条腿失败不影响另一条：旧值保留（"上一轮的实时值"仍比"没有价格"强），
 *   从未取到过值且配了兜底汇率才回退兜底值，并把错误记在该腿自己的 error 上（stale 由此得出）；
 * · `force = true` 只是"跳过新鲜度检查、两条腿都拉一遍"，**不再绕过单飞**（源码审计 2026-09 复审，
 *   P3）。single-flight 的 `.finally` 必须**自比较后再清空**：旧实现在 force 路径上既不查也不设
 *   `inflight`，于是并发 force 调用各起一轮，**先结束的那一轮**会把**后一轮**的句柄清成 null ——
 *   后面来的非 force 调用又起一轮，`cache` 由后写覆盖先写（丢更新）。
 * · 两腿独立之后单飞多了一层细节：**别人正在刷的那一轮未必包含我要的腿**（例如它在刷 USDT-CNY，
 *   而我的 BTY 已经过期）。所以等到它结束后按"它覆盖了哪条腿"重新判断：覆盖过的就不再重复拉，
 *   没覆盖过且确实过期的，再起一轮（最多 3 轮，防病态循环）。
 */
export async function refreshRates(force = false) {
  let covered = { bty: false, cny: false };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const due = dueParts();
    // 需要哪几条腿、还要哪几条腿（判定在 planRefresh 里，见那里的注释：force 独立于轮次）
    const { want } = planRefresh({ due, force, covered });
    if (!want.bty && !want.cny) return cache;
    if (inflight) {
      // 抓住手里这一轮（inflight 可能马上被清空），它"覆盖了哪条腿"记在 promise 自己身上
      const round = inflight;
      try {
        await round;
      } catch {
        /* doRefresh 内部已按腿兜住失败，这里只是不让异常冒泡打断调用方 */
      }
      const w = round.want || {};
      covered = { bty: covered.bty || !!w.bty, cny: covered.cny || !!w.cny };
      continue;
    }
    const p = doRefresh(want).finally(() => {
      if (inflight === p) inflight = null;
    });
    p.want = want; // 这一轮的覆盖范围（给等待者判断"我还要不要另起一轮"）
    inflight = p;
    lastStarved = { bty: false, cny: false };
    return p;
  }
  /*
    3 轮用尽：到这里说明每一轮都撞上了"只覆盖另一条腿"的在途刷新。**如实记下"我要的腿没被覆盖"**，
    让 snapshot 把它算进 stale —— 否则会拿一个比 TTL 更旧的价、却声称 stale=false。
  */
  const starved = starvedLegs({ due: dueParts(), force, covered });
  lastStarved = starved;
  if (starved.bty || starved.cny) {
    console.warn(
      `[rates] 刷新被在途轮次挤掉：${['bty', 'cny'].filter((k) => starved[k]).join('+')} 未能覆盖（已按 stale 上报）`
    );
  }
  return cache;
}

/**
 * 真正去打上游。**永不 reject**（每条腿各自 then/catch），否则等待者会被别人的失败打断。
 * @param {{bty:boolean,cny:boolean}} want 本轮要拉哪几条腿
 */
async function doRefresh(want) {
  const jobs = [];
  if (want.bty) {
    jobs.push(
      fetchBtyUsdt().then(
        (v) => {
          cache.btyUsdt = v;
          cache.atBty = Date.now();
          cache.btyError = null;
          cache.btyFallback = false; // 拿到实时值 → 这条腿不再算"兜底中"
        },
        (e) => {
          cache.atBty = Date.now();
          cache.btyError = `BTY-USDT: ${e?.message || e}`;
        }
      )
    );
  }
  if (want.cny) {
    jobs.push(
      fetchUsdtCny().then(
        (v) => {
          cache.usdtCny = v.value;
          cache.atCny = Date.now();
          cache.cnyError = null;
          cache.cnyFallback = false;
          cache.usdtCnySource = v.source;
          cache.usdtCnyLegs = v.legs;
          warnIfRedundant(v);
        },
        (e) => {
          cache.atCny = Date.now();
          cache.cnyError = `USDT-CNY: ${e?.message || e}`;
        }
      )
    );
  }
  await Promise.all(jobs);
  // 拉取失败：保留旧值；从未成功过则回退手工兜底汇率（未配置为 0 则保持 null）。
  // 兜底值会打上 fallback 标记：它按负缓存节奏重试（见 legDue），而不是被当成"有值"睡满一个 TTL。
  if (cache.btyError && cache.btyUsdt === null && config.rates.fallback.btyUsdt > 0) {
    cache.btyUsdt = config.rates.fallback.btyUsdt;
    cache.btyFallback = true;
  }
  if (cache.cnyError && cache.usdtCny === null && config.rates.fallback.usdtCny > 0) {
    cache.usdtCny = config.rates.fallback.usdtCny;
    cache.cnyFallback = true;
  }
  return cache;
}

/**
 * 对外快照：两条腿各自的取数时刻与错误都如实带出去。
 * `updatedAt` 取**两条腿里较旧的那一半**的时刻——"这份报价整体有多新"应该看最保守的那个数，
 * 报最新的一条会让人误以为两边都是刚取的（前端用它做展示/诊断，不参与金额计算）。
 */
function snapshot() {
  const errors = [cache.btyError, cache.cnyError].filter(Boolean);
  return {
    btyUsdt: cache.btyUsdt,
    usdtCny: cache.usdtCny,
    // 1 CNY = x BTY
    cnyToBty: 1 / (cache.btyUsdt * cache.usdtCny),
    // 降级有两种：取数报错，或**这一轮该刷的腿被在途轮次挤掉了**（见 lastStarved 的说明）
    stale: errors.length > 0 || lastStarved.bty || lastStarved.cny,
    error: errors.join('; ') || null,
    updatedAt: Math.min(cache.atBty, cache.atCny),
    btyUpdatedAt: cache.atBty,
    usdtUpdatedAt: cache.atCny,
    // 运维可见的冗余信息：本轮的 USDT-CNY 取数来源与可用源个数
    usdtCnySource: cache.usdtCnySource || null,
    usdtCnyLegs: cache.usdtCnyLegs ?? null,
  };
}

/** 当前汇率（可能触发一次后台刷新）；无任何可用值时返回 null 由调用方降级 */
export async function getRates() {
  const r = await refreshRates();
  if (!r.btyUsdt || !r.usdtCny) return null;
  return snapshot();
}

/**
 * 将 CNY 金额（分）换算为原生 BTY wei（decimals=18）。
 * 纯整数运算 + 无条件向上取整（ceil），与文档契约「向上取整 1 wei 防少付」一致：
 *   wei = ceil( fen/100 CNY ÷ (btyUsdt×usdtCny BTY/CNY) × 1e18 )
 * 上游汇率为浮点，先放大 1e8 转整数（保留 8 位有效精度，远超行情源实际精度），
 * 再做 BigInt 除法取整。旧实现用 double toFixed 截断会低付 ≤1 wei 量级且修正分支为死代码。
 * @returns {string} wei 字符串
 */
export function cnyFenToPayWei(cnyFen, rates) {
  const fen = BigInt(Math.trunc(Number(cnyFen) || 0));
  if (fen <= 0n) return '0';
  const prod = Number(rates.btyUsdt) * Number(rates.usdtCny);
  const scaled = Math.round(prod * 1e8); // btyUsdt×usdtCny 放大 1e8 为整数（>0 已由调用方保证）
  if (!Number.isFinite(scaled) || scaled <= 0) return '0';
  // wei = ceil( fen × 1e18 ÷ (prod × 100) ) = ceil( fen × 1e18 × 1e8 ÷ (scaled × 100) )
  const numerator = fen * 10n ** 18n * 100_000_000n;
  const denominator = BigInt(scaled) * 100n;
  return ((numerator + denominator - 1n) / denominator).toString();
}

/**
 * 折算结果是否可用于建单：纯数字且 > 0。
 *
 * 为什么必须有这道闸（源码评审 2026-09，P1）：`cnyFenToPayWei` 在汇率退化时**返回 '0'**
 * （`prod` 非有限数或 ≤ 0，例如行情源返回垃圾值、或两项里有一项缺失）。调用方原来只判
 * `if (!rates)`（数据源**完全**拿不到），于是 amountWei='0' 的草稿会落库；而链上
 * `Escrow.createOrder` 有 `if (amount == 0) revert InvalidAmount()` ⇒ 这张草稿**永远付不掉**，
 * 却一直占着库存占位与「同买家 10 张草稿」的额度，直到 30 分钟 TTL 清扫。
 * 判据单独成函数是为了可测：路由只用它，不自己写正则。
 */
export function isPayableAmount(amountWei) {
  const s = String(amountWei ?? '');
  return /^\d+$/.test(s) && BigInt(s) > 0n;
}
