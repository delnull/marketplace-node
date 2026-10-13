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
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, uint256 amount, uint64 timeoutBlocks, uint64 createdAtBlock)',
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
  // 其它一律 revert RefundAmountNotAccepted（0 → RefundAmountZero，> amount → RefundAmountExceeds；
  // 旧的 RefundNotFull 错误已随本轮契约变更删除）。仲裁人 arbitrate 不受此限（任意比例拆分）。
  'event RefundApproved(bytes32 indexed orderId, uint256 refundWei)',
  // 买家对**具体金额**的部分退款授权（= 让"双方已谈拢的部分退款"不必绕道仲裁人）。
  // 授权不转移资金、不冻结订单、也不影响买家其它出口；重复授权直接覆盖旧值。
  'event PartialRefundAccepted(bytes32 indexed orderId, uint256 refundWei)',
  // 确认收货后的**售后案件**（契约 2026-10 第二批；本地镜像的唯一判据见 src/afterSale.js）：
  // 开案（仅买家、仅终局且窗口内）/ 结案（买家撤诉或仲裁人，note 为用户文本）。
  // 它不动托管资金（钱早已结清），补偿只能来自卖家保证金 Staking.penalize 或线下转账，
  // 因此也**不阻塞卖家撤资**（撤资闸只看 sellerOpenCases，案件不计入）。
  'event AfterSaleOpened(bytes32 indexed orderId, address indexed buyer, address indexed seller)',
  'event AfterSaleClosed(bytes32 indexed orderId, address indexed by, string note)',
  // 只读（字段顺序必须与 Escrow.Order **逐字段对应**：refundedAmount 在 status 之前；末尾两项是
  // 2026-09 审计新增——feeCollectorAtCreate（创建时的平台费收取方快照，决定本单扣不扣费）与
  // buyerConfirmed（买家本人确认过收货）。**少一项、错一位都会静默解码出垃圾**：ethers 用短 ABI 解长
  // 返回值会直接抛 out of result range，而错序不会报错——它只会把相邻字段的值读成另一个字段。
  // 同步点：contracts/src/Escrow.sol、contracts/src/Staking.sol 的 IEscrowMinimal、frontend/src/chain.ts、
  // node/scripts/reconcile-ledger.js、scripts/dev/*.mjs —— 改一处必须全改。）
  'function getOrder(bytes32 orderId) view returns (address buyer, address seller, uint256 amount, uint256 feeBps, uint64 timeoutBlocks, uint64 createdAtBlock, bool refundRequested, bool refundRejected, uint256 refundedAmount, uint8 status, address feeCollectorAtCreate, bool buyerConfirmed)',
  // 写（节点不经手资金，仅买家/卖家/仲裁人直接调用；此处仅供脚本/测试参考）
  'function createOrder(bytes32 orderId, address seller, uint256 amount, uint64 timeoutBlocks) payable',
  'function confirmReceipt(bytes32 orderId)',
  'function requestDispute(bytes32 orderId)',
  'function arbitrate(bytes32 orderId, uint256 refundWei)',
  'function releaseExpired(bytes32 orderId)',
  'function requestRefund(bytes32 orderId)',
  'function approveRefund(bytes32 orderId, uint256 refundWei)',
  'function acceptPartialRefund(bytes32 orderId, uint256 refundWei)',
  // 买家已授权的部分退款额（0 = 未授权）；approveRefund 部分退款时的唯一合法取值来源
  'function acceptedPartialRefund(bytes32 orderId) view returns (uint256)',
  /*
    确认收货后的售后案件只读视图（`/sync` 与后台对账的链上真值；见 src/chainOrder.js 的
    fetchAfterSaleFor）。刻意只读这两个、不读 settledAtBlock/afterSaleWindowBlocks：
    "窗口还开着吗"由**合约**在 openAfterSale 里判（revert AfterSaleWindowClosed），
    节点不重复实现一遍窗口算术——两套判据迟早漂移，而这里读它并没有任何本地决策要用。
    链上事实源：afterSaleOpenedAtBlock != 0 ⇔ 有在途案件；结案会把它清零
    （所以同一单在窗口内可以再次开案，本地镜像随之回到 open）。
  */
  'function afterSaleOpen(bytes32 orderId) view returns (bool)',
  'function afterSaleOpenedAtBlock(bytes32 orderId) view returns (uint64)',
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
    挂账余额（`_settle` 派发失败时改记到收款方名下，由其 withdrawPayout/withdrawFees 自领）。
    **按地址计**：payouts 读店主地址、fees 读当前全局 feeCollector；合约按**每单创建时快照**的
    收取方扣费，历史收取方的挂账不在这两个读数里（已知边界，见 opsMetrics.accruedReading）。
  */
  'function accruedPayouts(address to) view returns (uint256)',
  'function accruedFees(address collector) view returns (uint256)',
  'function rejectRefund(bytes32 orderId)',
  'function arbiter() view returns (address)',
  'function feeBps() view returns (uint256)',
  // 费用收取方（**全局**披露与兜底口径）：契约层 2026-09 起扣费判据是**每单**的创建时快照
  // `feeCollectorAtCreate`（getOrder 元组新增字段，_settle 只读它），本全局函数在新合约上可能
  // 已移除 ⇒ 读失败即 known=false ⇒ 账本对"没有快照的行"按可能扣费处理（保守，见 fees.js）
  'function feeCollector() view returns (address)',
];

export const ESCROW_STATUS = ['None', 'Created', 'Disputed', 'Settled', 'Refunded'];

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

/** 获取 Escrow 合约实例（只读调用/事件过滤；签名交易由钱包侧发起） */
export function getEscrow() {
  if (!config.chain.escrowAddress) {
    throw new Error('MK_ESCROW_ADDRESS 未配置（合约部署后填入）');
  }
  return new ethers.Contract(config.chain.escrowAddress, ESCROW_ABI, getProvider());
}

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
  const o = await escrow.getOrder(orderIdHex);
  return {
    buyer: o.buyer.toLowerCase(),
    seller: o.seller.toLowerCase(),
    amount: o.amount.toString(),
    feeBps: Number(o.feeBps),
    timeoutBlocks: Number(o.timeoutBlocks),
    createdAtBlock: Number(o.createdAtBlock),
    refundRequested: o.refundRequested,
    refundRejected: o.refundRejected,
    // 已退买家的金额（部分退款/拆分裁决凭据；0 = 未退款，= amount 表示全额退款）
    refundedAmount: String(o.refundedAmount ?? '0'),
    /**
     * **创建时快照的平台费收取方**（小写；零地址原样返回，由 src/fees.js 的 feeSnapshotOf
     * 归一成 `''`=未知 / 零地址=本单不扣费）。合约按它决定这一单扣不扣费，账本必须按单判定。
     */
    feeCollectorAtCreate: String(o.feeCollectorAtCreate ?? '').toLowerCase(),
    status: ESCROW_STATUS[Number(o.status)] || 'None',
  };
}

// ── 仲裁人地址（本地配置优先，其次链上读取 + 短缓存）──
let _arbiterAddr = null;
let _arbiterAt = 0;

/**
 * 解析链上仲裁人（Escrow.arbiter()）：供订单详情「仲裁人视角」鉴权（裁决证据开放）。
 * MK_ARBITER_ADDRESS 配置优先（免 RPC、可单测）；未配置则 RPC 读合约并缓存 60s；
 * RPC 失败也负缓存 60s（不立即重试）——防 RPC 故障时每个详情请求都触发一次超时重试拖慢接口；
 * 失败回退上次成功值；从未成功返回 null——安全方向：宁可拒绝开放不泄露交付码。
 */
export async function getArbiterAddress() {
  const configured = (config.chain.arbiterAddress || '').toLowerCase();
  if (configured) return configured;
  const now = Date.now();
  if (now - _arbiterAt < 60_000) return _arbiterAddr; // 正/负缓存同窗口：失败后 60s 内不重试
  _arbiterAt = now;
  try {
    const a = await getEscrow().arbiter();
    _arbiterAddr = a.toLowerCase();
    return _arbiterAddr;
  } catch {
    return _arbiterAddr; // 失败：null（或上次成功值），负缓存期内不再打 RPC
  }
}