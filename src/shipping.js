/**
 * 物流要素（**承运方名称**）的归一与上限——**唯一实现**。
 *
 * 为什么单独一处：同一份"店主/买家填的承运方"有三个写入入口（单笔发货 `POST /:id/ship`、
 * 批量发货 `POST /seller/batch-ship`、退货单回填 `POST /:id/return/tracking`），
 * 每个入口各写一遍 trim/长度/空串处理必然漂移——而漂移的表现是"同一个承运方在三个入口
 * 存成了三种字符串"（`''` / `' 顺丰 '` / `null`），下游（前端按名称识别承运方并拼查询链接）
 * 就得为每种写法各兜一次，且永远兜不全。
 *
 * 三条口径：
 *  1. **空串/空白/非字符串 = 未填 ⇒ `null`**（三态纪律：没填就是"没有这个事实"，
 *     不是空串、更不是"其他"这种凭空造出来的值）；
 *  2. **上限 {@link CARRIER_MAX_LEN} 字符**：承运方名称是人手填的短文本，最长的一类
 *     （"全球邮政特快专递"）也只有 8 个字；40 已经覆盖任何正经名称，再长只可能是
 *     误填/把说明文字写进来了。超长**截断**而不是拒绝——与 `tracking_no` 同款：
 *     它是展示与查询辅助字段，不是资金要素，不该因为它让整笔发货失败；
 *  3. 去掉控制字符（`\x00-\x1f`）：它会进 JSON 响应、也可能被拼进查询链接，
 *     留着只会制造看不见的差异（同 `evidenceFiles.validateFileMeta` 对文件名的清洗口径）。
 *
 * 与前端的分工：前端 `utils/shipTrack.ts` 按这张表识别承运方（label/别名，去空白与
 * `·`/`.`/`-`/括号后比较），**识别不出就不拼 URL**、只给可复制单号。所以节点侧只做
 * "如实存下用户填的那个名称"，不做名称到承运方的归一或校验——那是展示层的判据，
 * 节点替它归一就会把"店主写的到底是什么"这个事实抹掉。
 */

/**
 * 承运方名称长度上限（字符）。
 * 依据：常见承运方名称 2~8 个字（"顺丰速运"/"全球邮政特快专递"），国际件名稍长；
 * 40 是"绝无正经名称会被截断"的宽松上界，同时挡住把说明文字塞进这一格。
 */
export const CARRIER_MAX_LEN = 40;

/**
 * 承运方名称归一：`undefined`/`null`/空串/纯空白 → `null`（未填）；否则去掉控制字符、
 * 去首尾空白、截断到 {@link CARRIER_MAX_LEN}。
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeCarrier(raw) {
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, CARRIER_MAX_LEN);
}
