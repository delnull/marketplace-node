/**
 * `audit_logs` 的 **append-only** 库约束（`TRIGGER_DDL` ⑩⑪）。
 *
 * 要防的是什么：审计哈希链的校验器只能**事后**发现断裂，而"持库凭据的人一条 UPDATE/DELETE"
 * 根本不经过应用。症状是静默的：删掉一行只会让下一行的 prev_hash 接不上（要等有人手工跑
 * `check-integrity` 才看得见），改一行 action/detail 甚至可能永远不会被读到。
 *
 * 触发器的判据（**唯一的一份，在 db.js 的 DDL 里**）：
 *   · BEFORE UPDATE：只允许 logAudit 的那次回填——`OLD.entry_hash IS NULL AND NEW.entry_hash
 *     IS NOT NULL` 且其余每个可写列与 OLD 全等；其它一律 SIGNAL SQLSTATE '45000'；
 *   · BEFORE DELETE：一律 SIGNAL。
 * 本文件证明的正是这两句：正常回填能过（否则应用每次写审计都会炸）、改 action/detail/at 被拒、
 * 二次回填被拒、删行被拒，且失败后那一行**一字未变**。
 *
 * 边界（不是本文件能覆盖、也不该假装覆盖）：TRUNCATE/DROP 是 DDL，触发器触发不了——
 * 那要收 DDL 权限。触发器的射程到此为止，见 db.js 里那两条触发器旁的"代价②"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, TEST_SHOP_CODE } from './setup.mjs';

const ctx = await makeCtx();
const { db, owner } = ctx;
const { logAudit } = await import('../src/audit.js');
const { verifyAuditChain } = await import('../src/auditChain.js');

const ACTOR = `0x${'cd'.repeat(20)}`;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
let seq = 0;

/** 清空审计表（TRUNCATE 是 DDL：这是触发器射程之外的边界，也是测试之间唯一安全的清理方式） */
async function reset() {
  await db.run('TRUNCATE TABLE audit_logs');
}

/** 直接插一行（`entry_hash` 为 NULL，模拟 logAudit 刚 INSERT 完的那一刻），返回 id */
async function insertRaw({ prevHash } = {}) {
  seq += 1;
  // head_slot = IF(entry_hash IS NULL, NULL, …) 的唯一键不约束 NULL；
  // 但回填之后它变成 prev_hash，所以每个会被回填的行给一个互不相同的前驱。
  const prev = prevHash ?? `${String(seq).padStart(2, '0')}${'c'.repeat(62)}`;
  const r = await db.run(
    `INSERT INTO audit_logs (actor, actor_role, shop_code, action, target_type, target_id, detail, ip, prev_hash)
     VALUES (?, 'owner', NULL, ?, 'test', 'x', '{}', '', ?)`,
    ACTOR,
    `probe.${seq}`,
    prev
  );
  return Number(r.insertId);
}

/** 断言的形状：SIGNAL SQLSTATE '45000' + 可读消息（错误码/消息都是契约的一部分） */
function signal(messageRe) {
  return (e) => {
    assert.equal(e.code, 'ER_SIGNAL_EXCEPTION', `期待库侧 SIGNAL，实际 ${e.code}：${e.message}`);
    assert.equal(e.sqlState, '45000', `SIGNAL 的 SQLSTATE 必须是 45000：${e.message}`);
    assert.match(String(e.message), messageRe);
    return true;
  };
}

test('两条守卫挂在 audit_logs 上，且都是 BEFORE（AFTER 就拦不住这条语句本身）', async () => {
  const triggers = await db.all(
    `SELECT TRIGGER_NAME AS name, EVENT_MANIPULATION AS event, ACTION_TIMING AS timing
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'audit_logs'
      ORDER BY TRIGGER_NAME`
  );
  assert.deepEqual(
    triggers.map((t) => [t.name, t.timing, t.event]),
    [
      ['trg_audit_logs_hash_backfill_only', 'BEFORE', 'UPDATE'],
      ['trg_audit_logs_no_delete', 'BEFORE', 'DELETE'],
    ]
  );
});

test('正常路径：logAudit 先 INSERT 再回填 entry_hash（唯一允许的 UPDATE）能过，链仍自洽', async () => {
  await reset();
  await logAudit({
    req: { ip: '127.0.0.1' },
    actor: owner.address,
    actorRole: 'owner',
    shopCode: TEST_SHOP_CODE,
    action: 'append.probe',
    targetType: 'test',
    targetId: '1',
    detail: { ok: true },
  });
  const row = await db.get("SELECT * FROM audit_logs WHERE action = 'append.probe'");
  assert.ok(row, '审计行必须落库');
  assert.equal(String(row.entry_hash).length, 64, '回填必须成功（INSERT 时是 NULL，UPDATE 由触发器放行）');
  const chain = await verifyAuditChain(db);
  assert.equal(chain.ok, true, `回填后链必须自洽：${JSON.stringify(chain.broken)}`);
  assert.equal(chain.hashed, 1);
});

test('直连回填一次能过；第二次回填被拒（哈希不可改写）', async () => {
  await reset();
  const id = await insertRaw();
  await db.run('UPDATE audit_logs SET entry_hash = ? WHERE id = ?', HASH_A, id);
  assert.equal((await db.get('SELECT entry_hash FROM audit_logs WHERE id = ?', id)).entry_hash, HASH_A);

  await assert.rejects(
    () => db.run('UPDATE audit_logs SET entry_hash = ? WHERE id = ?', HASH_B, id),
    signal(/只允许/)
  );
  assert.equal((await db.get('SELECT entry_hash FROM audit_logs WHERE id = ?', id)).entry_hash, HASH_A, '被拒的写入不得改到行');
});

test('改 action / detail / at 一律被拒，且行内容一字未变', async () => {
  await reset();
  const id = await insertRaw();
  await db.run('UPDATE audit_logs SET entry_hash = ? WHERE id = ?', HASH_A, id);
  const before = await db.get('SELECT * FROM audit_logs WHERE id = ?', id);

  for (const [label, sql, params] of [
    ['action', 'UPDATE audit_logs SET action = ? WHERE id = ?', ['shop.nothing_happened', id]],
    ['detail', 'UPDATE audit_logs SET detail = ? WHERE id = ?', ['{"changed":true}', id]],
    ['at', 'UPDATE audit_logs SET at = at + INTERVAL 1 SECOND WHERE id = ?', [id]],
    ['shop_code（改成节点级）', 'UPDATE audit_logs SET shop_code = NULL WHERE id = ?', [id]],
    ['ip', 'UPDATE audit_logs SET ip = ? WHERE id = ?', ['203.0.113.9', id]],
  ]) {
    await assert.rejects(() => db.run(sql, ...params), signal(/只允许/), `${label} 必须被拒`);
  }

  // "回填的同时顺手改一列"也不行：回填的凭据是"其余列与 OLD 全等"
  await assert.rejects(
    () => db.run('UPDATE audit_logs SET entry_hash = ?, action = ? WHERE id = ?', HASH_B, 'shop.nothing_happened', id),
    signal(/只允许/)
  );

  const after = await db.get('SELECT * FROM audit_logs WHERE id = ?', id);
  assert.deepEqual(after, before, '被拒的写入必须整条回滚（包括 entry_hash）');
});

test('二次回填 / 值未变的 UPDATE 同样被拒（唯一允许的是 NULL → 非 NULL 的那一次）', async () => {
  await reset();
  const id = await insertRaw();
  await db.run('UPDATE audit_logs SET entry_hash = ? WHERE id = ?', HASH_A, id);

  await assert.rejects(
    () => db.run('UPDATE audit_logs SET entry_hash = entry_hash WHERE id = ?', id),
    signal(/只允许/),
    '值未变的 UPDATE 也不属于"回填"（它同样能掩盖一次回填失败）'
  );
});

test('删行被拒（审计行是证据）', async () => {
  await reset();
  const id = await insertRaw();
  await assert.rejects(() => db.run('DELETE FROM audit_logs WHERE id = ?', id), signal(/不可删除/));
  assert.ok(await db.get('SELECT 1 AS hit FROM audit_logs WHERE id = ?', id), '被拒后行必须还在');
});
