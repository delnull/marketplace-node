/**
 * 擦除范围（"什么会被擦、什么**刻意保留**"）—— 多份文档与实现之间的**漂移守卫**。
 *
 * ── 为什么值得单独一条测试 ────────────────────────────────────────────────
 * 这是一份**对用户的承诺**，而且同时印在三份文档里：
 *   · `docs/DEPLOY_NODE.md`（部署方口径）、`docs/OPS_RUNBOOK.md`（运维口径）、
 *   · `node/docs/COMPLIANCE.md` §4（**店主/买家看得见的那一份**，随公开仓发布）。
 * 加上实现处的文件头（`node/src/piiErase.js`），同一份清单有四个落点。
 * 谁少一项、谁多说一项，都不会有任何东西报错——而后果是当事人按错误的预期行事：
 * 买家以为"删了个人信息等于这单没了"，或店主以为"评价正文也会被擦掉"而向买家作了虚假承诺。
 *
 * ── 这条测试查什么、不查什么 ──────────────────────────────────────────────
 * 查：**保留清单**必须逐项出现在上述每一处；**在途状态集合**（不可擦）必须在文档与
 *     `orderStatus.js` 的唯一集合里对得上；"不等于这一单从系统里消失"这句结论必须在店主档里。
 * 不查：文档的排版与措辞（各读者面本来就不同），也不查每份文档包含**全部**细节——
 *     给不同读者的文档允许只讲对他重要的部分，但**不许把保留清单讲少**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** 仓库根：从测试文件向上找带 `contracts/src` 的那一层（编译产物层级会变，写死会脆） */
function repoRoot() {
  let dir = path.resolve(import.meta.dirname);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'contracts', 'src'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`找不到仓库根（从 ${import.meta.dirname} 向上 6 层没有 contracts/src）`);
}
const ROOT = repoRoot();
const read = (rel) => {
  const p = path.join(ROOT, rel);
  assert.ok(fs.existsSync(p), `文档不在预期位置：${rel}（若它被改名/移动，本测试与文档索引要同批改）`);
  return fs.readFileSync(p, 'utf8');
};

/** 归一：统一空白（文档里同一句可能跨行、或带 markdown 的强调标记） */
const norm = (s) => s.replace(/\*\*/g, '').replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n');

/** 三份对外文档 + 实现处（每一处都必须把"刻意保留"的清单讲全） */
const DOCS = {
  'docs/DEPLOY_NODE.md': norm(read('docs/DEPLOY_NODE.md')),
  'docs/OPS_RUNBOOK.md': norm(read('docs/OPS_RUNBOOK.md')),
  'node/docs/COMPLIANCE.md': norm(read('node/docs/COMPLIANCE.md')),
  'node/src/piiErase.js（实现处文件头）': norm(read('node/src/piiErase.js')),
};

/**
 * 刻意保留的清单。每项 = { 名称, 在**承诺那一段**里必须出现的匹配 }。
 *
 * ⚠️ 断言**不能**写成"整篇文档包含这个词"（第一版就是这么写的，变异测试当场证明它挡不住）：
 * 同一份文档里"评价正文"还会出现在数据保留表等别处，于是把**承诺清单本身删掉**也照样通过。
 * 所以这里先按关键词切出"讲这件事的那一段"，再要求该段内逐项出现——
 * 锚词取各文档里表示"这些不动/这些保留"的说法（见 ANCHORS）。
 */
const PRESERVED = [
  { name: '金额与退款额', re: /金额|金额与退款额/ },
  { name: '订单状态', re: /状态/ },
  { name: '链上托管单号', re: /托管单号|链上单号/ },
  { name: '支付凭证/交易哈希', re: /支付凭证|支付交易哈希|支付哈希/ },
  { name: '链上事件史', re: /事件史/ },
  { name: '物流单号', re: /物流单号/ },
  { name: '退货单地址与备注', re: /退货(单)?地址|退货单地址与备注|退货备注/ },
  { name: '已交付的码 / tokenId', re: /tokenId|已交付的码|兑换码/ },
  { name: '评价正文', re: /评价正文|评价（不含个人信息的部分）/ },
];

/** 各文档里"承诺段"的锚词（该段必须逐项讲全保留清单） */
const ANCHORS = {
  'docs/DEPLOY_NODE.md': /刻意保留/,
  'docs/OPS_RUNBOOK.md': /刻意不擦/,
  'node/docs/COMPLIANCE.md': /刻意保留/,
  'node/src/piiErase.js（实现处文件头）': /一律不动/,
};

/**
 * 把"承诺所在的那一小节"切出来：锚词**所在**的 markdown 小节（上一个标题行 → 下一个标题行）。
 *
 * 为什么不取"锚词之后 N 字"：清单经常写在锚词**之前**——COMPLIANCE §4 的表头是"刻意保留的内容"、
 * 逐项在下面的表格行里；`piiErase.js` 的清单在"一律不动"这句话的**前半句**。
 * 按小节切的前提是"这一节讲的就是这件事"，于是"删掉清单里的一项"必然落在窗口内 ⇒ 测试会红；
 * 而整篇包含检查会把别处的同名词也算进来（第一版的教训，变异测试当场证明它挡不住）。
 */
function promiseSpan(text, anchor, file) {
  const m = anchor.exec(text);
  assert.ok(m, `${file} 里找不到"承诺段"的锚词（${anchor}）——文档改写后要么补回锚词、要么同批改本测试`);
  const lines = text.split('\n');
  let hit = -1;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (m.index >= offset && m.index < offset + lines[i].length + 1) {
      hit = i;
      break;
    }
    offset += lines[i].length + 1;
  }
  assert.ok(hit >= 0, `${file}：锚词定位失败（归一化后行号对不上）`);
  const isHeading = (l) => /^#{1,6}\s/.test(l.trim());
  let start = hit;
  while (start > 0 && !isHeading(lines[start])) start--;
  let end = hit + 1;
  while (end < lines.length && !isHeading(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

test('"刻意保留"清单必须完整存在于**正主**处（实现文件头与两份讲全的文档）', () => {
  const BEARERS = [
    'node/src/piiErase.js（实现处文件头）',
    'node/docs/COMPLIANCE.md',
    'docs/DEPLOY_NODE.md',
  ];
  const missing = [];
  for (const file of BEARERS) {
    const span = promiseSpan(DOCS[file], ANCHORS[file], file);
    for (const item of PRESERVED) {
      if (!item.re.test(span)) missing.push(`${file} 的承诺段里没有「${item.name}」`);
    }
  }
  assert.deepEqual(missing, [], `这几处是清单的正主，必须讲全（当事人按它行事）：\n  ${missing.join('\n  ')}`);
});

/*
  "委托指针"是合法的：`OPS_RUNBOOK.md` 只列了四项，并写明"完整擦除范围…见 node/src/piiErase.js 文件头"。
  但**声明"完整在这里"的文档不许讲漏**——那是另一种谎：读者以为按它列的做就够，实际少了几类数据。
  所以这一条查：凡是自称"完整/刻意保留"的地方，要么列全，要么明确指向正主（且正主真的讲全，见上一条）。
*/
test('自称"完整清单"的文档必须列全，或明确指向正主（不许讲漏还自称完整）', () => {
  const problems = [];
  for (const [file, text] of Object.entries(DOCS)) {
    if (file === 'node/src/piiErase.js（实现处文件头）') continue; // 正主由上一条守
    const m = /完整[^。\n]{0,80}(刻意不擦|刻意保留|擦除范围)/.exec(text);
    if (!m) continue; // 没自称"完整"，不适用
    // 它自称完整：看它在同一小节里是列全了，还是把清单委托给了正主
    const span = promiseSpan(text, /完整[^。\n]{0,80}(刻意不擦|刻意保留|擦除范围)/, file);
    const missing = PRESERVED.filter((i) => !i.re.test(span)).map((i) => i.name);
    if (missing.length === 0) continue; // 讲全了，通过
    const delegates = /见\s*`?node\/src\/piiErase\.js/.test(span);
    if (!delegates) {
      problems.push(`${file}：自称"完整"却漏了 ${missing.join('、')}，且没有指向 node/src/piiErase.js`);
    }
  }
  assert.deepEqual(problems, [], `自称完整却不完整，读者会按它少列的那份清单行事：\n  ${problems.join('\n  ')}`);
});

test('"在途不可擦"的状态集合：文档说法必须与 orderStatus.js 的唯一集合对得上', async () => {
  const { PII_ERASABLE_STATUS, PII_PROTECTED_STATUS } = await import('../src/orderStatus.js');
  const protectedZh = { draft: '草稿', escrowed: '已托管', shipped: '已发货', disputed: '争议中' };
  const erasableZh = { confirmed: '已确认收货', settled: '已结算', refunded: '已退款', expired: '已超时释放', cancelled: '已取消' };

  // 两份集合必须互补且覆盖全部状态（漏一个 ⇒ 那一类单既不被拒也不会被擦，静默）
  assert.deepEqual(
    [...PII_ERASABLE_STATUS, ...PII_PROTECTED_STATUS].sort(),
    [...(await import('../src/orderStatus.js')).ORDER_STATUS].sort(),
    '可擦 ∪ 受保护 必须等于全部订单状态'
  );

  const shopDoc = DOCS['node/docs/COMPLIANCE.md'];
  for (const st of PII_PROTECTED_STATUS) {
    assert.ok(shopDoc.includes(protectedZh[st]), `店主档必须点明在途状态「${protectedZh[st]}」不能擦（否则店主会以为可以）`);
  }
  for (const st of PII_ERASABLE_STATUS.filter((s) => s !== 'cancelled')) {
    assert.ok(shopDoc.includes(erasableZh[st]), `店主档必须点明可擦的终局状态「${erasableZh[st]}」`);
  }
  // 弃单（cancelled）从未上链托管，店主档用"从未上链托管的弃单"表述它
  assert.match(shopDoc, /弃单/, '可擦集合里的 cancelled 要用店主看得懂的说法点到（弃单）');
});

test('结论句必须在店主档里：「删除个人信息」不等于这一单从系统里消失', () => {
  const shopDoc = DOCS['node/docs/COMPLIANCE.md'];
  assert.match(shopDoc, /不等于"?这一单从系统里消失|不等于这一单从系统里消失/, '这句是买家最容易误解的地方，店主档必须原样写着');
  // 且要告诉店主：这个口径必须对买家讲明（否则他读了也不知道要转达）
  assert.match(shopDoc, /对买家讲明|告知买家/, '要知道这句是要**转达给买家**的，不是店主自己知道就行');
});
