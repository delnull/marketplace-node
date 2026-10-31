/**
 * schema 文本的结构守卫。
 *
 * 为什么需要这个文件：`SCHEMA_DDL` 是一整段 **JS 模板字面量**，这带来两种
 * **语法完全合法、但建表结果错**的失败模式，`node --check` 一个都抓不到：
 *
 *   1. **注释里出现反引号** ⇒ 模板字面量在那里被截断，后面的 DDL 变成 JS 代码。
 *      实测踩过三次（每次都让全仓 import 失败，因为 db.js 是所有模块的入口）。
 *   2. **建表语句被 `/* … *​/` 注释吞掉** ⇒ 那段 SQL 永远不会下发，表根本不存在。
 *      实测踩过一次：`product_codes` / `product_nft_tokens` 整块落在 DDL 头部的说明里，
 *      于是卡密池与 NFT 池不会被建；而它们当时**也不在任何门禁清单里**，所以启动门禁放行，
 *      直到第一笔交付才炸（`Unknown table`）。
 *
 * 第 2 类无法靠"仔细看"避免——注释与代码在文本上长得一样。所以把它变成一条会**红**的判据：
 * 逐字符扫描，确认每一条 CREATE 都在注释之外；再钉住表清单，让"少建一张表"当场现形。
 * 运行期的结构门禁（`src/db.js` 的 `inspectSchemaStructure`）负责"已存在的表形状对不对"，
 * 本文件只负责"建表语句有没有被注释吞掉/清单有没有漂移"——两者判的不是同一件事。
 *
 * 本文件**不 import src/**（只读文本），所以不需要数据库，也不需要 test/setup.mjs。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_JS = path.join(here, '..', 'src', 'db.js');
const BACKTICK = String.fromCharCode(96);

/**
 * 取出 `SCHEMA_DDL` 模板字面量的内容 —— **不用"下一个反引号"当右界**（那是本文件曾经的盲点）。
 *
 * ## 为什么必须按行扫到 `;` 收口，而不能 `match(/const SCHEMA_DDL = `([\s\S]*?)`;/)`
 * 那个正则**假设了 DDL 里没有反引号**——而它要找的正是反引号。于是注释里一出现反引号就自相矛盾：
 *   · 右界提前落在**注释里那个反引号**上 ⇒ 切出来的是 DDL 的**残段**（长度 > 0，所以"取不到 ⇒ 被截断"
 *     那条断言不响）；
 *   · 残段里当然没有反引号（它就是在第一个反引号前面结束的）⇒ "注释里不得有反引号"那条也不响。
 * 两条断言同时沉默，而 `db.js` 已经是一份**语法错误的 JS**（模板串被截断、后面的 DDL 变成代码）。
 * 本会话实测踩到第 11 次时才看出这个盲点：`node --check src/db.js` 报错、而本文件全绿。
 *
 * 现在的形状：从 `const SCHEMA_DDL = ` 那**一行**往下逐行找那个以反引号 + `;` 收尾的行
 * （模板字面量的真实右界），中间出现的任何反引号都是**内容里的裸反引号** ⇒ 直接报出来。
 * 这样"有裸反引号"与"右界找不到"是两条**互斥且都响亮**的结论，不再互相掩盖。
 */
function readDdl() {
  const src = fs.readFileSync(DB_JS, 'utf8');
  const lines = src.split('\n');
  const head = lines.findIndex((l) => l.startsWith('const SCHEMA_DDL = '));
  assert.ok(head >= 0, '找不到 `const SCHEMA_DDL = ` ——它在 db.js 里的形状变了？');
  const openTick = lines[head].indexOf(BACKTICK);
  assert.ok(openTick >= 0, `第 ${head + 1} 行的 SCHEMA_DDL 不是以反引号开头的模板字面量`);
  const bare = [];
  for (let i = head; i < lines.length; i++) {
    const from = i === head ? openTick + 1 : 0;
    const at = lines[i].indexOf(BACKTICK, from);
    if (at < 0) continue;
    // 右界 = 反引号之后只剩 `;`（模板字面量的收尾）
    if (lines[i].slice(at + 1).trim() === ';') {
      const body = [lines[head].slice(openTick + 1), ...lines.slice(head + 1, i), lines[i].slice(0, at)].join('\n');
      assert.ok(bare.length === 0, `SCHEMA_DDL 的**内容**里有裸反引号（模板字面量会在那里被截断）：\n  ${bare.join('\n  ')}`);
      return body;
    }
    bare.push(`${i + 1}: ${lines[i].trim().slice(0, 100)}`);
  }
  assert.fail(
    `找不到 SCHEMA_DDL 的收尾（一行以反引号 + 分号结束）——它多半被内容里的反引号截断了。\n` +
      `  可疑行：\n  ${bare.join('\n  ') || '（一行都没扫到，模板字面量可能被整体改写）'}`
  );
}

/** 某个下标是否落在 `/* … *​/` 注释内部。 */
function insideComment(text, pos) {
  let depth = 0;
  for (let i = 0; i < pos; i++) {
    if (text[i] === '/' && text[i + 1] === '*') { depth++; i++; continue; }
    if (text[i] === '*' && text[i + 1] === '/') { depth--; i++; continue; }
  }
  return depth > 0;
}

function createStatements(ddl) {
  const out = [];
  const re = /CREATE (?:TABLE IF NOT EXISTS|OR REPLACE VIEW) (\w+)/g;
  let m;
  while ((m = re.exec(ddl))) out.push({ name: m[1], at: m.index, inComment: insideComment(ddl, m.index) });
  return out;
}

test('SCHEMA_DDL 的注释里不得出现反引号（会截断模板字面量）', () => {
  /*
    `readDdl()` 现在**会**在内容里发现裸反引号并直接 fail（见它的说明：旧实现用反引号当右界，
    于是"有裸反引号"与"右界找不到"这两条结论互相掩盖，两条断言都是哑的）。这里再独立扫一遍，
    是为了让失败信息落在**这一条**上（读的人一眼知道是注释写了反引号，而不是"DDL 取不出来"）。
  */
  const ddl = readDdl();
  const offenders = ddl.split('\n')
    .map((line, i) => ({ line: i + 1, text: line }))
    .filter((x) => x.text.includes(BACKTICK));
  assert.deepEqual(
    offenders.map((x) => `${x.line}: ${x.text.trim()}`),
    [],
    'DDL 是 JS 模板字面量：注释里的反引号会在那里截断它。改用「」或直接去掉。'
  );
});

test('SCHEMA_DDL 的块注释必须配平', () => {
  const ddl = readDdl();
  const opens = (ddl.match(/\/\*/g) || []).length;
  const closes = (ddl.match(/\*\//g) || []).length;
  assert.equal(opens, closes, `块注释开 ${opens} 个、闭 ${closes} 个——不配平会有整段 DDL 被吞掉`);
});

test('每一条建表/建视图语句都必须在注释之外（被吞掉的表不会被建出来）', () => {
  const swallowed = createStatements(readDdl()).filter((s) => s.inComment).map((s) => s.name);
  assert.deepEqual(swallowed, [], '这些语句落在注释里，表/视图根本不会被创建');
});

test('表与视图清单被钉住：少建一张或多建一张都要当场现形', () => {
  const names = createStatements(readDdl()).map((s) => s.name).sort();
  /*
    `db_write_lock` **已按计划删除**（2026-10-16）：四道"先读后写"的闸已全部落成
    计数器 / 唯一约束 / 触发器，写事务不再串行，那张过渡表与 withTransaction 里的取锁语句同批移除。
    这张清单的作用在这一次删除里兑现了：删表与删锁任缺其一都会让这条测试变红
    （守卫先红过一次，正是"删了锁、忘了改清单"）。

    现在补上的是删锁之后的**新不变量**：计数器由触发器维护，所以触发器必须与表同在——
    少了触发器，`buyer_draft_quota` 只增不减，买家付满 10 笔之后**再也建不了草稿**，
    而且日志里一个字都没有。这条断言就是防那一类静默错账。
  */
  const expected = [
    'audit_logs', 'auth_sessions', 'buyer_blocks', 'buyer_draft_quota', 'buyer_favorites', 'buyer_product_quota', 'dispute_evidence',
    'evidence_files', 'nft_claims', 'node', 'node_staff', 'order_alerts', 'order_chain',
    'order_delivery_claims', 'order_delivery_items', 'order_returns', 'order_shipping',
    'orders', 'payment_tokens', 'product_codes', 'product_nft_tokens', 'product_skus', 'products', 'proxy_drafts',
    'reviews', 'seller_proxy_draft_quota', 'seller_proxy_product_quota', 'shop_applications',
    'shop_claims', 'shop_operators', 'shop_webhook', 'shops', 'siwe', 'v_orders',
  ].sort();
  assert.deepEqual(names, expected, 'DDL 里的表/视图清单与预期不一致——多一张少一张都会让某条链路静默失效');
});

test('配额计数器的触发器必须与计数器同在（少了它计数只增不减，买家会被永久锁死）', () => {
  /*
    触发器**不在 SCHEMA_DDL 里**：MySQL 的 CREATE TRIGGER 没有 IF NOT EXISTS，
    所以它们是各自一条 `DROP … IF EXISTS` + `CREATE`，在 migrate() 里跟在建表之后单独下发。
    因此这里扫的是整个 db.js 源文件，而不是 DDL 那段模板字面量。
  */
  const src = fs.readFileSync(DB_JS, 'utf8');
  const triggers = [...src.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1]).sort();
  /*
    比"只减不加"多出来的**两个 restore 触发器**（2026-10-16）：池占位在 `cancelled` 时就结清了
    （草稿超时/买家取消是常态，不结清那张商品就再也卖不出去），而 `cancelled → escrowed`
    （买家在草稿被清扫之后才完成支付）必须把占位**占回来**——否则余量虚高 ⇒ 超卖。
    这一处只能由触发器做：三条恢复路径（watcher / `/sync` / 链上对账）调用占位恢复的时机不一样，
    应用层拿不到与顺序无关的"只做一次"凭据，而那条状态迁移本身就是凭据。
  */
  assert.deepEqual(triggers, [
    'trg_audit_logs_hash_backfill_only',
    'trg_audit_logs_no_delete',
    'trg_delivery_pool_claim',
    'trg_delivery_pool_claim_release',
    'trg_delivery_pool_release',
    'trg_orders_delete_pool_release',
    'trg_orders_delete_quota_release',
    'trg_orders_draft_quota_release',
    'trg_orders_pool_codes_release',
    'trg_orders_pool_codes_restore',
    'trg_orders_pool_tokens_release',
    'trg_orders_pool_tokens_restore',
    'trg_orders_product_quota_release',
    'trg_orders_proxy_draft_quota_release',
    'trg_orders_proxy_product_quota_release',
  ], '少一个触发器就少一条库侧判据（计数只增不减 / 审计行可被改删）——那是静默且永久的错账');
  /*
    新加的两条是"一码一次"的库侧判据（见 db.js 的 order_delivery_claims 与 TRIGGER_DDL ③'）：
      · 插入交付行 ⇒ 把**池内资源**记进认领账（唯一键挡住同一单重复交付同一个码/ tokenId）；
      · 删除交付行 ⇒ 退回认领（不碰任何计数器，所以没有 GREATEST/UNSIGNED 的中间值问题）。
    自由文本交付不进入认领账（value 不是标识），这是刻意的：见 order_delivery_items 的注释。
  */
  const claimTriggers = triggers.filter((t) => t.startsWith('trg_delivery_pool_claim'));
  assert.deepEqual(claimTriggers, ['trg_delivery_pool_claim', 'trg_delivery_pool_claim_release']);
  assert.match(
    src.slice(src.indexOf('CREATE TRIGGER trg_delivery_pool_claim '), src.indexOf('CREATE TRIGGER trg_delivery_pool_claim ') + 1200),
    /INSERT INTO order_delivery_claims/,
    '认领触发器必须把池内资源写进 order_delivery_claims（唯一键在它身上）'
  );

  /*
    审计表的两条 append-only 守卫（见 db.js 的 TRIGGER_DDL ⑩⑪）：唯一允许的 UPDATE 是
    entry_hash 回填，DELETE 一律 SIGNAL。少了任何一条，"持库凭据的人一条 UPDATE/DELETE"
    就能让哈希链只剩事后才可能被发现的断裂（而校验器是手工 CLI，日常没人跑）。
  */
  const auditTriggers = triggers.filter((t) => t.startsWith('trg_audit_'));
  assert.deepEqual(auditTriggers, ['trg_audit_logs_hash_backfill_only', 'trg_audit_logs_no_delete']);
  for (const t of auditTriggers) {
    const body = src.slice(src.indexOf(`CREATE TRIGGER ${t}`), src.indexOf(`CREATE TRIGGER ${t}`) + 1400);
    assert.match(body, /BEFORE (UPDATE|DELETE) ON audit_logs/, `${t} 必须挂在 audit_logs 的 BEFORE 上`);
    assert.match(body, /SIGNAL SQLSTATE '45000'/, `${t} 必须用 SIGNAL 拒绝（而不是静默忽略）`);
  }

  /*
    **`DELETE` 那一侧必须有触发器**（2026-10-16 补，此前一条都没有）。
    上面那六条全是 `AFTER UPDATE` / `AFTER INSERT`，于是删订单时一个减量都不触发：
    交付行随外键级联删（那条 `AFTER INSERT` 自然不响）、草稿配额与池占位都留在计数器里。
    真实入口有三条（草稿清扫、测试夹具、运维/直连 SQL 清理），而**症状是店主发现池子
    永远是满的**、买家再也建不了草稿——库里查不出原因。

    这条判据不看"写了几个触发器"，而是**成对**检查：每个"减量发生在 UPDATE/INSERT 上"的
    计数器，都必须有一个对应的 `AFTER DELETE` 兜底。
  */
  const deleteTriggers = triggers.filter((t) => t.includes('_delete_'));
  assert.deepEqual(
    deleteTriggers,
    ['trg_orders_delete_pool_release', 'trg_orders_delete_quota_release'],
    '删除订单必须结清池占位与两种草稿配额（买家/代客），且代客标记要在四本账处理完之后才删'
  );
  for (const t of deleteTriggers) {
    const body = src.slice(src.indexOf(`CREATE TRIGGER ${t}`), src.indexOf(`CREATE TRIGGER ${t}`) + 700);
    assert.match(body, /AFTER DELETE ON orders/, `${t} 必须挂在 orders 的 AFTER DELETE 上`);
    /* 夹逼与 CAST 一个都不能省（理由见 TRIGGER_DDL 开头的 UNSIGNED 说明） */
    assert.match(body, /GREATEST\(0, CAST\(/, `${t} 的减量必须带 GREATEST 夹逼与 CAST（UNSIGNED 中间值会溢出）`);
  }
  // 加量在应用（守卫 UPDATE），减量在库（触发器）：这个不对称是刻意的，两处的列都要在
  const ddl = readDdl();
  for (const col of ['active_drafts', 'units', 'reserved_codes', 'reserved_tokens', 'evidence_bytes']) {
    assert.ok(ddl.includes(col), `计数器列 ${col} 不见了`);
  }
});

/*
  "每一张建出来的表都要被某份清单认领"那条测试**随清单一起删掉了**（2026-10-17）：
  启动门禁不再维护第二份列/表清单，而是把 SCHEMA_DDL 在临时库里全量执行一遍再对拍
  （见 src/db.js 的 inspectSchemaStructure）。"少建一张表/少一列/少一个 CHECK" 由
  test/schema-fingerprint.test.js 用**真实 DDL 的产物**判定，文本清单不再是判据。
*/
