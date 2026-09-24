/**
 * 订单草稿取消/发货防呆（联邦公开部署加固）：
 *  - v2 数量模型：同买家同商品可多次购买（orderId = keccak(快照,卖家,买家,草稿 UUID)
 *    ——UUID 随机化：无链上预占、无共享单号混行概念）；
 *  - 取消（POST /:id/cancel）：买家本人/店主可取消 draft 或无支付凭证的 escrowed
 *    异常单；已上链托管（有凭证）不可本地取消（资金在链上，走退款/争议/超时流程）；
 *    取消释放占位库存；escrowed 无凭证单取消前查链上防误取消真单（P1-3）；
 *  - 发货防呆（POST /:id/ship）：paid_tx_hash 为空的 escrowed 单拒绝发货（防白送
 *    货物/码），提示先同步；店主可取消异常单清理，真单不受影响。
 * 状态推进不经真实链上（单测无 RPC）——与 watcher 测试同款：直调 applyEvent/直改 DB。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { assertOk, login, makeCtx, productPayload, skuInv } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();
// 同买家同商品可多次购买（v2：orderId 含 UUID 随机化，无共享单号概念）
const buyer2 = Wallet.createRandom();
// 模拟链上规范哈希
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

let ownerToken;
let buyerToken;
let strangerToken;

const { applyEvent } = await import('../src/escrowWatcher.js');

const availOf = (slug) => {
  const r = skuInv(db, slug);
  return r.capacity === null ? null : Math.max(0, r.capacity - (r.committed || 0));
};

/** 上架商品（owner）并返回产物 */
async function listProduct(payload) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(payload)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 下单草稿（返回响应体 data）；店主代买家下单 */
async function createDraft(slug, who = buyer.address) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ productSlug: slug, buyer: who })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/**
 * 数据完整性回归（2026-09）：`escrow_order_id` 现在有**唯一索引**——「一单一号」是 watcher 按
 * orderId 回写、对账、事件去重的根基，重复单号会让一个链上事件同时改多行（占位重复回补/重复计数）。
 * 历史上曾有「共享 orderId 的存量幽灵行」这类脏数据用例，现由唯一索引在写入时就拦住，
 * 那些用例连同 helper 一并删除（不再存在这种状态）。
 */
test('托管单号唯一：重复 escrow_order_id 在写入时即被拒绝', () => {
  const now = Date.now();
  const orderIdHex = '0x' + '5'.repeat(64);
  const ins = db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, cny_fen, status, escrow_order_id, created_at, updated_at)
     VALUES (?, 'p-uniq', '{}', '0x00', '', ?, ?, '1000000000000000000', 100, 'draft', ?, ?, ?)`
  );
  ins.run(`uniq-a-${now}`, buyer.address.toLowerCase(), owner.address.toLowerCase(), orderIdHex, now, now);
  assert.throws(
    () => ins.run(`uniq-b-${now}`, buyer.address.toLowerCase(), owner.address.toLowerCase(), orderIdHex, now, now),
    /UNIQUE|constraint/i,
    '同一 escrow_order_id 不得落两行'
  );
  // 唯一索引是**部分索引**：未上链草稿（escrow_order_id 为 NULL）不受约束
  const draftIns = db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, cny_fen, status, escrow_order_id, created_at, updated_at)
     VALUES (?, 'p-uniq', '{}', '0x00', '', ?, ?, '1000000000000000000', 100, 'draft', NULL, ?, ?)`
  );
  draftIns.run(`uniq-c-${now}`, buyer.address.toLowerCase(), owner.address.toLowerCase(), now, now);
  draftIns.run(`uniq-d-${now}`, buyer.address.toLowerCase(), owner.address.toLowerCase(), now, now);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM orders WHERE product_slug = 'p-uniq' AND escrow_order_id IS NULL").get().c,
    2,
    'NULL 单号不参与唯一约束（草稿期尚未生成链上单号）'
  );
});

function rowOf(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  strangerToken = (await login(ctx, stranger)).token;
  assert.ok(ownerToken && buyerToken && strangerToken);
});

// ── 多次购买（v2：UUID 随机化 orderId）──

test('同买家同商品可多次购买：每单独立 orderId，草稿互不影响', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '多购-进行中商品' }));
  const d1 = await createDraft(p.slug);
  const d2 = await createDraft(p.slug); // 同买家同商品再下一单（v2 不再拦截）

  assert.notEqual(d1.escrowOrderId, d2.escrowOrderId, 'UUID 随机化：每单独立的链上 orderId（无链上预占/共享单号）');
  assert.notEqual(d1.id, d2.id);
  assert.equal(rowOf(d1.id).status, 'draft', '原草稿不受影响');
  assert.equal(rowOf(d2.id).status, 'draft');
  assert.equal(availOf(p.slug), null, '不限量商品无占位纠缠');
});

test('已成交终态（confirmed）后同买家同商品仍可再次购买（单号互不冲突）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '多购-已成交商品' }));
  const d1 = await createDraft(p.slug);
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), d1.id);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: d1.escrowOrderId }, { txHash: payHash(), block: 1 }), 1);

  const d2 = await createDraft(p.slug); // 已成交后仍可再购（v2 需求：同一商品可反复购买）
  assert.notEqual(d1.escrowOrderId, d2.escrowOrderId, '新单独立 orderId，与已成交单互不冲突');
  assert.equal(rowOf(d1.id).status, 'confirmed', '已成交单不受影响');
});

// ── 取消（N2）──

test('买家取消自己的草稿：占位回补；取消后可重新下单（cancelled 放行）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '取消草稿商品', capacity: 1 }));
  const d = await createDraft(p.slug);
  assert.equal(availOf(p.slug), 0, '下单占位');

  // 第三人取消 → 403；匿名 → 401
  await request(app).post(`/api/orders/${d.id}/cancel`).expect(401);
  const third = await request(app)
    .post(`/api/orders/${d.id}/cancel`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .expect(403);

  // 买家本人取消 → cancelled 且占位回补
  const res = await request(app)
    .post(`/api/orders/${d.id}/cancel`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.status, 'cancelled');
  assert.equal(availOf(p.slug), 1, '取消后占位回补');

  // cancelled 是本地终态：再次取消被拒
  const again = await request(app)
    .post(`/api/orders/${d.id}/cancel`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  assert.notEqual(again.body.code, 0);

  // 取消后可重新下单（同买家同商品——v2 每单独立 orderId）
  const d2 = await createDraft(p.slug);
  assert.notEqual(d2.escrowOrderId, d.escrowOrderId, 'UUID 随机化：新草稿独立 orderId');
  assert.equal(availOf(p.slug), 0, '重下再次占位');
});

test('店主可取消任意买家草稿（误下单/占坑清理）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '店主取消商品', capacity: 1 }));
  const d = await createDraft(p.slug, buyer2.address);
  const res = await request(app)
    .post(`/api/orders/${d.id}/cancel`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.status, 'cancelled');
  assert.equal(availOf(p.slug), 1, '店主取消同样回补占位');
});

test('已上链托管（有支付凭证）的 escrowed 不可本地取消（资金在链上，走争议/超时）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '不可取消商品' }));
  const d = await createDraft(p.slug);
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), d.id);

  const res = await request(app)
    .post(`/api/orders/${d.id}/cancel`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /不可取消/);
  assert.equal(rowOf(d.id).status, 'escrowed', '有凭证托管单不得被本地取消');
});

// ── 发货防呆（N3）与幽灵行清理 ──

test('发货防呆：escrowed 无支付凭证 → 拒绝发货并提示同步；店主可取消该异常单', async () => {
  const p = await listProduct(productPayload({ kind: 'digital', title: '防呆-幽灵单商品' }));
  const d = await createDraft(p.slug, buyer2.address);
  // 模拟幽灵单：被 watcher 推进为 escrowed 但从未落支付凭证（共享 orderId 的重复草稿）
  db.prepare("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE id = ?").run(Date.now(), d.id);
  assert.equal(rowOf(d.id).paid_tx_hash, null);

  const ownerLogin = await login(ctx, owner);
  const ship = await request(app)
    .post(`/api/orders/${d.id}/ship`)
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ deliveryCode: 'GHOST-CODE' })
    .expect(200);
  assert.notEqual(ship.body.code, 0, '无凭证单不得发货');
  assert.match(ship.body.message, /缺少链上支付凭证/, '提示先同步补齐');
  assert.equal(rowOf(d.id).status, 'escrowed', '拒绝发货不改变状态');

  // 店主清理：取消无凭证异常单
  const cancel = await request(app)
    .post(`/api/orders/${d.id}/cancel`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(cancel);
  assert.equal(cancel.body.data.status, 'cancelled');
});
