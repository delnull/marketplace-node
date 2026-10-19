/**
 * "一码一次"的**库侧判据**：`order_delivery_claims` + 两条触发器（见 db.js 的 DDL 与 TRIGGER_DDL）。
 *
 * 为什么不是给 `order_delivery_items` 直接加 `UNIQUE (order_id, kind, value)`：
 * 手动交付的每一行是"一件"，而 `value` 对**池内资源**才是标识，对"池外自由文本"只是说明。
 * 同一句说明写两行（例如同一份下载链接交付两件）是合法写入——naive 唯一键会让它在
 * **校验通过之后**被库拒掉（本仓最不该有的"通过了却存不下"）。
 * 所以约束只压在"这个值确实是本商品池里的一行"的交付行上，自由文本不受约束。
 *
 * 这个文件同时钉住代价的另一面：认领账必须跟着交付行移动（插入收、删除退、订单级联删）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, insertProduct, insertOrder } from './setup.mjs';

const ctx = await makeCtx();
const { db, owner, buyer } = ctx;

const BUYER = buyer.address.toLowerCase();
const SELLER = owner.address.toLowerCase();

async function setupDigital({ quantity = 1 } = {}) {
  const p = await insertProduct(db, { kind: 'digital', skus: [] });
  const o = await insertOrder(db, {
    status: 'shipped',
    productId: p.productId,
    productSlug: p.slug,
    quantity,
    buyer: BUYER,
    seller: SELLER,
    amountWei: '0',
    usdtMicro: 0,
  });
  return { product: p, order: o };
}

async function claimsOf(orderId) {
  return await db.all('SELECT kind, value FROM order_delivery_claims WHERE order_id = ? ORDER BY value', orderId);
}

test('同一单重复交付同一个池内码 ⇒ 落库这一步就失败（不再只靠调用点的条件 UPDATE）', async () => {
  const { product, order } = await setupDigital();
  await db.run("INSERT INTO product_codes (product_id, code, status) VALUES (?, 'CLAIM-POOL-1', 'used')", product.productId);
  await db.run(
    "INSERT INTO order_delivery_items (order_id, kind, value) VALUES (?, 'code', 'CLAIM-POOL-1')",
    order.orderId
  );
  assert.deepEqual(await claimsOf(order.orderId), [{ kind: 'code', value: 'CLAIM-POOL-1' }]);

  await assert.rejects(
    () =>
      db.run(
        "INSERT INTO order_delivery_items (order_id, kind, value) VALUES (?, 'code', 'CLAIM-POOL-1')",
        order.orderId
      ),
    (e) => e.code === 'ER_DUP_ENTRY',
    '同一单第二次交付同一个池内码必须在库里失败'
  );
  assert.equal((await claimsOf(order.orderId)).length, 1, '失败的那次不能留下认领');
});

test('池外自由文本重复（每行一件的说明型交付）**仍然合法**：那是唯一键被否掉的形状', async () => {
  const { order } = await setupDigital({ quantity: 2 });
  const insert = (v) =>
    db.run('INSERT INTO order_delivery_items (order_id, kind, value) VALUES (?, ?, ?)', order.orderId, 'code', v);
  await insert('SAME-NOTE');
  await insert('SAME-NOTE');
  assert.equal(
    (await db.all('SELECT id FROM order_delivery_items WHERE order_id = ?', order.orderId)).length,
    2,
    '自由文本重复两行必须存得下（naive UNIQUE(order_id,kind,value) 会把它挡成 500）'
  );
  assert.deepEqual(await claimsOf(order.orderId), [], '自由文本不是池内资源，不进认领账');
});

test('同一个池内码交付给**不同订单**不受认领账约束（跨单一次性是 product_codes 的职责）', async () => {
  const a = await setupDigital();
  const b = await setupDigital();
  await db.run("INSERT INTO product_codes (product_id, code, status) VALUES (?, 'CLAIM-SHARED', 'used')", a.product.productId);
  await db.run("INSERT INTO product_codes (product_id, code, status) VALUES (?, 'CLAIM-SHARED', 'used')", b.product.productId);
  const insert = (orderId) =>
    db.run("INSERT INTO order_delivery_items (order_id, kind, value) VALUES (?, 'code', 'CLAIM-SHARED')", orderId);
  await insert(a.order.orderId);
  await insert(b.order.orderId);
  assert.equal((await claimsOf(a.order.orderId)).length, 1);
  assert.equal((await claimsOf(b.order.orderId)).length, 1);
});

test('删掉交付行 ⇒ 认领跟着退回（唯一键不会变成"永远不能再交付"）', async () => {
  const { product, order } = await setupDigital();
  await db.run("INSERT INTO product_codes (product_id, code, status) VALUES (?, 'CLAIM-RETRACT', 'used')", product.productId);
  const insert = () =>
    db.run("INSERT INTO order_delivery_items (order_id, kind, value) VALUES (?, 'code', 'CLAIM-RETRACT')", order.orderId);
  await insert();
  await db.run("DELETE FROM order_delivery_items WHERE order_id = ? AND kind = 'code' AND value = 'CLAIM-RETRACT'", order.orderId);
  assert.deepEqual(await claimsOf(order.orderId), [], '删交付行必须退掉认领');
  await insert(); // 退回之后重新交付同一个码是允许的（认领账只表达"当前这一行在"）
  assert.equal((await claimsOf(order.orderId)).length, 1);
});

test('订单被删 ⇒ 交付行与认领一起级联消失', async () => {
  const { product, order } = await setupDigital();
  await db.run("INSERT INTO product_codes (product_id, code, status) VALUES (?, 'CLAIM-CASCADE', 'used')", product.productId);
  await db.run("INSERT INTO order_delivery_items (order_id, kind, value) VALUES (?, 'code', 'CLAIM-CASCADE')", order.orderId);
  await db.run('DELETE FROM orders WHERE id = ?', order.orderId);
  assert.equal((await claimsOf(order.orderId)).length, 0);
  assert.equal(
    (await db.get('SELECT COUNT(*) AS c FROM order_delivery_items WHERE order_id = ?', order.orderId)).c,
    0
  );
});
