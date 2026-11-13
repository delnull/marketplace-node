/**
 * 公开销量/单量的唯一判据：**已支付**才算。
 *
 * 排除：
 *  · 全额退款（refunded）——钱已退回买家，不是成交；
 *  · cancelled——未成交的取消行（正常取消路径没有支付凭证，这里是防御异常行）；
 *  · 自买（buyer = seller）——同一个人左右手互买不构成销量。
 *
 * 保留：escrowed / shipped / disputed / confirmed / settled / expired 等已付款订单；
 * 部分退款（settled + refunded_amount_wei > 0）仍算一笔已支付订单/件数。
 *
 * 只用在**公开销量/单量**；店主看板的成交/净额仍走 `INCOME_STATUS`。
 */
export const PAID_SALES_WHERE =
  "TRIM(COALESCE(o.paid_tx_hash, '')) <> '' AND o.status NOT IN ('refunded', 'cancelled') AND o.buyer <> o.seller";

/**
 * 同一判据的行级版本（画像/单量共用；SQL 与 JS 两处必须逐条同义）。
 */
export function isEffectivePaidOrder(row) {
  if (!String(row?.paid_tx_hash || '').trim()) return false;
  const status = String(row?.status || '');
  if (status === 'refunded' || status === 'cancelled') return false;
  return String(row?.buyer || '').toLowerCase() !== String(row?.seller || '').toLowerCase();
}
