/**
 * 对账脚本 `scripts/reconcile-ledger.js` 的口径单测（T4 + T7）。
 *
 * 脚本是 CLI，所以这里**真的把它跑起来**（子进程）：链上侧指向本文件起的本地假 JSON-RPC
 * 服务器（只回 eth_blockNumber / eth_getLogs / eth_call），本地侧指向本进程**专属的一个 MySQL 库**
 * ——不触网、不依赖公共 RPC、不碰节点真正在用的那个库。
 *
 * 为什么本地侧是"一个只含订单列的空库"而不是节点的完整结构：脚本本地侧只 SELECT 九列
 * （见 scripts/reconcile-ledger.js 的 loadLocal），用真实建表语句就得先把几十个 NOT NULL 列
 * 凑齐，而那些列与"对账口径"毫无关系——凑出来的夹具只会掩盖真正要钉的那几列。所以这里按
 * **脚本读什么就建什么**造一个专用库（库名带 pid，进程间互不可见，收尾时删掉）。
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
import http from 'node:http';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { Interface } from 'ethers';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'scripts', 'reconcile-ledger.js');

/**
 * 本进程专属的夹具库。**不复用 `MK_DB_NAME`**：那个名字归 test/setup.mjs（本文件不 import 它，
 * 也就不需要它那套节点环境），而这里要的是一张只有七列的表——两者混在一个库名上会互相拆台。
 */
const DB_NAME = `mk_test_reconcile_${process.pid}`;

const ZERO = '0x0000000000000000000000000000000000000000';
const ESCROW = '0x2222222222222222222222222222222222222222';
const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BUYER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ORDER_ID = '0x' + '11'.repeat(32);
const FC_AT_CREATE = '0xcccccccccccccccccccccccccccccccccccccccc'; // 本地库里的"创建时收费方"
const FC_GLOBAL = '0xdddddddddddddddddddddddddddddddddddddddd'; // 链上全局收费方
const SHOP = 'SHOP00001'; // 本地 shop_code（多店对账的本地维度）
const SELLER = '0xdddddddddddddddddddddddddddddddddddddddd'; // 默认本地店主 / 链上 OrderCreated.seller

const ABI = [
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, address host, uint256 amount)',
  'event ReceiptConfirmed(bytes32 indexed orderId)',
  'function getOrder(bytes32 orderId) view returns (address buyer, address seller, uint256 amount, uint256 feeBps, uint64 timeoutBlocks, uint64 createdAtBlock, bool refundRequested, bool refundRejected, uint256 refundedAmount, uint8 status, address feeCollectorAtCreate, bool buyerConfirmed)',
  'function commissionTermsAtCreate(bytes32 orderId) view returns (address payee, uint16 bps)',
  'function feeCollector() view returns (address)',
  // 链上结算实数（P1-1：脚本必须读这两项，而不是自己按 bps 复算）
  'function sellerNetAtSettle(bytes32 orderId) view returns (uint256)',
  'function commissionAtSettle(bytes32 orderId) view returns (uint256)',
];
const iface = new Interface(ABI);

/** 假链上的可变真值（每个用例开始时设定） */
const chain = {
  globalCollector: ZERO, // feeCollector() 的返回
  createdAmount: 1000n, // OrderCreated 的托管额
  factsFeeBps: 100, // getOrder().feeBps
  factsRefunded: 0n, // getOrder().refundedAmount
  /** getOrder().feeCollectorAtCreate（创建时的收取方快照；ZERO = 本单不扣费）。
   *  对账脚本的本地侧**按单**判定就靠它（2026-09 审计：不能用全局 feeCollector() 反推单笔）。 */
  factsCollectorAtCreate: ZERO,
  /** 结算时实际付给节点主的抽成（commissionAtSettle 的返回；0 = 本单没抽成）。 */
  commissionAtSettle: 0n,
  /** 创建时抽成条款的收款人（= 本节点 owner）；多店对账用它判断订单属于哪个节点。 */
  commissionPayee: OWNER,
  commissionBpsAtCreate: 0,
  /** OrderCreated.seller；`makeLocalDb` 按当前夹具的 seller 同步（已结算单现在也要对 seller） */
  createdSeller: SELLER,
  /** 模拟旧合约/ABI 未同步：读不到 sellerNetAtSettle / commissionAtSettle（null = 不失败） */
  failNet: false,
  failCommission: false,
};

/** 假链上的 sellerNetAtSettle：`(amount − refunded) − fee − commission`（与合约 _settle 同口径） */
function chainSellerNet() {
  const base = chain.createdAmount > chain.factsRefunded ? chain.createdAmount - chain.factsRefunded : 0n;
  const collector = String(chain.factsCollectorAtCreate || '').toLowerCase();
  const chargeable = collector !== ZERO && collector !== OWNER;
  const fee = chargeable && chain.factsFeeBps > 0 ? (base * BigInt(chain.factsFeeBps)) / 10000n : 0n;
  return base - fee - chain.commissionAtSettle;
}

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
          chain.createdSeller,
          chain.commissionPayee,
          chain.createdAmount,
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
        } else if (data.startsWith(iface.getFunction('sellerNetAtSettle').selector)) {
          if (chain.failNet) throw new Error('unit-test: sellerNetAtSettle 读不到');
          result = iface.encodeFunctionResult('sellerNetAtSettle', [chainSellerNet()]);
        } else if (data.startsWith(iface.getFunction('commissionAtSettle').selector)) {
          if (chain.failCommission) throw new Error('unit-test: commissionAtSettle 读不到');
          result = iface.encodeFunctionResult('commissionAtSettle', [chain.commissionAtSettle]);
        } else if (data.startsWith(iface.getFunction('commissionTermsAtCreate').selector)) {
          result = iface.encodeFunctionResult('commissionTermsAtCreate', [
            chain.commissionPayee,
            chain.commissionBpsAtCreate,
          ]);
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

/**
 * 造夹具库（**只有脚本真正 SELECT 的那几列**）。
 *
 * 订单在真库里是**三张 1:1 表**（见 src/db.js），而脚本读的是聚合读模型 `v_orders`——
 * 所以这里按"脚本读什么就建什么"造三样：`orders`（事实）、`order_chain`（链上镜像，
 * `escrow_order_id`/`refunded_amount_wei` 住在那里）、以及把两者拼起来的同名视图。
 * 只建视图不建表会连视图一起失效，只建表不建视图则脚本一句都跑不通。
 *
 * `fee_collector_at_create` = 本地补录的创建时收费方快照（**NULL** = 未知 → 脚本退回全局兜底；
 * 旧形状用空串兼任"未知"，而新 schema 里 NULL 才是）。
 * 每次用例前整表重建：脚本是按 status 全表扫的，残留行会直接改变汇总数字。
 */
async function makeLocalDb({
  amountWei = '1000',
  feeBps = 100,
  feeCollectorAtCreate = null,
  /*
    节点抽成条款：默认**零地址**（确证"本单不抽成"）。NULL 才是"从未补录 = 未知"——
    默认给 ZERO 是为了让既有用例（没有抽成腿）保持"已确证、可核对"，
    而未知档由专门的用例显式构造（要求退出码 3）。
  */
  commissionBps = 0,
  commissionTo = ZERO,
  status = 'confirmed',
  /* 本单卖家。**必须与真库同形状**：对账脚本要用它判"平台不向自己收费"
     （`feeCollectorAtCreate == seller` ⇒ 链上那一单不扣费，见 Escrow._splitOf）——
     夹具里没有这一列时脚本会整条报 "Unknown column 'seller'"，而那是**夹具与真库不同形**，
     不是被测代码的问题。 */
  seller = SELLER,
} = {}) {
  chain.createdSeller = String(seller).toLowerCase();
  const conn = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, multipleStatements: true });
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
    await conn.query('INSERT INTO shops (code, seller) VALUES (?, ?)', [SHOP, seller]);
    /*
      金额列用与真库同款的 `DECIMAL(38,0)`：夹具若用 TEXT，脚本那边"金额是字符串"的口径就验不出来
      （而对账正是拿这些数字与链上比）。`fee_collector_at_create` 可空（NULL = 从未补录）。
    */
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
         status ENUM('draft','escrowed','shipped','confirmed','disputed','settled','refunded','expired','cancelled') NOT NULL DEFAULT 'draft',
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
    // 视图的列名与真库那份逐字同源（脚本按名字读：escrow_order_id / refunded_amount_wei 在子表上）
    await conn.query(`CREATE VIEW v_orders AS
         SELECT o.id AS order_id, o.order_no, o.shop_code, o.status, o.seller, o.amount_wei, o.fee_bps, o.fee_collector_at_create,
                o.commission_bps, o.commission_to, c.escrow_order_id, c.refunded_amount_wei
           FROM orders o LEFT JOIN order_chain c ON c.order_id = o.id`);
    const [ins] = await conn.query(
      `INSERT INTO orders (order_no, shop_code, seller, amount_wei, fee_bps, fee_collector_at_create,
                           commission_bps, commission_to, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['B0000000000000000001', SHOP, seller, amountWei, feeBps, feeCollectorAtCreate, commissionBps, commissionTo, status]
    );
    await conn.query('INSERT INTO order_chain (order_id, escrow_order_id, refunded_amount_wei) VALUES (?, ?, ?)', [
      ins.insertId,
      ORDER_ID,
      '0',
    ]);
  } finally {
    await conn.end().catch(() => {});
  }
}

/** 删掉夹具库（尽力而为：清理失败不该决定测试结论） */
after(async () => {
  try {
    const conn = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, connectTimeout: 5000 });
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    } finally {
      await conn.end().catch(() => {});
    }
  } catch (e) {
    console.warn(`[reconcile-test] 夹具库 ${DB_NAME} 清理失败（不影响测试结论）：${e?.message || e}`);
  }
});

/**
 * 跑一次脚本（子进程）；返回 { code, out }。
 * ⚠️ 必须用**异步** spawn：spawnSync 会阻塞父进程的事件循环，而假 RPC 服务器就跑在父进程里
 * ——同步等待必然死锁（子进程的 fetch 20s 超时后报 "This operation was aborted"）。
 */
function runScript(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        ...process.env,
        MK_DB_HOST: config.db.host,
        MK_DB_PORT: String(config.db.port),
        MK_DB_USER: config.db.user,
        MK_DB_PASSWORD: config.db.password,
        MK_DB_NAME: DB_NAME, // 脚本连的是本文件的夹具库（而不是节点在用的那个）
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
  chain.commissionAtSettle = 0n;
  chain.commissionPayee = OWNER;
  chain.commissionBpsAtCreate = 0;
  chain.failNet = false;
  chain.failCommission = false;
});

test('全局零地址（合约不扣费）⇒ 两侧都按 0 费折算；但快照缺失只能算"未核对"（exit 3）', async () => {
  await makeLocalDb({ feeCollectorAtCreate: null }); // 本单没有创建时快照 ⇒ 退回全局（零地址 = 不扣）
  chain.globalCollector = ZERO;
  chain.factsCollectorAtCreate = ZERO; // 按单快照同样为零地址
  const { code, out } = await runScript(['--start-block', '900']);
  assert.match(out, /单数=1 毛额=1000 wei 已退买家=0 wei 平台费=0 wei 期望实收=1000 wei/, '本地侧不得扣费');
  assert.match(out, /链上实际到账估算=1000 wei/);
  assert.match(out, /差额=—/, '平台费快照缺失 ⇒ 估算不构成"核对过"，不给差额');
  assert.match(out, /不能算作已核对/, '必须显式说明这一档是估算');
  assert.match(out, /\(\u96f6\u5730\u5740=\u515c\u5e95\u6309\u4e0d\u6263\u8d39\)|零地址=兜底按不扣费/, '输出如实标注判据来源');
  assert.equal(code, 3, '快照缺失 ⇒ 没核对成（旧实现给 diff=0 / exit 0）');
});

test('全局配了收费方时两侧都按 10 扣（控制组）；快照缺失仍算"未核对"', async () => {
  await makeLocalDb({ feeCollectorAtCreate: null });
  chain.globalCollector = FC_GLOBAL;
  // 契约层 2026-09 起链上**按单快照**判定：要让两侧都扣费，这一单的创建时快照也必须非零
  // （只把全局配上是不够的——那正是本组用例要证明的口径差异）
  chain.factsCollectorAtCreate = FC_GLOBAL;
  const { code, out } = await runScript(['--start-block', '900']);
  assert.match(out, /平台费=10 wei 期望实收=990 wei/);
  assert.match(out, /链上实际到账估算=990 wei/);
  assert.match(out, /差额=—/);
  assert.equal(code, 3, '平台费快照缺失 ⇒ 估算不算核对');
});

test('链上侧按单判定（T7）：本地快照=零地址、全局非零 ⇒ 两侧仍都不扣费', async () => {
  await makeLocalDb({ feeCollectorAtCreate: ZERO }); // 这单创建时就没配收取方 ⇒ 永不扣费
  chain.globalCollector = FC_GLOBAL; // 全局后来配上了，与在途单无关
  chain.factsCollectorAtCreate = ZERO; // 链上快照同样按单（不是全局）
  const { code, out } = await runScript(['--start-block', '900']);
  assert.match(out, /平台费=0 wei 期望实收=1000 wei/, '本地按快照 ⇒ 不扣');
  assert.match(out, /链上实际到账估算=1000 wei/, '链上侧同样按快照（不是全局）⇒ 也不扣');
  assert.match(out, /差额=0 wei/);
  assert.equal(code, 0);
});

test('差额非 0 时退出码非 0（行配对得上、数额不符也要报警）', async () => {
  // 平台费快照**已知**（零地址）才能计算可信差额；NULL 会走"未核对"档（见专门用例）
  await makeLocalDb({ feeCollectorAtCreate: ZERO });
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

test('--db-only 与卖家面板同口径：--fee-collector 只影响估算；快照缺失一律 exit 3', async () => {
  await makeLocalDb({ feeCollectorAtCreate: null });
  // ① 显式告知 feeCollector 为零地址（合约不扣费）⇒ 折算为 0，但快照仍缺失 ⇒ 估算 ≠ 已核对
  const none = await runScript(['--db-only', '--fee-collector', 'none']);
  assert.match(none.out, /平台费=0 wei 期望实收=1000 wei/);
  assert.match(none.out, /--fee-collector/);
  assert.match(none.out, /跳过链上比对/);
  assert.equal(none.code, 3, '没有创建时快照 ⇒ 离线核数也不得报"一致"');
  // ② 不给参数：离线读不到 ⇒ 保守按名义费率折算，并明确提示怎么对齐
  const unknown = await runScript(['--db-only']);
  assert.match(unknown.out, /平台费=10 wei 期望实收=990 wei/);
  assert.match(unknown.out, /--fee-collector none/, '必须告诉运维怎么与面板对齐');
  assert.equal(unknown.code, 3);
  // ③ --fee-collector 给非零地址 ⇒ 按会扣费折算（与面板"已扣"同口径）
  const addr = await runScript(['--db-only', '--fee-collector', FC_GLOBAL]);
  assert.match(addr.out, /平台费=10 wei 期望实收=990 wei/);
  assert.match(addr.out, /非零地址=兜底按会扣费/);
  assert.equal(addr.code, 3);
});

test('本地已有快照时，--db-only 直接按快照判（不依赖 --fee-collector）', async () => {
  await makeLocalDb({ feeCollectorAtCreate: ZERO });
  const { code, out } = await runScript(['--db-only']);
  assert.match(out, /平台费=0 wei 期望实收=1000 wei/, '快照=零地址是权威"不扣费"，无需全局兜底');
  assert.match(out, /单数=1/);
  assert.equal(code, 0, '平台费与抽成都已确证 ⇒ 离线核数可报 0');
});

/**
 * **"平台不向自己收费"必须在对账里也是同一条判据**（2026-10-16）。
 *
 * 链上 `Escrow._splitOf` 是 `fee = (collector != 0 && collector != seller) ? … : 0`
 * ——收款方就是本单卖家时**一分不扣**（平台自营店，Escrow 注释里写明的运营形态）。
 * 这条判据此前在链下三个费用内核里都没有镜像，而对账脚本是**两侧共用同一把尺子**：
 * 本地按 `feeBps` 扣、链上也按 `feeBps` 扣 ⇒ 差异永远不会报警（自己证明自己），
 * 只会把平台费收入系统性虚增、把卖家实收报低。所以这里必须逐字钉住：
 * 收款方 == 卖家 ⇒ **两侧都 0**，而"全局兜底非零"这种局外参数不得把它翻过来。
 */
test('平台不向自己收费：收款方 == 卖家 ⇒ 两侧都不扣费（与 Escrow._splitOf 同判据）', async () => {
  /*
    卖家用 `OWNER`（= 假链上 OrderCreated 里的 seller，也是链上 host 判据的节点主）：
    "收款方 == 卖家"这条判据**两侧都按同一行订单的 seller 算**，所以本地库那一行与链上
    那一笔必须真的是同一个卖家——用一个随便编的地址会让链上一侧拿不到判据，
    而症状是"结论看似正确（不扣）但走的是另一条分支"，测不到要测的东西。
  */
  await makeLocalDb({ feeCollectorAtCreate: OWNER, seller: OWNER });
  chain.globalCollector = FC_GLOBAL; // 全局兜底是"会扣费"，但按单的判据优先
  chain.factsCollectorAtCreate = OWNER; // 链上快照 == 卖家（平台自营店）
  const { code, out } = await runScript(['--start-block', '900']);
  assert.match(out, /平台费=0 wei 期望实收=1000 wei/, '本地：收款方就是卖家 ⇒ 不扣（缺这一条会扣成 10）');
  assert.match(out, /链上实际到账估算=1000 wei/, '链上侧同判据 ⇒ 也不扣');
  assert.match(out, /差额=0 wei/);
  assert.equal(code, 0);

  // 反向控制：把收款方换成另一个人（既非卖家也非零地址）⇒ 两侧都恢复按费率扣
  const OTHER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  await makeLocalDb({ feeCollectorAtCreate: OTHER, seller: OWNER });
  chain.factsCollectorAtCreate = OTHER;
  const charged = await runScript(['--start-block', '900']);
  assert.match(charged.out, /平台费=10 wei 期望实收=990 wei/, '收款方不是卖家 ⇒ 照扣（判据不能顺手放行所有人）');
  assert.equal(charged.code, 0);
});

/**
 * **P1-1：节点抽成必须进入两侧的净额**。
 *
 * 旧脚本两侧都只算 `net = amount − refunded − fee`，于是 `commission_bps > 0` 的店：
 * 链上卖家实际少拿一个抽成额，而两侧**同时**漏掉它 ⇒ 差额 0、退出码 0——对账自证"一致"。
 * 现在链上侧读 `sellerNetAtSettle` / `commissionAtSettle` 实数，本地侧读
 * `commission_bps` / `commission_to` 快照并按同样的下取整折算。
 *
 * 本用例的判定力：若本地侧再次漏掉抽成，`期望实收` 会是 1000（链上 900）⇒ 差额 100、
 * 断言 `差额=0` 立刻变红。
 */
test('节点抽成：两侧都扣同一笔抽成（链上 sellerNetAtSettle 实数）⇒ 差额 0；本地漏算会差 100', async () => {
  chain.createdAmount = 1000n;
  chain.factsFeeBps = 0;
  chain.factsCollectorAtCreate = ZERO; // 平台费腿为 0，单独钉抽成
  chain.factsRefunded = 0n;
  chain.commissionAtSettle = 100n; // 10% 抽成
  try {
    // 收款方非零且 != 卖家 ⇒ 本地必须扣这 100
    await makeLocalDb({ feeBps: 0, feeCollectorAtCreate: ZERO, commissionBps: 1000, commissionTo: FC_GLOBAL });
    const { code, out } = await runScript(['--start-block', '900']);
    assert.match(
      out,
      /平台费=0 wei 期望实收=900 wei 节点抽成=100 wei/,
      '本地期望实收必须扣掉节点抽成（漏算会是 1000）'
    );
    assert.match(out, /链上实际到账估算=900 wei（sellerNetAtSettle 实测/);
    assert.match(out, /链上节点抽成=100 wei（commissionAtSettle 实测/);
    assert.match(out, /链上平台费=0 wei/);
    assert.match(out, /差额=0 wei/);
    assert.equal(code, 0, '两侧同口径 ⇒ 一致（旧实现本地 1000 vs 链上 900，会差 100 并 exit 2）');
  } finally {
    chain.commissionAtSettle = 0n;
  }
});

test('本地抽成条款从未补录（commission_to IS NULL）⇒ 报"无法核对"且退出码 3（不是 0）', async () => {
  chain.createdAmount = 1000n;
  chain.factsFeeBps = 0;
  chain.factsCollectorAtCreate = ZERO;
  chain.factsRefunded = 0n;
  chain.commissionAtSettle = 0n;
  // commission_to = NULL = 未知（不是"确证不抽成"）
  await makeLocalDb({ feeBps: 0, feeCollectorAtCreate: ZERO, commissionBps: 0, commissionTo: null });
  const { code, out } = await runScript(['--start-block', '900']);
  assert.match(out, /commission_to IS NULL/, '必须把"未补录的抽成条款"作为独立读数报出来');
  assert.match(out, /没有被核对过/, '未知抽成不能被折成 0 后宣称一致');
  assert.equal(code, 3, '没核对成 ⇒ exit 3（旧实现静默按 0 折算、diff=0、exit 0）');

  // --db-only 同样不得把未知抽成报成"一致"
  const dbOnly = await runScript(['--db-only', '--fee-collector', 'none']);
  assert.match(dbOnly.out, /commission_to IS NULL/);
  assert.equal(dbOnly.code, 3);
});

/**
 * **平台费快照缺失同样是"没核对成"**（P1-1 复审补充）。
 *
 * 本地没有 `fee_collector_at_create` 时那一腿只能按全局兜底**估算**：它恰好等于链上实数的
 * 那一轮会输出 diff=0 / ✅——把"猜对了"当成"核对过"。现在它进入 unverified：不给差额、
 * 不给 ✅、退出码 3，并把未核对订单号打印出来。
 */
test('本地平台费快照为 NULL ⇒ 估算不算核对：exit 3、差额不可计算、不出现 ✅', async () => {
  chain.createdAmount = 1000n;
  chain.factsFeeBps = 0;
  chain.factsCollectorAtCreate = ZERO;
  chain.factsRefunded = 0n;
  chain.commissionAtSettle = 0n;
  // 全局兜底也是零地址（估算恰好 = 链上不扣费），最容易产生假 ✅
  chain.globalCollector = ZERO;
  await makeLocalDb({ feeBps: 100, feeCollectorAtCreate: null, commissionBps: 0, commissionTo: ZERO });
  const { code, out } = await runScript(['--start-block', '900']);
  assert.match(out, /fee_collector_at_create 为 NULL/);
  assert.match(out, /不能算作已核对/, '全局兜底是估算，不是核对');
  assert.match(out, /未核对清单/, '必须把未核对的订单号点出来');
  assert.match(out, /差额=—/);
  assert.doesNotMatch(out, /✅ 本地入账/, '读数缺失时不得输出"一致"结论');
  assert.equal(code, 3, '未知档 ⇒ 非 0（旧实现会 diff=0 / exit 0）');
});

test('链上 commissionAtSettle 读不到 ⇒ 抽成腿报未知、退出码 3（不回落到本地复算）', async () => {
  chain.createdAmount = 1000n;
  chain.factsFeeBps = 0;
  chain.factsCollectorAtCreate = ZERO;
  chain.factsRefunded = 0n;
  chain.commissionAtSettle = 50n; // 假链确实抽了 50，但脚本读不到
  chain.failCommission = true;
  try {
    await makeLocalDb({ feeBps: 0, feeCollectorAtCreate: ZERO, commissionBps: 500, commissionTo: FC_GLOBAL });
    const { code, out } = await runScript(['--start-block', '900']);
    assert.match(out, /commissionAtSettle 读不到/, '必须显式说清哪一项读不到');
    assert.match(out, /差额=—/, '读数不齐时不得给出一个看似确定的差额');
    assert.equal(code, 3, '链上抽成读数缺失 ⇒ 没核对成');
  } finally {
    chain.failCommission = false;
    chain.commissionAtSettle = 0n;
  }
});


