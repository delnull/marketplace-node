/**
 * 云服务商适配器的**共同契约**（三家都实现这一组，没有第二套形状）。
 *
 * 这里定义的是一条硬边界：**能做的事由实现本身决定，不由字段声明决定**。
 * 于是"某家买不了域名"是**编译期/启动期就成立的事实**（该方法根本不存在），
 * 而不是运行时才发现的失败，更不是一句被吞掉的 warn（本仓最忌讳的形状：
 * "看起来跑完了，其实那一步被静默降级了"）。
 *
 * 每个适配器还必须提供 `describe()`：各家的 API 差异（签名、区域名、镜像 ID、
 * 能不能买域名）全部写在里面 —— 用户在 check 阶段一眼看到"这家能做什么、要什么凭据"，
 * 而不是等到 up 跑到一半才被拒。
 */

/**
 * 这三家是支持的。两条硬条件，缺一不进这个名单：
 *   1. 在**非中国大陆区域**有机器；
 *   2. 有**境外注册商**的域名注册接口（阿里云国际站 / 腾讯云国际站 / AWS Route 53）。
 * 第 2 条不是偏好：域名在境外注册 + 机器在境外，整条链路才**不存在"要不要 ICP 备案"这个问题**。
 * 名单里只放满足这两条的实现，是为了让"备案"这件事在代码里**不可表达** ——
 * 而不是留给运行期去判断某个 flag 有没有设对。
 */
export const PROVIDER_IDS = Object.freeze(['aliyun', 'tencent', 'aws']);

/**
 * 必需方法的形状（缺失即启动期报错，不留"半成品适配器能跑一半"的余地）。
 *
 * ⚠️ 名单里**只放真被调用的方法**（2026-10-15 审计 F10）：此前还列着 `listRegions` 与
 * `readARecord` —— 三家适配器都老实实现了，而**生产代码零调用**（只有测试直接调它们，
 * 于是测试的覆盖率还让人以为它被用着）。这类成员比没有更糟：它把没人用的义务混进
 * "适配器要写什么"的唯一清单里，新加一家时照它实现一遍、然后在生产里永远不跑。
 * 以后要加方法就**同批加调用点**——调用点在哪儿，"这个方法干什么"就写在哪儿。
 */
const REQUIRED = [
  'describe',
  'account',
  'listServers',
  'listDomains',
  'resolveImage',
  'ensureSecurityGroup',
  'createServer',
  'deleteServer',
  'serverPublicIp',
  'serverMonthlyPrice',
  'ensureZone',
  'upsertARecord',
  'domainPrice',
  'buyDomain',
];

/**
 * @param {object} impl
 * @param {string} impl.id
 * @param {object} impl.describe 见各适配器的 describe()
 */
export function defineProvider(impl) {
  // 先判 id：不然一个拼错的 provider 名会被报成"缺 16 个方法"，把真正的原因盖住
  if (!PROVIDER_IDS.includes(impl.id)) throw new Error(`未知的 provider id：${impl.id}（可用：${PROVIDER_IDS.join(', ')}）`);
  const missing = REQUIRED.filter((k) => typeof impl[k] !== 'function');
  if (missing.length) throw new Error(`适配器 ${impl.id} 缺少必需方法：${missing.join(', ')}`);
  return Object.freeze(impl);
}

/**
 * "能不能买域名"的唯一判据：**方法在不在**。
 * 调用方（CLI/编排）用它做前置拒绝，且拒绝发生在花任何钱之前。
 */
export function canBuyDomain(provider) {
  return typeof provider.buyDomain === 'function' && typeof provider.domainPrice === 'function';
}
