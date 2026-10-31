// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NodeFixture} from "./NodeFixture.sol";
import {Escrow} from "../src/Escrow.sol";
import {MarketplaceRegistry} from "../src/MarketplaceRegistry.sol";
import {ContractCodeHash} from "../src/ContractCodeHash.sol";
import {Vm} from "forge-std/Vm.sol";

/**
 * @dev 链上/链下 ABI 契约的机械判据：元组字数、字段顺序、事件签名。
 *      node/src/chain.js、frontend/src/chain.ts、Staking 的 IEscrowMinimal 都按位置解码，
 *      这些形状一变就必须同批改；这个测试是先红的那一个。
 */
contract AbiContractTest is NodeFixture {
    bytes32 internal constant ORDER1 = bytes32(uint256(1));

    function testOrderTupleIsExactly10Words() public {
        _order(ORDER1, 1 ether);
        (bool ok, bytes memory ret) =
            address(escrow).staticcall(abi.encodeWithSignature("getOrder(bytes32)", ORDER1));
        assertTrue(ok, "getOrder");
        assertEq(ret.length, 32 * 10, "Order tuple must be 10 words");

        (
            address buyer_,
            address seller_,
            uint256 amount_,
            uint64 timeoutBlocks_,
            uint64 createdAtBlock_,
            bool refundRequested_,
            bool refundRejected_,
            uint256 refundedAmount_,
            uint8 status_,
            bool buyerConfirmed_
        ) = abi.decode(ret, (address, address, uint256, uint64, uint64, bool, bool, uint256, uint8, bool));
        assertEq(buyer_, buyer);
        assertEq(seller_, seller);
        assertEq(amount_, 1 ether);
        assertEq(timeoutBlocks_, TIMEOUT);
        assertTrue(createdAtBlock_ > 0);
        assertFalse(refundRequested_);
        assertFalse(refundRejected_);
        assertEq(refundedAmount_, 0);
        assertEq(status_, uint8(Escrow.OrderStatus.Created));
        assertFalse(buyerConfirmed_);
    }

    /// 节点启动期自检同时读这两个上限；只把 min 暴露成 public 会让 /healthz 永久报 unknown。
    function testTimeoutBoundsAreReadable() public view {
        assertEq(escrow.minTimeoutBlocks(), TIMEOUT);
        assertEq(escrow.MAX_TIMEOUT_BLOCKS(), 518_400);
    }

    function testNodeInfoFieldOrder() public {
        (bool ok, bytes memory ret) =
            address(registry).staticcall(abi.encodeWithSignature("getNode(address)", operator));
        assertTrue(ok, "getNode");
        // 返回单个动态 struct：word0 = 指向元组的偏移（0x20），元组头从 word1 开始。
        // 头：5 个静态值 + endpoint 偏移 + 2 个区块 + 2 个 bool = 10 个字。
        assertTrue(ret.length >= 32 * 11, "NodeInfo head must be 10 words + outer offset");
        assertEq(uint256(bytes32(_slice(ret, 0))), 32, "outer offset");
        assertEq(address(uint160(uint256(bytes32(_slice(ret, 1))))), operator);
        assertEq(address(uint160(uint256(bytes32(_slice(ret, 2))))), address(escrow));
        assertEq(bytes32(_slice(ret, 3)), ContractCodeHash.forAddress(address(escrow)));
        assertEq(address(uint160(uint256(bytes32(_slice(ret, 4))))), address(staking));
        assertEq(bytes32(_slice(ret, 5)), ContractCodeHash.forAddress(address(staking)));

        MarketplaceRegistry.NodeInfo memory n = registry.getNode(operator);
        assertEq(n.endpoint, ENDPOINT);
        assertTrue(n.registeredAtBlock > 0);
        assertTrue(n.updatedAtBlock >= n.registeredAtBlock);
        assertTrue(n.active);
        assertFalse(n.suspended);
    }

    function _slice(bytes memory data, uint256 word) private pure returns (bytes memory out) {
        out = new bytes(32);
        for (uint256 i = 0; i < 32; ++i) {
            out[i] = data[word * 32 + i];
        }
    }

    function testClaimCaseIs8Words() public {
        vm.prank(seller);
        staking.stake{value: 1 ether}();
        _order(ORDER1, 1 ether);
        _rollPastTimeout(ORDER1);
        escrow.releaseExpired(ORDER1);
        bytes32 claimId = keccak256("abi-claim");
        _openClaim(claimId, ORDER1, 0.1 ether);

        (bool ok, bytes memory ret) =
            address(escrow).staticcall(abi.encodeWithSignature("claimCase(bytes32)", claimId));
        assertTrue(ok, "claimCase");
        assertEq(ret.length, 32 * 8, "ClaimCase must be 8 words");
        (
            bytes32 orderId_,
            bytes32 tokenRef_,
            address seller_,
            address claimant_,
            uint256 amount_,
            uint64 deadline_,
            uint64 openedAt_,
            bool closed_
        ) = abi.decode(ret, (bytes32, bytes32, address, address, uint256, uint64, uint64, bool));
        assertEq(orderId_, ORDER1);
        assertEq(tokenRef_, keccak256(abi.encode(claimId)));
        assertEq(seller_, seller);
        assertEq(claimant_, claimant);
        assertEq(amount_, 0.1 ether);
        assertTrue(deadline_ > 0);
        assertTrue(openedAt_ > 0);
        assertFalse(closed_);
    }

    function testOrderCreatedEventTopic() public {
        vm.recordLogs();
        _order(ORDER1, 1 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("OrderCreated(bytes32,address,address,uint256)");
        bool found = false;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) {
                found = true;
                assertEq(address(logs[i].emitter), address(escrow));
                assertEq(logs[i].topics[1], ORDER1);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), buyer);
                assertEq(address(uint160(uint256(logs[i].topics[3]))), seller);
                break;
            }
        }
        assertTrue(found, "OrderCreated(bytes32,address,address,uint256)");
    }
}
