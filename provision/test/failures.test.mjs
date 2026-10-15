/**
 * 三个"会让人做错事"的失败路径（2026-10-15 审计 F1/F2/F3）。
 *
 * 共同形状：**失败被表达成了别的东西**——未导入的符号、没人读的状态字段、被吞掉的读取失败。
 * 各自的代价分别是：用户拿到 ReferenceError 而不是可照做的处置（且退出码方向错）、
 * destroy 之后 `up` 去复用一台已释放的机器、以及**真的去买一个账号里已经有的域名**。
 *
 * 这三条此前都没有判据：假云从不返回非 200（F1 的分支走不到）、
 * `releasedAt` 全仓零读取（F2 没有用例）、`listDomains().catch(() => [])`（F3 无人造过失败）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeCloud } from './fake-cloud.mjs';
import { setFetch, apiCall } from '../lib/http.mjs';
import { decideServer } from '../lib/resume.mjs';
import { KIND } from '../lib/errors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'cli.mjs');

/* ── F1：非 2xx 必须走分类层，而不是在 http 客户端里炸出一个未定义符号 ────────── */
test('非 2xx：错误必须是已分类的 CloudError（不是 ReferenceError）', async () => {
  setFetch(async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ Code: 'Forbidden', Message: '拒绝访问' }),
  }));
  try {
    const err = await apiCall({
      provider: 'aliyun',
      action: 'QueryDomainList',
      url: 'https://example.invalid/',
      method: 'POST',
      headers: {},
      body: '',
      attempts: 1, // 只试一次：本用例验的是"非 2xx 会被分类"，不是重试退避
    }).then(
      () => null,
      (e) => e
    );
    assert.ok(err, '非 2xx 必须抛错（不许静默返回空）');
    assert.notEqual(err.name, 'ReferenceError', `错误必须在分类层里产生，实际：${err.name}: ${err.message}`);
    assert.equal(err.name, 'CloudError', `应当是 CloudError，实际 ${err.name}`);
    assert.ok(
      Object.values(KIND).includes(err.kind),
      `kind 必须来自 errors.mjs 的码表（实际 ${JSON.stringify(err.kind)}）——退出码与重试退避都按它分叉`
    );
    assert.match(String(err.message), /403/, '错误消息里要有 HTTP 状态，排障第一眼要看它');
  } finally {
    setFetch(globalThis.fetch); // 恢复注入点（`setFetch(null)` 会让后续用例拿不到 fetch）
  }
});

/* ── F2：destroy 写下的 releasedAt 必须被"能不能复用"的判据读到 ──────────────── */
test('已释放的机器不得被续跑复用（releasedAt 有判据）', async () => {
  const st = {
    shop: 'demo',
    domain: 'shop.example.com',
    owner: '0x1111111111111111111111111111111111111111',
    server: { id: 'i-fake-1', name: 'mk-demo', region: 'cn-hangzhou', publicIp: '203.0.113.10', releasedAt: '2026-10-15T00:00:00.000Z' },
  };
  const picked = await decideServer({
    o: { provider: 'aliyun', domain: 'shop.example.com', region: 'cn-hangzhou', serverName: 'mk-demo' },
    existing: [],
    st,
    serverName: 'mk-demo',
    log: () => {},
  });
  assert.notEqual(
    picked.action,
    'reuse',
    'destroy 已经把机器释放了（状态里留着 releasedAt），续跑会对着死 IP 建解析并等 SSH 超时'
  );
  /*
    `--adopt` 必须仍然可达（它是"状态没写成"时的出口）：下面这条与上一条一起，
    把"releasedAt 被忽略"的两个后果都钉住——复用死机器、以及 adopt 被早返回挡掉。
  */
  const adopted = await decideServer({
    o: { provider: 'aliyun', adopt: 'i-fake-1', domain: 'shop.example.com', region: 'cn-hangzhou' },
    existing: [{ id: 'i-fake-1', name: 'mk-demo', status: 'Running', publicIp: '203.0.113.10' }],
    st,
    serverName: 'mk-demo',
    log: () => {},
  });
  assert.equal(adopted.action, 'adopt', '--adopt 必须能认领（它不该被"续跑"分支挡在后面）');
});

/* ── F4：AWS 的 NextToken 必须来自上一次响应，不是页号 ───────────────────────── */
test('AWS 列机器：第一次请求不许带 NextToken，后续只带服务商给的那个令牌', async () => {
  const aws = createFakeCloud({
    instanceTokenPages: true,
    servers: [
      { id: 'i-a', name: 'mk-a', status: 'running', publicIp: '203.0.113.1' },
      { id: 'i-b', name: 'mk-b', status: 'running', publicIp: '203.0.113.2' },
    ],
  });
  const base = await aws.listen();
  /*
    `PROVISION_API_BASE` 是**请求那一刻**读的（见 lib/http.mjs 的 withMockBase），
    所以这里设上就生效；不设的话请求会打到**真实 AWS**（凭据是假的 ⇒ 401 AuthFailure，
    现场看起来像"适配器坏了"，其实是用例忘了接假云）。
  */
  const prevBase = process.env.PROVISION_API_BASE;
  process.env.PROVISION_API_BASE = base;
  try {
    const { createAws } = await import('../providers/aws.mjs');
    const provider = createAws({ accessKeyId: 'AK', accessKeySecret: 'SK' });
    const list = await provider.listServers('ap-southeast-1');
    const descs = aws.state.calls.filter((c) => String(c.body || '').includes('Action=DescribeInstances'));
    assert.ok(descs.length >= 2, `应当翻到第二页（实际 ${descs.length} 次 DescribeInstances）`);
    assert.equal(
      /NextToken=1(&|$)/.test(String(descs[0].body)) || /NextToken=1(&|$)/.test(String(descs[1].body)),
      false,
      '页号被当成 NextToken 发了（第一次请求带 NextToken=1 ⇒ 真机上是 InvalidNextToken）'
    );
    assert.match(String(descs[1].body), /NextToken=tok-2/, '第二页必须带**服务商返回的**令牌');
    assert.equal(list.length, 2, '两页都要取到（漏页 ⇒ resume 判成"账号里没有同名机器"⇒ 再买一台）');
  } finally {
    if (prevBase === undefined) delete process.env.PROVISION_API_BASE;
    else process.env.PROVISION_API_BASE = prevBase;
    await aws.close();
  }
});

/* ── F9：解析区不能是 TLD（写进去的记录对域名永远不生效）──────────────────────── */
test('--zone com：必须当场拒绝，而不是把 A 记录写进 com 区', async () => {
  const { resolveZone } = await import('../lib/zone.mjs');
  // 合法形状照常放行（多标签记录名在 DNS 里是合法的：两边都是店主自己的名字）
  assert.equal(resolveZone({ domain: 'shop.example.com' }), 'example.com', '不显式给 zone 时推出可注册的那一级');
  assert.equal(resolveZone({ domain: 'shop.example.com', zone: 'example.com' }), 'example.com');
  assert.equal(resolveZone({ domain: 'a.b.example.com', zone: 'example.com' }), 'example.com', '多标签记录名合法，不许顺手收紧');
  assert.equal(resolveZone({ domain: 'shop.example.co.uk', zone: 'example.co.uk' }), 'example.co.uk', '公共后缀不是"取后两段"');
  // 非法形状：TLD 不是"可注册的那一级"
  assert.throws(
    () => resolveZone({ domain: 'shop.example.com', zone: 'com' }),
    (e) => {
      assert.match(e.message, /顶级域/);
      assert.match(e.message, /不属于你/, '要说清后果（记录建了也不生效），否则用户只会换个写法再试');
      assert.match(e.message, /--zone example\.com/, '要给出可照做的正确写法');
      return true;
    }
  );
  // 不是上级域名：原有判据照旧
  assert.throws(() => resolveZone({ domain: 'shop.example.com', zone: 'example.org' }), /不是 shop\.example\.com 的上级域名/);
});

/* ── F3：读不到域名列表时不许买（更不许把"读不到"当成"账号里没有"）────────────── */
let fake;
let apiBase;
before(async () => {
  fake = createFakeCloud({ queryDomainsFails: true, domains: ['example.com'] });
  apiBase = await fake.listen();
});
after(async () => {
  await fake.close();
});

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        PROVISION_API_BASE: apiBase,
        ALIYUN_ACCESS_KEY_ID: 'AK',
        ALIYUN_ACCESS_KEY_SECRET: 'SK',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('plan：读不到域名列表 ⇒ 说"读不到"并加 blocker，绝不给出"要加 --buy"的结论', async () => {
  const r = await runCli(['plan', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', '0x' + '1'.repeat(40), '--email', 'ops@example.com', '--buy', '--max-monthly', '100', '--max-domain-year', '100']);
  const out = r.stdout + r.stderr;
  assert.match(out, /读不到/, `必须如实说"读不到"（实际输出：${out.slice(0, 200)}）`);
  assert.doesNotMatch(out, /不在账号里/, '"读不到"与"账号里没有"是两件事，不许混');
  assert.doesNotMatch(out, /buy-domain/, '读数不可用时不许把"买域名"排进计划');
  assert.notEqual(r.code, 0, '有 blocker 的计划不该以成功退出');
});

test('up：读不到域名列表 ⇒ 一单都不下（尤其不许买一个账号里已有的域名）', async () => {
  const before = fake.state.calls.length;
  const r = await runCli(['up', '--provider', 'aliyun', '--domain', 'shop.example.com', '--buy', '--owner', '0x' + '1'.repeat(40), '--email', 'ops@example.com', '--max-monthly', '100', '--max-domain-year', '100']);
  const sent = fake.state.calls.slice(before).map((c) => String(c.body || ''));
  assert.equal(
    sent.some((b) => b.includes('SaveSingleTaskForCreatingOrderActivate')),
    false,
    '账号里已经有 example.com，却因为"读不到列表"发起了注册下单——这就是那条错额支出'
  );
  assert.notEqual(r.code, 0, '读不到域名列表时必须停下（不是"继续跑下去"）');
  assert.match(
    r.stdout + r.stderr,
    /读不到|无法判断/,
    `要让用户看懂停下了是因为"读数不可用"（实际：${(r.stdout + r.stderr).slice(0, 200)}）`
  );
});
