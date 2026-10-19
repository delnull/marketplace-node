/**
 * 多店节点对账（`scripts/reconcile-ledger.js`）的节点级集成判据。
 *
 * 旧脚本把链上订单按 `seller == MK_SHOP_OWNER` 过滤：节点主自己的店能对上，租户店的
 * seller 不是节点主 → 本地收入行全部落到“链上查不到”。本文件钉住新判据：
 *   · 节点归属 = `commissionTermsAtCreate(orderId).payee == MK_SHOP_OWNER`（host），不是 seller；
 *   · 本地侧按 `shop_code` 分店汇总；
 *   · 同一 seller 在别的节点的单必须排除，不能算成本节点“链上多出的单”；
 *   · 本地记了别的节点的单 / 本地完全漏掉本节点已结算单 = exit 2；
 *   · host 读不到 = exit 3（没核对成，不是“不属于本节点”）。
 *
 * 假 RPC 在进程内，脚本以子进程跑；本地库是带 pid 的独立库（与 reconcile-ledger.test.js
 * 同一套“只建脚本真正 SELECT 的列”的夹具思路）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { Interface } from 'ethers';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'scripts', 'reconcile-ledger.js');
const DB_NAME = `mk_test_reconcile_multi_${process.pid}`;

const ZERO = '0x0000000000000000000000000000000000000000';
const ESCROW = '0x3333333333333333333333333333333333333333';
const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 节点主 / host
const TENANT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // 租户店主
const FOREIGN = '0xdddddddddddddddddddddddddddddddddddddddd'; // 另一个节点主
const BUYER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SHOP_OWN = 'OWN000001';
const SHOP_TENANT = 'TEN000001';
const ID_OWN = '0x' + '11'.repeat(32);
const ID_TENANT = '0x' + '22'.repeat(32);
const ID_FOREIGN = '0x' + '33'.repeat(32);
const ID_EXTRA = '0x' + '44'.repeat(32);

const ABI = [
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, address host, uint256 amount)',
  'event ReceiptConfirmed(bytes32 indexed orderId)',
  'event RefundApproved(bytes32 indexed orderId, uint256 refundWei)',
  'function getOrder(bytes32 orderId) view returns (address buyer, address seller, uint256 amount, uint256 feeBps, uint64 timeoutBlocks, uint64 createdAtBlock, bool refundRequested, bool refundRejected, uint256 refundedAmount, uint8 status, address feeCollectorAtCreate, bool buyerConfirmed)',
  'function commissionTermsAtCreate(bytes32 orderId) view returns (address payee, uint16 bps)',
  'function feeCollector() view returns (address)',
  'function sellerNetAtSettle(bytes32 orderId) view returns (uint256)',
  'function commissionAtSettle(bytes32 orderId) view returns (uint256)',
];
const iface = new Interface(ABI);

/** 假链上的订单真值。所有订单默认已 ReceiptConfirmed（status=3、有结算事件）。 */
const chain = {
  orders: [],
  termsFail: new Set(),
};

const orderOf = (id) => chain.orders.find((o) => o.id === id);
const byId = (id) => orderOf(id) || null;

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const j = JSON.parse(body || '{}');
    const latest = 1000;
    let result;
    try {
      if (j.method === 'eth_blockNumber') {
        result = '0x' + latest.toString(16);
      } else if (j.method === 'eth_getLogs') {
        const topic0 = String(j.params?.[0]?.topics?.[0] || '').toLowerCase();
        const createdTopic = iface.getEvent('OrderCreated').topicHash.toLowerCase();
        const confirmedTopic = iface.getEvent('ReceiptConfirmed').topicHash.toLowerCase();
        const refundedTopic = iface.getEvent('RefundApproved').topicHash.toLowerCase();
        const logs = [];
        if (topic0 === createdTopic) {
          for (const o of chain.orders) {
            if (o.created === false) continue;
            const hit = iface.encodeEventLog(iface.getEvent('OrderCreated'), [
              o.id,
              BUYER,
              o.seller,
              o.host,
              o.amount,
            ]);
            logs.push({ address: ESCROW, topics: hit.topics, data: hit.data, blockNumber: '0x' + Number(o.block ?? 0x3e2).toString(16), transactionHash: '0x' + 'ab'.repeat(32), logIndex: '0x0' });
          }
        } else if (topic0 === confirmedTopic) {
          for (const o of chain.orders) {
            if (o.settled === false) continue;
            const hit = iface.encodeEventLog(iface.getEvent('ReceiptConfirmed'), [o.id]);
            logs.push({ address: ESCROW, topics: hit.topics, data: hit.data, blockNumber: '0x3e2', transactionHash: '0x' + 'ab'.repeat(32), logIndex: '0x0' });
          }
        } else if (topic0 === refundedTopic) {
          for (const o of chain.orders) {
            if (!o.refunded) continue;
            const hit = iface.encodeEventLog(iface.getEvent('RefundApproved'), [o.id, o.refunded]);
            logs.push({ address: ESCROW, topics: hit.topics, data: hit.data, blockNumber: '0x3e2', transactionHash: '0x' + 'ab'.repeat(32), logIndex: '0x0' });
          }
        }
        result = logs;
      } else if (j.method === 'eth_call') {
        const data = String(j.params?.[0]?.data || '');
        if (data.startsWith(iface.getFunction('feeCollector').selector)) {
          result = iface.encodeFunctionResult('feeCollector', [ZERO]);
        } else if (data.startsWith(iface.getFunction('commissionTermsAtCreate').selector)) {
          const [id] = iface.decodeFunctionData('commissionTermsAtCreate', data);
          const o = byId(String(id).toLowerCase());
          if (!o) throw new Error('unit-test: no order');
          if (chain.termsFail.has(o.id)) throw new Error('unit-test: commissionTermsAtCreate unavailable');
          result = iface.encodeFunctionResult('commissionTermsAtCreate', [o.host, 500]);
        } else if (data.startsWith(iface.getFunction('getOrder').selector)) {
          const [id] = iface.decodeFunctionData('getOrder', data);
          const o = byId(String(id).toLowerCase());
          if (!o) throw new Error('unit-test: no order');
          result = iface.encodeFunctionResult('getOrder', [
            BUYER,
            o.seller,
            o.amount,
            0n,
            100n,
            1n,
            false,
            false,
            o.refunded ?? 0n,
            o.status ?? 3,
            ZERO,
            false,
          ]);
        } else if (data.startsWith(iface.getFunction('sellerNetAtSettle').selector)) {
          const [id] = iface.decodeFunctionData('sellerNetAtSettle', data);
          const o = byId(String(id).toLowerCase());
          if (!o) throw new Error('unit-test: no order');
          result = iface.encodeFunctionResult('sellerNetAtSettle', [o.net]);
        } else if (data.startsWith(iface.getFunction('commissionAtSettle').selector)) {
          const [id] = iface.decodeFunctionData('commissionAtSettle', data);
          const o = byId(String(id).toLowerCase());
          if (!o) throw new Error('unit-test: no order');
          result = iface.encodeFunctionResult('commissionAtSettle', [o.commission]);
        } else {
          throw new Error(`未知调用 ${data.slice(0, 10)}`);
        }
      } else {
        throw new Error(`未预期的 RPC 方法 ${j.method}`);
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 1, result }));
    } catch (e) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 1, error: { code: -32000, message: String(e?.message || e) } }));
    }
  });
});
let rpcUrl = '';
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
after(() => rpcServer.close());

async function localDb(rows) {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4`);
    await conn.query(`USE \`${DB_NAME}\``);
    await conn.query('DROP VIEW IF EXISTS v_orders');
    await conn.query('DROP TABLE IF EXISTS order_chain');
    await conn.query('DROP TABLE IF EXISTS orders');
    await conn.query('DROP TABLE IF EXISTS shops');
    await conn.query(`CREATE TABLE shops (
         code CHAR(9) NOT NULL,
         seller CHAR(42) NOT NULL,
         PRIMARY KEY (code),
         UNIQUE KEY uq_shops_seller (seller)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    for (const r of rows) {
      await conn.query('INSERT IGNORE INTO shops (code, seller) VALUES (?, ?)', [r.shop, r.seller]);
    }
    await conn.query(`CREATE TABLE orders (
         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
         order_no CHAR(21) NOT NULL,
         shop_code CHAR(9) NOT NULL,
         seller CHAR(42) NOT NULL,
         amount_wei DECIMAL(38,0) NOT NULL,
         fee_bps SMALLINT UNSIGNED NOT NULL DEFAULT 0,
         fee_collector_at_create CHAR(42) NULL,
         commission_bps SMALLINT UNSIGNED NOT NULL DEFAULT 0,
         commission_to CHAR(42) NULL,
         status ENUM('draft','escrowed','shipped','confirmed','disputed','settled','refunded','expired','cancelled') NOT NULL DEFAULT 'confirmed',
         PRIMARY KEY (id),
         UNIQUE KEY uq_orders_no (order_no)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.query(`CREATE TABLE order_chain (
         order_id BIGINT UNSIGNED NOT NULL,
         escrow_order_id CHAR(66) NOT NULL,
         refunded_amount_wei DECIMAL(38,0) NOT NULL DEFAULT 0,
         PRIMARY KEY (order_id),
         UNIQUE KEY uq_chain_escrow (escrow_order_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.query(`CREATE VIEW v_orders AS
         SELECT o.id AS order_id, o.order_no, o.shop_code, o.status, o.seller, o.amount_wei, o.fee_bps, o.fee_collector_at_create,
                o.commission_bps, o.commission_to, c.escrow_order_id, c.refunded_amount_wei
           FROM orders o LEFT JOIN order_chain c ON c.order_id = o.id`);
    for (const [i, r] of rows.entries()) {
      const [ins] = await conn.query(
        `INSERT INTO orders (order_no, shop_code, seller, amount_wei, fee_bps, fee_collector_at_create,
                             commission_bps, commission_to, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`B000000000000000000${i + 1}`, r.shop, r.seller, String(r.amount), r.feeBps ?? 0, ZERO, r.commissionBps ?? 500, r.commissionTo ?? OWNER, r.status || 'confirmed']
      );
      await conn.query('INSERT INTO order_chain (order_id, escrow_order_id, refunded_amount_wei) VALUES (?, ?, ?)', [
        ins.insertId,
        r.id,
        String(r.refunded ?? 0),
      ]);
    }
  } finally {
    await conn.end().catch(() => {});
  }
}

function runScript(args = ['--start-block', '900']) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        ...process.env,
        MK_DB_HOST: config.db.host,
        MK_DB_PORT: String(config.db.port),
        MK_DB_USER: config.db.user,
        MK_DB_PASSWORD: config.db.password,
        MK_DB_NAME: DB_NAME,
        MK_RPC_URL: rpcUrl,
        MK_ESCROW_ADDRESS: ESCROW,
        MK_SHOP_OWNER: OWNER,
        MK_ESCROW_START_BLOCK: '',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: `${out}\nspawn error: ${e.message}` }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const ownOrder = {
  id: ID_OWN,
  seller: OWNER,
  amount: 1000n,
  host: OWNER,
  net: 1000n,
  commission: 0n,
};
const tenantOrder = {
  id: ID_TENANT,
  seller: TENANT,
  amount: 2000n,
  host: OWNER,
  net: 1900n,
  commission: 100n,
};

before(() => {
  // 每个用例自己重建 orders；这里只复位 host 读取失败集合。
  chain.termsFail.clear();
});

after(async () => {
  try {
    const conn = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      connectTimeout: 5000,
    });
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    } finally {
      await conn.end().catch(() => {});
    }
  } catch (e) {
    console.warn(`[reconcile-multishop-test] 夹具库清理失败：${e?.message || e}`);
  }
});

test('同一节点的自营店 + 租户店都按 host 对账；店铺分行、exit 0', async () => {
  chain.orders = [ownOrder, tenantOrder];
  await localDb([
    { id: ID_OWN, shop: SHOP_OWN, seller: OWNER, amount: 1000n, feeBps: 0, commissionBps: 0 },
    { id: ID_TENANT, shop: SHOP_TENANT, seller: TENANT, amount: 2000n, feeBps: 0 },
  ]);
  const { code, out } = await runScript();
  assert.equal(code, 0, out);
  assert.match(out, /本节点托管=2/, '链上 host 过滤必须同时认出 own 与 tenant');
  assert.match(out, new RegExp(`${SHOP_OWN} seller=${OWNER}`), '自营店独立小计');
  assert.match(out, new RegExp(`${SHOP_TENANT} seller=${TENANT}`), '租户店独立小计');
  assert.match(out, /✅ 本节点全部店铺的本地入账与链上结算事件一致/);
});

test('同一 seller 在别的节点的单不得算成本节点链上多出的单', async () => {
  const foreignSameSeller = {
    id: ID_FOREIGN,
    seller: TENANT, // 同一租户在另一节点也开了店
    amount: 3000n,
    host: FOREIGN,
    net: 2850n,
    commission: 150n,
  };
  chain.orders = [ownOrder, tenantOrder, foreignSameSeller];
  await localDb([
    { id: ID_OWN, shop: SHOP_OWN, seller: OWNER, amount: 1000n, feeBps: 0, commissionBps: 0 },
    { id: ID_TENANT, shop: SHOP_TENANT, seller: TENANT, amount: 2000n, feeBps: 0 },
  ]);
  const { code, out } = await runScript();
  assert.equal(code, 0, out);
  assert.match(out, /其它节点=1/, 'host 过滤把它归类为别的节点');
  assert.match(out, /已按 host 排除/);
  assert.doesNotMatch(out, /链上已结算但本地\*\*完全没有该单\*\*/, 'foreign order 不得报成本节点漏扫');
});

test('本地记了别的节点的单 ⇒ foreignHost 差异（exit 2），不是“链上查不到”', async () => {
  const wrongHost = {
    id: ID_FOREIGN,
    seller: TENANT,
    amount: 3000n,
    host: FOREIGN,
    net: 2850n,
    commission: 150n,
  };
  chain.orders = [ownOrder, tenantOrder, wrongHost];
  await localDb([
    { id: ID_OWN, shop: SHOP_OWN, seller: OWNER, amount: 1000n, feeBps: 0, commissionBps: 0 },
    { id: ID_TENANT, shop: SHOP_TENANT, seller: TENANT, amount: 2000n, feeBps: 0 },
    { id: ID_FOREIGN, shop: SHOP_TENANT, seller: TENANT, amount: 3000n, feeBps: 0 },
  ]);
  const { code, out } = await runScript();
  assert.equal(code, 2, out);
  assert.match(out, /host 是\*\*别的节点\*\*/);
  assert.match(out, new RegExp(`${ID_FOREIGN.slice(0, 18)}`));
});

test('非入账态（draft/cancelled）链上 host 是别的节点也必须报 foreignHost（全状态审计）', async () => {
  const wrongHost = {
    id: ID_FOREIGN,
    seller: TENANT,
    amount: 3000n,
    host: FOREIGN,
    net: 2850n,
    commission: 150n,
  };
  chain.orders = [ownOrder, tenantOrder, wrongHost];
  await localDb([
    { id: ID_OWN, shop: SHOP_OWN, seller: OWNER, amount: 1000n, feeBps: 0, commissionBps: 0 },
    { id: ID_TENANT, shop: SHOP_TENANT, seller: TENANT, amount: 2000n, feeBps: 0 },
    { id: ID_FOREIGN, shop: SHOP_TENANT, seller: TENANT, amount: 3000n, feeBps: 0, status: 'draft' },
  ]);
  const { code, out } = await runScript();
  assert.equal(code, 2, out);
  assert.match(out, /status=draft/);
  assert.match(out, /host 是\*\*别的节点\*\*/);
});

test('已结算单的本地 seller/shop 错位也必须报 sellerMismatch（不能因 settledIds 提前跳过）', async () => {
  chain.orders = [ownOrder, tenantOrder];
  await localDb([
    { id: ID_OWN, shop: SHOP_OWN, seller: TENANT, amount: 1000n, feeBps: 0, commissionBps: 0 },
    { id: ID_TENANT, shop: SHOP_TENANT, seller: TENANT, amount: 2000n, feeBps: 0 },
  ]);
  const { code, out } = await runScript();
  assert.equal(code, 2, out);
  assert.match(out, /seller 与本地订单 seller 不一致/);
  assert.match(out, new RegExp(`${ID_OWN.slice(0, 18)}`));
});

test('链上本节点已结算、本地完全没有该单 ⇒ extra（exit 2）', async () => {
  const extra = {
    id: ID_EXTRA,
    seller: TENANT,
    amount: 4000n,
    host: OWNER,
    net: 3800n,
    commission: 200n,
  };
  chain.orders = [ownOrder, tenantOrder, extra];
  await localDb([
    { id: ID_OWN, shop: SHOP_OWN, seller: OWNER, amount: 1000n, feeBps: 0, commissionBps: 0 },
    { id: ID_TENANT, shop: SHOP_TENANT, seller: TENANT, amount: 2000n, feeBps: 0 },
  ]);
  const { code, out } = await runScript();
  assert.equal(code, 2, out);
  assert.match(out, /本地\*\*完全没有该单\*\*/);
  assert.match(out, new RegExp(`${ID_EXTRA.slice(0, 18)}`));
});

test('链上已全额退款、本地完全没有 ⇒ refundedOnly（exit 2），不冒充在途/卖家收款', async () => {
  const refunded = {
    id: ID_EXTRA,
    seller: TENANT,
    amount: 4000n,
    host: OWNER,
    net: 0n,
    commission: 0n,
    refunded: 4000n,
    settled: false,
    status: 4,
    block: 900,
  };
  chain.orders = [ownOrder, tenantOrder, refunded];
  await localDb([
    { id: ID_OWN, shop: SHOP_OWN, seller: OWNER, amount: 1000n, feeBps: 0, commissionBps: 0 },
    { id: ID_TENANT, shop: SHOP_TENANT, seller: TENANT, amount: 2000n, feeBps: 0 },
  ]);
  const { code, out } = await runScript();
  assert.equal(code, 2, out);
  assert.match(out, /已全额退款/);
  assert.doesNotMatch(out, /还在途\/漏扫\/库缺行/);
});

test('链上本节点已有 OrderCreated、本地完全没有且已过确认深度 ⇒ openOnly（exit 2）', async () => {
  const open = {
    id: ID_EXTRA,
    seller: TENANT,
    amount: 4000n,
    host: OWNER,
    net: 3800n,
    commission: 200n,
    settled: false,
    block: 900,
  };
  chain.orders = [ownOrder, tenantOrder, open];
  await localDb([
    { id: ID_OWN, shop: SHOP_OWN, seller: OWNER, amount: 1000n, feeBps: 0, commissionBps: 0 },
    { id: ID_TENANT, shop: SHOP_TENANT, seller: TENANT, amount: 2000n, feeBps: 0 },
  ]);
  const { code, out } = await runScript();
  assert.equal(code, 2, out);
  assert.match(out, /已有 OrderCreated、本地完全没有该单/);
  assert.match(out, new RegExp(`${ID_EXTRA.slice(0, 18)}`));
});

test('链上已有托管、本地仍是 draft（已过确认深度）⇒ localDraftOnchain（exit 2）', async () => {
  const onchainDraft = {
    id: ID_EXTRA,
    seller: TENANT,
    amount: 4000n,
    host: OWNER,
    net: 3800n,
    commission: 200n,
    settled: false,
    block: 900,
  };
  chain.orders = [ownOrder, tenantOrder, onchainDraft];
  await localDb([
    { id: ID_OWN, shop: SHOP_OWN, seller: OWNER, amount: 1000n, feeBps: 0, commissionBps: 0 },
    { id: ID_TENANT, shop: SHOP_TENANT, seller: TENANT, amount: 2000n, feeBps: 0 },
    { id: ID_EXTRA, shop: SHOP_TENANT, seller: TENANT, amount: 4000n, feeBps: 0, status: 'draft' },
  ]);
  const { code, out } = await runScript();
  assert.equal(code, 2, out);
  assert.match(out, /本地仍是草稿\/已取消/);
  assert.match(out, new RegExp(`${ID_EXTRA.slice(0, 18)}`));
});

test('OrderCreated 在区间外且 host 读不到 ⇒ exit 3（没核对成），不得当成别的节点直接排除', async () => {
  const tenantWithoutCreated = { ...tenantOrder, created: false };
  chain.orders = [ownOrder, tenantWithoutCreated];
  chain.termsFail = new Set([ID_TENANT]);
  await localDb([
    { id: ID_OWN, shop: SHOP_OWN, seller: OWNER, amount: 1000n, feeBps: 0, commissionBps: 0 },
    { id: ID_TENANT, shop: SHOP_TENANT, seller: TENANT, amount: 2000n, feeBps: 0 },
  ]);
  const { code, out } = await runScript();
  assert.equal(code, 3, out);
  assert.match(out, /归属读不到|抽成收款人读不到|OrderCreated 区间外/);
  assert.doesNotMatch(out, /✅ 本节点全部店铺/);
});
