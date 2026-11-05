/**
 * 金额展示口径（**标价币种微单位 → 十进制串**）——节点侧的唯一实现。
 *
 * 为什么单独成文件（源码审计 2026-09）：`(micro / 1e6).toFixed(2)` 这段换算原先在
 * `routes/orders.js`、`routes/arbitration.js`、`routes/products.js` 里各抄了几遍，
 * 而"商品金额 = 应付总额 − 运费"这条兜底规则也各写了一遍。三份实现当前数值一致，
 * 但只要有人改一处（比如给金额加上千分位、或把兜底改成不夹 0），另外两处就会静默漂移——
 * 而漂移的表现是"同一个数在两个接口里不一样"，最难被发现的一类账目问题。
 *
 * 单位口径（2026-10 由 CNY 分改为微 USDT；2026-11 增加 BTY 计价）：
 * 商品/订单都带一个标价币种（`USDT` 或 `BTY`），金额一律存**该币种的微单位**：
 *   1 USDT = 1e6 微 USDT；1 BTY = 1e6 微 BTY（= 1e12 wei）。
 * 所以两种币种的微单位都是 6 位小数，格式化只有一条代码路径；单位由币种决定。
 * 支付资产金额（原生 BTY wei / ERC20 最小单位）不在这里格式化——见 `weiToDecimal`。
 *
 * 前端有同口径的 `frontend/src/utils/amountSplit.ts`（那边还要处理 wei/退款折算）。
 * 两边的展示规则必须逐字一致：整数拆位、最多 6 位小数、**去掉全部尾零**、负数带号、非有限值按 0。
 */

/** 标价币种 → 展示单位（同时是产品/订单快照里的单位）；缺失/非法直接抛错，不猜 USDT */
export function priceUnitOf(currency) {
  if (currency !== 'USDT' && currency !== 'BTY') {
    throw new Error(`缺少合法的计价币种（收到 ${JSON.stringify(currency)}；只能是 USDT 或 BTY）`);
  }
  return currency;
}

/**
 * 标价币种微单位 → 十进制展示串（**最多 6 位小数、去净尾零**、不带单位）：
 * `25000000 → '25'`、`12500000 → '12.5'`、`100000 → '0.1'`、`1 → '0.000001'`、`0 → '0'`。
 *
 * 为什么**不**补足两位小数（2026-10 定稿）：链上资产不是法币，`25.00` 这种补零只是法币习惯，
 * 而商城里的价格本就可能是 `0.000001 USDT`——统一"去净尾零"后，
 * `25` / `12.5` / `0.1` / `0.000001` 才是同一套规则的自然结果，也不会让 `0.10` 看起来比 `0.1` "更精确"。
 * 代价（明确记录）：`25` 少了"这是金额"的视觉暗示，所以**单位必须始终跟在数字后面**（`25 USDT`），
 * 任何只印数字不印单位的金额位都是缺陷。
 */
export function priceOf(micro) {
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
 * 商品金额（标价币种微单位）= 应付总额 − 运费（夹到 ≥ 0）。
 * 运费按单收取一次、只对实物商品计；数字 / NFT / ERC20 单的 shipping_fee_micro 恒 0，
 * 此时它就等于总额。
 *
 * **这里保持"永远返回 number"**（不引入 `null`）：两个入参在节点侧都是**自己库里的
 * `BIGINT UNSIGNED` 列**（`orders.price_micro` / `shipping_fee_micro`，标价币种微单位；
 * 不是 wei 那种 38 位 `DECIMAL`，所以驱动给的是 number），畸形值到不了这里——为一条不可达
 * 的路径把返回值改成 `number | null`，会让这个 DTO 字段的形状在**链路上**多出一态，而下游
 * （前端 `types.ts` 与各渲染点）得跟着改一遍。trust boundary 在**消费端**：畸形载荷由
 * `utils/orderVault` 的 `toFiniteNumber` 判成"读不到"（不写这个键），不在这里造一个假数字。
 * 因此这里只做有限的形状防御（数组/对象等非数值 → 夹成 0，与从前逐字节一致），
 * 不承担"读不到"的语义。
 */
export function goodsPriceMicroOf(priceMicro, shippingFeeMicro = 0) {
  const total = Number.isFinite(Number(priceMicro)) ? Math.trunc(Number(priceMicro)) : 0;
  const ship = Number.isFinite(Number(shippingFeeMicro)) ? Math.trunc(Number(shippingFeeMicro)) : 0;
  return Math.max(0, total - ship);
}
