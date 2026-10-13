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

