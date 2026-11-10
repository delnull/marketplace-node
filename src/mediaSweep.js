/**
 * 媒体生命周期：孤儿清扫（商品图/视频、规格图、评价图、头像共用 uploads 目录）+
 * **唯一显式删除入口** `removeMediaUrls`（按全库引用判定，见该函数说明）。
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
import {
  STORED_EXT_PATTERN,
  STORED_NAME_RE,
  storedMediaNameOf,
  UPLOAD_URL_PREFIX,
} from './mediaKinds.js';
import { findMedia, uploadsDir } from './productMedia.js';

const URL_RE = new RegExp(`/api/uploads/[0-9a-f]{64}\\.(?:${STORED_EXT_PATTERN})`, 'g');

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
  // 头像也是 /api/uploads/ 的引用落点；漏掉会把在用头像当孤儿删掉
  { table: 'node', columns: Object.freeze(['avatar_url']) },
  { table: 'shops', columns: Object.freeze(['avatar_url']) },
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
 * 批量版引用查询：只回答"这些 URL 里哪些还被引用"，不再把全库行读进 Node。
 *
 * 每个来源表一条 `LIKE` 查询（列 × URL 展开成 OR），命中行再递归收集并**按目标 URL 过滤**。
 * 引用面仍是 {@link MEDIA_REF_SOURCES} 这一份清单；与全量扫描的口径差异只有两点：
 *  · `LIKE '%url%'` 可能把"另一个 URL 里包含该串"也算命中——方向是**多保留**，安全；
 *  · 查询本身只返回可能命中的行，不再全表搬运（商品/订单快照大时这是主要成本）。
 *
 * 用途：显式删除前的引用判定（头像/评价图/ PII 擦除）。孤儿清扫仍走全量扫描——
 * 它本来就要一次看完所有引用，没有"给定 URL"可批。
 *
 * @param {string[]} urls 目标 URL（`/api/uploads/<sha256>.<ext>`）
 * @returns {Promise<Set<string>>} 命中的目标 URL
 */
export async function referencedMediaUrlsOf(urls) {
  const targets = [...new Set((urls || []).map((u) => String(u || '')).filter(Boolean))];
  if (!targets.length) return new Set();
  const db = getDb();
  // `ESCAPE '!'`：URL 里不会有 `!`，但把 `%`/`_`/`!` 转义掉，避免被当成通配符
  const patterns = targets.map((u) => `%${u.replace(/[!%_]/g, '!$&')}%`);
  const found = new Set();
  for (const { table, columns } of MEDIA_REF_SOURCES) {
    const where = [];
    const params = [];
    for (const column of columns) {
      for (const pattern of patterns) {
        where.push(`\`${column}\` LIKE ? ESCAPE '!'`);
        params.push(pattern);
      }
    }
    if (!where.length) continue;
    const rows = await db.all(
      `SELECT ${columns.map((c) => `\`${c}\``).join(', ')} FROM \`${table}\` WHERE ${where.join(' OR ')}`,
      ...params
    );
    for (const row of rows) {
      for (const column of columns) collect(row[column], found);
    }
  }
  const out = new Set();
  for (const url of targets) if (found.has(url)) out.add(url);
  return out;
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
    if (!STORED_NAME_RE.test(name)) continue;
    const url = `${UPLOAD_URL_PREFIX}${name}`;
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

/**
 * 删除一组媒体 URL —— **唯一显式删除入口**（评价图下架、头像替换/移除、PII 擦除共用）。
 *
 * 判据不是"调用方说要删就删"，而是**全库引用**：内容寻址后同一个 URL 可能同时被商品、
 * 订单快照、评价、头像引用，按调用方手里那一条引用直接 unlink 会删掉别人还在用的图
 * （旧实现的 `removeMediaByUrl` 就是这个形状）。引用面与孤儿清扫共用
 * {@link MEDIA_REF_SOURCES} 这一份清单，由 test/media-sweep-refs.test.js 与 schema 对拍。
 *
 * 调用顺序是契约：**先落库移除引用，再调用本函数**（下架评价图/替换头像/擦除 PII 都是这个顺序）。
 * 仍被引用的 URL 不删（保留在 `referenced`）；真正 unlink 的个数在 `removed`；删不掉的在 `failed`。
 *
 * 残留窗口（如实写）：上传返回 URL 到调用方把它写进某条引用之间，文件处于"暂时无引用"。
 * 删除恰好落在这个窗口内时，调用方最终会保存一个指向已删文件的 URL。孤儿清扫的 7 天 TTL
 * 本来就是给这个窗口的，但显式删除不能延迟（头像替换/评价下架/PII 擦除都要求立即生效）。
 * 要彻底消除它需要给"已上传未引用"加租约（额外的持久状态），本仓不引入这份状态。
 *
 * @param {string|string[]} urls `/api/uploads/<sha256>.<ext>`（非本节点形状的条目被静默忽略）
 * @returns {Promise<{removed:number, failed:string[], referenced:string[]}>}
 *          `removed` = 真正 unlink 的文件数；`failed` = 仍没删掉的 URL（权限/占用）；
 *          `referenced` = 仍被别处引用、按判据刻意保留的 URL。
 */
export async function removeMediaUrls(urls) {
  const names = [
    ...new Set(
      (Array.isArray(urls) ? urls : [urls]).map((url) => storedMediaNameOf(url)).filter(Boolean)
    ),
  ];
  if (!names.length) return { removed: 0, failed: [], referenced: [] };
  /*
    先看盘上还剩什么：重复调用（PII 擦除是幂等的）大多在这里就结束了，
    没必要为已不存在的文件做一次引用扫描。
  */
  const hits = [];
  for (const name of names) {
    const hit = findMedia(name);
    if (hit) hits.push({ name, hit });
  }
  if (!hits.length) return { removed: 0, failed: [], referenced: [] };
  const targetUrls = hits.map(({ name }) => `${UPLOAD_URL_PREFIX}${name}`);
  const refs = await referencedMediaUrlsOf(targetUrls);
  const failed = [];
  const referenced = [];
  let removed = 0;
  for (const { name, hit } of hits) {
    const url = `${UPLOAD_URL_PREFIX}${name}`;
    if (refs.has(url)) {
      referenced.push(url);
      continue;
    }
    try {
      fs.unlinkSync(hit.disk);
      removed += 1;
    } catch (e) {
      // 扫描到 unlink 之间被别的请求删掉：目标已达成，不算失败
      if (e?.code === 'ENOENT') continue;
      failed.push(url);
    }
  }
  return { removed, failed, referenced };
}
