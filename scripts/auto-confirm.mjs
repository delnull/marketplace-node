#!/usr/bin/env node
/**
 * 超时自动确认 keeper（独立进程，**不嵌在节点 API 进程里**）。
 *
 * 为什么独立：节点主私钥不能进 Web 服务进程；keeper 只需要一把 operator 私钥和一个只读 DB 连接，
 * 由节点主用 systemd timer / cron / 容器 sidecar 自行运行。节点后台没有密钥也能完整运营。
 *
 * 它做两件事：
 *  1. 对本节点已支付、仍在链上 Created 的订单，当 `latestBlock > releaseNotBeforeBlock`
 *     （严格大于；等于阈值那一块合约仍会 revert）时调用 `releaseExpired(orderId)`（超时释放）。
 *  2. 对已确认收货、货款仍在 Escrow 7 天留存期的订单，到期且没有在途售后案件（也没有
 *     未走完的退货单）时调用 `releaseSellerFunds(orderId)`，把留存货款释放给卖家；
 *     在途售后案到达强制结案期限（开案 + 90 天或窗口结束，先到者）后也由它触发结案。
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
  'function afterSaleOpenedAtBlock(bytes32 orderId) view returns (uint64)',
  'function settledAtBlock(bytes32 orderId) view returns (uint64)',
  'function afterSaleWindowAtSettle(bytes32 orderId) view returns (uint64)',
  'function releaseSellerFunds(bytes32 orderId)',
];

/** 与合约 `Escrow.MAX_AFTER_SALE_CASE_BLOCKS` 同值：售后案的投票上限（90 天 @5 秒/块）。 */
const MAX_AFTER_SALE_CASE_BLOCKS = 1_555_200;

/*
  BTY 主网的 eth_estimateGas 对 >10 万 gas 的调用固定返回 -32000 且不带 revert data，
  keeper 会看到 `missing revert data` 而永远释放不了。实测动作本身只要 ~5 万 gas；
  但**上限必须留够付款余量**：`Escrow._payoutNativeOrCredit` 只在 `gasleft() > 16 万`
  时才直接 push，否则静默转成 `accruedPayouts`（卖家得自己 withdraw）。190k 的上限恰好
  会让付款腿挂在账上；400k 给足余量，成功时未用的 gas 会退回。
*/
const GAS_RELEASE_EXPIRED = 400_000n;
const GAS_RELEASE_SELLER_FUNDS = 400_000n;

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

/**
 * BTY 的 `tx.wait()` 会在回执里遇到系统交易字段时解析失败（本仓 e2e 已改用原始
 * `eth_getTransactionReceipt` 轮询）。keeper 只认链上 status=1，不依赖 ethers 的回执解析。
 */
async function waitConfirmed(hash, label) {
  for (let i = 0; i < 40; i++) {
    const rc = await provider.send('eth_getTransactionReceipt', [hash]);
    if (rc && rc.blockNumber) {
      const status = Number.parseInt(rc.status, 16);
      if (status !== 1) throw new Error(`${label} reverted (status=${rc.status}, block=${rc.blockNumber})`);
      return rc;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`${label} timeout: ${hash}`);
}

async function tick() {
  const latest = await provider.getBlockNumber();
  /*
    候选面用**键集分页**遍历，而不是 `ORDER BY updated_at ASC LIMIT 100` 一次定生死：
    旧的单页查询在"头部 100 单都不可释放"（退款待决/未到期）时，后面的到期单永远轮不到
    （节点级、跨店共享，忙店很容易到 100）。每页按 (updated_at, order_id) 前进，
    不依赖 offset，也不因为处理过程中行被 watcher 改掉而跳行。
  */
  const PAGE = 100;
  let released = 0;
  let cursor = null;
  for (let pageNo = 0; pageNo < 100; pageNo += 1) {
    const pageWhere = cursor
      ? " AND (updated_at > ? OR (updated_at = ? AND order_id > ?))"
      : '';
    const params = cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.orderId] : [];
    const [rows] = await conn.query(
      `SELECT order_id, order_no, escrow_order_id, status, refund_status, updated_at
         FROM v_orders
        WHERE status IN ('escrowed', 'shipped')
          AND escrow_order_id IS NOT NULL
          AND escrow_order_id <> ''${pageWhere}
        ORDER BY updated_at ASC, order_id ASC
        LIMIT ${PAGE}`,
      params
    );
    if (!rows.length) break;
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
        const tx = await escrow.releaseExpired(orderId, { gasLimit: GAS_RELEASE_EXPIRED });
        log('sent', row.order_no, tx.hash);
        await waitConfirmed(tx.hash, 'releaseExpired');
        released += 1;
      } catch (e) {
        log('release-failed', row.order_no, e?.shortMessage || e?.message || e);
      }
    }
    if (rows.length < PAGE) break;
    const last = rows[rows.length - 1];
    cursor = { updatedAt: last.updated_at, orderId: last.order_id };
  }
  if (released) log('released', released);

  /*
    留存期释放：状态已经 confirmed/settled 的单不在上面的候选面里，但货款可能还在
    Escrow.sellerPending（确认收货后 7 天）。keeper 不猜留存期，只读链上的 unlockBlock /
    afterSaleOpen / 案件到期块。有在途售后案且**两个到期出口都没到**时本轮跳过（不白付
    gas 在必然 revert 的调用上）；到期后照常调用，让"任何人可强制结案并释放余款"在 keeper
    侧也能生效。线下退货单（open/shipped）是本地附加闸：链上没有退货状态，退货没走完就
    不自动把货款放给卖家（卖家仍可自行提取，这是已知边界）。
    同样按键集分页，避免头部 100 单全部「无留存货款/案件在途」时饿死后面的单。
  */
  let pendingReleased = 0;
  cursor = null;
  for (let pageNo = 0; pageNo < 100; pageNo += 1) {
    const pageWhere = cursor
      ? " AND (updated_at > ? OR (updated_at = ? AND order_id > ?))"
      : '';
    const params = cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.orderId] : [];
    const [settled] = await conn.query(
      `SELECT order_id, order_no, escrow_order_id, updated_at
         FROM v_orders
        WHERE status IN ('confirmed', 'settled', 'expired')
          AND NOT EXISTS (
            SELECT 1 FROM order_returns r
             WHERE r.order_id = v_orders.order_id AND r.status IN ('open', 'shipped')
          )
          AND escrow_order_id IS NOT NULL
          AND escrow_order_id <> ''${pageWhere}
        ORDER BY updated_at ASC, order_id ASC
        LIMIT ${PAGE}`,
      params
    );
    if (!settled.length) break;
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
      /*
        在途售后案件不是"一律不碰"：合约在**先到者**到期后允许任何人强制结案并释放余款
        （开案 + 90 天，或结算 + 窗口）。所以这里只在"两个期限都没到"时跳过；到期就照常调用，
        否则强制结案这条 permissionless 出口在 keeper 侧永远触发不了（本地 after_sale_status
        只能被 AfterSaleClosed 改掉，而那个事件需要先有人调 releaseSellerFunds）。
        本地镜像不再参与这一判断——链上读数才是判据。
      */
      if (caseOpen) {
        let opened;
        let settledAt;
        let window;
        try {
          [opened, settledAt, window] = await Promise.all([
            escrow.afterSaleOpenedAtBlock(orderId),
            escrow.settledAtBlock(orderId),
            escrow.afterSaleWindowAtSettle(orderId),
          ]);
        } catch (e) {
          log('case-deadline-read-failed', row.order_no, e?.shortMessage || e?.message || e);
          continue;
        }
        const voteDeadline = Number(opened) + MAX_AFTER_SALE_CASE_BLOCKS;
        const windowEnd = Number(settledAt) + Number(window);
        if (latest < voteDeadline && latest <= windowEnd) continue; // 还没到强制结案
      }
      if (pending === 0n && !caseOpen) continue;
      if (!caseOpen && latest < Number(unlock)) continue;
      if (DRY) {
        log('dry-run-would-release-pending', row.order_no, `amount=${pending.toString()} latest=${latest}`);
        continue;
      }
      try {
        const tx = await escrow.releaseSellerFunds(orderId, { gasLimit: GAS_RELEASE_SELLER_FUNDS });
        log('sent-pending', row.order_no, tx.hash);
        await waitConfirmed(tx.hash, 'releaseSellerFunds');
        pendingReleased += 1;
      } catch (e) {
        log('pending-release-failed', row.order_no, e?.shortMessage || e?.message || e);
      }
    }
    if (settled.length < PAGE) break;
    const last = settled[settled.length - 1];
    cursor = { updatedAt: last.updated_at, orderId: last.order_id };
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
  /*
    `config.chain` **没有** `rpcUrl` 单值字段（多端点解析见 src/config.js 的 parseRpcUrls）。
    读一个不存在的字段会让 ethers 退回 `http://localhost:8545`：keeper 不报错、每轮 tick-failed，
    超时释放与留存释放两条自动路径静默消失。这里显式取第一个端点并在启动期失败。
  */
  const rpcUrl = String(config.chain.rpcUrls?.[0] || '').trim();
  if (!/^https?:\/\//i.test(rpcUrl)) {
    console.error('缺少 MK_RPC_URL（keeper 需要至少一个 http(s) 端点）');
    process.exitCode = 2;
    return;
  }
  provider = new ethers.JsonRpcProvider(rpcUrl, config.chain.chainId);
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
