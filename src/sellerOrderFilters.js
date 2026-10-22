/**
 * 卖家订单列表与 CSV 导出共用的筛选谓词。
 *
 * 为什么必须是同一份：列表支持 status/refund/afterSale/q，导出只认 status/from/to，
 * 于是页面按“退款待处理”筛出 3 单、点导出却拿到全店订单，提示还写“按当前筛选条件”。
 * 这里把列表的筛选语义收成唯一实现，导出只允许再追加时间区间（它本来就有）。
 *
 * ⚠️ **本函数不包含店铺作用域**：它只回答“筛选条件”，不回答“能看哪一家店”。
 * 店铺维度是**安全边界**，必须由每条查询在 SQL 文本里字面写出 `shop_code = ?`
 * （列表与导出两处都如此）。把 `shop_code = ?` 藏进返回值里，静态守卫与读代码的人都
 * 看不出这条边界还在不在；而“边界不可见”正是跨店导出 PII 那类事故的起点。
 */
import { ORDER_STATUS, ACTIVE_IN } from './orderStatus.js';
import { AFTER_SALE_OPEN_SQL } from './afterSaleSql.js';

/**
 * @param {Record<string, unknown>} query  Express 的 req.query
 * @returns {{ where: string, params: unknown[] } | { error: string }} `where` 只含筛选条件
 *          （无条件时为 `1=1`）；**调用方必须自己拼 `shop_code = ?` 并把店铺编号放在
 *          `params` 第一位**（参数顺序与 SQL 中 `?` 的出现顺序一致）。
 */
export function sellerOrderFilters(query) {
  let where = '1=1';
  const params = [];

  if (query.status) {
    const st = String(query.status);
    if (!ORDER_STATUS.includes(st)) return { error: `status 无效（可选：${ORDER_STATUS.join('/')}）` };
    where += ' AND status = ?';
    params.push(st);
  }

  if (query.refund) {
    const r = String(query.refund);
    if (!['requested', 'rejected'].includes(r)) return { error: 'refund 需为 requested / rejected' };
    where += ' AND refund_status = ?';
    params.push(r);
    /*
      「退款待处理」必须与 status-counts 的 pendingRefund 同一个谓词：
      只按 refund_status 会把已经退完款、状态仍是 refunded 的单算进待办。
    */
    if (r === 'requested') where += ` AND status IN ${ACTIVE_IN}`;
  }

  if (query.afterSale) {
    const a = String(query.afterSale);
    if (!['open', 'closed'].includes(a)) return { error: 'afterSale 需为 open / closed' };
    where += a === 'open' ? ` AND ${AFTER_SALE_OPEN_SQL}` : " AND after_sale_status = 'closed'";
  }

  if (query.q) {
    const q = String(query.q).trim().toLowerCase();
    if (!q) return { error: 'q 不能为空' };
    if (q.length > 200) return { error: 'q 过长（≤200 字符）' };
    /*
      把检索词当字面量：转义 LIKE 通配符，避免 %/_ 把检索变成宽泛命中。
      COLLATE 是必须的：库/表大小写敏感，而单号与商品标识是大小写混排的 Crockford 串。
    */
    const esc = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
    const like = `%${esc(q)}%`;
    where +=
      " AND (buyer = ? OR order_no COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\'" +
      " OR product_slug COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\'" +
      " OR product_snapshot COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\')";
    params.push(q, like, like, like);
  }

  return { where, params };
}
