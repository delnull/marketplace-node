/**
 * 证据附件（P0-2）：图片/PDF 上传、鉴权下载、文件落盘与安全校验。
 *
 * 规则：
 *  - 白名单 image/png|jpeg|webp、application/pdf；**magic bytes 嗅探**（防改扩展名伪装）；
 *  - 单文件 ≤2MB；单条 evidence ≤6 个 / ≤20MB；单订单累计 ≤20MB；
 *  - 磁盘文件名 = uuid.安全扩展名（与原始文件名隔离，防路径穿越/编码诡计）；
 *  - sha256 存证；可见矩阵与 evidence 文本一致（buyer/owner；arbiter 仅 disputed **或有在途
 *    售后案件的终局单**——后者是契约 2026-10 第二批的裁决面，见 afterSale.js）；
 *  - 附件不可删除/修改（证据语义）；
 *  - **陈述时限**（`MK_DISPUTE_STATEMENT_DAYS`，默认 7 天，0 = 关闭）：争议与售后案件两个阶段的
 *    举证窗口，自"进入争议/案件开案"的**本地镜像时刻**起算，过期提交被拒（拒因可读）；
 *    判据与阶段/身份/条数同处 `evidencePhaseError`（唯一门控），订单 DTO 的倒计时字段
 *    `statementDeadlineAt` 走 `statementFieldsOf`（与门控同一份窗口计算）。
 *
 * ## 配额是**列上的计数器**，不是"插入前数一数"（2026-10 重设计）
 *
 * 两个层级各有一个计数器，**都由那一条 `UPDATE` 自己回答**"还能不能再收"：
 *   · 单条陈述：`dispute_evidence.file_count` / `file_bytes`，带
 *     `CHECK (file_count <= 6 AND file_bytes <= 20971520)`，谓词
 *     `WHERE file_count + n <= 6 AND file_bytes + b <= 20MB`；
 *   · 整张订单：`orders.evidence_bytes`（订单级累计 ≤20MB），谓词
 *     `WHERE evidence_bytes + b <= 20MB`。
 * `changes === 1` 才算占到位，越界在语句上失败，不依赖任何调用点记得先查一次。
 * 旧形状是"先 `SELECT COUNT(*)` / `SUM(size)`、再 INSERT"——两次读到的计数在并发下可以都通过，
 * 而超出的后果是附件总量无界（磁盘是节点最贵的那个失败面）。
 * 订单级那一层尤其不能靠"读一次 SUM"：库里没有全局写锁了（2026-10-16 删），两条并发陈述
 * 各自读到旧合计就都能落行（每条陈述上限 6 件 × 2MB，两条即可越过 20MB）。
 *
 * 代价如实写：计数器是**新增状态**，它必须与 `evidence_files` 的行数/字节数**同生同死**——
 * 所以加减只有一处实现：本文件（占位）与 `piiErase.js`（擦除时同事务清零），别处不得改这三列。
 *
 * ## 磁盘目录按**内部订单键**分（`orders.id`，即 `evidence_files.order_id`）
 *
 * 目录名就是 `evidence_files.order_id` 那个值：它是子表外键，文件行本来就有它，
 * 而下载/擦除都从文件行出发（`fileDiskPath` 一次 JOIN 都不用）。
 * 刻意**不**用对外单号 `order_no` 做目录键：同一个订单有两套表示（内部键/对外号）时，
 * 谁少写一次转换，谁就会在磁盘上多出一份"看不见、也删不掉"的个人数据。
 * 代价：内部键在重建库之后会变，历史附件目录因此属于"换库时的迁移面"（与库一起换）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, withTransaction } from './db.js';
import config from './config.js';
import { ACTIVE_STATUS } from './orderStatus.js';
// 字节判据的唯一实现（商品媒体与证据附件共用；本文件的 ALLOWED 只决定"允许收哪几种"）
import { sniffMediaMime } from './mediaKinds.js';
// 确认收货后的售后案件：在途判据的唯一实现（本文件的阶段门控与退货窗口、仲裁队列共用）
import { isAfterSaleOpen, hasAfterSaleHistory } from './afterSale.js';

export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB
export const MAX_FILES_PER_EVIDENCE = 6;
export const MAX_BYTES_PER_ORDER = 20 * 1024 * 1024; // 20MB
export const MAX_RAW_NAME = 120;

/**
 * 证据附件的**策略**：收哪些类型、各自落盘的扩展名。
 *
 * 字节层面的判据**不在这里**：`sniffMediaMime`（`shared/media.js`）是"这段字节到底是什么"
 * 的唯一实现，商品媒体与证据附件共用。本表只回答"证据附件允许收哪几种"——
 * 两张表曾各自维护一份魔数（改一处漏一处），现在只有策略是两套。
 * 注意它与商品媒体的策略**故意不同**：附件不收 gif（动图对举证没有价值、却更难核验），
 * 也不收任何视频（视频进主图区，不进举证附件）。
 */
const ALLOWED = {
  'image/png': { ext: 'png' },
  'image/jpeg': { ext: 'jpg' },
  'image/webp': { ext: 'webp' },
  'application/pdf': { ext: 'pdf' }, // %PDF
};
const MIME_ALIAS = { 'image/jpg': 'image/jpeg' };

/** 校验并规范化单个文件声明；返回 {ok, error?} */
export function validateFileMeta({ name, mime, size }) {
  const m = String(mime || '').toLowerCase();
  const normalized = MIME_ALIAS[m] || m;
  if (!ALLOWED[normalized]) return { error: `文件类型不支持（${m || '未知'}）：仅支持 png/jpeg/webp 图片与 pdf` };
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) {
    return { error: '单文件需 ≤ 2MB' };
  }
  // `filename VARCHAR(120)`：清洗后按列宽截断（原始名只用于展示，磁盘名是 uuid）
  const rawName = String(name || '').replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_').trim().slice(0, MAX_RAW_NAME);
  if (!rawName) return { error: '文件名无效' };
  return { ok: true, mime: normalized, ext: ALLOWED[normalized].ext, rawName };
}

/**
 * 附件落盘根目录（**唯一实现**；证据附件与商品媒体都从它派生，见 productMedia.uploadsDir）。
 *
 * 只有一个旋钮：`MK_ATTACH_DIR`（容器部署指向挂载卷，见 deploy/README.md）；未配置时回落到
 * **进程工作目录**下的 `attachments/`。
 *
 * 为什么不再"跟随数据库文件位置"（旧形状）：MySQL 没有库文件，`config.db.file` 已不存在——
 * 那条推导在证据附件这边会直接抛（`path.resolve(undefined)`），在商品媒体那边则静默回落成
 * `process.cwd()/uploads`。容器里 cwd = `/app`，于是店主上传的图片/视频落在**挂载卷之外**，
 * 下一次镜像更新全部消失，而部署文档承诺的是"在数据卷里"。同一件事曾经有两份推导，
 * 于是两边的坏法还不同（一边报错、一边静默丢数据）——现在只有这一处，两个目录同生同死。
 */
export function attachmentsRoot() {
  if (config.attachDir) return config.attachDir;
  return path.join(process.cwd(), 'attachments');
}

/**
 * 某订单的附件目录（**参数是内部订单键** `orders.id`，见文件头）。
 *
 * 空/0/undefined 一律**抛错**，不兜底成 `''`：那会让路径退化成附件**根目录**，
 * 而 `removeOrderAttachments` 对它执行的是 `rmSync(recursive)`——"根目录"在形状上
 * 不是任何一个订单的目录，所以它不该能被算出来（当前唯一调用点传的是自增主键，
 * 这条护栏是给下一个调用点用的：猜错一次就是整棵附件树）。
 *
 * @param {number|string} orderId **正整数**内部订单键（`orders.id`）；数字或数字字符串
 * @throws {TypeError} 不是正整数（0/负数/小数/空串/undefined/null/非数字字符串）
 */
export function orderAttachDir(orderId) {
  const key = (typeof orderId === 'number' || typeof orderId === 'string') && String(orderId).trim() !== ''
    ? Number(orderId)
    : NaN;
  if (!Number.isInteger(key) || key <= 0) {
    throw new TypeError(
      `orderAttachDir 需要内部订单键 orders.id（正整数），收到 ${JSON.stringify(orderId)}：` +
        '空/0 会算出附件根目录，removeOrderAttachments 会把整个附件根目录递归删掉'
    );
  }
  return path.join(attachmentsRoot(), String(key));
}

/**
 * 保存一批评审通过的文件（两阶段：先全量校验 meta+magic，再逐个落盘，最后**一个事务**写行；
 * 任一文件失败不产生任何残留——已写文件删除 + 已插入的 DB 行随事务回滚（防悬空记录
 * 永久占订单配额/下载 404））。
 *
 * **落盘必须在事务之外**（2026-10，MySQL 迁移）。MySQL 的事务绑定在一条连接上：
 * 把 `fs.writeFileSync` 放进事务区段，等于"持着那几行的锁等磁盘"——一次慢盘/大文件会把
 * 同一个订单/同一条陈述上的写请求一起堵住（没有全局写锁了，但长事务仍然会挡住别人）。
 * 旧实现（SQLite 单连接、同步执行）没有第二把锁可持，所以那时写盘与写行放在一起是免费的。
 *
 * 新顺序 = 先写盘 → 再开事务写行。不变式与代价如实写在这里：
 *   · 任何**抛错**路径（校验、写盘、INSERT、配额）都清掉已写文件，不留下半个批次；
 *   · **进程中断**（非异常路径：被 kill）可能留下孤儿文件——无害且是刻意的方向：
 *     配额按行计、下载按行定位，没有行就没人看得见这些文件；反过来"行在而文件不在"
 *     才会产生买家看得到的裂图（那由"先写盘后写行"杜绝）。
 *   · 代价：孤儿文件只能靠运维/目录清理兜底（`removeOrderAttachments` 是订单级删除入口）。
 *
 * ⚠️ 配额判据**只在这里**（两个层级的计数器，见文件头），路由不再自己数一遍：
 * 判据抄两份的必然结果是"一侧拒了、另一侧照收"（本仓已有的教训，见文件头）。
 *
 * 「这一条陈述属于这一张订单」是**数据形状**，不是调用方的纪律：参数收的是证据行本身，
 * 不是两个可以各自拼错的数字。旧签名 `{orderId, evidenceId}` 允许把 A 单的附件写进 B 单的
 * 陈述目录（两个 id 都合法、组合非法），而附件是**订单**的证据——挂错单等于把一方的材料
 * 交给另一单的当事人。现在 pair 只能来自同一行，错配在入口处就抛错（见下）。
 *
 * @param {{orderId: number|string, evidence: {id:number, order_id:number}, files: Array<{name:string,mime:string,dataB64:string}>}} args
 *        `orderId` = **内部订单键**（`orders.id`；`evidence_files.order_id` 是它的外键）；
 *        `evidence` = `dispute_evidence` 那一行（至少含 `id` 与 `order_id`）
 */
export async function storeFiles({ orderId, evidence, files }) {
  const db = getDb();
  const orderKey = Number(orderId);
  const evidenceKey = Number(evidence?.id);
  /**
   * 校验类失败（用户可自行修复：类型不符、魔数不符、配额已满），消息是**我们自己写的**、
   * 可以原样回给客户端。打上 `expose` 标记，让路由层能把它们与 fs/db 的原始异常区分开——
   * 后者（`ENOENT: … open '/srv/…'`）含服务器绝对路径，只进服务端日志，不回客户端。
   */
  const userError = (msg) => Object.assign(new Error(msg), { expose: true });
  /*
    **归属不变量**：附件目录键与文件行外键都是订单内部键，而陈述行来自另一张表。
    这里在碰磁盘之前把两者钉在一起；不合法就直接拒绝（`expose` ⇒ 路由可原样回给用户）。
  */
  if (!Number.isInteger(orderKey) || orderKey <= 0) throw userError('订单标识非法，无法保存附件');
  if (!Number.isInteger(evidenceKey) || evidenceKey <= 0) throw userError('证据记录不存在');
  if (Number(evidence?.order_id) !== orderKey) {
    throw userError('证据记录不属于该订单：附件只能追加到本单的陈述上');
  }
  // 阶段一：全量预检（meta + 魔数），失败即整体拒绝（此阶段不碰磁盘、不碰库）
  const prepared = files.map((f) => {
    const data = Buffer.from(f.dataB64, 'base64');
    const meta = validateFileMeta({ name: f.name, mime: f.mime, size: data.length });
    if (!meta.ok) throw userError(meta.error);
    if (sniffMediaMime(data) !== meta.mime) {
      throw userError(`文件「${meta.rawName}」内容与声明类型不符（魔数校验失败）`);
    }
    return { data, meta };
  });
  if (!prepared.length) throw userError('files 需为非空数组 [{name, mime, dataB64}]');

  const dir = orderAttachDir(orderKey);
  fs.mkdirSync(dir, { recursive: true });
  const created = [];
  const written = [];
  try {
    // 阶段二：逐个落盘（事务之外，见上方说明）；sha256 与磁盘名在这里定下来，供阶段三写行
    const staged = [];
    for (const { data, meta } of prepared) {
      const stored = `${crypto.randomUUID()}.${meta.ext}`;
      const disk = path.join(dir, stored);
      fs.writeFileSync(disk, data, { flag: 'wx' });
      written.push(disk);
      staged.push({ meta, stored, sha: crypto.createHash('sha256').update(data).digest('hex'), size: data.length });
    }
    /*
      阶段三：整批行**同一个事务**（进程中断也不留半批行——一个订单的附件要么全在要么全不在，
      配额与时间线的读数才自洽）。事务里只有两件事：占配额、写行，没有任何 I/O。
    */
    const addCount = staged.length;
    const addBytes = staged.reduce((a, s) => a + s.size, 0);
    await withTransaction(async () => {
      /*
        单条陈述的配额 = **条件 UPDATE**（见文件头）：`file_count/file_bytes` 是权威计数，
        越界时它命中 0 行。这里不看"当前是多少"，所以并发两次上传不可能同时通过。
      */
      const reserved = await db.run(
        `UPDATE dispute_evidence SET file_count = file_count + ?, file_bytes = file_bytes + ?
          WHERE id = ? AND file_count + ? <= ? AND file_bytes + ? <= ?`,
        addCount, addBytes, evidenceKey, addCount, MAX_FILES_PER_EVIDENCE, addBytes, MAX_BYTES_PER_ORDER
      );
      if (reserved.changes !== 1) {
        throw userError(
          `该陈述的附件配额已满（单条陈述至多 ${MAX_FILES_PER_EVIDENCE} 个、累计 ${Math.round(MAX_BYTES_PER_ORDER / 1024 / 1024)}MB）：` +
            '请先删除/压缩后重试，或把材料分成多条陈述提交'
        );
      }
      /*
        订单级累计上限 = **同一形状的第二个计数器**（`orders.evidence_bytes`）。
        为什么不能像旧实现那样在这里 `SUM(size)` 一次再插行：那是"先读计数再写入"，
        靠旧的全局写锁才成立——锁一删，两条并发陈述各读到旧合计就都能落行。
        现在越界在这条 UPDATE 自己身上失败（命中 0 行），与单条陈述那道闸同一个判据形状。
      */
      const orderRoom = await db.run(
        'UPDATE orders SET evidence_bytes = evidence_bytes + ? WHERE id = ? AND evidence_bytes + ? <= ?',
        addBytes, orderKey, addBytes, MAX_BYTES_PER_ORDER
      );
      if (orderRoom.changes !== 1) {
        throw userError(`该订单证据附件累计超过 ${Math.round(MAX_BYTES_PER_ORDER / 1024 / 1024)}MB 上限`);
      }
      for (const s of staged) {
        const r = await db.run(
          'INSERT INTO evidence_files (evidence_id, order_id, filename, stored_name, mime, size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)',
          evidenceKey, orderKey, s.meta.rawName, s.stored, s.meta.mime, s.size, s.sha
        );
        created.push({ id: r.insertId, name: s.meta.rawName, mime: s.meta.mime, size: s.size, sha256: s.sha });
      }
    });
  } catch (e) {
    // DB 行（与配额占位）随事务回滚；已写文件在这里手动清理（没有行指向它们，就是孤儿）
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

/**
 * 可受理售后/争议陈述的**订单状态**（唯一实现；`POST /:orderNo/evidence` 与附件上传共用）。
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
  /*
    ── 已擦除个人信息的单**不再接收**新的个人信息 ─────────────────
    擦除是数据主体的删除请求（手动端点或保留期扫描），而陈述正文与证据附件**本身就是个人信息**。
    旧实现只按状态判：`isAfterSaleOpen(order)` 一成立就受理，于是「已擦除 → 买家在售后窗口内
    再提交陈述与附件」会把刚删掉的东西**重新写回同一张单**；而保留期扫描又为在途售后案件让路
    （见 afterSaleSql.js 的 AFTER_SALE_NOT_OPEN_SQL），新写入的个人信息因此可能长期留存——
    "删了又收"让删除请求形同虚设，且每一个入口都得各自记得这件事。
    判据放在**唯一的阶段门**（本函数）：陈述提交与附件上传共用它，所以两处一起关门。
    为什么是"拒绝"而不是"收下再擦"：擦除之后本地没有可核对的收货信息/联系方式，
    收下的陈述无法被送达对方，只会变成一份谁也用不上的个人数据。

    ⚠️ 判据是 `pii_erased_at IS NOT NULL`（`DATETIME(3)` 列）：旧形状拿它当毫秒整数比大小
    （`Number(x) > 0`），换成 `Date` 之后那种写法会退化成"任何日期都 > 0"——恰好仍然是对的，
    但读的人再也看不出它其实是个 NULL 判据。三态写清楚：NULL = 从未擦过（正常单），
    非 NULL = 已擦（不再收新的个人数据）。
  */
  if (order?.pii_erased_at !== null && order?.pii_erased_at !== undefined) {
    return (
      '该订单的个人信息已按删除请求擦除（陈述正文与证据附件本身即个人信息），不再受理新的售后陈述与附件——' +
      '如仍需主张权利，请走链上仲裁或线下渠道；需要在本店留痕请另开一张订单'
    );
  }
  if (isAfterSaleOpen(order)) return null; // 在途售后案件：终局单也受理（见上方说明）
  if (EVIDENCE_OPEN_STATUS.includes(status)) return null;
  /*
    终局单里再分一句：**开过案但已结案**的单，拒它的理由是"案件已结案"，
    而不是含糊的"状态不接受陈述"——当事人点提交时最需要知道的就是这一点。
    结案是终态（合约 afterSaleClosedAtBlock 不可清除），不能重新开案；仍可走链下协商。
  */
  if (hasAfterSaleHistory(order)) {
    return (
      `该订单的售后案件已结案（after_sale_status=${String(order?.after_sale_status)}），不再受理新的售后陈述——` +
      '结案后不能重新开案；如仍有争议请走线下渠道或另开一张订单'
    );
  }
  return (
    `订单当前状态不接受新的售后陈述（当前 ${status || '未知'}；仅 ${EVIDENCE_OPEN_STATUS.join(' / ')} 受理，` +
    '或有在途售后案件的终局单）——' +
    '售后陈述与证据附件只对在途订单与在途售后案件开放：草稿请先在链上完成托管，已终局/已取消的订单请通过链上仲裁或线下渠道处理'
  );
}

/**
 * 售后/争议陈述的四个阶段（与 `dispute_evidence.phase` 的 ENUM 同值；唯一实现，见 evidencePhaseError）：
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
 * 条数上限"是同一道闸的四段，而这道闸有**两个写入端点**（`POST /:orderNo/evidence` 提交陈述、
 * `POST /:orderNo/evidence/:evidenceId/files` 追加附件）。判据一旦在路由里各写一遍，必然漂移，
 * 而漂移的后果不是文案不一致，是**一侧拒了、另一侧照收**：举证期过后还能往单上追加 20MB 个人数据，
 * 仲裁人看到的证据面就与"过期视为放弃举证"这条规则矛盾。所以窗口判定与 phase/身份判定同处一函数，
 * 两个端点只能拿到同一个结论。
 *
 * 锚点取**本地已镜像的链上时刻**，刻意不另算一套：
 *  - `arbitration` = `updated_at`（watcher 回写 disputed 的那一刻；仲裁队列的 `disputedAt`
 *    就是这一列，两处口径必须一致，否则"队列里显示等了多久"与"还能不能提交"会各说一套）；
 *  - `after_sale`  = `after_sale_opened_at`（链上 AfterSaleOpened 的落库时刻）。
 *    刻意不用 `updated_at`：案件**不动**订单状态、也不动 updated_at（见 src/afterSale.js 文件头）。
 * 两列都是 `DATETIME(3)` → 驱动给 `Date`；本模块只做"两个时刻之间隔了多久"的算术。
 *
 * 已知代价（如实写）：锚点是**落库时刻**而非链上区块时刻，watcher 轮询有间隔（默认 15s）+
 * 确认深度（默认 12 块），所以窗口起点比链上真实时刻晚若干秒；争议期间任何对订单的镜像写入
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
 * 时刻一律 `Date`（`openedAt` / `deadlineAt`），`remainingMs` 是**时长**（毫秒数）——
 * 两者刻意分开：时长永远不该被当成时间戳去序列化（那正是本仓旧形状的毛病）。
 *
 * @param {object} order v_orders 行（需 `updated_at` 或 `after_sale_opened_at`，以及 after_sale_status）
 * @param {'arbitration'|'after_sale'} phase
 * @param {number} now 判定时刻（**毫秒数**；可注入，便于边界测试——这是纯算术，不进 SQL）
 * @returns {null | {phase: string, days: number, openedAt: Date, deadlineAt: Date, remainingMs: number, expired: boolean}}
 */
export function statementWindowOf(order, phase, now = Date.now()) {
  const days = statementDays();
  if (!days) return null; // 关闭：不限时
  const col = STATEMENT_PHASE_ANCHOR[phase];
  if (!col) return null; // 该阶段不设窗口（退款申请/回复两阶段）
  const anchor = order?.[col];
  const openedAt = anchor instanceof Date ? anchor : null;
  if (!openedAt) return null; // 锚点读不到：不假装"已过期"
  const deadlineAt = new Date(openedAt.getTime() + days * DAY_MS);
  const expired = now > deadlineAt.getTime(); // 边界：恰好到点仍算"未过"（"N 天内可提交"含第 N 天末尾）
  return { phase, days, openedAt, deadlineAt, remainingMs: expired ? 0 : deadlineAt.getTime() - now, expired };
}

/** 陈述时限已过的拒因（**唯一措辞**：门控与附件端点逐字共用；可读、说清起算点与后果） */
function statementExpiredMessage(phase, win) {
  const d = win.deadlineAt;
  const p = (n) => String(n).padStart(2, '0');
  // 展示用本地时刻（运维/当事人看的是自己的钟）；库里与接口上的那份仍是 UTC 的 `Date`
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
 * 形状：`statementDeadlineAt: Date | null`——**举证截止时刻**，**null = 未开启该规则**
 * （`MK_DISPUTE_STATEMENT_DAYS=0` 关闭 / 该单此刻没有争议也没有在途案件 / 锚点读不到）。
 * 对外 JSON 由 `Date.prototype.toJSON()` 给出 ISO-8601（与全仓时间口径一致）。
 * 契约的另一端是前端的 `Order.statementDeadlineAt` 与举证倒计时门，那边按同样的口径判
 * "未开启 / 期内 / 已过期"（**前端同批改**：旧契约给的是毫秒整数）。
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
 * `POST /:orderNo/evidence`（提交陈述）与 `POST /:orderNo/evidence/:evidenceId/files`（追加附件）——
 * 而两处的**文案已经漂移**（一处写"订单已进入争议（disputed），退款申请阶段结束"，
 * 另一处多一句"请在争议流程中提交仲裁陈述或链上和解退款"），语义也出现了细微偏差
 * （附件那侧把"未知阶段"落进 arbitration 分支）。附件与陈述是同一份证据的两个部分，
 * 门控漂移的后果是一侧拒了、另一侧照收：往一个已经不允许陈述的单上追加 20MB 个人数据。
 *
 * 顺序**刻意**是「状态 → 身份 → 阶段」（与旧实现一致）：先判状态才能保证
 * 「已终局/已取消（可能刚被 erase-pii 擦过）的单"这条最重的约束在身份不匹配时也先说出来；
 * 反过来会让一个陌生登录用户看到"仅买家可提交"，误以为自己是当事人只是阶段不对。
 *
 * @param {object} order v_orders 行（需 status / refund_status / after_sale_status / updated_at / pii_erased_at）
 * @param {string} phase 见 EVIDENCE_PHASES
 * @param {'buyer'|'seller'} role 调用方已解析出的身份（不对时由本函数给出 403）
 * @param {{now?: number}} [opts] now = 判定时刻（毫秒数；仅供边界测试注入，生产走 Date.now()）
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
export async function filesOfEvidence(evidenceId) {
  return (await getDb().all('SELECT id, filename, mime, size, sha256, created_at FROM evidence_files WHERE evidence_id = ? ORDER BY id ASC', Number(evidenceId)))
    .map((f) => ({ id: f.id, name: f.filename, mime: f.mime, size: f.size, sha256: f.sha256, createdAt: f.created_at }));
}

/**
 * 批量取多条陈述的附件元数据（**一次查询**）——订单详情时间线专用。
 * 原实现逐行调用 filesOfEvidence 是 N+1 次查询（一单 60 行陈述就是 60 次往返），
 * 而详情是公开只读接口里最热的读路径之一；这里按 evidence_id IN (...) 一次取回并按
 * 陈述 id 分组，返回 Map<evidenceId, files[]>（无附件的 id 也会在 Map 里给出空数组）。
 */
export async function filesOfEvidenceMany(evidenceIds) {
  const ids = [...new Set((evidenceIds || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const marks = ids.map(() => '?').join(',');
  const rows = await getDb().all(`SELECT id, evidence_id, filename, mime, size, sha256, created_at FROM evidence_files
        WHERE evidence_id IN (${marks}) ORDER BY id ASC`, ...ids);
  for (const f of rows) {
    const list = out.get(f.evidence_id);
    if (list) list.push({ id: f.id, name: f.filename, mime: f.mime, size: f.size, sha256: f.sha256, createdAt: f.created_at });
  }
  return out;
}

/**
 * 文件落盘绝对路径（供下载流读取；不存在返回 null）。
 * `fileRow.order_id` 就是目录键（**内部订单键**，见文件头）——不需要任何 JOIN 或换算。
 */
export function fileDiskPath(fileRow) {
  const p = path.join(orderAttachDir(fileRow.order_id), fileRow.stored_name);
  return fs.existsSync(p) ? p : null;
}

/** 按 id 读文件行（含 order/evidence 归属） */
export async function findFileById(fileId) {
  return await getDb().get('SELECT * FROM evidence_files WHERE id = ?', Number(fileId)) || null;
}

/**
 * 删除订单附件目录（订单级清理入口：擦除流程与运维/测试调用）。
 * 订单键非法时由 `orderAttachDir` 抛错——**不会**退化成删除附件根目录。
 * @param {number|string} orderId **内部订单键**（`orders.id`，正整数），与 `evidence_files.order_id` 同值
 */
export function removeOrderAttachments(orderId) {
  const dir = orderAttachDir(orderId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
