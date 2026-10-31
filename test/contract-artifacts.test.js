/**
 * 公开节点仓的编译产物清单（`node/contract-artifacts.json`）必须自洽：
 * creation/deployed bytecode 的 keccak256 与清单里的哈希逐项相等，且没有未链接库占位。
 *
 * 部署脚本直接使用这份字节码；清单损坏/被替换时必须在**部署前**拒绝，而不是部署完
 * 才发现 Registry 白名单对不上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';

const FILE = new URL('../contract-artifacts.json', import.meta.url);
const manifest = JSON.parse(readFileSync(FILE, 'utf8'));

test('编译产物清单：核心合约齐全，creation/runtime 哈希与字节码一致', () => {
  assert.equal(manifest.schema, 1);
  const names = manifest.contracts.map((c) => c.name).sort();
  assert.deepEqual(names, ['Escrow', 'MarketplaceRegistry', 'NodeGovernance', 'Staking', 'TokenPayoutVault']);
  for (const c of manifest.contracts) {
    assert.match(c.bytecode, /^0x[0-9a-f]+$/, `${c.name} creation bytecode 非法`);
    assert.match(c.deployedBytecode, /^0x[0-9a-f]+$/, `${c.name} runtime bytecode 非法`);
    assert.ok(!c.bytecode.includes('__'), `${c.name} creation bytecode 含未链接库占位`);
    assert.equal(ethers.keccak256(c.bytecode), c.creationCodeHash, `${c.name} creationCodeHash`);
    assert.equal(ethers.keccak256(c.deployedBytecode), c.runtimeCodeHash, `${c.name} runtimeCodeHash`);
    assert.ok(Array.isArray(c.abi) && c.abi.length > 0, `${c.name} ABI 为空`);
  }
});
