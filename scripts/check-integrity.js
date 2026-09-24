#!/usr/bin/env node
/**
 * 交付一致性体检 CLI（源码评审 2026-09，P0-2）：判断"从旧备份恢复之后，码/NFT 的交付状态
 * 还自洽吗"。规则本体在 `src/integrity.js`（有单测），本文件只做：开库 → 打印 → 定退出码。
 *
 * 为什么需要：备份点**之后**新建的订单不会被 watcher 回填（它只 UPDATE 已有行、从不 INSERT），
 * 已发出的码在恢复后会回到 `unused`（同一码可被再发一次）。README/运维文档曾承诺"watcher 会继续
 * 扫链补写"——那句话对"状态回写"成立、对"订单行不存在"不成立。
 *
 * 用法（在 node/ 目录下，或 `npm run check:integrity`）：
 *   node scripts/check-integrity.js            # 打印全部问题
 *   node scripts/check-integrity.js --json     # 机器可读（CI/告警）
 *   MK_DB_FILE=/data/mk.db node scripts/check-integrity.js
 *
 * 退出码：0 = 一致；2 = 发现不一致（与 reconcile-ledger.js 的"有差异"约定一致，便于脚本判读）；
 *        1 = 自身出错（库打不开等）。
 * 注意：**未哈希审计行（早于哈希链的历史行）不算"不一致"**，退出码仍为 0——它们是"无法校验"，
 * 不是篡改证据（三态纪律见 src/auditChain.js）；断裂才进 issues 并给 2。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findIntegrityIssues } from '../src/integrity.js';

const json = process.argv.includes('--json');

/**
 * 库文件必须**已存在**（源码审计 2026-09 复审，P1）。
 *
 * 原先直接 `initDb()` → `new DatabaseSync(file)`：node:sqlite 会**创建**文件并建全部表，
 * 于是"库路径写错/库根本不存在"这种体检工具最该拦住的事故，被报成"✓ 没有发现不一致"
 * 并以退出码 0 结束——还在磁盘上留下一个空的 ghost.db（连 -wal/-shm）。文件头标的"只读"
 * 也不成立。现在先查存在性，再以 `readOnly` 打开（本工具只读，不需要建表，也不需要写权限）。
 */
const dbFile = String(process.env.MK_DB_FILE || 'marketplace-node.db');
const dbPath = path.resolve(dbFile);
if (!fs.existsSync(dbPath)) {
  console.error(
    `[check-integrity] 找不到数据库文件：${dbPath}\n` +
      '  （MK_DB_FILE 指向的库不存在。体检工具不会替你新建一个空库——那会把"你查的不是那个库"报成绿。）'
  );
  process.exit(1);
}

let db = null;
try {
  // 只读打开：体检不写任何东西（连建表都不需要），也不需要文件写权限
  db = new DatabaseSync(dbPath, { readOnly: true });
  const { issues, counts, checked, auditChain } = findIntegrityIssues(db);

  if (json) {
    console.log(JSON.stringify({ db: dbPath, counts, checked, auditChain, issues }, null, 2));
  } else {
    console.log(`交付一致性体检（只读）：${dbPath}`);
    console.log(
      `  已检查：交付行 ${checked.deliveryItems} · 已用码 ${checked.codesUsed} · 已交付 tokenId ${checked.nftUsed}`
    );
    console.log(
      `  不一致：已交付但池里未标 used ${counts.codeDeliveredNotUsed}（码）/ ${counts.nftDeliveredNotUsed}（NFT）· ` +
        `池里 used 但无交付行 ${counts.codeUsedWithoutDelivery}（码）/ ${counts.nftUsedWithoutDelivery}（NFT）`
    );
    // 审计哈希链单独一行：它与上面四条查的不是同一类故障（恢复旧库 vs 事后改审计）
    console.log(
      `  审计哈希链：${auditChain.ok ? '✓ 自洽' : `✗ 断裂 ${counts.auditChainBroken} 处`}` +
        `（已校验 ${auditChain.hashed}/${auditChain.entries} 行）` +
        (auditChain.unhashedCount
          ? ` · 未哈希 ${auditChain.unhashedCount} 行（早于哈希链，**无法校验**，不是篡改证据）`
          : '')
    );
    // 链头：盘外锚点。没有它，攻击者把尾部整段删掉（或从被改那行起整体重算哈希）是查不出来的——
    // 这是哈希链的固有边界，不是本工具的缺陷（见 src/auditChain.js 文件头"能查出什么/查不出什么"）。
    if (auditChain.hashed) {
      console.log(`  链头 head=${auditChain.head}`);
      console.log('    （把这一行抄到盘外留存：尾部被整段删掉时，只有它拦得住）');
    }
    if (!issues.length) {
      console.log('  ✓ 没有发现不一致：交付行与池状态自洽');
    } else {
      console.log('\n  逐条（码/tokenId 已打码，够定位不够直接用）：');
      for (const it of issues) console.log(`  · [${it.kind}] ${it.detail}`);
      console.log(
        '\n  处置建议：**不要**用脚本自动改（要先定"以链上已交付为准还是以池内状态为准"）。' +
          '\n  若这批数据来自旧备份：本项目为 greenfield，优先按 docs/OPS_RUNBOOK.md §1 重建库，' +
          '\n  再让节点从 MK_ESCROW_START_BLOCK 重新扫链；已交付但链上无据的码需要人工与买家核对。'
      );
      // 审计断裂**不能**跟着"删库重建"的处置走：那条建议会把要保护证据的那张表一起删掉。
      if (counts.auditChainBroken) {
        console.log(
          '  ⚠ 审计哈希链有断裂：先**原样保全证据**（连同 -wal/-shm 一起拷走库文件、记下上面的 head），' +
            '\n  再用备份比对"哪个时间点之后被改的"；重建库会连审计行一起删掉——那是证据，不是脏数据。'
        );
      }
    }
  }
  // 先关库再退出：`process.exit()` 会立刻终止进程，写在 finally 里的 close 根本不会执行
  try {
    db.close();
  } catch {
    /* 关闭失败不影响结论 */
  }
  process.exit(issues.length ? 2 : 0);
} catch (e) {
  console.error(`[check-integrity] 执行失败：${e?.message || e}`);
  try {
    db?.close();
  } catch {
    /* 关闭失败不影响退出码 */
  }
  process.exit(1);
}
