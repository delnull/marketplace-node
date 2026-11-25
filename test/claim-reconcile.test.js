/**
 * 提货争议零赔付终态对账：
 *   ClaimClosed 漏扫时，`claimCase.closed + claimPaidByOrder == 开案快照` 必须释放本地声明槽；
 *   链上累计已大于快照时不得把“可能已赔付”误判成 rejected（否则会二次赔付）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, insertOrder, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { db, owner, buyer } = ctx;
const { reconcileClaims } = await import('../src/claimReconcile.js');

let seq = 0;
const claimId = () => '0x' + String(++seq).padStart(4, '0').repeat(16);
const tokenContract = '0x' + 'ab'.repeat(20);

async function makeClaim({ snapshot = '0', chainPaid = '0', closed = true } = {}) {
  const n = ++seq;
  const order = await insertOrder(db, {
    status: 'settled',
    productSlug: `p-claim-${n}`,
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    amountWei: '1000000000000000000',
    priceMicro: 1_000_000,
    escrowOrderId: claimId(),
    paidTxHash: '0x' + String(n).padStart(64, '0'),
  });
  if (snapshot !== null) {
    await db.run('UPDATE order_chain SET claim_paid_wei = ? WHERE order_id = ?', snapshot, order.orderId);
  }
  const disputeId = claimId();
  await db.run(
    `INSERT INTO nft_claims
       (claim_no, shop_code, product_slug, order_id, order_no, seller, token_contract, token_id,
        claimant, status, claim_amount_wei, claim_paid_at_open, dispute_claim_id, dispute_state, dispute_opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, 'opened', ?)`,
    `C${String(n).padStart(10, '0')}${'A'.repeat(10)}`,
    shopRef.value,
    `p-claim-${n}`,
    order.orderId,
    order.orderNo,
    owner.address.toLowerCase(),
    tokenContract,
    String(900000 + n),
    buyer.address.toLowerCase(),
    '100000000000000000',
    snapshot,
    disputeId,
    new Date(Date.now() - 120_000)
  );
  const fakeEscrow = {
    claimCase: async () => ({ closed, orderId: order.escrowOrderId }),
    claimPaidByOrder: async () => BigInt(chainPaid),
  };
  return { order, disputeId, fakeEscrow };
}

test('零赔付 ClaimClosed 漏扫：链上 closed 且累计赔付等于开案快照 → 本地 rejected/closed', async () => {
  const { disputeId, fakeEscrow } = await makeClaim({ snapshot: '0', chainPaid: '0', closed: true });
  const r = await reconcileClaims({ escrow: fakeEscrow, minAgeMs: 0, blockTag: 'latest' });
  assert.equal(r.closed, 1);
  const row = await db.get(
    'SELECT status, dispute_state, claim_amount_wei FROM nft_claims WHERE dispute_claim_id = ?',
    disputeId
  );
  assert.equal(row.status, 'rejected');
  assert.equal(row.dispute_state, 'closed');
  assert.equal(row.claim_amount_wei, null);
});

test('链上累计赔付已大于快照：不能释放声明槽（可能已赔付，交 ClaimPaid/人工）', async () => {
  const { disputeId, fakeEscrow } = await makeClaim({ snapshot: '0', chainPaid: '100', closed: true });
  const r = await reconcileClaims({ escrow: fakeEscrow, minAgeMs: 0, blockTag: 'latest' });
  assert.equal(r.closed, 0);
  const row = await db.get('SELECT status, dispute_state FROM nft_claims WHERE dispute_claim_id = ?', disputeId);
  assert.equal(row.status, 'requested');
  assert.equal(row.dispute_state, 'opened');
});

test('链上争议仍未关闭：不产生本地终态', async () => {
  const { disputeId, fakeEscrow } = await makeClaim({ snapshot: '0', chainPaid: '0', closed: false });
  const r = await reconcileClaims({ escrow: fakeEscrow, minAgeMs: 0, blockTag: 'latest' });
  assert.equal(r.closed, 0);
  const row = await db.get('SELECT status, dispute_state FROM nft_claims WHERE dispute_claim_id = ?', disputeId);
  assert.equal(row.status, 'requested');
  assert.equal(row.dispute_state, 'opened');
});

test('对账固定同一 blockTag：claimCase 与 claimPaidByOrder 必须收到同一个高度', async () => {
  const { order, fakeEscrow } = await makeClaim({ snapshot: '0', chainPaid: '0', closed: true });
  const tags = [];
  fakeEscrow.claimCase = async (_id, opts) => {
    tags.push(['claimCase', opts?.blockTag]);
    return { closed: true, orderId: order.escrowOrderId };
  };
  fakeEscrow.claimPaidByOrder = async (_id, opts) => {
    tags.push(['claimPaidByOrder', opts?.blockTag]);
    return 0n;
  };
  const r = await reconcileClaims({ escrow: fakeEscrow, minAgeMs: 0, blockTag: 4242 });
  assert.equal(r.closed, 1);
  assert.deepEqual(tags.map(([, tag]) => tag), [4242, 4242]);
});

test('claimCase 返回的订单与本地 claim 不一致：不写终态', async () => {
  const { disputeId, fakeEscrow } = await makeClaim({ snapshot: '0', chainPaid: '0', closed: true });
  fakeEscrow.claimCase = async () => ({ closed: true, orderId: '0x' + 'ff'.repeat(32) });
  const r = await reconcileClaims({ escrow: fakeEscrow, minAgeMs: 0, blockTag: 'latest' });
  assert.equal(r.closed, 0);
  assert.ok(r.unreadable >= 1);
  const row = await db.get('SELECT status, dispute_state FROM nft_claims WHERE dispute_claim_id = ?', disputeId);
  assert.equal(row.status, 'requested');
  assert.equal(row.dispute_state, 'opened');
  await db.run("UPDATE nft_claims SET status='rejected', dispute_state='closed' WHERE dispute_claim_id = ?", disputeId);
});

test('缺少 claim_paid_at_open 的旧行：不猜、不释放，并计入 missingSnapshot', async () => {
  const { disputeId, fakeEscrow } = await makeClaim({ snapshot: null, chainPaid: '0', closed: true });
  const r = await reconcileClaims({ escrow: fakeEscrow, minAgeMs: 0, blockTag: 'latest' });
  assert.ok(r.missingSnapshot >= 1);
  const row = await db.get('SELECT status, dispute_state FROM nft_claims WHERE dispute_claim_id = ?', disputeId);
  assert.equal(row.status, 'requested');
  assert.equal(row.dispute_state, 'opened');
  await db.run("UPDATE nft_claims SET status='rejected', dispute_state='closed' WHERE dispute_claim_id = ?", disputeId);
});

test('对账按 id 游标翻页：前 20 条一直 open 也不会饿死后面的行', async () => {
  const made = [];
  for (let i = 0; i < 3; i += 1) {
    made.push(await makeClaim({ snapshot: '0', chainPaid: '0', closed: true }));
  }
  const byClaim = new Map(made.map((m) => [m.disputeId, m.order.escrowOrderId]));
  const fake = {
    claimCase: async (id) => ({ closed: true, orderId: byClaim.get(id) }),
    claimPaidByOrder: async () => 0n,
  };
  let closed = 0;
  for (let i = 0; i < 3; i += 1) {
    const r = await reconcileClaims({ escrow: fake, minAgeMs: 0, blockTag: 'latest', limit: 1 });
    closed += r.closed;
  }
  assert.equal(closed, 3);
});

/* ══════════════════════════════════════════════════════════════════════
   撤销证据的**有界续扫**（2026-11）
   ══════════════════════════════════════════════════════════════════════ */

/** 带事件能力的假 escrow：`queryFilter` 按块范围返回给定日志，可注入失败/范围上限 */
function scanChain({ logs = [], maxRange = 2000, failOnCall = 0 } = {}) {
  let calls = 0;
  return {
    filters: { ClaimDisputeCancelled: () => ({}) },
    async queryFilter(_filter, from, to) {
      calls += 1;
      if (failOnCall && calls === failOnCall) throw new Error('query returned more than 10000 results（注入）');
      if (to - from + 1 > maxRange) throw new Error(`range too large（注入：${from}-${to}）`);
      return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    },
    calls: () => calls,
  };
}

/** 把一个 claim 的链上读数与事件能力拼成 reconcileClaims 的 escrow 替身 */
function escrowOf(fakeEscrow, chain) {
  return { ...fakeEscrow, ...chain };
}

test('撤销证据：全史一次 queryFilter 会被 RPC 拒（旧形状），现在按块分页扫完并写出 rejected', async () => {
  const { disputeId, order, fakeEscrow } = await makeClaim({ snapshot: '0', chainPaid: '0', closed: true });
  const chain = scanChain({ maxRange: 2000 });
  const fake = escrowOf(fakeEscrow, chain);
  // 9000 块 / 每块 2000 ⇒ 5 次 queryFilter；任何一次超范围都会抛
  const r = await reconcileClaims({ escrow: fake, minAgeMs: 0, blockTag: 9000, scanFromBlock: 101 });
  assert.equal(r.closed, 1);
  assert.equal(chain.calls(), 5, '扫描必须按 2000 块分页，而不是一次全扫');
  const row = await db.get('SELECT status, dispute_state FROM nft_claims WHERE dispute_claim_id = ?', disputeId);
  assert.equal(row.status, 'rejected');
  assert.equal(row.dispute_state, 'closed');
});

test('续扫未追平：本轮不把"没查到撤销"当成"判店主无责"，下一轮从断点继续', async () => {
  const { disputeId, fakeEscrow } = await makeClaim({ snapshot: '0', chainPaid: '0', closed: true });
  const chain = scanChain({ failOnCall: 3, maxRange: 2000 });
  const fake = escrowOf(fakeEscrow, chain);

  const r1 = await reconcileClaims({ escrow: fake, minAgeMs: 0, blockTag: 9000, scanFromBlock: 201 });
  assert.equal(r1.closed, 0, '集合未覆盖到链头时不得写终态');
  assert.ok(r1.unreadable >= 1);
  let row = await db.get('SELECT status, dispute_state FROM nft_claims WHERE dispute_claim_id = ?', disputeId);
  assert.equal(row.status, 'requested');
  assert.equal(row.dispute_state, 'opened');
  assert.equal(chain.calls(), 3, '第 3 段失败 ⇒ 游标停在 4001，前两段不重扫');

  // 下一轮：从断点续扫（不回到 1），追平后写 rejected
  chain.failOnCall = 0;
  const r2 = await reconcileClaims({ escrow: fake, minAgeMs: 0, blockTag: 9000, scanFromBlock: 201 });
  assert.equal(r2.closed, 1);
  assert.equal(chain.calls(), 3 + 3, '续扫 4001-9000 只需 3 段');
  row = await db.get('SELECT status, dispute_state FROM nft_claims WHERE dispute_claim_id = ?', disputeId);
  assert.equal(row.status, 'rejected');
});

test('撤销证据命中：写 cancelled/cancelled（不是"判店主无责"）', async () => {
  const { order, disputeId, fakeEscrow } = await makeClaim({ snapshot: '0', chainPaid: '0', closed: true });
  // 撤销事件落在扫描范围内；claimId 用 indexed args[0] 的形状
  const chain = scanChain({ logs: [{ blockNumber: 1500, args: [disputeId] }] });
  const fake = escrowOf(fakeEscrow, chain);
  const r = await reconcileClaims({ escrow: fake, minAgeMs: 0, blockTag: 3000, scanFromBlock: 301 });
  assert.equal(r.closed, 1);
  const row = await db.get('SELECT status, dispute_state FROM nft_claims WHERE dispute_claim_id = ?', disputeId);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.dispute_state, 'cancelled');
});
