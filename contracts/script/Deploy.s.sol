// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MarketplaceRegistry} from "../src/MarketplaceRegistry.sol";
import {ContractCodeHash} from "../src/ContractCodeHash.sol";

/**
 * @notice 平台侧部署（只有 1 个合约）：MarketplaceRegistry。
 *
 * 用法：
 *   export DEPLOYER_PRIVATE_KEY=0x...
 *   forge script script/Deploy.s.sol:DeployScript --rpc-url <rpc> --broadcast
 *
 * 初始实现哈希取**完整 runtime 字节码**的 keccak256（`ContractCodeHash`，含 metadata）：
 * 任何字节变化都会换哈希、需要重新审批。节点公开的编译产物（ABI + creation/runtime
 * bytecode + 哈希）就是给平台做这次审批、第三方做复核用的，不再有“只看可执行前缀”的捷径。
 */
contract DeployScript is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        require(block.chainid == 2999, "must deploy on BTY mainnet (chainId 2999)");

        /*
          正式部署必须把 `ESCROW_CODE_HASH` / `STAKING_CODE_HASH` 设成公开节点仓
          `node/contract-artifacts.json` 里的 runtimeCodeHash——目录审批的是**节点实际部署的
          完整字节**，平台本机另编一次会因 metadata（行尾/递归依赖/构建机）得到不同哈希。
          本地/测试不设这两个变量时才回退到本脚本自己编译的产物。
        */
        bytes32 escrowCodeHash = vm.envOr(
            "ESCROW_CODE_HASH", ContractCodeHash.ofBytes(vm.getDeployedCode("Escrow.sol:Escrow"))
        );
        bytes32 stakingCodeHash = vm.envOr(
            "STAKING_CODE_HASH", ContractCodeHash.ofBytes(vm.getDeployedCode("Staking.sol:Staking"))
        );

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
