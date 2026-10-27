#!/usr/bin/env node
/**
 * 超时自动确认 keeper（独立进程，**不嵌在节点 API 进程里**）。
 *
 * 为什么独立：节点主私钥不能进 Web 服务进程；keeper 只需要一把 operator 私钥和一个只读 DB 连接，
 * 由节点主用 systemd timer / cron / 容器 sidecar 自行运行。节点后台没有密钥也能完整运营。
 *
 * 它做两件事：
 *  1. 对本节点已支付、仍在链上 Created 的订单，当 releaseNotBeforeBlock <= latestBlock 时
 *     调用 `releaseExpired(orderId)`（超时释放）。
 *  2. 对已确认收货、货款仍在 Escrow 售后留存期的订单，留存期结束且没有在途售后案件时
 *     调用 `releaseSellerFunds(orderId)`，把留存货款释放给卖家。
 * 状态回写由节点 watcher/对账完成，keeper 不直接改库。
 *
 * 用法：
 *   MK_AUTO_CONFIRM_KEY=0x... node --env-file=.env scripts/auto-confirm.mjs --once
 *   MK_AUTO_CONFIRM_KEY_FILE=/run/secrets/keeper.key node ... scripts/auto-confirm.mjs
 *   --dry-run 只打印将释放的订单，不发交易
 */
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import mysql from 'mysql2/promise';
import config from '../src/config.js';
import { releaseExpiredDecision } from '../src/autoConfirm.js';

const ABI = [
  'function releaseNotBeforeBlock(bytes32 orderId) view returns (uint64)',
  'function releaseExpired(bytes32 orderId)',
  'function sellerPending(bytes32 orderId) view returns (uint256)',
  'function sellerPendingUnlockBlock(bytes32 orderId) view returns (uint64)',
  'function afterSaleOpen(bytes32 orderId) view returns (bool)',
  'function releaseSellerFunds(bytes32 orderId)',
];

const ONCE = process.argv.includes('--once');
const DRY = process.argv.includes('--dry-run');
const INTERVAL_MS = Math.max(5_000, Number(process.env.MK_AUTO_CONFIRM_INTERVAL_MS || 60_000));

function privateKey() {
  const inline = String(process.env.MK_AUTO_CONFIRM_KEY || '').trim();
  if (inline) return inline;
  const file = String(process.env.MK_AUTO_CONFIRM_KEY_FILE || '').trim();
  if (file) return readFileSync(file, 'utf8').trim();
  return '';
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

let running = true;
let wallet;
let escrow;
let provider;
let conn;

async function tick() {
  const latest = await provider.getBlockNumber();
  const [rows] = await conn.query(
    `SELECT order_no, escrow_order_id, status, refund_status
       FROM v_orders
      WHERE status IN ('escrowed', 'shipped')
        AND escrow_order_id IS NOT NULL
        AND escrow_order_id <> ''
      ORDER BY updated_at ASC
      LIMIT 100`
  );
  let released = 0;
  for (const row of rows) {
    const orderId = String(row.escrow_order_id);
    if (!/^0x[0-9a-fA-F]{64}$/.test(orderId)) continue;
    // 退款申请待商家处理时合约会拒绝释放（RefundPending）；跳过它，不白付 gas。
    if (String(row.refund_status || '') === 'requested') continue;
    let at;
    try {
      at = await escrow.releaseNotBeforeBlock(orderId);
    } catch (e) {
      log('read-failed', row.order_no, e?.shortMessage || e?.message || e);
      continue;
    }
    const d = releaseExpiredDecision(at, latest);
    if (!d.eligible) continue;
    if (DRY) {
      log('dry-run-would-release', row.order_no, `latest=${latest}`);
      continue;
    }
    try {
      const tx = await escrow.releaseExpired(orderId);
      log('sent', row.order_no, tx.hash);
      await tx.wait();
      released += 1;
    } catch (e) {
      log('release-failed', row.order_no, e?.shortMessage || e?.message || e);
    }
  }
  if (released) log('released', released);

  /*
    留存期释放：状态已经 confirmed/settled 的单不在上面的候选面里，但货款可能还在
    Escrow.sellerPending。keeper 不猜留存期，只读链上的 unlockBlock 和 afterSaleOpen。
  */
  const [settled] = await conn.query(
    `SELECT order_no, escrow_order_id
       FROM v_orders
      WHERE status IN ('confirmed', 'settled', 'expired')
        AND escrow_order_id IS NOT NULL
        AND escrow_order_id <> ''
      ORDER BY updated_at ASC
      LIMIT 100`
  );
  let pendingReleased = 0;
  for (const row of settled) {
    const orderId = String(row.escrow_order_id);
    if (!/^0x[0-9a-fA-F]{64}$/.test(orderId)) continue;
    let pending;
    let unlock;
    let caseOpen;
    try {
      [pending, unlock, caseOpen] = await Promise.all([
        escrow.sellerPending(orderId),
        escrow.sellerPendingUnlockBlock(orderId),
        escrow.afterSaleOpen(orderId),
      ]);
    } catch (e) {
      log('pending-read-failed', row.order_no, e?.shortMessage || e?.message || e);
      continue;
    }
    if (pending === 0n || caseOpen) continue;
    if (latest < Number(unlock)) continue;
    if (DRY) {
      log('dry-run-would-release-pending', row.order_no, `amount=${pending.toString()} latest=${latest}`);
      continue;
    }
    try {
      const tx = await escrow.releaseSellerFunds(orderId);
      log('sent-pending', row.order_no, tx.hash);
      await tx.wait();
      pendingReleased += 1;
    } catch (e) {
      log('pending-release-failed', row.order_no, e?.shortMessage || e?.message || e);
    }
  }
  if (pendingReleased) log('pending-released', pendingReleased);
}

async function main() {
  const pk = privateKey();
  if (!pk) {
    console.error('缺少 MK_AUTO_CONFIRM_KEY 或 MK_AUTO_CONFIRM_KEY_FILE（只给 keeper 用的 operator 私钥）');
    process.exitCode = 2;
    return;
  }
  if (!config.chain.escrowAddress) {
    console.error('缺少 MK_ESCROW_ADDRESS');
    process.exitCode = 2;
    return;
  }
  provider = new ethers.JsonRpcProvider(config.chain.rpcUrl, config.chain.chainId);
  wallet = new ethers.Wallet(pk, provider);
  escrow = new ethers.Contract(config.chain.escrowAddress, ABI, wallet);
  /*
    keeper 只读订单表，**不调用 db.js 的 initDb**：那道初始化会抢节点实例锁并跑 DDL，
    而 keeper 是节点旁边的第二个进程，不是第二个节点。直接用一条只读连接。
  */
  conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
    charset: 'utf8mb4',
  });
  log('keeper-start', wallet.address, 'escrow', config.chain.escrowAddress, ONCE ? 'once' : `every ${INTERVAL_MS}ms`, DRY ? 'dry-run' : '');

  do {
    try {
      await tick();
    } catch (e) {
      log('tick-failed', e?.shortMessage || e?.message || e);
    }
    if (!ONCE) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  } while (running && !ONCE);
}

process.on('SIGINT', () => {
  running = false;
});
process.on('SIGTERM', () => {
  running = false;
});

try {
  await main();
} finally {
  await conn?.end().catch(() => {});
}
