/**
 * P1-⑤ 店员（`shop_operators`，**一行一人、按店铺分**，网页「店铺设置」维护）与 P1-④ 审计：
 *  - 登录回执给 `isHost` 与 `shops[]`（这个地址能经营的店**与各自角色**），没有节点级的
 *    `role`/`isOwner`/`isStaff`——"这次登录针对哪家店"这件事已经不在了；staff 可经营操作、
 *    不可财务面；
 *  - 审计记录 staff 动作（含 actor_role）、买家动作不入审计、detail 不含码原文。
 *
 * "店员"是**这家店**授权的角色，而不是"这个节点的操作员"：单键时代 A 店店员在 B 店同样能经营，
 * 而 B 店店主既看不见也撤不掉那份授权。所以白名单的键是**店铺编号**（fixture 落的那一行），
 * 不是空串、也不是节点主地址。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const operator = Wallet.createRandom();
const stranger = Wallet.createRandom();

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
/*
  店员白名单（店铺设置页写入；auth.js 每次请求实时读取 `shop_operators`）。
  用 addShopOperator 而不是"写一份名单"：旧实现是 kv 里的一份 JSON 数组，增删都要先读后写，
  两个并发请求各自写回就会把对方那一份整个盖掉（被移除的店员仍有权限，且静默）。
  这里断言**读回的集合**而不是"写过了就算数"：店铺编号写错时在这一行就红，
  而不是等到下面某个接口 403 才表现成"鉴权坏了"。
*/
const { addShopOperator, getShopOperators } = await import('../src/auth.js');
await addShopOperator(shopRef.value, operator.address.toLowerCase());
assert.deepEqual(await getShopOperators(shopRef.value), [operator.address.toLowerCase()]);

let ownerToken;
let operatorToken;
let buyerToken;
let strangerToken;
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  operatorToken = (await login(ctx, operator)).token;
  buyerToken = (await login(ctx, buyer)).token;
  strangerToken = (await login(ctx, stranger)).token;
});

test('登录回执：isHost + shops[] 逐店角色（没有节点级的 role/isOwner/isStaff）', async () => {
  const op = await (async () => {
    const nonce = await request(app).get(`/api/auth/nonce?address=${operator.address}`).expect(200);
    const sig = await operator.signMessage(nonce.body.data.message);
    return request(app).post('/api/auth/login').send({ address: operator.address, message: nonce.body.data.message, signature: sig }).expect(200);
  })();
  assertOk(op);
  /*
    店员身份是**这家店**给的，所以判据从"回执里的 role == 'staff'"改成"回执列出的那家店里
    role == 'staff'"：同一次登录里他可能只是 A 店的店员，在 B 店什么都不是。
  */
  const roleIn = (body, code) => body.shops.find((s) => s.code === code)?.role;
  assert.equal(roleIn(op.body.data, shopRef.value), 'staff', '该地址在这家店是店员');
  // 店员不是节点主：节点级动作（开店申请队列）对他关闭
  assert.equal(op.body.data.isHost, false);
  /*
    旧形状的三个字段随"这次登录针对哪家店"一起删掉了（见 src/routes/auth.js）。
    留着它们就是留一份"登录那一刻的角色快照"，而他现在能不能动这家店，每次都按
    `shops.seller` / `shop_operators` 现算——两份真相迟早不一致。
  */
  for (const removed of ['role', 'isOwner', 'isStaff']) {
    assert.ok(!(removed in op.body.data), `登录回执不应再有 ${removed}（没有"这次登录针对哪家店"这回事）`);
  }

  const own = await (async () => {
    const nonce = await request(app).get(`/api/auth/nonce?address=${owner.address}`).expect(200);
    const sig = await owner.signMessage(nonce.body.data.message);
    return request(app).post('/api/auth/login').send({ address: owner.address, message: nonce.body.data.message, signature: sig }).expect(200);
  })();
  /*
    节点主在他**自己开的那家店**里同时是 host 与 owner（那家店的 seller 就是他）。
    两者是**可以同时成立**的身份，所以是两个独立判据——把一个短路进另一个，
    就会出现"他管不了自己的流水"（短路成 host）或"他进不了节点级动作"（短路成 owner）。
  */
  assert.equal(own.body.data.isHost, true);
  assert.equal(roleIn(own.body.data, shopRef.value), 'owner');
});

test('操作员可经营（商品/码池/发货/订单列表/状态计数），不可财务面（流水/看板/导出/审计）', async () => {
  // 经营面
  const p = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'physical', title: '操作员商品', priceUsdtMicro: 99_000_000 }))
    .expect(200);
  assertOk(p);
  const patch = await request(app)
    .patch(`/api/products/${p.body.data.slug}`)
    .set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value)
    // 价格/库存逐组合给出（`specs + skus` 是写接口的唯一形状；商品级的 priceUsdtMicro/capacity 是只读汇总）
    .send({ skus: [{ key: '', priceUsdtMicro: 88_000_000 }] })
    .expect(200);
  assertOk(patch);
  const all = await request(app).get('/api/products/all').set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(all);
  const ordersList = await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(ordersList);
  const counts = await request(app).get('/api/orders/seller/status-counts').set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(counts);

  /*
    「同步链上状态」是运维动作（把漏扫/滞后的镜像拉回链上真值），店员本就能发货、登记 NFT 交付、
    回复评价，唯独这一个按钮此前只认 `config.shop.owner`（2026-10-15 与全仓 staffOnly 规约对齐）。
    验法：拿一张**别人的**真实订单（买家自己下的草稿）分别用店员与陌生人去同步——
    陌生人必须 403，店员必须过得了鉴权（本测试的 RPC 指向必然拒连的端口，见 setup.mjs，
    所以它会停在"读不到链上"那一步，就像真实 RPC 故障时一样）。
  */
  const draftRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: p.body.data.slug })
    .expect(200);
  assertOk(draftRes);
  const foreignOrderId = draftRes.body.data.id;

  const asStranger = await request(app)
    .post(`/api/orders/${foreignOrderId}/sync`)
    .set('Authorization', `Bearer ${strangerToken}`).set('X-Mk-Shop', shopRef.value);
  assert.equal(asStranger.status, 403, '陌生人不得同步别人的订单');

  const asOperator = await request(app)
    .post(`/api/orders/${foreignOrderId}/sync`)
    .set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value);
  assert.notEqual(asOperator.status, 403, `店员必须过得了这道鉴权，实际：${asOperator.status} ${asOperator.body.message}`);
  assert.notEqual(asOperator.status, 404, '订单确实存在 ⇒ 404 会说明请求根本没走到鉴权之后那一步');
  assert.ok(
    !/仅买家本人或店铺经营人员/.test(String(asOperator.body.message)),
    '过不了鉴权才会出现这句文案'
  );

  // 财务/敏感面 → 403
  await request(app).get('/api/orders/seller/ledger').set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value).expect(403);
  await request(app).get('/api/shop/stats/overview').set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value).expect(403);
  await request(app).get('/api/shop/export/orders.csv').set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value).expect(403);
  await request(app).get('/api/shop/export/codes.csv?slug=x').set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value).expect(403);
  await request(app).get('/api/shop/audit').set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value).expect(403);

  // 普通买家 → 经营面 403
  await request(app).post('/api/products').set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).send(productPayload()).expect(403);
  await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(403);
});

test('审计：staff 动作入账（detail 无码原文）；买家动作不入账；查询仅 owner', async () => {
  // owner 上架数字商品并导入码池（审计应记 product.create/code.import 且 detail 不含码值）
  const p = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'digital', title: '审计商品' }))
    .expect(200);
  assertOk(p);
  const slug = p.body.data.slug;
  await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ codes: ['AUDIT-SECRET-CODE-1'] })
    .expect(200);

  // 买家取消草稿（user 动作不入审计）
  const draft = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug })
    .expect(200);
  assertOk(draft);
  await request(app)
    .post(`/api/orders/${draft.body.data.id}/cancel`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);

  // 操作员改价（staff 动作入账 actor_role=staff）
  await request(app)
    .patch(`/api/products/${slug}`)
    .set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ skus: [{ key: '', priceUsdtMicro: 50_000_000 }] })
    .expect(200);

  const audit = await request(app).get('/api/shop/audit?pageSize=100').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(audit);
  const items = audit.body.data.items;
  const create = items.find((i) => i.action === 'product.create' && i.targetId === slug);
  assert.ok(create && create.actorRole === 'owner', 'owner 上架入审计');
  const imp = items.find((i) => i.action === 'code.import' && i.targetId === slug);
  assert.ok(imp, '码导入入审计');
  assert.ok(!JSON.stringify(imp.detail).includes('AUDIT-SECRET-CODE'), '审计 detail 不含码原文');
  const opUpdate = items.find((i) => i.action === 'product.update' && i.targetId === slug && i.actorRole === 'staff');
  assert.ok(opUpdate, '店员动作入审计（actor_role=staff）');
  const cancels = items.filter((i) => i.action === 'order.cancel');
  assert.equal(cancels.length, 0, '买家取消不入审计（user 动作过滤）');
  assert.ok(items.every((i) => i.actorRole === 'owner' || i.actorRole === 'staff'));

  // 匿名不可查
  await request(app).get('/api/shop/audit').expect(401);
});
