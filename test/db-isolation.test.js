/**
 * 测试进程的**库隔离**是本套件能不能跑的前提，所以它有可执行的判据，而不是注释里的约定。
 *
 * 背景（见 test/setup.mjs 文件头）：`node --test test/*.test.js` 每个文件一个进程、并行执行，
 * 而 MySQL 是**共享服务器**——库名只能靠 `MK_DB_NAME` 按 pid 分开，且必须在任何业务模块求值
 * **之前**设好。设晚了的后果不是"某个用例失败"：某个模块若在求值时就用上了库名（最坏情况是
 * 打到默认的 `marketplace_node`），污染的是真库，而这批测试本身还是绿的。
 *
 * 钉住两件事：
 *  1. 任何 import `../src/…` 的测试文件，必须把 `./setup.mjs` 写在**它前面**
 *     （ESM 按书写顺序求值依赖，所以这条静态顺序就是运行时的求值顺序）；
 *  2. setup.mjs 之前求值的那些模块，**传递可达**不到 `src/db.js`——否则"库名已经设好"这件事
 *     在这些测试文件里根本不成立。
 *
 * 反过来不要求：只测纯函数（money/ids/monotonicClock…）的文件不必为它建一个库，
 * 它们只要不碰 db 层即可（第 2 条管的就是这个）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const NODE_DIR = path.resolve(TEST_DIR, '..');
const SRC_DIR = path.join(NODE_DIR, 'src');

/** 静态 import/export-from 的 specifier，按**书写顺序**返回（含出现位置） */
function staticImports(source) {
  const out = [];
  const re = /^\s*(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(source))) out.push({ spec: m[1], index: m.index });
  return out;
}

/** src 内相对模块解析（本仓 src 只有相对导入；解析不到的返回 null） */
function resolveInSrc(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const p = path.resolve(path.dirname(fromFile), spec);
  return fs.existsSync(p) ? p : null;
}

/** 从一组入口文件出发，能否（传递地）走到 src/db.js */
function reachesDbLayer(entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    if (file === path.join(SRC_DIR, 'db.js')) return true;
    const source = fs.readFileSync(file, 'utf8');
    for (const { spec } of staticImports(source)) {
      const next = resolveInSrc(file, spec);
      if (next) stack.push(next);
    }
  }
  return false;
}

const testFiles = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js')).sort();

test('库名先于任何业务模块生效：import ../src 的测试文件必须把 ./setup.mjs 写在它前面', () => {
  const violations = [];
  for (const file of testFiles) {
    const source = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    const imports = staticImports(source);
    const setup = imports.find((i) => i.spec === './setup.mjs');
    if (!setup) continue;
    for (const i of imports) {
      if (i.spec.startsWith('../src/') && i.index < setup.index) {
        violations.push(`${file}: ${i.spec} 在 ./setup.mjs 之前求值`);
      }
    }
  }
  assert.deepEqual(violations, [], `这些文件会在库名设好之前求值业务模块：\n${violations.join('\n')}`);
});

test('没有 setup.mjs 的测试文件碰不到 db 层（它们连的库名不是本进程那一个）', () => {
  const violations = [];
  for (const file of testFiles) {
    const full = path.join(TEST_DIR, file);
    const imports = staticImports(fs.readFileSync(full, 'utf8'));
    const setup = imports.find((i) => i.spec === './setup.mjs');
    const before = imports.filter((i) => (setup ? i.index < setup.index : true));
    // 只看得见的副作用入口：src 模块（本仓测试没有别的本地模块）
    const entries = before
      .map((i) => (i.spec.startsWith('../src/') ? resolveInSrc(full, i.spec) : null))
      .filter(Boolean);
    if (entries.length && reachesDbLayer(entries)) violations.push(file);
  }
  assert.deepEqual(violations, [], `这些文件在库名设好之前就能走到 src/db.js：\n${violations.join('\n')}`);
});
