/**
 * `GET /api/shop` 的 `nodeCode` 必须是**值**（字符串或 null），不是 async 函数的 Promise。
 *
 * 旧实现写 `nodeCode: readNodeCode() || null`，而 `readNodeCode` 是 async ⇒ 恒真的 Promise
 * 被 JSON 序列化成 `{}`：前端拿到一个对象，既不是编号也不是 null，所有"按形状判断"的分支
 * 都走了错误的一边。这里用同步缓存注入直接钉住形状（不依赖 RPC）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;
const { __setCachedShopCodeForTest, resetShopCodeCache } = await import('../src/shopCode.js');

after(() => resetShopCodeCache());

test('未预热 ⇒ nodeCode 为 null（不是 {}）；预热后 ⇒ 原样下发字符串', async () => {
  resetShopCodeCache();
  const cold = await request(app).get('/api/shop').expect(200);
  assert.equal(cold.body.code, 0);
  assert.equal(cold.body.data.nodeCode, null, '没有缓存时如实给 null');
  assert.notDeepEqual(cold.body.data.nodeCode, {}, '不得把 Promise 序列化成 {}');

  __setCachedShopCodeForTest('RRSFVVB8G');
  const warm = await request(app).get('/api/shop').expect(200);
  assert.equal(warm.body.data.nodeCode, 'RRSFVVB8G', '同步缓存里的编号原样下发');
  assert.equal(typeof warm.body.data.nodeCode, 'string', '形状是字符串（不是对象/Promise）');
});
