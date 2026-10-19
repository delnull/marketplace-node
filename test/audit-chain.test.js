/**
 * 管理审计哈希链（`src/auditChain.js` + `src/audit.js` 的写入路径）的回归测试。
 *
 * 要防的是什么：审计行原先可被任何拿到磁盘写权限的人（或一次"从旧备份恢复"）静默
 * `UPDATE`/`DELETE`——"谁在什么时候改了店铺设置/导出了什么"因此失去证据力。写入是唯一入口
 * `logAudit`，校验器是唯一实现 `verifyAuditChain`，本文件把两侧一起钉住：
 *   ① 干净链必须通过（体检不能见谁都报）；
 *   ② 改一行、删一行、插一行假哈希，以及"把一行搬到另一个 id"的两种搬法——
 *      连 `prev_hash` 一起搬（= 让两条行指向同一个前驱）**写不进去**，库的唯一索引
 *      `uq_audit_head` 直接拒绝（分叉在落库这一步就不可表达，比事后报断裂更强）；
 *      只搬 `entry_hash` 而换个前驱（库会接受）则必须被校验器报到那一行上；
 *   ③ 空表必须 ok（校验器不得在退化输入上抛错）；
 *   ④ **三态纪律**：升级前没有哈希的历史行只能进 `unhashed`，**不能被说成篡改**；
 *   ⑤ 哈希确实覆盖每一列（逐字段变一个字节，重算必须不等）——防止哪天有人把某列漏出序列化；
 *   ⑥ 已知边界也钉住：截断尾部链条自己查不出来（靠盘外 head 兜），免得后来人以为它被覆盖了。
 *
 * ⚠️ **正常路径上的 UPDATE/DELETE 现在被库触发器拒绝**（`src/db.js` 的 TRIGGER_DDL ⑩⑪，
 * 行为用例在 test/audit-append-only.test.js）。本文件模拟的是**已经落进库里的**断裂：
 * 旧备份恢复、早于触发器的历史行、或有人先用 DDL 权限把守卫摘掉再改。那些场景正是校验器
 * 必须继续存在的原因——所以篡改模拟先摘守卫、跑完立刻原样重建（见 withoutAuditGuards）。
 * 清理用 TRUNCATE 而不是 DELETE：DELETE 已被 ⑪ 拒绝，而 DDL 是触发器的射程之外（见代价②）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, makeCtx, shopRef, TEST_SHOP_CODE } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

// 业务模块必须动态 import（config/db 在模块顶层读 process.env，而 makeCtx 才设好它）
const { verifyAuditChain, auditEntryHash } = await import('../src/auditChain.js');
const { logAudit } = await import('../src/audit.js');
const { findIntegrityIssues } = await import('../src/integrity.js');

/**
 * 走**唯一的审计入口**写一行，返回落库后的行（用它断言链上的真实字节）。
 * `shopCode` 必填（见 src/audit.js）：本文件写的是**店铺行**（夹具里那唯一一家店），
 * 节点级那一档（`null`）由 test/audit-scope.test.js 与下面的历史行夹具覆盖。
 */
async function audit(action, detail = {}) {
  await logAudit({ req: { ip: '127.0.0.1' }, actor: owner.address, actorRole: 'owner', shopCode: TEST_SHOP_CODE, action, targetType: 'test', targetId: 'x', detail });
  return await db.get('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1');
}

/**
 * 直接插一行（模拟"有磁盘写权限的人"或"升级前的旧写入者"），返回新行 id。
 * `shop_code` 留 NULL（节点级）：这些夹具行的重点是"有没有哈希/哈希是不是编的"，
 * 归属不是它们的判据；NULL 也让它们与"升级前那批两列全空的历史行"同形。
 */
async function insertRaw({ prevHash = null, entryHash = null, action = 'shop.update', at = new Date() } = {}) {
  // `at` 是 DATETIME(3)：传毫秒整数会被 MySQL 当成数字字面量解析（报 Incorrect datetime value）
  const r = await db.run(`INSERT INTO audit_logs (at, actor, actor_role, action, target_type, target_id, detail, ip, prev_hash, entry_hash)
       VALUES (?, ?, 'owner', ?, 'shop', '-', '{}', '', ?, ?)`, at, '0xdead', action, prevHash, entryHash);
  return Number(r.insertId);
}

/** 清空审计表：同文件内共享一个库，用例之间互不依赖（AUTO_INCREMENT 只保证递增，不影响判据）。
 *
 * 用 TRUNCATE 而不是 DELETE：DELETE 已被库的 append-only 触发器拒绝（TRIGGER_DDL ⑪），
 * 而 TRUNCATE 是 DDL——它不触发 DELETE 触发器。这恰好说明了触发器的射程：它挡的是 DML，
 * DDL 权限要靠授权去收（与 src/db.js 里那两条触发器的"代价②"一致）。
 */
async function reset() {
  await db.run('TRUNCATE TABLE audit_logs');
  assert.equal((await db.get('SELECT COUNT(*) AS c FROM audit_logs')).c, 0, '前置：审计表已清空');
}

/**
 * 摘掉审计守卫 → 执行 `fn`（模拟"改动已经落进库里的"场景）→ **原样重建**守卫。
 *
 * 为什么需要它：UPDATE/DELETE 现在在语句自己身上就失败了，而校验器要防的是"绕过/早于
 * 这道网"的断裂（旧备份恢复、历史行、有 DDL 权限的人先 DROP TRIGGER）。这里用
 * `SHOW CREATE TRIGGER` 取回服务器上的原文再重建——不在测试里手抄第二份触发器定义，
 * 否则测的就不是节点启动时实际建出来的那两条。
 */
async function withoutAuditGuards(fn) {
  const guards = await db.all(
    `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'audit_logs'`
  );
  assert.equal(guards.length, 2, '前置：audit_logs 上应有两条 append-only 守卫');
  const definitions = [];
  for (const { name } of guards) {
    const row = await db.get(`SHOW CREATE TRIGGER \`${name}\``);
    definitions.push(String(row['SQL Original Statement']));
    await db.run(`DROP TRIGGER \`${name}\``);
  }
  try {
    return await fn();
  } finally {
    for (const sql of definitions) await db.run(sql);
  }
}

/** 断裂清单压成 [id, kind] 便于逐条精确断言（"报了几条、报在哪一行"都是判据） */
const shape = (broken) => broken.map((b) => [b.id, b.kind]);

test('空表 ⇒ ok（0 行、无断裂、链头为空串；校验器在退化输入上不得抛错）', async () => {
  await reset();
  const r = await verifyAuditChain(db);
  assert.deepEqual(
    { ok: r.ok, entries: r.entries, hashed: r.hashed, unhashedCount: r.unhashedCount, broken: r.broken, head: r.head },
    // 空表：链头是 NULL（不是空串）——NULL 才是"还没有链首"，空串在旧形状里兼任了这个意思
    { ok: true, entries: 0, hashed: 0, unhashedCount: 0, broken: [], head: null }
  );
});

test('连续 3 次真实 logAudit ⇒ 链自洽，且每行的 prev_hash 确实引用上一行的 entry_hash', async () => {
  await reset();
  const a = await audit('product.update', { priceFrom: 100, priceTo: 200 });
  const b = await audit('shop.update', { noticeChanged: true });
  const c = await audit('export.ledger', { rows: 12 });

  const r = await verifyAuditChain(db);
  assert.equal(r.ok, true, `干净链被报成断裂：${JSON.stringify(r.broken)}`);
  assert.equal(r.entries, 3);
  assert.equal(r.hashed, 3);
  assert.equal(r.unhashedCount, 0);

  // "上一行哈希确实被引用"：逐行等于前一行的 entry_hash（而不是各自随便记了个哈希）
  assert.equal(a.prev_hash, null, '链首的 prev_hash 是 NULL（不是空串）');
  assert.equal(b.prev_hash, a.entry_hash, '第 2 行必须引用第 1 行的 entry_hash');
  assert.equal(c.prev_hash, b.entry_hash, '第 3 行必须引用第 2 行的 entry_hash');
  assert.equal(r.head, c.entry_hash, '链头 = 最后一行已哈希行的 entry_hash');
  assert.equal(a.entry_hash.length, 64, 'entry_hash 是 64 位 hex');
});

test('哈希覆盖每一列：逐字段改一个字节，重算必然不等（防止某列被漏出序列化）', async () => {
  await reset();
  const a = await audit('shop.update', { noticeChanged: true });
  const mutated = {
    id: a.id + 1,
    at: a.at + 1,
    actor: `${a.actor}x`,
    actor_role: 'staff', // 落库是 owner：换角色必须改哈希
    // 店铺维度也在哈希里：把一行改判给另一家店（或改成节点级 NULL）必须改变哈希——
    // 否则"某行出现在/消失在某家店的审计里"在证据层上什么都查不出来
    shop_code: null,
    action: `${a.action}x`,
    target_type: `${a.target_type}x`,
    target_id: `${a.target_id}x`,
    detail: `${a.detail} `,
    ip: `${a.ip}x`,
  };
  for (const [field, v] of Object.entries(mutated)) {
    assert.notEqual(auditEntryHash(null, { ...a, [field]: v }), a.entry_hash, `字段 ${field} 必须参与哈希`);
  }
  // 同一份字节的重算必须与落库值一致（否则干净行也会被报成断裂）
  assert.equal(auditEntryHash(null, a), a.entry_hash, '干净行的重算必须逐字相等');
  // 校验器读的列清单必须与 HASH_FIELDS 对齐：漏一列 ⇒ 该列读成 undefined ⇒ 有值的行为全被报成断裂
  // （2026-10-16 加 shop_code 时实测踩到：节点级行照样过、店铺行全报 hash-mismatch——假警报）
  const r = await verifyAuditChain(db);
  assert.equal(r.ok, true, `店铺行参与校验时不得报断裂（校验器的 SELECT 漏列就是这个症状）：${JSON.stringify(r.broken)}`);
});

test('原样 UPDATE 改掉某行的 detail ⇒ 报在该 id 上（audit-hash-mismatch），且不牵连邻行', async () => {
  await reset();
  await audit('shop.update', {});
  const b = await audit('product.update', { priceTo: 200 });
  await audit('export.ledger', {});
  await withoutAuditGuards(() => db.run('UPDATE audit_logs SET detail = ? WHERE id = ?', '{"priceTo":1}', b.id)); // 改了不重算哈希

  const r = await verifyAuditChain(db);
  assert.equal(r.ok, false);
  assert.deepEqual(shape(r.broken), [[b.id, 'audit-hash-mismatch']], `只该报被改的那一行：${JSON.stringify(r.broken)}`);
  assert.match(r.broken[0].detail, /被事后改过/);
});

test('原样 UPDATE 改掉某行的 action ⇒ 同样报在该 id 上（哈希不是只看 detail）', async () => {
  await reset();
  const a = await audit('shop.update', {});
  await withoutAuditGuards(() => db.run('UPDATE audit_logs SET action = ? WHERE id = ?', 'shop.nothing_happened', a.id));

  const r = await verifyAuditChain(db);
  assert.deepEqual(shape(r.broken), [[a.id, 'audit-hash-mismatch']], JSON.stringify(r.broken));
});

test('删掉中间一行 ⇒ 在它的后继行上报 audit-prev-hash-mismatch（并说明疑似被删）', async () => {
  await reset();
  await audit('shop.update', {});
  const b = await audit('product.update', {});
  const c = await audit('export.ledger', {});
  await withoutAuditGuards(() => db.run('DELETE FROM audit_logs WHERE id = ?', b.id)); // 删掉中间一行，其余一字未动

  const r = await verifyAuditChain(db);
  assert.equal(r.ok, false);
  assert.deepEqual(shape(r.broken), [[c.id, 'audit-prev-hash-mismatch']], JSON.stringify(r.broken));
  assert.match(r.broken[0].detail, /被删/);
});

test('删掉链首行 ⇒ 报在（新的）第一行已哈希行上：链首之前的行被删也看得出来', async () => {
  await reset();
  const a = await audit('shop.update', {});
  const b = await audit('export.ledger', {});
  await withoutAuditGuards(() => db.run('DELETE FROM audit_logs WHERE id = ?', a.id));

  const r = await verifyAuditChain(db);
  assert.deepEqual(shape(r.broken), [[b.id, 'audit-prev-hash-mismatch']], JSON.stringify(r.broken));
  assert.match(r.broken[0].detail, /链首之前/);
});

test('手工插入一行伪造哈希（接在前一行后面，哈希是编的）⇒ 报断裂', async () => {
  await reset();
  const a = await audit('shop.update', {});
  const fakeId = await insertRaw({ prevHash: a.entry_hash, entryHash: 'f'.repeat(64), action: 'export.codes' });

  const r = await verifyAuditChain(db);
  assert.equal(r.ok, false);
  assert.deepEqual(shape(r.broken), [[fakeId, 'audit-hash-mismatch']], JSON.stringify(r.broken));
  assert.match(r.broken[0].detail, /伪造/);
});

/*
  把一行"搬"到另一个 id 上 ⇒ 必须报断裂（id 也绑在哈希里）。

  MySQL 之下这一条**分两半**，因为库里多了一道 SQLite 时期没有的约束：
  `uq_audit_head`（生成列 `IFNULL(prev_hash,'')` 上的唯一索引）让"两条审计行指向同一个前驱"在**写入时**
  就被拒绝——那正是"哈希链不许分叉"的落库形态（见 src/db.js 的建表说明）。
  所以：
    ① 连 prev_hash 一起原样搬 = 被库直接拒（分叉在形状上不可表达）；
    ② 只把 entry_hash 搬过来（换个前驱，库接受）⇒ 校验器必须报 audit-hash-mismatch
       —— 搬过来的那个哈希是用**另一个 id / 另一个 prev_hash** 算的，内容对不上。
  两半合起来才等于旧断言（"搬一行下去就会报断裂"），少任何一半都会把这条保护说小。
*/
test('把某行连哈希一起搬到另一个 id：要么被唯一索引拒（禁止分叉），要么被校验器报到那一行上', async () => {
  await reset();
  await audit('shop.update', {});
  const b = await audit('export.ledger', { rows: 3 });
  const cols = 'at, actor, actor_role, action, target_type, target_id, detail, ip, prev_hash, entry_hash';

  // ① 原样搬（含 prev_hash）：写不进去——同一前驱只能有一条审计行
  await assert.rejects(
    () => db.run(`INSERT INTO audit_logs (${cols}) SELECT ${cols} FROM audit_logs WHERE id = ?`, b.id),
    /Duplicate entry/i,
    '同一 prev_hash 的第二行必须被唯一索引拒绝（否则哈希链可以分叉）'
  );

  // ② 只把 entry_hash 搬过来、前驱换成一个不存在的前驱（这样库才会接受）：
  //    哈希与 id/前驱对不上，必须报在搬过来的那一行上
  const id = Number(
    (await db.run(
      `INSERT INTO audit_logs (${cols})
       SELECT at, actor, actor_role, action, target_type, target_id, detail, ip, ?, entry_hash FROM audit_logs WHERE id = ?`,
      'a'.repeat(64),
      b.id
    )).insertId
  );

  const r = await verifyAuditChain(db);
  assert.equal(r.ok, false);
  const kinds = r.broken.filter((x) => x.id === id).map((x) => x.kind).sort();
  // 两条都对：搬过来的哈希是用**另一个 id** 算的（内容对不上），且它的 prev_hash 接在一个不存在的前驱上（位置也对不上）
  assert.deepEqual(kinds, ['audit-hash-mismatch', 'audit-prev-hash-mismatch'], JSON.stringify(r.broken));
});

test('三态：升级前的历史行（两列都空）⇒ 归 unhashed、不报成篡改，新链从第一条新审计行起头', async () => {
  await reset();
  // 模拟"运维为保住历史行手工 ADD COLUMN(DEFAULT '')"之后库里那批旧行
  // ⚠️ 两个时刻都是 DATETIME(3)：毫秒整数会被 MySQL 当数字字面量解析（写进荒谬时间且不报错）
  const l1 = await insertRaw({ action: 'shop.update', at: new Date(Date.now() - 2000) });
  const l2 = await insertRaw({ action: 'product.update', at: new Date(Date.now() - 1000) });

  const a = await audit('export.ledger', { rows: 1 });
  const b = await audit('export.orders', { rows: 2 });

  const r = await verifyAuditChain(db);
  assert.equal(r.ok, true, `历史行不是篡改证据，不该报断裂：${JSON.stringify(r.broken)}`);
  assert.equal(r.broken.length, 0);
  assert.equal(r.unhashedCount, 2);
  assert.deepEqual(
    r.unhashed.map((u) => u.id),
    [l1, l2],
    '未哈希行要单独列出来（"这些行早于哈希链、无法校验"）'
  );
  assert.equal(r.hashed, 2);
  assert.equal(a.prev_hash, null, '链从第一条**新**审计行起头，不接在未哈希历史行后面');
  assert.equal(b.prev_hash, a.entry_hash);
  assert.equal(r.head, b.entry_hash);
});

test('半哈希行（写着 prev_hash 却没有 entry_hash）⇒ 按断裂报，不混进"早于哈希链"那一态', async () => {
  await reset();
  await audit('shop.update', {});
  const halfId = await insertRaw({ prevHash: 'a'.repeat(64), entryHash: null });

  const r = await verifyAuditChain(db);
  assert.equal(r.ok, false);
  assert.deepEqual(shape(r.broken), [[halfId, 'audit-entry-hash-missing']], JSON.stringify(r.broken));
  assert.equal(r.unhashedCount, 0, '半哈希行不得被说成"早于哈希链、无法校验"');
});

test('体检接线：断裂进 issues（带 auditId），未哈希行只进计数、不进 issues', async () => {
  await reset();
  const a = await audit('shop.update', {});
  await audit('export.ledger', {});
  await insertRaw({ action: 'product.update' }); // 未哈希历史行（id 最大，位置不影响三态）
  await withoutAuditGuards(() => db.run('UPDATE audit_logs SET action = ? WHERE id = ?', 'shop.updated', a.id));

  const { issues, counts, checked, auditChain } = await findIntegrityIssues(db);
  const hit = issues.find((i) => i.auditId === a.id);
  assert.ok(hit, `体检必须报出被改的那一行：${JSON.stringify(issues)}`);
  assert.equal(hit.kind, 'audit-hash-mismatch');
  assert.equal(counts.auditChainBroken, 1);
  assert.equal(checked.auditEntries, 3);
  assert.equal(checked.auditUnhashed, 1);
  assert.equal(auditChain.ok, false);
  assert.equal(
    issues.filter((i) => String(i.kind).startsWith('audit-')).length,
    1,
    '未哈希的历史行不得被报成不一致（否则真实断裂会淹没在噪声里）'
  );
});

test('经真实接口写入的审计行同样入链（路由 → logAudit 的接线，不只是直接调函数）', async () => {
  await reset();
  const { token } = await login(ctx, owner);
  const headBefore = (await verifyAuditChain(db)).head; // 登录等前置动作若也写审计，这里照样接得上

  const res = await request(app)
    .put('/api/shop')
    .set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value)
    .send({ notice: '哈希链走查' })
    .expect(200);
  assert.equal(res.body.code, 0);

  const row = await db.get("SELECT * FROM audit_logs WHERE action = 'shop.update' ORDER BY id DESC LIMIT 1");
  assert.ok(row, '店铺资料更新必须落审计');
  assert.equal(row.entry_hash.length, 64);
  assert.equal(row.prev_hash, headBefore, '接口写入的行必须接在当时的链头上');

  const r = await verifyAuditChain(db);
  assert.equal(r.ok, true, JSON.stringify(r.broken));
});

test('已知边界：截断尾部链条自己查不出来（靠盘外 head 兜）——钉住它，免得被当成已覆盖', async () => {
  await reset();
  await audit('shop.update', {});
  const b = await audit('export.ledger', { rows: 9 });
  const headBefore = (await verifyAuditChain(db)).head;
  assert.equal(headBefore, b.entry_hash);

  await withoutAuditGuards(() => db.run('DELETE FROM audit_logs WHERE id = ?', b.id)); // 删掉最后一行

  const r = await verifyAuditChain(db);
  assert.equal(r.ok, true, '尾部被整段删掉时，链内没有任何一行会抱怨——这是哈希链的固有边界');
  assert.notEqual(r.head, headBefore, '但链头变了：把 head 抄到盘外留存的人能立刻发现');
});

/*
  ── 事务语义（2026-09 深度测试补）：审计写入自己开事务，而**调用方可能已经在一个事务里**
  （例如路由层把「状态迁移 + 事件史 + 审计」包成一个分组）。这组用例把两种嵌套行为钉住：
    · 外层提交：审计行必须在链上、且链自洽（内层 SAVEPOINT 正常释放）；
    · 外层回滚：审计行随外层一起消失，**链上不能留下空洞**（下一条仍接在回滚前的链头上）。
  为什么重要：一旦出现"prev_hash 指向一个不存在的 entry_hash"，事后任何一次体检都会报断裂，
  而那是**误报**——真正的分叉必须伴随一次真实篡改。这条边界不写用例，将来换个写法就会踩到。
*/
test('审计写入嵌在外层事务里：外层提交 ⇒ 链自洽且接得上', async () => {
  await reset();
  const { withTransaction } = await import('../src/db.js');
  const a = await audit('shop.update', {});
  const headBefore = a.entry_hash;

  const b = await withTransaction(async () => await audit('product.create', { slug: 'nested-1' }));

  assert.equal(b.prev_hash, headBefore, '嵌套写入（SAVEPOINT 内）也必须接在外层事务开始前的链头上');
  const r = await verifyAuditChain(db);
  assert.equal(r.ok, true, `链必须自洽：${JSON.stringify(r.broken)}`);
  assert.equal(r.head, b.entry_hash, '链头应指向最后一条已提交的审计行');
});

test('外层事务回滚：审计行随之消失，且链上不留空洞（下一条接回滚前的链头）', async () => {
  await reset();
  const { withTransaction, abortTx } = await import('../src/db.js');
  const a = await audit('shop.update', {});
  const headBefore = a.entry_hash;
  const rowsBefore = (await db.get('SELECT COUNT(*) AS c FROM audit_logs')).c;

  await withTransaction(async () => {
    await audit('export.ledger', { rows: 1 }); // 这一行会随外层一起回滚
    abortTx(null);
  });

  assert.equal(
    (await db.get('SELECT COUNT(*) AS c FROM audit_logs')).c,
    rowsBefore,
    '回滚后审计行数应回到外层开始前'
  );
  const r1 = await verifyAuditChain(db);
  assert.equal(r1.ok, true, '回滚**不能**被报成篡改（链上不该出现指向不存在哈希的 prev_hash）');
  assert.equal(r1.head, headBefore, '链头回到回滚前那一行');

  // 回滚之后再写一条：必须接在 headBefore 上，而不是接在被回滚掉的那一行上
  const c = await audit('shop.settings', { k: 'v' });
  assert.equal(c.prev_hash, headBefore, '回滚后的新行必须接在**已提交**的链头上（否则就是永久断裂）');
  const r2 = await verifyAuditChain(db);
  assert.equal(r2.ok, true, `链必须继续自洽：${JSON.stringify(r2.broken)}`);
});
