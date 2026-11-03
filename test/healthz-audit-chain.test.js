/**
 * `/healthz` 的**审计链读数**（`src/app.js` 的 readAuditChain）。
 *
 * 要防的是什么：`audit_logs` 的 append-only 触发器只挡 DML。拿到 DDL 权限的人（或一次
 * `TRUNCATE`）之后，库里会留下"prev_hash 接不上"的痕——而在这条读数之前，只有**有人记得**
 * 跑 `npm run check:integrity` 才看得见。探活每几秒一次，把"最近 N 行还接得上吗"挂上去，
 * 断裂最迟一个缓存周期就能被看见。
 *
 * 同时钉住它的三个边界（这三条都是"读数"而不是"判据"）：
 *   · 断裂**不改变** `/healthz` 的 200 与顶层 code（探活看的是 watcher 那几条）；
 *   · 缓存是 30s——窗口内的重复请求不再重扫，`at` 不变；
 *   · 读不到（表被挪走）时 ok=null / code=2，与"链没问题"分开，且同样不影响 200。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, assertOk, TEST_SHOP_CODE } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

const { logAudit } = await import('../src/audit.js');
const { auditEntryHash } = await import('../src/auditChain.js');
const { resetAuditChainCache } = await import('../src/app.js');

/** 清空审计表 + 重置 healthz 的读数缓存（30s 缓存是进程级的，用例之间必须显式失效） */
async function reset() {
  await db.run('TRUNCATE TABLE audit_logs');
  resetAuditChainCache();
}

/** 走唯一的审计入口写一行（hash 链由 logAudit 维护） */
async function audit(action = 'shop.update') {
  await logAudit({
    req: { ip: '127.0.0.1' },
    actor: owner.address,
    actorRole: 'owner',
    shopCode: TEST_SHOP_CODE,
    action,
    targetType: 'test',
    targetId: 'x',
    detail: {},
  });
}

/**
 * 一条 INSERT 直接灌 n 行**已经正确成链**的审计行（显式给 id：哈希把 id 也算进去，所以先定 id 再算哈希）。
 * 不用 logAudit 逐行写：那是每行一次事务，灌 205 行要十几秒，而这条用例要的只是"表比窗口长"。
 */
async function appendHashedRows(n) {
  const head = await db.get('SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1');
  let prev = head ? String(head.entry_hash) : null;
  const firstId = Number((await db.get('SELECT COALESCE(MAX(id), 0) AS m FROM audit_logs')).m) + 1;
  const base = Date.now();
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = {
      id: firstId + i,
      at: new Date(base + i),
      actor: owner.address.toLowerCase(),
      actor_role: 'owner',
      shop_code: TEST_SHOP_CODE,
      action: `probe.${i}`,
      target_type: 'test',
      target_id: 'x',
      // JSON 列传字符串：驱动对"对象"参数不会替你序列化（query 形态会写成 [object Object]）
      detail: '{}',
      ip: '127.0.0.1',
    };
    const entry = auditEntryHash(prev, row);
    rows.push({ ...row, prev_hash: prev, entry_hash: entry });
    prev = entry;
  }
  const values = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
  await db.run(
    `INSERT INTO audit_logs (id, at, actor, actor_role, shop_code, action, target_type, target_id, detail, ip, prev_hash, entry_hash)
     VALUES ${values}`,
    ...rows.flatMap((r) => [
      r.id, r.at, r.actor, r.actor_role, r.shop_code, r.action, r.target_type, r.target_id, r.detail, r.ip, r.prev_hash, r.entry_hash,
    ])
  );
}

async function healthAuditChain() {
  const res = await request(app).get('/healthz').expect(200);
  assertOk(res);
  const cap = res.body.data.capabilities?.auditChain;
  assert.ok(cap, 'healthz.capabilities 必须有 auditChain 读数（否则"链还完整吗"仍然只能靠人记得跑体检）');
  return { res, cap };
}

test('干净链 ⇒ {window, checked, ok:true, firstBrokenId:null, code:0}，且不影响健康结论', async () => {
  await reset();
  await audit('shop.update');
  await audit('product.update');
  await audit('export.ledger');

  const { res, cap } = await healthAuditChain();
  assert.equal(res.body.data.healthy, true);
  assert.equal(cap.window, 200, '窗口是常数 200（探活不扫全表）');
  assert.equal(cap.checked, 3, '窗口里有多少行就校验多少行');
  assert.equal(cap.ok, true);
  assert.equal(cap.firstBrokenId, null);
  assert.equal(cap.code, 0);
  assert.match(cap.detail, /自洽/);
});

test('窗口内被塞入一行假哈希 ⇒ ok:false/firstBrokenId/code:1，但仍是 200 且顶层 code:0', async () => {
  await reset();
  await audit('shop.update');
  const head = String(
    (await db.get('SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1')).entry_hash
  );
  // 直接 INSERT 一行编造的哈希（append-only 触发器只挡 UPDATE/DELETE，插入假行正是"能改库的人"的形状）
  const forged = Number(
    (
      await db.run(
        `INSERT INTO audit_logs (at, actor, actor_role, action, target_type, target_id, detail, ip, prev_hash, entry_hash)
         VALUES (NOW(3), '0xdead', 'owner', 'audit.forged', 'test', '-', '{}', '', ?, ?)`,
        head,
        'f'.repeat(64)
      )
    ).insertId
  );

  const { res, cap } = await healthAuditChain();
  // 它是读数不是判据：链断了，探活仍然绿——这里的红线是"断裂必须看得见"，不是"必须 503"
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 0);
  assert.equal(res.body.data.healthy, true);
  assert.equal(cap.ok, false);
  assert.equal(cap.code, 1);
  assert.equal(cap.firstBrokenId, forged, '必须指到第一处断裂的审计行');
  assert.match(cap.detail, new RegExp(`#${forged}`));
});

test('30s 缓存：窗口内的后续请求不再重扫（at 不变）；重置后才看见新写入的断裂', async () => {
  await reset();
  await audit('shop.update');
  const first = (await healthAuditChain()).cap;
  assert.equal(first.checked, 1);

  await audit('product.update');
  const cached = (await healthAuditChain()).cap;
  assert.equal(cached.at, first.at, '缓存期内不该重新采样');
  assert.equal(cached.checked, 1, '缓存期内看到的还是上一次窗口（这是 30s 的代价，不是 bug）');

  resetAuditChainCache();
  const fresh = (await healthAuditChain()).cap;
  assert.notEqual(fresh.at, first.at);
  assert.equal(fresh.checked, 2, '缓存失效后必须看到新行');
});

test('窗口只取最近 200 行（多一行作为前驱锚），不随表增长线性变慢', async () => {
  await reset();
  // 205 行：窗口 = 最近 200 行，另 1 行当"窗口前驱"（否则首行会被误报成链首被删）
  await appendHashedRows(205);
  const { cap } = await healthAuditChain();
  assert.equal(cap.checked, 200, `只校验最近 ${cap.window} 行，实际 ${cap.checked}`);
  assert.equal(cap.ok, true, `整条链是干净的，窗口结论不该是断裂：${cap.detail}`);
});

test('窗口前一行是未哈希历史行 ⇒ 仍自洽（锚取"窗口之前最后一条已哈希行"，不是紧邻的那一行）', async () => {
  await reset();
  await appendHashedRows(100);
  /*
    升级前的历史行（两列都 NULL）落在已哈希链中间——全表体检会跳过它继续往后比，窗口读数也必须如此。
    旧实现的锚取"窗口的前一行"（= 这条未哈希行）⇒ 首个已哈希行会被误报成"链首之前被删了"（假警报）。
  */
  await db.run(
    `INSERT INTO audit_logs (at, actor, actor_role, action, target_type, target_id, detail, ip)
     VALUES (NOW(3), '0xdead', 'owner', 'legacy.probe', 'test', '-', '{}', '')`
  );
  await appendHashedRows(200);

  const { cap } = await healthAuditChain();
  assert.equal(cap.checked, 200);
  assert.equal(cap.ok, true, `未哈希历史行不是断裂证据（窗口锚跳过它即可）：${cap.detail}`);
});

test('读不到审计表 ⇒ ok:null/code:2（不折成"没问题"），且 /healthz 仍 200', async () => {
  await reset();
  await db.run('RENAME TABLE audit_logs TO audit_logs_unreadable');
  try {
    resetAuditChainCache();
    const { res, cap } = await healthAuditChain();
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 0);
    assert.equal(cap.ok, null, '"读不到"与"链没问题"必须是两个结论');
    assert.equal(cap.code, 2);
    assert.equal(cap.checked, 0);
    assert.match(cap.detail, /没校验成/);
  } finally {
    await db.run('RENAME TABLE audit_logs_unreadable TO audit_logs');
    resetAuditChainCache();
  }
});
