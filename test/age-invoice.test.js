/**
 * 年龄限制商品机制（B）+ 开票信息机制（C）。
 *
 * B（机制，不是政策）：products.age_restricted 入快照（店主不可在上架后静默增删限制）；
 *   下单必须带买家显式确认 ageAck（没断言直接拒单），落库 orders.age_ack 只是**留痕**——
 *   客户端断言不是年龄证明，不构成授权；非限制商品忽略该断言（恒 0）。
 * C（机制，不是税务政策）：下单可带 invoice {needed,title,taxNo}，trim + 长度上限（抬头 ≤100、税号 ≤40）；
 *   落库 orders.invoice_*，抬头/税号是个人信息 → 仅当事人可见 + 纳入 PII 擦除路径（见 pii-erase.test.js）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();

let ownerToken;
let buyerToken;
let strangerToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  strangerToken = (await login(ctx, stranger)).token;
  assert.ok(ownerToken && buyerToken && strangerToken);
});

const blocked = (res) => {
  assert.notEqual(res.body.code, 0, '应被拒');
  return String(res.body.message || '');
};

const rowOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

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

/** 下单请求（不预设 HTTP 状态：年龄门槛/发票校验按客户端错误返回 400 + 明确中文原因） */
const postOrder = (body, token = buyerToken) =>
  request(app).post('/api/orders').set('Authorization', `Bearer ${token}`).send(body);

const draftCount = () => db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'draft'").get().c;

// ══ B：年龄限制 ══

test('年龄限制商品：下单必须带买家显式确认；确认后留痕并写入快照', async () => {
  const p = await listProduct(
    productPayload({ kind: 'physical', title: '年龄限制商品', priceCnyFen: 5000, capacity: 3, ageRestricted: true })
  );
  assert.equal(p.ageRestricted, true, '公开投影回传年龄限制标记');

  const before = draftCount();
  // ① 不带 ageAck：拒单（机制不能"默认通过"）
  const missing = await postOrder({ productSlug: p.slug });
  assert.match(blocked(missing), /未成年人禁止购买/);
  // ② 显式 false：同样拒单
  const denied = await postOrder({ productSlug: p.slug, ageAck: false });
  assert.match(blocked(denied), /未成年人禁止购买/);
  // ③ 非法断言类型：拒（不给字符串留漂移空间）
  const badType = await postOrder({ productSlug: p.slug, ageAck: 'yes' });
  assert.match(blocked(badType), /ageAck 需为布尔值/);
  assert.equal(draftCount(), before, '被拒的下单不产生草稿（也不占库存额度）');

  // ④ 带断言：建单成功，留痕 + 快照锁定
  const okRes = await postOrder({ productSlug: p.slug, ageAck: true });
  assertOk(okRes);
  const o = okRes.body.data;
  assert.equal(o.ageAck, true, '订单记录买家确认');
  assert.equal(rowOf(o.id).age_ack, 1);
  assert.equal(o.productSnapshot.age_restricted, 1, '年龄限制写入订单锁定的商品快照');
  assert.equal(o.productSnapshot.shipping_fee_cny_fen, 0, '未设运费时为 0（包邮）');
  // 店主代下单同样受门槛约束（门槛在商品上，不在调用方身份上）
  const ownerRes = await postOrder({ productSlug: p.slug, buyer: buyer.address }, ownerToken);
  assert.match(blocked(ownerRes), /未成年人禁止购买/);
  const ownerAck = await postOrder({ productSlug: p.slug, buyer: buyer.address, ageAck: true }, ownerToken);
  assertOk(ownerAck);
  assert.equal(ownerAck.body.data.ageAck, true);
});

test('非年龄限制商品：ageAck 断言被忽略（恒 0，不留误导性痕迹）', async () => {
  const p = await listProduct(productPayload({ kind: 'digital', title: '普通商品，无年龄限制', priceCnyFen: 1000 }));

  const noAck = (await postOrder({ productSlug: p.slug })).body.data;
  assert.equal(noAck.ageAck, false);
  assert.equal(rowOf(noAck.id).age_ack, 0);

  const withAck = await postOrder({ productSlug: p.slug, ageAck: true });
  assertOk(withAck);
  assert.equal(withAck.body.data.ageAck, false, '商品未声明年龄限制时，客户端断言一律忽略');
  assert.equal(rowOf(withAck.body.data.id).age_ack, 0);
  assert.equal(withAck.body.data.productSnapshot.age_restricted, 0);
});

test('年龄限制标记入快照：加/去限制必变哈希，同值保存哈希不变；校验拒绝非布尔', async () => {
  const { computeSnapshotHash, snapshotObject } = await import('../src/routes/products.js');
  const p = await listProduct(
    productPayload({ kind: 'physical', title: '年龄限制快照商品', priceCnyFen: 2000, capacity: 5, shippingFeeCnyFen: 500 })
  );
  const base = p.snapshotHash;
  assert.equal(p.ageRestricted, false);

  const restricted = await patchProduct(p.slug, { ageRestricted: true });
  assert.notEqual(restricted.snapshotHash, base, '加上年龄限制必须重算快照哈希');
  const snap = snapshotObject({
    slug: restricted.slug,
    title: restricted.title,
    description: restricted.description,
    description_blocks: JSON.stringify(restricted.descriptionBlocks || []),
    images: JSON.stringify(restricted.images),
    kind: restricted.kind,
    shipping_fee_cny_fen: restricted.shippingFeeCnyFen,
    age_restricted: restricted.ageRestricted ? 1 : 0,
    specs: JSON.stringify(restricted.specs || []),
    skus: (restricted.skus || []).map((s) => ({ sku_key: s.key, price_cny_fen: s.priceCnyFen })),
  });
  assert.equal(snap.age_restricted, 1, '快照含 age_restricted');
  assert.equal(computeSnapshotHash(snap), restricted.snapshotHash, '快照哈希可复算');
  // 1 与 true 等价（快照里归一为 0/1，避免 true/false 与 1/0 混用产生不同哈希）
  const asOne = await patchProduct(p.slug, { ageRestricted: 1 });
  assert.equal(asOne.snapshotHash, restricted.snapshotHash, '1 与 true 同值同哈希');

  const back = await patchProduct(p.slug, { ageRestricted: false });
  assert.equal(back.snapshotHash, base, '去掉限制回到同一快照（哈希确定）');
  assert.equal(back.ageRestricted, false);

  const bad = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ kind: 'physical', title: '非法限制值', ageRestricted: 'yes' }))
    .expect(200);
  assert.match(blocked(bad), /ageRestricted/);
});

// ══ C：开票信息 ══

test('开票信息：往返存读 + trim + 长度上限 + 类型校验；不影响金额', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '开票商品', priceCnyFen: 3300, capacity: 10, shippingFeeCnyFen: 600 }));

  const withInvoice = await postOrder({
    productSlug: p.slug,
    invoice: { needed: true, title: '  某某科技有限公司  ', taxNo: ' 91310000MA1K35XXXX ' },
  });
  assertOk(withInvoice);
  const o = withInvoice.body.data;
  assert.deepEqual(o.invoice, { needed: true, title: '某某科技有限公司', taxNo: '91310000MA1K35XXXX' });
  const row = rowOf(o.id);
  assert.equal(row.invoice_needed, 1);
  assert.equal(row.invoice_title, '某某科技有限公司');
  assert.equal(row.invoice_tax_no, '91310000MA1K35XXXX');
  // 开票信息不是钱：金额仍 = 商品 + 运费
  assert.equal(o.cnyFen, 3900);
  assert.equal(o.goodsCnyFen, 3300);
  assert.equal(o.shippingFeeCnyFen, 600);

  // 未提交 invoice：默认空对象，不误标 needed
  const none = (await postOrder({ productSlug: p.slug })).body.data;
  assert.deepEqual(none.invoice, { needed: false, title: '', taxNo: '' });
  assert.equal(rowOf(none.id).invoice_needed, 0);

  // 只填税号（抬头留空）也可（个人抬头/无需抬头的情形）
  const taxOnly = await postOrder({ productSlug: p.slug, invoice: { needed: true, taxNo: '91310000MA1K35YYYY' } });
  assertOk(taxOnly);
  assert.equal(taxOnly.body.data.invoice.title, '');
  assert.equal(taxOnly.body.data.invoice.needed, true);
  // 只填抬头不勾 needed：仍记为需要开票（有抬头就是要开票，标记不能自相矛盾）
  const titleOnly = await postOrder({ productSlug: p.slug, invoice: { title: '个人' } });
  assertOk(titleOnly);
  assert.equal(titleOnly.body.data.invoice.needed, true);

  // 长度上限：超限明确拒绝，不静默截断（截断出错的税号比拒绝一次更糟）
  const longTitle = await postOrder({ productSlug: p.slug, invoice: { needed: true, title: 'x'.repeat(101) } });
  assert.match(blocked(longTitle), /发票抬头不能超过 100 字符/);
  const longTax = await postOrder({ productSlug: p.slug, invoice: { needed: true, taxNo: 'y'.repeat(41) } });
  assert.match(blocked(longTax), /纳税人识别号不能超过 40 字符/);
  // 边界可用：正好 100 / 40
  const edge = await postOrder({
    productSlug: p.slug,
    invoice: { needed: true, title: 't'.repeat(100), taxNo: 'n'.repeat(40) },
  });
  assertOk(edge);
  assert.equal(edge.body.data.invoice.title.length, 100);
  assert.equal(edge.body.data.invoice.taxNo.length, 40);

  // 类型校验：needed 非布尔 / invoice 非对象 / 勾了要票却什么都没填
  const badNeeded = await postOrder({ productSlug: p.slug, invoice: { needed: 'yes', title: '甲' } });
  assert.match(blocked(badNeeded), /invoice\.needed 需为布尔值/);
  const badShape = await postOrder({ productSlug: p.slug, invoice: ['x'] });
  assert.match(blocked(badShape), /invoice 需为对象/);
  const emptyButNeeded = await postOrder({ productSlug: p.slug, invoice: { needed: true } });
  assert.match(blocked(emptyButNeeded), /至少填写发票抬头或纳税人识别号/);
});

test('开票信息可见性：仅买家本人/店主可见（同收货信息矩阵），匿名与第三人恒 null', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '开票可见性商品', priceCnyFen: 1000, capacity: 5 }));
  const o = (
    await postOrder({ productSlug: p.slug, invoice: { needed: true, title: '某某商贸行', taxNo: '91440300MA5FXXXXXX' } })
  ).body.data;

  const asBuyer = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assert.equal(asBuyer.body.data.invoice.title, '某某商贸行');

  const asOwner = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.equal(asOwner.body.data.invoice.taxNo, '91440300MA5FXXXXXX', '店主可见（要照着开票）');

  const anon = await request(app).get(`/api/orders/${o.id}`).expect(200);
  assert.equal(anon.body.data.invoice, null, '匿名详情不暴露开票信息');

  const asStranger = await request(app)
    .get(`/api/orders/${o.id}`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .expect(200);
  assert.equal(asStranger.body.data.invoice, null, '第三人不可见开票信息');

  const listAnon = await request(app).get(`/api/orders?address=${buyer.address}`).expect(200);
  assert.equal(listAnon.body.data.orders.find((x) => x.id === o.id).invoice, null, '匿名列表同样为 null');
  const listBuyer = await request(app)
    .get(`/api/orders?address=${buyer.address}`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  assert.equal(listBuyer.body.data.orders.find((x) => x.id === o.id).invoice.needed, true);

  const sellerList = await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.ok(sellerList.body.data.orders.find((x) => x.id === o.id).invoice, '店主列表可见开票信息');
});
