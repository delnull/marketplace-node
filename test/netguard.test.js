/**
 * 出站 HTTP 目标安全校验（SSRF 防护，2026-09 修复）单测：
 *  - IPv4/IPv6 字面量保留段判定（回环/私有/链路本地/云元数据/CGNAT/文档/组播/映射地址）；
 *  - 主机名解析（默认 node:dns；'localhost' 离线可解析为回环）命中保留段拒绝；
 *  - 协议/userinfo 校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIpv4, isPrivateIpv6, isPrivateIp, assertPublicHttpTarget, setLookupAll } from '../src/netguard.js';

test('IPv4 保留段判定', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateIpv4(ip), true, `${ip} 应判定为保留/内网`);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1']) {
    assert.equal(isPrivateIpv4(ip), false, `${ip} 应判定为公网`);
  }
  assert.equal(isPrivateIpv4('203.0.113.9'), true, 'TEST-NET-3 文档段按保留处理');
});

test('IPv6 保留段判定（含 IPv4 映射与 NAT64）', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '64:ff9b::1', '2001:db8::1']) {
    assert.equal(isPrivateIpv6(ip), true, `${ip} 应判定为保留/内网`);
  }
  /*
    链路本地是 fe80::/10，不是"以 fe80 开头"（源码评审 2026-09 修复）：
    fe80:: – febf:: 全段都不可达公网，旧写法漏掉 fe81..febf ⇒ 那些地址会被当成公网**放行**
    （店主自配的 webhook / 风控 URL 就能借它打到链路本地）。这里把整段的边界都钉住。
  */
  for (const ip of ['fe80::1', 'fe8f::1', 'fe90::1', 'fea0::1', 'feb0::1', 'febf::ffff']) {
    assert.equal(isPrivateIpv6(ip), true, `${ip} 属链路本地 fe80::/10，必须判定为内网`);
  }
  for (const ip of ['fec0::1']) {
    assert.equal(isPrivateIpv6(ip), true, `${ip} 是已废弃的站点本地 fec0::/10，仍按内网判`);
  }
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPrivateIpv6(ip), false, `${ip} 应判定为公网`);
  }
  /*
    **按数值段判、不按字符串形状判**（源码审计 2026-09 复审）：旧实现逐段匹配字符串前缀，
    下面这些"写法与规范化形式不同"的保留地址**全部漏网**并会被当成公网放行
    （它们会作为"已校验地址"进入 pinnedRequest 的连接，没有第二道校验）。
    实测当前主流系统不路由 ::/96 与 ::ffff:0:0/96，所以不是可利用的 SSRF，是纵深防御缺口——
    但判据与被判对象必须同一套表示，这条修完之后所有字面量写法自动归一。
  */
  for (const ip of [
    '::7f00:1', // ::127.0.0.1 的 URL 规范化形式（::/96 里内嵌回环）
    '::a9fe:a9fe', // ::169.254.169.254（云元数据的兼容形式）
    '::ffff:0:7f00:1', // ::ffff:0:127.0.0.1（IPv4 转译前缀）
    'ff02::1', // IPv6 全节点组播（IPv4 那边 a>=224 是拦的，这边此前完全没判）
    'ff05::1:3', // 站点本地组播
    '2002:a9fe:a9fe::1', // 6to4，内嵌 169.254.169.254
    '2002:7f00:1::1', // 6to4，内嵌 127.0.0.1
  ]) {
    assert.equal(isPrivateIpv6(ip), true, `${ip} 属保留/内网段，必须判定为内网（旧实现漏判）`);
  }
  // 6to4 里内嵌的是**公网** IPv4 时不算内网（判据要精确到内嵌值，不能一刀切封掉 2002::/16）
  assert.equal(isPrivateIpv6('2002:0808:0808::1'), false, '2002:8.8.8.8:: 内嵌公网地址，应放行');
});

test('expandIpv6：各种写法都能展开成 8 组，非法输入返回 null', async () => {
  const { expandIpv6 } = await import('../src/netguard.js');
  assert.deepEqual(expandIpv6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(expandIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIpv6('[::1]'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIpv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
  assert.deepEqual(expandIpv6('fe80::1%eth0'), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(
    expandIpv6('2001:4860:4860:0:0:0:0:8888'),
    [0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888]
  );
  for (const bad of ['', 'x::1', '1:2:3:4:5:6:7:8:9', '::1::2', 'fe80::1::2']) {
    assert.equal(expandIpv6(bad), null, `${JSON.stringify(bad)} 应判为非法`);
  }
});

test('isPrivateIp 通用入口（非法输入返回 null）', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('not-an-ip'), null);
});

test('字面量 URL：内网/链路本地/云元数据拒绝，公网放行', async () => {
  const bad = [
    'http://127.0.0.1:8545',
    'http://10.1.2.3/x',
    'http://172.16.5.5/',
    'http://192.168.0.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:8080/',
    'http://[fe80::1]/',
    'http://[::ffff:192.168.1.1]/',
  ];
  for (const url of bad) {
    const r = await assertPublicHttpTarget(url);
    assert.equal(r.ok, false, `${url} 应被拒绝`);
  }
  const okUrl = 'https://93.184.216.34/order';
  const ok = await assertPublicHttpTarget(okUrl);
  assert.equal(ok.ok, true);
  // 通过时必须返回"钉住地址"（2026-09：调用方据此把连接钉死，不再让 DNS 有第二次机会）
  assert.deepEqual(ok.addresses, ['93.184.216.34'], '字面量 IP 也返回自己作为钉住地址');
  assert.equal(ok.host, '93.184.216.34');
  assert.equal(ok.port, '');
  assert.equal(ok.protocol, 'https:');
});

test('协议/userinfo/解析校验', async () => {
  assert.equal((await assertPublicHttpTarget('ftp://93.184.216.34/')).ok, false);
  assert.equal((await assertPublicHttpTarget('https://user:pass@93.184.216.34/')).ok, false);
  assert.equal((await assertPublicHttpTarget('not a url')).ok, false);
  // localhost 解析到回环 → 拒绝（离线安全）
  assert.equal((await assertPublicHttpTarget('http://localhost:9000/')).ok, false);
  // 解析器注入：公网域名解析到内网（DNS rebinding 形态）→ 拒绝
  setLookupAll(async () => [{ address: '10.0.0.6' }]);
  assert.equal((await assertPublicHttpTarget('https://evil.example.com/')).ok, false);
  setLookupAll(async () => [{ address: '93.184.216.34' }]);
  assert.equal((await assertPublicHttpTarget('https://evil.example.com/')).ok, true);
  /*
    通过时返回的 addresses 就是**本次解析出来的那批**（多地址全给，含端口/协议原文）：
    调用方（pinnedRequest）只连这批地址——这正是"校验的地址 = 连接的地址"的凭据。
  */
  setLookupAll(async () => [{ address: '93.184.216.34' }, { address: '1.1.1.1' }]);
  const multi = await assertPublicHttpTarget('http://hook.example.com:8443/hook');
  assert.equal(multi.ok, true);
  assert.deepEqual(multi.addresses, ['93.184.216.34', '1.1.1.1'], '全部通过校验的地址都交出去');
  assert.equal(multi.host, 'hook.example.com');
  assert.equal(multi.port, '8443');
  assert.equal(multi.protocol, 'http:');
  setLookupAll(async () => {
    throw new Error('ENOTFOUND');
  });
  assert.equal((await assertPublicHttpTarget('https://nope.invalid/')).ok, false);
});
