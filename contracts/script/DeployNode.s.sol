// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Escrow} from "../src/Escrow.sol";
import {Staking} from "../src/Staking.sol";
import {TokenPayoutVault} from "../src/TokenPayoutVault.sol";
import {NodeGovernance} from "../src/NodeGovernance.sol";

/**
 * @notice 节点侧部署：Escrow + Staking + NodeGovernance（不依赖任何 Registry）。
 *
 * 用法：
 *   export DEPLOYER_PRIVATE_KEY=0x...      # 节点 operator（同时是 Escrow/Staking 的 owner）
 *   export ARBITERS=0x...,0x...,0x...     # 委员会成员（逗号分隔，至少 3 人、阈值 < 人数）
 *   export ARBITER_THRESHOLD=2             # 可选，缺省 = 多数；必须小于成员数
 *   export REJECT_GRACE_BLOCKS=17280
 *   export MIN_TIMEOUT_BLOCKS=17280
 *   export AFTER_SALE_WINDOW_BLOCKS=3110400
 *   forge script script/DeployNode.s.sol:DeployNodeScript --rpc-url <rpc> --broadcast
 *
 * 顺序固定：TokenPayoutVault → Escrow → vault.setEscrow → Staking → escrow.setStaking → escrow.setArbiters
 *          → NodeGovernance → escrow.setGovernor → staking.setGovernor。
 * 完成后可以把这个节点登记到**任意多个** Registry（每个目录各签一次登记签名）。
 */
contract DeployNodeScript is Script {
    function run() external {
        uint256 operatorKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address operator = vm.addr(operatorKey);
        address[] memory arbiters = _parseArbiters(vm.envString("ARBITERS"));
        uint256 threshold = vm.envOr("ARBITER_THRESHOLD", arbiters.length / 2 + 1);
        uint64 rejectGrace = _envUint64("REJECT_GRACE_BLOCKS", 17_280);
        uint64 minTimeout = _envUint64("MIN_TIMEOUT_BLOCKS", 17_280);
        uint64 afterSale = _envUint64("AFTER_SALE_WINDOW_BLOCKS", 3_110_400);
        require(block.chainid == 2999, "must deploy on BTY mainnet (chainId 2999)");

        _validateArbiters(arbiters, threshold, operator);

        vm.startBroadcast(operatorKey);
        // 先部署挂账合约，再把地址写进 Escrow 的 storage；最后把 vault 的 credit 权限绑到 Escrow。
        // 圆形依赖用“先 vault(owner) → escrow(vault) → vault.setEscrow(escrow)”解开。
        TokenPayoutVault vault = new TokenPayoutVault(operator);
        Escrow escrow = new Escrow(operator, rejectGrace, minTimeout, afterSale, address(vault));
        vault.setEscrow(address(escrow));
        bytes32 escrowCodeHash = keccak256(address(escrow).code);
        Staking staking = new Staking(address(escrow), escrowCodeHash, operator);
        escrow.setStaking(address(staking));
        escrow.setArbiters(arbiters, uint16(threshold));
        NodeGovernance gov = new NodeGovernance(address(escrow), address(staking));
        escrow.setGovernor(address(gov));
        staking.setGovernor(address(gov));
        vm.stopBroadcast();

        console2.log("operator:", operator);
        console2.log("Escrow:", address(escrow));
        console2.log("Staking:", address(staking));
        console2.log("TokenPayoutVault:", address(vault));
        console2.log("NodeGovernance:", address(gov));
        console2.logBytes32(escrowCodeHash);
        console2.log("next: register this node in one or more registries (signature per registry)");
    }

    function _parseArbiters(string memory raw) internal pure returns (address[] memory) {
        require(bytes(raw).length > 0, "ARBITERS: empty (comma separated, at least one)");
        string[] memory parts = vm.split(raw, ",");
        address[] memory out = new address[](parts.length);
        for (uint256 i = 0; i < parts.length; ++i) {
            string memory part = vm.trim(parts[i]);
            require(bytes(part).length > 0, "ARBITERS: empty entry (stray comma?)");
            out[i] = vm.parseAddress(part);
        }
        return out;
    }

    function _validateArbiters(address[] memory arbiters, uint256 threshold, address owner) internal pure {
        require(arbiters.length >= 3, "arbiters: at least 3 (2-of-2 has no recovery path)");
        require(arbiters.length <= 20, "arbiters: max 20");
        require(threshold >= 1 && threshold < arbiters.length, "threshold must be < member count");
        bool ownerInList = false;
        for (uint256 i = 0; i < arbiters.length; ++i) {
            require(arbiters[i] != address(0), "arbiter: zero");
            if (arbiters[i] == owner) ownerInList = true;
            for (uint256 j = 0; j < i; ++j) {
                require(arbiters[i] != arbiters[j], "arbiter: duplicate");
            }
        }
        if (ownerInList) {
            require(arbiters.length >= 3, "owner-arbiter: committee >= 3");
            require(threshold >= 2, "owner-arbiter: threshold >= 2");
        }
    }

    function _envUint64(string memory key, uint256 dflt) private view returns (uint64) {
        uint256 v = vm.envOr(key, dflt);
        require(v <= type(uint64).max, "value exceeds uint64");
        return uint64(v);
    }
}
