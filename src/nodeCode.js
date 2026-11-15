/**
 * 节点编号（nodeCode）——**离链 URL codec**，node / 前端 / 脚本共用（零依赖）。
 *
 * 形状：**8 位 = 6 位数据 + 2 位校验**，纯 Crockford Base32（`0123456789ABCDEFGHJKMNPQRSTVWXYZ`）。
 * 数据位是 **30 bit 节点 ID** 的大端 base32 写法（6 字符 × 5 bit）；合约里只存这个 30 bit
 * 数字（`MarketplaceRegistry` 的 `nodeId`，由 `(chainId, escrow, staking)` 派生），字符串只
 * 活在离链 URL 与展示层。校验算法与店铺编号**同源**（`./codec.js`）：
 * `S = Σ 值×位权(1..6)`（0..651，10 bit 装得下）原样写成两位 base32，**不取模**。
 *
 * 检错保证与 `codec.js` 相同：任意单字符错、任意两个数据位互换、两位校验位互换必被检出；
 * ≥2 个错误的加权差若正好抵消则检不出（加权和的固有边界）。
 *
 * 为什么不用十进制/十六进制：节点 ID 会出现在 URL、二维码、聊天里，十进制最长 10 位且
 * 无自校验；Crockford 去掉了 I/L/O/U，抄写错误落到"另一个合法 ID"的概率被校验位再削一层。
 * ID ↔ 码是可逆的：`nodeIdOfCode(encodeNodeCodeFromId(id)) === String(id)`。
 */
import {
  ALPHABET,
  CHECK_LEN,
  codeCharValue,
  encodeFromData,
  isCodeShape,
  normalize,
  verifyCode,
} from './codec.js';

/** 数据位 = 30 bit 节点 ID；`[0, 2^30)`，上界与链上 `nodeId` 字段一致（合约派生值不会为 0） */
const NODE_ID_LIMIT = 1n << 30n;

export const NODE_CODE_ALPHABET = ALPHABET;
export const NODE_CODE_DATA_LEN = 6;
export const NODE_CODE_CHECK_LEN = CHECK_LEN;
export const NODE_CODE_LEN = NODE_CODE_DATA_LEN + NODE_CODE_CHECK_LEN;

/**
 * 入参（bigint | 十进制字符串 | number）→ 30 bit 范围内的 bigint。
 * 越界抛 RangeError；不是十进制整数写法抛 TypeError（**不截断、不猜**）。
 */
function toNodeId(id) {
  let v;
  if (typeof id === 'bigint') v = id;
  else if (typeof id === 'number') v = BigInt(id); // 非整数/NaN/Infinity → 内建 RangeError
  else if (typeof id === 'string') {
    const s = id.trim();
    if (!/^-?[0-9]+$/.test(s)) throw new TypeError(`节点 ID 必须是十进制整数：${id}`);
    v = BigInt(s);
  } else {
    throw new TypeError(`节点 ID 必须是 bigint、十进制字符串或 number：${String(id)}`);
  }
  if (v < 0n || v >= NODE_ID_LIMIT) {
    throw new RangeError(`节点 ID 必须落在 [0, 2^30)：${v}`);
  }
  return v;
}

/** 6 位数据 + 加权和 → 8 位编号（供测试/内部使用；长度或字符不对抛错） */
export function encodeNodeCodeFromData(data) {
  const d = normalize(data);
  if (d.length !== NODE_CODE_DATA_LEN) throw new Error(`数据位必须是 ${NODE_CODE_DATA_LEN} 位`);
  return encodeFromData(d);
}

/** 30 bit 节点 ID → 8 位编号：大端写出 6 个 5 bit Crockford 字符，再补两位校验 */
export function encodeNodeCodeFromId(id) {
  let v = toNodeId(id);
  let data = '';
  for (let i = 0; i < NODE_CODE_DATA_LEN; i += 1) {
    data = NODE_CODE_ALPHABET[Number(v & 31n)] + data;
    v >>= 5n;
  }
  return encodeFromData(data);
}

/** 形状检查（长度 + 字符集），**不**验校验位 */
export function isNodeCodeShape(v) {
  return isCodeShape(v, NODE_CODE_DATA_LEN);
}

/** 完整校验（形状 + 校验位）→ 归一化 8 位大写编号；非法（含非字符串）返回 null（**不抛错**） */
export function verifyNodeCode(v) {
  return verifyCode(v, NODE_CODE_DATA_LEN);
}

/** 编号 → **十进制字符串**节点 ID；非法编号返回 null（链上只认数字，字符串是离链表示） */
export function nodeIdOfCode(v) {
  const code = verifyNodeCode(v);
  if (code === null) return null;
  let id = 0n;
  for (let i = 0; i < NODE_CODE_DATA_LEN; i += 1) {
    id = id * 32n + BigInt(codeCharValue(code[i]));
  }
  return id.toString();
}
