/**
 * 订单路由：下单草稿（锁定汇率/应付金额/orderId）→ 买家链上托管 → 状态回写闭环。
 *
 *  GET    /api/orders?address=&status=   买家视角：按买家地址查订单（公开只读）
 *  GET    /api/orders/seller?status=     店主视角：全量订单（需 owner 登录）
 *  GET    /api/orders/seller/ledger      店主收款流水：已入账订单汇总+列表（需 owner 登录）
 *  GET    /api/orders/:id                订单详情（公开只读）
 *  POST   /api/orders                    创建订单草稿 {productSlug, quantity?}（需登录：本人或店主代下单）
 *  POST   /api/orders/:id/paid           买家支付后确认 {txHash}（链上校验 OrderCreated 日志）
 *  POST   /api/orders/:id/ship           店主发货 {trackingNo?}（physical）/ {deliveryCode?}（digital 手动多行）
 *                                        （需 owner 登录；无链上支付凭证拒发）
 *  POST   /api/orders/:id/nft-deliveries NFT 交付登记 {deliveries:[{tokenId,txHash}]}（owner；支持
 *                                        多枚与批量——多行可共享同一 txHash，核验后落交付子表）
 *  POST   /api/orders/:id/cancel         取消订单：draft（买家反悔/重复下单）或 escrowed 无支付
 *                                        凭证的异常单（买家本人或店主可调）
 *  POST   /api/orders/:id/evidence       提交售后/争议陈述 {phase, content}（两级流程数据面：
 *                                        refund_request 买家理由 / refund_reply 店主回复 /
 *                                        arbitration 争议双方陈述，按阶段与订单状态校验；
 *                                        链上动作钱包直调，本接口只收理由供卖家/仲裁人参考）
 *  POST   /api/orders/:id/sync           手动向链上同步订单状态（买家/店主可调；
 *                                        顺带按链上订单创建块补落支付凭证哈希；可恢复误取消单；
 *                                        按链上退款标记回填 refund_status）
 *
 * 状态机（本地）：
 *   draft → escrowed → shipped → confirmed
 *                       ├→ disputed → refunded / settled
 *                       └→ expired（超时释放）
 *   draft/无凭证异常单 → cancelled（买家/店主主动取消或草稿超时，见 /cancel 与 orderSweeper）
 * 本地状态由 escrowWatcher 事件回写驱动（权威）；paid/sync 为即时性辅助路径，
 * 其中 paid 会做链上交易日志校验，防止未支付冒报。
 * ⚠️ `confirmed` 只由**真实 ReceiptConfirmed 事件**产生（= 买家自己确认收货/争议中撤诉放款，
 * 界面文案据此断言"你已确认收货"）。/sync 与后台对账都只有链上快照（getOrder 的 status +
 * refundedAmount），无从证明"买家做过这个动作"，故链上 Settled 在这两条兜底路径上一律落
 * `settled`（文案只讲"钱已结算给商家"）——映射实现在 escrowWatcher.mapChainTerminal（唯一实现）。
 *
 * 两级售后（v2，链上强制，watcher 四事件回写镜像）：
 *   escrowed/shipped --买家 requestRefund--> refund_status=requested（资金冻结、超时释放被禁）
 *     ├--卖家 approveRefund(amount)--> refunded（**全额认赔**，不需要任何授权；全额退款时占位库存
 *     │                               按未交付行口径回补）
 *     ├--买家 acceptPartialRefund(wei) + 卖家 approveRefund(同额)--> settled
 *     │   （**双方谈拢的部分退款**：契约 2026-09 起 approveRefund 只接受「全额」或
 *     │    `acceptedPartialRefund[orderId]` 里买家**精确授权过的那个数**，其它一律
 *     │    `RefundAmountNotAccepted`（旧的 RefundNotFull 已删除）——卖家不能再单方面指定
 *     │    金额把订单结算掉；授权额镜像在 orders.accepted_partial_refund_wei，
 *     │    DTO 下发 acceptedPartialRefundWei/Decimal 供卖家面板给出可执行金额）
 *     └--卖家 rejectRefund--> refund_status=rejected --买家 requestDispute--> disputed
 *   disputed 中卖家仍可 approveRefund 全额和解退款（或按已授权金额部分和解）。被拒后合约不接受
 *   重复申请（防无限冻结循环，见 contracts/src/Escrow.sol requestRefund）——买家下一步即发起争议。
 *   仲裁人可**任意比例**拆分裁决（链上 arbitrate(orderId, refundWei)：refundWei 退买家、
 *   余额扣费后给卖家，本地落 settled 并记 refunded_amount_wei）——仲裁不受"买家授权"约束。
 *   sync 按链上 getOrder 的 refundRequested/refundRejected 权威回填本地 refund_status
 *   （事件漏扫/本地残留兜底，见 applyRefundFlags），并读只读视图 acceptedPartialRefund 补授权额
 *   （事件漏扫兜底；落列逻辑与 watcher 的 PartialRefundAccepted 分支共用 applyAcceptedPartialRefund）。
 *
 * 支付凭证不变量：escrowed 及以上状态必有 paid_tx_hash（链上规范哈希）——
 * watcher（OrderCreated 日志 transactionHash）/paid（收据规范哈希）/sync（按创建块
 * 反查事件）三条路径落库时同步写入。
 *
 * 数量模型（v2）：一单可购 quantity（1..99）件——金额/库存占位/交付均按量；
 * 链上 orderId = keccak(快照hash ‖ 卖家 ‖ 买家 ‖ 草稿 UUID)（UUID 随机化防链上预占，
 * 同买家同商品可反复购买，一单一号，不再有共享 orderId 的混行概念）。
 *
 * 交付物（order_delivery_items 子表，替代 v2 前单值交付列）：
 *  - digital：手动交付按行解析（每行一个码/说明，行数=quantity，命中码池 unused 码事务联动
 *    占用、命中 used 码拒绝）；留空则从码池事务内分配 quantity 个未用码（池不足拒发）
 *  - nft：卖家钱包把池内未用 tokenId 转给买家后再提交 {tokenId,txHash} 核验（绝不自动交付），
 *    支持分批（多枚/多哈希）与批量（同 txHash 多枚）；交付行累计达 quantity 自动置 shipped。
 *    核验按商品快照锁定的 nft_standard 选择事件签名（erc721：Transfer 兼容 ERC721A；
 *    erc1155：TransferSingle/TransferBatch 批量），同 txHash 一次集合核验整组 tokenId；
 *    同 tokenId 多份（value>1）不支持——每件 = 一个独立 tokenId 恰一份
 *  - physical：tracking_no 单值（件数见 quantity）
 * 码对买家仅在已交付状态可见（防未付款探码），对店主/仲裁人始终可见以便追索。
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { ethers } from 'ethers';
import { getDb, txBegin, txCommit, txRollback } from '../db.js';
import config from '../config.js';
import { getRates, cnyFenToPayWei, isPayableAmount } from '../rates.js';
// 订单状态集合的唯一出处（本文件是最大的使用者：入账/在途/已付款/草稿+在途 四套集合，见 src/orderStatus.js）
import {
  INCOME_STATUS as ORDER_INCOME_STATUS,
  ACTIVE_IN,
  PRE_PAID_IN,
  DRAFT_OR_ACTIVE_IN,
} from '../orderStatus.js';
import { verifyToken, roleOf, isStaff } from '../auth.js';
import { logAudit } from '../audit.js';
import { getEscrow, getProvider, fetchOnchainOrder, isAddress, weiToDecimal, getArbiterAddress } from '../chain.js';
import { deliverDigitalFromPool, tryAutoDeliverById } from '../autoDeliver.js';
import { holdStock, releaseHoldsForOrderIds, releaseHoldsForReturnReceived, releaseRefundedEscrow, restockOrder } from '../stockHold.js';
import { verifyNftTransfersTx } from '../nftDelivery.js';
import { newOrderId } from '../ids.js';
import { loadSkus, snapshotObject } from './products.js';
// 草稿 TTL 的单调锚点（唯一实现在 src/monotonicClock.js）：不受墙钟跳变影响的"这单过了多久"
import { bootId, monotonicNow } from '../monotonicClock.js';
import { ok, fail, wrap, bearerToken, makeAuthMiddleware, simpleRateLimit } from '../http.js';
// 金额展示口径的唯一实现（yuanOf / goodsFenOf）——不要再手写 (fen/100).toFixed(2)
import { goodsFenOf, yuanOf } from '../money.js';
import { submitReview, replyReview, findReviewByOrder, reviewToPublic, reviewableAt } from '../reviews.js';
import { reviewContentHash, evidenceContentHash } from '../notary.js';
import { fetchReturnByOrder, returnToPublic } from '../returns.js';
import {
  filesOfEvidenceMany,
  evidencePhaseError,
  EVIDENCE_PHASES,
  EVIDENCE_LIMIT_BY_PHASE as EVIDENCE_LIMIT_BY_PHASE_OF,
  EVIDENCE_PHASE_LABEL as EVIDENCE_PHASE_LABEL_OF,
} from '../evidenceFiles.js';
// 链上终局 → 本地终态的唯一实现（事件路径与快照路径共用；见 escrowWatcher 的 mapChainTerminal）
// + 授权额落列的唯一实现（事件路径与 /sync 快照路径共用；同上）
import { mapChainTerminal, applyAcceptedPartialRefund } from '../escrowWatcher.js';
import { notify } from '../webhook.js';
// 下单风控闸（可选，默认关闭）：店主自配的建单前准入服务——见 orderGate.js 的边界说明
import { checkOrderGate } from '../orderGate.js';
import { refreshFeeCollector, feeStatus, feeOf, feeChargeableForOrder, feeSnapshotOf } from '../fees.js';
// 池式商品「已收款但无货可交」：判定口径与主动告警都在 poolAlert.js（唯一实现）——
// 面板 poolEmpty 与托管落定后的 order.pool_empty webhook 用同一个 poolShortfallOf，
// 避免"面板说缺货但没告警"这类两处口径漂移
import { isPoolEmpty, alertPoolEmptyForOrder } from '../poolAlert.js';

const router = Router();
const requireAuth = makeAuthMiddleware(verifyToken);
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true });
const staffOnly = makeAuthMiddleware(verifyToken, { staffOnly: true }); // P1-⑤：经营面=店主+操作员
// RPC 触碰型动作限流（按 IP）：paid 每次 = 1 次 eth_getTransactionReceipt、sync 每次 =
// getOrder + queryFilter——防登录用户低频耗尽公共 RPC 配额（auth 端点另有专用限流）。
// 每进程独立窗口、量级宽松（正常操作远低于阈值，仅挡脚本化滥用）。
const paidLimiter = simpleRateLimit({ windowMs: 60_000, max: 300, message: '支付确认过于频繁，请稍后再试' });
const syncLimiter = simpleRateLimit({ windowMs: 60_000, max: 120, message: '同步请求过于频繁，请稍后再试' });
// NFT 交付核验每个唯一 txHash 一次 getTransactionReceipt（分组去重）——补 RPC 触碰限流（审计 F5）
const nftVerifyLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '交付核验过于频繁，请稍后再试' });
// 草稿创建限流（2026-09 修复：免费草稿锁库存 DoS 的第二道闸——同 IP 高频建单直接挡脚本，
// 与下方「同买家同商品至多一张未支付草稿」共同提高 sybil 锁库存成本）
const draftLimiter = simpleRateLimit({ windowMs: 60_000, max: 120, message: '下单过于频繁，请稍后再试' });
// 售后陈述限流：写入侧另有 (每单×每角色×每阶段) 条数上限（见 EVIDENCE_LIMIT_BY_PHASE），
// 这里挡的是"换个单/换阶段继续刷"的脚本；正常一方在一个争议里远不到 60 次/分
const evidenceLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '售后陈述提交过于频繁，请稍后再试' });

/** 管理审计便捷包装（仅 staff 记录，buyer 动作自动过滤） */
const audit = (req, action, targetType, targetId, detail) =>
  logAudit({ req, actor: req.auth?.address, actorRole: roleOf(req.auth?.address || ''), action, targetType, targetId, detail });

const ORDER_STATUS = ['draft', 'escrowed', 'shipped', 'confirmed', 'disputed', 'settled', 'refunded', 'expired', 'cancelled'];

/** 链上事件史上限（与 escrowWatcher 一致） */
const EVENT_HISTORY_LIMIT = 20;

/**
 * 售后陈述的「阶段事实」全部来自 `src/evidenceFiles.js`（**唯一实现**）：
 * 条数上限、阶段中文字面、阶段门控（与附件上传端点共用同一份判据）。
 * 原先这些常量与那段 if/else 门控在本文件里另写了一遍，附件端点又写一遍——
 * 两处文案已经漂移、语义出现细微偏差（详见 evidencePhaseError 的说明）。
 * 本地起个别名只为让本文件读起来不用跳文件；判据本体一律不在本文件重写。
 */
const EVIDENCE_LIMIT_BY_PHASE = EVIDENCE_LIMIT_BY_PHASE_OF;
const EVIDENCE_PHASE_LABEL = EVIDENCE_PHASE_LABEL_OF;
/**
 * 订单详情一次最多返回多少条陈述行（**展示上限，不删数据**）：
 * 写入侧已按 (角色×阶段) 限条，正常单最多 10+10+20×2 = 60 条；这里给 100 的余量，
 * 只为兜住"老版本无上限时期写下的脏数据"——详情页对每行都要拼附件元数据，
 * 行数无界就是一次 O(N) 的查询放大（原实现还是逐行 filesOfEvidence 的 N+1）。
 * 超出的行不丢：`evidenceCount` 给总数、`evidenceTruncated` 置真，前端据此提示"仅展示最近 N 条"。
 */
const EVIDENCE_DETAIL_LIMIT = 100;

/** 已入账状态（资金已释放给卖家）：买家确认 / 仲裁判付 / 超时释放 */
const INCOME_STATUS = ORDER_INCOME_STATUS; // 唯一出处：src/orderStatus.js（看板/CSV/可评价同源）

/** 买家侧兑换码可见状态（卖家已交付；退款/取消后码隐藏） */
const DELIVERED_STATUS = ['shipped', 'confirmed', 'settled', 'expired', 'disputed'];

/** 可选鉴权：解析 Bearer（缺失/无效返回 null，不拦截）——用于码等敏感字段的"登录本人可见"渐进展示 */
function optionalAuth(req) {
  try {
    const token = bearerToken(req);
    return token ? verifyToken(token) : null;
  } catch {
    return null;
  }
}

function findOrder(id) {
  return getDb().prepare('SELECT * FROM orders WHERE id = ?').get(String(id || ''));
}

// poolEmpty 提示（列表/详情字段）口径见 src/poolAlert.js：与托管落定后的 order.pool_empty
// 告警共用同一实现（池式商品不限量、下单不占位，故只提示不拦截）。

/** DB 行 → 对外字段（金额均字符串化防精度丢失；快照还原商品字段供买家校验）
 *  opts.as: 'owner' 店主视角 / 'arbiter' 仲裁人视角（裁决证据，码全可见）；
 *  'buyer' 买家视角（仅已交付状态可见码）；默认不暴露码。
 * 交付物以 deliveries 数组输出（kind='code' 为码/说明行，kind='nft' 为 tokenId+txHash 凭证行）。 */
function orderToPublic(o, opts = {}) {
  let snapshot = {};
  try {
    snapshot = JSON.parse(o.product_snapshot || '{}');
  } catch {
    snapshot = {};
  }
  // 链上事件史：JSON 列安全还原（watcher 回写时 append；详情页展示链上凭证）
  let onchainEvents = [];
  try {
    const parsed = JSON.parse(o.onchain_events || '[]');
    onchainEvents = Array.isArray(parsed) ? parsed : [];
  } catch {
    onchainEvents = [];
  }
  // 交付子表聚合：码可见性——店主/仲裁人始终可见（追索/裁决证据）；买家仅已交付（发货后）
  // 可见，退款/取消隐藏（码有实际兑换价值，退款后不再展示）。
  // NFT 凭证行（tokenId/txHash）不随码规则隐藏：转账凭证链上公开（任何人可查 Transfer），
  // 且买家需凭 txHash 自证持有（仲裁/申诉场景）；匿名可见不构成额外泄露（澄清，
  // 实现刻意恒可见——历史注释「同码隐藏规则」已过时）
  const rawItems = getDb()
    .prepare('SELECT kind, value, tx_hash, created_at FROM order_delivery_items WHERE order_id = ? ORDER BY id ASC')
    .all(o.id);
  const codeVisible = (() => {
    if (!opts.as) return false;
    if (opts.as === 'owner' || opts.as === 'arbiter') return true;
    return DELIVERED_STATUS.includes(o.status);
  })();
  const deliveries = rawItems
    .filter((it) => it.kind === 'nft' || codeVisible)
    .map((it) => ({
      kind: it.kind,
      value: it.value,
      txHash: it.kind === 'nft' ? it.tx_hash : null,
      createdAt: it.created_at,
    }));
  /*
    交付时刻：
      · 数字 / NFT 单 = 最后一条交付行的写入时刻；
      · **实物单 = 发货时刻**（`orders.shipped_at`）——实物的交付事实就是"已发货+物流单号"，
        `order_delivery_items` 里只会有兑换码与 NFT 行，实物单一条都没有。
        早先靠给实物单补一条假交付行来让这个字段非空，结果是同一张单上物流单号出现两次；
        改成按 shipped_at 兜底之后，实物单的发货时间照样有，且数据里不再有假行。
  */
  const deliveredAt =
    rawItems.length > 0
      ? Math.max(...rawItems.map((it) => it.created_at))
      : o.shipped_at
        ? Number(o.shipped_at)
        : null;
  // 收货信息为买家隐私：仅买家本人/店主/仲裁人视角返回，匿名与第三人恒 null
  const shippingVisible = opts.as === 'buyer' || opts.as === 'owner' || opts.as === 'arbiter';
  // 评价标记/内容（同构输出；公开列表仅 rated 驱动入口，内容随详情视角）
  const reviewRow = findReviewByOrder(o.id);
  const review = reviewRow
    ? {
        rated: true,
        rating: reviewRow.rating,
        content: reviewRow.content || null,
        reply: reviewRow.reply_content || null,
        createdAt: reviewRow.created_at,
        replyAt: reviewRow.reply_at || null,
        // 内容哈希存证（ARCHITECTURE.md §2.3）：kind='review'，买家原文哈希，可上链防删改
        contentHash: reviewContentHash(o.id, reviewRow.content || ''),
      }
    : { rated: false, rating: null, reviewable: reviewableAt(o) };
  // 退货单（履约/追回信息，按当事人视角可见——同收货信息矩阵）
  const returnRow = fetchReturnByOrder(o.id);
  const returnInfo = returnRow && shippingVisible ? returnToPublic(returnRow) : null;
  return {
    id: o.id,
    productSlug: o.product_slug,
    productSnapshot: snapshot,
    snapshotHash: o.snapshot_hash,
    /** 所选规格组合标识（无规格商品为空串） */
    skuKey: o.sku_key || '',
    /** 所选规格快照：{ 颜色:'黑', 尺寸:'65' }（下单时冻结；无规格为 {}） */
    skuSpecs: (() => {
      try {
        const v = JSON.parse(o.sku_specs || '{}');
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      } catch {
        return {};
      }
    })(),
    buyer: o.buyer,
    seller: o.seller,
    quantity: o.quantity || 1,
    shipping: shippingVisible
      ? {
          name: o.shipping_name || '',
          phone: o.shipping_phone || '',
          address: o.shipping_address || '',
        }
      : null,
    // 买家给卖家的订单备注：同收货信息可见矩阵（买家本人/店主/仲裁人可见，匿名与第三人恒 null）
    note: shippingVisible ? o.note || '' : null,
    /**
     * 未成年人禁止购买：买家在下单时点过确认（1/0）。
     * **只是留痕**——客户端断言不是年龄证明，本字段不构成授权/资格结论；
     * 商品是否属于年龄限制商品由快照里的 age_restricted 决定（买家可复算核验）。
     */
    ageAck: !!o.age_ack,
    /**
     * 发票信息（线下开票用）：**个人信息**（抬头/税号），可见矩阵与收货信息一致——
     * 买家本人/店主/仲裁人可见，匿名与第三人恒 null；PII 擦除路径会清空 title/taxNo。
     * invoice_needed 是订单处理标记（非 PII），擦除后保留，故放在同一对象里一并返回。
     */
    invoice: shippingVisible
      ? {
          needed: !!o.invoice_needed,
          title: o.invoice_title || '',
          taxNo: o.invoice_tax_no || '',
        }
      : null,
    // 收货信息是否已修改过一次（发货前仅一次修改通道；0/1）
    shippingEdited: shippingVisible ? !!o.shipping_edit_count : null,
    amountWei: o.amount_wei,
    amountDecimal: weiToDecimal(o.amount_wei),
    /** 已退给买家的金额（部分退款/拆分裁决；0=未退，= amountWei 表示全额退款） */
    refundedAmountWei: o.refunded_amount_wei || '0',
    refundedAmountDecimal: weiToDecimal(o.refunded_amount_wei || '0'),
    /*
      买家**已授权**的部分退款额（链上 acceptedPartialRefund(orderId) 的镜像；'0' = 未授权）。
      为什么下发（源码审计 2026-09）：契约收紧后 approveRefund 只接受「全额」或「买家精确授权过的
      那个数」，卖家面板必须先把授权额显示出来，店主才可能给出一个链上真的会接受的金额——
      否则他只能凭空试数字，吃链上那条晦涩的 revert（RefundAmountNotAccepted）。
      与 refundedAmountWei 同口径：字符串 wei + BTY 小数展示（weiToDecimal），防止精度丢失。
    */
    acceptedPartialRefundWei: o.accepted_partial_refund_wei || '0',
    acceptedPartialRefundDecimal: weiToDecimal(o.accepted_partial_refund_wei || '0'),
    /** 尚未退款的结算基数 = 托管额 − 已退（卖家侧口径，平台费按它计） */
    settledBaseWei: (() => {
      try {
        const base = BigInt(o.amount_wei || '0') - BigInt(o.refunded_amount_wei || '0');
        return (base > 0n ? base : 0n).toString();
      } catch {
        return o.amount_wei || '0';
      }
    })(),
    cnyFen: o.cny_fen,
    cny: yuanOf(o.cny_fen),
    /*
      金额拆分（运费模型 = **按单收取一次**的实物运费，见 POST / 里的锁定逻辑）：
        cnyFen            = 本单应付总额（商品 + 运费），也是链上锁定 amountWei 的 CNY 口径
        shippingFeeCnyFen = 本单实际锁定的运费（数字/NFT 单恒 0）
        goodsCnyFen       = cnyFen − 运费 = 商品金额（单价 × 数量）
      三者一起给，前端才能把「商品金额 + 运费 = 应付」这条算式摆给买家核对。
      口径实现在 src/money.js（**唯一一份**，与 arbitration/products 共用）。
    */
    shippingFeeCnyFen: o.shipping_fee_cny_fen || 0,
    shippingFeeCny: yuanOf(o.shipping_fee_cny_fen),
    goodsCnyFen: goodsFenOf(o.cny_fen, o.shipping_fee_cny_fen),
    goodsCny: yuanOf(goodsFenOf(o.cny_fen, o.shipping_fee_cny_fen)),
    btyUsdtRate: o.bty_usdt_rate,
    usdtCnyRate: o.usdt_cny_rate,
    status: o.status,
    escrowOrderId: o.escrow_order_id,
    paidTxHash: o.paid_tx_hash || null,
    onchainEvents,
    /*
      物流单号同属履约信息，与收货信息/备注/退货单走**同一可见矩阵**（源码审计 2026-09 修复）：
      本函数里其它敏感字段都过 shippingVisible，只有这一项漏了门控，于是匿名/第三人
      也能拿到它。物流单号不是"一个无害的编号"——承运商查询页用单号即可反查收件人姓名、
      电话与地址，等于绕过整张可见矩阵把收货信息交出去；而链上 OrderCreated 日志里
      买家的托管单号与地址都是公开的，匿名 `GET /api/orders?address=<链上读到的买家>`
      就能批量取走这家店全部实物单的物流单号。且 tracking_no 又在本仓"刻意不擦除"清单里
      （合规上不构成补救），所以必须在**返回口**挡住。
    */
    trackingNo: shippingVisible ? o.tracking_no || null : null,
    shippedAt: o.shipped_at || null, // 发货标记时刻（含自提/空单号交付——后前端"已交付"判定依据）
    deliveries,
    deliveredAt,
    refundStatus: o.refund_status || 'none',
    refundRequestedAt: o.refund_requested_at || null,
    refundRejectedAt: o.refund_rejected_at || null,
    feeBps: o.fee_bps || 0,
    /**
     * 链上**创建订单时**的平台费收取方快照（小写；'' = 未补录/未知 → null）。
     * 合约 `Escrow._settle` 只读这个快照决定这单扣不扣费（全局 feeCollector() 事后可改，
     * 不代表任何在途单的口径）——下发它前端才能自己核账，不必猜。
     */
    feeCollectorAtCreate: o.fee_collector_at_create ? String(o.fee_collector_at_create).toLowerCase() : null,
    /**
     * **按单**的平台费是否会被扣（前端据此在「已扣 / 不扣 / 预计」之间选文案）：
     * 快照非空 → 权威判定（零地址 = 这单永不扣费）；快照为空 → 退回全局保守口径
     *（未知时按可能扣费处理，与 feeStatus().feeChargeable 同值）。
     */
    feeChargeable: feeChargeableForOrder(o.fee_collector_at_create),
    review,
    return: returnInfo,
    timeoutBlocks: o.timeout_blocks,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

/** 状态迁移（仅当当前状态在 from 内），返回受影响行数 */
function transition(orderId, from, to) {
  const fromList = Array.isArray(from) ? from : [from];
  const marks = fromList.map(() => '?').join(',');
  return getDb()
    .prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE escrow_order_id = ? AND status IN (${marks})`)
    .run(to, Date.now(), orderId, ...fromList).changes;
}

/**
 * 校验买家支付收据：交易已上链、接收方为托管合约且含本订单 OrderCreated 日志。
 * 返回 { ok: true, canonicalHash } 或 { ok: false, message }。
 * canonicalHash 取收据的链上规范哈希：BTY EVM 交易在链上同时存在
 * Chain33TxId（主链哈希）与 EvmTxId（EVM 哈希）两个 ID（见 docs/ARCHITECTURE.md 3.7），
 * 钱包广播返回的可能只是其中一个别名。一律以 eth_getTransactionReceipt 返回的
 * 规范哈希落库，同一笔支付无论用哪个别名确认都归一为同一值——
 * 配合 paid_tx_hash 唯一索引实现「支付 txHash 必须唯一」。
 */
async function verifyPaidReceipt(order, txHash) {
  const receipt = await getProvider().getTransactionReceipt(txHash);
  if (!receipt) return { ok: false, message: '链上暂未检索到该交易，请稍后重试' };
  // 显式校验执行结果（源码审计 2026-09）：原来只靠「revert 的交易没有日志」这一在 BTY 兼容层
  // 未经验证的假设——收据若带 status 字段就按它判定，缺失（兼容层不带）时继续走日志判定。
  if (receipt.status !== undefined && receipt.status !== null && Number(receipt.status) !== 1) {
    return { ok: false, message: '该交易在链上执行失败（status ≠ 1），未产生托管——请核对钱包交易记录' };
  }
  const escrowAddr = config.chain.escrowAddress.toLowerCase();
  // BTY 兼容层收据实测不含 to 字段（仅 eth_getTransactionByHash 返回），不可作硬校验——
  // 下方「日志地址 == 托管合约」已是交易打到托管合约的充分证据（合约事件只能由合约自身发出）；
  // 仅当收据返回了 to 且与托管合约不符时才拒绝（防标准 EVM 链上的张冠李戴）
  if (receipt.to && receipt.to.toLowerCase() !== escrowAddr) {
    return { ok: false, message: '该交易的接收方不是托管合约地址' };
  }
  const iface = getEscrow().interface;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowAddr) continue;
    let parsed = null;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed && parsed.name === 'OrderCreated') {
      const created = parsed.args;
      // 防伪托管 + 账户一致性：Escrow 仅收原生 BTY，但事件可能被同名 orderId 干扰——
      // 必须核对事件中的金额/卖家/买家与本地订单锁定值一致（真实入金必然同值；
      // 买家比对防「他人钱包代付」把资金锁死在他人 buyer 名下/误触发交付）。
      const orderIdOk = String(created.orderId).toLowerCase() === order.escrow_order_id;
      const sellerOk = String(created.seller || '').toLowerCase() === String(order.seller || '').toLowerCase();
      const buyerOk = String(created.buyer || '').toLowerCase() === String(order.buyer || '').toLowerCase();
      let amountOk = false;
      try {
        amountOk = BigInt(created.amount) === BigInt(order.amount_wei || '0');
      } catch {
        amountOk = false;
      }
      if (orderIdOk && sellerOk && buyerOk && amountOk) {
        return {
          ok: true,
          canonicalHash: String(receipt.hash || txHash).toLowerCase(),
          blockNumber: receipt.blockNumber || null,
        };
      }
    }
  }
  return { ok: false, message: '交易中未找到与本单锁定匹配的托管事件（需 OrderCreated 且金额/卖家/买家一致，疑似未托管/他人代付或伪造托管）' };
}

/**
 * 事件史补写 OrderCreated（paid/sync 快路径专用）：watcher 仅在状态迁移成功时记录事件，
 * paid 先行置 escrowed 后 watcher 轮询到 OrderCreated 不再迁移（changed=0）——该单事件史将
 * 永缺 OrderCreated，导致详情页凭证链不完整、信誉画像（按事件史计单量/确认率分母/发货耗时
 * 起点）漏计整单。按订单 id 补写一条与 watcher 同构的镜像 {name,txHash,block,at}；
 * 已含 OrderCreated 时跳过（watcher 已记/重复调用幂等）。
 */
export function appendOrderCreatedEvent(orderId, meta = {}) {
  const db = getDb();
  const row = db.prepare('SELECT onchain_events FROM orders WHERE id = ?').get(String(orderId || ''));
  if (!row) return;
  let list = [];
  try {
    list = row.onchain_events ? JSON.parse(row.onchain_events) : [];
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  if (list.some((ev) => ev && ev.name === 'OrderCreated')) return;
  list.push({ name: 'OrderCreated', txHash: meta.txHash || null, block: meta.block || null, at: Date.now() });
  // 与 recordEvent(watcher) / appendSyncMirrorEvent 同款裁剪（事件史上限 20，见 docs §3.6）：
  // 此前本函数不裁剪，同一单一旦走到"先有 20 条（sync 镜像/watcher 事件）后补写 OrderCreated"
  // 的顺序，事件史就会变成 21+ 条，与另两条写入路径的承诺不一致（详情页/信誉画像按它读）。
  if (list.length > EVENT_HISTORY_LIMIT) list = list.slice(-EVENT_HISTORY_LIMIT);
  db.prepare('UPDATE orders SET onchain_events = ? WHERE id = ?').run(JSON.stringify(list), String(orderId || ''));
}

/**
 * 事件史补写 Sync 镜像（sync 手动推进专用）：watcher 漏扫后经 /sync 迁移的订单，
 * 详情凭证链与信誉画像可能缺里程碑——补一条 {name:'Sync:<状态>', block: 链上订单创建块} 镜像
 * （不与 watcher 真实事件重名，信誉计数按真实事件名统计不受影响；前端时间线按语义展示）。
 * 幂等：同状态镜像已存在时跳过。
 * 导出：链上状态对账（chainReconcile）修复滞留单时用同一条镜像——UI 时间线上"为什么变了"
 * 的解释只有一种形状（`Sync:<状态>`），不论修复来自手动 /sync 还是后台对账。
 */
export function appendSyncMirrorEvent(orderId, toStatus, meta = {}) {
  const db = getDb();
  const row = db.prepare('SELECT onchain_events FROM orders WHERE id = ?').get(String(orderId || ''));
  if (!row) return;
  let list = [];
  try {
    list = row.onchain_events ? JSON.parse(row.onchain_events) : [];
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  const name = `Sync:${toStatus}`;
  if (list.some((ev) => ev && ev.name === name)) return;
  list.push({ name, txHash: null, block: meta.block || null, at: Date.now() });
  if (list.length > EVENT_HISTORY_LIMIT) list = list.slice(-EVENT_HISTORY_LIMIT);
  db.prepare('UPDATE orders SET onchain_events = ? WHERE id = ?').run(JSON.stringify(list), String(orderId || ''));
}

/**
 * 将规范支付哈希写入订单（仅当该列仍为空且订单仍处于可支付态）。
 * 状态条件防竞态错记：草稿被清扫器关闭/买家取消（cancelled）后才落定的链上支付，
 * 哈希必须保持为空——watcher 的 OrderCreated 恢复分支以「cancelled 且无凭证」为前置，
 * 若此处把哈希写在 cancelled 行上，自动恢复将被永久跳过（链上资金真实存在而本地
 * 永远 cancelled，只能人工 sync 救回）。
 * 哈希已被其他订单占用时返回 { error: 'taken' }。先应用层预检给出友好错误；
 * 唯一索引 idx_orders_paid_tx 兜底并发竞态（SQLITE_CONSTRAINT）。
 * 落库成功同步补写 OrderCreated 事件史（paid 快路径不迁移 watcher 事件，见 appendOrderCreatedEvent）。
 */
function notePaidTxHash(order, canonicalHash) {
  const db = getDb();
  const taken = db
    .prepare('SELECT id FROM orders WHERE paid_tx_hash = ? AND id != ?')
    .get(canonicalHash, order.id);
  if (taken) return { error: 'taken' };
  // 哈希落库 + OrderCreated 事件史同事务（防半写：凭证已落而事件史缺失——凭证链/信誉漏计）
  try {
    txBegin();
    let changed = 0;
    try {
      changed = db
        .prepare(
          `UPDATE orders SET paid_tx_hash = ?, updated_at = ? WHERE id = ? AND paid_tx_hash IS NULL AND status IN ${PRE_PAID_IN}`
        )
        .run(canonicalHash, Date.now(), order.id).changes;
      if (changed === 1) appendOrderCreatedEvent(order.id, { txHash: canonicalHash });
      txCommit();
    } catch (e) {
      txRollback();
      throw e;
    }
    return { changes: changed };
  } catch (e) {
    if (/SQLITE_CONSTRAINT|UNIQUE constraint/i.test(String(e.code || '') + ' ' + String(e.message || ''))) return { error: 'taken' };
    throw e;
  }
}

// ── 创建草稿 ──

/**
 * 创建订单草稿：锁定商品快照 + 汇率与应付金额（单价×数量）+ 链上 orderId。
 * 鉴权（防匿名占位 DoS，P1-2）：需登录且目标买家=登录地址，店主可代买家下单（卖家面板代客单）；
 * 叠加每地址活跃草稿上限（防注册地址批量占位）。
 * orderId = keccak256(快照hash ‖ seller ‖ buyer ‖ 草稿 UUID)——UUID 随机化：
 *  - 同买家同商品可反复购买（v2 需求，不再防重拦截）；
 *  - 链上预占不可行（攻击者无法预知 orderId，原「确定性 orderId 占位 DoS」随之消除）。
 */
router.post('/', requireAuth, draftLimiter, wrap(async (req, res) => {
  const owner = (config.shop.owner || '').toLowerCase();
  if (!isAddress(owner)) return fail(res, '本节点未配置店主地址（MK_SHOP_OWNER），无法下单');
  if (!config.chain.escrowAddress) return fail(res, '本节点未启用托管支付（MK_ESCROW_ADDRESS 未配置）');
  const { productSlug, skuKey: bodySkuKey, buyer: bodyBuyer, quantity, shipping, note, ageAck, invoice } = req.body || {};
  const me = req.auth.address;
  const qty = quantity === undefined || quantity === null ? 1 : Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) return fail(res, 'quantity 需为 1..99 的整数');
  // 买家给卖家的订单备注（选填 ≤200 字；不入快照/不影响资金锁定——仅履约沟通用，当事人可见）
  const noteText = String(note ?? '').trim().slice(0, 200);
  /*
    未成年人禁止购买的买家确认（机制，不是政策）：
      · 只有商品 age_restricted=1 时才要求；此时**必须**显式断言 ageAck=true 才建单（否则拒单）；
      · ⚠️ 客户端断言不是年龄证明——落库的 age_ack 只是"买家在页面上点过确认"的留痕，
        不构成授权/资格结论（真要核验身份，那是运营方的线下流程，不是本软件能提供的保证）；
      · 非年龄限制商品：断言一律忽略（恒 0），避免给无关订单留下误导性痕迹。
  */
  if (ageAck !== undefined && ageAck !== null && ![true, false, 0, 1].includes(ageAck)) {
    return fail(res, 'ageAck 需为布尔值（买家对「未成年人禁止购买」的确认）');
  }
  const ageAckAsserted = ageAck === true || ageAck === 1;
  /*
    发票信息（选填；机制，不是税务政策）：{ needed, title, taxNo }。
    title/taxNo 是**个人信息**：仅当事人可见（同收货信息矩阵），并纳入 PII 擦除路径。
    这里统一 trim + 长度上限；超限**明确拒绝**而不是截断——截断出一个错的税号，
    比拒绝一次更糟（店主会照着一个不完整的税号去开票）。
  */
  let invoiceInfo = { needed: false, title: '', taxNo: '' };
  if (invoice !== undefined && invoice !== null) {
    if (typeof invoice !== 'object' || Array.isArray(invoice)) return fail(res, 'invoice 需为对象 { needed, title, taxNo }');
    const title = String(invoice.title ?? '').trim();
    const taxNo = String(invoice.taxNo ?? '').trim();
    if (title.length > 100) return fail(res, '发票抬头不能超过 100 字符');
    if (taxNo.length > 40) return fail(res, '纳税人识别号不能超过 40 字符');
    const needed = invoice.needed === undefined || invoice.needed === null ? false : invoice.needed;
    if (![true, false, 0, 1].includes(needed)) return fail(res, 'invoice.needed 需为布尔值');
    const neededFlag = needed === true || needed === 1;
    // 勾了要发票却什么都没填 = 店主拿到一张无从开票的记录：宁可拒单让买家补全
    if (neededFlag && !title && !taxNo) {
      return fail(res, '需要开票时请至少填写发票抬头或纳税人识别号（否则店主无从开票）');
    }
    invoiceInfo = { needed: neededFlag || !!(title || taxNo), title, taxNo };
  }
  // 收货信息（选填，实物履约用；不入快照/不影响资金锁定——资金以链上签名为准，地址仅履约参考）
  let shippingInfo = { name: '', phone: '', address: '' };
  if (shipping && typeof shipping === 'object') {
    const raw = {
      name: String(shipping.name ?? '').trim(),
      phone: String(shipping.phone ?? '').trim(),
      address: String(shipping.address ?? '').trim(),
    };
    if (raw.name.length > 60) return fail(res, '收货人姓名不能超过 60 字符');
    if (raw.phone.length > 30) return fail(res, '收货电话不能超过 30 字符');
    if (raw.address.length > 300) return fail(res, '收货地址不能超过 300 字符');
    shippingInfo = raw;
  }
  if (!shippingInfo.name && !shippingInfo.phone && !shippingInfo.address) {
    shippingInfo = { name: '', phone: '', address: '' };
  }
  // 目标买家：默认本人；店主可代买家下单（测试/代客场景），其余只允许本人
  const target = bodyBuyer ? String(bodyBuyer).toLowerCase() : me;
  if (!isAddress(target)) return fail(res, 'buyer 需为 0x 开头的以太坊地址');
  if (me !== target && me !== owner) return fail(res, '只能为本人下单（店主可代买家下单）', 403, 403);

  const product = getDb()
    .prepare('SELECT * FROM products WHERE slug = ? AND active = 1')
    .get(String(productSlug || ''));
  if (!product) return fail(res, '商品不存在或已下架', 404, 404);
  // ── 所选 SKU：价格与库存的权威来源 ──
  // 无规格商品的唯一组合 sku_key 为 ''，故这里不需要「有无规格」的分支。
  // 未指定 skuKey 时：只有一个组合就自动选中（简化调用仍可用）；
  // 多组合则必须显式选择 —— 否则金额无法确定，宁可拒单也不猜。
  const skuRows = loadSkus(product.id);
  const wantKey = bodySkuKey === undefined || bodySkuKey === null ? null : String(bodySkuKey);
  const sku =
    wantKey !== null
      ? skuRows.find((s) => s.sku_key === wantKey)
      : skuRows.length === 1
        ? skuRows[0]
        : null;
  if (!sku) {
    if (wantKey !== null) return fail(res, '所选规格不存在，请刷新页面后重新选择', 400, 400);
    return fail(res, '该商品有多种规格，下单时需指定 skuKey（所选规格组合）', 400, 400);
  }
  if (!sku.active) return fail(res, '所选规格已停售，请选择其它规格', 400, 400);
  // 年龄限制商品的买家确认门槛：没断言就不建单（防"默认通过"把机制做成空壳）。
  // 是否受限制取决于**商品行**（product.age_restricted），不是客户端说了算；
  // 这里先于汇率读取与占位判定，尽早给出可行动的拒绝（不消耗库存额度、不触碰 RPC）。
  if (product.age_restricted && !ageAckAsserted) {
    return fail(
      res,
      '该商品为未成年人禁止购买商品：下单前需买家显式确认（ageAck=true）。请勾选确认后再下单',
      400,
      400
    );
  }
  // 池式商品（码池 / NFT tokenId 池）的可用量核算在**事务内**做（见下方 txBegin 段）：
  // 只 COUNT 未用资源不扣减在途需求时，N 个并发草稿对 1 个码可以全部通过（各自都看到"还剩 1"），
  // 付款后只有先交付的那单拿得到资源，其余买家钱被托管却拿不到货——与 ARCHITECTURE.md §3.2
  // 「售罄拦截：防付款后无码可发」的承诺不符（源码审计 2026-09）。

  const rates = await getRates();
  if (!rates) return fail(res, '汇率数据源暂不可用，无法锁定应付金额，请稍后再试');

  /*
    运费：**按单收取一次**（不随件数翻倍）。
    取舍理由：实物小店的实际快递成本按"一个包裹"计，一件与三件的快递费基本相同；
    算式也最简单——应付 = 单价 × 数量 + 运费。若逐件计费，多件订单会凭空多收 N 倍快递费，
    而买家在下单页看到的"运费 ¥X"会与结算页金额不符（同一屏两套口径是最坏的体验）。
    仅实物商品计运费：数字 / NFT 无需物流，恒 0（商品侧已禁止给非实物设运费，这里是第二道闸）。
  */
  const shippingFeeFen =
    product.kind === 'physical' && Number.isInteger(product.shipping_fee_cny_fen) && product.shipping_fee_cny_fen > 0
      ? product.shipping_fee_cny_fen
      : 0;
  const goodsFen = sku.price_cny_fen * qty;
  // cny_fen = 商品金额 + 运费（订单行的权威总额口径）；amountWei 由它折算，两者恒同源
  const totalFen = goodsFen + shippingFeeFen;

  // 支付币种固定为原生 BTY：CNY 标价×数量 + 运费按当前汇率折算锁定（wei，向上取整防少付）
  const amountWei = cnyFenToPayWei(totalFen, rates);
  /*
    零金额草稿必须在这里拦住（源码评审 2026-09，P1）：`cnyFenToPayWei` 在汇率不可用时返回 '0'
    （rates.js 里 `scaled <= 0` 或非有限数就 return '0'），而它上游只判了 `!rates`（数据源**完全**
    拿不到）。于是"汇率链返回垃圾值/两项里有一项缺失"时，草稿会带着 amountWei='0' 落库——
    链上 `Escrow.createOrder` 有 `if (amount == 0) revert InvalidAmount()`，这笔支付**永远发不出去**，
    而草稿会一直占着库存占位与"同买家 10 张草稿"的额度，直到 30 分钟 TTL 清扫。
    宁可现在给一句可行动的拒绝，也不要产生一张注定付不掉的单（判据本体在 rates.isPayableAmount，有单测）。
  */
  if (!isPayableAmount(amountWei)) {
    return fail(res, '汇率换算结果异常（应付金额为 0），暂时无法下单：请稍后重试；持续出现请让店主检查节点汇率源');
  }
  const db = getDb();
  const now = Date.now();
  /*
    订单号 = 新式可读标识（`B` + 时间 + 随机，21 字符、无连字符，见 src/ids.js）。
    它对人友好（可念、可抄、可搜），对机器仍然够随机（50 bit）——订单是半敏感资源，
    拿单号能看到收货信息，所以不能用顺序号。
    注意：它同时被当作**草稿随机盐**参与下面的 orderId 哈希，随机性要求不变。
  */
  const id = newOrderId(now);
  // 草稿 UUID 纳入 orderId 哈希（随机化防链上预占；同买家同商品可反复购买）
  const orderIdHex = ethers.solidityPackedKeccak256(
    ['bytes32', 'address', 'address', 'string'],
    [product.snapshot_hash, owner, target, id]
  );
  /*
    订单锁定的商品快照必须与商品级快照**同源同形**：snapshotObject 的 skus 取自「行上的 skus 数组」，
    而 `SELECT * FROM products` 出来的行没有该属性 → 快照里的 skus 会变成 []。
    那样订单快照与其 snapshot_hash 复算不一致：前端订单页会报假的「商品内容已被修改」，
    仲裁页（按快照 skus 反查所选组合的锁定价）也永远查不到价——快照核验的意义就没了。
    这里显式挂上 loadSkus（形状与 rowToPublic 一致：sku_key / price_cny_fen）。
  */
  const snapshot = snapshotObject({ ...product, skus: loadSkus(product.id) });
  /*
    下单风控闸（可选、默认关闭）：**运营方自己的**准入策略执行点——平台不提供风控服务、
    也不替店主判定，节点只是把这一单的交易要素转给店主配的服务，按应答放行或拒单
    （默认未配置时 checkOrderGate 立即返回 ok，零开销，行为与从前一字不差）。

    位置刻意选在「本地校验全部通过、事务尚未开始」处：
      · 已在事务外，所以拒单**既不插订单行也不占库存**（draft/committed 都无痕迹）；
      · 已在金额/规格/数量算完之后，所以风控服务能看到真实的锁定金额（含运费）而不是请求体原文；
      · 排在限流/草稿上限/停售等本地判定之后：本地就能拒的请求不花这次外呼
        （真正的售罄与池量核算在事务内、本闸之后——它们必须与插单同事务读库存，不能提前）；
      · 在事务外也意味着这次外呼不会把 SQLite 写事务拖住（风控服务慢不该锁住全站的写）。
    应答为拒时按 fail-closed 处理（风控服务不可达/超时/应答异常同样拒单，见 src/orderGate.js），
    原因前缀标明"这是本店的风控"，不是平台/链上的拒绝。
  */
  const gate = await checkOrderGate({
    buyer: target,
    seller: owner,
    productSlug: product.slug,
    skuKey: sku.sku_key,
    quantity: qty,
    amountWei,
    cnyFen: totalFen,
    shippingFeeCnyFen: shippingFeeFen,
    note: noteText, // 刻意传了也不外发：orderGate.js 的白名单决定"发什么"，备注永不进 payload
  });
  if (!gate.ok) return fail(res, `本店风控未放行：${gate.reason}`, 403, 403);
  // 有限库存（capacity 非空）占位：事务内原子销量 +quantity（committed + qty ≤ capacity），耗尽即拒单（防并发超卖）；
  // 占位失败整体回滚，不产生草稿；不限量/池式商品（capacity 为 NULL）不占位。
  // 占位随订单生命周期释放：草稿超时取消/仲裁退款/超时释放时按 stockHold.js 单点契约回补，已成交不释放。
  // 占位（holdStock）+ 插单同事务：防进程中断造成「已占位未落单」（货被占死）或
  // 「已落单未占位」（余量虚高 → 超卖）；SAVEPOINT 嵌套（调用方若已有外层分组自动降级）
  txBegin();
  try {
    /*
      两道"免费草稿锁库存"的闸（同买家活跃草稿 ≤10、同商品合计占用 ≤99）：**必须与插单同事务**
      （源码评审 2026-09 修复）。它们原先在事务外，而闸的"读计数"与后面的"插单"之间隔着
      `await checkOrderGate(...)`（一次外部 HTTP 调用，几十毫秒）⇒ 并发请求各自读到旧计数，
      两道闸同时失效（10 张 × 99 件可以被打成群）。放进事务后由 SQLite 单写者串行保证
      "读计数 + 插单"原子，与下面池式商品的可用量核算同一个理由。
      代价：超限请求会先花掉一次风控外呼才被拒（原来在闸之前就拒），换回闸真的拦得住。
    */
    const drafts = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE buyer = ? AND status = 'draft'").get(target).c;
    if (drafts >= 10) {
      txRollback();
      return fail(res, '你的未支付草稿过多（≥10），请先完成支付或取消旧草稿后再下单');
    }
    /*
      同买家同商品未支付草稿的合计占用件数上限（2026-09 首修：sybil 免费草稿锁库存 DoS 的
      第一道闸——此前单地址可开 10 张 × 99 件 = 990 件同商品草稿占用限量额度，数地址即可
      免费锁死整仓；现按「该买家在该商品的未支付草稿占用合计 ≤ 99 件」收敛，
      单地址同商品锁库能力收窄 10 倍，同时保留"多张未支付草稿分次付款"的既有下单流）。
    */
    if (sku.capacity !== null) {
      const heldUnits = db
        .prepare(
          "SELECT COALESCE(SUM(quantity), 0) AS u FROM orders WHERE buyer = ? AND product_id = ? AND sku_key = ? AND status = 'draft'"
        )
        .get(target, product.id, sku.sku_key).u;
      if (Number(heldUnits) + qty > 99) {
        txRollback();
        return fail(res, `你对该商品的未支付草稿合计已达 ${Number(heldUnits)}/${99} 件上限——请先完成支付或取消旧草稿后再下单`);
      }
    }
    // 池式商品（digital 码池 / nft tokenId 池）可用量核算：与插单同事务 ⇒ 单写者串行下
    // 「检查 + 落单」原子，第二个并发请求必然看到第一个草稿的在途需求（修复并发草稿超卖）。
    // 口径：可用 = 未用资源 − 在途需求；在途需求 = 活动订单（draft/escrowed/shipped/disputed）
    // 尚未交付的数量（quantity − 已交付行数，按 kind 分别计 code/nft 行）。
    // 池未建（built=0）时不拦（卖家手动交付形态，与既有语义一致）。
    if (product.kind === 'digital' || product.kind === 'nft') {
      const table = product.kind === 'digital' ? 'product_codes' : 'product_nft_tokens';
      const itemKind = product.kind === 'digital' ? 'code' : 'nft';
      const built = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE product_id = ?`).get(product.id).c;
      if (built > 0) {
        const unused = db
          .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE product_id = ? AND status = 'unused'`)
          .get(product.id).c;
        const pending = db
          .prepare(
            `SELECT COALESCE(SUM(MAX(o.quantity - (
                      SELECT COUNT(*) FROM order_delivery_items d WHERE d.order_id = o.id AND d.kind = ?
                    ), 0)), 0) AS need
               FROM orders o
              WHERE o.product_id = ? AND o.status IN ${DRAFT_OR_ACTIVE_IN}`
          )
          .get(itemKind, product.id).need;
        const available = Math.max(0, unused - Number(pending || 0));
        if (available < qty) {
          txRollback();
          return product.kind === 'digital'
            ? fail(
                res,
                `该数字商品兑换码不足（未被在途订单占用的仅剩 ${available} 个，本单需 ${qty} 个）——请等待卖家补充，或先完成/取消未支付的草稿`
              )
            : fail(
                res,
                `该 NFT 商品库存不足（未被在途订单占用的仅剩 ${available} 枚，本单需 ${qty} 枚）——请等待卖家补充，或先完成/取消未支付的草稿`
              );
        }
      }
    }
    // 占位成功与否是决定 hold_qty 的唯一依据：限量商品占位成功 → hold_qty=quantity（随行记账，
    // 供释放/恢复使用）；不限量/池式商品（capacity NULL）不占位 → hold_qty=0
    let held = false;
    if (sku.capacity !== null) {
      if (!holdStock(product.id, sku.sku_key, qty)) {
        txRollback();
        return fail(res, '所选规格已售罄');
      }
      held = true;
    }
    db.prepare(
      `INSERT INTO orders
        (id, product_id, product_slug, product_snapshot, snapshot_hash, sku_key, sku_specs, buyer, seller,
         quantity, hold_qty, amount_wei, cny_fen, shipping_fee_cny_fen, bty_usdt_rate, usdt_cny_rate, status, escrow_order_id,
         timeout_blocks, shipping_name, shipping_phone, shipping_address, note, age_ack,
         invoice_needed, invoice_title, invoice_tax_no, created_at, updated_at, created_boot, created_mono)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .run(
        id, product.id, product.slug, JSON.stringify(snapshot), product.snapshot_hash,
        sku.sku_key, sku.specs_json,
        target, owner,
        qty, held ? qty : 0, amountWei, totalFen, shippingFeeFen, String(rates.btyUsdt), String(rates.usdtCny),
        orderIdHex, config.escrow.timeoutBlocks, shippingInfo.name, shippingInfo.phone, shippingInfo.address,
        noteText, product.age_restricted && ageAckAsserted ? 1 : 0,
        invoiceInfo.needed ? 1 : 0, invoiceInfo.title, invoiceInfo.taxNo, now, now,
        // 单调锚点（草稿 TTL 判据用，见 src/monotonicClock.js 与 db.js 的列说明）：
        // created_boot 让清扫器知道"这行的单调读数是不是本次运行的"，created_mono 是下单时刻的单调读数
        bootId, monotonicNow()
      );
    txCommit();
  } catch (e) {
    txRollback();
    throw e;
  }
  const order = findOrder(id);
  // 创建者视角返回（本人下单=buyer 视角、店主代下单=owner 视角），收货信息等私有字段可回显
  ok(res, orderToPublic(order, { as: me === target ? 'buyer' : 'owner' }), '订单草稿已创建，请在钱包内完成托管支付');
}));

// ── 查询 ──

/** 买家视角列表（公开；订单归属由买家地址查询，信息量不敏感） */
router.get('/', wrap(async (req, res) => {
  const { address } = req.query;
  if (!address || !isAddress(String(address))) return fail(res, '缺少 address 参数（买家地址）');
  const buyer = String(address).toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  let where = 'buyer = ?';
  const params = [buyer];
  if (req.query.status) {
    const st = String(req.query.status);
    if (!ORDER_STATUS.includes(st)) return fail(res, `status 无效（可选：${ORDER_STATUS.join('/')}）`);
    where += ' AND status = ?';
    params.push(st);
  }
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE ${where}`).get(...params).c;
  const rows = db
    .prepare(`SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);
  // 兑换码为敏感字段：仅当请求者携带有效登录令牌且为本单买家时可见（防未登录探码）
  const auth = optionalAuth(req);
  const orders = rows.map((o) =>
    orderToPublic(o, { as: auth && auth.address === o.buyer ? 'buyer' : null })
  );
  ok(res, { orders, total, page, pageSize });
}));

/** 店主待处理计数（卖家面板徽标：待发货/退款待处理/争议中等；单表聚合毫秒级） */
router.get('/seller/status-counts', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM orders GROUP BY status').all();
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.c]));
  // 待处理退款：与 /seller?refund=requested 筛选用同一谓词（跨 escrowed/shipped/disputed——
  // 此前漏 disputed 使徽标数 < 列表行数）
  const pendingRefund = db
    .prepare(`SELECT COUNT(*) AS c FROM orders WHERE refund_status = 'requested' AND status IN ${ACTIVE_IN}`)
    .get().c;
  // 可发货：escrowed 且有链上支付凭证（无凭证异常行不计入"待发货"——需先同步/取消）；
  // 退款冻结行不可发（/ship、batch-ship 均拒）——此前计入造成徽标虚高
  const shipReady = db
    .prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'escrowed' AND paid_tx_hash IS NOT NULL AND refund_status != 'requested'")
    .get().c;
  const pendingDispute = byStatus.disputed || 0;
  // P 评审扩展（卖家待办聚合）：退货回收 / 待回复评价 / 低库存
  const pendingReturns = db.prepare("SELECT COUNT(*) AS c FROM order_returns WHERE status IN ('open','shipped')").get().c;
  const returnsToConfirm = db.prepare("SELECT COUNT(*) AS c FROM order_returns WHERE status = 'shipped'").get().c;
  const pendingReviewReply = db
    .prepare(
      "SELECT COUNT(*) AS c FROM reviews r JOIN orders o ON o.id = r.order_id WHERE r.reply_content = '' AND o.status IN ('confirmed','settled','expired')"
    )
    .get().c;
  // 低库存按「商品」计数：任一组合余量 ≤ 商品级阈值即计入（卖家务必要一并看那些组合）
  const lowStockProducts = db
    .prepare(
      `SELECT COUNT(DISTINCT s.product_id) AS c
         FROM product_skus s
         JOIN products p ON p.id = s.product_id
        WHERE s.capacity IS NOT NULL AND p.stock_alert_at IS NOT NULL
          AND (s.capacity - s.committed) <= p.stock_alert_at`
    )
    .get().c;
  ok(res, { byStatus, shipReady, pendingRefund, pendingDispute, pendingReturns, returnsToConfirm, pendingReviewReply, lowStockProducts });
}));

/** 店主批量发货（P1-②：实物同物流单号；仅 physical ∧ escrowed ∧ 有凭证 ∧ 非退款冻结）。
 *  预校验全量（任一不符列 failed 原因，不半写）；成功的逐单发 order.shipped 通知。 */
router.post('/seller/batch-ship', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const ids = [...new Set((req.body?.ids || []).map((x) => String(x)).filter(Boolean))];
  if (!ids.length) return fail(res, 'ids 需为订单 id 数组（1..50）');
  // 超限直接拒绝而非静默截断——跨页勾选 >50 时截断会让卖家误以为全部已发（卖家侧审计 ①）
  if (ids.length > 50) return fail(res, `单次批量发货最多 50 单（当前勾选 ${ids.length} 单）：请减少勾选后分批提交`);
  const trackingNo = String(req.body?.trackingNo ?? '').trim().slice(0, 100);
  // 空单号允许（= 自提/线下交付，与单发 POST /:id/ship 同口径，复查批2发现此前硬拒与 UI
  //「可留空表示自提/线下交付」矛盾）；写空串 + shipped_at 发货标记维持已交付判定

  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM orders WHERE id IN (${marks})`).all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const failed = [];
  const okIds = [];
  for (const id of ids) {
    const o = byId.get(id);
    if (!o) {
      failed.push({ id, reason: '订单不存在' });
      continue;
    }
    let snap = {};
    try {
      snap = JSON.parse(o.product_snapshot || '{}');
    } catch {
      snap = {};
    }
    if (snap.kind !== 'physical') failed.push({ id, reason: `非实物商品（kind=${snap.kind || '?'}），不支持批量发货` });
    else if (o.status !== 'escrowed') failed.push({ id, reason: `状态(${o.status})非待发货` });
    else if (!o.paid_tx_hash) failed.push({ id, reason: '缺少链上支付凭证，请先同步或取消' });
    else if (o.refund_status === 'requested') failed.push({ id, reason: '退款申请待处理（冻结），请先处理' });
    else okIds.push(id);
  }
  if (okIds.length) {
    const now = Date.now();
    const upMarks = okIds.map(() => '?').join(',');
    db.prepare(`UPDATE orders SET status = 'shipped', tracking_no = ?, shipped_at = ?, updated_at = ? WHERE id IN (${upMarks}) AND status = 'escrowed'`)
      .run(trackingNo, now, now, ...okIds);
    for (const id of okIds) notify('order.shipped', id); // 逐单通知（P0-3 语义）
  }
  audit(req, 'order.batch_ship', 'order', okIds.join(',') || '-', { shipped: okIds.length, failed: failed.length });
  ok(res, { shipped: okIds, failed }, okIds.length ? `已批量发货 ${okIds.length} 单` : '无符合批量发货条件的订单');
}));

/** 店主视角列表（全量订单，需店主/操作员（staff）登录；卖家面板用，码全程可见） */
router.get('/seller', staffOnly, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  let where = '1=1';
  const params = [];
  if (req.query.status) {
    const st = String(req.query.status);
    if (!ORDER_STATUS.includes(st)) return fail(res, `status 无效（可选：${ORDER_STATUS.join('/')}）`);
    where += ' AND status = ?';
    params.push(st);
  }
  // 售后维度筛选（P 评审新增）：refund=requested 直达"退款待处理"视图
  if (req.query.refund) {
    const r = String(req.query.refund);
    if (!['requested', 'rejected'].includes(r)) return fail(res, 'refund 需为 requested / rejected');
    where += ' AND refund_status = ?';
    params.push(r);
    /*
      「退款待处理」必须与 /seller/status-counts 的 pendingRefund **同一谓词**。
      只按 refund_status='requested' 筛会把**已经退完款**的单（status=refunded，
      refund_status 仍停在 requested）也拉进"待处理"，于是店主看到
      「徽标 0 / 列表 1 单」，会以为统计坏了——而真相是那单已经没有待办。
      能由店主表态的只有 escrowed / shipped / disputed 这三种状态。
    */
    if (r === 'requested') where += ` AND status IN ${ACTIVE_IN}`;
  }
  // 卖家检索买家来询时按地址/单号/商品无从查起——q 走买家地址精确/
  // 本地单号前缀/商品标题·slug 模糊；SQLite LIKE 对 UUID 前缀查询足够）
  if (req.query.q) {
    const q = String(req.query.q).trim().toLowerCase();
    if (!q) return fail(res, 'q 不能为空');
    if (q.length > 200) return fail(res, 'q 过长（≤200 字符）');
    // 转义 LIKE 通配符（%/_/转义符本身）：把检索词当字面量匹配，防 % 或 _ 被当
    // 通配符拉回全表/宽泛命中（复查 13441c5 发现；参数化已防注入，此处防通配语义）
    const esc = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
    const like = `%${esc(q)}%`;
    where += " AND (buyer = ? OR id LIKE ? ESCAPE '\\' OR product_slug LIKE ? ESCAPE '\\' OR product_snapshot LIKE ? ESCAPE '\\')";
    params.push(q, like, like, like);
  }
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE ${where}`).get(...params).c;
  const rows = db
    .prepare(`SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);
  ok(res, { orders: rows.map((o) => ({ ...orderToPublic(o, { as: 'owner' }), poolEmpty: isPoolEmpty(o) })), total, page, pageSize });
}));

/**
 * 店主收款流水：已入账（买家确认/仲裁判付/超时释放）订单汇总 + 分页列表（需 owner 登录）。
 * summary 金额在 JS 侧 BigInt 累加——SQLite SUM 对 TEXT 金额/超 2^53 分会丢精度。
 * 入账时间取订单 updated_at（最后一次状态迁移时刻，由 watcher/同步写入）。
 */
router.get('/seller/ledger', ownerOnly, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const marks = INCOME_STATUS.map(() => '?').join(',');
  const db = getDb();
  // 平台费口径（契约层 2026-09 起**按单**）：合约只读订单**创建时**快照的收费方
  //（orders.fee_collector_at_create，见 src/fees.js），全局 feeCollector 只作快照缺失时的兜底
  // 与前端披露。这里仍 await 一次刷新：兜底口径与 feeSt 披露都要它（读不到则 known=false=保守）。
  await refreshFeeCollector();
  const feeSt = feeStatus();

  // 可选入账时间范围（?from=ms&to=ms，入账口径 = 订单 updated_at 末次状态迁移时刻）。
  // 非法/NaN/负值/from>to 此前静默忽略或空集，改为显式业务拒绝
  const range = [];
  const rangeParams = [];
  const rawFrom = req.query.from;
  const rawTo = req.query.to;
  const fromMs = rawFrom === undefined || rawFrom === '' ? null : parseInt(rawFrom, 10);
  const toMs = rawTo === undefined || rawTo === '' ? null : parseInt(rawTo, 10);
  if (fromMs !== null && (!Number.isFinite(fromMs) || fromMs <= 0)) return fail(res, 'from 需为毫秒时间戳');
  if (toMs !== null && (!Number.isFinite(toMs) || toMs <= 0)) return fail(res, 'to 需为毫秒时间戳');
  if (fromMs !== null && toMs !== null && fromMs > toMs) return fail(res, 'from 不得晚于 to');
  if (fromMs !== null) {
    range.push('updated_at >= ?');
    rangeParams.push(fromMs);
  }
  if (toMs !== null) {
    range.push('updated_at <= ?');
    rangeParams.push(toMs);
  }
  const rangeSql = range.length ? ` AND ${range.join(' AND ')}` : '';

  // 汇总：仅扫金额相关列，避免全表字段开销。金额在 JS 侧 BigInt 累加——
  // SQLite SUM 对 TEXT 金额/超 2^53 分会丢精度。
  // 净额口径（与链上 Escrow._settle 一致，2026-09 起支持部分退款/拆分裁决）：
  //   卖家结算基数 = amount − refunded_amount_wei（已退买家的部分不参与结算、也不计费）
  //   平台费       = feeChargeableForOrder(fee_collector_at_create) ? 基数 × fee_bps/10000 : 0
  //                  ——**按单**判据：合约只读创建订单时的收取方快照（全局 feeCollector() 事后
  //                  可改，用它会让在途单的费口径与链上相反），快照为空才退回全局保守口径。
  //   实收净额     = 基数 − 平台费
  // refunded_amount_wei 由 watcher/sync/paid 从链上 getOrder 补录；fee_collector_at_create 同批补录。
  const incomeRows = db
    .prepare(
      `SELECT status, amount_wei, cny_fen, fee_bps, fee_collector_at_create, refunded_amount_wei FROM orders WHERE status IN (${marks})${rangeSql}`
    )
    .all(...INCOME_STATUS, ...rangeParams);
  const byStatus = {};
  let totalCount = 0;
  let cnyFen = 0;
  let amountWei = 0n;
  let feeWei = 0n;
  let refundedWei = 0n;
  for (const r of incomeRows) {
    const refunded = BigInt(r.refunded_amount_wei || '0');
    const base = BigInt(r.amount_wei || '0') - refunded;
    const fee = feeOf(base > 0n ? base : 0n, Number(r.fee_bps || 0), r.fee_collector_at_create);
    const s = (byStatus[r.status] ??= { count: 0, cnyFen: 0, amountWei: '0', feeWei: '0', refundedWei: '0', amountWeiNet: '0' });
    s.count += 1;
    s.cnyFen += r.cny_fen;
    s.amountWei = (BigInt(s.amountWei) + BigInt(r.amount_wei)).toString();
    s.feeWei = (BigInt(s.feeWei) + fee).toString();
    s.refundedWei = (BigInt(s.refundedWei) + refunded).toString();
    s.amountWeiNet = (BigInt(s.amountWei) - BigInt(s.refundedWei) - BigInt(s.feeWei)).toString();
    totalCount += 1;
    cnyFen += r.cny_fen;
    amountWei += BigInt(r.amount_wei);
    feeWei += fee;
    refundedWei += refunded;
  }

  const rows = db
    .prepare(`SELECT * FROM orders WHERE status IN (${marks})${rangeSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...INCOME_STATUS, ...rangeParams, pageSize, offset);
  ok(res, {
    orders: rows.map((o) => {
      const refunded = BigInt(o.refunded_amount_wei || '0');
      const base = BigInt(o.amount_wei || '0') - refunded;
      // 平台费按**该单**的创建时收取方快照判定（见 src/fees.js / 上方汇总段说明）
      const fee = feeOf(base > 0n ? base : 0n, Number(o.fee_bps || 0), o.fee_collector_at_create);
      const pub = orderToPublic(o, { as: 'owner' });
      return {
        ...pub,
        feeBps: o.fee_bps || 0,
        feeWei: fee.toString(),
        refundedWei: refunded.toString(),
        /** 实收净额 = 托管额 − 已退买家 − 已扣平台费（与链上划款一致） */
        amountWeiNet: (BigInt(o.amount_wei || '0') - refunded - fee).toString(),
      };
    }),
    total: totalCount,
    page,
    pageSize,
    summary: {
      count: totalCount,
      cnyFen,
      amountWei: amountWei.toString(),
      feeWei: feeWei.toString(),
      refundedWei: refundedWei.toString(),
      amountWeiNet: (amountWei - refundedWei - feeWei).toString(),
      byStatus,
      // 费率披露口径（全局兜底 + 前端标注）：只有"本单没有创建时快照"的行才依赖 feeCollector；
      // feeCollectorKnown=false（RPC 读不到/新合约已移除该全局函数）时按 feeBps 折算并标注为
      // 「预计」——前端据此在「已扣平台费 / 预计平台费」之间选文案，不再无条件声称"已扣"。
      // 逐单的权威判定在订单 DTO 的 feeCollectorAtCreate / feeChargeable 上。
      ...feeSt,
    },
  });
}));

/** 平台费折算见 src/fees.js（唯一实现：**按单**的创建时收费方快照决定扣不扣，快照缺失退回全局兜底） */

/** 订单详情（公开只读；码仅对买家本人/店主/链上仲裁人可见；售后陈述同码可见矩阵） */
router.get('/:id', wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const auth = optionalAuth(req);
  const owner = (config.shop.owner || '').toLowerCase();
  let as = null;
  if (auth) {
    if (auth.address === order.buyer) as = 'buyer';
    else if (isStaff(auth.address)) as = 'owner';
    // 争议裁决证据开放：仅 disputed 单对仲裁人开码（正常在途单的交付码不属于裁决证据，
    // 仲裁人无查看必要——收紧隐私面；配置/RPC 失败则 null，不开放）
    else if (order.status === 'disputed' && auth.address === (await getArbiterAddress())) as = 'arbiter';
  }
  const body = { ...orderToPublic(order, { as }), poolEmpty: isPoolEmpty(order) };
  // 售后/争议陈述（dispute_evidence 时间线）：当事人（买家/店主）与争议裁决人（arbiter）可见，
  // 匿名/第三人不可见——陈述属私人交易上下文，不随公开字段泄露；按 id 升序即时间线顺序。
  // 读取侧限行（见 EVIDENCE_DETAIL_LIMIT）：取**最近** 100 条后再升序返回，附件元数据一次批量查
  // （filesOfEvidenceMany），不再逐行 filesOfEvidence（N+1）。
  if (as) {
    const total = getDb().prepare('SELECT COUNT(*) AS c FROM dispute_evidence WHERE order_id = ?').get(order.id).c;
    const rows = getDb()
      .prepare('SELECT id, role, phase, content, created_at FROM dispute_evidence WHERE order_id = ? ORDER BY id DESC LIMIT ?')
      .all(order.id, EVIDENCE_DETAIL_LIMIT)
      .reverse();
    const filesByEvidence = filesOfEvidenceMany(rows.map((e) => e.id));
    body.evidence = rows.map((e) => ({
      id: e.id,
      role: e.role,
      phase: e.phase,
      content: e.content,
      createdAt: e.created_at,
      // 争议陈述内容哈希（ARCHITECTURE.md §2.3）：可上链存证防节点删改
      contentHash: evidenceContentHash(order.id, e.role, e.content),
      files: filesByEvidence.get(e.id) || [], // 附件元数据（下载走鉴权接口，见 routes/evidenceFiles.js）
    }));
    /** 陈述总条数（不受展示上限影响）+ 是否被截断——前端据此显示"仅展示最近 N 条" */
    body.evidenceCount = total;
    body.evidenceTruncated = total > rows.length;
  }
  ok(res, body);
}));

// ── 状态推进 ──

/**
 * 买家支付完成确认：校验交易收据（接收方 == 托管合约 且含本订单 OrderCreated 日志）
 * 后置为 escrowed。即使不调用本接口，escrowWatcher 也会在轮询到事件时自动回写。
 * 支付 txHash 唯一性：落库值一律取收据规范哈希（BTY 双哈希归一，见 verifyPaidReceipt），
 * 同一规范哈希不得确认两单（预检 + 唯一索引 idx_orders_paid_tx 双保险）。
 */
router.post('/:id/paid', requireAuth, paidLimiter, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  if (order.buyer !== req.auth.address) return fail(res, '仅买家本人可确认托管支付', 403, 403);
  const txHash = String(req.body?.txHash || '');
  const txHashValid = /^0x[0-9a-fA-F]{64}$/.test(txHash);
  if (txHash && !txHashValid) return fail(res, 'txHash 格式无效');

  if (order.status === 'escrowed' || order.status === 'shipped') {
    // 幂等（watcher 已回写/自动交付已完成/重复确认）：托管已确认（escrowed/shipped 均为链上
    // OrderCreated 已落定的镜像）——历史订单未落支付哈希时，带 txHash 则校验后补记规范哈希；
    // 校验失败/哈希冲突仅告警——状态已是事实，链上凭证以事件史（watcher 回写）为准
    if (txHashValid && !order.paid_tx_hash) {
      const v = await verifyPaidReceipt(order, txHash);
      if (v.ok) {
        const r = notePaidTxHash(order, v.canonicalHash);
        if (r && r.error === 'taken') {
          console.warn(`[paid] 补记支付哈希被占用（order=${order.id}，hash=${v.canonicalHash.slice(0, 18)}…）——该支付已确认过另一订单`);
        }
      }
    }
    ok(res, { id: order.id, status: order.status }, '托管已确认');
    return;
  }
  if (order.status === 'cancelled') {
    // 草稿超时被清扫/手动取消后链上支付才落定：watcher 轮询到 OrderCreated 会按同规则自动恢复
    // （金额/卖家/买家匹配 + 重新占位），无需手动取消再下单
    return fail(res, '该订单已取消；若你已完成链上托管支付，节点将在检测到链上托管事件后自动恢复该订单（或稍后对该订单执行「同步链上状态」）');
  }
  if (order.status !== 'draft') return fail(res, `当前状态(${order.status})不可确认支付`);
  if (!txHashValid) return fail(res, '缺少支付交易哈希 txHash');

  const v = await verifyPaidReceipt(order, txHash);
  if (!v.ok) {
    // 诊断链上同 orderId 是否已被"假托管"抢先占用：orderId 自草稿起公开（GET /api/orders
    // 返回 escrowOrderId），攻击者可对该 orderId 以 1 wei 链上建单（金额/卖家/买家与本地
    // 不符 → paid/watcher 忽略但链上槽位被永久占位），真实付款将始终 OrderExists revert。
    // 检出后给可行动的提示（取消重下，UUID 换新 orderId 即绕开）。
    let hint = '';
    try {
      const onchain = await fetchOnchainOrder(order.escrow_order_id);
      if (onchain.status !== 'None') {
        hint =
          '；链上已存在同单号托管单但与本地参数不符（金额/卖家/买家任一不一致），疑似被他人抢先占位——请取消该草稿并重新下单，勿再对该草稿支付（若已转出资金请按链上记录方核对）';
      }
    } catch {
      /* RPC 不可达：维持原错误提示 */
    }
    return fail(res, v.message + hint);
  }

  // 同一笔链上支付只能确认一个订单（v2 一单一号 UUID orderId，防重由草稿层 UUID 保证；
  // 唯一索引兜底并发与存量异常）
  const db = getDb();
  const taken = db.prepare('SELECT id FROM orders WHERE paid_tx_hash = ? AND id != ?').get(v.canonicalHash, order.id);
  if (taken) {
    return fail(res, '该支付交易已确认过另一订单（同一笔链上托管只能确认一单），如重复下单请先取消旧订单');
  }
  // draft 迁移前复核链上当前状态——收据只证明「曾发生本单 OrderCreated」，不证明
  // 当前仍 Created。若链上已终局（Refunded/Settled——仲裁判退/卖家已退款/超时释放判卖）或已
  // 争议（Disputed），本地仍 draft 属事件漏扫竞态，把草稿推进为 escrowed 会复活一笔资金早已
  // 定局的单并可能自动发码（已退款买家免费得码）。RPC 不可达时不阻断（收据校验已通过、
  // watcher/sync 稍后纠正），仅尽力复核。退款申请待决（status=Created 且 refundRequested=true，
  // 请求不迁状态，此前漏检）同样不得自动发码——迁移照常（镜像），发码让位于
  // 冻结守卫（curRefundPending 传给尾部）。
  let curRefundPending = false;
  try {
    const cur = await fetchOnchainOrder(order.escrow_order_id);
    const st = String(cur?.status || 'Created');
    if (st === 'Refunded' || st === 'Settled' || st === 'Disputed') {
      const label = st === 'Refunded' ? '已退款' : st === 'Settled' ? '已成交（资金已结算给卖家）' : '已进入争议（资金冻结）';
      return fail(
        res,
        `链上该托管单当前状态为「${label}」，但本地仍是未支付草稿（疑似事件漏扫/竞态）——请勿按支付确认处理；` +
          '请对该订单执行「同步链上状态」，让本地与链上终局一致（草稿占位将按终局释放）'
      );
    }
    curRefundPending = !!(cur && cur.refundRequested);
  } catch {
    /* RPC 不可达：跳过复核（收据校验已通过；watcher 会按事件纠正） */
  }
  let changed = 0;
  try {
    // 状态迁移 + 事件史补写同事务（防进程中断半写：escrowed 已推进但 OrderCreated 事件史缺失，
    // 凭证链/信誉口径永久缺里程碑）；条件 status='draft' 与 watcher 并发回写竞态时仅一方推进
    txBegin();
    try {
      changed = db
        .prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
        .run(v.canonicalHash, Date.now(), order.id).changes;
      // paid 快路径不迁移 watcher 事件（见 appendOrderCreatedEvent）：迁移成功即补写事件史，
      // 保证详情页凭证链与信誉画像口径一致（watcher 已先行记录时幂等跳过）
      if (changed === 1) appendOrderCreatedEvent(order.id, { txHash: v.canonicalHash, block: v.blockNumber });
      txCommit();
    } catch (e) {
      txRollback();
      throw e;
    }
  } catch (e) {
    if (/SQLITE_CONSTRAINT|UNIQUE constraint/i.test(String(e.code || '') + ' ' + String(e.message || ''))) {
      return fail(res, '该支付交易已确认过另一订单（同一笔链上托管只能确认一单）');
    }
    throw e;
  }
  if (changed === 0) {
    // 并发竞态：watcher 已先行回写 escrowed（paid_tx_hash 仍空）→ 补记哈希后幂等返回；
    // 也可能订单已被并发取消/清扫（cancelled）——notePaidTxHash 有意不向取消行落哈希，
    // 回查真实状态给出正确引导而非谎报"托管已确认"（审计 F2）
    const r = notePaidTxHash(order, v.canonicalHash);
    if (r && r.error === 'taken') {
      console.warn(`[paid] 补记支付哈希被占用（order=${order.id}，hash=${v.canonicalHash.slice(0, 18)}…）——该支付已确认过另一订单`);
    }
    const rowNow = db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id);
    if (rowNow && rowNow.status === 'cancelled') {
      return ok(
        res,
        { id: order.id, status: 'cancelled' },
        '该订单刚被取消（草稿超时关闭或手动取消）；你的链上托管支付已确认，节点检测到托管事件后会自动恢复该订单（或稍后对该订单执行「同步链上状态」）'
      );
    }
    ok(res, { id: order.id, status: 'escrowed' }, '托管已确认');
    return;
  }
  // 订单级 feeBps + 已退金额 + **创建时收取方**快照补录（链上 getOrder 权威；供收款流水净额/退款口径。
  // 合约按 `feeCollectorAtCreate` 决定这单扣不扣费（详见 src/fees.js），故两列必须同批落库——
  // 只写 fee_bps 会让账本退回全局口径，与这单的链上事实可能相反。
  // RPC 失败静默——费率默认 0、已退默认 '0'、收取方默认 ''（未知，账本退回保守口径），
  // 且 watcher/sync 路径会再补）
  try {
    const onchain = await fetchOnchainOrder(order.escrow_order_id);
    const snap = feeSnapshotOf(onchain);
    db.prepare('UPDATE orders SET fee_bps = ?, fee_collector_at_create = ?, refunded_amount_wei = ? WHERE id = ?').run(
      snap.feeBps,
      snap.feeCollectorAtCreate,
      String(onchain.refundedAmount || '0'),
      order.id
    );
  } catch {
    /* 忽略：fee_bps 默认 0、refunded_amount_wei 默认 '0'、fee_collector_at_create 默认 ''（未知） */
  }
  // 卡密自动交付：数字商品且码池有未用码 → 自动发码置 shipped（买家立即可见兑换码）。
  // 通知顺序：escrowed（托管成功）先于 shipped（自动交付）——与 watcher 路径一致。
  // 链上退款申请待决（curRefundPending=true）时不自动发码（本地镜像滞后窗口；watcher
  // RefundRequested 事件随后会落 requested——此前该窗口会把码发给即将退款的买家）
  notify('order.escrowed', order.id);
  const autoDelivered = curRefundPending ? false : tryAutoDeliverById(order.id);
  /*
    池式商品主动告警（2026-09）：草稿创建到支付之间池子可能被别的订单掏空，此时买家钱已上链、
    却没有可交付资源——此前只有卖家面板的 poolEmpty 标着（卖家不看就不知道）。放在自动交付
    之后判断：交付成功说明资源本来够（订单已 shipped，判定自然不成立），失败的才是真缺口。
    每单至多告警一次（poolAlert 内部 kv 标记），不阻塞响应。
  */
  alertPoolEmptyForOrder(order.id);
  ok(
    res,
    { id: order.id, status: 'escrowed', autoDelivered },
    autoDelivered ? '托管确认成功，卡密已自动交付' : '托管确认成功，等待卖家发货'
  );
}));

/**
 * 数字商品手动交付：交付文本按行解析（每行一个码/说明），行数必须 = quantity；
 * 逐行与码池联动——命中池内 unused 码事务占用（防并发重复发放），命中 used 码拒绝（防重发），
 * 池外自由文本（说明型交付）直接落子表。全部通过后置 shipped。
 * 返回 { codes } 或 { error: 'pool_empty'|'conflict'|'code_used'|'not_escrowed'|'line_mismatch', message }。
 */
function deliverDigitalManual(order, manualText) {
  const db = getDb();
  const codes = String(manualText || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  const qty = order.quantity || 1;
  if (codes.length !== qty) {
    return { error: 'line_mismatch', message: `手动交付需恰好 ${qty} 行（每行一个码/说明），实际 ${codes.length} 行` };
  }
  // 每行长度上限与码池导入一致（200 字符），防超长自由文本撑爆交付物
  const overLong = codes.findIndex((c) => c.length > 200);
  if (overLong >= 0) {
    return { error: 'line_too_long', message: `第 ${overLong + 1} 行交付内容超过 200 字符上限，请拆分或缩短` };
  }
  const now = Date.now();
  txBegin();
  try {
    const pool = db.prepare('SELECT id, status FROM product_codes WHERE product_id = ? AND code = ?');
    const claim = db.prepare("UPDATE product_codes SET status = 'used', order_id = ?, used_at = ? WHERE id = ? AND status = 'unused'");
    for (const code of codes) {
      const hit = pool.get(order.product_id, code);
      if (!hit) continue; // 池外自由文本：无联动
      if (hit.status === 'used') {
        txRollback();
        return { error: 'code_used', message: `兑换码“${code.slice(0, 24)}…”已在其他订单发放过，请更换（留空则自动从码池分配）` };
      }
      const ch = claim.run(order.id, now, hit.id).changes;
      if (ch !== 1) {
        txRollback();
        return { error: 'conflict', message: '兑换码分配冲突，请重试' };
      }
    }
    const moved = db
      .prepare("UPDATE orders SET status = 'shipped', shipped_at = ?, updated_at = ? WHERE id = ? AND status = 'escrowed'")
      .run(now, now, order.id);
    if (moved.changes !== 1) {
      txRollback();
      return { error: 'not_escrowed', message: `当前状态(${order.status})不可发货，需买家托管成功` };
    }
    const ins = db.prepare('INSERT INTO order_delivery_items (order_id, kind, value, created_at) VALUES (?, ?, ?, ?)');
    for (const code of codes) ins.run(order.id, 'code', code, now);
    txCommit();
    return { codes };
  } catch (e) {
    txRollback();
    throw e;
  }
}

/**
 * 店主发货：
 *  - 实物：写入物流单号 trackingNo（可空，兼容自提等交付方式）；
 *  - 数字：手动交付内容（deliveryCode，多行=多码）按行解析联动码池；留空则事务内从码池
 *    分配 quantity 个未用码（池不足拒绝发货）——见 deliverDigitalManual / deliverDigitalFromPool。
 *  - NFT：见 POST /:id/nft-deliveries（本接口不处理 NFT）。
 */
router.post('/:id/ship', staffOnly, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  if (order.status !== 'escrowed') return fail(res, `当前状态(${order.status})不可发货，需买家托管成功`);
  // 发货防呆（支付凭证不变量，见文件头注释）：正常路径（watcher/paid/sync）落库时必带
  // 链上规范哈希；空哈希的 escrowed 单说明从未获真实入金确认（watcher 回写窗口内的
  // 竞态/异常残留），发货将白送货物或码——先同步（/sync 会按链上创建块反查事件补落哈希）
  // 仍为空则属异常单，需店主核账（可调 /cancel 清理）。
  if (!order.paid_tx_hash) {
    return fail(
      res,
      '该订单缺少链上支付凭证（paid_tx_hash 为空），无法发货——请先对该订单执行同步补齐凭证；若同步后仍为空说明本地状态异常，可取消该单后由买家重新下单'
    );
  }
  // 两级售后门控：买家退款申请待决（链上 refundRequested，资金冻结、超时释放被禁）期间拒绝发货——
  // 发货后若卖家再同意退款将钱货两失；应先链上 rejectRefund 拒绝申请再发货，或直接 approveRefund
  if (order.refund_status === 'requested') {
    return fail(
      res,
      '买家退款申请待处理（资金冻结中）：请先在链上拒绝该退款申请（rejectRefund）后再发货，或同意退款（approveRefund）'
    );
  }
  const db = getDb();
  let snap = {};
  try {
    snap = JSON.parse(order.product_snapshot || '{}');
  } catch {
    snap = {};
  }
  const now = Date.now();

  if (snap.kind === 'nft') {
    return fail(res, 'NFT 交付请使用 POST /api/orders/:id/nft-deliveries（支持多枚/批量哈希核验）');
  }

  if (snap.kind === 'digital') {
    const manual = String(req.body?.deliveryCode || req.body?.trackingNo || '').trim();
    if (manual) {
      // 手动交付（卖家直填，按行=多码，与码池联动）
      const r = deliverDigitalManual(order, manual);
      if (r.error) return fail(res, r.message);
      notify('order.shipped', order.id); // 卖家通知：手动交付完成
      audit(req, 'order.ship', 'order', order.id, { kind: 'digital', manual: true });
      ok(
        res,
        { id: order.id, status: 'shipped', deliveries: r.codes.map((c) => ({ kind: 'code', value: c })), trackingNo: null },
        '已交付（兑换码已发送给买家）'
      );
      return;
    }
    // 码池自动分配（与卡密自动交付共用同一事务函数，防并发重复发放；按 quantity 整批）
    const r = deliverDigitalFromPool(order);
    if (r.error === 'pool_empty') {
      return fail(res, `该数字商品兑换码池未用码不足 ${order.quantity || 1} 个，请先导入码池或手动填写交付内容（每行一个）`);
    }
    if (r.error) {
      return fail(res, '兑换码分配冲突，请重试');
    }
    // 手动发货（池自动分配）审计；autoDeliver（watcher/paid 自动触发）非 staff 动作不埋
    audit(req, 'order.ship', 'order', order.id, { kind: 'digital', pool: true });
    ok(
      res,
      { id: order.id, status: 'shipped', deliveries: r.codes.map((c) => ({ kind: 'code', value: c })), trackingNo: null },
      '已发货：兑换码已从码池分配并发送给买家'
    );
    return;
  }

  // 实物：记录物流单号（数量见订单 quantity）。条件更新（status + 凭证不变量双守卫）：
  // 与数字/NFT/批量发货同规约——防并发/多进程下对已迁出 escrowed 的行误写
  const trackingNo = String(req.body?.trackingNo || '').slice(0, 100);
  const moved = db
    .prepare(
      "UPDATE orders SET status = 'shipped', tracking_no = ?, shipped_at = ?, updated_at = ? WHERE id = ? AND status = 'escrowed' AND paid_tx_hash IS NOT NULL"
    )
    .run(trackingNo, now, now, order.id);
  if (moved.changes !== 1) {
    return fail(res, `当前状态(${order.status})不可发货，需买家托管成功`);
  }
  notify('order.shipped', order.id); // 卖家通知：实物发货
  audit(req, 'order.ship', 'order', order.id, { kind: 'physical', trackingNo });
  ok(res, { id: order.id, status: 'shipped', trackingNo, deliveries: [] }, '已标记发货');
}));

/**
 * NFT 交付登记（owner；支持数量模型下的多枚/分批交付）：
 * 卖家先在钱包把池内未用 tokenId 的 NFT 转给买家地址（ERC721 单枚/ERC1155 批量均可），
 * 再提交 deliveries: [{tokenId, txHash}]——多行共享同一 txHash 表达批量转账（一个哈希多枚），
 * 多行多 txHash 表达多哈希（一枚一哈希）。节点按 txHash 分组、按商品快照锁定的
 * nft_standard 做一次集合核验（申报集合 ⊆ 收据中 from=店主 to=买家 的转移集合），通过后
 * 事务占用池行并落交付子表；累计达 quantity 自动置 shipped（部分交付保持 escrowed，进度在详情可见）。
 * 核验：tokenId 须在商品交付池未用（事务内条件占用防并发双交付同一枚）；
 * 同一订单内 tokenId 不得重复申报（每件一枚的集合语义）。
 */
router.post('/:id/nft-deliveries', staffOnly, nftVerifyLimiter, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  if (order.status !== 'escrowed') return fail(res, `当前状态(${order.status})不可登记交付，需买家托管成功`);
  if (!order.paid_tx_hash) {
    return fail(res, '该订单缺少链上支付凭证（paid_tx_hash 为空），无法交付——请先对该订单执行同步补齐凭证');
  }
  // 两级售后门控：退款申请待决期间拒绝交付登记（同 /ship，防钱货两失）
  if (order.refund_status === 'requested') {
    return fail(
      res,
      '买家退款申请待处理（资金冻结中）：请先在链上拒绝该退款申请（rejectRefund）后再交付，或同意退款（approveRefund）'
    );
  }
  let snap = {};
  try {
    snap = JSON.parse(order.product_snapshot || '{}');
  } catch {
    snap = {};
  }
  if (snap.kind !== 'nft') return fail(res, '仅 NFT 商品使用本接口交付');
  const nftContract = String(snap.nft_contract || '').toLowerCase();
  if (!isAddress(nftContract)) return fail(res, '商品快照缺少合法的 NFT 合约地址，无法核验交付');

  // 入参归一：支持 {deliveries:[...]} 与兼容单条 {tokenId,txHash}
  const body = req.body || {};
  const raw = Array.isArray(body.deliveries)
    ? body.deliveries
    : body.tokenId !== undefined
      ? [{ tokenId: body.tokenId, txHash: body.txHash }]
      : [];
  if (!raw.length || raw.length > (order.quantity || 1)) {
    return fail(res, `需提交 1..${order.quantity || 1} 条交付记录（deliveries: [{tokenId, txHash}]，批量转账可多行共享同一 txHash）`);
  }
  const items = raw.map((it, i) => ({
    tokenId: String(it?.tokenId ?? '').trim(),
    txHash: String(it?.txHash ?? '').trim(),
    _i: i,
  }));
  for (const it of items) {
    if (!/^\d+$/.test(it.tokenId)) return fail(res, `第 ${it._i + 1} 条 tokenId 非法（需十进制数字，可从 NFT 池列表复制）`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(it.txHash)) return fail(res, `第 ${it._i + 1} 条 txHash 非法（0x + 64 位 hex）`);
  }
  // 同一订单内 tokenId 不得重复（每件一枚）；交付行累计不得超 quantity
  const db = getDb();
  const tokenIds = items.map((i) => i.tokenId);
  if (new Set(tokenIds).size !== tokenIds.length) return fail(res, '同一订单内 tokenId 不得重复申报（每件对应一枚）');
  const delivered = db
    .prepare("SELECT COUNT(*) AS c FROM order_delivery_items WHERE order_id = ? AND kind = 'nft'")
    .get(order.id).c;
  if (delivered + items.length > (order.quantity || 1)) {
    return fail(res, `超量交付：本单需 ${order.quantity} 枚，已交付 ${delivered} 枚，本次 ${items.length} 枚超出剩余额度`);
  }

  // 池内未用预检（全部满足才继续核验，失败提示具体冲突 token）
  const poolStmt = db.prepare("SELECT id FROM product_nft_tokens WHERE product_id = ? AND token_id = ? AND status = 'unused'");
  const poolRows = [];
  for (const it of items) {
    const row = poolStmt.get(order.product_id, it.tokenId);
    if (!row) return fail(res, `tokenId ${it.tokenId} 不在商品交付池内或已被交付（请核对 NFT 池中的未用列表）`);
    poolRows.push(row.id);
  }

  // 集合核验（v2）：同一 txHash 一次收据匹配整组 tokenId——ERC721 同收据多笔 Transfer /
  // ERC1155 TransferBatch 批量；ERC721A 用 erc721 签名兼容。standard 取商品快照锁定的
  // nft_standard（快照契约 v1 无该键时缺省 erc721，防御性兼容）
  const nftStandard = snap.nft_standard === 'erc1155' ? 'erc1155' : 'erc721';
  const from = String(order.seller).toLowerCase();
  const to = String(order.buyer).toLowerCase();
  const grouped = new Map(); // txHash → [{tokenId, idx}]
  items.forEach((it, i) => {
    const key = it.txHash.toLowerCase();
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ tokenId: it.tokenId, idx: i });
  });
  for (const [txHash, group] of grouped) {
    const v = await verifyNftTransfersTx(txHash, nftContract, {
      standard: nftStandard,
      from,
      to,
      tokenIds: group.map((g) => g.tokenId),
    });
    if (!v.ok) return fail(res, `txHash ${txHash.slice(0, 10)}… 核验未通过：${v.reason}`);
  }

  const now = Date.now();
  txBegin();
  try {
    const claim = db.prepare("UPDATE product_nft_tokens SET status = 'used', order_id = ?, used_at = ? WHERE id = ? AND status = 'unused'");
    for (let i = 0; i < items.length; i++) {
      const ch = claim.run(order.id, now, poolRows[i]).changes;
      if (ch !== 1) {
        txRollback();
        return fail(res, `tokenId ${items[i].tokenId} 刚被其他订单占用，请刷新池列表重选`);
      }
    }
    // 事务内重读已交付行数：入口预检（delivered）可能在链上核验（await RPC）期间过期——
    // 并发请求若各自按过期计数放行，会超量交付（行数 > quantity）并因 toStatus 误判
    // 永久滞留 escrowed（此后所有交付请求都被"超量"拒绝）。事务内以真实计数收口。
    const freshDelivered = db
      .prepare("SELECT COUNT(*) AS c FROM order_delivery_items WHERE order_id = ? AND kind = 'nft'")
      .get(order.id).c;
    if (freshDelivered + items.length > (order.quantity || 1)) {
      txRollback();
      return fail(
        res,
        `超量交付：本单需 ${order.quantity} 枚，已有 ${freshDelivered} 枚交付行被并发提交，本次 ${items.length} 枚将超出额度——请刷新后按剩余额度重新登记`
      );
    }
    const ins = db.prepare('INSERT INTO order_delivery_items (order_id, kind, value, tx_hash, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const it of items) ins.run(order.id, 'nft', it.tokenId, it.txHash.toLowerCase(), now);
    // 累计达 quantity → 自动 shipped；未达保持 escrowed（部分交付，进度见详情）
    const total = freshDelivered + items.length;
    const toStatus = total >= (order.quantity || 1) ? 'shipped' : 'escrowed';
    const moved = db
      .prepare(
        "UPDATE orders SET status = ?, shipped_at = COALESCE(shipped_at, ?), updated_at = ? WHERE id = ? AND status = 'escrowed' AND refund_status != 'requested'"
      )
      .run(toStatus, now, now, order.id).changes;
    if (moved !== 1) {
      txRollback();
      return fail(
        res,
        `当前状态(${order.status})不可登记交付，或退款申请已在核验期间落地（冻结）——请刷新后确认状态再重试`
      );
    }
    txCommit();
    if (toStatus === 'shipped') notify('order.shipped', order.id); // 卖家通知：NFT 全部交付
    audit(req, 'order.nft_delivery', 'order', order.id, { tokenCount: items.length, delivered: total });
    ok(
      res,
      {
        id: order.id,
        status: toStatus,
        delivered: total,
        quantity: order.quantity || 1,
        deliveries: items.map((it) => ({ kind: 'nft', value: it.tokenId, txHash: it.txHash.toLowerCase() })),
      },
      toStatus === 'shipped'
        ? 'NFT 已全部交付：链上 Transfer 凭证已登记，买家可自证持有'
        : `NFT 已交付 ${total}/${order.quantity} 枚（部分交付），全部到齐后自动完成发货`
    );
  } catch (e) {
    txRollback();
    throw e;
  }
}));

/**
 * 提交售后/争议陈述（两级流程数据面；链上动作由钱包直调，本接口仅收理由/证据）：
 *  - phase='refund_request'：买家在链上申请退款（refund_status=requested）后提交退款理由；
 *  - phase='refund_reply'：店主回应退款申请（是否同意/协商意见，refund_status=requested 期间）；
 *  - phase='arbitration'：争议中（disputed）买卖双方各陈事实，供仲裁人裁决参考。
 * 同角色同阶段可多次追加（形成时间线）；content 1..2000 字；条数上限见 EVIDENCE_LIMIT_BY_PHASE。
 */
router.post('/:id/evidence', requireAuth, evidenceLimiter, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const phase = String(req.body?.phase || '');
  const content = String(req.body?.content ?? '').trim();
  // phase 白名单也取自唯一实现（EVIDENCE_PHASES，与 DB 的 CHECK 约束同值）——不在这里再抄一份字面
  if (!EVIDENCE_PHASES.includes(phase)) {
    return fail(res, `phase 需为 ${EVIDENCE_PHASES.join(' / ')}`);
  }
  if (!content || content.length > 2000) return fail(res, 'content 需为 1..2000 字符');
  const owner = (config.shop.owner || '').toLowerCase();
  const role = req.auth.address === order.buyer ? 'buyer' : isStaff(req.auth.address) ? 'seller' : null;
  if (!role) return fail(res, '仅本单买家或店主/操作员可提交陈述', 403, 403);
  /*
    阶段门控（**唯一实现**：`src/evidenceFiles.js` 的 `evidencePhaseError`）——与附件上传端点
    共用同一份判据。顺序是「订单状态 → 身份 → refund_status → 阶段语义」，见该函数的说明：
      ① 订单状态先判（先于 phase/refund_status）：此前只按 refund_status 判阶段、不看订单状态，
         于是「escrowed 无支付凭证（异常态）+ refund_status='requested'」的单在买家 /cancel、
         店主 erase-pii（cancelled 在可擦集里）之后**仍能继续提交陈述与附件**：擦除是"用户要求删除"，
         随后又往同一张单里写入新的个人信息（≤2000 字 × 每次 + 最多 6 附件/20MB），保留期再等 180 天。
      ② 身份不符返回 403（业务码与 HTTP 都是 403），其余是业务拒绝（HTTP 200 + code≠0）。
  */
  const phaseGate = evidencePhaseError(order, phase, role);
  if (phaseGate) return fail(res, phaseGate.message, phaseGate.code, phaseGate.http);
  // 条数上限：按 (本单, 本人角色, 本阶段) 计——单方循环提交会把时间线与裁决面淹掉（详见常量注释）
  const cap = EVIDENCE_LIMIT_BY_PHASE[phase];
  const used = getDb()
    .prepare('SELECT COUNT(*) AS c FROM dispute_evidence WHERE order_id = ? AND role = ? AND phase = ?')
    .get(order.id, role, phase).c;
  if (used >= cap) {
    return fail(
      res,
      `本单「${EVIDENCE_PHASE_LABEL[phase]}」你已提交 ${used} 条（上限 ${cap} 条）：请把补充内容并入已有陈述，或等待对方/仲裁人处理`
    );
  }
  /*
    回读刚插入的行 id：用 `lastInsertRowid`，不再用 `SELECT … ORDER BY id DESC LIMIT 1`
    （源码评审 2026-09 修复）。旧写法在**单进程同步 SQLite** 下恰好对（同一条连接、中间没有 await），
    但它靠时序巧合成立：任何人把这个区块改成异步、或在中间插一句别的 INSERT，拿到的就是**别人的行 id**
    ——随后上传的附件会挂到另一条陈述上（证据挂错人，在争议里是要命的）。
  */
  const ins = getDb()
    .prepare('INSERT INTO dispute_evidence (order_id, role, phase, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(order.id, role, phase, content, Date.now());
  const evidenceId = Number(ins.lastInsertRowid);
  // evidenceId 供前端随后上传附件（POST /:id/evidence/:evidenceId/files）
  audit(req, 'evidence.submit', 'order', order.id, { phase });
  ok(res, { orderId: order.id, evidenceId, phase, role }, '已记录，将作为卖家/仲裁人的处理依据');
}));

/**
 * 取消订单（仅未上链托管的本地态可取消）：
 *  - draft：未支付草稿（买家反悔/误下单后清理）——买家本人或店主可取消；
 *  - escrowed 但 paid_tx_hash 为空：无链上支付凭证的异常单（watcher 回写窗口内的竞态残留）——
 *    取消前先查链上：若链上已存在匹配托管（支付已上链未回写）则拒绝并引导同步恢复，防误取消真单；
 *    RPC 不可达时保留可清理语义（异常单需要出口）。
 * 已上链托管（escrowed 且有支付凭证）及以上状态不可本地取消（资金在链上，走退款申请/争议/等待
 * 超时流程）。取消为本地终态，不影响链上；释放占位库存（stockHold 单点契约），并把售后镜像
 * `refund_status` 复位为 `none`（本地终局不留"退款申请待处理"的残影，见下方 UPDATE 处说明）。
 */
router.post('/:id/cancel', requireAuth, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const owner = (config.shop.owner || '').toLowerCase();
  const isBuyer = req.auth.address === order.buyer;
  const isStaffActor = isStaff(req.auth.address);
  if (!isBuyer && !isStaffActor) return fail(res, '仅买家本人或店主/操作员可取消订单', 403, 403);

  // escrowed 无凭证异常单：取消前查链上，防止把「已支付未回写」的真单误取消（P1-3）
  if (order.status === 'escrowed' && !order.paid_tx_hash && order.escrow_order_id) {
    try {
      const onchain = await fetchOnchainOrder(order.escrow_order_id);
      if (onchain.status !== 'None') {
        const match =
          onchain.seller === String(order.seller || '').toLowerCase() &&
          onchain.buyer === String(order.buyer || '').toLowerCase() &&
          BigInt(onchain.amount || '0') === BigInt(order.amount_wei || '0');
        if (match) {
          return fail(
            res,
            '链上已存在该订单的托管记录（支付可能已上链但未回写）——请对该订单执行「同步核实」恢复状态，勿直接取消'
          );
        }
      }
    } catch {
      // RPC 不可达：无法确认链上状态，保留可清理语义（异常单需要出口）
    }
  }

  const cancellable =
    order.status === 'draft' || (order.status === 'escrowed' && !order.paid_tx_hash);
  if (!cancellable) {
    return fail(
      res,
      `当前状态(${order.status})不可取消：已上链托管的订单请通过退款申请/争议/等待超时流程处理`
    );
  }
  const db = getDb();
  // 状态置 cancelled + 占位释放同事务（防进程中断半写：状态已取消但占位未回补 → 幻影占额
  // 永久滞留；releaseHoldsForOrderIds 内部事务经 SAVEPOINT 自动降级嵌套）。
  // 条件更新防并发/重复点击：仍处于可取消态才置 cancelled
  // 售后镜像随终局一起复位（refund_status → 'none'，与 watcher/sync 的终局迁移同口径）：
  // cancelled 是本地终局，留着 requested/rejected 会让"退款申请待处理"的镜像继续存在——
  // 而依赖它的门控（如 POST /:id/evidence 的阶段判定、卖家面板退款待办）会据此对一张
  // 已取消的单继续受理售后。复位后：状态门控与镜像口径一致，取消即真的结束。
  txBegin();
  let changed = 0;
  try {
    changed = db
      .prepare(
        "UPDATE orders SET status = 'cancelled', refund_status = 'none', updated_at = ? WHERE id = ? AND (status = 'draft' OR (status = 'escrowed' AND paid_tx_hash IS NULL))"
      )
      .run(Date.now(), order.id).changes;
    if (changed === 1) releaseHoldsForOrderIds([order.id]);
    txCommit();
  } catch (e) {
    txRollback();
    throw e;
  }
  if (changed === 0) return fail(res, '订单状态已变化，请刷新后重试');
  notify('order.cancelled', order.id); // 卖家通知：买家/店主取消草稿或清理异常单
  audit(req, 'order.cancel', 'order', order.id, { by: req.auth.address === order.buyer ? 'buyer' : 'staff' });
  ok(res, orderToPublic(findOrder(order.id)), '订单已取消，库存占位已释放');
}));

/**
 * 修改收货信息（买家本人，仅 escrowed 的实物单；发货后/已退款等终局不可改）。
 * 收货信息不入快照/不影响资金锁定——纯订单数据面，改错地址的补救通道（无需取消重下）。
 * 每单最多修改 1 次（shipping_edit_count 0→1）：防买家反复改址造成卖家发货错乱/被骚扰。
 */
router.patch('/:id/shipping', requireAuth, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  if (order.buyer !== req.auth.address) return fail(res, '仅买家本人可修改收货信息', 403, 403);
  if (order.status !== 'escrowed') return fail(res, `当前状态(${order.status})不可修改收货信息——需托管成功且卖家未发货（发货/终局后不可改）`);
  if ((order.shipping_edit_count || 0) >= 1) {
    return fail(res, '该订单的收货信息已修改过一次，不可再次修改——如需更正请直接联系卖家（订单备注/店铺公告渠道）');
  }
  let snap = {};
  try {
    snap = JSON.parse(order.product_snapshot || '{}');
  } catch {
    snap = {};
  }
  if (snap.kind !== 'physical') return fail(res, '仅实物订单需要收货信息');
  const raw = {
    name: String(req.body?.name ?? '').trim().slice(0, 60),
    phone: String(req.body?.phone ?? '').trim().slice(0, 30),
    address: String(req.body?.address ?? '').trim().slice(0, 300),
  };
  const db = getDb();
  const updated = db
    .prepare(
      "UPDATE orders SET shipping_name = ?, shipping_phone = ?, shipping_address = ?, shipping_edit_count = shipping_edit_count + 1, updated_at = ? WHERE id = ? AND status = ? AND shipping_edit_count = 0"
    )
    .run(raw.name, raw.phone, raw.address, Date.now(), order.id, 'escrowed');
  if (updated.changes !== 1) {
    return fail(res, '收货信息更新冲突：该单已修改过一次或状态已变化，请刷新后重试');
  }
  ok(res, orderToPublic(findOrder(order.id), { as: 'buyer' }), '收货信息已更新（每单仅可修改一次；发货将按新地址执行）');
}));

/**
 * 按链上订单退款标记回填本地 refund_status（sync 反查用；链上为权威，事件漏扫/本地残留的兜底）：
 *  - refundRequested → 'requested'（首次申请时刻保留，重复同步幂等）
 *  - 否则 refundRejected → 'rejected'（首次拒绝时刻保留）
 *  - 两者皆无 → 本地残留标记回 'none'（链上从未申请或已重置）
 * 仅作用于 Created 镜像（本地 escrowed/shipped 未终结单及 disputed——超时直争议可带链上退款标记残留）；终态订单不触碰。返回受影响行数。
 */
export function applyRefundFlags(orderIdHex, onchain) {
  const db = getDb();
  const now = Date.now();
  const id = String(orderIdHex).toLowerCase();
  if (onchain.refundRequested) {
    return db
      .prepare(
        "UPDATE orders SET refund_status = 'requested', refund_requested_at = COALESCE(refund_requested_at, ?), updated_at = ? WHERE escrow_order_id = ? AND status IN ('escrowed','shipped','disputed') AND refund_status != 'requested'"
      )
      .run(now, now, id).changes;
  }
  if (onchain.refundRejected) {
    return db
      .prepare(
        "UPDATE orders SET refund_status = 'rejected', refund_rejected_at = COALESCE(refund_rejected_at, ?), updated_at = ? WHERE escrow_order_id = ? AND status IN ('escrowed','shipped','disputed') AND refund_status != 'rejected'"
      )
      .run(now, now, id).changes;
  }
  return db
    .prepare(
      "UPDATE orders SET refund_status = 'none' WHERE escrow_order_id = ? AND status IN ('escrowed','shipped','disputed') AND refund_status != 'none'"
    )
    .run(id).changes;
}

/**
 * 手动同步链上状态（watcher 轮询间隔外的即时刷新）。
 * 链上快照（getOrder）只有 status + refundedAmount 两个终局字段，无法区分
 * "买家确认收货 / 超时释放 / 仲裁判付"（三者都是 Settled），故终局映射一律走
 * escrowWatcher.mapChainTerminal（**唯一实现**，与事件路径/后台对账同判据）：
 * 全额退买家 → refunded，其余（含 refundedAmount=0 = 全额判卖家、仲裁拆分）→ settled。
 * 精确语义（含 `confirmed`——"买家已确认收货"这个**买家动作**）只能由真实 ReceiptConfirmed
 * 事件回写证明，本接口刻意不再产出 `confirmed`；本接口仅作兜底。
 *
 * 结算类路径（Settled/Refunded）的本地终态与 watcher 的 settleByRefundSplit **同一判据**：
 * 两处都按"退给买家的钱是否等于托管额"决定 refunded/settled，所以同一笔单走事件回写还是走
 * 本接口兜底，得到的本地状态逐字相同（此前 Settled 分支把 refundedAmount=0 落成 confirmed，
 * 与 watcher/对账的 settled 相矛盾）。
 */
router.post('/:id/sync', requireAuth, syncLimiter, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const owner = (config.shop.owner || '').toLowerCase();
  if (req.auth.address !== order.buyer && req.auth.address !== owner) {
    return fail(res, '仅买家或店主可同步该订单', 403, 403);
  }
  if (!order.escrow_order_id) return fail(res, '该订单尚未生成链上托管标识');
  if (!config.chain.escrowAddress) return fail(res, '本节点未接入托管合约（MK_ESCROW_ADDRESS 未配置）');

  const onchain = await fetchOnchainOrder(order.escrow_order_id);
  const db = getDb();
  /**
   * 本单 OrderCreated 的规范支付哈希（同步期间按创建块反查得到；未取到为 null）。
   * 提到 switch 之上是因为它有两个使用点：普通态补录（上方，带状态守卫）与
   * **cancelled 行恢复成功后的补写**（下方 Created 分支）——两者必须分开，
   * 详见补录处的注释（源码审计 2026-09 修复：写进 cancelled 行会让 watcher 永久不再恢复该单）。
   */
  let createdTxHash = null;
  // 防伪托管：链上确实存在该 orderId 的订单并不代表本单真金白银入金——事件/交易
  // 可能被同名 orderId 干扰。凡链上订单存在，必须先核对金额/卖家与本地锁定一致，
  // 否则拒绝推进（与 paid/escrowWatcher 的 OrderCreated 校验同规则）。
  if (onchain.status !== 'None') {
    // 防伪托管 + 账户一致性（与 paid/escrowWatcher 的 OrderCreated 校验同规则）：
    // 链上订单的金额/卖家/买家必须与本地锁定一致。买家比对尤其重要——他人钱包
    // 代付/伪造托管会把资金锁在他人 buyer 名下并可能误触发发货，只有 buyer 一致
    // 才是「本单买家真实入金」（Escrow 以 msg.sender 为 buyer）。
    const match =
      onchain.seller === String(order.seller || '').toLowerCase() &&
      onchain.buyer === String(order.buyer || '').toLowerCase() &&
      BigInt(onchain.amount || '0') === BigInt(order.amount_wei || '0');
    if (!match) {
      return fail(res, '链上订单的金额/卖家/买家与本单锁定不一致，疑似伪造托管或他人代付，已拒绝同步');
    }
    // 补落支付凭证：链上确存在本单托管但本地未落 paid_tx_hash（历史数据/事件漏扫）时，
    // 按链上订单创建块单块反查 OrderCreated 日志取规范哈希补录——发货防呆（空哈希拒发）
    // 因此可自动恢复。RPC 异常不阻断同步主流程（状态推进不受影响）。
    if (!order.paid_tx_hash) {
      try {
        const escrow = getEscrow();
        const logs = await escrow.queryFilter(
          escrow.filters.OrderCreated(order.escrow_order_id),
          onchain.createdAtBlock,
          onchain.createdAtBlock
        );
        if (logs.length) {
          createdTxHash = String(logs[0].transactionHash).toLowerCase();
          /*
            状态守卫与 `notePaidTxHash`（本文件上方）**逐字同口径**（源码审计 2026-09 修复）：

            **不得**把哈希写进 cancelled 行。watcher 的 OrderCreated 恢复分支以
            「`status = 'cancelled' AND paid_tx_hash IS NULL`」为前置（escrowWatcher.js）。
            旧实现在这里无条件写哈希，于是下面 `case 'Created'` 一旦因限量售罄
            `restockOrder` 失败并回滚迁移，这一单就变成「本地 cancelled + 有凭证 + 链上
            资金真实存在」三种事实并存——watcher 的自动恢复**被永久跳过**。后果是
            买家钱锁在托管合约里、页面显示「已取消」，而再没有任何自动路径能救它；
            `/paid` 那条「节点将在检测到链上托管事件后自动恢复该订单」的承诺也随之落空。
            cancelled 行的凭证改由**迁移成功那一刻**补写（见下方 Created 分支），
            迁移失败则保持无凭证，watcher 仍能按事件自动恢复。
          */
          txBegin();
          try {
            const hashChanged = db
              .prepare(
                `UPDATE orders SET paid_tx_hash = ? WHERE id = ? AND paid_tx_hash IS NULL AND status IN ${PRE_PAID_IN}`
              )
              .run(createdTxHash, order.id).changes;
            // 同步路径同补 OrderCreated 事件史（凭证链完整性/信誉口径，见 appendOrderCreatedEvent）；
            // 仅在真的写入了哈希时补（否则事件史会出现一条没有对应凭证的记录）
            if (hashChanged === 1) {
              appendOrderCreatedEvent(order.id, { txHash: createdTxHash, block: onchain.createdAtBlock });
            }
            txCommit();
          } catch (e) {
            txRollback();
            throw e;
          }
        }
      } catch {
        // 网络/节点不可达：跳过补录，watcher 后续轮询仍会按事件落库
      }
    }
    // 订单级 feeBps + **创建时收取方**快照权威补录（链上 getOrder；收款净额口径用，重复同步幂等覆盖同值）。
    // 两列同批写：合约按 feeCollectorAtCreate 判这单扣不扣费（见 src/fees.js），只补费率会让
    // 账本与链上口径漂移。快照读不到（ABI 未同步/旧节点）时 feeSnapshotOf 回空串 = 未知，不猜。
    const feeSnap = feeSnapshotOf(onchain);
    if (
      feeSnap.feeBps !== Number(order.fee_bps || 0) ||
      feeSnap.feeCollectorAtCreate !== String(order.fee_collector_at_create || '')
    ) {
      db.prepare('UPDATE orders SET fee_bps = ?, fee_collector_at_create = ? WHERE id = ?')
        .run(feeSnap.feeBps, feeSnap.feeCollectorAtCreate, order.id);
    }
    /*
      买家「精确金额授权」的链上镜像回填（契约 2026-09 新增 acceptPartialRefund）：
      链上 `acceptedPartialRefund(orderId)` 是卖家用 approveRefund 退部分金额时的**唯一**合法取值，
      而它只由 PartialRefundAccepted 事件带到本地——事件漏挂/漏扫（节点停机、RPC 抖动、
      游标隔离）时，手动同步必须能把授权额补上，否则店主在面板上永远是"未授权"，
      只能拿一个凭空猜的数字去吃链上 RefundAmountNotAccepted 的 revert。
      读取失败（合约尚未升级/ABI 未同步/RPC 不可达）**不阻断同步**：保持本地原值，
      watcher 事件路径仍会补。⚠️ 必须在任何 txBegin 之前 await（事务区段内不得 await）；
      且只对本单链上确实存在的托管单读（status='None' 时读它没有意义）。
      落列走 applyAcceptedPartialRefund（与事件的 PartialRefundAccepted 分支**同一实现**：
      只写这一列、不动状态/updated_at、同值幂等、解析不出就不写）。
    */
    try {
      const acceptedWei = await getEscrow().acceptedPartialRefund(order.escrow_order_id);
      applyAcceptedPartialRefund(order.escrow_order_id, acceptedWei);
    } catch {
      /* 见上：读不到就保持本地原值（不写 '0'，那会抹掉面板上一条有效授权） */
    }
  }
  // 同步前状态（用于回报「是否真的发生了迁移」——源码审计 2026-09：此前无论是否变更
  // 都回「已按链上状态同步」，本地 cancelled 遇到链上 Disputed 这类 from 集未覆盖的组合
  // 一个字段没动却也报成功，前端据此展示成「已同步」误导用户）
  const statusBeforeSync = String(order.status || '');
  // 本地锁定的托管额（终局映射的比对基准；与链上 amount 比对过，见上方"防伪托管"段）
  const localAmountWei = String(order.amount_wei || '0');
  const chainRefundedWei = String(onchain.refundedAmount || '0');
  switch (onchain.status) {
    case 'Created': {
      // 误取消/草稿超时被关闭（cancelled）的单若链上确有托管（已支付未回写），
      // 恢复为 escrowed——先按逐单占位记账条件回补（restockOrder：曾占位才恢复，失败即库存
      // 在取消期间被卖完，提示人工处理）；随后 watcher 事件亦会自动完成同款恢复。
      // 注意 from 集不含 'escrowed'：SQLite 对"值未变 UPDATE"同样返回 changes=1，若含自身
      // 会把每次 sync 误判为迁移成功 → 重复推 order.escrowed 通知与噪音镜像（审计 F1）。
      const localRow = db.prepare('SELECT id, status FROM orders WHERE escrow_order_id = ?').get(order.escrow_order_id);
      // 迁移 + 恢复占位（若 cancelled）+ 镜像事件史 + 售后标记回填同事务（防半写：
      // 状态已推进而占位/事件史/标记缺失；restockOrder 内部事务经 SAVEPOINT 降级嵌套）
      txBegin();
      let movedToEscrowed = false;
      try {
        if (localRow?.status === 'cancelled') {
          if (!restockOrder(localRow.id)) {
            txRollback();
            return fail(res, '订单恢复失败：该商品库存已在取消期间被占用（限量售罄），请联系店主扩容后重试');
          }
        }
        movedToEscrowed = transition(order.escrow_order_id, ['draft', 'cancelled'], 'escrowed');
        if (movedToEscrowed) {
          /*
            支付凭证**必须在迁移成功这一刻一并补写**（源码审计 2026-09 复审，P1）。
            上面那段注释承诺"cancelled 行的凭证改由迁移成功那一刻补写（见下方 Created 分支）"，
            而本分支此前只 append 了镜像事件——凭证留空，于是：
              · `/ship` 直接拒绝（「缺少链上支付凭证…请先执行同步补齐凭证」），
                卖家按提示**再同步一次**才拿到凭证（那时状态已是 escrowed，才命中另一处守卫）；
              · 中间那句文案与 `OPS_RUNBOOK` 的"仍空则取消清理"会把人往**取消**上引，
                而这一行同时是 `/cancel` 认定的「escrowed 无凭证异常单」——RPC 抖动时真被取消，
                本地回到 cancelled 而链上资金仍在托管，此后**没有任何自动路径能救**
                （watcher 只对新日志反应、游标已越过；chainReconcile 对链上 Created 明确 action:'none'），
                最终链上超时释放会让本地落 expired 并计入卖家流水。
            守卫与另一处同款（`paid_tx_hash IS NULL`，绝不覆盖已有凭证）；
            `createdTxHash` 是上面按链上 createdAtBlock 反查 OrderCreated 日志得到的规范哈希。
          */
          if (createdTxHash) {
            db.prepare('UPDATE orders SET paid_tx_hash = ? WHERE id = ? AND paid_tx_hash IS NULL').run(
              createdTxHash,
              order.id
            );
          }
          appendSyncMirrorEvent(order.id, 'escrowed', { block: onchain.createdAtBlock });
        }
        // 两级售后标记权威回填：链上 Created 单的 refundRequested/refundRejected 直接反映
        // 买家是否已申请退款/卖家是否拒绝（事件漏扫或本地与链上不一致时以链上为准，见 applyRefundFlags）
        applyRefundFlags(order.escrow_order_id, onchain);
        txCommit();
      } catch (e) {
        txRollback();
        throw e;
      }
      if (movedToEscrowed) notify('order.escrowed', order.id); // 卖家通知：watcher 漏扫时的 sync 兜底（幂等语义同 watcher）
      break;
    }
    case 'Disputed': {
      /*
        争议推进 + 售后标记按链上真值刷新（超时直争议可带 refundRequested 残留，仲裁摘要如实展示）。
        from 集**含 cancelled**（源码审计 2026-09 对齐 watcher/对账的 `markEscrowDisputed`）：
        草稿被清扫/取消之后买家才完成支付是真实竞态，若 OrderCreated 那次扫描也漏了，
        之后争议发生时本地行会永远停在 cancelled，而链上那笔钱已被冻结——三条修复路径
        （事件/sync/对账）必须同一集合，漏一条就留下一块谁都不修的死角。
        cancelled 行取消时已释放占位，迁移无占位副作用。
      */
      txBegin();
      let movedToDisputed = false;
      try {
        movedToDisputed = transition(order.escrow_order_id, ['draft', 'escrowed', 'shipped', 'cancelled'], 'disputed');
        if (movedToDisputed) {
          appendSyncMirrorEvent(order.id, 'disputed', { block: onchain.createdAtBlock });
        }
        applyRefundFlags(order.escrow_order_id, onchain);
        txCommit();
      } catch (e) {
        txRollback();
        throw e;
      }
      if (movedToDisputed) notify('order.disputed', order.id); // 卖家通知：sync 兜底（watcher 事件漏扫时）
      break;
    }
    case 'Settled': {
      /*
        超时释放/仲裁判卖家/争议中买家撤诉放款均为链上 Settled；**仲裁拆分结算**也落链上
        Settled，所以本地终态必须按链上 refundedAmount 分岔——判据走 mapChainTerminal
        （escrowWatcher 的**唯一实现**，与事件路径 settleByRefundSplit、与后台对账
        planChainRepair 逐字同口径）：
          refundedAmount >= amount → refunded（全额退回买家）
          否则（含 0 = 全额判卖家、仲裁拆分）→ settled

        本分支**不再产生 `confirmed`**（源码审计 2026-09 收敛）：`confirmed` 的界面文案断言
        "你已确认收货"，那是买家自己的链上动作，而 getOrder 快照里没有任何字段能证明它
        （确认/超时/判付三者同为 Settled）。此前 Settled+refundedAmount=0 落 confirmed，
        与 watcher/对账对**同一个链上事实**给出的 settled 相矛盾：同一单走事件回写还是走
        /sync 兜底，买家看到的说法不同。宁可统一落 settled（文案只讲"钱已结算给商家"），
        也不猜事件名——真实 ReceiptConfirmed 事件到达时 watcher 仍会把该行推进为 confirmed。

        from 集：draft（节点停机漏扫 Created/确认事件后的残镜像——此前漏 draft，与 Refunded/
        OrderExpiredReleased 分支口径不一致，sync 静默无动作）、escrowed/shipped（普通成交）、
        disputed（撤诉/仲裁判卖家的事件漏扫兜底）、cancelled（草稿被清扫/取消后链上才终局成交——
        from 集缺口曾令其永不可迁移、卖家流水漏计；cancelled 行取消时已释放占位且从未交付，
        迁移无占位副作用）。
        迁移 + 镜像 + D1 占位回补 + 售后镜像清残留同事务（防半写：迁移成功而回补/标记缺失）。
      */
      const settledTarget = mapChainTerminal('Settled', chainRefundedWei, localAmountWei);
      txBegin();
      let movedToTarget = false;
      try {
        movedToTarget = transition(
          order.escrow_order_id,
          ['draft', 'escrowed', 'shipped', 'disputed', 'cancelled'],
          settledTarget
        );
        if (movedToTarget) {
          appendSyncMirrorEvent(order.id, settledTarget, { block: onchain.createdAtBlock });
        }
        // 拆分结算的已退金额按链上真值回填（链上 Settled 也可能是「仲裁拆分：部分退款 +
        // 部分结算」，refundedAmount 是账本净额/退款口径的唯一依据；未退款时写入 0 幂等）
        db.prepare('UPDATE orders SET refunded_amount_wei = ? WHERE escrow_order_id = ?')
          .run(chainRefundedWei, order.escrow_order_id);
        // D1：成交终局但退货已确认收货/放弃追索（received_at 非空，货已实际回到卖家侧可再售）→
        // 占位回补（watcher 同规则；本行幂等，sync 重复触发不二次扣减，见 releaseHoldsForReturnReceived）
        releaseHoldsForReturnReceived(order.escrow_order_id);
        // 链上已终结（结算给卖家）：售后镜像无意义，清残留（确认/超时/判付任一路径都可能带 prior 申请）
        db.prepare("UPDATE orders SET refund_status = 'none' WHERE escrow_order_id = ? AND refund_status != 'none'")
          .run(order.escrow_order_id);
        txCommit();
      } catch (e) {
        txRollback();
        throw e;
      }
      if (movedToTarget) {
        notify('order.settled', order.id); // 卖家通知：sync 兜底（链上 Settled 无法区分确认/超时/判付，
        // 以"资金已结算给卖家"的终局语义推送 order.settled，与 ARCHITECTURE.md §3.1.1 口径一致；
        // 拆分结算的买家侧说明看订单详情的「已退买家」一行）
      }
      break;
    }
    case 'Refunded': {
      // 全额退款（仲裁判退 / 卖家 approveRefund 全额和解）：迁移到 refunded 后按「仅未交付行释放」
      // 回补占位（stockHold.releaseRefundedEscrow：已交付后退款视为货在买家侧需线下回收，
      // 不自动回补——与 shipped→expired 不释放同口径）。
      // 目标状态同样由 mapChainTerminal 决定（不再硬写字符串）：链上 Refunded 恒为全额退买家，
      // 该函数返回 'refunded'；走同一函数保证"改判据时两处一起改"（见 mapChainTerminal 说明）。
      // from 集含 cancelled（草稿被清扫/取消后才终局退款——cancelled 行取消时已
      // 释放占位，releaseRefundedEscrow 幂等无副作用）。迁移 + 释放 + 镜像 + 标记同事务。
      const refundedTarget = mapChainTerminal('Refunded', chainRefundedWei, localAmountWei);
      txBegin();
      let movedToRefunded = false;
      try {
        movedToRefunded = transition(order.escrow_order_id, ['draft', 'escrowed', 'shipped', 'disputed', 'cancelled'], refundedTarget);
        if (movedToRefunded) {
          releaseRefundedEscrow(order.escrow_order_id);
          appendSyncMirrorEvent(order.id, refundedTarget, { block: onchain.createdAtBlock });
        }
        // 已退金额按链上真值回填（全额退款时 = amount；仍有退款则账本据此扣减）
        db.prepare('UPDATE orders SET refunded_amount_wei = ? WHERE escrow_order_id = ?')
          .run(chainRefundedWei, order.escrow_order_id);
        // 终态：售后标记回 none（订单状态已表达退款结果，陈述时间线仍在 evidence 中可溯）
        db.prepare("UPDATE orders SET refund_status = 'none' WHERE escrow_order_id = ? AND refund_status != 'none'")
          .run(order.escrow_order_id);
        txCommit();
      } catch (e) {
        txRollback();
        throw e;
      }
      if (movedToRefunded) notify('order.refunded', order.id); // 卖家通知：sync 兜底
      break;
    }
    default: {
      // None 表示链上无该单托管记录（草稿从未上链/单号不符）——对用户给出可行动
      // 指引而非「状态异常」的模糊报错
      if (onchain.status === 'None') {
        return fail(res, '链上无该 escrowOrderId 的托管记录（该草稿尚未上链托管，或单号核对有误——请核对凭证中的链上单号）');
      }
      return fail(res, `链上订单状态异常（${onchain.status}）`);
    }
  }
  audit(req, 'order.sync', 'order', order.id, { onchain: onchain.status }); // staff 触发的 sync 入审计（buyer 自动过滤）
  const statusAfterSync = String(findOrder(order.id)?.status || '');
  const syncMoved = statusAfterSync !== statusBeforeSync;
  ok(
    res,
    orderToPublic(findOrder(order.id), { as: req.auth.address === order.buyer ? 'buyer' : 'owner' }),
    syncMoved
      ? `已按链上状态同步（${statusBeforeSync} → ${statusAfterSync}）`
      : `本地状态与链上一致（当前 ${statusAfterSync}）——本次无需变更`
  );
}));

// ── 买家评价（P0-1：成交终局一单一评 + 店主单次回复，见 src/reviews.js 口径）──

/** 提交评价 */
router.post('/:id/review', requireAuth, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const { rating, content } = req.body || {};
  const r = submitReview({ order, buyer: req.auth.address, rating, content });
  if (r.error) return fail(res, r.error, r.forbidden ? 403 : 1, r.forbidden ? 403 : 200);
  notify('review.created', order.id); // 卖家通知：买家评价（店主可回评）
  // 响应走公共投影（匿名短地址；不回吐原始行——避免把完整 buyer/order_id 等内部列带出）
  ok(res, reviewToPublic(findReviewByOrder(order.id)), '评价成功');
}));

/** 店主回复评价（单次） */
router.post('/:id/review/reply', staffOnly, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const { content } = req.body || {};
  const r = replyReview({ order, owner: req.auth.address, content });
  if (r.error) return fail(res, r.error);
  audit(req, 'review.reply', 'order', order.id, {});
  ok(res, reviewToPublic(findReviewByOrder(order.id)), '回复成功');
}));

export default router;
