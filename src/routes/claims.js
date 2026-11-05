/**
 * NFT 提货声明（挂 `/api/claims`；**节点链下**数据面，链上只有提货争议那一步）。
 *
 *  GET  /nft?contract=&tokenId=  公开状态：这枚 token 的提货行（**不含收货信息**）
 *  GET  /nft/mine               我作为提货人提交过的行（需登录）
 *  POST /nft                    提交提货声明 {nftContract, tokenId, shipping:{name,phone,address}}
 *  GET  /nft/seller             我作为卖家（本节点）的提货行（需登录）
 *  POST /nft/:id/seller         卖家动作 {action:'approve'|'ship'|'fulfill'|'reject', trackingNo?, note?}
 *  POST /nft/:id/cancel         提货人撤回自己的声明（未发货前）
 *  POST /nft/:id/dispute        节点管理员生成链上 `openClaimDispute` 参数（不签交易、不广播）
 *
 * 路由形状与前端 `frontend/src/api/node.ts` 的 `NftClaim` 调用逐字对齐（路径/字段名/动作集合）。
 *
 * ## 为什么提货人是"当前持有人"而不是原订单买家
 *
 * NFT 可以转手。谁有权提货只能由**链上当前持有人**回答（`ownerOf` / `balanceOf`），
 * 所以提交入口是"持有人"，而"这枚 token 确实在本节点被交付过"是前置事实
 * （见 src/nftClaim.js 的判据链）。声明一旦提交就绑定提交人（A-policy）：
 * 卖家发货前会再查一次持有人，转手了就拒绝发货并提示取消，新持有人可以重新提。
 *
 * ## 节点不持私钥
 *
 * 链上的提货争议是 `onlyOwner`（本节点 Escrow 的 owner = 节点 operator）。节点只生成参数、
 * 记下 claimId，由节点主钱包发交易；watcher 按 claimId 把争议结论写回本地行。
 */
import { Router } from 'express';
import config from '../config.js';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { verifySession, roleOf, isHost } from '../auth.js';
import { getDb } from '../db.js';
import { logAudit } from '../audit.js';
import { sendCsv } from '../csv.js';
// 用户词表：表头与枚举值都从唯一来源取（与前端同一份数据）
import { enumText, fmtTime } from '../userText.js';
import {
  submitClaim,
  claimDto,
  sellerClaimAction,
  holderCancelClaim,
  buildClaimDisputeCall,
} from '../nftClaim.js';

const router = Router();
const requireAuth = makeAuthMiddleware(verifySession);
const nodeAdmin = makeAuthMiddleware(verifySession, { nodeAdmin: true });
// 公开状态查询是匿名可读的（买家/二级市场买家要能查），限流防脚本枚举 tokenId
const byTokenLimiter = simpleRateLimit({ windowMs: 60_000, max: 120, message: '提货状态查询过于频繁，请稍后再试' });
const exportLimiter = simpleRateLimit({ windowMs: 60_000, max: 10, message: '导出过于频繁（每分钟至多 10 次）：请稍后再试' });

const CLAIM_STATUSES = ['requested', 'approved', 'shipped', 'fulfilled', 'rejected', 'cancelled', 'expired'];

/** 卖家/店员作用域：与 POST /nft/:id/seller 同一判据（seller 本人或本店店员） */
async function sellerScopeOf(address) {
  const staffShops = (
    await getDb().all('SELECT shop_code FROM shop_operators WHERE address = ?', address)
  ).map((r) => String(r.shop_code));
  const scope = staffShops.length
    ? `(n.seller = ? OR n.shop_code IN (${staffShops.map(() => '?').join(',')}))`
    : 'n.seller = ?';
  return { scope, params: [address, ...staffShops] };
}

/**
 * 卖家提货筛选（列表与 CSV 共用；两处口径必须逐字一致）。
 * q 搜提货单/订单/tokenId/提货人/运单/合约；status=todo 表示三个待办态。
 */
function claimFilterOf(req) {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const status = String(req.query.status || 'all').trim();
  const fromRaw = String(req.query.from || '').trim();
  const toRaw = String(req.query.to || '').trim();
  if (status !== 'all' && status !== 'todo' && !CLAIM_STATUSES.includes(status)) {
    return { error: '状态筛选值非法' };
  }
  const parseDay = (raw, end) => {
    if (!raw) return null;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    if (!dateOnly && Number.isNaN(new Date(raw).getTime())) {
      return { error: `${end ? '结束时间' : '开始时间'}请填写日期（如 2026-10-01）或完整时间` };
    }
    const d = dateOnly ? new Date(`${raw}T00:00:00.000Z`) : new Date(raw);
    if (Number.isNaN(d.getTime())) return { error: `${end ? 'to' : 'from'} 不是有效日期` };
    if (dateOnly && end) d.setUTCHours(23, 59, 59, 999);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  };
  const from = parseDay(fromRaw, false);
  const to = parseDay(toRaw, true);
  if (from?.error) return { error: from.error };
  if (to?.error) return { error: to.error };
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.pageSize || '20'), 10) || 20));
  return { q, status, from, to, page, pageSize };
}

function claimWhereOf(scope, filter) {
  const parts = [scope.scope];
  const params = [...scope.params];
  if (filter.status === 'todo') {
    parts.push(`n.status IN ('requested','approved','shipped')`);
  } else if (filter.status !== 'all') {
    parts.push('n.status = ?');
    params.push(filter.status);
  }
  if (filter.q) {
    parts.push(`(n.claim_no LIKE ? OR n.order_no LIKE ? OR n.token_id LIKE ? OR n.claimant LIKE ? OR n.tracking_no LIKE ? OR n.token_contract LIKE ?)`);
    const like = `%${filter.q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (filter.from) {
    parts.push('n.created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    parts.push('n.created_at <= ?');
    params.push(filter.to);
  }
  return { where: `WHERE ${parts.join(' AND ')}`, params };
}

/** 公开状态：这枚 token 的提货行（按时间倒序；**不含收货信息**） */
router.get('/nft', byTokenLimiter, wrap(async (req, res) => {
  const contract = String(req.query.contract || '').trim();
  const tokenId = String(req.query.tokenId ?? '').trim();
  if (!contract || !tokenId) return fail(res, '需要合约地址与 NFT 编号两个参数');
  const rows = await getDb().all(
    `SELECT n.*, p.claim_window_days AS claim_window_days, o.updated_at AS order_updated_at,
         (SELECT c.escrow_order_id FROM order_chain c WHERE c.order_id = n.order_id) AS escrow_order_id,
         (SELECT d.tx_hash FROM order_delivery_items d WHERE d.order_id = n.order_id AND d.kind='nft' AND d.value = n.token_id ORDER BY d.id DESC LIMIT 1) AS delivery_tx_hash
       FROM nft_claims n
       LEFT JOIN products p ON p.id = n.product_id
       LEFT JOIN orders o ON o.id = n.order_id
      WHERE n.token_contract = ? AND n.token_id = ? ORDER BY n.id DESC LIMIT 20`,
    contract.toLowerCase(),
    tokenId
  );
  ok(res, { claims: rows.map((r) => claimDto(r, { as: 'public' })) });
}));

/** 我提交过的提货行（需登录；所有状态，新的在前） */
router.get('/nft/mine', requireAuth, wrap(async (req, res) => {
  const rows = await getDb().all(
    `SELECT n.*, p.title AS product_title, p.nft_standard AS nft_standard,
         p.claim_window_days AS claim_window_days, o.updated_at AS order_updated_at,
         (SELECT c.escrow_order_id FROM order_chain c WHERE c.order_id = n.order_id) AS escrow_order_id,
         (SELECT d.tx_hash FROM order_delivery_items d WHERE d.order_id = n.order_id AND d.kind='nft' AND d.value = n.token_id ORDER BY d.id DESC LIMIT 1) AS delivery_tx_hash
       FROM nft_claims n LEFT JOIN products p ON p.id = n.product_id
            LEFT JOIN orders o ON o.id = n.order_id
      WHERE n.claimant = ? ORDER BY n.id DESC LIMIT 200`,
    req.auth.address
  );
  ok(res, { claims: rows.map((r) => claimDto(r, { as: 'holder' })) });
}));

/** 卖家提货 CSV（当前筛选的全量，不分页；含收货信息，属卖家私域） */
router.get('/nft/seller.csv', requireAuth, exportLimiter, wrap(async (req, res) => {
  const filter = claimFilterOf(req);
  if (filter.error) return fail(res, filter.error);
  const scope = await sellerScopeOf(req.auth.address);
  const { where, params } = claimWhereOf(scope, filter);
  const total = Number((await getDb().get(`SELECT COUNT(*) AS total FROM nft_claims n ${where}`, ...params))?.total || 0);
  if (total > 20000) {
    return fail(res, `当前筛选共 ${total} 条，超过单次导出上限 20000 条；请缩小日期或状态范围后重试`);
  }
  const rows = await getDb().all(
    `SELECT n.*, p.title AS product_title, p.nft_standard AS nft_standard,
       p.claim_window_days AS claim_window_days, o.updated_at AS order_updated_at,
       (SELECT c.escrow_order_id FROM order_chain c WHERE c.order_id = n.order_id) AS escrow_order_id,
       (SELECT d.tx_hash FROM order_delivery_items d WHERE d.order_id = n.order_id AND d.kind='nft' AND d.value = n.token_id ORDER BY d.id DESC LIMIT 1) AS delivery_tx_hash
       FROM nft_claims n LEFT JOIN products p ON p.id = n.product_id
            LEFT JOIN orders o ON o.id = n.order_id
       ${where}
      ORDER BY FIELD(n.status,'requested','approved','shipped','fulfilled','rejected','cancelled','expired'), n.id DESC`,
    ...params
  );
  const headers = [
    '提货单号', '订单号', '商品', 'NFT 标准', 'NFT 合约', 'NFT 编号', '提货人',
    '收货人', '电话', '地址', '运单号', 'NFT 转账哈希', '状态', '链上案号', '备注', '申请时间', '更新时间',
  ];
  const csvRows = rows.map((r) => {
    const d = claimDto(r, { as: 'seller' });
    return [
      d.id, d.orderNo, d.productTitle || '', d.nftStandard ? enumText('nftStandard', d.nftStandard) : '',
      d.nftContract, d.tokenId, d.claimant, d.shipping?.name || '', d.shipping?.phone || '',
      d.shipping?.address || '', d.trackingNo || '', d.deliveryTxHash || '',
      enumText('claimStatus', d.status), d.claimId || '', d.note || '', fmtTime(d.createdAt), fmtTime(d.updatedAt),
    ];
  });
  /*
    导出审计**逐店落行**，一行一家店（`shop_code` 由被导出的行自己回答）。

    为什么不是一行节点级（旧形状 `shopCode: null` + `actorRole: 'staff'`）：
      · 角色是假的——卖家本人导出自己的提货单，旧实现恒写 staff；
      · 归属是假的——一份 CSV 可能横跨同一位卖家/店员可经营的几家店，而它读的是店铺私域数据
        （含收货信息）。写成节点级之后**只有节点主看得见**，真正该监督这次导出的店主反而看不到；
        而且节点主看到的是租户的动作，方向反了。
    逐店落行之后，每家店主在自己的审计列表里都能看到"谁在什么时候导出了我这家店的提货单"，
    角色也按该行自己的 seller 判定（seller == 操作者 ⇒ owner，否则 staff：他是因为店员身份进来的）。

    零行导出不落行：没有数据离开节点，就不存在"哪家店的提货单被带走"这个事实；
    给它编一个店铺归属反而是一句假话（见 audit.js 的 logAudit 对 shopCode 的纪律）。
  */
  const byShop = new Map();
  const actorAddress = String(req.auth.address || '').toLowerCase();
  for (const r of rows) {
    const code = String(r.shop_code || '');
    if (!code) continue;
    const g = byShop.get(code) || { rows: 0, mine: false };
    g.rows += 1;
    if (String(r.seller || '').toLowerCase() === actorAddress) g.mine = true;
    byShop.set(code, g);
  }
  for (const [code, g] of byShop) {
    await logAudit({
      req,
      actor: req.auth.address,
      // 他导出的是**自己作为 seller 的那批行** ⇒ 店主；否则他是该店店员（staff）
      actorRole: g.mine ? 'owner' : 'staff',
      shopCode: code,
      action: 'claim.export',
      targetType: 'nft_claim_export',
      targetId: 'seller.csv',
      detail: { rows: g.rows, status: filter.status, from: filter.from, to: filter.to },
    });
  }
  sendCsv(res, `nft-claims-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, headers, csvRows);
}));

/**
 * 我作为卖家/本店店员（本节点）的提货行（需登录；支持搜索/日期/状态/分页）。
 *
 * 列表的授权面必须与 `POST /nft/:id/seller` 完全一致：动作允许该行的 seller **或本店店员**，
 * 而旧列表只按 `seller = ?` 过滤——店员能处理却看不到，只能靠猜 claim id。
 * 这里用 `shop_operators` 找出当前地址任店员的本店编号，再取这些店的提货行。
 */
router.get('/nft/seller', requireAuth, wrap(async (req, res) => {
  const filter = claimFilterOf(req);
  if (filter.error) return fail(res, filter.error);
  const scope = await sellerScopeOf(req.auth.address);
  const { where, params } = claimWhereOf(scope, filter);
  const db = getDb();
  const total = Number((await db.get(`SELECT COUNT(*) AS total FROM nft_claims n ${where}`, ...params))?.total || 0);
  const offset = (filter.page - 1) * filter.pageSize;
  const rows = await db.all(
    `SELECT n.*, p.title AS product_title, p.nft_standard AS nft_standard,
       p.claim_window_days AS claim_window_days, o.updated_at AS order_updated_at,
       (SELECT c.escrow_order_id FROM order_chain c WHERE c.order_id = n.order_id) AS escrow_order_id,
       (SELECT d.tx_hash FROM order_delivery_items d WHERE d.order_id = n.order_id AND d.kind='nft' AND d.value = n.token_id ORDER BY d.id DESC LIMIT 1) AS delivery_tx_hash
       FROM nft_claims n LEFT JOIN products p ON p.id = n.product_id
            LEFT JOIN orders o ON o.id = n.order_id
       ${where}
      ORDER BY FIELD(n.status,'requested','approved','shipped','fulfilled','rejected','cancelled','expired'), n.id DESC
      LIMIT ${filter.pageSize} OFFSET ${offset}`,
    ...params
  );
  ok(res, {
    claims: rows.map((r) => claimDto(r, { as: 'seller' })),
    total,
    page: filter.page,
    pageSize: filter.pageSize,
  });
}));

/** 提交提货声明（持有人；token + 收货信息） */
router.post('/nft', requireAuth, wrap(async (req, res) => {
  const { nftContract, tokenId, shipping, note } = req.body || {};
  const r = await submitClaim({
    contract: nftContract,
    tokenId,
    claimant: req.auth.address,
    shipping,
    note,
  });
  if (!r.ok) return fail(res, r.message);
  ok(res, r.claim, '提货声明已提交；卖家会复核持有人并安排发货');
}));

/** 提货人撤回自己的声明（仅未发货前） */
router.post('/nft/:id/cancel', requireAuth, wrap(async (req, res) => {
  const r = await holderCancelClaim({ claimNo: req.params.id, claimant: req.auth.address });
  if (!r.ok) return fail(res, r.message);
  ok(res, r.claim, '声明已撤回（这枚 token 现在可以被当前持有人重新提交）');
}));

/**
 * 卖家推进/终结声明（approve / ship（需 trackingNo）/ fulfill / reject）。
 *
 * 鉴权 = 该行的 `seller`（订单卖家）**或** 那家店的店员（`roleOf`）；
 * `ship` 会在唯一实现里再查一次链上持有人（A-policy：转手了就拒绝发货，要求先取消）。
 */
router.post('/nft/:id/seller', requireAuth, wrap(async (req, res) => {
  const row = await getDb().get('SELECT seller, shop_code FROM nft_claims WHERE claim_no = ?', String(req.params.id || ''));
  if (!row) return fail(res, '声明不存在', 404, 404);
  const mine = String(row.seller) === String(req.auth.address);
  const staff = mine ? true : (await roleOf(req.auth.address, String(row.shop_code))) === 'staff';
  if (!mine && !staff) return fail(res, '只有该订单的卖家/本店店员可以处理这条提货声明', 403, 403);
  const { action, trackingNo, note } = req.body || {};
  const r = await sellerClaimAction({
    claimNo: req.params.id,
    seller: String(row.seller),
    action,
    trackingNo,
    rejectReason: note,
  });
  if (!r.ok) return fail(res, r.message);
  await logAudit({
    req,
    actor: req.auth.address,
    actorRole: mine ? 'owner' : 'staff',
    shopCode: String(row.shop_code),
    action: 'claim.' + String(action),
    targetType: 'nft_claim',
    targetId: r.claim.id,
    /*
      审计只记**状态与是否存在**：运单号可反查收件人，卖家驳回原因可能含买家个人信息。
      这两类内容住在 nft_claims，会随 PII 擦除清空；audit_logs 是 append-only（触发器拒绝
      UPDATE/DELETE），一旦抄进来就永远删不掉。不要把 detail 当调试日志用。
    */
    detail: {
      status: r.claim.status,
      hasTracking: !!r.claim.trackingNo,
      hasNote: !!r.claim.note,
    },
  });
  ok(res, r.claim, `声明已更新为 ${r.claim.status}`);
}));

/**
 * 生成链上提货争议的参数（nodeAdmin；**不签交易、不广播**）。
 *
 * 返回的 `call.args` 直接喂给节点主钱包的 `Escrow.openClaimDispute(...)`：
 * 节点只负责算准参数并记下 claimId，watcher 随后把链上结论写回本行。
 */
router.post('/nft/:id/dispute', nodeAdmin, wrap(async (req, res) => {
  const { amountWei, deadline } = req.body || {};
  const r = await buildClaimDisputeCall({ claimNo: String(req.params.id), amountWei, deadlineSeconds: deadline });
  if (!r.ok) return fail(res, r.message, r.status, r.status);
  const claimRow = await getDb().get('SELECT shop_code FROM nft_claims WHERE claim_no = ?', String(req.params.id || ''));
  const host = await isHost(req.auth.address, { force: true });
  await logAudit({
    req,
    actor: req.auth.address,
    actorRole: host ? 'host' : 'staff',
    shopCode: null,
    action: 'claim.dispute.prepare',
    targetType: 'nft_claim',
    targetId: String(req.params.id),
    /*
      `shopCode` 是**这家店的治理记录**赖以找到这一行的归属（节点级行的 shop_code 恒为 NULL，
      见 audit.js 的 auditWhere）。没有它，节点主在店铺详情里看不到"这家店的提货争议参数是谁生成的"。
    */
    detail: { claimId: r.call.claimId, amountWei: r.call.args[5], shopCode: claimRow?.shop_code ?? null },
  });
  ok(
    res,
    {
      chainId: config.chain.chainId,
      escrowAddress: config.chain.escrowAddress || null,
      ...r.call,
    },
    '请用节点主钱包广播 openClaimDispute（参数见 call.args）；链上结论由 watcher 回写本行'
  );
}));

export default router;
