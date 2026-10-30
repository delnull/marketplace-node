/**
 * 孤儿媒体清扫的**引用面**判据（清扫会删文件，漏一处引用就是删掉在用的图）。
 *
 * 清扫只删"全库无引用且超过 TTL"的文件，而"引用"来自 `MEDIA_REF_SOURCES` 这份手写清单。
 * 它此前漏了 `product_skus.image_url`（规格图会被当孤儿删掉）——这类漏法的判据只能是
 * **schema 与清单的对拍**，不是"下次记得"。
 *
 * 查什么：
 *  1. schema 里每个名字带媒体词汇的列（image/images/media/poster/video/logo/...）都必须在
 *     清单里。新增一处能存媒体 URL 的列而没加进清单 ⇒ 红。
 *  2. 清单里的每一列都真实存在（列被删/改名 ⇒ 红，而不是让 SQL 在清扫时才报错）。
 *  3. 行为：商品主图、详情图、规格图、订单快照里的 URL 都会被 `referencedMediaUrls()` 收到。
 *
 * 不查什么：不跑真实的 `sweepOrphanUploads`（那要往 uploads 目录写/删文件）；删除逻辑本身
 * 由 `scanned/referenced/removed/failed` 的形状与 `MEDIA_REF_SOURCES` 的单一来源保证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { insertOrder, insertProduct, makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { db, owner, buyer } = ctx;
const { MEDIA_REF_SOURCES, referencedMediaUrls } = await import('../src/mediaSweep.js');

/** 列名里出现这些词，就按"可能存媒体 URL"对待（新增字段命名基本逃不出这张表） */
const MEDIA_COLUMN_RE = /(^|_)(image|images|media|poster|video|avatar|banner|logo|thumbnail|thumb|cover|photo)(_|$)/i;

const mediaUrl = (ext = 'png') => `/api/uploads/${randomUUID()}.${ext}`;

test('schema 里每个媒体字段都在清扫的引用面里（漏一处就会删掉在用的文件）', async () => {
  const columns = await db.all(
    'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()'
  );
  const sources = new Map(MEDIA_REF_SOURCES.map((s) => [s.table, new Set(s.columns)]));
  const missing = columns
    .filter((col) => MEDIA_COLUMN_RE.test(col.c) && !sources.get(col.t)?.has(col.c))
    .map((col) => `${col.t}.${col.c}`)
    .sort();
  assert.deepEqual(
    missing,
    [],
    [
      '这些列名是媒体字段，但不在 node/src/mediaSweep.js 的 MEDIA_REF_SOURCES 里：',
      ...missing.map((c) => `  ${c}`),
      '清扫会把它们引用的文件当成孤儿删掉（不可逆）。若该列确实不存 /api/uploads/ URL，',
      '请改列名或把它显式纳入清单——不要靠"这次记得"。',
    ].join('\n')
  );
});

test('清单里的表/列都真实存在（列改名/被删要当场红，而不是清扫时才炸）', async () => {
  const columns = await db.all(
    'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()'
  );
  const have = new Set(columns.map((col) => `${col.t}.${col.c}`));
  const problems = [];
  for (const { table, columns: cols } of MEDIA_REF_SOURCES) {
    for (const c of cols) {
      if (!have.has(`${table}.${c}`)) problems.push(`${table}.${c}`);
    }
  }
  assert.deepEqual(problems, [], `MEDIA_REF_SOURCES 指向了不存在的列：${problems.join('、')}`);
});

test('商品主图 / 详情图 / 规格图 / 订单快照里的 URL 都算"被引用"', async () => {
  const productImage = mediaUrl();
  const descriptionImage = mediaUrl('webp');
  const skuImage = mediaUrl('jpg');
  const snapshotImage = mediaUrl('mp4');
  const unreferenced = mediaUrl();

  await insertProduct(db, {
    title: '清扫引用面测试商品',
    media: [{ type: 'image', url: productImage }],
    descriptionBlocks: [{ type: 'image', url: descriptionImage }],
    skus: [{ key: '', priceUsdtMicro: 1, imageUrl: skuImage }],
  });
  await insertOrder(db, {
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    productSnapshot: JSON.stringify({ media: [{ type: 'video', url: snapshotImage }] }),
  });

  const refs = await referencedMediaUrls();
  for (const [label, url] of [
    ['商品主图', productImage],
    ['详情图', descriptionImage],
    ['规格图', skuImage],
    ['订单快照', snapshotImage],
  ]) {
    assert.ok(refs.has(url), `${label} ${url} 没被清扫的引用面收到——它会被当成孤儿删掉`);
  }
  assert.equal(refs.has(unreferenced), false, '没有行引用过的 URL 不应出现在引用集合里');
});
