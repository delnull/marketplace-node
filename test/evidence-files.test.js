/**
 * 证据附件（P0-2）：上传白名单 + 魔数嗅探 + 配额；鉴权下载矩阵；evidence 时间线 files 元数据。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

// 附件目录（独立临时目录，结束清理）；仲裁人地址（下载矩阵 disputed 场景）
process.env.MK_ATTACH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-att-'));
const arbiter = Wallet.createRandom();
process.env.MK_ARBITER_ADDRESS = arbiter.address;

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const stranger = Wallet.createRandom();

let ownerToken;
let buyerToken;
let strangerToken;
let arbiterToken;
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');
const { applyEvent } = await import('../src/escrowWatcher.js');

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
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slug })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

function escrowed(order) {
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), order.id);
}

async function submitEvidence(orderId, body, token) {
  const req = request(app).post(`/api/orders/${orderId}/evidence`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
}

const latestEvidenceId = (orderId) =>
  db.prepare('SELECT id FROM dispute_evidence WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(orderId).id;

async function uploadFiles(orderId, evidenceId, files, token) {
  const req = request(app).post(`/api/orders/${orderId}/evidence/${evidenceId}/files`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({ files });
}

test('买家上传 PNG 附件成功：sha256/时间线 files 元数据/本人可下载', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件商品A' }));
  const order = await createDraft(p.slug);
  escrowed(order);
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'refund_request', content: '开箱照片如下' }, buyerToken);
  const evId = latestEvidenceId(order.id);

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
  const detail = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${buyerToken}`).expect(200);
  const ev = detail.body.data.evidence.find((e) => e.id === evId);
  assert.equal(ev.files.length, 1);
  assert.equal(ev.files[0].name, 'open-box.png');

  // 本人可下载（图片 inline）
  const dl = await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/${ev.files[0].id}`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(200);
  assert.match(dl.headers['content-type'] || '', /image\/png/);

  // 店主可下载；匿名/第三人拒
  await request(app).get(`/api/orders/${order.id}/evidence/${evId}/files/${ev.files[0].id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
  await request(app).get(`/api/orders/${order.id}/evidence/${evId}/files/${ev.files[0].id}`).expect(403);
  await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/${ev.files[0].id}`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .expect(403);
});

test('白名单与魔数校验：html/svg/伪装拒绝；越权与终局门控', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件边界商品' }));
  const order = await createDraft(p.slug);
  escrowed(order);
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'refund_request', content: '边界' }, buyerToken);
  const evId = latestEvidenceId(order.id);

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
  assert.equal(applyEvent('RefundRejected', { orderId: order.escrowOrderId }), 1);
  r = await uploadFiles(order.id, evId, [{ name: 'late.png', mime: 'image/png', dataB64: b64(pngBytes()) }], buyerToken);
  assert.notEqual(r.body.code, 0);
  assert.match(r.body.message || '', /门控/);
});

test('仲裁阶段附件：仲裁人（disputed 单）可下载；争议外不可见', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件仲裁商品' }));
  const order = await createDraft(p.slug);
  escrowed(order);
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  assert.equal(applyEvent('RefundRejected', { orderId: order.escrowOrderId }), 1);
  assert.equal(applyEvent('DisputeRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'arbitration', content: '证据图片' }, buyerToken);
  const evId = latestEvidenceId(order.id);
  await uploadFiles(order.id, evId, [{ name: 'proof.jpg', mime: 'image/jpeg', dataB64: b64(Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(16)])) }], buyerToken);
  const fileId = db.prepare('SELECT id FROM evidence_files WHERE evidence_id = ?').get(evId).id;

  // 仲裁人视角可下载（disputed 单）
  await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/${fileId}`)
    .set('Authorization', `Bearer ${arbiterToken}`)
    .expect(200);
  // 陌生人仍拒
  await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/${fileId}`)
    .set('Authorization', `Bearer ${strangerToken}`)
    .expect(403);
});

test('配额：单条 ≤6 个、订单累计 ≤20MB', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件配额商品' }));
  const order = await createDraft(p.slug);
  escrowed(order);
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'refund_request', content: '配额' }, buyerToken);
  const evId = latestEvidenceId(order.id);

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
  const ev2 = latestEvidenceId(order.id);
  for (let i = 0; i < 6; i++) {
    assertOk(await uploadFiles(order.id, ev2, [twoMb()], buyerToken), `e2 第 ${i + 1} 个应成功`);
  }
  await submitEvidence(order.id, { phase: 'refund_request', content: '配额3' }, buyerToken);
  const ev3 = latestEvidenceId(order.id);
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
  escrowed(order);
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'refund_request', content: '原子' }, buyerToken);
  const evId = latestEvidenceId(order.id);

  const before = db.prepare('SELECT COUNT(*) AS c FROM evidence_files WHERE order_id = ?').get(order.id).c;
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
  const after = db.prepare('SELECT COUNT(*) AS c FROM evidence_files WHERE order_id = ?').get(order.id).c;
  assert.equal(after, before, '失败批次不产生任何文件记录');
});

test('非数字/非法 fileId 返回 404 而非 500', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '附件404商品' }));
  const order = await createDraft(p.slug);
  escrowed(order);
  assert.equal(applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  await submitEvidence(order.id, { phase: 'refund_request', content: '404' }, buyerToken);
  const evId = latestEvidenceId(order.id);
  await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/not-a-number`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(404);
  await request(app)
    .get(`/api/orders/${order.id}/evidence/${evId}/files/999999`)
    .set('Authorization', `Bearer ${buyerToken}`)
    .expect(404);
});
