// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ContractCodeHash
 * @notice 合约**全量运行时字节码**的 keccak256（包含 solc metadata）。
 *
 * 目录白名单认的是"这份完整 runtime 被审过"：任何字节变化（包括 metadata、编译器设置、
 * 源文件哈希）都必须换哈希、重新审批。旧实现只哈希去掉 metadata 的前缀，攻击者可在
 * 已批准前缀后追加一段伪造 metadata 得到不同代码却命中同一白名单，因此已删除。
 *
 * 代价如实写：换构建环境（CRLF/LF、注释、优化器设置、IPFS 源哈希）会得到不同哈希，
 * 平台必须按**这次实际部署的完整产物**审批。节点公开的编译产物（ABI + creation/runtime
 * bytecode + 全量哈希）就是给平台做这次审批用的，不再有"只看可执行前缀"的捷径。
 */
library ContractCodeHash {
    /// @notice `account` 的全量运行时字节码哈希
    function forAddress(address account) internal view returns (bytes32) {
        return keccak256(account.code);
    }

    /// @notice 一段运行时字节码的全量哈希（部署脚本/测试用）
    function ofBytes(bytes memory code) internal pure returns (bytes32) {
        return keccak256(code);
    }
}
