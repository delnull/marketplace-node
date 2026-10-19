#!/usr/bin/env node
/**
 * 收款流水链上对账脚本（只读，节点级多店视角）
 *
 * 目的：把「本地已入账订单的期望实收（净额）」与「链上 Escrow 实际释放给本节点名下各店」对账，
 * 输出按店的差异清单与汇总——用于核验 watcher/ledger 口径、发现漏扫事件或本地脏数据。
 *
 * 口径：
 *  - **本节点 = MK_SHOP_OWNER（节点主/operator）**；托管 = MK_ESCROW_ADDRESS；RPC = MK_RPC_URL
 *  - 链上不再用 `seller == owner` 过滤：一个节点可以承载多家租户店，`seller` 是店主、不是节点主。
 *    本节点订单判据是 **`OrderCreated.host == owner`**（当前合约在创建事件里携带创建时快照
 *    的 host；零抽成也带 host）。只有本地订单的 OrderCreated 落在扫描区间外时，才回读
 *    `commissionTermsAtCreate.payee` 作为兜底。
 *  - 本地侧从 `v_orders` 读取**所有**带链上单号的订单：入账汇总只用
 *    `confirmed/settled/expired`；其余状态保留在 byOrderId，用于识别“链上已结算、本地状态没跟上”。
 *    每个订单带 `shop_code`，所以本节点多家店各有自己的小计。
 *  - 事件扫描区间默认取 `MK_ESCROW_START_BLOCK`（节点 .env，标准部署即 Escrow 部署块）；
 *    没有该值时退回 `--blocks`/200000。**默认回溯不足会让“链上有、本地没有”漏报**，多店节点
 *    应用 `--start-block` 覆盖全史。
 *  - **平台费判据是"每单"的**（契约层 2026-09）：合约 `Escrow._settle` 只读**创建订单时**快照的
 *    收费方（`getOrder(...).feeCollectorAtCreate`，零地址 = 这单永不扣费），全局 `feeCollector()`
 *    已被删除（实时读全局会让 owner 事后改配置影响到在途单）。本地侧只用一处判据
 *    `orderChargeable(快照, 全局兜底)`：
 *      · 本地侧：用本地库 `orders.fee_collector_at_create`（节点在 paid/watcher/sync 时补录）；
 *      · 没有快照（补录缺失/元组未同步）→ 退回全局兜底口径（在线读链上全局值；`--db-only`
 *        时由 `--fee-collector` 给出，未给则保守按"会扣费"折算）。
 *  - **链上侧只读链上实数，不再复算**（P1-1）：实际到账取 `Escrow.sellerNetAtSettle(orderId)`、
 *    节点抽成取 `Escrow.commissionAtSettle(orderId)`——这两项是 `_settle` 落库的结果。
 *  - 本地侧：每个入账单的期望实收 =（amount_wei − refunded_amount_wei）− 平台费 − 节点抽成。
 *    抽成取**订单级** `commission_bps` / `commission_to` 快照（`commission_to IS NULL` = 从未补录
 *    ⇒ 抽成未知 ⇒ 该轮**无法核对**，退出码 3）。
 *  - 链上已结算但本地**完全没有该单** = 漏扫；本地有该单但状态不是入账态 = 状态不同步；两者
 *    都列入差异（exit 2），但文案分开。
 *
 * 用法：
 *   node scripts/reconcile-ledger.js [--start-block 0] [--blocks N]
 *   （RPC/合约/节点主取自环境变量 MK_RPC_URL/MK_ESCROW_ADDRESS/MK_SHOP_OWNER，缺省读 .env：
 *     npm run reconcile —— package.json script，经 --env-file-if-exists=.env 注入；
 *     本地库取自 MK_DB_*（MK_DB_HOST/PORT/USER/PASSWORD/NAME））
 *   --db-only          仅输出本地侧统计（不连 RPC，供无网环境核数）
 *   --fee-collector A  离线核数用，设定**全局兜底口径**的收费方（`none`/零地址 = 不扣费）
 *   --blocks N         未给 --start-block/MK_ESCROW_START_BLOCK 时回溯 N 块（默认 200000）
 *   exit code：0=一致（或仅覆盖不足提示）；2=存在差异（本地漏单/链上漏扫/状态不同步/数额差额）；
 *              3=**没核对成**（链上 host/净额/抽成/getOrder 读不到，或本地抽成/平台费快照未补录）；
 *              1=脚本自身失败
 *
 * 注意：BTY 主网 EVM 不支持 PUSH0 等与本脚本无关；区块可能含系统交易，但 eth_getLogs 只回普通日志，
 * 不受影响。事件区间按 ≤2000 块分段拉取。
 */
import mysql from 'mysql2/promise';
import config from '../src/config.js';
import { assertDbConfigured } from '../src/db.js';
import { Interface } from 'ethers';

// ── 参数与配置 ──
const args = process.argv.slice(2);
const argVal = (name, fb = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fb;
};
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
/*
  **默认从 Escrow 部署块扫起**：节点 .env 的 MK_ESCROW_START_BLOCK 就是标准部署写入的部署块。
  旧默认只回溯 200000 块（≈11.6 天），营业超过窗口的节点会永远把历史单报成“区间外覆盖不足”，
  而多店节点一旦漏扫链上却本地没有的单，恰恰是脚本最该发现的差异。显式 --start-block 优先；
  没有该值时才用 --blocks 回溯。
*/
const START_BLOCK = Number(argVal('--start-block', process.env.MK_ESCROW_START_BLOCK || 0));
/** 默认回溯块数（只在没有 --start-block / MK_ESCROW_START_BLOCK 时使用） */
const DEFAULT_BLOCKS = Number(argVal('--blocks', 200000)) || 200000;
const RPC_TIMEOUT_MS = 20000;
/** 链上刚创建、尚未越过确认深度的单，watcher 还没处理是正常的；只对“已成熟”的链上单报漏扫。 */
const FINALITY_BLOCKS = Number(config.escrow?.finalityBlocks ?? 12);

const INCOME_STATUS = ['confirmed', 'settled', 'expired'];

/** Escrow 结算相关事件（orderId 均 indexed；Arbitrated 现带 refundWei：全额退买家不计收款） */
const ABI = [
  'event OrderCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, address host, uint256 amount)',
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
  /*
    创建时的节点抽成条款：`payee` 是节点主地址。当前合约已把 host 放进 OrderCreated
    事件，正常路径不再逐单调用；只有本地订单的创建事件在扫描区间外时才用它兜底。
    不能再用 `OrderCreated.seller == MK_SHOP_OWNER`：租户店的 seller 是店主，不是节点主；
    零抽成也存 payee，所以 bps=0 不能被当成“无主”。
  */
  'function commissionTermsAtCreate(bytes32 orderId) view returns (address payee, uint16 bps)',
  // 全局收取方（只作为"该单没有创建时快照"时的兜底披露，不再用于判定单笔扣不扣费）
  'function feeCollector() view returns (address)',
  /*
    链上结算的**实数**（P1-1）：脚本不再自己按 bps 复算链上净额/抽成。
      · `sellerNetAtSettle(orderId)` —— 判给卖家时的实收净额（已扣平台费与节点抽成）；
      · `commissionAtSettle(orderId)` —— 结算时**实际付给节点主**的抽成（0 = 本单没抽成）。
    两者都是 `_settle` 落库的结果；若按本地/名义费率复算，`commission_bps>0` 的店会因为漏掉
    抽成腿而恒差一个抽成额（更糟：两侧同错时自证一致）。读不到（旧合约/ABI 未同步）= 未知，
    本脚本据此报"没核对成"（退出码 3），绝不回落到复算值。
  */
  'function sellerNetAtSettle(bytes32 orderId) view returns (uint256)',
  'function commissionAtSettle(bytes32 orderId) view returns (uint256)',
];
const iface = new Interface(ABI);
const TOPIC = (name) => iface.getEvent(name).topicHash;

/**
 * 名义费率折算（**只算名义值**）：amountWei × feeBps / 10000（下取整，与链上 `Escrow._settle`
 * 及 src/fees.js 同款算式）。
 * ⚠️ 这里**不判**收费方——"这一单扣不扣费"由**每单**的创建时收费方快照与**该单卖家**共同决定，
 * 判据只在 orderChargeable() 一处（本地与链上两侧共用）；判据散成两处正是本次修复要消灭的东西
 * （见文件头）。
 */
const nominalFeeOf = (amountWei, feeBps) => (feeBps > 0 ? (amountWei * BigInt(feeBps)) / 10000n : 0n);

/**
 * 本地抽成折算（与 `nominalFeeOf` **同基数、同下取整**，见 src/fees.js 的 commissionOf）。
 * 收款人为空/零地址 ⇒ 0（那一单确证不抽成）；但**`commission_to IS NULL` 不是这一档**——
 * 它表示"从未补录"（未知），调用方必须先按未知处理，绝不能先折成 0。
 */
const nominalCommissionOf = (amountWei, commissionBps, commissionTo) => {
  const bps = Number(commissionBps);
  if (!Number.isInteger(bps) || bps <= 0) return 0n;
  const to = String(commissionTo ?? '').trim().toLowerCase();
  if (!to || isZeroAddr(to)) return 0n;
  return (amountWei * BigInt(bps)) / 10000n;
};
const ZERO = '0x0000000000000000000000000000000000000000';

/** 零地址/`none` 归一（离线参数与链上读取共用判定） */
const isZeroAddr = (a) => String(a || '').toLowerCase() === ZERO || String(a || '').toLowerCase() === 'none';
const UNKNOWN_COLLECTOR = { addr: null, known: false };

/**
 * 这一单是否会被扣费（**唯一判据**，本地与链上两侧共用；语义与 src/fees.js 的
 * `feeChargeableForOrder` + `feeOf` 的"平台不向自己收费"那一项**逐字一致**）：
 *   ① 快照为空（未补录/元组未同步）→ 退回全局保守口径（`globalChargeable`：未知=按会扣费算）；
 *   ② 快照是零地址 → 这单永不扣费（合约只读快照）；
 *   ③ **快照 == 该单卖家** → 链上 `_splitOf` 把整条腿归零（"平台不向自己收费"，
 *      `Escrow.sol` 的平台腿自付判据）⇒ 这里也必须判 0。
 *
 * ⚠️ ③ 是 2026-10-16 补的**镜像漂移**修复：链上加了这条判据，而本地与链上两侧的对账都没加，
 * 于是 `feeCollector == seller` 的单（平台自营店，Escrow 注释里写明的运营形态）两侧会
 * **同时**按 feeBps 扣出一个链上根本没扣的数 —— 差异永远不会报警（两边同错即自证），
 * 只会把平台费收入系统性虚增、把卖家实收报低。判据必须与链上同批同处。
 */
const orderChargeable = (feeCollectorAtCreate, globalChargeable, seller) => {
  const snap = String(feeCollectorAtCreate ?? '').trim().toLowerCase();
  if (!snap) return globalChargeable;
  if (isZeroAddr(snap)) return false;
  const s = String(seller ?? '').trim().toLowerCase();
  if (s !== '' && snap === s) return false; // 平台不向自己收费（= 该单卖家就是收取方）
  return true;
};

/**
 * 连本地库（**只读**：读完之后连接就断了，本脚本从不下发写语句）。
 *
 * 为什么不用 `initDb()`：它会 auto-create——库名写错时脚本会自己造一个空库出来，然后"对账"
 * 一份空账，报"一致"。所以这里用一条普通连接连上去，`ER_BAD_DB_ERROR` 原样变成一句可照做的提示。
 * 顺带一个好处：不走 initDb 就不进节点实例锁（GET_LOCK），于是**节点跑着的时候也能对账**。
 */
async function connectLocal() {
  // 与节点启动同一道配置门禁（唯一实现在 src/db.js）
  assertDbConfigured();
  const { host, port, user, password, name } = config.db;
  try {
    return await mysql.createConnection({
      host, port, user, password, database: name,
      charset: 'utf8mb4',
      /*
        读口径必须与 src/db.js **逐项一致**，否则"对账"本身会引入差异：
          · decimalNumbers:false —— 金额列是 DECIMAL(38,0)，打开它会静默取整（38 位装不进 JS number）；
            对账正是拿这些数字与链上比，取整就等于自己制造假差异。
          · timezone:'Z' —— 时间列是 DATETIME(3)，会话时区与驱动时区必须同时钉在 UTC。
      */
      decimalNumbers: false,
      supportBigNumbers: true,
      bigNumberStrings: false,
      timezone: 'Z',
      dateStrings: false,
      multipleStatements: false,
      connectTimeout: 10_000,
    });
  } catch (e) {
    if (e.code === 'ER_BAD_DB_ERROR') {
      console.error(`[reconcile] 库 \`${name}\` 不存在（${host}:${port}）。`);
      console.error('[reconcile] 对账脚本不会替你新建一个空库——那会把"你查的不是那个库"报成"一致"。');
      console.error('[reconcile] 处置：确认 MK_DB_HOST/MK_DB_NAME 指向节点真正在用的那个库（见 .env）。');
    } else {
      console.error(`[reconcile] 连不上 MySQL（${host}:${port}，用户 ${user}）：${e?.message || e}`);
      console.error('[reconcile] 连接参数取自 MK_DB_HOST/MK_DB_PORT/MK_DB_USER/MK_DB_PASSWORD/MK_DB_NAME（见 .env）。');
    }
    process.exit(1);
  }
}

// ── 本地侧 ──
/**
 * 本地侧汇总。`chargeable` = **全局兜底判据**（读链得到的全局 feeCollector，或离线参数）；
 * 每行的实际判定走 orderChargeable(row.fee_collector_at_create, chargeable)——与链上侧共用
 * 同一个函数，且与卖家面板（src/fees.js）同口径。
 * 本地库里的 fee_collector_at_create / commission_to 由节点在 paid/watcher/sync 时从链上补录。
 */
async function loadLocal({ chargeable }) {
  const conn = await connectLocal();
  /*
    读**全部**带链上单号的本地订单，而不是只读入账态：
      · 入账态（confirmed/settled/expired）进入金额汇总；
      · 其它状态只用来回答“链上已结算的这单，本地到底有没有/状态是否跟上”——
        旧实现只读入账态，于是链上已结算、本地还是 disputed 的单会同时出现在
        “本地已入账但链上查不到（missing）”和“链上已结算但本地未入账（extra）”两个清单里。
    多店节点必须有 `shop_code`：每行属于哪家店是本地事实，链上订单的归属则看
    `OrderCreated.host`（区间外才回退到 `commissionTermsAtCreate.payee`，见 loadOnchain）。
  */
  let rows;
  try {
    [rows] = await conn.query(`SELECT escrow_order_id, shop_code, amount_wei, fee_bps, fee_collector_at_create,
              commission_bps, commission_to, refunded_amount_wei, seller, status
         FROM v_orders WHERE escrow_order_id IS NOT NULL`);
  } finally {
    await conn.end().catch(() => {});
  }
  const byOrderId = new Map();
  const byShop = new Map();
  let gross = 0n;
  let fee = 0n;
  let commission = 0n;
  // 本地侧净额口径与链上一致：net = Σ(amount − refunded) − fee − commission（只对未退部分计）
  let refundedTotal = 0n;
  let incomeCount = 0;
  let unknownSnapshot = 0; // 平台费收费方快照为空（退回全局口径）的入账行数——提示补录缺失
  let unknownCommission = 0; // 抽成条款快照为空（commission_to IS NULL）= 从未补录 = 未知
  /** 未知档的订单号（输出里点出来，便于直接补录；只留短形式，最多 20 条） */
  const unknownSnapshotIds = [];
  const unknownCommissionIds = [];
  const noteUnknown = (list, id) => {
    if (list.length < 20) list.push(`${String(id).slice(0, 18)}…`);
  };
  for (const r of rows) {
    const amt = BigInt(r.amount_wei || '0');
    const refunded = BigInt(r.refunded_amount_wei || '0');
    const base = amt > refunded ? amt - refunded : 0n;
    const snap = String(r.fee_collector_at_create || '');
    const seller = String(r.seller || '').toLowerCase();
    const shopCode = String(r.shop_code || '');
    const status = String(r.status || '');
    /*
      `commission_to` 的三态：NULL = 从未补录（未知，**不得折成 0**）；零地址 = 确证这一单不抽成；
      非零 = 已知收款人。旧实现对这一列完全不读 ⇒ commission_bps>0 的店本地期望实收虚高一个抽成额。
    */
    const commissionTo = r.commission_to === null || r.commission_to === undefined
      ? null
      : String(r.commission_to).trim().toLowerCase();
    const id = String(r.escrow_order_id).toLowerCase();
    byOrderId.set(id, {
      amount: amt,
      refunded,
      feeBps: Number(r.fee_bps || 0),
      feeCollectorAtCreate: snap,
      commissionBps: Number(r.commission_bps || 0),
      commissionTo,
      seller,
      shopCode,
      status,
    });
    if (!INCOME_STATUS.includes(status)) continue;
    incomeCount += 1;
    if (!snap) {
      unknownSnapshot += 1;
      noteUnknown(unknownSnapshotIds, id);
    }
    if (commissionTo === null) {
      unknownCommission += 1;
      noteUnknown(unknownCommissionIds, id);
    }
    const f = orderChargeable(snap, chargeable, seller) ? nominalFeeOf(base, Number(r.fee_bps || 0)) : 0n;
    const c = commissionTo === null ? 0n : nominalCommissionOf(base, Number(r.commission_bps || 0), commissionTo);
    gross += amt;
    refundedTotal += refunded;
    fee += f;
    commission += c;
    let shop = byShop.get(shopCode);
    if (!shop) {
      shop = {
        code: shopCode,
        seller,
        count: 0,
        gross: 0n,
        refunded: 0n,
        fee: 0n,
        commission: 0n,
        net: 0n,
      };
      byShop.set(shopCode, shop);
    }
    shop.count += 1;
    shop.gross += amt;
    shop.refunded += refunded;
    shop.fee += f;
    shop.commission += c;
    shop.net += base - f - c;
  }
  return {
    byOrderId,
    byShop,
    summary: {
      count: incomeCount,
      allCount: rows.length,
      gross,
      refunded: refundedTotal,
      fee,
      commission,
      net: gross - refundedTotal - fee - commission,
      unknownSnapshot,
      unknownCommission,
      unknownSnapshotIds,
      unknownCommissionIds,
    },
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
 * 读一个 `uint256` 只读视图（`sellerNetAtSettle` / `commissionAtSettle`）。
 * 返回 bigint；读不到/解码失败返回 **null**（未知，由调用方报"没核对成"）。
 */
async function readUintView(fn, orderId) {
  const hex = await ethCall(iface.encodeFunctionData(fn, [orderId]));
  if (!hex) return null;
  try {
    const [v] = iface.decodeFunctionResult(fn, hex);
    return BigInt(v);
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
 * 读某订单的链上元组读数：feeBps 快照 + **创建时收费方快照** + 已退买家金额。
 * 注意：这里**不**用于计算链上净额（那是 `sellerNetAtSettle` 的事）；`refundedAmount`
 * 只用于把链上平台费**反推**出来（毛额 − 已退 − 抽成 − 实收），以及判断这一单需要人工核。
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
      /*
        退款额**不兜 0**：`?? 0n` 会把"这个字段读不到/元组缺列"写成"链上确证没退过款"，
        而对账脚本的职责恰恰是把"读不到"报出来。缺字段时 BigInt 抛错 → 外层 catch 返回 null
        → 该单走"读不到链上退款额"的分支并逐条标注（宁可吵，不要假绿）。
      */
      refundedAmount: BigInt(r.refundedAmount),
    };
  } catch {
    return null;
  }
}

/**
 * 读创建时的抽成条款（`payee` = 节点主地址）。
 *
 * 三态：
 *   · 对象 `{payee: 非零地址}` —— 这一单属于该节点；
 *   · 对象 `{payee: '', bps}` —— 链上确证没有可用的 payee（零地址）。当前合约即使 bps=0 也存
 *     host，所以这只会是异常数据；按**归属未知**处理（fail-closed），不能当成
 *     “不属于本节点”直接丢掉；
 *   · `null` —— RPC/解码失败，**不是零地址**，同样按未知处理。
 */
async function readCommissionTerms(orderId) {
  const hex = await ethCall(iface.encodeFunctionData('commissionTermsAtCreate', [orderId]));
  if (!hex) return null;
  try {
    const [payee, bps] = iface.decodeFunctionResult('commissionTermsAtCreate', hex);
    const p = String(payee || '').toLowerCase();
    return { payee: isZeroAddr(p) ? '' : p, bps: Number(bps) };
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
  /*
    多店节点必须知道“本节点是谁”，但归属不再需要逐单读 mapping：当前 Escrow 的
    `OrderCreated` 事件直接携带创建时快照的 host（`terms.commissionTo`）。
    seller 只是店主；host 才是节点。没有 MK_SHOP_OWNER 仍无法判本节点，直接失败。
  */
  if (!OWNER) {
    throw new Error('多店对账需要 MK_SHOP_OWNER（节点主/operator 地址）；它不等于店主 seller');
  }
  const latest = Number(await rpc('eth_blockNumber', []));
  const from = START_BLOCK > 0 ? START_BLOCK : Math.max(0, latest - DEFAULT_BLOCKS);
  console.log(`[reconcile] 链上扫描 ${from}..${latest} escrow=${ESCROW} nodeOwner=${OWNER}`);

  // 1) OrderCreated：事件自带 host，不再对每个订单发 commissionTermsAtCreate。
  const createdLogs = await getLogsRange(ESCROW, TOPIC('OrderCreated'), from, latest);
  const created = new Map(); // orderId -> { amount, seller, block, host, hostKnown }
  for (const l of createdLogs) {
    try {
      const ev = iface.parseLog({ topics: l.topics, data: l.data });
      const id = String(ev.args.orderId).toLowerCase();
      if (!created.has(id)) {
        const host = String(ev.args.host || '').toLowerCase();
        created.set(id, {
          amount: BigInt(ev.args.amount),
          seller: String(ev.args.seller || '').toLowerCase(),
          block: Number(l.blockNumber),
          host,
          hostKnown: !!host && !isZeroAddr(host),
        });
      }
    } catch {
      /* 忽略无法解析日志 */
    }
  }
  let hostedCount = 0;
  let foreignCount = 0;
  let hostUnknownCount = 0;
  for (const c of created.values()) {
    if (!c.hostKnown) hostUnknownCount += 1;
    else if (c.host !== OWNER) foreignCount += 1;
    else hostedCount += 1;
  }
  console.log(
    `[reconcile] 区间内 OrderCreated=${created.size}：本节点托管=${hostedCount} 其它节点=${foreignCount} ` +
      `归属读不到=${hostUnknownCount}（host 由 OrderCreated 事件携带，零 eth_call）`
  );

  // 2) 结算事件：只统计“本节点托管”的订单；归属读不到的单进入 unverified，不直接算差异。
  let skippedNoCreated = 0;
  let skippedForeign = 0;
  let orphanHosted = 0;
  let orphanHostUnreadable = 0;
  const hostUnreadableSettled = new Set();
  const refundedIds = new Set();
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
        const c = created.get(id);
        if (!c) {
          /*
            `OrderCreated` 不在扫描区间。先读抽成条款：能确定是别的节点 ⇒ 静默跳过；
            能确定是本节点 ⇒ 金额未知，**必须计入“没核对成”**；读不到 ⇒ 同样不能宣称一致。
          */
          skippedNoCreated += 1;
          const t = await readCommissionTerms(id);
          if (t?.payee && t.payee !== OWNER) {
            skippedForeign += 1;
            continue;
          }
          if (t?.payee === OWNER) orphanHosted += 1;
          else orphanHostUnreadable += 1;
          continue;
        }
        if (!c.hostKnown) {
          hostUnreadableSettled.add(id);
          continue;
        }
        if (c.host !== OWNER) {
          skippedForeign += 1;
          continue;
        }
        /*
          裁决/退款按退款额判定「卖家是否收到钱」：refundWei == 金额 ⇒ 全额退买家（不计收款）；
          refundWei < 金额 ⇒ 拆分结算（卖家收到余额，计入结算单）。两条出口都可能有部分金额：
          仲裁人 `arbitrate`（任意比例、无需授权）与 **买家已授权金额的 `approveRefund`**。
        */
        if (evName === 'Arbitrated' || evName === 'RefundApproved') {
          const refundWei = BigInt(ev.args.refundWei ?? 0n);
          const amount = BigInt(c.amount ?? 0n);
          if (amount > 0n && refundWei >= amount) {
            refundedIds.add(id); // 全额退款：不是卖家收款，但本地缺行仍要单独报
            continue;
          }
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
  return {
    created,
    settledIds,
    byName: settleSets,
    latest,
    from,
    skippedNoCreated,
    skippedForeign,
    orphanHosted,
    orphanHostUnreadable,
    hostUnreadableSettled,
    refundedIds,
    hostUnknownCount,
  };
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
  const local = await loadLocal({ chargeable });
  console.log('[reconcile] 本地已入账单（confirmed/settled/expired）：');
  /*
    这一行必须真的把数字打出来（源码审计 2026-09 修复）：旧写法 `单数=\ 毛额=\ wei …` 的模板
    占位符全丢了，`--db-only`（无网环境核数、以及恢复/迁移验收都拿它当结论）实际只输出一句空壳，
    运维看不到任何数字却以为"核过了"。
  */
  console.log(
    `[reconcile]   单数=${local.summary.count} 毛额=${local.summary.gross} wei ` +
      `已退买家=${local.summary.refunded} wei 平台费=${local.summary.fee} wei 期望实收=${local.summary.net} wei ` +
      `节点抽成=${local.summary.commission} wei（另有非入账本地订单 ${local.summary.allCount - local.summary.count} 条参与状态核对）`
  );
  /*
    多店节点必须能一眼看到“哪家店差”：只给一个节点级合计时，一家店的漏扫会被另一家店的
    正常数稀释。这里按 shop_code 各打一行；链上归属由 loadOnchain 的 host 判据保证。
  */
  console.log(`[reconcile] 本节点店铺 ${local.byShop.size} 家（仅列有入账订单的店）：`);
  for (const s of [...local.byShop.values()].sort((a, b) => a.code.localeCompare(b.code))) {
    console.log(
      `[reconcile]   ${s.code || '(无编号)'} seller=${s.seller} 单数=${s.count} 毛额=${s.gross} wei ` +
        `已退=${s.refunded} wei 平台费=${s.fee} wei 抽成=${s.commission} wei 期望实收=${s.net} wei`
    );
  }
  console.log(
    `[reconcile] 平台费判据（**按单**的创建时收费方快照；全局值只作兜底）：feeCollector=${fc.known ? fc.addr : '(未知)'} ` +
      `${fc.known ? (chargeable ? '（非零地址=兜底按会扣费）' : '（零地址=兜底按不扣费）') : '（未知=兜底保守按名义费率折算）'}` +
      `${fc.source === 'arg' ? '［来自 --fee-collector］' : fc.source === 'offline-unknown' ? '［--db-only 不连链，未给 --fee-collector］' : ''}`
  );
  if (local.summary.unknownSnapshot > 0) {
    /*
      **这一档不是"已核对"**：没有创建时快照 = 只能用全局兜底估算，而全局值事后可改、
      与在途单的实际扣费可以相反（方向两边都错）。它必须进入 unverified（退出码 3），
      否则一次"估算恰好等于链上实数"会让脚本给出 ✅——那是把"猜对了"当成"核对过"。
    */
    console.log(
      `[reconcile] ⚠ 本地 ${local.summary.unknownSnapshot} 单没有"创建时收费方"快照（fee_collector_at_create 为 NULL）` +
        '——这些单只能按全局兜底**估算**，**不能算作已核对**（退出码 3）。节点会在 paid/watcher/sync 时补录。'
    );
    if (local.summary.unknownSnapshotIds.length) {
      console.log(`[reconcile]   未核对清单（最多 20 条）：${local.summary.unknownSnapshotIds.join(' ')}`);
    }
  }
  if (local.summary.unknownCommission > 0) {
    /*
      抽成条款是**独立于平台费的三态**：`commission_to IS NULL` = 从未补录 = 不知道，
      与"零地址 = 确证不抽成"不是一回事。旧实现根本不读这两列 ⇒ 这一档被静默折成 0，
      于是 commission_bps>0 的店本地期望实收虚高、差额却可能恰好为 0（两侧同错即自证）。
    */
    console.log(
      `[reconcile] ⚠ 本地 ${local.summary.unknownCommission} 单没有节点抽成条款快照（commission_to IS NULL）` +
        '——这些单的抽成腿**未知**，本地期望实收无法核对（不是 0）；节点会在 paid/watcher/sync 时补录，' +
        '本轮的退出码为 3（没核对成）'
    );
    if (local.summary.unknownCommissionIds.length) {
      console.log(`[reconcile]   未核对清单（最多 20 条）：${local.summary.unknownCommissionIds.join(' ')}`);
    }
  }
  if (DB_ONLY) {
    if (fc.source === 'offline-unknown' && local.summary.unknownSnapshot > 0) {
      console.log(
        '[reconcile] ⚠ 离线口径：无快照的行按名义费率折算。若本部署这些行在链上其实不扣费' +
          '（创建时未配收取方），卖家面板的流水会比你看到的多一个费额——加 --fee-collector none 即与面板同口径'
      );
    }
    console.log('[reconcile] --db-only：跳过链上比对');
    /*
      离线核数同样不许把"估算"报成"已核对"：没有创建时快照（平台费）或没有抽成条款快照，
      这两条腿就是按全局兜底/0 估出来的。`--db-only` 没有链上可比，但这不等于"一致"；
      接监控的人只看退出码，所以未知档必须非 0（3 = 没核对成）。
      要一个"就按估算看数"的明确意图时，请先在库里补录快照（paid/watcher/sync 会自动补）。
    */
    if (local.summary.unknownCommission > 0 || local.summary.unknownSnapshot > 0) process.exitCode = 3;
    return;
  }

  const onchain = await loadOnchain();
  if (onchain.hostUnknownCount > 0) {
    console.log(
      `[reconcile] ⚠ ${onchain.hostUnknownCount} 个区间内 OrderCreated 的 host 字段为零/缺失：` +
        '无法判断属于哪个节点，不计入本节点汇总；这些单若在本地存在，会进入“没核对成”（exit 3）。'
    );
  }
  if (onchain.hostUnreadableSettled.size > 0) {
    console.log(
      `[reconcile] ⚠ ${onchain.hostUnreadableSettled.size} 个结算事件的订单 host 为零/缺失——` +
        '不能算作本节点已核对，退出码 3。'
    );
  }
  if (onchain.orphanHosted > 0) {
    console.log(
      `[reconcile] ⚠ ${onchain.orphanHosted} 个本节点订单的 OrderCreated 在扫描区间外：` +
        '只能确认 host、无法从事件拿金额，不加入链上汇总（exit 3）；用 --start-block/MK_ESCROW_START_BLOCK 覆盖全史。'
    );
  }
  if (onchain.orphanHostUnreadable > 0) {
    console.log(
      `[reconcile] ⚠ ${onchain.orphanHostUnreadable} 个结算事件既无 OrderCreated、也读不到 host（exit 3）。`
    );
  }
  if (onchain.skippedForeign > 0) {
    console.log(`[reconcile] ℹ ${onchain.skippedForeign} 个结算事件属于同合约的其它节点，已按 host 排除。`);
  }
  /*
    A：本地入账订单在链上没有“本节点已结算”事实。必须把五种情况分开，不能都用 missing：
      · missing          —— 链上非终局/查无此单 ⇒ 真差异（漏扫/数据异常），exit 2；
      · foreignHost      —— 链上这单的 host 是**别的节点**，本地却把它记成本节点订单
                            （全状态审计；入账态尤其严重）⇒ exit 2；
      · sellerMismatch   —— 链上 seller 与本地订单 seller 不一致 ⇒ 数据错位，exit 2；
      · outOfWindow      —— 链上已 Settled、只是 OrderCreated 在扫描区间外 ⇒ 覆盖不足，exit 0 提示；
      · unverifiedLocal  —— getOrder 读不到 / 抽成收款人读不到 ⇒ 没核对成，exit 3。
    此外 chain status=Refunded（全额退款）而本地记收入，是**状态不同步**，不是 outOfWindow。
  */
  const missing = [];
  const foreignHost = [];
  const sellerMismatch = [];
  const refundedButLocalIncome = [];
  const outOfWindow = [];
  const unverifiedLocal = [];
  const shopBySeller = new Map([...local.byShop.values()].map((s) => [s.seller, s.code]));
  /*
    只有 OrderCreated 在扫描区间外、本地却有该单时，才需要回读 mapping 取 host。
    区间内的事件已经携带 host，不再为本地每一单发 RPC。
  */
  const termsCache = new Map();
  const readTerms = async (id) => {
    if (!termsCache.has(id)) termsCache.set(id, await readCommissionTerms(id));
    return termsCache.get(id);
  };
  for (const [id, row] of local.byOrderId) {
    /*
      先按 OrderCreated.host 做**全状态**归属审计：不再只查入账态。
      非入账的 draft/cancelled/disputed 行如果链上 host 是别的节点，也是本地数据错位；
      事件已带 host，这里零额外 RPC。
    */
    const created = onchain.created.get(id);
    if (created?.hostKnown && created.host !== OWNER) {
      foreignHost.push({
        id: id.slice(0, 18) + '…',
        shop: row.shopCode,
        status: row.status,
        chainHost: created.host,
        nodeOwner: OWNER,
      });
      continue;
    }
    if (!INCOME_STATUS.includes(row.status)) continue;
    /*
      先比较链上 OrderCreated 的 seller（事件已带，零额外 RPC）。不能因为
      “这单已经在 settledIds 里”就先 continue：那会让本地 seller/shop 归属错误的
      已结算单正好绕过 sellerMismatch，节点总额仍可能相等而分店小计是错的。
      区间外没有事件的单，下面再用 getOrder 的 seller 补一次。
    */
    const eventSeller = onchain.created.get(id)?.seller || '';
    if (eventSeller && eventSeller !== row.seller) {
      sellerMismatch.push({
        id: id.slice(0, 18) + '…',
        localSeller: row.seller,
        chainSeller: eventSeller,
        shop: row.shopCode,
      });
      continue;
    }
    if (onchain.settledIds.has(id)) continue;
    const facts = await readOnchainOrderFacts(id);
    if (!facts) {
      unverifiedLocal.push({ id: id.slice(0, 18) + '…', reason: 'getOrder 读不到' });
      continue;
    }
    const terminal = facts.status === 3 || facts.status === 4;
    const sellerOk = facts.seller === row.seller;
    if (!terminal) {
      missing.push({ id: id.slice(0, 18) + '…', amount: row.amount.toString(), status: row.status, chainStatus: facts.status });
      continue;
    }
    if (!sellerOk) {
      sellerMismatch.push({
        id: id.slice(0, 18) + '…',
        localSeller: row.seller,
        chainSeller: facts.seller,
        shop: row.shopCode,
      });
      continue;
    }
    if (facts.status === 4) {
      refundedButLocalIncome.push({ id: id.slice(0, 18) + '…', shop: row.shopCode, status: row.status });
      continue;
    }
    const eventHost = onchain.created.get(id)?.host || '';
    const eventHostKnown = !!eventHost && !isZeroAddr(eventHost);
    const terms = eventHostKnown ? { payee: eventHost } : await readTerms(id);
    if (!terms?.payee) {
      unverifiedLocal.push({ id: id.slice(0, 18) + '…', reason: 'OrderCreated 区间外且 commissionTermsAtCreate.payee 读不到/为零' });
      continue;
    }
    if (terms.payee !== OWNER) {
      foreignHost.push({
        id: id.slice(0, 18) + '…',
        shop: row.shopCode,
        status: row.status,
        chainHost: terms.payee,
        nodeOwner: OWNER,
      });
      continue;
    }
    if (onchain.created.has(id)) {
      // 链上 status=Settled，但本次事件扫描没看到对应结算事件：不是“区间外覆盖不足”，
      // 而是事件漏扫/未识别，不能把它归到 outOfWindow 混过去。
      unverifiedLocal.push({ id: id.slice(0, 18) + '…', reason: '链上已 Settled，但扫描区间内无匹配结算事件' });
      continue;
    }
    outOfWindow.push({ id: id.slice(0, 18) + '…', amount: row.amount.toString(), status: row.status });
  }
  // B：链上本节点托管但本地没有/状态未跟上（watcher 漏扫/库缺行）
  const extra = [];
  const openOnly = [];
  const refundedOnly = [];
  const stale = [];
  const localDraftOnchain = [];
  for (const [id, c] of onchain.created) {
    if (!c.hostKnown || c.host !== OWNER) continue;
    const row = local.byOrderId.get(id);
    const seller = c.seller || '';
    const shop = row?.shopCode || shopBySeller.get(seller) || '';
    const amount = c.amount?.toString() || '?';
    if (!row) {
      const item = { id: id.slice(0, 18) + '…', amount, seller, shop, settled: onchain.settledIds.has(id) };
      if (item.settled) extra.push(item);
      else if (onchain.latest - Number(c.block) > FINALITY_BLOCKS) {
        if (onchain.refundedIds.has(id)) refundedOnly.push(item);
        else openOnly.push(item);
      }
      // 未越过确认深度的新单不报：watcher 本来就要等 finality，否则每次下单后跑一次对账都会红。
    } else if (row.status === 'draft' || row.status === 'cancelled') {
      // 本地还是草稿/已取消，链上却已有托管：买家已经付了钱，本地状态落后于链（不是“还没付”）。
      // 新单在确认深度内是正常竞态，不报。
      if (onchain.latest - Number(c.block) > FINALITY_BLOCKS) {
        localDraftOnchain.push({ id: id.slice(0, 18) + '…', amount, seller, shop, localStatus: row.status });
      }
    } else if (!INCOME_STATUS.includes(row.status)) {
      // 只有链上已结算才叫“状态没跟上”；链上还在途的本地非入账态是正常的。
      if (onchain.settledIds.has(id)) {
        stale.push({ id: id.slice(0, 18) + '…', amount, seller, shop, localStatus: row.status });
      }
    }
  }
  /*
    C：链上实际到账汇总——**只读链上实数**（P1-1）：
      · `sellerNetAtSettle(orderId)` = 实际付给卖家的净额（已扣平台费与节点抽成）；
      · `commissionAtSettle(orderId)` = 实际付给节点主的抽成。
    脚本不再按 bps 复算这两条腿：旧实现的 chain 侧 net = amount − refunded − fee 漏掉了抽成，
    而本地侧同样漏掉 ⇒ commission_bps>0 的店「两侧同错、差额 0」，对账自证一致。
    平台费只作为**反推值**（毛额 − 已退买家 − 抽成 − 实收），且只在所有读数都拿到时才给。
  */
  let onchainNet = 0n;
  let onchainCommission = 0n;
  let onchainGross = 0n;
  let onchainRefunded = 0n;
  let netUnreadable = 0; // sellerNetAtSettle 读不到
  let commissionUnreadable = 0; // commissionAtSettle 读不到
  let factsUnreadable = 0; // getOrder 读不到（已退金额 / 元组读数）
  /*
    注：这里**不再**维护"OrderCreated 落在区间外"的计数器——`settledIds` 本身就是"命中
    `created`"的那批 id，所以这个循环里 `!c` 恒不成立，写在这里的计数器永远为 0（死代码）。
    真正的计数在 `loadOnchain` 里（`skippedNoCreated`，见上方告警）。
  */
  for (const id of onchain.settledIds) {
    const c = onchain.created.get(id);
    if (!c) continue;
    const [facts, net, commission] = await Promise.all([
      readOnchainOrderFacts(id),
      readUintView('sellerNetAtSettle', id),
      readUintView('commissionAtSettle', id),
    ]);
    if (facts === null) factsUnreadable += 1;
    if (net === null) netUnreadable += 1;
    if (commission === null) commissionUnreadable += 1;
    onchainGross += c.amount;
    if (facts !== null) onchainRefunded += facts.refundedAmount;
    if (net !== null) onchainNet += net;
    if (commission !== null) onchainCommission += commission;
  }
  const chainReadingsComplete = netUnreadable + commissionUnreadable + factsUnreadable === 0;
  const onchainFee = chainReadingsComplete
    ? onchainGross - onchainRefunded - onchainCommission - onchainNet
    : null;
  if (factsUnreadable > 0) {
    console.log(
      `[reconcile] ⚠ ${factsUnreadable} 单的 getOrder 元组读不到（已退买家/费率快照未知）——` +
        '链上平台费无法反推；这些单的链上净额/抽成仍按各自视图读取（读得到的已计入）'
    );
  }
  if (netUnreadable > 0) {
    console.log(
      `[reconcile] ⚠ ${netUnreadable} 单的 sellerNetAtSettle 读不到（旧合约/ABI 未同步/RPC）——` +
        '**这几单没有被核对过**（退出码 3）。脚本刻意不用本地快照或名义费率替代链上实数。'
    );
  }
  if (commissionUnreadable > 0) {
    console.log(
      `[reconcile] ⚠ ${commissionUnreadable} 单的 commissionAtSettle 读不到（旧合约/ABI 未同步/RPC）——` +
        '抽成腿**未知，不是 0**；这几单没有被核对过（退出码 3）。'
    );
  }
  if (onchain.skippedNoCreated > 0) {
    console.log(
      `[reconcile] ℹ ${onchain.skippedNoCreated} 个结算事件的 OrderCreated 不在扫描区间内` +
        `（其中其它节点 ${onchain.skippedForeign} 个；本节点 ${onchain.orphanHosted} 个、归属读不到 ${onchain.orphanHostUnreadable} 个）——` +
        '本节点/未知的已计入“没核对成”；用 --start-block 或 MK_ESCROW_START_BLOCK 覆盖全史重跑'
    );
  }

  console.log('[reconcile] 链上本节点结算事件：');
  console.log(`[reconcile]   确认=${onchain.byName.ReceiptConfirmed.size} 超时释放=${onchain.byName.OrderExpiredReleased.size} 仲裁判付=${onchain.byName.ArbitratedPaid.size}`);
  console.log(
    `[reconcile]   链上实际到账估算=${onchainNet.toString()} wei（sellerNetAtSettle 实测` +
      `${netUnreadable > 0 ? `；${netUnreadable} 单读不到` : ''}）`
  );
  console.log(
    `[reconcile]   链上节点抽成=${onchainCommission.toString()} wei（commissionAtSettle 实测` +
      `${commissionUnreadable > 0 ? `；${commissionUnreadable} 单读不到` : ''}）`
  );
  console.log(
    `[reconcile]   链上平台费=${onchainFee === null ? '—（读数不齐，无法反推）' : `${onchainFee} wei（= 毛额 − 已退买家 − 抽成 − 实收，由链上读数反推）`}`
  );
  /*
    差额只在**两侧都可核对**时给：链上有读数缺失、或本地抽成条款从未补录时，本地那个数
    是把未知折成 0 算出来的——拿它与链上实数比，得到的"0"是假的（正是 P1-1 要消灭的形状）。
  */
  const localVerifiable =
    local.summary.unknownCommission === 0 &&
    local.summary.unknownSnapshot === 0 &&
    unverifiedLocal.length === 0 &&
    onchain.hostUnknownCount === 0 &&
    onchain.hostUnreadableSettled.size === 0 &&
    onchain.orphanHosted === 0 &&
    onchain.orphanHostUnreadable === 0;
  const diff = chainReadingsComplete && localVerifiable ? onchainNet - local.summary.net : null;
  console.log(
    `[reconcile]   本地期望实收=${local.summary.net.toString()} wei → 差额=${
      diff === null ? '—（两侧读数不齐，本轮无法给差额）' : `${diff} wei`
    }`
  );
  if (missing.length) {
    console.log(`\n⚠ 本地已入账但链上未终局/查无此单（${missing.length} 单，疑似 watcher 漏扫或数据异常）：`);
    for (const m of missing) console.log(`   ${m.id} amount=${m.amount} localStatus=${m.status} chainStatus=${m.chainStatus}`);
  }
  if (foreignHost.length) {
    console.log(`\n⚠ 本地有订单、但链上这单的 host 是**别的节点**（${foreignHost.length} 单，归属错位）：`);
    for (const x of foreignHost) console.log(`   ${x.id} shop=${x.shop || '?'} status=${x.status || '?'} chainHost=${x.chainHost} nodeOwner=${x.nodeOwner}`);
  }
  if (sellerMismatch.length) {
    console.log(`\n⚠ 链上 seller 与本地订单 seller 不一致（${sellerMismatch.length} 单，数据错位）：`);
    for (const x of sellerMismatch) console.log(`   ${x.id} shop=${x.shop || '?'} local=${x.localSeller} chain=${x.chainSeller}`);
  }
  if (refundedButLocalIncome.length) {
    console.log(`\n⚠ 链上已全额退款、本地仍记收入（${refundedButLocalIncome.length} 单，状态不同步）：`);
    for (const x of refundedButLocalIncome) console.log(`   ${x.id} shop=${x.shop || '?'} localStatus=${x.status}`);
  }
  if (outOfWindow.length) {
    console.log(
      `\nℹ ${outOfWindow.length} 单在链上已 Settled、只是其 OrderCreated 落在本次扫描区间之外` +
        `（区间起点 ${onchain.from}）——**这是覆盖不足，不是账目差异**，不计入退出码。` +
        '\n  需要覆盖全史时用 --start-block <Escrow 部署块>（或 --blocks <更大回溯块数>）重跑。'
    );
    for (const m of outOfWindow.slice(0, 20)) console.log(`   ${m.id} amount=${m.amount} status=${m.status}`);
    if (outOfWindow.length > 20) console.log(`   …另有 ${outOfWindow.length - 20} 单（同上）`);
  }
  if (extra.length) {
    console.log(`\n⚠ 链上已结算但本地**完全没有该单**（${extra.length} 单，watcher 漏扫/库缺行）：`);
    for (const e of extra) console.log(`   ${e.id} amount=${e.amount} shop=${e.shop || '?'} seller=${e.seller || '?'}`);
  }
  if (openOnly.length) {
    console.log(`\n⚠ 链上本节点已有 OrderCreated、本地完全没有该单（${openOnly.length} 单，还在途/漏扫/库缺行）：`);
    for (const e of openOnly) console.log(`   ${e.id} amount=${e.amount} shop=${e.shop || '?'} seller=${e.seller || '?'}`);
  }
  if (refundedOnly.length) {
    console.log(`\n⚠ 链上本节点已全额退款、本地完全没有该单（${refundedOnly.length} 单；不是卖家收款，但仍是本地缺行）：`);
    for (const e of refundedOnly) console.log(`   ${e.id} amount=${e.amount} shop=${e.shop || '?'} seller=${e.seller || '?'}`);
  }
  if (stale.length) {
    console.log(`\n⚠ 链上已结算且本地有该单、但本地状态不是入账态（${stale.length} 单，状态不同步）：`);
    for (const e of stale) {
      console.log(`   ${e.id} amount=${e.amount} shop=${e.shop || '?'} localStatus=${e.localStatus} seller=${e.seller || '?'}`);
    }
  }
  if (localDraftOnchain.length) {
    console.log(`\n⚠ 本节点链上已有托管、本地仍是草稿/已取消（${localDraftOnchain.length} 单，本地状态落后）：`);
    for (const e of localDraftOnchain) {
      console.log(`   ${e.id} amount=${e.amount} shop=${e.shop || '?'} localStatus=${e.localStatus} seller=${e.seller || '?'}`);
    }
  }
  if (unverifiedLocal.length) {
    console.log(`\n⚠ 本地入账单的链上归属/元组读不到（${unverifiedLocal.length} 单，没核对成）：`);
    for (const e of unverifiedLocal.slice(0, 20)) console.log(`   ${e.id} ${e.reason}`);
  }
  if (diff !== null && diff !== 0n) {
    console.log(
      `\n⚠ 两侧数额差额 ${diff.toString()} wei（行配对得上但数额不符）：常见原因是本地 fee_bps/commission_bps/refunded_amount_wei` +
        '快照写错、平台费判据漂移，或链上订单的 OrderCreated 落在扫描区间外（见上方提示）'
    );
  }
  /*
    退出码：
      · 2 = 差异（missing / extra / diff ≠ 0）；
      · 3 = **没核对成**——链上 sellerNetAtSettle / commissionAtSettle / getOrder 有读不到的单，
        或本地抽成条款从未补录（commission_to IS NULL）。它不是差异，但也绝不是"一致"：
        旧实现把这几档静默折成 0（本地少减一条抽成腿、链上读数缺失退回本地），
        于是 commission_bps>0 的店会输出 diff=0 / exit 0，而卖家实际收到得更少。
    注意：链上读数不齐时**不给差额**（上面打印 `—`），因为那个数会误导；退出码仍然非 0。
  */
  /*
    未核对项 = 链上读数缺失 + **本地快照缺失（平台费/抽成任一腿）**。
    本地快照缺失时那一腿是按全局兜底/0 估算的——估算值哪怕恰好等于链上实数，
    也不构成"核对过"（下一次全局配置变化就会反转），所以必须与链上读不到同列。
  */
  const unverified =
    netUnreadable + commissionUnreadable + factsUnreadable + local.summary.unknownSnapshot + local.summary.unknownCommission +
    unverifiedLocal.length + onchain.hostUnknownCount + onchain.orphanHosted + onchain.orphanHostUnreadable +
    onchain.hostUnreadableSettled.size;
  const hasDifference =
    missing.length + foreignHost.length + sellerMismatch.length + refundedButLocalIncome.length + extra.length +
      openOnly.length + refundedOnly.length + stale.length + localDraftOnchain.length > 0 ||
    (diff !== null && diff !== 0n);
  if (!hasDifference && unverified === 0) {
    console.log(
      '\n✅ 本节点全部店铺的本地入账与链上结算事件一致（区间内）' +
        (outOfWindow.length ? `；区间外另有 ${outOfWindow.length} 单已核实为链上终局（覆盖不足，非差异）` : '')
    );
  }
  if (unverified > 0) {
    console.log(
      `\n⚠ 本轮有 ${unverified} 项读数缺失（链上归属/净额/抽成/getOrder，或本地平台费/抽成快照未补录）：` +
        '**这些单没有被核对过**（退出码 3；差额已置为不可计算，不会给出 ✅）。请补录/重跑；持续出现要查 RPC 与 ABI 是否同步。'
    );
  }
  process.exitCode = hasDifference ? 2 : unverified > 0 ? 3 : 0;
}

main().catch((e) => {
  console.error('[reconcile] 链上比对失败：', e.message || e);
  console.error('[reconcile] 提示：可用 --db-only 仅核对本地侧统计');
  process.exitCode = 1;
});