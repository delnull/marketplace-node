// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NodeFixture} from "./NodeFixture.sol";
import {Escrow} from "../src/Escrow.sol";
import {Staking} from "../src/Staking.sol";
import {NodeGovernance} from "../src/NodeGovernance.sol";

/**
 * @dev 每节点治理：owner 提议、委员会 2/3 批准、2 天延迟；唯一快速路径是委员会 2/3 解冻。
 */
contract GovernanceTest is NodeFixture {
    NodeGovernance internal gov;

    function setUp() public override {
        super.setUp();
        gov = new NodeGovernance(address(escrow), address(staking));
        vm.prank(operator);
        escrow.setGovernor(address(gov));
        vm.prank(operator);
        staking.setGovernor(address(gov));
    }

    function _proposeArbiters() internal returns (uint256 id) {
        address[] memory members = new address[](3);
        members[0] = arbiter1;
        members[1] = arbiter2;
        members[2] = operator;
        bytes memory data = abi.encodeWithSelector(Escrow.setArbiters.selector, members, 2);
        vm.prank(operator);
        gov.propose(address(escrow), data);
        return gov.proposalCount();
    }

    function testGovernorCannotBeWiredBeforeCommittee() public {
        Escrow e2 = new Escrow(operator, GRACE, TIMEOUT, AFTER_SALE, address(0));
        Staking s2 = new Staking(address(e2), keccak256(address(e2).code), operator);
        NodeGovernance g2 = new NodeGovernance(address(e2), address(s2));
        vm.prank(operator);
        e2.setStaking(address(s2));
        /*
          先接线 governor 后设委员会 = 永久死锁：governor 接线后 owner 失去 setArbiters，
          而 NodeGovernance 空委员会的 requiredVotes 恒为 0，提案永远执行不了。
          合约必须在接线那一刻就拒绝，而不是靠部署脚本顺序。
        */
        vm.prank(operator);
        vm.expectRevert(Escrow.NoArbiter.selector);
        e2.setGovernor(address(g2));
    }

    function testGovernorMustPointAtThisNodePair() public {
        Escrow e2 = new Escrow(operator, GRACE, TIMEOUT, AFTER_SALE, address(0));
        Staking s2 = new Staking(address(e2), keccak256(address(e2).code), operator);
        NodeGovernance wrongGov = new NodeGovernance(address(e2), address(staking));
        vm.prank(operator);
        e2.setStaking(address(s2));
        // governor 接线前必须先有委员会（否则合约以 NoArbiter 拒绝，见另一个用例）
        address[] memory members = new address[](3);
        members[0] = arbiter1;
        members[1] = arbiter2;
        members[2] = arbiter3;
        vm.prank(operator);
        e2.setArbiters(members, 2);
        vm.prank(operator);
        vm.expectRevert(Escrow.GovernorMismatch.selector);
        e2.setGovernor(address(wrongGov));

        NodeGovernance wrongGov2 = new NodeGovernance(address(escrow), address(s2));
        vm.prank(operator);
        vm.expectRevert(Staking.GovernorMismatch.selector);
        s2.setGovernor(address(wrongGov2));
    }

    function testOwnerProposesCommitteeVotesDelayExecutes() public {
        uint256 id = _proposeArbiters();
        assertEq(gov.requiredVotes(), 2);

        vm.prank(arbiter1);
        gov.vote(id);
        vm.prank(arbiter2);
        gov.vote(id);

        vm.expectRevert(NodeGovernance.TooEarly.selector);
        gov.execute(id);

        vm.warp(block.timestamp + gov.EXECUTION_DELAY());
        gov.execute(id);
        assertEq(escrow.arbiters().length, 3);
    }

    function testOwnerCannotBypassGovernorForCommitteeOrParams() public {
        address[] memory members = new address[](2);
        members[0] = arbiter1;
        members[1] = arbiter2;
        vm.prank(operator);
        vm.expectRevert(Escrow.NotArbiter.selector);
        escrow.setArbiters(members, 2);

        vm.prank(operator);
        vm.expectRevert(Escrow.NotArbiter.selector);
        escrow.setRejectGraceBlocks(20_000);
    }

    function testNonOwnerCannotPropose() public {
        bytes memory data = abi.encodeWithSelector(Escrow.setRejectGraceBlocks.selector, uint64(20_000));
        vm.prank(arbiter1);
        vm.expectRevert(NodeGovernance.NotOperator.selector);
        gov.propose(address(escrow), data);
    }

    function testNonCommitteeCannotVote() public {
        uint256 id = _proposeArbiters();
        vm.prank(buyer);
        vm.expectRevert(NodeGovernance.NotArbiter.selector);
        gov.vote(id);
    }

    function testCommitteeFastUnfreeze() public {
        vm.prank(operator);
        staking.freeze(seller, 30 days, "test");
        (,,, bool frozen) = staking.positions(seller);
        assertTrue(frozen);

        vm.prank(arbiter1);
        gov.proposeFastUnfreeze(seller);
        uint256 id = gov.proposalCount();
        (,,,,, bool fast,,) = gov.proposals(id);
        assertTrue(fast);

        vm.prank(arbiter1);
        gov.vote(id);
        vm.prank(arbiter2);
        gov.vote(id);
        gov.execute(id);

        (,,, frozen) = staking.positions(seller);
        assertFalse(frozen);
    }

    function testOwnerCannotCancelFastUnfreeze() public {
        vm.prank(operator);
        staking.freeze(seller, 30 days, "test");
        vm.prank(arbiter1);
        gov.proposeFastUnfreeze(seller);
        uint256 id = gov.proposalCount();
        vm.prank(operator);
        vm.expectRevert(NodeGovernance.CannotCancelFast.selector);
        gov.cancel(id);
    }

    function testInvalidTargetOrSelectorRejected() public {
        bytes memory badSelector = abi.encodeWithSignature("transferOwnership(address)", arbiter1);
        vm.prank(operator);
        vm.expectRevert(NodeGovernance.InvalidSelector.selector);
        gov.propose(address(escrow), badSelector);

        vm.prank(operator);
        vm.expectRevert(NodeGovernance.InvalidTarget.selector);
        gov.propose(address(0xdead), abi.encodeWithSelector(Escrow.setRejectGraceBlocks.selector, uint64(20_000)));
    }

    function testRevokedArbiterVoteDoesNotCountAtExecution() public {
        uint256 id = _proposeArbiters();
        vm.prank(arbiter1);
        gov.vote(id);
        vm.prank(arbiter2);
        gov.vote(id);

        // 直接由 governor 吊销 arbiter1：committeeEpoch 不变，但执行时不能再算他那一票。
        vm.prank(address(gov));
        escrow.revokeArbiter(arbiter1);
        vm.warp(block.timestamp + gov.EXECUTION_DELAY());
        vm.expectRevert(NodeGovernance.NotEnoughVotes.selector);
        gov.execute(id);
    }

    function testCannotRevokeIntoTwoOfTwo() public {
        bytes memory data = abi.encodeWithSelector(Escrow.revokeArbiter.selector, arbiter1);
        vm.prank(operator);
        gov.propose(address(escrow), data);
        uint256 id = gov.proposalCount();
        vm.prank(arbiter2);
        gov.vote(id);
        vm.prank(arbiter3);
        gov.vote(id);
        vm.warp(block.timestamp + gov.EXECUTION_DELAY());
        vm.expectRevert(NodeGovernance.LastArbiter.selector);
        gov.execute(id);
        assertTrue(escrow.isArbiter(arbiter1), "3/2 committee cannot be reduced to 2/2");
    }

    function testLastActiveArbiterCannotBeRevoked() public {        vm.prank(address(gov));
        escrow.revokeArbiter(arbiter1);

        // 3/2 只剩两票可投：再吊销一人会变成 1 个活跃委员，永远凑不齐 requiredVotes=2。
        bytes memory data = abi.encodeWithSelector(Escrow.revokeArbiter.selector, arbiter2);
        vm.prank(operator);
        gov.propose(address(escrow), data);
        uint256 id = gov.proposalCount();
        vm.prank(arbiter2);
        gov.vote(id);
        vm.prank(arbiter3);
        gov.vote(id);
        vm.warp(block.timestamp + gov.EXECUTION_DELAY());
        vm.expectRevert(NodeGovernance.LastArbiter.selector);
        gov.execute(id);
    }

    function testEpochChangeInvalidatesProposal() public {
        uint256 first = _proposeArbiters();
        vm.prank(arbiter1);
        gov.vote(first);

        // 第二个提案把委员会换掉（不会改变 owner/阈值），执行后 epoch 变化
        address[] memory members = new address[](3);
        members[0] = arbiter1;
        members[1] = arbiter2;
        members[2] = makeAddr("arbiter3");
        bytes memory data = abi.encodeWithSelector(Escrow.setArbiters.selector, members, 2);
        vm.prank(operator);
        gov.propose(address(escrow), data);
        uint256 second = gov.proposalCount();
        vm.prank(arbiter1);
        gov.vote(second);
        vm.prank(arbiter2);
        gov.vote(second);
        vm.warp(block.timestamp + gov.EXECUTION_DELAY());
        gov.execute(second);

        vm.prank(arbiter2);
        vm.expectRevert(NodeGovernance.EpochChanged.selector);
        gov.vote(first);
    }

    /// @dev 两个委员投票 + 时间锁执行（所有参数提案共用；不改变 epoch）
    function _pass(address target, bytes memory data) internal {
        vm.prank(operator);
        gov.propose(target, data);
        uint256 id = gov.proposalCount();
        vm.prank(arbiter1);
        gov.vote(id);
        vm.prank(arbiter2);
        gov.vote(id);
        vm.warp(block.timestamp + gov.EXECUTION_DELAY());
        gov.execute(id);
    }

    /**
     * @dev 治理**所有参数类型**逐一走通：Escrow 三个窗口参数、Staking 六个参数 +
     *      普通 unfreeze。任何 selector 从白名单漏掉/参数写错都会在这里红。
     */
    function testAllAllowedParameterSelectorsExecute() public {
        _pass(address(escrow), abi.encodeWithSelector(Escrow.setRejectGraceBlocks.selector, uint64(20_000)));
        assertEq(escrow.rejectGraceBlocks(), 20_000);

        _pass(address(escrow), abi.encodeWithSelector(Escrow.setMinTimeoutBlocks.selector, uint64(20_000)));
        assertEq(escrow.minTimeoutBlocks(), 20_000);

        _pass(address(escrow), abi.encodeWithSelector(Escrow.setAfterSaleWindowBlocks.selector, uint64(20_000)));
        assertEq(escrow.afterSaleWindowBlocks(), 20_000);

        _pass(address(staking), abi.encodeWithSelector(Staking.setPenaltyCapBps.selector, 6_000));
        assertEq(staking.penaltyCapBps(), 6_000);

        _pass(address(staking), abi.encodeWithSelector(Staking.setPenaltyWindow.selector, 2 days, 4_000));
        assertEq(staking.penaltyWindowSeconds(), 2 days);
        assertEq(staking.penaltyWindowCapBps(), 4_000);

        _pass(address(staking), abi.encodeWithSelector(Staking.setPenaltyWindowLock.selector, false));
        assertFalse(staking.penaltyWindowLocksWithdraw());

        _pass(address(staking), abi.encodeWithSelector(Staking.setUnlockDelay.selector, 2 days));
        assertEq(staking.unlockDelay(), 2 days);

        _pass(address(staking), abi.encodeWithSelector(Staking.setUnstakeApprovalTimeout.selector, 3 days));
        assertEq(staking.unstakeApprovalTimeout(), 3 days);

        _pass(address(staking), abi.encodeWithSelector(Staking.setMinRetainedStake.selector, 1 ether));
        assertEq(staking.minRetainedStake(), 1 ether);

        vm.prank(operator);
        staking.freeze(seller, 30 days, "governance matrix");
        (,,, bool frozenBefore) = staking.positions(seller);
        assertTrue(frozenBefore);
        _pass(address(staking), abi.encodeWithSelector(Staking.unfreeze.selector, seller));
        (,,, bool frozenAfter) = staking.positions(seller);
        assertFalse(frozenAfter);
    }
}
