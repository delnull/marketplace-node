// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NodeFixture} from "./NodeFixture.sol";
import {Escrow} from "../src/Escrow.sol";
import {Staking} from "../src/Staking.sol";

/**
 * @dev 提货争议 deadline 的唯一入口收口：owner 传入的 deadline 在开案时被夹到
 *      「开案 + 90 天」。没有这条上界，`type(uint64).max` 会让 sellerClaimExposure
 *      永久压住卖家的自动放行出口（`claimUnstake` 只受敞口约束）。
 */
contract ClaimCaseDeadlineTest is NodeFixture {
    bytes32 constant ORDER = keccak256("claim-deadline-order");
    uint64 constant MAX_CASE_SECONDS = 90 days;

    function _settledOrderWithStake() internal {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        _order(ORDER, 1 ether);
        _rollPastTimeout(ORDER);
        escrow.releaseExpired(ORDER);
    }

    function testDeadlineIsClampedToMaxCaseDuration() public {
        _settledOrderWithStake();
        vm.prank(operator);
        escrow.openClaimDispute(
            keccak256("max-deadline"), ORDER, keccak256("token"), seller, claimant, 1, type(uint64).max
        );
        Escrow.ClaimCase memory c = escrow.claimCase(keccak256("max-deadline"));
        assertEq(c.deadline, c.openedAt + MAX_CASE_SECONDS, "deadline must be clamped at the boundary");
    }

    function testShortDeadlineIsKept() public {
        _settledOrderWithStake();
        uint64 want = uint64(block.timestamp + 7 days);
        vm.prank(operator);
        escrow.openClaimDispute(keccak256("short-deadline"), ORDER, keccak256("token"), seller, claimant, 1, want);
        assertEq(escrow.claimCase(keccak256("short-deadline")).deadline, want);
    }

    function testClaimCannotBeOpenedOrPenalizedAfterAfterSaleWindow() public {
        _settledOrderWithStake();
        uint64 settled = escrow.settledAtBlock(ORDER);
        uint64 window = escrow.afterSaleWindowAtSettle(ORDER);
        bytes32 claimId = keccak256("window-claim");

        vm.prank(operator);
        escrow.openClaimDispute(claimId, ORDER, keccak256("window-token"), seller, claimant, 1, uint64(block.timestamp + 1 days));
        vm.roll(uint256(settled + window + 1));

        // 已经过了可追罚窗口：不能再用新开案锁卖家敞口。
        vm.prank(operator);
        vm.expectRevert(Escrow.AfterSaleWindowClosed.selector);
        escrow.openClaimDispute(
            keccak256("late-claim"), ORDER, keccak256("late-token"), seller, claimant, 1, uint64(block.timestamp + 1 days)
        );

        // 已开的案也不能在窗口外完成罚没。
        vm.prank(arbiter1);
        escrow.voteClaim(claimId, 1);
        vm.prank(arbiter2);
        vm.expectRevert(Staking.PenaltyWindowElapsed.selector);
        escrow.voteClaim(claimId, 1);
    }

    function testAfterClampedDeadlineAnyoneCanCancelAndSellerCanUseOwnerlessExit() public {
        // owner 显式打开“自动放行”出口（默认 0 = 关闭），再用 1 wei 争议压住它。
        vm.prank(operator);
        staking.setUnstakeApprovalTimeout(1 days);
        _settledOrderWithStake();

        vm.prank(operator);
        escrow.openClaimDispute(
            keccak256("lock-claim"), ORDER, keccak256("token"), seller, claimant, 1, type(uint64).max
        );

        vm.prank(seller);
        staking.requestUnstake(1 ether);
        vm.warp(block.timestamp + 8 days);
        vm.prank(seller);
        vm.expectRevert(Staking.BelowRequiredFloor.selector);
        staking.claimUnstake();

        // 90 天后 deadline 到期：任何人（这里由卖家自己）可撤销并释放敞口。
        vm.warp(uint256(escrow.claimCase(keccak256("lock-claim")).deadline) + 1);
        vm.prank(seller);
        escrow.cancelClaimDispute(keccak256("lock-claim"), "expired");
        assertEq(escrow.sellerClaimExposure(seller), 0);
        assertTrue(escrow.claimCase(keccak256("lock-claim")).closed);

        uint256 before = seller.balance;
        vm.prank(seller);
        staking.claimUnstake();
        assertEq(seller.balance, before + 1 ether, "ownerless exit must work after the case expires");
    }
}
