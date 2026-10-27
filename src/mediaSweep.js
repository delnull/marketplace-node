/**
 * 孤儿媒体清扫（商品图/视频、评价图共用 uploads 目录）。
 *
 * 只删**全库无引用**且超过 TTL 的文件：
 *  - 商品当前 media / description_blocks；
 *  - 订单 product_snapshot（历史订单的图必须继续可看，否则「孤儿」删掉会裂图）；
 *  - 评价 images / followup_images。
 *
 * uploads 里可能还有「刚上传、还没保存商品/评价」的文件——TTL 就是留给编辑器的窗口。
 * 删除是幂等的；目录读不到返回 scanned=-1，不假装成功。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { uploadsDir } from './productMedia.js';

const URL_RE = /\/api\/uploads\/[0-9a-fA-F-]{36}\.(?:png|jpe?g|webp|gif|mp4|webm)/g;

function collect(value, out) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(URL_RE)) out.add(m[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collect(v, out);
  }
}

/** 全库引用集合（商品当前字段 + 订单快照 + 评价图） */
export async function referencedMediaUrls() {
  const db = getDb();
  const refs = new Set();
  const products = await db.all('SELECT media, description_blocks FROM products');
  for (const r of products) {
    collect(r.media, refs);
    collect(r.description_blocks, refs);
  }
  const orders = await db.all('SELECT product_snapshot FROM orders');
  for (const r of orders) collect(r.product_snapshot, refs);
  const reviews = await db.all('SELECT images, followup_images FROM reviews');
  for (const r of reviews) {
    collect(r.images, refs);
    collect(r.followup_images, refs);
  }
  return refs;
}

/**
 * @returns {{scanned:number, referenced:number, removed:number, failed:number, unreadable?:boolean}}
 */
export async function sweepOrphanUploads({ olderThanMs = 7 * 24 * 3600 * 1000, now = Date.now() } = {}) {
  const refs = await referencedMediaUrls();
  const dir = uploadsDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { scanned: -1, referenced: refs.size, removed: 0, failed: 0, unreadable: true };
  }
  const cutoff = now - Math.max(0, olderThanMs);
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|webp|gif|mp4|webm)$/i.test(name)) {
      continue;
    }
    const url = `/api/uploads/${name}`;
    if (refs.has(url)) continue;
    const disk = path.join(dir, name);
    try {
      const st = fs.statSync(disk);
      if (!st.isFile() || st.mtimeMs > cutoff) continue;
      fs.unlinkSync(disk);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: names.length, referenced: refs.size, removed, failed };
}
