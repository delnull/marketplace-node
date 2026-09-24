# 联邦商城 · 开店节点运维手册（店主版）

> 读者就是店主本人：节点在你自己的服务器上，数据在你自己的机器里，出问题只有你能处理。不需要懂运维，但请照做。
> 三条原则：**动手前先备份**；**涉及资金先对账**；**看不懂的字段照表判，不要猜**。
>
> 本文是 **Docker 版**：宿主机上只有 Docker、一个数据卷、（可选）一个反向代理容器——**宿主机不装 Node，也没有 systemd 单元**。
> 这是刻意的：宿主环境（发行版不同、包管理器不同、可能已经有别人的服务在跑）是最不可控的变量，Node 与依赖全在镜像里，
> 于是**容器可以随时删掉重建**（升级就是换个镜像），搬家就是导出/导入那个卷。

| 本文约定 | 含义 |
|---|---|
| `<安装目录>` | 代码 / 配置 / 状态文件所在目录，默认 `/opt/marketplace-node`（有 root/sudo 时）或 `$HOME/marketplace-node`（脚本的 `--dir`） |
| `<容器名>` | = 服务名，默认 `marketplace-node`（脚本的 `--service`），也就是 `docker` 里的容器名 |
| `<数据卷>` | 你的**全部数据**：默认 `marketplace-node-data`（脚本的 `--volume`），挂进容器是 `/data` |
| `<端口>` | **宿主**上发布的端口，默认 `8090`（脚本的 `--port`）；容器内固定监听 `8090` |

> 下面的命令一律按**默认名字**写。同机开了第二家店、或改过 `--service / --volume / --dir / --port` 的，
> 把命令里的名字换成 `bash deploy.sh --status` 打印出来的那一套（它同时记在 `<安装目录>/.deploy-state` 里）。

硬约束（违反会出各种怪问题）：

- **单进程单实例**：一个数据卷只能给**一个**节点容器用——别把同一个卷同时挂给两个容器，也别在宿主机上再起一个进程读同一个库（SQLite 是单文件，两个写者必然互相踩）。
- **`MK_TOKEN_SECRET` 必须是 ≥32 字符的强随机值**：缺失 / 过弱 / 仍是模板示例值一律**拒绝启动**，没有旁路开关。
- **改完 `<安装目录>/.env` 必须重建容器**（`bash deploy.sh --update`）：`.env` 是 `docker run --env-file` 在**创建容器那一刻**读进去的，`docker restart` 只是重跑同一份旧配置——改了等于没改，这条最容易白忙一场。
- **进容器一律带 `-u node`**：`docker exec -it -u node <容器名> sh`。容器主进程以 uid 1000（非 root）运行，但 `docker exec` **默认仍以 root 进入**——用 root 在卷里写文件会让节点之后**写不动**（症状与修法见 §8）。
- **对外必须 https**：联邦前端是 https 页面，浏览器会拦掉对 http 节点的请求。

## 1. 日常检查（每天两分钟）

| 想确认什么 | 命令 |
|---|---|
| 容器 / 数据卷 / 关键配置 / 健康状态 / 最近日志 + 探活，一次看全 | `cd <安装目录> && bash deploy.sh --status` |
| 同上（`--status` 与 `--health` 打印的是同一份；探活不通过会以 **exit 2** 结束，可以放进自己的监控脚本） | `cd <安装目录> && bash deploy.sh --health` |
| 容器在不在、健不健康 | `docker ps --filter name=marketplace-node`（STATUS 一栏应看到 `Up … (healthy)`） |
| 实时看日志（日志走 stdout，容器版没有 journald） | `docker logs -f marketplace-node`（只看最近 100 行：`docker logs --tail 100 marketplace-node`） |
| 手工读健康检查 | `curl -s http://127.0.0.1:<端口>/healthz` |
| CPU / 内存占用 | `docker stats --no-stream marketplace-node` |

> **容器 `healthy` 只说明"进程还能应答 `/healthz`"。** 镜像里自带的 HEALTHCHECK 判的只是 HTTP 200，它**看不出**后台任务停摆：
> 事件轮询器、链上对账、个人信息擦除都可能在服务照常应答的同时已经停了。真正的判据是下面这些字段。

> **服务活着 ≠ 后台任务在跑。** `/healthz` 能返回 200 时，事件轮询器照样可能已经停摆，所以要看你 `/healthz` 返回里 `data` 的这三块状态字段：`watcher`（链上事件扫描游标）、`reconcile`（链上状态对账）、`piiRetention`（个人信息到期擦除）。同一个响应里还有 `owner`（节点自报的店主地址）与 `escrowAddress`（节点自报的托管合约）——它们应与 `.env` 一致，因为买家下单弹窗会拿链上登记与节点自报交叉比对，**不一致就直接拒绝支付**。

| 块 | 字段 | 正常长什么样 | 什么时候要管 |
|---|---|---|---|
| watcher | `configured` | `true`（已配 `MK_ESCROW_ADDRESS`） | `false` = 纯展示模式、**不能下单**；不是预期就查配置 |
| watcher | `lastOkAt` / `lastPollAt` | 持续推进（默认 15 秒一轮，`MK_ESCROW_POLL_MS`） | 超过 3× 轮询间隔不推进 = **轮询停摆** |
| watcher | `lastError` | `null` | 非 `null` 即告警（RPC 不可达 / 解析失败） |
| watcher | `lagBlocks` | 在 **0 ↔ 12** 之间摆动 | **只看趋势**：持续单调增长且 `upToDate` 长期为 `false` = 轮询跟不上或被 RPC 限流。**「停在 12」不是故障** |
| watcher | `quarantined` | `0` | **>0 要人工介入**：有事件被跳过，相关订单不会回写（处理见 §8） |
| reconcile | `enabled` | `true` | `false` 而你以为它在兜底 = 没有任何自动修复（未配 `MK_ESCROW_ADDRESS` 时就是 `false`） |
| reconcile | `lastOkAt` / `lastRunAt` | 持续推进（默认 10 分钟一轮，`MK_CHAIN_RECONCILE_MS`） | 超过 3× 周期不推进 = **对账停摆** |
| reconcile | `lastError` | `null` | 非 `null` 即告警：此时滞留单不会被修回 |
| reconcile | `lastRepaired` / `lastMissing` | `0` / `0` | `lastRepaired > 0` 值得追因（轮询器漏过一单）；**`lastMissing > 0` 必须人工核**（多半是合约地址 / 链 ID 配错） |
| piiRetention | `days` / `enabled` | 与你要求的保留期一致（默认 180 天） | `days` 不符就改（见 §7）；**以为开着、其实 `enabled=false` 最危险**（个人信息一直留着） |
| piiRetention | `lastOkAt` / `lastRunAt` | 持续推进（默认每 6 小时一轮） | 超过 3× 周期不推进 = **擦除停摆** |
| piiRetention | `lastError` | `null` | **非 `null` 即告警**：擦除不可逆，静默失败只会让个人信息越留越久 |
| piiRetention | `lastErased` / `lastScanned` | 供人工核对（累计口径看审计 `order.erase_pii`） | 数目异常时去审计里核 |

> 基线：轮询器只处理「链头 − 确认深度」之前的事件（`MK_ESCROW_FINALITY_BLOCKS`，默认 12 块 ≈ 1 分钟），所以**买家付款后订单滞后约 1 分钟才变「已托管」是正常的**，不是节点卡住。`lagBlocks` 也不是"落后量"：追平时它被置 0，链头前进后下一轮又 ≈12。

建议固化的动作：每天 `docker exec -u node marketplace-node npm run reconcile`（**exit 0 = 本地账与链上一致，exit 2 = 有差异，必须人工核**；容器里已经有完整运行环境与配置，**不要**为了跑它去宿主机装 Node）；每周抽查 `/api/shop/audit` 最新 50 条；日志里留意 `[escrowWatcher]`、`[chainReconcile]`、`[autoDeliver]`、`[poolAlert]`（已收款但池内资源不足）、`[pii]`（擦除 / 附件删除失败）、`[webhook] 通知失败`、`[sweeper]`、`[audit] 写入失败`、`[server]`。

**几个不常做、但一定会用到的动作**：

| 想做的事 | 命令 / 做法 |
|---|---|
| 换域名 | 域名解析好后重跑 `bash deploy.sh --update --domain 新域名`（会重建容器与反代/证书配置，SIWE 域名与 CORS 白名单一并更新），然后到前端开店向导里**重新登记**一次 |
| 同机再开一家店 | `bash deploy.sh --service shop-b --volume shop-b-data --port 8091 --dir /opt/shop-b`（容器名、卷名、端口三者都要换）。第二家店**别再选 Caddy 模式**：`80/443` 已经被第一家店的 Caddy 容器占着，第二个 Caddy 起不来——用 `--tls-mode none`（交给已有反代）更省事 |
| 链上更新登记 / 注销登记 | 到 https://fedmall.bityuan.com 的开店向导里操作（**只有登记时的那个钱包**能更新或注销） |
| 暂停营业 | 前端「卖家面板 → 店铺设置」把商品下架；要让目录里也看不到，就在向导里注销登记。**数据与订单都还在你的卷里**，重新登记即可复业 |
| 关掉节点（数据不动） | `docker stop marketplace-node`；以后恢复：`docker start marketplace-node` |
| 不想再用这套安装（但留数据） | `bash deploy.sh --uninstall`：移除节点容器与 Caddy 容器、删掉它们之间的网络，**数据卷保留**；`.env` 与状态文件也留在安装目录 |
| 彻底清除（不可逆） | `bash deploy.sh --purge`：**连数据卷一起删**，要先手输卷名确认（非交互场景加 `--yes` 跳过确认） |
| 只看计划、不动手 | `bash deploy.sh --dry-run`（把要装 Docker / 建镜像 / 建卷 / 起容器 / 配 HTTPS 的计划打印出来就退出） |

## 2. 备份

**要备两样东西**：**数据卷**（SQLite 库 + 证据附件——商品、订单、客户收货信息全在这儿），以及 `<安装目录>/.env`（里面有令牌密钥，权限收紧、别外传）。

```bash
# 1) 导出数据卷（整卷带走：库 + -wal/-shm + attachments/）
cd /opt/marketplace-node
docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup \
  --entrypoint tar marketplace-node:latest czf /backup/node-data-$(date +%F).tar.gz -C /data .

# 2) 备份配置：丢了 .env 里的 MK_TOKEN_SECRET，店主与店员的登录态会全部失效
cp -a /opt/marketplace-node/.env /var/backups/marketplace-node/env-$(date +%F)

# 3) 确认备份里真有东西（能恢复的才叫备份）
tar tzf node-data-$(date +%F).tar.gz | head
```

- 导出用的是**镜像里自带的 `tar`**（`--entrypoint tar`），宿主机上什么都不用装；`marketplace-node:latest` 这份镜像本来就在机器上，所以这条命令离线也能跑。
- 想要一份"完全一致"的快照，就先停一下节点再导：`docker stop marketplace-node` → 导出 → `docker start marketplace-node`（买家会看到几十秒不可达，挑低峰做）。
- ⚠️ **别只 `cp` 卷里的 `marketplace-node.db` 单文件**：SQLite 跑在 WAL 模式，最近的写入可能还在没合并的 `-wal` 里，直接拷会**看起来成功、恢复后少一截**。省心的两条路：整卷导出（`-wal` / `-shm` 一起带走），或先停容器再导。
- 想每天自动跑：把下面的命令存成一个脚本（`OUT` 自己挑一个**不在安装目录里**的位置），`sudo crontab -e` 加一行；脚本里清理旧的、**本地留最近 7 份**就够：

```bash
#!/usr/bin/env bash
set -euo pipefail
VOL=marketplace-node-data; OUT=/var/backups/marketplace-node
mkdir -p "$OUT"; STAMP=$(date +%F)
docker run --rm -v "$VOL":/data -v "$OUT":/backup \
  --entrypoint tar marketplace-node:latest czf "/backup/node-data-$STAMP.tar.gz" -C /data .
ls -1t "$OUT"/node-data-*.tar.gz | tail -n +8 | xargs -r rm -f    # 本地留最近 7 份
```

- 另建议存一份到**另一台机器或离线介质**：同一台机器上的备份，磁盘坏了会一起没。

## 3. 恢复与恢复演练

**每季度演练一次，首次上线前务必做一次**——演练就是照下面真的走一遍，并把数据对完。

1. 备好一台干净机器（或同机的**另一套**安装：`--service` / `--volume` / `--port` / `--dir` 四个都换）。新机上装好 Docker（`bash deploy.sh` 会按发行版自己装），先跑一次 `bash deploy.sh`，把镜像与**一个空数据卷**建起来；
2. `docker stop <容器名>`（恢复期间别让节点再写数据）；
3. 把备份导进数据卷（导入走容器里的 `tar`，文件属主按归档原样还原到容器里的 `node` 用户）：

```bash
cd /var/backups/marketplace-node
docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup \
  --entrypoint tar marketplace-node:latest xzf /backup/node-data-YYYY-MM-DD.tar.gz -C /data
```

4. `docker start <容器名>`，再 `bash deploy.sh --health`，并确认商品 / 订单 / 码池齐全、`docker exec -u node marketplace-node npm run reconcile` → **exit 0**；
5. `docker exec -u node marketplace-node npm run check:integrity` → **必须 exit 0**。它只读地比对「交付行 ↔ 码池 / NFT 池」，专抓两种**恢复特有**的痕迹：**① 已交付的码在池里回到 `unused`**（码池状态默认值就是 unused，恢复旧库会把"备份点之后发出的码"打回未用态 ⇒ **同一个码可能被再发给下一个买家**，而链上资金是真的）；**② 池里 `used` 却找不到交付行**（交付记录被回退，收据 / 举证链断裂）。
   发现不一致时**不要**用脚本自动改：先定口径（以链上已交付为准，还是以池内状态为准）再人工处理；已发出、又无法与买家核对的码，宁可在码池里手工标记为不可用，也别让它重新进可交付池。

**必须分清两种「丢失」**：**状态回写**能补——恢复点之后的链上事件，轮询器会接着扫并回写**本地已有的行**；**订单行本身补不回来**——新建订单的写入只发生在"创建草稿"这一步，轮询器只会更新已存在的行，所以恢复点之后新建的订单**在本地永久不存在**（你看不到、也不会发货），只能按链上托管单号人工核对。

> **结论（请记住）**：本项目里**「恢复旧备份」不是受支持的运维动作**。链下数据可以放弃时，干净做法是**重建库 + 让节点重新扫链**（重建时把旧库文件先改名留档、别直接删；扫链起点 `MK_ESCROW_START_BLOCK` 设成 Escrow 部署块高度，一键脚本装好的 `.env` 里已经是这个值），再用 `reconcile` 与 `check:integrity` 复核：

```bash
# 重建库：旧的整套（含 -wal/-shm）挪进 /data/old-db 留档，别删
docker stop marketplace-node
docker run --rm -v marketplace-node-data:/data --entrypoint sh marketplace-node:latest \
  -c 'mkdir -p /data/old-db && mv /data/marketplace-node.db* /data/old-db/'
docker start marketplace-node     # 起一个新空库，从 MK_ESCROW_START_BLOCK 重新扫链
```

只有在"链下数据比链上状态更权威"的极少数场景（例如码池原始导入文件已丢失）才谈恢复，且必须先跑一次 `check:integrity` 看清代价。

## 4. 升级到最新版 / 回滚

代码来自本仓库 `https://github.com/delnull/marketplace-node`。**升级 = 重新构建镜像 → 用同一个数据卷重建容器**，配置、令牌密钥、数据全部保留。

```bash
cd /opt/marketplace-node
docker tag marketplace-node:latest marketplace-node:keep-$(date +%F)   # 升级前给旧镜像留个标签，回滚要用
git pull --ff-only        # 让安装目录里的代码变成新版（当初不是 git clone 装的，就跳过这一步）
bash deploy.sh --update   # 重新构建镜像 → 用同一个数据卷与配置重建容器
```

- **`--update` 只做"用安装目录里现有的代码重建镜像 + 重建容器"，它不会替你拉代码**：所以那行 `git pull` 要不要跑，取决于你当初怎么装的（在安装目录里 `git clone` 装的要；用 `bash <(curl …)` 或下载 ZIP 解压装的，要自己把新代码换上去）。想记下升级前的代码版本：`cd /opt/marketplace-node && git rev-parse --short HEAD`。
- `.env` 里**脚本管理的键**（端口、店主地址、域名、CORS 白名单等，共二十多个）会按本次参数与状态文件重写一遍；**你自己加的那些键**（兜底汇率、风控闸、`MK_OWNER_LOGIN_ALERT` 等）会原样保留，脚本还会把它们列出来告诉你保留了哪些。
- **升级前先按 §2 备份**（代码能退回去，数据不会跟着退回去）；升级后必做两件事：`bash deploy.sh --health`（对照 §1 三块）与 `docker exec -u node marketplace-node npm run reconcile`（exit 0）。
- **升级前先看计划**：`bash deploy.sh --update --dry-run` 什么都不改；非交互场景（脚本里 / `ssh` 不带 `-t`）加 `--yes`，例如 `bash deploy.sh --update --yes`。

**回滚**（脚本没有回滚子命令，手动做）：把容器换回升级前那个镜像标签，**数据卷不动**——这就是 `deploy.sh` 起容器时用的那一串参数：

```bash
docker images 'marketplace-node*'        # 找到升级前打的 keep-… 标签
docker rm -f marketplace-node
docker run -d --name marketplace-node --restart unless-stopped \
  --network marketplace-node-net --network-alias marketplace-node \
  -p 127.0.0.1:8090:8090 --env-file /opt/marketplace-node/.env \
  -v marketplace-node-data:/data marketplace-node:keep-2026-09-23
```

> 上面那串里的**名字、端口、卷名、路径要按你这套安装的来**（`bash deploy.sh --status` 会打印，`<安装目录>/.deploy-state` 里也记着）。`--network` / `--network-alias` 别漏：Caddy 容器就是靠服务名在 `<服务名>-net` 这张网络里找到节点的。选过 `--tls-mode none` 的安装，发布地址是 `0.0.0.0` 而不是 `127.0.0.1`。

回滚后若数据与旧代码对不上（界面报错、`check:integrity` 不过），按 §3 处理：数据可以放弃就重建库 + 重扫链，**不要**拿旧备份去覆盖新数据——那会把升级后新增的订单与售后记录一起抹掉。

## 5. 换服务器（迁移）

1. **备份**：在旧机上按 §2 做两件事——导出数据卷，**并把 `<安装目录>/.env` 一起带走**（里面有 `MK_TOKEN_SECRET`，不带走的话新机上所有人的登录态都失效）；
2. **新机上先把架子搭好**：装好 Docker（`bash deploy.sh` 会自己装），按新机的路径放好代码，先跑一次 `bash deploy.sh --owner <店主地址> --domain <域名> --email <邮箱>`，把镜像、空数据卷、反代/证书都建好；
3. **搬数据**：`docker stop <容器名>` → 按 §3 第 3 步把备份导进新机的数据卷 → 用旧机那份 `.env` 覆盖新机的 `<安装目录>/.env` → `bash deploy.sh --update`（它会重建并启动容器，这样新那份 `.env` 才会被读进去）；
4. **改配置**：`.env` 里的共享合约地址、`MK_ESCROW_START_BLOCK` **保持原值**（事件游标存在库里，会自动从停摆处接着扫）；链上登记的 endpoint 不在 `.env` 里，它在开店向导网页填写；
5. **对外入口**：确认 `curl -s https://你的域名/healthz` 正常后，**再把域名解析指到新机**（反代与证书在第 2 步已经配好；域名变了就 `bash deploy.sh --update --domain 新域名`）；
6. **重新登记**：域名换了就按新域名重新登记，用**同一个店主钱包**即可——同一个 operator 更新 endpoint **不需要先注销**，旧 endpoint 会被链上释放；也可以 `bash deploy.sh --register --owner <店主地址> --domain <新域名> --key-file <私钥文件>`。**域名原样保留的话，这一步不用做**（链上登记记的就是域名）；
7. **验证**：`bash deploy.sh --health` → 商品 / 订单完整 → `docker exec -u node marketplace-node npm run reconcile` exit 0 → 用真钱包下一笔小额单，走完「下单 → 支付 → 发货」；**旧机器先别清理**，数据至少留 7 天，期间随时可以把域名指回去。

## 6. 密钥与身份变更

### 6.1 登录令牌密钥（`MK_TOKEN_SECRET`）

| 情形 | 怎么做 |
|---|---|
| 常规轮换 | `openssl rand -base64 32` 生成新值 → 改 `<安装目录>/.env` → **重建容器**：`cd <安装目录> && bash deploy.sh --update`。旧令牌全部失效，**所有登录用户要重新登录**（建议低峰做，可先通知活跃店员）。**`docker restart` 不行**——它读的还是旧配置，改了等于没改 |
| 疑似泄露 | ① **立即轮换**（同上）；② 用 `/api/shop/audit` 查泄露窗口内有没有异常的店员动作；③ 若怀疑资金侧：**链上托管资金不受这个密钥影响**（链上动作仍需钱包私钥），重灾区是**码池原文与发货**——逐个核对该窗口内发货单的收货地址是否可疑 |

不需要双密钥过渡期（登录令牌最长 24 小时）。可选加固：自己在 `.env` 里加一行 `MK_OWNER_LOGIN_ALERT=1`（这类脚本不管的键在 `--update` 时原样保留），店主每次登录都推一条通知（含地址与来源 IP），用来发现有人冒领店主令牌。

### 6.2 换店主钱包（链上转让）

- 店主身份 = 店主钱包地址（`.env` 的 `MK_SHOP_OWNER`）；**链上登记的 operator 就是登记时用的那个钱包**，链上更新登记 / 注销只能由它发起。
- 换店主**不能只改 `.env`**：要走链上 Registry 的原子转让 `transferNode`——登记从旧 operator 直接换到新 operator，**没有抢注窗口**，也不用"先注销再注册"。转让要**双方各签一次**（旧店主 `fromSig` + 新店主 `toSig`，各自的 EIP-191 personal 签名；摘要 = `keccak256(abi.encode(from, to, endpoint, escrowAddress, chainId, registry))`，chainId = 2999）。**前端转让向导尚未实现**，目前只能用脚本 / 钱包直调合约——这一步建议找懂链上工具的人配合。
- **转让的是店铺经营权，不是历史订单的资金归属**：链上托管单的 `seller` 在下单时已锁定且不可更改，在途订单仍按 §6.3 处理。
- 操作顺序：新服务器按 §5 恢复数据 → `.env` 设 `MK_SHOP_OWNER=新地址` → `bash deploy.sh --update`（重建容器）→ `docker exec -u node marketplace-node npm run reconcile` 对账 → 到店铺页确认「链上登记 operator」已变成新地址。
- 旧店主**无法操作**（失能、身故）时：转让必须 `fromSig`，**拿不到旧私钥就转不了**——这是双签设计的必然代价；此时新店主只能用新地址另起一家店，搬走能搬的数据（商品 / 码池），并在原店公告与社区渠道公示。

### 6.3 私钥丢失 / 关店

**先理解一件事**：链上托管单的 `seller` 是下单时锁定的店主地址，且**不可更改**——确认收货由买家签、退款同意 / 拒绝要店主签、仲裁判付也进这个地址。所以「私钥丢了」不是改 `.env` 重建容器就能解决的：**换 `MK_SHOP_OWNER` 只影响新订单。**

| 情形 | 怎么办 |
|---|---|
| 私钥丢失 | ① **立即**把商品全部下架停售并对外公告（公告不依赖店主签名）；② 在途单按下面三行逐单处理；③ 新地址只能接新单：改 `MK_SHOP_OWNER` → `bash deploy.sh --update`（重建容器）→ 用新钱包重新登记（**旧登记无法用新钥注销**，会一直挂在目录里） |
| 未发货（escrowed） | 请买家**申请退款**；你已无法同意 → 资金冻结 → 订单超时（约 7 天）后买家可直接发起争议，仲裁判退即可全额退回。**不要等超时释放**——那会把钱打进你已丢失私钥的地址 |
| 已发货（shipped） | 请买家尽快**确认收货**（钱进店，但你已取不出来 = 实质损失）；**货没真交付就不要让买家确认**，引导退款 / 争议 |
| 争议中（disputed） | 等仲裁：判退买家可以回款；判付卖家则进死地址——请在仲裁材料里说明情况 |
| 关店（主动停业） | ① 公告关店日期与售后截止日；② **清在途**：未结订单要么买家确认、要么退款结清，数字码池下架、停止接单；③ 归档前先跑一次保留期（§7）；④ 到期后注销链上登记 → 停通知 → 停节点（`docker stop marketplace-node`；要连容器一起撤掉就 `bash deploy.sh --uninstall`，**数据卷保留**），并按 §2 把数据卷导出成归档包冷存（买家查询与追溯用，建议留 ≥ 180 天）；⑤ 公开渠道不要留"仍在运营"的误导信息。注意链上登记**不会过期**，你失能又无法注销时店铺会一直挂在目录里，买家侧看到的是"不可达" |

## 7. 数据保留与清理

> **个人信息不要手工跑 SQL 删。** 正规通道只有下面三条，它们会同时清掉「收货信息 + 买家备注 + 开票抬头 / 税号 + 售后陈述正文 + 证据附件（库里行 + 磁盘文件）」，并在审计里留痕；手工 `UPDATE` 只清列、不清附件文件、也不入审计——那是"以为删干净了，其实没删"。顺带一提：`docker exec` 默认以 root 进容器，手工改库还容易在卷里留下 root 属主的文件，让节点之后**写不动**（§8）。

| 通道 | 怎么用 |
|---|---|
| 买家点名单请求 | `POST /api/shop/orders/:id/erase-pii`（仅**终局**单；在途单会被拒——你还要按地址发货）。只能由店主调用 |
| 到期自动擦除 | `MK_PII_RETENTION_DAYS`（默认 180 天，**0 = 关闭**）：每 6 小时扫一轮，擦除终局且静置超期的订单 |
| 手动立刻跑一轮 | `curl -X POST https://你的域名/api/shop/retention/run -H "Authorization: Bearer <店主令牌>" -H 'Content-Type: application/json' -d '{"days":180}'`；`{"days":N}` 可临时收紧，`{"days":0}` 表示关闭 |

`erase-pii` 与 `retention/run` 两个接口都**幂等**，都写审计（`order.erase_pii` / `retention.run`，只记条数不记内容）；`MK_PII_RETENTION_DAYS=0` 时周期扫描**不启动任何定时器**（关闭就是真关闭），但上面两个显式接口仍然可用；**擦除不可逆，也不等于这一单从系统里消失**——金额、状态、链上托管单号、支付凭证、事件史、物流单号、退货单地址与备注、已交付的码与 tokenId、评价正文都是**刻意保留**的，请如实告知买家。**关店 / 搬家前先跑一次保留期**（用上表第三个通道，或等周期扫描），把已过期的终局单个人信息先清掉——归档包里的个人信息越少越好。

| 数据 | 说明 | 怎么清理 |
|---|---|---|
| `attachments/`（证据附件） | 卷内 `/data/attachments`；单文件 ≤2MB、单条 ≤6 个、单订单 ≤20MB | 随上面的擦除一并删除（库里行 + 磁盘文件）。磁盘删除在事务提交后执行，失败会打 `[pii] … 证据附件删除失败` 并留待下次补齐——**看到这行请手工清一下那个目录**（进容器记得带 `-u node`）；平时也留意数据卷占用的磁盘空间：`docker system df -v`，或 `docker run --rm -v marketplace-node-data:/data --entrypoint du marketplace-node:latest -sh /data` |
| 审计日志 | **没有**自动保留策略 | 按需归档后删除（先查一下行数确认）。⚠️ 删之前先导出：它是"谁在什么时候删过谁的数据"的唯一凭据 |
| 登录 nonce | 自动过期 | 节点每 10 分钟自动清理，**不用你管** |
| 退货单 / 评价 / 争议证据 | 交易上下文 | 建议随订单长期保留（仲裁与对账要追溯）。注意：擦除会把争议陈述正文置为墓碑串但**保留行**，评价正文**不在擦除范围内** |

## 8. 故障速查（症状 → 怎么办）

| 症状 | 原因 | 怎么办 |
|---|---|---|
| 容器反复重启 / `docker ps -a` 里是 `Exited` 或 `Restarting` | 节点进程起来就退出：配置被改坏、卷权限不对、端口被占。`--restart unless-stopped` 会自动重拉，但**配置错会变成无限重启循环** | `docker logs --tail 100 marketplace-node` 看真实原因；自己 `docker stop` 过的，`docker start marketplace-node` 即可。节点**本身**的判据仍然是 §1 那三块，别只看容器在不在 |
| 容器起不来，日志报 `SQLITE_READONLY` / `EACCES` / `permission denied` | 数据卷里有 root 属主的文件——多半是有人用 `docker exec`（**不带 `-u node`**）进去写过东西。节点以 uid 1000 跑，写不动这些文件 | 修属主：`docker run --rm -v marketplace-node-data:/data --entrypoint chown marketplace-node:latest -R node:node /data`；以后进容器一律 `docker exec -it -u node marketplace-node sh`。**不要**图省事给容器加 `--privileged` 或用 root 跑节点 |
| 容器起不来，日志说 `MK_TOKEN_SECRET` 不合格 | 密钥缺失 / <32 字符 / 重复或纯数字 / 仍是模板示例值 | 删掉 `.env` 里那一行后 `bash deploy.sh --update`（会重新生成并重建容器）。**没有旁路开关**——弱密钥能让任何人伪造店主令牌。代价是店主登录态失效 |
| 容器起不来，日志说 `chainId` 不符 | `MK_RPC_URL` 指到了别的链 | 改回 `https://mainnet.bityuan.com/eth` 后 `bash deploy.sh --update` |
| 端口被占用 / 想换端口 | 同机已有服务占了 8090（另外 8080 也很常被别的东西占着，别改用它） | 换一个：`bash deploy.sh --update --port 8091`（会重建容器并更新反代配置）。**占用者若是旧版的宿主安装**（这台机器以前用"装 Node + systemd"的方式部署过）：`systemctl status marketplace-node` 看它还在不在跑，清理掉：`sudo systemctl disable --now marketplace-node && sudo rm -f /etc/systemd/system/marketplace-node.service && sudo systemctl daemon-reload`（`deploy.sh` 检测到这种残留也会提示你） |
| 改完 `.env` 没生效 | `.env` 是在 `docker run` 那一刻读进容器配置的，`docker restart` 不会重读 | `bash deploy.sh --update`（重建容器）。Caddyfile 不一样，它是挂载进去的文件，改完 `docker restart marketplace-node-caddy` 就生效 |
| 磁盘满了 | 卷里的附件 / 审计 / 日志（`docker logs` 也占磁盘） | `docker system df -v` 看是谁占的；清理无用的旧镜像：`docker image prune -f`。⚠️ **千万别 `docker volume prune`**——它删的正是"当前没有容器在用"的卷，你的店就在里面 |
| 脚本第 ⑧ 步证书申请失败 | 域名没解析到本机 / 80 端口没放行 / 用了 CDN 代理 | **Caddy 的报错在 `docker logs marketplace-node-caddy` 里**（证书数据在 `${服务名}-caddy-data` 卷里，重建 Caddy 容器不会重新申请）；修好后重跑 `bash deploy.sh --update --domain 你的域名`。用宿主 nginx 模式的话，也可手动 `sudo certbot --nginx -d 你的域名` |
| 买家说"已支付但订单还是待支付" | 轮询器刻意等确认深度（默认 12 块 ≈ 1 分钟），状态回写天生滞后 | 先等 1 分钟；仍不动让买家点订单页「同步链上状态」（不受确认深度限制，直读链上真值）；再核 `.env` 合约地址与买家实际支付地址是否一致、RPC 是否可达 |
| 界面一直不更新 / 收款流水缺单 | 轮询器停摆或事件被隔离——**容器照样 `healthy`，看不出来** | 看 §1 的 `watcher` 块：`lastOkAt` 不推进 = 停摆；`quarantined > 0` = 有事件被跳过；`lagBlocks` 持续增长 = 跟不上 |
| `/healthz` 的 `quarantined > 0` | 同一事件连续失败 3 次后被移入隔离清单（跳过它并继续推进游标，避免一个坏事件把扫描窗口永久钉死） | ① 读隔离清单定位事件；② 按订单号用 `POST /api/orders/:id/sync` 从链上**单独补回**（隔离期间的正规补救路径）；③ 确认该事件确实无害后，从隔离清单删掉该条，下轮会重试；④ 同一单反复被隔离 = 本地行与链上真值不符，按下一行查 |
| 订单停在"待发货"很久，链上却早已结清 / 退回 | 事件被漏扫（RPC 抖动、停机跨过扫描窗口、起始块配错、事件进隔离） | 看日志有没有 `[chainReconcile] 修复滞留订单`（后台对账默认 10 分钟一轮，只处理**静置超过 6 小时**的非终态单）；等不及就直接 `POST /api/orders/:id/sync`（不受 6 小时限制） |
| 日志出现「本地为 … 链上却查不到该托管单」 | 多半是合约地址 / 链 ID 配错（也可能是 RPC 读到了错误的链） | **必须人工核** `.env` 的 `MK_ESCROW_ADDRESS` / `MK_CHAIN_ID` 与买家实际支付是否一致，再决定改配置还是走 `/sync` |
| `npm run reconcile` 报差异（exit 2） | 本地入账但链上无事件 = 漏扫；链上有事件但本地未入账 = 事件应用失败 | 前者把 `MK_ESCROW_START_BLOCK` 调早回扫；后者看轮询日志后手动 `/sync`。逐单人工核，不要默认"脚本认不出来"。跑法：`docker exec -u node marketplace-node npm run reconcile` |
| 收到 `order.pool_empty` 告警 | 已收款但池内资源不足（码池 / NFT 池在建草稿与托管落定之间被别单买空） | **立即补货**（导入兑换码 / tokenId）或与买家协商退款。每单只告警一次，别等下一封。收到 `order.hold_missing` 是另一回事：订单从取消恢复但限量库存已被买走，需核对余量后扩容或退款 |
| 发货被拒 | 「缺链上支付凭证」= 该单是无凭证的异常行，先「同步补齐」，仍为空就取消清理（链上托管若真的落定，轮询器会自动恢复真单）；「退款申请待处理」= 买家退款冻结期，先在链上拒绝或同意退款（同意时可**只退部分金额**，留空 = 全额退） | 按左边对应处理 |
| 操作员操作被拒（403） | 操作员只能用经营面；财务面（流水 / 看板 / 导出 / 审计）是店主专属 | 在卖家面板「店铺设置 → 店员白名单」确认该地址已加入（增删即改即生效，不用重启） |
| 商品页 / 订单页报「商品内容已被修改」但没人改过 | 商品的快照哈希与按当前算法复算的结果不一致，常见于手工改过库里的行 | 把该商品**重新保存一次**（会重算并写回哈希；批量改价同样重算）即消除；重存后仍不一致才是真被改过 |
| 买家要求删除个人信息 | — | 走 `POST /api/shop/orders/:id/erase-pii`（仅终局单，在途单会被拒）；到期自动擦除见 §7。**不要手工跑 SQL** |
| 下单被拒「未成年人禁止购买商品」 | 该商品打开了未成年人限制，下单必须由买家勾选确认 | 要放开就编辑商品把该开关关掉（会重算快照哈希，在途订单不受影响）。**哪些商品属于限制商品由你自己界定**——软件只提供机制 |
| 日志出现「忽略与链上真值不符的事件」 | 有人对同一个订单号造了诱饵单（未付款草稿的单号是公开的），该事件被**刻意拒绝落地** | 核对本地单与买家真实支付交易；买家的真实支付若因此被挡，只能作废重下 |
| 汇率频繁 stale / RPC 报错 | 官方行情与公开源不可达；或节点默认只配了一个 RPC（单点） | 检查出网并加 `MK_FALLBACK_BTY_USDT` / `MK_FALLBACK_USDT_CNY` 兜底（这两个键不归脚本管，`--update` 会原样保留）；把备选公共 RPC 写进 `MK_RPC_URL`（多源轮询要自己在前置层做，本项目不内置） |
| 全店突然下不了单，提示「本店风控未放行」 | 配了 `MK_ORDER_GATE_URL`，而风控闸是 **fail-closed**：不可达 / 超时 / 非 200 一律拒单 | 先恢复你的风控服务；**逃生通道 = 清空 `MK_ORDER_GATE_URL` 并重建容器**（`bash deploy.sh --update`，这样 `.env` 才会被重新读进去；留空的行为与从未配置完全一致） |
| 前端发现不到我的店 | 没做链上登记，或登记的 endpoint 与实际域名不一致 | **未登记的节点前端一定发现不到，没有静态兜底列表**；到前端「开店 / 登记我的节点」用店主钱包登记，并确认目录里能看到本店 |
| 买家换设备后说找不到订单 | 不是订单丢了 | 让他打开「我的订单」`/orders`——页面拿钱包地址向所有可达店铺并发查询并合并（换设备 / 丢本地凭证的正规找回路径）。显示"N 家店没读到"只说明那几家没读到，≠ 没有订单 |
| 升级后界面报错 / 行为不对 | 新代码与库里的数据对不上，或新版本来就不合适 | 按 §4 回滚到升级前的镜像（数据卷不动）；确实要回到升级前的数据，才按 §3 走恢复流程并跑 `check:integrity` |

## 9. 必须知道的边界

- **数据只在你自己的机器上**：在你的**数据卷**里，别人读不到，也删不掉；同理，也没有人能替你履行店主该履行的义务。**容器和镜像都可以随便删了重建，唯一不能碰的是那个数据卷**——它是你全部经营数据的唯一副本。
- **托管资金没有任何人能冻结、划扣、没收**：链上托管合约里没有这类函数。你最多只能**拒绝交付**，把订单推进「退款 / 争议 / 仲裁」轨道。别对投诉方承诺"我已冻结"——那是做不到的事。
- **收到投诉 / 律师函 / 执法或监管的调取请求**时，顺序是：① **先止血**——关店 / 注销登记 / 下架商品或停节点（`docker stop`，**都不退资金、不动链上在途单**）；② **保全与导出**——`GET /api/shop/export/orders.csv`（含收货信息，可加 `?status=` / `?from=` / `?to=`）、`ledger.csv`、`products.csv`、`codes.csv`，每次导出都会自动写审计；③ **如实回应**——`GET /api/shop/audit` 说明"谁在什么时候做了什么"，但它**只记店主 / 店员动作，买家动作不在其中**（买家的资金行为看链上事件史）。
- 这里**没有平台、没有客服、也没有可被投诉的运营主体**。买家问"找谁"：直接找店主、走链上售后（申请退款 → 被拒后争议 → 仲裁裁决）、加入他自己浏览器的黑名单，或走司法途径。
