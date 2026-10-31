// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NodeFixture} from "./NodeFixture.sol";
import {Escrow} from "../src/Escrow.sol";
import {Staking} from "../src/Staking.sol";

/**
 * @dev 结构性安全回归：这些形状在修复前要么把资金永久锁死，要么把阈值降级成单点。
 *      每个用例对应一条"同类入口全部覆盖"的判据，不是针对某次输入的补丁。
 */
contract SecurityFixesTest is NodeFixture {
    bytes32 internal constant ORDER = keccak256("security-order");

    function testOwnerlessUnstakeExitExistsWithTimeoutZero() public {
        // 默认部署 unstakeApprovalTimeout == 0；owner 丢钥时不能把卖家质押永久锁死。
        assertEq(staking.unstakeApprovalTimeout(), 0);
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        vm.prank(seller);
        staking.requestUnstake(1 ether);

        (,,, bool armed, uint256 at) = staking.unstakeState(seller);
        assertTrue(armed, "absolute auto-approve upper bound must always exist");
        assertEq(at, block.timestamp + staking.MAX_UNSTAKE_APPROVAL_TIMEOUT());

        // 还没到绝对上限：仍然必须人工批准
        vm.warp(at - 1);
        vm.prank(seller);
        vm.expectRevert(Staking.UnstakeNotApproved.selector);
        staking.claimUnstake();

        // 到绝对上限后，没有 owner 也能取回
        vm.warp(at);
        uint256 before = seller.balance;
        vm.prank(seller);
        staking.claimUnstake();
        assertEq(seller.balance, before + 1 ether);
    }

    function testRevokingWindowOpenerDoesNotUnlockWithdrawal() public {
        vm.prank(seller);
        staking.stake{value: 2 ether}();
        _order(ORDER, 1 ether);
        _rollPastTimeout(ORDER);
        escrow.releaseExpired(ORDER);

        // 两票达到阈值 -> Staking.penalize 开窗，opener = arbiter2
        _votePenalty(ORDER, 0.4 ether);
        (bool lockedBefore,) = staking.withdrawLock(seller);
        assertTrue(lockedBefore, "penalty window must lock withdrawals");

        // 吊销开窗人只停他的票；窗口锁不能因此被拆掉（同窗口其他委员仍可继续罚没）
        vm.prank(operator);
        escrow.revokeArbiter(arbiter2);
        (bool lockedAfter,) = staking.withdrawLock(seller);
        assertTrue(lockedAfter, "revoking one arbiter must not unlock the window");

        vm.prank(seller);
        staking.requestUnstake(1.6 ether);
        vm.warp(block.timestamp + staking.unlockDelay() + 1);
        vm.prank(operator);
        vm.expectRevert(Staking.PenaltyWindowLocked.selector);
        staking.approveUnstake(seller);

        // 治理的显式全局开关仍是紧急放人路径
        vm.prank(operator);
        staking.setPenaltyWindowLock(false);
        vm.prank(operator);
        staking.approveUnstake(seller);
    }

    function testBuyerArbiterCannotVoteOnOwnOrderClaim() public {
        address[] memory members = new address[](3);
        members[0] = arbiter1;
        members[1] = arbiter2;
        members[2] = buyer; // 买家同时是委员
        vm.prank(operator);
        escrow.setArbiters(members, 2);

        vm.prank(seller);
        staking.stake{value: 1 ether}();
        _order(ORDER, 1 ether);
        _rollPastTimeout(ORDER);
        escrow.releaseExpired(ORDER);

        bytes32 claimId = keccak256("buyer-own-claim");
        _openClaim(claimId, ORDER, 0.2 ether);

        // 提货赔付共享原买家的订单级受偿额度；买家是利害关系人，不能投票
        vm.prank(buyer);
        vm.expectRevert(Escrow.InvalidArbiter.selector);
        escrow.voteClaim(claimId, 0.2 ether);

        // 另一位委员仍然可以正常投票
        vm.prank(arbiter1);
        escrow.voteClaim(claimId, 0.2 ether);
        vm.prank(arbiter2);
        escrow.voteClaim(claimId, 0.2 ether);
        assertTrue(escrow.claimCase(claimId).closed);
    }

    function testForcedAfterSaleCloseKeepsPenaltyRemedyInsideWindow() public {
        /*
          90 天强制结案只释放 pending；若它同时消灭 Staking 罚没资格，生产 180 天窗口
          实际只剩 90 天救济。这里用一个 3,000,000 块窗口的节点（> 90 天绝对上限）：
          强制结案后、窗口仍有效时，委员会仍能罚没。
        */
        Escrow e2 = new Escrow(operator, GRACE, TIMEOUT, 3_000_000, address(0));
        Staking s2 = new Staking(address(e2), keccak256(address(e2).code), operator);
        address[] memory members = new address[](3);
        members[0] = arbiter1;
        members[1] = arbiter2;
        members[2] = arbiter3;
        vm.prank(operator);
        e2.setStaking(address(s2));
        vm.prank(operator);
        e2.setArbiters(members, 2);

        vm.prank(seller);
        s2.stake{value: 1 ether}();
        vm.prank(buyer);
        e2.createOrder{value: 1 ether}(ORDER, seller, 1 ether, TIMEOUT);
        vm.prank(buyer);
        e2.confirmReceipt(ORDER);
        vm.prank(buyer);
        e2.openAfterSale(ORDER);

        uint64 opened = e2.afterSaleOpenedAtBlock(ORDER);
        vm.roll(uint256(opened) + 1_555_200);
        uint256 sellerBefore = seller.balance;
        vm.prank(seller);
        e2.releaseSellerFunds(ORDER);
        assertEq(seller.balance, sellerBefore + 1 ether, "forced close releases pending");
        assertTrue(e2.afterSaleForcedClosed(ORDER));

        // 窗口 3,000,000 块，当前只过 1,555,200：罚没资格仍在
        vm.prank(arbiter1);
        e2.votePenalty(ORDER, 0.3 ether);
        vm.prank(arbiter2);
        e2.votePenalty(ORDER, 0.3 ether);
        assertEq(s2.poolOf(seller), 0.7 ether, "penalty after forced close must still execute");
    }
}
