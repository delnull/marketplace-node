/**
 * 编号编解码内核（Crockford Base32 数据位 + 2 位加权校验）——**校验算法的唯一实现**，
 * node / 前端 / 脚本共用（零依赖）。
 *
 * 形状：`dataLen` 位数据 + 2 位校验 = `dataLen + 2` 位，全部取自同一套 Crockford 字母表。
 * 校验：**加权和原样保存** `S = Σ 值(data[i])×(i+1)`（位权 1..dataLen），
 *       写成 `ALPHABET[S>>5] + ALPHABET[S&31]`——**不取模**。
 *
 * 为什么不取模：取模就得保证模数是素数（32 不是素数，单字符差会被 32 模掉）；而两位
 * base32 有 1024 个值，7 位数据的加权和上界是 31×(1+…+7) = 868 < 1024，整个 S 装得下
 * ⇒ 校验值可以原样保存，不需要素域，校验位与数据位因此共用同一套字母表（编号里不会
 * 出现字母表之外的字符）。6 位数据上界 651，同样装得下。
 * dataLen ≥ 8 时上界 31×n(n+1)/2 ≥ 1024，两位装不下 ⇒ 读入口 `isCodeShape`/`verifyCode`
 * 由 `assertDataLen` 拒绝；编码路径 `encodeFromData` 不猜数据长度，只按容器长度调用
 * `checkChars`，长度由各格式模块钉死 6 / 7 位。`checkChars` 自己的判据只有“字符合法 + S<1024”，
 * 不负责长度——所以它不会替调用方拒绝 8 位数据。
 *
 * 检错保证（对齐"抄错一位落到另一家真店"这个事故模型）：
 *   · 任意**单字符**错（含两位校验位）：ΔS = 位权×差值 ≠ 0，而 S 是精确值 ⇒ 必被检出；
 *   · 任意两个**数据位**互换且值不同：ΔS = (位权差)×(值差) ≠ 0 ⇒ 必被检出
 *     （值相同则编号根本没变，不是错误）；
 *   · 两位校验位互换也检出（`32c₁+c₂ = 32c₂+c₁` 只在 c₁ = c₂ 时成立）。
 *   两个及以上错误的加权差若正好抵消（如权重 1 位 +7、权重 7 位 −1）则检不出——这是
 *   加权和的固有边界，只保证单字符与换位。
 *
 * 形状（长度 + 字符集）与校验位是**两层判据**：`isCodeShape` 只回答第一层，`verifyCode`
 * 回答完整的两层。读入口的输入形状失败只返回 null / false，**不抛错**；`dataLen` 是各
 * 格式模块自己的常量（本仓只有 6 / 7），传错是编程错误，当场抛 TypeError。
 */

/** Crockford Base32 数据字母表（无 I/L/O/U，避免 1/I、0/O 抄错） */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 校验位固定两位：10 bit 装下 6/7 位数据的整个加权和（见文件头） */
export const CHECK_LEN = 2;

/** 加权和能原样写成两位 base32 的数据位数上限：31×n(n+1)/2 < 1024 ⇒ n ≤ 7 */
const MAX_DATA_LEN = 7;

/** 字符 → 值（0..31）；非法返回 -1（含空串/多字符/非字符串） */
export function codeCharValue(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return -1;
  return ALPHABET.indexOf(ch);
}

/** 输入归一化：只认字符串（trim + 大写）；非字符串返回空串（避开 `String(无原型对象)` 这类抛错路径） */
export function normalize(v) {
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

/** dataLen 是调用方常量；传错是编程错误（不是某个外部输入"形状不对"） */
function assertDataLen(dataLen) {
  if (!Number.isInteger(dataLen) || dataLen < 1 || dataLen > MAX_DATA_LEN) {
    throw new TypeError(`数据位长度必须是 1..${MAX_DATA_LEN} 的整数：${dataLen}`);
  }
}

/**
 * 数据位 → 两位校验位：`Σ 值×位权(1..dataLen)` 原样写成两位 base32（不取模）。
 * 只接受**已归一化**的数据位（大写、Crockford）；非法字符或 S ≥ 1024 抛错——
 * 这是编码路径的编程错误，读入口不会走到这里（`verifyCode` 先判形状）。
 */
export function checkChars(data) {
  if (typeof data !== 'string') throw new TypeError('数据位必须是字符串');
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const n = codeCharValue(data[i]);
    if (n < 0) throw new Error(`非法数据字符：${data[i]}`);
    sum += n * (i + 1); // 位权 1..dataLen：让"换位"也能被检出（见文件头）
  }
  if (sum >= 1024) throw new Error(`加权和 ${sum} 超出两位 base32 的取值范围（必须 < 1024）`);
  return ALPHABET[sum >> 5] + ALPHABET[sum & 31];
}

/**
 * 数据位 + 校验位，长度由 `data.length` 决定（各格式模块负责钉死 6 / 7 位）。
 * 数据位先归一化（trim + 大写），与 `verifyCode` 共用同一个归一化。
 */
export function encodeFromData(data) {
  const d = normalize(data);
  if (d.length === 0) throw new Error('数据位不能为空');
  return d + checkChars(d);
}

/** 归一化后的形状（长度 + 字符集）串；不合格返回 null */
function shapeOf(v, dataLen) {
  const s = normalize(v);
  if (s.length !== dataLen + CHECK_LEN) return null;
  for (const ch of s) if (codeCharValue(ch) < 0) return null;
  return s;
}

/** 形状检查（长度 + 字符集），**不**验校验位；坏输入返回 false，不抛错 */
export function isCodeShape(v, dataLen) {
  assertDataLen(dataLen);
  return shapeOf(v, dataLen) !== null;
}

/**
 * 完整校验（形状 + 校验位）→ 归一化的大写编号；非法返回 null（**形状失败不抛错**）。
 * 形状已保证前 `dataLen` 位都在字母表内、且 `dataLen ≤ 7` ⇒ 重算校验不会抛错。
 */
export function verifyCode(v, dataLen) {
  assertDataLen(dataLen);
  const s = shapeOf(v, dataLen);
  if (s === null) return null;
  return s === encodeFromData(s.slice(0, dataLen)) ? s : null;
}
