/**
 * 仲裁数据面（供链上仲裁人裁决参考；本节点 = 一家店，待仲裁单即本店 disputed 订单）。
 *
 *  GET /api/arbitration/pending   待仲裁争议单列表（公开只读，分页倒序）
 *
 * 裁决闭环：买家在订单页发起争议（链上 requestDispute）→ 节点 escrowWatcher 回写本单
 * 为 disputed（onchain_events 追加 DisputeRequested）→ 仲裁人在前端「仲裁台」从各可达
 * 节点聚合本端点 → 行级查看详情（GET /api/orders/:id，仲裁人身份可读全字段含交付证据）
 * → 钱包直调链上 Escrow.arbitrate(orderId, refundWei) 裁决（可全额退买家 / 全额判卖家 / 按金额拆分；
 * 节点不经手资金，无写接口）→ 各节点 watcher 轮询 Arbitrated 事件回写 settled/refunded，本列表自动收敛。
 *
 * 隐私口径：待仲裁单已进入链上争议流程，订单号/金额/参与方在链上 DisputeRequested 与
 * OrderCreated 事件中公开可查——本端点摘要与链上公开信息对齐，不新增泄露面；
 * 交付内容（兑换码/tokenId 原文）属敏感资源，不出现在摘要——裁决证据经详情接口
 * 按身份返回（买家本人/店主/仲裁人，见 orders.js 详情路由的 as 判定）。
 */
import { Router } from 'express';
import { getDb } from '../db.js';
import { ok, wrap, simpleRateLimit } from '../http.js';
import { weiToDecimal } from '../chain.js';
// 金额展示口径的唯一实现（yuanOf / goodsFenOf）——不要手写 (fen/100).toFixed(2)
import { goodsFenOf, yuanOf } from '../money.js';
// 「已交付事实」的唯一实现（shipped_at / tracking_no / 交付行三要素）——不要在本文件重写判据
import { hasDelivered } from '../returns.js';
// 平台费**按单**判据的唯一实现（创建时收取方快照；见 src/fees.js）
import { feeChargeableForOrder } from '../fees.js';

const router = Router();

/*
  待仲裁列表限流（公开只读，此前**无任何节点内限流**）：
  每行摘要都要跑 2 次 COUNT（evidenceCount = dispute_evidence 计数 + 列表的 total），
  且响应含完整买卖双方地址（见文件头隐私口径）——匿名脚本按页翻即可低成本放大 CPU 与
  地址收集面。数值依据：仲裁台前端对每家节点每 30s 轮询一次（pages/arbiter/shared.tsx 的
  POLL_MS=30_000）＝ 2 次/分/店，60 次/分留了 30 倍余量，正常使用永远碰不到。
*/
const pendingLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '待仲裁列表查询过于频繁，请稍后再试' });

/** DB 行 → 待仲裁摘要（不含交付内容原文；事件史为链上公开信息，可附） */
function disputeToPublic(o) {
  let snap = {};
  try {
    snap = JSON.parse(o.product_snapshot || '{}');
  } catch {
    snap = {};
  }
  let onchainEvents = [];
  try {
    const parsed = JSON.parse(o.onchain_events || '[]');
    onchainEvents = Array.isArray(parsed) ? parsed : [];
  } catch {
    onchainEvents = [];
  }
  return {
    id: o.id,
    escrowOrderId: o.escrow_order_id,
    productSlug: o.product_slug,
    productTitle: snap.title || o.product_slug,
    productKind: snap.kind || 'physical',
    productImage: Array.isArray(snap.images) && snap.images[0] ? snap.images[0] : null,
    // 数量模型 v2：争议单可能为多份（同一快照同买家可重复下单，一份链上托管单 = 一个草稿单）
    quantity: o.quantity || 1,
    /*
      金额拆分（与 orders.js 的 orderToPublic 同口径，缺一不可）：
        cnyFen            = 本单应付总额（商品 + 运费），也是链上锁定 amountWei 的 CNY 口径
        shippingFeeCnyFen = 本单实际锁定的运费（按单收取一次；数字/NFT 单恒 0）
        goodsCnyFen       = cnyFen − 运费 = 商品金额（单价 × 数量）
      仲裁人要判的是"退多少"，而商品金额与运费是两笔不同的钱：只给总额，
      前端任何「本单单价 = 总额 ÷ 数量」的换算都会把运费摊成商品价
      （2 件 ¥10 + 运费 ¥5 → ¥12.50/件），裁决依据里就多出一个不存在的单价。
    */
    cnyFen: o.cny_fen,
    cny: yuanOf(o.cny_fen),
    shippingFeeCnyFen: o.shipping_fee_cny_fen || 0,
    shippingFeeCny: yuanOf(o.shipping_fee_cny_fen),
    goodsCnyFen: goodsFenOf(o.cny_fen, o.shipping_fee_cny_fen),
    goodsCny: yuanOf(goodsFenOf(o.cny_fen, o.shipping_fee_cny_fen)),
    amountWei: o.amount_wei,
    amountDecimal: weiToDecimal(o.amount_wei),
    /*
      已退买家（链上真值镜像；0 = 未退款）。
      为什么必须给（源码审计 2026-09）：`Staking.penalize` 的罚没上限基准是
      `amount − refundedAmount`，前端要显示"本单可罚没上限"就得有这一项；
      只给毛额时界面算出的上限**高于链上允许值**，仲裁人照填必然 revert `ExceedsCap()`。
      （争议单处于 disputed，通常在退款之前，所以它多为 0；但部分退款后再次进入争议的
      路径确实存在，不能靠"应该不会有"来省掉这个字段。）
    */
    refundedAmountWei: o.refunded_amount_wei || '0',
    /*
      买家**已授权**的部分退款额（= 链上 `acceptedPartialRefund(orderId)` 的镜像；'0' = 未授权）。
      为什么给：契约 2026-09 起 `approveRefund` 只接受「全额」或「买家精确授权过的那个数」，
      仲裁人看的是"这单双方谈到哪一步了"——买家已经点头的金额是裁决的重要上下文
      （例如双方已谈拢 40%、仲裁人再判一个完全不同的比例就是在推翻双方的和解）。
      公开无妨：这是「买家授权了多少」的**经济事实**，本身不含任何个人信息——
      与同一对象里的 refundedAmountWei 同级（链上 OrderCreated / PartialRefundAccepted 事件
      本来就公开可查），不新增泄露面（见文件头隐私口径）。
    */
    acceptedPartialRefundWei: o.accepted_partial_refund_wei || '0',
    acceptedPartialRefundDecimal: weiToDecimal(o.accepted_partial_refund_wei || '0'),
    buyer: o.buyer,
    seller: o.seller,
    /*
      交付证据已提交标记：任意交付行（码/NFT 凭证，v2 子表）、物流单号、**或发货标记 shipped_at**
      任一非空即视为已交付——裁决时可区分「未发货」争议与「已交付但货不对版/未收到」争议。

      必须走 `returns.hasDelivered`（**唯一实现**，三要素齐全；源码审计 2026-09 修复）：
      本地只判 `tracking_no`/交付行会漏掉「自提 / 线下交付」——`POST /:id/ship` 允许空物流单号，
      那种单照样会写 `shipped_at`（见 db.js 的列注释与 orders.js 的发货分支）。漏判的后果是
      `/arbiter` 列表给仲裁人一个**红色断言**「未交付（发货前争议）」，而货其实已经当面交给买家；
      仲裁人按列表分诊，看到的是与事实相反的证据，足以把裁决引向「判退款买家」。
      hasDelivered 里 `shipped_at` 那一项正是为此加的（见其注释）。
    */
    delivered: hasDelivered(o),
    timeoutBlocks: o.timeout_blocks,
    createdAt: o.created_at,
    // 售后流程镜像（两级售后 v2）：争议入口是「退款被拒」或「订单超时」——仲裁人可据此
    // 判断两级流程是否走完（requested/rejected 时间戳 + 陈述计数）；时间戳均为链上事件回写值
    refundStatus: o.refund_status || 'none',
    refundRequestedAt: o.refund_requested_at || null,
    refundRejectedAt: o.refund_rejected_at || null,
    /*
      平台费**按单**口径（与 orders.js 的 orderToPublic 同款，缺一不可）：
      合约按创建订单时快照的收取方（feeCollectorAtCreate）决定这单扣不扣费，全局 feeCollector()
      事后可改、不代表本单。仲裁人在算"本单可罚没上限/该退多少"时要能看出这笔钱里有没有平台费，
      所以把快照与按单判定一并下发（空串 → null；判定见 src/fees.js 的 feeChargeableForOrder）。

      ⚠ `feeBps` 必须与快照**同生共死**（源码评审 2026-09 修复，P2）：`fee_bps` 列是
      `INTEGER NOT NULL DEFAULT 0`，而它与 `fee_collector_at_create` 由**同一条 UPDATE** 补录
      （`/paid`、watcher、`/sync` 三处都是成对写）。所以"快照为空"就意味着"两列都没补录过"，
      此时把 `fee_bps` 当成 0 下发是**把"不知道"说成"不扣费"**：仲裁台会印出"本单费率 0%"，
      而链上实际按快照扣——前端为此专门区分 `null`（读不到）与 `0`（确实是 0，
      见 order-detail / arbiterMoney 的三态判据与 PendingDispute.feeBps 的类型 `number | null`）。
      旧实现写 `o.fee_bps || 0`，把这个三态压成了两态，等于让前端那半边的修复失效。
    */
    feeBps: o.fee_collector_at_create ? Number(o.fee_bps) || 0 : null,
    feeCollectorAtCreate: o.fee_collector_at_create ? String(o.fee_collector_at_create).toLowerCase() : null,
    feeChargeable: feeChargeableForOrder(o.fee_collector_at_create),
    evidenceCount: getDb().prepare('SELECT COUNT(*) AS c FROM dispute_evidence WHERE order_id = ?').get(o.id).c,
    // 进入争议时刻 = 最近一次状态迁移时间（watcher 回写 disputed 时更新）
    disputedAt: o.updated_at,
    onchainEvents,
  };
}

/** 待仲裁争议单列表（按进入争议时间倒序分页） */
router.get('/pending', pendingLimiter, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  const offset = (page - 1) * pageSize;
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'disputed'").get().c;
  const rows = db
    .prepare("SELECT * FROM orders WHERE status = 'disputed' ORDER BY updated_at DESC LIMIT ? OFFSET ?")
    .all(pageSize, offset);
  ok(res, { disputes: rows.map(disputeToPublic), total, page, pageSize });
}));

export default router;
