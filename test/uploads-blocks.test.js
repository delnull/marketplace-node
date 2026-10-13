/**
 * 商品媒体上传（主图区图片 + 视频）+ 详情块（文字/图片混排）单测。
 *
 * 覆盖：
 *  - 上传：**类型由字节判定**（不看客户端声明的 MIME）、图片/视频各自的大小上限、权限、空体
 *  - 落盘后可通过公开路径读回，且按类型给出正确 Content-Type 与长缓存头
 *  - 路径穿越与不存在文件都被拒
 *  - 商品 media 字段：形状校验、上限、URL 白名单、视频只收本站、poster 必填、入快照哈希
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
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * 合成一个"MP4 容器"：偏移 4 起必须是 `ftyp` box（判据见 shared/media.js）。
 * 测试不需要能解码的画面——服务端判的是容器（编码不可判，那由店主侧封面抓帧兜住）。
 */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(2048, 7)]);

/** 合成一个 WebM 容器：EBML 魔数 + 头部 DocType `webm` */
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from('B\x82\x84webmB\x87\x81\x02B\x85\x81\x02', 'latin1'),
  Buffer.alloc(256, 3),
]);

/** 上传：请求体就是文件字节（**不是** base64 JSON） */
const upload = (buf, { token = ownerToken, type = 'application/octet-stream' } = {}) =>
  request(app)
    .post('/api/uploads')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', type)
    .send(buf);

// ── 上传 ──

test('上传商品图：落盘并返回节点相对 URL + sha256', async () => {
  const res = await upload(PNG, { type: 'image/png' }).expect(200);
  assertOk(res);
  const { url, kind, mime, sha256, size } = res.body.data;
  assert.match(url, /^\/api\/uploads\/[0-9a-f-]{36}\.png$/, '返回节点相对路径（换域名不回填历史数据）');
  assert.equal(kind, 'image');
  assert.equal(mime, 'image/png');
  assert.equal(size, PNG.length);
  assert.equal(sha256, createHash('sha256').update(PNG).digest('hex'), 'sha256 可复算');
});

test('上传视频：按字节认成 mp4/webm，返回 kind=video', async () => {
  const mp4 = await upload(MP4, { type: 'video/mp4' }).expect(200);
  assertOk(mp4);
  assert.equal(mp4.body.data.kind, 'video');
  assert.equal(mp4.body.data.mime, 'video/mp4');
  assert.match(mp4.body.data.url, /\.mp4$/);

  const webm = await upload(WEBM, { type: 'video/webm' }).expect(200);
  assertOk(webm);
  assert.equal(webm.body.data.mime, 'video/webm');
});

test('类型由字节判定：声明与实际不符时以字节为准，认不出来就拒', async () => {
  // 声明成图片、实为 MP4 → 按 MP4 落盘（扩展名 .mp4，不是 .png）
  const lying = await upload(MP4, { type: 'image/png' }).expect(200);
  assertOk(lying);
  assert.equal(lying.body.data.kind, 'video');
  assert.match(lying.body.data.url, /\.mp4$/);

  // 声明成 mp4、实为 PNG → 按 PNG 落盘，并按**图片**上限判（2MB）
  const lying2 = await upload(PNG, { type: 'video/mp4' }).expect(200);
  assertOk(lying2);
  assert.equal(lying2.body.data.kind, 'image');
  assert.match(lying2.body.data.url, /\.png$/);

  const pdf = await upload(Buffer.from('%PDF-1.7 not really a pdf'), { type: 'application/pdf' }).expect(200);
  assert.notEqual(pdf.body.code, 0);
  assert.match(pdf.body.message, /只收 png|无法识别/);
});

test('上传的媒体可经公开路径读回，Content-Type 与长缓存头正确；视频支持 Range', async () => {
  const up = await upload(PNG, { type: 'image/png' }).expect(200);
  const got = await request(app).get(up.body.data.url).expect(200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.match(got.headers['cache-control'] || '', /immutable/, '文件名随机且内容不变 → 可长缓存');
  assert.equal(got.body.length, PNG.length, '字节与上传一致');

  const vid = await upload(MP4, { type: 'video/mp4' }).expect(200);
  const range = await request(app).get(vid.body.data.url).set('Range', 'bytes=0-63').expect(206);
  assert.equal(range.headers['content-type'], 'video/mp4');
  assert.match(range.headers['content-range'] || '', /^bytes 0-63\//, '视频拖动进度条靠 Range（sendFile 自带）');
  assert.equal(range.body.length, 64);
});

test('大小上限按类型判：图片 2MB 被拒，视频 50MB 以内放行', async () => {
  // 3MB 的 PNG 头 + 填充：超 2MB 图片上限
  const bigPng = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 0)]);
  const big = await upload(bigPng, { type: 'image/png' }).expect(200);
  assert.notEqual(big.body.code, 0);
  assert.match(big.body.message, /图片超过 2MB|上限/);

  // 3MB 的 MP4：仍在视频上限内
  const bigMp4 = Buffer.concat([MP4, Buffer.alloc(3 * 1024 * 1024, 0)]);
  const okVid = await upload(bigMp4, { type: 'video/mp4' }).expect(200);
  assertOk(okVid);
  assert.equal(okVid.body.data.kind, 'video');
});

test('权限：未登录 401；非店主 403', async () => {
  await upload(Buffer.alloc(0), { token: '' }).expect(401);
  const stranger = (await login(ctx, ctx.buyer)).token;
  // makeAuthMiddleware({staffOnly}) 统一给出「需要店主/店员权限」
  await upload(Buffer.alloc(0), { token: stranger }).expect(403);
});

test('空请求体被拒（不是"空图片"这种半成品落盘）', async () => {
  const res = await upload(Buffer.alloc(0)).expect(200);
  assert.notEqual(res.body.code, 0);
  assert.match(res.body.message, /为空/);
});

test('读取：路径穿越与不存在的文件名都 404', async () => {
  for (const bad of ['..%2F..%2Fpackage.json', 'notauuid.png', '../../../etc/passwd', 'a.mp4', 'a.png']) {
    const res = await request(app).get(`/api/uploads/${bad}`);
    assert.equal(res.status, 404, `${bad} 应 404`);
  }
});

// ── 主图区（media）──

test('media：形状、上限、URL 白名单、视频只收本站、封面必填', async () => {
  const post = (body) =>
    request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).send(productPayload(body));

  // 形状不对
  const badShape = await post({ media: ['https://example.com/a.jpg'] }).expect(200);
  assert.notEqual(badShape.body.code, 0);
  assert.match(badShape.body.message, /type 只能是 image 或 video/);

  // javascript: 之外还要求 http(s)/本站路径
  const badScheme = await post({ media: [{ type: 'image', url: 'javascript:alert(1)' }] }).expect(200);
  assert.notEqual(badScheme.body.code, 0);
  assert.match(badScheme.body.message, /http\/https|本站上传/);

  // 视频只收本站上传（外链绕过"类型由字节判定"）
  const extVid = await post({
    media: [{ type: 'video', url: 'https://cdn.example.com/a.mp4', poster: 'https://cdn.example.com/a.jpg' }],
  }).expect(200);
  assert.notEqual(extVid.body.code, 0);
  assert.match(extVid.body.message, /视频仅支持上传到本站/);

  // 封面必填
  const noPoster = await post({
    media: [{ type: 'video', url: '/api/uploads/00000000-0000-0000-0000-000000000000.mp4' }],
  }).expect(200);
  assert.notEqual(noPoster.body.code, 0);
  assert.match(noPoster.body.message, /封面图/);

  // 视频个数上限
  const many = Array.from({ length: 4 }, () => ({
    type: 'video',
    url: '/api/uploads/00000000-0000-0000-0000-000000000000.mp4',
    poster: '/api/uploads/11111111-1111-1111-1111-111111111111.jpg',
  }));
  const tooMany = await post({ media: many }).expect(200);
  assert.notEqual(tooMany.body.code, 0);
  assert.match(tooMany.body.message, /视频最多 3 个/);

  // 合计上限
  const manyItems = Array.from({ length: 11 }, () => ({ type: 'image', url: 'https://example.com/a.jpg' }));
  const tooManyItems = await post({ media: manyItems }).expect(200);
  assert.notEqual(tooManyItems.body.code, 0);
  assert.match(tooManyItems.body.message, /主图区最多 10 项/);
});

test('media 入快照：顺序与元素都是校验输入，改媒体/改顺序都必须重算哈希', async () => {
  const created = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(
      productPayload({
        title: '主图区快照',
        media: [
          {
            type: 'video',
            url: '/api/uploads/00000000-0000-0000-0000-000000000000.mp4',
            poster: '/api/uploads/11111111-1111-1111-1111-111111111111.jpg',
          },
          { type: 'image', url: 'https://example.com/a.jpg' },
        ],
      })
    )
    .expect(200);
  assertOk(created);
  const p = created.body.data;
  assert.equal(p.media.length, 2);
  assert.equal(p.media[0].type, 'video');
  assert.equal(p.media[0].poster, '/api/uploads/11111111-1111-1111-1111-111111111111.jpg');
  const before = p.snapshotHash;

  // 只调换顺序也要换哈希（顺序是展示语义，买家据此核验主图没被换）
  const swapped = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ media: [p.media[1], p.media[0]] })
    .expect(200);
  assertOk(swapped);
  assert.notEqual(swapped.body.data.snapshotHash, before, '换主图顺序必须改变快照哈希');

  // 换封面（poster）同样要变
  const reposter = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      media: [
        { ...swapped.body.data.media[1], poster: 'https://example.com/new-poster.jpg' },
        swapped.body.data.media[0],
      ],
    })
    .expect(200);
  assertOk(reposter);
  assert.notEqual(reposter.body.data.snapshotHash, swapped.body.data.snapshotHash, '换封面必须改变快照哈希');

  // 未提交 media 时沿用现有（三态：未提交=不动）
  const untouched = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ title: '主图区快照（改名）' })
    .expect(200);
  assertOk(untouched);
  assert.deepEqual(untouched.body.data.media, reposter.body.data.media);
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

test('批量改价：快照重算必须带上描述块与主图区（漏一个键＝买家看到假的"内容已被修改"）', async () => {
  /*
    这条钉的是一个真实修过的缺陷：批量改价路径原先**手挑字段**重建快照，漏掉了
    description_blocks（后来也一定会漏 media）——于是带详情块/主图区的商品被批量改一次价，
    库里那个 snapshot_hash 就与商品真实内容脱钩，买家侧复算必然不一致。
    修法是让该路径把**整行**交给 snapshotObject；这里用"公开字段能否复算出同一个哈希"来验证。
  */
  const created = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(
      productPayload({
        title: '批量改价一致性',
        descriptionBlocks: [{ type: 'text', text: '带块的说明' }, { type: 'image', url: 'https://e.com/x.png' }],
        media: [
          { type: 'image', url: 'https://e.com/a.jpg' },
          {
            type: 'video',
            url: '/api/uploads/00000000-0000-0000-0000-000000000000.mp4',
            poster: '/api/uploads/11111111-1111-1111-1111-111111111111.jpg',
          },
        ],
      })
    )
    .expect(200);
  assertOk(created);
  const p = created.body.data;

  const res = await request(app)
    .patch('/api/products/batch')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ slugs: [p.slug], patch: { priceUsdtMicro: 99_000_000 } })
    .expect(200);
  assertOk(res);

  const { snapshotObject, computeSnapshotHash } = await import('../src/routes/products.js');
  const { rowLikeOf } = await import('./setup.mjs');
  const detail = await request(app).get(`/api/products/${p.slug}`).expect(200);
  const d = detail.body.data;
  assert.equal(d.priceUsdtMicro, 99_000_000, '批量改价生效');
  assert.equal(
    computeSnapshotHash(snapshotObject(rowLikeOf(d))),
    d.snapshotHash,
    '批量改价后，公开字段仍能复算出同一个快照哈希（块与媒体都没被漏掉）'
  );
});
