/**
 * 节点公开读数的一致性（2026-10-20 手工部署后审计的三个"不对"）：
 *
 *   ① **版本只有一份真相**：`/healthz`、`/api/shop`、`/api/shop/registry-info`
 *      以前各写一份 `'0.1.0'` 字面量。版本一升，漏改的那个接口会继续报旧版本——
 *      不报错、不崩溃，只是一句静默的假话。唯一真相是 `package.json`。
 *   ② **店名必填**：店名是店铺在联邦目录里的身份，没有默认名可回退。
 *      空名一路进到 shops 行，买家在目录里就会看到一家没有名字的店。
 *   ③ **店铺家数只数在营店**：店主退出后那一行留成墓碑（`exited_at_block > 0`），
 *      它不是"现在还挂在名下的店"；把它算进 total，节点主面板上的家数会比实际多。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';
import { makeCtx, login } from './setup.mjs';

// 开店申请的前置：本节点必须配了 Registry（否则路由在"店名"之前就拒绝）。
// 必须在 makeCtx() 之前设——config 里是 import 期快照（见 setup.mjs 对 env 注入时机的说明）。
process.env.MK_REGISTRY_ADDRESS = '0x000000000000000000000000000000000000dEaD';

const ctx = await makeCtx();
const { app, request, db } = ctx;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('版本只有一个真相（package.json）：三个公开读数都报它', async () => {
  const health = await request(app).get('/healthz').expect(200);
  const shop = await request(app).get('/api/shop').expect(200);
  const registry = await request(app).get('/api/shop/registry-info').expect(200);
  assert.equal(health.body.data.version, pkg.version, '/healthz 的 version 必须来自 package.json');
  assert.equal(shop.body.data.version, pkg.version, '/api/shop 的 version 必须来自 package.json');
  assert.equal(registry.body.data.version, pkg.version, '/api/shop/registry-info 的 version 必须来自 package.json');
});

test('开店申请：店名必填（空名/纯空白被拒），填了才落库', async () => {
  const seller = Wallet.createRandom();
  const { token } = await login(ctx, seller);
  // 业务失败按本仓口径是 HTTP 200 + code!=0（见 http.js 的 fail）
  const bad = await request(app)
    .post('/api/shops/applications')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: '   ', notice: '' })
    .expect(200);
  assert.notEqual(bad.body.code, 0, '空店名必须被拒绝（不能靠展示默认名兜底）');
  assert.match(bad.body.message, /店名不能为空/, '拒绝理由要说清是店名');

  const good = await request(app)
    .post('/api/shops/applications')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: '测试小店', notice: '' })
    .expect(200);
  assert.equal(good.body.data.name, '测试小店');
});

test('健康检查的店铺家数只数在营店：已退出的墓碑行不算', async () => {
  const readCounts = async () => (await request(app).get('/healthz').expect(200)).body.data.shops;
  const before = await readCounts();
  const seller = Wallet.createRandom().address.toLowerCase();
  await db.run(
    `INSERT INTO shops (code, seller, name, listed, commission_bps, exited_at_block)
     VALUES (?, ?, ?, 0, 0, 12345)`,
    '0000TOMB1',
    seller,
    '已退出的店'
  );
  try {
    const after = await readCounts();
    assert.equal(after.total, before.total, '墓碑行（exited_at_block > 0）不该算进"名下店铺"');
    assert.equal(after.listed, before.listed, '它同样不在售');
  } finally {
    await db.run('DELETE FROM shops WHERE code = ?', '0000TOMB1');
  }
});
