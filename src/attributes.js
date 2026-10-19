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
 * ── 落库形状：`[{name, value, pair}]`，`pair` 是**刻意冗余**（2026-10-16 重设计）──
 * 按（参数名, 值）精确筛选需要一个可索引的单键，而多值索引只能索引"JSON 里已存在的数组元素"，
 * 于是把它拼成 `pair = nameKey + U+0000 + valueKey`。
 *   · 冗余住在**同一个列**里（`products.attributes` 一份 JSON）⇒ 一次写入即原子，
 *     不可能出现"名/值更新了、索引键没更新"的漂移；
 *   · 旧形状是 `products.attributes` + `product_attributes` 两张**镜像表**，
 *     靠调用方"记得同批写"来保持一致——漏一处就是静默漂移（页面显示的参数与按它筛出的商品各说一套）。
 *     那正是本次重设计要消灭的东西：判据落进数据形状，而不是落进"调用点都记得"。
 *
 * `pair` 的构造只有本模块这一处（{@link attrPairOf}）：写入侧（`normalizeAttributes`）与
 * 筛选侧（`routes/products.js` 的 `?attr=名:值`）用的是同一个函数，两侧不可能拼出不同的键。
 *
 * **分隔符为什么是 U+0000**：{@link cleanLabel} 把控制字符一律折成空格 ⇒ 参数名与值里
 * **永远不可能**出现 NUL，所以 `pair` 的切分无歧义；查询语法用的 `:` 不行
 * （值里本来就有冒号：`接口: USB-C` 会被切成两半）。
 *
 * 代价如实写（索引宽度是硬边界）：索引建在 `CAST(attributes->'$[*].pair' AS CHAR(128))` 上，
 * `pair` 最长 = 24 + 1 + 60 = 85 字，留了余量；超长会在写入当场失败（而不是悄悄筛不到）。
 *
 * ── 清洗与去重口径 ─────────────────────────────────────────────────────
 * 复用 `src/tags.js` 的 `cleanLabel`（控制字符→空格、零宽字符→删除、空白折叠、trim）
 * 与 `tagKeyOf`（ASCII 折小写的**键**）——"什么算同一个字符串"全仓只有那一处实现。
 * 去重按键：`品牌` 与 `品牌 ` 是同一个键；同一个键只保留**先出现的那种写法**（展示形）。
 * 超限（条数/长度）与非法输入**一律报可读中文错，绝不静默截断**（与标签同一条口径）。
 */
import { assertParsedJsonColumn, cleanLabel, tagKeyOf } from './tags.js';

/** 参数条目数上限。依据：够覆盖"品类 + 品牌 + 型号 + 关键规格 + 履约相关"，
 *  再多的实际形态是把详情搬进参数表（那是商品说明，不是参数）。 */
export const ATTR_MAX = 20;

/** 参数名上限（按码点计数，一个汉字算 1 字） */
export const ATTR_NAME_MAX_LEN = 24;

/** 参数值上限：要能写下"304 不锈钢（食品级）"这类具体值，又不至于变成一段话 */
export const ATTR_VALUE_MAX_LEN = 60;

/** `pair` 的分隔符；见文件头"为什么是 U+0000" */
const PAIR_SEP = '\u0000';

const len = (s) => [...s].length;

/**
 * 参数筛选键：`名键 + NUL + 值键` —— **唯一实现**（写入与筛选共用）。
 *
 * 入参必须是**已经折过的键**（`tagKeyOf` 的输出），不是展示形：把折大小写这一步留在函数外，
 * 是为了让"哪些地方该折"一眼可见（查询入参可能什么写法都有，写入路径已经折过一次）。
 * @param {string} nameKey
 * @param {string} valueKey
 * @returns {string}
 */
export function attrPairOf(nameKey, valueKey) {
  return `${nameKey}${PAIR_SEP}${valueKey}`;
}

/**
 * 参数数组归一化（写入路径的**唯一**入口：上架 POST 与编辑 PATCH 共用）。
 *
 * @param {unknown} input 期望为 `[{name, value}]`
 * @returns {{name: string, value: string, pair: string}[]} 按**键**去重后的落库形状（顺序 = 店主书写顺序）
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
    out.push({ name, value, pair: attrPairOf(key, tagKeyOf(value)) });
  }
  if (out.length > ATTR_MAX) {
    throw new Error(`最多 ${ATTR_MAX} 条商品参数（去重后当前 ${out.length} 条）——请删掉次要的几条`);
  }
  return out;
}

/**
 * 解析 `products.attributes` 列的**读回值**（JSON 数组，元素为 `{name, value, pair}`）
 * → `[{name, value}]`（DTO 与快照共用的投影）。
 *
 * 三态纪律的落法（与 `parseTagsColumn` 同款）：形状不对（不是数组 / 元素不是对象）**就是 `[]`** ——
 * 参数的 DTO 契约是 **恒为数组、空数组 = 没有参数（不是 null）**。刻意**不**二次清洗：
 * 下发必须与库里、与快照里的字节一致，否则"页面上显示的参数"与"哈希锁住的那份"会各说一套。
 *
 * `pair` **刻意不下发**：它是给多值索引用的派生键（`nameKey + NUL + valueKey`），
 * 名与值本身才是事实；把它带进 DTO/快照会让哈希契约多一个纯冗余字段
 * （节点与前端都得逐字复现它，收益为零、漂移面却多一处）。
 *
 * @param {unknown} raw DB 读回的列值（⚠️ 不是列原文，见 `assertParsedJsonColumn`）
 * @returns {{name: string, value: string}[]}
 */
export function parseAttributesColumn(raw) {
  const v = assertParsedJsonColumn(raw, 'products.attributes');
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.name === 'string' && typeof x.value === 'string')
    .map((x) => ({ name: x.name, value: x.value }));
}
