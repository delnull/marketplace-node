/**
 * 买家履约信号（**本店视角**，ownerOnly 只读）——`GET /api/shop/buyer-signal?address=0x…`。
 *
 * 回答的问题只有一个：**这个买家在本店的历史长什么样**（成交/确认/退款/争议/超时释放的分布），
 * 好让店主在面对一笔新订单时有一条可查的线索。它**不是**跨店信用分，也**不是**判定。
 *
 * 三条边界，写在这里免得被"顺手扩展"改掉：
 *  1. **只做本店视角**：节点只数自己镜像的订单，绝不拿一个地址去联邦其它节点查询。
 *     别人的顾客数据不在本店的数据面上；"替卖家打听这个人在别家怎么样"正是隐私面。
 *     所以响应里给的是 `scope: 'this_shop_only'`，note 里也把这句话说给店主听。
 *  2. **口径必须可独立复算**：每个计数都对应一个**链上事实**，第三方扫链即可复算——
 *     `settledToSeller` ← `getOrder.status ∈ Settled`（本地 confirmed/settled/expired）；
 *     `refundedToBuyer` ← `getOrder.refundedAmount > 0`（本地 refunded_amount_wei）；
 *     `disputed` / `expiredReleased` ← `DisputeRequested` / `OrderExpiredReleased` 日志
 *     （本地事件镜像 onchain_events，最权威的是当前状态本身）；
 *     `afterSaleOpen/Closed` ← `afterSaleOpenedAtBlock != 0` / 已结案；
 *     `refundRequested` ← `RefundRequested` 日志（本地耐久痕迹 refund_requested_at）。
 *  3. **三态纪律**：读不到的单**单列**（`unverified`），既不进分子分母、也不当作"没有发生"；
 *     小样本（默认 < 3 张成交单）时比率一律 `null` 而不是 0——"1 张单 1 次退款"读出来是 100%，
 *     那是指数级的误导。
 *
 * 为什么**不**复用 `/api/shop/reputation` 的 `computeReputation`：那是**按事件发生次数**、
 * 且只统计"事件史里有 OrderCreated"的单（为了不让分子脱离分母而整单跳过，见 reputation.js）。
 * 买家信号要回答的是"这个人在本店一共成交几单、退过几单"，用事件计数会：
 *   · 把**没有事件镜像**的单整张丢掉（那是"读不到"，应当单列而不是消失）；
 *   · 把"一次退款"与"一次争议"混成同一类事件计数（这里要的是**每单恰好计一次**的分布）。
 * 所以这里用**列口径**（本地镜像自己的真值，逐项对应链上 getOrder/事件），只借用 reputation.js
 * 的 `parseOnchainEvents`（事件 JSON 的唯一解析入口）读两处"历史事实"。
 *
 * 响应形状的另一端（前端）：`frontend/src/types.ts` 的 `BuyerSignal` 与
 * `frontend/src/utils/buyerSignal.ts`（不提供 ≠ 0、小样本不出比率、限定语只有一份）。
 *
 * 文案纪律（本仓硬要求）：这是**可疑信号，不是结论**。所以响应里只有计数与比率，
 * 没有一个判定词，也不提供"是否拉黑"这类结论字段；解读的责任在店主，判断的依据是订单明细。
 */
import { getDb } from './db.js';
import config from './config.js';
import { INCOME_STATUS } from './orderStatus.js';
import { parseOnchainEvents } from './reputation.js';

/**
 * 比率的最小样本量（不足则比率置 null）。
 * 3 是"至少有两张单可以互相对照"的下限；样本量本身（`sample`）随响应下发，
 * 前端的展示阈值必须读它（两处不一致会出现"服务端给了数、界面说样本不足"）。
 */
export const SIGNAL_MIN_SAMPLES = 3;

/** 比率：分母 0 → null；4 位小数（与履约画像同款，防浮点尾巴） */
const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : null);

/** 该单是否退过钱给买家（`refunded_amount_wei != '0'`，含全额与部分/仲裁拆分；链上 getOrder.refundedAmount 的镜像） */
function hasRefundedToBuyer(row) {
  try {
    return BigInt(row?.refunded_amount_wei || '0') > 0n;
  } catch {
    return false; // 脏值不当成"退过款"（宁可低报，也不凭空指控一次退款）
  }
}

/**
 * 纯函数：给定**该买家的全部订单行**（orders 行）→ 履约信号（不触链、不查库，可单测）。
 *
 * **样本**（比率的分子分母同源，这是本仓反复强调的那条纪律）= 该买家在本店**真实发生过托管**
 * 的订单，判据是 `paid_tx_hash` 非空（支付凭证不变量：escrowed 及以上必有凭证，见 routes/orders.js
 * 文件头）。刻意**不用** `escrow_order_id`：那一列在**下单草稿**时就已生成（orderId 随草稿落库），
 * 拿它当"成交"会把一堆从未付款的草稿算进分母——"5 张单 0 次履约"就会看起来像履约记录。
 *
 * @param {Array<object>} rows 该买家的 orders 行
 * @param {{address?: string, minSamples?: number, now?: number}} opts
 */
export function computeBuyerSignal(rows, { address, minSamples = SIGNAL_MIN_SAMPLES, now = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const addr = String(address || '').toLowerCase();
  const min = Number.isFinite(Number(minSamples)) && Number(minSamples) > 0 ? Math.floor(Number(minSamples)) : SIGNAL_MIN_SAMPLES;

  let localOrders = 0;
  let sample = 0;
  let unverified = 0;
  let settledToSeller = 0;
  let refundedBuyer = 0;
  let disputed = 0;
  let expiredReleased = 0;
  let confirmed = 0;
  let refundRequested = 0;
  let afterSaleOpen = 0;
  let afterSaleClosed = 0;
  for (const r of list) {
    localOrders += 1;
    if (!r?.paid_tx_hash) continue; // 未付款（草稿/已取消）：没有履约可谈，不进样本
    sample += 1;
    const status = String(r?.status || '');
    // ① 钱判给店主（链上 Settled）：确认收货 / 仲裁判卖家 / 超时释放 / 双方和解
    if (INCOME_STATUS.includes(status)) settledToSeller += 1;
    // ② 钱退给买家（链上 refundedAmount > 0，含部分退款与拆分裁决）
    if (hasRefundedToBuyer(r)) refundedBuyer += 1;
    // ③ 买家自己确认过收货（链上 ReceiptConfirmed → 本地 confirmed 是它唯一的来源）
    if (status === 'confirmed') confirmed += 1;
    // ④ 超时释放：本地 expired 只由 OrderExpiredReleased 回写；事件史里再兜一次（漏扫后被 /sync 收敛成 settled 的单）
    const events = parseOnchainEvents(r?.onchain_events);
    const hasEvent = (name) => events.some((e) => e && e.name === name);
    if (status === 'expired' || hasEvent('OrderExpiredReleased')) expiredReleased += 1;
    // ⑤ 曾进入争议：当前状态为 disputed，或事件史里有 DisputeRequested
    if (status === 'disputed' || hasEvent('DisputeRequested')) disputed += 1;
    /*
      ⑤ 的"读不到"单独计数：本单**已终局**（钱已判走）却**没有 OrderCreated 镜像**
      （paid 与 watcher 两条路径都会补写它：没有它，这一单在本地的链上过程就无从复算）——
      它到底有没有争议过，本地没有可复算的痕迹。这类单不进分子，也不当作"从没争议"。
      在途单（escrowed/shipped）排除在外：链上还在 Created 的单不可能已经争议过
      （合约不允许从争议退回 Created）。
    */
    else if (!hasEvent('OrderCreated') && status !== 'escrowed' && status !== 'shipped') unverified += 1;
    /*
      ⑥ 提出过退款申请：取**耐久痕迹** `refund_requested_at`（而不是数 RefundRequested 事件）——
      终局迁移会复位 refund_status，却刻意保留这一列时刻（见 escrowWatcher 的两级售后分支），
      所以它比"事件史里还有没有那条事件"更可靠（事件史只保留最近 20 条，会被挤掉）。
    */
    if (Number(r?.refund_requested_at) > 0 || String(r?.refund_status) === 'requested') refundRequested += 1;
    // ⑦ 售后案件（本地列状态；案件是叠加在终局之上的第二层，不动 orders.status）
    const as = String(r?.after_sale_status || 'none');
    if (as === 'open') afterSaleOpen += 1;
    else if (as === 'closed') afterSaleClosed += 1;
  }

  const enough = sample >= min;
  const rate = (n) => (enough ? ratio(n, sample) : null);
  return {
    // ===== 前端契约字段（frontend/src/types.ts 的 BuyerSignal）=====
    available: true, // 本读数全部来自本地镜像：对合法地址恒可读；读不到的单在 unverified 里单列
    note: enough
      ? `样本 ${sample} 单（本店与该买家的订单共 ${localOrders} 张，其中真实发生托管的 ${sample} 张）：比率以它为分母。`
      : `本店与该买家共 ${localOrders} 张订单，其中真实发生托管的只有 ${sample} 张，不足 ${min} 张：` +
        '比率一律置 null——小样本下任何比例都不构成信号，请直接看分项计数与订单明细。',
    sample,
    settledToSeller,
    refundedToBuyer: refundedBuyer,
    disputed,
    afterSaleOpen,
    afterSaleClosed,
    expiredReleased,
    // 「确认收货占比」：买家自己确认过收货的比例（confirmed 只由真实 ReceiptConfirmed 事件产生）
    confirmRate: rate(confirmed),
    // 「退款率」：**实际退过款**的单占比（含部分退款；钱真的退回去了，比"申请过"更硬）
    refundRate: rate(refundedBuyer),
    // 「退款申请率」：提出过退款申请的单占比（含被拒/撤回——申请本身也是信号，且与上一条不同义）
    refundRequestRate: rate(refundRequested),
    disputeRate: rate(disputed),

    // ===== 口径与三态（附加字段；前端不消费，供人工核对与后续扩展）=====
    /** 三个比率的分子里那两个**没有**契约字段的计数（原始计数照给，读者可自行标注 n 笔） */
    confirmed,
    refundRequested,
    /** 比率的分母（= sample）与阈值；前端若把阈值写死在本地，务必与这里保持一致 */
    ratioBasis: { denominator: 'sample', value: sample, minSamples: min },
    minSamples: min,
    localOrders,
    unverified: {
      /**
       * 已终局、却没有 `OrderCreated` 镜像的单数（事件史为空，或那条事件被 20 条上限挤出）：
       * 它们的**争议史/超时释放史读不到**（本地只留下终局状态本身）——所以上面这两个计数是**下界**，
       * 而这批单既不计入分子分母、也不当作"从没发生过"。
       */
      terminalWithoutEventMirror: unverified,
      note:
        '这些单已终局，但本地事件史里没有 OrderCreated（paid/watcher 都会补写它）：' +
        '它们是否曾经争议/超时释放**读不到**，不计入 disputed / expiredReleased，也不当作"没发生过"。',
    },
    scope: 'this_shop_only',
    shopOwner: (config.shop.owner || '').toLowerCase() || null,
    scopeNote:
      '本读数只统计**本店**与该买家的历史：节点不会为任意地址去其他店铺查询（那是别人的数据面，也是隐私面）。' +
      '你看到的就是"该买家在本店的表现"，不代表他在别处如何。',
    signalNote:
      '这些是**可疑信号，不是结论**：退款/争议偏多也可能来自商品描述不清、物流问题或规则分歧；' +
      '本读数不构成对任何买家的判定，也不应作为自动拒单/降权/封禁的唯一依据——' +
      '判断请结合订单明细、沟通记录与平台规则，并按适用法律处理个人信息。',
    caveats: [
      '计数逐项对应一个链上事实：settledToSeller ← getOrder.status=Settled；refundedToBuyer ← refundedAmount>0；disputed/expiredReleased ← DisputeRequested/OrderExpiredReleased 日志；afterSaleOpen/Closed ← afterSaleOpenedAtBlock 与结案事件；refundRequested ← RefundRequested（本地耐久痕迹）。第三方扫链可逐项复算。',
      `disputed 与 expiredReleased 依赖本地事件镜像：已终局却没有事件史的单（当前 ${unverified} 单）一律计入 unverified，因此这两个计数是**下界**。`,
      'afterSaleClosed 也是下界：链上快照（afterSaleOpen=false）分不清"从未开案"与"开过又结了"，这类单本地停在 none（见 src/afterSale.js）。',
      '样本 = 真实发生过托管的单（paid_tx_hash 非空）；草稿与本地取消单不进分母（没付款就谈不上履约），它们在 localOrders 里如实计数。',
    ],
    generatedAt: now,
  };
}

/** 端点用入口：读该买家在本店的订单行 → 纯函数（无链上读取、无跨店查询） */
export function buyerSignal(address, opts = {}) {
  const addr = String(address || '').toLowerCase();
  const rows = getDb().prepare('SELECT * FROM orders WHERE buyer = ? ORDER BY created_at DESC').all(addr);
  return computeBuyerSignal(rows, { address: addr, ...opts });
}
