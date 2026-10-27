/**
 * `MK_TRUST_PROXY` 的解析是 XFF 信任边界的唯一入口；默认部署写的是
 * `loopback,172.16.0.0/12` 这种混合形式，必须真的能启动，而不是在首次请求/重启时炸掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readTrustProxy(value) {
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import cfg from './src/config.js'; console.log(JSON.stringify(cfg.trustProxy))"],
    {
      cwd: NODE_DIR,
      encoding: 'utf8',
      env: { ...process.env, MK_TRUST_PROXY: value, MK_TOKEN_SECRET: 'test-secret-0123456789abcdef' },
    }
  );
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

test('MK_TRUST_PROXY：loopback 与 CIDR 混写可用（默认自动部署的写法）', () => {
  const r = readTrustProxy('loopback,172.16.0.0/12');
  assert.equal(r.status, 0, r.err || r.out);
  assert.deepEqual(JSON.parse(r.out), ['loopback', '172.16.0.0/12']);
});

test('MK_TRUST_PROXY：无法解析的项必须拒绝启动，不能静默忽略', () => {
  const r = readTrustProxy('loopback,not-an-ip');
  assert.notEqual(r.status, 0, '非法项必须让配置入口抛错');
  assert.match(r.err, /MK_TRUST_PROXY|not-an-ip/);
});
