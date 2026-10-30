// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Staking —— 每个节点一个卖家保证金合约
 * @notice 卖家质押；委员会票决达到阈值后，由本节点的 Escrow 调：
 *   · penalize：把卖家保证金赔给订单买家（售后/罚没）；
 *   · penalizeClaim：把卖家保证金赔给提货争议的提货人（NFT 可能已转手，提货人不是原买家）。
 *
 * 资金池按地址计；出金只有一条路：申请 → 冷却 → owner 批准（或自动放行窗口到期自领）；
 * owner 没有直接提款入口，罚没只能由本节点 Escrow 触发。
 * 出金下限 = 在途退款敞口 + 在途提货争议敞口，与治理留存线取较大者。
 *
 * 事实源是本节点 Escrow（不可更换；构造期形状探针 + 代码哈希互验）；本合约不存委员会副本。
 * 无平台费：本合约不向平台/节点支付任何费用，只把卖家保证金赔给买家/提货人。
 *
 * 代码哈希：escrow 地址与配置都放 storage（无 immutable），使所有节点实例的运行时字节码一致，
 * 平台 Registry 的实现白名单才能认证它。换 Escrow 必须重部署 Staking 并显式迁移质押。
 */
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IEscrowMinimal {
    /**
     * @dev 字段顺序/类型必须与 `Escrow.Order` **逐字对应**（ABI 元组按位置解码）。
     * 2026-09 加入 `refundedAmount`（部分退款/拆分裁决）时，本接口漏改会让 `status` 读到
     * 错位的字（实测表现为所有 penalize 测试报 OrderNotSettled）——改了 Escrow 结构务必同步此处。
     * 末尾 `buyerConfirmed` 是罚没资格门槛；任何字段顺序变化都必须同批更新这里。
     */
    struct Order {
        address buyer;
        address seller;
        uint256 amount;
        uint64 timeoutBlocks;
        uint64 createdAtBlock;
        bool refundRequested;
        bool refundRejected;
        uint256 refundedAmount; // 已退买家的金额（罚没上限据此收敛：只对「卖家实际留下」的部分追责）
        uint8 status; // 0=None 1=Created 2=Disputed 3=Settled 4=Refunded
        bool buyerConfirmed; // 买家认可过本单的资金处置（罚没资格门槛，见 penalize）
    }

    /// @dev 与 `Escrow.ClaimCase` 逐字对应（提货争议；提货人不是原买家）
    struct ClaimCase {
        bytes32 orderId;
        bytes32 tokenRef;
        address seller;
        address claimant;
        uint256 amount;
        uint64 deadline;
        uint64 openedAt;
        bool closed;
    }

    function getOrder(bytes32 orderId) external view returns (Order memory);

    function claimCase(bytes32 claimId) external view returns (ClaimCase memory);

    /// @notice 该卖家的在途提货争议敞口（开案锁定、结案释放；出金下限读它）
    function sellerClaimExposure(address seller) external view returns (uint256);

    /**
     * @notice 该单**落定在哪一届委员会**（0 = 还没有任何裁决动作）。
     *
     * `penalize` 用它给罚没窗口的归属（`PenaltyWindow.epochAtOpen`）定值：窗口属于**该单的裁决
     * 届次**，不是"开窗那一刻的当前届"。它只是留痕/诊断读数；出金锁只认
     * `revokedArbiter[开窗人]` 与全局开关，不再看"投票人是否仍当前届"。
     */
    function orderEpoch(bytes32 orderId) external view returns (uint32);

    /**
     * @notice 该卖家当前的**在途售后敞口**（wei）= Σ 在途单（退款申请待决 + 争议中 + 被拒后尚未终局）的 `amount`。
     *
     * 这是本合约**出金下限**的唯一读数之一（2026-10-13 复审由"笔数"改为"金额"）：
     * 任何一笔打款之后 `poolOf(卖家)` 都不得低于该敞口（与治理留存线取较大者，见 `payoutFloors`）。
     * 敞口由 Escrow 幂等维护（只有终局 `_settle` 会放掉；拒绝退款**不**放掉，之后发起争议也不会重复累加）。
     *
     * **为什么必须是金额**：按笔数记账时判据只能是 `> 0`；攻击者用一笔 1 wei 的订单并申请退款
     * ⇒ 用极小成本把该店的整个质押池钉住。
     */
    function sellerOpenExposure(address seller) external view returns (uint256);

    /**
     * @notice 该单**结算给卖家时的实收净额**（wei；0 = 该单没有判给卖家）。
     *
     * 它是 `penalize` 单笔上限的**基准**：罚没不得超过卖家**实际拿到**的钱。
     * 见 `Escrow.sellerNetAtSettle` 的完整理由（为什么不能用托管毛额：`penaltyCapBps == 10000`
     * 时"自建订单洗池"恰好打平，`cap < 10000` 时严格亏损）。
     */
    function sellerNetAtSettle(bytes32 orderId) external view returns (uint256);

    /**
     * @notice 该单**是否有"确认收货之后"开启的**售后案件。
     *
     * 它放宽的是罚没资格门槛：`buyerConfirmed` 原本一票否决（买家自己点过确认收货的单不得追罚，
     * 那是源码审计 2026-09 的 P1 修复）；但"收货后才发现是假货"必须有一条救济路径，
     * 所以买家开案之后，`buyerConfirmed` 不再阻止罚没。
     * 注意：售后案件**不**计入 `sellerOpenExposure`（它不阻塞卖家出金）。
     *
     * **它只是门槛的一半（2026-10-14 修正）**：案件一旦开启就**永不自动过期**
     * （`closeAfterSale` 只有买家能调，委员会一侧走 `voteAfterSale` 票决），所以单看这个活标志等于"窗口没有上限"——
     * 另一半是同单的窗口读法（见 `settledAtBlock` / `afterSaleWindowAtSettle`），
     * 两半合起来才表达"该单仍在**可追罚期**内"。
     */
    function afterSaleOpen(bytes32 orderId) external view returns (bool);

    /**
     * @notice 该单**结算给卖家**时的区块高度（0 = 从未判给卖家）。
     *
     * 与 `afterSaleWindowAtSettle` 一起构成售后窗口的**唯一判据**（Escrow 在 `_settle` 里
     * 同一处、同一条件写入）。Staking 用它把"可追罚期"钉在**罚没那一刻**：
     * 案件活标志永不失效，而窗口会到期（见 `_afterSaleInWindow`）。
     */
    function settledAtBlock(bytes32 orderId) external view returns (uint64);

    /**
     * @notice 该单**结算给卖家时**的售后窗口长度快照（块数；0 = 从未判给卖家）。
     *
     * 必须取**快照**而不是实时的 `afterSaleWindowBlocks`：owner 事后调小不得追夺已结算单
     * 买家手里的剩余期限、调大不得让历史订单重新变成可追罚对象（Escrow 侧的完整理由见
     * `Escrow.afterSaleWindowBlocks`）。契约形状必须与 `Escrow.sol` 的真实声明**逐字对齐**
     * （`mapping(bytes32 => uint64) public` ⇒ `(bytes32) returns (uint64)`）——改了这里
     * 就必须同批改 `_probeEscrow` 的探针清单。
     */
    function afterSaleWindowAtSettle(bytes32 orderId) external view returns (uint64);
}

/**
 * @dev Escrow 的**角色只读面**（只服务 owner 转移闸：owner 也是角色）。
 *      事实源只有 本节点 Escrow 一处，本合约不复制任何状态。
 */
interface IEscrowOwnerRoles {
    function revokedArbiter(address who) external view returns (bool);
}

contract Staking is Ownable2Step, ReentrancyGuard {
    /**
     * @notice 本节点的托管合约（**唯一事实源**：订单终局/参与方/委员会与届次都由它读）。
     *
     * **不可更换**：没有 setter，任何换源入口都不存在；换 Escrow 必须重部署 Staking 并做一次
     * 显式迁移。这里用 storage 而不是 immutable，是为了让**同一份源码在所有节点实例上产出
     * 相同的实现哈希**（运行时字节码去掉 metadata）——平台 Registry 的白名单才能认证它。
     * immutable 会把每个实例的 escrow 地址嵌进字节码，使每个节点的哈希都不同。
     *
     * 构造期仍做形状探针 + 代码哈希互验（`escrowCodeHash_` 只用于构造期校验，不落 storage）。
     */
    IEscrowMinimal public escrow;

    /// @notice 委员会治理合约（一次性接线；设置后罚没/冷却/留存参数只能由它改；owner 仍可冻结/解冻）
    address public governor;

    /**
     * @notice `IEscrowMinimal.Order` 的字数（10 个字段，每个 1 字）。
     *
     * 用途只有一个：`_probeEscrow` 用它挡住"事实源配成了订单形状不同的合约"——
     * 形状漂移会让 `penalize` **静默解码出垃圾**。改了 `Escrow.Order` 的字段数就必须同批改这里。
     */
    uint256 internal constant ESCROW_ORDER_WORDS = 10;

    struct Position {
        uint256 staked; // 在池质押（可被罚没）
        uint256 pending; // 已申请撤资（冷却期内仍属担保池；到期且未冻结可提取）
        uint64 releaseAt; // pending 可提取时刻
        /*
          **这里原本还有一个 `bool frozen`**（治理冻结的独立存储位）。2026-10-13 删掉：
          它与 `frozenUntil` 是同一件事的两个真相，而 `freeze`（无限期，写这个位）
          与 `freezeUntil`（≤180 天）并存 ⇒ **上限可以被绕过**（改用前者即可无限期冻结），
          也让"冻到什么时候"要看两个字段。现在冻结只有一处状态：`frozenUntil[operator]`，
          对外仍以 `positions(...)` 的第四个返回值暴露（**派生读数**，见该函数），
          于是 ABI 形状不变、镜像不用改，而"两个真相"变得不可表达。
        */
    }

    /// @notice operator => 质押头寸（**只读入口见 `positions`**；存储改用下划线前缀，
    ///         因为它不再是对外 ABI 的一部分——对外读法只有 `positions` 一处）
    mapping(address => Position) internal _positions;

    /**
     * @notice operator 的质押头寸（外部只读；**唯一对外读法**）。
     *
     * 第四个返回值 `frozen` 是 `frozenUntil` 的**派生读数**（`frozenUntil > now`），不是独立状态：
     * 冻结只有一个真相，读法保持与升级前逐字段相同（同一顺序、同一含义），
     * 所以前端 `positions(operator)` 的镜像**不需要改**。
     */
    function positions(address operator)
        external
        view
        returns (uint256 staked, uint256 pending, uint64 releaseAt, bool frozen)
    {
        Position storage p = _positions[operator];
        return (p.staked, p.pending, p.releaseAt, frozenUntil[operator] > block.timestamp);
    }

    /**
     * @notice operator 在池担保额 = staked + pending（冷却期资金仍属可罚没担保池）。
     * 前端保证金标注、罚没窗口额度与出金下限都以本值为准。
     * `public`（而非 external）是为了让同合约内的窗口额度计算复用它——**口径只有一处**。
     */
    function poolOf(address operator) public view returns (uint256) {
        return _positions[operator].staked + _positions[operator].pending;
    }

    /// @notice 已执行罚没的订单（幂等）
    mapping(bytes32 => bool) public penalizedOrders;

    /// @notice 已执行赔付的提货争议（幂等）
    mapping(bytes32 => bool) public penalizedClaims;

    /// @notice 同一订单的提货赔付累计（多枚 NFT 的提货争议共享订单净额上限）
    mapping(bytes32 => uint256) public claimPenalizedByOrder;

    /// @notice 同一订单的**全部罚没累计**（订单罚没 + 提货赔付），跨两种路径共享一个上限
    mapping(bytes32 => uint256) public penalizedByOrderTotal;

    /**
     * @notice **逐运营方的滚动窗口罚没账**（源码审计 2026-09 续）。
     *
     * 为什么需要它（残留风险）：原先只有两道闸——「每单一次」与「单笔 ≤ 未退部分 × penaltyCapBps」。
     * 两者都**只约束单笔**，跨单没有任何累计约束：一笔 10 BTY 的单最多罚 5，一百笔就是 500，
     * 直到把质押池掏空为止。仲裁人是单点信任，文档自己承认可能失能/被盗——
     * 一把被盗的仲裁人密钥可以把任何一个卖家的质押**在一次窗口内清空**，卖家没有任何反制手段
     * （`freeze` 只挡提取、不挡罚没）。质押是"托管判付之后的第二层资金"，
     * 它的作用域应当用**速率**限住，而不是寄望于仲裁人永远善意。
     *
     * 语义：`windowSeconds` 内，同一 operator 的累计罚没 ≤ **开窗时**质押池 × `windowCapBps/10000`。
     * 窗口在"窗口过期后的第一次罚没"时重新开启。
     *   · `cap` 在开窗时**快照**（不随后续质押变化）：否则卖家临时加质押就能抬高可罚额度，
     *     而这笔钱本来只是路过；反过来也避免了"罚没导致池变小 ⇒ 上限跟着变小"的连锁锁死。
     *   · `end`（窗口到期时刻）同样在开窗时**快照**（2026-09 复审修改，见 `setPenaltyWindow`）：
     *     治理参数只影响**之后开启的窗口**，不改写进行中窗口的长度、额度与出金锁。
     *     旧实现按当下的 `penaltyWindowSeconds` 实时算到期，于是 owner 一条交易就能让所有在途窗口
     *     立刻过期（速率闸对在途窗口等于失效）并同时解开所有人的出金闸——误配的杀伤半径是全站，
     *     而"救援"本来就有专门的实时开关 `penaltyWindowLocksWithdraw`（见 `withdrawLock`）。
     *   · `windowSeconds == 0` 或 `windowCapBps == 0` 视为**不再开新窗**（治理自担风险）：
     *     进行中的窗口按自己的快照执行完，不会被追溯作废。
     *
     * 未采用的做法：把"在途订单"作为禁止撤资的条件。那会让一个买家凭一笔假订单
     * 冻结卖家的全部质押（DoS 成本极低、受害面极大），比它解决的问题更糟。
     */
    struct PenaltyWindow {
        uint64 start; // 本窗口起点（unix 秒；0 = 尚未开窗）
        uint64 end; // 本窗口到期时刻（unix 秒；**开窗时按当时的 windowSeconds 快照**，0 = 尚未开窗）
        uint256 cap; // 本窗口累计上限（开窗时按当时的质押池快照）
        uint256 penalized; // 本窗口内已累计罚没
        /**
         * @notice **开窗那一单的裁决届次**（`Escrow.orderEpoch(orderId)`，不是开窗时的当前届）。
         *
         * 它是**诊断/审计**读数：出金锁只看 `revokedArbiter[penaltyWindowOpener]`（见
         * `withdrawLock`），换届与届次比较都不再参与资金闸。它也不参与速率闸的额度判据：
         * 累计按 operator 单调，只有窗口到期才重置；被吊销成员的票不再计入（`revokedArbiter`），
         * 旧届成员若仍未被吊销，其对在途单的投票权保留，但已经用掉的额度不会回来。
         */
        uint32 epochAtOpen;
    }

    /// @notice operator => 当前窗口
    mapping(address => PenaltyWindow) public penaltyWindows;

    /**
     * @notice operator => 本活动窗口的**开窗人**（第一笔让窗口开启的罚没投票人；不因同窗口
     *         后续罚没改写）。
     *
     * 它是出金锁的**唯一放人信号**：`withdrawLock` 只问 `revokedArbiter[penaltyWindowOpener]`。
     * 为什么是"开窗人"而不是"最近一次投票人"：放人是一次**显式治理动作**（吊销），
     * 被吊销的必须是那个让这扇窗开启的人；若让后续投票人覆盖，吊销对象就会漂移，
     * "吊销谁才放人"又变成需要推断的第二套语义（2026-10-21 复审）。
     * 换届/是否当前届成员都**不再**参与锁的判定（见 `withdrawLock`）。
     */
    mapping(address => address) public penaltyWindowOpener;

    /**
     * @notice 罚没窗口长度上限：**6 个月**（策略上限，不是溢出护栏）。
     *
     * 为什么要有上限：窗口一开，`penaltyWindowLocksWithdraw` 会把该店主的出金闸关到窗口结束
     * （见 withdrawLock），所以 `windowSeconds` 同时是"店主已到期的钱最多再多等多久"。
     * 治理把它设成一个荒谬的大数（旧上限是 **3650 天 = 10 年**）在效果上等于把资金锁死，
     * 而"只是设了个大数"在治理动作里非常容易被忽略——这正是需要硬上限的场景。
     *
     * 为什么是 6 个月：默认 30 天要能按更严的策略放大，而放大到什么程度仍有意义？
     * 罚没窗口是**速率闸**（同一店主每窗口累计罚没 ≤ 开窗时质押池 × capBps），
     * 半年是"商业上还能称之为一个考核期"的上限（与常见的质保金/尾款留存周期同量级）；
     * 再长就不能叫速率闸，而是"没收资格"。误配一次的代价因此被限制在半年，而不是十年。
     * 代价如实写明：治理**不能**再配出比半年更长的窗口（真需要更长考核期，得改合约重部署）；
     * 被窗口锁住的店主仍有两条实时出口——等到窗口自然到期，或治理 `setPenaltyWindowLock(false)`。
     */
    uint256 public constant MAX_PENALTY_WINDOW_SECONDS = 180 days;

    /**
     * @notice 罚没窗口长度的**硬下界**：1 天（0 仍是"关闭新窗口"的显式开关）。
     *
     * 为什么不能只挡 0：窗口是**速率闸**与**出金闸**的共同时间尺度，1 秒的窗口在效果上
     * 等于没有闸——罚没与出金可以在相邻两块里循环发生，而 `penaltyWindowState` 仍报
     * "limited=true"，没有任何读数告诉运营方这条保护已经形同虚设。这与
     * `MIN_UNLOCK_DELAY`（冷却不能短到等于不存在）是同一条纪律：参数的两侧都要有界，
     * 而不是只挡"太长了会锁死"那一侧。
     *
     * 0 保留为**显式关闭**（`setPenaltyWindow(0, …)`，事件里看得见）；要恢复就必须重新设一个
     * ≥1 天的值。代价如实写明：演示/测试不能再开"秒级窗口"，需要按天推进（`vm.warp`）。
     */
    uint256 public constant MIN_PENALTY_WINDOW_SECONDS = 1 days;

    /**
     * @notice 撤资冷却期上限：**90 天**（策略上限，同上）。
     *
     * 冷却是为了"罚没还能打到这笔钱"：`requestUnstake` 之后资金仍在担保池里，
     * `releaseAt` 之前可被罚没。需要多久取决于最长争议路径——订单超时
     * （Escrow 的 `timeoutBlocks`，约 2 周量级）加上仲裁人处理时间，90 天留了大余量。
     * 旧上限 3650 天同样属于"等于锁死"的量级，故一并收到 90 天（3 个月）。
     */
    uint256 public constant MAX_UNLOCK_DELAY = 90 days;

    /// @notice 罚没窗口长度（秒），默认 30 天；0 = 关闭窗口限制
    uint256 public penaltyWindowSeconds = 30 days;

    /// @notice 单个窗口内累计罚没上限（开窗时质押池的比例，基点），默认 50%；0 = 关闭窗口限制
    uint256 public penaltyWindowCapBps = 5000;

    /// @notice 罚没窗口开启期间是否禁止提取质押（默认开）。见 `withdrawLock` 的完整取舍说明
    bool public penaltyWindowLocksWithdraw = true;

    /// @notice 罚没执行人**不存副本**（源码审计 2026-09）：唯一入口是 本节点 Escrow 的调用。
    /// 单笔罚没 ≤ 托管金额的比例（基点，10000=100%），默认 50%
    uint256 public penaltyCapBps = 5000;

    /// @notice 撤资冷却期（秒），默认 7 天
    uint256 public unlockDelay = 7 days;

    /**
     * @notice 撤资冷却期**下限**：1 小时。
     *
     * 为什么要有下限（2026-10）：`setUnlockDelay(0)` 曾是完全合法的一条治理交易，而冷却归零后
     * `requestUnstake + 批准` 就能在一瞬间清空质押池——"冷却期"这条护栏等于可以被一条参数交易抹掉。
     * 与上限（90 天）配成一对：窗口既不能长到等于锁死，也不能短到等于不存在。
     */
    uint256 public constant MIN_UNLOCK_DELAY = 1 hours;

    /// @notice 撤资审批"自动放行"窗口的上限：365 天（见 `unstakeApprovalTimeout`）
    uint256 public constant MAX_UNSTAKE_APPROVAL_TIMEOUT = 365 days;

    /// @notice `freeze(operator, seconds, reason)` 可设的最长冻结期：180 天（与罚没窗口上限同量级）
    uint256 public constant MAX_FREEZE_SECONDS = 180 days;

    /**
     * @notice 单次派发允许转发给收款方的 gas 上限（与 Escrow 同口径，见 `_payoutOrCredit`）。
     * 不给上限就等于让**收款方**决定这笔结算花多少 gas：一个在 receive 里烧 gas 的收款方
     * 能把仲裁人的一次罚没直接烧成 OOG（交易回滚，但"罚不了"这件事已经发生了）。
     */
    uint256 public constant PAYOUT_GAS_CAP = 100_000;

    /**
     * @notice 走挂账分支时预留的 gas 余量（冷 SSTORE + 事件 + 调用点的收尾；见 `_payoutOrCredit`）
     *
     * 与 `Escrow.ACCRUAL_GAS_HEADROOM` **同口径同取值**（2026-10-14 一并从 35 000 提到 60 000）：
     * 旧值只算了挂账分支自身、没算结算收尾，于是存在一段预算让余量检查放行 push、
     * push 花掉那笔钱之后挂账反而写不下 ⇒ 整笔 `penalize`/`claimUnstake` OOG 回滚。
     * 回滚方向是安全的（罚没资格与窗口记账一并撤销，不会罚错），但"罚不了"确实发生了。
     *
     * 口径如实：这是**预算**不是证明；判据由 `Escrow.t.sol::testNoGasBudgetLosesMoney`
     * 那条预算扫描承担（两个合约的 `_payoutOrCredit` 是同一形状，扫描覆盖其行为）。
     * 偏高是安全方向：gas 紧张时更倾向挂账，钱仍挂在账上、由收款方自领。
     */
    uint256 public constant ACCRUAL_GAS_HEADROOM = 60_000;

    /**
     * @notice 撤资审批的**自动放行**窗口（秒）：0 = 必须管理员人工批准（默认，永不放行）。
     *
     * 为什么留这个旋钮（默认关闭）：审批制把"店主能不能把钱拿走"交给了 owner，
     * 于是 owner 失联/丢钥就等于**所有店主的质押永久锁死**——本仓库对"单点能把资金锁死"
     * 一向要求有有界出口（罚没窗口、撤资冷却都各有一对上下限）。设一个 >0 的值即表示
     * "管理员在窗口内不处理就视为默认通过"，把无限期锁死变成有界延迟；默认 0 表示
     * 明确选择"宁可等管理员"（符合"不可随意撤资"的产品口径）。
     */
    uint256 public unstakeApprovalTimeout = 0;

    /**
     * @notice **留存线**（治理侧的那一半出金下限）：打款之后 `poolOf(operator)` 不得低于这个额度
     *         （wei）。owner 可调（`setMinRetainedStake`），默认 **0 = 关闭**。
     *
     * 为什么需要它（2026-10 第三批，补敞口结构上覆盖不到的那一段）：
     * 买家的链上救济不止"退款申请/争议中"那两态——**确认收货之后**他还有 `afterSaleWindowBlocks`
     * （默认 180 天、上限 360 天）可以 `openAfterSale` 开一个售后案件，而补偿只能来自**卖家保证金**
     * （那笔托管早已结清）。敞口**看不到**这段窗口（它只看退款待决/争议中，售后案件刻意不计入，
     * 否则一笔陈年售后就能把质押无限期钉住）。于是存在一条完全合规的掏空路径：
     * 店主在任意一笔确认收货之后立刻 `requestUnstake` 全额、等冷却期满被批准 ⇒ 保证金清零；
     * 60 天后买家开案时，`penalize` 面对的是一个空池。留存线就是这条路径上的**下限**：
     * 打款后池不得低于它，所以池里**始终**留着一段可被罚没的钱。
     *
     * 它是什么、不是什么（如实写明，勿把两者的边界读混）：
     *   ① 它是**固定额**，不是按单笔风险的滚动准备金（rolling reserve）。真正贴合风险的做法是
     *      "每个订单按其售后窗口到期时间记账，窗口内那部分不可提"——那需要按单到期记账、
     *      一套随订单生灭而增删的账，成本高且多一个会写错的账本；本合约没做，代价是**过度保留**
     *      （店主即便一笔在途售后都没有，池底那一段也动不了），且额度不随订单笔数增长——
     *      单量大的店主应把留存线设得更高；
     *   ② 它与在途售后**敞口**不是替代关系，而是同一条下限的两个来源：`F = max(敞口, 留存线)`
     *      （见 `payoutFloors`）。敞口是**精确**的（有多少在途索赔就留多少钱），留存线只是
     *      **数量下限**。关掉留存线（=0）不等于关掉敞口；
     *   ③ **它只约束 owner 审批的那条出金路径**（`approveUnstake`）。
     *      店主不依赖 owner 的有界出口 `claimUnstake` **只受敞口约束**——否则 owner 把留存线
     *      设成一个巨大的数，就等于把"owner 失联时的出口"关掉了，而那条出口存在的全部意义正是防这个。
     *      买家补偿 `penalize` **不受任何出金下限约束**（留存线、敞口都不）：它是买家拿到
     *      第二层补偿的唯一入口，用"该留多少钱"的参数去否决它等于把赔付关死（见 `penalize`）。
     *      （owner 若想连自动放行也不放，正确的动作是把 `unstakeApprovalTimeout` 保持 0，而不是
     *      用一个金额参数去否决它——两个旋钮不该互相矛盾。）
     *   ④ 留存的额度从"这个店主能提多少"里扣掉：`retainedState()` 直接给 `withdrawable`（走 ③ 的口径），
     *      `claimableState()` 给不依赖 owner 的那条口径。若罚没把池打到留存线之下，则**owner 审批的**
     *      出金会被 `BelowRequiredFloor` 拒（直到店主补质押或治理调低）；`claimUnstake` 只看敞口，
     *      不在这里被拦。这是刻意的保守方向：审批路径下不许提，只能补。
     *
     * 取值建议（**刻意不设硬上限**，与 `penaltyWindowSeconds` / `unlockDelay` 那对"上下限"不同）：
     * 那两处的边界保护的是**买家/店主免于治理误配**（窗口太长＝锁死、冷却太长＝扣押）；留存线恰好相反，
     * 它是给买家的保护，调大只在 ③ 的那条路径上收紧，而"该留多少"取决于店铺规模、客单价与
     * `afterSaleWindowBlocks`——合约无法替运营方算出一个正确值。设 0 就是明确选择"不留存"（自担风险）。
     * 运营方应按"售后窗口内可能同时出现的在途售后笔数 × 单笔可能的罚没额"来估，
     * 并记住它不随订单自动增长（见 ①）。
     */
    uint256 public minRetainedStake = 0;

    /**
     * @notice operator => 撤资审批状态（2026-10：**提现要管理员批准**）
     * @dev 用独立 mapping 而不是往 `Position` 里加字段：`positions` 是 public 的，
     *      结构体加字段会让它的 getter 元组变形，所有按位置解码的读取方（前端 ABI、脚本）
     *      必须同批改，漏一处就是静默解码错位——与 Escrow 的 `acceptedPartialRefund` 同一个理由。
     */
    struct UnstakeRequest {
        bool approved; // 管理员已批准本批撤资（批准即打款，见 approveUnstake）
        uint64 requestedAt; // 本批申请时刻（自动放行窗口的起点）
    }

    mapping(address => UnstakeRequest) public unstakeRequests;

    /// @notice operator => 治理冻结的到期时刻（0 = 未冻结）。**冻结的唯一状态**——
    ///         对外经 `positions(operator)` 的 `frozen` 派生读数暴露（见该函数）
    mapping(address => uint64) public frozenUntil;

    /**
     * @notice 未能即时派发给店主/买家的资金（收款方拒收原生转账或 gas 不足时挂账，由其自行
     * `withdrawPayout()` 领取）。与 Escrow 的 `accruedPayouts` 同款、同一个理由：
     * 本合约的两条出金路径（审批给店主、罚没给买家）都可能遇到"收款方是拒收原生的合约"，
     * 旧实现 push 失败即 revert —— 罚没永远做不了、店主的质押永远提不出来（且没有任何出口）。
     */
    mapping(address => uint256) public accruedPayouts;

    event Staked(address indexed operator, uint256 amount, uint256 total); // total = poolOf（唯一口径，含 pending）
    event UnstakeRequested(address indexed operator, uint256 amount, uint64 releaseAt);
    event Withdrawn(address indexed operator, uint256 amount); // 只在真的 push 到账时发（挂账走 PayoutAccrued）
    /// @dev 治理冻结（**必须带期限**）。`until` 一并进事件：链下据此复算"还剩多久"，
    ///      也让"续期"这件事在日志里表现为一次次明确的动作（而不是一个永远在的状态）
    event OperatorFrozen(address indexed operator, uint64 until, string reason);
    event OperatorUnfrozen(address indexed operator);
    event PenaltyExecuted(bytes32 indexed orderId, address indexed operator, address indexed buyer, uint256 amount);
    event ClaimPenaltyExecuted(
        bytes32 indexed claimId, address indexed seller, address indexed claimant, uint256 amount
    );
    event ConfigUpdated(string key, uint256 value);
    // 2026-10 第二批（提现审批 + 出金下限 + 挂账）
    event UnstakeApproved(address indexed operator, uint256 amount); // **管理员**批准即打款（失败则挂账）
    event UnstakeAutoApproved(address indexed operator, uint256 amount); // 走自动放行窗口、由店主自领（无管理员批准）
    event UnstakeRejected(address indexed operator, uint256 amount, string reason); // 金额退回在池质押（不没收）
    event PayoutAccrued(address indexed to, uint256 amount); // 派发失败已挂账，由其自行领取
    event PayoutWithdrawn(address indexed to, uint256 amount);
    event GovernorSet(address indexed governor);
    // 注：原先还有 `EscrowChangeProposed` / `EscrowChangeCancelled` / `EscrowChanged` 三个事件，
    // 随整条换源机制一起删除（2026-10-14，见 `escrow` 的说明）；旧的 `ArbiterUpdated` 也早已随
    // "仲裁人不再存副本"一起删除（委员名单只在 本节点 Escrow 上，见 `committeeEpoch`）。

    error NotEscrow(); // 罚没只能由 本节点 Escrow（委员会票决达到阈值后）调用
    error OrderNotSettled(); // 罚没只针对 Settled 的订单（Refunded 是全额退款，不写售后窗口、基准为 0；与 Escrow 同一道门槛）
    error OrderConfirmedByBuyer(); // 买家自己确认收货结掉的单：罚没无据（门槛见 penalize）
    error PartiesMismatch();
    error OrderAlreadyPenalized();
    error ClaimAlreadyPenalized();
    error ClaimNotOpen();
    error ExceedsCap();
    error ExceedsWindowCap(); // 超出"本窗口累计"上限（速率闸，见 PenaltyWindow）
    error PenaltyWindowElapsed(); // 罚没时效已过：该单的售后窗口已关闭（见 penalize 的窗口判据）
    error PenaltyWindowLocked(); // 罚没窗口开启期间禁止提取质押（见 withdrawLock）
    error InsufficientStake();
    error Frozen();
    error PendingUnstakeExists();
    error NothingToWithdraw();
    error NoValue();
    error ZeroAmount();
    error ZeroAddress();
    error GovernanceLocked();
    error NotOwner();
    error GovernorAlreadySet();
    error GovernorNotContract();
    error GovernorMismatch();
    error RoleConflict(); // owner 也是角色：不得由仲裁人/被吊销仲裁人/当前节点主/墓碑兼任
    error EscrowUnavailable(); // 事实源无代码：owner 转移闸读不到判据时拒绝，不 fail-open
    error TransferFailed();
    // 2026-10 第二批
    error UnstakeNotApproved(); // 冷却已满但**管理员尚未批准**（或审批自动放行窗口未到）
    error BelowRequiredFloor(); // 本次出金会让质押池低于出金下限（在途售后敞口 / 治理留存线，见 payoutFloors）
    error NothingPending(); // 没有在途撤资申请（批准/驳回时）
    error NotMatured(); // 冷却期未满：审批只能在冷却期满后进行（买家投诉窗口）
    error NotFrozen(); // 对**本就未冻结**的 operator 调 unfreeze：拒绝而不是静默成功（见 unfreeze）
    error EscrowProbeFailed(); // 托管地址不满足 IEscrowMinimal（缺读法/订单形状不符）
    /**
     * @notice 构造期传入的托管地址，其运行时字节码哈希与同一批传入的哈希不一致。
     *
     * 地址与哈希必须互相印证。它挡的是**配置错误**——传错地址、传错哈希、把部署顺序写反
     * （例如 Registry/Escrow 的地址对调）——这类错误若放过去，症状是"罚没的事实源指向一个
     * 谁都说不清的合约"，而 Staking 里存着店主的钱、且构造后**没有第二个入口能改回来**。
     */
    error EscrowCodeHashMismatch();

    /**
     * @param escrow_ 本节点托管合约（**唯一事实源**：订单终局/参与方/**仲裁人**都由它读）。
     *        **不可更换**：换 Escrow 必须重部署 Staking 并做一次显式迁移（见 `escrow` 的说明）。
     * @param escrowCodeHash_ `escrow_` 的**构建哈希**（`keccak256(address(escrow).code)`，含
     *        构建 metadata）：只用于构造期“地址与哈希是同一次部署的一对”的互验。它**不是**
     *        Registry 的实现哈希（后者去掉 metadata，见 `RuntimeCodeHash`），两者不要混用。
     * @param initialOwner 合约 owner（只做参数、审批与冻结治理，**不能动用任何质押资金**）
     *
     * 注：原先还有 `arbiter_` 参数与对应的 `arbiter` 存储副本（单仲裁人时代），早已删除——
     * 委员名单/届次以本节点 Escrow 为唯一事实源，两份可变状态靠人工
     * 同步迟早漂移，而漂移的后果是资金级的（旧仲裁人密钥仍能罚没卖家质押）。
     */
    constructor(address escrow_, bytes32 escrowCodeHash_, address initialOwner) Ownable(initialOwner) {
        /*
          构造期形状探针 + 代码哈希互验：本合约的全部出金路径依赖事实源的读法，
          配错一个"有代码但没有这些读法"的合约会让质押整体提不出来。探的必须是会调用的。
        */
        escrow = _probeEscrow(escrow_);
        /*
          双锚定只保留**构造期校验**：哈希不落 storage，于是所有节点实例的运行时字节码一致，
          平台 Registry 的代码白名单才能认证本合约。传错地址/哈希/部署顺序 ⇒ 部署即失败。
        */
        if (keccak256(escrow_.code) != escrowCodeHash_) revert EscrowCodeHashMismatch();
    }

    // ── 委员会治理接线 ───────────────────────────────────────────────

    function setGovernor(address governor_) external onlyOwner {
        if (governor != address(0)) revert GovernorAlreadySet();
        if (governor_.code.length == 0) revert GovernorNotContract();
        if (!_governorMatches(governor_)) revert GovernorMismatch();
        governor = governor_;
        emit GovernorSet(governor_);
    }

    /// @dev governor 必须明确指向本 Staking 与其唯一事实源 Escrow。
    function _governorMatches(address candidate) private view returns (bool) {
        (bool ok, bytes memory ret) = candidate.staticcall(abi.encodeWithSignature("escrow()"));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != address(escrow)) return false;
        (ok, ret) = candidate.staticcall(abi.encodeWithSignature("staking()"));
        return ok && ret.length >= 32 && abi.decode(ret, (address)) == address(this);
    }

    /**
     * @dev 罚没/冷却/留存参数：接线前 owner 可完成初始配置；接线后只能由 governor 调。
     *      `unfreeze` 仍允许 owner 直接调（与 governor 的委员会快速解冻并存）。
     */
    modifier onlyGovernor() {
        address g = governor;
        if (g == address(0)) {
            if (msg.sender != owner()) revert NotOwner();
        } else if (msg.sender != g) {
            revert NotOwner();
        }
        _;
    }

    modifier onlyOwnerOrGovernor() {
        if (msg.sender != owner() && msg.sender != governor) revert NotOwner();
        _;
    }

    // ── 店主：质押 / 申请撤资（**打款由管理员批准触发**，2026-10 第二批）──

    /// @notice 增质押（累计；无最低额强制——质押门槛由节点自己决定，不在本合约字段里）
    /// @dev 第三个参数是 `poolOf`（staked + pending），不是单独的 `staked` 桶：
    ///      "在池担保额"对外只有一个口径（`poolOf`），事件里再放一个只算 staked 的"总额"
    ///      等于给链下账本埋第二种真相。
    function stake() external payable {
        if (msg.value == 0) revert NoValue();
        _positions[msg.sender].staked += msg.value;
        emit Staked(msg.sender, msg.value, poolOf(msg.sender));
    }

    /**
     * @notice 店主**申请**撤资：金额移入 pending 并开始冷却计时。**这一步不打款**。
     *
     * 两条前置（缺一不可）：
     *   ① 未被治理冻结；
     *   ② 当前没有另一批在途申请（单批次语义：上一批要先被管理员批准或驳回）。
     *
     * 冷却期（`unlockDelay`）是**买家投诉窗口**：从本函数到放款之间资金一直留在担保池里
     * （可被罚没），而两条放款路径（`approveUnstake` / `claimUnstake`）的第一道判据都是
     * "早于 `releaseAt` 一律 `NotMatured`"——没有第三条能绕过它的入口。
     *
     * 注：**出金下限不在这里拦**——本函数只是申请，一分钱都不出去（`staked` 与 `pending` 同属
     * `poolOf`，下限读数不变）；真正的判据在**打款**路径上（见 `payoutFloors`）。
     * 旧口径在这里挡"有在途售后就不许申请"，那条检查既拦不住任何钱，又把"申请"与"能不能拿到"
     * 两件事混在同一个错误码里（旧 `OpenAfterSaleExists` 已随该口径删除）。
     * 店主想先知道"最多能动多少"应读 `retainedState`（owner 审批那条路径的口径）
     * 或 `claimableState`（店主自取自领那条口径）。
     */
    function requestUnstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Position storage p = _positions[msg.sender];
        if (_isFrozen(msg.sender)) revert Frozen();
        if (p.pending != 0) revert PendingUnstakeExists();
        if (amount > p.staked) revert InsufficientStake();

        p.staked -= amount;
        p.pending = amount;
        p.releaseAt = uint64(block.timestamp + unlockDelay);
        // 新申请一律回到"待批准"（批准只对当批有效）
        unstakeRequests[msg.sender] = UnstakeRequest({approved: false, requestedAt: uint64(block.timestamp)});
        emit UnstakeRequested(msg.sender, amount, p.releaseAt);
    }

    /**
     * @notice **唯一的 owner 出金入口**：批准已到期的那批撤资申请并**直接打款**给店主。
     *
     * 前置：有在途申请；冷却期已满；未冻结；未被罚没窗口的出金闸锁住；
     * **打款后不破出金下限** `F = max(在途售后敞口, 留存线)`（见 `payoutFloors`）。
     * 打款失败（店主是拒收原生转账的合约等）不会 revert 整笔——改为挂账 + `PayoutAccrued`，
     * 店主随后自己 `withdrawPayout()` 领取（与 Escrow 的兜底同款）。
     *
     * **三条路径的唯一关系**（2026-10 第三批收口；旧 `releaseStake` 已删除）：
     *   · `requestUnstake`（店主）：只把 staked 挪进 pending 并按下 `releaseAt`，一分钱不出；
     *   · 本函数（owner）：冷却期满后把**整批** pending 打给店主；
     *   · `claimUnstake`（店主自己）：只在治理配置了 `unstakeApprovalTimeout` 且该窗口也过了时，
     *     把同一批 pending 领走——它是 owner 失联时的有界出口，判据比本函数**更窄**
     *     （只受在途售后敞口约束，不受留存线约束）。
     * 三者都只动 `pending`、都不看 staked。**没有任何路径能在 `releaseAt` 之前把钱拿出池**：
     * 旧 `releaseStake` 曾是一条无申请、无冷却的旁路，现在连形状都不存在了。
     */
    function approveUnstake(address operator) external onlyOwner nonReentrant {
        Position storage p = _positions[operator];
        if (p.pending == 0) revert NothingPending();
        if (block.timestamp < p.releaseAt) revert NotMatured();
        if (_isFrozen(operator)) revert Frozen();
        _revertIfWithdrawLocked(operator);
        _revertIfBelowRequiredFloor(operator, p.pending);

        uint256 amt = p.pending;
        p.pending = 0;
        p.releaseAt = 0;
        /*
          审批记录**不删除**，而是置成 `approved = true`（保留 `requestedAt` 作为"最近一批"的留痕）：
          删掉的话 `unstakeState().approved` 就恒为 false（该字段没有任何地方置位过），
          而 `autoApproveArmed` 里的 `!approved` 也随之变成死代码——前端"已批准"那一态永远显示不出来。
          下次 `requestUnstake` 会把它重置回 `false`，所以它表达的是"**最近一批**已获批准"。
        */
        unstakeRequests[operator].approved = true;
        emit UnstakeApproved(operator, amt);
        // 只有真的 push 出去才发 Withdrawn；挂账分支由 PayoutAccrued 表达（事件不得声称钱已到账）
        if (_payoutOrCredit(operator, amt)) emit Withdrawn(operator, amt);
    }

    /**
     * @notice 管理员**驳回**撤资申请：金额原路退回 `staked`（**不没收**），店主可稍后再申请。
     * 为什么要"退回在池"而不是"留在 pending 等下次批准"：pending 带着一个旧的 `releaseAt`，
     * 留在那里会出现"驳回之后过两天又被批准、绕开重新申请时的冷却与出金下限检查"的口子。
     */
    function rejectUnstake(address operator, string calldata reason) external onlyOwner {
        Position storage p = _positions[operator];
        if (p.pending == 0) revert NothingPending();
        uint256 back = p.pending;
        p.staked += back;
        p.pending = 0;
        p.releaseAt = 0;
        delete unstakeRequests[operator];
        emit UnstakeRejected(operator, back, reason);
    }

    /**
     * @notice 管理员在**自动放行窗口**内未处理时，由**店主自己**触发打款（`unstakeApprovalTimeout > 0`
     * 才有这条路径；默认 0 ⇒ 恒 revert `UnstakeNotApproved`）。
     *
     * 它存在的唯一理由是"owner 失联/丢钥不能等于所有店主的质押永久锁死"。闸门：
     * 冷却期满、未冻结、未被罚没窗口锁住、**打款后不低于在途售后敞口**。
     * 与 `approveUnstake` 是**同一批 pending、同一个冷却判据**：区别只有触发者
     * （店主 vs owner）与留存线是否参与（这里只看敞开）；没有第三条放款路径。
     *
     * **为什么这里只受敞口约束、不受治理留存线约束（2026-10-13 复审）**：留存线是 owner 设的
     * **策略性**下限，而这条路径存在的意义正是"owner 不动作时的出口"。若留存线也能否决它，
     * 那么 owner 只要把留存线设成一个巨大的数，这条"有界出口"就名存实亡——**两个旋钮不该互相矛盾**
     * （owner 若真的不想放自动放行，正确的动作是把 `unstakeApprovalTimeout` 保持 0）。
     * 敞口不同：它是"买家已经真实主张、钱还冻在托管里"的等额部分，任何路径都必须留出来。
     */
    function claimUnstake() external nonReentrant {
        Position storage p = _positions[msg.sender];
        if (p.pending == 0) revert NothingPending();
        if (block.timestamp < p.releaseAt) revert NotMatured();
        if (!_isAutoApproved(msg.sender)) revert UnstakeNotApproved();
        if (_isFrozen(msg.sender)) revert Frozen();
        _revertIfWithdrawLocked(msg.sender);
        _revertIfBelowExposureFloor(msg.sender, p.pending);

        uint256 amt = p.pending;
        p.pending = 0;
        p.releaseAt = 0;
        delete unstakeRequests[msg.sender];
        // 独立事件名：这条路径**没有**管理员批准，链下按事件统计"管理员批准"时不得把它算进去
        emit UnstakeAutoApproved(msg.sender, amt);
        if (_payoutOrCredit(msg.sender, amt)) emit Withdrawn(msg.sender, amt);
    }

    /**
     * @dev 是否已过自动放行窗口（`unstakeApprovalTimeout == 0` 时恒 false = 必须人工批准）。
     *      `!approved` 这一条与 `unstakeState.autoApproveArmed` 里的同名字段共用同一口径：
     *      已获批准的那一批不该再走自动放行（两处判据必须一致，否则界面与链上会对同一状态说两种话）。
     *      注意 `autoApproveArmed` 只回答“窗口开着、还没批准”，**不回答“时间到了没有”**；
     *      时间判据只在 `_isAutoApproved` 这一处。
     */
    function _isAutoApproved(address operator) internal view returns (bool) {
        UnstakeRequest memory r = unstakeRequests[operator];
        uint256 t = unstakeApprovalTimeout;
        return t > 0 && !r.approved && r.requestedAt != 0 && block.timestamp >= uint256(r.requestedAt) + t;
    }

    /// @notice 领取**挂账**的派发（仅在打款失败时才会产生挂账；见 `_payoutOrCredit`）
    function withdrawPayout() external nonReentrant {
        uint256 v = accruedPayouts[msg.sender];
        if (v == 0) revert NothingToWithdraw();
        accruedPayouts[msg.sender] = 0;
        _sendNative(msg.sender, v);
        emit PayoutWithdrawn(msg.sender, v);
    }

    /// @dev 治理冻结（**唯一判据**：`frozenUntil` 未到期）。冻结不再有第二个状态位——
    ///      `positions(operator)` 的 `frozen` 就是这个判据的读数（见该函数）
    function _isFrozen(address operator) internal view returns (bool) {
        return frozenUntil[operator] > block.timestamp;
    }

    /**
     * @dev **出金下限的两个来源（唯一实现）**：`exposure` = 在途售后敞口（`Escrow` 的幂等账），
     *      `required = max(exposure, minRetainedStake)`。
     *
     * 为什么把两个数一起返回、而不是两个函数各算一遍：两条 `_revertIfBelow*` 与两个只读视图
     * （`retainedState` / `claimableState`）必须永远对同一 operator 给出同一个 `exposure` ——
     * 各写一遍必然漂移，而漂移的后果是"界面说能提、链上 revert"。
     *
     * 为什么有两个数而不是一个：`required` 里的留存线是 **owner 的策略**，`exposure` 是
     * **买家的真实主张**。前者只用于 owner 审批的那条出金路径（`approveUnstake`），后者用于
     * `claimUnstake`（owner 失联时的有界出口）。**罚没两条都不用**（`penalize` 不受任何出金
     * 下限约束）：那是买家拿第二层补偿的唯一入口，而"在途主张远大于质押"是常态，
     * 用 `pool − exposure` 当门槛会把这条入口关死（完整代价见 `penalize`）。
     */
    function payoutFloors(address operator) public view returns (uint256 exposure, uint256 required) {
        exposure = escrow.sellerOpenExposure(operator) + escrow.sellerClaimExposure(operator);
        uint256 retained = minRetainedStake;
        required = exposure > retained ? exposure : retained;
    }

    /**
     * @dev **罚没单笔上限的基准（唯一实现）** = `min(托管毛额, 卖家实收净额)`。
     *
     * 当前模型没有平台费/节点抽成，`sellerNetAtSettle` 就是卖家实际拿到的净额
     * （全额结算 = amount；部分退款 = amount − refundedAmount）。用它作基准，
     * 罚没不会超过卖家真实所得；用毛额则会把"卖家从来没收到的那部分"也罚走
     * （旧模型里的费/抽成腿），制造"罚得比卖家赚得还多"的错位。
     *
     * 取 `min(毛额, 净额)` 而不是直接用净额：`sellerNetAtSettle` 只在 `toSeller > 0` 时写入，
     * 未写入即 0 ⇒ 基准 0 ⇒ `ExceedsCap`——**fail-closed**（读不到就不许罚，而不是按毛额放行）。
     */
    function _penaltyBase(bytes32 orderId, IEscrowMinimal.Order memory o) private view returns (uint256) {
        uint256 gross = o.amount > o.refundedAmount ? o.amount - o.refundedAmount : 0;
        uint256 net = escrow.sellerNetAtSettle(orderId);
        return gross < net ? gross : net;
    }

    /// @dev 判据按**打款后**的池算：`poolOf - payoutAmount ≥ floor`（边界值相等**通过**）。
    ///      必须在**扣账之前**调用：本函数只读不写，失败时不留下任何中间状态。
    ///
    /// **用减法而不是 `floor + payoutAmount` 比较**（2026-10-13 复审）：`minRetainedStake` 没有上界，
    /// 治理把它设成接近 `uint256.max` 时，`floor + payoutAmount` 会在 checked 算术下 panic 0x11
    /// （错误码从"低于下限"变成"溢出"，排查时看不出是哪个参数的问题）。
    /// 先比 `pool < floor`（此时任何一笔都动不了，语义清楚），再比剩余额度，两处都不会溢出。
    function _revertIfBelowFloor(address operator, uint256 payoutAmount, uint256 floor) internal view {
        if (floor == 0) return; // 没有下限：连一次多余的算术/比较都不做
        uint256 pool = poolOf(operator);
        if (pool < floor || pool - floor < payoutAmount) revert BelowRequiredFloor();
    }

    /// @dev owner 审批的那条出金路径（`approveUnstake`）：`max(敞口, 留存线)`
    function _revertIfBelowRequiredFloor(address operator, uint256 payoutAmount) internal view {
        (, uint256 required) = payoutFloors(operator);
        _revertIfBelowFloor(operator, payoutAmount, required);
    }

    /// @dev **只用敞口**的判据（只被 `claimUnstake` 使用）：打款后池不得低于买家已真实主张的
    ///      额度。留存线（owner 策略）刻意不参与这条路径——它是"owner 失联"的有界出口，
    ///      若被留存线否决，owner 设一个大数就能把它关掉。理由的完整版见 `claimUnstake`。
    ///      罚没连这条判据都没有（见 `penalize`），别把两者混成同一层。
    function _revertIfBelowExposureFloor(address operator, uint256 payoutAmount) internal view {
        (uint256 exposure, ) = payoutFloors(operator);
        _revertIfBelowFloor(operator, payoutAmount, exposure);
    }

    /**
     * @dev 派发：先按 gas 上限尝试 push，失败或 gas 余量不足则**挂账**给收款方自取。
     * 与 Escrow `_payoutOrCredit` 逐条同款（含"挂账自身要花的 gas 必须预留"这条结构性保证）。
     * @return pushed 是否真的把钱 push 给了收款方（false = 已挂账，调用方**不得**发"已打款"类事件）
     */
    function _payoutOrCredit(address to, uint256 value) internal returns (bool pushed) {
        if (value == 0) return false;
        if (gasleft() > PAYOUT_GAS_CAP + ACCRUAL_GAS_HEADROOM) {
            (bool ok, ) = payable(to).call{value: value, gas: PAYOUT_GAS_CAP}("");
            if (ok) return true;
        }
        accruedPayouts[to] += value;
        emit PayoutAccrued(to, value);
    }

    /**
     * @notice 某店主的撤资申请全貌（**唯一实现**：前端"等待管理员批准/已可批准"的展示共用）。
     * @return pending 在途申请金额（wei）
     * @return releaseAt 冷却期到期时刻（unix 秒；0 = 无在途申请）
     * @return approved 是否已获批准（`approveUnstake` 是即打款的，所以读取时通常已清零）
     * @return autoApproveArmed 是否配置了自动放行窗口且尚未放行
     * @return autoApproveAt 自动放行时刻（0 = 未配置或已放行）
     */
    function unstakeState(address operator)
        external
        view
        returns (uint256 pending, uint64 releaseAt, bool approved, bool autoApproveArmed, uint256 autoApproveAt)
    {
        Position storage p = _positions[operator];
        UnstakeRequest memory r = unstakeRequests[operator];
        approved = r.approved;
        uint256 t = unstakeApprovalTimeout;
        autoApproveArmed = !approved && t > 0 && r.requestedAt != 0;
        autoApproveAt = autoApproveArmed ? uint256(r.requestedAt) + t : 0;
        return (p.pending, p.releaseAt, approved, autoApproveArmed, autoApproveAt);
    }

    /**
     * @notice 某店主**出金下限**读数（**owner 审批那条路径的口径**：`approveUnstake`）：
     *         现在最多能动多少、动完池里还剩多少。
     *
     * 与 `unstakeGate` 的分工：那个回答"现在能不能被批准"（冻结、罚没窗口锁、冷却），
     * 本函数回答"**金额上**能动到哪"——两者都要看，缺一个就会出现"界面说可以提、链上 revert"
     * （`_revertIfBelowRequiredFloor` 是唯一的金额判据，本函数只是它的读数，
     * 口径必须逐字一致：`withdrawable = pool > required ? pool - required : 0`）。
     * 注意它**不**判断其它闸门（例如冻结期间 `withdrawable` 仍会显示一个正数，而实际提不走）。
     *
     * 口径来源是 `payoutFloors` 的 `required = max(在途售后敞口, 留存线)`。店主**自取自领**那条
     * （`claimUnstake`）的口径不同（只受敞口约束，见 `claimableState`）——别把两个读数混用。
     *
     * @param pool 该店主当前的担保池（`poolOf`：staked + pending，冷却期资金仍属池）
     * @param required 当前生效下限（wei；= max(在途售后敞口, `minRetainedStake`)）
     * @param withdrawable 走 owner 审批路径时现在**最多**能出金的金额（wei；0 = 一分都动不了——
     *                     在下限之上才能动，只能补质押或等售后了结 / 治理调低留存线）。
     *                     注意它只是**金额上限**：真正的打款金额是 `pending`，且还受冷却、
     *                     冻结、罚没窗口三道闸约束（见 `unstakeGate`）。
     */
    function retainedState(address operator)
        external
        view
        returns (uint256 pool, uint256 required, uint256 withdrawable)
    {
        pool = poolOf(operator);
        (, required) = payoutFloors(operator);
        withdrawable = pool > required ? pool - required : 0;
    }

    /**
     * @notice 某店主**自取自领**那条路径（`claimUnstake`）的金额读数：
     *         它**只**受在途售后敞口约束，不受治理留存线约束（理由见 `claimUnstake`）。
     *
     * 为什么单独一个视图而不是复用 `retainedState`：两条路径的下限**本来就不同**，
     * 用一个读数糊住两者，必然出现"界面按留存线说不能提、链上其实能提"（或反过来）。
     * 两个视图共用同一个内核 `payoutFloors`，所以不会漂移。
     *
     * @param pool 当前担保池（`poolOf`）
     * @param exposure 在途售后敞口（wei）
     * @param claimable 走 `claimUnstake` 时**现在真的能领出**的金额（wei；0 = 整批 pending
     *                 会破敞口下限，`claimUnstake` 会 revert）。注意 `claimUnstake` 没有
     *                 “部分领取”参数：它要么把整批 pending 打给店主，要么因 `BelowRequiredFloor`
     *                 回滚；所以这里返回的是 **pending 或 0**，不是 `pool − exposure` 这个上限。
     *                 旧实现返回上限，曾出现“界面报可领 99，链上因整批 100 破下限而 revert”。
     */
    function claimableState(address operator)
        external
        view
        returns (uint256 pool, uint256 exposure, uint256 claimable)
    {
        pool = poolOf(operator);
        (exposure, ) = payoutFloors(operator);
        uint256 available = pool > exposure ? pool - exposure : 0;
        Position storage p = _positions[operator];
        /*
          `claimUnstake` 的实际前置必须全部在这里回答，否则界面会报一个"能领"的金额，
          而店主签下去必吃 revert（`UnstakeNotApproved` / `Frozen` / `PenaltyWindowLocked`）。
          金额下限只回答"多少"，不回答"现在能不能"：三条状态闸缺一不可。
        */
        if (p.pending == 0 || block.timestamp < p.releaseAt || !_isAutoApproved(operator) || _isFrozen(operator)) {
            return (pool, exposure, 0);
        }
        (bool locked, ) = withdrawLock(operator);
        if (locked) return (pool, exposure, 0);
        claimable = p.pending <= available ? p.pending : 0;
    }

    /**
     * @notice 某店主现在**能不能申请 / 能不能被批准**撤资（状态 + 金额的合并读数，前端与运维用）：
     * 返回 (canRequest, canApprove, reason)。`reason` 为空串表示没有阻塞项。
     * 口径与合约内的前置逐条一致——前端不再自己拼判据（避免"界面说能提、链上 revert"）。
     *
     * **`canRequest` 与 `canApprove` 各自只表达自己那条路径的前置，两者不可互相借用
     * （2026-10-14 修复）**：
     *   · `canRequest` 只回答"`requestUnstake` 会不会成功"：冻结 / 已有在途申请 / 池里有可申请的金额
     *     （`staked == 0` 时任何正数金额都会撞 `InsufficientStake`，所以那时也算不能申请）。
     *   · `canApprove` 只回答"`approveUnstake` 会不会成功"：在途申请 + 冷却期满 + 未冻结 +
     *     未被罚没窗口的出金闸锁住 + 这笔金额不破出金下限。
     *
     * **出金闸（罚没窗口锁）只能出现在 `canApprove` 一侧**（旧实现在 `canRequest` 之前先查锁，
     * 于是锁定期内界面显示"不能申请"，而 `requestUnstake` **根本没有这条前置**、链上照收——
     * 界面对同一状态说了两种话，业主按界面等一个窗口期才去申请）。申请**一分钱都不出去**，
     * 它不该受任何出金闸约束（同款理由见 `requestUnstake`：出金下限也不在那里拦）。
     * 判据只有一处：本条与那三个函数的前置**必须表达同一件事**，任何一侧改了都要同批改另一侧。
     *
     * ⚠ `reason` 是**合并判据下最优先的阻塞项**（顺序：`frozen` → `pending-unstake` →
     * `cooling` → `penalty-window-locked` → `below-floor`），它**不是**某一次具体调用的
     * revert 名称映射：例如"同时被冻结且冷却未满"时这里报 `frozen`，而 `approveUnstake` 会先撞
     * `NotMatured`。因此调用方应把 `reason` 当**解释**（"为什么现在动不了"），需要精确错误码时
     * 以实际调用的 revert 为准。
     *
     * 2026-10-13 复审把**金额**并进了 `canApprove`：它同时要求"这笔 pending 不大于
     * `retainedState().withdrawable`"（走 owner 审批口径），所以 `canApprove == true`
     * 与 `approveUnstake` 会不会成功**逐字一致**——此前它只报状态类闸门，界面得自己再比一次
     * 金额，而"再比一次"就是漂移的入口。金额不够时报 `below-floor`。
     */
    function unstakeGate(address operator) external view returns (bool canRequest, bool canApprove, string memory reason) {
        Position storage p = _positions[operator];
        if (_isFrozen(operator)) return (false, false, "frozen");
        // 没有在途申请：申请路径只看"池里有没有可申请的钱"，批准路径无对象可谈（不打款、不读金额）
        if (p.pending == 0) {
            if (p.staked == 0) return (false, false, "nothing-staked");
            return (true, false, "");
        }
        if (block.timestamp < p.releaseAt) return (false, false, "cooling");
        (bool locked, ) = withdrawLock(operator);
        if (locked) return (false, false, "penalty-window-locked");
        // 金额判据与 `_revertIfBelowRequiredFloor` 同一内核（payoutFloors）+ 同一比较形状（减法，避免溢出）
        (, uint256 required) = payoutFloors(operator);
        uint256 pool = poolOf(operator);
        if (pool < required || pool - required < p.pending) return (false, false, "below-floor");
        return (false, true, "");
    }

    /**
     * @notice 该 operator 现在能否提取已到期的撤资（**唯一实现**：合约内部闸门与前端展示共用）。
     *
     * 为什么要有这道闸（源码审计 2026-09 续）：质押是"托管判付之后的第二层补偿资金"，
     * 而卖家可以在察觉不妙之前就 `requestUnstake`，等冷却期一过让资金**到期待提**——
     * 之后一旦出现争议，他可以随时把剩下的质押一次性提走。速率闸（`PenaltyWindow`）把
     * 单窗口能罚的上限压到开窗时质押池的 50%，但**它管不住卖家跑掉**：
     * 窗口一开、罚掉 50%，卖家立刻把另外 50% 提走，后续受害者在下一个窗口里就无钱可罚了。
     * 于是两道闸必须配套：**窗口开启期间不得出金**（长度在开窗时快照，默认 30 天）。
     *
     * 到期时刻取 `window.end`（**开窗时快照**，2026-09 复审修改）：窗口一开，"锁到什么时候"就是
     * 既定事实，治理事后调大/调小 `penaltyWindowSeconds` 都不会改写它——否则 owner 一条交易
     * 就能同时解开所有在途窗口的出金闸（见 `setPenaltyWindow`）。
     * **但开关本身仍是实时的**：`penaltyWindowLocksWithdraw` 不参与快照，这是留给治理的
     * 紧急放人路径（怀疑仲裁人发疯时把被锁的诚实店主放出来），也是"实时读窗口长度"这个
     * 旧行为唯一真正需要保留的能力——它已经有专门的开关，不必再让数字承担救援职责。
     *
     * **提前放人的唯一信号**（2026-10-21 复审）：`revokedArbiter[开窗人]` 为真，或
     * `penaltyWindowLocksWithdraw` 被关掉。**换届本身不是信号**——旧届成员仍能裁旧单，
     * 把"不在当前届"当解锁会让一次例行 `setArbiters` 顺手拆掉在途窗口的锁。
     *
     * 明确记录的代价（这是刻意的取舍）：
     *   · 被罚没过的店主，其已到期的撤资要**再多等**到窗口结束（最多 180 天）才能提取；
     *   · 这个闸由仲裁人的动作触发，所以一把被盗/恶意的仲裁人密钥可以用 1 wei 的罚没
     *     反复把某店主的出金窗口往后推（本质与它已经能做的"每窗口罚走 50%"同级，
     *     但成本更低）。治理的应对是**显式 `revokeArbiter`**（同时停掉他的票并解除他开的窗口）
     *     或 `setPenaltyWindowLock(false)`（全局、立即生效，不受快照影响）；常规
     *     `removeArbiter`/`setArbiters` **不会**解除在途窗口。
     *   · 被 `freeze` 的店主本来也提不了（治理冻结），所以这道闸不引入新的权限类别。
     *
     * @return locked 是否被锁住
     * @return until 锁到期时刻（unix 秒）；0 = 未上锁
     */
    function withdrawLock(address operator) public view returns (bool locked, uint256 until) {
        if (!penaltyWindowLocksWithdraw) return (false, 0); // 实时开关：治理的紧急放人路径
        PenaltyWindow memory w = penaltyWindows[operator];
        if (w.end == 0) return (false, 0);
        uint256 end = uint256(w.end);
        if (block.timestamp >= end) return (false, 0);
        /*
          **唯一的提前放人信号 = 开窗人已被显式吊销**（`revokedArbiter`），不是"他是否还在
          当前届"。换届是正常治理动作，而旧届成员仍能裁旧单：若把"不在当前届"当解锁，
          一次例行 `setArbiters` 就会让旧届刚开的窗口**生来不锁**，卖家在窗口内把剩余质押
          提走，速率闸的"罚掉一半后不能再跑"随之失效（2026-10-21 复审，已用回归钉住）。
          显式吊销同时停掉他的票，语义一致：怀疑失陷 → 吊销 → 他开的窗口随之解除。
          没有记录 opener 的历史窗口（opener == 0）按保守方向继续锁——`revokedArbiter[0]`
          恒为 false，正好落在这个分支上。
        */
        if (IEscrowOwnerRoles(address(escrow)).revokedArbiter(penaltyWindowOpener[operator])) {
            return (false, 0);
        }
        return (true, end);
    }

    function _revertIfWithdrawLocked(address operator) internal view {
        (bool locked, ) = withdrawLock(operator);
        if (locked) revert PenaltyWindowLocked();
    }

    // ── 治理（owner）：冻结调查 + 参数 ──

    /**
     * @notice 治理冻结（**必须带期限**，`1..MAX_FREEZE_SECONDS` 秒）：到期自动解除
     *         （`frozenUntil <= now` 即视为未冻结）。
     *
     * **2026-10-13 收口（推翻此前"无限期 freeze + 带期限 freezeUntil 两个入口"）**：
     * 原先 `freeze(operator, reason)` 是**无限期**的，而 `freezeUntil` 有 180 天上限——
     * 同一件事两个入口、只有一个有界，于是那条上限**可以被绕过**（改用 `freeze` 即可永久冻结）。
     * 而本仓对"能把资金锁住多久"一向给硬上限（罚没窗口 180 天、撤资冷却 90 天），冻结不该例外；
     * 契约注释里写的也正是这个意图，代码却留了个无界入口——现在两边一致了：
     *   · 只有一个入口 `freeze(operator, seconds, reason)`，`seconds` 必须在上限内
     *     （0 也拒：那是一次什么都不做的"冻结"，只会让事件日志与状态对不上）；
     *   · 需要更长时间就**到期后重新冻结**——那是一次新的、带事件、可被店主与监控看到的动作，
     *     而不是一个"设完就永远在"的状态。代价如实写明：**治理要记住续期**，
     *     否则调查中的店主会在到期后自动解冻。
     */
    function freeze(address operator, uint256 seconds_, string calldata reason) external onlyOwner {
        require(seconds_ > 0 && seconds_ <= MAX_FREEZE_SECONDS, "freeze-seconds");
        uint64 until = uint64(block.timestamp + seconds_);
        frozenUntil[operator] = until;
        emit OperatorFrozen(operator, until, reason);
    }

    /**
     * @notice 解除治理冻结。
     *
     * **对本就未冻结的 operator 直接 revert（`NotFrozen`，2026-10-14 修复）**：旧实现无条件
     * `frozenUntil[operator] = 0` 并发 `OperatorUnfrozen`，于是
     *   · 一次"解冻"可以对一个从未被冻结的店主落链，事件日志里出现一次并不存在的解冻
     *     （链下按日志重建"治理动作时间线"时会产生假记录）；
     *   · 一笔因地址写错而落到别人身上的 `unfreeze` **静默成功**——而它本该是一次失败，
     *     让人立刻发现"我操作的不是我以为的那个人"。
     * 语义上"解冻一个没冻结的人"不是一个动作（与 `freeze` 拒收 `seconds == 0` 同一条理由：
     * 那是一次什么都不做的调用，只会让日志与状态对不上），所以这里明确失败而不是静默成功。
     * 注：冻结**到期之后**也算"未冻结"（唯一真相是 `frozenUntil > now`，见 `_isFrozen`），
     * 所以对已到期的冻结调本函数同样 revert——自然到期不需要、也不该由治理补一笔交易。
     */
    function unfreeze(address operator) external onlyOwnerOrGovernor {
        if (!_isFrozen(operator)) revert NotFrozen();
        frozenUntil[operator] = 0;
        emit OperatorUnfrozen(operator);
    }


    /**
     * @notice 设置**单笔罚没上限比例**（基点；`1..10000`）
     *
     * **下界是 1，不是 0（2026-10-14 独立审计修订）**：`0` 在算术上让
     * `cap = base × 0 / 10000 == 0`，于是 `penalize` **永久不可用**
     * （`amountWei == 0` 撞 `ZeroAmount`、`> 0` 撞 `ExceedsCap`）——买家再也拿不到保证金补偿，
     * 而这是一条"看起来只是把上限调到最小"的治理交易，没有任何读数或事件指出它把罚没整体关掉了。
     *
     * 与它的兄弟旋钮口径对齐：`setPenaltyWindow(_, 0)` 与 `penaltyWindowCapBps = 0` 的语义是
     * "**不再开新窗**"，那条路径在 `setPenaltyWindow` 的注释里写明了"治理自担风险"。
     * 要关掉速率闸就走那条路（有文档、有事件、语义明确）；**要关掉罚没本身没有合法旋钮**——
     * 罚没是"托管判付之后的第二层资金"，是买家在卖家跑路后的唯一补偿来源，不该有一个静默 kill switch。
     */
    function setPenaltyCapBps(uint256 value) external onlyGovernor {
        require(value >= 1 && value <= 10000, "cap-bps");
        penaltyCapBps = value;
        emit ConfigUpdated("penaltyCapBps", value);
    }

    /**
     * @notice 罚没**速率**闸参数：`windowSeconds` 内累计罚没不超过开窗时质押池的 `capBps/10000`。
     *
     * ⚠ 两个参数的生效时机现在**一致**（2026-09 复审修改，此前 `windowSeconds` 是实时生效的）：
     *   · `capBps`（窗口的累计上限）：**开窗时快照**成 `w.cap`，进行中的窗口按它执行完。
     *     理由：改参数不该把已经发生的罚没重算——否则"这个卖家被罚了多少"会随治理动作漂移。
     *   · `windowSeconds`（窗口长度）：**同样在开窗时快照**成 `w.end = now + windowSeconds`，
     *     进行中的窗口按它执行完（`penaltyWindowState` 与 `withdrawLock` 都读 `w.end`）。
     *
     * 为什么把 `windowSeconds` 从"实时"改成"快照"（这是一次明确的口径修改，DEPLOY/运营文档同步）：
     *   旧口径下，一条 `setPenaltyWindow(很小的值, …)` 会**追溯地**让所有在途窗口立刻过期：
     *   速率闸对在途窗口等于失效（`w.penalized` 归零、按当下池重开新窗），**同时解开所有人的出金闸**。
     *   也就是说"误配一次"的杀伤半径是全站所有店主，而它换来的能力只有一条——
     *   "把被窗口锁住的店主立刻放出来"。而那条能力**本来就有专门的实时开关**
     *   `penaltyWindowLocksWithdraw`（见 `withdrawLock`），不必再让一个数字兼职救援。
     *   快照之后：治理参数只影响**之后开启的窗口**，与 `capBps` 同一套时间语义，
     *   合约里也不再存在"同一结构体两个字段生效时机不同"这种必须反复解释的设计。
     *
     * 需要立刻止住一个失控的仲裁人时，正确的动作仍是**换届 + 显式吊销**（`Escrow.setArbiters` /
     * `removeArbiter` 只卸任；`revokeArbiter` 才会让他的旧票不再计入），而不是改这里的数字。
     *
     * @param windowSeconds 窗口长度（秒）；0 = **不再开新窗**（进行中的窗口按快照执行完）；
     *        非 0 值必须在 `MIN_PENALTY_WINDOW_SECONDS`（1 天）..`MAX_PENALTY_WINDOW_SECONDS`
     *        （180 天）之间——下界防"1 秒窗口把速率闸与出金闸缩成不存在"，上限防"永久锁死"。
     * @param capBps 窗口内累计上限（基点，10000 = 开窗时质押池的 100%）；0 = 不再开新窗
     */
    function setPenaltyWindow(uint256 windowSeconds, uint256 capBps) external onlyGovernor {
        require(windowSeconds == 0 || windowSeconds >= MIN_PENALTY_WINDOW_SECONDS, "window-seconds-floor");
        require(windowSeconds <= MAX_PENALTY_WINDOW_SECONDS, "window-seconds-cap");
        require(capBps <= 10000, "window-cap-bps");
        penaltyWindowSeconds = windowSeconds;
        penaltyWindowCapBps = capBps;
        emit ConfigUpdated("penaltyWindowSeconds", windowSeconds);
        emit ConfigUpdated("penaltyWindowCapBps", capBps);
    }

    /**
     * @notice 开关"罚没窗口期间禁止提取质押"（默认开）。
     * 关掉它的含义是：接受"卖家在窗口内把剩余质押提走、后续受害者无钱可罚"的风险，
     * 换取"被罚过一次的店主不必再多等到窗口结束"。见 `withdrawLock` 的取舍说明。
     */
    function setPenaltyWindowLock(bool on) external onlyGovernor {
        penaltyWindowLocksWithdraw = on;
        emit ConfigUpdated("penaltyWindowLocksWithdraw", on ? 1 : 0);
    }

    /**
     * @notice 某 operator 的罚没窗口读数（**唯一实现**：合约、前端、文档共用同一套判据，
     * 前端不再自己算"窗口过没过期 / 还剩多少"）。
     *
     * @return limited 是否启用了窗口限制（false 时 remaining / windowEndsAt 无意义）。
     *                 进行中的窗口在自己的 `end` 之前**始终**算"有限制"——即使治理随后把
     *                 `windowSeconds`/`capBps` 置 0：那些参数只影响之后开启的窗口，界面不能
     *                 因为治理关了参数就显示"可以随便罚"（那会让人照着重试然后吃 revert）。
     * @return remaining 本窗口内**还可**罚没的额度（wei）：
     *                   窗口尚未开启或已过期 ⇒ 按**此刻**质押池折算（下一次罚没会开新窗）
     * @return windowEndsAt 本窗口结束时刻（unix 秒，= 开窗时快照的 `w.end`）；0 = 当前没有进行中的窗口
     */
    function penaltyWindowState(address operator)
        public
        view
        returns (bool limited, uint256 remaining, uint256 windowEndsAt)
    {
        PenaltyWindow memory w = penaltyWindows[operator];
        /*
          **不读当前仲裁人**（2026-10 第三批，P1）：额度累计与窗口归属已经解耦——
          轮换仲裁人不会作废在途窗口、也不会把已用额度还回去（那正是旧实现可被循环刷新的根因）。
          进行中的窗口按自己的 `cap`/`end` 快照执行完；只有窗口到期后，下一次罚没才按当下池开新窗。
        */
        if (w.end != 0 && block.timestamp < uint256(w.end)) {
            // 进行中的窗口：长度与额度都是开窗时的快照，治理改参数不改写它
            return (true, w.penalized >= w.cap ? 0 : w.cap - w.penalized, uint256(w.end));
        }
        // 无进行中的窗口：下一次罚没会按**当下**参数开新窗，所以这里按当下参数估算
        uint256 win = penaltyWindowSeconds;
        uint256 bps = penaltyWindowCapBps;
        if (win == 0 || bps == 0) return (false, 0, 0); // 不再开新窗
        return (true, (poolOf(operator) * bps) / 10000, 0);
    }

    /**
     * @notice 某 operator 当前罚没窗口的**全量明细**（运维/治理诊断用；`penaltyWindowState` 只给结论）。
     * @return start 开窗时刻（unix 秒；0 = 尚未开窗）
     * @return end 到期时刻（开窗时快照）
     * @return cap 本窗口累计上限（开窗时质押池快照 × capBps）
     * @return penalized 本窗口已累计罚没
     * @return epochAtOpen 开窗时**该单的裁决届次**（`Escrow.orderEpoch`；纯留痕/诊断，不参与额度累计，也不参与出金锁）
     */
    function penaltyWindowDetail(address operator)
        external
        view
        returns (uint64 start, uint64 end, uint256 cap, uint256 penalized, uint32 epochAtOpen)
    {
        PenaltyWindow memory w = penaltyWindows[operator];
        return (w.start, w.end, w.cap, w.penalized, w.epochAtOpen);
    }

    /**
     * @dev 计入本窗口并校验累计上限（**唯一实现**：penalize 与 penaltyWindowState 用同一套
     * "开窗时按当时质押池快照"的算法；两处各写一遍必然漂移，而漂移的后果是界面显示"还能罚"
     * 而链上 revert，或反过来）。
     *
     * **累计与窗口归属解耦（2026-10 第三批，P1）**：本函数**不读**当前届——
     * 旧实现把"窗口属于开窗时的仲裁人"当成判据，于是 owner 一次换届（`setArbiters`/`addArbiter`/
     * `removeArbiter`）就能让在途窗口作废、按当下池重开一个新额度，"单窗口 ≤ 50%"可以被循环
     * 刷新到无上界。现在：额度按 operator **单调累计**，只在窗口**到期**时重置，与谁在任无关；
     * 换届仍能立刻吊销失陷密钥（`revokeArbiter` 置 `revokedArbiter`，让被吊销者连旧届的票都不算），
     * 但**不会**把已经用掉的额度还回去。`epochAtOpen` 只是窗口归属的诊断读数；
     * `penaltyWindowOpener` 记录**开窗人**（只在开窗时写一次），`withdrawLock` 只问
     * `revokedArbiter(opener)`——显式吊销才解除，换届/是否当前届不再参与。
     *
     * 窗口的长度与额度都只在**开窗那一刻**定型：进行中的窗口（`block.timestamp < w.end`）按自己的
     * 快照执行完，不再看 `penaltyWindowSeconds`/`penaltyWindowCapBps` 的当下值；只有需要开新窗时
     * 才读实时参数，`win == 0 || bps == 0` 表示"不再开新窗"（在途窗口不受影响）。
     */
    function _chargePenaltyWindow(
        address operator,
        uint256 pool,
        uint256 amountWei,
        uint32 orderEpochOf,
        address voter
    ) internal {
        PenaltyWindow storage w = penaltyWindows[operator];
        if (w.end != 0 && block.timestamp < uint256(w.end)) {
            uint256 usedNow = w.penalized + amountWei;
            if (usedNow > w.cap) revert ExceedsWindowCap();
            w.penalized = usedNow;
            // opener 只在开窗时写一次（见 `penaltyWindowOpener`）：同一窗口里的后续罚没不改写它
            return;
        }
        uint256 win = penaltyWindowSeconds;
        uint256 bps = penaltyWindowCapBps;
        if (win == 0 || bps == 0) return; // 治理不再开新窗（速率闸对新窗口关闭）
        w.start = uint64(block.timestamp);
        w.end = uint64(block.timestamp + win); // win ≤ MAX_PENALTY_WINDOW_SECONDS（180 天），不会溢出 uint64
        w.cap = (pool * bps) / 10000;
        // 该单的裁决届次（`Escrow.orderEpoch`）：**诊断读数**，不参与出金锁与额度累计
        w.epochAtOpen = orderEpochOf;
        penaltyWindowOpener[operator] = voter;
        if (amountWei > w.cap) revert ExceedsWindowCap();
        w.penalized = amountWei;
    }

    function setUnlockDelay(uint256 value) external onlyGovernor {
        /*
          下限（2026-10 新增）：1 小时。`setUnlockDelay(0)` 曾完全合法，而冷却归零后
          "申请 → 批准"就能在一瞬间清空质押池——"冷却是买家投诉窗口"这条护栏可以被一条参数交易
          抹掉。上限 90 天的理由见下（防"荒谬的长冷却"等于锁死）；两侧都要有界。
        */
        require(value >= MIN_UNLOCK_DELAY, "unlock-delay-floor");
        /*
          上限是**策略**上限，不是溢出护栏。⚠️ **2026-10-16 更正一句假话**：此处此前写
          "显式转换 `uint64(x)` 溢出时是 revert（panic 0x11）"——**那是错的**。Solidity 0.8.x
          的溢出检查只覆盖算术运算（`+ - * / **`），**显式窄化转换是静默截断**（这正是
          OpenZeppelin `SafeCast` 存在的理由；实测 `uint64(2^64) == 0`、`uint64(2^64+17280) == 17280`，
          都不 revert）。
          所以"即使没有这条 require 也不会被悄悄改小"这句话只对**算术**成立，对转换不成立：
          `p.releaseAt = uint64(block.timestamp + unlockDelay)`（见 requestUnstake）里的加法
          由 checked 算术保证，而那个 `uint64(...)` 本身会截断——上限 90 天这条 require
          因此在**两个意义上**都需要：它既是策略上限（防治理误配出荒谬的长冷却，那在效果上
          等于把店主已申请撤资的资金锁住），也是"永远不会走到那个会截断的转换上"的前提。
          同类形状在部署脚本里曾经是活的（`Deploy.s.sol` 对三个窗口参数直接 `uint64(envOr(...))`）
          ——已改为越界即拒绝部署，见该文件的 `_envUint64`。

          **2026-09 上线前下调**：从 3650 天（10 年）收到 `MAX_UNLOCK_DELAY` = 90 天，
          与 `setPenaltyWindow` 的 `window-seconds-cap` 同款守卫、同一套"防锁死"理由
          （100 年与 10 年在"等于锁死"这件事上没有区别，只有量级上的自我安慰）。
        */
        require(value <= MAX_UNLOCK_DELAY, "unlock-delay-cap");
        unlockDelay = value;
        emit ConfigUpdated("unlockDelay", value);
    }

    /**
     * @notice 设置撤资审批的**自动放行**窗口（秒）：0 = 必须人工批准（默认），上限 365 天。
     *
     * 语义：申请之后经过该窗口，管理员仍未批准也视为放行——**由店主自己调用 `claimUnstake()`
     * 触发打款**（见该函数）。它**不是**给店主的常规快捷通道（默认 0 = 关闭），而是**给
     * "管理员失联"留的有界出口**：设成 0（默认）表示明确接受"管理员不批就永远提不走"这个单点风险。
     */
    function setUnstakeApprovalTimeout(uint256 seconds_) external onlyGovernor {
        require(seconds_ <= MAX_UNSTAKE_APPROVAL_TIMEOUT, "unstake-approval-timeout");
        unstakeApprovalTimeout = seconds_;
        emit ConfigUpdated("unstakeApprovalTimeout", seconds_);
    }

    /**
     * @notice 设置**留存线**（wei）：走 owner 审批的那条出金路径打款后 `poolOf(operator)`
     *         不得低于它。`0` = 关闭（默认）。完整的"为什么/不是什么/怎么估"见 `minRetainedStake`。
     *
     * 生效时机是**实时**的（与 `penaltyWindowLocksWithdraw` 同类，与 `PenaltyWindow.cap/end`
     * 那种"开窗时快照"相反，刻意的）：它约束的是**尚未发生的出金**，而每一次出金在审批时
     * 都会重新过一遍 `_revertIfBelowRequiredFloor`。于是调高立刻收紧（正在进行中的 pending 也提不走）、
     * 调低立刻放开——治理的两个方向都要能立刻生效（调低是"救援"：池已经被罚到下限之下时，
     * 只有补质押或调低留存线两条路）。
     *
     * **它管不到哪一条（刻意，见 `minRetainedStake` ③）**：店主不依赖 owner 的有界出口
     * `claimUnstake` 只受在途售后敞口约束。owner 若想连自动放行也不放，正确的动作是把
     * `unstakeApprovalTimeout` 保持 0，而不是用一个金额参数去否决它。
     */
    function setMinRetainedStake(uint256 value) external onlyGovernor {
        minRetainedStake = value;
        emit ConfigUpdated("minRetainedStake", value);
    }

    // 注：2026-10-14 之前这里还有一整段"托管合约（事实源）更换"（proposeEscrow / cancelEscrowChange /
    // applyEscrow / _revertIfArbiterChanges + pendingEscrow 状态 + 三个事件 + 五个错误）。
    // 它已整条删除，理由见 `escrow` 与文件头 ③：那条护栏的判据读的是**候选合约自报**的
    // 候选合约自报的裁决者，因此不可能成立。**不要**以"加一条更严的判据/白名单"的形式把它带回来。

    /**
     * @dev 托管地址探针（**唯一实现，且只剩构造期一个调用点**）：本合约**实际依赖的十个读法**
     *      必须都在（`getOrder` / `sellerOpenExposure` / `sellerClaimExposure` / `claimCase` /
     *      `sellerNetAtSettle` / `afterSaleOpen` / `settledAtBlock` / `afterSaleWindowAtSettle` /
     *      `orderEpoch` / `revokedArbiter`）。
     *
     * 为什么不能只探一两个读法：`penalize` 与出金下限还依赖其余读法。只探一两个函数时，
     * 一个"有那个读法、但没有其余读法"的地址会被写进 `escrow`（storage，构造后无 setter），
     * 此后 `sellerOpenExposure` 的调用直接 revert ⇒ **两条出金路径整体死亡**，而质押钱还在里面。
     * 判据与 Escrow 的形状探针同款：**探的必须是会调用的**。
     *
     * 返回 `IEscrowMinimal` 而不是 `void`：探针的返回值就是那个已被验证过形状的地址，
     * 于是"探过的地址"与"写进事实源的地址"在类型上不可能分叉（调用方拿不到未探过的地址）。
     *
     * `getOrder` 额外要求返回长度**恰好** `ESCROW_ORDER_WORDS` 个字（`!=`，不是下界）：这同时把
     * "订单结构体形状变了、但本合约的 `IEscrowMinimal.Order` 忘了同批改"这种**静默解码错位**
     * 挡在构造期——结构体**增加**字段时多出来的字不会被解码，而最后一个字段会从错位的槽里读出来
     * （下界完全挡不住增字段这一类，而那是最难查的事故）。
     */
    function _probeEscrow(address candidate) internal view returns (IEscrowMinimal) {
        if (candidate.code.length == 0) revert ZeroAddress();
        _probeBool(candidate, abi.encodeWithSignature("afterSaleOpen(bytes32)", bytes32(0)));
        _probeWord(candidate, abi.encodeWithSignature("sellerOpenExposure(address)", address(0)), 1);
        // 提货争议敞口：出金下限读它；缺它则所有出金路径 revert。
        _probeWord(candidate, abi.encodeWithSignature("sellerClaimExposure(address)", address(0)), 1);
        // 提货争议案件：penalizeClaim 读它；缺它则提货赔付整条路径死掉。
        _probeWord(candidate, abi.encodeWithSignature("claimCase(bytes32)", bytes32(0)), 8);
        _probeWord(candidate, abi.encodeWithSignature("sellerNetAtSettle(bytes32)", bytes32(0)), 1);
        // 2026-10-14 随"罚没侧窗口校验"一起加：缺它则 `_afterSaleInWindow` 直接 revert，
        // 而那条判据在 `buyerConfirmed` 的单上必被读到 ⇒ 整条售后救济路径死掉。
        _probeWord(candidate, abi.encodeWithSignature("settledAtBlock(bytes32)", bytes32(0)), 1);
        _probeWord(candidate, abi.encodeWithSignature("afterSaleWindowAtSettle(bytes32)", bytes32(0)), 1);
        _probeWord(candidate, abi.encodeWithSignature("getOrder(bytes32)", bytes32(0)), ESCROW_ORDER_WORDS);
        // 2026-10-18 修 P1 时加：罚没窗口的归属取 `orderEpoch`（该单的裁决届次），不是当前届。
        // 缺它则 `penalize` 直接 revert（selector 不存在）——罚没整条路径在部署后第一次罚就没
        // 发现，所以必须进构造期探针，与其余读法同款。
        _probeWord(candidate, abi.encodeWithSignature("orderEpoch(bytes32)", bytes32(0)), 1);
        // `revokedArbiter`：owner 转移闸与出金锁的提前解除都读它。
        _probeBool(candidate, abi.encodeWithSignature("revokedArbiter(address)", address(0)));
        return IEscrowMinimal(candidate);
    }

    /// @dev 探一个返回 `bool` 的读法（长度不足即视为不兼容）
    function _probeBool(address candidate, bytes memory data) private view {
        (bool ok, bytes memory ret) = candidate.staticcall(data);
        if (!ok || ret.length < 32) revert EscrowProbeFailed();
    }

    /// @dev 探一个返回 N 个字的读法。`words` 是**期望的确切字数**（不是下界）：
    ///      订单结构体若**增加**字段而 `IEscrowMinimal.Order` 忘了同批改，多出来的字不会被解码、
    ///      而最后一个字段会从错位的槽里读出来（静默解码错位）。用 `!=` 才能把这种情况挡在配置期。
    function _probeWord(address candidate, bytes memory data, uint256 words) private view {
        (bool ok, bytes memory ret) = candidate.staticcall(data);
        if (!ok || ret.length != 32 * words) revert EscrowProbeFailed();
    }

    /**
     * @notice 所有权转移的第二道闸：新 owner 可以是当前节点主、也可以是仲裁人；
     *         但不能是墓碑式已吊销仲裁人，也不能是 Staking/Escrow 自身。
     *         本合约不读任何 Registry：跨目录的角色互斥属于节点选人/披露规则。
     *
     * 判在生效点（`acceptOwnership` → `_transferOwnership`），与 Escrow 同一条理由：
     * 提名只是一条待接受记录。构造期 `escrow` 尚未赋值，
     * 这一次是 ownable 初始化，必须放行。事实源读不到（无代码）时**拒绝**，不 fail-open。
     */
    function _transferOwnership(address newOwner) internal override {
        if (newOwner != address(0) && address(escrow) != address(0)) {
            address escrowAddress = address(escrow);
            if (escrowAddress.code.length == 0) revert EscrowUnavailable();
            if (newOwner == address(this) || newOwner == escrowAddress) revert RoleConflict();
            IEscrowOwnerRoles e = IEscrowOwnerRoles(escrowAddress);
            if (e.revokedArbiter(newOwner)) revert RoleConflict();
        }
        super._transferOwnership(newOwner);
    }

    function renounceOwnership() public view override onlyOwner {
        revert GovernanceLocked();
    }

    // ── 委员会票决的罚没（唯一入口 = 本节点 Escrow；链上事实驱动）──

    /**
     * @notice 罚没 operator（== order.seller）的质押并直接补偿 order.buyer。
     * 前置：msg.sender == 本节点 Escrow（委员会票决达到阈值后由 Escrow 调）；**该单不是买家自己确认收货结掉的**（除非买家开过
     * 售后案件**且仍在窗口内**，见下）；订单已 **Settled**（`Refunded` 一律拒绝：全额退款不写售后窗口，
     * 罚没基准本来就是 0，见 `penalize` 里的说明）；operator/buyer 与链上订单一致；每单至多一次。
     *
     * @dev **为什么要有 `buyerConfirmed` 门槛（源码审计 2026-09，P1）**：原先只校验终局状态
     * （Settled/Refunded），而那覆盖了**买家自己点「确认收货」的正常成交**——于是仲裁人
     * （无论善意误判还是密钥被盗）可以对任意一笔历史正常订单罚没卖家质押：无时限、
     * 每单一次、`penaltyCapBps` 可设到 10000（单单 100%）、无逐 operator 累计上限。
     * 本合约的文件头写明罚没场景是「**托管判付 / 超时释放给跑路卖家后**的第二层资金」——
     * 共同点是"钱是在买家没有认可的情况下判给卖家的"。所以门槛就取这一条：
     *   · `voteSettlement` 判卖家 / 卖家胜诉 → 可罚（买家没认可）；
     *   · `releaseExpired` 超时释放 → **可罚**（跑路卖家的主场景，正是本合约存在的理由）；
     *   · `confirmReceipt`（含争议中撤诉放款）→ **不可罚**（买家自己认可了这笔钱）；
     *   · `approveRefund` → **不可罚**：它只能执行"全额"或"买家已授权的金额"，两种都是买家认可的
     *     处置结果（全额退对买家只有好处；授权额是买家点过头的数）。若不排除，同一个仲裁人就能
     *     与买家合谋制造一次"友好和解"、再对卖家质押罚没，罚走超出双方谈拢结果的金额。
     *     取舍：仲裁人失能时，买家于是要在「撤诉放款结束订单」与「继续停在 Disputed 保留罚没资格」
     *     之间选一个——文档与界面都应把这一点说出来，而不是替买家决定（见 ARCHITECTURE §2.4）。
     *   · 全额退款（`Refunded`）→ 状态本身就不在可罚集合里（买家已全额受偿）。
     * 注意：这与"必须曾进入争议"**不是**同一条门槛——那样会把跑路卖家漏在门外。
     *
     * @dev **2026-10 第二批的放宽（"确认收货后发现商品有问题"）**：买家开过**售后案件**
     * （`Escrow.afterSaleOpen(orderId)`）**且该单仍在窗口内**时，`buyerConfirmed` **不再**一票否决——
     * 否则"收到货才发现是假货/少件"在整个机制内没有任何救济。放宽的边界：
     *   · 必须是**买家本人**在链上开的案件，且 Escrow 的入口只接受"买家自己确认收货、
     *     且**从未执行过退款**"的终局单（`openAfterSale` 的收口，见该函数）——所以
     *     "双方谈拢的部分退款和解"**不可能**借这条放宽被重新追罚；
     *   · **窗口是"可追罚期"，它在开案与罚没两处都成立**（2026-10-14 修复，见下面的判据注释）。
     *     窗口长度取该单**创建时**的快照（结算时由 `_writeSettle` 落库，2026-10 第三批），
     *     上限 `Escrow.MAX_AFTER_SALE_WINDOW_BLOCKS` = 360 天、生产默认 180 天，
     *     所以不会退化成"任何历史订单随时可被翻出来追罚"——那正是 P1 修复要防的东西。
     *     **推翻的旧叙述**：此前这里写的是"窗口有硬上限 ⇒ 不会退化"，而当时罚没侧只读
     *     `afterSaleOpen` 这个**活标志**、案件一旦开启永不自动过期（`closeAfterSale` 只有买家或
     *     仲裁人能调，卖家关不掉）⇒ 那句话并不成立（已实测 PoC：陈年案件可被无限期翻出来追罚）。
     *     现在判据补上了窗口，两处（Escrow 开案 / 本函数罚没）同源同式。
     *   · 单笔上限与速率闸照旧生效。
     *   · **本条刻意不受在途售后敞口下限约束**（2026-10 第三批先改成受约束，真链闭环当场推翻）：
     *     敞口下限约束的是**出金**（`approveUnstake` / `claimUnstake`）——
     *     "店主能把自己的钱拿走多少"。罚没不是出金：它是**买家获得补偿的唯一入口**。
     *     把两者绑在一起的后果是实测出来的：演示链上该店 `poolOf=12,500 BTY` 而
     *     `sellerOpenExposure=462,967 BTY`（在途主张远大于质押是**常态**，因为敞口按托管额累计、
     *     而质押是一笔定额），于是 `pool − exposure` 恒为负 ⇒ **罚没在本可罚的单上一笔也执行不了**，
     *     受害买家一分钱拿不到。用"覆盖率"换掉"能不能赔"，把唯一的赔付入口关死了。
     *     现在口径是**罚没优先**：先赔已经判定的受害者；池子被罚到低于敞口是允许的，
     *     因为托管层才是第一赔付层，质押是第二层且本来就可能不够。
     *     代价如实写明：在途主张可能拿不到足额的第二层赔付（这正是"质押只覆盖一部分"的既有事实，
     *     不是本函数造成的）。它同时也是 `sellerOpenExposure` 不收进这里的唯一理由。
     *     另外留存线（`minRetainedStake`）同样**不**约束本函数——那是 owner 的策略性下限，
     *     约束它只会让"补偿买家"被治理参数反噬（见 `testRetainedStakeDoesNotBlockPenalize`）。
     */
    function penalize(bytes32 escrowOrderId, address operator, address buyer, uint256 amountWei, address voter)
        external
        nonReentrant
    {
        /*
          **罚没只能由 Escrow 调用**（2026-10-18）：Escrow 的 `votePenalty` / `voteAfterSale`
          只有在**同一票值达到委员会阈值**时才走到这里。单个仲裁人直接调本函数扣钱，
          会把"多仲裁人 + 阈值"降级成"每把钥匙都能单独罚"，所以授权判据从"某个地址"改成
          "唯一入口"——Escrow 一侧的计票是唯一的门槛，这里不再复制一份。
        */
        if (msg.sender != address(escrow)) revert NotEscrow();
        if (amountWei == 0) revert ZeroAmount();
        if (penalizedOrders[escrowOrderId]) revert OrderAlreadyPenalized();

        IEscrowMinimal.Order memory o = escrow.getOrder(escrowOrderId);
        /*
          罚没资格门槛（2026-10 第二批放宽，2026-10-14 补上窗口的另一半，见本函数注释）：
          买家自己认可过这笔钱 ⇒ 罚没无据——**除非**买家开过售后案件（`afterSaleOpen`）
          **且这笔罚没仍落在那个窗口内**（`_afterSaleInWindow`）。两个条件缺一不可：
            · 只看案件活标志 ⇒ 案件永不自动过期（`closeAfterSale` 只有买家能调，卖家关不掉），
              于是"窗口有硬上限"这句话不成立：一笔陈年确认收货的单只要当年开过案，
              就永远可以被翻出来追罚——正是 P1 修复要防的东西；
            · 只看窗口 ⇒ 买家从没主张过任何异议，罚没无据（门槛被整体抹掉）。
          Escrow 在 `openAfterSale` 里校验窗口（开案那一刻），这里在**使用**那一刻再校验一次：
          两处判据同源同式（`block.number <= settledAtBlock + afterSaleWindowAtSettle`），
          因为"可追罚期"是**同一段时间**——开案在窗口内、罚没也必须在窗口内。
        */
        /*
          只有 `Settled` 可罚。`Refunded`（全额退款）曾经也被接受，但 `_writeSettle` 在
          `amount - refundWei == 0` 时不写 `settledAtBlock`/`afterSaleWindowAtSettle`，
          于是下一行的窗口判据必然先把它拒掉——那条分支从未可达，只是让错误码变成
          `PenaltyWindowElapsed`（2026-10-21 复审删除，与 Escrow.votePenalty 同批）。
          全额退款后买家已全额受偿，罚没基准本来就是 0。
        */
        if (o.status != 3) revert OrderNotSettled(); // Settled
        if (o.seller != operator || o.buyer != buyer) revert PartiesMismatch();
        /*
          **罚没时效：所有终局单都受该单自己的售后窗口约束**（2026-10-20）。
          此前只有 `buyerConfirmed` 的单走 `_afterSaleInWindow`；`buyerConfirmed == false` 的
          `voteSettlement`/`releaseExpired` 单没有时间上限，一笔陈年订单可以被翻出来追罚。
          这里把窗口提到**所有单**上：窗口值来自 `Escrow` 的创建时快照、结算时落库，
          与 `openAfterSale`/罚没侧原本的判据同源同式；`settledAtBlock == 0`/
          `afterSaleWindowAtSettle == 0`（从未判给卖家 / 全额退款）一律 fail-closed。
          代价如实写明：超时释放/仲裁判付的单也只在窗口内可罚；过了窗口，第二层补偿
          只剩线下协商。这与"可追罚期必须有一个终态"是同一条取舍，此前只是漏用了同一窗口。
        */
        if (!_afterSaleInWindow(escrowOrderId)) revert PenaltyWindowElapsed();
        /*
          买家自己认可过这笔钱 ⇒ 罚没无据——**除非**买家开过售后案件（`afterSaleOpen`）。
          窗口已在上一行对所有单校验；这里只保留"是否主张过异议"这一条。
        */
        if (o.buyerConfirmed && !escrow.afterSaleOpen(escrowOrderId)) {
            revert OrderConfirmedByBuyer();
        }

        Position storage p = _positions[operator];
        uint256 pool = p.staked + p.pending;
        uint256 cap = (_penaltyBase(escrowOrderId, o) * penaltyCapBps) / 10000;
        uint256 usedTotal = penalizedByOrderTotal[escrowOrderId];
        if (amountWei > cap || usedTotal + amountWei > cap) revert ExceedsCap();
        if (amountWei > pool) revert InsufficientStake();
        /*
          **这里刻意没有"在途售后敞口下限"这道闸**（2026-10 第三批加了又撤，理由见本函数注释的
          那一段）：罚没是买家获得补偿的唯一入口，而"在途主张远大于质押"是常态 ⇒ 一旦把
          `pool − exposure` 当门槛，罚没会在本可罚的单上恒失败，把唯一赔付入口关死。
          出金下限仍然在 `approveUnstake` / `claimUnstake` 两条**出金**路径上成立。
        */
        /*
          速率闸（源码审计 2026-09 续）：单笔上限之外再加"每窗口累计"上限。
          顺序刻意放在单笔与池校验**之后**：先让调用方看到"这一笔本身就不合规"
          （ExceedsCap / InsufficientStake），再谈"你这个窗口已经用掉多少"——
          否则一个超单笔上限的请求会先报 ExceedsWindowCap，让人误以为改小金额就能过。
        */
        /*
          窗口归属取**该单的裁决届次**（`orderEpoch`）只作留痕/诊断：罚没权属于"裁决这一单的
          那一届"，旧届成员在换届之后仍可能对旧单罚没并新开窗口；但窗口是否锁出金与届次无关
          （2026-10-21 起只看 `revokedArbiter[开窗人]` 或全局开关，见 `withdrawLock`）。
          `voter` 只在该笔罚没**开新窗**时被记为 `penaltyWindowOpener`；同窗口后续罚没不改写它。
        */
        _chargePenaltyWindow(operator, pool, amountWei, escrow.orderEpoch(escrowOrderId), voter);

        /*
          先记下扣账**之前**的 pending（2026-10-14 修复）：下面的幽灵清理必须只在"**这次罚没
          真的把 pending 打到 0**"时发生。旧实现无条件判 `p.pending == 0`，于是**任何**一次与
          pending 无关的罚没（pending 本来就是 0）都会顺手 `delete unstakeRequests[operator]`，
          抹掉 `unstakeState().approved` ——而它的语义是"**最近一批**已获批准"的留痕
          （`approveUnstake` 刻意保留它，见那里的注释），链下按它渲染"已批准"那一态。
          修法：把判据绑到**这次扣账的因果**上（原本有 pending 且被打到 0），而不是"当下的数字
          恰好是 0"——后者把"无事发生"与"被清空"混成同一件事。
        */
        uint256 pendingBefore = p.pending;
        // 先扣 staked，不足扣冷却期 pending（冷却期资金仍属担保池；冻结仅阻止提取不阻止罚没）
        uint256 take = amountWei;
        if (take <= p.staked) {
            p.staked -= take;
        } else {
            take -= p.staked;
            p.staked = 0;
            p.pending -= take;
        }
        /*
          罚没把 pending **扣到 0** 时，必须同步清掉那一批撤资申请（`releaseAt` 与审批记录）：
          否则 `unstakeState` 会报出"pending=0 但 releaseAt≠0、甚至 autoApproveArmed=true"的**幽灵读数**，
          与它自己文档里"releaseAt == 0 = 无在途申请"矛盾——资金层面没有风险（`approveUnstake` /
          `claimUnstake` 都会先报 `NothingPending`），但界面会显示一笔并不存在的"待批申请"。
          条件里的 `pendingBefore > 0` 是这次修复的实质：没有它，一次与 pending 无关的罚没
          也会顺手抹掉"最近一批已获批准"的留痕（见上）。
        */
        if (pendingBefore > 0 && p.pending == 0) {
            p.releaseAt = 0;
            delete unstakeRequests[operator];
        }
        penalizedOrders[escrowOrderId] = true;
        penalizedByOrderTotal[escrowOrderId] = usedTotal + amountWei;
        // 打款失败不 revert 整笔（买家是拒收原生的合约时，旧实现会让这一单**永远罚不了**）：
        // 改为挂账 + 事件，买家自己 `withdrawPayout()` 领取。
        _payoutOrCredit(buyer, amountWei);
        emit PenaltyExecuted(escrowOrderId, operator, buyer, amountWei);
    }

    /**
     * @notice 提货争议赔付：从卖家保证金赔给**提货人**（唯一调用方 = 本节点 Escrow）。
     *
     * 提货人不是原订单买家（NFT 可能已经转手），所以不能复用 `penalize`（它赔给 `o.buyer`）。
     * 赔付基准仍是**原订单**的卖家净额：同一订单的多枚 NFT 提货争议共享
     * `claimPenalizedByOrder[orderId]` 累计上限，不能靠拆成多枚 NFT 绕过。
     * 窗口速率闸、出金锁、挂账逻辑与 `penalize` 完全一致。
     */
    function penalizeClaim(bytes32 claimId, address seller, address claimant, uint256 amountWei, address voter)
        external
        nonReentrant
    {
        if (msg.sender != address(escrow)) revert NotEscrow();
        if (amountWei == 0) revert ZeroAmount();
        if (penalizedClaims[claimId]) revert ClaimAlreadyPenalized();

        IEscrowMinimal.ClaimCase memory c = escrow.claimCase(claimId);
        if (c.openedAt == 0 || c.closed) revert ClaimNotOpen();
        if (c.seller != seller || c.claimant != claimant) revert PartiesMismatch();
        if (amountWei > c.amount) revert ExceedsCap();

        IEscrowMinimal.Order memory o = escrow.getOrder(c.orderId);
        if (o.status != 3) revert OrderNotSettled(); // Settled
        if (o.seller != seller) revert PartiesMismatch();
        // 提货争议也受该单售后窗口约束；否则 owner 可在任意时间开案并追罚卖家。
        if (!_afterSaleInWindow(c.orderId)) revert PenaltyWindowElapsed();

        Position storage p = _positions[seller];
        uint256 pool = p.staked + p.pending;
        uint256 cap = (_penaltyBase(c.orderId, o) * penaltyCapBps) / 10000;
        uint256 usedTotal = penalizedByOrderTotal[c.orderId];
        if (amountWei > cap || usedTotal + amountWei > cap) revert ExceedsCap();
        if (amountWei > pool) revert InsufficientStake();

        _chargePenaltyWindow(seller, pool, amountWei, escrow.orderEpoch(c.orderId), voter);

        uint256 pendingBefore = p.pending;
        uint256 take = amountWei;
        if (take <= p.staked) {
            p.staked -= take;
        } else {
            take -= p.staked;
            p.staked = 0;
            p.pending -= take;
        }
        if (pendingBefore > 0 && p.pending == 0) {
            p.releaseAt = 0;
            delete unstakeRequests[seller];
        }
        penalizedClaims[claimId] = true;
        claimPenalizedByOrder[c.orderId] += amountWei;
        penalizedByOrderTotal[c.orderId] = usedTotal + amountWei;
        _payoutOrCredit(claimant, amountWei);
        emit ClaimPenaltyExecuted(claimId, seller, claimant, amountWei);
    }

    /**
     * @dev **该单是否仍在"可追罚期"内**（唯一实现；罚没侧的那一半门槛，见 `penalize`）。
     *
     * 判据与 `Escrow.openAfterSale` 的窗口校验**逐字同式**：`block.number <= settled + window`，
     * 两者读同一个 `afterSaleWindowAtSettle`（**创建时快照、结算时落库**，2026-10 第三批；
     * 由 Escrow 的 `_writeSettle` 同一处同一条件写入）。两处必须同源同式，否则会出现
     * "能开案却不能罚"（或反过来）这种界面上无从解释的组合。
     *
     * `settled == 0 || window == 0` ⇒ false（fail-closed）：读不到就是"这笔钱从未判给卖家"，
     * 于是"买家已确认收货"的单不可罚——宁可罚不了，也不按一个来路不明的数字放行。
     *
     * 代价如实写明（这是刻意的取舍）：窗口同时约束**开案**与**罚没**，所以在窗口最后一刻开的
     * 案件在链上几乎没有可裁决时间（仲裁人必须在同一窗口内完成罚没），买家那时只能走线下救济。
     * 不这样做的替代方案（案件一开就冻结窗口）等于"案件永不过期"，而那正是本次要修掉的洞。
     */
    function _afterSaleInWindow(bytes32 orderId) internal view returns (bool) {
        uint64 settled = escrow.settledAtBlock(orderId);
        uint64 window = escrow.afterSaleWindowAtSettle(orderId);
        if (settled == 0 || window == 0) return false;
        return block.number <= uint256(settled) + uint256(window);
    }

    /**
     * @dev 全额 gas、失败即 revert 的转账。**只用于收款方自己发起的取款**（`withdrawPayout`）：
     * 那种情况下失败只回滚他自己那一笔，挂账余额原样保留。业务性派发一律走 `_payoutOrCredit`。
     */
    function _sendNative(address to, uint256 value) internal {
        (bool ok, ) = payable(to).call{value: value}("");
        if (!ok) revert TransferFailed();
    }
}
