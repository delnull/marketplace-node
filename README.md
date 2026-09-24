# 联邦商城 · 开店节点（marketplace-node）

**开一家自己的店 = 在你自己的服务器上跑这个节点。** 商品、订单、客户资料都留在你自己的机器上，
链上只做两件事：**登记你的店铺**（让买家能找到你）和**托管货款**（确认收货后才放款给你）。

前端聚合站（买家逛的地方）：[fedmall.bityuan.com](https://fedmall.bityuan.com)
代码仓库：**[marketplace-node](https://github.com/delnull/marketplace-node)**（克隆这一个仓库就能开店）

```
                              ┌──────────────────────────────┐
   买家浏览器 ──浏览聚合页──▶ │  fedmall.bityuan.com（前端） │
        │                     └──────────────┬───────────────┘
        │                                    │ 只从链上 Registry 读店铺目录
        │                                    ▼
        │                      ┌──────────────────────────────┐
        └──直接访问你的节点──▶ │ BTY EVM 主网（chainId 2999） │
             (https://你的域名)│ MarketplaceRegistry / Escrow │
                               └──────────────────────────────┘
                                            ▲ 登记你的节点
                              ┌─────────────┴────────────────┐
                              │  你的服务器：本仓库          │
                              │  容器里跑 Express + SQLite   │
                              └──────────────────────────────┘
```

---

## 30 秒版

```bash
# 1) 先把你的域名（如 shop.example.com）解析到这台服务器的公网 IP
# 2) 然后一条命令：
bash deploy.sh
# 3) 部署完到 https://fedmall.bityuan.com →「开店/登记我的节点」完成链上登记（用同一个店主钱包）
```

脚本只要求宿主有 **Docker**（没有就自己装）；**Node 与依赖全在容器镜像里**，宿主机不需要装任何运行时。
所有数据在**命名卷**里，容器可以随时删掉重建——升级就是换个镜像，数据不会动。

脚本会问你几件事（其余全部自动）：**店主钱包地址**、**对外域名**、**HTTPS 用哪种方式**
（Caddy 容器 / 宿主 nginx+certbot / 不配 TLS）、**证书邮箱**，以及**是否现在就链上登记**
（选"稍后"就在上面那个网页里登记，更安全）。

---

## 一、开一家店需要什么

| 需要 | 说明 |
| --- | --- |
| **一台 Linux 服务器** | Ubuntu / Debian / CentOS 等，1 核 1G 起步即可。节点只依赖 Node 内置 SQLite，**不需要 MySQL/Redis**；**需要 Docker**——没有的话脚本会自己装 |
| **一个域名 + HTTPS** | 买家浏览器会**直接访问你的节点**（前端是 https，所以你也必须 https）。默认用**一个 Caddy 容器**全自动申请并续期 Let's Encrypt 证书（也可以选宿主 nginx + certbot，或干脆不配 TLS、交给你的负载均衡）；域名要先解析到这台机器 |
| **一个钱包地址**（店主钱包） | 作为你的店铺身份：上架商品、发货、改店铺设置都用它签名登录。**它也是收款方** |
| **一点点 BTY 当 gas** | 只在"链上登记/更新登记"时用，一次约 0.001 BTY 量级，留 0.01 BTY 绰绰有余。**开店不需要质押**（本联邦当前 `minStakeToRegister = 0`） |
| **一个能跑链上交易的钱包**（MetaMask 等） | 登记那一步需要它；手机端请用带内置钱包的浏览器 |

服务器需要放行 **80 端口**（申请证书）与 **443 端口**（买家访问）；节点容器自身只在内部监听 8090，
默认只绑到本机（`127.0.0.1:8090`），对外由 Caddy/nginx 反代，不需要对公网直接开。

---

## 二、详细部署流程

### 第 1 步：把域名解析到你的服务器

在域名服务商处加一条 **A 记录**：`shop.example.com` → 你的服务器公网 IP。
（用 Cloudflare 之类的话，先关掉"小黄云"代理，证书申请会更顺。）

验证（在服务器上执行，能返回你的公网 IP 就对了）：

```bash
dig +short shop.example.com        # 或 nslookup shop.example.com
curl -s https://api.ipify.org      # 本机公网出口 IP
```

> 域名没解析好会怎样：脚本第 ⑦ 步的 Let's Encrypt 申请会失败（这是唯一一处强依赖域名解析的地方）。
> 节点本身仍然会跑起来，只是买家还看不到你。

### 第 2 步：运行 `deploy.sh`

三种跑法，任选其一：

```bash
# A. 交互式（推荐第一次）：只问必填项
git clone https://github.com/delnull/marketplace-node.git && cd marketplace-node
bash deploy.sh

# B. 不落盘、直接跑（脚本会自己把代码取到 /opt/marketplace-node 或 $HOME/marketplace-node）
bash <(curl -fsSL https://raw.githubusercontent.com/delnull/marketplace-node/main/deploy.sh)

# C. 全自动（零交互，适合已经有域名/邮箱/私钥的人）
bash deploy.sh --owner 0x你的店主钱包 --domain shop.example.com --email you@example.com
```

先用 `bash deploy.sh --dry-run` 可以只打印计划、什么都不改。

**脚本会依次做这 9 件事**（每步都会打印它在干什么）：

| 步 | 做什么 | 你可以从中确认什么 |
| --- | --- | --- |
| ① 环境检测 | 系统 / 权限 / `curl` `tar` `openssl`；**检查 Docker，没有就按发行版装上并启动**（apt/dnf/yum/apk/pacman/zypper，兜底用官方脚本） | 装完会把你的用户加进 `docker` 组，并提醒**重新登录一次**才不用 sudo |
| ② 取代码 | 就地用当前目录；或把当前代码复制到安装目录；或 `git clone`；**宿主机连 git 都没有时，用容器把源码包下载下来** | 安装目录默认 `/opt/marketplace-node`（有 root/sudo 时）或 `$HOME/marketplace-node` |
| ③ 写配置 | 生成 `<安装目录>/.env`（权限 600）：**合约地址已内置**、令牌密钥当场随机生成、数据路径指向卷内 | 重跑会**沿用已有的 `MK_TOKEN_SECRET`**（否则店主登录态全失效），你自己加的配置项也原样保留 |
| ④ 构建镜像 | `docker build`（基础镜像 `node:24-slim`）—— Node 与依赖都进镜像，**宿主不装任何运行时** | 镜像落盘约 370 MB（其中基础镜像约占 330 MB）；构建过程中不额外下载任何系统包（这是刻意的，见 Dockerfile 注释） |
| ⑤ 数据卷 | `docker volume create <服务名>-data`（已存在就沿用） | 商品/订单/附件都在卷里，**容器删了重建数据也在** |
| ⑥ 启动容器 | `docker run -d --restart unless-stopped`：发布端口、挂数据卷、注入 `.env` | 开机自启靠 Docker 的 restart policy，**不需要 systemd 单元** |
| ⑦ 探活 | 循环请求 `http://127.0.0.1:8090/healthz` 直到通过 | 必须返回 `"code":0`，且链 ID 自检通过（`chainId 2999`） |
| ⑧ HTTPS | 按你选的方式：**Caddy 容器**（自动申请+续期证书，证书存在卷里）/ 宿主 nginx + certbot / 不配 TLS（只监听端口，交给外部入口） | nginx 与 Caddy 的配置都会先校验，校验不过就**还原成部署前的样子**，不会把坏配置留在机器上 |
| ⑨ 链上登记 | 只有你给了私钥（`--key-file` 或交互选"现在登记"）才执行：在**容器里**签名并广播 `registerNode`，然后核验 `getActiveNodes()` | 私钥只经**标准输入**进容器、随容器销毁，宿主磁盘上不落任何文件；没给就跳过，第 3 步在网站上登记即可 |

脚本结束时你会看到容器名、数据卷、探活结果、对外地址，以及**下一步该做什么**。

### 第 3 步：在网站上登记（也可以让脚本代做）

登记就是"把你的域名写进链上店铺目录"，这一步之后买家才会看到你。

**方式一：网页向导（推荐，钱包插件签名，最安全）**

1. 打开 [fedmall.bityuan.com](https://fedmall.bityuan.com) → 首页点「**🏪 开店/登记我的节点**」（或直接访问 `/#/open-shop`）；
2. 步骤① 填**节点地址**：`https://shop.example.com`（必须 https，会做"转小写 + 去尾斜杠"的规范化）；
3. 页面会**读取你的节点**并与链上目录交叉核验（托管合约地址必须与本联邦的 canonical Escrow 一致）——
   不一致会明确报错，这时通常是你的 `.env` 里合约地址被改过；
4. 步骤④ **连接钱包**：⚠️ 请用**部署时填的那个店主钱包**。页面上会提示"与当前钱包不同"——
   若用了别的钱包，链上 `operator` 就会变成那个钱包，而节点的写操作（上架/发货）仍要求店主钱包，
   两边就对不上了；
5. 步骤⑤ 点「**钱包签名并登记开店**」→ 钱包确认两笔（签名 + 交易）→ 等待上链确认。

**方式二：让脚本当场登记（把私钥交给脚本，省一步）**

```bash
bash deploy.sh --owner 0x你的店主钱包 --domain shop.example.com --email you@example.com \
               --key-file /root/shop.key
# 或部署之后补登记：
bash deploy.sh --register --owner 0x… --domain shop.example.com --key-file /root/shop.key
```

私钥只用于**签名与广播**：不写盘、不进 `.env`、不打印、不进日志。`--key-file` 给的文件只被读一次
（重定向进容器的标准输入），交互粘贴的私钥同样只经标准输入进容器、随容器一起销毁——**宿主磁盘上不落任何文件**。
`registerNode` 需要一点 gas；**首次登记允许他人代付**，但 operator 永远是签名者本人。

### 第 4 步：验证，然后上架商品

```bash
bash deploy.sh --health          # 本机探活（节点自己的健康检查）
curl -s https://shop.example.com/api/shop   # 从公网看你的节点（应返回店主地址、链 ID、托管地址）
```

- 打开 [fedmall.bityuan.com](https://fedmall.bityuan.com)：首页店铺列表里应出现你的店（新登记通常几十秒内可见）；
- 用**店主钱包**在前端点「连接钱包」登录 → 进「**卖家面板**」：上架商品、设店名/公告、加店员、
  配通知 webhook、看订单与发货——这些都**不上链**，只写你自己的节点数据库，即改即生效。

---

## 三、部署后你得到了什么

```
宿主机
├── Docker（脚本装的，或复用了你已有的）
├── 数据卷 marketplace-node-data      ← 全部经营数据都在这里（容器内挂成 /data）
│   ├── marketplace-node.db           ← 商品/订单/评价…（SQLite）
│   └── attachments/                  ← 订单证据附件
└── <安装目录>/（默认 /opt/marketplace-node 或 $HOME/marketplace-node）
    ├── .env                          ← 你的配置（权限 600；含令牌密钥，别外传、别入库）
    ├── Caddyfile                     ← 选了 Caddy 时生成的反代配置
    ├── .deploy-state                 ← 这套安装的身份（容器名/端口/卷名），--update 等靠它认路
    ├── Dockerfile                    ← 镜像怎么构建（Node 与依赖都在镜像里）
    └── src/ scripts/ test/           ← 源码（scripts/register-node.mjs 可手工补登记）
```

| 组件 | 位置 / 命令 |
| --- | --- |
| 容器 | `marketplace-node`（`docker ps`；`--restart unless-stopped`，开机自启、崩溃自动重启） |
| 镜像 | `marketplace-node:latest`（落盘约 370 MB；Node 与依赖都在里面，宿主不需要装 Node）。升级时脚本会把重建前的镜像另存为 `marketplace-node-rollback:latest`，新镜像起不来会自动回滚到它 |
| 数据卷 | `marketplace-node-data` ← 挂到容器 `/data`。**备份就是导出这个卷**（见下） |
| 监听 | 容器内 `8090`；默认只发布到宿主 `127.0.0.1:8090`，对外由 Caddy/nginx 反代 |
| 日志 | `docker logs -f marketplace-node` |
| 健康检查 | 容器自带 `HEALTHCHECK`（`docker ps` 里能看到 `healthy`）；接口是 `GET /healthz` |
| 店铺信息 | `GET /api/shop`（买家前端与开店向导都读它） |

进容器里看数据或调试请带上 `-u node`（`docker exec -it -u node marketplace-node sh`）——
容器主进程已经是非 root（uid 1000），但 `docker exec` 默认仍以 root 进入，**用 root 在卷里写文件会让节点之后写不动**。

---

## 四、日常运维

| 想做的事 | 命令 |
| --- | --- |
| 看状态 | `bash deploy.sh --status`（容器/数据卷/关键配置/最近日志都列出来） |
| 只看探活 | `bash deploy.sh --health`（一行结论，不健康时退出码 2 —— 适合喂监控/cron） |
| 看日志 | `docker logs -f marketplace-node`（`--tail 100` 看最近 100 行） |
| **升级到最新版** | `bash deploy.sh --update`（刷新代码 → 重新构建镜像 → 用**同一个数据卷**重建容器；**配置、密钥、数据全部保留**）。`git clone` 装的自带 `git pull`；**没有 git 的安装（ZIP/curl）加 `--pull`** 从公开仓拉最新代码；新镜像起不来会**自动回滚**到上一个镜像 |
| **改了 `.env`** | 用 `bash deploy.sh --update` 重建容器。⚠️ `docker restart` **不会**重新读 `.env`——配置是在**创建容器那一刻**由 `--env-file` 注入的，重启沿用旧配置（Caddyfile 例外：它是挂进容器的文件，改完 `docker restart <服务名>-caddy` 即生效） |
| 重启节点 | `docker restart marketplace-node` |
| 同机再开一家店 | `bash deploy.sh --service shop-b --volume shop-b-data --port 8091 --dir /opt/shop-b`（容器名、卷名、端口三者都要换）。⚠️ 第二家店**不要选 `--tls-mode caddy`**：Caddy 要独占宿主 80/443，第二个 Caddy 容器会因端口冲突起不来，用 `--tls-mode none` 交给已有反代 |
| 收紧端口暴露面 | 默认按 TLS 方式发布（配了 TLS → 只绑 `127.0.0.1`；不配 → 绑 `0.0.0.0`）。同机已有 nginx 反代、但又用了 `--tls-mode none` 时，用 `--bind 127.0.0.1` 只对宿主机暴露（这个选择会记进 `.deploy-state`，`--update` 不会偷偷改回 `0.0.0.0`） |
| 备份 | 导出数据卷：`docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup --entrypoint tar marketplace-node:latest czf /backup/node-data-$(date +%F).tar.gz -C /data .` |
| 恢复 | 先 `docker stop marketplace-node`，再 `docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup --entrypoint tar marketplace-node:latest xzf /backup/node-data-YYYY-MM-DD.tar.gz -C /data`，然后 `docker start marketplace-node` |
| 换域名 | 域名解析好后重跑 `bash deploy.sh --update --domain 新域名`（会更新反代/证书/SIWE 域名与 CORS），然后重新登记一次 |
| 链上更新登记 / 注销登记 | 到 https://fedmall.bityuan.com 的开店向导里操作（**只有登记时的那个钱包**能更新或注销） |
| 暂停营业 | 前端「卖家面板 → 店铺设置」下架商品；要让目录里也看不到，可在向导里注销登记（数据与订单都还在你的卷里） |
| 关掉节点 | `docker stop marketplace-node`（数据不动）；以后重启：`docker start marketplace-node` |
| 不再需要 / 搬走 | `bash deploy.sh --uninstall`（删容器，**数据卷保留**）；`docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup --entrypoint tar marketplace-node:latest czf /backup/backup.tar.gz -C /data .` 导出后即可换机器 |
| 彻底清除 | `bash deploy.sh --purge`（**连数据卷一起删**，不可逆，需要手输卷名确认） |

**容器名、卷名、端口是"这套安装的身份"**：安装目录里会留一份 `.deploy-state`（记下它们），
`--update` / `--status` / `--health` / `--uninstall` 会自动沿用，不用每次重复指定。
容器名在同一台机器上是唯一的：若你要用的名字已被**另一套安装**占用（指向别的目录），
脚本会**拒绝覆盖**并给出两条出路——换名字（`--service <别的名字>`），或确认要接管再加 `--force`。

**关于备份的边界**：链上的钱不需要你备份（托管在合约里）；需要备份的是**你的商品、订单、
客户收货信息与证据附件**——它们只存在于你机器上的那个**数据卷**里。丢了就是真丢了，且没有第三方副本。
（卷名默认 `marketplace-node-data`，容器内是 `/data`；导出/恢复命令见上面「日常运维」那一行。）

---

## 五、配置项（`.env`）

脚本生成的 `.env` 里**合约地址已经填好**，正常情况下一行都不用改。要改的通常只有端口或 CORS：

**完整配置清单（含每一项的中文注释）在 `.env.example`**，下表是其中最常用的几项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `MK_PORT` | `8090` | 本机监听端口。**同机若已占用 8080（很常见）就别用 8080** |
| `MK_SHOP_OWNER` | 你填的 | 店主钱包地址 = 店铺身份锚点。**改它不等于换店主**（换店主走链上 `transferNode`） |
| `MK_ESCROW_ADDRESS` / `MK_REGISTRY_ADDRESS` | 已内置 | 本联邦的共享合约。**别改**：改了节点就去读别的链/别的合约，前端会直接拒绝登记 |
| `MK_RPC_URL` / `MK_CHAIN_ID` | 主网 / `2999` | 节点启动时自检链 ID，指错链会拒绝启动 |
| `MK_ESCROW_START_BLOCK` | 本批部署块 | 事件扫描起点（填 0 表示从当前链头开始；改了不影响已有订单） |
| `MK_CORS_ORIGIN` | `https://fedmall.bityuan.com,https://你的域名` | 允许哪些站点跨域读你的节点。**必填显式白名单**——类生产下写 `*` 等于"不开放跨域" |
| `MK_DB_FILE` / `MK_ATTACH_DIR` | `/data/…`（卷内） | 数据与附件路径。**别改成卷外的路径**（例如 `/tmp/x.db`）——那样容器一重建数据就没了 |
| `MK_AUTO_DELIVER` | `1` | 数字商品自动发码（码池有货时买家付款后自动交付） |
| `MK_PII_RETENTION_DAYS` | `180` | 终局订单的收货信息/备注/证据到期自动擦除（个人信息合规用；金额与订单事实保留） |
| `MK_BTY_TTL_MS` | `60000` | BTY 行情缓存 1 分钟。官方行情端点，**它直接决定买家要付多少 BTY**，所以跟得紧 |
| `MK_RATES_TTL_MS` | `1800000` | USDT→CNY 缓存 30 分钟。这一项决定你的节点**每天向公共汇率接口发多少次请求**（30 分钟 = 每源 48 次/天）。除非你要盯盘，否则别调小 |
| `MK_FALLBACK_BTY_USDT` / `MK_FALLBACK_USDT_CNY` | `0` | 行情源**全部**不可用时的兜底汇率（同时标记 `stale`）。填了它，源挂掉时你的店还能按旧价下单；留 `0` 则表示宁可不报价 |
| `MK_TOKEN_SECRET` | 随机生成 | 登录令牌签名密钥。**别改**：改了店主所有登录态失效；**别外传**：泄漏等于店主身份可被伪造 |

---

## 六、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 脚本第 ⑧ 步证书申请失败 | 域名没解析到本机 / 80 端口没放行 / 用了 CDN 代理。**Caddy 的报错在 `docker logs marketplace-node-caddy` 里**；修好后重跑 `bash deploy.sh --update --domain 你的域名`。用宿主 nginx 模式的话，也可手动 `sudo certbot --nginx -d 你的域名` |
| 节点起不来，日志说 `MK_TOKEN_SECRET` 不合格 | 密钥被改短或被替换成示例值。删掉 `.env` 里那一行后重跑 `bash deploy.sh --update`（会重新生成），代价是店主登录态失效 |
| 日志说 `chainId` 不符 | `MK_RPC_URL` 指到了别的链。改回 `https://mainnet.bityuan.com/eth` 后 `bash deploy.sh --update` |
| 端口被占用 | 同机已有服务占了 8090。换一个：`bash deploy.sh --update --port 8091`（会重建容器并更新反代配置） |
| `--update` 报"容器名已被占用" | 说明同名容器是**另一套安装**（指向别的目录）。换名字 `--service <别的名字>`，或确认要接管再加 `--force`。**别用 `--force` 去覆盖不认识的安装** |
| 同机想开第二家店 | 必须给三个都不同的值：`--service shop-b --volume shop-b-data --port 8091 --dir /opt/shop-b`（容器名与卷名全机唯一，端口不能撞） |
| 同机再开一家店时提示"数据卷不存在" | 卷名默认跟着 `--service` 走；如果你只改了 `--service` 而没改 `--volume`，新安装会去找 `<新服务名>-data`。要么让它自动建，要么显式 `--volume` 指到已有的卷（**想让两家店共用一个库是行不通的，各自一份**） |
| **服务器访问不了 GitHub** | 脚本取代码有两条路：宿主机 `git clone`，或（宿主机没有 git 时）**用容器下载源码包**——两条都要能访问 GitHub。完全出不了网的做法：在能上网的机器上打开仓库页 → **Code → Download ZIP**，把压缩包传到服务器解压，进去跑 `bash deploy.sh`。**镜像构建只需要能拉 `node:24-slim`**（受限网络可配 Docker 镜像加速） |
| 拉不到基础镜像（build 卡住 / `EOF`） | `node:24-slim` 来自 Docker Hub。配一个镜像加速器，或先在有网机器上 `docker pull node:24-slim && docker save` 再传到服务器 `docker load` |
| 升级时提示"非交互环境无法询问域名" | 这套安装没有配域名（升级本身不需要域名）。**要加域名就显式给 `--domain`**；不加就直接 `bash deploy.sh --update --yes`，不会再追问 |
| 前端首页看不到我的店 | ① 还没链上登记（去做第 3 步）；② 登记的 endpoint 与你的实际域名不一致；③ 你的节点从公网不可达（`curl https://你的域名/api/shop` 试试）；④ 反代/证书有问题。**没有登记过的节点一定不会被展示**——这是刻意的，没有静态兜底店铺列表 |
| 网页向导说"该节点不能登记到本前端" | 你节点的 `MK_ESCROW_ADDRESS` 与本前端配置的 canonical Escrow 不一致（一般是被改过）。恢复内置值再试 |
| 向导说"与当前钱包不同" | 你连的钱包 ≠ 部署时的 `MK_SHOP_OWNER`。请换回那个钱包（链上 `operator` 就是当前钱包，登记错了之后只能用那个钱包更新/注销） |
| 买家下单失败 / 页面空白 | 跨域被拦：确认 `.env` 的 `MK_CORS_ORIGIN` 含 `https://fedmall.bityuan.com`；改完跑 `bash deploy.sh --update`（`docker restart` 不会重新读 `.env`） |
| 页面上只有人民币价、没有 BTY 应付金额 | 你的节点取不到行情。你的服务器要能访问 `https://mainnet.bityuan.com/tapi/ticker`（BTY 价）与公共汇率接口（USDT→CNY）。先 `curl https://你的域名/api/rates` 看返回：`available:false` = 一个源都没取到（八成是出网被限）；`available:true` 但 `stale:true` = 正在用上一轮缓存或兜底汇率。行情**只是展示与折算**，买家签名确认的支付金额才是准的 |
| 想确认行情冗余还剩几条腿 | `curl https://你的域名/api/rates` 看 `usdtCnyLegs`（正常 `3`）与 `usdtCnySource`（正常 `median(coinbase,erapi×peg,frankfurter×peg)`）。只剩 1 条腿时日志里会有一条 `[rates] USDT-CNY 冗余不足` 告警——**看到就去查**，别等唯一那条也断 |
| 行情看着"不动" / 想知道数据有多新 | `/api/rates` 里 `btyUpdatedAt`、`usdtUpdatedAt` 是**两条腿各自**的上次**尝试**取数时刻（毫秒；**失败也会更新**，所以它比"手上这个值的年龄"更乐观，只能当"最近一次打上游是什么时候"看），`updatedAt` 取两者中较旧的那个。BTY 腿默认 1 分钟一刷、USDT→CNY 腿 30 分钟一刷——这是刻意的：BTY 价要跟得紧，人民币汇率没必要打那么勤 |
| 担心行情接口把我的 IP 封了 | BTY 腿打的是官方端点（默认 1 分钟一次）；USDT→CNY 腿的缓存默认 30 分钟（每源 48 次/天），正常一天只有几十次请求。并发请求还会被合并成一轮（single-flight），不会因为访问量涨了就多打上游。**别把 TTL 调到秒级**——那才是被封的原因。读 `/api/rates` 本身不会打上游 |
| 想换店主钱包 | 走链上 `transferNode`（双方签名），**不要**直接改 `.env`（见 `docs/OPS_RUNBOOK.md §5.5`） |

---

## 七、安全与隐私须知

- **私钥**：只有链上登记/更新/注销才用到店主私钥（或钱包插件）。脚本不会保存它。
  用临时文件登记完请立即删除——`operator` 权限等同店主私钥权限。
- **你的数据在你手上**：商品、订单、客户资料都在你服务器的**数据卷**里（容器内 `/data`），
  本项目**没有中央服务器**，也没有人能替你读取或恢复。请自己做好备份与访问控制。
- **你的责任（开店前必读）**：谁开店、谁上架、谁收款、谁发货，谁就是**经营者**，经营的法律义务在你身上。
  这里**没有"平台"**：节点自托管、代码开源、无账号体系、无身份权威，因此 **KYC/AML 既未实现，
  也无法在这套架构下被有意义地强制执行**；链上托管合约里**没有任何**管理动作能冻结或划扣资金——
  退款与结算只能走合约规定的四条路径（买家确认收货 / 卖家同意退款 / 仲裁裁决 / 超时释放）。
  **完整的合规与责任须知见 [docs/COMPLIANCE.md](docs/COMPLIANCE.md)（开店前请通读一遍）。**
- **收好你自己的记录**：商品、订单、收货信息、开票抬头、售后沟通都在你的节点里。收到买家投诉、
  或收到监管/司法的合法调取请求时，处理与配合的义务都在你（店主）身上。**收货信息与开票抬头属于个人信息**：
  请在店铺公告里写明你收集什么、用途与联系方式；终局订单的个人信息默认 180 天后自动擦除
  （`MK_PII_RETENTION_DAYS`，金额与订单事实保留），也可用「卖家面板」按单立即擦除。
- **合约未经独立审计、不可升级**：承载大额资金前请自行审计。
- 本项目代码仅供学习研究参考，不构成任何投资或法律意见；正式经营前请就你的具体情形咨询执业律师。

---

## 八、技术要点

- **运行要求**：宿主只要能跑 **Docker**（脚本会自己装）。Node 与依赖都在镜像里
  （镜像基于 `node:24-slim`，节点用 Node 内置的 `node:sqlite`，**零原生依赖**，不需要 MySQL / Redis）；
  一台 1 核 1G 的机器就够。构建镜像时**除基础镜像与 npm 依赖外不下载任何系统包**——
  这是刻意的：宿主机的包源/镜像源是最不可控的变量，实测有机器连不上某些 CDN，构建就会长时间卡住
- **端口**：容器内监听 `8090`；默认只发布到宿主 `127.0.0.1:8090`，对外由 Caddy/nginx 反代
- **数据**：数据库与证据附件都在**命名卷**里（容器内挂成 `/data`）。备份/恢复就是导出/导入这个卷——
  **不要**用 `docker commit` 去固化数据，也不要往容器里写业务数据（容器一删就没了）
- **判定"节点正常"的三个真值**（`GET /healthz`）：`code:0`、`escrowAddress` 是本联邦的托管合约、
  `owner` 是你的店主地址；其中 `watcher` 段还能看到链上事件扫描游标是否在推进
- **行情（价格换算的关键）**：两条腿**各自缓存、各自失败**——BTY 价取自官方 `mainnet.bityuan.com/tapi/ticker`
  （默认 1 分钟一刷，它直接决定买家要付多少 BTY）；USDT→CNY 取**三个独立公共源并行 + 取中位数**
  （默认 30 分钟一刷，公共接口省着用），并按 5–10 的合理区间过滤掉明显是垃圾的返回值。
  **某一条腿断了不影响出价**（另一条腿照常工作、旧值保留），但会在日志里告警、在 `/api/rates` 里如实
  标出 `stale` / `error` / `usdtCnyLegs`——冗余掉光是看得见的，不会静默到"全站突然没有价格"。
- **目录**：`src/`（路由与业务逻辑）、`scripts/`（登记/对账/体检等工具，都在**容器里**跑）、
  `test/`、`Dockerfile` + `docker-entrypoint.sh`（镜像怎么构建、容器怎么降权启动）、`shared/shopCode.js`（店铺编号算法）

部署、运维与排错需要的东西都在本文与 `bash deploy.sh --help` 里；接口的具体行为可以直接读 `src/`。

---

## 九、延伸阅读（都在本仓库 `docs/` 里）

| 文档 | 什么时候看 |
| --- | --- |
| [合规与责任须知 **COMPLIANCE.md**](docs/COMPLIANCE.md) | **开店前必读**：经营者的法律义务、个人信息怎么处理、收到买家投诉或监管调取请求时怎么办 |
| [运维手册 **OPERATIONS.md**](docs/OPERATIONS.md) | 备份/恢复/迁移/升级/密钥轮换/故障速查（照着做就行） |
| [机制与边界 **MECHANICS.md**](docs/MECHANICS.md) | 钱是怎么被保护的、订单与售后怎么流转、这个产品**明确不做**什么、有哪些已知缺口 |
