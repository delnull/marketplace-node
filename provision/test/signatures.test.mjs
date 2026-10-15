/**
 * 四家的**签名算法**单测。
 *
 * 为什么这几条最值得先测：签名错了的表现是 `SignatureDoesNotMatch` / 401，
 * 看起来像"参数不对"，而参数明明是对的 —— 现场排查会往错的方向走半天。
 * 而签名是纯函数：给它确定的输入，输出必须逐字节一致。这里用各家文档里的用例与
 * 自算的期望值把三个算法钉住（阿里云 HMAC-SHA1、腾讯云 TC3、AWS SigV4）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import { percentEncode, signRpc } from '../providers/aliyun.mjs';
import { signTc3, sha256Hex as tencentSha } from '../providers/tencent.mjs';
import { signV4 } from '../providers/aws.mjs';

/* ── 阿里云：percentEncode 是签名错的头号原因 ─────────────────────────────── */
test('阿里云 percentEncode：空格是 %20、~ 不编码、* 编成 %2A', () => {
  // 这三条正是与 encodeURIComponent 的差别；用 + 或留着 ~ 都会 SignatureDoesNotMatch
  assert.equal(percentEncode('a b'), 'a%20b');
  assert.equal(percentEncode('~'), '~');
  assert.equal(percentEncode('*'), '%2A');
  assert.equal(percentEncode('/'), '%2F');
  assert.notEqual(percentEncode('a b'), 'a+b');
});

test('阿里云 RPC 签名：StringToSign 的分隔与 base64 结果可复算', () => {
  const params = { Action: 'DescribeRegions', Format: 'JSON', Version: '2014-05-26', AccessKeyId: 'testid' };
  const { canonical, signature } = signRpc({ params, secret: 'testsecret' });
  // canonical 必须按 key 字典序
  assert.equal(canonical, 'AccessKeyId=testid&Action=DescribeRegions&Format=JSON&Version=2014-05-26');
  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonical)}`;
  const expected = createHmac('sha1', 'testsecret&').update(stringToSign).digest('base64');
  assert.equal(signature, expected);
});

/* ── 腾讯云 TC3：日期必须 UTC、签的 header 固定两个 ───────────────────────── */
test('腾讯云 TC3：Authorization 的 Credential 用 UTC 日期（跨时区不会算错一天）', () => {
  // 2026-10-14T16:30:00Z 在 UTC+8 是 10-15 的 00:30 —— 本地日期会算成 20261015 而签错
  const ts = Math.floor(Date.parse('2026-10-14T16:30:00Z') / 1000);
  const auth = signTc3({ secretId: 'AKIDtest', secretKey: 'secret', service: 'cvm', host: 'cvm.tencentcloudapi.com', payload: '{}', timestamp: ts, action: 'DescribeRegions', version: '2017-03-12' });
  assert.match(auth, /^TC3-HMAC-SHA256 Credential=AKIDtest\/20261014\/cvm\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
});

test('腾讯云 TC3：同一个输入每次得到同一个签名（纯函数，不含时钟）', () => {
  const args = { secretId: 'id', secretKey: 'sk', service: 'cvm', host: 'cvm.tencentcloudapi.com', payload: '{"a":1}', timestamp: 1_700_000_000, action: 'X', version: '2017-03-12' };
  assert.equal(signTc3(args), signTc3(args));
  assert.equal(tencentSha('abc'), createHash('sha256').update('abc').digest('hex'));
});


/* ── AWS SigV4：header 名小写、payload 参与摘要 ───────────────────────────── */
test('AWS SigV4：Credential 是 AK/date/region/service/aws4_request，payload 进摘要', () => {
  const common = {
    method: 'POST',
    host: 'ec2.ap-southeast-1.amazonaws.com',
    path: '/',
    query: {},
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    region: 'ap-southeast-1',
    service: 'ec2',
    accessKeyId: 'AKIA_test',
    accessKeySecret: 'secret',
    now: new Date('2026-10-14T09:30:00Z'),
  };
  const a = signV4({ ...common, payload: 'Action=DescribeInstances&Version=2016-11-15' });
  const b = signV4({ ...common, payload: 'Action=RunInstances&Version=2016-11-15' });
  assert.match(a.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIA_test\/20261014\/ap-southeast-1\/ec2\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.notEqual(a.headers.authorization, b.headers.authorization);
  assert.equal(a.headers['x-amz-date'], '20261014T093000Z');
});

test('AWS SigV4：带 session token 时它必须进 SignedHeaders（否则 STS 临时凭据会被拒）', () => {
  const { signedHeaders } = signV4({
    method: 'POST',
    host: 'sts.amazonaws.com',
    path: '/',
    query: {},
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'Action=GetCallerIdentity&Version=2011-06-15',
    region: 'us-east-1',
    service: 'sts',
    accessKeyId: 'AK',
    accessKeySecret: 'SK',
    sessionToken: 'TOKEN',
    now: new Date('2026-10-14T09:30:00Z'),
  });
  assert.ok(signedHeaders.includes('x-amz-security-token'));
});