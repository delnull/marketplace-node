/**
 * 金额展示口径（**微 USDT → USDT**）——节点侧的唯一实现。
 *
 * 为什么单独成文件（源码审计 2026-09）：`(micro / 1e6).toFixed(2)` 这段换算原先在
 * `routes/orders.js`、`routes/arbitration.js`、`routes/products.js` 里各抄了几遍，
 * 而"商品金额 = 应付总额 − 运费"这条兜底规则也各写了一遍。三份实现当前数值一致，
 * 但只要有人改一处（比如给金额加上千分位、或把兜底改成不夹 0），另外两处就会静默漂移——
 * 而漂移的表现是"同一个数在两个接口里不一样"，最难被发现的一类账目问题。
 *
 * 前端有同口径的 `frontend/src/utils/amountSplit.ts`（那边还要处理 wei/退款折算）。
 * 两边的 **USDT 展示规则必须逐字一致**：整数拆位、最多 6 位小数、**去掉全部尾零**、负数带号、非有限值按 0。
 *
 * 单位口径（2026-10 由 CNY 分改为微 USDT）：标价单位为 **USDT**，库里一律存
 * **微 USDT**（1 USDT = 1e6 微 USDT，与链上 USDT 的 6 位小数同口径），因此有了
 * "分"之下的精度（0.000001 USDT）。2 位小数的老单位（CNY 分）已全部改掉。
 */

/**
 * 微 USDT → USDT 展示串（**最多 6 位小数、去净尾零**）：
 * `25000000 → '25'`、`12500000 → '12.5'`、`100000 → '0.1'`、`1 → '0.000001'`、`0 → '0'`。
 *
 * 为什么**不**补足两位小数（2026-10 定稿）：USDT 是加密资产，`25.00` 这种补零只是法币习惯，
 * 而商城里的价格本就可能是 `0.000001 USDT`——统一"去净尾零"后，
 * `25` / `12.5` / `0.1` / `0.000001` 才是同一套规则的自然结果，也不会让 `0.10` 看起来比 `0.1` "更精确"。
 * 代价（明确记录）：`25` 少了"这是金额"的视觉暗示，所以**单位必须始终跟在数字后面**（`25 USDT`），
 * 任何只印数字不印单位的金额位都是缺陷。
 */
export function usdtOf(micro) {
  const n = Number(micro);
  const v = Number.isFinite(n) ? Math.trunc(n) : 0;
  const abs = Math.abs(v);
  const int = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${v < 0 ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/**
 * 商品金额（微 USDT）= 应付总额 − 运费（夹到 ≥ 0）。
 * 运费按单收取一次、只对实物商品计；数字/NFT 单的 `shipping_fee_usdt_micro` 恒 0，
 * 此时它就等于总额（旧语义），所以这个兜底对老数据同样成立。
 *
 * **这里保持"永远返回 number"**（不引入 `null`）：两个入参在节点侧都是**自己库里的
 * SQLite INTEGER 列**，畸形值到不了这里——为一条不可达的路径把返回值改成 `number | null`，
 * 会让这个 DTO 字段的形状在**链路上**多出一态，而下游（前端 `types.ts` 与各渲染点）
 * 得跟着改一遍。trust boundary 在**消费端**：畸形载荷由 `utils/orderVault` 的
 * `toFiniteNumber` 判成"读不到"（不写这个键），不在这里造一个假数字。
 * 因此这里只做有限的形状防御（数组/对象等非数值 → 夹成 0，与从前逐字节一致），
 * 不承担"读不到"的语义。
 */
export function goodsMicroOf(usdtMicro, shippingFeeUsdtMicro = 0) {
  const total = Number.isFinite(Number(usdtMicro)) ? Math.trunc(Number(usdtMicro)) : 0;
  const ship = Number.isFinite(Number(shippingFeeUsdtMicro)) ? Math.trunc(Number(shippingFeeUsdtMicro)) : 0;
  return Math.max(0, total - ship);
}
