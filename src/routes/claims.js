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
import { verifyToken, roleOf, isHost } from '../auth.js';
import { getDb } from '../db.js';
import { logAudit } from '../audit.js';
import {
  submitClaim,
  claimDto,
  sellerClaimAction,
  holderCancelClaim,
  buildClaimDisputeCall,
} from '../nftClaim.js';

const router = Router();
const requireAuth = makeAuthMiddleware(verifyToken);
const nodeAdmin = makeAuthMiddleware(verifyToken, { nodeAdmin: true });
// 公开状态查询是匿名可读的（买家/二级市场买家要能查），限流防脚本枚举 tokenId
const byTokenLimiter = simpleRateLimit({ windowMs: 60_000, max: 120, message: '提货状态查询过于频繁，请稍后再试' });

/** 公开状态：这枚 token 的提货行（按时间倒序；**不含收货信息**） */
router.get('/nft', byTokenLimiter, wrap(async (req, res) => {
  const contract = String(req.query.contract || '').trim();
  const tokenId = String(req.query.tokenId ?? '').trim();
  if (!contract || !tokenId) return fail(res, '需要 contract 与 tokenId 两个参数');
  const rows = await getDb().all(
    'SELECT * FROM nft_claims WHERE token_contract = ? AND token_id = ? ORDER BY id DESC LIMIT 20',
    contract.toLowerCase(),
    tokenId
  );
  ok(res, { claims: rows.map((r) => claimDto(r, { as: 'public' })) });
}));

/** 我提交过的提货行（需登录；所有状态，新的在前） */
router.get('/nft/mine', requireAuth, wrap(async (req, res) => {
  const rows = await getDb().all(
    'SELECT * FROM nft_claims WHERE claimant = ? ORDER BY id DESC LIMIT 200',
    req.auth.address
  );
  ok(res, { claims: rows.map((r) => claimDto(r, { as: 'holder' })) });
}));

/**
 * 我作为卖家/本店店员（本节点）的提货行（需登录；所有状态，新的在前）。
 *
 * 列表的授权面必须与 `POST /nft/:id/seller` 完全一致：动作允许该行的 seller **或本店店员**，
 * 而旧列表只按 `seller = ?` 过滤——店员能处理却看不到，只能靠猜 claim id。
 * 这里用 `shop_operators` 找出当前地址任店员的本店编号，再取这些店的提货行。
 */
router.get('/nft/seller', requireAuth, wrap(async (req, res) => {
  const address = req.auth.address;
  const staffShops = (
    await getDb().all('SELECT shop_code FROM shop_operators WHERE address = ?', address)
  ).map((r) => String(r.shop_code));
  const rows = staffShops.length
    ? await getDb().all(
        `SELECT * FROM nft_claims WHERE seller = ? OR shop_code IN (${staffShops.map(() => '?').join(',')})
         ORDER BY id DESC LIMIT 200`,
        address,
        ...staffShops
      )
    : await getDb().all('SELECT * FROM nft_claims WHERE seller = ? ORDER BY id DESC LIMIT 200', address);
  ok(res, { claims: rows.map((r) => claimDto(r, { as: 'seller' })) });
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
    detail: { status: r.claim.status, trackingNo: r.claim.trackingNo, note: r.claim.note },
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
  const r = await buildClaimDisputeCall({ claimNo: req.params.id, amountWei, deadlineSeconds: deadline });
  if (!r.ok) return fail(res, r.message, r.status, r.status);
  const host = await isHost(req.auth.address, { force: true });
  await logAudit({
    req,
    actor: req.auth.address,
    actorRole: host ? 'host' : 'staff',
    shopCode: null,
    action: 'claim.dispute.prepare',
    targetType: 'nft_claim',
    targetId: String(req.params.id),
    detail: { claimId: r.call.claimId, amountWei: r.call.args[5] },
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
