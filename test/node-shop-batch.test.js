/**
 * 节点管理员批量暂停/恢复店铺接单。
 *
 * 判据：
 *   · 缺一家整批不执行（404），不会留下部分状态；
 *   · 全批存在时一次改完，公开目录同步消失/恢复；
 *   · 暂停必须给原因，已在目标状态计入 unchanged；
 *   · 非 nodeAdmin 不能调用；动作逐店留节点级审计。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, assertOk, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const secondCode = '0000TE274';
const batchPath = '/api/shops/admin/listing';

test('批量暂停/恢复：缺一家整批拒绝；全批存在时一次改完并同步公开目录', async () => {
  const secondSeller = '0x' + '11'.repeat(20);
  await db.run(
    `INSERT INTO shops (code, seller, name, notice, listed)
     VALUES (?, ?, ?, ?, 1)`,
    secondCode,
    secondSeller,
    '批量测试二号店',
    '',
    1
  );
  const accentCode = '0000TE37B';
  await db.run(
    `INSERT INTO shops (code, seller, name, notice, listed)
     VALUES (?, ?, ?, ?, 1)`,
    accentCode,
    '0x' + '22'.repeat(20),
    'Café 店',
    '',
    1
  );
  const token = (await login(ctx, owner)).token;
  const auth = { Authorization: `Bearer ${token}` };

  const noReason = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ codes: [shopRef.value, secondCode], listed: false });
  assert.equal(noReason.status, 400, '批量暂停同样必须给原因');

  const missing = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ codes: [shopRef.value, 'ZZZZZZZV4'], listed: false, reason: '批量测试' });
  assert.equal(missing.status, 404, '缺一家应整批拒绝');
  const stillListed = await request(app)
    .get('/api/shops/admin/all')
    .set(auth)
    .expect(200);
  for (const code of [shopRef.value, secondCode]) {
    const row = stillListed.body.data.shops.find((s) => s.code === code);
    assert.equal(row.listed, true, '整批拒绝时不能部分暂停');
  }

  const suspended = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ codes: [shopRef.value, secondCode], listed: false, reason: '批量违规' })
    .expect(200);
  assertOk(suspended);
  assert.deepEqual([...suspended.body.data.updated].sort(), [shopRef.value, secondCode].sort());
  assert.equal(suspended.body.data.unchanged, 0);

  const publicList = await request(app).get('/api/shops').expect(200);
  assert.equal(
    publicList.body.data.shops.some((s) => s.code === shopRef.value || s.code === secondCode),
    false,
    '批量暂停的店不能出现在公开目录'
  );

  const restored = await request(app)
    .patch(batchPath)
    .set(auth)
    .send({ codes: [shopRef.value, secondCode], listed: true })
    .expect(200);
  assertOk(restored);
  assert.deepEqual([...restored.body.data.updated].sort(), [shopRef.value, secondCode].sort());
  const searched = await request(app)
    .get('/api/shops/admin/all?q=批量测试二号')
    .set(auth)
    .expect(200);
  assert.deepEqual(
    searched.body.data.shops.map((s) => s.code),
    [secondCode],
    'q 按店名过滤；不能因搜索把别的店带回来'
  );
  const searchedByCode = await request(app)
    .get('/api/shops/admin/all?q=0000te27')
    .set(auth)
    .expect(200);
  assert.deepEqual(searchedByCode.body.data.shops.map((s) => s.code), [secondCode], 'q 按编号不区分大小写');
  const searchedBySeller = await request(app)
    .get(`/api/shops/admin/all?q=${secondSeller.toUpperCase()}`)
    .set(auth)
    .expect(200);
  assert.deepEqual(
    searchedBySeller.body.data.shops.map((s) => s.code),
    [secondCode],
    'q 也匹配店主地址且不区分大小写'
  );
  const searchedNone = await request(app)
    .get('/api/shops/admin/all?q=不存在-的-店')
    .set(auth)
    .expect(200);
  assert.deepEqual(searchedNone.body.data.shops, [], '无匹配返回空数组，不是全量');
  const searchedWildcard = await request(app)
    .get('/api/shops/admin/all?q=%25')
    .set(auth)
    .expect(200);
  assert.deepEqual(searchedWildcard.body.data.shops, [], 'LIKE 的 % 必须当字面量转义，不能匹配全量');
  const searchedAccent = await request(app)
    .get('/api/shops/admin/all?q=caf%C3%A9')
    .set(auth)
    .expect(200);
  assert.ok(
    searchedAccent.body.data.shops.some((s) => s.code === accentCode),
    'ngram 搜索忽略重音：Café 店必须能被 cafe 查到'
  );
  const publicAgain = await request(app).get('/api/shops').expect(200);
  for (const code of [shopRef.value, secondCode]) {
    assert.ok(
      publicAgain.body.data.shops.some((s) => s.code === code),
      '批量恢复后店铺应重新出现在公开目录'
    );
  }

  const audit = await db.get(
    "SELECT shop_code, detail FROM audit_logs WHERE action = 'shop.suspend' ORDER BY id DESC LIMIT 1"
  );
  assert.ok(audit, '批量暂停必须留审计');
  assert.equal(audit.shop_code, null, '店铺处置是节点级动作（shop_code 为 NULL）');
});

test('公开查询：地址是否能经营店铺（店主/店员，含歇业，只给布尔值）', async () => {
  const ownerAddr = owner.address.toLowerCase();
  const stranger = '0x' + '44'.repeat(20);
  const staffAddr = '0x' + '55'.repeat(20);
  let res = await request(app).get(`/api/shops?address=${ownerAddr}`).expect(200);
  assert.equal(res.body.data.hasOperatedShop, true, '节点主在本节点有店');
  assert.ok(res.body.data.shops.some((s) => s.code === shopRef.value), '公开列表里仍有这家在售店');

  res = await request(app).get(`/api/shops?address=${stranger}`).expect(200);
  assert.equal(res.body.data.hasOperatedShop, false, '陌生地址没有店');

  await db.run('INSERT INTO shop_operators (shop_code, address) VALUES (?, ?)', shopRef.value, staffAddr);
  res = await request(app).get(`/api/shops?address=${staffAddr}`).expect(200);
  assert.equal(res.body.data.hasOperatedShop, true, '店员也能经营这家店（自己不是 seller）');
  assert.equal(
    res.body.data.shops.some((s) => s.seller === staffAddr),
    false,
    '店员不是店主，不能从公开列表的 seller 推出来'
  );

  await request(app).get('/api/shops?address=not-an-address').expect(400);

  const token = (await login(ctx, owner)).token;
  const auth = { Authorization: `Bearer ${token}` };
  await request(app)
    .patch(`/api/shops/admin/${shopRef.value}/listing`)
    .set(auth)
    .send({ listed: false, reason: '测试歇业' })
    .expect(200);

  res = await request(app).get(`/api/shops?address=${ownerAddr}`).expect(200);
  assert.equal(res.body.data.hasOperatedShop, true, '歇业后仍应显示“有店”');
  assert.equal(
    res.body.data.shops.some((s) => s.code === shopRef.value),
    false,
    '歇业店不进公开列表'
  );
  res = await request(app).get(`/api/shops?address=${staffAddr}`).expect(200);
  assert.equal(res.body.data.hasOperatedShop, true, '歇业店的店员仍然算“能经营”');

  res = await request(app).get(`/api/shops?address=${stranger}`).set(auth).expect(200);
  assert.equal(res.body.data.hasOperatedShop, true, '有令牌时以令牌地址为准，不能被 query 换成别人');

  await request(app)
    .patch(`/api/shops/admin/${shopRef.value}/listing`)
    .set(auth)
    .send({ listed: true })
    .expect(200);
  await db.run('DELETE FROM shop_operators WHERE shop_code = ? AND address = ?', shopRef.value, staffAddr);
});

test('非节点管理员不能批量暂停店铺', async () => {
  const token = (await login(ctx, buyer)).token;
  const res = await request(app)
    .patch(batchPath)
    .set('Authorization', `Bearer ${token}`)
    .send({ codes: [shopRef.value], listed: false, reason: '越权尝试' });
  assert.equal(res.status, 403);
});

test('匿名地址查询限流：额度用完后只停归属回答，公开店铺列表照常返回', async () => {
  // 与路由里的 SHOP_QUERY_MAX_PER_WINDOW=600 对齐；前面用例已经消耗过几次额度。
  // 带一个**验不过的 Bearer**：限流若按“有没有 Authorization 头”放行，这里就永远到不了上限。
  let limited = false;
  for (let i = 0; i < 620; i += 1) {
    const res = await request(app)
      .get(`/api/shops?address=${owner.address.toLowerCase()}`)
      .set('Authorization', 'Bearer not-a-real-token');
    assert.equal(res.status, 200, '限流不能把公开目录打成 429/错误');
    if (res.body.data.hasOperatedShop === false) {
      limited = true;
      assert.equal(res.body.data.hasOperatedShopLimited, true, '额度用尽必须可观测');
      assert.ok(
        res.body.data.shops.some((s) => s.code === shopRef.value),
        '归属回答停了，公开店铺列表不能跟着消失'
      );
      break;
    }
  }
  assert.equal(limited, true, '匿名地址枚举必须被封顶');
});
