/**
 * P2：`/healthz` 必须 `no-store` —— 它是**判据**，不是展示页。
 *
 * 旧实现的 path 正则含 `healthz`，于是它落在公开可缓存分支里：
 * 503 也带 `public, max-age=30, stale-while-revalidate=60`。中间层可以把一个
 * 已经停滞的节点再喂回 healthy 约 90 秒，探活/编排据此判定，重启时机与真实故障错开。
 *
 * 多后端之后，watcher 停滞判据读的是**集群级** `node.watcher_last_ok_at`（任意后端成功
 * 都会刷新），不是本进程的 `lastOkAt`——standby 的本地值恒为 0，不能拿它判健康。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db } = ctx;

const { watcherStatus } = await import('../src/escrowWatcher.js');

const originalStartedAt = watcherStatus.processStartedAt;
const originalOk = (await db.get('SELECT watcher_last_ok_at AS at FROM node WHERE id = 1'))?.at ?? null;

const restore = async () => {
  watcherStatus.startedAt = 0;
  watcherStatus.lastOkAt = 0;
  watcherStatus.lockSkippedSince = 0;
  watcherStatus.lastLockSkippedAt = 0;
  watcherStatus.lastLockAcquiredAt = 0;
  watcherStatus.role = 'starting';
  watcherStatus.standbySince = 0;
  watcherStatus.processStartedAt = originalStartedAt;
  await db.run('UPDATE node SET watcher_last_ok_at = ? WHERE id = 1', originalOk);
};

after(restore);

test('/healthz：200 与 503 都带 no-store（健康读数不允许被中间层缓存）', async () => {
  await restore(); // 集群尚未成功、进程刚启动 ⇒ 宽限期内不判（200）
  const healthy = await request(app).get('/healthz').expect(200);
  assertOk(healthy);
  assert.equal(healthy.headers['cache-control'], 'no-store', '健康时也不许缓存');

  // 集群停滞 ⇒ 503：这一档正是最不能被缓存的
  watcherStatus.processStartedAt = Date.now() - 10 * 60_000;
  await db.run('UPDATE node SET watcher_last_ok_at = CURRENT_TIMESTAMP(3) - INTERVAL 10 MINUTE WHERE id = 1');
  const stalled = await request(app).get('/healthz').expect(503);
  assert.notEqual(stalled.body.code, 0);
  assert.equal(stalled.headers['cache-control'], 'no-store', '不健康时同样不许缓存（否则约 90s 内会被喂回 healthy 假象）');
});

test('/healthz：长时间拿不到 watcher 分布式锁（锁空闲）⇒ 503；standby 不判', async () => {
  await restore();
  // 锁被另一后端正常持有：standby 是健康形态，不能因本地没跑过 watcher 就 503
  watcherStatus.role = 'standby';
  watcherStatus.standbySince = Date.now() - 120_000;
  watcherStatus.lockSkippedSince = 0;
  const standby = await request(app).get('/healthz').expect(200);
  assert.equal(standby.body.data.watcher.role, 'standby');

  // 锁空闲却一直抢不到：这才是故障
  watcherStatus.role = 'blocked';
  watcherStatus.lockSkippedSince = Date.now() - 120_000;
  watcherStatus.lastLockSkippedAt = Date.now();
  const res = await request(app).get('/healthz').expect(503);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /分布式锁/);
  assert.equal(res.headers['cache-control'], 'no-store');
});
