/**
 * SIWE 认证路由：nonce 签发 + 验签（EIP-4361 流程）。
 *
 *  GET  /api/auth/nonce?address=0x... -> {message, address, expiresIn}
 *    —— 生成签名原文（含一次性 nonce，Redis TTL 内有效）
 *  POST /api/auth/login {address, message, signature}
 *    —— 验签通过后签发 HMAC Bearer 令牌（**节点级会话**：令牌不带任何店铺声明）
 *
 * ## 登录与店铺无关（旧形状的 `shop` 参数已删除，也不留"可选 shop"这一档）
 *
 * 挑战的键是地址（nonce 在 Redis，没有 shop_code 维度），令牌里也没有店铺——"你是谁"与
 * "你能动哪几家店"本就是两件事：后者由 `shops.seller` / `shop_operators` 回答，
 * 每次请求实时判定（见 http.js 的 makeAuthMiddleware 与 auth.roleOf）。
 * 旧形状要求带 `shop` 且它必须是一家**真实存在**的店：零店铺的新节点连登录都发不出去；
 * 前端还必须按店各登一次、各存一份令牌，而"拿 A 店的令牌去动 B 店"成了服务端要挡的事。
 * 把 `shop` 改成"可选"只会让"登录是否绑店"继续有两种形状，所以整条参数删掉。
 *
 * 登录回执给出 `shops`：这个地址在本节点能经营的店与**各自**的角色（前端据此画店铺切换器，
 * 也据此回答"我在这家店是不是店主"）。回执里**没有** node 级的 `code`/`role`/`isOwner`/`isStaff`：
 * 那四个字段是"这次登录针对的那家店"的结论，而那个维度已经不存在——留着它们只能填一个
 * 与任何店铺都对不上的值（那正是本次要删掉的那类假话）。
 */
import { Router } from 'express';
import { issueSiwe, verifySiwe, issueToken, verifySession, revokeSession, roleOf, isHost, operatedShopCodes, isNodeStaffOf } from '../auth.js';
import { isAddress } from '../chain.js';
import { shopDto, shopRowByCode, nodeOwner } from '../shops.js';
import config from '../config.js';
// clientIp：来源 IP 的唯一实现（trust proxy 只解析一次，见 http.js）
import { ok, fail, wrap, clientIp, bearerToken, simpleRateLimit } from '../http.js';
import { notifyRaw } from '../webhook.js';

/** "节点主没开店 ⇒ 没有告警收件人"只报一次（见登录告警那段） */
let ownerLoginAlertNoRecipientWarned = false;

/**
 * 一次成功登录的**唯一回执形状**：普通 SIWE 登录与扫码登录共用。
 * 若两处各拼一次，`shops` 的角色判据迟早漂移。
 */
async function loginPayload(address, hostNow) {
  const recovered = String(address).toLowerCase();
  const nodeAddr = await nodeOwner();
  const nodeStaff = await isNodeStaffOf(recovered);
  const shops = [];
  for (const code of await operatedShopCodes(recovered)) {
    const row = await shopRowByCode(code);
    if (!row) continue;
    const role = await roleOf(recovered, code);
    if (role === 'owner' || role === 'staff') shops.push({ ...shopDto(row, nodeAddr), role });
  }
  return {
    token: await issueToken(recovered),
    address: recovered,
    isHost: hostNow,
    isNodeStaff: nodeStaff,
    shops,
  };
}

/** 节点主登录告警：普通登录与扫码登录共用（不是第二套权限判据） */
async function alertOwnerLogin(recovered, hostNow, req) {
  if (!hostNow || !config.webhook.ownerLoginAlert) return;
  const hostShops = await operatedShopCodes(recovered);
  if (hostShops.length) {
    notifyRaw('auth.owner_login', {
      shopCode: hostShops[0],
      address: recovered,
      ip: clientIp(req),
    }).catch((e) => console.error('[auth] 节点主登录告警投递异常：', e?.message || e));
  } else if (!ownerLoginAlertNoRecipientWarned) {
    ownerLoginAlertNoRecipientWarned = true;
    console.warn(
      '[auth] MK_OWNER_LOGIN_ALERT 已开启，但节点主在本节点没有任何店铺 ⇒ 没有可投递的 webhook，该告警不会发出'
    );
  }
}

const router = Router();

/**
 * Origin 协议健全性校验：联邦下任意合规前端都可能调用节点接口（CORS 保持开放），
 * 但登录接口的调用方若来自非 http(s) 环境（Origin 为 null/file/data：沙箱 iframe、
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

/*
  认证接口匿名可达，必须走与其它匿名入口**同一套 Redis 限流**（防 nonce 表膨胀/验签滥用）。
  旧实现在本文件维护进程内 Map，多进程时每个进程各算一份，等于把认证限流放大 N 倍；
  现在只保留路由级 policy，计数在 `simpleRateLimit` 的 Redis 内。
*/
const nonceLimiter = simpleRateLimit({ windowMs: 60_000, max: 120 });
const loginLimiter = simpleRateLimit({ windowMs: 60_000, max: 60 });

/** 获取 SIWE 签名原文（前端弹出钱包签名后回传） */
router.get('/nonce', nonceLimiter, originProtocolGuard, wrap(async (req, res) => {
  const address = String(req.query.address || '').trim().toLowerCase();
  if (!isAddress(address)) return fail(res, 'address 参数无效（需 0x 开头的以太坊地址）');
  const message = await issueSiwe(address);
  ok(res, { message, address, expiresIn: config.siwe.ttlSeconds });
}));

/** 验证签名并登录，签发 HMAC 令牌（**节点级会话**：回执给出这个地址能经营的店与各自角色） */
router.post('/login', loginLimiter, originProtocolGuard, wrap(async (req, res) => {
  const { address, message, signature } = req.body || {};
  if (!isAddress(address)) return fail(res, 'address 参数无效');
  if (!message || !signature) return fail(res, '缺少 message 或 signature');
  /*
    `verifySiwe` 用**抛异常**表达业务失败（nonce 过期/不匹配、签名地址不一致、挑战已被消费），
    而 `wrap` 会把未捕获异常折叠成"服务内部错误"（类生产环境不回原文）——
    于是用户看到的是一条内部错误，既不知道该"重新获取签名原文"，还会把正常事件刷进
    `[http] 未捕获异常` 的日志噪音里。
    这里把它收敛成 401 + 原文：这是**可自行修复**的输入问题，不是服务端故障。
  */
  let recovered;
  try {
    recovered = await verifySiwe(address, message, signature);
  } catch (e) {
    // Redis 不可用不是"签名错误"：回 503，别让用户以为自己的签名/原文坏了。
    if (e?.code === 'REDIS_UNAVAILABLE') return fail(res, '登录依赖暂时不可用，请稍后重试', 503, 503);
    return fail(res, String(e?.message || '签名校验失败，请重新获取签名原文后再登录'), 1, 401);
  }
  const hostNow = await isHost(recovered, { force: true });
  await alertOwnerLogin(recovered, hostNow, req);
  let payload;
  try {
    payload = await loginPayload(recovered, hostNow);
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') return fail(res, '登录依赖暂时不可用，请稍后重试', 503, 503);
    throw e;
  }
  ok(res, payload);
}));

/**
 * 退出登录：撤销**当前令牌**对应的服务端会话。未登录/令牌已失效也返回成功（幂等），
 * 前端在清理本地令牌之前调用它；只清 localStorage 的旧行为会让泄露令牌继续可用到 TTL。
 */
router.post('/logout', wrap(async (req, res) => {
  const token = bearerToken(req);
  if (token) {
    let payload;
    try {
      payload = await verifySession(token);
    } catch (e) {
      if (e?.code === 'SESSION_STORE_UNAVAILABLE') {
        return fail(res, '鉴权依赖暂时不可用，请稍后重试', 503, 503);
      }
      /* 已经过期/撤销/无效：退出是幂等的 */
      return ok(res, { loggedOut: true });
    }
    try {
      await revokeSession(payload.jti);
    } catch {
      // 撤销写失败不能报成功：用户会以为会话已经失效。
      return fail(res, '撤销会话失败，请稍后重试', 503, 503);
    }
  }
  return ok(res, { loggedOut: true });
}));

export default router;
