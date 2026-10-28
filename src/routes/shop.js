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
 *  GET  /reviews/stats   店铺买家评价聚合（公开只读）
 *  GET  /buyer-signal    买家履约信号（ownerOnly；**本店视角**，口径见 src/buyerSignal.js）
 *  POST /claims          提交一条身份声明 {kind,value,issued,signature}（ownerOnly；签名核验见 src/claims.js）
 *  GET  /claims          公开列出**有效**声明（原样带 message/signature，供第三方核验；不标"认证"）
 *  POST /claims/:id/revoke  撤销一条声明（ownerOnly；已撤销的不再出现在公开列表；入审计）
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
  verifyToken,
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
import { isAddress, isZeroAddress } from '../chain.js';
import { assertPublicHttpTarget } from '../netguard.js';
import { sweepOrphanUploads } from '../mediaSweep.js';
import { getRates, usdtMicroToPayWei, isPayableAmount } from '../rates.js';
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
} from '../shops.js';
// 节点级运营读数（nodeAdmin）：只出"这台机器有没有在干活"，不出任何店铺经营明细
import { escrowWatcherStatus } from '../escrowWatcher.js';
import { chainReconcileStatus } from '../chainReconcile.js';
// 店铺身份声明的唯一判据层：规范消息构造（**逐字**使用请求字段）/ 声明值校验（**拒绝**而非变换）/
// 签名核验（见 src/claims.js 文件头——那里写清了铁律"签名的字节就是提交的字节"，
// 以及"它证明什么、不证明什么"：对外口径必须是"店主签过这句话"，不是"官方认证"）
import { checkClaimValue, buildClaimMessage, verifyClaim } from '../claims.js';
import { reputationSummary } from '../reputation.js';
import { shopReviewStats } from '../reviews.js';
// 谈信地址的唯一形状入口：两种写法（0x / 1 开头）与“清空”的语义都只在这里
import { parseTanxinAddress, tanxinAddressOf } from '../tanxin.js';
import { webhookStatus, sendTestEvent, webhookConfig, setWebhookConfig } from '../webhook.js';
import { overviewStats, trendStats, productStats, normalizeStatsDays } from '../stats.js';
// 本节点保证金状况的读数（治理只读；事实源与取舍见 src/stakingRisk.js）
import { stakingShortfall } from '../stakingRisk.js';
// 买家履约信号（本店视角；口径、隐私边界与文案纪律见 src/buyerSignal.js 文件头）
import { buyerSignal } from '../buyerSignal.js';
// 运营读数与 SLA（待办谓词、托管超时、挂账、对账、发货时长的**唯一实现**）
import { opsMetrics, slaReading, SLA_LIMIT_DEFAULT, SLA_LIMIT_MAX } from '../opsMetrics.js';

const router = Router();
// 店铺级财务面：**只认该店店主（seller）**。host 不在此列——租户店铺的账不是节点主的账
// （他能看到的只有节点级读数，见 GET /node；他自己那家店的账也只有他作为 seller 才看得到）。
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true });
const staffOnly = makeAuthMiddleware(verifyToken, { staffOnly: true });
// 节点级：节点主 ∪ 节点员工（nodeAdmin；员工与节点主同权限的日常运营动作）。
// 注意 PII 保留期与节点审计**不在这里**：那两件是 hostOnly（仅节点主，见 routes/pii.js / audit.js）。
const nodeAdmin = makeAuthMiddleware(verifyToken, { nodeAdmin: true });
// 增删节点员工是权限授予本身：只允许节点主，避免员工自行扩权/互授。
const hostOnly = makeAuthMiddleware(verifyToken, { hostOnly: true });

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

/** 节点公告（`node.notice` 的展示形；'' = 没设置过） */
export async function nodeNoticeOf() {
  return shopDisplayNotice(await nodeRow());
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
    'UPDATE node SET name = ?, notice = ?, tanxin_address = ?, updated_at = ? WHERE id = 1',
    String(name ?? ''),
    String(notice ?? ''),
    tanxinAddress == null ? null : String(tanxinAddress),
    new Date()
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
    'UPDATE shops SET name = ?, notice = ?, tanxin_address = ?, updated_at = ? WHERE code = ?',
    String(name ?? ''),
    String(notice ?? ''),
    tanxinAddress == null ? null : String(tanxinAddress),
    new Date(),
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
  注意：与 simpleRateLimit 的其它用法一样是**单进程内存窗口**，多实例部署需网关层兜底。
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
router.get('/payment-methods', wrap(async (req, res) => {
  const raw = String(req.query.usdtMicro ?? '').trim();
  let total = null;
  if (raw) {
    if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) return fail(res, 'usdtMicro 需为正整数（微 USDT）');
    total = raw;
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
      filtered = tokens.map((t) => ({ ...t, supported: null, unavailable: `无法核验链上白名单：${e?.message || e}` }));
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
    return fail(res, '本节点未接入托管合约（MK_ESCROW_ADDRESS 为空）：先接 Escrow，否则配了也收不了 ERC20');
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
  await upsertPaymentToken(token);
  await audit(req, 'payment_token.save', 'node', token.address, {
    symbol: token.symbol,
    decimals: token.decimals,
    mode: token.mode,
    fixedUsdtMicroPerToken: token.fixed,
    priceUrl: token.priceUrl || null,
  }, null);
  ok(res, { token }, '已保存；还需节点主钱包在链上启用 supportedToken，买家才能用它付款');
}));

/** 删除一条配置（只停止未来报价；已托管订单仍按快照里的支付资产结算）。 */
router.delete('/payment-tokens/:address', hostOnly, wrap(async (req, res) => {
  const address = String(req.params.address || '').trim().toLowerCase();
  if (!isAddress(address)) return fail(res, '支付资产地址非法');
  const deleted = await deletePaymentToken(address);
  if (!deleted) return fail(res, '该支付资产配置不存在', 404, 404);
  await audit(req, 'payment_token.delete', 'node', address, {}, null);
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
  if (!['add', 'remove'].includes(action)) return fail(res, 'action 需为 add / remove');
  if (!isAddress(address) || isZeroAddress(address)) return fail(res, 'address 需为 0x 开头的以太坊地址（零地址不可加入）');
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
  // 节点级动作：**不属于任何一家店**（节点主可以一家店都没有；带上 X-Mk-Shop 也只是范围提示），
  // 所以显式传 null，而不是从 req.shop 猜一个归属
  await audit(req, 'node.update', 'node', 'node', {
    nameChanged: nextName !== curName,
    noticeChanged: nextNotice !== curNotice,
    tanxinChanged: nextTanxin !== curTanxin,
  }, null);
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
  await audit(
    req,
    'shop.update',
    'shop',
    shop.code,
    { nameChanged: nextName !== curName, noticeChanged: nextNotice !== curNotice, tanxinChanged: nextTanxin !== curTanxin },
    shop.code
  );
  ok(
    res,
    { code: shop.code, name: shopDisplayName({ name: nextName }), notice: nextNotice, tanxinAddress: nextTanxin },
    '店铺资料已更新（买家店铺页即时生效；链上登记不含展示资料，无需同步）'
  );
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
  if (typeof listed !== 'boolean') return fail(res, 'listed 需为布尔值（true=复业，false=歇业）', 400, 400);
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
    if (paused.changes !== 1) return fail(res, '店铺状态已变化，请刷新后重试', 409, 409);
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
  if (resumed.changes !== 1) return fail(res, '店铺状态已变化，请刷新后重试', 409, 409);
  await audit(req, 'shop.self_resume', 'shop', shop.code, {}, shop.code);
  ok(res, { listed: true, listedReason: '' }, '已复业：商品重新进入店铺聚合面');
}));


/** 节点主清理孤儿媒体：只删全库无引用且超过 TTL 的文件；商品/订单快照/评价引用都保护。 */
router.post('/media/sweep-orphans', hostOnly, wrap(async (req, res) => {
  const days = req.body?.olderThanDays === undefined ? 7 : Number(req.body.olderThanDays);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return fail(res, 'olderThanDays 需为 1..365 的整数', 400, 400);
  }
  const r = await sweepOrphanUploads({ olderThanMs: Math.floor(days) * 86_400_000 });
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
  if (!['add', 'remove'].includes(action)) return fail(res, 'action 需为 add / remove');
  if (!isAddress(address) || isZeroAddress(address)) return fail(res, 'address 需为 0x 开头的以太坊地址（零地址不可加入）');
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
  if (url === undefined && secret === undefined) return fail(res, '需提供 url 或 secret');
  const saved = await withTransaction(async () => {
    const cur = await webhookConfig(shop.code);
    const nextUrl = url !== undefined ? String(url).trim().slice(0, 500) : cur.url;
    const nextSecret = secret !== undefined ? String(secret).trim().slice(0, 200) : cur.secret;
    if (nextUrl && !/^https:\/\//i.test(nextUrl)) return abortTx({ error: 'webhook url 需为 https:// 开头（投递端只接受加密目标）' });
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

// ── 店铺身份声明（shop claim：店主钱包签名、可核验的外部身份声明）──
/*
  为什么要它：`code`（店铺编号）解决"唯一"，不解决"哪个才是官方那家"——编号本身不带外部身份。
  本组端点让店主用钱包**对一段规范消息签名**，把 domain / github / x / telegram 绑定到店铺地址上；
  EOA 可离线 `ethers.verifyMessage`；合约账户（Safe/多签）走标准 1271 或 Safe legacy 链上核验。
  节点提交时已验过，第三方不依赖节点也能按账户类型自行核验。⚠️ 它证明"某个地址签过这句话"，
  **不证明**那个域名/账号真的属于他——
  归属核验（DNS TXT / gist / OAuth）不在本机制内，故对外**不得**标成"已认证/官方"。
*/

/** 声明行的对外形状（公开列表与写回执共用一份，避免两处各拼一遍字段） */
function claimDto(row) {
  return {
    // id 是自增 BIGINT（MySQL AUTO_INCREMENT），但对外**下发字符串**：前端类型 `ShopClaim.id` 是 string
    // （撤销走 URL 路径段，字符串与数字都能拼，但类型不一致会让 TS 端在其它用法上出错）。
    id: String(row.id),
    kind: row.kind,
    value: row.value,
    address: row.address,
    // message 与 signature **原样**下发：第三方核验用的就是这两个字节，
    // 任何"顺手规整一下"（去尾换行、重排字段）都会让重算出的地址/1271 摘要与 address 不一致。
    message: row.message,
    signature: row.signature,
    // `created_at` 是 DATETIME(3) → `Date`，对外 JSON 是 ISO-8601（前端按 ISO 解析）
    createdAt: row.created_at,
  };
}

/**
 * 解析"本店是谁"：店主地址 + 店铺编号 —— **用请求的店铺上下文，不另起第二个真相源**。
 *
 * 多店之前它是"读全局常量 + 读链上 codeOf(常量)"；现在它直接回答"这次请求指的是哪家店"：
 * `seller` 来自该行（链上 `ShopInfo.seller` 的镜像）、`code` 是该行的店铺编号。
 * 编号的意义不变：声明消息里要写 `code:` 行，**签名因此覆盖了"这条声明属于哪家店"**——
 * 换一家店的 code 就是另一段消息，签名对不上。
 *
 * 三态纪律：**没有编号就如实报"暂无法核验"并拒绝落库**，绝不"先存着"——
 * 未经核验的声明一旦进了公开列表，第三方会把它当成"店主签过"（它并没有）。
 * @returns {{operator: string|null, code: string|null, reason: string|null}}
 */
function resolveShopIdentity(req) {
  const shop = req.shop;
  /*
    `ownerOnly` 中间件保证这里必有店铺上下文（请求头指的那家，或这个地址唯一经营的那家），
    所以这一支正常不可达；真走到这里说明鉴权链被绕过——如实拒绝，**绝不"先存着"**。
  */
  if (!shop) {
    return { operator: null, code: null, reason: '本次请求没有解析出店铺上下文' };
  }
  const operator = String(shop.seller || '').trim().toLowerCase();
  if (!isAddress(operator) || isZeroAddress(operator)) {
    return { operator: null, code: null, reason: '该店铺行没有合法的店主地址' };
  }
  // 编号恒非空（一行店铺只在链上登记之后才存在，见 src/shops.js），所以这里没有"还没有编号"那一档
  return { operator, code: shop.code, reason: null };
}

/**
 * 公开列表的限流：与其他公开只读端点同款（联邦前端的店主主页会扇出到每个可达节点，
 * 60 次/分足够"一屏几十家店 × 几次页面切换"）。同样是**单进程内存窗口**，
 * 多实例部署需网关层兜底。
 */
const claimsLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '店铺身份声明查询过于频繁，请稍后再试' });

/**
 * 提交一条身份声明（ownerOnly）：`{kind, value, issued, signature}`。
 *
 * ⚠️ **签名的字节就是提交的字节**（铁律，见 src/claims.js 文件头）：`kind` / `value` / `issued`
 * **逐字**进消息——不 trim、不折大小写、不补当天。归一**只发生在拒绝这一侧**：
 * 值不是规范形就直接拒绝并告诉店主该写成什么、该对哪条消息重签；
 * 绝不允许"先替店主归一、再用归一后的值去验签"（那样客户端签原文永远验不过，
 * 而错误看起来只是"签名不对"，排查成本极高）。
 *
 * `issued` **必须由请求体给出**（`YYYY-MM-DD`）：它是被签名覆盖的文本的一部分，
 * 节点**不替客户端补当天**——日期是跨时区最容易漂移的一环（同一时刻两端可能不是同一天），
 * 节点自己生成会让"店主签的那天"与"节点算的那天"不同，表现是验签失败且极难定位。
 * 缺失/形状非法 ⇒ 报可读中文错（要求客户端显式给出）。
 *
 * 声明值长度上限：**逐字 ≤ 320 字符**（各类 kind 另有更紧的形状规则，见 src/claims.js），
 * 超限直接拒绝而不是截断——截断后的域名/仓库名会变成一个
 * "看起来合法但完全不是他声明的东西"。
 *
 * 幂等：同 (kind, value, shop_code) 在库里只有一行（唯一索引）；完全相同的重发**不改行、不新增**，
 * 已撤销后重新声明则恢复生效（按新签名覆盖 message/signature 并刷新 created_at）。
 * 每一种情况都写审计，detail 里带 duplicate/revived 以便区分"真的新声明"与"重复提交"。
 */
router.post('/claims', ownerOnly, wrap(async (req, res) => {
  const { kind, value, issued, signature } = req.body || {};
  const me = resolveShopIdentity(req);
  if (me.reason) {
    return fail(res, `暂无法核验店主身份：${me.reason}——请稍后重试（未通过核验的声明一律不落库）`);
  }
  // ① 校验（**拒绝**而不是变换）：请求里的值必须**逐字**就是规范形，否则不进入验签
  const check = checkClaimValue(kind, value);
  if (!check.ok) {
    /*
      归一**只出现在这条错误信息里**：告诉店主该改成什么，并给出"改成规范形后应当签的那条消息"。
      这一段**不参与**验签，也绝不会被写进库——它只是让店主一次就能改对。
      （`canonical` 为 null 时连规范形都得不出来，例如非字符串/超长/空值，就只能给原因。）
    */
    const suggested =
      check.canonical === null
        ? null
        : (() => {
            try {
              return buildClaimMessage({ code: me.code, operator: me.operator, kind, value: check.canonical, issued });
            } catch {
              return null; // issued 也就缺/非法：先让店主把它补齐，下一步再报
            }
          })();
    return fail(
      res,
      suggested
        ? `${check.reason}。\n请改成规范形后，用店主钱包对下面这条消息原文重新签名：\n${suggested}`
        : check.reason
    );
  }
  // ② 用请求体**原样**字段构造消息（不归一、不生成日期）：kind/value/issued 逐字进消息
  let message;
  try {
    message = buildClaimMessage({ code: me.code, operator: me.operator, kind, value, issued });
  } catch (e) {
    return fail(res, e.message);
  }
  // ③ 验签：验的就是上面那条逐字拼出来的消息
  const v = await verifyClaim({ message, signature, expectedOperator: me.operator });
  if (!v.ok) {
    /*
      验签失败时把**这条消息**回给店主：前端一旦按别的字节（例如自己先做了归一）去签，
      两边算出的消息就不是同一串。给出确切字节，店主重签一次即可，不必去猜"哪里不一样"。
      消息本身是公开信息（它最终要原样下发），不构成泄露。
    */
    return fail(
      res,
      `签名核验不通过：${v.reason}。\n签名覆盖的就是提交的字节（节点不做任何归一）。请用店主钱包对下面这条消息原文签名后重试：\n${message}`
    );
  }
  const db = getDb();
  /*
    落库口径：`value` 存**签名覆盖的那个原文**（校验通过时它就是规范形，二者相等——不存在
    "归一值"与"原文"两份真相）；`kind` 同理（校验已保证它是逐字的规范 kind）。
    `created_at` 由服务器盖章（列默认 CURRENT_TIMESTAMP(3)）；恢复生效那一支要显式刷新它，
    因为"这一行代表的是现在这次声明"。
  */
  const signedValue = value;
  const signedKind = kind;
  const shopCode = String(req.shop.code || '');
  const existing = await db.get('SELECT * FROM shop_claims WHERE kind = ? AND value = ? AND shop_code = ?', signedKind, signedValue, shopCode);
  let id;
  let duplicate = false;
  let revived = false;
  if (!existing) {
    id = Number(
      (await db.run('INSERT INTO shop_claims (shop_code, kind, value, address, message, signature) VALUES (?, ?, ?, ?, ?, ?)', shopCode, signedKind, signedValue, me.operator, message, String(signature))).insertId
    );
  } else if (existing.revoked_at === null && existing.message === message && existing.signature === String(signature)) {
    // 完全相同的重发：**幂等**——不改行、不新增、不动 created_at（否则每次重发都像"重新声明了一次"）
    id = existing.id;
    duplicate = true;
  } else {
    // 已撤销后重新声明（恢复生效）或换了一份新签名（issued 不同）：同一行按最新签名覆盖。
    // created_at 也随之刷新：它表示"现在这一行的声明时刻"，而不是历史上第一次声明的时刻
    // （那一次的时间与撤销都留在审计里，见 action=shop.claim / shop.claim.revoke）。
    revived = existing.revoked_at !== null;
    id = existing.id;
    await db.run('UPDATE shop_claims SET message = ?, signature = ?, created_at = ?, revoked_at = NULL WHERE id = ?', message,
      String(signature),
      new Date(),
      id);
  }
  await audit(req, 'shop.claim', 'shop_claim', String(id), { kind: signedKind, value: signedValue, duplicate, revived }, shopCode);
  const row = await db.get('SELECT * FROM shop_claims WHERE id = ?', id);
  ok(
    res,
    claimDto(row),
    duplicate
      ? '该声明此前已提交过（幂等：未产生新记录）'
      : revived
        ? '该声明此前已撤销，现按新签名恢复生效'
        : '声明已记录：EOA 可用 verifyMessage(message, signature) 离线核验；合约账户用标准 1271 或 Safe legacy 链上核验'
  );
}));

/**
 * 公开列出**有效**声明（已撤销的不出现）。
 *
 * 只呈现**原始事实**：message / signature / address / kind / value / createdAt——
 * 刻意**不加**任何"已认证 / 官方 / verified"字段：节点能证明的只有"这个地址签过这句话"，
 * 证明不了"这个域名真是他的"（见文件头）。把它标成认证，就是在替第三方做一个做不了的判断。
 * 核验方式（响应 message 里也写了一遍，界面/脚本照做即可）：EOA 重算
 * `ethers.verifyMessage(message, signature)` 与 address 比对；合约账户对 address 调
 * 标准 1271 digest 或 Safe legacy `isValidSignature(bytes,bytes)`。
 *
 * 形状 `{ claims: [...] }` 而不是裸数组：与其它列表端点一样留出扩展位（将来要加 total/截断标记
 * 时不至于为了一个字段改整个响应形状）。
 */
router.get('/claims', listedShopScope, claimsLimiter, wrap(async (req, res) => {
  /*
    按店铺限定：不带 X-Mk-Shop 时汇总**全部在售店铺**的声明（公开目录页要的就是这个），
    带了就只出那一家。声明本身是公开事实，所以"汇总"不构成越权；而"哪条属于哪家店"
    必须随行下发（`shopCode` 字段）——否则第三方无法把声明与它要核验的那家店对上。
    ⚠️ 这里的"全部"只能由**没有请求头**进入：指到一家暂停接单的店铺时请求被
    `listedShopScope` 以 409 拒绝（否则挂起店页面会显示全节点合计，还带着 code:0）。
  */
  const scoped = req.shop ? String(req.shop.code || '') : null;
  const rows = (
    scoped === null
      ? await getDb().all('SELECT * FROM shop_claims WHERE revoked_at IS NULL ORDER BY id ASC')
      : await getDb().all('SELECT * FROM shop_claims WHERE revoked_at IS NULL AND shop_code = ? ORDER BY id ASC', scoped)
  );
  ok(
    res,
    { claims: rows.map((r) => ({ ...claimDto(r), shopCode: r.shop_code || '' })) },
    '声明由店主钱包签名：EOA 可离线 verifyMessage；合约账户用标准 1271 或 Safe legacy 链上核验（无需信任本节点）；节点不判定域名/账号归属'
  );
}));

/**
 * 撤销一条声明（ownerOnly）：置 `revoked_at`（`Date`），此后不再出现在公开列表。写审计。
 * 幂等：已撤销的再撤一次只回执"此前已撤销"，不改行、不写第二条审计（没有发生变化）。
 * `id` 非法/不存在都如实报（404），不静默成功——店主以为撤了、实际没撤是最坏的形态。
 * **只能撤本店的声明**：否则 A 店店主可以拿一个自增 id 把 B 店的声明撤掉（那些 id 是连号的）。
 */
router.post('/claims/:id/revoke', ownerOnly, wrap(async (req, res) => {
  const id = Number(String(req.params.id ?? '').trim());
  if (!Number.isInteger(id) || id <= 0) return fail(res, 'id 需为声明的正整数编号');
  const db = getDb();
  const row = await db.get('SELECT * FROM shop_claims WHERE id = ?', id);
  if (!row) return fail(res, '声明不存在', 404, 404);
  if (String(row.shop_code || '') !== String(req.shop.code || '')) {
    return fail(res, '该声明不属于本店', 403, 403);
  }
  if (row.revoked_at !== null) {
    return ok(res, claimDto(row), '该声明此前已撤销（幂等：未产生新记录，也不重复写审计）');
  }
  await db.run('UPDATE shop_claims SET revoked_at = ? WHERE id = ?', new Date(), id);
  await audit(req, 'shop.claim.revoke', 'shop_claim', String(id), { kind: row.kind, value: row.value }, row.shop_code);
  ok(res, claimDto(await db.get('SELECT * FROM shop_claims WHERE id = ?', id)), '声明已撤销（不再出现在公开列表）');
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
  与既有只读端点一样是**单进程内存窗口**，多实例部署需网关层兜底。
*/
const buyerSignalLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '买家履约信号查询过于频繁，请稍后再试' });
const metricsLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: '运营指标查询过于频繁，请稍后再试' });
const slaLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: 'SLA 读数查询过于频繁，请稍后再试' });

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
    return fail(res, 'address 需为 0x 开头的以太坊地址（零地址没有履约历史可谈）');
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
    return fail(res, `limit 需为 1..${SLA_LIMIT_MAX} 的整数（缺省 ${SLA_LIMIT_DEFAULT}）`);
  }
  ok(res, await slaReading({ limit, seller: req.shop.seller }));
}));

// ── 经营看板（P1-①，ownerOnly 私域；口径见 src/stats.js）──

/** 汇总卡（缺省 30；days=0 全量；D7 钳制与归一见 stats.normalizeStatsDays） */
router.get('/stats/overview', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 30);
  if (days === null) return fail(res, 'days 无效（需非负整数；0=全量；上限 366 天）');
  ok(res, await overviewStats(days, req.shop.seller));
}));

/** 最近 N 天趋势（缺省 14，补零；D6 自然日对齐见 stats.trendStats） */
router.get('/stats/trend', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 14);
  if (days === null) return fail(res, 'days 无效（需正整数；上限 366 天）');
  if (days === 0) return fail(res, 'trend 需正整数天数（不支持全量）');
  ok(res, { days, items: await trendStats(days, req.shop.seller) });
}));

/** 商品排行（sort=gmv|orders|refund；缺省 30 天；days=0 全量） */
router.get('/stats/products', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 30);
  if (days === null) return fail(res, 'days 无效（需非负整数；0=全量；上限 366 天）');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  ok(res, await productStats(days, String(req.query.sort || 'gmv'), page, pageSize, req.shop.seller));
}));

export default router;
