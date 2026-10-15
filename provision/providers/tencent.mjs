/**
 * 腾讯云适配器（CVM + VPC + 域名注册（国际站）+ DNSPod + Billing）。
 *
 * ── 签名：TC3-HMAC-SHA256 ─────────────────────────────────────────────────────
 *   密钥派生：kDate=HMAC("TC3"+SecretKey, UTC日期) → kService=HMAC(kDate, 服务名) → kSigning=HMAC(kService,"tc3_request")
 *   签名 = HexEncode(HMAC(kSigning, StringToSign))
 * 两个容易踩的点（官方文档明确警告过）：
 *   · CredentialScope 里的日期必须是 **UTC** 日期（本地 UTC+8 在 00:00–08:00 之间会算错一天，
 *     表现为 AuthFailure.SignatureExpire —— 看起来像时钟不同步，其实是时区用错）；
 *   · 请求头里必须签 `host` 与 `content-type` 两个（少签一个就是签名不匹配）。
 *
 * ── 域名注册固定走国际站（domain.intl），且动作名是另一套 ─────────────────────
 * 中国站的域名（`domain.tencentcloudapi.com` + `CreateDomainBatch`）由境内注册商承接、
 * 需要工信部实名（模板审核要人上传证件 + 短信验证码，1~3 个工作日），而且**能且需要备案**。
 * 国际站（`domain.intl.tencentcloudapi.com`）的域名由境外注册商承接、**不能做 ICP 备案** ——
 * 与非大陆区域的机器配套，整条链路就不存在备案问题。所以这里只留国际站那一条路径，
 * 连"要不要用中国站"这个选择都不存在（少一个能被指错的分支）。
 * ⚠️ 国际站的动作名多一个 `Intl`：`CreateIntlDomainBatch` / `CheckIntlDomainNew` /
 * `DescribeIntlDomainPriceNewList` / `DescribeIntlDomainList` / `DescribeIntlTemplateList`。
 *
 * ── 余额单位是分 ─────────────────────────────────────────────────────────────
 * `DescribeAccountBalance` 的所有金额字段单位都是**分**（文档原文），换算成元要 /100。
 */
import { createHash, createHmac } from 'node:crypto';
import { CloudError, classify } from '../lib/errors.mjs';
import { apiCall } from '../lib/http.mjs';
import { defineProvider } from '../lib/provider.mjs';
import { PAGE_SIZE, fetchAllPages } from '../lib/paginate.mjs';

const SERVICES = {
  cvm: { host: 'cvm.tencentcloudapi.com', version: '2017-03-12' },
  vpc: { host: 'vpc.tencentcloudapi.com', version: '2017-03-12' },
  domain: { host: 'domain.intl.tencentcloudapi.com', version: '2018-08-08' },
  dnspod: { host: 'dnspod.tencentcloudapi.com', version: '2021-03-23' },
  billing: { host: 'billing.tencentcloudapi.com', version: '2018-07-09' },
};

/** 非中国大陆地域（官方公共参数表的子集）。第一个是默认。 */
const REGIONS = [
  { id: 'ap-hongkong', label: '中国香港' },
  { id: 'ap-singapore', label: '新加坡' },
  { id: 'ap-jakarta', label: '印尼（雅加达）' },
  { id: 'ap-tokyo', label: '日本（东京）' },
  { id: 'ap-seoul', label: '韩国（首尔）' },
  { id: 'na-siliconvalley', label: '美国（硅谷）' },
  { id: 'eu-frankfurt', label: '德国（法兰克福）' },
];

const INSTANCE_TYPES = ['S5.SMALL2', 'SA5.SMALL2', 'S5.MEDIUM4', 'SA5.MEDIUM2', 'S5.MEDIUM2'];

export function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function hmac(key, s) {
  return createHmac('sha256', key).update(s).digest();
}

/**
 * 纯函数：按 TC3 规则算出 Authorization 头（有单测）。
 * @param {{secretId:string, secretKey:string, service:string, host:string, payload:string, timestamp:number, action:string, version:string, region?:string, token?:string}} o
 */
export function signTc3(o) {
  // 必须 UTC，且 Credential 里的日期是 **YYYYMMDD**（无横杠；带横杠会被判签名格式错）
  const date = new Date(o.timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${o.host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(o.payload)].join('\n');
  const scope = `${date}/${o.service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(o.timestamp), scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`TC3${o.secretKey}`, date);
  const kService = hmac(kDate, o.service);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `TC3-HMAC-SHA256 Credential=${o.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export function createTencent({ secretId, secretKey, token }) {
  if (!secretId || !secretKey) {
    throw new CloudError('auth', '缺少腾讯云凭据：需要 TENCENTCLOUD_SECRET_ID 与 TENCENTCLOUD_SECRET_KEY');
  }

  async function call(svcName, action, params = {}, opts = {}) {
    const svc = SERVICES[svcName];
    /*
      Region **只进 X-TC-Region 请求头**，不进 JSON body：官方公共参数文档写的是
      "使用签名方法 v3 时，公共参数需要统一放到 HTTP Header 请求头部中"，POST+JSON 的示例体里
      也没有 Region。塞进 body 是未定义行为 —— 严格的产品会以
      `UnknownParameter.WithGuess`（参数无法识别）拒掉。
      所以这里先从 body 里摘掉 Region，再把它放到头上。
    */
    const { Region: bodyRegion, ...rest } = params ?? {};
    const region = opts.region || bodyRegion;
    const payload = JSON.stringify(rest);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      host: svc.host,
      'X-TC-Action': action,
      'X-TC-Version': svc.version,
      'X-TC-Timestamp': String(timestamp),
      ...(region ? { 'X-TC-Region': region } : {}),
      ...(token ? { 'X-TC-Token': token } : {}),
      Authorization: signTc3({
        secretId,
        secretKey,
        service: svcName,
        host: svc.host,
        payload,
        timestamp,
        action,
        version: svc.version,
      }),
    };
    const r = await apiCall({
      provider: 'tencent',
      action,
      url: `https://${svc.host}/`,
      method: 'POST',
      headers,
      body: payload,
      attempts: opts.attempts,
      // 错误在 Response.Error 里，HTTP 状态码**永远是 200**（这点与其它三家都不同）
      errorCode: (o) => o?.Response?.Error?.Code,
    });
    const err = r?.Response?.Error;
    if (err) {
      // apiCall 只按 HTTP 状态判成败，而腾讯云**失败也是 200** ⇒ 这里必须自己再判一次
      throw new CloudError(classify(err.Code, 400), `tencent:${action} 失败：${err.Code} ${err.Message}`, {
        provider: 'tencent',
        action,
        code: err.Code,
        requestId: r.Response.RequestId,
      });
    }
    return r.Response;
  }

  /**
   * 国际站的注册人资料（registrant profile）：动作是 `DescribeIntlTemplateList`。
   *
   * ⚠️ 与中国站的"信息模板"**不是一回事**：中国站的模板有 `AuditStatus`（工信部实名审核），
   * 国际站的 `IntlTemplate` 数据结构里**没有审核状态、也没有 IsValidTemplate**（官方输出参数只有
   * TemplateId / RegistrantContact / TechnicalContact / AdminContact / BillingContact /
   * CreatedOn / UpdatedOn / IsDefault）。所以这里只判断"有没有资料"，
   * **不编一个审核状态出来** —— 编出来的字段会永远读不到，于是所有人都被当成"模板没审核"而挡住。
   */
  async function registrantProfiles() {
    const r = await call('domain', 'DescribeIntlTemplateList', { Offset: 0, Limit: 100 });
    return (r.TemplateSet ?? []).map((t) => ({
      id: t.TemplateId,
      status: 'usable', // 国际站资料没有审核态；可用性由下单时的 ResourceNotFound.TemplateNotFound 判定
      valid: true,
      isDefault: !!t.IsDefault,
    }));
  }

  /**
   * 不钉镜像 ID：腾讯云的 Ubuntu 镜像 ID 随地域/时间变化，钉死必坏。
   * 抽成具名函数（而不是对象里的方法）是因为询价与建机器都要用它 ——
   * 对象字面量里用 `this.xxx()` 会在解构调用时静默失效。
   */
  async function resolveImage(region) {
    const r = await call(
      'cvm',
      'DescribeImages',
      {
        Region: region,
        Filters: [
          { Name: 'image-type', Values: ['PUBLIC_IMAGE'] },
          { Name: 'platform', Values: ['Ubuntu'] },
        ],
        Limit: 20,
      },
      { region }
    );
    const img = (r.ImageSet ?? []).find((i) => i.ImageState === 'NORMAL' && /ubuntu/i.test(i.Platform ?? ''));
    if (!img) {
      throw new CloudError('invalid', `腾讯云 ${region} 上找不到可用的 Ubuntu 公共镜像`, { provider: 'tencent', action: 'DescribeImages' });
    }
    return { id: img.ImageId, name: img.ImageName || img.ImageId, family: img.Platform };
  }

  return defineProvider({
    id: 'tencent',
    label: '腾讯云',
    credentialsHint: 'TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY（CAM 子用户；需要 cvm:*、vpc:*、dnspod:*、domain:*、finance:DescribeAccountBalance）',
    defaultRegion: REGIONS[0].id,
    regions: REGIONS,

    describe: () => ({
      id: 'tencent',
      label: '腾讯云',
      endpoints: Object.fromEntries(Object.entries(SERVICES).map(([k, v]) => [k, v.host])),
      regions: REGIONS,
      defaultRegion: REGIONS[0].id,
      instanceTypes: INSTANCE_TYPES,
      image: '按 Filters(platform=Ubuntu, image-type=PUBLIC_IMAGE) 实时查（不钉镜像 ID —— 那些 ID 会随地域与时间失效）',
      domainRegistrar: true,
      notes: [
        '机器按小时后付费（POSTPAID_BY_HOUR）并在创建时分配公网 IP，用 provision destroy 释放。',
        '域名走**国际站注册商**（domain.intl）：域名在中国大陆境外注册、**不能做 ICP 备案** —— 与非大陆区域的机器配套，整条链路不需要备案。',
        '国际站的域名动作名带 Intl（CreateIntlDomainBatch / CheckIntlDomainNew / DescribeIntlDomainPriceNewList）。',
        '余额接口返回的单位是**分**（已换算成元展示）。',
      ],
    }),

    /* ── 账号 ────────────────────────────────────────────────────────────── */
    async account() {
      const out = { balance: null, currency: 'CNY', warnings: [] };
      // 凭据是否有效：用 CVM 的 DescribeRegions（只读、无需地域）先探一次，
      // 这样"密钥错"与"缺 finance 权限"能分开报，而不是笼统一句调用失败。
      try {
        await call('cvm', 'DescribeRegions', {});
        out.identity = { ok: true, note: '密钥有效（CVM DescribeRegions 通过）' };
      } catch (e) {
        throw e; // 密钥本身不对就别继续了
      }
      try {
        const b = await call('billing', 'DescribeAccountBalance', {});
        // 所有金额字段单位都是**分**
        // 余额取**数字或 null**：NaN 会同时骗过 `!= null` 与 `<= 0` 两道判断（见 aliyun.mjs 同一处注释）
    const realFen = Number(b.RealBalance ?? b.Balance ?? NaN);
    out.balance = Number.isFinite(realFen) ? realFen / 100 : null;
    if (out.balance == null) out.warnings.push('余额接口没有返回 RealBalance/Balance —— 这次不判余额，下单时若不足会以失败告终');
        out.owed = Number(b.OweAmount ?? 0) / 100;
        out.balanceDetail = { real: out.balance, cash: Number(b.CashAccountBalance ?? 0) / 100, free: Number(b.FreezeAmount ?? 0) / 100, owed: out.owed };
      } catch (e) {
        out.warnings.push(`余额查询失败（${e.kind}）：${e.message} —— 需要 finance:DescribeAccountBalance 权限；不影响继续，但余额不足会在下单时才暴露`);
      }
      /*
        注册人资料（registrant profile）：`CreateIntlDomainBatch` 的 `TemplateId` 是必填，
        所以"账号里有没有一份资料"是可判定的前置。但**只在确实查到了列表时**才据此拦人：
        查不到就如实说明"看不到列表"，让下单去当判据 —— 把"查不到"当成"没有"，
        会把一个能跑通的账号挡在门外。
      */
      try {
        const tpl = await registrantProfiles();
        out.domainTemplates = tpl;
        out.domainBlockers = tpl.length
          ? []
          : [
              '账号里没有注册人资料（registrant profile）—— 国际站注册域名必须带一个 TemplateId',
              '去腾讯云国际站控制台「域名 → 注册人资料」新建一份（境外注册商不做中国式实名审核，无需上传证件）',
              '或改用 --domain <已有的域名>（本工具只建解析，不注册）',
            ];
      } catch (e) {
        out.domainTemplates = null;
        out.domainBlockers = [];
        out.warnings.push(`读不到注册人资料列表（${e.kind}）：${e.message} —— 继续尝试注册；若注册失败会带原始错误码`);
      }
      return out;
    },

    async listServers(region) {
      const regions = region ? [region] : REGIONS.map((r) => r.id);
      const all = [];
      for (const r of regions) {
        /*
          每个区域都要**翻完所有页**：resume 的判据靠这份列表完整（漏一页就会判成"没有同名机器"
          然后再买一台）。Tencent 用 Offset/Limit + TotalCount 分页。
        */
        const rows = await fetchAllPages({
          fetchPage: (page) => call('cvm', 'DescribeInstances', { Region: r, Limit: PAGE_SIZE, Offset: (page - 1) * PAGE_SIZE }, { region: r }),
          readPage: (res) => ({ itemsPath: (x) => x.InstanceSet ?? [], total: Number.isFinite(Number(res.TotalCount)) ? Number(res.TotalCount) : null }),
        });
        for (const i of rows) {
          all.push({
            id: i.InstanceId,
            name: i.InstanceName,
            status: i.InstanceState,
            publicIp: (i.PublicIpAddresses ?? [])[0] ?? null,
            privateIp: (i.PrivateIpAddresses ?? [])[0] ?? null,
            region: r,
            instanceType: i.InstanceType,
            createdAt: i.CreatedTime,
          });
        }
      }
      return all;
    },

    async listDomains() {
      /*
        国际站的"我的域名"列表是 `DescribeIntlDomainList`（不是中国站的 DescribeDomainNameList）。
        返回的 `IntlDomainInfo` 里**没有 BuyStatus**，状态字段叫 `Status`（字符串）、
        `DomainStatus`（字符串数组）；`AutoRenew` 是整数 0/1 而不是布尔。
        这里按官方输出参数写 —— 之前读 BuyStatus 会恒为 undefined，也就是"看起来取到了、其实什么都没取到"。
      */
      // 翻完所有页：漏一页会判成"域名不在账号里"，把人推去 --buy（然后撞 DuplicateDomain）
      const rows = await fetchAllPages({
        fetchPage: (page) => call('domain', 'DescribeIntlDomainList', { Offset: (page - 1) * PAGE_SIZE, Limit: PAGE_SIZE }),
        readPage: (res) => ({ itemsPath: (x) => x.DomainSet ?? [], total: Number.isFinite(Number(res.TotalCount)) ? Number(res.TotalCount) : null }),
      });
      const r = { DomainSet: rows };
      return (r.DomainSet ?? []).map((d) => ({
        name: d.DomainName,
        expiresAt: d.ExpirationDate,
        status: d.Status ?? (Array.isArray(d.DomainStatus) ? d.DomainStatus.join(',') : null),
        autoRenew: Number(d.AutoRenew) === 1,
      }));
    },

    /* ── 机器 ────────────────────────────────────────────────────────────── */
    resolveImage,

    async ensureSecurityGroup({ region, name }) {
      const list = await call('vpc', 'DescribeSecurityGroups', { Region: region, Filters: [{ Name: 'security-group-name', Values: [name] }], Limit: 100 }, { region });
      let id = (list.SecurityGroupSet ?? []).find((g) => g.SecurityGroupName === name)?.SecurityGroupId;
      if (!id) {
        const created = await call('vpc', 'CreateSecurityGroup', { GroupName: name, GroupDescription: 'marketplace-node' }, { region });
        id = created.SecurityGroup?.SecurityGroupId;
      }
      // 新建的安全组默认**入站全拒**（官方文档明说），所以必须显式放行这三条
      try {
        await call(
          'vpc',
          'CreateSecurityGroupPolicies',
          {
            Region: region,
            SecurityGroupId: id,
            SecurityGroupPolicySet: {
              /*
                ⚠️ **不要传 Version**：官方语义是"每次更新规则版本号自动加1，防止更新的规则已过期，
                不填不考虑冲突"。写死 '1' 只在安全组的当前版本恰为 1 时才成功，
                否则报 UnsupportedOperation.VersionMismatch（一个随机复现的失败）。
              */
              Ingress: [
                { Protocol: 'TCP', Port: '22', CidrBlock: '0.0.0.0/0', Action: 'ACCEPT', PolicyDescription: 'ssh' },
                { Protocol: 'TCP', Port: '80', CidrBlock: '0.0.0.0/0', Action: 'ACCEPT', PolicyDescription: 'http (ACME)' },
                { Protocol: 'TCP', Port: '443', CidrBlock: '0.0.0.0/0', Action: 'ACCEPT', PolicyDescription: 'https (buyers)' },
              ],
            },
          },
          { region }
        );
      } catch (e) {
        // 重复规则会报 UnsupportedOperation.DuplicatePolicy —— 那说明"已经对了"
        if (!/DuplicatePolicy/i.test(String(e.code ?? ''))) throw e;
      }
      return { id };
    },

    async createServer({ region, name, instanceType, sshPublicKey, securityGroupId, imageId, userData }) {
      // KeyName 只允许字母/数字/下划线且 ≤25 字符；ProjectId 是必填（0 = 默认项目）
      // KeyName 只允许 [A-Za-z0-9_]（带 '-' 或 '.' 会被 InvalidKeyPairNameIncludeIllegalChar 拒掉）⇒ 先归一化再截断
      const safe = String(name).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 18);
      const keyName = `mk_${safe}_${Math.random().toString(36).slice(2, 6)}`;
      const imported = await call('cvm', 'ImportKeyPair', { KeyName: keyName, ProjectId: 0, PublicKey: sshPublicKey }, { region });
      const r = await call(
        'cvm',
        'RunInstances',
        {
          Region: region,
          InstanceChargeType: 'POSTPAID_BY_HOUR',
          InstanceName: name,
          ImageId: imageId,
          InstanceType: instanceType,
          Placement: { Zone: (await defaultZone(region)) },
          SecurityGroupIds: [securityGroupId],
          // 不指定 InternetAccessible 的话默认公网带宽是 0（文档原文）⇒ 拿不到公网 IP
          InternetAccessible: { InternetChargeType: 'TRAFFIC_POSTPAID_BY_HOUR', InternetMaxBandwidthOut: 5, PublicIpAssigned: true },
          LoginSettings: { KeyIds: [imported.KeyId] },
          SystemDisk: { DiskType: 'CLOUD_BSSD', DiskSize: 40 },
          InstanceCount: 1,
          ...(userData ? { UserData: Buffer.from(userData, 'utf8').toString('base64') } : {}),
        },
        { region }
      );
      const id = (r.InstanceIdSet ?? [])[0];
      if (!id) throw new CloudError('unknown', `腾讯云 RunInstances 没有返回实例 ID：${JSON.stringify(r).slice(0, 300)}`, { provider: 'tencent' });
      return { id, keyId: imported.KeyId };
    },

    async deleteServer({ region, id }) {
      await call('cvm', 'TerminateInstances', { Region: region, InstanceIds: [id] }, { region });
      return { released: true };
    },

    async serverPublicIp({ region, id }) {
      const r = await call('cvm', 'DescribeInstances', { Region: region, InstanceIds: [id] }, { region });
      const i = (r.InstanceSet ?? [])[0];
      if (!i) return { status: 'missing', publicIp: null };
      return {
        status: i.InstanceState, // PENDING / RUNNING / STOPPED / LAUNCH_FAILED
        publicIp: (i.PublicIpAddresses ?? [])[0] ?? null,
        privateIp: (i.PrivateIpAddresses ?? [])[0] ?? null,
      };
    },

    async serverMonthlyPrice({ region, instanceType, imageId }) {
      let r;
      try {
        r = await call(
          'cvm',
          'InquiryPriceRunInstances',
          {
            Region: region,
            InstanceChargeType: 'POSTPAID_BY_HOUR',
            InstanceType: instanceType,
            // 询价必须带一个具体镜像；调用方没给就用本地域实时查到的那一个（this 在对象字面量里不可靠）
            ImageId: imageId ?? (await resolveImage(region)).id,
            // Placement 在**询价接口上是必填**（与 RunInstances 的条件必填不同）：少了直接 MissingParameter
            Placement: { Zone: await defaultZone(region) },
            /*
              询价这里用**按带宽**计费，而建机器用的是按流量 —— 刻意的，理由是"能不能算出月价"：
                · 按流量（TRAFFIC_POSTPAID_BY_HOUR）时 BandwidthPrice.UnitPrice 的单位是 **元/GB**，
                  乘以 730 等于在给"730 GB 流量"定价，那是个凭空造出来的数字；
                · 按带宽（BANDWIDTH_POSTPAID_BY_HOUR）时单位是元/小时，× 730 才是真正的月成本。
              代价写明：按带宽报价比按流量**偏保守**（轻流量时真实账单更低），
              而闸门本来就该按"最坏情况"判 —— 宁可高估，不要给人一个偏低的预算承诺。
            */
            InternetAccessible: { InternetChargeType: 'BANDWIDTH_POSTPAID_BY_HOUR', InternetMaxBandwidthOut: 5, PublicIpAssigned: true },
            SystemDisk: { DiskType: 'CLOUD_BSSD', DiskSize: 40 },
            InstanceCount: 1,
          },
          { region }
        );
      } catch (e) {
        throw new CloudError('unavailable', `腾讯云询价失败（${e.kind}）：${e.message}`, { provider: 'tencent', action: 'InquiryPriceRunInstances' });
      }
      /*
        取价要用 **UnitPriceDiscount ?? UnitPrice**：官方对 UnitPrice 的定义是"原价"，
        真正会扣的是折扣价。用原价会高估（对闸门是安全方向），但既然有折扣价就该用它。
      */
      const pick = (item) => {
        const v = Number(item?.UnitPriceDiscount ?? item?.UnitPrice ?? NaN);
        return Number.isFinite(v) ? v : null;
      };
      const instance = pick(r.Price?.InstancePrice);
      const bandwidth = pick(r.Price?.BandwidthPrice) ?? 0;
      if (instance == null) {
        throw new CloudError('unavailable', `腾讯云询价返回里没有 InstancePrice.UnitPrice：${JSON.stringify(r).slice(0, 200)}`, { provider: 'tencent' });
      }
      // 后付费是**阶梯价**（0-96h / 96-360h / 360h+），UnitPrice 只代表第一档。
      // 按 730 小时直接乘会**高估**（第一档最贵）—— 高估对预算闸门是安全方向，所以在 source 里如实写明。
      const hourly = instance + bandwidth;
      return {
        monthly: +(hourly * 730).toFixed(2),
        currency: 'CNY',
        source:
          `腾讯云 InquiryPriceRunInstances 实时价（机器 ${instance} + 带宽 ${bandwidth} = ${hourly.toFixed(4)} 元/小时 × 730；` +
          '后付费是阶梯价，第一档最贵，故此为**上界**）',
      };
    },

    /* ── DNS（DNSPod）────────────────────────────────────────────────────── */
    async ensureZone({ domain }) {
      const got = await call('dnspod', 'DescribeDomain', { Domain: domain }).catch((e) => {
        if (e.kind === 'not_found' || /DomainNotReged|ResourceNotFound/i.test(String(e.code ?? ''))) return null;
        throw e;
      });
      if (got?.DomainInfo) {
        return { id: String(got.DomainInfo.DomainId ?? domain), name: domain, nameservers: got.DomainInfo.DnspodNsList ?? [] };
      }
      const created = await call('dnspod', 'CreateDomain', { Domain: domain });
      return { id: String(created.DomainInfo?.Id ?? domain), name: domain, nameservers: created.DomainInfo?.GradeNsList ?? [] };
    },

    async upsertARecord({ zoneName, rr, value }) {
      const existing = await call('dnspod', 'DescribeRecordList', { Domain: zoneName, SubDomain: rr, RecordType: 'A', Limit: 100, ErrorOnEmpty: 'no' });
      const hit = (existing.RecordList ?? []).find((r) => r.Name === rr && r.Type === 'A');
      if (hit) {
        if (hit.Value === value) return { id: String(hit.RecordId), changed: false };
        await call('dnspod', 'ModifyRecord', { Domain: zoneName, RecordId: hit.RecordId, SubDomain: rr, RecordType: 'A', RecordLine: '默认', Value: value, TTL: 600 });
        return { id: String(hit.RecordId), changed: true };
      }
      const r = await call('dnspod', 'CreateRecord', { Domain: zoneName, SubDomain: rr, RecordType: 'A', RecordLine: '默认', Value: value, TTL: 600 });
      return { id: String(r.RecordId), changed: true };
    },

    /* ── 域名注册（国际站）───────────────────────────────────────────────── */
    async domainPrice({ domain, years = 1 }) {
      /*
        ⚠️ 国际站的可注册性接口参数名与中国站**不同**：
        `CheckIntlDomainNew` 要的是 `Domain`（必填）+ `Period`（选填，用于查溢价域名），
        中国站的 `CheckDomain` 才是 `DomainName`。传错会直接 InvalidParameter/MissingParameter。
        `Period` 不给时查不了溢价域名，所以这里一定带上。
      */
      const check = await call('domain', 'CheckIntlDomainNew', { Domain: domain, Period: String(years) });
      const tld = domain.split('.').slice(1).join('.');
      let yearly = null;
      try {
        // TldList 的取值形态以点开头（官方示例是 ".com"）；Year 官方示例里给的是字符串 "1"
        const prices = await call('domain', 'DescribeIntlDomainPriceNewList', { TldList: [`.${tld}`], Year: [String(years)], Operation: ['new'] });
        const list = prices.PriceList ?? [];
        // 按 (Tld, Year) 精确匹配；匹配不到就用第一条 —— 参数形态（带不带点）我按官方示例写，
        // 万一服务端归一化方式不同，宁可"取到了但来源写清楚"，也不要报成"查不到价格"
        const hit = list.find((p) => String(p.Tld).replace(/^\./, '') === tld && Number(p.Year) === Number(years)) ?? list[0];
        yearly = hit ? Number(hit.RealPrice ?? hit.Price ?? NaN) || null : null;
      } catch {
        yearly = Number(check.RealPrice ?? check.Price ?? NaN) || null;
      }
      return {
        available: !!check.Available,
        reason: check.Reason ?? null,
        premium: !!check.Premium,
        yearly,
        total: yearly != null ? yearly * years : null,
        currency: 'CNY',
        source: '腾讯云国际站 CheckIntlDomainNew + DescribeIntlDomainPriceNewList 实时价',
      };
    },

    /**
     * 国际站的注册动作是 `CreateIntlDomainBatch`（必填四项与官方文档一致：
     * TemplateId / Period / Domains.N / PayMode）。
     *
     * `TemplateId` 是**注册人联系资料**（registrant profile），不是工信部实名审核 ——
     * 境外注册商不做中国式实名，所以这条路可以无人值守。
     *
     * ⚠️ `AutoRenewFlag` 在国际站是 **Boolean**（中国站的 CreateDomainBatch 是 Integer 0/1）——
     * 传 0 会被当成类型不符；这里按文档给 false。
     */
    async buyDomain({ domain, years = 1, templateId }) {
      if (!templateId) {
        throw new CloudError(
          'invalid',
          '腾讯云国际站注册域名需要一份注册人资料（registrant profile）：先调 DescribeIntlTemplateList 拿一个 TemplateId，或用 --domain <已有的域名>',
          { provider: 'tencent', action: 'CreateIntlDomainBatch' }
        );
      }
      const r = await call('domain', 'CreateIntlDomainBatch', {
        TemplateId: templateId,
        Period: years,
        Domains: [domain],
        PayMode: 1, // 1 = 使用余额付费（0 是"在线支付"，那需要人去收银台）
        AutoRenewFlag: false,
      });
      return { taskId: r.LogId != null ? String(r.LogId) : null, accepted: true };
    },

    /**
     * 批量注册的进度：`DescribeIntlDomainBatchDetails` 每个域名一条
     * `{Status, Domain, Reason, Action, Id}`（官方取值 `SUCCESS` / `FAILURE`，另有进行中的状态）。
     *
     * **只有明确写着成功的才算成功**：`rows.length` 非空**不能**当成功 —— 空状态、没见过的状态
     * 都可能是"还没做完"，而调用方（up.mjs 的轮询）遇到 SUCCESS 就往下走。那时解析区还没生效，
     * 下一步必挂，而用户已经被告知"域名买好了"。默认分支取 pending 而不是成功：
     * 取错方向一次，就会把"还在进行"说成"已完成"。
     */
    async domainTask({ taskId }) {
      const r = await call('domain', 'DescribeIntlDomainBatchDetails', { LogId: Number(taskId), Offset: 0, Limit: 100 }).catch(() => null);
      if (!r) return { status: 'unknown', error: null, raw: null };
      const rows = r.DomainBatchDetailSet ?? [];
      const failed = rows.find((x) => /fail|reject|error/i.test(String(x.Status ?? '')));
      if (failed) return { status: 'EXECUTE_FAILURE', error: failed.Reason || failed.ReasonZh || failed.Status, raw: rows[0] ?? null };
      // 官方给的成功串是 `SUCCESS`（旧版把 doing/successful 都算成功，正好错在这一步）
      const allDone = rows.length > 0 && rows.every((x) => /^success(ful)?$/i.test(String(x.Status ?? '').trim()));
      return { status: allDone ? 'EXECUTE_SUCCESS' : 'EXECUTING', error: null, raw: rows[0] ?? null };
    },

    domainTemplates: registrantProfiles,
  });

  /** 默认可用区：CVM 的 Placement.Zone 是必填，取该地域第一个可用区 */
  async function defaultZone(region) {
    const z = await call('cvm', 'DescribeZones', { Region: region }, { region });
    const zone = (z.ZoneSet ?? []).find((x) => x.ZoneState === 'AVAILABLE')?.Zone ?? (z.ZoneSet ?? [])[0]?.Zone;
    if (!zone) throw new CloudError('invalid', `腾讯云 ${region} 没有可用区`, { provider: 'tencent', action: 'DescribeZones' });
    return zone;
  }
}
