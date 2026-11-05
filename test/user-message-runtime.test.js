/**
 * **运行时**守卫（与 `user-text.test.js` 的源码扫描互补）：
 * 源码扫描只能看见字面量；这一条真的发请求，检查节点返回给用户的 `message` 是不是中文、
 * 有没有把机器标识符漏出去。第一版只覆盖不依赖业务数据的拒绝路径（401 / 参数非法），
 * 因为它们的文案最容易在重构里被顺手改回英文。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;

/** 与 `user-text.test.js` 同一份禁用词（只看用户消息，不看日志） */
const BANNED = [
  /\bEscrow\b/,
  /\bStaking\b/,
  /\bRegistry\b/,
  /\boperator\b/,
  /\bendpoint\b/,
  /\bRPC\b/,
  /\bABI\b/,
  /\bAPI\b/,
  /\btokenId\b/,
  /\bdecimals\b/,
  /\btxHash\b/,
  /\bchainId\b/,
  /\bwei\b/,
  /\bbps\b/,
  /\bgas\b/,
  /\bSettled\b/,
  /\bDisputed\b/,
  /\brefundStatus\b/,
  /\bshop_code\b/,
  /\bMK_[A-Z_]+\b/,
];

function assertUserMessage(res, label) {
  const msg = String(res.body?.message ?? '');
  assert.ok(msg.trim(), `${label}：响应里没有 message`);
  assert.match(msg, /[\u4e00-\u9fff]/, `${label}：message 必须是中文（实际：${msg}）`);
  for (const re of BANNED) {
    assert.ok(!re.test(msg), `${label}：message 含机器标识符 ${re}（实际：${msg}）`);
  }
}

test('运行时：未登录的 401 文案是中文，且不含机器标识符', async () => {
  const seller = await request(app).get('/api/orders/seller').expect(401);
  assertUserMessage(seller, '卖家列表未登录');
  const product = await request(app).post('/api/products').send({}).expect(401);
  assertUserMessage(product, '上架未登录');
});

test('运行时：参数非法的业务失败文案是中文，且不含机器标识符', async () => {
  const nonce = await request(app).get('/api/auth/nonce?address=not-an-address');
  assert.notEqual(nonce.body.code, 0);
  assertUserMessage(nonce, '登录地址非法');
});
