/**
 * 下单风控的**默认发送器**（`orderGate.pinnedGateSender`）端到端用例（2026-09 续）。
 *
 * 为什么单独一层：`checkOrderGate` 的既有用例全部用 `setOrderGateSender` 注入捕获型 sender
 * （单测禁网），因此**默认路径**（真实发请求那条）一直没有覆盖——而 DNS rebinding 的洞恰恰只在
 * 默认路径上。这里用真实本地 HTTP 服务器 + **解析不了的主机名**（`*.invalid`）+ 钉住地址
 * 127.0.0.1 发一次请求：能到达就证明"连的是校验过的那批地址"，而不是连接时又解析了一次。
 * 若把默认发送器改回 `fetch(url)`，本文件的用例会以 `getaddrinfo ENOTFOUND` 变红。
 *
 * 同时钉住风控专属的那半截需求：**必须把响应体读回来**（`{"allow":true}` 才放行），
 * 这与 webhook（只看状态码、默认丢体）不同。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pinnedGateSender } from '../src/orderGate.js';

let received = [];
let listenPort = 0;
let reply = '{"allow":true}';

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(reply);
  });
});

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  listenPort = server.address().port;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const gateUrl = (path = '/check') => `http://gate.invalid:${listenPort}${path}`;

test('默认发送器：主机名解析不了也按钉住地址直达（Host 头仍是原主机名）', async () => {
  received = [];
  const body = JSON.stringify({ event: 'order.gate', productSlug: 'x' });
  const res = await pinnedGateSender(gateUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    addresses: ['127.0.0.1'], // 生产里由 netguard 返回；本地服务器在回环上
    timeoutMs: 2000,
  });
  assert.equal(res.status, 200, '必须真的到达本地服务器（退化成 fetch 会 ENOTFOUND）');
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/check');
  assert.equal(received[0].body, body, '交易要素原样送达');
  assert.equal(received[0].host, `gate.invalid:${listenPort}`, 'Host 头是原主机名（钉的是 IP，不是身份）');
});

test('默认发送器：把响应体读回来并可通过 text()/json() 解析（风控要读 allow 字段）', async () => {
  received = [];
  reply = '{"allow":false,"reason":"本店不向该地区销售"}';
  const res = await pinnedGateSender(gateUrl(), { body: '{}', addresses: ['127.0.0.1'], timeoutMs: 2000 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.allow, false);
  assert.equal(data.reason, '本店不向该地区销售', '店主给的理由要能原样透传给买家');
  reply = '{"allow":true}';
});

test('默认发送器：没有已校验地址时拒绝发请求（fail-closed，不退回系统解析）', async () => {
  received = [];
  await assert.rejects(() => pinnedGateSender(gateUrl(), { body: '{}', addresses: [], timeoutMs: 1000 }), /缺少已校验/);
  assert.equal(received.length, 0, '一个请求都不许发出');
});
