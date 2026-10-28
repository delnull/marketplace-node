/**
 * 仲裁数据面（供链上仲裁人裁决参考；本节点 = 一库多店，待仲裁单 = 本节点全部店铺的 disputed 订单）。
 *
 *  GET /api/arbitration/pending       待仲裁争议单列表（公开只读，分页倒序）
 *  GET /api/arbitration/after-sales   待处理**售后案件**列表（确认收货后开的案；公开只读，分页倒序）
 *
 * 裁决闭环：买家在订单页发起争议（链上 requestDispute）→ 节点 escrowWatcher 回写本单
 * 为 disputed（事件史追加 DisputeRequested）→ 仲裁人在前端「仲裁台」从各可达
 * 节点聚合本端点 → 行级查看详情（GET /api/orders/:orderNo，仲裁人身份可读全字段含交付证据）
 * → 钱包直调链上 Escrow.voteSettlement(orderId, refundWei) **票决**（达到当届阈值的那一票执行裁决：
 * 可全额退买家 / 全额判卖家 / 按金额拆分；节点不经手资金，无写接口）→ 各节点 watcher 轮询
 * Arbitrated 事件回写 settled/refunded，本列表自动收敛。
 *
 * **为什么售后案件是独立路由而不是并进 /pending 的一个 `kind`**：
 *  1. 两者是**不同的钱、不同的链上动作、不同的收口**：争议单资金还锁在托管里，裁决走
 *     `Escrow.voteSettlement` 票决；售后案件优先从 Escrow 留存的卖家货款退款、不足走
 *     `Staking.penalize`，收口走 `voteAfterSale`/`closeAfterSale`。合成一个列表后每个调用点都得按 kind 再分叉一次
 *     ——那正是本仓反对的"在调用点补判据"。
 *  2. 队列语义也不同：/pending 的候选是 `status='disputed'`（本地在途状态），
 *     /after-sales 的候选是 `after_sale_status='open'`（**叠加在终局之上的第二层**，见 afterSale.js）。
 *     两者的排序锚点、分页、限流与前端动作面都不一样。
 *  3. 但**字段口径必须一致**：两个端点共用同一个行映射 `disputeToPublic`（含 kind 判别位），
 *     所以仲裁台的两份数据面不会各长一套字段名。
 *
 * 隐私口径：待仲裁单已进入链上争议流程、售后案件也由链上 AfterSaleOpened 公开（含买卖双方），
 * 订单号/金额/参与方在链上事件中公开可查——本端点摘要**以链上公开信息为准**，不新增泄露面。
 * 两个字段是本地读数、不是链上事实，必须如实说明（P3-7）：
 *   · `orderNo` —— 含下单毫秒前缀、能继续探测本地详情面，只对已确证的链上仲裁人下发
 *     （匿名行 `orderNo = null`，见 disputeToPublic 的说明）；
 *   · `delivered` —— 本地对"货是否已交付"的**推断**（`returns.hasDelivered`：发货标记/物流单号/
 *     交付行三要素），不是链上读数。它不构成额外隐私面（不是收货信息/码原文），匿名摘要保留它，
 *     但接收方不能把它当成"链上已证明交付"。
 * 除这两项外，摘要字段都来自链上公开事件或订单公开金额，匿名可读。
 * 交付内容（兑换码/tokenId 原文）属敏感资源，不出现在摘要——裁决证据经详情接口
 * 按身份返回（买家本人/店主/仲裁人，见 orders.js 详情路由的 as 判定；售后案件同样对仲裁人开放）。
 *
 * ⚠️ 读取一律走**读模型视图 `v_orders`**（三表各一份：事实/收货/链上镜像），
 * 且下发的订单标识是**对外单号 `order_no`**（内部自增键 `order_id` 只用于子表关联与计数）。
 */
import { Router } from 'express';
import { getDb } from '../db.js';
import { ok, wrap, simpleRateLimit, bearerToken } from '../http.js';
import { verifyToken } from '../auth.js';
import { weiToDecimal, isArbiterForOrder } from '../chain.js';
// 金额展示口径的唯一实现（usdtOf / goodsMicroOf）——不要手写 (micro/1e6).toFixed(2)
import { goodsMicroOf, usdtOf } from '../money.js';
// 「已交付事实」的唯一实现（shipped_at / tracking_no / 交付行三要素）——不要在本文件重写判据
import { hasDelivered } from '../returns.js';
// 事件史对外的唯一折算点（库里的 at 是毫秒，出口一律 ISO；见 src/reputation.js）
import { eventsForDto } from '../reputation.js';
// 确认收货后的售后案件：在途判据与 DTO 字段的唯一实现（见 src/afterSale.js）
import { AFTER_SALE_OPEN_SQL } from '../afterSaleSql.js';
import { afterSaleFieldsOf } from '../afterSale.js';
// 队列等待读数（计数 + 最久等待）的唯一实现：本文件的两个列表与 /api/shop/metrics 共用
import { queueWait } from '../opsMetrics.js';
// 主图区缩略图的读取口径（图片取 url、视频取 poster）——**唯一实现**，卡片/订单/仲裁台共用
import { firstMediaThumb } from '../mediaKinds.js';

const router = Router();

/*
  待仲裁列表限流（公开只读，此前**无任何节点内限流**）：
  每行摘要都要跑 2 次 COUNT（evidenceCount = dispute_evidence 计数 + 列表的 total），
  且响应含完整买卖双方地址（见文件头隐私口径）——匿名脚本按页翻即可低成本放大 CPU 与
  地址收集面。数值依据：仲裁台前端对每家节点每 30s 轮询一次 ＝ 2 次/分/店，
  60 次/分留了 30 倍余量，正常使用永远碰不到。
*/
const pendingLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '待仲裁列表查询过于频繁，请稍后再试' });

/**
 * 这次请求的**已确证仲裁人地址**（唯一入口；读不到/非仲裁人返回 `null`）。
 *
 * 为什么只用来决定 `orderNo`：队列里的金额/双方地址/链上单号在链上事件里本就公开
 * （仲裁台匿名聚合它们是本文件的既有设计，且 RPC 故障时它仍必须可读）；
 * 但 `orderNo` 是**本地可继续探测的句柄**（时间前缀 + 50 bit 随机段，拿到它就能试
 * `/api/orders/:orderNo` 的详情面），它不是链上事实，只该给真正处理**这一单**的人。
 *
 * 注意这里只回答"令牌是谁"；"他能不能处理**这一行**"由 `isArbiterForOrder` 按**该单落定届**
 * 逐行判定（见 disputeToPublic）——拿当前届给整页判资格会在换届后把权限判反：
 * 旧届成员仍有这一单的裁决权，新届非该单成员没有。
 */
function verifiedArbiterAddress(req) {
  const token = bearerToken(req);
  if (!token) return null;
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return null;
  }
  return String(payload.address || '').toLowerCase() || null;
}

/**
 * 行 → 摘要（**两个列表共用**：争议单与售后案件，靠 `kind` 判别位分开）。
 * 字段口径必须一致，否则仲裁台的两份数据面会各长一套名字（见文件头"为什么独立路由"）。
 * @param {object} o `v_orders` 行
 * @param {'dispute'|'after_sale'} kind 判别位
 * @param {{actor?: string|null}} [opts] `actor` = 已确证令牌地址；**逐行**按该单落定届判资格
 * @returns {Promise<object>}
 */
async function disputeToPublic(o, kind = 'dispute', { actor = null } = {}) {
  let snap = {};
  try {
    // 快照是 MEDIUMTEXT（**刻意不是 JSON 列**：快照哈希是给第三方核验的契约，字节必须由应用决定，
    // 而 MySQL 的 JSON 会规范化键序/空白），所以这里仍要自己 parse
    snap = JSON.parse(o.product_snapshot || '{}');
  } catch {
    snap = {};
  }
  /*
    事件史是 `order_chain.events`（JSON 列 → 驱动解成数组），视图把它暴露为 `onchain_events`。
    视图对 `order_chain` 是 **LEFT JOIN**：还没上链的单没有那一行，`onchain_events` 因此是 NULL ——
    "没有链上事件史"在这里是可达状态（不是防御性分支），所以默认给空数组。
  */
  const onchainEvents = eventsForDto(o.onchain_events);
  return {
    // 判别位：同一份字段口径下的两类待办（'dispute'=争议中，'after_sale'=确认收货后的售后案件）
    kind,
    /*
      ⚠️ 对外标识是 `orderNo`（`CHAR(21)`，URL 里用的那个）。内部键 `order_id` 不出本节点：
      它在换库/重建之后会变，而仲裁台的链接要能长期指向同一张单。

      **但 orderNo 只给有权处理这一单的仲裁人**（`null` = 这一行不提供本地句柄）：
      它是"时间前缀 + 50 bit 随机段"的本地句柄，拿到它就可以继续探测详情面；
      匿名队列只需要链上事实（下面那些字段），不需要它。非 null 时仲裁台才能打开详情。
      判据是 `isArbiterForOrder(actor, escrowOrderId)`——**这一单落定届**的成员，不是当前届：
      换届后旧届成员仍要有句柄去处理在途争议，新届非该单成员不该拿到。
      拿不到链上订单键（`escrow_order_id` 为空）的行：**不下发** orderNo（没有订单键就无法
      回答"这一单是谁的"；按当前届给一个句柄就是把"本地可探测面"交给不该看的人）。
      代价如实写明：匿名轮询仍能拿到金额/双方地址（链上公开），但拿不到可探测的句柄；
      未登录的仲裁台看不到详情链接，需要先按本节点登录（前端 tokenOf(origin) 已有）。
    */
    orderNo: actor && o.escrow_order_id && (await isArbiterForOrder(actor, o.escrow_order_id)) ? o.order_no : null,
    /* 订单详情的店铺维度；配合该节点 operator 才能构造 `/orders/<operator>:<code>/<orderNo>`。 */
    shopCode: o.shop_code || null,
    escrowOrderId: o.escrow_order_id,
    /*
      订单身份的另一半：**快照哈希**。仲裁动作要在本地复算
      `orderId = keccak(快照哈希 ‖ 卖家 ‖ 买家 ‖ 本地单号)` 并与节点下发的
      `escrowOrderId` 逐字比对，才能挡住“同一对当事人、同一金额、换一笔单”的签名目标替换。
      哈希本身是公开事实（商品快照的哈希，订单详情里本来就展示），不含个人信息。
    */
    snapshotHash: o.snapshot_hash || null,
    productSlug: o.product_slug,
    productTitle: snap.title || o.product_slug,
    productKind: snap.kind || 'physical',
    // 商品缩略图：主图区第一项的**缩略图**（图片取 url，视频取封面 poster）。
    // 这里只下发 URL 字符串（仲裁台的列表是密集列表，不该为了一个缩略图去解析媒体类型）；
    // 相对路径由前端按该单所属节点的 origin 拼绝对地址（与商品页同一套解析）。
    productImage: firstMediaThumb(snap.media),
    // 数量模型 v2：争议单可能为多份（同一快照同买家可重复下单，一份链上托管单 = 一个草稿单）
    quantity: o.quantity || 1,
    /*
      金额拆分（与 orders.js 的 orderToPublic 同口径，缺一不可）：
        usdtMicro            = 本单应付总额（商品 + 运费），也是链上锁定 amountWei 的 USDT 口径
        shippingFeeUsdtMicro = 本单实际锁定的运费（按单收取一次；数字/NFT 单恒 0）
        goodsUsdtMicro       = usdtMicro − 运费 = 商品金额（单价 × 数量）
      仲裁人要判的是"退多少"，而商品金额与运费是两笔不同的钱：只给总额，
      前端任何「本单单价 = 总额 ÷ 数量」的换算都会把运费摊成商品价
      （2 件 10 USDT + 运费 5 USDT → 12.5 USDT/件），裁决依据里就多出一个不存在的单价。
    */
    usdtMicro: o.usdt_micro,
    usdt: usdtOf(o.usdt_micro),
    shippingFeeUsdtMicro: o.shipping_fee_usdt_micro || 0,
    shippingFeeUsdt: usdtOf(o.shipping_fee_usdt_micro),
    goodsUsdtMicro: goodsMicroOf(o.usdt_micro, o.shipping_fee_usdt_micro),
    goodsUsdt: usdtOf(goodsMicroOf(o.usdt_micro, o.shipping_fee_usdt_micro)),
    // 金额列是 `DECIMAL(38,0)` → 驱动给**字符串**（见 db.js：38 位 wei 过不了 JS number）；
    // 展示用的十进制同样由 chain.weiToDecimal 从字符串算，不经过 number
    amountWei: o.amount_wei,
    paymentToken: o.payment_token || null,
    paymentSymbol: o.payment_symbol || null,
    paymentDecimals: o.payment_decimals ?? 18,
    amountDecimal: weiToDecimal(o.amount_wei, o.payment_decimals ?? 18),
    /*
      已退买家（链上真值镜像）。**必须给**：`Staking.penalize` 的罚没上限基准是
      `min(amount − refundedAmount, escrow.sellerNetAtSettle(orderId))`——**毛额那一腿**由这里给，
      **净额那一腿**由前端直接读链。只给毛额、或按毛额算上限，界面算出的数就
      **高于链上允许值**，仲裁人照填必然 revert `ExceedsCap()`。
      NULL = 这一单还没有链上镜像行（尚未托管），与 '0'（确证没退过款）是两件事：
      所以这里保留 null，不折成 '0'。
    */
    refundedAmountWei: o.refunded_amount_wei ?? null,
    /*
      买家**已授权**的部分退款额（= 链上 `acceptedPartialRefund(orderId)` 的镜像；'0' = 未授权）。
      为什么给：`approveRefund` 只接受「全额」或「买家精确授权过的那个数」，
      仲裁人看的是"这单双方谈到哪一步了"——买家已经点头的金额是裁决的重要上下文
      （例如双方已谈拢 40%、仲裁人再判一个完全不同的比例就是在推翻双方的和解）。
      公开无妨：这是「买家授权了多少」的**经济事实**，本身不含任何个人信息——
      与同一对象里的 refundedAmountWei 同级（链上事件本来就公开可查），不新增泄露面。
    */
    acceptedPartialRefundWei: o.accepted_partial_refund_wei ?? null,
    // 与 refundedAmountWei 同口径：null = 读不到，'0' = 确证未授权；且必须按支付资产精度换算
    // （ERC20 6 位精度的单用默认 18 位会放大 1e12，仲裁人看到的授权额将完全错误）。
    acceptedPartialRefundDecimal: weiToDecimal(o.accepted_partial_refund_wei, o.payment_decimals ?? 18),
    buyer: o.buyer,
    seller: o.seller,
    /*
      交付证据已提交标记（**本地交付推断，不是链上读数**）：任意交付行（码/NFT 凭证）、
      物流单号、**或发货标记 shipped_at** 任一非空即视为已交付——裁决时可区分「未发货」争议
      与「已交付但货不对版/未收到」争议。匿名队列也会下发它；接收方不得把它当成链上事实
      （链上没有"是否发货"这个字段，只有 Escrow 的托管状态）。

      必须走 `returns.hasDelivered`（**唯一实现**，三要素齐全）：本地只判 `tracking_no`/交付行
      会漏掉「自提 / 线下交付」——`POST /:orderNo/ship` 允许空物流单号，那种单照样会写
      `shipped_at`。漏判的后果是 `/arbiter` 列表给仲裁人一个**红色断言**「未交付（发货前争议）」，
      而货其实已经当面交给买家；仲裁人按列表分诊，看到的是与事实相反的证据。
    */
    delivered: await hasDelivered(o),
    timeoutBlocks: o.timeout_blocks,
    // `created_at` / `updated_at` 是 DATETIME(3) → `Date`，对外 JSON 是 ISO-8601
    createdAt: o.created_at,
    // 售后流程镜像（两级售后 v2）：争议入口是「退款被拒」或「订单超时」——仲裁人可据此
    // 判断两级流程是否走完（requested/rejected 时间戳 + 陈述计数）
    refundStatus: o.refund_status || 'none',
    refundRequestedAt: o.refund_requested_at || null,
    refundRejectedAt: o.refund_rejected_at || null,
    /*
      零费模型：订单上没有平台费/节点抽成的费率快照可下发——仲裁人按
      "毛额 − 已退买家"与卖家的在途敞口/保证金读数判断可罚没上限与应退金额。
    */
    // 子表用**内部订单键**（dispute_evidence.order_id 是它的外键）
    evidenceCount: Number((await getDb().get('SELECT COUNT(*) AS c FROM dispute_evidence WHERE order_id = ?', o.order_id)).c),
    // 进入争议时刻 = 最近一次状态迁移时间（watcher 回写 disputed 时更新）
    disputedAt: o.updated_at,
    /*
      确认收货后的售后案件（契约 2026-10 第二批；字段口径见 src/afterSale.js）。
      争议单恒为 none（两套流程互斥：案件要求订单已终局，争议要求资金仍在托管里），
      一并下发是为了让两份列表**形状一致**——仲裁台不必按 kind 决定读不读这几个字段。
    */
    ...afterSaleFieldsOf(o),
    onchainEvents,
  };
}

/** 待仲裁争议单列表（按进入争议时间倒序分页；附"最久等待"读数） */
router.get('/pending', pendingLimiter, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  const offset = (page - 1) * pageSize;
  const db = getDb();
  const actor = verifiedArbiterAddress(req);
  const total = Number((await db.get("SELECT COUNT(*) AS c FROM v_orders WHERE status = 'disputed'")).c);
  const rows = await db.all("SELECT * FROM v_orders WHERE status = 'disputed' ORDER BY updated_at DESC LIMIT ? OFFSET ?", pageSize, offset);
  /*
    仲裁台是**节点级**视图（仲裁人要看到这台机器上所有店铺的争议单），所以店铺参数显式传
    `null` = 全部在售店铺。**不能省**：`queueWait` 的店铺参数漏传即抛错——
    "默认成全部"是一次静默的跨店混算，宁可在这里响亮地失败。
  */
  /*
    逐行映射与等待读数都**必须 await**：`disputeToPublic` 每行要读一次交付事实与一次证据计数，
    `queueWait` 一次聚合查询——三者都是异步库调用。漏掉任何一个 await，下发的就不是摘要而是
    一个 Promise，而 `JSON.stringify` 会把 Promise 序列化成 `{}`：响应仍是 200、`total` 仍是真数，
    只有条目内容变成空对象（前端读到 `undefined`，仲裁台整列空白，且没有任何一处报错）。
  */
  ok(res, {
    disputes: await Promise.all(rows.map((r) => disputeToPublic(r, 'dispute', { actor }))),
    total,
    page,
    pageSize,
    waiting: await queueWait({ where: "status = 'disputed'", timeCol: 'updated_at', seller: null }),
  });
}));

/**
 * 待处理**售后案件**列表（确认收货后开的案；按开案时间倒序分页；附"最久等待"读数）。
 *
 * 候选 = `after_sale_status='open'` 的订单（列在 `order_chain`，本地镜像；三条回填路径见 afterSale.js）。
 * 排序用 after_sale_opened_at（本队列的待办起点），**不是** updated_at：案件不迁移订单状态、
 * 也不动 updated_at（那是入账窗口锚点），拿它排序会是"这笔钱什么时候结清的"，与待办无关。
 * 读的是视图：`after_sale_status` 与 `status` 分居两张表，而候选判据跨这两列。
 */
router.get('/after-sales', pendingLimiter, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  const offset = (page - 1) * pageSize;
  const db = getDb();
  const actor = verifiedArbiterAddress(req);
  const total = Number((await db.get(`SELECT COUNT(*) AS c FROM v_orders WHERE ${AFTER_SALE_OPEN_SQL}`)).c);
  const rows = await db.all(`SELECT * FROM v_orders WHERE ${AFTER_SALE_OPEN_SQL} ORDER BY after_sale_opened_at DESC LIMIT ? OFFSET ?`, pageSize, offset);
  ok(res, {
    afterSales: await Promise.all(rows.map((r) => disputeToPublic(r, 'after_sale', { actor }))),
    total,
    page,
    pageSize,
    waiting: await queueWait({ where: AFTER_SALE_OPEN_SQL, timeCol: 'after_sale_opened_at', seller: null }),
  });
}));

export default router;
