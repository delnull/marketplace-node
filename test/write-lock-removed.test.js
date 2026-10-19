/**
 * 「全局写锁真的没了」——两条判据，都不靠计时：
 *
 *  1. **结构**：过渡期那张 `db_write_lock` 表在库里不存在（删锁与删表必须同批；
 *     它在 `SCHEMA_DDL` 里的缺席由 `test/schema-guard.test.js` 的表清单钉住）。
 *  2. **行为**：两个**写事务可以同时在事务里**——用一道栅栏（barrier）而不是 sleep：
 *     各自先在事务内写一行（不同的行，所以行锁互不相干），然后等对方也进来。
 *     还锁着的话第二个事务永远进不到回调里（第一个正拿着锁等它），栅栏超时 ⇒ 断言失败。
 *     有锁时它**必然**红，没锁时它在毫秒级绿——所以这不是一条看时序的脆测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Wallet } from 'ethers';
import { makeCtx, insertProduct, insertOrder } from './setup.mjs';

process.env.MK_DB_POOL_SIZE = '4'; // 两个并发事务各要一条连接；默认 2 也行，留点余量

const ctx = await makeCtx();
const { db, owner } = ctx;
const { withTransaction, abortTx } = await import('../src/db.js');
const { reserveDraftQuota } = await import('../src/draftQuota.js');

test('过渡期的 db_write_lock 表已经删掉（删表与删锁同批）', async () => {
  const rows = await db.all(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'db_write_lock'"
  );
  assert.deepEqual(rows.map((r) => r.t), [], 'db_write_lock 还在库里：取锁语句删了而表没删（或反过来）都说明这一批没删净');
  // 源码里只剩"它曾经存在"的历史说明（文件头），不得再有建表/取锁语句
  const src = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  const ddl = src.match(/const SCHEMA_DDL = `([\s\S]*?)`;/)[1];
  assert.ok(!ddl.includes('db_write_lock'), 'SCHEMA_DDL 里还留着 db_write_lock 的建表语句');
  assert.ok(!/FOR UPDATE/.test(src.match(/export async function withTransaction[\s\S]*?\n}/)[0]), 'withTransaction 里还留着取锁语句');
});

test('两个写事务可以同时在事务里（有全局锁时这条必然红）', async () => {
  const a = await insertProduct(db, { kind: 'physical', title: '并发写 A' });
  const b = await insertProduct(db, { kind: 'physical', title: '并发写 B' });
  const buyerA = Wallet.createRandom().address.toLowerCase();
  const buyerB = Wallet.createRandom().address.toLowerCase();

  let inside = 0;
  let releaseBoth;
  const bothInside = new Promise((resolve) => {
    releaseBoth = resolve;
  });
  /** 事务内先写（占位 + 落草稿），再等另一个事务也进来 */
  const run = (buyer, product) =>
    withTransaction(async () => {
      const quota = await reserveDraftQuota({ buyer, productId: product.productId, units: 1 });
      if (quota?.fail) return abortTx({ fail: quota.fail });
      await insertOrder(db, { buyer, seller: owner.address.toLowerCase(), productId: product.productId, quantity: 1 });
      inside += 1;
      if (inside === 2) releaseBoth();
      // 等对方进到事务里；全局写锁还在的话对方永远进不来，这里会超时
      await Promise.race([bothInside, new Promise((r) => setTimeout(r, 3000))]);
      return inside;
    });

  const [x, y] = await Promise.all([run(buyerA, a), run(buyerB, b)]);
  assert.equal(Math.max(x, y), 2, `两个写事务必须能同时在事务里（实际同时进入 ${Math.max(x, y)} 个）`);
  assert.equal(
    Number((await db.get('SELECT active_drafts AS v FROM buyer_draft_quota WHERE buyer = ?', buyerA)).v),
    1,
    '并发写各自提交（A 的额度在）'
  );
  assert.equal(
    Number((await db.get('SELECT active_drafts AS v FROM buyer_draft_quota WHERE buyer = ?', buyerB)).v),
    1,
    '并发写各自提交（B 的额度在）'
  );
});
