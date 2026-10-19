/**
 * 管理审计哈希链（`audit_logs` 的防篡改层）：**写入时的链头口径与只读校验器共用本模块**。
 *
 * 为什么需要：`audit_logs` 原先就是一张普通表——任何拿到磁盘写权限的人（或一次"从旧备份恢复"）
 * 都能静默 `UPDATE`/`DELETE` 审计行，"谁在什么时候改了店铺设置/导出了什么"随即失去证据力。
 * 现在每行带 `prev_hash`（上一行的 `entry_hash`，**链首为 NULL**）与
 * `entry_hash = sha256(规范序列化(prev_hash, 本行))`：任何一列的**落库字节**被改动，
 * 该行重算出来的哈希就对不上。
 *
 * **分叉在落库那一步就写不进去**：表上有一列生成列 `head_slot = IFNULL(prev_hash,'')`，其上是
 * UNIQUE（`uq_audit_head`）。为什么不是直接对 `prev_hash` 建唯一索引（实测踩到）：MySQL 的
 * 唯一索引**不约束 NULL**，而链首的前驱恰恰就是 NULL ⇒ 多个写者可以同时插入多行"链首"，
 * 也就是多条互不相接的链——分叉保护反而在最该生效的第一行失效。折成常量之后，
 * "没有前驱的行"全表至多一行，非空前驱各自唯一。
 * 代价（写在 audit.js 那边）：新行的 `prev_hash` 必须在 **INSERT 时**给出，不能"先插 NULL 再补"。
 *
 * ── 规范序列化（为什么这么选）──
 *   载荷 = `JSON.stringify([prev_hash, id, at, actor, actor_role, shop_code, action, target_type, target_id, detail, ip])`
 *   · 固定字段数组 + JSON 定界/转义：`detail` 是**可含任意分隔符的自由文本**（JSON 摘要），写成
 *     `字段 + '|' + 字段` 直接拼接就能构造出同一个字节串（字段边界不可验证，等于没绑上）；长度前缀
 *     能解决，但要自己再定一套编码/转义规则（多一份实现、多一处漂移）；`JSON.stringify` 对数组元素
 *     定界并转义，是标准库里的唯一实现，且序列化原文抄进报告能肉眼对比。
 *   · `prev_hash` 放在**同一个数组的第一位**，而不是 `prevHash + 序列化(...)` 的裸拼接：裸拼接下
 *     "前缀末尾"与"序列化开头"之间的边界同样不可验证。
 *   · `id` 计入哈希：行号也是"这一行是什么"的一部分——否则把某行内容原样搬到另一个 id 上、
 *     连哈希都不用重算（test/audit-chain.test.js 有用例钉着这条）。
 *   · `shop_code` 计入哈希（2026-10-16 加店铺维度时一并加的）：归属**决定这一行谁能看见**，
 *     所以它必须被证据层覆盖——否则把某行改判给另一家店、连哈希都不用重算，
 *     而症状恰好是"这家店的审计里出现了一条不属于它的行 / 一条行从它的审计里消失"。
 *     它是 `NULL`（节点级）还是 9 位编号，由 canonicalField 编成两种不同的字节（见下）。
 *   · NULL 与空串编码成不同字节（`null` vs `""`）：否则把某列的 NULL 改成 `''` 不改变哈希。
 *   · 字段顺序是**契约**：增删或换序会让全部历史行失效（与商品快照键序同理，见 §3.3）。
 *
 * ── 值的规范形（列类型跟着重设计改了，序列化规则没变）──
 * 被哈希的是**从库里读回来的那一行**，而每个字段的 JS 类型是驱动给的，所以每个类型都要有
 * 一个**确定的**文本形（两边各算一次必须得到同一串，否则校验器会把干净的链报成断裂）：
 *   · `DATETIME(3)` → `Date` → `toISOString()`：毫秒精度与列精度同为 3 位，往返无损；
 *   · `JSON` 列（`detail`）→ 驱动直接解出的**对象** → `JSON.stringify(对象)`。
 *     MySQL 存 JSON 时会规范化（键序、空白），而读回来的一定是那份规范化后的字节，
 *     所以"对象 → stringify"是一条**确定**的映射：写入侧与校验侧读的是同一行、同一份文本。
 *     旧实现写 `String(row.detail)`，那在 `detail` 是 TEXT 的年代是对的；换成 JSON 列之后
 *     它会给每个对象都算出同一个 `[object Object]`——哈希就再也绑不住摘要内容了。
 *   · 其余（CHAR/VARCHAR/ENUM/BIGINT）→ `String(v)`（与旧实现逐字一致）。
 *
 * ── 能查出什么 / 查不出什么（先写在最前面，免得把它当成"绝对防篡改"）──
 *   ✅ 改动任意列而不重算（`audit-hash-mismatch`）；删链首/中段任意一行、或插入一行假哈希
 *      （后继行的 `prev_hash` 接不上 → `audit-prev-hash-mismatch`）；**写入分叉**由
 *      `uq_audit_head`（`IFNULL(prev_hash,'')` 上的唯一索引）直接拒绝——同一个前驱只能被一行指认，
 *      且"自称链首"的行全表至多一行。
 *   ❌ ① **从被改那行起把后面所有行的哈希整体重算**：算法公开、不依赖任何密钥，能改库的人也能重算，
 *        链条本身拦不住（这是哈希链的固有边界，不是本实现的缺陷）；
 *      ② **截断尾部**：删掉最后 N 行，没有任何后继行会抱怨。
 *      这两条只能靠把**链头**留到盘外（另存一份 / 上链存证）兜底——所以 `verifyAuditChain` 把 `head`
 *      一并返回、CLI 也打印它，运维抄一份即得。此处刻意**不**在库里再落一份"影子总账"：
 *      同一个库里的第二份副本，对"能改这个库的人"一样可改，换不到任何东西，只多一个真相来源
 *      （旧实现在 kv 里存过一份的念头，`kv` 表已随重设计删除，这个念头也就不必再否一次）。
 *   哈希用 sha256（`node:crypto`，零依赖）：这是本地证据链、不上链，与合约侧 keccak256 口径无关；
 *   输出小写 hex、不加 `0x` 前缀，便于 `sha256sum` 一类现成工具复核。
 *
 * ── 三态纪律（历史行不是篡改）──
 *   hashed   `entry_hash` 非空 → 参与校验（链首那行的 `prev_hash` 是 NULL，不是空串）；
 *   unhashed `entry_hash` **与** `prev_hash` 都是 NULL → 只提示"这些行早于哈希链、无法校验"，
 *            **不报成篡改**（升级前的历史行、或没有哈希能力的写入者留下的行都属于这一态）；
 *   broken   上面两类断裂。另有一种**半哈希行**（自己没哈希、却写着 `prev_hash`）按断裂报：正常的历史
 *            行两列都是 NULL，那种组合只可能来自"哈希被事后清掉"或"写到一半"，把它说成"早于哈希链"
 *            恰好会被用来掩盖痕迹。
 */
import { createHash } from 'node:crypto';
import { getDb } from './db.js';

/** 参与哈希的行字段（顺序即契约，勿改动） */
const HASH_FIELDS = ['id', 'at', 'actor', 'actor_role', 'shop_code', 'action', 'target_type', 'target_id', 'detail', 'ip'];

/**
 * 未哈希行在报告里最多列这么多条：历史行可能有成千上万条，报告不该被它们淹没，
 * 总数另给 `unhashedCount`（CLI 也照它打印）。
 */
const UNHASHED_SAMPLE = 20;

/** 三种断裂形状——同时也是 `findIntegrityIssues` 用的 issue kind（两处各起一套名字迟早漂移） */
export const AUDIT_BROKEN_KINDS = {
  hash: 'audit-hash-mismatch', // 落库内容与 entry_hash 对不上（字段被改过）
  prev: 'audit-prev-hash-mismatch', // prev_hash 接不上前一行（被删/被插/被改过链）
  missing: 'audit-entry-hash-missing', // 半哈希行：写着 prev_hash 却没有自己的哈希
};

/** 报告里只留哈希前 12 位：够定位、不够当凭据用（与 integrity.js 打码码原文同思路） */
const short = (h) => (h ? `${String(h).slice(0, 12)}…` : '（NULL）');

/** 行标识（只用于把断裂说清楚；action 是 'shop.update' 这类固定动作名，不含业务原文） */
const rowTag = (r) => `审计 #${r.id}（${String(r.action ?? '').slice(0, 60)}）`;

/**
 * 单个字段 → 规范文本（**唯一实现**，见文件头"值的规范形"）。
 * `undefined` 与 `null` 都编码成 JSON 的 `null`：读不到与没有是同一件事（列里只有 NULL）。
 */
function canonicalField(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 规范序列化（唯一实现，本模块私有）：链头 + 本行 → 无歧义字节串 */
function auditPayload(prevHash, row) {
  const head = prevHash === null || prevHash === undefined ? null : String(prevHash);
  return JSON.stringify([head, ...HASH_FIELDS.map((f) => canonicalField(row[f]))]);
}

/** 本行 entry_hash = sha256(规范序列化(prev_hash, 本行))，小写 hex（64 字符） */
export function auditEntryHash(prevHash, row) {
  return createHash('sha256').update(auditPayload(prevHash, row), 'utf8').digest('hex');
}

/**
 * 链头 = **最后一行已哈希行**的 `entry_hash`；表里还没有已哈希行时返回 `null`（新链从 NULL 起）。
 *
 * 写入（audit.js）与校验器共用这一条查询：口径只留一份，免得"写的时候跳过未哈希行、校验的时候
 * 不跳过"这类漂移把干净的链报成断裂。跳过未哈希行的理由：历史行落在链首之前，新行必须接在
 * **已哈希行**之后，否则它会把 `prev_hash` 写成 NULL、自称链首，反而被校验器报成断裂。
 *
 * 返回 `null` 而不是空串（2026-10-16）：`prev_hash` / `entry_hash` 都是 `CHAR(64) NULL`，
 * 而 **NULL 才是"链首"**——旧形状用空串表达同一件事，于是"被清空"与"本来就是链首"在库里同形
 * （而校验器必须把前者报成断裂）。NULL 让这两态在**列类型**层面就分开。
 * @param {{get: (sql: string, ...params: any[]) => Promise<any>}} [db] 查询门面（默认 `getDb()`；写入侧传当前事务那条连接，见 audit.js）
 * @returns {Promise<string|null>}
 */
export async function chainHead(db = getDb()) {
  const r = await db.get('SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1');
  return r ? String(r.entry_hash) : null;
}

/**
 * 只读校验：按 id 升序重算整条链（**不改任何数据**——修复不该由脚本替人决定，理由同 integrity.js）。
 * @param {{all: (sql: string, ...params: any[]) => Promise<any[]>}} [db] 查询门面（默认 `getDb()`）
 * @returns {Promise<{ok:boolean, entries:number, hashed:number, unhashed:Array<{id:number,at:Date|null,action:string}>,
 *            unhashedCount:number, broken:Array<{id:number,kind:string,detail:string}>, head:string|null}}
 *   `ok` = 没有断裂（**未哈希行不影响 ok**：它们是三态里的另一态）；`entries` = 表内总行数（含未哈希）；
 *   `head` = 链头（`null` = 表里还没有已哈希行），供盘外锚点比对（尾部被整段删掉时只有它拦得住）。
 */
export async function verifyAuditChain(db = getDb()) {
  /*
    列清单是**显式**的（不是 SELECT *）：这里漏一列 ⇒ 该列读成 undefined ⇒ canonicalField 编成 null
    ⇒ 凡是在这一列上有值的行全部被报成 audit-hash-mismatch（假警报）。2026-10-16 加 shop_code 时
    实测踩到过一次：节点级行（shop_code 本来就是 NULL）照样过，店铺行全报断裂——
    所以**凡参与哈希的列都必须出现在这条 SELECT 里**，HASH_FIELDS 与它是同一个契约的两半。
  */
  const rows = await db.all(`SELECT id, at, actor, actor_role, shop_code, action, target_type, target_id, detail, ip, prev_hash, entry_hash
         FROM audit_logs ORDER BY id ASC`);

  const broken = [];
  const unhashed = [];
  let unhashedCount = 0;
  let hashed = 0;
  let prevId = null; // 上一行**已哈希行**的 id（只为把断裂说清楚）
  let prev = null; // 期望的链头（null = 链首之前）
  let head = null;

  for (const r of rows) {
    const entry = r.entry_hash == null ? null : String(r.entry_hash);
    const storedPrev = r.prev_hash == null ? null : String(r.prev_hash);

    if (entry === null) {
      if (storedPrev !== null) {
        // 半哈希行：两列本该同生同灭，只有一边有值就是被清过/半写（见文件头三态说明）
        broken.push({
          id: r.id,
          kind: AUDIT_BROKEN_KINDS.missing,
          detail:
            `${rowTag(r)}写着 prev_hash=${short(storedPrev)} 却没有自己的 entry_hash——` +
            `"升级前的历史行"两列都是 NULL，这种半哈希行只可能来自哈希被事后清掉或写入中途失败，无法校验`,
        });
      } else {
        unhashedCount += 1;
        if (unhashed.length < UNHASHED_SAMPLE) unhashed.push({ id: r.id, at: r.at ?? null, action: r.action });
      }
      continue;
    }

    hashed += 1;

    if (storedPrev !== prev) {
      broken.push({ id: r.id, kind: AUDIT_BROKEN_KINDS.prev, detail: prevMismatchDetail(r, storedPrev, prev, prevId) });
    }
    // 本行自身完整性：用**它自己写着的** prev_hash 重算，免得"prev_hash 被改"把两件事混成一件
    const expected = auditEntryHash(storedPrev, r);
    if (expected !== entry) {
      broken.push({
        id: r.id,
        kind: AUDIT_BROKEN_KINDS.hash,
        detail:
          `${rowTag(r)}的落库内容与 entry_hash 对不上（重算 ${short(expected)} ≠ 存储 ${short(entry)}）` +
          `——该行的字段被事后改过（或哈希本身是伪造的）`,
      });
    }

    // 链头一律推进到**本行存着的** entry_hash：一行被改只报它自己，不会顺着链把后面每一行都报一遍
    //（级联噪声会把真正的现场淹掉）。单个改内容却不重算哈希的行，已经由它自己的 hash-mismatch 报出。
    prev = entry;
    head = entry;
    prevId = r.id;
  }

  return {
    ok: broken.length === 0,
    entries: rows.length,
    hashed,
    unhashed,
    unhashedCount,
    broken,
    head,
  };
}

/** 把"接不上"的三种成因分开说：链首之前被删 / 本行自称链首（prev_hash 被清成 NULL）/ 中间被删·改·插 */
function prevMismatchDetail(r, storedPrev, prev, prevId) {
  if (prev === null) {
    return (
      `${rowTag(r)}写着 prev_hash=${short(storedPrev)}，但它前面已经没有任何已哈希的审计行——` +
      `链首之前的行被删掉了（或这些行被一起改写成了新链）`
    );
  }
  if (storedPrev === null) {
    return (
      `${rowTag(r)}自称链首（prev_hash 为 NULL），但它前面还有已哈希行 #${prevId}——` +
      `#${prevId} 之后的行被删过，或本行的 prev_hash 被清空`
    );
  }
  return (
    `${rowTag(r)}写的 prev_hash=${short(storedPrev)} 与上一行已哈希行 #${prevId} 的 entry_hash=${short(prev)} ` +
    `接不上——这两行之间有审计行被删/被改/被插入过`
  );
}
