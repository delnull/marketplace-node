/**
 * P1：**暂停接单的店铺，三个"影响未来销售"的商品写入口必须被拒**。
 *
 * `POST /` 与 `PATCH /batch` 一直有闸；`PATCH /:slug`、`POST /:slug/codes`、
 * `POST /:slug/tokens` 没有——同一件事（改价/备货）两个入口两种结论。
 *
 * 修法不是在这三处各补一行：闸下沉到**唯一的取行函数** `requireShopProduct`，
 * 按 HTTP 方法判定（写动作过闸、GET 不过闸——码池读取是店主处理退款/对码所需）。
 * 于是新增一个写入口只要走这个函数就自动带闸；本文件同时钉住"读路径没被误伤"。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

let ownerToken;
let physical;
let digital;
let nft;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  const create = async (body) => {
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
      .send(body)
      .expect(200);
    assertOk(res);
    return res.body.data;
  };
  physical = await create(productPayload({ kind: 'physical', title: '暂停闸-实物' }));
  digital = await create(productPayload({ kind: 'digital', title: '暂停闸-数字' }));
  nft = await create(
    productPayload({
      kind: 'nft',
      title: '暂停闸-NFT',
      nftContract: '0x2222222222222222222222222222222222222222',
      nftStandard: 'erc721',
    })
  );
});

after(async () => {
  await db.run('UPDATE shops SET listed = 1 WHERE code = ?', shopRef.value);
});

const asOwner = (r) =>
  r.set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value);

test('暂停接单：PATCH /:slug、POST /:slug/codes、POST /:slug/tokens 全部被拒；GET 读取不受影响', async () => {
  await db.run('UPDATE shops SET listed = 0 WHERE code = ?', shopRef.value);

  const cases = [
    {
      label: 'PATCH /:slug（改价/改标题）',
      run: () => asOwner(request(app).patch(`/api/products/${physical.slug}`)).send({ title: '暂停时改标题' }),
    },
    {
      label: 'POST /:slug/codes（备码池）',
      run: () => asOwner(request(app).post(`/api/products/${digital.slug}/codes`)).send({ codes: ['PAUSED-1'] }),
    },
    {
      label: 'POST /:slug/tokens（备 NFT 池）',
      run: () => asOwner(request(app).post(`/api/products/${nft.slug}/tokens`)).send({ tokens: ['1'] }),
    },
    // 既有闸的回归：这两个入口本来就该拒，别在改形状时把它们弄丢
    {
      label: 'POST /（新上架）',
      run: () => asOwner(request(app).post('/api/products')).send(productPayload({ title: '暂停时上架' })),
    },
    {
      label: 'PATCH /batch（批量改价）',
      run: () => asOwner(request(app).patch('/api/products/batch')).send({ slugs: [physical.slug], patch: { priceUsdtMicro: 1 } }),
    },
  ];

  for (const c of cases) {
    const res = await c.run();
    assert.equal(res.status, 403, `${c.label}：暂停接单是授权/状态拒绝，统一走 403（与 POST / 同口径）`);
    assert.equal(res.body.code, 403, `${c.label}：必须明确拒绝（旧形状在三个新入口上会成功）`);
    assert.match(String(res.body.message), /暂停接单/, `${c.label}：拒因必须可读且同源`);
  }

  // 写动作确实没有落库：码池/交付池仍为空，标题未变
  assert.equal(Number((await db.get('SELECT COUNT(*) AS c FROM product_codes WHERE product_id = (SELECT id FROM products WHERE slug = ?)', digital.slug)).c), 0);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS c FROM product_nft_tokens WHERE product_id = (SELECT id FROM products WHERE slug = ?)', nft.slug)).c), 0);
  assert.equal((await db.get('SELECT title FROM products WHERE slug = ?', physical.slug)).title, '暂停闸-实物');

  /*
    读路径刻意不过闸：店主必须还能读码池/交付池来处理退款与对码（`listed = 0`
    只是暂停接单，不是店下线——见 shops.js 的说明）。
  */
  const codesRead = await asOwner(request(app).get(`/api/products/${digital.slug}/codes`)).send();
  assert.equal(codesRead.status, 200);
  assertOk(codesRead);
  const tokensRead = await asOwner(request(app).get(`/api/products/${nft.slug}/tokens`)).send();
  assert.equal(tokensRead.status, 200);
  assertOk(tokensRead);
});
