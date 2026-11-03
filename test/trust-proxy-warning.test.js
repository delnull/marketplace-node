/**
 * P1 的另一半：`MK_TRUST_PROXY` **默认关闭**，且"收到 XFF 但没配置"必须在日志里
 * 大声说一次——否则反代之后"所有人共用一个限流桶 / 审计 ip 恒为代理"没有任何信号。
 *
 * 本文件不配置 MK_TRUST_PROXY（默认档），直接驱动唯一取值函数 `clientIp`，
 * 不启动 app、不建库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const config = (await import('../src/config.js')).default;
const { clientIp } = await import('../src/http.js');

test('默认不信任 XFF：req.ip 保持不变；第一次看到 XFF 时告警一次（不刷屏）', () => {
  assert.equal(config.trustProxy, false, '默认必须是"不信任意客户端伪造的来源地址"');

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const req = {
      headers: { 'x-forwarded-for': '203.0.113.9' },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(clientIp(req), '127.0.0.1', '未配置时来源仍是 TCP 对端地址（不解析 XFF）');
    clientIp(req); // 第二次：同一进程只告警一次
  } finally {
    console.warn = origWarn;
  }

  assert.equal(warnings.length, 1, '同一个进程里只喊一次（否则每个请求一行，日志会被自己淹掉）');
  assert.match(warnings[0], /MK_TRUST_PROXY/);
  assert.match(warnings[0], /限流/);
  assert.match(warnings[0], /审计/);
});
