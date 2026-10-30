// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title RuntimeCodeHash
 * @notice 实现哈希：运行时字节码**去掉末尾 solc metadata** 后的 keccak256。
 *
 * 为什么不是 `keccak256(code)`：solc 会在运行时字节码末尾附一段 CBOR metadata，
 * 内容是每个源文件的字节哈希、编译设置与源码 IPFS 哈希。于是**同一份可执行代码**换个
 * 构建环境（Windows 的 CRLF 检出、Linux 的 LF、子模块不同的行尾、源文件里的注释）就会
 * 得到另一个哈希。目录白名单按 `keccak256(code)` 放行时，节点主在另一个操作系统上构建
 * 就登记不上——白名单要认的是“这份实现被审过”，不是“这台机器这次的构建被审过”。
 *
 * 剥掉 metadata 后：可执行字节相同 ⇒ 实现哈希相同，与构建环境无关。
 *
 * 适用边界：只对**实例无关**的实现成立。Escrow/Staking 刻意把部署参数放在 storage、
 * 不用 immutable，所以同一份源码的每个实例运行时字节码一致；带 immutable 的合约每个
 * 实例的代码都不同，这个哈希不该拿来做实现白名单。
 */
library RuntimeCodeHash {
    /// @notice `account` 的实现哈希（读 `account.code`，去掉 metadata 后 keccak256）
    function forAddress(address account) internal view returns (bytes32) {
        return ofBytes(account.code);
    }

    /// @notice 一段运行时字节码的实现哈希（部署脚本用它算 Registry 的初始白名单）
    function ofBytes(bytes memory code) internal pure returns (bytes32 hash) {
        uint256 keep = _codeLength(code);
        assembly {
            hash := keccak256(add(code, 0x20), keep)
        }
    }

    /**
     * @dev 去掉末尾 CBOR metadata 后的长度；识别不出 metadata 时返回原长度。
     *
     * 三条同时成立才剥（保守优先，避免把真实代码当 metadata 切掉）：
     *   · 末尾两字节是 CBOR 段长度（大端）；
     *   · 段首是 CBOR map（0xa1..0xa4）；
     *   · 段内含 `"solc"` 键。
     * `bytecodeHash = none` 的产物没有 metadata，末尾两字节可能恰好是个小长度，
     * 但后两条不会同时成立。
     */
    function _codeLength(bytes memory code) private pure returns (uint256) {
        uint256 len = code.length;
        if (len < 4) return len;
        uint256 metaLen;
        assembly {
            metaLen := shr(240, mload(add(add(code, 0x20), sub(len, 2))))
        }
        if (metaLen < 3 || metaLen + 2 > len) return len;
        uint256 start = len - metaLen - 2;
        uint8 marker = uint8(code[start]);
        if (marker < 0xa1 || marker > 0xa4) return len;
        if (!_containsSolc(code, start, metaLen)) return len;
        return start;
    }

    /// @dev metadata 段里必须有 `"solc"`（0x73 6f 6c 63）：solc 产物的稳定标记
    function _containsSolc(bytes memory code, uint256 start, uint256 length) private pure returns (bool) {
        uint256 end = start + length - 3;
        for (uint256 i = start; i < end; ++i) {
            if (code[i] == 0x73 && code[i + 1] == 0x6f && code[i + 2] == 0x6c && code[i + 3] == 0x63) {
                return true;
            }
        }
        return false;
    }
}
