// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev Safe v1.3 `CompatibilityFallbackHandler` 的最小**语义**替身（不是只回魔数的桩）：
 *   · `isValidSignature(bytes32,bytes)` 按 Safe 的 bytes32 重载行为返回失败（它会把 digest
 *     再包成 SafeMessage，因此 `signMessage(inner)` 的标准路径永远不中）；
 *   · `isValidSignature(bytes,bytes)` 按 Safe 的 `getMessageHashForSafe(safe, data)` 计算
 *     `SafeMessage(data)`，再用 owner 的 ECDSA 签名恢复；命中返回旧魔数 0x20c13b0b。
 *
 * 这样测试必须真的对 `SafeMessage(inner)` 签名才能过，能证明 legacy 分支不是“传什么签名都收”。
 */
contract MockSafe1271 {
    bytes32 private constant SAFE_MSG_TYPEHASH = keccak256("SafeMessage(bytes message)");
    bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH =
        keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    /// @dev 与 Safe v1.3 `getMessageHashForSafe(address(this), message)` 同一算式
    function messageHash(bytes memory message) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, block.chainid, address(this)));
        bytes32 safeMessage = keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(message)));
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domain, safeMessage));
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return bytes4(0xffffffff);
    }

    function isValidSignature(bytes calldata data, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return bytes4(0xffffffff);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        return ecrecover(messageHash(data), v, r, s) == owner ? bytes4(0x20c13b0b) : bytes4(0xffffffff);
    }
}
