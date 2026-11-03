/**
 * 售后案件状态的 **SQL 谓词**（纯字符串模块，只依赖列名）。
 *
 * 为什么单独成文件：`afterSale.js` 持有开/关案的写入口，必须 import `db.js`；而卖家筛选
 * （`sellerOrderFilters.js`）只需要这两个谓词，不该为了一个字符串把数据库层拉进纯函数测试。
 * 把谓词放在这里之后，"纯筛选逻辑"与"库层"在依赖图上分开，`db-isolation` 才能继续回答
 * "这个测试文件在库名设好之前有没有碰到 db"。
 *
 * 两个方向都给：`AFTER_SALE_OPEN_SQL`（在途，用于队列/徽标/门控）
 * 与 `AFTER_SALE_NOT_OPEN_SQL`（无在途，用于"漏扫开案"扫描与保留期让路的候选面）。
 * 别名：这两个谓词**不带表别名**，直接拼在 `v_orders` 或 `orders` 的单表查询上；
 * 需要 JOIN 别名的调用方自己写 `o.after_sale_status`。
 */
export const AFTER_SALE_OPEN_SQL = "after_sale_status = 'open'";
export const AFTER_SALE_NOT_OPEN_SQL = "(after_sale_status IS NULL OR after_sale_status <> 'open')";
