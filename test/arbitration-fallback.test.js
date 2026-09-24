/**
 * 仲裁人视角安全降级：节点未配置 MK_ARBITER_ADDRESS 且 RPC 不可达（单测禁网）时，
 * getArbiterAddress 返回 null——详情接口不把任何登录地址视为仲裁人，
 * 宁可拒绝开放视角（交付码不泄露），店主兜底视角不受影响。
 * 状态推进不经真实链上（单测无 RPC）——与 watcher.test 同款：直调 applyEvent。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

// 刻意不设 MK_ARBITER_ADDRESS：走 RPC 读取路径，而单测环境网络被禁（makeCtx 替换 fetch）
const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const arbiter = Wallet.createRandom();

let ownerToken;
let arbiterToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  arbiterToken = (await login(ctx, arbiter)).token;
  assert.ok(ownerToken && arbiterToken);
});

const { applyEvent } = await import('../src/escrowWatcher.js');

test('RPC 不可达且无仲裁人配置：仲裁人登录也不开放交付码（安全降级）', async () => {
  const res0 = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ title: '降级仲裁数字商品' }))
    .expect(200);
  assertOk(res0);
  const p = res0.body.data;

  const draftRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ productSlug: p.slug, buyer: buyer.address })
    .expect(200);
  assertOk(draftRes);
  const order = draftRes.body.data;
  // 模拟 watcher/paid 回写：escrowed 必落链上支付凭证（发货防呆要求，见 orders.js 头注释）
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run('0x' + 'e'.repeat(64), Date.now(), order.id);

  // 卖家手动交付码后买家发起争议（shipped → disputed，含码的争议单）
  const shipRes = await request(app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ deliveryCode: 'CARD-888' })
    .expect(200);
  assertOk(shipRes);
  assert.equal(applyEvent('DisputeRequested', { orderId: order.escrowOrderId }), 1);

  // 待仲裁列表正常公开（降级只影响「仲裁人视角」的数据开放，不影响公开摘要）
  const pendRes = await request(app).get('/api/arbitration/pending').expect(200);
  assertOk(pendRes);
  assert.equal(pendRes.body.data.total, 1);
  assert.equal(pendRes.body.data.disputes[0].delivered, true);

  // 仲裁人令牌访问详情：RPC 不可达 → 无法确证其为链上仲裁人 → 码不开放
  const arbDetail = await request(app)
    .get(`/api/orders/${order.id}`)
    .set('Authorization', `Bearer ${arbiterToken}`)
    .expect(200);
  assertOk(arbDetail);
  assert.equal(arbDetail.body.data.status, 'disputed', '公开字段仍可读');
  assert.deepEqual(arbDetail.body.data.deliveries, [], '未确证仲裁人身份前不泄露码');

  // 店主兜底不受影响（卖家本来持有码，追索/回收权限不依赖仲裁人判定）
  const ownerDetail = await request(app)
    .get(`/api/orders/${order.id}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(ownerDetail);
  assert.equal(ownerDetail.body.data.deliveries[0].value, 'CARD-888', '店主视角不受降级影响');
});
