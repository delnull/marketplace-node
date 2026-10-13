/**
 * 商品媒体（主图区图片 + 视频）上传与读取。
 *
 *  POST /api/uploads          店主/操作员上传一段商品媒体（**请求体就是文件字节**，流式写入）
 *                             → { url:'/api/uploads/<file>', kind:'image'|'video', mime, size, sha256 }
 *  GET  /api/uploads/:name    公开读取（商品媒体本就是公开内容；文件名为随机 UUID，
 *                             不可枚举，等价于「知道链接即可访问」——公开商品图/视频不需要更强保密）。
 *                             `res.sendFile` 自带 Range/206：视频拖动进度条不需要另写流式读取。
 *
 * 传输形状：**原始字节流**，不是 base64 JSON。
 *  - 旧实现 `{ name, mime, dataB64 }` 有两个毛病：base64 让体积膨胀 33%（50MB 视频 → ~67MB 字符串），
 *    且整份内容要在内存里待两遍；流式写入的内存占用是常量。
 *  - 代价如实写：类型要等字节到了才知道（判据是字节，不是客户端声明的 MIME），
 *    于是传输上限只能取类型表里最大的那个（50MB），一次垃圾上传最多写 50MB 才被丢弃
 *    —— 由请求限流 + 按人的字节额度 + 临时文件即删兜住。
 *
 * 为什么不复用证据附件那套（routes/evidenceFiles.js）：附件挂在订单/证据上，
 * 有可见矩阵与按订单配额；商品媒体是店铺级公开资源，鉴权与配额语义完全不同，
 * 硬合并只会把两套规则搅在一起。存储布局与安全约定则与它保持一致（见 productMedia.js）。
 */
import { Router } from 'express';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { roleOf, verifyToken } from '../auth.js';
import { logAudit } from '../audit.js';
import { MediaUploadError, findMedia, storeMediaStream } from '../productMedia.js';

const router = Router();
// 与 products 路由同权限：商品经营面 = 店主 + 操作员
const staffOnly = makeAuthMiddleware(verifyToken, { staffOnly: true });

// 上传限流：单 IP 每分钟 20 个（正常上架远低于此；挡脚本刷盘）
const uploadLimiter = simpleRateLimit({ windowMs: 60_000, max: 20, message: '媒体上传过于频繁，请稍后再试' });
const readLimiter = simpleRateLimit({ windowMs: 60_000, max: 2000, message: '媒体读取过于频繁' });

/**
 * 按人（staff 地址）的小时字节额度：1GB。
 *
 * 为什么要有它：请求数限流挡不住"20 个 50MB 视频/分钟"这种量级（一分钟就能写 1GB，
 * 而且磁盘上的孤儿媒体是**刻意不删**的）。判据挂在人身上而不是 IP 上——
 * 同一家店的店主换网络照旧受自己的额度约束。
 * 额度只在**上传之前**检查、成功之后记账：超了就直接拒（不浪费一次 50MB 的写盘）。
 */
const UPLOAD_BYTES_PER_HOUR = 1024 * 1024 * 1024;
const byteLedger = new Map(); // actor → [{ at, bytes }]
function bytesUsedInWindow(actor, now) {
  const rows = (byteLedger.get(actor) || []).filter((r) => now - r.at < 3_600_000);
  if (rows.length) byteLedger.set(actor, rows);
  else byteLedger.delete(actor);
  return rows.reduce((n, r) => n + r.bytes, 0);
}
function noteUploadedBytes(actor, bytes, now) {
  const rows = byteLedger.get(actor) || [];
  rows.push({ at: now, bytes });
  byteLedger.set(actor, rows);
}

/** 上传一段商品媒体（图片或视频，类型由字节判定） */
router.post(
  '/',
  staffOnly,
  uploadLimiter,
  wrap(async (req, res) => {
    const actor = req.auth?.address || '';
    const used = bytesUsedInWindow(actor, Date.now());
    if (used >= UPLOAD_BYTES_PER_HOUR) {
      return fail(res, `本小时上传额度已用完（${Math.round(UPLOAD_BYTES_PER_HOUR / 1024 / 1024)}MB），请稍后再试`);
    }
    let stored;
    try {
      stored = await storeMediaStream(req);
    } catch (e) {
      // 类型不符/超限/空文件都是**用户可修的输入错误**（不是内部异常）：按业务失败回给前端
      if (e instanceof MediaUploadError) return fail(res, e.message);
      throw e;
    }
    noteUploadedBytes(actor, stored.size, Date.now());
    logAudit({
      req,
      actor,
      actorRole: roleOf(actor),
      action: 'product.media.upload',
      targetType: stored.kind,
      targetId: stored.url,
      detail: { size: stored.size, mime: stored.mime },
    });
    ok(res, stored, stored.kind === 'video' ? '视频已上传' : '图片已上传');
  })
);

/**
 * 读取媒体（公开）。
 * 注意：这里**不删**孤儿文件 —— 商品下架/换图/换视频后旧文件仍留在盘上。
 * 有意为之：订单快照锁的是媒体 URL 字符串，删文件会让历史订单变成裂图；
 * 省下的那点磁盘不值得冒这个险（删文件需要先确认全库无引用，属于另一件事）。
 * 用量可在 `GET /healthz` 的 `uploads` 块看到（`mediaUsage`）。
 */
router.get(
  '/:name',
  readLimiter,
  wrap(async (req, res) => {
    const hit = findMedia(req.params.name);
    if (!hit) return fail(res, '媒体不存在', 404, 404);
    res.setHeader('Content-Type', hit.mime);
    // 文件名是随机 UUID、内容永不变化 → 可长缓存
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(hit.disk);
  })
);

export default router;
