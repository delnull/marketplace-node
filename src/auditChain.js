/**
 * 管理审计哈希链（`audit_logs` 的防篡改层）：**写入时的链头口径与只读校验器共用本模块**。
 *
 * 为什么需要：`audit_logs` 原先就是一张普通表——任何拿到磁盘写权限的人（或一次"从旧备份恢复"）
 * 都能静默 `UPDATE`/`DELETE` 审计行，"谁在什么时候改了店铺设置/导出了什么"随即失去证据力。
 * 现在每行带 `prev_hash`（上一行的 `entry_hash`，链首为空串）与
 * `entry_hash = sha256(规范序列化(prev_hash, 本行))`：任何一列的**落库字节**被改动，
 * 该行重算出来的哈希就对不上。
 *
 * ── 规范序列化（为什么这么选）──
 *   载荷 = `JSON.stringify([prev_hash, id, at, actor, actor_role, action, target_type, target_id, detail, ip])`
 *   · 固定字段数组 + JSON 定界/转义：`detail` 是**可含任意分隔符的自由文本**（JSON 摘要），写成
 *     `字段 + '|' + 字段` 直接拼接就能构造出同一个字节串（字段边界不可验证，等于没绑上）；长度前缀
 *     能解决，但要自己再定一套编码/转义规则（多一份实现、多一处漂移）；`JSON.stringify` 对数组元素
 *     定界并转义，是标准库里的唯一实现，且序列化原文抄进报告能肉眼对比。
 *   · `prev_hash` 放在**同一个数组的第一位**，而不是 `prevHash + 序列化(...)` 的裸拼接：裸拼接下
 *     "前缀末尾"与"序列化开头"之间的边界同样不可验证。
 *   · `id` 计入哈希：行号也是"这一行是什么"的一部分——否则把某行内容原样搬到另一个 id 上、
 *     连哈希都不用重算（test/audit-chain.test.js 有用例钉着这条）。
 *   · NULL 与空串编码成不同字节（`null` vs `""`）：否则把某列的 NULL 改成 `''` 不改变哈希。
 *   · 字段顺序是**契约**：增删或换序会让全部历史行失效（与商品快照键序同理，见 §3.3）。
 *
 * ── 能查出什么 / 查不出什么（先写在最前面，免得把它当成"绝对防篡改"）──
 *   ✅ 改动任意列而不重算（`audit-hash-mismatch`）；删链首/中段任意一行、或插入一行假哈希
 *      （后继行的 `prev_hash` 接不上 → `audit-prev-hash-mismatch`）。
 *   ❌ ① **从被改那行起把后面所有行的哈希整体重算**：算法公开、不依赖任何密钥，能改库的人也能重算，
 *        链条本身拦不住（这是哈希链的固有边界，不是本实现的缺陷）；
 *      ② **截断尾部**：删掉最后 N 行，没有任何后继行会抱怨。
 *      这两条只能靠把**链头**留到盘外（另存一份 / 上链存证）兜底——所以 `verifyAuditChain` 把 `head`
 *      一并返回、CLI 也打印它，运维抄一份即得。此处刻意**不**在 kv 里再落一份"影子总账"：同一个库里的
 *      第二份副本，对"能改这个库的人"一样可改，换不到任何东西，只多一个真相来源。
 *   哈希用 sha256（`node:crypto`，零依赖）：这是本地证据链、不上链，与合约侧 keccak256 口径无关；
 *   输出小写 hex、不加 `0x` 前缀，便于 `sha256sum` 一类现成工具复核。
 *
 * ── 三态纪律（历史行不是篡改）──
 *   hashed   两列都非空 → 参与校验；
 *   unhashed `entry_hash` 为空 → 只提示"这些行早于哈希链、无法校验"，**不报成篡改**（升级前的历史行、
 *            或没有哈希能力的写入者留下的行都属于这一态）；
 *   broken   上面两类断裂。另有一种**半哈希行**（自己没哈希、却写着 `prev_hash`）按断裂报：正常的历史
 *            行两列都是空的，那种组合只可能来自"哈希被事后清掉"或"写到一半"，把它说成"早于哈希链"
 *            恰好会被用来掩盖痕迹。
 */
import { createHash } from 'node:crypto';
import { getDb } from './db.js';

/** 参与哈希的行字段（顺序即契约，勿改动） */
const HASH_FIELDS = ['id', 'at', 'actor', 'actor_role', 'action', 'target_type', 'target_id', 'detail', 'ip'];

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
const short = (h) => (h ? `${String(h).slice(0, 12)}…` : '（空）');

/** 行标识（只用于把断裂说清楚；action 是 'shop.update' 这类固定动作名，不含业务原文） */
const rowTag = (r) => `审计 #${r.id}（${String(r.action ?? '').slice(0, 60)}）`;

/** 规范序列化（唯一实现，本模块私有）：链头 + 本行 → 无歧义字节串 */
function auditPayload(prevHash, row) {
  const fields = HASH_FIELDS.map((f) => (row[f] == null ? null : String(row[f])));
  return JSON.stringify([prevHash == null ? null : String(prevHash), ...fields]);
}

/** 本行 entry_hash = sha256(prev_hash ‖ 规范序列化(本行))，小写 hex（64 字符） */
export function auditEntryHash(prevHash, row) {
  return createHash('sha256').update(auditPayload(prevHash, row), 'utf8').digest('hex');
}

/**
 * 链头 = **最后一行已哈希行**的 `entry_hash`；表里还没有已哈希行时返回空串（新链从空串起）。
 *
 * 写入（audit.js）与校验器共用这一条查询：口径只留一份，免得"写的时候跳过未哈希行、校验的时候
 * 不跳过"这类漂移把干净的链报成断裂。跳过未哈希行的理由：历史行落在链首之前，新行必须接在
 * **已哈希行**之后，否则它会把 `prev_hash` 写成空串、自称链首，反而被校验器报成断裂。
 * @param {import('node:sqlite').DatabaseSync} [db]
 * @returns {string}
 */
export function chainHead(db = getDb()) {
  const r = db
    .prepare(
      `SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL AND entry_hash != '' ORDER BY id DESC LIMIT 1`
    )
    .get();
  return r ? String(r.entry_hash) : '';
}

/**
 * 只读校验：按 id 升序重算整条链（**不改任何数据**——修复不该由脚本替人决定，理由同 integrity.js）。
 * @param {import('node:sqlite').DatabaseSync} [db]
 * @returns {{ok:boolean, entries:number, hashed:number, unhashed:Array<{id:number,at:number,action:string}>,
 *            unhashedCount:number, broken:Array<{id:number,kind:string,detail:string}>, head:string}}
 *   `ok` = 没有断裂（**未哈希行不影响 ok**：它们是三态里的另一态）；`entries` = 表内总行数（含未哈希）；
 *   `head` = 链头，供盘外锚点比对（尾部被整段删掉时只有它拦得住）。
 */
export function verifyAuditChain(db = getDb()) {
  const rows = db
    .prepare(
      `SELECT id, at, actor, actor_role, action, target_type, target_id, detail, ip, prev_hash, entry_hash
         FROM audit_logs ORDER BY id ASC`
    )
    .all();

  const broken = [];
  const unhashed = [];
  let unhashedCount = 0;
  let hashed = 0;
  let prevId = null; // 上一行**已哈希行**的 id（只为把断裂说清楚）
  let prev = ''; // 期望的链头
  let head = '';

  for (const r of rows) {
    const entry = r.entry_hash == null ? '' : String(r.entry_hash);
    const storedPrev = r.prev_hash == null ? '' : String(r.prev_hash);

    if (!entry) {
      if (storedPrev) {
        // 半哈希行：两列本该同生同灭，只有一边有值就是被清过/半写（见文件头三态说明）
        broken.push({
          id: r.id,
          kind: AUDIT_BROKEN_KINDS.missing,
          detail:
            `${rowTag(r)}写着 prev_hash=${short(storedPrev)} 却没有自己的 entry_hash——` +
            `"升级前的历史行"两列都是空的，这种半哈希行只可能来自哈希被事后清掉或写入中途失败，无法校验`,
        });
      } else {
        unhashedCount += 1;
        if (unhashed.length < UNHASHED_SAMPLE) unhashed.push({ id: r.id, at: r.at, action: r.action });
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
    // （级联噪声会把真正的现场淹掉）。单个改内容却不重算哈希的行，已经由它自己的 hash-mismatch 报出。
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

/** 把"接不上"的三种成因分开说：链首之前被删 / 本行自称链首（prev_hash 被清空）/ 中间被删·改·插 */
function prevMismatchDetail(r, storedPrev, prev, prevId) {
  if (prev === '') {
    return (
      `${rowTag(r)}写着 prev_hash=${short(storedPrev)}，但它前面已经没有任何已哈希的审计行——` +
      `链首之前的行被删掉了（或这些行被一起改写成了新链）`
    );
  }
  if (storedPrev === '') {
    return (
      `${rowTag(r)}自称链首（prev_hash 为空），但它前面还有已哈希行 #${prevId}——` +
      `#${prevId} 之后的行被删过，或本行的 prev_hash 被清空`
    );
  }
  return (
    `${rowTag(r)}写的 prev_hash=${short(storedPrev)} 与上一行已哈希行 #${prevId} 的 entry_hash=${short(prev)} ` +
    `接不上——这两行之间有审计行被删/被改/被插入过`
  );
}
