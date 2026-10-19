/**
 * 商品标签（类目）的归一化与上限 —— **唯一实现**。
 *
 * 为什么单独一处：标签有两个写入入口（上架 `POST /api/products`、编辑 `PATCH /api/products/:slug`），
 * 各自写一遍 trim/去重/长度判断必然漂移——漂移的表现是"同一个标签在两条路径下存成了两种字符串"，
 * 而它下游要支撑两件事：按标签**精确筛选**与在库标签**聚合**。一旦库里同时存在 `GPU` 与 `gpu`
 * 两份"身份"，这两件事都得各自再折一次大小写——判据就分叉了，且永远补不全（将来多一个入口就多一个漏点）。
 *
 * ── 库里存的是 `[{key, display}]`，不是两份必须同批写的数据（2026-10-16 重设计）──
 * 旧形状是 `products.tags`（展示形 JSON）+ `product_tags`（一行一标签的**镜像表**）：
 * 「键」与「展示形」分居两处，靠调用方"记得在同一个批次里都写"来保持一致——漏一处就静默漂移，
 * 而漂移的症状是"卡片上显示的标签"与"按它搜到的商品"各说一套。
 * 现在只有**一列 JSON**：数组元素自带 `{key, display}`，一次写入即原子；
 * 筛选走多值索引（`? MEMBER OF (tags->'$[*].key')`，索引 `idx_products_tags`），
 * 不再需要镜像表，也就不存在"忘了同步镜像"这条路。
 *
 * 代价如实写（索引宽度是硬边界）：索引建在 `CAST(tags->'$[*].key' AS CHAR(64))` 上，
 * 键超过 64 字时**写入当场失败**（实测 `ER_FUNCTIONAL_INDEX_DATA_IS_TOO_LONG`），
 * 而不是"悄悄查不到"——这正是要的方向；{@link TAG_MAX_LEN}=24 远在 64 之下，
 * 越界只可能来自绕过本模块的手写 SQL。
 *
 * ── 因此标签有**两种形态**，本模块同时定义它们（各自只有这一处实现）──
 *
 *  1. **键 `tagKeyOf`（规范形）**：控制字符→空格、零宽字符→删除、空白串折成单个空格、trim、
 *     **ASCII 折小写**（只折 A-Z，中文等非 ASCII 逐字原样）。匹配（`?tag=`）、去重、
 *     `GROUP BY` **全部只认它** —— 于是"大小写只差一点的两个标签"在库里**不可表达**。
 *  2. **展示形（`normalizeTags` 的 `display`）**：同一套清洗，但**不折大小写** —— 店主写 `RTX 5090`，
 *     买家看到的就该是 `RTX 5090`（商城浏览里显示成 `rtx 5090` 是可见的体验缺陷）。
 *
 * 两者的关系：一个键可以对应**多种展示形**（不同商品各写各的）。对外展示用哪一种，是**查询期**的
 * 规则（出现次数最多者优先、并列取字典序最小者），实现在 `routes/products.js` 的
 * `GET /api/products/tags` —— 本模块不替它决定，只提供键与展示形两样东西。
 *
 * 清洗口径（键与展示形共用同一套，只有"折不折大小写"这一步不同）：
 *  - **控制字符（C0/C1/DEL）→ 空格**：它们多是复制粘贴夹带的分隔噪声，直接删掉会把两个词粘起来；
 *  - **零宽字符（U+200B..U+200D、U+FEFF）→ 删除**：不占位也不分隔，纯粹是"看不见却参与比较"的成因
 *    （前端 `utils/productTags` 的 `normTag` 也去它们；但它把控制字符**直接删掉**而这里折成空格，
 *    所以带控制字符的标签在保存前后可能差一个空格——**命中不受影响**：
 *    写入时键由本模块定下，读取侧用的是同一个 `tagKeyOf`，而展示形的选取以库里的为准）；
 *  - **空白串折成单个空格 + trim**：`RTX  5090` 与 `RTX 5090` 是同一个标签——空白多少是输入噪声，
 *    不是店主的书写风格；**大小写才是书写风格**，所以只在键里折、展示形保留；
 *  - 丢弃空串项（清洗后为空 = 这一项没写，直接丢，**不是**错误）；
 *  - 单个标签 ≤ {@link TAG_MAX_LEN} 字、最多 {@link TAGS_MAX} 个；**超限与非法一律报可读中文错，
 *    绝不静默截断**——静默截断会让店主以为"我打了 9 个标签"，而库里只存了 8 个，
 *    且被丢掉的是哪一个完全不可预期（错误必须能被看见，才谈得上修）。
 *
 * 本模块是**纯函数**（不碰 DB/网络）：归一化是判据，落库与下发都只是它的使用方。
 */

/** 单个标签的字符上限（按**码点**计数，一个汉字/一个 emoji 各算 1 字） */
export const TAG_MAX_LEN = 24;

/**
 * 单个商品的标签数量上限。
 * 依据：标签是"类目/检索面"，8 个足以覆盖"品类 + 品牌 + 属性 + 用途"；
 * 再多的实际形态是把关键词堆进标签（那是搜索作弊，不是分类）。
 */
export const TAGS_MAX = 8;

/** 控制字符（C0/C1/DEL）：多是夹带的分隔噪声 —— 折成空格（删掉会把两个词粘起来） */
// eslint-disable-next-line no-control-regex
const CONTROL_TO_SPACE_RE = /[\x00-\x1f\x7f-\x9f]+/g;

/** 零宽字符（U+200B..U+200D、U+FEFF）：不占位也不分隔 —— 直接删除 */
const ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]+/g;

/** 空白串（含全角空格 U+3000 与不换行空格 U+00A0）：折成单个空格 */
const WS_RUN_RE = /\s+/g;

/**
 * 清洗（**不折大小写**）→ 展示形。**导出的唯一实现在这里**：标签与商品参数
 * （`src/attributes.js`）共用同一套"什么算同一个字符串"的口径——两份清洗必然漂移，
 * 而漂移的表现是"同一份输入在标签里被接受、在参数里被存成另一个样子"。
 * @param {string} raw
 * @returns {string} 清洗后的展示形；空串 = 该项清洗后为空
 */
export function cleanLabel(raw) {
  return raw.replace(CONTROL_TO_SPACE_RE, ' ').replace(ZERO_WIDTH_RE, '').replace(WS_RUN_RE, ' ').trim();
}

/**
 * 标签**键**（规范形）：匹配、去重、多值索引、`GROUP BY` 只认它。
 *
 * 只折 ASCII 大小写（`/[A-Z]/`），**不用** `toLowerCase()`——后者会连全角/其它语系一起折，
 * 与"ASCII 大小写不敏感、中文原样"的口径不符（`ＧＰＵ` 应原样保留，不该悄悄变成 `ｇｐｕ`）。
 * 非字符串按空串处理（写入路径已校验过类型；查询入参可能什么都有）。
 * @param {unknown} raw
 * @returns {string} 键；空串 = 清洗后为空（不是一个可用标签）
 */
export function tagKeyOf(raw) {
  const s = typeof raw === 'string' ? raw : String(raw ?? '');
  return cleanLabel(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * `products.tags` 列（JSON）的**读回值**门禁 —— 标签/参数/承诺/详情块四个解析入口共用。
 *
 * 为什么必须拦：MySQL 的 JSON 列在驱动这一层就被解析成 JS 值（`db.js` 没有打开 `jsonStrings`），
 * 所以"传进来一个字符串"只可能是调用方手里拿的是**列原文**（旧实现的形状）。
 * 不拦的话，下面那些 `Array.isArray(v) ? v : []` 会把这份数据判成"没有内容"——
 * 一个**静默的错误答案**，而它下游是快照哈希（快照里少一份参数 ⇒ 两端哈希不一致 ⇒
 * 每个买家都看到假的「商品内容已被修改」）。响亮地失败在这里是唯一正确的方向。
 * @param {unknown} raw 读回的列值
 * @param {string} what 出错时指认是哪个列（可读中文）
 * @returns {unknown} 原值（只做类型门禁，不做形状归一）
 */
export function assertParsedJsonColumn(raw, what) {
  if (typeof raw === 'string') {
    throw new Error(
      `${what}：JSON 列由驱动解析成 JS 值，这里拿到的却是字符串（列原文）——请把 SELECT 读回的值直接传进来，不要 JSON.parse/JSON.stringify`
    );
  }
  return raw;
}

/**
 * 标签数组归一化：`undefined`/`null` → `[]`（没提交 = 无标签）。
 *
 * 返回的是**落库形状**：`[{key, display}]`（`key` 是 {@link tagKeyOf} 的规范形，
 * `display` 是清洗后的展示形），可直接 `JSON.stringify` 进 `products.tags`。
 * 非法输入抛 `Error`，`message` 是给店主看的中文（调用方直接透传给前端即可，不要再包一层"参数错误"）。
 *
 * 去重**按键**（`GPU` 与 `gpu` 是同一个标签）：同一商品里同一个键只留**先出现的那种写法**——
 * 这与前端 `utils/productTags` 的 `normalizeTags` 同口径（它也是"按 ASCII 大小写不敏感去重、
 * 保留首次出现的写法"），所以两端看到的是同一份数组。
 *
 * @param {unknown} input 期望为字符串数组
 * @returns {{key: string, display: string}[]} 按键去重后（长度 ≤ {@link TAGS_MAX}）
 * @throws {Error} 非数组 / 元素非字符串 / 单标签超 {@link TAG_MAX_LEN} / 去重后超 {@link TAGS_MAX}
 */
export function normalizeTags(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new Error(`标签（tags）需为字符串数组，例如 ["显卡","二手"]（当前收到 ${typeof input}）`);
  }
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') {
      throw new Error(`标签（tags）每一项都必须是字符串（第 ${out.length + 1} 项是 ${typeof raw}）`);
    }
    const display = cleanLabel(raw);
    if (!display) continue; // 清洗后为空：这一项没写，丢弃（不是错误）
    const len = [...display].length;
    if (len > TAG_MAX_LEN) {
      throw new Error(
        `标签「${[...display].slice(0, TAG_MAX_LEN).join('')}…」超过 ${TAG_MAX_LEN} 字上限（本项 ${len} 字）——请拆成更短更具体的标签`
      );
    }
    const key = tagKeyOf(display);
    if (seen.has(key)) continue; // 同一个键只留首次出现的写法（去重按 ASCII 大小写不敏感）
    seen.add(key);
    out.push({ key, display });
  }
  if (out.length > TAGS_MAX) {
    throw new Error(`最多 ${TAGS_MAX} 个标签（去重后当前 ${out.length} 个）——请删除多余的标签再提交`);
  }
  return out;
}

/**
 * 解析 `products.tags` 列的**读回值**（JSON 数组，元素为 `{key, display}`）→ **展示形数组**。
 *
 * 三态纪律在这里的落法：形状不对（不是数组 / 元素不是 `{key, display}`）**就是** `[]` ——
 * 标签是可选字段，DTO 契约是 **`tags` 恒为字符串数组、空数组 = 无标签（不是 null）**；
 * 若这里返回 null，每个消费点都得再判一次 null，而"读不出来"与"没有标签"对检索与展示的影响相同。
 *
 * 刻意**不**在这里二次清洗（清洗是写入入口的事）：下发必须与库里、与快照里引用的那份一致，
 * 否则"卡片上显示的标签"与"点它能搜到的标签"会各说一套（键就在同一份数据里，读取侧不该再折一次）。
 *
 * 键不参与展示（展示形才是给买家看的），但**元素缺键即丢掉**：那种元素只能显示、不能被筛选，
 * 正是本设计要消灭的"显示得出但搜不到"。
 *
 * @param {unknown} raw DB 读回的列值（⚠️ 不是列原文，见 {@link assertParsedJsonColumn}）
 * @returns {string[]} 展示形数组
 */
export function parseTagsColumn(raw) {
  const v = assertParsedJsonColumn(raw, 'products.tags');
  if (!Array.isArray(v)) return [];
  return v
    .filter((t) => t && typeof t === 'object' && typeof t.key === 'string' && t.key !== '' && typeof t.display === 'string' && t.display !== '')
    .map((t) => t.display);
}
