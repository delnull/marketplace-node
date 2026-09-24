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
 */
import { fetchOnchainOrder } from './chain.js';

let _fetchOrder = (orderIdHex) => fetchOnchainOrder(orderIdHex);

/** 测试注入链上订单读取器（传 null 恢复默认） */
export function setChainOrderFetcher(fn) {
  _fetchOrder = fn || ((orderIdHex) => fetchOnchainOrder(orderIdHex));
}

/** 读取链上订单真值（形状见 chain.fetchOnchainOrder）；抛错 = 读不到，**不是**"链上没有" */
export function fetchOrderFor(orderIdHex) {
  return _fetchOrder(orderIdHex);
}
