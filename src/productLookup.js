/**
 * 商品标识（`products.slug`）**单件读行**的唯一入口。
 *
 * 为什么需要它：slug 会被复制进 URL / 聊天 / 工单，而库里存的是大写 Crockford。
 * 按 slug 取整行的地方必须过归一化；批量/投影查询（`reviews.js`、`export.js`、批量改价等
 * 只取 id 或带额外谓词的语句）仍写在各自文件里，但**新增"按 slug 取行"的读入口必须走这里**。
 *
 * 归一化只有 `ids.normalizeId` 一处（trim + 大写 + `I/L→1`、`O→0`）；`sellableOnly` 复用
 * `shops.productSellableSql` 的同一份判据（下单入口要的"能卖"与列表页完全同源）。
 */
import { getDb } from './db.js';
import { normalizeId } from './ids.js';
import { productSellableSql } from './shops.js';

/**
 * @param {unknown} slug 任意来源的商品标识（URL 段 / 请求体）
 * @param {{ sellableOnly?: boolean }} [opts]
 * @returns {Promise<object|undefined>} 商品行；标识为空/不存在时 undefined
 */
export async function productRowBySlug(slug, { sellableOnly = false } = {}) {
  const key = normalizeId(slug);
  if (!key) return undefined;
  const sql = sellableOnly
    ? `SELECT * FROM products WHERE slug = ? AND ${productSellableSql()}`
    : 'SELECT * FROM products WHERE slug = ?';
  return await getDb().get(sql, key);
}
