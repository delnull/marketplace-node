#!/usr/bin/env node
/**
 * 主网 E2E 冒烟验收（只读业务 + 真实托管资金，金额很小）：
 *
 * 验证「合约 ↔ 联邦节点 ↔ 主网事件轮询」全链路：
 *   店主登录 → 上架数字商品 + 码池 → 买家登录下单（quantity）→ 链上 createOrder 真实托管
 *   → POST /paid 四要素校验 → 自动发码置 shipped → 买家 confirmReceipt → watcher 回写 confirmed
 *   → 卖家流水入账。目录登记不在此脚本里：由 operator 在浏览器钱包完成，节点不持私钥。
 *
 * 前置：
 *   1) 一个连到目标 Escrow 的节点实例已在运行（MK_PORT 等由你配置），店主=下方 owner；
 *   2) owner 私钥经 DEPLOYER_PRIVATE_KEY 环境变量或 %TEMP%\mk-deploy.key（MK_KEY_FILE 可改）；
 *   3) 买家钱包由脚本自动生成并从 owner 转入小额测试资金（--fund-wei，默认 0.05 BTY，
 *      足够 2 单固定支付/多单汇率支付；用完即弃——测试资金不回收，余额极小）。
 *
 * 用法（示例：node 起在 18080）：
 *   node scripts/e2e-mainnet.mjs [--node http://127.0.0.1:18080] [--quantity 2] [--price-usdt-micro 100000000]
 *   （--price-usdt-micro 是**微 USDT**：1 USDT = 1e6，默认 1e8 = 100 USDT）
 *   环境变量：MK_RPC_URL / MK_ESCROW_ADDRESS / MK_STAKING_ADDRESS（**后三者必填**）
 *   --fund-wei N：给新买家转账金额（默认 5e15）
 *   --skip-buyer-fund：不转账（买家余额已足够时）
 *   exit code：0=通过；1=失败（错误会打印到 stderr）
 *
 * 注意：BTY 链上交易的确认轮询走原始 JSON-RPC（ethers tx.wait 会被系统交易解析击穿，勿改回）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet, JsonRpcProvider, Contract, formatEther } from 'ethers';

/* ── 参数 ── */
const args = process.argv.slice(2);
const argVal = (name, fb = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fb;
};
const NODE_URL = argVal('--node', 'http://127.0.0.1:18080');
const QUANTITY = Number(argVal('--quantity', '2'));
const PRICE_MICRO = Number(argVal('--price-usdt-micro', '100000000')); // 1e8 微 = 100 USDT
const FUND_WEI = args.includes('--skip-buyer-fund') ? 0n : BigInt(argVal('--fund-wei', '50000000000000000'));
// 默认 0.05 BTY：BTY 主网要求余额 ≥ 10×gas 费，托管 0.001 + createOrder/confirm 两笔 tx 的 10 倍费 ≈ 0.027 BTY

const RPC = process.env.MK_RPC_URL || 'https://mainnet.bityuan.com/eth';
// 缺参数即 fail-fast（可读提示，而不是拿空地址去打 RPC 得到晦涩报错）
const ESCROW = process.env.MK_ESCROW_ADDRESS || '';
const STAKING = process.env.MK_STAKING_ADDRESS || '';
if (!/^0x[0-9a-fA-F]{40}$/.test(ESCROW) || !/^0x[0-9a-fA-F]{40}$/.test(STAKING)) {
  console.error('缺少/非法 MK_ESCROW_ADDRESS / MK_STAKING_ADDRESS（须为 0x+40 hex）。');
  console.error('  例：MK_ESCROW_ADDRESS=0x… MK_STAKING_ADDRESS=0x… npm run e2e');
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
    media: [], kind: 'digital', priceUsdtMicro: PRICE_MICRO,
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
  /*
    零费模型：`createOrder(orderId, seller, amount, timeoutBlocks)` 只有四个参数——
    没有店铺条款、没有抽成收款人。店铺/商品/订单明细全在节点链下。
  */
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
    净额断言（零费模型）：这笔单没有退款 ⇒ **净额必须逐字等于毛额**。
    合约的结算只有退款 + 卖家两条腿，任何差额都说明账本口径错了。
  */
  const net = BigInt(ledger.summary.amountWeiNet);
  const gross = BigInt(ledger.summary.amountWei);
  const refunded = BigInt(ledger.summary.refundedWei ?? '0');
  if (refunded !== 0n) throw new Error(`验收单不该有退款（refunded=${refunded}）`);
  if (net !== gross || net !== amount) {
    throw new Error(`流水净额异常：净额 ${net} / 毛额 ${gross} / 托管 ${amount} 应当三者相等`);
  }

  step('7. 事件史完整性（OrderCreated/ReceiptConfirmed 已在详情时间线）');
  const events = (finalOrder.onchainEvents || []).map((e) => e.name);
  console.log(`事件史: ${events.join(' → ')}`);
  if (!events.includes('OrderCreated') || !events.includes('ReceiptConfirmed')) throw new Error('事件史缺关键里程碑');

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
