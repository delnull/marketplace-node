/**
 * 证据附件（P0-2）：上传白名单 + 魔数嗅探 + 配额；鉴权下载矩阵；evidence 时间线 files 元数据。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef, orderIdOf } from './setup.mjs';

// 附件目录（独立临时目录，结束清理）；仲裁人地址（下载矩阵 disputed 场景）
process.env.MK_ATTACH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-att-'));
const arbiter = Wallet.createRandom();
// 2026-10-18：仲裁人不再是单个环境变量，改为链上当前届名单（测试注入取值）

const ctx = await makeCtx();

// 2026-10-18：仲裁人 = 链上当前届名单（注入取值，避免起假 RPC）
const { setCommitteeReader } = await import('../src/chain.js');
setCommitteeReader(async () => ({ arbiters: [arbiter.address.toLowerCase()], threshold: 1, epoch: 1 }));
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();

let ownerToken;
let buyerToken;
let strangerToken;
let arbiterToken;
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');
const { applyEvent } = await import('../src/escrowWatcher.js');
// 目录键的形状守卫（item 3）：非正整数的 orderId 必须抛错，不得退化成附件根目录
const { orderAttachDir, removeOrderAttachments } = await import('../src/evidenceFiles.js');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  strangerToken = (await login(ctx, stranger)).token;
  arbiterToken = (await login(ctx, arbiter)).token;
});

/** 最小合法 PNG 体（真实魔数 + 填充） */
const pngBytes = (fill = 1, extra = 8) =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(extra, fill)]);
const b64 = (buf) => buf.toString('base64');

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

async function escrowed(order) {
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), order.id);
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', payHash(), order.id);
}

async function submitEvidence(orderId, body, token) {
  const req = request(app).post(`/api/orders/${orderId}/evidence`);
  if (token) req.set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value);
  return req.send(body);
}

const latestEvidenceId = async (orderId) =>
  (await db.get('SELECT id FROM dispute_evidence WHERE order_id = ? ORDER BY id DESC LIMIT 1', await orderIdOf(db, orderId))).id;

test('附件目录键的形状：非正整数一律抛错（"附件根目录"不可被表达成一个订单目录）', () => {
  /*
    旧实现是 `String(orderId || '')`：空/0/undefined 都会算成附件**根目录**，而
    `removeOrderAttachments` 对它执行 `rmSync(recursive)`。当前唯一调用点传的是自增主键
    （不可达），但形状本身是错的——这条用例把"根目录"从订单目录的类型里删掉：
    非正整数不是"某个订单的目录"，只能抛错。
  */
  for (const bad of [0, -1, -7, 1.5, '', '   ', undefined, null, NaN, 'abc', true]) {
    assert.throws(() => orderAttachDir(bad), TypeError, `orderId=${String(bad)} 必须抛 TypeError`);
  }
  assert.equal(orderAttachDir(7), path.join(process.env.MK_ATTACH_DIR, '7'));
  // BIGINT 超出安全整数时驱动会给字符串（见 db.js 的 supportBigNumbers）：数字字符串照收
  assert.equal(orderAttachDir('7'), path.join(process.env.MK_ATTACH_DIR, '7'));
  // 删除入口共用同一判据：0 不会退化成"删附件根目录"
  assert.throws(() => removeOrderAttachments(0), TypeError);
});

async function uploadFiles(orderId, evidenceId, files, token) {
  const req = request(app).post(`/api/orders/${orderId}/evidence/${evidenceId}/files`);
  if (token) req.set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value);
  return req.send({ files });
}

test('买家上传 PNG 附件成功：sha256/时间线 files 元数据/本人可下载', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件商品A' }));
  const order = await createDraft(p.slug);
  await escrowed(order);
  assert.equal(await applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'refund_request', content: '开箱照片如下' }, buyerToken);
  const evId = await latestEvidenceId(order.id);

  const up = await uploadFiles(
    order.id,
    evId,
    [{ name: 'open-box.png', mime: 'image/png', dataB64: b64(pngBytes()) }],
    buyerToken
  );
  assertOk(up);
  assert.equal(up.body.data.uploaded.length, 1);
  assert.equal(up.body.data.uploaded[0].mime, 'image/png');
  assert.match(up.body.data.uploaded[0].sha256, /^[0-9a-f]{64}$/);

  // 时间线 files 元数据
  const detail = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  const ev = detail.body.data.evidence.find((e) => e.id === evId);
  assert.equal(ev.files.length, 1);
  assert.equal(ev.files[0].name, 'open-box.png');

  // 本人可下载（图片 inline）
  const dl = await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/${ev.files[0].id}`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.match(dl.headers['content-type'] || '', /image\/png/);

  // 店主可下载；匿名/第三人拒（统一 404，与"不存在"同形，见下面的专门用例）
  await request(app).get(`/api/orders/${order.id}/evidence/${evId}/files/${ev.files[0].id}`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  await request(app).get(`/api/orders/${order.id}/evidence/${evId}/files/${ev.files[0].id}`).expect(404);
  await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/${ev.files[0].id}`)
    .set('Authorization', `Bearer ${strangerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(404);
});

test('白名单与魔数校验：html/svg/伪装拒绝；越权与终局门控', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件边界商品' }));
  const order = await createDraft(p.slug);
  await escrowed(order);
  assert.equal(await applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'refund_request', content: '边界' }, buyerToken);
  const evId = await latestEvidenceId(order.id);

  // html 拒绝
  let r = await uploadFiles(order.id, evId, [{ name: 'a.html', mime: 'text/html', dataB64: b64(Buffer.from('<script>')) }], buyerToken);
  assert.notEqual(r.body.code, 0);
  // svg（mime image/svg+xml）拒绝
  r = await uploadFiles(order.id, evId, [{ name: 'a.svg', mime: 'image/svg+xml', dataB64: b64(Buffer.from('<svg/>')) }], buyerToken);
  assert.notEqual(r.body.code, 0);
  // 声明 png 但内容为 PDF 头 → 魔数拒绝
  r = await uploadFiles(order.id, evId, [{ name: 'fake.png', mime: 'image/png', dataB64: b64(Buffer.from('%PDF-1.7 fake')) }], buyerToken);
  assert.notEqual(r.body.code, 0);
  assert.match(r.body.message || '', /魔数/);
  // base64 大小超 2MB
  const big = pngBytes(1, 2 * 1024 * 1024 + 100);
  r = await uploadFiles(order.id, evId, [{ name: 'big.png', mime: 'image/png', dataB64: b64(big) }], buyerToken);
  assert.notEqual(r.body.code, 0);
  assert.match(r.body.message || '', /2MB/);

  // 越权：店主不可向买家 refund_request 证据补附件
  r = await uploadFiles(order.id, evId, [{ name: 'x.png', mime: 'image/png', dataB64: b64(pngBytes()) }], ownerToken);
  assert.notEqual(r.body.code, 0);
  // 陌生人 403
  await uploadFiles(order.id, evId, [{ name: 'x.png', mime: 'image/png', dataB64: b64(pngBytes()) }], strangerToken).then((x) => {
    assert.equal(x.status, 403);
  });
  // 终局（confirm）后不可再补附件（refund_request 阶段要求 refund_status=requested）
  assert.equal(await applyEvent('RefundRejected', { orderId: order.escrowOrderId }), 1);
  r = await uploadFiles(order.id, evId, [{ name: 'late.png', mime: 'image/png', dataB64: b64(pngBytes()) }], buyerToken);
  assert.notEqual(r.body.code, 0);
  assert.match(r.body.message || '', /门控/);
});

test('仲裁阶段附件：仲裁人（disputed 单）可下载；争议外不可见', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件仲裁商品' }));
  const order = await createDraft(p.slug);
  await escrowed(order);
  assert.equal(await applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  assert.equal(await applyEvent('RefundRejected', { orderId: order.escrowOrderId }), 1);
  assert.equal(await applyEvent('DisputeRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'arbitration', content: '证据图片' }, buyerToken);
  const evId = await latestEvidenceId(order.id);
  await uploadFiles(order.id, evId, [{ name: 'proof.jpg', mime: 'image/jpeg', dataB64: b64(Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(16)])) }], buyerToken);
  const fileId = (await db.get('SELECT id FROM evidence_files WHERE evidence_id = ?', evId)).id;

  // 仲裁人视角可下载（disputed 单）
  await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/${fileId}`)
    .set('Authorization', `Bearer ${arbiterToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  // 陌生人仍拒（统一 404，不确认"某单+某证据+某附件存在"）
  await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/${fileId}`)
    .set('Authorization', `Bearer ${strangerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(404);
});

test('换届后：旧届成员仍能读该单详情/附件；新届非该单成员不能（订单级届次快照）', async () => {
  /*
    2026-10-18：裁决资格从"当前届"改为"**该单落定届**"（争议发起时快照）。
    旧实现拿当前届给所有单判资格，换届后旧成员打不开正在处理的争议（详情证据/附件全断），
    而新成员能读到自己根本裁不了的单。这里用注入 reader 的 `orderId` 参数模拟两届同时存在。
  */
  const oldArbiter = Wallet.createRandom();
  const newArbiter = Wallet.createRandom();
  const oldToken = (await login(ctx, oldArbiter)).token;
  const newToken = (await login(ctx, newArbiter)).token;

  const p = await listProduct(productPayload({ kind: 'physical', title: '换届仲裁商品' }));
  const order = await createDraft(p.slug);
  await escrowed(order);
  assert.equal(await applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  assert.equal(await applyEvent('RefundRejected', { orderId: order.escrowOrderId }), 1);
  assert.equal(await applyEvent('DisputeRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'arbitration', content: '换届前的证据' }, buyerToken);
  const evId = await latestEvidenceId(order.id);
  await uploadFiles(order.id, evId, [{ name: 'old-arb.png', mime: 'image/png', dataB64: b64(pngBytes()) }], buyerToken);
  const fileId = (await db.get('SELECT id FROM evidence_files WHERE evidence_id = ?', evId)).id;

  const historical = String(order.escrowOrderId).toLowerCase();
  setCommitteeReader(async (orderId) =>
    orderId === historical
      ? { arbiters: [oldArbiter.address.toLowerCase()], threshold: 1, epoch: 1 }
      : { arbiters: [newArbiter.address.toLowerCase()], threshold: 1, epoch: 2 }
  );
  try {
    // 旧届成员：详情里能看到陈述/附件元数据，附件可下载
    const oldDetail = await request(app)
      .get(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${oldToken}`).set('X-Mk-Shop', shopRef.value)
      .expect(200);
    assertOk(oldDetail);
    assert.ok(oldDetail.body.data.evidence?.some((e) => e.id === evId), '旧届成员必须仍能读这一单的陈述');
    await request(app)
      .get(`/api/orders/${order.id}/evidence/${evId}/files/${fileId}`)
      .set('Authorization', `Bearer ${oldToken}`).set('X-Mk-Shop', shopRef.value)
      .expect(200);

    // 新届非该单成员：详情不开放证据，附件统一 404
    const newDetail = await request(app)
      .get(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${newToken}`).set('X-Mk-Shop', shopRef.value)
      .expect(200);
    assertOk(newDetail);
    assert.equal(newDetail.body.data.evidence, undefined, '新届非该单成员拿不到陈述');
    await request(app)
      .get(`/api/orders/${order.id}/evidence/${evId}/files/${fileId}`)
      .set('Authorization', `Bearer ${newToken}`).set('X-Mk-Shop', shopRef.value)
      .expect(404);

    // 仲裁列表的 orderNo 也按**每单**判：旧届拿得到，新届拿不到
    const listOld = await request(app).get('/api/arbitration/pending?pageSize=100').set('Authorization', `Bearer ${oldToken}`).expect(200);
    const rowOld = listOld.body.data.disputes.find((r) => String(r.escrowOrderId).toLowerCase() === historical);
    assert.ok(rowOld, '前置：这一单在待仲裁队列里');
    assert.equal(rowOld.orderNo, order.id, '旧届成员应拿到这一单的本地句柄');
    const listNew = await request(app).get('/api/arbitration/pending?pageSize=100').set('Authorization', `Bearer ${newToken}`).expect(200);
    const rowNew = listNew.body.data.disputes.find((r) => String(r.escrowOrderId).toLowerCase() === historical);
    assert.equal(rowNew.orderNo, null, '新届非该单成员的令牌不是这一单的句柄凭证');
  } finally {
    // 恢复本文件其余用例的当前届注入
    setCommitteeReader(async () => ({ arbiters: [arbiter.address.toLowerCase()], threshold: 1, epoch: 1 }));
  }
});

test('配额：单条 ≤6 个、订单累计 ≤20MB', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件配额商品' }));
  const order = await createDraft(p.slug);
  await escrowed(order);
  assert.equal(await applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'refund_request', content: '配额' }, buyerToken);
  const evId = await latestEvidenceId(order.id);

  // 单请求 7 个：必须在写盘前按条数拒绝（不能先写 7 个再回滚）
  const seven = Array.from({ length: 7 }, (_, i) => ({ name: `bad${i}.png`, mime: 'image/png', dataB64: b64(pngBytes(i + 1, 64)) }));
  let tooMany = await uploadFiles(order.id, evId, seven, buyerToken);
  assert.notEqual(tooMany.body.code, 0);
  assert.match(tooMany.body.message || '', /6 个附件/);

  const six = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.png`, mime: 'image/png', dataB64: b64(pngBytes(i + 1, 64)) }));
  assertOk(await uploadFiles(order.id, evId, six, buyerToken));
  // 第 7 个（同一 evidence）→ 条数上限
  let r = await uploadFiles(order.id, evId, [{ name: 'f7.png', mime: 'image/png', dataB64: b64(pngBytes(7, 64)) }], buyerToken);
  assert.notEqual(r.body.code, 0);
  assert.match(r.body.message || '', /6/);

  // 订单累计 20MB（每文件恰 2MB）：e1 小文件 ~0.9KB；e2 传 6 个 = 12MB →
  // e3 前 3 个达 ~18.9MB、第 4 个触发累计上限（含 e1 的 864B 余量后恰超）
  const twoMb = () => ({ name: 'big.png', mime: 'image/png', dataB64: b64(pngBytes(2, 2 * 1024 * 1024 - 8)) });
  await submitEvidence(order.id, { phase: 'refund_request', content: '配额2' }, buyerToken);
  const ev2 = await latestEvidenceId(order.id);
  for (let i = 0; i < 6; i++) {
    assertOk(await uploadFiles(order.id, ev2, [twoMb()], buyerToken), `e2 第 ${i + 1} 个应成功`);
  }
  await submitEvidence(order.id, { phase: 'refund_request', content: '配额3' }, buyerToken);
  const ev3 = await latestEvidenceId(order.id);
  for (let i = 0; i < 3; i++) {
    assertOk(await uploadFiles(order.id, ev3, [twoMb()], buyerToken), `e3 第 ${i + 1} 个（累计 ≤20MB）应成功`);
  }
  r = await uploadFiles(order.id, ev3, [twoMb()], buyerToken);
  assert.notEqual(r.body.code, 0);
  assert.match(r.body.message || '', /20MB/);
});

test('多文件整批原子性：任一文件魔数失败 → 整批不落库（无部分成功残留）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件原子性商品' }));
  const order = await createDraft(p.slug);
  await escrowed(order);
  assert.equal(await applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'refund_request', content: '原子' }, buyerToken);
  const evId = await latestEvidenceId(order.id);

  const before = (await db.get('SELECT COUNT(*) AS c FROM evidence_files WHERE order_id = ?', await orderIdOf(db, order.id))).c;
  const bad = await uploadFiles(
    order.id,
    evId,
    [
      { name: 'ok.png', mime: 'image/png', dataB64: b64(pngBytes()) },
      { name: 'fake.png', mime: 'image/png', dataB64: b64(Buffer.from('%PDF-1.7 fake')) },
    ],
    buyerToken
  );
  assert.notEqual(bad.body.code, 0, '整批含伪造文件应整体拒绝');
  const after = (await db.get('SELECT COUNT(*) AS c FROM evidence_files WHERE order_id = ?', await orderIdOf(db, order.id))).c;
  assert.equal(after, before, '失败批次不产生任何文件记录');
});

test('storeFiles 拒绝错配的 order/evidence 组合（归属是数据形状，不是调用方的纪律）', async () => {
  /*
    旧签名 {orderId, evidenceId} 允许把 A 单的附件写进 B 单的陈述（两个 id 各自合法、组合非法）。
    现在 evidence 行整行传入，`evidence.order_id === orderId` 在入口处断言——错配不产生任何
    文件行/磁盘文件（先断言、后写盘）。
  */
  const mk = async (title) => {
    const p = await listProduct(productPayload({ kind: 'physical', title }));
    const order = await createDraft(p.slug);
    await escrowed(order);
    assert.equal(await applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
    await submitEvidence(order.id, { phase: 'refund_request', content: title }, buyerToken);
    const evidenceId = await latestEvidenceId(order.id);
    const internal = await orderIdOf(db, order.id);
    return { order, evidence: await db.get('SELECT * FROM dispute_evidence WHERE id = ?', evidenceId), internal };
  };
  const a = await mk('归属A');
  const b = await mk('归属B');
  const { storeFiles } = await import('../src/evidenceFiles.js');
  const files = [{ name: 'x.png', mime: 'image/png', dataB64: b64(pngBytes()) }];

  // A 单 + B 单的证据行 ⇒ 拒绝
  await assert.rejects(
    () => storeFiles({ orderId: a.internal, evidence: b.evidence, files }),
    /不属于该订单/
  );
  // 只给证据 id（没有 order_id 的旧形状）同样拒绝——不存在"只凭 id 就信"的分支
  await assert.rejects(() => storeFiles({ orderId: a.internal, evidence: { id: a.evidence.id }, files }), /不属于该订单/);

  const count = Number(
    (await db.get('SELECT COUNT(*) AS c FROM evidence_files WHERE evidence_id IN (?, ?)', a.evidence.id, b.evidence.id)).c
  );
  assert.equal(count, 0, '被拒绝的组合不得落任何文件行');

  // 控制组：正确归属可以写入（本文件其它用例已覆盖路由路径，这里确认新签名可用）
  const created = await storeFiles({ orderId: a.internal, evidence: a.evidence, files });
  assert.equal(created.length, 1);
});

/**
 * **P2-2：陈述条数上限必须串行化到订单行**。
 *
 * 旧实现把「COUNT → 判上限 → INSERT」放进一个事务，但那只是**快照读**：REPEATABLE READ 下
 * N 个并发提交各读各的旧计数，都能通过（单方一次刷出任意多条陈述）。现在事务先
 * `SELECT id FROM orders … FOR UPDATE`，同一单的提交排队，后到者一定看得到先到者已提交的行。
 * 这里一次发 20 条并发提交，上限 10：必须恰好 10 条成功，其余被"上限"拒绝。
 */
test('并发提交陈述：同一单的上限不会被同时穿过（10 条上限 + 20 并发 ⇒ 恰好 10 条落库）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '并发陈述上限商品' }));
  const order = await createDraft(p.slug);
  await escrowed(order);
  assert.equal(await applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);

  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      submitEvidence(order.id, { phase: 'refund_request', content: `并发陈述 ${i}` }, buyerToken)
    )
  );
  const okCount = responses.filter((r) => r.body?.code === 0).length;
  const rejected = responses.filter((r) => r.body?.code !== 0);
  assert.equal(okCount, 10, `上限 10，20 并发只能成功 10（实际 ${okCount}）`);
  assert.ok(
    rejected.every((r) => /上限|补充内容/.test(String(r.body?.message || ''))),
    `被拒的必须是"已到上限"而不是别的错误：${JSON.stringify(rejected.map((r) => r.body?.message))}`
  );

  const internal = await orderIdOf(db, order.id);
  const count = Number(
    (await db.get("SELECT COUNT(*) AS c FROM dispute_evidence WHERE order_id = ? AND role = 'buyer' AND phase = 'refund_request'", internal)).c
  );
  assert.equal(count, 10, '库里恰好 10 条（没有一次并发把上限穿过去）');
});

test('非数字/非法 fileId 返回 404 而非 500', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件404商品' }));
  const order = await createDraft(p.slug);
  await escrowed(order);
  assert.equal(await applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'refund_request', content: '404' }, buyerToken);
  const evId = await latestEvidenceId(order.id);
  await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/not-a-number`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(404);
  await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/999999`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(404);
});

test('下载 404 不区分"不存在"与"无权"：两者响应逐字相同；有权者仍能看到可读原因', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件统一404商品' }));
  const order = await createDraft(p.slug);
  await escrowed(order);
  assert.equal(await applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'refund_request', content: '统一404' }, buyerToken);
  const evId = await latestEvidenceId(order.id);
  assertOk(await uploadFiles(order.id, evId, [{ name: 'x.png', mime: 'image/png', dataB64: b64(pngBytes()) }], buyerToken));
  const fileRow = await db.get('SELECT * FROM evidence_files WHERE evidence_id = ?', evId);
  const url = `/api/orders/${order.id}/evidence/${evId}/files/${fileRow.id}`;

  /*
    旧形状：匿名 403、第三人 403、不存在 404 ⇒ 403 本身就是"某单 + 某证据 + 某附件存在"
    的确认器。现在全部 404，且响应体与"真的不存在"逐字相同（差异只在服务端日志里）。
  */
  const deniedAnon = await request(app).get(url).expect(404);
  const deniedStranger = await request(app)
    .get(url)
    .set('Authorization', `Bearer ${strangerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(404);
  const ghostFile = await request(app).get(`/api/orders/${order.id}/evidence/${evId}/files/999999`).expect(404);
  const ghostOrder = await request(app).get(`/api/orders/NO-SUCH-ORDER/evidence/${evId}/files/${fileRow.id}`).expect(404);
  for (const [name, r] of Object.entries({ deniedAnon, deniedStranger, ghostFile, ghostOrder })) {
    assert.deepEqual(
      r.body,
      deniedAnon.body,
      `${name} 的响应必须与"确实不存在"逐字相同（status=${r.status}, message=${r.body.message}）`
    );
  }

  /*
    有权者不受这条收口影响：权限检查在磁盘检查**之前**，所以"文件被清理了"这种
    **他有权知道**的失败仍带可读原因（而不是被折叠成匿名用的通用 404 文案）。
  */
  const internalId = await orderIdOf(db, order.id);
  fs.rmSync(path.join(orderAttachDir(internalId), fileRow.stored_name));
  const buyerMissing = await request(app)
    .get(url)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(404);
  assert.match(buyerMissing.body.message, /附件文件缺失（存储可能被清理）/);
  assert.notEqual(buyerMissing.body.message, deniedAnon.body.message, '有权者的可读原因不是匿名那份通用 404 文案');
});
