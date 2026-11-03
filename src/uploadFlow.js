/**
 * 一次「流式上传 + 按人字节额度」的唯一实现。
 *
 * 商品媒体（routes/uploads.js）与节点头像/店铺头像（routes/shop.js）走的是同一条闸：
 * 预留额度 → 读请求体写盘 → 成功按实际字节结算 / 失败全额归还。此前这段逻辑只写在
 * uploads.js 里，头像如果另抄一份，两处的"失败是否归还额度"迟早会分叉（而症状是
 * 额度被失败上传悄悄吃掉，没人能复现）。
 */
import { MediaUploadError, storeMediaStream } from './productMedia.js';
import { MAX_UPLOAD_BYTES, PRODUCT_MEDIA_MIMES } from './mediaKinds.js';
import { reserveUploadBytes, commitUploadBytes, releaseUploadBytes } from './uploadBudget.js';

/** 默认每人每小时额度（商品媒体与头像共用同一份额度） */
export const DEFAULT_UPLOAD_BYTES_PER_HOUR = 1024 * 1024 * 1024;
const MB = (n) => Math.round(Number(n) / 1024 / 1024);

/** 额度不足（用户可修：等窗口过去或压缩文件） */
export class UploadQuotaError extends Error {
  constructor(used, limitBytes, maxBytes) {
    super(
      `本小时上传额度不足以容纳本次上传（已用 ${MB(used)}MB / 上限 ${MB(limitBytes)}MB；` +
        `单次最多 ${MB(maxBytes)}MB）——请稍后再试，或先压缩/裁剪媒体`
    );
    this.name = 'UploadQuotaError';
    this.used = used;
    this.limitBytes = limitBytes;
    this.maxBytes = maxBytes;
  }
}

/** Redis 不可用（不是用户输入问题；返回 503 让调用方重试） */
export class UploadUnavailableError extends Error {
  constructor() {
    super('上传依赖暂时不可用，请稍后重试');
    this.name = 'UploadUnavailableError';
  }
}

/**
 * 处理一次原始字节流上传。
 *
 * @param {import('express').Request} req
 * @param {string} actor 上传者地址（额度按人记账）
 * @param {{maxUploadBytes?:number, limitBytes?:number, allowedMimes?:string[], label?:string}} [opts]
 * @returns {Promise<{url:string, kind:'image'|'video', mime:string, size:number, sha256:string}>}
 * @throws {UploadUnavailableError|UploadQuotaError|MediaUploadError}
 */
export async function storeRequestMedia(req, actor, opts = {}) {
  const {
    maxUploadBytes = MAX_UPLOAD_BYTES,
    limitBytes = DEFAULT_UPLOAD_BYTES_PER_HOUR,
    allowedMimes = PRODUCT_MEDIA_MIMES,
    label = '主图区',
  } = opts;
  let reserved;
  try {
    reserved = await reserveUploadBytes(actor, maxUploadBytes, limitBytes);
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw new UploadUnavailableError();
    throw e;
  }
  if (!reserved.ok) throw new UploadQuotaError(reserved.used, reserved.limitBytes, maxUploadBytes);
  try {
    const stored = await storeMediaStream(req, { maxUploadBytes, allowedMimes, label });
    await commitUploadBytes(reserved.reservation, stored.size);
    return stored;
  } catch (e) {
    await releaseUploadBytes(reserved.reservation);
    throw e;
  }
}

export { MediaUploadError };
