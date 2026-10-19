/**
 * 审计的**店铺维度**（2026-10-16）：一行审计归哪家店，必须由**行自己**回答（`audit_logs.shop_code`）。
 *
 * 要防的是什么：读的判据原先只有 `ownerOnly`（"你是不是请求头那家店的店主"），而行上没有任何
 * 店铺标识——于是一节点 N 家店里，**任一店店主都能读到整个节点的审计行**：别家店的订单号
 * （`target_id`）与变更摘要（`detail`）都在里面。那是数据模型缺了一维，不是权限配置漏了一项。
 *
 * 本文件钉住四件事（都是**真接口 + 真 MySQL**，不是直接调函数）：
 *   ① 归属由行的 `shop_code` 决定，不由"谁在查"决定：A 店店主读不到 B 店的行，加过滤器也读不到；
 *   ② 节点级行（`shop_code IS NULL`）**只有节点主**能读，且走的是另一条路由（/audit/node）；
 *   ③ `logAudit` / `queryAudit` 的 `shopCode` **必填**：`undefined`（忘了给）抛错，不落一行——
 *      "忘了给"与"节点级"（显式 `null`）是两件事，折成同一个值的后果本表已经栽过一次
 *      （见 db.js 的 head_slot 注释）；
 *   ④ 链**不分店**：跨店交错写入之后，节点级校验器仍然一路接得上（没有"空洞"可被误报成篡改），
 *      而按店过滤的**列表**里根本没有链字段——读者无从把"别家店的行被过滤掉了"读成"链断了"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { login, makeCtx, TEST_SHOP_CODE } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

const { verifyAuditChain } = await import('../src/auditChain.js');
const { logAudit, queryAudit } = await import('../src/audit.js');

/** 第二家店（本节点上的另一个**独立**店主）：一个钱包在本节点只能开一家店，所以必须是新钱包 */
const OTHER_SHOP_CODE = '0000TEST2';
const otherOwner = Wallet.createRandom();
await db.run(
  `INSERT INTO shops (code, seller, name, notice, listed, commission_bps) VALUES (?, ?, '', '', 1, 0)
   ON DUPLICATE KEY UPDATE seller = seller`,
  OTHER_SHOP_CODE, otherOwner.address.toLowerCase()
);

/** 走真接口改本店公告（PUT /api/shop → action=shop.update），返回落库的那一行 */
async function renameShop(wallet, shopCode, notice) {
  const { token } = await login(ctx, wallet);
  const res = await request(app)
    .put('/api/shop')
    .set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopCode)
    .send({ notice });
  assert.equal(res.body.code, 0, JSON.stringify(res.body));
  return await db.get(
    "SELECT * FROM audit_logs WHERE action = 'shop.update' AND target_id = ? AND detail->>'$.noticeChanged' = 'true' ORDER BY id DESC LIMIT 1",
    shopCode
  );
}

/** 走真接口改节点资料（PUT /api/shop/node，hostOnly → action=node.update） */
async function renameNode(notice) {
  const { token } = await login(ctx, owner);
  const res = await request(app)
    .put('/api/shop/node')
    .set('Authorization', `Bearer ${token}`)
    .send({ notice });
  assert.equal(res.body.code, 0, JSON.stringify(res.body));
  return await db.get("SELECT * FROM audit_logs WHERE action = 'node.update' ORDER BY id DESC LIMIT 1");
}

const itemOf = (body) => body.data.items;

test('真接口：A 店店主读不到 B 店的审计行，也读不到节点级行（加过滤器同样读不到）', async () => {
  const a = await renameShop(owner, TEST_SHOP_CODE, `A 店公告 ${Date.now()}`);
  const b = await renameShop(otherOwner, OTHER_SHOP_CODE, `B 店公告 ${Date.now()}`);
  const n = await renameNode(`节点公告 ${Date.now()}`);
  assert.equal(a.shop_code, TEST_SHOP_CODE, 'A 店的行必须写着 A 店编号');
  assert.equal(b.shop_code, OTHER_SHOP_CODE, 'B 店的行必须写着 B 店编号');
  assert.equal(n.shop_code, null, '节点级动作不属于任何一家店（NULL，不是空串）');

  const { token } = await login(ctx, owner);
  const list = await request(app)
    .get('/api/shop/audit?pageSize=100')
    .set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', TEST_SHOP_CODE)
    .expect(200);
  const items = itemOf(list.body);
  assert.ok(items.length > 0, 'A 店自己的审计必须看得见');
  assert.ok(items.every((i) => i.targetId !== OTHER_SHOP_CODE), `A 店读到了 B 店的行：${JSON.stringify(items.filter((i) => i.targetId === OTHER_SHOP_CODE))}`);
  assert.ok(!items.some((i) => i.action === 'node.update'), '节点级行不该出现在店铺列表里（那是节点主的视野）');
  assert.ok(items.some((i) => i.id === a.id), 'A 店自己刚写的那一行必须看得见');

  // 过滤参数不能让越权"复活"：过滤器是**在店铺范围内的**缩小，不是它的替代品
  const filtered = await request(app)
    .get(`/api/shop/audit?pageSize=100&action=shop.update&actor=${otherOwner.address.toLowerCase()}`)
    .set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', TEST_SHOP_CODE)
    .expect(200);
  assert.deepEqual(itemOf(filtered.body), [], '按 B 店主地址过滤也必须返回空（过滤器不越过店铺边界）');

  // 反过来：B 店店主也读不到 A 店的行
  const { token: bToken } = await login(ctx, otherOwner);
  const bList = await request(app)
    .get('/api/shop/audit?pageSize=100')
    .set('Authorization', `Bearer ${bToken}`).set('X-Mk-Shop', OTHER_SHOP_CODE)
    .expect(200);
  const bItems = itemOf(bList.body);
  assert.ok(bItems.some((i) => i.id === b.id), 'B 店自己的行必须看得见');
  assert.ok(bItems.every((i) => i.targetId !== TEST_SHOP_CODE), 'B 店读到了 A 店的行');
  assert.ok(!bItems.some((i) => i.action === 'node.update'), 'B 店店主不是节点主，看不到节点级行');
});

test('列表里没有链字段：按店过滤后的读者手里根本没有"相邻关系"可以读成断裂', async () => {
  const { token } = await login(ctx, owner);
  const list = await request(app)
    .get('/api/shop/audit?pageSize=5')
    .set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', TEST_SHOP_CODE)
    .expect(200);
  const items = itemOf(list.body);
  assert.ok(items.length > 0);
  for (const it of items) {
    assert.deepEqual(
      Object.keys(it).filter((k) => k.includes('hash')).sort(),
      [],
      '审计列表不得下发 prev_hash/entry_hash：分店过滤后的子集在链上是有空洞的，把链字段交出去就是在制造假警报'
    );
  }
});

test('节点级审计只有节点主能读（GET /api/shop/audit/node），且只出节点级那一份', async () => {
  const n = await renameNode(`节点公告 ${Date.now()}`);
  const { token } = await login(ctx, owner); // 节点主（MK_SHOP_OWNER）
  const res = await request(app)
    .get('/api/shop/audit/node?pageSize=100')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  const items = itemOf(res.body);
  assert.ok(items.some((i) => i.id === n.id), '节点主必须看得见节点级动作（节点资料/开店审批/保留期触发）');
  assert.ok(!items.some((i) => i.action === 'shop.update'), '节点级列表里不得混进某家店的行');

  // 店主（不是节点主）读节点级那一份：403
  const { token: bToken } = await login(ctx, otherOwner);
  await request(app).get('/api/shop/audit/node').set('Authorization', `Bearer ${bToken}`).expect(403);
  // 匿名：401（两条路由都不放行）
  await request(app).get('/api/shop/audit/node').expect(401);
  await request(app).get('/api/shop/audit').expect(401);
});

test('shopCode 必填：undefined（忘了给）抛错，null（节点级）与编号是两种明确的表态', async () => {
  const before = Number((await db.get('SELECT COUNT(*) AS c FROM audit_logs')).c);

  await assert.rejects(
    () => logAudit({ actor: owner.address, actorRole: 'owner', action: 'probe.missing', targetType: 'test', targetId: 'x' }),
    /缺少 shopCode/,
    '漏传 shopCode 必须当场抛错——猜一个归属就是伪造一条审计'
  );
  await assert.rejects(
    () => logAudit({ actor: owner.address, actorRole: 'owner', action: 'probe.empty', targetType: 'test', targetId: 'x', shopCode: '' }),
    /缺少 shopCode/,
    '空串不是"节点级"的写法（那正是本表栽过的折叠）：节点级要显式 null'
  );
  await assert.rejects(
    () => queryAudit({ pageSize: 1 }),
    /缺少 shopCode/,
    '列表查询漏传 shopCode 就是把整个节点的审计读出来'
  );
  assert.equal(
    Number((await db.get('SELECT COUNT(*) AS c FROM audit_logs')).c),
    before,
    '两次失败都不许留下半行审计'
  );

  // 显式表态：null = 节点级，编号 = 某家店
  await logAudit({ actor: owner.address, actorRole: 'host', action: 'probe.node_level', targetType: 'test', targetId: 'x', shopCode: null });
  const nodeRow = await db.get("SELECT * FROM audit_logs WHERE action = 'probe.node_level' ORDER BY id DESC LIMIT 1");
  assert.equal(nodeRow.shop_code, null);
  assert.equal((await queryAudit({ pageSize: 100, shopCode: null })).items.some((i) => i.action === 'probe.node_level'), true);
  assert.equal((await queryAudit({ pageSize: 100, shopCode: TEST_SHOP_CODE })).items.some((i) => i.action === 'probe.node_level'), false);

  // 指不到任何一家店的编号：外键当场拒绝（不是"写一行谁都看不见的审计"）
  await assert.rejects(
    () => logAudit({ actor: owner.address, actorRole: 'owner', action: 'probe.bad_shop', targetType: 'test', targetId: 'x', shopCode: '0000NOPE9' }),
    /ER_NO_REFERENCED_ROW|foreign key/i
  );
  assert.equal(await db.get("SELECT id FROM audit_logs WHERE action = 'probe.bad_shop'"), undefined, '不存在的店铺编号不得落行');
});

test('链是节点级的：跨店交错写入之后一路接得上，链头覆盖全表最后一行', async () => {
  const a = await renameShop(owner, TEST_SHOP_CODE, `交错 A ${Date.now()}`);
  const n = await renameNode(`交错 N ${Date.now()}`);
  const b = await renameShop(otherOwner, OTHER_SHOP_CODE, `交错 B ${Date.now()}`);

  // 三行三跳：A → N → B（跨店、跨层），每行都必须接在**上一行**的 entry_hash 上
  assert.equal(n.prev_hash, a.entry_hash, '节点级行必须接在 A 店那一行后面（链不分店）');
  assert.equal(b.prev_hash, n.entry_hash, 'B 店那一行必须接在节点级行后面（链不分店）');

  const r = await verifyAuditChain(db);
  assert.equal(r.ok, true, `节点级校验器必须一路接得上：${JSON.stringify(r.broken)}`);
  assert.equal(r.head, b.entry_hash, '链头 = 全表最后一行的 entry_hash（与店铺无关）');
});

test('哈希覆盖店铺维度：把一行的归属改到另一家店 ⇒ 重算必然不等（证据层也认这一维）', async () => {
  const { auditEntryHash } = await import('../src/auditChain.js');
  const row = await renameShop(owner, TEST_SHOP_CODE, `哈希归属 ${Date.now()}`);
  assert.equal(auditEntryHash(row.prev_hash, row), row.entry_hash, '干净行的重算必须逐字相等');
  assert.notEqual(
    auditEntryHash(row.prev_hash, { ...row, shop_code: OTHER_SHOP_CODE }),
    row.entry_hash,
    '把这一行改判给另一家店必须改变哈希——否则"某行出现在/消失在某家店的审计里"就没有证据'
  );
  assert.notEqual(
    auditEntryHash(row.prev_hash, { ...row, shop_code: null }),
    row.entry_hash,
    '把店铺行改成节点级（NULL）同样必须改变哈希'
  );
});
