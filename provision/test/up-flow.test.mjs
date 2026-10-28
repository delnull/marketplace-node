/**
 * 端到端编排测试：**用假云把 `up()` 整条跑完一遍**。
 *
 * 这里验的不是"函数被调用了"，而是四个真正会出事的判据：
 *   1. **不会被重复购买**：同一个店铺跑第二次不许再开机器、再买域名；
 *   2. **闸门在花钱之前**：预算不够时，一条创建请求都不许发出去；
 *   3. **域名不在账号里、又没 --buy 时**必须停下并说清出路（而不是买一个或假装成功）；
 *   4. **远端执行的正是店主脚本**：`deploy.sh --tls-mode caddy --domain … --owner …`（含 CORS/证书那两步的前提）。
 *
 * 假云按四家官方文档的响应形状回话（test/fake-cloud.mjs），所以适配器的解析路径也一并被跑到。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

import { createFakeCloud } from './fake-cloud.mjs';
import { createAliyun } from '../providers/aliyun.mjs';
import { loadState } from '../lib/state.mjs';

const OWNER = '0x66681e2889242FF0739A88879fa66890B8C7dA45';
const DOMAIN = 'shop.example.com';
// 注册商只列可注册的那一级：账号里拥有 example.com 才是真的拥有，节点挂在 shop 子域上
const ZONE = 'example.com';

let cloud;
let apiBase;
let healthServer;
let healthBase;
/** 临时"仓库"：只有 git 与 node/ 两个文件，`git archive HEAD:node` 能跑通就好 */
let repoRoot;
/** 远端执行记录：把编排层真正发到服务器上的命令抓下来断言 */
let sshCalls;

before(async () => {
  cloud = createFakeCloud();
  apiBase = await cloud.listen();
  process.env.PROVISION_API_BASE = apiBase;

  // 公网验收：本地起一个"节点"，返回真实的 /healthz 形状
  healthServer = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { escrowAddress: '0x9c2cdf4079b499b8537da47ed9488966efa2531c', owner: OWNER, watcher: { cursor: 1 } } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => healthServer.listen(0, '127.0.0.1', r));
  healthBase = `http://127.0.0.1:${healthServer.address().port}`;
  process.env.PROVISION_HEALTH_BASE = healthBase;

  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-prov-'));
  fs.mkdirSync(path.join(repoRoot, 'node'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'node', 'deploy.sh'), '#!/usr/bin/env bash\necho fake deploy\n');
  fs.writeFileSync(path.join(repoRoot, 'node', 'package.json'), '{"name":"marketplace-node"}');
  const git = (...args) => spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

after(async () => {
  await cloud.close();
  await new Promise((r) => healthServer.close(r));
  delete process.env.PROVISION_API_BASE;
  delete process.env.PROVISION_HEALTH_BASE;
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例从干净的账号状态开始：只保留"已有一个域名"这一条，避免用例之间互相影响
  cloud.state.servers = [];
  cloud.state.domains = [ZONE];
  cloud.state.templates = [{ id: 'tmpl-ok-1', status: 'SUCCEED', emailVerified: true, valid: true }];
  cloud.state.describeInstancesCalls = 0;
  cloud.state.zoneRecords = new Map();
  cloud.state.zones = new Map([['example.com', { id: 'd-example.com', nameservers: ['ns1.alidns.com'] }]]);
  cloud.state.calls = [];
  cloud.state.balance = 5000;
  cloud.state.domainOrder = null;
  sshCalls = [];
  fs.rmSync(path.join(repoRoot, '.provision'), { recursive: true, force: true });
});

/** 注入的外部世界：SSH / 打包之外的东西全在这里被替掉，测试不碰网络也不碰真机器 */
function makeIo() {
  return {
    // 与真 generateSshKey 同一形状：(keyPath, { type }) —— 注入点不是"另一套接口"
    generateSshKey: (keyPath) => {
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, 'FAKE PRIVATE KEY', { mode: 0o600 });
      fs.writeFileSync(`${keyPath}.pub`, 'ssh-rsa AAAAfake marketplace-provision\n');
      return { keyPath, publicKey: 'ssh-rsa AAAAfake marketplace-provision' };
    },
    probe: () => true,
    upload: (a) => sshCalls.push({ kind: 'upload', ...a }),
    runScript: (a) => {
      sshCalls.push({ kind: 'runScript', script: a.script });
      return { status: 0, stdout: '', stderr: '' };
    },
    run: (a) => {
      sshCalls.push({ kind: 'run', command: a.command });
      return { status: 0, out: '{"code":0}' };
    },
  };
}

const baseOptions = (over = {}) => ({
  shop: 'default',
  provider: 'aliyun',
  region: 'cn-hongkong',
  domain: DOMAIN,
  owner: OWNER,
  email: 'me@example.com',
  maxMonthly: 200,
  maxDomainYear: 200,
  years: 1,
  sshUser: 'root',
  sshKeyType: 'rsa',
  installDir: '/opt/marketplace-node',
  serverName: 'marketplace-node',
  rev: 'HEAD',
  ...over,
});

const logs = [];
const log = (m) => logs.push(m);

/**
 * 把"等"的节拍压到 0：被验证的是**等的是哪一个外部事实**，不是等多久。
 * （真跑时是 10 秒一次、最长几分钟；测试里 DNS/机器/证书都立刻满足。）
 */
const fastWait = {
  pollMs: 1,
  sshPollMs: 1,
  dnsPollMs: 1,
  httpsPollMs: 1,
  domainTaskPollMs: 1,
  timeoutMs: { server: 3000, ssh: 3000, dns: 3000, https: 3000 },
  resolve4: async () => ['203.0.113.10'],
};

/* ── ① 完整走通 ───────────────────────────────────────────────────────────── */
test('一条流程走完：装好节点、拿到 endpoint、状态落盘', async () => {
  const { up } = await import('../lib/up.mjs');
  logs.length = 0;
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  const out = await up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait });

  assert.equal(out.ok, true);
  assert.equal(out.host, '203.0.113.10');
  assert.match(out.endpoint, /^https:\/\/shop\.example\.com$/);

  // 远端跑的是店主脚本，且带上 Caddy（HTTPS）+ 域名 + 店主地址
  const deploy = sshCalls.find((c) => c.kind === 'runScript');
  assert.ok(deploy, '应该执行了远端部署脚本');
  assert.match(deploy.script, /bash deploy\.sh/);
  assert.match(deploy.script, /--tls-mode caddy/);
  assert.match(deploy.script, /--domain 'shop\.example\.com'/);
  assert.match(deploy.script, new RegExp(`--owner '${OWNER}'`));
  assert.doesNotMatch(deploy.script, /--no-register/); // deploy.sh 没有链上登记步骤
  // 上传的是 git archive 出来的包（内容来自提交，不是工作区）
  assert.ok(sshCalls.some((c) => c.kind === 'upload' && /node-[0-9a-f]+\.tgz$/.test(c.local)));

  // 状态文件记下了后续 destroy/verify 需要的一切
  const st = loadState(repoRoot, 'default');
  assert.equal(st.server.id, 'i-fake-1');
  assert.equal(st.server.publicIp, '203.0.113.10');
  assert.equal(st.dns.recordId, 'rec-1');
  assert.equal(st.node.tlsMode, 'caddy');
  assert.equal(st.domainPurchase.bought, false);
  assert.equal(st.verified.httpsOk, true);
  // A 记录真的写进去了
  assert.equal(cloud.state.zoneRecords.get('example.com/shop'), '203.0.113.10');
});

/* ── ② 第二次跑：不许重复购买 ─────────────────────────────────────────────── */
test('同一个店铺再跑一次：复用机器与域名，不再下单', async () => {
  const { up } = await import('../lib/up.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait });
  const callsAfterFirst = cloud.state.calls.length;

  logs.length = 0;
  const out2 = await up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait });
  const newCalls = cloud.state.calls.slice(callsAfterFirst);
  const runInstances = newCalls.filter((c) => /Action=RunInstances/.test(c.body));
  assert.equal(runInstances.length, 0, '第二次跑不该再开机器');
  assert.equal(out2.host, '203.0.113.10');
  assert.ok(logs.some((l) => l.includes('机器已有')), '应该明说在复用已有机器');
});

/* ── ③ 闸门在花钱之前 ─────────────────────────────────────────────────────── */
test('预算不够：一条创建请求都不许发出去', async () => {
  const { up } = await import('../lib/up.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  // 机器询价 0.08 元/小时 × 730 ≈ 58.4 元/月，给 10 元/月的授权必然超
  await assert.rejects(
    () => up({ provider, options: baseOptions({ maxMonthly: 10 }), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.equal(e.kind, 'invalid');
      assert.match(e.message, /预算闸门/);
      assert.match(e.message, /--max-monthly/);
      return true;
    }
  );
  const created = cloud.state.calls.filter((c) => /Action=(RunInstances|CreateSecurityGroup|ImportKeyPair)/.test(c.body));
  assert.equal(created.length, 0, '被闸门拦下时不许有任何创建动作');
  assert.equal(loadState(repoRoot, 'default')?.server ?? null, null, '不许留下"已下单"的状态');
});

/* ── ④ 域名不在账号里：要么买、要么停 ─────────────────────────────────────── */
test('域名不在账号里且没 --buy：停下并给出两条出路', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.domains = []; // 账号里没有这个域名
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /不在这个账号的域名列表里/);
      assert.match(e.message, /--buy/);
      assert.match(e.message, /--domain/);
      return true;
    }
  );
  assert.equal(cloud.state.domainOrder, null, '没授权就不许下单买域名');
});

test('--buy 且账号没就绪（没有实名模板）：在花钱之前拒绝，并说清缺什么', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.domains = [];
  cloud.state.templates = []; // 账号里一个已认证的模板都没有
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions({ buy: true, priceDomain: 70, maxMonthly: 100 }), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.equal(e.kind, 'account_not_ready');
      assert.match(e.message, /信息模板/);
      return true;
    }
  );
  assert.equal(cloud.state.domainOrder, null);
});

test('--buy 且账号就绪：按闸门买下域名，并把模板带进下单请求', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.domains = [];
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  const out = await up({ provider, options: baseOptions({ buy: true, priceDomain: 70, maxMonthly: 100 }), repoRoot, log, io: makeIo(), wait: fastWait });
  assert.equal(out.ok, true);
  assert.equal(cloud.state.domainOrder.domain, DOMAIN);
  assert.equal(cloud.state.domainOrder.templateId, 'tmpl-ok-1');
  const st = loadState(repoRoot, 'default');
  assert.equal(st.domainPurchase.bought, true);
  assert.equal(st.domainPurchase.taskId, 'task-1');
});

/*
  ── "读不到任务状态" ≠ "任务结束"（2026-10-15 审计 F7）──────────────────────
  旧实现 `.catch(() => null)` + `if (!t) break;`：一次读失败就**静默跳出**注册状态轮询，
  而屏幕最后一行还是「已提交注册任务」——用户以为流程走完了，真相是状态一次都没读到
  （钱已经花了，所以不改流程，只把两种情形分开说）。
*/
test('域名注册状态读不到：明说"无法确认"（不静默跳出、也不谎报成功）', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.domains = [];
  cloud.state.domainTaskFails = true;
  logs.length = 0;
  try {
    const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
    const out = await up({ provider, options: baseOptions({ buy: true, priceDomain: 70, maxMonthly: 100 }), repoRoot, log, io: makeIo(), wait: fastWait });
    // 下单已经提交（钱花了）：流程继续，但结论必须如实——不把"读不到"说成"成功"、也不说成"失败"
    assert.equal(out.ok, true);
    const text = logs.join('\n');
    assert.match(text, /注册任务状态这次没读到/, '每次读失败都要留一行（不是静默）');
    assert.match(text, /始终没读到（taskId=task-1）/, '整轮都没读到 ⇒ 最后明说一次（附 taskId，用户据此复查）');
    assert.match(text, /无法确认/, '不许把它说成成功');
  } finally {
    cloud.state.domainTaskFails = false;
  }
});

test('域名要买但没给域名单价上限：闸门拒绝（不可撤销支出要单独授权）', async () => {  const { up } = await import('../lib/up.mjs');
  cloud.state.domains = [];
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions({ buy: true, maxDomainYear: undefined, priceDomain: 70 }), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /--max-domain-year/);
      return true;
    }
  );
});

test('服务商按非人民币报价时：闸门拒绝并要求人自己换算（绝不内置汇率折算）', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.domains = [];
  cloud.state.domainCurrency = 'USD';
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions({ buy: true }), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /USD/);
      assert.match(e.message, /--price-domain/);
      assert.equal(cloud.state.domainOrder, null, '被拦下就不许下单');
      return true;
    }
  );
  cloud.state.domainCurrency = 'CNY';
});

/* ── ⑤ 账号里已有同名机器：不猜，给三条路 ─────────────────────────────────── */
test('账号里已有同名机器：停下并给三条路（认领 / 换名字 / 只看现状），且**不会**自动挑一台', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.servers = [{ id: 'i-old', name: 'marketplace-node', status: 'Running', publicIp: '198.51.100.1' }];
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /已经有 1 台叫 marketplace-node 的机器/);
      assert.match(e.message, /--adopt i-old/, '要给出可照做的认领命令（带上真实实例 ID）');
      assert.match(e.message, /--server-name/, '换名字这条路');
      assert.match(e.message, /check/, '只看现状这条路');
      assert.match(e.message, /没有自动挑一台/, '要明说"脚本不替你猜"');
      return true;
    }
  );
  assert.equal(cloud.state.calls.filter((c) => /Action=RunInstances/.test(c.body ?? '')).length, 0, '不许下单');
});

test('多台同名机器：全部列出来让用户选（不按顺序取第一个）', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.servers = [
    { id: 'i-a', name: 'marketplace-node', status: 'Running', publicIp: '198.51.100.1' },
    { id: 'i-b', name: 'marketplace-node', status: 'Stopped', publicIp: null },
  ];
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /已经有 2 台/);
      assert.match(e.message, /i-a/);
      assert.match(e.message, /i-b/, '两台都要列出来（含没有公网 IP 的那台）');
      assert.match(e.message, /（暂无公网 IP）/, '没有 IP 要说清，而不是显示空白');
      return true;
    }
  );
});

test('--adopt：认领已有机器，写进状态并直接续跑（不再下单、不重复建安全组）', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.servers = [{ id: 'i-orphan', name: 'marketplace-node', status: 'Running', publicIp: '203.0.113.10', instanceType: 'ecs.e-c1m1.large' }];
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  const out = await up({ provider, options: baseOptions({ adopt: 'i-orphan' }), repoRoot, log, io: makeIo(), wait: fastWait });
  assert.equal(out.host, '203.0.113.10');
  const st = loadState(repoRoot, 'default');
  assert.equal(st.server.id, 'i-orphan', '认领的机器要进状态（下次就是普通续跑）');
  assert.equal(st.server.adopted, true, '要标明它是认领来的，别假装是我们开的');
  assert.equal(cloud.state.calls.filter((c) => /Action=RunInstances/.test(c.body ?? '')).length, 0, '认领不该下单');
});

test('--adopt 给了不存在的 ID：明确报错并列出账号里实际有的机器', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.servers = [{ id: 'i-real', name: 'x', status: 'Running', publicIp: '203.0.113.9' }];
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions({ adopt: 'i-typo' }), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /找不到这台机器/);
      assert.match(e.message, /i-real/, '要把账号里实际有的列出来，用户才知道该填哪个');
      return true;
    }
  );
});

test('续跑：状态里已有机器时不再下单，且开头把"已完成/待完成"讲清楚', async () => {
  const { up } = await import('../lib/up.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait });
  const before = cloud.state.calls.length;
  logs.length = 0;
  await up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait });
  assert.equal(cloud.state.calls.slice(before).filter((c) => /Action=RunInstances/.test(c.body ?? '')).length, 0, '续跑不许再买机器');
  assert.ok(logs.some((l) => l.includes('续跑检查')), '开头要讲清这次从哪继续');
  assert.ok(logs.some((l) => l.includes('已完成')), '要列出已完成的步骤');
  assert.ok(logs.some((l) => l.includes('机器决策')), '要明说机器是复用还是新开');
});

test('续跑时参数被改过（换域名）：拒绝并说清代价，而不是把新参数套到旧机器上', async () => {
  const { up } = await import('../lib/up.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait });
  await assert.rejects(
    () => up({ provider, options: baseOptions({ domain: 'other.example.com' }), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /参数与它不一致/);
      assert.match(e.message, /--shop/, '要给出"换一套参数就换个店铺名"这条路');
      return true;
    }
  );
});

/* ── ⑥ dry-run：**只读、不写、不花钱** ─────────────────────────────────────── */
test('--dry-run + --buy 且域名不在账号里：绝不真的下单（原来会先买域名再报"没有创建资源"）', async () => {
  const { up } = await import('../lib/up.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  cloud.state.domains = []; // 域名不在账号里 —— 这正是原来会真买的那个输入
  const out = await up({ provider, options: baseOptions({ dryRun: true, buy: true, priceDomain: 70 }), repoRoot, log, io: makeIo(), wait: fastWait });
  assert.equal(out.dryRun, true);
  assert.match(out.note, /不会.*真的注册域名/, '要明说这次没有真的买');
  assert.equal(cloud.state.calls.filter((c) => /CreatingOrderActivate|CreateIntlDomainBatch/.test(c.body ?? '')).length, 0, '买域名的请求一条都不许发出');
  assert.equal(cloud.state.calls.filter((c) => /Action=RunInstances/.test(c.body ?? '')).length, 0, '开机器也不许');
  assert.equal(loadState(repoRoot, 'default'), null, 'dry-run 不落状态（落了就等于"这次已经做了"）');
});

test('--dry-run：把"本来会做什么"列出来，并指路 plan（看价格与闸门结论）', async () => {
  const { up } = await import('../lib/up.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  const out = await up({ provider, options: baseOptions({ dryRun: true }), repoRoot, log, io: makeIo(), wait: fastWait });
  assert.deepEqual(out.checks, ['账号可读（余额/权限）', '域名可注册性与报价', '机型询价与可用性', '预算闸门']);
  assert.ok(out.would.some((w) => /创建机器/.test(w)), '要列出会创建的东西');
  assert.ok(logs.some((l) => l.includes('plan')), '要指路 plan —— 那才是"先看花多少"的命令');
});

/* ── ⑦ 余额为 0：缺省拒绝 ─────────────────────────────────────────────────── */
test('余额为 0：缺省就停下（欠费账号下单只会得到一堆失败）', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.balance = 0;
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.equal(e.kind, 'insufficient_balance');
      assert.match(e.message, /--allow-zero-balance/);
      return true;
    }
  );
});

/* ── ⑧ destroy：先导出数据、再释放机器、域名留着 ─────────────────────────── */
test('destroy：导出数据卷 → 释放机器 → 域名与解析保留（按量计费的东西才该被释放）', async () => {
  const { up } = await import('../lib/up.mjs');
  const { destroy } = await import('../lib/destroy.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait });
  assert.equal(cloud.state.servers.length, 1);

  // 导出那一步走 ssh run：给一段 base64 的假 tar 包，验证它被落盘成备份文件
  const tarball = Buffer.from('fake-tar-bytes');
  const io = makeIo();
  io.run = (a) => {
    sshCalls.push({ kind: 'run', command: a.command });
    return { status: 0, out: tarball.toString('base64') };
  };
  const inject = { ...io, loadProvider: async () => provider, ensureCreds: async () => ({}) };
  const out = await destroy({ options: { shop: 'default' }, repoRoot, log, io: inject });
  assert.equal(out.released, true);
  assert.equal(cloud.state.servers.length, 0, '机器应该被释放');
  assert.ok(out.backup && fs.existsSync(out.backup), '数据卷应该先被导出到本地');
  assert.equal(fs.readFileSync(out.backup).toString(), 'fake-tar-bytes');
  // 域名与解析区不删（年付且 60 天内不可转出，删了也不退钱）
  assert.ok(cloud.state.domains.includes(ZONE), '买下来的应该是可注册的那一级');
  const st = loadState(repoRoot, 'default');
  assert.ok(st.server.releasedAt, '状态文件要记下已释放');
});

test('destroy：数据导不出来时**拒绝**，除非明确表示数据不要了', async () => {
  const { up } = await import('../lib/up.mjs');
  const { destroy } = await import('../lib/destroy.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait });

  const io = makeIo();
  io.run = () => ({ status: 1, out: '' }); // 机器连不上 / 卷不存在
  const inject = { ...io, loadProvider: async () => provider, ensureCreds: async () => ({}) };
  await assert.rejects(
    () => destroy({ options: { shop: 'default' }, repoRoot, log, io: inject }),
    (e) => {
      assert.equal(e.gate, true);
      assert.match(e.message, /永久丢掉/);
      assert.match(e.message, /--i-know-data-is-lost/);
      return true;
    }
  );
  assert.equal(cloud.state.servers.length, 1, '导不出数据时不许删机器');

  const out = await destroy({ options: { shop: 'default', iKnowDataIsLost: true }, repoRoot, log, io: inject });
  assert.equal(out.released, true);
  assert.equal(cloud.state.servers.length, 0);
});
/* ── ⑨ 账号里有别的名字的机器：列出来问一句（这条是用户提的需求）───────────────── */
test('账号里有别的名字的可用机器：列出来并给出 --adopt，而不是默默再开一台', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.servers = [{ id: 'i-mine', name: 'my-old-box', status: 'Running', publicIp: '198.51.100.7', instanceType: 'ecs.e-c1m1.large' }];
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /已经有 1 台可以用的机器/);
      assert.match(e.message, /i-mine/);
      assert.match(e.message, /my-old-box/, '名字要列出来（用户靠它认机器）');
      assert.match(e.message, /--adopt i-mine/, '要能直接照抄');
      assert.match(e.message, /--server-name/, '也要保留"另开一台"这条路');
      assert.equal(/Action=RunInstances/.test(cloud.state.calls.map((c) => c.body ?? '').join()), false, '不许下单');
      return true;
    }
  );
});

test('清单里标出"我们的密钥能不能登进去"（能不能接手只能试，所以要让用户提前看到）', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.servers = [
    { id: 'i-a', name: 'box-a', status: 'Running', publicIp: '198.51.100.7' },
    { id: 'i-b', name: 'box-b', status: 'Running', publicIp: '198.51.100.8' },
  ];
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  const io = makeIo();
  // 只有 i-a 能登进去（用 IP 区分）——探针的结论必须体现在清单上
  io.probe = ({ host }) => host === '198.51.100.7';
  await assert.rejects(
    () => up({ provider, options: baseOptions(), repoRoot, log, io, wait: fastWait }),
    (e) => {
      assert.match(e.message, /i-a[\s\S]*我们的密钥可登录/);
      assert.match(e.message, /i-b[\s\S]*登不进去/);
      return true;
    }
  );
});

test('别的机器但不可用（停机的、没公网 IP 的）：不进清单，直接新开', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.servers = [
    { id: 'i-stopped', name: 'box-stopped', status: 'Stopped', publicIp: '198.51.100.9' },
    { id: 'i-noip', name: 'box-noip', status: 'Running', publicIp: null },
  ];
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  const out = await up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait });
  assert.equal(out.ok, true, '没有可用机器就该照常新开，不能把用户卡住');
  assert.equal(cloud.state.calls.filter((c) => /Action=RunInstances/.test(c.body ?? '')).length, 1, '新开一台');
});

test('--adopt 认领别的名字的机器：状态里记名字标 adopted，位置状态正常续跑', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.servers = [{ id: 'i-mine', name: 'my-old-box', status: 'Running', publicIp: '198.51.100.7', instanceType: 'ecs.e-c1m1.large' }];
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  const out = await up({ provider, options: baseOptions({ adopt: 'i-mine' }), repoRoot, log, io: makeIo(), wait: fastWait });
  assert.equal(out.host, '198.51.100.7');
  const st = loadState(repoRoot, 'default');
  assert.equal(st.server.id, 'i-mine');
  assert.equal(st.server.adopted, true);
});

test('--adopt 一台停机的机器：明确拒绝（认领一个关着的机器没有意义）', async () => {
  const { up } = await import('../lib/up.mjs');
  cloud.state.servers = [{ id: 'i-stopped', name: 'box', status: 'Stopped', publicIp: '198.51.100.9' }];
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions({ adopt: 'i-stopped' }), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /状态是 Stopped/);
      return true;
    }
  );
});
/* ── ⑩ review 查出来的几处：补测试钉住 ───────────────────────────────────── */
test('--shop 会直接进文件名：不许出现可能跳出 .provision 的形状', async () => {
  const { up } = await import('../lib/up.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  /*
    "跳出去的那些尝试一个文件都没写成"：判据取**前后对比**，而不是"那个文件当前不存在"
    （2026-10-15 审计 F8）。旧写法 `assert.equal(fs.existsSync(<repoRoot>/../README.json), false)`
    断了**仓库外**的一个固定路径——而 repoRoot 是测试自己的临时目录、它的上一级是操作系统共享的
    临时目录：只要那台机器上恰好有个 `%TEMP%\README.json`（别的工具、上一次跑的东西），
    这条用例就恒红，且报错指向"你的代码写文件到仓库外了"，与真因无关。
    现在只断言"这一轮没有新增条目"——与临时目录里原本有什么无关，也与谁没清理无关。
  */
  const outsideDir = path.dirname(repoRoot);
  const before = new Set(fs.existsSync(outsideDir) ? fs.readdirSync(outsideDir) : []);
  for (const bad of ['../../README', 'a/b', '.hidden', '..']) {
    await assert.rejects(
      () => up({ provider, options: baseOptions({ shop: bad }), repoRoot, log, io: makeIo(), wait: fastWait }),
      (e) => {
        assert.match(e.message, /--shop 只能用/, `shop=${bad} 应该被挡住`);
        return true;
      }
    );
  }
  const after = new Set(fs.existsSync(outsideDir) ? fs.readdirSync(outsideDir) : []);
  const added = [...after].filter((n) => !before.has(n));
  assert.deepEqual(added, [], `跳出状态目录的尝试不许在仓库外留下任何新条目（新增：${added.join('、')}）`);
});

test('续跑时改店主地址：拒绝（owner 是店铺身份锚点，静默换掉 = 把店交给另一个地址）', async () => {
  const { up } = await import('../lib/up.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await up({ provider, options: baseOptions(), repoRoot, log, io: makeIo(), wait: fastWait });
  await assert.rejects(
    () => up({ provider, options: baseOptions({ owner: '0x1111111111111111111111111111111111111111' }), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /店主地址/);
      return true;
    }
  );
});

test('四层以上的域名：不猜解析区，要求显式 --zone（公共后缀表是另一份会过期的真相）', async () => {
  const { up } = await import('../lib/up.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions({ domain: 'shop.example.com.cn' }), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /多于三层/);
      assert.match(e.message, /--zone/);
      return true;
    }
  );
});

test('--zone 与域名对不上：拒绝，而不是建一个永远不生效的解析', async () => {
  const { up } = await import('../lib/up.mjs');
  const provider = createAliyun({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  await assert.rejects(
    () => up({ provider, options: baseOptions({ zone: 'other.com' }), repoRoot, log, io: makeIo(), wait: fastWait }),
    (e) => {
      assert.match(e.message, /不是 .* 的上级域名/);
      return true;
    }
  );
});

test('机器价拿不到时闸门拒绝（不许退化成"0 元 ≤ 额度"的假通过）', async () => {
  const { enforce } = await import('../lib/budget.mjs');
  const r = enforce({
    maxMonthly: 200,
    maxDomainYear: 100,
    cost: { serverMonthly: 0, serverPricedBy: 'provider', domainTotal: 0, domainYears: 1, domainYearly: 0, serverSource: '（没有）', domainSource: '（不涉及）' },
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /价格还拿不到/);
  // 而"只授权域名"那一步是显式豁免的，不受这条影响
  const d = enforce({
    maxMonthly: 200,
    maxDomainYear: 100,
    scope: 'domain-only',
    cost: { serverMonthly: 0, serverPricedBy: 'provider', domainTotal: 70, domainYears: 1, domainYearly: 70, domainCurrency: 'CNY', serverSource: '（本步不涉及）', domainSource: '你给的价' },
  });
  assert.equal(d.ok, true);
});
/* ── ⑪ review 剩下的几处：把假云补成真实语义，并钉住 ───────────────────────── */
test('腾讯云 domainTask：空状态 / 没见过的状态都不能算成功（否则会在域名还没注册完时往下走）', async () => {
  const { createTencent: mk } = await import('../providers/tencent.mjs');
  const p = mk({ secretId: 'ID', secretKey: 'KEY' });
  const saved = cloud.state.domainOrder;
  for (const [status, want] of [
    ['SUCCESS', 'EXECUTE_SUCCESS'],
    ['', 'EXECUTING'],
    [undefined, 'EXECUTING'],
    ['unknown', 'EXECUTING'],
    ['FAILURE', 'EXECUTE_FAILURE'],
  ]) {
    cloud.state.domainOrder = { domains: ['example.com'], detailStatus: status, failed: status === 'FAILURE' };
    const t = await p.domainTask({ taskId: '1', domain: 'example.com' });
    assert.equal(t.status, want, `Status=${JSON.stringify(status)} 应判为 ${want}`);
  }
  cloud.state.domainOrder = saved;
});

test('列表分页：第二页的机器也要看得见（漏页 = 判成"没有同名机器"然后再买一台）', async () => {
  const { createAliyun: mk } = await import('../providers/aliyun.mjs');
  const p = mk({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  cloud.state.instancePages = [
    [{ InstanceId: 'i-1', InstanceName: 'a', Status: 'Running' }],
    [{ InstanceId: 'i-2', InstanceName: 'marketplace-node', Status: 'Running', EipAddress: { IpAddress: ['203.0.113.5'] } }],
  ];
  const list = await p.listServers('cn-hongkong');
  assert.deepEqual(list.map((s) => s.id), ['i-1', 'i-2'], '两页都要拿到');
  cloud.state.instancePages = null;
});

test('阿里云公网 IP：没有公网 IP 时返回的是字符串 "Null"，不能解析成 "N"', async () => {
  const { createAliyun: mk } = await import('../providers/aliyun.mjs');
  const p = mk({ accessKeyId: 'AK', accessKeySecret: 'SK' });
  cloud.state.instancePages = [[{ InstanceId: 'i-1', InstanceName: 'a', Status: 'Running', PublicIpAddress: { IpAddress: 'Null' } }]];
  const list = await p.listServers('cn-hongkong');
  assert.equal(list[0].publicIp, null, '垃圾值必须当成"没有 IP"（"N" 会被写进状态、发给解析、拿去 SSH）');
  cloud.state.instancePages = null;
});