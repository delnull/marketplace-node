/**
 * 路由大小写（2026-11）。
 *
 * Express 默认**大小写不敏感**：`/API/orders` 与 `/api/orders` 命中同一条路由。而本进程里
 * 有一批准据按 `req.path` 的**小写正则**写：缓存判定、JSON 解析豁免（上传路径）、
 * 部分限流键。两层对"同一个请求"给出不同答案，且判据层是沉默的——换个大小写就能让
 * "该豁免的被顶掉 / 该限流的没限"。
 *
 * 判据（三半）：① 非规范大小写的 API 路径 404（不存在"另一条入口"）；
 *              ② 规范路径照旧（200/503 都算通，健康判据另测）；
 *              ③ `/healthz` 大写也 404（探活脚本不会用大写，但这是同一条规则）。
 *
 * 代价：历史客户端若用过大写路径会 404。本项目按 greenfield 写，接口路径的唯一来源是
 * 前端与文档，不需要为这种形状留兼容。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;

test('非规范大小写的 API 路径一律 404（不许绕过按小写路径写的判据）', async () => {
  for (const p of ['/API/products', '/Api/orders', '/HEALTHZ', '/API/uploads']) {
    const r = await request(app).get(p);
    assert.equal(r.status, 404, `${p} 必须 404，实际 ${r.status}`);
  }
});

test('规范路径不受影响（这一条防的是"开了开关把正常路径也挡了"）', async () => {
  const products = await request(app).get('/api/products');
  assert.equal(products.status, 200, '小写产品列表必须照常 200');
  const health = await request(app).get('/healthz');
  assert.ok(health.status === 200 || health.status === 503, `健康判据只允许 200/503，实际 ${health.status}`);
});
