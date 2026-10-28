# 联邦商城 · 开店节点

一台服务器就够了：在自己的域名下运行一个联邦商城节点；节点里可以开多家店，商品、订单、客户资料都留在你自己的 MySQL 里。

## 前置

- Linux 服务器（Ubuntu / Debian / CentOS，x86_64 或 arm64），可访问外网；
- 一个域名（要对外提供 HTTPS；证书可以在本机申请，也可以交给负载均衡/CDN）；
- 节点主钱包地址（链上 `registerNode` 的身份）；
- **MySQL 可选**：首次部署会询问用你已有的 MySQL，还是没有则由脚本自动部署一个只给本节点使用的 MySQL 容器。

宿主只需要一台 Linux 服务器，Node、依赖和运行环境都在镜像里。

## 节点合约（首次部署必须先做）

每个节点自己部署 `TokenPayoutVault`、`Escrow`、`Staking`、`NodeGovernance`；目录合约
`MarketplaceRegistry` 由平台部署，节点部署完成后用自己的钱包登记。`contracts/` 与 Foundry
脚本随本仓发布。

完整步骤、参数、`startBlock` 取法与启动自检见 [docs/DEPLOY_CONTRACTS.md](docs/DEPLOY_CONTRACTS.md)；
主网部署入口是 `node scripts/deploy-node-mainnet.cjs`：先 `--check`，再 `--broadcast`。四个合约在
`10 gwei`、3 个委员下约 **0.133 BTY**，建议钱包准备 **0.2 BTY 以上**。

`deploy-constants.json` 的 `contracts` 三项（Escrow / Staking / startBlock）默认留空；部署完填
**本节点**的结果，或用 `--escrow` / `--staking` / `--start-block` 传给安装脚本。留空或
`startBlock=0` 会被部署脚本当场拒绝，不会静默接错合约。

> 合约源码与 `frontend/` 无关；前端不随节点仓发布。合约地址与 Registry 登记由节点方自己完成。

> Windows 原生路径 `deploy.ps1` 使用已有 MySQL；自动 MySQL 容器只随 Linux/macOS 的 `deploy.sh`。

## 一行部署

首次安装必须把本节点合约的三项带进来（先做上一节的合约部署）：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/delnull/marketplace-node/main/install.sh) \
  --escrow 0x你的Escrow --staking 0x你的Staking --start-block <Escrow 的部署块高>
```

其它参数（`--owner`、`--domain`、`--db-mode` 等）可以直接接在后面。脚本会自己取代码、构建镜像、建数据卷、启动容器并探活。首次会先检查本机环境：

- 已有同名 MySQL 容器/数据卷：直接复用，不重新安装；
- 本机已有 MySQL 服务：询问是否使用它；选“是”只填连接，不会另装；
- 非交互模式检测到已有 MySQL 时拒绝自行再装，必须显式选择 `--db-mode external` 或 `--db-mode container`。

随后会询问：

1. 节点主钱包地址；
2. 对外域名，以及 HTTPS 在哪终止；
3. **是否使用你自己的 MySQL**：
   - 有：输入地址（`host` 或 `host:port`）、库名、用户名、密码；
   - 没有：脚本自动创建 `mysql:8.4` 容器、命名数据卷和独立网络。

不需要先 clone；但首次安装必须给上面三项（或先 clone 再改 `deploy-constants.json`）。想改代码或离线审阅时才用：

```bash
git clone https://github.com/delnull/marketplace-node.git && cd marketplace-node && bash deploy.sh
```

### 非交互部署

使用已有 MySQL：

```bash
MK_DB_PASSWORD='你的密码' bash <(curl -fsSL https://raw.githubusercontent.com/delnull/marketplace-node/main/install.sh) \
  --escrow 0x你的Escrow --staking 0x你的Staking --start-block <Escrow 的部署块高> \
  --owner 0x你的节点主钱包 --domain shop.example.com --email you@example.com \
  --db-mode external --db-host db.example.com --db-port 3306 \
  --db-name marketplace_node --db-user marketplace_node --yes
```

由脚本部署 MySQL：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/delnull/marketplace-node/main/install.sh) \
  --escrow 0x你的Escrow --staking 0x你的Staking --start-block <Escrow 的部署块高> \
  --owner 0x你的节点主钱包 --domain shop.example.com --email you@example.com \
  --db-mode container --yes
```

密码优先用 `MK_DB_PASSWORD` 环境变量传，不要写进命令行历史。

## MySQL

### 用自己的 MySQL

数据库必须满足：

- MySQL 8.x，库默认排序规则 `utf8mb4_0900_as_cs`；
- 应用账号对该库有全部权限；
- 应用账号有 `SESSION_VARIABLES_ADMIN`（节点启动时会设置 `binlog_row_image`）；
- 允许节点在临时库重放 schema：需要建库/建表/建触发器/建视图权限；最省事是全局 `ALL`，或让 DBA 按启动日志补齐；
- 若开启了 binlog：服务端 `log_bin_trust_function_creators=1`，或账号有 `SUPER`。

这些权限不够时节点会在启动期拒绝运行，不会带着坏库继续跑。

### 由脚本部署 MySQL

- 只在 Docker 网络内暴露，**不发布 3306 到宿主**；
- 数据在命名卷 `<service>-mysql-data`，删容器不会删数据；
- root 密码保存在安装目录 `.mysql-root`（0600）；
- 应用账号自动获得所需权限，库使用 `utf8mb4_0900_as_cs`。

**卸载节点容器不会删除 MySQL 数据卷**；只有显式 `--purge` 才会删除。

## 部署后

- 本机健康检查：`curl http://127.0.0.1:8090/healthz`
- 链上登记：打开 https://fedmall.bityuan.com →「节点登记」，用节点主钱包完成 `registerNode`
- 开店：登记节点后，店主在前端「申请开店」提交申请；节点主/员工在节点面板审批通过后，**本节点**直接建店并分配编号（店铺/商品/订单全在节点链下，没有链上开店交易）

节点容器里的 `127.0.0.1` 指容器自己。使用外部 MySQL 时，地址必须是容器能访问到的主机/IP；本机已有 MySQL 默认填 `host.docker.internal`，需要 MySQL 监听容器可达地址，不能只绑定 `127.0.0.1`。

## 日常运维

```bash
bash deploy.sh --status       # 容器、数据卷、MySQL 状态
bash deploy.sh --health       # 健康时只输出一行
bash deploy.sh --update       # 重新构建镜像，沿用数据卷和 MySQL 数据
bash deploy.sh --uninstall    # 移除节点容器，保留数据卷/MySQL 数据
bash deploy.sh --purge        # 删除节点与 MySQL 数据卷（不可逆）
docker logs -f marketplace-node
```

升级、备份、恢复和故障处理见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 安全

- 节点主私钥不要交给脚本；链上登记用浏览器钱包完成。
- `.env` 含令牌密钥和数据库密码，权限保持 0600，不要提交到仓库。
- 生产环境把 `MK_CORS_ORIGIN` 收窄到实际前端域名。
- 对外只暴露 HTTPS；MySQL 不应对公网开放。
- 根目录的 `deploy-constants.json` 只记**本节点**的 Escrow / Staking / startBlock 三项；换批时三项同批更新，不要手改单个地址。部署前必须拿到真实地址：写进这个文件，或用 `--escrow` / `--staking` / `--start-block` 传；两者都没有（或 `startBlock=0`）时脚本拒绝。
