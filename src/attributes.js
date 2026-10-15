/**
 * 商品**参数**（attributes）的归一化与上限 —— **唯一实现**。
 *
 * ── 与标签（tags）的分工，一句话 ─────────────────────────────────────────
 *   `tags`       = **检索维度**：买家按它筛选、聚合页按它出分面。**不进快照**（改标签不改"买到的是什么"）。
 *   `attributes` = **商品是什么**：成色、材质、产地、型号、批次、保质期……**全部进快照**
 *                  （它是店主对这件货的陈述；事后改掉而买家手里的哈希不变，等于货可被无声换掉）。
 *
 * 这条分工是刻意让"同一份数据只有一个去处"：参数不再分"进快照的/不进快照的"两半，
 * 于是店主与读者都不必判断"这条该写哪儿"——想被搜到就写标签，想说清是什么就写参数。
 *
 * ── 为什么必须有这一层（而不是让店主继续写进商品说明）──────────────────
 * 商品说明是**自由文本**：能写"全新未拆封"，但仲裁人只能把整段话读一遍，
 * 而"卖家到底承诺了哪一条"没有边界。参数是 `{name, value}` 的键值对，
 * 仲裁台可以逐条对照"买家说他买的是全新，快照里的参数写的是什么"。
 * 它服务的是最常见的争议类型：货不对板。
 *
 * ── 清洗与去重口径 ─────────────────────────────────────────────────────
 * 复用 `src/tags.js` 的 `cleanLabel`（控制字符→空格、零宽字符→删除、空白折叠、trim）
 * 与 `tagKeyOf`（ASCII 折小写的**键**）——"什么算同一个字符串"全仓只有那一处实现。
 * 去重按键：`品牌` 与 `品牌 ` 是同一个键；同一个键只保留**先出现的那种写法**（展示形）。
 * 超限（条数/长度）与非法输入**一律报可读中文错，绝不静默截断**（与标签同一条口径）。
 */
import { cleanLabel, tagKeyOf } from './tags.js';

/** 参数条目数上限。依据：够覆盖"品类 + 品牌 + 型号 + 关键规格 + 履约相关"，
 *  再多的实际形态是把详情搬进参数表（那是商品说明，不是参数）。 */
export const ATTR_MAX = 20;

/** 参数名上限（按码点计数，一个汉字算 1 字） */
export const ATTR_NAME_MAX_LEN = 24;

/** 参数值上限：要能写下"304 不锈钢（食品级）"这类具体值，又不至于变成一段话 */
export const ATTR_VALUE_MAX_LEN = 60;

const len = (s) => [...s].length;

/**
 * 参数数组归一化（写入路径的**唯一**入口：上架 POST 与编辑 PATCH 共用）。
 *
 * @param {unknown} input 期望为 `[{name, value}]`
 * @returns {{name: string, value: string}[]} 按**键**去重后的展示形数组（顺序 = 店主书写顺序）
 * @throws {Error} 非数组 / 元素形状不对 / 名称或值为空 / 超长 / 去重后超条数上限
 */
export function normalizeAttributes(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new Error(`商品参数（attributes）需为数组，例如 [{"name":"成色","value":"全新未拆封"}]（当前收到 ${typeof input}）`);
  }
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`商品参数（attributes）每一行都需为 {name, value}（第 ${out.length + 1} 行不是对象）`);
    }
    const unknown = Object.keys(raw).filter((k) => k !== 'name' && k !== 'value');
    if (unknown.length) {
      throw new Error(`商品参数每一行只认 name 与 value（第 ${out.length + 1} 行多了：${unknown.join('、')}）`);
    }
    const name = cleanLabel(String(raw.name ?? ''));
    const value = cleanLabel(String(raw.value ?? ''));
    // 整行都没写 = 这一行没填，丢弃（不是错误）；只写了一半才是错误
    if (!name && !value) continue;
    if (!name) throw new Error(`商品参数第 ${out.length + 1} 行只有值「${value}」没有名称`);
    if (!value) throw new Error(`商品参数「${name}」没有填值——不填就等于没有这条参数`);
    if (len(name) > ATTR_NAME_MAX_LEN) {
      throw new Error(`参数名「${name.slice(0, ATTR_NAME_MAX_LEN)}…」超过 ${ATTR_NAME_MAX_LEN} 字上限（本项 ${len(name)} 字）`);
    }
    if (len(value) > ATTR_VALUE_MAX_LEN) {
      throw new Error(`参数「${name}」的值超过 ${ATTR_VALUE_MAX_LEN} 字上限（本项 ${len(value)} 字）——更长的说明请写进商品说明`);
    }
    const key = tagKeyOf(name);
    if (seen.has(key)) continue; // 同一个键只留先出现的写法（与标签同一条去重口径）
    seen.add(key);
    out.push({ name, value });
  }
  if (out.length > ATTR_MAX) {
    throw new Error(`最多 ${ATTR_MAX} 条商品参数（去重后当前 ${out.length} 条）——请删掉次要的几条`);
  }
  return out;
}

/**
 * 解析 `products.attributes` 列（JSON 数组）→ 参数数组。
 *
 * 三态纪律的落法（与 `parseTagsColumn` 同款）：读不出来（列缺失/JSON 损坏/形状不对）**就是 `[]`** ——
 * 参数的 DTO 契约是 **恒为数组、空数组 = 没有参数（不是 null）**。刻意**不**二次清洗：
 * 下发必须与库里、与快照里的字节一致，否则"页面上显示的参数"与"哈希锁住的那份"会各说一套。
 *
 * @param {unknown} raw DB 列原文（JSON 字符串）
 * @returns {{name: string, value: string}[]}
 */
export function parseAttributesColumn(raw) {
  let v;
  try {
    v = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.name === 'string' && typeof x.value === 'string')
    .map((x) => ({ name: x.name, value: x.value }));
}
