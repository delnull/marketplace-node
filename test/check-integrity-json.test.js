/**
 * `check-integrity --json` 的机器可读契约。
 *
 * 要防的是什么：体检项还在增长（2026-10-17 新增四个计数器的对拍），文本摘要会跟着改；
 * 如果 `--json` 是手写字段清单，CI/告警看到的就是**旧形状**——`counts.reservedCodesDrift`
 * 根本不存在，下游读到 undefined 当成 0，正好是"静默通过"（与这次要修的那类 fail-open 同形）。
 *
 * 判据是**对拍**而不是"字段名在不在"：同一份库上分别跑 `findIntegrityIssues()` 与 CLI，
 * `--json` 的 counts / checked 必须与函数返回**逐个键相等**。函数新增一项而 CLI 没带，这条就红。
 * 既有字段（db / auditChain / issues）同批钉住——这次改动不许把它们挤掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCtx, insertProduct } from './setup.mjs';

/** `node/`：CLI 的相对路径与 spawn 的工作目录都从这里算 */
const NODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ctx = await makeCtx();
const { db } = ctx;
const { findIntegrityIssues } = await import('../src/integrity.js');

test('--json 带全 counts/checked（与 findIntegrityIssues 逐键对拍），既有字段不变', async () => {
  // 造一个生产路径造不出的漂移：计数器偏大 ⇒ counts.reservedCodesDrift=1、checked.productCounters>0
  const p = await insertProduct(db, { kind: 'digital', title: 'JSON 契约' });
  await db.run('UPDATE products SET reserved_codes = 3 WHERE id = ?', p.productId);

  // 先拿函数的返回值当**唯一真相**（顺序不能反：两份读数要落在同一份数据上）
  const api = await findIntegrityIssues(db);

  const r = spawnSync(process.execPath, ['scripts/check-integrity.js', '--json'], {
    cwd: NODE_DIR,
    env: process.env, // 同一个测试库：MK_DB_NAME 由 setup.mjs 领给本进程，子进程继承
    encoding: 'utf8',
  });
  assert.equal(r.status, 2, `发现不一致时退出码必须是 2（stderr=${r.stderr}）`);
  assert.match(r.stdout, /^\s*\{/, `--json 的 stdout 必须只有 JSON（实际开头：${r.stdout.slice(0, 80)}）`);
  const json = JSON.parse(r.stdout);

  // 既有字段：形状不许被这次改动挤掉
  assert.equal(typeof json.db, 'string');
  assert.ok(json.db.includes('@'), `db 要能指出查的是哪个库，实际：${json.db}`);
  assert.ok(Array.isArray(json.issues), 'issues 在 --json 里仍是数组');
  for (const k of ['ok', 'entries', 'hashed', 'unhashed', 'unhashedCount', 'broken', 'head']) {
    assert.ok(k in json.auditChain, `auditChain.${k} 是既有字段，不许丢`);
  }

  // 新增计数器的 counts/checked：键集与值都必须与函数返回一致
  const missingCounts = Object.keys(api.counts).filter((k) => !(k in json.counts));
  const missingChecked = Object.keys(api.checked).filter((k) => !(k in json.checked));
  assert.deepEqual(missingCounts, [], `--json 的 counts 缺了 integrity.js 新增的键：${missingCounts.join(' ')}`);
  assert.deepEqual(missingChecked, [], `--json 的 checked 缺了 integrity.js 新增的键：${missingChecked.join(' ')}`);
  assert.deepEqual(json.counts, api.counts, 'counts 的值必须与函数返回一致（不只是键在）');
  assert.deepEqual(json.checked, api.checked, 'checked 的值必须与函数返回一致（不只是键在）');

  // 新计数器必须真的以"有值"的形态出现在 JSON 里，而不是一排 0（那也可能是没接线）
  assert.equal(json.counts.reservedCodesDrift, 1, '新计数器 counts.reservedCodesDrift 必须是真实读数');
  assert.ok(json.checked.productCounters >= 1, '新增的 checked.productCounters 必须是真实读数');

  // issues 仍是同一条结论（文本摘要与 --json 不许各说一套）
  assert.equal(json.issues.length, api.issues.length);
  assert.deepEqual(
    json.issues.map((i) => i.kind).sort(),
    api.issues.map((i) => i.kind).sort(),
    'issues 的 kind 集合必须与函数返回一致'
  );
});
