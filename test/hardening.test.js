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
const { usdtMicroToPayWei } = await import('../src/rates.js');

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
    .send(productPayload({ title: '坏图商品', media: [{ type: 'image', url: 'javascript:alert(1)' }, { type: 'image', url: 'data:image/png;base64,AAAA' }] }))
    .expect(200);
  assert.notEqual(bad.body.code, 0, '非 http(s) 图片应整体拒绝');
  assert.match(bad.body.message, /http\/https/);

  const okP = await createProduct(productPayload({ title: '好图商品', media: [{ type: 'image', url: 'https://example.com/ok.jpg' }] }));
  assert.equal(okP.media.length, 1);
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
    /*
      写接口只认 `specs + skus`（商品级的 `capacity` 是各组合之和的只读汇总，提交它会被
      **带字段名拒绝**——见 products.js 的 PRODUCT_WRITE_KEYS）。本用例只想验"清池后可改型"，
      所以库存按真实形状写在组合上；同时把 skus 完整给出（含 priceUsdtMicro）：
      改了 kind 就落在一件无规格商品上，唯一组合 key='' 给全字段最不易误读。
    */
    .send({
      kind: 'physical',
      title: '清池后改实物',
      specs: [],
      skus: [{ key: '', priceUsdtMicro: 88_000_000, capacity: 5 }],
    })
    .expect(200);
  assertOk(changed);
  assert.equal(changed.body.data.kind, 'physical');
});

test('汇率换算：纯整数向上取整（防少付），无死代码修正分支', () => {
  // 唯一一条腿：1 BTY = x USDT（标价即 USDT，换算里不再乘任何法币汇率）
  const rates = { btyUsdt: 0.1 };
  // 10 USDT（10_000_000 微）→ 恰 100 BTY
  assert.equal(usdtMicroToPayWei(10_000_000, rates), (100n * 10n ** 18n).toString());

  /*
    除不尽的汇率：结果必须是**不小于精确值的最小整数**（整除余数无条件进位）。
    汇率在实现里被放大成整数 scaled = round(rate × 1e8)，于是 1 微 USDT 的精确应付
    = 1e-6 USDT ÷ rate BTY/USDT × 1e18 wei = 1e20 / scaled wei。
  */
  const scaled = BigInt(Math.round(0.022778 * 1e8));
  const num = 1n * 10n ** 20n;
  assert.ok(num % scaled > 0n, '选这个汇率就是为了让除法除不尽——否则测不到"向上取整"');
  const floor = num / scaled;
  const v = BigInt(usdtMicroToPayWei(1, { btyUsdt: 0.022778 }));
  assert.ok(v >= floor, '向上取整结果 ≥ 精确值（防少付）');
  assert.equal(v, floor + 1n, '恰好是最小的可行整数（不是截断，也不多加）');
});

test('履约画像同源窗口：窗外创建、窗内确认的旧单不再污染窗内比率', () => {
  const now = Date.now();
  const e = (name, at) => ({ name, txHash: null, block: null, at });
  const oldCreated = now - 40 * DAY_MS; // 40 天前创建（d30/d90 窗外）
  const rows = [
    {
      status: 'confirmed',
      delivered_at: null,
      // 托管证明（画像按它计入单量）+ 锚点兜底（OrderCreated 被挤掉时用）——见 computeReputation 的说明
      paid_tx_hash: '0x' + 'ab'.repeat(32),
      created_at: oldCreated,
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
