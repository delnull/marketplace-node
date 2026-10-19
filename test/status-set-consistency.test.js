/**
 * 订单状态集一致性（源码评审 2026-09，防"加一个状态要改 N 处"这类静默失效）。
 *
 * 为什么要有这个测试：`orders.status` 的权威定义只有一处——`db.js` 建表语句里的
 * `CHECK (status IN (...))`；但**用**到状态集合的地方散落在十几个文件里：内联字面量
 * （`status IN ('escrowed','shipped','disputed')`）、模板常量（`escrowWatcher.js` 的 `FROM_SET`）、
 * 以及导出的数组（`PII_ERASABLE_STATUS` / `INCOME_STATUS` / `REVIEWABLE_STATUS` / `EVIDENCE_OPEN_STATUS`…）。
 * 这些集合必须互相自洽，否则出错方式**全都是静默的**：
 *   · 状态名拼错（`'shiped'`）⇒ 那条 SQL 永远匹配 0 行：事件照扫、状态照旧、没有任何报错；
 *   · 新增一个状态却漏进某个集合 ⇒ 某些单永远迁移不到（例如某状态不在 FROM_SET 里，
 *     `OrderExpiredReleased` 就永远改不动它）；
 *   · 写错目标状态（`SET status = 'setled'`）⇒ 直接被 CHECK 约束拒（这条会报错，但仍要拦住）。
 * 现在这些都由本测试在 CI 里拦住，不靠人记。
 *
 * 三条判据（都从源码/模块读，不硬编码状态名）：
 *   ① `db.js` 的 CHECK 列表 = 权威集合 CANON；至少 9 个状态（防止正则失效导致空集假通过）；
 *   ② 任何"作用于 orders 的 `status IN (...)`"字面量与 `FROM_SET` ⇒ 每个 token ∈ CANON、无重复；
 *   ③ 任何 `SET status = '<字面量>'` ⇒ ∈ CANON；导出的状态数组 ⇒ 每个元素 ∈ CANON。
 * 另有**下限断言**：扫到的列表数量不得低于阈值——否则"正则一夜之间匹配不到东西"会变成假绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** 递归收集 src 下的 .js（排除测试与 node_modules——src 里本来也没有） */
function srcFiles(dir = SRC) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(path.join(SRC, '..'), p).replace(/\\/g, '/');
const texts = new Map(srcFiles().map((p) => [rel(p), fs.readFileSync(p, 'utf8')]));

/**
   * 权威集合：db.js 建表语句里 `orders.status` 的 **ENUM 值域**。
   *
   * MySQL 8 把闭合集合落成 ENUM（值域写在列定义里、占 1 字节、SHOW COLUMNS 自带文档），
   * 旧形状的 `CHECK (status IN (…))` 整条没了——所以这里按**列定义**取，取不到就响亮失败
   * （"正则变成空集"必须比"守卫静默放行"先被发现）。
   */
  function canonStatuses() {
    const t = texts.get('src/db.js');
    const m = t.match(/status\s+ENUM\(([^)]*)\)\s+NOT NULL\s+DEFAULT\s+'draft'/);
    assert.ok(m, 'db.js 里必须能找到 orders.status 的 ENUM 定义（找不到说明建表语句被改写了，先看这里）');
    return m[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
  }

const CANON = canonStatuses();

test('权威集合（db.js 的 ENUM 值域）覆盖全部 9 个订单状态', () => {
  assert.equal(CANON.length, 9, `期望 9 个状态，实际 ${CANON.length}：${CANON.join('/')}`);
  for (const s of ['draft', 'escrowed', 'shipped', 'confirmed', 'disputed', 'settled', 'refunded', 'expired', 'cancelled']) {
    assert.ok(CANON.includes(s), `权威集合缺少 ${s}`);
  }
});

/**
 * 扫描"作用于 orders 的 status IN (...)"。
 * 用**整份文件文本**匹配（SQL 模板会跨行），再判断这条语句里的 `status` 属于哪张表——
 * `order_returns`（退货单）与 `product_codes`（码池）也有同名的 `status` 列，
 * 它们各有一套状态，不能混进来。建表语句里的 `CHECK (...)` 直接跳过（那是 schema 定义，
 * 权威集合由第一个用例单独断言）。
 *
 * 判表规则（三条，先看触发器伪行、再看限定名、最后看最近的 FROM/JOIN）：
 *   ① **触发器伪行**（`OLD.status` / `NEW.status`）⇒ 属于触发器**挂在哪张表上**（`AFTER UPDATE ON orders`）。
 *      触发器里那批状态字面量是"加一个状态漏改一处"最贵的地方（订单离开在途集合时的池占位减量
 *      就在那里，漏改的后果是永久多占/少占，而没有任何报错）——只按"最近的 FROM/JOIN"判表会把它们
 *      整批漏在守卫之外（它们的最近表是 `products` / `order_delivery_items`）。
 *   ② **列被限定**（`r.status`）⇒ 按别名反查它绑定的表。多店改造后出现了
 *      `FROM order_returns r JOIN orders o ON … WHERE r.status IN ('open','shipped')`
 *      这种形状：最近的表是 orders，但被判的列明明是 r.status（属于退货单）。
 *      只看"最近的表"会把退货单自己的状态误判成 orders 的状态 —— 那是**守卫误报**，
 *      而误报的代价是下一个人把守卫放宽（真正的漂移就再也拦不住了）。
 *   ③ 未限定 ⇒ 沿用"最近的 FROM/UPDATE/JOIN 表"，与既有实现一致。
 */
function collectOrdersInLists() {
  const found = [];
  for (const [file, text] of texts) {
    /*
      `NOT IN` 一起扫：它拼的是**同一个集合的补集**（"订单离开在途集合"那半边就在触发器里），
      漏改它的后果与漏改 `IN` 一模一样（占位永久不释放/永久多占），而且更隐蔽——
      只扫 `IN` 的话，这半边字面量在整个守卫之外，加一个状态时没有任何东西会红。
    */
    for (const m of text.matchAll(/status\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi)) {
      const head = text.slice(Math.max(0, m.index - 400), m.index);
      if (/CHECK\s*\($/.test(head.trimEnd())) continue; // schema 的 CHECK 约束（db.js 建表）
      if (/CHECK\s*\([^)]*$/.test(head.slice(-120))) continue;
      const tables = [...head.matchAll(/\b(?:from|update|join)\s+([a-z_]+)/gi)].map((x) => x[1].toLowerCase());
      const qual = /([A-Za-z_]\w*)\s*\.\s*$/.exec(head);
      let table = tables[tables.length - 1];
      if (qual && /^(?:old|new)$/i.test(qual[1])) {
        // 在**整份文件**里回看最近一个触发器头（不用 400 字窗口：触发器体比窗口长，
        // 一旦回看不到就会把这一处静默漏掉——那正是本测试要消灭的那种失效）
        const t = /(?:after|before)\s+(?:insert|update|delete)\s+on\s+([a-z_]+)/gi;
        const upto = text.slice(0, m.index);
        let last = null;
        for (const x of upto.matchAll(t)) last = x[1];
        table = last ? last.toLowerCase() : table;
      } else if (qual) {
        const aliasMap = new Map();
        for (const j of head.matchAll(/\b(?:from|join)\s+([a-z_]+)(?:\s+(?:as\s+)?([a-z_]\w*))?/gi)) {
          const t = j[1].toLowerCase();
          const a = (j[2] || t).toLowerCase();
          // 别名的下一个词若是 SQL 关键字（on/where/…），说明它其实没写别名（形如 `FROM orders WHERE`）
          if (/^(on|where|and|or|group|order|limit|join|left|inner|using|set)$/.test(a)) aliasMap.set(t, t);
          else aliasMap.set(a, t);
        }
        if (aliasMap.has(qual[1].toLowerCase())) table = aliasMap.get(qual[1].toLowerCase());
      }
      // `v_orders` 是 orders 的读模型（同一份 status 列），写在它上面的字面量同样会静默腐烂
      if (table !== 'orders' && table !== 'v_orders') continue; // 退货单/码池/店铺申请另有一套状态
      const raw = m[1];
      // 占位符列表（`IN (${marks})`）没有字面量：它的内容由数组断言覆盖，这里跳过
      if (/\$\{|`/.test(raw)) continue;
      const tokens = [...raw.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      if (!tokens.length) continue;
      found.push({ file, tokens, snippet: raw.replace(/\s+/g, ' ').slice(0, 120) });
    }
  }
  return found;
}

test('所有"作用于 orders 的 status IN (...)"只用权威集合里的状态、且无重复', () => {
  const lists = collectOrdersInLists();
  // 下限：真实代码里有 10+ 处；写成阈值是为了"正则失效 ⇒ 列表变空"时立刻变红（假绿比红更坏）
  assert.ok(lists.length >= 8, `扫到的 orders 状态列表只有 ${lists.length} 处，低于下限 8：正则或代码结构变了，先看本测试的扫描逻辑`);
  const bad = [];
  for (const l of lists) {
    const unknown = l.tokens.filter((t) => !CANON.includes(t));
    if (unknown.length) bad.push(`${l.file}: 出现未知状态 ${unknown.join('/')} —— IN (${l.snippet})`);
    const dup = l.tokens.filter((t, i) => l.tokens.indexOf(t) !== i);
    if (dup.length) bad.push(`${l.file}: 列表内重复 ${[...new Set(dup)].join('/')}`);
  }
  assert.deepEqual(bad, [], `状态名必须取自 db.js 的 CHECK 约束：\n${bad.join('\n')}`);
});

test('FROM_SET 常量（watcher 里"可被终局事件改写"的来源集）⊆ 权威集合', () => {
  const t = texts.get('src/escrowWatcher.js');
  const m = t.match(/const FROM_SET = "\(([^)]*)\)"/);
  assert.ok(m, 'escrowWatcher.js 里应有 FROM_SET 常量（若被改名，请同步本测试）');
  const tokens = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.ok(tokens.length >= 5, `FROM_SET 只解析出 ${tokens.length} 个状态：解析逻辑可能失效`);
  for (const s of tokens) assert.ok(CANON.includes(s), `FROM_SET 含未知状态 ${s}`);
});

test('任何 `UPDATE orders … SET status = 字面量` 的写入都是合法状态', () => {
  const bad = [];
  let hits = 0;
  for (const [file, text] of texts) {
    for (const u of text.matchAll(/UPDATE\s+orders\b/gi)) {
      const seg = text.slice(u.index, u.index + 400);
      const m = seg.match(/SET\s+status\s*=\s*'([a-z_]+)'/i);
      if (!m) continue;
      hits += 1;
      if (!CANON.includes(m[1])) bad.push(`${file}: UPDATE orders SET status = '${m[1]}' 不在 status 的 ENUM 值域里`);
    }
  }
  assert.ok(hits >= 5, `扫到的 orders 状态写入只有 ${hits} 处，低于下限 5：扫描正则可能失效`);
  assert.deepEqual(bad, []);
});

test('导出的状态数组（擦除/入账/可评价/证据开放）⊆ 权威集合', async () => {
  const { PII_ERASABLE_STATUS, PII_PROTECTED_STATUS } = await import('../src/piiErase.js');
  const { REVIEWABLE_STATUS } = await import('../src/reviews.js');
  const { EVIDENCE_OPEN_STATUS } = await import('../src/evidenceFiles.js');
  const arrays = {
    PII_ERASABLE_STATUS,
    PII_PROTECTED_STATUS,
    REVIEWABLE_STATUS,
    EVIDENCE_OPEN_STATUS,
  };
  for (const [name, arr] of Object.entries(arrays)) {
    assert.ok(Array.isArray(arr) && arr.length > 0, `${name} 应是非空数组`);
    for (const s of arr) assert.ok(CANON.includes(s), `${name} 含未知状态 ${s}`);
  }
  // 擦除面与保护面互斥且并集 = 全部状态：新状态必须被显式归类（同款断言也见于 pii-erase.test.js，
  // 这里再从"权威集合"这一侧复核，避免两边各自维护一份世界观）
  assert.deepEqual([...PII_ERASABLE_STATUS, ...PII_PROTECTED_STATUS].sort(), [...CANON].sort());
});

/**
 * `src/orderStatus.js` 是集合的唯一出处（2026-09 抽取）：它自己也要被同一把尺子量。
 * 三条：① 每个导出数组 ⊆ CANON；② `ORDER_STATUS` 与 db.js 的 CHECK **顺序也一致**
 * （顺序是权威定义的书写顺序，改了要说一声）；③ 预拼的 SQL 片段必须等于 `sqlIn(对应数组)`
 * ——防止有人手改了片段却忘了改数组（那会让"常量"与"实际查询"悄悄分叉）。
 */
test('orderStatus.js 的集合与 SQL 片段自洽（抽取后的新护栏）', async () => {
  const mod = await import('../src/orderStatus.js');
  const { ORDER_STATUS, ACTIVE_STATUS, PRE_PAID_STATUS, DRAFT_OR_ACTIVE_STATUS, INCOME_STATUS, PII_ERASABLE_STATUS, PII_PROTECTED_STATUS, sqlIn, ACTIVE_IN, PRE_PAID_IN, DRAFT_OR_ACTIVE_IN, INCOME_IN } = mod;

  assert.deepEqual([...ORDER_STATUS], [...CANON], 'ORDER_STATUS 必须与 db.js 的 ENUM 逐字同序');
  const sets = {
    ACTIVE_STATUS,
    PRE_PAID_STATUS,
    DRAFT_OR_ACTIVE_STATUS,
    INCOME_STATUS,
    PII_ERASABLE_STATUS,
    PII_PROTECTED_STATUS,
  };
  for (const [name, arr] of Object.entries(sets)) {
    assert.ok(Array.isArray(arr) && arr.length > 0, `${name} 应是非空数组`);
    for (const s of arr) assert.ok(CANON.includes(s), `${name} 含未知状态 ${s}`);
    assert.equal(new Set(arr).size, arr.length, `${name} 内部不得重复`);
  }
  assert.equal(ACTIVE_IN, sqlIn(ACTIVE_STATUS));
  assert.equal(PRE_PAID_IN, sqlIn(PRE_PAID_STATUS));
  assert.equal(DRAFT_OR_ACTIVE_IN, sqlIn(DRAFT_OR_ACTIVE_STATUS));
  assert.equal(INCOME_IN, sqlIn(INCOME_STATUS));
  // 片段只能由常量拼出（不接受任何外部输入）——这里顺手确认它确实是 `('a','b')` 这种形状
  assert.match(ACTIVE_IN, /^\('escrowed','shipped','disputed'\)$/);
});
