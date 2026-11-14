/**
 * 店铺编号（shop code）——**编号规则与校验的唯一实现**，node / frontend / 脚本共用。
 *
 * 形状：**9 位 = 7 位数据 + 2 位校验**
 *   数据位：节点生成的 7 个 Crockford Base32 字符（`src/ids.js` 用 CSPRNG 取字符）；
 *   校验位：**加权和本身** `S = Σ 值×位权(1..7)`（最大 31×28 = 868），写成两位 base32
 *           （`S >> 5`、`S & 31`）——**不取模**。
 *
 * 为什么两位校验：加权和的上界是 868，10 bit（两位 base32，1024）装得下，所以校验值可以
 * **原样保存、不取模**；不取模就不需要"没有零因子的算术"，校验位与数据位因此可以共用
 * 同一套 32 符号字母表，编号里不会出现字母表之外的字符。
 *
 * 检错保证（对齐"抄错一位落到另一家真店"这个事故模型）：
 *   · 任意**单字符**错（含两位校验位）：Δ = 位权×差值 ≠ 0，而 S 存的是精确值 ⇒ 必被检出；
 *   · 任意两个**数据位**互换：Δ = (位权差)×(值差) ≠ 0 ⇒ 必被检出；
 *   · 两位校验位互换也检出（`c₁·32 + c₂ = c₂·32 + c₁` 只在两位相同时成立）。
 *   ≥2 个错误若加权差**正好抵消**（权重 1 位 +7、权重 7 位 −1）则检不出——这是加权和的固有
 *   边界；上面两条保证只覆盖单字符与换位，多错误不保证。
 *
 * 编号是**节点本地**事实：节点生成、写入 `shops.code`，不掺 chainId/registry，也不由链上铸造。
 * 本文件只负责编码与校验，不生成随机数（生成器在 node/src/ids.js，便于用 CSPRNG）。
 * 形状检查与取值查表共用**同一个字母表**：数据位里出现字母表之外的字符在形状那一步就不成立，
 * 所以"形状通过、校验抛错"这一类问题在结构上不可表达。
 *
 * **本文件不依赖任何库**（前端/节点/模拟链/脚本都能直接 import）。
 * 改算法必须同步改 `src/ids.js` 的生成路径与测试；前端 `asShopCode` 直接调本文件。
 */

/** Crockford Base32 数据字母表（无 I/L/O/U，避免 1/I、0/O 抄错） */
export const SHOP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SHOP_CODE_DATA_LEN = 7;
export const SHOP_CODE_CHECK_LEN = 2;
export const SHOP_CODE_LEN = SHOP_CODE_DATA_LEN + SHOP_CODE_CHECK_LEN;

/** 字符 → 值（0..31）；非法返回 -1（含空串/多字符/非字符串） */
export function codeCharValue(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return -1;
  return SHOP_CODE_ALPHABET.indexOf(ch);
}

/** 7 位数据 + 加权和 → 9 位编号（`Σ 值×位权(1..7)` 的两位 base32 写法，不取模） */
export function encodeShopCodeFromData(data) {
  const v = String(data || '').toUpperCase();
  if (v.length !== SHOP_CODE_DATA_LEN) throw new Error(`数据位必须是 ${SHOP_CODE_DATA_LEN} 位`);
  let sum = 0;
  for (let i = 0; i < v.length; i += 1) {
    const n = codeCharValue(v[i]);
    if (n < 0) throw new Error(`非法数据字符：${v[i]}`);
    sum += n * (i + 1); // 位权 1..7：让"换位"也能被检出（见文件头注释）
  }
  return v + SHOP_CODE_ALPHABET[sum >> 5] + SHOP_CODE_ALPHABET[sum & 31];
}

/** 输入归一化：只认字符串（非字符串一律非法，也避开 `String(无原型对象)` 这类抛错路径） */
function normalize(v) {
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

/** 形状检查（长度 + 字符集），**不**验校验位 */
export function isShopCodeShape(v) {
  const s = normalize(v);
  if (s.length !== SHOP_CODE_LEN) return false;
  for (const ch of s) if (codeCharValue(ch) < 0) return false;
  return true;
}

/**
 * 完整校验（形状 + 校验位）→ 归一化的大写编号，非法返回 null。
 * **前端解析 `/shop/<code>` 前必须先过这一关。**
 *
 * 形状已保证前 7 位都在字母表里，所以 `encodeShopCodeFromData` 在这里不会抛错——
 * 非法输入只有"形状不对"一种，不需要再做一次取值域判断。
 */
export function verifyShopCode(v) {
  const s = normalize(v);
  if (!isShopCodeShape(s)) return null;
  return s === encodeShopCodeFromData(s.slice(0, SHOP_CODE_DATA_LEN)) ? s : null;
}
