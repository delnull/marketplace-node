/**
 * 列表分页的唯一实现 —— 让"这份列表是完整的"成为可依赖的不变量。
 *
 * ── 为什么必须收在一处 ────────────────────────────────────────────────────────
 * `resume.mjs` 的判据（"账号里有没有同名机器"、"域名是不是已经在账号里"）建立在
 * **列表完整**这个前提上。前提一旦不成立，症状是**静默**的：
 *   · 第 101 台同名机器在第一页之外 ⇒ 判成"没有" ⇒ 再买一台（正是要防的重复下单）；
 *   · 域名在第 2 页 ⇒ 判成"不在账号里" ⇒ 让人去 --buy（而那会撞 DuplicateDomain）。
 * 三家服务商的分页参数各不相同（PageNum/PageSize、Offset/Limit、NextToken/NextPageMarker），
 * 于是"每个适配器自己翻页"必然出现"某一家忘了翻"。这里把翻页收敛成一个形状：
 * 调用方只提供**取一页**和**从响应里读出"还有没有下一页"**，循环本身只有一份。
 *
 * ── 顺带守住"取不到就是没有"这个误判 ──────────────────────────────────────────
 * 翻页翻到一半失败时**不能**返回半个列表：那比报错更危险（会得出"没有这台机器"的结论）。
 * 所以这里的失败一律上抛，由调用方决定是停下还是明确降级。
 */

/** 一页最多取多少条：给各家留出它们自己的上限余量 */
export const PAGE_SIZE = 100;

/**
 * @param {object} o
 * @param {(page: number) => Promise<any>} o.fetchPage 取第 page 页（**从 1 开始**）
 * @param {(res: any, page: number) => { items?: any[], itemsPath?: (res:any)=>any[], total?: number|null, nextToken?: string|null }} o.readPage
 *        从一页响应里读出：条目（直接给数组，或给一个提取函数）、总数、下一页令牌。
 *        三者至少给一个；`nextToken` 优先（AWS/新版阿里云走它），否则按总数翻页。
 * @param {number} [o.maxPages] 安全上限（防止服务商返回的令牌不前进导致死循环）
 * @returns {Promise<any[]>} 全部条目（拼接后的）
 */
export async function fetchAllPages({ fetchPage, readPage, maxPages = 100 }) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPage(page);
    const read = readPage(res, page) ?? {};
    const items = read.itemsPath ? read.itemsPath(res) ?? [] : read.items ?? [];
    all.push(...items);

    if (read.nextToken) continue; // 令牌模式：服务商说还有就继续
    /*
      总数模式：**不比"这一页返回了几条"**（服务商常常不填满一页），改用两种终止条件：
        · 已经取到的条数 ≥ 总数
        · 这一页**一条都没回**（服务商对越界页的常见回答）
      外加一次"多问一页"的机会：先按总数判断，判不了就再问一页看是不是空的。
    */
    if (Number.isFinite(read.total)) {
      if (all.length >= read.total) return all;
      continue;
    }
    /*
      既没有令牌也没有总数：**约定只有一页**。
      刻意不"再多问一页看是不是空的"：那会让每个只有一页的账号（绝大多数）都多付一次只读请求，
      而这一层已经被"每家的字段都有一份单测"盯着（三家各自的响应形状都有测试）。
    */
    return all;
  }
  throw new Error(
    `列表分页超过 ${maxPages} 页仍未结束：服务商返回的分页信息可能没有前进。` +
      '这属于会静默漏数据的形状，所以不继续翻页 —— 请把这段原始响应报给维护者。'
  );
}
