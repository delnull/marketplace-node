/**
 * 公开销量：已支付件数，剔除全额退款/取消/自买；不限量也计。
 *
 * 这条与 `committed`（库存占用，含未付款草稿）是两件事。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, hexlify, randomBytes } from 'ethers';
import { makeCtx, assertOk, insertProduct, insertOrder } from './setup.mjs';
import { newProductSlug } from '../src/ids.js';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

test('商品销量只算已支付件数，不限量也计；退款/草稿/自买不计', async () => {
  const slug = newProductSlug();
  const title = `销量口径 ${slug}`;
  const { productId } = await insertProduct(db, {
    slug,
    title,
    description: '',
    kind: 'digital',
    priceCurrency: 'USDT',
    media: [],
    specs: [],
    terms: {},
  });

  const buyer = Wallet.createRandom().address.toLowerCase();
  const seller = owner.address.toLowerCase();
  const paid = (n, over = {}) => ({
    productId,
    productSlug: slug,
    seller,
    buyer,
    status: 'escrowed',
    quantity: n,
    paidTxHash: hexlify(randomBytes(32)),
    ...over,
  });

  // 2 件已支付在途 + 1 件已支付结算 = 3 件销量
  await insertOrder(db, paid(2));
  await insertOrder(db, paid(1, { status: 'settled' }));
  // 全额退款：已支付但不计销量
  await insertOrder(db, paid(3, { status: 'refunded' }));
  // 未支付草稿：不计销量
  await insertOrder(db, { productId, productSlug: slug, seller, buyer, status: 'draft', quantity: 4 });
  // 自买：不计销量
  await insertOrder(db, paid(5, { buyer: seller }));

  const res = await request(app).get(`/api/products?q=${encodeURIComponent(title)}`).expect(200);
  assertOk(res);
  const row = res.body.data.products.find((p) => p.slug === slug);
  assert.ok(row, '商品应出现在公开列表里');
  assert.equal(row.sales, 3, '销量 = 已支付件数，不含退款/草稿/自买');
  assert.equal(typeof row.committed, 'number', '库存占用字段仍独立下发');
});
