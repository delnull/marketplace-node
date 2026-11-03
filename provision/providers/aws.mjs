/**
 * AWS 适配器（EC2 + Route 53 + Route 53 Domains）。
 *
 * ── 这里有**四种**协议形状，不是一种（这是本文件最该先读的一段）──────────────
 *   1. EC2：**Query 协议** —— `POST /` + `application/x-www-form-urlencoded`，响应 **XML**；
 *   2. STS：同 1（Query + XML）；
 *   3. Route 53：**REST-XML** —— `GET/POST /2013-04-01/<资源路径>`，路径与查询串带参数，
 *      变更类动作（CreateHostedZone / ChangeResourceRecordSets）用 **XML 请求体**，响应也是 XML。
 *      （它**没有** `X-Amz-Target` 这种东西；早先按 JSON 协议写的那一版整条 DNS 路径都是 404。）
 *   4. Route 53 Domains：**JSON 协议** —— `POST /` + `application/x-amz-json-1.1` +
 *      `X-Amz-Target: Route53Domains_v20140515.<Action>`。
 *
 * ── SigV4 的 service 必须是**小写服务码** ────────────────────────────────────
 *   ec2 / sts / route53 / route53domains —— 而不是 `Route53`、`Route53Domains` 这种驼峰名。
 *   官方原文："The Region code, service code, and termination string must use lowercase characters."
 *   签错的表现是 403 SignatureDoesNotMatch（看起来像密钥问题）。
 *
 * ── AWS 没有"账户余额"这个接口（不要假装有）─────────────────────────────────
 * 计费模型是先用后付、月末出账。所以余额如实返回 null 并说明原因；
 * 更不拿 `ListPrices` 这种"能读价目表"的接口去冒充"账号能付款"的判据（它证明不了任何事）。
 *
 * ── 域名注册这条路**不是完全无人值守**（官方文档写明）─────────────────────────
 * ICANN 要求注册人邮箱验证：注册局会发验证邮件，**收件人必须点确认，否则域名会被挂起**
 * （"the registrant contact must follow the instructions in the email … or Route 53 must
 * suspend the domain"）。所以本工具把域名买下来之后，会把这件事明确写进待办里，
 * 而不是宣称"全自动完成"。另外部分 TLD（.ca/.fr/.it/.se/.sg/.uk 等）还要 ExtraParams，
 * 本工具只支持**不需要额外参数**的普通 TLD，遇到需要参数的会由注册局以 TLDRulesViolation 拒绝。
 */
import { createHash, createHmac } from 'node:crypto';
import { CloudError } from '../lib/errors.mjs';
import { apiCall, formBody, qs } from '../lib/http.mjs';
import { defineProvider } from '../lib/provider.mjs';
import { fetchAllPages } from '../lib/paginate.mjs';
import { child, childText, findAll, parseXml, pathText } from '../lib/xml.mjs';

/** 非中国大陆区域（我们只在这些区域开机器）。第一个是默认。 */
const REGIONS = [
  { id: 'ap-southeast-1', label: '新加坡' },
  { id: 'ap-northeast-1', label: '日本（东京）' },
  { id: 'ap-southeast-2', label: '澳大利亚（悉尼）' },
  { id: 'us-west-2', label: '美国（俄勒冈）' },
  { id: 'eu-central-1', label: '德国（法兰克福）' },
];

const INSTANCE_TYPES = ['t4g.nano', 't3.nano', 't3.micro', 't3.small'];
/** Canonical 的官方 AMI owner id（Ubuntu 官方文档口径；AWS 文档未列，故代码里注明来源） */
const UBUNTU_OWNER = '099720109477';
const DOMAINS_HOST = 'route53domains.us-east-1.amazonaws.com'; // 域名注册只有这一个端点
const CS = 'application/x-www-form-urlencoded; charset=utf-8';

/**
 * 每个 service 的**响应协议**（唯一判据；`signed()` 只在这里查）。
 *
 * AWS 不是"一种 API"：EC2/STS 走 Query 协议（表单请求 + XML 响应），Route 53 走 REST-XML，
 * 而 Route 53 Domains 走 **JSON 1.1**（`application/x-amz-json-1.1` + `x-amz-target`）。
 * 协议判错的症状很隐蔽：XML 解析器喂 JSON 体**不抛错**，只是什么都解析不出来，
 * 于是读到的每个字段都是 undefined——"这个域名能不能注册"恒 false、"多少钱"恒 null、
 * 注册任务号恒空（2026-10-15 审计实测：AWS 的域名三条路径一次也没成功过）。
 * 所以这里**必须声明**：`signed()` 查不到就拒绝，而不是退回某个默认解析器。
 */
const PROTOCOL = Object.freeze({
  ec2: 'xml',
  sts: 'xml',
  route53: 'xml', // REST-XML：读 GET + 查询串，写 POST + XML 体
  route53domains: 'json', // JSON 1.1
});

/**
 * 查一个 service 的响应协议；**没声明就拒绝**（判据只有 PROTOCOL 一份，`signed()` 也走这里）。
 *
 * 为什么单独一个导出函数：这条判据要能被单测直接钉住。藏在 `signed()` 里时，
 * "未声明的 service 会怎样"只能靠造一个永不发生的调用去探——那样的用例是空转的
 * （2026-10-15 审计在同一批里就抓到过这种形状）。
 */
export function protocolOf(service) {
  const p = PROTOCOL[service];
  if (!p) {
    throw new CloudError(
      'invalid',
      `aws: 没有声明 ${service} 的响应协议（见 providers/aws.mjs 的 PROTOCOL）——` +
        '不猜：协议猜错不会报错，只会让读到的每个字段变成 undefined',
      { provider: 'aws' }
    );
  }
  return p;
}

export function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}
export function hmac(key, s) {
  return createHmac('sha256', key).update(s).digest();
}

/**
 * 纯函数：SigV4 签名（有单测）。
 * @param {{method:string, host:string, path:string, query:Record<string,string>, headers:Record<string,string>, payload:string, region:string, service:string, accessKeyId:string, accessKeySecret:string, sessionToken?:string, now?:Date}} o
 */
export function signV4(o) {
  const now = o.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    ...o.headers,
    host: o.host,
    'x-amz-date': amzDate,
    ...(o.sessionToken ? { 'x-amz-security-token': o.sessionToken } : {}),
  };
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const signedHeaders = Object.keys(lower).sort();
  const canonicalHeaders = signedHeaders.map((k) => `${k}:${lower[k]}\n`).join('');
  // 查询串按 RFC3986 编码后按 key 排序（Route 53 的参数走 URL，这一步必须精确）
  const canonicalQuery = Object.keys(o.query ?? {})
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(o.query[k])}`)
    .join('&');
  const canonicalRequest = [o.method, o.path, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), sha256Hex(o.payload ?? '')].join('\n');
  const scope = `${dateStamp}/${o.region}/${o.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${o.accessKeySecret}`, dateStamp);
  const kRegion = hmac(kDate, o.region);
  const kService = hmac(kRegion, o.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}` },
    signedHeaders,
  };
}

/** XML 响应 → 解析树；顺带把错误码挑出来（EC2/Route53 都是 Errors.Error.Code 三层） */
function xmlParse(_res, text) {
  const tree = parseXml(text);
  return { tree, __err: pathText(tree, ['Errors', 'Error', 'Code']) ?? pathText(tree, ['ErrorResponse', 'Error', 'Code']) ?? childText(tree, 'Code') };
}

export function createAws({ accessKeyId, accessKeySecret, sessionToken }) {
  if (!accessKeyId || !accessKeySecret) {
    throw new CloudError('auth', '缺少 AWS 凭据：需要 AWS_ACCESS_KEY_ID 与 AWS_SECRET_ACCESS_KEY');
  }

  async function signed(o) {
    const protocol = protocolOf(o.service);
    const { headers } = signV4({
      method: o.method,
      host: o.host,
      path: o.path,
      query: o.query ?? {},
      headers: o.headers,
      payload: o.payload ?? '',
      region: o.region,
      service: o.service,
      accessKeyId,
      accessKeySecret,
      sessionToken,
    });
    const url = `https://${o.host}${o.path}${Object.keys(o.query ?? {}).length ? `?${qs(o.query)}` : ''}`;
    return apiCall({
      provider: 'aws',
      action: o.action,
      url,
      method: o.method,
      headers,
      body: o.method === 'GET' ? undefined : o.payload,
      attempts: o.attempts,
      /*
        ── 响应协议按 service 选（2026-10-15 审计 F8，唯一判据在 PROTOCOL）──────────
        旧实现**写死** `parse: xmlParse`：EC2/STS/Route53 确实是 XML，但 **Route 53 Domains
        是 JSON 协议**（`application/x-amz-json-1.1`）。XML 解析器喂一份 JSON 体不会抛错，
        它只是什么都解析不出来 ⇒ `Availability`、`Prices`、`OperationId`、`Domains` 全是 undefined
        ⇒ AWS 上"这个域名能不能注册"恒为 false、"多少钱"恒为 null、注册任务号恒读不到
        （那三条路径**一次也没成功过**，而每一处的症状都长得像"服务商没给原因"）。
        所以协议不是一个可以各调用点自己记得的细节：它在 PROTOCOL 里声明一次，这里查一次，
        **没声明的直接拒绝**——猜错协议不会报错，只会让读到的每个字段变成 undefined。
      */
      parse: protocol === 'xml' ? xmlParse : undefined,
      errorCode: protocol === 'xml' ? (x) => x?.__err : undefined,
    });
  }

  /** EC2 / STS：Query 协议（表单 + XML 响应） */
  const ec2 = (region, action, params = {}) =>
    signed({ region, service: 'ec2', host: `ec2.${region}.amazonaws.com`, path: '/', method: 'POST', headers: { 'content-type': CS }, payload: formBody({ Action: action, Version: '2016-11-15', ...params }), action }).then((r) => r.tree);
  const stsQuery = (action) =>
    signed({ region: 'us-east-1', service: 'sts', host: 'sts.amazonaws.com', path: '/', method: 'POST', headers: { 'content-type': CS }, payload: formBody({ Action: action, Version: '2011-06-15' }), action }).then((r) => r.tree);

  /**
   * Route 53：**REST-XML**。
   * 读用 GET + 查询串；写用 POST + XML 体（CreateHostedZone 要 201，ChangeResourceRecordSets 要 200）。
   */
  const route53 = (o) => signed({ ...o, region: 'us-east-1', service: 'route53', host: 'route53.amazonaws.com', ...(o.body ? { headers: { 'content-type': 'text/xml; charset=utf-8' }, payload: o.body, method: 'POST' } : { method: 'GET' }) });

  /** Route 53 Domains：JSON 协议；target 里的版本串是 `v20140515`（带 v，少它会被判未知操作） */
  const domains = (action, body) => {
    const payload = JSON.stringify(body ?? {});
    return signed({
      region: 'us-east-1',
      service: 'route53domains',
      host: DOMAINS_HOST,
      path: '/',
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `Route53Domains_v20140515.${action}` },
      payload,
      action,
    }).then((r) => {
      // JSON 协议的错误码在 __type 里（`InvalidInput` / `com.amazon…#InvalidInput`）
      if (r.__err) throw new CloudError('invalid', `aws:${action} 失败：${r.__err}`, { provider: 'aws', action, code: r.__err, raw: r });
      return r;
    });
  };

  /** 默认子网：RunInstances 不写 SubnetId 就依赖默认 VPC，那不一定存在 */
  async function defaultSubnet(region) {
    const tree = await ec2(region, 'DescribeSubnets', { 'Filter.1.Name': 'default-for-az', 'Filter.1.Value.1': 'true' });
    const subnetId = childText(findAll(tree, 'item')[0] ?? {}, 'subnetId');
    if (!subnetId) {
      throw new CloudError('invalid', `AWS ${region} 里没有默认 VPC 的默认子网 —— 先建一个 VPC+子网，或 --region 换一个区域`, {
        provider: 'aws',
        action: 'DescribeSubnets',
      });
    }
    return subnetId;
  }

  return defineProvider({
    id: 'aws',
    label: 'AWS',
    credentialsHint: 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY（可选 AWS_SESSION_TOKEN）',
    defaultRegion: REGIONS[0].id,
    regions: REGIONS,

    describe: () => ({
      id: 'aws',
      label: 'AWS',
      endpoints: {
        ec2: 'ec2.<region>.amazonaws.com（Query + XML）',
        route53: 'route53.amazonaws.com（REST-XML）',
        route53domains: `${DOMAINS_HOST}（JSON，只有 us-east-1）`,
      },
      regions: REGIONS,
      defaultRegion: REGIONS[0].id,
      instanceTypes: INSTANCE_TYPES,
      image: 'Canonical 官方 Ubuntu 24.04 AMI（owner 099720109477）实时查，按创建时间取最新',
      domainRegistrar: true,
      notes: [
        '**AWS 没有"账户余额"接口**（先用后付）：本工具因此不做余额闸门，只做价格闸门。',
        '域名走 Route 53 Domains（境外注册商，**不能做 ICP 备案**），无需中国式实名；但 **ICANN 要求注册人邮箱点确认**，' +
          '不确认域名会被挂起 —— 下单后请查收 --email 那封信并点确认。',
        '域名注册是异步操作（OperationId）：状态里可能出现 PENDING_CUSTOMER_ACTION 这类"等人确认"，不是失败。',
        't4g.* 是 ARM（Graviton），镜像里有 node:24-slim（多架构），更便宜；t3.* 是 x86。',
      ],
    }),

    /* ── 账号 ────────────────────────────────────────────────────────────── */
    async account() {
      const out = { balance: null, currency: 'USD', warnings: [] };
      // GetCallerIdentity：唯一"只验证钥匙"的接口（不需要任何 IAM 权限）
      const ident = await stsQuery('GetCallerIdentity');
      const result = child(ident, 'GetCallerIdentityResult') ?? ident;
      out.identity = { accountId: childText(result, 'Account'), arn: childText(result, 'Arn') };
      out.warnings.push('AWS 不提供账户余额查询（先用后付、月末出账）—— 能不能下单取决于绑定的付款方式，不是余额数字；本工具因此不做余额闸门，只做价格闸门');

      /*
        域名注册的前置：**没有只读接口能证明"账号能付款"**（这也是不再拿 ListPrices 冒充判据的原因 ——
        它只证明接口可用，证明不了付款方式有效）。所以这里只做两件确定的事：
        读一次价目表确认 Route 53 Domains 这个 API 对本账号可用，并把"ICANN 邮箱确认"这条待办说清楚。
      */
      try {
        await domains('ListPrices', { Tld: 'com' });
        out.domainTemplates = [{ id: '(AWS 不需要注册人资料模板)', status: 'usable', valid: true }];
        out.domainBlockers = [];
        out.domainNotes = [
          '注册后注册局会向 --email 发一封 ICANN 验证信：**必须点确认**，否则域名会被挂起（官方文档原文）',
          '账号需要有可用的付款方式；AWS 不收注册费的抵扣额度（credits）',
          '部分 TLD（.ca/.fr/.it/.se/.sg/.uk 等）需要额外参数，本工具只支持不需要额外参数的普通 TLD',
        ];
      } catch (e) {
        out.domainTemplates = null;
        out.domainBlockers = [
          `Route 53 Domains 不可用（${e.kind}）：${e.message}`,
          '常见原因：该区域/账号没有开通 Route 53 Domains、没有可用的付款方式',
          '或改用 --domain <已有的域名>（本工具只建解析，不注册）',
        ];
      }
      return out;
    },

    async listServers(region) {
      const regions = region ? [region] : REGIONS.map((r) => r.id);
      const all = [];
      for (const r of regions) {
        /*
          必须**翻完所有页**（`NextToken`）：resume 的判据（"账号里有没有同名机器"）
          靠这份列表完整 —— 漏一页就会判成"没有"然后再买一台。
          `shutting-down` 也放进过滤器：实例正在关掉时它仍占着名字，
          看不见它就会以为"这个名字空着"，然后拿同一个名字再开一台。
        */
        /*
          ⚠️ `NextToken` 必须来自**上一次响应**，不是页号（2026-10-15 审计 F4）：
          `fetchAllPages` 的契约是 `fetchPage(page)`（页号从 1 开始，见 paginate.mjs），
          旧实现把那个页号直接塞进 `NextToken`，于是**第一次请求就带着 `NextToken=1`** ——
          EC2 对非法令牌回 `InvalidNextToken`，而 `up`/`check`/`plan` 一开头都要列机器。
          假云不看这个参数，所以测试测不到它（这也是它一直没被发现的原因）。
        */
        let nextToken = null;
        const reservations = await fetchAllPages({
          fetchPage: async () => {
            const tree = await ec2(r, 'DescribeInstances', {
              'Filter.1.Name': 'instance-state-name',
              'Filter.1.Value.1': 'pending',
              'Filter.1.Value.2': 'running',
              'Filter.1.Value.3': 'stopping',
              'Filter.1.Value.4': 'stopped',
              'Filter.1.Value.5': 'shutting-down',
              ...(nextToken ? { NextToken: nextToken } : {}),
            });
            nextToken = pathText(tree, ['nextToken']) ?? null; // 供下一页用
            return tree;
          },
          readPage: (tree) => ({
            // 层级是 reservationSet > item(预占) > instancesSet > item(实例)：**必须按层取**
            itemsPath: (x) =>
              findAll(x, 'item').flatMap((reservation) => {
                const instances = child(reservation, 'instancesSet');
                return instances ? findAll(instances, 'item') : [];
              }),
            nextToken: pathText(tree, ['nextToken']) ?? null,
          }),
        });
        for (const inst of reservations.flat()) {
          const id = childText(inst, 'instanceId');
          if (!id) continue;
          const nameTag = findAll(inst, 'item').find((t) => childText(t, 'key') === 'Name');
          all.push({
            id,
            name: nameTag ? childText(nameTag, 'value') : null,
            status: childText(child(inst, 'instanceState') ?? {}, 'name'),
            publicIp: childText(inst, 'ipAddress'),
            privateIp: childText(inst, 'privateIpAddress'),
            region: r,
            instanceType: childText(inst, 'instanceType'),
            createdAt: childText(inst, 'launchTime'),
          });
        }
      }
      return all;
    },

    async listDomains() {
      const out = [];
      let marker;
      // ListDomains 默认只回 20 条（MaxItems 上限 100）+ NextPageMarker：不分页会**静默漏掉**第 21 个之后的域名
      for (let page = 0; page < 20; page++) {
        const r = await domains('ListDomains', { MaxItems: 100, ...(marker ? { Marker: marker } : {}) });
        for (const d of r.Domains ?? []) out.push({ name: d.DomainName, expiresAt: d.Expiry, autoRenew: !!d.AutoRenew });
        marker = r.NextPageMarker;
        if (!marker) break;
      }
      return out;
    },

    /* ── 机器 ────────────────────────────────────────────────────────────── */
    async resolveImage(region) {
      const tree = await ec2(region, 'DescribeImages', {
        'Owner.1': UBUNTU_OWNER,
        'Filter.1.Name': 'name',
        'Filter.1.Value.1': 'ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*',
        'Filter.2.Name': 'state',
        'Filter.2.Value.1': 'available',
        'Filter.3.Name': 'architecture',
        'Filter.3.Value.1': 'x86_64',
      });
      // 官方明说元素顺序**不保证**，所以不能取第一条：按 creationDate 取最新的那个，
      // 否则"能跑"的另一面是"悄悄用了一个很旧的快照"（打补丁落后几个月）。
      const candidates = findAll(tree, 'item')
        .map((i) => ({ id: childText(i, 'imageId'), name: childText(i, 'name'), created: childText(i, 'creationDate') }))
        .filter((x) => x.id);
      if (!candidates.length) {
        throw new CloudError('invalid', `AWS ${region} 上找不到 Ubuntu 24.04 官方 AMI`, { provider: 'aws', action: 'DescribeImages' });
      }
      candidates.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
      return { id: candidates[0].id, name: candidates[0].name, family: 'ubuntu-24.04-amd64' };
    },

    async ensureSecurityGroup({ region, name }) {
      const listed = await ec2(region, 'DescribeSecurityGroups', { 'Filter.1.Name': 'group-name', 'Filter.1.Value.1': name });
      let id = childText(findAll(listed, 'item')[0] ?? {}, 'groupId');
      if (!id) {
        const created = await ec2(region, 'CreateSecurityGroup', { GroupName: name, GroupDescription: 'marketplace-node' });
        id = childText(created, 'groupId');
      }
      for (const port of [22, 80, 443]) {
        try {
          await ec2(region, 'AuthorizeSecurityGroupIngress', {
            GroupId: id,
            'IpPermissions.1.IpProtocol': 'tcp',
            'IpPermissions.1.FromPort': port,
            'IpPermissions.1.ToPort': port,
            'IpPermissions.1.IpRanges.1.CidrIp': '0.0.0.0/0',
          });
        } catch (e) {
          // 重复规则是"已经对了"，不是失败（官方错误码 InvalidPermission.Duplicate）
          if (!/InvalidPermission\.Duplicate/i.test(String(e.code ?? ''))) throw e;
        }
      }
      return { id };
    },

    async createServer({ region, name, instanceType, sshPublicKey, securityGroupId, imageId, userData }) {
      const keyName = `mk-${name}-${Math.random().toString(36).slice(2, 8)}`;
      await ec2(region, 'ImportKeyPair', { KeyName: keyName, PublicKeyMaterial: Buffer.from(sshPublicKey, 'utf8').toString('base64') });
      const subnetId = await defaultSubnet(region);
      /*
        用 NetworkInterface 形态（官方 Example 5 就是这个形状）：`NetworkInterface.1.DeviceIndex=0`
        + `AssociatePublicIpAddress=true` + `SubnetId=…`。
        两条规矩（官方原文）：① 指定了网卡就必须把安全组挂在网卡上，**不能**再用顶层 SecurityGroupId；
        ② 网卡与 Ipv6AddressCount 之类互斥。
      */
      const tree = await ec2(region, 'RunInstances', {
        ImageId: imageId,
        InstanceType: instanceType,
        MinCount: 1,
        MaxCount: 1,
        KeyName: keyName,
        'NetworkInterface.1.DeviceIndex': 0,
        'NetworkInterface.1.SubnetId': subnetId,
        'NetworkInterface.1.AssociatePublicIpAddress': 'true',
        'NetworkInterface.1.SecurityGroupId.1': securityGroupId,
        'TagSpecification.1.ResourceType': 'instance',
        'TagSpecification.1.Tag.1.Key': 'Name',
        'TagSpecification.1.Tag.1.Value': name,
        ...(userData ? { UserData: Buffer.from(userData, 'utf8').toString('base64') } : {}),
      });
      /*
        ⚠️ instanceId 在 `instancesSet > item > instanceId` **三层深**，不是根的直属子元素。
        早先写成"根的直接子元素"时它恒为 undefined ⇒ 机器已经开出来并开始计费，
        而脚本报"没有返回实例 ID"——**一个被计费的孤儿实例**。这是本文件最该记住的一处。
      */
      const inst = findAll(child(tree, 'instancesSet') ?? tree, 'item')[0];
      const id = childText(inst ?? {}, 'instanceId');
      if (!id) throw new CloudError('unknown', `AWS RunInstances 没有返回实例 ID（响应形状变了？）：${JSON.stringify(tree).slice(0, 300)}`, { provider: 'aws', action: 'RunInstances' });
      return { id, keyId: keyName };
    },

    async deleteServer({ region, id }) {
      await ec2(region, 'TerminateInstances', { 'InstanceId.1': id });
      return { released: true };
    },

    async serverPublicIp({ region, id }) {
      const tree = await ec2(region, 'DescribeInstances', { 'InstanceId.1': id });
      const instances = child(findAll(tree, 'item')[0] ?? {}, 'instancesSet');
      const one = instances ? findAll(instances, 'item')[0] : null;
      if (!one) return { status: 'missing', publicIp: null };
      return {
        status: childText(child(one, 'instanceState') ?? {}, 'name'),
        publicIp: childText(one, 'ipAddress'),
        privateIp: childText(one, 'privateIpAddress'),
      };
    },

    /** AWS 没有按需询价接口（Price List Query 要单独开通、返回整份目录）：如实失败，由人给价 */
    async serverMonthlyPrice() {
      throw new CloudError(
        'unavailable',
        'AWS 没有按需询价接口（Price List Query API 需单独开通且返回整份价目目录）。\n' +
          '        请用 --price-server <元/月> 显式给出你接受的月价（t3.micro 在新加坡约 8~10 美元/月，公网 IPv4 另计）。',
        { provider: 'aws' }
      );
    },

    /* ── DNS（Route 53，REST-XML）────────────────────────────────────────── */
    async ensureZone({ domain }) {
      const listed = await route53({ action: 'ListHostedZonesByName', path: '/2013-04-01/hostedzonesbyname', query: { dnsname: domain, maxitems: '10' } });
      const zones = findAll(listed.tree, 'HostedZone').map((z) => ({
        id: childText(z, 'Id'),
        name: childText(z, 'Name'),
        private: childText(child(z, 'Config') ?? {}, 'PrivateZone') === 'true',
      }));
      const hit = zones.find((z) => z.name === `${domain}.` && !z.private);
      if (hit) {
        const detail = await route53({ action: 'GetHostedZone', path: `/2013-04-01/hostedzone/${hit.id.replace('/hostedzone/', '')}` });
        return { id: hit.id, name: domain, nameservers: findAll(child(detail.tree, 'DelegationSet') ?? detail.tree, 'NameServer').map((n) => n.text) };
      }
      // 创建是 POST + XML 体，成功返回 201
      const created = await route53({
        action: 'CreateHostedZone',
        path: '/2013-04-01/hostedzone',
        body: `<?xml version="1.0" encoding="UTF-8"?><CreateHostedZoneRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><Name>${domain}</Name><CallerReference>mk-${Date.now()}</CallerReference></CreateHostedZoneRequest>`,
      });
      const zone = child(created.tree, 'HostedZone');
      return {
        id: childText(zone ?? {}, 'Id'),
        name: domain,
        nameservers: findAll(child(created.tree, 'DelegationSet') ?? created.tree, 'NameServer').map((n) => n.text),
      };
    },

    async upsertARecord({ zoneName, rr, value }) {
      const zone = await this.ensureZone({ domain: zoneName });
      const zoneId = String(zone.id).replace('/hostedzone/', '');
      const name = rr === '@' ? `${zoneName}.` : `${rr}.${zoneName}.`;
      const listed = await route53({
        action: 'ListResourceRecordSets',
        path: `/2013-04-01/hostedzone/${zoneId}/rrset`,
        query: { name, type: 'A', maxitems: '1' },
      });
      const hit = findAll(listed.tree, 'ResourceRecordSet').find((s) => childText(s, 'Name') === name && childText(s, 'Type') === 'A');
      const prev = hit ? findAll(child(hit, 'ResourceRecords') ?? hit, 'Value').map((v) => v.text) : [];
      const changed = prev.length !== 1 || prev[0] !== value;
      if (changed) {
        await route53({
          action: 'ChangeResourceRecordSets',
          path: `/2013-04-01/hostedzone/${zoneId}/rrset/`,
          body:
            `<?xml version="1.0" encoding="UTF-8"?><ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">` +
            `<ChangeBatch><Comment>marketplace-node</Comment><Changes><Change><Action>UPSERT</Action><ResourceRecordSet>` +
            `<Name>${name}</Name><Type>A</Type><TTL>600</TTL><ResourceRecords><ResourceRecord><Value>${value}</Value></ResourceRecord></ResourceRecords>` +
            `</ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`,
        });
      }
      return { id: `${name}A`, changed };
    },

    /* ── 域名注册（Route 53 Domains，JSON）──────────────────────────────── */
    async domainPrice({ domain, years = 1 }) {
      const avail = await domains('CheckDomainAvailability', { DomainName: domain });
      /*
        只有 `AVAILABLE` 才能注册（官方原文："You can register only domains designated as AVAILABLE"）。
        其余取值（DONT_KNOW / PENDING / AVAILABLE_RESERVED / AVAILABLE_PREORDER / INVALID_NAME_FOR_TLD…）
        都**不能**当成"可注册" —— 早先写成 `!== 'UNAVAILABLE'` 会把一片不可注册的状态报成可买。
      */
      const status = String(avail.Availability ?? '');
      const tld = domain.split('.').slice(1).join('.');
      let yearly = null;
      let currency = null;
      try {
        // 官方示例给的是带点的形态（`.net`）；两种都试一次，取到的那个为准
        const prices = await domains('ListPrices', { Tld: `.${tld}` }).catch(() => domains('ListPrices', { Tld: tld }));
        /*
          ListPrices 的响应形状（核文档纠正过一次）：`Prices[]` 是 **DomainPrice**，
          `Name` 是 **TLD 名**（不是 "Registration"），价钱在 `RegistrationPrice: {Currency, Price}` 里。
          早先按 `Prices[].Name === 'Registration'` 找 ⇒ 永远取不到价（静默 null）。
        */
        const entry = (prices.Prices ?? []).find((p) => String(p.Name ?? '').replace(/^\./, '') === tld) ?? (prices.Prices ?? [])[0];
        const reg = entry?.RegistrationPrice;
        if (reg && Number.isFinite(Number(reg.Price))) {
          yearly = Number(reg.Price);
          currency = reg.Currency ?? 'USD';
        }
      } catch {
        yearly = null;
      }
      return {
        available: status === 'AVAILABLE',
        reason: status || null, // 不可注册时把服务商给的状态原样带出去（DONT_KNOW 等），不翻译
        premium: null, // 官方没有"溢价"这个布尔；不要编一个 false
        yearly,
        total: yearly != null ? +(yearly * years).toFixed(2) : null,
        currency: currency ?? 'USD',
        source: 'Route 53 Domains CheckDomainAvailability + ListPrices',
      };
    },

    /**
     * 注册。必填：DomainName / DurationInYears / AdminContact / RegistrantContact / TechContact。
     * ⚠️ 电话号码格式是硬要求：`+<国家码>.<号码>`（官方示例 `+1.1234567890`）——
     * 格式不对会被注册局退单，所以这里在**发请求之前**校验，而不是等一个看不懂的下单失败。
     */
    async buyDomain({ domain, years = 1, contact }) {
      if (!contact) {
        throw new CloudError(
          'invalid',
          'AWS 注册域名需要完整联系人：加 --contact-first-name/--contact-last-name/--contact-phone/--contact-address/--contact-city/--contact-country/--contact-zip（邮箱默认用 --email）',
          { provider: 'aws', action: 'RegisterDomain' }
        );
      }
      if (!/^\+\d{1,3}\.\d{4,}$/.test(String(contact.phone ?? ''))) {
        throw new CloudError('invalid', `电话号码格式不对：官方要求 "+<国家码>.<号码>"（例如 +86.13800138000），收到 ${contact.phone}`, {
          provider: 'aws',
          action: 'RegisterDomain',
        });
      }
      const c = {
        FirstName: contact.firstName,
        LastName: contact.lastName,
        ContactType: contact.organization ? 'COMPANY' : 'PERSON',
        ...(contact.organization ? { OrganizationName: contact.organization } : {}),
        AddressLine1: contact.address,
        City: contact.city,
        State: contact.state ?? contact.city,
        CountryCode: contact.country,
        ZipCode: contact.zip,
        PhoneNumber: contact.phone,
        Email: contact.email,
      };
      const r = await domains('RegisterDomain', {
        DomainName: domain,
        DurationInYears: years,
        AutoRenew: false,
        AdminContact: c,
        RegistrantContact: c,
        TechContact: c,
        // 官方：四个联系人的隐私设置必须一致，所以只给三个会漏掉 billing —— 一起给
        PrivacyProtectAdminContact: true,
        PrivacyProtectBillingContact: true,
        PrivacyProtectRegistrantContact: true,
        PrivacyProtectTechContact: true,
      });
      return { taskId: r.OperationId ?? null, accepted: true };
    },

    /**
     * 轮询注册操作。状态枚举**不是封闭集**（官方页面的示例里出现了不在列表里的
     * `WORKFLOW_IN_PROGRESS`），所以只把明确的失败判成失败，其余原样上报。
     */
    async domainTask({ taskId }) {
      const r = await domains('GetOperationDetail', { OperationId: taskId });
      const status = String(r.Status ?? 'unknown');
      return {
        status: /^FAILED$|^ERROR$/i.test(status) ? 'EXECUTE_FAILURE' : /SUCCESSFUL/i.test(status) ? 'EXECUTE_SUCCESS' : status,
        error: r.Message ?? null,
        // 有些状态是"等人做事"（付款方式验证、点确认邮件），不是失败 —— 原样告诉用户别误判
        needsHuman: /PENDING/i.test(status) || /PENDING/i.test(String(r.StatusFlag ?? '')),
        raw: r,
      };
    },

    domainTemplates: async () => [{ id: '(AWS 不需要注册人资料模板)', status: 'usable', valid: true }],
  });
}
