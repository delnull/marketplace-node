# 节点合约部署

节点自己部署并拥有下面四个合约；目录合约 `MarketplaceRegistry` 由平台部署，节点只在部署完成后用自己的钱包登记。

| 合约 | 作用 |
|---|---|
| `TokenPayoutVault` | ERC20 出金被收款方拒绝时挂账，收款人之后自行领取 |
| `Escrow` | 托管、结算、退款/售后、提货争议、接单开关 |
| `Staking` | 卖家保证金、罚没、提货赔付 |
| `NodeGovernance` | 节点主提议、委员会 2/3、2 天时间锁、快速解冻 |

合约不可升级：再部署会得到一组新地址；原合约里的托管和质押不会迁移，换合约前先把在途订单结清。

## 前置

- Foundry（版本以 CI `.github/workflows/ci.yml` 的 pin 为准）：**只有修改合约/重新生成公开编译产物时**才需要；主网部署直接使用随包 `contract-artifacts.json`，不走 `forge script`；
- BTY EVM 主网 RPC，chainId `2999`。优先用 `https://node1.bityuan.com/eth`，不可用时依次换 `https://node2.bityuan.com/eth`、`https://mainnet.bityuan.com/eth`。部署前用 `cast chain-id --rpc-url <rpc>` 确认返回 `2999`；
- gas 由 `eth_gasPrice` 给出（当前 `10 gwei`）。BTY 主网按 **gasLimit** 扣费，未用完不退，所以脚本用实测 gasUsed + 10% 的固定上限，`eth_estimateGas` 只用来确认交易不会被拒绝；不要把 gasLimit 拍高；
- operator 钱包，余额要覆盖脚本打印的 `gasCost`；这个地址就是稍后的 `MK_SHOP_OWNER`；
- 至少 3 个仲裁人地址，彼此独立；`ARBITER_THRESHOLD` 必须 ≥2 且小于人数（单人阈值会让任意一名委员单独裁决）；
- 原样使用本仓 `contracts/`。`foundry.toml` 固定了 solc 0.8.24 / optimizer runs 1 / evm_version paris；目录按 Escrow/Staking 的**全量 runtime 哈希**（`keccak256(code)`，含 metadata）放行。任何字节变化（含 metadata、行尾、注释、优化参数）都会换哈希、需重新审批；公开节点仓随包的编译产物（ABI + creation/runtime bytecode + 哈希）就是给平台审批/第三方复核用的。

## 费用

整个部署（四个合约 + 节点登记）建议钱包准备 **0.5 BTY 以上**。

其中合约部署按 `10 gwei`、3 个委员计算：gasLimit 合计 `13,290,000`，约 **0.133 BTY**。BTY 按 gasLimit 扣费，失败/重试也会消耗 gasLimit；0.5 BTY 留出 gas 价波动、重试和节点登记的费用。`--check` 会按当前 `eth_gasPrice` 重新计算并拒绝余额不足。

每多一个委员约增加 `25,000` gasLimit（`10 gwei` 下约 `0.00025 BTY`）。

## 1. 编译产物（随公开节点仓提供，无需本地 Foundry）

公开节点仓根部的 `contract-artifacts.json` 是平台/发布者从 `contracts/out` 生成的完整产物：
`{name, abi, creationCodeHash, runtimeCodeHash, bytecode, deployedBytecode}`，其中
`runtimeCodeHash = keccak256(完整 runtime bytecode，含 solc metadata)`。部署脚本直接使用这份
bytecode，并在本地校验 `keccak256(bytecode) == creationCodeHash`、
`keccak256(deployedBytecode) == runtimeCodeHash`；清单被篡改/损坏会当场拒绝。

只有**修改合约**时才需要重新生成：`cd contracts && forge build`，然后用生成脚本跑
`node scripts/build-contract-artifacts.mjs`，同批提交 `node/contract-artifacts.json`。公开仓
发布/CI 的 `build-contract-artifacts.mjs --check` 会拒绝"清单与源码构建不一致"。

## 2. 部署

```bash
export MK_RPC_URL=https://node1.bityuan.com/eth
cast chain-id --rpc-url "$MK_RPC_URL"    # 必须输出 2999

export DEPLOYER_PRIVATE_KEY=0x...       # operator；会成为 Escrow/Staking/TokenPayoutVault 的 owner
# 也可以不导私钥，改成：export MK_KEY_FILE=/path/to/key
export ARBITERS=0x...,0x...,0x...       # 至少 3 个，不能重复
export ARBITER_THRESHOLD=2              # 必须小于 ARBITERS 人数
# 可选窗口，括号里是默认值（单位：块）
export REJECT_GRACE_BLOCKS=17280        # 拒绝退款后的释放静置期
export MIN_TIMEOUT_BLOCKS=17280         # 下单允许的最小超时
export AFTER_SALE_WINDOW_BLOCKS=3110400 # 确认收货后的售后窗口

node scripts/deploy-node-mainnet.cjs --check
node scripts/deploy-node-mainnet.cjs --broadcast
```

`--check` 只读：检查 RPC、余额、nonce、gas 预算，不广播。`--broadcast` 才部署并做链上复核。

主网不用 `forge script`：BTY RPC 不接受 Forge 广播前使用的 EIP-1898 区块对象，会报
`invalid argument 1: json: cannot unmarshal object into Go value of type string`；`contracts/script/DeployNode.s.sol`
只用于本地 anvil。部署脚本用 ethers 发交易、原始 JSON-RPC 读链，顺序与 `DeployNode.s.sol` 一致：
`TokenPayoutVault` → `Escrow` → `vault.setEscrow` → `Staking` → `escrow.setStaking` → `escrow.setArbiters`
→ `NodeGovernance` → `escrow.setGovernor` / `staking.setGovernor`。

脚本自动取 `eth_gasPrice`；只有 RPC 报价异常时才临时设 `MK_GAS_PRICE`（wei）。

## 3. 记录输出

部署成功后脚本会打印一段 JSON：

```json
{
  "operator": "0x...",
  "escrow": "0x...",
  "staking": "0x...",
  "tokenPayoutVault": "0x...",
  "nodeGovernance": "0x...",
  "escrowCodeHash": "0x...",
  "startBlock": 12345678
}
```

`startBlock` 是 Escrow 的部署块，脚本直接给出。不要用当前最新块，否则节点会漏扫部署后到启动前的事件。

`escrowCodeHash` 是 Escrow 的**全量 runtime 哈希**（`keccak256(escrow.code)`，含 metadata）：既做 Staking 构造期互验，也是目录白名单/登记行钉住的同一个值。

## 4. 填进节点配置

`deploy-constants.json` 的 `contracts` 三项：

```json
"contracts": {
  "escrow": "0x...",
  "staking": "0x...",
  "startBlock": 12345678
}
```

也可以不编辑文件，把三项直接传给安装脚本：

```bash
bash deploy.sh --escrow 0x... --staking 0x... --start-block 12345678
```

命令行给的值会写回**安装目录**的 `deploy-constants.json`，后续 `--update` 不必重复带。文件里留空或 `startBlock=0` 会被 `deploy.sh` / `deploy.ps1` 当场拒绝。

`TokenPayoutVault` 和 `NodeGovernance` 不写进这个文件：节点从 `Escrow.tokenVaultAddress()` 读 vault，治理合约由 Escrow/Staking 的 `governor()` 接线。地址仍要留档，用于核对和应急。

## 5. 启动自检

节点启动时会核对，不一致直接拒绝启动：

- `Escrow.owner()` 等于 `MK_SHOP_OWNER`；
- `Escrow.staking()` 等于 `MK_STAKING_ADDRESS`，且 `Staking.owner()` 等于 `MK_SHOP_OWNER`；
- RPC 的 chainId 等于 `MK_CHAIN_ID`；
- Escrow 必须包含本版本代码要求的入口。

所以 `DEPLOYER_PRIVATE_KEY` 对应的地址必须和安装时填的节点主地址是同一个；改这个地址只能重新部署并重新登记。

部署完成后可以只读核对：

```bash
cast call <Escrow> "owner()(address)" --rpc-url <rpc>
cast call <Escrow> "staking()(address)" --rpc-url <rpc>
cast call <Escrow> "tokenVaultAddress()(address)" --rpc-url <rpc>
cast call <Escrow> "governor()(address)" --rpc-url <rpc>
```

## 6. 登记到目录

节点跑起来后，在 https://fedmall.bityuan.com 用 operator 钱包完成节点登记：endpoint 填节点对外的 HTTPS 根地址，Escrow / Staking 填上面两个地址。

目录登记会核对：

- operator 等于 Escrow / Staking 的 owner；
- 两个合约的**全量 runtime 哈希**（`keccak256(code)`，含 metadata）都在目录白名单里；
- 同一个 Escrow / Staking 没有被别的 operator 占用。

目录只放行**完整 runtime 字节**；哈希不一致时登记会报 `ImplementationNotApproved`，不要改合约去绕过。

## 7. 留档

至少保存：operator、四个合约地址、部署交易哈希、`startBlock`、`escrowCodeHash`、委员会名单与阈值、部署时的 `git rev-parse HEAD`。部署私钥只在部署机上临时使用，不写进节点 `.env`，也不提交到仓库。
