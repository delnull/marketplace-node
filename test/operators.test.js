/**
 * P1-⑤ 子账号（店员白名单 kv `mk:shop_operators`，网页「店铺设置」维护）与 P1-④ 审计：
 *  - 登录角色三元（owner/operator/user）；operator 可经营操作、不可财务面；
 *  - 审计记录 staff 动作（含 actor_role）、买家动作不入审计、detail 不含码原文。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const operator = Wallet.createRandom();
const stranger = Wallet.createRandom();

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
// 店员白名单已改 kv（店铺设置页写入；auth.js 每次请求实时读取）
const { kvSet } = await import('../src/db.js');
kvSet('mk:shop_operators', JSON.stringify([operator.address.toLowerCase()]));

let ownerToken;
let operatorToken;
let buyerToken;
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  operatorToken = (await login(ctx, operator)).token;
  buyerToken = (await login(ctx, buyer)).token;
});

test('登录返回三元角色（owner/operator/user）', async () => {
  const asOwner = await request(app)
    .post('/api/auth/login')
    .set('Authorization', '') // login 不需要 token
    .send({});
  void asOwner;
  // 直接校验由 login() helper 拿到的登录态由各钱包构成；此处验证接口字段：
  const op = await (async () => {
    const nonce = await request(app).get(`/api/auth/nonce?address=${operator.address}`).expect(200);
    const sig = await operator.signMessage(nonce.body.data.message);
    return request(app).post('/api/auth/login').send({ address: operator.address, message: nonce.body.data.message, signature: sig }).expect(200);
  })();
  assertOk(op);
  assert.equal(op.body.data.role, 'operator');
  assert.equal(op.body.data.isOperator, true);
  assert.equal(op.body.data.isOwner, false);

  const own = await (async () => {
    const nonce = await request(app).get(`/api/auth/nonce?address=${owner.address}`).expect(200);
    const sig = await owner.signMessage(nonce.body.data.message);
    return request(app).post('/api/auth/login').send({ address: owner.address, message: nonce.body.data.message, signature: sig }).expect(200);
  })();
  assert.equal(own.body.data.role, 'owner');
});

test('操作员可经营（商品/码池/发货/订单列表/状态计数），不可财务面（流水/看板/导出/审计）', async () => {
  // 经营面
  const p = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${operatorToken}`)
    .send(productPayload({ kind: 'physical', title: '操作员商品', priceCnyFen: 9900 }))
    .expect(200);
  assertOk(p);
  const patch = await request(app)
    .patch(`/api/products/${p.body.data.slug}`)
    .set('Authorization', `Bearer ${operatorToken}`)
    .send({ priceCnyFen: 8800 })
    .expect(200);
  assertOk(patch);
  const all = await request(app).get('/api/products/all').set('Authorization', `Bearer ${operatorToken}`).expect(200);
  assertOk(all);
  const ordersList = await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${operatorToken}`).expect(200);
  assertOk(ordersList);
  const counts = await request(app).get('/api/orders/seller/status-counts').set('Authorization', `Bearer ${operatorToken}`).expect(200);
  assertOk(counts);

  // 财务/敏感面 → 403
  await request(app).get('/api/orders/seller/ledger').set('Authorization', `Bearer ${operatorToken}`).expect(403);
  await request(app).get('/api/shop/stats/overview').set('Authorization', `Bearer ${operatorToken}`).expect(403);
  await request(app).get('/api/shop/export/orders.csv').set('Authorization', `Bearer ${operatorToken}`).expect(403);
  await request(app).get('/api/shop/export/codes.csv?slug=x').set('Authorization', `Bearer ${operatorToken}`).expect(403);
  await request(app).get('/api/shop/audit').set('Authorization', `Bearer ${operatorToken}`).expect(403);

  // 普通买家 → 经营面 403
  await request(app).post('/api/products').set('Authorization', `Bearer ${buyerToken}`).send(productPayload()).expect(403);
  await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${buyerToken}`).expect(403);
});

test('审计：staff 动作入账（detail 无码原文）；买家动作不入账；查询仅 owner', async () => {
  // owner 上架数字商品并导入码池（审计应记 product.create/code.import 且 detail 不含码值）
  const p = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ kind: 'digital', title: '审计商品' }))
    .expect(200);
  assertOk(p);
  const slug = p.body.data.slug;
  await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['AUDIT-SECRET-CODE-1'] })
    .expect(200);

  // 买家取消草稿（user 动作不入审计）
  const draft = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slug })
    .expect(200);
  assertOk(draft);
  await request(app)
    .post(`/api/orders/${draft.body.data.id}/cancel`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);

  // 操作员改价（operator 动作入账 actor_role=operator）
  await request(app)
    .patch(`/api/products/${slug}`)
    .set('Authorization', `Bearer ${operatorToken}`)
    .send({ priceCnyFen: 5000 })
    .expect(200);

  const audit = await request(app).get('/api/shop/audit?pageSize=100').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(audit);
  const items = audit.body.data.items;
  const create = items.find((i) => i.action === 'product.create' && i.targetId === slug);
  assert.ok(create && create.actorRole === 'owner', 'owner 上架入审计');
  const imp = items.find((i) => i.action === 'code.import' && i.targetId === slug);
  assert.ok(imp, '码导入入审计');
  assert.ok(!JSON.stringify(imp.detail).includes('AUDIT-SECRET-CODE'), '审计 detail 不含码原文');
  const opUpdate = items.find((i) => i.action === 'product.update' && i.targetId === slug && i.actorRole === 'operator');
  assert.ok(opUpdate, '操作员动作入审计（actor_role=operator）');
  const cancels = items.filter((i) => i.action === 'order.cancel');
  assert.equal(cancels.length, 0, '买家取消不入审计（user 动作过滤）');
  assert.ok(items.every((i) => i.actorRole === 'owner' || i.actorRole === 'operator'));

  // 匿名不可查
  await request(app).get('/api/shop/audit').expect(401);
});
