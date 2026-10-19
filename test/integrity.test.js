/**
 * 交付一致性体检（`src/integrity.js`）的回归测试。
 *
 * 对应源码评审 2026-09 的 P0-2：`escrowWatcher` 只 UPDATE 已有行（全仓唯一 `INSERT INTO orders`
 * 在建草稿），所以**备份点之后新建的订单永远不会被回填**；而 `product_codes.status` 的默认值是
 * `'unused'`，恢复旧库会把已发出的码打回未用态 ⇒ **同一个码可能被再发一次**（链上资金是真的）。
 * 这条防线就是要在事后能查出"交付行与池状态对不上"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, shopRef, insertOrder as insertOrderRow, TEST_SHOP_CODE } from './setup.mjs';

const ctx = await makeCtx();
const { db, owner, buyer } = ctx;

const { findIntegrityIssues } = await import('../src/integrity.js');

const PRODUCT_ID = 990001;

/**
   * 造一个商品 + 一笔订单（直接插行：本用例测的是体检判据，不是下单流程）。
   *
   * 返回 `{ orderId, orderNo }`：`orderId` 是**内部主键**（`product_codes.order_id` /
   * `order_delivery_items.order_id` 都是指向它的外键），`orderNo` 是**对外订单号**——
   * 体检报告里的 `orderId` 字段给的是后者（见 src/integrity.js 的文件头：内部键不出本节点，
   * 而报告是给运维照着去订单详情核对用的）。
   *
   * 商品按**固定 id** 造：体检判据按 product_id 关联池与交付行，随机 id 会让"同一个商品跨用例复用"
   * 这件事说不清。所以这里保留显式 id 的 INSERT（`insertProduct` 走自增，不适用），但形状必须与
   * 建表语句一致：`shop_code` 有外键（只能是测试店铺）、`slug` 是 CHAR(11)、`description` 无默认值。
   * 幂等用 `ON DUPLICATE KEY UPDATE id = id`（与 src/db.js 同款）：**不用** INSERT IGNORE——
   * 它会把外键违规、数据截断一并降级成警告，那是静默丢数据。
   */
  async function seed({ status = 'shipped', productId = PRODUCT_ID } = {}) {
    const slug = `P${String(productId).padStart(10, '0').slice(-10)}`; // P + 10 位数字（Crockford 合法字符）
    await db.run(`INSERT INTO products (id, slug, shop_code, title, description, kind, snapshot_hash)
       VALUES (?, ?, ?, ?, '', 'digital', '0x00')
       ON DUPLICATE KEY UPDATE id = id`, productId, slug, TEST_SHOP_CODE, `体检商品 ${productId}`);
    const row = await insertOrderRow(db, {
      status,
      productId,
      productSlug: slug,
      buyer: buyer.address.toLowerCase(),
      seller: owner.address.toLowerCase(),
      amountWei: '1',
      usdtMicro: 1,
    });
    /*
      夹具直接插一行 shipped 订单**绕过下单路径**，所以池占位计数器没有被加过；而
      integrity 现在会核对 "products.reserved_codes = 在途订单尚未交付的件数"（见 src/integrity.js ⑥）。
      夹具必须自己把这条不变量维护住，否则每个用例都会在账目检查上先红一次——
      那不是"体检误报"，是这个夹具造出了生产路径造不出的账。交付行插入时触发器会把它减回来。
    */
    await db.run('UPDATE products SET reserved_codes = reserved_codes + 1 WHERE id = ?', productId);
    return { orderId: row.orderId, orderNo: row.orderNo };
  }

  async function addCode(productId, code, status, orderId) {
    await db.run(`INSERT INTO product_codes (product_id, code, status, order_id, used_at)
       VALUES (?, ?, ?, ?, ?)`, productId, code, status, orderId, status === 'used' ? new Date() : null);
  }

  async function addDelivery(orderId, kind, value) {
    await db.run('INSERT INTO order_delivery_items (order_id, kind, value) VALUES (?, ?, ?)', orderId, kind, value);
  }

test('交付行与池状态自洽 ⇒ 无问题（正向基线：体检不能见谁都报）', async () => {
  const itOk = await seed();
  await addCode(PRODUCT_ID, 'IT-OK-CODE', 'used', itOk.orderId);
  await addDelivery(itOk.orderId, 'code', 'IT-OK-CODE');
  const { issues, counts } = await findIntegrityIssues(db);
  assert.equal(counts.codeDeliveredNotUsed, 0);
  assert.equal(counts.codeUsedWithoutDelivery, 0);
  assert.equal(issues.length, 0, `不该有噪声：${JSON.stringify(issues)}`);
});

test('恢复旧库的典型痕：已交付的码在池里回到 unused ⇒ 必须报出来（双交付风险）', async () => {
  const itReverted = await seed();
  await addCode(PRODUCT_ID, 'IT-REVERTED-CODE', 'unused', null); // 恢复后被回退的样子
  await addDelivery(itReverted.orderId, 'code', 'IT-REVERTED-CODE');
  const { issues, counts } = await findIntegrityIssues(db);
  assert.equal(counts.codeDeliveredNotUsed, 1);
  const hit = issues.find((i) => i.resource === 'IT-REVERTED-CODE');
  assert.ok(hit, '必须报出这个码');
  assert.equal(hit.orderId, itReverted.orderNo, '报告里的 orderId 是对外订单号（内部键不出本节点）');
  assert.match(hit.detail, /再发给别的买家/);
  // 报告里的码要打码（码是敏感资源，不能凭报告直接用）
  assert.ok(!hit.detail.includes('IT-REVERTED-CODE'), '报告不得打印码原文');
});

test('交付行指向的码在池里被挂到别的订单 ⇒ 报"状态/归属不符"', async () => {
  const itOwnerA = await seed();
  const itOwnerB = await seed();
  await addCode(PRODUCT_ID, 'IT-MOVED-CODE', 'used', itOwnerB.orderId); // 池说归 B，交付行说给了 A
  await addDelivery(itOwnerA.orderId, 'code', 'IT-MOVED-CODE');
  const { issues } = await findIntegrityIssues(db);
  const hit = issues.find((i) => i.resource === 'IT-MOVED-CODE' && i.orderId === itOwnerA.orderNo);
  assert.ok(hit, '归属不符必须报出');
  // detail 里的 `order_id=` 是**池里那一行的内部键**（提示运维直接按它去库里核对）
  assert.match(hit.detail, new RegExp(`order_id=${itOwnerB.orderId}`));
});

test('池里没有这个码（交付行还在）⇒ 报"池被重建/导入丢了"', async () => {
  const itOrphan = await seed();
  await addDelivery(itOrphan.orderId, 'code', 'IT-NO-POOL-ROW');
  const { issues } = await findIntegrityIssues(db);
  const hit = issues.find((i) => i.kind === 'code-delivered-without-pool-row');
  assert.ok(hit);
  assert.match(hit.detail, /没有这个码/);
});

test('池里标了 used 但没有交付行 ⇒ 报"交付记录被回退"', async () => {
  const itLost = await seed();
  await addCode(PRODUCT_ID, 'IT-LOST-ITEM', 'used', itLost.orderId); // 池说已交付
  // 故意不插交付行（同一进程里别的用例也留了同类痕，所以断言落在"这一单"上，而非总数）
  const { issues, counts } = await findIntegrityIssues(db);
  assert.ok(counts.codeUsedWithoutDelivery >= 1);
  const hit = issues.find((i) => i.kind === 'code-used-without-delivery' && i.orderId === itLost.orderNo);
  assert.ok(hit, '必须报出这一单');
  assert.match(hit.detail, /交付记录疑似被回退/);
});

/**
 * 串商品：交付行的码**不属于该订单商品的池** ⇒ 必须报出来。
 *
 * 判据由 ① 提供（`LEFT JOIN product_codes pc ON pc.product_id = o.product_id AND pc.code = di.value`，
 * `pc.id IS NULL` = "本商品的池里没有这个码"）。旧实现另有一条判据④
 * `JOIN product_codes pc ON pc.code = di.value WHERE pc.product_id != o.product_id`——
 * 它没限定商品，只要**别的池**里有同名字符串的码就命中，而 `(product_id, code)` 唯一约束
 * 允许同一码串存在于多个池（正常数据），于是自洽数据被判"错位"、`check:integrity` 退出码变 2，
 * 而工具的处置建议是"优先重建库"（会误删正常数据）。④ 已删除（源码审计 2026-09 复审，P2）。
 */
test('码不属于本商品的池却被交付 ⇒ 报"本商品的池里没有这个码"（串商品）', async () => {
  const OTHER = PRODUCT_ID + 1;
  const itCross = await seed({ productId: OTHER });
  await addCode(PRODUCT_ID, 'IT-CROSS-CODE', 'used', itCross.orderId); // 码属于 990001
  await addDelivery(itCross.orderId, 'code', 'IT-CROSS-CODE'); // 订单属于 990002
  const { issues, counts } = await findIntegrityIssues(db);
  assert.ok(counts.codeDeliveredNotUsed >= 1);
  const hit = issues.find((i) => i.kind === 'code-delivered-without-pool-row' && i.orderId === itCross.orderNo);
  assert.ok(hit, '必须报出这一单');
  assert.match(hit.detail, /没有这个码/);
});

/**
 * 反例守卫（同一次审计）：**同一个码串存在于两个商品的池里是合法数据**，
 * 只要订单自己那个商品的池里有它、且标 used、且指向本单，就不该报任何不一致。
 * 这条用例正是旧判据④的假阳性形状——它会把它判成 `code-product-mismatch`。
 */
test('同一码串存在于两个商品的池（合法）不得误报', async () => {
  const OTHER = PRODUCT_ID + 1;
  const itDupA = await seed({ productId: PRODUCT_ID });
  const itDupB = await seed({ productId: OTHER });
  await addCode(PRODUCT_ID, 'IT-DUP-CODE', 'used', itDupA.orderId);
  await addCode(OTHER, 'IT-DUP-CODE', 'used', itDupB.orderId); // 另一池里同名码，属正常
  await addDelivery(itDupA.orderId, 'code', 'IT-DUP-CODE');
  await addDelivery(itDupB.orderId, 'code', 'IT-DUP-CODE');
  const { issues } = await findIntegrityIssues(db);
  const hits = issues.filter((i) => i.orderId === itDupA.orderNo || i.orderId === itDupB.orderNo);
  assert.deepEqual(hits, [], `自洽数据不得报不一致，实际报了：${JSON.stringify(hits)}`);
});

test('空的库（没有交付行）⇒ 干净退出，不误报', async () => {
  /*
    先删**订单**再删码：删订单会经触发器把池占位结清（`trg_orders_delete_pool_release`），
    计数器因此仍然自洽；反过来只删交付行（`DELETE FROM order_delivery_items`）会留下
    "计数器已按交付减过、交付行却没了"的账——那是真漂移，新加的计数器对拍会（正确地）报出来。
    product_codes.order_id 是 ON DELETE SET NULL，所以订单删完之后还要把池行删掉，否则会报
    "池里 used 却没有交付行"。
  */
  await db.run('DELETE FROM orders');
  await db.run('DELETE FROM product_codes');
  const { issues, checked, counts } = await findIntegrityIssues(db);
  assert.equal(checked.deliveryItems, 0);
  assert.equal(counts.reservedCodesDrift, 0, `计数器不该有漂移：${JSON.stringify(issues)}`);
  assert.equal(issues.length, 0, `空库不该有噪声：${JSON.stringify(issues)}`);
});
