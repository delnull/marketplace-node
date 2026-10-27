// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NodeFixture} from "./NodeFixture.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MarketplaceRegistry} from "../src/MarketplaceRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {Staking} from "../src/Staking.sol";
import {TokenPayoutVault} from "../src/TokenPayoutVault.sol";

contract DummyImpl {}

/// @dev 最小 ERC20，用于托管合约的 token 支付/退款测试
contract MockERC20 {
    string public symbol = "MOCK";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (blocked[to]) return false;
        if (balanceOf[msg.sender] < amount) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (balanceOf[from] < amount || allowance[from][msg.sender] < amount) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockNoReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// @dev 非标准：成功时不返回 bool
    function transfer(address to, uint256 amount) external {
        require(!blocked[to], "blocked");
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (balanceOf[from] < amount || allowance[from][msg.sender] < amount) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockFeeERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - fee;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (balanceOf[from] < amount || allowance[from][msg.sender] < amount) return false;
        allowance[from][msg.sender] -= amount;
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        return true;
    }
}

contract ProtocolTest is NodeFixture {
    using MessageHashUtils for bytes32;
    bytes32 internal constant ORDER1 = bytes32(uint256(1));
    bytes32 internal constant ORDER2 = bytes32(uint256(2));
    bytes32 internal constant ORDER3 = bytes32(uint256(3));

    /* ── Registry ───────────────────────────────────────────────────── */

    function testNodeRegistered() public view {
        MarketplaceRegistry.NodeInfo memory n = registry.getNode(operator);
        assertEq(n.operator, operator);
        assertEq(n.escrow, address(escrow));
        assertEq(n.staking, address(staking));
        assertEq(n.escrowCodeHash, keccak256(address(escrow).code));
        assertEq(n.stakingCodeHash, keccak256(address(staking).code));
        assertTrue(n.active);
        assertFalse(n.suspended);
        assertTrue(registry.isNodeActive(operator));
        assertEq(registry.escrowOperator(address(escrow)), operator);
        assertEq(registry.getActiveNodes(0, 100).length, 1);
    }

    function testSameEscrowCanRegisterInTwoRegistries() public {
        MarketplaceRegistry r2 = new MarketplaceRegistry(
            address(this),
            keccak256(vm.getDeployedCode("Escrow.sol:Escrow")),
            keccak256(vm.getDeployedCode("Staking.sol:Staking"))
        );
        r2.registerNode(
            operator,
            ENDPOINT,
            address(escrow),
            address(staking),
            _signRegistrationFor(address(r2), ENDPOINT, address(escrow), address(staking), OPERATOR_KEY)
        );
        assertTrue(r2.isNodeActive(operator));
        assertEq(r2.getNode(operator).escrow, address(escrow));

        // 一个目录的永久关闭只影响该目录；另一个目录与节点自己的 Escrow 不受影响。
        registry.forceCloseNode(operator, "directory-local");
        assertFalse(registry.isNodeActive(operator));
        assertTrue(r2.isNodeActive(operator));
        _order(ORDER1, 1 ether);
    }

    function testRejectsUnapprovedImplementation() public {
        DummyImpl dummy = new DummyImpl();
        uint256 key = 0xD3;
        address op = vm.addr(key);
        vm.expectRevert(MarketplaceRegistry.ImplementationNotApproved.selector);
        registry.registerNode(
            op,
            "https://bad.example.com",
            address(dummy),
            address(staking),
            _signRegistration("https://bad.example.com", address(dummy), address(staking), key)
        );
    }

    function testRegisterRejectsEscrowOwnedByAnother() public {
        address other = makeAddr("other-escrow-owner");
        uint256 key = 0xE1;
        address newOp = vm.addr(key);
        vm.startPrank(other);
        Escrow e2 = new Escrow(other, GRACE, TIMEOUT, AFTER_SALE, address(0));
        Staking s2 = new Staking(address(e2), keccak256(address(e2).code), other);
        vm.stopPrank();

        // 代码哈希都是白名单实现，但 owner 不是登记 operator：目录拒绝，避免资金方错位
        vm.expectRevert(MarketplaceRegistry.EscrowNotBound.selector);
        registry.registerNode(
            newOp,
            "https://other.example.com",
            address(e2),
            address(s2),
            _signRegistration("https://other.example.com", address(e2), address(s2), key)
        );
    }

    function testRegistryAcceptsNodeWithoutCommitteeOrBinding() public {
        uint256 key = 0xD4;
        address op = vm.addr(key);
        vm.startPrank(op);
        Escrow e2 = new Escrow(op, GRACE, TIMEOUT, AFTER_SALE, address(0));
        Staking s2 = new Staking(address(e2), keccak256(address(e2).code), op);
        // 刻意不 setStaking、不 setArbiters：Registry 只校验代码哈希 + Ownable owner，
        // 不读 Escrow.staking 绑定/委员会（那些由前端/用户直接核对）。
        vm.stopPrank();

        registry.registerNode(
            op,
            "https://independent.example.com",
            address(e2),
            address(s2),
            _signRegistration("https://independent.example.com", address(e2), address(s2), key)
        );
        assertTrue(registry.isNodeActive(op));
        assertEq(registry.getNode(op).escrow, address(e2));
        assertEq(registry.getNode(op).staking, address(s2));
    }

    function testRegistryRejectsStakingAlreadyUsedByAnotherNode() public {
        uint256 key = 0xD6;
        address op = vm.addr(key);
        vm.startPrank(op);
        Escrow e2 = new Escrow(op, GRACE, TIMEOUT, AFTER_SALE, address(0));
        vm.stopPrank();

        // 第一个 operator 已登记 staking；第二个节点不能把同一个 Staking 登记成自己的。
        vm.expectRevert(MarketplaceRegistry.StakingAlreadyRegistered.selector);
        registry.registerNode(
            op,
            "https://staking-shared.example.com",
            address(e2),
            address(staking),
            _signRegistration("https://staking-shared.example.com", address(e2), address(staking), key)
        );
    }

    function testRegistryRejectsNonHttpsOrIpEndpoint() public {
        uint256 key = 0xD7;
        address op = vm.addr(key);
        vm.startPrank(op);
        Escrow e2 = new Escrow(op, GRACE, TIMEOUT, AFTER_SALE, address(0));
        Staking s2 = new Staking(address(e2), keccak256(address(e2).code), op);
        vm.stopPrank();

        string[6] memory bad = [
            "node.example.com",
            "http://node.example.com",
            "https://127.0.0.1",
            "https://0x7f.0.0.1",
            "https://node.example.com:443",
            "https://node.example.com/api/"
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(MarketplaceRegistry.EndpointNotNormalized.selector);
            registry.registerNode(
                op, bad[i], address(e2), address(s2), _signRegistration(bad[i], address(e2), address(s2), key)
            );
        }

        // 允许域名后的路径（前端页面本身在 HTTPS 下，可能挂在反向代理子路径）。
        registry.registerNode(
            op,
            "https://node.example.com/api",
            address(e2),
            address(s2),
            _signRegistration("https://node.example.com/api", address(e2), address(s2), key)
        );
        assertTrue(registry.isNodeActive(op));
    }

    function testRegistryRejectsZeroOrSameAddress() public {
        uint256 key = 0xD5;
        address op = vm.addr(key);
        vm.prank(op);
        vm.expectRevert(MarketplaceRegistry.EscrowNotBound.selector);
        registry.registerNode(
            op,
            "https://zero.example.com",
            address(0),
            address(staking),
            _signRegistration("https://zero.example.com", address(0), address(staking), key)
        );
        vm.prank(op);
        vm.expectRevert(MarketplaceRegistry.StakingNotBound.selector);
        registry.registerNode(
            op,
            "https://same.example.com",
            address(escrow),
            address(escrow),
            _signRegistration("https://same.example.com", address(escrow), address(escrow), key)
        );
    }

    function testPlatformSuspendDoesNotStopEscrow() public {
        registry.suspendNode(operator, "review");
        assertFalse(registry.isNodeActive(operator));
        assertEq(registry.getActiveNodes(0, 100).length, 0);

        /*
          新模型：Registry 只是目录；节点合约不读它。平台停用后，已经在链上的 Escrow
          仍可结算/接单——前端/目录必须硬禁支付，节点自己用 setAcceptingOrders 暂停。
        */
        _order(ORDER1, 1 ether);

        registry.unsuspendNode(operator);
        assertTrue(registry.isNodeActive(operator));
    }

    function testNodeOwnerCanPauseOrders() public {
        vm.prank(operator);
        escrow.setAcceptingOrders(false);

        vm.prank(buyer);
        vm.expectRevert(Escrow.OrdersPaused.selector);
        escrow.createOrder{value: 1 ether}(ORDER1, seller, 1 ether, TIMEOUT);

        vm.prank(operator);
        escrow.setAcceptingOrders(true);
        _order(ORDER1, 1 ether);
    }

    function testForceCloseBlocksRegistration() public {
        registry.forceCloseNode(operator, "fraud");
        assertTrue(registry.isForceClosed(operator));
        assertFalse(registry.isNodeActive(operator));

        // force-close 只关闭本目录的行，不冻结节点自己的托管；在途/新单仍由节点自己决定。
        _order(ORDER1, 1 ether);

        vm.expectRevert(MarketplaceRegistry.OperatorForceClosed.selector);
        registry.registerNode(
            operator,
            ENDPOINT,
            address(escrow),
            address(staking),
            _signRegistration(ENDPOINT, address(escrow), address(staking), OPERATOR_KEY)
        );
    }

    function testOwnerCanBeNodeOperator() public {
        // 平台 owner 可以同时是节点主：所有权转移不再拒绝节点主
        registry.transferOwnership(operator);
        vm.prank(operator);
        registry.acceptOwnership();
        assertEq(registry.owner(), operator);
        assertTrue(registry.isNodeActive(operator));

        // owner 可以停用自己的节点，也可以恢复（没有"owner 不能碰自己节点"的限制）
        vm.prank(operator);
        registry.suspendNode(operator, "self-suspend");
        assertFalse(registry.isNodeActive(operator));
        vm.prank(operator);
        registry.unsuspendNode(operator);
        assertTrue(registry.isNodeActive(operator));
    }

    function testCommitteeMax20() public {
        address[] memory members = new address[](20);
        for (uint256 i = 0; i < 20; ++i) members[i] = address(uint160(0x10000 + i));
        vm.prank(operator);
        escrow.setArbiters(members, 1);
        assertEq(escrow.arbiters().length, 20);

        address[] memory tooMany = new address[](21);
        for (uint256 i = 0; i < 21; ++i) tooMany[i] = address(uint160(0x20000 + i));
        vm.prank(operator);
        vm.expectRevert(Escrow.CommitteeTooLarge.selector);
        escrow.setArbiters(tooMany, 1);
    }

    function testClaimIdDoesNotOverwriteOrderEpoch() public {
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);
        assertEq(escrow.orderEpoch(ORDER1), 0, "order epoch before claim");

        // claimId 与 orderId 相同：两个命名空间必须互不覆盖
        _openClaim(ORDER1, ORDER1, 0.1 ether);
        assertEq(escrow.orderEpoch(ORDER1), 0, "claim must not write order epoch");
        assertEq(escrow.claimEpoch(ORDER1), escrow.committeeEpoch(), "claim epoch");
    }

    function testRevokedArbiterOldVoteNotCounted() public {
        address extra = makeAddr("extraArbiter");
        address[] memory members = new address[](3);
        members[0] = arbiter1;
        members[1] = arbiter2;
        members[2] = extra;
        vm.prank(operator);
        escrow.setArbiters(members, 2);

        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.requestRefund(ORDER1);
        vm.prank(seller);
        escrow.rejectRefund(ORDER1);
        vm.prank(buyer);
        escrow.requestDispute(ORDER1);

        // 先以仲裁人身份投一票
        vm.prank(arbiter1);
        escrow.voteSettlement(ORDER1, 0);

        // owner 吊销该委员：旧票不能再计入，且本人不能再投
        vm.prank(operator);
        escrow.revokeArbiter(arbiter1);

        vm.prank(arbiter1);
        vm.expectRevert(Escrow.NotArbiter.selector);
        escrow.voteSettlement(ORDER1, 0);

        // 3/2 委员会吊销一人后不能缩成 2/2（否则再丢一把钥就永久无解）；
        // 墓碑保留在名单里，但计票跳过，剩余两人仍能凑够 2 票。
        assertEq(escrow.arbiters().length, 3, "3/2 must keep its shape after revoke");
        assertFalse(escrow.isArbiter(arbiter1), "revoked member is not an arbiter");
        vm.prank(arbiter2);
        escrow.voteSettlement(ORDER1, 0);
        assertEq(uint8(escrow.getOrder(ORDER1).status), uint8(Escrow.OrderStatus.Disputed));
        vm.prank(extra);
        escrow.voteSettlement(ORDER1, 0);
        assertEq(uint8(escrow.getOrder(ORDER1).status), uint8(Escrow.OrderStatus.Settled));
    }

    function testOwnerCanBeArbiter() public {
        // 节点主可以进委员会：3 人/阈值 2（owner 也在名单里）
        address[] memory members = new address[](3);
        members[0] = arbiter1;
        members[1] = arbiter2;
        members[2] = operator;
        vm.prank(operator);
        escrow.setArbiters(members, 2);
        assertEq(escrow.arbiters().length, 3);

        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.requestRefund(ORDER1);
        vm.prank(seller);
        escrow.rejectRefund(ORDER1);
        vm.prank(buyer);
        escrow.requestDispute(ORDER1);

        vm.prank(operator);
        escrow.voteSettlement(ORDER1, 0);
        vm.prank(arbiter1);
        escrow.voteSettlement(ORDER1, 0);
        assertEq(uint8(escrow.getOrder(ORDER1).status), uint8(Escrow.OrderStatus.Settled));
    }

    function testCommitteeShapeRejectsSoloAndUnanimousPanels() public {
        address[] memory one = new address[](1);
        one[0] = operator;
        vm.prank(operator);
        vm.expectRevert(Escrow.NoArbiter.selector);
        escrow.setArbiters(one, 1);

        address[] memory two = new address[](2);
        two[0] = operator;
        two[1] = arbiter1;
        vm.prank(operator);
        vm.expectRevert(Escrow.NoArbiter.selector);
        escrow.setArbiters(two, 2);

        address[] memory three = new address[](3);
        three[0] = operator;
        three[1] = arbiter1;
        three[2] = arbiter2;
        vm.prank(operator);
        vm.expectRevert(Escrow.OwnerNeedsIndependentPanel.selector);
        escrow.setArbiters(three, 1);

        // n-of-n 也不可表达：丢一把钥就永远凑不齐票
        vm.prank(operator);
        vm.expectRevert(Escrow.ThresholdOutOfBounds.selector);
        escrow.setArbiters(three, 3);

        vm.prank(operator);
        escrow.setArbiters(three, 2);
        assertEq(escrow.arbiters().length, 3);
    }

    function testEscrowOwnerTransferToArbiterAllowedWithIndependentPanel() public {
        // 3 人/阈值 2：owner 进入委员会后仍不是 1-of-1，允许转移
        vm.prank(operator);
        escrow.transferOwnership(arbiter1);
        vm.prank(arbiter1);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), arbiter1);
    }

    function testStakingOwnerCanBeArbiter() public {
        vm.prank(operator);
        staking.transferOwnership(arbiter1);
        vm.prank(arbiter1);
        staking.acceptOwnership();
        assertEq(staking.owner(), arbiter1);
    }

    function testImplementationWhitelistToggle() public {
        bytes32 h = keccak256(address(escrow).code);
        assertTrue(registry.isApprovedEscrowImplementation(h));
        registry.approveEscrowImplementation(h, false);
        assertFalse(registry.isApprovedEscrowImplementation(h));
        // 撤销白名单后，已登记行不再以 active 身份下发（分页长度/下标不变，前端按 active 过滤）
        assertFalse(registry.getNode(operator).active);
        assertFalse(registry.isNodeActive(operator), 'isNodeActive must match getNode().active');
        MarketplaceRegistry.NodeInfo[] memory rows = registry.getActiveNodes(0, 100);
        assertEq(rows.length, 1);
        assertFalse(rows[0].active);
        registry.approveEscrowImplementation(h, true);
        assertTrue(registry.isApprovedEscrowImplementation(h));
    }

    /* ── Escrow: 基本资金流（零费用）────────────────────────────────── */

    function testCreateAndConfirmNoFee() public {
        uint256 before = seller.balance;
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);

        Escrow.Order memory o = escrow.getOrder(ORDER1);
        assertEq(uint256(o.status), uint256(Escrow.OrderStatus.Settled));
        assertEq(o.refundedAmount, 0);
        // 确认收货先进入售后留存期：钱仍在 Escrow，卖家不能立即拿走。
        assertEq(seller.balance, before, "seller does not get paid during holdback");
        assertEq(escrow.sellerPending(ORDER1), 1 ether);
        assertEq(address(escrow).balance, 1 ether);

        vm.expectRevert(Escrow.PendingLocked.selector);
        escrow.releaseSellerFunds(ORDER1);

        vm.roll(uint256(escrow.sellerPendingUnlockBlock(ORDER1)));
        escrow.releaseSellerFunds(ORDER1);
        assertEq(seller.balance, before + 1 ether, "seller gets full amount after holdback, no fee");
        assertEq(address(escrow).balance, 0);
    }

    function testSellerHoldbackCoversWholeAfterSaleWindow() public {
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);

        uint64 settled = escrow.settledAtBlock(ORDER1);
        uint64 window = escrow.afterSaleWindowAtCreate(ORDER1);
        uint64 unlock = escrow.sellerPendingUnlockBlock(ORDER1);
        assertEq(unlock, uint64(settled + window + 1), "holdback must outlive the last openAfterSale block");

        // 窗口最后一个块仍可开案；此时卖家不能已经提走货款。
        vm.roll(uint256(settled + window));
        vm.prank(buyer);
        escrow.openAfterSale(ORDER1);
        _voteAfterSale(ORDER1, 0.4 ether);
        assertEq(escrow.sellerPending(ORDER1), 0.6 ether);

        vm.roll(uint256(unlock));
        escrow.releaseSellerFunds(ORDER1);
        assertEq(escrow.sellerPending(ORDER1), 0);
    }

    function testTimeoutRelease() public {        uint256 before = seller.balance;
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);
        assertEq(seller.balance, before + 1 ether);
    }

    function testSellerFullRefund() public {
        _order(ORDER1, 1 ether);
        uint256 before = buyer.balance;
        vm.prank(seller);
        escrow.approveRefund(ORDER1, 1 ether);
        assertEq(buyer.balance, before + 1 ether);
        assertEq(uint256(escrow.getOrder(ORDER1).status), uint256(Escrow.OrderStatus.Refunded));
    }

    function testPartialRefundRequiresBuyerAuthorization() public {
        _order(ORDER1, 1 ether);
        vm.prank(seller);
        vm.expectRevert(Escrow.RefundAmountNotAccepted.selector);
        escrow.approveRefund(ORDER1, 0.4 ether);

        uint256 buyerBefore = buyer.balance;
        uint256 sellerBefore = seller.balance;
        vm.prank(buyer);
        escrow.acceptPartialRefund(ORDER1, 0.4 ether);
        vm.prank(seller);
        escrow.approveRefund(ORDER1, 0.4 ether);
        assertEq(buyer.balance, buyerBefore + 0.4 ether);
        assertEq(seller.balance, sellerBefore);
        assertEq(escrow.sellerPending(ORDER1), 0.6 ether);
        vm.roll(uint256(escrow.sellerPendingUnlockBlock(ORDER1)));
        escrow.releaseSellerFunds(ORDER1);
        assertEq(seller.balance, sellerBefore + 0.6 ether);
    }

    function testERC20OrderSettlesInToken() public {
        MockERC20 token = new MockERC20();
        vm.prank(operator);
        escrow.setSupportedToken(address(token), true);
        token.mint(buyer, 100e6);
        vm.prank(buyer);
        token.approve(address(escrow), 100e6);

        vm.prank(buyer);
        escrow.createOrderToken(ORDER1, seller, address(token), 100e6, TIMEOUT);
        assertEq(escrow.orderToken(ORDER1), address(token));
        assertEq(token.balanceOf(address(escrow)), 100e6);

        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);
        assertEq(escrow.sellerPending(ORDER1), 100e6);
        assertEq(token.balanceOf(seller), 0);
        vm.roll(uint256(escrow.sellerPendingUnlockBlock(ORDER1)));
        escrow.releaseSellerFunds(ORDER1);
        assertEq(token.balanceOf(seller), 100e6);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testERC20FailedPayoutCreditsVault() public {
        MockERC20 token = new MockERC20();
        vm.prank(operator);
        escrow.setSupportedToken(address(token), true);
        token.mint(buyer, 100e6);
        vm.prank(buyer);
        token.approve(address(escrow), 100e6);
        vm.prank(buyer);
        escrow.createOrderToken(ORDER1, seller, address(token), 100e6, TIMEOUT);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);
        vm.roll(uint256(escrow.sellerPendingUnlockBlock(ORDER1)));

        // 收款地址被 token 拒绝时，Escrow 不能整笔回滚（否则钱永远留在合约里）；
        // 先转给 vault 记账，解除拒绝后收款人自行 claim。
        token.setBlocked(seller, true);
        escrow.releaseSellerFunds(ORDER1);
        assertEq(token.balanceOf(address(tokenVault)), 100e6);
        assertEq(tokenVault.credits(address(token), seller), 100e6);
        assertEq(escrow.sellerPending(ORDER1), 0);

        // 挂账只能由 Escrow 写；任何人都不能凭空给某人记一笔。
        vm.prank(buyer);
        vm.expectRevert(TokenPayoutVault.OnlyEscrow.selector);
        tokenVault.credit(address(token), buyer, 1);

        token.setBlocked(seller, false);
        vm.prank(seller);
        tokenVault.claim(address(token));
        assertEq(token.balanceOf(seller), 100e6);
        assertEq(tokenVault.credits(address(token), seller), 0);
    }

    function testFeeTokenVaultCreditsActualReceived() public {
        MockFeeERC20 token = new MockFeeERC20();
        TokenPayoutVault vault = new TokenPayoutVault(operator);
        vm.prank(operator);
        vault.setEscrow(address(this));

        token.mint(address(this), 100e6);
        token.transfer(address(vault), 100e6); // 1% fee: vault gets 99
        vault.credit(address(token), seller, 100e6);
        assertEq(vault.credits(address(token), seller), 99e6, "vault must credit actual balance delta");
        assertEq(vault.totalCredits(address(token)), 99e6);

        vm.prank(seller);
        vault.claim(address(token));
        assertEq(token.balanceOf(seller), 98_010_000, "claim pays the actual credited amount, then token fee applies");
        assertEq(vault.credits(address(token), seller), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function testNoReturnTokenFallsBackToVaultAndClaims() public {
        MockNoReturnERC20 token = new MockNoReturnERC20();
        vm.prank(operator);
        escrow.setSupportedToken(address(token), true);
        token.mint(buyer, 100e6);
        vm.prank(buyer);
        token.approve(address(escrow), 100e6);
        vm.prank(buyer);
        escrow.createOrderToken(ORDER1, seller, address(token), 100e6, TIMEOUT);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);

        // 直接转卖家会被拒（非标准 transfer 无返回值 + blocked）；回退到 vault 必须成功
        token.setBlocked(seller, true);
        vm.roll(uint256(escrow.sellerPendingUnlockBlock(ORDER1)));
        escrow.releaseSellerFunds(ORDER1);
        assertEq(token.balanceOf(address(tokenVault)), 100e6);
        assertEq(tokenVault.credits(address(token), seller), 100e6);

        token.setBlocked(seller, false);
        vm.prank(seller);
        tokenVault.claim(address(token));
        assertEq(token.balanceOf(seller), 100e6);
        assertEq(tokenVault.credits(address(token), seller), 0);
    }

    function testERC20AfterSaleRefundsFromPendingOnly() public {        MockERC20 token = new MockERC20();
        vm.prank(operator);
        escrow.setSupportedToken(address(token), true);
        token.mint(buyer, 100e6);
        vm.prank(buyer);
        token.approve(address(escrow), 100e6);
        vm.prank(buyer);
        escrow.createOrderToken(ORDER2, seller, address(token), 100e6, TIMEOUT);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER2);
        vm.prank(buyer);
        escrow.openAfterSale(ORDER2);

        _voteAfterSale(ORDER2, 100e6);
        assertEq(token.balanceOf(buyer), 100e6);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.sellerPending(ORDER2), 0);
    }

    function testERC20ClaimsAndStakingPenaltyAreRejected() public {
        MockERC20 token = new MockERC20();
        vm.prank(operator);
        escrow.setSupportedToken(address(token), true);
        token.mint(buyer, 100e6);
        vm.prank(buyer);
        token.approve(address(escrow), 100e6);
        vm.prank(buyer);
        escrow.createOrderToken(ORDER3, seller, address(token), 100e6, TIMEOUT);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER3);

        vm.prank(operator);
        vm.expectRevert(Escrow.TokenClaimsNotSupported.selector);
        escrow.openClaimDispute(keccak256("token-claim"), ORDER3, keccak256("ref"), seller, claimant, 1e6, 0);

        vm.expectRevert(Escrow.TokenPenaltyNotSupported.selector);
        escrow.votePenalty(ORDER3, 1e6);
    }

    function testAfterSaleFullRefundFromPending() public {
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);
        vm.prank(buyer);
        escrow.openAfterSale(ORDER1);
        uint256 buyerBefore = buyer.balance;
        _voteAfterSale(ORDER1, 1 ether);
        assertEq(buyer.balance, buyerBefore + 1 ether);
        assertEq(escrow.sellerPending(ORDER1), 0);
        assertEq(address(escrow).balance, 0);
        assertFalse(escrow.afterSaleOpen(ORDER1));
    }

    function testFullRefundSettledBlocksAfterSale() public {
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);
        vm.prank(seller);
        escrow.refundSettled(ORDER1, 1 ether);
        assertEq(escrow.getOrder(ORDER1).refundedAmount, 1 ether, "buyer received must be recorded");

        vm.prank(buyer);
        vm.expectRevert(Escrow.NotSettledForAfterSale.selector);
        escrow.openAfterSale(ORDER1);
    }

    function testPartialRefundSettledCapsAfterSale() public {
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);
        vm.prank(seller);
        escrow.refundSettled(ORDER1, 0.4 ether);
        vm.prank(buyer);
        escrow.openAfterSale(ORDER1);

        vm.prank(arbiter1);
        escrow.voteAfterSale(ORDER1, 0.3 ether);
        vm.prank(arbiter2);
        escrow.voteAfterSale(ORDER1, 0.3 ether);
        assertEq(escrow.getOrder(ORDER1).refundedAmount, 0.7 ether, "pending refund + after-sale must be cumulative");
        assertEq(escrow.sellerPending(ORDER1), 0.3 ether, "only the remaining pending is left");
        assertEq(escrow.afterSaleOpen(ORDER1), false);
    }

    function testAfterSaleExpiresReleasesPending() public {
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);
        vm.prank(buyer);
        escrow.openAfterSale(ORDER1);

        vm.roll(block.number + 1_555_200 + 1);
        uint256 before = seller.balance;
        escrow.releaseSellerFunds(ORDER1);
        assertEq(seller.balance, before + 1 ether, "expired case must not pin seller pending");
        assertEq(escrow.sellerPending(ORDER1), 0);
        assertEq(escrow.afterSaleOpen(ORDER1), false);
    }

    function testClaimVoteAfterDeadlineReverts() public {
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);
        _openClaim(keccak256("late-claim"), ORDER1, 0.1 ether);
        vm.warp(block.timestamp + 31 days);
        vm.prank(arbiter1);
        vm.expectRevert(Escrow.ClaimDeadlinePassed.selector);
        escrow.voteClaim(keccak256("late-claim"), 0);
    }

    function testClaimCancelledAfterDeadlineByAnyone() public {
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);
        bytes32 claimId = keccak256("expired-claim");
        _openClaim(claimId, ORDER1, 0.1 ether);
        assertEq(escrow.sellerClaimExposure(seller), 0.1 ether);

        // 一个委员先投 0 票会关闭 owner 的常规撤销入口；deadline 后必须由任何人可撤。
        vm.prank(arbiter1);
        escrow.voteClaim(claimId, 0);
        vm.warp(block.timestamp + 31 days);
        vm.prank(buyer);
        escrow.cancelClaimDispute(claimId, "expired");
        assertEq(escrow.sellerClaimExposure(seller), 0);
        assertTrue(escrow.claimCase(claimId).closed);
    }

    function testHistoricalArbiterCanBeRevokedAfterRotation() public {
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.requestRefund(ORDER1);
        vm.prank(seller);
        escrow.rejectRefund(ORDER1);
        vm.prank(buyer);
        escrow.requestDispute(ORDER1);

        address[] memory next = new address[](3);
        next[0] = arbiter2;
        next[1] = arbiter3;
        next[2] = makeAddr("freshArbiter");
        vm.prank(operator);
        escrow.setArbiters(next, 2);

        // arbiter1 已不在当前届，但仍是旧届成员；吊销必须仍然生效
        vm.prank(operator);
        escrow.revokeArbiter(arbiter1);
        vm.prank(arbiter1);
        vm.expectRevert(Escrow.NotArbiter.selector);
        escrow.voteSettlement(ORDER1, 0);
    }

    function testSellerCanRefundFromPending() public {
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);
        uint256 buyerBefore = buyer.balance;

        vm.prank(buyer);
        vm.expectRevert(Escrow.NotSeller.selector);
        escrow.refundSettled(ORDER1, 0.3 ether);

        vm.prank(seller);
        escrow.refundSettled(ORDER1, 0.3 ether);
        assertEq(buyer.balance, buyerBefore + 0.3 ether);
        assertEq(escrow.sellerPending(ORDER1), 0.7 ether);
    }

    function testOpenAfterSaleBlocksPendingRelease() public {
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);
        vm.prank(buyer);
        escrow.openAfterSale(ORDER1);
        vm.roll(uint256(escrow.sellerPendingUnlockBlock(ORDER1)));
        vm.expectRevert(Escrow.PendingCaseOpen.selector);
        escrow.releaseSellerFunds(ORDER1);
    }

    function testRejectGraceBeforeRelease() public {
        _order(ORDER1, 1 ether);
        Escrow.Order memory o = escrow.getOrder(ORDER1);
        // 在超时前 10 块拒绝：否则"拒绝 + 静置期"会早于超时结束，releaseExpired 只会先报 NotExpired
        vm.roll(uint256(o.createdAtBlock) + uint256(o.timeoutBlocks) - 10);
        vm.prank(buyer);
        escrow.requestRefund(ORDER1);
        vm.prank(seller);
        escrow.rejectRefund(ORDER1);
        _rollPastTimeout(ORDER1);
        vm.expectRevert(Escrow.RejectGraceActive.selector);
        escrow.releaseExpired(ORDER1);
        vm.roll(block.number + uint256(GRACE) + 1);
        escrow.releaseExpired(ORDER1);
        assertEq(uint256(escrow.getOrder(ORDER1).status), uint256(Escrow.OrderStatus.Settled));
    }

    function testDisputeSettlement() public {
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.requestRefund(ORDER1);
        vm.prank(seller);
        escrow.rejectRefund(ORDER1);
        vm.prank(buyer);
        escrow.requestDispute(ORDER1);

        uint256 buyerBefore = buyer.balance;
        uint256 sellerBefore = seller.balance;
        _voteSettlement(ORDER1, 0.5 ether);
        assertEq(buyer.balance, buyerBefore + 0.5 ether);
        assertEq(seller.balance, sellerBefore + 0.5 ether);
        assertEq(uint256(escrow.getOrder(ORDER1).status), uint256(Escrow.OrderStatus.Settled));
    }

    function testAfterSalePenaltyFromPendingFirst() public {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);
        vm.prank(buyer);
        escrow.openAfterSale(ORDER1);

        uint256 buyerBefore = buyer.balance;
        _voteAfterSale(ORDER1, 0.4 ether);
        // 留存货款优先赔付买家；保证金不动，只有不足部分才罚 Staking。
        assertEq(buyer.balance, buyerBefore + 0.4 ether);
        assertEq(staking.poolOf(seller), 1 ether);
        assertEq(escrow.sellerPending(ORDER1), 0.6 ether);
        assertFalse(escrow.afterSaleOpen(ORDER1));

        vm.roll(uint256(escrow.sellerPendingUnlockBlock(ORDER1)));
        escrow.releaseSellerFunds(ORDER1);
        assertEq(escrow.sellerPending(ORDER1), 0);
    }

    /* ── Escrow: 提货争议 ──────────────────────────────────────────── */

    function testClaimPenaltyPaysHolder() public {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);

        bytes32 claimId = keccak256("claim-1");
        _openClaim(claimId, ORDER1, 0.3 ether);
        assertEq(escrow.sellerClaimExposure(seller), 0.3 ether);

        uint256 before = claimant.balance;
        _voteClaim(claimId, 0.3 ether);
        assertEq(claimant.balance, before + 0.3 ether);
        assertEq(staking.poolOf(seller), 0.7 ether);
        assertEq(escrow.sellerClaimExposure(seller), 0);
        assertTrue(escrow.claimCase(claimId).closed);
    }

    function testClaimRequiresSettledOrder() public {
        _order(ORDER1, 1 ether);
        vm.prank(operator);
        vm.expectRevert(Escrow.OrderNotSettled.selector);
        escrow.openClaimDispute(
            keccak256("c"), ORDER1, keccak256("t"), seller, claimant, 0.3 ether, uint64(block.timestamp + 1 days)
        );
    }

    function testClaimSelfVoteRejected() public {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);
        bytes32 claimId = keccak256("claim-self");
        _openClaim(claimId, ORDER1, 0.2 ether);

        vm.prank(seller);
        vm.expectRevert(Escrow.InvalidArbiter.selector);
        escrow.voteClaim(claimId, 0.2 ether);
        vm.prank(claimant);
        vm.expectRevert(Escrow.InvalidArbiter.selector);
        escrow.voteClaim(claimId, 0.2 ether);
    }

    function testClaimCancelReleasesExposure() public {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);
        bytes32 claimId = keccak256("claim-cancel");
        _openClaim(claimId, ORDER1, 0.2 ether);
        vm.prank(operator);
        escrow.cancelClaimDispute(claimId, "settled off-chain");
        assertEq(escrow.sellerClaimExposure(seller), 0);
        vm.prank(arbiter1);
        vm.expectRevert(Escrow.ClaimNotOpen.selector);
        escrow.voteClaim(claimId, 0.2 ether);
    }

    function testClaimDeadlineAndAmount() public {
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);

        vm.prank(operator);
        vm.expectRevert(Escrow.ClaimDeadlinePassed.selector);
        escrow.openClaimDispute(
            keccak256("expired"), ORDER1, keccak256("t"), seller, claimant, 0.1 ether, uint64(block.timestamp - 1)
        );

        vm.prank(operator);
        vm.expectRevert(Escrow.InvalidClaimAmount.selector);
        escrow.openClaimDispute(
            keccak256("big"), ORDER1, keccak256("t"), seller, claimant, 2 ether, uint64(block.timestamp + 1 days)
        );
    }

    /* ── Staking ────────────────────────────────────────────────────── */

    function testStakeAndUnstake() public {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        assertEq(staking.poolOf(seller), 1 ether);

        vm.prank(seller);
        staking.requestUnstake(1 ether);
        assertEq(staking.poolOf(seller), 1 ether);
        vm.warp(block.timestamp + 7 days + 1);
        uint256 before = seller.balance;
        vm.prank(operator);
        staking.approveUnstake(seller);
        assertEq(seller.balance, before + 1 ether);
        assertEq(staking.poolOf(seller), 0);
    }

    function testFreezeBlocksUnstake() public {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        vm.prank(operator);
        staking.freeze(seller, 1 days, "review");
        vm.prank(seller);
        vm.expectRevert(Staking.Frozen.selector);
        staking.requestUnstake(1 ether);
    }

    function testPenaltyCapAndPayout() public {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);

        vm.prank(arbiter1);
        escrow.votePenalty(ORDER1, 0.6 ether);
        vm.prank(arbiter2);
        vm.expectRevert(Staking.ExceedsCap.selector);
        escrow.votePenalty(ORDER1, 0.6 ether);

        uint256 buyerBefore = buyer.balance;
        _votePenalty(ORDER1, 0.4 ether);
        assertEq(buyer.balance, buyerBefore + 0.4 ether);
        assertEq(staking.poolOf(seller), 0.6 ether);
        assertTrue(staking.penalizedOrders(ORDER1));
    }

    function testVotePenaltyCountsTowardAfterSaleCap() public {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.confirmReceipt(ORDER1);
        vm.prank(buyer);
        escrow.openAfterSale(ORDER1);

        _votePenalty(ORDER1, 0.4 ether);
        assertEq(escrow.getOrder(ORDER1).refundedAmount, 0.4 ether, "penalty must count as buyer compensation");

        // 已赔 0.4，售后只剩 0.6 额度；0.7 必须拒绝，否则同一单赔超
        vm.prank(arbiter1);
        vm.expectRevert(Escrow.InvalidAmount.selector);
        escrow.voteAfterSale(ORDER1, 0.7 ether);

        _voteAfterSale(ORDER1, 0.6 ether);
        assertEq(escrow.getOrder(ORDER1).refundedAmount, 1 ether, "refund + penalty must converge to order amount");
        assertEq(escrow.sellerPending(ORDER1), 0.4 ether, "penalty came from stake; after-sale paid the remaining pending");
    }

    function testClaimPenaltyCumulativeCap() public {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);

        bytes32 c1 = keccak256("cc-1");
        _openClaim(c1, ORDER1, 0.3 ether);
        _voteClaim(c1, 0.3 ether);

        bytes32 c2 = keccak256("cc-2");
        _openClaim(c2, ORDER1, 0.2 ether);
        uint256 before = claimant.balance;
        _voteClaim(c2, 0.2 ether);
        assertEq(claimant.balance, before + 0.2 ether);
        assertEq(staking.poolOf(seller), 0.5 ether);

        bytes32 c3 = keccak256("cc-3");
        _openClaim(c3, ORDER1, 1);
        vm.prank(arbiter1);
        escrow.voteClaim(c3, 1);
        vm.prank(arbiter2);
        vm.expectRevert(Staking.ExceedsCap.selector);
        escrow.voteClaim(c3, 1);
    }

    function testClaimExposureBlocksWithdraw() public {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);

        bytes32 claimId = keccak256("floor-claim");
        _openClaim(claimId, ORDER1, 0.5 ether);

        vm.prank(seller);
        staking.requestUnstake(1 ether);
        vm.warp(block.timestamp + 7 days + 1);
        (, uint256 required) = staking.payoutFloors(seller);
        assertEq(required, 0.5 ether);

        vm.prank(operator);
        vm.expectRevert(Staking.BelowRequiredFloor.selector);
        staking.approveUnstake(seller);

        vm.prank(operator);
        escrow.cancelClaimDispute(claimId, "resolved");
        vm.prank(operator);
        staking.approveUnstake(seller);
    }

    function testRejectGraceUsesConfiguredValueEvenAboveOrderTimeout() public {
        vm.prank(operator);
        escrow.setRejectGraceBlocks(TIMEOUT * 2);
        _order(ORDER1, 1 ether);
        vm.prank(buyer);
        escrow.requestRefund(ORDER1);
        vm.prank(seller);
        escrow.rejectRefund(ORDER1);
        assertEq(escrow.rejectGraceBlocksOf(ORDER1), TIMEOUT * 2, "grace truncated");
    }

    function testOrderPenaltyReducesClaimCapacity() public {
        vm.startPrank(operator);
        staking.setPenaltyCapBps(10_000);
        staking.setPenaltyWindow(1 days, 10_000);
        vm.stopPrank();
        vm.prank(seller);
        staking.stake{value: 1 ether}();

        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);
        _votePenalty(ORDER1, 0.4 ether);

        // 订单已赔买家 0.4 ⇒ 提货争议最多只能再开 0.6；0.7 必须被订单级上限拒绝。
        bytes32 claimId = keccak256("shared-cap-claim");
        vm.prank(operator);
        vm.expectRevert(Escrow.InvalidClaimAmount.selector);
        escrow.openClaimDispute(
            claimId, ORDER1, keccak256("shared-cap-token"), seller, claimant, 0.7 ether, uint64(block.timestamp + 1 days)
        );
        _openClaim(claimId, ORDER1, 0.2 ether);
        _voteClaim(claimId, 0.2 ether);
        assertTrue(escrow.claimCase(claimId).closed, "claim closes after committee vote");
    }

    function testSameOrderTokenCannotHaveTwoOpenClaims() public {
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);
        bytes32 tokenRef = keccak256("same-token");
        vm.prank(operator);
        escrow.openClaimDispute(
            keccak256("open-1"), ORDER1, tokenRef, seller, claimant, 0.1 ether, uint64(block.timestamp + 1 days)
        );
        vm.prank(operator);
        vm.expectRevert(Escrow.ClaimExists.selector);
        escrow.openClaimDispute(
            keccak256("open-2"), ORDER1, tokenRef, seller, claimant, 0.1 ether, uint64(block.timestamp + 1 days)
        );
    }

    function testDifferentTokenRefsCannotExceedOrderClaimExposure() public {
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);
        vm.prank(operator);
        escrow.openClaimDispute(
            keccak256("exposure-1"), ORDER1, keccak256("token-a"), seller, claimant, 0.6 ether, uint64(block.timestamp + 1 days)
        );
        assertEq(escrow.orderClaimExposure(ORDER1), 0.6 ether);
        vm.prank(operator);
        vm.expectRevert(Escrow.InvalidClaimAmount.selector);
        escrow.openClaimDispute(
            keccak256("exposure-2"), ORDER1, keccak256("token-b"), seller, claimant, 0.6 ether, uint64(block.timestamp + 1 days)
        );
    }

    function testTransferRegistrationRequiresNewOperatorSignature() public {
        address nextOperator = makeAddr("next-node-operator");
        uint256 newKey = 0xA11CE;
        bytes32 inner = keccak256(
            abi.encode(
                "transferRegistration",
                operator,
                nextOperator,
                address(escrow),
                address(staking),
                ENDPOINT,
                block.chainid,
                address(registry)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newKey, inner.toEthSignedMessageHash());
        // 签名地址与声明的新 operator 不一致：目录拒绝
        vm.prank(operator);
        vm.expectRevert(MarketplaceRegistry.BadSignature.selector);
        registry.transferRegistration(nextOperator, abi.encodePacked(r, s, v));

        address actualNew = vm.addr(newKey);
        (v, r, s) = vm.sign(newKey, inner.toEthSignedMessageHash());
        // inner 绑定的是 nextOperator，不是 actualNew，仍然不能冒名
        vm.prank(operator);
        vm.expectRevert(MarketplaceRegistry.BadSignature.selector);
        registry.transferRegistration(actualNew, abi.encodePacked(r, s, v));

        bytes32 inner2 = keccak256(
            abi.encode(
                "transferRegistration",
                operator,
                actualNew,
                address(escrow),
                address(staking),
                ENDPOINT,
                block.chainid,
                address(registry)
            )
        );
        (v, r, s) = vm.sign(newKey, inner2.toEthSignedMessageHash());
        // 目录身份转移前，资金合约所有权必须先交给新 operator（Registry 会读 owner）
        vm.prank(operator);
        escrow.transferOwnership(actualNew);
        vm.prank(actualNew);
        escrow.acceptOwnership();
        vm.prank(operator);
        staking.transferOwnership(actualNew);
        vm.prank(actualNew);
        staking.acceptOwnership();
        vm.prank(operator);
        registry.transferRegistration(actualNew, abi.encodePacked(r, s, v));

        assertEq(registry.getNode(actualNew).operator, actualNew);
        assertTrue(registry.getNode(actualNew).active);
        assertEq(registry.escrowOperator(address(escrow)), actualNew);
        assertEq(registry.getNode(operator).registeredAtBlock, 0);
        assertEq(registry.getNode(actualNew).endpoint, ENDPOINT);
    }

    function testDeregisterReleasesUniqueKeysAndAllowsReRegister() public {
        assertTrue(registry.isNodeActive(operator));
        vm.prank(operator);
        registry.deregisterNode();
        assertFalse(registry.isNodeActive(operator));
        // endpoint / escrow / staking 的唯一性占位必须随注销释放，否则同一套节点永远回不来
        assertEq(registry.escrowOperator(address(escrow)), address(0));

        // 注销后重新激活必须 operator 本人发交易（首次注册才允许代付签名）
        vm.prank(operator);
        _register(operator, address(escrow), address(staking), OPERATOR_KEY);
        assertTrue(registry.isNodeActive(operator));
    }
}
