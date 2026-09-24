#!/bin/sh
#
# 容器入口脚本：把数据卷的属主交给 node，再降权执行。
#
# 为什么需要它（而不是直接 `CMD node src/server.js`）：节点要以**非 root** 运行，但 `/data`
# 这个卷（named volume 或 bind mount）刚被 Docker 建出来时属主通常是 root，SQLite 一写就
# `SQLITE_READONLY`/`EACCES`。所以：以 root 启动时先把数据目录交给镜像里的 `node` 用户（uid 1000），
# 再用 setpriv 降权执行真正的命令；以非 root 启动（例如 `--user 1000:1000`）就直接执行。
#
# 为什么用 setpriv 而不是 su-exec / gosu：那两个都要额外装包，而**装包就得连镜像源的 CDN**——
# 实测有机器连不上 dl-cdn.alpinelinux.org，于是 `docker build` 卡死十分钟（这就是把基础镜像
# 换成 Debian slim 的原因：它自带的 util-linux setpriv 就支持 --reuid/--regid，一个包都不用装）。
# 注意：Alpine 的 busybox setpriv **不支持** --reuid，所以这个入口脚本与 Debian 基础镜像是配套的。
set -e

# 容器里若自带 .env（挂载进来的、或本地 docker build 后手工放的），让 Node 读它；
# 没有就不加这个开关 —— 之前把 --env-file-if-exists 写死在 CMD 里，每次启动都会打印
# 一行 ".env not found. Continuing without it."，而部署时配置是由 `docker --env-file` 注入的，
# 这行日志对店主纯属误导（看起来像"配置没加载"）。
if [ -f .env ] && [ "${1:-}" = "node" ] && [ "${2:-}" = "src/server.js" ]; then
  shift
  set -- node --env-file=.env "$@"
fi

if [ "$(id -u)" = "0" ]; then
  data_root="/data"
  mkdir -p "$data_root"
  owner="$(stat -c '%u' "$data_root" 2>/dev/null || echo '')"
  if [ "$owner" != "$(id -u node)" ]; then
    chown node:node "$data_root"
    echo "[entrypoint] /data 属主已交给 node（原 uid=${owner:-未知}）"
  fi
  # 附件目录可能被配到 /data 之外（那时运维要自己挂卷并保证可写），这里只保证默认路径可用
  if [ -n "${MK_ATTACH_DIR:-}" ] && [ "${MK_ATTACH_DIR#/data/}" != "$MK_ATTACH_DIR" ]; then
    mkdir -p "$MK_ATTACH_DIR"
    chown node:node "$MK_ATTACH_DIR"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
