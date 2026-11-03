/**
 * 宿主平台适配层（node/platform.sh）的回归测试。
 *
 * 为什么这一层必须有测试：deploy.sh 的其余部分吃的是"平台结论"（用哪个包管理器装 Docker、
 * 要不要 root、装到哪个目录、能不能用 --tls-mode nginx），而结论错的表现是**静默的**——
 * 脚本照样跑完，只是要么装错了东西、要么把目录写到不该写的地方。这些分支在 CI 上永远
 * 走不到（CI 只有一种宿主），靠人一台台机器点不现实。
 *
 * 做法：给 host_probe 一个**假宿主**（PATH 里只放我们点名的包管理器/init 命令，
 * os-release 指到临时文件），然后只断言结论。测的是"判据"，**不是**"真能在 AlmaLinux 上
 * 装成功"——后者必须回真机验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM_SH = path.join(NODE_DIR, 'platform.sh');

/**
 * Windows 上的 bash 是 MSYS/Git Bash，它**不认 `C:\...` 形式的 PATH**（那是 Windows 语义）。
 * 注入给它的每个路径都要先转成 MSYS 形式。用 bash 自己的 cygpath 转，转不了就原样返回
 * （Linux CI 上什么都不用做）。
 */
function toBashPath(p) {
  if (!BASH) return p;
  const r = spawnSync(BASH, ['-c', 'command -v cygpath >/dev/null && cygpath -u "$1" || printf %s "$1"', '-', p], { encoding: 'utf8' });
  return (r.stdout || p).trim() || p;
}
/**
 * 找得到 bash 吗。
 * platform.sh 服务的是 Linux/macOS 部署（Windows 走 deploy.ps1），所以这个测试在
 * **没有 bash 的 Windows 上必须明确跳过**，而不是报一堆看不懂的失败——"跳过的原因"
 * 与"失败"是两件事，混在一起会让下一个人以为是脚本坏了。
 * bash 的路径按"能执行才算"来判：Windows 常见安装位置的 `bash.exe` 本身只是个转发器。
 */
function findBash() {
  const candidates = [
    'bash',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env.BASH,
  ].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'exit 0'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}
const BASH = findBash();
const SKIP = BASH ? false : '本机没有可执行的 bash（platform.sh 面向 Linux/macOS；Windows 走 deploy.ps1）';
/**
 * MSYS/Git Bash 的根前缀（Windows 上 Node 看不到 /usr/bin，要靠 bash 报出来）
 */
const BASH_ROOT = (() => {
  if (!BASH) return '';
  const r = spawnSync(BASH, ['-c', 'printf %s "${MINGW_PREFIX:-}"'], { encoding: 'utf8' });
  return (r.stdout || '').trim();
})();

/**
 * 假宿主的工作目录。
 *
 * 由 **bash 自己** `mktemp -d` 建，而不是 Node 的 `mkdtempSync('/tmp/…')`：
 * 测试可能跑在"Node 是宿主二进制、bash 在 Linux 容器里"的组合下（本仓验证多发行版时就是
 * 这么跑的：把宿主 node 挂进 debian/almalinux 容器）。那种组合里 `/tmp` 对 Node 不存在、
 * 而 `os.tmpdir()` 给的是宿主临时目录 —— 容器看不到它，stub 写不进 calls.log，
 * 看起来像生产代码坏了，实际是装置错位（本仓经典形状：代价挂错了维度）。
 * bash 自己建的目录，两端都看得见：容器里是真 /tmp，Git Bash 里是 MSYS /tmp。
 */
function makeBinDir() {
  if (BASH) {
    const r = spawnSync(BASH, ['-c', 'D=$(mktemp -d) || exit 1; echo "probe" > "$D/.w" || exit 1; rm -f "$D/.w"; printf %s "$D"'], { encoding: 'utf8' });
    const dir = (r.stdout || '').trim();
    if (r.status === 0 && dir) {
      const native = spawnSync(BASH, ['-c', 'command -v cygpath >/dev/null && cygpath -w "$1" || printf %s "$1"', '-', dir], { encoding: 'utf8' });
      const p = (native.stdout || '').trim();
      if (p) return p;
    }
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mk-host-'));
}

/** 把 bash 报出来的路径转成 Node 能直接读的形式（Git Bash 下需要 cygpath） */
function toNativePath(p) {
  if (!BASH) return p;
  const r = spawnSync(BASH, ['-c', 'command -v cygpath >/dev/null && cygpath -w "$1" || printf %s "$1"', '-', p], { encoding: 'utf8' });
  return (r.stdout || p).trim() || p;
}

/** 探测时被"遮蔽"的候选命令：不在假宿主的 commands 里就让它找不到（见 runInFakeHost 注释） */
const SHADOWABLE = ['apt-get', 'dnf', 'yum', 'zypper', 'apk', 'pacman', 'systemctl', 'rc-service', 'service'];

/**
 * 在"假宿主"里跑一段脚本。
 *   commands —— 这台机器上**存在**的命令（没点名的一律不存在，于是包管理器探测结果由我们决定）
 *   uname    —— uname -s 的输出
 * 返回值里的 binDir 里有 calls.log：stub 被调用时会记录一行，用来断言"分派到了哪个安装器"。
 */
function runInFakeHost({ uname = 'Linux', osReleaseId = 'testos', commands = [], osOverride = '', inContainer = '', immutable = '', script }) {
  /*
    假宿主**整个在 bash 里搭起来**（目录、os-release、stub 二进制）。
    为什么不在 Node 侧建：测试可能跑在"Node 是宿主二进制、bash 在 Linux 容器里"的组合下
    （本仓验证多发行版时就是这么跑的）。那种组合里 Node 建的目录落在**宿主文件系统**上，
    容器以 root 进去对它没有执行权限 —— stub 存在、`command -v` 找得到、但一执行就 127，
    表现为"分派测试红了"，而生产代码没问题（本仓经典形状：代价挂错了维度）。
    bash 自己建的目录在自己那侧天然可执行/可写。
  */
  const q = (s) => JSON.stringify(s);
  const stubs = commands
    /*
      stub 把调用记到 `$MK_FAKE_CALLS`（由下面 export），而不是自己拼路径：
      拼路径要写 `$(dirname "$0")`，而它嵌在 printf 的双引号里会被**提前展开**，
      写进文件就成了语法错误（实测："Unterminated quoted string"）。
      改成引用一个已导出的变量，嵌套引号问题从根上消失 —— 而变量值由 bash 自己算，
      所以"容器里 /tmp、Git Bash 里 MSYS 路径"两种情况都不用特判。
    */
    .map((name) => `printf '#!/bin/sh\\necho "STUB ${name}" >> "$MK_FAKE_CALLS"\\nexit 0\\n' > "$HOST_TEST_BIN/${name}"; chmod 755 "$HOST_TEST_BIN/${name}"`)
    .join('\n');
  /*
    让"假宿主"里的包管理器探测可控 —— **这一步不是洁癖，是判据的一部分**。
    spawnSync 会把父进程的 PATH 传下去，于是如果宿主真有 apt-get（CI、容器、Ubuntu 机器都
    是），`command -v apt-get` 会命中**真的那个**，探测结果随宿主而变：看起来像断言写错了，
    实际是测试装置让被测判据漏了气（本仓经典形状：代价挂错了维度）。

    做法有两处讲究：
      1) **不能把 PATH 缩成一个目录**：MSYS（Git Bash）的 cat/grep 依赖 /usr/bin 下的 DLL，
         PATH 里没有它就整片 127（实测）。所以保留系统目录，只把被点名的命令**遮蔽**掉。
      2) 遮蔽靠**劫持 `command` 内建**：`command -v X` 只在 X 不可用时为假，而这里对
         "没被点名的候选命令"直接返回 1，于是探测看到的就是"这台假宿主上没有它"。
         试过三种更"正统"的写法都不成立，记下来免得下一个人再走一遍：
           · 把 PATH 缩成一个目录 → MSYS 的 cat/grep 因缺 DLL 整片 127；
           · 定义同名函数返回 127 → `command -v` 照样报告"函数存在"；
           · 用 `exec` 重写命令 → `command -v` 照样找到真实二进制（真 Linux 上实测）。
  */
  const SYSTEM_PATH = BASH_ROOT ? `${BASH_ROOT}/bin:/usr/bin:/bin` : '/usr/bin:/bin';
  const requested = new Set(commands);
  const hidden = SHADOWABLE.filter((c) => !requested.has(c));
  const commandFn = `command() { if [ "\${1:-}" = "-v" ]; then case "\${2:-}" in ${hidden.join('|')}) return 1 ;; esac; fi; builtin command "$@"; }`;
  const prelude = [
    'set -eu',
    // uname 用 shell 函数而不是假二进制：-s 决定平台，-m 供 VER 用
    `uname() { if [ "$1" = "-s" ]; then echo ${q(uname)}; else echo x86_64; fi; }`,
    'HOST_TEST_BIN="$(mktemp -d)"',
    `export PATH="$HOST_TEST_BIN:${SYSTEM_PATH}"`,
    'MK_FAKE_CALLS="$HOST_TEST_BIN/calls.log"; export MK_FAKE_CALLS',
    stubs,
    `printf 'ID=${osReleaseId}\\nVERSION_ID=9.4\\nPRETTY_NAME="${osReleaseId} 9.4"\\n' > "$HOST_TEST_BIN/os-release"`,
    `export MK_HOST_OS_RELEASE_FILE="$HOST_TEST_BIN/os-release"`,
    commandFn,
    osOverride ? `export MK_HOST_OS=${q(osOverride)}` : 'unset MK_HOST_OS',
    inContainer ? `export MK_HOST_IN_CONTAINER=${q(inContainer)}` : 'unset MK_HOST_IN_CONTAINER',
    immutable ? `export MK_HOST_IMMUTABLE=${q(immutable)}` : 'unset MK_HOST_IMMUTABLE',
    `. ${q(toBashPath(PLATFORM_SH))}`,
    // 把假宿主目录报给外面（断言要读它下面的 calls.log）
    'printf "HOST_TEST_BIN=%s\\n" "$HOST_TEST_BIN" >&2',
  ].join('\n');
  const r = spawnSync(BASH, ['-c', `${prelude}\n${script}`], { encoding: 'utf8' });
  const m = /HOST_TEST_BIN=(.+)/.exec(r.stderr || '');
  return {
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').replace(/HOST_TEST_BIN=.+\n?/, '').trim(),
    status: r.status,
    // Node 侧的路径：Git Bash 下 mktemp 给的是 MSYS 路径，读文件前要转成 Windows 形式
    binDir: m ? toNativePath(m[1].trim()) : '',
  };
}

/** 发行版矩阵：**判据是包管理器与 init，不是发行版名**（名字一直在变，包管理器不会） */
const DISTROS = [
  { name: 'Alibaba Cloud Linux 3', id: 'alinux', cmds: ['dnf', 'systemctl'], pm: 'dnf', init: 'systemd' },
  { name: 'Anolis OS 8', id: 'anolis', cmds: ['dnf', 'systemctl'], pm: 'dnf', init: 'systemd' },
  { name: 'TencentOS Server 3', id: 'tencentos', cmds: ['dnf', 'systemctl'], pm: 'dnf', init: 'systemd' },
  { name: 'OpenCloudOS 8', id: 'opencloudos', cmds: ['dnf', 'systemctl'], pm: 'dnf', init: 'systemd' },
  { name: 'AlmaLinux 9', id: 'almalinux', cmds: ['dnf', 'systemctl'], pm: 'dnf', init: 'systemd' },
  { name: 'Rocky Linux 9', id: 'rocky', cmds: ['dnf', 'systemctl'], pm: 'dnf', init: 'systemd' },
  { name: 'Fedora', id: 'fedora', cmds: ['dnf', 'systemctl'], pm: 'dnf', init: 'systemd' },
  { name: 'CentOS Stream 9 / CentOS 9', id: 'centos', cmds: ['dnf', 'systemctl'], pm: 'dnf', init: 'systemd' },
  { name: 'Red Hat Enterprise Linux 9', id: 'rhel', cmds: ['dnf', 'systemctl'], pm: 'dnf', init: 'systemd' },
  { name: 'Oracle Linux 9', id: 'ol', cmds: ['dnf', 'systemctl'], pm: 'dnf', init: 'systemd' },
  { name: 'Amazon Linux 2023', id: 'amzn', cmds: ['dnf', 'systemctl'], pm: 'dnf', init: 'systemd' },
  { name: 'Ubuntu 24.04', id: 'ubuntu', cmds: ['apt-get', 'systemctl'], pm: 'apt', init: 'systemd' },
  { name: 'Debian 12', id: 'debian', cmds: ['apt-get', 'systemctl'], pm: 'apt', init: 'systemd' },
  { name: 'openSUSE Leap 15.6', id: 'opensuse-leap', cmds: ['zypper', 'systemctl'], pm: 'zypper', init: 'systemd' },
  { name: 'Alpine', id: 'alpine', cmds: ['apk', 'rc-service'], pm: 'apk', init: 'openrc' },
  { name: 'Arch', id: 'arch', cmds: ['pacman', 'systemctl'], pm: 'pacman', init: 'systemd' },
];

for (const d of DISTROS) {
  test(`平台探测：${d.name} → ${d.pm}/${d.init}`, () => {
    const { out, status, err } = runInFakeHost({
      osReleaseId: d.id,
      commands: d.cmds,
      script: `host_probe; printf '%s|%s|%s|%s' "$MK_HOST_OS" "$MK_HOST_PM" "$MK_HOST_INIT" "$MK_HOST_VER"`,
    });
    assert.equal(status, 0, `platform.sh 在假宿主里应正常结束，stderr=${err}`);
    const [osName, pm, init, ver] = out.split('|');
    assert.equal(osName, 'linux');
    assert.equal(pm, d.pm, `${d.name} 应识别为 ${d.pm}`);
    assert.equal(init, d.init, `${d.name} 的服务管理应为 ${d.init}`);
    assert.match(ver, new RegExp(d.id), '发行版描述取自已加载的 os-release');
  });
}

test('macOS：识别为 macos、无包管理器/init，且不需要 root', { skip: SKIP }, () => {
  const { out, status } = runInFakeHost({
    uname: 'Darwin',
    script: `host_probe; printf '%s|%s|%s|%s' "$MK_HOST_OS" "$MK_HOST_PM" "$MK_HOST_INIT" "$MK_HOST_WANTS_ROOT"`,
  });
  assert.equal(status, 0);
  assert.equal(out, 'macos|none|none|0');
});

test('Windows（Git Bash/MSYS）：识别为 windows，由 deploy.sh 门禁路由到 deploy.ps1', { skip: SKIP }, () => {
  // 真机形态就是本仓开发机：uname 报 MINGW64_NT-…。必须归到 windows 而不是 unknown，
  // 否则店主只会看到"无法识别的宿主系统"，看不出该走哪条路。
  const { out, status } = runInFakeHost({
    uname: 'MINGW64_NT-10.0-19045',
    script: `host_probe; printf '%s' "$MK_HOST_OS"`,
  });
  assert.equal(status, 0);
  assert.equal(out, 'windows');
});

test('不自动装 Docker：macOS 装不了（Docker 是带 VM 的应用，装它要图形界面）', { skip: SKIP }, () => {
  const { status, out } = runInFakeHost({
    uname: 'Darwin',
    script: `host_probe; host_install_docker "" && echo INSTALLED || echo REFUSED`,
  });
  assert.equal(status, 0);
  assert.equal(out, 'REFUSED', out);
});

test('容器内不装 Docker：装不了（引擎来自宿主），且指引说清这一点', { skip: SKIP }, () => {
  const { status, out } = runInFakeHost({
    commands: ['dnf', 'systemctl'],
    inContainer: '1',
    script: `host_probe; host_install_docker "" && echo INSTALLED || echo REFUSED; host_docker_install_hint 2>&1 | head -1`,
  });
  assert.equal(status, 0);
  assert.match(out, /^REFUSED/);
  assert.match(out, /在容器里/);
});

test('不可变宿主（CoreOS 类）：不装 Docker，指引点明原因', { skip: SKIP }, () => {
  const { status, out } = runInFakeHost({
    commands: [], // 没有包管理器
    immutable: '1',
    // 显式声明"不在容器里"：不可变宿主与"在容器里"是两件事。测试若跑在容器里
    // （本仓验证多发行版时就是），不声明就会让两条拒绝理由叠加，测不到想测的那一条。
    inContainer: '0',
    script: `host_probe; host_install_docker "" && echo INSTALLED || echo REFUSED; host_docker_install_hint 2>&1 | head -1`,
  });
  assert.equal(status, 0);
  assert.match(out, /^REFUSED/);
  assert.match(out, /不可变宿主/);
});

test('装 Docker 按包管理器分派：CentOS/RHEL 系走 dnf（不再靠 have 链各判一次）', { skip: SKIP }, () => {
  const { status, out } = runInFakeHost({
    commands: ['dnf', 'systemctl'],
    inContainer: '0', // 见上面 CoreOS 用例：跑在容器里时，不声明就会被"容器内不装"先拦下
    script: `host_probe; host_install_docker "" >/dev/null 2>&1 || true; grep -c 'STUB dnf' "$MK_FAKE_CALLS" 2>/dev/null || echo 0`,
  });
  assert.equal(status, 0);
  assert.equal(out, '1', `应恰好调用一次 dnf：${out}`);
});

test('装 Docker 按包管理器分派：openSUSE 走 zypper、Alpine 走 apk', { skip: SKIP }, () => {
  for (const [cmd, distro] of [['zypper', 'opensuse-leap'], ['apk', 'alpine']]) {
    const r = runInFakeHost({
      osReleaseId: distro,
      commands: [cmd, 'systemctl'],
      inContainer: '0', // 同上：分派要在"真机上装"这个前提下测
      script: `host_probe; host_install_docker "" >/dev/null 2>&1 || true; grep -c 'STUB ${cmd}' "$MK_FAKE_CALLS" 2>/dev/null || echo 0`,
    });
    assert.equal(r.status, 0);
    assert.equal(r.out, '1', `${distro} 应恰好调用一次 ${cmd}：${r.out}`);
  }
});

test('起守护按 init 分派：systemd → systemctl enable --now docker', { skip: SKIP }, () => {
  const { status, out } = runInFakeHost({
    commands: ['dnf', 'systemctl'],
    inContainer: '0', // 同上
    script: `host_probe; dk() { return 0; }; host_start_docker dk "" >/dev/null 2>&1 || true; grep -o 'STUB systemctl' "$MK_FAKE_CALLS" | head -1`,
  });
  assert.equal(status, 0);
  assert.equal(out, 'STUB systemctl', out);
});

test('起守护：非 Linux 直接返回 0（macOS 上守护由 Desktop/colima 自己管，脚本不碰）', { skip: SKIP }, () => {
  const { status, out } = runInFakeHost({
    uname: 'Darwin',
    script: `host_probe; host_start_docker dk "" && echo READY || echo FAILED`,
  });
  assert.equal(status, 0);
  assert.equal(out, 'READY');
});

test('默认安装目录：Linux 有 root → /opt，没 root → $HOME；macOS 永远 $HOME', { skip: SKIP }, () => {
  // $HOME 必须由 **bash 自己**报出来：Node 的 process.env.HOME 在 Windows 上是空的，
  // 而 bash（MSYS）里有值 —— 拿 Node 的值断言会得到一个假失败。
  const linux = runInFakeHost({
    commands: ['dnf'],
    script: `host_probe; host_default_dir 1; echo ---; host_default_dir 0; echo ---; printf '%s' "$HOME"`,
  });
  const [withRoot, withoutRoot, bashHome] = linux.out.split('---').map((s) => s.trim());
  assert.equal(withRoot, '/opt/marketplace-node', '有 root/sudo 时用 /opt（FHS 约定）');
  assert.equal(withoutRoot, `${bashHome}/marketplace-node`, '没有 root 时用 $HOME');
  const mac = runInFakeHost({ uname: 'Darwin', script: `host_probe; host_default_dir 1` });
  assert.match(mac.out, /\/marketplace-node$/);
  assert.doesNotMatch(mac.out, /^\/opt/, 'macOS 上没有 /opt 约定，不许默认装到那里');
});

test('能力判据：旧 systemd 残留只在 Linux+systemd 上检查；--tls-mode nginx 只在 Linux 可用', { skip: SKIP }, () => {
  const linux = runInFakeHost({
    commands: ['dnf', 'systemctl'],
    script: `host_probe; host_supports_systemd_legacy && echo legacy-ok; host_supports_nginx_certbot && echo nginx-ok`,
  });
  assert.equal(linux.out, 'legacy-ok\nnginx-ok');
  const mac = runInFakeHost({
    uname: 'Darwin',
    script: `host_probe; host_supports_systemd_legacy && echo legacy-ok || echo no-legacy; host_supports_nginx_certbot && echo nginx-ok || echo no-nginx`,
  });
  assert.equal(mac.out, 'no-legacy\nno-nginx', 'macOS 上既没有 systemd 也没有 conf.d 约定，这两条必须是否');
});
