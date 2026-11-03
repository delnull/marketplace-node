/**
 * 孤儿媒体清扫（商品图/视频、规格图、评价图共用 uploads 目录）。
 *
 * 只删**全库无引用**且超过 TTL 的文件。引用面见 {@link MEDIA_REF_SOURCES}：
 *  - 商品当前 media / description_blocks；
 *  - 规格组合主图 product_skus.image_url（与商品主图同一条 URL 判据，页面上会被渲染）；
 *  - 订单 product_snapshot（历史订单的图必须继续可看，否则「孤儿」删掉会裂图）；
 *  - 评价 images / followup_images。
 *
 * 漏掉一处落点的后果不是"少清一个文件"，而是**删掉在用的图**（不可逆）。所以引用面
 * 集中成一份清单，并由 test/media-sweep-refs.test.js 按 schema 对拍：列名带媒体词汇的
 * 新列不在清单里会当场变红。
 *
 * uploads 里可能还有「刚上传、还没保存商品/评价」的文件——TTL 就是留给编辑器的窗口。
 * 删除是幂等的；目录读不到返回 scanned=-1，不假装成功。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { uploadsDir } from './productMedia.js';

const URL_RE = /\/api\/uploads\/[0-9a-fA-F-]{36}\.(?:png|jpe?g|webp|gif|mp4|webm)/g;

/**
 * 清扫的**引用面**：所有会被页面渲染的 `/api/uploads/` URL 落点（表 + 列）。
 *
 * 表名/列名只来自这份静态清单（不来自请求），拼进 SQL 前仍加反引号。
 * 新增一处落点时**必须同时加进这里**——判据是 test/media-sweep-refs.test.js
 * （它把 schema 里带媒体词汇的列与这份清单对拍）。
 */
export const MEDIA_REF_SOURCES = Object.freeze([
  { table: 'products', columns: Object.freeze(['media', 'description_blocks']) },
  { table: 'product_skus', columns: Object.freeze(['image_url']) },
  { table: 'orders', columns: Object.freeze(['product_snapshot']) },
  { table: 'reviews', columns: Object.freeze(['images', 'followup_images']) },
]);

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

/** 全库引用集合（按 {@link MEDIA_REF_SOURCES} 逐表逐列收集） */
export async function referencedMediaUrls() {
  const db = getDb();
  const refs = new Set();
  for (const { table, columns } of MEDIA_REF_SOURCES) {
    const rows = await db.all(`SELECT ${columns.map((c) => `\`${c}\``).join(', ')} FROM \`${table}\``);
    for (const row of rows) {
      for (const column of columns) collect(row[column], refs);
    }
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
