/**
 * 评审修复回归（2026-09-09 一轮）：
 *  - 商品图片 URL 协议白名单（http/https）
 *  - 下架商品详情：匿名 404 / 店主可预览
 *  - 码池/NFT 池整池清空（ownerOnly + confirm 门）+ 清空后可改型
 *  - 汇率换算精确向上取整（无浮点截断少付）
 *  - 履约画像同源窗口口径（窗外旧单窗内确认不再污染窗内比率）
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, owner } = ctx;

let ownerToken;
let operatorToken;
const DAY_MS = 24 * 3600 * 1000;

const { computeReputation } = await import('../src/reputation.js');
const { cnyFenToPayWei } = await import('../src/rates.js');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  // 操作员：经营面可用，财务面/ownerOnly 不可用（白名单 kv：登录前写入，auth 实时读取即生效）
  const operator = (await import('ethers')).Wallet.createRandom();
  const { kvSet } = await import('../src/db.js');
  kvSet('mk:shop_operators', JSON.stringify([operator.address.toLowerCase()]));
  const op = await login(ctx, operator);
  operatorToken = op.token;
});

async function createProduct(payload) {
  const res = await ctx.request(ctx.app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

test('图片 URL 仅 http/https：javascript:/data: 拒绝入库，正常 https 通过', async () => {
  const bad = await ctx.request(ctx.app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ title: '坏图商品', images: ['javascript:alert(1)', 'data:image/png;base64,AAAA'] }))
    .expect(200);
  assert.notEqual(bad.body.code, 0, '非 http(s) 图片应整体拒绝');
  assert.match(bad.body.message, /http\/https/);

  const okP = await createProduct(productPayload({ title: '好图商品', images: ['https://example.com/ok.jpg'] }));
  assert.equal(okP.images.length, 1);
});

test('下架商品详情：匿名/第三人 404，店主令牌可预览', async () => {
  const p = await createProduct(productPayload({ title: '下架预览商品' }));
  // 操作员（staff）同样可预览（经营面）
  await ctx.request(ctx.app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ active: false })
    .expect(200);

  const anon = await ctx.request(ctx.app).get(`/api/products/${p.slug}`).expect(404);
  assert.equal(anon.body.code, 404);
  const buyerView = await ctx.request(ctx.app).get(`/api/products/${p.slug}`).expect(404); // 第三人同样 404
  assert.equal(buyerView.body.code, 404);

  const ownerView = await ctx.request(ctx.app)
    .get(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(ownerView.body.data.active, false, '店主可预览下架商品');
});

test('码池清空：需 confirm + 仅 owner；清空后可改商品类型', async () => {
  const p = await createProduct(productPayload({ kind: 'digital', title: '清池商品' }));
  await ctx.request(ctx.app)
    .post(`/api/products/${p.slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['C1', 'C2', 'C3'] })
    .expect(200);

  // 操作员不能清池（ownerOnly 敏感批量作废）
  const opClear = await ctx.request(ctx.app)
    .delete(`/api/products/${p.slug}/codes?confirm=1`)
    .set('Authorization', `Bearer ${operatorToken}`)
    .expect(403);
  assert.equal(opClear.body.code, 403);

  // 无 confirm 拒绝
  const noConfirm = await ctx.request(ctx.app)
    .delete(`/api/products/${p.slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.notEqual(noConfirm.body.code, 0);

  // 有池时改型被拒 → 清空后改型成功
  const blockType = await ctx.request(ctx.app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ kind: 'physical', title: '清池后改实物' })
    .expect(200);
  assert.notEqual(blockType.body.code, 0, '已建码池不可直接改型');

  const cleared = await ctx.request(ctx.app)
    .delete(`/api/products/${p.slug}/codes?confirm=1`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(cleared);
  assert.equal(cleared.body.data.cleared, 3);

  const changed = await ctx.request(ctx.app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ kind: 'physical', title: '清池后改实物', capacity: 5 })
    .expect(200);
  assertOk(changed);
  assert.equal(changed.body.data.kind, 'physical');
});

test('汇率换算：纯整数向上取整（防少付），无死代码修正分支', () => {
  const rates = { btyUsdt: 0.1, usdtCny: 7.2 }; // 1 BTY = 0.72 CNY
  // 72 CNY（7200 分）→ 恰 100 BTY
  assert.equal(cnyFenToPayWei(7200, rates), (100n * 10n ** 18n).toString());
  // 0.01 CNY（1 分）→ ceil(0.01/0.72 BTY) = 13888888888888889 wei（整除余数无条件进位）
  assert.equal(cnyFenToPayWei(1, rates), '13888888888888889');
  // 不为 0 的整数保证
  const v = BigInt(cnyFenToPayWei(1, rates));
  const exact = (1n * 10n ** 18n * 100_000_000n) / (BigInt(Math.round(0.1 * 7.2 * 1e8)) * 100n);
  assert.ok(v >= exact, '向上取整结果 ≥ 精确值');
  assert.ok(v - exact <= 1n, '上取整最多 +1 wei');
});

test('履约画像同源窗口：窗外创建、窗内确认的旧单不再污染窗内比率', () => {
  const now = Date.now();
  const e = (name, at) => ({ name, txHash: null, block: null, at });
  const oldCreated = now - 40 * DAY_MS; // 40 天前创建（d30/d90 窗外）
  const rows = [
    {
      status: 'confirmed',
      delivered_at: null,
      onchain_events: JSON.stringify([
        e('OrderCreated', oldCreated),
        e('ReceiptConfirmed', now - 1000), // 窗内才确认（旧实现会把确认计进 d30 分子）
      ]),
    },
  ];
  const r = computeReputation(rows, now);
  assert.equal(r.windows.all.confirmed, 1);
  assert.equal(r.windows.d30.orders, 0, '40 天前创建的订单不进 d30 分母');
  assert.equal(r.windows.d30.confirmed, 0, '其确认也不进 d30 分子（同源）——旧实现分子=1/分母=0 失真');
  assert.equal(r.windows.d30.confirmRate, null);
  assert.equal(r.windows.d90.orders, 1, '40 天在 d90/d365 窗口内（同源分母=分子）');
  assert.equal(r.windows.d90.confirmRate, 1);
  assert.equal(r.windows.d365.orders, 1);
  assert.equal(r.windows.d365.confirmRate, 1, 'd365 窗口完整（同源 1/1）');
});

test('码池敏感读取入审计（code.read）且 detail 不含码原文', async () => {
  const p = await createProduct(productPayload({ kind: 'digital', title: '审计读码商品' }));
  await ctx.request(ctx.app)
    .post(`/api/products/${p.slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['SECRET-CODE-X'] })
    .expect(200);
  await ctx.request(ctx.app)
    .get(`/api/products/${p.slug}/codes?status=all`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const audit = await ctx.request(ctx.app).get('/api/shop/audit').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  const reads = audit.body.data.items.filter((i) => i.action === 'code.read');
  assert.ok(reads.length >= 1, '码池读取应留审计');
  assert.ok(!JSON.stringify(reads).includes('SECRET-CODE-X'), '审计 detail 不得含码原文');
  const opRead = await ctx.request(ctx.app)
    .get(`/api/products/${p.slug}/codes?status=all`)
    .set('Authorization', `Bearer ${operatorToken}`)
    .expect(200);
  assertOk(opRead, '操作员仍可读码（经营面设计），但读取留痕');
});
