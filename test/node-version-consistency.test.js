/**
 * **Node 版本口径只有一个**：`.nvmrc` / 各 `package.json` 的 `engines` / CI 的 `setup-node`
 * 三处必须说同一件事。
 *
 * ## 为什么值得一条判据
 *
 * 这三处各写一份版本，而它们服务于三个不同的人：
 *   · `.nvmrc` —— 本机开发者敲 `nvm use`；
 *   · `engines` —— `npm install` 时的警告（以及读 README 的人）；
 *   · CI 的 `node-version` —— 唯一**真正**决定"跑在哪个版本上"的那一处。
 * 三处漂移的症状不是报错，而是**"我这儿能跑、CI 红了"**（或者反过来：CI 用着比声明更新的
 * 版本，于是用了新语法而声明里没有它）。本仓已经把这一类"同一事实抄多份"收拾过很多次
 * （店铺编号、佣金判据、配额计数器），版本口径是同一类。
 *
 * ## 判据
 *
 *   ① 三个 JS 包（`node/` / `frontend/` / `contracts` 无包）都必须有 `engines.node`；
 *   ② 它们必须**逐字相同**（同一个仓库的 JS 运行时只有一个下限）；
 *   ③ `.nvmrc` 必须存在，且**满足** `engines.node` 这个范围（拿真版本的语义去比，
 *      不是"看起来差不多"）；
 *   ④ CI 里每个 `setup-node` 的 `node-version` 也必须满足那个范围。
 *
 * 用 `semver` 比？**不引入依赖**：本仓的依赖清单是刻意的（见 node/package.json），
 * 而这里要判的范围形态只有一个（`>=X.Y`），所以自己解析那一种就够 ——
 * 解析不了的范围**直接报错**，而不是"看不懂就放过"（那是这类守卫最容易退化的方式）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** 参与统一的 JS 包（相对仓库根）。`contracts/` 是 Solidity，没有 package.json。 */
const PACKAGES = ['node/package.json', 'frontend/package.json'];

/** 解析 `>=X.Y[.Z]` 这一种范围（本仓只用这一种）；别的形态直接报错。 */
function parseLowerBound(range) {
  const m = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(range || '').trim());
  if (!m) throw new Error(`不认识的 engines.node 范围形态：${JSON.stringify(range)}（本守卫只理解 ">=X.Y[.Z]"）`);
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** `a >= b`（逐段比） */
const gte = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2]);

function enginesOf(rel) {
  const j = JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
  return j.engines?.node ?? null;
}

test('三个 JS 版本口径必须一致：engines（逐字相同）+ .nvmrc + CI 的 setup-node', () => {
  const declared = PACKAGES.map((p) => [p, enginesOf(p)]);
  for (const [p, v] of declared) {
    assert.ok(v, `${p} 缺 engines.node —— 公开仓里"这个包要哪个 Node"必须写出来（npm 只在缺失时警告，不会替你回答）`);
  }
  const distinct = [...new Set(declared.map(([, v]) => v))];
  assert.equal(
    distinct.length,
    1,
    `engines.node 不一致：${declared.map(([p, v]) => `${p}=${v}`).join(' / ')} —— 同一个仓库的 JS 运行时只有一个下限`
  );
  const bound = parseLowerBound(distinct[0]);

  // ③ .nvmrc 必须满足那个范围
  const nvmrcPath = path.join(REPO, '.nvmrc');
  assert.ok(fs.existsSync(nvmrcPath), '缺 .nvmrc（本机开发者敲 `nvm use` 时要有个准数）');
  const nvmrc = fs.readFileSync(nvmrcPath, 'utf8').trim();
  const nvmVer = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(nvmrc);
  assert.ok(nvmVer, `.nvmrc 内容不是版本号：${JSON.stringify(nvmrc)}`);
  const nvm = [Number(nvmVer[1]), Number(nvmVer[2] ?? 0), Number(nvmVer[3] ?? 0)];
  assert.ok(gte(nvm, bound), `.nvmrc=${nvmrc} 不满足 engines.node=${distinct[0]} —— 本机与声明对不上`);

  // ④ CI 里每一处 setup-node 都要满足
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const versions = [...ci.matchAll(/node-version:\s*'?([0-9.]+)'?/g)].map((m) => m[1]);
  assert.ok(versions.length > 0, 'CI 里找不到 setup-node 的 node-version（判据会变成恒真）');
  for (const v of versions) {
    const parts = v.split('.').map(Number);
    const full = [parts[0], parts[1] ?? 0, parts[2] ?? 0];
    assert.ok(
      gte(full, bound),
      `CI 用的 Node ${v} 不满足 engines.node=${distinct[0]} —— CI 跑在一个我们声明"不支持"的版本上`
    );
  }
});
