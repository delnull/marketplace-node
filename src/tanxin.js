/**
 * 谈信地址（节点 / 店铺的公开客服联系方式）—— **唯一形状校验入口**。
 *
 * 支持两种写法（谈信 App 里同一个人的两种地址形态）：
 *   · `0x` + 40 位十六进制：谈信 App 的 EVM 账户地址；
 *   · `1` 开头的 BTY / Chain33 base58 地址（33–35 位）：同一账户的链上地址。
 *
 * ## 为什么只校验形状，不校验校验和 / 不查存在性
 *
 * 这个字段是**展示与聊天入口**，不是资金地址：页面把字符串原样交给谈信 App 的
 * `openChat(address)`，由 App 解析“这个人是谁”。在节点侧做 checksum 会把合法地址挡在门外，
 * 而“地址不存在”只有谈信 App 知道——所以这里只挡明显不是地址的输入。
 *
 * ## 为什么原样保存、不折小写
 *
 * base58 区分大小写；`0x` 地址的校验和写法也区分大小写。把它当 EVM 地址折成小写，
 * 会把 `1…` 地址整条改坏。库列因此是 `VARCHAR(64)`，不是 `CHAR(42)`，也不带
 * `col = LOWER(col)` 的 CHECK（见 db.js 的 schema 注释）。
 */

/** 与库列 `VARCHAR(64)` 对齐；两种合法形状都远短于它 */
export const TANXIN_ADDRESS_MAX = 64;

/** `0x` + 40 位十六进制（大小写都收：谈信 App 的账户地址可能带校验和） */
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * `1` 开头的 BTY / Chain33 base58 地址。
 * base58 字母表去掉易混的 `0 O I l`；链上实测长度 33/34，留到 35 以容纳前导零更长的编码。
 */
const BTY_RE = /^1[1-9A-HJ-NP-Za-km-z]{32,34}$/;

/**
 * 解析一次写入。
 *
 * `''` / 纯空白 = **清空**（`value: null`），与“没设置过”同形；不是错误。
 * 返回 `{ok: true, value}` 或 `{ok: false, error}`，路由把 error 原样变成 400。
 */
export function parseTanxinAddress(input) {
  const s = String(input ?? '').trim();
  if (!s) return { ok: true, value: null };
  if (s.length > TANXIN_ADDRESS_MAX) {
    return { ok: false, error: `谈信地址最长 ${TANXIN_ADDRESS_MAX} 个字符` };
  }
  if (!EVM_RE.test(s) && !BTY_RE.test(s)) {
    return {
      ok: false,
      error: '谈信地址需为 0x 开头的 42 位地址，或 1 开头的 BTY 地址（33–35 位，base58）',
    };
  }
  return { ok: true, value: s };
}

/** 一行（node / shops）→ 对外值：空串与 NULL 都归一成 null（“没设置过”） */
export function tanxinAddressOf(row) {
  return String(row?.tanxin_address || '') || null;
}
