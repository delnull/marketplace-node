/**
 * Express 应用组装（与 server.js 分离，便于接口单测直接注入 createApp）。
 * 响应体统一 {code, message, data}：code=0 成功，非 0 为业务错误。
 */
import express from 'express';
import cors from 'cors';
import config from './config.js';
import { ok, fail, isProdLike } from './http.js';
import { shopName } from './routes/shop.js';
import { escrowWatcherStatus } from './escrowWatcher.js';
import { piiRetentionStatus } from './piiErase.js';
import { chainReconcileStatus } from './chainReconcile.js';
import { escrowAnchorStatus } from './chainAnchor.js';

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

export function createApp() {
  const app = express();
  app.disable('x-powered-by'); // 不泄露技术栈
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
    */
    if (
      /^\/(api\/orders|api\/shop\/settings|api\/shop\/orders|api\/shop\/retention|api\/auth|api\/shop\/export|api\/shop\/audit|api\/shop\/stats|api\/orders\/seller|api\/products\/all|api\/products\/[^/]+\/codes|api\/products\/[^/]+\/tokens|api\/arbitration)(\/|$)/.test(
        req.path || ''
      )
    ) {
      res.setHeader('Cache-Control', 'private, no-store');
    } else if (
      // 公开只读端点（商品/店铺/汇率/履约画像/店铺评价/健康检查）：不含隐私字段，
      // 允许共享缓存 30s + 后台续期 60s。联邦前端一次首页会向 N 个节点各打 3~4 个
      // 这类请求——节点无任何服务端缓存（reputation 每次全表重算），缓存收益明显。
      // 明确排除 /api/arbitration/pending（含完整买卖双方地址）与 /api/products/all（staff）。
      // Vary: Origin —— cors 反射请求 Origin，共享缓存必须按 Origin 分桶，
      // 否则会把 A 站的 ACAO 响应喂给 B 站导致跨域被浏览器拦截。
      req.method === 'GET' &&
      /^\/(api\/(products(\/[^/]+)?|shop(\/(reputation|reviews\/stats))?|rates)|healthz)$/.test(req.path || '')
    ) {
      res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      /*
        `Vary: Origin, Authorization`（源码审计 2026-09 复审，P3）：cors 会按请求 Origin 反射
        `Access-Control-Allow-Origin`，共享缓存不按 Origin 分桶就会把 A 站的响应喂给 B 站。
        另外 `GET /api/products/:slug` 对**下架商品**在 staff 预览时返回 200、匿名返回 404
        （见 routes/products.js），只按路径分桶会把那份 200 缓存给匿名请求——带上 Authorization
        之后缓存必须按凭据分桶，这条泄漏路径才关掉。
      */
      res.setHeader('Vary', 'Origin, Authorization');
    }
    next();
  });
  // 全局 JSON 1MB；证据附件与商品图片上传路径豁免（各自自带 body 解析，见对应路由）
  //
  // 路径先去掉**尾斜杠**再匹配（源码审计 2026-09 复审，P3）：`/api/uploads/` 与 `/api/uploads`
  // 在 Express 里路由到同一个 handler，而旧判据只认不带斜杠的字面量——于是带尾斜杠的写法
  // 会先吃到这里的 1MB 解析器：2MB 的图片上传变成 500（413 又被下面的错误兜底改写成
  // "服务内部错误"），而客户端看不出真正原因。
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

  // 简易请求日志（生产可去掉或接日志服务）
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - t0}ms)`);
    });
    next();
  });

  // 健康检查（docker healthcheck 用；店名走 kv——网页改店名不影响健康检查语义）
  app.get('/healthz', (req, res) => {
    ok(res, {
      name: shopName(),
      owner: config.shop.owner || null,
      escrowAddress: config.chain.escrowAddress || null,
      version: '0.1.0',
      now: Date.now(),
      /*
        链上轮询器活性（源码审计 2026-09）：此前游标只存 kv、进展只进控制台——「轮询失败、
        游标落后链头、事件被隔离」在运维侧完全不可见（docker healthcheck 照样绿），而界面
        上给用户的说法是「节点 watcher 稍后回写」。这里把 cursor/lagBlocks/隔离数暴露出来，
        监控与人工排查都能直接看到轮询器是否真的在推进。
      */
      watcher: escrowWatcherStatus(),
      // 另两个后台任务的状态（源码审计 2026-09）：reconcile 管镜像偏离的自动修复，
      // piiRetention 管个人信息到期擦除。三者都只靠 console 日志时，容器里丢日志
      // 就等于没有信号——尤其 retention 是不可逆操作，静默失败会一直留着个人信息。
      reconcile: chainReconcileStatus(),
      piiRetention: piiRetentionStatus(),
      /*
        托管合约地址锚点（源码评审 2026-09）：启动时"这次用的地址与上次记录的是否一致、
        本地还有多少在途链上单"——不一致且还有在途单时进程根本不会起来（见 chainAnchor.js），
        所以这里能看到的状态是 ok/record/warn/ack 四种；把它暴露出来是为了让运维不用翻日志
        就知道"这个节点现在锚在哪个合约上"。
      */
      escrowAnchor: escrowAnchorStatus(),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/shop', shopRouter);
  app.use('/api/shop/export', exportRouter); // P1-② CSV 导出（ownerOnly）
  app.use('/api/shop/audit', auditRouter); // P1-④ 管理审计（ownerOnly）
  app.use('/api/shop', piiRouter); // 个人信息删除/保留期（ownerOnly：erase-pii 与 retention/run）
  app.use('/api/uploads', uploadsRouter); // 商品图片上传/读取（上传仅 staff，读取公开）
  app.use('/api/products', productsRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/orders', returnsRouter); // 退货单（P0-4）：与 orders 同前缀，无路径冲突
  app.use('/api/orders', evidenceFilesRouter); // 证据附件（P0-2）
  app.use('/api/rates', ratesRouter);
  app.use('/api/arbitration', arbitrationRouter);

/*
  启动预热店铺编号：/api/shop 读的是 30s 同步缓存，不预热的话首个响应里 code 是 null
  （前端会退回主机名形状，等目录加载后才切到编号）。预热只发一次链上读，失败也不影响启动。
*/
import('./shopCode.js').then((m) => void m.shopCode()).catch(() => {});

  // 404
  app.use((req, res) => {
    fail(res, '接口不存在', 404, 404);
  });

  // 全局错误兜底（wrap 已覆盖各路由异步异常；此处兜底中间件层错误如 JSON 解析失败——
  // 不回传内部错误细节，开发环境可见 message）
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', req.method, req.originalUrl, err.message);
    /*
      body 超限要回 **413**，不能被折叠成 500"服务内部错误"（源码审计 2026-09 复审，P3）：
      body-parser 抛的是 `entity.too.large`，旧实现一路走到这里变成 500——客户端只知道
      "服务器出错"，既不知道该压缩内容，也看不到真实原因（上传图片/附件的用户最容易撞上）。
    */
    if (err?.type === 'entity.too.large') {
      return fail(res, '请求体过大（超过本站该端点的体积上限）', 1, 413);
    }
    const detail = process.env.NODE_ENV === 'development' ? err.message : null;
    fail(res, detail || '服务内部错误', 1, 500);
  });

  return app;
}