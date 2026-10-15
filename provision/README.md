# 云上开店：给一把云 API key，把机器、域名、解析、HTTPS、节点一次做完

**这个目录解决的是"从零到一家能访问的店"里最烦的那一段**：你不需要先在控制台点出一台服务器、
再买域名、再配解析、再登上去装东西。给一把云 API key，剩下的由脚本按你的预算授权一次走完，
最后把 `https://你的域名` 交给你。

```bash
# ① 先看：余额、权限、账号里已有的机器与域名、域名注册前置 —— 只读，不花钱
node provision/cli.mjs check --provider aliyun --domain shop.example.com \
     --owner 0x你的店主钱包 --email me@example.com

# ② 再算：报价 + 预算闸门 —— 仍然不花钱
node provision/cli.mjs plan  --provider aliyun --domain shop.example.com --buy \
     --owner 0x… --email me@example.com --max-monthly 60 --max-domain-year 90

# ③ 最后真下单：开机器（非中国大陆区域）→（需要时）买域名 → 建解析 → 装 Docker/容器 → Caddy 申请证书
node provision/cli.mjs up    --provider aliyun --domain shop.example.com --buy \
     --owner 0x… --email me@example.com --max-monthly 60 --max-domain-year 90

node provision/cli.mjs verify  --shop default    # 复验（本机 + 公网 https）
node provision/cli.mjs destroy --shop default    # 释放机器（先导出数据卷；域名默认保留）
```

**还没拿到 API key？** 跑 `node provision/cli.mjs providers` —— 它会打印每家的控制台入口、
该开哪些权限、以及要填哪两个环境变量（照着点一遍即可）。凭据没配好时跑 `check/plan/up`，
报错里也会带同一份走法。

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

---

## 三条与"钱"有关的设计，动手前先知道

1. **不给额度就不创建任何资源。** `--max-monthly` 是**支出授权**，不是提示；买域名还要单独给
   `--max-domain-year`。价格优先走各家**实时询价**；拿不到价时脚本**不猜**（要么换一家能询价的，
   要么你自己用 `--price-server` 给出月成本）。`--dry-run` 的承诺是"绝不写任何东西"，
   要看价格与闸门结论请用 `plan`。
2. **中断了重跑同一条命令就是续跑。** 状态落盘在 `.provision/<shop>.json`（已 gitignore）：
   机器/域名/DNS/密钥路径都记着，所以不会重复下单；账号里已经有可用的机器时，
   脚本会把它们**列出来**让你点名（`--adopt <实例ID>`）或换名字开新的，**不替你猜哪台**。
3. **链上登记刻意不自动做。** `registerNode` 要用店主私钥（operator 权限等同私钥），
   这一步留给你在 [fedmall.bityuan.com](https://fedmall.bityuan.com) 的「开店/登记我的节点」
   用钱包签名完成 —— 脚本结束时会把该登记的地址打出来。

退出码是给脚本/AI 用的契约：`0` 成功 · `1` 运行期失败 · `2` 用法错 ·
**`3` 闸门拒绝**（预算不够 / 账号未实名 / 权限缺失 / 密钥不对 —— 原样重跑不会变好）。

---

## 和自己动手装的区别

| | 自己有一台机器时（仓库根的 `deploy.sh`） | 云上开店（`provision/`） |
| --- | --- | --- |
| 需要的输入 | 一台已存在的机器 + SSH 私钥 | 一把云 API key |
| 谁开机器/买域名 | 你在控制台点 | 脚本按预算闸门下单 |
| HTTPS | 你决定在哪终止 | 本机 Caddy 自动申请并续期（`--tls-mode caddy`） |
| 适合 | 已经有机器、或想自己掌控 | 从零开始，或想一条命令走完 |

两条路**共用同一个部署脚本**（仓库根的 `deploy.sh`）：`provision` 不重写部署逻辑，
它只是把"机器与域名从哪来"这一段也自动化了 —— 所以部署出来的东西与手工装的一模一样。
