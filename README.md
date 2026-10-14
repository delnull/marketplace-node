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

脚本会问你几件事（其余全部自动）：**店主钱包地址**、**对外域名**、**HTTPS 在哪终止**
（别处负载均衡/CDN/另一台 nginx —— 默认 / 本机 Caddy 容器 / 本机宿主 nginx+certbot）、
**是否现在就链上登记**（选"稍后"就在上面那个网页里登记，更安全）；只有选了"本机申请证书"才会问**证书邮箱**。

---

## 一、开一家店需要什么

| 需要 | 说明 |
| --- | --- |
| **一台机器** | 三类宿主，各自一条命令：<br>· **Linux**（Ubuntu / Debian / Fedora / CentOS Stream / Rocky / AlmaLinux / Oracle Linux / Amazon Linux / openSUSE / Alpine 等）：`bash deploy.sh`，没有 Docker 时脚本按**包管理器**自行安装（apt / dnf / yum / zypper / apk / pacman）<br>· **macOS**：同一份 `bash deploy.sh`，但 Docker 需要你自己装（它是带虚拟机的应用：Docker Desktop / colima / OrbStack——脚本不会替你装）<br>· **Windows Server / Windows**：`.\deploy.ps1`，**原生**跑（不需要 Docker、不需要 WSL）<br>1 核 1G 起步即可；节点只依赖 Node 内置 SQLite，**不需要 MySQL/Redis** |
| **一个域名**（证书可选） | 买家浏览器会**直接访问你的节点**，所以**买家看到的节点地址必须是 `https://`**（前端是 https，浏览器会拦掉到 http 节点的请求）。但**证书不一定要在这台机器上**——HTTPS 在哪终止，证书就在哪申请：① 本机申请（`--tls-mode caddy` 一键全包，或干净机器上用 `--tls-mode nginx`）；② 别处申请（负载均衡 / CDN / 另一台 nginx —— **默认**，本机只出 `http://<本机>:$PORT`）。 |
| **一个钱包地址**（店主钱包） | 作为你的店铺身份：上架商品、发货、改店铺设置都用它签名登录。**它也是收款方** |
| **一点点 BTY 当 gas** | 只在"链上登记/更新登记"时用，一次约 0.001 BTY 量级，留 0.01 BTY 绰绰有余。**开店不需要质押**（本联邦当前 `minStakeToRegister = 0`） |
| **一个能跑链上交易的钱包**（MetaMask 等） | 登记那一步需要它；手机端请用带内置钱包的浏览器 |

**要在本机申请证书**（`--tls-mode caddy`，或干净机器上的 `--tls-mode nginx`）时才需要放行 **80 端口**
（Let's Encrypt 校验用）与 **443 端口**（买家访问）——这两件事发生在**证书所在的那台机器**上，
所以"证书在别处"的部署只要在本机放行节点端口，另需让那个外部入口连得到本机。节点自身监听 8090：
不配本机 TLS 时绑 `0.0.0.0`（给外部入口连），配了本机 TLS 时默认只绑 `127.0.0.1`（由本机反代连），
需要收紧就显式 `--bind 127.0.0.1`。

> **Windows 上的 `--tls-mode nginx` 不存在**：那条路是 Linux 发行版的实现（`/etc/nginx/conf.d` +
> `systemctl reload` + `certbot --nginx`）。Windows 那条路径只有两种：本机 Caddy 申请（`-TlsMode caddy`）
> 或外部入口终止（`-TlsMode none`，默认）。**两条路径的本机监听端口都是 8090**，容器路径里
> 它是容器内固定端口（`--port` 只改发布到宿主的端口）。

---

## 二、详细部署流程

### 第 1 步：把域名指向**终止 HTTPS 的那台机器**

"那台机器"可以是本机，也可以是负载均衡 / CDN / 另一台 nginx —— 这决定证书在哪申请（见下面 A/B）：

在域名服务商处加一条 **A 记录**：`shop.example.com` → **那台机器的公网 IP**。
（用 Cloudflare 之类的话，先关掉"小黄云"代理，证书申请会更顺。）

> **域名与证书是两件事**：发给买家的地址必须是 `https://shop.example.com`（前端强制 https），
> 但**证书不一定在这台跑节点的机器上**。先想清楚 TLS 在哪终止，再决定用下面哪种拓扑。

验证（在服务器上执行，能返回你的公网 IP 就对了）：

```bash
dig +short shop.example.com        # 或 nslookup shop.example.com
curl -s https://api.ipify.org      # 本机公网出口 IP
```

> 域名没解析好会怎样：只有**选了本机申请证书**（`--tls-mode caddy`/`nginx`）时才强依赖它——
> 那时 Let's Encrypt 校验会失败（节点本身照样跑起来，只是买家还看不到你）。证书在别处时，
> 解析是你和那台机器之间的事，脚本不参与也不会因此报错。

**两种拓扑，先选一种**（决定后面给哪些参数）：

| | A. TLS 在**别处**终止（**默认**） | B. TLS 在**本机**终止 |
| --- | --- | --- |
| 谁拿域名与证书 | 负载均衡 / CDN / 另一台 nginx | 本机：Caddy 容器（`--tls-mode caddy`）或宿主 nginx+certbot（`--tls-mode nginx`） |
| 本机出什么 | `http://<本机>:8090`（容器绑 `0.0.0.0`，给那个入口连） | Caddy/nginx 出 443；节点绑 `127.0.0.1:8090` |
| 本机要证书吗 | **不要**（脚本一个证书都不申请、不碰宿主 nginx） | 要（脚本负责申请与续期） |
| 谁转发到 8090 | 那台外部机器 | 本机的 Caddy / nginx |
| 适用 | 已经有机器/入口在管证书；本机只跑节点 | 一台干净机器，想一条命令全包 |

> 已经装了 nginx（域名与证书都在它上面）的机器属于 **B 的第二种形态**，但**不要**选
> `--tls-mode nginx`（那会在 conf.d 里再写一个 server 块、再申请一张证书，还可能把你现有站点一起
> reload）。正确写法是：`--tls-mode none --bind 127.0.0.1`，然后在**你那份 nginx** 的 server 块里加
> `location / { proxy_pass http://127.0.0.1:8090; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }`。

### 第 2 步：运行 `deploy.sh`

几种跑法，任选其一：

```bash
# A. 交互式（推荐第一次）：问店主地址 / 域名 / HTTPS 在哪终止
git clone https://github.com/delnull/marketplace-node.git && cd marketplace-node
bash deploy.sh

# B. 不落盘、直接跑（脚本会自己把代码取到 /opt/marketplace-node 或 $HOME/marketplace-node）
bash <(curl -fsSL https://raw.githubusercontent.com/delnull/marketplace-node/main/deploy.sh)

# C. 零交互·证书在别处（拓扑 A，**默认**：本机只出 http://<本机>:8090，不申请任何证书）
bash deploy.sh --owner 0x你的店主钱包 --domain shop.example.com --yes

# D. 零交互·本机一键全包（拓扑 B：Caddy 自动申请并续期证书，需 80/443 空闲且域名已解析到本机）
bash deploy.sh --owner 0x你的店主钱包 --domain shop.example.com --email you@example.com --tls-mode caddy --yes

# E. 本机已有 nginx 与证书（拓扑 B 第二形态：节点只监听回环，由你那份 nginx 反代）
bash deploy.sh --owner 0x你的店主钱包 --domain shop.example.com --tls-mode none --bind 127.0.0.1 --yes
```

> `--domain` 只写"这个节点的对外身份"（SIWE 签名原文 + CORS 白名单 + 登记 endpoint），
> **它不会触发本机申请证书**；想让本机全包就显式加 `--tls-mode caddy`。

先用 `bash deploy.sh --dry-run` 可以只打印计划、什么都不改。

### 第 2 步（Windows）：运行 `deploy.ps1`（**原生**，不需要 Docker）

```powershell
# 在**管理员** PowerShell 里（注册开机自启需要它；非管理员会在动手前就拒绝，并说明原因）
git clone https://github.com/delnull/marketplace-node.git
cd marketplace-node
.\deploy.ps1 -Owner 0x你的店主钱包 -Domain shop.example.com -Yes

# 想让本机申请证书： -TlsMode caddy -Email you@example.com
# 已有入口在终止 TLS（默认）： -TlsMode none，节点只出 http://<本机>:8090
.\deploy.ps1 -DryRun          # 只打印计划，什么都不改
.\deploy.ps1 -Status | -Health | -Update | -Uninstall | -Purge
```

它做的事与 `deploy.sh` 逐一对应，只是载体换成 Windows 本机：**找/装 Node**（装就装进安装目录，
不动系统 PATH）→ 写 `<安装目录>\.env`（**同一套键**，ACL 收紧）→ `npm ci --omit=dev` →
注册**开机自启的计划任务**（以 SYSTEM 运行，含崩溃重拉）→ 探活 →（可选）本机 Caddy 申请证书。
安装目录默认 `C:\ProgramData\marketplace-node`；数据在它的 `data\` 子目录里（升级只换代码，不碰它）。

> 两条路径的**合约地址与运行参数来自同一份** `deploy-constants.json`（换批只改那一处），
> 且 `MK_*` 键集合由测试钉住一致——否则同一家店在两种宿主上会悄悄有不同行为。

**脚本会依次做这 9 件事**（每步都会打印它在干什么）：

| 步 | 做什么 | 你可以从中确认什么 |
| --- | --- | --- |
| ① 环境检测 | 系统 / 权限 / `curl` `tar` `openssl`；**检查 Docker，没有就按宿主平台装上并启动** | 判据是**包管理器**而不是发行版名（apt/dnf/yum/zypper/apk/pacman；RHEL 系衍生版名字一直在变，白名单必然漏）。装完会把你的用户加进 `docker` 组，并提醒**重新登录一次**才不用 sudo。**macOS** 上不自动装（Docker 是带虚拟机的应用），只给出该装哪个的指引；**容器内/不可变宿主**（CoreOS 一类）同样只给指引 |
| ② 取代码 | 就地用当前目录；或把当前代码复制到安装目录；或 `git clone`；**宿主机连 git 都没有时，用容器把源码包下载下来** | 安装目录默认 `/opt/marketplace-node`（有 root/sudo 时）或 `$HOME/marketplace-node` |
| ③ 写配置 | 生成 `<安装目录>/.env`（权限 600）：**合约地址已内置**、令牌密钥当场随机生成、数据路径指向卷内 | 重跑会**沿用已有的 `MK_TOKEN_SECRET`**（否则店主登录态全失效），你自己加的配置项也原样保留 |
| ④ 构建镜像 | `docker build`（基础镜像 `node:24-slim`）—— Node 与依赖都进镜像，**宿主不装任何运行时** | 镜像落盘约 370 MB（其中基础镜像约占 330 MB）；构建过程中不额外下载任何系统包（这是刻意的，见 Dockerfile 注释） |
| ⑤ 数据卷 | `docker volume create <服务名>-data`（已存在就沿用） | 商品/订单/附件都在卷里，**容器删了重建数据也在** |
| ⑥ 启动容器 | `docker run -d --restart unless-stopped`：发布端口、挂数据卷、注入 `.env` | 开机自启靠 Docker 的 restart policy，**不需要 systemd 单元** |
| ⑦ 探活 | 循环请求 `http://127.0.0.1:8090/healthz` 直到通过 | 探活的判据是 **HTTP 200**（`"code":0` 是 `--health` 另外 grep 的；链 ID 自检发生在容器**启动期**，探活看不到它——启动日志里才有） |
| ⑧ HTTPS 在哪终止 | **默认在你指定的外部入口**（本机一个证书都不申请，只监听 `http://<本机>:8090`，并打印还差哪三步）；选了 `--tls-mode caddy` 才在本机起 Caddy 自动申请+续期证书（证书存在卷里）；`--tls-mode nginx` 则在宿主装 nginx + certbot（**机器上已有 nginx 站点时会被拒绝**，并给你该用的写法） | **nginx 模式**会先 `nginx -t` 校验、不过就还原成部署前的样子；**Caddy 模式没有这层校验**——Caddyfile 每次整份重写，起不来只在容器日志里报错、要你手工改回。本机已有 nginx 时脚本**不碰你的 conf.d** |
| ⑨ 链上登记 | 只有你给了私钥（`--key-file` 或交互选"现在登记"）才执行：在**容器里**签名并广播 `registerNode`，然后核验 `getActiveNodes()` | 私钥只经**标准输入**进容器、随容器销毁，宿主磁盘上不落任何文件；没给就跳过，第 3 步在网站上登记即可 |

脚本结束时你会看到容器名、数据卷、探活结果、对外地址，以及**下一步该做什么**。

### 第 3 步：在网站上登记（也可以让脚本代做）

登记就是"把你的域名写进链上店铺目录"，这一步之后买家才会看到你。

**方式一：网页向导（推荐，钱包插件签名，最安全）**

1. 打开 [fedmall.bityuan.com](https://fedmall.bityuan.com) → 顶部导航点「**开店登记**」（或直接访问 `/#/open-shop`）；
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

**定价用 USDT，不是人民币**：商品标价的单位是 **USDT**（一种美元稳定币），库里存**微 USDT**
（1 USDT = 1e6），所以**最多 6 位小数**（卖 0.000001 USDT 的东西在系统里是合法的，虽然没人会这么卖）。
商品单价上限 **1000 万 USDT**（1e7）；**运费上限 1000 USDT**，0 = 包邮，且**只有实物商品能设运费**
（数字/NFT 商品填了非 0 运费会被明确拒绝，不是悄悄归零）。买家实付是按官方 BTY-USDT 行情折算出来的
**原生 BTY**，链上托管只收 BTY——**标价币种 ≠ 结算币种**，页面会把折算后的应付金额摆给买家在签名前确认。

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
| **手改过 Caddyfile**（换证书邮箱/加 header/日志） | ⚠️ 每次部署（含 `--update`）都会**整份重新生成**它。脚本会先把上一份备份成 `Caddyfile.bak.<时间戳>` 并告诉你"内容有变化"；把改动合并回去后 `docker restart <服务名>-caddy` 即生效；想整份回退：`cp -a <安装目录>/Caddyfile.bak.<ts> <安装目录>/Caddyfile && docker restart <服务名>-caddy` |
| 重启节点 | `docker restart marketplace-node` |
| 同机再开一家店 | `bash deploy.sh --service shop-b --volume shop-b-data --port 8091 --dir /opt/shop-b`（容器名、卷名、端口三者都要换）。⚠️ 第二家店**不要再选 `--tls-mode caddy`**：Caddy 要独占宿主 80/443，第二个 Caddy 容器会因端口冲突起不来，用 `--tls-mode none` 交给已有反代 |
| 收紧端口暴露面 | 默认按 TLS 方式发布（本机申请证书 → 只绑 `127.0.0.1`；证书在别处 → 绑 `0.0.0.0` 好让那个入口连进来）。同机已有 nginx 反代、走 `--tls-mode none` 时，用 `--bind 127.0.0.1` 只对宿主机暴露（这个选择会记进 `.deploy-state`，`--update` 不会偷偷改回 `0.0.0.0`） |
| 备份 | 导出数据卷：`docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup --entrypoint tar marketplace-node:latest czf /backup/node-data-$(date +%F).tar.gz -C /data .` |
| 恢复 | 先 `docker stop marketplace-node`，再 `docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup --entrypoint tar marketplace-node:latest xzf /backup/node-data-YYYY-MM-DD.tar.gz -C /data`，然后 `docker start marketplace-node` |
| 换域名 | 两件事分开办：① 节点侧重跑 `bash deploy.sh --update --domain 新域名`（只更新 `MK_SIWE_DOMAIN` 与 CORS 白名单；**不会**因为换了域名就去申请证书）；② 证书与入口在你那边同步：本机证书（Caddy/nginx）按新域名重新签发，外部入口改转发规则。然后到开店向导按新 endpoint **重新登记一次** |
| 链上更新登记 / 注销登记 | 到 https://fedmall.bityuan.com 的开店向导里操作（**只有登记时的那个钱包**能更新或注销） |
| 暂停营业 | 前端「卖家面板 → 店铺设置」下架商品；要让目录里也看不到，可在向导里注销登记（数据与订单都还在你的卷里） |
| 关掉节点 | `docker stop marketplace-node`（数据不动）；以后重启：`docker start marketplace-node` |
| 不再需要 / 搬走 | `bash deploy.sh --uninstall`（删容器，**数据卷保留**）；`docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup --entrypoint tar marketplace-node:latest czf /backup/backup.tar.gz -C /data .` 导出后即可换机器 |
| 彻底清除 | `bash deploy.sh --purge`（**连数据卷一起删**，不可逆，需要手输卷名确认） |

**退出码只有这几种**（喂监控/cron 时按这个判，不用去猜 docker 的原生码）：

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 脚本自己的失败（配置不合规、镜像构建失败、容器起不来、端口被占……**原因都在上面的输出里**，脚本一律给出下一步命令） |
| 2 | 用法错（未知参数 / 非法取值）、`--health` 判为不健康、或 `--status` 拿不到结果 —— 适合直接当告警信号 |

> 端口被占这类 docker 原生失败（`docker run` 返回 125）**不会漏出脚本**：脚本会把 docker 的原始
> 报错与退出码一起回显，然后以 **1** 结束，并清掉这次没起来的空壳容器（否则下次重跑会撞上
> "容器已存在"，把真原因盖掉）。


**容器名、卷名、端口是"这套安装的身份"**：安装目录里会留一份 `.deploy-state`（记下它们），
`--update` / `--status` / `--health` / `--uninstall` 会自动沿用，不用每次重复指定。
容器名在同一台机器上是唯一的：若这个名字已被占用（**脚本不判断它属于哪套安装**），
脚本会拒绝覆盖并报出真实文案「容器 xxx 已存在」，出路只有两条——升级（`--update`，会接管这个名字）
或确认要覆盖重建再加 `--force`。

**关于备份的边界**：链上的钱不需要你备份（托管在合约里）；需要备份的是**你的商品、订单、
客户收货信息与证据附件**——它们只存在于你机器上的那个**数据卷**里。丢了就是真丢了，且没有第三方副本。
（卷名默认 `marketplace-node-data`，容器内是 `/data`；导出/恢复命令见上面「日常运维」那一行。）

---

## 五、配置项（`.env`）

脚本生成的 `.env` 里**合约地址已经填好**（来自 `deploy-constants.json`，两条部署路径共用那一份），
正常情况下一行都不用改。要改的通常只有端口或 CORS：

**完整配置清单（含每一项的中文注释与默认值）在 `.env.example`**——那里是唯一一份，别处不再抄第二份。
下表**只列"改了会出事"的项**：

| 键 | 改了会怎样 |
| --- | --- |
| `MK_SHOP_OWNER` | 店主钱包地址 = 店铺身份锚点。**改它不等于换店主**（换店主走链上 `transferNode`） |
| `MK_ESCROW_ADDRESS` / `MK_REGISTRY_ADDRESS` | 本联邦的共享合约。**别改**：改了节点就去读别的链/别的合约，前端会直接拒绝登记 |
| `MK_RPC_URL` / `MK_CHAIN_ID` | 节点启动时自检链 ID，指错链会拒绝启动 |
| `MK_DB_FILE` / `MK_ATTACH_DIR` | 数据与附件路径。**别改成卷外的路径**（例如 `/tmp/x.db`）——那样容器一重建数据就没了 |
| `MK_CORS_ORIGIN` | 允许哪些站点跨域读你的节点。**类生产下要显式白名单**——写 `*` 等于"谁都能读" |
| `MK_TOKEN_SECRET` | 登录令牌签名密钥。**别改**：改了店主所有登录态失效；**别外传**：泄漏等于店主身份可被伪造 |
| `MK_PII_RETENTION_DAYS` | 终局订单的个人信息到期自动擦除（`0` = 关闭）。**它管的是个人信息，不是订单事实**：金额与订单记录一律保留 |

> ⚠️ `bash deploy.sh`（含 `--update`）**每次都会整份重写 `.env`**：上表这些键由脚本重新写入，
> **手工改过的值会被静默改回**。要长期生效就改脚本用的常量（`deploy-constants.json`）或改用脚本不接管的键；
> 不在脚本接管清单里的键（例如你自己加的风控闸、兜底汇率、通知配置）会被原样保留。

---

## 六、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 我只要一个域名、证书自己在别处弄，脚本却在本机折腾证书 | 旧口径下"给了 `--domain` 就当你要在本机申请证书"；现在**默认不申请**。若你看到它去起 Caddy/装 nginx，说明你（或旧命令里）显式给了 `--tls-mode caddy/nginx`——去掉它重跑 `bash deploy.sh --update --yes` 即可，本机只监听端口 |
| 脚本拒绝 `--tls-mode nginx`：本机已有 nginx 站点 | 这是刻意的：再写一个 `listen 80` 的 server 块会与同机站点争 `server_name`，而 `systemctl reload nginx` 会把它们一起卷进来。改走：`bash deploy.sh --update --tls-mode none --bind 127.0.0.1 --yes`，再在**你那份 nginx** 里加 `location / { proxy_pass http://127.0.0.1:8090; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }` |
| 脚本第 ⑧ 步证书申请失败 | **只在你选了本机申请证书时才会遇到**：域名没解析到本机 / 80 端口没放行 / 用了 CDN 代理。**Caddy 的报错在 `docker logs marketplace-node-caddy` 里**；修好后重跑 `bash deploy.sh --update --domain 你的域名`。用宿主 nginx 模式的话，也可手动 `sudo certbot --nginx -d 你的域名`。不想在本机申请：`--tls-mode none`，证书交给你的入口 |
| 节点起不来，日志说 `MK_TOKEN_SECRET` 不合格 | 密钥被改短或被替换成示例值。删掉 `.env` 里那一行后重跑 `bash deploy.sh --update`（会重新生成），代价是店主登录态失效 |
| 日志说 `chainId` 不符 | `MK_RPC_URL` 指到了别的链。改回 `https://mainnet.bityuan.com/eth` 后 `bash deploy.sh --update` |
| 端口被占用 | 同机已有服务占了 8090。换一个：`bash deploy.sh --update --port 8091`（会重建容器并更新反代配置） |
| `--update` 报"容器 xxx 已存在" | 同名容器已被占用（**脚本不判断它属于哪套安装**）。出路：`--update` 接管这个名字升级，或确认要覆盖重建再加 `--force`。**别用 `--force` 去覆盖不认识的安装** |
| 同机想开第二家店 | 必须给三个都不同的值：`--service shop-b --volume shop-b-data --port 8091 --dir /opt/shop-b`（容器名与卷名全机唯一，端口不能撞） |
| 同机再开一家店时提示"数据卷不存在" | 卷名默认跟着 `--service` 走；如果你只改了 `--service` 而没改 `--volume`，新安装会去找 `<新服务名>-data`。要么让它自动建，要么显式 `--volume` 指到已有的卷（**想让两家店共用一个库是行不通的，各自一份**） |
| **服务器访问不了 GitHub** | 脚本取代码有两条路：宿主机 `git clone`，或（宿主机没有 git 时）**用容器下载源码包**——两条都要能访问 GitHub。完全出不了网的做法：在能上网的机器上打开仓库页 → **Code → Download ZIP**，把压缩包传到服务器解压，进去跑 `bash deploy.sh`。**镜像构建除了基础镜像，还要从 npm 拉依赖**（`npm ci --omit=dev`）：受限网络要把 Docker 镜像加速与 npm 源一起准备好 |
| 拉不到基础镜像（build 卡住 / `EOF`） | `node:24-slim` 来自 Docker Hub。配一个镜像加速器，或先在有网机器上 `docker pull node:24-slim && docker save` 再传到服务器 `docker load` |
| 升级时想让它别追问域名 | 已有 `.env` 且没配域名时，脚本走的是"沿用现有配置"，**不会追问**（旧的"非交互环境无法询问域名"提示已删除）。要加域名就显式 `--domain 你的域名`；不加就 `bash deploy.sh --update --yes` |
| 前端首页看不到我的店 | ① 还没链上登记（去做第 3 步）；② 登记的 endpoint 与你的实际域名不一致；③ 你的节点从公网不可达（`curl https://你的域名/api/shop` 试试）；④ 反代/证书有问题。**没有登记过的节点一定不会被展示**——这是刻意的，没有静态兜底店铺列表 |
| 网页向导说"该节点不能登记到本前端" | 你节点的 `MK_ESCROW_ADDRESS` 与本前端配置的 canonical Escrow 不一致（一般是被改过）。恢复内置值再试 |
| 向导说"与当前钱包不同" | 你连的钱包 ≠ 部署时的 `MK_SHOP_OWNER`。请换回那个钱包（链上 `operator` 就是当前钱包，登记错了之后只能用那个钱包更新/注销） |
| 买家下单失败 / 页面空白 | 跨域被拦：确认 `.env` 的 `MK_CORS_ORIGIN` 含 `https://fedmall.bityuan.com`；改完跑 `bash deploy.sh --update`（`docker restart` 不会重新读 `.env`） |
| 页面上只有 USDT 标价、没有 BTY 应付金额 | 你的节点取不到行情。你的服务器只要访问得到一个地址：`https://mainnet.bityuan.com/tapi/ticker`（官方 BTY-USDT 行情）。先 `curl https://你的域名/api/rates` 看返回：`available:false` = 现在报不出价（八成是出网被限，且没配兜底）；`available:true` 时再看两个标记——`stale:true` = **最近一次打上游失败了**（手上这个数是缓存里上一轮的实时值），`fallback:true` = **手上这个数是你自己填的兜底值**（不是行情）。两者含义不同，节点的响应体里一直分开报。行情**只是展示与折算**，买家签名确认的支付金额才是准的 |
| 想确认行情来源与新鲜度 | 标价单位已是 USDT，所以行情**只有官方 BTY-USDT 这一条腿**（旧的 USDT→CNY 法币腿连同它的三个公共源、多源中位数与缓存 TTL 已整体删除）。`curl https://你的域名/api/rates` 看 `btyUsdt`（1 BTY = x USDT）与 `usdtToBty`（1 USDT = x BTY），两者互为倒数 |
| 行情看着"不动" / 想知道数据有多新 | `/api/rates` 里的 `updatedAt` 是**上一次尝试**取数的时刻（毫秒；**失败也会更新**，所以它比"手上这个值的年龄"更乐观，只能当"最近一次打上游是什么时候"看）。默认 1 分钟一刷——这个数直接决定买家要付多少 BTY，跟得紧是刻意的 |
| 担心行情接口把我的 IP 封了 | 打的是官方端点，正常情况下**一分钟最多一次**（一天约 1440 次）。并发请求会被合并成一轮（single-flight），不会因为访问量涨了就多打上游。**别把 TTL 调到秒级**——那才是被封的原因。注意：`GET /api/rates` **就是刷新触发点**（缓存到期才会真打上游，没到期只回缓存值）——"读接口不会打上游"是错的 |
| 想换店主钱包 | 走链上 `transferNode`（双方签名），**不要**直接改 `.env`（见 `docs/OPERATIONS.md` §6.2） |

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
  （`MK_PII_RETENTION_DAYS`，金额与订单事实保留）。**要按单立即擦除，目前只能你自己用店主令牌调
  `POST /api/shop/orders/:id/erase-pii`——卖家面板里没有这个按钮**（接口只认 ownerOnly，店员无权）。
- **合约未经独立审计、不可升级**：承载大额资金前请自行审计。
- 本项目代码仅供学习研究参考，不构成任何投资或法律意见；正式经营前请就你的具体情形咨询执业律师。

---

## 八、技术要点

- **运行要求**：宿主只要能跑 **Docker**（脚本会自己装）。Node 与依赖都在镜像里
  （镜像基于 `node:24-slim`，节点用 Node 内置的 `node:sqlite`，**零原生依赖**，不需要 MySQL / Redis）；
  一台 1 核 1G 的机器就够。构建镜像时**除基础镜像与 npm 依赖外不下载任何系统包**——
  这是刻意的：宿主机的包源/镜像源是最不可控的变量，实测有机器连不上某些 CDN，构建就会长时间卡住
- **端口**：容器内固定监听 `8090`；发布到哪个宿主地址由 `--bind` 决定——**配了本机 TLS 默认 `127.0.0.1`，不配 TLS（默认的 `--tls-mode none`）默认 `0.0.0.0`**，也就是默认发布在所有网卡上，对外由你自己的入口/反代负责
- **数据**：数据库与证据附件都在**命名卷**里（容器内挂成 `/data`）。备份/恢复就是导出/导入这个卷——
  **不要**用 `docker commit` 去固化数据，也不要往容器里写业务数据（容器一删就没了）
- **判定"节点正常"的三个真值**（`GET /healthz`）：`code:0`、`escrowAddress` 是本联邦的托管合约、
  `owner` 是你的店主地址；其中 `watcher` 段还能看到链上事件扫描游标是否在推进
- **行情（价格换算的关键）**：只有**一条腿**——官方 `mainnet.bityuan.com/tapi/ticker`（BTY-USDT，
  默认 1 分钟一刷，它直接决定买家要付多少 BTY）。上游取数失败**不丢旧值**（上一轮的实时值仍比"没有价格"强），
  只有从未取到过值且你配了 `MK_FALLBACK_BTY_USDT` 才回退那个手工数；两种情况都在 `/api/rates` 里如实
  标出 `stale` / `error`，一条腿都取不到时是 `available:false`（前端只展示 USDT 标价、不显示 BTY 估算）。
  **不会静默到"全站突然没有价格"**：取不到页面就照实说，不会拿旧值或 0 糊过去。
- **标价与上限**：商品标价单位是 **USDT**（一种美元稳定币），库里存**微 USDT**（1 USDT = 1e6），
  所以定价支持**最多 6 位小数**（`0.000001 USDT` 也是合法价；展示时**最多 6 位、去净尾零**，
  `25` 而不是 `25.00`——所以页面上金额后面一定跟着 `USDT` 单位）；
  商品单价上限 **1000 万 USDT**（1e7；再大就会让"单价 × 99 件"越过 JS 安全整数，
  而那种订单行会让订单面板整片读不出来），运费上限 **1000 USDT**（0 = 包邮，仅实物商品可设）。
  买家实付按上面那条 BTY-USDT 行情折算成原生 BTY，链上托管只收 BTY——**标价与结算币种不同**，
  这一点在下单弹窗里对买家明示。
- **目录**：`src/`（路由与业务逻辑）、`scripts/`（登记/对账/体检等工具，都在**容器里**跑）、
  `test/`、`Dockerfile` + `docker-entrypoint.sh`（镜像怎么构建、容器怎么降权启动）、`shared/shopCode.js`（店铺编号算法）

部署、运维与排错需要的东西都在本文与 `bash deploy.sh --help` 里；接口的具体行为可以直接读 `src/`。

---

## 九、延伸阅读（店主口径，就在本仓 `docs/` 里）

| 文档 | 什么时候看 |
| --- | --- |
| [店主合规与责任手册 **COMPLIANCE.md**](docs/COMPLIANCE.md) | **开店前必读**：经营者的法律义务、个人信息怎么处理、收到买家投诉或监管调取请求时怎么办 |
| [开店节点运维手册 **OPERATIONS.md**](docs/OPERATIONS.md) | 备份/恢复/迁移/升级/密钥轮换/故障速查（照着做就行） |
| [钱、订单与边界 **MECHANICS.md**](docs/MECHANICS.md) | 钱是怎么被保护的、订单与售后怎么流转、这个产品**明确不做**什么、有哪些已知缺口 |
