/**
 * 审计里的「改前 / 改后」：**唯一**的比较、截断与形状实现。
 *
 * 为什么单独成模块（而不是在三个写入口各写一遍）：
 *  - 三个入口（product.update / shop.update / node.update）对"什么算变了"必须同一判据：
 *    对象键序不同、`0` 与 `false`、`undefined` 与 `null` 各写一遍就会漂移成
 *    "有的入口说没变、有的入口说变了"；
 *  - 审计是 append-only 的证据：值必须**有界**。商品描述/详情块可以是几千字，
 *    原样抄进去会让一行审计膨胀到不可读，也会把历史文本永久留在表里；
 *  - 值的形状要能被前端**按动作**翻译（金额/规格/标签），所以这里只负责
 *    "取哪些键、旧值是什么、新值是什么、超长怎么标"，不负责中文。
 *
 * 约定：
 *  - `changes` 只含**真的变了**的键（提交了但值没变的不算）；
 *  - 值按 `maxString` / `maxJson` 截断，截断后是 `{ $truncated: true, bytes, preview }`，
 *    前端据此显示"已截断"，而不是把截断后的 JSON 当成完整值；
 *  - 比较用 `stableAuditValue`：对象键排序后再序列化，避免"同一份值、键序不同"被当成变更。
 */

const DEFAULT_MAX_STRING = 500;
const DEFAULT_MAX_JSON = 4000;

/** 截断标记：前端识别它并显示"已截断"（见 frontend/src/utils/auditScope.ts） */
export const AUDIT_TRUNCATED = '$truncated';

/** 规范化：undefined/null 折成 null；对象键排序；数组逐项。 */
function normalize(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]);
    return out;
  }
  return value;
}

/** 比较用的规范字符串（键序无关） */
export function stableAuditValue(value) {
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return String(value);
  }
}

/** 两个值在审计口径下是否相同（undefined 与 null 视为相同） */
export function sameAuditValue(a, b) {
  return stableAuditValue(a) === stableAuditValue(b);
}

/**
 * 入库的值：字符串截断、结构化值超过 `maxJson` 时换成带预览的标记对象。
 * 读不到（undefined）写成 null，不写 `undefined`（JSON 列会丢掉这个键）。
 */
export function boundAuditValue(value, { maxString = DEFAULT_MAX_STRING, maxJson = DEFAULT_MAX_JSON } = {}) {
  const v = normalize(value);
  if (typeof v === 'string' && v.length > maxString) {
    return { [AUDIT_TRUNCATED]: true, bytes: v.length, preview: `${v.slice(0, maxString)}…` };
  }
  if (v && typeof v === 'object') {
    let text;
    try {
      text = JSON.stringify(v);
    } catch {
      return String(v);
    }
    if (text.length <= maxJson) return v;
    return { [AUDIT_TRUNCATED]: true, bytes: text.length, preview: `${text.slice(0, maxJson)}…` };
  }
  return v;
}

/**
 * 生成审计 detail 的 `{ fields, changes }`。
 *
 * @param {object} before 改前值（API 字段名 → 值）
 * @param {object} after  改后值（同一组字段名；通常就是校验后的 value）
 * @param {string[]} keys 要比较的字段（调用方只传请求体里出现的键）
 * @param {{maxString?:number,maxJson?:number,project?:Record<string,(v:unknown)=>unknown>}} [opts]
 *   `project[key]` 是**审计投影**：比较与入库都用投影后的值。用于去掉领域对象里的派生键
 *   （例如商品 attributes 的 `pair` 只服务多值索引，DTO/快照都刻意不带它）。
 */
export function auditChanges(before, after, keys, opts = {}) {
  const fields = [];
  const changes = {};
  const pick = (obj, key) => {
    const v = obj?.[key];
    const project = opts.project?.[key];
    return typeof project === 'function' ? project(v) : v;
  };
  for (const key of keys) {
    const from = pick(before, key);
    const to = pick(after, key);
    if (sameAuditValue(from, to)) continue;
    fields.push(key);
    changes[key] = { from: boundAuditValue(from, opts), to: boundAuditValue(to, opts) };
  }
  return { fields, changes };
}
