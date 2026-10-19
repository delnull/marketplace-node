/**
 * 连接池的**有界排队 + 获取超时 + 深度读数**（`db.js` 的 poolDepth / acquirePooledConnection）。
 *
 * 旧口径是 `queueLimit: 0`（无限排队）且没有获取超时：池子被占满时每个请求都挂在
 * `getConnection()` 上，进程看起来健康但所有请求都在等一条永远不会先到的连接。
 * 这里钉住两件事：
 *   · 读数如实（idle 时 inUse=0；事务结束后归零）；
 *   · 排队到顶**立即失败**（code = MK_DB_POOL_QUEUE_FULL），而不是无限挂住。
 *
 * 获取超时本身是 10s，自动化里不真等（那会把定向测试拖长）；超时路径在交付验证里用
 * 独立探针跑过一次，这里只钉"有界"这一半。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { db } = ctx;
const { poolDepth, withTransaction, openTransactions } = await import('../src/db.js');

test('池深度读数：形状 + idle 时 inUse=0', async () => {
  const d = poolDepth();
  assert.equal(typeof d.connectionLimit, 'number');
  assert.ok(d.connectionLimit >= 1);
  /*
    排队上限是**泄漏护栏**、不是并发节流阀：本仓读面天然一行一查（页面上界 pageSize=100），
    所以上限必须容得下"池很小 + 一页 100 行"这种合法扇出。系数取小（曾取 4 ⇒ 池 2 时上限 8）
    会把正常请求判成泄漏，实测仲裁队列直接 500。
  */
  assert.equal(d.queueLimit, d.connectionLimit * 64, '排队上限由连接数派生（有界，不是 0=无限）');
  assert.ok(d.queueLimit >= 100, '上限必须容得下一页 100 行的合法扇出');
  assert.equal(d.acquireTimeoutMs, 10_000);
  assert.equal(d.inUse, 0, `空闲时不该有借出的连接：${JSON.stringify(d)}`);
  assert.equal(d.waiting, 0);
});

test('事务结束后连接归还（inUse 归零，计数器成对）', async () => {
  const before = poolDepth();
  await withTransaction(async () => {
    await db.get('SELECT 1 AS ok');
    assert.equal(poolDepth().inUse, 1, '事务持有期间应当看得见 1 条借出的连接');
  });
  const after = poolDepth();
  assert.equal(after.inUse, 0);
  assert.equal(after.acquired - after.released, before.acquired - before.released);
  assert.equal(openTransactions(), 0);
});

test('排队到顶立即失败：无界排队在形状上不可表达', async () => {
  const limit = poolDepth().connectionLimit;
  const queue = poolDepth().queueLimit;
  let releaseGates;
  const gates = new Promise((resolve) => {
    releaseGates = resolve;
  });

  // ① 占满全部连接：这些事务拿到连接后停在 gate 上（不提交、不归还）
  const holders = [];
  const started = [];
  for (let i = 0; i < limit; i++) {
    const startedP = {};
    startedP.promise = new Promise((resolve) => {
      startedP.resolve = resolve;
    });
    started.push(startedP.promise);
    holders.push(
      withTransaction(async () => {
        startedP.resolve();
        await gates;
      })
    );
  }
  await Promise.all(started);
  assert.equal(poolDepth().inUse, limit, '全部连接应当都被借出');

  // ② 把排队位置坐满：这些调用都停在 getConnection 上
  const waiters = [];
  for (let i = 0; i < queue; i++) waiters.push(withTransaction(async () => {}));
  assert.equal(poolDepth().waiting, queue, `排队位置应当坐满：${JSON.stringify(poolDepth())}`);

  // ③ 再多一个：必须**当场**失败，而不是加入一条无限的队伍
  await assert.rejects(
    () => withTransaction(async () => {}),
    (e) => e.code === 'MK_DB_POOL_QUEUE_FULL',
    '排队到顶后必须立即失败（MK_DB_POOL_QUEUE_FULL）'
  );
  assert.equal(poolDepth().queueFull, 1);

  // 收尾：放行全部事务，等它们回滚/提交并归还连接；池子回到 idle
  releaseGates();
  await Promise.allSettled([...holders, ...waiters]);
  const after = poolDepth();
  assert.equal(after.inUse, 0, `收尾后不该有借出的连接：${JSON.stringify(after)}`);
  assert.equal(after.waiting, 0);
  assert.equal(openTransactions(), 0);
});
