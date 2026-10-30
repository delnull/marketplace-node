// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RuntimeCodeHash} from "../src/RuntimeCodeHash.sol";

/**
 * @dev 实现哈希的判据：solc metadata（含源文件字节哈希）不参与身份，可执行字节才参与。
 *      这是“节点主在 Linux/Windows 上构建都能登记”的根据。
 */
contract RuntimeCodeHashTest is Test {
    function testArtifactMetadataIsStripped() public view {
        bytes memory art = vm.getDeployedCode("Escrow.sol:Escrow");
        uint256 start = _metadataStart(art);
        assertEq(art.length - start, 53, "solc 0.8.24 metadata must be 51B CBOR + 2B length");
        assertTrue(keccak256(art) != RuntimeCodeHash.ofBytes(art), "artifact must carry metadata");
        assertEq(RuntimeCodeHash.ofBytes(art), _keccakPrefix(art, start));
    }

    function testMetadataOnlyVariantHasSameImplementationHash() public pure {
        bytes memory a = _code(_suffix(bytes32(uint256(1))));
        bytes memory b = _code(_suffix(bytes32(uint256(2))));
        assertTrue(keccak256(a) != keccak256(b), "raw build hashes must differ");
        assertEq(RuntimeCodeHash.ofBytes(a), RuntimeCodeHash.ofBytes(b), "implementation hash must match");
        assertEq(RuntimeCodeHash.ofBytes(a), _keccakPrefix(a, _metadataStart(a)));
    }

    function testArtifactIpfsHashDoesNotMoveImplementationHash() public view {
        bytes memory art = vm.getDeployedCode("Escrow.sol:Escrow");
        bytes32 before = RuntimeCodeHash.ofBytes(art);
        // 32 字节 IPFS 哈希位于后缀起点 +10（a2 64 'ipfs' 58 22 12 20）
        art[_metadataStart(art) + 10] ^= 0xff;
        assertTrue(keccak256(art) != keccak256(vm.getDeployedCode("Escrow.sol:Escrow")), "raw hash must move");
        assertEq(RuntimeCodeHash.ofBytes(art), before, "implementation hash must not move");
    }

    function testCodeWithoutMetadataHashesWhole() public pure {
        bytes memory code = hex"6001600055";
        assertEq(RuntimeCodeHash.ofBytes(code), _keccakPrefix(code, code.length));
    }

    function testUnrecognizedTailIsNotStripped() public pure {
        // 尾部像 CBOR（长度 3、段首 0xa1）但没有 "solc"：不能当成 metadata 切掉。
        bytes memory code = abi.encodePacked(hex"6001600055", hex"a161780003");
        assertEq(RuntimeCodeHash.ofBytes(code), _keccakPrefix(code, code.length));
    }

    function testShortCodeHashesWhole() public pure {
        bytes memory code = hex"6001";
        assertEq(RuntimeCodeHash.ofBytes(code), _keccakPrefix(code, code.length));
    }

    /// @dev 末尾两字节 = CBOR 段长度（大端）；段起点 = 总长 - 长度 - 2
    function _metadataStart(bytes memory code) private pure returns (uint256) {
        uint256 metaLen = (uint256(uint8(code[code.length - 2])) << 8) | uint8(code[code.length - 1]);
        return code.length - metaLen - 2;
    }

    function _code(bytes memory suffix) private pure returns (bytes memory) {
        return abi.encodePacked(hex"60016000556000", suffix);
    }

    function _suffix(bytes32 ipfsHash) private pure returns (bytes memory) {
        return abi.encodePacked(hex"a2646970667358221220", ipfsHash, hex"64736f6c63430008180033");
    }

    function _keccakPrefix(bytes memory data, uint256 len) private pure returns (bytes32 h) {
        assembly {
            h := keccak256(add(data, 0x20), len)
        }
    }
}
