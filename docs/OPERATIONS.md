# 节点运维

本文只写日常会用到的操作。配置项见 `.env.example`，部署选项见 `bash deploy.sh --help`。

## 1. 健康与日志

```bash
bash deploy.sh --status       # 容器、数据卷、MySQL
bash deploy.sh --health       # 健康：一行；不健康才带原因
docker logs -f marketplace-node
```

`/healthz` 返回 200 且 `code=0` 才算健康。链上 watcher 停滞、数据库不可用、schema 不符都会让它返回非 0。

## 2. 备份

### 2.1 数据库

内置 MySQL：

```bash
cd /opt/marketplace-node  # 普通用户安装目录为 $HOME/marketplace-node
DB="$(sed -n 's/^MK_DB_NAME=//p' .env)"
docker exec -e MYSQL_PWD="$(cat .mysql-root)" marketplace-node-mysql \
  mysqldump -uroot --single-transaction --routines --triggers "$DB" \
  | gzip > "node-db-$(date +%F).sql.gz"
```

`bash deploy.sh --update` 在重建容器前也会对内置 MySQL 自动落一份
`db-backup-<UTC 时间>.sql.gz`（备份失败会明确告警，不假装备份成功）。外部 MySQL 仍按下文手动备份。

外部 MySQL：

```bash
mysqldump -h <host> -u <user> -p --single-transaction --routines --triggers <db> \
  | gzip > "node-db-$(date +%F).sql.gz"
```

### 2.2 附件与商品媒体

```bash
docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup --entrypoint tar \
  marketplace-node:latest czf /backup/node-data-$(date +%F).tar.gz -C /data .
```

### 2.3 要一起保存的文件

- 安装目录 `.env`（含 `MK_TOKEN_SECRET`，丢了会导致所有登录失效）；
- 内置 MySQL 的 `.mysql-root`；
- `deploy-constants.json`（合约批次）；
- 上面两份备份。

## 3. 恢复

先停节点；如果是换机器，先把备份的 `.env` 与 `.mysql-root` 放回安装目录：

```bash
docker stop marketplace-node
```

数据库：

```bash
DB="$(sed -n 's/^MK_DB_NAME=//p' .env)"
gunzip -c node-db-YYYY-MM-DD.sql.gz | \
  docker exec -i -e MYSQL_PWD="$(cat .mysql-root)" marketplace-node-mysql mysql -uroot "$DB"
```

附件：

```bash
docker run --rm -v marketplace-node-data:/data -v "$PWD":/backup --entrypoint tar \
  marketplace-node:latest xzf /backup/node-data-YYYY-MM-DD.tar.gz -C /data
```

再启动：

```bash
docker start marketplace-node
curl http://127.0.0.1:8090/healthz
```

## 4. 升级与回滚

```bash
bash deploy.sh --update
```

会重建镜像，用同一个数据卷和同一套 MySQL 重建容器，数据不动。`--update` 默认只用安装目录里的代码；要拉公开仓最新版用 `--update --pull`，或重新跑一遍 `install.sh`。新容器健康检查失败时脚本会自动回滚到上一个镜像；回滚也失败时看上面的日志手工介入。

## 5. 数据库结构

节点启动时会把期望 schema 在临时库里执行一遍，再与真实库逐项对拍。缺列、缺索引、缺触发器、排序规则不符都会拒绝启动，并打印可执行的修复 SQL。

不要手工改表来“先跑起来”。先备份，再按输出修复；或重建库并重新导入商品/订单。

## 6. 安全

- `.env` 和 `.mysql-root` 权限保持 `0600`，不要进 Git、不要贴聊天。
- MySQL 只允许节点容器访问，不要对公网开放 3306。
- 公网只暴露 HTTPS；反向代理后按拓扑设置 `MK_TRUST_PROXY`：宿主 nginx 用 `loopback`，Caddy/Docker 反代用代理所在网段（如 `172.16.0.0/12`）。**不要填 `1`**——配置层只接受空、`loopback` 或 IP/CIDR，填 1 会拒绝启动。
- `MK_CORS_ORIGIN` 只填实际前端域名；不要在生产用 `*`。
- 节点主私钥只用于钱包签名，不写入服务器。

## 7. 个人信息

`MK_PII_RETENTION_DAYS` 控制终局订单的收货信息保留期（默认 180 天，0 = 关闭）。到期自动擦除，不可逆。备份里仍可能含旧个人信息，需要按自己的保留策略清理备份。

## 8. 卸载

```bash
bash deploy.sh --uninstall   # 移除节点容器，保留数据卷和 MySQL 数据
bash deploy.sh --purge       # 连数据卷一起删（不可逆）
```

`--purge` 会删除节点附件卷和内置 MySQL 数据卷；确认备份已经做完。
