/**
 * 三家适配器的**契约测试**：`check` 路径（凭据 → 余额 → 已有资源 → 域名前置）。
 *
 * 为什么这条路径值得逐家测：它是用户**第一次**看到的东西，而三家的差异全在这一段里
 * —— 单位（腾讯云是分）、域名走哪个注册商（境外）、余额有没有这个接口（AWS 根本没有）。
 * 这些差异只要有一处判错，用户就会在"还没花钱"的阶段得到一条误导性的结论。
 *
 * 用假云跑（test/fake-cloud.mjs），断言的是**结论与单位**，不是"调用了几次"。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeCloud } from './fake-cloud.mjs';
import { createAliyun } from '../providers/aliyun.mjs';
import { createTencent } from '../providers/tencent.mjs';
import { createAws } from '../providers/aws.mjs';
import { canBuyDomain, defineProvider, PROVIDER_IDS } from '../lib/provider.mjs';

let cloud;
before(async () => {
  cloud = createFakeCloud();
  process.env.PROVISION_API_BASE = await cloud.listen();
});
after(async () => {
  await cloud.close();
  delete process.env.PROVISION_API_BASE;
});
beforeEach(() => {
  cloud.state.servers = [];
  cloud.state.domains = [];
  cloud.state.templates = [{ id: 'tmpl-ok-1', status: 'SUCCEED', emailVerified: true, valid: true }];
  cloud.state.balance = 5000;
  cloud.state.calls = [];
  /*
    假云的**资源位**也要清：安全组、VPC、解析记录都是"账号里已经存在的东西"，
    上个用例建过之后不清，下个用例就会走"复用已有"的短路分支 ——
    于是"建 VPC / 建安全组"那条路根本不会被走到，测试却绿着（我在这上面被绊了一次）。
  */
  cloud.state.securityGroup = null;
  cloud.state.vpcFlow = false;
  cloud.state.vpcCreated = false;
  cloud.state.vpcs = undefined;
  cloud.state.zoneRecords = new Map();
  cloud.state.zones = new Map();
  cloud.state.importedKey = null;
  cloud.state.describeInstancesCalls = 0;
});

const creds = { accessKeyId: 'AK', accessKeySecret: 'SK', secretId: 'ID', secretKey: 'KEY' };

test('支持的就是这三家（都在非大陆区域有机器 + 都有境外注册商的域名接口）', () => {
  assert.deepEqual([...PROVIDER_IDS], ['aliyun', 'tencent', 'aws']);
});

/**
 * "不备案"必须是**结构上不可选错**的，而不是一句提示或一个默认值：
 * 域名注册只能打境外注册商的端点。中国站的注册商端点（domain.aliyuncs.com /
 * domain.tencentcloudapi.com）一旦出现在代码里，就等于留了一条"注册出能/需要备案的域名"的路。
 * 这条守卫盯的是**端点**，所以以后有人改动 endpoint 常量时会立刻红。
 */
test('域名注册只打境外注册商的端点（中国站的注册商端点不许出现）', async () => {
  for (const id of PROVIDER_IDS) {
    const p = await loadById(id);
    const endpoints = JSON.stringify(p.describe().endpoints ?? {});
    for (const forbidden of ['domain.aliyuncs.com', 'domain.tencentcloudapi.com']) {
      assert.equal(endpoints.includes(forbidden), false, `${id} 的端点里出现了中国站注册商：${forbidden}`);
    }
  }
  const aliyun = createAliyun(creds).describe();
  assert.match(aliyun.endpoints.domain, /^domain-intl\./);
  const tencent = createTencent(creds).describe();
  assert.match(tencent.endpoints.domain, /^domain\.intl\./);
  // AWS 的域名注册端点全球只有一个（境外注册商）
  const aws = createAws(creds).describe();
  assert.match(aws.endpoints.route53domains, /route53domains\./);
});

test('三家都有域名注册能力（都能买域名），所以 canBuyDomain 一律为真', async () => {
  for (const id of PROVIDER_IDS) {
    const p = await loadById(id);
    assert.equal(canBuyDomain(p), true, `${id} 应该有买域名能力`);
  }
});

test('适配器缺少必需方法时，defineProvider 立刻报错（不留半成品能跑一半）', () => {
  assert.throws(() => defineProvider({ id: 'aliyun', describe: () => ({}) }), /缺少必需方法/);
  assert.throws(() => defineProvider({ id: 'nope' }), /未知的 provider id/);
});

test('阿里云 check：余额按元、已有资源列出来、模板就绪时不报 blocker', async () => {
  cloud.state.servers = [{ id: 'i-1', name: 'marketplace-node', status: 'Running', publicIp: '203.0.113.10', instanceType: 'ecs.e-c1m1.large' }];
  const p = createAliyun(creds);
  const acct = await p.account();
  assert.equal(acct.balance, 5000);
  assert.equal(acct.currency, 'CNY');
  assert.deepEqual(acct.domainBlockers, []);
  assert.equal(acct.identity.accountId, '1234567890');
  const servers = await p.listServers('cn-hongkong');
  assert.equal(servers.length, 1);
  assert.equal(servers[0].publicIp, '203.0.113.10');
});

test('阿里云 check：账号里一个模板都没有时，domainBlockers 明说缺什么（而不是等下单失败）', async () => {
  cloud.state.templates = [];
  const p = createAliyun(creds);
  const acct = await p.account();
  assert.equal(acct.domainBlockers.length >= 2, true);
  assert.match(acct.domainBlockers.join('\n'), /信息模板/);
});

test('阿里云询价：小时价折成月价（×730），并把来源写清楚', async () => {
  cloud.state.hourlyPrice = 0.1;
  const p = createAliyun(creds);
  const price = await p.serverMonthlyPrice({ region: 'cn-hongkong', instanceType: 'ecs.e-c1m1.large', imageId: 'img' });
  assert.equal(price.monthly, 73); // 0.1 × 730
  assert.match(price.source, /DescribePrice/);
});

test('腾讯云 check：余额单位是**分**，必须换算成元', async () => {
  cloud.state.balance = 1234.56;
  const p = createTencent(creds);
  const acct = await p.account();
  // 假云按"分"返回 123456，适配器要还原成 1234.56 元
  assert.equal(acct.balance, 1234.56);
  assert.equal(acct.owed, 0);
});

test('腾讯云：失败也是 HTTP 200，错误必须从 Response.Error 里认出来', async () => {
  const p = createTencent(creds);
  // 拿一个确实会失败的动作来验：DescribeDomain 查一个不存在的域名时，
  // 腾讯云回的是 HTTP 200 + Response.Error（`ResourceNotFound.DomainNotReged`）——
  // 只看 res.ok 会把这次失败当成成功，所以适配器必须自己再判一次 Response.Error。
  // 这里直接用一个**未实现的动作**：假云对未知动作回 InvalidAction（同样是 HTTP 200 + Response.Error）。
  cloud.state.describeDomainFails = true;
  try {
    await assert.rejects(
      () => p.ensureZone({ domain: 'example.com' }),
      (e) => {
        assert.equal(e.provider, 'tencent');
        assert.match(String(e.code), /AuthFailure|Signature/, '非 not_found 的失败必须原样上抛，不能被"域名没注册"那个分支吞掉');
        return true;
      }
    );
  } finally {
    cloud.state.describeDomainFails = false;
  }
});

/*
  ── 参数名 / 响应字段名的回归测试 ──────────────────────────────────────────────
  下面这几条不是"多测一遍"，而是把**逐字核对官方文档查出来的错**钉住。
  这一类错有两种形态，都很隐蔽：
    · 参数名错 → 服务商回 InvalidParameter，看起来像"账号/权限问题"；
    · 响应字段名错 → **不报错**，只是恒为 undefined（"看起来取到了，其实什么都没取到"）。
  国际站的域名接口参数名与中国站不同（Domain vs DomainName、*Intl* 动作名），
  最容易在"照着中国站文档写"的时候写错，所以这里逐字断言。
*/
function reqBody(predicate) {
  return cloud.state.calls.find((c) => predicate(c));
}

test('腾讯云国际站：CheckIntlDomainNew 的参数是 Domain（不是 DomainName），且带 Period', async () => {
  cloud.state.domains = [];
  const p = createTencent(creds);
  await p.domainPrice({ domain: 'shop.example.com', years: 2 });
  const body = JSON.parse(reqBody((c) => c.headers?.['x-tc-action'] === 'CheckIntlDomainNew').body);
  assert.equal(body.Domain, 'shop.example.com', 'CheckIntlDomainNew 的必填参数官方叫 Domain');
  assert.equal(body.DomainName, undefined, '传 DomainName 会被拒（MissingParameter.DomainIsEmpty）');
  assert.equal(body.Period, '2', 'Period 用于查溢价域名，不给就查不到溢价价');
});

test('腾讯云国际站：域名列表用 DescribeIntlDomainList，且按 Status/AutoRenew 解析（没有 BuyStatus 这个字段）', async () => {
  cloud.state.domains = ['shop.example.com'];
  const p = createTencent(creds);
  const list = await p.listDomains();
  assert.ok(reqBody((c) => c.headers?.['x-tc-action'] === 'DescribeIntlDomainList'), '应该调国际站的动作');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'shop.example.com');
  assert.equal(list[0].status, 'ok');
  assert.equal(list[0].autoRenew, false); // 官方是整数 0/1，不是布尔
});

test('腾讯云国际站：注册人资料没有"审核状态"这回事，不许编一个出来挡住用户', async () => {
  cloud.state.templates = [{ id: 'tmpl-1' }]; // IntlTemplate 只有 TemplateId/联系人/IsDefault
  const p = createTencent(creds);
  const tpl = await p.domainTemplates();
  assert.equal(tpl.length, 1);
  assert.equal(tpl[0].id, 'tmpl-1');
  assert.equal(tpl[0].valid, true, '国际站资料没有审核态 ⇒ 一律视为可用，别编 AuditStatus');
});

test('腾讯云国际站：下单用 CreateIntlDomainBatch，AutoRenewFlag 是布尔（中国站才是 0/1）', async () => {
  const p = createTencent(creds);
  await p.buyDomain({ domain: 'shop.example.com', years: 1, templateId: 'tmpl-1' });
  const body = JSON.parse(reqBody((c) => c.headers?.['x-tc-action'] === 'CreateIntlDomainBatch').body);
  assert.equal(body.TemplateId, 'tmpl-1');
  assert.equal(body.Period, 1);
  assert.deepEqual(body.Domains, ['shop.example.com']);
  assert.equal(body.PayMode, 1);
  assert.equal(body.AutoRenewFlag, false, '国际站是 Boolean，传 0 类型不符');
});

test('阿里云：CheckDomain 的 FeeCurrency 只认 USD（传账号币种会被参数校验拒掉）', async () => {
  cloud.state.domains = [];
  const p = createAliyun(creds);
  await p.domainPrice({ domain: 'shop.example.com', years: 1 });
  const form = new URLSearchParams(reqBody((c) => /Action=CheckDomain/.test(c.body)).body);
  assert.equal(form.get('FeeCurrency'), 'USD');
  assert.equal(form.get('FeeCommand'), 'create');
});

test('阿里云：价格条目按 action=activate 取（FeeCommand 的 create 不是条目里的 action 值）', async () => {
  cloud.state.hourlyPrice = 0.1;
  cloud.state.domainPrice = 78;
  const p = createAliyun(creds);
  const price = await p.domainPrice({ domain: 'shop.example.com', years: 1 });
  assert.equal(price.yearly, 78);
  assert.equal(price.available, true);
});

test('阿里云：VPC 安全组不许传 NicType=internet（官方：VPC 只支持 intranet，且默认值恰是 internet）', async () => {
  cloud.state.domains = [];
  const p = createAliyun(creds);
  await p.ensureSecurityGroup({ region: 'cn-hongkong', name: 'marketplace-node' });
  const calls = cloud.state.calls.filter((c) => /Action=AuthorizeSecurityGroup/.test(c.body ?? ''));
  assert.equal(calls.length, 3, '三个端口各一条规则');
  for (const c of calls) {
    const form = new URLSearchParams(c.body);
    assert.equal(form.get('Permissions.1.NicType'), null, '传了 NicType 就会被拒（VPC 安全组只支持 intranet）');
    assert.equal(form.get('Permissions.1.Policy'), 'accept');
  }
});

test('AWS check：余额如实为 null 并说明原因（AWS 没有余额接口）', async () => {
  const p = createAws(creds);
  const acct = await p.account();
  assert.equal(acct.balance, null);
  assert.equal(acct.identity.accountId, '123456789012');
  assert.match(acct.warnings.join('\n'), /没有账户余额查询|不提供账户余额/);
});

test('AWS 机器列表：同名 item 嵌套里要取对实例（XML 分层）', async () => {
  cloud.state.servers = [{ id: 'i-aws-1', name: 'marketplace-node', status: 'running', instanceType: 't3.micro', publicIp: '203.0.113.20' }];
  const p = createAws(creds);
  const servers = await p.listServers('ap-southeast-1');
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, 'i-aws-1');
  assert.equal(servers[0].name, 'marketplace-node');
  assert.equal(servers[0].publicIp, '203.0.113.20');
});

test('AWS 没有询价接口：如实失败（价目表要单独开通，不能拿过期价冒充实时价）', async () => {
  const p = createAws(creds);
  await assert.rejects(
    () => p.serverMonthlyPrice({ region: 'ap-southeast-1', instanceType: 't3.micro' }),
    (e) => {
      assert.equal(e.kind, 'unavailable');
      assert.match(e.message, /--price-server/);
      return true;
    }
  );
});

test('AWS 注册域名缺联系人：明确拒绝（拿占位值下单会被注册局退单）', async () => {
  const p = createAws(creds);
  await assert.rejects(
    () => p.buyDomain({ domain: 'shop.example.com', years: 1 }),
    (e) => {
      assert.match(e.message, /联系人/);
      return true;
    }
  );
});

async function loadById(id) {
  const mod = await import(`../providers/${id}.mjs`);
  const factory = Object.values(mod).find((v) => typeof v === 'function' && v.name.startsWith('create'));
  return factory(creds);
}

test('AWS 建机器：显式带默认子网 + 网卡上要公网 IP（不写 SubnetId 就依赖默认 VPC，那不一定存在）', async () => {
  cloud.state.domains = [];
  const p = createAws(creds);
  // 用一个假的安全组 id 直接调 createServer（不真的走 EnsureSecurityGroup 的分支）
  await p.createServer({ region: 'ap-southeast-1', name: 'marketplace-node', instanceType: 't3.micro', sshPublicKey: 'ssh-rsa AAAA', securityGroupId: 'sg-1', imageId: 'ami-1' });
  const call = cloud.state.calls.find((c) => /Action=RunInstances/.test(c.body ?? ''));
  const form = new URLSearchParams(call.body);
  assert.equal(form.get('NetworkInterface.1.DeviceIndex'), '0');
  assert.equal(form.get('NetworkInterface.1.AssociatePublicIpAddress'), 'true');
  assert.equal(form.get('NetworkInterface.1.SubnetId'), 'subnet-default-1', '必须显式给子网');
  assert.equal(form.get('NetworkInterface.1.SecurityGroupId.1'), 'sg-1');
  assert.equal(form.get('SecurityGroupId.1'), null, '安全组挂在网卡上，别在顶层再给一份（会冲突）');
});

test('AWS 没有默认子网时：明确失败并说清该怎么办（而不是等 RunInstances 报一个看不懂的错）', async () => {
  const p = createAws(creds);
  const original = cloud.state.calls.length;
  // 让 DescribeSubnets 返回空集合
  const prev = cloud.state.emptySubnets;
  cloud.state.emptySubnets = true;
  try {
    await assert.rejects(
      () => p.createServer({ region: 'ap-southeast-1', name: 'x', instanceType: 't3.micro', sshPublicKey: 'ssh-rsa AAAA', securityGroupId: 'sg-1', imageId: 'ami-1' }),
      (e) => {
        assert.equal(e.kind, 'invalid');
        assert.match(e.message, /默认子网/);
        return true;
      }
    );
  } finally {
    cloud.state.emptySubnets = prev;
    assert.ok(cloud.state.calls.length > original);
  }
});
/*
  ── 阿里云：逐条核对官方文档后修掉的错，逐条钉住 ─────────────────────────────
  这几条有个共同点：错的时候**不会**报"参数错"，而是返回空集合或恒为 null，
  然后表现为"镜像找不到 / 记录查不到 / 价格是 undefined"。所以必须断言请求本身。
*/
test('阿里云：ImageFamily 必须是镜像族系（acs:…），不是镜像 ID 前缀', async () => {
  cloud.state.domains = [];
  const p = createAliyun(creds);
  const img = await p.resolveImage('cn-hongkong');
  assert.ok(img.id, '假云对非 acs: 族系返回空集合 ⇒ 传错时这里会抛错');
  const form = new URLSearchParams(reqBody((c) => /Action=DescribeImages/.test(c.body)).body);
  assert.match(form.get('ImageFamily'), /^acs:/, '族系名以 acs: 开头（官方公共镜像概述）');
});

/*
  ⚠️ 这两条原本用 `readARecord` 触发请求——那个方法**生产代码零调用**，已按 doctrine 删掉
  （2026-10-15 审计 F10）。被钉住的规则属于**在跑的那条路径** `upsertARecord`（它同样要
  按 RR 精确读出已有记录才能决定改还是建），所以这里改成调 `upsertARecord`：
  断言不变，触发点换成真会被调用的那个。
*/
test('阿里云：DescribeDomainRecords 不能带 SearchMode（带上会让 RRKeyWord/TypeKeyWord 失效）', async () => {
  cloud.state.domains = [];
  cloud.state.zoneRecords = new Map([['example.com/shop', '203.0.113.10']]);
  cloud.state.zones = new Map([['example.com', { id: 'd-1', nameservers: ['ns1.alidns.com'] }]]);
  const p = createAliyun(creds);
  const rec = await p.upsertARecord({ zoneName: 'example.com', rr: 'shop', value: '203.0.113.11' });
  assert.equal(rec.changed, true);
  /*
    精确命中的观测点用**请求**而不是假云里的值：假云的 zoneRecords 只服务读取
    （AddDomainRecord/UpdateDomainRecord 不改它），所以"读到了那一条"的证据是
    "走了更新而不是新建"——读不到时会去 AddDomainRecord（重复 A 记录）。
  */
  assert.ok(
    reqBody((c) => /Action=UpdateDomainRecord/.test(c.body)) !== undefined,
    '已有记录 ⇒ 必须走 UpdateDomainRecord（读不到就会去 AddDomainRecord，留下重复 A 记录）'
  );
  assert.equal(
    cloud.state.calls.some((c) => /Action=AddDomainRecord/.test(String(c.body || ''))),
    false,
    '不许出现新建请求'
  );
  const form = new URLSearchParams(reqBody((c) => /Action=DescribeDomainRecords/.test(c.body)).body);
  assert.equal(form.get('SearchMode'), null, '传了 SearchMode，官方语义下 RRKeyWord/TypeKeyWord 被忽略');
  assert.equal(form.get('RRKeyWord'), 'shop');
  assert.equal(form.get('TypeKeyWord'), 'A');
});

test('阿里云：询价缺 Currency 时按 USD 标注（国际站是 USD，不是 CNY）', async () => {
  cloud.state.hourlyPrice = 0.1;
  cloud.state.priceCurrency = undefined; // 服务商没回币种
  const p = createAliyun(creds);
  const price = await p.serverMonthlyPrice({ region: 'cn-hongkong', instanceType: 'ecs.e-c1m1.large', imageId: 'img' });
  assert.equal(price.currency, 'USD', '国际站的默认口径是 USD；标成 CNY 会让闸门把美元当人民币比');
  assert.match(price.source, /USD/);
  cloud.state.priceCurrency = 'CNY';
});

test('阿里云：安全组用 MaxResults（PageSize 正在下线），且不带 NicType', async () => {
  cloud.state.domains = [];
  const p = createAliyun(creds);
  await p.ensureSecurityGroup({ region: 'cn-hongkong', name: 'marketplace-node' });
  const listed = new URLSearchParams(reqBody((c) => /Action=DescribeSecurityGroups/.test(c.body)).body);
  assert.equal(listed.get('MaxResults'), '50');
  assert.equal(listed.get('PageSize'), null, 'PageSize 已标记即将下线（NotSupported.PageNumberAndPageSize）');
});

test('阿里云：CreateVpc 是异步的 —— 建完必须等它 Available 才建交换机', async () => {
  cloud.state.domains = [];
  cloud.state.vpcFlow = true; // 账号里没有 VPC：建之前查不到，建之后才有 —— 只有这条路会走到"自己建 VPC"
  cloud.state.vpcCreated = false; // 上一个用例可能把它置过 true，不重置就跳过了"自己建"这条路
  try {
    const p = createAliyun(creds);
    await p.ensureSecurityGroup({ region: 'cn-hongkong', name: 'marketplace-node' });
    const actions = cloud.state.calls.map((c) => new URLSearchParams(c.body).get('Action'));
    // event-kind 用**精确相等**找，不用 indexOf('CreateVpc') —— 后者会命中 'DescribeVpcs' 里的子串
    const at = (name) => actions.findIndex((a) => a === name);
    const createVpc = at('CreateVpc');
    const describeVpcAttribute = at('DescribeVpcAttribute');
    const createVSwitch = at('CreateVSwitch');
    assert.ok(createVpc >= 0, `应该走了"自己建 VPC"这条路；实际动作：${actions.join(' → ')}`);
    assert.ok(describeVpcAttribute > createVpc, 'CreateVpc 之后必须查 VPC 状态');
    assert.ok(createVSwitch > describeVpcAttribute, '要等状态可用才建交换机（否则 IncorrectVpcStatus）');
  } finally {
    cloud.state.vpcFlow = false;
  }
});

test('阿里云：CheckDomain 的 FeeCurrency 固定 USD，且按 activate 条目取价', async () => {
  cloud.state.domains = [];
  cloud.state.domainPrice = 78;
  const p = createAliyun(creds);
  const price = await p.domainPrice({ domain: 'shop.example.com', years: 1 });
  assert.equal(price.yearly, 78);
  assert.equal(price.currency, 'USD');
  const form = new URLSearchParams(reqBody((c) => /Action=CheckDomain/.test(c.body)).body);
  assert.equal(form.get('FeeCurrency'), 'USD');
});

test('阿里云：下单失败不靠 Result 字段判（响应里只有 RequestId + TaskNo），靠轮询状态', async () => {
  const p = createAliyun(creds);
  const bought = await p.buyDomain({ domain: 'shop.example.com', years: 1, templateId: 'tmpl-ok-1' });
  assert.equal(bought.taskId, 'task-1');
  const task = await p.domainTask({ taskId: 'task-1', domain: 'shop.example.com' });
  assert.equal(task.status, 'EXECUTE_SUCCESS');
});
/*
  ── 腾讯云：核对官方文档后修掉的几处 ──────────────────────────────────────────
*/
test('腾讯云询价：Placement 是必填、用折扣价、按带宽算月价（不拿元/GB 去乘 730）', async () => {
  const p = createTencent(creds);
  const price = await p.serverMonthlyPrice({ region: 'ap-hongkong', instanceType: 'S5.SMALL2', imageId: 'img-ubuntu2204' });
  // 假云给的是 机器 0.12/0.1（折扣价 0.1）+ 带宽 0.06 = 0.16 元/小时 ⇒ ×730
  assert.equal(price.monthly, 116.8);
  assert.equal(price.currency, 'CNY');
  assert.match(price.source, /阶梯|上界/);
  const body = JSON.parse(reqBody((c) => c.headers?.['x-tc-action'] === 'InquiryPriceRunInstances').body);
  assert.ok(body.Placement?.Zone, 'Placement 在询价接口上是必填（少了直接 MissingParameter）');
  assert.equal(body.InternetAccessible.InternetChargeType, 'BANDWIDTH_POSTPAID_BY_HOUR', '按带宽才能算出月价；按流量的单位是元/GB');
});

test('腾讯云：Region 只进 X-TC-Region 请求头，不进 JSON body（官方：公共参数统一放头部）', async () => {
  const p = createTencent(creds);
  await p.listServers('ap-hongkong');
  const call = reqBody((c) => c.headers?.['x-tc-action'] === 'DescribeInstances');
  assert.equal(call.headers['x-tc-region'], 'ap-hongkong', '头部要有 region');
  assert.equal(JSON.parse(call.body).Region, undefined, 'body 里不该再带一份 —— 严格的产品会以 UnknownParameter.WithArgs 拒掉');
});

test('腾讯云：安全组规则不许写死 Version（写死只在版本恰为 1 时成功）', async () => {
  cloud.state.securityGroup = null;
  const p = createTencent(creds);
  await p.ensureSecurityGroup({ region: 'ap-hongkong', name: 'marketplace-node' });
  const body = JSON.parse(reqBody((c) => c.headers?.['x-tc-action'] === 'CreateSecurityGroupPolicies').body);
  assert.equal(body.SecurityGroupPolicySet.Version, undefined, '传版本号会在版本不匹配时报 UnsupportedOperation.VersionMismatch');
  assert.ok(Array.isArray(body.SecurityGroupPolicySet.Ingress), '一次请求只能一个方向：只发 Ingress');
});

test('腾讯云：查解析记录要带 ErrorOnEmpty=no（默认 yes 会把"没有这条记录"变成异常）', async () => {
  cloud.state.zones = new Map([['example.com', { id: 1, nameservers: ['ns1.dnspod.net'] }]]);
  cloud.state.zoneRecords = new Map();
  const p = createTencent(creds);
  // 没有这条记录：`upsertARecord` 必须先把它读成"空"再决定新建（而不是让接口抛异常）
  const rec = await p.upsertARecord({ zoneName: 'example.com', rr: 'shop', value: '203.0.113.11' });
  assert.equal(rec.changed, true, '空区里必须先读到"没有"，然后才建');
  assert.equal(cloud.state.zoneRecords.get('example.com/shop'), '203.0.113.11');
  const body = JSON.parse(reqBody((c) => c.headers?.['x-tc-action'] === 'DescribeRecordList').body);
  assert.equal(body.ErrorOnEmpty, 'no');
  assert.equal(body.SubDomain, 'shop', '规范参数是 SubDomain（Subdomain 已废弃）');
});

test('腾讯云：KeyName 里不许出现 - 或 .（实例名带符号时会被密钥接口拒掉）', async () => {
  const p = createTencent(creds);
  await p.createServer({ region: 'ap-hongkong', name: 'marketplace-node', instanceType: 'S5.SMALL2', sshPublicKey: 'ssh-rsa AAAA', securityGroupId: 'sg-1', imageId: 'img-1' });
  const body = JSON.parse(reqBody((c) => c.headers?.['x-tc-action'] === 'ImportKeyPair').body);
  assert.match(body.KeyName, /^[A-Za-z0-9_]+$/, `KeyName 只能字母数字下划线，收到 ${body.KeyName}`);
  assert.ok(body.KeyName.length <= 25);
});
/*
  ── 权限清单不会漂移 ────────────────────────────────────────────────────────
  `providers` 打印的那份"该开哪些权限"是给人照抄的。它会漂移：适配器加了一个新接口，
  清单没跟上，用户照单开权限就会在跑到一半时收到 Forbidden —— 而那时他已经配好了 key、
  甚至已经付了机器的钱。
  所以这里用假云把 check 路径真跑一遍，断言"适配器实际发出的每个动作都在清单里"。
  这条守卫不依赖人记得同步。
*/
test('providers 里列的权限清单覆盖了适配器实际发出的每个动作（清单不会漂移）', async () => {
  const { CHANNELS } = await import('../lib/credentialHelp.mjs');
  /*
    动作清单的格式是 "服务 动作 动作…"（空白分隔，机器可解析）——
    这条守卫读的就是它，所以格式不能随便改（改了这里会红，改回来就好）。
  */
  const declared = (id) => {
    const set = new Set();
    for (const line of CHANNELS[id].actions) {
      const [svc, ...acts] = line.trim().split(/\s+/);
      for (const a of acts) set.add(`${svc} ${a}`.toLowerCase());
    }
    return set;
  };
  const norm = (s) => String(s).toLowerCase();

  for (const id of PROVIDER_IDS) {
    cloud.state.calls = [];
    cloud.state.domains = ['shop.example.com'];
    const p = await loadById(id);
    // 只跑"只读 + 凭据"这一段（check 的全部网络行为）：不会创建任何东西，但会把清单里
    // 该有的读动作全用到
    await p.account();
    await p.listServers(undefined).catch(() => []);
    await p.listDomains().catch(() => []);
    await p.resolveImage(id === 'aws' ? 'ap-southeast-1' : id === 'tencent' ? 'ap-hongkong' : 'cn-hongkong').catch(() => null);

    const sent = new Set();
    for (const c of cloud.state.calls) {
      if (id === 'aliyun') {
        const a = new URLSearchParams(c.body ?? '').get('Action');
        if (a) sent.add(a.toLowerCase());
      } else if (id === 'tencent') {
        const a = c.headers?.['x-tc-action'];
        if (a) sent.add(a.toLowerCase());
      } else {
        const a = new URLSearchParams(c.body ?? '').get('Action') ?? /\.([A-Za-z]+)$/.exec(c.headers?.['x-amz-target'] ?? '')?.[1];
        if (a) sent.add(a.toLowerCase());
      }
    }
    assert.ok(sent.size > 0, `${id}: 假云没记录到任何动作，这条守卫就白写了`);

    // 清单里是 "服务 动作"：比较时只比动作名（服务名由适配器决定，清单只是给人看的归属）
    const have = [...declared(id)].map((x) => norm(x.split(' ')[1]));
    const missing = [...sent].filter((a) => !have.includes(norm(a)));
    assert.deepEqual(missing, [], `${id}: 这些动作没写进权限清单（清单漂移了）：${missing.join(', ')}`);
  }
});
/*
  ── AWS 的**响应协议**必须按 service 选（2026-10-15 审计 F8）──────────────────
  EC2/STS/Route53 是 XML，而 **Route 53 Domains 是 JSON 1.1**。旧实现给所有 AWS 调用写死
  `parse: xmlParse`：XML 解析器喂 JSON 体不抛错，只是什么都解析不出来 ⇒ `Availability`/`Prices`/
  `OperationId`/`Domains` 全 undefined ⇒ AWS 上"能不能注册"恒 false、"多少钱"恒 null（实测：
  这三条路径一次也没成功过）。下面逐条钉住 JSON 协议那几个动作**真的读到了字段**，
  外加一条"没声明协议的 service 必须拒绝"（防这类静默失败再回来）。
*/
test('AWS 域名（JSON 协议）：能不能注册、多少钱、账号里有哪些域名都必须真的读到', async () => {
  const p = createAws(creds);
  cloud.state.domains = ['example.com'];
  cloud.state.domainAvailable = true;
  const price = await p.domainPrice({ domain: 'shop.example.com', years: 1 });
  assert.equal(price.available, true, 'CheckDomainAvailability 的 Availability 必须被读到（不是 undefined ⇒ false）');
  assert.equal(price.yearly, 13, 'ListPrices 的 RegistrationPrice.Price 必须被读到（不是 null）');
  assert.equal(price.currency, 'USD', '币种同样来自 RegistrationPrice.Currency');
  const list = await p.listDomains();
  assert.deepEqual(list.map((d) => d.name), ['example.com'], 'ListDomains 的 Domains[] 必须被读到');
});

test('AWS：响应协议按 service 查表，没声明的当场拒绝（协议猜错只会让每个字段变成 undefined）', async () => {
  const { protocolOf } = await import('../providers/aws.mjs');
  assert.equal(protocolOf('ec2'), 'xml', 'EC2/STS 是 Query 协议（XML 响应）');
  assert.equal(protocolOf('sts'), 'xml');
  assert.equal(protocolOf('route53'), 'xml', 'Route 53 是 REST-XML');
  assert.equal(protocolOf('route53domains'), 'json', 'Route 53 Domains 是 JSON 1.1——当成 XML 会让每个字段读不到');
  assert.throws(
    () => protocolOf('ce'),
    (e) => {
      assert.match(e.message, /没有声明 ce 的响应协议/);
      assert.match(e.message, /变成 undefined/, '要说清后果：猜错协议不会报错，只会静默读不到');
      return true;
    }
  );
});

/*
  ── AWS 安全组：已有就复用（F8① 的核对结论）────────────────────────────────
  审计把它记成"夹具缺 item 层 ⇒ 每次都新建安全组"。实测**不成立**：夹具的
  `DescribeSecurityGroups` 返回 `securityGroupInfo > item > groupId`（与官方 XML 同形），
  适配器按层取也能取到 —— 两次调用只发一次 CreateSecurityGroup。
  这条用例把这个结论钉住：夹具形状与适配器解析必须一直对得上，否则"复用"会静默退化成"每次都新建"
  （多出来的安全组不会有人清理）。
*/
test('AWS 安全组：第二次调用复用已有的（不重复创建）', async () => {
  const p = createAws(creds);
  const prev = cloud.state.securityGroup;
  cloud.state.securityGroup = null;
  try {
    const before = cloud.state.calls.length;
    const a = await p.ensureSecurityGroup({ region: 'ap-southeast-1', name: 'mk-sg-reuse' });
    const b = await p.ensureSecurityGroup({ region: 'ap-southeast-1', name: 'mk-sg-reuse' });
    const creates = cloud.state.calls
      .slice(before)
      .filter((c) => String(c.body || '').includes('Action=CreateSecurityGroup')).length;
    assert.equal(a.id, 'sg-1');
    assert.equal(b.id, 'sg-1', '第二次必须复用同一个（取不到 id 就会再建一个）');
    assert.equal(creates, 1, `只允许创建一次（实际 ${creates} 次）`);
  } finally {
    cloud.state.securityGroup = prev;
  }
});
