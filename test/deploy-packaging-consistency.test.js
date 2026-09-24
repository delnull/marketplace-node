/**
 * 部署打包一致性守卫（2026-09 测试机全新安装时暴露）。
 *
 * 背景：`bash deploy.sh` 在「就地拷贝代码」这条路径上用 tar 的 `--exclude` 排掉 `.env` 与 `.env.*`
 * （本机开发用的 `.env` 里可能有私钥/令牌，不该被搬到服务器上），而 Dockerfile 里有一行
 * `COPY .env.example` —— `.env.example` 同样匹配 `.env.*`，于是**排掉之后镜像必然构建失败**：
 *     ERROR: failed to compute cache key: "/.env.example": not found
 * 这条分支只在「目标目录还不存在」时走到（全新安装）。之前的验证都是复用已经放好代码的目录，
 * 所以一直没暴露；真正把日志甩到脸上的是一次干净目录上的全新安装。
 *
 * 守卫的是"四处必须同时成立"：拷贝排除规则、把 `.env.example` 补回来、Dockerfile 的 COPY、
 * `.dockerignore` 的反向放行。任何一处被改而其余没跟上，这里就会红。
 *
 * 判据尽量做成**结构性**的（解析 Dockerfile 的 COPY 源 + 模拟拷贝排除规则），而不是"某行文字在不在"：
 * 这样以后往镜像里加文件（例如再 COPY 一个配置文件）时，只要它会被排除规则误杀，测试立刻发现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 节点代码根（`node/`），也就是镜像构建上下文 */
const NODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (rel) => fs.readFileSync(path.join(NODE_ROOT, rel), 'utf8');

/** glob（只用到 `*`）→ 正则：`*` 不跨路径分隔符 */
const globToRe = (pat) => new RegExp(`^${pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

/**
 * 模拟 tar 的匹配语义（本脚本里的模式都写成"名字"形式，故按**路径每一段**匹配；
 * 这是 GNU tar「不带 / 的模式匹配任意一层」的简化版，够用且不会过度承诺）。
 */
const excludedBy = (relPath, patterns) =>
  relPath.split('/').some((seg) => patterns.some((p) => (p.includes('/') ? globToRe(p).test(relPath) : globToRe(p).test(seg))));

/** deploy.sh 里「就地拷贝代码」那一段（从 tar 打包到该分支结束，含紧随其后的补回动作） */
function copyBlock() {
  const src = read('deploy.sh');
  const start = src.indexOf('tar -cf -');
  assert.ok(start > 0, 'deploy.sh 里找不到 tar 打包代码的那一段');
  // 分支边界：缩进回到 2 格及以内的 elif/else/fi（补回 .env.example 的那行在 die 之后，属于同一分支）
  const rest = src.slice(start);
  const end = rest.search(/\n {0,2}(elif|else|fi)\b/);
  assert.ok(end > 0, '找不到拷贝分支的结尾（分支结构变了，守卫的边界需要跟着改）');
  return rest.slice(0, end);
}

test('拷贝代码时排掉本机 .env（含私钥/令牌），但要把 .env.example 补回来', () => {
  const block = copyBlock();
  const patterns = [...block.matchAll(/--exclude='?([^'\s\\]+)'?/g)].map((m) => m[1]);
  assert.ok(patterns.includes('.env'), `拷贝规则里必须排掉 .env，实际：${patterns.join(' ')}`);
  assert.ok(patterns.includes('.env.*'), `.env.* 也要排掉（.env.local/.env.production 可能含密钥），实际：${patterns.join(' ')}`);
  // 关键：`.env.*` 会连 .env.example 一起排掉，而 Dockerfile 要 COPY 它 —— 必须显式补回
  assert.match(block, /cp -a "\$HERE\/\.env\.example" "\$DIR\/\.env\.example"/, '拷贝后必须把 .env.example 补回 $DIR，否则 docker build 必然失败在 COPY 那一行');
});

test('拷贝规则作用于一批文件名时的实际结果（.env 被排掉、.env.example 留下）', () => {
  const block = copyBlock();
  const patterns = [...block.matchAll(/--exclude='?([^'\s\\]+)'?/g)].map((m) => m[1]);
  const fixtures = [
    '.env',
    '.env.local',
    '.env.example',
    'Dockerfile',
    'docker-entrypoint.sh',
    'src/server.js',
    'scripts/register-node.mjs',
    'marketplace-node.db',
    'marketplace-node.db-wal',
    'node_modules/express/package.json',
    'data/x',
    'uploads/x',
    '.uploads/x',
    '.git/config',
    '.deploy-state',
  ];
  const kept = fixtures.filter((f) => !excludedBy(f, patterns));
  // 补回规则：`.env.example` 单独 cp 一份
  if (/cp -a "\$HERE\/\.env\.example"/.test(block)) kept.push('.env.example');

  for (const must of ['.env.example', 'Dockerfile', 'src/server.js', 'scripts/register-node.mjs']) {
    assert.ok(kept.includes(must), `${must} 必须留在部署目录里，实际留下的：${kept.join(' ')}`);
  }
  for (const not of ['.env', '.env.local', 'marketplace-node.db', 'node_modules/express/package.json', '.git/config', '.deploy-state']) {
    assert.ok(!kept.includes(not), `${not} 不该被搬到部署目录（本机状态/密钥/数据）：${kept.join(' ')}`);
  }
});

test('Dockerfile 里 COPY 的每个源文件，都不会被拷贝规则误杀（否则镜像构建必炸）', () => {
  const patterns = [...copyBlock().matchAll(/--exclude='?([^'\s\\]+)'?/g)].map((m) => m[1]);
  const reAdded = /cp -a "\$HERE\/\.env\.example"/.test(copyBlock()) ? ['.env.example'] : [];
  const copyLines = read('Dockerfile')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(COPY|ADD)\s/.test(l) && !l.startsWith('#'));
  assert.ok(copyLines.length >= 3, `Dockerfile 里应该有若干 COPY 行，实际解析到 ${copyLines.length} 行`);

  const problems = [];
  for (const line of copyLines) {
    const args = line.replace(/^(COPY|ADD)\s+/, '').split(/\s+/).filter((a) => !a.startsWith('--'));
    const sources = args.slice(0, -1); // 最后一个是目标
    for (const s of sources) {
      if (/[*?]/.test(s)) continue; // 通配的源不做静态判断
      const abs = path.join(NODE_ROOT, s);
      if (!fs.existsSync(abs)) problems.push(`${line} → 源 ${s} 在 node/ 里不存在`);
      else if (excludedBy(s, patterns) && !reAdded.includes(s)) problems.push(`${line} → 源 ${s} 会被 deploy.sh 的 --exclude 排掉，且没有补回`);
    }
  }
  assert.deepEqual(problems, [], `镜像构建上下文与拷贝规则不一致：\n  ${problems.join('\n  ')}`);
});

test('.dockerignore 排掉 .env 类文件，但反向放行 .env.example（否则构建上下文里没有它）', () => {
  const lines = read('.dockerignore')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert.ok(lines.includes('.env'), `.dockerignore 必须排掉 .env，实际：${lines.join(' ')}`);
  // 放行写法：`!.env.example`（最后匹配的模式生效）；没有它，COPY .env.example 同样失败
  assert.ok(lines.includes('!.env.example'), `.dockerignore 必须用 !.env.example 反向放行，实际：${lines.join(' ')}`);
  // 顺序也要对：放行必须**排在**排除之后（.dockerignore 是后面的模式覆盖前面的）
  assert.ok(lines.indexOf('!.env.example') > lines.findIndex((l) => l === '.env' || l === '.env.*'), '!.env.example 必须排在 .env / .env.* 之后');
});

/**
 * 从 .env 里回读的每一个值都必须清掉 `\r`。
 *
 * 这是**正式站上真踩到的**：服务器上那份 `.env` 是上一版 PowerShell 部署器写的（**CRLF**），
 * `cut -d= -f2-` 把行尾的 `\r` 当成了值的一部分 —— 于是"空域名"被读成 `"\r"`，CORS 白名单里
 * 多出一条 `https://` 的垃圾项（`MK_CORS_ORIGIN=https://fedmall.bityuan.com,https://`）。
 * 值的来源不可控（可能是任何工具写的、任何行尾），所以判据是结构性的：**凡是从这个文件取值的
 * 地方，要么走 `env_val`，要么自带 `tr -d '\r'`**。
 */
test('从 .env 回读值的地方都必须清掉 \\r（CRLF 的 .env 会污染取值）', () => {
  const src = read('deploy.sh');
  assert.match(src, /^env_val\(\) \{.*cut -d= -f2-.*tr -d '\\r'/m, 'deploy.sh 里应该有 env_val()：取 .env 的值时统一去掉 \\r 与首尾空白');

  const offenders = [];
  for (const [i, line] of src.split('\n').entries()) {
    if (!line.includes('cut -d= -f2-')) continue; // 只审"取值"这种写法
    if (line.trimStart().startsWith('#')) continue; // 注释里提到它不算
    if (line.includes("tr -d '\\r'")) continue; // 自带清理（env_val 的实现就是这种）
    offenders.push(`${i + 1}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [], `这些地方从 .env 取值但没清 \\r：\n  ${offenders.join('\n  ')}`);
});
