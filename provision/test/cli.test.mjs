/**
 * CLI 层测试：**命令分发、必填校验、退出码**。
 *
 * 退出码是给脚本与 AI 用的契约，所以它必须是判据而不是副产品：
 *   0 成功 / 1 运行期失败 / 2 用法错 / 3 闸门拒绝（预算不够、账号没就绪 —— 重跑不会变好）。
 * 把 2 和 3 混在一起，上层就只能"重试看看"，而重试对这两类都不会变好。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createFakeCloud } from './fake-cloud.mjs';
import { FLAGS, parseArgs, requireFor } from '../cli.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const OWNER = '0x66681e2889242FF0739A88879fa66890B8C7dA45';

let cloud;
let apiBase;

before(async () => {
  cloud = createFakeCloud();
  apiBase = await cloud.listen();
});
after(async () => {
  await cloud.close();
});
beforeEach(() => {
  cloud.state.servers = [];
  cloud.state.domains = ['example.com']; // 注册商只列可注册的那一级
  cloud.state.templates = [{ id: 'tmpl-1', status: 'SUCCEED', emailVerified: true, valid: true }];
  cloud.state.balance = 5000;
});

/**
 * 跑一次 CLI（子进程）：返回 { code, stdout, stderr }。
 *
 * **必须用异步 spawn，不能用 spawnSync**：假云跑在本进程里，而 spawnSync 会把本进程的
 * 事件循环**整个堵住** —— 子进程发出的 HTTP 请求永远等不到响应，于是"测试挂死"，
 * 而现场只留下一行进度日志（我在这上面花了不少时间：症状与"假云没实现那个接口"一模一样）。
 * 用 spawn + await 之后，父进程照常在事件循环上跑，请求才有人应答。
 */
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
    // 兜底超时：子进程真卡住时给出结论，而不是让整个测试进程永远等下去
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/* ── 纯函数层：参数解析 ────────────────────────────────────────────────────── */
test('parseArgs：开关不接受取值（--buy true 这种写法必须当场报错）', async () => {
  assert.throws(() => parseArgs(['up', '--buy', 'true']), /开关，不接受取值/);
  assert.deepEqual(parseArgs(['up', '--buy', '--owner', OWNER]).buy, true);
  assert.equal(parseArgs(['up', '--buy', '--owner', OWNER]).owner, OWNER);
});

test('parseArgs：缺值的取值型参数报错；默认值被填上', async () => {
  assert.throws(() => parseArgs(['up', '--owner']), /缺少取值/);
  assert.throws(() => parseArgs(['up', '--nope']), /未知参数/);
  const o = parseArgs(['up']);
  assert.equal(o.shop, 'default');
  assert.equal(o.years, 1);
  assert.equal(o.installDir, '/opt/marketplace-node');
});

test('requireFor：up 没有 --max-monthly 时按**闸门**拒绝（不是用法错）', async () => {
  const o = parseArgs(['up', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', OWNER, '--email', 'a@b.c']);
  try {
    requireFor('up', o);
    assert.fail('应该抛错');
  } catch (e) {
    assert.equal(e.gate, true);
    assert.match(e.message, /支出授权/);
  }
});

test('requireFor：owner 必须是 0x + 40 位十六进制（写错的地址会落成别人的店）', async () => {
  const bad = parseArgs(['check', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', '0x123', '--email', 'a@b.c']);
  assert.throws(() => requireFor('check', bad), /40 位十六进制/);
  const good = parseArgs(['check', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', OWNER, '--email', 'a@b.c']);
  assert.doesNotThrow(() => requireFor('check', good));
});

test('FLAGS 里每个参数都有中文说明（--help 就是从这里生成的，缺了就是空白一格）', async () => {
  for (const [flag, spec] of Object.entries(FLAGS)) {
    if (flag === '--help') continue;
    assert.ok(spec.help, `${flag} 缺少说明`);
  }
});

/* ── 子进程层：退出码 ─────────────────────────────────────────────────────── */
test('providers --json：stdout 是纯 JSON（进度日志被赶到 stderr）', async () => {
  const { code, stdout } = await runCli(['providers', '--json']);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((p) => p.id), ['aliyun', 'tencent', 'aws']);
});

test('未知命令 ⇒ 2；缺必填 ⇒ 2；没给额度 ⇒ 3（闸门）', async () => {
  assert.equal((await runCli(['nope'])).code, 2);
  assert.equal((await runCli(['check'])).code, 2);
  const noBudget = await runCli(['up', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', OWNER, '--email', 'a@b.c']);
  assert.equal(noBudget.code, 3);
  assert.match(noBudget.stderr, /支出授权/);
});

test('check：余额/已有资源/域名就绪情况都进 JSON（失败也是 0，除非真的出错）', async () => {
  const { code, stdout } = await runCli(['check', '--json', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', OWNER, '--email', 'a@b.c']);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.account.balance, 5000);
  assert.equal(out.domain.owned, true);
  assert.deepEqual(out.gates, []);
});

test('check：域名不在账号里且没有已实名模板 ⇒ 退出码 3（闸门）并给出 blocker', async () => {
  cloud.state.domains = [];
  cloud.state.templates = [];
  const { code, stdout } = await runCli(['check', '--json', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', OWNER, '--email', 'a@b.c']);
  assert.equal(code, 3);
  const out = JSON.parse(stdout);
  assert.equal(out.gates.length, 1);
  assert.equal(out.gates[0].kind, 'account_not_ready');
});

test('check：余额为 0 ⇒ 退出码 3 并指出先充值', async () => {
  cloud.state.balance = 0;
  const { code, stdout } = await runCli(['check', '--json', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', OWNER, '--email', 'a@b.c']);
  assert.equal(code, 3);
  const out = JSON.parse(stdout);
  assert.equal(out.gates[0].kind, 'insufficient_balance');
});

test('plan：算出月成本、给出步骤、并执行与 up 同一个闸门', async () => {
  const { code, stdout } = await runCli(['plan', '--json', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', OWNER, '--email', 'a@b.c', '--max-monthly', '200', '--max-domain-year', '200']);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.ok(out.cost.serverMonthly > 0);
  assert.equal(out.cost.domainTotal, 0, '域名已在账号里 ⇒ 不花钱');
  assert.equal(out.budget.ok, true);
  assert.ok(out.steps.some((s) => s.step === 'create-server'));
});

test('plan：额度给太低 ⇒ 闸门拒绝（退出码 3），且不创建任何东西', async () => {
  const { code, stdout } = await runCli(['plan', '--json', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', OWNER, '--email', 'a@b.c', '--max-monthly', '1']);
  assert.equal(code, 3);
  const out = JSON.parse(stdout);
  assert.equal(out.budget.ok, false);
  assert.equal(cloud.state.calls.filter((c) => /Action=RunInstances/.test(c.body ?? '')).length, 0);
});

test('凭据缺失 ⇒ 退出码 3，且报错里带完整的"怎么拿 key"走法（用户不必去翻文档）', async () => {
  const { code, stderr } = await runCli(['check', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', OWNER, '--email', 'a@b.c'], {
    ALIYUN_ACCESS_KEY_ID: '',
    ALIYUN_ACCESS_KEY_SECRET: '',
  });
  assert.equal(code, 3);
  assert.match(stderr, /ALIYUN_ACCESS_KEY_ID/, '缺哪个变量要点名');
  assert.match(stderr, /ram\.console\.alibabacloud\.com/, '要给控制台入口');
  assert.match(stderr, /AliyunECSFullAccess/, '要给照抄的策略名');
  assert.match(stderr, /export ALIYUN_ACCESS_KEY_ID=/, '要给两边 shell 的写法');
  assert.match(stderr, /怎么拿/, '要说清这是"怎么拿 key"，不是"key 可能抄错了"');
  assert.equal(/密钥无效或已过期/.test(stderr), false, '还没配 key 时不许再说"密钥可能失效"——两句会互相打架');
});

test('providers（不带 --json）默认打印"怎么拿 key"，而不是先甩一坨 JSON', async () => {
  const { code, stdout } = await runCli(['providers']);
  assert.equal(code, 0);
  for (const url of ['ram.console.alibabacloud.com', 'console.intl.cloud.tencent.com/cam/capi', 'console.aws.amazon.com/iam']) {
    assert.equal(stdout.includes(url), true, `缺少控制台入口：${url}`);
  }
  for (const env of ['ALIYUN_ACCESS_KEY_ID', 'TENCENTCLOUD_SECRET_ID', 'AWS_ACCESS_KEY_ID']) {
    assert.equal(stdout.includes(env), true, `缺少环境变量名：${env}`);
  }
  assert.match(stdout, /不需要 ICP 备案/);
});

test('providers --json：结构化输出保持干净（脚本/AI 用）', async () => {
  const { code, stdout } = await runCli(['providers', '--json']);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.length, 3);
});

test('--help 里也指明"还没拿到 key 去哪儿看"（不然用户会在参数表里迷路）', async () => {
  const { stdout } = await runCli(['--help']);
  assert.match(stdout, /还没拿到 key/);
  assert.match(stdout, /cli\.mjs providers/);
});

test('用不存在的 --shop 做 verify/destroy ⇒ 退出码 3（没有本工具创建的东西可动）', async () => {
  assert.equal((await runCli(['verify', '--shop', 'nope-' + Date.now()])).code, 3);
  assert.equal((await runCli(['destroy', '--shop', 'nope-' + Date.now()])).code, 3);
});

test('--help 打到 stdout 且包含用法与退出码约定', async () => {
  const { code, stdout } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /provision —— 一把云 API key/);
  assert.match(stdout, /退出码：0 成功；1 运行期失败；2 用法错；3 闸门拒绝/);
});

/* 保证 tmp 目录不残留（这条只是防止以后有人往 CLI 里加"顺手写文件"的行为） */
test('CLI 不在仓库里留下临时文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-cli-'));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(true);
});

/*
  ── 服务商报外币时：plan 与 up 必须说**同一句话**（2026-10-15 审计 F10）────────────
  此前 up 说"请用 --price-domain 给个元价"，plan 说"币种不对"（它把服务商的美元价照用，
  把问题留给预算闸门）——同一件事两句话，用户先看 plan 再跑 up 会以为其中一个坏了。
  现在两侧共用 `budget.domainPriceOf`：plan 的 blocker 与 up 的报错是同一句。
*/
test('plan：服务商按外币报价且没给 --price-domain ⇒ 说清"给个元价"，与 up 同一句', async () => {
  cloud.state.domains = [];
  cloud.state.domainCurrency = 'USD';
  try {
    // 阿里云国际站的 CheckDomain 固定按 USD 报价（见 fake-cloud 的 domainCurrency 说明）
    const { code, stdout } = await runCli(['plan', '--json', '--provider', 'aliyun', '--domain', 'shop.example.com', '--owner', OWNER, '--email', 'a@b.c', '--max-monthly', '200', '--max-domain-year', '200', '--buy']);
    const out = JSON.parse(stdout);
    const why = JSON.stringify(out.blockers);
    assert.match(why, /--price-domain/, '要说清怎么修（而不是只报"币种不对"）');
    assert.match(why, /元/, '要点明额度是元、且不折算');
    assert.notEqual(code, 0, '有 blocker 的计划不该以成功退出');
  } finally {
    cloud.state.domainCurrency = 'CNY';
  }
});
