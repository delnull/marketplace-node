/**
 * 公共 HTTP 工具：统一响应格式 {code, message, data}、
 * 错误处理与鉴权中间件。
 */
import config from './config.js';
import { getShopOperators } from './auth.js';

/**
 * 是否"类生产"（未设 NODE_ENV 也算生产）。
 * **唯一实现**：`server.js` 的启动自检与 `app.js` 的 CORS 判定都调它——
 * 原先三处各写一遍（`=== 'production'` / `!== 'development'` / 一句死代码），
 * 于是"裸机没设 NODE_ENV"在不同地方得到不同结论（CORS 放行任意 Origin，但密钥自检按生产拦）。
 */
export function isProdLike(nodeEnv = process.env.NODE_ENV) {
  return nodeEnv !== 'test' && nodeEnv !== 'development';
}

/** 统一成功响应 */
export function ok(res, data = null, message = 'success') {
  res.json({ code: 0, message, data });
}

/** 统一业务失败响应（HTTP 200 + code != 0，与前端既有处理约定一致） */
export function fail(res, message = '操作失败', code = 1, httpStatus = 200) {
  res.status(httpStatus).json({ code, message, data: null });
}

/** 异步路由包装：捕获异常统一映射 */
export function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      /*
        生产不把异常原文回给客户端（源码评审 2026-09 修复）：`fs` 抛错里带**绝对路径**
        （例如 `ENOENT: no such file or directory, open '/data/attachments/…'`），
        `ethers`/`sqlite` 的报错也常含内部结构——这些只对运维有用，对攻击者同样有用。
        判据与 `server.js` 的启动自检统一用 `isProdLike`：**未设 NODE_ENV 也算生产**
        （裸机/systemd 部署常常什么都不设，不能因此走"开发"分支）。
        开发/测试仍回原文，否则本地排查得翻日志。
      */
      if (isProdLike()) {
        console.error(`[http] 未捕获异常：${e?.stack || e?.message || e}`);
        fail(res, '服务内部错误');
        return;
      }
      fail(res, e.message || '服务内部错误', 1);
    });
  };
}

/**
 * 鉴权中间件：解析 Bearer 令牌。
 *  - ownerOnly: 必须为店主（config.shop.owner 实时比对）
 *  - staffOnly: 店主或网页管理的店员白名单（kv，实时读取）
 *  - requireAuth: 任意已登录用户
 */
export function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/**
 * 轻量内存限流中间件（匿名/低频滥用防护）：单进程滑动窗口，按 IP 计数。
 * 说明：进程重启清零（演示/单实例够用；多实例/反代部署建议在网关层限流并显式
 * trust proxy 后本中间件才取到真实 IP——见 docs/OPS_RUNBOOK.md §4）。
 */
export function simpleRateLimit({ windowMs, max, message = '请求过于频繁，请稍后再试' } = {}) {
  const hits = new Map(); // key: ip → number[]（时间戳）
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    // 内存护栏：条目数超阈值时惰性清扫整窗已过期条目（防唯一 IP 面大时 Map 无界增长——审计 F10）
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.length === 0 || now - v[v.length - 1] >= windowMs) hits.delete(k);
      }
    }
    const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      fail(res, message, 429, 429);
      return;
    }
    list.push(now);
    hits.set(ip, list);
    next();
  };
}

export function makeAuthMiddleware(verifyToken, { ownerOnly = false, staffOnly = false } = {}) {
  return (req, res, next) => {
    try {
      const token = bearerToken(req);
      if (!token) {
        fail(res, '未登录或令牌缺失', 401, 401);
        return;
      }
      const payload = verifyToken(token);
      if (ownerOnly || staffOnly) {
        // 角色以当前数据实时比对（令牌内 role 仅为签发快照，店主轮换/店员变更后旧令牌不越权）
        const owner = (config.shop.owner || '').toLowerCase();
        const addr = payload.address || '';
        const isOwnerNow = !!owner && addr === owner;
        const isStaffNow = isOwnerNow || getShopOperators().includes(addr);
        if (ownerOnly && !isOwnerNow) {
          fail(res, '需要店主权限', 403, 403);
          return;
        }
        if (staffOnly && !isStaffNow) {
          fail(res, '需要店主/店员权限', 403, 403);
          return;
        }
      }
      req.auth = payload;
      next();
    } catch (e) {
      fail(res, e.message || '鉴权失败', 401, 401);
    }
  };
}
