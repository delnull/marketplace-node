/**
 * 生产语义硬化（源码评审 2026-09 的新增回归网）。
 *
 * 本文件专门覆盖"**没设 NODE_ENV**"这个真实部署形状——裸机/systemd/容器起 node 时
 * 常常什么都不设，而仓库里原先三处各自算了一遍"是不是生产"：
 *   · `app.js` 的 CORS：`NODE_ENV !== 'production'` ⇒ 裸机被当成**非生产**，`MK_CORS_ORIGIN=*`
 *     会反射任意 Origin（任何网站都能带 Cookie/Authorization 读走响应）；
 *   · `server.js` 的密钥自检：`NODE_ENV !== 'test' && !== 'development'` ⇒ 裸机按**生产**拦。
 * 同一台机器上两处结论相反，靠的就是没人把这两种写法放在一起看过。
 * 现在判据唯一化为 `http.js` 的 `isProdLike()`，本文件把它钉死。
 *
 * 注意：`.env.test` 在本仓**不存在**（`--env-file-if-exists` 只是容错），测试进程里
 * `process.env.NODE_ENV` 本来就是 undefined ⇒ 默认场景即"裸机部署"，无需伪造。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;
const { createApp } = await import('../src/app.js');
const { isProdLike, wrap } = await import('../src/http.js');
const { default: config } = await import('../src/config.js');

test('"类生产"判据：未设/空/生产 → 是；test/development → 否', async () => {
  assert.equal(process.env.NODE_ENV, undefined, '本套件的前提是进程里没有 NODE_ENV（裸机形状）');
  // 未设（undefined）与空串都要算生产：`NODE_ENV=` 这种"设了个空值"的写法同样不给人开绿灯
  assert.equal(isProdLike(undefined), true, '没设 NODE_ENV 必须按生产处理');
  assert.equal(isProdLike(''), true, 'NODE_ENV= 空值必须按生产处理');
  assert.equal(isProdLike('production'), true);
  assert.equal(isProdLike('test'), false);
  assert.equal(isProdLike('development'), false);
  // 不传参时读 process.env（调用点都这么用）
  assert.equal(isProdLike(), true);
});

test('CORS：裸机（未设 NODE_ENV）不反射任意 Origin；development 才反射', async () => {
  assert.equal(config.corsOrigin, '*', '本用例前提是 MK_CORS_ORIGIN 缺省为 *（否则测不到"反射"这条路）');
  const origin = 'https://evil.example';
  const probe = (a) => request(a).get('/healthz').set('Origin', origin).expect(200);

  // ① 类生产：origin 判为 false ⇒ cors 中间件**不设** Access-Control-Allow-Origin
  process.env.NODE_ENV = '';
  const prodLike = createApp();
  const denied = await probe(prodLike);
  assert.equal(
    denied.headers['access-control-allow-origin'],
    undefined,
    '裸机部署下不得反射任意 Origin（旧写法 NODE_ENV !== "production" 会在这里放行）'
  );

  // ② 显式开发：本地/演示要跨端口，反射照旧
  process.env.NODE_ENV = 'development';
  const dev = createApp();
  const allowed = await probe(dev);
  assert.equal(allowed.headers['access-control-allow-origin'], origin, 'development 下应反射请求 Origin');

  delete process.env.NODE_ENV; // 复原：下面的用例仍在"裸机"前提下跑
  assert.equal(isProdLike(), true);
});

test('匿名可读的仲裁待办列表带 private, no-store；公开只读端点仍是 public', async () => {
  // 仲裁面含完整买卖双方地址（见 routes/arbitration.js 文件头隐私口径），匿名可读 ⇒ 必须禁缓存
  const arb = await request(app).get('/api/arbitration/pending').expect(200);
  const cc = String(arb.headers['cache-control'] || '');
  assert.match(cc, /no-store/, '/api/arbitration/pending 必须 no-store（旧白名单漏了它）');
  assert.match(cc, /private/, '含参与方地址的响应只允许私有缓存');

  // 反例：公开只读端点（不含隐私字段）不应被一起禁掉——否则联邦首页 N 家店 × 3~4 请求全打回源
  const health = await request(app).get('/healthz').expect(200);
  assert.match(
    String(health.headers['cache-control'] || ''),
    /public/,
    '公开只读端点应保持 public 缓存策略，别把整站都禁成 no-store'
  );
});

test('未捕获异常：类生产只回"服务内部错误"（不带异常原文），development 回原文', async () => {
  // 造一个会抛的实现（内容取真实形状：fs 的 ENOENT 带绝对路径）
  const boom = () =>
    wrap(async () => {
      throw new Error("ENOENT: no such file or directory, open '/srv/marketplace/node/.data/attachments/secret.pdf'");
    });
  const call = async () => {
    let body;
    const res = {
      status() {
        return this;
      },
      json(b) {
        body = b;
        return this;
      },
    };
    // wrap 的错误分支是异步 catch，等一个微任务/宏任务周期
    boom()({}, res);
    await new Promise((r) => setTimeout(r, 0));
    return body;
  };

  process.env.NODE_ENV = '';
  const prod = await call();
  assert.equal(prod.message, '服务内部错误', '生产必须给通用文案');
  assert.ok(
    !JSON.stringify(prod).includes('/srv/marketplace'),
    '响应里不得出现异常原文（绝对路径/内部结构）'
  );

  process.env.NODE_ENV = 'development';
  const dev = await call();
  assert.match(dev.message, /ENOENT/, '开发/本地排查仍要原文');

  delete process.env.NODE_ENV;
});
