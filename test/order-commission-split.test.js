/**
 * 订单 DTO 的两个抽成字段**不能是同一个问题**（2026-10-18 拆字段）：
 *
 *   · `commission`     = **这一单**的条款：草稿用建单时向买家报的 `commission_quoted_*`；
 *                        已上链用 `/paid`/watcher/`/sync` 从 `Escrow.commissionTermsAtCreate`
 *                        回填的 `commission_*` 快照（链上按它分钱，事后改店铺费率不追溯）。
 *   · `shopCommission` = **店铺当前登记**（`orderTermsOf(shopRow)`），供下单前/付款前与链上比对。
 *
 * 旧实现把"店铺当前登记"塞进 `commission`，于是店铺从 5% 改到 8% 之后，**已成交/待付款的
 * 历史单**在界面上显示成 8%，而链上按它创建时的 5% 结算——店主/买家都无法从订单页看出真相。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, shopRef, insertOrder } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

let ownerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
});

const ownerAddr = owner.address.toLowerCase();
const readOrder = async (orderNo) => {
  const res = await request(app)
    .get(`/api/orders/${orderNo}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(res);
  return res.body.data;
};

test('草稿 5% 之后店铺改 8%：GET /orders/:id 的 commission.bps 仍 5，shopCommission.bps 为 8', async () => {
  // 建单时店铺登记 5%，订单报价也是 5%
  await db.run('UPDATE shops SET commission_bps = 500 WHERE code = ?', shopRef.value);
  const draft = await insertOrder(db, {
    status: 'draft',
    shopCode: shopRef.value,
    buyer: buyer.address.toLowerCase(),
    seller: ownerAddr,
    amountWei: '1000',
    usdtMicro: 1_000_000,
    btyUsdtRate: '0.1',
    commissionQuotedBps: 500,
    commissionQuotedTo: ownerAddr,
  });

  // 店铺事后改成 8%（链上 setShopCommission 的镜像）；草稿还没上链，本单条款仍是报价的 5%
  await db.run('UPDATE shops SET commission_bps = 800 WHERE code = ?', shopRef.value);

  const data = await readOrder(draft.orderNo);
  assert.equal(data.commission?.bps, 500, '草稿的本单条款必须取建单报价（不随店铺改费率漂移）');
  assert.equal(String(data.commission?.to).toLowerCase(), ownerAddr);
  assert.equal(data.shopCommission?.bps, 800, '店铺当前登记必须如实给出 8%（下单前/付款前的比对锚）');
  assert.equal(String(data.shopCommission?.to).toLowerCase(), ownerAddr);
});

test('已上链的单：commission 取链上快照（3%），不取店铺当前登记（8%）', async () => {
  await db.run('UPDATE shops SET commission_bps = 800 WHERE code = ?', shopRef.value);
  const onchain = await insertOrder(db, {
    status: 'escrowed',
    shopCode: shopRef.value,
    buyer: buyer.address.toLowerCase(),
    seller: ownerAddr,
    amountWei: '1000',
    usdtMicro: 1_000_000,
    btyUsdtRate: '0.1',
    escrowOrderId: `0x${'a1'.repeat(32)}`,
    commissionBps: 300,
    commissionTo: ownerAddr,
    commissionQuotedBps: 300,
    commissionQuotedTo: ownerAddr,
  });

  const data = await readOrder(onchain.orderNo);
  assert.equal(data.commission?.bps, 300, '已上链的单按链上快照（钱就是按它分的）');
  assert.equal(data.shopCommission?.bps, 800, '店铺当前登记另给一字段');
});
