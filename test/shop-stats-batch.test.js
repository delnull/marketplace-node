/**
 * 批量店铺统计（目录页一屏一请求）。
 *
 * 口径：只返回本节点在售、且编号存在的店；评价/有效单量按店作用域；
 * 未知编号不出现在结果里（前端按未知处理，不印 0），单店失败不带垮整批。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, assertOk, shopRef } from './setup.mjs';
import { newShopCode } from '../src/ids.js';

const ctx = await makeCtx();
const { app, request } = ctx;

test('批量店铺统计：返回在售店的评价与有效单量，未知编号不出现', async () => {
  const r = await request(app)
    .get(`/api/shops/stats?code=${shopRef.value}&code=ZZZZZZZV4`)
    .expect(200);
  assertOk(r);
  const entry = r.body.data.shops[shopRef.value];
  assert.ok(entry, '在售店应在批量结果里');
  assert.equal(typeof entry.review.count, 'number');
  assert.ok(entry.review.avg === null || typeof entry.review.avg === 'number');
  assert.ok(
    entry.reputation === null || typeof entry.reputation.effectiveOrders === 'number',
    '批量只下发有效单量，不下发完整履约画像'
  );
  assert.equal(r.body.data.shops.ZZZZZZZV4, undefined, '未知编号不返回');
});

test('批量店铺统计：超过 24 个编号返回 400，不静默截断', async () => {
  const codes = Array.from({ length: 25 }, () => newShopCode());
  const query = codes.map((c) => `code=${encodeURIComponent(c)}`).join('&');
  const r = await request(app).get(`/api/shops/stats?${query}`).expect(400);
  assert.equal(r.body.code, 400);
  assert.match(r.body.message, /最多.*24/);
});

test('批量店铺统计：编号里的非字母字符在形状这一关被拒，不透传', async () => {
  // 编号只含 Crockford 字母表：带标点的串在形状这一关被拒，不进结果。
  const r = await request(app).get('/api/shops/stats?code=00000010-').expect(200);
  assertOk(r);
  assert.deepEqual(r.body.data.shops, {}, '非法编号不进结果，请求本身也不能被拆坏');
});
