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
    .get(`/api/shops/stats?code=${shopRef.value}&code=ZZZZZZZZZ`)
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
  assert.equal(r.body.data.shops.ZZZZZZZZZ, undefined, '未知编号不返回');
});

test('批量店铺统计：超过 24 个编号返回 400，不静默截断', async () => {
  const codes = Array.from({ length: 25 }, () => newShopCode());
  const query = codes.map((c) => `code=${encodeURIComponent(c)}`).join('&');
  const r = await request(app).get(`/api/shops/stats?${query}`).expect(400);
  assert.equal(r.body.code, 400);
  assert.match(r.body.message, /最多.*24/);
});

test('批量店铺统计：校验位是逗号的合法编号不被逗号分隔拆坏', async () => {
  // 用生成器找一个校验位为逗号的合法编号（这是 shopCode 的合法扩展符号，不是脏数据）
  let code = '';
  for (let i = 0; i < 200; i += 1) {
    const candidate = newShopCode();
    if (candidate.endsWith(',')) {
      code = candidate;
      break;
    }
  }
  assert.ok(code, '应能生成校验位为逗号的编号');
  const r = await request(app).get(`/api/shops/stats?code=${encodeURIComponent(code)}`).expect(200);
  assertOk(r);
  assert.equal(r.body.data.shops[code], undefined, '不在库里的编号不返回，但请求本身不能被拆坏');
});
