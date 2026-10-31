/**
 * 标识符（订单号 / 商品标识 / 店铺编号 / 提货声明号）——**统一格式，去掉连字符**。
 *
 * 为什么不用 UUID：`ae9c128c-6a90-4989-87e5-7dd7c5b57482` 是对机器友好、对人极不友好的字符串——
 * 36 个字符、4 个连字符、大小写混排，用户在聊天里报单号、客服在电话里核单号时，
 * 连字符要不要念、第几段是第几位都会出错；抄进搜索框还常常把「-」抄成「—」。
 *
 * 格式（Crockford Base32：`0123456789ABCDEFGHJKMNPQRSTVWXYZ`）：
 *   · 去掉了 I / L / O / U —— 这四个字符最容易和 1 / 1 / 0 / V 看混（"念出来分不清"）；
 *   · 全部**大写**，没有连字符与空格，任何输入法下都能原样抄写；
 *   · 长度固定，肉眼可以校验"少没少一位"。
 *
 * 订单号 `B` + 时间(10) + 随机(10) = **21 字符**：
 *   · 前 10 位是下单毫秒时间戳（48 bit，够用到公元 10889 年）→ 订单号**天然按时间有序**，
 *     日志里一眼能看出先后，也便于按前缀做区间检索；
 *   · 后 10 位是 50 bit 随机 → 订单是半敏感资源（拿单号能看到收货信息等），
 *     必须不可枚举：50 bit ≈ 1.1e15，同一毫秒内碰撞概率可忽略；
 *   例：`B0V3K7QW3M9P2TZ8N5VW1Y`
 *
 * 提货声明号 `C` + 时间(10) + 随机(10) = **21 字符**：与订单号同一套理由（持有人要能口头报它）。
 *
 * 商品标识 `P` + 随机(10) = **11 字符**（例：`P7QW3M4X9T2`）：
 *   · 商品是公开可枚举的资源，不需要时间前缀（那反而会泄露"何时上架"的弱信息给无关的人）；
 *   · 10 位随机 ≈ 1e15 组合，跨店全局唯一足够。
 *
 * 店铺编号 = 8 位随机数据 + 1 位**加权校验** = **9 字符**（`newShopCode`）：
 *   · 店铺是**节点链下**的事实（平台目录只登记节点），编号由本节点铸造、写入 `shops.code`；
 *   · 校验位的形状契约在 `./shopCode.js`（前端在解析 `/shop/<code>` 前用它校验，
 *     单测 `test/shopCode.test.js` 会拿本函数生成的编号去过那份实现）。本文件只负责**铸造**，
 *     读路径从不解析编号里的任何含义——存在性只有库能回答。
 *
 * 新项目只有这一套格式：这里的生成器是**唯一生成器**，
 * `isNewOrderId` / `isNewProductSlug` 只服务展示层判断，**不用于校验/拒绝**——
 * 读路径不得假设"标识一定是这个形状"（形状校验只在这些生成器的输出上成立）。
 */
import crypto from 'node:crypto';
import { SHOP_CODE_ALPHABET, encodeShopCodeFromData } from './shopCode.js';

/** Crockford Base32（无 I L O U，避免与 1 0 看混） */
const ALPHABET = SHOP_CODE_ALPHABET;
const RE_ORDER = /^B[0-9A-HJKMNP-TV-Z]{20}$/;
const RE_SLUG = /^P[0-9A-HJKMNP-TV-Z]{10}$/;

/** 无偏 random 整数（拒绝采样，避免取模引入偏差） */
function randomInt(max) {
  const limit = Math.floor(0xffffffff / max) * max;
  for (;;) {
    const v = crypto.randomBytes(4).readUInt32BE(0);
    if (v < limit) return v % max;
  }
}

/** 整数 → 定长 base32（左补 0） */
function encode(value, len) {
  let v = BigInt(value);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out = ALPHABET[Number(v % 32n)] + out;
    v /= 32n;
  }
  return out;
}

/** 随机 base32 串（逐字符无偏） */
function randomChars(len) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[randomInt(32)];
  return out;
}

/** 新订单号：`B` + 10 位时间 + 10 位随机 */
export function newOrderId(now = Date.now()) {
  return `B${encode(now, 10)}${randomChars(10)}`;
}

/** 新商品标识：`P` + 10 位随机 */
export function newProductSlug() {
  return `P${randomChars(10)}`;
}

/** 新提货声明号：`C` + 10 位时间 + 10 位随机（与订单号同一套理由：持有人要能口头报它） */
export function newClaimNo(now = Date.now()) {
  return `C${encode(now, 10)}${randomChars(10)}`;
}

/**
 * 新店铺编号：8 位随机数据 + 1 位**加权校验**（`Σ 值×位权(1..8) mod 37`）。
 *
 * 店铺是节点链下的事实，编号由本节点铸造（平台 Registry 不认识"店"）。校验位的算法契约见
 * `./shopCode.js`：前端解析 `/shop/<code>` 前要过它，所以本函数**必须产出能通过那份校验**
 * 的编号——`test/shopCode.test.js` 拿它生成的编号过 shared 的 `verifyShopCode` 守住这条。
 */
export function newShopCode() {
  return encodeShopCodeFromData(randomChars(8));
}

/** 是否新式订单号（仅用于展示层"这是新格式"的判断，不用于校验/拒绝） */
export function isNewOrderId(v) {
  return RE_ORDER.test(String(v || ''));
}

/** 是否新式商品标识 */
export function isNewProductSlug(v) {
  return RE_SLUG.test(String(v || ''));
}

/**
 * 订单号时间前缀 → 毫秒时间戳（解析不出来返回 null）。
 * 用途：列表里"按单号前缀看下单时间"、排障时按前缀定位区间。
 */
export function orderIdTime(id) {
  const s = String(id || '');
  if (!RE_ORDER.test(s)) return null;
  let v = 0n;
  for (const ch of s.slice(1, 11)) v = v * 32n + BigInt(ALPHABET.indexOf(ch));
  return Number(v);
}
