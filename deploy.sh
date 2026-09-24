#!/usr/bin/env bash
# =============================================================================
#  联邦商城 · 开店节点一键部署（fedmall.bityuan.com）—— **Docker 版**
#
#  一条命令把你这台服务器变成联邦商城的一家店：装 Docker（若没有）→ 构建镜像 →
#  建数据卷 → 起容器 → 探活 →（可选）链上登记。
#
#  ── 为什么只用 Docker ──────────────────────────────────────────────────────
#  上一版是"在宿主机上装"：装 Node 到 /usr/local、写 systemd 单元、装 nginx/certbot。
#  宿主环境是最不可控的变量：发行版不同、包管理器不同、可能已经有别人的服务在跑、
#  还可能把别人依赖的运行时顺手升掉。改成容器后：
#      · 不再往宿主机装任何运行时（Node 只在镜像里）；
#      · 不依赖 init 系统（开机自启用 Docker 的 `--restart unless-stopped`）；
#      · 数据在**命名卷**里 —— 容器可以随时删掉重建（升级就是换镜像），搬家就是导出/导入卷。
#  宿主上只多三样东西：Docker（若原本没有）、一个数据卷、（可选）一个反向代理容器。
#
#  ── HTTPS 怎么给（运行时会让你选）──────────────────────────────────────────
#  联邦前端是 https，浏览器会拦掉到 http 节点的请求，所以节点对外必须是 https：
#    1) Caddy 容器（推荐）：全容器、自动申请与续期 Let's Encrypt，宿主不装任何东西
#    2) 宿主 nginx + certbot：和上一版一样（宿主会被装 nginx 与 certbot）
#    3) 不配 TLS：节点只监听端口，TLS 由外部（负载均衡 / 已有反向代理）终止
#
#  ── 用法 ───────────────────────────────────────────────────────────────────
#      bash deploy.sh                      # 交互式：问域名/邮箱/店主地址
#      bash deploy.sh --owner 0x… --domain shop.example.com --email me@x.com
#      bash deploy.sh --tls-mode caddy|nginx|none       # 跳过 TLS 选择
#      bash deploy.sh --dry-run            # 只打印计划，什么都不改（含"要不要装 Docker"）
#      bash deploy.sh --status | --health | --update | --register | --uninstall
#      bash deploy.sh --update --pull      # 升级（并强制从公开仓拉最新代码）
#      bash deploy.sh --purge              # 卸载并**删除数据卷**（不可逆，需二次确认）
#      bash deploy.sh --help
#
#  ── 可选参数 ───────────────────────────────────────────────────────────────
#      --port 8090                       对外暴露的端口（容器内固定 8090）
#      --bind 127.0.0.1                  发布到哪个宿主地址（默认：配了 TLS→127.0.0.1，不配 TLS→0.0.0.0）
#      --dir /opt/marketplace-node       代码/配置/Caddyfile/状态文件所在目录
#      --service marketplace-node        容器名与服务名（同机开第二家店必须换）
#      --volume marketplace-node-data    数据卷名（同机开第二家店必须换）
#      --image marketplace-node:latest   镜像名:标签
#      --key-file /path/key              登记用私钥文件（默认交互粘贴）
#      --no-register / --no-domain       跳过登记 / 先不配域名
#      --pull                            --update 时强制从公开仓拉最新代码（没有 git 的安装用）
#      --yes / --force                   不交互 / 覆盖同名容器
#
#  ── 关于私钥 ───────────────────────────────────────────────────────────────
#  链上登记必须用**店主本人的私钥**签名（registerNode 的 operator 就是你）。粘贴方式下私钥
#  只经标准输入进容器、随容器一起销毁：**宿主磁盘上不落任何文件**。之后也可以随时到
#  https://fedmall.bityuan.com →「开店/登记我的节点」用钱包插件完成登记（推荐）。
#  登记要花一点点 BTY 当 gas（约 0.001 BTY 量级），钱包里留 0.01 BTY 就够。
# =============================================================================
set -Eeuo pipefail

FRONTEND='https://fedmall.bityuan.com'
# 本联邦的共享合约（2026-09-23 部署到 BTY EVM 主网）；店主不需要填、也不该改
ESCROW='0x820d7ae8fe55ba66d4a1eef2186c4548c85a5908'
REGISTRY='0xce47d45fc94e774e479f34a406e84d086f999085'
START_BLOCK=47487268
RPC_URL='https://mainnet.bityuan.com/eth'
CHAIN_ID=2999
CONTAINER_PORT=8090
CADDY_IMAGE='caddy:2-alpine'
# 取源码用（只在"宿主机没有源码也没有 git"时启用；见 ② 取代码）
SRC_REPO='https://github.com/delnull/marketplace-node.git'
SRC_TARBALL='https://codeload.github.com/delnull/marketplace-node/tar.gz/refs/heads/main'
# 兜底下载源码用的镜像：用**构建镜像的同一个基础镜像**（本地没有就拉一次，之后复用）
BASE_IMAGE='node:24-slim'
KEEP_SECRET=''

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN_REPO=0; [ -f "$HERE/package.json" ] && [ -f "$HERE/src/server.js" ] && IN_REPO=1

MODE=install
DRY_RUN=0; ASSUME_YES=0; FORCE=0; NO_REGISTER=0; NO_DOMAIN=0; PULL=0
OWNER=''; DOMAIN=''; EMAIL=''; KEY_FILE=''; PORT=''; DIR=''; SERVICE=''; VOLUME=''; IMAGE=''
TLS_MODE=''; DIR_GIVEN=0; KEY_INPUT=''; BIND=''

while [ $# -gt 0 ]; do
  case "$1" in
    --owner) OWNER="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --key-file) KEY_FILE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; DIR_GIVEN=1; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --volume) VOLUME="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --tls-mode) TLS_MODE="${2:-}"; shift 2 ;;
    --no-tls) TLS_MODE=none; shift ;;
    # 发布到哪个宿主地址：默认跟着 TLS 方式走（配了 TLS 就只绑本机，让本机反代访问；
    # 不配 TLS 就绑 0.0.0.0，因为外部负载均衡要从**私网 IP** 连进来，绑 127.0.0.1 它就连不上）。
    # 需要收紧时显式指定，例如同机已有 nginx 反代：--bind 127.0.0.1
    --bind) BIND="${2:-}"; shift 2 ;;
    --no-register) NO_REGISTER=1; shift ;;
    --no-domain) NO_DOMAIN=1; shift ;;
    --pull) PULL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --status|--health|--update|--register|--uninstall|--purge) MODE="${1#--}"; shift ;;
    -h|--help) MODE=help; shift ;;
    *) printf '未知参数：%s（bash deploy.sh --help）\n' "$1" >&2; exit 2 ;;
  esac
done

# ── 输出 ──
c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log()  { printf '%s\n' "$*"; }
info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '%s!%s %s\n' "$c_warn" "$c_off" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$c_err" "$*" "$c_off" >&2; exit 1; }
step() { printf '\n%s── %s ──%s\n' "$c_dim" "$*" "$c_off"; }
# 交互提问。stdin 不是终端时**绝不空等**：有默认值就用默认值，没有就直接报错并给出对应参数。
# （踩过的坑：ssh 里不带 -t 跑、或 curl | bash 时，read 会永久阻塞，表现为"脚本卡住不动"，
#   现场完全看不出是卡在提问上 —— 没人盯着终端时这不叫交互，叫挂死。）
# 写法提醒：默认值请写 '' 或 'x'，**别写 ' '（单个空格）** —— "单空格引号 + 紧跟另一个引号参数"
# 会让 bash 报 unmatched quote（实测 bash 4/5 都一样），而且空格默认值本身就是脏数据。
TTY=0; [ -t 0 ] && TTY=1
ask() {
  local p="$1" d="${2:-}" hint="${3:-}" a=''
  if [ "$TTY" = 0 ]; then
    if [ -n "$d" ]; then warn "非交互环境（stdin 不是终端）：${hint:-该项} 采用默认值 $d"; printf '%s' "$d"; return 0; fi
    die "非交互环境（stdin 不是终端），无法询问${hint:+「$hint」} —— 请用参数直接指定（bash deploy.sh --help）"
  fi
  printf '%s' "$p" >&2; IFS= read -r a || true; printf '%s' "${a:-$d}"
}

# 从已有 .env 里取值：**必须去掉行尾的 \r 与首尾空白**。这个文件可能是别的工具写的
# （上一版的 PowerShell 部署器写出来的就是 CRLF），而 `cut -d= -f2-` 会把那个 \r 当成值的一部分——
# 实测把 `MK_SIWE_DOMAIN=`（本意是空）读成了 "\r"，于是 CORS 白名单里多出一条 `https://` 的垃圾项。
# 所以凡是从这个文件回读的值（店主地址、域名、令牌密钥、TTL、保留的额外键），一律走这个函数。
env_val() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true; }

# ── Docker 访问（能用就直接用，不能就用 sudo）──
SUDO=()
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO=(sudo); fi
dk() { "${SUDO[@]}" docker "$@"; }
have() { command -v "$1" >/dev/null 2>&1; }
as_root() { "${SUDO[@]}" "$@"; }

# --help 只打印文件头那段注释（不能写死行号：上一版按 '2,57p' 取行，头部一改就把下面的
# 代码行也当帮助打出来了 —— 用"遇到第一行非注释就停"的规则，头部怎么改都不会漏出代码）
if [ "$MODE" = help ]; then
  awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  exit 0
fi
case "$MODE" in status|health|update|register|uninstall|purge) ;; *) MODE=install ;; esac
[ "$MODE" = update ] && NO_REGISTER=1

# ── 目录/名字/端口的默认值 ──
if [ "${DIR_GIVEN}" = 0 ]; then
  if [ "$IN_REPO" = 1 ]; then DIR="$HERE"
  elif [ "$(id -u)" -eq 0 ] || { [ ${#SUDO[@]} -gt 0 ] && sudo -n true 2>/dev/null; }; then DIR='/opt/marketplace-node'
  else DIR="$HOME/marketplace-node"; fi
fi
STATE_FILE="$DIR/.deploy-state"
# 已有安装优先沿用状态文件里的名字/端口（--update/--status/--uninstall 不必重复给）
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  [ -n "${STATE_SERVICE:-}" ] && [ -z "$SERVICE" ] && SERVICE="$STATE_SERVICE"
  [ -n "${STATE_PORT:-}" ] && [ -z "$PORT" ] && PORT="$STATE_PORT"
  [ -n "${STATE_VOLUME:-}" ] && [ -z "$VOLUME" ] && VOLUME="$STATE_VOLUME"
  [ -n "${STATE_TLS:-}" ] && [ -z "$TLS_MODE" ] && TLS_MODE="$STATE_TLS"
  # 邮箱没有对应的 .env 键（证书在 Caddy/宿主 nginx 那一侧），只能记在状态文件里：
  # 不记的话 --update --yes 每次都会把 Caddyfile 的 email 写成占位地址。
  [ -n "${STATE_EMAIL:-}" ] && [ -z "$EMAIL" ] && EMAIL="$STATE_EMAIL"
  # 绑定地址同理：不记住的话，给 nginx 用的 --bind 127.0.0.1 会在下次 --update 时
  # 悄悄退回默认的 0.0.0.0（把节点暴露到所有网卡上——安全性的倒退不能靠人记得加参数）
  [ -n "${STATE_BIND:-}" ] && [ -z "$BIND" ] && BIND="$STATE_BIND"
fi
SERVICE="${SERVICE:-marketplace-node}"
PORT="${PORT:-8090}"
VOLUME="${VOLUME:-${SERVICE}-data}"
CONTAINER="$SERVICE"
CADDY_CONTAINER="${SERVICE}-caddy"
NETWORK="${SERVICE}-net"
CADDY_DATA="${SERVICE}-caddy-data"
CADDY_CONFIG="${SERVICE}-caddy-config"
IMAGE="${IMAGE:-marketplace-node:latest}"
ENV_FILE="$DIR/.env"
UNIT_LEGACY="/etc/systemd/system/$SERVICE.service"

# =============================================================================
# ① 环境检测的横幅对 --health **不打**：那个模式是给监控/cron 用的，输出必须只有一行结论
# （多几行就会把"看一行就知道死没死"这件事毁掉）。--status 保留横幅，它本来就是给人看的。
if [ "$MODE" != health ]; then
  step "① 环境检测"
  [ "$(uname -s)" = Linux ] || die "本脚本面向 Linux 服务器（当前：$(uname -s)）"
  info "系统：$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -sr ) / $(uname -m)"
  info "目录：$DIR    容器：$SERVICE    端口：$PORT    数据卷：$VOLUME"
else
  [ "$(uname -s)" = Linux ] || die "本脚本面向 Linux 服务器（当前：$(uname -s)）"
fi

ensure_docker() {
  if have docker && dk info >/dev/null 2>&1; then
    ok "Docker 可用：$(dk --version 2>/dev/null | awk '{print $3}')（守护进程正常）"
    return 0
  fi
  step "安装 / 启动 Docker"
  if [ "$DRY_RUN" = 1 ]; then
    if have docker; then info "[dry-run] 将启动 Docker 守护进程"
    else info "[dry-run] 将按发行版安装 Docker（apt/dnf/apk/pacman/zypper，兜底用官方 get.docker.com 脚本）"; fi
    return 0
  fi
  if ! have docker; then
    if have apt-get; then
      info "apt-get 安装 docker.io …"
      as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io
    elif have dnf; then
      info "dnf 安装 docker …"; as_root dnf install -y -q docker || as_root dnf install -y -q docker-ce
    elif have yum; then
      info "yum 安装 docker …"; as_root yum install -y -q docker || as_root yum install -y -q docker-ce
    elif have apk; then
      info "apk 安装 docker …"; as_root apk add --no-cache docker
    elif have pacman; then
      info "pacman 安装 docker …"; as_root pacman -Sy --noconfirm docker
    elif have zypper; then
      info "zypper 安装 docker …"; as_root zypper --non-interactive install docker
    else
      # 兜底：官方便捷脚本（覆盖上面没列到的发行版；它会自己加软件源并装 docker-ce）
      have curl || die "既没有已知的包管理器，也没有 curl，无法自动安装 Docker —— 请手动安装后重跑"
      warn "未识别的发行版：改用 Docker 官方脚本安装（curl -fsSL https://get.docker.com | sh）"
      curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || die "下载 Docker 安装脚本失败（出网受限？）"
      as_root sh /tmp/get-docker.sh || die "Docker 官方脚本安装失败（看上面的输出）"
      rm -f /tmp/get-docker.sh
    fi
    have docker || die "安装后仍找不到 docker —— 请手动安装后重跑（https://docs.docker.com/engine/install/）"
  fi
  # 启动守护进程（systemd / service / openrc 三种都试一遍，装完不一定自动起）
  as_root systemctl enable --now docker >/dev/null 2>&1 \
    || as_root service docker start >/dev/null 2>&1 \
    || as_root rc-service docker start >/dev/null 2>&1 \
    || true
  local i
  for i in $(seq 1 20); do dk info >/dev/null 2>&1 && break; sleep 1; done
  dk info >/dev/null 2>&1 || die "Docker 守护进程没起来（看 journalctl -u docker / tail /var/log/docker.log）"
  ok "Docker 已就绪：$(dk --version 2>/dev/null | awk '{print $3}')"
  if [ "$(id -u)" -ne 0 ]; then
    local target="${SUDO_USER:-$(id -un)}"
    if ! id -nG "$target" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
      as_root usermod -aG docker "$target" >/dev/null 2>&1 || true
      warn "已把 $target 加入 docker 组 —— **重新登录一次**之后才不用 sudo（本次部署继续用 sudo）"
    fi
  fi
}

# ── 旧版（宿主安装）的残留：只提示，不自动删（那是回滚点，也可能是别人的东西）──
check_legacy_host_install() {
  if [ -f "$UNIT_LEGACY" ]; then
    warn "检测到宿主机上还有旧版的 systemd 单元 $UNIT_LEGACY（上一版是宿主安装）——"
    warn "  本脚本不再使用它。容器版跑通后可自行清理："
    warn "    sudo systemctl disable --now $SERVICE && sudo rm -f $UNIT_LEGACY && sudo systemctl daemon-reload"
  fi
  if have node; then
    info "宿主机上已有 Node（$(node -v 2>/dev/null)）——本脚本不需要它，也不会改动它"
  fi
}

if [ "$MODE" != status ] && [ "$MODE" != health ] && [ "$MODE" != uninstall ] && [ "$MODE" != purge ]; then
  ensure_docker
  check_legacy_host_install
fi

# =============================================================================
# 只读：--status / --health
# =============================================================================
if [ "$MODE" = status ] || [ "$MODE" = health ]; then
  have docker || { warn "这台机器上没有 docker —— 节点不可能在跑（或它是旧版的宿主安装）"; exit 2; }

  # --health 只回答"活着吗"：一行状态 + 探活结果，适合喂监控/cron（不健康 exit 2）。
  # 想看容器/卷/配置/最近日志的细节请用 --status —— 两者用途不同，别混成一段输出。
  if [ "$MODE" = health ]; then
    STATE="$(dk inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}无healthcheck{{end}}' "$CONTAINER" 2>/dev/null || echo '容器不存在')"
    BODY="$(curl -s -m 8 "http://127.0.0.1:$PORT/healthz" || true)"
    if printf '%s' "$BODY" | grep -q '"code":0'; then
      ok "健康：容器 $STATE；探活 $(printf '%s' "$BODY" | grep -o '"code":[0-9]*' | head -1)；$(printf '%s' "$BODY" | grep -o '"cursor":[0-9]*' | head -1) $(printf '%s' "$BODY" | grep -o '"lagBlocks":[0-9]*' | head -1)"
      exit 0
    fi
    warn "不健康：容器 $STATE；探活 ${BODY:-失败}"
    dk logs --tail 15 "$CONTAINER" 2>&1 | sed 's/^/    /' || true
    exit 2
  fi

  step "节点现状"
  dk ps -a --filter "name=^${CONTAINER}\$" --format '  容器：{{.Names}}  状态：{{.Status}}  镜像：{{.Image}}  端口：{{.Ports}}'
  dk volume inspect "$VOLUME" --format '  数据卷：{{.Name}}' 2>/dev/null || warn "数据卷 $VOLUME 不存在"
  if [ -f "$ENV_FILE" ]; then
    info "配置：$ENV_FILE（$(grep -c . "$ENV_FILE") 行；密钥不在脚本这一侧）"
    grep -E '^(MK_PORT|MK_SHOP_OWNER|MK_ESCROW_START_BLOCK|MK_CORS_ORIGIN|MK_BTY_TTL_MS|MK_RATES_TTL_MS)=' "$ENV_FILE" | sed 's/^/    /' || true
  else
    warn "配置不存在：$ENV_FILE"
  fi
  if dk ps --filter "name=^${CONTAINER}\$" --format '{{.Names}}' | grep -q .; then
    info "健康状态：$(dk inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}（无 healthcheck）{{end}}' "$CONTAINER" 2>/dev/null)"
    info "最近日志："
    dk logs --tail 20 "$CONTAINER" 2>&1 | sed 's/^/    /' || true
  fi
  step "探活"
  BODY="$(curl -s -m 8 "http://127.0.0.1:$PORT/healthz" || true)"
  if [ -n "$BODY" ]; then ok "探活：$BODY"; else warn "探活失败：http://127.0.0.1:$PORT/healthz（容器没起？端口没发布？）"; exit 2; fi
  exit 0
fi

# =============================================================================
# 卸载
# =============================================================================
if [ "$MODE" = uninstall ] || [ "$MODE" = purge ]; then
  step "卸载"
  if [ "$MODE" = purge ]; then
    warn "==--purge：会**删除数据卷 $VOLUME**（商品/订单/附件全没）—— 不可逆 =="
    if [ "$ASSUME_YES" != 1 ]; then
      log "  确认请输入卷名：$VOLUME"
      CONFIRM="$(ask '  > ' '' '删除数据卷的确认（非交互请加 --yes）')"
      [ "$CONFIRM" = "$VOLUME" ] || die "输入不匹配，什么都没删"
    fi
  fi
  if have docker; then
    dk rm -f "$CONTAINER" >/dev/null 2>&1 && ok "容器已移除：$CONTAINER" || info "容器不存在：$CONTAINER"
    dk rm -f "$CADDY_CONTAINER" >/dev/null 2>&1 && ok "Caddy 容器已移除：$CADDY_CONTAINER" || true
    dk network rm "$NETWORK" >/dev/null 2>&1 || true
    if [ "$MODE" = purge ]; then
      dk volume rm "$VOLUME" >/dev/null 2>&1 && ok "数据卷已删除：$VOLUME" || warn "数据卷删除失败（可能还在被别的容器用）"
      dk volume rm "$CADDY_DATA" "$CADDY_CONFIG" >/dev/null 2>&1 || true
    else
      ok "数据卷保留：$VOLUME（要连数据一起删：bash deploy.sh --purge）"
    fi
  else
    warn "这台机器上没有 docker —— 没什么可卸的"
  fi
  if [ -f "$UNIT_LEGACY" ]; then
    warn "宿主上还留着旧版的 systemd 单元：sudo systemctl disable --now $SERVICE && sudo rm -f $UNIT_LEGACY && sudo systemctl daemon-reload"
  fi
  info "配置与状态文件保留在 $DIR（含 .env，里面有令牌密钥；不需要了就自行删除）"
  exit 0
fi

# =============================================================================
step "② 取代码"

# 就地拷贝当前代码（安装目录与脚本所在目录不是同一份时用；排除本机状态与密钥）
copy_code_from_here() {
  info "把当前代码复制到 $DIR"
  ( cd "$HERE" && tar -cf - \
      --exclude=node_modules --exclude=.env --exclude='.env.*' --exclude='*.db' --exclude='*.db-wal' \
      --exclude='*.db-shm' --exclude=data --exclude=uploads --exclude=.uploads --exclude=.git \
      --exclude=.test-build --exclude=.deploy-state . ) | ( cd "$DIR" && tar -xf - ) || die "复制代码到 $DIR 失败"
  # 上面排掉了 .env / .env.*（本机开发用的 .env 里可能有私钥、令牌，不该被搬到服务器上），
  # 但 .env.example 是**样例配置、没有秘密**，而 Dockerfile 里有 `COPY .env.example` ——
  # 少了它 docker build 会直接失败在那一行。所以这里单独补回来。
  [ -f "$HERE/.env.example" ] && cp -a "$HERE/.env.example" "$DIR/.env.example"
}

# 宿主机既没有源码也没有 git：**用容器把源码包下下来**（宿主只需要 Docker）。
# 为什么不在 Dockerfile 里 git clone：镜像要可复现、可离线构建，也不该把 .git 与仓库地址
# 焊进镜像里 —— 取源码是"部署这一步"的事，不是"镜像"的事。
# 注意：解到**已存在的安装目录**上是有意为之（升级就是换掉这份代码），压缩包里没有 .env /
# .deploy-state，所以配置与本机状态不会被冲掉。
fetch_code_via_container() {
  info "用容器下载源码包（$SRC_TARBALL）→ $DIR"
  dk run --rm -v "$DIR:/out" -e MK_SRC_URL="$SRC_TARBALL" "$BASE_IMAGE" sh -c '
    set -e
    node -e "
      const fs=require(\"fs\");
      fetch(process.env.MK_SRC_URL).then((r)=>{ if(!r.ok) throw new Error(\"HTTP \"+r.status); return r.arrayBuffer(); })
        .then((b)=>fs.writeFileSync(\"/tmp/src.tgz\", Buffer.from(b)))
        .catch((e)=>{ console.error(\"下载失败：\"+e.message); process.exit(1); });
    "
    tar xzf /tmp/src.tgz -C /out --strip-components=1
  ' || die "容器内下载源码失败（服务器能否访问 GitHub？）—— 也可以在本机下载 ZIP 后上传解压，再在解压目录里跑本脚本"
}

if [ "$MODE" = register ]; then
  info "补登记模式：不构建镜像、不重启容器（只用现有安装的配置与镜像）"
elif [ "$MODE" = update ]; then
  # 升级必须**真的换掉代码**，否则 rc/local 上的改动永远上不去：
  # 之前这里只打印一句"更新模式"就直接去重建镜像 —— 用的是安装目录里那份**旧代码**，
  # 于是"升级到最新版"对跟文档走的店主是假的（他们克隆一次之后再也升不动）。
  info "更新模式：先刷新代码，再重新构建镜像 → 用同一个数据卷与配置重建容器"
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] 将刷新 $DIR 的代码（git pull / 拷贝当前代码 / 容器内下载源码包），然后重建镜像与容器"
  elif [ -d "$DIR/.git" ]; then
    info "更新代码：git pull --ff-only（$DIR）"
    (cd "$DIR" && git pull --ff-only) || warn "git pull 失败（继续用现有代码重建镜像）"
  elif [ "$IN_REPO" = 1 ] && [ "$HERE" != "$DIR" ]; then
    # 脚本自己在**另一份**代码里（例如店主下载了新 ZIP 再对旧安装目录跑 --update）→ 用这份新代码
    copy_code_from_here
  elif [ "$PULL" = 1 ]; then
    # 没有 git、脚本又就在安装目录里（curl|bash 那种装法）：只有显式要求才去公开仓拉最新代码。
    # 不默认拉，是因为"脚本和代码在同一目录"时，目录里那份往往**就是**运维刚放进去的版本
    # （例如本仓的正式站发布：上传新包 → 跑 --update 重建镜像），默认覆盖会把刚放上去的换掉。
    fetch_code_via_container
  else
    warn "代码就在安装目录里（$DIR），本次不刷新它 —— 直接用这份代码重建镜像"
    warn "  要拿公开仓最新代码：bash deploy.sh --update --pull（需要能访问 GitHub）"
    warn "  或者先自己更新这个目录（git pull / 重新解压新版本），再跑 --update"
  fi
  ok "代码就绪：$DIR"
elif [ "$DIR_GIVEN" = 0 ] && [ "$IN_REPO" = 1 ]; then
  ok "就地使用当前目录：$HERE"
elif [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] 将把代码放到 $DIR（就地拷贝 / git clone / 容器内下载源码包）"
elif [ -d "$DIR/.git" ]; then
  info "更新已有代码：$DIR"; (cd "$DIR" && git pull --ff-only) || warn "git pull 失败（继续用现有代码）"
  ok "代码就绪：$DIR"
elif [ -f "$DIR/package.json" ]; then
  info "目标目录已是一份代码：$DIR，沿用现有代码"
  ok "代码就绪：$DIR"
else
  if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then die "$DIR 已存在且非空：用 --dir 指定别的目录，或先清空它"; fi
  mkdir -p "$DIR" 2>/dev/null || as_root mkdir -p "$DIR"
  if [ "$IN_REPO" = 1 ]; then
    copy_code_from_here
  elif have git; then
    info "克隆代码仓库 → $DIR（用宿主机的 git）"
    git clone --depth 1 "$SRC_REPO" "$DIR" || die "代码拉取失败（网络/仓库地址？）"
  else
    fetch_code_via_container
  fi
  ok "代码就绪：$DIR"
fi
# 前置检查：目录里确实是一份节点代码。dry-run 跳过 —— 那时 $DIR 可能还不存在
# （我们只是"打算"把代码放过去），否则 `--dry-run --dir <新目录>` 必然死在
# "这不是一份节点代码"，把"先看计划再决定"这个用法直接抹掉了。
if [ "$DRY_RUN" != 1 ]; then
  [ -f "$DIR/Dockerfile" ] || die "$DIR 里没有 Dockerfile —— 这不是一份节点代码（用 --dir 指到正确目录）"
fi
if [ "$MODE" = register ]; then
  [ -f "$ENV_FILE" ] || die "补登记需要已有安装（找不到 $ENV_FILE）——请先跑一次 bash deploy.sh"
fi

# =============================================================================
# 店主地址 / 域名 / TLS 选择
# =============================================================================
if [ "$MODE" != register ]; then
  if [ -z "$OWNER" ] && [ -f "$ENV_FILE" ]; then
    OWNER="$(env_val MK_SHOP_OWNER)"
  fi
  if [ -z "$OWNER" ]; then
    [ "$ASSUME_YES" = 1 ] && die "缺少 --owner（店主钱包地址）"
    log ""
    log "  你的店主钱包地址（商品上架/发货的身份锚点，例如 0x1234…）"
    OWNER="$(ask '  > ' '' '店主钱包地址（用 --owner 0x… 指定）')"
  fi
  printf '%s' "$OWNER" | grep -Eq '^0x[0-9a-fA-F]{40}$' || die "店主钱包地址格式不对：$OWNER"
  [ "$OWNER" = "0x0000000000000000000000000000000000000000" ] && die "店主地址不能是全零地址"

  [ "$NO_DOMAIN" = 1 ] && DOMAIN=''
  if [ -z "$DOMAIN" ] && [ -f "$ENV_FILE" ]; then
    DOMAIN="$(env_val MK_SIWE_DOMAIN)"
  fi
  if [ -z "$DOMAIN" ] && [ "$NO_DOMAIN" != 1 ]; then
    if [ -f "$ENV_FILE" ]; then
      # 已有配置里 MK_SIWE_DOMAIN 是空的 = 这套安装当初就选了"先不配域名"，那是**记录在案的决定**，
      # 不是漏填。重跑（尤其 --update --yes 这种非交互场景）不该反复追问 —— 之前会直接报
      # "非交互环境无法询问域名"，于是**连升级都做不了**。要加域名就显式给 --domain。
      info "沿用现有配置：这套安装没有配域名（要加域名请显式给：--domain 你的域名）"
    else
      log ""
      log "  节点要挂在哪个域名下？（买家会直接访问它，域名请先解析到本机）"
      log "  例：shop.example.com     —— 留空 = 先只跑节点、稍后再配（那就还不能被买家发现）"
      DOMAIN="$(ask '  > ' '' '节点域名（用 --domain shop.example.com 指定，或 --no-domain 先不配）')"
    fi
  fi
  DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
  DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')"
  ENDPOINT=''; [ -n "$DOMAIN" ] && ENDPOINT="https://$DOMAIN"

  if [ -n "$DOMAIN" ] && [ -z "$TLS_MODE" ]; then
    if [ "$ASSUME_YES" = 1 ]; then TLS_MODE=caddy
    else
      log ""
      log "  HTTPS 用哪种方式？（前端是 https，浏览器会拦掉到 http 节点的请求）"
      log "    1) Caddy 容器        —— 全容器、自动申请与续期证书，宿主不装任何东西（推荐）"
      log "    2) 宿主 nginx+certbot —— 和上一版一样，会在宿主上装 nginx 与 certbot"
      log "    3) 不配 TLS          —— 节点只监听端口，由外部（负载均衡/已有反代）终止 TLS"
      ANS="$(ask '  请选择（默认 1）> ' '1' 'HTTPS 方式（用 --tls-mode caddy|nginx|none 指定）')"
      case "$ANS" in 2) TLS_MODE=nginx ;; 3) TLS_MODE=none ;; *) TLS_MODE=caddy ;; esac
    fi
  fi
  [ -z "$DOMAIN" ] && TLS_MODE=none
  case "$TLS_MODE" in caddy|nginx|none) ;; *) die "--tls-mode 只能是 caddy / nginx / none（收到：$TLS_MODE）";; esac
  if [ "$TLS_MODE" != none ] && [ -z "$EMAIL" ] && [ "$ASSUME_YES" != 1 ]; then
    # 邮箱可以合法地留空（certbot 有 --register-unsafely-without-email 这条路），
    # 所以非交互场景不报错、直接留空，只提示一句。
    if [ "$TTY" = 1 ]; then
      EMAIL="$(ask "  证书邮箱（Let's Encrypt 到期提醒用，可留空）> " '')"
    else
      warn "非交互环境：证书邮箱留空（之后可在 $DIR/Caddyfile 改 email 后重启 $CADDY_CONTAINER）"
    fi
  fi
else
  DOMAIN="$(env_val MK_SIWE_DOMAIN)"
  ENDPOINT=''; [ -n "$DOMAIN" ] && ENDPOINT="https://$DOMAIN"
  OWNER="$(env_val MK_SHOP_OWNER)"
  [ -n "$ENDPOINT" ] || die "补登记需要域名：现有配置里 MK_SIWE_DOMAIN 为空（先跑 bash deploy.sh --domain 你的域名）"
fi

# ── 登记私钥（可选）──
DO_REGISTER=0
if [ "$NO_REGISTER" != 1 ] && [ -n "$ENDPOINT" ] && [ "$MODE" != update ]; then
  if [ -n "$KEY_FILE" ]; then
    [ -f "$KEY_FILE" ] || die "私钥文件不存在：$KEY_FILE"
    DO_REGISTER=1
  elif [ "$ASSUME_YES" != 1 ] && [ "$TTY" = 1 ]; then
    log ""
    log "  现在就在链上登记这家店吗？（登记后买家立刻能在 $FRONTEND 看到你）"
    log "    1) 现在登记 —— 需要粘贴店主钱包私钥（不回显；只经标准输入进容器，宿主不留文件）"
    log "    2) 稍后登记 —— 到 $FRONTEND 的「开店/登记我的节点」用钱包插件完成（推荐，更安全）"
    ANS="$(ask '  请选择（默认 2）> ' '2')"
    if [ "$ANS" = "1" ]; then
      printf '    店主私钥（输入不回显，粘贴后回车）> ' >&2
      read -r -s KEY_INPUT || true
      printf '\n' >&2
      [ -n "$KEY_INPUT" ] || die "未输入私钥"
      DO_REGISTER=1
    fi
  fi
fi

log ""
info "店主地址：$OWNER"
info "对外域名：${ENDPOINT:-（未指定，节点不会被买家发现）}"
info "HTTPS   ：$TLS_MODE"
info "链上登记：$([ "$DO_REGISTER" = 1 ] && echo '本次脚本完成' || echo '稍后（前端开店向导）')"
info "合约：Escrow=$ESCROW  Registry=$REGISTRY（已内置）"

if [ "$DRY_RUN" = 1 ]; then
  step "dry-run：以上是全部计划，未做任何改动"
  info "将构建镜像 $IMAGE（docker build $DIR）"
  info "将创建/复用数据卷 $VOLUME（挂到容器 /data）"
  BIND_PLAN="$BIND"
  [ -n "$BIND_PLAN" ] || { BIND_PLAN='127.0.0.1'; [ "$TLS_MODE" = none ] && BIND_PLAN='0.0.0.0'; }
  info "将起容器 $CONTAINER：--restart unless-stopped -p $BIND_PLAN:$PORT:$CONTAINER_PORT --env-file $ENV_FILE -v $VOLUME:/data"
  [ "$TLS_MODE" = caddy ] && info "将起 Caddy 容器 $CADDY_CONTAINER（自动 HTTPS：$DOMAIN）"
  [ "$TLS_MODE" = nginx ] && info "将在宿主安装 nginx + certbot 并写 /etc/nginx/conf.d/$SERVICE.conf"
  [ "$DO_REGISTER" = 1 ] && info "将在容器里执行链上登记"
  info "去掉 --dry-run 即真正执行"
  exit 0
fi

# =============================================================================
step "③ 写配置（$ENV_FILE）"
umask 077
DATA_MOUNT='/data'
KEEP_EXTRA=''
MANAGED_KEYS='MK_PORT MK_SHOP_OWNER MK_RPC_URL MK_CHAIN_ID MK_ESCROW_ADDRESS MK_REGISTRY_ADDRESS MK_ESCROW_START_BLOCK MK_ESCROW_TIMEOUT_BLOCKS MK_ESCROW_FINALITY_BLOCKS MK_ESCROW_POLL_MS MK_CHAIN_RECONCILE_MS MK_CORS_ORIGIN MK_CORS_ALLOW_ALL MK_DB_FILE MK_ATTACH_DIR MK_AUTO_DELIVER MK_PII_RETENTION_DAYS MK_BTY_TTL_MS MK_RATES_TTL_MS MK_DRAFT_TTL_MINUTES MK_REVIEW_TTL_DAYS MK_TOKEN_TTL MK_SIWE_TTL MK_TOKEN_SECRET MK_SIWE_DOMAIN'
if [ -f "$ENV_FILE" ]; then
  KEEP_SECRET="$(env_val MK_TOKEN_SECRET)"
  cp -a "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  # 脚本不管的键原样保留（店主自己加的风控闸/兜底汇率/通知等，重跑脚本不该把它们删掉）。
  # 保留的行会原样进新文件，所以同样要清掉 \r —— 否则 CRLF 会从这几行传染给整个配置。
  KEEP_EXTRA="$(awk -v managed="$MANAGED_KEYS" '
    BEGIN { n = split(managed, m, " "); for (i = 1; i <= n; i++) keep[m[i]] = 1 }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    { k = $0; sub(/=.*$/, "", k); gsub(/[[:space:]]/, "", k); if (!(k in keep)) print $0 }
  ' "$ENV_FILE" 2>/dev/null | tr -d '\r' || true)"
fi
if [ -z "$KEEP_SECRET" ] || [ "${#KEEP_SECRET}" -lt 32 ]; then
  have openssl || die "缺少 openssl（装一下：apt install openssl），它用来生成令牌密钥"
  KEEP_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  ok "已生成强随机令牌密钥 MK_TOKEN_SECRET（只写在本机 $ENV_FILE，权限 600）"
else
  ok "沿用已有 MK_TOKEN_SECRET（店主登录态不失效）"
fi
KEEP_BTY_TTL="$(env_val MK_BTY_TTL_MS)"
[ -n "$KEEP_BTY_TTL" ] || KEEP_BTY_TTL=60000
KEEP_RATES_TTL="$(env_val MK_RATES_TTL_MS)"
[ -n "$KEEP_RATES_TTL" ] || KEEP_RATES_TTL=1800000
# CORS 白名单：只把**非空**的 Origin 拼进来（ENDPOINT 可能带空白或为空串，拼进去会变成垃圾项）
CORS="$FRONTEND"
if [ -n "${ENDPOINT//[[:space:]]/}" ]; then CORS="$CORS,$ENDPOINT"; fi

cat > "$ENV_FILE" <<EOF
# 由 deploy.sh（Docker 版）生成于 $(date -u +%Y-%m-%dT%H:%M:%SZ)
# 这个文件通过 docker --env-file 传给容器；数据在卷 $VOLUME 里（挂到容器 $DATA_MOUNT）
MK_PORT=$CONTAINER_PORT
MK_SHOP_OWNER=$OWNER
MK_RPC_URL=$RPC_URL
MK_CHAIN_ID=$CHAIN_ID
MK_ESCROW_ADDRESS=$ESCROW
MK_REGISTRY_ADDRESS=$REGISTRY
MK_ESCROW_START_BLOCK=$START_BLOCK
MK_ESCROW_TIMEOUT_BLOCKS=120960
MK_ESCROW_FINALITY_BLOCKS=12
MK_ESCROW_POLL_MS=15000
MK_CHAIN_RECONCILE_MS=600000
# 谁可以跨域读你的节点：联邦前端（买家聚合） + 你自己的域名
MK_CORS_ORIGIN=$CORS
MK_CORS_ALLOW_ALL=0
# 数据在**卷**里：容器删了重建数据也在，这是升级与搬家都不丢数据的前提
MK_DB_FILE=$DATA_MOUNT/marketplace-node.db
MK_ATTACH_DIR=$DATA_MOUNT/attachments
MK_AUTO_DELIVER=1
MK_PII_RETENTION_DAYS=180
# 行情缓存（毫秒）：BTY 价跟得紧；USDT→CNY 缓存久一点，免得把公共汇率接口打成限速
MK_BTY_TTL_MS=$KEEP_BTY_TTL
MK_RATES_TTL_MS=$KEEP_RATES_TTL
MK_DRAFT_TTL_MINUTES=30
MK_REVIEW_TTL_DAYS=30
MK_TOKEN_TTL=86400
MK_SIWE_TTL=600
MK_TOKEN_SECRET=$KEEP_SECRET
MK_SIWE_DOMAIN=$DOMAIN
EOF
if [ -n "$KEEP_EXTRA" ]; then
  {
    printf '\n# ── 以下配置项不由 deploy.sh 管理，重跑脚本时原样保留 ──\n'
    printf '%s\n' "$KEEP_EXTRA"
  } >> "$ENV_FILE"
  info "沿用你原有的这些配置项：$(printf '%s' "$KEEP_EXTRA" | sed 's/=.*//' | tr '\n' ' ')"
fi
chmod 600 "$ENV_FILE"
ok "配置就绪：$ENV_FILE（$(grep -c . "$ENV_FILE") 行，0600）"

# =============================================================================
if [ "$MODE" != register ]; then
  step "④ 构建镜像（$IMAGE）"
  # 重建前先把**当前这个镜像**另存一个 tag：新镜像构建失败/起不来时可以一键回到它。
  # 为什么必须有：下面第 ⑥ 步会先删掉旧容器再起新的，如果新镜像有问题，线上就空窗了
  # （旧实现就是这样，失败只留一句"看日志"）。
  ROLLBACK_IMAGE="${SERVICE}-rollback:latest"
  OLD_IMAGE_ID="$(dk image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)"
  if [ -n "$OLD_IMAGE_ID" ]; then
    dk tag "$OLD_IMAGE_ID" "$ROLLBACK_IMAGE" >/dev/null 2>&1 \
      && info "已把当前镜像存为回滚点：$ROLLBACK_IMAGE（${OLD_IMAGE_ID:7:12}）" \
      || warn "回滚点标记失败（不影响本次部署）"
  fi
  info "docker build $DIR …"
  dk build -t "$IMAGE" "$DIR" || die "镜像构建失败（看上面的输出；最常见原因：拉不到基础镜像 $BASE_IMAGE —— 服务器出网/Docker 镜像源受限）。**旧容器没有被动过，节点仍在正常服务**"
  IMAGE_ID="$(dk image inspect "$IMAGE" --format '{{.Id}}' | cut -c8-19)"
  # 尺寸用 docker images 的口径（落盘占用），不是 inspect 的 .Size（那是压缩层大小，
  # 两个数字差 4 倍：同一个镜像 369MB 落盘 / 83MB 压缩，报小的那个会让店主以为磁盘没事）
  IMAGE_SIZE="$(dk images --format '{{.Size}}' "$IMAGE" 2>/dev/null | head -1)"
  ok "镜像就绪：$IMAGE（$IMAGE_ID，落盘 ${IMAGE_SIZE:-未知}）"

  step "⑤ 数据卷（$VOLUME）"
  if dk volume inspect "$VOLUME" >/dev/null 2>&1; then
    ok "数据卷已存在（沿用：里面的商品/订单/附件都不会动）"
  else
    dk volume create "$VOLUME" >/dev/null
    ok "已创建数据卷：$VOLUME"
  fi
  info "备份：docker run --rm -v $VOLUME:/data -v \"\$PWD\":/backup --entrypoint tar $IMAGE czf /backup/node-data-\$(date +%F).tar.gz -C /data ."
  info "恢复：docker run --rm -v $VOLUME:/data -v \"\$PWD\":/backup --entrypoint tar $IMAGE xzf /backup/node-data-YYYY-MM-DD.tar.gz -C /data"

  # 起容器（正常路径与回滚路径共用；回滚要用旧镜像 + 同一套网络/端口/卷/配置）
  run_container() {
    local img="$1"
    dk rm -f "$CONTAINER" >/dev/null 2>&1 || true
    dk network inspect "$NETWORK" >/dev/null 2>&1 || dk network create "$NETWORK" >/dev/null
    dk run -d --name "$CONTAINER" \
      --restart unless-stopped \
      --network "$NETWORK" --network-alias "$SERVICE" \
      -p "$BIND:$PORT:$CONTAINER_PORT" \
      --env-file "$ENV_FILE" \
      -v "$VOLUME:$DATA_MOUNT" \
      "$img" >/dev/null
  }
  # 探活：返回 0/1，同时把最后一次的 HTTP 码放进 PROBE_CODE
  probe() {
    local i
    PROBE_CODE=''
    for i in $(seq 1 30); do
      PROBE_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
      [ "$PROBE_CODE" = "200" ] && return 0
      sleep 1
    done
    return 1
  }

  step "⑥ 启动节点容器（$CONTAINER）"
  if dk ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    if [ "$FORCE" != 1 ] && [ "$MODE" != update ]; then
      die "容器 $CONTAINER 已存在 —— 用 --update 升级，或 --force 覆盖重建（数据卷不受影响）"
    fi
    info "移除旧容器（数据在卷里，不受影响）"
  fi
  # 绑哪个宿主地址：--bind 优先，否则跟着 TLS 方式走（见参数说明）
  if [ -z "$BIND" ]; then
    BIND='127.0.0.1'
    [ "$TLS_MODE" = none ] && BIND='0.0.0.0'
  fi
  case "$BIND" in
    0.0.0.0|127.0.0.1|'[::]'|'::') ;;
    *) die "--bind 只能是 0.0.0.0 或 127.0.0.1（收到：$BIND）" ;;
  esac
  run_container "$IMAGE"
  ok "容器已启动：$CONTAINER（$BIND:$PORT → 容器 $CONTAINER_PORT，数据卷 $VOLUME）"

  step "⑦ 探活"
  if ! probe; then
    warn "新容器健康检查未通过（HTTP ${PROBE_CODE:-000}）。最近日志："
    dk logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/    /' || true
    if [ -n "$OLD_IMAGE_ID" ]; then
      warn "自动回滚：用上一个镜像（$ROLLBACK_IMAGE）重建容器 ……"
      if run_container "$ROLLBACK_IMAGE" && probe; then
        ok "已回滚到上一个镜像并探活通过（$ROLLBACK_IMAGE）—— 节点恢复服务"
        dk logs --tail 10 "$CONTAINER" 2>&1 | sed 's/^/    /' || true
        die "本次升级失败（新镜像有问题），已自动回滚。修好后重跑：bash deploy.sh --update"
      fi
      warn "回滚也没起来（HTTP ${PROBE_CODE:-000}）：看上面的日志，手工介入"
    fi
    die "节点没起来：看上面的日志（常见：配置里的合约地址被改坏 / 数据卷权限 / 端口被占）"
  fi
  BODY="$(curl -s -m 8 "http://127.0.0.1:$PORT/healthz" || true)"
  ok "探活通过：$BODY"

  step "⑧ HTTPS（$TLS_MODE）"
  if [ "$TLS_MODE" = none ]; then
    if [ -n "$DOMAIN" ]; then
      warn "未配置 TLS：请把外部入口（负载均衡/反向代理）指到 http://<本机>:$PORT，并在那里终止 TLS"
      warn "联邦前端是 https，浏览器会拦掉到 http 节点的请求 —— 这一步不做，买家就看不到你"
    else
      info "未指定域名：节点只在 http://127.0.0.1:$PORT 上可访问（仅本机）"
    fi
    [ "$BIND" = '0.0.0.0' ] && warn "端口已监听在所有网卡上 —— 记得放行防火墙/安全组，否则公网仍然访问不到"
  elif [ "$TLS_MODE" = caddy ]; then
    step "⑧a Caddy 容器（自动 HTTPS）"
    cat > "$DIR/Caddyfile" <<EOF
# 由 deploy.sh 生成于 $(date -u +%Y-%m-%dT%H:%M:%SZ)；改完执行：docker restart $CADDY_CONTAINER
{
	email ${EMAIL:-admin@example.com}
}

$DOMAIN {
	encode gzip
	reverse_proxy $SERVICE:$CONTAINER_PORT
	header {
		-Server
	}
}
EOF
    chmod 644 "$DIR/Caddyfile"
    dk rm -f "$CADDY_CONTAINER" >/dev/null 2>&1 || true
    info "拉起 Caddy（首次会去申请证书：需要 $DOMAIN 已解析到本机、80/443 可达）…"
    if dk run -d --name "$CADDY_CONTAINER" \
        --restart unless-stopped \
        --network "$NETWORK" \
        -p 80:80 -p 443:443 -p 443:443/udp \
        -v "$DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
        -v "$CADDY_DATA:/data" -v "$CADDY_CONFIG:/config" \
        "$CADDY_IMAGE" >/dev/null; then
      ok "Caddy 已启动：$CADDY_CONTAINER（证书数据在卷 $CADDY_DATA）"
      info "看证书申请进度：docker logs -f $CADDY_CONTAINER"
    else
      warn "Caddy 启动失败（拉不到 $CADDY_IMAGE？看上面的输出）"
      warn "节点本身已经在跑；你可以改用 --tls-mode nginx 或 --tls-mode none 重跑"
    fi
  else
    step "⑧b 宿主 nginx + certbot"
    if ! have nginx; then
      info "安装 nginx …"
      if have apt-get; then
        as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx
      elif have dnf; then as_root dnf install -y -q nginx
      else die "无法自动安装 nginx，请手动安装后重跑；或改用 --tls-mode caddy / none"; fi
    fi
    CONF="/etc/nginx/conf.d/$SERVICE.conf"
    TMP_CONF="$(mktemp)"
    cat > "$TMP_CONF" <<EOF
# 联邦商城节点（由 deploy.sh 生成）：$DOMAIN → 127.0.0.1:$PORT（容器 $CONTAINER）
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
    location = /healthz { proxy_pass http://127.0.0.1:$PORT/healthz; }
}
EOF
    # 覆盖前备份；校验失败立即还原并 reload（别把坏配置留在 conf.d 里等下次重启整机 nginx 全挂）
    CONF_BAK=''; HAD_CONF=0
    if as_root test -f "$CONF"; then CONF_BAK="$(mktemp)"; as_root cp -a "$CONF" "$CONF_BAK"; HAD_CONF=1; fi
    as_root cp "$TMP_CONF" "$CONF"; rm -f "$TMP_CONF"
    if as_root nginx -t >/dev/null 2>&1; then
      as_root systemctl reload nginx 2>/dev/null || as_root nginx -s reload 2>/dev/null || true
      rm -f "$CONF_BAK"
      ok "nginx 已配置：$CONF"
    else
      as_root nginx -t || true
      if [ "$HAD_CONF" = 1 ]; then as_root cp -a "$CONF_BAK" "$CONF"; warn "已还原原有 nginx 配置"; else as_root rm -f "$CONF"; warn "已移除本次写入的 nginx 配置"; fi
      rm -f "$CONF_BAK"
      as_root systemctl reload nginx 2>/dev/null || as_root nginx -s reload 2>/dev/null || true
      die "nginx 配置校验失败（见上）——已还原到部署前的状态"
    fi
    if ! have certbot; then
      info "安装 certbot …"
      if have apt-get; then as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx
      elif have dnf; then as_root dnf install -y -q certbot python3-certbot-nginx
      else warn "无法自动安装 certbot：请手动执行 certbot --nginx -d $DOMAIN"; fi
    fi
    if have certbot; then
      info "申请 Let's Encrypt 证书（要求 $DOMAIN 已解析到本机、80 端口可被公网访问）…"
      if [ -n "$EMAIL" ]; then
        as_root certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos -n --redirect || warn "certbot 失败（看上面输出）：修好后重跑 bash deploy.sh --update --domain $DOMAIN"
      else
        as_root certbot --nginx -d "$DOMAIN" --register-unsafely-without-email --agree-tos -n --redirect || warn "certbot 失败（看上面输出）：建议带 --email 重跑"
      fi
    fi
    CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/shop" 2>/dev/null || true)"
    if [ "$CODE" = "200" ]; then ok "对外入口可访问：https://$DOMAIN/api/shop → 200"; else warn "对外入口自检 HTTP ${CODE:-000}（证书没配好/域名未解析/防火墙）"; fi
  fi

  # 状态文件：--update/--status/--health/--uninstall 靠它认路
  cat > "$STATE_FILE" <<EOF
STATE_SERVICE=$SERVICE
STATE_PORT=$PORT
STATE_VOLUME=$VOLUME
STATE_IMAGE=$IMAGE
STATE_CONTAINER=$CONTAINER
STATE_TLS=$TLS_MODE
STATE_EMAIL=$EMAIL
STATE_BIND=$BIND
STATE_NETWORK=$NETWORK
STATE_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 644 "$STATE_FILE"
fi

# =============================================================================
if [ "$DO_REGISTER" = 1 ]; then
  step "⑨ 链上登记（在容器里跑 register-node.mjs）"
  info "私钥只经标准输入进容器，随容器一起销毁：宿主磁盘上不落任何文件"
  REG_CMD='umask 077; cat > "$MK_KEY_FILE"; exec node scripts/register-node.mjs --endpoint "$MK_REGISTER_ENDPOINT" --owner "$MK_REGISTER_OWNER"'
  reg_args=(--rm -i --env-file "$ENV_FILE" -e MK_KEY_FILE=/tmp/owner.key
            -e MK_REGISTER_ENDPOINT="$ENDPOINT" -e MK_REGISTER_OWNER="$OWNER" "$IMAGE" sh -c "$REG_CMD")
  REG_OK=0
  if [ -n "$KEY_FILE" ]; then
    dk run "${reg_args[@]}" < "$KEY_FILE" && REG_OK=1
  else
    printf '%s\n' "$KEY_INPUT" | dk run "${reg_args[@]}" && REG_OK=1
    unset KEY_INPUT
  fi
  if [ "$REG_OK" = 1 ]; then
    ok "登记成功：$ENDPOINT"
  else
    die "链上登记失败（见上面输出）。节点本身已在运行，也可以稍后到 $FRONTEND 的「开店向导」完成登记"
  fi
fi

# =============================================================================
step "完成"
ok "节点：http://127.0.0.1:$PORT/healthz（容器 $CONTAINER，数据卷 $VOLUME）"
[ -n "$ENDPOINT" ] && ok "对外：$ENDPOINT"
log ""
if [ "$MODE" = register ] || [ "$DO_REGISTER" = 1 ]; then
  log "  你的店已上链登记，打开 $FRONTEND 首页即可看到（首次显示可能需要几十秒）。"
else
  log "  还差最后一步：打开 $FRONTEND →「开店/登记我的节点」，用钱包签名完成登记，"
  log "  登记后买家才能发现你（没有登记过的节点前端一定看不到——这是刻意的，没有静态兜底列表）。"
fi
log ""
log "  常用命令："
log "    docker logs -f $CONTAINER            # 看日志（容器版没有 systemd 单元）"
log "    bash deploy.sh --health              # 探活（含最近日志）"
log "    bash deploy.sh --update              # 重新构建镜像并用同一个数据卷重建容器（数据不丢）"
log "    bash deploy.sh --register            # 补登记（或换域名后重新登记）"
log "    docker restart $CONTAINER            # 重启节点"
log "    bash deploy.sh --uninstall           # 停掉并移除容器（数据卷保留）"
log ""
log "  数据（数据库与附件）都在卷 $VOLUME 里 —— 备份就是导出这个卷（命令见上面 ⑤ 的提示）"
log "  店铺资料（店名/公告/店员/通知）登录 $FRONTEND 的卖家面板网页维护，即改即生效"
log ""
log "  建议接着读两份（都在本仓库 docs/ 目录里）："
log "    docs/COMPLIANCE.md  合规与责任须知（开店前必读：经营者的法律义务、个人信息、被投诉怎么办）"
log "    docs/OPERATIONS.md  运维手册（备份/恢复/升级/轮换密钥/故障速查）"
