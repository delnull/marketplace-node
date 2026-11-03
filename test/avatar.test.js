import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, shopRef, TEST_SHOP_CODE } from './setup.mjs';

const ctx = await makeCtx();
// 必须在 makeCtx（设好 MK_SHOP_OWNER / MK_DB_NAME）之后动态导入：
// productMedia → config 会在模块求值时读 env，静态导入会抢在 setup 前面。
const { uploadsDir } = await import('../src/productMedia.js');
const { app, request, db, owner, buyer } = ctx;
const ownerToken = (await login(ctx, owner)).token;
const buyerToken = (await login(ctx, buyer)).token;

/** 1×1 PNG（与 review-media-governance.test.js 同一份，节点按字节判类型） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

const diskOf = (url) => `${uploadsDir()}/${String(url).split('/').pop()}`;

test('店铺头像：店主上传/替换/移除，旧文件同批删掉，公开 DTO 立即带上', async () => {
  const up = await request(app)
    .post('/api/shop/avatar')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .set('Content-Type', 'image/png')
    .send(PNG)
    .expect(200);
  assertOk(up);
  const url = up.body.data.avatarUrl;
  assert.match(url, /^\/api\/uploads\/[0-9a-f-]{36}\.png$/);
  assert.equal(fs.existsSync(diskOf(url)), true, '上传成功必须真的落盘');

  const row = await db.get('SELECT avatar_url FROM shops WHERE code = ?', TEST_SHOP_CODE);
  assert.equal(row.avatar_url, url);

  // 公开节点信息 + 店铺设置两处读到的必须是同一个 URL
  const info = await request(app).get('/api/shop').set('X-Mk-Shop', shopRef.value).expect(200);
  assert.equal(info.body.data.shop.avatarUrl, url);
  const inList = info.body.data.shops.find((s) => s.code === TEST_SHOP_CODE);
  assert.equal(inList.avatarUrl, url);
  const settings = await request(app)
    .get('/api/shop/settings')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.equal(settings.body.data.avatarUrl, url);

  // 换一张：旧头像不能继续占盘
  const up2 = await request(app)
    .post('/api/shop/avatar')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .set('Content-Type', 'image/png')
    .send(PNG)
    .expect(200);
  assertOk(up2);
  const url2 = up2.body.data.avatarUrl;
  assert.notEqual(url2, url);
  assert.equal(fs.existsSync(diskOf(url)), false, '替换后旧头像文件必须删除');
  assert.equal(fs.existsSync(diskOf(url2)), true);

  const del = await request(app)
    .delete('/api/shop/avatar')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.equal(del.body.data.avatarUrl, '');
  assert.equal(fs.existsSync(diskOf(url2)), false, '移除后头像文件必须删除');
});

test('节点头像：节点主可上传/移除，公开 DTO 带上；员工与买家不可改', async () => {
  const up = await request(app)
    .post('/api/shop/node/avatar')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('Content-Type', 'image/png')
    .send(PNG)
    .expect(200);
  assertOk(up);
  const url = up.body.data.avatarUrl;
  assert.match(url, /^\/api\/uploads\/[0-9a-f-]{36}\.png$/);

  const row = await db.get('SELECT avatar_url FROM node WHERE id = 1');
  assert.equal(row.avatar_url, url);
  const info = await request(app).get('/api/shop').expect(200);
  assert.equal(info.body.data.avatarUrl, url);
  const identity = await request(app).get('/api/shop/node-identity').expect(200);
  assert.equal(identity.body.data.avatarUrl, url);

  // 买家（非节点主）不能改
  await request(app)
    .post('/api/shop/node/avatar')
    .set('Authorization', `Bearer ${buyerToken}`)
    .set('Content-Type', 'image/png')
    .send(PNG)
    .expect(403);

  // 节点员工是 nodeAdmin 但不是节点主：节点身份也只归节点主
  const nodeStaff = Wallet.createRandom();
  await db.run('INSERT INTO node_staff (address) VALUES (?)', nodeStaff.address.toLowerCase());
  const nodeStaffToken = (await login(ctx, nodeStaff)).token;
  await request(app)
    .post('/api/shop/node/avatar')
    .set('Authorization', `Bearer ${nodeStaffToken}`)
    .set('Content-Type', 'image/png')
    .send(PNG)
    .expect(403);

  const del = await request(app)
    .delete('/api/shop/node/avatar')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(del.body.data.avatarUrl, '');
  assert.equal(fs.existsSync(diskOf(url)), false);
});

test('店铺头像只认店主：店员上传 403；非图片内容被拒', async () => {
  const staff = Wallet.createRandom();
  await db.run('INSERT INTO shop_operators (shop_code, address) VALUES (?, ?)', TEST_SHOP_CODE, staff.address.toLowerCase());
  const staffToken = (await login(ctx, staff)).token;
  await request(app)
    .post('/api/shop/avatar')
    .set('Authorization', `Bearer ${staffToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .set('Content-Type', 'image/png')
    .send(PNG)
    .expect(403);

  const bad = await request(app)
    .post('/api/shop/avatar')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('X-Mk-Shop', shopRef.value)
    .set('Content-Type', 'text/plain')
    .send(Buffer.from('not an image'))
    .expect(200);
  // 业务失败沿用本仓 HTTP 200 + code!=0 的形状（鉴权失败才是 403）
  assert.notEqual(bad.body.code, 0);
  assert.match(String(bad.body.message || ''), /头像只收/);
});
