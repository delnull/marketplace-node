/**
 * 结构门禁（`src/db.js` 的 `inspectSchemaStructure`）的**可执行判据**。
 *
 * 为什么必须有用例：旧门禁只查 `information_schema.COLUMNS`，而 `createFreshSchema()` 执行的全是
 * `CREATE TABLE IF NOT EXISTS`（对已存在的表是 no-op）——CHECK / 索引 / 生成列表达式 / 列宽
 * 全在门禁射程之外。实测（测试机旧库）：缺 `ck_skus_committed`（`committed <= capacity`）
 * ⇒ `committed > capacity` 可表达 ⇒ **静默超卖**，而启动一切正常。
 *
 * 这里不 mock 任何东西：每个用例在真实的测试库上造出"旧结构"，再让门禁自己对拍
 * （临时库里把 SCHEMA_DDL 全量执行一遍是它的真实工作方式）。因此这些断言证明的是
 * 门禁**会拒绝**这一类缺口，而不是"差异函数对某个假对象返回了 true"。
 *
 * 顺序是刻意的：破坏结构的用例排在后面（后面的用例只做直接 SQL 断言），
 * 文件末尾把测试库的默认排序规则改成 ai_ci 再验排序规则门禁——`after()` 会删掉整个测试库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { db } = ctx;
const { inspectSchemaStructure, databaseCollationReport } = await import('../src/db.js');

/** 差异里找一条：`kind` + `table` + `object` 三者一起定位（同一张表可能有多种差异） */
function findDiff(structure, kind, table, object) {
  return structure.diffs.find((d) => d.kind === kind && d.table === table && d.object === object);
}

test('新建库：结构指纹与 SCHEMA_DDL 一致（门禁不误报自己刚建出来的库）', async () => {
  const s = await inspectSchemaStructure();
  assert.deepEqual(s.diffs, [], `新建库不该有任何结构差异：${JSON.stringify(s.diffs)}`);
  assert.equal(s.ok, true);
  assert.equal(s.fresh, false, '这个库已经建过表（makeCtx 里 initDb 建的）');
});

test('库级排序规则：新建库是 utf8mb4_0900_as_cs（_ai_ci 会让 ABC 与 abc 成同一个标识）', async () => {
  const r = await databaseCollationReport();
  assert.equal(r.ok, true);
  assert.equal(r.actual, 'utf8mb4_0900_as_cs');
});

test('运维自己的表与触发器**不在对拍范围**：多出来不报错', async () => {
  await db.run('CREATE TABLE IF NOT EXISTS ops_backup_20261017 (id BIGINT UNSIGNED PRIMARY KEY, note VARCHAR(20))');
  try {
    await db.run('CREATE TRIGGER ops_orders_note AFTER UPDATE ON orders FOR EACH ROW SET @ops_note = 1');
    const s = await inspectSchemaStructure();
    assert.deepEqual(s.diffs, [], `运维表/触发器被误报了：${JSON.stringify(s.diffs)}`);
  } finally {
    await db.run('DROP TRIGGER IF EXISTS ops_orders_note');
    await db.run('DROP TABLE IF EXISTS ops_backup_20261017');
  }
});

test('声明过的表上多出一列 ⇒ 报"多"（形状必须一致，不只是"缺了才报"）', async () => {
  await db.run('ALTER TABLE shops ADD COLUMN ops_extra VARCHAR(10) NULL');
  try {
    const s = await inspectSchemaStructure();
    assert.equal(s.ok, false);
    assert.ok(findDiff(s, 'column-extra', 'shops', 'ops_extra'), JSON.stringify(s.diffs));
  } finally {
    await db.run('ALTER TABLE shops DROP COLUMN ops_extra');
  }
});

test('缺 CHECK（防超卖那条）⇒ 拒绝启动，差异带期望表达式', async () => {
  await db.run('ALTER TABLE product_skus DROP CHECK ck_skus_committed');
  const s = await inspectSchemaStructure();
  assert.equal(s.ok, false, '缺 CHECK 必须被拒绝');
  const d = findDiff(s, 'check-missing', 'product_skus', 'ck_skus_committed');
  assert.ok(d, `必须报出缺的 CHECK：${JSON.stringify(s.diffs)}`);
  assert.match(String(d.expected), /committed` <= `capacity`/, '差异里要带期望表达式（不是只说"缺了"）');

  // 用差异里带的期望表达式把 CHECK 加回去（证明它不是一段只能看不能用的文本），门禁应恢复通过
  await db.run(`ALTER TABLE product_skus ADD CONSTRAINT \`ck_skus_committed\` CHECK ${d.expected}`);
  const after = await inspectSchemaStructure();
  assert.equal(after.ok, true, `按期望表达式补回 CHECK 后应当通过：${JSON.stringify(after.diffs)}`);
});

test('列类型不同 ⇒ 拒绝（列在不在与列宽/类型是两件事）', async () => {
  await db.run('ALTER TABLE orders MODIFY COLUMN timeout_blocks BIGINT UNSIGNED NULL');
  const s = await inspectSchemaStructure();
  assert.equal(s.ok, false);
  const d = findDiff(s, 'column-diff', 'orders', 'timeout_blocks');
  assert.ok(d, `必须报出列类型不同：${JSON.stringify(s.diffs)}`);
  assert.ok(d.fields.includes('columnType'), `差异字段必须含 columnType：${JSON.stringify(d.fields)}`);
  await db.run('ALTER TABLE orders MODIFY COLUMN timeout_blocks INT UNSIGNED NULL');
  const after = await inspectSchemaStructure();
  assert.equal(after.ok, true, `恢复期望列类型后应当通过：${JSON.stringify(after.diffs)}`);
});

/**
 * P0-2 的形状：三条**钱相关判据的输入列**此前不在任何清单里——
 *   orders.timeout_blocks（验货窗口判据读它）、node.watcher_hash（重组检测读它）、
 *   node.reconcile_after_sale_order_id（售后对账游标读它）。
 * 门禁升级成指纹之后，"哪一列要入册"这件事不再由人记得：SCHEMA_DDL 里的每一列都在断言范围内。
 */
test('缺列（含三条钱相关输入列）⇒ 逐列报出，不再依赖"有人记得把它加进清单"', async () => {
  const drops = [
    ['orders', 'timeout_blocks'],
    ['node', 'watcher_hash'],
    ['node', 'reconcile_after_sale_order_id'],
  ];
  for (const [table, column] of drops) await db.run(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
  const s = await inspectSchemaStructure();
  assert.equal(s.ok, false);
  for (const [table, column] of drops) {
    assert.ok(findDiff(s, 'column-missing', table, column), `${table}.${column} 必须报缺列：${JSON.stringify(s.diffs)}`);
  }
  // 恢复期望形状（本文件后续用例还要用这些列）
  await db.run('ALTER TABLE orders ADD COLUMN timeout_blocks INT UNSIGNED NULL');
  await db.run('ALTER TABLE node ADD COLUMN watcher_hash CHAR(66) NULL');
  await db.run('ALTER TABLE node ADD COLUMN reconcile_after_sale_order_id BIGINT UNSIGNED NULL');
});

test('触发器语句被换掉 ⇒ 拒绝（触发器是 schema 的一部分）', async () => {
  await db.run('DROP TRIGGER IF EXISTS trg_delivery_pool_claim_release');
  const s = await inspectSchemaStructure();
  assert.equal(s.ok, false);
  assert.ok(findDiff(s, 'trigger-missing', undefined, 'trg_delivery_pool_claim_release'), JSON.stringify(s.diffs));
});

test('库级排序规则不是 as_cs ⇒ 拒绝（判据只有一处：databaseCollationReport）', async () => {
  const { d } = await db.get('SELECT DATABASE() AS d');
  await db.run(`ALTER DATABASE \`${d}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  try {
    const r = await databaseCollationReport();
    assert.equal(r.ok, false, 'ai_ci 必须被拒绝');
    assert.equal(r.actual, 'utf8mb4_0900_ai_ci');
    assert.equal(r.expected, 'utf8mb4_0900_as_cs');
  } finally {
    await db.run(`ALTER DATABASE \`${d}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs`);
  }
  const restored = await databaseCollationReport();
  assert.equal(restored.ok, true);
});
