/**
 * P1：**批量发货必须以 `changes` 对齐实际认领的行**。
 *
 * `okIds` 来自"闸之前的本地读 + 一次链上 RPC"；从读到 UPDATE 之间隔着一次 RPC 往返。
 * 旧实现用一条 `IN (…) AND status='escrowed'` 的 UPDATE，然后无论 `changes` 是多少，
 * 都把 `okIds` 全量回报为"已发货 N 单"并逐单发 `order.shipped` 通知——被并发取消/退款/
 * 另一店员先发货的单会得到一条与事实相反的通知，店主以为发出去了、买家却查不到。
 *
 * 现在逐行条件更新（外加与单发 `/ship` 相同的 `paid_tx_hash` EXISTS 守卫），
 * 只有 `changes === 1` 的行进 `shipped` 并触发通知；未认领的行进 `failed` 并说明原因。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const { setChainOrderFetcher } = await import('../src/chainOrder.js');

const ZERO = '0x0000000000000000000000000000000000000000';
let ownerToken;
let buyerToken;
let product;

const asOwner = (r) =>
  r.set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value);

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'physical', title: '批量发货对齐探针' }))
    .expect(200);
  assertOk(res);
  product = res.body.data;
});

after(() => setChainOrderFetcher(null));

let seq = 0;

/** 建单并直接置 escrowed + 支付凭证（模拟 watcher/paid 已回写，跳过真实链上） */
async function escrowedOrder() {
  const draft = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: product.slug })
    .expect(200);
  assertOk(draft);
  seq += 1;
  const hash = `0x${String(seq).padStart(64, 'c')}`;
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), draft.body.data.id);
  await db.run(
    'UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)',
    hash,
    draft.body.data.id
  );
  const row = await db.get('SELECT * FROM v_orders WHERE order_no = ?', draft.body.data.id);
  return row;
}

const chainTruthOf = (row) => ({
  buyer: row.buyer,
  seller: row.seller,
  amount: row.amount_wei,
  status: 'Created',
  refundRequested: false,
  timeoutBlocks: Number(row.timeout_blocks),
  // 与本地报价一致（不是零地址：bps=0 时链上仍存 host，交付闸按 (seller, host) 比店铺键）
  // 顶层 commissionTo 是订单身份的一部分（chainParamsMatch 读它），必须与嵌套那份同值
  commissionTo: String(row.commission_quoted_to ?? ZERO).toLowerCase(),
  commissionTerms: {
    commissionTo: String(row.commission_quoted_to ?? ZERO).toLowerCase(),
    commissionBps: Number(row.commission_quoted_bps) || 0,
  },
  refundedAmount: '0',
});

test('并发改走一单：只回报/落库真正认领的行，未认领行给出原因', async () => {
  const a = await escrowedOrder();
  const b = await escrowedOrder();

  // 闸按链上真值放行两单
  setChainOrderFetcher(async (orderId) => {
    const row = [a, b].find((r) => String(r.escrow_order_id).toLowerCase() === orderId);
    if (!row) throw new Error(`unit-test: 未预期的 orderId ${orderId}`);
    return chainTruthOf(row);
  });

  /*
    在批量 UPDATE 执行之前把 a 单改成 refunded（模拟另一店员/一次退款同步抢先）。
    这不是"改库存数据"：它精确落在"闸已经放行 → 落库前"的那个窗口里，
    旧实现下 UPDATE 的 `status='escrowed'` 守卫会不命中，但它仍然回报两单都已发货。
  */
  const original = db.run;
  let flipped = false;
  db.run = async function (sql, ...params) {
    if (!flipped && /UPDATE orders SET status = 'shipped'/.test(String(sql))) {
      flipped = true;
      await original.call(this, "UPDATE orders SET status = 'refunded', updated_at = ? WHERE order_no = ?", new Date(), a.order_no);
    }
    return original.call(this, sql, ...params);
  };

  let res;
  try {
    res = await asOwner(request(app).post('/api/orders/seller/batch-ship')).send({
      ids: [a.order_no, b.order_no],
      trackingNo: 'SF-ALIGN-1',
    });
  } finally {
    db.run = original;
  }

  assert.equal(res.status, 200);
  assertOk(res);
  assert.deepEqual(res.body.data.shipped, [b.order_no], '只回报真正认领的那一单（旧实现会回报两单）');
  assert.equal(res.body.data.failed.length, 1);
  assert.equal(res.body.data.failed[0].id, a.order_no);
  assert.match(String(res.body.data.failed[0].reason), /并发|未认领/, '未认领的行必须给出可读原因');
  assert.match(String(res.body.message), /已批量发货 1 单/);

  // 库里的状态与回报一致：a 仍是 refunded（不是 shipped），b 是 shipped 且有运单号
  assert.equal((await db.get('SELECT status FROM orders WHERE order_no = ?', a.order_no)).status, 'refunded');
  const bRow = await db.get('SELECT status, tracking_no FROM orders WHERE order_no = ?', b.order_no);
  assert.equal(bRow.status, 'shipped');
  assert.equal(bRow.tracking_no, 'SF-ALIGN-1');
});
