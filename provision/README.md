# 云上部署节点

`provision/cli.mjs` 用云 API 完成：购买/复用服务器 → 域名 → DNS → HTTPS → 调用 `deploy.sh` 装节点。

它不部署合约，也不做链上节点登记；节点装好后由钱包完成登记。开店是节点本地申请，不产生链上交易。

## 前置

- 阿里云国际站、腾讯云国际站或 AWS 的 API 凭据（只从环境变量读）；
- 一个域名，或允许脚本购买域名；
- 节点主钱包地址、邮箱；
- 账户已完成实名/付款方式等云厂商要求。

凭据变量：

```text
ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET
TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY
AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
```

## 命令

```bash
# 只读检查：余额、权限、已有服务器/域名
node provision/cli.mjs check --provider aliyun --domain shop.example.com \
  --owner 0x节点主钱包 --email you@example.com --json

# 报价 + 预算闸门；不创建资源
node provision/cli.mjs plan --provider aliyun --domain shop.example.com --buy \
  --owner 0x节点主钱包 --email you@example.com \
  --max-monthly 60 --max-domain-year 90

# 真正创建：机器 → 域名（可选）→ 解析 → Docker → Caddy → 节点
node provision/cli.mjs up --provider aliyun --domain shop.example.com --buy \
  --owner 0x节点主钱包 --email you@example.com \
  --max-monthly 60 --max-domain-year 90

# 复验
node provision/cli.mjs verify --shop default

# 释放机器（域名默认保留）
node provision/cli.mjs destroy --shop default
```

`--max-monthly` 和 `--max-domain-year` 是支出授权，不是提示；超过预算会拒绝下单。AWS 没有可用询价接口时需要显式 `--price-server`，脚本不猜价格。

## 结果

- 机器只放在非中国大陆区域，域名走境外注册商，不需要 ICP 备案；
- Caddy 自动申请/续期 HTTPS；
- `deploy.sh` 默认自动部署 MySQL 容器；也可以传 `--db-mode external` 等参数使用已有 MySQL；
- 状态保存在 `.provision/<shop>.json`（已忽略，不进 Git），重复运行是续跑，不会重复下单；
- 安装完成后，脚本打印节点地址；到 https://fedmall.bityuan.com 完成节点登记和开店申请。

## 安全

- API 凭据只放环境变量，不写命令行、不进仓库；
- 云账号建议单独授权，只给创建/释放本工具所需资源的最小权限；
- `destroy` 前先导出节点数据卷和 MySQL 备份。
