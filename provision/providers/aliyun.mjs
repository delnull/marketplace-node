/**
 * 阿里云适配器（ECS + Alidns + Domain + BssOpenApi）。
 *
 * ── 签名 ──────────────────────────────────────────────────────────────────────
 * 这四个产品都是 **RPC 风格**接口，用 HMAC-SHA1：
 *   StringToSign = METHOD&%2F&percentEncode(canonicalizedQuery)
 *   Signature    = Base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign))
 * 其中 percentEncode 与标准 URL 编码**不同**：空格编成 %20（不是 +）、`~` 不编码、
 * `*` 编成 %2A。写错的表现是 SignatureDoesNotMatch（看起来像参数错），所以它单独成函数、单独有测试。
 *
 * ── 三个"照直觉写就一定错"的点（都是官方文档里明确的）────────────────────────
 *   1. ECS 的 endpoint 是**按区域**的：`ecs.<region>.aliyuncs.com`。没有全局的 ecs.aliyuncs.com。
 *   2. **没有 QueryDomainPrice 这个接口**（查询返回 api not found）。域名价格要从 `CheckDomain`
 *      的 `Price`/`StaticPriceInfo.PriceInfo[]` 里取。
 *   3. 2022-03-01 起**只能**用"已通过实名认证的信息模板"（RegistrantProfileId）注册域名，
 *      不再接受直接传持有者信息。所以"能不能买域名"取决于账号里有没有一个 RealNameStatus=SUCCEED
 *      的模板 —— 这是**账号状态**，不是代码能力。check 阶段会把它查出来并说清楚，
 *      而不是等到花钱那一步才失败。
 *
 * ── 为什么默认按量付费（PostPaid）────────────────────────────────────────────
 * 包年包月要先付一整年、退订走工单；按量付费按小时计费，用户不满意直接 `provision destroy`
 * 删掉，损失最多几小时。这个脚本的定位是"一条流程走完就能用"，不是替用户做财务决策，
 * 所以默认选代价最小、可撤销的那一种。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { CloudError } from '../lib/errors.mjs';
import { apiCall, qs } from '../lib/http.mjs';
import { defineProvider } from '../lib/provider.mjs';
import { PAGE_SIZE, fetchAllPages } from '../lib/paginate.mjs';

const ALIDNS = { host: 'alidns.aliyuncs.com', version: '2015-01-09' };
/*
  域名注册固定走**国际站**（domain-intl）—— 这不是可选参数，是本工具的定位：
  国际站的域名由**中国大陆境外的注册商**承接，因此**不能做中国大陆 ICP 备案**，
  配上非大陆区域的机器，整条链路就不存在"要不要备案"这个问题。
  阿里云中国站（domain.aliyuncs.com）的域名可以备案，把它当成一条可选路径留着，
  就等于留着"某天有人用 --site cn 跑一遍、然后发现备案卡住"的可能 —— 所以不留。
*/
const DOMAIN = { host: 'domain-intl.aliyuncs.com', version: '2018-01-29' };
const BSS = { host: 'business.ap-southeast-1.aliyuncs.com', version: '2017-12-14' };
const STS = { version: '2015-04-01' };
const ECS_VERSION = '2014-05-26';

/** 非中国大陆区域（我们只在这些区域开机器）。第一个是默认。 */
const REGIONS = [
  { id: 'cn-hongkong', label: '中国香港' },
  { id: 'ap-southeast-1', label: '新加坡' },
  { id: 'ap-southeast-3', label: '马来西亚（吉隆坡）' },
  { id: 'ap-northeast-1', label: '日本（东京）' },
  { id: 'us-west-1', label: '美国（硅谷）' },
  { id: 'eu-central-1', label: '德国（法兰克福）' },
];

/**
 * 候选机型：从最小往上试，第一个在目标区域有货且询价成功的就用它。
 * ⚠️ 这里**只放经济型 e 与通用算力型 u1**：因为系统盘用了 `cloud_essd_entry`，
 * 而官方对这个盘型的约束是"仅当 InstanceType 为 ecs.u1（通用算力型）或 ecs.e（经济型）时支持"。
 * 早先列表里还挂着 g6/c6 —— 那两个机型配 essd_entry 会被拒，
 * 于是"便宜机型没货时往后试一个"这条兜底恰好**在需要它的时候失效**。
 * 代价写明：只在这两个规格族里挑，可选面比全量小；换机型时要连盘型一起换。
 */
const INSTANCE_TYPES = ['ecs.e-c1m1.large', 'ecs.e-c1m2.large', 'ecs.e-c1m4.xlarge', 'ecs.u1-c1m1.large', 'ecs.u1-c1m2.large'];

/**
 * 官方 Ubuntu 镜像用 **ImageFamily** 指定：让阿里云自己选该区域最新的一版。
 * 钉一个具体镜像 ID 的适配器过几个月就必然坏（镜像会被下线），而 ImageFamily 是长期的。
 *
 * ⚠️ 取值必须是**镜像族系**名（官方公共镜像概述里给的是 `acs:ubuntu_22_04_x64`），
 * 不是镜像 ID 的前缀（`ubuntu_22_04_x64_20G_alibase_2026xxxx.vhd` 那种）。
 * 传成后者时 DescribeImages 返回空 → resolveImage 抛错 → **一台机器都开不出来**。
 */
const IMAGE_FAMILY = 'acs:ubuntu_22_04_x64';

const encode = encodeURIComponent;

/** 阿里云 RPC 专用的百分号编码（RFC3986 的一个特定子集，见文件头） */
export function percentEncode(str) {
  return encode(str).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

/** 纯函数：构造 canonicalizedQuery 与签名（有单测；签错的表现是"看起来像参数错"，必须能单独验） */
export function signRpc({ params, secret, httpMethod = 'POST' }) {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const stringToSign = `${httpMethod}&${percentEncode('/')}&${percentEncode(canonical)}`;
  return { canonical, signature: createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64') };
}

/**
 * 实例的公网 IP —— **唯一的解析处**。
 *
 * 两个坑，都会静默产出垃圾数据：
 *   1. 没有公网 IP 时阿里云回的是**字符串 `"Null"`**（不是空数组）。直接 `[0]` 会取到 `"N"`，
 *      它非空 ⇒ waitForPublicIp 认为拿到了 IP ⇒ `"N"` 被写进状态、发给解析、拿去 SSH。
 *   2. EipAddress（绑定的弹性 IP）与 PublicIpAddress（自动分配）都可能在，顺序决定拿哪个；
 *      这里优先 EIP —— 它是稳定地址，重启不变。
 * 所以：候选值统一成数组、只接受形如 IPv4 的字符串，其余一律当作"没有 IP"。
 */
function firstPublicIp(instance) {
  return [instance?.EipAddress?.IpAddress, instance?.PublicIpAddress?.IpAddress]
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .map((v) => String(v ?? '').trim())
    .filter((v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(v))[0] ?? null;
}

export function createAliyun({ accessKeyId, accessKeySecret }) {
  if (!accessKeyId || !accessKeySecret) {
    throw new CloudError(
      'auth',
      '缺少阿里云凭据：需要 ALIYUN_ACCESS_KEY_ID 与 ALIYUN_ACCESS_KEY_SECRET（**国际站** RAM 用户的 AccessKey）'
    );
  }

  async function call(host, version, action, params = {}, opts = {}) {
    const all = {
      Format: 'JSON',
      Version: version,
      AccessKeyId: accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      SignatureVersion: '1.0',
      SignatureNonce: randomUUID(),
      Action: action,
      ...params,
    };
    const { signature } = signRpc({ params: all, secret: accessKeySecret });
    // POST 表单：UserData（base64）与域名列表都会把 URL 撑长，走 body 更稳
    return apiCall({
      provider: 'aliyun',
      action,
      url: `https://${host}/`,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: qs({ ...all, Signature: signature }),
      attempts: opts.attempts,
      errorCode: (o) => o?.Code,
    });
  }
  const ecs = (region, action, params, opts) => call(`ecs.${region}.aliyuncs.com`, ECS_VERSION, action, { RegionId: region, ...params }, opts);

  /**
   * 默认 VPC/交换机：RunInstances 建 VPC 类型实例的前提（官方文档要求"预先创建"）。
   *
   * ⚠️ `CreateVpc` 是**异步**的（官方原文："系统会返回一个实例 ID，但该 VPC 尚未创建完成，
   * 系统后台的创建任务仍在进行"）。紧接着建交换机必被拒（`IncorrectVpcStatus`），
   * 所以这里必须**等到 VPC 真的可用**再建子网 —— 这条路径只在"账号里本来没有 VPC"时才走到，
   * 正是最不容易被测到、也最容易在真实新账号上翻车的那一段。
   */
  async function resolveNetwork(region) {
    const vpcs = await ecs(region, 'DescribeVpcs', { PageSize: 50 });
    let vpcId = (vpcs.Vpcs?.Vpc ?? []).find((v) => v.IsDefault)?.VpcId ?? (vpcs.Vpcs?.Vpc ?? [])[0]?.VpcId;
    if (!vpcId) {
      const zones = await ecs(region, 'DescribeZones', {});
      const zoneId = (zones.Zones?.Zone ?? [])[0]?.ZoneId;
      const created = await ecs(region, 'CreateVpc', { CidrBlock: '172.16.0.0/12', VpcName: 'mk-provision' });
      vpcId = created.VpcId;
      await waitVpcAvailable(region, vpcId);
      await ecs(region, 'CreateVSwitch', { ZoneId: zoneId, CidrBlock: '172.16.0.0/24', VpcId: vpcId, VSwitchName: 'mk-provision' });
    }
    const vsw = await ecs(region, 'DescribeVSwitches', { VpcId: vpcId, PageSize: 50 });
    const vswitchId = (vsw.VSwitches?.VSwitch ?? [])[0]?.VSwitchId;
    if (!vswitchId) {
      throw new CloudError('invalid', `阿里云 ${region} 的 VPC ${vpcId} 下没有交换机（vSwitch），无法创建 VPC 类型实例`, {
        provider: 'aliyun',
        action: 'DescribeVSwitches',
      });
    }
    return { vpcId, vswitchId };
  }

  /** 等 VPC 从 Pending 变成 Available（CreateVpc 是异步的，见 resolveNetwork 的说明） */
  async function waitVpcAvailable(region, vpcId, { timeoutMs = 120_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await ecs(region, 'DescribeVpcAttribute', { VpcId: vpcId });
      const status = r.Status ?? '';
      if (/Available/i.test(status)) return true;
      if (/Pending|Creating/i.test(status) || !status) {
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      throw new CloudError('invalid', `VPC ${vpcId} 状态是 ${status}，无法继续建子网`, { provider: 'aliyun', action: 'DescribeVpcAttribute' });
    }
    throw new CloudError('unavailable', `等 VPC ${vpcId} 可用超时 —— 去控制台看这个 VPC 的状态`, { provider: 'aliyun' });
  }

  const listInstances = async (region) => {
    /*
      必须**翻完所有页**：resume 的判据（"账号里有没有同名机器"）依赖这份列表完整。
      旧的写法只取一页（PageSize:100），第 101 台之后就看不见 —— 于是判成"没有"、再买一台。
    */
    const raw = await fetchAllPages({
      // 阿里云两种分页风格并存：新版给 NextToken（同一页里带回来），老版给 PageNumber + TotalCount
      fetchPage: (page) => ecs(region, 'DescribeInstances', { PageSize: PAGE_SIZE, PageNumber: page }),
      readPage: (r) => ({
        itemsPath: (x) => x.Instances?.Instance ?? [],
        nextToken: r.NextToken ?? null,
        total: Number.isFinite(Number(r.TotalCount)) ? Number(r.TotalCount) : null,
      }),
    });
    return raw.map((i) => ({
      id: i.InstanceId,
      name: i.InstanceName,
      status: i.Status,
      publicIp: firstPublicIp(i),
      privateIp: (i.VpcAttributes?.PrivateIpAddress?.IpAddress ?? [])[0] ?? null,
      region: i.RegionId,
      instanceType: i.InstanceType,
      createdAt: i.CreationTime,
    }));
  };

  /** 账号里可用的实名信息模板（域名注册的硬前提，见文件头第 3 条） */
  async function approvedTemplates() {
    const r = await call(DOMAIN.host, DOMAIN.version, 'QueryRegistrantProfiles', { PageSize: 100 });
    const list = r.RegistrantProfiles?.RegistrantProfile ?? [];
    return list.map((t) => ({
      id: String(t.RegistrantProfileId),
      status: t.RealNameStatus ?? 'unknown', // SUCCEED / AUDITING / FAILED / NONAUDIT
      emailVerified: String(t.EmailVerificationStatus ?? '') === '1',
      isDefault: String(t.DefaultRegistrantProfile ?? '') === 'true', // 字段名核对过：RegistrantProfileType 是 common|cnnic，不是默认标记
    }));
  }

  return defineProvider({
    id: 'aliyun',
    label: '阿里云',
    credentialsHint: 'ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET（RAM 用户；需要 ecs:*、alidns:*、domain:*、bss:DescribeAcccount）',
    defaultRegion: REGIONS[0].id,
    regions: REGIONS,

    describe: () => ({
      id: 'aliyun',
      label: '阿里云',
      endpoints: { ecs: `ecs.<region>.aliyuncs.com（按区域）`, dns: ALIDNS.host, domain: DOMAIN.host, billing: BSS.host },
      regions: REGIONS,
      defaultRegion: REGIONS[0].id,
      instanceTypes: INSTANCE_TYPES,
      image: `ImageFamily=${IMAGE_FAMILY}（由阿里云选该区域最新一版官方 Ubuntu 22.04）`,
      domainRegistrar: true,
      notes: [
        '机器按小时计费（PostPaid）并在创建时分配公网 IP，用 provision destroy 释放。',
        '域名走**国际站注册商**（domain-intl）：域名在中国大陆境外注册，**不能做 ICP 备案** —— 与非大陆区域的机器配套，整条链路不需要备案。',
        '域名注册自 2022-03-01 起必须带一个**已通过实名认证**的信息模板，且下单是异步任务（TaskNo + QueryTaskDetailList）。',
        '凭据必须来自**阿里云国际站**账号（中国站与国际站是两套隔离的账号体系，混用会报 InvalidAccessKeyId）。',
      ],
    }),

    /* ── 账号 ────────────────────────────────────────────────────────────── */
    async account() {
      const out = { balance: null, currency: null, identity: null, warnings: [] };
      // ① 凭据本身是否有效：GetCallerIdentity **不需要任何 RAM 权限**，是唯一干净的"钥匙对不对"判据。
      //    先用它，就能把"密钥错"与"缺某项权限"彻底分开 —— 否则一个 bss 权限缺失会被报成"密钥无效"。
      const stsHost = `sts.${REGIONS[0].id}.aliyuncs.com`;
      const ident = await call(stsHost, STS.version, 'GetCallerIdentity', {});
      out.identity = { accountId: ident.AccountId, arn: ident.Arn, type: ident.IdentityType };

      // ② 余额（需要 bss:DescribeAcccount；缺权限时如实说明，不把它算成密钥问题）
      try {
        const b = await call(BSS.host, BSS.version, 'QueryAccountBalance', {});
        /*
      余额取**数字或 null**，绝不让 NaN 流出去：`NaN != null` 为真、`NaN <= 0` 为假，
      于是"余额为 0 / 字段没返回"会被下游当成一个正常数字——既不拦也不警告，
      还会打印"余额：NaN"，然后在**下单那一刻**才失败。
      `account()` 的契约是 `balance: null` = 取不到，这里就按契约归一化一次。
    */
    const cash = Number(b.Data?.AvailableAmount ?? b.Data?.AvailableCashAmount ?? NaN);
    out.balance = Number.isFinite(cash) ? cash : null;
    if (out.balance == null) out.warnings.push('余额接口没有返回可用金额（AvailableAmount/AvailableCashAmount 都缺失）—— 这次不判余额，下单时若不足会以失败告终');
        out.currency = b.Data?.Currency ?? 'CNY';
        out.balanceDetail = b.Data;
      } catch (e) {
        out.warnings.push(`余额查询失败（${e.kind}）：${e.message} —— 需要 bss:DescribeAcccount 权限；不影响继续，但余额不足会在下单时才暴露`);
      }

      /*
        ③ 域名注册的账号级前提。
        注意判据的来源：模板这一关是**中国站注册商**（工信部实名）的要求，
        而我们固定走国际站。国际站是否暴露 QueryRegistrantProfiles、是否同样卡模板，
        我无法从公开文档确认 —— 所以这里只在**确实查到了模板列表**时才据此拦人；
        查不到就如实说明"看不到模板列表"，让下单去当那个判据（失败了会带原始错误码）。
        不这么做的话，"查不到"会被当成"没有模板"，把一个能跑通的账号挡在门外。
      */
      try {
        const tpl = await approvedTemplates();
        out.domainTemplates = tpl;
        if (tpl.length === 0) {
          out.domainBlockers = [
            '账号里没有"已实名认证且邮箱已验证"的域名信息模板（国际站若沿用中国站的模板要求，需要先补一个）',
            '去控制台「域名 → 信息模板」新建并等审核通过，或改用 --domain <已有的域名>（本工具只建解析，不注册）',
          ];
        } else {
          const ok = tpl.filter((t) => t.status === 'SUCCEED' && t.emailVerified);
          out.domainBlockers = ok.length
            ? []
            : [`账号里的信息模板都没有通过审核（共 ${tpl.length} 个，状态：${tpl.map((t) => t.status).join('/')}）`];
        }
      } catch (e) {
        out.domainTemplates = null;
        out.domainBlockers = [];
        out.warnings.push(`读不到域名信息模板列表（${e.kind}）：${e.message} —— 国际站可能不提供该接口，继续尝试注册；若注册失败会带原始错误码`);
      }
      return out;
    },

    listServers: async (region) => {
      const regions = region ? [region] : REGIONS.map((r) => r.id);
      const all = [];
      for (const r of regions) all.push(...(await listInstances(r)));
      return all;
    },

    async listDomains() {
      // QueryDomainList 用 PageNum 分页：只取第 1 页会漏掉第 101 个之后的域名
      const r = { Data: { Domain: await fetchAllPages({
        fetchPage: (page) => call(DOMAIN.host, DOMAIN.version, 'QueryDomainList', { PageNum: page, PageSize: PAGE_SIZE }),
        readPage: (res) => ({ itemsPath: (x) => x.Data?.Domain ?? [], total: Number.isFinite(Number(res.TotalItemNum)) ? Number(res.TotalItemNum) : null }),
      }) } };
      return (r.Data?.Domain ?? []).map((d) => ({
        name: d.DomainName,
        expiresAt: d.ExpirationDate,
        status: d.DomainStatus,
        audit: d.DomainAuditStatus,
      }));
    },

    /* ── 机器 ────────────────────────────────────────────────────────────── */
    async resolveImage(region) {
      const r = await ecs(region, 'DescribeImages', { ImageFamily: IMAGE_FAMILY, ImageOwnerAlias: 'system', PageSize: 10 });
      const img = (r.Images?.Image ?? [])[0];
      if (!img) {
        throw new CloudError('invalid', `阿里云 ${region} 上找不到 ${IMAGE_FAMILY} 的官方镜像（该区域可能没有这个镜像族）`, {
          provider: 'aliyun',
          action: 'DescribeImages',
        });
      }
      return { id: img.ImageId, name: img.OSName || img.ImageId, family: IMAGE_FAMILY };
    },

    /**
     * 安全组必须放行 80/443：Caddy 要过 ACME 的 HTTP-01 校验、买家要能访问 https。
     * 阿里云新建的安全组默认只通内网，缺这两条的症状是**证书永远签不下来**（而不是报错）。
     */
    async ensureSecurityGroup({ region, name }) {
      const listed = await ecs(region, 'DescribeSecurityGroups', { SecurityGroupName: name, MaxResults: 50 });
      let id = (listed.SecurityGroups?.SecurityGroup ?? []).find((g) => g.SecurityGroupName === name)?.SecurityGroupId;
      if (!id) {
        const { vpcId } = await resolveNetwork(region);
        const created = await ecs(region, 'CreateSecurityGroup', { VpcId: vpcId, SecurityGroupName: name, Description: 'marketplace-node' });
        id = created.SecurityGroupId;
      }
      for (const [port, desc] of [
        [22, 'ssh'],
        [80, 'http (ACME / redirect)'],
        [443, 'https (buyers)'],
      ]) {
        try {
          // 当前形态是 Permissions.N.* —— 扁平的 IpProtocol/PortRange 参数已标记 deprecated
          await ecs(region, 'AuthorizeSecurityGroup', {
            SecurityGroupId: id,
            'Permissions.1.Policy': 'accept',
            'Permissions.1.Priority': 1,
            'Permissions.1.IpProtocol': 'TCP',
            'Permissions.1.PortRange': `${port}/${port}`,
            'Permissions.1.SourceCidrIp': '0.0.0.0/0',
            'Permissions.1.Description': desc,
            /*
              刻意**不传 NicType**：它只对**经典网络**安全组有意义。官方原文——
              "For VPC security group rules, you do not need to set the network interface
              controller (NIC) type parameter. The default value is intranet, and only
              intranet is supported."。我们的机器都在 VPC 里，传 'internet' 正好撞在
              "only intranet is supported" 上（而它的默认值恰恰是 internet，所以只能不传）。
            */
          });
        } catch (e) {
          // 阿里云**没有**"规则已存在"这个错误码（官方原文：规则已存在时调用成功但不增加规则），
          // 所以这里不做重复判断 —— 不写一个永远不会命中的分支，那只会让人以为存在这种错误。
          throw e;
        }
      }
      return { id };
    },

    async createServer({ region, name, instanceType, sshPublicKey, securityGroupId, imageId, userData }) {
      // 每次部署一个独立密钥对：名字带随机后缀，避免与账号里同名的旧密钥冲突
      const keyName = `mk-${name}-${randomUUID().slice(0, 8)}`;
      await ecs(region, 'ImportKeyPair', { KeyPairName: keyName, PublicKeyBody: sshPublicKey });
      const { vswitchId } = await resolveNetwork(region);
      const r = await ecs(region, 'RunInstances', {
        ImageId: imageId,
        InstanceType: instanceType,
        SecurityGroupId: securityGroupId,
        VSwitchId: vswitchId,
        InstanceName: name,
        HostName: name,
        KeyPairName: keyName,
        InstanceChargeType: 'PostPaid',
        InternetChargeType: 'PayByTraffic',
        // >0 才会分配公网 IP（官方文档明说）；Caddy 申请证书要求它可达
        InternetMaxBandwidthOut: 5,
        'SystemDisk.Category': 'cloud_essd_entry',
        'SystemDisk.Size': 40,
        Amount: 1,
        ...(userData ? { UserData: Buffer.from(userData, 'utf8').toString('base64') } : {}),
      });
      const id = (r.InstanceIdSets?.InstanceIdSet ?? [])[0];
      if (!id) {
        throw new CloudError('unknown', `阿里云 RunInstances 没有返回实例 ID：${JSON.stringify(r).slice(0, 300)}`, {
          provider: 'aliyun',
          action: 'RunInstances',
        });
      }
      return { id, keyId: keyName };
    },

    async deleteServer({ region, id }) {
      await ecs(region, 'DeleteInstance', { InstanceId: id, Force: true });
      return { released: true };
    },

    async serverPublicIp({ region, id }) {
      const r = await ecs(region, 'DescribeInstances', { InstanceIds: JSON.stringify([id]) });
      const i = (r.Instances?.Instance ?? [])[0];
      if (!i) return { status: 'missing', publicIp: null };
      return {
        status: i.Status, // Pending / Running / Starting / Stopping / Stopped
        publicIp: firstPublicIp(i), // 解析只有这一处（见 firstPublicIp 的两个坑）
        privateIp: (i.VpcAttributes?.PrivateIpAddress?.IpAddress ?? [])[0] ?? null,
      };
    },

    /** 实时询价（按量付费 → PriceUnit=Hour）。取不到就上抛，由预算闸门要求用户显式给价。 */
    async serverMonthlyPrice({ region, instanceType, imageId }) {
      let r;
      try {
        r = await ecs(region, 'DescribePrice', {
          ResourceType: 'instance',
          InstanceType: instanceType,
          ImageId: imageId,
          PriceUnit: 'Hour',
          Amount: 1,
          'SystemDisk.Category': 'cloud_essd_entry',
          'SystemDisk.Size': 40,
          InternetMaxBandwidthOut: 5,
          InternetChargeType: 'PayByTraffic',
        });
      } catch (e) {
        throw new CloudError('unavailable', `阿里云询价失败（${e.kind}）：${e.message}`, { provider: 'aliyun', action: 'DescribePrice' });
      }
      const hourly = Number(r.PriceInfo?.Price?.TradePrice ?? NaN);
      if (!Number.isFinite(hourly)) {
        throw new CloudError('unavailable', `阿里云询价返回里没有 TradePrice：${JSON.stringify(r).slice(0, 200)}`, { provider: 'aliyun' });
      }
      // 询价返回小时价；折月按 730 小时（云厂商通用口径）
      return {
        monthly: +(hourly * 730).toFixed(2),
        currency: r.PriceInfo?.Price?.Currency ?? 'USD',
        source: `阿里云 DescribePrice 实时价（${hourly} × 730，币种 ${r.PriceInfo?.Price?.Currency ?? 'USD'}）`,
      };
    },

    /* ── DNS ─────────────────────────────────────────────────────────────── */
    async ensureZone({ domain }) {
      const listed = await call(ALIDNS.host, ALIDNS.version, 'DescribeDomains', { KeyWord: domain, SearchMode: 'EXACT', PageSize: 100 });
      const hit = (listed.Domains?.Domain ?? []).find((d) => d.DomainName === domain);
      if (hit) return { id: hit.DomainId, name: domain, nameservers: hit.DnsServers?.DnsServer ?? [] };
      const added = await call(ALIDNS.host, ALIDNS.version, 'AddDomain', { DomainName: domain });
      return { id: added.DomainId ?? domain, name: domain, nameservers: added.DnsServers?.DnsServer ?? [] };
    },

    async upsertARecord({ zoneName, rr, value }) {
      /*
        ⚠️ 这里**不能**传 SearchMode：官方原文是"填入 LIKE 或 EXACT 时，请使用 KeyWord 参数
        （传入 RRKeyWord、TypeKeyWord、ValueKeyWord、Type、Line、Status 参数无效）"。
        早先同时传 SearchMode='EXACT' 与 RRKeyWord/TypeKeyWord ⇒ 那两个过滤器被**静默忽略**，
        于是 upsert 可能给同一条记录再加一条（重复 A 记录），readARecord 也可能报"没有这条"。
        不传 SearchMode 时，RRKeyWord 模糊、TypeKeyWord 精确 —— 正是这里想要的语义。
      */
      const existing = await call(ALIDNS.host, ALIDNS.version, 'DescribeDomainRecords', {
        DomainName: zoneName,
        RRKeyWord: rr,
        TypeKeyWord: 'A',
        PageSize: 100,
      });
      const hit = (existing.DomainRecords?.Record ?? []).find((r) => r.RR === rr && r.Type === 'A');
      if (hit) {
        if (hit.Value === value) return { id: hit.RecordId, changed: false };
        await call(ALIDNS.host, ALIDNS.version, 'UpdateDomainRecord', { RecordId: hit.RecordId, RR: rr, Type: 'A', Value: value, TTL: 600 });
        return { id: hit.RecordId, changed: true };
      }
      const r = await call(ALIDNS.host, ALIDNS.version, 'AddDomainRecord', { DomainName: zoneName, RR: rr, Type: 'A', Value: value, TTL: 600 });
      return { id: r.RecordId, changed: true };
    },

    /* ── 域名注册 ────────────────────────────────────────────────────────── */
    /**
     * 可注册性 + 价格：**CheckDomain 一个接口给两样**（没有 QueryDomainPrice 这个接口）。
     * `Avail` 是字符串：'1'=可注册、'3'=可预注册、'4'=可删除预注册、'0'=不可、
     * '-1'/'-2'/'-3' 分别对应异常/暂停注册/黑名单。
     *
     * ⚠️ `FeeCurrency` **只有 USD 一个合法值**（官方参数表就列了 USD），
     * 所以这里写死 USD、不接受调用方传币种 —— 传 CNY 会被参数校验拒掉。
     * 代价是：`StaticPriceInfo.money` 到底按 USD 还是账号币种计价，文档没写死，
     * 因此把币种**如实标出来**让预算闸门去判（非人民币就要求人自己换算），不替它猜。
     *
     * 价格条目的 `action` 字段官方示例给的是 `activate`（FeeCommand 的取值才是 create），
     * 所以匹配时以 activate 为主、其余兜底取第一条 —— 只按 'create' 找会找不到。
     */
    async domainPrice({ domain, years = 1 }) {
      const r = await call(DOMAIN.host, DOMAIN.version, 'CheckDomain', {
        DomainName: domain,
        FeeCommand: 'create',
        FeePeriod: years,
        FeeCurrency: 'USD',
      });
      const avail = String(r.Avail ?? '');
      const entries = r.StaticPriceInfo?.PriceInfo ?? [];
      const priceEntry = entries.find((p) => p.action === 'activate') ?? entries.find((p) => p.action === 'create') ?? entries[0];
      const amount = Number(priceEntry?.money ?? r.Price ?? NaN);
      /*
        币种：`PriceInfo[]` 只有 {action, money, period} 三个字段（**没有 currency**），
        而请求里的 FeeCurrency 固定是 USD —— 所以这里只能按 USD 标注，并把这件事写进 source，
        让用户知道"这个数字是美元、要按元核算得自己给 --price-domain"。
      */
      const currency = 'USD';
      return {
        available: avail === '1',
        availCode: avail,
        reason: r.Reason ?? null,
        premium: String(r.Premium) === 'true',
        // 注意：Avail=1 只说明"这个名字能注册"，**不说明账号有资格买**（实名模板那关由 account() 报）
        yearly: Number.isFinite(amount) ? amount / Math.max(1, years) : null,
        total: Number.isFinite(amount) ? amount : null,
        currency,
        source: `阿里云 CheckDomain 实时价（${currency}${currency === 'USD' ? '，按 USD 报；要按元核算请用 --price-domain' : ''}）`,
      };
    },

    /**
     * 下单是**异步任务**：接口只回 TaskNo，注册结果要轮询 QueryTaskDetailList。
     * 这里把"任务已提交"与"域名已到手"分开返回，调用方必须轮询 —— 不假装下单即完成
     * （官方口径：支付成功 ≠ 注册成功，注册局审核还要 1~3 个工作日）。
     */
    async buyDomain({ domain, years = 1, templateId }) {
      if (!templateId) {
        throw new CloudError(
          'invalid',
          '阿里云注册域名必须带一个已通过实名认证的信息模板（RegistrantProfileId）：2022-03-01 起不再接受直接传持有者信息',
          { provider: 'aliyun', action: 'SaveSingleTaskForCreatingOrderActivate' }
        );
      }
      const r = await call(DOMAIN.host, DOMAIN.version, 'SaveSingleTaskForCreatingOrderActivate', {
        DomainName: domain,
        SubscriptionDuration: years,
        RegistrantProfileId: templateId,
        AliyunDns: 'true',
        EnableDomainProxy: 'false',
      });
      /*
        响应只有 RequestId + TaskNo（官方输出参数就这两个）——**没有** Result/Message。
        所以这里不判"下单被拒"：判据在轮询那一步（QueryTaskDetailList 的 TaskStatus/ErrorMsg）。
        早先按 .Result === false 写了一个永远不会命中的守卫，那比没有更糟：它让人以为这里会拦住失败。
      */
      return { taskId: r.TaskNo ?? null, accepted: true };
    },

    /** 轮询注册任务：EXECUTE_SUCCESS / EXECUTE_FAILURE / EXECUTING 三种状态如实返回 */
    async domainTask({ taskId, domain }) {
      const r = await call(DOMAIN.host, DOMAIN.version, 'QueryTaskDetailList', { TaskNo: taskId, PageNum: 1, PageSize: 100 });
      const rows = r.Data?.TaskDetail ?? [];
      const mine = domain ? rows.find((x) => x.DomainName === domain) ?? rows[0] : rows[0];
      return {
        status: mine?.TaskStatus ?? 'unknown', // WAITING_EXECUTE / EXECUTING / EXECUTE_SUCCESS / EXECUTE_FAILURE
        code: mine?.TaskStatusCode,
        error: mine?.ErrorMsg || mine?.FailReason || null,
        raw: mine ?? null,
      };
    },

    domainTemplates: approvedTemplates,
  });
}
