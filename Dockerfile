# BitYuan 联邦商城节点 —— 单店铺 API 服务（容器镜像）
#
# 构建（context = node/ 目录）：
#     docker build -t marketplace-node .
# 运行（数据必须在卷里，容器本身无状态）：
#     docker run -d --name marketplace-node --restart unless-stopped \
#       -p 127.0.0.1:8090:8090 --env-file /opt/marketplace-node/.env \
#       -v marketplace-node-data:/data marketplace-node
# 一键做完上面这些（含 Docker 安装、HTTPS、可选链上登记）：bash deploy.sh
#
# 基础镜像选 **Debian slim**（不是 alpine），原因很具体：
#   · 节点零原生依赖（express/cors/ethers 全是纯 JS），不需要编译工具链，slim 够用；
#   · 容器里要以非 root 运行，需要把 /data 的属主交给 node 用户再降权 —— Debian 自带的
#     util-linux `setpriv` 支持 `--reuid/--regid`，**一个包都不用装**；
#     而 Alpine 的 busybox setpriv 不支持 --reuid，只能额外装 su-exec，而"装包"要连 Alpine CDN
#     （实测有服务器连不上 dl-cdn.alpinelinux.org，于是 docker build 卡死十分钟）。
#   · 结论：**构建过程中除了基础镜像与 npm 依赖之外不下载任何东西**，网络依赖面最小。
FROM node:24-slim

WORKDIR /app

# 先装依赖：package*.json 不变时这一层命中缓存，改代码不会重装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 应用代码；scripts/ 也要进镜像 —— `--register` / 对账 / 体检这些运维动作都是在容器里跑
# `node scripts/xxx.js`，镜像里没有它就只能回宿主装 Node，那正是要避免的
COPY src ./src
COPY scripts ./scripts
COPY .env.example ./.env.example
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
# 数据默认落在卷 /data（SQLite 单文件 + WAL，可热备份）
ENV MK_DB_FILE=/data/marketplace-node.db
ENV MK_ATTACH_DIR=/data/attachments
ENV MK_PORT=8090

VOLUME ["/data"]
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MK_PORT||8090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 入口脚本负责"把 /data 交给 node 用户再降权"（见 docker-entrypoint.sh 的说明）；
# 配置来自 `docker --env-file`，容器里没有 .env 时入口脚本也不会去读（避免误导性日志）
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
