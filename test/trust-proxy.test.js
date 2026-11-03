/**
 * P1：`MK_TRUST_PROXY` 是 **X-Forwarded-For 的唯一解析点**。
 *
 * 默认部署拓扑是"反代之后"（本机 Caddy/nginx，见 node/README 与 docs/DEPLOY_NODE.md 拓扑 A）。
 * 不配置它时，`req.ip` 恒为代理地址：所有匿名客户端**共用一个限流桶**
 * （一人刷满 `/login` 60 次/分即全网登不上），`audit_logs.ip` 也恒为代理地址。
 *
 * 本文件把 `MK_TRUST_PROXY=loopback` 配好（请求从 127.0.0.1 发出，属于可信跳），
 * 断言：① /healthz 能读到当前口径；② 不同 XFF 来源各有一个限流桶。
 * 默认关闭 + 收到 XFF 时的告警由 trust-proxy-warning.test.js 钉住。
 */
process.env.MK_TRUST_PROXY = 'loopback';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCtx, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;

test('/healthz 暴露生效的反代信任边界（capabilities.trustProxy）', async () => {
  const res = await request(app).get('/healthz').expect(200);
  assertOk(res);
  assert.equal(res.body.data.capabilities?.trustProxy, 'loopback', '运维必须能读到本进程实际信任哪些代理跳');
});

test('限流按 XFF 里的真实来源分桶（不是全节点共用一个桶）', async () => {
  const hit = (ip) =>
    request(app)
      .get('/api/shop/reputation')
      .set('X-Forwarded-For', ip)
      .then((r) => r);

  // 阈值是 60/分：前 60 次必须正常放行
  for (let i = 0; i < 60; i += 1) {
    const r = await hit('203.0.113.7');
    assert.equal(r.status, 200, `第 ${i + 1} 次不应被限流`);
  }
  const blocked = await hit('203.0.113.7');
  assert.equal(blocked.status, 429, '同一个来源达到阈值后必须 429');
  assert.equal(blocked.body.code, 429);

  /*
    关键断言：换一个 XFF 来源必须重新有额度。若 trust proxy 没接线（或写成 false），
    两个来源共用"代理的 IP"这一个桶，这里会是 429——正是"一人刷满、全网登不上"的形态。
  */
  const other = await hit('203.0.113.8');
  assert.equal(other.status, 200, '另一个来源必须有自己的桶（证明 req.ip 取的是 XFF，不是代理地址）');
  assertOk(other);
});

/**
 * "解析真实来源"只有一处：`http.clientIp`。它消费的是 Express 的 trust proxy 结论
 * （`app.set('trust proxy', …)`），所以任何模块再自己读 `req.ip` / `req.socket.remoteAddress`
 * 或在代码里拆 `X-Forwarded-For`，都会造出第二个判据——而它与 Express 的 CIDR 判定必然漂移。
 *
 * 这条用例是**静态**的：行为测试抓不到它（trust proxy 打开时，直接读 req.ip 与本用例
 * 走 clientIp 得到的值恰好相同）。同理它覆盖 `audit_logs.ip` 与登录限流键——两处都曾直接
 * 读 req.ip（audit.js / routes/auth.js），只靠行为断言永远发现不了。
 */
test('来源 IP 的唯一入口：除 http.js 外没有任何模块直接读 req.ip / remoteAddress / XFF', () => {
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(file);
        continue;
      }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(srcRoot, file);
      if (rel === 'http.js') continue; // 唯一实现本身
      const code = stripComments(readFileSync(file, 'utf8'));
      if (/req\??\.ip\b|req\??\.socket\??\.remoteAddress\b|x-forwarded-for/i.test(code)) offenders.push(rel);
    }
  };
  walk(srcRoot);
  assert.deepEqual(
    offenders,
    [],
    `来源 IP 只能从 http.js 的 clientIp 取（XFF/trust proxy 的唯一解析点）；直接读的模块：${offenders.join('、')}`
  );
});
