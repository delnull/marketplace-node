// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev 最小的 EIP-1271 合约账户替身：测试把 (digest, keccak256(signature)) 置为有效，
 *      `isValidSignature` 返回标准魔数；无效时返回 0xffffffff。
 *
 * 为什么需要它：`MarketplaceRegistry` 的注册/开店/转让签名已从"只能 ECDSA recover"
 * 扩展为"EOA 走 ECDSA、合约账户走 EIP-1271"。没有这个替身，合约账户路径在 Forge 里
 * 根本不可达，改坏了也全绿。
 */
contract MockERC1271 {
    mapping(bytes32 => mapping(bytes32 => bool)) private _valid;

    function setValid(bytes32 digest, bytes calldata signature, bool ok) external {
        _valid[digest][keccak256(signature)] = ok;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        return _valid[digest][keccak256(signature)] ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    /// @dev 供"合约节点主自己发起 registerShop"的用例：msg.sender 必须是本合约
    function registerShopAsHost(
        address registry,
        address seller,
        uint16 commissionBps,
        uint64 deadline,
        bytes calldata hostSig,
        bytes calldata sellerSig
    ) external {
        (bool ok, bytes memory ret) = registry.call(
            abi.encodeWithSignature(
                "registerShop(address,uint16,uint64,bytes,bytes)", seller, commissionBps, deadline, hostSig, sellerSig
            )
        );
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
