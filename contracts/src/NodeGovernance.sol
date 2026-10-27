// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title NodeGovernance —— 每节点一个的“owner 提议 + 委员会 2/3 批准”治理合约
 *
 * 设计边界（刻意的）：
 *   · 只治理 Escrow 的委员会名单/窗口参数，以及 Staking 的罚没/冷却/留存参数；
 *   · 不碰卖家的提款审批（approveUnstake/rejectUnstake 仍是 owner），也不碰冻结（freeze 仍是 owner）；
 *   · 唯一例外是**委员会快速解冻**：任一委员可发起，委员会 2/3 通过后立即执行，防止 owner 扣押卖家资金；
 *   · 提案在创建时快照委员会届次（`epoch`）；换届后未执行提案自动失效。
 *
 * 为什么独立成合约：Escrow 已经接近 EIP-170（24,576 B），提案/计票状态机放不进去；
 * Staking 虽然还有空间，但治理放在 Staking 会让“罚没参数”和“谁能改参数”绑在同一个合约上。
 *
 * 权限事实源全部实时读 Escrow（不读任何 Registry）：
 *   · `owner()` = 节点运营方（唯一可提议者）；
 *   · `arbiters()` / `arbiterThreshold()` / `isArbiter` / `revokedArbiter`；
 *   · 当前节点主（owner）可以兼任委员；跨目录的角色互斥属于节点选人/披露规则。
 */
interface IEscrowGovernance {
    function owner() external view returns (address);
    function committeeEpoch() external view returns (uint32);
    function arbiters() external view returns (address[] memory);
    function arbiterThreshold() external view returns (uint16);
    function isArbiter(address who) external view returns (bool);
    function revokedArbiter(address who) external view returns (bool);
}

contract NodeGovernance {
    address public immutable escrow;
    address public immutable staking;

    /// @notice 普通提案的执行延迟：给用户/委员会留出 veto/退出窗口
    uint256 public constant EXECUTION_DELAY = 2 days;

    struct Proposal {
        address target;
        bytes data;
        uint64 createdAt;
        uint32 epoch; // 创建时的 Escrow 委员会届次；换届后提案失效
        uint16 votes;
        bool fast; // 委员会快速解冻：无延迟，且 owner 不能取消
        bool executed;
        bool cancelled;
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public voted;
    /**
     * @dev 投票者名单。`votes` 只是当时的计数器；执行时必须按**当前**委员会重新点数——
     *      吊销一个委员不应让他在吊销前投的票继续生效，而 `committeeEpoch` 不会因单点吊销而改变。
     */
    mapping(uint256 => address[]) private _voters;

    event ProposalCreated(uint256 indexed id, address indexed target, bool fast, bytes data);
    event ProposalVoted(uint256 indexed id, address indexed arbiter, uint16 votes, uint16 required);
    event ProposalExecuted(uint256 indexed id, address indexed target);
    event ProposalCancelled(uint256 indexed id);

    error NotOperator();
    error NotArbiter();
    error InvalidTarget();
    error InvalidSelector();
    error ProposalNotFound();
    error ProposalClosed();
    error AlreadyVoted();
    error EpochChanged();
    error TooEarly();
    error NotEnoughVotes();
    error ExecutionFailed();
    error CannotCancelFast();
    error LastArbiter();

    constructor(address escrow_, address staking_) {
        require(escrow_.code.length > 0 && staking_.code.length > 0, "code");
        escrow = escrow_;
        staking = staking_;
    }

    /* ── 提案 ───────────────────────────────────────────────────────── */

    /// @notice owner 发起普通提案（委员会 2/3 批准 + 2 天延迟后执行）
    function propose(address target, bytes calldata data) external {
        if (msg.sender != IEscrowGovernance(escrow).owner()) revert NotOperator();
        _checkProposal(target, data);
        _create(target, data, false);
    }

    /// @notice 任一委员发起“快速解冻”：2/3 通过后立即执行，owner 不能取消
    function proposeFastUnfreeze(address operator) external {
        if (!isCommitteeMember(msg.sender)) revert NotArbiter();
        bytes memory data = abi.encodeWithSignature("unfreeze(address)", operator);
        _checkProposal(staking, data);
        _create(staking, data, true);
    }

    function _create(address target, bytes memory data, bool fast) private {
        uint256 id = ++proposalCount;
        proposals[id] = Proposal({
            target: target,
            data: data,
            createdAt: uint64(block.timestamp),
            epoch: IEscrowGovernance(escrow).committeeEpoch(),
            votes: 0,
            fast: fast,
            executed: false,
            cancelled: false
        });
        emit ProposalCreated(id, target, fast, data);
    }

    /* ── 投票与执行 ─────────────────────────────────────────────────── */

    function vote(uint256 id) external {
        Proposal storage p = proposals[id];
        if (p.createdAt == 0) revert ProposalNotFound();
        if (p.executed || p.cancelled) revert ProposalClosed();
        if (p.epoch != IEscrowGovernance(escrow).committeeEpoch()) revert EpochChanged();
        if (!isCommitteeMember(msg.sender)) revert NotArbiter();
        if (voted[id][msg.sender]) revert AlreadyVoted();
        voted[id][msg.sender] = true;
        _voters[id].push(msg.sender);
        p.votes += 1;
        emit ProposalVoted(id, msg.sender, p.votes, requiredVotes());
    }

    function execute(uint256 id) external {
        Proposal storage p = proposals[id];
        if (p.createdAt == 0) revert ProposalNotFound();
        if (p.executed || p.cancelled) revert ProposalClosed();
        if (p.epoch != IEscrowGovernance(escrow).committeeEpoch()) revert EpochChanged();
        if (!p.fast && block.timestamp < uint256(p.createdAt) + EXECUTION_DELAY) revert TooEarly();
        /*
          执行前按**当前**委员会重数票：单点 revokeArbiter 不改变 committeeEpoch，旧票不能因为
          "当时投过"就继续算数。名单里被吊销/被移除的投票者在此被跳过。
        */
        address[] storage voters = _voters[id];
        uint16 activeVotes = 0;
        for (uint256 i = 0; i < voters.length; ++i) {
            if (isCommitteeMember(voters[i])) ++activeVotes;
        }
        p.votes = activeVotes;
        uint16 required = requiredVotes();
        if (required == 0 || activeVotes < required) revert NotEnoughVotes();
        if (p.target == escrow && _selector(p.data) == REVOKE_ARBITER) _checkRevokeKeepsQuorum(p.data);
        p.executed = true;
        (bool ok,) = p.target.call(p.data);
        if (!ok) revert ExecutionFailed();
        emit ProposalExecuted(id, p.target);
    }

    function cancel(uint256 id) external {
        if (msg.sender != IEscrowGovernance(escrow).owner()) revert NotOperator();
        Proposal storage p = proposals[id];
        if (p.createdAt == 0) revert ProposalNotFound();
        if (p.executed || p.cancelled) revert ProposalClosed();
        if (p.fast) revert CannotCancelFast();
        p.cancelled = true;
        emit ProposalCancelled(id);
    }

    /* ── 读入口 ─────────────────────────────────────────────────────── */

    /// @notice 通过所需票数 = max(Escrow 阈值, 委员会 2/3 向上取整)，且至少 1 票
    function requiredVotes() public view returns (uint16) {
        uint256 n = IEscrowGovernance(escrow).arbiters().length;
        if (n == 0) return 0;
        uint256 twoThirds = (n * 2 + 2) / 3; // ceil(2n/3)：3→2，4→3，20→14
        uint256 t = IEscrowGovernance(escrow).arbiterThreshold();
        uint256 req = t > twoThirds ? t : twoThirds;
        if (req == 0) req = 1;
        if (req > n) req = n;
        return uint16(req);
    }

    /**
     * @notice 该地址是否可以在本治理合约投票：Escrow 当前届委员且未被吊销。
     *         不读任何 Registry；owner 若在委员会名单里同样可以投票。
     */
    function isCommitteeMember(address who) public view returns (bool) {
        if (who == address(0)) return false;
        IEscrowGovernance e = IEscrowGovernance(escrow);
        if (!e.isArbiter(who) || e.revokedArbiter(who)) return false;
        return true;
    }

    /* ── 内部：selector 白名单 ──────────────────────────────────────── */

    bytes4 private constant SET_ARBITERS = bytes4(keccak256("setArbiters(address[],uint16)"));
    bytes4 private constant REVOKE_ARBITER = bytes4(keccak256("revokeArbiter(address)"));
    bytes4 private constant SET_REJECT_GRACE = bytes4(keccak256("setRejectGraceBlocks(uint64)"));
    bytes4 private constant SET_MIN_TIMEOUT = bytes4(keccak256("setMinTimeoutBlocks(uint64)"));
    bytes4 private constant SET_AFTER_SALE_WINDOW = bytes4(keccak256("setAfterSaleWindowBlocks(uint64)"));

    bytes4 private constant SET_PENALTY_CAP = bytes4(keccak256("setPenaltyCapBps(uint256)"));
    bytes4 private constant SET_PENALTY_WINDOW = bytes4(keccak256("setPenaltyWindow(uint256,uint256)"));
    bytes4 private constant SET_PENALTY_WINDOW_LOCK = bytes4(keccak256("setPenaltyWindowLock(bool)"));
    bytes4 private constant SET_UNLOCK_DELAY = bytes4(keccak256("setUnlockDelay(uint256)"));
    bytes4 private constant SET_UNSTAKE_APPROVAL_TIMEOUT = bytes4(keccak256("setUnstakeApprovalTimeout(uint256)"));
    bytes4 private constant SET_MIN_RETAINED = bytes4(keccak256("setMinRetainedStake(uint256)"));
    bytes4 private constant UNFREEZE = bytes4(keccak256("unfreeze(address)"));

    function _checkProposal(address target, bytes memory data) private view {
        if (target != escrow && target != staking) revert InvalidTarget();
        if (data.length < 4) revert InvalidSelector();
        bytes4 sel = _selector(data);
        if (target == escrow) {
            if (
                sel != SET_ARBITERS && sel != REVOKE_ARBITER && sel != SET_REJECT_GRACE
                    && sel != SET_MIN_TIMEOUT && sel != SET_AFTER_SALE_WINDOW
            ) revert InvalidSelector();
        } else {
            if (
                sel != SET_PENALTY_CAP && sel != SET_PENALTY_WINDOW && sel != SET_PENALTY_WINDOW_LOCK
                    && sel != SET_UNLOCK_DELAY && sel != SET_UNSTAKE_APPROVAL_TIMEOUT && sel != SET_MIN_RETAINED
                    && sel != UNFREEZE
            ) revert InvalidSelector();
        }
    }

    function _selector(bytes memory data) private pure returns (bytes4 s) {
        assembly {
            s := mload(add(data, 32))
        }
    }

    /**
     * @dev 吊销当前届成员前确认剩余活跃委员仍高于 quorum（至少留一人的容错余量）。
     *      3/2 委员会吊销一人会变成 2/2——仍能投票，但再丢一把钥就永久冻结；因此拒绝。
     *      要替换失陷成员应先 setArbiters 换人（保持 3 人），再把旧成员作为非当前届吊销。
     */
    function _checkRevokeKeepsQuorum(bytes memory data) private view {
        address member;
        assembly {
            member := mload(add(data, 36))
        }
        IEscrowGovernance e = IEscrowGovernance(escrow);
        if (!isCommitteeMember(member)) return;
        address[] memory members = e.arbiters();
        uint256 active;
        uint256 current;
        for (uint256 i = 0; i < members.length; ++i) {
            if (isCommitteeMember(members[i])) ++active;
            if (members[i] == member) current = 1;
        }
        if (current == 1 && active - 1 <= uint256(requiredVotes())) revert LastArbiter();
    }
}
