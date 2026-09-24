#!/usr/bin/env node
/**
 * 主网 E2E 冒烟验收（只读业务 + 真实托管资金，金额很小）：
 *
 * 验证「合约 ↔ 联邦节点 ↔ 主网事件轮询」全链路：
 *   店主登录 → 上架数字商品 + 码池 → 买家登录下单（quantity）→ 链上 createOrder 真实托管
 *   → POST /paid 四要素校验 → 自动发码置 shipped → 买家 confirmReceipt → watcher 回写 confirmed
 *   → 卖家流水入账 →（可选）Registry 登记（四字段签名 endpoint+escrowAddress+chainId+registryAddress）并验证 getActiveNodes。
 *
 * 前置：
 *   1) 一个连到目标 Escrow 的节点实例已在运行（MK_PORT 等由你配置），店主=下方 owner；
 *   2) owner 私钥经 DEPLOYER_PRIVATE_KEY 环境变量或 %TEMP%\mk-deploy.key（MK_KEY_FILE 可改）；
 *   3) 买家钱包由脚本自动生成并从 owner 转入小额测试资金（--fund-wei，默认 0.05 BTY，
 *      足够 2 单固定支付/多单汇率支付；用完即弃——测试资金不回收，余额极小）。
 *
 * 用法（示例：node 起在 18080、注册 Registry）：
 *   node scripts/e2e-mainnet.mjs [--node http://127.0.0.1:18080] [--register] [--quantity 2] [--price-fen 10000]
 *   环境变量：MK_RPC_URL / MK_ESCROW_ADDRESS / MK_REGISTRY_ADDRESS（**后两者必填**：源码审计 2026-09 已
 *             移除内置的 v2 联调默认地址——那组地址是三段含 metaJson 签名的旧版 Registry，与当前
 *             ABI/签名规则不兼容，按默认值跑只会回滚；请指向上线重部署版地址，
 *             见 README「部署状态」与 docs/DEPLOY_NODE.md §4.2）
 *   --register：把本店登记到 MK_REGISTRY_ADDRESS（四字段签名
 *                abi.encode(endpoint, escrowAddress, chainId, registryAddress) + EIP-191，且本脚本
 *                ABI 无 metaJson——**仅适用于"上线重部署版"Registry（NodeInfo 无 metaJson）**；
 *                v2 联调合约（0x8a59d7…7138）仍为三段含 metaJson 签名，勿与 --register 混用）
 *   --deregister：对 Registry 执行 deregisterNode（仅 operator 本人；同样需新版 Registry）
 *   --fund-wei N：给新买家转账金额（默认 5e15）
 *   --skip-buyer-fund：不转账（买家余额已足够时）
 *   exit code：0=通过；1=失败（错误会打印到 stderr）
 *
 * 注意：BTY 链上交易的确认轮询走原始 JSON-RPC（ethers tx.wait 会被系统交易解析击穿，勿改回）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet, JsonRpcProvider, Contract, keccak256, AbiCoder, getBytes, formatEther } from 'ethers';

/* ── 参数 ── */
const args = process.argv.slice(2);
const argVal = (name, fb = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fb;
};
const NODE_URL = argVal('--node', 'http://127.0.0.1:18080');
const DO_REGISTER = args.includes('--register');
const DO_DEREGISTER = args.includes('--deregister');
const ENDPOINT = (argVal('--endpoint', '') || NODE_URL).replace(/\/+$/, '');
const QUANTITY = Number(argVal('--quantity', '2'));
const PRICE_FEN = Number(argVal('--price-fen', '10000'));
const FUND_WEI = args.includes('--skip-buyer-fund') ? 0n : BigInt(argVal('--fund-wei', '50000000000000000'));
// 默认 0.05 BTY：BTY 主网要求余额 ≥ 10×gas 费，托管 0.001 + createOrder/confirm 两笔 tx 的 10 倍费 ≈ 0.027 BTY

const RPC = process.env.MK_RPC_URL || 'https://mainnet.bityuan.com/eth';
/*
  托管/注册地址**必须显式提供**（源码审计 2026-09 修复）：此前这里默认填 v2 联调地址
  （Escrow 0x3a22… / Registry 0x8a59…）。那组地址的 Registry 用「含 metaJson 的三段签名」，
  与当前代码的两段/四字段签名 ABI 不兼容——按默认值跑 `npm run e2e -- --register` 必然回滚，
  而 docs/DEPLOY_NODE.md 又明令「勿填 v2 联调地址」，文档与脚本互为矛盾。
  宁可缺参数直接报错（下方有可读提示），也不要让人以为"默认就能跑通"。
*/
const ESCROW = process.env.MK_ESCROW_ADDRESS || '';
const REGISTRY = process.env.MK_REGISTRY_ADDRESS || '';
// 缺参数即 fail-fast（可读提示，而不是拿空地址去打 RPC 得到晦涩报错）
if (!/^0x[0-9a-fA-F]{40}$/.test(ESCROW) || !/^0x[0-9a-fA-F]{40}$/.test(REGISTRY)) {
  console.error('缺少/非法 MK_ESCROW_ADDRESS 或 MK_REGISTRY_ADDRESS（须为 0x+40 hex）。');
  console.error('  例：MK_ESCROW_ADDRESS=0x… MK_REGISTRY_ADDRESS=0x… npm run e2e -- --register');
  console.error('  注意：不要填 v2 联调地址（三段含 metaJson 签名的旧版 Registry，与当前 ABI/签名不兼容）。');
  process.exit(1);
}

/* ── 私钥（owner=店主；与 deploy-mainnet 同约定，禁入库）── */
function loadPrivateKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY;
  const keyFile = process.env.MK_KEY_FILE || path.join(os.tmpdir(), 'mk-deploy.key');
  try {
    if (fs.existsSync(keyFile)) {
      const v = fs.readFileSync(keyFile, 'utf8').trim();
      if (v) return v;
    }
  } catch {
    /* ignore */
  }
  return null;
}
const OWNER_PK = loadPrivateKey();
if (!OWNER_PK) {
  console.error('缺少店主私钥：设置 $env:DEPLOYER_PRIVATE_KEY 或写私钥到 %TEMP%\\mk-deploy.key（MK_KEY_FILE 可改）');
  process.exit(1);
}

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const owner = new Wallet(OWNER_PK.startsWith('0x') ? OWNER_PK : '0x' + OWNER_PK, provider);

/* ── BTY 兼容工具（确认轮询走原始 JSON-RPC）── */
const rpc = async (method, params) => {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastTxHash = null;
async function broadcast(txPromise, label) {
  const tx = await txPromise;
  lastTxHash = tx.hash;
  console.log(`  tx ${label}: ${tx.hash}`);
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const rc = await rpc('eth_getTransactionReceipt', [tx.hash]);
    if (rc && rc.status !== undefined) {
      console.log(`  ${label} confirmed block=${parseInt(rc.blockNumber, 16)} status=${parseInt(rc.status, 16)}`);
      if (parseInt(rc.status, 16) !== 1) throw new Error(`${label} 交易失败（status=0）`);
      return rc;
    }
  }
  throw new Error(`${label} 未在时限内确认`);
}

/* ── 节点 API ── */
async function api(method, nodePath, body, token) {
  const res = await fetch(NODE_URL + nodePath, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`API ${method} ${nodePath} 失败: ${j.message}`);
  return j.data;
}
const login = async (wallet) => {
  const { message } = await api('GET', `/api/auth/nonce?address=${wallet.address}`);
  const signature = await wallet.signMessage(message);
  return api('POST', '/api/auth/login', { address: wallet.address, message, signature }).then((d) => d.token);
};

const step = (s) => console.log(`\n== ${s} ==`);

const ESCROW_ABI = [
  'function createOrder(bytes32 orderId, address seller, uint256 amount, uint64 timeoutBlocks) payable',
  'function confirmReceipt(bytes32 orderId)',
];
const REGISTRY_ABI = [
  'function registerNode(address operator, string endpoint, address escrowAddress, bytes signature)',
  'function deregisterNode()',
  // getActiveNodes 的 tuple 必须与 contracts/src/MarketplaceRegistry.sol 的 NodeInfo 逐字对应：
  // 末尾的 string code（店铺编号，8 位 Crockford Base32）不可省——ABI 字段数不符时 ethers
  // 解码结果整体错位（code 会读成空/报错），冒烟脚本的"注销后本店应不在列"判定随之失真
  'function getActiveNodes() view returns (tuple(address operator, string endpoint, address escrowAddress, uint64 registeredAtBlock, uint64 updatedAtBlock, bool active, bool suspended, string code)[])',
];

async function waitOrderStatus(id, token, targets, tries = 20, intervalMs = 4000) {
  let order = null;
  for (let i = 0; i < tries; i++) {
    await sleep(intervalMs);
    const res = await fetch(NODE_URL + `/api/orders/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    order = (await res.json()).data;
    if (targets.includes(order.status)) break;
  }
  return order;
}

async function main() {
  // --deregister：仅注销本店登记，不跑交易链路
  if (DO_DEREGISTER) {
    step('注销 Registry 登记');
    const registry = new Contract(REGISTRY, REGISTRY_ABI, owner);
    await broadcast(registry.deregisterNode(), 'deregisterNode');
    const nodes = await registry.getActiveNodes();
    console.log(`注销后 getActiveNodes()=${nodes.length}（本店应不在列）`);
    return;
  }

  const tag = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const buyer = Wallet.createRandom().connect(provider);
  const health = await api('GET', '/healthz');
  console.log(`节点 ${NODE_URL} escrow=${health.escrowAddress} 店主=${health.owner}`);
  if ((health.escrowAddress || '').toLowerCase() !== ESCROW.toLowerCase()) {
    throw new Error(`节点托管地址 ${health.escrowAddress} 与目标 Escrow ${ESCROW} 不一致（先检查节点 .env）`);
  }

  step('0. 买家资金准备');
  if (FUND_WEI > 0n) {
    console.log(`给买家 ${buyer.address} 转 ${formatEther(FUND_WEI)} BTY`);
    await broadcast(owner.sendTransaction({ to: buyer.address, value: FUND_WEI }), 'fundBuyer');
  } else {
    console.log('跳过转账（--skip-buyer-fund）');
  }

  step('1. 店主登录 + 上架数字商品 + 码池');
  const ownerToken = await login(owner);
  const product = await api('POST', '/api/products', {
    title: `E2E 冒烟 ${tag}`, description: '主网全链路验收商品（脚本自动生成）',
    images: [], kind: 'digital', priceCnyFen: PRICE_FEN,
  }, ownerToken);
  console.log(`商品 ${product.slug} snapshotHash=${product.snapshotHash.slice(0, 18)}…`);
  const codes = Array.from({ length: 6 }, (_, i) => `E2E-${tag}-${i + 1}`);
  const pool = await api('POST', `/api/products/${product.slug}/codes`, { codes }, ownerToken);
  console.log(`码池导入 imported=${pool.imported}`);

  step('2. 买家登录 + 下单草稿（quantity=' + QUANTITY + '）');
  const buyerToken = await login(buyer);
  const draft = await api('POST', '/api/orders', { productSlug: product.slug, quantity: QUANTITY }, buyerToken);
  console.log(`draft ${draft.id} 金额=${draft.amountWei} wei（固定支付/汇率锁定） orderId=${draft.escrowOrderId.slice(0, 18)}…`);

  step('3. 买家链上 createOrder（真实托管）');
  const escrow = new Contract(ESCROW, ESCROW_ABI, buyer);
  const amount = BigInt(draft.amountWei);
  await broadcast(
    escrow.createOrder(draft.escrowOrderId, draft.seller, amount, BigInt(draft.timeoutBlocks ?? 0), { value: amount }),
    'createOrder'
  );

  step('4. POST /paid（日志四要素校验 → escrowed → 自动发码）');
  const paid = await api('POST', `/api/orders/${draft.id}/paid`, { txHash: lastTxHash }, buyerToken);
  console.log(`paid: status=${paid.status} autoDelivered=${paid.autoDelivered}`);
  // watcher 5s 轮询可能先于 paid 完成回写+自动交付（shipped）——两种都表示托管已确认且幂等通过
  if (paid.status !== 'escrowed' && paid.status !== 'shipped') throw new Error(`paid 后应 escrowed/shipped，实际 ${paid.status}`);

  step('5. 等待自动交付 shipped');
  const shippedOrder = await waitOrderStatus(draft.id, buyerToken, ['shipped', 'confirmed']);
  if (shippedOrder.status !== 'shipped') throw new Error(`预期 shipped，实际 ${shippedOrder.status}`);
  console.log(`订单 ${shippedOrder.status} 交付码=${shippedOrder.deliveries.map((d) => d.value).join(',')}`);
  if (shippedOrder.deliveries.length !== QUANTITY) throw new Error(`应交付 ${QUANTITY} 个码`);
  if (!shippedOrder.paidTxHash) throw new Error('缺链上支付凭证（paid_tx_hash）');

  step('6. 买家 confirmReceipt → watcher 回写 confirmed → 流水入账');
  await broadcast(escrow.confirmReceipt(draft.escrowOrderId), 'confirmReceipt');
  const finalOrder = await waitOrderStatus(draft.id, buyerToken, ['confirmed', 'settled', 'expired'], 15);
  if (finalOrder.status !== 'confirmed') throw new Error(`预期 confirmed，实际 ${finalOrder.status}`);
  const ledger = await api('GET', '/api/orders/seller/ledger', undefined, ownerToken);
  console.log(`流水: 单数=${ledger.total} 净额=${ledger.summary.amountWeiNet} wei`);
  if (ledger.total < 1) throw new Error('流水未入账');
  /*
    净额断言（源码审计 2026-09 复审修复，P2）：原先是 `if (net < amount) throw new Error('流水净额异常')`
    —— 这在**任何真的会扣平台费的部署上必然误报**：账本口径是 `net = amount − refunded − fee`
    （与合约 `_settle` 的 `sellerNet = (amount − refundWei) − fee` 逐字同源），
    所以只要创建订单时 `feeBps > 0` 且 `feeCollectorAtCreate ≠ 0`，net 就**必然小于** amount。
    而这是文档指定的主网验收流程（`PRODUCT_BOUNDARIES.md` §6），运维会拿到一个假失败，
    进而把"平台费按单快照生效"误诊成账目错误——正好怀疑刚上线的那套按单费口径。

    改成断言"净额落在应然区间"：上界 = amount（未扣费时），下界 = amount − amount×费率上限
    （`MAX_FEE_BPS = 1000` = 10%，链上强制；比逐单读链上费率更稳，也不必额外打 RPC）。
    再多断一条自洽：净额 = 毛额 − 已退 − 平台费（三个数都在同一份 summary 里）。
  */
  const net = BigInt(ledger.summary.amountWeiNet);
  const gross = BigInt(ledger.summary.amountWei);
  const fee = BigInt(ledger.summary.feeWei ?? '0');
  const refunded = BigInt(ledger.summary.refundedWei ?? '0');
  const minNet = amount - (amount * 1000n) / 10000n; // 扣满 10% 的下界（MAX_FEE_BPS）
  if (net > amount) throw new Error(`流水净额异常：${net} > 毛托管额 ${amount}（净额不可能超过毛额）`);
  if (net < minNet) throw new Error(`流水净额异常：${net} < 下界 ${minNet}（最大费率 10% 也扣不到这么多）`);
  if (gross - refunded - fee !== net) {
    throw new Error(`流水口径不自洽：毛额 ${gross} − 已退 ${refunded} − 平台费 ${fee} ≠ 净额 ${net}`);
  }

  step('7. 事件史完整性（OrderCreated/ReceiptConfirmed 已在详情时间线）');
  const events = (finalOrder.onchainEvents || []).map((e) => e.name);
  console.log(`事件史: ${events.join(' → ')}`);
  if (!events.includes('OrderCreated') || !events.includes('ReceiptConfirmed')) throw new Error('事件史缺关键里程碑');

  if (DO_REGISTER) {
    step('8. Registry 注册（绑定消息签名：endpoint+escrow+chainId+registry；注意 signMessage 须 getBytes）');
    const chainId = parseInt(await rpc('eth_chainId', []), 16);
    const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'address', 'uint256', 'address'], [ENDPOINT, ESCROW, chainId, REGISTRY]));
    const sig = await owner.signMessage(getBytes(digest));
    const registry = new Contract(REGISTRY, REGISTRY_ABI, owner);
    await broadcast(registry.registerNode(owner.address, ENDPOINT, ESCROW, sig), 'registerNode');
    const nodes = await registry.getActiveNodes();
    const mine = nodes.find((n) => n.operator.toLowerCase() === owner.address.toLowerCase());
    if (!mine || mine.escrowAddress.toLowerCase() !== ESCROW.toLowerCase()) throw new Error('Registry 登记验证失败');
    console.log(`已登记: endpoint=${mine.endpoint} escrow=${mine.escrowAddress} registeredAtBlock=${mine.registeredAtBlock}`);
  }

  console.log('\n✅ E2E 验收通过（合约 ↔ 节点 ↔ 主网事件轮询全链路）');
  console.log(JSON.stringify({
    productSlug: product.slug, orderId: draft.id, escrowOrderId: draft.escrowOrderId,
    amountWei: draft.amountWei, buyer: buyer.address, deliveries: shippedOrder.deliveries.map((d) => d.value),
    createOrderTx: lastTxHash, ledgerNetWei: ledger.summary.amountWeiNet,
  }, null, 2));
  console.log(`买家测试账户（余额不再使用，请忽略）: ${buyer.address}`);
}

main().catch((e) => {
  console.error('\nE2E 失败:', e.message || e);
  process.exit(1);
});
