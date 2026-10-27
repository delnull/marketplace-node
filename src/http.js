/**
 * 公共 HTTP 工具：统一响应格式 {code, message, data}、
 * 错误处理与鉴权中间件。
 */
import config from './config.js';
import { roleOf, isNodeAdmin, isHost, operatedShopCodes } from './auth.js';
import { SHOP_HEADER, shopContextOf, shopRowByCode, shopSellable, notSellableReason } from './shops.js';

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

/**
 * 统一业务失败响应（HTTP 200 + code != 0，与前端既有处理约定一致）。
 *
 * `data`（2026-10-14 新增，**可选**，默认 `null`）：失败时也需要带**读数**的场景。
 * 先例是个人信息擦除——"库内已清空、但磁盘上的附件没删掉"是一种**半成品失败**，
 * 调用方必须读到残留数才知道该显示什么（只给一句 message，界面只能猜，而这里猜错的
 * 代价是"以为删干净了、其实盘上还有个人数据"）。默认值保持了既有调用方的响应形状不变。
 */
export function fail(res, message = '操作失败', code = 1, httpStatus = 200, data = null) {
  res.status(httpStatus).json({ code, message, data });
}

/** 异步路由包装：捕获异常统一映射 */
export function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      /*
        响应已经写出去了：此时**不能再写第二次**。
        旧实现在这里无条件 `fail()`，而 `res.json` 之后再写会抛 `ERR_HTTP_HEADERS_SENT`——
        它发生在 catch 里、没有下一层接住，于是变成 unhandledRejection，被 shutdown.js
        当成致命错误 `process.exit(1)`：一个店的审计写失败能把整台节点停掉。
        已经发出去的响应无法收回，唯一诚实的收口是：留日志 + 销毁连接（客户端看到的是
        "连接断了"，而不是一个看起来完整的 200）。
      */
      if (res.headersSent) {
        console.error(
          `[http] 响应已发出后仍抛错（连接将被销毁）：${req.method} ${req.originalUrl}：${e?.stack || e?.message || e}`
        );
        if (typeof res.destroy === 'function') res.destroy();
        return;
      }
      /*
        生产不把异常原文回给客户端（源码评审 2026-09 修复）：`fs` 抛错里带**绝对路径**
        （例如 `ENOENT: no such file or directory, open '/data/attachments/…'`），
        `ethers`/`mysql2` 的报错也常含内部结构——这些只对运维有用，对攻击者同样有用。
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
 * 这次请求的**来源 IP**（限流键、审计列、请求日志的唯一取值处）。
 *
 * XFF 的**唯一解析点**是 `app.set('trust proxy', config.trustProxy)`：Express 只在
 * `MK_TRUST_PROXY` 显式配置时才相信 `X-Forwarded-For`，否则 `req.ip` 就是 TCP 对端地址。
 * 这里不再自己拆 XFF——自己拆一份等于在"信任边界"之外多出一个解析器，而它必然与
 * Express 的 CIDR 判定漂移（一个按跳数、一个按网段，结论可以相反）。
 *
 * 反代之后未配置 `MK_TRUST_PROXY` 时，所有匿名请求会共享代理那一个限流桶，
 * 且 `audit_logs.ip` 恒为代理地址。这类部署错误不会自己冒出来，所以第一次看到
 * 带 XFF 的请求就**大声说一次**（每进程一次，不刷屏）。
 */
let warnedUntrustedForwardedFor = false;
export function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').trim();
  if (forwarded && !config.trustProxy && !warnedUntrustedForwardedFor) {
    warnedUntrustedForwardedFor = true;
    console.warn(
      '[http] 收到 X-Forwarded-For，但 MK_TRUST_PROXY 未配置：限流键、审计 ip 与请求日志仍按 TCP 对端地址记录。' +
        '如果本节点在反向代理之后（默认部署拓扑），多个客户端会共用同一个限流桶，审计里的来源地址也恒为代理——' +
        '请按代理网段设置 MK_TRUST_PROXY（例如 loopback，或逗号分隔的 CIDR 列表）。'
    );
  }
  return String(req?.ip || req?.socket?.remoteAddress || 'unknown');
}

/**
 * 鉴权中间件：解析 Bearer 令牌。
 *  - ownerOnly: 必须为该店店主（`shops.seller`，实时比对）
 *  - staffOnly: 店主或该店店员（`shop_operators` 一行一人，每请求实时读取）
 *  - nodeAdmin: 节点主 ∪ 节点员工（节点级动作；与店铺无关，不要求请求头）
 *  - hostOnly: **仅节点主本人**（不可逆 / 跨租户的节点级动作，例如 PII 保留期擦除与节点审计）
 *  - requireAuth: 任意已登录用户
 */
export function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/**
 * 轻量内存限流中间件（匿名/低频滥用防护）：单进程滑动窗口，按 IP 计数。
 * 说明：进程重启清零（演示/单实例够用；多实例/反代部署需在网关层限流，
 * 并显式配置 MK_TRUST_PROXY，否则这里取到的永远是代理那一个地址）。
 */
export function simpleRateLimit({ windowMs, max, message = '请求过于频繁，请稍后再试' } = {}) {
  const hits = new Map(); // key: ip → number[]（时间戳）
  return (req, res, next) => {
    const ip = clientIp(req);
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

/**
 * 异步中间件包装（**唯一实现**：`optionalShop`/`makeAuthMiddleware` 与各路由的前置门控共用）。
 *
 * 为什么需要它：店铺上下文、角色判据、门控里的订单/证据查库都要 await。Express 4 不会接住
 * async 中间件返回的 rejected promise——不包这一层，一次数据库抖动就会变成一个"请求
 * 永远挂着、响应不发、也没有日志"的黑洞（比 500 难查得多）。
 * 与 `wrap` 分开：`wrap` 是**路由处理器**的兜底（回统一失败响应），中间件要把错误交给
 * Express 的错误链（`next(err)`），两者的收口位置不同。
 */
export function asyncMiddleware(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 店铺上下文中间件（**公开面用**，不带鉴权）。
 *
 * 公开浏览面允许不带 `X-Mk-Shop`（= 该节点全部**在售**店铺）；带了就必须指得中，
 * 否则 404——"你指的是哪家店"与"这家店不存在"是两种不同的失败，混成一个会让排查方向错掉。
 *
 * ## 三态必须显式：`shop` 为 null 只表示"没有请求头"
 *
 * 旧实现把"指到了、但该店暂停接单"也写成 `req.shop = null`，于是它与"没带头"同形。
 * 消费点只要写成 `req.shop ? byShop(req.shop) : allShops()`（聚合统计的默认写法），
 * 一个**挂起店页面**就会拿到**全节点合计**，还带着 `code:0` —— 前端无从分辨。
 *
 * 现在：
 *   · 没带头           ⇒ `req.shop = null`，`req.shopNotSellable = false`（唯一的"全节点"入口）；
 *   · 指到可售店铺     ⇒ `req.shop = row`，`req.shopNotSellable = false`；
 *   · 指到暂停接单店铺 ⇒ `req.shop = row`，`req.shopNotSellable = true`。
 *
 * 第三态**保留那一行**（不是置 null）是刻意的：任何照旧写 `req.shop ? ... : 全节点合计` 的
 * 消费点至少只会算错"这一家"，不会静默放大成全节点；而聚合统计专用中间件
 * `listedShopScope` 会直接拒绝第三态（见下）。
 */
export const optionalShop = asyncMiddleware(async (req, res, next) => {
  if (!(await loadPublicShopContext(req, res))) return;
  next();
});

/**
 * 聚合统计（跨店合计）的店铺作用域：**只有"没有请求头"能进入全节点合计**。
 *
 * 指到暂停接单的店铺时拒绝（409：资源存在、状态不允许），拒因与商品详情/下单闸
 * 共用 `shops.notSellableReason`——同一件事不可能在两处给出两种说法。
 * 为什么不是 404：那家店确实存在（抄错编号与"暂停接单"是两种失败，混成一个会把店主
 * 引向排查编号），而 409 让调用方知道"链接没错、是这家店现在不接单"。
 */
export const listedShopScope = asyncMiddleware(async (req, res, next) => {
  if (!(await loadPublicShopContext(req, res))) return;
  if (req.shopNotSellable) {
    fail(res, notSellableReason(req.shop), 409, 409);
    return;
  }
  next();
});

/** 解析公开面的店铺三态（两个中间件共用；返回 false = 已经把 404 写出去）。 */
async function loadPublicShopContext(req, res) {
  const { shop, unresolved } = await shopContextOf(req);
  if (unresolved) {
    fail(res, `请求头 ${SHOP_HEADER} 指向的店铺不存在（编号抄错，或该店已注销）`, 404, 404);
    return false;
  }
  attachShopContext(req, shop);
  return true;
}

/** 把店铺行挂到请求上（**唯一实现**：公开面与鉴权中间件共用，避免两处判 `listed`） */
function attachShopContext(req, shop) {
  req.shop = shop || null;
  req.shopNotSellable = !!shop && !shopSellable(shop);
}

/**
 * 鉴权中间件：解析 Bearer 令牌 + **解析这次请求作用于哪一家店**。
 *
 * ## 三个角色（判据在 `auth.roleOf`，本函数只消费结论）
 *  - `host`：节点主（`node.owner`）。节点级动作用 `nodeAdmin`（开店申请队列）；**店铺级 ownerOnly
 *    不含 host**——租户店铺的流水/导出/看板/擦除只认该店 `seller`，否则"跨店越权"只是从店员
 *    换成了节点主；他自己开的那家店的 seller 就是他，所以不受影响。
 *  - `owner`：该店 seller。`ownerOnly` 认它。
 *  - `staff`：该店自己那份店员名单（`shop_operators`，按店铺分）。`staffOnly` 认它。
 *
 * ## 登录是**节点级**的，所以 `X-Mk-Shop` 是**范围提示**，不是鉴权前置条件
 *
 * 令牌只说"这个地址登录了本节点"（见 auth.js 的 issueToken）。"这次请求动的是哪家店"
 * 分三种情形，判据全部只在这一处：
 *   · **买家动作**（`requireAuth`：不带角色要求）：店铺**从目标推导**，不需要请求头——
 *     建草稿取商品行的 `shop_code`（routes/orders.js），订单动作取订单行的 `shop_code`
 *     （orderScope.js 的 `findOrderInShop`，以及各 handler 传给 `isStaff` 的 `order.shop_code`）。
 *     带了头在这里只是"按这家店看"的提示（列表类端点据此限定范围），不是授权凭证。
 *   · **卖家动作**（`ownerOnly` / `staffOnly`）：这个地址能经营哪几家店是**授权事实**，
 *     由 `shops.seller` ∪ `shop_operators` 回答（`auth.operatedShopCodes`）。
 *     恰好一家 ⇒ 就是它，不必带请求头；**多于一家 ⇒ 必须点名**（缺头 = 400）：
 *     "哪一家"没有合理默认值，给一个默认会让请求方以为自己在动 A 店、实际动了 B 店，
 *     而所有写操作都成功、没有任何报错。带上头就必须指得中（否则 404），角色仍按
 *     **那一家**实时重算（`roleOf`）——节点级登录绝不等于节点级权限。
 *   · **节点主动作**（`nodeAdmin`）：与店铺无关，既不要求也不消费请求头（节点主可以一家店都没有，
 *     要求他"先挑一家店"就是把登录重新绑回店铺）。
 *
 * ## 旧形状（本次删掉）错在哪
 *
 * 旧实现写的是 `needShop = requireShop || ownerOnly || staffOnly`：缺头一律 400，
 * 且令牌里签发时的 `code` 必须与请求头解析出的那家一致（403）。于是"一次登录只能动一家店"，
 * 前端必须按店各登一次、各存一份令牌；而**买家下单**也被迫先声明一家店——那一层"声明"
 * 与"这单到底属于谁"其实是同一个事实（商品行的 `shop_code`），凭空多出一个可以不一致的输入。
 * 令牌里的店铺声明与那次比对整段删除（令牌里已没有 `code`）。
 */
export function makeAuthMiddleware(
  verifyToken,
  { ownerOnly = false, staffOnly = false, nodeAdmin = false, hostOnly = false } = {}
) {
  // 卖家面的两档必须落在**某一家店**的上下文里：它们的判据是"他在那家店里是什么角色"
  const sellerScope = ownerOnly || staffOnly;
  // 节点级两档：nodeAdmin（节点主 ∪ 员工）与 hostOnly（仅节点主）——都**不要求**请求头
  const nodeScope = nodeAdmin || hostOnly;
  const denyMessage = ownerOnly ? '需要店主权限（店铺级财务面仅该店店主可见）' : '需要店主/店员权限';
  return asyncMiddleware(async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) {
      fail(res, '未登录或令牌缺失', 401, 401);
      return;
    }
    /*
      **令牌无效是 401，鉴权内部失败是 503**（P3-3）：旧实现把 try 里的**一切**异常都映射成
      `401 + e.message`。于是 DB 连接池超时/链上读不到会被说成"未登录"（用户去重新登录，问题
      却不在令牌），同时把 `Pool timeout: acquire …` 这类内部字符串原样回给客户端（生产泄露
      内部结构）。两者是不同层的失败，必须分开：
        · `verifyToken` 只回答"这串令牌是不是本节点签发的、有没有过期"——它抛错就是 401；
        · 之后的角色/店铺/链上读取是**服务端依赖**——失败是 503（通用文案 + 服务端日志留原文）。
    */
    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      fail(res, '登录令牌无效或已过期，请重新登录', 401, 401);
      return;
    }
    try {
      /*
        节点/店铺角色（node.owner、node_staff、shops.seller、shop_operators）全部住本节点库，
        每次请求现读，没有"撤权后 15 秒仍可写"的窗口；仍走链上缓存的仲裁人判定在
        routes/orders.js 与 routes/evidenceFiles.js 的 `as='arbiter'` 分支单独 force。
      */
      const addr = String(payload.address || '').toLowerCase();

      if (nodeScope) {
        /*
          节点管理员 = 节点主 ∪ 节点员工（`auth.isNodeAdmin`）或**仅节点主**（`auth.isHost`）。
          员工与节点主同权限（审批开店、停用/恢复店铺等日常运营动作），但
          **PII 保留期擦除与节点审计不在此列**：前者跨租户且不可逆，后者含全节点 IP/操作者，
          这两件只有节点主能做（hostOnly）。
        */
        const allowed = hostOnly ? await isHost(addr) : await isNodeAdmin(addr);
        if (!allowed) {
          fail(res, hostOnly ? '需要节点主权限' : '需要节点主或节点员工权限', 403, 403);
          return;
        }
        /*
          **节点级动作不消费请求头**：`X-Mk-Shop` 只是只读回声（节点主可以一家店都没有）。
          解析成功就挂 `req.shop`；解析失败（编号抄错/店铺已注销）**忽略**，不能因此 404——
          旧实现把请求头的存在性当成节点级动作的前置条件，于是"带了一个过期编号"会让
          节点主连 `/api/shop/node` 都打不开。只忽略"指不中"这一种结论；解析本身抛错
          （库抖动）仍走外层 catch，不被吞掉。
        */
        let hinted = null;
        const ctx = await shopContextOf(req);
        if (!ctx.unresolved) hinted = ctx.shop;
        req.auth = payload;
        attachShopContext(req, hinted);
        req.shopRole = hinted ? await roleOf(addr, hinted.code) : 'user';
        next();
        return;
      }

      /*
        请求头是范围提示：带了就必须指得中。"你指的是哪家店"与"这家店不存在"是两种不同的失败，
        混成一个会让排查方向错掉（这条口径与 optionalShop 相同）。
      */
      const { shop: hinted, unresolved } = await shopContextOf(req);
      if (unresolved) {
        fail(res, `请求头 ${SHOP_HEADER} 指向的店铺不存在（编号抄错，或该店已注销）`, 404, 404);
        return;
      }

      if (sellerScope) {
        // 没带范围提示时的唯一候选：这个地址**恰好**经营一家店 ⇒ 就是它（多于一家 ⇒ 400）
        const shop = hinted || (await soleOperatedShop(addr, res, denyMessage));
        if (!shop) return; // soleOperatedShop 失败时已经把响应写出去
        const role = await roleOf(addr, shop.code);
        if (ownerOnly && role !== 'owner') {
          fail(res, denyMessage, 403, 403);
          return;
        }
        if (staffOnly && role !== 'owner' && role !== 'staff') {
          fail(res, denyMessage, 403, 403);
          return;
        }
        req.auth = payload;
        attachShopContext(req, shop);
        req.shopRole = role;
        next();
        return;
      }

      req.auth = payload;
      attachShopContext(req, hinted);
      req.shopRole = hinted ? await roleOf(addr, hinted.code) : 'user';
      next();
    } catch (e) {
      /*
        响应已经写出去了（例如某条 fail 之后又抛错）：不能再写第二次（会抛
        ERR_HTTP_HEADERS_SENT，在 catch 里没有下一层接住 ⇒ unhandledRejection ⇒ 进程退）。
        已发出的响应收不回，只能留日志并交给连接销毁/上游重试。
      */
      if (res.headersSent) {
        console.error(`[http] 鉴权过程中响应已发出后仍抛错：${req.method} ${req.originalUrl}：${e?.stack || e?.message || e}`);
        if (typeof res.destroy === 'function') res.destroy();
        return;
      }
      console.error(`[http] 鉴权内部失败（依赖不可用，不是令牌问题）：${req.method} ${req.originalUrl}：${e?.stack || e?.message || e}`);
      fail(res, '鉴权服务暂时不可用（内部错误），请稍后重试', 503, 503);
    }
  });
}

/**
 * 卖家动作在**没有**请求头时的店铺：这个地址恰好经营一家 ⇒ 返回那一行；多于一家 ⇒ 400。
 *
 * 失败时**已经把响应写出去**（与 routes/products.js 的 `requireShopProduct` 同款约定），
 * 调用方只需 `if (!shop) return;`：
 *   · 一家都没有 ⇒ 403：这是授权问题的正常回答（不是"参数没带"）；
 *   · 多于一家 ⇒ 400：没有合理默认值（给默认 = 静默对另一家店动手）；
 *   · 编号在清单里却读不到那一行 ⇒ 404：清单与店铺行同源，正常不可达，不猜、不兜底。
 *
 * ## "多于一家"是什么情形（2026-10-16 核实并写死口径）
 *
 * **一个地址在一个节点上只能开一家店**——这条由数据库的 `UNIQUE KEY uq_shops_seller (seller)`
 * 保证（`shops` 表那一行注释：一个钱包在本节点只能开一家），链上侧同样是"一个 host 一行"
 * （`MarketplaceRegistry._shopOf[seller][host]`，而一个节点就是一个 host）。
 * 所以 `operatedShopCodes` 的**并集**里出现第二家店，只可能来自一个来源：
 * **这个地址被另一家店写进了店员名单**（`shop_operators`）——即"我是 A 店店主，同时是 B 店店员"。
 *
 * 那条路径下的歧义是**真实的、无法消除的**：同一个"上架商品"动作，在 A 店与 B 店都是合法的，
 * 没有任何事实能推出"这次是哪一家"。所以 400 仍然是对的（给默认 = 静默动错店），
 * 而文案必须点出这个来源（说成"你开了多家店"是假话，用户会去找一个不存在的"我的店铺列表"）。
 */
async function soleOperatedShop(addr, res, denyMessage, { force = false } = {}) {
  const codes = await operatedShopCodes(addr, { force });
  if (codes.length === 0) {
    fail(res, `${denyMessage}（本地址在本节点没有可经营的店铺）`, 403, 403);
    return null;
  }
  if (codes.length > 1) {
    fail(
      res,
      `缺少请求头 ${SHOP_HEADER}：这个地址在本节点可经营 ${codes.length} 家店铺（${codes.join('、')}）——` +
        '你在一家店是店主，同时被其他店列入了店员名单；请指明本次操作哪一家（取值就是店铺编号）',
      400,
      400
    );
    return null;
  }
  const shop = await shopRowByCode(codes[0]);
  if (!shop) {
    fail(res, `店铺 ${codes[0]} 不存在（编号抄错，或该店已注销）`, 404, 404);
    return null;
  }
  return shop;
}
