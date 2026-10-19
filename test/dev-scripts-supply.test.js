/**
 * **开发脚手架与运行时口径的两条守卫**（同一个主题：公开仓的"能不能被别人跑起来"）。
 *
 * ## ① 依赖按**包名**解析，不许把 `node_modules` 布局硬编码进源码
 *
 * `scripts/dev/*` 是演示与验收脚手架，它们要用 `ethers` / `mysql2` / `vite`，
 * 而那三个包不在 `scripts/` 下（分别是 `node/` 与 `frontend/` 的依赖）。
 * 此前 11 处写法是把路径硬编码进八个文件：
 *
 *     import { ethers } from '../../frontend/node_modules/ethers/lib.esm/index.js';
 *
 * 它**只在当前布局 + 当前包版本下成立**，而错起来很安静（前端换了依赖或 `exports` 变了
 * ⇒ 八个脚本一起 `ERR_MODULE_NOT_FOUND`，看不出是"脚手架依赖了别人家的内部布局"）。
 * 唯一的合法解析点是 `scripts/dev/deps.mjs`（按包名、固定顺序 `node/` → `frontend/`）。
 *
 * ## ② Node 版本口径只有一个
 *
 * `.nvmrc` / 各 `package.json` 的 `engines` / CI 的 `setup-node` 三处服务于三个不同的人
 * （本机开发者、读声明的人、真正决定版本的那一处），漂移的症状不是报错而是
 * **"我这儿能跑、CI 红了"**。详见 `node-version-consistency.test.js`（那边判等，这里判"有没有写"）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/**
 * 这两条判据要**完整仓**（`scripts/` 与 `frontend/` 都与 `node/` 同级）。
 *
 * `node/` 是唯一真源，会被 `scripts/sync-node-repo.mjs` 发布到公开的节点公开节点仓
 * （镜像里只有 `node/**` + `provision/**`）。在那里跑 `npm test` 时 `scripts/` 不存在，
 * 而"这棵树里没有可比对的对象"与"判据不成立"是两件事 —— 所以**跳过而不是失败**
 * （与 `abi-consistency.test.js` 的 `FULL_TREE` 同款）。
 *
 * 判据是**模块加载期唯一的一处**，且必须覆盖下面真正会被 `walk()` 走到的两棵树：
 * 只判其中一棵，另一棵缺失时 `readdirSync` 会在用例里抛 ENOENT —— 那正是"跳过"退化成
 * "失败"的形状，而不是少跑一条断言。判据用目录而不是具体文件名：目录在、文件却改名了，
 * 那是真要修这条守卫（`readFileSync` 会当场报错），不该被当成"这棵树里没有"。
 */
const FULL_TREE = fs.existsSync(path.join(REPO, 'scripts', 'dev')) && fs.existsSync(path.join(REPO, 'frontend', 'src'));
const guard = FULL_TREE ? test : test.skip;

/** 递归列出源文件（跳过 node_modules / 构建产物 / 隐藏目录） */
function walk(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

/**
 * 判据：源码里**不许出现 `node_modules` 路径**。
 *
 * 例外两类，都是"这句话在解释规则本身、而不是在用它"：
 *   · `scripts/dev/deps.mjs` —— 唯一合法的解析点（它必须拼这个路径名）；
 *   · 注释行（`//`、`*`、`/*`）—— 引用旧写法作为历史对照。
 * 判据按**行**看，所以注释里提一句不会放过真正的 import。
 */
guard('开发脚本里不许硬编码 node_modules 路径（依赖一律经 deps.mjs 按包名解析）', () => {
  const files = [...walk(path.join(REPO, 'scripts'), ['.mjs', '.js']), ...walk(path.join(REPO, 'frontend'), ['.mjs'])];
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(REPO, f).replace(/\\/g, '/');
    if (rel === 'scripts/dev/deps.mjs') continue; // 唯一解析点
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('node_modules/')) return;
      const t = line.trim();
      // 注释行（含块注释续行的 `*`）不算：它们解释的是"以前那样写为什么错"
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      offenders.push(`${rel}:${i + 1}  ${t.slice(0, 110)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    '这些地方把 node_modules 布局硬编码进了源码——改用 `scripts/dev/deps.mjs` 的 loadEthers/loadMysql/loadVite：\n  ' +
      offenders.join('\n  ')
  );
});

guard('deps.mjs 的解析顺序固定为 node/ → frontend/，且解析结果真的能加载', async () => {
  const { readFileSync } = fs;
  const src = readFileSync(path.join(REPO, 'scripts', 'dev', 'deps.mjs'), 'utf8');
  /*
    顺序是判据的一部分：`node/` 是这些脚本的真源（dev-stack 起的就是 node/src/server.js，
    node/package.json 里 ethers 是正式依赖）。反过来时，两棵树装了不同版本就会
    "谁先被探测到就用谁" —— `role-handover.mjs` 此前正是那个反的顺序。
  */
  const nodeIdx = src.indexOf("name: 'node'");
  const feIdx = src.indexOf("name: 'frontend'");
  assert.ok(nodeIdx > 0 && feIdx > nodeIdx, 'HOSTS 的顺序必须是 node/ 在 frontend/ 之前');

  // 真加载一次（这条同时证明"解析器写的路径在真机上存在"——否则改坏了也只有跑 demo 才发现）
  const { loadEthers, loadMysql, loadVite } = await import('../../scripts/dev/deps.mjs');
  const { ethers } = await loadEthers();
  assert.equal(typeof ethers.Wallet, 'function', 'ethers 必须真的可用');
  assert.equal(typeof (await loadMysql()).default.createConnection, 'function', 'mysql2/promise 必须真的可用');
  assert.equal(typeof (await loadVite()).createServer, 'function', 'vite 必须真的可用（且拿到的是 ESM 入口）');
});
