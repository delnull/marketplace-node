/**
 * 事务作用域（`withTransaction` 的回调即事务边界）+ 多写路径分组回归（审计 F3/F4+D2/D3）：
 *  - 顶层调用：回调正常返回即提交，抛错即整体回滚；嵌套调用自动降级 SAVEPOINT，
 *    内层回滚不影响外层、内层返回后外层回滚整体撤销。
 *  - **泄漏在形状上不可表达**：没有要成对调用的原语，连接由 finally 归还——
 *    `openTransactions()` 是"还有几条连接开着事务"的读数，任何路径走完都必须是 0。
 *  - 业务分组实测：把「置 cancelled + releaseHoldsForOrderIds」放进同一个事务后整体回滚，
 *    占位/释放标记必须全部撤销（证明释放函数在已有事务内以 SAVEPOINT 嵌套，不会提前
 *    固化半写状态）；提交路径则一次性生效。
 * 既有行为回归（cancel/sweeper/watcher/sync/paid/settleReturn/自动交付等分组改造）由
 * 各专项测试文件全量覆盖（本文件只验证原语与嵌套语义本身）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { assertOk, login, makeCtx, orderIdOf, productPayload, skuInv, shopRef, TEST_SHOP_CODE } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
let withTransaction;
let abortTx;
let openTransactions;
let releaseHoldsForOrderIds;

let ownerToken;
let buyerToken;
const uid = () => `sp-${Math.random().toString(36).slice(2, 10)}`;

before(async () => {
  ({ withTransaction, abortTx, openTransactions } = await import('../src/db.js'));
  ({ releaseHoldsForOrderIds } = await import('../src/stockHold.js'));
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
});

const commOf = async (slug) => (await skuInv(db, slug)).committed || 0;

/*
  事务原语用例需要一个"能看见行在不在"的表。原来用的是 kv 的两列 EAV —— 它已随重设计删除
  （见 src/db.js：结构化状态各自成表，刻意不再提供通用键值读写）。
  这里改用 `shop_webhook`：它是真实的一张**一行一店**的表（主键 shop_code，外键指向 shops），
  写一行/读一行都直接对应"这次事务到底提交了没有"，判据与原来逐字等价。
*/
/** 写一行 webhook 配置（事务里的"写"） */
const hookSet = async (key, value) =>
  await db.run(
    `INSERT INTO shop_webhook (shop_code, url, secret) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE url = VALUES(url), secret = VALUES(secret)`,
    TEST_SHOP_CODE,
    key,
    value
  );
/** 读回那一行（不存在 ⇒ null，与旧 kvGet 的「没有这一行」同形）；值在 secret 列里 */
const hookGet = async (key) => (await db.get('SELECT url, secret FROM shop_webhook WHERE shop_code = ? AND url = ?', TEST_SHOP_CODE, key)) || null;

test('抛错即整体回滚，且连接被归还（事务泄漏在形状上不可表达）', async () => {
  const k = uid();
  await assert.rejects(
    () => withTransaction(async () => {
      await hookSet(k, '1');
      throw new Error('boom');
    }),
    /boom/
  );
  assert.equal(await hookGet(k), null, '抛出即整体回滚（半写不留）');
  assert.equal(openTransactions(), 0, 'openTransactions() 是"泄漏事务"的唯一读数，正常路径恒为 0');
});

test('嵌套事务：内层回滚不影响外层（外层随后正常返回即提交生效）', async () => {
  const k1 = uid();
  const k2 = uid();
  await withTransaction(async () => {
    await hookSet(k1, '1');
    // abortTx = "回滚当前这层并把 value 当作结果返回"的唯一入口（回调内没有别的回滚出口）
    const inner = await withTransaction(async () => {
      await hookSet(k2, '2');
      abortTx('rolled-back');
    });
    assert.equal(inner, 'rolled-back', '内层回滚的值原样成为 withTransaction 的结果');
  });
  assert.equal((await hookGet(k1))?.secret, '1', '外层写入保留');
  assert.equal(await hookGet(k2), null, '内层写入随内层回滚撤销');
  assert.equal(openTransactions(), 0);
});

test('嵌套事务：内层正常返回后外层回滚 → 整体撤销（内层未提前固化）', async () => {
  const k1 = uid();
  const k2 = uid();
  await withTransaction(async () => {
    await hookSet(k1, '1');
    await withTransaction(async () => {
      await hookSet(k2, '2');
    }); // 内层正常返回 = 释放 SAVEPOINT，不固化
    abortTx(null); // 外层回滚 → 两层全部撤销
  });
  assert.equal(await hookGet(k1), null, '外层写入随外层回滚撤销');
  assert.equal(await hookGet(k2), null, '内层写入未提前固化');
  assert.equal(openTransactions(), 0);
});

test('分组语义：外层事务内「置 cancelled + 释放占位」整体回滚 → 全量撤销', async () => {
  const p = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'physical', title: 'SAVEPOINT 回滚商品', capacity: 3, priceUsdtMicro: 99_000_000 }))
    .expect(200);
  assertOk(p);
  const slug = p.body.data.slug;
  const o = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug })
    .expect(200);
  assertOk(o);
  const orderId = o.body.data.id;
  assert.equal(await commOf(slug), 1, '下单占位 1 件');

  // 模拟「取消路由分组」：置 cancelled + 释放放在同一个事务里，然后整体回滚
  await withTransaction(async () => {
    await db.run("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE order_no = ?", new Date(), orderId);
    /*
      ⚠️ `orderId` 是**对外单号**，而这个函数要的是**内部数值主键**（orders.id）——
      它刻意对传错响亮失败（旧写法把单号塞进 `IN (…)` 只会永不命中：占位永不回补，
      而调用方看到"成功"，那是超卖）。所以这里显式转一次，不做兜底。
    */
    await releaseHoldsForOrderIds([await orderIdOf(db, orderId)]); // 内部 withTransaction → SAVEPOINT 嵌套
    abortTx(null); // 模拟进程中断/错误：整体撤销
  });
  const row = await db.get('SELECT status, released_at FROM v_orders WHERE order_no = ?', orderId);
  assert.equal(row.status, 'draft', '回滚后状态复原（半写被撤销）');
  assert.equal(row.released_at, null, '回滚后释放标记不存在（半写被撤销）');
  assert.equal(await commOf(slug), 1, '回滚后 committed 未被扣减（无幻影释放）');
  assert.equal(openTransactions(), 0, '回滚路径同样归还连接');

  // 对照：同一分组成功提交 → 一次生效
  await withTransaction(async () => {
    await db.run("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE order_no = ?", new Date(), orderId);
    await releaseHoldsForOrderIds([await orderIdOf(db, orderId)]);
  });
  const row2 = await db.get('SELECT status, released_at FROM v_orders WHERE order_no = ?', orderId);
  assert.equal(row2.status, 'cancelled', '提交后状态生效');
  assert.ok(row2.released_at, '提交后释放标记落定');
  assert.equal(await commOf(slug), 0, '提交后 committed 回补（一次性生效）');
  assert.equal(openTransactions(), 0);
});
