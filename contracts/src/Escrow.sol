// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TokenPayoutVault} from "./TokenPayoutVault.sol";

/// @dev 本节点保证金合约的只读面 + 罚没入口（唯一调用方是本 Escrow）
interface IStakingPenalize {
    function owner() external view returns (address);
    function escrow() external view returns (address);
    function penalizedOrders(bytes32 orderId) external view returns (bool);
    function penalizedClaims(bytes32 claimId) external view returns (bool);
    function claimCapacityRemaining(bytes32 orderId) external view returns (uint256);
    function penalize(bytes32 orderId, address operator, address buyer, uint256 amountWei, address voter) external;
    function penalizeClaim(bytes32 claimId, address seller, address claimant, uint256 amountWei, address voter)
        external;
}

/// @dev 节点白名单内的标准 ERC20（只要求 transfer/transferFrom/balanceOf）
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/**
 * @title Escrow —— 每个节点一个托管合约（正常商城的资金流 + 本节点委员会）
 *
 * 资金流：买家锁定货款 → 卖家发货 → 买家确认收货后货款进入**最多 7 天**的留存期
 *         （取 `min(本单窗口, 7 天)`；窗口更短时按窗口），到期且无在途售后才释放给卖家；
 *         退款回买家；超时释放给卖家。
 * 售后：确认收货后 180 天（上限 360 天）内买家可开案；赔款**只从 Staking 的卖家保证金出**（BTY）。
 * 争议：买家发起 → 本节点委员会按阈值票决（可全额退 / 全额判卖家 / 任意拆分）。
 * 罚没：委员会票决达到阈值后，由本合约调本节点 Staking 从卖家保证金赔给买家。
 * 提货争议：NFT 提货人（当前持有人）与卖家的纠纷，由节点运营方开案、委员会票决，
 *           从卖家保证金赔给提货人（见 ClaimCase）。
 *
 * 本合约**不收任何费用**：没有平台费、没有节点抽成；结算只有买家/卖家两条腿。
 * 店铺、商品、订单明细与任何费率全部在节点链下，合约不读店铺、不读费率。
 *
 * ERC20 支付（节点白名单）：订单的支付资产由 orderToken 固定，退款/结算/留存/卖家退款全部同币种。
 * 售后赔付是**跨币种**的：Staking 只有原生 BTY，所以代币单的赔款也是 BTY（从卖家 BTY 保证金出）。
 * 提货争议仍拒绝代币单（提货人不是买家，订单的代币账本没有对应预留额度）。
 */
contract Escrow is Ownable2Step, ReentrancyGuard {
    enum OrderStatus {
        None,
        Created,
        Disputed,
        Settled,
        Refunded
    }

    struct Order {
        address buyer;
        address seller;
        uint256 amount;
        uint64 timeoutBlocks;
        uint64 createdAtBlock;
        bool refundRequested;
        bool refundRejected;
        uint256 refundedAmount;
        OrderStatus status;
        bool buyerConfirmed;
    }

    /// @dev 提货争议案件（节点运营方开案，委员会票决赔给提货人）
    struct ClaimCase {
        bytes32 orderId;
        bytes32 tokenRef; // keccak256(nftContract, tokenId)；同一订单同一 tokenRef 只允许一个未结案
        address seller;
        address claimant;
        uint256 amount; // 开案时的争议金额上限（还受 _freeBuyerCredit 与 Staking 容量双重约束）
        uint64 deadline; // 裁决/投票截止（开案时夹到 90 天；过期票不生效，owner 可撤销）
        uint64 openedAt;
        bool closed;
    }

    /* ── 订单状态 ───────────────────────────────────────────────────── */

    mapping(bytes32 => Order) internal _orders;

    /// @dev 买家已精确授权的部分退款金额（0 = 未授权）
    mapping(bytes32 => uint256) public acceptedPartialRefund;

    /// @notice 订单支付资产：address(0)=原生 BTY；否则为节点白名单 ERC20
    mapping(bytes32 => address) public orderToken;

    /// @notice 节点支持作为支付资产的 ERC20（不含原生 BTY，原生恒支持）
    mapping(address => bool) public supportedToken;

    /// @dev 卖家拒绝退款的区块（0 = 从未拒绝）
    mapping(bytes32 => uint64) public refundRejectedAtBlock;

    /// @dev 卖家**结算前**在途敞口 = Σ 退款待决/争议中/被拒未终局订单的 amount（不含结算后的售后案；提货争议另有 `sellerClaimExposure`）
    mapping(address => uint256) public sellerOpenExposure;

    /// @dev 订单是否有在途**结算前**退款/争议（幂等开/关；售后案件是另一层，不写这里）
    mapping(bytes32 => bool) private caseOpen;

    /// @dev 全局在途**结算前**退款/争议敞口（仅原生单；不含售后案件与提货赔付）
    uint256 public totalOpenExposure;

    /// @dev 订单判给卖家的实收净额（罚款单笔上限基准）
    mapping(bytes32 => uint256) public sellerNetAtSettle;

    /// @dev 确认收货后暂存、尚未释放给卖家的货款（售后留存期）
    mapping(bytes32 => uint256) public sellerPending;

    /// @dev 暂存货款最早可释放区块（结算时按 `min(本单窗口, 7 天)` 锁定）
    mapping(bytes32 => uint64) public sellerPendingUnlockBlock;

    /// @dev 订单判给卖家的区块（售后窗口起算）
    mapping(bytes32 => uint64) public settledAtBlock;

    /// @dev 确认收货后售后案件的开案区块（0 = 无在途案件）
    mapping(bytes32 => uint64) public afterSaleOpenedAtBlock;

    /// @dev 售后案件结案区块（0 = 从未结案；结案是终态）
    mapping(bytes32 => uint64) public afterSaleClosedAtBlock;

    /**
     * @notice 售后案是**强制到期**结案的（不是买家撤诉/委员会裁决）。
     *
     * 强制结案释放卖家 pending，但**不消灭**窗口内剩余的第二层罚没救济：Staking 的
     * `buyerConfirmed` 门槛在 `afterSaleOpen` 与这个标志任一为真时放行。买家撤诉/委员会
     * 裁决结案不置位，罚没资格仍按"买家已认可"收回。窗口到期后 `_afterSaleInWindow`
     * 仍会拒绝，所以它不是无限期翻案入口。
     */
    mapping(bytes32 => bool) public afterSaleForcedClosed;

    /* ── 委员会 ─────────────────────────────────────────────────────── */

    struct Committee {
        address[] members;
        uint16 threshold;
    }

    uint16 internal constant MAX_ARBITERS = 20;
    uint32 public committeeEpoch;
    mapping(uint32 => Committee) private _committees;
    mapping(uint32 => mapping(address => bool)) private _inCommittee;
    mapping(address => bool) public revokedArbiter;
    mapping(bytes32 => mapping(uint8 => mapping(uint32 => mapping(address => uint256)))) private _voteValue;
    mapping(bytes32 => mapping(uint8 => mapping(uint32 => mapping(address => bool)))) private _voted;

    uint8 private constant VOTE_SETTLEMENT = 0;
    uint8 private constant VOTE_PENALTY = 1;
    uint8 private constant VOTE_AFTER_SALE = 2;
    uint8 private constant VOTE_CLAIM = 3;

    /* ── 提货争议 ───────────────────────────────────────────────────── */

    mapping(bytes32 => ClaimCase) private _claimCases;
    /// @dev orderId => tokenRef => 是否已有未结案 claim（同一订单同一 token 同时只能有一案）
    mapping(bytes32 => mapping(bytes32 => bool)) private _claimOpenForOrderToken;
    /// @dev 同一订单所有未结案 claim 的金额累计；不同 tokenRef 也不能把赔付敞口堆到订单净额之上
    mapping(bytes32 => uint256) public orderClaimExposure;
    /// @dev 卖家在途提货争议敞口（开案时锁定，结案释放；Staking 出金下限读它）
    mapping(address => uint256) public sellerClaimExposure;
    /// @dev 订单累计已通过提货争议赔付给 claimant 的金额（与买家退款分开）
    mapping(bytes32 => uint256) public claimPaidByOrder;

    /// @dev 案件是否已有投票（按当前委员会届次；换届后旧票不再阻塞撤销）
    mapping(bytes32 => mapping(uint32 => bool)) private _claimVoted;

    /* ── 配置 ───────────────────────────────────────────────────────── */

    /// @notice 节点自己是否接新单（owner 可暂停；不依赖任何 Registry）
    bool public acceptingOrders = true;

    /// @notice 本节点保证金合约（一次性接线）
    address public staking;

    /// @dev ERC20 出金失败时的挂账合约；address(0) = 未配置，失败出金直接回滚。
    ///      刻意用 storage 而不是 immutable：Registry 按**全量 runtime 哈希**白名单实现，
    ///      immutable 会把部署参数烧进 runtime，导致每个节点的 Escrow 哈希都不同、无法登记。
    address private tokenVault;

    /// @notice 委员会治理合约（一次性接线；设置后委员会成员与窗口参数只能由它改）
    address public governor;

    /// @notice 拒绝退款后的释放静置期（块）
    uint64 public rejectGraceBlocks;
    mapping(bytes32 => uint64) private rejectGraceAtCreate;

    uint64 public constant MAX_TIMEOUT_BLOCKS = 518_400;
    uint64 internal constant MIN_ORDER_TIMEOUT_BLOCKS = 17_280;
    uint64 internal constant MAX_REJECT_GRACE_BLOCKS = 172_800;
    uint64 internal constant MIN_REJECT_GRACE_BLOCKS = 17_280;
    uint64 internal constant MAX_AFTER_SALE_WINDOW_BLOCKS = 6_220_800;
    uint64 internal constant MIN_AFTER_SALE_WINDOW_BLOCKS = 17_280;

    uint64 public minTimeoutBlocks;
    uint64 public afterSaleWindowBlocks;
    /**
     * @dev 卖家货款在确认收货后的**最长留存期**：7 天（BTY 5 秒/块 = 120,960 块）。
     *
     * 售后窗口可能很长（生产默认 180 天），卖家回款不能等半年：留存最多 7 天，窗口余下的
     * 时间由 Staking 保证金兜底。留存期内若有在途售后案件，`releaseSellerFunds` 会被
     * `PendingCaseOpen` 挡住——钱**重新冻结到案件结案**（或到期强制结案）为止；
     * 结案后不需要再等，到点即可释放。
     */
    uint64 public constant SELLER_HOLDBACK_BLOCKS = 120_960;
    // 售后案件的**投票**上限（90 天，按 BTY 5 秒/块 = 1_555_200）。
    // 案件开在 7 天留存期内时会把货款冻结到结案；没有绝对出口就等于“买家开案后消失、
    // 留存货款永久留在 Escrow”。强制结案出口取**先到者**：开案 + 90 天（本上限，投票已关）
    // 或 结算 + 窗口（Staking 侧也不再受理罚没）——两者任一到期，任何人可结案并释放余款。
    // 强制结案会置 `afterSaleForcedClosed`：只释放 pending，**不消灭**原窗口内剩余的
    // 第二层罚没救济（Staking.buyerConfirmed 门槛同时看 afterSaleOpen/afterSaleForcedClosed）。
    // 因此 90 天是“留存货款”的实际期限，不是“罚没资格”的期限；后者仍以结算时快照的窗口为准。
    uint64 internal constant MAX_AFTER_SALE_CASE_BLOCKS = 1_555_200;
    /**
     * @dev 提货争议案的最长裁决期（90 天，按 unix 秒）。deadline 来自 owner，原先没有上界：
     *      `type(uint64).max` 会让 sellerClaimExposure 永久压住卖家出金，而 `claimUnstake`
     *      （owner 失联时的唯一出口）只受敞口约束——一笔 1 wei 的争议就能让它永远 revert。
     *      与 after-sale 的绝对到期同一形状：开案时把 deadline 夹到本上界，之后所有读法
     *      （voteClaim/cancelClaimDispute/前端倒计时）都只看这个已落定的值，不再有第二个判据。
     */
    uint64 internal constant MAX_CLAIM_CASE_SECONDS = 90 days;
    mapping(bytes32 => uint64) private afterSaleWindowAtCreate;
    mapping(bytes32 => uint64) public afterSaleWindowAtSettle;

    uint256 internal constant PAYOUT_GAS_CAP = 100_000;
    uint256 internal constant ACCRUAL_GAS_HEADROOM = 60_000;
    mapping(address => uint256) public accruedPayouts;

    /* ── 事件 ───────────────────────────────────────────────────────── */

    event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, uint256 amount);
    event OrderCreatedToken(
        bytes32 indexed orderId, address indexed buyer, address indexed seller, address token, uint256 amount
    );
    event TokenSupportUpdated(address indexed token, bool supported);
    event ReceiptConfirmed(bytes32 indexed orderId);
    event DisputeRequested(bytes32 indexed orderId);
    event Arbitrated(bytes32 indexed orderId, uint256 refundWei);
    event OrderExpiredReleased(bytes32 indexed orderId);
    event RefundRequested(bytes32 indexed orderId);
    event RefundRejected(bytes32 indexed orderId);
    event PartialRefundAccepted(bytes32 indexed orderId, uint256 refundWei);
    event RefundApproved(bytes32 indexed orderId, uint256 refundWei);
    event PayoutAccrued(address indexed to, uint256 amount);
    event PayoutWithdrawn(address indexed to, uint256 amount);
    event SellerPendingAccrued(bytes32 indexed orderId, address indexed seller, uint256 amount, uint64 unlockBlock);
    event SellerFundsReleased(bytes32 indexed orderId, address indexed seller, uint256 amount);
    // amount = 本次退给买家的金额；refundedTotal = 含本次在内的累计已付买家（订单级上限的唯一读数）
    event SellerRefunded(bytes32 indexed orderId, address indexed buyer, uint256 amount, uint256 refundedTotal);
    /// @notice 提货争议赔付给 claimant（可能是买家之外的提货人）；与买家退款分开记账
    event ClaimPaid(
        bytes32 indexed orderId,
        bytes32 indexed claimId,
        address indexed claimant,
        uint256 amount,
        uint256 refundedTotal,
        uint256 claimPaidTotal
    );
    event AfterSaleOpened(bytes32 indexed orderId, address indexed buyer, address indexed seller);
    event AfterSaleClosed(bytes32 indexed orderId, address indexed by, string note);
    event CommitteeUpdated(uint32 indexed epoch, address[] members, uint16 threshold);
    event ArbiterRevoked(address indexed arbiter);
    event SettlementVoted(
        bytes32 indexed orderId, address indexed arbiter, uint256 refundWei, uint16 votes, uint16 threshold
    );
    event PenaltyVoted(
        bytes32 indexed orderId, address indexed arbiter, uint256 amountWei, uint16 votes, uint16 threshold
    );
    event AfterSaleVoted(
        bytes32 indexed orderId, address indexed arbiter, uint256 penaltyWei, uint16 votes, uint16 threshold
    );
    event ClaimDisputeOpened(
        bytes32 indexed claimId,
        bytes32 indexed orderId,
        address indexed seller,
        address claimant,
        uint256 amount,
        uint64 deadline
    );
    event ClaimVoted(
        bytes32 indexed claimId, address indexed arbiter, uint256 amountWei, uint16 votes, uint16 threshold
    );
    event ClaimClosed(bytes32 indexed claimId, uint256 amountWei, address indexed claimant);
    event ClaimDisputeCancelled(bytes32 indexed claimId, string reason);
    event StakingSet(address indexed staking);
    event GovernorSet(address indexed governor);
    event AcceptingOrdersSet(bool accepting);
    event RejectGraceBlocksUpdated(uint64 indexed newValue);
    event MinTimeoutBlocksUpdated(uint64 indexed newValue);
    event AfterSaleWindowBlocksUpdated(uint64 indexed newValue);

    /* ── 错误 ───────────────────────────────────────────────────────── */

    error InvalidOrder();
    error OnlyOwner();
    error OrderExists();
    error NotBuyer();
    error OnlyArbiter();
    error NotArbiter();
    error InvalidArbiter();
    error NoArbiter();
    error DuplicateArbiter();
    error CommitteeTooLarge();
    error ThresholdOutOfBounds();
    error RoleConflict();
    error AlreadyConfigured();
    error StakingNotConfigured();
    error OrdersPaused();
    error OrderNotSettled();
    error InvalidTimeout();
    error NotCreated();
    error NotDisputed();
    error InvalidAmount();
    error NativeTransferFailed();
    error AmountMismatch();
    error OwnershipLocked();
    error NotSeller();
    error RefundNotRequested();
    error RefundAlreadyRequested();
    error RefundPending();
    error RefundNotRejected();
    error RefundAlreadyRejected();
    error RefundAmountOutOfRange();
    error RefundAmountNotAccepted();
    error NothingToWithdraw();
    error PendingAmountTooLarge();
    error PendingLocked();
    error PendingCaseOpen();
    error NothingSellerPending();
    error TokenNotSupported();
    error TokenAmountMismatch();

    error TokenClaimsNotSupported();
    error TokenTransferFailed();
    error InvalidRejectGrace();
    error RefundRequestTooLate();
    error RejectGraceActive();
    error InvalidMinTimeout();
    error TimeoutTooShort();
    error InvalidAfterSaleWindow();
    error NotSettledForAfterSale();
    error AfterSaleWindowClosed();
    error AfterSaleAlreadyOpen();
    error AfterSaleNotOpen();
    error AfterSaleCaseClosed();
    error ExposureAccountingBroken();
    error ClaimExists();
    error ClaimNotOpen();
    error ClaimAlreadyVoted();
    error InvalidClaimant();
    error InvalidClaimAmount();
    error ClaimCapacityExceeded();
    error ClaimDeadlinePassed();
    error GovernorMismatch();
    error InvalidTokenVault();

    constructor(
        address initialOwner,
        uint64 rejectGraceBlocks_,
        uint64 minTimeoutBlocks_,
        uint64 afterSaleWindowBlocks_,
        address tokenVault_
    ) Ownable(initialOwner) {
        // 非零 vault 必须是合约：EOA 会收下 ERC20，随后空 credit 调用也会“成功”，账目丢失。
        if (tokenVault_ != address(0)) {
            if (tokenVault_.code.length == 0) revert InvalidTokenVault();
            // 至少要有 TokenPayoutVault 的读接口；任意带 fallback 的合约通过 code.length 检查后
            // 仍可能把 token 收下却不记账，这里用只读探针把“不是这套接口”的地址挡在部署期。
            (bool ok, bytes memory ret) =
                tokenVault_.staticcall(abi.encodeWithSignature("credits(address,address)", address(0), address(0)));
            if (!ok || ret.length < 32) revert InvalidTokenVault();
            /*
               vault 必须尚未绑定 Escrow：同一个 vault 只能服务一个 Escrow。
               Escrow 在构造时还不可能被 setEscrow 绑定，所以此刻非零只可能是“另一个 Escrow 已占用”；
               token 出金的 credit 会因 OnlyEscrow 回滚，最终把 token 卡在 Escrow 里。
            */
            (ok, ret) = tokenVault_.staticcall(abi.encodeWithSignature("escrow()"));
            if (!ok || ret.length < 32 || abi.decode(ret, (address)) != address(0)) revert InvalidTokenVault();
        }
        tokenVault = tokenVault_;
        if (rejectGraceBlocks_ < MIN_REJECT_GRACE_BLOCKS || rejectGraceBlocks_ > MAX_REJECT_GRACE_BLOCKS) {
            revert InvalidRejectGrace();
        }
        rejectGraceBlocks = rejectGraceBlocks_;
        if (minTimeoutBlocks_ < MIN_ORDER_TIMEOUT_BLOCKS || minTimeoutBlocks_ > MAX_TIMEOUT_BLOCKS) {
            revert InvalidMinTimeout();
        }
        minTimeoutBlocks = minTimeoutBlocks_;
        if (afterSaleWindowBlocks_ < MIN_AFTER_SALE_WINDOW_BLOCKS || afterSaleWindowBlocks_ > MAX_AFTER_SALE_WINDOW_BLOCKS)
        {
            revert InvalidAfterSaleWindow();
        }
        afterSaleWindowBlocks = afterSaleWindowBlocks_;
    }

    /* ── 买家 ───────────────────────────────────────────────────────── */

    /// @notice 创建托管订单并锁定原生 BTY 货款。店铺/订单号由节点自己的库负责。
    function createOrder(bytes32 orderId, address seller, uint256 amount, uint64 timeoutBlocks)
        external
        payable
        nonReentrant
    {
        if (msg.value != amount) revert AmountMismatch();
        _createOrderCommon(orderId, seller, amount, timeoutBlocks, address(0));
        emit OrderCreated(orderId, msg.sender, seller, amount);
    }

    /// @notice 创建托管订单并锁定节点白名单内的 ERC20 货款（调用前须 approve 本合约）。
    function createOrderToken(
        bytes32 orderId,
        address seller,
        address token,
        uint256 amount,
        uint64 timeoutBlocks
    ) external payable nonReentrant {
        if (msg.value != 0) revert AmountMismatch();
        if (token == address(0) || token.code.length == 0 || !supportedToken[token]) revert TokenNotSupported();
        _createOrderCommon(orderId, seller, amount, timeoutBlocks, token);

        uint256 before = IERC20(token).balanceOf(address(this));
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert TokenTransferFailed();
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert TokenAmountMismatch();
        emit OrderCreated(orderId, msg.sender, seller, amount);
        emit OrderCreatedToken(orderId, msg.sender, seller, token, amount);
    }

    function _createOrderCommon(
        bytes32 orderId,
        address seller,
        uint256 amount,
        uint64 timeoutBlocks,
        address token
    ) private {
        if (staking == address(0)) revert StakingNotConfigured();
        if (committeeEpoch == 0) revert NoArbiter();
        if (!acceptingOrders) revert OrdersPaused();

        if (orderId == bytes32(0)) revert InvalidOrder();
        if (seller == address(0) || seller == msg.sender || seller == address(this)) revert InvalidOrder();
        if (amount == 0) revert InvalidAmount();
        if (timeoutBlocks == 0 || timeoutBlocks > MAX_TIMEOUT_BLOCKS) revert InvalidTimeout();
        if (timeoutBlocks < minTimeoutBlocks) revert TimeoutTooShort();
        if (_orders[orderId].status != OrderStatus.None) revert OrderExists();

        Order storage o = _orders[orderId];
        o.buyer = msg.sender;
        o.seller = seller;
        o.amount = amount;
        o.timeoutBlocks = timeoutBlocks;
        o.createdAtBlock = uint64(block.number);
        o.status = OrderStatus.Created;
        orderToken[orderId] = token;
        rejectGraceAtCreate[orderId] = rejectGraceBlocks;
        afterSaleWindowAtCreate[orderId] = afterSaleWindowBlocks;
    }

    /// @notice 买家确认收货（或争议中撤诉放款）→ 结算；货款进入 7 天留存期（不超过本单窗口）
    function confirmReceipt(bytes32 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Created && o.status != OrderStatus.Disputed) revert NotCreated();
        if (msg.sender != o.buyer) revert NotBuyer();
        o.buyerConfirmed = true;
        _settle(orderId, o, 0);
        emit ReceiptConfirmed(orderId);
    }

    /// @notice 买家申请退款（仅超时前；超时后的救济路径是发起争议）
    function requestRefund(bytes32 orderId) external {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Created) revert NotCreated();
        if (msg.sender != o.buyer) revert NotBuyer();
        if (block.number > uint256(o.createdAtBlock) + uint256(o.timeoutBlocks)) revert RefundRequestTooLate();
        if (o.refundRequested) revert RefundAlreadyRequested();
        if (o.refundRejected) revert RefundAlreadyRejected();
        o.refundRequested = true;
        _openCase(orderId, o);
        emit RefundRequested(orderId);
    }

    /// @notice 买家对**具体金额**授权部分退款（0 = 撤回授权）
    function acceptPartialRefund(bytes32 orderId, uint256 refundWei) external {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Created && o.status != OrderStatus.Disputed) revert NotCreated();
        if (msg.sender != o.buyer) revert NotBuyer();
        if (refundWei >= o.amount) revert RefundAmountOutOfRange();
        if (refundWei == 0) {
            delete acceptedPartialRefund[orderId];
            emit PartialRefundAccepted(orderId, 0);
            return;
        }
        acceptedPartialRefund[orderId] = refundWei;
        emit PartialRefundAccepted(orderId, refundWei);
    }

    /// @notice 买家发起争议（卖家拒绝过，或订单已超时）
    function requestDispute(bytes32 orderId) external {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Created) revert NotCreated();
        if (msg.sender != o.buyer) revert NotBuyer();
        if (!o.refundRejected && block.number <= uint256(o.createdAtBlock) + uint256(o.timeoutBlocks)) {
            revert RefundNotRejected();
        }
        if (committeeEpoch == 0) revert NoArbiter();
        o.status = OrderStatus.Disputed;
        _openCase(orderId, o);
        emit DisputeRequested(orderId);
    }

    /// @notice 确认收货后就商品问题开一个链上售后案件（只接受买家自己确认、**未全额退款**的单）
    function openAfterSale(bytes32 orderId) external {
        Order storage o = _orders[orderId];
        if (msg.sender != o.buyer) revert NotBuyer();
        // 已全额退买家 = 没有可再赔的余额；部分退款仍可开案，剩余额度由 refundedAmount 收敛
        if (o.status != OrderStatus.Settled || !o.buyerConfirmed || o.refundedAmount >= o.amount) {
            revert NotSettledForAfterSale();
        }
        if (afterSaleClosedAtBlock[orderId] != 0) revert AfterSaleCaseClosed();
        uint64 settled = settledAtBlock[orderId];
        if (settled == 0) revert NotSettledForAfterSale();
        uint64 window = afterSaleWindowAtSettle[orderId];
        if (window == 0) revert NotSettledForAfterSale();
        if (block.number > uint256(settled) + uint256(window)) revert AfterSaleWindowClosed();
        if (afterSaleOpenedAtBlock[orderId] != 0) revert AfterSaleAlreadyOpen();
        afterSaleOpenedAtBlock[orderId] = uint64(block.number);
        emit AfterSaleOpened(orderId, o.buyer, o.seller);
    }

    /// @notice 买家撤诉结案（不涉及罚没）
    function closeAfterSale(bytes32 orderId, string calldata note) external {
        Order storage o = _orders[orderId];
        if (msg.sender != o.buyer) revert NotBuyer();
        if (afterSaleOpenedAtBlock[orderId] == 0) revert AfterSaleNotOpen();
        _closeAfterSaleCase(orderId);
        emit AfterSaleClosed(orderId, msg.sender, note);
    }

    /* ── 卖家 ───────────────────────────────────────────────────────── */

    /// @notice 卖家同意退款：全额，或买家已精确授权的部分金额
    function approveRefund(bytes32 orderId, uint256 refundWei) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Created && o.status != OrderStatus.Disputed) revert NotCreated();
        if (msg.sender != o.seller) revert NotSeller();
        if (refundWei > o.amount) revert RefundAmountOutOfRange();
        if (refundWei != o.amount) {
            uint256 auth = acceptedPartialRefund[orderId];
            if (auth == 0 || auth != refundWei) revert RefundAmountNotAccepted();
        }
        o.buyerConfirmed = true;
        _settle(orderId, o, refundWei);
        emit RefundApproved(orderId, refundWei);
    }

    /// @notice 卖家拒绝退款申请（此后买家可发起争议；释放须再等静置期）
    function rejectRefund(bytes32 orderId) external {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Created) revert NotCreated();
        if (msg.sender != o.seller) revert NotSeller();
        if (!o.refundRequested) revert RefundNotRequested();
        o.refundRequested = false;
        o.refundRejected = true;
        refundRejectedAtBlock[orderId] = uint64(block.number);
        delete acceptedPartialRefund[orderId];
        emit RefundRejected(orderId);
    }

    /* ── 任何人 ─────────────────────────────────────────────────────── */

    /// @notice 超时释放：超时 + 无待决退款 + 拒绝静置期已过 → 全额结算给卖家
    function releaseExpired(bytes32 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Created) revert NotCreated();
        if (block.number <= uint256(o.createdAtBlock) + uint256(o.timeoutBlocks)) revert InvalidTimeout();
        if (o.refundRequested) revert RefundPending();
        if (o.refundRejected) {
            if (block.number <= uint256(refundRejectedAtBlock[orderId]) + _rejectGraceBlocks(orderId)) {
                revert RejectGraceActive();
            }
        }
        _settle(orderId, o, 0);
        emit OrderExpiredReleased(orderId);
    }

    function withdrawPayout() external nonReentrant {
        uint256 v = accruedPayouts[msg.sender];
        if (v == 0) revert NothingToWithdraw();
        accruedPayouts[msg.sender] = 0;
        _sendNative(msg.sender, v);
        emit PayoutWithdrawn(msg.sender, v);
    }

    /**
     * @notice 释放确认收货后的留存货款给卖家。
     * @dev **任何人可调**（owner/seller/keeper 都行）：钱只会打给订单卖家，调用者拿不到。
     *      条件：结算已过留存期（7 天），且没有在途售后案件。案件在途时有两个到期出口，
     *      **以先到者为准**：开案满 90 天（委员会投票上限，`MAX_AFTER_SALE_CASE_BLOCKS`），
     *      或本单窗口结束（`settledAtBlock + afterSaleWindowAtSettle`，窗口一过 Staking 侧
     *      也不再接受罚没）。到期后任何人可强制结案并释放余款——不让案件无限期压住卖家回款。
     */
    function releaseSellerFunds(bytes32 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Settled) revert OrderNotSettled();
        /*
          绝对到期必须先于 pending==0 判断：卖家可在案件在途时用 refundSettled 把留存退空，
          买家随后消失；若先因 pending==0 回滚，这个案件就再没有 permissionless 出口。
        */
        bool forcedClose = false;
        uint64 opened = afterSaleOpenedAtBlock[orderId];
        if (opened != 0) {
            /*
              两个到期出口取**先到者**：开案满 90 天（投票已关），或本单窗口结束
              （`block.number > settled + window`；Staking 侧从下一刻起也不再受理罚没）。
            */
            bool voteDeadlinePassed = block.number >= uint256(opened) + MAX_AFTER_SALE_CASE_BLOCKS;
            if (!voteDeadlinePassed && block.number <= uint256(settledAtBlock[orderId]) + uint256(afterSaleWindowAtSettle[orderId])) {
                revert PendingCaseOpen();
            }
            _closeAfterSaleCase(orderId);
            afterSaleForcedClosed[orderId] = true;
            forcedClose = true;
            emit AfterSaleClosed(orderId, msg.sender, "expired");
        }
        uint256 pending = sellerPending[orderId];
        if (pending == 0) {
            if (opened != 0) return; // 只完成了到期结案，没有钱可放
            revert NothingSellerPending();
        }
        // 强制结案是绝对出口，绕过普通留存解锁；否则结案写入会被下面的 PendingLocked 回滚。
        if (!forcedClose && block.number < uint256(sellerPendingUnlockBlock[orderId])) revert PendingLocked();
        sellerPending[orderId] = 0;
        _payoutOrCredit(orderId, o.seller, pending);
        emit SellerFundsReleased(orderId, o.seller, pending);
    }

    /**
     * @notice 卖家在留存期内主动把留存货款退给买家（部分/全额）。
     * @dev 只动 sellerPending，不动 Staking；退款后剩余留存仍按原解锁区块释放。
     */
    function refundSettled(bytes32 orderId, uint256 refundWei) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Settled) revert OrderNotSettled();
        if (msg.sender != o.seller) revert NotSeller();
        if (refundWei == 0 || refundWei > sellerPending[orderId]) revert PendingAmountTooLarge();
        if (refundWei > _freeBuyerCredit(orderId, o)) revert RefundAmountOutOfRange();
        /*
          留存期退款也必须服从订单级“买家已受偿 <= amount”的上限。
          旧实现只看 sellerPending：先 votePenalty 把 refundedAmount 加上去、
          却不减少 sellerPending，卖家再退整个 pending 就会让 refundedAmount > amount，
          后续 voteAfterSale/openClaimDispute 的减法下溢，watcher 也会把合法事件隔离。
        */
        _creditBuyerFromPending(orderId, o, refundWei);
        emit SellerRefunded(orderId, o.buyer, refundWei, o.refundedAmount);
    }

    /* ── 委员会票决 ─────────────────────────────────────────────────── */

    function voteSettlement(bytes32 orderId, uint256 refundWei) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Disputed) revert NotDisputed();
        if (refundWei > o.amount) revert RefundAmountOutOfRange();
        _rejectSelfVote(o);
        (uint16 votes, uint16 threshold) = _castVote(orderId, VOTE_SETTLEMENT, refundWei);
        emit SettlementVoted(orderId, msg.sender, refundWei, votes, threshold);
        if (votes >= threshold) {
            _settle(orderId, o, refundWei);
            emit Arbitrated(orderId, refundWei);
        }
    }

    function votePenalty(bytes32 orderId, uint256 amountWei) external nonReentrant {
        Order storage o = _orders[orderId];
        if (amountWei == 0) revert InvalidAmount();
        if (o.status != OrderStatus.Settled) revert OrderNotSettled();
        if (staking == address(0)) revert StakingNotConfigured();
        /*
          原生单：未结案提货争议已预留的额度不能被罚没吃掉；否则 claim 在投票执行时会因订单上限回滚。
          代币单：赔付从 BTY 保证金出，与订单的代币账本**不同币种**，`refundedAmount` 不参与，
          上限只由 Staking 的池子与票决决定（见 `_penalizeFromStake`）。
        */
        if (orderToken[orderId] == address(0) && amountWei > _freeBuyerCredit(orderId, o)) revert InvalidAmount();
        _rejectSelfVote(o);
        (uint16 votes, uint16 threshold) = _castVote(orderId, VOTE_PENALTY, amountWei);
        emit PenaltyVoted(orderId, msg.sender, amountWei, votes, threshold);
        if (votes >= threshold) _penalizeFromStake(orderId, o, amountWei, msg.sender);
    }

    /**
     * @notice 售后结案：委员会票决赔付金额（0 = 判卖家无责），达到阈值后**一次完成**赔付与结案。
     *
     * 赔付款**只从 Staking 的卖家保证金出**（原生单付 BTY；代币单也付 BTY）——7 天留存期
     * 只决定卖家什么时候能拿走货款，不是买家的赔付资金池。代币单的这笔钱不进以支付代币计的
     * `refundedAmount`，累计上限由 Staking 的 `penalizedByOrderTotal` 单独记。
     *
     * 时间窗两条：案件开案后 90 天内可票决（`MAX_AFTER_SALE_CASE_BLOCKS`）；强制结案出口取
     * “开案 + 90 天”与“结算 + 窗口”的**先到者**（见 `releaseSellerFunds`）。赔付本身仍受
     * 该单快照窗口约束（Staking 的 `_afterSaleInWindow`）。
     */
    function voteAfterSale(bytes32 orderId, uint256 penaltyWei) external nonReentrant {
        Order storage o = _orders[orderId];
        uint64 opened = afterSaleOpenedAtBlock[orderId];
        if (opened == 0) revert AfterSaleNotOpen();
        if (block.number >= uint256(opened) + MAX_AFTER_SALE_CASE_BLOCKS) revert AfterSaleWindowClosed();
        if (penaltyWei > 0) {
            if (staking == address(0)) revert StakingNotConfigured();
            if (orderToken[orderId] == address(0) && penaltyWei > _freeBuyerCredit(orderId, o)) revert InvalidAmount();
        }
        _rejectSelfVote(o);
        (uint16 votes, uint16 threshold) = _castVote(orderId, VOTE_AFTER_SALE, penaltyWei);
        emit AfterSaleVoted(orderId, msg.sender, penaltyWei, votes, threshold);
        if (votes >= threshold) {
            if (penaltyWei > 0) _penalizeFromStake(orderId, o, penaltyWei, msg.sender);
            _closeAfterSaleCase(orderId);
            emit AfterSaleClosed(orderId, msg.sender, "");
        }
    }

    /**
     * @dev 委员会判赔的**唯一付款腿**：`votePenalty` 与 `voteAfterSale` 共用，钱只从 Staking 出。
     *
     * 原生单：先记账（订单级"买家已受偿 ≤ amount"）再付款，并复用 `SellerRefunded` 让 watcher
     * 把 `refunded_amount_wei` 写回——CEI 顺序：回调里的 `openAfterSale`/`openClaimDispute`
     * 必须看到已写入的账本；Staking 付款 revert 时记账随整笔回滚。
     * 代币单：赔偿是 BTY，不能写进以支付代币计的 `refundedAmount`（同一列混两种单位会让
     * `_freeBuyerCredit` 与 watcher 都读到错数字）；累计上限由 Staking 的
     * `penalizedByOrderTotal` 单独记，Escrow 不发 `SellerRefunded`。
     */
    function _penalizeFromStake(bytes32 orderId, Order storage o, uint256 amountWei, address voter) private {
        if (orderToken[orderId] == address(0)) {
            _accountBuyerCredit(o, amountWei);
            IStakingPenalize(staking).penalize(orderId, o.seller, o.buyer, amountWei, voter);
            emit SellerRefunded(orderId, o.buyer, amountWei, o.refundedAmount);
            return;
        }
        IStakingPenalize(staking).penalize(orderId, o.seller, o.buyer, amountWei, voter);
    }

    /* ── 提货争议 ───────────────────────────────────────────────────── */

    /// @notice 节点运营方开提货争议案（提货人不是原买家，所以不能走 openAfterSale）
    function openClaimDispute(
        bytes32 claimId,
        bytes32 orderId,
        bytes32 tokenRef,
        address seller,
        address claimant,
        uint256 amount,
        uint64 deadline
    ) external onlyOwner {
        if (claimId == bytes32(0) || _claimCases[claimId].openedAt != 0) revert ClaimExists();
        if (_claimOpenForOrderToken[orderId][tokenRef]) revert ClaimExists();
        if (staking == address(0)) revert StakingNotConfigured();
        if (committeeEpoch == 0) revert NoArbiter();
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Settled) revert OrderNotSettled();
        if (orderToken[orderId] != address(0)) revert TokenClaimsNotSupported();
        if (o.seller != seller) revert InvalidOrder();
        // 提货争议也是售后权利：窗口过了就不能再开案/锁卖家敞口。
        uint64 settled = settledAtBlock[orderId];
        uint64 window = afterSaleWindowAtSettle[orderId];
        if (settled == 0 || window == 0 || block.number > uint256(settled) + uint256(window)) {
            revert AfterSaleWindowClosed();
        }
        if (claimant == address(0) || claimant == seller || claimant == address(this)) revert InvalidClaimant();
        if (amount == 0 || amount > _freeBuyerCredit(orderId, o)) revert InvalidClaimAmount();
        if (amount > IStakingPenalize(staking).claimCapacityRemaining(orderId)) revert ClaimCapacityExceeded();
        if (block.timestamp > deadline) revert ClaimDeadlinePassed();
        /*
          入口即收口：deadline 是 owner 传入的唯一时间参数，先夹到"开案 + 90 天"。
          之后 voteClaim / cancelClaimDispute / 前端倒计时都读同一个已落定的 c.deadline，
          不会出现"合约按 90 天停、界面按 10 年倒计时"的两套真相。
        */
        uint64 openedAt = uint64(block.timestamp);
        uint64 maxDeadline = openedAt + MAX_CLAIM_CASE_SECONDS;
        if (deadline > maxDeadline) deadline = maxDeadline;

        _claimCases[claimId] = ClaimCase({
            orderId: orderId,
            tokenRef: tokenRef,
            seller: seller,
            claimant: claimant,
            amount: amount,
            deadline: deadline,
            openedAt: openedAt,
            closed: false
        });
        _claimOpenForOrderToken[orderId][tokenRef] = true;
        orderClaimExposure[orderId] += amount;
        sellerClaimExposure[seller] += amount;
        emit ClaimDisputeOpened(claimId, orderId, seller, claimant, amount, deadline);
    }

    /// @notice 委员会对提货争议投票：票值 = 赔给提货人的金额（0 = 判卖家无责并结案）
    function voteClaim(bytes32 claimId, uint256 amountWei) external nonReentrant {
        ClaimCase storage c = _claimCases[claimId];
        if (c.openedAt == 0 || c.closed) revert ClaimNotOpen();
        // deadline 是**裁决**截止，不只是开案截止：过期后票不再生效，任何人可撤销并释放敞口。
        if (block.timestamp > c.deadline) revert ClaimDeadlinePassed();
        if (amountWei > c.amount) revert InvalidClaimAmount();
        Order storage claimOrder = _orders[c.orderId];
        /*
          利益冲突面与 `votePenalty` 同口径：提货争议虽然赔付给 claimant（不一定是原买家），
          但它**消耗原买家的订单级受偿额度**（refundedAmount 共享），原买家仍是利害关系人。
          旧实现只排斥 seller/claimant，买家若是委员可以对涉及自己订单的赔付投票，且前端
          `chainErrorText` 已经对外宣称"任何委员都不能在自己是买家或卖家的单上投票"。
        */
        if (msg.sender == c.seller || msg.sender == c.claimant || msg.sender == claimOrder.buyer) {
            revert InvalidArbiter();
        }
        _claimVoted[claimId][committeeEpoch] = true;
        // 与订单票同一判据：当前委员会名单，不再有 claim 届次快照
        (uint16 votes, uint16 threshold) = _castVote(claimId, VOTE_CLAIM, amountWei);
        emit ClaimVoted(claimId, msg.sender, amountWei, votes, threshold);
        if (votes >= threshold) {
            if (amountWei > 0) {
                /*
                  先记账、再让 Staking 付款（CEI）：claimant 可能是合约，回调里会重新读
                  refundedAmount / orderClaimExposure；旧顺序先付款后记账会让回调看到旧账本。
                  付款 revert 时记账随整笔回滚，不会留下假账。
                */
                _accountBuyerCredit(claimOrder, amountWei);
                IStakingPenalize(staking).penalizeClaim(claimId, c.seller, c.claimant, amountWei, msg.sender);
                claimPaidByOrder[c.orderId] += amountWei;
                emit ClaimPaid(
                    c.orderId,
                    claimId,
                    c.claimant,
                    amountWei,
                    claimOrder.refundedAmount,
                    claimPaidByOrder[c.orderId]
                );
            }
            _closeClaimCase(claimId, c, amountWei);
        }
    }

    /**
     * @notice 撤销尚未有人投票的提货争议（线下和解）；已到 deadline 后任何人可撤销。
     * @dev 没有这条超时出口，一个委员投 0 票就能永久关闭 owner 的撤销入口，
     *      同时 sellerClaimExposure 会一直压着卖家的出金下限。
     */
    function cancelClaimDispute(bytes32 claimId, string calldata reason) external {
        ClaimCase storage c = _claimCases[claimId];
        if (c.openedAt == 0 || c.closed) revert ClaimNotOpen();
        if (block.timestamp <= c.deadline) {
            if (msg.sender != owner()) revert OnlyOwner();
            if (_claimVoted[claimId][committeeEpoch]) revert ClaimAlreadyVoted();
        }
        _closeClaimCase(claimId, c, 0);
        emit ClaimDisputeCancelled(claimId, reason);
    }

    /* ── 委员会治理 ─────────────────────────────────────────────────── */

    function setArbiters(address[] calldata members, uint16 threshold) external onlyGovernor {
        _validateCommittee(members, threshold);
        _writeCommittee(members, threshold);
    }

    /**
     * @notice 吊销某地址的当前裁决资格。
     * @dev **不要求它是当前名单成员**：被换下的失陷密钥仍可被拉黑，旧票也不再计入。
     *      墓碑在当前届内全局生效；若吊销会让**活跃委员**跌破阈值，本函数直接 revert
     *      （不再留墓碑位）——否则计票永远凑不齐，结算/罚没/售后/提货赔付会永久卡死。
     *      要换掉失陷成员请用 `setArbiters` 显式重新任命（它同时清回墓碑）；
     *      这不是永久封禁，需要永久排除就使用新地址。
     */
    function revokeArbiter(address member) external onlyGovernor {
        if (member == address(0)) revert InvalidArbiter();
        if (revokedArbiter[member]) return;
        Committee storage c = _committees[committeeEpoch];
        uint256 n = c.members.length;
        for (uint256 i = 0; i < n; ++i) {
            if (c.members[i] == member) {
                // 保留至少 3 人；移除成员只在 threshold < n-1 且 n>3 时安全，3/2 用墓碑保形。
                if (n > 3 && c.threshold < n - 1) {
                    c.members[i] = c.members[n - 1];
                    c.members.pop();
                }
                break;
            }
        }
        /*
          墓碑/移除都不能把**活跃人数**降到阈值以下：`_countVotes` 跳过墓碑，一旦 active < threshold
          就永远凑不齐票——结算/罚没/售后/提货赔付全部永久卡死，而委员名单还能靠 `setArbiters`
          换人。`NodeGovernance` 的提案路径本来就有同样的检查（`_checkRevokeKeepsQuorum`）；
          这里补在唯一写入口上，接线前的 owner 直调与自定义 governor 也走同一条判据。
        */
        uint256 activeAfter = 0;
        for (uint256 i = 0; i < c.members.length; ++i) {
            address m = c.members[i];
            if (m != member && !revokedArbiter[m]) ++activeAfter;
        }
        if (activeAfter < c.threshold) revert ThresholdOutOfBounds();
        revokedArbiter[member] = true;
        emit ArbiterRevoked(member);
    }

    /* ── 接线与参数 ─────────────────────────────────────────────────── */

    /// @notice 节点自己暂停/恢复接新单（不依赖任何 Registry；在途单照常结算）
    function setAcceptingOrders(bool accepting) external onlyOwner {
        acceptingOrders = accepting;
        emit AcceptingOrdersSet(accepting);
    }

    /// @notice 节点主配置支持的 ERC20 支付资产（原生 BTY 恒支持，不在此表）
    function setSupportedToken(address token, bool supported) external onlyOwner {
        if (token == address(0) || token.code.length == 0) revert TokenNotSupported();
        // 没有 TokenPayoutVault 时，收款方拒收 token 的兜底不存在：宁可不让开启 ERC20 支付。
        // 也要求 vault 已回指本 Escrow；否则 `credit` 会因 OnlyEscrow 回滚，订单无法终局。
        if (supported) {
            if (tokenVault == address(0)) revert InvalidTokenVault();
            (bool ok, bytes memory ret) = tokenVault.staticcall(abi.encodeWithSignature("escrow()"));
            if (!ok || ret.length < 32 || abi.decode(ret, (address)) != address(this)) {
                revert InvalidTokenVault();
            }
        }
        supportedToken[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    function setStaking(address staking_) external onlyOwner {
        if (staking != address(0)) revert AlreadyConfigured();
        if (staking_.code.length == 0) revert StakingNotConfigured();
        if (IStakingPenalize(staking_).escrow() != address(this)) revert StakingNotConfigured();
        _probeBytes32Arg(staking_, IStakingPenalize.penalizedOrders.selector);
        _probeBytes32Arg(staking_, IStakingPenalize.penalizedClaims.selector);
        // openClaimDispute 的唯一外部读：缺它则提货争议开案永久 revert，而接线是一次性的。
        _probeBytes32Arg(staking_, IStakingPenalize.claimCapacityRemaining.selector);
        (bool ok, bytes memory ret) =
            staking_.staticcall(abi.encodeWithSelector(IStakingPenalize.owner.selector));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != owner()) revert RoleConflict();
        staking = staking_;
        emit StakingSet(staking_);
    }

    function setGovernor(address governor_) external onlyOwner {
        if (governor != address(0)) revert AlreadyConfigured();
        if (governor_.code.length == 0) revert InvalidArbiter();
        if (staking == address(0)) revert StakingNotConfigured();
        /*
          **委员会必须先就位**：governor 一旦接线，owner 就失去直接 setArbiters 的权力；
          若此时 committeeEpoch == 0，NodeGovernance 的 requiredVotes 也是 0（永远凑不齐），
          新建订单又因 `committeeEpoch == 0` 被拒——整个节点只能重部署。
          这里用 NoArbiter 复用"委员会未配置"的语义，不新增错误码（Escrow 已接近 EIP-170）。
        */
        if (committeeEpoch == 0) revert NoArbiter();
        if (!_governorMatches(governor_)) revert GovernorMismatch();
        governor = governor_;
        emit GovernorSet(governor_);
    }

    /// @dev governor 必须明确指向本 Escrow 与已接线的 Staking，避免一次性接错后永久锁死治理。
    function _governorMatches(address candidate) private view returns (bool) {
        (bool ok, bytes memory ret) = candidate.staticcall(abi.encodeWithSignature("escrow()"));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != address(this)) return false;
        (ok, ret) = candidate.staticcall(abi.encodeWithSignature("staking()"));
        return ok && ret.length >= 32 && abi.decode(ret, (address)) == staking;
    }

    /**
     * @dev 委员会/窗口参数的唯一治理入口。
     *      接线前（governor == 0）owner 可完成初始任命；接线后只能由 governor 调，
     *      owner 不能绕过委员会直接改名单/参数。
     */
    modifier onlyGovernor() {
        address g = governor;
        if (g == address(0)) {
            if (msg.sender != owner()) revert NotArbiter();
        } else if (msg.sender != g) {
            revert NotArbiter();
        }
        _;
    }

    function setRejectGraceBlocks(uint64 newValue) external onlyGovernor {
        if (newValue < MIN_REJECT_GRACE_BLOCKS || newValue > MAX_REJECT_GRACE_BLOCKS) revert InvalidRejectGrace();
        rejectGraceBlocks = newValue;
        emit RejectGraceBlocksUpdated(newValue);
    }

    function setMinTimeoutBlocks(uint64 newValue) external onlyGovernor {
        if (newValue < MIN_ORDER_TIMEOUT_BLOCKS || newValue > MAX_TIMEOUT_BLOCKS) revert InvalidMinTimeout();
        minTimeoutBlocks = newValue;
        emit MinTimeoutBlocksUpdated(newValue);
    }

    function setAfterSaleWindowBlocks(uint64 newValue) external onlyGovernor {
        if (newValue < MIN_AFTER_SALE_WINDOW_BLOCKS || newValue > MAX_AFTER_SALE_WINDOW_BLOCKS) {
            revert InvalidAfterSaleWindow();
        }
        afterSaleWindowBlocks = newValue;
        emit AfterSaleWindowBlocksUpdated(newValue);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipLocked();
    }

    /* ── 读入口 ─────────────────────────────────────────────────────── */

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function claimCase(bytes32 claimId) external view returns (ClaimCase memory) {
        return _claimCases[claimId];
    }

    function claimTallyOf(bytes32 claimId, uint256 amountWei) external view returns (uint16 n) {
        (n,) = _countVotes(claimId, VOTE_CLAIM, amountWei);
    }

    function arbiters() external view returns (address[] memory) {
        return _committees[committeeEpoch].members;
    }

    function arbiterThreshold() external view returns (uint16) {
        return _committees[committeeEpoch].threshold;
    }

    function isArbiter(address who) public view returns (bool) {
        return _inCommittee[committeeEpoch][who] && !revokedArbiter[who];
    }

    function tokenVaultAddress() external view returns (address) {
        return tokenVault;
    }

    /// @notice 当前委员会届次（仅供 Staking 的罚没窗口做诊断留痕；**不再有按单届次快照**）
    function orderEpoch(bytes32) external view returns (uint32) {
        return committeeEpoch;
    }

    function rejectGraceBlocksOf(bytes32 orderId) external view returns (uint64) {
        Order storage o = _orders[orderId];
        if (o.status == OrderStatus.None) return 0;
        return _rejectGraceBlocks(orderId);
    }

    function afterSaleWindowBlocksOf(bytes32 orderId) external view returns (uint64) {
        return afterSaleWindowAtSettle[orderId];
    }

    function releaseNotBeforeBlock(bytes32 orderId) external view returns (uint64) {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Created) return 0;
        uint64 at = o.createdAtBlock + o.timeoutBlocks;
        if (o.refundRejected) {
            uint64 graceAt = refundRejectedAtBlock[orderId] + _rejectGraceBlocks(orderId);
            if (graceAt > at) at = graceAt;
        }
        return at;
    }

    function afterSaleOpen(bytes32 orderId) external view returns (bool) {
        return afterSaleOpenedAtBlock[orderId] != 0;
    }

    /// @notice 治理身份 = 本节点 owner 或**当前届**仲裁人（节点鉴权唯一读法）
    function isProtocolGovernance(address who) public view returns (bool) {
        return who == owner() || isArbiter(who);
    }

    /* ── 内部：结算 ─────────────────────────────────────────────────── */

    /**
     * @dev 订单级买家受偿的**唯一记账内核**（只对以订单币种赔付的路径调用：结算退款、
     * 留存期退款、原生单的罚没/售后、提货赔付 `ClaimPaid`；代币单的 BTY 赔付不进这一列）。
     * 所有这类路径都必须先过这里，才能保证 `refundedAmount <= amount`，后续
     * `amount - refundedAmount` 不会下溢。旧实现由各路径自己 `+=`，于是
     * `votePenalty` 加了 refundedAmount 却不减 sellerPending，卖家再退整个 pending
     * 就会把累计值推过订单额。
     */
    function _accountBuyerCredit(Order storage o, uint256 amount) private {
        uint256 remaining = o.amount > o.refundedAmount ? o.amount - o.refundedAmount : 0;
        if (amount > remaining) revert RefundAmountOutOfRange();
        o.refundedAmount += amount;
    }

    /// @dev 未被未结案提货争议占用的买家受偿额度（退款/售后不得吃掉 claim 的预留）。
    function _freeBuyerCredit(bytes32 orderId, Order storage o) private view returns (uint256) {
        uint256 remaining = o.amount > o.refundedAmount ? o.amount - o.refundedAmount : 0;
        uint256 reserved = orderClaimExposure[orderId];
        return remaining > reserved ? remaining - reserved : 0;
    }

    /// @dev 从售后留存里退给买家：先减留存，再占订单级额度，再付款（顺序不影响回滚，但注释要与代码一致）。
    function _creditBuyerFromPending(bytes32 orderId, Order storage o, uint256 amount) private {
        if (amount > sellerPending[orderId]) revert PendingAmountTooLarge();
        sellerPending[orderId] -= amount;
        _accountBuyerCredit(o, amount);
        _payoutOrCredit(orderId, o.buyer, amount);
    }

    function _settle(bytes32 orderId, Order storage o, uint256 refundWei) internal {
        uint256 sellerNet = o.amount - refundWei;
        _writeSettle(orderId, o, refundWei, sellerNet);
        if (refundWei > 0) _payoutOrCredit(orderId, o.buyer, refundWei);
        if (sellerNet == 0) return;
        uint64 hold = _holdbackBlocks(orderId, o);
        if (hold == 0) {
            _payoutOrCredit(orderId, o.seller, sellerNet);
            return;
        }
        sellerPending[orderId] = sellerNet;
        uint64 unlock = uint64(block.number) + hold;
        sellerPendingUnlockBlock[orderId] = unlock;
        emit SellerPendingAccrued(orderId, o.seller, sellerNet, unlock);
    }

    /// @dev 只有买家确认收货（或卖家按买家授权部分退款）才进入留存期；留存最多 7 天，且不超过本单窗口。
    function _holdbackBlocks(bytes32 orderId, Order storage o) private view returns (uint64) {
        if (!o.buyerConfirmed) return 0;
        uint64 window = afterSaleWindowAtCreate[orderId];
        return window < SELLER_HOLDBACK_BLOCKS ? window : SELLER_HOLDBACK_BLOCKS;
    }

    function _writeSettle(bytes32 orderId, Order storage o, uint256 refundWei, uint256 sellerNet) internal {
        uint256 amount = o.amount;
        o.refundedAmount = refundWei;
        o.status = refundWei == amount ? OrderStatus.Refunded : OrderStatus.Settled;
        if (acceptedPartialRefund[orderId] != 0) {
            delete acceptedPartialRefund[orderId];
            emit PartialRefundAccepted(orderId, 0);
        }
        _closeCase(orderId, o);
        if (amount - refundWei > 0) {
            settledAtBlock[orderId] = uint64(block.number);
            sellerNetAtSettle[orderId] = sellerNet;
            afterSaleWindowAtSettle[orderId] = afterSaleWindowAtCreate[orderId];
        }
    }

    function _openCase(bytes32 orderId, Order storage o) internal {
        if (caseOpen[orderId]) return;
        caseOpen[orderId] = true;
        if (orderToken[orderId] != address(0)) return;
        sellerOpenExposure[o.seller] += o.amount;
        totalOpenExposure += o.amount;
    }

    function _closeCase(bytes32 orderId, Order storage o) internal {
        if (!caseOpen[orderId]) return;
        caseOpen[orderId] = false;
        if (orderToken[orderId] != address(0)) return;
        uint256 amount = o.amount;
        uint256 e = sellerOpenExposure[o.seller];
        if (e < amount) revert ExposureAccountingBroken();
        sellerOpenExposure[o.seller] = e - amount;
        uint256 t = totalOpenExposure;
        if (t < amount) revert ExposureAccountingBroken();
        totalOpenExposure = t - amount;
    }

    function _closeAfterSaleCase(bytes32 orderId) private {
        delete afterSaleOpenedAtBlock[orderId];
        afterSaleClosedAtBlock[orderId] = uint64(block.number);
    }

    function _closeClaimCase(bytes32 claimId, ClaimCase storage c, uint256 amountWei) private {
        c.closed = true;
        delete _claimOpenForOrderToken[c.orderId][c.tokenRef];
        uint256 orderExposure = orderClaimExposure[c.orderId];
        if (orderExposure < c.amount) revert ExposureAccountingBroken();
        orderClaimExposure[c.orderId] = orderExposure - c.amount;
        uint256 amount = c.amount;
        uint256 e = sellerClaimExposure[c.seller];
        if (e < amount) revert ExposureAccountingBroken();
        sellerClaimExposure[c.seller] = e - amount;
        emit ClaimClosed(claimId, amountWei, c.claimant);
    }

    function _rejectGraceBlocks(bytes32 orderId) internal view returns (uint64) {
        return rejectGraceAtCreate[orderId];
    }

    /* ── 内部：委员会 ───────────────────────────────────────────────── */

    function _validateCommittee(address[] calldata members, uint16 threshold) private view {
        uint256 n = members.length;
        // 2-of-2 / n-of-n 的委员会一旦丢一把钥就永远凑不齐票，且没有可用的换人出口。
        // 从形状上禁止它，比部署后靠治理救火可靠。
        if (n < 3) revert NoArbiter();
        if (n > MAX_ARBITERS) revert CommitteeTooLarge();
        /*
          阈值下界固定为 2：`threshold == 1` 会让**任意一个**委员单独完成结算/罚没，
          把"多仲裁人 + 阈值"降级成单点（且与 NodeGovernance 的 2/3 门槛矛盾）。
          n-of-n 同样禁止：丢一把钥就永远凑不齐票，没有换人出口。
        */
        if (threshold < 2 || threshold >= n) revert ThresholdOutOfBounds();
        for (uint256 i = 0; i < n; ++i) {
            _validateMember(members[i]);
            for (uint256 j = 0; j < i; ++j) {
                if (members[j] == members[i]) revert DuplicateArbiter();
            }
        }
    }

    function _validateMember(address member) private view {
        if (member == address(0) || member == address(this)) revert InvalidArbiter();
        /*
          节点主（Escrow owner）可以兼任仲裁人；委员会形状（至少 3 人、阈值 ≥2 且 < 人数）由
          `_validateCommittee` **无条件**强制，与 owner 是否在名单里无关。本合约不读任何
          Registry：其他节点主/目录 owner 的互斥属于节点自己的选人/披露规则。
        */
    }

    function _writeCommittee(address[] memory members, uint16 threshold) private {
        // 委员会形状（成员数、阈值下界、owner 兼任）已在 `_validateCommittee` 里统一校验；
        // 这里不再重复一遍——重复的判据迟早会与唯一判据漂移。
        uint32 epoch = committeeEpoch + 1;
        Committee storage c = _committees[epoch];
        for (uint256 i = 0; i < members.length; ++i) {
            c.members.push(members[i]);
            _inCommittee[epoch][members[i]] = true;
            revokedArbiter[members[i]] = false;
        }
        c.threshold = threshold;
        committeeEpoch = epoch;
        emit CommitteeUpdated(epoch, members, threshold);
    }

    function _castVote(bytes32 orderId, uint8 kind, uint256 value)
        private
        returns (uint16 votes, uint16 threshold)
    {
        /*
          **只认当前委员会名单**：不再把开案时的届次快照进订单。换届/吊销后，旧届成员
          立即失去投票资格；当前委员即使没参与过开案，也能裁决旧单。这消除了"旧届全部
          失联/被吊销 ⇒ 争议永久冻结"的死锁，代价如实写在 `_countVotes` 的注释里：
          一次换届会改变在途订单的裁决人集合，平台必须把委员会变更当作资金级动作。
        */
        if (revokedArbiter[msg.sender]) revert NotArbiter();
        if (committeeEpoch == 0) revert NoArbiter();
        if (!_inCommittee[committeeEpoch][msg.sender]) revert OnlyArbiter();
        _voteValue[orderId][kind][committeeEpoch][msg.sender] = value;
        _voted[orderId][kind][committeeEpoch][msg.sender] = true;
        return _countVotes(orderId, kind, value);
    }

    function _countVotes(bytes32 orderId, uint8 kind, uint256 value)
        private
        view
        returns (uint16 votes, uint16 threshold)
    {
        Committee storage c = _committees[committeeEpoch];
        threshold = c.threshold;
        address[] storage ms = c.members;
        for (uint256 i = 0; i < ms.length; ++i) {
            address m = ms[i];
            if (revokedArbiter[m]) continue;
            if (_voted[orderId][kind][committeeEpoch][m] && _voteValue[orderId][kind][committeeEpoch][m] == value) ++votes;
        }
    }

    function _rejectSelfVote(Order storage o) private view {
        if (msg.sender == o.buyer || msg.sender == o.seller) revert InvalidArbiter();
    }

    /* ── 内部：接线探针 ─────────────────────────────────────────────── */

    function _probeBytes32Arg(address target, bytes4 selector) private view {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSelector(selector, bytes32(0)));
        if (!ok || ret.length < 32) revert StakingNotConfigured();
    }

    /* ── 内部：转账 ─────────────────────────────────────────────────── */

    function _payoutOrCredit(bytes32 orderId, address to, uint256 value) internal {
        address token = orderToken[orderId];
        if (token == address(0)) {
            _payoutNativeOrCredit(to, value);
            return;
        }
        /*
          直接付款也必须用 `_tryTokenTransfer`，不能写成
          `try IERC20(token).transfer(...) returns (bool)`：Solidity 的 try/catch **不捕获返回
          数据解码失败**（issue #11886）。对"成功但不返回任何数据"的非标准 ERC20（白名单允许
          这类代币），那种写法会在解码 `bool` 时直接 revert，整笔结算/退款/释放永久失败，
          钱锁在 Escrow 里。`_tryTokenTransfer` 对空返回按成功、对 false/回滚按失败。
          标准 ERC20 的 false 是"未转账"，转给 vault 再记账是既有兜底；
          非标准 token"返回 false 但已经改了余额"的重复转账风险由节点白名单承担。
        */
        if (_tryTokenTransfer(token, to, value)) return;
        // 非零地址必须有代码：否则 EOA 会收下 token，随后对 EOA 的 credit 空调用也会"成功"，账目丢失。
        if (tokenVault.code.length != 0 && _tryTokenTransfer(token, tokenVault, value)) {
            TokenPayoutVault(tokenVault).credit(token, to, value);
            return;
        }
        revert TokenTransferFailed();
    }

    /**
     * @dev 兼容不返回 bool 的非标准 ERC20；返回值缺失按成功，返回 false/回滚按失败。
     *      **直接付款与 vault 兜底都走它**：`try ... returns (bool)` 无法捕获"成功但无返回数据"
     *      的解码失败（solidity issue #11886），那会让这类代币的订单永久锁死。
     */
    function _tryTokenTransfer(address token, address to, uint256 value) private returns (bool ok) {
        assembly {
            let ptr := mload(0x40)
            // transfer(address,uint256) = 0xa9059cbb
            mstore(ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 4), to)
            mstore(add(ptr, 36), value)
            ok := call(gas(), token, 0, ptr, 68, 0, 0)
            // 空返回 = 兼容非标准 token 的成功；有返回则必须解码第一个字为 true。
            // 旧实现把返回值写到内存 0，却从 ptr 读输入 calldata，永远得到非零，
            // 于是 token 返回 false 也会被当成成功；fallback 的 credit 余额检查虽能救回
            // 大多数情况，但“先转给收款人、失败后又转给 vault”的语义必须一条不混。
            if and(ok, gt(returndatasize(), 0)) {
                if lt(returndatasize(), 32) { ok := 0 }
                if ok {
                    returndatacopy(0, 0, 32)
                    ok := mload(0)
                }
            }
        }
    }

    function _payoutNativeOrCredit(address to, uint256 value) private {
        if (gasleft() > PAYOUT_GAS_CAP + ACCRUAL_GAS_HEADROOM) {
            (bool ok,) = payable(to).call{value: value, gas: PAYOUT_GAS_CAP}("");
            if (ok) return;
        }
        accruedPayouts[to] += value;
        emit PayoutAccrued(to, value);
    }

    function _sendNative(address to, uint256 value) private {
        (bool ok,) = payable(to).call{value: value}("");
        if (!ok) revert NativeTransferFailed();
    }

    function _transferOwnership(address newOwner) internal override {
        if (newOwner != address(0)) {
            if (revokedArbiter[newOwner]) revert RoleConflict();
            /*
              转给本合约或 Staking 会把 `onlyOwner` 入口（setSupportedToken / setAcceptingOrders /
              openClaimDispute，以及接线前的 setArbiters）永久砖死：没有任何外部账户能再以那个
              地址发交易。委员会形状不需要在这里再判——`_validateCommittee` 对**任何**一届都无条件
              要求 n≥3、threshold≥2，所以"owner 兼任仲裁人导致 1-of-1"不可表达。
              `staking == 0` 时与 `newOwner == 0` 的比较已被外层排除，故不必再判非零。
            */
            if (newOwner == address(this) || newOwner == staking) revert RoleConflict();
        }
        super._transferOwnership(newOwner);
    }
}
