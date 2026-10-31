/**
 * 店铺编号（shop code）——**编号规则与校验的唯一实现**，node / frontend / 脚本共用。
 *
 * 形状：**9 位 = 8 位数据 + 1 位校验**
 *   数据位：节点生成的 8 个 Crockford Base32 字符（`node/src/ids.js` 用 CSPRNG 取字符）；
 *   校验位：**加权和** `Σ 值×位权(1..8) mod 37`，值域 0..36 映射到 Crockford 数据字母表，
 *           32..36 用 URL/IM 安全的 `-._~,`（官方写作 `*~$=U`——`*` 在聊天里触发斜体、
 *           `$`/`=` 常被转义，而编号最常贴进聊天）。
 *
 * 校验位为什么用**加权**而不是普通和：普通和对换位不敏感（换位不改变和），
 * 即 `K7QW…` 敲成 `7KQW…` 照样通过 —— 那正是"敲错一位落到另一家真店"的事故来源。
 * 加权后：单字符错 Δ = δ·w ≢ 0 (mod 37)（δ ∈ [1,31]、w ∈ [1,8]）；换位 Δ = (vᵢ−vⱼ)(wⱼ−wᵢ) ≢ 0
 * （值互异、位权互异且都小于质数 37）⇒ **单字符错误与任意换位都能检出**。
 *
 * 编号是**节点本地**事实：节点生成、写入 `shops.code`，不掺 chainId/registry，也不由链上铸造。
 * 本文件只负责编码与校验，不生成随机数（生成器在 node/src/ids.js，便于用 CSPRNG）。
 *
 * **本文件不依赖任何库**（前端/节点/模拟链/脚本都能直接 import）。
 * 改算法必须同步改 `node/src/ids.js` 的生成路径与测试；前端 `asShopCode` 直接调本文件。
 */

/** Crockford Base32 数据字母表（无 I/L/O/U，避免 1/I、0/O 抄错） */
export const SHOP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 校验位的扩展符号（对应值 32..36） */
export const SHOP_CODE_EXT = '-._~,';
export const SHOP_CODE_DATA_LEN = 8;
export const SHOP_CODE_LEN = SHOP_CODE_DATA_LEN + 1;

/** 字符 → 值（数据字母表 0..31，扩展 32..36）；非法返回 -1 */
export function codeCharValue(ch) {
  const i = SHOP_CODE_ALPHABET.indexOf(ch);
  if (i >= 0) return i;
  const j = SHOP_CODE_EXT.indexOf(ch);
  return j >= 0 ? 32 + j : -1;
}

/** 8 位数据 + 校验和 → 9 位编号（**加权和**：Σ 值×位权(1..8) mod 37） */
export function encodeShopCodeFromData(data) {
  const v = String(data || '').toUpperCase();
  if (v.length !== SHOP_CODE_DATA_LEN) throw new Error('数据位必须是 8 位');
  let sum = 0;
  for (let i = 0; i < v.length; i += 1) {
    const n = codeCharValue(v[i]);
    if (n < 0 || n > 31) throw new Error(`非法数据字符：${v[i]}`);
    sum += n * (i + 1); // 位权 1..8：让"换位"也能被检出（见文件头注释）
  }
  const c = sum % 37;
  return v + (c < 32 ? SHOP_CODE_ALPHABET[c] : SHOP_CODE_EXT[c - 32]);
}

/** 形状检查（长度 + 字符集），**不**验校验位 */
export function isShopCodeShape(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (s.length !== SHOP_CODE_LEN) return false;
  for (const ch of s) if (codeCharValue(ch) < 0) return false;
  return true;
}

/**
 * 完整校验（形状 + 校验位）→ 归一化的大写编号，非法返回 null。
 * **前端解析 `/shop/<code>` 前必须先过这一关。**
 *
 * 源码审计 2026-09 修复：`isShopCodeShape` 的字符集含扩展符号（`-._~,`，用于第 9 位校验位），
 * 因此数据位里出现扩展符号时形状检查会通过，而 `encodeShopCodeFromData` 对「数据位值 > 31」
 * 是**抛异常**的——于是 `verifyShopCode('1234567-9')` 直接 throw 而不是返回 null，与本文档
 * 承诺的「非法返回 null」相反。调用方（前端把 URL 段喂进来）会因此从「编号抄错了」升级成
 * 未捕获异常/白屏。这里按契约收口：数据位不合法即视为非法编号。
 */
export function verifyShopCode(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (!isShopCodeShape(s)) return null;
  // 数据位必须是纯数据字符（值 0..31）；含扩展符号/非法字符 → 不是编号（不抛错）
  for (let i = 0; i < SHOP_CODE_DATA_LEN; i += 1) {
    const n = codeCharValue(s[i]);
    if (n < 0 || n > 31) return null;
  }
  const expect = encodeShopCodeFromData(s.slice(0, SHOP_CODE_DATA_LEN)).slice(-1);
  return s.slice(-1) === expect ? s : null;
}

/** 别名（语义同上：完整校验） */
export function isShopCode(v) {
  return verifyShopCode(v) !== null;
}

/** 别名：归一化（完整校验 + 统一大写） */
export function normalizeShopCode(v) {
  return verifyShopCode(v);
}
