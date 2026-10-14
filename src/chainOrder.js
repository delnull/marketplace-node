/**
 * 链上订单读取的**可注入包装**（唯一一份）。
 *
 * 为什么单独一个模块：`fetchOnchainOrder`（chain.js）直接打 RPC，单测里只能起假 JSON-RPC 服务器
 * 才能伪造返回值（见 `test/order-sync-paths.test.js` 的做法）。而"链上当前真值"是好几处判断的
 * 依据——对账（chainReconcile）与码池补货后的自动交付补跑（autoDeliver）都要按它决定**要不要动钱/
 * 发货**。两边各自留一个注入钩子就会出现"同一个东西两套实现"，所以钩子只在这里留一个：
 *   · 生产：默认直接调 chain.js 的 `fetchOnchainOrder`；
 *   · 测试：`setChainOrderFetcher(fn)` 注入假读数（传 null 恢复默认）。
 *
 * chainReconcile.js 仍然**再导出** `setChainOrderFetcher`（既有测试按那个路径导入），行为不变。
 *
 * 售后案件（确认收货后的 second-layer 案件）同理走本模块的 `fetchAfterSaleFor`：它是
 * `POST /api/orders/:id/sync`（人工兜底）与 `chainReconcile`（后台兜底）**共用**的链上读数，
 * 两处各写一遍"读 afterSaleOpen + afterSaleOpenedAtBlock"就是本仓明令禁止的两套实现；
 * 而"读到的真值怎么落列"由 src/afterSale.js 的 `applyAfterSaleFromChain` 唯一决定。
 *
 * 同理，凡是**按链上真值决定要不要把货交出去**的地方，判据只有本模块的 `deliveryGate` 一处
 * （三个手动交付入口 + 自动交付），"这个链上单号是不是我这一单"只有 `chainParamsMatch` 一处
 * （交付闸、watcher 事件分支、后台对账共用）——判据落在调用点上就是两个答案层的开始。
 */
import { fetchOnchainOrder, getEscrow } from './chain.js';

let _fetchOrder = (orderIdHex) => fetchOnchainOrder(orderIdHex);

/** 测试注入链上订单读取器（传 null 恢复默认） */
export function setChainOrderFetcher(fn) {
  _fetchOrder = fn || ((orderIdHex) => fetchOnchainOrder(orderIdHex));
}

/** 读取链上订单真值（形状见 chain.fetchOnchainOrder）；抛错 = 读不到，**不是**"链上没有" */
export function fetchOrderFor(orderIdHex) {
  return _fetchOrder(orderIdHex);
}

/**
 * 链上真值与本地订单锁定参数逐项比对（买家/卖家/金额三者皆不可变）。
 * 缺字段（单测直调/兼容旧调用）时返回 true（跳过比对）。
 *
 * 为什么住在这里而不是各调用点：`orderId` 自草稿起公开（匿名 `GET /api/orders?address=` 就能读到
 * 未付款草稿的托管单号），任何**按链上读数动钱或发货**的地方都必须先回答"这个链上单号确实是我这单吗"，
 * 否则一个 1 wei 的诱饵单就能驱动本地状态（库存占位释放、自动发码、事件史造假）。
 * 判据只有这一份：交付闸（`deliveryGate`）、watcher 的事件分支、后台对账（chainReconcile）共用它。
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
  return buyerOk && sellerOk && amountOk;
}

/**
 * **交付闸**（发货/发码/NFT 登记的唯一判据层）：现在能不能把货交出去。
 *
 * ── 为什么不能用本地 `orders.refund_status`（本模块存在的理由）────────────────
 * 那一列是 watcher 以 `head − MK_ESCROW_FINALITY_BLOCKS`（默认 12 块 ≈ 1 分钟）为上界回写的**镜像**，
 * 所以买家在 `createOrder` 之后紧接着 `requestRefund` 的那 12 块里，镜像**必然**还是 `none`。
 * 判据落在镜像上，就等于给了"钱已冻结、货照发"一个结构性窗口：买家手里有货/码，
 * 而托管里的钱被 `refundRequested` 永久挡住超时释放（卖家只能拒绝 → 争议 → 仲裁，双损）。
 * 本仓已经为**自动**交付认定过这条是 P1 并改读链上真值（见 autoDeliver 的说明），
 * 但手动交付的三个入口（`POST /:id/ship`、`POST /seller/batch-ship`、`POST /:id/nft-deliveries`）
 * 当时仍在看镜像——同一个"该不该交付"的问题于是有两个答案层，而两个答案在这 12 块里必然相反。
 * 现在四个入口（含自动交付）全部经本函数，判据只剩一处。
 *
 * ── 判据与方向 ────────────────────────────────────────────────────────────
 *   · 链上 `status` 必须是 `Created`（钱还在托管里；`Disputed`/`Settled`/`Refunded` 都不该发货）；
 *   · 链上 `refundRequested` 必须为假（真值只在链上；卖家拒绝后它为假 ⇒ 恢复可交付，见
 *     test/auto-deliver.test.js 的"拒绝后恢复"用例）；
 *   · 链上读不到 ⇒ **拒绝**（fail-closed）。代价如实写明：节点 RPC 故障期间卖家发不了货，
 *     而"读不到就放行"恰恰会把上面那个窗口原样还回来（买家的钱包走的是它自己的 RPC，
 *     链可以在本节点读不到的时候继续前进）。这正是 autoDeliver 早已采取的同一方向。
 *   · 链上同单号的买家/卖家/金额与本单不符 ⇒ 拒绝（诱饵单，见 chainParamsMatch）。
 *
 * ── 残余窗口（如实写明）────────────────────────────────────────────────────
 * 判据是**读的那一刻**的链上真值，从读数到本地落库之间仍有**一次 RPC 往返**的窗口——
 * 比原先的"一个 finality 深度"小三个数量级，但不可能为零（链上随时可以再变）。
 * 这一点与"任何链上读数都有时效"同源，不额外加锁或补偿。
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
      message: '链上同单号的托管单与本单的买家/卖家/金额不一致（疑似他人对同一单号的诱饵单）——已阻止交付，请核对该订单',
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
 * （买家/卖家/金额三项，防他人对同一 orderId 的诱饵单——与 watcher/sync/主对账同一条规矩，
 * 见 chainReconcile 的说明）。少了这一步，一个 1 wei 的假单就能驱动本地案件状态。
 * 三次读取在同一个 tick 里发出，ethers v6 会把它们打包成一次 JSON-RPC 请求（batchMaxCount 默认 100），
 * 所以这不会把 RPC 次数翻三倍。
 *
 * `openedAtBlock` 在无案件时链上返回 0 → 归一成 null（0 不是区块号，落库会变成假事实）。
 * **读数自相矛盾时抛错**（`open=true` 而 `openedAtBlock` 不是合法区块号）：那说明 ABI 与合约不匹配
 * （例如把别的函数的返回值解成了这两个视图），此时"有案件"这个结论本身就不可信——
 * 抛错让 /sync 与对账都跳过该单（保持本地原值），比照着一个解码错位的读数改库安全得多。
 *
 * @returns {Promise<{open: boolean, openedAtBlock: number|null, status: string,
 *                    buyer: string, seller: string, amount: string}>}
 */
export async function fetchAfterSaleFor(orderIdHex) {
  const c = getEscrow();
  const [order, open, block] = await Promise.all([
    fetchOnchainOrder(orderIdHex),
    c.afterSaleOpen(orderIdHex),
    c.afterSaleOpenedAtBlock(orderIdHex),
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

let _fetchAfterSale = (orderIdHex) => fetchAfterSaleFor(orderIdHex);

/** 测试注入售后案件读取器（传 null 恢复默认）——与 setChainOrderFetcher 同款 */
export function setAfterSaleCaseFetcher(fn) {
  _fetchAfterSale = fn || ((orderIdHex) => fetchAfterSaleFor(orderIdHex));
}

/** 读取链上售后案件真值（形状见 fetchAfterSaleFor）；抛错 = 读不到 */
export function fetchAfterSaleCase(orderIdHex) {
  return _fetchAfterSale(orderIdHex);
}

