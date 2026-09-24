/**
 * SIWE 认证路由：nonce 签发 + 验签（EIP-4361 流程）。
 *
 *  GET  /api/auth/nonce?address=0x... -> {message, address, expiresIn}
 *    —— 生成签名原文（含一次性 nonce，落 SQLite，TTL 内有效）
 *  POST /api/auth/login {address, message, signature}
 *    —— 验签通过后签发 HMAC Bearer 令牌；恢复地址 == 店主 → isOwner=true
 */
import { Router } from 'express';
import { issueSiwe, verifySiwe, issueToken, roleOf } from '../auth.js';
import { isAddress } from '../chain.js';
import config from '../config.js';
import { ok, fail, wrap } from '../http.js';
import { notifyRaw } from '../webhook.js';

const router = Router();

/**
 * Origin 协议健全性校验（2026-09 修复）：联邦下任意合规前端都可能调用节点接口（CORS 保持
 * 开放），但登录接口的调用方若来自非 http(s) 环境（Origin 为 null/file/data：沙箱 iframe、
 * 本地文件页等）一律拒绝——这类页面不属于任何正规前端，只可能用于钓鱼中继/脚本探测。
 * 无 Origin 头（curl/服务端脚本等非浏览器调用）放行。
 */
function originProtocolGuard(req, res, next) {
  const o = req.headers.origin;
  if (o && !/^https?:\/\//i.test(String(o))) {
    fail(res, '不支持的来源（Origin 必须为 http/https）——请通过正规网页访问', 403, 403);
    return;
  }
  next();
}

// ── 轻量内存限流（认证接口匿名可达；防 nonce 表膨胀/验签滥用）。单进程滑动窗口： ──
//   每个 IP 独立窗口，超限返回 429 提示稍后再试；进程重启即清零（演示级够用，生产可换网关/Redis）
const RATE_LIMIT = {
  '/nonce': { windowMs: 60_000, max: 120 }, // 取 nonce 是廉价但可无限刷表/占地址
  '/login': { windowMs: 60_000, max: 60 },
};
const hits = new Map(); // key: `${path}|${ip}` → number[]（时间戳）

function rateLimit(path) {
  const rule = RATE_LIMIT[path];
  return (req, res, next) => {
    if (!rule) return next();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${path}|${ip}`;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < rule.windowMs);
    if (list.length >= rule.max) {
      fail(res, '请求过于频繁，请稍后再试', 429, 429);
      return;
    }
    list.push(now);
    hits.set(key, list);
    // 内存护栏（）：条目数超阈值时惰性清扫整窗已过期条目——防 IPv6 轮换/
    // 代理池长期运行下 Map 无界增长（与 http.js simpleRateLimit 同款策略）
    if (hits.size > 5000) {
      const cutoff = now - Math.max(...Object.values(RATE_LIMIT).map((r) => r.windowMs));
      for (const [k, ts] of hits) {
        if (!ts.some((t) => t >= cutoff)) hits.delete(k);
      }
    }
    next();
  };
}

/** 获取 SIWE 签名原文（前端弹出钱包签名后回传） */
router.get('/nonce', rateLimit('/nonce'), originProtocolGuard, wrap(async (req, res) => {
  const address = String(req.query.address || '').trim().toLowerCase();
  if (!isAddress(address)) return fail(res, 'address 参数无效（需 0x 开头的以太坊地址）');
  const message = issueSiwe(address);
  ok(res, { message, address, expiresIn: config.siwe.ttlSeconds });
}));

/** 验证签名并登录，签发 HMAC 令牌（P1-⑤：payload.role=owner|operator|user） */
router.post('/login', rateLimit('/login'), originProtocolGuard, wrap(async (req, res) => {
  const { address, message, signature } = req.body || {};
  if (!isAddress(address)) return fail(res, 'address 参数无效');
  if (!message || !signature) return fail(res, '缺少 message 或 signature');
  /*
    `verifySiwe` 用**抛异常**表达业务失败（nonce 过期/不匹配、签名地址不一致），
    而 `wrap` 会把未捕获异常折叠成"服务内部错误"（类生产环境不回原文）——
    于是用户看到的是一条内部错误，既不知道该"重新获取签名原文"，还会把正常事件刷进
    `[http] 未捕获异常` 的日志噪音里（源码审计 2026-09 复审，P2）。
    这里把它收敛成 401 + 原文：这是**可自行修复**的输入问题，不是服务端故障。
  */
  let recovered;
  try {
    recovered = verifySiwe(address, message, signature);
  } catch (e) {
    return fail(res, String(e?.message || '签名校验失败，请重新获取签名原文后再登录'), 1, 401);
  }
  const role = roleOf(recovered);
  // 店主登录告警（2026-09 修复，可选开：MK_OWNER_LOGIN_ALERT=1）：owner 令牌 = 全店写权限，
  // 若因钓鱼中继/令牌失窃被冒领，店主经自有 webhook 通道第一时间知情（轮换/撤销先行）
  if (role === 'owner' && config.webhook.ownerLoginAlert) {
    notifyRaw('auth.owner_login', { address: recovered, ip: String(req.ip || req.socket?.remoteAddress || '') });
  }
  const token = issueToken(recovered, role);
  ok(res, {
    token,
    address: recovered,
    role,
    isOwner: role === 'owner',
    isOperator: role === 'operator',
  });
}));

export default router;
