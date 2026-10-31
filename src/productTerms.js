/**
 * 商品级**承诺**（terms）的归一化与上限 —— **唯一实现**。
 *
 * ── 这个模块解决的是什么问题 ─────────────────────────────────────────────
 * 本商城的争议裁决**不做事实调查**（不走访、不勘验、不联系任何第三方），仲裁人手上的材料只有
 * 「链上终局事实 + 双方陈述与证据 + 费率披露 + 程序行为」（见 `docs/DISPUTE_RULES.md`）。
 * 于是最常见的三类争议——**货不对板 / 晚发货 / 不给退**——此前在机制内**没有客观判据**：
 * 店主就算在商品详情里写了"48 小时内发货、七天无理由"，那也只是**图片或长文里的一句话**，
 * 而仲裁台渲染的是快照里的纯文本 `description`（图片块降级为 `[图片]` 三个字）。
 *
 * `terms` 把这几条承诺变成**结构化、下单时锁进快照、仲裁台读得到**的字段：
 * 买家签的那笔交易的 `orderId` 由快照哈希派生 ⇒ 事后改承诺会改变 orderId（防篡改锁定）。
 * 这不是"上链存证"，是"可被买家独立核验的锁定"——与年龄限制同一条论证（见 docs/OPERATOR_COMPLIANCE.md）。
 *
 * ── 三条设计纪律（都不是可选的）─────────────────────────────────────────
 *  1. **只有受控枚举与数字，没有自由文本**。自由文本会退化成"换个地方写文案"，
 *     而文案无法被对照——仲裁人要判的是"承诺过什么"，不是一个字符串里藏了什么。
 *     细节（材质、赠品、注意事项）属于商品说明，不属于承诺。
 *  2. **"未声明"与"声明了不支持退换"是两个值**（`unspecified` vs `none`）。
 *     把没表态默认成"不退换"，等于替店主说了一句他没说过的话——而这句话会被仲裁人读到。
 *  3. **不承诺机制管不到的事**：链上"确认收货后还能主张多久"由合约参数决定
 *     （`afterSaleWindowBlocks`，1–360 天，结算时按单快照），那是**权利期限**，
 *     不是退换规则。所以这里**没有质保期字段**——商品级再声明一个"质保 X 天"，
 *     会让买家以为它受机制保障，而超出合约窗口的部分在系统内根本无处主张
 *     （与 `PRODUCT_BOUNDARIES.md` "读起来像保证的都必须真做得到"同一条口径）。
 *
 * ── 与其它字段的边界 ────────────────────────────────────────────────────
 *  · `shipping_fee_usdt_micro` = 运费（钱）；`terms.handling_days` = **多久发出**（时间）。
 *    两者共同回答"这一单要等多久、要花多少"，但一个是金额一个不是。
 *  · `specs` / `product_skus` = 卖什么规格、什么价（决定 `sku_key` 与成交价）；
 *    `attributes`（`src/attributes.js`）= 这东西是什么（不影响价格）。
 *
 * 落库是 MySQL 的真 JSON 列（`products.terms`）：写进去的键序**不是**读回来的键序
 * （JSON 类型会按键长/字节重排，见 `src/db.js` 的说明），所以**下发与快照都以读回值为准**，
 * 并且由 {@link parseTermsColumn} 这一处把形状重新钉成固定键序——那是快照哈希的输入。
 */
import { assertParsedJsonColumn } from './tags.js';

/** 承诺发货时效的上限（自然日）。下限 = 1：0 天不是承诺，"今天发"没有可核对的边界 */
export const MAX_HANDLING_DAYS = 30;

/** 退换窗口的上限（自然日）——店主自己承诺的窗口，与链上售后窗口是两件不同的事 */
export const MAX_RETURN_WINDOW_DAYS = 30;

/**
 * 退换规则（受控枚举）。`unspecified` 是**默认值**且必须存在，理由见文件头纪律 2。
 *  · unspecified —— 店主没声明（不是"不退换"）
 *  · none        —— 明确声明不支持退换
 *  · defective   —— 仅质量问题可退换
 *  · no-reason   —— 无理由可退换（"七天无理由"就是它 + window=7）
 */
export const RETURN_POLICIES = ['unspecified', 'none', 'defective', 'no-reason'];

/**
 * 退货运费由谁承担（受控枚举；只在真的可退换时有意义）。
 *  · seller —— 店主承担    · buyer —— 买家承担    · split —— 各承担一半
 */
export const RETURN_FREIGHTS = ['seller', 'buyer', 'split'];

/**
 * 归一后的空承诺（未声明任何一条）：DTO、快照、DB 列三处**同一个形状**。
 * ⚠️ **键序有意义**：它就是快照哈希里 `terms` 的键序（前端 `utils/snapshot.ts` 的 `termsOf`
 * 按同一顺序重建），改动这里的顺序等于改快照契约。
 */
export const EMPTY_TERMS = Object.freeze({
  handling_days: null,
  return_policy: 'unspecified',
  return_window_days: null,
  return_freight: null,
  /**
   * 店主是否**支持开票**（boolean）。
   *
   * 为什么是"店主声明"而不是"软件能力"：能不能开票取决于这家店有没有税务主体，
   * 联邦制下没有任何运营方能替它回答。所以它是**店主对这笔交易的陈述**，与承诺同源、同样进快照
   * ——卖家用它做买家侧的闸（不支持就不给买家填开票信息的地方），仲裁时也能看到"下单时声明的是什么"。
   *
   * `false`（明确不开）与 `null`（未声明）在**买家侧的行为完全相同**（都不显示开票入口）：
   * 开票是店主的主动能力声明，未声明不等于默认支持。分开保留是为了让店主面板能区分
   * "我明确说了不开"与"我还没填"——那是他自己的经营记录，不是买家的权利。
   */
  invoice_supported: null,
});

/**
 * 承诺归一化（写入路径的**唯一**入口：上架 POST 与编辑 PATCH 共用）。
 *
 * 键名是 **snake_case 且两端逐字一致**（DB 列内 JSON / 快照 / DTO）——与 `media`、`specs`、
 * `skus` 的 JSON 内容同一条纪律：容器键随列名（顶层 DTO 里就是 `terms`），
 * **内容不翻译**。多一层 camelCase 映射就多一张会漂移的对照表。
 *
 * 校验失败的 message 是给店主看的中文（调用方直接透传，不要再包一层"参数错误"）。
 *
 * @param {unknown} input 期望为 `{handling_days?, return_policy?, return_window_days?, return_freight?}`
 * @returns {{handling_days: number|null, return_policy: string, return_window_days: number|null, return_freight: string|null, invoice_supported: boolean|null}}
 * @throws {Error} 形状不对 / 枚举非法 / 天数越界 / 组合自相矛盾（如"不退换"却给了退货运费承担方）
 */
export function normalizeTerms(input) {
  if (input === undefined || input === null) return { ...EMPTY_TERMS };
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('承诺（terms）需为对象，例如 {"handling_days":2,"return_policy":"no-reason","return_window_days":7,"return_freight":"seller"}');
  }
  const unknown = Object.keys(input).filter((k) => !(k in EMPTY_TERMS));
  if (unknown.length) {
    throw new Error(`承诺（terms）不认识这些字段：${unknown.map((k) => `「${k}」`).join('、')}——可用字段：${Object.keys(EMPTY_TERMS).join(' / ')}`);
  }

  const days = (raw, label, max, { allowNull = true } = {}) => {
    if (raw === undefined || raw === null || raw === '') {
      if (allowNull) return null;
      throw new Error(`${label}不能为空`);
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      throw new Error(`${label}需为 1..${max} 的整数（自然日）——留空表示不承诺`);
    }
    return n;
  };

  const handling_days = days(input.handling_days, '承诺发货时效', MAX_HANDLING_DAYS);

  const policy = input.return_policy === undefined || input.return_policy === null || input.return_policy === ''
    ? 'unspecified'
    : String(input.return_policy);
  if (!RETURN_POLICIES.includes(policy)) {
    throw new Error(`退换规则（return_policy）只能是 ${RETURN_POLICIES.join(' / ')}`);
  }

  const returnable = policy === 'defective' || policy === 'no-reason';
  const return_window_days = days(input.return_window_days, '退换窗口', MAX_RETURN_WINDOW_DAYS, {
    allowNull: !returnable,
  });
  /*
   自相矛盾的两处必须在**写入时**拒绝，而不是存成一份读起来矛盾的承诺：
     · 声明了可退换却没有窗口 ⇒ 仲裁人无法回答"第 10 天还算不算"；
     · 声明了"不退换/未声明"却填了退货运费承担方 ⇒ 一条永远不会适用的规则。
  */
  if (returnable && return_window_days === null) {
    throw new Error('声明了可退换就必须填退换窗口（1..30 天）——否则买家不知道几天内提出有效');
  }
  if (!returnable && return_window_days !== null) {
    throw new Error('只有"仅质量问题可退换"或"无理由可退换"才能填退换窗口');
  }

  let return_freight = input.return_freight === undefined || input.return_freight === null || input.return_freight === ''
    ? null
    : String(input.return_freight);
  if (return_freight !== null && !RETURN_FREIGHTS.includes(return_freight)) {
    throw new Error(`退货运费承担方（return_freight）只能是 ${RETURN_FREIGHTS.join(' / ')}`);
  }
  if (return_freight !== null && !returnable) {
    throw new Error('只有声明了可退换，退货运费承担方才有意义');
  }

  /*
    开票：只接受布尔与"空"，字符串 `'true'`/`'1'` 一律拒绝——否则"店主到底声明了什么"
    会变成拼写问题，而这一条要进快照、仲裁时照着读。
  */
  const invRaw = input.invoice_supported;
  let invoice_supported = null;
  if (invRaw !== undefined && invRaw !== null && invRaw !== '') {
    if (typeof invRaw !== 'boolean') {
      throw new Error('是否支持开票（invoice_supported）只能是 true / false，或留空表示未声明');
    }
    invoice_supported = invRaw;
  }

  return { handling_days, return_policy: policy, return_window_days, return_freight, invoice_supported };
}

/**
 * 解析 `products.terms` 列的**读回值**（JSON 对象）→ 归一后的承诺（**固定键序**，见 {@link EMPTY_TERMS}）。
 *
 * 口径与 `parseTagsColumn` 一致：**形状不对就是空承诺**（"未声明"与"读不出来"对展示与仲裁的影响相同，
 * 都不是"店主声明了什么"），但**刻意不在这里做二次校验**——写入路径已经归一过，
 * 这里再判一次就会出现第二个判据（而它一旦与写入侧不同口径，"展示的承诺"与"锁进快照的承诺"就会不一致）。
 *
 * 为什么这个投影非有不可：DB 里的键序是 MySQL 排的（按键长/字节重排），而**快照哈希算的是这一份**，
 * 前端 `utils/snapshot.ts` 的 `termsOf` 也按 {@link EMPTY_TERMS} 的顺序重建——三处必须逐字同序。
 *
 * @param {unknown} raw DB 读回的列值（⚠️ 不是列原文，见 `assertParsedJsonColumn`）
 * @returns {{handling_days: number|null, return_policy: string, return_window_days: number|null, return_freight: string|null, invoice_supported: boolean|null}}
 */
export function parseTermsColumn(raw) {
  const v = assertParsedJsonColumn(raw, 'products.terms');
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...EMPTY_TERMS };
  return {
    handling_days: Number.isInteger(v.handling_days) && v.handling_days > 0 ? v.handling_days : null,
    return_policy: RETURN_POLICIES.includes(v.return_policy) ? v.return_policy : 'unspecified',
    return_window_days: Number.isInteger(v.return_window_days) && v.return_window_days > 0 ? v.return_window_days : null,
    return_freight: RETURN_FREIGHTS.includes(v.return_freight) ? v.return_freight : null,
    invoice_supported: typeof v.invoice_supported === 'boolean' ? v.invoice_supported : null,
  };
}
