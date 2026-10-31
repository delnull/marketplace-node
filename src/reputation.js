/**
 * 店铺履约画像统计（公开只读，链下信誉索引）。
 *
 * 口径（每项标注数据源与可审计性）：
 *  - 事件计数（托管单量/买家确认/超时释放/争议/仲裁判向）取自订单事件史（`order_chain.events`，
 *    读模型 `v_orders` 里叫 `onchain_events`）——watcher 对 Escrow 链上事件的**本地位移镜像**
 *    （每事件含 txHash/块号，可链上对账），节点虚报统计可被第三方重算戳穿；
 *    `at` 为节点落库时刻（近似事件时刻，诚实标注）。
 *  - 仲裁判向不在事件史字段内（Arbitrated 参数未落库），以订单**终局状态**反推：
 *    refunded = 判买家 / settled = 判卖家（只统计**含 Arbitrated 事件**的行）。
 *    注意 refunded/settled 两态**也可由 `RefundApproved` 产生**（卖家同意退款 / 争议中和解，
 *    含部分退款——那类单没有 Arbitrated 事件，因此不计入判向统计）；拆分裁决按 settled
 *    计入判卖家侧（要区分"拆分"需另读 refundedAmountWei）；
 *  - 发货耗时中位数/P90 = delivered_at − OrderCreated.at，本地账 ⚠ 节点自述（可交叉抽样）；
 *    减法的唯一实现在 shipLatencySpan（卖家 SLA 读数复用同一批样本与同一基准，见 opsMetrics.js）；
 *  - 样本阈值：窗口内争议 < 5 笔时争议率/判买家率置 null（sampleTooSmall 标记），防小样本误导；
 *  - **重复交易对占比**（`sybil`，2026-10 新增）：同一 buyer↔seller 交易对在窗口内的第 2 笔及以后
 *    的成交占该窗总成交的比例 = (总成交 − 不同交易对数) / 总成交。它是**可疑信号，不是结论**：
 *    真实的回头客（同一买家复购）与刷量在本地数据上完全同形，所以只报出比例与集中度，
 *    由读者自行判断；样本 < SYBIL_SAMPLE_MIN 时比率置 null（同争议率的小样本纪律）。
 *    口径可**从链上独立重算**：买方/卖方都在 `OrderCreated` 事件里（两个 indexed 字段），
 *    第三方扫一遍该合约的 OrderCreated 日志、按 (buyer, seller) 分组即可复算本信号——
 *    节点这一侧只是把它已经镜像的事件跑了一遍同样的分组（本仓"第三方扫链可复核"的纪律）。
 *    隐私：只出计数与比率，**不下发**具体交易对/买家地址（那等于把"某地址买了 N 次"单笔化披露）。
 *  - 隐私口径：只出聚合统计，不下发单笔订单（买家地址/商品/金额均不出现）。
 *
 * 量级：单节点一家店，全表扫描 + 行内 JSON 解析为毫秒级，公开只读低频端点不做缓存。
 */
import { getDb } from './db.js';
// 本店身份锚点（seller 过滤的判据，见 reputationSummary 的说明）
import config from './config.js';
// 「这一单有没有争过」的唯一判据（本模块与 buyerSignal 共用，见 orderFacts.js 的说明）
import { rowEverDisputed } from './orderFacts.js';

/** 时间窗（键按 JSON 输出；days=0 表示累计全量） */
const WINDOWS = [
  { key: 'all', days: 0 },
  { key: 'd365', days: 365 },
  { key: 'd90', days: 90 },
  { key: 'd30', days: 30 },
];

/** 争议样本阈值：低于该数的窗口争议相关率不展示（防小样本误导） */
const DISPUTE_SAMPLE_MIN = 5;

/**
 * 重复交易对信号的样本阈值：窗内成交低于该数时比率置 null（与争议率同一套小样本纪律——
 * "3 单里 2 单是同一买家"读起来像 67% 的异常集中度，实际上什么也说明不了）。
 */
const SYBIL_SAMPLE_MIN = 5;

/**
 * 发货耗时**分位数**的样本阈值（SLA 读数用，见 src/opsMetrics.js）：
 * P90 在 n<10 时就等于最大值、n<5 时连"尾部"都谈不上——摆在 SLA 面板上会被读成
 * "典型最慢要这么久"，所以低于该数时**不下发中位数/P90**（原始样本量照给）。
 * 数值与争议率/女巫率的 5 同量级，理由同一套：小样本不下发比率类读数。
 * 注意它只作用于**分位数**：`/reputation` 的 delivery 是原始分布读数（中位数照给，读者自辨），
 * 两处口径的差别写在 opsMetrics 的 SLA 读数 note 里，免得被当成"同一个数两处不一样"。
 */
export const DELIVERY_MIN_SAMPLES = 5;

const DAY_MS = 24 * 3600 * 1000;

/**
 * 时间列的**毫秒读数**（唯一实现）——统计侧所有"多久/早晚"的算术都在毫秒域里做。
 *
 * 为什么要有它（而不是各处 `Number(x)`）：库里的时间列是 `DATETIME(3)`，读出来是 **`Date`**
 * （见 db.js 的三层时间口径），而这一层的窗口比较、排序、减法都要毫秒数。写成 `.getTime()`
 * 是显式的；写成 `Number(date)` 虽然碰巧也对，但它看起来像"把 Date 当数字用"，
 * 让人分不清哪一处是刻意的换算。
 *
 * 读不到/不是时间 ⇒ **null**（调用方按"读不到"处理）：绝不返回 NaN——
 * NaN 与任何数比较都是假，一条坏数据会静默地被判成"不在任何窗口里"，而那是编出来的结论。
 * 只接受 `Date` 与毫秒数两种形状（前者来自库、后者来自单测注入），别的形状一律 null。
 */
export function timeMs(v) {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * 解析事件史（`order_chain.events`，读模型 `v_orders` 里叫 `onchain_events`）——**唯一入口**
 * （画像/SLA/买家信号共用）。
 *
 * JSON 列由驱动**解析成 JS 值**返回（见 db.js 的连接选项），所以这里拿到的是数组本身，
 * 不再 `JSON.parse`；再 parse 一次会抛错并被吞掉，事件史会被静默清空。
 * 形状不对（不是数组）时给 `[]`：调用方只做计数，多一条少一条都不该让整页读数炸掉。
 */
export function parseOnchainEvents(raw) {
  return Array.isArray(raw) ? raw : [];
}

/**
 * 事件史 → **对外形状**：把 `at` 的毫秒数折成 ISO-8601 字符串。
 *
 * 为什么存储保持毫秒、只在出口折一次：
 *   · 内部读者 `escrowedAtOf` 要做**时长算术**（必须先有毫秒），所以存储不能是字符串；
 *   · 对外只有**一种**时间表示（见 db.js 的说明），所以出口不能是毫秒。
 * 两个需求分别在各自那一层满足，而不是让某一层"两种都认"——那正是要消灭的东西。
 * 折在前端也不行：出口统一之后前端只需要一条规则（所有时间都是 ISO）。
 *
 * 形状不对的条目原样透传（与 `parseOnchainEvents` 的宽容口径一致：一份坏数据
 * 不该让整页读数炸掉，但也不该被悄悄补上一个编出来的时刻）。
 */
export function eventsForDto(raw) {
  return parseOnchainEvents(raw).map((ev) =>
    ev && typeof ev === 'object' && typeof ev.at === 'number'
      ? { ...ev, at: new Date(ev.at).toISOString() }
      : ev
  );
}

/**
 * 托管入账近似时刻 = 事件史里**第一条** `OrderCreated` 的落库时刻（`at`）；读不到返回 null。
 *
 * 口径的边界（如实写）：`at` 是节点轮询/`/paid` 落库的时刻，不是链上区块时刻（差一轮轮询间隔），
 * 全仓的"发货耗时"都以它为准（见文件头），所以它是**节点自述**而非链上事实。
 *
 * `at` 在这一列里是**毫秒数**（不是 DATETIME）：事件史是应用自己写的 JSON 文档，
 * 它的形状由"所有写者 + 所有读者"共同决定——写者（watcher 的 recordEvent、routes/orders.js 的
 * 补写）都是毫秒，而这里的时长算术也必须先有毫秒。
 * 对外的形状由 `eventsForDto` 折成 ISO（出口只有一种表示）；把库里 DATETIME 的 `Date`
 * 口径直接套到这一列上（或反过来把 `at` 存成字符串）都会让时长算术静默变成 NaN。
 */
export function escrowedAtOf(events) {
  for (const ev of events || []) {
    const at = timeMs(ev && ev.at);
    if (ev?.name === 'OrderCreated' && at) return at;
  }
  return null;
}

/**
 * 发货耗时样本（毫秒）= 交付时刻 − 托管入账近似时刻；任一缺失返回 null（读不到就不报数）。
 * **唯一判据**：履约画像与卖家 SLA 读数共用同一个减法——两处各写一遍必然漂移，
 * 而"这家店发货要多久"出现两个数就是两个真相。
 *
 * 入参是**毫秒数**（调用方用 `timeMs(列)` / `escrowedAtOf(事件史)` 先折算好）。
 */
export function shipLatencySpan({ deliveredAt, escrowedAt }) {
  const d = timeMs(deliveredAt) || null;
  const e = timeMs(escrowedAt) || null;
  if (!d || !e) return null;
  return d - e;
}

/**
 * 分位数（最近秩法：升序第 ⌈q·n⌉ 个样本）——**唯一实现**。
 * 本函数只做算术，**不判样本够不够**（那是调用方的显示策略，见 DELIVERY_MIN_SAMPLES）。
 */
export function percentile(list, q) {
  if (!Array.isArray(list) || !list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[idx];
}

/** 交易对的稳定键（buyer↔seller；卖家在本仓是一家店，但键里带上它才是"交易对"的诚实口径） */
const pairKeyOf = (row) => `${String(row.buyer || '').toLowerCase()}|${String(row.seller || '').toLowerCase()}`;

/** 纯统计函数（行：读模型 `v_orders` 的 status/onchain_events/delivered_at/buyer/seller 列；nowMs 供测试注入） */
export function computeReputation(rows, nowMs = Date.now()) {
  // 每窗聚合桶（事件计数 + 发货耗时样本 + 交易对计数）
  const win = {};
  for (const w of WINDOWS) {
    win[w.key] = {
      orders: 0, confirmed: 0, timeouts: 0, disputes: 0,
      settledToSeller: 0, refundedToBuyer: 0,
      deliveries: [], // 发货耗时样本（ms）
      pairs: new Map(), // 交易对键 → 该窗内的成交单数（重复交易对信号的原始材料）
    };
  }
  let firstOrderAt = null;
  /*
    **事件史读不出来的行数**（2026-10-16 补，三态纪律）：`order_chain.events` 是 JSON 列，
    驱动会解析成 JS 值——但配置/列类型/读模型任何一处变化都可能让它以**字符串**回来。
    宽容地把非数组折成 `[]` 是对的（一份坏数据不该让整页读数炸掉），但**折成 0 事件就不对了**：
    画像里的单量、确认率、超时率、争议率全部按事件计数算，于是一次格式漂移会让整个节点的
    公开画像静默变成"这家店什么历史都没有"，而 `/api/shop/reputation` 仍然 200。
    这是买家用来判断"这家店靠不靠谱"的主要信号，答案必须是**能不能读**而不是一个默认值。
    所以这里把"读不出来的行数"作为**独立结论**带回出口（调用方据此显示"画像不完整"，
    而不是显示一个看起来正常的零）。与 `poolAlert` 为"快照读不到 ≠ 没有池"做三态同款。
  */
  let eventsUnreadable = 0;

  /** 事件 at 落入窗口？all 恒含；有界窗按落库时刻过滤 */
  const inWindow = (w, at) => w.days === 0 || at >= nowMs - w.days * DAY_MS;

  for (const row of rows) {
    // 事件史解析与"托管入账近似时刻"都走本模块的唯一实现（画像/SLA/买家信号同源）
    if (row.onchain_events !== null && row.onchain_events !== undefined && !Array.isArray(row.onchain_events)) {
      eventsUnreadable += 1;
    }
    const events = parseOnchainEvents(row.onchain_events);
    /*
      ⚠️ **不按"有没有事件史"跳过整单**（2026-10-15 修 D3 的最后一段）：
      事件史是**可变长度**的镜像（上限 20 条、可被可重复事件挤空），"这单托管过"的凭据不是它，
      而是 `paid_tx_hash`（见下面那段说明）。留着 `if (!events.length) continue;`
      就等于把"整单是否进画像"仍然挂在事件史上——事件被清空的老店照样会显示成「新店」。
      没有事件时下面各计数自然是 0（分子不受影响），单量与非空凭证同源。
    */

    // 交付时刻（本地账：卖家发货写入）——列是 DATETIME(3)（Date）或 NULL，算术在毫秒域做
    const deliveredAt = timeMs(row.delivered_at);
    // OrderCreated 落库时刻（托管入账近似）——唯一判据见 escrowedAtOf
    const escrowedAt = escrowedAtOf(events);

    // ── 同源口径（评审修正，防 >100% 失真）──
    // 每笔订单以「OrderCreated 落库时刻」归属窗口（窗口语义 = 近 N 天创建的托管单），
    // 该单其后所有事件（确认/争议/仲裁/超时…）全部计入同一批窗口——
    // 比率分子分母同源：窗内不会出现「窗外创建的旧单在窗内确认/裁决」的孤儿分子，
    // confirmRate/disputeRate/refundRate 恒 ∈ [0,1]。
    /*
      ── 托管**证明**与窗口锚点都不再依赖"事件史里还留着 OrderCreated"（2026-10-15 修 D3）──
      旧实现的判据是"事件史里找得到 OrderCreated"，而 `onchain_events` 只保留**最后 20 条**
      （`slice(-20)`），`PartialRefundAccepted` 又是**可重复**事件（买家每授权一次记一条）——
      审计实测：对同一单授权 20 次即可把 `OrderCreated` 挤出去，于是那一单在公开画像里
      **整单消失**（连它有过的争议、确认、判向一起消失），店铺页印「新店：还没有任何托管记录」——
      一句关于这家店的**具体断言**，而依据是本地事件史被挤掉。
      现在两件事各用一件**不会被挤掉**的凭据：
        · 证明 = `paid_tx_hash`（链上支付凭证本身；发货闸用的也是它——"缺凭证"的单连发货都会被拒），
          它由 paid / watcher / sync 三条链上路径写入，与事件史的裁剪无关；
        · 锚点 = `OrderCreated` 的落库时刻；真被挤掉时退回本行的 `created_at`
          （同一单的本地起始时刻，通常与托管时刻相差一次草稿存活时间；只影响有界窗口的边界，
          不影响 all 窗口——公开画像读的是 all）。
      代价如实写：没有支付凭证的单（历史异常行）从此**不进画像**——比"把一家有记录的店说成新店"划算。
    */
    const proven = !!String(row.paid_tx_hash || '').trim();
    if (!proven) continue;
    const anchorAt = escrowedAt || timeMs(row.created_at) || 0;
    if (!anchorAt) continue; // 连本地起始时刻都没有：无法归属窗口
    const orderWindows = WINDOWS.filter((w) => inWindow(w, anchorAt));
    /*
      **托管单量每行只加一次**（不再由"事件里有没有 OrderCreated"决定）：计数与证明同源之后，
      下面的逐事件计数最多每行各一次 ⇒ `分子 ≤ 分母` 是**结构上**成立的，
      而不是靠"跳过没有 OrderCreated 的行"来回避（旧口径的代价是整单消失，见上）。
    */
    for (const w of orderWindows) {
      win[w.key].orders += 1;
      const key = pairKeyOf(row);
      win[w.key].pairs.set(key, (win[w.key].pairs.get(key) || 0) + 1);
    }
    if (firstOrderAt === null || anchorAt < firstOrderAt) firstOrderAt = anchorAt;

    /*
      **"这一单有没有争过"只判一次**（2026-10-15 修 D1/D2）：判据在 `orderFacts.rowEverDisputed`
      （状态 ∨ DisputeRequested ∨ Arbitrated），本模块与 buyerSignal 共用同一份实现。
      旧实现只在事件名恰好是 `DisputeRequested` 时给 `disputes += 1`，于是**镜像被 /sync 或后台
      对账按链上真值修好的争议**（事件名是 `Sync:disputed`）一律读成 0：审计实测 7 张
      `status='disputed'`、钱冻在链上的单，公开页印「争议率 0%」，而同一时刻 buyerSignal 印「争议 7 单」。
      更要紧的是它让**分子脱离分母**：判向计数（`refundedToBuyer`/`settledToSeller`）是
      **按行**数的（行上有 `Arbitrated` 就算），而分母是**按事件**数的 —— 混合口径能算出
      `refundRate = 1.4`（「争议 5 笔中判买家 7 笔」）。现在两者同源（都以本行为单位），
      因此 `refundedToBuyer + settledToSeller ≤ disputes` 恒成立，比率回到 [0,1]。
    */
    if (rowEverDisputed(row, events)) for (const w of orderWindows) win[w.key].disputes += 1;

    for (const ev of events) {
      const at = timeMs(ev && ev.at);
      if (!at) continue;
      if (ev.name === 'ReceiptConfirmed') {
        for (const w of orderWindows) win[w.key].confirmed += 1;
      } else if (ev.name === 'OrderExpiredReleased') {
        for (const w of orderWindows) win[w.key].timeouts += 1;
      } else if (ev.name === 'Arbitrated') {
        // 判向以终局状态反推（refunded=买家 / settled=卖家）；异常终局不计入判向
        if (row.status === 'refunded') {
          for (const w of orderWindows) win[w.key].refundedToBuyer += 1;
        } else if (row.status === 'settled') {
          for (const w of orderWindows) win[w.key].settledToSeller += 1;
        }
      }
    }

    // 发货耗时样本：按订单创建归属窗口（与事件计数同源；有交付记录且能取到托管时刻）。
    // 减法只有一处实现（shipLatencySpan）：履约画像与卖家 SLA 读数必须给出同一个"发货多久"。
    const span = shipLatencySpan({ deliveredAt, escrowedAt });
    if (span !== null) for (const w of orderWindows) win[w.key].deliveries.push(span);
  }

  /** 中位数（偶数取均值）；空样本返回 null */
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };

  /** 比率（分母 0 返回 null；4 位小数防浮点尾巴） */
  const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : null);

  const windows = {};
  const delivery = {};
  for (const w of WINDOWS) {
    const b = win[w.key];
    const disputes = b.disputes;
    const sampleTooSmall = disputes > 0 && disputes < DISPUTE_SAMPLE_MIN;
    /*
      重复交易对信号（**可疑信号，不是结论**；口径与边界见文件头）：
        repeatOrders = 总成交 − 不同交易对数（= 第 2 笔及以后的成交笔数）
        repeatPairShare = repeatOrders / 总成交
        topPairShare    = 单一交易对的最大成交数 / 总成交（集中度）
      两项都只在小样本之上才给（否则 null）。
    */
    const distinctPairs = b.pairs.size;
    const repeatOrders = Math.max(0, b.orders - distinctPairs);
    const topPairOrders = b.pairs.size ? Math.max(...b.pairs.values()) : 0;
    const sybilTooSmall = b.orders < SYBIL_SAMPLE_MIN;
    windows[w.key] = {
      orders: b.orders,
      confirmed: b.confirmed,
      timeouts: b.timeouts,
      disputes,
      settledToSeller: b.settledToSeller,
      refundedToBuyer: b.refundedToBuyer,
      // 样本不足：争议相关率不展示（其余字段照常，窗内 0 争议视为健康而非样本问题）
      disputeRate: sampleTooSmall ? null : ratio(disputes, b.orders),
      refundRate: sampleTooSmall ? null : ratio(b.refundedToBuyer, disputes),
      confirmRate: ratio(b.confirmed, b.orders),
      timeoutRate: ratio(b.timeouts, b.orders),
      sampleTooSmall,
      sybil: {
        distinctPairs,
        repeatOrders,
        repeatPairShare: sybilTooSmall ? null : ratio(repeatOrders, b.orders),
        topPairShare: sybilTooSmall ? null : ratio(topPairOrders, b.orders),
        sampleTooSmall: sybilTooSmall,
      },
    };
    delivery[w.key] = {
      count: b.deliveries.length,
      medianMs: median(b.deliveries),
      /*
        P90（最近秩法，见 percentile）：与中位数同一批样本、同一基准。
        样本量低于 DELIVERY_MIN_SAMPLES 时这里照样给数（**原始分布读数**，读者自辨），
        `sampleTooSmall` 只是如实标注样本量；要"样本不足就整块不发数"的读数（SLA）由调用方
        据此自行置 null——两处口径的差别写在 opsMetrics.slaReading 的 note 里。
      */
      p90Ms: percentile(b.deliveries, 0.9),
      sampleTooSmall: b.deliveries.length < DELIVERY_MIN_SAMPLES,
    };
  }

  return {
    windows,
    delivery,
    /*
      ⚠️ 出口折 ISO：这是**对外契约里的时刻**，全仓只有这一种表示（见 db.js）。
      内部一路用毫秒算（`anchorAt` 来自 `timeMs`，方便比较与相减），只在出口折一次；
      直接把毫秒下发会让前端的 `fmtTime(iso)` 静默印 "-"（读不到），而数据显示是空的、
      也不报错——这类"两种时间表示"的错配正是把它统一成 ISO 要消灭的东西。
    */
    firstOrderAt: firstOrderAt === null ? null : new Date(firstOrderAt).toISOString(),
    /*
      **画像完整性的独立结论**（不是"零事件"）：`eventsUnreadable > 0` 表示有若干行的事件史
      读不出来（列形状不对），它们的事件计数在本轮里是缺的。调用方遇到非零应当**如实标注
      "画像不完整"**，而不是把它当成"这家店没有历史"。为 0 才是"全部都读到了"。
    */
    eventsUnreadable,
    note: '事件计数源自节点对 Escrow 链上事件的镜像（txHash/块号可重算对账）；发货耗时为本地账（节点自述）。',
    /*
      给调用方的一句话边界（同一条也写在 windows[].sybil 的注释里）：
      重复交易对占比**只是可疑信号**——真实的回头客与刷量在"同一买家反复买同一家店"这件事上完全同形，
      它既不能单独证明刷量，也不能因为高就下架/降权任何一方；样本不足时比率为 null 而不是 0。
    */
    sybilNote:
      'sybil.* = 同一 buyer↔seller 交易对的重复成交占比（可疑信号，非结论）：' +
      '真实复购与刷量在本地/链上同形，仅作人工核查的入口；口径可由第三方扫 OrderCreated 事件按 (buyer,seller) 分组独立重算。',
  };
}

/**
 * 路由用便捷入口：全表统计（订单行含草稿/取消；**没有链上支付凭证的行不进画像**，见 computeReputation）。
 * 交付时刻已随 v2 数量模型迁至 order_delivery_items 子表（一单多行交付）：
 * 聚合取最晚交付行时刻，语义与原 delivered_at 列一致（发货耗时口径不变）。
 * **实物单兜底取 shipped_at**：实物单没有交付行（子表只记码/NFT），
 * 不兜底的话已发货的实物单会被算成"从未交付"，发货耗时中位数会丢掉这一大块样本。
 * buyer/seller 两列是**重复交易对信号**的分组键（见文件头；两者都是 OrderCreated 事件的
 * indexed 字段 ⇒ 口径可由第三方扫链复算）。
 *
 * **必须按卖家地址过滤**（2026-10-15 修 D6，2026-10 多店改造改为显式传参）：
 * `orders.seller` 是**逐行**写入的（= 该单所属店铺的 `shops.seller`），而本函数此前不带任何
 * WHERE —— 于是换过店主地址（店铺转手 / 换绑钱包）、或一台节点上有多家店时，会把**别家店**
 * 的订单算进这一家的公开画像（单量、确认率、发货耗时全被稀释/抬高），而这份画像是买家
 * 用来判断"这家店靠不靠谱"的。
 *
 * 参数是**三态**（沿用本仓的三态纪律，目的是让"忘了传"不可表达）：
 *   · `undefined`（漏传）⇒ 抛错。**不给默认值**：默认成"全部"就是一次静默的跨店混算，
 *     而它的表现是"画像数字看起来正常、只是不对"——最难查的一类；
 *   · `null` ⇒ 显式表示"该节点全部在售店铺的合计"（公开目录页要的就是这个）；
 *   · 地址字符串 ⇒ 只算这一家。
 * @param {string|null|undefined} seller
 */
export async function reputationSummary(seller) {
  if (seller === undefined) {
    throw new Error('reputationSummary 需要显式的 seller（null = 全部在售店铺）；漏传会静默跨店混算');
  }
  const sel = seller === null ? '' : String(seller).toLowerCase();
  /*
    整单读走读模型 `v_orders`：事件史（`order_chain.events`，视图里叫 `onchain_events`）、
    支付凭证（`order_chain.paid_tx_hash`）与订单事实一次读全；交付时刻取交付子表的最晚一行、
    实物单兜底 `shipped_at`（口径见函数说明）。
    `WHERE o.seller = ?` 不带 `lower()`：函数包住列只会让索引失效；写入侧一律小写落库是
    **唯一的不变量**（地址列是 `utf8mb4_0900_as_cs` 大小写敏感，2026-10 更正：此前这里写的是
    "排序规则本是 ai_ci"——那是假话，as_cs 下大小写不同的行是两条互不可见的键）。
  */
  const rows = await getDb().all(`SELECT o.status, o.onchain_events, o.buyer, o.seller, o.paid_tx_hash, o.created_at,
              COALESCE(
                (SELECT MAX(created_at) FROM order_delivery_items WHERE order_id = o.order_id),
                o.shipped_at
              ) AS delivered_at
       FROM v_orders o
       JOIN shops s ON s.code = o.shop_code AND s.listed = 1
       ${sel ? 'WHERE o.seller = ?' : ''}`, ...(sel ? [sel] : []));
  return computeReputation(rows, Date.now());
}
