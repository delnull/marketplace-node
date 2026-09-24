/**
 * SIWE (EIP-4361) 签名认证 + 轻量 HMAC 会话令牌。
 *
 * SIWE（EIP-4361）流程（BTY 主网 chainId 2999 取硬编码常量，不信任客户端声明），
 * 差异：nonce 落 SQLite（无 Redis 依赖）；登录成功签发 HMAC 令牌，
 * 供商品上架/发货等写操作鉴权（Bearer header）。
 *
 * 流程：
 *  1. GET  /api/auth/nonce?address=0x... -> { message }（含 nonce，存表，TTL）
 *  2. POST /api/auth/login {address, message, signature}
 *     -> 验签恢复地址 == 声明的 address；若 == config.shop.owner 标记 isOwner
 *     -> 返回 { token, address, isOwner }
 */
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { getDb, kvGet } from './db.js';
import config from './config.js';

// ── 店员白名单（原 MK_OPERATORS 已删除：店铺设置「店员管理」写 kv，鉴权每次请求实时读取）──
const OPERATORS_KEY = 'mk:shop_operators';

/** 当前店员白名单（小写地址数组；kv 存储，网页增删，见 routes/shop.js PUT /staff） */
export function getShopOperators() {
  try {
    const raw = kvGet(OPERATORS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((s) => String(s).toLowerCase()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// SIWE 消息中的 Chain ID：谈信 H5 钱包 / BTY 主网固定 2999（EIP-4361 语义）
const SIWE_CHAIN_ID = 2999;

/**
 * 节点 SIWE 身份解析（2026-09 修复：登录签名原文不再硬编码 marketplace.local/http://localhost——
 * 原文身份应指向「本节点后端 API」，钱包弹窗据此可辨识、消息哈希随节点而异）。
 * 取值链（第一个非空生效）：
 *   1) MK_SIWE_DOMAIN：节点对外 API 域名（部署向导填写；可带协议，host[:port] 亦可）；
 *   2) MK_REGISTER_ENDPOINT：链上登记的节点 endpoint（本质即 API 根地址）；
 *   3) config.shop.owner：店主地址小写——无域名的直连/内网部署以店主地址为店铺身份锚
 *      （0x+40hex 为合法 host 标签，消息可正常解析验签；钱包展示为地址串，可区分各店）；
 *   4) 全部为空（纯浏览模式节点）：回退历史占位 marketplace.local。
 * 每请求动态读取（env 变更即生效，测试可注入）。
 */
export function resolveSiweIdentity() {
  const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/i;
  const fallbackOwner = String(config.shop.owner || '').toLowerCase();
  // 1) 显式域名/登记端点优先（MK_SIWE_DOMAIN → MK_REGISTER_ENDPOINT）
  const raw =
    String(process.env.MK_SIWE_DOMAIN || '').trim() ||
    String(process.env.MK_REGISTER_ENDPOINT || '').trim();
  if (raw) {
    try {
      const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      const u = new URL(withScheme);
      const host = u.host; // host[:port]（URL 自动小写 hostname）
      const uri = `${u.protocol}//${u.host}/`;
      // 域名形态健全性：host[:port]、无路径/query/userinfo；异常值继续走兜底
      if (host && HOST_RE.test(host)) {
        return { domain: host, uri };
      }
    } catch {
      /* raw 无法解析为 URL：继续走兜底 */
    }
  }
  // 2) 店主地址兜底：0x+40hex 形态会被 WHATWG URL 解析器当作非法数字型 host 抛错，
  //    且地址本就是"节点身份锚"而非站点——直接构造 domain/URI，不经 URL 解析
  if (fallbackOwner && /^0x[0-9a-f]{40}$/i.test(fallbackOwner)) {
    return { domain: fallbackOwner, uri: `https://${fallbackOwner}/` };
  }
  // 3) 无店主地址的纯浏览节点：历史占位
  return { domain: 'marketplace.local', uri: 'http://localhost' };
}

/** RFC 3339 UTC 时间戳（EIP-4361 规范；严格 SIWE 库按 UTC 解析，带 Z 避免 +8 墙钟被误判超前 8h——审计 F7） */
function rfc3339Utc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildMessage(address) {
  // 节点场景以地址为准，验签不依赖域名；但签名原文身份（domain/URI）必须反映本节点
  // （2026-09 修复：见 resolveSiweIdentity——防统一占位文案掩盖跨店/仿冒 UI）
  const { domain, uri } = resolveSiweIdentity();
  const nonce = crypto.randomBytes(16).toString('hex');
  const nowMs = Date.now();
  const expiresAt = Math.floor(nowMs / 1000) + config.siwe.ttlSeconds;
  const message =
    `${domain} wants you to sign in with your Ethereum account:\n` +
    `${address}\n\n` +
    `欢迎使用去中心化商城节点\n\n` +
    `URI: ${uri}\n` +
    `Version: 1\n` +
    `Chain ID: ${SIWE_CHAIN_ID}\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${rfc3339Utc(nowMs)}\n` +
    `Expiration Time: ${rfc3339Utc(expiresAt * 1000)}`;
  return { message, nonce, expiresAt };
}

/**
 * 生成并存储 SIWE 原文（同地址重复获取覆盖旧 nonce——节点单用户场景足够）。
 * 2026-09 修复（nonce 防覆盖 DoS）：仍存在**未过期**挑战时不再覆盖——否则任何人
 * 对受害者地址 GET /nonce 一次即可顶掉其进行中的登录（受害者钱包签名后回传必失败，
 * 需重新发起；重复触发即成骚扰型 DoS）。未过期挑战原样返回（幂等），过期后正常重发。
 */
export function issueSiwe(address) {
  const addr = address.toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);
  const existing = getDb().prepare('SELECT message, expires_at FROM siwe WHERE address = ?').get(addr);
  if (existing && existing.expires_at > nowSec) {
    return existing.message; // 已有有效挑战：幂等返回，不覆盖
  }
  const { message, expiresAt } = buildMessage(addr);
  getDb()
    .prepare(
      'INSERT INTO siwe (address, message, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(address) DO UPDATE SET message = excluded.message, expires_at = excluded.expires_at'
    )
    .run(addr, message, expiresAt);
  return message;
}

/** 验证 SIWE 签名，成功返回恢复出的地址（校验 message 与地址匹配且未过期） */
export function verifySiwe(address, message, signature) {
  const addr = address.toLowerCase();
  const row = getDb().prepare('SELECT message, expires_at FROM siwe WHERE address = ?').get(addr);
  if (!row) throw new Error('nonce 不存在，请重新获取签名原文');
  if (row.message !== message) throw new Error('签名原文不匹配，请重新获取');
  if (row.expires_at < Math.floor(Date.now() / 1000)) throw new Error('签名原文已过期，请重新获取');

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    throw new Error('签名格式无效');
  }
  if (recovered !== addr) throw new Error('签名地址与声明地址不一致');

  // 一次性使用：验证通过即删除（防重放）
  getDb().prepare('DELETE FROM siwe WHERE address = ?').run(addr);
  return recovered;
}

/** 清理过期 nonce（登录成功会删当前行，此处兜底防表无限膨胀）。返回清理行数。 */
export function cleanupExpiredSiwe(nowMs = Date.now()) {
  const { changes } = getDb()
    .prepare('DELETE FROM siwe WHERE expires_at < ?')
    .run(Math.floor(nowMs / 1000));
  return changes;
}

/** 解析地址角色（P1-⑤）：owner > operator > user；operator 白名单实时读 kv（网页管理） */
export function roleOf(address) {
  const addr = String(address || '').toLowerCase();
  const owner = (config.shop.owner || '').toLowerCase();
  if (owner && addr === owner) return 'owner';
  if (getShopOperators().includes(addr)) return 'operator';
  return 'user';
}

/** 是否店铺经营人员（owner ∪ 网页店员白名单）——中间件实时比对用 */
export function isStaff(address) {
  const role = roleOf(address);
  return role === 'owner' || role === 'operator';
}

// ── HMAC 令牌 ──
function signPayload(payloadB64) {
  return crypto.createHmac('sha256', config.siwe.secret).update(payloadB64).digest('base64url');
}

/** 签发令牌：base64url(JSON{address,exp,role}) . sig；role 供前端展示，后端鉴权实时比对配置 */
export function issueToken(address, role = 'user') {
  const payload = {
    address: address.toLowerCase(),
    role: ['owner', 'operator', 'user'].includes(role) ? role : 'user',
    exp: Math.floor(Date.now() / 1000) + config.siwe.tokenTtlSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

/** 校验令牌；失败抛 Error，成功返回 {address, owner, exp} */
export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw new Error('令牌格式无效');
  const [payloadB64, sig] = parts;
  const expect = signPayload(payloadB64);
  // 恒定时间比较
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('令牌签名无效');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('令牌已过期');
  return payload;
}
