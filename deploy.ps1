# =============================================================================
#  deploy.ps1 — 联邦商城开店节点 · **Windows 原生**部署（Windows Server 2019+ / Windows 10+）
#
#  在 Windows 上把节点当成一个本机服务跑起来：装 Node → 写配置 → 装依赖 →
#  注册开机自启的计划任务 → 探活 →（可选）链上登记。
#
#  ── 为什么 Windows 不用容器（与 deploy.sh 是两条路径，不是两个实现）───────────
#  节点本身**零 POSIX 依赖**（已实测：Windows 上 `node src/server.js` 直接起、/healthz 返回
#  code:0、依赖 express/cors/ethers/mysql2 全是纯 JS）。
#  在 Windows Server 上跑 Linux 容器要额外一层 VM（WSL2/Hyper-V）与 Docker Desktop 的授权，
#  而"直接在 Windows 上跑 Node"反而少一层、少一个故障面。
#  代价照实说：这是**第二条部署路径**——容器那条（`deploy.sh`）管镜像与卷，这条管本机服务与目录。
#  两条路径靠 `deploy-constants.json`（合约地址/端口/运行参数**唯一真相**）与
#  `test/deploy-constants.test.js`（禁止任一侧再写一份字面量）钉在一起，不靠"记得同步"。
#
#  ── 与 deploy.sh 的差异（都源于平台，不是设计分歧）─────────────────────────
#    · 自启/守护：Linux 用 `docker run --restart unless-stopped`；Windows 用**计划任务 + 看护进程**
#      （不引第三方二进制，如 NSSM——那要给店主增加一个下载与信任对象）。
#    · 数据位置：**附件与商品媒体**——Linux 在**命名卷**里（容器删了数据还在）；Windows 没有卷这一层，
#      就放在安装目录的 `data\` 子目录里。**升级只换代码，不碰 data\**。库在 MySQL 里（两条路径都一样）。
#    · 权限：Linux 有 `chmod 600`；Windows 用 ACL（把 .env 收紧到当前用户 + SYSTEM）。
#    · HTTPS：两条路径都用 Caddy（容器 vs 本机进程），拓扑含义一致（见 deploy.sh 文件头 A/B）。
#
#  ── 用法 ───────────────────────────────────────────────────────────────────
#      .\deploy.ps1                                     # 安装（交互式问店主地址/域名）
#      .\deploy.ps1 -Owner 0x… -Domain shop.example.com # 非交互安装（证书在别处终止）
#      .\deploy.ps1 -Owner 0x… -Domain shop.example.com -TlsMode caddy -Email me@x.com
#      .\deploy.ps1 -DryRun                             # 只打印计划，什么都不改
#      .\deploy.ps1 -Status | -Health | -Update | -Uninstall | -Purge
#      .\deploy.ps1 -Help
#
#  ── 可选参数 ───────────────────────────────────────────────────────────────
#      -Port 8090              对外端口（**别用 8080**：本机开发默认端口，Windows 上常被别的服务占）
#      -Bind 0.0.0.0           监听地址（配了本机 TLS 默认 127.0.0.1；证书在别处时默认 0.0.0.0）
#      -Dir C:\marketplace-node   代码/配置/数据/日志所在目录
#      -Service marketplace-node  计划任务名与数据目录名（同机开第二家店必须换）
#      -RedisUrl redis://:密码@主机:6379/0   外部 Redis（必填；也可先写 MK_REDIS_URL）
#      -NodeVersion 24.21.0    没有 Node 时要装的版本（默认取常量里的 24 线）
#      -Mirror https://npmmirror.com/mirrors/node   国内下载 Node 的镜像（默认走官方 nodejs.org）
# =============================================================================
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Status,
  [switch]$Health,
  [switch]$Update,
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$Help,
  [switch]$Yes,

  [string]$Owner = '',
  [string]$Domain = '',
  [string]$Email = '',
  [string]$Port = '',
  [string]$Bind = '',
  [string]$Dir = '',
  [string]$Service = '',
  [string]$RedisUrl = '',
  [ValidateSet('caddy', 'none', '')][string]$TlsMode = '',

  # 没有 Node 时才用到
  [string]$NodeVersion = '24.21.0',
  [string]$Mirror = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ── 输出（与 deploy.sh 同形：✓ / ! / ✗ 与分节标题，两条路径的日志读起来一致）──
function Write-Log  { param([string]$m) Write-Host $m }
function Write-Info { param([string]$m) Write-Host $m }
function Write-Ok   { param([string]$m) Write-Host "✓ $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "! $m" -ForegroundColor Yellow }
function Write-Step { param([string]$m) Write-Host "`n── $m ──" -ForegroundColor DarkGray }
function Die {
  param([string]$m, [int]$code = 1)
  Write-Host "✗ $m" -ForegroundColor Red
  exit $code
}

# ── 部署常量：**唯一真相**在 deploy-constants.json（与 deploy.sh 共用同一份）──────
# 取不到就当场失败，绝不退回内建默认值 —— 退回默认值正是"静默接了错合约"的形状。
$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
$CONSTANTS_FILE = Join-Path $HERE 'deploy-constants.json'
if (-not (Test-Path -LiteralPath $CONSTANTS_FILE)) {
  Die "缺少 $CONSTANTS_FILE —— 部署常量（合约地址/RPC/端口）的唯一真相在那里；文件不在就无法保证接的是本批合约，拒绝继续"
}
$C = Get-Content -LiteralPath $CONSTANTS_FILE -Raw -Encoding UTF8 | ConvertFrom-Json

function Get-Const {
  param([string]$Path, [string]$Label)
  $node = $C
  foreach ($p in $Path.Split('.')) { $node = $node.$p }
  if ($null -eq $node -or ($node -is [string] -and $node.Trim() -eq '')) {
    Die "deploy-constants.json 里取不到 $Label —— 文件结构变了？脚本拒绝用一个猜出来的值继续"
  }
  return $node
}

$FrontendOrigin = Get-Const 'network.frontendOrigin' 'network.frontendOrigin'
$RpcUrl         = Get-Const 'network.rpcUrl'         'network.rpcUrl'
$ChainId        = Get-Const 'network.chainId'        'network.chainId'
$Escrow         = Get-Const 'contracts.escrow'       'contracts.escrow'
$Staking        = Get-Const 'contracts.staking'      'contracts.staking'
$StartBlock     = Get-Const 'contracts.startBlock'   'contracts.startBlock'
$ContainerPort  = Get-Const 'runtime.containerPort'  'runtime.containerPort'
$DefaultService = Get-Const 'runtime.serviceName'    'runtime.serviceName'

# 结构性门禁（与 deploy.sh 同一判据）：「是不是上一批已弃用的那个合法地址」脚本无法判断，
# 只能由部署者按发布检查表核对；这里挡住的是"形状就不对"。
if ($Escrow -notmatch '^0x[0-9a-fA-F]{40}$' -or $Staking -notmatch '^0x[0-9a-fA-F]{40}$' -or [int]$StartBlock -le 0) {
  Die "deploy-constants.json 的合约常量不合法：escrow=$Escrow staking=$Staking startBlock=$StartBlock（起始块不能是 0：0 = 从最新块开始 ⇒ 漏扫历史事件且不报错；Escrow/Staking 必须由本节点部署、互相回指、owner=本节点 operator）"
}

# ── 模式 ──
$MODE = 'install'
if ($Status)    { $MODE = 'status' }
if ($Health)    { $MODE = 'health' }
if ($Update)    { $MODE = 'update' }
if ($Uninstall) { $MODE = 'uninstall' }
if ($Purge)     { $MODE = 'purge' }
if ($Help)      { $MODE = 'help' }
if ($DryRun)    { $script:DRY_RUN = $true } else { $script:DRY_RUN = $false }

if ($MODE -eq 'help') {
  Get-Content -LiteralPath $MyInvocation.MyCommand.Path | Select-Object -First 60 | ForEach-Object { $_ -replace '^# ?', '' }
  exit 0
}

# ── 平台门禁：这条路径只服务 Windows ──
if ($env:OS -ne 'Windows_NT' -and -not ($IsWindows)) {
  Die "deploy.ps1 面向 Windows（原生运行节点）。Linux/macOS 请用 bash deploy.sh（Docker 路径）"
}

# ── 权限门禁：安装/升级要注册系统级计划任务，**必须管理员** ──
# 为什么在动手之前就判：这条判据决定了"能不能装成"，而它要等到第 ⑥ 步注册任务时才暴露
# ——那时配置与依赖都装完了，店主看到的是一句 AccessDenied。判据挂在入口，代价最小。
# 只读模式（-Status/-Health）与卸载不需要管理员；-DryRun 也不需要（它不改任何东西）。
if ($MODE -in @('install', 'update') -and -not $script:DRY_RUN) {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die @"
注册开机自启需要**管理员权限**（计划任务要以 SYSTEM 运行，机器一开机就起店）。

  请用管理员身份打开 PowerShell 重跑同一条命令。
  判据是"能不能装成"而不是"能不能跑起来"：非管理员也能把代码与依赖装好，
  但**没有自启**的店在重启后就没了 —— 那种"看起来装好了"比当场拒绝更糟。
"@
  }
}

# ── 目录 / 名字 / 端口 ──
if (-not $Service) { $Service = $DefaultService }
if (-not $Dir) {
  # 默认装到 ProgramData：那是 Windows 上"服务的数据"该在的地方（不随某个用户的 profile 走，
  # 也不会因为某个人注销而失效），且不需要管理员以外的特殊权限。
  $Dir = Join-Path $env:ProgramData $Service
}
$Dir = [System.IO.Path]::GetFullPath($Dir)
$DATA_DIR = Join-Path $Dir 'data'
$LOG_DIR = Join-Path $Dir 'logs'
$ENV_FILE = Join-Path $Dir '.env'
$STATE_FILE = Join-Path $Dir '.deploy-state.json'
$NODE_DIR = Join-Path $Dir 'node-runtime'
$TASK_NAME = $Service
$LAUNCHER = Join-Path $Dir 'run-node.ps1'

if (-not $Port) {
  # 已装过就沿用状态文件里的端口（-Update/-Status 不必重复给），否则用容器内的固定端口
  if (Test-Path -LiteralPath $STATE_FILE) {
    $st = Get-Content -LiteralPath $STATE_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($st.port) { $Port = [string]$st.port }
  }
  if (-not $Port) { $Port = [string]$ContainerPort }
}
if ($Port -notmatch '^\d+$' -or [int]$Port -lt 1 -or [int]$Port -gt 65535) {
  Die "端口非法：'$Port'（要 1-65535 的十进制整数）"
}
if ([int]$Port -eq 8080) {
  # 与 deploy.sh 同一条静态判据：8080 是本机开发的默认端口，同机常被别的服务占着
  Die "别用 8080：本机开发的默认端口，同机常被别的服务占着。换一个，例如 -Port 8090"
}

if (-not $TlsMode -and (Test-Path -LiteralPath $STATE_FILE)) {
  $st = Get-Content -LiteralPath $STATE_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($st.tls) { $TlsMode = [string]$st.tls }
}
if (-not $TlsMode) { $TlsMode = 'none' }   # 默认：TLS 在别处终止（与 deploy.sh 的默认一致）
if (-not $Bind) {
  if ($TlsMode -eq 'none') { $Bind = '0.0.0.0' } else { $Bind = '127.0.0.1' }
}

$script:STATE = [ordered]@{
  service = $Service
  port    = [int]$Port
  bind    = $Bind
  tls     = $TlsMode
  dir     = $Dir
}

# =============================================================================
# ① 环境检测
# =============================================================================
function Get-PlatformInfo {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  $name = if ($os) { $os.Caption } else { [System.Environment]::OSVersion.VersionString }
  $arch = $env:PROCESSOR_ARCHITECTURE
  return "$name / $arch"
}

function Get-NodeExe {
  <#
    找可用的 Node（≥ 23.4，节点用到 --env-file-if-exists）。
    顺序：安装目录自带 → PATH。找不到返回 $null（由调用方决定装还是拒绝）。
  #>
  $bundled = Join-Path $NODE_DIR 'node.exe'
  foreach ($cand in @($bundled, 'node')) {
    try {
      $cmd = Get-Command $cand -ErrorAction Stop
      $ver = & $cmd.Source -v 2>$null
      if ($ver -match '^v(\d+)\.(\d+)\.(\d+)') {
        $maj = [int]$Matches[1]; $min = [int]$Matches[2]
        if ($maj -gt 23 -or ($maj -eq 23 -and $min -ge 4)) { return $cmd.Source }
      }
    } catch { }
  }
  return $null
}

function Install-Node {
  <#
    没有合适的 Node 就装一份到**安装目录里**（$NODE_DIR），而不是往 Program Files 或系统 PATH 装：
    理由与 deploy.sh 拒绝改宿主环境是同一条 —— 卸载要能干净地连带删掉，且不与机器上别人的
    Node 版本打架。代价：这份 Node 只归这个节点用，机器上有别的 Node 也不会被复用（这是刻意的）。
  #>
  param([string]$Version)
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = if ($Mirror) { $Mirror.TrimEnd('/') } else { 'https://nodejs.org/dist' }
  $zipName = "node-v$Version-win-$arch.zip"
  $url = "$base/v$Version/$zipName"
  $tmp = Join-Path $env:TEMP $zipName
  Write-Info "下载 Node $Version（$arch）：$url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
  } catch {
    Die "下载 Node 失败（$url）：$($_.Exception.Message)`n  出网受限时可以指定镜像：-Mirror https://npmmirror.com/mirrors/node"
  }
  New-Item -ItemType Directory -Force -Path $NODE_DIR | Out-Null
  $stage = Join-Path $env:TEMP "mk-node-stage-$([guid]::NewGuid().ToString('N'))"
  Expand-Archive -LiteralPath $tmp -DestinationPath $stage -Force
  $inner = Get-ChildItem -LiteralPath $stage -Directory | Select-Object -First 1
  if (-not $inner) { Die "解压出来的 Node 包结构不对（没找到顶层目录）" }
  Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $NODE_DIR -Recurse -Force
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  $exe = Join-Path $NODE_DIR 'node.exe'
  if (-not (Test-Path -LiteralPath $exe)) { Die "装完仍找不到 $exe" }
  Write-Ok "Node 已装到 $NODE_DIR（只归本节点使用，不动系统 PATH）"
  return $exe
}

function New-Secret {
  <#
    令牌密钥：必须是密码学随机（它被当作 HMAC 密钥，弱密钥 = 任何人可离线伪造店主令牌）。
    节点自己会拒绝 <32 字符/纯数字/重复字符/仓库示例值，这里先生成一个 48 字节的 base64url。
  #>
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Protect-File {
  <#
    .env 里有 MK_TOKEN_SECRET。Linux 那条路径用 chmod 600；Windows 没有 POSIX 权限位，
    等价物是 ACL：只留 当前用户 与 SYSTEM（计划任务以 SYSTEM 跑，所以必须给它），
    其余继承项全部移除。失败就如实告警，不假装成功 —— "以为收紧了其实没有"比不收紧更糟。
  #>
  param([string]$Path)
  try {
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)   # 断开继承并清掉继承来的规则
    $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
    foreach ($who in @($me, 'NT AUTHORITY\SYSTEM')) {
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($who, 'FullControl', 'Allow')
      $acl.AddAccessRule($rule) | Out-Null
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    return $true
  } catch {
    Write-Warn "收紧 $Path 的 ACL 失败（$($_.Exception.Message)）—— 请自行确认只有本机管理员可读：它含令牌密钥"
    return $false
  }
}

function Read-EnvValue {
  param([string]$Path, [string]$Key)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
    if ($line -match "^\s*$([regex]::Escape($Key))=(.*)$") { return $Matches[1].Trim() }
  }
  return ''
}

function Write-EnvFile {
  <#
    写 .env。**键与取值必须与 deploy.sh 生成的一致**（那条路径用 `docker --env-file` 注入，
    这条直接在进程环境里给）——否则同一家店在两种宿主上行为不同，而差异是静默的。
    沿用规则也一致：已存在的 MK_TOKEN_SECRET 与店主自加的键原样保留（重跑不该让店主登录态失效）。
  #>
  param([string]$OwnerAddr, [string]$DomainName, [string]$Secret, [string]$Redis)

  $MANAGED = @(
    'MK_PORT', 'MK_SHOP_OWNER', 'MK_RPC_URL', 'MK_CHAIN_ID', 'MK_ESCROW_ADDRESS',
    'MK_STAKING_ADDRESS', 'MK_ESCROW_START_BLOCK', 'MK_ESCROW_TIMEOUT_BLOCKS', 'MK_ESCROW_FINALITY_BLOCKS', 'MK_ESCROW_POLL_MS',
    'MK_CHAIN_RECONCILE_MS', 'MK_CORS_ORIGIN', 'MK_CORS_ALLOW_ALL', 'MK_ATTACH_DIR',
    'MK_AUTO_DELIVER', 'MK_PII_RETENTION_DAYS', 'MK_BTY_TTL_MS', 'MK_DRAFT_TTL_MINUTES', 'MK_REVIEW_TTL_DAYS',
    'MK_TOKEN_TTL', 'MK_SIWE_TTL', 'MK_TOKEN_SECRET', 'MK_SIWE_DOMAIN', 'MK_REDIS_URL'
  )
  $extra = @()
  if (Test-Path -LiteralPath $ENV_FILE) {
    $keepNames = @{}
    foreach ($k in $MANAGED) { $keepNames[$k] = $true }
    foreach ($line in (Get-Content -LiteralPath $ENV_FILE -Encoding UTF8)) {
      $t = $line.Trim()
      if ($t -eq '' -or $t.StartsWith('#')) { continue }
      $name = ($t -split '=', 2)[0].Trim()
      if (-not $keepNames.ContainsKey($name)) { $extra += $t }
    }
    Copy-Item -LiteralPath $ENV_FILE -Destination "$ENV_FILE.bak.$(Get-Date -Format yyyyMMdd-HHmmss)" -Force -ErrorAction SilentlyContinue
  }

  $cors = $FrontendOrigin
  if ($DomainName -and $DomainName.Trim() -ne '') {
    $cors = "$cors,https://$($DomainName.Trim().TrimEnd('/'))"
  }
  # 行情缓存沿用店主手改过的值（与 deploy.sh 的 MK_BTY_TTL_MS 规则一致）
  $btyTtl = Read-EnvValue -Path $ENV_FILE -Key 'MK_BTY_TTL_MS'
  if (-not $btyTtl) { $btyTtl = [string]$C.appDefaults.MK_BTY_TTL_MS }

  $lines = @(
    "# 由 deploy.ps1（Windows 原生版）生成于 $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
    "# 与 deploy.sh 共用 deploy-constants.json 的常量；附件与商品媒体在 $DATA_DIR（升级只换代码，不碰 data\）"
    "MK_PORT=$ContainerPort"
    "MK_SHOP_OWNER=$OwnerAddr"
    "MK_RPC_URL=$RpcUrl"
    "MK_CHAIN_ID=$ChainId"
    "MK_ESCROW_ADDRESS=$Escrow"
    "MK_STAKING_ADDRESS=$Staking"
    "MK_ESCROW_START_BLOCK=$StartBlock"
    "MK_ESCROW_TIMEOUT_BLOCKS=$($C.appDefaults.MK_ESCROW_TIMEOUT_BLOCKS)"
    "MK_ESCROW_FINALITY_BLOCKS=$($C.appDefaults.MK_ESCROW_FINALITY_BLOCKS)"
    "MK_ESCROW_POLL_MS=$($C.appDefaults.MK_ESCROW_POLL_MS)"
    "MK_CHAIN_RECONCILE_MS=$($C.appDefaults.MK_CHAIN_RECONCILE_MS)"
    "# 谁可以跨域读你的节点：联邦前端（买家聚合） + 你自己的域名"
    "MK_CORS_ORIGIN=$cors"
    "MK_CORS_ALLOW_ALL=$($C.appDefaults.MK_CORS_ALLOW_ALL)"
    "# 附件与商品媒体在安装目录的 data\ 里（Windows 没有命名卷这一层；升级不碰它）"
    "MK_ATTACH_DIR=$((Join-Path $DATA_DIR 'attachments'))"
    "# 库在 MySQL 里、不在 data\ 内：MK_DB_* 由你自己写进这个 .env（本脚本不管它们，重跑原样保留）"
    "MK_AUTO_DELIVER=$($C.appDefaults.MK_AUTO_DELIVER)"
    "MK_PII_RETENTION_DAYS=$($C.appDefaults.MK_PII_RETENTION_DAYS)"
    "# 行情缓存（毫秒）：官方 BTY-USDT 行情直接决定""买家要付多少 BTY""，所以跟得紧（标价单位就是 USDT）"
    "MK_BTY_TTL_MS=$btyTtl"
    "MK_DRAFT_TTL_MINUTES=$($C.appDefaults.MK_DRAFT_TTL_MINUTES)"
    "MK_REVIEW_TTL_DAYS=$($C.appDefaults.MK_REVIEW_TTL_DAYS)"
    "MK_TOKEN_TTL=$($C.appDefaults.MK_TOKEN_TTL)"
    "MK_SIWE_TTL=$($C.appDefaults.MK_SIWE_TTL)"
    "MK_TOKEN_SECRET=$Secret"
    "MK_SIWE_DOMAIN=$DomainName"
    "MK_REDIS_URL=$Redis"
  )
  if ($extra.Count -gt 0) {
    $lines += ''
    $lines += '# ── 以下配置项不由 deploy.ps1 管理，重跑时原样保留 ──'
    $lines += $extra
  }
  Set-Content -LiteralPath $ENV_FILE -Value $lines -Encoding UTF8
  Protect-File -Path $ENV_FILE | Out-Null
  Write-Ok "配置就绪：$ENV_FILE（ACL 已收紧，含令牌密钥）"
}

function Write-Launcher {
  <#
   看护脚本：拉起 node 并**在它退出后拉起**（对应容器的 `--restart unless-stopped`）。
   为什么需要它：Windows 没有"把任意 exe 当服务"的原生办法（服务必须实现 SCM 协议，
   node.exe 不是服务程序）；用计划任务直接跑 node 的话，进程崩了就没人再拉起来。
   所以：计划任务以 SYSTEM 在开机时启动本脚本，本脚本成为看护进程。
   不引 NSSM/WinSW 是刻意的：那要给店主多一个"下载并信任一个第三方二进制"的动作。
  #>
  $exe = Join-Path $NODE_DIR 'node.exe'
  $log = Join-Path $LOG_DIR 'node.log'
  $errlog = Join-Path $LOG_DIR 'node.err.log'
  # 用 -f 占位符拼这份脚本，而不是在 here-string 里混用 `$ 转义与 $() 插值：
  # 后者在嵌套引号处极易写成语法错误（本文件第一版就是这么挂的：解析器报 "Unexpected token"）。
  # 模板里的 {0}=exe {1}=envFile {2}=dir {3}=log {4}=errlog；`$ 是给**生成出来的脚本**用的转义。
  $template = @'
# 由 deploy.ps1 生成；改它不会生效——改完请重跑 .\deploy.ps1 -Update
# 职责：拉起节点，并在它退出后重新拉起（等价于容器的 --restart unless-stopped）
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath '{2}'

# 退避：连续秒退时拉长间隔，避免"崩-拉"风暴把日志刷满
$delay = 2
while ($true) {
  $started = Get-Date
  # --env-file-if-exists：与 Linux 路径等价（那条是 docker --env-file 注入）
  & '{0}' --env-file-if-exists='{1}' 'src/server.js' 1>> '{3}' 2>> '{4}'
  $ran = [int]((Get-Date) - $started).TotalSeconds
  if ($ran -ge 60) { $delay = 2 } else { $delay = [Math]::Min($delay * 2, 60) }
  "[$(Get-Date -Format s)] 节点退出（运行 ${ran}s），${delay}s 后重启" | Add-Content -LiteralPath '{4}'
  Start-Sleep -Seconds $delay
}
'@
  $body = $template -f $exe, $ENV_FILE, $Dir, $log, $errlog
  Set-Content -LiteralPath $LAUNCHER -Value $body -Encoding UTF8
  Write-Ok "看护脚本就绪：$LAUNCHER"
}

function Install-ServiceTask {
  <#
    注册计划任务：开机（含无人登录时）以 SYSTEM 启动看护脚本。
    与 systemd 单元 / docker --restart 的定位相同：机器起来，店就开着。
    管理员权限在**入口**已经判过（见上面那条权限门禁）——那里判的代价最小。
  #>
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$LAUNCHER`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  # 失败重启：看护脚本若因故退出（例如 node 装坏），任务自己再拉几次
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)   # 0 = 不限时（节点是常驻进程）
  Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Force | Out-Null
  Write-Ok "开机自启已注册：计划任务 $TASK_NAME（以 SYSTEM 运行，无人登录也会起）"
}

function Start-ServiceTask {
  Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
}
function Stop-ServiceTask {
  # 先停任务（看护进程），再杀掉它拉起的 node —— 否则看护进程会立刻把 node 再拉起来
  Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Dir*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Test-Health {
  <#
    探活。判据与 deploy.sh 一致：**不只看 HTTP 200**，要看 body 里的 code:0
    与 escrowAddress（"接错托管合约"一样返回 200 —— 那正是要挡的静默失败）。
  #>
  param([int]$TimeoutSec = 8)
  $url = "http://127.0.0.1:$Port/healthz"
  try {
    $resp = Invoke-WebRequest -Uri $url -TimeoutSec $TimeoutSec -UseBasicParsing
    $json = $resp.Content | ConvertFrom-Json
    return [pscustomobject]@{ Ok = ($json.code -eq 0); Raw = $json; Url = $url }
  } catch {
    return [pscustomobject]@{ Ok = $false; Raw = $null; Url = $url }
  }
}

# =============================================================================
# 只读模式：-Status / -Health
# =============================================================================
if ($MODE -eq 'health') {
  $h = Test-Health
  if ($h.Ok) {
    $w = $h.Raw.data.watcher
    Write-Ok "健康：code=0 escrow=$($h.Raw.data.escrowAddress) cursor=$($w.cursor) lag=$($w.lagBlocks)"
    exit 0
  }
  Write-Warn "不健康：$($h.Url) 探活失败或 code != 0"
  exit 2
}

if ($MODE -eq 'status') {
  Write-Step '节点现状'
  $task = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    Write-Info "  计划任务：$TASK_NAME  状态：$($task.State)  上次结果：$($info.LastTaskResult)"
  } else {
    Write-Warn "  计划任务 $TASK_NAME 不存在（还没装？）"
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Dir*" } |
    ForEach-Object { Write-Info "  进程：node.exe PID=$($_.ProcessId)" }
  if (Test-Path -LiteralPath $ENV_FILE) {
    Write-Info "  配置：$ENV_FILE"
    foreach ($k in @('MK_PORT', 'MK_SHOP_OWNER', 'MK_ESCROW_ADDRESS', 'MK_SIWE_DOMAIN', 'MK_CORS_ORIGIN')) {
      $v = Read-EnvValue -Path $ENV_FILE -Key $k
      if ($v) { Write-Info "    $k=$v" }
    }
  } else {
    Write-Warn "  配置不存在：$ENV_FILE"
  }
  Write-Step '探活'
  $h = Test-Health
  if ($h.Ok) { Write-Ok "探活：$($h.Raw | ConvertTo-Json -Compress -Depth 3)" } else { Write-Warn "探活失败：$($h.Url)"; exit 2 }
  exit 0
}

# =============================================================================
# 卸载
# =============================================================================
if ($MODE -eq 'uninstall' -or $MODE -eq 'purge') {
  Write-Step '卸载'
  if ($MODE -eq 'purge') {
    Write-Warn "== -Purge：会**删除数据目录 $DATA_DIR**（附件与商品媒体全没；库在 MySQL 里，不在本目录内）—— 不可逆 =="
    if (-not $Yes) {
      $ans = Read-Host "  确认请输入 PURGE"
      if ($ans -ne 'PURGE') { Die '输入不匹配，什么都没删' }
    }
  }
  Stop-ServiceTask
  Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
  Write-Ok "计划任务已移除：$TASK_NAME"
  if ($MODE -eq 'purge') {
    Remove-Item -LiteralPath $DATA_DIR -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "数据目录已删除：$DATA_DIR（库在 MySQL 里，不在本目录内，要一起删就 DROP DATABASE）"
  } else {
    Write-Ok "附件与商品媒体保留在：$DATA_DIR（要一起删：.\deploy.ps1 -Purge；库在 MySQL 里，得自己删）"
  }
  Write-Info "代码/配置/日志保留在 $Dir（含 .env，里面有令牌密钥；不需要了就自行删除）"
  exit 0
}

# =============================================================================
# ② 环境检测（安装/升级路径）
# =============================================================================
if ($MODE -ne 'health') {
  Write-Step '① 环境检测'
  Write-Info "系统：$(Get-PlatformInfo)"
  Write-Info "目录：$Dir    任务：$Service    端口：$Port    绑定：$Bind    TLS：$TlsMode"
}

$nodeExe = Get-NodeExe
if ($DRY_RUN) {
  Write-Step 'dry-run：以上是计划'
  if ($nodeExe) { Write-Info "将使用已有 Node：$nodeExe（$(& $nodeExe -v)）" }
  else { Write-Info "将下载并安装 Node $NodeVersion 到 $NODE_DIR（不动系统 PATH）" }
  Write-Info "将写配置 $ENV_FILE（ACL 收紧）"
  Write-Info "将安装生产依赖（npm ci --omit=dev）"
  Write-Info "将注册开机自启的计划任务 $TASK_NAME（SYSTEM）并启动"
  if ($TlsMode -eq 'caddy') { Write-Info "将在本机用 Caddy 申请证书（$Domain，需 80/443 可达）" }
  else { Write-Info "本机不申请证书：节点监听 $Bind`:$Port，TLS 与证书由你的外部入口终止" }
  Write-Info '去掉 -DryRun 即真正执行'
  exit 0
}

if (-not $nodeExe) {
  Write-Step '安装 Node'
  $nodeExe = Install-Node -Version $NodeVersion
}
$nodeVer = & $nodeExe -v
Write-Ok "Node 可用：$nodeVer（$nodeExe）"

# =============================================================================
# ③ 店主地址 / 域名
# =============================================================================
if ($MODE -ne 'update' -or -not (Test-Path -LiteralPath $ENV_FILE)) {
  if (-not $Owner) { $Owner = Read-EnvValue -Path $ENV_FILE -Key 'MK_SHOP_OWNER' }
  if (-not $Owner) {
    if ($Yes) { Die '缺少 -Owner（店主钱包地址）' }
    $Owner = (Read-Host '  你的店主钱包地址（商品上架/发货的身份锚点，例如 0x1234…）').Trim()
  }
  if ($Owner -notmatch '^0x[0-9a-fA-F]{40}$') { Die "店主钱包地址格式不对：$Owner" }
  if ($Owner -match '^0x0{40}$') { Die '店主地址不能是全零地址' }

  if (-not $Domain) { $Domain = Read-EnvValue -Path $ENV_FILE -Key 'MK_SIWE_DOMAIN' }
  if (-not $Domain -and -not $Yes) {
    $Domain = (Read-Host '  对外域名（可留空：先跑起来，稍后再配）').Trim()
  }
  $Domain = $Domain -replace '^https?://', '' -replace '/.*$', ''
}

if (-not $Owner) { $Owner = Read-EnvValue -Path $ENV_FILE -Key 'MK_SHOP_OWNER' }

Write-Log ''
Write-Info "店主地址：$Owner"
Write-Info "对外域名：$(if ($Domain) { "https://$Domain" } else { '（未指定，节点不会被买家发现）' })"
Write-Info "HTTPS   ：$TlsMode"
Write-Info "合约：Escrow=$Escrow  Staking=$Staking（自 deploy-constants.json）"

# =============================================================================
# ④ 写配置
# =============================================================================
Write-Step "③ 写配置（$ENV_FILE）"
New-Item -ItemType Directory -Force -Path $Dir, $DATA_DIR, $LOG_DIR | Out-Null
$secret = Read-EnvValue -Path $ENV_FILE -Key 'MK_TOKEN_SECRET'
if ($secret.Length -lt 32) {
  $secret = New-Secret
  Write-Ok '已生成强随机令牌密钥 MK_TOKEN_SECRET（只写在本机 .env，ACL 收紧）'
} else {
  Write-Ok '沿用已有 MK_TOKEN_SECRET（店主登录态不失效）'
}
# Redis 是硬依赖：升级沿用已有 .env；首次必须显式传 --RedisUrl 或先写 MK_REDIS_URL。
if (-not $RedisUrl) { $RedisUrl = Read-EnvValue -Path $ENV_FILE -Key 'MK_REDIS_URL' }
if (-not $RedisUrl) { throw 'Redis 是节点必需依赖：请加 --RedisUrl redis://[:密码@]主机:6379/0（或先写 MK_REDIS_URL）' }
Write-EnvFile -OwnerAddr $Owner -DomainName $Domain -Secret $secret -Redis $RedisUrl

# =============================================================================
# ⑤ 装依赖
# =============================================================================
Write-Step '④ 安装依赖（npm ci --omit=dev）'
if (-not (Test-Path -LiteralPath (Join-Path $Dir 'package.json'))) {
  Die "$Dir 里没有 package.json —— 这不是一份节点代码（把本仓库的 node\ 目录内容放在这里，或用 -Dir 指到正确目录）"
}
$npm = Join-Path (Split-Path -Parent $nodeExe) 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm)) {
  # 官方 Windows 包里 npm 与 node 同目录；找不到就用 PATH 上的
  $npm = 'npm'
}
Push-Location $Dir
try {
  & $npm ci --omit=dev 2>&1 | ForEach-Object { Write-Info "  $_" }
  if ($LASTEXITCODE -ne 0) { Die "npm ci 失败（看上面的输出）" }
} finally {
  Pop-Location
}
Write-Ok '依赖就绪'

# =============================================================================
# ⑥ 注册服务并启动
# =============================================================================
Write-Step '⑤ 注册开机自启并启动'
Write-Launcher
Install-ServiceTask
Start-ServiceTask

Write-Step '⑥ 探活'
$deadline = (Get-Date).AddSeconds(60)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $h = Test-Health
  if ($h.Ok) { $healthy = $true; break }
}
if (-not $healthy) {
  Write-Warn "60 秒内没起来。看日志：$LOG_DIR\node.err.log"
  Write-Warn "计划任务状态：$( (Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue).State )"
  Die '节点没起来（数据与配置都还在，修好后重跑 .\deploy.ps1 -Update）'
}
$hh = Test-Health
Write-Ok "探活通过：code=0"
Write-Info "  escrowAddress=$($hh.Raw.data.escrowAddress)  host=$($hh.Raw.data.host)"
$w = $hh.Raw.data.watcher
Write-Info "  watcher: cursor=$($w.cursor) latest=$($w.latest) lag=$($w.lagBlocks) lastError=$($w.lastError)"
if ($hh.Raw.data.escrowAddress -and $hh.Raw.data.escrowAddress.ToLower() -ne $Escrow.ToLower()) {
  Die "接的托管合约不是本批的（节点自报 $($hh.Raw.data.escrowAddress)，常量里是 $Escrow）—— 检查 .env 与 deploy-constants.json"
}

# =============================================================================
# ⑦ HTTPS（可选，本机终止）
# =============================================================================
if ($TlsMode -eq 'caddy') {
  Write-Step '⑦ Caddy（自动 HTTPS）'
  if (-not $Domain) { Write-Warn '选了 caddy 但没给域名 —— 跳过（Caddy 申请证书必须有域名）' }
  else {
    $caddyExe = Join-Path $Dir 'caddy.exe'
    if (-not (Test-Path -LiteralPath $caddyExe)) {
      Write-Info "下载 Caddy（Windows amd64）…"
      $caddyZip = Join-Path $env:TEMP 'caddy.zip'
      try {
        Invoke-WebRequest -Uri 'https://caddyserver.com/api/download?os=windows&arch=amd64' -OutFile $caddyZip -UseBasicParsing
        Expand-Archive -LiteralPath $caddyZip -DestinationPath (Split-Path -Parent $caddyExe) -Force
        Remove-Item -LiteralPath $caddyZip -Force -ErrorAction SilentlyContinue
      } catch {
        Write-Warn "下载 Caddy 失败：$($_.Exception.Message)"
        Write-Warn "  可以让外部入口终止 TLS：本机已监听 $Bind`:$Port，把域名反代过来即可"
      }
    }
    if (Test-Path -LiteralPath $caddyExe) {
      $caddyfile = Join-Path $Dir 'Caddyfile'
      @"
# 由 deploy.ps1 生成；改完执行：.\deploy.ps1 -Update -- 或直接重启计划任务 $Service
{
	email $Email
}

$Domain {
	encode gzip
	reverse_proxy 127.0.0.1:$Port
	header {
		-Server
	}
}
"@ | Set-Content -LiteralPath $caddyfile -Encoding UTF8
      Write-Ok "Caddyfile 就绪：$caddyfile（Caddy 以计划任务方式常驻由你自行决定；本脚本只准备二进制与配置）"
      Write-Warn 'Caddy 需要占用 80/443 且域名已解析到本机；若本机已有入口在终止 TLS，请改走 -TlsMode none'
    }
  }
}

# =============================================================================
# ⑧ 状态文件
# =============================================================================
$script:STATE['owner'] = $Owner
$script:STATE['domain'] = $Domain
$script:STATE['node'] = $nodeVer
$script:STATE['updatedAt'] = [DateTime]::UtcNow.ToString('s')
$script:STATE | ConvertTo-Json | Set-Content -LiteralPath $STATE_FILE -Encoding UTF8
Write-Ok "状态已记录：$STATE_FILE"

# =============================================================================
# ⑨ 链上登记（可选）
# =============================================================================
if ($Domain -and $MODE -ne 'update') {
  Write-Log ''
  Write-Info "还差一步买家才能发现你：到 $FrontendOrigin 的「开店/登记我的节点」用钱包完成链上登记"
  Write-Info "  （登记 endpoint = https://$Domain；未登记时前端聚合列表里不会有这家店）"
}

Write-Log ''
Write-Ok '完成。常用命令：'
Write-Info "    .\deploy.ps1 -Status              # 现状（任务/进程/配置/探活）"
Write-Info "    .\deploy.ps1 -Health              # 一行探活（不健康退出码 2）"
Write-Info "    .\deploy.ps1 -Update              # 重新安装依赖并重启（数据不动）"
Write-Info "    .\deploy.ps1 -Uninstall           # 停掉并注销任务（附件与商品媒体保留；库在 MySQL 里）"
Write-Info "    .\deploy.ps1 -Purge               # 连附件与商品媒体一起删（不可逆；库不在其中）"
