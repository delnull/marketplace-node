/**
 * 个人信息擦除与保留期（PIPL 式删除请求的落地实现，2026-09）。
 *
 * 为什么需要它：`orders.shipping_name/phone/address`、`orders.note`、
 * `orders.invoice_title/invoice_tax_no`（开票抬头与税号同样是个人信息：抬头常是真实姓名，
 * 税号可关联到具体主体）、`dispute_evidence.content` 与证据附件一旦落库就永久留在磁盘上——
 * 此前**没有任何产品能力**能删掉它们，店主收到买家的删除请求只能手工改库（或者干脆做不到）。
 * 本模块提供两条通道，**共用同一个擦除内核**（eraseOrderPii，只有一份实现，防两条路径的擦除范围漂移）：
 *  1. 显式删除请求：POST /api/shop/orders/:id/erase-pii（ownerOnly，见 routes/pii.js）；
 *  2. 保留期到期自动擦除：runPiiRetention（POST /api/shop/retention/run 手动触发 +
 *     server.js 启动的周期扫描），阈值 = MK_PII_RETENTION_DAYS（默认 180 天，0 = 关闭）。
 *
 * 擦除范围（只有这些是个人信息）：
 *  - 收货信息三列与买家备注 → 置空串（列 NOT NULL DEFAULT ''，不写 NULL）；
 *  - 发票抬头与纳税人识别号 → 置空串（invoice_needed 这个**布尔标记**不是个人信息，
 *    它只是"这单要不要开票"的处理状态，与金额/状态同列为不可删的订单事实，故保留）；
 *  - 每条售后/争议陈述的正文 → 墓碑串（**不删行**：时间线/角色/阶段是资金争议的事实记录，
 *    "谁在什么时候提交过陈述"必须留着，只有正文属于个人信息）；
 *  - 证据附件 → DB 行 + 磁盘文件一并删除（文件才是真正的个人数据，行只是索引；
 *    删行不删文件等于"数据还在磁盘上"，是最常见的假删除）。
 * 金额、状态、链上托管单号、支付交易哈希、链上事件史、不带 PII 的评价与交付行**一律不动**：
 * 它们是账目与链上凭证，删掉就等于篡改账本（也删不掉链上那份公开历史）。
 *
 * 终局才可擦（PII_ERASABLE_STATUS）：draft/escrowed/shipped/disputed 的在途单必须保留收货
 * 信息，否则卖家无法发货、退款也无法联系买家。该约束写在核心里，两条通道同样受它约束。
 *
 * 幂等：重复调用不报错、不重复计数；磁盘清理无条件执行，所以"上一次删文件失败"能被
 * 下一次调用补齐（孤儿文件不因 DB 行已消失而永久留在磁盘上）。
 *
 * ⚠ 擦除只写 `pii_erased_at`（擦除锚点），**绝不写 `updated_at`**（2026-09 复审修复，P1）：
 * `updated_at` 是入账/争议起始时刻的口径，被擦除动作改写会让旧成交额重新落进近期报表窗口
 * （详见 eraseOrderPii 内的说明）。
 */
import fs from 'node:fs';
import config, { PII_RETENTION_DAYS } from './config.js';
import { getDb, txBegin, txCommit, txRollback, checkpointTruncate } from './db.js';
import { logAudit } from './audit.js';
import { orderAttachDir, removeOrderAttachments } from './evidenceFiles.js';
// 状态集合的唯一出处（见下方再导出说明）：本文件内部要用，所以先 import 再 export
import { PII_ERASABLE_STATUS, PII_PROTECTED_STATUS } from './orderStatus.js';
// 确认收货后的售后案件：在途判据的唯一实现（保留期扫描据此让路，见 runPiiRetention）
import { AFTER_SALE_NOT_OPEN_SQL } from './afterSale.js';

/** 陈述正文的墓碑（保留可读性：当事人看到的是"已删除"而不是空白/报错） */
export const PII_TOMBSTONE = '[已按数据删除请求擦除]';

/**
 * 可擦除状态 = 资金流已终结（confirmed/settled/refunded/expired 四个终局 + 从未支付的 cancelled）。
 * cancelled 一并纳入：它从未上链托管（取消条件就是 draft 或"escrowed 但无支付凭证"），静置
 * 超期即是弃单，留着买家填过的收货地址纯属风险；万一久远之后链上又冒出一笔该单号的真实托管
 * （watcher 会把 cancelled 恢复成 escrowed），买家仍可在发货前经 PATCH /:id/shipping 重新提交
 * 地址——恢复通道没有被这次擦除堵死。
 *
 * 集合本体在 `src/orderStatus.js`（订单状态集合的唯一出处）：本文件只再导出，
 * 保证"擦除面 / 保护面"与 schema 的 CHECK 约束、以及其它模块用的是**同一份**定义
 * （改一处漏一处在这类集合上全都不报错，见 orderStatus.js 的说明）。
 */
export { PII_ERASABLE_STATUS, PII_PROTECTED_STATUS };

/** 保留期扫描的单批候选数（一轮内多批推进，避免一次扫描长时间占用主线程） */
const RETENTION_BATCH = 20;
/**
 * 单次运行最多处理的候选订单数（周期扫描与手动运行共用）：SQLite 与 fs 都是同步 API，
 * 一次擦太多会长时间占住事件循环（HTTP 全部排队）。200 单/次足够日常（周期扫描每 6 小时
 * 一轮），存量很大时手动端点会回 `truncated: true`，再点一次即可继续。
 */
const RETENTION_MAX_PER_RUN = 200;
/** 周期扫描间隔（6 小时）：保留期以天计，多轮只为"启动即收敛"与新终局单尽早清理 */
const SWEEP_INTERVAL_MS = 6 * 3600_000;

/** 空值归一（列非空但可能是 ''，计数时两者等价） */
const nonEmpty = (v) => String(v ?? '') !== '';

/**
 * 磁盘附件清理（事务外，见 eraseOrderPii 说明）。
 *
 * @returns {{removed:number, remaining:number}} `removed` = 删除**前**目录内的文件数（= 本次擦掉了
 *   几个，用于响应/审计的计数）；`remaining` = 删除**之后**目录里还剩几个文件，
 *   **0 表示确实干净**，非 0 表示没删净（权限/占用/只读挂载）。
 *
 * 为什么返回"残留数"而不是 `ok:false` 加一个原因字段（2026-10-14）：调用方要判的是
 * "盘上还有没有个人数据"，那就该由**实测的残留数**回答。返回一个布尔时，消费方只要把字段名
 * 猜错（历史上就写成了 `attachmentFiles.failed`）就会把失败读成成功，而且**没有任何测试会红**——
 * `undefined > 0` 不抛错。残留数是**事实**，不是对事实的描述，猜不歪。
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
    console.error(`[pii] 订单 ${String(orderId).slice(0, 8)}… 的证据附件删除失败（磁盘上仍有数据，将重试）:`, e?.message || e);
  }
  return { removed: Math.max(0, before), remaining: countFiles() };
}

/**
 * 擦除单个订单的个人信息（**唯一实现**；调用方只负责鉴权与审计）。
 * @param {string} orderId 本地订单 id（内部重读该行，避免调用方传入过期快照）
 * @returns {{ok:true, orderId:string, status:string, changed:boolean, counts:object}
 *          | {error:'not_found'|'not_terminal', message:string}}
 *  counts = { shippingFields, invoiceFields, evidenceContents, attachmentRows, attachmentFiles }（只有计数，
 *  不含任何被擦除的内容——审计与响应都不应把 PII 再抄一份出来）。
 */
export function eraseOrderPii(orderId) {
  const db = getDb();
  const id = String(orderId || '');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return { error: 'not_found', message: '订单不存在' };
  if (!PII_ERASABLE_STATUS.includes(String(order.status))) {
    return {
      error: 'not_terminal',
      message:
        `当前状态(${order.status})不可擦除个人信息：资金流未终结——在途单必须保留收货信息，` +
        '卖家才能按地址发货（draft/escrowed/shipped/disputed 一律拒绝）。请等订单终局' +
        '（confirmed/settled/refunded/expired/cancelled）后再执行删除请求',
    };
  }
  const now = Date.now();
  const counts = { shippingFields: 0, invoiceFields: 0, evidenceContents: 0, attachmentRows: 0, attachmentFiles: 0 };
  // 计数取自擦除前的行快照（擦除之后就无从得知"原来有没有内容"了；只记数，不记内容）
  counts.shippingFields = [order.shipping_name, order.shipping_phone, order.shipping_address, order.note].filter(nonEmpty).length;
  // 开票抬头/税号计入独立计数器（与收货信息分开，运维才能看清"这次擦掉的是哪一类个人信息"）
  counts.invoiceFields = [order.invoice_title, order.invoice_tax_no].filter(nonEmpty).length;
  txBegin();
  let attachmentFiles = { files: 0, ok: true };
  try {
    /*
      收货信息 + 备注无条件 UPDATE（已擦净也写一次锚点）。
      锚点是 `pii_erased_at`，**不是 `updated_at`**（2026-09 复审修复，P1）：
      `updated_at` 是**入账/争议起始时刻**的口径——流水页（routes/orders.js 的 INCOME_STATUS 窗口）、
      看板 GMV 与趋势日桶（stats.js）、ledger.csv 的 income_at 全按它分窗。旧实现为了"擦过就不再重复
      入选"而每轮把 updated_at 刷成当天，后果是**一笔 180 天前的成交额会在被擦那个月重新落进
      「最近 30 天」的报表里**，同一笔钱跨月各出现一次（escrowWatcher.js 里对同类改写写下的禁令：
      "一个迟到的事件把已终局的行挪进更晚的窗口，就等于让成交额在两天的报表里各出现一次"）。
      单独一列拿到同一个性质（COALESCE(pii_erased_at, updated_at) 选候选），且账目列一个字节都不动。
      金额/状态/托管单号/支付哈希/事件史均不在此列（账目与链上凭证不可删）。
      发票抬头/税号同属个人信息，一并置空（invoice_needed 标记保留，见文件头）。
    */
    db.prepare(
      "UPDATE orders SET shipping_name = '', shipping_phone = '', shipping_address = '', note = '', " +
        "invoice_title = '', invoice_tax_no = '', pii_erased_at = ? WHERE id = ?"
    ).run(now, id);
    // 陈述正文 → 墓碑：只改正文，行/角色/阶段/时刻保留（时间线仍是完整的事实记录）
    counts.evidenceContents = db
      .prepare('UPDATE dispute_evidence SET content = ? WHERE order_id = ? AND content != ?')
      .run(PII_TOMBSTONE, id, PII_TOMBSTONE).changes;
    // 附件索引行删除（文件随 order_id 级联语义一并删；显式按 order_id 删除不依赖级联开关）
    counts.attachmentRows = db.prepare('DELETE FROM evidence_files WHERE order_id = ?').run(id).changes;
    txCommit();
  } catch (e) {
    txRollback();
    throw e;
  }
  // 磁盘文件在 COMMIT 之后删：文件系统操作不可回滚，不能与 SQL 事务混在一起。顺序取
  // "先落库、后删文件"——若此处失败，DB 已无引用、磁盘残留由下次调用/运维清理兜底；
  // 反过来（先删文件后落库）一旦回滚，DB 里会留下指向不存在文件的悬空行。
  attachmentFiles = removeAttachmentsFromDisk(id);
  counts.attachmentFiles = attachmentFiles.removed;
  /*
    ── 附件删盘失败**不算擦干净**（2026-10-14 审计修订：旧判据是死代码）──────────────
    旧实现把判据写成 `!attachmentFiles.ok && attachmentFiles.failed > 0`，而
    `removeAttachmentsFromDisk` 从来**没有**返回过 `failed` 字段（它返回 `{files, ok}`）——
    `undefined > 0` 恒为 false ⇒ `diskFailed` 恒 false ⇒ 失败分支整段不可达：
    `ok:true` / `error:undefined` 恒成立，手动端点回"个人信息已擦除"，
    保留期扫描把它记成已擦除、写审计、`/healthz` 的 `piiRetention.lastError` 仍为 null。
    而磁盘上的证据附件（真正的个人数据）一个都没删掉。
    这正是"判据挂错层"的形状：**成功与否必须由事实产出方给出**，不能由消费方去猜字段名。
    所以现在 `removeAttachmentsFromDisk` 返回"**删完之后还剩几个文件**"（含"连目录都列不出来"
    时的哨兵值），这里的 `ok` 只由它派生——名字写错不可能再变成成功。
  */
  const diskFailed = attachmentFiles.remaining !== 0;
  /*
    锚点（`pii_erased_at`）只在**真的擦干净**时前移（2026-10-14）。
    旧实现的注释写着"锚点已经前移，所以这一单不会自动重来"，把"永不重试"当成一个已接受的边界——
    而它其实与"保留期自动擦除"这条产品承诺直接冲突：数据主体要求的删除，系统答复"已删除"、
    盘上却还在，而且没有任何自动重试。现在删盘失败 ⇒ 把锚点回退（连同本轮写入的行内字段一起
    已经没有个人信息了，回退锚点不会让信息复活），保留期扫描下一轮会**再试一次**；
    重试全部成功之后锚点才落定。代价如实写：失败期间这一单会反复出现在候选集里，
    直到目录权限/占用问题被解决（这正是我们要的——它是**可见的**未完成，而不是静默的成功）。
  */
  if (diskFailed) {
    db.prepare('UPDATE orders SET pii_erased_at = NULL WHERE id = ?').run(id);
  }
  /*
    WAL 截断（2026-10-14 审计新增，"假删除"的第二条腿）：库内字段已置空、释放页由
    `secure_delete=ON` 清零，但**WAL 里的历史帧**不在那两条的作用范围内——实测擦除之后
    `<db>-wal` 里仍能直接搜到手机号/地址/备注原文，而 PASSIVE 自动 checkpoint 不截断文件。
    所以每次擦除（手动与保留期都走这里）之后强制截断一次。失败不抛出：清 WAL 是加固，
    不该让一次"没清成"回滚已经落库的擦除（返回 null 时由下次擦除再试）。
  */
  const walTruncated = checkpointTruncate();
  return {
    ok: !diskFailed,
    error: diskFailed
      ? attachmentFiles.remaining < 0
        ? '附件目录无法读取（权限/挂载异常），无法确认磁盘上的附件是否已删除——请检查目录权限后重试（系统会在下一轮保留期扫描中自动重试）'
        : `附件索引已清空，但磁盘上还剩 ${attachmentFiles.remaining} 个文件未删除（目录权限/文件被占用）——请处理后重试（系统会在下一轮保留期扫描中自动重试）`
      : undefined,
    orderId: id,
    status: order.status,
    // 磁盘上的附件文件也算"本次真的擦掉了东西"：DB 行早前已删、只剩孤儿文件的情形同样是一次
    // 有意义的删除（否则响应会报"无变更"，让人以为没删干净/白跑一趟）
    changed:
      counts.shippingFields + counts.invoiceFields + counts.evidenceContents + counts.attachmentRows + counts.attachmentFiles > 0,
    // 三态（与响应里的其它读数同款）：true 确认删净 / false 确认没删净 / null 读不到 ⇒ 不敢说
    attachmentFilesRemoved: attachmentFiles.remaining < 0 ? null : attachmentFiles.remaining === 0,
    attachmentFilesRemaining: attachmentFiles.remaining,
    /** WAL 是否已截断（false = 原文可能仍在 `<db>-wal` 里；见 checkpointTruncate 的说明） */
    walTruncated,
    counts,
  };
}

/**
 * 保留期擦除（周期扫描与 POST /api/shop/retention/run 共用）：终局且静置超过 days 天的订单
 * 自动擦除个人信息——"存着不删"本身就是合规风险，到期即清无需人工记得。
 *
 * 候选锚点 = `MAX(COALESCE(pii_erased_at, 0), updated_at)`，按它升序（最旧的先擦）、单轮分批推进、最多 limit 单。
 * **为什么不是单用 updated_at**（2026-09 复审修复，P1）：扫描需要"擦过就不再重复入选"的锚点
 * （否则已擦净的旧单每轮都占满批量上限，新到期的单永远轮不到），而 `updated_at` 是**入账时刻**
 * 的口径（流水/ GMV 窗口 / 趋势日桶 / ledger.csv 全按它分窗）——拿它当锚点就等于把一笔旧成交
 * 挪进更晚的报表窗口，同一笔钱跨月各出现一次。`pii_erased_at` 提供同一个性质且不碰账目列。
 *
 * **为什么是 MAX 而不是 COALESCE**（源码审计 2026-09 复审，P1）：`COALESCE(a, b)` 在 a 非空时
 * **完全忽略 b**，取到的是"两个时刻里更旧的那个"。而 `pii_erased_at` 一旦写入就再无任何代码
 * 重置（`eraseOrderPii` 是唯一写入点），恢复通道却是设计内的（`escrowWatcher` 会把
 * `cancelled` 恢复成 `escrowed`；文件头也明写"买家仍可在发货前经 PATCH /:id/shipping 重新提交地址"）。
 * 于是出现这条真实路径：400 天前擦过一次 → 今天买家重新填了收货信息且订单成交 →
 * `COALESCE` 仍取 400 天前的 `pii_erased_at` ⇒ 候选命中 ⇒ **刚填的地址在下一轮（≤6h）被再次销毁**，
 * 店主失去退货/售后依据。锚点的语义应当是"最后一次动静"（擦除或业务更新取其晚者），
 * `MAX` 正是这个意思；从未擦过的行 `COALESCE(...,0)` = 0 ⇒ 与旧口径 `updated_at` 完全一致，
 * 不改变任何存量行为。
 * @param {{days?:number, now?:number, limit?:number}} opts days 缺省取 config.pii.retentionDays
 * @returns {{days:number, disabled:boolean, candidates:number, erased:number, orderIds:string[],
 *            truncated:boolean, counts:object}}
 *
 * 候选面还额外排除**有在途售后案件**（after_sale_status='open'）的单：案件未了结时不销毁证据
 * （理由与边界见下方 pick 处的说明；显式删除请求不受此限）。
 */
export function runPiiRetention({ days = config.pii.retentionDays, now = Date.now(), limit = RETENTION_MAX_PER_RUN } = {}) {
  const n = Number(days);
  const empty = { shippingFields: 0, invoiceFields: 0, evidenceContents: 0, attachmentRows: 0, attachmentFiles: 0 };
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('PII 保留期天数无效（需 ≥ 0 的整数；0 = 关闭自动擦除）');
  }
  // 0 = 关闭（默认值来自 MK_PII_RETENTION_DAYS）：不扫描、不擦除，但显式删除请求不受影响
  if (n === 0) return { days: 0, disabled: true, candidates: 0, erased: 0, orderIds: [], truncated: false, counts: empty };
  const cutoff = now - Math.floor(n) * 86_400_000;
  const db = getDb();
  const marks = PII_ERASABLE_STATUS.map(() => '?').join(',');
  /*
    **有在途售后案件的单不自动擦除**（2026-10，契约第二批带来的新状态）。

    为什么必须在这里让路：售后案件只存在于**终局**单上（链上要求 Settled），而终局单正是保留期
    扫描的候选面——一条 settlement 后的案件（"收到货才发现是假货"）往往在成交 180 天后才被开出来
    （窗口上限 360 天），扫到就擦等于**把双方刚提交的 after_sale 陈述正文、证据附件与收货信息
    一起销毁**，而仲裁人还要靠它们裁决（罚没走 Staking.penalize）。这与 disputed 被排除在
    可擦集之外是同一条理由：争议/救济未了结时不销毁证据。

    边界（刻意的，别顺手改）：
      · 只挡**自动**保留期扫描。显式删除请求（POST /api/shop/orders/:id/erase-pii）仍照旧执行
        ——那是数据主体本人/店主明确要求删除，节点不该以"有案件"为由拒绝（要拒绝也该在业务层
        说明理由，而不是让保留期定时器替他们决定）；
      · 案件结案（closed）后这行立刻回到候选面，到期即擦，不改变保留期的最终效果。
  */
  const pick = db.prepare(
    `SELECT id FROM orders WHERE status IN (${marks}) AND ${AFTER_SALE_NOT_OPEN_SQL} ` +
      `AND MAX(COALESCE(pii_erased_at, 0), updated_at) <= ? ` +
      `ORDER BY MAX(COALESCE(pii_erased_at, 0), updated_at) ASC LIMIT ?`
  );
  const counts = { ...empty };
  const orderIds = [];
  let examined = 0;
  /**
   * 本轮"库内已擦、但磁盘附件没删掉"的单数（见 eraseOrderPii 的磁盘失败分支）。
   * 它不是成功也不是普通异常：锚点已前移 ⇒ 自动路径不会再来，必须让运维看得见。
   */
  let diskFailed = 0;
  while (examined < limit) {
    const rows = pick.all(...PII_ERASABLE_STATUS, cutoff, RETENTION_BATCH);
    if (!rows.length) break;
    let erasedInBatch = 0;
    for (const row of rows) {
      examined += 1;
      try {
        const r = eraseOrderPii(row.id);
        if (r.error) {
          diskFailed += 1;
          console.error(`[pii] 保留期擦除 ${String(row.id).slice(0, 8)}… 未完全成功：${r.error}`);
          continue;
        }
        for (const k of Object.keys(counts)) counts[k] += r.counts[k] || 0;
        orderIds.push(row.id);
        erasedInBatch += 1;
        // 逐单审计：与手动端点同 action，detail.trigger 区分来源（audit_logs 只存摘要，无 PII）
        logAudit({
          actor: config.shop.owner || 'system',
          actorRole: 'owner',
          action: 'order.erase_pii',
          targetType: 'order',
          targetId: row.id,
          detail: { trigger: 'retention', retentionDays: Math.floor(n), ...r.counts },
        });
      } catch (e) {
        console.error(`[pii] 保留期擦除 ${String(row.id).slice(0, 8)}… 失败（下轮重试）:`, e?.message || e);
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
    erased: orderIds.length,
    diskFailed,
    orderIds,
    truncated: examined >= limit,
    counts,
  };
}

/**
 * 保留期任务的运行状态（在 /healthz 暴露，源码审计 2026-09）：
 * 原先只有 console 日志——运维看不到「上次擦除是什么时候、擦了几单、有没有一直在失败」，
 * 而自动擦除是**不可逆**的：一个静默失败的定时器意味着个人信息一直留着（合规上是漏，运维上却
 * 毫无信号）。这里记最近一次运行的结果，与 watcher 的状态同款处理（docker healthcheck 看不出
 * 这类问题的，必须让 /healthz 能看出来）。
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
  lastCounts: null,
};

/** 只读快照（/healthz 用） */
export function piiRetentionStatus() {
  return { days: PII_RETENTION_DAYS, ...retentionStatus };
}

/**
 * 启动周期擦除（server 入口调用）：MK_PII_RETENTION_DAYS=0 时不启动任何定时器
 * （关闭即真的关闭，不留空转）。tick 包 try/catch：擦除异常不得击穿进程。
 */
export function startPiiRetentionSweep() {
  if (!(PII_RETENTION_DAYS > 0)) {
    retentionStatus.enabled = false;
    console.log('[pii] MK_PII_RETENTION_DAYS=0：保留期自动擦除已关闭（显式删除请求仍可用 POST /api/shop/orders/:id/erase-pii）');
    return null;
  }
  retentionStatus.enabled = true;
  retentionStatus.intervalMs = SWEEP_INTERVAL_MS;
  const tick = () => {
    retentionStatus.lastRunAt = Date.now();
    try {
      const r = runPiiRetention();
      retentionStatus.lastOkAt = Date.now();
      retentionStatus.lastScanned = r.candidates ?? 0;
      retentionStatus.lastErased = r.erased ?? 0;
      retentionStatus.lastDiskFailed = r.diskFailed ?? 0;
      retentionStatus.lastCounts = r.counts || null;
      /*
        "库内已擦、磁盘附件没删掉"是**半成功**，不能报绿（源码审计 2026-09 复审）：
        `pii_erased_at` 已前移 ⇒ 这一单不会再入选，而证据文件还留在磁盘上。
        把它写进 lastError（/healthz 可见），让运维按提示去清目录权限/占用。
      */
      retentionStatus.lastError =
        retentionStatus.lastDiskFailed > 0
          ? `有 ${retentionStatus.lastDiskFailed} 单的附件索引已清空但磁盘文件未删净（目录权限/文件被占用）——请检查附件目录后手动清理`
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
  tick();
  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[pii] 保留期擦除已启用：终局订单静置超过 ${PII_RETENTION_DAYS} 天后自动擦除个人信息`);
  return timer;
}
