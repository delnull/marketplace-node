/**
 * Escrow 事件轮询器：定时从链上拉取托管事件，将本地订单状态推进为权威值。
 *
 * 事件 → 本地状态（仅当订单存在且前置状态匹配时迁移，防止回退）：
 *   OrderCreated        draft     → escrowed
 *   ReceiptConfirmed    escrowed/shipped/disputed → confirmed（买家确认收货；争议中=买家撤诉放款）
 *   DisputeRequested    escrowed/shipped → disputed（买家发起争议）
 *   Arbitrated          disputed  → refundWei == amount ? refunded : settled
 *                       （**拆分结算**：refundWei 退买家、余额扣费后判卖家，两者都发生在同一笔里，
 *                        所以状态由退款额决定而不是由"谁赢了"决定；见 settleByRefundSplit）
 *   OrderExpiredReleased draft/escrowed/shipped → expired（超时释放给卖家，refundWei 恒 0）
 *   RefundRequested     escrowed/shipped → 同状态 + refund_status=requested（两级售后第一级：
 *                       买家链上申请退款，资金冻结/超时释放被禁，等待卖家 approve/reject）
 *   RefundRejected      escrowed/shipped → 同状态 + refund_status=rejected（卖家拒绝，
 *                       买家获得 requestDispute 资格——第二级入口；合约不接受被拒后重复申请）
 *   PartialRefundAccepted escrowed/shipped/disputed/… → **状态不变**，只把买家授权的部分退款额
 *                       写进 accepted_partial_refund_wei（授权不转移资金、不冻结订单，见下）
 *   RefundApproved      escrowed/shipped/disputed → refunded（refundWei == amount 全额退回买家，
 *                       或争议中和解）/ settled（refundWei == 买家授权额的部分退款）
 *                       （合约 2026-09 收紧：approveRefund 只接受「全额」或「acceptedPartialRefund
 *                       里买家精确授权过的那个数」，其它一律 `RefundAmountNotAccepted`——旧的
 *                       `RefundNotFull` 已删除。卖家退部分金额**必须**先拿到买家对那个数字的授权，
 *                       而拆分裁决（任意比例、无需授权）仍只归仲裁人票决 `voteSettlement(orderId, refundWei)`
 *                       （达到当届阈值的那一票执行结算）。
 *                       占位仅回补「从未交付」的行——交付后退款视为货在买家侧需线下回收，
 *                       不自动回补，与 shipped→expired 不释放同口径）
 *   AfterSaleOpened     **状态不变**（confirmed/settled/expired 依旧），只置 after_sale_status=open
 *                       + 开案时刻/区块（确认收货后的售后案件；契约 2026-10 第二批）
 *   AfterSaleClosed     **状态不变**，置 closed + 结案时刻/说明（事件里的 note，截断见 afterSale.js）
 *
 * 两级售后为链上强制流程（合约状态机），本地 refund_status 仅为其镜像：
 * 迁移失败（changes=0）的事件不记录事件史，幂等重复扫描不重复记账。
 *
 * 售后案件（AfterSaleOpened/Closed）同样只是**叠加在终局之上的第二层**镜像：确认收货后货款先进入
 * Escrow 售后留存期；案件在途时不释放留存货款，赔付优先从留存出、不足才由 Staking 罚没。
 * 因此这两个分支刻意**不碰 orders.status**（见 src/afterSale.js 文件头的完整理由）；
 * 人工 /sync 与后台对账按链上 afterSaleOpen/afterSaleOpenedAtBlock 回填同几列，判据同源。
 *
 * ⚠️ 上表的 from 集是**正常路径**；代码里每个分支的 from 集都更宽，用来收敛"节点停机/漏扫"
 * 留下的残镜像（`draft`/`cancelled` 也接受，否则这些单会永远停在非终态、卖家流水漏计）。
 * 以 `applyEventCore`（`case 'ReceiptConfirmed'` / `case 'OrderExpiredReleased'` 里的 FROM_SET）
 * 与 `settleByRefundSplit` / `markEscrowDisputed` 里的实际集合为准。
 *
 * ## 表与键（2026-10 MySQL 重设计后本模块最容易写错的两处）
 *
 * 订单拆成三张：`orders`（事实/履约）、`order_shipping`（个人信息）、`order_chain`
 * （**链上镜像，本模块独占写**）。于是：
 *   · **状态列与链上镜像列不再同一张表**：`orders.status` / `orders.updated_at` 在一张，
 *     `paid_tx_hash` / `refund_status` / `refund_requested_at` / `refunded_amount_wei` /
 *     `accepted_partial_refund_wei` / `after_sale_*` / `events` 在另一张。**刻意不用多表 UPDATE
 *     一并写**：多表 UPDATE 的 `affectedRows` 是**两表命中行数之和**（实测：命中一对 = 2，
 *     连"值未变"也是 2），全仓 `changes === 1` 那套守卫在它上面直接失效
 *     （db.js 的 assertChangesSemantics 钉住的是单表语义）。所以每个分支先按 `orders.id`
 *     写状态（`changes` 恰好 0/1，幂等守卫就挂在它上面），再按 `order_id` 写镜像列，
 *     两者在同一个事务里成对落定。
 *   · 行里**没有 `id`**：内部键是 `orders.id`（本模块一律叫 `order_id`），对外标识是
 *     `orders.order_no`（URL/通知/日志里用的那个）。事件只带**链上单号**，所以每次都要先由
 *     `localRowOf` 换算出 `order_id`（见那里的说明），子表与 order_chain 的写入一律用它。
 *
 * ## 游标与进程状态的去向（原先散在 kv 的四个字符串键上）
 *
 * 全部落在 `node` 单例行（`CHECK (id = 1)`，由 db.js 的 initDb() 在启动期建立）：
 *   · `watcher_block` / `watcher_hash` —— 游标与重组检测基准；
 *   · `auto_flush_pending` —— 本轮未追平链头（追赶回放抑制了自动交付）的收尾冲刷标记；
 *   · `quarantined_events` —— 连续失败、需人工介入的隔离事件清单（真 JSON 列，默认 `'{}'`，
 *     形状是"指纹 → 条目"的对象，见 quarantineEntriesOf）。
 * 为什么集中成 `nodeRow()` 一次读 + 三个只写自己那几列的写口：状态原先经 `kvGet/kvSet`
 * 各处自行拼字符串，"读到的到底是什么"在每个调用点各判一次；集中之后列的语义只有一个落点。
 * **NULL 表示"还没有游标"，不是 0**——0 是合法的创世块高度，混同会让"从未扫过"与"扫到了第 0 块"
 * 再也分不开；`watcher_hash` 同理（NULL = 没有可比的基准，空串在这个列上已不可表达）。
 * 行不存在时**直接抛错**（见 pollOnce）：那意味着游标没有地方记账，不能静默继续。
 *
 * 说明：
 *  - BTY EVM 主网无可靠的公共 WebSocket，事件轮询（eth_getLogs 按块区间）是稳妥路径；
 *  - 首次启动默认从"当前最新块"开始，若担心漏扫历史事件，
 *    配置 MK_ESCROW_START_BLOCK = Escrow 合约部署块高度；
 *  - 同一轮询内事件按 (blockNumber, logIndex) 排序后逐个应用，状态迁移顺序与链一致。
 */
import config from './config.js';
import { getDb, withTransaction } from './db.js';
// node 单例行的唯一读入口（行由 db.js 的 initDb() 在启动期建立）
import { nodeRow } from './shops.js';
// fetchOnchainOrder：非 OrderCreated 事件的「链上真值预取」（防诱饵单，见 pollOnce 头部说明）——
// **必漏不可**：少了它，pollOnce 里那句 await 会抛 ReferenceError 被当成"链上真值未取到"，
// 于是**所有**退款/争议/仲裁类事件每轮失败、回退重扫 3 次后被隔离，链上镜像静默停摆。
import { getEscrow, getProvider, fetchOnchainOrder, invalidateCommitteeCache } from './chain.js';
// `chainParamsMatch` 住在 chainOrder.js——那里是「链上真值 → 要不要动钱/发货」这类判据的
// 唯一实现地；本文件的轮询与 chainReconcile、三个交付入口共用同一份（见 chainOrder.js 的说明）
import { chainParamsMatch } from './chainOrder.js';
import { tryAutoDeliverByEscrowOrder, flushAutoDeliverPending } from './autoDeliver.js';
// `deliveredItemsSql` / `isDelivered`：「这一单的货交出去了没有」的唯一判据与**唯一列名**
// （见 stockHold.js——列名写错会当场抛错，因为静默判成"未交付"就是把已发出的货回补占位 ⇒ 超卖）
import { releaseHoldsForOrderIds, releaseHoldsForReturnReceived, releaseRefundedEscrow, isDelivered, restockOrder, deliveredItemsSql } from './stockHold.js';
// 状态迁移的**唯一认领内核**：迁移与"迁移前是什么状态"必须同一把行锁（见文件头）
import { claimOrderState } from './orderTransition.js';
import { notify, notifyRaw, typeForChainEvent } from './webhook.js';
import { alertPoolEmptyForOrder } from './poolAlert.js';
// 一次性告警的「投递成功才留下幂等标记」（唯一实现；见 alertAck.js）
import { alertOnceDelivered } from './alertAck.js';
// 确认收货后的售后案件：本地镜像的**唯一写入口/判据**（事件路径、/sync、后台对账三者同源）
import { applyAfterSaleOpened, applyAfterSaleClosed } from './afterSale.js';

/* ─────────────────── node 单例行的写口（读只有 nodeRow 一处）─────────────────── */

/**
 * 游标落库。`hash` 传 null = 没有可比的基准（哈希读取失败 / 刚回退重扫）——
 * 这一列的空值语义就是 NULL：写空串会让"读不到"与"该高度没有哈希"同形。
 * `updated_at` 显式写（列没有 ON UPDATE），它是运维判断"这台节点的链上进度最后一次动是什么时候"的依据。
 */
async function setWatcherCursor(block, hash) {
  await getDb().run(
    'UPDATE node SET watcher_block = ?, watcher_hash = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1',
    block,
    hash || null
  );
}

/** 追赶收尾冲刷标记（1 = 本轮扫描未追平链头，追平后要补一次自动交付冲刷） */
async function setAutoFlushPending(on) {
  await getDb().run('UPDATE node SET auto_flush_pending = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1', on ? 1 : 0);
}

/**
 * 隔离清单落库（`node.quarantined_events`）。
 *
 * 形状是"**指纹 → 条目**"的**对象**（DDL 默认值就是 `'{}'`）：指纹（`block:index:name:orderId前缀`）
 * 就是键，条目里不再重复存它。为什么不是数组：条目要能按键直接摘除/更新（成功即摘除、
 * 失败即覆盖），数组做同样的事得自己扫一遍；更坏的是"往数组上挂非索引属性"这种写法在 JS 里
 * 能跑，而 `JSON.stringify(数组)` **只序列化索引元素**——隔离记录会被静默丢光，失败事件于是
 * 无限重试。形状与用法必须同形。
 * JSON 列由驱动解析成 JS 值返回（见 db.js 的连接选项），所以读出来是对象本身——
 * 再 `JSON.parse` 一次会抛错并被吞掉，整份清单会被**静默清空**。
 */
function quarantineEntriesOf(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

async function setQuarantinedEvents(byFp) {
  const entries = Object.entries(byFp)
    .sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0))
    .slice(-FAILED_EVENTS_MAX); // 超出上限丢最旧（防无界增长）
  await getDb().run(
    'UPDATE node SET quarantined_events = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1',
    JSON.stringify(Object.fromEntries(entries))
  );
}

/** 单轮扫描区块数上限（BTY 5 秒/块，2000 块 ≈ 2.8 小时；防 RPC 单次超时） */
const SCAN_LIMIT = 2000;
/**
 * 检测到重组（游标块哈希不一致）时的回退重扫深度：64 块 ≈ 5 分钟，覆盖常见短重组。
 * 2026-09 复核：原 20 块在「贴链头 + 深度 >20 块重组」场景下回退不足——先前已应用的
 * 终局事件（如 RefundApproved）可能在新分叉上不存在而本地镜像滞留终态；64 块覆盖
 * 更深的短重组（BTY 平均出块 5s，超深度重组需 5 分钟以上，概率极低；事件史/对账
 * 仍可人工兜底）。回退只多拉一段日志（幂等重扫），成本可忽略。
 */
const REORG_REWIND_BLOCKS = 64;
/**
 * 同一事件的最大重试轮数（源码审计 2026-09 修复「坏事件永久钉死游标」）：
 * 事件应用失败会把游标回退到该事件前一块重扫（确定性重试）。但若该事件**每轮都失败**
 * （ABI 漂移、脏数据、唯一键冲突），回退 + `to = min(latest, from + SCAN_LIMIT)` 会让扫描窗口
 * 永远停在 `failedFrom + 2000`——链头越过该窗口后，**其后所有订单事件再也不会被拉取**
 *（镜像静默停摆），且 `behind` 恒为 true 令自动交付被永久抑制。
 * 故同一事件连续失败到上限后转入「隔离」：本窗口跳过它继续推进。隔离清单持久化在
 * `node.quarantined_events` 并经 /healthz 暴露（事件不静默消失：每轮告警 + 清单可查 + 可人工处理后清理重放）。
 */
const MAX_EVENT_RETRIES = 3;
/** 隔离清单条目上限（防无界增长；超出丢最旧，见 setQuarantinedEvents） */
const FAILED_EVENTS_MAX = 50;

/**
 * 原始 JSON-RPC 只读调用（块哈希读取专用）：BTY 主网区块含系统交易（to=0x16 的奖励交易
 * nonce≈6e18），ethers v6 的 getBlock 解析会因 nonce 溢出崩溃——凡涉及区块对象的读取
 * 一律走原始 JSON-RPC：ethers 的区块解析会拒绝 BTY 主网的系统交易字段。
 * 2026-09 复核：显式 15s 超时——RPC 挂起（TCP 黑洞/节点无响应）时若无超时，轮询器将
 * 永久卡在重组检测上，订单状态回写与自动交付全部停摆（fetch 默认无超时）。
 */
async function rpc(method, params) {
  const res = await fetch(config.chain.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error?.message || JSON.stringify(j.error)}`);
  return j.result;
}

/** 读取指定块哈希：`undefined` = RPC 失败（调用方须与原「块不存在」区分对待），`null` = 块不存在 */
async function blockHashOf(height) {
  try {
    const b = await rpc('eth_getBlockByNumber', [`0x${BigInt(height).toString(16)}`, false]);
    return b && b.hash ? String(b.hash).toLowerCase() : null;
  } catch {
    return undefined;
  }
}

/**
 * 轮询器运行状态（供 /healthz 暴露，源码审计 2026-09：此前游标只存在 kv、进展只进控制台，
 * 「游标落后/事件隔离/轮询失败」在运维侧完全不可见——docker healthcheck 照样绿）。
 *
 * ⚠️ 从 2026-10-16 起它同时是 `/healthz` **健康判据的输入**（停滞或隔离数非零 ⇒ 503）。
 * 所以它导出：那条判据必须有一条**可控**的用例（把 `lastOkAt` 推到过去 ⇒ 断言 503）——
 * "停滞"在测试里等不出来（窗口下限 90 秒），而一个只有"健康那一半"被验证过的判据，
 * 等于没验证。测试用完必须还原（本对象是**进程级共享状态**，污染它会连累同进程的其它用例）。
 */
export const watcherStatus = {
  startedAt: 0,
  lastPollAt: 0,
  lastOkAt: 0,
  lastError: null,
  cursor: 0,
  latest: 0,
  lagBlocks: 0,
  lastScan: null,
  upToDate: false,
  quarantined: 0,
};

/** 追平链头后隔一轮重扫游标块（见 pollOnce 的链头分支）；进程级即可，重启后第一次追平仍会重扫。 */
let headRescanPending = false;

/** 只读快照（/healthz 与运维脚本用）。async：隔离清单现在是 `node.quarantined_events`
 *  这个真 JSON 列，读它要走库——同步实现会让这一格永远显示 0，
 *  而它正是"有多少条链上事件被隔离、需人工介入"的唯一读数（见 MAX_EVENT_RETRIES）。 */
export async function escrowWatcherStatus() {
  let quarantined = 0;
  try {
    const row = await nodeRow();
    quarantined = Object.keys(quarantineEntriesOf(row?.quarantined_events)).length;
  } catch {
    // 读不到（库没起来 / 那一行还没建）⇒ 0（与"确实一条都没有"同形，代价如实写：这一格会显示 0——
    // 但真正的隔离信号还有每一轮的 console.error 与 `lastError`，不靠这一格兜底）
    quarantined = 0;
  }
  return {
    configured: !!config.chain.escrowAddress,
    ...watcherStatus,
    quarantined,
    /** 落后链头是否已超过单轮扫描上限（= 追赶中；长期 >0 说明轮询跟不上或 RPC 受限） */
    lagBlocks: Math.max(0, Number(watcherStatus.lagBlocks) || 0),
  };
}

/**
 * 事件处理顺序（与状态机一致，合并后按块序应用）。
 *
 * **导出**（2026-09）：这条清单是"事件漏挂"这一整类缺陷的唯一入口——事件不在清单里，
 * `pollOnce` 就**永远不会**为它发 queryFilter，链上发生了、本地毫无痕迹且无任何报错。
 * 导出给单测逐项钉住（新事件必须同时进清单；删掉一行就会有用例变红），见
 * `test/partial-refund-consent.test.js`。运维侧 `/healthz` 不消费它（只读轮询状态）。
 */
export const EVENTS = [
  'OrderCreated',
  'ReceiptConfirmed',
  'DisputeRequested',
  'Arbitrated',
  'OrderExpiredReleased',
  'RefundRequested',
  'RefundRejected',
  // 买家对具体金额的部分退款授权（approveRefund 退部分金额的唯一合法来源）——
  // **漏挂即静默**：卖家面板永远看不到买家授权额，只能拿 RefundAmountNotAccepted 的 revert 试错
  'PartialRefundAccepted',
  'RefundApproved',
  /*
    结算后的售后退款 / 仲裁售后赔付都只发 SellerRefunded（且不改 getOrder.refundedAmount 之外的列）。
    漏挂它，本地净额、流水、看板、CSV 会永远按“未退款”算；/sync 读 getOrder 也补不到。
    refundedTotal 是含本次在内的累计值，按绝对值落库，重放不会重复加。
  */
  'SellerRefunded',
  // 确认收货后的**售后案件**（契约 2026-10 第二批，本地镜像见 src/afterSale.js）：
  // 开案/结案只写售后案件那几列，**不改 orders.status**（订单仍是 confirmed/settled/expired 终局——
  // 链上 Escrow.Order.status 全程停在 Settled，货款仍在售后留存期；改成本地 disputed
  // 会把仍在留存的货款重新算进在途窗口，见 afterSale.js 文件头）。
  // **漏挂即静默**：买家开了案、仲裁台队列里却没有这一单，而店主/仲裁人完全无从知道。
  'AfterSaleOpened',
  'AfterSaleClosed',
  /*
    提货争议（**不是订单状态事件**）：只把链上 `ClaimCase` 的结论写回 `nft_claims` 的
    dispute_* 列（开案/结案/撤销）。漏挂的代价是节点自己的提货声明永远停在"处理中"，
    而链上早已结案——店主/持有人都看不到结果。
  */
  'ClaimDisputeOpened',
  'ClaimVoted',
  'ClaimClosed',
  'ClaimDisputeCancelled',
  /*
    委员会治理事件（**不是订单事件**）：只让委员会缓存立即失效，不进 `applyEvent`。
    漏挂的代价是撤权/换届后旧名单继续通过仲裁人鉴权（读 PII 的详情与附件下载），
    最坏要等 60s 正缓存自然过期——所以它们与订单事件一样必须进这张清单。
  */
  'CommitteeUpdated',
  'ArbiterRevoked',
];

/**
 * 这条日志是否真的来自 canonical Escrow。
 *
 * `queryFilter` 的 `address` 过滤是**由 RPC 执行**的：ethers 把它翻译进 `eth_getLogs` 的 filter，
 * 却不会在返回后重新核对 `log.address`。一个错误的 RPC 实现（或伪造/被劫持的 RPC）可以返回
 * 任意合约的同 topic 日志，而 watcher 随后会按事件参数推进本地订单状态（退款/结算/发码）。
 * 所以把"发布者必须是托管合约"作为**本地判据**再验一次——与收据路径
 *（`routes/orders.js` 的 verifyPaidReceipt）和 `chain.shopRegisteredEventFromLogs` 同一条纪律。
 *
 * `removed=true` 是重组后撤销的日志；getLogs 正常不会返回，但既然要校验来源，就一并拒绝。
 * 只校验来源不校验区块头：RPC 仍是节点自己配置的信任源（同一份 RPC 也提供 getOrder），
 * 要防它整体作伪需要独立 RPC / 轻客户端，不在本函数的范围内。
 */
export function isCanonicalEscrowLog(log, escrowAddress) {
  if (!log || typeof log !== 'object') return false;
  if (log.removed === true) return false;
  const expected = String(escrowAddress || '').trim().toLowerCase();
  if (!expected) return false;
  return String(log.address || '').trim().toLowerCase() === expected;
}

/** 事件史上限（防单订单无限膨胀；20 条覆盖完整生命周期富余） */
const EVENT_HISTORY_LIMIT = 20;

/**
 * 链上单号 → 本地行（**本模块所有事件分支的入口读**）。
 *
 * 一次读带回落库与判定要用的全部列：状态在 `orders`、凭证与退款镜像在 `order_chain`，
 * 而每个分支都要用它判前置状态与幂等。每个分支各写一条 SELECT 迟早会漏列，而"漏列的读法"
 * 只得到 `undefined`——它与"没有这个事实"在判断里同形，于是一条分支会静默走错。
 *
 * 本节点没有这一单（Escrow 合约里的单**不限于本节点**：联邦里所有店共用同一个合约）⇒ 返回
 * `undefined`，调用方按"无事可做"返回 0（不建行、不猜）。
 */
async function localRowOf(db, escrowOrderId) {
  /*
    ⚠️ 这张 SELECT 是**所有事件分支共用的那一处取数**（见上方"每个分支各写一条 SELECT 迟早会漏列"）。
    所以它必须把下游要用到的每一列都取出来 —— 漏一列的后果不是"某个判断多了一次空值检查"，
    而是**那个事实从此读不到**：`shop_code` 漏过一次，直接导致 `order.hold_missing` 告警
    的 payload 里 `shopCode` 是 undefined ⇒ `webhookConfig(undefined)` 折成空键 ⇒
    投递**一次尝试都不发**就返回 false，而日志写着"未配置通知地址"（其实配了）。
    新增列时请回到这里补一行，而不是在分支里再查一次。
  */
  return await db.get(
    `SELECT o.id AS order_id, o.order_no, o.status, o.buyer, o.seller, o.shop_code, o.amount_wei, o.timeout_blocks,
            o.payment_token, c.paid_tx_hash, c.refund_status, c.refunded_amount_wei, c.accepted_partial_refund_wei
       FROM order_chain c JOIN orders o ON o.id = c.order_id
      WHERE c.escrow_order_id = ?`,
    String(escrowOrderId).toLowerCase()
  );
}

/**
 * 事件史追加：链上凭证（txHash/块号）落订单，供详情核对与仲裁溯源。
 *
 * 事件史是 `order_chain.events`（JSON 列）：**读-改-写必须在同一个事务里**，而本函数只在
 * `applyEventCore` 的事务里被调用（同一条纪律见 routes/orders.js 的 appendOrderCreatedEvent）
 * ——并发的 /sync 与 watcher 各自读到同一份旧数组、各自 push，后写的那一份会把对方那条事件
 * 整条盖掉（详情页的凭证链与信誉画像因此静默缺一条里程碑，而两边都返回成功）。
 *
 * `at` 是**毫秒读数**（不是 DATETIME 列）：事件史是应用自己写的 JSON 文档，它的形状由所有
 * 写者（本函数、routes/orders.js 的补写）与所有读者（前端 `OnchainEvent.at: number`、
 * reputation / buyerSignal / opsMetrics）共同决定——把库里 DATETIME 的 `Date` 口径套上去，
 * 前端的排序与展示会静默失效。
 */
async function recordEvent(escrowOrderId, ev) {
  const db = getDb();
  // FOR UPDATE：普通 SELECT 在 REPEATABLE READ 下看不到并发事务刚提交的事件；
  // 只把 UPDATE 关进事务并不能阻止两个写者用旧数组互相覆盖。
  const row = await db.get(
    'SELECT order_id, events FROM order_chain WHERE escrow_order_id = ? FOR UPDATE',
    escrowOrderId
  );
  if (!row) return;
  const list = Array.isArray(row.events) ? row.events.slice() : [];
  list.push(ev);
  const trimmed = list.length > EVENT_HISTORY_LIMIT ? list.slice(-EVENT_HISTORY_LIMIT) : list;
  await db.run('UPDATE order_chain SET events = ? WHERE order_id = ?', JSON.stringify(trimmed), row.order_id);
}

/**
 * 应用单条链上事件到本地订单（导出以便单测直接覆盖各状态迁移分支）。
 *  meta: { txHash, block, chainParams, skipAutoDeliver }——链上凭证与链上真值；迁移成功
 *  （changes>0）时追加进订单事件史。
 *
 * 原子性（审计 D2/D3 分组）：状态迁移 + 占位释放/恢复 + 事件史同属一个事务——
 * 防进程恰在「状态 UPDATE 已落库、释放/事件史未执行」之间中断：事件幂等重放时
 * 状态不再命中（changed=0），释放会被永久跳过 → 终局单占位滞留。单事件全事务后
 * 中断即整体回滚，游标回退重扫（N1）时事件完整重放。SAVEPOINT 嵌套：内部
 * release 系 / restock / autoDeliver 的事务自动降级为内层保存点。
 *
 * 副作用时序（源码审计 2026-09 修复）：webhook 通知与自动交付原在事务内发出——若后续语句
 * 抛错整体回滚，卖家已收到「订单已托管」而本地仍是 draft（回滚后重扫会再报一次）。
 * 现统一压入 meta.afterCommit，**COMMIT 成功之后**才执行（顺序与原先一致：先 order.escrowed，
 * 后自动交付的 order.shipped）；单个副作用抛错只告警，不影响已提交的状态。
 * 这些副作用里既有 `notify`（同步发起、fire-and-forget）也有链上复核 + 自动交付（真异步），
 * 所以提交后的循环逐个 `await`：不 await 的话它们的 rejection 会变成 unhandled rejection，
 * 而这段代码恰恰是"状态已落库、失败只影响通知"的那一层——错误必须落在它自己的 try 里。
 */
export async function applyEvent(name, args, meta = {}) {
  const after = [];
  const m = { ...meta, afterCommit: after };
  /* 状态迁移 + 占位释放/恢复 + 事件史**同一个事务**（`withTransaction` 的回调即作用域）。
     嵌套调用（release 系 / restock / autoDeliver 自己的事务）自动降级为 SAVEPOINT。 */
  const changed = await withTransaction(async () => applyEventCore(name, args, m));
  for (const fn of after) {
    try {
      await fn();
    } catch (e) {
      console.error(`[escrowWatcher] 提交后副作用失败（状态已落库，不影响一致性）: ${name}`, e?.message || e);
    }
  }
  return changed;
}

/**
 * 「链上已退买家金额」的**唯一判据**：读得到 → `bigint`（≥ 0），读不到 → `null`。
 *
 * 为什么必须把"读不到"与"确证为 0"分开（2026-10 生产化清理）：
 *   · `0n` 在这套语义里是一个**具体结论**——"从未退款 / 全额判卖家"（见 `mapChainTerminal`）；
 *   · 而字段缺失、ABI 漂移、脏字符串是**不知道**。用一个 0 去代表"不知道"，等于替链上说了一句
 *     它没说过的话：全额退款会被写成 `settled` + `refunded_amount_wei='0'`，**买家钱的下落记反**，
 *     而且对账脚本会认为"本地与链上一致"（两边同错，自证清白）。
 * 所以这里返回 `null`，调用方**必须**显式处理（不推进终态、不写金额、留下告警等下轮）。
 *
 * 输入通常是 `DECIMAL(38,0)` 的**字符串**（38 位 wei 过不了 JS 数字，见 db.js），
 * 所以下面一律走 `BigInt`：`0n` 与 `null` 的区别就是"确证没退过"与"读不到"的区别。
 */
export function readRefundedWei(v) {
  if (v === undefined || v === null) return null;
  /*
    ⚠️ 空串必须先挡掉：`BigInt('')` **等于 0n**（不是抛错），
    所以"字段是空白"会被悄悄读成"确证为 0"——正是这个函数要防的那种伪造。
  */
  if (typeof v === 'string' && v.trim() === '') return null;
  try {
    const n = BigInt(typeof v === 'string' ? v.trim() : v);
    return n >= 0n ? n : null; // 负数不是"没退过款"，是脏数据 ⇒ 不知道
  } catch {
    return null;
  }
}

/**
 * 链上终局（status + refundedAmount）→ 本地终态（**唯一实现**）。
 *
 * 链上状态本身无法区分"买家确认收货 / 超时释放 / 仲裁判付"（三者都是 Settled），
 * 所以不猜事件名：只有全额退回买家的才是 refunded，其余（含 refundedAmount = 0 = 全判卖家）一律 settled。
 *
 * 判据与链上 `Escrow._settle` 逐字一致：
 *   refundWei == amount → 状态 Refunded（全额退买家，不扣费）
 *   0 ≤ refundWei < amount → 状态 Settled（拆分结算或全额判卖家）
 * 而 `getOrder` 的 `refundedAmount` 正是那个 refundWei 的镜像，故快照路径（chainReconcile 兜底
 * 对账 / `POST /:id/sync` 手动同步）与事件路径必须共用本函数——否则同一笔单走事件回写还是走
 * 快照同步会得到两种说法（历史上 `/sync` 把 refundedAmount=0 的 Settled 落成 `confirmed`，
 * 而事件路径/对账落 `settled`；`confirmed` 的界面文案断言"你已确认收货"，而链上状态无从证明
 * 这个**买家动作**，只有真实 ReceiptConfirmed 事件才能证明）。
 *
 * **第三态（2026-10 生产化清理）**：返回 `null` = 判不了。此前"解析失败按 0 处理、永不抛错"，
 * 于是"不知道"被写成了"全额判卖家"——账目不可逆。现在只有在下列情况下才允许继续判：
 *   · 状态是 `Refunded`（状态自己就是结论）；
 *   · 状态是 `Settled`（合约语义：不是全额退款才发 Settled）——此时缺的只是**金额**，
 *     调用方必须按"读不到"处理（不许写 0）；
 *   · 两个金额都读得到（正常路径）。
 *
 * @param {string} chainStatus 链上状态名（'Settled' / 'Refunded' / ...）
 * @param {string|number|bigint} refundedAmountWei 链上已退买家金额
 * @param {string|number|bigint} amountWei 本单托管额（本地锁定值，链上真值经 chainParamsMatch 校验过）
 * @returns {'refunded'|'settled'|null}
 */
export function mapChainTerminal(chainStatus, refundedAmountWei, amountWei) {
  const st = String(chainStatus ?? '');
  if (st === 'Refunded') return 'refunded';
  const refunded = readRefundedWei(refundedAmountWei);
  const amount = readRefundedWei(amountWei);
  if (refunded === null || amount === null) return st === 'Settled' ? 'settled' : null;
  return amount > 0n && refunded >= amount ? 'refunded' : 'settled';
}

/**
 * 链上「按退款额拆分结算」→ 本地终态（RefundApproved / Arbitrated 共用，**唯一实现**）。
 *
 * 合约侧语义（Escrow._settle）：refundWei 退买家，余额 amount−refundWei 扣费后给卖家；
 *   refundWei == amount → 状态 Refunded（全额退款）
 *   refundWei <  amount → 状态 Settled（拆分：部分退款 + 部分结算，含 refundWei=0 全额判卖家）
 * 本地镜像必须与之一致：全额退 → 'refunded'；拆分/判卖家 → 'settled'。两者都记
 * `refunded_amount_wei`（净额 = amount − refunded；零费模型下没有第三腿，UI 据此展示拆分）。
 *
 * 两列分住两张表（状态在 `orders`、金额与退款标记在 `order_chain`）：先写状态
 * （`changes` 精确 0/1，幂等守卫与"钱的下落"判定都挂在它上面），确认迁移发生后再写镜像列
 * ——反过来会出现"状态没动、金额却改了"的中间态，而那一刻的账本净额会按"没退过款"算。
 *
 * @param {{get: Function, run: Function}} db 查询门面
 * @param {string} orderId 链上托管单号
 * @param {string|number|bigint} refundWeiArg 事件里的退款额（**必填**：读不到即抛出，不再有"缺失按全额判卖家"的兼容路径）
 * @returns {number} 受影响行数（0 = 未命中可迁移的行 / 本节点没有这一单）
 * @throws 退款额或本地托管额读不到时抛出（**不落终态**，由调用方的失败/重试机制接管）
 *
 * 导出：链上状态对账（chainReconcile）的终局修复走**同一个函数**——对账若自己写一份
 * "链上 Refunded/Settled → 本地状态 + refunded_amount_wei + 占位回补"的映射，
 * 两处迟早会漂移（这正是本仓库反复强调的"唯一实现"）。
 */
/**
 * 写 `order_chain.refunded_amount_wei` 的**唯一出口**（事件/快照路径共用）。
 *
 * 契约：这个数是"买家**累计**已受偿"，不是"本次结算退了 Friendly 多少"。
 *   · 超过托管额 ⇒ 拒绝（否则视图 `amount_net_wei` 会变成负数，流水出现负净额）；
 *   · 只增不减（`GREATEST`）⇒ 重放 `Arbitrated`（事件里是结算时刻的 refundWei）不能把
 *     之后 `SellerRefunded` 写大的累计值改小；隔离事件"修好根因后重放"也不再制造金额回退。
 *
 * @returns {Promise<number>} changes（0 = 值未变/超界被拒）
 */
export async function setRefundedAmount(db, orderId, amountWei, totalWei) {
  const amount = readRefundedWei(amountWei);
  const total = readRefundedWei(totalWei);
  if (amount === null || total === null) return 0;
  if (total > amount) return 0;
  const totalText = total.toString();
  const result = await db.run(
    `UPDATE order_chain
        SET refunded_amount_wei = GREATEST(COALESCE(refunded_amount_wei, 0), ?)
      WHERE order_id = ? AND (refunded_amount_wei IS NULL OR refunded_amount_wei <> ?)`,
    totalText,
    Number(orderId),
    totalText
  );
  return result.changes;
}

export async function settleByRefundSplit(db, orderId, refundWeiArg) {  const local = await db.get(
    `SELECT o.id AS order_id, o.amount_wei
       FROM orders o JOIN order_chain c ON c.order_id = o.id
      WHERE c.escrow_order_id = ?`,
    String(orderId).toLowerCase()
  );
  if (!local) return 0;
  const amount = readRefundedWei(local.amount_wei);
  const refunded = readRefundedWei(refundWeiArg);
  if (amount === null || refunded === null) {
    /*
      **退款额读不到 ⇒ 一个字都不写**（2026-10 生产化清理）。
      这个字段就是"全额退买家 还是 拆分/全额判卖家"的**唯一依据**——按 0 兜底会把全额退款写成
      settled + refunded_amount_wei='0'，买家钱的下落就此记反（不可逆，且事后两边同错）。
      这里**抛出**而不是返回 0：0 会被上游当成"没有需要迁移的行"，事件照旧算处理完成、游标继续前进，
      那一单就永远停在非终态、也不会再有人来修。抛出则进 `applyEvent` 既有的失败处理
      （记重试 → 连续失败转持久化隔离清单 + 每轮告警），下一轮带着健康的读数再来一次。
      真实链上事件经 ABI 解码必然带 refundWei；**没有"字段缺失就按全额判卖家"这条兼容路径了**
      （旧版 `refundToBuyer=false` 的语义已随合约删除）。
    */
    throw new Error(
      `退款额读不到（refundWei=${String(refundWeiArg)}，本地 amount=${String(local.amount_wei)}）：不落终态`
    );
  }
  // 与 `mapChainTerminal` 的关系：两者**同一判据**（amount > 0 && refunded >= amount → refunded），
  // 事件路径直接用事件里的 refundWei（信息更全：不必等 getOrder 快照），快照路径只有
  // status + refundedAmount 两个字段，故走 mapChainTerminal。改判据时必须同时改这两处，
  // 否则「同一笔单走事件回写 vs 走兜底同步」会得到两种本地终态。
  const fullRefund = amount > 0n && refunded >= amount;
  const status = fullRefund ? 'refunded' : 'settled';
  /*
    **迁移与"要不要补占位"必须共用同一把行锁**（2026-10-31 并发收口）：
    旧实现先普通 SELECT 拿 `local.status`，再用它决定是否 restock；草稿清扫器/买家取消
    可能在两次语句之间提交，UPDATE 命中 `cancelled` 成功后分支仍看旧 `draft`，占位永久漏补。
    `claimOrderState` 在事务内 `SELECT ... FOR UPDATE`，`from` 就是本次认领的前一状态。
  */
  const { changed, from } = await claimOrderState(
    db,
    local.order_id,
    ['draft', 'cancelled', 'escrowed', 'shipped', 'disputed', 'expired'],
    status
  );
  if (changed > 0) {
    await db.run("UPDATE order_chain SET refund_status = 'none' WHERE order_id = ? AND refund_status <> 'none'", local.order_id);
    await setRefundedAmount(db, local.order_id, amount, refunded);
    if (fullRefund) {
      // 全额退款：占位按「未交付行」口径回补（已交付后退款视为货在买家侧，需线下回收，防超卖）
      await releaseRefundedEscrow(orderId);
    } else {
      // 拆分/判卖家：成交向终态——已交付行若退货已确认收货/放弃追索则回补占位（D1 口径）
      await releaseHoldsForReturnReceived(orderId);
      /*
        取消时占位已经释放；链上随后才结算给卖家（拆分/判付）时，本地不能继续把这件货
        标成“可再售”。补占位失败只告警（资金已上链，订单必须收敛），由店主核账扩容。
      */
      if (from === 'cancelled' && !(await restockOrder(local.order_id))) {
        console.error(
          `[escrowWatcher] 恢复已取消订单 ${String(local.order_id).slice(0, 8)}… 的库存占位失败（限量库存不足），请店主核账扩容`
        );
      }
    }
  }
  return changed;
}

/**
 * 链上 Disputed → 本地 disputed（**唯一实现**）：DisputeRequested 事件与链上状态对账
 * （chainReconcile 按 getOrder 的 Disputed 修复滞留单）共用同一 SQL/from 集，
 * 防两处条件漂移导致「事件能改、对账改不动」（或反之）的静默分歧。
 *
 * from 集含 `cancelled`（源码审计 2026-09 补齐）：终局路径（Refunded/Settled/Expired）
 * 早就接受 cancelled 残镜像，冻结路径却漏了它——于是"买家在草稿被清扫/取消之后才完成支付"
 * 这一竞态留下一个死角：只要 `OrderCreated` 那次扫描也漏了（RPC 抖动/进程停机），
 * 买家随后申请退款、被拒、发起争议时，本地行会**永远停在 cancelled**，
 * 而链上那笔钱已经真的被冻结在 Disputed 里。
 *
 * **从 cancelled 复活必须把库存占位补回来**（2026-10-22 复审）：取消流程释放过占位，
 * 只改状态会让同一件货同时"可再售"又"已有在途单"（争议判给卖家即超卖）。见函数体内说明。
 * @returns {number} 受影响行数（0 = 未命中可迁移的行 / 本节点没有这一单）
 */
export async function markEscrowDisputed(db, orderId) {
  const local = await db.get(
    'SELECT o.id AS order_id, o.order_no, o.shop_code FROM orders o JOIN order_chain c ON c.order_id = o.id WHERE c.escrow_order_id = ?',
    String(orderId).toLowerCase()
  );
  if (!local) return 0;
  /*
    **先认领迁移，再补占位**（顺序是判据，不是风格）。

    两条路径（watcher 的 DisputeRequested 与 /sync、后台对账）可能同时处理同一单：先做
    `UPDATE ... WHERE status IN (...)` 拿到 changes=1 的那一方才是"这次真的把它推进了"的人。
    反过来的顺序（先补占位、再迁移）会在输掉竞争的调用点留下一笔**属于终局的**占位：
    例如另一条路径刚把它判成 refunded，这里却因为读到的是旧 status=cancelled 而先占了位——
    库存被一件已经退款的单永久占住（商品看起来卖光了）。`restockOrder` 自身的
    `released_at IS NOT NULL` 认领只能防重复，防不了"为不该占的单占位"。
  */
  const { changed, from } = await claimOrderState(
    db,
    local.order_id,
    ['draft', 'escrowed', 'shipped', 'cancelled'],
    'disputed'
  );
  if (changed === 0 || from !== 'cancelled') return changed;
  /*
    **从 cancelled 复活必须把库存占位补回来**（2026-10-22 复审）。

    取消（草稿清扫/买家取消）时占位已经释放；而"订单已取消、链上却已支付、`OrderCreated` 又漏扫"
    是真实竞态，其后的第一手链上事实可能是 Disputed（买家已申请退款/发起争议）。旧实现只把
    状态推成 disputed，却不碰占位——于是这件商品同时"可再售"又"已有在途单"，一旦争议判给卖家
    就是一次超卖，而 Created 恢复分支（`restockOrder` + 告警）早就做了同一件事。
    占位恢复失败**不阻断争议推进**：钱已经冻在链上，本地状态必须先与链上一致；差额交给店主核账，
    与 Created 分支同一口径（那里是 `abortTx`，因为那时钱还在托管里、可以拒绝恢复）。
  */
  if (!(await restockOrder(local.order_id))) {
    console.error(
      `[escrowWatcher] 复活争议单 ${String(local.order_no).slice(0, 8)}… 的库存占位失败（限量库存不足），请店主核账扩容`
    );
    try {
      await alertOnceDelivered({
        orderId: local.order_id,
        kind: 'hold_missing',
        label: '[escrowWatcher]',
        what: `（order.hold_missing，order=${String(local.order_no).slice(0, 8)}…，争议复活时占位失败）`,
        send: () =>
          notifyRaw('order.hold_missing', {
            // shopCode 必填：webhook 按它选店（缺了会一次都不投递，见 Created 分支的同款说明）
            shopCode: local.shop_code,
            orderId: local.order_no,
            escrowOrderId: orderId,
            reason: '订单取消后链上才进入争议，本地复活时库存占位失败（限量库存已被他人买走）——请核对商品余量并扩容或退款处理',
          }),
      });
    } catch {
      /* 告警失败不影响状态推进（console 已留痕） */
    }
  }
  return changed;
}

/**
 * 买家「已授权的部分退款额」→ 订单列（**唯一实现**）。
 *
 * 两条路径共用本函数：事件路径（`PartialRefundAccepted` 分支）与快照路径
 * （`POST /:id/sync` 读链上只读视图 `acceptedPartialRefund(orderId)` 兜底）——
 * 各写一份 SQL 迟早漂移（一边写 updated_at、一边不写；一边容忍脏值、一边不容忍），
 * 而这一列是卖家给出"链上真的会接受的退款金额"的唯一依据（契约 2026-09：
 * `approveRefund` 只接受「全额」或 `acceptedPartialRefund[orderId]`）。
 *
 * 口径：
 *  - 只写 `order_chain` 这一列、**不迁移状态、不动 `orders.updated_at`**（授权不转移资金、
 *    不冻结订单；且 updated_at 是统计窗口与列表排序的依据，迟到的事件不该把行挪进更晚的窗口）；
 *  - 幂等：值与本地相同时 changes=0（重扫/重复同步不产生噪音写，也不重复记事件史）；
 *  - 解不出金额（ABI 漂移/字段缺失/脏值）时返回 0 且**保持本地原值**——绝不写 '0'
 *    （那等于断言"买家从未授权"，会抹掉面板上一条有效授权），也绝不写假数字。
 *
 * @param {string} orderIdHex 链上托管单号
 * @param {string|number|bigint} acceptedWei 授权额（0 = 未授权）
 * @returns {Promise<number>} 受影响行数（0 = 无该单 / 值未变 / 不可解析）
 */
export async function applyAcceptedPartialRefund(orderIdHex, acceptedWei) {
  const raw = acceptedWei;
  let wei = null;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    try {
      wei = BigInt(raw).toString();
    } catch {
      wei = null;
    }
  }
  if (wei === null) {
    console.warn(
      `[escrowWatcher] 忽略无法解析的授权额（orderId=${String(orderIdHex).slice(0, 18)}… acceptedWei=${JSON.stringify(raw)}）：保持本地原值`
    );
    return 0;
  }
  return (await getDb().run(
    'UPDATE order_chain SET accepted_partial_refund_wei = ? WHERE escrow_order_id = ? AND accepted_partial_refund_wei <> ?',
    wei,
    String(orderIdHex).toLowerCase(),
    wei
  )).changes;
}

/**
 * 应用一条链上提货争议事件到 `nft_claims`（**唯一写入点**）。
 *
 * 只按 `dispute_claim_id` 匹配：节点在 `/api/claims/:id/dispute` 里把"这次开案用的是哪个
 * claimId"记进那一行（开案交易由节点主钱包发，节点不持私钥）。链上发生但本地没有对应行
 * （不是本节点开的案）⇒ 0，不建行、不猜。
 *
 * `ClaimVoted` 刻意不落库：nft_claims 没有逐票镜像，票数属于链上读法（`claimTallyOf`）；
 * 本地要的是**结论**（ClaimClosed / ClaimDisputeCancelled）。
 */
async function applyClaimChainEvent(name, args) {
  const claimId = String(args?.claimId || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(claimId)) return 0;
  const db = getDb();
  if (name === 'ClaimVoted') return 0;
  if (name === 'ClaimDisputeOpened') {
    return (await db.run(
      "UPDATE nft_claims SET dispute_state = 'opened', dispute_opened_at = CURRENT_TIMESTAMP(3) WHERE dispute_claim_id = ? AND dispute_state = 'none'",
      claimId
    )).changes;
  }
  if (name === 'ClaimClosed') {
    const rawAmount = args?.amountWei;
    const amount = rawAmount === undefined || rawAmount === null ? null : String(rawAmount);
    if (amount === null || !/^\d+$/.test(amount)) return 0;
    /*
      争议结案必须同时推进**链下声明状态**：requested/approved/shipped 仍占着
      `uq_claims_active_token` 的唯一槽位，只改 dispute_state 会让这枚 token 之后
      再也无法被新持有人声明。赔偿 >0 ⇒ fulfilled（已兑付，继续占位防二次赔付）；
      判卖家无责 ⇒ rejected（让位给后续持有人）。`claim_amount_wei` 有 CHECK >0，
      无法用 0 表示"没有赔付"，所以零赔付写 NULL。
    */
    const terminalStatus = amount === '0' ? 'rejected' : 'fulfilled';
    const claimAmount = amount === '0' ? null : amount;
    return (await db.run(
      `UPDATE nft_claims
          SET status = ?,
              dispute_state = 'closed',
              dispute_closed_at = CURRENT_TIMESTAMP(3),
              claim_amount_wei = ?
        WHERE dispute_claim_id = ? AND dispute_state <> 'closed'`,
      terminalStatus,
      claimAmount,
      claimId
    )).changes;
  }
  if (name === 'ClaimDisputeCancelled') {
    return (await db.run(
      `UPDATE nft_claims
          SET status = 'cancelled',
              dispute_state = 'cancelled',
              dispute_closed_at = CURRENT_TIMESTAMP(3),
              claim_amount_wei = NULL
        WHERE dispute_claim_id = ? AND dispute_state <> 'closed'`,
      claimId
    )).changes;
  }
  return 0;
}

async function applyEventCore(name, args, meta = {}) {
  // Claim* 事件没有普通订单的 orderId；先把它们路由到唯一的 claim 处理器，避免在下面
  // `String(args.orderId)` 处被当成 undefined 订单静默丢弃。
  if (String(name).startsWith('Claim')) return applyClaimChainEvent(name, args);
  const orderId = String(args.orderId).toLowerCase();
  const db = getDb();
  /*
    入口读：链上单号 → 本地行（见 localRowOf）。本节点没有这一单 ⇒ 无事可做返回 0
    （合约里的单不限于本节点，别人的单每轮都会出现在日志里）。
  */
  const local = await localRowOf(db, orderId);
  if (!local) return 0;
  /*
    防伪托管（**全事件**口径，源码审计 2026-09 修复）：此前只有 OrderCreated 分支核对
    金额/卖家/买家，终局与冻结类事件（Expired / Arbitrated / Refund* / DisputeRequested /
    ReceiptConfirmed）**只按 orderId + 本地状态**落地——而草稿的 escrowOrderId 并不是秘密：
    匿名列表虽不下发它，但详情页以不可枚举的 order_no 为键、拿到那张 URL 的人就能读出。
    攻击者据此对任意
    **未付款草稿**的 orderId 用 1 wei + timeoutBlocks=1 建一笔自己的链上单，再调
    releaseExpired 触发 OrderExpiredReleased：本地 draft 被改成 expired（库存占位被释放、
    事件史写入攻击者 txHash、并按 INCOME_STATUS 计入卖家流水），此后买家真实支付因
    OrderExists 永久 revert，只能作废重下——每开一张草稿即可被定点打断一次。
    现要求：凡带 meta.chainParams（pollOnce 以 getOrder 预取的链上真值；买家/卖家/金额
    自创建起不可变）的事件，必须先与本行锁定值逐项一致，不一致则整条事件不落地。
    注：单测直调/兼容旧调用不带 chainParams 时跳过（与 OrderCreated 分支同口径）。
  */
  if (name !== 'OrderCreated' && meta.chainParams && !chainParamsMatch(local, meta.chainParams)) {
    console.warn(
      `[escrowWatcher] 忽略与链上真值不符的事件: ${name} orderId=${orderId} 买家/卖家/金额/验货窗口与本地订单锁定不一致（疑似他人对同一 orderId 的诱饵单）`
    );
    return 0;
  }
  let changed;
  switch (name) {
    case 'OrderCreated': {
      // 防伪托管（与 paid/sync 同规则）：事件里的金额/卖家/买家必须与本地锁定值一致，
      // 且 chainParams 里的 token 必须等于本地 payment_token——ERC20 单的金额是 token
      // 最小单位，只比数字会让同数字的原生灰尘单顶替。字段缺失（单测直调）时跳过事件字段比对，
      // 但真实路径的 chainParams 已由 pollOnce 预取并逐项校验。
      let match = true;
      if (args.seller !== undefined && args.amount !== undefined && args.buyer !== undefined) {
        const sellerOk = String(args.seller).toLowerCase() === String(local.seller || '').toLowerCase();
        const buyerOk = String(args.buyer).toLowerCase() === String(local.buyer || '').toLowerCase();
        let amountOk = false;
        try {
          amountOk = BigInt(args.amount) === BigInt(local.amount_wei || '0');
        } catch {
          amountOk = false;
        }
        match = sellerOk && buyerOk && amountOk;
      }
      // 兜底：事件字段缺失（ABI 漂移）时用 pollOnce 预取的链上真值再比一遍
      if (match && meta.chainParams) match = chainParamsMatch(local, meta.chainParams);
      if (!match) {
        console.warn(
          `[escrowWatcher] 忽略疑似伪造托管事件: orderId=${orderId} 金额/卖家/买家/验货窗口与本地订单锁定不符`
        );
        return 0; // 不推进、不记录事件史、不触发自动交付
      }
      // 支付哈希统一小写（与 paid/sync 同规约；唯一索引大小写敏感，防同笔支付双形落两单）
      const txHash = meta.txHash ? String(meta.txHash).toLowerCase() : null;
      /*
        状态在 `orders`、支付凭证在 `order_chain`：两条语句、同一个事务。
        凭证用 `COALESCE` 写：paid 快路径可能已经先落库（它的哈希来自收据，同为链上规范哈希），
        这里只补空；而 watcher 落的是 `log.transactionHash`（BTY 双哈希：广播返回的 hash
        可能只是别名，一律归一）。
        顺序是先状态后凭证：状态的 `changes` 是"这一单确实从 draft 迁过来了"的**唯一凭据**
        （0/1，见文件头对多表 UPDATE 的说明），只有它为 1 才写凭证。
      */
      changed = (await db.run(
        "UPDATE orders SET status = 'escrowed', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'draft'",
        local.order_id
      )).changes;
      if (changed > 0) {
        await db.run('UPDATE order_chain SET paid_tx_hash = COALESCE(paid_tx_hash, ?) WHERE order_id = ?', txHash, local.order_id);
      } else if (local.status === 'cancelled' && !local.paid_tx_hash) {
        // 草稿超时被清扫（sweeper）/手动取消后链上托管才落定的竞态恢复：
        // 事件金额/卖家/买家已与本地一致 → 链上资金真实存在。先按逐单占位记账回补占位
        // （restockOrder 失败=取消期间限量库存被卖完，仅记告警——资金已上链，订单优先恢复，
        // 差额由店主人工核账扩容），再置 escrowed 并自动交付。
        if (!(await restockOrder(local.order_id))) {
          // 占位恢复失败 = 该单的限量库存在取消期间被卖给了别人：链上资金真实存在、订单
          // 必须恢复（不能因本地账目卡住资金），但本地余量已无法覆盖两笔承诺 → 存在超卖，
          // 需店主人工核账/扩容。仅 console 会静默漏过（源码审计 2026-09 修复）：
          // 同时推店主 webhook + 每个订单只告警一次（`order_alerts` 主键去重），保证「看得见」。
          console.error(
            `[escrowWatcher] 恢复已取消订单 ${String(local.order_no).slice(0, 8)}… 的库存占位失败（限量库存不足），请店主核账扩容`
          );
          try {
            // 预占只在投递成功后留下（2026-09 修复，见 alertAck.js）：投递失败/未配置通知地址时
            // 预占被释放，事件重放（重启/重组重扫）会再推一次——"超卖需核账"不能因为一次投递失败就永久丢失
            await alertOnceDelivered({
              orderId: local.order_id,
              kind: 'hold_missing',
              label: '[escrowWatcher]',
              what: `（order.hold_missing，order=${String(local.order_no).slice(0, 8)}…，取消期间限量库存已被他人买走）`,
              send: () =>
                notifyRaw('order.hold_missing', {
                  /*
                    ⚠️ `shopCode` 是**必填**的：`webhook.deliver()` 按 `payload.shopCode` 去查
                    `shop_webhook`（一行一店）。缺了它，投递会**一次尝试都不发**就 resolve(false)，
                    日志还写着"未配置通知地址"——而地址其实是配了的。
                    症状：`order_alerts` 的预占被释放、下一轮重投、永远投不出去。
                  */
                  shopCode: local.shop_code,
                  orderId: local.order_no,
                  escrowOrderId: orderId,
                  reason: '取消期间限量库存已被他人买走，订单已恢复但未重新占位——请核对该商品余量并扩容或退款处理',
                }),
            });
          } catch {
            /* 告警失败不影响恢复（console 已留痕） */
          }
        }
        changed = (await db.run(
          "UPDATE orders SET status = 'escrowed', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'cancelled'",
          local.order_id
        )).changes;
        if (changed > 0) {
          await db.run('UPDATE order_chain SET paid_tx_hash = COALESCE(paid_tx_hash, ?) WHERE order_id = ?', txHash, local.order_id);
          console.warn(`[escrowWatcher] 自动恢复已取消订单 ${String(local.order_no).slice(0, 8)}…（链上托管已落定，置回 escrowed）`);
        }
      }
      // 卡密自动交付：数字商品且码池有未用码时，托管成功后直接自动发码置 shipped。
      // 通知顺序保证语义不倒置：先 escrowed（托管成功）再 shipped（自动交付完成）。
      // 追赶回放防误发：同批内该单稍后存在终局事件（退款/仲裁判退/超时）时
      // pollOnce 传 skipAutoDeliver=true → 本轮不自动发码（等待本批终局事件把单置终态），
      // 避免「已退款/已超时买家仍免费得码」；单测直调不带该标记，行为不变。
      if (changed > 0) {
        // 提交后再发（见 applyEvent 说明）：先 escrowed，再自动交付的 shipped。
        // 参数据是**对外单号** order_no（接收方按它查单；内部键 orders.id 不是任何人的标识）。
        meta.afterCommit?.push(() => notify('order.escrowed', local.order_no));
        /*
          自动交付（2026-10-13 改）：判据搬到**链上复核**里（见 autoDeliver.tryAutoDeliverByEscrowOrder 的说明）——
          本地镜像 `refund_status` 有 12 块确认深度的滞后，够买家在 `OrderCreated` 之后补一笔
          `requestRefund`，然后拿到码再让钱冻在托管里。
          两件事随之改变，都必须在这里处理，否则会引入新的错：
            · 它是 async ⇒ 这个提交后回调本身也是 async，由 `applyEvent` 逐个 await（rejection
              落在那里的 try/catch；回调自己不再吞错，否则一次失败会静默消失）；
            · `alertPoolEmptyForOrder`（池空告警）依赖"交付已经试过"这个前提 ⇒ 必须**排在交付之后**
              （原先靠同步顺序保证；现在只能在 finally 里串起来，否则正常交付也会误报池空）。
          注意 `skipAutoDeliver`（追赶回放）分支：交付交给收尾的 `flushAutoDeliverPending` 补，
          但告警照旧要发（那条分支下"没发码"不是失败，只是延后）。
        */
        meta.afterCommit?.push(async () => {
          // 交付之后才判池空（见上）；告警自身失败只记日志，不影响已提交的状态
          const alertAfterDeliver = async () => {
            try {
              await alertPoolEmptyForOrder(local.order_id);
            } catch (e) {
              console.error(`[escrowWatcher] 池空告警失败（不影响一致性）: ${e?.message || e}`);
            }
          };
          if (meta.skipAutoDeliver) return alertAfterDeliver();
          try {
            await tryAutoDeliverByEscrowOrder(orderId);
          } catch (e) {
            console.error(`[escrowWatcher] 自动交付链上复核失败（状态已落库，不影响一致性）: ${e?.message || e}`);
          } finally {
            await alertAfterDeliver();
          }
        });
      }
      break;
    }
    case 'ReceiptConfirmed': {
      // 买家确认收货可发生在退款申请后（链上 confirmReceipt 不要求未申请）——终局同时复位售后镜像；
      // v2+ 争议中买家撤诉放款同样发本事件（Escrow.confirmReceipt 扩 Disputed 态）→ disputed → confirmed
      // from 集对齐 /sync 的 Settled 口径（源码审计 2026-09）：draft/cancelled 行是「节点漏扫
      // OrderCreated」的残镜像——链上既已收到本事件，说明该单确实托管过且已结算给卖家，
      // 本地必须收敛到成交终局（此前这些行永远停在 draft/cancelled，卖家流水漏计）。
      // settled 也要收：/sync 在漏扫事件时可能先落 settled，真实 ReceiptConfirmed 到达后
      // 必须能补成 confirmed（确认率/文案依赖它）。
      const claim = await claimOrderState(
        db,
        local.order_id,
        ['draft', 'cancelled', 'escrowed', 'shipped', 'disputed', 'expired', 'settled'],
        'confirmed'
      );
      changed = claim.changed;
      if (changed > 0) {
        // 取消时占位已释放；链上既然成交/确认，必须把占位补回来，否则同一件限量货可再次卖出。
        if (claim.from === 'cancelled' && !(await restockOrder(local.order_id))) {
          console.error(
            `[escrowWatcher] 恢复已取消订单 ${String(local.order_no).slice(0, 8)}… 的库存占位失败（限量库存不足），请店主核账扩容`
          );
          try {
            await alertOnceDelivered({
              orderId: local.order_id,
              kind: 'hold_missing',
              label: '[escrowWatcher]',
              what: `（order.hold_missing，order=${String(local.order_no).slice(0, 8)}…，确认收货复活时占位失败）`,
              send: () =>
                notifyRaw('order.hold_missing', {
                  shopCode: local.shop_code,
                  orderId: local.order_no,
                  escrowOrderId: orderId,
                  reason: '订单取消后链上才确认收货，本地复活时库存占位失败（限量库存已被他人买走）——请核对商品余量并扩容或退款处理',
                }),
            });
          } catch {
            /* 告警失败不能阻断状态收敛 */
          }
        }
        // 终局复位退款镜像（链上列，见文件头的两表说明）：只在迁移真的发生了的时候写
        await db.run("UPDATE order_chain SET refund_status = 'none' WHERE order_id = ?", local.order_id);
        // D1：已交付行若退货已确认收货/放弃追索（received_at 非空，货已实际回卖家侧/卖家放弃追回），
        // 即使资金终局判给卖家（成交）也不应继续占位——实物已可再售，见 releaseHoldsForReturnReceived
        await releaseHoldsForReturnReceived(orderId);
      }
      break;
    }
    case 'DisputeRequested':
      // from 集与对账（chainReconcile 按链上 Disputed 修复）共用 markEscrowDisputed（唯一实现）
      changed = await markEscrowDisputed(db, orderId);
      break;
    /*
      两级售后（v2）：买家链上 requestRefund → refund_status=requested（资金冻结、超时释放被禁）；
      卖家 rejectRefund → rejected（解锁 requestDispute 资格）。合约不接受被拒后重复申请
      （防「申请→拒绝→再申请」无限冻结循环，见 Escrow.sol requestRefund），本地镜像随之翻转。

      ⚠️ 两列分住两张表（`refund_status`/`refund_requested_at` 在 order_chain，`updated_at` 在 orders），
      所以守卫要**两边都判**：先判订单是否还在途（它决定"这一单还在退款窗口里吗"），
      再写镜像列（幂等守卫 `<> 'requested'` 挂在那一列上），最后才动 updated_at。
      反过来先写镜像列，会让一张已终局的单被盖上"退款申请中"的标记——那正是面板上
      "已退款却显示待处理退款"这类自相矛盾的来源。
    */
    case 'RefundRequested':
      changed = 0;
      if (local.status === 'escrowed' || local.status === 'shipped') {
        const n = (await db.run(
          "UPDATE order_chain SET refund_status = 'requested', refund_requested_at = CURRENT_TIMESTAMP(3) WHERE order_id = ? AND refund_status <> 'requested'",
          local.order_id
        )).changes;
        if (n > 0) {
          await db.run('UPDATE orders SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', local.order_id);
          changed = n;
        }
      }
      break;
    case 'RefundRejected':
      changed = 0;
      if (local.status === 'escrowed' || local.status === 'shipped') {
        const n = (await db.run(
          `UPDATE order_chain
              SET refund_status = 'rejected', refund_rejected_at = CURRENT_TIMESTAMP(3),
                  accepted_partial_refund_wei = 0
            WHERE order_id = ?
              AND (refund_status <> 'rejected' OR accepted_partial_refund_wei <> 0)`,
          local.order_id
        )).changes;
        if (n > 0) {
          await db.run('UPDATE orders SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', local.order_id);
          changed = n;
        }
      }
      break;
    case 'PartialRefundAccepted': {
      /*
        买家对**具体金额**的部分退款授权（契约 2026-09 新增；契约收紧 approveRefund 之后，
        卖家要退部分金额，唯一合法取值就是这里被授权的那个数）。

        本事件**不迁移订单状态**：授权不转移资金、不冻结订单，买家仍可确认收货/发起争议/
        改授权额（重复授权覆盖旧值），所以 status / refund_status 一律不动。

        但"授权额真的写入/变化"必须算作 changed > 0 —— 通用尾部（recordEvent 事件史 +
        typeForChainEvent 通知分派）只在 changed > 0 时才跑，若这里恒返回 0，链上授权了、
        本地订单详情里却查不到任何凭证（而卖家要凭这条金额去调 approveRefund）。
        幂等：`WHERE ... <> ?` 让同值重扫（重组回退/失败重试）changes=0，不重复记账
        （与其它分支"changes=0 不写事件史"同口径）。
        重复授权覆盖旧值时被拒的授权不会上链（合约在写映射前 revert），故本列恒等于链上
        `acceptedPartialRefund(orderId)`。

        刻意**不迁移状态、不动 updated_at**（写入逻辑与 /sync 快照路径共用同一实现
        `applyAcceptedPartialRefund`）：授权不改变任何时间线语义，而 updated_at 是统计窗口
        （stats.js 的入账/退款按天聚合）与店主列表排序的依据——一个迟到的事件把已终局的行
        "挪"进更晚的窗口，就等于让成交额在两天的报表里各出现一次。本分支只写这一列，别无副作用。

        通知：不派发 webhook（`typeForChainEvent` 刻意不给它映射）——这不是店主/买家需要
        被叫醒的**状态**通知：订单状态没变、钱没动，卖家用不用这个授权额由他自己决定
        （面板上读 DTO 即可）。给它加 'order.*' 通知只会让店主在"什么都没发生"时收到告警。
      */
      changed = await applyAcceptedPartialRefund(orderId, args?.refundWei);
      break;
    }
    case 'RefundApproved':
      // 卖家 approveRefund（申请后同意 / 争议中和解）：合约 2026-09 只接受两种金额 ——
      // refundWei == amount（全额认赔，不需要授权）或 refundWei == 买家已精确授权的
      // acceptedPartialRefund[orderId]（部分退款）；其它一律 RefundAmountNotAccepted
      //（旧的 RefundNotFull 已删除），所以本事件只会是这两档之一；能任意比例拆分的
      // 仍然只有仲裁人票决 voteSettlement（Arbitrated 事件，无需买家授权）。
      // 这里仍走 settleByRefundSplit 的按额判定（而不是硬写 refunded）：ABI 漂移/旧事件字段缺失时
      // 判据与 Arbitrated 完全一致，不会出现"同一笔钱两条事件路径两种终态"。
      // from 集对齐 /sync 的 Refunded 口径（源码审计 2026-09）：补 draft/cancelled——链上已终局
      // 是事实，本地残镜像必须收敛（此前这些行永远停在非终态，买家看不到结果）。
      changed = await settleByRefundSplit(db, orderId, args.refundWei);
      break;
    /*
      确认收货后的售后案件（契约 2026-10 第二批）——**两个分支都不迁移 orders.status**。

      为什么必须写在这里（而不是调用点各判一次）：`after_sale_status` 是"这一个终局单上有没有
      在途案件"的**唯一**本地事实，它同时喂着售后陈述门控、退货单窗口、仲裁台队列、卖家徽标与
      保留期保护。事件路径是它的第一来源；/sync 与后台对账（chainReconcile）按链上
      afterSaleOpen/afterSaleOpenedAtBlock 走 afterSale.js 里**同一对**写入口回填，
      所以"漏扫事件"不会让这个状态与链上永久分叉。

      `changes=0`（本地无此单 / 已是该状态）时不写事件史、不发通知——与其它分支同口径；
      链上真值核验（meta.chainParams 的买家/卖家/金额比对）在本函数头部统一执行，售后案件事件
      同样受它保护（草稿的 orderId 对拿到详情链接的人可见，不核对就等于让别人的假案件驱动本地队列）。
      这两列都住在 order_chain（链上镜像表），写入只落在那一行上（见 afterSale.js）。
    */
    case 'AfterSaleOpened':
      // 只置 open + 开案时刻/区块；已结案的行由 applyAfterSaleOpened 的 WHERE 守卫拒绝覆盖（终态）
      changed = await applyAfterSaleOpened(orderId, { block: meta.block ?? null });
      break;
    case 'AfterSaleClosed':
      // note 是链上事件里的**用户文本**：在唯一写入口截断到 500 字符；只在 JSON 里下发，
      // 由前端按纯文本渲染（节点不做 HTML 拼接/半吊子转义，见 afterSale.js 的 XSS 说明）
      changed = await applyAfterSaleClosed(orderId, { note: args?.note ?? null });
      break;
    case 'SellerRefunded': {
      /*
        refundedTotal 由合约在**所有**买家已收路径（结算退款 + sellerPending 退款 + 售后质押赔付）
        累加后下发。节点按绝对值写，不做 `+= amount`：事件重放/游标回退不会重复记账。
      */
      const total = String(args?.refundedTotal ?? '').trim();
      if (!/^\d+$/.test(total)) {
        throw new Error(`SellerRefunded 缺少合法的 refundedTotal（${String(args?.refundedTotal)}）`);
      }
      const totalBig = BigInt(total);
      if (totalBig > BigInt(local.amount_wei)) {
        throw new Error(`SellerRefunded 的 refundedTotal=${total} 超过托管额 ${local.amount_wei}`);
      }
      if (local.refunded_amount_wei != null && totalBig < BigInt(local.refunded_amount_wei)) {
        throw new Error(
          `SellerRefunded 的 refundedTotal=${total} 小于本地已记账 ${local.refunded_amount_wei}（链上退款额不应回退）`
        );
      }
      changed = (await db.run(
        'UPDATE order_chain SET refunded_amount_wei = ? WHERE order_id = ? AND refunded_amount_wei <> ?',
        total,
        local.order_id,
        total
      )).changes;
      break;
    }
    case 'Arbitrated':
      // 仲裁裁决（争议可能带着 requested/rejected 镜像进入）：refundWei 同口径拆分结算；
      // 占位回补（全额退款 = 未交付行口径 / 拆分与判卖家 = D1 退货已回收口径）由 settleByRefundSplit 内部处理
      changed = await settleByRefundSplit(db, orderId, args.refundWei);
      break;
    case 'OrderExpiredReleased': {
      // 链上超时释放适用于 Created 单：本地 draft/escrowed（未交付）与 shipped（已交付后买家
      // 拖单不确认）都可能是其镜像；confirmed 亦纳入 from 集（历史上 /sync 把链上
      // Settled 一律焊成 confirmed 后，真实超时事件必须能把该镜像纠正为 expired——真实
      // 买家确认收货后链上不会再发本事件，纳入 confirmed 无回退风险）。释放口径与退款
      // 终局一致（见 releaseRefundedEscrow）：「已交付」（shipped，或 escrowed 但已有交付行/
      // 物流单号的部分交付）一律视为钱货两清、不释放库存占位（防已售出货物回补库存导致
      // 超卖）；从未交付的 draft/escrowed 归还占位额度（货仍在库可再售）。逐行快照判定
      // 释放粒度，避免以单行状态代表整体漏放/多放。超时即终局：退款镜像复位。
      // from 集对齐 /sync 与对账的口径（源码审计 2026-09）：补 cancelled（草稿被清扫后才
      // 落定的链上单，卖家真实收款而本地永不停留在非终态 = 流水漏计）、disputed（链上 Created
      // 单不可能超时释放成 Disputed，本地 disputed 必是漏扫/重组残镜像），
      // 以及 **settled**（2026-09 复审补：/sync 与 chainReconcile 现在把"链上已 Settled 但原因未知"
      // 统一收敛为 settled，其中就包含**超时释放后事件被漏扫**这一种——事件随后被重扫出来时，
      // 必须能把镜像纠正成更准确的 expired，否则买家看到的永远是"已结算"而不是"超时已释放给商家"。
      // 安全性：orderId 一单一号且 createOrder 对已存在单号 revert，故不可能同时存在"真单"与"诱饵单"，
      // 凡是本事件到达且 chainParams 校验通过，本地已终局的行也应当被纠正）。
      const FROM_SET = "('draft','cancelled','escrowed','shipped','disputed','confirmed','settled')";
      /*
        「已交付事实」的列名必须走 `deliveredItemsSql`（唯一拼法）：`stockHold.isDelivered`
        只认 `delivered_items` 这个名字，且**列缺失时抛错**——静默判成"未交付"就会把已经
        交到买家手里的货重新回补占位（超卖）。
      */
      const before = await db.all(`SELECT o.id AS order_id, o.status, o.shipped_at, o.tracking_no, ${deliveredItemsSql('o')}
           FROM orders o
           WHERE o.id = ? AND o.status IN ${FROM_SET}`, local.order_id);
      changed = (await db.run(
        `UPDATE orders SET status = 'expired', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status IN ${FROM_SET}`,
        local.order_id
      )).changes;
      if (changed > 0) {
        // 超时即终局：退款镜像复位（链上列，见文件头的两表说明）
        await db.run("UPDATE order_chain SET refund_status = 'none' WHERE order_id = ?", local.order_id);
        /*
          「已交付事实」= shipped_at ∨ tracking_no ∨ 交付行（与 db.js 的列注释、stockHold.js 的
          释放判据、returns.hasDelivered **同一口径**）。原先只判 `status !== 'shipped'` 与
          tracking_no/交付行，漏了 `shipped_at`——而 `/sync` 会把链上 Settled 焊成 `confirmed`，
          于是「自提/线下交付（空物流单号，只有 shipped_at）」的单走到这里时
          `status === 'confirmed'` 绕过了 `!== 'shipped'`、另两项也空 → **占位被回补**，
          已经交到买家手里的货重新变成可售库存 → 超卖（正是 db.js 里 shipped_at 那一列
          声明要防的事：自提/线下交付也须据此判已交付）。
        */
        const released = before
          .filter((r) => !isDelivered(r)) // 「已交付事实」的唯一判据（stockHold.isDelivered）
          .map((r) => r.order_id);
        if (released.length) await releaseHoldsForOrderIds(released);
        // D1：已交付行（shipped/有物流/有交付行）超时释放本不自动回补（货在买家侧钱货两清），
        // 但若退货已确认收货/放弃追索（received_at 非空）——货已实际回到卖家侧可再售——占位回补
        await releaseHoldsForReturnReceived(orderId);
      }
      break;
    }
    default:
      return 0;
  }
  if (changed > 0) {
    await recordEvent(orderId, { name, txHash: meta.txHash || null, block: meta.block || null, at: Date.now() });
    // 卖家通知（P0-3）：状态迁移成功后触发（webhook 内部未配置即零开销）。
    // OrderCreated 已在分支内先行入队（保证 escrowed 早于自动交付的 shipped），此处跳过防双发。
    // 参数据是**对外单号** order_no（接收方按它查单）。
    /*
      结算类事件要结合**本单托管额**判"全额退款 vs 拆分结算"（事件本身只有 refundWei）：
      这里传 local.amount_wei（已过 chainParamsMatch 校验），与本地终态判据同源。
    */
    const wtype = typeForChainEvent(name, args, { amountWei: local.amount_wei });
    if (wtype && name !== 'OrderCreated') meta.afterCommit?.push(() => notify(wtype, local.order_no));
  }
  return changed;
}

/** 执行一轮扫描，返回统计信息（无链上配置时跳过） */
export async function pollOnce() {
  if (!config.chain.escrowAddress) {
    return { skipped: true, reason: 'MK_ESCROW_ADDRESS 未配置' };
  }
  watcherStatus.lastPollAt = Date.now();
  if (!watcherStatus.startedAt) watcherStatus.startedAt = watcherStatus.lastPollAt;
  const escrow = getEscrow();
  const head = await getProvider().getBlockNumber();
  /*
    确认深度（源码审计 2026-09）：只扫描「链头 − finalityBlocks」之前的区块。
    重组只回放日志、不回滚已落地的终态（本地无反向迁移路径），等 N 块再处理即从源头规避
    「事件先落地、随后被重组掉」造成的永久错位。finalityBlocks=0 时等价于旧行为（见 config.js）。
  */
  const latest = Math.max(0, head - (config.escrow.finalityBlocks || 0));

  /* 游标、哈希基准、追赶标记与隔离清单都在 `node` 单行上（读只有 nodeRow 一处）：**必须 await**
     ——不 await 时 `from` 是 `Number(Promise)` = NaN、`cursorHash` 是一个 Promise（恒真），
     于是"从第 0 块重扫"与"重组检测拿 Promise 与链上哈希比"同时发生：前者每轮重放全部历史事件
     （幂等，但白烧 RPC），后者把每一轮都判成重组。
     NULL = 还没有游标（不是 0：0 是**合法的创世块高度**，两者混同会让"从未扫过"与
     "扫到了第 0 块"再也分不开）。 */
  const node = await nodeRow();
  if (!node) {
    /*
      行不存在 ⇒ **抛错**，不静默降级：这一行是本模块唯一的记账处（游标/重组基准/隔离清单/
      追平标记），没有它，"每轮从第 0 块重扫"会安静地一直跑下去（幂等，所以不会有任何报错）。
      建立它只有一处（db.js 的 initDb() → ensureNodeRow()）。
    */
    throw new Error(
      '[escrowWatcher] node 单例行（id=1）不存在：链上事件游标没有地方记账。' +
        '处置：确认 MK_SHOP_OWNER 已配置（db.js 的 initDb() 会据此建立这一行），再重启。'
    );
  }
  const cursorBlock = node.watcher_block === null || node.watcher_block === undefined ? null : Number(node.watcher_block);
  /*
    `from` 的三态与旧形状的坑：
      · `null` = **还没有游标**（首启）；
      · `0`    = **游标就在创世块**（合法高度，不是"没有"）。
    旧实现用 `let from = cursorBlock === null ? 0 : cursorBlock` 把两者压成同一个数，
    后面再用 `if (!from)` 判首启——于是游标 ≤64 时一次重组回退到 0 会被当成"从未扫过"，
    `from` 被改写成 `latest - 1`，新分叉上 `[rewound, latest-2]` 的事件**永不重放**：
    订单永远停在旧状态，而日志里只有一句"检测到链重组"。
  */
  let from = cursorBlock;
  let cursorHash = node.watcher_hash ? String(node.watcher_hash) : '';
  if (cursorBlock !== null && cursorBlock > 0 && cursorHash) {
    // 重组检测（游标已存在且存过哈希）：若该高度的链上哈希与上次记录不一致，说明发生了
    // 重组/回滚——被替换高度上的事件（含自动发码）可能作废，回退一段深度重扫。
    // 迁移幂等（状态前置条件守卫），重扫不会重复记账/重复发码（码分配走条件 UPDATE）。
    // 注：RPC 失败（undefined）与「块不存在」（null）必须区分——源码审计 2026-09：
    // 原实现把两者都当 null 而**静默跳过**检测，窗口照常应用新分叉日志并把游标哈希覆盖成
    // 新链值，重组从此再也检测不出来（孤儿状态永久滞留）。RPC 失败时显式告警。
    const curHash = await blockHashOf(from);
    if (curHash === undefined) {
      console.warn(`[escrowWatcher] 重组检测跳过：游标块 ${from} 哈希读取失败（RPC 异常），本轮不做重组比对`);
    } else if (curHash && curHash !== cursorHash) {
      /*
        回退到 `from - REORG_REWIND_BLOCKS + 1` 那一块之前（`from` 存的是"已扫到的块"，
        下一轮从 `from + 1` 开始）。游标 ≤64 时回退点就是创世块，`from` 因此可以是 0——
        它是**合法值**，绝不能让它落进下面的首启分支（那会把扫描起点改成链头，
        新分叉上 [回退点, 链头-2] 的事件永远不重放）。
      */
      const rewound = Math.max(1, from - REORG_REWIND_BLOCKS + 1);
      console.warn(
        `[escrowWatcher] 检测到链重组：游标块 ${from} 哈希不一致，回退 ${from - rewound + 1} 块重扫（幂等）`
      );
      from = rewound - 1;
      cursorHash = '';
    }
  }
  if (cursorBlock === null) {
    // 只有"没有游标"才走首启：`from` 为 0 也可能是重组回退到了创世块之后
    from = config.escrow.startBlock > 0 ? config.escrow.startBlock - 1 : latest - 1;
    if (config.escrow.startBlock <= 0) {
      console.warn('[escrowWatcher] 首次启动且未配置 MK_ESCROW_START_BLOCK，从最新块开始扫描；历史事件可由 /api/orders/:id/sync 兜底');
    }
  }
  if (from >= latest) {
    /*
      已追平链头：若此前有跨越多个扫描窗口的追赶回放（期间抑制了自动交付），在此做
      一次链上真值冲刷——跨批残留的「OrderCreated 与退款分处两窗」场景由
      flushAutoDeliverPending 以 getOrder 复核后补交付（仅 Created 且未申请退款的行）。

      `auto_flush_pending` 是**落库的标记**（不是进程内变量）：抑制发生在某一轮、补扫发生在
      若干轮之后，中间可能重启——进程内变量会在重启时丢掉那一次冲刷，而受影响的行仍停在
      escrowed（没有任何路径会再给它们发码）。冲刷前逐单复核链上真值，重复调用幂等。
    */
    if (Number(node.auto_flush_pending) === 1) {
      try {
        const flushed = await flushAutoDeliverPending();
        await setAutoFlushPending(false);
        if (flushed > 0) {
          console.warn(`[escrowWatcher] 追赶收尾冲刷补交付 ${flushed} 单（此前跨窗抑制）`);
        }
      } catch (e) {
        // 标记不清：下一轮追平重试（冲刷失败不该让"补交付"这件事悄悄消失）
        console.warn(`[escrowWatcher] 追赶收尾冲刷失败：${e?.message || e}（标记保留，下一轮追平重试）`);
      }
    }
    /*
      已追平链头时**隔一轮重扫游标所在块**：链头刚出现的日志可能在 RPC 返回 head 之后才可查，
      上一轮扫到 `to=latest` 却漏掉该块事件时，游标已推进到 latest，旧实现永远不再看它。
      重扫一个块的事件应用是幂等的（changed=0 时不会记事件/发通知），代价是追平后最多每两轮
      多一次单块日志查询；这比“漏掉 ReceiptConfirmed 后只能靠 /sync 降级成 settled”便宜。
    */
    if (from > 0) {
      if (!headRescanPending) {
        headRescanPending = true;
      } else {
        headRescanPending = false;
        from -= 1;
      }
    }
    if (from >= latest) {
      Object.assign(watcherStatus, {
        cursor: from,
        latest,
        lagBlocks: 0,
        upToDate: true,
        lastOkAt: Date.now(),
        lastError: null,
      });
      return { upToDate: true, from, latest };
    }
  }
  headRescanPending = false;
  const to = Math.min(latest, from + SCAN_LIMIT);
  watcherStatus.cursor = from;
  watcherStatus.latest = head;
  watcherStatus.lagBlocks = head - from;
  watcherStatus.upToDate = false;
  // 本轮未达链头（仍有 backlog 待下一轮追扫）：回放中的 OrderCreated 一律抑制自动交付——
  // 其后的退款/仲裁/超时事件可能落在后续窗口（跨批预扫看不到），先发码再被置 refunded
  // 即「已退款买家免费得码」。抑制行由追平后的 flushAutoDeliverPending 以链上真值复核补交付
  //（仅 Created 且 refundRequested=false）；终局行由后续事件迁移置终态。
  const behind = to < latest;
  // 只在标记还是 0 的时候写（每轮重复写同一个值只是白写一行）
  if (behind && Number(node.auto_flush_pending) !== 1) await setAutoFlushPending(true);

  // 并行拉取各事件日志，合并后按 (块号, 日志序号) 排序逐个应用
  const logsByName = await Promise.all(
    EVENTS.map((name) => escrow.queryFilter(escrow.filters[name](), from + 1, to))
  );
  const escrowAddress = String(config.chain.escrowAddress || '').toLowerCase();
  const all = [];
  let foreignLogs = 0;
  logsByName.forEach((logs, i) => {
    for (const log of logs) {
      /*
        **本地再验一次发布者**（见 isCanonicalEscrowLog）：address 过滤是 RPC 的承诺，不是返回值的
        性质。收据路径与 Registry 日志路径都各自核过 `log.address`，这里漏掉就等于给"别人的合约
        发出同名事件"留了一条驱动本地订单状态的路。校验失败只丢弃这一条，不让整轮失败——否则
        一条坏日志会把它后面的好日志一起拖进隔离重试。
      */
      if (!isCanonicalEscrowLog(log, escrowAddress)) {
        foreignLogs += 1;
        continue;
      }
      all.push({ name: EVENTS[i], block: log.blockNumber, index: log.index, txHash: log.transactionHash, args: log.args });
    }
  });
  if (foreignLogs > 0) {
    console.warn(
      `[escrowWatcher] 本轮忽略 ${foreignLogs} 条非托管合约地址的日志（address != ${escrowAddress}，或 removed=true）：` +
        'RPC 的日志过滤不可信，已按来源丢弃'
    );
  }
  all.sort((a, b) => a.block - b.block || a.index - b.index);

  let updated = 0;
  let failed = 0;
  let failedFrom = 0;
  const db = getDb();
  // 审计 P1-2/追赶回放（停机跨区间后批量重扫）时，若同一 orderId 在本批内
  // OrderCreated 之后还跟着退款冻结/退款/仲裁/超时类事件，OrderCreated 分支若立即自动发码，
  // 稍后事件把单置 requested/refunded/expired 就造成「已退款买家免费得码」。预扫描本批：
  // OrderCreated 在前、后随以下任一事件 → 该 OrderCreated 跳过自动交付。
  // 复审补全：RefundRequested（冻结，同批内此前漏检——资金冻结后码已发出、随后 approveRefund
  // 即双损）与 DisputeRequested（争议冻结）一并纳入。
  // 2026-10 补 AfterSaleOpened/AfterSaleClosed：售后案件只可能存在于**已终局**的单上
  // （合约要求 status==Settled），所以同批内出现在 OrderCreated 之后，就说明这一单早就结清了——
  // 此时自动发码等于把码发给一个已经终局（可能已退款失败/已超时）的单。
  const TERMINAL_FOLLOW = new Set(['RefundApproved', 'Arbitrated', 'OrderExpiredReleased', 'RefundRequested', 'DisputeRequested', 'AfterSaleOpened', 'AfterSaleClosed']);
  const skipAutoDeliver = new Set(); // orderId → 本批内 OrderCreated 后有冻结/终局事件，跳过其自动交付
  {
    const orderSeq = new Map(); // orderId → { createdIdx: number|null, terminalAfter: boolean }
    all.forEach((ev, idx) => {
      const oid = String(ev.args?.orderId || '').toLowerCase();
      if (!oid) return;
      let rec = orderSeq.get(oid);
      if (!rec) {
        rec = { createdIdx: null, terminalAfter: false };
        orderSeq.set(oid, rec);
      }
      if (ev.name === 'OrderCreated' && rec.createdIdx === null) rec.createdIdx = idx;
      else if (TERMINAL_FOLLOW.has(ev.name) && rec.createdIdx !== null) rec.terminalAfter = true;
    });
    for (const [oid, rec] of orderSeq) if (rec.terminalAfter) skipAutoDeliver.add(oid);
  }
  /*
    链上真值预取（源码审计 2026-09，防「诱饵单」）：此前只有 OrderCreated 分支核对链上参数，
    攻击者可用他人草稿的 orderId 建 1 wei 单再 releaseExpired，把本地未付款 draft 改成 expired
    （占位被释放、事件史写入攻击者 txHash、按 INCOME_STATUS 计入卖家流水）。这里对**本批内
    涉及本地订单的非 OrderCreated 事件**逐个 orderId 取一次 getOrder（买家/卖家/金额自创建起
    不可变 ⇒ 现取现用恒有效），随 meta.chainParams 传入 applyEvent 逐项比对。
    取不到（RPC 失败）时**不阻断整轮**：该 orderId 记为 unverified，其事件在下面按单条失败处理
    （重试 → 隔离），既不会「无法核对就直接落地」，也不会因一个单拖住整窗扫描。
    每个 orderId 至多一次 RPC；本地无此单的偶发事件不打 RPC（链上的单不限于本节点）。
    提货争议事件（Claim*）没有普通订单状态要改，不在这里预取（由 applyClaimChainEvent 处理）。
  */
  const paramsById = new Map(); // orderId → { ok:true, buyer, seller, amount, timeoutBlocks, token } | { ok:false }
  {
    const needIds = new Set();
    for (const ev of all) {
      /*
        OrderCreated 也必须预取：事件本身不带支付资产，只比 orderId/买卖家/金额
        会让「ERC20 单 + 原生灰尘支付」通过；token 只能从 getOrder/orderToken 现读。
      */
      if (ev.name.startsWith('Claim')) continue;
      const oid = String(ev.args?.orderId || '').toLowerCase();
      if (oid) needIds.add(oid);
    }
    for (const oid of needIds) {
      const local = await db.get('SELECT order_id FROM order_chain WHERE escrow_order_id = ?', oid);
      if (!local) continue;
      try {
        const p = await fetchOnchainOrder(oid);
        paramsById.set(oid, {
          ok: true,
          buyer: p.buyer,
          seller: p.seller,
          amount: p.amount,
          timeoutBlocks: p.timeoutBlocks,
          token: p.token,
        });
      } catch (e) {
        paramsById.set(oid, { ok: false });
        console.warn(
          `[escrowWatcher] 链上真值预取失败（orderId=${oid.slice(0, 18)}…）：涉及该单的事件本轮不落地，下轮重试`,
          e?.message || e
        );
      }
    }
  }

  // 失败事件隔离清单（见 MAX_EVENT_RETRIES）：连续失败到上限的事件本轮跳过，
  // 保证游标能越过坏事件继续前进（否则窗口被钉死在某 2000 块区间内，其后事件永不拉取）。
  // 进程内用 Map（键 = 指纹），落库时折回"指纹 → 条目"的对象（见 setQuarantinedEvents）。
  const quarantined = new Map(Object.entries(quarantineEntriesOf(node.quarantined_events)));
  const fpOf = (ev) => `${ev.block}:${ev.index}:${ev.name}:${String(ev.args?.orderId || '').slice(0, 10)}`;

  for (const ev of all) {
    const fp = fpOf(ev);
    const seen = quarantined.get(fp);
    if (seen && Number(seen.tries || 0) >= MAX_EVENT_RETRIES) {
      // 已到重试上限：跳过并只每轮告警一次（清单持久化在 node.quarantined_events，可在 /healthz
      // 查看计数；修复根因后可人工清掉该条目重放）
      console.error(
        `[escrowWatcher] 跳过隔离中的事件（已连续失败 ${seen.tries} 次）: ${ev.name} block=${ev.block} index=${ev.index} orderId=${String(ev.args?.orderId || '').slice(0, 18)}… 原因: ${seen.error || '未知'}`
      );
      continue;
    }
    try {
      /*
        委员会治理事件：**不落到任何订单**，只让委员会缓存立即失效。换届/吊销之后，
        下一笔仲裁人鉴权（写路径或读 PII 的 `force:true`）必须现读链上新名单——
        缓存里那一份旧名单是"撤权后仍能读 PII"的唯一来源。
      */
      if (ev.name === 'CommitteeUpdated' || ev.name === 'ArbiterRevoked') {
        invalidateCommitteeCache();
        continue;
      }
      /*
        提货争议事件：**不落到订单状态**，只把链上 `ClaimCase` 的结论写回 `nft_claims` 的
        dispute_* 列（按节点自己在开案时记下的 `dispute_claim_id` 匹配）。
        节点没有这一行（不是本节点开的案 / 钱包直接开的案）⇒ 0，不建行、不猜。
      */
      if (String(ev.name).startsWith('Claim')) {
        updated += await applyClaimChainEvent(ev.name, ev.args);
        quarantined.delete(fp);
        continue;
      }
      const oidOfEv = String(ev.args?.orderId || '').toLowerCase();
      const prefetched = paramsById.get(oidOfEv);
      // 本地有此单但链上真值没取到 → 本条事件按失败处理（重试/隔离），绝不无核对落地
      if (prefetched && prefetched.ok === false) {
        throw new Error('链上真值未取到（RPC 读取失败），本轮不落地该事件（防无法核对即推进）');
      }
      const n = await applyEvent(ev.name, ev.args, {
        txHash: ev.txHash,
        block: ev.block,
        // 链上真值（买家/卖家/金额/验货窗口）：非 OrderCreated 事件据此拒绝「他人对同一 orderId
        // 的诱饵单」，见 applyEventCore 头部说明。OrderCreated 自身已用事件字段比对。
        chainParams: prefetched && prefetched.ok ? {
          buyer: prefetched.buyer,
          seller: prefetched.seller,
          amount: prefetched.amount,
          timeoutBlocks: prefetched.timeoutBlocks,
          token: prefetched.token,
        } : undefined,
        // 本批预扫命中 或 未达链头的跨窗回放（behind）→ OrderCreated 抑制自动交付
        skipAutoDeliver: ev.name === 'OrderCreated' && (skipAutoDeliver.has(oidOfEv) || behind),
      });
      updated += n;
      // 成功即从隔离清单摘除（此前失败可能是暂态：RPC 抖动/竞争窗口）
      quarantined.delete(fp);
    } catch (e) {
      // 单事件应用失败：记录重试次数并继续处理其余事件（防止个别坏事件阻塞整轮）；
      // 本轮结束后游标回退到最早失败块前——下一轮重扫该区间（迁移幂等、不重复记账）。
      // 连续失败达 MAX_EVENT_RETRIES 后转入隔离（下一轮跳过该事件），保证游标仍能前进——
      // 否则坏事件会把扫描窗口永久钉死在 failedFrom + SCAN_LIMIT 内（其后事件永不拉取）。
      // 资金类终局事件（RefundApproved/Arbitrated 等）不允许静默丢失：每轮告警 + 清单持久化
      // + /healthz 暴露，需人工介入（日志/对账；/sync 仍可即时兜底）。
      failed++;
      if (!failedFrom || ev.block < failedFrom) failedFrom = ev.block;
      const prev = quarantined.get(fp);
      const tries = Number(prev?.tries || 0) + 1;
      quarantined.set(fp, {
        tries,
        name: ev.name,
        block: ev.block,
        index: ev.index,
        orderId: String(ev.args?.orderId || ''),
        error: String(e?.message || e).slice(0, 200),
        at: Date.now(),
      });
      console.error(
        `[escrowWatcher] 应用事件失败（第 ${tries}/${MAX_EVENT_RETRIES} 次，本轮回退重扫）: ${ev.name} ${String(ev.args?.orderId || '').slice(0, 18)}…`,
        e.message || e
      );
    }
  }
  // 隔离清单落库（截断到上限，丢最旧；成功事件已在上面摘除）
  await setQuarantinedEvents(quarantined);
  if (failed > 0 && failedFrom > 0) {
    // 失败事件的确定性重试：游标退回最早失败事件前一块并清除哈希基准，下轮从头应用
    // （此前成功的迁移幂等跳过，失败事件再次尝试）。连续失败到 MAX_EVENT_RETRIES 的事件
    // 下轮被隔离跳过，因此本回退不会把游标永久钉死（见常量说明）。
    await setWatcherCursor(failedFrom - 1, null);
    watcherStatus.lastError = `本轮 ${failed} 个事件应用失败，游标回退至 ${failedFrom - 1}`;
    console.error(`[escrowWatcher] 本轮 ${failed} 个事件应用失败，游标回退至 ${failedFrom - 1}，下轮重扫（幂等）；持续失败请排查节点日志`);
    return { scanned: { from: from + 1, to }, events: all.length, updated, failed, rewound: true };
  }
  // 记录游标块哈希作为下轮重组检测基准（读取失败**写 NULL**：源码审计 2026-09——
  // 原实现失败时保留旧值，于是下轮拿「新高度的哈希」与「旧高度的哈希」比对，必然不等
  // → 每轮误判一次重组并回退 64 块重扫，永不收敛。NULL = 跳过一轮比对，不阻断扫描）
  const h = await blockHashOf(to);
  await setWatcherCursor(to, h || null);
  Object.assign(watcherStatus, {
    cursor: to,
    latest: head,
    lagBlocks: Math.max(0, head - to),
    upToDate: to >= latest,
    lastScan: { from: from + 1, to, events: all.length, updated, failed },
    lastOkAt: Date.now(),
    lastError: null,
  });
  return { scanned: { from: from + 1, to }, events: all.length, updated, failed };
}

/**
 * 启动轮询（立即执行一次后按 pollIntervalMs 定时）；进程退出不阻塞。
 * 2026-09 复核：busy 互斥防单轮超时导致的扫描堆积（重叠扫描重复打 RPC 且游标竞争）；
 * 单轮超过 pollInterval×4（默认 60s）仍未完成时告警（RPC 无响应/积压信号），不打断在途轮询。
 */
export function startWatcher() {
  let busy = false;
  const tick = async () => {
    if (busy) return; // 上一轮未完成：跳过本轮（不堆积并发扫描）
    busy = true;
    const guard = setTimeout(() => {
      console.error(
        `[escrowWatcher] 单轮轮询超过 ${config.escrow.pollIntervalMs * 4}ms 未完成（RPC 无响应/日志积压？）——请检查 MK_RPC_URL 与公共 RPC 配额；进程继续运行，在途轮询结束后自动恢复节奏`
      );
    }, config.escrow.pollIntervalMs * 4);
    try {
      await pollOnce();
    } catch (e) {
      watcherStatus.lastError = String(e?.shortMessage || e?.message || e);
      watcherStatus.lastPollAt = Date.now();
      console.error('[escrowWatcher] 轮询失败:', e.shortMessage || e.message);
    } finally {
      clearTimeout(guard);
      busy = false;
    }
  };
  tick();
  const timer = setInterval(tick, config.escrow.pollIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
