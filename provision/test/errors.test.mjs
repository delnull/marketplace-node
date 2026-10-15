/**
 * 错误归类单测 —— 这一层决定"用户下一步该干什么"，所以每条映射都要钉住。
 *
 * 最要紧的一条：**账号没就绪（实名/风控）不能并进"没权限"**。
 * 两者给用户的处置完全相反（一个去控制台办实名，一个去改 RAM 策略），
 * 归错类会让人白折腾一圈，而这类错误的原始码在四家里长得都很像。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADVICE, classify, CloudError, describe, KIND } from '../lib/errors.mjs';

test('四家的"密钥无效"都归到 AUTH（同一个处置：换 key）', () => {
  assert.equal(classify('InvalidAccessKeyId.NotFound'), KIND.AUTH);
  assert.equal(classify('SignatureDoesNotMatch'), KIND.AUTH);
  assert.equal(classify('AuthFailure.SignatureFailure'), KIND.AUTH);
  assert.equal(classify('InvalidClientTokenId'), KIND.AUTH);
  assert.equal(classify('UnrecognizedClientException'), KIND.AUTH);
});

test('"没权限"归到 FORBIDDEN（处置是改策略），不归 AUTH', () => {
  assert.equal(classify('Forbidden.RAM'), KIND.FORBIDDEN);
  assert.equal(classify('NoPermission'), KIND.FORBIDDEN);
  assert.equal(classify('UnauthorizedOperation'), KIND.FORBIDDEN);
  assert.equal(classify('AccessDenied'), KIND.FORBIDDEN);
  assert.equal(classify('OptInRequired'), KIND.FORBIDDEN);
});

test('账号未实名/风控归到 ACCOUNT_NOT_READY（改策略解决不了）', () => {
  assert.equal(classify('RealNameAuthenticationError'), KIND.ACCOUNT_NOT_READY);
  assert.equal(classify('ResourceNotFound.ApprovedTemplateNotFound'), KIND.ACCOUNT_NOT_READY);
  assert.equal(classify('UnsupportedOperation.AccountRealName'), KIND.ACCOUNT_NOT_READY);
  assert.equal(classify('Forbidden.RiskControl'), KIND.ACCOUNT_NOT_READY);
  assert.notEqual(classify('RealNameAuthenticationError'), KIND.FORBIDDEN);
});

test('三家的"余额不足"都归到 INSUFFICIENT_BALANCE', () => {
  assert.equal(classify('InvalidAccountStatus.NotEnoughBalance'), KIND.INSUFFICIENT_BALANCE);
  assert.equal(classify('InvalidAccount.InsufficientBalance'), KIND.INSUFFICIENT_BALANCE);
  assert.equal(classify('Account.Arrearage'), KIND.INSUFFICIENT_BALANCE);
});

test('未识别的码落到 UNKNOWN（原样上抛，不猜）', () => {
  assert.equal(classify('SomethingBrandNew.Weird'), KIND.UNKNOWN);
  assert.equal(classify(''), KIND.UNKNOWN);
  assert.equal(classify(undefined), KIND.UNKNOWN);
});

test('没有码时按 HTTP 状态兜底：401→AUTH、403→FORBIDDEN、429→THROTTLED、503→UNAVAILABLE', () => {
  assert.equal(classify('', 401), KIND.AUTH);
  assert.equal(classify('', 403), KIND.FORBIDDEN);
  assert.equal(classify('', 429), KIND.THROTTLED);
  assert.equal(classify('', 503), KIND.UNAVAILABLE);
  assert.equal(classify('', 404), KIND.NOT_FOUND);
});

test('每一种 kind 都有一句可照做的处置（没有"未知处置"的空档）', () => {
  for (const kind of Object.values(KIND)) {
    assert.ok(ADVICE[kind], `${kind} 缺少处置建议`);
    assert.ok(ADVICE[kind].length > 5);
  }
});

test('describe() 把原始码与 requestId 一并带出（不然工单没法开）', () => {
  const e = new CloudError(KIND.INVALID, 'aliyun:RunInstances 失败', { code: 'OperationDenied.NoStock', requestId: 'RID-1' });
  const s = describe(e);
  assert.match(s, /OperationDenied\.NoStock/);
  assert.match(s, /RID-1/);
});

test('分类是按前缀匹配的：带后缀的细分码也能归对（如 Throttling.User）', () => {
  assert.equal(classify('Throttling.User'), KIND.THROTTLED);
  assert.equal(classify('InvalidParameterValue.InstanceType'), KIND.INVALID);
});
