/**
 * SAVEPOINT/深度计数事务原语 + 多写路径分组回归（审计 F3/F4+D2/D3）：
 *  - txBegin/txCommit/txRollback：顶层真事务、嵌套自动降级 SAVEPOINT；
 *    内层回滚不影响外层、内层提交后外层回滚整体撤销；不成对调用抛错（防泄漏悬挂事务）。
 *  - 业务分组实测：把「置 cancelled + releaseHoldsForOrderIds」放进外层事务后整体回滚，
 *    占位/释放标记必须全部撤销（证明释放函数在已有事务内以 SAVEPOINT 嵌套，不会提前
 *    固化半写状态）；提交路径则一次性生效。
 * 既有行为回归（cancel/sweeper/watcher/sync/paid/settleReturn/自动交付等分组改造）由
 * 各专项测试文件全量覆盖（本文件只验证原语与嵌套语义本身）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { assertOk, login, makeCtx, productPayload, skuInv } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
let kvGet;
let kvSet;
let txBegin;
let txCommit;
let txRollback;
let releaseHoldsForOrderIds;

let ownerToken;
let buyerToken;
const uid = () => `sp-${Math.random().toString(36).slice(2, 10)}`;

before(async () => {
  ({ kvGet, kvSet, txBegin, txCommit, txRollback } = await import('../src/db.js'));
  ({ releaseHoldsForOrderIds } = await import('../src/stockHold.js'));
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
});

const commOf = (slug) =>
  (skuInv(db, slug).committed) || 0;

test('嵌套事务：内层回滚不影响外层（外层随后提交生效）', () => {
  const k1 = uid();
  const k2 = uid();
  txBegin();
  try {
    kvSet(k1, '1');
    txBegin();
    kvSet(k2, '2');
    txRollback(); // 内层回滚：k2 消失，外层不受损
    txCommit();
  } catch (e) {
    txRollback();
    throw e;
  }
  assert.equal(kvGet(k1), '1', '外层写入保留');
  assert.equal(kvGet(k2), null, '内层写入随内层回滚撤销');
});

test('嵌套事务：内层提交后外层回滚 → 整体撤销（内层未提前固化）', () => {
  const k1 = uid();
  const k2 = uid();
  txBegin();
  try {
    kvSet(k1, '1');
    txBegin();
    kvSet(k2, '2');
    txCommit(); // 内层提交（仅释放 SAVEPOINT，未固化）
    txRollback(); // 外层回滚 → 两层全部撤销
  } catch (e) {
    txRollback();
    throw e;
  }
  assert.equal(kvGet(k1), null, '外层写入随外层回滚撤销');
  assert.equal(kvGet(k2), null, '内层写入未提前固化');
});

test('不成对的 commit/rollback 抛错（防悬挂事务泄漏）', () => {
  assert.throws(() => txCommit(), /无活动事务/);
  assert.throws(() => txRollback(), /无活动事务/);
  // 手动补一层再正确关闭，确保后续用例不被悬挂事务污染
  txBegin();
  txCommit();
});

test('分组语义：外层事务内「置 cancelled + 释放占位」整体回滚 → 全量撤销', async () => {
  const p = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ kind: 'physical', title: 'SAVEPOINT 回滚商品', capacity: 3, priceCnyFen: 9900 }))
    .expect(200);
  assertOk(p);
  const slug = p.body.data.slug;
  const o = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slug })
    .expect(200);
  assertOk(o);
  const orderId = o.body.data.id;
  assert.equal(commOf(slug), 1, '下单占位 1 件');

  // 模拟「取消路由分组」：置 cancelled + 释放放在同一外层事务，然后整体回滚
  txBegin();
  try {
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), orderId);
    releaseHoldsForOrderIds([orderId]); // 内部事务 → SAVEPOINT 嵌套
    txRollback(); // 模拟进程中断/错误：整体撤销
  } catch (e) {
    txRollback();
    throw e;
  }
  const row = db.prepare('SELECT status, released_at FROM orders WHERE id = ?').get(orderId);
  assert.equal(row.status, 'draft', '回滚后状态复原（半写被撤销）');
  assert.equal(row.released_at, null, '回滚后释放标记不存在（半写被撤销）');
  assert.equal(commOf(slug), 1, '回滚后 committed 未被扣减（无幻影释放）');

  // 对照：同一分组成功提交 → 一次生效
  txBegin();
  try {
    db.prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), orderId);
    releaseHoldsForOrderIds([orderId]);
    txCommit();
  } catch (e) {
    txRollback();
    throw e;
  }
  const row2 = db.prepare('SELECT status, released_at FROM orders WHERE id = ?').get(orderId);
  assert.equal(row2.status, 'cancelled', '提交后状态生效');
  assert.ok(row2.released_at, '提交后释放标记落定');
  assert.equal(commOf(slug), 0, '提交后 committed 回补（一次性生效）');
});
