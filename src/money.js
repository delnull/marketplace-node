/**
 * 金额展示口径（**CNY 分 → 元**）——节点侧的唯一实现。
 *
 * 为什么单独成文件（源码审计 2026-09）：`(fen / 100).toFixed(2)` 这段换算原先在
 * `routes/orders.js`、`routes/arbitration.js`、`routes/products.js` 里各抄了几遍，
 * 而"商品金额 = 应付总额 − 运费"这条兜底规则也各写了一遍。三份实现当前数值一致，
 * 但只要有人改一处（比如给金额加上千分位、或把兜底改成不夹 0），另外两处就会静默漂移——
 * 而漂移的表现是"同一个数在两个接口里不一样"，最难被发现的一类账目问题。
 *
 * 前端有同口径的 `frontend/src/utils/amountSplit.ts`（那边还要处理 wei/退款折算）。
 * 两边的**元展示规则必须逐字一致**：整数拆位、两位小数、负数带号、非有限值按 0。
 */

/** 分 → 元的展示串（两位小数、不带 ¥）：`1250 → '12.50'`、`5 → '0.05'`、`2500 → '25.00'` */
export function yuanOf(fen) {
  const n = Number(fen);
  const f = Number.isFinite(n) ? Math.trunc(n) : 0;
  const abs = Math.abs(f);
  return `${f < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * 商品金额（CNY 分）= 应付总额 − 运费（夹到 ≥ 0）。
 * 运费按单收取一次、只对实物商品计；数字/NFT 单的 `shipping_fee_cny_fen` 恒 0，
 * 此时它就等于总额（旧语义），所以这个兜底对老数据同样成立。
 */
export function goodsFenOf(cnyFen, shippingFeeCnyFen = 0) {
  const total = Number.isFinite(Number(cnyFen)) ? Math.trunc(Number(cnyFen)) : 0;
  const ship = Number.isFinite(Number(shippingFeeCnyFen)) ? Math.trunc(Number(shippingFeeCnyFen)) : 0;
  return Math.max(0, total - ship);
}
