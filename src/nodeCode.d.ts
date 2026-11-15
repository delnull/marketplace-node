/**
 * `node/src/nodeCode.js` 的类型声明 —— 前端（TypeScript）直接 import 同一份 JS 实现。
 *
 * 节点编号：6 位数据（30 bit 节点 ID 的大端 base32）+ 2 位加权校验 = 8 位 Crockford
 * Base32，无标点。合约只存 30 bit 数字（`nodeId`），字符串只用于离链 URL / 展示。
 */
export declare const NODE_CODE_ALPHABET: string;
export declare const NODE_CODE_DATA_LEN: number;
export declare const NODE_CODE_CHECK_LEN: number;
export declare const NODE_CODE_LEN: number;

/** 6 位数据 + 加权和 → 8 位编号（供测试/内部使用）；长度或字符不对抛错 */
export declare function encodeNodeCodeFromData(data: string): string;

/**
 * 30 bit 节点 ID → 8 位编号。
 * 越界抛 `RangeError`；不是十进制整数写法（含非 bigint/string/number）抛 `TypeError`。
 */
export declare function encodeNodeCodeFromId(id: bigint | string | number): string;

/** 形状检查（长度 + 字符集），**不**验校验位 */
export declare function isNodeCodeShape(v: unknown): boolean;

/** 完整校验（形状 + 校验位）→ 归一化大写编号；非法（含非字符串）返回 null（**不抛错**） */
export declare function verifyNodeCode(v: unknown): string | null;

/** 编号 → 十进制字符串节点 ID；非法编号返回 null（**不抛错**） */
export declare function nodeIdOfCode(v: unknown): string | null;
