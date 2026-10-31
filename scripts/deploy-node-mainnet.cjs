#!/usr/bin/env node
'use strict';

/**
 * 节点侧合约主网部署（chainId 2999）。
 *
 * 为什么需要这个脚本：BTY 主网 RPC 不支持 EIP-1898 的区块对象，而 forge script 在
 * 广播前会用 `{ blockHash, requireCanonical }` 查 nonce/code，直接报
 * `invalid argument 1: json: cannot unmarshal object into Go value of type string`。
 * 这里用 ethers 的完整 sendTransaction 路径广播，读操作全部走原始 JSON-RPC（字符串
 * block tag），避开该不兼容。
 *
 * 顺序与 contracts/script/DeployNode.s.sol 一致：
 *   TokenPayoutVault → Escrow → vault.setEscrow → Staking → escrow.setStaking
 *   → escrow.setArbiters → NodeGovernance → escrow.setGovernor → staking.setGovernor
 *
 * 只部署节点自己的四个合约，不登记任何 Registry。
 *
 * 用法：
 *   node scripts/deploy-node-mainnet.cjs --check       # 只读预检，不广播
 *   node scripts/deploy-node-mainnet.cjs --broadcast   # 部署并链上复核
 *
 * 环境变量：
 *   DEPLOYER_PRIVATE_KEY  operator 私钥（也可用 MK_KEY_FILE 指向文件）
 *   ARBITERS              逗号分隔的委员会地址，至少 3 个
 *   ARBITER_THRESHOLD     可选，默认多数；必须小于人数
 *   REJECT_GRACE_BLOCKS / MIN_TIMEOUT_BLOCKS / AFTER_SALE_WINDOW_BLOCKS 可选
 *   MK_RPC_URL            默认 https://node1.bityuan.com/eth
 *   MK_GAS_PRICE          可选，覆盖 RPC 的 eth_gasPrice
 *   MK_MIN_BALANCE        可选，最低余额（BTY），默认 0.05
 */

const fs = require('fs');
const path = require('path');
const {
  Wallet,
  JsonRpcProvider,
  Interface,
  AbiCoder,
  keccak256,
  parseUnits,
  formatEther,
} = require('ethers');

const HERE = __dirname;
const NODE_ROOT = path.resolve(HERE, '..');
/**
 * 随本包提供**已编译**的字节码（`contract-artifacts.json`，由本仓
 * `scripts/build-contract-artifacts.mjs` 从 contracts/out 生成）。主网部署不再要求
 * 店主本地装 Foundry/编译：部署的就是这份清单里的完整 bytecode，runtime 哈希与它一一对应。
 */
const ARTIFACTS = path.join(NODE_ROOT, 'contract-artifacts.json');

const RPC = process.env.MK_RPC_URL || 'https://node1.bityuan.com/eth';
const CHAIN_ID = 2999;
const MIN_BALANCE = parseUnits(process.env.MK_MIN_BALANCE || '0.05', 'ether');
const CHECK = process.argv.includes('--check');
const BROADCAST = process.argv.includes('--broadcast');
const POLL_TIMES = 120;
const POLL_INTERVAL_MS = 3000;

/*
  BTY 主网按 gasLimit 扣费，未用完的 gas 不退：实测账户余额减少额 = 各笔 gasLimit × gasPrice。
  eth_estimateGas 在本网偏高（Escrow 估 7.8M、实际 5.5M），所以 gasLimit 按实测 gasUsed + ~10%
  固定，估算只用来确认这笔交易不会 revert，不用估算值当上限。
*/
const GAS = {
  vault: 660_000n,
  escrow: 6_100_000n,
  setEscrow: 55_000n,
  staking: 4_170_000n,
  setStaking: 50_000n,
  setArbitersBase: 270_000n,
  setArbitersPerExtra: 25_000n,
  governance: 1_830_000n,
  setEscrowGovernor: 45_000n,
  setStakingGovernor: 60_000n,
};

const abiCoder = AbiCoder.defaultAbiCoder();
const ZERO = '0x0000000000000000000000000000000000000000';
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function usage() {
  console.error('用法：node scripts/deploy-node-mainnet.cjs --check | --broadcast');
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadKey() {
  const direct = String(process.env.DEPLOYER_PRIVATE_KEY || '').trim();
  const file = process.env.MK_KEY_FILE || '';
  const key = direct || (file ? fs.readFileSync(file, 'utf8').trim() : '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die('缺少合法私钥：设 DEPLOYER_PRIVATE_KEY 或 MK_KEY_FILE');
  return key;
}

function loadArtifact(name) {
  if (!fs.existsSync(ARTIFACTS)) {
    die(`缺少公开编译产物：${ARTIFACTS}（仓库应随包提供；不要本地 forge build 后临时替换）`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(ARTIFACTS, 'utf8'));
  } catch (e) {
    die(`编译产物清单不是合法 JSON：${e?.message || e}`);
  }
  const j = (manifest.contracts || []).find((c) => c.name === name);
  if (!j) die(`${name}: 编译产物清单里没有这个合约`);
  const object = j.bytecode;
  if (!object || object === '0x') die(`${name}: bytecode 为空`);
  if (keccak256(object) !== j.creationCodeHash) die(`${name}: creationCodeHash 与 bytecode 不一致（清单被篡改/损坏）`);
  if (keccak256(j.deployedBytecode) !== j.runtimeCodeHash) die(`${name}: runtimeCodeHash 与 deployedBytecode 不一致`);
  return {
    abi: j.abi,
    iface: new Interface(j.abi),
    bytecode: object.startsWith('0x') ? object : `0x${object}`,
    runtimeCodeHash: j.runtimeCodeHash,
  };
}

function initcode(art, types, values) {
  const encoded = abiCoder.encode(types, values);
  return `${art.bytecode}${encoded.slice(2)}`;
}

function parseArbiters() {
  const raw = String(process.env.ARBITERS || '').trim();
  if (!raw) die('缺少 ARBITERS（逗号分隔，至少 3 个地址）');
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length < 3 || list.length > 20) die(`ARBITERS 人数必须在 3..20：当前 ${list.length}`);
  const seen = new Set();
  for (const a of list) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a) || same(a, ZERO)) die(`ARBITERS 里有非法地址：${a}`);
    if (seen.has(a.toLowerCase())) die(`ARBITERS 有重复地址：${a}`);
    seen.add(a.toLowerCase());
  }
  return list;
}

function envUint64(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return BigInt(fallback);
  if (!/^\d+$/.test(raw)) die(`${name} 不是十进制整数：${raw}`);
  const v = BigInt(raw);
  if (v > 0xffffffffffffffffn) die(`${name} 超出 uint64`);
  return v;
}

async function confirmGas(label, tx, gasLimit) {
  try {
    await rpc('eth_estimateGas', [tx]);
  } catch (e) {
    throw new Error(`${label} 的 eth_estimateGas 失败：${e.message}（这笔交易会被拒绝，拒绝盲发）`);
  }
  return gasLimit;
}

async function waitReceipt(hash) {
  for (let i = 0; i < POLL_TIMES; i++) {
    const rc = await rpc('eth_getTransactionReceipt', [hash]);
    if (rc && rc.blockNumber) {
      return {
        status: Number(rc.status),
        blockNumber: Number(rc.blockNumber),
        gasUsed: BigInt(rc.gasUsed),
        contractAddress: rc.contractAddress,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`等待回执超时：${hash}`);
}

async function main() {
  if (!CHECK && !BROADCAST) {
    usage();
    process.exit(1);
  }
  if (CHECK && BROADCAST) usage();

  const key = loadKey();
  const operator = new Wallet(key).address;
  const arbiters = parseArbiters();
  const thresholdRaw = Number(process.env.ARBITER_THRESHOLD || Math.floor(arbiters.length / 2) + 1);
  /*
    无条件 >= 2：threshold=1 会让任意一名委员单独完成结算/罚没（合约层已拒绝这个形状，
    脚本必须在发交易前给同一条拒因，而不是等链上 revert）。
  */
  if (!Number.isInteger(thresholdRaw) || thresholdRaw < 2 || thresholdRaw >= arbiters.length) {
    die(`ARBITER_THRESHOLD 必须是 2..${arbiters.length - 1} 的整数（单人阈值会让任意一名委员单独裁决）`);
  }
  const threshold = thresholdRaw;
  const rejectGrace = envUint64('REJECT_GRACE_BLOCKS', 17280);
  const minTimeout = envUint64('MIN_TIMEOUT_BLOCKS', 17280);
  const afterSale = envUint64('AFTER_SALE_WINDOW_BLOCKS', 3110400);

  const chainId = Number(await rpc('eth_chainId'));
  if (chainId !== CHAIN_ID) die(`RPC chainId=${chainId}，必须是 ${CHAIN_ID}`);
  const gasPrice = process.env.MK_GAS_PRICE
    ? BigInt(process.env.MK_GAS_PRICE)
    : BigInt(await rpc('eth_gasPrice'));
  const balance = BigInt(await rpc('eth_getBalance', [operator, 'latest']));
  const nonce = Number(await rpc('eth_getTransactionCount', [operator, 'pending']));

  const vaultArt = loadArtifact('TokenPayoutVault');
  const escrowArt = loadArtifact('Escrow');
  const stakingArt = loadArtifact('Staking');
  const govArt = loadArtifact('NodeGovernance');

  const setArbitersGas = GAS.setArbitersBase + GAS.setArbitersPerExtra * BigInt(Math.max(0, arbiters.length - 3));
  const totalGas =
    GAS.vault +
    GAS.escrow +
    GAS.setEscrow +
    GAS.staking +
    GAS.setStaking +
    setArbitersGas +
    GAS.governance +
    GAS.setEscrowGovernor +
    GAS.setStakingGovernor;
  const gasCost = gasPrice * totalGas;

  console.log(`RPC       : ${RPC}`);
  console.log(`chainId   : ${chainId}`);
  console.log(`operator  : ${operator}`);
  console.log(`arbiters  : ${arbiters.join(', ')}`);
  console.log(`threshold : ${threshold}`);
  console.log(`windows   : rejectGrace=${rejectGrace} minTimeout=${minTimeout} afterSale=${afterSale}`);
  console.log(`gasPrice  : ${gasPrice} wei`);
  console.log(`gasBudget : ${totalGas}（按 gasLimit 扣费，未用不退）`);
  console.log(`gasCost   : ${formatEther(gasCost)} BTY`);
  console.log(`balance   : ${formatEther(balance)} BTY`);
  console.log(`nonce     : ${nonce}`);
  console.log(`artifacts : ${ARTIFACTS}`);

  if (balance < MIN_BALANCE) die(`余额 ${formatEther(balance)} BTY 低于下限 ${formatEther(MIN_BALANCE)} BTY`);
  if (balance < gasCost) {
    die(`余额不足以覆盖 gasLimit 预算：需要 ${formatEther(gasCost)} BTY`);
  }

  if (CHECK) {
    console.log('\n预检通过：未广播。加 --broadcast 才会部署。');
    return;
  }

  const wallet = new Wallet(key, new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true }));
  let nonceNow = nonce;

  async function send(label, { to = null, data, gasLimit }) {
    const bal = BigInt(await rpc('eth_getBalance', [operator, 'latest']));
    if (bal < gasPrice * gasLimit) {
      throw new Error(`${label} 前余额不足：需要 ${formatEther(gasPrice * gasLimit)} BTY，当前 ${formatEther(bal)} BTY`);
    }
    const n = nonceNow++;
    const tx = await wallet.sendTransaction({
      type: 0,
      chainId: CHAIN_ID,
      nonce: n,
      gasPrice,
      gasLimit,
      data,
      ...(to ? { to } : {}),
    });
    console.log(`  ${label}: tx=${tx.hash} nonce=${n} gasLimit=${gasLimit}`);
    const rc = await waitReceipt(tx.hash);
    if (rc.status !== 1) throw new Error(`${label} 失败 status=${rc.status} tx=${tx.hash}`);
    console.log(`    block=${rc.blockNumber} gasUsed=${rc.gasUsed}${rc.contractAddress ? ` address=${rc.contractAddress}` : ''}`);
    return rc;
  }

  console.log('\n=== 部署 ===');

  const vaultData = initcode(vaultArt, ['address'], [operator]);
  const vaultGas = await confirmGas('TokenPayoutVault', { from: operator, data: vaultData }, GAS.vault);
  const vaultRc = await send('TokenPayoutVault', { data: vaultData, gasLimit: vaultGas });
  const vault = vaultRc.contractAddress;
  if (!vault) throw new Error('TokenPayoutVault 未返回合约地址');

  const escrowData = initcode(
    escrowArt,
    ['address', 'uint64', 'uint64', 'uint64', 'address'],
    [operator, rejectGrace, minTimeout, afterSale, vault]
  );
  const escrowGas = await confirmGas('Escrow', { from: operator, data: escrowData }, GAS.escrow);
  const escrowRc = await send('Escrow', { data: escrowData, gasLimit: escrowGas });
  const escrow = escrowRc.contractAddress;
  if (!escrow) throw new Error('Escrow 未返回合约地址');
  const startBlock = escrowRc.blockNumber;

  const setEscrowData = vaultArt.iface.encodeFunctionData('setEscrow', [escrow]);
  await send('vault.setEscrow', {
    to: vault,
    data: setEscrowData,
    gasLimit: await confirmGas('vault.setEscrow', { from: operator, to: vault, data: setEscrowData }, GAS.setEscrow),
  });

  const escrowCode = await rpc('eth_getCode', [escrow, 'latest']);
  const escrowCodeHash = keccak256(escrowCode);

  const stakingData = initcode(stakingArt, ['address', 'bytes32', 'address'], [escrow, escrowCodeHash, operator]);
  const stakingGas = await confirmGas('Staking', { from: operator, data: stakingData }, GAS.staking);
  const stakingRc = await send('Staking', { data: stakingData, gasLimit: stakingGas });
  const staking = stakingRc.contractAddress;
  if (!staking) throw new Error('Staking 未返回合约地址');

  const setStakingData = escrowArt.iface.encodeFunctionData('setStaking', [staking]);
  await send('escrow.setStaking', {
    to: escrow,
    data: setStakingData,
    gasLimit: await confirmGas('escrow.setStaking', { from: operator, to: escrow, data: setStakingData }, GAS.setStaking),
  });

  const setArbitersData = escrowArt.iface.encodeFunctionData('setArbiters', [arbiters, threshold]);
  await send('escrow.setArbiters', {
    to: escrow,
    data: setArbitersData,
    gasLimit: await confirmGas('escrow.setArbiters', { from: operator, to: escrow, data: setArbitersData }, setArbitersGas),
  });

  const govData = initcode(govArt, ['address', 'address'], [escrow, staking]);
  const govGas = await confirmGas('NodeGovernance', { from: operator, data: govData }, GAS.governance);
  const govRc = await send('NodeGovernance', { data: govData, gasLimit: govGas });
  const gov = govRc.contractAddress;
  if (!gov) throw new Error('NodeGovernance 未返回合约地址');

  const setEscrowGovData = escrowArt.iface.encodeFunctionData('setGovernor', [gov]);
  await send('escrow.setGovernor', {
    to: escrow,
    data: setEscrowGovData,
    gasLimit: await confirmGas('escrow.setGovernor', { from: operator, to: escrow, data: setEscrowGovData }, GAS.setEscrowGovernor),
  });

  const setStakingGovData = stakingArt.iface.encodeFunctionData('setGovernor', [gov]);
  await send('staking.setGovernor', {
    to: staking,
    data: setStakingGovData,
    gasLimit: await confirmGas('staking.setGovernor', { from: operator, to: staking, data: setStakingGovData }, GAS.setStakingGovernor),
  });

  console.log('\n=== 链上复核 ===');
  async function call(to, iface, fn, args = []) {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await rpc('eth_call', [{ to, data }, 'latest']);
    if (!raw || raw === '0x') throw new Error(`${fn} @ ${to} 无返回数据`);
    return iface.decodeFunctionResult(fn, raw);
  }

  const checks = [];
  const check = (ok, msg) => {
    checks.push({ ok, msg });
    console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
  };

  for (const [label, addr] of [['Vault', vault], ['Escrow', escrow], ['Staking', staking], ['Governance', gov]]) {
    const code = await rpc('eth_getCode', [addr, 'latest']);
    check(code && code !== '0x', `${label} 有代码 ${addr}`);
  }
  check(same((await call(escrow, escrowArt.iface, 'owner'))[0], operator), 'Escrow.owner = operator');
  check(same((await call(staking, stakingArt.iface, 'owner'))[0], operator), 'Staking.owner = operator');
  check(same((await call(vault, vaultArt.iface, 'owner'))[0], operator), 'Vault.owner = operator');
  check(same((await call(escrow, escrowArt.iface, 'staking'))[0], staking), 'Escrow.staking = Staking');
  check(same((await call(staking, stakingArt.iface, 'escrow'))[0], escrow), 'Staking.escrow = Escrow');
  check(same((await call(escrow, escrowArt.iface, 'tokenVaultAddress'))[0], vault), 'Escrow.tokenVaultAddress = Vault');
  check(same((await call(vault, vaultArt.iface, 'escrow'))[0], escrow), 'Vault.escrow = Escrow');
  check(same((await call(escrow, escrowArt.iface, 'governor'))[0], gov), 'Escrow.governor = Governance');
  check(same((await call(staking, stakingArt.iface, 'governor'))[0], gov), 'Staking.governor = Governance');
  const chainArbiters = (await call(escrow, escrowArt.iface, 'arbiters'))[0].map((a) => String(a).toLowerCase());
  check(
    chainArbiters.length === arbiters.length &&
      arbiters.every((a, i) => chainArbiters[i] === a.toLowerCase()),
    'Escrow.arbiters = 部署参数'
  );
  check(Number((await call(escrow, escrowArt.iface, 'arbiterThreshold'))[0]) === threshold, 'Escrow.arbiterThreshold = 部署参数');
  check(same(await rpc('eth_getCode', [escrow, 'latest']), escrowCode), 'Escrow 字节码哈希未变化');

  const failed = checks.filter((c) => !c.ok);
  if (failed.length) throw new Error(`链上复核失败 ${failed.length} 项`);

  const summary = {
    operator,
    escrow,
    staking,
    tokenPayoutVault: vault,
    nodeGovernance: gov,
    escrowCodeHash,
    startBlock,
  };
  console.log('\n=== 结果（未登记 Registry）===');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
