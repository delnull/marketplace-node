/**
 * **"买家签进链上的分账条款 == 我们报的那一份吗"**——交付闸的第四条判据
 * （`chainOrder.termsMismatchOf` / `deliveryGate`，2026-10-15 加；2026-10-18 改为三态）。
 *
 * 为什么单独立一组用例：这一条判据只被**真链矩阵**（`scripts/dev/dev-scenarios.mjs` 的 ⑤ 段）
 * 覆盖过——那需要起链、起节点、真钱包签名。而它守的是一个**纯函数**上的不变量：
 * 报价列（`orders.commission_quoted_*` + `timeout_blocks`）与链上那一份逐项相等。
 *
 * 判据的形状（本文件的核心，2026-10-18 收紧）：
 *   · `{ok:true}` —— 逐项相等；
 *   · `reason:'mismatch'` —— 两边都读到了，值不同 ⇒ `deliveryGate` 拒绝交付；
 *   · `reason:'unreadable'` —— **任一侧读不到/非法** ⇒ 也拒绝交付（fail-closed）。
 *     旧实现对"报价缺失 / 链上抽成条款读失败 / 窗口非法"返回 null（= 放行），
 *     于是买家把抽成签给另一个已登记节点、只要那一次读失败，交付就照常发生。
 *
 * 零抽成的店铺键是 **(seller, commissionTo)**：链上 bps=0 时仍存 host，不再归一成零地址。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryGate, termsMismatchOf, setChainOrderFetcher } from '../src/chainOrder.js';

const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const HOST = '0x3333333333333333333333333333333333333333';
const ZERO = '0x0000000000000000000000000000000000000000';
const ORDER_ID = `0x${'ab'.repeat(32)}`;

/** 本地订单行（只放这条判据用得到的列；`commission_*` 是链上镜像，`commission_quoted_*` 是报价） */
const row = (over = {}) => ({
  id: 'X1',
  escrow_order_id: ORDER_ID,
  buyer: BUYER,
  seller: SELLER,
  amount_wei: '1000',
  timeout_blocks: 17280,
  commission_bps: 500,
  commission_to: HOST,
  commission_quoted_bps: 500,
  commission_quoted_to: HOST,
  ...over,
});

/** 链上真值（`fetchOnchainOrder` 的形状里这条判据用得到的部分） */
const chain = (over = {}) => ({
  buyer: BUYER,
  seller: SELLER,
  amount: '1000',
  timeoutBlocks: 17280,
  refundRequested: false,
  status: 'Created',
  // 订单身份的一部分（顶层）：交付闸的 chainParamsMatch 读它；夹具报价 host = HOST
  commissionTo: HOST,
  commissionTerms: { commissionTo: HOST, commissionBps: 500 },
  ...over,
});

after(() => setChainOrderFetcher(null));

test('报价与链上逐字一致 ⇒ {ok:true}，交付放行', async () => {
  assert.deepEqual(termsMismatchOf(row(), chain()), { ok: true });
  setChainOrderFetcher(async () => chain());
  const g = await deliveryGate(row());
  assert.equal(g.ok, true);
});

test('抽成被改成 0 + 另一个收款人 ⇒ 两条腿都命中（收款人不再按 bps 归一）', () => {
  const m = termsMismatchOf(row({ commission_quoted_bps: 0, commission_quoted_to: HOST }), chain({ commissionTerms: { commissionTo: BUYER, commissionBps: 0 } }));
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'mismatch');
  assert.deepEqual(m.fields, ['commissionTo']);
});

test('bps=0 但收款人是另一家店 ⇒ 仍是 mismatch（店铺键是 (seller, commissionTo)）', () => {
  const m = termsMismatchOf(
    row({ commission_quoted_bps: 0, commission_quoted_to: HOST }),
    chain({ commissionTerms: { commissionTo: BUYER, commissionBps: 0 } })
  );
  assert.equal(m.reason, 'mismatch');
  assert.deepEqual(m.fields, ['commissionTo'], '零费率时收款人仍必须逐字相等（链上用它定位店铺）');
  // 反向控制：0 bps + 同一个 host ⇒ 一致（不能把合法的零抽成判成不符）
  assert.deepEqual(
    termsMismatchOf(
      row({ commission_quoted_bps: 0, commission_quoted_to: HOST }),
      chain({ commissionTerms: { commissionTo: HOST, commissionBps: 0 } })
    ),
    { ok: true }
  );
});

test('收款人被改成别人 ⇒ 命中 commissionTo', () => {
  const m = termsMismatchOf(row(), chain({ commissionTerms: { commissionTo: BUYER, commissionBps: 500 } }));
  assert.deepEqual(m.fields, ['commissionTo']);
});

test('验货窗口被拉长 ⇒ 命中 timeoutBlocks（30 天不能被当成"没读到"放过）', () => {
  const m = termsMismatchOf(row(), chain({ timeoutBlocks: 518400 }));
  assert.deepEqual(m.fields, ['timeoutBlocks']);
});

test('报价缺失 ⇒ unreadable（不是"跳过"）：交付闸必须拒绝', async () => {
  const m = termsMismatchOf(
    row({ commission_quoted_to: null, timeout_blocks: null }),
    chain({ commissionTerms: { commissionTo: BUYER, commissionBps: 1000 } })
  );
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'unreadable');
  assert.deepEqual(m.fields, ['commissionQuoted', 'timeoutBlocksQuoted']);

  setChainOrderFetcher(async () => chain());
  const g = await deliveryGate(row({ commission_quoted_to: null, timeout_blocks: null }));
  assert.equal(g.ok, false);
  assert.equal(g.code, 'terms_unreadable');
  assert.match(g.message, /读不到链上抽成条款|无法确认/);
});

test('报价已知但链上抽成条款读不到 ⇒ unreadable，交付闸明确拒绝', async () => {
  const m = termsMismatchOf(row(), chain({ commissionTerms: null }));
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'unreadable');
  assert.deepEqual(m.fields, ['commissionTerms']);

  setChainOrderFetcher(async () => chain({ commissionTerms: null }));
  const g = await deliveryGate(row());
  assert.equal(g.ok, false);
  assert.equal(g.code, 'terms_unreadable');
  assert.match(g.message, /读不到链上抽成条款，不能交付/);
});

test('链上验货窗口不是安全整数 ⇒ unreadable（不能跳过比较）', async () => {
  const m = termsMismatchOf(row(), chain({ timeoutBlocks: Number.NaN }));
  assert.equal(m.reason, 'unreadable');
  assert.deepEqual(m.fields, ['timeoutBlocksChain']);
  setChainOrderFetcher(async () => chain({ timeoutBlocks: undefined }));
  const g = await deliveryGate(row());
  assert.equal(g.code, 'terms_unreadable');
});

test('交付闸：不一致 ⇒ 拒绝交付且理由是条款不符（而不是某个含糊的失败）', async () => {
  setChainOrderFetcher(async () => chain({ commissionTerms: { commissionTo: BUYER, commissionBps: 1000 } }));
  const g = await deliveryGate(row());
  assert.equal(g.ok, false);
  assert.equal(g.code, 'terms_mismatch');
  assert.match(g.message, /分账条款与本店报价不一致/);
  assert.match(g.message, /commissionTo|commissionBps/);
});
