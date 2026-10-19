/**
 * P2：`/healthz` 必须 `no-store` —— 它是**判据**，不是展示页。
 *
 * 旧实现的 path 正则含 `healthz`，于是它落在公开可缓存分支里：
 * 503 也带 `public, max-age=30, stale-while-revalidate=60`。中间层可以把一个
 * 已经停滞的节点再喂回 healthy 约 90 秒，探活/编排据此判定，重启时机与真实故障错开。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;

const { watcherStatus } = await import('../src/escrowWatcher.js');

const restore = () => {
  watcherStatus.startedAt = 0;
  watcherStatus.lastOkAt = 0;
};

after(restore);

test('/healthz：200 与 503 都带 no-store（健康读数不允许被中间层缓存）', async () => {
  restore(); // startedAt=0 ⇒ 尚未起过轮询 ⇒ 不判（200）
  const healthy = await request(app).get('/healthz').expect(200);
  assertOk(healthy);
  assert.equal(healthy.headers['cache-control'], 'no-store', '健康时也不许缓存');

  // 起过、但已停滞 ⇒ 503：这一档正是最不能被缓存的
  watcherStatus.startedAt = 1;
  watcherStatus.lastOkAt = 1;
  const stalled = await request(app).get('/healthz').expect(503);
  assert.notEqual(stalled.body.code, 0);
  assert.equal(stalled.headers['cache-control'], 'no-store', '不健康时同样不许缓存（否则约 90s 内会被喂回 healthy 假象）');
});
