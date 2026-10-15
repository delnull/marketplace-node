/**
 * 拿钥匙的说明书 —— **唯一的家，而且正好出现在用户需要它的那一刻**。
 *
 * 为什么放在代码里而不是文档里：这一步是"用户第一次跑就会撞上"的，而撞上的那一刻他正在看终端。
 * 让他离开终端去翻文档，等于把一个必然发生的步骤外包给运气。所以：
 *   · 缺凭据时（`credentialError`）→ 直接把控制台路径与权限清单打在他眼前；
 *   · `providers` / 想先看看时（`channelsHelpLines`）→ 同样能看到。
 *
 * 每条都写三样：**去哪点**（控制台地址）、**给什么权限**（照抄的策略名）、**填哪两个环境变量**。
 * 少任何一样，用户都会卡住：只给地址他不知道要开什么权限，只给权限名他不知道去哪开。
 */
import { CloudError } from './errors.mjs';

/** 控制台入口按站点分开写：中国站与国际站是两套隔离的账号，进错站拿的 key 用不了 */
export const CHANNELS = Object.freeze({
  aliyun: {
    id: 'aliyun',
    label: '阿里云（国际站）',
    site: 'intl',
    console: 'https://ram.console.alibabacloud.com/',
    // 权限策略里的动作名与接口名偶尔不同名，例如余额接口叫 QueryAccountBalance，而 RAM 动作名是 bss:DescribeAcccount（官方拼写就是三个 c）
    steps: [
      '打开 https://ram.console.alibabacloud.com/ → 左侧「Identities / 身份管理 → Users / 用户」',
      '新建一个 RAM 用户，访问方式勾「OpenAPI 访问」',
      '给这个用户加权限：附加系统策略 AliyunECSFullAccess + AliyunDNSFullAccess + AliyunDomainFullAccess（下面列了实际用到的动作，想按最小权限来就照它自定义一条策略）',
      '回到该用户 →「Credential / 认证管理 → AccessKey → Create AccessKey」',
      'AccessKey Secret 只在创建时显示一次，关掉对话框就再也看不到 —— 当场存好',
    ],
    env: ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET'],
    pitfalls: [
      '别用主账号的 AccessKey：它默认拥有账号下全部权限；建一个 RAM 用户再给它发 key',
      'key 必须来自国际站账号（alibabacloud.com）。中国站与国际站是两套隔离的账号体系，混用会报 InvalidAccessKeyId',
      '账号要先完成实名认证，否则连余额都查不出来',
    ],
    actions: [
      'sts GetCallerIdentity',
      'bss QueryAccountBalance',
      'ecs DescribeRegions DescribeImages DescribeInstances DescribeVpcs DescribeVSwitches DescribeZones DescribeSecurityGroups DescribePrice DescribeVpcAttribute',
      'ecs CreateVpc CreateVSwitch CreateSecurityGroup AuthorizeSecurityGroup ImportKeyPair RunInstances DeleteInstance',
      'alidns DescribeDomains AddDomain DescribeDomainRecords AddDomainRecord UpdateDomainRecord',
      'domain QueryRegistrantProfiles QueryDomainList CheckDomain SaveSingleTaskForCreatingOrderActivate QueryTaskDetailList',
    ],
  },
  tencent: {
    id: 'tencent',
    label: '腾讯云（国际站）',
    site: 'intl',
    console: 'https://console.intl.cloud.tencent.com/cam/capi',
    steps: [
      '打开 https://console.intl.cloud.tencent.com/cam/capi （国际站控制台 →「访问管理 → API 密钥管理」）',
      '先建一个子用户（「用户 → 用户列表 → 新建用户」，勾「编程访问」）再给它单独发密钥；别直接用主账号密钥',
      '给这个用户加策略：QcloudCVMFullAccess + QcloudVPCFullAccess + QcloudDNSPodFullAccess + QcloudDomainFullAccess，再加一个只读财务策略（控制台里叫「财务只读」之类，用于查余额）',
      '在「API 密钥管理」里「新建密钥」，把 SecretId 与 SecretKey 都存下来',
      'SecretKey 只在创建时显示一次',
    ],
    env: ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'],
    pitfalls: [
      '账号要先完成实名认证，否则余额接口会失败',
      '域名走国际站注册商（domain.intl）—— 用中国站的账号/密钥会打到另一套域名接口上',
    ],
    actions: [
      'cvm DescribeRegions DescribeInstances DescribeZones DescribeImages',
      'cvm ImportKeyPair RunInstances TerminateInstances InquiryPriceRunInstances',
      'vpc DescribeSecurityGroups CreateSecurityGroup CreateSecurityGroupPolicies',
      'dnspod DescribeDomain CreateDomain DescribeRecordList CreateRecord ModifyRecord',
      'domain CheckIntlDomainNew DescribeIntlDomainPriceNewList DescribeIntlTemplateList CreateIntlDomainBatch DescribeIntlDomainBatchDetails DescribeIntlDomainList',
      'billing DescribeAccountBalance',
    ],
  },
  aws: {
    id: 'aws',
    label: 'AWS',
    site: 'global',
    console: 'https://console.aws.amazon.com/iam/home#/users',
    steps: [
      '打开 https://console.aws.amazon.com/iam/home#/users →「Create user」',
      '不要勾「Provide user access to the AWS Management Console」（本工具只用 API，不需要登录控制台）',
      '下一步选「Attach policies directly」，新建一条内联策略：把下面列出的动作照抄进去（这就是本工具实际会用到的全部权限）',
      '建好后点进该用户 →「Security credentials → Access keys → Create access key」，场景选 Command Line Interface (CLI)',
      '把 Access key ID 与 Secret access key 存下来（Secret 只显示这一次）',
    ],
    env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    pitfalls: [
      '账号要绑定可用的付款方式才能注册域名；Route 53 的注册费不能用 AWS 抵扣额度（credits）付',
      '域名注册后注册局会往 --email 发一封 ICANN 验证信，必须点确认，否则域名会被挂起',
      'Route 53 Domains 只在美国东部（us-east-1）有端点 —— 已写死，你不用选',
    ],
    actions: [
      'sts GetCallerIdentity',
      'ec2 DescribeRegions DescribeImages DescribeSubnets DescribeInstances DescribeSecurityGroups',
      'ec2 CreateSecurityGroup AuthorizeSecurityGroupIngress ImportKeyPair RunInstances TerminateInstances',
      'route53 ListHostedZonesByName GetHostedZone CreateHostedZone ListResourceRecordSets ChangeResourceRecordSets',
      'route53domains CheckDomainAvailability ListPrices ListDomains RegisterDomain GetOperationDetail',
    ],
  },
});

/**
 * 凭据缺失时打印的**完整走法**。
 * @param {string} provider
 * @param {{ missing?: string[] }} [o]
 * @returns {string} 多行文本（不带尾部换行）
 */
export function credentialHelp(provider, o = {}) {
  const c = CHANNELS[provider];
  if (!c) return '';
  const lines = [];
  lines.push(`${c.label}的 API 凭据怎么拿（照着点一遍就行）：`);
  for (const [i, s] of c.steps.entries()) lines.push(`  ${i + 1}. ${s}`);
  lines.push('');
  lines.push('  拿到后填这两个环境变量（不要写进命令行参数：会留在 shell 历史与进程列表里）：');
  for (const k of c.env) {
    lines.push(`    PowerShell:  $env:${k}='…'`);
    lines.push(`    bash/zsh:    export ${k}=…`);
  }
  if (o.missing?.length) {
    lines.push('');
    lines.push(`  当前缺的是：${o.missing.join('、')}`);
  }
  if (c.pitfalls?.length) {
    lines.push('');
    lines.push('  几个容易踩的：');
    for (const p of c.pitfalls) lines.push(`    · ${p}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 抛错版本的包装：**错误信息本身就是说明书**。
 * 这一条是"用户拿不到 key 就一切白搭"的正面解法 —— 把必然发生的那一步，
 * 放在他必然会看到的地方。
 */
export function credentialError(provider, missing) {
  const c = CHANNELS[provider];
  return new CloudError('auth', `缺少 ${c?.label ?? provider} 的凭据：${missing.join('、')}\n${credentialHelp(provider, { missing })}`, {
    provider,
  });
}

/** `providers` 命令用：三家的入口与权限清单（不需要先有 key 也能看） */
export function channelsHelpLines() {
  const out = [];
  for (const c of Object.values(CHANNELS)) {
    out.push(`${c.label}   控制台：${c.console}`);
    out.push(`  环境变量：${c.env.join(' + ')}`);
    for (const s of c.steps) out.push(`    · ${s}`);
    for (const a of c.actions) out.push(`      ${a}`);
    out.push('');
  }
  return out;
}
