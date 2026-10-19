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
cd /opt/marketplace-node
docker exec -e MYSQL_PWD="$(cat .mysql-root)" <service>-mysql \
  mysqldump -uroot --single-transaction --routines --triggers <db_name> \
  | gzip > "node-db-$(date +%F).sql.gz"
```

外部 MySQL：

```bash
mysqldump -h <host> -u <user> -p --single-transaction --routines --triggers <db> \
  | gzip > "node-db-$(date +%F).sql.gz"
```

### 2.2 附件与商品媒体

```bash
docker run --rm -v <service>-data:/data -v "$PWD":/backup --entrypoint tar \
  marketplace-node:latest czf /backup/node-data-$(date +%F).tar.gz -C /data .
```

### 2.3 要一起保存的文件

- 安装目录 `.env`（含 `MK_TOKEN_SECRET`，丢了会导致所有登录失效）；
- 内置 MySQL 的 `.mysql-root`；
- `deploy-constants.json`（合约批次）；
- 上面两份备份。

## 3. 恢复

先停节点：

```bash
docker stop <service>
```

数据库：

```bash
gunzip -c node-db-YYYY-MM-DD.sql.gz | \
  docker exec -i -e MYSQL_PWD="$(cat .mysql-root)" <service>-mysql mysql -uroot <db>
```

附件：

```bash
docker run --rm -v <service>-data:/data -v "$PWD":/backup --entrypoint tar \
  marketplace-node:latest xzf /backup/node-data-YYYY-MM-DD.tar.gz -C /data
```

再启动：

```bash
docker start <service>
curl http://127.0.0.1:8090/healthz
```

## 4. 升级与回滚

```bash
bash deploy.sh --update
```

会拉取/复制最新代码、重建镜像、用同一个数据卷和同一套 MySQL 重建容器。数据不动。新容器健康检查失败时脚本会自动回滚到上一个镜像。

手动回滚：

```bash
docker images | grep marketplace-node
docker tag <上一个镜像> marketplace-node:latest
bash deploy.sh --update
```

## 5. 数据库结构

节点启动时会把期望 schema 在临时库里执行一遍，再与真实库逐项对拍。缺列、缺索引、缺触发器、排序规则不符都会拒绝启动，并打印可执行的修复 SQL。

不要手工改表来“先跑起来”。先备份，再按输出修复；或重建库并重新导入商品/订单。

## 6. 安全

- `.env` 和 `.mysql-root` 权限保持 `0600`，不要进 Git、不要贴聊天。
- MySQL 只允许节点容器访问，不要对公网开放 3306。
- 公网只暴露 HTTPS；反向代理后设置 `MK_TRUST_PROXY=1`，否则来源 IP 会记成代理地址。
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
