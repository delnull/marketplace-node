/**
 * 汇率服务：USDT 计价 → 原生 BTY 支付换算的行情来源。
 *
 * 唯一数据源：官方行情 mainnet.bityuan.com/tapi/ticker（BTY-USDT：
 * code==0 且 data.data.USDT.BTY.last）——缓存短（默认 60 秒，MK_BTY_TTL_MS）：
 * 它直接决定"买家要付多少 BTY"，要跟得住。
 * 上游不可用时回退 config.rates.fallback.btyUsdt 手工汇率（标记 stale=true）。
 *
 * 为什么只有一条腿（2026-10 改标价单位为 USDT）：标价本身就是 USDT（微 USDT，6 位小数），
 * 而链上托管只收原生 BTY，所以**唯一**需要的换算是「USDT → BTY」。旧实现还有一条
 * USDT→CNY 的法币腿（3 家免密钥公共接口 + 中位数 + 合理性区间），那是为"人民币标价"服务的；
 * 标价改成 USDT 之后它与定价再无关系，整条腿连同其数据源、缓存 TTL、兜底汇率与
 * orders.usdt_cny_rate 快照列一并删除——留着只会是"看起来还在参与定价"的死代码。
 *
 * 汇率仅用于：商品详情展示换算、下单时锁定应付金额（订单快照记录汇率，
 * 实际支付金额由买家签名确认的 wei 数为准）。波动风险由买家签名前确认承担。
 * 本文件只管**原生 BTY** 的 USDT→BTY 换算；ERC20 报价在 paymentTokens.js。
 */
import config from './config.js';

const BTY_TICKER_URL = 'https://mainnet.bityuan.com/tapi/ticker';

/**
 * 缓存：`atBty` 记的是**上一次尝试时刻**（失败也更新），这样失败自然进入负缓存，
 * 不会因为"有个旧值"就每个请求都去打一轮上游。
 */
let cache = {
  btyUsdt: null, // 1 BTY = x USDT
  atBty: 0,
  btyError: null,
  /*
    当前服务的是**手工兜底值**（不是实时行情）。
    为什么要单独记（源码评审 2026-09）：兜底值一旦写进 `btyUsdt`，在 `legDue()` 看来就是
    "有值"，于是要等一个完整 TTL 才去重试真实行情源 —— 上游只是抖了一下，
    门店却按一个手工数字定价一个 TTL。所以让它按负缓存（30 秒）的节奏重试。
  */
  btyFallback: false,
};

/**
 * 失败负缓存 TTL：**从未取到过值**（或当前服务的是手工兜底值）且上游不可用时，
 * 短时间内不重复打上游，否则"上游全挂"会被放大成"每个请求都去打一轮上游"。
 * 已经有**实时**值的腿按自己的 TTL 走。
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

/** 进行中的刷新 Promise（single-flight：TTL 边界并发请求只打一次上游） */
let inflight = null;

/**
 * 这条腿是否到了该刷新的时刻。
 * 有**实时**值 → 按自己的 TTL；从未取到过值、或当前服务的是**手工兜底值** → 按失败负缓存
 * （NEGATIVE_TTL_MS），否则"上游全挂"会被放大成"每个请求都去打一轮上游"（这正是要防的封杀路径）。
 * 兜底值也走负缓存是有意的：它不代表上游好了，只是"先给个能下单的数"，必须持续重试真实源
 * （见 `cache.btyFallback` 的说明）。
 *
 * `at === 0` 显式判为"没取过"：不要依赖"`Date.now()` 一定远大于 0"这个隐含前提——
 * 一旦时钟从 0 起（测试里的假时钟、或极端环境），`0 - 0 >= TTL` 会算出"还不该刷"，
 * 于是**永远不发起第一次请求**（真实的调试经历：页面一直是"待汇率"）。
 */
function legDue(at, value, ttlMs, isFallback) {
  if (!at) return true; // 从未尝试过（含时钟从 0 起的场景）
  return Date.now() - at >= (value === null || isFallback ? NEGATIVE_TTL_MS : ttlMs);
}

/**
 * 刷新缓存（带 TTL）。
 *
 * · 上游失败不丢旧值：保留上一轮的实时值（"上一轮的实时值"仍比"没有价格"强）；
 *   从未取到过值且配了兜底汇率才回退兜底值，并把错误记在 error 上（stale 由此得出）；
 * · `force = true` 只是"跳过新鲜度检查"，**不绕过单飞**（源码审计 2026-09 复审，P3）。
 *   single-flight 的 `.finally` 必须**自比较后再清空**：旧实现在 force 路径上既不查也不设
 *   `inflight`，于是并发 force 调用各起一轮，**先结束的那一轮**会把**后一轮**的句柄清成 null ——
 *   后面来的非 force 调用又起一轮，`cache` 由后写覆盖先写（丢更新）。
 * · 改标价单位为 USDT 后只剩这一条腿，旧实现里"两条腿各自 TTL + 在途轮次未必覆盖我要的腿"
 *   那套协调逻辑（planRefresh / starvedLegs / 负缓存轮询）随之删除：一轮刷新必然覆盖全部需要的东西。
 */
export async function refreshRates(force = false) {
  if (!force && !legDue(cache.atBty, cache.btyUsdt, config.rates.btyTtlMs, cache.btyFallback)) return cache;
  if (inflight) {
    // 抓住手里这一轮（inflight 可能马上被清空）；它必然覆盖这条唯一的腿
    const round = inflight;
    try {
      await round;
    } catch {
      /* doRefresh 内部已兜住失败，这里只是不让异常冒泡打断调用方 */
    }
    return cache;
  }
  const p = doRefresh().finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}

/**
 * 真正去打上游。**永不 reject**，否则等待者会被别人的失败打断。
 */
async function doRefresh() {
  try {
    const v = await fetchBtyUsdt();
    cache.btyUsdt = v;
    cache.atBty = Date.now();
    cache.btyError = null;
    cache.btyFallback = false; // 拿到实时值 → 不再算"兜底中"
  } catch (e) {
    cache.atBty = Date.now();
    cache.btyError = `BTY-USDT: ${e?.message || e}`;
  }
  // 拉取失败：保留旧值；从未成功过则回退手工兜底汇率（未配置为 0 则保持 null）。
  // 兜底值会打上 fallback 标记：它按负缓存节奏重试（见 legDue），而不是被当成"有值"睡满一个 TTL。
  if (cache.btyError && cache.btyUsdt === null && config.rates.fallback.btyUsdt > 0) {
    cache.btyUsdt = config.rates.fallback.btyUsdt;
    cache.btyFallback = true;
  }
  return cache;
}

/**
 * 对外快照：取数时刻与错误如实带出去。
 * `usdtToBty` = 1 USDT = x BTY（前端展示换算、下单锁定金额都用它）。
 * `fallback` = 当前这个数是 `MK_FALLBACK_BTY_USDT` 的**手工值**（不是行情）——它和"缓存里
 * 上一轮的实时值"对买家的含义完全不同（一个是店主填的数、一个是旧行情），
 * 所以必须分开报：只报 `stale` 会让店主以为"只是有点滞后"（源码评审 2026-10，P1）。
 */
function snapshot() {
  return {
    btyUsdt: cache.btyUsdt,
    // 1 USDT = x BTY
    usdtToBty: 1 / cache.btyUsdt,
    stale: Boolean(cache.btyError),
    fallback: cache.btyFallback,
    error: cache.btyError || null,
    updatedAt: cache.atBty,
  };
}

/** 当前汇率（可能触发一次后台刷新）；无任何可用值时返回 null 由调用方降级 */
export async function getRates() {
  const r = await refreshRates();
  if (!r.btyUsdt) return null;
  return snapshot();
}

/**
 * 将 USDT 金额（**微 USDT**，6 位小数）换算为原生 BTY wei（decimals=18）。
 * 纯整数运算 + 无条件向上取整（ceil），与文档契约「向上取整 1 wei 防少付」一致：
 *   wei = ceil( micro/1e6 USDT ÷ btyUsdt BTY/USDT × 1e18 )
 * 上游汇率为浮点，先放大 1e8 转整数（保留 8 位有效精度，远超行情源实际精度），
 * 再做 BigInt 除法取整。旧实现用 double toFixed 截断会低付 ≤1 wei 量级且修正分支为死代码。
 * @returns {string} wei 字符串
 */
export function usdtMicroToPayWei(usdtMicro, rates) {
  const n = Number(usdtMicro);
  /*
    非有限数一律按 0（`Infinity` / `NaN`）：本函数的契约是"退化就返回 '0'，由调用方的
    isPayableAmount 把草稿拦住"，而 `BigInt(Infinity)` 会**抛 RangeError** —— 一个导出的
    金额函数不该用异常来表达"没有值"（源码评审 2026-10，P3；当前路由侧入参恒为有限整数，
    但直连调用/将来的调用方不该踩这个坑）。
  */
  if (!Number.isFinite(n) || n <= 0) return '0';
  const micro = BigInt(Math.trunc(n));
  if (micro <= 0n) return '0';
  const scaled = Math.round(Number(rates?.btyUsdt) * 1e8); // btyUsdt 放大 1e8 为整数（>0 已由调用方保证）
  if (!Number.isFinite(scaled) || scaled <= 0) return '0';
  // wei = ceil( micro × 1e18 ÷ (btyUsdt × 1e6) ) = ceil( micro × 1e18 × 1e8 ÷ (scaled × 1e6) )
  const numerator = micro * 10n ** 18n * 100_000_000n;
  const denominator = BigInt(scaled) * 1_000_000n;
  return ((numerator + denominator - 1n) / denominator).toString();
}

/**
 * 折算结果是否可用于建单：纯数字且 > 0。
 *
 * 为什么必须有这道闸（源码评审 2026-09，P1）：`usdtMicroToPayWei` 在汇率退化时**返回 '0'**
 * （`scaled` 非有限数或 ≤ 0，例如行情源返回垃圾值、或汇率缺失）。调用方原来只判
 * `if (!rates)`（数据源**完全**拿不到），于是 amountWei='0' 的草稿会落库；而链上
 * `Escrow.createOrder` 有 `if (amount == 0) revert InvalidAmount()` ⇒ 这张草稿**永远付不掉**，
 * 却一直占着库存占位与「同买家 10 张草稿」的额度，直到 30 分钟 TTL 清扫。
 * 判据单独成函数是为了可测：路由只用它，不自己写正则。
 */
export function isPayableAmount(amountWei) {
  const s = String(amountWei ?? '');
  return /^\d+$/.test(s) && BigInt(s) > 0n;
}
