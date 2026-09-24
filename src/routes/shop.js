/**
 * 店铺信息与管理路由（经营参数全部网页化：kv 存储，见 docs/DECISIONS.md）。
 *
 * 配置文件只保留"身份与接线"（店主钱包/escrow/registry/端口等）；
 * 店名/公告/店员白名单/通知 webhook 均在卖家面板「店铺设置」维护（即改即生效，无需重启）。
 *
 *  GET  /                店铺展示信息（name/notice/owner/链配置——买家页面与下单核验用）
 *  GET  /registry-info   开店登记信息（owner/name/notice/escrow/registry；endpoint 由开店向导
 *                        网页填写——节点不预置对外地址；链上登记不含展示元数据，见合约注释）
 *  PUT  /                编辑店铺资料 {name?, notice?}（staffOnly；入审计）
 *  GET  /settings        店铺设置读取（ownerOnly：当前资料/店员列表/webhook 状态）
 *  PUT  /staff           店员管理 {action:'add'|'remove', address}（ownerOnly；入审计）
 *  PUT  /webhook         通知配置 {url, secret}（ownerOnly；secret 不回显，仅布尔状态）
 *  GET  /reputation      履约画像聚合统计（信誉索引，纯公开只读）
 *  GET  /reviews/stats   店铺买家评价聚合（公开只读）
 */
import { Router } from 'express';
import config, { DEFAULT_SHOP_NAME } from '../config.js';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { verifyToken, roleOf, getShopOperators } from '../auth.js';
import { kvGet, kvSet } from '../db.js';
import { logAudit } from '../audit.js';
import { isAddress, isZeroAddress } from '../chain.js';
import { reputationSummary } from '../reputation.js';
import { shopReviewStats } from '../reviews.js';
import { webhookStatus, sendTestEvent } from '../webhook.js';
import { shopCode, cachedShopCode } from '../shopCode.js';
import { overviewStats, trendStats, productStats, normalizeStatsDays } from '../stats.js';
import { refreshFeeCollector, feeStatus } from '../fees.js';

const router = Router();
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true });
// 店铺资料编辑（店名/公告）为经营面操作：店主与店员（网页授权白名单）均可（入审计）
const staffOnly = makeAuthMiddleware(verifyToken, { staffOnly: true });

// ── 店铺资料（kv 覆盖默认：网页「店铺设置」编辑，无需改 .env 重启）──
const KV_NAME = 'mk:shop_name';
const KV_NOTICE = 'mk:shop_notice';
const KV_OPERATORS = 'mk:shop_operators';
const KV_WEBHOOK_URL = 'mk:webhook_url';
const KV_WEBHOOK_SECRET = 'mk:webhook_secret';

export function shopName() {
  const v = kvGet(KV_NAME);
  return v !== null && v !== '' ? v : DEFAULT_SHOP_NAME;
}

export function shopNotice() {
  const v = kvGet(KV_NOTICE);
  return v !== null ? v : '';
}

const audit = (req, action, targetType, targetId, detail) =>
  logAudit({ req, actor: req.auth?.address, actorRole: roleOf(req.auth?.address || ''), action, targetType, targetId, detail });

/*
  公开只读聚合端点的限流（此前**完全无限流**，而它们都是 O(全表) 的）：
   · /reputation：reputationSummary 扫全表 orders 并对每行 JSON.parse(onchain_events)——
     单次就是一次全表解析，匿名脚本按秒轮询即可把 CPU 打满；
   · /reviews/stats：reviews 表聚合（较轻，但同样是公开面）。
  数值依据：联邦前端的目录页会对**每个可达节点**各打一次 reputation（useNodeDirectory 扇出，
  各家店同一 IP 从同一浏览器发出），商家主页另加一次——60 次/分足够"一屏几十家店 × 几次
  页面切换"，而脚本化 1 次/秒以下的全表扫描才可能碰到上限（2 次/秒即挡）。
  注意：与 simpleRateLimit 的其它用法一样是**单进程内存窗口**，多实例部署需网关层兜底。
*/
const reputationLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '店铺履约画像查询过于频繁，请稍后再试' });
const reviewsStatsLimiter = simpleRateLimit({ windowMs: 60_000, max: 120, message: '店铺评价统计查询过于频繁，请稍后再试' });

/** 店铺展示信息（买家店铺页/下单核验用） */
router.get('/', (req, res) => {
  /*
    店铺编号（链上铸造的 9 位标识 = 8 数据 + 1 加权校验）：前端用它把这家店写进 URL（`/shop/00000003`）。
    节点**自报**编号的意义——前端任何一次与某店交互都能顺带学会 `origin → code`，
    不必为全站 27 个链接点各发一次"问编号"的请求。
    这里读的是 30s 缓存（同步、不发请求），首次调用先暖一次缓存；读不到就是 null（不编造）。
  */
  void shopCode();
  ok(res, {
    owner: config.shop.owner || null,
    code: cachedShopCode() || null,
    name: shopName(),
    notice: shopNotice(),
    chainId: config.chain.chainId,
    escrowAddress: config.chain.escrowAddress || null,
    registryAddress: config.chain.registryAddress || null,
    timeoutBlocks: config.escrow.timeoutBlocks,
    version: '0.1.0',
  });
});

/**
 * 开店登记信息（公开只读）：前端「添加节点成为卖家」据此自动填充与**一致性校验**——
 * 节点 escrow/registry 必须与登记前端同网络（VITE_*），否则拒绝登记。
 * 注意：endpoint 不在节点预置——由开店向导网页填写（本节点可被任一前端访问时域名即 endpoint）。
 */
router.get('/registry-info', (req, res) => {
  const name = shopName();
  const notice = shopNotice();
  ok(res, {
    owner: config.shop.owner || null,
    name,
    notice,
    chainId: config.chain.chainId,
    escrowAddress: config.chain.escrowAddress || null,
    registryAddress: config.chain.registryAddress || null,
    canRegister: !!(config.shop.owner && config.chain.escrowAddress && config.chain.registryAddress),
    version: '0.1.0',
  });
});

/** 店主/店员编辑店铺资料（name/notice；入审计；无需改 .env 重启） */
router.put('/', staffOnly, wrap(async (req, res) => {
  const { name, notice } = req.body || {};
  const curName = shopName();
  const curNotice = shopNotice();
  const nextName = name !== undefined ? String(name).trim().slice(0, 60) : curName;
  const nextNotice = notice !== undefined ? String(notice).trim().slice(0, 500) : curNotice;
  if (name !== undefined && !nextName) return fail(res, '店铺名不能为空（≤60 字）');
  if (name !== undefined) kvSet(KV_NAME, nextName);
  if (notice !== undefined) kvSet(KV_NOTICE, nextNotice);
  audit(req, 'shop.update', 'shop', '-', { nameChanged: nextName !== curName, noticeChanged: nextNotice !== curNotice });
  ok(res, { name: nextName, notice: nextNotice }, '店铺资料已更新（买家店铺页即时生效；链上登记不含展示资料，无需同步）');
}));

/** 店铺设置读取（ownerOnly）：当前资料/店员列表/webhook 状态（secret 不回显） */
router.get('/settings', ownerOnly, (req, res) => {
  ok(res, {
    name: shopName(),
    notice: shopNotice(),
    operators: getShopOperators(),
    webhook: {
      url: kvGet(KV_WEBHOOK_URL) || '',
      hasSecret: !!(kvGet(KV_WEBHOOK_SECRET) || ''),
    },
  });
});

/** 店员管理（ownerOnly；白名单存 kv，鉴权实时读取；入审计） */
router.put('/staff', ownerOnly, wrap(async (req, res) => {
  const action = String(req.body?.action || '');
  const address = String(req.body?.address || '').trim().toLowerCase();
  if (!['add', 'remove'].includes(action)) return fail(res, 'action 需为 add / remove');
  if (!isAddress(address) || isZeroAddress(address)) return fail(res, 'address 需为 0x 开头的以太坊地址（零地址不可加入）');
  const owner = (config.shop.owner || '').toLowerCase();
  if (address === owner) return fail(res, '店主无需加入店员名单（店主权限恒高于店员）');
  const list = getShopOperators();
  const next = action === 'add' ? [...new Set([...list, address])] : list.filter((a) => a !== address);
  kvSet(KV_OPERATORS, JSON.stringify(next));
  audit(req, 'staff.' + action, 'shop', address, { operators: next.length });
  ok(res, { operators: next }, action === 'add' ? `已添加店员 ${address.slice(0, 10)}…（经营面可用，财务/审计面仍仅店主）` : `已移除店员 ${address.slice(0, 10)}…`);
}));

/** 通知 webhook 配置（ownerOnly；url 留空=停用通知；secret 留空=不签名） */
router.put('/webhook', ownerOnly, wrap(async (req, res) => {
  const { url, secret } = req.body || {};
  if (url === undefined && secret === undefined) return fail(res, '需提供 url 或 secret');
  const nextUrl = url !== undefined ? String(url).trim().slice(0, 500) : kvGet(KV_WEBHOOK_URL) || '';
  const nextSecret = secret !== undefined ? String(secret).trim().slice(0, 200) : kvGet(KV_WEBHOOK_SECRET) || '';
  if (nextUrl && !/^https?:\/\//i.test(nextUrl)) return fail(res, 'webhook url 需为 http(s):// 开头');
  kvSet(KV_WEBHOOK_URL, nextUrl);
  kvSet(KV_WEBHOOK_SECRET, nextSecret);
  audit(req, 'webhook.update', 'shop', '-', { urlSet: !!nextUrl, secretSet: !!nextSecret });
  ok(res, { url: nextUrl, hasSecret: !!nextSecret }, nextUrl ? '通知已启用（关键事件将 POST 到该地址；接收方应按 eventId 幂等）' : '通知已停用');
}));

/** 通知投递状态（ownerOnly）：最近若干次投递的结果——店主能看到"我的机器人到底收到没有" */
router.get('/webhook-status', ownerOnly, (req, res) => {
  ok(res, webhookStatus());
});

/** 发送一条测试事件（ownerOnly）：同步返回结果，失败原因直接显示在设置页 */
router.post('/webhook-test', ownerOnly, wrap(async (req, res) => {
  const r = await sendTestEvent();
  audit(req, 'webhook.test', 'shop', '-', { ok: r.ok });
  if (!r.ok) return ok(res, r, `测试事件投递失败：${r.error}`);
  ok(res, r, '测试事件投递成功（接收方应已收到 type=webhook.test 的 POST）');
}));

/** 履约画像（公开只读聚合统计，口径见 reputation.js 头注释——不下发单笔订单） */
router.get('/reputation', reputationLimiter, (req, res) => {
  ok(res, reputationSummary());
});

/** 店铺买家评价聚合（公开只读：count/avg——与履约画像互补的主观质量信号） */
router.get('/reviews/stats', reviewsStatsLimiter, (req, res) => {
  ok(res, shopReviewStats());
});

// ── 经营看板（P1-①，ownerOnly 私域；口径见 src/stats.js）──

/** 汇总卡（缺省 30；days=0 全量；D7 钳制与归一见 stats.normalizeStatsDays） */
router.get('/stats/overview', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 30);
  if (days === null) return fail(res, 'days 无效（需非负整数；0=全量；上限 366 天）');
  await refreshFeeCollector(); // 净额按每单的创建时收费方快照判定；全局口径只作兜底与披露（见 src/fees.js）
  ok(res, { ...overviewStats(days), ...feeStatus() });
}));

/** 最近 N 天趋势（缺省 14，补零；D6 自然日对齐见 stats.trendStats） */
router.get('/stats/trend', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 14);
  if (days === null) return fail(res, 'days 无效（需正整数；上限 366 天）');
  if (days === 0) return fail(res, 'trend 需正整数天数（不支持全量）');
  await refreshFeeCollector();
  ok(res, { days, items: trendStats(days) });
}));

/** 商品排行（sort=gmv|orders|refund；缺省 30 天；days=0 全量） */
router.get('/stats/products', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 30);
  if (days === null) return fail(res, 'days 无效（需非负整数；0=全量；上限 366 天）');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  await refreshFeeCollector();
  ok(res, productStats(days, String(req.query.sort || 'gmv'), page, pageSize));
}));

export default router;
