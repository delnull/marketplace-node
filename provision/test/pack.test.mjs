/**
 * 发布包（`packNode`）的形状 —— **两种仓库布局都要产出同一个形状**。
 *
 * 为什么这条值得单独一个测试文件：包形状错了**不会在本地报任何错**，
 * 它坏在服务器上（`deploy.sh` 按 `$DIR/node` 找代码，找不到就报一个与真因无关的
 * "文件找不到"），而且错的时候是"部署到一半"。
 *
 * 历史上这里错过两次，两次都是"我以为 git 会这样"：
 *   1. 以为 `git archive <rev>:node` 自带 `node/` 前缀 —— 实测**不自带**，子树内容落在包根上；
 *   2. 以为公开仓（仓库根就是节点）没法复用同一段打包逻辑 —— 其实 `--prefix=node/` 一视同仁。
 * 所以判据钉在**包里的条目名**上，而不是"我们传了哪个参数"：参数改了但形状不变，测试仍该绿。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { packNode } from '../lib/up.mjs';

/** 列出一个 tgz 里的条目（用 tar 而不是手写 gzip 解析：这是测试，可读性优先） */
function entries(tarball) {
  const r = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  assert.equal(r.status, 0, `tar 读不了 ${tarball}：${r.stderr}`);
  // Windows 的 tar 输出 CRLF：不剥掉 `\r` 会得到 `'node/deploy.sh\r'`，于是"包里明明有"却断言失败
  return r.stdout
    .split('\n')
    .map((e) => e.replace(/\r$/, ''))
    .filter(Boolean);
}

/** 造一个临时仓：mode='subtree' 时 node/ 是子目录（开发仓）；mode='root' 时仓库根就是节点（公开仓） */
function makeRepo(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mk-pack-${mode}-`));
  const nodeDir = mode === 'subtree' ? path.join(root, 'node') : root;
  fs.mkdirSync(path.join(nodeDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(nodeDir, 'package.json'), '{"name":"marketplace-node"}');
  fs.writeFileSync(path.join(nodeDir, 'src', 'server.js'), '// x\n');
  fs.writeFileSync(path.join(nodeDir, 'deploy.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(nodeDir, '.env.example'), 'PORT=8090\n');
  if (mode === 'subtree') fs.writeFileSync(path.join(root, 'README.md'), '# 开发仓\n');
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'i');
  return root;
}

/**
 * 服务器侧的起点：`deployNodeScript` 把包解到 `$DIR`，然后跑 `$DIR/node/deploy.sh`。
 * 这个测试不复制那行脚本，只检查它依赖的**那一个事实**：`node/deploy.sh` 在包里。
 */
const NEEDED_IN_PACK = ['node/deploy.sh', 'node/package.json', 'node/src/server.js'];
/** 构建镜像要用的东西必须在包里（少一个 docker build 就失败在 COPY 那一行） */
const NEEDED_FOR_DOCKER = ['node/Dockerfile', 'node/docker-entrypoint.sh', 'node/.env.example'];

const repos = [];

before(() => {
  repos.push(makeRepo('subtree'), makeRepo('root'));
});
after(() => {
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
});

test('开发仓（node/ 是子目录）：包里有 node/ 前缀', () => {
  const root = repos[0];
  const tarball = packNode(root, 'HEAD', () => {});
  const list = entries(tarball);
  for (const want of NEEDED_IN_PACK) {
    assert.ok(list.includes(want), `包里缺少 ${want}；实际顶层：${[...new Set(list.map((e) => e.split('/')[0]))].join(' ')}`);
  }
  // 反向判据：包根上**不许**直接出现 deploy.sh（那正是"前缀丢了"的症状）
  assert.equal(list.includes('deploy.sh'), false, 'deploy.sh 出现在包根上 ⇒ node/ 前缀丢了，服务器上 $DIR/node/deploy.sh 会不存在');
  fs.rmSync(tarball, { force: true });
});

test('公开仓（仓库根就是节点）：同一个形状，下游一行都不用改', () => {
  const root = repos[1];
  const tarball = packNode(root, 'HEAD', () => {});
  const list = entries(tarball);
  for (const want of NEEDED_IN_PACK) {
    assert.ok(list.includes(want), `包里缺少 ${want}（公开仓布局最容易在这里漏前缀）`);
  }
  assert.equal(list.includes('deploy.sh'), false, '包根上不该有 deploy.sh');
  fs.rmSync(tarball, { force: true });
});

test('两种布局产出的条目集合一致（形状只有一种）', () => {
  const a = entries(packNode(repos[0], 'HEAD', () => {}));
  const b = entries(packNode(repos[1], 'HEAD', () => {}));
  assert.deepEqual(a.filter((x) => x.startsWith('node/')).sort(), b.filter((x) => x.startsWith('node/')).sort());
});

test('真实仓库（本仓）打出来的包：node/deploy.sh 在预期位置，且 Docker 要的文件齐全', () => {
  // 注意用 dirname（`import.meta.url` 是 `file://…` 字符串，拿去拼路径会得到一个不存在的目录）
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const git = (...a) => spawnSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8' });
  if (git('rev-parse', '--git-dir').status !== 0) return; // 不是 git 工作区（例如离线拷包）时跳过
  const tarball = packNode(repoRoot, 'HEAD', () => {});
  const list = entries(tarball);
  for (const want of [...NEEDED_IN_PACK, ...NEEDED_FOR_DOCKER]) {
    assert.ok(list.includes(want), `包里缺少 ${want}`);
  }
  fs.rmSync(tarball, { force: true });
});
