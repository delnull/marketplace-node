// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MarketplaceRegistry} from "../src/MarketplaceRegistry.sol";
import {RuntimeCodeHash} from "../src/RuntimeCodeHash.sol";

/**
 * @notice 平台侧部署（只有 1 个合约）：MarketplaceRegistry。
 *
 * 用法：
 *   export DEPLOYER_PRIVATE_KEY=0x...
 *   forge script script/Deploy.s.sol:DeployScript --rpc-url <rpc> --broadcast
 *
 * 初始实现哈希取运行时字节码**去掉 solc metadata** 后的哈希（`RuntimeCodeHash`）：
 * Escrow/Staking 无 immutable，同一份源码在任何机器/行尾下构建出的可执行字节一致，
 * 实现哈希就一致——节点主在 Windows 还是 Linux 上构建都能命中同一份白名单。
 * 改可执行代码仍会改变哈希，白名单的“只认审过的实现”不放宽。
 */
contract DeployScript is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        require(block.chainid == 2999, "must deploy on BTY mainnet (chainId 2999)");

        bytes32 escrowCodeHash = RuntimeCodeHash.ofBytes(vm.getDeployedCode("Escrow.sol:Escrow"));
        bytes32 stakingCodeHash = RuntimeCodeHash.ofBytes(vm.getDeployedCode("Staking.sol:Staking"));

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
