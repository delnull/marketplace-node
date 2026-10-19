/**
 * 配置入口的**合约地址严格校验**（唯一判据在 src/config.js）。
 *
 * README/.env.example 里"不要填 0x000…0"只是一句文档，不是判据。填错时节点会照常启动，
 * watcher 每轮都在扫、却永远扫不到事件（零地址上没有代码）——表现为"节点活着、订单永不推进"，
 * 日志里一个字都没有。所以非法值必须在配置求值时就拒绝启动（与弱密钥/库结构的启动自检同口径）。
 *
 * 用子进程测：配置是模块求值期产物，同一个测试进程里无法既加载"合法配置"又加载"非法配置"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const NODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZERO = '0x0000000000000000000000000000000000000000';

/** 只保留与配置校验相关的键：从父进程继承的 MK_* 地址必须先清掉，否则测不出本用例设的值 */
function runConfig(extraEnv) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^MK_(ESCROW|REGISTRY|BLOCKLIST)_ADDRESS$|^MK_TRUST_PROXY$/.test(k)) delete env[k];
  }
  Object.assign(env, extraEnv);
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('./src/config.js').then(m => console.log(JSON.stringify(m.default.chain)))"],
    { cwd: NODE_DIR, env, encoding: 'utf8' }
  );
}

test('已配置的合约地址必须是非零 20 字节 hex；非法即拒绝启动（配置入口一处判据）', () => {
  const bad = [
    { MK_ESCROW_ADDRESS: ZERO },
    { MK_ESCROW_ADDRESS: '0x123' }, // 少位
    { MK_REGISTRY_ADDRESS: 'not-an-address' },
    { MK_BLOCKLIST_ADDRESS: `0x${'0'.repeat(40)}` },
    { MK_TRUST_PROXY: '10.0.0.0/99' }, // 网段前缀越界：反代边界同样必须在启动期可判
  ];
  for (const env of bad) {
    const r = runConfig(env);
    assert.notEqual(r.status, 0, `${JSON.stringify(env)} 必须让进程拒绝启动（实际 stdout=${r.stdout} stderr=${r.stderr}）`);
    assert.match(r.stderr, /MK_(ESCROW|REGISTRY|BLOCKLIST)_ADDRESS|MK_TRUST_PROXY/, '错误必须点名是哪个配置项');
  }

  // 空串是合法的（= 未接入该能力，纯展示节点）；合法地址照常启动
  const empty = runConfig({ MK_ESCROW_ADDRESS: '', MK_REGISTRY_ADDRESS: '', MK_BLOCKLIST_ADDRESS: '' });
  assert.equal(empty.status, 0, `空值必须允许（实际 ${empty.stderr}）`);
  const valid = runConfig({ MK_ESCROW_ADDRESS: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' });
  assert.equal(valid.status, 0, `合法地址必须启动（实际 ${valid.stderr}）`);
  assert.equal(
    JSON.parse(valid.stdout.trim()).escrowAddress,
    '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
    '合法地址原样保留（大小写由使用侧归一）'
  );
});
