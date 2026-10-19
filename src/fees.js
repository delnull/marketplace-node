/**
 * 平台费口径（**唯一实现**）——收款流水/看板/CSV 导出的净额都走这里。
 *
 * 「收不收、按哪个地址收」在**创建订单时快照**（每单一个决定，2026-09 契约变更）：
 * 合约 `Escrow.Order` 新增 `feeCollectorAtCreate`，`_settle` 只读这个快照——
 *   `feeCollectorAtCreate != address(0) && feeBps > 0` 才扣费
 * 为什么不能读全局 `feeCollector()`（源码审计 2026-09 → 契约层修复）：
 * 全局值可被 owner 事后 `setFeeCollector(x)` 改掉，而**费率调整不应影响在途订单**。
 * 于是"实时读全局"必然与链上漂移，且两个方向都错：
 *  · 创建时配了收取方 → 事后被置零：链上照扣（快照），节点账本却报"不扣费"⇒ 净额虚高；
 *  · 创建时为 0 → 事后配了收取方：链上一分不扣，节点账本却按 feeBps 折算 ⇒ 净额虚低。
 * 这正是本文件头要消灭的"面板说扣了、钱包没少"。
 *
 * 读取策略（三级）：
 *  1. **每单快照**（orders.fee_collector_at_create，由 paid / watcher / sync 从链上补录）——
 *     权威，不需要任何 RPC。非 NULL → 直接按它判（零地址=不扣，非零=扣）；**NULL = 未知**
 *     （见 `feeSnapshotReadOf`：`fee_bps` 那一列分不开"没补录"与"就是 0"，所以判据取两列；
 *     MySQL 重设计后"从未补录"由 NULL 表达，空串不再是一种取值）；
 *  2. 快照为 NULL（补录失败/ABI 尚未同步）= **未知** → 退回全局口径 `feeChargeable()`
 *     （见下），并在响应里如实标注"未知"；
 *  3. 全局口径：`refreshFeeCollector()` 带 60s 缓存读链上全局 `feeCollector()`；**读不到就是读不到**
 *     （RPC 不可达/合约已移除该函数）⇒ `known=false`、`feeCollector=null`，随响应一起下发
 *     （`feeCollectorKnown` / `feeCollector`），UI 据此把金额标为「预计」而不是「已扣」。
 *     读不到时**绝不**拿上一次成功读到的地址冒充"当前的真值"：那会让一次 RPC 抖动把口径说反
 *     （"零地址=本部署从不扣费"与"读不到"在响应里曾是同一个形状——见 refreshFeeCollector 的注释）。
 */
import { getEscrow } from './chain.js';

/**
 * feeCollector 读取缓存（60s；同进程共享）。
 *  `at`      最后一次**尝试**读的时刻（只用于 TTL：读失败也刷新，避免每次请求都去戳不可达的 RPC）
 *  `addr`    本次（TTL 窗口内）**确证**读到的收取方；读不到时恒 null（= 读不到，不是"零地址"）
 *  `known`   本次是否**确证**（true 才有资格谈 addr 的含义：零地址 = 从不扣费）
 *  `lastOk`  最后一次**成功**读数 `{ at, addr }`，只作诊断/日志用（"最后一次成功读数"），
 *            **绝不**参与任何判定——它与"当前是否已确证"是两件事，故分开放。
 */
let cache = { at: 0, addr: null, known: false, lastOk: null };
const TTL_MS = 60_000;

/** 零地址判定（与 chain.isZeroAddress 同口径；此处内联避免循环依赖） */
function isZeroAddr(a) {
  return !a || String(a).toLowerCase() === '0x0000000000000000000000000000000000000000';
}

/**
 * 刷新链上 feeCollector（带 TTL 缓存）。账本/看板/导出路由在计算前 await 一次即可。
 * 永不抛错。
 *
 * ⚠️ 用途已收窄为**披露与兜底**（每单快照缺失时才参与折算）：链上已改为按订单创建时快照
 * 决定扣费，全局值只是"这家店现在配的收费方"，不再等于任何在途单的实际口径。
 */
export async function refreshFeeCollector() {
  if (cache.at && Date.now() - cache.at < TTL_MS) return cache;
  try {
    const addr = String(await getEscrow().feeCollector()).toLowerCase();
    const at = Date.now();
    cache = { at, addr, known: true, lastOk: { at, addr } };
    return cache;
  } catch (e) {
    /*
      读失败 ⇒ **如实标成"读不到"**（2026-10，推翻 2026-09 复审的"沿用上次的 known"）。
      "读不到"与"确证是某个值"是两件事：旧实现把 `addr`/`known` 保留上次的成功读数，
      于是一次 RPC 抖动就能把口径**说反**——上一次读到零地址（=本部署从不扣费）之后读不到，
      响应里仍旧写着"已知、零地址"，面板继续按"已扣/不扣"报数，而当前真相是"不知道"。
      现在：本次窗口内一律 `known=false`、`addr=null`（读不到），`feeChargeable()` 随之
      按"可能扣费"保守折算并在响应里标「预计」（与本文件头的三级策略一致）。
      上次成功读数只留在 `lastOk` 里供日志/诊断说明"最后读到的是什么"，**不参与判定**。
      `at` 仍刷新（"上次尝试读的时刻"）：读不到时也不要在每个请求上重打不可达的 RPC。
    */
    const prev = cache.lastOk;
    cache = { at: Date.now(), addr: null, known: false, lastOk: prev };
    console.warn(
      `[fees] 读不到链上全局 feeCollector()（${e?.message || e}）——本次披露按"读不到"（feeCollectorKnown=false、feeCollector=null）、` +
        `无快照的行按"可能扣费"保守折算并标注为预计；${
          prev ? `最后一次成功读数是 ${prev.addr}（${new Date(prev.at).toISOString()}）` : '此前从未成功读到过'
        }`
    );
    return cache;
  }
}

/**
 * 当前是否可能扣费：已知 feeCollector 为 0 → 从不扣费；**读不到** → 按可能扣费处理（保守）。
 * 这是**全局兜底口径**，只用于"该单没有创建时快照"的行（见 feeChargeableForOrder）。
 * 注意三态：`true` 有两种来源——"确证非零地址"与"读不到（估算）"。要分清它们看
 * `feeStatus().feeCollectorKnown`（false = 读不到，金额只能当预计），不要把这个布尔当链上事实。
 */
export function feeChargeable() {
  return !(cache.known && isZeroAddr(cache.addr));
}

/**
 * 该订单在创建时是否配置了平台费收取方（链上快照，**权威且不依赖 RPC**）。
 *  - 快照非 NULL → `快照 !== 零地址`（零地址 = 创建时就没配收取方 ⇒ 这单永不扣费）；
 *  - 快照缺失（NULL，或调用方手里没有这一列的旧对象）→ **未知**，
 *    退回全局保守口径 `feeChargeable()`（宁可提示"可能扣费"，也不把不知道说成不扣费）。
 * @param {string|null|undefined} feeCollectorAtCreate orders.fee_collector_at_create（小写地址或 NULL）
 */
export function feeChargeableForOrder(feeCollectorAtCreate) {
  const snap = String(feeCollectorAtCreate ?? '').trim();
  if (!snap) return feeChargeable();
  return !isZeroAddr(snap);
}

/**
 * 该单的扣费判据**来自哪里**：`'snapshot'`（创建时收费方快照——链上权威）或
 * `'fallback'`（快照缺失 → 退回全局保守口径，**可能**与链上实际扣费不符）。
 *
 * 为什么必须把它单独说出来（源码审计 2026-09 续）：`feeChargeableForOrder` 在快照缺失时
 * 会给出一个"保守但可能错"的布尔值，而导出/对账只看那个布尔值就分不出两种情况——
 * 「确证按快照不扣费」与「读不到、于是按会扣费折算」。后者正是店主月结时对不上账的常见来源
 * （费率差额不是数据错误，是口径没落盘）。三态纪律：有快照 / 无快照（NULL）/ 判据本身未知，
 * 前两者都在这里如实标出，绝不让"折算了"冒充"已确证"。
 * @param {string|null|undefined} feeCollectorAtCreate orders.fee_collector_at_create（NULL = 从未补录）
 * @returns {'snapshot'|'fallback'}
 */
export function feeBasisOf(feeCollectorAtCreate) {
  return String(feeCollectorAtCreate ?? '').trim() ? 'snapshot' : 'fallback';
}

/**
 * 对外披露口径（随账号类接口返回，供 UI 标注「已扣 / 预计」）：
 *  `feeCollector`      本次确证读到的收取方；**读不到时为 null**（不再是上次的值）
 *  `feeCollectorKnown` false = 本次读不到 ⇒ 界面必须按「预计」呈现（三态：确证扣/确证不扣/读不到）
 *  `feeChargeable`     全局兜底布尔（读不到时按"可能扣费"保守取值，见上）
 * 三个字段语义不变（前端 utils/arbiterMoney.feeCollectorFromNodeFlags 已按这三态消费）。
 */
export function feeStatus() {
  return { feeCollector: cache.addr || null, feeCollectorKnown: cache.known, feeChargeable: feeChargeable() };
}

/**
 * 从链上 `getOrder` 结果里取本单的费率与**创建时收取方快照**（唯一实现；paid / watcher / sync
 * 三个补录入口共用）。
 *
 * `feeCollectorAtCreate` 是 `getOrder` 返回元组末尾新增的一项（契约层 2026-09，ABI 已同步）。
 * **两个字段必须都读到才算读到**（`known`）：它们在库里的两列由**同一条 UPDATE** 成对写
 * （见 `writeFeeSnapshot`），只写一半会让"没补录过"和"确证 0%"在 `fee_bps`
 * （`SMALLINT UNSIGNED NOT NULL DEFAULT 0`）上同形——那正是账本/看板曾经把"不知道"印成"不扣费"的根因。
 * 所以缺任一个字段 ⇒ `known:false`（此时 `feeBps`/`feeCollectorAtCreate` 是占位值，**不得写库**）。
 *
 * 字段缺失/为 null 时返回空串 = **未知**（绝不回落成零地址——那等于凭空宣称"这单不扣费"）。
 * 返回值里的空串是**"未知"的进程内表示**：写库时由 `writeFeeSnapshot` 落成 NULL
 * （列可空，NULL 才是库里"从未补录"的形状）。
 * @returns {{known:boolean, feeBps:number, feeCollectorAtCreate:string}} feeCollectorAtCreate 小写地址或 ''（未知）
 */
export function feeSnapshotOf(onchain) {
  const rawCollector = onchain?.feeCollectorAtCreate;
  const collector = rawCollector === undefined || rawCollector === null ? '' : String(rawCollector).trim().toLowerCase();
  const rawBps = onchain?.feeBps;
  const bps =
    rawBps === undefined || rawBps === null || String(rawBps).trim() === '' ? null : Number(rawBps);
  const known = collector !== '' && bps !== null && Number.isFinite(bps) && bps >= 0;
  return { known, feeBps: known ? bps : 0, feeCollectorAtCreate: known ? collector : '' };
}

/**
 * 费率快照的**唯一写入点**（三态判据与写入放在一起，2026-10-15）：
 * `known:false`（链上那两个字段没同时读到）时**什么都不写**，返回 false——
 * 绝不把"未知"写成 `fee_bps = 0` + 空串，也绝不覆盖掉此前补录过的确证快照。
 *
 * **两条腿的 known 各自独立**（2026-10-18 修）：平台费快照读到、而节点抽成快照没读到
 * （`commissionTermsAtCreate` 那一次 RPC 失败）时，只写 `fee_bps` / `fee_collector_at_create`
 * 两列，**不动** `commission_bps` / `commission_to`。旧实现把"抽成未知"折成
 * `{commissionBps: 0, commissionTo: null}` 一起写进同一条 UPDATE ⇒ 一次链上读数缺口会把
 * 已经补录过的抽成快照**抹成未知/0**（账本随即把这一单的抽成腿算成 0，而链上照扣）。
 * 代价如实写明：这一单在两列上会短暂处于"费已确证、抽成仍未补录"——那正是三态允许的中间态，
 * 下一轮补录会补上；而反向（把未知写成 0）是不可恢复的错账。
 *
 * 为什么把写入也收到这里：此前三处补录各自写 UPDATE，判据（`feeSnapshotOf` 的返回值）与
 * 写入点分离，于是"忘了判 known"这件事在调用点无法被发现——structurally，
 * 判据与它保护的那次写入必须在同一个函数里。
 *
 * 表与键（2026-10 重设计）：这四列**都在 `orders`**（订单事实与条款快照），
 * 不在链上镜像表 `order_chain` 里——所以 `WHERE id = ?` 打的是 `orders.id`（内部数字键，
 * 与 `v_orders.order_id` 同值）。
 *
 * 注意：本函数**不碰** `refunded_amount_wei`（那是另一个链上事实，住在 `order_chain`，口径见调用方），
 * 也不动 `updated_at`（补录不是状态迁移）。
 *
 * **返回值 = 这次是否真的改变了库里的值**（2026-10-18，为 `/sync` 的"本次做了什么"文案）：
 * 两条 UPDATE 都带 NULL 安全的"值不同才写"谓词（`NOT (col <=> ?)`），所以同值补录
 * `changes=0`、返回 false。调用方据此区分"补录了"与"本来就有"，而不是把每次补录都
 * 报成一次变更（更不是靠 `FOUND_ROWS` 的 changes=1 把同值写当成变更）。
 *
 * @param {{run: Function}} db 查询门面（`getDb()`；补录入口在事务里时同样传它）
 * @param {number} orderId 订单内部键（`orders.id`）
 * @returns {boolean} 是否真的写入了新值（false = 平台费快照未知，或四列本来就等于这次读数）
 */
export async function writeFeeSnapshot(db, orderId, snap, commissionSnap) {
  if (!snap || !snap.known) return false;
  if (!commissionSnap || !commissionSnap.known) {
    const { changes } = await db.run(
      `UPDATE orders SET fee_bps = ?, fee_collector_at_create = ?
        WHERE id = ? AND (fee_bps <> ? OR NOT (fee_collector_at_create <=> ?))`,
      snap.feeBps, snap.feeCollectorAtCreate, orderId,
      snap.feeBps, snap.feeCollectorAtCreate
    );
    return changes === 1;
  }
  const { changes } = await db.run(
    `UPDATE orders SET fee_bps = ?, fee_collector_at_create = ?, commission_bps = ?, commission_to = ?
      WHERE id = ?
        AND (fee_bps <> ? OR NOT (fee_collector_at_create <=> ?)
             OR commission_bps <> ? OR NOT (commission_to <=> ?))`,
    snap.feeBps, snap.feeCollectorAtCreate, commissionSnap.commissionBps, commissionSnap.commissionTo || null, orderId,
    snap.feeBps, snap.feeCollectorAtCreate, commissionSnap.commissionBps, commissionSnap.commissionTo || null
  );
  return changes === 1;
}

/**
 * 平台费**折算内核**：**结算基数** × feeBps / 10000（与链上同款下取整）；不扣费时恒为 0。
 * 注意 `amountWei` 是**结算基数**，不是托管总额：调用方要传 `amount − refunded`
 * （部分退款/拆分裁决的单，费只对卖家实收的那部分计）。
 *
 * **刻意不 export**（2026-10-16）：它是算术内核，参数一多就有"少传一个就静默算错"的形状，
 * 而唯一合法入口是 `feeOfRow`（三态 + 全部判据都在那里）。此前 `export` 让调用点能绕过
 * `feeOfRow` 自己拼三个参数——而"拼错"的后果是账目偏低且不可对账。现在业务代码拿不到它。
 *
 * @param {bigint|string|number} amountWei 结算基数（= amount − 已退买家）
 * @param {number|string} feeBps 订单级费率快照（基点）
 * @param {string} feeCollectorAtCreate 该单创建时的平台费收取方（订单快照）
 * @param {string} seller 该单的卖家（= 订单 `seller`）
 */
function feeOf(amountWei, feeBps, feeCollectorAtCreate, seller) {
  const bps = Number(feeBps);
  if (!Number.isInteger(bps) || bps <= 0) return 0n;
  if (!feeChargeableForOrder(feeCollectorAtCreate)) return 0n;
  /*
    **平台不向自己收费**（2026-10-16 镜像链上 `Escrow._splitOf` 的同一判据）：
    链上是 `collector != address(0) && collector != o.seller` 两条并存，缺了后一条时
    ——平台收款地址就是店主地址（平台自营店，Escrow 注释里写明的运营形态）——
    链上实收平台费恒为 **0**，而这里会照 feeBps 扣出一个数。后果不是"显示不准"：
    · 店主订单卡/流水/导出 CSV/看板/仲裁台的"实收净额"**全部偏低一个平台费**；
    · 平台费收入账**虚增**；
    · 而链上对账（`reconcile-ledger`）用同一把错尺子 ⇒ **永远对不出来**——
      这正是那份脚本自己警告过的"两边同源即自证"。
    判据落在这里（唯一内核）而不是各调用点：链上那一条写在 `_splitOf` 里，
    链下这一条写在这里，**两处各一份、语义逐字相同**；调用点只传事实，不做判断。
    地址一律小写比较（本仓地址列的写入侧不变量），空串/未读到 ⇒ 不构成"等于卖家"。
  */
  const collector = String(feeCollectorAtCreate ?? '').trim().toLowerCase();
  const sellerAddr = String(seller ?? '').trim().toLowerCase();
  if (sellerAddr !== '' && collector === sellerAddr) return 0n;
  return (BigInt(amountWei) * BigInt(bps)) / 10000n;
}

/**
 * 该行的**费率快照读数**（三态）——"这一单的费率口径"的**唯一判据**。
 *
 * 为什么必须有它（2026-10-14 收口）：`orders.fee_bps` 是 `SMALLINT UNSIGNED NOT NULL DEFAULT 0`，
 * 于是「从没补录过」与「快照确实是 0」在那一列上是**同一个值**，分不开。能分开它们的是
 * `fee_collector_at_create`：两列由**同一条 UPDATE** 成对补录（`/paid`、watcher、`/sync` 三处
 * 都是成对写），所以
 *   · **NULL** ⇒ 两列都没补录过 ⇒ **未知**（当成 0 就是替链上宣布"本单不扣费"：收据会印
 *     「0%（本单费率快照为 0）」、账本会按不扣费报净额，而链上 `_settle` 恰恰是按创建时快照扣的）；
 *   · 非 NULL ⇒ 已知（零地址 = 创建时没配收取方 ⇒ 这单永不扣费）。
 * 这条判据 `src/routes/arbitration.js` 早就写在自己的注释里了，但订单详情、流水、看板、CSV
 * 四处仍在读裸列 ⇒ 同一件事四个答案。现在只有这一份，四个消费点都调它。
 *
 * ⚠️ 判据是 `== null`，**不是**空串：这一列从 SQLite 时期的 `TEXT NOT NULL DEFAULT ''` 换成了
 * 可空列，"从未补录"现在只有 NULL 一种形状（空串在库里已经不可表达）。写成
 * `String(row.fee_collector_at_create ?? '')` 也是对的，但那要靠"空串恰好无法出现"这条外部事实；
 * 直接判 NULL 才是判据本身。
 *
 * @param {object} row 订单行（需 `fee_bps` 与 `fee_collector_at_create`；`v_orders` 两列都有）
 * @returns {{known:false} | {known:true, feeBps:number, feeCollectorAtCreate:string}}
 */
export function feeSnapshotReadOf(row) {
  if (row?.fee_collector_at_create === null || row?.fee_collector_at_create === undefined) return { known: false };
  return {
    known: true,
    feeBps: Number(row.fee_bps) || 0,
    feeCollectorAtCreate: String(row.fee_collector_at_create).trim().toLowerCase(),
  };
}

/**
 * 某行的平台费（**三态**）：`bigint`，或 **null = 费率快照未回填 ⇒ 不知道**。
 *
 * 为什么返回 null 而不是 0：这个数会被印在「已扣平台费」与「实收净额」上，而"不知道"
 * 与"不扣费"在店主的账上是两件事（一个是待补录，一个是链上一分没扣）。调用方拿到 null
 * 时应当如实报未知（`—` + "费率快照未回填"），而不是印一个 0。
 *
 * `row.seller` 是**必需**的（2026-10-16）：链上 `_splitOf` 的判据含"收取方 != 卖家"
 * （平台不向自己收费），所以"这一单扣不扣费"要拿订单的卖家一起看。行来自 `orders`/`v_orders`
 * 时 `seller` 恒在（两处都有这一列），所以这不是"多一个可选参数"，而是判据的输入之一。
 * @param {bigint|string|number} baseWei 结算基数（= amount − 已退买家）
 * @param {object} row 订单行（整行：「未知」要两列一起看，见 feeSnapshotReadOf；「自收」要 seller）
 * @returns {bigint|null}
 */
export function feeOfRow(baseWei, row) {
  const s = feeSnapshotReadOf(row);
  return s.known ? feeOf(baseWei, s.feeBps, s.feeCollectorAtCreate, row.seller) : null;
}

/** 某行的卖家实收净额（**三态**）：`bigint`，或 null = 费率/抽成快照未回填（见 feeOfRow / commissionOfRow）
 *
 * 三级分账下净额 = 基数 − 平台费 − 节点抽成。**任一条腿未知，整个净额就是未知**：
 * 印一个"少扣了一条腿"的数比印"—"更糟——店主会拿它去对账，而那个数与链上
 * `Escrow.sellerNetAtSettle` 逐单对不上，且看不出是谁漏了。
 */
export function netOfRow(baseWei, row) {
  const fee = feeOfRow(baseWei, row);
  if (fee === null) return null;
  const commission = commissionOfRow(baseWei, row);
  if (commission === null) return null;
  return BigInt(baseWei) - fee - commission;
}

/* ── 节点抽成（三级分账的中间那条腿，2026-10 多店改造新增）────────────────── */

/**
 * 从链上 `Escrow.commissionTermsAtCreate(orderId)` 的返回值里取本单的抽成条款
 * （唯一实现；paid / watcher / sync 三个补录入口共用）。
 *
 * 与 `feeSnapshotOf` 的关键差别：抽成条款是**一次独立只读调用**的结果，读到了就是确证的
 * ——`commissionBps == 0` 是**确证"这单不抽成"**，不是一个需要再判的未知档。
 * 所以这里没有"两个字段必须同时读到"的问题，`known` 只由"调用是否成功"决定，
 * 而那个由调用方（catch 住异常的补录入口）回答：**读不到就别调本函数**。
 * @returns {{known:boolean, commissionBps:number, commissionTo:string}} commissionTo 小写地址（零地址 = 确证不抽成）
 */
export function commissionSnapshotOf(terms) {
  const rawTo = terms?.commissionTo;
  const to = rawTo === undefined || rawTo === null ? '' : String(rawTo).trim().toLowerCase();
  const rawBps = terms?.commissionBps ?? terms?.bps;
  const bps = rawBps === undefined || rawBps === null || String(rawBps).trim() === '' ? null : Number(rawBps);
  const known = to !== '' && bps !== null && Number.isFinite(bps) && bps >= 0;
  return { known, commissionBps: known ? bps : 0, commissionTo: known ? to : '' };
}

/**
 * 抽成的**折算内核**：与 `feeOf` **同形状、同基数、同一种下取整**。
 *
 * 为什么必须复用同一个基数与取整：链上 `_settle` 是
 * `fee = toSeller × feeBps/10000`、`commission = toSeller × commissionBps/10000`，
 * 两条腿各自下取整、余数全归店主。链下若换了基数（例如对毛额算抽成）或换了取整方向，
 * 差额会**每一单都出现且不可对账**——"面板说扣了 7.3、链上实际扣了 7.31"。
 *
 * `commissionTo` 为 NULL/空/零地址 ⇒ 0（那一单确证不抽成）。
 */
export function commissionOf(amountWei, commissionBps, commissionTo) {
  const bps = Number(commissionBps);
  if (!Number.isInteger(bps) || bps <= 0) return 0n;
  const to = String(commissionTo ?? '').trim().toLowerCase();
  if (!to || to === '0x0000000000000000000000000000000000000000') return 0n;
  return (BigInt(amountWei) * BigInt(bps)) / 10000n;
}

/**
 * 某行的抽成读数（**三态**，与 `feeSnapshotReadOf` 同款）：
 *   · `commission_to` 为 **NULL** ⇒ 从没补录过 ⇒ **未知**（当成 0 就是替链上宣布"这单没抽成"）；
 *   · 非 NULL ⇒ 已知（零地址 = 确证这一单不抽成）。
 */
export function commissionSnapshotReadOf(row) {
  if (row?.commission_to === null || row?.commission_to === undefined) return { known: false };
  return {
    known: true,
    commissionBps: Number(row.commission_bps) || 0,
    commissionTo: String(row.commission_to).trim().toLowerCase(),
  };
}

/**
 * 某行的抽成（**三态**）：`bigint`，或 **null = 条款快照未回填 ⇒ 不知道**。
 * 契约与 `feeOfRow` 完全一致（调用方拿到 null 时如实报未知，不要印 0）。
 */
export function commissionOfRow(baseWei, row) {
  const s = commissionSnapshotReadOf(row);
  return s.known ? commissionOf(baseWei, s.commissionBps, s.commissionTo) : null;
}

/**
 * 建草稿时写入**抽成条款快照**（`commission_bps` / `commission_to`）。
 *
 * 为什么可以在这里写、而平台费不行：抽成条款来自**本店自己的店铺记录**（本地已知，
 * 就是顾客在结账页看到的那一份），不必等链上回读；而平台费率与收取方是**全局合约状态**，
 * 只有 `Escrow.getOrder` 的创建时快照才是权威（本地读全局值会与在途单的口径打架）。
 *
 * 与平台费快照同一套三态：`known:false`（读不到条款）⇒ 写 **NULL** = 未知，
 * **绝不写 0**——"未知"与"确证不抽成"在净额上必须长得不一样（零地址才是"确证不抽成"）。
 * 只写这两列，绝不碰 `fee_bps` / `fee_collector_at_create`（那两列由链上补录负责）。
 * @param {{run: Function}} db 查询门面
 * @param {number} orderId 订单内部键（`orders.id`）
 * @returns {boolean} 是否写入了确证值
 */
export async function writeCommissionSnapshot(db, orderId, commissionSnap) {
  const c = commissionSnap && commissionSnap.known ? commissionSnap : { commissionBps: 0, commissionTo: null };
  /*
    ⚠️ 写的是**报价列**（`commission_quoted_*`），不是链上镜像列（`commission_*`）。
    这两列是两个事实：本函数在**建草稿**那一刻调用（= 我们向买家报的条款），
    而链上镜像列由 `/paid`、watcher、`/sync` 三处按 `Escrow.commissionTermsAtCreate` 回填
    （= 链上真正执行的那一份）。原先两者写同一列 ⇒ 链上值一到就把报价冲掉，
    于是"买家签进链上的条款与我们报的不一样"这件事在库里再也比不出来（2026-10-15 修）。
  */
  await db.run('UPDATE orders SET commission_quoted_bps = ?, commission_quoted_to = ? WHERE id = ?', c.commissionBps,
    c.commissionTo || null,
    orderId);
  return !!c.commissionTo;
}

/* ── 成交条款读数（**下单那一刻的快照**，多店改造新增）────────────────────────── */

/**
 * 「这一单成交时的抽成条款」读数 —— **唯一实现**。
 *
 * ⚠️ 它与 `orderTermsOf(shopRow)`（`shops` 表那两份**在售**列）回答的是**两个不同的问题**，
 * 绝不可互相替代（这是本仓最贵的一类静默错账）：
 *   · 本函数　= `commission_bps` / `commission_to` 两列（链上 `commissionTermsAtCreate` 的镜像，
 *     由 `/paid`、watcher、`/sync` 从链上补录）⇒「买家付款那一刻谈定、链上 `_settle` 照着执行」
 *     的那一份，**已成交的钱按它分**；
 *   · 在售列 = 此刻的条款，是给**下一单**报价用的。店铺换过条款的订单，两者必然不同
 *     （先 5% 成交、两周后改成 8% 的单，用 8% 复算净额 ⇒ 店主对账时账上凭空少一截，
 *      而对账脚本若也用 8%，两边同错、永远查不出来）。
 *
 * 三态与 `feeSnapshotReadOf` **完全同款**：`commission_to` 为 NULL = 从未补录 = **未知**
 * （当成 0 就是替链上宣布"这单没抽成"）；非 NULL = 已知（零地址 = 确证不抽成）。
 * @param {object} row 订单行（需 `commission_bps` 与 `commission_to`）
 * @returns {{known:false} | {known:true, bps:number, payee:string}} payee 小写地址（零地址 = 确证不抽成）
 */
export function commissionTermsReadOf(row) {
  const s = commissionSnapshotReadOf(row);
  return s.known ? { known: true, bps: s.commissionBps, payee: s.commissionTo } : { known: false };
}

/**
 * 某行的**报价条款**读数（三态，`{ known:false }` = 从没报价过）。
 *
 * 与 `commissionTermsReadOf`（链上镜像）是**两个不同的问题**：
 *   · 本函数 = "我们当时向买家报的是多少"（建草稿那一刻写一次，此后不变）；
 *   · 那一个 = "链上 `_settle` 实际会按多少分"（买家签名携带、链上快照）。
 * 两者不一致就是"这份订单的抽成腿被买家改了"——见 src/chainOrder.js 的 `termsMismatchOf`。
 */
export function quotedCommissionReadOf(row) {
  if (row?.commission_quoted_to === null || row?.commission_quoted_to === undefined) return { known: false };
  return {
    known: true,
    bps: Number(row?.commission_quoted_bps) || 0,
    payee: String(row.commission_quoted_to).trim().toLowerCase(),
  };
}

/**
 * 订单的**四腿读数**（毛额 / 平台费 / 节点抽成 / 卖家实收）—— 面板与对账的**唯一实现**。
 *
 * 为什么必须是一个函数而不是四处各写一遍算术：净额在链上是
 * `sellerNet = (amount − refundWei) − fee − commission`（`Escrow._settle`，两腿各自下取整、
 * 余数归店主）。链下有 **四个**消费方（卖家流水、订单详情金额卡、导出 CSV、dev 对账），
 * 每一个都要用到同一个中间结果；谁少减一条腿，谁就报出一个**比链上多的数**，
 * 而"面板说入账 X、钱包少了 Y"是店主唯一无法自行排查的那类事故。
 *
 * 三态：任何一个输入读不到（毛额/已退买家非十进制串、快照未补录）⇒ `ok:false`，
 * **不给任何数**——`amountWeiNet` 印 `—`，不印一个偏大的数。
 *
 * 金额列的**形状**（2026-10 重设计）：`amount_wei`（orders）、`refunded_amount_wei`
 * 与两个授权额（order_chain）都是 `DECIMAL(38,0)`，驱动以**字符串**返回（38 位 wei 过不了
 * JS 的数字）——所以下面一律走 `BigInt(...)`，不做任何 `Number(...)` 折算。
 *
 * @param {object} row 订单行（`amount_wei` / `refunded_amount_wei` / `fee_*` / `commission_*`；
 *        `v_orders` 把三张表的这些列合在一起，读模型行直接可用）
 * @returns {{ok:false, reason:string} | {ok:true, basisWei:string, feeWei:string|null, commissionWei:string|null, netWei:string|null, feeKnown:boolean, commissionKnown:boolean}}
 *   `basisWei` = 结算基数 = 毛额 − 已退买家（**确证**：两个输入都是十进制串才有这个读数）；
 *   `feeWei` / `commissionWei` 为 null ⇒ 那一条腿的条款快照没补录（下限 0、上限未知）；
 *   `netWei` 为 null ⇒ 两条腿里至少一条未知 ⇒ **净额不可说**。
 */
export function settlementReadOf(row) {
  /*
    三态判据必须显式，不能靠 `BigInt(...)` 抛错来兜底（2026-10 修）：
    `BigInt('')` 等于 `0n` 而**不抛错**，`refunded_amount_wei ?? '0'` 还会把 NULL 读成
    "确证没退过款"——于是同一行里出现 `refundedAmountWei: null`（三态）与一个按"没退过款"
    算出来的净额，两个读数互相矛盾，而店主看到的是那个偏大的数。
    空串/NULL/非十进制 一律 = **读不到**（不是 0）。
  */
  const dec = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!/^\d+$/.test(s)) return null;
    return BigInt(s);
  };
  const amounts = (() => {
    const gross = dec(row?.amount_wei);
    const refunded = dec(row?.refunded_amount_wei);
    if (gross === null || refunded === null) return null; // 读数畸形 ⇒ 不给数
    const basis = gross > refunded ? gross - refunded : 0n;
    return { basis };
  })();
  if (!amounts) {
    return {
      ok: false,
      reason:
        '本单金额读数缺失或畸形（托管毛额 / 已退买家不是十进制 wei 串）：平台费、节点抽成与实收净额都算不出来，一律显示 —，请刷新或改用链上直查核对。',
    };
  }
  const basis = amounts.basis;
  const fee = feeOfRow(basis, row);
  const commission = commissionOfRow(basis, row);
  return {
    ok: true,
    basisWei: basis.toString(),
    feeWei: fee === null ? null : fee.toString(),
    commissionWei: commission === null ? null : commission.toString(),
    netWei: fee === null || commission === null ? null : (basis - fee - commission).toString(),
    feeKnown: fee !== null,
    commissionKnown: commission !== null,
  };
}

/** 仅供测试：清空缓存（含"最后一次成功读数"——用例之间不得互相看见对方的读数） */
export function resetFeeCache() {
  cache = { at: 0, addr: null, known: false, lastOk: null };
}
