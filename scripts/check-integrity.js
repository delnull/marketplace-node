#!/usr/bin/env node
/**
 * 交付一致性体检 CLI（源码评审 2026-09，P0-2）：判断"从旧备份恢复之后，码/NFT 的交付状态
 * 还自洽吗"。规则本体在 `src/integrity.js`（有单测），本文件只做：连库 → 打印 → 定退出码。
 *
 * 为什么需要：备份点**之后**新建的订单不会被 watcher 回填（它只 UPDATE 已有行、从不 INSERT），
 * 已发出的码在恢复后会回到 `unused`（同一码可被再发一次）。README/运维文档曾承诺"watcher 会继续
 * 扫链补写"——那句话对"状态回写"成立、对"订单行不存在"不成立。
 *
 * 用法（在 node/ 目录下，或 `npm run check:integrity`）：
 *   node scripts/check-integrity.js            # 打印全部问题
 *   node scripts/check-integrity.js --json     # 机器可读（CI/告警）
 *   MK_DB_HOST=… MK_DB_NAME=… node scripts/check-integrity.js
 *   （连接参数一律取 config.db = MK_DB_*，与节点本身同一份口径，不另设"体检专用"的库地址）
 *
 * 退出码：0 = 一致；2 = 发现不一致（与 reconcile-ledger.js 的"有差异"约定一致，便于脚本判读）；
 *        1 = 自身出错（连不上库等）。
 * 注意：**未哈希审计行（早于哈希链的历史行）不算"不一致"**，退出码仍为 0——它们是"无法校验"，
 * 不是篡改证据（三态纪律见 src/auditChain.js）；断裂才进 issues 并给 2。
 */
import mysql from 'mysql2/promise';
import config from '../src/config.js';
import { assertDbConfigured } from '../src/db.js';
import { findIntegrityIssues } from '../src/integrity.js';

const json = process.argv.includes('--json');

/**
 * 只读门面：`get`/`all` 照 `src/db.js` 的门面形状给，**`run` 直接抛错**。
 *
 * 为什么在脚本里再写一遍而不是 `initDb()` + `getDb()`：
 *  · `initDb()` 会 auto-create——库名写错/库还不存在时，它会**造一个空库**，于是本工具最该拦住的
 *    事故（"你查的不是那个库"）被报成"✓ 没有发现不一致"并以 0 退出，服务器上还多一个 ghost 库。
 *    所以这里用一条普通连接连上去，`ER_BAD_DB_ERROR` 原样变成一句可照做的提示。
 *  · `initDb()` 还要抢**节点实例锁**（GET_LOCK）：体检恰恰要在节点跑着的时候做，抢锁只能得到
 *    "另一个节点进程正在用这个库"然后退出。
 *  · "只读"由形状保证：这里没有写路径可给它，不是注释里的一句承诺。
 */
function readonlyFacade(conn) {
  return {
    async get(sql, ...params) {
      const [rows] = await conn.query(sql, params);
      return rows[0];
    },
    async all(sql, ...params) {
      const [rows] = await conn.query(sql, params);
      return rows;
    },
    async run() {
      throw new Error('check-integrity 是只读工具：不提供写入路径');
    },
  };
}

// 与节点启动同一道配置门禁（唯一实现在 src/db.js）：缺 MK_DB_* 时给出可照做的提示，
// 而不是等 mysql2 抛一句 ECONNREFUSED
assertDbConfigured();
const { host, port, user, password, name } = config.db;
let conn = null;
try {
  conn = await mysql.createConnection({
    host, port, user, password, database: name,
    charset: 'utf8mb4',
    /*
      读口径必须与 src/db.js **逐项一致**，否则"体检"看到的与节点看到的不是同一份数据：
        · decimalNumbers:false —— 金额列是 DECIMAL(38,0)，打开它会静默取整（38 位装不进 JS number）；
        · timezone:'Z' —— 时间列是 DATETIME(3)，会话时区与驱动时区必须同时钉在 UTC。
    */
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    timezone: 'Z',
    dateStrings: false,
    multipleStatements: false,
    connectTimeout: 10_000,
  });
} catch (e) {
  if (e.code === 'ER_BAD_DB_ERROR') {
    console.error(`[check-integrity] 库 \`${name}\` 不存在（${host}:${port}）。`);
    console.error('  体检工具不会替你新建一个空库——那会把"你查的不是那个库"报成绿。');
    console.error('  处置：确认 MK_DB_HOST/MK_DB_PORT/MK_DB_NAME 指向节点真正在用的那个库；');
    console.error('        若这是全新部署，先启动一次节点（它会建库建表）。');
  } else {
    console.error(`[check-integrity] 连不上 MySQL（${host}:${port}，用户 ${user}）：${e?.message || e}`);
    console.error('  连接参数取自 MK_DB_HOST/MK_DB_PORT/MK_DB_USER/MK_DB_PASSWORD/MK_DB_NAME（见 .env）。');
  }
  process.exit(1);
}

try {
  const db = readonlyFacade(conn);
  const { issues, counts, checked, auditChain } = await findIntegrityIssues(db);
  const target = `${name} @ ${host}:${port}`;

  if (json) {
    /*
      `counts` / `checked` **整对象透传**，不在这里挑字段：体检项还在增长（2026-10-17 新增了四个
      计数器的对拍及其 checked），手写字段清单会让"文本摘要印了新项、--json 还是旧形状"——下游 CI
      读到 undefined 只会当成 0，正是"静默通过"。字段清单唯一的家是 `findIntegrityIssues` 的返回
      形状（test/check-integrity-json.test.js 拿它与本输出逐键对拍）。代价：JSON 会随函数增长，
      这是想要的（多一个键不该需要改两处）。
    */
    console.log(JSON.stringify({ db: target, counts, checked, auditChain, issues }, null, 2));
  } else {
    console.log(`交付一致性体检（只读）：${target}`);
    console.log(
      `  已检查：交付行 ${checked.deliveryItems} · 已用码 ${checked.codesUsed} · 已交付 tokenId ${checked.nftUsed} · ` +
        `商品计数器 ${checked.productCounters} 个商品 · SKU 计数器 ${checked.skuCounters} 个组合 · hold_qty>0 的订单 ${checked.ordersWithHold}`
    );
    console.log(
      `  不一致：已交付但池里未标 used ${counts.codeDeliveredNotUsed}（码）/ ${counts.nftDeliveredNotUsed}（NFT）· ` +
        `池里 used 但无交付行 ${counts.codeUsedWithoutDelivery}（码）/ ${counts.nftUsedWithoutDelivery}（NFT）`
    );
    // 计数器漂移单独一行：它不报错、只能对拍发现——偏大 ⇒ 有件数永远卖不出去，偏小 ⇒ 超卖
    console.log(
      `  计数器：reserved_codes 漂移 ${counts.reservedCodesDrift} · reserved_tokens 漂移 ${counts.reservedTokensDrift} · ` +
        `committed 漂移 ${counts.committedDrift} · hold_qty 不等于 0/quantity ${counts.holdQtyMismatch} · ` +
        `占位找不到 SKU 行 ${counts.holdWithoutSku} · 不可对拍 ${counts.counterNotComparable}`
    );
    // 审计哈希链单独一行：它与上面的交付/计数器查的不是同一类故障（恢复旧库 vs 事后改审计）
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
          '\n  若这批数据来自旧备份：本项目为 greenfield，优先按 node/docs/OPERATIONS.md §2 重建库（DROP DATABASE 后由节点重建），' +
          '\n  再让节点从 MK_ESCROW_START_BLOCK 重新扫链；已交付但链上无据的码需要人工与买家核对。'
      );
      // 审计断裂**不能**跟着"删库重建"的处置走：那条建议会把要保护证据的那张表一起删掉。
      if (counts.auditChainBroken) {
        console.log(
          '  ⚠ 审计哈希链有断裂：先**原样保全证据**（导出 audit_logs 全表 + 记下上面的 head；' +
            '\n  开了 binlog 的部署还要连同备份一起留存，见 src/db.js 的 binlog_row_image 说明），' +
            '\n  再用备份比对"哪个时间点之后被改的"；重建库会连审计行一起删掉——那是证据，不是脏数据。'
        );
      }
    }
  }
  // 先关连接再退出：`process.exit()` 会立刻终止进程，写在 finally 里的 close 根本不会执行
  await conn.end().catch(() => {});
  process.exit(issues.length ? 2 : 0);
} catch (e) {
  console.error(`[check-integrity] 执行失败：${e?.message || e}`);
  await conn.end().catch(() => {});
  process.exit(1);
}
