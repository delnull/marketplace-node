/**
 * 2026-09 修复回归：
 *  1) 同买家同（限量）商品至多一张未支付草稿——sybil 免费草稿锁库存 DoS 收敛；
 *     同商品旧草稿取消后可重新下单；不限量/池式商品不受限。
 *  2) SIWE nonce 防覆盖：未过期挑战重复获取幂等返回，不再顶掉进行中的登录；
 *     过期后正常重发。
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
});

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

function createDraft(slug, token = buyerToken, qty) {
  return request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ productSlug: slug, ...(qty ? { quantity: qty } : {}) });
}

test('限量商品：同买家同商品未支付草稿合计占用 ≤99 件（防单地址 990 件锁库），取消后可重建', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '限量重复草稿商品', capacity: 500 }));

  // 多张未支付草稿仍允许（分次付款流）：2 × qty1 = 2 ≤ 99
  const a1 = await createDraft(p.slug, buyerToken, 1).expect(200);
  assertOk(a1);
  const a2 = await createDraft(p.slug, buyerToken, 2).expect(200);
  assertOk(a2, '合计 ≤99 件的多张草稿应放行');
  void a2;

  // 已有 2 件占用时再下 99 件 → 拒绝（原可 10 张 ×99 = 990 件/地址）
  const big0 = await createDraft(p.slug, buyerToken, 99).expect(200);
  assert.equal(big0.body.code, 1);
  assert.match(big0.body.message, /99/, '合计超 99 件上限应拒绝');

  // 取消全部旧草稿后 99 件大单放行；再补 1 件 → 拒绝
  for (const d of [a1, a2]) {
    await request(app)
      .post(`/api/orders/${d.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
  }
  const big = await createDraft(p.slug, buyerToken, 99).expect(200);
  assertOk(big);
  const over = await createDraft(p.slug, buyerToken, 1).expect(200);
  assert.equal(over.body.code, 1);
  assert.match(over.body.message, /99/, '超 99 件上限应拒绝');

  // 取消后恢复额度 → 可再次下单
  await request(app)
    .post(`/api/orders/${big.body.data.id}/cancel`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  const again = await createDraft(p.slug, buyerToken, 1).expect(200);
  assertOk(again);
  assert.notEqual(again.body.data.id, big.body.data.id);
});

test('限量商品：草稿已支付（escrowed）后允许再次下单同商品；店主可代其他买家下单', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '限量已付再购商品', capacity: 50 }));
  const r1 = await createDraft(p.slug).expect(200);
  assertOk(r1);
  // 模拟支付回写（escrowed 非 draft，不占草稿槽位）
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = '0x' || hex(randomblob(32)) WHERE id = ?").run(r1.body.data.id);
  const r2 = await createDraft(p.slug).expect(200);
  assertOk(r2, '已支付后再次下单应放行');
  // 店主为其他买家代下单不受该买家草稿影响
  const otherBuyer = (await import('ethers')).Wallet.createRandom();
  const res3 = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ productSlug: p.slug, buyer: otherBuyer.address })
    .expect(200);
  assertOk(res3);
});

test('不限量商品（capacity null）不设同商品草稿限制', async () => {
  const p = await listProduct(productPayload({ kind: 'digital', title: '不限量重复草稿商品', capacity: null }));
  const r1 = await createDraft(p.slug).expect(200);
  assertOk(r1);
  const r2 = await createDraft(p.slug).expect(200);
  assertOk(r2, '不限量商品允许多张草稿（无锁库存面）');
});

test('SIWE nonce 防覆盖：未过期挑战重复获取幂等；过期后重发', async () => {
  const first = await request(app).get(`/api/auth/nonce?address=${buyer.address}`).expect(200);
  assertOk(first);
  const second = await request(app).get(`/api/auth/nonce?address=${buyer.address}`).expect(200);
  assertOk(second);
  assert.equal(second.body.data.message, first.body.data.message, '未过期挑战应幂等返回（不被第三方顶掉）');

  // 强制过期后重新签发（新消息）
  db.prepare('UPDATE siwe SET expires_at = 0 WHERE address = ?').run(buyer.address.toLowerCase());
  const third = await request(app).get(`/api/auth/nonce?address=${buyer.address}`).expect(200);
  assertOk(third);
  assert.notEqual(third.body.data.message, first.body.data.message, '过期后应重新生成挑战');
});

test('SIWE 身份：填域名 → 域名入签名原文；未填 → 回退链（登记端点 → 店主地址）', async () => {
  const expire = () => db.prepare('UPDATE siwe SET expires_at = 0 WHERE address = ?').run(buyer.address.toLowerCase());
  const ownerLower = owner.address.toLowerCase();

  // 1) MK_SIWE_DOMAIN：host 小写归一 + 端口保留，URI 补全协议；该形态下登录仍可完成
  process.env.MK_SIWE_DOMAIN = 'https://Shop-A.Example.com:8443';
  expire();
  const r1 = await request(app).get(`/api/auth/nonce?address=${buyer.address}`).expect(200);
  assertOk(r1);
  assert.match(r1.body.data.message, /shop-a\.example\.com:8443 wants you to sign in/);
  assert.match(r1.body.data.message, /URI: https:\/\/shop-a\.example\.com:8443\//);
  const sig1 = await buyer.signMessage(r1.body.data.message);
  const l1 = await request(app)
    .post('/api/auth/login')
    .send({ address: buyer.address, message: r1.body.data.message, signature: sig1 })
    .expect(200);
  assertOk(l1, '域名形态签名原文可正常登录');

  // 2) 回退 MK_REGISTER_ENDPOINT（取 host，忽略路径）
  delete process.env.MK_SIWE_DOMAIN;
  process.env.MK_REGISTER_ENDPOINT = 'https://reg.example.net/order';
  expire();
  const r2 = await request(app).get(`/api/auth/nonce?address=${buyer.address}`).expect(200);
  assertOk(r2);
  assert.match(r2.body.data.message, /reg\.example\.net wants you to sign in/);
  assert.match(r2.body.data.message, /URI: https:\/\/reg\.example\.net\//);

  // 3) 均未填 → 店主地址小写兜底（domain 与 URI 均锚定店铺身份）
  delete process.env.MK_REGISTER_ENDPOINT;
  expire();
  const r3 = await request(app).get(`/api/auth/nonce?address=${buyer.address}`).expect(200);
  assertOk(r3);
  assert.match(r3.body.data.message, new RegExp(`${ownerLower} wants you to sign in`));
  assert.match(r3.body.data.message, new RegExp(`URI: https://${ownerLower}/`));
});

test('auth Origin 协议健全性：null/file 来源拒绝，https 来源放行', async () => {
  const expire = () => db.prepare('UPDATE siwe SET expires_at = 0 WHERE address = ?').run(buyer.address.toLowerCase());
  // 非法协议 Origin（沙箱 null / 本地文件）→ 403（业务码与既有 403 约定一致）
  for (const origin of ['null', 'file://', 'data:']) {
    const res = await request(app)
      .get(`/api/auth/nonce?address=${buyer.address}`)
      .set('Origin', origin)
      .expect(403);
    assert.equal(res.body.code, 403, `${origin} 应被协议校验拒绝`);
  }
  // 正规 https 前端 → 放行并可完成登录
  expire();
  const nonce = await request(app)
    .get(`/api/auth/nonce?address=${buyer.address}`)
    .set('Origin', 'https://portal.example.com')
    .expect(200);
  assertOk(nonce);
  const sig = await buyer.signMessage(nonce.body.data.message);
  const login = await request(app)
    .post('/api/auth/login')
    .set('Origin', 'https://portal.example.com')
    .send({ address: buyer.address, message: nonce.body.data.message, signature: sig })
    .expect(200);
  assertOk(login);
});
