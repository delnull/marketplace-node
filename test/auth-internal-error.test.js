/**
 * 鉴权失败的**分层**（P3-3）：
 *   · 令牌本身无效/过期 ⇒ 401（用户能自力修复：重新登录）；
 *   · 角色判定依赖（DB 池/链上读数）失败 ⇒ 503 + 通用文案（内部字符串只进服务端日志）。
 *
 * 旧实现把 `makeAuthMiddleware` 的整个 try 折成 `401 + e.message`：一次 DB 连接池超时
 * 会被说成"未登录"，还把 `pool timeout: acquire …` 原样回给客户端（生产泄露内部结构）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, login, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, buyer } = ctx;

let buyerToken;
before(async () => {
  buyerToken = (await login(ctx, buyer)).token;
});

test('令牌无效 ⇒ 401（可读的"重新登录"，不是内部错误）', async () => {
  const res = await request(app)
    .get('/api/orders/seller')
    .set('Authorization', 'Bearer not-a-token')
    .set('X-Mk-Shop', shopRef.value)
    .expect(401);
  assert.equal(res.body.code, 401);
  assert.match(String(res.body.message), /令牌无效|重新登录/);
});

test('角色判定的 DB 读失败 ⇒ 503 + 通用文案；内部原文不进响应', async () => {
  const origGet = db.get.bind(db);
  db.get = async () => {
    throw new Error('pool timeout: acquire connection from marketplace_node');
  };
  let res;
  try {
    res = await request(app)
      .get('/api/orders/seller')
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('X-Mk-Shop', shopRef.value);
  } finally {
    db.get = origGet;
  }
  assert.equal(res.status, 503, '服务端依赖失败不是 401');
  assert.equal(res.body.code, 503);
  assert.match(String(res.body.message), /鉴权服务暂时不可用|稍后重试/);
  assert.doesNotMatch(String(res.body.message), /pool timeout|marketplace_node/, '不得回泄漏内部字符串');
});

test('无请求头时的店铺清单读失败同样 503（不是"你没有店铺"403）', async () => {
  const origAll = db.all.bind(db);
  db.all = async () => {
    throw new Error('connect ETIMEDOUT 10.0.0.9:3306');
  };
  let res;
  try {
    res = await request(app)
      .get('/api/orders/seller')
      .set('Authorization', `Bearer ${buyerToken}`);
  } finally {
    db.all = origAll;
  }
  assert.equal(res.status, 503);
  assert.doesNotMatch(String(res.body.message), /ETIMEDOUT|10\.0\.0\.9/);
});
