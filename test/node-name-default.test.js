/**
 * 节点名 ≠ 店铺名：两者的默认值不许共用。
 *
 * 症状（2026-10-20 手工部署实测）：新节点的 `/healthz` 报 `"name":"我的联邦小店"`——
 * 那是**店铺**的默认名。节点与店铺是两个实体（一节点多店），共用默认值的结果是
 * 联邦目录里每个没设置过名字的节点都印着同一句话，而且把"节点"说成了"店"。
 *
 * 判据：
 *   ① 有对外域名时节点默认名 = 域名（与 SIWE 身份同源）；没有域名时用中性占位；
 *   ② 店铺没有默认名（写入口拒绝空名），不被节点默认名影响；
 *   ③ 三个公开读数（/healthz、/api/shop、/api/shop/node-identity）取到同一个节点名。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

// makeCtx() 会先注入 MK_SHOP_OWNER 等环境变量再加载 db/config（config 里是快照），
// 所以它必须排在动态 import 之前——顶层 import 会让 config 在环境变量还没注入时就被求值。
const ctx = await makeCtx();
const { nodeDisplayName, shopDisplayName } = await import('../src/shops.js');
const { DEFAULT_NODE_NAME } = await import('../src/config.js');

const DOMAIN_ENV = ['MK_SIWE_DOMAIN', 'MK_REGISTER_ENDPOINT'];
const clearDomainEnv = () => {
  for (const k of DOMAIN_ENV) delete process.env[k];
};

test('节点默认名：有域名取域名、没有域名用中性占位；店铺默认名不受影响', () => {
  clearDomainEnv();

  // ① 没有域名：节点用中性占位；店名没有默认占位（写入口拒绝空名）
  assert.equal(shopDisplayName({ name: '' }), '', '店名不再回退到"我的联邦小店"式占位');
  assert.equal(nodeDisplayName({ name: '' }), DEFAULT_NODE_NAME);
  assert.notEqual(nodeDisplayName({ name: '' }), '我的联邦小店', '节点默认名不能是店铺式占位');

  // ② 有域名：取域名（与 SIWE 身份同源）；带协议、带结尾斜杠都能解析
  process.env.MK_SIWE_DOMAIN = 'https://lingsui.cc/';
  assert.equal(nodeDisplayName({ name: '' }), 'lingsui.cc');
  assert.equal(nodeDisplayName({}), 'lingsui.cc');

  // ③ 两档的优先级：MK_SIWE_DOMAIN 在前；也可写 host[:port]
  delete process.env.MK_SIWE_DOMAIN;
  process.env.MK_REGISTER_ENDPOINT = 'shop.example.com:8443';
  assert.equal(nodeDisplayName({}), 'shop.example.com:8443');
  process.env.MK_SIWE_DOMAIN = 'lingsui.cc';
  assert.equal(nodeDisplayName({}), 'lingsui.cc');

  // ④ 显式设置的节点名优先于任何默认
  assert.equal(nodeDisplayName({ name: '我的节点' }), '我的节点');

  // ⑤ 解析不了的域名不编造：回到中性占位
  process.env.MK_SIWE_DOMAIN = 'not a domain';
  delete process.env.MK_REGISTER_ENDPOINT;
  assert.equal(nodeDisplayName({}), DEFAULT_NODE_NAME);

  clearDomainEnv();
});

test('三个公开读数用同一个节点名（域名），且不借用店铺默认名', async () => {
  clearDomainEnv();
  process.env.MK_SIWE_DOMAIN = 'https://lingsui.cc';

  const health = await ctx.request(ctx.app).get('/healthz').expect(200);
  const shop = await ctx.request(ctx.app).get('/api/shop').expect(200);
  const registry = await ctx.request(ctx.app).get('/api/shop/node-identity').expect(200);

  assert.equal(health.body.data.name, 'lingsui.cc', '/healthz 的 name 是节点名（默认取域名）');
  assert.equal(shop.body.data.name, 'lingsui.cc', '/api/shop 的顶层 name 是节点名');
  assert.equal(registry.body.data.name, 'lingsui.cc', '/api/shop/node-identity 的 name 是节点名');
  for (const body of [health.body.data, shop.body.data, registry.body.data]) {
    assert.notEqual(body.name, '我的联邦小店', '节点读数里不许再出现店铺式占位名');
  }

  clearDomainEnv();
});
