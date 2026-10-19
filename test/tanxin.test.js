/**
 * 谈信地址：形状校验（唯一入口 `src/tanxin.js`）+ 节点/店铺两条写入口的端到端行为。
 *
 * 判据只有三条：
 *   ① 两种合法写法（0x… 与 1…）**原样**落库并出现在公开 DTO 里（base58 不许被折小写）；
 *   ② 非法写法是 400，且不覆盖旧值；
 *   ③ 空串 = 清空（对外 null），不是“写进去一个空地址”。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOk, login, makeCtx, shopRef } from './setup.mjs';
import { parseTanxinAddress, TANXIN_ADDRESS_MAX } from '../src/tanxin.js';

const ctx = await makeCtx();
const { app, request, owner, buyer } = ctx;

const EVM = `0x${'a'.repeat(40)}`;
const EVM_CHECKSUM = `0x${'A'.repeat(40)}`;
const BTY_34 = '1Ji3W12KGScCM7C2p8bg635sNkayDM8MGY';
const BTY_33 = '1bgg6HwQretMiVcSWvayPRvVtwjyKfz1J';

test('形状校验：0x 与 1 开头两种都收，原样返回；空串是清空', () => {
  for (const v of [EVM, EVM_CHECKSUM, BTY_34, BTY_33]) {
    assert.deepEqual(parseTanxinAddress(v), { ok: true, value: v });
  }
  assert.deepEqual(parseTanxinAddress('  '), { ok: true, value: null });
  assert.deepEqual(parseTanxinAddress(`  ${BTY_34}  `), { ok: true, value: BTY_34 }, '允许首尾空白，但落库前去掉');
});

test('形状校验：明显不是地址的输入被拒', () => {
  for (const v of [
    '0x1234',
    `0x${'g'.repeat(40)}`,
    `3${BTY_34.slice(1)}`, // 只支持 1 开头
    `1${'0'.repeat(33)}`, // base58 不含 0
    `1${'I'.repeat(33)}`, // base58 不含 I
    `1${'a'.repeat(TANXIN_ADDRESS_MAX)}`,
  ]) {
    const r = parseTanxinAddress(v);
    assert.equal(r.ok, false, `应拒绝：${v}`);
    assert.match(r.error, /谈信地址/);
  }
});

test('公开节点信息：初始没有谈信地址', async () => {
  const res = await request(app).get('/api/shop').expect(200);
  assertOk(res);
  assert.equal(res.body.data.tanxinAddress, null);
  const registry = await request(app).get('/api/shop/registry-info').expect(200);
  assertOk(registry);
  assert.equal(registry.body.data.tanxinAddress, null);
});

test('节点主写入 0x 地址：公开读取、设置读取、节点运营读取三处一致', async () => {
  const { token } = await login(ctx, owner);
  const res = await request(app)
    .put('/api/shop/node')
    .set('Authorization', `Bearer ${token}`)
    .send({ tanxinAddress: EVM_CHECKSUM })
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.tanxinAddress, EVM_CHECKSUM, '校验和写法原样返回');

  const pub = await request(app).get('/api/shop').expect(200);
  assert.equal(pub.body.data.tanxinAddress, EVM_CHECKSUM);

  const registry = await request(app).get('/api/shop/registry-info').expect(200);
  assert.equal(registry.body.data.tanxinAddress, EVM_CHECKSUM);

  const admin = await request(app)
    .get('/api/shop/node')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assert.equal(admin.body.data.tanxinAddress, EVM_CHECKSUM);
});

test('节点主改写成 1 开头的 BTY 地址：大小写原样保留', async () => {
  const { token } = await login(ctx, owner);
  const res = await request(app)
    .put('/api/shop/node')
    .set('Authorization', `Bearer ${token}`)
    .send({ tanxinAddress: BTY_34 })
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.tanxinAddress, BTY_34);

  const pub = await request(app).get('/api/shop').expect(200);
  assert.equal(pub.body.data.tanxinAddress, BTY_34, 'base58 地址不许被折成小写');
});

test('非法值 400 且不覆盖旧值；空串清空成 null', async () => {
  const { token } = await login(ctx, owner);
  const bad = await request(app)
    .put('/api/shop/node')
    .set('Authorization', `Bearer ${token}`)
    .send({ tanxinAddress: '0xnot-an-address' })
    .expect(200);
  assert.notEqual(bad.body.code, 0);
  assert.match(String(bad.body.message), /谈信地址/);

  const still = await request(app).get('/api/shop').expect(200);
  assert.equal(still.body.data.tanxinAddress, BTY_34, '非法写入不能把旧地址冲掉');

  const cleared = await request(app)
    .put('/api/shop/node')
    .set('Authorization', `Bearer ${token}`)
    .send({ tanxinAddress: '' })
    .expect(200);
  assertOk(cleared);
  assert.equal(cleared.body.data.tanxinAddress, null);
  const after = await request(app).get('/api/shop').expect(200);
  assert.equal(after.body.data.tanxinAddress, null);
});

test('店铺写入：仅店主/店员可改，公开列表、店铺详情、设置三处同时可见', async () => {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .put('/api/shop')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .set('X-Mk-Shop', shopRef.value)
    .send({ tanxinAddress: BTY_33 })
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.tanxinAddress, BTY_33);

  const list = await request(app).get('/api/shops').expect(200);
  assertOk(list);
  assert.equal(list.body.data.shops.find((s) => s.code === shopRef.value)?.tanxinAddress, BTY_33);

  const detail = await request(app).get('/api/shop').set('X-Mk-Shop', shopRef.value).expect(200);
  assert.equal(detail.body.data.shop.tanxinAddress, BTY_33);

  const settings = await request(app)
    .get('/api/shop/settings')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.equal(settings.body.data.tanxinAddress, BTY_33);

  const buyerLogin = await login(ctx, buyer);
  await request(app)
    .put('/api/shop')
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .set('X-Mk-Shop', shopRef.value)
    .send({ tanxinAddress: EVM })
    .expect(403);
});

test('店铺清空：公开 DTO 回到 null', async () => {
  const { token } = await login(ctx, owner);
  const res = await request(app)
    .put('/api/shop')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Mk-Shop', shopRef.value)
    .send({ tanxinAddress: '' })
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.tanxinAddress, null);
  const detail = await request(app).get('/api/shop').set('X-Mk-Shop', shopRef.value).expect(200);
  assert.equal(detail.body.data.shop.tanxinAddress, null);
});
