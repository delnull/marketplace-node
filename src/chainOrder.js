/**
 * 链上订单读取的**可注入包装**（唯一一份）。
 *
 * 为什么单独一个模块：`fetchOnchainOrder`（chain.js）直接打 RPC，单测里只能起假 JSON-RPC 服务器
 * 才能伪造返回值。而"链上当前真值"是好几处判断的依据——对账（chainReconcile）与码池补货后的
 * 自动交付补跑（autoDeliver）都要按它决定**要不要动钱/发货**。两边各自留一个注入钩子就会出现
 * "同一个东西两套实现"，所以钩子只在这里留一个：
 *   · 生产：默认直接调 chain.js 的 `fetchOnchainOrder`；
 *   · 测试：`setChainOrderFetcher(fn)` 注入假读数（传 null 恢复默认）。
 *
 * `chainReconcile.js` 仍然**再导出** `setChainOrderFetcher`（既有测试按那个路径导入），行为不变。
 *
 * 售后案件同理走本模块的 `fetchAfterSaleFor`：它是 `POST /api/orders/:id/sync`（人工兜底）与
 * `chainReconcile`（后台兜底）**共用**的链上读数，而"读到的真值怎么落列"由
 * src/afterSale.js 的 `applyAfterSaleFromChain` 唯一决定。
 *
 * 同理，凡是**按链上真值决定要不要把货交出去**的地方，判据只有本模块的 `deliveryGate` 一处
 * （三个手动交付入口 + 自动交付），"这个链上单号是不是我这一单"只有 `chainParamsMatch` 一处
 * （交付闸、watcher 事件分支、后台对账共用）——判据落在调用点上就是两个答案层的开始。
 *
 * 本节点没有平台费、没有节点抽成、没有链上店铺登记：订单身份只有 **(orderId, 买家, 卖家, 金额,
 * 验货窗口)** 五项，比对也只比这五项。
 */
import { fetchOnchainOrder, getEscrow } from './chain.js';

let _fetchOrder = (orderIdHex, opts) => fetchOnchainOrder(orderIdHex, opts);

/** 测试注入链上订单读取器（传 null 恢复默认） */
export function setChainOrderFetcher(fn) {
  _fetchOrder = fn || ((orderIdHex, opts) => fetchOnchainOrder(orderIdHex, opts));
}

/** 读取链上订单真值（形状见 chain.fetchOnchainOrder）；抛错 = 读不到，**不是**"链上没有" */
export function fetchOrderFor(orderIdHex, opts) {
  return _fetchOrder(orderIdHex, opts);
}

/**
 * 链上真值与本地订单锁定参数逐项比对（买家/卖家/金额/**验货窗口**皆不可变）。
 *
 * 为什么这四项就是订单身份：合约的 `createOrder(orderId, seller, amount, timeoutBlocks)` 只接
 * 这四项，`OrderCreated` 也只带 orderId/buyer/seller/amount。同一 orderId 上的"另一笔单"
 * 只能靠其中某一项不同来区分——任一项不同，这条链上读数就不能驱动本地状态。
 *
 * 缺字段的行为（刻意保留）：读取器从创建起就提供这四项，生产形状上不存在缺失，
 * 而测试桩会用部分对象；缺项跳过。改动这一形状时要同时改本函数的调用点与
 * test/chain-amounts.test.js。
 *
 * 为什么住在这里而不是各调用点：草稿的 `escrowOrderId` 虽然**不在匿名列表里**，但详情页以
 * 不可枚举的 order_no 为键，拿到那张 URL 的人就能读出支付参数；任何**按链上读数动钱或发货**
 * 的地方都必须先回答"这个链上单号确实是我这单吗"，否则一个 1 wei 的诱饵单就能驱动本地状态
 * （库存占位释放、自动发码、事件史造假）。判据只有这一份：交付闸（`deliveryGate`）、
 * watcher 的事件分支、后台对账（chainReconcile）、`/sync`、`/cancel` 共用它。
 */
export function chainParamsMatch(local, p) {
  if (!p) return true;
  const buyerOk = !p.buyer || String(p.buyer).toLowerCase() === String(local.buyer || '').toLowerCase();
  const sellerOk = !p.seller || String(p.seller).toLowerCase() === String(local.seller || '').toLowerCase();
  let amountOk = true;
  if (p.amount !== undefined && p.amount !== null) {
    try {
      amountOk = BigInt(p.amount) === BigInt(local.amount_wei || '0');
    } catch {
      amountOk = false;
    }
  }
  /*
    验货窗口也是订单身份的一部分：同一对当事人、同一金额、**不同 timeoutBlocks** 的诱饵单
    同样能驱动本地状态（例如本地 7 天窗口的单被判成 1 块窗口的单，随后被快速 releaseExpired）。
    本地/链上任一侧读不到时不做比较（老行/测试桩），读到就必须逐字相等。
  */
  const lt = Number(local.timeout_blocks);
  const ct = Number(p.timeoutBlocks);
  const timeoutOk =
    !Number.isSafeInteger(lt) || lt <= 0 || !Number.isSafeInteger(ct) || ct <= 0 || lt === ct;
  /*
    支付资产也是订单身份：ERC20 单的 amount 是 token 最小单位，原生单是 wei。
    只比数字会让一张 6 位 USDT 单被同数字的原生灰尘单顶替（12.5 USDT = 12.5M token units
    = 12.5M wei）。生产调用方 `fetchOnchainOrder` 总是给出 token；只有测试桩省略该字段时跳过，
    这是夹具形状，不是“链上读不到也放行”。
  */
  let tokenOk = true;
  if (p.token !== undefined && p.token !== null) {
    /*
      本地缺 `payment_token` 时必须 fail-closed：旧写法 `|| ZERO_ADDRESS` 会把“SELECT 漏列”
      伪装成“原生单”，ERC20 单因此被当成诱饵单永久跳过。生产入口必须把该列读出来。
    */
    tokenOk = String(p.token).toLowerCase() === String(local.payment_token || '').toLowerCase();
  }
  return buyerOk && sellerOk && amountOk && timeoutOk && tokenOk;
}

/**
 * 一条解码后的 `OrderCreated` 日志是否属于**本单**（orderId + 买家 + 卖家 + 金额）。
 *
 * 为什么不能只靠 `queryFilter` 的 indexed 过滤：那同样是 RPC 的承诺。`/sync` 拿日志补
 * `paid_tx_hash`、`/paid` 拿收据日志确认托管——两处都已核对 `log.address`，但地址只证明
 * "这条日志由托管合约发出"，不证明它属于这一单。一个错误/被劫持的 RPC 可以返回**另一个订单**
 * 的 OrderCreated（同样来自托管地址），把它的 txHash 写成本单的支付凭证。这里把事件字段与
 * 本地锁定值逐项对齐，两处共用这一份。
 *
 * 缺字段一律 false（与 `chainParamsMatch` 的"缺字段跳过"相反：这是收据/凭证动作，
 * 读不到就不该落库）。
 */
export function orderCreatedMatches(order, args, escrowOrderId, token) {
  if (!order || !args) return false;
  const id = String(args.orderId || '').toLowerCase();
  const wantId = String(escrowOrderId || order.escrow_order_id || '').toLowerCase();
  if (!id || id !== wantId) return false;
  const buyerOk = String(args.buyer || '').toLowerCase() === String(order.buyer || '').toLowerCase();
  const sellerOk = String(args.seller || '').toLowerCase() === String(order.seller || '').toLowerCase();
  if (!buyerOk || !sellerOk) return false;
  /*
    事件本身不带 token；调用方必须把链上 `orderToken(orderId)` 读出来传进来。
    没有这个参数就不认（fail-closed）——不能让“只比金额”的旧调用悄悄放行。
  */
  const actualToken = String(token || '').toLowerCase();
  if (!actualToken || actualToken !== String(order.payment_token || '').toLowerCase()) return false;
  try {
    return BigInt(args.amount) === BigInt(order.amount_wei || '0');
  } catch {
    return false;
  }
}

/**
 * **交付闸**（发货/发码/NFT 登记的唯一判据层）：现在能不能把货交出去。
 *
 * ── 为什么不能用本地 `orders.refund_status`（本模块存在的理由）────────────────
 * 那一列是 watcher 以 `head − MK_ESCROW_FINALITY_BLOCKS`（默认 12 块 ≈ 1 分钟）为上界回写的**镜像**，
 * 所以买家在 `createOrder` 之后紧接着 `requestRefund` 的那 12 块里，镜像**必然**还是 `none`。
 * 判据落在镜像上，就等于给了"钱已冻结、货照发"一个结构性窗口：买家手里有货/码，
 * 而托管里的钱被 `refundRequested` 永久挡住超时释放（卖家只能拒绝 → 争议 → 仲裁，双损）。
 * 四个交付入口（三个手动 + 自动）全部经本函数，判据只剩一处。
 *
 * ── 判据与方向 ────────────────────────────────────────────────────────────
 *   · 链上 `status` 必须是 `Created`（钱还在托管里；`Disputed`/`Settled`/`Refunded` 都不该发货）；
 *   · 链上 `refundRequested` 必须为假（真值只在链上；卖家拒绝后它为假 ⇒ 恢复可交付）；
 *   · 链上同单号的买家/卖家/金额/验货窗口与本单不符 ⇒ 拒绝（诱饵单，见 chainParamsMatch）；
 *   · 链上读不到 ⇒ **拒绝**（fail-closed）。代价如实写明：节点 RPC 故障期间卖家发不了货，
 *     而"读不到就放行"恰恰会把上面那个窗口原样还回来。
 *
 * ── 残余窗口（如实写明）────────────────────────────────────────────────────
 * 判据是**读的那一刻**的链上真值，从读数到本地落库之间仍有**一次 RPC 往返**的窗口——
 * 比原先的"一个 finality 深度"小三个数量级，但不可能为零（链上随时可以再变）。
 *
 * @param {object} order 本地订单行（需 buyer/seller/amount_wei/escrow_order_id）
 * @returns {Promise<{ok:true, chain:object} | {ok:false, code:string, message:string}>}
 *          判别式（**不抛错**）：调用方只需 `if (!gate.ok) return fail(res, gate.message)`
 */
export async function deliveryGate(order) {
  const orderIdHex = String(order?.escrow_order_id || '').trim().toLowerCase();
  if (!orderIdHex) {
    return {
      ok: false,
      code: 'no_escrow_id',
      message: '该订单还没有链上托管单号，无法核验链上是否已冻结——请先对该订单执行「同步链上状态」',
    };
  }
  let chain;
  try {
    chain = await fetchOrderFor(orderIdHex);
  } catch (e) {
    return {
      ok: false,
      code: 'unreadable',
      message: `读不到链上托管状态（${e?.message || e}）：交付前必须确认这笔钱仍在托管且未被申请退款，本次已中止，请稍后重试`,
    };
  }
  if (!chainParamsMatch(order, chain)) {
    return {
      ok: false,
      code: 'decoy',
      message:
        '链上同单号的托管单与本单的买家/卖家/金额/验货窗口不一致——疑似他人对同一单号的诱饵单，已阻止交付，请核对该订单',
    };
  }
  if (String(chain.status) !== 'Created') {
    return {
      ok: false,
      code: 'not_in_escrow',
      message: `链上这笔托管已不在「托管中」（当前：${chain.status}）——已阻止交付，请刷新后按链上真值处理（该单可能已退款/已结算/已进入争议）`,
    };
  }
  if (chain.refundRequested) {
    return {
      ok: false,
      code: 'refund_pending',
      message: '链上显示买家已申请退款（资金冻结中）：请先在链上拒绝该退款申请（rejectRefund）后再交付，或同意退款（approveRefund）',
    };
  }
  return { ok: true, chain };
}

/**
 * 链上售后案件读数（默认实现 = Escrow 的两个只读视图 + 一次 getOrder；抛错 = 读不到，
 * **不是**"没有案件"）。
 *
 * 为什么把 getOrder 一起读回来：改本地镜像之前必须确认"这个链上 orderId 确实是本单"
 * （买家/卖家/金额三项，防他人对同一 orderId 的诱饵单）。三次读取在同一个 tick 里发出，
 * ethers v6 会把它们打包成一次 JSON-RPC 请求。
 *
 * `openedAtBlock` 在无案件时链上返回 0 → 归一成 null（0 不是区块号，落库会变成假事实）。
 * **读数自相矛盾时抛错**（`open=true` 而 `openedAtBlock` 不是合法区块号）：那说明 ABI 与合约
 * 不匹配，此时"有案件"这个结论本身就不可信——抛错让 /sync 与对账都跳过该单（保持本地原值）。
 *
 * @returns {Promise<{open: boolean, openedAtBlock: number|null, status: string,
 *                    buyer: string, seller: string, amount: string}>}
 */
export async function fetchAfterSaleFor(orderIdHex, { blockTag = 'latest' } = {}) {
  const c = getEscrow();
  const overrides = blockTag === 'latest' ? {} : { blockTag };
  const [order, open, block] = await Promise.all([
    fetchOnchainOrder(orderIdHex, { blockTag }),
    c.afterSaleOpen(orderIdHex, overrides),
    c.afterSaleOpenedAtBlock(orderIdHex, overrides),
  ]);
  const n = Number(block);
  const openedAtBlock = Number.isSafeInteger(n) && n > 0 ? n : null;
  if (open && openedAtBlock === null) {
    throw new Error(
      '链上售后案件读数自相矛盾：afterSaleOpen=true 而 afterSaleOpenedAtBlock 不是合法区块号（ABI 与合约不匹配？）'
    );
  }
  return {
    open: !!open,
    openedAtBlock,
    // 链上订单终局状态（'None' = 链上查不到该单 ⇒ 调用方必须跳过，不能据"没有案件"改本地）
    status: order.status,
    buyer: order.buyer,
    seller: order.seller,
    amount: order.amount,
  };
}

let _fetchAfterSale = (orderIdHex, opts) => fetchAfterSaleFor(orderIdHex, opts);

/** 测试注入售后案件读取器（传 null 恢复默认）——与 setChainOrderFetcher 同款 */
export function setAfterSaleCaseFetcher(fn) {
  _fetchAfterSale = fn || ((orderIdHex, opts) => fetchAfterSaleFor(orderIdHex, opts));
}

/** 读取链上售后案件真值（形状见 fetchAfterSaleFor）；抛错 = 读不到 */
export function fetchAfterSaleCase(orderIdHex, opts) {
  return _fetchAfterSale(orderIdHex, opts);
}
