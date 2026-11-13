#!/usr/bin/env node
/**
 * 一次性迁移：给已在运行的节点补 `order_idempotency` 表。
 *
 * 新库由 `SCHEMA_DDL` 直接建好；已有库在升级前跑一次本脚本（`CREATE TABLE IF NOT EXISTS`，
 * 幂等，可重复执行）。表定义**只有** `src/db.js` 的 `ORDER_IDEMPOTENCY_DDL` 一份。
 *
 * 为什么不走 `initDb()`：它会先跑启动结构门禁，老库缺这张表会被门禁拒绝——
 * 而那正是本脚本要补的东西，顺序上跑不到建表。这里用一条普通连接直接执行 DDL。
 *
 * 用法（node/ 目录；连接参数与节点同一份口径 MK_DB_*）：
 *   node --env-file-if-exists=.env scripts/migrate-order-idempotency.mjs
 * 退出码：0 = 已就绪；1 = 连库/建表失败。
 */
import mysql from 'mysql2/promise';
import config from '../src/config.js';
import { assertDbConfigured, ORDER_IDEMPOTENCY_DDL } from '../src/db.js';

assertDbConfigured();
const { host, port, user, password, name } = config.db;

let conn;
try {
  conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database: name,
    charset: 'utf8mb4',
    multipleStatements: false,
    connectTimeout: 10_000,
  });
} catch (e) {
  if (e.code === 'ER_BAD_DB_ERROR') {
    console.error(`[migrate] 库 \`${name}\` 不存在（${host}:${port}）——全新部署不需要迁移，直接启动节点即可建库建表。`);
  } else {
    console.error(`[migrate] 连不上 MySQL（${host}:${port}，用户 ${user}）：${e?.message || e}`);
    console.error('  连接参数取自 MK_DB_HOST/MK_DB_PORT/MK_DB_USER/MK_DB_PASSWORD/MK_DB_NAME（见 .env）。');
  }
  process.exit(1);
}

try {
  await conn.query(ORDER_IDEMPOTENCY_DDL);
  /*
    早期跑过本脚本的库已有表、但没有 created_at 索引（CREATE TABLE IF NOT EXISTS 不会补索引）。
    启动结构门禁会拿 SCHEMA_DDL 对拍，缺索引会被拒；这里幂等地补一次。
  */
  const [idx] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'order_idempotency'
        AND INDEX_NAME = 'idx_order_idempotency_created' LIMIT 1`,
    [name]
  );
  if (!idx.length) {
    await conn.query('ALTER TABLE order_idempotency ADD INDEX idx_order_idempotency_created (created_at)');
    console.log('[migrate] 已补 order_idempotency(created_at) 索引');
  }
  console.log(`[migrate] \`${name}\` 的 order_idempotency 已就绪`);
} catch (e) {
  console.error(`[migrate] 建表失败：${e?.message || e}`);
  process.exitCode = 1;
} finally {
  await conn.end();
}
