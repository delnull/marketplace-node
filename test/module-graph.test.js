/**
 * **模块图链接检查**：每个 `import { 具名 }` 都必须真的存在于目标模块的导出里。
 *
 * ## 为什么需要一条静态检查
 *
 * 2026-10-15 的实测事故：`src/server.js` 写着 `import { shopNameOf } from './shops.js'`，
 * 而 `shopNameOf` 的实现住在 `routes/shop.js`（它要读 kv 覆盖，见那里的说明）。
 * ESM 对**不存在的具名导出**是**加载期直接抛错**——节点不是"某个接口坏掉"，是**整台起不来**：
 *
 *     SyntaxError: The requested module './shops.js' does not provide an export named 'shopNameOf'
 *
 * 而当时：`node --check` 对每个文件都通过（它不链接），747 条接口测试全绿
 * （它们 import 的是 `app.js`，**不经过** `server.js`），`dev-verify` 也没机会跑——
 * 直到 `dev-stack --rebuild` 起节点时才发现。故障面与检测面完全错开：改的是入口文件，
 * 测的是入口以下的每一层。
 *
 * ## 它检查什么、不检查什么
 *
 * 检查：`src/**` 与 `scripts/**` 里每个 `.js` 的相对 import，其**具名导入**必须由目标模块
 * 导出（`export function/class/const/let/var`、`export { a, b as c }` 的**本地名与别名都算**、
 * `export * from` 一律放行——重新导出算"可能有"）。副作用 import、命名空间 import、
 * 默认 import、裸模块（node_modules）不检查。
 *
 * 不检查：**值**层面的形状（类型/参数），那是测试与运行期的事。这条只回答一个二值问题：
 * "这个符号在这个模块里存不存在"——存在性是**静态可判定**的，所以它该在静态层被判定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 递归列出目录下的 `.js`（跳过 node_modules / 数据库 / 上传物） */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name.startsWith('.')) continue;
    const p = path.join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(p));
    else if (name.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 模块导出的**名字集合**（本地名与 `as` 别名都算；`export *` 置 `star`） */
function exportsOf(src) {
  const names = new Set();
  let star = false;
  const addAs = (clause) => {
    for (const part of clause.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const m = t.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (m) {
        names.add(m[1]); // 本地名（`import { a as b }` 时目标模块导出的是 a）
        if (m[2]) names.add(m[2]);
      }
    }
  };
  const decl = /export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of src.matchAll(decl)) names.add(m[1]);
  const braces = /\bexport\s*\{([^}]*)\}/g;
  for (const m of src.matchAll(braces)) addAs(m[1]);
  if (/\bexport\s*\*/.test(src)) star = true;
  return { names, star };
}

/** 解析一条 import 语句的具名子句（`{ a, b as c }`） */
function namedClause(spec) {
  const m = spec.match(/\{([^}]*)\}/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const t = s.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/);
      return t ? t[1] : null;
    })
    .filter(Boolean);
}

const IMPORT_RE = /^[ \t]*import\s+([^'";]*?)from\s*['"]([^'"]+)['"]/gm;

test('模块图链接：每个具名 import 都必须存在于目标模块的导出里', () => {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))];
  assert.ok(files.length > 50, `扫描到的模块数异常偏少（${files.length}）——检查本用例的 walk 是否还在工作`);
  const problems = [];
  let checkedImports = 0;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      const target = m[2];
      if (!target.startsWith('.')) continue; // 裸模块（node_modules / node: 内置）
      const names = namedClause(spec);
      if (!names.length) continue; // 副作用 / 命名空间 / 默认 import
      const resolved = path.resolve(path.dirname(file), target);
      if (!existsSync(resolved)) {
        problems.push(`${path.relative(ROOT, file)} → ${target}：模块文件不存在`);
        continue;
      }
      const { names: ex, star } = exportsOf(readFileSync(resolved, 'utf8'));
      if (star) continue; // 有 `export *` ⇒ 静态判定不了，放行
      for (const n of names) {
        checkedImports += 1;
        if (!ex.has(n)) {
          problems.push(`${path.relative(ROOT, file)} → ${target}：目标模块没有导出 \`${n}\`（ESM 会在**加载期**抛错 ⇒ 整个进程起不来）`);
        }
      }
    }
  }
  assert.ok(checkedImports > 200, `实际核对的具名导入不足（${checkedImports}）——正则可能已与写法脱节`);
  assert.deepEqual(problems, [], `发现 ${problems.length} 处无效具名导入：\n${problems.join('\n')}`);
});

test('模块图链接：`src/server.js`（真正的进程入口）必须能被链接', () => {
  /*
    上一条是"逐条查"，这一条是"整图查"，两者都要：逐条查给出**是哪一行**，
    整图查保证"从入口出发的每一条边"都被覆盖（含只在入口链上出现的文件）。
    `node --check` 做不到这件事（它只做语法检查、不解析导入），这就是那次事故溜过去的原因。
  */
  const entry = path.join(ROOT, 'src', 'server.js');
  const seen = new Set();
  const stack = [entry];
  const problems = [];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const target = m[2];
      if (!target.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (!existsSync(resolved)) {
        problems.push(`${path.relative(ROOT, file)} → ${target}：模块文件不存在`);
        continue;
      }
      const { names: ex, star } = exportsOf(readFileSync(resolved, 'utf8'));
      if (!star) {
        for (const n of namedClause(m[1])) {
          if (!ex.has(n)) problems.push(`${path.relative(ROOT, file)} → ${target}：没有导出 \`${n}\``);
        }
      }
      stack.push(resolved);
    }
  }
  assert.ok(seen.size > 20, `入口可达模块数异常偏少（${seen.size}）`);
  assert.deepEqual(problems, [], `进程入口不可链接：\n${problems.join('\n')}`);
});
