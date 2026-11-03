/**
 * 九个订单状态的**动作矩阵**：每个动作都在全部 9 个状态上跑一遍，而不是只跑正常路径。
 *
 * 订单状态是 `draft / escrowed / shipped / confirmed / disputed / settled / refunded / expired / cancelled`。
 * 这里钉住四条最容易在状态门控上漂移的动作：
 *   · 买家取消：只有 draft（历史异常 escrowed 无凭证另有出口，但本矩阵用有凭证的单，不能取消）；
 *   · 卖家发货：只有 escrowed 且链上仍在托管；
 *   · 买家评价：confirmed / settled / expired（入账终局）；
 *   · 买家改收货信息：只有 escrowed 实物单。
 *
 * 每个用例都新建订单，不复用上一格的状态，避免"上一条先改了状态，下一条才碰巧通过"。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, randomBytes, hexlify } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef, insertOrder } from './setup.mjs';
import { ORDER_STATUS } from '../src/orderStatus.js';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const host = owner;
let productSlug;
let hostToken;
let buyerToken;

const hex = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const escrowId = () => hexlify(randomBytes(32));
const paidHash = () => hexlify(randomBytes(32));
const snapshot = JSON.stringify({
  kind: 'physical',
  title: '状态矩阵实物商品',
  description: 'order-status-matrix',
  media: [],
  specs: [],
  skus: [{ key: '', priceUsdtMicro: 1_000_000, capacity: null }],
});

before(async () => {
  hostToken = (await login(ctx, host)).token;
  buyerToken = (await login(ctx, buyer)).token;
  const p = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${hostToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'physical', title: '状态矩阵实物商品' }));
  assertOk(p);
  productSlug = p.body.data.slug;
});

async function makeOrder(status) {
  const shipped = status === 'shipped' || status === 'confirmed';
  const o = await insertOrder(db, {
    buyer: buyer.address.toLowerCase(),
    seller: host.address.toLowerCase(),
    status,
    productSlug,
    productSnapshot: snapshot,
    snapshotHash: hex(1),
    amountWei: '1000000000000000000',
    usdtMicro: 1_000_000,
    timeoutBlocks: 120_960,
    escrowOrderId: escrowId(),
    paidTxHash: status === 'draft' ? undefined : paidHash(),
    shippingName: '矩阵买家',
    shippingPhone: '13800000000',
    shippingAddress: '矩阵地址 1 号',
    ...(shipped ? { shippedAt: new Date(), trackingNo: 'SF1234567890', carrier: '顺丰' } : {}),
  });
  // 评价要落 product_id；insertOrder 是通用夹具，不替调用方猜商品行，这里显式补上。
  const product = await db.get('SELECT id FROM products WHERE slug = ?', productSlug);
  await db.run('UPDATE orders SET product_id = ? WHERE id = ?', product.id, o.orderId);
  return o;
}

function buyerAs(path) {
  return request(app)[path.method](path.url).set('Authorization', `Bearer ${buyerToken}`);
}
function hostAs(path) {
  return request(app)[path.method](path.url)
    .set('Authorization', `Bearer ${hostToken}`)
    .set('X-Mk-Shop', shopRef.value);
}

test('取消：仅 draft 可取消，其余 8 个状态全部拒绝', async () => {
  for (const status of ORDER_STATUS) {
    const o = await makeOrder(status);
    const res = await buyerAs({ method: 'post', url: `/api/orders/${o.orderNo}/cancel` });
    if (status === 'draft') {
      assert.equal(res.status, 200, `draft: ${res.status} ${res.body.message || ''}`);
      assertOk(res);
      assert.equal(res.body.data.status, 'cancelled');
    } else {
      assert.notEqual(res.body.code, 0, `${status} 不应可取消：${res.body.message || ''}`);
    }
  }
});

test('发货：仅 escrowed 可发货，其余 8 个状态全部拒绝', async () => {
  for (const status of ORDER_STATUS) {
    const o = await makeOrder(status);
    const res = await hostAs({ method: 'post', url: `/api/orders/${o.orderNo}/ship` }).send({ trackingNo: 'SF-MATRIX-1' });
    if (status === 'escrowed') {
      assert.equal(res.status, 200, `escrowed: ${res.status} ${res.body.message || ''}`);
      assertOk(res);
      assert.equal(res.body.data.status, 'shipped');
    } else {
      assert.notEqual(res.body.code, 0, `${status} 不应可发货：${res.body.message || ''}`);
    }
  }
});

test('评价：仅 confirmed / settled / expired 可评价，其余 6 个状态全部拒绝', async () => {
  const reviewable = new Set(['confirmed', 'settled', 'expired']);
  for (const status of ORDER_STATUS) {
    const o = await makeOrder(status);
    const res = await buyerAs({ method: 'post', url: `/api/orders/${o.orderNo}/review` }).send({
      rating: 5,
      content: `状态矩阵评价 ${status}`,
    });
    if (reviewable.has(status)) {
      assert.equal(res.status, 200, `${status}: ${res.status} ${res.body.message || ''}`);
      assertOk(res);
    } else {
      assert.notEqual(res.body.code, 0, `${status} 不应可评价：${res.body.message || ''}`);
    }
  }
});

test('改收货信息：仅 escrowed 实物单可改，其余 8 个状态全部拒绝', async () => {
  for (const status of ORDER_STATUS) {
    const o = await makeOrder(status);
    const res = await buyerAs({ method: 'patch', url: `/api/orders/${o.orderNo}/shipping` }).send({
      name: '新收货人',
      phone: '13900000000',
      address: '新地址 2 号',
    });
    if (status === 'escrowed') {
      assert.equal(res.status, 200, `escrowed: ${res.status} ${res.body.message || ''}`);
      assertOk(res);
    } else {
      assert.notEqual(res.body.code, 0, `${status} 不应可改收货信息：${res.body.message || ''}`);
    }
  }
});

test('状态计数与 PII 可擦标记覆盖全部 9 个状态', async () => {
  /*
    另建一批**不被上面动作改过**的订单，保证读回的就是写入时那个状态。
    计数端点与 piiErasable 都是前端按钮的取数入口；集合漂移会让按钮亮/灭错一格。
  */
  const rows = [];
  for (const status of ORDER_STATUS) rows.push({ status, o: await makeOrder(status) });

  const list = await hostAs({ method: 'get', url: '/api/orders/seller?pageSize=100' });
  assert.equal(list.status, 200);
  assertOk(list);
  const byNo = new Map(list.body.data.orders.map((o) => [o.id, o]));
  const erasable = new Set(['confirmed', 'settled', 'refunded', 'expired', 'cancelled']);
  for (const { status, o } of rows) {
    const got = byNo.get(o.orderNo);
    assert.ok(got, `卖家列表缺少 ${status} 的订单 ${o.orderNo}`);
    assert.equal(got.status, status, `${status} 读回状态`);
    assert.equal(got.piiErasable, erasable.has(status), `${status} 的 piiErasable`);
  }
});
