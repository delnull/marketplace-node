/**
 * 池式商品（数字码池 / NFT tokenId 池）的**占位计数**——加量半边（唯一实现）。
 *
 * 口径（与旧的派生算式**逐字等价**）：
 *   `products.reserved_codes` = Σ 该商品「在途订单（draft/escrowed/shipped/disputed）
 *                               尚未交付的件数」
 *   可用量 = 池内 unused 数 − reserved_codes
 * 旧实现是下单时现算一遍 `COUNT(unused) − SUM(quantity − 已交付行数)`——那是"先读计数再落单"，
 * 靠全局写锁才成立（实测：删锁之前它是对的，删锁之后 N 个并发草稿对 1 个码可以全部通过）。
 * 现在是**计数器 + 带守卫的 UPDATE**：越界在那条语句自己身上失败（命中 0 行）。
 *
 * 实测（真 MySQL，独立临时库）：池里 10 个未用码、30 个并发占位 → 恰好 10 个成功；
 * 之后消耗 5 个码（unused=5、reserved=10）再占位 → `changes = 0`（拒）。
 *
 * ## 减量在**库侧的触发器**里，不在本文件（见 db.js 的 TRIGGER_DDL）
 *
 * ⚠️ 减量与"恢复时的加量"都没有调用点，全部由触发器完成：
 *   · `order_delivery_items` 插入一行 ⇒ 该商品池 −1（交付了一件，这一件不再需要留着）；
 *   · `orders.status` 离开「draft/escrowed/shipped/disputed」⇒ 减去**剩余未交付**件数；
 *   · `orders.status` 从「已结清」回到 `escrowed`（唯一形状是 cancelled → escrowed）⇒ 把剩余需求占回来。
 * **不要在任何交付/终局/恢复路径上补这些增减**（那会算两遍）。
 * 为什么挂触发器：交付与状态迁移各有三到七八个写者（池自动分配 / 手动填码 / 自由文本 / NFT 登记；
 * 路由、watcher、对账、清扫器），而"少减一次"的后果是占位永久虚高——那件商品再也卖不出去，
 * 且没有任何错误码；"恢复时忘了占回来"则相反（超卖）。
 * 恢复那一处尤其不能留在应用：三条恢复路径（watcher / `/sync` / 链上对账）调用占位恢复的
 * 时机各不相同，应用层拿不到与顺序无关的"只做一次"凭据，而**那条状态迁移本身就是凭据**。
 *
 * ## 为什么池未建（池里一个资源都没有）时**不拦**
 *
 * 守卫里带一个 `NOT EXISTS(池里有行)` 的豁免项：`reserved + qty <= unused` 这个形状在
 * "池还没建"时恒假（unused = 0），会把**每一张**草稿都拒掉——而"卖家手动交付/自由文本"
 * 这种形态（池根本没建）是既有语义里明确允许的（旧实现写的就是"池未建（built=0）时不拦"）。
 * 豁免项只影响"拦不拦"，**不影响记账**：占位照加（reserved 可能大于 unused ⇒ 可用量为 0），
 * 所以卖家之后导入码池时，这些在途需求仍然算数（与旧派生算式同口径）。
 * 代价如实写：`reserved` 允许大于 `unused`（池没建/被掏空时），读它的人必须按"可用量 = max(0, 差)"
 * 去读，而不是把 reserved 当成"池里已锁定多少"。
 *
 * ## 加量为什么留在应用（不对称是刻意的）
 *
 * 业务拒绝要变成应用读得懂的**可读结果**（"兑换码不足（未被在途订单占用的仅剩 N 个）"），
 * 而不是一个需要翻译的 SQL 错误码——见 db.js 的 TRIGGER_DDL 头部。
 */
import { getDb } from './db.js';

/** 商品类型 → 池（表名 / 计数器列 / 交付行的 kind）。**唯一拼法**，别处不得再写一份 */
const POOLS = {
  digital: { table: 'product_codes', column: 'reserved_codes', itemKind: 'code' },
  nft: { table: 'product_nft_tokens', column: 'reserved_tokens', itemKind: 'nft' },
};

/**
 * 类型 → 池的解析（**唯一判据**；拼错的类型必须响亮地失败）：实物商品（没有池）返回 null
 * 表示"无需占位"，而任何别的值都是**编程错误**——静默放行等于让这道闸因为一个拼错的类型
 * 永远失效（商品池照旧超卖，而且没有任何错误码）。
 */
function poolFor(kind) {
  const k = String(kind ?? '');
  if (k === 'physical') return null; // 实物商品没有池：没有可占的额度
  const pool = POOLS[k];
  if (!pool) {
    throw new Error(
      `poolQuota：未知商品类型 ${JSON.stringify(kind)}（只能是 digital / nft / physical）——` +
        '闸不能因为一个拼错的类型静默失效'
    );
  }
  return pool;
}

/**
 * 占位 units 件（下单事务内调用）。
 *
 * @param {number} productId 商品内部键
 * @param {string} kind `products.kind`（digital / nft；实物传别的值 ⇒ 直接放行）
 * @param {number} units 件数（= 这一单的 quantity；池式商品的 hold_qty 恒 0，占位记在计数器上）
 * @returns {Promise<boolean>} true = 占到位；false = 池内未被占用的余量不够
 *
 * ⚠️ 必须与"插单"在**同一个事务**里：占位成功而订单没落库 = 池额度被一张不存在的单占死；
 * 反过来则会超卖（付款后无码可发）。
 */
export async function reservePoolUnits(productId, kind, units) {
  const pool = poolFor(kind);
  if (!pool) return true; // 实物商品没有池：没有可占的额度
  const qty = Number(units);
  const { changes } = await getDb().run(
    `UPDATE products AS p SET p.${pool.column} = p.${pool.column} + ?
      WHERE p.id = ?
        AND (NOT EXISTS (SELECT 1 FROM ${pool.table} c WHERE c.product_id = p.id)
             OR p.${pool.column} + ? <= (SELECT COUNT(*) FROM ${pool.table} c
                                       WHERE c.product_id = p.id AND c.status = 'unused'))`,
    qty,
    productId,
    qty
  );
  return changes === 1;
}

/**
 * 池的可用量读数（**只用于给人看的拒因/展示**，不是判据——判据永远是那条守卫 UPDATE 的 `changes`）。
 *
 * `available = max(0, unused − reserved)`：reserved 允许大于 unused（池未建或被掏空，见文件头），
 * 所以这里必须夹零，否则界面会显示一个负数余量。
 */
export async function poolAvailability(productId, kind) {
  const pool = poolFor(kind);
  if (!pool) return null;
  const row = await getDb().get(
    `SELECT (SELECT COUNT(*) FROM ${pool.table} c WHERE c.product_id = pr.id AND c.status = 'unused') AS unused,
            pr.${pool.column} AS reserved
       FROM products pr WHERE pr.id = ?`,
    productId
  );
  const unused = Number(row?.unused ?? 0);
  const reserved = Number(row?.reserved ?? 0);
  return { unused, reserved, available: Math.max(0, unused - reserved) };
}
