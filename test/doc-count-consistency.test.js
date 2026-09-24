/**
 * 文档计数自洽守卫（源码评审 2026-09 新增）。
 *
 * 为什么需要：本仓把"用例数"当成事实写在 5 处文档里（README ×2、ARCHITECTURE §5、
 * RELEASE_CHECKLIST 的 CI 行、FRONTEND_V4_GUIDE 的用例表），而且**每次加测试都要同步这 5 处**。
 * 人工同步已经错过一次：`RELEASE_CHECKLIST` 的前端清单漏了一整个文件（多行续行的枚举 + 单行声明，
 * 只改了声明没改明细），于是同一句话里写着 **181**、逐项加起来却是 **165**。
 * 文档说谎比不写数字更糟——尤其当那个数字是"CI 是不是全绿"的唯一书面依据时。
 *
 * 四条判据（都在同一行/同一段声明内自洽，不需要跑测试也能验）：
 *   ① `（**N**：A 28 + B 30 + …）`      声明在前，枚举在后；
 *   ② `（A 28 / B 30 / … = **N**）`     声明在后（前端用例表就是这种写法）；
 *   ③ `N 单测：…` / `N/ N（…）`         目录树与命令注释里的写法；
 *   ④ 枚举明细与声明值**必须相等**。
 * 两个解析坑（第一版都踩过，写在注释里免得下次重犯）：
 *   · 枚举会**跨行续行**（下一行以 `+` 开头，属于同一条）——必须先合并续行；
 *   · 同一行可能有**多处**独立声明（CI 那行同时写了 forge/node/frontend 三个数）——必须按声明切开，
 *     每处只看它自己括号里的那串"标签 数字"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 参与校验的文档（相对仓库根） */
const DOCS = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/RELEASE_CHECKLIST.md',
  'docs/FRONTEND_V4_GUIDE.md',
  'docs/DEPLOY_NODE.md',
];

/**
 * 本守卫只在"这几份文档都在这棵树里"时有意义：它校验的是它们内部"用例数"的声明与明细是否自洽。
 * 只有节点这一份代码时这些文档不在，于是**跳过而不是失败**——判据用文件存在性，
 * 两种目录布局下同一份代码都不需要改。
 */
const DOCS_PRESENT = DOCS.every((f) => fs.existsSync(path.join(ROOT, f)));
const guard = DOCS_PRESENT ? test : test.skip;

/** 合并 `+` 续行：`… 28 +\n  + 30 + …` 是**同一条**枚举 */
function joinContinuations(lines) {
  const out = [];
  for (const raw of lines) {
    if (/^\s*\+/.test(raw) && out.length) out[out.length - 1] += ` ${raw.trim()}`;
    else out.push(raw);
  }
  return out;
}

/** 一行里的"标签 数字"对（至少 3 对才算枚举，避免把普通句子当枚举） */
const pairsIn = (slice) =>
  [...slice.matchAll(/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]*)\s+(\d+)/g)].map((m) => ({ label: m[1], n: +m[2] }));

/** 一处"声明 + 枚举"的校验：返回问题描述（无问题返回 null） */
function checkDeclared(decl, slice, where) {
  const pairs = pairsIn(slice);
  if (pairs.length < 3) return null; // 不是枚举，跳过（避免误报）
  const sum = pairs.reduce((a, b) => a + b.n, 0);
  if (sum === decl) return null;
  return `${where}：声明 ${decl}，但明细 ${pairs.map((p) => `${p.label} ${p.n}`).join(' + ')} 求和 = ${sum}`;
}

/** 扫描一份文档，返回所有"声明 vs 明细"不一致 */
function inconsistencies(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const problems = [];
  joinContinuations(text.split(/\r?\n/)).forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    // ① 声明在前：`**N**：` / `N 单测` / `N/N（`
    for (const re of [/\*\*(\d+)\*\*\s*[：:]/g, /(\d+)\s*单测/g, /(\d+)\/\1（/g]) {
      for (const m of line.matchAll(re)) {
        const rest = line.slice(m.index + m[0].length);
        const end = rest.indexOf('）');
        const p = checkDeclared(+m[1], end >= 0 ? rest.slice(0, end) : rest, where);
        if (p) problems.push(p);
      }
    }
    // ② 声明在后：`（A 28 / B 30 / … = **N**）`
    for (const m of line.matchAll(/=\s*\*\*(\d+)\*\*/g)) {
      const head = line.slice(0, m.index);
      const start = head.lastIndexOf('（');
      if (start < 0) continue;
      const p = checkDeclared(+m[1], head.slice(start), where);
      if (p) problems.push(p);
    }
  });
  return problems;
}

guard('文档里的"用例数"与逐项明细必须自洽（5 处文档全查）', () => {
  const all = [];
  let checked = 0;
  for (const f of DOCS) {
    all.push(...inconsistencies(f));
    // 统计被真正检查过的声明数，防止"文档结构一改就再也匹配不到"的假绿
    const text = joinContinuations(fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)).join('\n');
    checked += (text.match(/\*\*(\d+)\*\*\s*[：:]/g) || []).length;
    checked += (text.match(/=\s*\*\*(\d+)\*\*/g) || []).length;
    checked += (text.match(/\d+\s*单测/g) || []).length;
    checked += (text.match(/\d+\/\d+（/g) || []).length;
  }
  assert.ok(checked >= 8, `只扫到 ${checked} 处用例数声明，低于下限 8：文档结构或正则变了，先看本测试`);
  assert.deepEqual(all, [], `文档里的数字对不上：\n${all.join('\n')}`);
});

guard('守卫本身能抓住"只改声明、忘改明细"这一类错（用一段构造文本自证）', () => {
  // 这一段正是当初真实漏项的形状：声明 181、明细求和 165
  const bad = '（**181**：金额拆分 28 + 仲裁裁决金额 30 + 部分退款授权 17 + 联邦查询范围 15 + 收据 11 + 汇率 9 + 快照 9 + 通知里程碑 9 + 订单通知文案 7 + 存证三态 10 + 罚没资格 5 + 下单请求体 5 + 凭证库 9 + 底座自检 1）';
  const tmp = path.join(ROOT, 'node', '.tmp-doc-count-fixture.md');
  try {
    fs.writeFileSync(tmp, bad, 'utf8');
    const problems = (() => {
      const text = fs.readFileSync(tmp, 'utf8');
      const out = [];
      for (const m of text.matchAll(/\*\*(\d+)\*\*\s*[：:]/g)) {
        const rest = text.slice(m.index + m[0].length);
        const end = rest.indexOf('）');
        const p = checkDeclared(+m[1], end >= 0 ? rest.slice(0, end) : rest, 'fixture');
        if (p) out.push(p);
      }
      return out;
    })();
    assert.equal(problems.length, 1, '构造的漏项必须被报出来（否则守卫形同虚设）');
    assert.match(problems[0], /声明 181/);
    assert.match(problems[0], /求和 = 165/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
