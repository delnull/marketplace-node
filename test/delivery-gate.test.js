/**
 * 交付闸（`chainOrder.deliveryGate`）——**三个手动交付入口与自动交付共用的唯一判据层**。
 *
 * 为什么单独立这个文件（2026-10-14）：本仓此前只有**自动**交付读链上真值，而
 * `POST /:id/ship`、`POST /seller/batch-ship`、`POST /:id/nft-deliveries` 三个手动入口看的是
 * 本地 `orders.refund_status` 镜像——那个镜像由 watcher 以 `head − finalityBlocks`（默认 12 块
 * ≈ 1 分钟）为上界回写，于是"买家托管后立刻 requestRefund"的那 12 块里它**必然**还是 `none`：
 * 判据落在镜像上，货就发出去了，而链上那笔钱被 `refundRequested` 永久挡住超时释放。
 * 真实链上复现过（演示栈：链上 Created + refundRequested=true，`POST /ship` 仍回 200 已标记发货）。
 *
 * 本文件钉住的就是那个窗口：**镜像说"没冻结"、链上说"已冻结"时，四个入口必须全部拒绝**；
 * 方向是 fail-closed（链上读不到也拒绝），并且"链上根本不是我这一单"（诱饵单）同样拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, makeCtx, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const { setChainOrderFetcher } = await import('../src/chainOrder.js');
const { tryAutoDeliverByEscrowOrder } = await import('../src/autoDeliver.js');

const ownerToken = (await login(ctx, owner)).token;

let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');
const escrowId = () => '0x' + String(1000 + ++seq).padStart(64, '0');

/** 直插一行"已托管"订单（快照形状由 kind 决定；这些用例只关心交付闸，不关心下单流程） */
function insertOrder({ slug, kind = 'digital', status = 'escrowed', refundStatus = 'none', qty = 1 }) {
  const now = Date.now();
  const id = `dg-${++seq}-${now}`;
  const oid = escrowId();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller, quantity,
       amount_wei, usdt_micro, status, escrow_order_id, paid_tx_hash, refund_status, created_at, updated_at)
     VALUES (?, ?, ?, '0x00', '', ?, ?, ?, '1000000000000000000', 1000000, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    slug,
    JSON.stringify({ kind, title: `闸用例商品 ${slug}`, slug }),
    buyer.address.toLowerCase(),
    owner.address.toLowerCase(),
    qty,
    status,
    oid,
    payHash(),
    refundStatus,
    now,
    now
  );
  return { id, escrowOrderId: oid };
}

const rowOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const codeStats = (productId) =>
  db.prepare("SELECT COUNT(*) AS c FROM product_codes WHERE product_id = ? AND status = 'unused'").get(productId).c;

/** 装"链上就是这一单"的读数桩（默认全绿），over 覆盖任意字段 */
const chainSays = (over = {}) =>
  setChainOrderFetcher(async (orderIdHex) => {
    const row = db
      .prepare('SELECT buyer, seller, amount_wei FROM orders WHERE escrow_order_id = ?')
      .get(String(orderIdHex || '').toLowerCase());
    if (!row) throw new Error('链上没有这一单');
    return {
      status: 'Created',
      refundRequested: false,
      refundRejected: false,
      refundedAmount: '0',
      buyer: row.buyer,
      seller: row.seller,
      amount: row.amount_wei,
      ...over,
    };
  });

const ship = (id, body = { trackingNo: 'SF123' }) =>
  request(app).post(`/api/orders/${id}/ship`).set('Authorization', `Bearer ${ownerToken}`).send(body);
const batchShip = (ids) =>
  request(app).post('/api/orders/seller/batch-ship').set('Authorization', `Bearer ${ownerToken}`).send({ ids, trackingNo: 'SF123' });
const nftDeliver = (id) =>
  request(app)
    .post(`/api/orders/${id}/nft-deliveries`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ deliveries: [{ tokenId: '1', txHash: '0x' + 'a'.repeat(64) }] });

/* ══════════════════════════════════════════════════════════════════════
   ① 核心回归：镜像滞后窗口（本地 none / 链上 refundRequested=true）
   ══════════════════════════════════════════════════════════════════════ */

test('镜像还没跟上（refund_status=none）而链上已冻结时：/ship 必须拒绝', async () => {
  const { id } = insertOrder({ slug: 'dg-phys-1', kind: 'physical' });
  assert.equal(rowOf(id).refund_status, 'none', '前置：镜像滞后（这正是缺陷窗口）');
  chainSays({ refundRequested: true });

  const res = await ship(id);
  assert.notEqual(res.body.code, 0, '链上已冻结 ⇒ 不得发货');
  assert.match(res.body.message, /申请退款|冻结/);
  assert.equal(rowOf(id).status, 'escrowed', '状态一个字节都不许动（这一单没有交付）');
});

test('镜像滞后而链上已冻结时：/seller/batch-ship 必须整单列入 failed（不得半发）', async () => {
  const a = insertOrder({ slug: 'dg-phys-2', kind: 'physical' });
  const b = insertOrder({ slug: 'dg-phys-3', kind: 'physical' });
  chainSays({ refundRequested: true });

  const res = await batchShip([a.id, b.id]);
  assert.equal(res.body.code, 0, '批量接口本身成功返回（逐单给结果）');
  assert.equal(res.body.data.shipped.length, 0, '两单都不许发出去');
  assert.equal(res.body.data.failed.length, 2);
  for (const f of res.body.data.failed) assert.match(f.reason, /申请退款|冻结/);
  assert.equal(rowOf(a.id).status, 'escrowed');
  assert.equal(rowOf(b.id).status, 'escrowed');
});

test('镜像滞后而链上已冻结时：/:id/nft-deliveries 必须拒绝', async () => {
  const { id } = insertOrder({ slug: 'dg-nft-1', kind: 'nft' });
  chainSays({ refundRequested: true });

  const res = await nftDeliver(id);
  assert.notEqual(res.body.code, 0, '链上已冻结 ⇒ 不得登记 NFT 交付');
  assert.match(res.body.message, /申请退款|冻结/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM order_delivery_items WHERE order_id = ?").get(id).c,
    0,
    '没有落任何交付行'
  );
});

test('镜像滞后而链上已冻结时：自动交付同样不发码（同一判据）', async () => {
  const made = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ kind: 'digital', title: '闸用例数字商品' }))
    .expect(200);
  const slug = made.body.data.slug;
  await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['DG-CODE-1'] })
    .expect(200);

  const o = insertOrder({ slug, kind: 'digital' });
  db.prepare('UPDATE orders SET product_id = (SELECT id FROM products WHERE slug = ?) WHERE id = ?').run(slug, o.id);
  const pid = db.prepare('SELECT id FROM products WHERE slug = ?').get(slug).id;

  chainSays({ refundRequested: true });
  const delivered = await tryAutoDeliverByEscrowOrder(o.escrowOrderId);
  assert.equal(delivered, false, '链上已冻结 ⇒ 自动交付不发码');
  assert.equal(rowOf(o.id).status, 'escrowed');
  assert.equal(codeStats(pid), 1, '码仍在池里（没有被占用/核销）');
});

/* ══════════════════════════════════════════════════════════════════════
   ①b **反方向**：镜像说"冻结"、链上说"已解冻"时，交付必须照常放行
   （判据是链上真值，不是镜像——镜像在 rejectRefund 之后、或 RefundRejected
     事件漏扫/被隔离时会长期停在 requested；那时按镜像判 = 第二个答案层，
     表现为"同一时刻自动交付拒绝、手动发货放行"，2026-10-15 的评审实测出来的）
   ══════════════════════════════════════════════════════════════════════ */

test('镜像停在 requested 而链上已解冻：/ship 必须放行（不许拿镜像挡合法交付）', async () => {
  const { id } = insertOrder({ slug: 'dg-phys-9', kind: 'physical', refundStatus: 'requested' });
  assert.equal(rowOf(id).refund_status, 'requested', '前置：镜像停在"待处理"');
  chainSays({ refundRequested: false, refundRejected: true }); // 卖家已链上拒绝

  const res = await ship(id);
  assert.equal(res.body.code, 0, `链上没冻结就该能发货，实际：${JSON.stringify(res.body)}`);
  assert.equal(rowOf(id).status, 'shipped');
});

test('镜像停在 requested 而链上已解冻：自动交付同样照发（两个路径不许有两个答案）', async () => {
  const made = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ kind: 'digital', title: '闸用例数字商品B' }))
    .expect(200);
  const slug = made.body.data.slug;
  await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['DG-CODE-2'] })
    .expect(200);

  const o = insertOrder({ slug, kind: 'digital', refundStatus: 'requested' });
  db.prepare('UPDATE orders SET product_id = (SELECT id FROM products WHERE slug = ?) WHERE id = ?').run(slug, o.id);
  const pid = db.prepare('SELECT id FROM products WHERE slug = ?').get(slug).id;

  chainSays({ refundRequested: false, refundRejected: true });
  const delivered = await tryAutoDeliverByEscrowOrder(o.escrowOrderId);
  assert.equal(delivered, true, '链上没冻结 ⇒ 自动交付照发（本地镜像不参与判定）');
  assert.equal(rowOf(o.id).status, 'shipped');
  assert.equal(codeStats(pid), 0, '码已被本单占用');
});

/* ══════════════════════════════════════════════════════════════════════
   ② 方向：fail-closed 与"链上不是我这一单"
   ══════════════════════════════════════════════════════════════════════ */

test('链上读不到（RPC 故障）⇒ 拒绝交付，而不是退回镜像放行', async () => {
  const { id } = insertOrder({ slug: 'dg-phys-4', kind: 'physical' });
  setChainOrderFetcher(() => {
    throw new Error('ECONNREFUSED 127.0.0.1:8545');
  });

  const res = await ship(id);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /读不到链上托管状态/);
  assert.equal(rowOf(id).status, 'escrowed');
});

test('链上已不在托管中（Settled/Disputed/Refunded）⇒ 拒绝交付', async () => {
  for (const status of ['Settled', 'Disputed', 'Refunded']) {
    const { id } = insertOrder({ slug: `dg-phys-${status}`, kind: 'physical' });
    chainSays({ status });
    const res = await ship(id);
    assert.notEqual(res.body.code, 0, `${status} 不得发货`);
    assert.match(res.body.message, /已不在「托管中」/);
    assert.equal(rowOf(id).status, 'escrowed');
  }
});

test('链上同单号的买家/卖家/金额与本单不符（诱饵单）⇒ 拒绝交付', async () => {
  const { id } = insertOrder({ slug: 'dg-phys-5', kind: 'physical' });
  chainSays({ amount: '1' }); // 1 wei 的假单
  const res = await ship(id);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /诱饵单/);
  assert.equal(rowOf(id).status, 'escrowed');
});

test('订单没有链上托管单号 ⇒ 拒绝交付（无法核验就不交付）', async () => {
  const { id } = insertOrder({ slug: 'dg-phys-6', kind: 'physical' });
  db.prepare('UPDATE orders SET escrow_order_id = NULL WHERE id = ?').run(id);
  chainSays();
  const res = await ship(id);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /还没有链上托管单号/);
});

/* ══════════════════════════════════════════════════════════════════════
   ③ 反向：正常路径不许被这道闸堵死（含"拒绝退款后恢复可交付"）
   ══════════════════════════════════════════════════════════════════════ */

test('链上 Created 且未申请退款 ⇒ 正常发货（闸不拦正常路径）', async () => {
  const { id } = insertOrder({ slug: 'dg-phys-7', kind: 'physical' });
  chainSays();
  const res = await ship(id);
  assert.equal(res.body.code, 0, res.body.message);
  assert.equal(rowOf(id).status, 'shipped');
});

test('卖家已拒绝退款（refundRejected=true 而 refundRequested=false）⇒ 恢复可交付', async () => {
  const { id } = insertOrder({ slug: 'dg-phys-8', kind: 'physical', refundStatus: 'rejected' });
  chainSays({ refundRequested: false, refundRejected: true });
  const res = await ship(id);
  assert.equal(res.body.code, 0, res.body.message);
  assert.equal(rowOf(id).status, 'shipped');
});
