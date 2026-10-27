/**
 * 节点公开读数的一致性：
 *
 *   ① **版本只有一份真相**：`/healthz`、`/api/shop`、`/api/shop/node-identity`
 *      以前各写一份 `'0.1.0'` 字面量。版本一升，漏改的那个接口会继续报旧版本——
 *      不报错、不崩溃，只是一句静默的假话。唯一真相是 `package.json`。
 *   ② **店名必填**：店名是店铺在目录里的身份，没有默认名可回退。
 *      空名一路进到 shops 行，买家在目录里就会看到一家没有名字的店。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';
import { makeCtx, login } from './setup.mjs';

// 必须在 makeCtx() 之前设——config 里是 import 期快照（见 setup.mjs 对 env 注入时机的说明）。
// 节点不读取 Registry；这里故意不设置任何目录环境变量，证明节点仍能完整提供公开读数。
const ctx = await makeCtx();
const { app, request } = ctx;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('版本只有一个真相（package.json）：三个公开读数都报它', async () => {
  const health = await request(app).get('/healthz').expect(200);
  const shop = await request(app).get('/api/shop').expect(200);
  const identity = await request(app).get('/api/shop/node-identity').expect(200);
  assert.equal(health.body.data.version, pkg.version, '/healthz 的 version 必须来自 package.json');
  assert.equal(shop.body.data.version, pkg.version, '/api/shop 的 version 必须来自 package.json');
  assert.equal(identity.body.data.version, pkg.version, '/api/shop/node-identity 的 version 必须来自 package.json');
});

test('node-identity 给出节点自己的身份参数（owner/escrow/staking/chainId），不含任何 Registry 字段', async () => {
  const r = await request(app).get('/api/shop/node-identity').expect(200);
  const d = r.body.data;
  // 测试环境两项合约地址都由 setup.mjs 注入（虚拟地址，只验证 DTO 形状与同源）
  assert.equal(d.owner, ctx.owner.address.toLowerCase());
  assert.match(String(d.escrowAddress).toLowerCase(), /^0x[0-9a-f]{40}$/);
  assert.match(String(d.stakingAddress).toLowerCase(), /^0x[0-9a-f]{40}$/);
  assert.equal('registryAddress' in d, false, '节点身份不得再暴露 Registry 字段');
  assert.equal(typeof d.chainId, 'number');
  assert.equal(d.canRegister, true, 'owner + escrow + staking 齐全时客户端才允许发起登记');
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
  assert.equal(good.body.data.status, 'pending');
});
