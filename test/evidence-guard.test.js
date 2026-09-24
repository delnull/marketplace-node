/**
 * 售后陈述 / 证据附件的**订单状态门控**与**条数上限**（T2、T3）。
 *
 * 现状缺陷（源码审计 2026-09）：
 *  · 门控只看 `refund_status`，不看订单状态；而 refund_status 只在 watcher/sync 的终局迁移里复位，
 *    `/cancel` 不复位。于是一笔「escrowed 无支付凭证（异常态）+ refund_status='requested'」的单
 *    被买家 /cancel 之后，店主再对它 erase-pii（cancelled 在可擦集里）就出现**擦除不 sticky**：
 *    擦完仍能继续提交 ≤2000 字陈述与 ≤6 个附件/20MB，"已按删除请求擦净"的单上又落下新的个人信息。
 *  · 陈述无条数上限：单方可以对一笔单循环提交，把时间线与裁决面淹掉。
 *
 * 本文件用真实端点钉住：
 *  1. cancelled（售后镜像残留在 requested）→ 陈述与附件上传**都**被状态门控拒绝；
 *  2. /cancel 成功时把 refund_status 复位为 none（本地终局不留"退款申请待处理"的残影）；
 *  3. 「cancel → erase-pii → 再提交」整条滥用链被堵死（擦除后不再产生新的个人数据）；
 *  4. 每单每角色每阶段的条数上限（仲裁阶段 20 条；对方不占你的额度）；
 *  5. **阶段门控只有一份实现**（源码审计 2026-09 续）：陈述端点与附件端点对同一
 *     (订单, 阶段) 必须给出**逐字相同**的拒绝理由，身份分支是 403——两侧各写一遍判据
 *     必然漂移，而漂移的后果是一侧拒了、另一侧照收 20MB 个人数据。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, login, assertOk } from './setup.mjs';

// 附件目录（擦除用例要验证"磁盘真的动过"；独立临时目录避免与他人共享）
process.env.MK_ATTACH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-evguard-'));

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

/**
 * 仲裁阶段的条数上限（**故意写死 20**，而不是 import 生产常量）：上限是产品决策，
 * 有人下调它时这条用例应当变红提醒"这是安全闸"，而不是自动跟着走。
 * 生产实现在 src/evidenceFiles.js 的 EVIDENCE_LIMIT_BY_PHASE（陈述端点与附件端点共用的
 * 唯一一份阶段事实；orders.js 只是转出）。
 */
const ARB_CAP = 20;

let buyerToken;
let ownerToken;
before(async () => {
  buyerToken = (await login(ctx, buyer)).token;
  ownerToken = (await login(ctx, owner)).token;
});

let seq = 0;
/**
 * 直接插本地订单行（状态/售后镜像/收货信息全由用例指定——本文件关心的是门控，
 * 不是下单流程；这样才构造得出"异常态 + 镜像残留"这种真实但少见的组合）。
 */
function insertOrder({ status = 'escrowed', refundStatus = 'none', paid = false, shipping = '' } = {}) {
  seq += 1;
  const id = `ev-${seq}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, cny_fen, bty_usdt_rate, usdt_cny_rate, status, escrow_order_id, paid_tx_hash,
       refund_status, shipping_name, created_at, updated_at)
     VALUES (?, 'p-ev', '{}', '0x00', '', ?, ?, '1000', 100, '0.1', '7.2', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    buyer.address.toLowerCase(),
    owner.address.toLowerCase(),
    status,
    `0x${String(seq).padStart(64, '0')}`,
    paid ? `0x${String(seq).padStart(64, 'f')}` : null,
    refundStatus,
    shipping,
    now,
    now
  );
  return { id, escrowOrderId: `0x${String(seq).padStart(64, '0')}` };
}

/** 造一条已有的陈述行（角色 buyer / 阶段 refund_request），供附件上传走到门控 */
function insertEvidence(orderId, { role = 'buyer', phase = 'refund_request', content = '既有陈述' } = {}) {
  const r = db
    .prepare('INSERT INTO dispute_evidence (order_id, role, phase, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(orderId, role, phase, content, Date.now());
  return Number(r.lastInsertRowid);
}

const rowOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const evidenceCount = (id) => db.prepare('SELECT COUNT(*) AS c FROM dispute_evidence WHERE order_id = ?').get(id).c;

const postEvidence = (orderId, body, token = buyerToken) =>
  request(app).post(`/api/orders/${orderId}/evidence`).set('Authorization', `Bearer ${token}`).send(body);

const pngB64 = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8, 1)]).toString('base64');
const uploadFile = (orderId, evidenceId, token = buyerToken) =>
  request(app)
    .post(`/api/orders/${orderId}/evidence/${evidenceId}/files`)
    .set('Authorization', `Bearer ${token}`)
    .send({ files: [{ name: 'proof.png', mime: 'image/png', dataB64: pngB64() }] });

const cancelOrder = (orderId, token = buyerToken) =>
  request(app).post(`/api/orders/${orderId}/cancel`).set('Authorization', `Bearer ${token}`).send({});
const erasePii = (orderId) =>
  request(app).post(`/api/shop/orders/${orderId}/erase-pii`).set('Authorization', `Bearer ${ownerToken}`).send({});

test('cancelled 单（售后镜像残留在 requested）不再受理售后陈述与附件', async () => {
  // 这笔单正是缺陷场景：异常态被取消，但 refund_status 仍停在 requested
  const o = insertOrder({ status: 'cancelled', refundStatus: 'requested', shipping: '张三 13800000000' });
  const evId = insertEvidence(o.id);
  assert.equal(rowOf(o.id).refund_status, 'requested', '前置：镜像残留 requested（旧实现据此放行）');

  const stmt = await postEvidence(o.id, { phase: 'refund_request', content: '取消了我还要补充陈述' });
  assert.notEqual(stmt.body.code, 0, '陈述必须被拒');
  assert.match(stmt.body.message, /不接受新的售后陈述/);
  assert.match(stmt.body.message, /cancelled/, '拒绝原因要说明当前状态，可行动');

  const up = await uploadFile(o.id, evId);
  assert.notEqual(up.body.code, 0, '附件上传必须被拒（它是个人数据的主要载体）');
  assert.match(up.body.message, /不接受新的售后陈述/);
  assert.equal(evidenceCount(o.id), 1, '没有新增陈述行（写入侧真的被挡住了）');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM evidence_files WHERE order_id = ?').get(o.id).c, 0, '没有落任何附件行');
});

test('/cancel 复位售后镜像：状态置 cancelled 的同时 refund_status → none', async () => {
  const o = insertOrder({ status: 'escrowed', refundStatus: 'requested', paid: false });
  const res = await cancelOrder(o.id);
  assertOk(res);
  const row = rowOf(o.id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.refund_status, 'none', '本地终局不留"退款申请待处理"的残影（与 watcher/sync 终局迁移同口径）');

  // 取消后再提交：被**状态门控**拒绝（而不是仅靠 refund_status 恰好已是 none——
  // 门控顺序决定了拒因，这条断言钉住"状态是第一道闸"）
  const stmt = await postEvidence(o.id, { phase: 'refund_request', content: '取消后补理由' });
  assert.notEqual(stmt.body.code, 0);
  assert.match(stmt.body.message, /不接受新的售后陈述/);
});

test('擦除不 sticky：cancel → erase-pii → 仍然无法在这张单上落下新的个人信息', async () => {
  const o = insertOrder({ status: 'escrowed', refundStatus: 'requested', paid: false, shipping: '李四 13900000000' });
  const evId = insertEvidence(o.id, { content: '原陈述：货不对版' });
  assert.equal((await cancelOrder(o.id)).body.code, 0, '异常单可被取消');

  const erased = await erasePii(o.id);
  assertOk(erased);
  assert.equal(rowOf(o.id).shipping_name, '', '擦除已生效（cancelled 在可擦集里）');
  assert.equal(rowOf(o.id).refund_status, 'none', '取消已复位镜像（配合状态门控，双保险）');

  // 关键断言：擦除之后，陈述与附件都进不来 —— 否则"已删除"的单上又会长出新的个人数据
  const stmt = await postEvidence(o.id, { phase: 'refund_request', content: '擦完我再写一段 2000 字的个人信息' });
  assert.notEqual(stmt.body.code, 0);
  assert.match(stmt.body.message, /不接受新的售后陈述/);
  const up = await uploadFile(o.id, evId);
  assert.notEqual(up.body.code, 0);
  assert.equal(evidenceCount(o.id), 1, '陈述行数不变（只有那条已被墓碑化的历史)');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM evidence_files WHERE order_id = ?').get(o.id).c, 0);
  assert.equal(rowOf(o.id).shipping_name, '', 'PII 仍然是空的（没有被新提交"喂"回来）');
});

test('阶段门控只有一份实现：陈述端点与附件端点对同一 (订单, 阶段) 给出**逐字相同**的拒绝', async () => {
  /*
    这条用例钉住的是"**唯一实现**"本身（源码审计 2026-09 续）。
    此前 `POST /:id/evidence` 与 `POST /:id/evidence/:evidenceId/files` 各写了一遍
    「订单状态 → 身份 → refund_status → 阶段语义」的判据，文案已经漂移
    （附件那侧多一句"请在争议流程中提交仲裁陈述"，且把"未知阶段"落进 arbitration 分支）。
    门控漂移不是文案问题：一侧拒了、另一侧照收，就是往一张已经不允许陈述的单上追加 20MB 个人数据。
    所以这里不比对"是否都拒绝"，而是比对**拒绝理由是否逐字相同**——文案一旦分叉立刻变红。
  */
  const cases = [
    // 阶段 × 订单状态 的三种被拒组合（身份与 evidence.role 对齐，才能走到两个端点共用的那道门控）
    { status: 'disputed', refundStatus: 'requested', role: 'seller', phase: 'refund_reply', why: '争议中无"回复退款申请"语义' },
    { status: 'escrowed', refundStatus: 'none', role: 'buyer', phase: 'refund_request', why: '没有待处理的退款申请' },
    { status: 'escrowed', refundStatus: 'none', role: 'buyer', phase: 'arbitration', why: '非争议态不受理仲裁陈述' },
  ];
  for (const c of cases) {
    const o = insertOrder({ status: c.status, refundStatus: c.refundStatus });
    const evId = insertEvidence(o.id, { role: c.role, phase: c.phase });
    const token = c.role === 'seller' ? ownerToken : buyerToken;
    const before = evidenceCount(o.id); // 前置证据行（附件端点必须有一条既有陈述才能走到阶段门控）

    const stmt = await postEvidence(o.id, { phase: c.phase, content: '试探门控' }, token);
    assert.notEqual(stmt.body.code, 0, `[${c.why}] 陈述端点必须拒绝`);
    const up = await uploadFile(o.id, evId, token);
    assert.notEqual(up.body.code, 0, `[${c.why}] 附件端点必须拒绝`);
    assert.equal(
      up.body.message,
      stmt.body.message + '（附件同证据阶段门控）',
      `[${c.why}] 附件端点的拒因必须**逐字**来自陈述端点那一份（漂移即变红）：${stmt.body.message}`
    );
    assert.equal(evidenceCount(o.id), before, `[${c.why}] 被拒的陈述没有落库`);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM evidence_files WHERE order_id = ?').get(o.id).c,
      0,
      `[${c.why}] 被拒的附件没有落盘`
    );
  }
});

test('阶段门控的身份分支返回 403（业务码与 HTTP 都是 403），不与"阶段不对"混为一谈', async () => {
  const o = insertOrder({ status: 'escrowed', refundStatus: 'requested' });
  // 店主去提交"退款理由"（那是买家的阶段）
  const asSeller = await postEvidence(o.id, { phase: 'refund_request', content: '我自己回复自己' }, ownerToken);
  assert.equal(asSeller.body.code, 403, '身份不符是 403，不是普通业务拒绝');
  assert.match(asSeller.body.message, /仅买家可提交/);
  assert.equal(evidenceCount(o.id), 0);
  // 买家去提交"退款回复"（那是店主的阶段）
  const asBuyer = await postEvidence(o.id, { phase: 'refund_reply', content: '我自己回复自己' });
  assert.equal(asBuyer.body.code, 403);
  assert.match(asBuyer.body.message, /仅店主可提交/);
  assert.equal(evidenceCount(o.id), 0);
  // 同一个 endpoint 上，同样的身份若换成自己那一侧，就能提交（证明上面的 403 来自身份而不是别的门）
  assertOk(await postEvidence(o.id, { phase: 'refund_request', content: '这次是对的阶段' }));
  assert.equal(evidenceCount(o.id), 1);
});

test('详情陈述行有展示上限：历史脏数据（>100 条）被截断但总数照报（读取侧的 N+1 防护）', async () => {
  const o = insertOrder({ status: 'disputed' });
  // 绕过写入侧的条数上限，直接批量塞 130 条（模拟"老版本无上限时期"的历史数据）
  const ins = db.prepare('INSERT INTO dispute_evidence (order_id, role, phase, content, created_at) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < 130; i++) ins.run(o.id, i % 2 === 0 ? 'buyer' : 'seller', 'arbitration', `历史陈述 ${i + 1}`, Date.now() + i);
  db.exec('COMMIT');

  const detail = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assertOk(detail);
  const ev = detail.body.data.evidence;
  assert.equal(detail.body.data.evidenceCount, 130, '总数如实上报');
  assert.equal(ev.length, 100, '一次最多返回 100 条（详情对每行都要拼附件元数据，行数必须封顶）');
  assert.equal(detail.body.data.evidenceTruncated, true, '被截断要显式标注（前端提示"仅展示最近 N 条"）');
  assert.equal(ev[ev.length - 1].content, '历史陈述 130', '取的是**最近**的 100 条，且按时间线升序返回');
  assert.equal(ev[0].content, '历史陈述 31');
});

test('陈述条数上限：仲裁阶段每角色 20 条，超出拒绝；对方额度互不影响', async () => {
  const o = insertOrder({ status: 'disputed', refundStatus: 'requested' });
  // 买家把额度用满
  for (let i = 0; i < ARB_CAP; i++) {
    const r = await postEvidence(o.id, { phase: 'arbitration', content: `买家陈述 ${i + 1}` });
    assertOk(r);
  }
  const over = await postEvidence(o.id, { phase: 'arbitration', content: '第 21 条' });
  assert.notEqual(over.body.code, 0, '超过上限必须拒绝');
  assert.match(over.body.message, /上限/);
  assert.match(over.body.message, new RegExp(String(ARB_CAP)));
  assert.equal(evidenceCount(o.id), ARB_CAP, '超限的那条没有落库');

  // 店主不受买家额度影响（额度按 (单, 角色, 阶段) 计）
  const seller = await postEvidence(o.id, { phase: 'arbitration', content: '卖家陈述：不同意仅退款' }, ownerToken);
  assertOk(seller);
  assert.equal(evidenceCount(o.id), ARB_CAP + 1);
  // 买家仍受自己额度约束
  assert.notEqual((await postEvidence(o.id, { phase: 'arbitration', content: '再补一条' })).body.code, 0);

  // 详情读取侧：陈述行按时间线升序返回，并给出总条数（展示上限见 EVIDENCE_DETAIL_LIMIT）
  const detail = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  assertOk(detail);
  assert.equal(detail.body.data.evidenceCount, ARB_CAP + 1, '详情给出陈述总条数');
  assert.equal(detail.body.data.evidenceTruncated, false, `未超过展示上限 ${ARB_CAP + 1} 条`);
  assert.equal(detail.body.data.evidence.length, ARB_CAP + 1);
  assert.equal(detail.body.data.evidence[ARB_CAP].role, 'seller', '按 id 升序 = 时间线顺序');
  assert.deepEqual(detail.body.data.evidence[0].files, [], '无附件的陈述给空数组（批量查询口径）');

  // 附件随陈述上传后，详情用批量查询取回元数据（不是逐行 filesOfEvidence 的 N+1）
  const evId = detail.body.data.evidence[0].id;
  assertOk(await uploadFile(o.id, evId));
  const detail2 = await request(app).get(`/api/orders/${o.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  const first = detail2.body.data.evidence.find((e) => e.id === evId);
  assert.equal(first.files.length, 1);
  assert.equal(first.files[0].name, 'proof.png');
  assert.deepEqual(
    detail2.body.data.evidence.find((e) => e.id !== evId).files,
    [],
    '没有附件的陈述不受批量查询影响（空数组）'
  );
});
