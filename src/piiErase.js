/**
 * 个人信息擦除与保留期（PIPL 式删除请求的落地实现，2026-09；2026-10-16 随重设计改形状）。
 *
 * 为什么需要它：买家的收货人/电话/地址/备注、开票抬头与税号、以及售后陈述正文与证据附件
 * 一旦落库就永久留在磁盘上——此前**没有任何产品能力**能删掉它们，店主收到买家的删除请求
 * 只能手工改库（或者干脆做不到）。本模块提供两条通道，**共用同一个擦除内核**
 * （eraseOrderPii，只有一份实现，防两条路径的擦除范围漂移）：
 *  1. 显式删除请求：POST /api/shop/orders/:orderNo/erase-pii（ownerOnly，见 routes/pii.js）；
 *  2. 保留期到期自动擦除：runPiiRetention（POST /api/shop/retention/run 手动触发 +
 *     server.js 启动的周期扫描），阈值 = MK_PII_RETENTION_DAYS（默认 180 天，0 = 关闭）。
 *
 * ## 承诺的形状变了：**"那一行还在不在"，不是"六个列有没有改对"**
 *
 * 重设计把个人信息整体搬进 `order_shipping`（1:1，随订单级联删除），于是擦除就是
 * `DELETE FROM order_shipping WHERE order_id = ?`。这不是换了个写法，而是**换了一个可证明的命题**：
 *   · 旧形状：擦除 = 把六列各改成一个空串/墓碑，而"擦干净了"要靠"每一列的改名/新增都记得
 *     加进这条 UPDATE"来维持——漏一次就是**静默留下的个人数据**（列还在，值还在，
 *     而接口回"已擦除"）；
 *   · 新形状：擦除 = 删掉那一行。`changes === 1` 是"确实删掉了一行"，
 *     重复调用时"查不到那一行"就是"已经擦过了"——两者都由**行在不在**回答，拼不出第三种可能。
 * 代价如实写：擦除之后本地再也拿不到那单的收货信息（包括"曾经填过什么"的痕迹）——
 * 这正是删除请求要的，但意味着**擦除不可逆**，任何"先擦后发货"的操作都会卡住（见下"终局才可擦"）。
 *
 * 擦除范围：
 *  - `order_shipping` **整行删除**（收货三列 + 备注 + 开票抬头/税号 + 编辑计数）；
 *    这一行里的东西**全部**是"删掉就应该没有"的个人信息。
 *    判据只有一个：**擦除之后还应不应该读得到** —— 所以"这单要不要开票"（`invoice_needed`）住
 *    `orders`（订单事实），抬头与税号住这一行（个人信息）。它曾经被放进这一行，
 *    后果是擦除后导出把这单读成"没要求开票"——与事实相反；已挪走，别搬回来。
 *  - 每条售后/争议陈述的正文 → 墓碑串（**不删行**：时间线/角色/阶段是资金争议的事实记录，
 *    "谁在什么时候提交过陈述"必须留着，只有正文属于个人信息）；
 *  - 证据附件 → DB 行 + 磁盘文件一并删除（文件才是真正的个人数据，行只是索引；
 *    删行不删文件等于"数据还在磁盘上"，是最常见的假删除）；
 *  - 附件配额计数器（每条陈述的 `dispute_evidence.file_count/file_bytes` 与订单级的
 *    `orders.evidence_bytes`）**同事务清零**：行没了而计数还留着，
 *    就是一份描述不存在文件的账（见 evidenceFiles.js 的"计数器是与行同生共死的状态"）。
 * 金额、状态、链上托管单号、支付交易哈希、链上事件史、净额、物流单号、退货单地址与备注、
 * 已交付的兑换码与 NFT tokenId、不带 PII 的评价正文、**售后结案说明（`after_sale_note`：链上
 * `AfterSaleClosed` 事件的公开文本，删掉本地副本只会与链上不一致，且它本来就是公开的）**一律不动：
 * 它们是账目、履约与链上凭证，删掉就等于篡改账本（也删不掉链上那份公开历史）。
 * ⚠️ 这份"刻意保留"清单是**对用户的承诺**——改它要同批改 `docs/OPERATOR_COMPLIANCE.md` §5.4
 * （对外的承诺文本）、`docs/DEPLOY_NODE.md` 与 `node/docs/OPERATIONS.md`（少一项不会报错，
 * 但当事人会按错误的预期行事；`node/test/pii-scope-consistency.test.js` 就是这条守卫）。
 *
 * 终局才可擦（PII_ERASABLE_STATUS）：draft/escrowed/shipped/disputed 的在途单必须保留收货
 * 信息，否则卖家无法发货、退款也无法联系买家。该约束写在核心里，两条通道同样受它约束，
 * 并且**写进了擦除语句自己的状态谓词**——eligibility 的那次 JS 读只是给人看的预检，
 * "真的可擦"由 `changes === 1` 回答（见 eraseOrderPii 内的说明）。
 *
 * ⚠ 擦除只保证**本节点这一段**：库内那一行 + 附件文件。库服务器侧的二进制日志历史、InnoDB 的
 * undo 与表空间空闲页、以及任何备份/只读副本都在节点控制之外，接口用 `residual` 如实作答
 * （见 residualReport 的说明）。旧实现在这里承诺"磁盘上不再有原文"——那是 SQLite 的
 * `secure_delete` + WAL 截断撑起来的，MySQL 下**兑现不了**，留着就是给用户看的一句假话。
 *
 * ⚠ 擦除只写 `pii_erased_at`（擦除锚点），**绝不写 `updated_at`**：
 * `updated_at` 是入账/争议起始时刻的口径（流水页的 `INCOME_STATUS` 窗口、看板 GMV 与趋势日桶、
 * ledger.csv 的 income_at 全按它分窗），被擦除动作改写会让一笔旧成交额重新落进近期报表窗口。
 *
 * 幂等：重复调用不报错、不重复计数；磁盘清理无条件执行，所以"上一次删文件失败"能被
 * 下一次调用补齐（孤儿文件不因 DB 行已消失而永久留在磁盘上）。
 */
import fs from 'node:fs';
import config, { PII_RETENTION_DAYS } from './config.js';
import { getDb, withTransaction, abortTx, serverCapabilities } from './db.js';
import { logAudit } from './audit.js';
import { orderAttachDir, removeOrderAttachments } from './evidenceFiles.js';
import { clearReviewImages } from './reviews.js';
import { removeMediaByUrl } from './productMedia.js';
// 节点主地址（`node.owner`）：保留期扫描的审计主体
import { nodeOwner } from './shops.js';
// 状态集合的唯一出处（见下方再导出说明）：本文件内部要用，所以先 import 再 export
import { PII_ERASABLE_STATUS, PII_PROTECTED_STATUS } from './orderStatus.js';
// 确认收货后的售后案件：在途判据的唯一实现（保留期扫描据此让路，见 runPiiRetention）
import { AFTER_SALE_NOT_OPEN_SQL } from './afterSaleSql.js';

/** 陈述正文的墓碑（保留可读性：当事人看到的是"已删除"而不是空白/报错） */
export const PII_TOMBSTONE = '[已按数据删除请求擦除]';

/**
 * 可擦除状态 = 资金流已终结（confirmed/settled/refunded/expired 四个终局 + 从未支付的 cancelled）。
 * cancelled 一并纳入：它从未上链托管（取消条件就是 draft 或"escrowed 但无支付凭证"），静置
 * 超期即是弃单，留着买家填过的收货地址纯属风险；万一久远之后链上又冒出一笔该单号的真实托管
 * （watcher 会把 cancelled 恢复成 escrowed），买家仍可在发货前经 PATCH /:orderNo/shipping
 * 重新提交地址——恢复通道没有被这次擦除堵死。
 *
 * 集合本体在 `src/orderStatus.js`（订单状态集合的唯一出处）：本文件只再导出，
 * 保证"擦除面 / 保护面"与 schema 的 ENUM 取值、以及其它模块用的是**同一份**定义
 * （改一处漏一处在这类集合上全都不报错，见 orderStatus.js 的说明）。
 */
export { PII_ERASABLE_STATUS, PII_PROTECTED_STATUS };

/** 保留期扫描的单批候选数（一轮内多批推进：每批只把 RETENTION_BATCH 行读进内存，存量很大时不会一次性拉全量） */
const RETENTION_BATCH = 20;
/**
 * 单次运行最多处理的候选订单数（周期扫描与手动运行共用）：一轮就是一轮——它把"这一次点了多少活"
 * 钉成有界的（每单一次事务 + 一次目录删除），也让手动端点能回一个确定的 `truncated: true`
 * 告诉运维"还有剩，再点一次"。200 单/次足够日常（周期扫描每 6 小时一轮）。
 */
const RETENTION_MAX_PER_RUN = 200;
/** 正在跑的那一轮保留期扫描（`runPiiRetention` 的单飞闸就靠它；见那里的说明） */
let inflightRetention = null;
/** 周期扫描间隔（6 小时）：保留期以天计，多轮只为"启动即收敛"与新终局单尽早清理 */
const SWEEP_INTERVAL_MS = 6 * 3600_000;

/**
 * 可擦状态集合的 SQL 占位符（**唯一拼法**）：eligibility 预检、擦除语句、保留期候选三处
 * 共用同一个常量，所以"某处少列一个状态"这种静默漂移不可能发生。
 */
const ERASABLE_MARKS = PII_ERASABLE_STATUS.map(() => '?').join(',');

/**
 * 「资金流未终结」的拒绝结果（**唯一拼法**）：预检与事务内的状态谓词共用同一句话。
 * 两处都要它，是因为"读到可擦"与"真的可擦"是两个时刻（见 eraseOrderPii），
 * 各写一份文案就会随状态集合漂移。
 */
function notTerminal(status) {
  return {
    code: 'not_terminal',
    error: 'not_terminal',
    message:
      `当前状态(${status})不可擦除个人信息：资金流未终结——在途单必须保留收货信息，` +
      '卖家才能按地址发货（draft/escrowed/shipped/disputed 一律拒绝）。请等订单终局' +
      '（confirmed/settled/refunded/expired/cancelled）后再执行删除请求',
  };
}

/** 「订单不存在」（读不到那一行；**不猜**、不建行） */
function notFound() {
  return { code: 'not_found', error: 'not_found', message: '订单不存在' };
}

/** 提货声明仍在履约中：claim 那份收货信息与 order_shipping 同级，不能只擦订单那一份。 */
function claimOpen() {
  return {
    code: 'claim_open',
    error: 'claim_open',
    message: '该订单还有在途的 NFT 提货声明：claim 里的收货信息正在用于履约，需先完成/驳回/取消声明后再擦除',
  };
}

/**
 * 售后案件在途：双方陈述与附件是仲裁人裁决的唯一证据；店主（本路由的 ownerOnly 主体）
 * 正是可能被罚的一方，不能让他用删除请求把证据先擦掉。结案后再走正常擦除。
 */
function afterSaleCaseOpen() {
  return {
    code: 'case_open',
    error: 'case_open',
    message:
      '该订单有在途售后案件：双方陈述与附件是委员会裁决证据，案件结案前不能擦除；' +
      '结案后再提交删除请求（收货信息也会保留到案件结束，退货/换货仍需要它）',
  };
}

/**
 * 「擦除之后，原文还有没有可能从别处被读出来」——如实作答（出参 `residual` 的**唯一产出方**）。
 *
 * 为什么必须由节点回答、而不是界面按状态猜：旧接口回一个 `walTruncated`，界面据此说"已删干净"。
 * MySQL 下既没有 WAL 可截断，也没有 `secure_delete` 那种"写时清零"的开关——那条腿**不存在**，
 * 而库服务器里确实还留着节点删不掉的两类副本：
 *   · **二进制日志**：下单时的 INSERT 记的是整行（`binlog_row_image=MINIMAL` 只约束节点自己的
 *     连接，且只保证**本次擦除语句**不写 before-image），那些历史帧要到轮转/过期才消失；
 *   · **InnoDB undo 与表空间空闲页**：DELETE 只是把行标成删除并写新页，旧字节留在 undo/空闲区里，
 *     要等所在页被复用时才消失。
 * 再加一类节点根本看不见的：备份与只读副本。
 *
 * 三态：`serverCapabilities()` 未就绪或探测失败时各读数一律为 null——**读不到就说读不到**，
 * 不得折成"没问题"（本仓对"读不到"的一贯口径；前端 `piiEraseOutcomeText` 按三态分叉）。
 *
 * 代价（如实写）：节点**不再承诺**"磁盘上不再有原文"，因为 InnoDB 下它兑现不了；能承诺的只有
 * "库内那一行与附件文件已擦"。否掉的替代方案是保留旧口径——那对店主/运维是一句假话，
 * 而当事人会据此把仍含个人数据的备份归档走。
 */
function residualReport() {
  const caps = serverCapabilities();
  const logBin = caps?.logBin ?? null; // true 开着 / false 没开 / null 读不到
  const rowImage = caps?.binlogRowImage ?? null; // 'MINIMAL' / 'FULL' / 'NOBLOB' / null
  const binlogExpireSeconds = caps?.binlogExpireSeconds ?? null;
  /*
    本次擦除语句自己会不会把原文写进日志的 before-image：只由 binlog_row_image 决定
    （MINIMAL = 不写 before-image，after-image 只含被改动的列，而 DELETE 记的是主键）。
    日志**关着**时什么都写不进去 ⇒ false，与 row_image 的读数无关。
  */
  let eraseWrotePlaintext;
  if (logBin === false) eraseWrotePlaintext = false;
  else if (rowImage === null) eraseWrotePlaintext = null;
  else eraseWrotePlaintext = rowImage !== 'MINIMAL';
  const expiry =
    binlogExpireSeconds === null
      ? '日志保留期读不到'
      : binlogExpireSeconds > 0
        ? `日志保留期 ${binlogExpireSeconds} 秒，到点自动轮转清理`
        : '日志保留期 0 = 不自动清理（要消除只能由运维执行 PURGE BINARY LOGS）';
  let binlog;
  if (logBin === false) {
    binlog = '库服务器没开二进制日志（log_bin=OFF），日志这条腿不存在';
  } else if (logBin === null) {
    binlog =
      `没读到 log_bin：无法确认库服务器是否开着二进制日志，也就无法确认日志里有没有原文（别把它当成"没有"）；若开着，${expiry}，在那之前原文仍可从日志里读出`;
  } else if (eraseWrotePlaintext === true) {
    binlog =
      `二进制日志开着，且本会话 binlog_row_image=${rowImage}：**本次擦除的语句自己**就把旧值写进了 before-image（下单时的 INSERT 还记过一整行），${expiry}——在轮转/清理之前原文仍可从日志里读出`;
  } else if (eraseWrotePlaintext === false) {
    binlog =
      `二进制日志开着：本次擦除的语句已按 MINIMAL 只记主键（改动的列在 after-image 里），但下单时的 INSERT 记过整行，那些历史帧仍在日志里（${expiry}）——在轮转/清理之前原文仍可从日志里读出`;
  } else {
    binlog =
      `二进制日志开着，但没读到 binlog_row_image：无法确认本次擦除的语句有没有把旧值写进 before-image；下单时的 INSERT 那一份一定还在日志里（${expiry}）`;
  }
  return {
    /** 二进制日志里**可能**仍有原文（true/false 为实测；null = 读不到 ⇒ 不敢说没有） */
    dbLogsPossible: logBin,
    /** 上述日志的保留期（秒）；null = 读不到（运维据此判断多久后自然消失） */
    binlogExpireSeconds,
    /** 本次擦除语句自己会不会把原文写进日志的 before-image（null = 读不到） */
    eraseWrotePlaintext,
    /** 一句可直接展示给店主/运维的话（残留在哪、由谁处置）；不含任何"已彻底消失"的承诺 */
    note:
      `${binlog}。另有节点**完全无法触及**的两类副本：InnoDB 的 undo/表空间空闲页` +
      '（旧字节要等所在页被复用时才消失），以及库与磁盘的任何历史备份/只读副本' +
      '（处置在运维侧：按备份保留策略过期，必要时对磁盘与备份加密）——这两类节点删不掉，也不谎称已删。',
  };
}

/**
 * 磁盘附件清理（事务外，见 eraseOrderPii 说明）。
 *
 * @param {number} orderId **内部订单键**（`orders.id`）：附件目录与 `evidence_files.order_id` 同键
 * @returns {{removed:number, remaining:number}} `removed` = 删除**前**目录内的文件数（= 本次擦掉了
 *   几个，用于响应/审计的计数）；`remaining` = 删除**之后**目录里还剩几个文件，
 *   **0 表示确实干净**，非 0 表示没删净（权限/占用/只读挂载）。
 *
 * 为什么返回"残留数"而不是 `ok:false` 加一个原因字段：调用方要判的是
 * "盘上还有没有个人数据"，那就该由**实测的残留数**回答。返回一个布尔时，消费方只要把字段名
 * 猜错就会把失败读成成功，而且**没有任何测试会红**——`undefined > 0` 不抛错。
 * 残留数是**事实**，不是对事实的描述，猜不歪。
 *
 * ⚠️ `remaining` 用 `-1` 作"列不出来"的哨兵（目录不可读时 `existsSync`/`readdirSync` 会抛）：
 * 那种情况**绝不能**算 0（"读不到"不等于"没有"——与全仓三态纪律一致），调用方按"没删净"处理。
 */
function removeAttachmentsFromDisk(orderId) {
  const dir = orderAttachDir(orderId);
  const countFiles = () => {
    try {
      return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    } catch {
      return -1; // 列不出来 ⇒ 不知道 ⇒ 按没删净处理（不得当成 0）
    }
  };
  const before = countFiles();
  try {
    removeOrderAttachments(orderId);
  } catch (e) {
    // 删文件失败必须留痕：DB 行已删，磁盘上却仍有个人数据（权限/占用/只读挂载）——
    // 这是"以为删干净了其实没删"的典型场景，需运维人工清理；下一轮保留期扫描会再试。
    console.error(`[pii] 订单 ${String(orderId)} 的证据附件删除失败（磁盘上仍有数据，将重试）:`, e?.message || e);
  }
  return { removed: Math.max(0, before), remaining: countFiles() };
}

/**
 * 擦除单个订单的个人信息（**唯一实现**；调用方只负责鉴权与审计）。
 * @param {string} orderNo **对外订单号**（`orders.order_no`，URL 里用的那一个）。
 *   刻意不收内部自增键：擦除是对**用户认得的那个单号**做出的承诺，而内部键不出本节点。
 * @returns {{ok:boolean, error?:string, orderNo:string, status:string, changed:boolean,
 *            attachmentFilesRemoved:boolean|null, attachmentFilesRemaining:number,
 *            cleanupPending:boolean, residual:object, counts:object}
 *          | {code:'not_found'|'not_terminal'|'claim_open', error:string, message:string}}
 *  counts = { shippingRows, claimPii, evidenceContents, attachmentRows, attachmentFiles }（只有计数，
 *  不含任何被擦除的内容——审计与响应都不应把 PII 再抄一份出来）。
 *  residual = 「库服务器侧还剩什么」的如实读数（见 residualReport）。
 */
export async function eraseOrderPii(orderNo) {
  const db = getDb();
  const no = String(orderNo || '');
  const order = await db.get('SELECT id AS order_id, status FROM orders WHERE order_no = ?', no);
  /*
    ── 两个必填字段的**分工** ────────────────────────────────────────────
    `code` 明说这是哪一类结果，调用方按它分支；`error` 是一句给人看的原因。
    为什么必须有 `code`：此前调用方用"有没有 `error` 字段"来判"这是拒绝"，
    而**删盘失败**的结果也带 `error`（它确实是"有东西没做成"），于是被同一个守卫拦下——
    那条分支返回的响应**不带读数**，界面恰好在这一刻读不到"盘上还剩几个文件"。
    也就是说：靠"字段在不在"猜语义，等于让两个不同的结论共用一个形状。
    现在三种结果的 `code` 各自不同：'not_found' / 'not_terminal' = **什么也没擦**（拒绝）；
    成功时 `ok:true` 且 `code` 为 undefined（半成品失败由 `ok:false` + 读数表达）。
  */
  if (!order) return notFound();
  const orderId = Number(order.order_id);
  // 预检（给人看的原因）。它**不是**判据：判据在擦除语句自己的状态谓词上（见下）。
  if (!PII_ERASABLE_STATUS.includes(String(order.status))) return notTerminal(String(order.status));
  const counts = { shippingRows: 0, claimPii: 0, evidenceContents: 0, attachmentRows: 0, attachmentFiles: 0, reviewImages: 0 };
  let reviewImageUrls = [];
  /*
    ── 擦除语句自带状态谓词（修一条**真实的数据破坏路径**）──────────────────────────
    上面那次 JS 读与下面的事务之间隔着一段时间，而状态可以被并发推进：`cancelled` 的单
    会因链上冒出的真实托管被 escrowWatcher 恢复成 `escrowed`（买家重新提交收货信息、等卖家发货）。
    只按 id 删除 ⇒ 这一单的收货信息会在**已付款的在途单**上被销毁，卖家拿不到地址、
    发不了货，而响应还说"个人信息已擦除"。所以可擦状态集合同时是删除语句的谓词，
    `changes === 1` 才算真的删到；没删到就整体回滚（abortTx）并按**当时的真实状态**回一句可读原因
    ——只有真的删到了才计数、才删附件索引、才写擦除锚点（否则会报一次没发生的擦除）。
    预检保留的理由见上：它给人看的原因需要那次读。
  */
  const refusal = await withTransaction(async () => {
    /*
      提货声明（nft_claims）的收货人/电话/地址/备注是同一份个人信息，但住在另一张表。
      这里先把该单的 claim 行锁住再判断：否则擦除事务删完 order_shipping 后，
      并发的 claim approve/ship 可能把一份仍在履约的地址变成“已擦除”的假象。
      只有终局 claim 才清 PII；在途 claim 拒绝整单擦除（与订单在途同一方向）。
    */
    const claims = await db.all('SELECT id, status FROM nft_claims WHERE order_id = ? FOR UPDATE', orderId);
    if (claims.some((c) => ['requested', 'approved', 'shipped'].includes(String(c.status)))) {
      return abortTx(claimOpen());
    }
    /*
      在途售后案件：陈述/附件是委员会裁决证据，而本入口的主体正是店主（可能被罚的一方）。
      这条判断此前只在保留期扫描的候选 SQL 里——手动 erase-pii 绕过它，店主可以在买家
      开案后把双方证据一起墓碑化。判据必须在本内核里，任何调用方都绕不过。
      `FOR UPDATE` 与 watcher 的 applyAfterSaleOpened 争同一行：开案先提交则这里看见
      open；擦除先提交则案件是在“无陈述”之后才开，不会销毁既有证据。
    */
    const chain = await db.get('SELECT after_sale_status FROM order_chain WHERE order_id = ? FOR UPDATE', orderId);
    if (String(chain?.after_sale_status || 'none') === 'open') {
      return abortTx(afterSaleCaseOpen());
    }
    const ship = await db.get('SELECT 1 AS hit FROM order_shipping WHERE order_id = ?', orderId);
    if (ship) {
      /*
        删的是**那一行**（不是六列的空串）：一句话同时表达"哪些行可擦"（orders.status 的谓词）
        与"擦到什么程度"（行没了）。多表 DELETE 的 `changes` 是**删除的行数**，
        所以 1 = 确实删掉了一行收货信息，0 = 状态谓词没命中（或已被别处删掉）。
      */
      const del = await db.run(
        `DELETE s FROM order_shipping s JOIN orders o ON o.id = s.order_id
          WHERE s.order_id = ? AND o.status IN (${ERASABLE_MARKS})`,
        orderId, ...PII_ERASABLE_STATUS
      );
      if (del.changes !== 1) {
        const fresh = await db.get('SELECT status FROM orders WHERE id = ?', orderId);
        return abortTx(fresh ? notTerminal(String(fresh.status)) : notFound());
      }
      counts.shippingRows = 1;
    }
    /*
      擦除锚点 = `pii_erased_at`（**不是** `updated_at`，理由见文件头）。
      已擦净的行也再写一次锚点：重复调用是幂等的，而"最后一次擦除动作发生在什么时候"
      本来就该按事实更新（保留期去重与排序读的就是它）。
      没有收货信息行也要写锚点：事实是"这一单此刻确实没有个人数据了"（可能因为从未填写，
      也可能因为上一次已经擦过），而**"擦过"必须留下痕迹**——否则保留期扫描会反复选中它，
      每一轮都白跑一次事务。
    */
    await db.run('UPDATE orders SET pii_erased_at = ? WHERE id = ?', new Date(), orderId);
    // 已终结的提货声明：清掉收货人与备注；claim_no/金额/链上争议结论保留为账目事实。
    counts.claimPii = (await db.run(
      `UPDATE nft_claims
          SET shipping_name = '', shipping_phone = '', shipping_address = '', note = '', reject_reason = ''
        WHERE order_id = ? AND status IN ('fulfilled','rejected','cancelled','expired')
          AND (shipping_name <> '' OR shipping_phone <> '' OR shipping_address <> '' OR note <> '' OR reject_reason <> '')`,
      orderId
    )).changes;
    // 陈述正文 → 墓碑：只改正文，行/角色/阶段/时刻保留（时间线仍是完整的事实记录）
    counts.evidenceContents = (await db.run('UPDATE dispute_evidence SET content = ? WHERE order_id = ? AND content != ?', PII_TOMBSTONE, orderId, PII_TOMBSTONE)).changes;
    // 附件索引行删除（文件随 order_id 级联语义一并删；显式按 order_id 删除不依赖级联开关）
    counts.attachmentRows = (await db.run('DELETE FROM evidence_files WHERE order_id = ?', orderId)).changes;
    /*
      配额计数器同事务清零：计数器是"描述现存附件"的状态（见 evidenceFiles.js），
      行删了而计数留着，就是一份指向不存在文件的账——它会让这一单此后再也收不了附件
      （配额看起来永远是满的），而"为什么满"在库里查不出任何原因。
      **三层一起清**：每条陈述的两个计数器，以及订单级的 `orders.evidence_bytes`
      （订单级那道闸读的就是它；漏掉它单子仍然收不了附件，且同样查不出原因）。
    */
    await db.run('UPDATE dispute_evidence SET file_count = 0, file_bytes = 0 WHERE order_id = ? AND (file_count != 0 OR file_bytes != 0)', orderId);
    await db.run('UPDATE orders SET evidence_bytes = 0 WHERE id = ? AND evidence_bytes != 0', orderId);
    /*
      评价图同样可能是个人信息（人像/住址/聊天截图）。正文按既有口径保留，
      图片 URL 从评价行移除并在提交后删盘；先落库再删文件，避免回滚后只剩悬空 URL。
    */
    const reviewImages = await clearReviewImages(orderId);
    reviewImageUrls = reviewImages.urls;
    counts.reviewImages = reviewImageUrls.length;
    return null; // 事务里该做的都做了：下面的磁盘删除必须在 COMMIT 之后
  });
  if (refusal) return refusal;
  /*
    磁盘文件在 COMMIT 之后删：文件系统操作不可回滚，不能与 SQL 事务混在一起。顺序取
    "先落库、后删文件"——若此处失败，DB 已无引用、磁盘残留由下次调用/运维清理兜底；
    反过来（先删文件后落库）一旦回滚，DB 里会留下指向不存在文件的悬空行。
  */
  const attachmentFiles = removeAttachmentsFromDisk(orderId);
  counts.attachmentFiles = attachmentFiles.removed;
  // 评价图在事务里已清 URL；文件删除放在提交后，删不掉的孤儿由媒体清扫兜底。
  counts.reviewImages = reviewImageUrls.filter((u) => removeMediaByUrl(u)).length;
  /*
    ── 附件删盘失败**不算擦干净**（2026-10-14 审计修订：旧判据是死代码）──────────────
    旧实现把判据写成 `!attachmentFiles.ok && attachmentFiles.failed > 0`，而
    `removeAttachmentsFromDisk` 从来**没有**返回过 `failed` 字段（它返回 `{files, ok}`）——
    `undefined > 0` 恒为 false ⇒ `diskFailed` 恒 false ⇒ 失败分支整段不可达：
    `ok:true` / `error:undefined` 恒成立，手动端点回"个人信息已擦除"，
    保留期扫描把它记成已擦除、写审计、`/healthz` 的 `piiRetention.lastError` 仍为 null。
    而磁盘上的证据附件（真正的个人数据）一个都没删掉。
    这正是"判据挂错层"的形状：**成功与否必须由事实产出方给出**，不能由消费方去猜字段名。
    所以 `removeAttachmentsFromDisk` 返回"**删完之后还剩几个文件**"（含"连目录都列不出来"
    时的哨兵值），这里的 `ok` 只由它派生——名字写错不可能再变成成功。
  */
  const diskFailed = attachmentFiles.remaining !== 0;
  /*
    ── "还没清完"是一条**可查的工作记录** ──────────────────────────────
    把删盘失败表达成"把锚点回退成 NULL"是错的：候选判据是**纯时间判据**，
    锚点回退并不会让这一单重新入选（它的 `updated_at` 就是订单终局那一下），
    于是这一单要等到保留期（默认 180 天）之后才可能被扫到，`MK_PII_RETENTION_DAYS=0` 时则永远不会。
    换句话说：**承诺的自动重试不存在**，买家的证据文件会一直躺在盘上，而所有界面都告诉店主"已擦除"。
    根因是判据挂错了层——"还欠一次清理"是**工作状态**，不是时间锚点能表达的东西。
    现在两者分开、各司其职：
      · `pii_erased_at` = "库内这批个人数据已擦"（时间锚点，供保留期去重与排序）；
      · `pii_cleanup_pending` = "这一单还有没清完的清理工作"——**只剩磁盘附件这一条腿**
        （库服务器侧的残留随 InnoDB 一起成为"删不掉"的那一类，见 residualReport：重试也没有意义）。
    保留期候选判据里加上 `OR pii_cleanup_pending = 1`，于是"下一轮扫描会重试"变成真的，
    而且是**有界的一次**（清干净即置 0，不再反复入选）。
  */
  const clean = !diskFailed;
  await db.run('UPDATE orders SET pii_cleanup_pending = ? WHERE id = ?', clean ? 0 : 1, orderId);
  return {
    ok: clean,
    error: clean
      ? undefined
      : `${
          attachmentFiles.remaining < 0
            ? '附件目录无法读取（权限/挂载异常），无法确认磁盘上的附件是否已删除'
            : `附件索引已清空，但磁盘上还剩 ${attachmentFiles.remaining} 个文件未删除（目录权限/文件被占用）`
        }——已记为待清理，下一轮保留期扫描会重试（也可再次调用本接口立即重试）`,
    // 对外回的是**订单号**（调用方手里那个），内部键只用于子表与磁盘目录
    orderNo: no,
    status: order.status,
    // 磁盘上的附件文件也算"本次真的擦掉了东西"：DB 行早前已删、只剩孤儿文件的情形同样是一次
    // 有意义的删除（否则响应会报"无变更"，让人以为没删干净/白跑一趟）
    changed:
      counts.shippingRows + counts.claimPii + counts.evidenceContents + counts.attachmentRows + counts.attachmentFiles + counts.reviewImages >
      0,
    // 三态（与响应里的其它读数同款）：true 确认删净 / false 确认没删净 / null 读不到 ⇒ 不敢说
    attachmentFilesRemoved: attachmentFiles.remaining < 0 ? null : attachmentFiles.remaining === 0,
    attachmentFilesRemaining: attachmentFiles.remaining,
    /** 这一单是否仍欠一次清理（true ⇒ 保留期扫描会再试；见上面的说明） */
    cleanupPending: !clean,
    /** 库服务器侧还剩什么（二进制日志/undo/空闲页/备份）——节点控制之外的那一段，如实作答 */
    residual: residualReport(),
    counts,
  };
}

/**
 * 保留期擦除（周期扫描与 POST /api/shop/retention/run 共用）：终局且静置超过 days 天的订单
 * 自动擦除个人信息——"存着不删"本身就是合规风险，到期即清无需人工记得。
 *
 * 候选锚点 = `GREATEST(COALESCE(pii_erased_at, updated_at), updated_at)`，按它升序（最旧的先擦）、
 * 单轮分批推进、最多 limit 单。
 * **为什么不是单用 updated_at**：扫描需要"擦过就不再重复入选"的锚点（否则已擦净的旧单每轮都
 * 占满批量上限，新到期的单永远轮不到），而 `updated_at` 是**入账时刻**的口径（流水/GMV 窗口/
 * 趋势日桶/ledger.csv 全按它分窗）——拿它当锚点就等于把一笔旧成交挪进更晚的报表窗口。
 * `pii_erased_at` 提供同一个性质且不碰账目列。
 *
 * **为什么是 GREATEST 而不是 COALESCE**（源码审计 2026-09 复审，P1）：`COALESCE(a, b)`
 * 在 a 非空时**完全忽略 b**，取到的是"两个时刻里更旧的那个"。而 `pii_erased_at` 一旦写入就再无
 * 任何代码重置（eraseOrderPii 是唯一写入点），恢复通道却是设计内的（`escrowWatcher` 会把
 * `cancelled` 恢复成 `escrowed`；文件头也明写"买家仍可在发货前重新提交收货信息"）。
 * 于是出现这条真实路径：400 天前擦过一次 → 今天买家重新填了收货信息且订单成交 →
 * `COALESCE` 仍取 400 天前的 `pii_erased_at` ⇒ 候选命中 ⇒ **刚填的地址在下一轮（≤6h）被再次删除**，
 * 店主失去退货/售后依据。锚点的语义应当是"最后一次动静"（擦除或业务更新取其晚者），
 * `GREATEST` 正是这个意思。
 *
 * 两列都是 `DATETIME(3)` → 驱动给 `Date`，候选边界因此是 `Date` 参数（旧形状是毫秒整数，
 * 而 `COALESCE(pii_erased_at, 0)` 那种"用 0 当空值"的写法在 DATETIME 列上不可表达——
 * 这也是重设计把时间统一成 `Date` 的直接好处之一：空值只有 NULL 一种拼法）。
 *
 * @param {{days?:number, now?:number, limit?:number}} opts days 缺省取 config.pii.retentionDays；
 *        `now` 是**判定时刻的毫秒数**（仅供测试注入；它是要写进 SQL 的边界的输入，换算成 Date 后入库）
 * @returns {Promise<{days:number, disabled:boolean, candidates:number, erased:number, diskFailed:number,
 *            cleanupPending:number, orderNos:string[], truncated:boolean, counts:object}>}
 *
 * 候选面还额外排除**有在途售后案件**（after_sale_status='open'）的单：案件未了结时不销毁证据
 * （判据在 `eraseOrderPii` 内核；显式删除请求同样被拒，见 `afterSaleCaseOpen`）。
 */
export async function runPiiRetention({ days = config.pii.retentionDays, now = Date.now(), limit = RETENTION_MAX_PER_RUN } = {}) {
  /*
    **单飞闸（唯一实现，就放在这个内核里）**：保留期扫描有两个入口——定时器，以及
    `POST /api/shop/retention/run`。两个入口同时开跑会各自选中同一批候选，于是
    擦除计数被记两遍、审计表里出现重复的 `order.erase_pii` 行，而"
    pii_cleanup_pending 由最后写者决定"也让"还欠一次清理"这个标记可能被并发的那一轮抹掉。
    闸放在**内核**而不是两个入口各放一次：入口是可以再增加的，判据只有一处才拦得全。
    第二个调用者拿到的是**正在跑的那一轮**的结果（而不是自己再跑一遍）。
  */
  if (inflightRetention) return inflightRetention;
  inflightRetention = runPiiRetentionInner({ days, now, limit }).finally(() => { inflightRetention = null; });
  return inflightRetention;
}

async function runPiiRetentionInner({ days, now, limit }) {
  const n = Number(days);
  const empty = { shippingRows: 0, claimPii: 0, evidenceContents: 0, attachmentRows: 0, attachmentFiles: 0, reviewImages: 0 };
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('PII 保留期天数无效（需 ≥ 0 的整数；0 = 关闭自动擦除）');
  }
  // 0 = 关闭自动扫描（默认值来自 MK_PII_RETENTION_DAYS）；显式删除仍受案件/claim 内核闸约束
  if (n === 0) return { days: 0, disabled: true, candidates: 0, erased: 0, diskFailed: 0, cleanupPending: 0, orderNos: [], truncated: false, counts: empty };
  const cutoff = new Date(Number(now) - Math.floor(n) * 86_400_000);
  const db = getDb();
  /*
    **有在途售后案件的单不自动擦除**（契约 2026-10 第二批带来的新状态）。
    为什么必须在这里让路：售后案件只存在于**终局**单上（链上要求 Settled），而终局单正是保留期
    扫描的候选面——一条 settlement 后的案件（"收到货才发现是假货"）往往在成交 180 天后才被开出来
    （窗口上限 360 天），扫到就擦等于**把双方刚提交的 after_sale 陈述正文、证据附件与收货信息
    一起销毁**，而仲裁人还要靠它们裁决（罚没走 Staking.penalize）。这与 disputed 被排除在
    可擦集之外是同一条理由：争议/救济未了结时不销毁证据。

    边界（刻意的，别顺手改）：
      · 自动保留期扫描与显式删除请求**都**让路：后者的主体是店主，而店主正是售后案件里可能
        被罚的一方；让他在开案后擦掉双方陈述/附件，等于先销毁裁决证据。拒绝发生在内核
        （`eraseOrderPii` 的 `after_sale_status='open'` 检查），不是某个调用点；
      · 案件结案（closed）后这行立刻回到候选面，到期即擦，不改变保留期的最终效果。

    候选读的是**读模型视图 v_orders**：`after_sale_status` 住在 `order_chain`、`status` 住在
    `orders`，而保留期的判据跨越这两张表——视图正是"把一张订单读全"的唯一读法
    （写仍然一律直接命中具体那张表，见 db.js 的说明）。
    逐批重查（而不是一次性取全量再逐个擦）：每擦完一批，候选面就变了——`pii_erased_at` 前移、
    `pii_cleanup_pending` 归零，所以下一批必须重新选（见下面 while 里的说明）。
  */
  const counts = { ...empty };
  const orderNos = [];
  /*
    审计行的 actor = **节点主**（`node.owner`）：保留期扫描是这台机器自己的动作，没有请求上下文。
    读一次、整轮共用（每单一次审计写，不该每单再查一次那一行）。
  */
  const nodeAddr = await nodeOwner();
  const auditActor = nodeAddr || 'system';
  let examined = 0;
  /**
   * 本轮"库内已擦、但还有没清完的清理工作"的单数（见 eraseOrderPii 的 pending 分支）：
   * 现在只剩磁盘附件一条腿（库服务器侧的残留节点删不掉、重试也没有意义）。
   * 它们**不是"永远不会重来"**——候选判据里有 `OR pii_cleanup_pending = 1`，
   * 所以每一轮扫描都会把它们排在队首重试（`ORDER BY` 那一项）。
   */
  let diskFailed = 0;
  let cleanupPending = 0;
  const AGE_SQL = 'GREATEST(COALESCE(pii_erased_at, updated_at), updated_at)';
  /*
    在途提货声明同样让路：claim 的收货信息正在用于履约，擦订单那一行不是“擦干净”。
    显式删除请求仍可在 claim 终局后执行；这里只挡自动保留期，避免每轮白跑。
  */
  const ACTIVE_CLAIM_SQL =
    "NOT EXISTS (SELECT 1 FROM nft_claims nc WHERE nc.order_id = o.order_id AND nc.status IN ('requested','approved','shipped'))";
  while (examined < limit) {
    const rows = await db.all(
      `SELECT order_no, shop_code FROM v_orders o WHERE status IN (${ERASABLE_MARKS}) AND ${AFTER_SALE_NOT_OPEN_SQL} ` +
        `AND ${ACTIVE_CLAIM_SQL} AND (${AGE_SQL} <= ? OR pii_cleanup_pending = 1) ` +
        `ORDER BY (pii_cleanup_pending = 1) DESC, ${AGE_SQL} ASC LIMIT ?`,
      ...PII_ERASABLE_STATUS,
      cutoff,
      RETENTION_BATCH
    );
    if (!rows.length) break;
    let erasedInBatch = 0;
    for (const row of rows) {
      examined += 1;
      try {
        const r = await eraseOrderPii(row.order_no);
        /*
          拒绝（`code` 非空 = **什么也没擦**）与半成功（`ok:false` + 读数）是两种结论，
          判据只能是内核给的那个 `code`——两者都带 `error`，按"有没有 error"分支会把
          "状态在擦除前一刻被改回在途"记成"删盘失败"，运维就会去查一个不存在的目录权限问题。
        */
        if (r.code) continue;
        if (r.error) {
          diskFailed += 1;
          if (r.cleanupPending) cleanupPending += 1;
          console.error(`[pii] 保留期擦除 ${String(row.order_no)} 未完全成功：${r.error}`);
          continue;
        }
        for (const k of Object.keys(counts)) counts[k] += r.counts[k] || 0;
        orderNos.push(row.order_no);
        erasedInBatch += 1;
        /*
          逐单审计：与手动端点同 action，detail.trigger 区分来源（audit_logs 只存摘要，无 PII）。
          **必须 await**：logAudit 是异步写。不 await 时本轮会在审计行落库之前就返回 `erased`
          ——调用方（手动端点/healthz/测试）读到的"已擦 N 单"是一个**没有审计痕迹**的结论，
          而审计恰恰是擦除这种不可逆动作唯一的证据。

          归属 = **这一单所属的店**（不是"谁触发的"）：保留期扫描是节点级动作（actor_role=host），
          但它擦的是某家店的订单——店主的审计列表里必须看得见"我这家店有一单被擦了"。
          挂成节点级就等于把这件事从受影响那家店的视野里拿掉（扫一次全节点，各家店一无所知）。
        */
        await logAudit({
          actor: auditActor,
          // 保留期扫描没有请求上下文：动作主体是这台节点，所以角色是 host（节点主）
          actorRole: 'host',
          shopCode: row.shop_code,
          action: 'order.erase_pii',
          targetType: 'order',
          targetId: row.order_no,
          detail: { trigger: 'retention', retentionDays: Math.floor(n), ...r.counts },
        });
      } catch (e) {
        console.error(`[pii] 保留期擦除 ${String(row.order_no)} 失败（下轮重试）:`, e?.message || e);
      }
    }
    // 本批一单都没擦掉（异常/状态竞态）→ 不再继续：否则 while 会一直选中同一批卡住的行，
    // 把本轮额度全耗在它们身上，新到期的订单永远轮不到（与 escrowWatcher 的隔离清单同思路）
    if (erasedInBatch === 0) break;
    if (rows.length < RETENTION_BATCH) break;
  }
  return {
    days: Math.floor(n),
    disabled: false,
    candidates: examined,
    erased: orderNos.length,
    diskFailed,
    cleanupPending,
    orderNos,
    truncated: examined >= limit,
    counts,
  };
}

/**
 * 保留期任务的运行状态（在 /healthz 暴露）：
 * 原先只有 console 日志——运维看不到「上次擦除是什么时候、擦了几单、有没有一直在失败」，
 * 而自动擦除是**不可逆**的：一个静默失败的定时器意味着个人信息一直留着（合规上是漏，运维上却
 * 毫无信号）。这里记最近一次运行的结果，与 watcher 的状态同款处理（docker healthcheck 看不出
 * 这类问题的，必须让 /healthz 能看出来）。
 *
 * 两个时刻是 `Date`（对外 JSON 是 ISO-8601）：healthz 的读者是运维与监控，
 * 而同一份响应里混着"毫秒整数"和"ISO 字符串"两种时间，迟早会有人拿错一个去比较。
 */
const retentionStatus = {
  enabled: false,
  intervalMs: 0,
  lastRunAt: null,
  lastOkAt: null,
  lastError: null,
  lastScanned: 0,
  lastErased: 0,
  lastDiskFailed: 0,
  /** 仍欠清理的单数（只剩磁盘附件这一条腿）：它们每轮都会被重试，运维据此判断"清目录"这件事做完没有 */
  lastCleanupPending: 0,
  lastCounts: null,
};

/** 只读快照（/healthz 用） */
export function piiRetentionStatus() {
  return { days: PII_RETENTION_DAYS, ...retentionStatus };
}

/**
 * 启动周期擦除（server 入口调用）：MK_PII_RETENTION_DAYS=0 时不启动任何定时器
 * （关闭即真的关闭，不留空转）。tick 自己包 try/catch：擦除异常不得击穿进程
 * （`runPiiRetention` 现在是异步的，异常从 await 处抛出，所以捕获必须在这里）。
 */
export function startPiiRetentionSweep() {
  if (!(PII_RETENTION_DAYS > 0)) {
    retentionStatus.enabled = false;
    console.log('[pii] MK_PII_RETENTION_DAYS=0：保留期自动擦除已关闭（显式删除请求仍可用，但在途售后的陈述/附件不可擦）');
    return null;
  }
  retentionStatus.enabled = true;
  retentionStatus.intervalMs = SWEEP_INTERVAL_MS;
  const tick = async () => {
    retentionStatus.lastRunAt = new Date();
    try {
      const r = await runPiiRetention();
      retentionStatus.lastOkAt = new Date();
      retentionStatus.lastScanned = r.candidates ?? 0;
      retentionStatus.lastErased = r.erased ?? 0;
      retentionStatus.lastDiskFailed = r.diskFailed ?? 0;
      retentionStatus.lastCleanupPending = r.cleanupPending ?? 0;
      retentionStatus.lastCounts = r.counts || null;
      /*
        "库内已擦、但还有没清完的清理工作"是**半成功**，不能报绿。
        现在这条只剩磁盘附件一条腿（库服务器侧的残留删不掉）。这些单会被下一轮重试
        （候选判据里有 `OR pii_cleanup_pending = 1`），所以这里写的是"还剩几单待清"，
        而不是"再也不会重来"。
      */
      retentionStatus.lastError =
        retentionStatus.lastCleanupPending > 0
          ? `有 ${retentionStatus.lastCleanupPending} 单的个人信息还没清完（附件文件未删净）——已排队等待下一轮重试；若是目录权限/占用导致，请一并处理`
          : null;
      if (r.erased > 0) {
        console.log(`[pii] 保留期擦除：${r.erased} 个终局订单（静置 > ${r.days} 天）的收货信息/备注/陈述正文/证据附件已擦除`);
      }
      if (retentionStatus.lastError) console.error(`[pii] ${retentionStatus.lastError}`);
    } catch (e) {
      retentionStatus.lastError = String(e?.message || e);
      console.error('[pii] 本轮保留期擦除异常（下轮重试）:', e?.message || e);
    }
  };
  // 首轮立即跑一次（"启动即收敛"），但不阻塞返回定时器：擦除要读库、必然异步，异常在 tick 内部消化
  void tick();
  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[pii] 保留期擦除已启用：终局订单静置超过 ${PII_RETENTION_DAYS} 天后自动擦除个人信息`);
  return timer;
}
