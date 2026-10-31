/**
 * `shared/shopCode.js` 的类型声明 —— 前端（TypeScript）直接 import 同一份 JS 实现。
 *
 * 店铺编号是节点本地事实：8 位随机数据 + 1 位加权校验。node 生成、前端解析、
 * 脚本校验都走这一份；不要在这里再声明一套“哈希编号”的旧接口。
 */
export declare const SHOP_CODE_ALPHABET: string;
export declare const SHOP_CODE_EXT: string;
export declare const SHOP_CODE_DATA_LEN: number;
export declare const SHOP_CODE_LEN: number;

/** 字符 → 值（数据字母表 0..31，扩展 32..36）；非法返回 -1 */
export declare function codeCharValue(ch: string): number;

/** 8 位数据 + 校验和 → 9 位编号（加权和 Σ 值×位权(1..8) mod 37） */
export declare function encodeShopCodeFromData(data: string): string;

/** 形状检查（长度 + 字符集），**不**验校验位 */
export declare function isShopCodeShape(v: unknown): boolean;

/** 完整校验（形状 + 校验位）→ 归一化大写编号；非法返回 null（**不抛错**） */
export declare function verifyShopCode(v: unknown): string | null;

/** 别名：完整校验（boolean） */
export declare function isShopCode(v: unknown): boolean;

/** 别名：归一化（完整校验 + 统一大写），非法返回 null */
export declare function normalizeShopCode(v: unknown): string | null;
