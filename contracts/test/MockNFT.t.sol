// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockNFT} from "./MockNFT.sol";

contract MockNFTTest is Test {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    MockNFT internal nft;

    function setUp() public {
        nft = new MockNFT();
    }

    function testMintAndTransferEmitsTransfer() public {
        address buyer = makeAddr("buyer");
        nft.mint(address(this), 1);
        assertEq(nft.ownerOf(1), address(this));

        vm.expectEmit(true, true, true, true, address(nft));
        emit Transfer(address(this), buyer, 1);
        nft.transferFrom(address(this), buyer, 1);
        assertEq(nft.ownerOf(1), buyer);
    }
}
