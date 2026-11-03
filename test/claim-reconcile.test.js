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
    usdtMicro: 1_000_000,
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
