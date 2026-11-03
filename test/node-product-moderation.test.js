/**
 * 节点管理员强制下架/恢复商品。
 *
 * 判据：
 *   · 与店主 `active` 正交：店主上架也绕不过 `node_hidden`，店主不能改它；
 *   · 公开列表/详情/建单在隐藏后都不可达，卖家 `/all` 仍能看到原因；
 *   · 恢复后重新进入公开面；
 *   · 非节点管理员不能调用；动作留节点级审计。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, shopRef, productPayload, insertProduct } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const code = shopRef.value;

async function createProduct(token, title = '节点处置测试商品') {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Mk-Shop', code)
    .send(productPayload({ title }))
    .expect(200);
  assertOk(res);
  return res.body.data.slug;
}

test('节点强制下架：公开面消失、店主改不动；恢复后重新可见并留审计', async () => {
  const token = (await login(ctx, owner)).token;
  const auth = { Authorization: `Bearer ${token}` };
  const slug = await createProduct(token);
  const modPath = `/api/products/admin/${slug}/moderation`;

  const bad = await request(app).patch(modPath).set(auth).send({ hidden: true });
  assert.equal(bad.status, 400, '强制下架必须给原因');

  const hidden = await request(app)
    .patch(modPath)
    .set(auth)
    .send({ hidden: true, reason: '疑似假货，待店主举证' })
    .expect(200);
  assertOk(hidden);
  assert.equal(hidden.body.data.nodeHidden, true);

  const admin = await request(app)
    .get('/api/products/admin/all?hidden=1&q=节点处置测试商品')
    .set(auth)
    .expect(200);
  const adminRow = admin.body.data.products.find((p) => p.slug === slug);
  assert.ok(adminRow, '节点管理列表必须能看到被强制下架的商品');
  assert.equal(adminRow.nodeHidden, true);
  assert.equal(adminRow.nodeHiddenReason, '疑似假货，待店主举证');

  const shopRow = (
    await request(app)
      .get('/api/shops/admin/all')
      .set(auth)
      .expect(200)
  ).body.data.shops.find((s) => s.code === code);
  assert.equal(shopRow.hiddenProductCount, 1, '店铺管理读数要跟着商品处置更新');
  assert.ok(shopRow.productCount >= 1);

  const publicList = await request(app).get('/api/products?pageSize=100').expect(200);
  assert.equal(
    publicList.body.data.products.some((p) => p.slug === slug),
    false,
    '被节点隐藏的商品不能出现在公开列表'
  );
  const publicDetail = await request(app).get(`/api/products/${slug}`);
  assert.equal(publicDetail.status, 404, '被节点隐藏的商品公开详情按不存在处理');

  const sellerAll = await request(app)
    .get('/api/products/all?pageSize=100')
    .set(auth)
    .set('X-Mk-Shop', code)
    .expect(200);
  const row = sellerAll.body.data.products.find((p) => p.slug === slug);
  assert.ok(row, '卖家列表仍要能看到这件商品（否则无从整改）');
  assert.equal(row.nodeHidden, true);
  assert.equal(row.nodeHiddenReason, '疑似假货，待店主举证', '原因必须让店主看到');

  // 店主不能通过商品编辑接口改节点处置：未知字段被明确拒绝（不是静默忽略）
  const sellerTry = await request(app)
    .patch(`/api/products/${slug}`)
    .set(auth)
    .set('X-Mk-Shop', code)
    .send({ nodeHidden: false });
  assert.notEqual(sellerTry.body.code, 0);
  assert.match(String(sellerTry.body.message), /nodeHidden/);

  // 店主重新上架自己的 active 也不会绕过节点处置
  await request(app)
    .patch(`/api/products/${slug}`)
    .set(auth)
    .set('X-Mk-Shop', code)
    .send({ active: true })
    .expect(200);
  const stillHidden = await request(app).get(`/api/products/${slug}`);
  assert.equal(stillHidden.status, 404);

  const audit = await db.get(
    "SELECT shop_code, target_id, detail FROM audit_logs WHERE action = 'product.node_hide' ORDER BY id DESC LIMIT 1"
  );
  assert.ok(audit, '强制下架必须留审计');
  assert.equal(audit.shop_code, null, '商品处置是节点级动作（shop_code 为 NULL）');
  assert.equal(audit.target_id, slug);

  const scoped = await request(app)
    .get(`/api/shop/audit/node?targetShop=${code}`)
    .set(auth)
    .expect(200);
  assert.ok(
    scoped.body.data.items.some((i) => i.action === 'product.node_hide' && i.targetId === slug),
    '店铺详情要能按 detail.shopCode 读到这家店的商品处置记录'
  );

  const restored = await request(app).patch(modPath).set(auth).send({ hidden: false }).expect(200);
  assertOk(restored);
  assert.equal(restored.body.data.nodeHidden, false);
  assert.equal(restored.body.data.nodeHiddenAt, null, '恢复后不再保留处置时刻（审计里有）');
  const visible = await request(app).get(`/api/products/${slug}`).expect(200);
  assert.equal(visible.body.data.slug, slug);
});

test('非节点管理员不能强制下架商品', async () => {
  const ownerToken = (await login(ctx, owner)).token;
  const slug = await createProduct(ownerToken);
  const buyerToken = (await login(ctx, buyer)).token;
  const list = await request(app)
    .get('/api/products/admin/all')
    .set('Authorization', `Bearer ${buyerToken}`);
  assert.equal(list.status, 403, '节点商品管理列表只对 nodeAdmin 开放');
  const res = await request(app)
    .patch(`/api/products/admin/${slug}/moderation`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ hidden: true, reason: '越权尝试' });
  assert.equal(res.status, 403);
});

test('节点预览：隐藏/草稿商品的详情只对节点管理员开放', async () => {
  const token = (await login(ctx, owner)).token;
  const auth = { Authorization: `Bearer ${token}` };
  const slug = await createProduct(token, '节点预览测试商品');

  const detail = await request(app).get(`/api/products/admin/${slug}`).set(auth).expect(200);
  assertOk(detail);
  assert.equal(detail.body.data.product.slug, slug);
  assert.equal(detail.body.data.shop.code, code);
  assert.match(String(detail.body.data.product.description), /单测上架的商品描述/);

  const buyerToken = (await login(ctx, buyer)).token;
  const forbidden = await request(app)
    .get(`/api/products/admin/${slug}`)
    .set('Authorization', `Bearer ${buyerToken}`);
  assert.equal(forbidden.status, 403);
});

test('批量处置：缺一件整批不执行；全批存在时一次下架/恢复', async () => {
  const token = (await login(ctx, owner)).token;
  const auth = { Authorization: `Bearer ${token}` };
  const a = await createProduct(token, '批量处置 A');
  const b = await createProduct(token, '批量处置 B');
  const batchPath = '/api/products/admin/moderation';

  const noReason = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ slugs: [a, b], hidden: true });
  assert.equal(noReason.status, 400, '批量下架同样必须给原因');

  const missing = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ slugs: [a, 'NOT_A_SLUG'], hidden: true, reason: '批量测试' });
  assert.equal(missing.status, 404, '缺一件应整批拒绝');
  const untouched = await request(app).get(`/api/products/${a}`).expect(200);
  assert.equal(untouched.body.data.slug, a, '整批拒绝时不能部分下架');

  const hidden = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ slugs: [a, b], hidden: true, reason: '批量售假投诉' })
    .expect(200);
  assertOk(hidden);
  assert.deepEqual([...hidden.body.data.updated].sort(), [a, b].sort());
  assert.equal(hidden.body.data.unchanged, 0);

  for (const slug of [a, b]) {
    const publicDetail = await request(app).get(`/api/products/${slug}`);
    assert.equal(publicDetail.status, 404, '批量下架后公开详情不可达');
    const adminDetail = await request(app).get(`/api/products/admin/${slug}`).set(auth).expect(200);
    assert.equal(adminDetail.body.data.product.nodeHidden, true);
  }

  const restored = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ slugs: [a, b], hidden: false })
    .expect(200);
  assertOk(restored);
  assert.deepEqual([...restored.body.data.updated].sort(), [a, b].sort());
  for (const slug of [a, b]) {
    await request(app).get(`/api/products/${slug}`).expect(200);
  }
});

test('节点商品列表可按店铺筛选；非法店铺编号 400', async () => {
  const token = (await login(ctx, owner)).token;
  const auth = { Authorization: `Bearer ${token}` };
  const seller = Wallet.createRandom().address.toLowerCase();
  await db.run(
    'INSERT INTO shops (code, seller, name, notice, listed) VALUES (?, ?, ?, ?, 1)',
    '0000SHP02',
    seller,
    '第二家店',
    ''
  );
  const { slug } = await insertProduct(db, { shopCode: '0000SHP02', title: '第二家店的商品' });

  const filtered = await request(app)
    .get('/api/products/admin/all?shop=0000SHP02&pageSize=100')
    .set(auth)
    .expect(200);
  assert.ok(filtered.body.data.products.some((p) => p.slug === slug));
  assert.equal(
    filtered.body.data.products.every((p) => p.shopCode === '0000SHP02'),
    true,
    '按店铺筛选不能混进别家的商品'
  );

  const second = await insertProduct(db, { shopCode: '0000SHP02', title: '第二家店的商品 2' });
  const recent = await request(app)
    .get('/api/products/admin/all?shop=0000SHP02&sort=recent&pageSize=2')
    .set(auth)
    .expect(200);
  assert.deepEqual(
    recent.body.data.products.map((p) => p.slug),
    [second.slug, slug],
    'sort=recent 必须按 id 倒序（店铺详情看最近商品）'
  );

  const bad = await request(app).get('/api/products/admin/all?shop=not-a-code').set(auth);
  assert.equal(bad.status, 400);
  const badSort = await request(app).get('/api/products/admin/all?sort=oldest').set(auth);
  assert.equal(badSort.status, 400);
});
