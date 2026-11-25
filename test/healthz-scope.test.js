/**
 * `/healthz` 的**读数范围**（2026-11）。
 *
 * 背景：`/healthz` 是匿名可打的探活口，而旧实现把 full 读数（整表 shops、审计链校验、
 * 媒体目录扫描、能力探测、node 行明细）**无条件算完**再决定回哪一份。于是任何一个匿名
 * 请求都能让节点跑一遍全量读数——既是免费的全量查询口，也是不需要凭据的 DoS 面。
 *
 * 判据（三半）：
 *   ① 匿名 GET /healthz ⇒ 只回公开读数（身份/计数/watcher 游标），**没有**
 *      capabilities / uploads / node / reconcile / committee / ownerBinding；
 *   ② `?full=1` 不带令牌 ⇒ 401（既不"匿名也给"，也不静默降级成公开读数——
 *      探活脚本据此判断"我到底拿到了哪一份"）；
 *   ③ 节点主带令牌 `?full=1` ⇒ 仍有 capabilities / uploads / node（完整读数没被删掉）。
 *
 * 为什么公开读数里必须留 watcher：`deploy/deploy-node.ps1` 在**不带令牌**的探活响应里
 * grep `"cursor":[0-9]`；删掉它，发布脚本会把"读不到游标"当成故障。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, assertOk, login } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner } = ctx;
const ownerToken = (await login(ctx, owner)).token;

/** 200/503 都是"读数算出来了"：不健康时正文与 200 同形（见 healthz 的判据说明） */
async function read(res) {
  assert.ok(res.status === 200 || res.status === 503, `意外状态码 ${res.status}：${res.text}`);
  assert.ok(res.body.data, '探活必须带 data（算不出来时应走 503 + 无 data 的另一个分支）');
  return res.body.data;
}

test('/healthz：匿名只拿公开读数（不跑审计链/媒体扫描/能力探测）', async () => {
  const d = await read(await request(app).get('/healthz'));
  for (const k of ['capabilities', 'uploads', 'node', 'reconcile', 'piiRetention', 'committee', 'ownerBinding', 'escrowAnchor']) {
    assert.equal(k in d, false, `匿名读数不该包含 ${k}（它只在 full 里，且旧写法会为每个匿名请求白跑一遍）`);
  }
  assert.equal(typeof d.healthy, 'boolean');
  assert.ok(d.watcher && typeof d.watcher === 'object', 'watcher 是公开读数（连接页与探活脚本都要）');
  assert.ok('cursor' in d.watcher, 'deploy-node.ps1 要在无令牌响应里 grep "cursor"');
  assert.deepEqual(Object.keys(d.shops || {}).sort(), ['listed', 'total'], 'shops 形状必须保持 {total,listed}');
  assert.equal(typeof d.version, 'string');
  assert.ok(d.now, 'now 是公开读数（时刻只在响应里，不在文档里）');
});

test('/healthz：?full=1 不带令牌 ⇒ 401（不静默降级，也不匿名给完整读数）', async () => {
  const res = await request(app).get('/healthz?full=1');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 401);
  assert.match(String(res.body.message), /节点主|员工/);
});

test('/healthz：节点主带令牌 ?full=1 ⇒ 完整读数仍在', async () => {
  const res = await request(app)
    .get('/healthz?full=1')
    .set('Authorization', `Bearer ${ownerToken}`);
  assertOk(res); // 200 + code 0（不健康时这个用例的环境不成立：makeCtx 的 watcher 是宽限期）
  const d = res.body.data;
  assert.ok(d.capabilities && typeof d.capabilities === 'object', 'full 必须给能力读数');
  assert.ok(d.capabilities.auditChain, '审计链读数是 full 的一部分');
  assert.ok(d.uploads && typeof d.uploads === 'object', '媒体用量是 full 的一部分');
  assert.ok(d.node && typeof d.node === 'object', 'node 单行读数是 full 的一部分');
});
