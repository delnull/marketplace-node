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
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { db, owner, buyer } = ctx;

const { findIntegrityIssues } = await import('../src/integrity.js');

const PRODUCT_ID = 990001;

/** 造一个商品 + 一笔订单（直接插行：本用例测的是体检判据，不是下单流程） */
function seed(orderId, { status = 'shipped', productId = PRODUCT_ID } = {}) {
  db.prepare(
    `INSERT INTO products (id, slug, title, description, description_blocks, images, kind, specs,
        snapshot_hash, created_at, updated_at)
     VALUES (?, ?, ?, '', '[]', '[]', 'digital', '[]', '0x' + '00', ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(productId, `integrity-slug-${productId}`, `体检商品 ${productId}`, Date.now(), Date.now());
  db.prepare(
    `INSERT INTO orders (id, product_id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       quantity, hold_qty, amount_wei, cny_fen, status, created_at, updated_at)
     VALUES (?, ?, ?, '{}', '0x' + '00', '', ?, ?, 1, 0, '1', 1, ?, ?, ?)`
  ).run(orderId, productId, `integrity-slug-${productId}`, buyer.address.toLowerCase(), owner.address.toLowerCase(), status, Date.now(), Date.now());
}

function addCode(productId, code, status, orderId) {
  db.prepare(
    'INSERT INTO product_codes (product_id, code, status, order_id, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(productId, code, status, orderId, Date.now(), status === 'used' ? Date.now() : null);
}

function addDelivery(orderId, kind, value) {
  db.prepare('INSERT INTO order_delivery_items (order_id, kind, value, created_at) VALUES (?, ?, ?, ?)').run(
    orderId,
    kind,
    value,
    Date.now()
  );
}

test('交付行与池状态自洽 ⇒ 无问题（正向基线：体检不能见谁都报）', () => {
  seed('it-ok');
  addCode(PRODUCT_ID, 'IT-OK-CODE', 'used', 'it-ok');
  addDelivery('it-ok', 'code', 'IT-OK-CODE');
  const { issues, counts } = findIntegrityIssues(db);
  assert.equal(counts.codeDeliveredNotUsed, 0);
  assert.equal(counts.codeUsedWithoutDelivery, 0);
  assert.equal(issues.length, 0, `不该有噪声：${JSON.stringify(issues)}`);
});

test('恢复旧库的典型痕：已交付的码在池里回到 unused ⇒ 必须报出来（双交付风险）', () => {
  seed('it-reverted');
  addCode(PRODUCT_ID, 'IT-REVERTED-CODE', 'unused', null); // 恢复后被回退的样子
  addDelivery('it-reverted', 'code', 'IT-REVERTED-CODE');
  const { issues, counts } = findIntegrityIssues(db);
  assert.equal(counts.codeDeliveredNotUsed, 1);
  const hit = issues.find((i) => i.resource === 'IT-REVERTED-CODE');
  assert.ok(hit, '必须报出这个码');
  assert.equal(hit.orderId, 'it-reverted');
  assert.match(hit.detail, /再发给别的买家/);
  // 报告里的码要打码（码是敏感资源，不能凭报告直接用）
  assert.ok(!hit.detail.includes('IT-REVERTED-CODE'), '报告不得打印码原文');
});

test('交付行指向的码在池里被挂到别的订单 ⇒ 报"状态/归属不符"', () => {
  seed('it-owner-a');
  seed('it-owner-b');
  addCode(PRODUCT_ID, 'IT-MOVED-CODE', 'used', 'it-owner-b'); // 池说归 B，交付行说给了 A
  addDelivery('it-owner-a', 'code', 'IT-MOVED-CODE');
  const { issues } = findIntegrityIssues(db);
  const hit = issues.find((i) => i.resource === 'IT-MOVED-CODE' && i.orderId === 'it-owner-a');
  assert.ok(hit, '归属不符必须报出');
  assert.match(hit.detail, /order_id=it-owner-b/);
});

test('池里没有这个码（交付行还在）⇒ 报"池被重建/导入丢了"', () => {
  seed('it-orphan');
  addDelivery('it-orphan', 'code', 'IT-NO-POOL-ROW');
  const { issues } = findIntegrityIssues(db);
  const hit = issues.find((i) => i.kind === 'code-delivered-without-pool-row');
  assert.ok(hit);
  assert.match(hit.detail, /没有这个码/);
});

test('池里标了 used 但没有交付行 ⇒ 报"交付记录被回退"', () => {
  seed('it-lost-item');
  addCode(PRODUCT_ID, 'IT-LOST-ITEM', 'used', 'it-lost-item'); // 池说已交付
  // 故意不插交付行（同一进程里别的用例也留了同类痕，所以断言落在"这一单"上，而非总数）
  const { issues, counts } = findIntegrityIssues(db);
  assert.ok(counts.codeUsedWithoutDelivery >= 1);
  const hit = issues.find((i) => i.kind === 'code-used-without-delivery' && i.orderId === 'it-lost-item');
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
test('码不属于本商品的池却被交付 ⇒ 报"本商品的池里没有这个码"（串商品）', () => {
  const OTHER = PRODUCT_ID + 1;
  seed('it-cross', { productId: OTHER });
  addCode(PRODUCT_ID, 'IT-CROSS-CODE', 'used', 'it-cross'); // 码属于 990001
  addDelivery('it-cross', 'code', 'IT-CROSS-CODE'); // 订单属于 990002
  const { issues, counts } = findIntegrityIssues(db);
  assert.ok(counts.codeDeliveredNotUsed >= 1);
  const hit = issues.find((i) => i.kind === 'code-delivered-without-pool-row' && i.orderId === 'it-cross');
  assert.ok(hit, '必须报出这一单');
  assert.match(hit.detail, /没有这个码/);
});

/**
 * 反例守卫（同一次审计）：**同一个码串存在于两个商品的池里是合法数据**，
 * 只要订单自己那个商品的池里有它、且标 used、且指向本单，就不该报任何不一致。
 * 这条用例正是旧判据④的假阳性形状——它会把它判成 `code-product-mismatch`。
 */
test('同一码串存在于两个商品的池（合法）不得误报', () => {
  const OTHER = PRODUCT_ID + 1;
  seed('it-dup-a', { productId: PRODUCT_ID });
  seed('it-dup-b', { productId: OTHER });
  addCode(PRODUCT_ID, 'IT-DUP-CODE', 'used', 'it-dup-a');
  addCode(OTHER, 'IT-DUP-CODE', 'used', 'it-dup-b'); // 另一池里同名码，属正常
  addDelivery('it-dup-a', 'code', 'IT-DUP-CODE');
  addDelivery('it-dup-b', 'code', 'IT-DUP-CODE');
  const { issues } = findIntegrityIssues(db);
  const hits = issues.filter((i) => i.orderId === 'it-dup-a' || i.orderId === 'it-dup-b');
  assert.deepEqual(hits, [], `自洽数据不得报不一致，实际报了：${JSON.stringify(hits)}`);
});

test('空的库（没有交付行）⇒ 干净退出，不误报', () => {
  db.prepare('DELETE FROM order_delivery_items').run();
  db.prepare('DELETE FROM product_codes').run();
  const { issues, checked } = findIntegrityIssues(db);
  assert.equal(checked.deliveryItems, 0);
  assert.equal(issues.length, 0);
});
