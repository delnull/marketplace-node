/**
 * 费率快照的**三态判据与唯一写入点**（`feeSnapshotOf` / `writeFeeSnapshot`）。
 *
 * 这一组测试守的是一类曾经真实存在过的病：`orders.fee_bps` 是 `INTEGER NOT NULL DEFAULT 0`，
 * "从没补录过"与"链上确证 0%"在它上面同形；能分开二者的只有 `fee_collector_at_create`。
 * 三处补录（`/paid`、watcher、`/sync`）原来各自写 UPDATE，判据与写入分离 ⇒
 * "链上只读到一半"时会把未知写成确证 0%，并且**覆盖掉**此前补录过的确证快照。
 * 现在：判据 `known` 与写入同在 `writeFeeSnapshot` 里，缺一半就一个字节都不写。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

const ZERO = '0x0000000000000000000000000000000000000000';
const FC = '0x1111111111111111111111111111111111111111';

const { feeSnapshotOf, writeFeeSnapshot } = await import('../src/fees.js');

let ownerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
});

let seq = 0;
/** 插一条"入账向"订单行，返回 id（列的口径与 fees-per-order.test.js 的同名助手一致） */
function insertRow({ feeCollectorAtCreate = '', feeBps = 0 } = {}) {
  seq += 1;
  const id = `fee-snap-${String(seq).padStart(3, '0')}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, usdt_micro, bty_usdt_rate, status, escrow_order_id, paid_tx_hash,
       fee_bps, fee_collector_at_create, created_at, updated_at)
     VALUES (?, 'p-feesnap', '{}', '0x00', '', ?, ?, '1000', 1000000, '0.1', 'confirmed', ?, NULL, ?, ?, ?, ?)`
  ).run(
    id,
    ctx.buyer.address.toLowerCase(),
    owner.address.toLowerCase(),
    `0x${String(seq).padStart(64, '0')}`,
    feeBps,
    feeCollectorAtCreate,
    now,
    now
  );
  return id;
}

const rowOf = (id) => db.prepare('SELECT fee_bps, fee_collector_at_create FROM orders WHERE id = ?').get(id);

test('feeSnapshotOf：两个字段都读到才算读到（known=true），保留确证 0%', () => {
  // 确证"这单不扣费"：链上回零地址 + 费率 0 —— 这是**结论**，必须能写进去
  const zero = feeSnapshotOf({ feeBps: 0, feeCollectorAtCreate: ZERO });
  assert.equal(zero.known, true);
  assert.equal(zero.feeBps, 0);
  assert.equal(zero.feeCollectorAtCreate, ZERO);

  const charged = feeSnapshotOf({ feeBps: 100, feeCollectorAtCreate: FC });
  assert.equal(charged.known, true);
  assert.equal(charged.feeBps, 100);
  assert.equal(charged.feeCollectorAtCreate, FC);
  // 大小写归一到小写（库里列的口径）
  assert.equal(feeSnapshotOf({ feeBps: 1, feeCollectorAtCreate: FC.toUpperCase().replace('0X', '0x') }).feeCollectorAtCreate, FC);
});

test('feeSnapshotOf：缺任一个字段 ⇒ known=false（不是"费率 0"）', () => {
  for (const partial of [
    { feeBps: 0 }, // 缺收取方
    { feeCollectorAtCreate: FC }, // 缺费率
    { feeCollectorAtCreate: '' }, // 空串 = 未读到
    { feeBps: null, feeCollectorAtCreate: FC },
    { feeBps: undefined, feeCollectorAtCreate: FC },
    { feeBps: 'abc', feeCollectorAtCreate: FC }, // 畸形
    { feeBps: -1, feeCollectorAtCreate: FC }, // 非法
    null,
    undefined,
    {},
  ]) {
    const s = feeSnapshotOf(partial);
    assert.equal(s.known, false, `应判未知：${JSON.stringify(partial)}`);
    assert.equal(s.feeCollectorAtCreate, '');
  }
  // 畸形费率**不许**被 Number() 静默折成 0（这正是旧实现 `Number(onchain?.feeBps || 0)` 的病）
  assert.equal(feeSnapshotOf({ feeBps: 'abc', feeCollectorAtCreate: FC }).known, false);
});

test('writeFeeSnapshot：快照未知 ⇒ 不写库，且**不覆盖**已有的确证快照', () => {
  const id = insertRow({ feeCollectorAtCreate: FC, feeBps: 100 });
  assert.equal(rowOf(id).fee_bps, 100, '前置：库里已有确证快照');

  // 链上只读到收取方（费率缺失）⇒ 一个字节都不许动
  const wrote = writeFeeSnapshot(db, id, feeSnapshotOf({ feeCollectorAtCreate: FC }));
  assert.equal(wrote, false, '未知快照不得写库');
  const after = rowOf(id);
  assert.equal(after.fee_bps, 100, '费率没被覆盖成 0');
  assert.equal(after.fee_collector_at_create, FC, '收取方也没被覆盖');
});

test('writeFeeSnapshot：快照读到 ⇒ 两列同批写（含确证 0%）', () => {
  const id = insertRow(); // 未补录：fee_bps=0 且收取方空串
  assert.equal(rowOf(id).fee_collector_at_create, '');

  assert.equal(writeFeeSnapshot(db, id, feeSnapshotOf({ feeBps: 0, feeCollectorAtCreate: ZERO })), true);
  const after = rowOf(id);
  assert.equal(after.fee_bps, 0);
  assert.equal(after.fee_collector_at_create, ZERO, '确证不扣费是一条约结论，必须落库');
});

test('路由层：/sync 与 /paid 的补录只经 writeFeeSnapshot（源码守卫，防判据与写入再次分离）', async () => {
  /*
    为什么要有这条源码守卫：本轮修的正是"判据在 fees.js、写入却在三个地方各写一遍"，
    而那种分离在运行时测不出来（只有 ABI 漂移时才显形）。守的是形状而不是行为：
    谁再往 orders 表直接写 fee_bps/fee_collector_at_create，这条就会红。
  */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/routes/orders.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/escrowWatcher.js', import.meta.url), 'utf8');
  const hits = [...src.matchAll(/UPDATE orders SET[^\n]*fee_bps/g)].filter(
    (m) => !m[0].includes('SET fee_bps = ?, fee_collector_at_create = ?')
  );
  assert.deepEqual(hits.map((m) => m[0]), [], '直接把 fee_bps 写进 UPDATE 的地方只应有 fees.writeFeeSnapshot 一处');
  // 且 fees.js 里那一条确实是唯一的那一条
  const fees = readFileSync(new URL('../src/fees.js', import.meta.url), 'utf8');
  assert.equal([...fees.matchAll(/UPDATE orders SET fee_bps = \?, fee_collector_at_create = \?/g)].length, 1);
});

test('订单 DTO 对这个行的读数：未补录 ⇒ feeBps=null；确证 0% ⇒ 0', async () => {
  const unknown = insertRow();
  const known = insertRow({ feeCollectorAtCreate: ZERO, feeBps: 0 });
  const readBps = async (id) => {
    const res = await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    assertOk(res);
    return res.body.data.feeBps;
  };
  assert.equal(await readBps(unknown), null);
  assert.equal(await readBps(known), 0);
});
