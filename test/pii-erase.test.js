/**
 * 个人信息擦除 + 保留期（PIPL 式删除请求）单测：
 *  - POST /api/shop/orders/:id/erase-pii（ownerOnly）：终局才可擦、幂等、返回计数不返回内容；
 *  - 擦除后金额/状态/链上托管单号/支付凭证/事件史/评价（无 PII）必须原样保留；
 *  - 证据附件：DB 行与磁盘文件一并删除（只删行 = 数据还在磁盘上，是最常见的假删除）；
 *  - 审计：action=order.erase_pii 落表，detail 只有计数（不得把擦掉的内容抄进审计）；
 *  - 保留期：runPiiRetention 只碰"终局且静置超过阈值"的订单；days=0 = 关闭；
 *    POST /api/shop/retention/run 为同一实现的 ownerOnly 手动入口；周期扫描接线可用。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

// 附件目录（独立临时目录；擦除用例要验证"磁盘文件真的没了"，不能用共享目录）
process.env.MK_ATTACH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-pii-'));

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const operator = Wallet.createRandom();

const { applyEvent } = await import('../src/escrowWatcher.js');
const { eraseOrderPii, runPiiRetention, startPiiRetentionSweep, PII_TOMBSTONE, PII_ERASABLE_STATUS, PII_PROTECTED_STATUS } = await import('../src/piiErase.js');
const { PII_RETENTION_DAYS } = await import('../src/config.js');

let ownerToken;
let buyerToken;
let operatorToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  operatorToken = (await login(ctx, operator)).token;
  // 店员（operator）：能做发货/退款，但删除个人信息是不可逆的店主级动作
  const r = await request(app)
    .put('/api/shop/staff')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ action: 'add', address: operator.address })
    .expect(200);
  assertOk(r);
});

let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

const pngBytes = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8, 1)]);

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug, extra = {}) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slug, ...extra })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 本地镜像"买家已托管"（链上校验不在单测范围，仅置状态与凭证） */
function escrowed(order) {
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), order.id);
}

/** 把订单静置 days 天（保留期扫描以 updated_at 为锚点） */
function ageOrder(orderId, days) {
  db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(Date.now() - days * 86_400_000, orderId);
}

const rowOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const attachRows = (id) => db.prepare('SELECT * FROM evidence_files WHERE order_id = ?').all(id);
const evidenceRows = (id) => db.prepare('SELECT * FROM dispute_evidence WHERE order_id = ? ORDER BY id ASC').all(id);
const diskPath = (orderId, storedName) => path.join(process.env.MK_ATTACH_DIR, orderId, storedName);

const eraseViaApi = (orderId, token = ownerToken) =>
  request(app).post(`/api/shop/orders/${orderId}/erase-pii`).set('Authorization', `Bearer ${token}`).send({});

/** 见证"已收款 + 有售后陈述 + 有附件"的订单（附件只能挂在退款申请阶段） */
async function draftWithEvidenceAndFile(slug, shipping, note, title) {
  const order = await createDraft(slug, { shipping, note });
  escrowed(order);
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  const ev = await request(app)
    .post(`/api/orders/${order.id}/evidence`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ phase: 'refund_request', content: `${title}：收到的货与描述不符` })
    .expect(200);
  assertOk(ev);
  const evId = ev.body.data.evidenceId;
  const up = await request(app)
    .post(`/api/orders/${order.id}/evidence/${evId}/files`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ files: [{ name: 'receipt.png', mime: 'image/png', dataB64: pngBytes().toString('base64') }] })
    .expect(200);
  assertOk(up);
  const stored = attachRows(order.id)[0].stored_name;
  assert.ok(fs.existsSync(diskPath(order.id, stored)), '上传后附件文件应落盘');
  return { order, evId, stored };
}

test('erase-pii：在途单拒绝；终局擦除（含附件行与磁盘文件）；金额/托管单号/凭证/事件史/评价保留；重复调用幂等', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 擦除实物商品' }));
  const { order, evId, stored } = await draftWithEvidenceAndFile(
    p.slug,
    { name: '张三', phone: '13800000000', address: '北京市朝阳区某路 1 号 101 室' },
    '请放门口，到达前电话联系',
    '开箱不符'
  );
  const beforeRow = rowOf(order.id);
  assert.equal(beforeRow.shipping_name, '张三');
  assert.equal(beforeRow.note, '请放门口，到达前电话联系');

  // ── 在途（escrowed）：拒绝擦除——卖家还得靠收货信息发货 ──
  const inflight = await eraseViaApi(order.id);
  assert.notEqual(inflight.body.code, 0);
  assert.match(inflight.body.message, /资金流未终结/);
  assert.equal(rowOf(order.id).shipping_name, '张三', '在途单的收货信息必须原样保留');

  // 匿名 / 店员均不可擦（ownerOnly）
  const anon = await request(app).post(`/api/shop/orders/${order.id}/erase-pii`).send({}).expect(401);
  assert.notEqual(anon.body.code, 0);
  const staff = await eraseViaApi(order.id, operatorToken);
  assert.equal(staff.status, 403);

  // ── 终局：买家确认收货（confirmed）+ 提交评价（无 PII，擦除后必须保留）──
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 7 }), 1);
  const rev = await request(app)
    .post(`/api/orders/${order.id}/review`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ rating: 5, content: '沟通顺畅' })
    .expect(200);
  assertOk(rev);

  // 擦除前的终局快照：擦除只许动 PII，账目/链上凭证/状态一个字段都不许变
  const preErase = rowOf(order.id);
  const res = await eraseViaApi(order.id);
  assertOk(res);
  assert.equal(res.body.data.alreadyErased, false);
  assert.deepEqual(res.body.data.erased, {
    shippingFields: 4, // 收货人/电话/地址 + 备注
    invoiceFields: 0, // 本单未填写开票信息
    evidenceContents: 1,
    attachmentRows: 1,
    attachmentFiles: 1,
  });
  // 响应只给计数，不给被擦除的内容（否则等于把 PII 又发了一遍）
  assert.ok(!JSON.stringify(res.body).includes('张三'), '响应不得回显被擦除的内容');
  assert.ok(!JSON.stringify(res.body).includes('13800000000'), '响应不得回显被擦除的字段值');

  // ── 数据面：PII 没了，账目/链上凭证/评价一个不少 ──
  const after = rowOf(order.id);
  assert.equal(after.shipping_name, '');
  assert.equal(after.shipping_phone, '');
  assert.equal(after.shipping_address, '');
  assert.equal(after.note, '');
  assert.equal(after.status, preErase.status, '状态不变（终态）');
  assert.equal(after.amount_wei, preErase.amount_wei, '金额保留（账目不可删）');
  assert.equal(after.escrow_order_id, preErase.escrow_order_id, '链上托管单号保留');
  assert.equal(after.paid_tx_hash, preErase.paid_tx_hash, '支付凭证哈希保留');
  assert.equal(after.refunded_amount_wei, preErase.refunded_amount_wei);
  assert.ok(JSON.parse(after.onchain_events || '[]').length >= 2, '链上事件史保留（OrderCreated + 确认）');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reviews WHERE order_id = ?').get(order.id).c, 1, '评价（无 PII）保留');

  // 陈述行保留（时间线事实），只有正文换成墓碑
  const evRows = evidenceRows(order.id);
  assert.equal(evRows.length, 1, '陈述行不删（谁在何时提交过是争议事实）');
  assert.equal(evRows[0].content, PII_TOMBSTONE);
  assert.equal(evRows[0].role, 'buyer');
  assert.equal(evRows[0].phase, 'refund_request');

  // 附件行与磁盘文件都消失
  assert.equal(attachRows(order.id).length, 0, '附件行已删除');
  assert.equal(fs.existsSync(diskPath(order.id, stored)), false, '磁盘文件已删除（不能只删行）');

  // 审计入账：detail 只有计数与来源
  const audit = db
    .prepare("SELECT * FROM audit_logs WHERE action = 'order.erase_pii' AND target_id = ? ORDER BY id DESC LIMIT 1")
    .get(order.id);
  assert.ok(audit, '擦除必须写审计');
  const detail = JSON.parse(audit.detail);
  assert.equal(detail.trigger, 'request');
  assert.equal(detail.shippingFields, 4);
  assert.equal(detail.attachmentRows, 1);
  assert.ok(!JSON.stringify(detail).includes('张三'), '审计 detail 不得含被擦除的内容');

  // ── 幂等：重复调用不报错、不重复计数、不再产生变更 ──
  const again = await eraseViaApi(order.id);
  assertOk(again);
  assert.equal(again.body.data.alreadyErased, true);
  assert.deepEqual(again.body.data.erased, {
    shippingFields: 0,
    invoiceFields: 0,
    evidenceContents: 0,
    attachmentRows: 0,
    attachmentFiles: 0,
  });
  assert.equal(evidenceRows(order.id)[0].content, PII_TOMBSTONE);
});

test('erase-pii：附件行已删但磁盘残留孤儿文件时，重复调用仍会清掉目录（幂等自愈）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 孤儿附件商品' }));
  const { order, stored } = await draftWithEvidenceAndFile(p.slug, { name: '李四', phone: '13900000000', address: '上海市某路 2 号' }, '备注', '孤儿');
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 8 }), 1);
  // 模拟"上次调用删了 DB 行、删文件阶段失败"：手工删行、留文件
  db.prepare('DELETE FROM evidence_files WHERE order_id = ?').run(order.id);
  assert.ok(fs.existsSync(diskPath(order.id, stored)));
  const res = await eraseViaApi(order.id);
  assertOk(res);
  assert.equal(res.body.data.erased.attachmentRows, 0, '已无附件行');
  assert.equal(res.body.data.erased.attachmentFiles, 1, '孤儿文件仍被本次调用清掉');
  assert.equal(fs.existsSync(diskPath(order.id, stored)), false);
});

test('保留期：终局且静置超过阈值才擦；在途与未到期一律不动；days=0 = 关闭', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 保留期商品' }));
  // ① 终局 + 超期（200 天）：应被擦
  const stale = await createDraft(p.slug, { shipping: { name: '王五', phone: '13700000000', address: '广州市某路 3 号' }, note: '超期单' });
  escrowed(stale);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: stale.escrowOrderId }, { txHash: payHash(), block: 9 }), 1);
  ageOrder(stale.id, 200);
  // ② 终局但未超期（刚更新）：不擦
  const fresh = await createDraft(p.slug, { shipping: { name: '赵六', phone: '13600000000', address: '深圳市某路 4 号' }, note: '新单' });
  escrowed(fresh);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: fresh.escrowOrderId }, { txHash: payHash(), block: 10 }), 1);
  // ③ 在途（escrowed）且极旧：不擦（卖家要按地址发货）
  const inflight = await createDraft(p.slug, { shipping: { name: '钱七', phone: '13500000000', address: '杭州市某路 5 号' }, note: '在途单' });
  escrowed(inflight);
  ageOrder(inflight.id, 400);

  const rowBeforeErase = rowOf(stale.id);
  const r = runPiiRetention({ days: 180 });
  assert.equal(r.erased, 1);
  assert.deepEqual(r.orderIds, [stale.id], '只有终局且静置 > 180 天的订单被擦');
  assert.equal(r.candidates, 1, '在途单不进候选（SQL 层已按终局状态过滤）');
  assert.equal(r.counts.shippingFields, 4);
  assert.equal(rowOf(stale.id).shipping_name, '');
  assert.equal(rowOf(fresh.id).shipping_name, '赵六', '未到期订单保留');
  assert.equal(rowOf(inflight.id).shipping_name, '钱七', '在途订单保留');
  assert.equal(rowOf(inflight.id).note, '在途单');
  // 保留期擦除逐单入审计（detail.trigger 区分来源）
  const audit = db
    .prepare("SELECT * FROM audit_logs WHERE action = 'order.erase_pii' AND target_id = ? ORDER BY id DESC LIMIT 1")
    .get(stale.id);
  assert.ok(audit, '保留期擦除同样入审计');
  assert.equal(JSON.parse(audit.detail).trigger, 'retention');

  /*
    幂等：已擦净的行**写的是 pii_erased_at**（擦除锚点），`updated_at` 一个字节都不动——
    两者都要断言，因为旧实现正是靠刷新 updated_at 实现幂等的，而那会让一笔 200 天前的成交额
    重新落进"最近 30 天"的报表窗口（见下一条用例）。
  */
  const erasedRow = rowOf(stale.id);
  assert.ok(Number(erasedRow.pii_erased_at) > 0, '擦除必须写 pii_erased_at 作为保留期锚点');
  assert.equal(
    erasedRow.updated_at,
    rowBeforeErase.updated_at,
    '擦除不得改写 updated_at（入账/争议起始时刻的口径）'
  );
  const second = runPiiRetention({ days: 180 });
  assert.equal(second.erased, 0);
  assert.equal(second.candidates, 0, '擦过的单不再进候选（锚点仍是擦除时刻，不会重复占批量上限）');

  // 0 = 关闭（MK_PII_RETENTION_DAYS=0 的语义）：不扫描、不擦除
  const off = runPiiRetention({ days: 0 });
  assert.equal(off.disabled, true);
  assert.equal(off.erased, 0);
  assert.equal(off.candidates, 0);
  // 非法天数直接抛（路由层另有校验）
  assert.throws(() => runPiiRetention({ days: -1 }), /保留期天数无效/);

  // 配置默认值：MK_PII_RETENTION_DAYS 未设置 → 180 天
  assert.equal(PII_RETENTION_DAYS, 180, '默认保留期为 180 天');
  // 擦除面与保护面互斥且覆盖全部订单状态：日后新增状态时必须显式决定它属于哪一侧
  const ALL_STATUS = ['draft', 'escrowed', 'shipped', 'confirmed', 'disputed', 'settled', 'refunded', 'expired', 'cancelled'];
  assert.deepEqual([...PII_ERASABLE_STATUS, ...PII_PROTECTED_STATUS].sort(), [...ALL_STATUS].sort());
  assert.ok(PII_ERASABLE_STATUS.includes('refunded'));
  assert.ok(!PII_ERASABLE_STATUS.includes('escrowed'), '在途状态不可擦');
});

test('保留期擦除不得把旧成交额挪进近期报表窗口（入账口径 = updated_at，2026-09 复审修复）', async () => {
  /*
    业务危害（源码评审 2026-09，P1）：流水页 / 看板 GMV / 趋势日桶 / ledger.csv 全按
    `orders.updated_at` 分窗（routes/orders.js 的 INCOME_STATUS 窗口、stats.js、routes/export.js）。
    旧实现在保留期扫描里把 `updated_at` 刷成擦除当天，于是一笔 200 天前的成交额会在被擦那个月
    **重新落进"最近 30 天"**，同一笔钱跨月各出现一次——不报错，只是对不上账。
    这里直接按"最近 30 天入账窗口"的判据断言擦除前后口径不变。
  */
  const p = await listProduct(productPayload({ kind: 'physical', title: '入账口径商品' }));
  const o = await createDraft(p.slug, { shipping: { name: '吴九', phone: '13300000000', address: '南京市某路 7 号' }, note: '入账口径单' });
  escrowed(o);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: o.escrowOrderId }, { txHash: payHash(), block: 12 }), 1);
  ageOrder(o.id, 200); // 200 天前终局（入账时刻）

  // 与 routes/orders.js 的流水窗口同判据：终局状态 + updated_at >= 窗口起点
  const win30 = Date.now() - 30 * 86_400_000;
  const inIncomeWindow = (id) =>
    !!db
      .prepare("SELECT 1 FROM orders WHERE id = ? AND status IN ('confirmed','settled','expired') AND updated_at >= ?")
      .get(id, win30);
  assert.equal(inIncomeWindow(o.id), false, '200 天前的成交不该落在最近 30 天窗口');

  const r = runPiiRetention({ days: 180 });
  assert.deepEqual(r.orderIds, [o.id], '该单应被保留期扫描命中');
  assert.equal(inIncomeWindow(o.id), false, '擦除后它仍然不在最近 30 天窗口（旧实现在这里会变成 true）');

  // 反向断言：入账时刻确实没被动过（而不是"窗口查询恰好没命中"）
  const row = db.prepare('SELECT updated_at, created_at, pii_erased_at FROM orders WHERE id = ?').get(o.id);
  assert.ok(row.updated_at < win30, 'updated_at 仍是 200 天前那一刻');
  assert.ok(Number(row.pii_erased_at) > win30, '锚点列是"刚刚擦除"，与账目列互不干扰');
});

test('POST /api/shop/retention/run：ownerOnly；缺省用配置阈值；可显式覆盖天数；入审计', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 保留期端点商品' }));
  const order = await createDraft(p.slug, { shipping: { name: '孙八', phone: '13400000000', address: '成都市某路 6 号' }, note: '端点保留期单' });
  escrowed(order);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 11 }), 1);
  ageOrder(order.id, 30); // 30 天：按默认 180 天不动，按显式 7 天该擦

  const anon = await request(app).post('/api/shop/retention/run').send({}).expect(401);
  assert.notEqual(anon.body.code, 0);
  const staff = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${operatorToken}`).send({}).expect(403);
  assert.notEqual(staff.body.code, 0);

  // 缺省阈值 = config.pii.retentionDays（测试环境 = 180）
  const def = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).send({}).expect(200);
  assertOk(def);
  assert.equal(def.body.data.days, 180);
  assert.equal(def.body.data.erased, 0);
  assert.equal(rowOf(order.id).shipping_name, '孙八', '30 天 < 180 天：不擦');

  // 显式收紧到 7 天：同一订单立刻到期
  const run = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).send({ days: 7 }).expect(200);
  assertOk(run);
  assert.equal(run.body.data.days, 7);
  assert.equal(run.body.data.erased, 1);
  assert.deepEqual(run.body.data.orderIds, [order.id]);
  assert.equal(run.body.data.counts.shippingFields, 4);
  assert.equal(rowOf(order.id).shipping_name, '');
  assert.equal(rowOf(order.id).status, 'confirmed', '终态与账目不变');

  // 非法天数拒绝
  const bad = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).send({ days: -1 }).expect(200);
  assert.notEqual(bad.body.code, 0);
  // 手动运行本身入审计（action=retention.run）
  assert.ok(db.prepare("SELECT * FROM audit_logs WHERE action = 'retention.run'").get(), '手动运行入审计');
});

/**
 * 手动保留期端点的**单飞 + 结果复用**（T3）：
 * runPiiRetention 是全同步重活（一次最多擦 200 单，期间独占事件循环），重复点击/脚本重放
 * 只会在队列里再排一次同样的活。故：距上次结束 < 2 秒且 days 相同 → 复用上次结果并标注
 * `reused: true`，**不重复擦**；days 不同 = 货真价实的另一次运行，不复用。
 * 证伪方式：先跑一次擦掉到期单，再在同一窗口内新建一张到期单并重复请求——
 * 若没有单飞，第二次会把它也擦掉（erased 变 2、该单的收货信息被清空）。
 */
test('POST /api/shop/retention/run 单飞：2 秒内的重复请求复用上次结果（不重复跑重活）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 单飞商品' }));
  const first = await createDraft(p.slug, { shipping: { name: '陈一', phone: '13000000001', address: '天津市某路 1 号' } });
  escrowed(first);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: first.escrowOrderId }, { txHash: payHash(), block: 21 }), 1);
  ageOrder(first.id, 205); // 205 天：用 days=200 的窗口擦它

  const run1 = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).send({ days: 200 }).expect(200);
  assertOk(run1);
  assert.equal(run1.body.data.days, 200);
  assert.equal(run1.body.data.erased, 1);
  assert.deepEqual(run1.body.data.orderIds, [first.id]);
  assert.equal(run1.body.data.reused, undefined, '首次运行不是复用');
  assert.equal(rowOf(first.id).shipping_name, '', '到期单已擦');

  // 同一窗口内再造一张到期单：如果单飞失效，第二次运行会把它擦掉
  const second = await createDraft(p.slug, { shipping: { name: '陈二', phone: '13000000002', address: '天津市某路 2 号' } });
  escrowed(second);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: second.escrowOrderId }, { txHash: payHash(), block: 22 }), 1);
  ageOrder(second.id, 205);

  const run2 = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).send({ days: 200 }).expect(200);
  assertOk(run2);
  assert.equal(run2.body.data.reused, true, '2 秒内的重复请求复用上次结果');
  assert.equal(run2.body.data.erased, 1, '复用上次结果（未再跑一遍）');
  assert.match(run2.body.message, /复用/);
  assert.equal(rowOf(second.id).shipping_name, '陈二', '第二次没有真的运行 ⇒ 新到期单仍在（这正是单飞的意义）');

  // 不同 days = 另一次运行（不复用）：收紧到 100 天后第二张单立刻到期
  const run3 = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).send({ days: 100 }).expect(200);
  assertOk(run3);
  assert.equal(run3.body.data.reused, undefined, 'days 不同不复用');
  assert.equal(run3.body.data.days, 100);
  assert.equal(run3.body.data.erased, 1);
  assert.equal(rowOf(second.id).shipping_name, '', '这一次真的运行了');
});

test('周期扫描接线：startPiiRetentionSweep 启动即收敛一次并返回定时器', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 周期扫描商品' }));
  const order = await createDraft(p.slug, { shipping: { name: '周九', phone: '13300000000', address: '南京市某路 7 号' }, note: '周期单' });
  escrowed(order);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 12 }), 1);
  ageOrder(order.id, 365);
  const timer = startPiiRetentionSweep();
  assert.ok(timer, '已启用保留期时应返回定时器（tick 同步执行一次）');
  clearInterval(timer);
  assert.equal(rowOf(order.id).shipping_name, '', '启动即收敛：超期订单在首轮 tick 已擦除');
});

/**
 * 开票信息（C）同样是个人信息：抬头常是真实姓名、税号指向具体主体。
 * 擦除只清 title/taxNo（内容），保留 invoice_needed 这个"要不要开票"的处理标记
 * ——它是订单处理状态、不是个人信息，与金额/状态同列为不可删的订单事实。
 */
test('开票信息（抬头/税号）随 PII 擦除一并清空；invoice_needed 标记保留；幂等且不污染审计', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 开票商品' }));
  const order = await createDraft(p.slug, {
    shipping: { name: '吴十', phone: '13200000000', address: '武汉市某路 8 号' },
    invoice: { needed: true, title: '某某科技有限公司', taxNo: '91310000MA1K35XXXX' },
  });
  assert.equal(rowOf(order.id).invoice_needed, 1);
  assert.equal(rowOf(order.id).invoice_title, '某某科技有限公司');
  assert.equal(rowOf(order.id).invoice_tax_no, '91310000MA1K35XXXX');

  // 在途单不可擦（发票信息与收货信息同受资金流未终结的约束）
  const inflight = await eraseViaApi(order.id);
  assert.notEqual(inflight.body.code, 0);
  assert.equal(rowOf(order.id).invoice_title, '某某科技有限公司', '在途单的开票信息保留（店主还要开票）');

  escrowed(order);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 13 }), 1);

  const res = await eraseViaApi(order.id);
  assertOk(res);
  // 收货信息 3 项 + 备注 0 项；开票 2 项
  assert.equal(res.body.data.erased.shippingFields, 3);
  assert.equal(res.body.data.erased.invoiceFields, 2, '抬头与税号各计一项');
  assert.ok(!JSON.stringify(res.body).includes('某某科技'), '响应不得回显被擦除的开票抬头');
  assert.ok(!JSON.stringify(res.body).includes('91310000MA1K35XXXX'), '响应不得回显被擦除的税号');

  const after = rowOf(order.id);
  assert.equal(after.invoice_title, '');
  assert.equal(after.invoice_tax_no, '');
  assert.equal(after.invoice_needed, 1, 'invoice_needed 是订单处理标记（非 PII），保留');
  assert.equal(after.amount_wei, rowOf(order.id).amount_wei, '金额不变');

  const audit = db
    .prepare("SELECT * FROM audit_logs WHERE action = 'order.erase_pii' AND target_id = ? ORDER BY id DESC LIMIT 1")
    .get(order.id);
  assert.equal(JSON.parse(audit.detail).invoiceFields, 2);
  assert.ok(!JSON.stringify(audit.detail).includes('某某科技'), '审计 detail 不得含被擦除的开票信息');

  // 幂等：重复调用不报错、不重复计数
  const again = await eraseViaApi(order.id);
  assertOk(again);
  assert.equal(again.body.data.alreadyErased, true);
  assert.equal(again.body.data.erased.invoiceFields, 0);

  // 保留期通道同口径：带开票信息的终局单到期后同样被清
  const stale = await createDraft(p.slug, {
    shipping: { name: '郑十一', phone: '13100000000', address: '西安市某路 9 号' },
    invoice: { needed: true, title: '某某商贸行', taxNo: '91440300MA5FXXXXXX' },
  });
  escrowed(stale);
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: stale.escrowOrderId }, { txHash: payHash(), block: 14 }), 1);
  ageOrder(stale.id, 200);
  const sweep = runPiiRetention({ days: 180 });
  assert.ok(sweep.orderIds.includes(stale.id), '到期单进保留期擦除');
  assert.equal(rowOf(stale.id).invoice_title, '', '保留期通道同样清空开票抬头');
  assert.equal(rowOf(stale.id).invoice_tax_no, '');
});
