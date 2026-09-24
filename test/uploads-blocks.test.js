/**
 * 商品图片上传 + 详情块（文字/图片混排）单测。
 *
 * 覆盖：
 *  - 上传的类型白名单 / 大小上限 / 权限 / base64 校验
 *  - 落盘后可通过公开路径读回，且按扩展名给出正确 Content-Type
 *  - 路径穿越与不存在文件都被拒
 *  - 详情块：规范化（空块丢弃、相邻文字合并）、类型白名单、入快照哈希、DTO 暴露
 *  - description 与块的关系：有块时由块派生（搜索用），无块时保留原文
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { login, makeCtx, productPayload, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner } = ctx;
const ownerToken = (await login(ctx, owner)).token;

/** 1x1 PNG（最小合法图片） */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const upload = (body, token = ownerToken) =>
  request(app).post('/api/uploads').set('Authorization', `Bearer ${token}`).send(body);

// ── 上传 ──

test('上传商品图：落盘并返回节点相对 URL + sha256', async () => {
  const res = await upload({ name: 'a.png', mime: 'image/png', dataB64: PNG_B64 }).expect(200);
  assertOk(res);
  const { url, sha256, size } = res.body.data;
  assert.match(url, /^\/api\/uploads\/[0-9a-f-]{36}\.png$/, '返回节点相对路径（换域名不回填历史数据）');
  assert.equal(size, Buffer.from(PNG_B64, 'base64').length);
  assert.equal(sha256, createHash('sha256').update(Buffer.from(PNG_B64, 'base64')).digest('hex'), 'sha256 可复算');
});

test('上传的图片可经公开路径读回，Content-Type 与长缓存头正确', async () => {
  const up = await upload({ name: 'b.png', mime: 'image/png', dataB64: PNG_B64 }).expect(200);
  const url = up.body.data.url;
  const got = await request(app).get(url).expect(200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.match(got.headers['cache-control'] || '', /immutable/, '文件名随机且内容不变 → 可长缓存');
  assert.equal(got.body.length, Buffer.from(PNG_B64, 'base64').length, '字节与上传一致');
});

test('类型白名单：非图片与 svg 被拒；大小超限被拒', async () => {
  const pdf = await upload({ name: 'a.pdf', mime: 'application/pdf', dataB64: PNG_B64 }).expect(200);
  assert.notEqual(pdf.body.code, 0);
  assert.match(pdf.body.message, /仅支持 png/);

  // svg 可内嵌脚本 —— 虽在 <img> 中不执行，但一旦被用在别的渲染上下文就是 XSS 面，故不收
  const svg = await upload({ name: 'a.svg', mime: 'image/svg+xml', dataB64: PNG_B64 }).expect(200);
  assert.notEqual(svg.body.code, 0);

  const big = await upload({
    name: 'big.png',
    mime: 'image/png',
    // 3MB base64 → 约 2.25MB 解码后，超 2MB 图片上限但仍在 4MB body 限制内
    dataB64: 'A'.repeat(3 * 1024 * 1024),
  }).expect(200);
  assert.notEqual(big.body.code, 0);
  assert.match(big.body.message, /2MB|上限/);
});

test('权限：未登录 401；非店主 403', async () => {
  await request(app).post('/api/uploads').send({ name: 'a.png', mime: 'image/png', dataB64: PNG_B64 }).expect(401);
  const stranger = (await login(ctx, ctx.buyer)).token;
  // makeAuthMiddleware({staffOnly}) 统一给出「需要店主/店员权限」
  await upload({ name: 'a.png', mime: 'image/png', dataB64: PNG_B64 }, stranger).expect(403);
});

test('dataB64 缺失或为空被拒', async () => {
  const res = await upload({ name: 'a.png', mime: 'image/png' }).expect(200);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /dataB64/);
});

test('读取：路径穿越与不存在的文件名都 404', async () => {
  for (const bad of ['..%2F..%2Fpackage.json', 'notauuid.png', '../../../etc/passwd', 'a.png']) {
    const res = await request(app).get(`/api/uploads/${bad}`);
    assert.equal(res.status, 404, `${bad} 应 404`);
  }
});

// ── 详情块 ──

test('详情块：空块丢弃、相邻文字合并、图片 URL 白名单', async () => {
  const ok1 = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(
      productPayload({
        title: '富说明商品',
        descriptionBlocks: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
          { type: 'image', url: '/api/uploads/00000000-0000-0000-0000-000000000000.png' },
          { type: 'text', text: '   ' }, // 空块 → 丢弃
          { type: 'image', url: 'https://example.com/x.jpg' },
        ],
      })
    )
    .expect(200);
  assertOk(ok1);
  const blocks = ok1.body.data.descriptionBlocks;
  assert.equal(blocks.length, 3, '两个相邻文字块合并为 1，两个图片块保留');
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, '第一段\n第二段', '相邻文字块按换行合并');
  assert.equal(blocks[1].type, 'image');

  // javascript: 之类的 scheme 必须被拒（将来换渲染上下文就是 XSS）
  const bad = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ descriptionBlocks: [{ type: 'image', url: 'javascript:alert(1)' }] }))
    .expect(200);
  assert.notEqual(bad.body.code, 0);
  assert.match(bad.body.message, /http\/https|本站上传/);

  const badType = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ descriptionBlocks: [{ type: 'script', text: 'x' }] }))
    .expect(200);
  assert.notEqual(badType.body.code, 0);
  assert.match(badType.body.message, /不支持的详情块类型/);
});

test('description 与块的关系：有块则由块派生（供搜索），无块则保留原文', async () => {
  const withBlocks = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(
      productPayload({
        title: '派生摘要',
        description: '这段会被块覆盖',
        descriptionBlocks: [
          { type: 'text', text: '关键词甲' },
          { type: 'image', url: 'https://example.com/a.jpg' },
          { type: 'text', text: '关键词乙' },
        ],
      })
    )
    .expect(200);
  assertOk(withBlocks);
  const d = withBlocks.body.data.description;
  assert.match(d, /关键词甲/);
  assert.match(d, /关键词乙/);
  assert.match(d, /\[图片\]/, '图片块在摘要里留占位，保留段落节奏');
  assert.doesNotMatch(d, /被块覆盖/, '有块时原文被派生摘要取代');

  // 派生摘要要能被搜索命中（搜索走 SQL LIKE 匹配的是 description）
  const found = await request(app).get('/api/products?q=关键词甲').expect(200);
  assert.ok(
    found.body.data.products.some((p) => p.slug === withBlocks.body.data.slug),
    '详情块里的文字应可被商品搜索命中'
  );

  const plain = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ title: '纯文本说明', description: '只有一段纯文本' }))
    .expect(200);
  assertOk(plain);
  assert.equal(plain.body.data.description, '只有一段纯文本', '无块时保留原文');
  assert.deepEqual(plain.body.data.descriptionBlocks, []);
});

test('详情块入快照：改块必须重算哈希，否则详情可被无声篡改', async () => {
  const created = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ title: '快照含块', descriptionBlocks: [{ type: 'text', text: '原始说明' }] }))
    .expect(200);
  assertOk(created);
  const p = created.body.data;
  assert.deepEqual(p.descriptionBlocks, [{ type: 'text', text: '原始说明' }]);
  const before = p.snapshotHash;

  const patched = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ descriptionBlocks: [{ type: 'text', text: '原始说明' }, { type: 'image', url: 'https://e.com/x.png' }] })
    .expect(200);
  assertOk(patched);
  assert.notEqual(patched.body.data.snapshotHash, before, '往说明里插图必须改变快照哈希');
  assert.equal(patched.body.data.descriptionBlocks.length, 2);
});

test('详情块数量上限', async () => {
  const many = Array.from({ length: 41 }, (_, i) => ({ type: 'text', text: `第 ${i} 段` }));
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ descriptionBlocks: many }))
    .expect(200);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /最多 40 个/);
});
