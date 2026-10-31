#!/usr/bin/env node
/**
 * 从 `contracts/out` 生成节点公开的编译产物清单（`node/contract-artifacts.json`）。
 *
 * 为什么需要它：目录白名单现在按**完整 runtime 哈希**（含 metadata）审批；平台/第三方
 * 必须拿到"这次实际部署的完整字节码"才能复核。节点在 `/api/contracts` 公开同一份清单，
 * 前端展示哈希并提供 JSON/bytecode 下载。`--check` 用于 CI/发布前确认仓库里的清单与
 * 当前 contracts 构建一致（不能拿旧清单去审批新代码）。
 *
 * 用法：cd contracts && forge build && node ../node/scripts/build-contract-artifacts.mjs [--check]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'contracts', 'out');
/**
 * 开发仓布局：`<root>/node/scripts` + `<root>/node/contract-artifacts.json`；
 * 公开节点仓布局：`<root>/scripts` + `<root>/contract-artifacts.json`（node/ 摊到仓库根）。
 */
const TARGET = existsSync(path.join(ROOT, 'node', 'package.json'))
  ? path.join(ROOT, 'node', 'contract-artifacts.json')
  : path.join(ROOT, 'contract-artifacts.json');
const NAMES = ['MarketplaceRegistry', 'Escrow', 'Staking', 'NodeGovernance', 'TokenPayoutVault'];

function artifactOf(name) {
  // forge 的路径是 out/<file>.sol/<contract>.json；同名合约只取第一个
  for (const dir of [name, `${name}.sol`]) {
    const file = path.join(OUT, dir, `${name}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  }
  throw new Error(`缺少编译产物：${name}（先 cd contracts && forge build）`);
}

function hexOf(v, name) {
  const s = String(v || '').trim();
  if (!/^0x[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) throw new Error(`非法字节码：${name}`);
  return s.toLowerCase();
}

const contracts = NAMES.map((name) => {
  const a = artifactOf(name);
  const creation = hexOf(a.bytecode?.object, name);
  const runtime = hexOf(a.deployedBytecode?.object, name);
  if (!creation || !runtime) throw new Error(`${name} 的 bytecode/deployedBytecode 为空（--via-ir 或抽象合约？）`);
  return {
    name,
    abi: a.abi,
    creationCodeHash: ethers.keccak256(creation),
    runtimeCodeHash: ethers.keccak256(runtime),
    bytecode: creation,
    deployedBytecode: runtime,
  };
});

const manifest = {
  schema: 1,
  note: '完整 runtime 字节码的 keccak256（含 solc metadata）；目录白名单以这份值为准。',
  contracts,
};
const text = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const old = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
  if (old !== text) {
    console.error('contract-artifacts.json 与当前 contracts 构建不一致：请重新生成并同批提交。');
    process.exit(1);
  }
  console.log('contract-artifacts.json 与当前构建一致');
} else {
  writeFileSync(TARGET, text);
  console.log(`已写入 ${path.relative(ROOT, TARGET)}（${contracts.length} 个合约）`);
}
