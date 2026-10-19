# 云上开店（资源自动化）：机器、域名、解析、HTTPS、节点进程

**先说清楚它做不到什么：它不是"一条命令开出一家能卖的店"。**
这个目录自动化的是云资源与服务器上的节点进程：开机器（非中国大陆）、（可选）买域名、建解析、
把打包好的 `node/` 上传到机器、调用节点部署脚本 `deploy.sh`（固定 `--tls-mode caddy`）。
它**不部署合约、不配置 MySQL、不填 `MK_DB_*`、不做链上节点登记，也不做店铺申请 / `registerShop`**。
全新机器上它会在节点部署阶段失败：`deploy-constants.json` 为空时 `deploy.sh` 在启动门禁直接拒绝；
即使常量已填，没有 MySQL 连接参数的 `.env` 也会让节点在 `initDb()` 处退出。
要得到能卖的店，先按「前置」准备，再按 `node/README.md` 完成节点登记与开店申请。

```bash
# ① 先看：余额、权限、账号里已有的机器与域名、域名注册前置 —— 只读，不花钱
node provision/cli.mjs check --provider aliyun --domain shop.example.com \
     --owner 0x你的节点主钱包 --email me@example.com

# ② 再算：报价 + 预算闸门 —— 仍然不花钱
node provision/cli.mjs plan  --provider aliyun --domain shop.example.com --buy \
     --owner 0x… --email me@example.com --max-monthly 60 --max-domain-year 90 --price-domain 70

# ③ 最后真下单：开机器（非中国大陆区域）→（需要时）买域名 → 建解析 → 装 Docker/容器 → Caddy 申请证书
node provision/cli.mjs up    --provider aliyun --domain shop.example.com --buy \
     --owner 0x… --email me@example.com --max-monthly 60 --max-domain-year 90 --price-domain 70

node provision/cli.mjs verify  --shop default    # 只复验节点 /healthz（不检查是否已有店铺）
node provision/cli.mjs destroy --shop default    # 释放机器（只尝试导出数据卷；MySQL 库要自己先 dump；域名保留）
```

`--max-domain-year` 是**买域名的单独授权**，要买就必须给。阿里云国际站的 `CheckDomain` 按 **USD**
报价，而本工具的额度只认**元**，所以买阿里云域名还必须用 `--price-domain <元/年>` 给一个你接受的
元价（示例 70 只是占位，不是报价）。AWS 买域名还要完整联系人：
`--contact-first-name` / `--contact-last-name` / `--contact-phone` / `--contact-address` /
`--contact-city` / `--contact-country` / `--contact-zip`（邮箱用 `--email`）。

**还没拿到 API key？** 跑 `node provision/cli.mjs providers` —— 它会打印每家的控制台入口、
该开哪些权限、以及要填哪两个环境变量（照着点一遍即可）。凭据没配好时跑 `check/plan/up`，
报错里也会带同一份走法。注意 `check` / `plan` **只看云账号、域名与预算**，不检查
`deploy-constants.json` 是否已填、也不检查目标机器的 MySQL/`.env`。

---

## 前置（缺一条，`up` 都不会产出可用店铺）

1. **合约常量**：在**完整仓库**用 `node scripts/deploy-mainnet.cjs` 部署/核验当批
   Escrow / Blocklist / Registry / Staking（脚本还会部署 ReviewNotary）并接线，然后把
   `deploy-constants.json` 的五项（`escrow` / `registry` / `blocklist` /
   `startBlock` = Escrow 部署块，不能是 0；`escrowCodeHash` = Escrow 运行时字节码的 keccak256，
   取值口径见该文件头）填好。
   部署/接线需要 `DEPLOYER_PRIVATE_KEY` 与 `ARBITERS`（至少一位，且不得是部署者/费用收取人）；
   复用已有 Escrow 的 `--skip-escrow` 与只读核验 `--verify-only` 还需要
   `MK_ESCROW_ADDRESS`（`--verify-only` 不需要私钥，但仍要解析 `ARBITERS`）。
   **provision 上传的是 `--rev` 指向的提交内容，不是工作区**：填好常量后要提交，未提交改动不会被发布。
   `deploy.sh` / `deploy.ps1` 在五项为空时拒绝执行（`--help` / `--dry-run` / `--status` 也一样）。
2. **MySQL 8**：provision **不安装、不配置数据库**，也没有传 `MK_DB_*` 的参数。
   `deployNodeScript` 只把 owner / domain / email 传给 `deploy.sh`（**install 模式，不带 `--update`**），
   所以常量已填的全新机器上，`up` 会在节点启动时失败。可行的补法：
   - **部署失败后人工补**：SSH 进机器，编辑 `<install-dir>/node/.env` 补上
     `MK_DB_HOST` / `MK_DB_PORT` / `MK_DB_USER` / `MK_DB_PASSWORD` / `MK_DB_NAME`，然后在那个目录跑
     `bash deploy.sh --update --yes`（这是 node 的脚本，不是 `provision up`）；成功后用 `provision verify` 复验。
   - **已有节点机器**：如果 `.env` 已配好、容器已在跑，不要重跑 `provision up`（install 模式会撞
     `deploy.sh` 的「容器已存在」）；用 `bash deploy.sh --update` 升级，或直接按 `node/README.md` 手工部署。
   - `--adopt` 只认领机器/续跑，不会生成 `.env`，也不会改变这条限制。
3. **账号与域名前置**：`check` 会读余额、域名列表，并尝试读信息模板/实名状态。信息模板未审核、余额不足、
   API 权限不足这些**仍可能要你去控制台办**——脚本只如实报告闸门，不会替你点。
   域名已在别处注册/解析时，`ensureZone` 会在本服务商建一个解析区并打印 NS；
   **必须到注册商把域名的 NS 改成这些值**，否则 `waitForDns` / Caddy / `verify` 会失败。
4. **TLS**：provision 固定调用 `deploy.sh --tls-mode caddy`（provision 自己**没有** `--tls-mode` 参数），
   因此目标机器需要 80/443 空闲、域名已解析到它；Caddy 由 `deploy.sh` 启动并申请证书。

---

## 支持哪几家

**阿里云（国际站）/ 腾讯云（国际站）/ AWS**。三家都能同时开出**非中国大陆的机器**与
**境外注册商的域名**，所以：

> **不需要 ICP 备案**，而且这不是一个配置项、是结构：机器只在非中国大陆区域，域名只走境外注册商
> （阿里云国际站 `domain-intl`、腾讯云国际站 `domain.intl`、AWS Route 53）—— 代码里没有中国站
> 注册商这条路径，所以"注册出一个需要备案的域名"不可表达（有测试盯着那三个端点）。
> 域名解析到那台境外机器、Caddy 直接申请 Let's Encrypt 证书，全程不需要备案。

法务上如实说一句：**托管于非中国内地服务器的网站无需工信部备案，但通常仍需完成公安联网备案**。
`check` 会把这两件事分开陈述，不会说成"什么都不用办"。

凭据**只从环境变量读**，不进命令行、不落盘、不打印：

| 服务商 | 环境变量 |
| --- | --- |
| 阿里云（国际站） | `ALIYUN_ACCESS_KEY_ID` + `ALIYUN_ACCESS_KEY_SECRET` |
| 腾讯云（国际站） | `TENCENTCLOUD_SECRET_ID` + `TENCENTCLOUD_SECRET_KEY` |
| AWS | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` |

`--region` 是**自由文本，不按白名单校验**：默认取各家列表里的第一个（阿里云/腾讯云是香港，
AWS 是新加坡），填错或该区域无货会在云 API 调用处失败，而不是在参数解析时被拦下。

---

## 三条与"钱"有关的设计，动手前先知道

1. **不给额度就不创建任何资源。** `--max-monthly` 是**支出授权**，不是提示；买域名还要单独给
   `--max-domain-year`。价格优先走各家**实时询价**；拿不到价时脚本**不猜**：机器价用
   `--price-server`，域名价用 `--price-domain`。阿里云国际站的域名报价固定 USD，闸门只认元，
   所以它必须有 `--price-domain` 才能过。`--dry-run` 的承诺是"绝不写任何东西"，
   要看价格与闸门结论请用 `plan`。
2. **中断了重跑同一条命令可续上云资源。** 状态落盘在 `.provision/<shop>.json`（已 gitignore）：
   机器/域名/DNS/密钥路径都记着，所以不会重复下单；账号里已经有可用的机器时，
   脚本会把它们**列出来**让你点名（`--adopt <实例ID>`）或换名字开新的，**不替你猜哪台**。
   `--adopt` 只解决"机器在账号里、状态没写成"这一种情况，不会附带数据库配置。
   注意：节点部署步骤会在机器上重跑 `deploy.sh`（install 模式）；**容器已经存在时它会以
   「容器 xxx 已存在」拒绝**——那之后要升级/重建请用 `bash deploy.sh --update`，不要重跑 `up` 的部署段。
3. **链上登记刻意不自动做，而且它只登记节点。** `registerNode` 要用节点主私钥（operator 权限等同
   私钥），这一步留给你在 [fedmall.bityuan.com](https://fedmall.bityuan.com) 的「开店/登记我的节点」
   用钱包签名完成。**节点登记不会创建店铺**：之后还要走「申请开店」的四步双签
   （店主申请 → 节点主/员工审批签票据 → 节点主/员工钱包广播 `registerShop` → 回传交易哈希核验），
   节点才会落 `shops` 行、`/api/shops` 才会有这家店。本工具两件都不做。

退出码是给脚本/AI 用的契约：`0` 成功 · `1` 运行期失败 · `2` 用法错 ·
**`3` 闸门拒绝**（预算不够 / 账号未就绪 / 权限缺失 / 密钥不对 —— 原样重跑不会变好）。

---

## 和自己动手装的区别

| | 自己有一台机器时（完整仓库 `node/deploy.sh`；发布公开节点仓根目录就是 `deploy.sh`） | 云上开店（`provision/`） |
| --- | --- | --- |
| 需要的输入 | 一台已存在的机器 + SSH 私钥 | 一把云 API key |
| 谁开机器/买域名 | 你在控制台点 | 脚本按预算闸门下单 |
| HTTPS | 你决定在哪终止 | 固定交给 `deploy.sh` 的 Caddy 容器（`--tls-mode caddy`；provision 没有这个参数） |
| 不做的部分 | 合约部署、MySQL、节点/店铺链上登记 | 同样不做，而且它没有传 `MK_DB_*` 的入口 |

两条路**共用同一个部署脚本**：完整仓库里是 `node/deploy.sh`，发布公开节点仓的根目录就是 `deploy.sh`。
provision 不重写部署逻辑，只把"机器与域名从哪来"这一段自动化；但**共用脚本不等于装出来就能卖**——
脚本需要的合约常量与数据库 `.env` 仍需你按「前置」准备好。
