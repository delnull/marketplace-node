/**
 * 对账脚本 `scripts/reconcile-ledger.js` 的口径单测（T4 + T7）。
 *
 * 脚本是 CLI，所以这里**真的把它跑起来**（子进程）：链上侧指向本文件起的本地假 JSON-RPC
 * 服务器（只回 eth_blockNumber / eth_getLogs / eth_call），本地侧指向临时 SQLite 文件——
 * 不触网、不依赖公共 RPC、不碰真实数据库。
 *
 * 钉住的不变量：
 *  1. **本地侧与链上侧同一个平台费判据**（T4）：两侧都按"每单的创建时收费方快照"判，
 *     快照缺失时才退回全局兜底。旧实现本地侧自带一份 feeOf 且不看收费方 ⇒「feeBps>0 而链上
 *     一分不扣」的部署下本地扣、链上不扣，输出恒差一个费额；
 *  2. **差额非 0 时退出码非 0**（T4）：旧版只在 missing/extra 时 exit 2，行配对得上但数额不符
 *     仍报 0——接监控的人读到"一致"；
 *  3. `--db-only` 的"期望实收"能与卖家面板同口径（`--fee-collector none`）；
 *  4. **链上侧按单判定**（T7）：本地行有"创建时收费方"快照而全局值相反时，两侧仍同口径。
 *
 * ⚠️ 依赖提示：假 RPC 的 `getOrder` 返回元组按**脚本内 ABI 的字段数**编码（契约层新增的
 * `feeCollectorAtCreate` 由仓库所有者统一同步）。元组同步后本桩应补上该项；同步前
 * `readOnchainOrderFacts` 读不到该字段（解码失败即返回 null）会退回**本地同名列**——
 * 仍然按单判定，故本文件的断言在两种状态下都成立。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Interface } from 'ethers';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'scripts', 'reconcile-ledger.js');

const ZERO = '0x0000000000000000000000000000000000000000';
const ESCROW = '0x2222222222222222222222222222222222222222';
const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BUYER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ORDER_ID = '0x' + '11'.repeat(32);
const FC_AT_CREATE = '0xcccccccccccccccccccccccccccccccccccccccc'; // 本地库里的"创建时收费方"
const FC_GLOBAL = '0xdddddddddddddddddddddddddddddddddddddddd'; // 链上全局收费方

const ABI = [
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, uint256 amount, uint64 timeoutBlocks, uint64 createdAtBlock)',
  'event ReceiptConfirmed(bytes32 indexed orderId)',
  'function getOrder(bytes32 orderId) view returns (address buyer, address seller, uint256 amount, uint256 feeBps, uint64 timeoutBlocks, uint64 createdAtBlock, bool refundRequested, bool refundRejected, uint256 refundedAmount, uint8 status, address feeCollectorAtCreate, bool buyerConfirmed)',
  'function feeCollector() view returns (address)',
];
const iface = new Interface(ABI);

/** 假链上的可变真值（每个用例开始时设定） */
const chain = {
  globalCollector: ZERO, // feeCollector() 的返回
  createdAmount: 1000n, // OrderCreated 的托管额
  factsFeeBps: 100, // getOrder().feeBps
  factsRefunded: 0n, // getOrder().refundedAmount
  /** getOrder().feeCollectorAtCreate（创建时的收取方快照；ZERO = 本单不扣费）。
   *  对账脚本的链上一侧**按单**判定就靠它（2026-09 审计：不能用全局 feeCollector() 反推单笔）。 */
  factsCollectorAtCreate: ZERO,
};

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
        const created = iface.encodeEventLog(iface.getEvent('OrderCreated'), [
          ORDER_ID,
          BUYER,
          OWNER,
          chain.createdAmount,
          100n,
          1n,
        ]);
        const confirmed = iface.encodeEventLog(iface.getEvent('ReceiptConfirmed'), [ORDER_ID]);
        const hit = topic0 === iface.getEvent('OrderCreated').topicHash.toLowerCase() ? created : topic0 === iface.getEvent('ReceiptConfirmed').topicHash.toLowerCase() ? confirmed : null;
        result = hit
          ? [
              {
                address: ESCROW,
                topics: hit.topics,
                data: hit.data,
                blockNumber: '0x3e2',
                transactionHash: '0x' + 'ab'.repeat(32),
                logIndex: '0x0',
              },
            ]
          : [];
      } else if (j.method === 'eth_call') {
        const data = String(j.params?.[0]?.data || '');
        if (data.startsWith(iface.getFunction('feeCollector').selector)) {
          result = iface.encodeFunctionResult('feeCollector', [chain.globalCollector]);
        } else if (data.startsWith(iface.getFunction('getOrder').selector)) {
          result = iface.encodeFunctionResult('getOrder', [
            BUYER,
            OWNER,
            chain.createdAmount,
            chain.factsFeeBps,
            100n,
            1n,
            false,
            false,
            chain.factsRefunded,
            3, // Settled
            // 契约层 2026-09 新增的两项（末尾，顺序必须与脚本内 ABI 一致）
            chain.factsCollectorAtCreate,
            false, // buyerConfirmed（对账脚本不消费，占位对齐 ABI）
          ]);
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-reconcile-'));
const dbFile = path.join(tmpDir, 'node.db');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/**
 * 造本地库（脚本只读这几列）。`feeCollectorAtCreate` = 本地补录的创建时收费方快照
 * （'' = 未知 → 脚本退回全局兜底）。
 */
function makeLocalDb({ amountWei = '1000', feeBps = 100, feeCollectorAtCreate = '', status = 'confirmed' } = {}) {
  const db = new DatabaseSync(dbFile);
  db.exec('DROP TABLE IF EXISTS orders');
  db.exec(
    `CREATE TABLE orders (
       id TEXT PRIMARY KEY, escrow_order_id TEXT, amount_wei TEXT, fee_bps INTEGER,
       fee_collector_at_create TEXT NOT NULL DEFAULT '', refunded_amount_wei TEXT NOT NULL DEFAULT '0', status TEXT
     )`
  );
  db.prepare(
    'INSERT INTO orders (id, escrow_order_id, amount_wei, fee_bps, fee_collector_at_create, refunded_amount_wei, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('local-1', ORDER_ID, amountWei, feeBps, feeCollectorAtCreate, '0', status);
  db.close();
}

/**
 * 跑一次脚本（子进程）；返回 { code, out }。
 * ⚠️ 必须用**异步** spawn：spawnSync 会阻塞父进程的事件循环，而假 RPC 服务器就跑在父进程里
 * ——同步等待必然死锁（子进程的 fetch 20s 超时后报 "This operation was aborted"）。
 */
function runScript(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--db', dbFile, ...args], {
      env: {
        ...process.env,
        MK_RPC_URL: rpcUrl,
        MK_ESCROW_ADDRESS: ESCROW,
        MK_SHOP_OWNER: OWNER,
        ...extraEnv,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: `${out}\nspawn error: ${e.message}` }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

before(() => {
  // 每个用例前复位假链
  chain.globalCollector = ZERO;
  chain.createdAmount = 1000n;
  chain.factsFeeBps = 100;
  chain.factsRefunded = 0n;
  chain.factsCollectorAtCreate = ZERO;
});

test('本地侧与链上侧同一个判据：全局零地址（合约不扣费）时两侧都不扣费、差额为 0', async () => {
  makeLocalDb({ feeCollectorAtCreate: '' }); // 本单没有创建时快照 ⇒ 退回全局（零地址 = 不扣）
  chain.globalCollector = ZERO;
  chain.factsCollectorAtCreate = ZERO; // 按单快照同样为零地址
  const { code, out } = await runScript(['--start-block', '900']);
  assert.match(out, /单数=1 毛额=1000 wei 已退买家=0 wei 平台费=0 wei 期望实收=1000 wei/, '本地侧不得扣费');
  assert.match(out, /链上实际到账估算=1000 wei/);
  assert.match(out, /差额=0 wei/, '两侧同口径 ⇒ 差额 0（旧实现本地扣费恒差 10）');
  assert.match(out, /\(\u96f6\u5730\u5740=\u515c\u5e95\u6309\u4e0d\u6263\u8d39\)|零地址=兜底按不扣费/, '输出如实标注判据来源');
  assert.equal(code, 0, '一致 ⇒ exit 0');
});

test('全局配了收费方时两侧都扣费（控制组）：差额仍为 0', async () => {
  makeLocalDb({ feeCollectorAtCreate: '' });
  chain.globalCollector = FC_GLOBAL;
  // 契约层 2026-09 起链上**按单快照**判定：要让两侧都扣费，这一单的创建时快照也必须非零
  // （只把全局配上是不够的——那正是本组用例要证明的口径差异）
  chain.factsCollectorAtCreate = FC_GLOBAL;
  const { code, out } = await runScript(['--start-block', '900']);
  assert.match(out, /平台费=10 wei 期望实收=990 wei/);
  assert.match(out, /链上实际到账估算=990 wei/);
  assert.match(out, /差额=0 wei/);
  assert.equal(code, 0);
});

test('链上侧按单判定（T7）：本地快照=零地址、全局非零 ⇒ 两侧仍都不扣费', async () => {
  makeLocalDb({ feeCollectorAtCreate: ZERO }); // 这单创建时就没配收取方 ⇒ 永不扣费
  chain.globalCollector = FC_GLOBAL; // 全局后来配上了，与在途单无关
  chain.factsCollectorAtCreate = ZERO; // 链上快照同样按单（不是全局）
  const { code, out } = await runScript(['--start-block', '900']);
  assert.match(out, /平台费=0 wei 期望实收=1000 wei/, '本地按快照 ⇒ 不扣');
  assert.match(out, /链上实际到账估算=1000 wei/, '链上侧同样按快照（不是全局）⇒ 也不扣');
  assert.match(out, /差额=0 wei/);
  assert.equal(code, 0);
});

test('差额非 0 时退出码非 0（行配对得上、数额不符也要报警）', async () => {
  makeLocalDb({ feeCollectorAtCreate: '' });
  chain.globalCollector = ZERO;
  chain.factsCollectorAtCreate = ZERO;
  chain.createdAmount = 2000n; // 链上托管额与本地锁定值不符（本地 1000）
  const { code, out } = await runScript(['--start-block', '900']);
  assert.match(out, /差额=1000 wei/);
  assert.match(out, /两侧数额差额/, '输出要说明差额的常见来源');
  assert.equal(code, 2, '旧实现只看 missing/extra ⇒ 这里会错误地 exit 0');
  // 反向控制：把链上金额改回一致后应恢复 exit 0
  chain.createdAmount = 1000n;
  assert.equal((await runScript(['--start-block', '900'])).code, 0);
});

test('--db-only 与卖家面板同口径：--fee-collector none 时本地不扣费；不给参数则按名义费率并标注', async () => {
  makeLocalDb({ feeCollectorAtCreate: '' });
  // ① 显式告知 feeCollector 为零地址（合约不扣费）⇒ 与面板口径一致
  const none = await runScript(['--db-only', '--fee-collector', 'none']);
  assert.match(none.out, /平台费=0 wei 期望实收=1000 wei/);
  assert.match(none.out, /--fee-collector/);
  assert.match(none.out, /跳过链上比对/);
  assert.equal(none.code, 0);
  // ② 不给参数：离线读不到 ⇒ 保守按名义费率折算，并明确提示怎么对齐
  const unknown = await runScript(['--db-only']);
  assert.match(unknown.out, /平台费=10 wei 期望实收=990 wei/);
  assert.match(unknown.out, /--fee-collector none/, '必须告诉运维怎么与面板对齐');
  assert.equal(unknown.code, 0);
  // ③ --fee-collector 给非零地址 ⇒ 按会扣费折算（与面板"已扣"同口径）
  const addr = await runScript(['--db-only', '--fee-collector', FC_GLOBAL]);
  assert.match(addr.out, /平台费=10 wei 期望实收=990 wei/);
  assert.match(addr.out, /非零地址=兜底按会扣费/);
});

test('本地已有快照时，--db-only 直接按快照判（不依赖 --fee-collector）', async () => {
  makeLocalDb({ feeCollectorAtCreate: ZERO });
  const { code, out } = await runScript(['--db-only']);
  assert.match(out, /平台费=0 wei 期望实收=1000 wei/, '快照=零地址是权威"不扣费"，无需全局兜底');
  assert.match(out, /单数=1/);
  assert.equal(code, 0);
});


