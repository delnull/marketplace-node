/**
 * 店铺镜像对账的**墓碑分支**（2026-10-18）：店主 `deregisterShop` 之后，链上留下的是
 * `registeredAtBlock > 0 && exitedAtBlock != 0`，而 `shopListed` 必为假。
 *
 * 旧实现把这一档与"从未登记"合并成 `continue`，于是本地 `listed` 永远停在 1：
 * 已注销的店仍在目录里、仍接单（下单会在链上 revert，但界面显示在营业）。
 * 新判据：**读到确切的 exitedAtBlock>0 就写 listed=0**（同时把墓碑区块落进
 * `exited_at_block`，供"能否重新申请开店"使用）；读不到链时仍照旧跳过，不猜。
 *
 * 链上读取用本地假 JSON-RPC（与 order-sync-paths.test.js 同款）：ethers 在 Node 下走
 * node:http，不经过 globalThis.fetch，所以必须起真服务器而不是打桩 fetch。
 */
process.env.MK_REGISTRY_ADDRESS = '0x000000000000000000000000000000000000dEaD';
process.env.MK_CHAIN_ID = '31337';

const { makeCtx } = await import('./setup.mjs');
const { Interface, encodeBytes32String, ZeroHash } = await import('ethers');
const http = await import('node:http');
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;

const ctx = await makeCtx();
const { db } = ctx;
const { default: config } = await import('../src/config.js');
const { REGISTRY_ABI } = await import('../src/chain.js');
const { reconcileOnce } = await import('../src/termsReconciler.js');

const iface = new Interface(REGISTRY_ABI);
const REGISTRY = config.chain.registryAddress.toLowerCase();
const OWNER = (await (await import('../src/shops.js')).nodeOwner()).toLowerCase();

/** seller(lower) → 链上读数 */
const chainShops = new Map();
/** true = 本轮的链上读取"不可达"（快速返回 JSON-RPC 错误，不关闭服务器——关掉端口会让 ethers 长时间重试） */
let rpcFails = false;

function handleRpc(j) {
  if (rpcFails) return { error: { code: -32000, message: 'unit-test: RPC 故意不可达' } };
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
      result: iface.encodeFunctionResult('getShop', [[
        v.host,
        v.seller,
        v.commissionBps,
        v.registeredAtBlock,
        v.hostSuspendedAtBlock,
        v.exitedAtBlock,
        v.code,
      ]]),
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

test('店主已退出（registeredAtBlock>0 && exitedAtBlock>0）⇒ 本地 listed=0 并落墓碑区块', async () => {
  const exitedSeller = '0x' + 'a1'.repeat(20);
  const liveSeller = '0x' + 'b2'.repeat(20);
  await db.run(
    `INSERT INTO shops (code, seller, name, notice, listed, commission_bps, registered_at_block)
     VALUES (?, ?, '', '', 1, 100, 5)`,
    '0000EXIT1',
    exitedSeller
  );
  await db.run(
    `INSERT INTO shops (code, seller, name, notice, listed, commission_bps, registered_at_block)
     VALUES (?, ?, '', '', 1, 100, 6)`,
    '0000KEEP1',
    liveSeller
  );
  chainShops.set(exitedSeller, { registeredAtBlock: 10, exitedAtBlock: 20, code: '0000EXIT1', commissionBps: 300 });
  chainShops.set(liveSeller, { registeredAtBlock: 11, exitedAtBlock: 0, code: '0000KEEP1', commissionBps: 200, listed: true });

  const r = await reconcileOnce();
  assert.ok(r.changed >= 2, `两家店都应被更新（实际 changed=${r.changed}）`);

  const exited = await db.get('SELECT listed, exited_at_block, commission_bps, registered_at_block FROM shops WHERE code = ?', '0000EXIT1');
  assert.equal(Number(exited.listed), 0, '已注销的店必须退出在售列表（旧实现会一直停在 1）');
  assert.equal(Number(exited.exited_at_block), 20, '墓碑区块要落库，供"能否重新申请开店"判据使用');
  assert.equal(Number(exited.commission_bps), 300);
  assert.equal(Number(exited.registered_at_block), 10);

  const live = await db.get('SELECT listed, exited_at_block, commission_bps FROM shops WHERE code = ?', '0000KEEP1');
  assert.equal(Number(live.listed), 1, '在售店照常');
  assert.equal(Number(live.exited_at_block), 0);
  assert.equal(Number(live.commission_bps), 200);

  // 读不到链（RPC 报错）：不得把任何行写成"已注销"（三态纪律：读不到 ≠ 已退出）
  rpcFails = true;
  const before = await db.get('SELECT listed, exited_at_block FROM shops WHERE code = ?', '0000EXIT1');
  await reconcileOnce();
  const after = await db.get('SELECT listed, exited_at_block FROM shops WHERE code = ?', '0000EXIT1');
  assert.deepEqual(after, before, '链不可达时一个字节都不写');
  rpcFails = false;
});
