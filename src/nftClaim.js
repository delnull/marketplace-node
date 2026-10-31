/**
 * NFT 提货声明（**节点链下**流程；链上只有"提货争议"那一步，见 `Escrow.ClaimCase`）。
 *
 * ## 这个功能回答什么
 *
 * NFT 商品卖的是"一枚 token"，而实物/服务由卖家**链下兑付**。买家拿走 token 之后，
 * 谁有权提货？判据只能是"现在这枚 token 在谁手上"——所以声明的入口是**持有人**，不是原订单买家。
 *
 * ## 判据链（每一环都在本模块唯一实现）
 *
 *  1. **这枚 token 在本节点被交付过**：`order_delivery_items(kind='nft', value=tokenId)`
 *     + 订单终局（confirmed/settled/expired；expired 只要交付行存在就仍可提货）
 *     + 商品行的 `nft_contract` 与请求一致。
 *     没有这一条，任何人在任何 NFT 上都能对本店发起提货声明。
 *  2. **商品开了提货**（`products.claimable = 1`）：收藏品没有线下兑付，不该出现在声明入口。
 *  3. **在提货窗口内**：`claim_window_days` 自**交付订单终局时刻**（`orders.updated_at`）起算；
 *     NULL = 不限期。过期声明直接拒绝，不落行（"过期了还能排上队"比拒绝更糟）。
 *  4. **提交人就是当前持有人**：`ownerOf(tokenId)`（721）/ `balanceOf(claimant, tokenId)`（1155）。
 *     读不到 ⇒ 拒绝（fail-closed）：没有链上读数时"他是不是持有人"没有答案。
 *  5. **一枚 token 同时只有一条未完结声明**：库里的函数唯一索引兜底（并发下也拦得住）。
 *
 * ## A-policy：声明绑定提交人，不随后续转手漂移
 *
 * 声明行记的是**提交那一刻**的持有人。此后 token 若被转走：
 *   · 卖家**发货前**会再查一次链上持有人（`shipClaim`），发现已转手就拒绝发货并提示取消；
 *   · 取消后该行让位（唯一索引只压未完结状态），**新持有人可以重新提一条**；
 *   · 已经 `fulfilled` 的声明不能被第二次兑付（同一枚 token 兑付两次是资金/实物双重损失）。
 *
 * ## 提货争议（链上）
 *
 * 兑付谈不拢时，由**节点运营方**（= 本节点 Escrow 的 owner，`openClaimDispute` 是 onlyOwner）
 * 用钱包发起链上争议；节点不持私钥，所以这里只生成参数并记下 `dispute_claim_id`，
 * 之后由 `escrowWatcher` 把 `ClaimDisputeOpened/Closed/Cancelled` 的结论写回 dispute_* 列。
 */
import { ethers } from 'ethers';
import { getDb, withTransaction } from './db.js';
import { getProvider, isAddress } from './chain.js';
import { newClaimNo } from './ids.js';

/** 仍占着"这枚 token 的提货权"的状态：seller 可操作、新声明不能插队 */
export const CLAIM_OPEN_STATUSES = ['requested', 'approved', 'shipped'];

const TOKEN_ID_RE = /^\d{1,78}$/;
const NAME_MAX = 60;
const PHONE_MAX = 30;
const ADDRESS_MAX = 300;
const NOTE_MAX = 200;
const REASON_MAX = 200;

/* ── 链上持有人读取（可注入；测试不起 RPC）────────────────────────────── */

let _ownershipReader = null;

/**
 * 测试注入点（与 `chainOrder.setChainOrderFetcher` 同款）：`fn({contract, tokenId, claimant})`
 * 返回 `{ owned: true|false|null, detail? }`；传 null 恢复真实链上读取。
 * `owned: null` 表示**读不到**——调用方按 fail-closed 拒绝，绝不折成"不是持有人"或"是"。
 */
export function setNftOwnershipReader(fn) {
  _ownershipReader = typeof fn === 'function' ? fn : null;
}

const ERC165_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
];

/**
 * 这枚 token 现在是不是 `claimant` 的（**唯一判据**）。
 *
 * 先按 ERC-721 `ownerOf`（绝大多数提货型 NFT），调用失败再按 ERC-1155 `balanceOf`。
 * 两条都读不到 ⇒ `{ owned: null }`：**不知道**，调用方必须拒绝（fail-closed）。
 *
 * @returns {Promise<{owned: boolean|null, detail: string}>}
 */
export async function nftOwnedBy({ contract, tokenId, claimant }) {
  if (_ownershipReader) {
    const r = await _ownershipReader({ contract, tokenId, claimant });
    if (!r || (r.owned !== true && r.owned !== false && r.owned !== null)) {
      throw new Error('NFT 持有人读取器返回的形状非法（需要 { owned: true|false|null }）');
    }
    return { owned: r.owned, detail: r.detail || '' };
  }
  const c = String(contract || '').toLowerCase();
  const who = String(claimant || '').toLowerCase();
  if (!isAddress(c) || !isAddress(who) || !TOKEN_ID_RE.test(String(tokenId))) {
    return { owned: null, detail: '合约地址/持有人/ tokenId 形状非法' };
  }
  const nft = new ethers.Contract(c, ERC165_ABI, getProvider());
  try {
    const owner = String(await nft.ownerOf(BigInt(tokenId))).toLowerCase();
    return { owned: owner === who, detail: owner === who ? '' : `当前持有人是 ${owner}` };
  } catch {
    // 不是 721（或该 token 不存在）：再试 1155 的余额读数
  }
  try {
    const bal = BigInt(await nft.balanceOf(who, BigInt(tokenId)));
    return { owned: bal > 0n, detail: bal > 0n ? '' : '该地址在 ERC-1155 上余额为 0' };
  } catch (e) {
    return { owned: null, detail: String(e?.shortMessage || e?.message || e).slice(0, 120) };
  }
}

/* ── 行读取与 DTO ───────────────────────────────────────────────────── */

/** 按对外声明号读一行（读不到返回 undefined） */
export async function claimRowByNo(claimNo) {
  const v = String(claimNo ?? '').trim();
  if (!v) return undefined;
  return await getDb().get(
    `SELECT n.*, (SELECT c.escrow_order_id FROM order_chain c WHERE c.order_id = n.order_id) AS escrow_order_id
       FROM nft_claims n WHERE n.claim_no = ?`,
    v
  );
}

/**
 * 声明行的对外形状（与前端 `NftClaim` 的字段名逐字对齐，见 frontend/src/api/node.ts）。
 *
 * 三个视角共用这一份：
 *  · `public`：公开状态（`GET /api/claims/nft?contract&tokenId` 的聚合一端）——
 *    **不给收货信息与运单号**：收件人姓名/电话/地址是个人信息，"谁在提、寄到哪"不是公开事实。
 *    claimant/seller 是链上本来就公开的钱包地址，照给；
 *  · `holder`：提交人本人（含自己填的收货信息）；
 *  · `seller`：本店店主/店员（含收货信息，发货要用）。
 */
export function claimDto(row, { as = 'public' } = {}) {
  if (!row) return null;
  const base = {
    id: row.claim_no,
    nftContract: row.token_contract,
    tokenId: row.token_id,
    tokenRef: tokenRefOf(row.token_contract, row.token_id),
    orderNo: row.order_no,
    /**
     * 交付这枚 NFT 的链上托管单号（`Escrow.getOrder` 的键）。前端在签名
     * `openClaimDispute` 前必须用它复核订单的卖家/状态，不能只信节点返回的 `args[1]`。
     */
    escrowOrderId: row.escrow_order_id ? String(row.escrow_order_id).toLowerCase() : null,
    seller: row.seller,
    claimant: row.claimant,
    status: row.status,
    shipping: null,
    claimId: row.dispute_claim_id || null,
    note: row.reject_reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (as === 'public') return base;
  return {
    ...base,
    shopCode: row.shop_code,
    productSlug: row.product_slug,
    trackingNo: row.tracking_no || null,
    disputeState: row.dispute_state || 'none',
    disputeOpenedAt: row.dispute_opened_at ?? null,
    disputeClosedAt: row.dispute_closed_at ?? null,
    shipping:
      as === 'seller' || as === 'holder'
        ? {
            name: row.shipping_name || '',
            phone: row.shipping_phone || '',
            address: row.shipping_address || '',
          }
        : null,
    ...(as === 'seller' ? { buyerNote: row.note || '', claimAmountWei: row.claim_amount_wei ?? null } : {}),
  };
}

/* ── 交付事实与窗口 ─────────────────────────────────────────────────── */

/**
 * 这枚 token 在本节点的**交付事实**（唯一读法）：哪一张已完成订单交付了它、商品是否允许提货、
 * 窗口多长。找不到返回 null（"没被本节点交付过"——不是"读不到"）。
 */
export async function deliveredTokenOf(contract, tokenId, { orderId = null } = {}) {
  const c = String(contract || '').toLowerCase();
  const t = String(tokenId || '');
  if (!isAddress(c) || !TOKEN_ID_RE.test(t)) return null;
  const params = [t, c];
  let orderClause = '';
  if (orderId !== null && orderId !== undefined) {
    orderClause = ' AND o.id = ?';
    params.push(orderId);
  }
  return await getDb().get(
    `SELECT o.id AS order_id, o.order_no, o.shop_code, o.product_id, o.product_slug, o.seller,
            o.status, o.updated_at, o.pii_erased_at, p.nft_contract, p.claimable, p.claim_type,
            p.claim_window_days, p.claim_instructions
       FROM order_delivery_items d
       JOIN orders o ON o.id = d.order_id
       JOIN products p ON p.id = o.product_id
      WHERE d.kind = 'nft' AND d.value = ? AND p.nft_contract = ?
        /*
          'expired' 也要收：链上 releaseExpired 把订单结算给卖家（等价 Settled），
          而 NFT 是否已交付由链下交付行决定；交付过就必须允许持有人继续提货/开争议。
        */
        AND o.status IN ('confirmed','settled','expired')${orderClause}
      ORDER BY d.created_at DESC, d.id DESC LIMIT 1`,
    ...params
  );
}

/**
 * 提货窗口的截止时刻（`Date`；null = 不限期或没有窗口依据）。
 *
 * 起算点是**交付订单的终局时刻**（`orders.updated_at`，watcher/同步写下的那一次状态迁移；
 * 与流水/看板同一口径，不另造一个"交付完成时刻"）。窗口长度取商品当前配置。
 * 代价如实写：商品后来改窗口长度会影响在途订单的截止时刻——这是刻意的（窗口是店铺政策），
 * 已提交的声明按提交时判过一次，不受影响。
 */
export function claimDeadlineOf({ delivered, now = Date.now() }) {
  const days = delivered?.claim_window_days;
  if (days === null || days === undefined) return null;
  const base = delivered.updated_at instanceof Date ? delivered.updated_at.getTime() : Number(delivered.updated_at);
  if (!Number.isFinite(base)) return null;
  return new Date(base + Number(days) * 86_400_000);
}

/* ── 提交声明 ───────────────────────────────────────────────────────── */

/**
 * 提交一条提货声明（持有人视角）。
 *
 * @param {{contract:string, tokenId:string, claimant:string,
 *          shipping:{name:string, phone:string, address:string}, note?:string}} input
 * @returns {Promise<{ok:true, claim:object} | {ok:false, status:number, message:string}>}
 *          判别式，不抛错：调用方只需把 `{status,message}` 翻成 HTTP 响应
 */
export async function submitClaim({ contract, tokenId, claimant, shipping, note } = {}) {
  const c = String(contract || '').trim().toLowerCase();
  const t = String(tokenId ?? '').trim();
  const who = String(claimant || '').trim().toLowerCase();
  if (!isAddress(c)) return { ok: false, status: 400, message: 'contract 需为 0x 开头的 NFT 合约地址' };
  if (!TOKEN_ID_RE.test(t)) return { ok: false, status: 400, message: 'tokenId 需为十进制整数（uint256 范围内）' };
  if (!isAddress(who)) return { ok: false, status: 400, message: '登录地址非法' };
  const name = String(shipping?.name ?? '').trim().slice(0, NAME_MAX);
  const phone = String(shipping?.phone ?? '').trim().slice(0, PHONE_MAX);
  const address = String(shipping?.address ?? '').trim().slice(0, ADDRESS_MAX);
  if (!name || !phone || !address) return { ok: false, status: 400, message: '收货信息不全：姓名/电话/地址都必填' };
  const noteText = String(note ?? '').trim().slice(0, NOTE_MAX);

  const delivered = await deliveredTokenOf(c, t);
  if (!delivered) {
    return {
      ok: false,
      status: 409,
      message: '这枚 token 没有在本节点的已完成订单里交付过（或合约地址与商品不符）——无法发起提货声明',
    };
  }
  if (delivered.pii_erased_at != null) {
    return {
      ok: false,
      status: 409,
      message: '该交付订单的个人信息已按请求擦除：擦除是终态，不能再新建提货声明写入收货信息',
    };
  }
  if (Number(delivered.claimable) !== 1) {
    return { ok: false, status: 409, message: '这件商品的卖家没有开启提货兑付（claimable = 0）' };
  }
  const deadline = claimDeadlineOf({ delivered });
  if (deadline && Date.now() > deadline.getTime()) {
    return { ok: false, status: 409, message: `提货窗口已于 ${deadline.toISOString()} 关闭` };
  }
  /*
    持有人判据（**fail-closed**）：读不到链上持有人就拒绝——"无法确认"不等于"是他"。
    代价如实写：本节点 RPC 故障期间持有人提不了货；这条与交付闸同一方向。
  */
  const own = await nftOwnedBy({ contract: c, tokenId: t, claimant: who });
  if (own.owned === null) {
    return { ok: false, status: 503, message: `读不到链上 NFT 持有人（${own.detail}）：无法确认提货资格，请稍后重试` };
  }
  if (!own.owned) return { ok: false, status: 403, message: `你不是这枚 NFT 的当前持有人（${own.detail || '链上 ownerOf 不符'}）` };

  const db = getDb();
  // 已兑付过 ⇒ 一枚 token 只能兑付一次（唯一索引 status 里 fulfilled 也占位，这里给可读拒因）
  const prior = await db.get(
    "SELECT claim_no, status FROM nft_claims WHERE token_contract = ? AND token_id = ? AND status = 'fulfilled' LIMIT 1",
    c,
    t
  );
  if (prior) return { ok: false, status: 409, message: `这枚 token 已兑付过（声明 ${prior.claim_no}），不能重复提货` };
  /*
    窗口已过 / 被驳回 / 被取消的旧行不占位（唯一索引只压 requested/approved/shipped/fulfilled）；
    但"过期"只在提交这一刻惰性判定——没有后台扫描也能让新持有人接手。
  */
  try {
    const claimNo = newClaimNo();
    await withTransaction(async () => {
      const ins = await db.run(
        `INSERT INTO nft_claims
           (claim_no, shop_code, product_id, product_slug, order_id, order_no, seller,
            token_contract, token_id, claimant, status, shipping_name, shipping_phone, shipping_address, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`,
        claimNo,
        delivered.shop_code,
        delivered.product_id,
        delivered.product_slug,
        delivered.order_id,
        delivered.order_no,
        delivered.seller,
        c,
        t,
        who,
        name,
        phone,
        address,
        noteText
      );
      return ins;
    });
    return { ok: true, claim: claimDto(await claimRowByNo(claimNo), { as: 'holder' }) };
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY' || Number(e?.errno) === 1062) {
      return {
        ok: false,
        status: 409,
        message: '这枚 token 已有一条未完结的提货声明（同一枚 token 同时只能有一条）——请等待卖家处理，或先取消旧声明',
      };
    }
    throw e;
  }
}

/* ── 状态迁移（卖家动作的唯一实现）──────────────────────────────────── */

/** 允许的卖家动作与前置状态（**唯一判据**；路由只做鉴权与参数校验） */
const SELLER_ACTIONS = {
  approve: { from: ['requested'], to: 'approved' },
  ship: { from: ['approved'], to: 'shipped' },
  fulfill: { from: ['shipped'], to: 'fulfilled' },
  reject: { from: ['requested', 'approved'], to: 'rejected' },
  cancel: { from: ['requested', 'approved', 'shipped'], to: 'cancelled' },
};

export const SELLER_CLAIM_ACTIONS = Object.keys(SELLER_ACTIONS);

/**
 * 卖家推进/终结一条声明（approve / ship / fulfill / reject / cancel）。
 *
 * `ship` 会**再查一次链上持有人**（A-policy 的另一半）：声明绑定的是提交那一刻的持有人，
 * 卖家发货前若 token 已经转手，货不该发给原提交人——拒绝并要求先取消（新持有人会重新提）。
 * 读不到链上持有人时同样拒绝（fail-closed）：宁可晚发一天，也不把实物发给一个无法确认的人。
 *
 * @param {{claimNo:string, seller:string, action:string, trackingNo?:string, rejectReason?:string}} input
 * @returns {Promise<{ok:true, claim:object} | {ok:false, status:number, message:string}>}
 */
export async function sellerClaimAction({ claimNo, seller, action, trackingNo, rejectReason } = {}) {
  const spec = SELLER_ACTIONS[String(action || '')];
  if (!spec) return { ok: false, status: 400, message: `action 需为 ${SELLER_CLAIM_ACTIONS.join(' / ')}` };
  const row = await claimRowByNo(claimNo);
  if (!row) return { ok: false, status: 404, message: '声明不存在' };
  if (String(row.seller) !== String(seller)) return { ok: false, status: 403, message: '该声明不属于你这家店' };
  if (!spec.from.includes(String(row.status))) {
    return { ok: false, status: 409, message: `当前状态（${row.status}）不能执行 ${action}` };
  }
  if (action === 'ship') {
    const own = await nftOwnedBy({ contract: row.token_contract, tokenId: row.token_id, claimant: row.claimant });
    if (own.owned === null) {
      return { ok: false, status: 503, message: `读不到链上 NFT 持有人（${own.detail}）：发货前必须确认 token 仍在提交人名下，请稍后重试` };
    }
    if (!own.owned) {
      return {
        ok: false,
        status: 409,
        message: `这枚 NFT 已不在提交人名下（${own.detail || '链上 ownerOf 不符'}）：请先取消这条声明（cancel），由新持有人重新提交`,
      };
    }
  }
  const tracking = action === 'ship' ? String(trackingNo ?? '').trim().slice(0, 100) : null;
  if (action === 'ship' && !tracking) return { ok: false, status: 400, message: 'ship 需要 trackingNo（发货单号）' };
  const reason = action === 'reject' ? String(rejectReason ?? '').trim().slice(0, REASON_MAX) : '';

  const sets = ['status = ?'];
  const params = [spec.to];
  if (action === 'ship') {
    sets.push('tracking_no = ?');
    params.push(tracking);
  }
  if (action === 'reject') {
    sets.push('reject_reason = ?');
    params.push(reason);
  }
  params.push(row.id);
  const changed = (await getDb().run(
    `UPDATE nft_claims SET ${sets.join(', ')} WHERE id = ? AND status IN (${spec.from.map(() => '?').join(',')})`,
    ...params,
    ...spec.from
  )).changes;
  if (changed !== 1) return { ok: false, status: 409, message: '声明状态已被并发修改，请刷新后重试' };
  return { ok: true, claim: claimDto(await claimRowByNo(claimNo), { as: 'seller' }) };
}

/**
 * 提交人撤回自己的声明（仅未发货前）：转手后新持有人要能接手，旧声明不能成为永久占位。
 */
export async function holderCancelClaim({ claimNo, claimant } = {}) {
  const row = await claimRowByNo(claimNo);
  if (!row) return { ok: false, status: 404, message: '声明不存在' };
  if (String(row.claimant) !== String(claimant)) return { ok: false, status: 403, message: '只有提交人本人可以撤回' };
  if (!CLAIM_OPEN_STATUSES.includes(String(row.status))) {
    return { ok: false, status: 409, message: `当前状态（${row.status}）不能撤回` };
  }
  if (String(row.status) === 'shipped') return { ok: false, status: 409, message: '已发货的声明不能撤回（请与卖家协商）' };
  const changed = (await getDb().run(
    "UPDATE nft_claims SET status = 'cancelled' WHERE id = ? AND status IN ('requested','approved')",
    row.id
  )).changes;
  if (changed !== 1) return { ok: false, status: 409, message: '声明状态已被并发修改，请刷新后重试' };
  return { ok: true, claim: claimDto(await claimRowByNo(claimNo), { as: 'holder' }) };
}

/* ── 提货争议（链上参数生成 + claimId 记录）────────────────────────── */

/**
 * 提货争议的 `claimId`（**唯一生成规则**）：`keccak256("mk.nftclaim:" + claimNo)`。
 *
 * 为什么用确定性派生而不是随机数：节点要在**开案之前**把 claimId 记进本地行，之后
 * watcher 按它把 `ClaimDisputeOpened/Closed` 写回来。随机数会让"钱包实际用的 id"与
 * "本地记的 id"之间存在一次可能丢失的对应关系（前端传错/重复点击都会分叉）；
 * 派生值对同一个 claimNo 恒相同，重复开案只会在链上 revert（ClaimExists），而不是记错行。
 */
export function disputeClaimIdOf(claimNo) {
  return ethers.keccak256(ethers.toUtf8Bytes(`mk.nftclaim:${String(claimNo)}`));
}

/**
 * `tokenRef` = `keccak256(abi.encodePacked(nftContract, tokenId))`（与前端聚合口径一致）。
 *
 * Escrow 的 `openClaimDispute(..., tokenRef, ...)` 只把它**留痕**在 `ClaimCase` 里，不据此做
 * 任何金额/归属判定，所以这里选 packed 形式（前端 `NftClaim.tokenRef` 就是这么算的）——
 * 两端必须同式，否则同一条提货记录在两处显示成两个 ref。
 */
export function tokenRefOf(contract, tokenId) {
  return ethers.keccak256(
    ethers.solidityPacked(['address', 'uint256'], [String(contract).toLowerCase(), BigInt(tokenId)])
  );
}

/**
 * 生成一次链上 `openClaimDispute` 的调用参数并记下 claimId（**不签交易、不广播**）。
 *
 * 为什么节点不直接发：`openClaimDispute` 是 `onlyOwner`（本节点 Escrow 的 owner = 节点 operator），
 * 而节点进程**不持私钥**——这是全仓的硬边界。节点只负责把参数算准、把"这次开案用的是哪个 id"
 * 记进本地行，交易由节点主钱包发。
 *
 * 入参校验与链上同口径（先在这里挡住可预期的 revert，别让钱包白付 gas）：
 *  · 订单必须在链上**已结算**（`Escrow.openClaimDispute` 要求 status == Settled）；
 *  · 金额 0 < amount ≤ 订单净额（amount − refundedAmount）；
 *  · deadline 是 unix 秒且未过期。
 *
 * @returns {Promise<{ok:true, call:object} | {ok:false, status:number, message:string}>}
 */
export async function buildClaimDisputeCall({ claimNo, amountWei, deadlineSeconds, now = Date.now() } = {}) {
  const row = await claimRowByNo(claimNo);
  if (!row) return { ok: false, status: 404, message: '声明不存在' };
  if (!CLAIM_OPEN_STATUSES.includes(String(row.status)) && String(row.status) !== 'fulfilled') {
    return { ok: false, status: 409, message: `当前状态（${row.status}）不能发起提货争议` };
  }
  if (String(row.dispute_state || 'none') !== 'none') {
    return { ok: false, status: 409, message: `这条声明已有链上争议结论（${row.dispute_state}），不能再次开案` };
  }
  const delivered = await deliveredTokenOf(row.token_contract, row.token_id, { orderId: row.order_id });
  if (!delivered) {
    return { ok: false, status: 409, message: '声明的订单不再是这枚 token 的已交付订单（可能已被转售/对账漂移），不能开案' };
  }
  const claimDeadline = claimDeadlineOf({ delivered, now });
  if (claimDeadline && now > claimDeadline.getTime()) {
    return { ok: false, status: 409, message: `提货窗口已于 ${claimDeadline.toISOString()} 关闭，链上开案已失去商品政策依据` };
  }
  const chainRow = await getDb().get('SELECT escrow_order_id, refunded_amount_wei FROM order_chain WHERE order_id = ?', row.order_id);
  if (!chainRow) return { ok: false, status: 409, message: '该声明的订单没有链上托管镜像（无法定位 Escrow 订单）' };
  const orderRow = await getDb().get('SELECT amount_wei, seller FROM orders WHERE id = ?', row.order_id);
  if (!orderRow) return { ok: false, status: 409, message: '该声明的订单已不存在' };
  const amount = String(amountWei ?? '').trim();
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    return { ok: false, status: 400, message: 'amountWei 需为正整数字符串（wei）' };
  }
  const refunded = BigInt(chainRow.refunded_amount_wei || '0');
  const net = BigInt(orderRow.amount_wei || '0') - refunded;
  if (BigInt(amount) > net) {
    return { ok: false, status: 400, message: `amountWei 超过该订单净额（amount − refunded = ${net.toString()} wei）` };
  }
  let dl = deadlineSeconds === undefined || deadlineSeconds === null || deadlineSeconds === ''
    ? Math.floor(now / 1000) + 7 * 86_400
    : Number(deadlineSeconds);
  if (!Number.isSafeInteger(dl) || dl <= 0) return { ok: false, status: 400, message: 'deadline 需为 unix 秒' };
  /*
    链上 deadline 是“开案后委员会仍可裁的截止”，不能越过商品的提货窗口：否则节点主可以把
    一个已经关闭的商品政策窗口续到任意未来。未给 deadline 时默认 7 天，也要被窗口上限截住。
  */
  if (claimDeadline) {
    const maxDl = Math.floor(claimDeadline.getTime() / 1000);
    if (maxDl <= Math.floor(now / 1000)) {
      return { ok: false, status: 409, message: '商品提货窗口已关闭，不能开案' };
    }
    if (dl > maxDl) dl = maxDl;
  }
  if (dl * 1000 <= now) return { ok: false, status: 400, message: 'deadline 已过去：链上会以 ClaimDeadlinePassed 拒绝' };

  const claimId = disputeClaimIdOf(row.claim_no);
  const tokenRef = tokenRefOf(row.token_contract, row.token_id);
  const changed = (await getDb().run(
    "UPDATE nft_claims SET claim_amount_wei = ?, dispute_claim_id = ? WHERE id = ? AND dispute_state = 'none'",
    amount,
    claimId,
    row.id
  )).changes;
  if (changed !== 1) {
    return { ok: false, status: 409, message: '声明状态已被并发修改（可能已有争议结论），请刷新后重试' };
  }
  return {
    ok: true,
    call: {
      fn: 'openClaimDispute',
      chainId: null, // 由路由补（config.chain.chainId），本模块不读配置以保持纯函数形状
      escrow: null,
      claimId,
      args: [claimId, String(chainRow.escrow_order_id).toLowerCase(), tokenRef, String(orderRow.seller), String(row.claimant), amount, dl],
      tokenRef,
      deadline: dl,
    },
  };
}
