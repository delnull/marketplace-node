/**
 * `node/src/shopCode.js` 的类型声明 —— 前端（TypeScript）直接 import 同一份 JS 实现。
 *
 * 店铺编号是节点本地事实：7 位随机数据 + 2 位加权校验（9 位 base32，无标点）。
 * node 生成、前端解析、脚本校验都走这一份。
 */
export declare const SHOP_CODE_ALPHABET: string;
export declare const SHOP_CODE_DATA_LEN: number;
export declare const SHOP_CODE_CHECK_LEN: number;
export declare const SHOP_CODE_LEN: number;

/** 字符 → 值（0..31）；非法返回 -1 */
export declare function codeCharValue(ch: string): number;

/** 7 位数据 + 加权和 → 9 位编号（`Σ 值×位权(1..7)` 的两位 base32 写法，不取模） */
export declare function encodeShopCodeFromData(data: string): string;

/** 形状检查（长度 + 字符集），**不**验校验位 */
export declare function isShopCodeShape(v: unknown): boolean;

/** 完整校验（形状 + 校验位）→ 归一化大写编号；非法（含非字符串）返回 null（**不抛错**） */
export declare function verifyShopCode(v: unknown): string | null;
