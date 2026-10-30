// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MarketplaceRegistry} from "../src/MarketplaceRegistry.sol";
import {RuntimeCodeHash} from "../src/RuntimeCodeHash.sol";
import {Escrow} from "../src/Escrow.sol";
import {Staking} from "../src/Staking.sol";
import {TokenPayoutVault} from "../src/TokenPayoutVault.sol";

/**
 * @dev 新形状的共用夹具：平台 Registry + 一个节点栈（Escrow + Staking + 委员会），
 *      节点已登记。所有测试从"平台已部署、节点已接线、委员会已就位"开始。
 */
abstract contract NodeFixture is Test {
    using MessageHashUtils for bytes32;

    uint256 internal constant OPERATOR_KEY = 0xB0B;
    uint256 internal constant ARB1_KEY = 0xC1;
    uint256 internal constant ARB2_KEY = 0xC2;
    uint256 internal constant ARB3_KEY = 0xC3;
    string internal constant ENDPOINT = "https://node.example.com";
    uint64 internal constant GRACE = 17_280;
    uint64 internal constant TIMEOUT = 17_280;
    uint64 internal constant AFTER_SALE = 17_280;

    address internal operator;
    address internal arbiter1;
    address internal arbiter2;
    address internal arbiter3;
    address internal buyer;
    address internal seller;
    address internal claimant;

    MarketplaceRegistry internal registry;
    Escrow internal escrow;
    Staking internal staking;
    TokenPayoutVault internal tokenVault;

    function setUp() public virtual {
        vm.chainId(2999);
        operator = vm.addr(OPERATOR_KEY);
        arbiter1 = vm.addr(ARB1_KEY);
        arbiter2 = vm.addr(ARB2_KEY);
        arbiter3 = vm.addr(ARB3_KEY);
        buyer = makeAddr("buyer");
        seller = makeAddr("seller");
        claimant = makeAddr("claimant");

        vm.deal(operator, 1000 ether);
        vm.deal(buyer, 1000 ether);
        vm.deal(seller, 1000 ether);
        vm.deal(claimant, 10 ether);

        bytes32 escrowHash = RuntimeCodeHash.ofBytes(vm.getDeployedCode("Escrow.sol:Escrow"));
        bytes32 stakingHash = RuntimeCodeHash.ofBytes(vm.getDeployedCode("Staking.sol:Staking"));
        registry = new MarketplaceRegistry(address(this), escrowHash, stakingHash);

        vm.startPrank(operator);
        tokenVault = new TokenPayoutVault(operator);
        escrow = new Escrow(operator, GRACE, TIMEOUT, AFTER_SALE, address(tokenVault));
        tokenVault.setEscrow(address(escrow));
        staking = new Staking(address(escrow), keccak256(address(escrow).code), operator);
        escrow.setStaking(address(staking));
        address[] memory members = new address[](3);
        members[0] = arbiter1;
        members[1] = arbiter2;
        members[2] = arbiter3;
        // 3 人/阈值 2：任何一人失联都还能凑够票，且 2-of-2 的“丢钥即永久冻结”不可表达。
        escrow.setArbiters(members, 2);
        vm.stopPrank();

        _register(operator, address(escrow), address(staking), OPERATOR_KEY);
    }

    function _register(address op, address esc, address stk, uint256 key) internal {
        registry.registerNode(op, ENDPOINT, esc, stk, _signRegistration(ENDPOINT, esc, stk, key));
    }

    function _signRegistration(string memory endpoint, address esc, address stk, uint256 key)
        internal
        returns (bytes memory)
    {
        return _signRegistrationFor(address(registry), endpoint, esc, stk, key);
    }

    function _signRegistrationFor(address targetRegistry, string memory endpoint, address esc, address stk, uint256 key)
        internal
        returns (bytes memory)
    {
        bytes32 inner = keccak256(abi.encode(endpoint, esc, stk, block.chainid, targetRegistry));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, inner.toEthSignedMessageHash());
        return abi.encodePacked(r, s, v);
    }

    function _order(bytes32 id, uint256 amount) internal returns (Escrow.Order memory o) {
        vm.prank(buyer);
        escrow.createOrder{value: amount}(id, seller, amount, TIMEOUT);
        return escrow.getOrder(id);
    }

    function _rollPastTimeout(bytes32 id) internal {
        Escrow.Order memory o = escrow.getOrder(id);
        vm.roll(uint256(o.createdAtBlock) + uint256(o.timeoutBlocks) + 1);
    }

    function _voteSettlement(bytes32 id, uint256 refundWei) internal {
        vm.prank(arbiter1);
        escrow.voteSettlement(id, refundWei);
        vm.prank(arbiter2);
        escrow.voteSettlement(id, refundWei);
    }

    function _votePenalty(bytes32 id, uint256 amountWei) internal {
        vm.prank(arbiter1);
        escrow.votePenalty(id, amountWei);
        vm.prank(arbiter2);
        escrow.votePenalty(id, amountWei);
    }

    function _voteAfterSale(bytes32 id, uint256 penaltyWei) internal {
        vm.prank(arbiter1);
        escrow.voteAfterSale(id, penaltyWei);
        vm.prank(arbiter2);
        escrow.voteAfterSale(id, penaltyWei);
    }

    function _voteClaim(bytes32 claimId, uint256 amountWei) internal {
        vm.prank(arbiter1);
        escrow.voteClaim(claimId, amountWei);
        vm.prank(arbiter2);
        escrow.voteClaim(claimId, amountWei);
    }

    function _openClaim(bytes32 claimId, bytes32 orderId, uint256 amount) internal {
        vm.prank(operator);
        escrow.openClaimDispute(
            claimId, orderId, keccak256(abi.encode(claimId)), seller, claimant, amount, uint64(block.timestamp + 30 days)
        );
    }
}
