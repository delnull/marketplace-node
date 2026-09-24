/**
 * 卖家订单检索 q（GET /api/orders/seller?q=，UX 审计 P2；复查 a9926e9 转义修复）：
 *  - 正例：按买家地址精确命中（大小写不敏感）、按商品标题子串命中、与其它行互斥正确；
 *  - 反例：q='%' 必须按字面量处理（ESCAPE 转义）——修复前命中全部订单；
 *    注：'_' 因快照 JSON 键自带下划线（price_cny_fen 等）无法作区分用例，故用 % 作判别；
 *  - 校验：空白 q / 超 200 字符 → code=1 业务拒绝（本项目业务错误统一 HTTP 200+code）；
 *  - 角色：仅 staff（owner/operator）可用，买家 HTTP 403。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const stranger = Wallet.createRandom();

const ctx = await makeCtx();
const { app, request, owner, buyer } = ctx;

let ownerToken;
let buyerToken;
let strangerToken;
let slugB; // 买家 stranger 下单（标题含下划线，作字面量辅助用例）
let orderIdA;
let slugC; // 买家 stranger 下单（标题含字面 %，作转义判别用例）

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  strangerToken = (await login(ctx, stranger)).token;
  assert.ok(ownerToken && buyerToken && strangerToken);

  const mk = async (title) => {
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(productPayload({ kind: 'physical', title, priceCnyFen: 8800 }))
      .expect(200);
    assertOk(res);
    return res.body.data.slug;
  };
  const slugA = await mk('专测甲：USB 数据线');
  slugB = await mk('专测乙_HDMI 转接头');
  slugC = await mk('专测丙：话费卡 100% 通用券');

  const oa = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: slugA })
    .expect(200);
  assertOk(oa);
  orderIdA = oa.body.data.id;
  for (const s of [slugB, slugC]) {
    const r = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ productSlug: s })
      .expect(200);
    assertOk(r);
  }
});

async function search(q, token = ownerToken) {
  const res = await request(app)
    .get(`/api/orders/seller?q=${encodeURIComponent(q)}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

test('q：买家地址精确命中；商品标题子串命中；无词 0 命中', async () => {
  const byAddr = await search(buyer.address.toLowerCase());
  assert.equal(byAddr.total, 1, 'buyer 地址精确命中其 1 单');
  assert.equal(byAddr.orders[0].id, orderIdA);

  const byAddrMixedCase = await search(buyer.address.toUpperCase());
  assert.equal(byAddrMixedCase.total, 1, '地址大小写不敏感（q 统一小写化）');

  const byTitle = await search('专测丙');
  assert.equal(byTitle.total, 1, '标题子串命中丙单');
  assert.ok(byTitle.orders[0].id !== orderIdA);

  const none = await search('不存在的商品词xyz');
  assert.equal(none.total, 0);
});

test('q：% 通配符按字面量处理——仅命中标题含字面 % 的丙单（修复前命中全部 3 单）', async () => {
  const all = await request(app).get('/api/orders/seller').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.ok(all.body.data.total >= 3, '本文件至少存在 3 张草稿单');

  const pct = await search('%');
  assert.equal(pct.total, 1, "q='%' 只命中含字面 % 的丙单——修复前命中全部");
  assert.equal(pct.orders[0].productSlug, slugC);

  const full = await search('100%');
  assert.equal(full.total, 1, 'q=100% 字面命中丙单');

  // 转义符本身不特殊：q='\\' 不命中（SQLite 无 ESCAPE 子句时反斜杠本为普通字符，转义后仍普通）
  const bs = await search('\\');
  assert.equal(bs.total, 0);

  // 下划线按字面参与检索：q='乙_HDMI' 精确命中乙单（若无转义，'_' 通配任意单字符
  // 会同时命中「乙XHDMI」形态——此处乙/丙单标题仅乙单含该片段，断言仍为 1）
  const usWord = await search('乙_HDMI');
  assert.equal(usWord.total, 1, '标题含下划线片段按字面命中乙单');
  assert.equal(usWord.orders[0].productSlug, slugB);
});

test('q：空白拒绝、超 200 字符拒绝（业务错误 code=1）；买家调用 HTTP 403', async () => {
  const blank = await request(app).get('/api/orders/seller?q=%20%20').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.equal(blank.body.code, 1, '空白 q 业务拒绝');
  const long = await request(app)
    .get('/api/orders/seller?q=' + encodeURIComponent('长'.repeat(201)))
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(long.body.code, 1, '超长 q 业务拒绝');
  await request(app).get('/api/orders/seller?q=usb').set('Authorization', `Bearer ${buyerToken}`).expect(403);
});
