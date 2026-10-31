#!/usr/bin/env bash
# =============================================================================
#  联邦商城 · 开店节点一键部署（fedmall.bityuan.com）—— **Docker 版**
#
#  一条命令把你这台服务器变成联邦商城的一家店：装 Docker（若没有）→ 构建镜像 →
#  建数据卷 → 起容器 → 探活 → 打印链上登记指引。
#
#  ── 为什么只用 Docker ──────────────────────────────────────────────────────
#  上一版是"在宿主机上装"：装 Node 到 /usr/local、写 systemd 单元、装 nginx/certbot。
#  宿主环境是最不可控的变量：发行版不同、包管理器不同、可能已经有别人的服务在跑、
#  还可能把别人依赖的运行时顺手升掉。改成容器后：
#      · 不再往宿主机装任何运行时（Node 只在镜像里）；
#      · 不依赖 init 系统（开机自启用 Docker 的 `--restart unless-stopped`）；
#      · 数据在**命名卷**里（附件与商品媒体；库在 MySQL 里）—— 容器可以随时删掉重建（升级就是换镜像），
#        搬家就是导出/导入卷与 MySQL 库。
#  宿主上只多三样东西：Docker（若原本没有）、一个数据卷、（可选）一个反向代理容器。
#
#  ── 证书放哪、HTTPS 在哪终止（**这是两个拓扑，不是一个开关**）─────────────
#  联邦前端是 https，浏览器会拦掉到 http 节点的请求，所以**买家看到的 endpoint 必须是 https**
#  （链上登记与前端向导都强制 https）。但**证书不一定要在本机**：TLS 在哪终止，证书就在哪申请。
#
#    拓扑 A「TLS 在外部终止」：本机只出 http://<本机>:$PORT，域名与证书在别处
#                             （负载均衡 / CDN / 另一台 nginx）——**默认就是这条**：
#                             不给 --tls-mode 只给 --domain 即走它，本机不申请任何证书、不碰宿主 nginx。
#    拓扑 B「TLS 在本机终止」：域名直接解析到本机，证书由本机申请：
#                             · Caddy 容器（`--tls-mode caddy`）：全自动申请与续期，宿主不装任何东西
#                               —— **干净机器上想要一键全包就显式选它**；
#                             · 宿主 nginx + certbot（`--tls-mode nginx`）：**只适合干净机器**；
#                               机器上已有 nginx 站点时脚本会**拒绝**（理由与替代写法见第 ⑧b 步）。
#
#  「本机已有 nginx、证书也已就绪」（拓扑 B 的第二形态）：用 `--tls-mode none --bind 127.0.0.1`，
#  节点只监听回环，由你那份 nginx 加一段反代指过来 —— 脚本不碰你的证书，也不写 conf.d。
#
#  ── 用法 ───────────────────────────────────────────────────────────────────
#      bash deploy.sh                      # 交互式：问域名/邮箱/店主地址
#      bash deploy.sh --owner 0x… --domain shop.example.com --email me@x.com
#      bash deploy.sh --tls-mode caddy|nginx|none       # 跳过 TLS 选择（--no-tls 等价于 --tls-mode none）
#      bash deploy.sh --dry-run            # 只打印计划，什么都不改（含"要不要装 Docker"）
#      bash deploy.sh --status | --health | --update | --uninstall
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
#      --db-mode external|container      用自己的 MySQL 还是由脚本起 MySQL 容器（不给则交互询问）
#      --db-host HOST[:PORT]             外部 MySQL 地址（也接受 mysql://HOST:PORT；不要把密码写进 URL）
#      --db-name NAME / --db-user USER   外部库名/用户名；密码用 MK_DB_PASSWORD 环境变量传
#      --db-container NAME               内置 MySQL 容器名（默认 <service>-mysql）
#      --db-volume NAME                  内置 MySQL 数据卷（默认 <service>-mysql-data）
#      --db-image IMAGE                  内置 MySQL 镜像（默认 mysql:8.4）
#      --redis-url URL                   外部 Redis（必填；如 redis://:密码@主机:6379/0，
#                                        也可用 MK_REDIS_URL 环境变量传，避免密码进 history）
#      --image marketplace-node:latest   镜像名:标签
#      --escrow 0x… --staking 0x… --start-block N
#                                         本节点 Escrow / Staking / 起始扫描块；不填则读 deploy-constants.json
#      --no-domain                       先不配域名
#      --pull                            --update 时强制从公开仓拉最新代码（没有 git 的安装用）
#      --yes / --force                   不交互 / 覆盖同名容器
#
#  ── 关于私钥 ───────────────────────────────────────────────────────────────
#  链上登记由店主在前端（fedmall.bityuan.com）的「开店/登记我的节点」用钱包插件完成（部署脚本不持私钥、不代登记）。
# =============================================================================
set -Eeuo pipefail

# ── 输出与失败 ──
# 先定义：下面解析参数、读常量、平台探测都会用到 die，不能等到常量门禁之后才定义。
# （上一版 const() 在 die 之前调用它，取不到常量时先打出 "die: command not found"。）
c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log()  { printf '%s\n' "$*"; }
info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '%s!%s %s\n' "$c_warn" "$c_off" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$c_err" "$*" "$c_off" >&2; exit 1; }
step() { printf '\n%s── %s ──%s\n' "$c_dim" "$*" "$c_off"; }

# ── 部署常量从哪来 ──────────────────────────────────────────────────────────
# 本节点自己的 Escrow / Staking / 起始扫描块住在 deploy-constants.json（与 Windows 原生路径
# deploy.ps1 共用同一份），脚本里不内置默认值：接错托管合约的表现是**静默的**——节点照常启动、
# 商品照常展示，只有买家付款路径指向别处。所以缺值/坏值在安装/升级前当场拒绝。
#
# 每个节点部署自己的 Escrow + Staking（contracts/script/DeployNode.s.sol）：
#   · Escrow 与 Staking 必须互相回指，且 owner 都是节点 operator；
#   · startBlock 取 Escrow/Staking 中最早的部署块；错成更高高度会漏扫历史事件；
#   · 链上登记由店主在前端用钱包完成，部署脚本**不持私钥、不自动登记**。
# 换节点/换批时三项同批改；一行安装也可以用 --escrow / --staking / --start-block 直接传，
# 不必先改文件（install.sh 会原样透传给 deploy.sh）。
#
# contracts 三项留空 / startBlock=0 = 未部署：安装/升级时的形状门禁会当场拒绝，而不是静默接错。
# 取源码用（只在"宿主机没有源码也没有 git"时启用；见 ② 取代码）
SRC_REPO='https://github.com/delnull/marketplace-node.git'
SRC_TARBALL='https://codeload.github.com/delnull/marketplace-node/tar.gz/refs/heads/main'
# 兜底下载源码用的镜像：用**构建镜像的同一个基础镜像**（本地没有就拉一次，之后复用）
BASE_IMAGE='node:24-slim'
KEEP_SECRET=''

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN_REPO=0; [ -f "$HERE/package.json" ] && [ -f "$HERE/src/server.js" ] && IN_REPO=1
CONSTANTS_FILE="$HERE/deploy-constants.json"
# ── 部署常量 ────────────────────────────────────────────────────────────────
# 唯一真相仍是 deploy-constants.json（与 Windows 原生路径 deploy.ps1 共用同一份）。
# 一行安装（curl | bash）时 BASH_SOURCE 是 /dev/fd/63，旁边没有这个文件；
# 这里只在 install/update 真正需要常量时下载，--help/--status/--health/--uninstall 不碰它。
const_raw_from() {
  local key="$1" file="$2"
  [ -r "$file" ] || { printf '%s' ''; return 0; }
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$file" | head -1 | sed 's/[[:space:]]*$//'
}
const_raw() { const_raw_from "$1" "$CONSTANTS_FILE"; }
const() {
  local val
  val="$(const_raw "$1")"
  [ -n "$val" ] || die "deploy-constants.json 里取不到 $1 —— 文件结构变了？脚本拒绝用一个猜出来的值继续"
  printf '%s' "$val"
}
# 取**数值**型常量：多一道字符集校验，因为下面要把它裸着写进 .env 的 here-doc
# （here-doc 里裸写的值会被当算术表达式展开，塞进非数字就是一个"看起来成功、写进去却是 0/空"的坑）。
constN() {
  local val
  val="$(const "$1")"
  # 不要用 `expr "$val" + 0` 判数字：`expr 0 + 0` 的输出是 0，但退出码是 1，
  # 于是合法的 0（例如 MK_CORS_ALLOW_ALL=0）会被当成“不是数字”。这里按字符集判。
  case "$val" in ''|*[!0-9]*) die "deploy-constants.json 的 $1 不是数字：'$val'（脚本不猜）" ;; esac
  printf '%s' "$val"
}

# ── 安装/升级期的硬门禁：本节点 Escrow/Staking/起始块必须是**本批**的（fail-closed）──
# 为什么是一条门禁而不是靠注释提醒（2026-10-14）：这些值决定"买家把钱锁到哪个合约、
# 节点按哪份名单过滤"，而错了之后的表现是**静默的**——节点照常启动、商品照常展示，
# 只有买家付款路径指向别处。历史已经踩过一次：那批链上字节码与仓库代码不一致，
# 后果是店主提不出质押而 `/healthz` 一切正常。"常量填错"必须当场停下。
# 判据只做**结构性**校验（地址形状 + 起始块非 0）：「是不是上一批已弃用的那个合法地址」
# 脚本无法判断，只能由部署者按发布检查表逐项核对。
require_contract_constants() {
  if printf '%s' "$ESCROW" | grep -Eq '^0x[0-9a-fA-F]{40}$' \
     && printf '%s' "$STAKING" | grep -Eq '^0x[0-9a-fA-F]{40}$' \
     && printf '%s' "$START_BLOCK" | grep -Eq '^[0-9]+$' \
     && [ "$START_BLOCK" != '0' ]; then
    return 0
  fi
  cat >&2 <<EOF
[deploy.sh] 拒绝执行：没有可用的本节点合约常量。

  取到的值：escrow=$ESCROW  staking=$STAKING  startBlock=$START_BLOCK

  这三项会被写进 <安装目录>/.env（docker --env-file 注入容器）与安装目录的
  deploy-constants.json，不是编进镜像。它们必须与**本节点**部署的合约一致，两种给法任选其一：
    1) 写进 deploy-constants.json 的 contracts 三项
       （Windows 原生路径 deploy.ps1 只读这份文件，不接受下面三个参数）
    2) 直接传给本脚本（一行安装 install.sh 会原样透传）：
       --escrow 0x...  --staking 0x...  --start-block <块高>
       命令行给的值会写回安装目录的 deploy-constants.json，之后 --update 不必重复带。
  约束：
    · 先部署本节点合约：contracts/script/DeployNode.s.sol（Escrow + Staking + 委员会 + NodeGovernance）
    · 起始块不能是 0（0 = 从最新块开始 ⇒ 漏扫历史事件且不报错）
    · Escrow 与 Staking 必须由同一节点部署、互相回指、owner 都是该节点 operator
EOF
  exit 1
}

# 只在 install/update 路径调用（**刷新代码之前**）。共享值来自本次代码；
# 三项按 CLI > 安装目录里现有值 > 本次代码包里的值（首次安装，或店主直接改了代码包）。
# 最终三项只经过 require_contract_constants 这一道判据，不在别处各判一次。
load_deploy_constants() {
  if [ ! -r "$CONSTANTS_FILE" ]; then
    if [ "$IN_REPO" = 1 ]; then
      : # 仓库里缺文件，交给下面的结构门禁报错
    elif ! command -v curl >/dev/null 2>&1; then
      die "缺少 curl：一行安装需要 curl 下载当批 deploy-constants.json"
    else
      CONSTANTS_TMP="$(mktemp "${TMPDIR:-/tmp}/marketplace-constants.XXXXXX")" || die "无法创建临时文件"
      if ! curl -fsSL --max-time 30 \
        'https://raw.githubusercontent.com/delnull/marketplace-node/main/deploy-constants.json' \
        -o "$CONSTANTS_TMP"; then
        rm -f "$CONSTANTS_TMP"
        die "下载 deploy-constants.json 失败（检查网络/代理）"
      fi
      CONSTANTS_FILE="$CONSTANTS_TMP"
      trap 'rm -f "${CONSTANTS_TMP:-}"' EXIT
    fi
  fi
  [ -r "$CONSTANTS_FILE" ] || die "缺少 $CONSTANTS_FILE —— 部署常量（合约地址/RPC/端口）的唯一真相在那里；文件不在就无法保证接的是本批合约，拒绝继续"

  FRONTEND="$(const frontendOrigin)"
  RPC_URL="$(const rpcUrl)"
  CHAIN_ID="$(const chainId)"
  # 共享常量（RPC/链 ID/前端/运行参数）来自**本次要部署的代码**。
  # 三项本节点合约属于安装状态：命令行显式值 > 安装目录里现有的 deploy-constants.json
  # > 本次代码包里的值（首次安装；或店主直接在代码包里改过）。
  local install_file="$DIR/deploy-constants.json" node_file
  if [ -r "$install_file" ]; then node_file="$install_file"; else node_file="$CONSTANTS_FILE"; fi
  ESCROW="${ESCROW_ARG:-$(const_raw_from escrow "$node_file")}"
  STAKING="${STAKING_ARG:-$(const_raw_from staking "$node_file")}"
  START_BLOCK="${START_BLOCK_ARG:-$(const_raw_from startBlock "$node_file")}"
  CONTAINER_PORT="$(const containerPort)"
  # 容器停机宽限期（秒）⇒ `docker run --stop-timeout`。它必须**大于** .env 里的
  # MK_SHUTDOWN_DRAIN_MS（节点自己等在途请求的上限）：相等或更短时，宽限期一到 SIGKILL 就把
  # 优雅关闭截断，而节点已经打了"已关闭"那一行（看起来一切正常）。这条不等式由
  # test/deploy-plan.test.js 对 deploy-constants.json 守着，脚本不重复判。
  STOP_GRACE="$(constN stopGraceSeconds)"
  require_contract_constants
}

# 把本次解析出的三项写回**安装目录**的 deploy-constants.json。
# 为什么必须写回：一行安装可以用 --escrow/--staking/--start-block 传值；不落盘的话，
# 下一次 --update（没带参数）会读到代码包里的空模板并被门禁拒绝。写回后，
# 安装目录里的这一份就是后续升级的唯一真相；代码包里的共享默认值（RPC/链 ID/appDefaults）
# 仍然以本次部署的代码为准（见 load_deploy_constants 的读取顺序）。
persist_contract_constants() {
  local file="$DIR/deploy-constants.json" tmp
  if [ ! -f "$file" ]; then
    [ -f "$CONSTANTS_FILE" ] || die "缺少 $CONSTANTS_FILE：无法在安装目录生成 deploy-constants.json"
    cp -a "$CONSTANTS_FILE" "$file" || die "无法把 deploy-constants.json 放进 $DIR"
  fi
  if [ "$(const_raw_from escrow "$file")" = "$ESCROW" ] \
     && [ "$(const_raw_from staking "$file")" = "$STAKING" ] \
     && [ "$(const_raw_from startBlock "$file")" = "$START_BLOCK" ]; then
    return 0
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/marketplace-constants.XXXXXX")" || die "无法创建临时文件"
  if ! sed \
      -e "s/\(\"escrow\"[[:space:]]*:[[:space:]]*\)\"[^\"]*\"/\1\"$ESCROW\"/" \
      -e "s/\(\"staking\"[[:space:]]*:[[:space:]]*\)\"[^\"]*\"/\1\"$STAKING\"/" \
      -e "s/\(\"startBlock\"[[:space:]]*:[[:space:]]*\)[0-9][0-9]*/\1$START_BLOCK/" \
      "$file" > "$tmp"; then
    rm -f "$tmp"
    die "写回 $file 失败（sed）"
  fi
  if ! cat "$tmp" > "$file"; then
    rm -f "$tmp"
    die "写回 $file 失败（写入）"
  fi
  rm -f "$tmp"
  [ "$(const_raw_from escrow "$file")" = "$ESCROW" ] \
    && [ "$(const_raw_from staking "$file")" = "$STAKING" ] \
    && [ "$(const_raw_from startBlock "$file")" = "$START_BLOCK" ] \
    || die "写回 $file 后核对不一致（escrow/staking/startBlock）"
}

CADDY_IMAGE='caddy:2-alpine'

MODE=install
DRY_RUN=0; ASSUME_YES=0; FORCE=0; NO_DOMAIN=0; PULL=0
OWNER=''; DOMAIN=''; EMAIL=''; PORT=''; DIR=''; SERVICE=''; VOLUME=''; IMAGE=''
TLS_MODE=''; TLS_MODE_GIVEN=0; BIND=''; BIND_GIVEN=0; DIR_GIVEN=0
# 本节点合约三项：命令行显式值优先于 deploy-constants.json，供一行安装把值带进来。
ESCROW_ARG=''; STAKING_ARG=''; START_BLOCK_ARG=''
# MySQL：默认交互询问；--db-mode 供非交互/自动化显式选择。
# external = 用户已有的 MySQL；container = 本脚本部署一个仅节点可达的 MySQL 容器。
DB_MODE=''; DB_MODE_GIVEN=0
DB_HOST_VALUE=''; DB_PORT_VALUE=''; DB_NAME=''; DB_USER=''; DB_PASSWORD=''
DB_CONTAINER=''; DB_VOLUME=''; DB_IMAGE=''; DB_ROOT_PASSWORD=''
REDIS_URL_VALUE="${MK_REDIS_URL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --owner) OWNER="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; DIR_GIVEN=1; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --volume) VOLUME="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --escrow) ESCROW_ARG="${2:-}"; shift 2 ;;
    --staking) STAKING_ARG="${2:-}"; shift 2 ;;
    --start-block) START_BLOCK_ARG="${2:-}"; shift 2 ;;
    --tls-mode) TLS_MODE="${2:-}"; TLS_MODE_GIVEN=1; shift 2 ;;
    --no-tls) TLS_MODE=none; TLS_MODE_GIVEN=1; shift ;;
    # 发布到哪个宿主地址：默认跟着 TLS 方式走（配了 TLS 就只绑本机，让本机反代访问；
    # 不配 TLS 就绑 0.0.0.0，因为外部负载均衡要从**私网 IP** 连进来，绑 127.0.0.1 它就连不上）。
    # 需要收紧时显式指定，例如同机已有 nginx 反代：--bind 127.0.0.1
    --bind) BIND="${2:-}"; BIND_GIVEN=1; shift 2 ;;
    --no-domain) NO_DOMAIN=1; shift ;;
    --db-mode) DB_MODE="${2:-}"; DB_MODE_GIVEN=1; shift 2 ;;
    --db-host) DB_HOST_VALUE="${2:-}"; shift 2 ;;
    --db-port) DB_PORT_VALUE="${2:-}"; shift 2 ;;
    --db-name) DB_NAME="${2:-}"; shift 2 ;;
    --db-user) DB_USER="${2:-}"; shift 2 ;;
    # 密码也可用环境变量 MK_DB_PASSWORD 传入（避免出现在 shell history / ps 参数里）
    --db-password) DB_PASSWORD="${2:-}"; shift 2 ;;
    --db-container) DB_CONTAINER="${2:-}"; shift 2 ;;
    --db-volume) DB_VOLUME="${2:-}"; shift 2 ;;
    --db-image) DB_IMAGE="${2:-}"; shift 2 ;;
    # Redis 是节点硬依赖：外部 Redis 的 URL（密码不要出现在命令行历史里，优先用 MK_REDIS_URL）
    --redis-url) REDIS_URL_VALUE="${2:-}"; shift 2 ;;
    --pull) PULL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --status|--health|--update|--uninstall|--purge) MODE="${1#--}"; shift ;;
    -h|--help) MODE=help; shift ;;
    *) printf '未知参数：%s（bash deploy.sh --help）\n' "$1" >&2; exit 2 ;;
  esac
done

# --help 只打印文件头那段注释（不能写死行号：上一版按 '2,57p' 取行，头部一改就把下面的
# 代码行也当帮助打出来了 —— 用"遇到第一行非注释就停"的规则，头部怎么改都不会漏出代码）。
# 放在读常量与平台探测之前：全新 checkout 上也能先看用法。
if [ "$MODE" = help ]; then
  awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  exit 0
fi

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

# 密码：交互时隐藏输入；非交互只接受环境变量，绝不把密码放到 argv（ps 可见）。
ask_secret() {
  local p="$1" env_name="$2" a=''
  if [ "$TTY" = 0 ]; then
    a="${!env_name:-}"
    [ -n "$a" ] || die "非交互环境缺少密码：请设置环境变量 $env_name（不要用 --db-password，密码会出现在 ps/history）"
    printf '%s' "$a"; return 0
  fi
  printf '%s' "$p" >&2
  IFS= read -r -s a || true
  printf '\n' >&2
  [ -n "$a" ] || die "密码不能为空"
  printf '%s' "$a"
}

random_secret() {
  local n="${1:-24}" v=''
  if have openssl; then
    v="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$n")"
  elif [ -r /dev/urandom ]; then
    v="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$n")"
  fi
  [ "${#v}" -ge "$n" ] || die "无法生成强随机密码（需要 openssl 或 /dev/urandom）"
  printf '%s' "$v"
}

# MySQL 标识符只接受保守字符集：它既要进 SQL（由镜像初始化器使用），也要进 .env。
valid_db_id() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_]+$'; }

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

# ── 宿主平台探测：**平台判据的唯一一层**（见 platform.sh 文件头）──────────────
# 为什么在这里探测一次：这台机器是 Linux 还是 macOS、用哪个包管理器装 Docker、要不要 root、
# 安装目录默认放哪、--tls-mode nginx 能不能用 —— 这些结论在第 ①④⑤⑧ 步都要用。
# 散着判就会变成"每个调用点各判一次"，而新增一种宿主时永远判不全（这正是本仓忌讳的形状）。
if [ -r "$HERE/platform.sh" ]; then
  # shellcheck source=platform.sh
  . "$HERE/platform.sh"
else
  die "缺少 $HERE/platform.sh（宿主平台适配层）—— 安装包不完整，请重新获取完整代码后再跑"
fi
host_probe

case "$MODE" in status|health|update|uninstall|purge) ;; *) MODE=install ;; esac

# ── 目录/名字/端口的默认值 ──
if [ "${DIR_GIVEN}" = 0 ]; then
  if [ "$IN_REPO" = 1 ]; then DIR="$HERE"
  else
    # 默认安装目录由平台决定：Linux 上"有 root/sudo"才用 /opt（有 FHS 约定），
    # macOS 上永远用 $HOME（那里没有 /opt 约定，往系统目录装东西属于越权改系统）。
    CAN_ROOT=0
    [ "$(id -u)" -eq 0 ] && CAN_ROOT=1
    [ "$CAN_ROOT" = 0 ] && [ ${#SUDO[@]} -gt 0 ] && sudo -n true 2>/dev/null && CAN_ROOT=1
    DIR="$(host_default_dir "$CAN_ROOT")"
  fi
fi
STATE_FILE="$DIR/.deploy-state"
# 已有安装优先沿用状态文件里的名字/端口（--update/--status/--uninstall 不必重复给）
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  [ -n "${STATE_SERVICE:-}" ] && [ -z "$SERVICE" ] && SERVICE="$STATE_SERVICE"
  [ -n "${STATE_PORT:-}" ] && [ -z "$PORT" ] && PORT="$STATE_PORT"
  [ -n "${STATE_VOLUME:-}" ] && [ -z "$VOLUME" ] && VOLUME="$STATE_VOLUME"
  # 镜像名也是安装状态：带 --image 装过一次后，--update 不能悄悄退回 marketplace-node:latest
  # （同机第二个节点会用同一个 tag，先更新谁谁生效）。
  [ -n "${STATE_IMAGE:-}" ] && [ -z "$IMAGE" ] && IMAGE="$STATE_IMAGE"
  [ -n "${STATE_TLS:-}" ] && [ -z "$TLS_MODE" ] && TLS_MODE="$STATE_TLS"
  # 邮箱没有对应的 .env 键（证书在 Caddy/宿主 nginx 那一侧），只能记在状态文件里：
  # 不记的话 --update --yes 每次都会把 Caddyfile 的 email 写成占位地址。
  [ -n "${STATE_EMAIL:-}" ] && [ -z "$EMAIL" ] && EMAIL="$STATE_EMAIL"
  # 绑定地址同理：不记住的话，给 nginx 用的 --bind 127.0.0.1 会在下次 --update 时
  # 悄悄退回默认的 0.0.0.0（把节点暴露到所有网卡上——安全性的倒退不能靠人记得加参数）
  [ -n "${STATE_BIND:-}" ] && [ -z "$BIND" ] && BIND="$STATE_BIND"
  [ -n "${STATE_DB_MODE:-}" ] && [ -z "$DB_MODE" ] && DB_MODE="$STATE_DB_MODE"
  [ -n "${STATE_DB_CONTAINER:-}" ] && [ -z "$DB_CONTAINER" ] && DB_CONTAINER="$STATE_DB_CONTAINER"
  [ -n "${STATE_DB_VOLUME:-}" ] && [ -z "$DB_VOLUME" ] && DB_VOLUME="$STATE_DB_VOLUME"
  [ -n "${STATE_DB_IMAGE:-}" ] && [ -z "$DB_IMAGE" ] && DB_IMAGE="$STATE_DB_IMAGE"
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
# MySQL：容器模式的名字/卷/镜像。显式 --db-* 优先，其次状态文件，最后按服务名派生。
DB_CONTAINER="${DB_CONTAINER:-${SERVICE}-mysql}"
DB_VOLUME="${DB_VOLUME:-${SERVICE}-mysql-data}"
DB_IMAGE="${DB_IMAGE:-mysql:8.4}"
DB_NETWORK="$NETWORK"
DB_ROOT_FILE="$DIR/.mysql-root"
ENV_FILE="$DIR/.env"
UNIT_LEGACY="/etc/systemd/system/$SERVICE.service"

# ── 端口判据（挂在这个唯一入口上，不是散在各调用点）─────────────────────────
# 为什么在**这里**判：这两个毛病（端口非法 / 撞 8080）都是"输入就不该被接受"，
# 而它们的症状（docker run 失败、与同机别的服务抢端口）要等到第 ⑥ 步才暴露——
# 那时镜像已经建好了、卷已经建好了，店主看到的是"节点起不来"而不是"你填的端口不行"。
case "$PORT" in
  ''|*[!0-9]*) die "端口非法：'$PORT'（要 1-65535 的十进制整数）" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "端口越界：$PORT（1-65535）"; fi
if [ "$PORT" -eq 8080 ]; then
  # 8080 是本机开发的默认端口，同机也很可能被别的东西占着（正式站上 `cs-agent-api` 就绑在
  # 127.0.0.1:8080）——这是**静态判据**，不依赖本机现状：现在空着不代表下次也空着，
  # 而"两个服务抢同一个端口"的代价（谁的容器先起来谁赢）落在别人身上。
  die "别用 8080：本机开发的默认端口，同机常被别的服务占着（正式站的 cs-agent-api 就在 127.0.0.1:8080）。换一个，例如 --port 8090"
fi

# =============================================================================
# ① 环境检测的横幅对 --health **不打**：那个模式是给监控/cron 用的，输出必须只有一行结论
# （多几行就会把"看一行就知道死没死"这件事毁掉）。--status 保留横幅，它本来就是给人看的。
if [ "$MODE" != health ]; then
  step "① 环境检测"
  case "$MK_HOST_OS" in
    linux|macos)
      info "系统：$MK_HOST_VER（包管理器：$MK_HOST_PM  服务管理：$MK_HOST_INIT）"
      info "目录：$DIR    容器：$SERVICE    端口：$PORT    数据卷：$VOLUME"
      ;;
    windows)
      # 这条路径不是"以后再做"，而是**在 Windows 上本来就是错的**：bash 下的 $DIR 是
      # MSYS 路径（/c/Users/…），交给 docker.exe 会被当 Linux 路径解释，构建上下文与
      # bind mount 全错。所以这里不是拒绝支持 Windows，而是把 Windows 交给对的入口。
      die "Windows 上请用 deploy.ps1（PowerShell）：节点直接跑在 Windows 上，不需要容器。
    在 PowerShell 里执行：  .\\deploy.ps1
    （在 Git Bash / WSL 里跑本脚本得到的路径与 docker 的路径语义不一致，会把构建上下文和挂载指错）"
      ;;
    *) die "无法识别的宿主系统（$MK_HOST_VER）—— 本脚本支持 Linux 与 macOS；Windows 请用 deploy.ps1" ;;
  esac
else
  case "$MK_HOST_OS" in
    linux|macos) ;;
    windows) die "Windows 上请用 PowerShell 版：.\\deploy.ps1" ;;
    *) die "无法识别的宿主系统（$MK_HOST_VER）" ;;
  esac
fi

ensure_docker() {
  if have docker && dk info >/dev/null 2>&1; then
    ok "Docker 可用：$(dk --version 2>/dev/null | awk '{print $3}')（守护进程正常）"
    return 0
  fi
  step "安装 / 启动 Docker"
  if [ "$DRY_RUN" = 1 ]; then
    if have docker; then info "[dry-run] 将启动 Docker 守护进程"
    else info "[dry-run] 将安装 Docker（宿主：$MK_HOST_VER，包管理器：$MK_HOST_PM）"; fi
    return 0
  fi
  # 装：由适配层按包管理器分派（macOS 不自动装、容器内不装、不可变宿主不装，都只给指引）
  if ! have docker; then
    info "安装 Docker（$MK_HOST_PM）…"
    host_install_docker "${SUDO[*]}" || {
      have docker || { host_docker_install_hint; die "本机没有可用的 Docker，且无法自动安装（见上面的指引）"; }
    }
    have docker || { host_docker_install_hint; die "安装后仍找不到 docker"; }
  fi
  host_start_docker dk "${SUDO[*]}" || die "Docker 守护进程没起来（看 journalctl -u docker / tail /var/log/docker.log）"
  ok "Docker 已就绪：$(dk --version 2>/dev/null | awk '{print $3}')"
  # 免 sudo 用 docker（仅 Linux 有意义；macOS 上 docker 走用户自己的 socket，没有 docker 组）
  local granted
  granted="$(host_grant_docker "${SUDO[*]}")"
  [ -n "$granted" ] && warn "已把 $granted 加入 docker 组 —— **重新登录一次**之后才不用 sudo（本次部署继续用 sudo）"
  return 0
}

# ── 旧版（宿主安装）的残留：只提示，不自动删（那是回滚点，也可能是别人的东西）──
check_legacy_host_install() {
  if host_supports_systemd_legacy && [ -f "$UNIT_LEGACY" ]; then
    warn "检测到宿主机上还有旧版的 systemd 单元 $UNIT_LEGACY（上一版是宿主安装）——"
    warn "  本脚本不再使用它。容器版跑通后可自行清理："
    warn "    sudo systemctl disable --now $SERVICE && sudo rm -f $UNIT_LEGACY && sudo systemctl daemon-reload"
  fi
  if have node; then
    info "宿主机上已有 Node（$(node -v 2>/dev/null)）——本脚本不需要它，也不会改动它"
  fi
}

# ── MySQL 选择：用户已有的外部库，或本脚本用 Docker 起一个只对节点网络可见的库 ──
# 设计判据：
#   · 外部库：用户输入 host/port/name/user/password；脚本只写 .env，不碰对方的库；
#   · 内置库：命名卷（不是 bind mount）+ 用户自定义网络，**不发布 3306 到宿主**；
#     MySQL 镜像用 MYSQL_DATABASE/MYSQL_USER 初始化，应用账号只拥有该库；
#   · 已有安装：从 .env/状态文件沿用，绝不重新询问或悄悄换库；要换库只能显式改 .env 后重建。
db_config_from_env() {
  [ -f "$ENV_FILE" ] || return 0
  local host port name user pass
  host="$(env_val MK_DB_HOST)"
  [ -n "$host" ] || return 0
  port="$(env_val MK_DB_PORT)"; name="$(env_val MK_DB_NAME)"
  user="$(env_val MK_DB_USER)"; pass="$(env_val MK_DB_PASSWORD)"
  DB_HOST_VALUE="${DB_HOST_VALUE:-$host}"
  DB_PORT_VALUE="${DB_PORT_VALUE:-$port}"
  DB_NAME="${DB_NAME:-$name}"
  DB_USER="${DB_USER:-$user}"
  DB_PASSWORD="${DB_PASSWORD:-$pass}"
  [ -z "$DB_MODE" ] || return 0
  if [ "$host" = "$DB_CONTAINER" ] || [ "${STATE_DB_MODE:-}" = container ]; then
    DB_MODE=container
  else
    DB_MODE=external
  fi
}

# 宿主机上是否已经有一台在跑的 MySQL。只用于“不要重复安装”的决策，
# 不拿它猜账号/密码：检测到也必须由部署者确认是否使用、并填连接。
detect_local_mysql() {
  if have mysqladmin && mysqladmin ping -h 127.0.0.1 --silent >/dev/null 2>&1; then
    return 0
  fi
  if (echo >/dev/tcp/127.0.0.1/3306) >/dev/null 2>&1; then
    return 0
  fi
  if have systemctl; then
    local s
    for s in mysql mysqld mariadb; do
      systemctl is-active --quiet "$s" 2>/dev/null && return 0
    done
  fi
  return 1
}

parse_db_host() {  local raw="$1" host port
  raw="${raw#mysql://}"
  raw="${raw%%/*}"
  case "$raw" in
    *@*) die "MySQL 地址里不要写账号/密码（会出现在历史与进程列表里）；host 与账号分项输入" ;;
  esac
  if printf '%s' "$raw" | grep -Eq '^\[[^]]+\](:[0-9]+)?$'; then
    host="$(printf '%s' "$raw" | sed -E 's/^\[([^]]+)\].*/\1/')"
    port="$(printf '%s' "$raw" | sed -nE 's/^\[[^]]+\]:([0-9]+)$/\1/p')"
  elif printf '%s' "$raw" | grep -Eq '^[^:]+:[0-9]+$'; then
    host="${raw%:*}"; port="${raw##*:}"
  else
    host="$raw"; port=''
  fi
  [ -n "$host" ] || die "MySQL 地址不能为空"
  printf '%s' "$host" | grep -Eq '^[A-Za-z0-9._-]+$' || die "MySQL 地址含非法字符：$host（只收主机名/IP，可带 :端口）"
  DB_HOST_VALUE="$host"
  if [ -n "$port" ]; then DB_PORT_VALUE="$port"; fi
  return 0
}

resolve_db_config() {
  db_config_from_env
  local host_mysql=0
  if [ -z "$DB_MODE" ] && detect_local_mysql; then
    host_mysql=1
  fi
  if [ -n "$DB_MODE" ] && ! printf '%s' "$DB_MODE" | grep -Eq '^(external|container)$'; then
    die "--db-mode 只能是 external 或 container，当前 '$DB_MODE'"
  fi
  # 已有安装：模式已经由 .env/状态确定；显式换模式会指向另一套数据，直接拒绝。
  if [ -f "$ENV_FILE" ] && [ -n "${STATE_DB_MODE:-}" ] && [ "$DB_MODE_GIVEN" = 1 ] && [ "$DB_MODE" != "$STATE_DB_MODE" ]; then
    die "已有安装在用 db-mode=$STATE_DB_MODE，不能在 --update 时改成 $DB_MODE；换库请先备份并显式迁移"
  fi
  # 已有同名 MySQL 容器：复用，不重新安装（即使 .env 丢了也不该再起一套）。
  if [ -z "$DB_MODE" ] && dk inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    DB_MODE=container
    DB_NAME="${DB_NAME:-$(dk inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DB_CONTAINER" 2>/dev/null | sed -n 's/^MYSQL_DATABASE=//p' | head -1)}"
    DB_USER="${DB_USER:-$(dk inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DB_CONTAINER" 2>/dev/null | sed -n 's/^MYSQL_USER=//p' | head -1)}"
    DB_PASSWORD="${DB_PASSWORD:-$(dk inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DB_CONTAINER" 2>/dev/null | sed -n 's/^MYSQL_PASSWORD=//p' | head -1)}"
    info "检测到已有 MySQL 容器 $DB_CONTAINER：复用，不重新安装"
  fi
  if [ -z "$DB_MODE" ]; then
    if [ "$host_mysql" = 1 ]; then
      info "检测到本机已有 MySQL（127.0.0.1:3306 或 mysql 服务在运行）"
      if [ "$ASSUME_YES" = 1 ]; then
        die "检测到本机已有 MySQL，但非交互没有指定用哪套库；拒绝自动再装一个。请用 --db-mode external --db-host … --db-name … --db-user …（密码用 MK_DB_PASSWORD）使用已有库，或显式 --db-mode container 新建"
      fi
      local a
      a="$(ask '  直接使用这台已有的 MySQL？[Y/n] ' 'y' '已有 MySQL 选择')"
      case "$a" in n|N|no|NO) DB_MODE=container ;; *) DB_MODE=external ;; esac
    elif [ "$ASSUME_YES" = 1 ]; then
      DB_MODE=container
      info "非交互未指定 --db-mode：默认由本脚本部署 MySQL 容器（$DB_CONTAINER）"
    else
      local a
      a="$(ask '  你有自己的 MySQL 8 吗？[y/N] ' 'n' 'MySQL 选择（y=已有，N=本脚本部署）')"
      case "$a" in y|Y|yes|YES) DB_MODE=external ;; *) DB_MODE=container ;; esac
    fi
  fi
  if [ "$DB_MODE" = container ]; then
    DB_HOST_VALUE="$DB_CONTAINER"
    DB_PORT_VALUE="${DB_PORT_VALUE:-3306}"
    DB_NAME="${DB_NAME:-mk_${SERVICE//[^A-Za-z0-9_]/_}}"
    DB_USER="${DB_USER:-mknode}"
    DB_PASSWORD="${DB_PASSWORD:-$(random_secret 24)}"
    if [ -f "$DB_ROOT_FILE" ]; then
      DB_ROOT_PASSWORD="$(cat "$DB_ROOT_FILE")"
    elif dk inspect "$DB_CONTAINER" >/dev/null 2>&1; then
      DB_ROOT_PASSWORD="$(dk inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DB_CONTAINER" 2>/dev/null | sed -n 's/^MYSQL_ROOT_PASSWORD=//p' | head -1)"
    else
      DB_ROOT_PASSWORD="$(random_secret 32)"
    fi
  else
    local default_host=''
    [ "$host_mysql" = 1 ] && default_host='host.docker.internal'
    [ -n "$DB_HOST_VALUE" ] || DB_HOST_VALUE="$(ask '  MySQL 地址（host 或 host:port）: ' "$default_host" 'MySQL 地址')"
    parse_db_host "$DB_HOST_VALUE"
    DB_PORT_VALUE="${DB_PORT_VALUE:-3306}"
    [ -n "$DB_NAME" ] || DB_NAME="$(ask '  数据库名: ' '' 'MySQL 库名')"
    [ -n "$DB_USER" ] || DB_USER="$(ask '  用户名: ' '' 'MySQL 用户名')"
    [ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(ask_secret '  密码（输入不显示）: ' MK_DB_PASSWORD)"
  fi
  valid_db_id "$DB_NAME" || die "数据库名只能包含字母/数字/下划线：$DB_NAME"
  valid_db_id "$DB_USER" || die "MySQL 用户名只能包含字母/数字/下划线：$DB_USER"
  printf '%s' "$DB_PORT_VALUE" | grep -Eq '^[0-9]+$' || die "MySQL 端口非法：$DB_PORT_VALUE"
  [ "$DB_PORT_VALUE" -ge 1 ] && [ "$DB_PORT_VALUE" -le 65535 ] || die "MySQL 端口越界：$DB_PORT_VALUE"
  [ -n "$DB_PASSWORD" ] || die "MySQL 密码不能为空"
  case "$DB_PASSWORD" in *$'\n'*|*$'\r'*) die "MySQL 密码不能包含换行" ;; esac
  if [ "$DB_MODE" = external ]; then
    case "$DB_HOST_VALUE" in 127.0.0.1|localhost|::1)
      warn "外部 MySQL 地址是 $DB_HOST_VALUE：容器里的 127.0.0.1 指容器自己；若库在宿主上，请填宿主可达 IP 并确认 bind-address"
      ;;
    esac
  fi
}

ensure_mysql_container() {
  [ "$DB_MODE" = container ] || return 0
  if [ -z "$DB_ROOT_PASSWORD" ] && [ -f "$DB_ROOT_FILE" ]; then
    DB_ROOT_PASSWORD="$(cat "$DB_ROOT_FILE")"
  fi
  if [ -z "$DB_ROOT_PASSWORD" ] && dk inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    DB_ROOT_PASSWORD="$(dk inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DB_CONTAINER" 2>/dev/null | sed -n 's/^MYSQL_ROOT_PASSWORD=//p' | head -1)"
  fi
  dk network inspect "$DB_NETWORK" >/dev/null 2>&1 || dk network create "$DB_NETWORK" >/dev/null
  dk volume inspect "$DB_VOLUME" >/dev/null 2>&1 || dk volume create "$DB_VOLUME" >/dev/null
  if ! dk image inspect "$DB_IMAGE" >/dev/null 2>&1; then
    info "拉取 MySQL 镜像 $DB_IMAGE（首次约数百 MB）…"
    if have timeout; then
      timeout 300 "${SUDO[@]}" docker pull "$DB_IMAGE" >/dev/null || die "拉取 $DB_IMAGE 失败/超时（检查 Docker 镜像源；不会带着半截镜像启动）"
    else
      "${SUDO[@]}" docker pull "$DB_IMAGE" >/dev/null || die "拉取 $DB_IMAGE 失败（检查 Docker 镜像源）"
    fi
  fi
  if dk inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    if [ "$(dk inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null || true)" != true ]; then
      info "启动已有 MySQL 容器：$DB_CONTAINER"
      dk start "$DB_CONTAINER" >/dev/null
    else
      info "复用已有 MySQL 容器：$DB_CONTAINER"
    fi
  else
    [ -n "$DB_ROOT_PASSWORD" ] || DB_ROOT_PASSWORD="$(random_secret 32)"
    info "创建 MySQL 容器：$DB_CONTAINER（镜像 $DB_IMAGE，卷 $DB_VOLUME，仅加入网络 $DB_NETWORK）"
    dk run -d --name "$DB_CONTAINER" \
      --restart unless-stopped \
      --network "$DB_NETWORK" \
      -e MYSQL_ROOT_PASSWORD="$DB_ROOT_PASSWORD" \
      -e MYSQL_DATABASE="$DB_NAME" \
      -e MYSQL_USER="$DB_USER" \
      -e MYSQL_PASSWORD="$DB_PASSWORD" \
      -v "$DB_VOLUME:/var/lib/mysql" \
      "$DB_IMAGE" \
      --character-set-server=utf8mb4 \
      --collation-server=utf8mb4_0900_as_cs \
      --log-bin-trust-function-creators=1 >/dev/null || die "MySQL 容器启动失败（看上面的 docker 输出；镜像 $DB_IMAGE 拉取失败也会这样）"
  fi
  local i ok=0
  for i in $(seq 1 60); do
    if dk exec "$DB_CONTAINER" mysqladmin ping -h 127.0.0.1 -uroot -p"$DB_ROOT_PASSWORD" --silent >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" != 1 ]; then
    dk logs --tail 30 "$DB_CONTAINER" 2>&1 | sed 's/^/    /' || true
    die "MySQL 容器 120 秒内没有就绪（$DB_CONTAINER）"
  fi
  if ! dk exec -e MYSQL_PWD="$DB_PASSWORD" "$DB_CONTAINER" \
      mysql -h127.0.0.1 -u"$DB_USER" "$DB_NAME" -e 'SELECT 1' >/dev/null 2>&1; then
    die "MySQL 已启动，但应用账号 $DB_USER 无法访问库 $DB_NAME（卷里是另一套旧账号？换库请显式备份/迁移）"
  fi
  # 节点启动时会执行 SET SESSION binlog_row_image='MINIMAL'。MySQL 8 的库级 ALL 不包含
  # 这个全局动态权限；不给的话节点会在 initDb() 里 ER_SPECIFIC_ACCESS_DENIED_ERROR 反复重启。
  if ! dk exec -e MYSQL_PWD="$DB_ROOT_PASSWORD" "$DB_CONTAINER" \
      mysql -uroot -e "ALTER DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
        GRANT SESSION_VARIABLES_ADMIN ON *.* TO '$DB_USER'@'%';
        -- 内置库只服务本节点；节点会在临时库重放完整 schema（含触发器/视图），
        -- 因此应用账号需要在这个隔离容器内拥有建库/建触发器/建视图的权限。
        GRANT ALL PRIVILEGES ON *.* TO '$DB_USER'@'%';" >/dev/null 2>&1; then
    die "无法初始化 MySQL 应用账号权限（$DB_USER）：需要 SESSION_VARIABLES_ADMIN 与临时探针库权限"
  fi
  ok "MySQL 就绪：$DB_CONTAINER / $DB_NAME（仅容器网络可达，不发布 3306）"
  if [ ! -f "$DB_ROOT_FILE" ]; then
    umask 077
    printf '%s\n' "$DB_ROOT_PASSWORD" > "$DB_ROOT_FILE"
    chmod 600 "$DB_ROOT_FILE" 2>/dev/null || true
    info "MySQL root 密码保存在 $DB_ROOT_FILE（0600；备份/恢复需要，不要删）"
  fi
}


if [ "$MODE" != status ] && [ "$MODE" != health ] && [ "$MODE" != uninstall ] && [ "$MODE" != purge ]; then
  # 合约常量在**刷新代码之前**解析：安装目录里那份是节点身份，新代码包里的空模板不能覆盖它；
  # 读不到/不合法在动任何代码之前就拒绝。
  # --help/--status/--health/--uninstall/--purge 在读常量之前就已经返回。
  load_deploy_constants
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
    # 容器不存在/没在跑时，端口 $PORT 上可能是**别的**服务；此时探活会给出假阳性。
    case "$STATE" in
      running/*) ;;
      *) warn "不健康：容器 $STATE（预期的 $CONTAINER 不在运行）；未探活"; exit 2 ;;
    esac
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
  if [ "$DB_MODE" = container ]; then
    dk ps -a --filter "name=^${DB_CONTAINER}\$" --format '  MySQL：{{.Names}}  状态：{{.Status}}' || true
    dk volume inspect "$DB_VOLUME" --format '  MySQL 数据卷：{{.Name}}' 2>/dev/null || warn "MySQL 数据卷 $DB_VOLUME 不存在"
  elif [ -n "$DB_MODE" ]; then
    info "MySQL：外部 $DB_HOST_VALUE:$DB_PORT_VALUE/$DB_NAME（脚本不管它）"
  fi
  if [ -f "$ENV_FILE" ]; then
    info "配置：$ENV_FILE（$(grep -c . "$ENV_FILE") 行；密钥不在脚本这一侧）"
    grep -E '^(MK_PORT|MK_SHOP_OWNER|MK_ESCROW_START_BLOCK|MK_CORS_ORIGIN|MK_BTY_TTL_MS)=' "$ENV_FILE" | sed 's/^/    /' || true
  else
    warn "配置不存在：$ENV_FILE"
  fi
  RUNNING=0
  if dk ps --filter "name=^${CONTAINER}\$" --format '{{.Names}}' | grep -q .; then
    RUNNING=1
    info "健康状态：$(dk inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}（无 healthcheck）{{end}}' "$CONTAINER" 2>/dev/null)"
    info "最近日志："
    dk logs --tail 20 "$CONTAINER" 2>&1 | sed 's/^/    /' || true
  fi
  step "探活"
  if [ "$RUNNING" != 1 ]; then
    # 容器没在跑时不要探端口：那个端口上可能是同机另一个服务，会给出"健康"的假阳性。
    warn "容器 $CONTAINER 不在运行：跳过探活（端口 $PORT 上可能是别的服务）"
    exit 2
  fi
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
    warn "==--purge：会**删除数据卷 $VOLUME**（附件与商品媒体全没）$( [ "$DB_MODE" = container ] && printf '与 MySQL 数据卷 %s' "$DB_VOLUME" )—— 不可逆 =="
    if [ "$ASSUME_YES" != 1 ]; then
      log "  确认请输入卷名：$VOLUME"
      CONFIRM="$(ask '  > ' '' '删除数据卷的确认（非交互请加 --yes）')"
      [ "$CONFIRM" = "$VOLUME" ] || die "输入不匹配，什么都没删"
    fi
  fi
  if have docker; then
    dk rm -f "$CONTAINER" >/dev/null 2>&1 && ok "容器已移除：$CONTAINER" || info "容器不存在：$CONTAINER"
    dk rm -f "$CADDY_CONTAINER" >/dev/null 2>&1 && ok "Caddy 容器已移除：$CADDY_CONTAINER" || true
    if [ "$DB_MODE" = container ]; then
      dk rm -f "$DB_CONTAINER" >/dev/null 2>&1 && ok "MySQL 容器已移除：$DB_CONTAINER" || info "MySQL 容器不存在：$DB_CONTAINER"
    fi
    dk network rm "$NETWORK" >/dev/null 2>&1 || true
    if [ "$MODE" = purge ]; then
      dk volume rm "$VOLUME" >/dev/null 2>&1 && ok "数据卷已删除：$VOLUME" || warn "数据卷删除失败（可能还在被别的容器用）"
      if [ "$DB_MODE" = container ]; then
        dk volume rm "$DB_VOLUME" >/dev/null 2>&1 && ok "MySQL 数据卷已删除：$DB_VOLUME" || warn "MySQL 数据卷删除失败（可能还在被别的容器用）"
      fi
      dk volume rm "$CADDY_DATA" "$CADDY_CONFIG" >/dev/null 2>&1 || true
    else
      ok "数据卷保留：$VOLUME（要连数据一起删：bash deploy.sh --purge）"
      [ "$DB_MODE" = container ] && info "MySQL 数据卷保留：$DB_VOLUME（--purge 才会删）"
    fi
  else
    warn "这台机器上没有 docker —— 没什么可卸的"
  fi
  if host_supports_systemd_legacy && [ -f "$UNIT_LEGACY" ]; then
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
      --exclude=node_modules --exclude=.env --exclude='.env.*' \
      --exclude=data --exclude=uploads --exclude=.uploads --exclude=.git \
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

if [ "$MODE" = update ]; then
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
  # 代码就位后，把本次解析出的三项写回安装目录；之后 --update / 重跑安装都不必重复带参数。
  persist_contract_constants
fi

# =============================================================================
# 店主地址 / 域名 / TLS 选择
# =============================================================================
if true; then
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
      log "  节点要挂在哪个域名下？这个域名是你在链上登记的对外身份（endpoint 必须 https）"
      log "  例：shop.example.com     —— 留空 = 先只跑节点、稍后再配（那就还不能被买家发现）"
      log "  注：域名解析到哪台机器由你决定（本机 / 负载均衡 / CDN / 另一台反代都行）"
      DOMAIN="$(ask '  > ' '' '节点域名（用 --domain shop.example.com 指定，或 --no-domain 先不配）')"
    fi
  fi
  DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
  DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')"
  ENDPOINT=''; [ -n "$DOMAIN" ] && ENDPOINT="https://$DOMAIN"
else
  DOMAIN="$(env_val MK_SIWE_DOMAIN)"
  # 与安装路径同一把尺子（去掉协议与路径、转小写）：补登记时这个值会重新签进签名原文，
  # 两种形态会得到两个不同的 endpoint —— 规范化只能有一处口径。
  DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
  DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')"
  ENDPOINT=''; [ -n "$DOMAIN" ] && ENDPOINT="https://$DOMAIN"
  OWNER="$(env_val MK_SHOP_OWNER)"
  [ -n "$ENDPOINT" ] || die "补登记需要域名：现有配置里 MK_SIWE_DOMAIN 为空（先跑 bash deploy.sh --domain 你的域名）"
fi

# ── TLS 方式：**只由 --tls-mode / --no-tls 决定，没有隐式默认** ──────────────
#  域名的含义只有一个：这个节点的对外身份（SIWE 签名原文 + CORS 白名单 + 登记 endpoint）。
#  **证书与它无关** —— TLS 在哪终止，证书就在哪申请（两种拓扑见文件头）。
#  这里刻意不写"有域名就默认在本机申请证书"：那样"我只填个域名、证书自己在别处弄"会被**悄悄
#  解释成**"在本机起 Caddy 去占 80/443 申请证书"，在已有入口的机器上只会留下一条 warn，
#  而店主以为自己配好了。要一键全包就显式 `--tls-mode caddy`。
if true; then
  if [ "$TLS_MODE_GIVEN" = 0 ] && [ -n "$DOMAIN" ]; then
    if [ "$TTY" = 1 ] && [ "$ASSUME_YES" != 1 ]; then
      log ""
      log "  HTTPS 在哪终止？（前端是 https，所以**买家看到的 endpoint 必须是 https**；"
      log "  这不等于证书必须在本机 —— TLS 在哪终止，证书就在哪申请）"
      log "    1) 别处 —— 负载均衡 / CDN / 另一台 nginx 拿域名与证书，转发到本机 http://<本机>:$PORT（默认）"
      log "    2) 本机 Caddy 容器 —— 自动申请与续期 Let's Encrypt，宿主不装任何东西（一键全包）"
      # 「本机宿主 nginx + certbot」这一条是 Linux 发行版的实现（/etc/nginx/conf.d + systemctl +
      # certbot --nginx），在 macOS 上根本不存在这套约定 ⇒ 不列出来，免得店主选了一个必然失败的路。
      if host_supports_nginx_certbot; then
        log "    3) 本机宿主 nginx+certbot —— 会在宿主上装 nginx 与 certbot（只适合干净机器）"
      fi
      ANS="$(ask '  请选择（默认 1）> ' '1' 'HTTPS 终止方式（用 --tls-mode caddy|nginx|none 指定）')"
      case "$ANS" in 2) TLS_MODE=caddy ;; 3) TLS_MODE=nginx ;; *) TLS_MODE=none ;; esac
    else
      TLS_MODE=none
      if [ "$TLS_MODE_GIVEN" = 0 ]; then
        info "本机不申请证书（TLS 方式由外部入口决定）—— 这是**默认**；要让本机自动申请证书请显式给 --tls-mode caddy"
      fi
    fi
  fi
  [ -z "$DOMAIN" ] && TLS_MODE=none
  case "$TLS_MODE" in caddy|nginx|none) ;; *) die "--tls-mode 只能是 caddy / nginx / none（收到：$TLS_MODE）";; esac
  # `--tls-mode nginx` 的实现全是 Linux 发行版的假设：写 /etc/nginx/conf.d、`systemctl reload nginx`、
  # `certbot --nginx`。macOS 上这三样都不成立（nginx 走 brew、没有 conf.d 约定、没有 systemctl）
  # —— 所以这里不是"暂不支持"，而是**这条路在这台机器上本来就是错的**：拒绝，并给出对的写法。
  if [ "$TLS_MODE" = nginx ] && ! host_supports_nginx_certbot; then
    die "--tls-mode nginx 只适用于 Linux（宿主 nginx + certbot 是本脚本的 Linux 实现）。
    这台机器（$MK_HOST_VER）请二选一：
      · 想让本机自动申请证书： --tls-mode caddy --email 你的邮箱
      · 已有 nginx/其它入口在终止 TLS： --tls-mode none --bind 127.0.0.1，再由那个入口反代到本机 $PORT"
  fi
  if [ "$TLS_MODE" != none ] && [ -z "$EMAIL" ] && [ "$ASSUME_YES" != 1 ]; then
    # 邮箱可以合法地留空（certbot 有 --register-unsafely-without-email 这条路），
    # 所以非交互场景不报错、直接留空，只提示一句。
    if [ "$TTY" = 1 ]; then
      EMAIL="$(ask "  证书邮箱（Let's Encrypt 到期提醒用，可留空）> " '')"
    else
      warn "非交互环境：证书邮箱留空（之后可在 $DIR/Caddyfile 改 email 后重启 $CADDY_CONTAINER）"
    fi
  fi
fi

log ""
info "店主地址：$OWNER"
info "对外域名：${ENDPOINT:-（未指定，节点不会被买家发现）}"
info "HTTPS   ：$TLS_MODE"
info "链上登记：稍后到 $FRONTEND 的「开店/登记我的节点」用钱包完成（部署脚本不持私钥）"
info "合约：Escrow=$ESCROW  Staking=$STAKING（本次部署）"
# 域名给了但本机不申请证书时，在这里把"这不等于不能上 https"说清楚（拓扑 A 的定位说明）
if [ -n "$ENDPOINT" ] && [ "$TLS_MODE" = none ]; then
  info "证书    ：本机不申请（TLS 在哪终止、证书就在哪申请 —— 见上面第 ⑧ 步）"
fi

if [ "$DRY_RUN" = 1 ]; then
  step "dry-run：以上是全部计划，未做任何改动"
  info "将构建镜像 $IMAGE（docker build $DIR）"
  info "将创建/复用数据卷 $VOLUME（挂到容器 /data）"
  BIND_PLAN="$BIND"
  [ -n "$BIND_PLAN" ] || { BIND_PLAN='127.0.0.1'; [ "$TLS_MODE" = none ] && BIND_PLAN='0.0.0.0'; }
  info "将起容器 $CONTAINER：--restart unless-stopped -p $BIND_PLAN:$PORT:$CONTAINER_PORT --env-file $ENV_FILE -v $VOLUME:/data"
  if [ "$TLS_MODE" = caddy ]; then
    info "将在本机申请证书：Caddy 容器 $CADDY_CONTAINER 自动申请并续期 Let's Encrypt（$DOMAIN，需 80/443 空闲且可达）"
  elif [ "$TLS_MODE" = nginx ]; then
    info "将在本机申请证书：宿主安装 nginx + certbot 并写 /etc/nginx/conf.d/$SERVICE.conf（只适合干净机器）"
  elif [ -n "$DOMAIN" ]; then
    info "本机**不申请任何证书**：节点只监听 $BIND_PLAN:$PORT，TLS 与证书由你的外部入口终止"
    info "  要让买家看见，还差三步：① 域名 $DOMAIN 解析到那个入口；② 在那个入口上配证书并转发到本机 $PORT；③ 到 $FRONTEND 登记 $ENDPOINT"
  else
    info "未指定域名：本机不申请证书，节点只在 http://127.0.0.1:$PORT 上可访问"
  fi
  info "去掉 --dry-run 即真正执行"
  exit 0
fi

# =============================================================================
step "③ 写配置（$ENV_FILE）"
umask 077
resolve_db_config
# Redis 是硬依赖：升级时沿用已有 .env 的 URL；首次必须显式给 --redis-url 或 MK_REDIS_URL。
if [ -z "$REDIS_URL_VALUE" ] && [ -f "$ENV_FILE" ]; then
  REDIS_URL_VALUE="$(env_val MK_REDIS_URL)"
fi
if [ -z "$REDIS_URL_VALUE" ] && [ "$TTY" = 1 ] && [ "${ASSUME_YES:-0}" != 1 ]; then
  REDIS_URL_VALUE="$(ask '  > ' '' 'Redis 地址（必填，redis://[:密码@]主机:6379/0）')"
fi
[ -n "$REDIS_URL_VALUE" ] || die "Redis 是节点必需依赖：请加 --redis-url redis://[:密码@]主机:6379/0（或先 export MK_REDIS_URL）"
DATA_MOUNT='/data'
KEEP_EXTRA=''
MANAGED_KEYS='MK_PORT MK_SHOP_OWNER MK_RPC_URL MK_CHAIN_ID MK_ESCROW_ADDRESS MK_STAKING_ADDRESS MK_ESCROW_START_BLOCK MK_ESCROW_TIMEOUT_BLOCKS MK_ESCROW_FINALITY_BLOCKS MK_ESCROW_POLL_MS MK_CHAIN_RECONCILE_MS MK_CORS_ORIGIN MK_CORS_ALLOW_ALL MK_ATTACH_DIR MK_AUTO_DELIVER MK_PII_RETENTION_DAYS MK_BTY_TTL_MS MK_DRAFT_TTL_MINUTES MK_REVIEW_TTL_DAYS MK_TOKEN_TTL MK_SIWE_TTL MK_TOKEN_SECRET MK_SIWE_DOMAIN MK_DB_HOST MK_DB_PORT MK_DB_NAME MK_DB_USER MK_DB_PASSWORD MK_REDIS_URL'
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
  # 令牌密钥的生成：**两条路都必须是密码学随机**（它被用作 HMAC 密钥，弱密钥 = 任何人可离线
  # 伪造店主令牌）。openssl 在 macOS 上自带（LibreSSL），但"自带"不等于"一定有"，所以补一条
  # 不依赖外部命令的路 —— 脚本本来就要求宿主有 Node 吗？没有，所以这里也不能假定有 Node。
  # 取舍：优先 openssl；没有就用 /dev/urandom（POSIX，Linux/macOS 都有）；两者都没有才拒绝。
  if have openssl; then
    KEEP_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  elif [ -r /dev/urandom ]; then
    KEEP_SECRET="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 64)"
  else
    die "既没有 openssl 也没有 /dev/urandom，无法生成强随机令牌密钥（MK_TOKEN_SECRET）"
  fi
  [ "${#KEEP_SECRET}" -ge 32 ] || die "生成的令牌密钥长度不足（${#KEEP_SECRET}）—— 拒绝写入弱密钥"
  ok "已生成强随机令牌密钥 MK_TOKEN_SECRET（只写在本机 $ENV_FILE，权限 600）"
else
  ok "沿用已有 MK_TOKEN_SECRET（店主登录态不失效）"
fi
KEEP_BTY_TTL="$(env_val MK_BTY_TTL_MS)"
[ -n "$KEEP_BTY_TTL" ] || KEEP_BTY_TTL=60000
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
MK_STAKING_ADDRESS=$STAKING
MK_ESCROW_START_BLOCK=$START_BLOCK
MK_ESCROW_TIMEOUT_BLOCKS=$(constN MK_ESCROW_TIMEOUT_BLOCKS)
MK_ESCROW_FINALITY_BLOCKS=$(constN MK_ESCROW_FINALITY_BLOCKS)
MK_ESCROW_POLL_MS=$(constN MK_ESCROW_POLL_MS)
MK_CHAIN_RECONCILE_MS=$(constN MK_CHAIN_RECONCILE_MS)
# 谁可以跨域读你的节点：联邦前端（买家聚合） + 你自己的域名
MK_CORS_ORIGIN=$CORS
MK_CORS_ALLOW_ALL=$(constN MK_CORS_ALLOW_ALL)
# 附件与商品媒体在**卷**里：容器删了重建数据也在，这是升级与搬家都不丢附件的前提
MK_ATTACH_DIR=$DATA_MOUNT/attachments
MK_AUTO_DELIVER=$(constN MK_AUTO_DELIVER)
MK_PII_RETENTION_DAYS=$(constN MK_PII_RETENTION_DAYS)
# 优雅关闭：收到 SIGTERM 后节点自己"停止收新连接 → 等在途响应 → 关库 → 退出"的**上限**（毫秒）。
# ⚠️ 它与上面 docker run --stop-timeout $STOP_GRACE 是一对：宽限期必须大于这个值，
# 否则宽限期一到 SIGKILL 就把优雅关闭截断，而日志里已经打了"已关闭"。
# 这条不等式由 node/test/deploy-plan.test.js 对 deploy-constants.json 守着，脚本不重复判。
MK_SHUTDOWN_DRAIN_MS=$(constN MK_SHUTDOWN_DRAIN_MS)
# 行情缓存（毫秒）：官方 BTY-USDT 行情直接决定"买家要付多少 BTY"，所以跟得紧（标价单位就是 USDT）
MK_BTY_TTL_MS=$KEEP_BTY_TTL
MK_DRAFT_TTL_MINUTES=$(constN MK_DRAFT_TTL_MINUTES)
MK_REVIEW_TTL_DAYS=$(constN MK_REVIEW_TTL_DAYS)
MK_TOKEN_TTL=$(constN MK_TOKEN_TTL)
MK_SIWE_TTL=$(constN MK_SIWE_TTL)
MK_TOKEN_SECRET=$KEEP_SECRET
MK_SIWE_DOMAIN=$DOMAIN
# Redis：节点启动时必连；容器内 127.0.0.1 指容器自己，外部 Redis 请填可达的主机名/IP。
MK_REDIS_URL=$REDIS_URL_VALUE
EOF
# 数据库五项单独用 printf 写：密码可能含 $、反引号、反斜杠，不能经过 here-doc 展开。
{
  printf '# 数据库：%s 模式；容器内 127.0.0.1 指容器自己，内置库用容器名互通\n' "$DB_MODE"
  printf 'MK_DB_HOST=%s\n' "$DB_HOST_VALUE"
  printf 'MK_DB_PORT=%s\n' "$DB_PORT_VALUE"
  printf 'MK_DB_NAME=%s\n' "$DB_NAME"
  printf 'MK_DB_USER=%s\n' "$DB_USER"
  printf 'MK_DB_PASSWORD=%s\n' "$DB_PASSWORD"
} >> "$ENV_FILE"
if [ -n "$KEEP_EXTRA" ]; then
  {
    printf '\n# ── 以下配置项不由 deploy.sh 管理，重跑脚本时原样保留 ──\n'
    printf '%s\n' "$KEEP_EXTRA"
  } >> "$ENV_FILE"
  info "沿用你原有的这些配置项：$(printf '%s' "$KEEP_EXTRA" | sed 's/=.*//' | tr '\n' ' ')"
fi
chmod 600 "$ENV_FILE"
ok "配置就绪：$ENV_FILE（$(grep -c . "$ENV_FILE") 行，0600）"
ensure_mysql_container

# =============================================================================
if true; then
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
  info "docker build --pull $DIR …"
  # --pull：基础镜像是浮动标签（node:24-slim），不带它就会复用本机旧层——
  # Node 的安全补丁只随基础镜像走，"--update 重建了"不等于"运行时补丁装上了"。
  dk build --pull -t "$IMAGE" "$DIR" || die "镜像构建失败（看上面的输出；最常见原因：拉不到基础镜像 $BASE_IMAGE —— 服务器出网/Docker 镜像源受限）。**旧容器没有被动过，节点仍在正常服务**"
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
  info "备份（卷内附件与商品媒体）：docker run --rm -v $VOLUME:/data -v \"\$PWD\":/backup --entrypoint tar $IMAGE czf /backup/node-data-\$(date +%F).tar.gz -C /data ."
  info "恢复（卷内附件与商品媒体）：docker run --rm -v $VOLUME:/data -v \"\$PWD\":/backup --entrypoint tar $IMAGE xzf /backup/node-data-YYYY-MM-DD.tar.gz -C /data"
  info "库在 MySQL 里、不在卷内：备份/恢复用 mysqldump / mysql（见 docs/OPERATIONS.md §2、§3）"

  # 起容器（正常路径与回滚路径共用；回滚要用旧镜像 + 同一套网络/端口/卷/配置）
  run_container() {
    local img="$1"
    dk rm -f "$CONTAINER" >/dev/null 2>&1 || true
    dk network inspect "$NETWORK" >/dev/null 2>&1 || dk network create "$NETWORK" >/dev/null
    # 这里**故意不写 `dk run … || return 1`**：真正的原因是"端口被占"时 docker 会先建容器再连网络，
    # 于是留下一个 Created 状态的同名容器；而 `set -e` 会在 run 失败的那一行直接退脚本，
    # 后面任何补救都执行不到（实测：店主看到的只有一行裸的 docker 报错）。
    # 所以失败信息与善后一律在**调用方**处理（见下面的 ⑥ 段）。
    dk run -d --name "$CONTAINER" \
      --restart unless-stopped \
      --stop-timeout "$STOP_GRACE" \
      --network "$NETWORK" --network-alias "$SERVICE" \
      --add-host=host.docker.internal:host-gateway \
      -p "$BIND:$PORT:$CONTAINER_PORT" \
      --env-file "$ENV_FILE" \
      -v "$VOLUME:$DATA_MOUNT" \
      "$img" >/dev/null
  }
  # 探活：返回 0/1，同时把最后一次的 HTTP 码放进 PROBE_CODE。
  # 首次安装要建库、跑完整 schema 自检、等 watcher 第一轮成功；30 秒会把“正在初始化”
  # 误判成“起不来”。默认等 120 秒，可用 MK_DEPLOY_PROBE_SECONDS 覆盖。
  # ⚠️ 判据是 **HTTP 200 + 正文 `"code":0`**：`/healthz` 在后台任务不健康时会返回 503；
  # 只看 HTTP 码会漏掉一半，而漏掉的后果是“发布成功”打印在一个没处理链上事件的节点上。
  probe() {
    local i body timeout="${MK_DEPLOY_PROBE_SECONDS:-120}"
    case "$timeout" in ''|*[!0-9]*|0) timeout=120 ;; esac
    PROBE_CODE=''
    PROBE_BODY=''
    for i in $(seq 1 "$timeout"); do
      body="$(curl -s -m 5 -w '\n%{http_code}' "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
      PROBE_CODE="$(printf '%s' "$body" | tail -n1)"
      if [ "$PROBE_CODE" = "200" ] && printf '%s' "$body" | grep -q '"code":0'; then
        PROBE_BODY="$(printf '%s' "$body" | sed '$d')"
        return 0
      fi
      sleep 1
    done
    PROBE_BODY="$(printf '%s' "${body:-}" | sed '$d')"
    return 1
  }

  # 升级前先落一份库备份：镜像回滚不等于数据回滚。内置 MySQL 容器用 mysqldump
  # --single-transaction；外部库没有可信的本机客户端，只明确告警并给出命令，不假装备份成功。
  if [ "$MODE" = update ]; then
    if [ "$DB_MODE" = container ]; then
      BACKUP_FILE="$DIR/db-backup-$(date -u +%Y%m%d-%H%M%S).sql.gz"
      if dk exec -e MYSQL_PWD="$DB_PASSWORD" "$DB_CONTAINER" \
        mysqldump -u"$DB_USER" --single-transaction --routines --events "$DB_NAME" 2>/dev/null | gzip > "$BACKUP_FILE"; then
        ok "升级前数据库已备份：$BACKUP_FILE"
      else
        rm -f "$BACKUP_FILE"
        warn "升级前数据库备份失败（继续部署，但这次没有可回滚的数据快照）"
      fi
    else
      warn "外部 MySQL 不做自动备份：升级前请先执行 mysqldump（见 node/docs/OPERATIONS.md §2）"
    fi
  fi

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
  # 只在**绑定回环**时自动信任代理：此时外部无法直连节点，请求只能来自宿主 nginx（127.0.0.1）
  # 或同机 Docker 网络里的 Caddy（172.16/12）。绑 0.0.0.0 时无法知道代理网段，保持关闭并让
  # 运维按 docs/OPERATIONS.md 显式配置——不能把“任意客户端可伪造 XFF”当成默认。
  # 用户已显式设置时原样保留（MK_TRUST_PROXY 不在 MANAGED_KEYS 里）。
  if [ "$BIND" = '127.0.0.1' ] && [ -z "$(env_val MK_TRUST_PROXY)" ]; then
    printf 'MK_TRUST_PROXY=loopback,172.16.0.0/12\n' >> "$ENV_FILE"
    info "已启用代理信任：MK_TRUST_PROXY=loopback,172.16.0.0/12（绑定 127.0.0.1，仅本机/Docker 代理可连）"
  fi
  case "$BIND" in
    0.0.0.0|127.0.0.1|'[::]'|'::') ;;
    *) die "--bind 只能是 0.0.0.0 或 127.0.0.1（收到：$BIND）" ;;
  esac
  # 失败**必须自己兜住**（`|| true` 不是"吞错"）：`set -e` 会在 run 失败的那一行直接退脚本，
  # 于是下面的诊断与善后一行都执行不到（实测店主只看到一行裸的 docker 报错，且留下 Created 空壳）。
  # 同时**不让 docker 的退出码漏出去**：本脚本的失败口径只有 die=1 / 用法错=2（`--health` 不健康=2），
  # 漏出 125/127 这类原生码，喂监控的人就得去猜"125 是这个脚本的哪种失败"——退出码也是契约。
  RUN_RC=0
  # 注意别写成 `if ! run_container …; then RUN_RC=$?`：`!` 会把状态取反成 0，拿不到真实码
  run_container "$IMAGE" || RUN_RC=$?
  # 端口被占不会等在最后：`docker run` 直接失败（"failed to bind host port … address already in use"），
  # 而那时**容器名已被占用**（docker 先建容器再连网络），于是这一轮留下一个 Created 状态的同名容器，
  # 下次重跑会撞上"容器已存在"——把"端口被占"这个真原因盖成一句"用 --update 或 --force"。
  # 所以这里显式识别这一类失败：把真原因回显出来，并把这次没起来的空壳清掉（数据在卷里，不受影响）。
  if [ "$RUN_RC" -ne 0 ] && ! dk ps -a --filter "name=^${CONTAINER}$" --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    die "容器没建起来（docker 退出码 $RUN_RC；看上面的 docker 输出）：最常见是**宿主端口 $BIND:$PORT 已被占用**（改 --port，或用 --bind 换绑定地址）"
  fi
  if [ "$(dk inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)" = created ]; then
    # 这一条是**端口被占**最常见的形态：docker 先建容器、再连网络，连不上就留下 Created 空壳。
    # 两条诊断都要给全：docker 的**退出码**（$RUN_RC，例如 125）与容器自己的 State.Error ——
    # 前者是"哪一类失败"，后者是"具体哪一步失败"，缺一个都要让店主去翻上游输出。
    warn "容器创建了但没起来（docker 退出码 $RUN_RC；多半是**端口 $PORT 被占**）—— docker 的原始报错："
    dk inspect -f '{{.State.Error}}' "$CONTAINER" 2>/dev/null | head -c 300 | sed 's/^/    /' || true
    log ""
    log "  换端口：bash deploy.sh --update --port <别的端口>；换绑定地址：--bind 0.0.0.0|127.0.0.1"
    log "  看占用者：ss -lntp | grep ':$PORT\\b'"
    warn "已把这次没起来的空壳清掉，避免下次重跑撞上「容器已存在」（数据卷不受影响）"
    dk rm -f "$CONTAINER" >/dev/null 2>&1 || true
    die "启动失败：宿主端口 $PORT 可能已被占用（上面的 docker 原始报错为准）"
  fi
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
    die "节点没起来：看上面的日志（常见：连不上 MySQL（MK_DB_*）/ 配置里的合约地址被改坏 / 数据卷权限 / 端口被占）"
  fi
  BODY="$(curl -s -m 8 "http://127.0.0.1:$PORT/healthz" || true)"
  ok "探活通过：$BODY"

  step "⑧ HTTPS 的落点（$TLS_MODE）"
  new_section=0
  if [ -n "$DOMAIN" ] && [ "$BIND" = '127.0.0.1' ]; then
    warn "本机**没有申请任何证书**：证书与 HTTPS 由**本机你自己那个反代**负责（这是「本机 nginx 已是入口」那条路）"
    warn "还差两步：① 在你那份 nginx 的 server 块里加一段反代（见下）；② 到 $FRONTEND 登记 endpoint $ENDPOINT"
    info "  在你那份 nginx 的 server 块里加：location / { proxy_pass http://127.0.0.1:$PORT; proxy_set_header Host \$host; proxy_set_header X-Forwarded-Proto \$scheme; }"
    new_section=1
  elif [ -n "$DOMAIN" ]; then
    warn "本机**没有申请任何证书** —— 这不等于不能上 https：TLS 在哪终止，证书就在哪申请。"
    warn "还差三步，买家才看得见你（顺序不能颠倒）："
    warn "  ① 域名（$DOMAIN）：解析到**那台终止 TLS 的机器**（负载均衡 / CDN / 另一台 nginx）"
    warn "  ② 证书与转发：在那台机器上给 $DOMAIN 配好证书，反代到本机 http://<本机>:$PORT"
    warn "  ③ 链上登记：到 $FRONTEND 的「开店/登记我的节点」登记 endpoint $ENDPOINT"
  else
    info "未指定域名：本机不申请证书，节点只在 http://127.0.0.1:$PORT 上可访问（仅本机）"
    info "  之后有域名了：bash deploy.sh --update --domain 你的域名（证书在哪终止随后自己定）"
    new_section=1
  fi
  if [ "$BIND" = '0.0.0.0' ]; then
    warn "端口已监听在所有网卡上 —— 记得放行防火墙/安全组，否则外部入口也连不进来"
    new_section=1
  fi
  if [ "$BIND_GIVEN" = 0 ]; then
    if [ "$BIND" = '0.0.0.0' ]; then
      info "想只对本机暴露：加 --bind 127.0.0.1（这个选择会记进 $STATE_FILE，重跑不会退回 0.0.0.0）"
    else
      info "要让外部入口从别的网卡连进来：加 --bind 0.0.0.0"
    fi
    new_section=1
  fi
  [ "$new_section" = 1 ] && log ""
  if [ "$TLS_MODE" = caddy ]; then
    step "⑧a Caddy 容器（自动 HTTPS）"
    # Caddyfile 是**脚本生成但店主也会手改**的文件（例如换证书邮箱、加 header/日志），
    # 而这里每次部署都整份重写 ⇒ 手改会被静默覆盖。所以先备份一份，并在"确实被改过时"明说：
    # 与 chmod 644 + 挂载进容器（改完 `docker restart …-caddy` 即生效）配套，店主有得回退。
    CADDY_BAK=''
    if [ -f "$DIR/Caddyfile" ]; then
      CADDY_BAK="$DIR/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)"
      cp -a "$DIR/Caddyfile" "$CADDY_BAK" 2>/dev/null || CADDY_BAK=''
    fi
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
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy no-referrer
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		Content-Security-Policy "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src https: blob:; connect-src *"
	}
}
EOF
    chmod 644 "$DIR/Caddyfile"
    if [ -n "$CADDY_BAK" ]; then
      # 与"上一次那份"逐字比对（`cmp -s` 只看有没有差别，不产生输出），再单独判断"差别是否只在时间戳那行"。
      # 不用 `<(...)`：进程替换依赖 /dev/fd，在容器/受限 shell 里不一定有；
      # 也不用 `|| true` 吞掉报错（那会把"比对失败"说成"没改过"）。
      if cmp -s "$CADDY_BAK" "$DIR/Caddyfile"; then
        info "Caddyfile 已重新生成（与上次逐字一致）"
        rm -f "$CADDY_BAK"          # 等价：撤掉备份，不留垃圾
      else
        CADDY_DIFF=''; CADDY_DIFF_RC=0
        # 只看"去掉时间戳那行之后还剩什么差别"：diff 的 `1c1` 行号头与 `---` 分隔行也要一起滤掉，
        # 否则"只差时间戳"会被误判成"内容有变化"（会把店主吓得以为手改被覆盖）。
        # ⚠️ 判据必须看 **diff 自己的退出码**：本脚本开了 pipefail，diff 报错（rc=2）时
        # `$(… | grep …)` 整体非 0，而"过滤后为空"既可能是"只差时间戳"也可能是"diff 报错"——
        # 两者混为一谈就会把"比对失败"说成"没改过"。
        CADDY_DIFF="$(diff "$CADDY_BAK" "$DIR/Caddyfile" 2>&1)" || CADDY_DIFF_RC=$?
        if [ ! -r "$CADDY_BAK" ] || [ ! -r "$DIR/Caddyfile" ]; then
          warn "Caddyfile 比对失败（备份或新文件读不到）—— 无法判断这次有没有覆盖你的手改；上一次那份已备份为：$(basename "$CADDY_BAK")"
        elif [ "$CADDY_DIFF_RC" -eq 0 ]; then
          info "Caddyfile 已重新生成（与上次逐字一致）"
          rm -f "$CADDY_BAK"
        elif [ "$CADDY_DIFF_RC" -eq 1 ]; then
          CADDY_DIFF="$(printf '%s\n' "$CADDY_DIFF" | grep -vE '^([<>-] # 由 deploy\.sh 生成于|[0-9,]+[acd][0-9,]+$|---$)' || true)"
          if [ -n "${CADDY_DIFF//[[:space:]]/}" ]; then
            warn "Caddyfile 被重新生成过（内容有变化）—— 上一次那份已备份为：$(basename "$CADDY_BAK")"
            info "  你手改过的内容（certificate email / header / 日志等）请按需合并回去"
          else
            info "Caddyfile 已重新生成（内容与上次一致，只差那行时间戳）"
            rm -f "$CADDY_BAK"
          fi
        else
          warn "Caddyfile 比对失败（diff 退出码 $CADDY_DIFF_RC）—— 无法判断这次有没有覆盖你的手改；上一次那份已备份为：$(basename "$CADDY_BAK")"
        fi
      fi
      if [ -f "$CADDY_BAK" ]; then
        info "  改完只需重启即生效（它是挂载进容器的文件，不用重建容器）：docker restart $CADDY_CONTAINER"
        info "  想回到备份：cp -a $CADDY_BAK $DIR/Caddyfile && docker restart $CADDY_CONTAINER"
      fi
    fi
    # Caddy 是 TLS 入口，补丁只随镜像走；docker run 在标签已存在时不会重新拉取。
    # 拉取失败不阻断：旧镜像仍能服务，但必须明确告警——不能把"重建了"说成"补丁装上了"。
    dk pull "$CADDY_IMAGE" >/dev/null 2>&1 || warn "拉取 $CADDY_IMAGE 失败，继续使用本机已有镜像（可能不是最新安全版本）"
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
      warn "Caddy 启动失败（拉不到 $CADDY_IMAGE？看上面的输出；本机 80/443 已被别的服务占用也会这样）"
      warn "节点本身已经在跑；想改走「TLS 由既有入口终止」：再跑一次 bash deploy.sh --update --tls-mode none"
      warn "  然后让那个入口把 $DOMAIN 反代到本机 http://<本机>:$PORT（证书在它那边申请）"
    fi
  elif [ "$TLS_MODE" = nginx ]; then
    step "⑧b 宿主 nginx + certbot（**只适合干净机器**）"
    # ── 前置判据：这台机器上已经有别人的 nginx 站点吗？──────────────────────────
    # 为什么必须有这道门（旧形态会**静默**做三件危险的事）：
    #   ① 往 /etc/nginx/conf.d/ 里**再写一个 listen 80 的 server 块** —— 机器上就有第二个
    #      server_name 相同的 80 站点，谁被匹配取决于加载顺序；而下面那次 `systemctl reload nginx`
    #      会把**同机别人**的站点一起 reload（一个写坏的 conf 能让所有站点一起挂）；
    #   ② 用 `certbot --nginx -d $DOMAIN --redirect` 给**同一个域名再申请一张证书**，并在 80 上
    #      加一条重定向规则 —— 这与店主自己那套证书体系是两份真相；
    #   ③ 店主已有的 443 server 块，certbot 的 `--redirect` 会去改它（certbot 改的是**所有**
    #      匹配该域名的 server 块，不是只有我们写的那一个）。
    # 这一条不是"多写一个分支"，而是**判据落在"TLS 由谁终止"上**：
    # 机器上已有 nginx ⇒ TLS 与证书已经在别人手里，本脚本就不该再插一手。
    NGINX_FOREIGN=''
    for d in /etc/nginx/conf.d /etc/nginx/sites-enabled /etc/nginx/vhosts.d; do
      as_root test -d "$d" || continue
      # 不用 GNU find 的 `-printf`（那是 GNU 扩展）：这里要的只是"有哪些别人的站点"，
      # 换成一个空行分隔的 print + tr 即可 —— 少依赖一个非 POSIX 开关。
      NGINX_FOREIGN="$NGINX_FOREIGN$(as_root find "$d" -maxdepth 1 -type f -name '*.conf' ! -name "$SERVICE.conf" -print 2>/dev/null | tr '\n' ' ' || true)"
    done
    CERT_FOREIGN=''
    if as_root test -e "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; then CERT_FOREIGN="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; fi
    if [ -n "$(printf '%s' "$NGINX_FOREIGN" | tr -d ' ')" ]; then
      warn "这台机器上已经有别的 nginx 站点配置："
      warn "  $NGINX_FOREIGN"
      if [ -n "$CERT_FOREIGN" ]; then
        warn "而且 $DOMAIN 的证书已经在（$CERT_FOREIGN）—— 说明你的 https 入口本来就在跑。"
      fi
      log ""
      log "  这里不给你往 conf.d 里再塞一个 server 块（会与上面这些争同一个 server_name，"
      log "  而 certbot 的 --redirect 还会去改它们）。你的拓扑该走这一条："
      log ""
      log "    bash deploy.sh --update --tls-mode none --bind 127.0.0.1 --yes"
      log "      ⇒ 节点只监听 127.0.0.1:$PORT，证书与 https 由你那份 nginx 负责；"
      log "        在它的 server 块里加一段反代即可（不动其它站点）："
      log "          location / {"
      log "            proxy_pass http://127.0.0.1:$PORT;"
      log "            proxy_set_header Host \$host;"
      log "            proxy_set_header X-Forwarded-Proto \$scheme;"
      log "          }"
      log ""
      log "  想让本脚本全权接管证书与 80/443：换一台干净机器，或用 --tls-mode caddy（Caddy 自己占 80/443）。"
      die "本机已有 nginx 站点，--tls-mode nginx 会把它们一起卷进来（见上）"
    fi
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
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
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
STATE_DB_MODE=$DB_MODE
STATE_DB_CONTAINER=$DB_CONTAINER
STATE_DB_VOLUME=$DB_VOLUME
STATE_DB_IMAGE=$DB_IMAGE
STATE_EMAIL=$EMAIL
STATE_BIND=$BIND
STATE_NETWORK=$NETWORK
STATE_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 644 "$STATE_FILE"
fi

# =============================================================================
step "完成"
ok "节点：http://127.0.0.1:$PORT/healthz（容器 $CONTAINER，数据卷 $VOLUME）"
[ -n "$ENDPOINT" ] && ok "对外：$ENDPOINT"
if [ -n "$ENDPOINT" ] && [ "$TLS_MODE" = none ]; then
  log "  （对外地址由**你的入口**提供：本机没申请证书 —— 域名指向哪台机器、证书在哪申请都由你定；"
  log "    入口那边的自检：curl -s $ENDPOINT/healthz 应返回 \"code\":0）"
fi
log ""
log "  还差最后一步：打开 $FRONTEND →「开店/登记我的节点」，用钱包签名完成登记，"
log "  登记后买家才能发现你（没有登记过的节点前端一定看不到——这是刻意的，没有静态兜底列表）。"
log ""
log "  常用命令："
log "    docker logs -f $CONTAINER            # 看日志（容器版没有 systemd 单元）"
log "    bash deploy.sh --health              # 探活（健康时一行结论；不健康才带最近日志）"
log "    bash deploy.sh --update              # 重新构建镜像并用同一个数据卷重建容器（数据不丢）"
log "    docker restart $CONTAINER            # 重启节点"
log "    bash deploy.sh --uninstall           # 停掉并移除容器（数据卷保留）"
log ""
log "  附件与商品媒体都在卷 $VOLUME 里（备份命令见上面 ⑤ 的提示）；库在 MySQL 里，备份用 mysqldump"
log "  店铺资料（店名/公告/店员/通知）登录 $FRONTEND 的卖家面板网页维护，即改即生效"
log ""
log "  建议接着读（都在本目录的 docs/ 里）："
log "    docs/OPERATIONS.md  运维手册（备份/恢复/升级/卸载/个人信息）"
