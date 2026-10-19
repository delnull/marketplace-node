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
import express from 'express';
import { makeCtx, shopRef, insertOrder as insertOrderRow } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;
const { createApp, appErrorHandler } = await import('../src/app.js');
const { isProdLike, wrap, asyncMiddleware } = await import('../src/http.js');
// 进程内的 watcher 状态对象（**故意导出**：`/healthz` 的健康判据就建在它上面，
// 而"停滞"这件事没法在测试里真的等出来——见文件末尾那条用例）
const { watcherStatus: watcherRuntime } = await import('../src/escrowWatcher.js');
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

test('匿名可读的仲裁待办列表带 private, no-store；公开只读端点仍是 public；/healthz 单列 no-store', async () => {
  // 仲裁面含完整买卖双方地址（见 routes/arbitration.js 文件头隐私口径），匿名可读 ⇒ 必须禁缓存
  const arb = await request(app).get('/api/arbitration/pending').expect(200);
  const cc = String(arb.headers['cache-control'] || '');
  assert.match(cc, /no-store/, '/api/arbitration/pending 必须 no-store（旧白名单漏了它）');
  assert.match(cc, /private/, '含参与方地址的响应只允许私有缓存');

  /*
    `/healthz` 是**判据**不是展示页：503 也带 `public, max-age=30, stale-while-revalidate=60`
    时，中间层能把一个已停滞的节点再喂回 healthy 约 90 秒（见 P2 修复）。
  */
  const health = await request(app).get('/healthz').expect(200);
  assert.equal(health.headers['cache-control'], 'no-store', '健康检查不允许被中间层缓存');

  // 反例：公开只读端点（不含隐私字段）不应被一起禁掉——否则联邦首页 N 家店 × 3~4 请求全打回源
  const rates = await request(app).get('/api/rates').expect(200);
  assert.match(
    String(rates.headers['cache-control'] || ''),
    /public/,
    '公开只读端点应保持 public 缓存策略，别把整站都禁成 no-store'
  );
  // 店铺作用域请求必须按 X-Mk-Shop 分桶：否则共享缓存会把 A 店商品/画像喂给 B 店
  const products = await request(app).get('/api/products').set('X-Mk-Shop', shopRef.value).expect(200);
  assert.match(String(products.headers.vary || ''), /X-Mk-Shop/i, 'Vary 必须包含 X-Mk-Shop');
});

test('未捕获异常：类生产只回"服务内部错误"（不带异常原文），development 回原文', async () => {  // 造一个会抛的实现（内容取真实形状：fs 的 ENOENT 带绝对路径）
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

test('SyntaxError 不一律算客户端错：库里坏 JSON 抛的 SyntaxError ⇒ 500；body-parser 的 parse.failed ⇒ 400', async () => {
  const { db, buyer, owner } = ctx;
  /*
    真往库里写一条坏快照：`orders.product_snapshot` 是 MEDIUMTEXT（不是 JSON 列，
    理由见 db.js —— 快照字节必须由应用决定），所以它能存下坏 JSON，而某个 handler
    对它 JSON.parse 就会抛 SyntaxError——**与客户端请求体无关**。
  */
  const row = await insertOrderRow(db, {
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    productSnapshot: '{"title": "半截',
  });
  const stored = await db.get('SELECT product_snapshot FROM orders WHERE order_no = ?', row.orderNo);
  assert.equal(stored.product_snapshot, '{"title": "半截', '前置：库里确实存着坏 JSON');

  /*
    用**真实的**全局错误兜底（它被导出就是为了能这样直接驱动，而不是只能造一个 body-parser
    请求去间接命中）：handler 读库里的坏 JSON 并 JSON.parse ⇒ SyntaxError。
    旧判据 `err instanceof SyntaxError` 会把它报成 400"请求体不是合法 JSON"，
    把服务端数据损坏说成客户端输入错误。
  */
  const probe = express();
  probe.get('/db-corrupt-json', asyncMiddleware(async () => {
    JSON.parse(stored.product_snapshot);
  }));
  probe.use(appErrorHandler);
  const corrupt = await request(probe).get('/db-corrupt-json').expect(500);
  assert.equal(corrupt.body.code, 1, '500 路径保持统一失败信封');
  assert.doesNotMatch(String(corrupt.body.message), /合法 JSON/, '库里的坏 JSON 不得被报成"请求体不是合法 JSON"');

  // 反例：body-parser 的 entity.parse.failed 仍必须 400（客户端可自行修复的输入问题）
  const badBody = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send('{"address":')
    .expect(400);
  assert.equal(badBody.body.code, 1);
  assert.match(badBody.body.message, /请求体不是合法 JSON/, '客户端 JSON 语法错仍是 400');
});

/**
 * `/healthz` 的**健康判据**（2026-10-16 新增）：它此前无条件返回 200/code=0，于是
 * Docker HEALTHCHECK、`deploy.sh` 探活、`deploy-node.ps1` 的核对三处**都只证明"进程在监听"**
 * ——watcher 停摆时"发布成功"照样打印。现在停滞或隔离数非零 ⇒ **503 + code≠0**。
 *
 * 判据的三种情形必须分开（把"没轮到"与"坏了"混起来，一次 RPC 抖动之后容器编排就会
 * 反复重启一个配置完全正确的节点）：
 *   ① 未配置托管合约（纯展示节点）⇒ 不判；
 *   ② **轮询器还没起过**（startedAt == 0）⇒ 不判（链上读数还没有过第一次采样）；
 *   ③ 起过但停滞（lastOkAt 距今 ≥ 三倍轮询间隔、下限 90 秒）⇒ 不健康。
 * 这三条都在本用例里逐个走一遍；第 ③ 条只能靠**改状态**（窗口下限 90 秒，等不出来）。
 */
test('/healthz 健康判据：轮询器未起过 ⇒ 200；停滞 ⇒ 503（且 code≠0、带原因）', async () => {
  const saved = { ...watcherRuntime };
  const { db } = ctx;
  /*
    隔离数**不能靠改 `watcherStatus.quarantined` 来伪造**：那个字段在 `escrowWatcherStatus()`
    里会被**库里的 `node.quarantined_events` 覆盖**（库里那份才是唯一真相，见该函数的说明）。
    要让它非零就得真的往库里写（下面第 ④ 段），用完还原。
  */
  const savedQ = (await db.get('SELECT quarantined_events AS q FROM node WHERE id = 1'))?.q ?? null;
  try {
    // ② 轮询器还没起过：不判（"没有读数"不是"读数不好"）
    watcherRuntime.startedAt = 0;
    watcherRuntime.lastOkAt = 0;
    const notStarted = await request(app).get('/healthz').expect(200);
    assert.equal(notStarted.body.data.healthy, true, '还没轮到第一轮 ⇒ 不因 watcher 判不健康');

    // ③ 起过、但最后一次成功轮询远在过去 ⇒ 503
    watcherRuntime.startedAt = Date.now() - 10 * 60_000;
    watcherRuntime.lastOkAt = Date.now() - 10 * 60_000; // 远超三倍轮询间隔且 > 90 秒下限
    const stalled = await request(app).get('/healthz').expect(503);
    assert.notEqual(stalled.body.code, 0, 'code 也必须非 0（只看 code 的探活要能失败）');
    assert.equal(stalled.body.data.healthy, false);
    assert.match(String(stalled.body.data.reason), /停滞/, '原因要能直接读（运维据此判断是 RPC 还是合约）');

    // ④ 隔离事件非零：无论 watcher 在不在推进，都不健康（有事件连续失败、需人工介入）
    watcherRuntime.lastOkAt = Date.now();
    await db.run('UPDATE node SET quarantined_events = ? WHERE id = 1', JSON.stringify({
      '0:1:OrderCreated': { attempts: 5, name: 'OrderCreated', at: Date.now(), err: '测试注入' },
    }));
    const quarantined = await request(app).get('/healthz').expect(503);
    assert.match(String(quarantined.body.data.reason), /隔离/, '要说清是隔离事件，而不是含糊的"不健康"');
    assert.equal(quarantined.body.data.watcher.quarantined, 1, '隔离条数取自库里的 node.quarantined_events');

    // 恢复之后必须回到 200 —— 判据是**读数**，不是"一旦不健康就永久不健康"
    await db.run('UPDATE node SET quarantined_events = ? WHERE id = 1', JSON.stringify(savedQ ?? {}));
    watcherRuntime.lastOkAt = Date.now();
    const healed = await request(app).get('/healthz').expect(200);
    assert.equal(healed.body.data.healthy, true);
  } finally {
    // 进程级共享状态：必须还原，否则同进程的其它用例会读到假的健康结论
    Object.assign(watcherRuntime, saved);
    await db.run('UPDATE node SET quarantined_events = ? WHERE id = 1', JSON.stringify(savedQ ?? {}));
  }
});