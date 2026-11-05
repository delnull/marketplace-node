/**
 * 店铺信息与管理路由（经营参数全部网页化：**店名/公告是 `shops` 的列**，店员/通知各有自己的表）。
 *
 * 配置文件只保留"身份与接线"（节点主钱包/escrow/staking/端口等）；节点不读取任何 Registry。
 * 店名/公告/店员名单/通知 webhook 均在卖家面板「店铺设置」维护（即改即生效，无需重启）。
 * 节点自己的对外资料（名称/公告）是 `node` **单例行**的两列——它不是"某家店的名字"。
 *
 *  GET  /                节点信息（+ 带 X-Mk-Shop 时附该店信息）——买家页面与下单核验用
 *  GET  /node-identity   节点身份参数（owner/escrow/staking/chainId；endpoint 由登记工具填写）
 *  GET  /node            节点级只读运营读数（nodeAdmin；**不含任何店铺经营明细**）
 *  PUT  /node            编辑**节点资料**（nodeAdmin：名称/公告/谈信地址）
 *  PUT  /                编辑店铺资料 {name?, notice?, tanxinAddress?}（staffOnly；入审计）
 *  GET  /settings        店铺设置读取（ownerOnly：当前资料/店员列表/webhook 状态）
 *  PUT  /staff           店员管理 {action:'add'|'remove', address}（ownerOnly；入审计）
 *  PUT  /webhook         通知配置 {url, secret}（ownerOnly；secret 不回显，仅布尔状态）
 *  GET  /reputation      履约画像聚合统计（公开只读；带 X-Mk-Shop 时按该店限定）
 *  GET  /staking         本节点保证金状况（治理只读；口径见 src/stakingRisk.js）
 *  GET  /staking/requests 待审批的撤资申请（hostOnly；见 src/stakingRequests.js）
 *  GET  /reviews/stats   店铺买家评价聚合（公开只读）
 *  GET  /buyer-signal    买家履约信号（ownerOnly；**本店视角**，口径见 src/buyerSignal.js）
 *  GET  /metrics         运营指标（ownerOnly；待办/超时/挂账/对账读数，口径见 src/opsMetrics.js）
 *  GET  /sla             卖家 SLA 读数（ownerOnly；三份待办清单 + 发货时长分布，同上）
 *
 * **卖家面的店铺上下文由鉴权中间件解析**（见 http.js）：带 `X-Mk-Shop` 就按它（必须指得中），
 * 不带就取"这个地址在本节点唯一经营的那家店"；经营多家时必须点名（缺头 = 400，没有合理默认值）。
 */
import { Router } from 'express';
import config from '../config.js';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit, optionalShop, listedShopScope } from '../http.js';
import {
  verifySession,
  roleOf,
  isHost,
  getShopOperators,
  addShopOperator,
  removeShopOperator,
  nodeStaffList,
  addNodeStaff,
  removeNodeStaff,
} from '../auth.js';
import { getDb, withTransaction, abortTx } from '../db.js';
import { logAudit } from '../audit.js';
import { auditChanges } from '../auditDiff.js';
import { isAddress, isZeroAddress } from '../chain.js';
import { assertPublicHttpTarget } from '../netguard.js';
import { sweepOrphanUploads } from '../mediaSweep.js';
import { withRedisLock } from '../redis.js';
import { mediaUsage, REVIEW_IMAGE_MIMES, removeMediaByUrl } from '../productMedia.js';
import {
  MediaUploadError,
  UploadQuotaError,
  UploadUnavailableError,
  storeRequestMedia,
} from '../uploadFlow.js';
import { getRates, usdtMicroToPayWei, btyMicroToWei, isPayableAmount } from '../rates.js';
import {
  listPaymentMethods,
  tokenSupportedOnChain,
  listPaymentTokenConfigs,
  normalizePaymentToken,
  upsertPaymentToken,
  deletePaymentToken,
  assertTokenDecimals,
} from '../paymentTokens.js';
// 店铺（租户）事实源 + 节点单例（owner/节点资料）的唯一读入口：都从这里取，不在本文件另算一份
// `shopDisplayName/Notice`（店铺）与 `nodeDisplayName`（节点）是展示形的**唯一实现**：
// 店铺没有默认名（写入口拒绝空名），节点在 `''` 时回退对外域名/中性占位——见各自的说明
import {
  listShopRows,
  listListedShopRows,
  shopDto,
  shopDisplayName,
  shopDisplayNotice,
  nodeDisplayName,
  nodeOwner,
  nodeOwnerOf,
  nodeRow,
  avatarUrlOf,
  setShopAvatar,
  setNodeAvatar,
} from '../shops.js';
// 节点级运营读数（nodeAdmin）：只出"这台机器有没有在干活"，不出任何店铺经营明细
import { escrowWatcherStatus } from '../escrowWatcher.js';
import { chainReconcileStatus } from '../chainReconcile.js';
import { reputationSummary } from '../reputation.js';
import { shopReviewStats } from '../reviews.js';
// 谈信地址的唯一形状入口：两种写法（0x / 1 开头）与“清空”的语义都只在这里
import { parseTanxinAddress, tanxinAddressOf } from '../tanxin.js';
import { webhookStatus, sendTestEvent, webhookConfig, setWebhookConfig } from '../webhook.js';
import { overviewStats, trendStats, productStats, normalizeStatsDays } from '../stats.js';
// 本节点保证金状况的读数（治理只读；事实源与取舍见 src/stakingRisk.js）
import { stakingShortfall } from '../stakingRisk.js';
// 待审批撤资申请（节点主待办；不依赖事件索引，见 src/stakingRequests.js）
import { pendingUnstakeRequests } from '../stakingRequests.js';
// 买家履约信号（本店视角；口径、隐私边界与文案纪律见 src/buyerSignal.js 文件头）
import { buyerSignal } from '../buyerSignal.js';
// 运营读数与 SLA（待办谓词、托管超时、挂账、对账、发货时长的**唯一实现**）
import { opsMetrics, slaReading, SLA_LIMIT_DEFAULT, SLA_LIMIT_MAX } from '../opsMetrics.js';

const router = Router();
/**
 * 支付方式公开读：每次请求会对每个已配置 token 读一次链上白名单（无缓存时 N 次 RPC），
 * oracle 还可能出站取行情。给匿名读一个独立预算，避免被用来放大 RPC/出站流量。
 */
const paymentMethodsLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '支付方式查询过于频繁，请稍后再试' });
// 店铺级财务面：**只认该店店主（seller）**。host 不在此列——租户店铺的账不是节点主的账
// （他能看到的只有节点级读数，见 GET /node；他自己那家店的账也只有他作为 seller 才看得到）。
const ownerOnly = makeAuthMiddleware(verifySession, { ownerOnly: true });
const staffOnly = makeAuthMiddleware(verifySession, { staffOnly: true });
// 节点级：节点主 ∪ 节点员工（nodeAdmin；员工与节点主同权限的日常运营动作）。
// 注意 PII 保留期与节点审计**不在这里**：那两件是 hostOnly（仅节点主，见 routes/pii.js / audit.js）。
const nodeAdmin = makeAuthMiddleware(verifySession, { nodeAdmin: true });
// 增删节点员工是权限授予本身：只允许节点主，避免员工自行扩权/互授。
const hostOnly = makeAuthMiddleware(verifySession, { hostOnly: true });

/** 头像单文件上限：2MB（与图片类型的上限一致；头像不需要视频/大图） */
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** 头像上传限流：单 IP 每分钟 10 个（字节额度之外的第二道闸，挡脚本反复写盘） */
const avatarLimiter = simpleRateLimit({ windowMs: 60_000, max: 10, message: '头像上传过于频繁，请稍后再试' });

/**
 * 头像上传的失败形状与商品媒体一致：额度不足 / Redis 不可用 / 类型不符都是业务失败，
 * 未知异常继续冒泡给统一错误兜底。额度不足在**读请求体之前**就返回（见 uploadFlow.js）。
 */
function avatarUploadFail(res, e) {
  if (e instanceof UploadUnavailableError) return fail(res, e.message, 503, 503);
  if (e instanceof UploadQuotaError) return fail(res, e.message);
  if (e instanceof MediaUploadError) return fail(res, e.message);
  throw e;
}

/* ── 节点资料（`node` 单例行的 name/notice）──
 *
 * 为什么节点需要自己的名字：开节点与开店铺是两个独立动作——一个节点可以一家店都没有，
 * 但它仍然要在目录里有个名字。此前这个名字是**借**来的（节点主那家"自营店"的店名），
 * 于是"这台机器叫什么"取决于"节点主有没有给自己开过店"，而那两件事本来就无关。
 * 现在它是那一行自己的列（`node.name`/`node.notice`），与任何店铺无关。
 *
 * 单例性由 schema 保证（`CHECK (id = 1)`），所以这里没有"哪一行"的参数：
 * 行本身由 db.js 的 initDb() 种入，本模块只读写它。
 */

/** 节点对外名称（`node.name` 的展示形；'' = 没设置过 ⇒ 回退对外域名，再回退中性占位） */
export async function nodeNameOf() {
  return nodeDisplayName(await nodeRow());
}

/**
 * 节点资料的唯一写入口（路由只负责校验与审计）。
 * 三列**一起写**：调用方（PUT /node）已经读过当前值并把"只改其中一项"合并成完整的一组——
 * 用 `COALESCE(?, col)` 那种写法分不开"不改"与"改成空串"（公告与谈信地址都要能清空）。
 * `tanxinAddress` **必须显式给出**（`null` = 清空）：漏传时抛错，而不是静默把旧地址抹掉。
 */
export async function setNodeProfile(profile) {
  if (!Object.prototype.hasOwnProperty.call(profile || {}, 'tanxinAddress')) {
    throw new Error('setNodeProfile 必须显式给出 tanxinAddress（null = 清空；undefined 不是"不改"）');
  }
  const { name, notice, tanxinAddress } = profile || {};
  await getDb().run(
    'UPDATE node SET name = ?, notice = ?, tanxin_address = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1',
    String(name ?? ''),
    String(notice ?? ''),
    tanxinAddress == null ? null : String(tanxinAddress)
  );
}

/**
 * 店铺资料编辑（店名/公告/谈信地址）的写入口（唯一写入点；路由只负责校验与审计）。
 * 与节点资料同款：三列一起写（调用方已把"只改其中一项"合并好）；
 * `tanxinAddress` 同样必须显式给出（`null` = 清空），漏传即抛错。
 */
export async function setShopProfile(row, profile) {
  if (!Object.prototype.hasOwnProperty.call(profile || {}, 'tanxinAddress')) {
    throw new Error('setShopProfile 必须显式给出 tanxinAddress（null = 清空；undefined 不是"不改"）');
  }
  const { name, notice, tanxinAddress } = profile || {};
  await getDb().run(
    'UPDATE shops SET name = ?, notice = ?, tanxin_address = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE code = ?',
    String(name ?? ''),
    String(notice ?? ''),
    tanxinAddress == null ? null : String(tanxinAddress),
    String(row.code || '')
  );
}

/**
 * 审计的 actorRole 取**这家店里的角色**（host/owner/staff）。
 * 多店之前它是"与一个全局常量比一次"；现在同一地址在不同店里的角色可以不同，
 * 而"他在哪家店、以什么身份做了这件事"正是审计要回答的问题——所以店铺上下文必须进这一行。
 *
 * `shopCode` **每处显式给**（`null` = 节点级）：这里有一条 nodeAdmin 的节点资料路由（PUT /node），
 * 而 nodeAdmin 路由上的 `req.shop` 只是**请求头的回声**（节点主可以一家店都没有，也不消费它），
 * 拿它当归属就是"把节点级动作记到某家店头上"。所以归属不能从 req.shop 推，只能由调用点声明。
 * 角色与归属取**同一个值**（下面那个 `shopCode`），否则"以什么身份"与"在哪家店"会各说一套。
 */
const audit = async (req, action, targetType, targetId, detail, shopCode) => {
  const actor = req.auth?.address;
  /*
    节点级动作（`shopCode == null`）的 actorRole：节点主记 `host`、节点员工记 `staff`——
    "以什么身份"必须如实，否则节点员工做的审批会记成节点主做的（2026-10-18 员工上线后
    两者权限相同、但责任主体不同）。
  */
  const actorRole = shopCode
    ? (await isHost(actor))
      ? 'host'
      : await roleOf(actor || '', shopCode)
    : (await isHost(actor))
      ? 'host'
      : 'staff';
  return logAudit({
    req,
    actor,
    actorRole,
    shopCode,
    action,
    targetType,
    targetId,
    detail,
  });
};

/*
  公开只读聚合端点的限流（此前**完全无限流**，而它们都是 O(全表) 的）：
   · /reputation：reputationSummary 扫全表订单并对每行解析事件史——
     单次就是一次全表解析，匿名脚本按秒轮询即可把 CPU 打满；
   · /reviews/stats：reviews 表聚合（较轻，但同样是公开面）。
  数值依据：联邦前端的目录页会对**每个可达节点**各打一次 reputation（useNodeDirectory 扇出，
  各家店同一 IP 从同一浏览器发出），商家主页另加一次——60 次/分足够"一屏几十家店 × 几次
  页面切换"，而脚本化 1 次/秒以下的全表扫描才可能碰到上限（2 次/秒即挡）。
  注意：与 simpleRateLimit 的其它用法一样是**Redis 固定窗口**（跨进程共享，失败 fail-closed）。
*/
const reputationLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '店铺履约画像查询过于频繁，请稍后再试' });
const reviewsStatsLimiter = simpleRateLimit({ windowMs: 60_000, max: 120, message: '店铺评价统计查询过于频繁，请稍后再试' });

/**
 * 节点信息（公开只读；买家店铺页/下单核验用）。
 *
 * **这是节点级读数**：`owner` 是节点 operator（`node.owner`），店铺列表在 `/api/shops`。
 * 带 `X-Mk-Shop` 时附带该店的信息——前端一次请求就能同时拿到"这台机器是谁"与
 * "我要看的是哪家店"，不必两跳。
 *
 * 平台目录可以用 **endpoint**（不是编号）标识一台机器：节点只暴露自己的身份参数，
 * 登记由 operator 钱包在客户端按目标 Registry 签名，节点不读取也不依赖任何 Registry。
 */
router.get('/', optionalShop, wrap(async (req, res) => {
  // 节点资料三列同住 node 单例行：读一次，别为 name/notice/tanxin 各查一遍
  const node = await nodeRow();
  const owner = nodeOwnerOf(node);
  /*
    带 X-Mk-Shop 时即使这家店暂停接单也返回它的身份（`listed:false`）：
    店铺页要能显示“暂停接单”而不是 404；商品/聚合端点仍由 listedShopScope 拒绝。
    不带请求头时 req.shop 为 null，不会泄露任何店。
  */
  const shop = req.shop;
  const listed = await listListedShopRows();
  ok(res, {
    /* 节点 operator：链上 Registry 登记的主体，也是 Escrow/Staking 的 owner；唯一的字段名。 */
    host: owner || null,
    /*
      **节点自己的名字/公告**（不是某家店的名字）：开节点与开店铺是两个独立动作，
      一个节点可以一家店都没有，但它仍然要在目录里显示一个名字。
    */
    name: nodeDisplayName(node),
    notice: shopDisplayNotice(node),
    avatarUrl: avatarUrlOf(node),
    /** 节点自己的谈信地址（公开客服联系方式）；null = 没设置过 */
    tanxinAddress: tanxinAddressOf(node),
    chainId: config.chain.chainId,
    escrowAddress: config.chain.escrowAddress || null,
    stakingAddress: config.chain.stakingAddress || null,
    timeoutBlocks: config.escrow.timeoutBlocks,
    shops: listed.map((r) => shopDto(r, owner)),
    ...(shop ? { shop: shopDto(shop, owner) } : {}),
    version: config.version,
  });
}));

/**
 * 节点身份（公开只读）：客户端/登记工具据此组 `registerNode` 参数。
 *
 * 只暴露节点自己的事实：operator、Escrow/Staking 地址、chainId、endpoint 由调用方提供。
 * Registry 列表不在节点配置里，节点也不反向读取任何目录；同一份身份可由 operator
 * 分别登记到任意多个 Registry。
 */
router.get('/node-identity', wrap(async (req, res) => {
  const node = await nodeRow();
  const owner = nodeOwnerOf(node);
  ok(res, {
    owner: owner || null,
    name: nodeDisplayName(node),
    notice: shopDisplayNotice(node),
    avatarUrl: avatarUrlOf(node),
    tanxinAddress: tanxinAddressOf(node),
    chainId: config.chain.chainId,
    escrowAddress: config.chain.escrowAddress || null,
    stakingAddress: config.chain.stakingAddress || null,
    canRegister: !!(owner && config.chain.escrowAddress && config.chain.stakingAddress),
    version: config.version,
  });
}));

/**
 * 节点级只读运营读数（nodeAdmin）——**节点主必须能判断自己的服务是否正常**，
 * 而不是"节点主可以看别人的生意"。
 *
 * 因此这里的每一行都只回答"这台机器/这份服务怎么样"：后台任务活性、名下有几家店、
 * 几家在售、节点员工名单。**不含**订单、买家、金额、商品等任何店铺经营明细——
 * 那些只有该店店主能通过店铺级端点读到。
 */
router.get('/payment-methods', paymentMethodsLimiter, wrap(async (req, res) => {
  const raw = String(req.query.priceMicro ?? '').trim();
  const currency = String(req.query.priceCurrency ?? '').trim().toUpperCase();
  if (!currency) return fail(res, '必须指定计价币种（USDT 或 BTY）');
  if (!['USDT', 'BTY'].includes(currency)) return fail(res, '计价币种只能是 USDT 或 BTY');
  let total = null;
  if (raw) {
    if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) return fail(res, `金额必须是正整数（${currency} 微单位）`);
    total = raw;
  }
  /*
    BTY 定价：金额本身就是 BTY，只列原生 BTY，**不读行情**、不列 ERC20
    （列出别的币种就意味着要做 BTY→代币换算，与"BTY 定价不需要行情转换"直接矛盾）。
    USDT 定价：原生金额走 USDT→BTY 行情，ERC20 走节点自己的报价。
  */
  if (currency === 'BTY') {
    const nativeAmount = total ? btyMicroToWei(total) : null;
    return ok(res, {
      native: {
        token: 'native',
        symbol: 'BTY',
        decimals: 18,
        usdtMicroPerToken: null,
        amountWei: nativeAmount,
        payable: nativeAmount === null ? null : isPayableAmount(nativeAmount),
      },
      tokens: [],
    });
  }
  const rates = await getRates();
  const nativeAmount = total ? usdtMicroToPayWei(total, rates) : null;
  const tokens = await listPaymentMethods(total);
  /*
    公开支付方式必须与链上 `supportedToken` 一致：只列环境变量里“配置了”的 token，
    买家会先建草稿、占库存，到签名前才被 Escrow 拒绝。supported=false 直接剔除；
    RPC 读不到则保留但标记 unavailable（前端置灰），不把“读不到”当成可用。
  */
  let filtered = tokens;
  if (tokens.length) {
    try {
      if (!config.chain.escrowAddress) {
        filtered = tokens.map((t) => ({ ...t, supported: false, unavailable: '节点未接入托管合约' }));
      } else {
        const flags = await Promise.all(tokens.map((t) => tokenSupportedOnChain(t.token)));
        filtered = tokens
          .map((t, i) => ({ ...t, supported: !!flags[i] }))
          .filter((t) => t.supported);
      }
    } catch (e) {
      // 公开端点不回内部 RPC 错误原文（拓扑/端点会随错误消息泄露）；原文只进节点日志。
      console.warn(`[shop] 支付白名单链上核验失败：${e?.message || e}`);
      filtered = tokens.map((t) => ({ ...t, supported: null, unavailable: '链上支付白名单暂时不可核验' }));
    }
  }
  ok(res, {
    native: {
      token: 'native',
      symbol: 'BTY',
      decimals: 18,
      usdtMicroPerToken: null,
      amountWei: nativeAmount,
      payable: nativeAmount === null ? null : isPayableAmount(nativeAmount),
    },
    tokens: filtered,
  });
}));

/**
 * 节点级 ERC20 支付资产（**只有节点主**）：配置存库、页面维护；链上 `Escrow.supportedToken`
 * 仍是"能不能收"的唯一授权。租户店主不是节点主，不能决定这台机器收哪些币。
 */
router.get('/payment-tokens', hostOnly, wrap(async (req, res) => {
  const methods = await listPaymentMethods(null);
  const configs = await listPaymentTokenConfigs();
  const cfgBy = new Map(configs.map((c) => [c.address, c]));
  let escrow = null;
  let supported = {};
  try {
    escrow = config.chain.escrowAddress || null;
    const flags = await Promise.all(methods.map((m) => tokenSupportedOnChain(m.token)));
    supported = Object.fromEntries(methods.map((m, i) => [m.token, !!flags[i]]));
  } catch {
    /* 未部署 Escrow / RPC 不可达：supported 保持空对象，前端显示"未核验" */
  }
  ok(res, {
    escrow,
    tokens: methods.map((m) => {
      const c = cfgBy.get(m.token);
      return {
        ...m,
        fixedUsdtMicroPerToken: c?.fixed ?? null,
        priceUrl: c?.priceUrl ?? null,
        supported: supported[m.token] ?? null,
      };
    }),
  });
}));

/** 新增/更新一条支付资产配置（节点主；保存不代替链上启用）。 */
router.post('/payment-tokens', hostOnly, wrap(async (req, res) => {
  let token;
  try {
    token = normalizePaymentToken(req.body);
  } catch (e) {
    return fail(res, e.message);
  }
  if (!config.chain.escrowAddress) {
    return fail(res, '本节点未接入托管合约（托管合约地址未配置）：先完成托管接线，否则配了也收不了代币');
  }
  if (token.mode === 'oracle') {
    const target = await assertPublicHttpTarget(token.priceUrl);
    if (!target.ok) return fail(res, `行情源校验未通过：${target.message}`);
  }
  try {
    await assertTokenDecimals(token.address, token.decimals);
  } catch (e) {
    return fail(res, e.message, 1, 503);
  }
  const prev = (await listPaymentTokenConfigs()).find((c) => c.address === token.address) ?? null;
  await upsertPaymentToken(token);
  /*
    支付资产配置也是"改前 → 改后"：改固定价/行情源会直接影响买家实付，只有新值不够。
    新增（prev=null）没有旧值；更新时把配置字段逐一对比。字符串/数字先归一成同一形
    （`prev.fixed` 是 DB 读回的字符串、`token.fixed` 可能是数字），否则 5000000 与 "5000000"
    会被 diff 当成"变了"。
    **行情源 URL 不写原文**：URL 常带 `?apikey=`/token，审计是 append-only 且会进 CSV——
    只记录"有没有设置"，与 webhook 不记 URL/secret 同一口径。
  */
  const norm = (v) => (v == null || v === '' ? null : String(v));
  const before = prev
    ? {
        symbol: prev.symbol,
        decimals: prev.decimals,
        mode: prev.mode,
        fixedUsdtMicroPerToken: norm(prev.fixed),
        priceUrlSet: !!prev.priceUrl,
      }
    : null;
  const after = {
    symbol: token.symbol,
    decimals: token.decimals,
    mode: token.mode,
    fixedUsdtMicroPerToken: norm(token.fixed),
    priceUrlSet: !!token.priceUrl,
  };
  const diff = before ? auditChanges(before, after, Object.keys(after)) : { fields: [], changes: {} };
  /*
    新增没有"改前"：不写空的 fields/changes（否则界面会把一次新增说成"未发生变更"）。
    更新时 current 字段 + 变更对一起下发，摘要既能显示现值，也能显示旧值。
  */
  const detail = before ? { ...after, fields: diff.fields, changes: diff.changes } : { ...after };
  await audit(req, 'payment_token.save', 'node', token.address, detail, null);
  ok(res, { token }, '已保存；还需节点主钱包在链上启用 supportedToken，买家才能用它付款');
}));

/** 删除一条配置（只停止未来报价；已托管订单仍按快照里的支付资产结算）。 */
router.delete('/payment-tokens/:address', hostOnly, wrap(async (req, res) => {
  const address = String(req.params.address || '').trim().toLowerCase();
  if (!isAddress(address)) return fail(res, '支付资产地址非法');
  const deleted = await deletePaymentToken(address);
  if (!deleted) return fail(res, '该支付资产配置不存在', 404, 404);
  await audit(req, 'payment_token.delete', 'node', address, {
    symbol: deleted.symbol,
    decimals: deleted.decimals,
    mode: deleted.mode,
    fixedUsdtMicroPerToken: deleted.fixed,
    /* 与 save 同口径：不把可能带凭据的 URL 写进 append-only 审计 */
    priceUrlSet: !!deleted.priceUrl,
  }, null);
  ok(res, { address }, '已删除配置（链上 supportedToken 仍由节点主自行关停）');
}));

router.get('/node', nodeAdmin, wrap(async (req, res) => {
  const rows = await listShopRows();
  const node = await nodeRow();
  const owner = nodeOwnerOf(node);
  ok(res, {
    host: owner || null,
    // 节点资料（名称/公告/谈信地址）：与任何一家店无关，见 nodeNameOf 的说明
    name: nodeDisplayName(node),
    notice: shopDisplayNotice(node),
    avatarUrl: avatarUrlOf(node),
    tanxinAddress: tanxinAddressOf(node),
    shops: rows.map((r) => shopDto(r, owner)),
    counts: {
      shops: rows.length,
      listed: rows.filter((r) => Number(r.listed) === 1).length,
    },
    // 节点员工是**节点链下名单**（node_staff）：节点级动作没有链上交易，名单住本节点库
    staff: await nodeStaffList(),
    tasks: {
      watcher: await escrowWatcherStatus(),
      reconcile: chainReconcileStatus(),
    },
    /*
      上传目录用量（{files, bytes, readable}）：`/healthz` 里也有一份，但探活是给编排看的、页面上没人读。
      而"磁盘是这个功能新引入的失败面"（视频把单个孤儿的成本抬到 50MB），节点主在管理页上
      要能看到它、并在同一页触发清扫（见 /media/sweep-orphans）。
      `readable: false` = 读不到（不是"0 个文件"），界面必须分开说。
    */
    uploads: mediaUsage(),
  });
}));

/**
 * 节点员工名单（nodeAdmin）：本节点 `node_staff` 表的只读视图。
 *
 * 为什么没有链上入口：平台 Registry 只登记节点 operator，没有"节点员工"这个概念；
 * 节点级动作（审批开店、停用店铺）全在本节点库里完成，不需要任何员工签名。
 */
router.get('/node-staff', nodeAdmin, wrap(async (req, res) => {
  const hostAddr = await nodeOwner();
  ok(res, { host: hostAddr || null, staff: await nodeStaffList() });
}));

/**
 * 增删节点员工（hostOnly；入审计）。员工名单只是本节点的一张本地表，不读任何 Registry；
 * 但"授予员工权限"本身只能由节点主做，员工不能互授/扩权。
 */
router.put('/node-staff', hostOnly, wrap(async (req, res) => {
  const action = String(req.body?.action || '');
  const address = String(req.body?.address || '').trim().toLowerCase();
  if (!['add', 'remove'].includes(action)) return fail(res, '动作只能是添加或移除');
  if (!isAddress(address) || isZeroAddress(address)) return fail(res, '地址必须是 0x 开头的以太坊地址（零地址不可加入）');
  const owner = await nodeOwner();
  if (owner && address === owner) return fail(res, '节点主无需加入员工名单（节点主权限恒高于员工）');
  if (action === 'add') {
    await addNodeStaff(address);
  } else {
    await removeNodeStaff(address);
  }
  const next = await nodeStaffList();
  await audit(req, 'node.staff.' + action, 'node', address, { staff: next.length }, null);
  ok(res, { staff: next }, action === 'add' ? '已加入节点员工名单（节点级动作可用）' : '已移出节点员工名单（下一次请求即失效）');
}));

/**
 * 节点主编辑**节点资料**（名称/公告/谈信客服地址；入审计）。
 *
 * 这些是**节点对外的身份**，不是运营动作：员工能改店名/公告/客服地址，就能在节点自己的
 * 品牌下把买家导流到攻击者客服。节点员工只做日常运营（审批/停用/下架），身份写入留 hostOnly。
 * 与"某家店的资料"是两件事，行也分开。
 */
router.put('/node', hostOnly, wrap(async (req, res) => {
  const { name, notice, tanxinAddress } = req.body || {};
  const node = await nodeRow();
  // 合并用**原始列值**（不是展示形）：只改公告时不能把默认店名顺手写进库里——
  // 那会把"没设置过"这个事实抹掉（而它正是回默认名的依据）。
  const curName = String(node?.name || '');
  const curNotice = String(node?.notice || '');
  const curTanxin = tanxinAddressOf(node);
  const nextName = name !== undefined ? String(name).trim().slice(0, 60) : curName;
  const nextNotice = notice !== undefined ? String(notice).trim().slice(0, 500) : curNotice;
  if (name !== undefined && !nextName) return fail(res, '节点名不能为空（≤60 字）');
  let nextTanxin = curTanxin;
  if (tanxinAddress !== undefined) {
    const parsed = parseTanxinAddress(tanxinAddress);
    if (!parsed.ok) return fail(res, parsed.error);
    nextTanxin = parsed.value;
  }
  await setNodeProfile({ name: nextName, notice: nextNotice, tanxinAddress: nextTanxin });
  /*
    节点级动作：**不属于任何一家店**（节点主可以一家店都没有；带上 X-Mk-Shop 也只是范围提示），
    所以显式传 null，而不是从 req.shop 猜一个归属。

    `changes` 是**改前 → 改后**：`nameChanged/noticeChanged/tanxinChanged` 只说"变没变"，
    店主/节点主事后看不出改成了什么（改名与改公告都可能是争议点）。旧的三个布尔不再写；
    历史行仍带它们，界面按旧形状回显（append-only 的显示兜底，不是写入兼容）。
  */
  const diff = auditChanges(
    { name: curName, notice: curNotice, tanxinAddress: curTanxin },
    { name: nextName, notice: nextNotice, tanxinAddress: nextTanxin },
    ['name', 'notice', 'tanxinAddress']
  );
  await audit(req, 'node.update', 'node', 'node', { fields: diff.fields, changes: diff.changes }, null);
  ok(
    res,
    { name: shopDisplayName({ name: nextName }), notice: nextNotice, tanxinAddress: nextTanxin },
    '节点资料已更新（目录与店铺页即时生效；链上登记不含展示资料，无需同步）'
  );
}));

/** 店主/店员编辑店铺资料：公告店员可改，店名/谈信客服地址仅店主（身份字段，入审计） */
router.put('/', staffOnly, wrap(async (req, res) => {
  const shop = req.shop;
  const { name, notice, tanxinAddress } = req.body || {};
  /*
    店名与谈信客服地址是**买家看到的身份/客服入口**，不是运营文案；店员改它就能把买家
    导流到自己的客服。公告可以由店员维护，身份字段只认店主。
  */
  if (req.shopRole !== 'owner' && (name !== undefined || tanxinAddress !== undefined)) {
    return fail(res, '仅店主可修改店铺名与谈信客服地址（店员只能改公告）', 403, 403);
  }
  // 同上：合并用原始列值，只改一项时另一项保持原样（'' 仍然是"没设置过"）
  const curName = String(shop.name || '');
  const curNotice = String(shop.notice || '');
  const curTanxin = tanxinAddressOf(shop);
  const nextName = name !== undefined ? String(name).trim().slice(0, 60) : curName;
  const nextNotice = notice !== undefined ? String(notice).trim().slice(0, 500) : curNotice;
  if (name !== undefined && !nextName) return fail(res, '店铺名不能为空（≤60 字）');
  let nextTanxin = curTanxin;
  if (tanxinAddress !== undefined) {
    const parsed = parseTanxinAddress(tanxinAddress);
    if (!parsed.ok) return fail(res, parsed.error);
    nextTanxin = parsed.value;
  }
  await setShopProfile(shop, { name: nextName, notice: nextNotice, tanxinAddress: nextTanxin });
  // 店铺资料同样记**改前 → 改后**；布尔标志只保留在历史行里（见 auditScope 的旧形状回显）
  const diff = auditChanges(
    { name: curName, notice: curNotice, tanxinAddress: curTanxin },
    { name: nextName, notice: nextNotice, tanxinAddress: nextTanxin },
    ['name', 'notice', 'tanxinAddress']
  );
  await audit(
    req,
    'shop.update',
    'shop',
    shop.code,
    { fields: diff.fields, changes: diff.changes },
    shop.code
  );
  ok(
    res,
    { code: shop.code, name: shopDisplayName({ name: nextName }), notice: nextNotice, tanxinAddress: nextTanxin },
    '店铺资料已更新（买家店铺页即时生效；链上登记不含展示资料，无需同步）'
  );
}));

/**
 * 店铺头像（ownerOnly）：请求体就是图片字节（与 /api/uploads 同一种传输形状）。
 *
 * 头像是**店铺对买家的身份**，和店名/谈信地址同级：只有店主能改（店员改头像同样能把
 * 买家导流/冒充），所以这里用 ownerOnly 而不是 staffOnly。上传成功后把旧文件删掉——
 * 头像没有订单快照引用，不适用"孤儿媒体刻意不删"那条（见 productMedia.js）。
 */
router.post('/avatar', ownerOnly, avatarLimiter, wrap(async (req, res) => {
  const shop = req.shop;
  const old = avatarUrlOf(shop);
  let stored;
  try {
    stored = await storeRequestMedia(req, req.auth.address, {
      maxUploadBytes: AVATAR_MAX_BYTES,
      allowedMimes: REVIEW_IMAGE_MIMES,
      label: '头像',
    });
  } catch (e) {
    return avatarUploadFail(res, e);
  }
  try {
    await setShopAvatar(shop.code, stored.url);
  } catch (e) {
    // 写库失败就把刚落的文件删掉：不能让一个没人引用的头像占着盘
    removeMediaByUrl(stored.url);
    throw e;
  }
  if (old && old !== stored.url) removeMediaByUrl(old);
  await audit(req, 'shop.avatar.update', 'shop', shop.code, { size: stored.size, mime: stored.mime }, shop.code);
  ok(res, { avatarUrl: stored.url }, '店铺头像已更新（旧头像文件已清理）');
}));

/** 店铺头像移除（ownerOnly；幂等） */
router.delete('/avatar', ownerOnly, wrap(async (req, res) => {
  const shop = req.shop;
  const old = avatarUrlOf(shop);
  await setShopAvatar(shop.code, '');
  if (old) removeMediaByUrl(old);
  await audit(req, 'shop.avatar.clear', 'shop', shop.code, { hadAvatar: !!old }, shop.code);
  ok(res, { avatarUrl: '' }, '店铺头像已移除（回退为按身份生成的色块）');
}));

/**
 * 节点头像（hostOnly）：与节点名/公告同级，是节点对外身份；员工不能改写。
 * 节点可以一家店都没有，所以这里不要求也不消费 X-Mk-Shop。
 */
router.post('/node/avatar', hostOnly, avatarLimiter, wrap(async (req, res) => {
  const node = await nodeRow();
  const old = avatarUrlOf(node);
  let stored;
  try {
    stored = await storeRequestMedia(req, req.auth.address, {
      maxUploadBytes: AVATAR_MAX_BYTES,
      allowedMimes: REVIEW_IMAGE_MIMES,
      label: '头像',
    });
  } catch (e) {
    return avatarUploadFail(res, e);
  }
  try {
    await setNodeAvatar(stored.url);
  } catch (e) {
    removeMediaByUrl(stored.url);
    throw e;
  }
  if (old && old !== stored.url) removeMediaByUrl(old);
  await audit(req, 'node.avatar.update', 'node', 'node', { size: stored.size, mime: stored.mime }, null);
  ok(res, { avatarUrl: stored.url }, '节点头像已更新（旧头像文件已清理）');
}));

/** 节点头像移除（hostOnly；幂等） */
router.delete('/node/avatar', hostOnly, wrap(async (req, res) => {
  const node = await nodeRow();
  const old = avatarUrlOf(node);
  await setNodeAvatar('');
  if (old) removeMediaByUrl(old);
  await audit(req, 'node.avatar.clear', 'node', 'node', { hadAvatar: !!old }, null);
  ok(res, { avatarUrl: '' }, '节点头像已移除（回退为按身份生成的色块）');
}));

/**
 * 店主自助歇业/复业。
 *
 * 与节点管理员 `PATCH /api/shops/admin/:code/listing` 是两件事：
 *  · 店主只能暂停**自己**的店，且只有自己暂停的店能自己恢复；
 *  · 节点管理员暂停的店（listed_reason 没有 `店主歇业：` 前缀）店主不能绕过恢复。
 * 这是一致性约束，不是“信任店主”：管理员暂停通常有平台侧原因。
 */
router.patch('/listing', ownerOnly, wrap(async (req, res) => {
  const shop = req.shop;
  const listed = req.body?.listed;
  if (typeof listed !== 'boolean') return fail(res, '接单状态必须是布尔值（是=复业，否=歇业）', 400, 400);
  const reason = String(req.body?.reason ?? '').trim().slice(0, 120);
  const currentlyListed = Number(shop.listed) === 1;
  if (listed === currentlyListed) {
    return fail(res, listed ? '店铺已在营业，无需恢复' : '店铺已歇业，无需重复操作', 409, 409);
  }
  const db = getDb();
  if (!listed) {
    const pauseReason = `店主歇业：${reason || '店主自主歇业'}`.slice(0, 200);
    const paused = await db.run(
      'UPDATE shops SET listed = 0, listed_reason = ?, listed_at = CURRENT_TIMESTAMP(3) WHERE code = ? AND seller = ? AND listed = 1',
      pauseReason,
      shop.code,
      shop.seller
    );
    if (paused.foundRows !== 1) return fail(res, '店铺状态已变化，请刷新后重试', 409, 409);
    await audit(req, 'shop.self_suspend', 'shop', shop.code, { reason: pauseReason }, shop.code);
    return ok(res, { listed: false, listedReason: pauseReason }, '已歇业：店铺不再接新订单，在途订单/退款/售后照常');
  }
  if (!String(shop.listed_reason || '').startsWith('店主歇业：')) {
    return fail(res, '该店由节点管理员暂停，需联系节点管理员恢复', 403, 403);
  }
  const resumed = await db.run(
    "UPDATE shops SET listed = 1, listed_reason = '', listed_at = CURRENT_TIMESTAMP(3) WHERE code = ? AND seller = ? AND listed = 0 AND listed_reason LIKE '店主歇业：%'",
    shop.code,
    shop.seller
  );
  if (resumed.foundRows !== 1) return fail(res, '店铺状态已变化，请刷新后重试', 409, 409);
  await audit(req, 'shop.self_resume', 'shop', shop.code, {}, shop.code);
  ok(res, { listed: true, listedReason: '' }, '已复业：商品重新进入店铺聚合面');
}));


/** 节点主清理孤儿媒体：只删全库无引用且超过 TTL 的文件；商品/订单快照/评价引用都保护。 */
router.post('/media/sweep-orphans', hostOnly, wrap(async (req, res) => {
  const days = req.body?.olderThanDays === undefined ? 7 : Number(req.body.olderThanDays);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return fail(res, '天数必须是 1 到 365 的整数', 400, 400);
  }
  const run = await withRedisLock(
    'media-orphans',
    60_000,
    () => sweepOrphanUploads({ olderThanMs: Math.floor(days) * 86_400_000 }),
    { renewMs: 20_000 }
  );
  if (!run.acquired) {
    return fail(res, '另一个实例正在清理孤儿媒体（或上一次清理尚未释放锁），请稍后重试', 1, 409);
  }
  const r = run.value;
  await audit(req, 'media.orphan_sweep', 'node', 'uploads', { days: Math.floor(days), ...r }, null);
  ok(res, r, `孤儿媒体清扫：删除 ${r.removed} 个文件${r.failed ? `，${r.failed} 个删除失败` : ''}`);
}));

/** 店铺设置读取（ownerOnly）：当前资料/店员列表/webhook 状态（secret 不回显） */
router.get('/settings', ownerOnly, wrap(async (req, res) => {
  const shop = req.shop;
  const dto = shopDto(shop, await nodeOwner());
  ok(res, {
    code: shop.code,
    seller: shop.seller,
    name: shopDisplayName(shop),
    notice: shopDisplayNotice(shop),
    avatarUrl: avatarUrlOf(shop),
    tanxinAddress: tanxinAddressOf(shop),
    listed: dto.listed,
    listedReason: dto.listedReason,
    listedAt: dto.listedAt,
    // 店员名单一行一人（`shop_operators`）：读的是一份真名单，不是一段 JSON
    operators: await getShopOperators(shop.code),
    /*
      webhook 的形状与读写只有 `webhook.js` 一份实现（表 `shop_webhook`，一行一店），这里也走它：
      旧实现路由自己拼 `shop:<code>:webhook_url/secret` 两个 kv 键，于是"读的键"与"写的键"
      可以各自演化成两种形状——而那种不一致的症状是**通知静默停发、日志里一个字都没有**。
    */
    webhook: await webhookStatus(shop.code),
  });
}));

/**
 * 店员管理（ownerOnly；白名单在 `shop_operators`，鉴权每请求实时读取；入审计）。
 *
 * **增删各是一条语句**（一行一人）：旧形状是 kv 里一份 JSON 数组，"加一个"是
 * "读出来、改、写回去"——两个并发请求（两个标签页各加一个人）都读到同一份旧列表，
 * 后写的那份把先写的整个盖掉，于是**被移除的店员仍然在名单里**（撤权失败，且静默）。
 * 现在"丢更新"在形状上不可表达：不需要事务，也不需要先读一遍。
 */
router.put('/staff', ownerOnly, wrap(async (req, res) => {
  const shop = req.shop;
  const action = String(req.body?.action || '');
  const address = String(req.body?.address || '').trim().toLowerCase();
  if (!['add', 'remove'].includes(action)) return fail(res, '动作只能是添加或移除');
  if (!isAddress(address) || isZeroAddress(address)) return fail(res, '地址必须是 0x 开头的以太坊地址（零地址不可加入）');
  if (address === String(shop.seller || '').toLowerCase()) return fail(res, '店主无需加入店员名单（店主权限恒高于店员）');
  let removed = false;
  if (action === 'add') {
    // 幂等：已在名单里时那条语句自己什么都不改（撞主键即"已经在了"）
    await addShopOperator(shop.code, address);
  } else {
    removed = await removeShopOperator(shop.code, address);
  }
  const next = await getShopOperators(shop.code);
  await audit(req, 'staff.' + action, 'shop', address, { operators: next.length, removed }, shop.code);
  if (action === 'add') {
    return ok(res, { operators: next }, `已添加店员 ${address.slice(0, 10)}…（**本店**经营面可用，财务/审计面仍仅店主）`);
  }
  return ok(
    res,
    { operators: next },
    removed
      ? `已移除店员 ${address.slice(0, 10)}…（该地址在本店的经营权限立即失效：鉴权每请求重算角色，令牌本身不带店铺）`
      : `${address.slice(0, 10)}… 本来就不在本店店员名单里（幂等：没有任何变更）`
  );
}));

/**
 * 通知 webhook 配置（ownerOnly；url 留空=停用通知；secret 留空=不签名）。
 *
 * `shop_webhook` 是**一行一店**，"只改其中一个、保留另一个"因此是一次读-改-写。
 * 放在同一个事务里读、然后**一条语句**写完整的一对：否则并发的一次"换 url"与一次"换密钥"
 * 会各读到旧值、各写回自己那份，落成一对谁也没配过的组合——表现是"刚配好的通知地址又没了"，
 * 而两边都收到成功回执。判据（url 形状）在事务内判、用 `abortTx` 明确丢弃这次尝试：
 * 即使将来在它之前加了写入，也不会留下半套配置。
 */
router.put('/webhook', ownerOnly, wrap(async (req, res) => {
  const shop = req.shop;
  const { url, secret } = req.body || {};
  if (url === undefined && secret === undefined) return fail(res, '需要提供通知地址或签名密钥');
  const saved = await withTransaction(async () => {
    const cur = await webhookConfig(shop.code);
    const nextUrl = url !== undefined ? String(url).trim().slice(0, 500) : cur.url;
    const nextSecret = secret !== undefined ? String(secret).trim().slice(0, 200) : cur.secret;
    if (nextUrl && !/^https:\/\//i.test(nextUrl)) return abortTx({ error: '通知地址必须以 https:// 开头（只接受加密目标）' });
    await setWebhookConfig(shop.code, { url: nextUrl, secret: nextSecret });
    return { url: nextUrl, secret: nextSecret };
  });
  if (saved.error) return fail(res, saved.error);
  await audit(req, 'webhook.update', 'shop', shop.code, { urlSet: !!saved.url, secretSet: !!saved.secret }, shop.code);
  ok(res, { url: saved.url, hasSecret: !!saved.secret }, saved.url ? '通知已启用（**本店**关键事件将 POST 到该地址；接收方应按 eventId 幂等）' : '通知已停用');
}));

/** 通知投递状态（ownerOnly）：最近若干次投递的结果——店主能看到"我的机器人到底收到没有" */
router.get('/webhook-status', ownerOnly, wrap(async (req, res) => {
  ok(res, await webhookStatus(req.shop.code));
}));

/** 发送一条测试事件（ownerOnly）：同步返回结果，失败原因直接显示在设置页 */
router.post('/webhook-test', ownerOnly, wrap(async (req, res) => {
  const r = await sendTestEvent(req.shop.code);
  await audit(req, 'webhook.test', 'shop', req.shop.code, { ok: r.ok }, req.shop.code);
  if (!r.ok) return ok(res, r, `测试事件投递失败：${r.error}`);
  ok(res, r, '测试事件投递成功（接收方应已收到 type=webhook.test 的 POST）');
}));

/** 履约画像（公开只读聚合统计，口径见 reputation.js 头注释——不下发单笔订单）
 *  **按店铺限定**：不带 X-Mk-Shop 时返回该节点全部在售店铺的合计（目录页用），
 *  带了就只算那一家——否则把某一家的画像混进另一家/"这一家"的页面上，是"看起来是 A 的、其实是 A+B"。
 *   `listedShopScope`：指到暂停接单的店铺时拒绝（409），"全节点合计"只能由没有请求头进入。 */
router.get('/reputation', listedShopScope, reputationLimiter, wrap(async (req, res) => {
  ok(res, await reputationSummary(req.shop ? req.shop.seller : null));
}));

/**
 * 本节点保证金状况（公开只读；口径、事实源与取舍见 src/stakingRisk.js 文件头）。
 *
 * 数据全部来自链上公开状态（Registry 的在册节点集合 + 本节点 Staking 的 poolOf/payoutFloors），
 * 任何第三方扫链都能复算。它回答的是"本节点池子够不够覆盖自己的出金下限"——零费模型下
 * 平台没有注册门槛，低于下限时出金会被链上拒绝，而节点日志里一个字都不会说。
 * 限流与缓存：端点自身走 stakingRisk 的 30s 记忆化（一轮 RPC 覆盖 30 秒内的所有请求）。
 */
const stakingLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: '保证金读数查询过于频繁，请稍后再试' });
router.get('/staking', stakingLimiter, wrap(async (req, res) => {
  ok(res, await stakingShortfall({ force: false }));
}));
/** 强制刷新只对节点管理员开放：公开端点不允许用 query 绕过 30s 记忆化放大 RPC。 */
router.get('/staking/refresh', nodeAdmin, wrap(async (req, res) => {
  ok(res, await stakingShortfall({ force: true }));
}));

/**
 * 待审批的撤资申请（仅节点主）。
 *
 * 只读、且是 Staking owner 做审批前的唯一待办视图：合约没有枚举 pending 的读法，
 * 节点按"自己名下店铺的 seller"逐个读 `unstakeState`（见 src/stakingRequests.js 的口径与代价）。
 * 单个地址读不到时 `partial=true`，界面必须如实提示列表可能不完整。
 */
router.get('/staking/requests', hostOnly, stakingLimiter, wrap(async (req, res) => {
  ok(res, await pendingUnstakeRequests());
}));

/** 店铺买家评价聚合（公开只读：count/avg——与履约画像互补的主观质量信号）
 *  **按店铺限定**：不带 X-Mk-Shop 时是"该节点全部在售店铺"的合计，带了就只算那一家。
 *  暂停接单的店铺由 `listedShopScope` 拒绝——同 `/reputation`。 */
router.get('/reviews/stats', listedShopScope, reviewsStatsLimiter, wrap(async (req, res) => {
  ok(res, await shopReviewStats(req.shop ? req.shop.seller : null));
}));

// ── 运营读数（ownerOnly 私域；口径与唯一实现见 src/buyerSignal.js / src/opsMetrics.js）──

/*
  三个端点的限流：都只读本店数据，但都可能触链（metrics/sla 读释放阈值与挂账余额）或做全表聚合
  （buyer-signal 走履约画像的同一套事件解析）。店主面板按分钟级轮询，60/30 次每分钟留了几十倍余量；
  与既有只读端点一样是**Redis 固定窗口**（跨进程共享，失败 fail-closed）。
*/
const buyerSignalLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '买家履约信号查询过于频繁，请稍后再试' });
const metricsLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: '运营指标查询过于频繁，请稍后再试' });
const slaLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: '履约时效读数查询过于频繁，请稍后再试' });

/**
 * 买家履约信号（ownerOnly 只读）：**该买家在本店**的争议/退款/确认收货/超时释放分布。
 *
 * 为什么是 ownerOnly：它把"某个地址在这家店买过什么、退过什么款、有没有争议"摆在一起，
 * 是**店主视角的经营数据**，不是公开画像（公开画像只出聚合计数，见 /reputation，且不含买家维度）。
 * 为什么必须带 address：本读数就是"针对一个具体买家"的，没有缺省主体可言——
 * 缺参数/非法地址一律明确拒绝，不猜、不回落成"全部买家"。
 * 口径、隐私边界（**不为任意地址去查其它节点**）与文案纪律（可疑信号而非结论）见 buyerSignal.js。
 */
router.get('/buyer-signal', ownerOnly, buyerSignalLimiter, wrap(async (req, res) => {
  const address = String(req.query.address || '').trim().toLowerCase();
  if (!isAddress(address) || isZeroAddress(address)) {
    return fail(res, '地址必须是 0x 开头的以太坊地址（零地址没有履约历史）');
  }
  ok(res, await buyerSignal(address, req.shop.seller));
}));

/**
 * 运营指标（ownerOnly 只读）：待处理退款 / 在途售后案件 / 待仲裁争议（各带最久等待）、
 * 托管中与已超时单数、对账最近一轮与差异数、挂账余额、订单各状态计数。
 * 全部读数取自既有唯一实现（见 src/opsMetrics.js 文件头）；读不到的一律 available:false + reason。
 */
router.get('/metrics', ownerOnly, metricsLimiter, wrap(async (req, res) => {
  // 对账快照由路由取（唯一事实源），再交给 opsMetrics 组装——避免 opsMetrics ↔ routes/orders 循环依赖
  ok(res, await opsMetrics({ reconcile: chainReconcileStatus(), seller: req.shop.seller }));
}));

/**
 * 卖家 SLA 读数（ownerOnly 只读）：未发货超期清单（最久的 N 条）、待店主回复的退款申请、
 * 在途售后案件，以及发货时长中位数/P90（样本不足置 null 并说明）。
 * "超期"以链上 `releaseNotBeforeBlock` 被当前块高跨过为准，不是本地按块时间估算（见 opsMetrics）。
 */
router.get('/sla', ownerOnly, slaLimiter, wrap(async (req, res) => {
  const raw = req.query.limit;
  const limit = raw === undefined || raw === '' ? SLA_LIMIT_DEFAULT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > SLA_LIMIT_MAX) {
    return fail(res, `数量必须是 1 到 ${SLA_LIMIT_MAX} 的整数（缺省 ${SLA_LIMIT_DEFAULT}）`);
  }
  ok(res, await slaReading({ limit, seller: req.shop.seller }));
}));

// ── 经营看板（P1-①，ownerOnly 私域；口径见 src/stats.js）──

/** 汇总卡（缺省 30；days=0 全量；D7 钳制与归一见 stats.normalizeStatsDays） */
router.get('/stats/overview', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 30);
  if (days === null) return fail(res, '天数无效（需 0 或正整数；0=全量；上限 366 天）');
  ok(res, await overviewStats(days, req.shop.seller));
}));

/** 最近 N 天趋势（缺省 14，补零；D6 自然日对齐见 stats.trendStats） */
router.get('/stats/trend', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 14);
  if (days === null) return fail(res, '天数无效（需正整数；上限 366 天）');
  if (days === 0) return fail(res, '趋势天数必须是正整数（不支持全量）');
  ok(res, { days, items: await trendStats(days, req.shop.seller) });
}));

/** 商品排行（sort=gmv|orders|refund；缺省 30 天；days=0 全量） */
router.get('/stats/products', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 30);
  if (days === null) return fail(res, '天数无效（需 0 或正整数；0=全量；上限 366 天）');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  ok(res, await productStats(days, String(req.query.sort || 'gmv'), page, pageSize, req.shop.seller));
}));

export default router;
