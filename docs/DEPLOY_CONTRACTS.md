# 节点合约部署

节点自己部署并拥有下面四个合约；目录合约 `MarketplaceRegistry` 由平台部署，节点只在部署完成后用自己的钱包登记。

| 合约 | 作用 |
|---|---|
| `TokenPayoutVault` | ERC20 出金被收款方拒绝时挂账，收款人之后自行领取 |
| `Escrow` | 托管、结算、退款/售后、提货争议、接单开关 |
| `Staking` | 卖家保证金、罚没、提货赔付 |
| `NodeGovernance` | 节点主提议、委员会 2/3、2 天时间锁、快速解冻 |

合约不可升级：再部署一次会得到一组新地址，旧合约里的托管和质押不会迁移。换合约前先把在途订单结清。

## 前置

- Foundry `1.8.1`：`forge --version` 和 `cast --version` 都应为 `1.8.1`。本手册按 1.8.1 验证；旧版可能缺少脚本用到的 `vm.split` / `vm.trim`；
- BTY EVM 主网 RPC，chainId `2999`（`DeployNode` 硬性要求，其他链直接 revert）。优先用 `https://node1.bityuan.com/eth`，不可用时依次换 `https://node2.bityuan.com/eth`、`https://mainnet.bityuan.com/eth`。部署前用 `cast chain-id --rpc-url <rpc>` 确认返回 `2999`；
- gas price 不用手工设：`DeployNode.s.sol` 没有写死，forge 广播时向 RPC 取当前费率。当前三个 RPC 都返回 `10 gwei`；部署前用 `cast gas-price --rpc-url <rpc>` 核对。只有 RPC 报价明显异常时，才在部署命令上临时加 `--with-gas-price`（值取上面这条命令的输出）；不要把这个值写死进脚本或 `.env`；
- operator 钱包，余额足够支付部署 gas；这个地址就是稍后的 `MK_SHOP_OWNER`；
- 至少 3 个仲裁人地址，彼此独立；`ARBITER_THRESHOLD` 必须小于人数；
- 原样使用本仓 `contracts/`。`foundry.toml` 固定了 solc 0.8.24 / optimizer runs 1 / evm_version paris；目录按 Escrow/Staking 运行时字节码哈希放行，改源码或编译参数会导致登记被拒。

## 1. 编译

```bash
cd contracts
forge build
```

## 2. 部署

```bash
export RPC_URL=https://node1.bityuan.com/eth
cast chain-id --rpc-url "$RPC_URL"       # 必须输出 2999

export DEPLOYER_PRIVATE_KEY=0x...       # operator；会成为 Escrow/Staking/TokenPayoutVault 的 owner
export ARBITERS=0x...,0x...,0x...       # 至少 3 个，不能重复
export ARBITER_THRESHOLD=2              # 必须小于 ARBITERS 人数
# 可选窗口，括号里是默认值（单位：块）
export REJECT_GRACE_BLOCKS=17280        # 拒绝退款后的释放静置期
export MIN_TIMEOUT_BLOCKS=17280         # 下单允许的最小超时
export AFTER_SALE_WINDOW_BLOCKS=3110400 # 确认收货后的售后窗口

forge script script/DeployNode.s.sol:DeployNodeScript \
  --rpc-url "$RPC_URL" \
  --broadcast
```

`DeployNode.s.sol` 不设置 gas price；forge 广播时会向 RPC 取当前费率。部署前可以先看一眼：

```bash
cast gas-price --rpc-url "$RPC_URL"      # BTY 主网当前是 10 gwei
```

只有 RPC 返回的报价明显异常时，才在部署命令上临时加 `--with-gas-price`，值取 `cast gas-price` 的输出；不要把这个值写死进脚本或 `.env`。

脚本按固定顺序部署并接线：`TokenPayoutVault` → `Escrow` → `vault.setEscrow` → `Staking` → `escrow.setStaking` → `escrow.setArbiters` → `NodeGovernance` → `escrow.setGovernor` / `staking.setGovernor`。

## 3. 记录输出

从 forge 的输出里抄下：

```text
operator
Escrow
Staking
TokenPayoutVault
NodeGovernance
escrowCodeHash
```

`startBlock` 取 **Escrow 那笔 CREATE 交易所在的区块**（forge 输出里的 `Block:`；也可以 `cast receipt <Escrow 部署交易哈希> blockNumber --rpc-url <rpc>`）。不要用当前最新块，否则节点会漏扫部署后到启动前的事件。

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
- Escrow 具有本版本代码要求的入口（旧代次实例会被拒绝）。

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
- 两个合约的运行时字节码哈希都在目录白名单里；
- 同一个 Escrow / Staking 没有被别的 operator 占用。

登记报 `ImplementationNotApproved` 时，说明当前编译产物不是目录放行的那一代；换回本仓原样的 `contracts/` 和 `foundry.toml` 重新部署，不要改合约去绕过。

## 7. 留档

至少保存：operator、四个合约地址、部署交易哈希、`startBlock`、`escrowCodeHash`、委员会名单与阈值、部署时的 `git rev-parse HEAD`。部署私钥只在部署机上临时使用，不写进节点 `.env`，也不提交到仓库。
