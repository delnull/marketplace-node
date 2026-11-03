/**
 * 假云（测试用）—— 按四家**官方文档里的真实响应形状**回话，让适配器与整条编排都能被真跑一遍。
 *
 * 为什么值得写这么一层：这些适配器最难的从来不是"发请求"，而是**解析响应**与
 * **判据落在哪一层**（余额够不够、模板审没审、域名在不在、机器起没起来）。
 * 拿 mock 断言"调用了几次"没有意义；拿真实响应形状喂进去、断言"结论对不对"才有意义 ——
 * 后者能在没有云账号的情况下把"钱"和"停机"这两类风险挡在代码评审阶段。
 *
 * 覆盖面与刻意的不覆盖：
 *   · 阿里云：**完整**（账号/余额/模板/镜像/安全组/机器/询价/DNS/域名任务全走通）；
 *   · 腾讯云/AWS：覆盖 check 路径（凭据+余额+已有资源+域名前置），够验证签名与解析。
 */
import http from 'node:http';

/** 固定“服务器状态”：先 pending，被查过一次之后变 running */
export function createFakeCloud(overrides = {}) {
  const state = {
    /** 账号里已有哪些机器（判据：名字相同就拒绝重复下单） */
    servers: [],
    /** 账号里已有哪些域名 */
    domains: [],
    /** 实名信息模板（空数组 = 账号没就绪，买域名会被前置拦下） */
    templates: [{ id: 'tmpl-ok-1', status: 'SUCCEED', emailVerified: true, valid: true }],
    balance: 5000,
    /** ECS 的描述调用次数（用来模拟"查几次之后机器就 running"） */
    describeInstancesCalls: 0,
    /** 记录所有收到的请求，供测试断言"该调的调了、不该调的没调" */
    calls: [],
    /** 询价返回值 */
    hourlyPrice: 0.08,
    /** 询价返回的币种；设成 undefined 可模拟"服务商没回币种"（那时要按国际站口径标 USD） */
    priceCurrency: 'CNY',
    /** 设为 [] 可模拟"账号里一个 VPC 都没有"（走自己建 VPC 那条路） */
    vpcs: undefined,
    /**
     * 设 true 时模拟"账号里没有 VPC，且 CreateVpc 之后子网还没就绪"：
     * 建之前 DescribeVpcs/DescribeVSwitches 都回空，CreateVpc 之后才有内容。
     * 用来验"建完 VPC 必须等它 Available 再建交换机"这条异步时序（否则 IncorrectVpcStatus）。
     */
    describeDomainFails: false,
    /** 设 true 时 `QueryDomainList` 回 403（模拟"读不到账号里的域名"；见该分支的说明） */
    queryDomainsFails: false,
    /** 设 true 时 `QueryTaskDetailList` 回 500（钉住"读不到任务状态 ≠ 任务结束"，见该分支说明） */
    domainTaskFails: false,
    /** 非空时按真实分页语义回话（见 DescribeInstances 那段）：用来验「漏页」这类缺陷 */
    instancePages: null,
    vpcFlow: false,
    vpcCreated: false,
    domainPrice: 55,
    /**
     * 域名询价的币种。默认 CNY（腾讯云国际站按人民币报）；
     * 阿里云国际站的 CheckDomain 固定按 **USD** 报价，所以涉及阿里云买域名的用例要把它切成 USD
     * —— 那正好会走到"币种不是元 ⇒ 闸门要求人自己换算"这条判据上。
     */
    domainCurrency: 'CNY',
    domainAvailable: true,
    zoneRecords: new Map(), // `${zone}/${rr}` → value
    zones: new Map(), // zoneName → { id, nameservers }
    ...overrides,
  };

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://x');
    // 被 PROVISION_API_BASE 改写过的请求带 x-mock-host（原主机名）——适配器写的是真实 endpoint，
    // 假云靠这个头判断"它本来想找谁"
    const host = req.headers['x-mock-host'] ?? url.host ?? 'localhost';
    state.calls.push({ host, url: req.url, body, headers: req.headers });

    const send = (code, text, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(text);
    };

    try {
      // ── 阿里云：表单编码，响应是扁平 JSON（错误靠 HTTP 状态 + Code 字段） ──
      if (/aliyuncs\.com$/.test(host.split(':')[0])) {
        const p = new URLSearchParams(body);
        const action = p.get('Action');
        const out = aliyunAction(action, p, state);
        if (out.status && out.status !== 200) return send(out.status, JSON.stringify(out.json));
        return send(200, JSON.stringify(out.json ?? out));
      }

      // ── 腾讯云：**失败也是 200**，错误在 Response.Error 里 ──
      // 域名走国际站（domain.intl.tencentcloudapi.com），所以动作名是 *Intl* 那一套；
      // 这里按主机名分流，能顺带验证"适配器确实打的是国际站端点"
      if (/tencentcloudapi\.com$/.test(host.split(':')[0])) {
        const action = req.headers['x-tc-action'];
        const out = tencentAction(action, JSON.parse(body || '{}'), state);
        return send(200, JSON.stringify({ Response: out }));
      }

      // ── AWS：EC2/STS 是 XML，Route53 是 JSON ──
      if (/amazonaws\.com$/.test(host.split(':')[0])) {
        const p = new URLSearchParams(body);
        if (host.startsWith('ec2.')) return send(200, awsEc2Xml(p.get('Action'), p, state), 'text/xml');
        if (host.startsWith('sts.')) return send(200, `<?xml version="1.0"?><GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/mk</Arn><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`, 'text/xml');
        const out = awsJson(req.headers['x-amz-target'], JSON.parse(body || '{}'), state);
        return send(200, JSON.stringify(out));
      }

      send(404, JSON.stringify({ Code: 'NoSuchEndpoint', Message: host }));
    } catch (e) {
      send(500, JSON.stringify({ Code: 'InternalError', Message: e.message }));
    }
  });

  return {
    state,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
    /**
     * 关掉假云。
     *
     * 必须显式 closeAllConnections：undici（Node 内建 fetch）默认**保持连接**，
     * 而 `server.close()` 只停止接受新连接、要等已有连接自己结束 —— 于是"用例全绿，
     * 但测试进程永远不退出"。这个坑的表现极具误导性：报告里一条失败都没有。
     */
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

/* ── 阿里云 ───────────────────────────────────────────────────────────────── */
function aliyunAction(action, p, s) {
  const region = p.get('RegionId') ?? 'cn-hongkong';
  switch (action) {
    case 'GetCallerIdentity':
      return { AccountId: '1234567890', Arn: 'acs:ram::1234567890:user/mk', IdentityType: 'RAMUser' };
    case 'QueryAccountBalance':
      return { Code: '200', Success: true, Data: { AvailableAmount: String(s.balance), AvailableCashAmount: String(s.balance), Currency: 'CNY' } };
    case 'DescribeRegions':
      return { Regions: { Region: [{ RegionId: 'cn-hongkong' }, { RegionId: 'ap-southeast-1' }] } };
    case 'DescribeVpcs':
      if (s.vpcs) return { Vpcs: { Vpc: s.vpcs } };
      if (s.vpcFlow && !s.vpcCreated) return { Vpcs: { Vpc: [] } };
      return { Vpcs: { Vpc: [{ VpcId: s.vpcFlow ? 'vpc-made-1' : 'vpc-default-1', IsDefault: !s.vpcFlow }] } };
    case 'CreateVpc':
      s.vpcCreated = true;
      return { VpcId: 'vpc-made-1' };
    case 'CreateVSwitch':
      return { VSwitchId: 'vsw-made-1' };
    case 'DescribeVpcAttribute':
      return { VpcId: p.get('VpcId'), Status: 'Available' };
    case 'DescribeVSwitches':
      if (s.vpcFlow && !s.vpcCreated) return { VSwitches: { VSwitch: [] } };
      return { VSwitches: { VSwitch: [{ VSwitchId: 'vsw-1' }] } };
    case 'DescribeZones':
      return { Zones: { Zone: [{ ZoneId: `${region}-a` }] } };
    case 'DescribeSecurityGroups':
      return { SecurityGroups: { SecurityGroup: s.securityGroup ? [{ SecurityGroupId: 'sg-1', SecurityGroupName: s.securityGroup }] : [] } };
    case 'CreateSecurityGroup':
      s.securityGroup = p.get('SecurityGroupName');
      return { SecurityGroupId: 'sg-1' };
    case 'AuthorizeSecurityGroup':
      return {};
    case 'DescribeImages':
      return { Images: { Image: [{ ImageId: 'ubuntu_22_04_x64_20G_alibase_20260101.vhd', OSName: 'Ubuntu 22.04 64位' }] } };
    case 'ImportKeyPair':
      s.importedKey = p.get('KeyPairName');
      return {};
    case 'RunInstances':
      s.servers.push({ id: 'i-fake-1', name: p.get('InstanceName'), status: 'Pending', region, instanceType: p.get('InstanceType') });
      return { InstanceIdSets: { InstanceIdSet: ['i-fake-1'] }, RequestId: 'r' };
    case 'DescribeInstances': {
      s.describeInstancesCalls++;
      /*
        instancePages 非空时按**真实分页语义**回话：TotalCount 是总条数、每页只回 PageSize 条，
        且翻页要带 PageNumber。这是为了能验"漏页 ⇒ 判成没有同名机器 ⇒ 再买一台"这个缺陷 ——
        假云若不模拟分页，任何翻页缺陷都测不出来（绿着但真实会重复下单）。
      */
      if (Array.isArray(s.instancePages)) {
        const page = Number(p.get('PageNumber') ?? 1);
        const rows = s.instancePages[page - 1] ?? [];
        return {
          Instances: {
            Instance: rows.map((x) => ({
              ...x,
              RegionId: region,
              VpcAttributes: { PrivateIpAddress: { IpAddress: ['172.16.0.5'] } },
            })),
          },
          PageNumber: page,
          PageSize: 100,
          TotalCount: s.instancePages.flat().length,
        };
      }
      // 第一次查还在 Pending，之后 running 并带上公网 IP（云控制台就是这个节奏）
      if (s.describeInstancesCalls > 1) for (const x of s.servers) { x.status = 'Running'; x.publicIp = '203.0.113.10'; }
      return {
        Instances: {
          Instance: s.servers.map((x) => ({
            InstanceId: x.id,
            InstanceName: x.name,
            Status: x.status,
            RegionId: region,
            InstanceType: x.instanceType,
            PublicIpAddress: x.publicIp ? { IpAddress: [x.publicIp] } : undefined,
            VpcAttributes: { PrivateIpAddress: { IpAddress: ['172.16.0.5'] } },
          })),
        },
        TotalCount: s.servers.length,
      };
    }
    case 'DeleteInstance':
      s.servers = s.servers.filter((x) => x.id !== p.get('InstanceId'));
      return {};
    case 'DescribePrice':
      return { PriceInfo: { Price: { TradePrice: s.hourlyPrice, ...(s.priceCurrency ? { Currency: s.priceCurrency } : {}) } } };
    // Alidns
    case 'DescribeDomains':
      return { Domains: { Domain: [...s.zones.entries()].map(([name, z]) => ({ DomainName: name, DomainId: z.id, DnsServers: { DnsServer: z.nameservers } })) }, TotalCount: s.zones.size };
    case 'AddDomain': {
      const name = p.get('DomainName');
      s.zones.set(name, { id: `d-${name}`, nameservers: ['ns1.alidns.com', 'ns2.alidns.com'] });
      return { DomainName: name, DomainId: `d-${name}`, DnsServers: { DnsServer: ['ns1.alidns.com', 'ns2.alidns.com'] } };
    }
    case 'DescribeDomainRecords': {
      const key = `${p.get('DomainName')}/${p.get('RRKeyWord')}`;
      const value = s.zoneRecords.get(key);
      return { DomainRecords: { Record: value ? [{ RecordId: 'rec-1', RR: p.get('RRKeyWord'), Type: 'A', Value: value, TTL: 600 }] : [] } };
    }
    case 'AddDomainRecord': {
      s.zoneRecords.set(`${p.get('DomainName')}/${p.get('RR')}`, p.get('Value'));
      return { RecordId: 'rec-1' };
    }
    case 'UpdateDomainRecord':
      return { RecordId: p.get('RecordId') };
    // Domain（注册商）
    case 'QueryRegistrantProfiles':
      return { RegistrantProfiles: { RegistrantProfile: s.templates.map((t) => ({ RegistrantProfileId: t.id, RealNameStatus: t.status, EmailVerificationStatus: t.emailVerified ? '1' : '0' })) }, TotalItemNum: s.templates.length };
    case 'QueryDomainList':
      /*
        `queryDomainsFails = true` 时回一个**非 200**（真实世界：403/限流/网络）。
        为什么要能造这个：假云此前**从不返回非 200**，于是"读不到域名列表"这条路径
        （以及 http.mjs 里处理非 2xx 的那整段分类逻辑）在测试里根本走不到 ——
        实测代价是 `lib/http.mjs` 里一个未导入的 `classify` 一直没被发现（2026-10-15 审计）。
      */
      if (s.queryDomainsFails) return { status: 403, json: { Code: 'Forbidden', Message: 'fake cloud: QueryDomainList 故意失败' } };
      return { Data: { Domain: s.domains.map((d) => ({ DomainName: d, DomainStatus: '3' })) }, TotalItemNum: s.domains.length };
    case 'CheckDomain':
      return {
        Avail: s.domainAvailable ? '1' : '0',
        Reason: s.domainAvailable ? null : 'Domain is not available',
        Premium: false,
        // 币种以**服务商实际返回的**为准（真实世界正是这样：FeeCurrency 只是请求，回什么由服务商定）
        StaticPriceInfo: { PriceInfo: [{ action: 'activate', money: s.domainPrice * Number(p.get('FeePeriod') ?? 1), currency: s.domainCurrency, period: Number(p.get('FeePeriod') ?? 1) }] },
      };
    case 'SaveSingleTaskForCreatingOrderActivate':
      s.domainOrder = { taskId: 'task-1', domain: p.get('DomainName'), templateId: p.get('RegistrantProfileId') };
      s.domains.push(p.get('DomainName'));
      return { TaskNo: 'task-1', RequestId: 'r' };
    case 'QueryTaskDetailList':
      /*
        `domainTaskFails = true` 时回 500（真实世界：限流/超时/权限）。
        用来钉住"读不到任务状态 ≠ 任务结束"这条判据（2026-10-15 审计 F7）：
        旧实现读失败就静默跳出轮询，而屏幕上最后一行还是「已提交注册任务」——
        用户以为流程走完了，真相是状态一次都没读到。
      */
      if (s.domainTaskFails) return { status: 500, json: { Code: 'InternalError', Message: 'fake cloud: QueryTaskDetailList 故意失败' } };
      return { Data: { TaskDetail: [{ TaskNo: p.get('TaskNo'), DomainName: s.domainOrder?.domain, TaskStatus: 'EXECUTE_SUCCESS', TaskStatusCode: 2 }] } };
    default:
      return { status: 400, json: { Code: 'InvalidAction', Message: `fake cloud 没有实现 ${action}` } };
  }
}

/* ── 腾讯云 ───────────────────────────────────────────────────────────────── */
function tencentAction(action, params, s) {
  const ok = (obj) => ({ RequestId: 'req-1', ...obj });
  switch (action) {
    case 'DescribeRegions':
      return ok({ TotalCount: 2, RegionSet: [{ Region: 'ap-hongkong', RegionName: '香港', RegionState: 'AVAILABLE' }] });
    case 'DescribeAccountBalance':
      // 单位是**分**
      return ok({ Balance: s.balance * 100, RealBalance: s.balance * 100, CashAccountBalance: s.balance * 100, FreezeAmount: 0, OweAmount: 0 });
    case 'DescribeInstances':
      return ok({ TotalCount: s.servers.length, InstanceSet: s.servers.map((x) => ({ InstanceId: x.id, InstanceName: x.name, InstanceState: x.status === 'Running' ? 'RUNNING' : 'PENDING', PublicIpAddresses: x.publicIp ? [x.publicIp] : null, PrivateIpAddresses: ['10.0.0.5'], InstanceType: x.instanceType })) });
    case 'DescribeImages':
      return ok({ TotalCount: 1, ImageSet: [{ ImageId: 'img-ubuntu2204', ImageName: 'Ubuntu Server 22.04 LTS 64bit', Platform: 'Ubuntu', ImageState: 'NORMAL' }] });
    /*
      DescribeRecordList 按官方语义回话：**ErrorOnEmpty 默认 yes ⇒ 查不到就报错**。
      这条不模拟出来的话，"没带 ErrorOnEmpty=no"这个缺陷在测试里完全看不见
      （真实世界表现为：还没有 A 记录时轮询直接抛错，被当成硬失败）。
    */
    case 'DescribeRecordList': {
      const rows = [...s.zoneRecords.entries()]
        .filter(([k]) => k.startsWith(`${params.Domain}/`))
        .map(([k, v], i) => ({ RecordId: 100 + i, Name: k.split('/')[1], Type: 'A', Value: v, TTL: 600 }));
      const hit = rows.filter((r) => r.Name === params.SubDomain);
      if (!hit.length && params.ErrorOnEmpty !== 'no') {
        return { Error: { Code: 'ResourceNotFound.NoDataOfRecord', Message: '记录列表为空。' }, RequestId: 'req-1' };
      }
      return ok({ RecordCountInfo: { SubdomainCount: hit.length, TotalCount: hit.length, ListCount: hit.length }, RecordList: hit });
    }
    case 'CreateRecord':
      s.zoneRecords.set(`${params.Domain}/${params.SubDomain ?? '@'}`, params.Value);
      return ok({ RecordId: 101 });
    case 'ModifyRecord':
      return ok({ RecordId: params.RecordId });
    case 'CreateDomain':
      return ok({ DomainInfo: { Id: 1, Domain: params.Domain, GradeNsList: ['ns1.dnspod.net', 'ns2.dnspod.net'] } });
    case 'DescribeDomain': {
      const zn = [...s.zones.keys()].find((z) => z === params.Domain);
      /*
        describeDomainFails=true 时回一个**不该被吞掉**的错误：适配器只允许把
        "域名没注册"（ResourceNotFound.DomainNotReged）当成"还没有这个区"，
        其它失败必须原样上抛 —— 这条正好验它没把鉴权失败也吞下去。
      */
      if (s.describeDomainFails) return { Error: { Code: 'AuthFailure.SignatureFailure', Message: '签名失败' }, RequestId: 'req-1' };
      if (!zn) return { Error: { Code: 'ResourceNotFound.DomainNotReged', Message: '域名还没有注册' }, RequestId: 'req-1' };
      return ok({ DomainInfo: { DomainId: 1, DnspodNsList: ['ns1.dnspod.net', 'ns2.dnspod.net'] } });
    }
    case 'ImportKeyPair':
      if (!/^[A-Za-z0-9_]{1,25}$/.test(String(params.KeyName ?? ''))) {
        // 真实错误码：密钥名只支持英文、数字和下划线，长度不超过 25
        return { Error: { Code: 'InvalidKeyPairNameIncludeIllegalChar', Message: '密钥名称只支持英文、数字和下划线' }, RequestId: 'req-1' };
      }
      s.importedKey = params.KeyName;
      return ok({ KeyId: 'skey-fake-1' });
    case 'DescribeSecurityGroups':
      return ok({ TotalCount: s.securityGroup ? 1 : 0, SecurityGroupSet: s.securityGroup ? [{ SecurityGroupId: 'sg-1', SecurityGroupName: s.securityGroup }] : [] });
    case 'CreateSecurityGroup':
      s.securityGroup = params.GroupName;
      return ok({ SecurityGroup: { SecurityGroupId: 'sg-1', SecurityGroupName: params.GroupName } });
    case 'CreateSecurityGroupPolicies':
      if (params.SecurityGroupPolicySet?.Version !== undefined) {
        // 版本号写死时的真实错误：与当前最新版本不一致
        return { Error: { Code: 'UnsupportedOperation.VersionMismatch', Message: '指定安全组规则版本号和当前最新版本不一致' }, RequestId: 'req-1' };
      }
      return ok({});
    case 'RunInstances':
      s.servers.push({ id: 'ins-fake-1', name: params.InstanceName, status: 'Running', instanceType: params.InstanceType, publicIp: '203.0.113.30' });
      return ok({ InstanceIdSet: ['ins-fake-1'] });
    /*
      以下这几个"国际站域名"接口的形状**按官方文档逐字段抄**（域名的参数名与响应字段名
      与中国站不同，是这次核对中真查出问题的地方），所以假云在这里刻意把
      **必填参数缺失**当成错误回报 —— 参数名写错时测试会红，而不是悄悄返回一个空列表。
    */
    case 'DescribeIntlTemplateList':
      // 官方输出参数：TemplateSet[].{TemplateId, RegistrantContact, ..., IsDefault}；**没有审核状态**
      return ok({ TotalCount: s.templates.length, TemplateSet: s.templates.map((t) => ({ TemplateId: t.id, IsDefault: t.isDefault ? 1 : 0 })) });
    case 'DescribeIntlDomainList':
      // 官方输出参数：DomainSet[].{DomainName, Status, DomainStatus[], AutoRenew(int), ExpirationDate, ...}
      return ok({ TotalCount: s.domains.length, DomainSet: s.domains.map((d) => ({ DomainName: d, Status: 'ok', AutoRenew: 0 })) });
    case 'CheckIntlDomainNew':
      // 官方必填参数是 **Domain**（不是 DomainName）
      if (!params.Domain) return { Error: { Code: 'MissingParameter.DomainIsEmpty', Message: 'The domain cannot be empty.' }, RequestId: 'req-1' };
      return ok({ DomainName: params.Domain, Available: s.domainAvailable, Reason: s.domainAvailable ? '' : '已被注册', Premium: false, Price: s.domainPrice, RealPrice: s.domainPrice, Period: Number(params.Period ?? 1) });
    case 'DescribeIntlDomainPriceNewList':
      return ok({ PriceList: [{ Tld: '.com', Year: 1, Price: s.domainPrice, RealPrice: s.domainPrice, Operation: 'new' }] });
    case 'CreateIntlDomainBatch':
      // 官方必填四项：TemplateId / Period / Domains.N / PayMode
      if (!params.TemplateId) return { Error: { Code: 'MissingParameter.TemplateIdIsEmpty', Message: 'The profile ID is empty or invalid.' }, RequestId: 'req-1' };
      s.domainOrder = { templateId: params.TemplateId, domains: params.Domains, payMode: params.PayMode, autoRenew: params.AutoRenewFlag };
      s.domains.push(...params.Domains);
      return ok({ LogId: 318 });
    case 'DescribeIntlDomainBatchDetails':
      // 官方输出参数：DomainBatchDetailSet[].{Domain, Status, Reason, Action, Id}
      return ok({
        TotalCount: 1,
        // detailStatus 可切换：用来验「空 / 未知状态不能算成功」（官方取值 SUCCESS / FAILURE，另有进行中状态）
        DomainBatchDetailSet: [{ Domain: s.domainOrder?.domains?.[0], Status: 'detailStatus' in (s.domainOrder ?? {}) ? s.domainOrder.detailStatus : 'SUCCESS', Reason: s.domainOrder?.failed ? '注册局拒绝' : '' }],
      });
    case 'InquiryPriceRunInstances':
      /*
        官方形状：`Price` 里 InstancePrice / BandwidthPrice 都是 **ItemPrice**
        （UnitPrice=原价、UnitPriceDiscount=折扣价、ChargeUnit）。假云按这个形状回话，
        好让"该用折扣价""该看 ChargeUnit"这些判断在测试里真的被走到。
      */
      return ok({
        Price: {
          InstancePrice: { UnitPrice: 0.12, UnitPriceDiscount: 0.1, ChargeUnit: 'HOUR' },
          BandwidthPrice: { UnitPrice: 0.06, ChargeUnit: 'HOUR' },
        },
      });
    case 'DescribeZones':
      return ok({ TotalCount: 1, ZoneSet: [{ Zone: 'ap-hongkong-1', ZoneState: 'AVAILABLE' }] });
    default:
      return { Error: { Code: 'InvalidAction', Message: `fake cloud 没有实现 ${action}` }, RequestId: 'req-1' };
  }
}

/* ── AWS ──────────────────────────────────────────────────────────────────── */
function awsEc2Xml(action, p, s) {
  const wrap = (inner) => `<?xml version="1.0" encoding="UTF-8"?>\n<${action}Response xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">${inner}</${action}Response>`;
  switch (action) {
    case 'DescribeInstances': {
      /*
        令牌分页（2026-10-15 审计 F4 的判据）：`instanceTokenPages = true` 时第一页回一个
        `nextToken`，带着它再来才给第二页。用来钉住"下一令牌必须来自**上一次响应**"——
        旧实现把页号当 NextToken 发（第一次请求就带 `NextToken=1`，EC2 会回 InvalidNextToken），
        而假云原先不看这个参数，所以那个缺陷一直没被发现。
        同时拒绝明显非法的令牌：非法就按真实 EC2 的 `InvalidNextToken` 报错，
        这样"拿页号当令牌"会在测试里立刻显形，而不是等真机。
      */
      const token = p.get('NextToken');
      if (token && !/^tok-\d+$/.test(String(token))) {
        return `<?xml version="1.0" encoding="UTF-8"?><Response><Errors><Error><Code>InvalidNextToken</Code><Message>The specified NextToken is not valid.</Message></Error></Errors><RequestID>r-fake</RequestID></Response>`;
      }
      if (s.instanceTokenPages) {
        const page = token ? Number(String(token).replace('tok-', '')) : 1;
        const per = 1;
        const slice = s.servers.slice((page - 1) * per, page * per);
        const more = s.servers.length > page * per;
        return wrap(
          `<reservationSet>${slice
            .map(
              (x) => `<item><reservationId>r-${page}</reservationId><instancesSet><item><instanceId>${x.id}</instanceId><instanceState><code>16</code><name>running</name></instanceState><ipAddress>${x.publicIp ?? ''}</ipAddress><privateIpAddress>172.31.1.5</privateIpAddress><instanceType>${x.instanceType}</instanceType><tagSet><item><key>Name</key><value>${x.name}</value></item></tagSet></item></instancesSet></item>`
            )
            .join('')}</reservationSet>${more ? `<nextToken>tok-${page + 1}</nextToken>` : ''}`
        );
      }
      return wrap(
        `<reservationSet>${s.servers
          .map(
            (x) => `<item><reservationId>r-1</reservationId><instancesSet><item><instanceId>${x.id}</instanceId><instanceState><code>16</code><name>running</name></instanceState><ipAddress>${x.publicIp ?? ''}</ipAddress><privateIpAddress>172.31.1.5</privateIpAddress><instanceType>${x.instanceType}</instanceType><tagSet><item><key>Name</key><value>${x.name}</value></item></tagSet></item></instancesSet></item>`
          )
          .join('')}</reservationSet>`
      );
    }
    /*
      DescribeSubnets：官方响应是 subnetSet > item，而 item 里**还有嵌套的 item**
      （cidrBlockAssociationSet / ipv6CidrBlockAssociationSet / tagSet 各有一层 item），
      所以"取第一个 item 的 subnetId"必须按层取 —— 这正是我们的 XML 解析器存在的理由。
    */
    case 'DescribeSubnets':
      if (s.emptySubnets) return wrap('<subnetSet/>');
      return wrap(
        '<subnetSet><item><subnetId>subnet-default-1</subnetId><state>available</state><defaultForAz>true</defaultForAz><availabilityZone>ap-southeast-1a</availabilityZone>' +
          '<cidrBlockAssociationSet><item><associationId>subnet-cidr-assoc-1</associationId><cidrBlock>172.31.0.0/20</cidrBlock></item></cidrBlockAssociationSet>' +
          '<tagSet><item><key>Name</key><value>default</value></item></tagSet>' +
          '</item></subnetSet>'
      );
    case 'DescribeImages':
      return wrap('<imagesSet><item><imageId>ami-ubuntu2404</imageId><name>ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server-20260101</name><imageState>available</imageState><architecture>x86_64</architecture></item></imagesSet>');
    case 'DescribeSecurityGroups':
      return s.securityGroup ? wrap(`<securityGroupInfo><item><groupId>sg-1</groupId><groupName>${s.securityGroup}</groupName></item></securityGroupInfo>`) : wrap('<securityGroupInfo/>');
    case 'CreateSecurityGroup':
      s.securityGroup = p.get('GroupName');
      return wrap('<groupId>sg-1</groupId>');
    case 'AuthorizeSecurityGroupIngress':
      return wrap('<return>true</return>');
    case 'ImportKeyPair':
      return wrap('<keyName>k</keyName><keyFingerprint>f</keyFingerprint>');
    case 'RunInstances':
      s.servers.push({ id: 'i-aws-1', name: p.get('TagSpecification.1.Tag.1.Value'), status: 'running', instanceType: p.get('InstanceType'), publicIp: '203.0.113.20' });
      return wrap('<instancesSet><item><instanceId>i-aws-1</instanceId><instanceState><code>0</code><name>pending</name></instanceState></item></instancesSet>');
    case 'TerminateInstances':
      s.servers = [];
      return wrap('<instancesSet><item><instanceId>i-aws-1</instanceId></item></instancesSet>');
    default:
      return wrap(`<Errors><Error><Code>InvalidAction</Code><Message>fake cloud 没有实现 ${action}</Message></Error></Errors>`);
  }
}

function awsJson(target, body, s) {
  if (target?.includes('CheckDomainAvailability')) return { Availability: s.domainAvailable ? 'AVAILABLE' : 'UNAVAILABLE' };
  if (target?.includes('ListPrices'))
    /*
      官方形状（botocore 的 ListPrices 文档）：`Prices[]` 的每一项是 **DomainPrice**，
      `Name` 是 **TLD 名**（带点，如 `.com`），价钱在 `RegistrationPrice: {Currency, Price}` 里。
      旧夹具写的是扁平形状 + `Name: 'Registration'`——那是**已被纠正过的旧口径**
      （见 providers/aws.mjs 里那段注释），于是 AWS 询价在测试里恒为 `yearly: null`，
      并把"响应被当 XML 解析、每个字段都读不到"这个真实缺陷一起盖住了（2026-10-15 审计 F8）。
    */
    return { Prices: [{ Name: '.com', RegistrationPrice: { Currency: 'USD', Price: 13 } }] };
  if (target?.includes('ListDomains')) return { Domains: s.domains.map((d) => ({ DomainName: d })) };
  if (target?.includes('RegisterDomain')) {
    s.domains.push(body.DomainName);
    return { OperationId: 'op-1' };
  }
  if (target?.includes('GetOperationDetail')) return { OperationId: 'op-1', Status: 'SUCCESSFUL' };
  if (target?.includes('GetCostAndUsage')) return { ResultsByTime: [] };
  if (target?.includes('ListHostedZonesByName')) return { HostedZones: [] };
  if (target?.includes('CreateHostedZone')) return { HostedZone: { Id: '/hostedzone/Z1' }, DelegationSet: { NameServers: ['ns-1.awsdns.com', 'ns-2.awsdns.com'] } };
  return {};
}
