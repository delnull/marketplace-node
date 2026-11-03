/**
 * SSH 执行层 —— **脚本与"刚买回来的那台机器"之间唯一的通道**。
 *
 * 为什么用系统 OpenSSH 而不是自己实现协议：Node 没有内建 SSH 客户端，而引第三方库会
 * 给这个本该"零依赖、直接 node 跑"的工具加一条供应链。系统 ssh/scp 在 Linux/macOS 自带、
 * Windows 10+ 也自带（OpenSSH Client 可选功能），是本机已有的东西。
 *
 * 三件事在这里定死：
 *   1. **密钥是本工具自己生成的**（默认 **RSA-2048**，见 `generateSshKey` 的说明：
 *      腾讯云的 `ImportKeyPair` 只吃 OpenSSH RSA 公钥，ed25519 不是四家共同支持的那一种；
 *      要换用 `--ssh-key-type ed25519`）：不向用户要私钥路径，也不复用他机器上已有的
 *      `~/.ssh/id_*`（那种复用会悄悄扩大那把钥匙的授权面）。生成的私钥只落在
 *      `.provision/ssh/<shop>.key`（0600），状态文件只记路径。
 *   2. **一切连接都是非交互的**（`BatchMode=yes`）：没有密码回退、没有 host key 提问。
 *      交互式提问在"由 AI 跑一条流程"的场景里不是交互，是挂死。
 *   3. **首次连接的主机密钥**：用 `accept-new` 记下来（新买的机器只可能是第一次），
 *      之后同一台机器指纹变了会**硬失败**——那正是需要人看一眼的情形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 云厂商控制台里删机器后 IP 会被回收再利用，所以只对本次流程里"刚连过的那台"放宽。 */
const SSH_BASE = [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=4',
  '-o', 'LogLevel=ERROR',
];

/**
 * 远端命令里的字面量一律用单引号包裹（值与命令之间没有第二层解析）。
 *
 * 为什么住在这里：`sshRun` 是本工具**唯一**把字符串送进远端 shell 的地方，而"把一个值安全地
 * 嵌进 shell 命令"只有一份正确写法（单引号 + 内部单引号转义成 `'\''`）。
 * 2026-10-15 审计实测：`lib/destroy.mjs` 用 `JSON.stringify(script)` 拼 `bash -lc "…"`，
 * 而那是**坏的**（不只是"不够稳"）——在真 bash 上跑同一段脚本：
 *   · 旧写法：`exit=2`，`bash: line 1: set: pipefailnVALUE=…`（JSON 把换行写成 `\n` 两个字面字符，
 *     脚本被拼成一行）；`$HOME`/反引号被**外层 shell 先展开**，双引号被吃掉；
 *   · 新写法：`exit=0`，脚本逐字送达（`原始值=[a $HOME \`whoami\` "quoted" \ backslash]` 原样回显）。
 * 也就是说 `destroy` 的"先导出数据卷再释放机器"这条路径在真机上根本跑不起来，
 * 而失败信息看起来像"远端脚本自己有语法错"。同一个函数在 `up.mjs` 里早就是对的——
 * 两份实现里错的那一份不报错，只让某些值在远端变成别的东西（这里连值都到不了）。
 */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 把一段多行脚本安全地送进远端 bash：脚本作为**一个值**，不再被外层 shell 二次解析。 */
export function bashScript(script) {
  return `bash -lc ${shellQuote(script)}`;
}

export class SshError extends Error {
  constructor(message, { code, output } = {}) {
    super(message);
    this.name = 'SshError';
    this.code = code;
    this.output = output;
  }
}

/**
 * 生成本次部署专用密钥对。返回 { keyPath, publicKey }。
 * `publicKey` 是 OpenSSH 单行格式（`ssh-ed25519 AAAA… comment`），四家云的开机注入都吃这个。
 *
 * 为什么用系统的 `ssh-keygen` 而不是 Node 的 crypto：Node 导出的 PKCS#8 PEM
 * **OpenSSH 客户端读不了**（实测 `ssh-keygen -y` 直接 `invalid format`），而云控制台要的、
 * ssh 要用的都是 OpenSSH 原生格式。这里不能"生成完再转换"——转换本身也要 ssh-keygen。
 * 所以直接用它生成，并且这条依赖本来就与我们要求的一致（没有 OpenSSH 客户端连不上机器）。
 *
 * `keygen` 是**测试注入点**：默认就是真 ssh-keygen（生产路径只有这一条），
 * 测试里换成"写出一对固定密钥"的函数，好在没有 OpenSSH 的机器上也能跑编排测试。
 */
export function generateSshKey(keyPath, { type = 'rsa', keygen } = {}) {
  if (fs.existsSync(keyPath)) return { keyPath, publicKey: publicKeyFor(keyPath) };
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  if (keygen) return keygen({ keyPath, type });
  /*
    默认 RSA-2048 而不是 ed25519：这是这四家云的控制台上传/导入密钥时**共同支持**的那一种。
    ed25519 更现代，但腾讯云的 ImportKeyPair 文档明确要求 OpenSSH RSA 公钥，
    而"某些账号能导、某些不能"是最难排查的一类失败。用 RSA 换掉这个不确定性。
  */
  const args = type === 'ed25519' ? ['-t', 'ed25519'] : ['-t', 'rsa', '-b', '2048'];
  const res = spawnSync('ssh-keygen', [...args, '-N', '', '-C', 'marketplace-provision', '-f', keyPath, '-q'], {
    encoding: 'utf8',
  });
  if (res.error?.code === 'ENOENT') {
    throw new SshError('找不到 ssh-keygen：请安装 OpenSSH 客户端（Windows：设置 → 可选功能 → OpenSSH 客户端）');
  }
  if (res.status !== 0) throw new SshError(`ssh-keygen 失败（exit=${res.status}）：${res.stderr || ''}`);
  fs.chmodSync(keyPath, 0o600);
  return { keyPath, publicKey: publicKeyFor(keyPath) };
}

/** 从 .pub（或私钥派生的公钥）读出 OpenSSH 单行公钥 —— 重跑时状态文件只记了私钥路径 */
export function publicKeyFor(keyPath) {
  const pubPath = `${keyPath}.pub`;
  if (fs.existsSync(pubPath)) {
    const line = fs.readFileSync(pubPath, 'utf8').split('\n').find((l) => l.startsWith('ssh-') || l.startsWith('ecdsa-'));
    if (line) return line.trim();
  }
  throw new SshError(
    `读不到公钥：${pubPath} 不存在或格式不对。\n` +
      '        这一对密钥是本工具生成的，请让它自己管：删掉 .provision/ssh/ 下对应的两个文件后重跑。'
  );
}

function sshArgs(keyPath, target, extra = []) {
  return ['-i', keyPath, ...SSH_BASE, ...extra, target];
}

/**
 * 在同一条 SSH 连接上跑一段脚本。
 * @param {object} o
 * @param {string} o.keyPath
 * @param {string} o.user
 * @param {string} o.host
 * @param {string} o.script  远端 `bash -s` 读的脚本（用 stdin 传，避免多层引号被反复解析）
 * @param {boolean} [o.check] 失败时抛错（默认 true）
 * @param {(line:string)=>void} [o.onLine] 逐行回调（默认 inherit 给终端）
 */
export function runScript({ keyPath, user, host, script, check = true, onLine }) {
  const target = `${user}@${host}`;
  const res = spawnSync('ssh', sshArgs(keyPath, target, ['-T']), {
    input: script,
    encoding: 'utf8',
    // 不把远端输出吞进内存：部署日志可能几千行，实时给人看比最后一次性打印有用得多
    stdio: ['pipe', onLine ? 'pipe' : 'inherit', onLine ? 'pipe' : 'inherit'],
  });
  if (onLine) {
    for (const line of `${res.stdout || ''}${res.stderr || ''}`.split('\n')) if (line) onLine(line);
  }
  if (res.error?.code === 'ENOENT') {
    throw new SshError('找不到 ssh 命令：请安装 OpenSSH 客户端（Windows：设置 → 可选功能 → OpenSSH 客户端）');
  }
  if (check && res.status !== 0) {
    throw new SshError(`远端脚本失败（exit=${res.status}）`, { code: res.status, output: res.stdout });
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** 跑一条命令并取回 stdout（用于探活/取真值；不做引号魔法，命令原样交给远端 shell） */
export function run({ keyPath, user, host, command, check = true, timeoutMs = 60_000 }) {
  const res = spawnSync('ssh', sshArgs(keyPath, `${user}@${host}`, ['-T', command]), {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (res.error?.code === 'ENOENT') throw new SshError('找不到 ssh 命令（见 --help 的前置要求）');
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (check && res.status !== 0) throw new SshError(`远端命令失败（exit=${res.status}）：${command}\n${out}`, { code: res.status, output: out });
  return { status: res.status, out };
}

/** 上传一个本地文件到远端路径（先传到 /tmp 再按需要 sudo mv，调用方在脚本里做） */
export function upload({ keyPath, user, host, local, remote }) {
  const res = spawnSync('scp', ['-i', keyPath, '-q', ...SSH_BASE, local, `${user}@${host}:${remote}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (res.error?.code === 'ENOENT') throw new SshError('找不到 scp 命令（随 OpenSSH 客户端一起安装）');
  if (res.status !== 0) throw new SshError(`scp 失败（exit=${res.status}）：${local} → ${remote}`);
}

/** 这台机器现在能不能连上（云厂商控制台显示 running ≠ sshd 已就绪） */
export function probe({ keyPath, user, host }) {
  const res = spawnSync('ssh', sshArgs(keyPath, `${user}@${host}`, ['-T', '-o', 'ConnectTimeout=8', 'true']), {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return res.status === 0;
}
