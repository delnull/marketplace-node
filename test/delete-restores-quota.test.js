/**
 * **删除订单时配额必须还回去** —— 三条 `AFTER DELETE` 触发器的行为用例。
 *
 * ## 为什么需要它（这一条此前是静默的口径分叉）
 *
 * 配额计数器的"减量半边"全在触发器里，而那六条触发器**全是 `AFTER UPDATE` / `AFTER INSERT`**
 * （见 `db.js` 的 TRIGGER_DDL）——`DELETE` 一侧一条都没有。于是：
 *   · 删订单 ⇒ 交付行随外键级联删（`trg_delivery_pool_release` 自然不响应）
 *     ⇒ `products.reserved_codes` 只增不减，池"看起来永远是满的"；
 *   · 删 `draft` 订单 ⇒ `buyer_draft_quota` / `buyer_product_quota` 永久占着额度
 *     ⇒ 买家**再也建不了草稿**。
 *
 * 三条真实入口都会走到这里：草稿清扫、测试夹具、运维/直连 SQL 清理。
 * 而这两种症状都**不报错**：一个表现为"新单被判超卖"，另一个表现为"建单被拒"，
 * 库里都查不出原因。`schema-guard.test.js` 只证明"触发器写在源码里"，
 * 本文件证明"它真的把额度还回去了"——两件事必须都有。
 *
 * 判据刻意用**旧口径现算的真值**对拍（`pendingTruth` 就是当年那套
 * `SUM(quantity − 已交付行数)`），而不是"数字变成了多少"：计数器是实现，
 * 真值是不变量，只有对拍才拦得住"减多了"与"减少了"两种偏差。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { insertProduct, insertOrder, makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { db } = ctx;

const reservedOf = async (productId, col = 'reserved_codes') =>
  Number((await db.get(`SELECT ${col} AS v FROM products WHERE id = ?`, productId)).v);

/** 池内资源（本用例关心计数器，不关心导入接口） */
async function fillPool(productId, n, kind = 'digital') {
  const table = kind === 'digital' ? 'product_codes' : 'product_nft_tokens';
  const col = kind === 'digital' ? 'code' : 'token_id';
  for (let i = 0; i < n; i++) {
    await db.run(`INSERT INTO ${table} (product_id, ${col}) VALUES (?, ?)`, productId, `D-${i}`);
  }
}

/**
 * 该商品当前"真值"：**在途**订单尚未交付的件数合计（旧实现的现算口径）。
 *
 * 与 `pool-reserve-gate.test.js` 里同名函数逐字同源：它是**不变量**，
 * 计数器只是它的一个缓存。
 */
async function pendingTruth(productId, itemKind = 'code') {
  const r = await db.get(
    `SELECT COALESCE(SUM(GREATEST(o.quantity - (
              SELECT COUNT(*) FROM order_delivery_items d WHERE d.order_id = o.id AND d.kind = ?), 0)), 0) AS need
       FROM orders o WHERE o.product_id = ? AND o.status IN ('draft','escrowed','shipped','disputed')`,
    itemKind,
    productId
  );
  return Number(r.need);
}

/** 直接占位 + 落单（与下单路由同形：同一个事务里占位与插单；这里逐条执行，判据不依赖并发） */
async function orderWithHold(productId, { buyer, status = 'draft', quantity = 1, kind = 'digital' } = {}) {
  const col = kind === 'digital' ? 'reserved_codes' : 'reserved_tokens';
  await db.run(`UPDATE products SET ${col} = ${col} + ? WHERE id = ?`, quantity, productId);
  return await insertOrder(db, {
    buyer: buyer || Wallet.createRandom().address.toLowerCase(),
    seller: ctx.owner.address.toLowerCase(),
    productId,
    quantity,
    status,
  });
}

const draftQuotaOf = async (buyer) =>
  Number((await db.get('SELECT active_drafts AS v FROM buyer_draft_quota WHERE buyer = ?', buyer))?.v ?? 0);
const productQuotaOf = async (buyer, productId) =>
  Number((await db.get('SELECT units AS v FROM buyer_product_quota WHERE buyer = ? AND product_id = ?', buyer, productId))?.v ?? 0);

test('删在途订单 ⇒ 池占位还回去，且等于旧口径现算的真值（此前只增不减）', async () => {
  const p = await insertProduct(db, { skus: [{ key: '', priceUsdtMicro: 1_000_000 }], kind: 'digital', title: '删单还占位' });
  const productId = p.productId;
  await fillPool(productId, 10);

  const a = await orderWithHold(productId, { status: 'escrowed', quantity: 2 });
  const b = await orderWithHold(productId, { status: 'draft', quantity: 1 });
  assert.equal(await reservedOf(productId), 3, '两张单共占 3 件');
  assert.equal(await reservedOf(productId), await pendingTruth(productId), '前置：计数器与真值一致');

  // 删掉在途的那张（实付未交付）
  await db.run('DELETE FROM orders WHERE id = ?', a.orderId);
  assert.equal(await reservedOf(productId), 1, '在途单被删 ⇒ 它那 2 件占位必须还回去');
  assert.equal(await reservedOf(productId), await pendingTruth(productId), '删后仍须与真值相等');

  // 删掉草稿那张 —— 在途四态含 draft，所以同样要还
  await db.run('DELETE FROM orders WHERE id = ?', b.orderId);
  assert.equal(await reservedOf(productId), 0, '草稿被删 ⇒ 占位归零');
  assert.equal(await reservedOf(productId), await pendingTruth(productId));
});

test('删**已终结**订单 ⇒ 不重复减（终结那一刻已经结清过），只由在途那张决定计数', async () => {
  const p = await insertProduct(db, { skus: [{ key: '', priceUsdtMicro: 1_000_000 }], kind: 'digital', title: '终结单不重复减' });
  const productId = p.productId;
  await fillPool(productId, 10);

  /*
    在途单占 3；终结单（settled）**不占**——它离开在途四态时已经被 ④ 那条触发器结清过。
    这里手工把两张单的占位都加上去（模拟"下单时加过"），再把终结单删掉。

    正确的行为是**不动**计数器（`OLD.status` 不在在途四态里 ⇒ 触发器不动作）。
    若写成"无条件减"，终结单被删就会把在途单的占位一起减掉（`GREATEST` 夹到 0），
    那是**反方向的错账**（余量虚高 ⇒ 超卖），而且同样查不出来。
    所以这里断言的是"**没有变化**"，不是"减少"。
  */
  const live = await orderWithHold(productId, { status: 'escrowed', quantity: 3 });
  const done = await orderWithHold(productId, { status: 'settled', quantity: 2 });
  assert.equal(await reservedOf(productId), 5, '前置：两张单的占位都被手工加上去了');

  await db.run('DELETE FROM orders WHERE id = ?', done.orderId);
  assert.equal(await reservedOf(productId), 5, '终结单被删**不得减**（它早已结清；再减就是反方向的错账）');

  await db.run('DELETE FROM orders WHERE id = ?', live.orderId);
  assert.equal(await reservedOf(productId), 2, '在途单被删只还它自己那 3 件');
  assert.equal(await reservedOf(productId), await pendingTruth(productId) + 2, '剩下的 2 是那张终结单手工加的量，没有对应真值');
});

test('交付过的部分不重复还：删单只还「尚未交付」的件数（与 UPDATE 那一侧同一算式）', async () => {
  const p = await insertProduct(db, { skus: [{ key: '', priceUsdtMicro: 1_000_000 }], kind: 'digital', title: '删单只还剩余' });
  const productId = p.productId;
  await fillPool(productId, 10);

  const o = await orderWithHold(productId, { status: 'escrowed', quantity: 3 });
  /*
    交付一件。⚠️ `kind` 必须与商品池一致（这里是 `digital` ⇒ 交付行 `kind = 'code'`）：
    交付行那条触发器按 `IF(NEW.kind = 'code', 1, 0)` 选池，写成 `'nft'` 会去减 `reserved_tokens`
    而 `reserved_codes` 纹丝不动 —— 我第一版就是这么写的，于是断言红在一个**与被测行为无关**的地方。
  */
  await db.run("INSERT INTO order_delivery_items (order_id, kind, value) VALUES (?, 'code', 'K-1')", o.orderId);
  assert.equal(await reservedOf(productId), 2, '交付一件 ⇒ 占位减 1（既有触发器）');

  await db.run('DELETE FROM orders WHERE id = ?', o.orderId);
  assert.equal(await reservedOf(productId), 0, '删单时只剩 2 件未交付 ⇒ 至多还 2（不能还 3）');
  assert.equal(await reservedOf(productId), await pendingTruth(productId));
});

test('删草稿订单 ⇒ 两道免费草稿闸的额度都还回去（此前买家会被永久锁死）', async () => {
  const p = await insertProduct(db, { skus: [{ key: '', priceUsdtMicro: 1_000_000 }], kind: 'digital', title: '删草稿还额度' });
  const productId = p.productId;
  const buyer = Wallet.createRandom().address.toLowerCase();

  /*
    模拟"下单时加量"（加量在应用层，见 db.js 的不对称说明）：两张草稿 ⇒ 草稿闸 +2、商品闸 +2。
    然后删掉一张 —— 两条闸都必须各还一份。
  */
  await db.run('INSERT INTO buyer_draft_quota (buyer, active_drafts) VALUES (?, 2) ON DUPLICATE KEY UPDATE active_drafts = 2', buyer);
  await db.run('INSERT INTO buyer_product_quota (buyer, product_id, units) VALUES (?, ?, 2) ON DUPLICATE KEY UPDATE units = 2', buyer, productId);

  const o1 = await insertOrder(db, { buyer, seller: ctx.owner.address.toLowerCase(), productId, quantity: 1, status: 'draft' });
  const o2 = await insertOrder(db, { buyer, seller: ctx.owner.address.toLowerCase(), productId, quantity: 1, status: 'draft' });
  assert.equal(await draftQuotaOf(buyer), 2);
  assert.equal(await productQuotaOf(buyer, productId), 2);

  await db.run('DELETE FROM orders WHERE id = ?', o1.orderId);
  assert.equal(await draftQuotaOf(buyer), 1, '删一张草稿 ⇒ 草稿闸还一份（否则买家建单被永久拒绝）');
  assert.equal(await productQuotaOf(buyer, productId), 1, '商品级那道闸同样要还');

  await db.run('DELETE FROM orders WHERE id = ?', o2.orderId);
  assert.equal(await draftQuotaOf(buyer), 0);
  assert.equal(await productQuotaOf(buyer, productId), 0);
});

test('删**非草稿**订单 ⇒ 草稿闸不动（它当初就没加过量）', async () => {
  const p = await insertProduct(db, { skus: [{ key: '', priceUsdtMicro: 1_000_000 }], kind: 'digital', title: '非草稿不动草稿闸' });
  const productId = p.productId;
  const buyer = Wallet.createRandom().address.toLowerCase();

  // 一张 escrowed 单：草稿闸上不该有它的量（加量只发生在建草稿时）
  await db.run('INSERT INTO buyer_draft_quota (buyer, active_drafts) VALUES (?, 0) ON DUPLICATE KEY UPDATE active_drafts = 0', buyer);
  const o = await insertOrder(db, { buyer, seller: ctx.owner.address.toLowerCase(), productId, quantity: 1, status: 'escrowed' });
  await db.run('DELETE FROM orders WHERE id = ?', o.orderId);
  assert.equal(await draftQuotaOf(buyer), 0, '非草稿单被删不得动草稿闸（减到负数会撞 UNSIGNED 溢出，整条语句失败）');
});
