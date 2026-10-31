/**
 * 订单路由：下单草稿（锁定汇率/应付金额/orderId）→ 买家链上托管 → 状态回写闭环。
 *
 *  GET    /api/orders?address=&status=   买家视角：按买家地址查订单（公开只读）
 *  GET    /api/orders/seller?status=     店主视角：本店订单（需该店经营人员登录＝店主∪店员）
 *  GET    /api/orders/seller/ledger      店主收款流水：已入账订单汇总+列表（需 owner 登录）
 *  GET    /api/orders/:id                订单详情（公开只读）
 *  POST   /api/orders                    创建订单草稿 {productSlug, quantity?}（需登录：本人或店主代下单）
 *  POST   /api/orders/:id/paid           买家支付后确认 {txHash}（链上校验 OrderCreated 日志）
 *  POST   /api/orders/:id/ship           店主发货 {trackingNo?}（physical）/ {deliveryCode?}（digital 手动多行）
 *                                        （需该店经营人员登录；无链上支付凭证拒发）
 *  POST   /api/orders/:id/nft-deliveries NFT 交付登记 {deliveries:[{tokenId,txHash}]}（本店经营人员；支持
 *                                        多枚与批量——多行可共享同一 txHash，核验后落交付子表）
 *  POST   /api/orders/:id/cancel         取消订单：draft（买家反悔/重复下单）或 escrowed 无支付
 *                                        凭证的异常单（买家本人或本店经营人员可调）
 *  POST   /api/orders/:id/evidence       提交售后/争议陈述 {phase, content}（两级流程数据面：
 *                                        refund_request 买家理由 / refund_reply 店主回复 /
 *                                        arbitration 争议双方陈述，按阶段与订单状态校验；
 *                                        链上动作钱包直调，本接口只收理由供卖家/仲裁人参考）
 *  POST   /api/orders/:id/sync           手动向链上同步订单状态（买家/店主可调；
 *                                        顺带按链上订单创建块补落支付凭证哈希；可恢复误取消单；
 *                                        按链上退款标记回填 refund_status）
 *
 * **`:id` 恒为订单号 `orders.order_no`**（CHAR(21)，对外标识）：URL、DTO、通知、审计目标四处
 * 用的是同一个标识，而 `orders.id`（BIGINT 代理键）**一次都不出现在对外形状里**——
 * 它只用于子表外键（`order_delivery_items` / `dispute_evidence` / `reviews` / `order_returns` /
 * `evidence_files`）。读模型视图刻意把内部键命名为 `order_id`：`row.id` 于是恒为 undefined，
 * "拿内部键当对外单号"在形状上不可表达（见 db.js 的 v_orders 说明）。
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
 *   escrowed/shipped --买家 requestRefund（**仅超时前受理**，2026-10 加固 B）--> refund_status=requested
 *     │                （资金冻结、超时释放被禁；超时后合约报 RefundRequestTooLate，买家改走 requestDispute）
 *     ├--卖家 approveRefund(amount)--> refunded（**全额认赔**，不需要任何授权；全额退款时占位库存
 *     │                               按未交付行口径回补）
 *     ├--买家 acceptPartialRefund(wei) + 卖家 approveRefund(同额)--> settled
 *     │   （**双方谈拢的部分退款**：契约 2026-09 起 approveRefund 只接受「全额」或
 *     │    `acceptedPartialRefund[orderId]` 里买家**精确授权过的那个数**，其它一律
 *     │    `RefundAmountNotAccepted`（旧的 RefundNotFull 已删除）——卖家不能再单方面指定
 *     │    金额把订单结算掉；授权额镜像在 order_chain.accepted_partial_refund_wei（链上镜像表），
 *     │    DTO 下发 acceptedPartialRefundWei/Decimal 供卖家面板给出可执行金额）
 *     └--卖家 rejectRefund--> refund_status=rejected --买家 requestDispute--> disputed
 *   disputed 中卖家仍可 approveRefund 全额和解退款（或按已授权金额部分和解）。被拒后合约不接受
 *   重复申请（防无限冻结循环，见 contracts/src/Escrow.sol requestRefund）——买家下一步即发起争议。
 *   **拒绝还有一层链上后果（2026-10 加固 A）**：`rejectRefund` 会开启一段"释放静置期"
 *   （合约 releaseExpired 的 RejectGraceActive），期内任何人调 releaseExpired 都被挡回——那是买家
 *   "被拒 → 争议"的保证窗口。所以"拒绝之后超时就能收款"这句话只对**静置期已过**的单成立；
 *   链上阈值以只读函数 releaseNotBeforeBlock(orderId) 为准（前端 utils/escrowCountdown 同判据）。
 *   仲裁人可**任意比例**拆分裁决（链上 voteSettlement(orderId, refundWei) 票决：达到当届阈值的那一票
 *   执行结算，refundWei 退买家、余额扣费后给卖家，本地落 settled 并记 refunded_amount_wei）——
 *   仲裁不受"买家授权"约束。
 *   sync 按链上 getOrder 的 refundRequested/refundRejected 权威回填本地 refund_status
 *   （事件漏扫/本地残留兜底，见 applyRefundFlags），并读只读视图 acceptedPartialRefund 补授权额
 *   （事件漏扫兜底；落列逻辑与 watcher 的 PartialRefundAccepted 分支共用 applyAcceptedPartialRefund）。
 *
 * **确认收货后的售后案件**（契约 2026-10 第二批；本地判据的唯一实现在 `src/afterSale.js`）：
 *   终局（链上 Settled，货款进入售后留存期）——买家在窗口内（默认 180 天/上限 360 天，自结算块起算）
 *   链上 `openAfterSale(orderId)` 开案 --> 本地 order_chain.after_sale_status=open（**orders.status 不变**：
 *   订单仍旧是 confirmed/settled/expired）
 *     ├--双方在 `phase='after_sale'` 提交售后陈述（有在途案件时才受理，见 evidenceFiles.js）
 *     ├--卖家在留存期内主动 `refundSettled`，或仲裁人裁决后先从留存货款退买家、不足再 `Staking.penalize`
 *     └--买家 `closeAfterSale(orderId, note)` 撤诉，或委员会 `voteAfterSale(orderId, penaltyWei)` 结案
 *        --> after_sale_status=closed（**终态**：合约不允许重开；说明只随买家撤诉事件上链）
 *   它与**退款/争议**的关系（三者互不替代，别混着用）：
 *     · 确认收货后货款先进入 Escrow 售后留存期；案件在途时**不释放留存货款**，裁决优先从留存退买家，
 *       不足部分才由卖家保证金补足；
 *     · **不阻塞卖家出金**——出金下限只读链上 `Escrow.sellerOpenExposure`（退款申请/争议中的
 *       Σ amount），售后案件不计入；能追罚的口子由窗口长度限制（没有窗口就等于作废"买家点过头的单不再被追罚"）；
 *     · 它**不是** disputed：争议单资金仍在托管里、仲裁走 `Escrow.voteSettlement` 票决；案件走的是
 *       售后留存货款 + 保证金兜底。
 *   三条回填路径同源：事件（watcher 的 AfterSaleOpened/Closed）、本文件的 `/sync`
 *   （读 afterSaleOpen/afterSaleOpenedAtBlock）、后台对账（chainReconcile 的售后案件复查）——
 *   都经 `applyAfterSaleOpened`/`applyAfterSaleClosed`/`applyAfterSaleFromChain` 落列。
 *
 * 支付凭证不变量：escrowed 及以上状态必有 `order_chain.paid_tx_hash`（链上规范哈希）——
 * watcher（OrderCreated 日志 transactionHash）/paid（收据规范哈希）/sync（按创建块
 * 反查事件）三条路径落库时同步写入。该列的 UNIQUE 索引在**链上镜像表**上，
 * 所以"同一笔支付确认到两张单"由数据库挡下（NULL 可重复 = 未支付是常态）。
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
import { getDb, withTransaction, abortTx } from '../db.js';
import config from '../config.js';
import { getRates, usdtMicroToPayWei, isPayableAmount } from '../rates.js';
import { quotePaymentToken, tokenSupportedOnChain } from '../paymentTokens.js';
// 订单状态集合的唯一出处（本文件是最大的使用者：入账/在途/已付款/草稿+在途 四套集合 + 状态全集校验，
// 见 src/orderStatus.js）。本文件此前把状态全集内联抄了一份——那份抄写不在
// `test/status-set-consistency.test.js` 的射程内（它扫的是 SQL 字面量与指定模块的导出数组），
// 往枚举里加第 10 个状态时它会静默落后。
import {
  INCOME_STATUS as ORDER_INCOME_STATUS,
  ORDER_STATUS,
  PRE_PAID_IN,
  PII_ERASABLE_STATUS,
} from '../orderStatus.js';
import { verifySession, roleOf, isStaff } from '../auth.js';
// `eventsForDto`：事件史对外的唯一折算点（库里的 at 是毫秒，出口一律 ISO）
import { eventsForDto } from '../reputation.js';
import { logAudit } from '../audit.js';
import { getEscrow, getProvider, fetchOnchainOrder, finalizedBlockTag, isAddress, weiToDecimal, isArbiterForOrder } from '../chain.js';
import { deliverDigitalFromPool, tryAutoDeliverByEscrowOrder } from '../autoDeliver.js';
import { holdStock, releaseHoldsForOrderIds, releaseHoldsForReturnReceived, releaseRefundedEscrow, restockOrder } from '../stockHold.js';
// 订单状态迁移与"迁移前状态"同一把行锁（见 src/orderTransition.js）
import { claimOrderState } from '../orderTransition.js';
// 两道免费草稿闸的**加量**唯一实现（减量在 orders 上的触发器里：见 db.js 的 TRIGGER_DDL）
import { reserveDraftQuota } from '../draftQuota.js';
// 池式商品占位的**加量**唯一实现（减量同样在触发器里）
import { reservePoolUnits, poolAvailability } from '../poolQuota.js';
import { verifyNftTransfersTx } from '../nftDelivery.js';
import { newOrderId } from '../ids.js';
import { loadSkus, snapshotObject } from './products.js';
// 草稿 TTL 的单调锚点（唯一实现在 src/monotonicClock.js）：不受墙钟跳变影响的"这单过了多久"
import { bootId, monotonicNow } from '../monotonicClock.js';
import { ok, fail, wrap, bearerToken, makeAuthMiddleware, simpleRateLimit } from '../http.js';
// 金额展示口径的唯一实现（usdtOf / goodsMicroOf）——不要再手写 (micro/1e6).toFixed(2)
import { goodsMicroOf, usdtOf } from '../money.js';
import { refundUsdtMicroOfRow } from '../stats.js';
import { submitReview, replyReview, findReviewByOrder, findReviewsByOrderIds, reviewToPublic, parseReviewImages, reviewableAt, followupReview, removeReviewImage, REVIEWABLE_STATUS, reviewWriteRefusal } from '../reviews.js';
// 评价图上传：复用商品媒体的字节判定/落盘内核，但只收图片、上限更低
import { storeMediaStream, MediaUploadError, REVIEW_IMAGE_MIMES } from '../productMedia.js';
import { MEDIA } from '../mediaKinds.js';
import { UploadByteBudget } from '../uploadBudget.js';
import { fetchReturnByOrder, fetchReturnsByOrderIds, returnToPublic } from '../returns.js';
import {
  filesOfEvidenceMany,
  evidencePhaseError,
  statementFieldsOf,
  EVIDENCE_PHASES,
  EVIDENCE_LIMIT_BY_PHASE as EVIDENCE_LIMIT_BY_PHASE_OF,
  EVIDENCE_PHASE_LABEL as EVIDENCE_PHASE_LABEL_OF,
} from '../evidenceFiles.js';
// 链上终局 → 本地终态的唯一实现（事件路径与快照路径共用；见 escrowWatcher 的 mapChainTerminal）
// + 授权额落列的唯一实现（事件路径与 /sync 快照路径共用；同上）
import { mapChainTerminal, applyAcceptedPartialRefund, readRefundedWei, isCanonicalEscrowLog, markEscrowDisputed, setRefundedAmount } from '../escrowWatcher.js';
// 确认收货后的售后案件：DTO 字段与链上真值回填的**唯一实现**（watcher/对账/sync 同源）
import { afterSaleFieldsOf, isAfterSaleOpen, applyAfterSaleFromChain } from '../afterSale.js';
// 售后案件的链上只读读数 + **交付闸**（可注入；三个手动交付入口与自动交付共用同一个判据，
// 见 chainOrder.js 的 deliveryGate 说明）
import { fetchAfterSaleCase, deliveryGate, chainParamsMatch, orderCreatedMatches, fetchOrderFor } from '../chainOrder.js';
import { notify } from '../webhook.js';
// 下单风控闸（可选，默认关闭）：店主自配的建单前准入服务——见 orderGate.js 的边界说明
import { checkOrderGate } from '../orderGate.js';
// 池式商品「已收款但无货可交」：判定口径与主动告警都在 poolAlert.js（唯一实现）——
// 面板 poolEmpty 与托管落定后的 order.pool_empty webhook 用同一个 poolShortfallOf，
// 避免"面板说缺货但没告警"这类两处口径漂移
import { isPoolEmpty, alertPoolEmptyForOrder } from '../poolAlert.js';
// 承运方名称的归一（trim/控制字符/上限/空串→null）：三个发货/退货写入入口共用的唯一实现
import { normalizeCarrier } from '../shipping.js';
// 卖家待办计数（**唯一实现**）：本文件的徽标端点与 /api/shop/metrics 读同一份谓词与 SQL
import { sellerTodoCounts } from '../opsMetrics.js';
// 店铺判据（"能不能卖"的唯一实现）：下单闸与商品闸共用同一份文案
import { sellableError, shopRowByCode, shopRowsByCodes, productSellableSql } from '../shops.js';
import { findOrderInShop } from '../orderScope.js';
import { sellerOrderFilters } from '../sellerOrderFilters.js';

const router = Router();

/*
  公开读的预算：这两个端点无鉴权、且每行要取评价/退货/店铺/交付行（N+1），另外详情页
  在争议/售后单上还会强制读链上委员会。没有限流时，一个匿名 IP 就能用巨大 OFFSET + 并发
  把只有 10 条连接的 DB 池、事件循环与 RPC 配额一起打满（watcher/写请求也被拖住）。
  限流放在**路由入口**（与既有 limiter 同款单进程滑动窗口），并给 offset 一个硬上限。
*/
const publicListLimiter = simpleRateLimit({ windowMs: 60_000, max: 120, message: '订单列表查询过于频繁，请稍后再试' });
const publicDetailLimiter = simpleRateLimit({ windowMs: 60_000, max: 240, message: '订单详情查询过于频繁，请稍后再试' });

const requireAuth = makeAuthMiddleware(verifySession);
const ownerOnly = makeAuthMiddleware(verifySession, { ownerOnly: true });
const nodeAdmin = makeAuthMiddleware(verifySession, { nodeAdmin: true });
const staffOnly = makeAuthMiddleware(verifySession, { staffOnly: true }); // P1-⑤：经营面=店主+操作员
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
// 评价图上传：按 IP 20/分，再按买家地址给 200MB/小时（同一人换 IP 仍受额度约束）
const reviewImageLimiter = simpleRateLimit({ windowMs: 60_000, max: 20, message: '评价图上传过于频繁，请稍后再试' });
const REVIEW_IMAGE_MAX_BYTES = Math.max(...REVIEW_IMAGE_MIMES.map((m) => MEDIA[m].maxBytes ?? 0));
const reviewImageBudget = new UploadByteBudget({ limitBytes: 200 * 1024 * 1024 });

/**
 * 管理审计便捷包装（仅 staff 记录，buyer 动作自动过滤）。
 *
 * `shopCode` **必给**：这一行归哪家店，由**订单自己**回答（`order.shop_code`）。
 * ⚠️ 调用点必须传**订单那一行的** `shop_code`，不要传 `req.shop.code`：两者在走
 * `findOrderInShop` 的入口上恒等，但**不是所有入口都走它**——`/sync` 同时服务买家
 * （买家不带店铺头）与多店经营人员，用的是 `findOrder(orderNo)`，于是请求头里的店
 * 与订单所属的店可以是两家。传请求头会把审计行记到**别家店**的列表里
 * （动作作用在 B 店的单上、A 店店主在自己的审计列表里看到它）。订单行是唯一能表达
 * "这一行归谁看"的值。
 * **刻意不给默认值**：
 * 旧签名缺省 `''`，而 `roleOf(addr, '')` 恒为 `'user'`、logAudit 对 `'user'` 直接 return——
 * 于是这 9 个调用点**一条审计都没落过**（实测：发货 200、状态已改、audit_logs 空表），
 * 日志里一个字都没有，而前端还挂着 order.ship / order.cancel 这些动作的中文标签。
 * 没有默认值之后，"忘了给"传进去的是 `undefined`，logAudit 当场抛错（响亮）。
 * ⚠️ `roleOf` 是 async（要读店铺行与店员白名单），所以本包装也是 async：调用方**必须 await**。
 */
const audit = async (req, action, targetType, targetId, detail, shopCode) =>
  logAudit({
    req,
    actor: req.auth?.address,
    actorRole: req.shop?.code === shopCode && req.shopRole && req.shopRole !== 'user'
      ? req.shopRole
      : await roleOf(req.auth?.address || '', shopCode),
    shopCode,
    action,
    targetType,
    targetId,
    detail,
  });

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
 * 写入侧已按 (角色×阶段) 限条——退款理由/回复各 10、仲裁陈述与售后陈述各 20——所以最坏情况
 * （一单先走完争议、终局后又被开售后案件）是 10+10+20+20+20+20 = 100 条，正好等于本上限；
 * 再多只可能是老版本无上限时期写下的脏数据。详情页对每行都要拼附件元数据，
 * 行数无界就是一次 O(N) 的查询放大（原实现还是逐行 filesOfEvidence 的 N+1）。
 * 超出的行不丢：`evidenceCount` 给总数、`evidenceTruncated` 置真，前端据此提示"仅展示最近 N 条"。
 */
const EVIDENCE_DETAIL_LIMIT = 100;

/** 已成交状态（确认收货 / 仲裁判付 / 超时释放）；确认收货的货款可能仍在售后留存期 */
const INCOME_STATUS = ORDER_INCOME_STATUS; // 唯一出处：src/orderStatus.js（看板/CSV/可评价同源）

/** 买家侧兑换码可见状态（卖家已交付；退款/取消后码隐藏） */
const DELIVERED_STATUS = ['shipped', 'confirmed', 'settled', 'expired', 'disputed'];

/** 可选鉴权：解析 Bearer（缺失/无效返回 null，不拦截）——用于码等敏感字段的"登录本人可见"渐进展示 */
async function optionalAuth(req) {
  try {
    const token = bearerToken(req);
    return token ? await verifySession(token) : null;
  } catch {
    return null;
  }
}

/** 按**订单号**读整单：走读模型视图 v_orders（订单事实 + 个人信息 + 链上镜像一次读全）。 */
async function findOrder(orderNo) {
  return await getDb().get('SELECT * FROM v_orders WHERE order_no = ?', String(orderNo || ''));
}

// poolEmpty 提示（列表/详情字段）口径见 src/poolAlert.js：与托管落定后的 order.pool_empty
// 告警共用同一实现（池式商品不限量、下单不占位，故只提示不拦截）。

/**
 * 订单列表的**批量关系预取**：本页所有订单一次读回交付行/评价/退货单/店铺，
 * 把 `orderToPublic` 从 4×N 次查询降成固定 4 次（N ≤ pageSize）。
 *
 * 为什么放在这里而不是每个列表各写一遍：详情/单条路径仍走单个 reader；
 * 列表路径只有这一处预取入口，新增列表用例必须经过它（否则 N+1 会悄悄回来）。
 */
async function preloadOrderRelations(rows) {
  const ids = [...new Set(rows.map((o) => String(o.order_id)))];
  const codes = [...new Set(rows.map((o) => String(o.shop_code || '')).filter(Boolean))];
  const db = getDb();
  const idPh = ids.map(() => '?').join(',');
  const [deliveryRows, reviews, returns, shops] = await Promise.all([
    ids.length
      ? db.all(`SELECT order_id, kind, value, tx_hash, created_at FROM order_delivery_items WHERE order_id IN (${idPh}) ORDER BY id ASC`, ...ids)
      : [],
    findReviewsByOrderIds(ids),
    fetchReturnsByOrderIds(ids),
    shopRowsByCodes(codes),
  ]);
  const deliveries = new Map();
  for (const r of deliveryRows) {
    const k = String(r.order_id);
    if (!deliveries.has(k)) deliveries.set(k, []);
    deliveries.get(k).push(r);
  }
  return { deliveries, reviews, returns, shops };
}

/** DB 行 → 对外字段（金额均字符串化防精度丢失；快照还原商品字段供买家校验）
 *  opts.as: 'owner' 店主视角 / 'arbiter' 仲裁人视角（裁决证据，码全可见）；
 *  'buyer' 买家视角（仅已交付状态可见码）；默认不暴露码。
 *  opts.byOrderNo: 该请求以**不可枚举的订单号**为键（详情路由）——草稿的 escrowOrderId
 *  据此下发；列表路由不传（按地址可枚举，见下面 escrowOrderId 的可见性判据）。
 * 交付物以 deliveries 数组输出（kind='code' 为码/说明行，kind='nft' 为 tokenId+txHash 凭证行）。
 *  async：评价行/退货单/店铺条款都要读库（异步数据层），调用方**必须 await**——
 *  漏了的话拿到的是一个 Promise，展开成 `{}` 之后所有派生字段静默变成 undefined。 */
async function orderToPublic(o, opts = {}) {
  let snapshot = {};
  try {
    snapshot = JSON.parse(o.product_snapshot || '{}');
  } catch {
    snapshot = {};
  }
  // 链上事件史：order_chain.events 是**真 JSON 列**，驱动（jsonStrings 未开，见 db.js）直接给回数组，
  // 不再 JSON.parse —— 对已解析的数组再 parse 会抛错并被下面的 try 吞掉，事件史会**静默清空**。
  // 视图的 LEFT JOIN 在链上镜像行缺席时给出 NULL（镜像行与订单同行创建，缺席只可能是人工动过库），
  // 此时按"没有事件史"下发而不是把一个 null 塞进 DTO 破坏前端的数组契约。
  // `eventsForDto`：库里的 `at` 是毫秒数（内部时长算术要先有毫秒），对外一律折成 ISO。
  const onchainEvents = eventsForDto(o.onchain_events);
  // 交付子表聚合：码可见性——店主/仲裁人始终可见（追索/裁决证据）；买家仅已交付（发货后）
  // 可见，退款/取消隐藏（码有实际兑换价值，退款后不再展示）。
  // NFT 凭证行（tokenId/txHash）不随码规则隐藏：转账凭证链上公开（任何人可查 Transfer），
  // 且买家需凭 txHash 自证持有（仲裁/申诉场景）；匿名可见不构成额外泄露（澄清，
  // 实现刻意恒可见——历史注释「同码隐藏规则」已过时）
  const rawItems = opts.preloaded
    ? (opts.preloaded.deliveries.get(String(o.order_id)) || [])
    : await getDb().all('SELECT kind, value, tx_hash, created_at FROM order_delivery_items WHERE order_id = ? ORDER BY id ASC', o.order_id);
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
    交付时刻（`Date`；JSON 出口自动是 ISO-8601，与 created_at/updated_at 同一口径）：
      · 数字 / NFT 单 = 最后一条交付行的写入时刻；
      · **实物单 = 发货时刻**（`orders.shipped_at`）——实物的交付事实就是"已发货+物流单号"，
        `order_delivery_items` 里只会有兑换码与 NFT 行，实物单一条都没有。
        早先靠给实物单补一条假交付行来让这个字段非空，结果是同一张单上物流单号出现两次；
        改成按 shipped_at 兜底之后，实物单的发货时间照样有，且数据里不再有假行。
  */
  const deliveredAt =
    rawItems.length > 0
      ? rawItems.reduce((max, it) => (it.created_at > max ? it.created_at : max), rawItems[0].created_at)
      : o.shipped_at ?? null;
  // 收货信息为买家隐私：仅买家本人/店主/仲裁人视角返回，匿名与第三人恒 null
  const shippingVisible = opts.as === 'buyer' || opts.as === 'owner' || opts.as === 'arbiter';
  // 评价标记/内容（同构输出；公开列表仅 rated 驱动入口，内容随详情视角）。
  // 订单键一律用**内部 order_id** 去挂 reviews/order_returns（子表外键就是它）。
  const reviewRow = opts.preloaded
    ? (opts.preloaded.reviews.get(String(o.order_id)) || null)
    : await findReviewByOrder(o.order_id);
  const review = reviewRow
    ? {
        rated: true,
        rating: reviewRow.rating,
        content: reviewRow.content || null,
        images: parseReviewImages(reviewRow.images),
        reply: reviewRow.reply_content || null,
        createdAt: reviewRow.created_at,
        replyAt: reviewRow.reply_at ?? null,
        followup: reviewRow.followup_at
          ? {
              content: reviewRow.followup_content || null,
              images: parseReviewImages(reviewRow.followup_images),
              at: reviewRow.followup_at,
            }
          : null,
      }
    : { rated: false, rating: null, reviewable: reviewableAt(o), images: [], followup: null };
  // 退货单（履约/追回信息，按当事人视角可见——同收货信息矩阵）
  const returnRow = opts.preloaded
    ? (opts.preloaded.returns.get(String(o.order_id)) || null)
    : await fetchReturnByOrder(o.order_id);
  const returnInfo = returnRow && shippingVisible ? returnToPublic(returnRow) : null;
  /*
    本单所属店铺的行（用于 `shop` 这一块展示字段）。
  */
  const shopRow = o.shop_code
    ? (opts.preloaded ? opts.preloaded.shops.get(String(o.shop_code)) : await shopRowByCode(o.shop_code))
    : undefined;
  return {
    /** **对外标识 = 订单号**（URL/详情/通知/审计同一个值）。内部 `orders.id` 不出现在 DTO 里。 */
    id: o.order_no,
    productSlug: o.product_slug,
    productSnapshot: snapshot,
    snapshotHash: o.snapshot_hash,
    /** 所选规格组合标识（无规格商品为空串） */
    skuKey: o.sku_key,
    /** 所选规格快照：{ 颜色:'黑', 尺寸:'65' }（下单时冻结；无规格为 {}）。
     *  `sku_specs` 是 JSON 列，驱动已解析成对象——再 JSON.parse 一次会抛错并静默变成 {}。 */
    skuSpecs: (() => {
      const v = o.sku_specs;
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    })(),
    buyer: o.buyer,
    seller: o.seller,
    /*
      店铺编号：本节点铸造的 9 位编号（订单归属的唯一键）。
      零费模型下没有"抽成条款"要随单下发——托管结算只有买家/卖家两条腿。
    */
    shopCode: o.shop_code,
    quantity: o.quantity,
    /*
      收货信息、备注、发票同住 order_shipping 一行（见 db.js 的订单三表说明）。
      PII 擦除就是**把那一行删掉**，因此视图的 LEFT JOIN 会在擦除后给出 NULL——
      这里 `?? ''` 是把"这一行没了"折成空值的**展示口径**（前端契约是字符串，不是 null），
      与"双读/兜底"无关：这一列在新形状里没有第二种表示。
    */
    shipping: shippingVisible
      ? {
          name: o.shipping_name ?? '',
          phone: o.shipping_phone ?? '',
          address: o.shipping_address ?? '',
        }
      : null,
    // 买家给卖家的订单备注：同收货信息可见矩阵（买家本人/店主/仲裁人可见，匿名与第三人恒 null）
    note: shippingVisible ? o.note ?? '' : null,
    /**
     * 未成年人禁止购买：买家在下单时点过确认（1/0）。
     * **只是留痕**——客户端断言不是年龄证明，本字段不构成授权/资格结论；
     * 商品是否属于年龄限制商品由快照里的 age_restricted 决定（买家可复算核验）。
     */
    ageAck: !!o.age_ack,
    /**
     * 发票信息（线下开票用），可见矩阵与收货信息一致：买家本人/店主/仲裁人可见，
     * 匿名与第三人恒 null（整块不下发）。
     * ⚠️ 两个来源要分清（db.js 的三表说明）：
     *   · `needed` ← `orders.invoice_needed`——**订单事实**（"买家要不要开票"），擦除**不删**它；
     *   · `title` / `taxNo` ← `order_shipping`——个人信息，擦除删的就是那一行，此后读到 ''。
     * 旧注释说"三者同住 order_shipping、擦除后 needed=false"是假话：那会让 CSV/账目把
     * "要求过开票"的单报成"没要求开票"（正是当年把 invoice_needed 挪到 orders 的原因）。
     */
    invoice: shippingVisible
      ? {
          needed: !!o.invoice_needed,
          title: o.invoice_title ?? '',
          taxNo: o.invoice_tax_no ?? '',
        }
      : null,
    // 收货信息是否已修改过一次（发货前仅一次修改通道；0/1）
    shippingEdited: shippingVisible ? !!o.shipping_edit_count : null,
    /**
     * **这一单此刻能不能擦除个人信息**（店主侧的「擦除个人信息」入口按它显隐）。
     *
     * 为什么由节点下发而不是前端按状态判（2026-10）：可擦状态集合的**唯一出处**是
     * `src/orderStatus.js` 的 `PII_ERASABLE_STATUS`（在途四种状态必须保留收货信息，否则卖家无法发货），
     * 而 `PII_PROTECTED_STATUS` 与它互斥且并集 = 全部状态。前端若自己写一份 `['confirmed', …]`，
     * 就多出第二份真相：集合一改，前端那处**不报错**，只会静默地少一个入口或多出一个必败按钮
     * （用户看到的是"点了没反应/被拒"，而不是"这个功能没同步"）。
     * 这里只反映"状态允许擦"，**不反映权限**——端点是 ownerOnly，店员看到入口也会被 401 拒绝，
     * 所以调用方必须**同时**用登录角色（`vm.isOwner`）门控，两件事不要合并成一个布尔。
     */
    piiErasable: PII_ERASABLE_STATUS.includes(o.status),
    /** 个人信息擦除锚点（`Date`；null = 从未擦过）。**只写这一列、绝不写 `updated_at`**（口径见 piiErase.js） */
    piiErasedAt: o.pii_erased_at ?? null,
    /**
     * 这一单**还欠一次清理**（附件文件未删净，或 WAL 未截断；见 piiErase.js）。
     *
     * 为什么必须与 `piiErasedAt` 分开下发：锚点说的是"库内那批字段已擦"，而清理是**另一件事**——
     * 擦了一半时锚点会照常落定（库内确实没数据了），只有这个布尔能说明"盘上还有东西、已排队等重试"。
     * 界面若只按锚点印"已擦除"，在"擦了一半"的那一刻就是谎报（那正是这一列存在的理由）。
     */
    piiCleanupPending: o.pii_cleanup_pending === 1,
    amountWei: o.amount_wei,
    paymentToken: o.payment_token,
    paymentSymbol: o.payment_symbol,
    paymentDecimals: Number(o.payment_decimals),
    tokenUsdtMicroPerToken: o.token_usdt_micro_per_token ?? '0',
    paymentRateSource: o.payment_rate_source || 'bty',
    // true = 当时行情源不可用、按手工/固定兜底价成交（订单必须自己说出来）
    paymentRateStale: !!o.payment_rate_stale,
    paymentRateQuotedAt: o.payment_rate_quoted_at || null,
    amountDecimal: weiToDecimal(o.amount_wei, Number(o.payment_decimals)),
    /**
     * 已退给买家的金额（部分退款/拆分裁决；'0' = 链上确证没退过，= amountWei 表示全额退款）。
     *
     * **读不到与确证为 0 是两件事**（2026-10 修复）：这一列是 `DECIMAL(38,0) NOT NULL DEFAULT 0`
     * 且住在链上镜像表 order_chain（建表语句即最终结构、无存量迁移），驱动按 `decimalNumbers:false`
     * 以**十进制字符串**返回——wei 有 38 位，转成 JS number 会静默丢精度（见 db.js 的说明）。
     * 所以 `'0'` 只可能来自"写入时确实是 0"；这里**不再** `|| '0'` 把"视图 LEFT JOIN 拿不到
     * 镜像行"（读不到）说成"链上确证没退过款"——那会让卖家净额虚高、把一次已获授权的部分退款
     * 显示成未授权。缺列由启动期的结构指纹门禁拒绝启动（`SCHEMA_DDL` 是唯一真相）；
     * 这里的 pass-through 是同一口径的最后一道：DTO 不制造结论，
     * 读不到就下发 null，由前端三态消费（utils/refundAuth、utils/orderVault、utils/receipt）。
     */
    refundedAmountWei: o.refunded_amount_wei ?? null,
    refundedAmountDecimal: weiToDecimal(o.refunded_amount_wei, Number(o.payment_decimals)),
    /*
      买家**已授权**的部分退款额（链上 acceptedPartialRefund(orderId) 的镜像；
      '0' = 确证未授权，null = 读不到——视图 LEFT JOIN 拿不到镜像行，或列为 NULL）。
      为什么下发（源码审计 2026-09）：契约收紧后 approveRefund 只接受「全额」或「买家精确授权过的
      那个数」，卖家面板必须先把授权额显示出来，店主才可能给出一个链上真的会接受的金额——
      否则他只能凭空试数字，吃链上那条晦涩的 revert（RefundAmountNotAccepted）。
      与 refundedAmountWei 同口径：字符串 wei + BTY 小数展示（weiToDecimal），防止精度丢失；
      同一条三态纪律：读不到 ⇒ null（前端 refundAuth.authorizedRefundOf 按 source='unknown'
      处理并在签名前直读链上复核），绝不与 '0'（确证未授权）合并。
    */
    acceptedPartialRefundWei: o.accepted_partial_refund_wei ?? null,
    acceptedPartialRefundDecimal: weiToDecimal(o.accepted_partial_refund_wei, Number(o.payment_decimals)),
    /*
      **本单的金额三态**（零费模型：没有平台费、没有节点抽成）：
        · 毛额 `amountWei` = 托管锁定的 wei；
        · 已退买家额 `refundedAmountWei`（'0' = 确证没退过；null = 读不到——视图 LEFT JOIN
          拿不到镜像行时）；
        · 净额 `netWei = amountWei − refundedAmountWei`（与链上 `_settle` 的唯一算式一致：
          退款 + 卖家两条腿）。
      净额的第三态也要保住：任一读数缺失时给 null，绝不把"不知道"折成 0。
    */
    settlement: (() => {
      const amount = readRefundedWei(o.amount_wei);
      const refunded = readRefundedWei(o.refunded_amount_wei);
      const net = amount !== null && refunded !== null && amount >= refunded ? (amount - refunded).toString() : null;
      return {
        configured: true,
        amountWei: o.amount_wei ?? null,
        refundedWei: refunded === null ? null : refunded.toString(),
        netWei: net,
      };
    })(),
    usdtMicro: o.usdt_micro,
    usdt: usdtOf(o.usdt_micro),
    /*
      金额拆分（运费模型 = **按单收取一次**的实物运费，见 POST / 里的锁定逻辑）：
        usdtMicro            = 本单应付总额（商品 + 运费），也是链上锁定 amountWei 的 USDT 口径
        shippingFeeUsdtMicro = 本单实际锁定的运费（数字/NFT 单恒 0）
        goodsUsdtMicro       = usdtMicro − 运费 = 商品金额（单价 × 数量）
      三者一起给，前端才能把「商品金额 + 运费 = 应付」这条算式摆给买家核对。
      口径实现在 src/money.js（**唯一一份**，与 arbitration/products 共用）。
    */
    shippingFeeUsdtMicro: o.shipping_fee_usdt_micro,
    shippingFeeUsdt: usdtOf(o.shipping_fee_usdt_micro),
    goodsUsdtMicro: goodsMicroOf(o.usdt_micro, o.shipping_fee_usdt_micro),
    goodsUsdt: usdtOf(goodsMicroOf(o.usdt_micro, o.shipping_fee_usdt_micro)),
    /** 建单时锁定的 USDT→BTY 汇率（`DECIMAL(20,10)` ⇒ 十进制字符串，同样不许过 JS number） */
    btyUsdtRate: o.bty_usdt_rate,
    status: o.status,
    /*
      ── 草稿期的 `escrowOrderId` 是**买家的支付参数**，不是公开事实 ──
      它是链上 `Escrow.createOrder` 的键：一旦泄露，任何人都能对同一个 orderId 先建一笔
      1 wei 的托管单占位，真实买家付款会永久 `OrderExists` revert（本文件 :16xx 的注释
      已经承认过这条路径）。而已托管之后它由链上 `OrderCreated` 日志公开，藏也没意义。

      可见性判据只在**这一处**：
        · 非草稿（已上链/已终结）⇒ 公开；
        · 请求方已证明是当事人（`as` 非空：买家令牌、店主/店员、仲裁人）⇒ 下发；
        · 详情路由以**不可枚举的订单号**为键（`byOrderNo`，随机段 50 bit）——
          握着那个 URL 本身就是“这一单的钥匙”，所以匿名买家刷新详情页仍能付款；
        · 匿名/第三人的**列表**按买家地址枚举（地址在链上公开），草稿行根本不出现在
          列表里（见 GET / 的 `buyerSelf` 过滤）；列表不泄露 order_no，就不存在
          “地址 → 列表 → 详情”的支付参数组合路径。
    */
    escrowOrderId:
      o.status !== 'draft' || (opts.as !== undefined && opts.as !== null) || opts.byOrderNo === true
        ? o.escrow_order_id
        : null,
    /** 链上规范支付哈希；NULL = 未支付（三态，**不是空串**） */
    paidTxHash: o.paid_tx_hash ?? null,
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
    trackingNo: shippingVisible ? o.tracking_no ?? null : null,
    /*
      承运方名称（店主发货时填；可空）。**与 trackingNo 同一可见矩阵**：只有运单号时"拼查询链接"
      只能靠单号前缀猜，纯数字号段（中通/圆通/申通/韵达）完全猜不出，所以名称是让买家/店主
      能真的查到件的那一半信息——承运方名称本身不算隐私，但它和运单号是同一件事的两半，
      一个过门控、另一个裸奔就是"可见矩阵漏了一个字段"的老毛病（2026-09 修复过 trackingNo）。
      NULL = 店主没填（三态：不是空串、更不是"其他"）。
    */
    carrier: shippingVisible ? o.carrier ?? null : null,
    shippedAt: o.shipped_at ?? null, // 发货标记时刻（Date；含自提/空单号交付——前端"已交付"判定依据）
    deliveries,
    deliveredAt,
    /** 退款镜像（ENUM，NOT NULL DEFAULT 'none'；本列在 order_chain） */
    refundStatus: o.refund_status,
    refundRequestedAt: o.refund_requested_at ?? null,
    refundRejectedAt: o.refund_rejected_at ?? null,
    /*
      确认收货后的**售后案件**（契约 2026-10 第二批；字段口径与写入口都在 src/afterSale.js）：
        afterSaleStatus      none（从未开案）/ open（在途）/ closed（已结案；终态，不可重开）
        afterSaleOpenedAt    开案落库时刻（近似开案时刻）
        afterSaleOpenedBlock 链上开案区块（仲裁人/运维可据此去链上核对）
        afterSaleClosedAt    结案时刻
        afterSaleNote        结案说明（链上事件里的**用户文本**）
      ⚠️ afterSaleNote 是陌生人可控的文本：节点只在 JSON 里下发，**渲染端必须按纯文本输出**
      （不拼 HTML、不用 innerHTML）。长度已在唯一写入口截断到 500（见 afterSale.js），
      这里不再截一次——那样只会让"到底以谁为准"变成两个地方各说一套。
      与 status/refundStatus 的关系：**案件在途时 status 仍是终局**（见本文件头的说明）。
    */
    ...afterSaleFieldsOf(o),
    /*
      陈述时限（双方举证窗口；`MK_DISPUTE_STATEMENT_DAYS`，0 = 关闭）的**举证截止时刻**——
      **唯一出处**是 evidenceFiles.statementFieldsOf（与门控同一份窗口计算）：
      `statementDeadlineAt` **null = 未开启该规则**（配置关闭 / 此刻没有争议也没有在途案件），
      不是"已过期"；已过期由"截止时刻已过"表达。前端契约在
      `frontend/src/types.ts`（Order.statementDeadlineAt）与 `utils/statementDeadline.ts`（倒计时 + 提交门），
      两端的阶段作用域（只有争议陈述与售后陈述受约束）与起算点完全同源。
      界面据此显示"还能举证多久"，不必自己拿 updated_at 再算一遍（那样必然与门控漂移）。
    */
    ...statementFieldsOf(o),
    /*
      零费模型：订单上没有费率/抽成/收款方快照可下发——钱只有买家与卖家两条腿。
      历史上那三组字段（feeBps / feeCollectorAtCreate / feeChargeable）随平台费与
      节点抽成一起删除，读它的前端也同批删掉（不保留"永远是 0"的假字段）。
    */
    review,
    return: returnInfo,
    timeoutBlocks: o.timeout_blocks,
    /** 时间列一律 `Date`（JSON 出口自动是 ISO-8601；库里是 DATETIME(3)、服务器盖章） */
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

/**
 * **跨表守卫的写法：目标表单表 UPDATE + `EXISTS(另一张表)`，不用多表 JOIN。**
 *
 * 为什么不能用 `UPDATE orders o JOIN order_chain c … SET o.x = ?, c.y = ?`：MySQL 在
 * `CLIENT_FOUND_ROWS` 语义下（db.js 启动时实测钉住的那个），多表 UPDATE 的 `affectedRows`
 * 是**各张表命中行数之和**——一单命中会返回 **2**（2026-10-16 实测）。本文件里
 * `changes === 1` / `changes !== 1` 的守卫（状态迁移、凭证认领、取消、发货、改址次数）
 * 全都建立在"命中即 1"上，多表 UPDATE 会让它们**静默失效**（不报错，只是判据不再成立）。
 *
 * 所以规矩是：
 *   · 一条语句只写**一张**表，它的 `changes` 就是"我认领了几行"；
 *   · 另一张表上的条件写进 `EXISTS(...)` 子查询（目标表**不能**出现在子查询里，
 *     否则 MySQL 直接 `ER_UPDATE_TABLE_USED`）；
 *   · 确实要同时改两张表（例如"状态 + 凭证"）时，拆成两条**各自带守卫**的语句关在同一个
 *     `withTransaction` 里：第一条的 `changes` 是"我认领了这一行"的**唯一凭据**，第二条只在
 *     它为 1 时才写——两条之间没有别的写者能改**同一行**（那一行已被第一条锁住；注意这不再
 *     由全局锁保证，而是由行锁保证，所以两条语句必须落在**同一行**上）。
 */

/**
 * 状态迁移（仅当当前状态在 from 内），返回受影响行数。
 *
 * 参数是**内部 order_id**：状态与 `updated_at` 都在 `orders` 这一张表里，调用方（/sync）
 * 本来就握着 v_orders 那一行——旧的 `WHERE escrow_order_id = ?` 现在得先 JOIN order_chain
 * 才写得到同一个 `orders` 行，白白多一次连接。
 *
 * `updated_at` 必须显式写：它没有 `ON UPDATE CURRENT_TIMESTAMP`，而它是**入账窗口**与列表
 * 排序的锚点（收款流水按它筛 `?from/?to`），漏掉就等于这笔成交挤进上一次迁移的时间戳。
 */
async function transition(orderId, from, to) {
  const fromList = Array.isArray(from) ? from : [from];
  /*
    旧实现用普通 UPDATE 返回 changes，调用方再拿**事务外读到的** `order.status` 决定是否
    补库存占位。并发下（sweeper/买家取消在 RPC 往返之间提交）UPDATE 会命中 `cancelled`，
    而分支仍看旧 `draft`——占位永远漏补。`claimOrderState` 在事务内 `SELECT ... FOR UPDATE`，
    返回的 `from` 就是本次迁移真正的前一状态。`/sync` 的调用点全部在 `withTransaction` 内。
  */
  return await claimOrderState(getDb(), orderId, fromList, to);
}

/**
 * 链上「已退买家金额」回填——**与状态迁移共用同一个 claim**（P2-1）。
 *
 * 旧实现只要链上读到 refundedAmount 就无条件写这一列，即使状态迁移没发生（`moved=0`）：
 * 一张本地已 `expired` 的超时释放单被快照路径看到链上是 Settled 时，状态没动、退款金额
 * 却被改写，随后 PII 保留期/账本读到的是两份不同事实。判据写进**同一条 UPDATE**：
 * 只有本地状态此刻真的等于目标终态（`moved=1` 刚写入，或本来就是它）才写。
 * 单条语句里的 `EXISTS(status = ?)` 让"是否算这一单的终态"与写入同一时刻成立，
 * 不需要先读后写，也没有检查与写入之间的窗口。
 *
 * @returns {Promise<number>} changes（0 = 本地不是该终态，或值本来就相同）
 */
async function backfillRefundedAmount(order, targetStatus, wei) {
  const amount = readRefundedWei(order.amount_wei);
  const total = readRefundedWei(wei);
  // 超出托管额 / 读不到：不写。负净额会让流水与统计口径直接失真。
  if (amount === null || total === null || total > amount) return 0;
  const totalText = total.toString();
  return (await getDb().run(
    `UPDATE order_chain c SET c.refunded_amount_wei = GREATEST(COALESCE(c.refunded_amount_wei, 0), ?)
      WHERE c.escrow_order_id = ? AND (c.refunded_amount_wei IS NULL OR c.refunded_amount_wei <> ?)
        AND EXISTS (SELECT 1 FROM orders o WHERE o.id = c.order_id AND o.status = ?)`,
    totalText, order.escrow_order_id, totalText, targetStatus
  )).changes;
}

/**
 * 终局复位退款镜像（`refund_status='none'`）——同一个 claim：只有本地状态已经是目标终态才写。
 * 与 `backfillRefundedAmount` 同因：`moved=0` 时（尤其本地 expired 而链上是 Settled）
 * 不得把一张旧终局单的售后/退款镜像「顺手」改掉；它没有发生状态迁移，就没有这次复位的语义。
 */
async function clearRefundMirrorForTerminal(order, targetStatus) {
  return (await getDb().run(
    `UPDATE order_chain c SET c.refund_status = 'none'
      WHERE c.escrow_order_id = ? AND c.refund_status <> 'none'
        AND EXISTS (SELECT 1 FROM orders o WHERE o.id = c.order_id AND o.status = ?)`,
    order.escrow_order_id, targetStatus
  )).changes;
}

/**
 * 校验买家支付收据：交易已上链、接收方为托管合约且含本订单 OrderCreated 日志。
 * 返回 { ok: true, canonicalHash } 或 { ok: false, message }。
 * canonicalHash 取收据的链上规范哈希：BTY EVM 交易在链上同时存在
 * Chain33TxId（主链哈希）与 EvmTxId（EVM 哈希）两个 ID，
 * 钱包广播返回的可能只是其中一个别名。一律以 eth_getTransactionReceipt 返回的
 * 规范哈希落库，同一笔支付无论用哪个别名确认都归一为同一值——
 * 配合 paid_tx_hash 唯一索引实现「支付 txHash 必须唯一」。
 */
async function verifyPaidReceipt(order, txHash) {
  const receipt = await getProvider().getTransactionReceipt(txHash);
  if (!receipt) return { ok: false, message: '链上暂未检索到该交易，请稍后重试' };
  /*
    确认深度：/paid 若在 latest 就推进，一次短重组会让本地 escrowed + paid_tx_hash 指向一条
    链上已不存在的 OrderCreated；watcher/sync/对账随后按链上真值把它当"本地有、链上无"，
    没有自动回滚路径。与 watcher 读 `head − finality` 同口径：未达终局就不确认，让前端
    "稍后重试"（交易本身不会消失，只是还没到可回写深度）。finality=0（演示）时 finalizedBlockTag
    返回 'latest'，不做比较。
  */
  const finality = Number(config.escrow.finalityBlocks || 0);
  const finalized = await finalizedBlockTag().catch(() => null);
  if (finality > 0) {
    /*
      **读不到确认边界就拒绝**，不要 catch 成 null 后跳过比较（旧实现就是 fail-open）：
      这道闸的全部意义是"未达终局不写不可逆状态"，读不到时放行等于把闸拆掉。
      receipt 缺 blockNumber 同样无法证明深度 ⇒ 拒绝。
    */
    if (typeof finalized !== 'number') {
      return { ok: false, message: '读不到链上确认深度（RPC 异常）：本次不确认托管，请稍后重试（链上资金已托管）' };
    }
    if (receipt.blockNumber === undefined || receipt.blockNumber === null) {
      return { ok: false, message: '交易收据缺少区块号，无法验证确认深度：本次不确认托管，请稍后重试' };
    }
    if (Number(receipt.blockNumber) > finalized) {
      return {
        ok: false,
        message: `该交易所在区块（${receipt.blockNumber}）尚未达到确认深度（当前终局块 ${finalized}，需 ${finality} 块）：请稍后重试，链上资金已托管，状态会自动回写`,
      };
    }
  }
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
  /*
    事件本身不带支付资产/验货窗口；这两项都是订单身份。`/paid` 原先只比事件里的
    orderId/buyer/seller/amount（`orderCreatedMatches`），与 watcher/sync/对账/交付闸
    使用的 `chainParamsMatch` 不是同一判据——同一 orderId 换一个 timeoutBlocks 就能让本地
    进入 escrowed，而后续所有链上真值路径都把它当诱饵单拒绝，形成永久分叉。
    这里直接读链上订单并复用那唯一判据（含 timeoutBlocks/token），读不到或任一不符都不确认。
  */
  let chain;
  try {
    chain = await fetchOrderFor(order.escrow_order_id);
  } catch (e) {
    return { ok: false, message: `读不到链上订单真值（${e?.message || e}），本次不确认托管` };
  }
  if (chain.status === 'None') {
    return { ok: false, message: '链上尚未读到该订单（交易可能刚打包），请稍后重试' };
  }
  if (!chainParamsMatch(order, chain)) {
    return {
      ok: false,
      message:
        '链上同单号的托管单与本单的买家/卖家/金额/验货窗口/支付资产不一致——疑似诱饵单，本次不确认托管',
    };
  }
  const orderToken = chain.token;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrowAddr) continue;
    let parsed = null;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed && parsed.name === 'OrderCreated' && orderCreatedMatches(order, parsed.args, order.escrow_order_id, orderToken)) {
      return {
        ok: true,
        canonicalHash: String(receipt.hash || txHash).toLowerCase(),
        blockNumber: receipt.blockNumber || null,
      };
    }
  }
  return { ok: false, message: '交易中未找到与本单锁定匹配的托管事件（需 OrderCreated 且金额/卖家/买家一致，疑似未托管/他人代付或伪造托管）' };
}

/**
 * 事件史补写 OrderCreated（paid/sync 快路径专用）：watcher 仅在状态迁移成功时记录事件，
 * paid 先行置 escrowed 后 watcher 轮询到 OrderCreated 不再迁移（changed=0）——该单事件史将
 * 永缺 OrderCreated，导致详情页凭证链不完整、信誉画像（按事件史计单量/确认率分母/发货耗时
 * 起点）漏计整单。按订单补写一条与 watcher 同构的镜像 {name,txHash,block,at}；
 * 已含 OrderCreated 时跳过（watcher 已记/重复调用幂等）。
 *
 * @param {number} orderId **内部 order_id**（事件史是 order_chain 的一列，主键就是它）。
 *   调用方（本文件 /paid、/sync，以及 chainReconcile 的兜底）手里都有这一行；
 *   旧的"本地订单 id"参数在新形状下映射到 `orders.id`，而 `orders.id` 现在**只**在库内使用。
 */
export async function appendOrderCreatedEvent(orderId, meta = {}) {
  const db = getDb();
  /*
    「读整列 JSON → push → 写回」必须在**同一个事务**里（2026-10-16）：
    事件史是一列 JSON，两个写者（paid 快路径 / watcher / 手动 sync / 后台对账）并发时，
    各自读到同一份旧数组、各自 push、后写的那一份把前一份**整条事件**盖掉——
    详情页的凭证链与信誉画像（按事件史计单量/确认率分母）因此静默缺一条里程碑，
    而两边的返回都是成功。这与 watcher 的 recordEvent 是同一把锁下的串行写。
    已在外层事务里时自动降级为 SAVEPOINT（见 db.js）。
  */
  return await withTransaction(async () => {
    // FOR UPDATE：与 recordEvent / appendSyncMirrorEvent 共用同一把行锁，防读-改-写丢事件
    const row = await db.get('SELECT events FROM order_chain WHERE order_id = ? FOR UPDATE', orderId);
    if (!row) return;
    // JSON 列由驱动解析成数组（jsonStrings 未开，见 db.js）：这里只做类型兜底，
    // 不再 JSON.parse —— 对已解析的数组再 parse 会抛错并被吞掉，事件史会被**静默清空**。
    let list = Array.isArray(row.events) ? row.events : [];
    if (list.some((ev) => ev && ev.name === 'OrderCreated')) return;
    /*
      事件里 `at` 是**毫秒读数**（不是 DATETIME 列）：它与 watcher 写进同一列的
      `recordEvent` 事件、以及前端时间线的既有口径是同一种形状——这一列的形状由
      "所有写者 + 读者"共同决定，要改必须两条路径同批改（改一处就是时间线上两种时间）。
    */
    list.push({ name: 'OrderCreated', txHash: meta.txHash || null, block: meta.block || null, at: Date.now() });
    // 与 recordEvent(watcher) / appendSyncMirrorEvent 同款裁剪（事件史上限 20）：
    // 此前本函数不裁剪，同一单一旦走到"先有 20 条（sync 镜像/watcher 事件）后补写 OrderCreated"
    // 的顺序，事件史就会变成 21+ 条，与另两条写入路径的承诺不一致（详情页/信誉画像按它读）。
    if (list.length > EVENT_HISTORY_LIMIT) list = list.slice(-EVENT_HISTORY_LIMIT);
    await db.run('UPDATE order_chain SET events = ? WHERE order_id = ?', JSON.stringify(list), orderId);
  });
}

/**
 * 事件史补写 Sync 镜像（sync 手动推进专用）：watcher 漏扫后经 /sync 迁移的订单，
 * 详情凭证链与信誉画像可能缺里程碑——补一条 {name:'Sync:<状态>', block: 链上订单创建块} 镜像
 * （不与 watcher 真实事件重名，信誉计数按真实事件名统计不受影响；前端时间线按语义展示）。
 * 幂等：同状态镜像已存在时跳过。
 * 导出：链上状态对账（chainReconcile）修复滞留单时用同一条镜像——UI 时间线上"为什么变了"
 * 的解释只有一种形状（`Sync:<状态>`），不论修复来自手动 /sync 还是后台对账。
 * @param {number} orderId **内部 order_id**（同 appendOrderCreatedEvent）
 */
export async function appendSyncMirrorEvent(orderId, toStatus, meta = {}) {
  const db = getDb();
  /*
    与 appendOrderCreatedEvent 同一条纪律：读 JSON → push → 写回必须关在**同一个事务**里，
    否则并发的 /sync（或后台对账）会各自读到同一份旧数组、把对方刚补的那条镜像盖掉
    （时间线上少一次"为什么变了"的解释，且没有任何错误）。
  */
  return await withTransaction(async () => {
    const row = await db.get('SELECT events FROM order_chain WHERE order_id = ? FOR UPDATE', orderId);
    if (!row) return;
    let list = Array.isArray(row.events) ? row.events : [];
    const name = `Sync:${toStatus}`;
    if (list.some((ev) => ev && ev.name === name)) return;
    list.push({ name, txHash: null, block: meta.block || null, at: Date.now() });
    if (list.length > EVENT_HISTORY_LIMIT) list = list.slice(-EVENT_HISTORY_LIMIT);
    await db.run('UPDATE order_chain SET events = ? WHERE order_id = ?', JSON.stringify(list), orderId);
  });
}

/**
 * 将规范支付哈希写入订单（仅当该列仍为空且订单仍处于可支付态）。
 * 状态条件防竞态错记：草稿被清扫器关闭/买家取消（cancelled）后才落定的链上支付，
 * 哈希必须保持为空——watcher 的 OrderCreated 恢复分支以「cancelled 且无凭证」为前置，
 * 若此处把哈希写在 cancelled 行上，自动恢复将被永久跳过（链上资金真实存在而本地
 * 永远 cancelled，只能人工 sync 救回）。
 * 哈希已被其他订单占用时返回 { error: 'taken' }。先应用层预检给出友好错误；
 * `order_chain.paid_tx_hash` 的 UNIQUE 索引兜底并发竞态（MySQL 的 ER_DUP_ENTRY；
 * NULL 可重复 ⇒ 未支付的单互不冲突）。
 * 落库成功同步补写 OrderCreated 事件史（paid 快路径不迁移 watcher 事件，见 appendOrderCreatedEvent）。
 */
async function notePaidTxHash(order, canonicalHash) {
  const db = getDb();
  // 凭证列的唯一性住在链上镜像表：占用检查必须查 **order_chain**（orders 表里已经没有这一列）
  const taken = await db.get('SELECT order_id FROM order_chain WHERE paid_tx_hash = ? AND order_id != ?', canonicalHash, order.order_id);
  if (taken) return { error: 'taken' };
  /*
    凭证落库 + 事件史补写同事务（防半写：凭证已落而事件史缺失——凭证链/信誉漏计）。
    凭证在 order_chain、`updated_at` 在 orders ⇒ 两条**各自带守卫**的语句
    （为什么不用一条多表 UPDATE，见上方"跨表守卫的写法"）：
      · 凭证认领 = 自己的 `paid_tx_hash IS NULL` ＋ 另一张表的状态守卫（EXISTS）。
        状态守卫必须在：把哈希写进 cancelled 行会让 watcher 的自动恢复（以「cancelled 且
        无凭证」为前置）永久跳过，链上真实存在的资金就再没有自动路径能救回来；
      · `updated_at` 只在认领成功时推（认领失败时这一行什么都不该动，与旧实现同口径）。
  */
  try {
    const claimed = await withTransaction(async () => {
      const n = (await db.run(`UPDATE order_chain c SET c.paid_tx_hash = ?
           WHERE c.order_id = ? AND c.paid_tx_hash IS NULL
             AND EXISTS (SELECT 1 FROM orders o WHERE o.id = c.order_id AND o.status IN ${PRE_PAID_IN})`, canonicalHash, order.order_id)).changes;
      if (n === 1) {
        await db.run('UPDATE orders SET updated_at = ? WHERE id = ?', new Date(), order.order_id);
        await appendOrderCreatedEvent(order.order_id, { txHash: canonicalHash });
      }
      return n;
    });
    return { changes: claimed };
  } catch (e) {
    // 唯一索引兜底：同一笔链上支付被并发确认到两张单上时，这里把它折成可读的业务错误
    if (/ER_DUP_ENTRY|Duplicate entry/i.test(String(e.code || '') + ' ' + String(e.message || ''))) return { error: 'taken' };
    throw e;
  }
}

// ── 创建草稿 ──

/**
 * 创建订单草稿：锁定商品快照 + 汇率与应付金额（单价×数量）+ 链上 orderId。
 * 鉴权（防匿名占位 DoS，P1-2）：需登录且目标买家=登录地址，店主可代买家下单（卖家面板代客单）；
 * 叠加每 (发起人, 买家) 活跃草稿上限（防注册地址批量占位，也防店主用代客单占满别人额度）。
 * orderId = keccak256(快照hash ‖ seller ‖ buyer ‖ 草稿 UUID)——UUID 随机化：
 *  - 同买家同商品可反复购买（v2 需求，不再防重拦截）；
 *  - 链上预占不可行（攻击者无法预知 orderId，原「确定性 orderId 占位 DoS」随之消除）。
 *
 * **店铺从商品推导，不由请求声明**：卖方 = 商品行 `shop_code` 指向的那家店的 `seller`，
 * 它同时是链上 `createOrder` 的 `seller`、罚没责任主体与 `orderId` 哈希的一项。
 * 旧形状要求买家带 `X-Mk-Shop` 声明一家店，再校验它与商品的 `shop_code` 一致——那层声明与
 * "这单属于谁"本来就是同一个事实（商品行已经回答了），却凭空多出一个可以不一致的输入
 * （带错头是 404，只有带对头那一种用法能成功）。买家动作本就不该需要店铺句柄：
 * 一次登录就能买这个节点里任何一家店的东西（见 http.js 的中间件说明）。
 */
router.post('/', requireAuth, draftLimiter, wrap(async (req, res) => {
  if (!config.chain.escrowAddress) return fail(res, '本节点未启用托管支付（MK_ESCROW_ADDRESS 未配置）');
  const { productSlug, skuKey: bodySkuKey, buyer: bodyBuyer, quantity, shipping, note, ageAck, invoice, paymentToken: bodyPaymentToken } = req.body || {};
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
  const product = await getDb().get(
    `SELECT * FROM products WHERE slug = ? AND ${productSellableSql()}`,
    String(productSlug || '')
  );
  if (!product) return fail(res, '商品不存在或已下架', 404, 404);
  /*
    **店铺 = 商品所属的那一家**：`products.shop_code` 有外键指向 `shops(code)`，
    所以"这单付给谁"与"这件货是谁家的"读的是同一个列，二者不可能不一致。
    读不到那一行（正常不可达：外键拦着）时如实报错，**不回退到任何默认店铺**。

    这一处取代了旧的"请求头声明的店必须等于商品的 shop_code"那道校验（跨店越权，2026-10-15 修）：
    当时的判据是"两个可以不一致的输入必须相等"，而现在只剩一个输入（商品行），
    那一类越权（收货人写 B、库存占位打 A、自动交付从 A 的码池取码）在形状上不可表达。
  */
  const shop = await shopRowByCode(product.shop_code);
  if (!shop) return fail(res, '商品所属店铺不存在（该店已注销）：无法确定收款方，拒绝建单', 404, 404);
  // 暂停接单的店铺不能建新单（**影响未来销售**的动作，判据与商品闸同一处）
  const notSellable = sellableError(shop);
  if (notSellable) return fail(res, notSellable, 403, 403);
  const owner = String(shop.seller || '').toLowerCase();
  if (!isAddress(owner)) return fail(res, '该店铺没有合法的店主收款地址，无法下单');
  // 目标买家：默认本人；店主可代买家下单（测试/代客场景），其余只允许本人
  const target = bodyBuyer ? String(bodyBuyer).toLowerCase() : me;
  if (!isAddress(target)) return fail(res, 'buyer 需为 0x 开头的以太坊地址');
  if (me !== target && me !== owner) return fail(res, '只能为本人下单（店主可代买家下单）', 403, 403);
  /*
    代客单的额度记在 **(发起人, 买家)** 名下，不占买家自己的十张额度：否则店主可以拿代客草稿
    把任意买家的额度占满（见 draftQuota.js 文件头）。判据是"这次是谁发起"，不是 buyer != seller。
  */
  const quotaSeller = target === me ? null : owner;
  // ── 所选 SKU：价格与库存的权威来源 ──
  // 无规格商品的唯一组合 sku_key 为 ''，故这里不需要「有无规格」的分支。
  // 未指定 skuKey 时：只有一个组合就自动选中（简化调用仍可用）；
  // 多组合则必须显式选择 —— 否则金额无法确定，宁可拒单也不猜。
  const skuRows = await loadSkus(product.id);
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
  // 池式商品（码池 / NFT tokenId 池）的可用量核算在**事务内**做（见下方 withTransaction 段）：
  // 只 COUNT 未用资源不扣减在途需求时，N 个并发草稿对 1 个码可以全部通过（各自都看到"还剩 1"），
  // 付款后只有先交付的那单拿得到资源，其余买家钱被托管却拿不到货——与
  // 「售罄拦截：防付款后无码可发」的承诺不符（源码审计 2026-09）。

  const rates = await getRates();
  if (!rates) return fail(res, '汇率数据源暂不可用，无法锁定应付金额，请稍后再试');

  /*
    运费：**按单收取一次**（不随件数翻倍）。
    取舍理由：实物小店的实际快递成本按"一个包裹"计，一件与三件的快递费基本相同；
    算式也最简单——应付 = 单价 × 数量 + 运费。若逐件计费，多件订单会凭空多收 N 倍快递费，
    而买家在下单页看到的"运费 X USDT"会与结算页金额不符（同一屏两套口径是最坏的体验）。
    仅实物商品计运费：数字 / NFT 无需物流，恒 0（商品侧已禁止给非实物设运费，这里是第二道闸）。
  */
  const shippingFeeMicro =
    product.kind === 'physical' && Number.isInteger(product.shipping_fee_usdt_micro) && product.shipping_fee_usdt_micro > 0
      ? product.shipping_fee_usdt_micro
      : 0;
  const goodsMicro = sku.price_usdt_micro * qty;
  // usdt_micro = 商品金额 + 运费（订单行的权威总额口径）；amountWei 由它折算，两者恒同源
  const totalMicro = goodsMicro + shippingFeeMicro;
  /*
    合计必须落在**安全整数**内（源码评审 2026-10，P0）：`orders.usdt_micro` 是 BIGINT 列，
    而 JS 的 Number 只能精确表示到 Number.MAX_SAFE_INTEGER(9.007e15)——超过之后读回来的
    就不是写进去的那个数（旧实现下 node:sqlite 直接抛 RangeError）。后果不是"算得不准"，而是：
    这一行**已经提交**（写在本请求的 INSERT 之后），此后凡是 `SELECT *` 于 orders 的路径
    ——订单详情/买家列表/店主列表/流水/两个 CSV/仲裁队列/通知/池告警——全部 500，
    且 `cancel` 也走 findOrder ⇒ 接口层无法自救，只能人工改库。
    商品侧上限（PRICE_MAX_MICRO = 1e13 微）× 数量 ≤99 + 运费 ≤1e9 本来就在安全区内，
    这里再兜一道闸：任何绕过校验的历史数据或直连调用都写不出这种行。
  */
  if (!Number.isSafeInteger(totalMicro)) {
    return fail(res, '本单应付合计超出可精确表示的上限（约 90 亿 USDT）：请拆单或下调单价后再试');
  }

  // 支付资产：原生 BTY，或节点自己配置的 ERC20（价格语义见 src/paymentTokens.js）
  const requestedPayment = String(bodyPaymentToken ?? 'native').trim();
  const requestedToken = requestedPayment && requestedPayment.toLowerCase() !== 'native'
    ? requestedPayment.toLowerCase()
    : null;
  let amountWei;
  let paymentToken = '0x0000000000000000000000000000000000000000';
  let paymentSymbol = 'BTY';
  let paymentDecimals = 18;
  let tokenUsdtMicroPerToken = '0';
  let paymentRateSource = 'bty';
  let paymentRateStale = 0;
  if (requestedToken) {
    let quote;
    try {
      quote = await quotePaymentToken(requestedToken, totalMicro);
    } catch (e) {
      return fail(res, `该 ERC20 行情暂不可用：${e?.message || e}`, 503, 503);
    }
    if (!quote) return fail(res, '该 ERC20 不是本节点支持的支付资产', 400, 400);
    /*
      草稿也要先问链上白名单：否则会先占库存、30 分钟后才在钱包签名阶段被拒。
      读不到白名单就拒（fail-closed），不能生成一张可能永远付不了的草稿。
    */
    try {
      if (!(await tokenSupportedOnChain(quote.token))) {
        return fail(res, '该 ERC20 当前未在节点 Escrow 的支付白名单里，无法收款', 400, 400);
      }
    } catch (e) {
      return fail(res, `读不到该 ERC20 的链上支付白名单：${e?.message || e}`, 503, 503);
    }
    amountWei = quote.amountWei;
    paymentToken = quote.token;
    paymentSymbol = quote.symbol;
    paymentDecimals = quote.decimals;
    tokenUsdtMicroPerToken = quote.usdtMicroPerToken;
    paymentRateSource = quote.mode;
    paymentRateStale = quote.stale ? 1 : 0;
  } else {
    amountWei = usdtMicroToPayWei(totalMicro, rates);
    paymentRateStale = rates?.stale ? 1 : 0;
  }
  /*
    零金额草稿必须在这里拦住（源码评审 2026-09，P1）：`usdtMicroToPayWei` 在汇率不可用时返回 '0'
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
    这里显式挂上 loadSkus（形状与 rowToPublic 一致：sku_key / price_usdt_micro）。
  */
  const snapshot = snapshotObject({ ...product, skus: await loadSkus(product.id) });
  /*
    下单风控闸（可选、默认关闭）：**运营方自己的**准入策略执行点——平台不提供风控服务、
    也不替店主判定，节点只是把这一单的交易要素转给店主配的服务，按应答放行或拒单
    （默认未配置时 checkOrderGate 立即返回 ok，零开销，行为与从前一字不差）。

    位置刻意选在「本地校验全部通过、事务尚未开始」处：
      · 已在事务外，所以拒单**既不插订单行也不占库存**（draft/committed 都无痕迹）；
      · 已在金额/规格/数量算完之后，所以风控服务能看到真实的锁定金额（含运费）而不是请求体原文；
      · 排在限流/草稿上限/停售等本地判定之后：本地就能拒的请求不花这次外呼
        （真正的售罄与池量核算在事务内、本闸之后——它们必须与插单同事务读库存，不能提前）；
      · 在事务外也意味着这次外呼不会把写事务拖住（风控服务慢不该锁住全站的写）。
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
    usdtMicro: totalMicro,
    shippingFeeUsdtMicro: shippingFeeMicro,
    note: noteText, // 刻意传了也不外发：orderGate.js 的白名单决定"发什么"，备注永不进 payload
  });
  if (!gate.ok) return fail(res, `本店风控未放行：${gate.reason}`, 403, 403);
  // 有限库存（capacity 非空）占位：事务内原子销量 +quantity（committed + qty ≤ capacity），耗尽即拒单（防并发超卖）；
  // 占位失败整体回滚，不产生草稿；不限量/池式商品（capacity 为 NULL）不占位。
  // 占位随订单生命周期释放：草稿超时取消/仲裁退款/超时释放时按 stockHold.js 单点契约回补，已成交不释放。
  // 占位（holdStock）+ 插单同事务：防进程中断造成「已占位未落单」（货被占死）或
  // 「已落单未占位」（余量虚高 → 超卖）。零费模型下没有抽成/费率快照要写。
  // 嵌套调用（holdStock 内部）自动降级为 SAVEPOINT（见 db.js）。
  const created = await withTransaction(async () => {
    /*
      **同一份读**：商品行与 SKU 行在事务内重新锁定并复核，而不是沿用前面隔着汇率/风控外呼的
      旧快照。`snapshot_hash` / `price_usdt_micro` 是金额与 orderId 的输入——卖家在这段时间里
      改价/改规格，会让"订单快照、snapshot_hash、实付金额"三者来自不同版本（买家看到假哈希、
      仲裁看到的锁定价与实付不一致）。锁定后若与已用值不同，直接拒绝让买家刷新，不猜。
    */
    const freshProduct = await db.get(
      'SELECT id, snapshot_hash, active, shop_code FROM products WHERE id = ? FOR UPDATE',
      product.id
    );
    if (
      !freshProduct ||
      Number(freshProduct.active) !== 1 ||
      String(freshProduct.shop_code) !== String(product.shop_code) ||
      String(freshProduct.snapshot_hash) !== String(product.snapshot_hash)
    ) {
      return abortTx({ fail: '商品在你下单期间被修改（价格/规格/描述/上下架），请刷新页面核对后重新下单' });
    }
    const freshSku = await db.get(
      'SELECT sku_key, price_usdt_micro, active FROM product_skus WHERE product_id = ? AND sku_key = ? FOR UPDATE',
      product.id,
      sku.sku_key
    );
    if (
      !freshSku ||
      Number(freshSku.active) !== 1 ||
      Number(freshSku.price_usdt_micro) !== Number(sku.price_usdt_micro)
    ) {
      return abortTx({ fail: '所选规格在你下单期间被修改（价格/停售），请刷新页面核对后重新下单' });
    }
    /*
      两道"免费草稿锁库存"的闸（同买家活跃草稿 ≤10、同买家同商品草稿占位 ≤99）——
      **加量只有 `reserveDraftQuota` 一处实现**，减量在 `orders` 上的触发器里
      （`db.js` 的 TRIGGER_DDL：订单离开 draft 时减，**不要在这里补一次减量**）。

      它们必须与插单同事务：闸的"占位"与后面的"插单"之间隔着 `await checkOrderGate(...)`
      （一次外部 HTTP 调用，几十毫秒），分开写就等于放行一个没有订单的占位（额度被占死）。
      不在事务外、也不再需要"读计数"这一步：占位本身是带守卫的 UPDATE（命中 1 行才算占到），
      并发请求谁先占到谁算数，不靠任何人串行化。
      代价：超限请求会先花掉一次风控外呼才被拒（原来在闸之前就拒），换回闸真的拦得住。
    */
    const quota = await reserveDraftQuota({
      buyer: target,
      productId: product.id,
      units: qty,
      proxySeller: quotaSeller,
    });
    if (quota?.fail) return abortTx({ fail: quota.fail });
    /*
      池式商品（digital 码池 / nft tokenId 池）的可用量：占位同样只有一条带守卫的 UPDATE
      （`src/poolQuota.js`，减量在触发器里：交付一件减一件、订单离开在途减剩余需求）。
      口径：可用 = 未用资源 − 在途订单尚未交付的需求；这个和在途需求就是 `reserved_codes`
      这个计数器本身（旧实现是下单时现算一遍 SUM，靠全局写锁才成立）。
      池未建（池里一个资源都没有）时不拦：卖家手动交付/自由文本那种形态是既有语义（见 poolQuota.js）。
    */
    if (product.kind === 'digital' || product.kind === 'nft') {
      if (!(await reservePoolUnits(product.id, product.kind, qty))) {
        // 拒因里的余量只是给人看的读数（判据是上面那条 UPDATE 的 changes）
        const { available } = await poolAvailability(product.id, product.kind);
        return abortTx({
          fail:
            product.kind === 'digital'
              ? `该数字商品兑换码不足（未被在途订单占用的仅剩 ${available} 个，本单需 ${qty} 个）——请等待卖家补充，或先完成/取消未支付的草稿`
              : `该 NFT 商品库存不足（未被在途订单占用的仅剩 ${available} 枚，本单需 ${qty} 枚）——请等待卖家补充，或先完成/取消未支付的草稿`,
        });
      }
    }
    // 占位成功与否是决定 hold_qty 的唯一依据：限量商品占位成功 → hold_qty=quantity（随行记账，
    // 供释放/恢复使用）；不限量/池式商品（capacity NULL）不占位 → hold_qty=0
    let held = false;
    if (sku.capacity !== null) {
      if (!(await holdStock(product.id, sku.sku_key, qty))) {
        return abortTx({ fail: '所选规格已售罄' });
      }
      held = true;
    }
    /*
      建单要写**三张表**（订单事实 / 个人信息 / 链上镜像），判据是"谁写它"而不是"读起来顺不顺"
      （见 db.js 的订单三表说明）：

        · `orders`：事实与履约。零费模型下没有费率/抽成/收款方快照可写——订单上只有毛额。
          `created_at` / `updated_at` 不写：`DEFAULT CURRENT_TIMESTAMP(3)` 由**服务器**盖章，
          应用端时钟错了也写不错。
        · `order_shipping`：全部个人信息（收货三项 + 备注 + 开票三项 + 修改次数）。擦除时删的就是这一行。
        · `order_chain`：链上镜像行。**建草稿时就要有**（`escrow_order_id` 此刻已确定）——
          它是 paid_tx_hash / refund_status / after_sale_* / events 的宿主，晚建一步，
          后面每一条链上回写都得先判"这一行在不在"。
    */
    const ins = await db.run(`INSERT INTO orders
        (order_no, product_id, product_slug, product_snapshot, snapshot_hash, sku_key, sku_specs, buyer, seller, shop_code,
         quantity, hold_qty, amount_wei, payment_token, payment_symbol, payment_decimals,
         token_usdt_micro_per_token, payment_rate_source, payment_rate_stale, usdt_micro,
         shipping_fee_usdt_micro, bty_usdt_rate, status,
         timeout_blocks, age_ack, invoice_needed, created_boot, created_mono)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      id, product.id, product.slug, JSON.stringify(snapshot), product.snapshot_hash,
      // `sku_specs` 是 JSON 列：`loadSkus` 读回来的是**已解析的对象**（见 db.js 的 jsonStrings 说明），
      // 直接当参数传进去会被驱动转成 `` `key` = value `` 那种片段（ER_INVALID_JSON_TEXT）。
      sku.sku_key, JSON.stringify(sku.specs_json),
      target, shop.seller, shop.code,
      qty, held ? qty : 0, amountWei, paymentToken, paymentSymbol, paymentDecimals, tokenUsdtMicroPerToken,
      paymentRateSource, paymentRateStale, totalMicro, shippingFeeMicro,
      requestedToken ? '0' : String(rates.btyUsdt),
      config.escrow.timeoutBlocks,
      product.age_restricted && ageAckAsserted ? 1 : 0,
      // "要不要开票"是订单事实，住 orders —— 它**不随个人信息擦除消失**（擦除删的是 order_shipping 行）
      invoiceInfo.needed ? 1 : 0,
      // 单调锚点（草稿 TTL 判据用，见 src/monotonicClock.js 与 db.js 的列说明）：
      // created_boot 让清扫器知道"这行的单调读数是不是本次运行的"，created_mono 是下单时刻的单调读数
      bootId, monotonicNow());
    /*
      `insertId` = 这条 INSERT 分配到的 `orders.id`：下面两张 1:1 子表的外键就是它。
      刻意**不**用 `SELECT … ORDER BY id DESC LIMIT 1` 去回查（那靠"同一连接、中间没有别的
      INSERT"的时序巧合成立，中间插一句别人的 INSERT 就会把子行挂到别单上）。
    */
    const orderId = ins.insertId;
    /*
      代客单标记：触发器据此决定"离开 draft 时减 (店主, 买家) 的代客账还是买家自己的账"。
      必须与订单行同一事务；缺了它，代客草稿会去减买家的额度（买家被凭空扣一次）。
    */
    if (quotaSeller) await db.run('INSERT INTO proxy_drafts (order_id) VALUES (?)', orderId);
    await db.run(`INSERT INTO order_shipping
        (order_id, name, phone, address, note, invoice_title, invoice_tax_no)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      orderId, shippingInfo.name, shippingInfo.phone, shippingInfo.address, noteText,
      invoiceInfo.title, invoiceInfo.taxNo);
    // `refund_status` / `after_sale_status` 落在默认档（'none'）：本地此刻确实没发生过这两件事，
    // 写 'none' 与留默认值是同一个意思，所以只给这一行它独有的那一列。
    await db.run('INSERT INTO order_chain (order_id, escrow_order_id) VALUES (?, ?)', orderId, orderIdHex);
    return null;
  });
  if (created?.fail) return fail(res, created.fail);
  const order = await findOrder(id);
  // 创建者视角返回（本人下单=buyer 视角、店主代下单=owner 视角），收货信息等私有字段可回显
  ok(res, await orderToPublic(order, { as: me === target ? 'buyer' : 'owner' }), '订单草稿已创建，请在钱包内完成托管支付');
}));

// ── 查询 ──

/** 买家视角列表（公开；订单归属由买家地址查询，信息量不敏感） */
router.get('/', publicListLimiter, wrap(async (req, res) => {
  const { address } = req.query;
  if (!address || !isAddress(String(address))) return fail(res, '缺少 address 参数（买家地址）');
  const buyer = String(address).toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  if (page > 10_000) return fail(res, 'page 过大：请缩小范围或使用更精确的筛选', 1, 400);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  /*
    草稿行不出现在**非本人**的按地址列表里：地址本身是公开的，草稿的 order_no 又是
    匿名详情的钥匙；若列表把 order_no 交给任何知道买家地址的人，就能组合出
    “列表 → 详情 → escrowOrderId → 抢先 createOrder 占位”的支付 DoS。
    本人（令牌地址 == address）仍能看到自己的草稿；未登录/第三人只看已上链或终态单。
  */
  const auth = await optionalAuth(req);
  const buyerSelf = !!auth && String(auth.address || '').toLowerCase() === buyer;
  let where = 'buyer = ?';
  const params = [buyer];
  if (!buyerSelf) where += " AND status <> 'draft'";
  if (req.query.status) {
    const st = String(req.query.status);
    if (!ORDER_STATUS.includes(st)) return fail(res, `status 无效（可选：${ORDER_STATUS.join('/')}）`);
    where += ' AND status = ?';
    params.push(st);
  }
  const db = getDb();
  const total = (await db.get(`SELECT COUNT(*) AS c FROM v_orders WHERE ${where}`, ...params)).c;
  const rows = await db.all(`SELECT * FROM v_orders WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
  const preloaded = await preloadOrderRelations(rows);
  // 兑换码为敏感字段：仅当请求者携带有效登录令牌且为本单买家时可见（防未登录探码）
  const orders = await Promise.all(
    rows.map((o) => orderToPublic(o, { as: buyerSelf ? 'buyer' : null, preloaded }))
  );
  ok(res, { orders, total, page, pageSize });
}));

/** 店主待处理计数（卖家面板徽标：待发货/退款待处理/争议中等）。
 *  **谓词与实现在 opsMetrics.sellerTodoCounts（唯一实现）**：运营读数端点 `/api/shop/metrics`
 *  读的是同一份——徽标与指标各写一遍 SQL 必然漂移（徽标说 3 单、列表翻出 4 单）。 */
router.get('/seller/status-counts', staffOnly, wrap(async (req, res) => {
  ok(res, await sellerTodoCounts(req.shop.seller));
}));

/** 店主批量发货（P1-②：实物同物流单号；仅 physical ∧ escrowed ∧ 有凭证 ∧ 非退款冻结）。
 *  预校验全量（任一不符列 failed 原因，不半写）；成功的逐单发 order.shipped 通知。
 *  `ids` 是**订单号**（公开标识），返回的 shipped/failed 也是订单号。 */
router.post('/seller/batch-ship', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const ids = [...new Set((req.body?.ids || []).map((x) => String(x)).filter(Boolean))];
  if (!ids.length) return fail(res, 'ids 需为订单号数组（1..50）');
  // 超限直接拒绝而非静默截断——跨页勾选 >50 时截断会让卖家误以为全部已发（卖家侧审计 ①）
  if (ids.length > 50) return fail(res, `单次批量发货最多 50 单（当前勾选 ${ids.length} 单）：请减少勾选后分批提交`);
  /*
    空单号允许（= 自提/线下交付，与单发 POST /:id/ship 同口径），但**留空落 NULL、不落空串**：
    `tracking_no` 的三态是「有单号 / NULL = 没有这个事实」，空串是第三种表示，于是
    "店主没填"与"填了个空"在库里分不开、在查询里也各判一套（新 schema 已把 `''` 从这几列上删掉）。
    `shipped_at` 才是"已交付"的判据（自提单也发得了货）。
  */
  const trackingNo = String(req.body?.trackingNo ?? '').trim().slice(0, 100) || null;
  // 承运方名称：与单笔发货**同一归一**（src/shipping.js）——批量勾选的通常是同一家承运，
  // 所以整批写同一个值；留空同样落 NULL（未填），不留空串
  const carrier = normalizeCarrier(req.body?.carrier);

  const marks = ids.map(() => '?').join(',');
  /*
    店铺维度是这条查询的**安全边界**（2026-10-15 修）：此前只按 id 取行，于是一家店的店员
    可以把**别店**的订单 id 混进来一起"发货"（写运单号、推状态、发通知全都会成功）。
    加上 `shop_code` 之后，别店的 id 在下面按"订单不存在"处理——与单笔发货同款回答。
    `ids` 是**订单号**（前端的公开标识），所以这里按 order_no 取；行仍从读模型视图读全
    （下面要 `product_snapshot` 判 kind、要 `paid_tx_hash` 判凭证，两者分住在两张表里）。
  */
  const rows = await db.all(`SELECT * FROM v_orders WHERE order_no IN (${marks}) AND shop_code = ?`, ...ids, String(req.shop.code));
  const byId = new Map(rows.map((r) => [r.order_no, r]));
  const failed = [];
  const okIds = [];
  /*
    本地条件先筛（同步、零成本），**链上判据留到最后一起问**：
    `deliveryGate` 是"链上 status=Created 且 refundRequested=false"的唯一判据
    （见 chainOrder.js），不再看本地镜像 `refund_status`（它按 finality 深度滞后）。
    这里把候选单**并发**送进闸而不是逐单 await：ethers v6 会把同一 tick 发出的读取打包成
    一次 JSON-RPC 请求（batchMaxCount 默认 100，与 chainOrder 里那句注释同款），
    于是 50 单的网络往返从 50 次降到 1 次——逐单 await 的话，公共 RPC 上 50×几百毫秒
    会让店主在浏览器里等到超时。闸本身不抛错（判别式），Promise.all 不会被单笔读失败带崩。
  */
  const candidates = [];
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
    else candidates.push(o);
  }
  const gates = await Promise.all(candidates.map((o) => deliveryGate(o)));
  candidates.forEach((o, i) => {
    const gate = gates[i];
    if (!gate.ok) failed.push({ id: o.order_no, reason: gate.message });
    else okIds.push(o.order_no);
  });
  /*
    **认领按 changes 对齐**（P1，2026-10）：`okIds` 来自"闸之前的本地读 + 一次链上 RPC"，
    那次读与这次 UPDATE 之间隔着一次网络往返；单发 `POST /:id/ship` 的写法始终是
    「`changes !== 1` 就如实拒绝」，批量这边此前却在 UPDATE 不命中时照样回报"已发货 N 单"
    并逐单发 `order.shipped` 通知——店主以为发出去了、后台没有，通知还告诉了他一次假事实。

    形状改成**逐行条件更新**：每行自己回答"这次是不是我认领的"，`changes=1` 才算。
    `paid_tx_hash` 的 EXISTS 守卫也补上（与单发同款）：凭证是"真金白银入金"的不变量，
    它不是这次批量读之后还能被信任的本地字段。
    整个循环在一个事务里：要么这批认领一起可见，要么都不落（通知在提交之后才发）。
  */
  const claimed = [];
  if (okIds.length) {
    const now = new Date();
    const won = await withTransaction(async () => {
      const ids = [];
      for (const no of okIds) {
        const r = await db.run(
          `UPDATE orders SET status = 'shipped', tracking_no = ?, carrier = ?, shipped_at = ?, updated_at = ?
            WHERE order_no = ? AND status = 'escrowed'
              AND EXISTS (SELECT 1 FROM order_chain c WHERE c.order_id = orders.id AND c.paid_tx_hash IS NOT NULL)`,
          trackingNo,
          carrier,
          now,
          now,
          no
        );
        if (r.changes === 1) ids.push(no);
      }
      return ids;
    });
    for (const no of won) claimed.push(no);
    for (const no of okIds) {
      if (won.includes(no)) continue;
      failed.push({
        id: no,
        reason: '该单在批量校验后被并发修改（已被发货/取消/退款冻结，或支付凭证已不存在），本次未认领',
      });
    }
    for (const no of claimed) notify('order.shipped', no); // 只通知真正认领的行
  }
  await audit(req, 'order.batch_ship', 'order', claimed.join(',') || '-', { shipped: claimed.length, failed: failed.length, carrierFilled: !!carrier }, req.shop.code);
  ok(res, { shipped: claimed, failed }, claimed.length ? `已批量发货 ${claimed.length} 单` : '无符合批量发货条件的订单');
}));

/**
 * 店主视角列表（**本店**全量订单，需该店店主/店员登录；卖家面板用，码全程可见）。
 *
 * 🔴 店铺维度是这条查询的**安全边界**，不是筛选条件：多店之前它是 `WHERE 1=1`
 * （整个节点一个卖家，等价），多店之后同一条 SQL 会让 **A 店店员读到 B 店全部订单**——
 * 含买家地址、收货信息、备注、交付码原文。所以过滤写在**路由查出来的 SQL 里**，
 * 不是渲染层再筛一遍（渲染层的洞是"换一个出口就再漏一次"）。
 */
router.get('/seller', staffOnly, wrap(async (req, res) => {
  const page = Math.max(1, Math.ceil(parseInt(req.query.page, 10) || 1));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  // 店铺限定放**第一项且写死在 SQL 文本里**：`sellerOrderFilters` 只返回筛选条件，
  // 不再把安全边界藏进返回值（判据是 `shop_code` 这条外键，而不是 `lower(seller)`——
  // 订单归属随下单那一行落定，不随链上读数或地址大小写变化）。
  const filters = sellerOrderFilters(req.query);
  if ('error' in filters) return fail(res, filters.error);
  const { where, params } = filters;
  const db = getDb();
  const total = (await db.get(`SELECT COUNT(*) AS c FROM v_orders WHERE shop_code = ? AND ${where}`, String(req.shop.code), ...params)).c;
  const rows = await db.all(`SELECT * FROM v_orders WHERE shop_code = ? AND ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, String(req.shop.code), ...params, pageSize, offset);
  const preloaded = await preloadOrderRelations(rows);
  /*
    `poolEmpty` 必须 await：它是一次真正的库查询（池内可用量与已交付行数，见 poolAlert.js）。
    漏掉 await 时 `JSON.stringify` 会把 Promise 序列化成 `{}` —— 卖家面板读到的
    `poolEmpty` 于是恒为"真值对象"，缺货提示永不显示，而响应仍是 200、没有任何报错。
  */
  const orders = await Promise.all(rows.map(async (o) => ({ ...(await orderToPublic(o, { as: 'owner', preloaded })), poolEmpty: await isPoolEmpty(o) })));
  ok(res, { orders, total, page, pageSize });
}));

/**
 * 店主收款流水：已入账（买家确认/仲裁判付/超时释放）订单汇总 + 分页列表（需 owner 登录）。
 * summary 金额在 JS 侧 **BigInt** 累加：wei 是 `DECIMAL(38,0)`（库给回十进制字符串，见 db.js），
 * 38 位整数根本进不了 JS number；`usdt_micro` 虽在安全整数内，但累加多单后同样会漂，
 * 而这里的合计是要拿去和链上对账的整数金额。
 * 入账时间取订单 updated_at（最后一次状态迁移时刻，由 watcher/同步写入）。
 */
router.get('/seller/ledger', ownerOnly, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const marks = INCOME_STATUS.map(() => '?').join(',');
  const db = getDb();

  // 可选入账时间范围（?from=ms&to=ms，入账口径 = 订单 updated_at 末次状态迁移时刻）。
  // 非法/NaN/负值/from>to 此前静默忽略或空集，改为显式业务拒绝
  const range = [];
  const rangeParams = [];
  /*
    店铺限定**写死在下面两条 SQL 文本里**（理由同 /seller：多店之下这是安全边界，判据是
    那一条外键）。`range` 只放时间条件，汇总与分页共用 ⇒ 两处口径不可能分叉。
    参数顺序必须与 SQL 里 ? 的出现顺序一致：店铺编号在最前，随后是 INCOME_STATUS 的 marks，
    最后才是 range 各项。
  */
  const rawFrom = req.query.from;
  const rawTo = req.query.to;
  const fromMs = rawFrom === undefined || rawFrom === '' ? null : parseInt(rawFrom, 10);
  const toMs = rawTo === undefined || rawTo === '' ? null : parseInt(rawTo, 10);
  if (fromMs !== null && (!Number.isFinite(fromMs) || fromMs <= 0)) return fail(res, 'from 需为毫秒时间戳');
  if (toMs !== null && (!Number.isFinite(toMs) || toMs <= 0)) return fail(res, 'to 需为毫秒时间戳');
  if (fromMs !== null && toMs !== null && fromMs > toMs) return fail(res, 'from 不得晚于 to');
  /*
    查询串仍是毫秒（前端契约不变），但**参数化的是 `Date`**——`updated_at` 现在是 DATETIME(3)，
    把毫秒整数交给 MySQL 会被当数字字面量解析成一个荒谬的时间（且不报错）。
  */
  if (fromMs !== null) {
    range.push('updated_at >= ?');
    rangeParams.push(new Date(fromMs));
  }
  if (toMs !== null) {
    range.push('updated_at <= ?');
    rangeParams.push(new Date(toMs));
  }
  const rangeSql = range.length ? ` AND ${range.join(' AND ')}` : '';

  /*
    汇总：仅扫金额相关列，避免全表字段开销。金额在 JS 侧 **BigInt 累加**（理由见路由头）：
    `amount_wei` / `refunded_amount_wei` 是 `DECIMAL(38,0)` ⇒ 库给回**十进制字符串**，
    `usdt_micro` 是安全整数但多单累加会漂。所以一律 BigInt 进、字符串出；只有"单数"是普通计数。

    **零费模型的两腿口径**（与链上 `Escrow._settle` 逐字一致）：
      毛额     = amount_wei
      已退买家 = refunded_amount_wei          （已退的部分不参与结算）
      实收净额 = 毛额 − 已退买家               （余数全归店主 ⇒ 与链上一样永不多付一分）

    **三态**：`refunded_amount_wei` 是 `NOT NULL DEFAULT 0`，正常永远读得到；视图的 LEFT JOIN
    会在链上镜像行缺席时给出 NULL（人工动过库才会发生的行）。**缺席不折成 0**：它与"链上确证
    没退过款"是两件事，折成 0 会让"已退合计"偏小、净额偏大，而店主正是拿这个数去对账的。
    任一行未知 ⇒ 这一腿整体是 null（前端印 —）。

    `refunded_amount_wei` 住在 order_chain，所以这一读走读模型视图（三表 JOIN 一次读全）。
  */
  const incomeRows = await db.all(`SELECT status, amount_wei, usdt_micro, refunded_amount_wei,
      payment_token, payment_symbol, payment_decimals, bty_usdt_rate, token_usdt_micro_per_token
      FROM v_orders WHERE shop_code = ? AND status IN (${marks})${rangeSql}`, String(req.shop.code), ...INCOME_STATUS, ...rangeParams);
  /**
   * 累加一条金额腿：任一行未知 ⇒ 该腿合计恒为 null（未知），后续再累也回不来 —— 这就是"不知道"的传播。
   *
   * ⚠️ **累加器不是 BigInt 就当场抛错**（2026-10-16 修一个静默的形状缺陷）：本函数的契约是
   * "BigInt 累加器"，而此前 `byStatus` 分桶的初值被写成**字符串** `'0'` ⇒ `'0' + BigInt(v)`
   * 走的是 `String + BigInt` = **字符串拼接**：接口照常 200，而金额字段返回的是 N 个十进制串
   * 首尾相接。同一个函数在两个调用点语义不同，正是"判据挂在调用点"的典型形态；
   * 所以判据落进函数本身：类型不对就不可能悄悄算下去。
   */
  const addLeg = (acc, v) => {
    if (v === null || v === undefined) return null;
    // 未知一旦出现就保持未知；不能下一行再拿 null 当累加器抛 500（读不到不是内部错误）。
    if (acc === null) return null;
    if (typeof acc !== 'bigint') {
      throw new Error(`addLeg 的累加器必须是 BigInt（收到 ${typeof acc}：${String(acc)}）——字符串累加会静默变成拼接`);
    }
    return acc + BigInt(v);
  };
  const byStatus = {};
  let totalCount = 0;
  let usdtMicro = 0n;
  let amountWei = 0n;
  let refundedWei = 0n;
  let netWei = 0n;
  let usdtNetMicro = 0n;
  let refundedUsdtMicro = 0n;
  let mixedAssets = false;
  for (const r of incomeRows) {
    const refunded = r.refunded_amount_wei === null || r.refunded_amount_wei === undefined ? null : BigInt(r.refunded_amount_wei);
    const net = refunded === null ? null : BigInt(r.amount_wei) - refunded;
    const refundUsdt = refundUsdtMicroOfRow(r);
    const netUsdt = refunded === null ? null : BigInt(r.usdt_micro) - refundUsdt;
    /*
      wei 汇总只加原生：ERC20 的 amount_wei 是 token 最小单位（6 位 USDT 的 1e6 与 18 位
      BTY 的 1e18 不可相加）。跨资产总额只走微 USDT 那三列；mixedAssets=true 让前端知道
      “amountWei 是原生口径”，而不是把它当所有资产的总和。
    */
    const isNative = !r.payment_token || /^0x0{40}$/.test(String(r.payment_token).toLowerCase());
    if (!isNative) mixedAssets = true;
    /*
      分桶初值全部是 **BigInt**（0n），与总计那四个计数器同型——见 `addLeg` 的说明。
      出口时才 `.toString()`（DECIMAL 的对外口径就是字符串），形状只在边界处折一次。
    */
    const s = (byStatus[r.status] ??= {
      count: 0,
      usdtMicro: 0n,
      amountWei: 0n,
      refundedWei: 0n,
      amountWeiNet: 0n,
      usdtNetMicro: 0n,
      refundedUsdtMicro: 0n,
    });
    totalCount += 1;
    usdtMicro += BigInt(Math.trunc(Number(r.usdt_micro)));
    usdtNetMicro = addLeg(usdtNetMicro, netUsdt);
    refundedUsdtMicro = addLeg(refundedUsdtMicro, refundUsdt);
    s.count += 1;
    s.usdtMicro = BigInt(s.usdtMicro) + BigInt(Math.trunc(Number(r.usdt_micro)));
    if (isNative) {
      amountWei += BigInt(r.amount_wei);
      refundedWei = addLeg(refundedWei, refunded);
      netWei = addLeg(netWei, net);
      s.amountWei = BigInt(s.amountWei) + BigInt(r.amount_wei);
      s.refundedWei = addLeg(s.refundedWei, refunded);
      s.amountWeiNet = addLeg(s.amountWeiNet, net);
    }
    s.usdtNetMicro = addLeg(s.usdtNetMicro, netUsdt);
    s.refundedUsdtMicro = addLeg(s.refundedUsdtMicro, refundUsdt);
  }

  const rows = await db.all(`SELECT * FROM v_orders WHERE shop_code = ? AND status IN (${marks})${rangeSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, String(req.shop.code), ...INCOME_STATUS, ...rangeParams, pageSize, offset);
  const ledgerOrders = await Promise.all(rows.map(async (o) => {
    const refunded = readRefundedWei(o.refunded_amount_wei);
    const amount = readRefundedWei(o.amount_wei);
    return {
      ...(await orderToPublic(o, { as: 'owner' })),
      refundedWei: o.refunded_amount_wei ?? null,
      /** 实收净额 = 毛额 − 已退买家（与链上 `sellerNetAtSettle` 同一口径与实际值）；读不到即 null */
      amountWeiNet: refunded === null || amount === null ? null : (amount - refunded).toString(),
      /** 跨资产口径的实收净额（微 USDT；ERC20 单按锁定行情折算退款） */
      amountUsdtNetMicro:
        refunded === null ? null : (BigInt(o.usdt_micro) - refundUsdtMicroOfRow(o)).toString(),
      refundedUsdtMicro: refundUsdtMicroOfRow(o).toString(),
    };
  }));
  ok(res, {
    orders: ledgerOrders,
    total: totalCount,
    page,
    pageSize,
    summary: {
      count: totalCount,
      /* 微 USDT 汇总与 wei 侧同款：BigInt 累加、字符串出参（Number 累加在 9.007e15 以上会漂） */
      usdtMicro: usdtMicro.toString(),
      amountUsdtNetMicro: usdtNetMicro === null ? null : usdtNetMicro.toString(),
      refundedUsdtMicro: refundedUsdtMicro === null ? null : refundedUsdtMicro.toString(),
      /** amountWei/refundedWei/amountWeiNet 只汇总原生 BTY；ERC20 见下面的微 USDT 三列 */
      mixedAssets,
      amountWei: amountWei.toString(),
      /* 已退合计同净额：有任何一行读不到就是 null（不是 0） */
      refundedWei: refundedWei === null ? null : refundedWei.toString(),
      amountWeiNet: netWei === null ? null : netWei.toString(),
      /*
        按状态分桶：**出口这里把 BigInt 折成字符串**（与总计那几个数同一个口径）。
        计数保持 number，金额一律字符串或 null —— `null` 仍然表示"这一桶里有行读不到"，
        与 `0` 是两件事（三态纪律）。
      */
      byStatus: Object.fromEntries(
        Object.entries(byStatus).map(([k, b]) => [
          k,
          {
            count: b.count,
            usdtMicro: b.usdtMicro.toString(),
            amountWei: b.amountWei.toString(),
            refundedWei: b.refundedWei === null ? null : b.refundedWei.toString(),
            amountWeiNet: b.amountWeiNet === null ? null : b.amountWeiNet.toString(),
            amountUsdtNetMicro: b.usdtNetMicro === null ? null : b.usdtNetMicro.toString(),
            refundedUsdtMicro: b.refundedUsdtMicro === null ? null : b.refundedUsdtMicro.toString(),
          },
        ])
      ),
    },
  });
}));

/** 订单详情（公开只读；码仅对买家本人/店主/链上仲裁人可见；售后陈述同码可见矩阵） */
router.get('/:id', publicDetailLimiter, wrap(async (req, res) => {
  const order = await findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const auth = await optionalAuth(req);
  // 经营人员判据取**这张订单所属店铺**（订单面的店铺上下文来自订单行，不是请求头）
  let as = null;
  if (auth) {
    if (auth.address === order.buyer) as = 'buyer';
    else if (await isStaff(auth.address, order.shop_code || '', { force: true })) as = 'owner';
    // 争议裁决证据开放：仅 disputed 单对仲裁人开码（正常在途单的交付码不属于裁决证据，
    // 仲裁人无查看必要——收紧隐私面）。
    // `isArbiterForOrder()` 在**委员会读不到**时恒 false ⇒ 不开放
    // （2026-10-14：此前它会回退上次成功值，轮换过仲裁人之后旧密钥在 RPC 故障期间仍能开码；
    //  2026-10：判据只认**当前委员会名单**，不再按订单快照届次；换届后旧成员立即失去资格，
    //  当前成员可以处理旧单。
    // + 确认收货后的**售后案件**同样对仲裁人开放：案件由仲裁人结案、罚没（Staking.penalize）
    //   的资格门槛就是"案件在链上处于开启状态"，他必须能看到双方的 after_sale 陈述与附件才谈得上裁决；
    //   这类单的 status 是终局（settled/confirmed/expired），所以判据只能看案件在途标记
    //   （与附件下载端点 routes/evidenceFiles.js 的同一道判据共用 isAfterSaleOpen）。
    //   `force:true`：这是读 PII（交付码/双方陈述）的路径，换届/撤权后的缓存旧名单不能放行。
    else if ((order.status === 'disputed' || isAfterSaleOpen(order)) && (await isArbiterForOrder(auth.address, order.escrow_order_id, { force: true }))) as = 'arbiter';
  }
  // `poolEmpty` 必须 await（与列表同口径、同一个理由：它是查询结果，不是同步读数，见上面的说明）
  const body = { ...(await orderToPublic(order, { as, byOrderNo: true })), poolEmpty: await isPoolEmpty(order) };
  // 售后/争议陈述（dispute_evidence 时间线）：当事人（买家/店主）与争议裁决人（arbiter）可见，
  // 匿名/第三人不可见——陈述属私人交易上下文，不随公开字段泄露；按 id 升序即时间线顺序。
  // 读取侧限行（见 EVIDENCE_DETAIL_LIMIT）：取**最近** 100 条后再升序返回，附件元数据一次批量查
  // （filesOfEvidenceMany），不再逐行 filesOfEvidence（N+1）。
  if (as) {
    const total = (await getDb().get('SELECT COUNT(*) AS c FROM dispute_evidence WHERE order_id = ?', order.order_id)).c;
    const rows = (await getDb().all('SELECT id, role, phase, content, created_at FROM dispute_evidence WHERE order_id = ? ORDER BY id DESC LIMIT ?', order.order_id, EVIDENCE_DETAIL_LIMIT))
      .reverse();
    const filesByEvidence = await filesOfEvidenceMany(rows.map((e) => e.id));
    body.evidence = rows.map((e) => ({
      id: e.id,
      role: e.role,
      phase: e.phase,
      content: e.content,
      createdAt: e.created_at,
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
 * 同一规范哈希不得确认两单（预检 + `order_chain.paid_tx_hash` 上的唯一索引双保险）。
 */
router.post('/:id/paid', requireAuth, paidLimiter, wrap(async (req, res) => {
  const order = await findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  if (order.buyer !== req.auth.address) return fail(res, '仅买家本人可确认托管支付', 403, 403);
  const txHash = String(req.body?.txHash || '');
  const txHashValid = /^0x[0-9a-fA-F]{64}$/.test(txHash);
  if (txHash && !txHashValid) return fail(res, 'txHash 格式无效');

  if (order.status === 'escrowed' || order.status === 'shipped') {
    // 幂等（watcher 已回写/自动交付已完成/重复确认）：托管已确认（escrowed/shipped 均为链上
    // OrderCreated 已落定的镜像）——历史订单未落支付哈希时，带 txHash 则校验后补记规范哈希；
    // 校验失败仅告警（状态已是事实）；**哈希被别的订单占用则必须如实下发**（见下）。
    if (txHashValid && !order.paid_tx_hash) {
      const v = await verifyPaidReceipt(order, txHash);
      if (v.ok) {
        const r = await notePaidTxHash(order, v.canonicalHash);
        /*
          **一笔链上托管被两张单认领**是账目级异常，不能只留在 console（2026-10-16 收口）。
          此前的形状是"接口回 200 成功、异常只进日志"——而调用方（买家页面、脚本、
          第三方后台）拿到的结论是"一切正常"，要发现这件事只能靠翻日志。
          三态纪律的落地点在这里：**本单的状态是确证的（已托管），而"这笔支付归谁"是未决的**
          ——两者都要说出来，所以返回非零 code 但把状态读数一并带上（`fail` 的 data 参数）。
        */
        if (r && r.error === 'taken') {
          console.warn(`[paid] 支付哈希被占用（order=${order.order_no}，hash=${v.canonicalHash.slice(0, 18)}…）——该支付已确认过另一订单`);
          return fail(
            res,
            '本单已是托管状态；但这笔支付交易**已确认过另一订单**（同一笔链上托管被两张单认领）——' +
              '请勿据此重复发货，并联系节点运维核对账目',
            1,
            200,
            { id: order.order_no, status: order.status, paymentHashClaimedElsewhere: true }
          );
        }
      }
    }
    ok(res, { id: order.order_no, status: order.status }, '托管已确认');
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
    // 诊断链上同 orderId 是否已被"假托管"抢先占用：草稿的 escrowOrderId 对拿到详情链接的人
    // 可见（匿名列表不下发，但详情页按 order_no 返回），攻击者可对该 orderId 以 1 wei 链上建单（金额/卖家/买家与本地
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

  // 同一笔链上支付只能确认一个订单（一单一号 UUID orderId，防重由草稿层 UUID 保证；
  // `order_chain.paid_tx_hash` 的唯一索引兜底并发与存量异常）
  const db = getDb();
  const taken = await db.get('SELECT order_id FROM order_chain WHERE paid_tx_hash = ? AND order_id != ?', v.canonicalHash, order.order_id);
  if (taken) {
    return fail(res, '该支付交易已确认过另一订单（同一笔链上托管只能确认一单），如重复下单请先取消旧订单');
  }
  // draft 迁移前复核链上当前状态——收据只证明「曾发生本单 OrderCreated」，不证明
  // 当前仍 Created。若链上已终局（Refunded/Settled——仲裁判退/卖家已退款/超时释放判卖）或已
  // 争议（Disputed），本地仍 draft 属事件漏扫竞态，把草稿推进为 escrowed 会复活一笔资金早已
  // 定局的单并可能自动发码（已退款买家免费得码）。RPC 不可达时不阻断（收据校验已通过、
  // watcher/sync 稍后纠正），仅尽力复核。
  //
  // 注：**退款申请待决不在本复核里管**（2026-10-14 收口）。它的判据只在交付那一刻成立
  // （链上 `refundRequested`），而"迁移前读到的值"与"迁移后要不要发码"之间隔着一次写库 +
  // 一次 RPC 往返——用那个陈旧值当交付判据正是本节要修掉的错。发不发码现在只由
  // 交付路径自己按链上真值判（见下方 notify 之后的 `tryAutoDeliverByEscrowOrder`）。
  try {
    const cur = await fetchOnchainOrder(order.escrow_order_id);
    const st = String(cur?.status || 'Created');
    if (st === 'Refunded' || st === 'Settled' || st === 'Disputed') {
      const label = st === 'Refunded' ? '已退款' : st === 'Settled' ? '已成交（货款已结算，可能仍在售后留存期）' : '已进入争议（资金冻结）';
      return fail(
        res,
        `链上该托管单当前状态为「${label}」，但本地仍是未支付草稿（疑似事件漏扫/竞态）——请勿按支付确认处理；` +
          '请对该订单执行「同步链上状态」，让本地与链上终局一致（草稿占位将按终局释放）'
      );
    }
  } catch {
    /* RPC 不可达：跳过复核（收据校验已通过；watcher 会按事件纠正） */
  }
  let changed = 0;
  try {
    /*
      状态迁移 + 凭证认领 + 事件史补写同事务（防进程中断半写：escrowed 已推进但 OrderCreated
      事件史缺失，凭证链/信誉口径永久缺里程碑）；条件 `status='draft'` 与 watcher 并发回写
      竞态时只有一方推进。

      状态在 `orders`、凭证在 `order_chain` ⇒ 两条**各自带守卫**的语句（不用多表 UPDATE，
      理由见上方"跨表守卫的写法"）。顺序是**先状态、后凭证**：
        · 状态先动，`status='draft'` 就是这次迁移的原子认领（`changed` 取它的 changes）；
        · 凭证认领带 EXISTS 状态守卫 —— 草稿刚被清扫成 cancelled 时那一笔支付**不得**落哈希
          （watcher 的自动恢复以「cancelled 且无凭证」为前置，落了哈希那一单就再也救不回来）。
    */
    changed = await withTransaction(async () => {
      const moved = (await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE id = ? AND status = 'draft'", new Date(), order.order_id)).changes;
      await db.run(`UPDATE order_chain c SET c.paid_tx_hash = ?
           WHERE c.order_id = ? AND c.paid_tx_hash IS NULL
             AND EXISTS (SELECT 1 FROM orders o WHERE o.id = c.order_id AND o.status IN ${PRE_PAID_IN})`, v.canonicalHash, order.order_id);
      // paid 快路径不迁移 watcher 事件（见 appendOrderCreatedEvent）：迁移成功即补写事件史，
      // 保证详情页凭证链与信誉画像口径一致（watcher 已先行记录时幂等跳过）
      if (moved === 1) await appendOrderCreatedEvent(order.order_id, { txHash: v.canonicalHash, block: v.blockNumber });
      return moved;
    });
  } catch (e) {
    // 唯一索引兜底（MySQL 的 ER_DUP_ENTRY）：同一笔链上支付被并发确认到两张单上
    if (/ER_DUP_ENTRY|Duplicate entry/i.test(String(e.code || '') + ' ' + String(e.message || ''))) {
      return fail(res, '该支付交易已确认过另一订单（同一笔链上托管只能确认一单）');
    }
    throw e;
  }
  if (changed === 0) {
    // 并发竞态：watcher 已先行回写 escrowed（paid_tx_hash 仍空）→ 补记哈希后幂等返回；
    // 也可能订单已被并发取消/清扫（cancelled）——notePaidTxHash 有意不向取消行落哈希，
    // 回查真实状态给出正确引导而非谎报"托管已确认"（审计 F2）
    const r = await notePaidTxHash(order, v.canonicalHash);
    if (r && r.error === 'taken') {
      // 同上一处：账目级异常必须出现在结论里，不能只进日志（理由见那里）
      console.warn(`[paid] 支付哈希被占用（order=${order.order_no}，hash=${v.canonicalHash.slice(0, 18)}…）——该支付已确认过另一订单`);
      return fail(
        res,
        '本单托管已确认；但这笔支付交易**已确认过另一订单**（同一笔链上托管被两张单认领）——' +
          '请勿据此重复发货，并联系节点运维核对账目',
        1,
        200,
        { id: order.order_no, status: 'escrowed', paymentHashClaimedElsewhere: true }
      );
    }
    const rowNow = await db.get('SELECT status FROM orders WHERE id = ?', order.order_id);
    if (rowNow && rowNow.status === 'cancelled') {
      return ok(
        res,
        { id: order.order_no, status: 'cancelled' },
        '该订单刚被取消（草稿超时关闭或手动取消）；你的链上托管支付已确认，节点检测到托管事件后会自动恢复该订单（或稍后对该订单执行「同步链上状态」）'
      );
    }
    ok(res, { id: order.order_no, status: 'escrowed' }, '托管已确认');
    return;
  }
  // 订单级**已退金额**快照补录（链上 getOrder 权威；供收款流水净额/退款口径）。
  //
  // 补录失败**不改控制流**（链上那笔钱已经锁在托管里，这里绝不能变成 500 把买家拦在"托管已确认"
  // 之外），但也**不再完全静默**（2026-10）：读不到链上 getOrder 时这一列会留在默认值上
  //（refunded_amount_wei=0），本单净额退回毛额口径，直到 watcher/sync 路径再补——
  // 这件事必须留下一条可查的痕。
  try {
    const onchain = await fetchOnchainOrder(order.escrow_order_id);
    /*
      已退金额是**链上事实**（列在 order_chain），遵守三态：链上没有这个字段
      （读到 undefined/null/非数字）时保持库里原值，不写 0——`refunded_amount_wei` 参与
      "卖家实收净额"的口径，写一个凭空的 0 等于宣称"这单没退过款"。
    */
    const refundedRaw = onchain?.refundedAmount;
    const refunded = refundedRaw === undefined || refundedRaw === null ? '' : String(refundedRaw).trim();
    if (/^\d+$/.test(refunded)) {
      // 已退金额住在链上镜像表：按 order_id 写 order_chain（orders 表里已经没有这一列）
      await db.run('UPDATE order_chain SET refunded_amount_wei = ? WHERE order_id = ?', refunded, order.order_id);
    }
  } catch (e) {
    console.warn(
      `[paid] 链上补录失败（order=${order.order_no} escrowOrderId=${String(order.escrow_order_id).slice(0, 18)}…）：${e?.message || e}——` +
        `本单的 refunded_amount_wei 仍是默认值（净额按毛额口径），` +
        `订单状态不受影响；后续由 escrowWatcher / POST /:id/sync 补录`
    );
  }
  // 卡密自动交付：数字商品且码池有未用码 → 自动发码置 shipped（买家立即可见兑换码）。
  // 通知顺序：escrowed（托管成功）先于 shipped（自动交付）——与 watcher 路径一致。
  //
  // 交付判据**必须在链上**（2026-10-14 收口）：这里此前调 `tryAutoDeliverById(order.id)`
  //（只读本地镜像 `refund_status`），而买家完全可以在 `createOrder` 之后、本请求返回之前
  // 补一笔 `requestRefund` —— 那时本地镜像按定义还没跟上（watcher 的扫描上界是
  // `head − finalityBlocks`，默认 12 块 ≈ 1 分钟），于是码照发、钱冻在托管里，
  // 卖家只能拒绝 → 争议 → 仲裁（本仓注释里写的"双损"）。`/paid` 恰恰是**唯一**落在
  // 那个滞后窗口正中间的交付入口，所以这条不是"少一层校验"，而是判据挂错了层。
  // 现在按链上单号走 `tryAutoDeliverByEscrowOrder`（全模块唯一交付入口，链上 Created 且未申请退款才发；
  // 读不到链上真值就不发，留给卖家面板手动交付）——本行**不再**有第二个答案。
  notify('order.escrowed', order.order_no);
  let autoDelivered = false;
  try {
    autoDelivered = await tryAutoDeliverByEscrowOrder(order.escrow_order_id);
  } catch (e) {
    // 交付失败不影响"托管已确认"这个事实（状态已落库）；watcher / 补货补跑会再试
    console.error(`[paid] 自动交付失败（不影响托管确认）order=${order.order_no}: ${e?.message || e}`);
  }
  /*
    池式商品主动告警（2026-09）：草稿创建到支付之间池子可能被别的订单掏空，此时买家钱已上链、
    却没有可交付资源——此前只有卖家面板的 poolEmpty 标着（卖家不看就不知道）。放在自动交付
    之后判断：交付成功说明资源本来够（订单已 shipped，判定自然不成立），失败的才是真缺口。
    每单至多告警一次（`order_alerts(order_id, kind='pool_empty')` 的主键去重，见 poolAlert.js）。
    参数是**内部 order_id**：告警去重表的键就是它（不是订单号，也不是链上单号）。
    ⚠️ 本函数是 async（读库 + 外呼），**必须 await**：不 await 的话它抛错时会变成一条
    unhandled rejection（Node 默认把进程带走），而"托管已确认"这个已落库的事实也跟着一起丢。
    它自己不抛错（内部 try/catch），这里再兜一层只是不让告警影响响应。
  */
  try {
    await alertPoolEmptyForOrder(order.order_id);
  } catch (e) {
    console.warn(`[paid] 池缺货告警失败（不影响托管确认）order=${order.order_no}: ${e?.message || e}`);
  }
  ok(
    res,
    { id: order.order_no, status: 'escrowed', autoDelivered },
    autoDelivered ? '托管确认成功，卡密已自动交付' : '托管确认成功，等待卖家发货'
  );
}));

/**
 * 数字商品手动交付：交付文本按行解析（每行一个码/说明），行数必须 = quantity；
 * 逐行与码池联动——命中池内 unused 码事务占用（防并发重复发放），命中 used 码拒绝（防重发），
 * 池外自由文本（说明型交付）直接落子表。全部通过后置 shipped。
 * 返回 { codes } 或 { error: 'pool_empty'|'conflict'|'code_used'|'not_escrowed'|'line_mismatch', message }。
 */
async function deliverDigitalManual(order, manualText) {
  const db = getDb();
  const codes = String(manualText || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  const qty = order.quantity;
  if (codes.length !== qty) {
    return { error: 'line_mismatch', message: `手动交付需恰好 ${qty} 行（每行一个码/说明），实际 ${codes.length} 行` };
  }
  // 每行长度上限与码池导入一致（200 字符），防超长自由文本撑爆交付物
  const overLong = codes.findIndex((c) => c.length > 200);
  if (overLong >= 0) {
    return { error: 'line_too_long', message: `第 ${overLong + 1} 行交付内容超过 200 字符上限，请拆分或缩短` };
  }
  // 时间一律 `Date`（DATETIME(3) 列）：`Date.now()` 是毫秒整数，交给 MySQL 会被当数字字面量
  // 解析成一个荒谬的时间且不报错（见 db.js 的时间口径）。
  const now = new Date();
  /*
    码池占用（逐行 SELECT + 条件 UPDATE）+ 订单置 shipped + 落交付行**同一个事务**：
    条件 UPDATE 的 `changes !== 1` 是并发重复发放的唯一判据（见 db.js 对 changes 语义的说明），
    它必须与"插交付行"同一次提交，否则会出现「码已占用、交付行没落」或反过来的半写。
    本地写都在这一个回调里；没有 RPC/网络调用（符合 db.js 的约束）。
  */
  const outcome = await withTransaction(async () => {
    for (const code of codes) {
      const hit = await db.get('SELECT id, status FROM product_codes WHERE product_id = ? AND code = ?', order.product_id, code);
      if (!hit) continue; // 池外自由文本：无联动
      if (hit.status === 'used') {
        return abortTx({ error: 'code_used', message: `兑换码“${code.slice(0, 24)}…”已在其他订单发放过，请更换（留空则自动从码池分配）` });
      }
      // 池行的 order_id 是 orders.id 的外键 ⇒ 写**内部 order_id**（订单号在库里不是键）
      const ch = (await db.run("UPDATE product_codes SET status = 'used', order_id = ?, used_at = ? WHERE id = ? AND status = 'unused'", order.order_id, now, hit.id)).changes;
      if (ch !== 1) {
        return abortTx({ error: 'conflict', message: '兑换码分配冲突，请重试' });
      }
    }
    const moved = await db.run("UPDATE orders SET status = 'shipped', shipped_at = ?, updated_at = ? WHERE id = ? AND status = 'escrowed'", now, now, order.order_id);
    if (moved.changes !== 1) {
      return abortTx({ error: 'not_escrowed', message: `当前状态(${order.status})不可发货，需买家托管成功` });
    }
    for (const code of codes) {
      // `created_at` 交给服务器默认值（CURRENT_TIMESTAMP(3)）：交付时刻是"这一行什么时候落的"，
      // 应用端没必要也不该自己盖章（同一个事务里的多行本来就是同一时刻）。
      await db.run('INSERT INTO order_delivery_items (order_id, kind, value) VALUES (?, ?, ?)', order.order_id, 'code', code);
    }
    return { codes };
  });
  return outcome;
}

/**
 * 店主发货：
 *  - 实物：写入物流单号 trackingNo（可空，兼容自提等交付方式）；
 *  - 数字：手动交付内容（deliveryCode，多行=多码）按行解析联动码池；留空则事务内从码池
 *    分配 quantity 个未用码（池不足拒绝发货）——见 deliverDigitalManual / deliverDigitalFromPool。
 *  - NFT：见 POST /:id/nft-deliveries（本接口不处理 NFT）。
 */
router.post('/:id/ship', staffOnly, wrap(async (req, res) => {
  // 店铺作用域**就是取订单这一步**（见 src/orderScope.js）：别店的单在这里按"不存在"处理
  const order = await findOrderInShop(req.params.id, req.shop.code);
  if (!order) return fail(res, '订单不存在', 404, 404);
  if (order.status !== 'escrowed') return fail(res, `当前状态(${order.status})不可发货，需买家托管成功`);
  // 发货防呆（支付凭证不变量，见文件头注释）：正常路径（watcher/paid/sync）落库时必带
  // 链上规范哈希；空哈希的 escrowed 单说明从未获真实入金确认（watcher 回写窗口内的
  // 竞态/异常残留），发货将白送货物或码——先同步（/sync 会按链上创建块反查事件补落哈希）
  // 仍为空则属异常单，需店主核账（可调 /cancel 清理）。
  if (!order.paid_tx_hash) {
    return fail(
      res,
      '该订单缺少链上支付凭证（order_chain.paid_tx_hash 为空），无法发货——请先对该订单执行同步补齐凭证；若同步后仍为空说明本地状态异常，可取消该单后由买家重新下单'
    );
  }
  // 两级售后门控：**判据只有交付闸一处**（`chainOrder.deliveryGate` 读链上真值：
  // status=Created 且 refundRequested=false 才放行；读不到则拒绝）——发货后若卖家再同意退款
  // 将钱货两失，应先链上 rejectRefund 拒绝申请再发货，或直接 approveRefund。
  // 此前这里读的是本地镜像 `refund_status`，而它是 watcher 按 finality 深度回写的，
  // 买家"托管后立刻申请退款"的那 12 块里必然是 none ⇒ 货照发、钱冻住（见 deliveryGate 说明）。
  const gate = await deliveryGate(order);
  if (!gate.ok) return fail(res, gate.message);
  const db = getDb();
  let snap = {};
  try {
    snap = JSON.parse(order.product_snapshot || '{}');
  } catch {
    snap = {};
  }
  const now = new Date();

  if (snap.kind === 'nft') {
    return fail(res, 'NFT 交付请使用 POST /api/orders/:id/nft-deliveries（支持多枚/批量哈希核验）');
  }

  if (snap.kind === 'digital') {
    const manual = String(req.body?.deliveryCode || req.body?.trackingNo || '').trim();
    if (manual) {
      // 手动交付（卖家直填，按行=多码，与码池联动）
      const r = await deliverDigitalManual(order, manual);
      if (r.error) return fail(res, r.message);
      notify('order.shipped', order.order_no); // 卖家通知：手动交付完成
      await audit(req, 'order.ship', 'order', order.order_no, { kind: 'digital', manual: true }, order.shop_code);
      ok(
        res,
        { id: order.order_no, status: 'shipped', deliveries: r.codes.map((c) => ({ kind: 'code', value: c })), trackingNo: null, carrier: null },
        '已交付（兑换码已发送给买家）'
      );
      return;
    }
    // 码池自动分配（与卡密自动交付共用同一事务函数，防并发重复发放；按 quantity 整批）
    const r = await deliverDigitalFromPool(order);
    if (r.error === 'pool_empty') {
      return fail(res, `该数字商品兑换码池未用码不足 ${order.quantity} 个，请先导入码池或手动填写交付内容（每行一个）`);
    }
    if (r.error) {
      return fail(res, '兑换码分配冲突，请重试');
    }
    // 手动发货（池自动分配）审计；autoDeliver（watcher/paid 自动触发）非 staff 动作不埋
    await audit(req, 'order.ship', 'order', order.order_no, { kind: 'digital', pool: true }, order.shop_code);
    ok(
      res,
      { id: order.order_no, status: 'shipped', deliveries: r.codes.map((c) => ({ kind: 'code', value: c })), trackingNo: null, carrier: null },
      '已发货：兑换码已从码池分配并发送给买家'
    );
    return;
  }

  // 实物：记录物流单号与承运方名称（数量见订单 quantity）。条件更新（status + 凭证不变量双守卫）：
  // 与数字/NFT/批量发货同规约——防并发/多进程下对已迁出 escrowed 的行误写。
  // 凭证在 order_chain ⇒ 守卫写成 `EXISTS`（单目标表 + 另一张表的条件，见"跨表守卫的写法"）：
  // 只有一条语句、`changes` 仍是 1/0，状态与"有凭证"在同一条语句里判定。
  // 空单号落 NULL（自提/线下交付；`tracking_no` 的三态见批量发货处的说明），不留空串。
  const trackingNo = String(req.body?.trackingNo || '').trim().slice(0, 100) || null;
  // 承运方名称的归一（trim/控制字符/上限/空串→null）只有一处实现，见 src/shipping.js
  const carrier = normalizeCarrier(req.body?.carrier);
  const moved = await db.run(`UPDATE orders o
       SET o.status = 'shipped', o.tracking_no = ?, o.carrier = ?, o.shipped_at = ?, o.updated_at = ?
     WHERE o.id = ? AND o.status = 'escrowed'
       AND EXISTS (SELECT 1 FROM order_chain c WHERE c.order_id = o.id AND c.paid_tx_hash IS NOT NULL)`,
  trackingNo, carrier, now, now, order.order_id);
  if (moved.changes !== 1) {
    return fail(res, `当前状态(${order.status})不可发货，需买家托管成功`);
  }
  notify('order.shipped', order.order_no); // 卖家通知：实物发货
  /*
    ⚠️ **审计行里不抄运单号**（2026-10-16 修，与批量发货 `order.batch_ship` 对齐）。
    运单号在承运商侧可反查收件人姓名/电话/地址，而 `audit_logs` **不参与个人信息擦除**
    （`piiErase.js` 的保留清单只针对业务列），`GET /api/shop/audit` 又把 `detail` 原样下发
    ——抄进来一份就等于把"擦不掉的 PII"埋进审计表。要它有的是正路：`orders.tracking_no`
    才是权威列，审计行只记"做了这件事、做的是哪一单"（`order_no` 已经是那一单的键）。
    同一批的两个入口此前口径不一致（这里带单号、批量不带），现在只留一种形状。
    结构性口径：**审计 detail 只放"分类/计数/布尔"，不放标识类个人数据**——
    与 `routes/returns.js`（不落退货地址）、`routes/pii.js`（只落计数）、
    `routes/evidenceFiles.js`（只落单号/文件数/字节数）同款。
  */
  await audit(req, 'order.ship', 'order', order.order_no, { kind: 'physical', carrierFilled: !!carrier }, order.shop_code);
  ok(res, { id: order.order_no, status: 'shipped', trackingNo, carrier, deliveries: [] }, '已标记发货');
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
  const order = await findOrderInShop(req.params.id, req.shop.code);
  if (!order) return fail(res, '订单不存在', 404, 404);
  if (order.status !== 'escrowed') return fail(res, `当前状态(${order.status})不可登记交付，需买家托管成功`);
  if (!order.paid_tx_hash) {
    return fail(res, '该订单缺少链上支付凭证（order_chain.paid_tx_hash 为空），无法交付——请先对该订单执行同步补齐凭证');
  }
  // 两级售后门控：**判据只有交付闸一处**（链上 status=Created 且 refundRequested=false 才放行；
  // 读不到则拒绝）——同 /ship，见 chainOrder.deliveryGate 的说明
  const gate = await deliveryGate(order);
  if (!gate.ok) return fail(res, gate.message);
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
  if (!raw.length || raw.length > order.quantity) {
    return fail(res, `需提交 1..${order.quantity} 条交付记录（deliveries: [{tokenId, txHash}]，批量转账可多行共享同一 txHash）`);
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
  const delivered = (await db.get("SELECT COUNT(*) AS c FROM order_delivery_items WHERE order_id = ? AND kind = 'nft'", order.order_id)).c;
  if (delivered + items.length > order.quantity) {
    return fail(res, `超量交付：本单需 ${order.quantity} 枚，已交付 ${delivered} 枚，本次 ${items.length} 枚超出剩余额度`);
  }

  // 池内未用预检（全部满足才继续核验，失败提示具体冲突 token）：
  // 这里只是一次"给人看的"预检——真正防并发双交付的是下面事务内的条件占用（changes === 1）
  const poolRows = [];
  for (const it of items) {
    const row = await db.get("SELECT id FROM product_nft_tokens WHERE product_id = ? AND token_id = ? AND status = 'unused'", order.product_id, it.tokenId);
    if (!row) return fail(res, `tokenId ${it.tokenId} 不在商品交付池内或已被交付（请核对 NFT 池中的未用列表）`);
    poolRows.push(row.id);
  }

  // 集合核验（v2）：同一 txHash 一次收据匹配整组 tokenId——ERC721 同收据多笔 Transfer /
  // ERC1155 TransferBatch 批量；ERC721A 用 erc721 签名兼容。standard 必须由商品快照锁死。
  const nftStandard = snap.nft_standard;
  if (nftStandard !== 'erc721' && nftStandard !== 'erc1155') {
    return fail(res, '商品快照缺少合法的 NFT 标准（erc721/erc1155）：拒绝交付核验，请刷新商品后重试');
  }
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

  const now = new Date();
  /*
    这两个值要活过事务回调（提交后的副作用在回调之外，见下方注释）——所以声明在**回调外**。
    写成回调内 `const` 的话，块外引用会抛 ReferenceError：`node --check` 与 tsc 都看不出来，
    只有真的走一遍"成功的 NFT 交付"才会暴露（2026-10-14 演示栈真链剧本抓到的正是这一处）。
  */
  let total = 0;
  let toStatus = 'escrowed';
  /*
    池占用 + 交付行 + 订单行三者**同一个事务**（2026-10-16 收口，原实现已是这个形状，
    这里只是换成唯一的事务入口）：条件占用（`changes === 1`）防两单抢同一枚；
    **事务内重读**交付行数（入口那次读可能在链上核验的 RPC 往返期间过期）与
    "插入交付行 + 推订单状态"必须同一次提交——分开写就会出现「行已落、状态没推」，
    此后所有交付请求都被"超量"拒绝，订单永久滞留在 escrowed。

    但"同一个事务"**不等于**串行化（2026-10-18 修）：MySQL REPEATABLE READ 下那次
    `COUNT(*)` 是快照读，两个并发请求可以都看到旧计数、都通过"超量"检查。所以事务的第一条
    语句先 `SELECT id FROM orders … FOR UPDATE` 锁住本单：同一单的部分交付在这里排队，
    后到者的计数一定包含先到者已提交的交付行。`from 集/状态守卫`仍在同一条 UPDATE 上。
    回滚走 abortTx（前面那些 return fail 的语义：整体没发生）。
  */
  const outcome = await withTransaction(async () => {
    // 订单行锁 = "已交付数不超 quantity"这条判据的**串行化点**（唯一实现）
    const locked = await db.get('SELECT id FROM orders WHERE id = ? FOR UPDATE', order.order_id);
    if (!locked) return abortTx({ fail: '订单不存在（可能已被删除），无法登记交付' });
    for (let i = 0; i < items.length; i++) {
      const ch = (await db.run("UPDATE product_nft_tokens SET status = 'used', order_id = ?, used_at = ? WHERE id = ? AND status = 'unused'", order.order_id, now, poolRows[i])).changes;
      if (ch !== 1) {
        return abortTx({ fail: `tokenId ${items[i].tokenId} 刚被其他订单占用，请刷新池列表重选` });
      }
    }
    // 持订单行锁后重读已交付行数：入口预检（delivered）可能在链上核验（await RPC）期间过期——
    // 并发请求若各自按过期计数放行，会超量交付（行数 > quantity）并因 toStatus 误判
    // 永久滞留 escrowed（此后所有交付请求都被"超量"拒绝）。**串行化靠事务开头的 FOR UPDATE**，
    // 不靠"把 COUNT 放进事务"（REPEATABLE READ 下那仍是快照读）。
    const freshDelivered = (await db.get("SELECT COUNT(*) AS c FROM order_delivery_items WHERE order_id = ? AND kind = 'nft'", order.order_id)).c;
    if (freshDelivered + items.length > order.quantity) {
      return abortTx({
        fail: `超量交付：本单需 ${order.quantity} 枚，已有 ${freshDelivered} 枚交付行被并发提交，本次 ${items.length} 枚将超出额度——请刷新后按剩余额度重新登记`,
      });
    }
    for (const it of items) {
      // `created_at` 由服务器默认值盖章（同 deliverDigitalManual 的理由）
      await db.run('INSERT INTO order_delivery_items (order_id, kind, value, tx_hash) VALUES (?, ?, ?, ?)', order.order_id, 'nft', it.tokenId, it.txHash.toLowerCase());
    }
    // 累计达 quantity → 自动 shipped；未达保持 escrowed（部分交付，进度见详情）
    total = freshDelivered + items.length;
    toStatus = total >= order.quantity ? 'shipped' : 'escrowed';
    /*
      条件更新里**只留并发守卫**（`status = 'escrowed'`），不留本地镜像条件
      （2026-10-15 删掉 `AND refund_status != 'requested'`）：交付判据已经在进事务前由
      `deliveryGate` 按**链上真值**判过，再拿镜像判一次就是第二个答案层——
      镜像滞后（`rejectRefund` 之后、或 `RefundRejected` 事件漏扫）时它会把一次合法交付
      挡回去，还要给出一个与链上相反的理由（"退款申请已在核验期间落地"）。
      状态守卫仍然必要：并发请求/另一标签页可能已把这单推离 escrowed。
    */
    const moved = (await db.run("UPDATE orders SET status = ?, shipped_at = COALESCE(shipped_at, ?), updated_at = ? WHERE id = ? AND status = 'escrowed'", toStatus, now, now, order.order_id)).changes;
    if (moved !== 1) {
      return abortTx({ fail: `当前状态(${order.status})不可登记交付——请刷新后确认状态再重试` });
    }
    return null;
  });
  if (outcome?.fail) return fail(res, outcome.fail);
  /*
    提交后的副作用（通知/审计/响应）**必须在事务之外**（本仓的 afterCommit 纪律）：
    `notify` 的同步段会碰库（webhook.js 读店铺 webhook 配置 + 订单行），它抛错时若还落在
    事务回调里，就会把**已提交**的交付一起回滚掉，交付已生效却回 500，
    店主重试只会拿到"当前状态不可登记交付"。与 autoDeliver.deliverDigitalFromPool 同一形状
    （2026-10-14 同批收口）。
  */
  if (toStatus === 'shipped') notify('order.shipped', order.order_no); // 卖家通知：NFT 全部交付
  await audit(req, 'order.nft_delivery', 'order', order.order_no, { tokenCount: items.length, delivered: total }, order.shop_code);
  ok(
    res,
    {
      id: order.order_no,
      status: toStatus,
      delivered: total,
      quantity: order.quantity,
      deliveries: items.map((it) => ({ kind: 'nft', value: it.tokenId, txHash: it.txHash.toLowerCase() })),
    },
    toStatus === 'shipped'
      ? 'NFT 已全部交付：链上 Transfer 凭证已登记，买家可自证持有'
      : `NFT 已交付 ${total}/${order.quantity} 枚（部分交付），全部到齐后自动完成发货`
  );
}));

/**
 * 提交售后/争议陈述（两级流程数据面；链上动作由钱包直调，本接口仅收理由/证据）：
 *  - phase='refund_request'：买家在链上申请退款（refund_status=requested）后提交退款理由；
 *  - phase='refund_reply'：店主回应退款申请（是否同意/协商意见，refund_status=requested 期间）；
 *  - phase='arbitration'：争议中（disputed）买卖双方各陈事实，供仲裁人裁决参考。
 * 同角色同阶段可多次追加（形成时间线）；content 1..2000 字；条数上限见 EVIDENCE_LIMIT_BY_PHASE。
 */
router.post('/:id/evidence', requireAuth, evidenceLimiter, wrap(async (req, res) => {
  const order = await findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const phase = String(req.body?.phase || '');
  const content = String(req.body?.content ?? '').trim();
  // phase 白名单也取自唯一实现（EVIDENCE_PHASES，与 DB 的 CHECK 约束同值）——不在这里再抄一份字面
  if (!EVIDENCE_PHASES.includes(phase)) {
    return fail(res, `phase 需为 ${EVIDENCE_PHASES.join(' / ')}`);
  }
  if (!content || content.length > 2000) return fail(res, 'content 需为 1..2000 字符');
  const role =
    req.auth.address === order.buyer ? 'buyer' : (await isStaff(req.auth.address, order.shop_code || '', { force: true })) ? 'seller' : null;
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
  /*
    「读计数 → 判上限 → 插行」必须**串行化到同一张订单**上（2026-10-16 起直到 2026-10-18 的
    事务形状不够）：仅把三步放进一个事务，在 MySQL 的 REPEATABLE READ 下 `COUNT(*)` 是
    **非锁定读**——N 个并发提交各读各的快照，都看到旧计数（都 < 上限）⇒ 单方一次刷出
    任意多条陈述。上限是**写入侧**的闸（读取侧只按 EVIDENCE_DETAIL_LIMIT 限展示），
    超限必须真的在某一条语句上失败。现在事务先 `SELECT id FROM orders … FOR UPDATE`
    锁住订单行：同一单的提交在这里排队，后到者的 COUNT 一定看得到先到者已提交的行。
    代价如实写：同一单的并发陈述从"都能进"变成"串行进"（这正是上限的语义）；
    不同订单之间不受影响（锁的粒度是那一行）。超限走 abortTx：这次提交整体没发生。

    行 id 取**这条 INSERT 的 `insertId`**（新数据层的返回），不再用 `lastInsertRowid`，
    也不用 `SELECT … ORDER BY id DESC LIMIT 1`（源码评审 2026-09 修复）：后者靠"同一连接、
    中间没有 await"的时序巧合成立，一旦改成异步或在中间插一句别的 INSERT，拿到的就是
    **别人的行 id**——随后上传的附件会挂到另一条陈述上（证据挂错人，在争议里是要命的）。
    `insertId` 是 AUTO_INCREMENT 给这一条语句分配的号，没有这个巧合问题。
  */
  const ins = await withTransaction(async () => {
    /**
     * 订单行锁 = 这条上限判据的**串行化点**（唯一实现）：同一单的所有陈述提交在这里排队。
     * 用 `orders.id`（内部主键）而不是 `order_no`：主键等值 + 行锁，代价最小。
     * 订单不存在时 `get` 返回 undefined；此处上层 `findOrder` 已确认存在，正常不可达。
     */
    const locked = await getDb().get('SELECT id FROM orders WHERE id = ? FOR UPDATE', order.order_id);
    if (!locked) return abortTx({ over: 0 });
    const used = (await getDb().get('SELECT COUNT(*) AS c FROM dispute_evidence WHERE order_id = ? AND role = ? AND phase = ?', order.order_id, role, phase)).c;
    if (used >= cap) return abortTx({ over: used });
    // `created_at` 交给服务器默认值；`role`/`phase` 是 ENUM，值域与本文件上方的校验同源
    return await getDb().run('INSERT INTO dispute_evidence (order_id, role, phase, content) VALUES (?, ?, ?, ?)', order.order_id, role, phase, content);
  });
  if (ins.over !== undefined) {
    return fail(
      res,
      `本单「${EVIDENCE_PHASE_LABEL[phase]}」你已提交 ${ins.over} 条（上限 ${cap} 条）：请把补充内容并入已有陈述，或等待对方/仲裁人处理`
    );
  }
  const evidenceId = Number(ins.insertId);
  // evidenceId 供前端随后上传附件（POST /:id/evidence/:evidenceId/files）
  await audit(req, 'evidence.submit', 'order', order.order_no, { phase }, order.shop_code);
  // 响应里的 orderId 是**订单号**：前端随后拿它拼附件上传 URL（公开标识，与 URL 上那个同一个）
  ok(res, { orderId: order.order_no, evidenceId, phase, role }, '已记录，将作为卖家/仲裁人的处理依据');
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
  const order = await findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  // 经营人员判据取**这单所属店铺**（`isStaff(address, shopCode)`）
  const isBuyer = req.auth.address === order.buyer;
  const isStaffActor = await isStaff(req.auth.address, order.shop_code || '', { force: true });
  if (!isBuyer && !isStaffActor) return fail(res, '仅买家本人或店主/操作员可取消订单', 403, 403);

  // escrowed 无凭证异常单：取消前查链上，防止把「已支付未回写」的真单误取消（P1-3）
  if (order.status === 'escrowed' && !order.paid_tx_hash && order.escrow_order_id) {
    try {
      const onchain = await fetchOnchainOrder(order.escrow_order_id);
      if (onchain.status !== 'None') {
        // 「这个链上单号是不是我这一单」只有一处实现（chainParamsMatch，交付闸/watcher/对账共用）。
        // 读到买家/卖家/金额/窗口任一项不符 ⇒ 不是本单，可以取消；读不到（桩/老行）时
        // chainParamsMatch 按"跳过该项"处理，这里没有额外的未知档。
        if (chainParamsMatch(order, onchain)) {
          return fail(
            res,
            '链上已存在该订单的托管记录——请对该订单执行「同步核实」恢复状态，勿直接取消'
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
  const changed = await withTransaction(async () => {
    /*
      目标表 = orders（状态 + updated_at），凭证守卫走 EXISTS：可取消 = 草稿，或
      「escrowed 且**没有**凭证」。条件与状态写在同一条语句里——分成"先查凭证再取消"两步时，
      两步之间可能插进一次 /paid（凭证刚落地），那一单就会被误判为异常单取消掉。
      （为什么不用多表 UPDATE：见"跨表守卫的写法"。）
    */
    const n = (await db.run(`UPDATE orders o
         SET o.status = 'cancelled', o.updated_at = ?
       WHERE o.id = ?
         AND (o.status = 'draft'
              OR (o.status = 'escrowed'
                  AND EXISTS (SELECT 1 FROM order_chain c WHERE c.order_id = o.id AND c.paid_tx_hash IS NULL)))`,
    new Date(), order.order_id)).changes;
    if (n === 1) {
      // 售后镜像随终局一起复位（refund_status → 'none'，与 watcher/sync 的终局迁移同口径）：
      // cancelled 是本地终局，留着 requested/rejected 会让"退款申请待处理"的镜像继续存在——
      // 而依赖它的门控（如 POST /:id/evidence 的阶段判定、卖家面板退款待办）会据此对一张
      // 已取消的单继续受理售后。复位后：状态门控与镜像口径一致，取消即真的结束。
      await db.run("UPDATE order_chain SET refund_status = 'none' WHERE order_id = ? AND refund_status != 'none'", order.order_id);
      // 占位回补按**内部 order_id**（stockHold 的候选集合就是它自己的主键）
      await releaseHoldsForOrderIds([order.order_id]);
    }
    return n;
  });
  if (changed === 0) return fail(res, '订单状态已变化，请刷新后重试');
  notify('order.cancelled', order.order_no); // 卖家通知：买家/店主取消草稿或清理异常单
  await audit(req, 'order.cancel', 'order', order.order_no, { by: req.auth.address === order.buyer ? 'buyer' : 'staff' }, order.shop_code);
  ok(res, await orderToPublic(await findOrder(order.order_no)), '订单已取消，库存占位已释放');
}));

/**
 * 修改收货信息（买家本人，仅 escrowed 的实物单；发货后/已退款等终局不可改）。
 * 收货信息不入快照/不影响资金锁定——纯订单数据面，改错地址的补救通道（无需取消重下）。
 * 每单最多修改 1 次（`order_shipping.edit_count` 0→1）：防买家反复改址造成卖家发货错乱/被骚扰。
 */
router.patch('/:id/shipping', requireAuth, wrap(async (req, res) => {
  const order = await findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  if (order.buyer !== req.auth.address) return fail(res, '仅买家本人可修改收货信息', 403, 403);
  if (order.status !== 'escrowed') return fail(res, `当前状态(${order.status})不可修改收货信息——需托管成功且卖家未发货（发货/终局后不可改）`);
  if ((order.shipping_edit_count ?? 0) >= 1) {
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
  /*
    个人信息写在 order_shipping（另一张表）。目标表 = order_shipping，状态守卫走 EXISTS；
    `edit_count = 0` 是"本单只能改一次"的**条件守卫**（不是先读后判——那一读一写之间会插进
    第二次修改，两次都通过，第二次把第一次的地址覆盖掉而买家以为两次都生效了）。
    （为什么不用多表 UPDATE 改 shipping 三列 + orders.updated_at：见"跨表守卫的写法"。）
  */
  const updated = await withTransaction(async () => {
    const n = (await db.run(`UPDATE order_shipping s
         SET s.name = ?, s.phone = ?, s.address = ?, s.edit_count = s.edit_count + 1
       WHERE s.order_id = ? AND s.edit_count = 0
         AND EXISTS (SELECT 1 FROM orders o WHERE o.id = s.order_id AND o.status = 'escrowed')`,
    raw.name, raw.phone, raw.address, order.order_id)).changes;
    // `updated_at` 只在真的改了地址时推（它是列表排序/入账窗口锚点，不该被一次失败的修改推动）
    if (n === 1) await db.run('UPDATE orders SET updated_at = ? WHERE id = ?', new Date(), order.order_id);
    return n;
  });
  if (updated !== 1) {
    return fail(res, '收货信息更新冲突：该单已修改过一次或状态已变化，请刷新后重试');
  }
  ok(res, await orderToPublic(await findOrder(order.order_no), { as: 'buyer' }), '收货信息已更新（每单仅可修改一次；发货将按新地址执行）');
}));

/**
 * 按链上订单退款标记回填本地 refund_status（sync 反查用；链上为权威，事件漏扫/本地残留的兜底）：
 *  - refundRequested → 'requested'（首次申请时刻保留，重复同步幂等）
 *  - 否则 refundRejected → 'rejected'（首次拒绝时刻保留）
 *  - 两者皆无 → 本地残留标记回 'none'（链上从未申请或已重置）
 * 仅作用于 Created 镜像（本地 escrowed/shipped 未终结单及 disputed——超时直争议可带链上退款标记残留）；终态订单不触碰。返回受影响行数。
 *
 * 参数仍是**链上订单号**（调用方——/sync、chainReconcile 的兜底——手上都是它）。
 * 目标表 = order_chain（退款三列都在它上面），"只对未终结单生效"的状态守卫走 `EXISTS(orders)`
 * ——单目标表让返回值严格是 1/0（多表 UPDATE 会把两张表的命中数相加，见"跨表守卫的写法"）。
 * `orders.updated_at` 是入账窗口/陈述窗口的锚点，旧实现在改标记时一并推它，这里保持同口径：
 * 只有真的改了标记（changes === 1）才推，复位那一支不动它（与旧实现逐字一致）。
 */
export async function applyRefundFlags(orderIdHex, onchain) {
  const db = getDb();
  const id = String(orderIdHex).toLowerCase();
  const inFlight = "EXISTS (SELECT 1 FROM orders o WHERE o.id = c.order_id AND o.status IN ('escrowed','shipped','disputed'))";
  if (onchain.refundRequested) {
    return await withTransaction(async () => {
      const n = (await db.run(`UPDATE order_chain c
           SET c.refund_status = 'requested', c.refund_requested_at = COALESCE(c.refund_requested_at, ?)
         WHERE c.escrow_order_id = ? AND c.refund_status != 'requested' AND ${inFlight}`, new Date(), id)).changes;
      if (n === 1) await db.run('UPDATE orders SET updated_at = ? WHERE id = (SELECT order_id FROM order_chain WHERE escrow_order_id = ?)', new Date(), id);
      return n;
    });
  }
  if (onchain.refundRejected) {
    return await withTransaction(async () => {
      const n = (await db.run(`UPDATE order_chain c
           SET c.refund_status = 'rejected', c.refund_rejected_at = COALESCE(c.refund_rejected_at, ?)
         WHERE c.escrow_order_id = ? AND c.refund_status != 'rejected' AND ${inFlight}`, new Date(), id)).changes;
      if (n === 1) await db.run('UPDATE orders SET updated_at = ? WHERE id = (SELECT order_id FROM order_chain WHERE escrow_order_id = ?)', new Date(), id);
      return n;
    });
  }
  return (await db.run(`UPDATE order_chain c SET c.refund_status = 'none'
       WHERE c.escrow_order_id = ? AND c.refund_status != 'none' AND ${inFlight}`, id)).changes;
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
  const order = await findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  /*
    买家本人，或**店铺经营人员**（店主 ∪ 店员白名单）。原先只认 `config.shop.owner`——
    而"同步链上状态"是运维动作（把漏扫/滞后的镜像拉回链上真值），店员本就能发货、
    登记 NFT 交付、回复评价（都是 `staffOnly`），却唯独点不动这一个按钮。
    判据与那些入口同一处（`isStaff`），不再各写一份"谁是经营人员"。
  */
  if (req.auth.address !== order.buyer && !(await isStaff(req.auth.address, order.shop_code || '', { force: true }))) {
    return fail(res, '仅买家本人或店铺经营人员（店主/店员）可同步该订单', 403, 403);
  }
  if (!order.escrow_order_id) return fail(res, '该订单尚未生成链上托管标识');
  if (!config.chain.escrowAddress) return fail(res, '本节点未接入托管合约（MK_ESCROW_ADDRESS 未配置）');

  /*
    /sync 会写 settled/refunded 等**不可逆**终态，不能读 latest：必须与 watcher 用同一个
    head−finality 边界。读不到确认边界时拒绝同步（让用户稍后重试），不退回 latest。
  */
  let blockTag;
  try {
    blockTag = await finalizedBlockTag();
  } catch (e) {
    return fail(res, `无法确定链上确认边界（${e?.message || e}）：本次不同步，请稍后重试`, 1, 503);
  }
  const onchain = await fetchOnchainOrder(order.escrow_order_id, { blockTag });
  const db = getDb();
  /**
   * 本单 OrderCreated 的规范支付哈希（同步期间按创建块反查得到；未取到为 null）。
   * 提到 switch 之上是因为它有两个使用点：普通态补录（上方，带状态守卫）与
   * **cancelled 行恢复成功后的补写**（下方 Created 分支）——两者必须分开，
   * 详见补录处的注释（源码审计 2026-09 修复：写进 cancelled 行会让 watcher 永久不再恢复该单）。
   */
  let createdTxHash = null;
  /*
    ── 三处补录的**读数**（2026-10：失败必须留痕，且"补录失败" ≠ "没有凭证"）──
    下面三个补录动作刻意不阻断同步主流程（一次 RPC 抖动不该让"状态同步"整条失败），
    但旧实现用 `catch {}` 把失败吞成"和没找到一样"：店主被 /ship 拒绝后按提示来点同步，
    得到的仍是"缺少支付凭证"，而真正原因是**这次 RPC 读不到**（下次可能就好了）。
    三态：present（本来就有）/ recovered（本次补上）/ missing（读得到、链上确实没有）/
    unreadable（这次读不到——不是"没有"）。partialRefund / afterSale 同款 read/unreadable。
  */
  const syncBackfill = {
    paidTxHash: order.paid_tx_hash ? 'present' : 'missing',
    partialRefund: 'unreadable',
    afterSale: 'unreadable',
  };
  /*
    这一轮**真正写入**了什么（P2-1b）。补录动作成功（读到了）不等于值变了：
    `applyAcceptedPartialRefund` / `applyAfterSaleFromChain` 都只在值确实变化时才算一次写入。
    成功响应必须按这张表说话——旧实现只要状态没动就一律回"本次无需变更"，
    即使支付凭证/授权退款额/售后镜像刚刚被补上。
  */
  const syncWrites = { partialRefund: false, afterSale: false };
  // 防伪托管：链上确实存在该 orderId 的订单并不代表本单真金白银入金——事件/交易
  // 可能被同名 orderId 干扰。凡链上订单存在，必须先核对金额/卖家与本地锁定一致，
  // 否则拒绝推进（与 paid/escrowWatcher 的 OrderCreated 校验同规则）。
  if (onchain.status !== 'None') {
    // 防伪托管 + 账户一致性（与 paid/escrowWatcher 的 OrderCreated 校验同规则）：
    // 链上订单的金额/卖家/买家必须与本地锁定一致。买家比对尤其重要——他人钱包
    // 代付/伪造托管会把资金锁在他人 buyer 名下并可能误触发发货，只有 buyer 一致
    // 才是「本单买家真实入金」（Escrow 以 msg.sender 为 buyer）。
    // 判据只有一处实现（`chainParamsMatch`：交付闸、watcher 事件分支、后台对账共用）——
    // 本文件此前在 /sync 与 /cancel 各抄了一份严格比较（严格到"缺字段即不匹配"，
    // 与 chainParamsMatch 的"缺字段跳过"相反，于是同一个问题又有了两套语义）。
    const match = chainParamsMatch(order, onchain);
    if (!match) {
      return fail(res, '链上订单的金额/卖家/买家/验货窗口与本单锁定不一致，疑似伪造托管或他人代付，已拒绝同步');
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
        /*
          **发布者必须在本地再验一次**（与 watcher/chainReconcile 同一判据：
          `queryFilter` 的 address 过滤是 RPC 的承诺，不是返回值的性质）。缺这一条时，
          一个错误/被劫持的 RPC 可以用别的合约发同名事件，把一笔假 txHash 写成本单的
          支付凭证——它会被发货闸、导出与信誉画像当作"真实支付"。
        */
        const canonicalLogs = logs.filter(
          (l) => isCanonicalEscrowLog(l, config.chain.escrowAddress) && orderCreatedMatches(order, l.args, order.escrow_order_id, onchain.token)
        );
        if (canonicalLogs.length) {
          createdTxHash = String(canonicalLogs[0].transactionHash).toLowerCase();
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
          const hashChanged = await withTransaction(async () => {
            // 凭证认领（目标表 = order_chain，状态守卫走 EXISTS——见"跨表守卫的写法"）。
            // 与 notePaidTxHash 同口径；只在真的写入了哈希时补事件史
            //（否则事件史里会出现一条没有对应凭证的记录）。
            const changed = (await db.run(`UPDATE order_chain c SET c.paid_tx_hash = ?
                 WHERE c.order_id = ? AND c.paid_tx_hash IS NULL
                   AND EXISTS (SELECT 1 FROM orders o WHERE o.id = c.order_id AND o.status IN ${PRE_PAID_IN})`, createdTxHash, order.order_id)).changes;
            if (changed === 1) {
              await appendOrderCreatedEvent(order.order_id, { txHash: createdTxHash, block: onchain.createdAtBlock });
            }
            return changed;
          });
          if (hashChanged === 1) syncBackfill.paidTxHash = 'recovered';
        }
      } catch (e) {
        /*
          读不到 ≠ 没有：把 RPC 失败写成 missing 会让店主以为"这单天生没有凭证"，
          从而去点取消/重新下单；而真实情况是这次没读到、下次同步可能就补上了。
        */
        syncBackfill.paidTxHash = 'unreadable';
        console.warn(
          `[orders] /sync 支付凭证补录失败（order=${order.order_no}）：${e?.message || e}——本次是"读不到"，不是"链上不存在"，稍后重试或等 watcher 轮询`
        );
      }
    }
    /*
      买家「精确金额授权」的链上镜像回填（契约 2026-09 新增 acceptPartialRefund）：
      链上 `acceptedPartialRefund(orderId)` 是卖家用 approveRefund 退部分金额时的**唯一**合法取值，
      而它只由 PartialRefundAccepted 事件带到本地——事件漏挂/漏扫（节点停机、RPC 抖动、
      游标隔离）时，手动同步必须能把授权额补上，否则店主在面板上永远是"未授权"，
      只能拿一个凭空猜的数字去吃链上 RefundAmountNotAccepted 的 revert。
      读取失败（合约尚未升级/ABI 未同步/RPC 不可达）**不阻断同步**：保持本地原值，
      watcher 事件路径仍会补。⚠️ 必须在任何事务区段之前 await（事务回调里不得 await 数据库以外的东西）；
      且只对本单链上确实存在的托管单读（status='None' 时读它没有意义）。
      落列走 applyAcceptedPartialRefund（与事件的 PartialRefundAccepted 分支**同一实现**：
      只写这一列、不动状态/updated_at、同值幂等、解析不出就不写）。
    */
    try {
      const acceptedWei = await getEscrow().acceptedPartialRefund(order.escrow_order_id);
      syncWrites.partialRefund = (await applyAcceptedPartialRefund(order.escrow_order_id, acceptedWei)) > 0;
      syncBackfill.partialRefund = 'read';
    } catch (e) {
      /* 见上：读不到就保持本地原值（不写 '0'，那会抹掉面板上一条有效授权） */
      syncBackfill.partialRefund = 'unreadable';
      console.warn(
        `[orders] /sync 读取"买家已授权部分退款额"失败（order=${order.order_no}）：${e?.message || e}——本地原值保持不变，本次读数不可用（不是"未授权"）`
      );
    }
    /*
      确认收货后的**售后案件**按链上真值回填（契约 2026-10 第二批）。

      为什么必须在这里：售后案件由 AfterSaleOpened/Closed 事件回写，而事件漏扫（节点停机跨过扫描窗口、
      RPC 抖动、事件被隔离清单跳过）时，本地会与链上永久分叉，两个方向的后果都不轻：
        · 链上有案件、本地 none ⇒ 仲裁台队列里看不到这一单（买家开了案却没人处理）、
          售后陈述提交被门控拒掉、退货单建不了——买家的救济路径整条静默失效；
        · 链上已结案、本地 open ⇒ 队列永远挂着一条幽灵待办，店主反复看到"可能被罚没"。
      人工 sync 是这两条分叉的即时补救入口（后台对账是自动兜底，见 chainReconcile）。

      口径与 watcher/对账**同源**：读数走 chainOrder.fetchAfterSaleCase（与对账同一个读取器），
      落列走 afterSale.applyAfterSaleFromChain（唯一写入口）。刻意只做这两件事：
      不迁移 orders.status（案件不改变资金口径）、不动 updated_at（那是入账窗口锚点）。
      读不到（RPC 抖动/合约未升级）时**不阻断同步**：保持本地原值，watcher/对账还会再补。
      已知信息损失（如实写明）：链上只读视图里**没有**结案说明，所以这条路径关案时 note 为 null，
      要拿到说明只能等 AfterSaleClosed 事件。
      ⚠️ 必须在任何事务区段之前 await（事务回调里不得 await 数据库以外的东西，见 db.js）。
    */
    try {
      const truth = await fetchAfterSaleCase(order.escrow_order_id, { blockTag });
      /*
        案件读数同样要回答"这个链上单号确实是我这单吗"：`fetchAfterSaleCase` 只按 orderId 读，
        而 orderId 可以被同一卖家在另一个节点下的店复用（也是他人 1 wei 诱饵单的入口）。
        与 /paid、/sync 主体、对账使用**同一个**判据（chainParamsMatch，比对买家/卖家/金额/超时窗口），
        不匹配就整条不落地——否则别人的案件会点亮本店的售后队列与陈述门控。
      */
      if (!chainParamsMatch(order, truth)) {
        syncBackfill.afterSale = 'unreadable';
        console.warn(
          `[orders] /sync 跳过与链上真值不符的售后案件（order=${order.order_no}）：买家/卖家/金额/店铺节点与本地锁定不一致`
        );
      } else {
        const applied = await applyAfterSaleFromChain(order.escrow_order_id, truth);
        syncWrites.afterSale = applied.changed > 0;
        syncBackfill.afterSale = 'read';
        // 人工/对账改的是**镜像列**而不是链上事件，故不写进链上事件史，只留一条服务端日志
        if (applied.changed > 0) {
          console.warn(
            `[orders] /sync 按链上真值回填售后案件：order=${order.order_no.slice(0, 8)}… → ${applied.to}（事件漏扫兜底）`
          );
        }
      }
    } catch (e) {
      /* 见上：读不到就保持本地原值（watcher 事件/后台对账仍会补） */
      syncBackfill.afterSale = 'unreadable';
      console.warn(
        `[orders] /sync 回填售后案件失败（order=${order.order_no}）：${e?.message || e}——本地原值保持不变，本次读数不可用（不是"没有案件"）`
      );
    }
  }
  // 同步前状态（用于回报「是否真的发生了迁移」——源码审计 2026-09：此前无论是否变更
  // 都回「已按链上状态同步」，本地 cancelled 遇到链上 Disputed 这类 from 集未覆盖的组合
  // 一个字段没动却也报成功，前端据此展示成「已同步」误导用户）
  const statusBeforeSync = String(order.status || '');
  // 本地锁定的托管额（终局映射的比对基准；与链上 amount 比对过，见上方"防伪托管"段）。
  // `DECIMAL(38,0)` ⇒ 库给回的就是十进制字符串，下游 BigInt 直接吃（不要再过 Number）。
  const localAmountWei = String(order.amount_wei ?? '0');
  /*
    链上已退金额：`'0'` 是"确证为 0"，**读不到是"不知道"**——两者不能先用 `|| '0'` 抹平
    （2026-10 生产化清理）：把"不知道"写成 0 等于替链上说了一句它没说过的话（"没退过款"），
    账目记反且不可逆，而且事后两边同错、对账自证一致。读不到时下面既不判终态含义、
    也不改动账本金额，并在响应里说明。
  */
  const chainRefunded = readRefundedWei(onchain.refundedAmount); // bigint | null
  const chainRefundedWei = chainRefunded === null ? null : chainRefunded.toString();
  switch (onchain.status) {
    case 'Created': {
      // 误取消/草稿超时被关闭（cancelled）的单若链上确有托管（已支付未回写），
      // 恢复为 escrowed——先按逐单占位记账条件回补（restockOrder：曾占位才恢复，失败即库存
      // 在取消期间被卖完，提示人工处理）；随后 watcher 事件亦会自动完成同款恢复。
      // 注意 from 集不含 'escrowed'：**值未变的 UPDATE 同样返回 changes=1**（SQLite 与 MySQL 一致，
      // 由 db.js 的 assertChangesSemantics 在启动时实测钉住），若含自身会把每次 sync 误判为
      // 迁移成功 → 重复推 order.escrowed 通知与噪音镜像（审计 F1）。
      /*
        迁移 + 恢复占位（若 cancelled）+ 镜像事件史 + 售后标记回填同事务（防半写：
        状态已推进而占位/事件史/标记缺失；restockOrder 内部事务经 SAVEPOINT 降级嵌套）。
        `localRow` 的读一并放进事务：它决定要不要 restockOrder（一次写），留在事务外
        会让"读到 cancelled"与"补回占位"之间插进别的写者。
      */
      const createdOutcome = await withTransaction(async () => {
        /*
          迁移先认领：`claimOrderState` 在事务内 `SELECT ... FOR UPDATE`，返回的 `from` 是
          这次真正被迁移的前一状态。旧实现先普通读 `localRow.status` 再 restock，清扫器/取消
          在两次语句之间提交时，UPDATE 会命中 `cancelled`，而分支仍看旧 `draft`，占位漏补。
        */
        const claim = await claimOrderState(db, order.order_id, ['draft', 'cancelled'], 'escrowed');
        if (claim.changed === 1 && claim.from === 'cancelled') {
          if (!(await restockOrder(order.order_id))) {
            throw new Error('订单恢复失败：该商品库存已在取消期间被占用（限量售罄），请联系店主扩容后重试');
          }
        }
        if (claim.changed === 1) {
          /*
            支付凭证**必须在迁移成功这一刻一并补写**（源码审计 2026-09 复审，P1）。
            上面那段注释承诺"cancelled 行的凭证改由迁移成功那一刻补写（见下方 Created 分支）"，
            而本分支此前只 append 了镜像事件——凭证留空，于是：
              · `/ship` 直接拒绝（「缺少链上支付凭证…请先执行同步补齐凭证」），
                卖家按提示**再同步一次**才拿到凭证（那时状态已是 escrowed，才命中另一处守卫）；
              · 中间那句文案与运维手册里那条"仍空则取消清理"的口径会把人往**取消**上引，
                而这一行同时是 `/cancel` 认定的「escrowed 无凭证异常单」——RPC 抖动时真被取消，
                本地回到 cancelled 而链上资金仍在托管，此后**没有任何自动路径能救**
                （watcher 只对新日志反应、游标已越过；chainReconcile 对链上 Created 明确 action:'none'），
                最终链上超时释放会让本地落 expired 并计入卖家流水。
            守卫与另一处同款（`paid_tx_hash IS NULL`，绝不覆盖已有凭证）；
            `createdTxHash` 是上面按链上 createdAtBlock 反查 OrderCreated 日志得到的规范哈希。
          */
          if (createdTxHash) {
            await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE order_id = ? AND paid_tx_hash IS NULL', createdTxHash,
              order.order_id);
          }
          await appendSyncMirrorEvent(order.order_id, 'escrowed', { block: onchain.createdAtBlock });
        }
        // 两级售后标记权威回填：链上 Created 单的 refundRequested/refundRejected 直接反映
        // 买家是否已申请退款/卖家是否拒绝（事件漏扫或本地与链上不一致时以链上为准，见 applyRefundFlags）
        await applyRefundFlags(order.escrow_order_id, onchain);
        return { moved: claim.changed === 1 };
      });
      if (createdOutcome.fail) return fail(res, createdOutcome.fail);
      if (createdOutcome.moved) notify('order.escrowed', order.order_no); // 卖家通知：watcher 漏扫时的 sync 兜底（幂等语义同 watcher）
      break;
    }
    case 'Disputed': {
      /*
        争议推进 + 售后标记按链上真值刷新（超时直争议可带 refundRequested 残留，仲裁摘要如实展示）。

        推进走**唯一实现** `markEscrowDisputed`（watcher / 对账 / sync 三条路径共用）：
          · from 集含 **cancelled**（源码审计 2026-09）：草稿被清扫/取消之后买家才完成支付是真实
            竞态，若 OrderCreated 那次扫描也漏了，之后争议发生时本地行会永远停在 cancelled，
            而链上那笔钱已被冻结——三条修复路径必须同一集合，漏一条就留下一块谁都不修的死角；
          · 从 cancelled 复活时**补回库存占位**（2026-10-22 复审，超卖方向）：取消时占位已经释放，
            只改状态会让同一件货同时"可再售"又"已有在途单"；占位恢复失败不阻断争议推进
            （钱已冻在链上，本地状态必须先与链上一致），由该实现记告警。
      */
      const movedToDisputed = await withTransaction(async () => {
        const moved = await markEscrowDisputed(db, order.escrow_order_id);
        if (moved) {
          await appendSyncMirrorEvent(order.order_id, 'disputed', { block: onchain.createdAtBlock });
        }
        await applyRefundFlags(order.escrow_order_id, onchain);
        return moved;
      });
      if (movedToDisputed) notify('order.disputed', order.order_no); // 卖家通知：sync 兜底（watcher 事件漏扫时）
      break;
    }
    case 'Settled': {
      /*
        终态推进的前置：**链上已退金额必须读得到**（2026-10-22 复审）。

        链上 `Settled` 是两个不同的结局：`refundedAmount = 0` 是全额判卖家/超时释放，
        `0 < refundedAmount < amount` 是拆分结算（部分退款 + 部分结算）。本地终态与账本净额
        都由这个数分岔（`mapChainTerminal` → `refunded` / `settled`，`refunded_amount_wei` 决定净额）。
        读不到时推进状态会把"不知道退了多少"写成 `refunded_amount_wei = 0`——卖家的流水与统计
        会按"一分没退"报一个偏高的净额，而且此后两边同错、对账自证一致。
        watcher（`settleByRefundSplit` 直接抛错）与后台对账（`planChainRepair` 返回 unreadable、不推进）
        早就是这条口径；`/sync` 是第三条路径，必须同判据（2026-10-22 三处收口）。
      */
      if (chainRefunded === null) {
        return fail(
          res,
          '链上「已退买家金额」本次读不到：无法区分「全额退款」与「部分退款/判给卖家」，' +
            '为避免把账目记反，本次不推进终态（watcher 与后台对账同口径）。请稍后重试，或改用链上直查核对。'
        );
      }
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
        from 集缺口曾令其永不可迁移、卖家流水漏计）。cancelled 行取消时已释放占位；若终态是
        **成交/settled**，必须在同一事务里补回占位，否则限量货会被再次卖出（见下方 restockOrder）。
        **`expired` 刻意不在 from 集里**（P2-1 终态吸附）：超时释放是链上确凿的终局事件，
        而快照只有 status/refundedAmount、区分不了"超时释放"与"判给卖家"——把 expired 改写成
        settled 会重盖 updated_at（入账窗口）、重发通知、并推后 PII 保留期，而链上事实没有变化。
        纠正 expired 只有**事件路径**：watcher 的 OrderExpiredReleased 分支会把误判的
        confirmed/settled 纠正为更准确的 expired；反向（expired → 更准确的终态）由真实
        ReceiptConfirmed/Arbitrated/RefundApproved 事件完成。快照路径不猜事件名。
        迁移 + 镜像 + D1 占位回补 + 售后镜像清残留同事务（防半写：迁移成功而回补/标记缺失）。
        注意：事务只保证"一起提交"，**不**提供串行化——状态与金额写入靠同一个 claim
        （transition 的 changes=1 或 SQL 内的 EXISTS(status=target)）绑定，见 backfillRefundedAmount。
      */
      const settledTarget = mapChainTerminal('Settled', chainRefundedWei, localAmountWei);
      const movedToTarget = await withTransaction(async () => {
        const claim = await transition(
          order.order_id,
          ['draft', 'escrowed', 'shipped', 'disputed', 'cancelled'],
          settledTarget
        );
        if (claim.changed === 1) {
          await appendSyncMirrorEvent(order.order_id, settledTarget, { block: onchain.createdAtBlock });
          /*
            本地是 cancelled 而链上最终成交：取消流程已经把库存占位还给别人，这里必须补回来。
            **判据是本次认领的前一状态 `claim.from`，不是事务外读到的 `order.status`**；也不能
            按 `refunded > 0` 过滤：refunded=0 的 Settled（超时释放/判卖家）同样是一笔成交，
            同一个链上转移在 watcher 与 /sync 下必须得到同一个 committed。补不回来（限量库存
            已被卖空）就整笔回滚并让用户重试——settled 是终态，静默放行等于永久超卖。
          */
          if (claim.from === 'cancelled') {
            if (!(await restockOrder(order.order_id))) {
              throw new Error('订单已在链上成交，但该商品库存已在取消期间售空，无法补回占位；请店主扩容后重试同步');
            }
          }
        }
        // 拆分结算的已退金额按链上真值回填（链上 Settled 也可能是「仲裁拆分：部分退款 +
        // 部分结算」，refundedAmount 是账本净额/退款口径的唯一依据）。
        // **读不到就不写**：拿 0 覆盖等于把"不知道"写成"没退过款"，而这一列是账本净额的唯一依据。
        // **moved=0 且本地不是该终态（如 expired）也不写**：见 backfillRefundedAmount。
        if (chainRefundedWei !== null) {
          await backfillRefundedAmount(order, settledTarget, chainRefundedWei);
        }
        if (claim.changed === 1) {
          // D1：成交终局但退货已确认收货/放弃追索（received_at 非空，货已实际回到卖家侧可再售）→
          // 占位回补（watcher 同规则；本行幂等，sync 重复触发不二次扣减，见 releaseHoldsForReturnReceived）
          await releaseHoldsForReturnReceived(order.escrow_order_id);
        }
        // 链上已终结（结算给卖家）：售后镜像无意义，清残留（确认/超时/判付任一路径都可能带 prior 申请）。
        // 与退款金额同一条 claim：本地状态不是该终态时（例如 expired）不碰它。
        await clearRefundMirrorForTerminal(order, settledTarget);
        return claim.changed;
      });
      if (movedToTarget) {
        notify('order.settled', order.order_no); // 卖家通知：sync 兜底（链上 Settled 无法区分确认/超时/判付，
        // 以"资金已结算给卖家"的终局语义推送 order.settled；
        // 拆分结算的买家侧说明看订单详情的「已退买家」一行）
      }
      break;
    }
    case 'Refunded': {
      /*
        与 Settled 分支同一前置：链上 Refunded 是“全额退买家”，但金额读不到时
        仍可能是 RPC 形状漂移。旧实现先推进为 refunded、再跳过回填，页面就显示
        “已退 0”，而 refunded 又不进退款统计——两套账同时消失。金额未知不得写终态。
      */
      if (chainRefunded === null) {
        return fail(
          res,
          '链上「已退买家金额」本次读不到：无法确认这笔全额退款的实际金额，' +
            '为避免把账目记成「已退 0」，本次不推进终态。请稍后重试，或改用链上直查核对。'
        );
      }
      // 全额退款（仲裁判退 / 卖家 approveRefund 全额和解）：迁移到 refunded 后按「仅未交付行释放」
      // 回补占位（stockHold.releaseRefundedEscrow：已交付后退款视为货在买家侧需线下回收，
      // 不自动回补——与 shipped→expired 不释放同口径）。
      // 目标状态同样由 mapChainTerminal 决定（不再硬写字符串）：链上 Refunded 恒为全额退买家，
      // 该函数返回 'refunded'；走同一函数保证"改判据时两处一起改"（见 mapChainTerminal 说明）。
      // from 集含 cancelled（草稿被清扫/取消后才终局退款——cancelled 行取消时已
      // 释放占位，releaseRefundedEscrow 幂等无副作用）；**不含 expired**（终态吸附，见 Settled
      // 分支的说明：快照路径不得把超时释放改写成 refunded，真实事件才可纠正）。
      // 迁移 + 释放 + 镜像 + 标记同事务；金额/镜像列的写入与状态共用同一个 claim。
      const refundedTarget = mapChainTerminal('Refunded', chainRefundedWei, localAmountWei);
      const movedToRefunded = await withTransaction(async () => {
        const claim = await transition(order.order_id, ['draft', 'escrowed', 'shipped', 'disputed', 'cancelled'], refundedTarget);
        if (claim.changed === 1) {
          await releaseRefundedEscrow(order.escrow_order_id);
          await appendSyncMirrorEvent(order.order_id, refundedTarget, { block: onchain.createdAtBlock });
        }
        // 已退金额按链上真值回填（全额退款时 = amount；仍有退款则账本据此扣减）。
        // 同上：**读不到就不写**，绝不用 0 冒充"链上确证没退过款"；本地不是该终态也不写。
        if (chainRefundedWei !== null) {
          await backfillRefundedAmount(order, refundedTarget, chainRefundedWei);
        }
        // 终态：售后标记回 none（订单状态已表达退款结果，陈述时间线仍在 evidence 中可溯）；
        // 与状态同一 claim，本地 expired 时不动。
        await clearRefundMirrorForTerminal(order, refundedTarget);
        return claim.changed;
      });
      if (movedToRefunded) notify('order.refunded', order.order_no); // 卖家通知：sync 兜底
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
  await audit(req, 'order.sync', 'order', order.order_no, { onchain: onchain.status }, order.shop_code); // staff 触发的 sync 入审计（buyer 自动过滤）
  const orderAfterSync = await findOrder(order.order_no);
  const statusAfterSync = String(orderAfterSync?.status || '');
  const syncMoved = statusAfterSync !== statusBeforeSync;
  const unreadable = [
    syncBackfill.paidTxHash === 'unreadable' ? '支付凭证补录' : null,
    syncBackfill.partialRefund === 'unreadable' ? '买家授权退款额读取' : null,
    syncBackfill.afterSale === 'unreadable' ? '售后案件回填' : null,
  ].filter(Boolean);
  /*
    本轮**实际写入**了哪些补录（与"读到了"分开）。成功文案必须按它说话：
    旧实现只看状态有没有迁移，于是补上了支付凭证/授权额/售后镜像时仍回
    "本次无需变更"——运维据此以为没发生任何事（P2-1b）。
  */
  const backfilled = [
    syncBackfill.paidTxHash === 'recovered' ? '支付凭证' : null,
    syncWrites.partialRefund ? '买家授权退款额' : null,
    syncWrites.afterSale ? '售后案件镜像' : null,
  ].filter(Boolean);
  /*
    终态吸附（P2-1/P3-11）：状态没动，但链上快照给出的目标与本地终态不同（本地 expired，
    链上 Settled/Refunded）。这不是"一致"，而是"快照路径不覆盖已终态"——文案必须照实说，
    既不能报"无需变更"（读者会以为链上也就是 expired），也不能报"已同步"。
  */
  const chainTarget =
    onchain.status === 'Settled'
      ? mapChainTerminal('Settled', chainRefundedWei, localAmountWei)
      : onchain.status === 'Refunded'
        ? mapChainTerminal('Refunded', chainRefundedWei, localAmountWei)
        : null;
  const terminalAbsorbed =
    !syncMoved &&
    chainTarget !== null &&
    ['settled', 'refunded', 'expired'].includes(statusAfterSync) &&
    statusAfterSync !== chainTarget;
  const syncMessage = syncMoved
    ? `已按链上状态同步（${statusBeforeSync} → ${statusAfterSync}）` +
      (backfilled.length ? `；同时补录了 ${backfilled.join('、')}` : '')
    : terminalAbsorbed
      ? `本地已是终态 ${statusAfterSync}（链上快照目标 ${chainTarget}）——快照路径不覆盖已终态，` +
        '状态/退款金额/时间戳均未改动（真实事件到达时 watcher 会按事件名纠正）' +
        (backfilled.length ? `；本次只补录了 ${backfilled.join('、')}` : '')
      : backfilled.length
        ? `本地状态与链上一致（当前 ${statusAfterSync}）——本次只补录了 ${backfilled.join('、')}`
        : `本地状态与链上一致（当前 ${statusAfterSync}）——本次无需变更`;
  ok(
    res,
    {
      ...(await orderToPublic(orderAfterSync, { as: req.auth.address === order.buyer ? 'buyer' : 'owner' })),
      /*
        同步是一次"补录"动作，补录结果必须能和三件事分开：补上了 / 本来就有 / 这次没读到。
        只下发订单 DTO 时，"paidTxHash 仍为空"既可能是"链上确实没有"也可能是"RPC 读不到"，
        而这两种情况的处置完全相反（前者取消重下，后者稍后重试）。
      */
      syncBackfill,
    },
    syncMessage +
      (chainRefundedWei === null
        ? '；但链上"已退买家金额"这次没读到，账本金额**未被改动**（下次同步/对账会补）'
        : '') +
      (unreadable.length
        ? `；${unreadable.join('、')}这次没能采用（读不到，或链上读数不属于本单——两者都**不是**"没有"）——本地原值保持不变，稍后重试或等后台轮询补录`
        : '')
  );
}));

// ── 买家评价（P0-1：成交终局一单一评 + 店主单次回复 + 追评，见 src/reviews.js 口径）──

/**
 * 买家上传一张评价图（原图字节；类型由节点按字节判定）。
 *
 * 不复用 `POST /api/uploads`：那条是**店铺经营面**（staffOnly、按店额度、按店审计）；
 * 评价图是买家动作、挂在订单上，权限/额度/审计语义完全不同。
 */
router.post('/:id/review/images', requireAuth, reviewImageLimiter, wrap(async (req, res) => {
  const order = await findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const buyer = String(req.auth?.address || '').toLowerCase();
  if (String(order.buyer || '').toLowerCase() !== buyer) {
    return fail(res, '只有买家本人可以为该订单上传评价图', 403, 403);
  }
  const refused = reviewWriteRefusal(order);
  if (refused) return fail(res, refused, 403, 403);
  if (!REVIEWABLE_STATUS.includes(order.status)) {
    return fail(res, '只有成交终局订单可以上传评价图');
  }
  const reserved = reviewImageBudget.reserve(buyer, REVIEW_IMAGE_MAX_BYTES);
  if (!reserved.ok) {
    return fail(
      res,
      `本小时评价图额度不足（已用 ${Math.round(reserved.used / 1024 / 1024)}MB / ` +
        `${Math.round(reserved.limitBytes / 1024 / 1024)}MB；单张最多 ` +
        `${Math.round(REVIEW_IMAGE_MAX_BYTES / 1024 / 1024)}MB）`
    );
  }
  let stored;
  try {
    stored = await storeMediaStream(req, {
      allowedMimes: REVIEW_IMAGE_MIMES,
      maxUploadBytes: REVIEW_IMAGE_MAX_BYTES,
      label: '评价图',
    });
  } catch (e) {
    reviewImageBudget.release(reserved.reservation);
    if (e instanceof MediaUploadError) return fail(res, e.message);
    throw e;
  }
  reviewImageBudget.commit(reserved.reservation, stored.size);
  ok(res, stored, '评价图已上传');
}));

/** 提交评价 */
router.post('/:id/review', requireAuth, wrap(async (req, res) => {
  const order = await findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const { rating, content, images } = req.body || {};
  const r = await submitReview({ order, buyer: req.auth.address, rating, content, images });
  if (r.error) return fail(res, r.error, r.forbidden ? 403 : 1, r.forbidden ? 403 : 200);
  notify('review.created', order.order_no); // 卖家通知：买家评价（店主可回评）
  // 响应走公共投影（匿名短地址；不回吐原始行——避免把完整 buyer/内部主键等内部列带出）
  ok(res, reviewToPublic(await findReviewByOrder(order.order_id)), '评价成功');
}));

/** 节点管理员查看一单的评价图（只返回 URL，不含买家/正文；用于逐图治理） */
router.get('/:id/review/images', nodeAdmin, wrap(async (req, res) => {
  const order = await findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const row = await findReviewByOrder(order.order_id);
  if (!row) return fail(res, '该订单还没有评价', 404, 404);
  ok(res, {
    review: parseReviewImages(row.images),
    followup: parseReviewImages(row.followup_images),
  });
}));

/** 节点管理员逐图下架（评价图是公开内容，但节点仍需处理违法/侵权/PII 图） */
router.delete('/:id/review/images', nodeAdmin, wrap(async (req, res) => {
  const order = await findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const { kind, url } = req.body || {};
  const r = await removeReviewImage({ orderId: order.order_id, kind, url });
  if (r.error) return fail(res, r.error, r.notFound ? 404 : 1, r.notFound ? 404 : 200);
  await audit(req, 'review.image.remove', 'order', order.order_no, { kind: String(kind), remaining: r.remaining }, order.shop_code);
  ok(res, { remaining: r.remaining }, '评价图已下架');
}));


router.post('/:id/review/followup', requireAuth, wrap(async (req, res) => {
  const order = await findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const { content, images } = req.body || {};
  const r = await followupReview({ order, buyer: req.auth.address, content, images });
  if (r.error) return fail(res, r.error, r.forbidden ? 403 : 1, r.forbidden ? 403 : 200);
  ok(res, reviewToPublic(await findReviewByOrder(order.order_id)), '追评已提交');
}));

/** 店主回复评价（单次） */
router.post('/:id/review/reply', staffOnly, wrap(async (req, res) => {
  const order = await findOrderInShop(req.params.id, req.shop.code);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const { content } = req.body || {};
  const r = await replyReview({ order, content });
  if (r.error) return fail(res, r.error);
  await audit(req, 'review.reply', 'order', order.order_no, {}, order.shop_code);
  ok(res, reviewToPublic(await findReviewByOrder(order.order_id)), '回复成功');
}));

export default router;
