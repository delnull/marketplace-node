/**
 * 店铺编号（shop code）——**编号格式的对外入口**，node / frontend / 脚本共用。
 *
 * 形状：**9 位 = 7 位数据 + 2 位校验**，纯 Crockford Base32（`0123456789ABCDEFGHJKMNPQRSTVWXYZ`）。
 * 校验是加权和 `S = Σ 值×位权(1..7)`（0..868）原样写成两位 base32（`S>>5`、`S&31`），
 * **不取模、无特殊符号**。算法与检错保证的唯一实现在 `./codec.js`（节点编号共用同一内核），
 * 本文件只钉"店铺编号 = 7 位数据"这一格式；`test/shopCode.test.js` 同时钉住两者的一致性。
 *
 * 编号是**节点本地**事实：节点生成、写入 `shops.code`，不掺 chainId/registry，也不由链上铸造。
 * 本文件只负责编码与校验，不生成随机数（生成器在 `node/src/ids.js`，便于用 CSPRNG）。
 * 形状检查与取值查表共用**同一个字母表**：数据位里出现字母表之外的字符在形状那一步就不成立，
 * 所以"形状通过、校验抛错"这一类问题在结构上不可表达。
 *
 * **本文件不依赖任何库**（前端/节点/模拟链/脚本都能直接 import）。
 * 改算法必须同步改 `src/ids.js` 的生成路径与测试；前端 `asShopCode` 直接调本文件。
 */
import { ALPHABET, CHECK_LEN, encodeFromData, isCodeShape, normalize, verifyCode } from './codec.js';

export { codeCharValue } from './codec.js';

/** Crockford Base32 数据字母表（无 I/L/O/U，避免 1/I、0/O 抄错） */
export const SHOP_CODE_ALPHABET = ALPHABET;
export const SHOP_CODE_DATA_LEN = 7;
export const SHOP_CODE_CHECK_LEN = CHECK_LEN;
export const SHOP_CODE_LEN = SHOP_CODE_DATA_LEN + SHOP_CODE_CHECK_LEN;

/** 7 位数据 + 加权和 → 9 位编号（`Σ 值×位权(1..7)` 的两位 base32 写法，不取模） */
export function encodeShopCodeFromData(data) {
  const d = normalize(data);
  if (d.length !== SHOP_CODE_DATA_LEN) throw new Error(`数据位必须是 ${SHOP_CODE_DATA_LEN} 位`);
  return encodeFromData(d);
}

/** 形状检查（长度 + 字符集），**不**验校验位 */
export function isShopCodeShape(v) {
  return isCodeShape(v, SHOP_CODE_DATA_LEN);
}

/**
 * 完整校验（形状 + 校验位）→ 归一化的大写编号，非法返回 null。
 * **前端解析 `/shop/<nodeCode>/<shopCode>` 的第二段前必须先过这一关。**
 *
 * 形状已保证前 7 位都在字母表里，所以重算校验在这里不会抛错——
 * 非法输入只有"形状不对"一种，不需要再做一次取值域判断。
 */
export function verifyShopCode(v) {
  return verifyCode(v, SHOP_CODE_DATA_LEN);
}
