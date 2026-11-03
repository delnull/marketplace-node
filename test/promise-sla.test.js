/**
 * 商品级「承诺 vs 实际」读数（`opsMetrics.promiseSlaReading`，经 `GET /api/shop/sla` 下发）。
 *
 * 这一条读数存在的理由：店主在商品上声明了「2 天内发货」（进快照、仲裁台照着判），
 * 但在它对面**此前没有任何读数**——承诺只是文案。这个文件钉住三件事：
 *  1. **两侧判据都复用**，不新起口径：「已交付」= stockHold.isDelivered、「耗时」=
 *     reputation.shipLatencySpan、「分位数」= reputation.percentile。这里用"同一批样本"验：
 *     同一条已交付订单既进 /api/shop/reputation 的 delivery，也进承诺对账的实况；
 *  2. **在途超承诺**是给店主看的、可操作的那一半（数字 + 最久等了多久），
 *     而已终结（取消/退款/超时）的单**不许**被算成"还没发货"；
 *  3. **没声明承诺的商品不在清单里**（不声明就没有可对账的东西，不拿 0 天冒充），
 *     未上架的商品同样不算（还没有买家能看到它）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef, insertOrder as insertOrderRow } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const DAY = 24 * 3600 * 1000;
let ownerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
});

const post = async (body) => {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(body)
    .expect(200);
  assertOk(res);
  return res.body.data;
};

const rowOf = async (slug) => await db.get('SELECT id FROM products WHERE slug = ?', slug);

let seq = 0;
/**
 * 直接插订单行（本文件关心读数口径，不走下单链路）。
 * 关键点：**带上 product_id**（承诺对账按商品归属），并给 paid_tx_hash
 * （没有链上支付凭证的单不进任何统计——与履约画像同一批凭据）。
 */
async function insertOrder({ productId, slug, status, createdAgoMs, shippedAgoMs = null }) {
  seq += 1;
  const now = Date.now();
  const created = now - createdAgoMs;
  const row = await insertOrderRow(db, {
    productId,
    productSlug: slug,
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    amountWei: '1000',
    usdtMicro: 1000000,
    btyUsdtRate: '0.1',
    status,
    escrowOrderId: `0x${String(seq).padStart(64, '0')}`,
    paidTxHash: `0x${String(seq).padStart(64, 'a')}`,
    shippedAt: shippedAgoMs === null ? null : new Date(now - shippedAgoMs),
    holdQty: 1,
    updatedAt: new Date(created),
    // 托管入账时刻（承诺对账与履约画像共用的锚点）：事件史里的 at 是**毫秒读数**，不是 DATETIME 列
    events: [{ name: 'OrderCreated', txHash: '0x' + 'f'.repeat(64), block: 1, at: created }],
  });
  return row.orderNo;
}

const slaOf = async () => {
  const res = await request(app).get('/api/shop/sla').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(res);
  return res.body.data;
};

test('没声明承诺的商品不在清单里；未上架的也不算（草稿声明了也不出现）', async () => {
  await post(productPayload({ title: '承诺对账·没声明', capacity: 5 }));
  await post(productPayload({ kind: 'physical', title: '承诺对账·草稿声明了', terms: { handling_days: 1 }, capacity: 5, active: false }));
  const data = await slaOf();
  assert.equal(data.promises.some((p) => p.title.includes('没声明')), false, '没声明就没有可对账的东西');
  assert.equal(data.promises.some((p) => p.title.includes('草稿声明了')), false, '未上架商品不进承诺对账');
  assert.equal(data.promiseWindowDays, 30, '实况窗口随读数下发（界面要写"近 N 天"）');
});

test('在途超承诺：数字 + 最久等了多久；已终结的单不算"还没发货"', async () => {
  const p = await post(
    productPayload({ kind: 'physical', title: '承诺对账·在途', terms: { handling_days: 1 }, capacity: 10 })
  );
  const { id } = await rowOf(p.slug);
  // ① 在途、已等 2 天（承诺 1 天）→ 超期
  await insertOrder({ productId: id, slug: p.slug, status: 'escrowed', createdAgoMs: 2 * DAY });
  // ② 在途、已等 6 小时 → 未超期
  await insertOrder({ productId: id, slug: p.slug, status: 'escrowed', createdAgoMs: 6 * 3600 * 1000 });
  // ③ 已取消（等再久也不算"还没发货"）
  const cancelled = await insertOrder({ productId: id, slug: p.slug, status: 'cancelled', createdAgoMs: 9 * DAY });
  await db.run('UPDATE orders SET hold_qty = 0, released_at = ? WHERE order_no = ?', new Date(), cancelled);

  const row = (await slaOf()).promises.find((x) => x.slug === p.slug);
  assert.ok(row, '声明了承诺且已上架 ⇒ 必须出现在清单里');
  assert.equal(row.handlingDays, 1);
  assert.equal(row.overdueOrders, 1, '只有第 ① 单超承诺：取消单不算、未超期的不算');
  assert.ok(row.overdueWorstMs >= 2 * DAY - 60_000 && row.overdueWorstMs <= 2 * DAY + 60_000, '最久已等约 2 天');
  assert.equal(row.sampleCount, 0, '还没有已交付样本');
  assert.equal(row.medianMs, null, '样本不足时中位数是 null，不是 0');
});

test('已交付实况：样本量照给、样本 <5 不下发中位数、超承诺单数与占比如实', async () => {
  const p = await post(
    productPayload({ kind: 'physical', title: '承诺对账·实况', terms: { handling_days: 1 }, capacity: 50 })
  );
  const { id } = await rowOf(p.slug);
  /*
    两条已交付样本（走 shipped_at，与实物单同一条路径）：
      · 甲：下单 → 发货 0.5 天（未超承诺 1 天）
      · 乙：下单 → 发货 3 天（超承诺）
    耗时统计的口径是「托管入账时刻 → 交付时刻」，所以 created_at 就是托管锚点。
  */
  await insertOrder({ productId: id, slug: p.slug, status: 'shipped', createdAgoMs: 4 * DAY, shippedAgoMs: 3.5 * DAY });
  await insertOrder({ productId: id, slug: p.slug, status: 'shipped', createdAgoMs: 5 * DAY, shippedAgoMs: 2 * DAY });

  const row = (await slaOf()).promises.find((x) => x.slug === p.slug);
  assert.equal(row.sampleCount, 2, '两条窗口内已交付');
  assert.equal(row.sampleTooSmall, true, `样本 < ${5} 单：如实标注`);
  assert.equal(row.medianMs, null, '样本不足不给中位数（"样本不足"不是"0 小时"）');
  assert.equal(row.lateCount, 1, '乙超承诺（3 天 > 1 天），甲没有');
  assert.equal(row.lateRate, 0.5, '占比按样本算（1/2）');
  assert.equal(row.overdueOrders, 0, '两条都已交付 ⇒ 没有在途超承诺');
  assert.equal(row.overdueWorstMs, null);
});

test('与履约画像同一批样本：同一条订单在两个读数里的耗时相同', async () => {
  const rep = await request(app).get('/api/shop/reputation').expect(200);
  assertOk(rep);
  const delivery = rep.body.data.delivery?.d30 ?? rep.body.data.delivery?.all;
  assert.ok(delivery && delivery.count >= 2, '本文件造的两条已交付样本必须进履约画像（同一批样本）');
  const median = delivery.medianMs;
  assert.ok(Number.isFinite(median) && median > 0, '履约画像的中位数照给（它的显示策略与 SLA 不同，见 opsMetrics 的说明）');
});
