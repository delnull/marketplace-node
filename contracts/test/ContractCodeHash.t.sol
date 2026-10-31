// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ContractCodeHash} from "../src/ContractCodeHash.sol";
import {Escrow} from "../src/Escrow.sol";
import {Staking} from "../src/Staking.sol";

/**
 * @dev 全量合约哈希的判据：不剥任何尾部字节，metadata 变一个字节就必须变哈希。
 *      旧的"去 metadata 前缀哈希"已删除，这里专门钉住"不会再退回前缀承诺"。
 */
contract ContractCodeHashTest is Test {
    Escrow private escrow;
    Staking private staking;

    function setUp() public {
        address owner = makeAddr("hash-owner");
        address[] memory members = new address[](3);
        members[0] = makeAddr("hash-arb1");
        members[1] = makeAddr("hash-arb2");
        members[2] = makeAddr("hash-arb3");
        escrow = new Escrow(owner, 17_280, 17_280, 17_280, address(0));
        staking = new Staking(address(escrow), keccak256(address(escrow).code), owner);
        vm.prank(owner);
        escrow.setStaking(address(staking));
        vm.prank(owner);
        escrow.setArbiters(members, 2);
    }

    function testArtifactHashIsWholeRuntime() public view {
        bytes memory art = vm.getDeployedCode("Escrow.sol:Escrow");
        assertEq(ContractCodeHash.ofBytes(art), keccak256(art));
        assertTrue(art.length > 2, "artifact must not be empty");
    }

    function testMetadataChangeMovesHash() public pure {
        bytes memory a = hex"6000600055600a600055";
        bytes memory b = hex"6000600055600a600055a164736f6c6343000818";
        assertTrue(ContractCodeHash.ofBytes(a) != ContractCodeHash.ofBytes(b), "metadata must be part of identity");
    }

    function testCodeWithoutMetadataHashesWhole() public pure {
        bytes memory code = hex"600160005260206000f3";
        assertEq(ContractCodeHash.ofBytes(code), keccak256(code));
    }

    function testShortCodeHashesWhole() public pure {
        bytes memory code = hex"00";
        assertEq(ContractCodeHash.ofBytes(code), keccak256(code));
    }

    function testAddressHashEqualsDeployedCodeHash() public view {
        assertEq(ContractCodeHash.forAddress(address(escrow)), keccak256(address(escrow).code));
        assertEq(ContractCodeHash.forAddress(address(staking)), keccak256(address(staking).code));
    }
}
