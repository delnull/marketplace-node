# 联邦商城 · 开店节点运维手册（节点主版）

> 读者是**节点主**：这台机器与 `MK_SHOP_OWNER` 的主人，不一定是某家店的店主。店铺是节点上的租户：
> **`shops.seller` 才是店主**，订单货款归店主，节点只按 `commissionBps` 抽成给节点主。
> 开一家**能卖货**的店 = 一台跑着这个节点的服务器 + 链上**节点登记**（`registerNode`）+ 这家节点下的**一家店**
> （店主与节点主/本节点员工双签 `registerShop`）。**只做 `registerNode` 不会出现店铺，卖家面板也没有可经营的店**（见 §0.5）。
> 三条原则：**动手前先备份**；**涉及资金先对账**；**看不懂的字段照表判，不要猜**。
>
> 本文是 **Docker 版**：宿主机上只有 Docker、一个可连的 MySQL 8 与一个数据卷，**宿主机不装 Node，也没有 systemd 单元**。
> 例外只有一处：选了 `--tls-mode nginx` 时脚本会在宿主装 nginx + certbot 并写 `/etc/nginx/conf.d`（详见 §0.4 与 §9）；
> 默认的 `--tls-mode none` 不在宿主装任何东西，反代与证书都由你自己的入口负责。
> 旧版的"宿主安装 + systemd"已不再支持；正式站那台已于 **2026-10-13 整套删除**。本手册**没有** systemd 回滚路径——回滚只回滚容器镜像（旧机器上的残留单元清理见 §9）。

| 本文约定 | 含义 |
|---|---|
| `<安装目录>` | 代码 / 配置 / 状态文件所在目录，默认 `/opt/marketplace-node`（有 root/sudo 时）或 `$HOME/marketplace-node`（脚本的 `--dir`） |
| `<容器名>` | = 服务名，默认 `marketplace-node`（脚本的 `--service`），也就是 `docker` 里的容器名 |
| `<数据卷>` | 默认 `marketplace-node-data`（脚本的 `--volume`），挂进容器是 `/data`。里面有：证据附件（`attachments/`）、**商品媒体（`uploads/`：图片 ≤2MB、视频 ≤50MB，每个视频单独一份原始文件）**。**商品、订单、客户收货信息在 MySQL 库里**（不在卷里）——所以库与卷要**分别备份**（§2） |
| `<端口>` | **宿主**上发布的端口，默认 `8090`（脚本的 `--port`）；容器内固定监听 `8090` |

> 下面的命令一律按**默认名字**写。同机开了第二个节点、或改过 `--service / --volume / --dir / --port` 的，
> 把命令里的名字换成 `bash deploy.sh --status` 打印出来的那一套（它同时记在 `<安装目录>/.deploy-state` 里）。

硬约束（违反会出各种怪问题）：

- **一个节点一个库，节点里的店铺都在这个库里**：店铺是库里的行（`shops` 表 + 商品/订单上的 `shop_code`），所以**同一节点里多开几家店不需要动数据库**（走 §0.5 的开店申请）。要另起一个**节点**才需要另一个 `MK_DB_NAME`——同机跑多个节点共用一个 MySQL 实例没问题，各自一个库即可。
- **一个库只能给一个节点进程用**：别把同一个库接给两个容器、也别在宿主机上再起一个进程连它。节点启动时用 MySQL 咨询锁把库独占，**已有进程时直接拒绝启动**（这不是可选项：事件轮询游标、告警去重、库存占位回补都靠进程内状态，两个进程接同一个库会把链上事件应用两次、库存占位被重复回补，**而且不报任何错**）。
- **`MK_DB_HOST` / `MK_DB_USER` / `MK_DB_NAME` 必填、没有默认值**：缺失或为空一律**拒绝启动**并打印该怎么填。口令留空**只在库就在本机时**允许；对着远程库留空同样拒绝启动。库本身不用预先创建——首次启动会自动 `CREATE DATABASE IF NOT EXISTS`，但**排序规则必须是 `utf8mb4_0900_as_cs`**，且账号还要能建结构自检用的临时库（见 §0.2）。
- **`deploy.sh` / `deploy.ps1` 不写 `MK_DB_*`**：这五个连接键必须由你写进 `<安装目录>/.env`，脚本重跑时原样保留。没有它们，新安装会在节点启动的 `initDb()` 处退出。
- **`MK_TOKEN_SECRET` 必须是 ≥32 字符的强随机值**：缺失 / 过弱 / 仍是模板示例值一律**拒绝启动**，没有旁路开关。
- **改完 `<安装目录>/.env` 必须重建容器**（`bash deploy.sh --update`）：`.env` 是 `docker run --env-file` 在**创建容器那一刻**读进去的，`docker restart` 只是重跑同一份旧配置——改了等于没改，这条最容易白忙一场。
- **进容器一律带 `-u node`**：`docker exec -it -u node <容器名> sh`。容器主进程以 uid 1000（非 root）运行，但 `docker exec` **默认仍以 root 进入**——用 root 在卷里写文件会让节点之后**写不动**（症状与修法见 §9）。
- **对外必须 https**：联邦前端是 https 页面，浏览器会拦掉对 http 节点的请求。
- **节点在反向代理后面时设 `MK_TRUST_PROXY`**：不设时限流键、审计 `ip` 与请求日志都只看到代理那一个地址（所有匿名客户端共用一个限流桶）。本机 Caddy 是容器，来源是 Docker 网段（`docker network inspect <服务名>-net` 看 Subnet）；宿主 nginx 填 `loopback`。这个键**不归脚本管理**，`--update` 会原样保留。

## 0. 开始前（新装 / 重装必读）

### 0.1 合约常量（不是 `.env`，是仓库里的 `node/deploy-constants.json`）

`deploy.sh` 在解析参数**之前**读 `node/deploy-constants.json` 的 `contracts` 五项：
`escrow` / `registry` / `blocklist` / `startBlock` / `escrowCodeHash`。**当前仓库里这五项是空值**；`escrow` / `registry` / `blocklist` 为空、或 `startBlock=0` 时，脚本**所有模式**都会拒绝执行——包括 `--help`、`--dry-run`、`--status`、`--health`、`--update`、`--register`。五项必须由部署方按**同一批**部署结果填好；`blocklist` 是 Registry 构造函数的 immutable，必须与 Registry 同批；`escrowCodeHash` 为空会被 `deploy-plan.test` 的机械守卫抓住（它不参与 `deploy.sh` 的启动门禁，但它是"仓库记的地址与本批源码同一代"的唯一机械判据）。

本联邦是五份合约：**Escrow / Registry / Blocklist / Staking / ReviewNotary**。节点直连前三份；`Staking` 通过 `Registry.stakingContract` 读 `poolOf`（不配独立的 Staking 地址）；`ReviewNotary` 只由前端用（节点只算内容哈希，不读它的地址）。

`deploy/node.env` 里的 `MK_ESCROW_ADDRESS` / `MK_REGISTRY_ADDRESS` / `MK_BLOCKLIST_ADDRESS` / `MK_ESCROW_START_BLOCK` **只用于 `deploy-node.ps1` 发布后核对**，不会传给节点；真正喂给节点的是 `deploy-constants.json`（经 `deploy.sh` 写进 `.env`）。两处都要填同一批，但**不要**试图只改 `deploy/node.env` 来换合约。

标准部署一定有 Blocklist。因此**下单闸默认就是开着的**：每笔下单都会先做一次链上地址查询，`MK_ORDER_GATE_URL` 留空**不等于**没有闸（见 §9 的「全店突然下不了单」与 §10）。

### 0.2 MySQL 8（新装前必须准备）

1. 装 MySQL 8（发行版包 / 官方镜像 / 托管实例都行），确认**节点容器或进程能连到**它。容器里的 `127.0.0.1` 指容器自己——MySQL 在宿主机上时要填宿主机的内网 IP（或 `host.docker.internal`，按 Docker 配置），不能填 `127.0.0.1`。
2. 建库与专用账号，**排序规则必须是 `utf8mb4_0900_as_cs`**（节点启动会校验，不对就拒绝启动）：
   ```sql
   CREATE DATABASE IF NOT EXISTS mk_node CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
   CREATE USER 'mk_node'@'%' IDENTIFIED BY '<强口令>';
   GRANT ALL PRIVILEGES ON `mk_node`.* TO 'mk_node'@'%';
   ```
3. **还要给结构自检的临时库授权**：启动时会在同实例创建一个由 `MK_DB_NAME` 派生的临时库（`mk_schema_probe_<hash>`，名字固定），把建表语句全量执行一遍再删掉。账号只授权目标库时，启动会拒绝并**原样打印**临时库名与要补的 `GRANT ALL PRIVILEGES ON \`<临时库>\`.* …`；照它补一条即可。
4. 首次启动前把 `MK_DB_HOST` / `MK_DB_PORT` / `MK_DB_USER` / `MK_DB_PASSWORD` / `MK_DB_NAME` 写进 `<安装目录>/.env`。两种做法：
   - **先写再跑**：在代码目录创建 `.env` 写好这五行，再 `bash deploy.sh`；
   - **跑一次再补**：先跑一次（节点会在 `initDb()` 处退出），编辑脚本已经写出的 `<安装目录>/.env` 补上五行，再 `bash deploy.sh --update`。
5. 同一台 MySQL 上跑多个节点：每个节点用**不同的 `MK_DB_NAME`**；两个进程接同一个库会被实例锁拒绝启动。

### 0.3 节点主钱包（`MK_SHOP_OWNER`）

`MK_SHOP_OWNER` 是**节点主 / operator**（`node.owner`）的身份锚点，**启动必填**（缺失时 `db.js` 直接退出）。链上 `registerNode` 的 operator 应与它是同一个钱包。

> `deploy.sh` 的交互提示与部分报错仍把它叫"店主钱包地址"——按本节的**节点主 / operator**理解；填成某家店的 `shops.seller` 会让节点自报的 owner 与链上 operator 对不上。

它**不是**店主，也不是每笔货款的收款人：店铺店主是 `shops.seller`，货款归店主，节点只按 `commissionBps` 抽成给节点主。只改 `.env` 里的 `MK_SHOP_OWNER`**不会**改链上 operator（要改节点主走链上 `transferNode`，见 §6.2）；它也不会改任何一家店的店主。

### 0.4 HTTPS 与 Caddy（选了本机申请证书时）

买家看到的节点地址必须是 `https://`。TLS 在哪终止由 `--tls-mode` 决定（`none` 默认 / `caddy` / `nginx`）：

- `--tls-mode caddy` 由 `deploy.sh` 起一个 **Caddy 容器** `<服务名>-caddy`（默认 `marketplace-node-caddy`），映射 80/443，证书数据在 `<服务名>-caddy-data` 卷里。**Caddy 模式必须有域名**；不给域名脚本会把有效 TLS 退回 `none`。
- 看它有没有起来：`docker ps --filter name=marketplace-node-caddy`、`docker logs --tail 100 marketplace-node-caddy`。
- Caddy 容器没起来 / 证书要重签：先放行 80/443、确认域名已解析到本机，再 `bash deploy.sh --update --tls-mode caddy --domain 你的域名 --yes`（会重建 Caddy 容器；证书还在原来那个卷里，不会因为重建容器重新申请）。
- **只在 `--update` 时给 `--domain` 而不给 `--tls-mode`，有效 TLS 会变成 `none`**，旧 Caddy 容器还可能继续占着 80/443。换域名/重签时把 `--tls-mode caddy` 一起写上。

### 0.5 节点 ≠ 店铺（`registerNode` 不会开店）

1. **节点登记**：节点主钱包调用 `registerNode(operator, endpoint, escrow, signature)`，把 `https://你的域名` 写进链上节点目录，让前端能发现这台机器。**这一步不创建任何店铺。**
2. **店主提交申请**：店主钱包在前端「申请开店」里选这台节点，只填店名/公告（**不填抽成、不签名**；抽成是节点主的基础设施费）。
3. **节点主设置抽成并审批**：节点主/员工在 `/applications/:id/review` 里填 `commissionBps`（0–1000 = 0–10%）并通过，节点返回同一张票据摘要；店主先对这张票据签名（`POST /applications/:id/seller-sign`，接受节点主设置的条款），节点主/员工再对同一张摘要签名并回传 `/sign`。
4. **广播 `registerShop`**：必须由**节点主或本节点员工钱包**发起（合约用 `_actingHost()` 认节点），gas 由发起人付。
5. **核验上链**：把交易哈希回传 `/applications/:id/verify-onchain`，节点按链上 `ShopRegistered` 事件与 `getShop(seller, host)` 读数落本地 `shops` 行。**只有这一步之后，`/api/shops` 里才有这家店，卖家面板才能上架商品、接单。**
6. 节点主自己开店也走同一条申请：申请人 = 节点主，审批时设置的 `commissionBps` 必须为 `0`（合约与节点都会拒绝自己给自己抽成）。四份合约的 owner、节点主、节点员工、店主、平台费收取人都**不能**当仲裁人（见 §10）。

## 1. 日常检查（每天两分钟）

| 想确认什么 | 命令 |
|---|---|
| 容器 / 数据卷 / 关键配置 / 健康状态 / 最近日志 + 探活，一次看全 | `cd <安装目录> && bash deploy.sh --status` |
| 只要一行探活结论（适合喂监控/cron；不健康会以 **exit 2** 结束） | `cd <安装目录> && bash deploy.sh --health` |
| 容器在不在、健不健康 | `docker ps --filter name=^marketplace-node$`（STATUS 一栏应看到 `Up … (healthy)`；不加 `^…$` 会把 `marketplace-node-caddy` 也列出来） |
| 实时看日志（日志走 stdout，容器版没有 journald） | `docker logs -f marketplace-node`（只看最近 100 行：`docker logs --tail 100 marketplace-node`） |
| 手工读健康检查 | `curl -s http://127.0.0.1:<端口>/healthz` |
| CPU / 内存占用 | `docker stats --no-stream marketplace-node` |

> `--status` 与 `--health` **不是同一份输出**：`--status` 列容器/卷/配置/日志，`--health` 只回答"活着吗"并给一行结论。`--status` 的退出码只表示**有没有拿到探活响应**——即便 `/healthz` 返回 503，只要正文非空它也会以 0 结束；健康判据要用 `--health`，或自己看正文里的 `code` 与 §1 的四块读数。`--status` 完全拿不到响应时才以 exit 2 结束；退出码口径见 §9。

> **容器 `healthy` 现在也包含 watcher 判据**：镜像里的 `HEALTHCHECK` 按 `/healthz` 的响应是否 2xx 判（healthz 在 watcher 停滞或存在隔离事件时返回 **503**，容器会变成 `unhealthy`）。但它**仍然看不出** `reconcile`、`piiRetention`、`terms` 这三块后台任务停摆——那些只有在 `/healthz` 的响应正文里才看得到。

> **服务活着 ≠ 所有后台任务在跑。** `/healthz` 的 `data` 里有四块后台任务状态：`watcher`（链上事件扫描）、`reconcile`（链上状态对账）、`piiRetention`（个人信息到期擦除）、`terms`（链上佣金条款/在售状态镜像）。同一个响应里还有 `owner`（节点自报的节点主地址）与 `escrowAddress`（节点自报的托管合约）——它们应与 `.env`/本批常量一致，因为买家下单弹窗会拿链上登记与节点自报交叉比对，**不一致就直接拒绝支付**。

| 块 | 字段 | 正常长什么样 | 什么时候要管 |
|---|---|---|---|
| watcher | `configured` | `true`（已配 `MK_ESCROW_ADDRESS`） | `false` = 纯展示模式、**不能下单**；不是预期就查配置 |
| watcher | `lastOkAt` / `lastPollAt` | 持续推进（默认 15 秒一轮，`MK_ESCROW_POLL_MS`） | 超过 3× 轮询间隔不推进 = **轮询停摆**（此时 `/healthz` 已经 503） |
| watcher | `lastError` | `null` | 非 `null` 即告警（RPC 不可达 / 解析失败） |
| watcher | `lagBlocks` | 在 **0 ↔ 12** 之间摆动 | **只看趋势**：持续单调增长且 `upToDate` 长期为 `false` = 轮询跟不上或被 RPC 限流。**「停在 12」不是故障** |
| watcher | `quarantined` | `0` | **>0 要人工介入**：有事件被跳过，相关订单不会回写（处理见 §9；此时 `/healthz` 也是 503） |
| reconcile | `enabled` | `true` | `false` 而你以为它在兜底 = 没有任何自动修复（未配 `MK_ESCROW_ADDRESS` 时就是 `false`） |
| reconcile | `lastOkAt` / `lastRunAt` | 持续推进（默认 10 分钟一轮，`MK_CHAIN_RECONCILE_MS`） | 超过 3× 周期不推进 = **对账停摆** |
| reconcile | `lastError` | `null` | 非 `null` 即告警：此时滞留单不会被修回 |
| reconcile | `lastRepaired` / `lastMissing` | `0` / `0` | `lastRepaired > 0` 值得追因（轮询器漏过一单）；**`lastMissing > 0` 必须人工核**（多半是合约地址 / 链 ID 配错） |
| piiRetention | `days` / `enabled` | 与你要求的保留期一致（默认 180 天） | `days` 不符就改（见 §8）；**以为开着、其实 `enabled=false` 最危险**（个人信息一直留着） |
| piiRetention | `lastOkAt` / `lastRunAt` | 持续推进（默认每 6 小时一轮） | 超过 3× 周期不推进 = **擦除停摆** |
| piiRetention | `lastError` | `null` | **非 `null` 即告警**：擦除不可逆，静默失败只会让个人信息越留越久 |
| piiRetention | `lastErased` / `lastScanned` / `lastCleanupPending` | 供人工核对（累计口径看审计 `order.erase_pii`） | `lastCleanupPending > 0` = 有单只擦了库、附件文件没删净（去清附件目录权限/占用） |
| terms | `enabled` / `degraded` / `lastError` | `true` / `false` / `null` | `degraded:true` = 本轮**所有店铺**的链上条款/在售状态都读不到，本地费率镜像可能过期；`enabled:false` = 未配 Registry/未启动 |

> 基线：轮询器只处理「链头 − 确认深度」之前的事件（`MK_ESCROW_FINALITY_BLOCKS`，默认 12 块 ≈ 1 分钟），所以**买家付款后订单滞后约 1 分钟才变「已托管」是正常的**，不是节点卡住。`lagBlocks` 也不是"落后量"：追平时它被置 0，链头前进后下一轮又 ≈12。

建议固化的动作：

- **对账（节点级多店）**：`docker exec -u node marketplace-node npm run reconcile`。
  链上按 **`OrderCreated.host == MK_SHOP_OWNER`** 认本节点订单（`seller` 是店主，不是节点主；同一 seller 在别的节点的单会被 host 判据排除）；host 已由创建事件携带，区间内**零逐单 eth_call**；只有本地订单的创建事件在扫描区间外时才回退读 `commissionTermsAtCreate.payee`。本地从 `v_orders` 读**全部**带链上单号的订单，并按 `shop_code` 分店汇总。默认从 `MK_ESCROW_START_BLOCK` 覆盖全史；没有该值时用 `--blocks` 回溯（多店节点不要依赖默认回溯，历史单会进入“覆盖不足/没核对成”）。
  退出码：**0** = 本节点全部店铺一致（或仅覆盖不足提示）；**2** = 存在差异（本地入账但链上未终局/查无此单、本节点漏扫链上已结算单或已过确认深度的在途单、链上 host 是别的节点（含非入账态）、seller 错位、链上已全额退款但本地记收入/本地完全没有该退款单、本地草稿/已取消但链上已有托管、状态不同步、两侧净额差额 ≠ 0）；**3** = **没核对成**（链上 host/`sellerNetAtSettle`/`commissionAtSettle`/`getOrder` 读不到，或本地平台费/抽成快照从未补录）；**1** = 脚本自身失败。`--db-only` 只做本地汇总，仍不连链。
- **每周抽查审计**：本店 `/api/shop/audit`（`ownerOnly`，只出该 `shops.seller` 这家店的行）、节点级 `/api/shop/audit/node`（`hostOnly`，只出 `shop_code IS NULL` 的节点级行：节点资料、开店审批、保留期触发等）。节点主**读不到租户店的审计行**，店主**读不到节点级**行。
- 日志里留意 `[escrowWatcher]`、`[chainReconcile]`、`[autoDeliver]`、`[poolAlert]`（已收款但池内资源不足）、`[pii]`（擦除 / 附件删除失败）、`[webhook] 通知失败`、`[sweeper]`、`[audit] 写入失败`、`[server]`。

**几个不常做、但一定会用到的动作**：

| 想做的事 | 命令 / 做法 |
|---|---|
| 换域名 | 两件事分开办：① 节点侧 `bash deploy.sh --update --domain 新域名`（更新 `MK_SIWE_DOMAIN` 与 CORS 白名单，**不会**因为换域名就去申请证书）；② 证书与入口那侧同步；③ 到前端开店向导里用**节点主钱包**重新登记节点。用 Caddy 的安装要写全 `--update --tls-mode caddy --domain 新域名`，否则有效 TLS 会退回 `none` |
| 同机再开一个**节点** | `bash deploy.sh --service shop-b --volume shop-b-data --port 8091 --dir /opt/shop-b`（容器名、卷名、端口三者都要换，并给它**不同的 `MK_DB_NAME`**）。第二个节点**别再选 Caddy 模式**：`80/443` 已经被第一个节点的 Caddy 容器占着——用 `--tls-mode none`（交给已有反代）。**多开一家店不是这个操作**——同一个节点里多开几家店走 §0.5 的开店申请，不用动数据库 |
| 链上更新 / 注销**节点**登记 | 到 https://fedmall.bityuan.com 的开店向导里操作（**只有登记时的那个 operator 钱包**能更新或注销节点登记）。店铺的关店是另一件事：店主在卖家面板「店铺设置 → 店铺生命周期 → 关店」做 `deregisterShop`（只注销这一家店） |
| 暂停营业（某一家店） | 前端「卖家面板 → 店铺设置」把商品下架；要让**这家店**从目录里也消失，店主在卖家面板「设置 → 店铺生命周期 → 关店」（`deregisterShop`）。**数据与订单留在 MySQL 库与数据卷里**，重新走 §0.5 的双签即可复业（编号沿用）。**不要用注销节点来暂停一家店**——那会让整台节点从目录消失 |
| 本机 Caddy 没起来 / 证书没签发 | `docker ps --filter name=marketplace-node-caddy`、`docker logs --tail 100 marketplace-node-caddy`；确认 80/443 未被占、域名已解析到本机。重建：`bash deploy.sh --update --tls-mode caddy --domain 你的域名 --yes`（证书数据在 `<服务名>-caddy-data` 卷，重建容器不会重新申请）。不想在本机申请就改走 `--tls-mode none` |
| 关掉节点（数据不动） | `docker stop marketplace-node`；以后恢复：`docker start marketplace-node` |
| 不想再用这套安装（但留数据） | `bash deploy.sh --uninstall`：移除节点容器与 Caddy 容器、删掉它们之间的网络，**数据卷保留**；`.env` 与状态文件也留在安装目录 |
| 彻底清除（不可逆） | `bash deploy.sh --purge`：**连数据卷一起删**（附件与商品媒体；**库在 MySQL 里，不在其中**——要连库一起删就自己 `DROP DATABASE`），要先手输卷名确认（非交互场景加 `--yes` 跳过确认） |
| 只看计划、不动手 | `bash deploy.sh --dry-run`（把要装 Docker / 建镜像 / 建卷 / 起容器 / **HTTPS 在哪终止**的计划打印出来就退出）。注意：合约常量为空时它也会被启动门禁拒绝 |

## 2. 备份

**要备三样东西**：**数据库**（商品、订单、客户收货信息都在这儿）、**数据卷**（证据附件 + 商品媒体），以及 `<安装目录>/.env`（里面有令牌密钥与库口令，权限收紧、别外传）。

```bash
# 1) 导出数据库（--single-transaction = InnoDB 上不锁表的一致快照；连接参数见 .env 的 MK_DB_*）
mysqldump -h <MK_DB_HOST> -P <MK_DB_PORT> -u <MK_DB_USER> -p \
  --single-transaction --routines --triggers "$MK_DB_NAME" | gzip > node-db-$(date +%F).sql.gz

# 2) 导出数据卷（附件 + uploads/ 商品媒体）
cd /opt/marketplace-node
docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup \
  --entrypoint tar marketplace-node:latest czf /backup/node-data-$(date +%F).tar.gz -C /data .

# 3) 备份配置：丢了 .env 里的 MK_TOKEN_SECRET，所有登录用户的登录态会全部失效
cp -a /opt/marketplace-node/.env /var/backups/marketplace-node/env-$(date +%F)

# 4) 确认备份里真有东西（能恢复的才叫备份）
gzip -t node-db-$(date +%F).sql.gz && tar tzf node-data-$(date +%F).tar.gz | head
```

- 导出卷用的是**镜像里自带的 `tar`**（`--entrypoint tar`），宿主机上什么都不用装；`marketplace-node:latest` 这份镜像本来就在机器上，所以这条命令离线也能跑。
- 想要一份"完全一致"的快照，就先停一下节点再导：`docker stop marketplace-node` → 导出 → `docker start marketplace-node`（买家会看到几十秒不可达，挑低峰做）。
- ⚠️ **库不能靠"拷文件"备份**：直接拷 MySQL 的数据目录（`/var/lib/mysql`）会拿到撕裂状态，那不叫备份；`mysqldump` 才是一次一致的导出。
- ⚠️ **库与卷不是同一时刻的一套**（两条命令之间新增的附件不在库里）：要严格一致就先停容器再各导一次。
- 想每天自动跑：把下面的脚本存成一个文件（`OUT` 自己挑一个**不在安装目录里**的位置），`sudo crontab -e` 加一行；脚本里清理旧的、**库与卷各自留最近 7 份**：

```bash
#!/usr/bin/env bash
set -euo pipefail
VOL=marketplace-node-data; OUT=/var/backups/marketplace-node; STAMP=$(date +%F)
ENVF=/opt/marketplace-node/.env               # 库连接参数与节点用的是同一份
envof() { sed -n "s/^$1=//p" "$ENVF" | tail -1; }
H="$(envof MK_DB_HOST)"; H="${H:?未配置 MK_DB_HOST（节点是必须要一个 MySQL 8 的）}"
P="$(envof MK_DB_PORT)"; P="${P:-3306}"
U="$(envof MK_DB_USER)"; U="${U:?未配置 MK_DB_USER}"
N="$(envof MK_DB_NAME)"; N="${N:?未配置 MK_DB_NAME（本节点自己的库名）}"
mkdir -p "$OUT"
MYSQL_PWD="$(envof MK_DB_PASSWORD)" mysqldump -h "$H" -P "$P" -u "$U" \
  --single-transaction --routines --triggers "$N" | gzip > "$OUT/node-db-$STAMP.sql.gz"
docker run --rm -v "$VOL":/data -v "$OUT":/backup \
  --entrypoint tar marketplace-node:latest czf "/backup/node-data-$STAMP.tar.gz" -C /data .
ls -1t "$OUT"/node-db-*.sql.gz | tail -n +8 | xargs -r rm -f      # 各自留最近 7 份
ls -1t "$OUT"/node-data-*.tar.gz | tail -n +8 | xargs -r rm -f
```

- 另建议存一份到**另一台机器或离线介质**：同一台机器上的备份，磁盘坏了会一起没。
- 备份要**按期销毁**：个人信息擦除只动库与附件，动不了你已经导出的备份（§8）。

## 3. 恢复与恢复演练

**每季度演练一次，首次上线前务必做一次**——演练就是照下面真的走一遍，并把数据对完。

1. 备好一台干净机器（或同机的**另一套**安装：`--service` / `--volume` / `--port` / `--dir` 四个都换）。新机上先按 §0 备好**合约常量与 MySQL 8**（`MK_DB_*` 先写进 `.env`），装好 Docker（`bash deploy.sh` 会按发行版自己装），再跑一次 `bash deploy.sh`——它会建镜像与**一个空数据卷**。MySQL 没准备好时容器会在节点启动处退出（镜像与卷已经建好），准备好库后启动即可；库已就绪时会直接建空库建表，接着按第 3 步灌数据；
2. `docker stop <容器名>`（恢复期间别让节点再写数据）；
3. 把备份导回去（**库与卷是两条命令**）：

```bash
# ① 库：把 mysqldump 的备份灌回 MySQL
#    库不存在时先建，排序规则必须是 utf8mb4_0900_as_cs（不是默认的 ai_ci）：
#    CREATE DATABASE <MK_DB_NAME> CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
gunzip -c node-db-YYYY-MM-DD.sql.gz | mysql -h <MK_DB_HOST> -P <MK_DB_PORT> -u <MK_DB_USER> -p "$MK_DB_NAME"

# ② 附件与商品媒体：导入走容器里的 tar，文件属主按归档原样还原到容器里的 node 用户
cd /var/backups/marketplace-node
docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup \
  --entrypoint tar marketplace-node:latest xzf /backup/node-data-YYYY-MM-DD.tar.gz -C /data
```

4. `docker start <容器名>`，再 `bash deploy.sh --health`，并确认商品 / 订单 / 码池齐全。
5. `docker exec -u node marketplace-node npm run check:integrity` → **必须 exit 0**。它是只读、**整库（所有店铺）**的体检，比对**交付行 ↔ 码池 / NFT 池 + 商品/SKU 计数器 + 库存占位**，并**校验审计哈希链**。退出码：**0** = 一致（早于哈希链的未哈希行不算不一致）；**2** = 发现不一致；**1** = 自身出错（连不上库等）。
   它专抓两种**恢复特有**的痕迹：**① 已交付的码在池里回到 `unused`**（码池状态默认值就是 unused，恢复旧库会把"备份点之后发出的码"打回未用态 ⇒ **同一个码可能被再发给下一个买家**，而链上资金是真的）；**② 池里 `used` 却找不到交付行**（交付记录被回退，收据 / 举证链断裂）。
   发现不一致时**不要**用脚本自动改：先定口径（以链上已交付为准，还是以池内状态为准）再人工处理；已发出、又无法与买家核对的码，宁可在码池里手工标记为不可用，也别让它重新进可交付池。

> **对账是节点级多店口径**：`npm run reconcile` 链上按 `commissionTermsAtCreate.payee == MK_SHOP_OWNER` 认本节点，本地按 `shop_code` 分店；exit 0 覆盖本节点全部店铺，但前提是扫描区间覆盖全史（默认 `MK_ESCROW_START_BLOCK`）。区间不足时历史单会进入“覆盖不足/没核对成”，不要把它当账错，也不要拿不完整区间的 0 当验收。

**必须分清两种「丢失」**：**状态回写**能补——恢复点之后的链上事件，轮询器会接着扫并回写**本地已有的行**；**订单行本身补不回来**——新建订单的写入只发生在"创建草稿"这一步，轮询器只会更新已存在的行，所以恢复点之后新建的订单**在本地永久不存在**（你看不到、也不会发货），只能按链上托管单号人工核对。

> **结论（请记住）**：本项目里**「恢复旧备份」不是受支持的运维动作**。链下数据可以放弃时，干净做法是**重建库 + 让节点重新扫链**（重建前先按 §2 导出一份留档、别直接删库；扫链起点 `MK_ESCROW_START_BLOCK` 来自 `deploy-constants.json` 的 `startBlock`，标准部署就是 Escrow 部署块），再用 `check:integrity` 与节点级多店对账复核：

```bash
# 重建库：先留档（§2 的 mysqldump），再让 MySQL 删库
mysqldump -h <MK_DB_HOST> -u <MK_DB_USER> -p --single-transaction "$MK_DB_NAME" > old-db-$(date +%F).sql
docker stop marketplace-node
mysql -h <MK_DB_HOST> -u <MK_DB_USER> -p -e 'DROP DATABASE `'"$MK_DB_NAME"'`;'
docker start marketplace-node     # 起一个新空库（节点自动建库建表），从 MK_ESCROW_START_BLOCK 重新扫链
```

只有在"链下数据比链上状态更权威"的极少数场景（例如码池原始导入文件已丢失）才谈恢复，且必须先跑一次 `check:integrity` 看清代价。

## 4. 升级到最新版 / 回滚

代码来自本仓库 `https://github.com/delnull/marketplace-node`。**升级 = 重新构建镜像 → 用同一个数据卷与同一个库重建容器**，配置、令牌密钥、数据全部保留。

```bash
cd /opt/marketplace-node
git pull --ff-only              # 在安装目录里 git clone 装的：让代码变成新版
bash deploy.sh --update         # 重新构建镜像 → 用同一个数据卷与配置重建容器
# 安装目录里没有 git（当初用 ZIP 或 bash <(curl …) 装的）：跳过 git pull，改用
#   bash deploy.sh --update --pull    ← 强制从公开仓拉最新代码（需要能访问 GitHub）
```

- **`--update` 的代码来源**：安装目录是 git clone 时，它会先 `git pull --ff-only`（失败只告警，继续用现有代码重建）；其它安装方式不会自动拉代码，要拉公开仓最新版就加 `--pull`（脚本会在第 ② 步拉取）。想记下升级前的代码版本：`cd /opt/marketplace-node && git rev-parse --short HEAD`。
- **回滚点脚本会自己留**：升级时它把当前镜像打成 `<服务名>-rollback:latest`（并打印出来），新容器探活失败会自动用那个镜像重建。
- `.env` 里**脚本管理的键**（端口、节点主地址、域名、CORS 白名单，以及合约地址、超时、保留期、对账间隔等约二十多项）会按本次参数、状态文件与 `deploy-constants.json` 重写一遍；**你自己加的那些键**（风控闸 `MK_ORDER_GATE_URL`、兜底汇率 `MK_FALLBACK_BTY_USDT`、`MK_TRUST_PROXY`、`MK_OWNER_LOGIN_ALERT` 等）会原样保留，脚本还会把它们列出来告诉你保留了哪些。
- **要长期改托管运行参数**（例如 `MK_PII_RETENTION_DAYS`、`MK_ESCROW_TIMEOUT_BLOCKS`、`MK_RPC_URL`），改 `node/deploy-constants.json` 的 `appDefaults` / `network` 再 `--update`；只改 `.env` 会在下一次 `--update` 被改回去。`MK_DB_*` 与 `MK_TRUST_PROXY` 不归脚本管，重跑保留。
- **升级前先按 §2 备份**（代码能退回去，数据不会跟着退回去）；升级后必做两件事：`bash deploy.sh --health`（对照 §1 四块）与 `docker exec -u node marketplace-node npm run check:integrity`（必须 exit 0）。`npm run reconcile` 是节点级多店口径（见 §1）；升级后在全史扫描区间跑一次，exit 0 才表示本节点全部店铺一致。
- **升级前先看计划**：`bash deploy.sh --update --dry-run` 什么都不改；非交互场景（脚本里 / `ssh` 不带 `-t`）加 `--yes`，例如 `bash deploy.sh --update --yes`。

**回滚**：`deploy.sh` 没有回滚子命令；`deploy-node.ps1 -Rollback` 会用 `<服务名>-rollback:latest` 重建容器。手动回滚就是把容器换回升级前那个镜像标签，**数据卷不动**——这就是 `deploy.sh` 起容器时用的那一串参数（**没有 systemd 路径**）：

```bash
docker images 'marketplace-node*'        # 找到 <服务名>-rollback:latest（升级时脚本自动打的）
docker rm -f marketplace-node
docker run -d --name marketplace-node --restart unless-stopped \
  --stop-timeout 30 \
  --network marketplace-node-net --network-alias marketplace-node \
  -p 127.0.0.1:8090:8090 --env-file /opt/marketplace-node/.env \
  -v marketplace-node-data:/data marketplace-node-rollback:latest
```

> 上面那串里的**名字、端口、卷名、路径、绑定地址要按你这套安装的来**（`bash deploy.sh --status` 会打印，`<安装目录>/.deploy-state` 里也记着）。`--network` / `--network-alias` 别漏：Caddy 容器就是靠服务名在 `<服务名>-net` 这张网络里找到节点的。选过 `--tls-mode none` 的安装，发布地址是 `0.0.0.0` 而不是 `127.0.0.1`；`--stop-timeout` 要**大于** `MK_SHUTDOWN_DRAIN_MS`（默认 10 秒，标准安装 30 秒）。

回滚后若数据与旧代码对不上（界面报错、`check:integrity` 不过），按 §3 处理：数据可以放弃就重建库 + 重扫链，**不要**拿旧备份去覆盖新数据——那会把升级后新增的订单与售后记录一起抹掉。

## 5. 换服务器（迁移）

1. **备份**：在旧机上按 §2 做三件事——导出**数据库**（`mysqldump`）、导出**数据卷**（附件与商品媒体），**并把 `<安装目录>/.env` 一起带走**（里面有 `MK_TOKEN_SECRET` 与 `MK_DB_*`；不带走 token secret 的话新机上所有人的登录态都失效）。
2. **新机上先把架子搭好**：按 §0 备好**同一批合约常量**与 MySQL 8，装好 Docker（`bash deploy.sh` 会自己装），按新机的路径放好代码，先跑一次 `bash deploy.sh --owner <节点主地址> --domain <域名>`（**证书在哪终止按新机的实际情况选**：本机申请就加 `--tls-mode caddy`，由外部入口终止就加 `--tls-mode none`，本机已有 nginx 则 `--tls-mode none --bind 127.0.0.1`），把镜像、空数据卷、入口都建好。MySQL 还没配好时容器会在节点启动处退出（镜像与卷已经建好）；库已配好但还没有数据时它会先建空库建表，随后第 3 步导入覆盖。
3. **搬数据**：`docker stop <容器名>` → 按 §3 第 3 步把**库与卷**都导进新机（建库用 `utf8mb4_0900_as_cs`）→ 用旧机那份 `.env` 覆盖新机的 `<安装目录>/.env`（`MK_DB_*` 按新机改）→ `bash deploy.sh --update`（它会重建并启动容器，这样新那份 `.env` 才会被读进去）。
4. **改配置**：`deploy-constants.json` 的合约五项必须与旧机**同一批**（`--update` 会按它重写 `.env`；换批会让本地在途单与链上失联）。事件游标存在库里，恢复库后会从停摆处接着扫。链上登记的 endpoint 由域名决定（`MK_SIWE_DOMAIN` + 向导/`--register` 写入链上），不在 `.env` 里单独存一份。
5. **对外入口**：先在新机本机确认 `curl -s http://127.0.0.1:<端口>/healthz` 正常，再把域名解析指到新机；确认 `curl -s https://你的域名/healthz` 正常（反代与证书在第 2 步已经配好；域名变了就 `bash deploy.sh --update --tls-mode caddy --domain 新域名` 或你实际用的 TLS 方式）。
6. **重新登记（只在域名变了时）**：用**同一个节点主钱包**更新 endpoint **不需要先注销**，旧 endpoint 会被链上释放。先 `bash deploy.sh --update --domain 新域名 --yes` 把域名写进 `.env`（Caddy 安装要同时带 `--tls-mode caddy`），再 `bash deploy.sh --register --key-file <私钥文件>`。注意 `--register` **忽略**命令行再给的 `--owner` / `--domain`（它从现有 `.env` 读 `MK_SHOP_OWNER` / `MK_SIWE_DOMAIN`），所以换域名的那一步必须先做。域名原样保留的话，这一步不用做。
7. **验证**：`bash deploy.sh --health` → 商品 / 订单完整 → `docker exec -u node marketplace-node npm run check:integrity` exit 0 → 用真钱包下一笔小额单，走完「下单 → 支付 → 发货」；**旧机器先别清理**，数据至少留 7 天，期间随时可以把域名指回去。

## 6. 密钥与身份变更

### 6.1 登录令牌密钥（`MK_TOKEN_SECRET`）

| 情形 | 怎么做 |
|---|---|
| 常规轮换 | `openssl rand -base64 32` 生成新值 → 改 `<安装目录>/.env` → **重建容器**：`cd <安装目录> && bash deploy.sh --update`。旧令牌全部失效，**所有登录用户要重新登录**（建议低峰做，可先通知活跃店员）。**`docker restart` 不行**——它读的还是旧配置，改了等于没改 |
| 疑似泄露 | ① **立即轮换**（同上）；② 用 `/api/shop/audit`（本店，`ownerOnly`）与 `/api/shop/audit/node`（节点级，`hostOnly`）查泄露窗口内有没有异常的店员/节点级动作；③ 若怀疑资金侧：**链上托管资金不受这个密钥影响**（链上动作仍需钱包私钥），重灾区是**码池原文与发货**——逐个核对该窗口内发货单的收货地址是否可疑 |

不需要双密钥过渡期（登录令牌最长 24 小时）。可选加固：自己在 `.env` 里加一行 `MK_OWNER_LOGIN_ALERT=1`（这类脚本不管的键在 `--update` 时原样保留），**节点主**每次登录都推一条通知（含地址与来源 IP），用来发现有人冒领节点主令牌。

### 6.2 换节点主钱包（链上 `transferNode`，不是换店主）

- **节点主身份 = `.env` 的 `MK_SHOP_OWNER`（`node.owner`）**；**链上登记的 operator 就是 `registerNode` 时用的那个钱包**，链上更新登记 / 注销只能由它发起。它**不是**店铺店主；店铺店主是 `shops.seller`，两者可以不同。
- **换节点主不能只改 `.env`**：要走链上 Registry 的 `transferNode`——登记从旧 operator 直接换到新 operator，**没有抢注窗口**，也不用"先注销再注册"。转让要**双方各签一次**（旧节点主 `fromSig` + 新节点主 `toSig`，各自的 EIP-191 personal 签名；待签摘要 = `keccak256(abi.encode(from, to, endpoint, escrowAddress, deadline, chainId, registry))`，chainId = 2999，签名时再加 personal 前缀）。**票据带 `deadline`（`transferNode` 的第 5 个参数）**：它进签名消息体、由双方签字那一刻定死，过期即 `TransferExpired`。**别签成永久**——一份泄露的票据能在任意未来时刻被广播；给几天就够，过期重新签一份即可。界面在前端**链上权限台 `/authority` → 节点转让**（原节点主出票、接收方签收广播；节点主在卖家设置里的生命周期入口指向同一实现）。
- **`transferNode` 转让的是节点登记，不是店铺**：店铺身份是 `(seller, host)`，`host` 就是节点主地址。转让后旧 host 名下的店**仍归原店主**，但会**退出目录、不能下单**（`shopListed` 为假）；新节点主名下**没有这些店**。原节点主重新登记后那些店会自动恢复在售；原店主也可以在新节点下重新走 §0.5 的双签开店（旧店不自动迁移）。**订单货款仍归 `shops.seller`**，与节点主换人无关。
- **操作顺序**：先在链上完成 `transferNode`（双方签名）→ 再把新机/新安装的 `.env` 设成 `MK_SHOP_OWNER=新地址` → `bash deploy.sh --update`。**不要先改 `.env` 再转**：节点自报的 `owner` 会与链上 operator 不一致，买家下单弹窗的交叉比对会直接拒绝支付，节点级鉴权也会对不上。
- 旧节点主**无法操作**（失能、身故）时：转让必须 `fromSig`，**拿不到旧私钥就转不了**——这是双签设计的必然代价。此时新节点主只能用新地址**另登记一个新节点**（不同 endpoint）；旧节点登记会一直留在目录里，直到有人用旧钥匙注销。旧节点上各店铺的店主仍归各自 `shops.seller`，不能由节点主"搬走"；他们可以在新节点下重新开店。

### 6.3 私钥丢失 / 关店

**先分清两把钥匙**：**节点主钥匙**（`MK_SHOP_OWNER` / 链上 operator）与**店铺店主钥匙**（`shops.seller`）。两者不是一回事，处理方式也不同。

| 情形 | 怎么办 |
|---|---|
| **节点主**私钥丢失 | 节点本身可以继续服务已登记的店铺（店主仍能登录经营），但**节点主自己的动作做不了**：无法更新/注销节点登记、无法用 `transferNode` 转让、无法增删节点员工。**已任命的节点员工仍能审批新店**（那是链上员工权限，不依赖节点主钥匙）；没有员工时新店审批停摆。链上登记不会过期，会一直挂在目录里。处置：① 让现有店铺继续经营，或让各店主到**新节点**（新地址 `registerNode`）重新开店；② 新地址只能登记**新节点**，不能接管旧节点；③ 旧节点若只是 `docker stop`，链上登记仍在、店铺仍算在售但买家访问不到；只有注销 / 被治理停用 / 转让后，旧 host 名下的店才会 `shopListed=false` 退出目录（在途订单仍按链上履约） |
| **店铺店主**私钥丢失 | 店铺身份是 `(seller, host)`，**节点主无法把 `seller` 改成别人**；没有"店铺转让"入口。店主可先加的店员（`shop_operators`）仍能上架/发货，但**资金与设置（退款、流水、导出、审计）只有店主能操作**。未发货单请买家申请退款；店主无法同意/拒绝时，买家可在超时后发起争议，由委员会判退。**货款若结算给该地址，就是打进你已丢失私钥的地址**。处置：节点主可 `suspendShop` 让这家店退出目录（不能替店主 `deregisterShop`）；要永久封死编号走 Blocklist 的 Shop 类（治理，可撤销）。新钱包只能在节点下**重新申请一家新店**（新编号），不能接管旧店 |
| 关掉一家店（主动停业） | 由**店主本人**在卖家面板「店铺生命周期 → 关店」发 `deregisterShop`（单方权利，节点主/员工不能替他退）。店从目录消失、不能下单，在途订单照常履约；数据与订单仍在库/卷里，重新走 §0.5 的双签可复业（**编号沿用**）。关店前先跑一次保留期（§8） |
| 注销节点登记 | 由**节点主**发 `deregisterNode`。节点从目录消失，其下店铺 `shopListed` 随之为假（不能下单），在途订单照常履约；**店一家都不删**。同一 operator 重新 `registerNode`（编号不变）后，这些店自动恢复在售 |
| 停节点（不是注销） | `docker stop marketplace-node`。链上登记与店铺都还在，只是买家访问不到；恢复用 `docker start marketplace-node`。**停节点不等于关店，也不退任何在途资金** |

## 7. 上线后要自己拍板的链上参数（默认全是"关"）

> 这些参数**部署脚本不会替你设**（它们由链上各合约的治理 owner 调，不是 `.env`），而默认值都是**关**。
> 也就是说：**刚部署完的节点，节点主与店主都可以一分质押不交，出金也没有留存线** ——
> "质押是赔付后备"这句话在你设之前**还不成立**。摆出来是为了让你知道自己在选什么。

| 参数（getter） | 默认 | 它关着意味着 | 建议值 |
|---|---|---|---|
| `Registry.minStakeToRegister` | `0` | 没有额外门槛：除治理/仲裁/节点员工/店主等互斥身份外，任何地址都能登记节点，不押一分钱 | **0，但先想清**：它是所有节点都要过的门槛，包含别人。你要开放给陌生人 ⇒ 设一个"违约成本大于扯皮收益"的数（按 BTY 计价，小额即可）；只自用/熟人 ⇒ 留 0 |
| `Registry.minStakeToOpenShop` | `0` | 没有额外门槛：任何合格店主地址都能在这台节点下开店，不押一分钱（**与上一条是两把独立的闸**） | 想用"押金"给买家兜底就设一个与单笔成交额同量级的数；这是 `Staking.penalize` 能赔到钱的前提 |
| `Staking.minRetainedStake` | `0` | **没有额外的强制留存**：店主在冷却期（默认 7 天）满、且没有在途退款/争议敞口时，经 owner 批准（或自动放行窗口过）可以把质押全部提走；那之后的赔付后备是 0（出金下限 = `max(在途退款/争议敞口, minRetainedStake)`） | **≈ 本店单笔最大成交额**。理由：在途敞口只覆盖"已经开了退款/争议的单"，而"店主提空之后又冒出一笔要赔的单"正是它要兜的 |
| `Staking.unstakeApprovalTimeout` | `0` | 「管理员钥匙丢了」=「所有店主的质押再也提不走」（见 §10 末条） | **7 天**（`604800`，上限 365 天）。钥匙是单签名热钱包就设；多签/冷钥匙且有人看着可以留 0 |

```bash
# 查现值（getter 都是 public，直接读）
cast call <REGISTRY> "minStakeToRegister()(uint256)" --rpc-url $MK_RPC_URL
cast call <REGISTRY> "minStakeToOpenShop()(uint256)" --rpc-url $MK_RPC_URL
cast call <STAKING>  "minRetainedStake()(uint256)"   --rpc-url $MK_RPC_URL
cast call <STAKING>  "unstakeApprovalTimeout()(uint256)" --rpc-url $MK_RPC_URL

# 设（治理 owner 私钥；把 <wei> 换成本币最小单位）
cast send <REGISTRY> "setMinStakeToRegister(uint256)" <wei>      --private-key <KEY> --rpc-url $MK_RPC_URL
cast send <REGISTRY> "setMinStakeToOpenShop(uint256)" <wei>      --private-key <KEY> --rpc-url $MK_RPC_URL
cast send <STAKING>  "setMinRetainedStake(uint256)"   <wei>      --private-key <KEY> --rpc-url $MK_RPC_URL
cast send <STAKING>  "setUnstakeApprovalTimeout(uint256)" 604800 --private-key <KEY> --rpc-url $MK_RPC_URL
```

`Staking.penaltyWindowSeconds`（默认 **30 天**）与 `penaltyWindowCapBps`（默认 **5000 = 50%**）不用改也能用；
要改的理由只有"考核期更长/更短"，用 `setPenaltyWindow(windowSeconds, capBps)`，口径见 `contracts/src/Staking.sol` 里各 setter 的注释。

## 8. 数据保留与清理

> **个人信息不要手工跑 SQL 删。** 正规通道只有下面三条，它们会同时清掉「收货信息 + 买家备注 + 开票抬头 / 税号 + 售后陈述正文 + 证据附件（库里行 + 磁盘文件）」，并在审计里留痕；手工 `UPDATE` 只清列、不清附件文件、也不入审计——那是"以为删干净了，其实没删"。顺带一提：`docker exec` 默认以 root 进容器，手工改库还容易在卷里留下 root 属主的文件，让节点之后**写不动**（§9）。

| 通道 | 怎么用 |
|---|---|
| 买家点名单请求 | `POST /api/shop/orders/:orderNo/erase-pii`（仅**终局**单；在途单会被拒——你还要按地址发货）。**ownerOnly**：只能由该单所属店铺的店主调用 |
| 到期自动擦除 | `MK_PII_RETENTION_DAYS`（默认 180 天，**0 = 关闭**）：每 6 小时扫一轮，擦除终局且静置超期的订单。**节点级配置**，店铺不能单独设。它由 `deploy-constants.json` 的 `appDefaults` 决定；只改 `.env` 会在下次 `--update` 被改回 180 |
| 手动立刻跑一轮 | `curl -X POST https://你的域名/api/shop/retention/run -H "Authorization: Bearer <节点主令牌>" -H 'Content-Type: application/json' -d '{"days":180}'`；`{"days":N}` 可临时收紧。**这条是 hostOnly（仅节点主）**：它擦的是全节点到期的单，不是某一家店——所以店主令牌调不动它 |

`erase-pii` 与 `retention/run` 两个接口都**幂等**，都写审计（`order.erase_pii` / `retention.run`，只记条数不记内容）；`MK_PII_RETENTION_DAYS=0` 时周期扫描**不启动任何定时器**（关闭就是真关闭），`retention/run` 不传 `days` 时按 0 返回"已关闭"、不擦；显式 `{"days":N>0}` 仍可跑一轮，`erase-pii` 不受影响。

> **一条必须知道的非对称**：保留期扫描会**跳过** `after_sale_status='open'` 的终局单（售后未结时不销毁证据）；但**按单 `erase-pii` 没有这道让路**——它只判终局，所以对一笔开着售后的终局单调用仍会擦掉收货信息、陈述正文与证据附件。**售后未结时不要点它。**

**擦除不可逆，也不等于这一单从系统里消失**——金额、状态、链上托管单号、支付凭证、事件史、物流单号、退货单地址与备注、已交付的码与 tokenId、评价正文都是**刻意保留**的，请如实告知买家。**擦除够不到的地方也要如实说**：MySQL 的**二进制日志**里可能还留着这一行最初写入的原文（节点把自己的连接设成 `binlog_row_image=MINIMAL`，所以擦除语句本身不再写原文），以及你在 §2 **导出的备份**——前者要在 MySQL 侧设 `binlog_expire_logs_seconds`（到期自动清理）并给磁盘加密，后者按保留期销毁。对买家只能承诺"节点库与附件里的已删除"，不能承诺"磁盘上再也找不到"。**关店 / 搬家前先跑一次保留期**（用上表第三个通道，或等周期扫描），把已过期的终局单个人信息先清掉——归档包里的个人信息越少越好。

| 数据 | 说明 | 怎么清理 |
|---|---|---|
| `attachments/`（证据附件） | 卷内 `/data/attachments`；单文件 ≤2MB、单条 ≤6 个、单订单 ≤20MB | 随上面的擦除一并删除（库里行 + 磁盘文件）。磁盘删除在事务提交后执行，失败会打 `[pii] … 证据附件删除失败` 并留待下次补齐——**看到这行请手工清一下那个目录**（进容器记得带 `-u node`）；平时也留意数据卷占用的磁盘空间：`docker system df -v`，或 `docker run --rm -v marketplace-node-data:/data --entrypoint du marketplace-node:latest -sh /data` |
| 审计日志 | **没有**自动保留策略 | 按需归档后删除（先查一下行数确认）。⚠️ 删之前先导出：它是"谁在什么时候删过谁的数据"的唯一凭据 |
| 登录 nonce | 自动过期 | 节点每 10 分钟自动清理，**不用你管** |
| 退货单 / 评价 / 争议陈述 | 交易上下文 | 建议随订单长期保留（仲裁与对账要追溯）。擦除会把争议陈述正文置为墓碑串但**保留行**；退货单地址/备注与评价正文**不在擦除范围内**。**证据附件是例外**：随擦除删除 |
| **测试留下的临时库**（只有你自己跑过测试才会有） | 测试是**一进程一个库**（`mk_test_<进程号>_<随机>`），跑完自己删；进程被强杀（关窗口、CI 取消、断电）时删不掉，于是留在 MySQL 里，每个约 1MB | 先看有多少：`mysql -h <MK_DB_HOST> -u <MK_DB_USER> -p -N -e "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'mk\\_test\\_%'"`。确认里面没有你要留的东西之后逐库 `DROP DATABASE`。**不要按 `mk_%` 前缀批量删**：演示栈的库叫 `mk_demo_a~e`，那是你的演示数据 |

## 9. 故障速查（症状 → 怎么办）

| 症状 | 原因 | 怎么办 |
|---|---|---|
| 容器反复重启 / `docker ps -a` 里是 `Exited` 或 `Restarting` | 节点进程起来就退出：连不上 MySQL（`MK_DB_*` 写错 / 库那台机器不可达 / 账号被拒 / 排序规则不对 / 缺临时库授权）、配置被改坏、卷权限不对、端口被占。`--restart unless-stopped` 会自动重拉，但**配置错会变成无限重启循环** | `docker logs --tail 100 marketplace-node` 看真实原因；自己 `docker stop` 过的，`docker start marketplace-node` 即可。节点**本身**的判据仍然是 §1 那四块，别只看容器在不在 |
| 容器起不来，日志报 `EACCES` / `permission denied` | 数据卷里有 root 属主的文件——多半是有人用 `docker exec`（**不带 `-u node`**）进去写过东西。节点以 uid 1000 跑，写不动这些文件 | 修属主：`docker run --rm -v marketplace-node-data:/data --entrypoint chown marketplace-node:latest -R node:node /data`；以后进容器一律 `docker exec -it -u node marketplace-node sh`。**不要**图省事给容器加 `--privileged` 或用 root 跑节点 |
| 容器起不来，日志说 `MK_TOKEN_SECRET` 不合格 | 密钥缺失 / <32 字符 / 重复或纯数字 / 仍是模板示例值 | 删掉 `.env` 里那一行后 `bash deploy.sh --update`（会重新生成并重建容器）。**没有旁路开关**——弱密钥能让任何人伪造登录令牌。代价是所有登录态失效 |
| 容器起不来，日志说 `chainId` 不符 | `MK_RPC_URL` 指到了别的链 | 改回 `https://mainnet.bityuan.com/eth`（并确认 `MK_CHAIN_ID=2999`）后 `bash deploy.sh --update`；若是 `deploy-constants.json` 的 `network` 被改错，先改回去 |
| 端口被占用 / 想换端口 | 同机已有服务占了 8090（另外 8080 也很常被别的东西占着，**脚本静态拒绝 8080**） | 换一个：`bash deploy.sh --update --port 8091`（会重建容器并更新反代配置）。**旧版宿主安装**（2026-10-13 前装过 systemd 的机器）可能还留着单元：`systemctl status marketplace-node` 看它还在不在跑；清理：`sudo systemctl disable --now marketplace-node && sudo rm -f /etc/systemd/system/marketplace-node.service && sudo systemctl daemon-reload`。**这只是清理残留，不是回滚路径**——现在没有 systemd 回滚 |
| 改完 `.env` 没生效 | `.env` 是在 `docker run` 那一刻读进容器配置的，`docker restart` 不会重读 | `bash deploy.sh --update`（重建容器）。Caddyfile 不一样，它是挂载进去的文件，改完 `docker restart marketplace-node-caddy` 就生效（Caddy 容器存在时） |
| 手改过 Caddyfile（换证书邮箱 / 加 header / 日志），怕被下次部署覆盖 | 每次部署（含 `--update`）都会**整份重新生成** Caddyfile | 脚本会先把上一份备份成 `Caddyfile.bak.<时间戳>`，并且只在**内容确实变了**时打印"被重新生成过"（只差时间戳那行时不打扰你、也不留垃圾备份）。把改动合并回去 → `docker restart marketplace-node-caddy`；整份回退：`cp -a <安装目录>/Caddyfile.bak.<ts> <安装目录>/Caddyfile && docker restart marketplace-node-caddy` |
| 退出码怎么判（喂监控/cron） | 脚本只用三个码：**0** 成功；**1** 脚本自己的失败（原因都在输出里，且一律给出下一步命令）；**2** 用法错（未知参数）、`--health` 判为不健康、或 `--status` 拿不到探活结果 | docker 的原生码（例如端口被占的 125）**不会漏出**：脚本会连同 docker 原始报错一起回显，然后以 1 结束，并清掉这次没起来的空壳容器（否则下次重跑撞"容器已存在"，把真原因盖掉） |
| 磁盘满了 | 卷里的附件 / 商品媒体 / 日志（`docker logs` 也占磁盘） | `docker system df -v` 看是谁占的；清理无用的旧镜像：`docker image prune -f`。⚠️ **千万别 `docker volume prune`**——它删的正是"当前没有容器在用"的卷，你的店就在里面 |
| 订单已结清，但收款方说"钱没到账" | 收款地址是**拒收原生转账的合约**（多签/金库常见）时，结算不会回滚，钱改为**记在它名下等它自己领**（`withdrawPayout()` / `withdrawFees()`，只能领自己那一名下那笔，别人代领不了） | 先确认订单链上已终局（仲裁判付 / 确认收货 / 超时释放都算），再让**该地址本人**发领取交易；**挂账只能本人领走，改收费方不会迁移旧挂账**——所以换收费地址之前先给新地址发 1 wei 自测能否收到，收不到的地址不要配成收取方 |
| 公开接口被刷 / 想限流 | 节点内只对少数最容易被刷的端点做了按 IP 的内存限流（清单见各路由的 limiter；单进程、重启清零），其余端点**没有**限流 | 优先在**你自己的反向代理层**限流（nginx `limit_req` 对 `/api/` 生效即可）。⚠️ 节点在反代之后时，限流与审计取到的 IP 全是代理 IP——要真实 IP 就设 `MK_TRUST_PROXY`（本机 Caddy 按 `<服务名>-net` 的 Subnet 填 CIDR；宿主 nginx 填 `loopback`），改完 `--update` 重建容器。**只在你完全控制反代、且反代覆写 `X-Forwarded-For` 时开启**，否则限流可被伪造头绕过 |
| 脚本第 ⑧ 步证书申请失败 | **只在你选了本机申请证书（`--tls-mode caddy`/`nginx`）时才会遇到**：域名没解析到本机 / 80 端口没放行 / 用了 CDN 代理 | **Caddy 的报错在 `docker logs marketplace-node-caddy` 里**（证书数据在 `<服务名>-caddy-data` 卷里，重建 Caddy 容器不会重新申请）；修好后重跑 `bash deploy.sh --update --tls-mode caddy --domain 你的域名`。用宿主 nginx 模式的话，也可手动 `sudo certbot --nginx -d 你的域名`；不想在本机申请证书就改走 `--tls-mode none`，证书交给你的入口 |
| 脚本**拒绝** `--tls-mode nginx`（说本机已有 nginx 站点） | 这是刻意的：再写一个 `listen 80` 的 server 块会与同机站点争 `server_name`，而 `systemctl reload nginx` 会把它们一起卷进来（certbot `--redirect` 还会去改已有的 443 server 块） | 改走「本机已有入口」那条：`bash deploy.sh --update --tls-mode none --bind 127.0.0.1 --yes`，再在**你那份 nginx** 的 server 块里加 `location / { proxy_pass http://127.0.0.1:8090; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }` |
| 我只给了 `--domain`，脚本却说"本机不申请证书" | 这是**默认口径**：域名的含义是"节点的对外身份"（SIWE 原文 + CORS + 登记 endpoint），证书在哪申请由 **TLS 在哪终止**决定 | 想让本机全包：`bash deploy.sh --update --tls-mode caddy --domain 你的域名`（干净 Linux 机器也可 `--tls-mode nginx`）；想用既有入口：`--tls-mode none`（本机已有 nginx 时加 `--bind 127.0.0.1`） |
| 买家说"已支付但订单还是待支付" | 轮询器刻意等确认深度（默认 12 块 ≈ 1 分钟），状态回写天生滞后 | 先等 1 分钟；仍不动让买家点订单页「同步链上状态」（不受确认深度限制，直读链上真值）；再核 `.env` 合约地址与买家实际支付地址是否一致、RPC 是否可达 |
| 界面一直不更新 / 收款流水缺单 | 轮询器停摆或事件被隔离 | 看 §1 的 `watcher` 块：`lastOkAt` 不推进 = 停摆；`quarantined > 0` = 有事件被跳过；`lagBlocks` 持续增长 = 跟不上。注意 watcher 停摆/隔离时 `/healthz` 已经是 503，容器也会 `unhealthy` |
| `/healthz` 的 `quarantined > 0` | 同一事件连续失败 3 次后被移入隔离清单（库里 `node.quarantined_events`，键 = `block:index:name:orderId前10位`；跳过它并继续推进游标，避免一个坏事件把扫描窗口永久钉死） | ① 读隔离清单定位事件；② 按订单号用 `POST /api/orders/:orderNo/sync` 从链上**单独补回**（隔离期间的正规补救路径）；③ **清掉隔离条目本身不会让已越过的事件重放**（游标已在它之后），要重放只能 `/sync` 或把扫描起点调早重扫；④ 同一单反复被隔离 = 本地行与链上真值不符，按下一行查 |
| 订单停在"待发货"很久，链上却早已结清 / 退回 | 事件被漏扫（RPC 抖动、停机跨过扫描窗口、起始块配错、事件进隔离） | 看日志有没有 `[chainReconcile] 修复滞留订单`（后台对账默认 10 分钟一轮，只处理**静置超过 6 小时**的非终态单）；等不及就直接 `POST /api/orders/:orderNo/sync`（不受 6 小时限制） |
| 日志出现「本地为 … 链上却查不到该托管单」 | 多半是合约地址 / 链 ID 配错（也可能是 RPC 读到了错误的链） | **必须人工核** `.env` 的 `MK_ESCROW_ADDRESS` / `MK_CHAIN_ID` 与买家实际支付是否一致，再决定改配置（改 `deploy-constants.json`）还是走 `/sync` |
| `npm run reconcile` 报差异（exit 2） | 本地入账但链上未终局/查无此单；链上 host 是别的节点（含非入账态）；seller 错位；链上已全额退款但本地记收入或本地完全没有；本节点链上已结算但本地完全没有该单；本地状态未跟上；两侧净额差额 ≠ 0。host/getOrder 读不到是 exit 3（没核对成），不是差异 | 先看输出的小标题：`foreignHost` / `sellerMismatch` / `refundedButLocalIncome` / `refundedOnly` / `extra` / `openOnly` / `stale` / `missing` 各有独立处置。漏扫用 `--start-block <Escrow部署块>` 覆盖全史重跑，或改 `deploy-constants.json` 的 `startBlock` 后全量重建；事件应用失败看轮询日志后手动 `/sync`。逐单人工核 |
| 收到 `order.pool_empty` 告警 | 已收款但池内资源不足（码池 / NFT 池在建草稿与托管落定之间被别单买空） | **立即补货**（导入兑换码 / tokenId）或与买家协商退款。每单只告警一次，别等下一封。收到 `order.hold_missing` 是另一回事：订单从取消恢复但限量库存已被买走，需核对余量后扩容或退款 |
| 发货被拒 | 「缺链上支付凭证」= 该单是无凭证的异常行，先「同步补齐」，仍为空就取消清理（链上托管若真的落定，轮询器会自动恢复真单）；「退款申请待处理」= 买家退款冻结期，先在链上拒绝或同意退款。**部分退款不是任意金额**：只能退买家在链上**精确授权过**的那个数（`acceptPartialRefund`），否则链上 `RefundAmountNotAccepted`；全额退款无需授权 | 按左边对应处理 |
| 操作员操作被拒（403） | **店铺店员**（`shop_operators`，链下）只能用经营面；财务面（流水 / 看板 / 导出 / 审计）是店主专属。**节点员工**（链上 `Registry.setNodeStaff`）是另一套权限（审批开店/节点资料等），不是在卖家面板的店员名单里加的 | 店员：在卖家面板「店铺设置 → 店员白名单」确认该地址已加入（增删即改即生效，不用重启）。节点员工：由节点主钱包在链上增删，节点侧缓存用 `/api/shop/node-staff/refresh` 刷新 |
| 商品页 / 订单页报「商品内容已被修改」但没人改过 | 商品的快照哈希与按当前算法复算的结果不一致，常见于手工改过库里的行 | 把该商品**重新保存一次**（会重算并写回哈希；批量改价同样重算）即消除；重存后仍不一致才是真被改过 |
| 买家要求删除个人信息 | — | 走 `POST /api/shop/orders/:orderNo/erase-pii`（仅终局单、`ownerOnly`，在途单会被拒）；到期自动擦除见 §8。**不要手工跑 SQL**；售后未结时先别擦（§8） |
| 下单被拒「未成年人禁止购买商品」 | 该商品打开了未成年人限制，下单必须由买家勾选确认（`ageAck=true`） | 要放开就编辑商品把该开关关掉（会重算快照哈希，在途订单不受影响）。**哪些商品属于限制商品由你自己界定**——软件只提供机制 |
| 日志出现「忽略与链上真值不符的事件」 | 有人对同一个订单号造了诱饵单（未付款草稿的单号是公开的），该事件被**刻意拒绝落地** | 核对本地单与买家真实支付交易；买家的真实支付若因此被挡，只能作废重下 |
| 汇率频繁 stale / RPC 报错 | 官方行情不可达（标价单位已是 USDT，行情只有官方 BTY-USDT 这一条腿）；或节点只配了一个 RPC（单点） | 检查出网并加 `MK_FALLBACK_BTY_USDT` 兜底（这个键不归脚本管，`--update` 会原样保留）。**`MK_RPC_URL` 是脚本托管键**：只改 `.env` 会在下次 `--update` 被 `deploy-constants.json` 的 `network.rpcUrl` 重写；要长期换 RPC 改那一处再 `--update`。本项目不内置多源轮询，多源要在你的前置层做 |
| 全店突然下不了单，提示「本店风控未放行」 | 下单闸是 **fail-closed**，而且**不只由 `MK_ORDER_GATE_URL` 决定**：`orderGateEnabled()` = URL 非空 **或** `MK_BLOCKLIST_ADDRESS` 非空。标准部署一定有 Blocklist，所以即使 URL 为空，每笔下单也会先做一次链上地址查询；RPC 不可达/超时/名单读不到一律拒单 | 先看拒绝原因：`读不到链上黑名单` = RPC/合约问题，修 RPC；`该钱包地址已被列入全网冻结名单` = 链上 Address 类名单命中。**清空 `MK_ORDER_GATE_URL` 只能关掉店主自配的那道闸，关不掉链上地址闸**；且标准部署下 `--update` 会把 Blocklist 地址写回来。不要为了放行去删 Blocklist |
| 前端发现不到我的店 | ① **节点**没做链上登记（`registerNode`），或登记的 endpoint 与实际域名不一致；② 只登记了节点、**没有走 §0.5 的 `registerShop`**（`/api/shops` 里没有这家店）；③ 节点从公网不可达 | **未登记的节点/店铺前端一定发现不到，没有静态兜底列表**。节点：到前端「开店 / 登记我的节点」用**节点主钱包**登记；店铺：走 §0.5 的申请 + 双签 + `registerShop` + `/verify-onchain` |
| 买家换设备后说找不到订单 | 不是订单丢了 | 让他打开「我的订单」`/orders`——页面拿钱包地址向所有可达店铺并发查询并合并（换设备 / 丢本地凭证的正规找回路径）。显示"N 家店没读到"只说明那几家没读到，≠ 没有订单 |
| 升级后界面报错 / 行为不对 | 新代码与库里的数据对不上，或新版本来就不合适 | 按 §4 回滚到升级前的镜像（数据卷与**数据库都不动**——回滚镜像不会回滚库）；确实要回到升级前的数据，才按 §3 走恢复流程并跑 `check:integrity` |

## 10. 必须知道的边界

- **数据在你自己的两处**：**MySQL 库**（商品、订单、客户收货信息）与**数据卷**（证据附件与商品媒体），都在你自己的机器上，别人读不到，也删不掉；同理，也没有人能替你履行经营者的义务。**容器和镜像都可以随便删了重建，不能丢的是那个库与那个卷**——它们是你全部经营数据的唯一副本。
- **托管资金没有任何人能冻结、划扣、没收**：链上托管合约里没有这类函数。你最多只能**拒绝交付**，把订单推进「退款 / 争议 / 仲裁」轨道。别对投诉方承诺"我已冻结"——那是做不到的事。
- **收到投诉 / 律师函 / 执法或监管的调取请求**时，顺序是：① **先止血**——关店 / 注销节点登记 / 下架商品或停节点（`docker stop`，**都不退资金、不动链上在途单**）；② **保全与导出**——`GET /api/shop/export/orders.csv`（含收货信息，可加 `?status=` / `?from=` / `?to=`，`from`/`to` 是 **ISO-8601** 字符串）、`/api/shop/export/ledger.csv`、`/api/shop/export/products.csv`、`/api/shop/export/codes.csv`，每次导出都会自动写审计；③ **如实回应**——`GET /api/shop/audit`（`ownerOnly`，本店）与 `/api/shop/audit/node`（`hostOnly`，节点级）说明"谁在什么时候做了什么"。
  - **`orders.csv` 不是"全部订单记录"**：它只有订单 + 收货 + `invoice_needed`（开票抬头/税号不在 CSV）相关的列（首列 `order_no`，金额五列 `amount_wei` / `refunded_wei` / `fee_wei` / `commission_wei` / `amount_net_wei`；`from`/`to` 按 `created_at` 过滤，`ledger.csv` 按 `updated_at`，两者都收 ISO-8601）。**不含**争议陈述、证据附件、退货单、交付条目与事件史；这些要分别从证据附件目录、退货/订单接口与事件史保全。
  - **导出按店、`ownerOnly`**：四条 CSV 都只出请求头所指那家店（`shops.seller`）的数据；节点主如果不是该店店主，导不出租户店的数据——要保全别家店，只能请该店店主导出，或按已授权的司法/监管流程处理。
  - **审计范围**：审计只记节点主 / 节点员工 / 店主 / 店员的**管理动作**，**买家动作不在其中**（买家的资金行为看链上事件史）；且**审计按店隔离**：一节点 N 家店，节点主读不到租户店的审计行、店主读不到节点级与别家店的行——回应里给不出的范围要如实说明。
- 这里**没有平台、没有客服、也没有可被投诉的运营主体**。买家问"找谁"：直接找店主、走链上售后（申请退款 → 被拒后争议 → 委员会裁决）、加入他自己浏览器的黑名单，或走司法途径。
- **链上名单只有三类，别把"被拉黑"当成资金冻结**：`Blocklist` 的 `Shop` 类由 `Registry.shopListed` / `Escrow.createOrder` 在链上强制（被拉黑的店不能下单）；`Product`（商品）与 `Address`（钱包地址）类只是**节点/界面策略**，`Address` 类换个新钱包就能绕过。**没有 KYC，也没有制裁名单姓名筛查**；下单闸的地址检查是节点侧的 fail-closed 读链，不是链上强制。
- **撤资只有一条出口**：`requestUnstake` →（冷却期满）`approveUnstake`（owner；打款后不得低于 `max(在途退款/争议敞口, minRetainedStake)`）或 `claimUnstake`（仅 `unstakeApprovalTimeout > 0` 且窗口过；打款后只不得低于在途敞口）。**没有 `releaseStake` / `withdraw()`**；`penalize` 只由 Escrow 调、不受出金下限约束；退款被拒**不会**放掉敞口（直到 `_settle`）。
- **超时不是自动释放**：`MK_ESCROW_TIMEOUT_BLOCKS` 只是最早可释放时间（默认 120960 ≈ 7 天，按单快照；合约允许 1 天..30 天），必须有人发 `releaseExpired`（**任何人都能发**，不需要买家/卖家身份），退款待决/拒绝静置期内不能释放。改它要改 `deploy-constants.json`，不是 `.env`。
- **仲裁是委员会**：1..15 人、阈值 1..成员数，`voteSettlement` / `votePenalty` / `voteAfterSale` 票决；每单在争议/首票时固定届次。**四份合约的任一 owner、平台费收取人、节点主、节点员工、店主都不能当仲裁人**（任命时 `RoleConflict` 拒绝）；没有单仲裁人函数（`arbiter()` / `setArbiter` / `arbitrate` 都不存在）。售后结案买家可单方 `closeAfterSale`，委员会一侧走 `voteAfterSale`。**残余风险是委员会本身被多数控制**（阈值票决的固有代价），不是 owner 兼任仲裁人。
- **节点登记的读取与更新**：更新仍是 `registerNode`（operator 本人交易，改 endpoint/escrow 不用注销），活跃列表读 Registry 的 `getActiveNodes()`；没有 `updateNode` / `getActiveNodeOperators`。
- **个人信息保留期是节点级**：`MK_PII_RETENTION_DAYS`（默认 180，0 = 关闭），`retention/run` 是 `hostOnly`；**租户店不能单独设**。按单 `erase-pii` 是 `ownerOnly`、仅终局单；保留期扫描会跳过售后未结的单，但按单擦除**不会**（§8）。
- **质押提现的默认设置有一条单点失效（链上参数，只有各合约的治理 owner 能改）**：店主撤资走「申请 → 管理员批准」，而**自动放行窗口 `unstakeApprovalTimeout` 默认 0 = 必须人工批准**。也就是说默认配置下，「管理员那把钥匙丢了/失联」与「所有店主的质押再也提不走」是同一件事（罚没窗口期还会叠加一层：窗口开着时禁止出金，见 `Staking.withdrawLock`）。
  - 判断依据不是"哪边更安全"，而是**你打算怎么保管那把钥匙**：单签名热钱包 ⇒ 建议设一个窗口（例如 7 天，`cast send <STAKING> "setUnstakeApprovalTimeout(uint256)" 604800`），代价是"管理员想拦一笔撤资"最多只能拦这么久；多签/冷钥匙 ⇒ 可以留在 0，代价就是上面那条单点。
  - 两边的代价都写在链上那一行旁边（`Staking.setUnstakeApprovalTimeout` 的注释），这里只回答"该怎么选"。
  - **它不改变"谁是店主"**：`requestUnstake` / `claimUnstake` 始终由店主（`shops.seller`）发起，`approveUnstake` 始终由 Staking 治理 owner 发起；节点主与它们是不是同一地址，只决定这几把钥匙是否重合，不会把权限转给节点主。
