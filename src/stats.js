/**
 * 卖家经营看板统计（P1-①，ownerOnly 私域）。
 *
 * 口径：
 *  - 入账（GMV）= confirmed/settled/expired 的净额（金额 − 订单级 feeBps 折算，与收款流水一致）；
 *  - 退款额 = refunded 单托管毛额合计（单独口径，不与 GMV 净混合）；
 *  - 买家/复购按 address 去重计数（成交 ≥1 / ≥2 单）；
 *  - 时间窗口按本地入账时刻（orders.updated_at 终局迁移时间）归属；days=0 表示全量；
 *    overview/products 用滚动窗（最近 days×24h），trend 用自然日窗（本地今天零点起
 *    days 个完整日，见 trendStats——D6 对齐）；days 参数缺省/非法/越界统一归一
 *    （normalizeStatsDays：缺省给默认、0=全量、>366 钳制、非整数/负值拒绝——D7）；
 *  - 趋势按天补零；全部 BigInt 精确累加——**不用 SQL 的 SUM()/AVG()**：金额列是
 *    `DECIMAL(38,0)`，聚合值同样以字符串回来（见 db.js 的 decimalNumbers 说明），
 *    在 JS 里用 BigInt 逐行加总才有唯一的取整与溢出口径。
 */
import { getDb } from './db.js';
// 入账状态集合的唯一出处（src/orderStatus.js，与 db.js 列定义里的 ENUM 逐字同源）：
// 本文件此前手抄过一份 INCOME 内联数组——那份抄写不在 test/status-set-consistency.test.js
// 的射程内，往枚举里加状态时会静默落后（看板漏掉一整档入账）。
import { INCOME_STATUS } from './orderStatus.js';
// 平台费/净额一律走 src/fees.js（**唯一实现**，三态）：判据是**每行**的创建时收取方快照
// `fee_collector_at_create`（合约只读快照，全局 feeCollector() 事后可改，不能替代它），
// 而 `fee_bps` 那一列分不开"没补录"与"就是 0" ⇒ 用 `*OfRow(base, 整行)` 拿 `bigint | null`
// （null = 费率快照未回填，此时净额是"不知道"，不是 0；见 fees.feeSnapshotReadOf）
import { feeOfRow, netOfRow } from './fees.js';
// 时间列的毫秒读数（唯一实现）：库里的 DATETIME(3) 读出来是 Date，而窗口/分桶都在毫秒域做
import { timeMs } from './reputation.js';

const INCOME = INCOME_STATUS;

const DAY_MS = 24 * 3600 * 1000;
/** 看板窗口天数上限（含默认档；0=全量单列语义，不受此限） */
export const STATS_MAX_DAYS = 366;

// 平台费/净额一律走 src/fees.js 的 feeOfRow / netOfRow（**唯一实现**、三态）——本文件不再
// 自己拼 (金额, 费率, 收取方) 三元组：那样就把"费率快照是否回填"这个判据又抄了一遍。

/**
 * 看板 days 参数归一（D7：缺省/非法/越界统一钳制——此前 overview 缺省被 ||0 吞成全量、
 * products 负 days 直接给空看板，口径分裂）：
 *  - 缺省（undefined/''）→ def（路由默认：overview/products 30、trend 14）；
 *  - 显式 0 → 全量（单列语义，返回 0）；
 *  - 非整数/负值 → null（调用方报 days 无效）；
 *  - > STATS_MAX_DAYS → 钳制到 STATS_MAX_DAYS（一年窗口封顶；真全量请用 0）。
 */
export function normalizeStatsDays(raw, def) {
  if (raw === undefined || raw === '') return Number.isInteger(def) && def > 0 ? def : 0;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n === 0) return 0;
  if (n < 0) return null;
  return Math.min(n, STATS_MAX_DAYS);
}

/**
 * 店铺维度的过滤片段（**唯一实现**）。
 *
 * 参数三态（照本仓的三态纪律，目的是让"忘了传店铺"不可表达）：
 *   · `undefined` ⇒ 抛错。**刻意不给默认值**：默认成"全部店铺"就是一次静默的跨店混算，
 *     而它的表现是"看板数字看起来正常、只是把别人家的生意算进来了"——最难查的一类；
 *   · `null` ⇒ 显式表示"该节点全部在售店铺的合计"（只有节点级读数才这么用）；
 *   · 地址字符串 ⇒ 只算那一家。
 *
 * 过滤走 `orders.seller`（= 该单所属店铺的 `shops.seller`，逐行写入）：
 * 它就是链上 `OrderCreated` 的 indexed 字段，口径可由第三方扫链复算。
 */
function shopWhere(seller, prefix = 'o.') {
  if (seller === undefined) {
    throw new Error('统计口径需要显式的 seller（null = 全部在售店铺）；漏传会静默跨店混算');
  }
  if (seller === null) return { where: '', params: [] };
  // 不带 `lower()`：地址列的大小写不敏感排序规则已经在那了（见 db.js 第 8 条），
  // 函数包住列只会让索引失效（同一取舍见 shops.js 的 shopRowBySeller）。
  return { where: ` AND ${prefix}seller = ?`, params: [String(seller).toLowerCase()] };
}

/**
 * 时间窗口过滤片段与参数（按最近 days 天；days=0 全量）。
 * 阈值是 **`Date`**（`updated_at` 是 `DATETIME(3)`）：传毫秒数会被 MySQL 当数字字面量解析成
 * 一个与真实时刻无关的时间，而且**不报错**（见 db.js 的时间口径）。
 */
function windowWhere(days, prefix = 'o.') {
  if (!days) return { where: '', params: [] };
  const from = new Date(Date.now() - days * DAY_MS);
  return { where: ` AND ${prefix}updated_at >= ?`, params: [from] };
}

/** 本地时区「今天零点」（趋势/窗口对齐基准——桶与 SQL 用同一零点，避免滚动 now 错位） */
function startOfToday(nowMs = Date.now()) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 入账单行（窗口内）；退款金额随行取（upd 2026-09：支持部分退款，退款额不再等于整单金额）；
 * 平台费按行的 fee_collector_at_create（创建时收取方快照）判定，故该列必须取出。
 *
 * 整单读走读模型 `v_orders`：入账口径要同时看订单事实（状态/金额/数量/费率快照）与链上镜像
 * （`refunded_amount_wei`），后者住在 `order_chain`。
 */
async function incomeRows(days, seller) {
  const db = getDb();
  const marks = INCOME.map(() => '?').join(',');
  const w = windowWhere(days);
  const s = shopWhere(seller);
  return await db.all(`SELECT buyer, product_id, quantity, amount_wei, fee_bps, fee_collector_at_create, commission_bps, commission_to, refunded_amount_wei, status, updated_at
              FROM v_orders o WHERE o.status IN (${marks})${w.where}${s.where}`, ...INCOME, ...w.params, ...s.params);
}

/**
 * 退款行（窗口内）：**所有**有退款的行（含拆分结算的成交单），退款额取 `refunded_amount_wei`
 * 而不是整单金额——部分退款后按整额统计会把退款额虚增（源码审计 2026-09）。
 *
 * 判据是 `<> 0`（该列 `NOT NULL DEFAULT 0`，不是"有没有这一列"）：读模型里没有链上镜像行的
 * 单会得到 NULL，而 `NULL <> 0` 是 NULL（既不真也不假）⇒ 这类行天然不进退款统计，正是想要的。
 */
async function refundedRows(days, seller) {
  const w = windowWhere(days);
  const s = shopWhere(seller);
  return await getDb().all(`SELECT amount_wei, refunded_amount_wei, updated_at FROM v_orders o
        WHERE refunded_amount_wei <> 0${w.where}${s.where}`, ...w.params, ...s.params);
}

/** 汇总卡（days=0 全量；默认 30 由路由层给；seller 见 shopWhere 的三态说明） */
export async function overviewStats(days, seller) {
  if (seller === undefined) {
    throw new Error('overviewStats 需要显式的 seller（null = 全部在售店铺）；漏传会静默跨店混算');
  }
  /*
    入账行与退款行**一次发出、一次解构**：两个取数助手都是 async，逐个 `const x = helper(...)`
    漏掉 await 时 x 是 Promise，报错落在下面那个 `for...of`（"rows is not iterable"），
    指不到漏掉的那一行；绑成一次 Promise.all 之后，漏 await 在解构这一行当场抛。
  */
  const [rows, refunds] = await Promise.all([incomeRows(days, seller), refundedRows(days, seller)]);
  let gmvNetWei = 0n;
  let refundWei = 0n;
  let units = 0;
  let confirmed = 0;
  /*
    费率快照未回填的行数（`fee_collector_at_create` 为空；判据见 fees.feeSnapshotReadOf）：
    这些行的平台费算不出来 ⇒ 净额就不是确证的总计，下面下发 null（未知）而不是一个偏小的数。
    毛额/单数/买家数不受影响（它们与费率无关，仍是确证的）。
  */
  let feeUnknownCount = 0;
  const buyers = new Set();
  const buyerOrders = new Map();
  const soldProducts = new Set();
  for (const r of rows) {
    /*
      净额 = 托管额 − 已退买家 − 平台费 − **节点抽成**（多店改造后是三条腿；与链上
      `Escrow._settle` 同一个式子与取整）。平台费按该行的创建时收取方快照判定、
      抽成按该行**成交时**的条款快照——两条腿的判据都在 `netOfRow` 里（唯一实现，三态）。
      null = 任一条腿的快照未回填：那时净额是**不知道**，绝不能按 0 折算进 GMV。
    */
    const refunded = BigInt(r.refunded_amount_wei || '0');
    const base = BigInt(r.amount_wei || '0') - refunded;
    const net = netOfRow(base > 0n ? base : 0n, r);
    if (net === null) feeUnknownCount += 1;
    else gmvNetWei += net;
    units += r.quantity || 1;
    confirmed += r.status === 'confirmed' ? 1 : 0;
    buyers.add(r.buyer);
    buyerOrders.set(r.buyer, (buyerOrders.get(r.buyer) || 0) + 1);
    soldProducts.add(r.product_id);
  }
  // 退款总额 = Σ 实际退回买家的金额（含拆分结算的成交单；不再按整单金额统计）
  for (const r of refunds) refundWei += BigInt(r.refunded_amount_wei || '0');
  const repeatBuyers = [...buyerOrders.values()].filter((n) => n >= 2).length;
  /*
    在售商品数也按店铺限定：多店之下它是"这家店上架了多少件"，不是一个节点级的数字。
    商品表的店铺维度读法是 products.shop_code，而入参是 seller（见 shopWhere 的理由：
    seller 是链上可复算的那个键）——两者之间用**子查询**换算，不在这里另立一张映射表。
  */
  const activeProducts =
    seller === null
      ? (await getDb().get('SELECT COUNT(*) AS c FROM products WHERE active = 1')).c
      : (await getDb().get('SELECT COUNT(*) AS c FROM products WHERE active = 1 AND shop_code IN (SELECT code FROM shops WHERE seller = ?)', String(seller).toLowerCase())).c;
  return {
    orders: rows.length,
    units,
    gmvNetWei: feeUnknownCount > 0 ? null : gmvNetWei.toString(),
    feeUnknownCount,
    refundOrders: refunds.length,
    refundWei: refundWei.toString(),
    buyers: buyers.size,
    repeatBuyers,
    confirmRate: rows.length > 0 ? Math.round((confirmed / rows.length) * 10000) / 10000 : null,
    soldProducts: soldProducts.size,
    activeProducts,
  };
}

/**
 * 最近 N 天趋势（按本地入账时刻分日；补零）。
 * D6 对齐：桶与 SQL 窗口同用「本地今天零点 − (days−1) 天」的自然日起点（而非
 * 滚动 now−days×24h）——旧实现窗口比桶宽一天且随运行时刻漂移：午夜前后同一笔单
 * 可能落错日/被静默丢弃（桶外行 add 无门直接忽略），第 0 桶实际只覆盖半日。
 * days<=0 时按最近 31 个自然日（兼容旧直调形态；路由层已归一为正数）。
 */
export async function trendStats(days, seller) {
  const db = getDb();
  const eff = days > 0 ? days : 31;
  const s = shopWhere(seller);
  const start = startOfToday() - (eff - 1) * DAY_MS; // 本地今天零点起往前 eff 天（含今天）
  /*
    分桶与行归属用**同一个** `dayKey`：入参是库里的 `Date`（`updated_at` 是 `DATETIME(3)`），
    桶键由同一个毫秒起点逐日推进生成——两处各写一遍日期格式化就会出现"桶里少一天"这类静默错位。
  */
  const dayKey = (t) => {
    const d = t instanceof Date ? t : new Date(Number(t));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  // 窗口 = [start, 现在]：与 eff 个自然日桶严格同界（桶 key 由同一 start 逐日 +DAY 生成，
  // 与行归属同公式，杜绝滚动窗口的日界错位/漏日）。比较阈值是 Date（见 windowWhere 的说明）。
  const marks = INCOME.map(() => '?').join(',');
  const rows = await db.all(`SELECT amount_wei, fee_bps, fee_collector_at_create, commission_bps, commission_to, refunded_amount_wei, updated_at FROM v_orders o
       WHERE o.status IN (${marks}) AND o.updated_at >= ?${s.where}`, ...INCOME, new Date(start), ...s.params);
  const refunds = await db.all(`SELECT amount_wei, refunded_amount_wei, updated_at FROM v_orders o
        WHERE o.refunded_amount_wei <> 0 AND o.updated_at >= ?${s.where}`, new Date(start), ...s.params);

  const buckets = new Map();
  for (let i = 0; i < eff; i++) {
    const key = dayKey(start + i * DAY_MS);
    buckets.set(key, { day: key, orders: 0, netWei: '0', refundWei: '0', feeUnknownCount: 0 });
  }
  const add = (key, field, v) => {
    const b = buckets.get(key);
    if (!b) return;
    if (field === 'orders') b.orders += v;
    else b[field] = (BigInt(b[field]) + v).toString();
  };
  for (const r of rows) {
    const b = buckets.get(dayKey(r.updated_at));
    if (b) {
      b.orders += 1;
      const base = BigInt(r.amount_wei || '0') - BigInt(r.refunded_amount_wei || '0');
      // 三态（同 overview）：本日有费率快照未回填的单 ⇒ 当日净额 null（未知），而不是少算一个费的数
      const net = netOfRow(base > 0n ? base : 0n, r);
      if (net === null) {
        b.feeUnknownCount += 1;
        b.netWei = null;
      } else if (b.netWei !== null) {
        b.netWei = (BigInt(b.netWei) + net).toString();
      }
    }
  }
  for (const r of refunds) add(dayKey(r.updated_at), 'refundWei', BigInt(r.refunded_amount_wei || '0'));
  return [...buckets.values()];
}

/** 商品维度排行（窗口内入账聚合；sort=gmv|orders|refund；退款列与窗口口径一致） */
export async function productStats(days, sort = 'gmv', page = 1, pageSize = 20, seller) {
  // 退款毛额与退款单数统一按窗口过滤（与 overview/trend 同口径），并同样按店铺限定
  const marks = windowWhere(days);
  const s = shopWhere(seller);
  // 入账行与退款行一次发出、一次解构（理由见 overviewStats 里那段）
  const [rows, refundRows] = await Promise.all([
    incomeRows(days, seller),
    getDb().all(`SELECT product_id, amount_wei, refunded_amount_wei, COUNT(*) OVER (PARTITION BY product_id) AS order_count
       FROM v_orders o WHERE o.refunded_amount_wei <> 0 AND o.product_id IS NOT NULL${marks.where}${s.where}`, ...marks.params, ...s.params),
  ]);
  const refundWeiByProduct = new Map();
  const refundCountByProduct = new Map();
  for (const r of refundRows) {
    refundWeiByProduct.set(r.product_id, (refundWeiByProduct.get(r.product_id) || 0n) + BigInt(r.refunded_amount_wei || '0'));
    refundCountByProduct.set(r.product_id, r.order_count);
  }
  const agg = new Map(); // product_id -> {...}
  for (const r of rows) {
    const key = r.product_id;
    if (key == null) continue;
    const a = agg.get(key) || { units: 0, orders: 0, netWei: 0n, feeUnknownCount: 0, buyers: new Set(), lastSaleAt: 0 };
    a.orders += 1;
    a.units += r.quantity || 1;
    const baseP = BigInt(r.amount_wei || '0') - BigInt(r.refunded_amount_wei || '0');
    // 三态（同 overview）：该商品有费率快照未回填的单 ⇒ 它的净额 null（未知）
    const net = netOfRow(baseP > 0n ? baseP : 0n, r);
    if (net === null) {
      a.feeUnknownCount += 1;
      a.netWei = null;
    } else if (a.netWei !== null) {
      a.netWei += net;
    }
    a.buyers.add(r.buyer);
    /*
      `lastSaleAt` 是**对外契约里的 ISO-8601 时刻**（全仓时间只有这一种表示，见 db.js 的说明）。
      内部累加仍走毫秒（`Math.max` 要好比较），只在**这个出口**折成 ISO；
      读不到（列缺失/畸形）时给 null，而不是 0 —— 0 会被前端印成 1970 年。
      为什么不留毫秒：留着它就会让同一个响应里出现两种时间表示，而"两种表示"必然
      让某一处少转一次；前端的毫秒算术在本地由 ISO 现算，代价记在调用点上。
    */
    a.lastSaleAt = Math.max(a.lastSaleAt, timeMs(r.updated_at) || 0);
    agg.set(key, a);
  }
  const db = getDb();
  const rowsOut = [];
  for (const [productId, a] of agg) {
    const p = await db.get('SELECT slug, title, active FROM products WHERE id = ?', productId);
    rowsOut.push({
      productId,
      slug: p ? p.slug : `#${productId}`,
      title: p ? p.title : '(商品已删除)',
      active: p ? !!p.active : false,
      orders: a.orders,
      units: a.units,
      netWei: a.netWei === null ? null : a.netWei.toString(),
      feeUnknownCount: a.feeUnknownCount,
      refundWei: (refundWeiByProduct.get(productId) || 0n).toString(),
      refunds: refundCountByProduct.get(productId) || 0,
      buyers: a.buyers.size,
      lastSaleAt: a.lastSaleAt ? new Date(a.lastSaleAt).toISOString() : null,
    });
  }

  // 稳定排序：相等返回 0（此前恒 -1 使等值项顺序依赖引擎、JS sort 不稳）；
  // 净额未知（费率快照未回填）的行**排在最后**——不拿"不知道"当 0 去参与比大小。
  const byNetDesc = (a, b) => {
    if (a.netWei === null || b.netWei === null) {
      if (a.netWei === null && b.netWei === null) return 0;
      return a.netWei === null ? 1 : -1;
    }
    const d = BigInt(b.netWei) - BigInt(a.netWei);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  };
  const cmp = {
    gmv: byNetDesc,
    orders: (a, b) => b.orders - a.orders,
    refund: (a, b) => {
      const d = BigInt(b.refundWei) - BigInt(a.refundWei);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    },
  }[sort] || byNetDesc;
  rowsOut.sort(cmp);
  const total = rowsOut.length;
  const paged = rowsOut.slice((page - 1) * pageSize, page * pageSize);
  return { products: paged, total, page, pageSize };
}
