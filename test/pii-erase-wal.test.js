/**
 * PII 擦除的**两条腿**：文件库上的字节级判据 + "还欠清理"的重试队列。
 *
 * 为什么单开一个文件、而且用**真实文件库**：
 *  1. `pii-erase.test.js` 里那条"两条腿都在位"跑在 `:memory:` 库上，而内存库的
 *     `PRAGMA journal_mode = memory` ⇒ `wal_checkpoint(TRUNCATE)` 是**空操作**且回 `{busy:0}`，
 *     `checkpointTruncate()` 恒真、磁盘上根本没有 `-wal` 文件：那条断言**不可能失败**
 *     （2026-10-15 审计实测：把擦除路径里的 `checkpointTruncate()` 调用整个删掉，它照样绿）。
 *     判据必须挂在**真的会产生 WAL 的库**上，而且要看文件里的字节。
 *  2. "删盘/WAL 没成功 ⇒ 系统会在下一轮保留期扫描中自动重试"这句承诺，在此前是**假的**：
 *     候选判据是纯时间的（`MAX(pii_erased_at, updated_at) <= 截止`），而 `updated_at` 就是刚刚
 *     那一下 ⇒ 要等整个保留期（默认 180 天）才可能再被扫到，`MK_PII_RETENTION_DAYS=0` 则永远等不到。
 *     现在"还欠清理"落成 `orders.pii_cleanup_pending`，候选判据里带上 `OR pii_cleanup_pending = 1`：
 *     下面第二个用例就是**在同一个时间点上**再跑一轮扫描，验证它真的会被重试并清干净。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 与 test/setup.mjs 同款：禁外部网络、链上读取指向必然拒连的本地端口
process.env.MK_BTY_TTL_MS = '0';
process.env.MK_RPC_URL = 'http://127.0.0.1:1/';
globalThis.fetch = async () => {
  throw new Error('unit-test: 外部网络已禁用');
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-pii-wal-'));
const DB_FILE = path.join(TMP, 'node.db');
process.env.MK_DB_FILE = DB_FILE;
process.env.MK_ATTACH_DIR = path.join(TMP, 'attachments');

const { initDb, getDb, checkpointTruncate } = await import('../src/db.js');
const { eraseOrderPii, runPiiRetention } = await import('../src/piiErase.js');
const { orderAttachDir } = await import('../src/evidenceFiles.js');

const PHONE = '13900001234';
const ADDRESS = '北京市朝阳区探针路 100 号';
const NOTE = '探针备注：微信同号';

/** 读一个文件的原始字节（文件不存在时返回空串） */
function bytesOf(file) {
  try {
    return fs.readFileSync(file).toString('utf8');
  } catch {
    return '';
  }
}
const hasPII = (file) => {
  const s = bytesOf(file);
  return s.includes(PHONE) || s.includes(ADDRESS) || s.includes(NOTE);
};

let seq = 0;
/** 造一条**终局**订单 + 一条真实附件文件（附件才是盘上真正的个人数据） */
function makeTerminalOrderWithAttachment() {
  seq += 1;
  const id = `pii-wal-${String(seq).padStart(3, '0')}`;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
         amount_wei, usdt_micro, bty_usdt_rate, status, escrow_order_id, paid_tx_hash,
         shipping_name, shipping_phone, shipping_address, note, created_at, updated_at)
       VALUES (?, 'p', '{}', '0x00', '', '0xbuyer', '0xseller', '1000', 1000000, '0.1', 'confirmed', ?, ?,
               '张三', ?, ?, ?, ?, ?)`
    )
    .run(id, `0x${String(seq).padStart(64, '0')}`, `0x${String(seq + 100).padStart(64, '0')}`, PHONE, ADDRESS, NOTE, now, now);
  const dir = orderAttachDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const stored = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.txt';
  const file = path.join(dir, stored);
  fs.writeFileSync(file, `证据正文：电话 ${PHONE}，地址 ${ADDRESS}`, 'utf8');
  const ev = getDb()
    .prepare(
      `INSERT INTO dispute_evidence (order_id, role, phase, content, created_at)
       VALUES (?, 'buyer', 'refund_request', '陈述正文（含个人信息）', ?)`
    )
    .run(id, now);
  getDb()
    .prepare(
      `INSERT INTO evidence_files (evidence_id, order_id, filename, stored_name, mime, size, sha256, created_at)
       VALUES (?, ?, 'evidence.txt', ?, 'text/plain', 10, 'x', ?)`
    )
    .run(ev.lastInsertRowid, id, stored, now);
  return { id, file };
}

before(() => {
  initDb(DB_FILE);
});
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响判据 */
  }
});

test('前提：这是**文件库**（WAL 真的存在，判据才可能失败）', () => {
  const mode = getDb().prepare('PRAGMA journal_mode').get();
  assert.equal(String(mode?.journal_mode || '').toLowerCase(), 'wal');
  assert.equal(Number(getDb().prepare('PRAGMA secure_delete').get()?.secure_delete ?? 0), 1);
  // 先写一笔，确保 -wal 文件已经出现（TRUNCATE 之后的空文件也会保留）
  getDb().prepare('UPDATE orders SET note = ? WHERE id = ?').run('warmup', 'nonexistent');
  assert.ok(fs.existsSync(`${DB_FILE}-wal`) || checkpointTruncate(), '文件库上应当能看到 -wal 或至少能成功截断');
});

test('擦干净时：两条腿都落地（字节级）+ 不留待清理标记', () => {
  const { id, file } = makeTerminalOrderWithAttachment();
  // 前置：原文确实在库里与盘上（否则后面的"消失"是空转）
  assert.ok(bytesOf(file).includes(PHONE), '前置：附件文件里应当有原文');
  assert.ok(hasPII(DB_FILE) || hasPII(`${DB_FILE}-wal`), '前置：库或 WAL 里应当能搜到原文');

  const r = eraseOrderPii(id);
  assert.equal(r.ok, true, `应当一次擦干净：${r.error || ''}`);
  assert.equal(r.walTruncated, true, 'WAL 必须被截断（这是"盘上没有原文"这条承诺的唯一落点）');
  assert.equal(r.cleanupPending, false);
  assert.equal(getDb().prepare('SELECT pii_cleanup_pending FROM orders WHERE id = ?').get(id).pii_cleanup_pending, 0);

  // 字节级：库、WAL、附件文件里都不该再有原文（附件目录整体删除）
  assert.equal(hasPII(DB_FILE), false, '.db 里不该还有原文');
  assert.equal(hasPII(`${DB_FILE}-wal`), false, '-wal 里不该还有原文');
  assert.equal(fs.existsSync(file), false, '附件文件必须真的从磁盘上删掉');
  assert.equal(
    getDb().prepare('SELECT pii_erased_at FROM orders WHERE id = ?').get(id).pii_erased_at > 0,
    true,
    '擦除锚点写上了（供保留期去重）'
  );
});

test('WAL 被读者挡住时：不算擦干净、记为待清理，且**同一时间点**的下一轮扫描会重试并清干净', () => {
  const { id, file } = makeTerminalOrderWithAttachment();
  /*
    让 checkpoint 失败：另开一个连接并持住读事务（真实世界的等价物：备份进程、第二个进程、
    AV/索引器）。`wal_checkpoint(TRUNCATE)` 在有读者时会回 busy≠0。
  */
  const reader = new DatabaseSync(DB_FILE);
  reader.exec('BEGIN');
  reader.prepare('SELECT COUNT(*) AS c FROM orders').get();
  const r1 = eraseOrderPii(id);
  assert.equal(r1.walTruncated, false, '本机没能构造出"WAL 被挡住"的情形（判据未生效，勿当通过）');
  assert.equal(r1.ok, false, 'WAL 没截断 ⇒ 不算擦干净（旧实现把它当成功：ok 只看附件那条腿）');
  assert.equal(r1.cleanupPending, true, '必须记成"还欠一次清理"');
  assert.match(r1.error, /WAL/, `原因要说清是哪条腿：${r1.error}`);
  assert.equal(
    getDb().prepare('SELECT pii_cleanup_pending FROM orders WHERE id = ?').get(id).pii_cleanup_pending,
    1,
    '待清理标记要落库（保留期据此重试）'
  );
  assert.equal(fs.existsSync(file), false, '附件这条腿本身是成功的（文件已删）');

  // 读者放开（真实场景：备份跑完了）
  reader.exec('ROLLBACK');
  reader.close();

  /*
    关键断言：**不推进时间**，直接再跑一轮保留期扫描。
    候选判据若是纯时间的（旧实现），这一单的 updated_at 就是刚才那一下 ⇒ 候选为 0、永远不重试；
    现在 `OR pii_cleanup_pending = 1` 让它当场进候选，并在这一轮里把 WAL 一起清掉。
  */
  const r2 = runPiiRetention({ days: 180, now: Date.now() });
  assert.ok(r2.candidates >= 1, `欠清理的单必须在同一时间点就成为候选（实际 candidates=${r2.candidates}）`);
  assert.equal(r2.cleanupPending, 0, '重试后不应再有待清理的单');
  assert.equal(
    getDb().prepare('SELECT pii_cleanup_pending FROM orders WHERE id = ?').get(id).pii_cleanup_pending,
    0,
    '清干净后标记归零（一次有界重试，不是反复入选）'
  );
  assert.equal(hasPII(`${DB_FILE}-wal`), false, '重试之后 WAL 里不该还有原文');
});
