// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ContractCodeHash} from "./ContractCodeHash.sol";

/// @dev EIP-1271：合约账户（多签/Safe/金库）对节点登记签名的标准验签入口
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/**
 * @title MarketplaceRegistry
 * @notice 平台唯一合约：节点目录 + 节点生命周期 + 托管/保证金实现白名单。
 *
 * 平台不碰店铺、商品、订单、资金、费率、员工；这些都在节点自己的库里。
 * 每个节点部署自己的 Escrow（带委员会）与 Staking（保证金），到本合约登记：
 *   · Escrow/Staking 的**全量 runtime 哈希**（`keccak256(address.code)`，含 metadata，见
 *     `ContractCodeHash`）必须命中平台维护的白名单；
 *   · 两个地址都必须是合约且不能相同；
 *   · 一个 Escrow 只能登记给一个节点（_escrowOperator 唯一，**在本目录内**）。
 *
 * 本目录只读 E/S 的 `owner()` 与双向接线：owner 必须等于登记 operator，`Escrow.staking()`
 * 与 `Staking.escrow()` 必须互指（防止“目录主是 A、资金方是 B”的错位）。仍**不校验**
 * 委员会、真实余额或售后/罚没历史，也不为资金方背书——那些由消费者直接读 E/S 核对。
 * 目录的核心停用/恢复/关闭/列表不需要 E/S 部署；登记与 active 读法才会读 owner/接线。
 *
 * 节点合约不依赖本目录：同一个节点可以在多个 Registry 各自登记一行；本目录的停用/永久关闭
 * 只影响本目录的目录行，不影响节点自己的 Escrow/Staking。登记签名绑定本目录地址，
 * 多目录登记时每个目录各签一次，天然防跨目录重放。
 *
 * 每行带一个 30 bit `nodeId`：`keccak256(abi.encode(block.chainid, escrow, staking))` 的高 30 bit，
 * **不含本合约地址**——同一 (chainId, E/S) 在任何目录都得到同一个 ID，`getNodeById` 按它反查。
 * 链上只存整数：可见的 8 位 Crockford 码是**离链** codec 的表示，合约不存字符串、不做 Base32。
 * 它是资金身份的派生值而不是计数器：换 E/S = 换 ID（旧 E/S 的反查随重登记清掉）；注销后重登记
 * 同一 E/S 保留原 ID，所以跨目录引用不会因一次注销而断；同一 E/S 合法转移后重登记仍是同一 ID。
 * 代价是 30 bit 只有 2^-30 量级碰撞：派生为 0 或撞上他人已占用的 ID 时 `NodeIdCollision` 拒绝登记。
 *
 * 平台只做登记与目录治理：节点登记/转移/停用/恢复/永久关闭、封禁已注销 operator、释放已注销行、
 * Escrow/Staking 实现白名单。没有地址封禁、没有店铺/商品/订单/费率/员工/仲裁——那些都在节点自己的库里。
 *
 * 登记签名绑定 (endpoint, escrow, staking, chainId, address(this))，防代注册时被换地址、
 * 防跨链/同字节码部署重放。更新（活跃）只允许改 endpoint；换 escrow/staking 必须先注销再注册。
 */
contract MarketplaceRegistry is Ownable2Step {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    struct NodeInfo {
        address operator; // 节点运营者（目录身份/endpoint 归属人；登记时校验为 E/S 的 owner）
        uint64 nodeId; // 30 bit 派生 ID：keccak256(chainId, escrow, staking) 的高位；跨目录稳定
        address escrow; // 托管合约（节点部署）
        bytes32 escrowCodeHash; // 登记时钉住的全量 runtime 哈希（含 metadata）
        address staking; // 保证金合约（节点部署）
        bytes32 stakingCodeHash; // 登记时钉住的全量 runtime 哈希（含 metadata）
        string endpoint; // 节点 API 根地址
        uint64 registeredAtBlock; // 首次注册区块
        uint64 updatedAtBlock; // 最近更新区块
        bool active; // 是否在册
        bool suspended; // 平台停用（可恢复；从可发现集合剔除）
    }

    /// @notice operator => 节点信息（读入口 getNode / getNodeById 同走 _readNode，active 判据一致）
    mapping(address => NodeInfo) internal nodes;

    /// @notice nodeId => operator（30 bit 派生 ID 的反查表；注销保留、转移改绑、永久关闭/换 E/S 清掉）
    mapping(uint64 => address) private _nodeIdOperator;

    /// @notice endpoint => 当前占用该端点的 operator（唯一性约束）
    mapping(string => address) private _endpointOwner;

    /// @notice 被永久关闭的 operator 墓碑（不可再注册）
    mapping(address => bool) private forceClosedOperator;

    /// @notice 停用原因（suspendNode 写入、unsuspend/deregister/forceClose 清空）
    mapping(address => string) private _suspendedReason;

    /// @notice 被永久关闭行钉住的资金合约墓碑：同一个 Escrow/Staking 换 owner 也不能再回目录
    mapping(address => bool) private forceClosedEscrow;
    mapping(address => bool) private forceClosedStaking;

    /// @notice 可发现 operator 的紧凑数组（getActiveNodes 直接切片）
    address[] private _activeOperators;
    mapping(address => uint256) private _activeIndex;

    /// @notice 当前仍有登记行的 operator 全集（注销/停用保留；永久关闭/转出时移除）
    address[] private _operators;
    mapping(address => uint256) private _operatorIndex; // 0 = 未记录，i+1 = 下标

    /// @notice 单页 operator 上限（避免一次返回无界数组）
    uint256 private constant MAX_OPERATORS_PAGE = 200;

    /// @notice escrow => operator（一个 Escrow 只能属于一个节点；注销/永久关闭时清空）
    mapping(address => address) private _escrowOperator;

    /// @notice staking => operator（一个 Staking 只能属于一个节点；防止复用别人的保证金合约）
    mapping(address => address) private _stakingOperator;

    /// @notice 已审核的 Escrow 实现代码哈希
    mapping(bytes32 => bool) private _approvedEscrowCode;

    /// @notice 已审核的 Staking 实现代码哈希
    mapping(bytes32 => bool) private _approvedStakingCode;

    /// @notice 单页上限（目录是联邦发现层的单点；分页不是"仍可一次拉全"）
    uint256 private constant MAX_ACTIVE_NODES_PAGE = 100;

    event NodeRegistered(
        address indexed operator, string endpoint, address escrow, address staking, uint64 registeredAtBlock
    );
    event NodeUpdated(address indexed operator, string endpoint, uint64 updatedAtBlock);
    event NodeDeregistered(address indexed operator, string endpoint);
    event NodeOperatorUpdated(address indexed previousOperator, address indexed newOperator, string endpoint);
    event NodeSuspended(address indexed operator, string endpoint, string reason);
    event NodeRestored(address indexed operator, string endpoint);
    event NodeForceClosed(address indexed operator, string endpoint, string reason);
    event NodeRegistrationReleased(address indexed operator, uint64 nodeId, string endpoint);
    event EscrowImplementationApproved(bytes32 indexed codeHash, bool approved);
    event StakingImplementationApproved(bytes32 indexed codeHash, bool approved);

    error EndpointEmpty();
    error EndpointTooLong();
    error EndpointNotNormalized();
    error EndpointTaken();
    error PageTooLarge();
    error NodeNotRegistered();
    error BadSignature();
    error OnlyOperator();
    error SuspendedNode();
    error OperatorForceClosed();
    error GovernanceLocked();
    error ZeroHash();
    error ImplementationNotApproved();
    error EscrowNotBound();
    error EscrowAlreadyRegistered();
    error StakingNotBound();
    error StakingAlreadyRegistered();
    error EscrowImmutable();
    error RoleConflict();
    error OperatorMismatch();
    error NodeIdCollision();
    error NodeNotDeregistered();

    constructor(address initialOwner, bytes32 initialEscrowCodeHash, bytes32 initialStakingCodeHash)
        Ownable(initialOwner)
    {
        if (initialEscrowCodeHash == bytes32(0) || initialStakingCodeHash == bytes32(0)) revert ZeroHash();
        _approvedEscrowCode[initialEscrowCodeHash] = true;
        _approvedStakingCode[initialStakingCodeHash] = true;
        emit EscrowImplementationApproved(initialEscrowCodeHash, true);
        emit StakingImplementationApproved(initialStakingCodeHash, true);
    }

    /// @notice 治理权限不可放弃（owner 保留停用/永久关闭与白名单能力；owner 本就无法动用任何资金）
    function renounceOwnership() public view override onlyOwner {
        revert GovernanceLocked();
    }

    /* ── 节点登记 ───────────────────────────────────────────────────── */

    /**
     * @notice 注册节点 / 更新 endpoint / 注销后重新激活。
     * @dev 行的 nodeId 由 (chainId, escrow, staking) 派生：首次登记与注销后重登记时写入；
     *      重登记同一 E/S 保留原 ID，换 E/S 得到新 ID 并清掉旧 ID 的反查。
     * @param operator 目录身份/endpoint 归属人；登记时要求等于 Escrow/Staking 的 owner
     * @param endpoint 节点 API 根地址
     * @param escrow 节点部署的托管合约（命中 Escrow 白名单）
     * @param staking 节点部署的保证金合约（命中 Staking 白名单）
     * @param signature operator 对 (endpoint, escrow, staking, chainId, 本合约) 的 EIP-191 签名
     */
    function registerNode(
        address operator,
        string calldata endpoint,
        address escrow,
        address staking,
        bytes calldata signature
    ) external {
        _checkRegisterSig(operator, endpoint, escrow, staking, signature);
        if (forceClosedOperator[operator]) revert OperatorForceClosed();
        if (forceClosedEscrow[escrow] || forceClosedStaking[staking]) revert OperatorForceClosed();

        NodeInfo storage n = nodes[operator];
        bool isNew = n.registeredAtBlock == 0;
        bool isReactive = !isNew && !n.active;
        if (isReactive && n.suspended) revert SuspendedNode();

        if (isNew || isReactive) {
            // 注销后重新激活必须 operator 本人发交易；首次注册可代付（签名已绑定新地址）。
            if (!isNew && msg.sender != operator) revert OnlyOperator();
            _checkBinding(operator, escrow, staking);

            uint64 nodeId = _deriveNodeId(escrow, staking);
            address idOwner = _nodeIdOperator[nodeId];
            // 碰撞与“同一 E/S 已被另一行占用”都不可表达：一个 ID 只能解析回一行。
            if (idOwner != address(0) && idOwner != operator) revert NodeIdCollision();
            // 重登记换了 E/S：旧 E/S 的 ID 反查必须随这次登记失效，否则旧 URL 仍能读到本行。
            if (isReactive && n.nodeId != 0 && n.nodeId != nodeId) {
                if (_nodeIdOperator[n.nodeId] == operator) delete _nodeIdOperator[n.nodeId];
            }
            n.nodeId = nodeId;
            _nodeIdOperator[nodeId] = operator;

            _takeEndpoint(operator, endpoint, n.endpoint);

            n.operator = operator;
            n.escrow = escrow;
            n.escrowCodeHash = ContractCodeHash.forAddress(escrow);
            n.staking = staking;
            n.stakingCodeHash = ContractCodeHash.forAddress(staking);
            n.endpoint = endpoint;
            n.registeredAtBlock = isNew ? uint64(block.number) : n.registeredAtBlock;
            n.updatedAtBlock = uint64(block.number);
            n.active = true;
            delete _suspendedReason[operator];
            _rememberOperator(operator);
            _addActive(operator);
            emit NodeRegistered(operator, endpoint, escrow, staking, n.registeredAtBlock);
        } else {
            // 活跃更新：只允许 operator 本人改 endpoint；escrow/staking 是资金身份，不能原地换
            if (msg.sender != operator) revert OnlyOperator();
            if (n.suspended) revert SuspendedNode();
            if (escrow != n.escrow || staking != n.staking) revert EscrowImmutable();
            // E/S 不可变 ⇒ ID 不可变；仍按同一派生式核一次，保证行内 ID 与资金身份只有一份真相。
            if (n.nodeId != _deriveNodeId(escrow, staking)) revert NodeIdCollision();
            // owner 已转移的旧行不再代表当前 operator；要求先转移登记身份。
            if (!_ownedBy(n.escrow, operator) || !_ownedBy(n.staking, operator)) revert OperatorMismatch();
            if (keccak256(bytes(n.endpoint)) != keccak256(bytes(endpoint))) {
                _takeEndpoint(operator, endpoint, n.endpoint);
                n.endpoint = endpoint;
            }
            n.updatedAtBlock = uint64(block.number);
            emit NodeUpdated(operator, endpoint, n.updatedAtBlock);
        }
    }

    /// @notice 注销节点。仅 operator 本人可调；行保留，重新登记沿用原 endpoint 规则。
    function deregisterNode() external {
        NodeInfo storage n = nodes[msg.sender];
        if (n.registeredAtBlock == 0 || !n.active) revert NodeNotRegistered();
        /*
          被停用的节点**不能自己注销**：`suspendNode` 只置 `suspended`、不动 `active`，
          而注销会把 `suspended` 清成 false——两者相加就是一条"停用 → 自己注销 → 重新登记"
          的解除路径，平台唯一的可逆处置手段当场失效。解除停用只能由平台走 `unsuspendNode`。
        */
        if (n.suspended) revert SuspendedNode();

        if (_endpointOwner[n.endpoint] == msg.sender) delete _endpointOwner[n.endpoint];
        if (_escrowOperator[n.escrow] == msg.sender) delete _escrowOperator[n.escrow];
        if (_stakingOperator[n.staking] == msg.sender) delete _stakingOperator[n.staking];
        // nodeId 反查**不删**：注销后的行仍要能从旧 ID 读到（inactive 行），重登记同一 E/S 也沿用它。
        n.active = false;
        /*
          注销后清掉 suspended：走到这里它必然为 false（上面已拒绝 isSuspended）；这行保留
          是为了让"active=false + suspended=true"这个不可表达态在代码里没有第二个来源。
        */
        n.suspended = false;
        delete _suspendedReason[msg.sender];
        n.updatedAtBlock = uint64(block.number);
        _removeActive(msg.sender);
        emit NodeDeregistered(msg.sender, n.endpoint);
    }

    /**
     * @notice 旧 operator 发起目录身份转移，新 operator 用签名接受。
     *
     * 本目录读取节点合约的 `owner()`（只读）来要求“E/S owner = 新 operator”；
     * 转移还要求：
     *   · `msg.sender` 是当前行 operator；
     *   · `newOperator` 对绑定本 Registry/chainId/地址/endpoint 的消息签名。
     * 这不等于为资金方背书：委员会、余额与资金事实仍由消费者核对。
     *
     * 迁移只发生在**在册且未停用**的行；停用中的节点先由平台恢复，避免借转移绕过停用。
     */
    function transferRegistration(address newOperator, bytes calldata newSignature) external {
        address previousOperator = msg.sender;
        if (newOperator == address(0) || newOperator == previousOperator) revert OperatorMismatch();
        if (forceClosedOperator[newOperator]) revert OperatorForceClosed();
        if (nodes[newOperator].registeredAtBlock != 0) revert OperatorMismatch();

        NodeInfo storage old = nodes[previousOperator];
        if (old.registeredAtBlock == 0 || !old.active || old.suspended) revert NodeNotRegistered();
        if (forceClosedEscrow[old.escrow] || forceClosedStaking[old.staking]) revert OperatorForceClosed();
        if (old.operator != previousOperator) revert OperatorMismatch();
        if (_escrowOperator[old.escrow] != previousOperator) revert EscrowAlreadyRegistered();
        if (_endpointOwner[old.endpoint] != previousOperator) revert EndpointTaken();

        bytes32 inner = keccak256(
            abi.encode(
                "transferRegistration", previousOperator, newOperator, old.escrow, old.staking, old.endpoint, block.chainid, address(this)
            )
        );
        if (!_isValidSignature(newOperator, inner, inner.toEthSignedMessageHash(), newSignature)) revert BadSignature();
        // 目录身份转移前，E/S 的 Ownable 必须先交给新 operator（否则“目录主”与“资金方”错位）。
        if (!_ownedBy(old.escrow, newOperator) || !_ownedBy(old.staking, newOperator)) revert OperatorMismatch();

        NodeInfo memory moved = old;
        moved.operator = newOperator;
        moved.updatedAtBlock = uint64(block.number);
        delete nodes[previousOperator];
        nodes[newOperator] = moved;
        delete _suspendedReason[previousOperator];
        delete _suspendedReason[newOperator];
        _forgetOperator(previousOperator);
        _rememberOperator(newOperator);

        _nodeIdOperator[moved.nodeId] = newOperator;
        _escrowOperator[moved.escrow] = newOperator;
        _stakingOperator[moved.staking] = newOperator;
        _endpointOwner[moved.endpoint] = newOperator;
        _removeActive(previousOperator);
        _addActive(newOperator);
        emit NodeOperatorUpdated(previousOperator, newOperator, moved.endpoint);
    }

    /* ── 平台治理：停用 / 恢复 / 永久关闭 ─────────────────────────────── */

    function suspendNode(address operator, string calldata reason) external onlyOwner {
        NodeInfo storage n = nodes[operator];
        if (n.registeredAtBlock == 0 || !n.active || n.suspended) revert NodeNotRegistered();
        n.suspended = true;
        n.updatedAtBlock = uint64(block.number);
        _suspendedReason[operator] = reason;
        _removeActive(operator);
        emit NodeSuspended(operator, n.endpoint, reason);
    }

    function unsuspendNode(address operator) external onlyOwner {
        NodeInfo storage n = nodes[operator];
        if (n.registeredAtBlock == 0 || !n.suspended) revert NodeNotRegistered();
        n.suspended = false;
        n.updatedAtBlock = uint64(block.number);
        delete _suspendedReason[operator];
        if (n.active) _addActive(operator);
        emit NodeRestored(operator, n.endpoint);
    }

    /// @notice 永久关闭在册节点（墓碑：不可再注册；不可撤销）
    function forceCloseNode(address operator, string calldata reason) external onlyOwner {
        if (!nodes[operator].active) revert NodeNotRegistered();
        _forceClose(operator, reason);
    }

    /// @notice 永久关闭一个已注销的 operator（后果与 forceCloseNode 相同）
    /// @dev 若该行登记的 E/S 仍归此 operator，_forceClose 会把 E/S 一并永久墓碑；要让接盘方复用
    ///      这组 E/S，必须先转移 E/S 所有权、再调用本函数（治理确认层也写明这个顺序）。
    function banDeregisteredOperator(address operator, string calldata reason) external onlyOwner {
        // 已注销：行还在（registeredAtBlock != 0）、active=false；墓碑/从未注册都没有行。
        if (nodes[operator].registeredAtBlock == 0 || nodes[operator].active) revert NodeNotRegistered();
        _forceClose(operator, reason);
    }

    /**
     * @notice 释放一个**已注销**的登记行：删除行并清掉 nodeId / endpoint / E/S 占用，
     *         但**不**永久封禁该运营方、**不**把 E/S 写进墓碑。
     * @dev 用于“节点栈转让”：旧运营方已注销、E/S 已转给接盘方，但旧行的 nodeId 还占着反查时，
     *      平台用它释放 ID，让接盘方能用同一组 E/S 重新登记并复用同一 nodeCode。
     *      只接受 storage.active=false 的已注销行；在册/停用/永久关闭行拒绝。
     *      释放后旧运营方仍可重新登记（forceClosedOperator 不会被写入）；要永久封禁请走 ban。
     */
    function releaseDeregisteredRow(address operator) external onlyOwner {
        NodeInfo storage n = nodes[operator];
        if (n.registeredAtBlock == 0 || n.active) revert NodeNotDeregistered();
        uint64 nodeId = n.nodeId;
        string memory endpoint = n.endpoint;
        address escrow = n.escrow;
        address staking = n.staking;
        if (_endpointOwner[endpoint] == operator) delete _endpointOwner[endpoint];
        if (escrow != address(0) && _escrowOperator[escrow] == operator) delete _escrowOperator[escrow];
        if (staking != address(0) && _stakingOperator[staking] == operator) delete _stakingOperator[staking];
        _removeActive(operator);
        delete nodes[operator];
        // 只删仍指回本 operator 的反查：转移后的映射已经改绑到新行，不能误删。
        if (nodeId != 0 && _nodeIdOperator[nodeId] == operator) delete _nodeIdOperator[nodeId];
        delete _suspendedReason[operator];
        _forgetOperator(operator);
        emit NodeRegistrationReleased(operator, nodeId, endpoint);
    }

    function _forceClose(address operator, string calldata reason) private {
        if (forceClosedOperator[operator]) revert OperatorForceClosed();
        NodeInfo storage n = nodes[operator];
        string memory endpoint = n.endpoint;
        address escrow = n.escrow;
        address staking = n.staking;
        uint64 nodeId = n.nodeId;
        if (_endpointOwner[endpoint] == operator) delete _endpointOwner[endpoint];
        if (escrow != address(0) && _escrowOperator[escrow] == operator) delete _escrowOperator[escrow];
        if (staking != address(0) && _stakingOperator[staking] == operator) delete _stakingOperator[staking];
        _removeActive(operator);
        delete nodes[operator];
        // 墓碑行没有可读的 ID：反查一并清掉；只在仍指回本 operator 时删（转移后映射已改绑新行）。
        if (nodeId != 0 && _nodeIdOperator[nodeId] == operator) delete _nodeIdOperator[nodeId];
        delete _suspendedReason[operator];
        _forgetOperator(operator);
        forceClosedOperator[operator] = true;
        /*
          只有**仍归本 operator 绑定**的资金合约才进墓碑。已注销的 operator 可能已经
          把同一个 Escrow/Staking 转移给新 owner 并完成新登记；此时 tombstone 会把
          新节点正在用的资金合约一起封死（对已注销 operator 的 ban 不能穿透到新行）。
        */
        if (
            escrow != address(0)
                && (_escrowOperator[escrow] == address(0) || _escrowOperator[escrow] == operator)
                && _ownedBy(escrow, operator)
        ) {
            forceClosedEscrow[escrow] = true;
        }
        if (
            staking != address(0)
                && (_stakingOperator[staking] == address(0) || _stakingOperator[staking] == operator)
                && _ownedBy(staking, operator)
        ) {
            forceClosedStaking[staking] = true;
        }
        emit NodeForceClosed(operator, endpoint, reason);
    }

    /// @notice 批准/撤销一种 Escrow 实现；`codeHash` 用 `ContractCodeHash.forAddress(实现地址)`
    function approveEscrowImplementation(bytes32 codeHash, bool approved) external onlyOwner {
        if (codeHash == bytes32(0)) revert ZeroHash();
        _approvedEscrowCode[codeHash] = approved;
        emit EscrowImplementationApproved(codeHash, approved);
    }

    /// @notice 批准/撤销一种 Staking 实现；`codeHash` 用 `ContractCodeHash.forAddress(实现地址)`
    function approveStakingImplementation(bytes32 codeHash, bool approved) external onlyOwner {
        if (codeHash == bytes32(0)) revert ZeroHash();
        _approvedStakingCode[codeHash] = approved;
        emit StakingImplementationApproved(codeHash, approved);
    }

    /* ── 读入口 ─────────────────────────────────────────────────────── */

    /// @notice operator => 节点信息（active 掩码在唯一读出口 `_readNode` 里做）
    function getNode(address operator) external view returns (NodeInfo memory) {
        return _readNode(operator);
    }

    /// @notice 30 bit nodeId => 节点信息；未登记、已永久关闭、已释放或换 E/S 前的旧 ID 返回全零结构
    function getNodeById(uint64 id) external view returns (NodeInfo memory) {
        return _readNode(_nodeIdOperator[id]);
    }

    /// @notice 当前仍有登记行的 operator 总数（注销/停用保留；永久关闭/转出已移除）
    function operatorCount() external view returns (uint256) {
        return _operators.length;
    }

    /**
     * @notice operator 全集的一页（只返回地址，不拷贝 NodeInfo 结构体/字符串）
     * @dev 这是给治理台枚举历史行用的；当前 active 状态仍以 `getNode` 为准。
     */
    function operators(uint256 from, uint256 count) external view returns (address[] memory result) {
        if (count > MAX_OPERATORS_PAGE) revert PageTooLarge();
        uint256 len = _operators.length;
        if (from >= len || count == 0) return new address[](0);
        uint256 take = len - from;
        if (take > count) take = count;
        result = new address[](take);
        for (uint256 i = 0; i < take; ++i) {
            result[i] = _operators[from + i];
        }
    }

    /// @notice 最近一次治理停用的原因（未停用/已恢复为空串）
    function suspendedReasonOf(address operator) external view returns (string memory) {
        return _suspendedReason[operator];
    }

    /// @notice 活跃节点列表的一页（offset 是在可发现集合里的下标；单页最多 100 条）
    function getActiveNodes(uint256 offset, uint256 limit) external view returns (NodeInfo[] memory result) {
        if (limit > MAX_ACTIVE_NODES_PAGE) revert PageTooLarge();
        uint256 len = _activeOperators.length;
        if (offset >= len || limit == 0) return new NodeInfo[](0);
        uint256 take = len - offset;
        if (take > limit) take = limit;
        result = new NodeInfo[](take);
        for (uint256 i = 0; i < take; ++i) {
            // 白名单撤销或资金方 owner 变更后不再把该行当作 active 下发（分页下标保持不变）。
            result[i] = _readNode(_activeOperators[offset + i]);
        }
    }

    /// @notice Escrow => 节点主（注销/永久关闭后清空；用于前端反查与审计）
    function escrowOperator(address escrow) external view returns (address) {
        return _escrowOperator[escrow];
    }

    /// @notice 节点在册且未被停用（目录读法；节点合约不依赖本 Registry）
    function isNodeActive(address operator) public view returns (bool) {
        return _nodeActiveNow(nodes[operator]);
    }

    /// @dev 唯一 active 判据：在册 + 未停用 + 代码仍白名单 + owner 仍是 operator + E/S 双向接线。
    function _nodeActiveNow(NodeInfo memory n) private view returns (bool) {
        if (n.registeredAtBlock == 0 || !n.active || n.suspended) return false;
        return _codeStillApproved(n)
            && _ownedBy(n.escrow, n.operator)
            && _ownedBy(n.staking, n.operator)
            && _mutuallyBound(n.escrow, n.staking);
    }

    /// @notice 该地址是否仍持有节点主身份（在册或停用未清除）
    function isNodeOperator(address who) public view returns (bool) {
        NodeInfo storage n = nodes[who];
        return n.registeredAtBlock != 0 && (n.active || n.suspended);
    }

    function isForceClosed(address who) external view returns (bool) {
        return forceClosedOperator[who];
    }

    function isApprovedEscrowImplementation(bytes32 codeHash) external view returns (bool) {
        return _approvedEscrowCode[codeHash];
    }

    function isApprovedStakingImplementation(bytes32 codeHash) external view returns (bool) {
        return _approvedStakingCode[codeHash];
    }

    /* ── 内部实现 ───────────────────────────────────────────────────── */

    /**
     * @dev 唯一的行读出口：返回前把“已不算 active”的行掩成 active=false
     *      （白名单撤销/资金方 owner 变更后存储里的 active 仍是 true）。
     *      getNode / getNodeById / getActiveNodes 都必须走这里，active 判据只在 `_nodeActiveNow` 一处。
     */
    function _readNode(address operator) private view returns (NodeInfo memory n) {
        n = nodes[operator];
        if (n.active && !_nodeActiveNow(n)) n.active = false;
    }

    /**
     * @dev 30 bit nodeId 的唯一派生式：只吃 (chainId, escrow, staking)，**不含本合约地址**——
     *      同一节点栈在多个 Registry 得到同一个 ID，消费端才能按 ID 而不是 operator 跨目录引用。
     *      取 keccak 高 30 bit（>> 226）压进 uint64；0 保留给“无此行”的零结构，派生为 0 拒绝登记，
     *      否则 `getNodeById(0)` 会假装存在一行。它是派生值不是计数器：不维护“分配后永不复用”的表。
     *      代价：30 bit 只有 2^-30 量级碰撞，撞上已占用 ID 时拒绝登记（而不是覆盖别人的行）。
     */
    function _deriveNodeId(address escrow, address staking) private view returns (uint64 id) {
        id = uint64(uint256(keccak256(abi.encode(block.chainid, escrow, staking))) >> 226); // 高 30 bit
        if (id == 0) revert NodeIdCollision();
    }

    /// @dev 登记行只有在“当前地址代码仍被本目录白名单认可”时才算 active
    function _codeStillApproved(NodeInfo memory n) private view returns (bool) {
        return _approvedEscrowCode[ContractCodeHash.forAddress(n.escrow)]
            && _approvedStakingCode[ContractCodeHash.forAddress(n.staking)];
    }

    /**
     * @dev 地址、合约哈希、唯一占用、**E/S owner == operator** 与双向接线。
     *
     * `owner()`/`staking()`/`escrow()` 都是**只读**检查，用于阻止“目录主是 A、资金方是 B”
     * 或“Escrow 指向另一套 Staking”的错位；它不代表 Registry 为资金方背书：委员会、
     * 余额与真实资金事实仍由消费者核对。登记与 active 读法才读这些值，停用/恢复/关闭/列表不依赖 E/S 部署。
     */
    function _checkBinding(address operator, address escrow, address staking) private {
        if (escrow == address(0) || escrow.code.length == 0) revert EscrowNotBound();
        if (staking == address(0) || staking.code.length == 0) revert StakingNotBound();
        if (escrow == staking) revert StakingNotBound();
        if (!_approvedEscrowCode[ContractCodeHash.forAddress(escrow)]) revert ImplementationNotApproved();
        if (!_approvedStakingCode[ContractCodeHash.forAddress(staking)]) revert ImplementationNotApproved();

        address current = _escrowOperator[escrow];
        if (current != address(0) && current != operator) revert EscrowAlreadyRegistered();
        address stakingOwner = _stakingOperator[staking];
        if (stakingOwner != address(0) && stakingOwner != operator) revert StakingAlreadyRegistered();
        if (!_ownedBy(escrow, operator)) revert EscrowNotBound();
        if (!_ownedBy(staking, operator)) revert StakingNotBound();
        if (!_mutuallyBound(escrow, staking)) revert StakingNotBound();

        _escrowOperator[escrow] = operator;
        _stakingOperator[staking] = operator;
    }

    /// @dev Escrow.staking 与 Staking.escrow 必须互相指回；任一读不到即不匹配。
    function _mutuallyBound(address escrow, address staking) private view returns (bool) {
        (bool ok1, bytes memory ret1) = escrow.staticcall(abi.encodeWithSignature("staking()"));
        if (!ok1 || ret1.length < 32 || abi.decode(ret1, (address)) != staking) return false;
        (bool ok2, bytes memory ret2) = staking.staticcall(abi.encodeWithSignature("escrow()"));
        return ok2 && ret2.length >= 32 && abi.decode(ret2, (address)) == escrow;
    }

    /// @dev E/S 的 Ownable owner 是否等于目录 operator（只读；读不到即不匹配）。
    function _ownedBy(address target, address operator) private view returns (bool) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("owner()"));
        return ok && ret.length >= 32 && abi.decode(ret, (address)) == operator;
    }

    /// @dev 让 operator 占用新 endpoint：释放旧占用、校验非空/长度/规范形/未被他人占用
    function _takeEndpoint(address operator, string memory newEndpoint, string memory oldEndpoint) private {
        uint256 len = bytes(newEndpoint).length;
        if (len == 0) revert EndpointEmpty();
        if (len > 255) revert EndpointTooLong();
        if (!_isCanonicalEndpointForm(newEndpoint)) revert EndpointNotNormalized();

        if (bytes(oldEndpoint).length > 0 && _endpointOwner[oldEndpoint] == operator) {
            delete _endpointOwner[oldEndpoint];
        }
        address current = _endpointOwner[newEndpoint];
        if (current != address(0) && current != operator) revert EndpointTaken();
        _endpointOwner[newEndpoint] = operator;
    }

    /**
     * @dev endpoint 只接受**可公开解析的 HTTPS 域名根**（可带路径，如 `https://node.example.com/api`）：
     *      · 必须是 `https://`（HTTP 明文、IP、localhost、端口、查询串都不接受）；
     *      · host 至少两段域名标签，标签只含小写字母/数字/连字符，且不以连字符开头或结尾；
     *      · 全数字 host（IPv4）拒绝；路径可含大小写与常见 URL 字符，但不能带 `?`/`#`/反斜杠或尾斜杠。
     *      这样消费端拿到的 endpoint 直接就是可访问的根地址，不需要再猜 scheme/端口。
     */
    function _isCanonicalEndpointForm(string memory s) private pure returns (bool) {
        bytes memory b = bytes(s);
        if (b.length < 11) return false; // https:// + 至少 a.b
        if (
            !(b[0] == 0x68 && b[1] == 0x74 && b[2] == 0x74 && b[3] == 0x70 && b[4] == 0x73 && b[5] == 0x3A
                && b[6] == 0x2F && b[7] == 0x2F)
        ) return false;

        // 先切出 host（第一个 `/` 之前）；后面可以带路径，但不能带查询/fragment/端口。
        uint256 hostEnd = b.length;
        for (uint256 i = 8; i < b.length; i++) {
            if (b[i] == 0x2F) {
                hostEnd = i;
                break;
            }
        }
        if (hostEnd == 8) return false;
        if (hostEnd < b.length) {
            if (b.length == hostEnd + 1 || b[b.length - 1] == 0x2F) return false;
            /*
              路径唯一性必须按**规范化后**的段判断：`https://a.example/..` 与
              `https://a.example` 在客户端解析到同一个 origin，但原始字符串不同。
              这里拒绝 `.`/`..`，并拒绝路径中的任何 `%`——不做 percent-decoding，
              `%2e`、`%61` 这类写法在不同客户端可能解析成同一资源，目录唯一性不能建立
              在“两种写法恰好都没被用过”上。
            */
            uint256 segStart = hostEnd + 1;
            for (uint256 i = hostEnd + 1; i <= b.length; i++) {
                if (i < b.length && b[i] != 0x2F) {
                    uint8 pc = uint8(b[i]);
                    if (pc < 0x21 || pc > 0x7E || pc == 0x3F || pc == 0x23 || pc == 0x5C) return false;
                    // 路径不做 percent-decoding：`%61` 与 `a` 在浏览器里可能指向同一资源，
                    // 目录唯一性不能建立在“两种写法恰好都没被用过”上。API 根路径不需要编码。
                    if (pc == 0x25) return false;
                    continue;
                }
                uint256 len = i - segStart;
                // 空段（`a//b`）在不同 URL 解析器里可能被折叠成同一路径；API 根不需要它。
                if (len == 0) return false;
                if (len == 1 && b[segStart] == 0x2E) return false;
                if (len == 2 && b[segStart] == 0x2E && b[segStart + 1] == 0x2E) return false;
                segStart = i + 1;
            }
        }

        uint256 labelLen;
        uint256 labels;
        bool hyphenAtEnd;
        for (uint256 i = 8; i < hostEnd; i++) {
            uint8 c = uint8(b[i]);
            if (c == 0x2E) {
                if (labelLen == 0 || hyphenAtEnd) return false;
                labels++;
                labelLen = 0;
                hyphenAtEnd = false;
                continue;
            }
            // host 里不允许端口 / IPv6 括号 / userinfo
            if (c == 0x3A || c == 0x5B || c == 0x5D || c == 0x40) return false;
            bool digit = c >= 0x30 && c <= 0x39;
            bool lower = c >= 0x61 && c <= 0x7A;
            bool hyphen = c == 0x2D;
            if (!digit && !lower && !hyphen) return false;
            if (hyphen && labelLen == 0) return false;
            labelLen++;
            if (labelLen > 63) return false;
            hyphenAtEnd = hyphen;
        }
        if (labelLen == 0 || hyphenAtEnd) return false;
        labels++;
        if (labels < 2) return false;
        if (_isIpLikeHost(b, hostEnd)) return false; // IPv4（含 0x/纯数字缩写）
        return true;
    }

    /// @dev host 的每一段都是十进制数字或 0x 十六进制 ⇒ 这是 IP，而不是域名
    function _isIpLikeHost(bytes memory b, uint256 hostEnd) private pure returns (bool) {
        uint256 start = 8;
        for (uint256 i = 8; i <= hostEnd; i++) {
            if (i < hostEnd && b[i] != 0x2E) continue;
            if (i == start) return false;
            uint256 j = start;
            if (i - start >= 3 && b[j] == 0x30 && (b[j + 1] == 0x78 || b[j + 1] == 0x58)) {
                j += 2;
                if (j == i) return false;
                for (; j < i; j++) {
                    uint8 h = uint8(b[j]);
                    if (!((h >= 0x30 && h <= 0x39) || (h >= 0x61 && h <= 0x66))) return false;
                }
            } else {
                for (; j < i; j++) {
                    if (b[j] < 0x30 || b[j] > 0x39) return false;
                }
            }
            start = i + 1;
        }
        return true;
    }

    function _addActive(address operator) private {
        if (_activeIndex[operator] != 0) return;
        _activeIndex[operator] = _activeOperators.length + 1;
        _activeOperators.push(operator);
    }

    /// @dev 追加进 operator 枚举；重复登记/转移回旧地址不产生重复项
    function _rememberOperator(address operator) private {
        if (_operatorIndex[operator] != 0) return;
        _operators.push(operator);
        _operatorIndex[operator] = _operators.length;
    }

    /// @dev 从枚举移除（swap-pop）；用于永久关闭/转出/释放注销行后已删除登记行的地址
    function _forgetOperator(address operator) private {
        uint256 idx = _operatorIndex[operator];
        if (idx == 0) return;
        uint256 last = _operators.length - 1;
        address lastOp = _operators[last];
        _operators[idx - 1] = lastOp;
        _operatorIndex[lastOp] = idx;
        _operators.pop();
        delete _operatorIndex[operator];
    }

    function _removeActive(address operator) private {
        uint256 idx = _activeIndex[operator];
        if (idx == 0) return;
        uint256 last = _activeOperators.length - 1;
        address lastOp = _activeOperators[last];
        _activeOperators[idx - 1] = lastOp;
        _activeIndex[lastOp] = idx;
        _activeOperators.pop();
        delete _activeIndex[operator];
    }

    /// @dev 登记签名：EIP-191 personal_sign；EOA 走 ECDSA，合约账户走 EIP-1271（含 Safe legacy 重载）
    function _checkRegisterSig(
        address operator,
        string calldata endpoint,
        address escrow,
        address staking,
        bytes calldata signature
    ) private view {
        if (operator == address(0) || signature.length == 0) revert BadSignature();
        bytes32 inner =
            keccak256(abi.encode(endpoint, escrow, staking, block.chainid, address(this)));
        if (!_isValidSignature(operator, inner, inner.toEthSignedMessageHash(), signature)) {
            revert BadSignature();
        }
    }

    function _isValidSignature(address signer, bytes32 inner, bytes32 digest, bytes calldata signature)
        private
        view
        returns (bool)
    {
        if (signer == address(0)) return false;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;
        if (signer.code.length == 0) return false;

        // 标准 EIP-1271
        (bool ok, bytes memory ret) =
            signer.staticcall(abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, signature));
        if (ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == 0x1626ba7e) return true;

        // Safe CompatibilityFallbackHandler（v1.3）：isValidSignature(bytes,bytes) 验 inner 原文
        (ok, ret) = signer.staticcall(abi.encodeWithSelector(bytes4(0x20c13b0b), abi.encodePacked(inner), signature));
        if (!ok || ret.length < 32) return false;
        bytes4 magic = abi.decode(ret, (bytes4));
        return magic == bytes4(0x20c13b0b) || magic == 0x1626ba7e;
    }

    /**
     * @notice 所有权转移第二道闸：新 owner 不能是**被永久关闭的 operator**（墓碑）。
     *         节点主可以成为 owner（平台不限制 owner 兼任节点主）；墓碑是终局，不能再回到治理层。
     */
    function _transferOwnership(address newOwner) internal override {
        if (newOwner != address(0)) {
            if (forceClosedOperator[newOwner]) {
                revert RoleConflict();
            }
        }
        super._transferOwnership(newOwner);
    }
}
