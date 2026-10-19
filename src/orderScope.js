/**
 * **订单归属的唯一判据**（多租户节点）：这一单属于**这次请求作用于的那家店**吗。
 *
 * ## 为什么必须是一个共用的判据
 *
 * 一个节点上有多家店，而订单行里的 `shop_code` 是**唯一**能把订单与店绑起来的东西
 * （`seller` 只是链上收款地址，`req.shop` 只是"这次请求被解析到哪家店"）。卖家面的每一个
 * 订单动作（发货、批量发货、NFT 交付、退货、擦 PII、导出）都必须先回答这一问，
 * 而"在每个 handler 里各写一次比较"的形态必然漏——漏掉的那一处，凭据属于 A 店的店主
 * 可以对 B 店的订单动手，且**所有写操作都成功、没有任何报错**（实测：`/:id/ship` 只校验
 * 请求头那家店的角色，不看订单归谁 ⇒ A 店店主能给 B 店的托管单发货，数字商品连**兑换码原文**
 * 一起回在响应里；`erase-pii` 同款，且不可逆）。
 *
 * 所以判据只此一处，**调用点是"取订单"这个动作本身**（`findOrderInShop`），而不是
 * "取到之后再判一次"——后者只要有人忘了判就漏，前者忘不了。
 *
 * ⚠️ 它**只服务卖家面**：买家动作的店铺上下文就是订单自己（handler 直接读 `order.shop_code`
 * 去问 `isStaff`），所以买家不需要、也没有任何理由带 `X-Mk-Shop`（见 http.js 的中间件说明）。
 *
 * ## 判据为什么是 `shop_code` 相等
 *
 * `orders.shop_code` 与 `shops.code` 同批写入（下单时取商品行 `shop_code` 指向的那家店的
 * `code`，见 routes/orders.js），是本地键的一一对应，且两边**恒非空**（一行店铺只在链上登记
 * 之后才存在，编号由链上铸造；新 schema 里这条归属还有外键兜着：`orders.shop_code → shops(code)`，
 * 没有真实父行的订单插不进来）。
 * 不用 `seller` 比较：`seller` 是链上订单参数，而 `shop_code` 是本地索引、不依赖链上读数的到达时机。
 *
 * ## 查找键是**对外单号** `order_no`（不是内部键）
 *
 * URL / 通知里流通的是 `orders.order_no`（CHAR(21)）；内部键是 `orders.id`（BIGINT），
 * 读模型 `v_orders` 里叫 `order_id`。路由传进来的一律是前者，所以这里 `WHERE order_no = ?`——
 * 全仓只有这一处负责"把 URL 里的单号换成订单行"，写错键的形状会当场查不到（而不是命中另一单）。
 */
import { getDb } from './db.js';

/** 该订单是否属于这家店（`shopCode` 取 `req.shop.code`，卖家面恒非空） */
export function orderBelongsToShop(order, shopCode) {
  const want = String(shopCode ?? '');
  return !!want && String(order?.shop_code ?? '') === want;
}

/**
 * 按**对外单号**取订单，**并且要求它属于这家店**（取不到 / 不属于 ⇒ `null`）。
 *
 * 返回 `null` 的两种情形刻意不区分：对调用者来说"没有这一单"与"这一单不是你的"
 * 应当是同一个回答——把后者说成"这不是你的单"等于确认了该单号存在（可枚举）。
 *
 * 整单读一律走读模型 `v_orders`（orders + order_shipping + order_chain 三表合一）：
 * 调用方拿到的行里，**内部键是 `order_id`、对外标识是 `order_no`**，PII 在 `shipping_*` 名下，
 * 链上镜像在 `escrow_order_id` / `refund_*` / `after_sale_*` 名下。**这一行没有 `id`**——
 * 旧写法 `order.id` 拿到 undefined，会在绑定参数或写入处立刻抛错，而不是静默写错一张表。
 *
 * @param {string} orderNo 对外订单号（`orders.order_no`，CHAR(21)）
 * @param {string} shopCode 这次请求作用于的店铺编号（`req.shop.code`）
 * @returns {Promise<object|null>}
 */
export async function findOrderInShop(orderNo, shopCode) {
  const row = await getDb().get('SELECT * FROM v_orders WHERE order_no = ?', String(orderNo ?? ''));
  return row && orderBelongsToShop(row, shopCode) ? row : null;
}
