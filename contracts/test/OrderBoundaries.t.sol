// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NodeFixture} from "./NodeFixture.sol";
import {Escrow} from "../src/Escrow.sol";

/**
 * @dev 订单状态机里**恰好等于边界**的那一格。
 *
 * 这些用例不重复"正常路径"（见 Protocol.t.sol），只钉住 `<=` / `<`、`>=` / `>` 的选择：
 * 差一块的语义变化是买家能否申请退款、卖家能否释放、案件能否开/关、票是否还生效。
 * 边界写错时正常路径仍然全绿，只有这些用例会红。
 */
contract OrderBoundariesTest is NodeFixture {
    uint64 internal constant MIN_ORDER = 17_280;
    uint64 internal constant MAX_ORDER = 518_400;
    uint64 internal constant MIN_WINDOW = 17_280;
    uint64 internal constant MAX_WINDOW = 6_220_800;
    uint64 internal constant MAX_REJECT = 172_800;
    uint64 internal constant MAX_AFTER_SALE_CASE = 1_555_200;

    function _newEscrow(uint64 grace, uint64 timeout, uint64 afterSale) internal returns (Escrow) {
        return new Escrow(operator, grace, timeout, afterSale, address(tokenVault));
    }

    function _create(bytes32 id, uint64 timeout) internal {
        vm.prank(buyer);
        escrow.createOrder{value: 1 ether}(id, seller, 1 ether, timeout);
    }

    function testConstructorWindowBoundaries() public {
        _newEscrow(MIN_WINDOW, MIN_ORDER, MIN_WINDOW); // 三个下界本身合法
        _newEscrow(MAX_REJECT, MAX_ORDER, MAX_WINDOW); // 三个上界本身合法

        vm.expectRevert(Escrow.InvalidTokenVault.selector);
        new Escrow(operator, MIN_WINDOW, MIN_ORDER, MIN_WINDOW, address(0xdead));

        vm.expectRevert(Escrow.InvalidRejectGrace.selector);
        _newEscrow(MIN_WINDOW - 1, MIN_ORDER, MIN_WINDOW);
        vm.expectRevert(Escrow.InvalidRejectGrace.selector);
        _newEscrow(MAX_REJECT + 1, MIN_ORDER, MIN_WINDOW);

        vm.expectRevert(Escrow.InvalidMinTimeout.selector);
        _newEscrow(MIN_WINDOW, MIN_ORDER - 1, MIN_WINDOW);
        vm.expectRevert(Escrow.InvalidMinTimeout.selector);
        _newEscrow(MIN_WINDOW, MAX_ORDER + 1, MIN_WINDOW);

        vm.expectRevert(Escrow.InvalidAfterSaleWindow.selector);
        _newEscrow(MIN_WINDOW, MIN_ORDER, MIN_WINDOW - 1);
        vm.expectRevert(Escrow.InvalidAfterSaleWindow.selector);
        _newEscrow(MIN_WINDOW, MIN_ORDER, MAX_WINDOW + 1);
    }

    function testCreateOrderTimeoutBoundaries() public {
        bytes32 id = keccak256("timeout-bounds");

        vm.prank(buyer);
        vm.expectRevert(Escrow.InvalidTimeout.selector);
        escrow.createOrder{value: 1 ether}(id, seller, 1 ether, 0);

        vm.prank(buyer);
        vm.expectRevert(Escrow.TimeoutTooShort.selector);
        escrow.createOrder{value: 1 ether}(id, seller, 1 ether, MIN_ORDER - 1);

        _create(id, MIN_ORDER);
        assertEq(escrow.getOrder(id).timeoutBlocks, MIN_ORDER);

        bytes32 idMax = keccak256("timeout-max");
        _create(idMax, MAX_ORDER);
        assertEq(escrow.getOrder(idMax).timeoutBlocks, MAX_ORDER);

        vm.prank(buyer);
        vm.expectRevert(Escrow.InvalidTimeout.selector);
        escrow.createOrder{value: 1 ether}(keccak256("timeout-over"), seller, 1 ether, MAX_ORDER + 1);
    }

    function testRefundRequestAtTimeoutAndReleaseAtNextBlock() public {
        _create(keccak256("refund-exact"), TIMEOUT);
        Escrow.Order memory o = escrow.getOrder(keccak256("refund-exact"));

        // 合约写的是 `block.number > createdAt + timeout` 才拒绝退款 ⇒ 等于阈值仍可申请。
        vm.roll(uint256(o.createdAtBlock) + uint256(o.timeoutBlocks));
        vm.prank(buyer);
        escrow.requestRefund(keccak256("refund-exact"));
        assertTrue(escrow.getOrder(keccak256("refund-exact")).refundRequested);

        // 释放要求严格晚于超时块；等于阈值仍被 InvalidTimeout 挡住。
        _create(keccak256("release-exact"), TIMEOUT);
        o = escrow.getOrder(keccak256("release-exact"));
        vm.roll(uint256(o.createdAtBlock) + uint256(o.timeoutBlocks));
        vm.expectRevert(Escrow.InvalidTimeout.selector);
        escrow.releaseExpired(keccak256("release-exact"));
        vm.roll(block.number + 1);
        escrow.releaseExpired(keccak256("release-exact"));
        assertEq(uint8(escrow.getOrder(keccak256("release-exact")).status), uint8(Escrow.OrderStatus.Settled));
    }

    function testRefundRequestOneBlockAfterTimeoutReverts() public {
        _create(keccak256("refund-late"), TIMEOUT);
        Escrow.Order memory o = escrow.getOrder(keccak256("refund-late"));
        vm.roll(uint256(o.createdAtBlock) + uint256(o.timeoutBlocks) + 1);
        vm.prank(buyer);
        vm.expectRevert(Escrow.RefundRequestTooLate.selector);
        escrow.requestRefund(keccak256("refund-late"));
    }

    function testRejectGraceExactBoundary() public {
        _create(keccak256("grace"), TIMEOUT);
        vm.roll(block.number + 1); // 让拒绝块严格晚于创建块：拒绝静置期不会被超时条件遮住
        vm.prank(buyer);
        escrow.requestRefund(keccak256("grace"));
        vm.prank(seller);
        escrow.rejectRefund(keccak256("grace"));
        uint64 rejectedAt = uint64(block.number);

        vm.roll(uint256(rejectedAt) + uint256(GRACE));
        vm.expectRevert(Escrow.RejectGraceActive.selector);
        escrow.releaseExpired(keccak256("grace"));

        vm.roll(block.number + 1);
        escrow.releaseExpired(keccak256("grace"));
    }

    function testAfterSaleWindowExactBoundary() public {
        _create(keccak256("after-sale-exact"), TIMEOUT);
        vm.prank(buyer);
        escrow.confirmReceipt(keccak256("after-sale-exact"));
        uint64 settled = escrow.settledAtBlock(keccak256("after-sale-exact"));
        uint64 window = escrow.afterSaleWindowBlocksOf(keccak256("after-sale-exact"));

        // 窗口包含右端点：settled + window 仍可开案。
        vm.roll(uint256(settled) + uint256(window));
        vm.prank(buyer);
        escrow.openAfterSale(keccak256("after-sale-exact"));
        assertTrue(escrow.afterSaleOpen(keccak256("after-sale-exact")));

        _create(keccak256("after-sale-late"), TIMEOUT);
        vm.prank(buyer);
        escrow.confirmReceipt(keccak256("after-sale-late"));
        uint64 settledLate = escrow.settledAtBlock(keccak256("after-sale-late"));
        uint64 windowLate = escrow.afterSaleWindowBlocksOf(keccak256("after-sale-late"));
        vm.roll(uint256(settledLate) + uint256(windowLate) + 1);
        vm.prank(buyer);
        vm.expectRevert(Escrow.AfterSaleWindowClosed.selector);
        escrow.openAfterSale(keccak256("after-sale-late"));
    }

    function testAfterSaleCaseAbsoluteExpiryBoundary() public {
        bytes32 id = keccak256("after-sale-expiry");
        _create(id, TIMEOUT);
        vm.prank(buyer);
        escrow.confirmReceipt(id);
        vm.prank(buyer);
        escrow.openAfterSale(id);
        uint64 opened = escrow.afterSaleOpenedAtBlock(id);

        vm.roll(uint256(opened) + uint256(MAX_AFTER_SALE_CASE) - 1);
        vm.expectRevert(Escrow.PendingCaseOpen.selector);
        escrow.releaseSellerFunds(id);

        vm.roll(block.number + 1);
        escrow.releaseSellerFunds(id);
        assertFalse(escrow.afterSaleOpen(id));
        assertEq(escrow.sellerPending(id), 0);
    }

    function testAfterSaleExpiryClosesEvenAfterPendingRefunded() public {
        bytes32 id = keccak256("after-sale-empty-pending");
        _create(id, TIMEOUT);
        vm.prank(buyer);
        escrow.confirmReceipt(id);
        vm.prank(buyer);
        escrow.openAfterSale(id);

        // 卖家在案件在途时把留存货款全部退空，随后买家消失：到期仍必须有 permissionless 出口。
        uint256 pending = escrow.sellerPending(id);
        vm.prank(seller);
        escrow.refundSettled(id, pending);
        assertEq(escrow.sellerPending(id), 0);

        uint64 opened = escrow.afterSaleOpenedAtBlock(id);
        vm.roll(uint256(opened) + uint256(MAX_AFTER_SALE_CASE));
        escrow.releaseSellerFunds(id);
        assertFalse(escrow.afterSaleOpen(id));
    }

    function testClaimVoteDeadlineExactBoundary() public {
        bytes32 orderId = keccak256("claim-deadline");
        _create(orderId, TIMEOUT);
        vm.prank(buyer);
        escrow.confirmReceipt(orderId);

        bytes32 claimId = keccak256("claim-deadline-case");
        _openClaim(claimId, orderId, 0.1 ether);
        uint64 deadline = escrow.claimCase(claimId).deadline;

        // deadline 是裁决截止：恰好等于时仍可投票。
        vm.warp(deadline);
        vm.prank(arbiter1);
        escrow.voteClaim(claimId, 0);

        // 多一秒后票不再生效；任何人可撤销并释放卖家敞口。
        vm.warp(uint256(deadline) + 1);
        vm.prank(arbiter2);
        vm.expectRevert(Escrow.ClaimDeadlinePassed.selector);
        escrow.voteClaim(claimId, 0);

        vm.prank(claimant);
        escrow.cancelClaimDispute(claimId, "deadline");
        assertTrue(escrow.claimCase(claimId).closed);
        assertEq(escrow.sellerClaimExposure(seller), 0);
    }

    function testRefundAmountExactBoundaries() public {
        bytes32 id = keccak256("refund-amount");
        _create(id, TIMEOUT);

        vm.prank(seller);
        vm.expectRevert(Escrow.RefundAmountOutOfRange.selector);
        escrow.approveRefund(id, 1 ether + 1);

        // 非全额且未经买家授权（包括 0）不能退。
        vm.prank(seller);
        vm.expectRevert(Escrow.RefundAmountNotAccepted.selector);
        escrow.approveRefund(id, 0);
        vm.prank(seller);
        vm.expectRevert(Escrow.RefundAmountNotAccepted.selector);
        escrow.approveRefund(id, 1 ether - 1);

        // 全额不需要授权；恰好等于托管额。
        vm.prank(seller);
        escrow.approveRefund(id, 1 ether);
        assertEq(uint8(escrow.getOrder(id).status), uint8(Escrow.OrderStatus.Refunded));
    }

    function testPendingRefundAmountExactBoundaries() public {
        bytes32 id = keccak256("pending-amount");
        _create(id, TIMEOUT);
        vm.prank(buyer);
        escrow.confirmReceipt(id);
        uint256 pending = escrow.sellerPending(id);

        vm.prank(seller);
        vm.expectRevert(Escrow.PendingAmountTooLarge.selector);
        escrow.refundSettled(id, 0);
        vm.prank(seller);
        vm.expectRevert(Escrow.PendingAmountTooLarge.selector);
        escrow.refundSettled(id, pending + 1);

        vm.prank(seller);
        escrow.refundSettled(id, 1);
        assertEq(escrow.sellerPending(id), pending - 1);
    }
}
