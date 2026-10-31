/**
 * Express 应用组装（与 server.js 分离，便于接口单测直接注入 createApp）。
 * 响应体统一 {code, message, data}：code=0 成功，非 0 为业务错误。
 */
import express from 'express';
import cors from 'cors';
import config from './config.js';
import { ok, fail, wrap, isProdLike, clientIp, simpleRateLimit } from './http.js';
import { getDb, serverCapabilities } from './db.js';
import { redisHealth } from './redis.js';
// 审计哈希链的**只读校验器**（唯一实现，见 auditChain.js）：healthz 只用最近一段窗口，见下方 readAuditChain
import { verifyAuditChain } from './auditChain.js';
// 节点叫什么由**节点资料**回答（`node` 单例行的 name/notice，与任何一家店无关）
import { nodeNameOf } from './routes/shop.js';
import { listShopRows, nodeRow, nodeOwnerOf } from './shops.js';
import { escrowWatcherStatus } from './escrowWatcher.js';
import { piiRetentionStatus } from './piiErase.js';
import { chainReconcileStatus } from './chainReconcile.js';
import { escrowAnchorStatus } from './chainAnchor.js';
// 仲裁人读数与下单超时窗口自检：两者都有"读不到"这一档，而**读不到必须能看见**
import { committeeStatus, orderTimeoutSelfCheck } from './chain.js';
// 上传目录用量（视频把单个孤儿的成本从 2MB 抬到 50MB ⇒ 磁盘必须可见，见 productMedia.js）
import { mediaUsage } from './productMedia.js';

import authRouter from './routes/auth.js';
import shopRouter from './routes/shop.js';
import productsRouter from './routes/products.js';
import uploadsRouter from './routes/uploads.js';
import ordersRouter from './routes/orders.js';
import returnsRouter from './routes/returns.js';
import evidenceFilesRouter from './routes/evidenceFiles.js';
import exportRouter from './routes/export.js';
import auditRouter from './routes/audit.js';
import piiRouter from './routes/pii.js';
import ratesRouter from './routes/rates.js';
import arbitrationRouter from './routes/arbitration.js';
import shopsRouter from './routes/shops.js';
import claimsRouter from './routes/claims.js';
import blocksRouter from './routes/blocks.js';
import favoritesRouter from './routes/favorites.js';

/**
 * `/healthz` 的**审计链**读数：最近 `AUDIT_CHAIN_WINDOW` 行的哈希链还接得上吗？
 *
 * 为什么挂在探活上：`audit_logs` 的 append-only 触发器挡的是 DML；`TRUNCATE` / `DROP` 是 DDL，
 * 触发器管不到——那之后库里会留下"prev_hash 接不上"的痕，而在本读数之前只有**有人记得**跑
 * `npm run check:integrity` 才看得见。探活每隔几秒就被调一次，断裂因此最迟一个缓存周期就能被看见。
 *
 * 为什么是"最近 N 行 + 30s 缓存"而不是全表：全表校验的代价随审计行数线性增长，而探活是高频路径；
 * 这个读数回答的是"**现在**还在被改吗"，历史断裂由手工体检（`check:integrity`，全表扫）负责。
 * 代价如实写：窗口之外（更早的行）的篡改不会在这里出现；窗口内最多晚一个缓存周期（30s）——
 * 想要"立刻、全量"的结论只能跑体检。
 *
 * 它是**读数**不是健康判据：断裂/读不到都不改变 `/healthz` 的 HTTP 200 与顶层 `code`（探活看的是
 * watcher 那几条），只在 `capabilities.auditChain` 里给出 `{window, checked, ok, firstBrokenId,
 * code, detail}`——`ok:null` + `code:2` 表示"本次没校验成"，与"链没问题"是两件事。
 */
const AUDIT_CHAIN_WINDOW = 200;
const AUDIT_CHAIN_TTL_MS = 30_000;

/** 缓存：`at` 是采样时刻（缓存命中时它不变，读的人能看出这是多少秒前的结论） */
const auditChainCache = { at: 0, value: null };

/** 测试用：30s 缓存会让"断裂/读不到"这两条路径在一个用例里不可达，必须能显式重置 */
export function resetAuditChainCache() {
  auditChainCache.at = 0;
  auditChainCache.value = null;
}

export async function readAuditChain() {
  const now = Date.now();
  if (auditChainCache.value && now - auditChainCache.at < AUDIT_CHAIN_TTL_MS) return auditChainCache.value;
  let value;
  try {
    const db = getDb();
    /*
      窗口之外还要一个**前驱锚**：校验器要求第一行接在它前面那一行之后，直接喂窗口会让首行被误报成
      "链首之前被删了"。锚取的是**窗口之前最后一条已哈希行**，不是窗口的前一行——窗口前一行可能是
      未哈希的历史行（升级前的行），拿它当锚会把干净的链报成断裂。锚自己的断裂不计入本读数
      （更早的行归全表体检）。

      `SELECT *` 是刻意的：参与哈希的列清单在 auditChain.js 的 HASH_FIELDS，这里再列一遍就是第二份
      真相——2026-10-16 加 shop_code 时实测踩到"校验器 SELECT 漏列 ⇒ 所有店铺行被报成断裂"。
    */
    const rows = (await db.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?', AUDIT_CHAIN_WINDOW)).reverse();
    const firstId = rows.length ? Number(rows[0].id) : null;
    const anchorRow =
      firstId === null
        ? null
        : await db.get('SELECT * FROM audit_logs WHERE id < ? AND entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1', firstId);
    const anchor = anchorRow || null;
    // 校验逻辑只有 verifyAuditChain 一份：这里换掉的只是它的**输入窗口**（它只发一条整表 SELECT）。
    // anchor 必须一起喂进去：它只提供首行该接上的 prev，产出里再把它自己的断裂滤掉。
    const verified = await verifyAuditChain({ all: async () => (anchor ? [anchor, ...rows] : rows) });
    const broken = verified.broken.filter((b) => firstId !== null && Number(b.id) >= firstId);
    value = {
      window: AUDIT_CHAIN_WINDOW,
      checked: rows.length,
      ok: broken.length === 0,
      firstBrokenId: broken.length ? broken[0].id : null,
      code: broken.length ? 1 : 0,
      detail: broken.length
        ? `最近 ${rows.length} 行审计里最早一处断裂在 #${broken[0].id}（共 ${broken.length} 处）：${broken[0].detail}`
        : `最近 ${rows.length} 行审计哈希链自洽`,
      at: now,
    };
  } catch (e) {
    // 读不到 ≠ 没问题（本仓对"读不到"的一贯口径）：ok 留 null，不让它看起来通过
    value = {
      window: AUDIT_CHAIN_WINDOW,
      checked: 0,
      ok: null,
      firstBrokenId: null,
      code: 2,
      detail: `本次没校验成（不是"链没问题"）：${e?.message || e}`,
      at: now,
    };
  }
  auditChainCache.at = now;
  auditChainCache.value = value;
  return value;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by'); // 不泄露技术栈
  /*
    **X-Forwarded-For 的唯一解析点**（`config.trustProxy`，默认关闭）。
    这行决定 `req.ip` 是 TCP 对端地址还是 XFF 里的某一跳；限流、审计、请求日志
    都只读解析后的 `req.ip`（见 http.js 的 clientIp），不再各自拆一遍 XFF。
    默认 `false` 是刻意的：`true` 等于相信任意客户端伪造的来源地址。
  */
  app.set('trust proxy', config.trustProxy);
  /*
  CORS：`MK_CORS_ORIGIN=*` 默认只在**非生产**环境反射请求 Origin（本地/演示要跨端口）。
  生产环境不反射任意来源——未显式配置白名单时按"不开放跨域"处理（同源前端不受影响）。
  判据走 `http.js` 的 `isProdLike()`（唯一实现）：旧实现用 `NODE_ENV !== 'production'`，
  于是裸机/systemd（**没设 NODE_ENV**）会被当成非生产而反射任意 Origin，与同一文件里
  密钥自检的"未设也算生产"结论相反（源码评审 2026-09）。

  **但这条例外会让"默认配置"在最常见的部署形态下把跨域整个关掉**（源码审计 2026-09 复审）：
  联邦前端/仲裁台本来就是从浏览器跨域轮询各家节点的，而 `*` 在类生产环境下等于
  `cors({origin:false})`（连 `Access-Control-Allow-Origin` 响应头都不发），
  故障形态是"页面空白 + 服务端零日志"。所以：
    · `MK_CORS_ORIGIN` 给**显式白名单**（逗号分隔）时永远生效——这是推荐的生产配置；
    · 需要"谁都行"时显式设 `MK_CORS_ALLOW_ALL=1`（本接口用 Bearer 令牌、无 Cookie，
      不涉及凭据泄露；放开的是跨域**读取**）；
    · 其余情况下若检测到 `*` 被降级，启动日志会**大声说清**当前口径与修法，绝不静默。
  */
  const corsWildcardAllowed = config.corsOrigin === '*' && (!isProdLike() || config.corsAllowAll);
  const corsOptions =
    config.corsOrigin === '*'
      ? { origin: corsWildcardAllowed }
      : { origin: config.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean) };
  app.use(cors(corsOptions));
  if (config.corsOrigin === '*') {
    if (corsWildcardAllowed) {
      console.warn(
        `[cors] 允许任意来源跨域${config.corsAllowAll ? '（MK_CORS_ALLOW_ALL=1）' : '（非生产环境）'}`
      );
    } else {
      console.warn(
        '[cors] MK_CORS_ORIGIN=* 在类生产环境下**不会**反射任意来源：跨域调用（联邦前端/仲裁台）会被浏览器拦截。' +
          '请二选一：① MK_CORS_ORIGIN=https://你的前端域名[,https://另一个]（推荐）；② 确需对所有人开放跨域读取时设 MK_CORS_ALLOW_ALL=1'
      );
    }
  }
  // 基础安全响应头（API/附件/错误页统一生效）：nosniff 防 MIME 嗅探、禁 iframe 嵌套防
  // 点击劫持、Referrer-Policy 防 URL 内地址/令牌经 Referer 泄露到第三方
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    /*
      敏感业务数据禁缓存（审计 2026-09）：订单（含收货/备注/码原文）、店铺设置、认证 nonce/登录、
      以及一切带鉴权响应的管理面数据（export/audit/stats/seller/evidence/returns/webhook 等——
      共享缓存不得存储带 Authorization 的响应；公开读端点不含隐私字段可正常缓存）。
      **仲裁面也必须在列**（源码评审 2026-09 补）：`/api/arbitration/pending` 是**匿名可读**的
      （仲裁台要不登录就能看到待办队列），而它含**完整买卖双方地址**与争议要素——
      既不在公开可缓存白名单里，也没有 no-store，等于把"要不要缓存"交给了中间层的默认行为。
      **运营三端点同样在列**（2026-10）：`/api/shop/buyer-signal`（某买家在本店的退款/争议历史）、
      `/metrics`、`/sla` 都是 ownerOnly 的经营数据——默认无 Cache-Control 就等于交给中间层，
      而这三个端点的响应里带着"谁在这家店退过款、哪些单压着没发"。
    */
    /*
      敏感响应禁缓存。判据有两层（**不再只靠手工 URL 清单**）：
        ① 任何带 Bearer 令牌的响应一律 `private, no-store`——需要登录的端点天然带这个头，
           新增路由忘了往正则里补也不会把私域数据交给共享缓存；
        ② 少数**匿名可读但含隐私**的端点（仲裁待办、nonce/登录、码池/证据等）仍按路径兜住。
      旧实现只有 ②，而正则曾把 `/api/claims/nft/mine` 写成 `/api/claims/mine`——真实路由永不命中，
      提货记录的收货信息（姓名/电话/地址）就落在"没有 Cache-Control"的默认行为上。
    */
    const hasBearer = /^Bearer\s+/i.test(String(req.headers.authorization || ''));
    if (
      hasBearer ||
      /^\/(api\/orders|api\/claims|api\/shop\/(settings|orders|retention|export|audit|stats|metrics|sla|buyer-signal|webhook-status|node|node-staff|payment-tokens|claims)|api\/shops\/admin|api\/auth|api\/products\/all|api\/products\/[^/]+\/(codes|tokens)|api\/arbitration)(\/|$)/.test(
        req.path || ''
      )
    ) {
      res.setHeader('Cache-Control', 'private, no-store');
    } else if (/^\/healthz\/?$/.test(req.path || '')) {
      /*
        `/healthz` 是**判据**不是展示页：它的 200/503 与响应体里的 watcher 读数
        都是"此刻"的结论（见下面的健康判据）。它此前落在公开可缓存分支里，
        于是 503 也带 `public, max-age=30, stale-while-revalidate=60`——
        一个已经停滞的节点可以被中间层再喂回 healthy 约 90 秒（探活/编排据此判定，
        重启时机与真实故障错开）。健康检查必须每次回源。
      */
      res.setHeader('Cache-Control', 'no-store');
    } else if (
      // 公开只读端点（商品/店铺/汇率/履约画像/店铺评价）：不含隐私字段，
      // 允许共享缓存 30s + 后台续期 60s。联邦前端一次首页会向 N 个节点各打 3~4 个
      // 这类请求——节点无任何服务端缓存（reputation 每次全表重算），缓存收益明显。
      // 明确排除 /api/arbitration/pending（含完整买卖双方地址）与 /api/products/all（staff）。
      // Vary: Origin —— cors 反射请求 Origin，共享缓存必须按 Origin 分桶，
      // 否则会把 A 站的 ACAO 响应喂给 B 站导致跨域被浏览器拦截。
      req.method === 'GET' &&
      /^\/(api\/(products(\/[^/]+)?|shop(\/(reputation|reviews\/stats))?|rates))$/.test(req.path || '')
    ) {
      res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      /*
        `Vary: Origin, Authorization, X-Mk-Shop`：cors 会按请求 Origin 反射
        `Access-Control-Allow-Origin`，共享缓存不按 Origin 分桶就会把 A 站的响应喂给 B 站。
        另外 `GET /api/products/:slug` 对**下架商品**在 staff 预览时返回 200、匿名返回 404，
        `X-Mk-Shop` 又决定商品/画像/评价聚合的店铺作用域；只按路径分桶会把
        “A 店作用域/下架预览”的 200 缓存给 B 店或匿名请求。三者都必须进 Vary。
      */
      res.setHeader('Vary', 'Origin, Authorization, X-Mk-Shop');
    }
    next();
  });
  // 全局 JSON 1MB；证据附件与商品媒体上传路径豁免（各自自带 body 解析，见对应路由）
  //
  // 路径先去掉**尾斜杠**再匹配（源码审计 2026-09 复审，P3）：`/api/uploads/` 与 `/api/uploads`
  // 在 Express 里路由到同一个 handler，而旧判据只认不带斜杠的字面量——于是带尾斜杠的写法
  // 会先吃到这里的 1MB 解析器：2MB 的图片上传变成 500（413 又被下面的错误兜底改写成
  // "服务内部错误"），而客户端看不出真正原因。
  //
  // 商品媒体上传（/api/uploads）现在**完全不吃 JSON 解析器**：请求体就是文件字节，
  // 由路由自己流式写入磁盘（见 routes/uploads.js）。这里的豁免判据因此更要紧——
  // 一旦漏掉，一个 50MB 的视频会被 JSON 解析器按 1MB 顶掉。
  const normPath = (p) => {
    const s = String(p || '');
    return s.length > 1 && s.endsWith('/') ? s.replace(/\/+$/, '') || '/' : s;
  };
  const isFilesUpload = (req) =>
    req.method === 'POST' &&
    (/^\/api\/orders\/[^/]+\/evidence\/[^/]+\/files$/.test(normPath(req.path)) ||
      normPath(req.path) === '/api/uploads');
  app.use((req, res, next) => {
    if (isFilesUpload(req)) return next();
    express.json({ limit: '1mb' })(req, res, next);
  });

  // 简易请求日志（生产可去掉或接日志服务）；来源 IP 走 clientIp（唯一取值处，见 http.js）
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      // 收藏 GET 的 query 是钱包地址 + 偏好，不能原样进访问日志。
      const loggedUrl = /^\/api\/favorites\/?$/.test(String(req.path || '').toLowerCase())
        ? `${req.path}?address=[redacted]`
        : req.originalUrl;
      console.log(`${clientIp(req)} ${req.method} ${loggedUrl} -> ${res.statusCode} (${Date.now() - t0}ms)`);
    });
    next();
  });

  /*
    健康检查（docker healthcheck 与两条部署路径的探活都用它）。
    **handler 必须是 async 并逐个 await**：这些读数里有一半要走库（节点资料、`node` 行、
    店铺清单、watcher 的隔离清单条数），异步函数不 await 就会把一个 Promise
    原样塞进 `ok(res, {...})`——JSON 序列化把 Promise 变成 `{}`，于是 `/healthz` 永远返回
    一个**看起来正常**的响应（`shops: {}`、`node: {}`），而健康检查照样绿。
  */
  /*
    /healthz 是探活，不是免费的全量读数口：它每次都要读库、读 watcher 状态并拼 capabilities。
    编排/反代每秒一次足够；这里的上限远高于正常探活频率，但能挡住"用探活当免费全量查询"的滥用。
  */
  const healthLimiter = simpleRateLimit({ windowMs: 60_000, max: 300, message: '探活请求过于频繁' });
  app.get('/healthz', healthLimiter, wrap(async (req, res) => {
    try {
    const shopRows = await listShopRows();
    const node = await nodeRow();
    const owner = nodeOwnerOf(node);
    const watcher = await escrowWatcherStatus();
    /*
      ── 健康**判据**：不能是"进程在监听"（2026-10-16 收口）──────────────────────
      此前这个端点走 `ok()`，于是 **HTTP 恒 200、`code` 恒 0**，与任何健康状态无关。
      而它正是三处探活判据的唯一读数：
        · `node/Dockerfile` 的 `HEALTHCHECK`（只看退出码）；
        · `node/deploy.sh` 的探活（只看 HTTP 200）；
        · `deploy/deploy-node.ps1` 的核对（`grep '"code":0'`）。
      三者合起来只证明"进程在监听"——**watcher 停摆、事件被隔离、链上地址配错**都不影响它们，
      于是"发布成功"这四个字可以在一个根本没在处理链上事件的节点上打印出来。

      判据收在这里一处（不在三个消费端各判一次——那样漏一处就多一个"绿灯的死节点"）。
      判据的形状必须**区分三种情形**——把"没轮到"与"坏了"混起来，会让一次 RPC 抖动之后
      尚未完成第一轮轮询的进程被判成不健康，容器编排随之重启它，而重启解决不了 RPC 的问题：

        ① **未配置托管合约**（`configured=false`，纯展示节点）：链上事件这件事不存在 ⇒ 不判。
        ② **轮询器没起来**（`startedAt == 0`：进程刚启动、还没轮到第一轮，或本进程不跑轮询器）：
           链上读数还没有过第一次采样 ⇒ **不判**（"没有读数"与"读数不好"是两件事，
           与 `opsMetrics`/`fees` 对"读不到"给独立一档是同一条纪律）。
        ③ **轮询器起过、但已停滞**（`lastOkAt` 距今 ≥ `WATCHER_STALE_MS`）⇒ **不健康**。
           这才是要抓的那一类：游标不再推进，订单会永远停在旧状态。
        ④ **隔离事件数 ≠ 0** ⇒ 一律不健康（有链上事件连续失败、需人工介入）。

      **不健康时返回 503 且 `code != 0`**：两个信号都给，是为了让"只看 HTTP 码"的探活
      （Docker/deploy.sh）与"只看 code"的探活（deploy-node.ps1）**同时**能失败。
    */
    const watcherStaleMs = Math.max(90_000, Number(config.escrow.pollIntervalMs || 15_000) * 3);
    const watcherStarted = Number(watcher.startedAt) > 0;
    const watcherLastOk = Number(watcher.lastOkAt || 0);
    /*
      首轮扫描可能远超 90 秒（积压时先扫 2000 块再逐单预取）。在还没有任何成功读数时
      用 startedAt 给一个 4×stale 的宽限，避免 Docker 在首轮进行中反复重启；宽限过后仍无
      成功读数才算停滞。
    */
    const watcherStalled =
      watcher.configured &&
      watcherStarted &&
      (watcherLastOk > 0
        ? Date.now() - watcherLastOk >= watcherStaleMs
        : Date.now() - Number(watcher.startedAt) >= watcherStaleMs * 4);
    const quarantinedOk = Number(watcher.quarantined) === 0;
    // Redis 是限流/缓存的硬依赖：掉线时节点仍能读库，但匿名入口无法 prove 请求预算，
    // 探活必须报 503，而不是让编排以为可以继续接流量。
    const redis = await redisHealth();
    const redisOk = redis.connected;
    const healthy = !watcherStalled && quarantinedOk && redisOk;
    if (!healthy) {
      const why = [
        watcherStalled
          ? `链上事件轮询器已停滞 ${Math.round((Date.now() - Number(watcher.lastOkAt || 0)) / 1000)} 秒` +
            `（最后一次成功轮询 ${watcher.lastOkAt ? new Date(Number(watcher.lastOkAt)).toISOString() : '从未成功'}；` +
            `lagBlocks=${watcher.lagBlocks ?? null}，游标不再推进 ⇒ 订单会停在旧状态）`
          : null,
        !quarantinedOk ? `${watcher.quarantined} 条链上事件已隔离、需人工介入（见 node.quarantined_events）` : null,
        !redisOk ? 'Redis 不可用：限流/共享缓存无法工作（检查 MK_REDIS_URL 与 Redis 进程）' : null,
      ].filter(Boolean);
      res.status(503);
      return fail(res, `节点不健康：${why.join('；')}`, 1, 503, {
        healthy: false,
        reason: why.join('；'),
        watcher,
        redis,
        // 503 也要给隔离条数：否则运维只能从 watcher 里猜，node 读数在故障时反而消失。
        node: node
          ? {
              quarantinedEvents: node.quarantined_events && typeof node.quarantined_events === 'object'
                ? Array.isArray(node.quarantined_events)
                  ? node.quarantined_events.length
                  : Object.keys(node.quarantined_events).length
                : null,
            }
          : null,
      });
    }
    ok(res, {
      healthy: true,
      name: await nodeNameOf(),
      host: owner || null,
      shops: { total: shopRows.length, listed: shopRows.filter((r) => Number(r.listed) === 1).length },
      escrowAddress: config.chain.escrowAddress || null,
      stakingAddress: config.chain.stakingAddress || null,
      version: config.version,
      /* 时刻是 `Date`（对外 JSON 为 ISO-8601）：与库列/接口的其余时间同一种形状 */
      now: new Date(),
      /*
        **`node` 单例行的读数**（2026-10 重设计）：这些以前散在 kv 的两列字符串里，
        运维只能翻日志或猜。合约地址锚、watcher 游标（块号 + 块哈希）、对账游标
        （`(updated_at, id)` **键集分页对**，不是块号——对账按"最后处理到哪张单"推进）、
        隔离事件条数，都在这一块。
        读不到就是 null（该行/该列还没有值），**不折成 0**："游标在 0"与"还没有游标"
        是两件事，后者意味着链上事件从来没被处理过。
      */
      node: node
        ? {
            owner: owner || null,
            escrowAddress: node.escrow_address || null,
            watcherBlock: node.watcher_block ?? null,
            watcherHash: node.watcher_hash || null,
            reconcileAt: node.reconcile_at ?? null,
            reconcileOrderId: node.reconcile_order_id ?? null,
            quarantinedEvents: node.quarantined_events && typeof node.quarantined_events === 'object'
              ? Array.isArray(node.quarantined_events)
                ? node.quarantined_events.length
                : Object.keys(node.quarantined_events).length
              : null,
            updatedAt: node.updated_at ?? null,
          }
        : null,
      /*
        链上轮询器活性：游标存库、进展只进控制台的话，「轮询失败、游标落后链头、事件被隔离」
        在运维侧完全不可见（docker healthcheck 照样绿），而界面上给用户的说法是
        「节点 watcher 稍后回写」。这里把 cursor/lagBlocks/隔离数暴露出来，
        监控与人工排查都能直接看到轮询器是否真的在推进。
        ⚠️ 从 2026-10-16 起它同时是**健康判据的输入**（见上方 `healthy`）：
        watcher 停滞或隔离数非零 ⇒ 本端点 503，探活会真的失败。
      */
      watcher,
      // 另两个后台任务的状态：reconcile 管镜像偏离的自动修复，piiRetention 管个人信息到期擦除。
      // 三者都只靠 console 日志时，容器里丢日志就等于没有信号——尤其 retention 是不可逆操作，
      // 静默失败会一直留着个人信息。
      reconcile: chainReconcileStatus(),
      piiRetention: piiRetentionStatus(),
      /*
        托管合约地址锚点（源码评审 2026-09）：启动时"这次用的地址与上次记录的是否一致、
        本地还有多少在途链上单"——不一致且还有在途单时进程根本不会起来（见 chainAnchor.js），
        所以这里能看到的状态是 ok/record/warn/ack 四种；把它暴露出来是为了让运维不用翻日志
        就知道"这个节点现在锚在哪个合约上"。
      */
      escrowAnchor: escrowAnchorStatus(),
      /*
        委员会读数（2026-10-18：单仲裁人 → 多仲裁人 + 阈值）。为什么要暴露它：
        `getCommittee()` 在**读不到**时返回 `null`——那是刻意的安全方向（读不到就谁都不是仲裁人，
        见 chain.js 的说明），但它的代价是「RPC 抖动期间合法的仲裁人也进不来」，
        而在此之前这个状态**只能靠翻日志**看：`/healthz` 一切正常、仲裁人只看到自己被拒，
        运维无从知道是"你不是仲裁人"还是"节点读不到"。
        `known:false` = 本次没确证（此时 `committee` 为 null），`lastOk` 只是排障线索、不参与判定。
        三态口径——"读不到"必须能作为一个独立结论被看见。
      */
      committee: committeeStatus(),
      /*
        下单超时窗口自检的结论（2026-10-14）。为什么要暴露它：`checkOrderTimeoutBounds` 在启动期
        只跑一次，而它的 `unknown` 档（读不到链上界 / 配置值本身非法）**刻意不阻断启动**——
        否则一次 RPC 抖动就能停掉一个配置正确的节点。代价是"这次没校验成"必须有个地方能看见，
        否则它随启动日志一起丢了，而越界的配置会让**每一笔下单**都在买家钱包里 revert。
        从未跑过（例如未配置 MK_ESCROW_ADDRESS）时为 null。
      */
      orderTimeout: orderTimeoutSelfCheck(),
      /*
        商品媒体（upload dir）用量：孤儿媒体**刻意不删**（订单快照锁的是 URL 字符串），
        而视频把单个孤儿的成本从 2MB 抬到 50MB —— 磁盘是这个功能新引入的失败面，
        运维要能在健康检查上直接看见"这个节点囤了多少媒体"，而不是等写满那天。
      */
      uploads: mediaUsage(),
      /*
        部署能力读数：数据库探测（binlog 形态，见 db.js 的 serverCapabilities）加上
        **本进程实际生效的反代信任边界**。为什么 trustProxy 要在这里：它决定限流键、
        audit_logs.ip 与请求日志里的来源地址——配错时节点每个请求都"正常工作"，
        只有从这行读数才看得出"所有人共用一个桶"（默认 false = 不信 XFF；'loopback'/
        CIDR 列表 = 只信那些代理跳）。
      */
      capabilities: {
        ...(serverCapabilities() || {}),
        trustProxy: config.trustProxy,
        /*
          **审计链最近 N 行的读数**（见 readAuditChain）：它是读数不是判据——链断裂时本端点仍是
          200 / 顶层 code:0，结论只在 `auditChain.ok` / `code` / `detail` 里（code:1 = 断裂，
          code:2 = 本次没校验成）。放在 capabilities 而不是顶层，是因为探活消费端
          （Docker HEALTHCHECK / deploy.sh / deploy-node.ps1 的 `"code":0`）只认 HTTP 码与顶层 code。
        */
        auditChain: await readAuditChain(),
        // Redis 是限流/共享缓存的依赖；未配置/掉线会让 /healthz 503（见上方 healthy）
        redis,
      },
    });
    } catch (e) {
      /*
        健康端点必须**响亮地**失败：通用 wrap 的约定是“业务失败=HTTP 200 + code!=0”，
        但探活消费端（Docker HEALTHCHECK / deploy.sh / deploy-node.ps1）会把 200 当健康。
        读库/RPC/审计链任一 await 抛错时，这里直接 503 + code!=0，不让“节点死了”显示成绿色。
      */
      console.error(`[healthz] 健康读数读取失败：${e?.stack || e?.message || e}`);
      res.status(503);
      return fail(res, '节点不健康：健康读数读取失败（数据库或依赖不可用）', 1, 503, {
        healthy: false,
        reason: '健康读数读取失败（数据库或依赖不可用）',
      });
    }
  }));

  app.use('/api/auth', authRouter);
  // 买家在本节点的屏蔽名单：持久化在节点 DB，不依赖浏览器/平台目录
  app.use('/api/me/blocks', blocksRouter);
  // 买家收藏（店铺/商品）：GET 公开按地址读；写必须登录
  app.use('/api/favorites', favoritesRouter);
  // 店铺目录与开店申请（多店改造新增）：公开列表 /api/shops、详情 /api/shops/:code、申请与审批
  app.use('/api/shops', shopsRouter);
  app.use('/api/shop', shopRouter);
  app.use('/api/shop/export', exportRouter); // P1-② CSV 导出（ownerOnly）
  app.use('/api/shop/audit', auditRouter); // P1-④ 管理审计（ownerOnly）
  app.use('/api/shop', piiRouter); // 个人信息删除/保留期（**权威随作用域**：erase-pii 擦一单 ⇒ ownerOnly；retention/run 跑一轮节点级擦除 ⇒ hostOnly）
  app.use('/api/uploads', uploadsRouter); // 商品图片上传/读取（上传仅 staff，读取公开）
  app.use('/api/products', productsRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/orders', returnsRouter); // 退货单（P0-4）：与 orders 同前缀，无路径冲突
  app.use('/api/orders', evidenceFilesRouter); // 证据附件（P0-2）
  app.use('/api/rates', ratesRouter);
  app.use('/api/arbitration', arbitrationRouter);
  // NFT 提货声明（持有人提交、卖家处理、节点管理员生成链上争议参数）
  app.use('/api/claims', claimsRouter);

/*
  启动预热不需要任何东西：`/api/shop` 与 `/healthz` 只读库里那一行节点资料与本节点配置，
  不再有"链上节点编号"这种要预热的展示字段（平台目录以 endpoint + operator 标识节点）。
*/

  // 404
  app.use((req, res) => {
    fail(res, '接口不存在', 404, 404);
  });

  // 全局错误兜底（唯一实现见文件末尾的 appErrorHandler；单独导出是为了让"哪类错误该回 4xx"
  // 这条判据能被直接驱动，而不是只能靠造一个 body-parser 请求来间接命中）
  app.use(appErrorHandler);

  return app;
}

/**
 * 全局错误兜底（wrap 已覆盖各路由异步异常；此处兜底中间件层错误如 JSON 解析失败——
 * 不回传内部错误细节，开发环境可见 message）。
 *
 * **客户端造成的 4xx 一律不折叠成 500**（2026-10-16 收口）：body-parser 抛的两类
 * ——`entity.too.large`（超限）与 `entity.parse.failed`（JSON 语法错）——此前只有前者
 * 被单独接住，后者掉进 500"服务内部错误"。后果有两层：
 *   · 客户端分不清"我发错了"与"服务坏了"（前端只会显示"服务内部错误"，用户无从修起）；
 *   · 服务端 `[error]` 通道里，**可自行修复的输入错误**与真实故障混在同一条日志上，
 *     真故障的可见度被自己制造的噪声稀释。
 * 判据落在这里（唯一兜底处）而不是每个路由各判一次：body 解析发生在**进路由之前**，
 * 调用点根本看不到它。凡是带 `type` 的 body-parser 错误都是客户端错误，一律 400。
 *
 * **只认 `err.type`，不认 `instanceof SyntaxError`**：`JSON.parse` 抛的也是 SyntaxError，
 * 而它更常见的来源是**库里存着的坏 JSON**（快照/文本列）——把它报成"请求体不是合法 JSON"
 * 等于把服务端数据损坏说成客户端输入错误，还会让 500 通道里的真故障少一条。
 */
// eslint-disable-next-line no-unused-vars
export function appErrorHandler(err, req, res, next) {
  console.error('[error]', req.method, req.originalUrl, err.message);
  if (err?.type === 'entity.too.large') {
    return fail(res, '请求体过大（超过本站该端点的体积上限）', 1, 413);
  }
  if (err?.type === 'entity.parse.failed') {
    return fail(res, '请求体不是合法 JSON（检查是否被截断、或含未转义字符）', 1, 400);
  }
  const detail = process.env.NODE_ENV === 'development' ? err.message : null;
  fail(res, detail || '服务内部错误', 1, 500);
}