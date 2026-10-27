/**
 * 链上交互：ethers provider + **本节点两份合约**（Escrow / Staking）的只读封装。
 *
 * 职责：
 *  - 提供 JsonRpcProvider（BTY EVM 主网）；
 *  - Escrow 订单/提货争议/委员会的只读读数与事件日志解析（供 escrowWatcher 轮询回写）；
 *  - 本节点 Staking 的只读读数（`poolOf` / `payoutFloors`，供 stakingRisk）；
 *  - 地址/金额工具（checksum、wei ↔ 小数）。
 *
 * 节点不读取任何 Registry：Registry 只做目录展示，不是本节点的运行依赖。
 * 每个节点部署自己的 Escrow（带委员会）与 Staking（卖家保证金），用
 * `MK_ESCROW_ADDRESS` / `MK_STAKING_ADDRESS` 接线。**没有平台费、没有节点抽成、
 * 没有店铺链上登记、没有地址黑名单**——店铺/商品/订单明细/费用全在节点自己的库里。
 * 支付资产：原生 BTY + 节点配置并已在 Escrow 白名单开启的 ERC20（见 paymentTokens.js）。
 *
 * 注意：BTY 主网 RPC 的 eth_chainId=2999；ethers v6 若未登记该网络，
 * 可显式传入 network 参数避免未知网络校验。
 */
import { ethers } from 'ethers';
import config from './config.js';

// ── Escrow 合约 ABI（与 contracts/src/Escrow.sol 对齐；只含本节点需要的部分）──
export const ESCROW_ABI = [
  // 事件（watcher 依赖，topic 与链上一致）。OrderCreated **不再带 host**：
  // 订单只属于本节点这一份 Escrow，店铺与卖家是节点链下的事实。
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, uint256 amount)',
  'event ReceiptConfirmed(bytes32 indexed orderId)',
  'event DisputeRequested(bytes32 indexed orderId)',
  // refundWei：裁给买家的金额（0=全额判卖家，=amount=全额退买家，中间值=拆分结算）
  'event Arbitrated(bytes32 indexed orderId, uint256 refundWei)',
  'event OrderExpiredReleased(bytes32 indexed orderId)',
  'event RefundRequested(bytes32 indexed orderId)',
  'event RefundRejected(bytes32 indexed orderId)',
  // refundWei：卖家同意的退款金额。合约只接受两种金额：
  //   · refundWei == amount                        → 全额认赔（不需要任何授权）
  //   · refundWei == acceptedPartialRefund[orderId] → 买家已**精确授权**过的那个数
  'event RefundApproved(bytes32 indexed orderId, uint256 refundWei)',
  // 买家对**具体金额**的部分退款授权（= 让"双方已谈拢的部分退款"不必绕道仲裁人）。
  'event PartialRefundAccepted(bytes32 indexed orderId, uint256 refundWei)',
  // 确认收货后的**售后案件**（本地镜像的唯一判据见 src/afterSale.js）：
  // 它只影响售后裁决；补偿优先从 Escrow 留存的卖家货款出，不足部分再由 Staking 罚没。
  'event AfterSaleOpened(bytes32 indexed orderId, address indexed buyer, address indexed seller)',
  'event AfterSaleClosed(bytes32 indexed orderId, address indexed by, string note)',
  'event SellerPendingAccrued(bytes32 indexed orderId, address indexed seller, uint256 amount, uint64 unlockBlock)',
  'event SellerFundsReleased(bytes32 indexed orderId, address indexed seller, uint256 amount)',
  // refundedTotal = 含本次在内的订单级累计已付买家（售后账本唯一读数）
  'event SellerRefunded(bytes32 indexed orderId, address indexed buyer, uint256 amount, uint256 refundedTotal)',
  /*
    委员会治理事件（`escrowWatcher` 轮询到它们时让委员会缓存立即失效）：
    换届/吊销之后，仲裁人视角不能再按旧名单放行；没有这两个事件也可靠 60s TTL 收敛，
    但"撤权后最多再读 60 秒 PII"不是一个可接受的窗口。
  */
  'event CommitteeUpdated(uint32 indexed epoch, address[] members, uint16 threshold)',
  'event ArbiterRevoked(address indexed arbiter)',
  // 派发失败改挂账（收款方自取）；`PayoutWithdrawn` 由合约发出，节点只读余额
  'event PayoutAccrued(address indexed to, uint256 amount)',
  /*
    提货争议（NFT 提货人 ≠ 原买家，所以不能走 openAfterSale）：
    开案（节点运营方）/ 委员会按金额票决 / 结案 / 撤销。
    claimId 由节点侧生成并随开案参数交给节点主钱包（节点不持私钥）。
  */
  'event ClaimDisputeOpened(bytes32 indexed claimId, bytes32 indexed orderId, address indexed seller, address claimant, uint256 amount, uint64 deadline)',
  'event ClaimVoted(bytes32 indexed claimId, address indexed arbiter, uint256 amountWei, uint16 votes, uint16 threshold)',
  'event ClaimClosed(bytes32 indexed claimId, uint256 amountWei, address indexed claimant)',
  'event ClaimDisputeCancelled(bytes32 indexed claimId, string reason)',
  /*
    只读 `getOrder`（字段顺序必须与 Escrow.Order **逐字段对应**，共 10 个字段）：
    (buyer, seller, amount, timeoutBlocks, createdAtBlock, refundRequested, refundRejected,
     refundedAmount, status, buyerConfirmed)。
    **少一项、错一位都会静默解码出垃圾**：ethers 用短 ABI 解长返回值会直接抛 out of result
    range，而错序不会报错——它只会把相邻字段的值读成另一个字段。
    同步点：contracts/src/Escrow.sol、contracts/src/Staking.sol 的 IEscrowMinimal.
    ESCROW_ORDER_WORDS、frontend/src/chain.ts、node/src/chainReconcile.js。
  */
  'function getOrder(bytes32 orderId) view returns (address buyer, address seller, uint256 amount, uint64 timeoutBlocks, uint64 createdAtBlock, bool refundRequested, bool refundRejected, uint256 refundedAmount, uint8 status, bool buyerConfirmed)',
  // 写（节点不经手资金/不持私钥；真正调用在买家/卖家/仲裁人/节点主的钱包侧，此处仅供脚本/测试参考）
  'function createOrder(bytes32 orderId, address seller, uint256 amount, uint64 timeoutBlocks) payable',
  'function createOrderToken(bytes32 orderId, address seller, address token, uint256 amount, uint64 timeoutBlocks) payable',
  'function orderToken(bytes32 orderId) view returns (address)',
  'function supportedToken(address token) view returns (bool)',
  'function confirmReceipt(bytes32 orderId)',
  'function requestDispute(bytes32 orderId)',
  'function voteSettlement(bytes32 orderId, uint256 refundWei)',
  'function votePenalty(bytes32 orderId, uint256 amountWei)',
  'function voteAfterSale(bytes32 orderId, uint256 penaltyWei)',
  'function releaseExpired(bytes32 orderId)',
  'function requestRefund(bytes32 orderId)',
  'function approveRefund(bytes32 orderId, uint256 refundWei)',
  'function acceptPartialRefund(bytes32 orderId, uint256 refundWei)',
  'function rejectRefund(bytes32 orderId)',
  'function openAfterSale(bytes32 orderId)',
  'function closeAfterSale(bytes32 orderId, string note)',
  'function withdrawPayout()',
  'function releaseSellerFunds(bytes32 orderId)',
  'function refundSettled(bytes32 orderId, uint256 refundWei)',
  'function sellerPending(bytes32 orderId) view returns (uint256)',
  'function sellerPendingUnlockBlock(bytes32 orderId) view returns (uint64)',
  // 提货争议：开案与撤销是 onlyOwner（节点主钱包），投票是委员会成员
  'function openClaimDispute(bytes32 claimId, bytes32 orderId, bytes32 tokenRef, address seller, address claimant, uint256 amount, uint64 deadline)',
  'function voteClaim(bytes32 claimId, uint256 amountWei)',
  'function cancelClaimDispute(bytes32 claimId, string reason)',
  // 买家已授权的部分退款额（0 = 未授权）；approveRefund 部分退款时的唯一合法取值来源
  'function acceptedPartialRefund(bytes32 orderId) view returns (uint256)',
  /*
    确认收货后的售后案件只读视图（`/sync` 与后台对账的链上真值）。
    "窗口还开着吗"由**合约**在 openAfterSale 里判，节点不重复实现一遍窗口算术。
  */
  'function afterSaleOpen(bytes32 orderId) view returns (bool)',
  'function afterSaleOpenedAtBlock(bytes32 orderId) view returns (uint64)',
  'function settledAtBlock(bytes32 orderId) view returns (uint64)',
  'function afterSaleWindowBlocksOf(bytes32 orderId) view returns (uint64)',
  /*
    该卖家当前的**在途售后敞口**（wei）= Σ 在途单（退款申请待决 + 争议中）的 amount。
    它是 `Staking.payoutFloors` 的唯一读数来源 ⇒ 缺这个读法时四条出金路径整体 revert。
  */
  'function sellerOpenExposure(address seller) view returns (uint256)',
  'function totalOpenExposure() view returns (uint256)',
  /// 判给卖家时的**实收净额**（零费模型下 = amount − refundedAmount）——Staking 罚没上限基准
  'function sellerNetAtSettle(bytes32 orderId) view returns (uint256)',
  /*
    托管超时的**链上阈值**（前端 utils/escrowCountdown 同判据）：
    释放允许当且仅当 `latestBlock > releaseNotBeforeBlock(orderId)`。刻意不自己用
    `createdAtBlock + timeoutBlocks` 算一遍——合约在这之上还叠了"卖家拒绝退款后的释放静置期"。
    ⚠️ 若 `refundRequested` 仍为真，释放被**永久**禁止，此时本函数返回的 T 没有意义。
  */
  'function releaseNotBeforeBlock(bytes32 orderId) view returns (uint64)',
  /*
    下单超时窗口的链上上下界：**启动期自检**用它挡住"配得比合约允许区间还大/小"的那种
    `MK_ESCROW_TIMEOUT_BLOCKS`（配错时节点绿灯启动、每一笔 createOrder 都在买家钱包里回滚）。
  */
  'function minTimeoutBlocks() view returns (uint64)',
  'function MAX_TIMEOUT_BLOCKS() view returns (uint64)',
  // 挂账余额（`_settle` 派发失败时记到收款方名下，由其 withdrawPayout 自取）
  'function accruedPayouts(address to) view returns (uint256)',
  /*
    提货争议读法：
      · `claimCase(claimId)` = (orderId, tokenRef, seller, claimant, amount, deadline, openedAt, closed)
        8 个字段，按位置解码；
      · `sellerClaimExposure(seller)` = 卖家在途提货争议敞口（开案锁定、结案释放）；
      · `claimTallyOf(claimId, amountWei)` = 该金额的已投票数；`claimEpoch(claimId)` = 开案届次。
  */
  'function claimCase(bytes32 claimId) view returns (bytes32 orderId, bytes32 tokenRef, address seller, address claimant, uint256 amount, uint64 deadline, uint64 openedAt, bool closed)',
  'function sellerClaimExposure(address seller) view returns (uint256)',
  'function claimTallyOf(bytes32 claimId, uint256 amountWei) view returns (uint16)',
  'function claimEpoch(bytes32 claimId) view returns (uint32)',
  /*
    委员会只读面：`arbiters()` 返回**当前届**成员、`arbiterThreshold()` 是通过票数。
    `isArbiter(addr)` 是当前届成员的 O(1) 判据——节点侧所有"仲裁人视角"鉴权只读它。
    `orderEpoch/orderThreshold/orderArbiters` 是**按单**的裁决进度。
  */
  'function arbiters() view returns (address[])',
  'function arbiterThreshold() view returns (uint16)',
  'function committeeEpoch() view returns (uint32)',
  'function isArbiter(address who) view returns (bool)',
  // 治理身份 = 本节点 Escrow 的 owner 或当前届仲裁人（节点合约不读任何 Registry）
  'function isProtocolGovernance(address who) view returns (bool)',
  // 紧急吊销：只有 revokeArbiter 会置 true；节点侧用它把被吊销的成员挡在证据/PII 之外
  'function revokedArbiter(address who) view returns (bool)',
  'function orderEpoch(bytes32 orderId) view returns (uint32)',
  'function orderThreshold(bytes32 orderId) view returns (uint16)',
  'function orderArbiters(bytes32 orderId) view returns (address[])',
  /// 本节点托管合约的 owner（= 节点 operator；注册表里三方 owner 必须一致）
  'function owner() view returns (address)',
  /// 本节点的 Staking（节点合约不依赖任何 Registry）
  'function staking() view returns (address)',
];

export const ESCROW_STATUS = ['None', 'Created', 'Disputed', 'Settled', 'Refunded'];

/**
 * **代次探针清单：本节点在运行时真正调用的、且只存在于当前这一代 Escrow 上的读法。**
 *
 * 判据与 `Staking._probeEscrow`（探六个读法 + `getOrder` 确切字数）同一条纪律：
 * **探的必须是会调用的**；分散写三处必然漏，所以清单只能有一份。
 *
 * 入清单的三个条件（缺一不可）：
 *   ① 本节点或它的合约伙伴**真的会调**（不是"存在但没人用"）；
 *   ② 该读法**只在当前这一代**上存在（缺它就能判定代次）；
 *   ③ 传零参/零值也**必定成功返回**（探针是只读判定，不能因为"这个 orderId 不存在"就 revert）。
 *
 * `shape` 与调用形状逐字对应，探针按 `zeroArg` 构造入参，因此"清单写着 A、代码调 B"不可表达。
 */
export const ESCROW_GENERATION_PROBES = [
  // 下单超时窗口的上下界与释放阈值（前端倒计时 + 节点启动自检共用）
  { shape: 'minTimeoutBlocks()', zeroArg: 'none' },
  { shape: 'MAX_TIMEOUT_BLOCKS()', zeroArg: 'none' },
  { shape: 'releaseNotBeforeBlock(bytes32)', zeroArg: 'bytes32' },
  // 确认收货后的售后案件（watcher / 对账 / 详情页都读）
  { shape: 'afterSaleOpen(bytes32)', zeroArg: 'bytes32' },
  { shape: 'afterSaleOpenedAtBlock(bytes32)', zeroArg: 'bytes32' },
  { shape: 'afterSaleWindowBlocksOf(bytes32)', zeroArg: 'bytes32' },
  { shape: 'settledAtBlock(bytes32)', zeroArg: 'bytes32' },
  /*
    后三项是**合约伙伴**会调的（本节点不直接调，但节点接错代次就等于把它们一起弄死）：
    `Staking.payoutFloors` 读 `sellerOpenExposure` ⇒ 缺它则四条出金路径整体 revert；
    `Staking._penaltyBase` 读 `sellerNetAtSettle` ⇒ 缺它则罚没 fail-closed（上限 0）；
    `Staking` 的构造期探针与 Escrow 侧不变量对拍都用 `totalOpenExposure`。
  */
  { shape: 'sellerOpenExposure(address)', zeroArg: 'address' },
  { shape: 'sellerNetAtSettle(bytes32)', zeroArg: 'bytes32' },
  { shape: 'sellerPending(bytes32)', zeroArg: 'bytes32' },
  { shape: 'sellerPendingUnlockBlock(bytes32)', zeroArg: 'bytes32' },
  { shape: 'orderToken(bytes32)', zeroArg: 'bytes32' },
  { shape: 'supportedToken(address)', zeroArg: 'address' },
  { shape: 'totalOpenExposure()', zeroArg: 'none' },
  // 提货争议（watcher 与 /api/claims 的链上确认都读它；漏探 = 启动绿灯、提货争议读不到）
  { shape: 'claimCase(bytes32)', zeroArg: 'bytes32' },
  { shape: 'sellerClaimExposure(address)', zeroArg: 'address' },
  { shape: 'claimEpoch(bytes32)', zeroArg: 'bytes32' },
  /*
    委员会：`chain.getCommittee` / `chain.committeeForOrder` 在运行时真的会调这六个读法，
    其中按单的三个是**订单级裁决资格**的唯一来源（争议发起时快照届次）。
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
 * 启动期链 ID 自检：staticNetwork: true 会让 ethers 跳过与节点协商网络，
 * 于是把 MK_RPC_URL 配到别的链不会被发现——而 receipt/日志校验的**信任根**就是这条 RPC。
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
 * 启动期**下单超时窗口自检**。
 *
 * 为什么必须有它：`MK_ESCROW_TIMEOUT_BLOCKS`（默认 120960 ≈ 7 天）是**本节点自己**填进订单草稿的值，
 * 而合约对它有上下界（`minTimeoutBlocks` / `MAX_TIMEOUT_BLOCKS`）。配越界时节点会**绿灯启动、
 * 店面看起来在营业、但每一笔下单都在买家钱包里 revert**，运营方看到的是"没人下单"。
 *
 * 判据只有一处：链上 `minTimeoutBlocks()` / `MAX_TIMEOUT_BLOCKS()`，不在节点里再抄一份常量。
 *
 * **三档而不是两档**：只有"读到了链上界、且配置越界"才算 `blocked`；`unknown`（读不到 /
 * 配置值本身非法）**不阻断启动**，只把结论留在 `orderTimeoutSelfCheck()` 里、由 `/healthz`
 * 与启动日志说出来。把"读不到"升格成"拒绝启动"等于让一次 RPC 抖动停掉一个配置正确的节点。
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
 * `unknown` 档**不阻断启动**，所以必须有个地方能看见它。
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
 * 启动期**托管合约代次自检**。
 *
 * 判据：`ESCROW_GENERATION_PROBES` 里**每一个**形状都必须读得出来（清单是唯一真相）。
 * 链 ID 自检在本函数之前跑过，所以"读不到"在这里只能意味着**合约不是这一代**。
 * 逃生口 `MK_CONTRACT_GEN_ACK=1`：确有需要时显式声明，**不设静默降级**。
 * 返回 `{ ok, missing, probed }`，由 server.js 决定拒绝启动还是放行并告警。
 */
export async function assertEscrowGeneration() {
  const escrow = getEscrow();
  const missing = [];
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
 * 为什么两条：标准 1271 的 digest 是 EIP-191 外层（返回 `0x1626ba7e`）；Safe `signMessage(inner)`
 * 签的是 Safe EIP-712 的 `SafeMessage(inner)`，标准路径永远不中，它对应 legacy bytes 重载
 * （`0x20c13b0b`，必须传 inner 原始字节）。两次调用都是 fail-closed。
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
 * 本节点 Staking 的**只读** ABI（保证金/罚没/出金下限）。
 *
 * 节点不写它（stake/approveUnstake/freeze 都是店主或节点主的钱包交易），只读：
 *  - `poolOf(operator)` = staked + pending（冷却期资金仍属可罚没担保池）；
 *  - `payoutFloors(operator)` = (exposure, required)，出金下限的唯一读数来源；
 *  - `positions` / `penaltyWindowState` / `penalizedOrders` / `penalizedClaims` 是诊断读数。
 */
export const STAKING_ABI = [
  'function escrow() view returns (address)',
  'function owner() view returns (address)',
  'function poolOf(address operator) view returns (uint256)',
  'function payoutFloors(address operator) view returns (uint256 exposure, uint256 required)',
  'function positions(address operator) view returns (uint256 staked, uint256 pending, uint64 releaseAt, bool frozen)',
  'function penalizedOrders(bytes32 orderId) view returns (bool)',
  'function penalizedClaims(bytes32 claimId) view returns (bool)',
  'function claimPenalizedByOrder(bytes32 orderId) view returns (uint256)',
  'function penaltyWindowState(address operator) view returns (bool limited, uint256 remaining, uint256 windowEndsAt)',
];

/** 获取本节点 Staking 合约实例（只读）；未配置即抛错——"读不到保证金"与"没有保证金层"是两件事 */
export function getStaking() {
  if (!config.chain.stakingAddress) {
    throw new Error('MK_STAKING_ADDRESS 未配置（合约部署后填入）');
  }
  return new ethers.Contract(config.chain.stakingAddress, STAKING_ABI, getProvider());
}

/** 地址是否为 address(0)（零地址判定；NFT 合约地址非零校验用，见 routes/products.js） */
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
 * 三态：只认 `/^\d+$/`（可带首尾空白）的十进制 wei；`null`/`undefined`/空串/畸形/负数/`0x…`/小数
 * **一律 `null`** —— 不返回 `'0'`。这些 `*Decimal` 字段直接进 DTO 给界面显示，返回 `'0'` 等于
 * 替链上说了一句它没说过的话（"这笔钱是 0"）。返回 `null` 后，前端的三态渲染统一印 `—`。
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

/**
 * 查询订单在链上的状态（escrowed/shipped 等回写由 watcher 负责，这里供即时校验）。
 *
 * `refundedAmount` 缺失只映射成**未知**（空串），绝不折成 `'0'`：折成 0 等于"确证没退过款"，
 * 会让 `readRefundedWei`、对账的 `unreadable` 档与 `/sync` 的"已退金额这次没读到"提示
 * 在生产路径上永远不可达。
 */
/**
 * 终态写入的确认边界。watcher 只扫 `head - finalityBlocks`，但 `/sync` 与后台对账
 * 此前读 `latest` 就直接写 settled/refunded；12 块内重组后没有反向迁移路径。
 *
 * 这里返回一个可注入的 blockTag：生产 = `head - finality`，测试 = 'latest'（setup 注入，
 * 避免每个假 RPC 都要实现 eth_blockNumber）。读 head 失败时抛错，由调用方 fail-closed。
 */
let _finalizedBlockTag = async () => {
  const finality = Number(config.escrow.finalityBlocks || 0);
  if (finality <= 0) return 'latest';
  const head = Number(await getProvider().getBlockNumber());
  return Math.max(0, head - finality);
};

export function setFinalizedBlockTagReader(fn) {
  _finalizedBlockTag = fn || (async () => 'latest');
}

export async function finalizedBlockTag() {
  return await _finalizedBlockTag();
}

export async function fetchOnchainOrder(orderIdHex, { blockTag = 'latest' } = {}) {
  const escrow = getEscrow();
  const overrides = blockTag === 'latest' ? {} : { blockTag };
  // 支付资产与订单元组分开读：`getOrder` 的 10 字形状是既有 ABI 契约，不为了多一个字段改它。
  const [o, token] = await Promise.all([
    escrow.getOrder(orderIdHex, overrides),
    escrow.orderToken(orderIdHex, overrides),
  ]);
  return {
    buyer: o.buyer.toLowerCase(),
    seller: o.seller.toLowerCase(),
    amount: o.amount.toString(),
    timeoutBlocks: Number(o.timeoutBlocks),
    createdAtBlock: Number(o.createdAtBlock),
    refundRequested: o.refundRequested,
    refundRejected: o.refundRejected,
    refundedAmount: o.refundedAmount === undefined || o.refundedAmount === null ? '' : String(o.refundedAmount),
    buyerConfirmed: !!o.buyerConfirmed,
    // native = 零地址；ERC20 单必须与本地 payment_token 逐字相等
    token: String(token || '0x0000000000000000000000000000000000000000').toLowerCase(),
    status: ESCROW_STATUS[Number(o.status)] || 'None',
  };
}

// ── 委员会 ──
/**
 * 三态：`null` = **本次没读到**；对象 = **确证的当前届**（`arbiters: []` 也是确证：
 * 这个节点还没任命任何仲裁人）。失败即丢弃判定值，不拿上一次成功值顶班——
 * 两个消费方都是鉴权（订单详情的 `as='arbiter'`、附件下载），用旧值代表"现在是谁"
 * 等于替链上说了一句它没说过的话。
 *
 * 缓存两档 TTL：**成功 60s**、**失败 5s**。**单飞**（`_committeeInflight`）：并发的
 * `getCommittee()` 共享同一次链上读——否则"快的成功"与"慢的失败"会按完成顺序互相覆盖。
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
  裁决成员，所以"同一届只读一次链"既安全也必要——仲裁列表要给每一行判资格。
*/
const _epochCommittees = new Map();

/** 裁决种类（与 Escrow 的 `VOTE_*` 常量逐值对应；改合约顺序必须同批改这里） */
export const VOTE_KIND = { SETTLEMENT: 0, PENALTY: 1, AFTER_SALE: 2 };

/**
 * 委员会缓存立即失效（`escrowWatcher` 收到 `CommitteeUpdated` / `ArbiterRevoked` 时调用）。
 * 不清 `_committeeLastOk`：它是"最后一次确证读到过谁"的排障线索，不是判定值。
 */
export function invalidateCommitteeCache() {
  _committee = null;
  _committeeAt = 0;
  _committeeFailedAt = 0;
  _epochCommittees.clear();
}

/**
 * 测试注入点：让单测不起假 JSON-RPC 也能验证"读不到/读到"的分支。
 * 生产路径永远是链上读取；注入点只替换**取值**，判据与控制流仍是被测代码。
 *
 * 注入函数可选接收 `orderId`：不传 = 读当前届（`getCommittee`），传了 = 读**该单落定届**的成员
 * （`committeeForOrder`）。现有调用方忽略参数即可。
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
 * **委员会成员的资格判据（唯一实现）**：`revokedArbiter` 为真 ⇒ 排除。
 *
 * 节点不读取任何 Registry：平台目录的 forceClose 是目录状态，不是节点合约事实；
 * 委员会资格只由本节点 Escrow 的 `revokedArbiter` 回答。
 *
 * @param {string[]} members 链上原始名单（大小写不敏感）
 * @param {null | ((member:string)=>Promise<boolean>)} revokedOf 读 `revokedArbiter` 的函数；
 *   `null` = 注入的委员会读数（测试桩已代表链上状态，不再有 revoked 读法可调）
 * @returns {Promise<string[]>} 有资格的成员（保持原顺序、小写）
 */
async function eligibleCommitteeMembers(members, revokedOf) {
  const list = Array.isArray(members) ? members.map((m) => String(m).toLowerCase()) : [];
  const keep = await Promise.all(list.map(async (m) => {
    const revoked = revokedOf ? await Promise.resolve(revokedOf(m)).then((v) => v === true).catch(() => null) : false;
    return revoked === false;
  }));
  return list.filter((_, i) => keep[i]);
}

async function _loadCommittee({ force = false } = {}) {
  if (_committeeReader) {
    const c = committeeShape(await _committeeReader());
    // 注入桩给的是"链上原始名单"的形状；资格判据仍走同一实现。
    return { ...c, arbiters: await eligibleCommitteeMembers(c.arbiters, null) };
  }
  const escrow = getEscrow();
  const [members, threshold, epoch] = await Promise.all([
    escrow.arbiters(),
    escrow.arbiterThreshold(),
    escrow.committeeEpoch(),
  ]);
  const eligible = await eligibleCommitteeMembers(members, (m) => escrow.revokedArbiter(m));
  return committeeShape({ arbiters: eligible, threshold, epoch });
}

/**
 * 当前届委员会 `{ arbiters, threshold, epoch }`；读不到返回 `null`（三态见上）。
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
 * 争议在 `requestDispute` 那一刻把当届成员**快照**进订单（`Escrow.orderEpoch` /
 * `orderArbiters` / `orderThreshold`）。换届之后旧届成员仍然是这一单有资格的裁决人，
 * 新届成员没有这一单的历史投票权——节点必须与链上同一条判据。
 *
 * `orderEpoch(orderId) == 0`（未被争议快照过的单，含售后案件）回退当前届。
 * 缓存按**届次**；读不到返回 null（三态见上），失败不写缓存，下一次请求重试。
 *
 * @param {string} orderId 链上订单键（bytes32 hex）
 * @param {{force?: boolean}} [opts] `force=true` 跳过届次缓存并重读
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
      旧届名单可能仍含**被紧急吊销**的地址。这类地址已不能再投票，也不能再读该单的
      买家 PII/证据；资格只看本节点 Escrow 的 `revokedArbiter`，不读 Registry。合并为同一个
      资格函数 `eligibleCommitteeMembers`（与 `_loadCommittee` 共用），读不到 ⇒ 排除（fail-closed）。
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

// ── 委员会读取结束 ──
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
 * 供 /healthz、运维台与排障使用。
 */
export function committeeStatus() {
  return { committee: _committee, known: _committee !== null, lastOk: _committeeLastOk };
}

/**
 * 仅供测试：清空委员会读数缓存（含"最后一次成功读数"）。
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


