#!/usr/bin/env node
/**
 * 收款流水链上对账脚本（只读，单店视角）
 *
 * 目的：把「本地已入账订单的期望实收（净额）」与「链上 Escrow 实际释放给本店主的事件」对账，
 * 输出差异清单与汇总——用于核验 watcher/ledger 口径、发现漏扫事件或本地脏数据。
 *
 * 口径：
 *  - 本店 = MK_SHOP_OWNER（seller）；托管 = MK_ESCROW_ADDRESS；RPC = MK_RPC_URL
 *  - **平台费判据是"每单"的**（契约层 2026-09）：合约 `Escrow._settle` 只读**创建订单时**快照的
 *    收费方（`getOrder(...).feeCollectorAtCreate`，零地址 = 这单永不扣费），全局 `feeCollector()`
 *    已被删除（实时读全局会让 owner 事后改配置影响到在途单）。本脚本两侧共用一处判据
 *    `orderChargeable(快照, 全局兜底)`：
 *      · 链上侧：优先用 getOrder 的 feeCollectorAtCreate；
 *      · 本地侧：用本地库 `orders.fee_collector_at_create`（节点在 paid/watcher/sync 时补录）；
 *      · 两边都没有（元组未同步/未补录）→ 退回全局兜底口径（在线读链上全局值；`--db-only`
 *        时由 `--fee-collector` 给出，未给则保守按"会扣费"折算）。
 *    为什么要这样：旧版本地侧自带一份 `feeOf` 且**不看收费方**——「feeBps > 0 但链上一分不扣」
 *    的部署下本地把费扣掉、链上侧不扣，输出恒差一个费额；而旧版退出码只看 missing/extra，
 *    差额非 0 也返回 0，接监控的人会读到"一致"——对账脚本自证的意义就没了。
 *  - 本地侧：SQLite 中 status IN (confirmed, settled, expired) 的订单（= INCOME_STATUS），
 *    期望实收 =（amount_wei − refunded_amount_wei）− 平台费（平台费只对未退部分计，费率取订单级
 *    fee_bps 快照；该单的收费方快照为零地址 ⇒ 期望实收 = 结算基数）
 *  - 链上侧：拉 Escrow 的 OrderCreated（topic 过滤 seller=本店主，建立 orderId→amount）+ 结算事件
 *    （ReceiptConfirmed / OrderExpiredReleased / Arbitrated / RefundApproved，后两者按 refundWei 判定），
 *    对落在本店 orderId 集合的结算事件计实际到账（金额按 OrderCreated 的 amount，费率取链上
 *    getOrder(orderId).feeBps，缺失的订单在报告中单独列出以便人工核）
 *  - 事件缺失的订单（本地已入账但链上无结算事件）= 待查清单；链上多出（本店 orderId 结算但本地未入账）
 *    = 漏扫/状态不同步清单
 *
 * 用法：
 *   node scripts/reconcile-ledger.js [--db ./marketplace-node.db] [--start-block 0]
 *   （RPC/合约/店主取自环境变量 MK_RPC_URL/MK_ESCROW_ADDRESS/MK_SHOP_OWNER，缺省读 .env：
 *     npm run reconcile —— package.json script，经 --env-file-if-exists=.env 注入）
 *   --db-only          仅输出本地侧统计（不连 RPC，供无网环境核数）
 *   --fee-collector A  离线核数用，设定**全局兜底口径**的收费方（`none`/零地址 = 不扣费）：
 *                      只作用于"本地库里没有创建时快照"的行（有快照的行一律按快照判，与链上一致）。
 *                      使 --db-only 的"期望实收"与卖家面板流水**同口径**——面板的全局兜底是实时读链的，
 *                      离线脚本读不到就只能按名义费率估算。不给该参数时按名义费率折算并显式标注
 *                      （保守方向：少报费用比多报费用更容易让店主误判到账金额，与 src/fees.js 同款取舍）。
 *   --blocks N         未给 --start-block 时回溯 N 块（默认 200000，BTY 5s/块 ≈ 11.6 天）
 *   exit code：0=一致（或仅提示项）；2=存在差异（可接入监控）——差异含三类：
 *              本地已入账但链上无结算事件 / 链上已结算但本地未入账 / **两侧数额差额 ≠ 0**
 *
 * 注意：BTY 主网 EVM 不支持 PUSH0 等与本脚本无关；区块可能含系统交易，但 eth_getLogs 只回普通日志，
 * 不受影响。事件区间按 ≤2000 块分段拉取。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Interface } from 'ethers';

// ── 参数与配置 ──
const args = process.argv.slice(2);
const argVal = (name, fb = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fb;
};
const DB_FILE = argVal('--db', process.env.MK_DB_FILE || 'marketplace-node.db');
const DB_ONLY = args.includes('--db-only');
/**
 * 离线口径下的收费方（`none`/零地址 = 合约不扣费；地址 = 会扣费；未给 = 未知）：
 * --db-only 不连 RPC，所以链上 feeCollector 读不到——由运维显式告知，才能与卖家面板
 * （实时读链）的"已扣/预计"口径一致。见文件头"平台费判据只有一处"。
 */
const FEE_COLLECTOR_ARG = argVal('--fee-collector', null);
const OWNER = (process.env.MK_SHOP_OWNER || '').toLowerCase();
const ESCROW = (process.env.MK_ESCROW_ADDRESS || '').toLowerCase();
const RPC = process.env.MK_RPC_URL || 'https://mainnet.bityuan.com/eth';
const START_BLOCK = Number(argVal('--start-block', 0));
/** 默认回溯块数（≈11.6 天）。`--blocks N` 可覆盖——文件头一直写着这个开关，却从未被解析过 */
const DEFAULT_BLOCKS = Number(argVal('--blocks', 200000)) || 200000;
const RPC_TIMEOUT_MS = 20000;

const INCOME_STATUS = ['confirmed', 'settled', 'expired'];

/** Escrow 结算相关事件（orderId 均 indexed；Arbitrated 现带 refundWei：全额退买家不计收款） */
const ABI = [
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, uint256 amount, uint64 timeoutBlocks, uint64 createdAtBlock)',
  'event ReceiptConfirmed(bytes32 indexed orderId)',
  'event OrderExpiredReleased(bytes32 indexed orderId)',
  // 2026-09：裁决从 bool 改为退款金额（拆分裁决）——旧签名会让 topic 不匹配、仲裁结算的单
  // 在对账里彻底消失（只会少算，不会报警），所以这里必须与合约事件签名逐字一致
  'event Arbitrated(bytes32 indexed orderId, uint256 refundWei)',
  /*
    卖家同意退款/争议中和解：带 refundWei。合约 2026-09 收紧后只接受两种金额——
    `refundWei == amount`（全额退回买家，卖家一分钱收不到）或 `refundWei == acceptedPartialRefund[orderId]`
    （买家**精确授权过**的部分退款，余额结算给卖家）；其它一律 revert `RefundAmountNotAccepted`
    （旧的 `RefundNotFull` 已删除）。所以本事件既可能是全额退款、也可能是**双方谈拢的拆分**，
    不能再当作"恒为全额"直接排除——下面按 refundWei 判定时它与 Arbitrated 共用同一条逻辑。
    （任意比例、无需买家授权的拆分仍只归仲裁人 `arbitrate`，见 Arbitrated 事件。）
  */
  'event RefundApproved(bytes32 indexed orderId, uint256 refundWei)',
  // 只读：订单级费率快照 + **创建时的收取方快照**（链上真值——对账的链上一侧**不得**用本地
  // fee_bps/全局 feeCollector() 反推，否则本地快照写错时两边同错、永远对不出来，等于自证）。
  // 末尾两项是 2026-09 审计新增，字段序必须与 Escrow.Order 逐字对应（错序会静默解码出垃圾）。
  'function getOrder(bytes32 orderId) view returns (address buyer, address seller, uint256 amount, uint256 feeBps, uint64 timeoutBlocks, uint64 createdAtBlock, bool refundRequested, bool refundRejected, uint256 refundedAmount, uint8 status, address feeCollectorAtCreate, bool buyerConfirmed)',
  // 全局收取方（只作为"该单没有创建时快照"时的兜底披露，不再用于判定单笔扣不扣费）
  'function feeCollector() view returns (address)',
];
const iface = new Interface(ABI);
const TOPIC = (name) => iface.getEvent(name).topicHash;

/**
 * 名义费率折算（**只算名义值**）：amountWei × feeBps / 10000（下取整，与链上 `Escrow._settle`
 * 及 src/fees.js 同款算式）。
 * ⚠️ 这里**不判**收费方——"这一单扣不扣费"由**每单**的创建时收费方快照决定，判据只在
 * orderChargeable() 一处（本地与链上两侧共用）；判据散成两处正是本次修复要消灭的东西（见文件头）。
 */
const nominalFeeOf = (amountWei, feeBps) => (feeBps > 0 ? (amountWei * BigInt(feeBps)) / 10000n : 0n);
const ZERO = '0x0000000000000000000000000000000000000000';

/** 零地址/`none` 归一（离线参数与链上读取共用判定） */
const isZeroAddr = (a) => String(a || '').toLowerCase() === ZERO || String(a || '').toLowerCase() === 'none';
const UNKNOWN_COLLECTOR = { addr: null, known: false };

/**
 * 这一单是否会被扣费（**唯一判据**，本地与链上两侧共用；语义与 src/fees.js 的
 * feeChargeableForOrder 逐字一致）：
 *   ① 创建时收费方快照非空 → 权威：零地址 = 这单永不扣费（合约只读快照）；
 *   ② 快照为空（未补录/元组未同步）→ 退回全局保守口径（`globalChargeable`：未知=按会扣费算）。
 */
const orderChargeable = (feeCollectorAtCreate, globalChargeable) => {
  const snap = String(feeCollectorAtCreate ?? '').trim();
  if (!snap) return globalChargeable;
  return !isZeroAddr(snap);
};

// ── 本地侧 ──
/**
 * 本地侧汇总。`chargeable` = **全局兜底判据**（读链得到的全局 feeCollector，或离线参数）；
 * 每行的实际判定走 orderChargeable(row.fee_collector_at_create, chargeable)——与链上侧共用
 * 同一个函数，且与卖家面板（src/fees.js）同口径。
 * 本地库里的 fee_collector_at_create 由节点在 paid/watcher/sync 时从链上 getOrder 补录。
 */
function loadLocal({ chargeable }) {
  const file = path.resolve(DB_FILE);
  if (!fs.existsSync(file)) {
    console.error(`[reconcile] 未找到数据库 ${file}（可 --db 指定，或先启动过节点）`);
    process.exit(1);
  }
  const db = new DatabaseSync(file, { readOnly: true });
  const marks = INCOME_STATUS.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT escrow_order_id, amount_wei, fee_bps, fee_collector_at_create, refunded_amount_wei, status
         FROM orders WHERE status IN (${marks}) AND escrow_order_id IS NOT NULL`
    )
    .all(...INCOME_STATUS);
  db.close();
  const byOrderId = new Map();
  let gross = 0n;
  let fee = 0n;
  // 本地侧净额口径与链上一致：net = Σ(amount − refunded) − fee（只对未退部分计费）
  let refundedTotal = 0n;
  let unknownSnapshot = 0; // 快照为空（退回全局口径）的行数——输出里提示，便于发现补录缺失
  for (const r of rows) {
    const amt = BigInt(r.amount_wei || '0');
    const refunded = BigInt(r.refunded_amount_wei || '0');
    const base = amt > refunded ? amt - refunded : 0n;
    const snap = String(r.fee_collector_at_create || '');
    if (!snap) unknownSnapshot += 1;
    const f = orderChargeable(snap, chargeable) ? nominalFeeOf(base, Number(r.fee_bps || 0)) : 0n;
    gross += amt;
    refundedTotal += refunded;
    fee += f;
    byOrderId.set(String(r.escrow_order_id).toLowerCase(), {
      amount: amt,
      refunded,
      feeBps: Number(r.fee_bps || 0),
      feeCollectorAtCreate: snap,
      status: r.status,
    });
  }
  return {
    byOrderId,
    summary: { count: rows.length, gross, refunded: refundedTotal, fee, net: gross - refundedTotal - fee, unknownSnapshot },
  };
}

// ── 链上侧（原始 JSON-RPC，规避 BTY 兼容层解析问题）──
// 注意：BTY 兼容层 eth_getLogs 不支持 topics 数组含 null 占位的多级过滤（实测报
// "no support topic type"）——一律只传单一签名 topic（topics0）拉取，过滤在解码后本地做。
async function rpc(method, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只读 eth_call（对账用的链上真值读取；失败返回 null，由调用方降级并标注） */
async function ethCall(data) {
  try {
    const hex = await rpc('eth_call', [{ to: ESCROW, data }, 'latest']);
    return hex && hex !== '0x' ? hex : null;
  } catch {
    return null;
  }
}

/**
 * 读链上**全局** feeCollector：仅作"没有创建时快照的行"的兜底口径（契约层 2026-09 已把
 * 扣费判据改为每单快照；该全局函数在新合约上可能已不存在 ⇒ eth_call 失败 ⇒ known=false ⇒
 * 兜底按"会扣费"折算，方向保守）。
 */
async function readFeeCollector() {
  const hex = await ethCall(iface.encodeFunctionData('feeCollector', []));
  if (!hex) return { addr: null, known: false };
  try {
    const [addr] = iface.decodeFunctionResult('feeCollector', hex);
    return { addr: String(addr).toLowerCase(), known: true };
  } catch {
    return { addr: null, known: false };
  }
}

/**
 * 读某订单的链上真值：feeBps 快照 + **创建时收费方快照** + 已退买家金额
 *（对账链上一侧的唯一权威来源）。
 *
 * ⚠️ `feeCollectorAtCreate` 是 `getOrder` 返回元组**末尾新增**的一项（契约层 2026-09：平台费
 * "收不收、按哪个地址收"在创建订单时快照，`_settle` 只读它；全局 `feeCollector()` 已被删除——
 * 实时读全局会让 owner 事后改配置影响到在途单）。本脚本按它做**按单**判定。
 *
 * 本文件顶部的 ABI 数组**已含**该字段（`… bool refundedAmount` 之后的
 * `address feeCollectorAtCreate, bool buyerConfirmed`）——改这里时必须同步改那一行，
 * 否则 `r.feeCollectorAtCreate` 解出来的是**相邻字段的值**（错序不报错，只会静默读成垃圾，
 * 见 chain.js 同处的说明）。读到缺字段/失败时保持空串 = **未知** ⇒ 退回本地库同名列 /
 * 全局保守口径，不会凭空宣称"不扣费"。
 */
async function readOnchainOrderFacts(orderId) {
  const hex = await ethCall(iface.encodeFunctionData('getOrder', [orderId]));
  if (!hex) return null;
  try {
    const r = iface.decodeFunctionResult('getOrder', hex);
    return {
      status: Number(r.status), // 0=None 1=Created 2=Disputed 3=Settled 4=Refunded
      seller: String(r.seller || '').toLowerCase(),
      feeBps: Number(r.feeBps),
      feeCollectorAtCreate: r.feeCollectorAtCreate === undefined || r.feeCollectorAtCreate === null
        ? ''
        : String(r.feeCollectorAtCreate).toLowerCase(),
      refundedAmount: BigInt(r.refundedAmount ?? 0n),
    };
  } catch {
    return null;
  }
}

async function getLogsRange(address, topic0, from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    const end = Math.min(to, cur + 1999);
    const logs = await rpc('eth_getLogs', [{ address, topics: [topic0], fromBlock: '0x' + cur.toString(16), toBlock: '0x' + end.toString(16) }]);
    out.push(...(Array.isArray(logs) ? logs : []));
    cur = end + 1;
    await sleep(40); // 轻节流
  }
  return out;
}

async function loadOnchain() {
  if (!ESCROW) throw new Error('缺少 MK_ESCROW_ADDRESS（托管合约地址）');
  if (!OWNER) console.warn('[reconcile] 未设置 MK_SHOP_OWNER：将统计该托管合约全部结算事件（跨店口径），如需单店口径请配置店主地址');
  const latest = Number(await rpc('eth_blockNumber', []));
  const from = START_BLOCK > 0 ? START_BLOCK : Math.max(0, latest - DEFAULT_BLOCKS);
  console.log(`[reconcile] 链上扫描 ${from}..${latest} escrow=${ESCROW} seller=${OWNER || '(全部)'}`);

  // 1) OrderCreated：只按签名 topic 拉取，解码后按 seller 过滤（BTY 不支持 topic3 过滤）
  const createdLogs = await getLogsRange(ESCROW, TOPIC('OrderCreated'), from, latest);
  const created = new Map(); // orderId -> { amount, block }
  for (const l of createdLogs) {
    try {
      const ev = iface.parseLog({ topics: l.topics, data: l.data });
      const seller = String(ev.args.seller || '').toLowerCase();
      if (OWNER && seller !== OWNER) continue; // 单店口径：只统计本店主作为卖家的托管
      const id = String(ev.args.orderId).toLowerCase();
      if (!created.has(id)) created.set(id, { amount: BigInt(ev.args.amount), block: Number(l.blockNumber) });
    } catch {
      /* 忽略无法解析日志 */
    }
  }
  console.log(`[reconcile] 本店 OrderCreated（区间内）=${created.size}`);

  // 2) 结算事件：ReceiptConfirmed / OrderExpiredReleased / Arbitrated / RefundApproved
  //    （带 refundWei 的两个事件共用同一条判定：refundWei >= amount ⇒ 全额退买家、卖家没收到钱）
  let skippedNoCreated = 0;
  const settleSets = {
    ReceiptConfirmed: new Set(),
    OrderExpiredReleased: new Set(),
    ArbitratedPaid: new Set(),
    RefundApprovedPaid: new Set(),
  };
  for (const [evName, settleKey] of [
    ['ReceiptConfirmed', 'ReceiptConfirmed'],
    ['OrderExpiredReleased', 'OrderExpiredReleased'],
    ['Arbitrated', 'ArbitratedPaid'],
    ['RefundApproved', 'RefundApprovedPaid'],
  ]) {
    const logs = await getLogsRange(ESCROW, TOPIC(evName), from, latest);
    for (const l of logs) {
      try {
        const ev = iface.parseLog({ topics: l.topics, data: l.data });
        const id = String(ev.args.orderId).toLowerCase();
        /*
          结算事件对应的 OrderCreated 不在本次扫描区间内（或在区间内但不属于本店）。
          两种情况无法在这里区分（`created` 已按 OWNER 过滤），所以**计数**而不是丢弃一行不留痕
          （源码审计 2026-09 复审，P1：旧实现的计数器 `noCreated` 写在"settledIds 里找不到
          created 条目"处，而那条路径**恒不可达**——settledIds 就是由这里的 created 命中筛出来的，
          于是唯一的解释性告警永远打不出来）。真正的区分在下面 A 段用 getOrder 逐个判定。
        */
        if (!created.has(id)) {
          skippedNoCreated += 1;
          continue;
        }
        // 裁决/退款按退款额判定「卖家是否收到钱」：refundWei == 金额 ⇒ 全额退买家（不计收款）；
        // refundWei < 金额 ⇒ 拆分结算（卖家收到余额，计入结算单）。两条出口都可能有部分金额：
        // 仲裁人 `arbitrate`（任意比例、无需授权）与 **买家已授权金额的 `approveRefund`**
        //（2026-09 契约：只接受「全额」或 `acceptedPartialRefund[orderId]`，其它 RefundAmountNotAccepted）。
        // 所以这里一律按 refundWei 判，不假设"RefundApproved 恒为全额"（防合约口径再变时漏算）。
        // 金额取 OrderCreated 里锁定的托管额（同一 orderId 复用 created 映射）。
        if (evName === 'Arbitrated' || evName === 'RefundApproved') {
          const refundWei = BigInt(ev.args.refundWei ?? 0n);
          const amount = BigInt(created.get(id)?.amount ?? 0n);
          if (amount > 0n && refundWei >= amount) continue; // 全额退款：不计收款
        }
        settleSets[settleKey].add(id);
      } catch {
        /* ignore */
      }
    }
  }
  const settledIds = new Set([
    ...settleSets.ReceiptConfirmed,
    ...settleSets.OrderExpiredReleased,
    ...settleSets.ArbitratedPaid,
    ...settleSets.RefundApprovedPaid,
  ]);
  return { created, settledIds, byName: settleSets, latest, from, skippedNoCreated };
}

/**
 * **全局兜底**收费方口径（只在某单没有创建时快照时参与折算，见 orderChargeable）：
 * 在线时由 readFeeCollector()（裸 JSON-RPC，避开 BTY 兼容层的解析问题）给出；
 * --db-only 时由 --fee-collector 参数给出（未给=未知 ⇒ 保守按"会扣费"折算并在输出标注，
 * 与 src/fees.js 在 feeCollectorKnown=false 时的取舍一致）。
 */
async function resolveFeeCollector() {
  if (!DB_ONLY) {
    const fc = await readFeeCollector();
    return { ...fc, source: 'chain' };
  }
  if (FEE_COLLECTOR_ARG === null) return { ...UNKNOWN_COLLECTOR, source: 'offline-unknown' };
  return { addr: isZeroAddr(FEE_COLLECTOR_ARG) ? ZERO : String(FEE_COLLECTOR_ARG), known: true, source: 'arg' };
}

async function main() {
  /*
    兜底判据必须在**本地汇总之前**确定：先用它（或每行的创建时快照）算本地期望实收，
    再用同一个函数算链上侧——两侧口径只有一个来源（orderChargeable）。
    旧顺序（先本地汇总、链上侧才读 feeCollector）会让「feeBps>0 而链上不扣费」的部署
    本地扣费、链上不扣，输出恒差一个费额。
  */
  if (!DB_ONLY && !ESCROW) {
    // 早失败：没配托管合约就不必先花 20s 去等一次注定失败的 eth_call（与旧行为一致：直接报错退出）
    console.error('[reconcile] 缺少 MK_ESCROW_ADDRESS（托管合约地址）');
    process.exitCode = 1;
    return;
  }
  const fc = await resolveFeeCollector();
  const chargeable = !(fc.known && isZeroAddr(fc.addr));
  const local = loadLocal({ chargeable });
  console.log('[reconcile] 本地已入账单（confirmed/settled/expired）：');
  /*
    这一行必须真的把数字打出来（源码审计 2026-09 修复）：旧写法 `单数=\ 毛额=\ wei …` 的模板
    占位符全丢了，`--db-only`（无网环境核数、以及恢复/迁移验收都拿它当结论）实际只输出一句空壳，
    运维看不到任何数字却以为"核过了"。
  */
  console.log(
    `[reconcile]   单数=${local.summary.count} 毛额=${local.summary.gross} wei ` +
      `已退买家=${local.summary.refunded} wei 平台费=${local.summary.fee} wei 期望实收=${local.summary.net} wei`
  );
  console.log(
    `[reconcile] 平台费判据（**按单**的创建时收费方快照；全局值只作兜底）：feeCollector=${fc.known ? fc.addr : '(未知)'} ` +
      `${fc.known ? (chargeable ? '（非零地址=兜底按会扣费）' : '（零地址=兜底按不扣费）') : '（未知=兜底保守按名义费率折算）'}` +
      `${fc.source === 'arg' ? '［来自 --fee-collector］' : fc.source === 'offline-unknown' ? '［--db-only 不连链，未给 --fee-collector］' : ''}`
  );
  if (local.summary.unknownSnapshot > 0) {
    console.log(
      `[reconcile] ⚠ 本地 ${local.summary.unknownSnapshot} 单没有"创建时收费方"快照（fee_collector_at_create 为空）` +
        '——这些单只能按上面的全局兜底折算，与链上实际扣费可能不符（节点会在 paid/watcher/sync 时补录）'
    );
  }
  if (DB_ONLY) {
    if (fc.source === 'offline-unknown' && local.summary.unknownSnapshot > 0) {
      console.log(
        '[reconcile] ⚠ 离线口径：无快照的行按名义费率折算。若本部署这些行在链上其实不扣费' +
          '（创建时未配收取方），卖家面板的流水会比你看到的多一个费额——加 --fee-collector none 即与面板同口径'
      );
    }
    console.log('[reconcile] --db-only：跳过链上比对');
    return;
  }

  const onchain = await loadOnchain();
  /*
    A：本地已入账但链上**区间内**无结算事件。

    这里必须把两种完全不同的情况分开（源码审计 2026-09 复审，P1）：
      · `missing`      —— 链上确实查不到该单的终局事实 ⇒ **真差异**（漏扫/数据异常），退出码 2；
      · `outOfWindow`  —— 该单在链上**确实存在且已终局**，只是它的 `OrderCreated` 落在扫描区间之外
                          （默认回溯 200000 块 ≈ 11.6 天）⇒ 是**覆盖不足**，不是账目差异。
    旧实现把两者都算进 `missing` 并一律 exit 2：任何营业超过 12 天的店跑 `npm run reconcile`
    **永远报差异**，而这条命令既写在部署验收清单里、又是监控挂钩——恒红的告警很快就会被
    "习惯性忽略"，脚本存在的意义（发现真正的不符）正好被它自己抹掉。
    判定方式：对每个 missing 候选读一次链上 getOrder（`readOnchainOrderFacts`），
    status ∈ {Settled, Refunded} 且 seller 与本店一致 ⇒ 归入 outOfWindow。
    读不到（RPC 失败）时保守地仍算 missing——宁可报一个待人工确认的差异，也不静默放过。
  */
  const missing = [];
  const outOfWindow = [];
  for (const [id, row] of local.byOrderId) {
    if (onchain.settledIds.has(id)) continue;
    let facts = null;
    try {
      facts = await readOnchainOrderFacts(id);
    } catch {
      facts = null;
    }
    const terminalOnchain = !!facts && (facts.status === 3 || facts.status === 4);
    const sellerOk = !OWNER || !facts || !facts.seller || facts.seller === OWNER;
    if (terminalOnchain && sellerOk) {
      outOfWindow.push({ id: id.slice(0, 18) + '…', amount: row.amount.toString(), status: row.status });
    } else {
      missing.push({ id: id.slice(0, 18) + '…', amount: row.amount.toString(), status: row.status });
    }
  }
  // B：链上已结算（本店订单）但本地未入账（watcher 漏扫/状态不同步/超出本地库范围）
  const extra = [];
  for (const id of onchain.settledIds) {
    if (!local.byOrderId.has(id)) {
      extra.push({ id: id.slice(0, 18) + '…', amount: onchain.created.get(id)?.amount?.toString() || '?' });
    }
  }
  // C：链上实际到账汇总。费率取**链上 getOrder(orderId).feeBps**（源码审计 2026-09 修复：
  // 此前取本地 fee_bps，本地快照写错时两边同错 → 对账永远报「一致」，本该由对账脚本
  // 抓出的账目错误被自证掩盖）。
  // 「这单扣不扣费」同样**按单**判：优先用链上 getOrder 的 feeCollectorAtCreate（权威），
  // 读不到时退回本地同名列，再退回全局兜底——三段与本地侧共用 orderChargeable。
  let onchainNet = 0n;
  let feeSourceLocal = 0;
  /*
    注：这里**不再**维护"OrderCreated 落在区间外"的计数器——`settledIds` 本身就是"命中
    `created`"的那批 id，所以这个循环里 `!c` 恒不成立，写在这里的计数器永远为 0（死代码）。
    真正的计数在 `loadOnchain` 里（`skippedNoCreated`，见上方告警）。
  */
  let snapSourceLocal = 0; // 未能从链上读到创建时收费方快照（退回本地列/全局口径）
  for (const id of onchain.settledIds) {
    const c = onchain.created.get(id);
    if (!c) continue;
    const facts = await readOnchainOrderFacts(id);
    let bps;
    let refunded = 0n;
    let snap = '';
    if (facts === null) {
      // 链上真值读不到（RPC 抖动）：退回本地快照并计数，输出里显式标注（可能掩盖费率/退款额错误）
      const localRow = local.byOrderId.get(id);
      bps = localRow ? localRow.feeBps : 0;
      refunded = localRow ? localRow.refunded : 0n;
      snap = localRow ? localRow.feeCollectorAtCreate : '';
      feeSourceLocal += 1;
    } else {
      bps = facts.feeBps;
      refunded = facts.refundedAmount;
      snap = facts.feeCollectorAtCreate;
    }
    if (!snap) {
      // 链上元组里还没有该字段（ABI 未同步）→ 试本地列（节点补录过就有）
      const localRow = local.byOrderId.get(id);
      if (localRow && localRow.feeCollectorAtCreate) snap = localRow.feeCollectorAtCreate;
      else snapSourceLocal += 1; // 两边都未知：退回全局兜底口径
    }
    // 净额 = 托管额 − 已退买家 − 平台费（只对未退部分计费，与 Escrow._settle 一致）
    const base = c.amount > refunded ? c.amount - refunded : 0n;
    onchainNet += base - (orderChargeable(snap, chargeable) ? nominalFeeOf(base, bps) : 0n);
  }
  if (feeSourceLocal > 0) {
    console.log(`[reconcile] ⚠ ${feeSourceLocal} 单未能读到链上 feeBps（已退回本地快照，可能掩盖费率快照错误）`);
  }
  if (snapSourceLocal > 0) {
    console.log(
      `[reconcile] ⚠ ${snapSourceLocal} 单的"创建时收费方"链上与本地都读不到（本地未补录 / getOrder 元组未同步）` +
        '——这些单按全局兜底口径折算，可能与链上实际扣费不符'
    );
  }
  if (onchain.skippedNoCreated > 0) {
    console.log(
      `[reconcile] ⚠ ${onchain.skippedNoCreated} 个结算事件的 OrderCreated 不在扫描区间内（或不属于本店）——` +
        '托管额未知，未计入链上汇总；需要覆盖全史时用 --start-block <Escrow 部署块> 重跑'
    );
  }

  console.log('[reconcile] 链上本店结算事件：');
  console.log(`[reconcile]   确认=${onchain.byName.ReceiptConfirmed.size} 超时释放=${onchain.byName.OrderExpiredReleased.size} 仲裁判付=${onchain.byName.ArbitratedPaid.size}`);
  console.log(`[reconcile]   链上实际到账估算=${onchainNet.toString()} wei（费率取链上 getOrder 快照）`);
  const diff = onchainNet - local.summary.net;
  console.log(`[reconcile]   本地期望实收=${local.summary.net.toString()} wei → 差额=${diff.toString()} wei`);
  if (missing.length) {
    console.log(`\n⚠ 本地已入账但链上查不到终局事实（${missing.length} 单，疑似 watcher 漏扫或数据异常）：`);
    for (const m of missing) console.log(`   ${m.id} amount=${m.amount} status=${m.status}`);
  }
  if (outOfWindow.length) {
    console.log(
      `\nℹ ${outOfWindow.length} 单在链上已终局、只是其 OrderCreated 落在本次扫描区间之外` +
        `（区间起点 ${onchain.from}）——**这是覆盖不足，不是账目差异**，不计入退出码。` +
        '\n  需要覆盖全史时用 --start-block <Escrow 部署块>（或 --blocks <更大回溯块数>）重跑。'
    );
    for (const m of outOfWindow.slice(0, 20)) console.log(`   ${m.id} amount=${m.amount} status=${m.status}`);
    if (outOfWindow.length > 20) console.log(`   …另有 ${outOfWindow.length - 20} 单（同上）`);
  }
  if (extra.length) {
    console.log(`\n⚠ 链上已结算但本地未入账（${extra.length} 单，watcher 漏扫/状态不同步）：`);
    for (const e of extra) console.log(`   ${e.id} amount=${e.amount}`);
  }
  if (diff !== 0n) {
    console.log(
      `\n⚠ 两侧数额差额 ${diff.toString()} wei（行配对得上但数额不符）：常见原因是本地 fee_bps/refunded_amount_wei` +
        '快照写错、平台费判据漂移，或链上订单的 OrderCreated 落在扫描区间外（见上方提示）'
    );
  }
  if (!missing.length && !extra.length && diff === 0n) {
    console.log(
      '\n✅ 本地入账与链上结算事件一致（区间内）' +
        (outOfWindow.length ? `；区间外另有 ${outOfWindow.length} 单已核实为链上终局（覆盖不足，非差异）` : '')
    );
  }
  /*
    退出码（源码审计 2026-09 修复）：差异有三类——本地有链上无（missing）、链上有本地无（extra）、
    **行配对得上但数额不等（diff ≠ 0）**。旧版只看前两类，于是「feeBps>0 而链上 feeCollector=0」
    这类"两侧口径不同、行却配对得上"的部署下，差额恒为一个费额而退出码仍是 0：接监控的人读到
    "一致"，对账脚本存在的意义（发现账目不符）正好被它自己抹掉。三类一律 exit 2。
    2026-09 复审补：`outOfWindow`（链上已终局、只是超出扫描区间）**不置 2** —— 它是覆盖不足，
    不是差异；把它算作差异会让任何营业超过回溯窗口的店恒定报红（见上面 A 段的说明）。
  */
  process.exitCode = missing.length || extra.length || diff !== 0n ? 2 : 0;
}

main().catch((e) => {
  console.error('[reconcile] 链上比对失败：', e.message || e);
  console.error('[reconcile] 提示：可用 --db-only 仅核对本地侧统计');
  process.exitCode = 1;
});