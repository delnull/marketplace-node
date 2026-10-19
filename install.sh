#!/usr/bin/env bash
# 一行安装入口：下载完整节点包 → 用包内的 deploy.sh 安装/升级。
# 之所以不直接 curl deploy.sh：它还需要同目录的 platform.sh、deploy-constants.json、
# Dockerfile 等文件，单独下载一个脚本会缺文件。
set -Eeuo pipefail

SRC_TARBALL="${MK_NODE_TARBALL:-https://codeload.github.com/delnull/marketplace-node/tar.gz/refs/heads/main}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/marketplace-node-src.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

if ! command -v curl >/dev/null 2>&1; then
  printf '%s\n' '[install.sh] 需要 curl' >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  printf '%s\n' '[install.sh] 需要 tar' >&2
  exit 1
fi

printf '%s\n' "[install.sh] 下载节点包…"
if ! curl -fsSL --max-time 120 "$SRC_TARBALL" | tar -xz -C "$TMP" --strip-components=1; then
  printf '%s\n' '[install.sh] 下载/解压失败（检查网络或代理）' >&2
  exit 1
fi
[ -f "$TMP/deploy.sh" ] || { printf '%s\n' '[install.sh] 节点包内容不完整' >&2; exit 1; }

# 用户显式给了 --dir 就尊重；否则 root 用 /opt，普通用户用 $HOME（避免 sudo 写目录问题）。
has_dir=0
for a in "$@"; do
  [ "$a" = "--dir" ] && has_dir=1
done
args=("$@")
if [ "$has_dir" = 0 ]; then
  if [ "$(id -u)" = 0 ]; then dir=/opt/marketplace-node; else dir="$HOME/marketplace-node"; fi
  args+=(--dir "$dir")
fi

bash "$TMP/deploy.sh" "${args[@]}"
