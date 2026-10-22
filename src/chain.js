/**
 * 链上交互：ethers provider + Escrow 合约封装。
 *
 * 职责：
 *  - 提供 JsonRpcProvider（BTY EVM 主网）
 *  - Escrow 合约只读接口与事件日志解析（供 escrowWatcher 轮询回写）
 *  - 地址/金额工具（checksum、wei ↔ 小数）
 *
 * 支付币种全局约定为原生 BTY（2026-09 收敛）：合约/节点/前端均不再处理 ERC20，
 * 相关 ABI 与代币工具已随重构移除。
 *
 * 注意：BTY 主网 RPC 的 eth_chainId=2999；ethers v6 若未登记该网络，
 * 可显式传入 network 参数避免未知网络校验。
 */
import { ethers } from 'ethers';
import config from './config.js';

// ── Escrow 合约 ABI（与 contracts/src/Escrow.sol 对齐；只含本节点需要的部分）──
export const ESCROW_ABI = [
  // 事件（watcher 依赖，topic 与链上一致）
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, address host, uint256 amount)',
  'event ReceiptConfirmed(bytes32 indexed orderId)',
  'event DisputeRequested(bytes32 indexed orderId)',
  // refundWei：裁给买家的金额（0=全额判卖家，=amount=全额退买家，中间值=拆分结算）
  'event Arbitrated(bytes32 indexed orderId, uint256 refundWei)',
  'event OrderExpiredReleased(bytes32 indexed orderId)',
  'event RefundRequested(bytes32 indexed orderId)',
  'event RefundRejected(bytes32 indexed orderId)',
  // refundWei：卖家同意的退款金额。合约 2026-09 收紧为**只接受两种金额**：
  //   · refundWei == amount                             → 全额认赔（不需要任何授权）
  //   · refundWei == acceptedPartialRefund[orderId]      → 买家已**精确授权**过的那个数
  // 其它一律 revert RefundAmountNotAccepted（0 → RefundAmountZero，> amount → RefundAmountOutOfRange；
  // 旧的 RefundNotFull 错误已随本轮契约变更删除）。仲裁人票决 voteSettlement 不受此限（任意比例拆分）。
  'event RefundApproved(bytes32 indexed orderId, uint256 refundWei)',
  // 买家对**具体金额**的部分退款授权（= 让"双方已谈拢的部分退款"不必绕道仲裁人）。
  // 授权不转移资金、不冻结订单、也不影响买家其它出口；重复授权直接覆盖旧值。
  'event PartialRefundAccepted(bytes32 indexed orderId, uint256 refundWei)',
  // 确认收货后的**售后案件**（契约 2026-10 第二批；本地镜像的唯一判据见 src/afterSale.js）：
  // 开案（仅买家、仅终局且窗口内）/ 结案（买家撤诉或仲裁人，note 为用户文本）。
  // 它不动托管资金（钱早已结清），补偿只能来自卖家保证金 Staking.penalize 或线下转账，
  // 因此也**不阻塞卖家出金**（出金下限只算 sellerOpenExposure = 退款待决/争议中的敞口，案件不计入）。
  'event AfterSaleOpened(bytes32 indexed orderId, address indexed buyer, address indexed seller)',
  'event AfterSaleClosed(bytes32 indexed orderId, address indexed by, string note)',
  /*
    委员会治理事件（Escrow 2026-10-18）：`escrowWatcher` 轮询到它们时让委员会缓存立即失效 ——
    换届/吊销之后，仲裁人视角（订单详情交付码、证据附件下载）不能再按旧名单放行。
    没有这两个事件也可以靠 60s TTL 收敛，但"撤权后最多再读 60 秒 PII"不是一个可接受的窗口。
  */
  'event CommitteeUpdated(uint32 indexed epoch, address[] members, uint16 threshold)',
  'event ArbiterRevoked(address indexed arbiter)',
  // 只读（字段顺序必须与 Escrow.Order **逐字段对应**：refundedAmount 在 status 之前；末尾两项是
  // 2026-09 审计新增——feeCollectorAtCreate（创建时的平台费收取方快照，决定本单扣不扣费）与
  // buyerConfirmed（买家本人确认过收货）。**少一项、错一位都会静默解码出垃圾**：ethers 用短 ABI 解长
  // 返回值会直接抛 out of result range，而错序不会报错——它只会把相邻字段的值读成另一个字段。
  // 同步点：contracts/src/Escrow.sol、contracts/src/Staking.sol 的 IEscrowMinimal、frontend/src/chain.ts、
  // node/scripts/reconcile-ledger.js、scripts/dev/*.mjs —— 改一处必须全改。）
  'function getOrder(bytes32 orderId) view returns (address buyer, address seller, uint256 amount, uint256 feeBps, uint64 timeoutBlocks, uint64 createdAtBlock, bool refundRequested, bool refundRejected, uint256 refundedAmount, uint8 status, address feeCollectorAtCreate, bool buyerConfirmed)',
  // 写（节点不经手资金，仅买家/卖家/仲裁人直接调用；此处仅供脚本/测试参考）
  /*
    下单签名（2026-10 多店模型）：第 5 个参数是**节点抽成条款**（`{address commissionTo; uint16 commissionBps}`）。
    它由买家在结账时从 Registry 的店铺登记行读出后签进来，Escrow 只做入口校验并快照进订单——
    也就是说"这笔钱该怎么分"在下单那一刻就定了，节点改不了已签的单（见 Escrow.ShopTerms 的说明）。
    ⚠️ 这份声明是**给脚本/测试看的参考**：真正的调用在买家钱包侧（frontend/src/api/escrowTx.ts），
    改签名必须那一端同批改，否则下单会在 ethers 的参数编码处直接失败。
  */
  'function createOrder(bytes32 orderId, address seller, uint256 amount, uint64 timeoutBlocks, tuple(address commissionTo, uint16 commissionBps, bytes32 shopCode) terms) payable',
  'function confirmReceipt(bytes32 orderId)',
  'function requestDispute(bytes32 orderId)',
  /*
    2026-10-18：单仲裁人 → **多仲裁人 + 阈值票决**。三个写入口都是"投一票"，
    达到当届阈值的那一票在同一笔交易里执行（结算 / 罚没 / 售后结案）。
    节点不写链，这里声明只为脚本/测试参考；真正调用在钱包侧（frontend/src/api/escrowTx.ts）。
  */
  'function voteSettlement(bytes32 orderId, uint256 refundWei)',
  'function votePenalty(bytes32 orderId, uint256 amountWei)',
  'function voteAfterSale(bytes32 orderId, uint256 penaltyWei)',
  'function releaseExpired(bytes32 orderId)',
  'function requestRefund(bytes32 orderId)',
  'function approveRefund(bytes32 orderId, uint256 refundWei)',
  'function acceptPartialRefund(bytes32 orderId, uint256 refundWei)',
  /*
    订单创建时锁定的**节点抽成条款**（`{address payee; uint16 bps}`；未抽成时为 (0,0)）。
    它**不在 `getOrder` 元组里**——`Order` 结构体加到第 14 个字会让合约编译不过
    （Stack too deep，见 Escrow 里 OrderCommission 的说明），所以走独立 mapping + 本视图。
    对账/账本要"这一单被抽了多少"时也读 `commissionAtSettle`（结算时落库的实数），
    不要自己按 bps 复算：复算式要与链上共用同一个结算基数与取整，那正是 `fees.js` 收口成一处的那条纪律。
  */
  'function commissionTermsAtCreate(bytes32 orderId) view returns (address payee, uint16 bps)',
  /// @notice 结算时**实际付给节点主**的抽成（wei；0 = 本单没有抽成）。**唯一真相**，不做二次复算
  'function commissionAtSettle(bytes32 orderId) view returns (uint256)',
  // 买家已授权的部分退款额（0 = 未授权）；approveRefund 部分退款时的唯一合法取值来源
  'function acceptedPartialRefund(bytes32 orderId) view returns (uint256)',
  /*
    确认收货后的售后案件只读视图（`/sync` 与后台对账的链上真值；见 src/chainOrder.js 的
    fetchAfterSaleFor）。刻意只读这两个、不读 settledAtBlock/afterSaleWindowBlocks：
    "窗口还开着吗"由**合约**在 openAfterSale 里判（revert AfterSaleWindowClosed），
    节点不重复实现一遍窗口算术——两套判据迟早漂移，而这里读它并没有任何本地决策要用。
    链上事实源：afterSaleOpenedAtBlock != 0 ⇔ 有在途案件；结案会把它清零，但
    `afterSaleClosedAtBlock` 是**终态**（合约拒绝对已结案的单再开案；本地镜像不得把 closed 改回 open）。
  */
  'function afterSaleOpen(bytes32 orderId) view returns (bool)',
  'function afterSaleOpenedAtBlock(bytes32 orderId) view returns (uint64)',
  /*
    售后窗口的两个**按单**读数（2026-10-14 与 Staking 的罚没窗口判据同批加）：
      · `settledAtBlock(orderId)`            —— 窗口的**起算点**（0 = 这笔钱从未判给卖家）；
      · `afterSaleWindowBlocksOf(orderId)`   —— 窗口长度，`_settle` 时写入的**快照**
        （等价于 `afterSaleWindowAtSettle` 这个 public mapping；这里用视图函数名，
         因为合约里两者都在、而读法是"这一单的窗口是多少"这一个人话口径）。
    为什么节点也要能读它们：`Staking.penalize` 现在判"案件开着 ∧ 仍在窗口内"，
    前端仲裁台与运维对账都要用**同一对读数**复算，不能各写一遍块高算术
    （`Escrow.settledAtBlock` / `afterSaleWindowAtSettle` 是同一份事实的两种读法）。
  */
  'function settledAtBlock(bytes32 orderId) view returns (uint64)',
  'function afterSaleWindowBlocksOf(bytes32 orderId) view returns (uint64)',
  /*
    该卖家当前的**在途售后敞口**（wei）= Σ 在途单（退款申请待决 + 争议中）的 amount。
    它是 `Staking.payoutFloors` 的唯一读数来源 ⇒ 缺这个读法时四条出金路径整体 revert
    （店主提不出质押，而日志无声）。节点自己不做出金决策，但**代次探针必须探它**
    （见 ESCROW_GENERATION_PROBES 的说明），运维也拿它解释"为什么这家店提不出钱"。
  */
  'function sellerOpenExposure(address seller) view returns (uint256)',
  /*
    2026-10-13 复审新增（跨端镜像同批）：
      · `totalOpenExposure()`：全局在途售后敞口（= Σ `sellerOpenExposure`）。原消费方（Staking 的
        换源闸）已随"事实源不可更换"（2026-10-14）消失，今天读它的是 Staking 构造期探针的形状判据；
      · `sellerNetAtSettle(orderId)`：判给卖家时的**实收净额**（已扣平台费）——`Staking.penalize`
        单笔上限的基准（按毛额会多罚一笔卖家从未收到的费，并让自建订单洗池有利可图）。
    节点自身不做罚没、也不改事实源，这两项是给对账/脚本与人工核查用的读数。
  */
  'function totalOpenExposure() view returns (uint256)',
  'function sellerNetAtSettle(bytes32 orderId) view returns (uint256)',
  /*
    托管超时的**链上阈值**（前端 utils/escrowCountdown 同判据）：
    释放允许**当且仅当** `latestBlock > releaseNotBeforeBlock(orderId)`。刻意不自己用
    `createdAtBlock + timeoutBlocks` 算一遍——合约在这之上还叠了"卖家拒绝退款后的释放静置期"
    （加固 A），自己算会把静置期内的单误报成"已超时"。
    ⚠️ 合约注释写明：若 `refundRequested` 仍为真，释放是被**永久**禁止的，此时本函数返回的 T
    没有意义——调用方必须同时看退款申请状态（节点侧读本地镜像 refund_status）。
    （原注释指向 `src/opsMetrics.js`，那个文件在仓库里**不存在**——2026-10 清理掉的死引用。）
  */
  'function releaseNotBeforeBlock(bytes32 orderId) view returns (uint64)',
  /*
    下单允许的最小超时窗口（块数；owner 可调，2026-10-13 起不再是 immutable）。
    两个用途：**启动期代次自检**（assertEscrowGeneration——这条只读入口只在 2026-10 那一代
    合约上存在，读不到就说明接的是更早一代），以及**启动期下单超时窗口自检**
    （checkOrderTimeoutBounds：`MK_ESCROW_TIMEOUT_BLOCKS` 是本节点写进草稿的值，
    低于它会让每一笔 createOrder 以 TimeoutTooShort 回滚）。
    2026-10-14 更正：此处此前写"节点不用它做下单侧校验，下限另有部署期约束"——
    部署期约束只管部署脚本，管不到运行期这个环境变量，于是配错时节点绿灯启动、全网下不了单。
  */
  'function minTimeoutBlocks() view returns (uint64)',
  /// @dev 下单超时窗口的**上限**（`Escrow.MAX_TIMEOUT_BLOCKS` = 30 天）；与 `minTimeoutBlocks` 成对，
  ///      同一条启动期自检用它拦住"配得比上限还大"这一侧的越界。
  'function MAX_TIMEOUT_BLOCKS() view returns (uint64)',
  /*
    挂账余额（`_settle` 派发失败时改记到收款方名下，由其 withdrawPayout/withdrawFees 自领）。
    **按地址计**：payouts 读店主地址、fees 读当前全局 feeCollector；合约按**每单创建时快照**的
    收取方扣费，历史收取方的挂账不在这两个读数里（已知边界，见 opsMetrics.accruedReading）。
  */
  'function accruedPayouts(address to) view returns (uint256)',
  'function accruedFees(address collector) view returns (uint256)',
  'function rejectRefund(bytes32 orderId)',
  /*
    委员会只读面（2026-10-18）：`arbiters()` 返回**当前届**成员、`arbiterThreshold()` 是通过票数。
    `isArbiter(addr)` 是当前届成员的 O(1) 判据——节点侧所有"仲裁人视角"鉴权只读它。
    `orderEpoch/orderThreshold/orderArbiters/voteOf/tallyOf` 是**按单**的裁决进度
    （届次在争议发起时冻结；票值 0 也可能是一张有效的票，所以 `voteOf` 同时给 `cast`）。
  */
  'function arbiters() view returns (address[])',
  'function arbiterThreshold() view returns (uint16)',
  'function committeeEpoch() view returns (uint32)',
  'function isArbiter(address who) view returns (bool)',
  // 四份治理 owner + 当前届仲裁人的统一判据（角色互斥在节点侧的唯一读法）
  'function isProtocolGovernance(address who) view returns (bool)',
  // 紧急吊销：只有 revokeArbiter 会置 true；常规 remove/setArbiters 不再吊销（旧届在途单还要旧成员）。
  // 节点侧用它把被紧急吊销的成员挡在证据/PII 之外——合约只拒其投票。
  'function revokedArbiter(address who) view returns (bool)',
  'function orderEpoch(bytes32 orderId) view returns (uint32)',
  'function orderThreshold(bytes32 orderId) view returns (uint16)',
  'function orderArbiters(bytes32 orderId) view returns (address[])',
  'function voteOf(bytes32 orderId, uint8 kind, address who) view returns (bool cast, uint256 value)',
  'function tallyOf(bytes32 orderId, uint8 kind, uint256 value) view returns (uint16)',
  'function feeBps() view returns (uint256)',
  /// @notice 平台治理 owner（角色互斥判据：owner 只能当 owner；节点侧店铺员工登记要拒它）
  'function owner() view returns (address)',
  // 费用收取方（**全局**披露与兜底口径）：扣费判据是**每单**的创建时快照
  // `feeCollectorAtCreate`（getOrder 元组字段，_settle 只读它）。本全局函数在现行合约上仍存在，
  // 但 RPC 读失败时一律 known=false ⇒ 账本对"没有快照的行"按可能扣费处理（保守，见 fees.js）
  'function feeCollector() view returns (address)',
];

export const ESCROW_STATUS = ['None', 'Created', 'Disputed', 'Settled', 'Refunded'];

/**
 * **代次探针清单：本节点在运行时真正调用的、且只存在于新一代 Escrow 上的读法。**
 *
 * 为什么要有这份清单（2026-10-14 审计修订，这是一个真实发生过的失效）：
 * 旧实现把三个探针**内联写死在** `assertEscrowGeneration` 里
 * （`minTimeoutBlocks()` / `releaseNotBeforeBlock()` / `afterSaleOpen()`）。于是出现了一个
 * 恰好穿过那道闸的状态：链上的 Escrow 有这三个读法、却**没有** `totalOpenExposure()` /
 * `sellerOpenExposure()` / `sellerNetAtSettle()`——节点自检**绿灯通过**，然后在运行时逐处死掉
 * （`Staking.payoutFloors` 读 `sellerOpenExposure` ⇒ 四条出金路径整体 revert，而 `/healthz` 一切正常）。
 * 判据与 `Staking._probeEscrow`（探六个读法 + `getOrder` 确切字数）、
 * `MarketplaceRegistry.setStakingContract`（探自己唯一会调用的 `poolOf`）是同一条纪律：
 * **探的必须是会调用的**；分散写三处必然漏，所以清单只能有一份。
 *
 * 入清单的三个条件（缺一不可）：
 *   ① 本节点或它的合约伙伴**真的会调**（不是"存在但没人用"）；
 *   ② 该读法**只在新一代**上存在（旧一代没有 ⇒ 缺它就能判定代次）；
 *   ③ 传零参/零值也**必定成功返回**（探针是只读判定，不能因为"这个 orderId 不存在"就 revert）。
 * 条件③ 排除了 `releaseNotBeforeBlock(bytes32)` 这类对不存在订单会返回 0 的读法吗？不排除——
 * 它传零值返回 0，是安全的。真正要排除的是会 revert 的写法。
 *
 * `shape` 与调用形状逐字对应，探针按 `zeroArg` 构造入参，因此"清单写着 A、代码调 B"不可表达。
 */
export const ESCROW_GENERATION_PROBES = [
  // 下单最小超时窗口：节点读它做展示/运维读数（`opsMetrics`），旧一代没有
  { shape: 'minTimeoutBlocks()', zeroArg: 'none' },
  // 超时释放的阈值块高（前端倒计时 + 节点看板共用判据），2026-10 新增
  { shape: 'releaseNotBeforeBlock(bytes32)', zeroArg: 'bytes32' },
  // 确认收货后的售后案件（本节点 watcher / 对账 / 详情页都读），2026-10 第二批新增
  { shape: 'afterSaleOpen(bytes32)', zeroArg: 'bytes32' },
  // 案件开案区块：/sync 与后台对账按它回填本地镜像
  { shape: 'afterSaleOpenedAtBlock(bytes32)', zeroArg: 'bytes32' },
  // 售后窗口的**按单快照**（罚没资格与买家开案两处都要），2026-10-13 新增
  { shape: 'afterSaleWindowBlocksOf(bytes32)', zeroArg: 'bytes32' },
  // 结算区块：售后窗口的起算点，2026-10-13 新增
  { shape: 'settledAtBlock(bytes32)', zeroArg: 'bytes32' },
  /*
    后三项是**合约伙伴**会调的（本节点不直接调，但节点接错代次就等于把它们一起弄死）：
    `Staking.payoutFloors` 读 `sellerOpenExposure` ⇒ 缺它则四条出金路径整体 revert；
    `Staking._penaltyBase` 读 `sellerNetAtSettle` ⇒ 缺它则罚没 fail-closed（上限 0）；
    `Staking` 的构造期探针与 Escrow 侧不变量对拍都用 `totalOpenExposure`。
    把"别人的判据"也算进本节点的代次门禁，理由很直接：这三项缺一个，店主就提不出钱，
    而节点日志里一个字都不会说——正是这道自检存在的理由。
  */
  { shape: 'sellerOpenExposure(address)', zeroArg: 'address' },
  { shape: 'sellerNetAtSettle(bytes32)', zeroArg: 'bytes32' },
  { shape: 'totalOpenExposure()', zeroArg: 'none' },
  /*
    多店模型（2026-10）新增的两项，同样是"探的必须是会调用的"：
      · `commissionTermsAtCreate(bytes32)`：买家侧下单要把条款带进 createOrder，节点侧账本要回答
        "这一单被抽了多少"；缺它说明接的是没有多店分账的那一代托管；
      · `commissionAtSettle(bytes32)`：抽成腿的**唯一真相**（结算时落库的实数）。
    另注：`createOrder` 本身多了第 5 个参数，但**探针只能探只读读法**（`zeroArgsFor` 构造的是
    零值入参、且探针要"传零值也必定成功返回"）——写法是没法这样探的。所以代次判据落在上面两个
    只读视图上，写法的形状由**买家钱包侧**在编码参数时自然暴露（参数个数不对会直接失败）。
  */
  { shape: 'commissionTermsAtCreate(bytes32)', zeroArg: 'bytes32' },
  { shape: 'commissionAtSettle(bytes32)', zeroArg: 'bytes32' },
  /*
    委员会（2026-10-18：单仲裁人 → 多仲裁人 + 阈值）。`chain.getCommittee` /
    `chain.committeeForOrder` 在运行时真的会调这六个读法，其中按单的三个是**订单级裁决资格**
    的唯一来源（争议发起时快照届次；见 committeeForOrder 的说明）。
    漏探其中任何一个的后果与文件头那次事故同形：启动绿灯，而"谁有资格裁决这一单"在运行时
    读不到 ⇒ 仲裁人打不开详情/附件，且日志里只有一句"读不到"。
  */
  { shape: 'arbiters()', zeroArg: 'none' },
  { shape: 'arbiterThreshold()', zeroArg: 'none' },
  { shape: 'committeeEpoch()', zeroArg: 'none' },
  // 被解除/换届移除的仲裁人即使还留在旧届 orderArbiters 名单里，也不能再读该单 PII/证据
  { shape: 'revokedArbiter(address)', zeroArg: 'address' },
  { shape: 'orderEpoch(bytes32)', zeroArg: 'bytes32' },
  { shape: 'orderArbiters(bytes32)', zeroArg: 'bytes32' },
  { shape: 'orderThreshold(bytes32)', zeroArg: 'bytes32' },
];

/** 按 `zeroArg` 造零值入参（探针入参的唯一构造处，与清单同源） */
function zeroArgsFor(kind) {
  if (kind === 'none') return [];
  if (kind === 'address') return ['0x0000000000000000000000000000000000000000'];
  if (kind === 'bytes32') return ['0x' + '00'.repeat(32)];
  throw new Error(`ESCROW_GENERATION_PROBES 里有未知的 zeroArg 种类：${kind}`);
}

/**
 * 启动期链 ID 自检（源码审计 2026-09）：staticNetwork: true 会让 ethers 跳过与节点协商网络，
 * 于是把 MK_RPC_URL 配到别的链（测试网/分叉）不会被发现——而 receipt/日志校验的**信任根**就是这条 RPC：
 * 一旦指错链，别处的同名合约事件会驱动本地托管状态与账本。故启动时显式比对一次 eth_chainId，
 * 不一致直接抛错（进程退出优于静默按错误的链运行）。
 */
export async function assertChainId() {
  const got = Number(await getProvider().send('eth_chainId', []));
  if (got !== config.chain.chainId) {
    throw new Error(
      `RPC 链 ID 不匹配：MK_RPC_URL 指向 chainId ${got}，配置为 ${config.chain.chainId}——请修正 MK_RPC_URL 后重启`
    );
  }
  return got;
}

/**
 * 启动期**下单超时窗口自检**（2026-10-14）。
 *
 * 为什么必须有它：`MK_ESCROW_TIMEOUT_BLOCKS`（默认 120960 ≈ 7 天）是**本节点自己**填进订单草稿的值，
 * 买家只是照签（见 `routes/shop.js` 把它当店铺信息下发）。而合约对它有**常量下界**
 * （`MIN_ORDER_TIMEOUT_BLOCKS` = 1 天 = 17280 块）与上限（`MAX_TIMEOUT_BLOCKS` = 30 天 = 518400 块）：
 * 配置越界时 `Escrow.createOrder` 会以 `TimeoutTooShort` / `InvalidTimeout` 直接回滚。
 * 后果的形状很坏——**节点启动绿灯、店面看起来在营业、商品能浏览，但全网每一笔下单都失败**，
 * 而错误只在买家的钱包里以一次 revert 出现。运营方看到的是"没人下单"。
 *
 * 与仓库既有纪律的关系：本仓对"配置错误型 DoS"一律在**入口**拦掉
 * （`MarketplaceRegistry.setStakingContract` 探 `poolOf`、`server.js` 的库结构/密钥/风控闸/合约代次自检）。
 * 这一条此前是唯一漏网的：`node/src/chain.js` 的注释写着"节点不用 minTimeoutBlocks 做下单侧校验，
 * 下限另有部署期约束"——而**部署期约束只管部署脚本**，管不到运行期这个环境变量。
 *
 * 判据只有一处：链上 `minTimeoutBlocks()` / `MAX_TIMEOUT_BLOCKS()`（合约自己的读数），
 * 不在节点里再抄一份常量（抄一份就是第二个真相，合约改常量时它必然漂移）。
 *
 * **三档而不是两档**（2026-10-14 独立评审后收口）：只有"读到了链上界、且配置越界"才算
 * `blocked`；`unknown`（读不到 / 配置值本身非法）**不阻断启动**，只把结论留在
 * `orderTimeoutSelfCheck()` 里、由 `/healthz` 与启动日志说出来。理由：
 *   · 把"读不到"升格成"拒绝启动"，等于让**一次 RPC 抖动**停掉一个本来配置正确的节点——
 *     而缺省值（120960 = 7 天）本来就在合法区间内，停服换不来任何安全；
 *   · 与仓库既有口径一致：`opsMetrics` / `feeStatus` / `committeeStatus` 对"读不到"一律给
 *     **独立的一档**（available:false / known:false），绝不与"确证有问题"合并。
 * 代价如实写明：真读到越界之前，节点会带着一个"可能付不了款"的配置继续跑——所以
 * `unknown` 在启动日志里是**显眼的警告**，且 `/healthz` 能查到。
 *
 * @returns {{ verdict: 'ok'|'blocked'|'unknown', reason: 'ok'|'too-low'|'too-high'|'unreadable'|'invalid-config',
 *             configured: number, min: number|null, max: number|null, message: string }}
 */
export async function checkOrderTimeoutBounds() {
  const configured = Number(config.escrow.timeoutBlocks);
  const base = { configured, min: null, max: null };
  if (!Number.isFinite(configured) || configured <= 0) {
    return {
      ...base,
      verdict: 'unknown',
      reason: 'invalid-config',
      message: `MK_ESCROW_TIMEOUT_BLOCKS 不是正整数（${String(config.escrow.timeoutBlocks)}）——这份草稿的超时窗口无法确定`,
    };
  }
  let min;
  let max;
  try {
    const escrow = getEscrow();
    min = Number(await escrow.minTimeoutBlocks());
    max = Number(await escrow.MAX_TIMEOUT_BLOCKS());
  } catch (e) {
    return {
      ...base,
      verdict: 'unknown',
      reason: 'unreadable',
      message: `读不到链上下单超时窗口的上下界（minTimeoutBlocks / MAX_TIMEOUT_BLOCKS）：${String(
        e?.shortMessage || e?.message || e
      ).slice(0, 80)}`,
    };
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
    return {
      ...base,
      verdict: 'unknown',
      reason: 'unreadable',
      message: `链上返回的窗口上下界不可用（min=${min} max=${max}）`,
    };
  }
  base.min = min;
  base.max = max;
  if (configured < min) {
    return {
      ...base,
      verdict: 'blocked',
      reason: 'too-low',
      message:
        `MK_ESCROW_TIMEOUT_BLOCKS=${configured} 低于链上下界 ${min}（Escrow.minTimeoutBlocks）：` +
        `每一笔 createOrder 都会被 TimeoutTooShort 回滚——买家付不了款。请设为 ≥ ${min}（生产建议 120960 ≈ 7 天）后重启`,
    };
  }
  if (configured > max) {
    return {
      ...base,
      verdict: 'blocked',
      reason: 'too-high',
      message:
        `MK_ESCROW_TIMEOUT_BLOCKS=${configured} 超过链上上限 ${max}（Escrow.MAX_TIMEOUT_BLOCKS）：` +
        `每一笔 createOrder 都会被 InvalidTimeout 回滚。请设为 ≤ ${max} 后重启`,
    };
  }
  return { ...base, verdict: 'ok', reason: 'ok', message: `下单超时窗口 ${configured} 块在链上允许区间 [${min}, ${max}] 内` };
}

/**
 * 最近一次下单超时窗口自检的结论（进程内状态，供 `/healthz` 与排障）。
 *
 * 为什么要留这个读数：`checkOrderTimeoutBounds` 在启动期只跑一次，而它的 `unknown` 档
 * **不阻断启动**（见上）——那一档必须有个地方能看见，否则"这次没校验成"就随日志一起丢了。
 * 与 `committeeStatus()` / `feeStatus()` 同款：**"读不到"要能作为一个独立结论被看见**。
 */
let _orderTimeoutCheck = null;
/** @param {object|null} v 自检结论（`checkOrderTimeoutBounds` 的返回值） */
export function setOrderTimeoutSelfCheck(v) {
  _orderTimeoutCheck = v;
}
/** @returns {object|null} 最近一次自检结论；从未跑过时为 null */
export function orderTimeoutSelfCheck() {
  return _orderTimeoutCheck;
}

/**
 * 启动期**托管合约代次自检**（2026-10-13；2026-10-14 改为清单驱动）。
 *
 * 为什么必须有它（真实事故的形状）：本节点代码会调用 2026-10 那一代 Escrow 的只读入口
 * （`releaseNotBeforeBlock` / `afterSaleOpen` / `minTimeoutBlocks` …），而"链上部署的是哪一代"
 * 与"仓库里是哪一代"是两件独立的事——换批要么漏改 `MK_ESCROW_ADDRESS`、要么根本没重部署。
 * 两种情况下节点都**照常启动**，然后在运行时逐处降级：超时看板整列读不到、售后案件永远为空、
 * 关键加固静默缺席——现象与原因相隔十万八千里（正是本仓"库缺一列必须拒绝启动"要防的那一类）。
 *
 * 判据：`ESCROW_GENERATION_PROBES` 里**每一个**形状都必须读得出来（清单是唯一真相，见它的说明）。
 * 链 ID 自检在本函数之前跑过，所以"读不到"在这里只能意味着**合约不是这一代**（而不是 RPC 不可达）。
 * 逃生口 `MK_CONTRACT_GEN_ACK=1`（与本仓 `MK_ESCROW_CHANGE_ACK` 同款）：确有需要时显式声明，
 * **不设静默降级**。返回 `{ ok, missing, probed }`，由 server.js 决定拒绝启动还是放行并告警。
 *
 * ⚠️ **这条自检曾经漏过**（2026-10-14 审计 H2）：旧实现把三个探针内联写死在这里，
 * 于是"链上有这三个读法、却没有 `sellerOpenExposure`"的 Escrow 能让节点**绿灯启动**，
 * 然后在运行时把四条出金路径整体弄死（`payoutFloors` 读不到敞口 ⇒ 店主提不出质押），
 * 而 `/healthz` 一切正常。现在探针清单只有一份，并由
 * `test/escrow-generation-probes.test.js` 守着它与 ABI、与合约源码、与"必须覆盖的读法"三者一致。
 */
export async function assertEscrowGeneration() {
  const escrow = getEscrow();
  const missing = [];
  /*
    探针逐个来自 ESCROW_GENERATION_PROBES（**唯一清单**，见它的说明）：清单是"会调用的读法"，
    新增一处依赖就在这里加一行，而不是在别处再写一次 if。
    判据：读得到 = 这一代；读不到（链 ID 已在上一步自检过，所以不是 RPC 不可达）= 不是这一代。
  */
  for (const { shape, zeroArg } of ESCROW_GENERATION_PROBES) {
    if (!escrow[shape.split('(')[0]]) {
      // ABI 里没有这个片段 ⇒ 是清单与 ABI 漂移（配置期错误，不该等到运行时报"合约不对"）
      missing.push(`${shape}（本节点的 Escrow ABI 里没有这个片段——清单与 ABI 漂移了）`);
      continue;
    }
    try {
      await escrow[shape.split('(')[0]](...zeroArgsFor(zeroArg));
    } catch (e) {
      missing.push(`${shape}（${String(e?.shortMessage || e?.message || e).slice(0, 60)}）`);
    }
  }
  return { ok: missing.length === 0, missing, probed: ESCROW_GENERATION_PROBES.length };
}

let _provider = null;
/** 获取 provider（惰性单例） */
export function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(config.chain.rpcUrl, {
      chainId: config.chain.chainId,
      name: 'bityuan',
    }, { staticNetwork: true });
  }
  return _provider;
}

const ERC1271_IFACE = new ethers.Interface([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function isValidSignature(bytes data, bytes signature) view returns (bytes4)',
]);
const ERC1271_MAGIC = '0x1626ba7e';
const SAFE_LEGACY_MAGIC = '0x20c13b0b';

/** `eth_getCode` 短缓存 + 单次超时：1271 验签不能被一次挂死的 RPC 拖住整个请求。 */
const CODE_CACHE_TTL_MS = 60_000;
const CODE_CACHE_MAX = 500;
const CODE_CALL_TIMEOUT_MS = 1_200;
const _codeCache = new Map(); // address -> { at, code }

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout > ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function rememberCode(key, code, now) {
  if (_codeCache.size >= CODE_CACHE_MAX) {
    for (const [k, v] of _codeCache) {
      if (now - v.at >= CODE_CACHE_TTL_MS) _codeCache.delete(k);
    }
    while (_codeCache.size >= CODE_CACHE_MAX) {
      _codeCache.delete(_codeCache.keys().next().value);
    }
  }
  _codeCache.set(key, { at: now, code });
}

async function codeAt(address, provider) {
  const key = String(address).toLowerCase();
  const now = Date.now();
  const hit = _codeCache.get(key);
  if (hit && now - hit.at < CODE_CACHE_TTL_MS) return hit.code;
  const code = await withTimeout(provider.getCode(key), CODE_CALL_TIMEOUT_MS);
  rememberCode(key, code, now);
  return code;
}

/** 把 32 字节 inner 或 SIWE 原文转成 `bytes`；hex 字符串按字节解，普通字符串按 UTF-8 */
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  const s = String(value ?? '');
  return s.startsWith('0x') ? ethers.getBytes(s) : ethers.toUtf8Bytes(s);
}

async function call1271(provider, signer, data) {
  const ret = await withTimeout(provider.call({ to: String(signer).toLowerCase(), data }), CODE_CALL_TIMEOUT_MS);
  return String(ret || '0x');
}

/**
 * 合约账户的 1271 验签（**唯一实现**）：先按标准 EIP-1271 验 `isValidSignature(digest, sig)`，
 * 再按 Safe v1.3 `CompatibilityFallbackHandler` 的 legacy `isValidSignature(inner, sig)` 验。
 *
 * 为什么两条（2026-10-21 复审修 H1）：
 *   · 标准 1271：`digest` = EIP-191 外层（`hashMessage(inner)`），返回 `0x1626ba7e`；
 *   · Safe `signMessage(inner)` 签的是 Safe EIP-712 的 `SafeMessage(inner)`；Safe 的 bytes32
 *     重载会把 digest 再包成 `SafeMessage(abi.encode(digest))`，所以标准路径永远不中。
 *     它对应的是 legacy bytes 重载（选择器/旧魔数 `0x20c13b0b`），必须传 **inner 原始字节**。
 *
 * 两次调用都是 fail-closed；调用方先做离线 ECDSA，未命中才进来。
 */
export async function isValidContractSignature(signer, inner, digest, signature, provider = null) {
  if (!isAddress(signer)) return false;
  let p;
  try {
    p = provider || getProvider();
    const code = await codeAt(signer, p);
    if (code === '0x') return false;
  } catch {
    return false;
  }

  try {
    const data = ERC1271_IFACE.encodeFunctionData('isValidSignature(bytes32,bytes)', [
      String(digest),
      String(signature),
    ]);
    const ret = await call1271(p, signer, data);
    const decoded = ERC1271_IFACE.decodeFunctionResult('isValidSignature(bytes32,bytes)', ret);
    if (String(decoded[0]).toLowerCase() === ERC1271_MAGIC) return true;
  } catch {
    // 标准重载不可用/不认：继续试 Safe legacy
  }

  try {
    const data = ERC1271_IFACE.encodeFunctionData('isValidSignature(bytes,bytes)', [
      asBytes(inner),
      String(signature),
    ]);
    const ret = await call1271(p, signer, data);
    const decoded = ERC1271_IFACE.decodeFunctionResult('isValidSignature(bytes,bytes)', ret);
    const magic = String(decoded[0]).toLowerCase();
    return magic === SAFE_LEGACY_MAGIC || magic === ERC1271_MAGIC;
  } catch {
    return false;
  }
}

/** 获取 Escrow 合约实例（只读调用/事件过滤；签名交易由钱包侧发起） */
export function getEscrow() {
  if (!config.chain.escrowAddress) {
    throw new Error('MK_ESCROW_ADDRESS 未配置（合约部署后填入）');
  }
  return new ethers.Contract(config.chain.escrowAddress, ESCROW_ABI, getProvider());
}

/**
 * MarketplaceRegistry 的**只读** ABI（店铺身份 = 店主 × 节点，2026-10-16；2026-10-18 角色重构）。
 *
 * 为什么节点也要读 Registry：店铺的**卖家地址与节点费率**是链上事实（`ShopInfo`），
 * 而节点是**缓存**——本地 shops 表要与它逐条对账（见 `termsReconciler`）。
 * 费率自 2026-10-18 起**只有节点主能改**（`setShopCommission`，立即生效、此后创建的订单按新比例快照），
 * 所以本地这份读数是"链上的镜像"，不是"节点说了算"。
 *
 * `ShopInfo` 字段顺序与合约**逐字段对应**（ABI 元组按位置解码，错一位不会报错、只会读成相邻字段）：
 * host / seller / commissionBps / registeredAtBlock / hostSuspendedAtBlock / exitedAtBlock / code
 * （2026-10-18 删掉 termsDelistedAtBlock：协商费率整条流程已删除，"能不能卖"只问 `shopListed`）
 *
 * ⚠️ **抽成收款人不在结构体里**：它不是可配字段，恒为 `host`（节点地址）——
 * 谁提供基础设施，抽成就给谁。下单时 `commissionTo` 必须等于它，Escrow 在
 * `createOrder` 里读 `shopStateOfByCode` 逐字核验（买方不能自签一个别的收款人）。
 *
 * ⚠️ 店的身份是 **(店主, 节点)** 这一对，所以读一家店要两个参数（`getShop(seller, host)`），
 * 而"这家店现在能不能卖"问的是**编号**（`shopListed(code)`）——编号才是"哪一家店"的钥匙。
 *
 * ⚠️ **`code` 是 `bytes32`，不是 `string`**（2026-10-15 修）：合约里 `ShopInfo.code` 存的是
 * `_mintShopCode` 的返回值（`bytes32`），只有**事件**里才用 `_codeString(code)` 转成 9 位字符串。
 * 按 `string` 声明会让整族读法在链上必然失败（元组末位错型 ⇒ ethers 解码直接抛错），
 * 而 `termsReconciler` 对单店读失败是"本轮跳过"（读不到 ≠ 已暂停），于是整族对账静默失效。
 * 要 9 位字符串的地方一律过 `shopCodeFromChain()`（唯一转换点）。
 */
const SHOP_TUPLE =
  '(address host, address seller, uint16 commissionBps, uint64 registeredAtBlock, uint64 hostSuspendedAtBlock, uint64 exitedAtBlock, bytes32 code)';
/**
 * `getShop` 返回的 `ShopInfo` 字段数（与 `SHOP_TUPLE` 一一对应）。
 *
 * 为什么把这个数单列出来：`assertRegistryGeneration` 要能在**不信任元组内容**的前提下判断
 * "链上那一代 Registry 的 `ShopInfo` 是不是这一版"。字段变少时 ethers 多数情况下会直接解码失败，
 * 但"正好多/少了尾部动态项"这类形状可以解出数组而不报错——探针同时核对长度，两个判据缺一不可。
 */
const SHOP_INFO_FIELDS = 7;
export const REGISTRY_ABI = [
  `function getShopByCode(bytes32 code) view returns (tuple${SHOP_TUPLE} shop)`,
  `function getShop(address seller, address host) view returns (tuple${SHOP_TUPLE} shop)`,
  `function codeOf(address operator) view returns (string code)`,
  /*
    "这家店现在能不能卖"的**唯一判据**（合约侧把四个来源合成一个读数：编号解析得到一家在册的店、
    未被节点主/员工暂停、所属节点在册且未停用、未被协议侧拉黑）。
    参数是**编号**（不是店主地址）：一个钱包在几个节点下就有几家店，地址回答不了"哪一家"。
  */
  `function shopListed(bytes32 code) view returns (bool)`,
  /// @notice 下单闸读法：该店的当前费率 + 是否在售（Escrow 在 createOrder 里用同一处判据）
  'function shopStateOfByCode(bytes32 shopCode, address seller) view returns (address host, uint16 commissionBps, bool listed)',
  /*
    节点员工（2026-10-18）：`staffNode` 是 O(1) 反查（一个地址最多属于一个节点），
    `nodeStaff` 是可枚举名单。员工与节点主同权限（审批开店、停用/恢复店铺），
    但**不能**改费率、不能注销/转让节点、不能任命其他员工。
  */
  'function staffNode(address who) view returns (address)',
  'function nodeStaff(address operator) view returns (address[])',
  'function isNodeStaff(address who) view returns (bool)',
  /*
    **被强制关闭的节点员工**（`_forceClose` 的链上事实源，2026-10-18）。
    节点侧所有"这个人还算不算经营/管理身份"的判据都必须再问它一次：被 forceClose 的地址
    仍然可能留在 `shop_operators` 或旧缓存的 `staffNode` 里，而治理身份判据
    `Escrow.isProtocolGovernance` 对"被强制关闭的当前届仲裁人"已返回 false——只靠它挡不住。
    读不到 = 不能确认 ⇒ 按"不能给权限"处理（见 isForceClosedAddress 的三态说明）。
  */
  'function isForceClosed(address who) view returns (bool)',
  /*
    开店登记事件（2026-10-18）：节点按交易哈希核验"已上链"时，**只认这条事件**——
    交易"碰过 Registry"不等于它就是本申请的 registerShop（可能是暂停/换费率/别人的店）。
    字段与 MarketplaceRegistry.ShopRegistered 逐字对应（code 在事件里是 9 位字符串）。
  */
  'event ShopRegistered(address indexed host, address indexed seller, string code, uint16 commissionBps)',
  'function minStakeToOpenShop() view returns (uint256)',
  'function MAX_COMMISSION_BPS() view returns (uint16)',
];


/**
 * 链上 `ShopInfo.code`（`bytes32`，尾部补零）→ 9 位编号字符串（**唯一转换点**）。
 *
 * 为什么必须有一个：同一个编号在链上有两种形状——结构体里是 `bytes32`，事件里是 `string`。
 * 各处自己 `ethers.decodeBytes32String` 就会出现"某一处忘了转"，而症状是编号里带着
 * `\u0000` 或直接抛错（`decodeBytes32String` 对非 UTF-8 尾部会失败）。
 * 读不到/解不出 ⇒ 返回 `''`（调用方按"没有编号"处理，绝不编造一个）。
 */
export function shopCodeFromChain(v) {
  if (v === undefined || v === null) return '';
  try {
    return ethers.decodeBytes32String(v);
  } catch {
    return '';
  }
}

/** 9 位编号字符串 → 链上 `bytes32`（`getShopByCode` / `shopListed` 等按编号读的入参形状） */
export function shopCodeToChain(code) {
  return ethers.encodeBytes32String(String(code || ''));
}

/** Registry 事件解码器（与 REGISTRY_ABI 同一个定义；只在核验开店回执时用） */
const REGISTRY_IFACE = new ethers.Interface(REGISTRY_ABI);

/**
 * 从交易回执里取出**本节点 Registry 的 `ShopRegistered` 事件**（唯一实现）。
 *
 * 为什么必须是事件而不是"日志里出现过 Registry 地址"：`registerShop` 只是 Registry 的
 * 众多入口之一——暂停店铺、改费率、停用节点、甚至别人登记另一家店，回执里都带 Registry 日志。
 * 只判"碰过合约"会让节点把一笔不相干的交易记为 `registered_tx`（本地出现了链上根本没发生的店）。
 * 解码失败/不是这条事件/地址不对 ⇒ 返回 null（调用方拒绝落库，不猜）。
 *
 * @param {Array} logs 回执 logs
 * @param {string} registryAddress 本节点 Registry 地址
 * @returns {null | {host:string, seller:string, code:string, commissionBps:number}}
 */
export function shopRegisteredEventFromLogs(logs, registryAddress) {
  const registry = String(registryAddress || '').toLowerCase();
  if (!registry) return null;
  for (const log of logs || []) {
    if (String(log?.address || '').toLowerCase() !== registry) continue;
    let parsed = null;
    try {
      parsed = REGISTRY_IFACE.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed || parsed.name !== 'ShopRegistered') continue;
    return {
      host: String(parsed.args.host || '').toLowerCase(),
      seller: String(parsed.args.seller || '').toLowerCase(),
      code: String(parsed.args.code ?? ''),
      commissionBps: Number(parsed.args.commissionBps),
    };
  }
  return null;
}

/** 获取 Registry 合约实例（只读） */
export function getRegistry() {
  if (!config.chain.registryAddress) {
    throw new Error('MK_REGISTRY_ADDRESS 未配置（合约部署后填入）');
  }
  return new ethers.Contract(config.chain.registryAddress, REGISTRY_ABI, getProvider());
}

/**
 * 启动期 **Registry 代次自检**：探本版本代码真正会调、且只存在于当前这一代 Registry 的读法。
 *
 * 为什么需要它：Escrow 代次自检只证明托管合约对得上；而节点还会读 Registry 的店铺元组
 * （`getShop(seller, host)` 的 `ShopInfo` 字段序）与员工名单（`staffNode` / `nodeStaff`，
 * 2026-10-18 新增）。接上更早一代 Registry 时节点照样启动，然后：
 *   · `getShop` 按位置解码失败 ⇒ 店铺对账整轮静默跳过（本地 `listed` 再也不更新）；
 *   · `staffNode` 不存在 ⇒ 节点员工永远鉴权失败，而日志只有一条 RPC 读不到。
 * 与 Escrow 那条同一道纪律：**探的必须是会调用的**，探不到就拒绝启动。
 *
 * `getShop` 的判据有两条（缺一不可）：①调用能成功（缺函数/元组形状不符 ⇒ 抛错）；
 * ②返回的字段数 == `SHOP_INFO_FIELDS`（尾部可解码但少/多一项时只有长度能发现）。
 * 参数传零值是安全的：`_shopOf[0][0]` 是空结构体，所有字段为 0。
 *
 * @param {object|null} registry 测试注入用；缺省读配置里的 Registry 实例
 * @returns {Promise<{ok:boolean, skipped:boolean, missing:string[], probed:number}>}
 */
export async function assertRegistryGeneration(registry = null) {
  if (!registry && !config.chain.registryAddress) {
    return { ok: true, skipped: true, missing: [], probed: 0 };
  }
  const r = registry || getRegistry();
  const missing = [];
  const errText = (e) => String(e?.shortMessage || e?.message || e).slice(0, 60);
  try {
    const shop = await r.getShop(ethers.ZeroAddress, ethers.ZeroAddress);
    const arity = shop?.length;
    if (Number(arity) !== SHOP_INFO_FIELDS) {
      missing.push(
        `getShop(address,address)（返回 ${arity ?? '?'} 个字段，本版本需要 ${SHOP_INFO_FIELDS} 个——` +
          'Registry 的 ShopInfo 形状不是这一代）'
      );
    }
  } catch (e) {
    missing.push(`getShop(address,address)（${errText(e)}）`);
  }
  for (const [shape, args] of [
    ['staffNode(address)', [ethers.ZeroAddress]],
    ['nodeStaff(address)', [ethers.ZeroAddress]],
    ['isForceClosed(address)', [ethers.ZeroAddress]],
    ['shopListed(bytes32)', [ethers.ZeroHash]],
  ]) {
    try {
      await r[shape.split('(')[0]](...args);
    } catch (e) {
      missing.push(`${shape}（${errText(e)}）`);
    }
  }
  return { ok: missing.length === 0, skipped: false, missing, probed: 5 };
}

/**
 * **链上黑名单**（`Blocklist`，owner 维护，全网共享）的只读 ABI（2026-10）。
 *
 * 三类条目（`kind` 的数值是跨合约契约，`MarketplaceRegistry` 侧把 `Shop` 当成 0 用）：
 *   0 = Shop（店铺编号）/ 1 = Product（商品编号 = `products.slug`）/ 2 = Address（钱包地址）
 *
 * ⚠️ **两大类按字节存，`Shop` 类在合约里做大小写归一**（2026-10-16）：查地址前必须
 * `.toLowerCase()`（节点侧 `addressBlocked` 已经这么做并校验形状），查商品按 `products.slug`
 * 原样字节；而店铺编号**只有全大写这一种规范形**（Crockford Base32，见 `ShopCode.sol`），
 * 所以 `Blocklist._keyOf` 对 `Shop` 折大写 —— 治理用小写编号封店也能真正生效
 * （此前那条路径静默失效：条目进了名单、`shopListed` 依然为真）。消费端因此不必再折，
 * 折了也无害（同一个键）。
 */
const BLOCKLIST_ABI = [
  'function isBlocked(uint8 kind, string value) view returns (bool)',
  'function isBlockedMany(uint8 kind, string[] values) view returns (bool[])',
  'function entries(uint8 kind, uint256 offset, uint256 limit) view returns (tuple(uint8 kind, string value, uint64 addedAtBlock, string reason)[])',
  'function countOf(uint8 kind) view returns (uint256)',
  'function entryCount() view returns (uint256)',
];

/** 三类条目的 kind 数值（与 `Blocklist.Kind` 逐值对应；改合约枚举顺序必须同批改这里） */
export const BLOCK_KIND = { SHOP: 0, PRODUCT: 1, ADDRESS: 2 };

/** 获取 Blocklist 合约实例（只读）；未配置即抛错——"读不到名单"与"没有名单"是两件事 */
export function getBlocklist() {
  if (!config.chain.blocklistAddress) {
    throw new Error('MK_BLOCKLIST_ADDRESS 未配置（合约部署后填入）');
  }
  return new ethers.Contract(config.chain.blocklistAddress, BLOCKLIST_ABI, getProvider());
}

/**
 * 测试注入点（与 `chainOrder.setChainOrderFetcher` 同款，**唯一**一处）：
 * 让单测能在不起假 JSON-RPC 服务器的前提下验证"名单命中/未命中/读不到"三条分支。
 *
 * 为什么需要它（而不是继续用假 RPC 桩）：本文件的两个消费方（下单闸、公开列表）
 * 要验证的是**判据与控制流**——命中拒绝、不命中的放行、读不到时 fail-closed。
 * 用假 RPC 去验证这三条，等于把"ethers 的批量解码 + 桩的编码"一起拖进被测范围，
 * 而它一旦出错，症状是"看起来像实现问题"（本次自审就在这里绕了一圈）。
 * 注入点只替换**取值**，判据与控制流仍然是被测的真实代码。
 *
 * @param {{addressBlocked:(addr:string)=>boolean, blockedProducts:()=>string[]}|null} reader
 *        传 null 恢复默认（真实链上读取）
 */
export function setBlocklistReader(reader) {
  _blocklistReader = reader || null;
  _blockedSlugsCache = null;
}
let _blocklistReader = null;

/**
 * 某地址是否在链上名单的 `Address` 类里（供下单闸）。
 *
 * **失败原样上抛**，调用方按"读不到"处理——由 `orderGate` 决定 fail-closed
 * （名单读不到时拒单，与"该店风控服务不可达即拒单"同一条纪律）。
 */
export async function addressBlocked(addr) {
  const v = String(addr || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(v)) return false;
  /*
    ⚠️ **`!!` 必须作用在 `await` 之后**（2026-10-15 修，P0）：
    原先写的是 `return !!getBlocklist().isBlocked(...)` —— 没有 `await`，
    于是 `!!` 作用在一个 **Promise 对象**上，而 Promise 恒为真 ⇒ **任何地址都被判定为"已冻结"**。
    症状不是"少拦了几个"，而是**该节点再也接不了一张单**：下单闸把每一位买家都当成全网冻结地址
    拒掉（`该钱包地址已被列入全网冻结名单`——一句对全部顾客的错误指控）。

    为什么一直没被发现（两个原因都要记住）：
      · 单测走 `setBlocklistReader` 注入（**同步**桩）⇒ `!!` 作用在布尔上，是对的，测试全绿；
      · 演示栈从未配置 `MK_BLOCKLIST_ADDRESS` ⇒ 这条真实路径从来没被执行过一次。
    两者合起来就是"判据被测试覆盖了、但被测的那条路径不是生产走的那条"。
    注入点现在允许 async（真实读取本来就是 async），由 test/blocklist-gate.test.js 钉住。
  */
  if (_blocklistReader) return !!(await _blocklistReader.addressBlocked(v));
  return !!(await getBlocklist().isBlocked(BLOCK_KIND.ADDRESS, v));
}

/**
 * **全部被冻结的商品编号**（`Product` 类），带 TTL 缓存——供公开列表的 `NOT IN` 过滤。
 *
 * 为什么是"拉全量"而不是"按一批编号逐个问"：那一批编号是**本页**的商品，
 * 而过滤必须发生在 SQL 里（见 `routes/products.js` 的说明），所以需要的是"整份名单"。
 *
 * **名单超出单次可读上限时抛错，绝不返回被截断的名单**：读回 500 条而实际有 600 条，
 * 等于静默放过 100 件被冻结的商品——那是本条最坏的失败形态（看起来一切正常）。
 *
 * @param {number} maxEntries 单次可读上限（调用方给出的参数个数预算）
 * @returns {Promise<Set<string>>} 命中的商品编号（`products.slug` 原样大小写）
 */
export async function blockedProductSlugs(maxEntries = 500) {
  const now = Date.now();
  if (_blockedSlugsCache && now - _blockedSlugsCache.at < BLOCKED_SLUGS_TTL) return _blockedSlugsCache.set;
  const out = new Set();
  if (_blocklistReader) {
    // 注入路径：只回答"这一批里哪些命中"（与真实实现同一条 `NOT IN` 语义）。
    // 与 `addressBlocked` 同款：注入点可以是 async，`await` 之后再迭代——
    // 少了 `await` 会去迭代一个 Promise（抛 "is not iterable"），不是静默错，但同样是错的。
    /*
      ⚠️ **`|| []` 是错的形状**（2026-10-16 修，与 `addressBlocked` 同批）：桩返回
      `undefined`/`null` 会被读成"名单为空"⇒ 所有被冻结商品**放行**，而测试照旧全绿
      ——这正是本文件在 `addressBlocked` 那里刚记过的同一类坑（判据被测试覆盖了，
      但被测的那条路径不是生产走的那条）。所以这里区分"空名单"（数组、长度 0）
      与"读不出来"（不是数组）：后者**抛错**，与生产路径 `total > maxEntries` 时抛错同向
      （fail-closed：宁可列表读不出来，也不静默放过被冻结的商品）。
    */
    const stub = await _blocklistReader.blockedProducts();
    if (!Array.isArray(stub)) {
      throw new Error('blocklist 读取器返回的不是数组（读不到名单 ≠ 名单为空）——拒绝按"没有冻结商品"继续');
    }
    for (const s of stub) out.add(String(s));
    _blockedSlugsCache = { at: now, set: out };
    return out;
  }
  const c = getBlocklist();
  const total = Number(await c.countOf(BLOCK_KIND.PRODUCT));
  if (total > maxEntries) {
    throw new Error(
      `链上名单的商品类条目有 ${total} 条，超过本节点单次可读上限（${maxEntries} 条）——` +
        `请在治理侧收敛名单`
    );
  }
  if (total > 0) {
    const rows = await c.entries(BLOCK_KIND.PRODUCT, 0, total);
    for (const r of rows) out.add(String(r.value));
  }
  _blockedSlugsCache = { at: now, set: out };
  return out;
}

/** 仅供测试：清空商品类名单缓存（与 resetShopCodeCache 同款注入点） */
export function resetBlockedProductSlugsCache() {
  _blockedSlugsCache = null;
}

let _blockedSlugsCache = null;
const BLOCKED_SLUGS_TTL = 30_000;

/** 地址是否为 address(0)（零地址判定；NFT 合约地址非零校验用，见 products.js） */
export function isZeroAddress(addr) {
  return !addr || addr === '0x0000000000000000000000000000000000000000';
}

export function isAddress(v) {
  try {
    return ethers.isAddress(v);
  } catch {
    return false;
  }
}

/**
 * wei（十进制串 / bigint）→ 小数（按 decimals，默认 18）展示串；**读不到就返回 `null`**。
 *
 * 三态（2026-10 生产化清理，与前端 `utils/arbiterMoney.weiBig`、本仓 `readRefundedWei` 同一判据）：
 * 只认 `/^\d+$/`（可带首尾空白）的十进制 wei；`null`/`undefined`/空串/畸形/负数/`0x…`/小数
 * **一律 `null`** —— 不返回 `'0'`。
 *
 * 为什么不能返回 `'0'`：这些 `*Decimal` 字段直接进 DTO 给界面显示。返回 `'0'` 等于替链上说了一句
 * 它没说过的话（"这笔钱是 0"），而调用方的来源里有一半是**RPC 解出来的值**（`stakingRisk` 的
 * minStake/pool/shortfall、`opsMetrics` 的费率），没有 `NOT NULL` 那种库层门禁挡着 ⇒
 * "读不到被印成 0 BTY" 这一类在别处照样可表达。返回 `null` 后，前端的三态渲染统一印 `—`。
 *
 * 与 `decimalToWei` 的关系：两者互逆，都只走这一处判据（不要在调用点各自 `try/catch` 折 0）。
 */
export function weiToDecimal(wei, decimals = 18) {
  const raw = typeof wei === 'bigint' ? wei.toString() : String(wei ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  try {
    return ethers.formatUnits(raw, decimals);
  } catch {
    return null; // decimals 越界等：仍然是"读不到"，不是 0
  }
}

/** 小数（BTY 等）→ wei 字符串；入参为字符串避免浮点误差（内部用 BigInt 计算） */
export function decimalToWei(decimalStr, decimals = 18) {
  const [intPart = '0', fracPart = ''] = String(decimalStr).split('.');
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0')).toString();
}

/** 查询订单在链上的状态（escrowed/shipped 等回写由 watcher 负责，这里供即时校验） */
export async function fetchOnchainOrder(orderIdHex) {
  const escrow = getEscrow();
  /*
    `getOrder` 与抽成条款**同一个 tick 发出**（ethers v6 会把并发的 eth_call 打成一次
    JSON-RPC 批量请求，见 `fetchAfterSaleFor` 的同款说明）——所以多读一个视图**不增加往返**。
    抽成条款**不在 `getOrder` 元组里**：`Order` 结构体加到第 14 个字会让合约编译不过
    （Stack too deep，本合约不能开 viaIR），所以它是独立 mapping + 独立视图。
    读失败 = **这一项读不到**（不是"不抽成"）：`commissionTerms` 保持 null，
    由 `fees.commissionSnapshotOf(null)` 判成 known:false ⇒ 补录入口什么都不写。
  */
  const [o, terms] = await Promise.all([
    escrow.getOrder(orderIdHex),
    escrow.commissionTermsAtCreate(orderIdHex).catch(() => null),
  ]);
  return {
    buyer: o.buyer.toLowerCase(),
    seller: o.seller.toLowerCase(),
    amount: o.amount.toString(),
    feeBps: Number(o.feeBps),
    timeoutBlocks: Number(o.timeoutBlocks),
    createdAtBlock: Number(o.createdAtBlock),
    refundRequested: o.refundRequested,
    refundRejected: o.refundRejected,
    /*
      已退买家的金额（部分退款/拆分裁决凭据；0 = 未退款，= amount 表示全额退款）。
      **字段缺失只映射成"未知"（空串），绝不折成 `'0'`**（2026-10 修）：折成 0 等于
      "确证没退过款"，会让 `readRefundedWei`、对账的 `unreadable` 档与 `/sync` 的
      "已退金额这次没读到"提示在生产路径上永远不可达——而那几处判据存在的理由正是
      "读不到时不要按 0 处理"。同一个函数在 `feeCollectorAtCreate` 上守的就是这条纪律。
    */
    refundedAmount: o.refundedAmount === undefined || o.refundedAmount === null ? '' : String(o.refundedAmount),
    /**
     * **创建时快照的平台费收取方**（小写；零地址原样返回，由 src/fees.js 的 feeSnapshotOf
     * 归一成 `''`=未知 / 零地址=本单不扣费）。合约按它决定这一单扣不扣费，账本必须按单判定。
     */
    feeCollectorAtCreate: String(o.feeCollectorAtCreate ?? '').toLowerCase(),
    /**
     * **订单的店铺节点**（= 创建时快照的抽成收款人 = Registry 里这家店的 host），顶层字段。
     *
     * 为什么要单列一份（而不是让调用方自己从 `commissionTerms` 里取）：它是**订单身份**的一部分
     * （同一卖家在多个节点下各有一家店），`chainParamsMatch` 必须能在**每一条**读链路径上比对它。
     * 2026-10-21 的跨店诱饵单修复只让 watcher 手工把嵌套字段摊平，于是 `/sync` 与后台对账
     * 拿到的对象没有这个字段 ⇒ 比对被"缺字段跳过"的分支静默放行（2026-10-22 复审）。
     * 现在由读取器统一给出：读不到条款 ⇒ **空串**（不是 undefined）⇒ 比对**拒绝**，不再有跳过。
     */
    commissionTo: String(terms?.payee ?? terms?.[0] ?? '').toLowerCase(),
    /**
     * **创建时快照的节点抽成条款**（`{commissionTo, commissionBps}`；`null` = 本次没读到）。
     * 三态由 `fees.commissionSnapshotOf` 归一：读到 ⇒ 已知（零地址 = 确证这单不抽成）、
     * 读不到 ⇒ 未知（补录入口据此**什么都不写**，绝不写成"确证 0"）。
     */
    commissionTerms: terms
      ? { commissionTo: String(terms.payee ?? terms[0] ?? '').toLowerCase(), commissionBps: Number(terms.bps ?? terms[1] ?? 0) }
      : null,
    status: ESCROW_STATUS[Number(o.status)] || 'None',
  };
}

// ── 委员会（2026-10-18：单仲裁人 → 多仲裁人 + 阈值）──
/**
 * 三态：`null` = **本次没读到**；对象 = **确证的当前届**（`arbiters: []` 也是确证：
 * 这个节点还没任命任何仲裁人）。失败即丢弃判定值，不拿上一次成功值顶班——
 * 与旧实现同一条纪律：两个消费方都是鉴权（订单详情的 `as='arbiter'`、附件下载），
 * 用旧值代表"现在是谁"等于替链上说了一句它没说过的话。
 *
 * 缓存两档 TTL：**成功 60s**、**失败 5s**。失败也缓存是为了让 RPC 故障时不至于每个详情请求
 * 都触发一次超时重试；但只缓存 5s —— 一次抖动不该把仲裁人视角锁死一分钟。
 *
 * **单飞**（`_committeeInflight`）：并发的 `getCommittee()` 共享同一次链上读。旧实现每个调用
 * 各自发一轮，于是"快的成功"与"慢的失败"会按完成顺序互相覆盖——后完成的失败把已经写进缓存的
 * 成功名单清成 null，症状是同一批并发请求里有的放行有的拒绝，且看起来像随机故障。
 */
let _committee = null;
let _committeeAt = 0; // 最后一次**成功**读数的时刻
let _committeeFailedAt = 0; // 最后一次失败的时刻（负缓存 5s）
let _committeeLastOk = null;
let _committeeInflight = null;
const COMMITTEE_TTL_MS = 60_000;
const COMMITTEE_ERROR_TTL_MS = 5_000;
/*
  按**届次**缓存的委员会（`committeeForOrder` 用）。键是链上届次（uint32）：
  争议在 `requestDispute` 那一刻把当届快照进订单（`orderEpoch`），此后换届不会改变这一单的
  裁决成员，所以"同一届只读一次链"既安全也必要——仲裁列表要给每一行判资格，不能每行都发一次读数。
*/
const _epochCommittees = new Map();

/** 裁决种类（与 Escrow 的 `VOTE_*` 常量逐值对应；改合约顺序必须同批改这里） */
export const VOTE_KIND = { SETTLEMENT: 0, PENALTY: 1, AFTER_SALE: 2 };

/**
 * 委员会缓存立即失效（`escrowWatcher` 收到 `CommitteeUpdated` / `ArbiterRevoked` 时调用）。
 *
 * 不清 `_committeeLastOk`：它是"最后一次确证读到过谁"的排障线索，不是判定值
 * （与 `committeeStatus()` 的三态口径一致）。
 */
export function invalidateCommitteeCache() {
  _committee = null;
  _committeeAt = 0;
  _committeeFailedAt = 0;
  _epochCommittees.clear();
}

/**
 * 测试注入点（与 `setBlocklistReader` 同款）：让单测不起假 JSON-RPC 也能验证"读不到/读到"的分支。
 * 生产路径永远是链上读取；注入点只替换**取值**，判据与控制流仍是被测代码。
 *
 * 注入函数可选接收 `orderId`：不传 = 读当前届（`getCommittee`），传了 = 读**该单落定届**的成员
 * （`committeeForOrder`）。现有调用方忽略参数即可（它们只测当前届；此时订单级判据也按同一份名单）。
 */
let _committeeReader = null;
export function setCommitteeReader(reader) {
  _committeeReader = reader || null;
  invalidateCommitteeCache();
}

/** 链上/注入读数 → 统一形状（小写地址 + 数字阈值/届次）；字段缺失即抛错（不猜） */
function committeeShape({ arbiters, threshold, epoch }) {
  if (!Array.isArray(arbiters)) throw new Error('委员会读数的 arbiters 不是数组');
  const th = Number(threshold);
  const ep = Number(epoch);
  /*
    `epoch=0 / threshold=0 / members=[]` 是**确证**的"本节点还没任命仲裁人"（部署后、
    `setArbiters` 之前）：它必须能作为一条读数返回，否则 `getCommittee()` 会把"确证空名单"
    与"读不到"合并成一档。有成员时阈值必须为正——那种组合在合约里不可表达。
  */
  if (!Number.isInteger(th) || th < 0) throw new Error(`委员会读数的阈值非法：${String(threshold)}`);
  if (!Number.isInteger(ep) || ep < 0) throw new Error(`委员会读数的届次非法：${String(epoch)}`);
  if (arbiters.length > 0 && th <= 0) throw new Error(`委员会有 ${arbiters.length} 名成员但阈值为 ${th}`);
  return { arbiters: arbiters.map((a) => String(a).toLowerCase()), threshold: th, epoch: ep };
}

/**
 * **委员会成员的资格判据（唯一实现）**：`revokedArbiter || isForceClosed` 任一为真 ⇒ 排除。
 *
 * 为什么必须合并成一处：`arbiters()` / `orderArbiters()` 返回的是**链上原始名单**：
 *   · `revokedArbiter` 只由紧急吊销置位（常规换届不吊销，旧届成员仍可投旧届）；
 *   · 被 `_forceClose` 的成员仍可能留在当届/旧届名单里（合约 `_castVote` 会拒他的票，
 *     但名单读法本身不过滤）。
 * 节点把名单直接当"谁能读 PII / 谁在任"就会让一个**已无权投票**的地址继续读买家收货信息、
 * 证据附件，并在仲裁台被显示成投票人。两条判据都是 fail-closed：读不到任一状态 ⇒ 排除
 * （"无法确认有资格"不等于"有资格"）。
 *
 * @param {string[]} members 链上原始名单（大小写不敏感）
 * @param {null | ((member:string)=>Promise<boolean>)} revokedOf 读 `revokedArbiter` 的函数；
 *   `null` = 注入的委员会读数（测试桩已代表链上状态，不再有 revoked 读法可调）
 * @param {{force?: boolean}} [opts] `force=true` 时 `isForceClosed` 也跳过 15s 缓存——
 *   读 PII 的路径必须看到"刚刚被 forceClose"的成员，不能等缓存自然过期
 * @returns {Promise<string[]>} 有资格的成员（保持原顺序、小写）
 */
async function eligibleCommitteeMembers(members, revokedOf, { force = false } = {}) {
  const list = Array.isArray(members) ? members.map((m) => String(m).toLowerCase()) : [];
  const keep = await Promise.all(list.map(async (m) => {
    const [revoked, forceClosed] = await Promise.all([
      revokedOf ? Promise.resolve(revokedOf(m)).then((v) => v === true).catch(() => null) : false,
      isForceClosedAddress(m, { force }),
    ]);
    return revoked === false && forceClosed === false;
  }));
  return list.filter((_, i) => keep[i]);
}

async function _loadCommittee({ force = false } = {}) {
  if (_committeeReader) {
    const c = committeeShape(await _committeeReader());
    // 注入桩给的是"链上原始名单"的形状；资格判据仍走同一实现（forceClose 由注入点回答）。
    return { ...c, arbiters: await eligibleCommitteeMembers(c.arbiters, null, { force }) };
  }
  const escrow = getEscrow();
  const [members, threshold, epoch] = await Promise.all([
    escrow.arbiters(),
    escrow.arbiterThreshold(),
    escrow.committeeEpoch(),
  ]);
  const eligible = await eligibleCommitteeMembers(members, (m) => escrow.revokedArbiter(m), { force });
  return committeeShape({ arbiters: eligible, threshold, epoch });
}

/**
 * 当前届委员会 `{ arbiters, threshold, epoch }`；读不到返回 `null`（三态见文件头）。
 * 调度方（前端仲裁台、/healthz）据此显示"这一单要几票、谁在任"。
 *
 * @param {{force?: boolean}} [opts] `force=true` 跳过正/负缓存立刻重读——写路径与
 *   读 PII 的路径（仲裁详情/证据下载）用它，缓存里的旧名单不能成为撤权后的放行依据。
 */
export async function getCommittee({ force = false } = {}) {
  const now = Date.now();
  if (!force) {
    if (_committee !== null && now - _committeeAt < COMMITTEE_TTL_MS) return _committee;
    if (_committee === null && _committeeFailedAt !== 0 && now - _committeeFailedAt < COMMITTEE_ERROR_TTL_MS) return null;
  }
  if (_committeeInflight) return await _committeeInflight;
  _committeeInflight = (async () => {
    try {
      const c = await _loadCommittee({ force });
      const at = Date.now();
      _committee = c;
      _committeeAt = at;
      _committeeFailedAt = 0;
      _committeeLastOk = { at, ...c };
      return c;
    } catch (e) {
      _committee = null;
      _committeeFailedAt = Date.now();
      console.warn(
        `[chain] 读不到链上委员会（arbiters/arbiterThreshold/committeeEpoch）：${e?.message || e}——` +
          `本次按"不知道"处理（仲裁人视角不开放）；` +
          `${_committeeLastOk ? `最后一次成功读数是 ${_committeeLastOk.arbiters.length} 人/阈值 ${_committeeLastOk.threshold}（${new Date(_committeeLastOk.at).toISOString()}）` : '此前从未成功读到过'}`
      );
      return null;
    } finally {
      _committeeInflight = null;
    }
  })();
  return await _committeeInflight;
}

/** 该地址是否**当前届**仲裁人（读不到 ⇒ false，方向安全）。唯一鉴权判据。 */
export async function isArbiterAddress(addr, { force = false } = {}) {
  const a = String(addr || '').toLowerCase();
  if (!a) return false;
  const c = await getCommittee({ force });
  return !!c && c.arbiters.includes(a);
}

/**
 * **这一单**的裁决委员会（订单级资格的唯一读法）。
 *
 * 为什么不能用当前届：争议在 `requestDispute` 那一刻把当届成员**快照**进订单
 * （`Escrow.orderEpoch` / `orderArbiters` / `orderThreshold`）。换届之后：
 *   · 旧届成员仍然是这一单有资格的裁决人（他的票在链上仍然有效）；
 *   · 新届成员没有这一单的历史投票权（链上用快照判，节点必须同一条判据）。
 * 旧实现拿"当前届"给所有单判资格，症状是**换届后旧成员打不开正在处理的争议**
 * （详情证据、附件下载全部切断），而新成员能读到自己根本裁不了的单。
 *
 * `orderEpoch(orderId) == 0`（未被争议快照过的单，含售后案件）回退当前届：那一刻链上
 * `_committeeOfOrder` 也是同一回退，节点不自创第三种答案。
 *
 * 缓存按**届次**：同一届的成员/阈值在任何时候都相同，而列表要对每一行判资格。
 * 读不到返回 null（三态见文件头）；失败不写缓存，下一次请求重试。
 *
 * @param {string} orderId 链上订单键（bytes32 hex）
 * @param {{force?: boolean}} [opts] `force=true` 跳过届次缓存并重读 epoch/成员——撤权/换届后的
 *   读 PII 路径（仲裁详情、证据下载）用它，缓存里的旧名单不能成为放行依据。
 * @returns {Promise<{arbiters:string[], threshold:number, epoch:number}|null>}
 */
export async function committeeForOrder(orderId, { force = false } = {}) {
  const id = String(orderId || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return null;
  try {
    if (_committeeReader) {
      const c = committeeShape(await _committeeReader(id.toLowerCase()));
      return { ...c, arbiters: await eligibleCommitteeMembers(c.arbiters, null, { force }) };
    }
    const escrow = getEscrow();
    const epoch = Number(await escrow.orderEpoch(id));
    if (!Number.isInteger(epoch) || epoch <= 0) return await getCommittee({ force });
    if (!force) {
      const hit = _epochCommittees.get(epoch);
      if (hit) return hit;
    }
    const [members, threshold] = await Promise.all([
      escrow.orderArbiters(id),
      escrow.orderThreshold(id),
    ]);
    /*
      旧届名单可能仍含**被紧急吊销**或**被强制关闭**的地址（常规换届不再吊销，旧成员仍可投旧届）。
      这类地址已不能再投票，也不能再读该单的买家 PII/证据：两条判据合并为同一个资格函数
      `eligibleCommitteeMembers`（与 `_loadCommittee` 共用）。读不到任一成员状态 ⇒ 排除该成员
      （fail-closed），不把"读不到"当"有资格"。
    */
    const live = await eligibleCommitteeMembers(members, (m) => escrow.revokedArbiter(m), { force });
    const c = committeeShape({ arbiters: live, threshold, epoch });
    _epochCommittees.set(epoch, c);
    return c;
  } catch (e) {
    console.warn(
      `[chain] 读不到订单 ${id} 的裁决委员会（orderEpoch/orderArbiters/orderThreshold）：${e?.message || e}——` +
        '本次按"不是仲裁人"处理（fail-closed）'
    );
    return null;
  }
}

/**
 * 该地址是否有资格裁决**这一单**（订单级资格的唯一鉴权判据）。
 * 订单号缺失/读不到 ⇒ false：详情与附件下载都按"不是仲裁人"收回（方向安全）。
 */
export async function isArbiterForOrder(addr, orderId, { force = false } = {}) {
  const a = String(addr || '').toLowerCase();
  if (!a) return false;
  const c = await committeeForOrder(orderId, { force });
  return !!c && c.arbiters.includes(a);
}

/**
 * 委员会读数的诊断口径（不参与判定）：`known` = 本次窗口内是否**确证**读到了当前届。
 * 与 `fees.feeStatus()` 同款三态，供 /healthz、运维台与排障使用。
 */
export function committeeStatus() {
  return { committee: _committee, known: _committee !== null, lastOk: _committeeLastOk };
}

/**
 * 仅供测试：清空委员会读数缓存（含"最后一次成功读数"）。
 * 与 `fees.resetFeeCache()` 同款：60s 正/负缓存是生产语义，用例要跨过一次成功、一次失败。
 */
export function __resetCommitteeCacheForTest() {
  _committee = null;
  _committeeAt = 0;
  _committeeFailedAt = 0;
  _committeeLastOk = null;
  _epochCommittees.clear();
}

/** 仅供测试：只让 60s 窗口过期，保留 `lastOk`（模拟"缓存自然过期、这次读不到"）。 */
export function __expireCommitteeCacheForTest() {
  _committeeAt = 0;
  _committeeFailedAt = 0;
}

// ── 节点员工（2026-10-18）──
/**
 * 节点员工的唯一事实源在链上（`Registry.staffNode`）：员工要在**链上**审批开店、
 * 停用/恢复店铺，节点库里的名单授权不了那些交易；两份名单必然漂移，所以节点只读链。
 *
 * 三态：`null` = 本次读不到；`''` = 确证不是任何节点的员工；地址 = 确证属于该节点主。
 * `isNodeStaffOf` 对"读不到"按**不是员工**处理（权限方向 fail-closed）——
 * 被解除的员工最多在缓存 TTL（15s）内还能通过**读**路径；写路径由 `force` 跳过缓存
 * （见 http.js 的写请求默认 force），撤权后第一笔写就会被拒。
 *
 * 失败也缓存，但只 5s：一次 RPC 抖动不该让每个请求都重试一次超时，也不该把 15s 的正缓存
 * 变成"一次失败之后永远读不到"。
 */
const STAFF_TTL_MS = 15_000;
const STAFF_ERROR_TTL_MS = 5_000;
/** 缓存条数上限：达到后惰性清扫过期项，仍超限则丢最旧的（地址面可以很大，Map 不能无界） */
const STAFF_CACHE_MAX = 500;
const _staffCache = new Map();

/// @dev 测试注入点（与 `setCommitteeReader` 同款）：返回 `''` = 确证不是员工；地址 = 属于该节点主
let _staffReader = null;
export function setNodeStaffReader(reader) {
  _staffReader = reader || null;
  _staffCache.clear();
}

/** 一条员工缓存是否还在 TTL 内（负结果用短 TTL） */
function staffCacheLive(entry, now) {
  return now - entry.at < (entry.operator === null ? STAFF_ERROR_TTL_MS : STAFF_TTL_MS);
}

/** 惰性清扫：只在超过上限时动手（清理过期项；仍超限则按插入序丢最旧） */
function sweepStaffCache(now = Date.now()) {
  if (_staffCache.size <= STAFF_CACHE_MAX) return;
  for (const [k, v] of _staffCache) {
    if (!staffCacheLive(v, now)) _staffCache.delete(k);
  }
  for (const k of _staffCache.keys()) {
    if (_staffCache.size <= STAFF_CACHE_MAX) break;
    _staffCache.delete(k);
  }
}

/**
 * 该地址所属的节点主（`''` = 不是员工；`null` = 本次没读到）。
 * 每次请求都会走（`roleOf`），所以缓存按地址、15s（失败 5s）。
 *
 * @param {string} addr
 * @param {{force?: boolean}} [opts] `force=true` 跳过缓存立刻读链（写路径用：链上已移除的员工，
 *   缓存里的 true 不能继续放行）。
 */
export async function staffNodeOf(addr, { force = false } = {}) {
  const a = String(addr || '').toLowerCase();
  if (!a) return '';
  // 没配 Registry 且没有注入点就不可能有员工（名单的唯一事实源在链上）：直接给"不是员工"，不打 RPC
  if (!_staffReader && !config.chain.registryAddress) return '';
  const now = Date.now();
  if (!force) {
    const hit = _staffCache.get(a);
    if (hit && staffCacheLive(hit, now)) return hit.operator;
  }
  try {
    let operator;
    if (_staffReader) {
      const raw = await _staffReader(a);
      /*
        注入点与生产读数同一条三态纪律：`null`/`undefined` 是"读不到"，不是"不是员工"。
        把它折成 `''` 会让权限判定从 fail-closed 变成 fail-open，而测试恰好覆盖不到。
      */
      if (raw === null || raw === undefined) throw new Error('staff 读取器返回空读数（读不到 ≠ 不是员工）');
      const got = String(raw).toLowerCase();
      operator = got === '' || isZeroAddress(got) ? '' : got;
    } else {
      const got = String(await getRegistry().staffNode(a)).toLowerCase();
      operator = isZeroAddress(got) ? '' : got;
    }
    _staffCache.set(a, { at: Date.now(), operator });
    sweepStaffCache();
    return operator;
  } catch (e) {
    // 负缓存：短 TTL，绝不覆写成一个更长的"永久不是员工"窗口
    _staffCache.set(a, { at: Date.now(), operator: null });
    sweepStaffCache();
    console.warn(`[chain] 读不到链上 staffNode(${a})：${e?.message || e}——本次按"不是员工"处理（fail-closed）`);
    return null;
  }
}

/** 该地址是否**本节点**的员工；读不到按否处理。 */
export async function isNodeStaffOf(addr, operator, { force = false } = {}) {
  const op = String(operator || '').toLowerCase();
  if (!op) return false;
  const got = await staffNodeOf(addr, { force });
  return !!got && got === op;
}

/** 某节点的员工名单（`null` = 读不到；`[]` = 确证没有员工）。 */
export async function nodeStaffList(operator) {
  try {
    const list = await getRegistry().nodeStaff(operator);
    return list.map((a) => String(a).toLowerCase());
  } catch (e) {
    console.warn(`[chain] 读不到链上 nodeStaff(${operator})：${e?.message || e}`);
    return null;
  }
}

/**
 * 让某个地址的员工缓存立即失效（供"刚在链上增删完员工、紧接着刷新页面"的路径使用）。
 * 不传地址 = 清空全部（测试与运维用）。
 */
export function invalidateNodeStaffCache(addr) {
  if (!addr) {
    _staffCache.clear();
    return;
  }
  _staffCache.delete(String(addr).toLowerCase());
}

// ── 治理身份（角色互斥判据的链上事实源）──
let _protocolGovernanceReader = null;
const _governanceCache = new Map();
const GOVERNANCE_TTL_MS = 15_000;

/** 仅供测试：注入 `isProtocolGovernance(address)` 的读取实现；传 null 恢复链上读取。 */
export function setProtocolGovernanceReader(fn) {
  _protocolGovernanceReader = typeof fn === 'function' ? fn : null;
  _governanceCache.clear();
}

/** 角色/所有权变化后清缓存（节点侧没有事件监听，读路径靠 15s TTL，写路径 force）。 */
export function invalidateProtocolGovernanceCache(addr) {
  if (!addr) {
    _governanceCache.clear();
    return;
  }
  _governanceCache.delete(String(addr).toLowerCase());
}

/**
 * 某地址是否**任一治理合约 owner 或当前届仲裁人**（`Escrow.isProtocolGovernance`）。
 *
 * 为什么不是只读 `isArbiter`：角色互斥的对象不止仲裁人——Staking/Blocklist 的 owner
 * 也能冻结出金、改罚没上限、摘牌；如果节点侧只挡仲裁人，它们仍能被加进 `shop_operators`。
 * 所以店铺员工入口与 `roleOf` 都消费同一个链上判据。
 *
 * 返回 `true` / `false`；**读不到返回 `null`**。调用方必须把 `null` 当"不能确认"处理：
 * 登记入口拒绝（fail-closed），`roleOf` 按 `user` 处理（不冒充高权限）。
 */
export async function isProtocolGovernanceAddress(addr, { force = false } = {}) {
  const a = String(addr || '').toLowerCase();
  if (!a) return false;
  const now = Date.now();
  if (!force) {
    const hit = _governanceCache.get(a);
    if (hit && now - hit.at < GOVERNANCE_TTL_MS) return hit.value;
  }
  try {
    const v = _protocolGovernanceReader
      ? await _protocolGovernanceReader(a)
      : await getEscrow().isProtocolGovernance(a);
    if (v === null || v === undefined) return null;
    const value = v === true;
    _governanceCache.set(a, { at: now, value });
    return value;
  } catch (e) {
    console.warn(`[chain] 读不到 isProtocolGovernance(${a})：${e?.message || e}`);
    return null;
  }
}

// ── 被强制关闭的节点员工（`MarketplaceRegistry.isForceClosed`）──
/*
  为什么单列一条判据：`isProtocolGovernance` 回答的是"这个地址是不是 owner/当前届仲裁人"，
  而 forceClose 处理的是"这个地址作为**员工**已经被强制解除"——两者可以同时为 false
  （被 forceClose 的员工不是 owner，也不是仲裁人）。只查前者会让一个被永久强制关闭的地址
  继续以店铺员工/节点员工身份通过鉴权：链上已经把 `staffNode` 那一行清掉，但本地
  `shop_operators` 是**链下**事实，链上动作碰不到它；15s 缓存里也可能还留着旧值。
  所以"员工"这条腿必须**独立**再问一次链上 `isForceClosed`，且读不到就 fail-closed。

  三态与 `isProtocolGovernanceAddress` 完全同款：true/false/null（null = 读不到）。
  调用方必须把 null 当"不能确认"：登记入口拒绝、鉴权按 `user`/非管理员处理。
*/
const FORCE_CLOSED_TTL_MS = 15_000;
const _forceClosedCache = new Map();
let _forceClosedReader = null;

/** 仅供测试：注入 `isForceClosed(address)` 的读取实现（返回 true/false/null）；传 null 恢复链上读取。 */
export function setForceClosedReader(fn) {
  _forceClosedReader = typeof fn === 'function' ? fn : null;
  _forceClosedCache.clear();
}

/** 地址状态变化后清缓存（与 invalidateProtocolGovernanceCache 同款；forceClose 是永久状态，一般不需要）。 */
export function invalidateForceClosedCache(addr) {
  if (!addr) {
    _forceClosedCache.clear();
    return;
  }
  _forceClosedCache.delete(String(addr).toLowerCase());
}

/**
 * 该地址是否被链上强制关闭（`Registry.isForceClosed`）。
 *
 * 返回 true / false；**读不到返回 null**（调用方 fail-closed）。非法/空地址返回 false——
 * 它不可能是任何已登记员工（判据入口只接受 0x 地址，这里避免为脏值打 RPC）。
 *
 * 缓存：15s（与员工名单/治理身份同 TTL）。forceClose 是永久状态，正/负结果都可以缓存；
 * 写路径用 `force: true` 现读（管理员刚被解除时，缓存里的 false 不能继续放行）。
 */
export async function isForceClosedAddress(addr, { force = false } = {}) {
  const a = String(addr || '').toLowerCase();
  if (!a || !isAddress(a)) return false;
  /*
    未接 Registry（纯展示节点）时不存在"被强制关闭"这条链上状态：返回 false 而不是 null，
    否则节点主连 `/api/shop/node` 都会被自己挡掉（host 的 forceClosed 读不到 ⇒ 非管理员）。
    这与 `staffNodeOf` 在"没配 Registry 且没有注入点"时返回 ''（= 不是员工）同一条口径：
    **能力未接入**不是**读取失败**。真正读失败（配了 Registry 但 RPC 不通）仍是 null/fail-closed。
  */
  if (!_forceClosedReader && !config.chain.registryAddress) return false;
  const now = Date.now();
  if (!force) {
    const hit = _forceClosedCache.get(a);
    if (hit && now - hit.at < FORCE_CLOSED_TTL_MS) return hit.value;
  }
  try {
    const v = _forceClosedReader ? await _forceClosedReader(a) : await getRegistry().isForceClosed(a);
    if (v === null || v === undefined) return null; // 读不到 ≠ 没被关闭
    const value = v === true;
    _forceClosedCache.set(a, { at: now, value });
    return value;
  } catch (e) {
    // 不复用"上次成功读数"：一次 RPC 抖动必须表现为"不能确认"，不能把旧 false 当现状放行。
    console.warn(`[chain] 读不到 isForceClosed(${a})：${e?.message || e}——本次按"不能确认"处理（fail-closed）`);
    return null;
  }
}
