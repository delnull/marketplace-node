// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MarketplaceRegistry} from "../src/MarketplaceRegistry.sol";

/**
 * @notice 平台侧部署（只有 1 个合约）：MarketplaceRegistry。
 *
 * 用法：
 *   export DEPLOYER_PRIVATE_KEY=0x...
 *   forge script script/Deploy.s.sol:DeployScript --rpc-url <rpc> --broadcast
 *
 * 初始实现哈希直接从本批编译产物取运行时字节码哈希（Escrow 无 immutable；Staking 已改为
 * storage 配置，运行时字节码与实例无关）。节点必须使用同一份产物/编译设置，否则登记时
 * 代码哈希对不上。
 */
contract DeployScript is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        require(block.chainid == 2999, "must deploy on BTY mainnet (chainId 2999)");

        bytes32 escrowCodeHash = keccak256(vm.getDeployedCode("Escrow.sol:Escrow"));
        bytes32 stakingCodeHash = keccak256(vm.getDeployedCode("Staking.sol:Staking"));

        console2.log("deployer:", deployer);
        console2.log("chainId:", block.chainid);
        console2.logBytes32(escrowCodeHash);
        console2.logBytes32(stakingCodeHash);

        vm.startBroadcast(deployerKey);
        MarketplaceRegistry registry = new MarketplaceRegistry(deployer, escrowCodeHash, stakingCodeHash);
        vm.stopBroadcast();

        console2.log("MarketplaceRegistry:", address(registry));
    }
}
