/**
 * 商品图片上传与读取。
 *
 *  POST /api/uploads          店主/操作员上传一张商品图（body: { name, mime, dataB64 }，≤2MB）
 *                             → { url:'/api/uploads/<file>', sha256, size }
 *  GET  /api/uploads/:name    公开读取（商品图本就是公开内容；文件名为随机 UUID，
 *                             不可枚举，等价于「知道链接即可访问」——公开商品图不需要更强保密）
 *
 * 为什么不复用证据附件那套（routes/evidenceFiles.js）：附件挂在订单/证据上，
 * 有可见矩阵与按订单配额；商品图是店铺级公开资源，鉴权与配额语义完全不同，
 * 硬合并只会把两套规则搅在一起。存储布局与安全约定则与它保持一致（见 productImages.js）。
 */
import { Router } from 'express';
import express from 'express';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { roleOf, verifyToken } from '../auth.js';
import { logAudit } from '../audit.js';
import {
  MAX_IMAGE_BYTES,
  validateImageMeta,
  storeProductImage,
  findProductImage,
} from '../productImages.js';

const router = Router();
// 与 products 路由同权限：商品经营面 = 店主 + 操作员
const staffOnly = makeAuthMiddleware(verifyToken, { staffOnly: true });

// 上传限流：单 IP 每分钟 20 张（正常上架远低于此；挡脚本刷盘）
const uploadLimiter = simpleRateLimit({ windowMs: 60_000, max: 20, message: '图片上传过于频繁，请稍后再试' });
const readLimiter = simpleRateLimit({ windowMs: 60_000, max: 2000, message: '图片读取过于频繁' });

/** 上传一张商品图 */
router.post(
  '/',
  staffOnly,
  uploadLimiter,
  express.json({ limit: '4mb' }),
  wrap(async (req, res) => {
    const { name, mime, dataB64 } = req.body || {};
    const b64 = String(dataB64 || '');
    if (!b64) return fail(res, 'dataB64 必填（图片的 base64，不含 data: 前缀）');

    // 先按 base64 长度粗筛，避免把超限内容真的解码进内存
    if (Math.floor((b64.length * 3) / 4) > MAX_IMAGE_BYTES + 1024) {
      return fail(res, `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`);
    }
    let data;
    try {
      data = Buffer.from(b64, 'base64');
    } catch {
      return fail(res, 'dataB64 不是合法的 base64');
    }
    const meta = validateImageMeta({ name, mime, size: data.length });
    if (meta.error) return fail(res, meta.error);

    // 魔数不符是**用户可修的输入错误**（不是内部异常）：按业务失败回给前端，别让它冒成 500
    let stored;
    try {
      stored = storeProductImage({ mime: meta.mime, data });
    } catch (e) {
      return fail(res, e?.message || '图片内容校验失败');
    }
    logAudit({
      req,
      actor: req.auth?.address,
      actorRole: roleOf(req.auth?.address || ''),
      action: 'product.image.upload',
      targetType: 'image',
      targetId: stored.url,
      detail: { size: stored.size, mime: meta.mime },
    });
    ok(res, stored, '图片已上传');
  })
);

/**
 * 读取图片（公开）。
 * 注意：这里**不删**孤儿图片 —— 商品下架/改图后旧图仍留在盘上。
 * 有意为之：订单快照锁的是图片 URL 字符串，删图会让历史订单变成裂图；
 * 省下的那点磁盘不值得冒这个险（删图需要先确认全库无引用，属于另一件事）。
 */
router.get(
  '/:name',
  readLimiter,
  wrap(async (req, res) => {
    const hit = findProductImage(req.params.name);
    if (!hit) return fail(res, '图片不存在', 404, 404);
    res.setHeader('Content-Type', hit.mime);
    // 文件名是随机 UUID、内容永不变化 → 可长缓存
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(hit.disk);
  })
);

export default router;
