/**
 * 节点级 ERC20 支付资产配置与报价（**节点自己的策略**，不依赖 Registry）。
 *
 * 配置存在节点库 `payment_tokens` 表，由节点主在网页「节点管理 → ERC20 支付资产」维护：
 * 地址 / symbol / decimals / 报价方式 / 固定价或行情源。**没有环境变量**——改完即生效，
 * 不再需要重启进程。
 *
 * 与链上的分工（不是两份真相）：
 *   · 本表决定"节点愿不愿意报价"；
 *   · `Escrow.supportedToken` 决定"合约能不能收"；
 *   · 公开支付方式接口把两者取交集，草稿也会先读链上白名单，读不到就 fail-closed。
 *
 * 价格语义固定为 **1 个整 token 值多少 USDT**（微 USDT），避免"token 数量 / USDT"方向混淆。
 * 报价用 BigInt 向上取整，不接受低精度浮点作为最终金额。
 */
import { Contract, isAddress } from 'ethers';
import { getDb } from './db.js';
import { assertPublicHttpTarget } from './netguard.js';

const PRICE_TTL_MS = 30_000;
const priceCache = new Map(); // url -> { at, usdtMicroPerToken, stale }

/**
 * 归一化一条支付资产配置（**唯一校验实现**：启动、写入、测试共用）。
 * 入参既可以是 API body（camelCase），也可以是 DB 行（snake_case）。
 * @returns {{address:string,symbol:string,decimals:number,mode:'fixed'|'oracle',fixed:string|null,priceUrl:string}}
 */
export function normalizePaymentToken(input) {
  const address = String(input?.address ?? input?.token ?? '').trim().toLowerCase();
  if (!isAddress(address)) throw new Error('支付资产地址非法（需 0x 开头的 40 位十六进制）');
  const symbol = String(input?.symbol ?? '').trim();
  if (!symbol) throw new Error('支付资产 symbol 不能为空');
  if (symbol.length > 20) throw new Error('支付资产 symbol 不能超过 20 字符');
  const decimals = Number(input?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error('支付资产 decimals 需为 0..36 的整数');
  }
  const mode = String(input?.mode ?? 'fixed').trim();
  if (mode !== 'fixed' && mode !== 'oracle') throw new Error('报价方式只能是 fixed 或 oracle');
  const fixedRaw =
    input?.fixedUsdtMicroPerToken ?? input?.fixed_usdt_micro_per_token ?? input?.fixed ?? null;
  const fixed = fixedRaw === null || fixedRaw === undefined || String(fixedRaw).trim() === ''
    ? null
    : String(fixedRaw).trim();
  if (fixed !== null && (!/^\d+$/.test(fixed) || BigInt(fixed) <= 0n)) {
    throw new Error('1 个 token 折多少微 USDT 需为正整数');
  }
  const priceUrl = String(input?.priceUrl ?? input?.price_url ?? '').trim();
  if (priceUrl && !/^https:\/\//i.test(priceUrl)) throw new Error('行情源只接受 https://');
  if (mode === 'fixed' && fixed === null) throw new Error('fixed 报价必须填写 1 个 token 折多少微 USDT');
  if (mode === 'oracle' && !priceUrl) throw new Error('oracle 报价必须填写行情源 URL');
  return { address, symbol, decimals, mode, fixed, priceUrl };
}

/** 读出本节点的支付资产配置（原始形；只有节点主 API 与启动自检使用）。 */
export async function listPaymentTokenConfigs() {
  const rows = await getDb().all(
    `SELECT address, symbol, decimals, mode,
            fixed_usdt_micro_per_token AS fixed_usdt_micro,
            price_url
       FROM payment_tokens ORDER BY created_at ASC, address ASC`
  );
  return rows.map((r) => ({
    address: String(r.address),
    symbol: String(r.symbol),
    decimals: Number(r.decimals),
    mode: r.mode === 'oracle' ? 'oracle' : 'fixed',
    fixed: r.fixed_usdt_micro == null ? null : String(r.fixed_usdt_micro),
    priceUrl: r.price_url ? String(r.price_url) : '',
  }));
}

/**
 * 新增/更新一条配置（同一地址覆盖）。页面保存、测试夹具共用这一个写入口。
 * 地址不合法/字段非法时抛错；数据库 CHECK 是第二道兜底。
 */
export async function upsertPaymentToken(input) {
  const t = normalizePaymentToken(input);
  await getDb().run(
    `INSERT INTO payment_tokens
       (address, symbol, decimals, mode, fixed_usdt_micro_per_token, price_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       symbol = VALUES(symbol),
       decimals = VALUES(decimals),
       mode = VALUES(mode),
       fixed_usdt_micro_per_token = VALUES(fixed_usdt_micro_per_token),
       price_url = VALUES(price_url),
       updated_at = CURRENT_TIMESTAMP(3)`,
    t.address, t.symbol, t.decimals, t.mode, t.fixed, t.priceUrl || null
  );
  return t;
}

/** 删除一条配置（只停止未来报价；已托管订单仍按订单快照里的支付资产结算）。 */
export async function deletePaymentToken(address) {
  const addr = String(address ?? '').trim().toLowerCase();
  if (!isAddress(addr)) throw new Error('支付资产地址非法');
  const r = await getDb().run('DELETE FROM payment_tokens WHERE address = ?', addr);
  return r.changes === 1;
}

/**
 * 读 token 合约的 `decimals()` 并与配置比对（**唯一实现**：启动自检与页面保存共用）。
 * 读不到 / 不一致都抛错——精度写错会让报价差若干个数量级，不能静默继续。
 */
export async function assertTokenDecimals(address, expected) {
  const addr = String(address ?? '').trim().toLowerCase();
  if (!isAddress(addr)) throw new Error('支付资产地址非法');
  const { getProvider } = await import('./chain.js');
  const c = new Contract(addr, ['function decimals() view returns (uint8)'], getProvider());
  let onchain;
  try {
    onchain = Number(await c.decimals());
  } catch (e) {
    throw new Error(`读不到 token ${addr} 的 decimals()：${e?.message || e}（拒绝保存/启动）`);
  }
  if (!Number.isInteger(onchain) || onchain !== Number(expected)) {
    throw new Error(`token ${addr} 的链上 decimals=${onchain} 与配置 decimals=${expected} 不一致`);
  }
  return onchain;
}

/** 启动期语法/库形状自检（不触网）：非法配置应拒绝启动。 */
export async function validatePaymentTokens() {
  const rows = await listPaymentTokenConfigs();
  // DB CHECK 已经挡住大多数坏形状；这里再走同一套归一化，挡住手工改库/迁移残留。
  return rows.map((r) => normalizePaymentToken(r));
}

/** 启动期链上精度自检：配置里的 decimals 必须等于 token 合约的 decimals()。 */
export async function validatePaymentTokensOnChain() {
  const tokens = await listPaymentTokenConfigs();
  for (const t of tokens) await assertTokenDecimals(t.address, t.decimals);
}

async function oracleRate(token) {
  const hit = priceCache.get(token.priceUrl);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return { rate: hit.usdtMicroPerToken, stale: hit.stale };
  try {
    /*
      行情源 URL 现在是页面可配的，必须先过 SSRF 闸：内网/回环/云元数据地址不能成为节点
      出站 GET 的目标。解析与 fetch 的二次解析之间仍有 DNS rebinding 窗口（配置仅节点主可写，
      风险面已收窄）；彻底闭环需要 GET 版 pinnedRequest，见 netguard 的说明。
    */
    const target = await assertPublicHttpTarget(token.priceUrl);
    if (!target.ok) throw new Error(target.message);
    const res = await fetch(token.priceUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    let v = body?.usdtMicroPerToken;
    if (v == null && body?.usdt != null) {
      const f = Number(body.usdt);
      if (Number.isFinite(f) && f > 0) v = Math.round(f * 1e6);
    }
    const s = String(v ?? '');
    if (!/^\d+$/.test(s) || BigInt(s) <= 0n) throw new Error('价格字段非法');
    const rate = BigInt(s);
    priceCache.set(token.priceUrl, { at: Date.now(), usdtMicroPerToken: rate, stale: false });
    return { rate, stale: false };
  } catch (e) {
    /*
      兜底值不是 oracle 报价：返回 stale=true，订单必须把“这一单其实按 fixed 兜底”
      写进快照。只返回 rate 会让 payment_rate_source='oracle' 变成一句假话。
    */
    if (token.fixed) return { rate: BigInt(token.fixed), stale: true };
    throw new Error(`行情源不可用：${e?.message || e}`);
  }
}

async function currentRate(token) {
  return token.mode === 'oracle' ? oracleRate(token) : { rate: BigInt(token.fixed), stale: false };
}

function amountFor(totalUsdtMicro, token, rate) {
  const scale = 10n ** BigInt(token.decimals);
  return ((BigInt(totalUsdtMicro) * scale + rate - 1n) / rate).toString();
}

/** 公开的支付方式（金额可选；无 total 时只给币种与当前汇率）。 */
export async function listPaymentMethods(totalUsdtMicro = null) {
  const tokens = await listPaymentTokenConfigs();
  const out = [];
  for (const t of tokens) {
    try {
      const q = await currentRate(t);
      const amount = totalUsdtMicro != null ? amountFor(totalUsdtMicro, t, q.rate) : null;
      out.push({
        token: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
        mode: t.mode,
        usdtMicroPerToken: q.rate.toString(),
        stale: q.stale,
        quotedAt: new Date().toISOString(),
        amountWei: amount,
      });
    } catch (e) {
      out.push({
        token: t.address,
        symbol: t.symbol,
        decimals: t.decimals,
        mode: t.mode,
        unavailable: String(e?.message || e),
      });
    }
  }
  return out;
}

/** 为订单报价；token=address(0)/'native' 由调用方走原生 BTY。 */
export async function quotePaymentToken(tokenAddress, totalUsdtMicro) {
  const token = String(tokenAddress || '').toLowerCase();
  if (!isAddress(token) || /^0x0{40}$/.test(token)) return null;
  const cfg = (await listPaymentTokenConfigs()).find((x) => x.address === token);
  if (!cfg) return null;
  const q = await currentRate(cfg);
  return {
    token: cfg.address,
    symbol: cfg.symbol,
    decimals: cfg.decimals,
    mode: cfg.mode,
    usdtMicroPerToken: q.rate.toString(),
    stale: q.stale,
    quotedAt: new Date().toISOString(),
    amountWei: amountFor(totalUsdtMicro, cfg, q.rate),
  };
}

/**
 * 链上白名单的唯一的按 token 检查（报价/草稿/公开列表共用）。
 * 读不到就抛错，由调用方按"本次不可支付"处理——不把 RPC 失败折成 false 或 true。
 */
let _tokenSupportReader = async (tokenAddress) => {
  const { getEscrow } = await import('./chain.js');
  return !!(await getEscrow().supportedToken(tokenAddress));
};

/** 测试注入链上白名单读取器（传 null 恢复默认）——与 chainOrder.setChainOrderFetcher 同款 */
export function setTokenSupportReader(fn) {
  _tokenSupportReader = fn || (async (tokenAddress) => {
    const { getEscrow } = await import('./chain.js');
    return !!(await getEscrow().supportedToken(tokenAddress));
  });
}

export async function tokenSupportedOnChain(tokenAddress) {
  return !!(await _tokenSupportReader(tokenAddress));
}

/** 删除缓存（测试/运维重载用） */
export function clearPaymentRateCache() {
  priceCache.clear();
}
