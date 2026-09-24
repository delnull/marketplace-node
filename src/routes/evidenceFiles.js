/**
 * 证据附件路由（P0-2，挂 /api/orders 前缀）：
 *  POST /:id/evidence/:evidenceId/files   上传（base64 JSON；白名单+魔数+配额；与 evidence 同门控）
 *  GET  /:id/evidence/:evidenceId/files/:fileId  鉴权下载（图片 inline / PDF attachment）
 *
 * 全局 express.json 1MB 限制对该上传路径豁免（见 app.js isFilesUpload），本路由自带 18MB 解析。
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Router } from 'express';
import { getDb } from '../db.js';
import { verifyToken, roleOf, isStaff } from '../auth.js';
import { logAudit } from '../audit.js';
import { ok, fail, wrap, bearerToken, makeAuthMiddleware, simpleRateLimit, isProdLike } from '../http.js';
import { getArbiterAddress } from '../chain.js';
import {
  validateFileMeta,
  storeFiles,
  orderQuota,
  fileDiskPath,
  findFileById,
  evidencePhaseError,
  MAX_FILES_PER_EVIDENCE,
  MAX_BYTES_PER_ORDER,
} from '../evidenceFiles.js';

const router = Router();
const requireAuth = makeAuthMiddleware(verifyToken);
// 附件上传/下载按 IP 限流（上传先于 18MB body 解析：防未认证/认证后的大体积刷量；
// 下载防脚本化拖取——配额已按订单约束，此处挡单 IP 高频滥用）
const uploadLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: '附件上传过于频繁，请稍后再试' });
const downloadLimiter = simpleRateLimit({ windowMs: 60_000, max: 600, message: '附件下载过于频繁，请稍后再试' });

const findOrder = (id) => getDb().prepare('SELECT * FROM orders WHERE id = ?').get(String(id || ''));
const findEvidence = (id) => getDb().prepare('SELECT * FROM dispute_evidence WHERE id = ?').get(Number(id) || 0);

// 鉴权在 body 解析之前（requireAuth 401 时不触发 18MB JSON 解析——防未认证大体积 DoS）
router.post('/:id/evidence/:evidenceId/files', requireAuth, uploadLimiter, express.json({ limit: '18mb' }), wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const evidence = findEvidence(req.params.evidenceId);
  if (!evidence || evidence.order_id !== order.id) return fail(res, '证据记录不存在', 404, 404);
  // P1-⑤：卖家侧角色扩展为店主+操作员（operator 处理退款/争议需查看与回复）
  const role = req.auth.address === order.buyer ? 'buyer' : isStaff(req.auth.address) ? 'seller' : null;
  if (!role) return fail(res, '仅本单买家或店主/操作员可上传证据附件', 403, 403);
  if (role !== evidence.role) return fail(res, '只能向本人提交的证据条目追加附件', 403, 403);
  const gate = evidencePhaseError(order, evidence.phase, role);
  if (gate) return fail(res, gate.message + '（附件同证据阶段门控）', gate.code, gate.http);

  const raw = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!raw.length) return fail(res, 'files 需为非空数组 [{name, mime, dataB64}]');
  if (raw.length > MAX_FILES_PER_EVIDENCE) return fail(res, `单条陈述最多 ${MAX_FILES_PER_EVIDENCE} 个附件`);

  // 逐个预检（meta/大小/base64 长度）→ 配额（订单累计）→ 落盘（含魔数嗅探）
  const db = getDb();
  const exist = db.prepare('SELECT COUNT(*) AS c FROM evidence_files WHERE evidence_id = ?').get(evidence.id).c;
  if (exist + raw.length > MAX_FILES_PER_EVIDENCE) return fail(res, `单条陈述最多 ${MAX_FILES_PER_EVIDENCE} 个附件`);
  const quota = orderQuota(order.id);
  let totalBytes = quota.bytes;
  const prepared = [];
  for (const f of raw) {
    const b64 = String(f?.dataB64 || '');
    let size = 0;
    try {
      size = Buffer.byteLength(b64, 'base64');
    } catch {
      size = -1;
    }
    const meta = validateFileMeta({ name: f?.name, mime: f?.mime, size });
    if (!meta.ok) return fail(res, meta.error);
    totalBytes += size;
    if (totalBytes > MAX_BYTES_PER_ORDER) return fail(res, '该订单证据附件累计超过 20MB 上限');
    prepared.push({ name: f.name, mime: f.mime, dataB64: b64 });
  }
  try {
    const created = storeFiles({ orderId: order.id, evidenceId: evidence.id, files: prepared });
    logAudit({
      req,
      actor: req.auth?.address,
      actorRole: roleOf(req.auth?.address || ''),
      action: 'evidence.upload',
      targetType: 'evidence',
      targetId: String(evidence.id),
      detail: { orderId: order.id, files: created.length, bytes: created.reduce((a, f) => a + f.size, 0) },
    });
    ok(res, { uploaded: created }, '附件已上传（sha256 已登记，可在详情时间线查看）');
  } catch (e) {
    /*
      不要把 fs/db 的原始异常原文直接回给客户端（源码审计 2026-09 复审，P2）：`fs.writeFileSync`
      的 message 含**服务器绝对路径**（`ENOENT: no such file or directory, open '/srv/…/x.png'`），
      而且这里连服务端日志都没留——正是 http.js 要消灭的那种"用户看得见内部细节、运维却看不见"。
      校验类失败（`expose: true`，消息是我们自己写的）照常原样回：那是用户可自行修复的输入问题。
      其余：详情进服务端日志，响应按 `isProdLike()` 给通用文案（开发环境保留原文便于定位）。
    */
    console.error('[evidenceFiles] 附件保存失败:', e?.message || e);
    if (e?.expose) return fail(res, e.message);
    const detail = isProdLike() ? null : String(e?.message || '');
    fail(res, detail || '附件保存失败（服务器无法写入附件目录，请联系店铺运维）');
  }
}));

/** 鉴权下载：可见矩阵与 evidence 一致（buyer/owner；arbiter 仅 disputed）；文件归属该校验 */
router.get('/:id/evidence/:evidenceId/files/:fileId', downloadLimiter, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const evidence = findEvidence(req.params.evidenceId);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) return fail(res, '附件不存在', 404, 404);
  const file = findFileById(fileId);
  if (!evidence || evidence.order_id !== order.id || !file || file.evidence_id !== evidence.id) {
    return fail(res, '附件不存在', 404, 404);
  }
  const token = bearerToken(req);
  let auth = null;
  try {
    auth = token ? verifyToken(token) : null;
  } catch {
    auth = null;
  }
  let allowed = false;
  if (auth) {
    if (auth.address === order.buyer || isStaff(auth.address)) allowed = true;
    else if (order.status === 'disputed' && auth.address === (await getArbiterAddress())) allowed = true;
  }
  if (!allowed) return fail(res, '无权查看该附件（需买家本人/店主/操作员/争议仲裁人）', 403, 403);

  const disk = fileDiskPath(file);
  if (!disk) return fail(res, '附件文件缺失（存储可能被清理）', 404, 404);
  const isImage = file.mime.startsWith('image/');
  res.setHeader('Content-Type', file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 敏感证据内容：禁止任何缓存（含私有缓存）
  res.setHeader('Cache-Control', 'private, no-store');
  // RFC 6266：ASCII fallback + filename*（UTF-8 中文文件名正确显示）
  res.setHeader(
    'Content-Disposition',
    `${isImage ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.filename)}`
  );
  fs.createReadStream(disk).on('error', () => {
    if (!res.headersSent) fail(res, '附件读取失败', 1, 500);
    else res.end();
  }).pipe(res);
}));

export default router;
