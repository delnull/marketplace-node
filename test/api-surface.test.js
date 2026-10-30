/**
 * **接口面判据**：后端已挂载的每个端点、`api/node.ts` 的每个导出函数，都必须有前端出口，
 * 否则必须写进本文件的 allowlist 并给出理由。
 *
 * 为什么需要它：2026-10 的"孤儿媒体清扫"是一整个后端功能（路由 + 清理器 + 审计），
 * 落地时**没有任何前端改动**——页面照常能开、测试照常全绿，只有"节点主在界面上没有这个按钮"
 * 这件事没有任何东西会说。同类漏法（后端功能落地不配界面）只能靠一条会红的判据挡住。
 *
 * 判据的两侧从哪里来：
 *  - 后端：**运行时枚举** `createApp()` 的 router stack。不静态解析 `app.js` 的挂载表——
 *    那会变成第二份真相（新挂一个 router、或换了挂载前缀，静态表就漏）。
 *  - 前端：扫 `frontend/src/api/*.ts` 里的 `/api/...` 字面量（模板里的 `${...}` 归一成 `:p`）。
 *    只扫 API 客户端层：页面不该自己拼路径；"API 函数有没有页面消费者"由第三条测试守。
 *
 * 不判什么：**方法**（GET/POST…）。两侧都要解析调用表达式才能对上方法，误红比漏这一档更贵；
 * 方法错位由接口单测（supertest）与真实闭环覆盖。本测试只回答问题"有没有出口"。
 *
 * 代价如实写：allowlist 要维护，且扫描只能证明"被引用"，不能证明"入口可达"（仍可能被死分支
 * 引用）。它抬高下限，不是证明。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// 只为副作用：本进程的库名必须先于任何 src 模块生效（本文件会 import app.js → db.js）。
// 判据见 test/db-isolation.test.js；不建库、不用 ctx。
import './setup.mjs';
import { createApp } from '../src/app.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FRONTEND_SRC = path.join(ROOT, 'frontend', 'src');
const API_DIR = path.join(FRONTEND_SRC, 'api');

/** 模板表达式占位符（扫描时把 `${...}` 换成它，归一化时再决定是参数还是查询串） */
const PH = '\u0000';

/**
 * 没有前端出口的端点。**每条都必须写清为什么不需要**，且一旦有了出口就要删掉这条
 * （下面的"allowlist 过期"断言会红——它就是这份清单的回收机制）。
 */
const ALLOWED_ENDPOINTS = {
  '/healthz': '探活端点：Docker HEALTHCHECK 与部署脚本消费；页面不读探活响应',
  '/api/uploads/:p': '媒体读取由节点下发的 URL 直接渲染（<img src>），前端不拼这个路径',
  '/api/shop/staking/refresh': 'nodeAdmin 强制刷新，供 scripts/dev/seed-demo.mjs 用；公开页面按 30s 记忆化，不提供绕过',
};

/**
 * 没有页面消费者的 API 客户端导出函数。每条同样要写理由。
 */
const ALLOWED_FUNCTIONS = {
  fetchExportCsv: '内部传输助手：被同文件的 exportLedgerCsv / exportOrdersCsv 等使用',
};

// ── 一个够用的词法扫描：跳过注释，取出字符串/模板字面量 ────────────────
function skipTemplateExpr(src, i) {
  // src[i] === '$' && src[i + 1] === '{'
  let depth = 1;
  let j = i + 2;
  while (j < src.length && depth > 0) {
    const c = src[j];
    if (c === "'" || c === '"') {
      j = readQuoted(src, j, c).end;
      continue;
    }
    if (c === '`') {
      j = readTemplate(src, j).end;
      continue;
    }
    if (c === '/' && src[j + 1] === '/') {
      while (j < src.length && src[j] !== '\n') j++;
      continue;
    }
    if (c === '/' && src[j + 1] === '*') {
      j += 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j += 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    j++;
  }
  return j;
}

function readQuoted(src, i, quote) {
  let j = i + 1;
  let value = '';
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      value += src[j + 1] || '';
      j += 2;
      continue;
    }
    if (c === quote) return { value, end: j + 1 };
    value += c;
    j++;
  }
  return { value, end: j };
}

function readTemplate(src, i) {
  let j = i + 1;
  let value = '';
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      value += src[j + 1] || '';
      j += 2;
      continue;
    }
    if (c === '`') return { value, end: j + 1 };
    if (c === '$' && src[j + 1] === '{') {
      value += PH;
      j = skipTemplateExpr(src, j);
      continue;
    }
    value += c;
    j++;
  }
  return { value, end: j };
}

function scanLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const r = readQuoted(src, i, c);
      out.push(r.value);
      i = r.end;
      continue;
    }
    if (c === '`') {
      const r = readTemplate(src, i);
      out.push(r.value);
      i = r.end;
      continue;
    }
    i++;
  }
  return out;
}

/** 前端路径归一：`${...}` → `:p`；末尾的 `${...}`（查询串拼接）整个丢掉；去掉查询与尾斜杠 */
function normalizeFrontPath(value) {
  if (!value.startsWith('/api/')) return null;
  let s = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === PH) {
      const prev = s.slice(-1);
      // 末尾表达式且前面不是 `/`：`${qs}` / `${refresh ? '?refresh=1' : ''}` 这类查询串拼接
      if (i === value.length - 1 && prev !== '/' && prev !== '') continue;
      s += ':p';
      continue;
    }
    s += value[i];
  }
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/\/+$/, '') || '/';
  return s;
}

/** Express 4：从路由器 layer 的正则里还原挂载前缀（`/^\/api\/auth\/?(?=\/|$)/i` → `/api/auth`） */
function mountPathOf(layer) {
  const src = layer.regexp?.source || '';
  const m = /^\^\\\/(.*?)\\\/\?/.exec(src);
  if (!m) return '';
  return '/' + m[1].split('\\/').join('/');
}

/** 后端：**已挂载**的端点路径（方法不进判据，见文件头）；枚举一次即可（createApp 会打日志） */
let BACKEND_CACHE = null;
function backendPaths() {
  if (BACKEND_CACHE) return BACKEND_CACHE;
  const app = createApp();
  const stack = app._router?.stack;
  assert.ok(Array.isArray(stack), 'app._router.stack 不存在：Express 内部结构变了，本测试的枚举方式要更新');
  const out = new Set();
  const walk = (layers, prefix) => {
    for (const layer of layers) {
      if (layer.route) {
        const p = (prefix + layer.route.path).replace(/\/+$/, '') || '/';
        out.add(p.replace(/:[A-Za-z0-9_]+/g, ':p'));
        continue;
      }
      if (layer.name === 'router' && layer.handle?.stack) {
        const mount = mountPathOf(layer);
        assert.ok(mount, '无法还原路由器的挂载前缀：Express 内部结构变了，本测试的枚举方式要更新');
        walk(layer.handle.stack, (prefix + mount).replace(/\/+$/, ''));
      }
    }
  };
  walk(stack, '');
  BACKEND_CACHE = out;
  return out;
}

function frontendPaths() {
  const out = new Set();
  for (const name of fs.readdirSync(API_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(API_DIR, name), 'utf8');
    for (const literal of scanLiterals(src)) {
      const p = normalizeFrontPath(literal);
      if (p) out.add(p);
    }
  }
  return out;
}

function frontendSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) frontendSources(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('后端每个端点都有前端出口（没有出口的必须写进 allowlist 并说明理由）', () => {
  const backend = backendPaths();
  // 枚举器自身失效时（结构变了、挂载前缀解析不到）宁可红，也不要"零个端点、零个缺口"
  assert.ok(backend.size >= 100, `只枚举到 ${backend.size} 个端点：枚举器坏了（见 mountPathOf）`);
  const frontend = frontendPaths();
  const missing = [...backend].filter((p) => !frontend.has(p)).sort();
  const allowed = Object.keys(ALLOWED_ENDPOINTS).sort();
  assert.deepEqual(
    missing,
    allowed,
    [
      '以下端点在后端存在、前端却没有调用（若确实不需要界面，加进 ALLOWED_ENDPOINTS 并写明理由）：',
      ...missing.filter((p) => !(p in ALLOWED_ENDPOINTS)).map((p) => `  缺出口：${p}`),
      ...allowed.filter((p) => !missing.includes(p)).map((p) => `  allowlist 已过期（现在有出口了）：${p}`),
    ].join('\n')
  );
  for (const [p, why] of Object.entries(ALLOWED_ENDPOINTS)) {
    assert.ok(why.trim().length >= 8, `allowlist 条目 ${p} 没写理由——这条清单的意义就是"为什么不给界面"`);
  }
});

test('反向：前端调用的每个路径都在后端存在（没有拼错的端点）', () => {
  const backend = backendPaths();
  const extras = [...frontendPaths()].filter((p) => !backend.has(p)).sort();
  assert.deepEqual(extras, [], `前端调用了不存在的后端路径（拼错/删了路由没删调用）：\n  ${extras.join('\n  ')}`);
});

test('api/node.ts 的每个导出函数都有页面消费者（或写进 allowlist 并说明理由）', () => {
  const apiFile = path.join(API_DIR, 'node.ts');
  const apiSrc = fs.readFileSync(apiFile, 'utf8');
  const names = [...apiSrc.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
  assert.ok(names.length >= 100, `只解析到 ${names.length} 个导出函数：解析器失效了`);

  const others = frontendSources(FRONTEND_SRC)
    .filter((f) => f !== apiFile)
    .map((f) => fs.readFileSync(f, 'utf8'));
  const unused = names.filter((n) => !others.some((src) => new RegExp(`\\b${n}\\b`).test(src))).sort();
  const allowed = Object.keys(ALLOWED_FUNCTIONS).sort();
  assert.deepEqual(
    unused,
    allowed,
    [
      '以下 API 函数没有任何页面/其它模块调用（若确实只是内部助手，加进 ALLOWED_FUNCTIONS 并写明理由）：',
      ...unused.filter((n) => !(n in ALLOWED_FUNCTIONS)).map((n) => `  无消费者：${n}`),
      ...allowed.filter((n) => !unused.includes(n)).map((n) => `  allowlist 已过期（现在有消费者了）：${n}`),
    ].join('\n')
  );
});
