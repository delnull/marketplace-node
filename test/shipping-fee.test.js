/**
 * 实物商品运费（A）：
 *  - 商品级 shipping_fee_usdt_micro（**微 USDT**，按单收取一次；0 = 包邮）可上架/编辑/回读；
 *  - 校验：负值 / 非整数 / 超上限（>1e9 微 = 1000 USDT）/ 非实物商品设运费 一律明确拒绝；
 *  - 快照契约：运费与年龄限制**同键同位**进快照（kind 之后、specs 之前），
 *    改运费必变哈希，未改动时哈希稳定（否则买家会看到假的「商品内容已被修改」）；
 *  - 订单金额：实物单锁 商品 + 运费（按单一次，**不随件数翻倍**）并记录拆分；
 *    数字 / NFT 单只锁商品（运费恒 0）；
 *  - 订单快照可复算（买家侧核验路径：productSnapshot + snapshotHash 自洽）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

let ownerToken;
let buyerToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  assert.ok(ownerToken && buyerToken);
});

const blocked = (res) => {
  assert.notEqual(res.body.code, 0, '应被拒');
  return String(res.body.message || '');
};

async function listProduct(payload) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(payload)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

async function patchProduct(slug, body) {
  const res = await request(app)
    .patch(`/api/products/${slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(body)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 买家本人下单；返回响应体 data（未断言 code——拒绝用例要自己看 message） */
async function createDraft(slug, extra = {}) {
  return request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slug, ...extra })
    .expect(200);
}

const rowOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

/** 期望 wei：与节点同源（rates.usdtMicroToPayWei），避免在测试里手抄一遍汇率算式 */
async function expectWei(usdtMicro) {
  const { getRates, usdtMicroToPayWei } = await import('../src/rates.js');
  return usdtMicroToPayWei(usdtMicro, await getRates());
}

// ── 商品侧：字段与校验 ──

test('运费字段：上架/编辑往返、公开投影含微 USDT 与展示串、包邮为 0', async () => {
  const p = await listProduct(
    productPayload({ kind: 'physical', title: '运费商品', priceUsdtMicro: 88_000_000, capacity: 10, shippingFeeUsdtMicro: 12_000_000 })
  );
  assert.equal(p.shippingFeeUsdtMicro, 12_000_000, '公开投影回传运费（微 USDT）');
  assert.equal(p.shippingFeeUsdt, '12', '展示串（USDT，去净尾零：12 不是 12.00）');
  assert.equal(p.freeShipping, false);

  const free = await listProduct(productPayload({ kind: 'physical', title: '包邮商品', priceUsdtMicro: 5_000_000, capacity: 3 }));
  assert.equal(free.shippingFeeUsdtMicro, 0, '未提交运费 = 0（包邮）');
  assert.equal(free.freeShipping, true);

  // 编辑：改成 5.5 USDT，再改回包邮
  const paid = await patchProduct(p.slug, { shippingFeeUsdtMicro: 5_500_000 });
  assert.equal(paid.shippingFeeUsdtMicro, 5_500_000);
  assert.equal(paid.shippingFeeUsdt, '5.5', '展示串去净尾零：5.50 写作 5.5（有小数位时只去尾零，不补零）');
  const freeAgain = await patchProduct(p.slug, { shippingFeeUsdtMicro: 0 });
  assert.equal(freeAgain.shippingFeeUsdtMicro, 0, '0 = 包邮（可来回改）');

  // 未提交该字段的 PATCH 不改动它（快照字段漏传不得悄悄归零）
  const again = await patchProduct(p.slug, { shippingFeeUsdtMicro: 3_000_000 });
  assert.equal(again.shippingFeeUsdtMicro, 3_000_000);
  const onlyTitle = await patchProduct(p.slug, { title: '运费商品（改名）' });
  assert.equal(onlyTitle.shippingFeeUsdtMicro, 3_000_000, '只改标题不丢运费');
});

test('运费校验：负值/非整数/超上限/非实物商品设运费 一律拒绝', async () => {
  for (const bad of [-1, 1.5, 1_000_000_001, 'abc', {}]) {
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(productPayload({ kind: 'physical', shippingFeeUsdtMicro: bad }))
      .expect(200);
    assert.match(blocked(res), /shippingFeeUsdtMicro（运费）/, `非法运费应被拒：${JSON.stringify(bad)}`);
  }
  // 边界值可用：0 与 1e9（= 1000 USDT）
  const edge = await listProduct(productPayload({ kind: 'physical', title: '运费上限', shippingFeeUsdtMicro: 1_000_000_000 }));
  assert.equal(edge.shippingFeeUsdtMicro, 1_000_000_000);
  // 数字 / NFT 商品没有运费语义：携带非 0 值必须**明确拒绝**（静默归零会误导店主）
  for (const kind of ['digital', 'nft']) {
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(
        productPayload({
          kind,
          shippingFeeUsdtMicro: 1_000_000,
          ...(kind === 'nft'
            ? { nftContract: '0x1111111111111111111111111111111111111111', nftStandard: 'erc721' }
            : {}),
        })
      )
      .expect(200);
    assert.match(blocked(res), /仅实物商品可设置运费/, `${kind} 商品不得设运费`);
  }
});

/*
  ── 单价上限：不只是"防误填"，它还是**安全整数**的保证（源码评审 2026-10，P0） ──

  `orders.usdt_micro` 用 JS Number 承载，而 node:sqlite 读 > 2^53 的整数会抛 RangeError
  （一行脏数据 ⇒ 订单详情/列表/流水/CSV/仲裁/通知全 500，且该行已提交、只能人工改库）。
  上限因此必须是"最坏合计（单价 × 99 件 + 运费上限）仍在 2^53 内"的那个数：
  1e13 微 × 99 + 1e9 = 9.9e14 ≪ 9.007e15。本用例把这个**推导**钉死在测试里——
  以后谁把上限调大，这里先红，而不是等到某天订单面板整片 500。
*/
test('单价上限与"最坏合计必须落在安全整数内"这条推导绑定', async () => {
  const { PRICE_MAX_MICRO, SHIPPING_FEE_MAX_MICRO } = await import('../src/routes/products.js');
  assert.equal(Number.isSafeInteger(PRICE_MAX_MICRO), true, '上限本身必须能精确表示');
  const worst = PRICE_MAX_MICRO * 99 + SHIPPING_FEE_MAX_MICRO; // 99 = orders.quantity 的 CHECK 上限
  assert.equal(
    Number.isSafeInteger(worst),
    true,
    `最坏合计 ${worst} 必须 ≤ Number.MAX_SAFE_INTEGER(${Number.MAX_SAFE_INTEGER})，否则订单行会读不回来`
  );

  // 上限本身可用（边界值不拒），上限 +1 微必须明确拒绝
  const edge = await listProduct(productPayload({ title: '单价上限', priceUsdtMicro: PRICE_MAX_MICRO }));
  assert.equal(edge.priceUsdtMicro, PRICE_MAX_MICRO);
  const over = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ title: '单价越限', priceUsdtMicro: PRICE_MAX_MICRO + 1 }))
    .expect(200);
  assert.match(blocked(over), /价格需为 1\.\./, '越限单价必须明确拒绝而不是截断');
  // 报错文案面向店主：必须说清楚"多少 USDT"，不能只甩一个微整数
  assert.match(blocked(over), /USDT/);
});

// ── 快照契约 ──

test('快照：运费/年龄限制同键同位入快照；改其一必变哈希，无关改动哈希不变', async () => {
  const { snapshotObject, computeSnapshotHash } = await import('../src/routes/products.js');
  const p = await listProduct(
    productPayload({ kind: 'physical', title: '快照运费商品', priceUsdtMicro: 10_000_000, capacity: 5, shippingFeeUsdtMicro: 8_000_000 })
  );
  const snap = snapshotObject({
    slug: p.slug,
    title: p.title,
    description: p.description,
    description_blocks: JSON.stringify(p.descriptionBlocks || []),
    media: JSON.stringify(p.media),
    kind: p.kind,
    shipping_fee_usdt_micro: p.shippingFeeUsdtMicro,
    age_restricted: p.ageRestricted ? 1 : 0,
    specs: JSON.stringify(p.specs || []),
    skus: (p.skus || []).map((s) => ({ sku_key: s.key, price_usdt_micro: s.priceUsdtMicro })),
  });
  assert.equal(computeSnapshotHash(snap), p.snapshotHash, '公开字段可复算快照哈希');
  // 键序契约：kind 之后是 shipping_fee_usdt_micro、age_restricted，然后才是 specs/skus
  assert.deepEqual(Object.keys(snap), [
    'slug',
    'title',
    'description',
    'description_blocks',
    'media',
    'kind',
    'shipping_fee_usdt_micro',
    'age_restricted',
    'specs',
    'skus',
  ]);

  const repriced = await patchProduct(p.slug, { shippingFeeUsdtMicro: 9_000_000 });
  assert.notEqual(repriced.snapshotHash, p.snapshotHash, '改运费必须重算快照哈希');

  const restricted = await patchProduct(p.slug, { ageRestricted: true });
  assert.notEqual(restricted.snapshotHash, repriced.snapshotHash, '加年龄限制必须重算快照哈希');
  assert.equal(restricted.ageRestricted, true, '公开投影回传年龄限制标记');

  // 同值再提交（幂等）不应改变哈希——否则每次保存都会让买家看到"内容被修改"
  const sameAgain = await patchProduct(p.slug, { shippingFeeUsdtMicro: 9_000_000, ageRestricted: true });
  assert.equal(sameAgain.snapshotHash, restricted.snapshotHash, '同值保存哈希不变');

  // 未提交快照字段的部分更新（只改标题）也必须保持其他快照字段原样
  const renamed = await patchProduct(p.slug, { title: '快照运费商品（改名）' });
  const renamedSnap = snapshotObject({
    slug: renamed.slug,
    title: renamed.title,
    description: renamed.description,
    description_blocks: JSON.stringify(renamed.descriptionBlocks || []),
    media: JSON.stringify(renamed.media),
    kind: renamed.kind,
    shipping_fee_usdt_micro: renamed.shippingFeeUsdtMicro,
    age_restricted: renamed.ageRestricted ? 1 : 0,
    specs: JSON.stringify(renamed.specs || []),
    skus: (renamed.skus || []).map((s) => ({ sku_key: s.key, price_usdt_micro: s.priceUsdtMicro })),
  });
  assert.equal(computeSnapshotHash(renamedSnap), renamed.snapshotHash, '改标题后仍可复算（运费/限制未丢）');
  assert.equal(renamed.shippingFeeUsdtMicro, 9_000_000);
  assert.equal(renamed.ageRestricted, true);
});

// ── 订单金额 ──

test('实物订单锁定「商品 + 运费（按单一次）」并记录拆分；多件不翻倍', async () => {
  const p = await listProduct(
    productPayload({ kind: 'physical', title: '运费结算商品', priceUsdtMicro: 88_000_000, capacity: 20, shippingFeeUsdtMicro: 12_000_000 })
  );

  const one = (await createDraft(p.slug, { quantity: 1 })).body.data;
  assert.equal(one.shippingFeeUsdtMicro, 12_000_000, '本单锁定运费');
  assert.equal(one.goodsUsdtMicro, 88_000_000, '商品金额 = 单价 × 数量');
  assert.equal(one.usdtMicro, 100_000_000, '应付 = 商品 88 + 运费 12 = 100 USDT');
  assert.equal(one.shippingFeeUsdt, '12', '展示串去净尾零');
  assert.equal(one.goodsUsdt, '88', '展示串去净尾零');
  assert.equal(one.usdt, '100', '展示串去净尾零');
  assert.equal(one.amountWei, await expectWei(100_000_000), 'amountWei 由「商品+运费」折算锁定');
  const row = rowOf(one.id);
  assert.equal(row.shipping_fee_usdt_micro, 12_000_000, '订单行记录实际锁定的运费');
  assert.equal(row.usdt_micro, 100_000_000);

  // 按单收取一次：3 件的运费仍是 12 USDT（不是 36.00）
  const three = (await createDraft(p.slug, { quantity: 3 })).body.data;
  assert.equal(three.shippingFeeUsdtMicro, 12_000_000, '运费按单收取一次，不随件数翻倍');
  assert.equal(three.goodsUsdtMicro, 264_000_000);
  assert.equal(three.usdtMicro, 276_000_000);
  assert.equal(three.amountWei, await expectWei(276_000_000));

  // 订单快照自洽（买家侧核验路径）：锁定快照 + 哈希可复算
  const { computeSnapshotHash } = await import('../src/routes/products.js');
  assert.equal(computeSnapshotHash(one.productSnapshot), one.snapshotHash, '订单快照哈希可复算');
  assert.equal(one.productSnapshot.shipping_fee_usdt_micro, 12_000_000, '运费写在快照里（买家可核验锁定值）');

  // 事后改运费：老订单的锁定值不变，新订单按新价
  await patchProduct(p.slug, { shippingFeeUsdtMicro: 20_000_000 });
  const oldOrder = (await request(app).get(`/api/orders/${one.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200)).body.data;
  assert.equal(oldOrder.shippingFeeUsdtMicro, 12_000_000, '已下单的老订单运费不变');
  assert.equal(computeSnapshotHash(oldOrder.productSnapshot), oldOrder.snapshotHash, '老订单快照仍可复算（不误报被修改）');
  const fresh = (await createDraft(p.slug, { quantity: 1 })).body.data;
  assert.equal(fresh.shippingFeeUsdtMicro, 20_000_000, '新订单按新运费锁定');
  assert.equal(fresh.usdtMicro, 108_000_000);
});

test('数字 / NFT 订单只锁商品金额（运费恒 0）', async () => {
  const digital = await listProduct(productPayload({ kind: 'digital', title: '数字商品无运费', priceUsdtMicro: 30_000_000 }));
  const o1 = (await createDraft(digital.slug, { quantity: 2 })).body.data;
  assert.equal(o1.shippingFeeUsdtMicro, 0, '数字单运费恒 0');
  assert.equal(o1.goodsUsdtMicro, 60_000_000);
  assert.equal(o1.usdtMicro, 60_000_000, '应付 = 商品金额');
  assert.equal(o1.amountWei, await expectWei(60_000_000));

  const nft = await listProduct(
    productPayload({
      kind: 'nft',
      title: 'NFT 无运费',
      priceUsdtMicro: 50_000_000,
      nftContract: '0x2222222222222222222222222222222222222222',
      nftStandard: 'erc721',
    })
  );
  const o2 = (await createDraft(nft.slug, { quantity: 1 })).body.data;
  assert.equal(o2.shippingFeeUsdtMicro, 0);
  assert.equal(o2.goodsUsdtMicro, 50_000_000);
  assert.equal(o2.usdtMicro, 50_000_000);
  assert.equal(o2.amountWei, await expectWei(50_000_000));
});
