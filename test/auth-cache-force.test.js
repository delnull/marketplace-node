/**
 * 鉴权缓存的两条边（2026-10-18）：
 *
 *  ① **写请求跳过缓存**：链上把员工移除之后，`staffNode` 的 15s 正缓存里还写着 `true`。
 *     写请求（POST/PUT/PATCH/DELETE）的中间件必须 force 重读——撤权不能有 15 秒的写窗口。
 *  ② **读请求仍吃缓存**：列表这类高频读不因为这条修复变成每请求一次链上调用
 *     （用 `setNodeStaffReader` 的调用计数断言）。
 *
 * 判据由 `http.makeAuthMiddleware` 的 `forceAuth` 与 `auth.roleOf`/`isNodeAdmin` 的 `{force}`
 * 共同承担；本文件通过真实 HTTP 请求覆盖这两条路径，而不是直接调 `roleOf`。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, owner } = ctx;
const staff = Wallet.createRandom();
const OWNER = owner.address.toLowerCase();
const STAFF = staff.address.toLowerCase();

const { setNodeStaffReader, invalidateNodeStaffCache } = await import('../src/chain.js');
/** true = 链上还是本节点员工（读取器模拟 `Registry.staffNode`） */
let staffOnChain = true;
let reads = 0;
setNodeStaffReader(async (addr) => {
  reads += 1;
  return addr === STAFF && staffOnChain ? OWNER : '';
});

let staffToken;
before(async () => {
  staffToken = (await login(ctx, staff)).token;
  // 登录回执会走一次 operatedShopCodes（读到员工名单）——计数从干净状态开始
  invalidateNodeStaffCache();
  reads = 0;
});

test('读请求命中员工缓存；写请求 force 重读 ⇒ 链上已移除的 staff 立刻 403', async () => {
  // 两笔读：第一笔读链，第二笔命中缓存（计数断言）
  assertOk(await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${staffToken}`).expect(200));
  assertOk(await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${staffToken}`).expect(200));
  assert.equal(reads, 1, '读请求必须命中 15s 员工缓存（不是每请求一次 RPC）');

  // 链上移除，但缓存里仍是 true：读请求照旧命中缓存
  staffOnChain = false;
  assertOk(await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${staffToken}`).expect(200));
  assert.equal(reads, 1, '缓存未过期时读请求不得重读链');

  // 写请求（PUT）必须 force：即使缓存里还是 true，也立刻 403
  const denied = await request(app)
    .put('/api/shop')
    .set('Authorization', `Bearer ${staffToken}`)
    .send({ name: '缓存撤权测试' })
    .expect(403);
  assert.notEqual(denied.body.code, 0);
  assert.equal(reads, 2, '写请求必须绕过缓存重读链上员工名单');

  // 负缓存 5s 内：读请求同样被拒（不会拿旧的 true 放行）
  await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${staffToken}`).expect(403);

  // 重新任命（链上恢复 + 手动失效缓存）后写请求恢复
  staffOnChain = true;
  invalidateNodeStaffCache();
  assertOk(
    await request(app)
      .put('/api/shop')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ name: '恢复后的店铺名' })
      .expect(200)
  );
  assert.equal(reads, 4, '写请求的两次判定（店铺选择 + 店铺角色）都 force 重读');
});

test('nodeAdmin 写请求同样 force：员工移除后 /node-staff/refresh 立刻 403', async () => {
  reads = 0;
  invalidateNodeStaffCache();
  // 先读一次节点资料（nodeAdmin 读）把"员工=true"写进缓存
  assertOk(await request(app).get('/api/shop/node').set('Authorization', `Bearer ${staffToken}`).expect(200));
  assert.equal(reads, 1);
  staffOnChain = false;
  // 写请求：nodeAdmin 中间件 force ⇒ 读链发现已移除 ⇒ 403（而非拿缓存放行并清缓存）
  await request(app).post('/api/shop/node-staff/refresh').set('Authorization', `Bearer ${staffToken}`).expect(403);
  assert.equal(reads, 2, 'nodeAdmin 写请求必须 force');
  staffOnChain = true;
  invalidateNodeStaffCache();
});
