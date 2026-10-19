/**
 * 费率变更 ⇒ 旧费率下的**未支付草稿**被节点作废（2026-10-18）。
 *
 * 为什么必须作废：草稿在创建时把费率报给买家（`orders.commission_quoted_bps`），付款前端的
 * 校验是"报价 == 店铺当前费率"。节点主链上 `setShopCommission` 之后，这些草稿在新费率下
 * **必然被拦**，但行仍留在列表里、仍可被反复打开——买家看到一张永远付不了的草稿。
 *
 * 判据（本文件逐条钉住）：
 *   · `status='draft'` 且 `order_chain.paid_tx_hash IS NULL` ⇒ 与店铺新费率**同事务**置 cancelled；
 *   · 已支付/已上链（escrowed + 支付凭证）与别家店的草稿一律不动；
 *   · 作废逐单写审计（`order.cancel` + `detail.trigger='shop.commission_updated'` + 前后费率），
 *     不是一次静默 UPDATE；
 *   · 同一费率再对账一次不重复取消/不重复审计（幂等）。
 *
 * 链上读取用本地假 JSON-RPC（与 terms-reconciler-tombstone.test.js 同款）：`getShop`/`shopListed`
 * 按 selector 分发；`reconcileOnce` 走生产路径。
 */
process.env.MK_REGISTRY_ADDRESS = '0x000000000000000000000000000000000000dEaD';
process.env.MK_CHAIN_ID = '31337';

const { makeCtx, insertOrder, TEST_SHOP_CODE } = await import('./setup.mjs');
const { Interface, encodeBytes32String, ZeroHash } = await import('ethers');
const http = await import('node:http');
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;

const ctx = await makeCtx();
const { db, owner, buyer } = ctx;
const { default: config } = await import('../src/config.js');
const { REGISTRY_ABI } = await import('../src/chain.js');
const { reconcileOnce, setDraftChainOrderReader } = await import('../src/termsReconciler.js');

const iface = new Interface(REGISTRY_ABI);
const REGISTRY = config.chain.registryAddress.toLowerCase();
const OWNER = owner.address.toLowerCase();
const BUYER = buyer.address.toLowerCase();

// 单测不起 Escrow：默认"链上没有托管单"，即允许按本地草稿取消
setDraftChainOrderReader(async () => ({ status: 0 }));

/** seller(lower) → 链上读数 */
const chainShops = new Map();

function handleRpc(j) {
  if (j.method !== 'eth_call') return { error: { code: -32601, message: `unit-test: 未预期 ${j.method}` } };
  const to = String(j.params?.[0]?.to || '').toLowerCase();
  if (to !== REGISTRY) return { error: { code: -32601, message: 'unit-test: eth_call 目标不是 Registry' } };
  const data = String(j.params?.[0]?.data || '');
  const selector = data.slice(0, 10);
  if (selector === iface.getFunction('getShop').selector) {
    const [seller] = iface.decodeFunctionData('getShop', data);
    const s = chainShops.get(String(seller).toLowerCase());
    const v = {
      host: OWNER,
      seller: String(seller).toLowerCase(),
      commissionBps: s?.commissionBps ?? 0,
      registeredAtBlock: s?.registeredAtBlock ?? 0,
      hostSuspendedAtBlock: 0,
      exitedAtBlock: s?.exitedAtBlock ?? 0,
      code: s ? (s.code.startsWith('0x') ? s.code : encodeBytes32String(s.code)) : ZeroHash,
    };
    return {
      result: iface.encodeFunctionResult('getShop', [
        [v.host, v.seller, v.commissionBps, v.registeredAtBlock, v.hostSuspendedAtBlock, v.exitedAtBlock, v.code],
      ]),
    };
  }
  if (selector === iface.getFunction('shopListed').selector) {
    const [code] = iface.decodeFunctionData('shopListed', data);
    const listed = [...chainShops.values()].some((s) => s.listed && encodeBytes32String(s.code) === code);
    return { result: iface.encodeFunctionResult('shopListed', [listed]) };
  }
  return { error: { code: -32601, message: `unit-test: 未预期 selector ${selector}` } };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const out = Array.isArray(parsed)
      ? parsed.map((x) => ({ jsonrpc: '2.0', id: x?.id ?? 1, ...handleRpc(x) }))
      : { jsonrpc: '2.0', id: parsed?.id ?? 1, ...handleRpc(parsed) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
config.chain.rpcUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  if (server.listening) server.close();
});

const orderOf = (orderNo) => db.get('SELECT order_no, status FROM orders WHERE order_no = ?', orderNo);

test('费率 5%→8%：该店未支付草稿作废并入审计；已支付单与别家店草稿不受影响且幂等', async () => {
  // 本节点 fixture 的店：本地费率 5%
  await db.run('UPDATE shops SET commission_bps = 500, registered_at_block = 5 WHERE code = ?', TEST_SHOP_CODE);
  chainShops.set(OWNER, { registeredAtBlock: 10, exitedAtBlock: 0, code: TEST_SHOP_CODE, commissionBps: 500, listed: true });

  // 另一家店（只用于证明"按店作废"，不是全节点扫一遍）
  const otherSeller = '0x' + 'c3'.repeat(20);
  await db.run(
    `INSERT INTO shops (code, seller, name, notice, listed, commission_bps, registered_at_block)
     VALUES (?, ?, '', '', 1, 500, 5) ON DUPLICATE KEY UPDATE seller = seller`,
    '0000OTHR1',
    otherSeller
  );
  chainShops.set(otherSeller, { registeredAtBlock: 11, exitedAtBlock: 0, code: '0000OTHR1', commissionBps: 500, listed: true });

  const draft = await insertOrder(db, {
    status: 'draft',
    shopCode: TEST_SHOP_CODE,
    buyer: BUYER,
    seller: OWNER,
    amountWei: '1000',
    usdtMicro: 1_000_000,
  });
  const paid = await insertOrder(db, {
    status: 'escrowed',
    shopCode: TEST_SHOP_CODE,
    buyer: BUYER,
    seller: OWNER,
    amountWei: '2000',
    usdtMicro: 2_000_000,
    paidTxHash: '0x' + 'a1'.repeat(32),
  });
  const otherDraft = await insertOrder(db, {
    status: 'draft',
    shopCode: '0000OTHR1',
    buyer: BUYER,
    seller: otherSeller,
    amountWei: '3000',
    usdtMicro: 3_000_000,
  });

  // 第一次对账：费率没变 ⇒ 一张都不动
  await reconcileOnce();
  assert.equal((await orderOf(draft.orderNo)).status, 'draft', '费率没变时草稿不得被作废');
  assert.equal((await orderOf(paid.orderNo)).status, 'escrowed');

  // 链上费率 500 → 800
  chainShops.get(OWNER).commissionBps = 800;
  await reconcileOnce();

  assert.equal((await orderOf(draft.orderNo)).status, 'cancelled', '旧费率下的未支付草稿必须作废');
  assert.equal((await orderOf(paid.orderNo)).status, 'escrowed', '已支付/已上链订单一律不许动');
  assert.equal((await orderOf(otherDraft.orderNo)).status, 'draft', '只作废费率变化那家店的草稿');

  const auditRow = await db.get(
    'SELECT actor, actor_role, detail FROM audit_logs WHERE action = ? AND target_id = ? ORDER BY id DESC LIMIT 1',
    'order.cancel',
    draft.orderNo
  );
  assert.ok(auditRow, '作废必须有审计行（不是静默 UPDATE）');
  assert.equal(auditRow.actor, OWNER, '系统动作的主体是节点主（与 PII 保留期扫描同口径）');
  assert.equal(auditRow.actor_role, 'host');
  assert.equal(auditRow.detail.trigger, 'shop.commission_updated');
  assert.equal(Number(auditRow.detail.commissionBpsFrom), 500);
  assert.equal(Number(auditRow.detail.commissionBpsTo), 800);
  assert.match(String(auditRow.detail.reason), /费率已调整/);

  const paidAudit = await db.get('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', 'order.cancel', paid.orderNo);
  assert.equal(paidAudit, undefined, '已支付单不得被取消，也不该有取消审计');

  // 幂等：同一费率再对一次，不再产生审计
  const before = Number((await db.get('SELECT COUNT(*) AS c FROM audit_logs WHERE action = ?', 'order.cancel')).c);
  await reconcileOnce();
  const after = Number((await db.get('SELECT COUNT(*) AS c FROM audit_logs WHERE action = ?', 'order.cancel')).c);
  assert.equal(after, before, '费率未再变化时不得重复取消/重复审计');
});

/**
 * **P3-10：链上读必须发生在事务之外，且读不到时整行不写**。
 *
 * 旧实现把"读链（每张草稿一次 eth_call）→ 写店铺行 → 取消草稿"全放在
 * `withTransaction` + `FOR UPDATE` 里：一次 RPC 黑洞会持有行锁最长 N×2s。更糟的是
 * "读不到 ⇒ 本轮不取消"却照写新费率：下一轮 before.bps == after.bps，那批旧费率草稿
 * **永远不会再被计划作废**（注释承诺"下一轮再试"，代码再也不会试）。
 */
test('链上托管读数失败 ⇒ 本轮不写店铺行（下一轮仍能重试）；恢复后草稿被作废', async () => {
  await db.run('UPDATE shops SET commission_bps = 900 WHERE code = ?', TEST_SHOP_CODE);
  chainShops.get(OWNER).commissionBps = 900;
  const draft = await insertOrder(db, {
    status: 'draft',
    shopCode: TEST_SHOP_CODE,
    buyer: BUYER,
    seller: OWNER,
    amountWei: '5000',
    usdtMicro: 5_000_000,
  });

  chainShops.get(OWNER).commissionBps = 1_000; // 链上费率已变
  setDraftChainOrderReader(async () => null); // 读不到（RPC 故障）
  try {
    await reconcileOnce();
    assert.equal(
      Number((await db.get('SELECT commission_bps FROM shops WHERE code = ?', TEST_SHOP_CODE)).commission_bps),
      900,
      '读不到草稿的链上托管状态 ⇒ 整行不写（否则下一轮就看不到费率变化了）'
    );
    assert.equal((await orderOf(draft.orderNo)).status, 'draft', 'fail-closed：这一轮一张都不取消');
  } finally {
    setDraftChainOrderReader(async () => ({ status: 0 }));
  }

  // 下一轮恢复：before.bps（900） != after.bps（1000）仍然成立 ⇒ 真的"再试"并成功
  await reconcileOnce();
  assert.equal(
    Number((await db.get('SELECT commission_bps FROM shops WHERE code = ?', TEST_SHOP_CODE)).commission_bps),
    1_000,
    '恢复后新费率落库'
  );
  assert.equal((await orderOf(draft.orderNo)).status, 'cancelled', '旧费率下的草稿在重试轮被作废');
});

test('链上已经存在托管单的草稿不得被取消（支付已上链、/paid 尚未回写的竞态）', async () => {
  const draft = await insertOrder(db, {
    status: 'draft',
    shopCode: TEST_SHOP_CODE,
    buyer: BUYER,
    seller: OWNER,
    amountWei: '4000',
    usdtMicro: 4_000_000,
  });
  setDraftChainOrderReader(async () => ({ status: 1 })); // Created：链上已托管
  chainShops.get(OWNER).commissionBps = 900;
  try {
    await reconcileOnce();
    assert.equal((await orderOf(draft.orderNo)).status, 'draft', '链上已有单时只能保留草稿，等 watcher/被 /paid 认领');
    const audit = await db.get(
      'SELECT id FROM audit_logs WHERE action = ? AND target_id = ?',
      'order.cancel',
      draft.orderNo
    );
    assert.equal(audit, undefined, '不得产生取消审计');
  } finally {
    setDraftChainOrderReader(async () => ({ status: 0 }));
  }
});
