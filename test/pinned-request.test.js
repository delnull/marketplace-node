/**
 * 地址钉死（connection pinning）单测——**真实本地 HTTP 服务器**（node:http 监听 127.0.0.1 随机端口）。
 *
 * 为什么必须有这一层：webhook 投递的 SSRF 校验若只做到"解析出来的地址都是公网"，调用方随后
 * 交给 `fetch(url)` 时 fetch 会**自己再解析一次**——被控 DNS 第一次答公网、第二次答 127.0.0.1 /
 * 169.254.169.254，校验就被绕过（校验的地址 ≠ 连接的地址）。本文件用一个**解析不了的主机名**
 * （`*.invalid` 保证 NXDOMAIN）+ 钉住地址 127.0.0.1 发请求：请求必须成功到达本地服务器，
 * 这就证明连接目标来自"钉住的那批地址"，而不是又一次 DNS 解析。
 *
 * 覆盖：Host 头与 SNI 仍按原主机名、不跟随重定向（3xx 原样返回）、超时、无钉住地址时 fail-closed。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import { postPinned } from '../src/pinnedRequest.js';

/** 收到的请求（按序）+ 建立的 TCP 连接数（"一个连接都不许发出"类断言用） */
const received = [];
let connections = 0;
let listenPort = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (req.url.startsWith('/slow')) return; // 故意不应答：超时用例
    if (req.url.startsWith('/redirect')) {
      res.writeHead(302, { location: '/followed' });
      res.end('moved');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
server.on('connection', () => {
  connections += 1;
});

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  listenPort = server.address().port;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/** 主机名在 `.invalid` 下**必然解析不了**（RFC 2606 保留）——URL 用它，连得上就只可能是钉住生效 */
const hookUrl = (path = '/hook') => `http://pinned.invalid:${listenPort}${path}`;

test('前提自证：pinned.invalid 真的解析不了（否则本文件的"没有二次解析"断言不成立）', async () => {
  await assert.rejects(() => dns.promises.lookup('pinned.invalid'));
});

test('钉住地址：主机名解析不了，请求仍按钉住地址直达服务器（Host 头仍是原主机名）', async () => {
  received.length = 0;
  const body = JSON.stringify({ eventId: 'e-1', type: 'order.pool_empty', at: 1 });
  const res = await postPinned(hookUrl('/hook?x=1'), {
    headers: { 'content-type': 'application/json' },
    body,
    addresses: ['127.0.0.1'], // 校验通过的那批地址（生产里由 netguard 返回；本地服务器在回环上）
    timeoutMs: 2000,
  });
  assert.equal(res.status, 200, '必须真的到达本地服务器（若退化成 fetch(url) 会 ENOTFOUND）');
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/hook?x=1');
  assert.equal(received[0].body, body, '请求体原样送达');
  assert.equal(
    received[0].headers.host,
    `pinned.invalid:${listenPort}`,
    'Host 头是原主机名（含端口），不是钉住的 IP——钉的是"连到哪"，不是"以谁的名义请求"'
  );
});

test('没有已校验地址时拒绝发请求（fail-closed：零连接）', async () => {
  const before = connections;
  await assert.rejects(
    () => postPinned(hookUrl(), { addresses: [], body: '{}', timeoutMs: 1000 }),
    /缺少已校验的公网地址/
  );
  assert.equal(connections, before, '没有钉住地址就一个连接都不许建立');
});

test('不跟随重定向：3xx 原样作为状态码返回（Location 指向的地址不会被请求）', async () => {
  received.length = 0;
  const res = await postPinned(hookUrl('/redirect'), { addresses: ['127.0.0.1'], body: '{}', timeoutMs: 2000 });
  assert.equal(res.status, 302, '3xx 原样返回，由调用方判失败（语义与 fetch redirect:manual 一致）');
  assert.deepEqual(received.map((r) => r.url), ['/redirect'], '不得跟随到 /followed');
});

test('超时：到点销毁请求并抛错（不悬挂）', async () => {
  const t0 = Date.now();
  await assert.rejects(
    () => postPinned(hookUrl('/slow'), { addresses: ['127.0.0.1'], body: '{}', timeoutMs: 80 }),
    /请求超时/
  );
  assert.ok(Date.now() - t0 < 2000, '超时后立即失败，不等待服务器应答');
});

test('IPv6 钉住地址：URL 主机名的方括号被剥掉后交给 lookup（不退回系统解析器）', async () => {
  /*
    钉的是"IPv6 地址怎么传给 socket"这处易错点：URL 的 u.hostname 对 IPv6 带方括号
    （`http://[::1]:8080/`），直接喂给 net.connect/lookup 是非法主机名。这里服务器只监听
    127.0.0.1（不是 ::1），所以钉住 ::1 必须**失败**，且绝不能"悄悄回退到系统解析再连上 IPv4"。
  */
  const before = connections;
  await assert.rejects(() => postPinned(hookUrl('/hook'), { addresses: ['::1'], body: '{}', timeoutMs: 800 }));
  assert.equal(connections, before, '钉住 ::1 时不得回退到系统解析器（否则会连上 127.0.0.1 的服务器）');
});

/*
  `readBody`（2026-09 续新增，下单风控用）：默认丢弃响应体，只有显式要求时才读回来。
  为什么要分开：webhook 只关心状态码（店主接收端可能回体量不可控的 JSON），
  而下单风控必须读到 `{"allow":true}` 才能放行——两条路径的需求不同，默认值也不同（安全的一侧）。
*/
test('readBody：显式要求时才把响应体读回来（风控要读 {"allow":…}）', async () => {
  received.length = 0;
  const dropped = await postPinned(hookUrl('/hook'), { addresses: ['127.0.0.1'], body: '{}', timeoutMs: 2000 });
  assert.equal(dropped.body, undefined, '默认不读响应体（webhook 只看状态码）');

  const read = await postPinned(hookUrl('/hook'), {
    addresses: ['127.0.0.1'],
    body: '{}',
    timeoutMs: 2000,
    readBody: true,
  });
  assert.equal(read.status, 200);
  assert.equal(read.body, '{"ok":true}', '要求读体时必须拿到原文（调用方据此解析应答）');
  assert.equal(received.length, 2, '两次请求都真的发出去了');
});

test('readBody：响应体超过上限即停止累积（截断的 JSON 解析会失败 ⇒ 调用方 fail-closed 拒单）', async () => {
  // 服务器默认回 `{"ok":true}`（12 字节）；把上限压到 5 字节，模拟"对方回了一个超大响应"
  const res = await postPinned(hookUrl('/hook'), {
    addresses: ['127.0.0.1'],
    body: '{}',
    timeoutMs: 2000,
    readBody: true,
    maxBodyBytes: 5,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body, '{"ok"', '只保留上限内的字节（不把内存交给对方决定）');
  assert.throws(() => JSON.parse(res.body), '截断后必然解析失败——这正是 fail-closed 想要的');
});
