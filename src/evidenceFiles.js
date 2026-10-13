/**
 * 证据附件（P0-2）：图片/PDF 上传、鉴权下载、文件落盘与安全校验。
 *
 * 规则（见 docs/ARCHITECTURE.md §3.1）：
 *  - 白名单 image/png|jpeg|webp、application/pdf；**magic bytes 嗅探**（防改扩展名伪装）；
 *  - 单文件 ≤2MB；单条 evidence ≤6 个；单订单累计 ≤20MB；
 *  - 磁盘文件名 = uuid.安全扩展名（与原始文件名隔离，防路径穿越/编码诡计）；
 *  - sha256 存证；可见矩阵与 evidence 文本一致（buyer/owner；arbiter 仅 disputed **或有在途
 *    售后案件的终局单**——后者是契约 2026-10 第二批的裁决面，见 afterSale.js）；
 *  - 附件不可删除/修改（证据语义）；
 *  - **陈述时限**（`MK_DISPUTE_STATEMENT_DAYS`，默认 7 天，0 = 关闭）：争议与售后案件两个阶段的
 *    举证窗口，自"进入争议/案件开案"的**本地镜像时刻**起算，过期提交被拒（拒因可读）；
 *    判据与阶段/身份/条数同处 `evidencePhaseError`（唯一门控），订单 DTO 的倒计时字段
 *    `statementDeadlineAt` 走 `statementFieldsOf`（与门控同一份窗口计算）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, txBegin, txCommit, txRollback } from './db.js';
import config from './config.js';
import { ACTIVE_STATUS } from './orderStatus.js';
// 确认收货后的售后案件：在途判据的唯一实现（本文件的阶段门控与退货窗口、仲裁队列共用）
import { isAfterSaleOpen, hasAfterSaleHistory } from './afterSale.js';

export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB
export const MAX_FILES_PER_EVIDENCE = 6;
export const MAX_BYTES_PER_ORDER = 20 * 1024 * 1024; // 20MB
export const MAX_RAW_NAME = 120;

/** 白名单：mime → { ext, magic 前缀（hex 字符串或 {offset,len}）} */
const ALLOWED = {
  'image/png': { ext: 'png', magic: '89504e47' },
  'image/jpeg': { ext: 'jpg', magic: 'ffd8ff' },
  'image/webp': { ext: 'webp', magic: { bytes: '52494646', at: 0, tag: '57454250', tagAt: 8 } }, // RIFF....WEBP
  'application/pdf': { ext: 'pdf', magic: '25504446' }, // %PDF
};
const MIME_ALIAS = { 'image/jpg': 'image/jpeg' };

function hasMagic(buf, spec) {
  if (typeof spec === 'string') {
    const hex = Buffer.from(spec, 'hex');
    return buf.length >= hex.length && buf.subarray(0, hex.length).equals(hex);
  }
  const head = Buffer.from(spec.bytes, 'hex');
  const tag = Buffer.from(spec.tag, 'hex');
  return (
    buf.length >= spec.tagAt + tag.length &&
    buf.subarray(0, head.length).equals(head) &&
    buf.subarray(spec.tagAt, spec.tagAt + tag.length).equals(tag)
  );
}

/** 校验并规范化单个文件声明；返回 {ok, error?} */
export function validateFileMeta({ name, mime, size }) {
  const m = String(mime || '').toLowerCase();
  const normalized = MIME_ALIAS[m] || m;
  if (!ALLOWED[normalized]) return { error: `文件类型不支持（${m || '未知'}）：仅支持 png/jpeg/webp 图片与 pdf` };
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) {
    return { error: '单文件需 ≤ 2MB' };
  }
  const rawName = String(name || '').replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_').trim().slice(0, MAX_RAW_NAME);
  if (!rawName) return { error: '文件名无效' };
  return { ok: true, mime: normalized, ext: ALLOWED[normalized].ext, rawName };
}

/** 附件根目录（MK_ATTACH_DIR 或 <db 文件目录>/attachments；:memory: 测试回退当前目录） */
function attachRoot() {
  if (config.attachDir) return config.attachDir;
  const dbFile = config.db.file;
  const dir = dbFile === ':memory:' ? process.cwd() : path.dirname(path.resolve(dbFile));
  return path.join(dir, 'attachments');
}

export function orderAttachDir(orderId) {
  return path.join(attachRoot(), String(orderId || ''));
}

/**
 * 保存一批评审通过的文件（两阶段：先全量校验 meta+magic，再逐个落盘+INSERT；
 * 任一文件失败不产生任何残留——已写文件删除 + 已插入的 DB 行删除（防悬空记录
 * 永久占订单配额/下载 404））。
 */
export function storeFiles({ orderId, evidenceId, files }) {
  const db = getDb();
  /**
   * 校验类失败（用户可自行修复：类型不符、魔数不符），消息是**我们自己写的**、可以原样回给客户端。
   * 打上 `expose` 标记，让路由层能把它们与 fs/db 的原始异常区分开——后者（`ENOENT: … open '/srv/…'`）
   * 含服务器绝对路径，只进服务端日志，不回客户端（源码审计 2026-09 复审，P2）。
   */
  const userError = (msg) => Object.assign(new Error(msg), { expose: true });
  // 阶段一：全量预检（meta + 魔数），失败即整体拒绝
  const prepared = files.map((f) => {
    const data = Buffer.from(f.dataB64, 'base64');
    const meta = validateFileMeta({ name: f.name, mime: f.mime, size: data.length });
    if (!meta.ok) throw userError(meta.error);
    const spec = ALLOWED[meta.mime];
    if (!hasMagic(data, spec.magic)) {
      throw userError(`文件「${meta.rawName}」内容与声明类型不符（魔数校验失败）`);
    }
    return { data, meta };
  });

  // 阶段二：逐文件写盘 + INSERT（写盘/落库中途异常：回滚已写文件与已插入行）。
  // DB 插入整批同事务：进程中断（非异常路径）也不留半批行——只可能遗留孤儿文件
  // （无害：配额按行计，下载按行定位）
  const dir = orderAttachDir(orderId);
  fs.mkdirSync(dir, { recursive: true });
  const created = [];
  const written = [];
  txBegin();
  try {
    for (const { data, meta } of prepared) {
      const stored = `${crypto.randomUUID()}.${meta.ext}`;
      const disk = path.join(dir, stored);
      fs.writeFileSync(disk, data, { flag: 'wx' });
      written.push(disk);
      const sha = crypto.createHash('sha256').update(data).digest('hex');
      const now = Date.now();
      const ins = db.prepare(
        'INSERT INTO evidence_files (evidence_id, order_id, filename, stored_name, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      const r = ins.run(evidenceId, String(orderId), meta.rawName, stored, meta.mime, data.length, sha, now);
      const rowId = Number(r.lastInsertRowid);
      created.push({ id: rowId, name: meta.rawName, mime: meta.mime, size: data.length, sha256: sha });
    }
    txCommit();
  } catch (e) {
    // 回滚已插入的 DB 行（整事务回滚）+ 已写文件（DB 行随事务消失，文件仍需手动清理）
    txRollback();
    for (const disk of written) {
      try {
        fs.rmSync(disk, { force: true });
      } catch {
        /* 忽略清理失败（孤儿由运维/目录清理兜底） */
      }
    }
    throw e;
  }
  return created;
}

/** 订单维度配额检查：已用字节/条数 */
export function orderQuota(orderId) {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS s FROM evidence_files WHERE order_id = ?')
    .get(String(orderId || ''));
  return { count: row.c, bytes: row.s };
}

/**
 * 可受理售后/争议陈述的**订单状态**（唯一实现；`POST /:id/evidence` 与附件上传共用）。
 *
 * 只有资金流仍在途的三种状态受理新的陈述：escrowed（已托管/已交付前）/ shipped（已发货）/
 * disputed（争议中）。draft 无售后可言，终局（confirmed/settled/refunded/expired）售后已结束，
 * cancelled 是本地弃单（含"异常态被取消"与"草稿超时清扫"）。
 *
 * **唯一的例外：有在途售后案件（after_sale_status='open'）的终局单同样受理。**
 * 确认收货后的售后案件（契约 2026-10 第二批）本来就只存在于终局单上（链上要求 Settled），
 * 它的双方陈述阶段（phase='after_sale'）必须能在**终局状态**下提交——否则这条救济路径
 * 只有链上动作、没有任何文字证据面。判据是**案件在途**（afterSale.js 的唯一实现），
 * 不是"终局就放行"：案件结案后（closed）陈述立即停止受理，与退款申请的冻结语义一致。
 *
 * 为什么必须判状态（源码审计 2026-09）：门控此前只看 `refund_status`，而 refund_status 只在
 * watcher/sync 的终局迁移里复位——`/cancel` 不复位。于是一笔「escrowed 无支付凭证（异常态）
 * + refund_status='requested'」的单，买家自行 /cancel 后（订单已成 cancelled），店主再对它
 * 执行 erase-pii（cancelled 在可擦集里）就出现**擦除不 sticky**：擦完仍能继续提交 ≤2000 字
 * 陈述与最多 6 个附件/20MB，往"已按删除请求擦净"的单上重新落下个人信息，保留期再等 180 天。
 * 门控按状态收口后，取消即终局：擦过的单不会再有新的个人数据流入。
 */
export const EVIDENCE_OPEN_STATUS = ACTIVE_STATUS; // 在途单才允许提交/追加陈述与附件

/** 状态门控：返回可读的中文原因或 null（允许）。两个写入端点共用同一实现 */
export function evidenceStatusError(order) {
  const status = String(order?.status || '');
  if (isAfterSaleOpen(order)) return null; // 在途售后案件：终局单也受理（见上方说明）
  if (EVIDENCE_OPEN_STATUS.includes(status)) return null;
  /*
    终局单里再分一句：**开过案但已结案**的单，拒它的理由是"案件已结案"，
    而不是含糊的"状态不接受陈述"——当事人点提交时最需要知道的就是这一点
    （他还想补充说明，就得先由买家在窗口内重新开案，或走仲裁/线下）。
  */
  if (hasAfterSaleHistory(order)) {
    return (
      `该订单的售后案件已结案（after_sale_status=${String(order?.after_sale_status)}），不再受理新的售后陈述——` +
      '如仍有争议请走链上仲裁或线下渠道；需要重新主张请在售后窗口内再次开案'
    );
  }
  return (
    `订单当前状态不接受新的售后陈述（当前 ${status || '未知'}；仅 ${EVIDENCE_OPEN_STATUS.join(' / ')} 受理，` +
    '或有在途售后案件的终局单）——' +
    '售后陈述与证据附件只对在途订单与在途售后案件开放：草稿请先在链上完成托管，已终局/已取消的订单请通过链上仲裁或线下渠道处理'
  );
}

/**
 * 售后/争议陈述的四个阶段（DB CHECK 约束同值；唯一实现，见 evidencePhaseError）：
 *  - refund_request 买家退款理由（refund_status=requested 期间）
 *  - refund_reply   店主回复退款申请（同上，争议后停止）
 *  - arbitration    争议双方的仲裁陈述（disputed 期间）
 *  - after_sale     确认收货后的**售后案件**陈述（after_sale_status='open' 期间，买卖双方均可）
 */
export const EVIDENCE_PHASES = ['refund_request', 'refund_reply', 'arbitration', 'after_sale'];

/**
 * 每单「每角色 × 每阶段」的陈述条数上限（防单方循环刷屏）。
 * 依据：两级售后是**一次性交互**（退款申请 / 店主回复各 1~3 条足够把话说清）；仲裁与
 * **售后案件**都是双方多次交锋（举证、反驳、补充说明），各给到 20 条。额度按 (order, role, phase)
 * 计——对方的陈述不占你的额度。
 * 上限只由写入端点执行；详情读取侧另有展示上限（orders.js 的 EVIDENCE_DETAIL_LIMIT）兜历史脏数据。
 */
export const EVIDENCE_LIMIT_BY_PHASE = { refund_request: 10, refund_reply: 10, arbitration: 20, after_sale: 20 };

/** 阶段中文字面（错误信息用，避免把内部枚举直接甩给用户） */
export const EVIDENCE_PHASE_LABEL = { refund_request: '退款理由', refund_reply: '退款回复', arbitration: '仲裁陈述', after_sale: '售后陈述' };

const DAY_MS = 24 * 3600 * 1000;

/**
 * **陈述时限**（双方举证窗口；配置 `MK_DISPUTE_STATEMENT_DAYS`，默认 7 天，0 = 关闭）——唯一实现。
 *
 * 为什么必须收口在这里（而不是路由层）：窗口是**阶段门控的一部分**——它和"订单状态/身份/阶段语义/
 * 条数上限"是同一道闸的四段，而这道闸有**两个写入端点**（`POST /:id/evidence` 提交陈述、
 * `POST /:id/evidence/:evidenceId/files` 追加附件）。判据一旦在路由里各写一遍，必然漂移，
 * 而漂移的后果不是文案不一致，是**一侧拒了、另一侧照收**：举证期过后还能往单上追加 20MB 个人数据，
 * 仲裁人看到的证据面就与"过期视为放弃举证"这条规则矛盾。所以窗口判定与 phase/身份判定同处一函数，
 * 两个端点只能拿到同一个结论。
 *
 * 锚点取**本地已镜像的链上时刻**，刻意不另算一套：
 *  - `arbitration` = `orders.updated_at`（watcher 回写 disputed 的那一刻；仲裁队列的 `disputedAt`
 *    就是这一列，两处口径必须一致，否则"队列里显示等了多久"与"还能不能提交"会各说一套）；
 *  - `after_sale`  = `orders.after_sale_opened_at`（链上 AfterSaleOpened 的落库时刻）。
 *    刻意不用 `updated_at`：案件**不动**订单状态、也不动 updated_at（见 src/afterSale.js 文件头）。
 *
 * 已知代价（如实写）：锚点是**落库时刻**而非链上区块时刻，watcher 轮询有间隔（默认 15s）+
 * 确认深度（默认 12 块），所以窗口起点比链上真实时刻晚若干秒；争议期间任何对 `orders` 的镜像写入
 * （如 `/sync` 顺带回填 refund_status）也会把 updated_at 往后推、顺延窗口——方向是**放宽**而不是
 * 误伤，且与仲裁队列的等待时长读数保持一致。要精确到区块就得另立一套链上读数，得不偿失。
 */
export const STATEMENT_PHASE_ANCHOR = Object.freeze({ arbitration: 'updated_at', after_sale: 'after_sale_opened_at' });

/** 锚点的中文字面（拒因里要说清"从哪一刻起算"） */
const STATEMENT_ANCHOR_LABEL = Object.freeze({ arbitration: '进入争议', after_sale: '案件开案' });

/** 当前配置的陈述时限天数（0 = 关闭）；getter 动态读取，见 config.dispute.statementDays 的说明 */
function statementDays() {
  const n = Number(config.dispute.statementDays);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 该阶段此刻的陈述窗口；**null = 没有窗口可言**（三态里的"不适用"，与"已过期"是两件事）：
 *   · 特性关闭（`MK_DISPUTE_STATEMENT_DAYS=0`）；
 *   · 该阶段不是当前阶段（订单未进入争议 / 没有在途售后案件）——由调用方先判；
 *   · 阶段锚点读不到（列缺失/空值）。
 * 返回 `expired` 与 `remainingMs`，供门控拒绝与 DTO 倒计时**共用同一份计算**。
 *
 * 已过期的窗口仍然返回对象（`expired: true, remainingMs: 0`）：界面要能显示"举证已截止"，
 * 而不是把"已截止"显示成"没有窗口"。
 *
 * @param {object} order orders 行
 * @param {'arbitration'|'after_sale'} phase
 * @param {number} now 判定时刻（毫秒；可注入，便于边界测试）
 * @returns {null | {phase: string, days: number, openedAt: number, deadlineAt: number, remainingMs: number, expired: boolean}}
 */
export function statementWindowOf(order, phase, now = Date.now()) {
  const days = statementDays();
  if (!days) return null; // 关闭：不限时
  const col = STATEMENT_PHASE_ANCHOR[phase];
  if (!col) return null; // 该阶段不设窗口（退款申请/回复两阶段）
  const openedAt = Number(order?.[col]);
  if (!Number.isFinite(openedAt) || openedAt <= 0) return null; // 锚点读不到：不假装"已过期"
  const deadlineAt = openedAt + days * DAY_MS;
  const expired = now > deadlineAt; // 边界：恰好到点仍算"未过"（"N 天内可提交"含第 N 天末尾）
  return { phase, days, openedAt, deadlineAt, remainingMs: expired ? 0 : deadlineAt - now, expired };
}

/** 陈述时限已过的拒因（**唯一措辞**：门控与附件端点逐字共用；可读、说清起算点与后果） */
function statementExpiredMessage(phase, win) {
  const d = new Date(win.deadlineAt);
  const p = (n) => String(n).padStart(2, '0');
  const at = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return (
    `陈述时限已过（自${STATEMENT_ANCHOR_LABEL[phase]}起第 ${win.days} 天，${at} 截止），过期视为放弃举证——` +
    '本单的裁决/结案不再等待新的陈述与附件；确有新材料请联系仲裁人或走线下渠道'
  );
}

/** 时限门控（阶段语义成立后才判，拒因才准确）；未过期/无窗口返回 null */
function statementGateError(order, phase, now) {
  const win = statementWindowOf(order, phase, now);
  if (!win || !win.expired) return null;
  return { code: 1, http: 200, message: statementExpiredMessage(phase, win) };
}

/**
 * 订单 DTO 的陈述时限字段（**唯一出处**：与门控同一份 `statementWindowOf`）。
 *
 * 形状：`statementDeadlineAt: number | null`——**举证截止时刻**（unix ms），**null = 未开启该规则**
 * （`MK_DISPUTE_STATEMENT_DAYS=0` 关闭 / 该单此刻没有争议也没有在途案件 / 锚点读不到）。
 * 契约的另一端是前端的 `frontend/src/types.ts`（Order.statementDeadlineAt）与
 * `frontend/src/utils/statementDeadline.ts`（倒计时与提交门），那边按同样的口径判"未开启 / 期内 / 已过期"。
 *
 * 为什么是**一个**字段而不是每阶段一个：订单不可能同时"争议中"与"有在途售后案件"
 * （案件要求订单已终局、钱已判给卖家，见 afterSale.js 文件头），所以此刻有效的窗口至多一个；
 * 阶段作用域由**门控**决定（只有 arbitration / after_sale 两阶段受约束），DTO 只回答"截止在什么时候"。
 * 前端据此对两个阶段用同一个截止时刻——与节点门控是同一套口径，不会出现"界面放行、服务端拒绝"。
 *
 * 三态：null **不是**"已过期"，而是"这条规则没开着"；已过期由 `deadlineAt <= now` 表达
 * （界面据此刻禁用提交并写明"过期视为放弃举证"）。
 */
export function statementFieldsOf(order, now = Date.now()) {
  return { statementDeadlineAt: statementDeadlineAtOf(order, now) };
}

/**
 * 此刻对本单生效的举证截止时刻（null = 未开启该规则）；与门控共用同一个窗口计算。
 *
 * 阶段选择：争议优先——`disputed` 是"钱还锁在托管里等裁决"的那个阶段；售后案件只存在于终局单上
 * （两者互斥）。真遇到矛盾数据（本地同时 disputed 且在途案件）时以争议为准，不去编一个折中值。
 */
export function statementDeadlineAtOf(order, now = Date.now()) {
  const phase = String(order?.status || '') === 'disputed' ? 'arbitration' : isAfterSaleOpen(order) ? 'after_sale' : null;
  if (!phase) return null; // 该单此刻没有受时限约束的阶段
  const win = statementWindowOf(order, phase, now);
  return win ? win.deadlineAt : null;
}

/**
 * 阶段门控（**唯一实现**）：订单状态 → 身份 → refund_status → 阶段语义。
 *
 * 为什么必须收口（源码审计 2026-09 续）：同一条判据此前在两处各写了一遍——
 * `POST /:id/evidence`（提交陈述）与 `POST /:id/evidence/:evidenceId/files`（追加附件）——
 * 而两处的**文案已经漂移**（一处写"订单已进入争议（disputed），退款申请阶段结束"，
 * 另一处多一句"请在争议流程中提交仲裁陈述或链上和解退款"），语义也出现了细微偏差
 * （附件那侧把"未知阶段"落进 arbitration 分支）。附件与陈述是同一份证据的两个部分，
 * 门控漂移的后果是一侧拒了、另一侧照收：往一个已经不允许陈述的单上追加 20MB 个人数据。
 *
 * 顺序**刻意**是「状态 → 身份 → 阶段」（与旧实现一致）：先判状态才能保证
 * 「已终局/已取消（可能刚被 erase-pii 擦过）的单"这条最重的约束在身份不匹配时也先说出来；
 * 反过来会让一个陌生登录用户看到"仅买家可提交"，误以为自己是当事人只是阶段不对。
 *
 * @param {object} order orders 行（需 status / refund_status / after_sale_status / updated_at）
 * @param {string} phase 见 EVIDENCE_PHASES
 * @param {'buyer'|'seller'} role 调用方已解析出的身份（不对时由本函数给出 403）
 * @param {{now?: number}} [opts] now = 判定时刻（毫秒；仅供边界测试注入，生产走 Date.now()）
 * @returns {null | { code: number, http: number, message: string }}
 *          `code`/`http` 直接喂给 `fail(res, message, code, http)`；身份不符是 403，其余是业务拒绝。
 */
export function evidencePhaseError(order, phase, role, { now = Date.now() } = {}) {
  const statusErr = evidenceStatusError(order);
  if (statusErr) return { code: 1, http: 200, message: statusErr };
  const p = String(phase || '');
  if (!EVIDENCE_PHASES.includes(p)) {
    return { code: 1, http: 200, message: `phase 需为 ${EVIDENCE_PHASES.join(' / ')}` };
  }
  const refundStatus = String(order?.refund_status || '');
  if (p === 'refund_request') {
    if (role !== 'buyer') return { code: 403, http: 403, message: '退款理由仅买家可提交' };
    if (refundStatus !== 'requested') {
      return {
        code: 1,
        http: 200,
        message: '仅当退款申请待卖家处理（refund_status=requested）时可提交退款理由——请先由买家在链上发起退款申请',
      };
    }
    return null;
  }
  if (p === 'refund_reply') {
    if (role !== 'seller') return { code: 403, http: 403, message: '退款回复仅店主可提交' };
    if (refundStatus !== 'requested') {
      return { code: 1, http: 200, message: '仅当存在待处理的退款申请时可回复（申请被拒/已退款后不再受理）' };
    }
    // 争议中（超时直争议可带 refundRequested 残留）无"拒绝/同意申请"语义，走仲裁，回复不再受理
    if (String(order?.status || '') === 'disputed') {
      return {
        code: 1,
        http: 200,
        message: '订单已进入争议（disputed），退款申请阶段结束——请在争议流程中提交仲裁陈述或链上和解退款',
      };
    }
    return null;
  }
  // arbitration：只在争议中受理（双方的仲裁陈述是裁决的主要依据）
  if (p === 'arbitration') {
    if (String(order?.status || '') !== 'disputed') {
      return { code: 1, http: 200, message: '仲裁陈述仅限争议中（disputed）订单提交' };
    }
    /*
      陈述时限（双方举证窗口，见 statementWindowOf 的说明）：**放在阶段语义之后判**——
      只有"确实处于争议中"的单才谈得上窗口；先判窗口会让一个非争议单收到
      "陈述时限已过"这种驴唇不对马嘴的拒因（它根本没有窗口）。
    */
    return statementGateError(order, p, now);
  }
  /*
    after_sale：确认收货后的**售后案件**陈述（买卖双方均可，各 20 条）。

    门控只有一个判据：**案件在途**（after_sale_status='open'，唯一实现在 afterSale.js）。
    刻意不加"双方各只能……"之类的附加条件：售后案件是"收到货才发现问题"的救济路径，
    买卖双方都要能把话说清（买家说明问题、卖家给出处理方案/反驳）。
    也刻意**不**复用 arbitration 的 disputed 判据：案件里的订单状态是终局，链上根本没有
    DisputeRequested —— 用 status 判就会把整条路径拒之门外。结案（closed）后立即停止受理，
    但历史陈述仍留在时间线上可溯（与退款阶段收口同口径）。
  */
  if (!isAfterSaleOpen(order)) {
    return {
      code: 1,
      http: 200,
      message: '售后陈述仅在售后案件在途时可提交——确认收货后由买家在链上 openAfterSale 开案，结案后不再受理',
    };
  }
  // 售后案件的陈述时限：锚点是链上开案时刻的本地镜像（after_sale_opened_at），见 statementWindowOf
  return statementGateError(order, p, now);
}

/** evidence 行附件摘要（时间线输出用，不含下载 URL） */
export function filesOfEvidence(evidenceId) {
  return getDb()
    .prepare('SELECT id, filename, mime, size, sha256, created_at FROM evidence_files WHERE evidence_id = ? ORDER BY id ASC')
    .all(evidenceId)
    .map((f) => ({ id: f.id, name: f.filename, mime: f.mime, size: f.size, sha256: f.sha256, createdAt: f.created_at }));
}

/**
 * 批量取多条陈述的附件元数据（**一次查询**）——订单详情时间线专用。
 * 原实现逐行调用 filesOfEvidence 是 N+1 次查询（一单 60 行陈述就是 60 次往返），
 * 而详情是公开只读接口里最热的读路径之一；这里按 evidence_id IN (...) 一次取回并按
 * 陈述 id 分组，返回 Map<evidenceId, files[]>（无附件的 id 也会在 Map 里给出空数组）。
 */
export function filesOfEvidenceMany(evidenceIds) {
  const ids = [...new Set((evidenceIds || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const marks = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT id, evidence_id, filename, mime, size, sha256, created_at FROM evidence_files
        WHERE evidence_id IN (${marks}) ORDER BY id ASC`
    )
    .all(...ids);
  for (const f of rows) {
    const list = out.get(f.evidence_id);
    if (list) list.push({ id: f.id, name: f.filename, mime: f.mime, size: f.size, sha256: f.sha256, createdAt: f.created_at });
  }
  return out;
}

/** 文件落盘绝对路径（供下载流读取；不存在返回 null） */
export function fileDiskPath(fileRow) {
  const p = path.join(orderAttachDir(fileRow.order_id), fileRow.stored_name);
  return fs.existsSync(p) ? p : null;
}

/** 按 id 读文件行（含 order/evidence 归属） */
export function findFileById(fileId) {
  return getDb()
    .prepare('SELECT * FROM evidence_files WHERE id = ?')
    .get(Number(fileId)) || null;
}

/** 删除订单附件目录（订单删除级联清理用；仅测试/运维调用） */
export function removeOrderAttachments(orderId) {
  const dir = orderAttachDir(orderId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
