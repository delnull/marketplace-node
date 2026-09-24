#!/usr/bin/env node
/**
 * 部署期链上登记：用店主私钥当场注册/更新本店到 Registry（防他人抢注你的域名）。
 *
 * 背景（docs/ARCHITECTURE.md §2.2）：registerNode 允许"代注册"（首次注册可他人代付），
 * 因此**任何钱包都可以抢先占用一个未登记的 endpoint**（链上无法验证域名归属）——
 * 唯一可靠的先手权是 operator（店主）私钥签名。本脚本把登记前移到部署期：
 * 店主密钥当场签名 keccak256(abi.encode(endpoint, escrowAddress, chainId, registryAddress))
 * （四字段 + EIP-191 personal；见 contracts/src/MarketplaceRegistry.sol 的 _checkRegisterSig）
 * 并广播 registerNode，operator=密钥属主，抢注窗口消除。网页「开店向导」路径保留（未用本脚本时）。
 *
 * 用法：
 *   node scripts/register-node.mjs --endpoint https://shop.example.com [--owner 0x…]
 *   环境变量：
 *     MK_RPC_URL           默认 https://mainnet.bityuan.com/eth
 *     MK_REGISTRY_ADDRESS / MK_ESCROW_ADDRESS  必填（缺失即拒绝；勿填旧版 v2 联调地址——
 *                           其 ABI/签名为含 metaJson 三段，与本脚本不兼容）
 *     私钥（与 e2e-mainnet/部署脚本同一约定，禁入库）：
 *       DEPLOYER_PRIVATE_KEY=0x…     或
 *       MK_KEY_FILE=/path/key         或默认 %TEMP%/tmp mk-deploy.key
 *   --owner 0x…：私钥派生地址必须等于它；未传时自动读取 node/.env 的 MK_SHOP_OWNER 校验
 *     （两者都不匹配则拒绝登记——operator 落错店是事后极难纠正的错误）
 *
 * 安全注意：密钥仅用于本次签名与广播（不写盘、不入 .env、不打印）；
 * 广播后 operator=该密钥属主（可注销/转让），请按店主私钥同等保护——登记完成即可删除临时密钥文件。
 * exit code：0=登记成功并核验通过；1=失败（错误打印到 stderr）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, JsonRpcProvider, Contract, keccak256, AbiCoder, getBytes } from 'ethers';

/* ── 参数 ── */
const args = process.argv.slice(2);
const argVal = (name, fb = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fb;
};
// endpoint 规范化后再签名/广播：小写 + 去尾斜杠（链上唯一性按原始字节——大小写变体会
// 被链上当作不同 endpoint 占用，审计 2026-09；本仓库向导同规则）
const ENDPOINT = (argVal('--endpoint', '') || process.env.MK_REGISTER_ENDPOINT || '').trim().toLowerCase().replace(/\/+$/, '');
const OWNER_ARG = (argVal('--owner', '') || '').toLowerCase();
if (args.includes('-h') || args.includes('--help')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 30).join('\n'));
  process.exit(0);
}

const RPC = process.env.MK_RPC_URL || 'https://mainnet.bityuan.com/eth';
const REGISTRY = process.env.MK_REGISTRY_ADDRESS || '';
const ESCROW = process.env.MK_ESCROW_ADDRESS || '';

const fail = (msg) => {
  console.error(`❌ 链上登记失败：${msg}`);
  process.exit(1);
};
if (!/^https:\/\/[^\s/]+/i.test(ENDPOINT)) fail('endpoint 需为 https:// 开头的公网地址（--endpoint 或 MK_REGISTER_ENDPOINT）');
if (!/^0x[0-9a-fA-F]{40}$/.test(REGISTRY)) fail('缺少 Registry 合约地址（MK_REGISTRY_ADDRESS）');
if (!/^0x[0-9a-fA-F]{40}$/.test(ESCROW)) fail('缺少 canonical Escrow 托管地址（MK_ESCROW_ADDRESS）——须与节点 .env 一致');

/* ── 私钥（与 e2e-mainnet/部署脚本同一约定，禁入库）── */
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
  console.error('❌ 缺少店主私钥：设置 $env:DEPLOYER_PRIVATE_KEY=0x… 或将私钥写入 ' + path.join(os.tmpdir(), 'mk-deploy.key') + '（MK_KEY_FILE 可改路径）。登记完成后建议立即删除该临时文件');
  process.exit(1);
}

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const owner = new Wallet(OWNER_PK.startsWith('0x') ? OWNER_PK : '0x' + OWNER_PK, provider);
const ownerAddr = owner.address.toLowerCase();
// 登记属主校验（operator 落错店事后极难纠正——双重防线）：
// ① --owner 与私钥派生地址必须一致；② 未传 --owner 时自动加载 node/.env 的 MK_SHOP_OWNER 比对
const ENV_FILE = process.env.MK_ENV_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
function readEnvOwner() {
  try {
    const txt = fs.readFileSync(ENV_FILE, 'utf8');
    const m = txt.match(/^MK_SHOP_OWNER\s*=\s*(\S+)\s*$/m);
    return m ? m[1].trim().toLowerCase() : null;
  } catch {
    return null;
  }
}
const envOwner = readEnvOwner();
if (OWNER_ARG && OWNER_ARG !== ownerAddr) {
  fail(`私钥派生地址 ${ownerAddr} 与 --owner ${OWNER_ARG} 不一致——登记 operator 必须是店主本人地址`);
}
if (envOwner && envOwner !== ownerAddr) {
  fail(`私钥派生地址 ${ownerAddr} 与 node/.env 的 MK_SHOP_OWNER=${envOwner} 不一致——登记 operator 必须等于店主（节点身份锚点）；如确属换店主请先更新 .env 再登记`);
}
if (!OWNER_ARG && !envOwner) {
  console.warn('  ⚠ 未提供 --owner 且 node/.env 无 MK_SHOP_OWNER：将以私钥派生地址作为 operator 登记，请确认该地址就是店主');
}

/* ── BTY 兼容：交易确认轮询走原始 JSON-RPC（系统交易会击穿 ethers tx.wait，勿改回）── */
// 2026-09 复核：显式 15s 超时——RPC 挂起时轮询/签名前读取不得无限等待（fetch 默认无超时）
const rpc = async (method, params) => {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};

const REGISTRY_ABI = [
  'function registerNode(address operator, string endpoint, address escrowAddress, bytes signature)',
  // NodeInfo 共 **8** 个字段（末尾是店铺编号 code）——少写一个不会立刻报错（末尾字段缺失时
  // ethers 仍能解码前面的），但 .code 恒为 undefined，属潜伏错位（源码审计 2026-09 复审，P3）
  'function getActiveNodes() view returns (tuple(address operator, string endpoint, address escrowAddress, uint64 registeredAtBlock, uint64 updatedAtBlock, bool active, bool suspended, string code)[])',
];

async function main() {
  console.log(`登记 operator=${ownerAddr} endpoint=${ENDPOINT} escrow=${ESCROW} registry=${REGISTRY}`);
  // 注册签名绑定链与合约实例（digest = keccak256(abi.encode(endpoint, escrow, chainId, registry))）
  const chainIdHex = await rpc('eth_chainId', []);
  const chainId = parseInt(chainIdHex, 16);
  console.log(`  ① 绑定消息签名 keccak256(abi.encode(endpoint, escrowAddress, chainId=${chainId}, registry=${REGISTRY})) …`);
  const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'address', 'uint256', 'address'], [ENDPOINT, ESCROW, chainId, REGISTRY]));
  const signature = await owner.signMessage(getBytes(digest));

  console.log('  ② 广播 registerNode（首次注册/更新/重新激活同函数；需要少量 BTY 支付 gas）…');
  const registry = new Contract(REGISTRY, REGISTRY_ABI, owner);
  const tx = await registry.registerNode(ownerAddr, ENDPOINT, ESCROW, signature);
  console.log(`    tx: ${tx.hash}`);

  let lastErr = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const rc = await rpc('eth_getTransactionReceipt', [tx.hash]);
      if (rc && rc.status !== undefined) {
        if (parseInt(rc.status, 16) !== 1) fail(`交易失败（status=0，block ${parseInt(rc.blockNumber, 16)}）——请核对 endpoint 是否已被他人占用（EndpointTaken）或密钥余额`);
        console.log(`    confirmed block=${parseInt(rc.blockNumber, 16)}`);
        break;
      }
    } catch (e) {
      lastErr = e; // 网络抖动：继续轮询
    }
    if (i === 39) fail(`交易未在时限内确认（${lastErr?.message || 'RPC 无响应'}）——稍后可重跑本脚本或到网页「开店向导」补登记`);
  }

  console.log('  ③ 核验 getActiveNodes() …');
  const rows = await registry.getActiveNodes();
  const mine = rows.find((n) => n.operator.toLowerCase() === ownerAddr && n.endpoint.replace(/\/+$/, '').toLowerCase() === ENDPOINT.toLowerCase());
  if (!mine) fail('登记已上链但活跃列表中未查到本店——请稍后到网页「开店向导」核对状态');
  console.log(`✅ 登记成功：operator=${mine.operator} endpoint=${mine.endpoint} escrow=${mine.escrowAddress} registeredAtBlock=${mine.registeredAtBlock}`);
  console.log('  买家聚合首页将直连本店（交叉核验托管地址一致后显示绿条）。');
  console.log('  提示：若刚才是临时密钥文件登记，请立即删除该文件（operator 权限=店主私钥权限）。');
}

main().catch((e) => {
  console.error('❌ 链上登记失败：', e?.message || e);
  process.exit(1);
});
