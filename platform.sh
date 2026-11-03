#!/usr/bin/env bash
# =============================================================================
#  宿主平台适配层 —— **全脚本唯一允许出现平台判据的地方**
#
#  为什么要有这个文件（改之前先读）：
#  deploy.sh 里原先有两处 `[ "$(uname -s)" = Linux ] || die "本脚本面向 Linux 服务器"`，
#  而那两处只是把"非 Linux"挡在门外；真正决定"怎么装 Docker、怎么起守护、要不要 root、
#  装到哪个目录"的判断散在第 ①④⑤⑧ 步里（apt-get/dnf/yum/apk/pacman/zypper、systemctl/
#  service/rc-service、usermod、/opt），一共 41 处 as_root。
#  后果是**支持面说不清**：店主在 Rocky/AlmaLinux/Anolis/Fedora/openSUSE 上跑，成功与否
#  取决于那一串 if 恰好命中哪个分支，而 README 只写"面向 Linux 服务器"。
#
#  所以平台差异收敛到**一处**：本文件把宿主探测一次、归一成下面那组变量，
#  deploy.sh 只消费结论，不再自己判平台。新增一个发行版/一种宿主 = 改**这里一张表**，
#  而不是在 deploy.sh 的 41 个调用点各加一个分支（那正是"判据挂错层"的形状）。
#
#  ── 设计约束（与 README 的承诺对齐）────────────────────────────────────────
#   1. **不在 macOS 上自动装 Docker**：那里 Docker 是"一个带虚拟机的应用"（Docker Desktop/
#      colima/OrbStack），装它 = 装一个 VM 且要图形界面点同意——自动做既不可能也越权。
#      探测到没有就**明确告诉店主装哪个**（见 MK_HOST_DOCKER_HINT），而不是硬失败一句"不支持"。
#   2. **不写"发行版白名单"**：RHEL 系的衍生版（Alibaba Cloud Linux / Anolis / TencentOS /
#      OpenCloudOS / Rocky / Alma / Fedora / CentOS Stream…）名字在变，能装 Docker 的判据
#      是**包管理器**而不是发行版名。白名单式围堵必然漏掉下一个衍生版。
#   3. **容器内不是服务器**：在容器里（/.dockerenv 或 /run/.containerenv）跑本脚本时，
#      "装 Docker、起守护"这两件事都不该做——Docker 来自宿主（socket/外部）。此时若 socket
#      不可用就明确报"在容器里跑需要挂载 docker socket"，而不是去 apt-get 装一个不会生效的
#      Docker（那正是"看起来装好了、其实用不了"）。CoreOS/Flatcar 这类不可变宿主同理：
#      它们没有包管理器，Docker 由宿主自带，脚本只能**用**不能**装**。
#
#  ── 提供的东西（deploy.sh 只读这些）──────────────────────────────────────
#   变量：MK_HOST_OS         linux|macos|windows|unknown
#         MK_HOST_PM         apt|dnf|yum|zypper|apk|pacman|none（仅 Linux 有意义）
#         MK_HOST_INIT       systemd|openrc|sysvinit|none（仅 Linux 有意义）
#         MK_HOST_VER        "almalinux 9.4" 这类一行描述（只用于打印）
#         MK_HOST_WANTS_ROOT 1=通常需要 root/sudo 才能装 Docker 与写系统目录
#   函数：host_install_docker       —— 按包管理器装 Docker（macOS/容器内不装，直接给指引）
#         host_start_docker         —— 起守护并等它就绪
#         host_docker_install_hint  —— 装不了时给店主的**可照做**的指引（一行行打印）
#         host_grant_docker         —— 免 sudo 用 docker（仅 Linux 有意义）
#         host_default_dir          —— 默认安装目录（Linux /opt 或 $HOME；macOS 永远 $HOME）
#         host_supports_systemd_legacy —— 是否可能存在旧版 systemd 宿主安装残留
#         host_supports_nginx_certbot  —— 是否支持 --tls-mode nginx（宿主 nginx + certbot）
#
#  用法（deploy.sh 顶部）：
#      . "$HERE/platform.sh"
#      host_probe            # 探测一次，填好上面那些变量
# =============================================================================

# 平台探测：**只此一处**读 uname / os-release / 包管理器 / init。
# 结果全放进 MK_HOST_* 变量，后续任何地方都不再问"这是什么系统"。
host_probe() {
  local uname_s
  # **可注入**：MK_HOST_OS/MK_HOST_IN_CONTAINER/MK_HOST_IMMUTABLE 是这套判据的测试入口
  # （test/platform.test.js）。没有它，这一层就只能在真机上验，而"判据层不可测"意味着
  # 每加一种宿主都靠人工点一遍 —— 那正是本仓说的"判据挂错层"。
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  MK_HOST_OS="${MK_HOST_OS:-}"
  if [ -z "$MK_HOST_OS" ]; then
    case "$uname_s" in
      Linux) MK_HOST_OS=linux ;;
      Darwin) MK_HOST_OS=macos ;;
      MINGW*|MSYS*|CYGWIN*) MK_HOST_OS=windows ;;   # 原生入口是 deploy.ps1，见 deploy.sh 的门禁
      *) MK_HOST_OS=unknown ;;
    esac
  fi

  MK_HOST_PM=none
  MK_HOST_INIT=none
  MK_HOST_WANTS_ROOT=0
  MK_HOST_VER="$uname_s $(uname -m 2>/dev/null || echo '?')"

  if [ "$MK_HOST_OS" = linux ]; then
    # 发行版描述只用于打印（**不参与任何判断**——判断一律走包管理器/init，见文件头第 2 条）。
    # MK_HOST_OS_RELEASE_FILE 是测试入口（默认就是真机的 /etc/os-release）。
    local osr="${MK_HOST_OS_RELEASE_FILE:-/etc/os-release}"
    if [ -r "$osr" ]; then
      MK_HOST_VER="$( (. "$osr" 2>/dev/null && printf '%s %s' "${ID:-linux}" "${VERSION_ID:-}") || echo "$MK_HOST_VER")"
    fi
    # 包管理器：RHEL 9 系只有 dnf（yum 是符号链接），CentOS 7 只有 yum，所以两个都要认。
    # 顺序即优先级：同一台机器上装了多个时，优先用"这个发行版原生的那个"。
    if command -v apt-get >/dev/null 2>&1; then MK_HOST_PM=apt
    elif command -v dnf >/dev/null 2>&1; then MK_HOST_PM=dnf
    elif command -v yum >/dev/null 2>&1; then MK_HOST_PM=yum
    elif command -v zypper >/dev/null 2>&1; then MK_HOST_PM=zypper
    elif command -v apk >/dev/null 2>&1; then MK_HOST_PM=apk
    elif command -v pacman >/dev/null 2>&1; then MK_HOST_PM=pacman
    fi
    if command -v systemctl >/dev/null 2>&1; then MK_HOST_INIT=systemd
    elif command -v rc-service >/dev/null 2>&1; then MK_HOST_INIT=openrc
    elif command -v service >/dev/null 2>&1; then MK_HOST_INIT=sysvinit
    fi
    MK_HOST_WANTS_ROOT=1
    # 容器内/不可变宿主同样允许注入（测试入口），默认按本机实况判定
    if [ -z "${MK_HOST_IN_CONTAINER:-}" ]; then
      if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then MK_HOST_IN_CONTAINER=1; else MK_HOST_IN_CONTAINER=0; fi
    fi
    if [ -z "${MK_HOST_IMMUTABLE:-}" ]; then
      # 不可变宿主（CoreOS/Flatcar 等）：没有包管理器、/usr 只读，Docker 由宿主自带。
      # 括号是**判据的一部分**：没有它 `A && B || C` 会把"有包管理器但 /usr/share/coreos 不存在"
      # 也算成不可变宿主（shell 的 && / || 是同级左结合）。
      if [ "$MK_HOST_PM" = none ] && { [ -d /usr/share/coreos ] || [ -f /etc/coreos/update.conf ]; }; then
        MK_HOST_IMMUTABLE=1
      else
        MK_HOST_IMMUTABLE=0
      fi
    fi
  else
    MK_HOST_IN_CONTAINER="${MK_HOST_IN_CONTAINER:-0}"
    MK_HOST_IMMUTABLE="${MK_HOST_IMMUTABLE:-0}"
  fi
  # macOS 不需要 root（Docker 是应用）；目录与权限判断仍读这个变量。
  # ⚠️ 写成 if 而不是 `[ … ] && X=1`：本文件被 deploy.sh 在 `set -e` 下 source，
  # 顶层那行判据为假时整行返回 1 ⇒ **脚本零输出静默退出**（实测踩过）。
  if [ "$MK_HOST_OS" = macos ]; then MK_HOST_WANTS_ROOT=0; fi
}

# ── 装 Docker ───────────────────────────────────────────────────────────────
# 返回 0 = 已装好（或本来就可用）；1 = 装不了（调用方负责打印 host_docker_install_hint 并 die）
host_install_docker() {
  local as_root="$1"   # 调用方传入提权前缀（"sudo" 或空）——本文件不认识 sudo 变量
  case "$MK_HOST_OS" in
    macos)
      # 不自动装：Docker 在 macOS 上是带 VM 的应用。有 brew 就装 CLI（那只是客户端，
      # 真正的引擎仍要 Docker Desktop/colima 起来），没 brew 就交给指引。
      if command -v brew >/dev/null 2>&1; then
        brew install docker >/dev/null 2>&1 && return 0
      fi
      return 1
      ;;
    windows)
      # 原生 Windows 不走 bash：install 入口是 deploy.ps1（Node 直接跑在 Windows 上，不用容器）
      return 1
      ;;
  esac
  # ── Linux ──
  if [ "$MK_HOST_IN_CONTAINER" = 1 ] || [ "$MK_HOST_IMMUTABLE" = 1 ]; then
    return 1          # 容器内/不可变宿主：Docker 只能由宿主提供，装不了
  fi
  case "$MK_HOST_PM" in
    apt)    $as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq && \
            $as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io ;;
    dnf)    $as_root dnf install -y -q docker || $as_root dnf install -y -q docker-ce ;;
    yum)    $as_root yum install -y -q docker || $as_root yum install -y -q docker-ce ;;
    zypper) $as_root zypper --non-interactive install docker ;;
    apk)    $as_root apk add --no-cache docker ;;
    pacman) $as_root pacman -Sy --noconfirm docker ;;
    *)
      # 没有已知包管理器（含 RHEL 未订阅、EOL 发行版源已下线）：官方脚本是最后一条路，
      # 但它**不适用于** EOL 发行版（其仓库已下线），所以失败时指引里要说明这一点。
      command -v curl >/dev/null 2>&1 || return 1
      local tmp; tmp="$(mktemp 2>/dev/null || echo /tmp/get-docker.sh)"
      curl -fsSL https://get.docker.com -o "$tmp" || return 1
      $as_root sh "$tmp" || { rm -f "$tmp"; return 1; }
      rm -f "$tmp"
      ;;
  esac
  command -v docker >/dev/null 2>&1
}

# ── 起守护并等它就绪 ────────────────────────────────────────────────────────
# 入参：$1=docker 访问函数名（由调用方传 `dk`），$2=提权前缀。返回 0=就绪。
host_start_docker() {
  local dk_fn="$1" as_root="$2"
  [ "$MK_HOST_OS" = linux ] || return 0        # macOS：Desktop/colima 自己管守护，脚本不碰
  [ "$MK_HOST_IN_CONTAINER" = 1 ] && return 0  # 容器内：守护在宿主，没得 start
  case "$MK_HOST_INIT" in
    systemd)  $as_root systemctl enable --now docker >/dev/null 2>&1 || true ;;
    openrc)   $as_root rc-service docker start >/dev/null 2>&1 || true ;;
    sysvinit) $as_root service docker start >/dev/null 2>&1 || true ;;
  esac
  local i
  for i in $(seq 1 20); do "$dk_fn" info >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

# ── 给店主的指引（装不了/守护没起来时打印）─────────────────────────────────
host_docker_install_hint() {
  case "$MK_HOST_OS" in
    macos)
      cat >&2 <<'EOF'
  这台 Mac 上没有可用的 Docker 引擎。macOS 上 Docker 是一个**带 Linux 虚拟机的应用**，
  脚本不会替你装（装它要图形界面、要授权，也可能与你已有的方案冲突）。任选一种装好后重跑：

    · Docker Desktop（官方，个人/小规模免费）  https://www.docker.com/products/docker-desktop/
    · colima（开源、纯命令行，无桌面）        brew install colima docker && colima start
    · OrbStack（开源替代，较轻）              brew install orbstack

  装好后先自证引擎可用：`docker info` 能输出 Server 段落即就绪（只有 Client 段落不算）。
EOF
      ;;
    windows)
      echo "  原生 Windows 请用 deploy.ps1（PowerShell）：本机的 Node 直接跑，不需要容器。" >&2
      ;;
    *)
      if [ "$MK_HOST_IN_CONTAINER" = 1 ]; then
        cat >&2 <<'EOF'
  当前**在容器里**运行：脚本不会（也无法）在容器内装 Docker —— 引擎只能来自宿主。
  两条路：
    · 挂载宿主的 socket：docker run -v /var/run/docker.sock:/var/run/docker.sock …
    · 或者不要在容器里部署：直接在目标服务器（或它的宿主）上跑本脚本
EOF
      elif [ "$MK_HOST_IMMUTABLE" = 1 ]; then
        echo "  这是不可变宿主（CoreOS/Flatcar 一类）：Docker 应由宿主自带，请不要在容器/宿主机内安装。" >&2
      elif [ "$MK_HOST_PM" = none ]; then
        cat >&2 <<'EOF'
  这台机器上既没有已知的包管理器，也装不上 Docker。常见原因与对策：
    · **RHEL 未订阅**：`dnf` 存在但仓库不可用 —— 启用订阅（subscription-manager register）后重跑
    · **EOL 发行版**（CentOS 7/8 等）：官方仓库与 Docker 源都已下线 —— 请换受支持的发行版
      （Rocky / AlmaLinux / CentOS Stream 9+ / Ubuntu 22.04+ / Debian 12+ / Fedora / openSUSE）
    · 手工装好 Docker 后重跑本脚本即可（脚本只要求 `docker info` 可用）
EOF
      else
        echo "  请手工安装 Docker 后重跑：https://docs.docker.com/engine/install/" >&2
      fi
      ;;
  esac
}

# ── 免 sudo 用 docker（仅 Linux 有意义）────────────────────────────────────
host_grant_docker() {
  local as_root="$1"
  [ "$MK_HOST_OS" = linux ] || return 0
  [ "$(id -u 2>/dev/null || echo 0)" -eq 0 ] && return 0
  local target="${SUDO_USER:-$(id -un)}"
  id -nG "$target" 2>/dev/null | tr ' ' '\n' | grep -qx docker && return 0
  $as_root usermod -aG docker "$target" >/dev/null 2>&1 || return 0
  echo "$target"
}

# ── 默认安装目录 ───────────────────────────────────────────────────────────
# 入参：$1=有 root/sudo 时为 1（由调用方判，脚本里已有那个判据）。macOS **永远**用 $HOME：
# 那里没有 /opt 的约定，而"往 /opt 装东西"在 macOS 上属于越权改系统目录。
host_default_dir() {
  local can_root="$1"
  if [ "$MK_HOST_OS" = macos ]; then printf '%s/marketplace-node' "$HOME"; return; fi
  if [ "$can_root" = 1 ]; then printf '/opt/marketplace-node'; else printf '%s/marketplace-node' "$HOME"; fi
}

# ── 旧版 systemd 宿主安装的残留是否可能存在 ────────────────────────────────
# 只有 Linux + systemd 才可能有那份单元文件；在 macOS 上检查 /etc/systemd 是无意义的噪音。
host_supports_systemd_legacy() {
  [ "$MK_HOST_OS" = linux ] && [ "$MK_HOST_INIT" = systemd ]
}

# ── --tls-mode nginx（宿主 nginx + certbot）是否可用 ───────────────────────
# 这条路的实现是"写 /etc/nginx/conf.d + systemctl reload + certbot --nginx"，全部是
# Linux 发行版的包与路径假设（macOS 的 nginx 走 brew、没有 conf.d 约定、也没有 systemctl）。
# 所以它在非 Linux 上**不是"暂时不支持"而是错误的**：拒绝并给出 macOS 上正确的替代写法。
host_supports_nginx_certbot() {
  [ "$MK_HOST_OS" = linux ] && [ "$MK_HOST_PM" != none ]
}
