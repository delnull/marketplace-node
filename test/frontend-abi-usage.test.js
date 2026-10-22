/**
 * 前端**调用点 → ABI 声明**的守卫：`ethers.Contract` 的方法在 ABI 缺失时是
 * `undefined`，调用当场抛 TypeError——而它常被 `try/catch` 吞成"读不到"，
 * 于是界面表现为"权限/读数不可用"，而不是一个能定位的编译错误。
 *
 * 真实案例（2026-10，本轮全量验证抓到）：`useCaseCommittee` 读
 * `c.revokedArbiter(member)` 剔除已吊销的旧届仲裁人，但 `ESCROW_ABI` 漏声明这个 getter。
 * 结果整个 per-case 委员会读取进 catch ⇒ 仲裁台**所有行**的裁决按钮消失；页面同时还印着
 * "您属于当前届仲裁委员会"——看起来像权限被收回，实际是 ABI 漂移。
 *
 * 判据：消费 Escrow 的那两份文件里，对 `c` / `escrow` 的方法调用名必须逐个出现在
 * `frontend/src/chain.ts` 的 `ESCROW_ABI` 里。**不要求** ABI 覆盖合约全部函数
 * （钱包只声明自己会用的那些），只要求"用到的都在"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES = [
  'frontend/src/pages/arbiter/useCaseCommittee.ts',
  'frontend/src/api/escrowTx.ts',
  'frontend/src/chain.ts',
];
const guard = SOURCES.every((f) => fs.existsSync(path.join(ROOT, f))) ? test : test.skip;

guard('前端 Escrow 调用点用到的每个方法都在 ESCROW_ABI 里声明', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const chainSrc = read('frontend/src/chain.ts');
  const block = chainSrc.match(/(?:export\s+)?const ESCROW_ABI = \[([\s\S]*?)\n\]\s*as const;/);
  assert.ok(block, '找不到 ESCROW_ABI 声明块——检查 frontend/src/chain.ts 的形状');
  const declared = new Set(
    [...block[1].matchAll(/function\s+([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1])
  );

  const missing = [];
  for (const rel of ['frontend/src/pages/arbiter/useCaseCommittee.ts', 'frontend/src/api/escrowTx.ts']) {
    const src = read(rel);
    /* `escrow` 在 chain.ts 里也可能是别的变量；只扫这两份明确消费 Escrow 的文件 */
    for (const m of src.matchAll(/\b(?:c|escrow)\.([A-Za-z_]\w*)\(/g)) {
      if (!declared.has(m[1])) missing.push(`${rel}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)].sort(), [], 'ESCROW_ABI 漏声明了调用点用到的方法');
});
