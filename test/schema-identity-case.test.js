/**
 * 地址与店铺编号的**库级大小写判据**（`SCHEMA_DDL` 的 R2b）。
 *
 * 要防的是什么：库级排序规则是 `utf8mb4_0900_as_cs`（大小写敏感），而"写入前一律
 * `.toLowerCase()`"只是每个写者手里的纪律。任何直连 SQL / 导入脚本写进一个带校验和的地址，
 * 那一行对所有小写查询**永久不可见**且不报错——身份唯一性因此可以静默分裂成两个键。
 * 判据现在挂在列上：CHAR(42) 地址列 `CHECK (col = LOWER(col))`、CHAR(9) 店铺编号列
 * `CHECK (col = UPPER(col))`（Crockford Base32 的规范形是大写）。
 *
 * 本文件有两半：
 *   ① **清单从 SCHEMA_DDL 派生**（不是手抄）：新增一个 CHAR(42)/CHAR(9) 列却忘了带约束，
 *      这里当场变红——这正是不变量该有的形状（判据覆盖"这一类"，不是"这几个"）；
 *   ② **真库实测**：每张表的地址列都真的拒绝带校验和的写法，合法小写/大写/NULL 照旧能写。
 * 结构门禁（`inspectSchemaStructure`）对 CHECK 的对拍由 test/schema-fingerprint.test.js 覆盖，
 * 这里只补新约束的"门禁报差异 + 给修复语句"那一条（删掉一条新增 CHECK 再验）。
 *
 * 本文件不 mock 数据库：`makeCtx()` 建出来的就是 `SCHEMA_DDL` 的真实产物。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCtx, insertOrder, insertProduct, TEST_SHOP_CODE } from './setup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_JS = path.join(here, '..', 'src', 'db.js');

const ctx = await makeCtx();
const { db, owner, buyer } = ctx;
const { inspectSchemaStructure } = await import('../src/db.js');

/** 小写规范形（合法） */
const LOWER = `0x${'ab'.repeat(20)}`;
/** 带校验和的大小写混合形（同一个地址，as_cs 下却是另一个键——正是要拒绝的那一类） */
const UPPER = `0x${'AB'.repeat(20)}`;
/** 另一个合法小写地址（避免 seller 唯一键与夹具冲突） */
const otherLower = (byte) => `0x${String(byte).repeat(40)}`;

/**
 * 从 SCHEMA_DDL 的文本派生 CHAR(42)/CHAR(9) 列清单。
 *
 * 与 test/schema-guard.test.js 用同一种读法：DDL 是模板字面量，注释里出现反引号会截断它；
 * 这里先按"反引号 + 分号收尾的那一行"取出内容，再按 CREATE TABLE 切块。
 */
function readDdl() {
  const src = fs.readFileSync(DB_JS, 'utf8');
  const lines = src.split('\n');
  const head = lines.findIndex((l) => l.startsWith('const SCHEMA_DDL = '));
  assert.ok(head >= 0, '找不到 `const SCHEMA_DDL = ` ——它在 db.js 里的形状变了？');
  const openTick = lines[head].indexOf('`');
  const body = [];
  if (openTick >= 0) body.push(lines[head].slice(openTick + 1));
  for (let i = head + 1; i < lines.length; i++) {
    const at = lines[i].indexOf('`');
    if (at >= 0 && lines[i].slice(at + 1).trim() === ';') {
      body.push(lines[i].slice(0, at));
      return body.join('\n');
    }
    assert.ok(at < 0, `SCHEMA_DDL 内容里出现裸反引号（第 ${i + 1} 行），模板字面量会被截断`);
    body.push(lines[i]);
  }
  assert.fail('找不到 SCHEMA_DDL 的收尾（反引号 + 分号）');
}

/** `[{ table, column, type }]`：只认"行首列名 + CHAR(42|9)"，与建表语句同形 */
function charColumns(ddl, width) {
  const out = [];
  const tableRe = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\)\s*ENGINE=InnoDB/g;
  let t;
  while ((t = tableRe.exec(ddl))) {
    const columnRe = new RegExp(`^\\s*([a-z_][a-z0-9_]*)\\s+CHAR\\(${width}\\)(?!\\d)`, 'gim');
    let c;
    while ((c = columnRe.exec(t[2]))) out.push({ table: t[1], column: c[1] });
  }
  return out;
}

const ddl = readDdl();
const addressColumns = charColumns(ddl, 42);
const codeColumns = charColumns(ddl, 9);

/** 当前库里的全部 CHECK（名字 + 归一后的表达式） */
async function checksInDb() {
  const rows = await db.all(
    `SELECT tc.TABLE_NAME AS tableName, tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK'`
  );
  return new Map(rows.map((r) => [r.name, { table: r.tableName, clause: String(r.clause).replace(/\s+/g, ' ').trim() }]));
}

/** 断言某条语句被 **CHECK** 拒绝（不是别的约束/外键替它挡的） */
async function checkRejected(label, sql, params) {
  await assert.rejects(
    () => db.run(sql, ...params),
    (e) => {
      assert.equal(e.code, 'ER_CHECK_CONSTRAINT_VIOLATED', `${label} 必须被 CHECK 拒绝，实际：${e.code} ${e.message}`);
      return true;
    }
  );
}

test('清单从 SCHEMA_DDL 派生：27 个 CHAR(42) 地址列、10 个 CHAR(9) 店铺编号列', () => {
  /*
    清单钉死是**结果**，不是判据：真正的判据是下面两条"每个派生列都必须有对应 CHECK"。
    这里把当前清单写出来，是为了让"某一列被悄悄改成 VARCHAR 从而逃出约束范围"也现形
    （改类型会同时让结构门禁报 column-diff；两处都会响）。
  */
  assert.deepEqual(
    addressColumns.map((c) => `${c.table}.${c.column}`).sort(),
    [
      'audit_logs.actor',
      'buyer_blocks.buyer',
      'buyer_draft_quota.buyer',
      'buyer_favorites.buyer',
      'buyer_product_quota.buyer',
      'nft_claims.claimant',
      'nft_claims.seller',
      'nft_claims.token_contract',
      'node.escrow_address',
      'node.owner',
      'node.staking_address',
      'node_staff.address',
      'orders.buyer',
      'orders.payment_token',
      'orders.seller',
      'payment_tokens.address',
      'products.nft_contract',
      'reviews.buyer',
      'seller_proxy_draft_quota.buyer',
      'seller_proxy_draft_quota.seller',
      'seller_proxy_product_quota.buyer',
      'seller_proxy_product_quota.seller',
      'shop_applications.seller',
      'shop_claims.address',
      'shop_operators.address',
      'shops.seller',
      'siwe.address',
    ]
  );
  assert.deepEqual(
    codeColumns.map((c) => `${c.table}.${c.column}`).sort(),
    [
      'audit_logs.shop_code',
      'buyer_blocks.shop_code',
      'buyer_favorites.shop_code',
      'nft_claims.shop_code',
      'orders.shop_code',
      'products.shop_code',
      'shop_claims.shop_code',
      'shop_operators.shop_code',
      'shop_webhook.shop_code',
      'shops.code',
    ]
  );
});

test('每个地址列都有 ck_<表>_<列>_lower、每个编号列都有 ck_<表>_<列>_upper', async () => {
  const checks = await checksInDb();
  for (const { table, column } of addressColumns) {
    const name = `ck_${table}_${column}_lower`;
    const found = checks.get(name);
    assert.ok(found, `${table}.${column} 缺 ${name}（带校验和的地址会静默成为第二个身份键）`);
    assert.equal(found.table, table);
    assert.equal(found.clause, `(\`${column}\` = lower(\`${column}\`))`, `${name} 的表达式不是"列 = LOWER(列)"`);
  }
  for (const { table, column } of codeColumns) {
    const name = `ck_${table}_${column}_upper`;
    const found = checks.get(name);
    assert.ok(found, `${table}.${column} 缺 ${name}（小写编号会静默成为第二个身份键）`);
    assert.equal(found.table, table);
    assert.equal(found.clause, `(\`${column}\` = upper(\`${column}\`))`, `${name} 的表达式不是"列 = UPPER(列)"`);
  }
  // "多出来的"同样是假话：改列名/删列之后留下的约束会让下一次写入莫名其妙地失败
  const anyCaseCheck = [...checks.entries()].filter(([name]) => /_(lower|upper)$/.test(name)).map(([name]) => name).sort();
  const expected = [
    ...addressColumns.map(({ table, column }) => `ck_${table}_${column}_lower`),
    ...codeColumns.map(({ table, column }) => `ck_${table}_${column}_upper`),
  ].sort();
  assert.deepEqual(anyCaseCheck, expected);
});

test('地址录入口：带校验和的写法在每张表上都被拒（不是靠调用点记得折小写）', async () => {
  const nft = await insertProduct(db, { kind: 'nft', nftContract: LOWER, nftStandard: 'erc721' });
  const draft = await insertOrder(db, {
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    productId: nft.productId,
    status: 'draft',
  });

  await checkRejected('node.owner', 'UPDATE node SET owner = ? WHERE id = 1', [UPPER]);
  await checkRejected('node.escrow_address', 'UPDATE node SET escrow_address = ? WHERE id = 1', [UPPER]);
  await checkRejected('node.staking_address', 'UPDATE node SET staking_address = ? WHERE id = 1', [UPPER]);
  await checkRejected('node_staff.address', 'INSERT INTO node_staff (address) VALUES (?)', [UPPER]);
  await checkRejected('shops.seller', 'UPDATE shops SET seller = ? WHERE code = ?', [UPPER, TEST_SHOP_CODE]);

  await checkRejected(
    'shop_applications.seller',
    "INSERT INTO shop_applications (seller, name, notice, status) VALUES (?, '', '', 'pending')",
    [UPPER]
  );

  await checkRejected('shop_operators.address', 'INSERT INTO shop_operators (shop_code, address) VALUES (?, ?)', [
    TEST_SHOP_CODE,
    UPPER,
  ]);
  await checkRejected(
    'shop_claims.address',
    'INSERT INTO shop_claims (shop_code, kind, value, address, message, signature) VALUES (?, ?, ?, ?, ?, ?)',
    [TEST_SHOP_CODE, 'domain', 'probe.example', UPPER, 'm', 's']
  );

  await checkRejected('products.nft_contract', 'UPDATE products SET nft_contract = ? WHERE id = ?', [UPPER, nft.productId]);
  for (const column of ['buyer', 'seller']) {
    // 列名来自上面的派生清单，不是从请求里拼的：这里只跑确定在 schema 里的列
    await checkRejected(`orders.${column}`, `UPDATE orders SET \`${column}\` = ? WHERE id = ?`, [UPPER, draft.orderId]);
  }

  /*
    NFT 提货声明的两个地址列（token 合约 / 提交人）：先造一条合法行，再试带校验和的写法。
    它们没有"NULL 三态"之外的旁路——CHECK 挂在列上，任何写者都绕不过去。
  */
  const claimIns = await db.run(
    `INSERT INTO nft_claims
       (claim_no, shop_code, product_id, product_slug, order_id, order_no, seller,
        token_contract, token_id, claimant, status, shipping_name, shipping_phone, shipping_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '1', ?, 'requested', 'n', 'p', 'a')`,
    'C' + '0'.repeat(20),
    TEST_SHOP_CODE,
    nft.productId,
    nft.slug,
    draft.orderId,
    draft.orderNo,
    owner.address.toLowerCase(),
    LOWER,
    otherLower(7)
  );
  await checkRejected(
    'nft_claims.token_contract',
    'UPDATE nft_claims SET token_contract = ? WHERE id = ?',
    [UPPER, claimIns.insertId]
  );
  await checkRejected('nft_claims.claimant', 'UPDATE nft_claims SET claimant = ? WHERE id = ?', [UPPER, claimIns.insertId]);
  await checkRejected('nft_claims.seller', 'UPDATE nft_claims SET seller = ? WHERE id = ?', [UPPER, claimIns.insertId]);
  await db.run('DELETE FROM nft_claims WHERE id = ?', claimIns.insertId);

  await checkRejected(
    'reviews.buyer',
    'INSERT INTO reviews (order_id, product_id, buyer, rating) VALUES (?, ?, ?, 5)',
    [draft.orderId, nft.productId, UPPER]
  );
  await checkRejected(
    'audit_logs.actor',
    "INSERT INTO audit_logs (actor, actor_role, action, target_type, target_id) VALUES (?, 'owner', 'probe', 't', 'x')",
    [UPPER]
  );
  await checkRejected('siwe.address', 'INSERT INTO siwe (address, message, expires_at) VALUES (?, ?, NOW(3))', [UPPER, 'm']);
  await checkRejected('buyer_draft_quota.buyer', 'INSERT INTO buyer_draft_quota (buyer) VALUES (?)', [UPPER]);
  await checkRejected('buyer_product_quota.buyer', 'INSERT INTO buyer_product_quota (buyer, product_id) VALUES (?, ?)', [
    UPPER,
    nft.productId,
  ]);
});

test('店铺编号口：小写编号被拒（本节点铸造的规范形是大写）', async () => {
  await checkRejected(
    'shops.code',
    "INSERT INTO shops (code, seller, name, notice, listed) VALUES ('0000test1', ?, '', '', 1)",
    [otherLower(5)]
  );
});

test('合法写法不被误拒：小写地址、NULL 三态照旧能写', async () => {
  // 地址列：NULL 是"没有/从未记录"，CHECK 对它求值为 UNKNOWN ⇒ 通过
  await db.run('UPDATE node SET escrow_address = ? WHERE id = 1', LOWER);
  await db.run('UPDATE node SET escrow_address = NULL WHERE id = 1');
  // 可空的地址列同样：写小写、写 NULL 都是合法态
  // 店铺编号：现有夹具就是大写规范形；一次幂等写证明它不被这条 CHECK 误伤
  await db.run('UPDATE shops SET seller = seller WHERE code = ?', TEST_SHOP_CODE);
});

test('门禁：删掉一条新增的 CHECK ⇒ 报 check-missing，并给出可执行的 ADD CONSTRAINT 修复', async () => {
  await db.run('ALTER TABLE shops DROP CHECK ck_shops_seller_lower');
  try {
    const broken = await inspectSchemaStructure();
    assert.equal(broken.ok, false, '缺地址小写约束必须拒绝启动');
    const diff = broken.diffs.find(
      (d) => d.kind === 'check-missing' && d.table === 'shops' && d.object === 'ck_shops_seller_lower'
    );
    assert.ok(diff, `必须报出缺的 CHECK：${JSON.stringify(broken.diffs)}`);
    assert.match(String(diff.expected), /lower\(`seller`\)/, '差异里要带期望表达式');
    assert.equal(
      broken.repairs.some((r) => r.includes('ADD CONSTRAINT `ck_shops_seller_lower` CHECK')),
      true,
      '修复清单必须给出 ADD CONSTRAINT（照做即可，不用人抄建表语句）'
    );

    // 按差异里带的期望表达式补回去（证明它不是一段只能看不能用的文本），门禁应恢复通过
    await db.run(`ALTER TABLE shops ADD CONSTRAINT \`ck_shops_seller_lower\` CHECK ${diff.expected}`);
    const after = await inspectSchemaStructure();
    assert.equal(after.ok, true, `补回 CHECK 后应通过：${JSON.stringify(after.diffs)}`);
  } finally {
    // 断言失败时也不能把库留在"缺约束"的状态，否则后续用例会看到假的门禁差异
    const checks = await checksInDb();
    if (!checks.has('ck_shops_seller_lower')) {
      await db.run('ALTER TABLE shops ADD CONSTRAINT `ck_shops_seller_lower` CHECK (`seller` = LOWER(`seller`))');
    }
  }
});
