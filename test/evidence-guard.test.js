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
import { makeCtx, login, assertOk, shopRef, insertOrder as insertOrderRow } from './setup.mjs';

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
  ({ withTransaction } = await import('../src/db.js'));
  buyerToken = (await login(ctx, buyer)).token;
  ownerToken = (await login(ctx, owner)).token;
});
/** 事务入口（批量插历史数据用；见"详情陈述行有展示上限"那条用例） */
let withTransaction;

let seq = 0;
/**
 * 直接插本地订单行（状态/售后镜像/收货信息全由用例指定——本文件关心的是门控，
 * 不是下单流程；这样才构造得出"异常态 + 镜像残留"这种真实但少见的组合）。
 *
 * 行形状交给 setup.mjs 的 `insertOrder`：`refund_status`/`paid_tx_hash` 住在 `order_chain`，
 * 收货信息（这里只用到姓名）住在 `order_shipping`——**擦除就是删掉那一行**，
 * 所以"擦干净了"的新真相是姓名读回 NULL，而不是旧形状里的空串。
 */
async function insertOrder({ status = 'escrowed', refundStatus = 'none', paid = false, shippingName = '' } = {}) {
  seq += 1;
  return await insertOrderRow(db, {
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    status,
    productSlug: 'p-ev',
    amountWei: '1000',
    usdtMicro: 1000000,
    btyUsdtRate: '0.1',
    escrowOrderId: `0x${String(seq).padStart(64, '0')}`,
    paidTxHash: paid ? `0x${String(seq).padStart(64, 'f')}` : null,
    refundStatus,
    shippingName,
  });
}

/** 造一条已有的陈述行（角色 buyer / 阶段 refund_request），供附件上传走到门控 */
async function insertEvidence(orderId, { role = 'buyer', phase = 'refund_request', content = '既有陈述' } = {}) {
  const r = await db.run('INSERT INTO dispute_evidence (order_id, role, phase, content) VALUES (?, ?, ?, ?)', orderId, role, phase, content);
  return Number(r.insertId);
}

const rowOf = async (orderId) => await db.get('SELECT * FROM v_orders WHERE order_id = ?', orderId);
const evidenceCount = async (id) => (await db.get('SELECT COUNT(*) AS c FROM dispute_evidence WHERE order_id = ?', id)).c;

const postEvidence = (orderId, body, token = buyerToken) =>
  request(app).post(`/api/orders/${orderId}/evidence`).set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value).send(body);

const pngB64 = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8, 1)]).toString('base64');
const uploadFile = (orderId, evidenceId, token = buyerToken) =>
  request(app)
    .post(`/api/orders/${orderId}/evidence/${evidenceId}/files`)
    .set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value)
    .send({ files: [{ name: 'proof.png', mime: 'image/png', dataB64: pngB64() }] });

const cancelOrder = (orderId, token = buyerToken) =>
  request(app).post(`/api/orders/${orderId}/cancel`).set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value).send({});
const erasePii = (orderId) =>
  request(app).post(`/api/shop/orders/${orderId}/erase-pii`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send({});

test('cancelled 单（售后镜像残留在 requested）不再受理售后陈述与附件', async () => {
  // 这笔单正是缺陷场景：异常态被取消，但 refund_status 仍停在 requested
  const o = await insertOrder({ status: 'cancelled', refundStatus: 'requested', shippingName: '张三 13800000000' });
  const evId = await insertEvidence(o.orderId);
  assert.equal((await rowOf(o.orderId)).refund_status, 'requested', '前置：镜像残留 requested（旧实现据此放行）');

  const stmt = await postEvidence(o.orderNo, { phase: 'refund_request', content: '取消了我还要补充陈述' });
  assert.notEqual(stmt.body.code, 0, '陈述必须被拒');
  assert.match(stmt.body.message, /不接受新的售后陈述/);
  assert.match(stmt.body.message, /cancelled/, '拒绝原因要说明当前状态，可行动');

  const up = await uploadFile(o.orderNo, evId);
  assert.notEqual(up.body.code, 0, '附件上传必须被拒（它是个人数据的主要载体）');
  assert.match(up.body.message, /不接受新的售后陈述/);
  assert.equal(await evidenceCount(o.orderId), 1, '没有新增陈述行（写入侧真的被挡住了）');
  assert.equal((await db.get('SELECT COUNT(*) AS c FROM evidence_files WHERE order_id = ?', o.orderId)).c, 0, '没有落任何附件行');
});

test('/cancel 复位售后镜像：状态置 cancelled 的同时 refund_status → none', async () => {
  const o = await insertOrder({ status: 'escrowed', refundStatus: 'requested', paid: false });
  const res = await cancelOrder(o.orderNo);
  assertOk(res);
  const row = await rowOf(o.orderId);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.refund_status, 'none', '本地终局不留"退款申请待处理"的残影（与 watcher/sync 终局迁移同口径）');

  // 取消后再提交：被**状态门控**拒绝（而不是仅靠 refund_status 恰好已是 none——
  // 门控顺序决定了拒因，这条断言钉住"状态是第一道闸"）
  const stmt = await postEvidence(o.orderNo, { phase: 'refund_request', content: '取消后补理由' });
  assert.notEqual(stmt.body.code, 0);
  assert.match(stmt.body.message, /不接受新的售后陈述/);
});

test('擦除不 sticky：cancel → erase-pii → 仍然无法在这张单上落下新的个人信息', async () => {
  const o = await insertOrder({ status: 'escrowed', refundStatus: 'requested', paid: false, shippingName: '李四 13900000000' });
  const evId = await insertEvidence(o.orderId, { content: '原陈述：货不对版' });
  assert.equal((await cancelOrder(o.orderNo)).body.code, 0, '异常单可被取消');

  const erased = await erasePii(o.orderNo);
  assertOk(erased);
  assert.equal((await rowOf(o.orderId)).shipping_name, null, '擦除已生效（cancelled 在可擦集里）');
  assert.equal((await rowOf(o.orderId)).refund_status, 'none', '取消已复位镜像（配合状态门控，双保险）');

  // 关键断言：擦除之后，陈述与附件都进不来 —— 否则"已删除"的单上又会长出新的个人数据
  const stmt = await postEvidence(o.orderNo, { phase: 'refund_request', content: '擦完我再写一段 2000 字的个人信息' });
  assert.notEqual(stmt.body.code, 0);
  /*
    拒因现在是**擦除**那一句（2026-10-15 起擦除成了独立的一道门，见 evidenceStatusError）：
    它比"状态不接受陈述"更贴事实——即使这一单之后又被开案/回到受理集，
    "已按删除请求擦除"这条仍然成立，而"状态"那条会随状态变化而失效（判据挂错层的典型）。
  */
  assert.match(stmt.body.message, /已按删除请求擦除|不再受理新的售后陈述/);
  const up = await uploadFile(o.orderNo, evId);
  assert.notEqual(up.body.code, 0);
  assert.equal(await evidenceCount(o.orderId), 1, '陈述行数不变（只有那条已被墓碑化的历史)');
  assert.equal((await db.get('SELECT COUNT(*) AS c FROM evidence_files WHERE order_id = ?', o.orderId)).c, 0);
  assert.equal((await rowOf(o.orderId)).shipping_name, null, 'PII 仍然是空的（没有被新提交"喂"回来）');
});

test('已擦除的单即使有在途售后案件也不再收新陈述（否则"删了又收"，保留期还为该案让路）', async () => {
  /*
    2026-10-15 审计 D3 的现场：`isAfterSaleOpen(order)` 一成立，门就开着（终局单也受理售后陈述），
    而**手动擦除**并不看在途案件（只有保留期扫描排除它，见 afterSaleSql.js 的 AFTER_SALE_NOT_OPEN_SQL）。
    于是这条路径成立：终局单开案 → 店主执行删除请求 → 买家在窗口内继续提交陈述与附件
    ⇒ 刚删掉的个人信息被重新写回同一张单，而保留期扫描又为在途案件让路（跳过它）
    ⇒ 新写入的个人信息**可能长期留存**，删除请求形同虚设。
    判据落在唯一的阶段门（evidenceStatusError）：陈述与附件两个端点一起关门。
  */
  const o = await insertOrder({ status: 'confirmed', paid: true });
  await db.run("UPDATE order_chain SET after_sale_status = 'open', after_sale_opened_at = ? WHERE order_id = ?", new Date(), o.orderId);
  // 前置：案件在途 ⇒ 这条单本来**受理**售后陈述（这正是洞的形状）
  const before = await postEvidence(o.orderNo, { phase: 'after_sale', content: '开案时的陈述' });
  assert.equal(before.body.code, 0, '前置：在途售后案件受理陈述');
  const evId = Number(before.body.data.evidenceId);

  assertOk(await erasePii(o.orderNo));
  assert.ok((await rowOf(o.orderId)).pii_erased_at, '擦除已生效（confirmed 在可擦集里）');

  const stmt = await postEvidence(o.orderNo, { phase: 'after_sale', content: '擦完以后再写一段个人信息' });
  assert.notEqual(stmt.body.code, 0, '擦除之后不许再落下新的个人信息');
  assert.match(stmt.body.message, /已按删除请求擦除/);
  const up = await uploadFile(o.orderNo, evId);
  assert.notEqual(up.body.code, 0, '附件端点同门控（同一个 evidenceStatusError）');
  assert.equal((await rowOf(o.orderId)).after_sale_status, 'open', '案件本身不动（擦除不改案件状态，仍由仲裁台处理）');
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
    const o = await insertOrder({ status: c.status, refundStatus: c.refundStatus });
    const evId = await insertEvidence(o.orderId, { role: c.role, phase: c.phase });
    const token = c.role === 'seller' ? ownerToken : buyerToken;
    const before = await evidenceCount(o.orderId); // 前置证据行（附件端点必须有一条既有陈述才能走到阶段门控）

    const stmt = await postEvidence(o.orderNo, { phase: c.phase, content: '试探门控' }, token);
    assert.notEqual(stmt.body.code, 0, `[${c.why}] 陈述端点必须拒绝`);
    const up = await uploadFile(o.orderNo, evId, token);
    assert.notEqual(up.body.code, 0, `[${c.why}] 附件端点必须拒绝`);
    assert.equal(
      up.body.message,
      stmt.body.message + '（附件同证据阶段门控）',
      `[${c.why}] 附件端点的拒因必须**逐字**来自陈述端点那一份（漂移即变红）：${stmt.body.message}`
    );
    assert.equal(await evidenceCount(o.orderId), before, `[${c.why}] 被拒的陈述没有落库`);
    assert.equal(
      (await db.get('SELECT COUNT(*) AS c FROM evidence_files WHERE order_id = ?', o.orderId)).c,
      0,
      `[${c.why}] 被拒的附件没有落盘`
    );
  }
});

test('阶段门控的身份分支返回 403（业务码与 HTTP 都是 403），不与"阶段不对"混为一谈', async () => {
  const o = await insertOrder({ status: 'escrowed', refundStatus: 'requested' });
  // 店主去提交"退款理由"（那是买家的阶段）
  const asSeller = await postEvidence(o.orderNo, { phase: 'refund_request', content: '我自己回复自己' }, ownerToken);
  assert.equal(asSeller.body.code, 403, '身份不符是 403，不是普通业务拒绝');
  assert.match(asSeller.body.message, /仅买家可提交/);
  assert.equal(await evidenceCount(o.orderId), 0);
  // 买家去提交"退款回复"（那是店主的阶段）
  const asBuyer = await postEvidence(o.orderNo, { phase: 'refund_reply', content: '我自己回复自己' });
  assert.equal(asBuyer.body.code, 403);
  assert.match(asBuyer.body.message, /仅店主可提交/);
  assert.equal(await evidenceCount(o.orderId), 0);
  // 同一个 endpoint 上，同样的身份若换成自己那一侧，就能提交（证明上面的 403 来自身份而不是别的门）
  assertOk(await postEvidence(o.orderNo, { phase: 'refund_request', content: '这次是对的阶段' }));
  assert.equal(await evidenceCount(o.orderId), 1);
});

test('详情陈述行有展示上限：历史脏数据（>100 条）被截断但总数照报（读取侧的 N+1 防护）', async () => {
  const o = await insertOrder({ status: 'disputed' });
  /*
    绕过写入侧的条数上限，直接批量塞 130 条（模拟"老版本无上限时期"的历史数据）。
    门面只有 get/all/run，没有 statement 复用这种形状；130 次单行 INSERT 包在**一个事务**里，
    与旧的"prepare 一次跑 130 次"落库结果逐字一致（旧的 BEGIN/COMMIT 也是这个作用域）。
  */
  await withTransaction(async () => {
    for (let i = 0; i < 130; i++) {
      await db.run('INSERT INTO dispute_evidence (order_id, role, phase, content, created_at) VALUES (?, ?, ?, ?, ?)', o.orderId, i % 2 === 0 ? 'buyer' : 'seller', 'arbitration', `历史陈述 ${i + 1}`, new Date(Date.now() + i));
    }
  });

  const detail = await request(app).get(`/api/orders/${o.orderNo}`).set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(detail);
  const ev = detail.body.data.evidence;
  assert.equal(detail.body.data.evidenceCount, 130, '总数如实上报');
  assert.equal(ev.length, 100, '一次最多返回 100 条（详情对每行都要拼附件元数据，行数必须封顶）');
  assert.equal(detail.body.data.evidenceTruncated, true, '被截断要显式标注（前端提示"仅展示最近 N 条"）');
  assert.equal(ev[ev.length - 1].content, '历史陈述 130', '取的是**最近**的 100 条，且按时间线升序返回');
  assert.equal(ev[0].content, '历史陈述 31');
});

test('陈述条数上限：仲裁阶段每角色 20 条，超出拒绝；对方额度互不影响', async () => {
  const o = await insertOrder({ status: 'disputed', refundStatus: 'requested' });
  // 买家把额度用满
  for (let i = 0; i < ARB_CAP; i++) {
    const r = await postEvidence(o.orderNo, { phase: 'arbitration', content: `买家陈述 ${i + 1}` });
    assertOk(r);
  }
  const over = await postEvidence(o.orderNo, { phase: 'arbitration', content: '第 21 条' });
  assert.notEqual(over.body.code, 0, '超过上限必须拒绝');
  assert.match(over.body.message, /上限/);
  assert.match(over.body.message, new RegExp(String(ARB_CAP)));
  assert.equal(await evidenceCount(o.orderId), ARB_CAP, '超限的那条没有落库');

  // 店主不受买家额度影响（额度按 (单, 角色, 阶段) 计）
  const seller = await postEvidence(o.orderNo, { phase: 'arbitration', content: '卖家陈述：不同意仅退款' }, ownerToken);
  assertOk(seller);
  assert.equal(await evidenceCount(o.orderId), ARB_CAP + 1);
  // 买家仍受自己额度约束
  assert.notEqual((await postEvidence(o.orderNo, { phase: 'arbitration', content: '再补一条' })).body.code, 0);

  // 详情读取侧：陈述行按时间线升序返回，并给出总条数（展示上限见 EVIDENCE_DETAIL_LIMIT）
  const detail = await request(app).get(`/api/orders/${o.orderNo}`).set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(detail);
  assert.equal(detail.body.data.evidenceCount, ARB_CAP + 1, '详情给出陈述总条数');
  assert.equal(detail.body.data.evidenceTruncated, false, `未超过展示上限 ${ARB_CAP + 1} 条`);
  assert.equal(detail.body.data.evidence.length, ARB_CAP + 1);
  assert.equal(detail.body.data.evidence[ARB_CAP].role, 'seller', '按 id 升序 = 时间线顺序');
  assert.deepEqual(detail.body.data.evidence[0].files, [], '无附件的陈述给空数组（批量查询口径）');

  // 附件随陈述上传后，详情用批量查询取回元数据（不是逐行 filesOfEvidence 的 N+1）
  const evId = detail.body.data.evidence[0].id;
  assertOk(await uploadFile(o.orderNo, evId));
  const detail2 = await request(app).get(`/api/orders/${o.orderNo}`).set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  const first = detail2.body.data.evidence.find((e) => e.id === evId);
  assert.equal(first.files.length, 1);
  assert.equal(first.files[0].name, 'proof.png');
  assert.deepEqual(
    detail2.body.data.evidence.find((e) => e.id !== evId).files,
    [],
    '没有附件的陈述不受批量查询影响（空数组）'
  );
});
