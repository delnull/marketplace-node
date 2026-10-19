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
import { makeCtx, login, assertOk, shopRef, insertOrder as insertOrderRow } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

const ZERO = '0x0000000000000000000000000000000000000000';
const FC = '0x1111111111111111111111111111111111111111';

const { feeSnapshotOf, commissionSnapshotOf, writeFeeSnapshot } = await import('../src/fees.js');

let ownerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
});

let seq = 0;
/**
 * 插一条"入账向"订单行，返回**对外订单号**（列的口径与 fees-per-order.test.js 的同名助手一致）。返回内部主键与对外单号：
 * `writeFeeSnapshot` 收内部主键，接口 URL 收对外单号。
 *
 * `feeCollectorAtCreate` 的"未知"档现在是 **NULL**（不是空串）：三态里 NULL 才是"从未补录"，
 * 空串在旧形状里兼任"未知"，在新库里既不是未知也不是确证值。
 */
async function insertRow({ feeCollectorAtCreate = null, feeBps = 0, commissionBps, commissionTo } = {}) {
  seq += 1;
  const row = await insertOrderRow(db, {
    status: 'confirmed',
    productSlug: 'p-feesnap',
    buyer: ctx.buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    amountWei: '1000',
    usdtMicro: 1000000,
    btyUsdtRate: '0.1',
    escrowOrderId: `0x${String(seq).padStart(64, '0')}`,
    paidTxHash: null,
    feeBps,
    feeCollectorAtCreate,
    commissionBps,
    commissionTo,
  });
  return { orderId: row.orderId, orderNo: row.orderNo };
}

const rowOf = async (id) =>
  await db.get(
    'SELECT fee_bps, fee_collector_at_create, commission_bps, commission_to FROM v_orders WHERE order_no = ?',
    id
  );

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

test('writeFeeSnapshot：快照未知 ⇒ 不写库，且**不覆盖**已有的确证快照', async () => {
  const { orderId, orderNo } = await insertRow({ feeCollectorAtCreate: FC, feeBps: 100 });
  assert.equal((await rowOf(orderNo)).fee_bps, 100, '前置：库里已有确证快照');

  // 链上只读到收取方（费率缺失）⇒ 一个字节都不许动
  const wrote = await writeFeeSnapshot(db, orderId, feeSnapshotOf({ feeCollectorAtCreate: FC }));
  assert.equal(wrote, false, '未知快照不得写库');
  const after = await rowOf(orderNo);
  assert.equal(after.fee_bps, 100, '费率没被覆盖成 0');
  assert.equal(after.fee_collector_at_create, FC, '收取方也没被覆盖');
});

test('writeFeeSnapshot：抽成快照未知时只写平台费两列，不覆盖已确证的抽成快照', async () => {
  /*
    两条腿的 known 各自独立（2026-10-18）：`commissionTermsAtCreate` 那次 RPC 失败时，
    平台费快照已经确证；旧实现把未知抽成折成 {bps:0,to:null} 一起写 ⇒ 已补录的 500bps 被抹成 0。
    正确形状：只写 fee 两列，抽成列保持原值（下一轮补录再写它们）。
  */
  const { orderId, orderNo } = await insertRow({ commissionBps: 500, commissionTo: FC });

  // 第一次：两条腿都确证 ⇒ 四列成对写
  assert.equal(
    await writeFeeSnapshot(
      db,
      orderId,
      feeSnapshotOf({ feeBps: 100, feeCollectorAtCreate: FC }),
      commissionSnapshotOf({ commissionTo: FC, commissionBps: 500 })
    ),
    true
  );
  let after = await rowOf(orderNo);
  assert.equal(after.commission_bps, 500);
  assert.equal(after.commission_to, FC);

  // 第二次：平台费读到 200、抽成读不到 ⇒ fee 两列更新，抽成仍 500（不是 0/null）
  assert.equal(
    await writeFeeSnapshot(db, orderId, feeSnapshotOf({ feeBps: 200, feeCollectorAtCreate: FC }), commissionSnapshotOf(null)),
    true
  );
  after = await rowOf(orderNo);
  assert.equal(after.fee_bps, 200, '平台费的新读数要落库');
  assert.equal(after.fee_collector_at_create, FC);
  assert.equal(after.commission_bps, 500, '抽成读数未知时**不得**把已知的 500 覆盖成 0');
  assert.equal(after.commission_to, FC, '抽成收款人同样保持已知值');
});

test('writeFeeSnapshot：快照读到 ⇒ 两列同批写（含确证 0%）', async () => {
  const { orderId, orderNo } = await insertRow(); // 未补录：fee_bps=0 且收取方为 NULL（三态里的"未知"）
  assert.equal((await rowOf(orderNo)).fee_collector_at_create, null);

  assert.equal(await writeFeeSnapshot(db, orderId, feeSnapshotOf({ feeBps: 0, feeCollectorAtCreate: ZERO })), true);
  const after = await rowOf(orderNo);
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
  /*
    唯一写入点里应恰好有两条 UPDATE：四列同写（两条腿都确证）与只写 fee 两列
    （抽成未知时不覆盖已知值）。写死"一条"会让后一种正确形状无法表达。
  */
  const updates = [...fees.matchAll(/UPDATE orders SET fee_bps = \?, fee_collector_at_create = \?[^\n]*/g)].map((m) => m[0]);
  assert.equal(updates.length, 2, `fees.js 的费率快照写入点应恰好两条，实际：${JSON.stringify(updates)}`);
  assert.ok(updates.some((u) => u.includes('commission_bps = ?')), '一条必须四列成对写');
  assert.ok(updates.some((u) => !u.includes('commission_bps')), '一条必须只写 fee 两列（抽成未知时不覆盖已知值）');
});

test('订单 DTO 对这个行的读数：未补录 ⇒ feeBps=null；确证 0% ⇒ 0', async () => {
  // `insertRow` 返回 { orderId, orderNo }：`writeFeeSnapshot` 收内部主键，接口 URL 收对外单号
  const unknown = (await insertRow()).orderNo;
  const known = (await insertRow({ feeCollectorAtCreate: ZERO, feeBps: 0 })).orderNo;
  const readBps = async (orderNo) => {
    const res = await request(app).get(`/api/orders/${orderNo}`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
    assertOk(res);
    return res.body.data.feeBps;
  };
  assert.equal(await readBps(unknown), null);
  assert.equal(await readBps(known), 0);
});
