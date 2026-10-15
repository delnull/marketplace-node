#!/usr/bin/env node
/**
 * provision — 给一把云 API key，把"服务器 + 域名 + 解析 + HTTPS + 店铺节点"一次做完。
 *
 * 用法（PowerShell / bash 都一样）：
 *   node provision/cli.mjs providers
 *   node provision/cli.mjs check   --provider aliyun --domain shop.example.com
 *   node provision/cli.mjs plan    --provider aliyun --domain shop.example.com --buy --owner 0x… \
 *                                  --email me@example.com --max-monthly 60 --max-domain-year 90
 *   node provision/cli.mjs up      …（同上，真正下单）
 *   node provision/cli.mjs verify  --shop default
 *   node provision/cli.mjs destroy --shop default [--keep-domain]
 *
 * 凭据**只从环境变量读**（不落盘、不进命令行历史、不写日志）：
 *   阿里云   ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET（**国际站**账号）
 *   腾讯云   TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY
 *   AWS      AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 *
 * 退出码：0 成功；1 运行期失败；2 用法错；3 **闸门拒绝**（预算不够 / 账号没就绪 / 缺前置 —— 重跑同样参数不会变好）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ADVICE, CloudError, describe, KIND } from './lib/errors.mjs';
import { PROVIDER_IDS } from './lib/provider.mjs';
import { up } from './lib/up.mjs';
import { destroy } from './lib/destroy.mjs';
import { ensureCreds } from './lib/creds.mjs';
import { loadState } from './lib/state.mjs';
import { describeResume } from './lib/resume.mjs';
import { resolveZone } from './lib/zone.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/* ── 参数表：一处定义，用法与解析都从这里生成（不再有"文档里写了、代码里不认"的漂移）── */
const FLAGS = {
  '--provider': { arg: 'provider', help: 'aliyun | tencent | aws', required: true },
  '--region': { arg: 'region', help: '区域 ID（默认各家的香港/新加坡）' },
  '--domain': { arg: 'domain', help: '买家访问的域名，如 shop.example.com', required: true },
  '--zone': { arg: 'zone', help: '解析区（可注册的那一级），默认自动取域名后两段' },
  '--buy': { arg: 'buy', bool: true, help: '域名不在账号里时**买下它**（要走域名单价闸门）' },
  '--years': { arg: 'years', num: true, default: 1, help: '域名注册年限（默认 1）' },
  '--owner': { arg: 'owner', help: '店主钱包地址（店铺身份锚点）', required: true },
  '--email': { arg: 'email', help: 'Let’s Encrypt 到期提醒邮箱', required: true },
  '--max-monthly': { arg: 'maxMonthly', num: true, help: '**支出授权**：全部资源折合每月上限（元/月）。不给就不创建任何资源' },
  '--max-domain-year': { arg: 'maxDomainYear', num: true, help: '域名单价上限（元/年）；要买域名时必须给' },
  '--instance-type': { arg: 'instanceType', help: '指定机型（默认自动挑该区域有货的最小规格）' },
  '--price-server': { arg: 'priceServer', num: true, help: '机型月价（元/月）：AWS 没有询价接口，必须自己给（阿里云/腾讯云会自动询价）' },
  '--price-domain': { arg: 'priceDomain', num: true, help: '域名单价（元/年）：服务商查不到价格时必须自己给' },
  '--contact-first-name': { arg: 'contactFirstName', help: 'AWS 注册域名用：名' },
  '--contact-last-name': { arg: 'contactLastName', help: 'AWS 注册域名用：姓' },
  '--contact-phone': { arg: 'contactPhone', help: 'AWS 注册域名用：电话（+86.138…）' },
  '--contact-address': { arg: 'contactAddress', help: 'AWS 注册域名用：街道地址' },
  '--contact-city': { arg: 'contactCity', help: 'AWS 注册域名用：城市' },
  '--contact-country': { arg: 'contactCountry', help: 'AWS 注册域名用：两位国家码（如 CN）' },
  '--contact-zip': { arg: 'contactZip', help: 'AWS 注册域名用：邮编' },
  '--ssh-user': { arg: 'sshUser', default: 'root', help: 'SSH 登录用户（Ubuntu 镜像默认 root）' },
  '--ssh-key-type': { arg: 'sshKeyType', default: 'rsa', help: 'rsa | ed25519（默认 rsa：三家都能导入）' },
  '--install-dir': { arg: 'installDir', default: '/opt/marketplace-node', help: '服务器上的安装目录' },
  '--server-name': { arg: 'serverName', default: 'marketplace-node', help: '云上的实例名（也是"已有一台"的判据）' },
  '--shop': { arg: 'shop', default: 'default', help: '本地状态键（同机多店时区分）' },
  '--rev': { arg: 'rev', default: 'HEAD', help: '发布哪个提交的 node/（默认 HEAD）' },
  '--adopt': { arg: 'adopt', help: '认领一台已有机器（实例 ID 或公网 IP）：机器开出来了但状态没写成时的唯一安全出路' },
  '--allow-zero-balance': { arg: 'allowZeroBalance', bool: true, help: '余额为 0 也继续（仅当你清楚走的是后付费/信用额度）' },
  '--json': { arg: 'json', bool: true, help: '把结果以 JSON 打到 stdout（进度日志仍走 stderr）' },
  '--i-know-data-is-lost': { arg: 'iKnowDataIsLost', bool: true, help: 'destroy 时数据卷导不出来也照样释放（**商品/订单/附件会永久丢失**）' },
  '--dry-run': { arg: 'dryRun', bool: true, help: '算完价格、过完闸门就停，不创建任何资源' },
  '-h': { arg: 'help', bool: true, help: '看用法' },
  '--help': { arg: 'help', bool: true },
};

const COMMANDS = ['providers', 'check', 'plan', 'up', 'verify', 'destroy'];

function usage() {
  const lines = [
    'provision —— 一把云 API key，一条流程部署好商城节点（服务器 + 域名 + 解析 + HTTPS + 节点）',
    '',
    '用法：node provision/cli.mjs <命令> [参数]',
    `命令：${COMMANDS.join(' | ')}`,
    '',
    '参数：',
  ];
  for (const [flag, spec] of Object.entries(FLAGS)) {
    if (flag === '--help') continue;
    const arg = spec.arg ? ` <${spec.arg}>` : '';
    lines.push(`  ${flag}${arg}`.padEnd(26) + (spec.help ?? '') + (spec.required ? '（check/plan/up 必填）' : ''));
  }
  lines.push('', '凭据（只从环境变量读，不落盘、不进日志）：');
  for (const id of PROVIDER_IDS) {
    const { PROVIDERS } = credsTable();
    lines.push(`  ${id.padEnd(8)}${PROVIDERS[id]}`);
  }
  lines.push('', '**还没拿到 key？** 跑 `node provision/cli.mjs providers`：');
  lines.push('  它会打印每家的控制台入口、该开哪些权限、以及要填哪两个环境变量（照着点一遍即可）。');
  lines.push('  凭据没配好时跑 check/plan/up，报错里也会带同一份走法。');
  lines.push('', '退出码：0 成功；1 运行期失败；2 用法错；3 闸门拒绝（预算/账号未就绪 —— 重跑不会变好）');
  return lines.join('\n');
}

function credsTable() {
  return {
    PROVIDERS: {
      aliyun: 'ALIYUN_ACCESS_KEY_ID + ALIYUN_ACCESS_KEY_SECRET',
      tencent: 'TENCENTCLOUD_SECRET_ID + TENCENTCLOUD_SECRET_KEY',
      aws: 'AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY',
    },
  };
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const spec = FLAGS[a];
    if (!spec) {
      if (a.startsWith('-')) throw Object.assign(new Error(`未知参数：${a}`), { usage: true });
      o._.push(a);
      continue;
    }
    if (spec.bool) {
      /*
        开关型参数**不接受取值**，而且要当场拒绝 `--buy true` 这类写法。
        为什么较真：`--buy true` 里的 `true` 会被当成下一个位置参数，而 `--buy --owner 0x…`
        会把它后面的东西吃掉当值 —— 用户看到的是"我明明给了 owner 却说缺 owner"。
        （本仓对兜底式宽容的立场：宁可报错，也不猜。）
      */
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        throw Object.assign(new Error(`${a} 是开关，不接受取值（收到：${next}）`), { usage: true });
      }
      o[spec.arg] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw Object.assign(new Error(`${a} 缺少取值`), { usage: true });
    o[spec.arg] = spec.num ? Number(v) : v;
  }
  for (const [, spec] of Object.entries(FLAGS)) {
    if (spec.default !== undefined && o[spec.arg] === undefined) o[spec.arg] = spec.default;
  }
  return o;
}

/** 每个命令要什么参数：**在这里一次说清**，而不是在各分支里零散地判 */
function requireFor(cmd, o) {
  if (cmd === 'providers') return;
  if (['check', 'plan', 'up'].includes(cmd)) {
    for (const k of ['provider', 'domain', 'owner', 'email']) {
      const flag = Object.entries(FLAGS).find(([, s]) => s.arg === k)?.[0];
      if (!o[k]) throw Object.assign(new Error(`缺少 ${flag}（跑 provision/cli.mjs --help 看用法）`), { usage: true });
    }
    if (!PROVIDER_IDS.includes(o.provider)) throw Object.assign(new Error(`--provider 只能是 ${PROVIDER_IDS.join(' | ')}`), { usage: true });
    if (!/^0x[0-9a-fA-F]{40}$/.test(o.owner)) throw Object.assign(new Error(`--owner 必须是 0x 开头的 40 位十六进制地址：${o.owner}`), { usage: true });
    if (!/^[^\s.]+(\.[^\s.]+)+$/.test(o.domain)) throw Object.assign(new Error(`--domain 不像一个域名：${o.domain}`), { usage: true });
    /*
      `--years` 的边界收在这里（参数层），而不是在算钱的公式里：
      域名注册局普遍限制单次年限（.com 是 1–10 年），而闸门是按"总价 ÷ (年 × 12)"折成月成本的
      —— 年限填大只会把月成本**摊薄**，于是闸门低估、真下单却可能被注册局拒。
      花钱闸门上的输入必须在入口就合法，不能让"看起来更便宜"的值通过。
    */
    if (!(Number.isInteger(o.years) && o.years >= 1 && o.years <= 10)) {
      throw Object.assign(new Error(`--years 只能是 1~10 的整数（注册局的单次年限上限，收到：${o.years}）`), { usage: true });
    }
  }
  if (cmd === 'up' && !(o.maxMonthly > 0)) {
    // 这一条不是用法错，而是**闸门拒绝**：用户很可能只是先看看，那就该看到"为什么不能买"
    throw Object.assign(
      new Error(
        '没有支出授权：up 必须显式给出 --max-monthly <元/月>。\n' +
          '  脚本会真的下单（机器按小时计费、域名一次性扣费，都不可撤销）。\n' +
          '  先跑 `plan` 看这次要花多少，再带着额度跑 `up`。'
      ),
      { gate: true }
    );
  }
}

async function buildProvider(o) {
  const { loadProvider } = await import('./providers/index.mjs');
  return loadProvider(o.provider, await ensureCreds(o.provider, o));
}

/* ── 命令实现 ────────────────────────────────────────────────────────────── */
async function cmdProviders(o, log) {
  const { describeAll } = await import('./providers/index.mjs');
  const { channelsHelpLines } = await import('./lib/credentialHelp.mjs');
  /*
    这个命令的用途是"我还没有 key，先看看要办什么" —— 所以默认打印**能照着做**的走法
    （控制台地址 + 权限清单 + 环境变量名），而不是先甩一坨 JSON。
    要看结构化能力清单就加 --json（stdout 干净，方便脚本）。
  */
  if (!o.json) {
    log('三家都支持"非中国大陆机器 + 境外注册商域名"，所以都不需要 ICP 备案。先看怎么拿 key：');
    log('');
    for (const line of channelsHelpLines()) log(line);
  }
  return describeAll();
}

async function cmdCheck(o, log) {
  const provider = await buildProvider(o);
  const out = { provider: provider.describe(), account: null, costs: null, gates: [] };
  log(`检查 ${provider.label} 账号与前置条件 …`);
  /*
    `check` 是只读的"我现在在哪一步"命令，所以它必须先回答**本地状态**这件事：
    用户跑它多半就是因为"断了一次，不知道还要不要重买"。这份结论与 `up` 开头用的是同一份实现
    （resume.mjs），不另写一套 —— 两处口径不一致比没有更糟。
  */
  const st = loadState(REPO_ROOT, o.shop);
  out.localState = st
    ? { shop: o.shop, server: st.server?.id ?? null, publicIp: st.server?.publicIp ?? null, domain: st.domain ?? null, deployedRev: st.node?.deployedRev ?? null, verifiedAt: st.verified?.at ?? null }
    : null;
  log(`本地状态（店铺 ${o.shop}）：`);
  for (const line of describeResume(st)) log(`  ${line}`);
  log('');
  const acct = await provider.account();
  out.account = acct;
  log(`  余额：${acct.balance ?? '取不到'} ${acct.currency ?? ''}`);
  for (const w of acct.warnings ?? []) log(`  ⚠ ${w}`);
  const servers = await provider.listServers(o.region || provider.defaultRegion);
  // 三态：`null` = 读不到（判据说明见 up.mjs 同处——把"读不到"当成"没有"会去买一个已有的域名）
  const domains = await provider.listDomains().catch(() => null);
  out.existing = { servers, domains };
  log(
    domains === null
      ? `  已有服务器：${servers.length} 台；已有域名：读不到（列表接口失败——**不代表**账号里没有域名）`
      : `  已有服务器：${servers.length} 台；已有域名：${domains.length} 个`
  );

  // 域名前置（能不能买）——这是"账号状态"，不是代码能力；就绪与否必须在这里说清。
  // 判据**只来自 provider.account() 的 domainBlockers**（谁提供服务，谁判断它自己的前置条件）；
  // 这里不再自己拿模板列表重新判一次 —— 两处判定必然会在"接口不可用时"给出相反结论，
  // 而那条结论会挡住一个本来能跑通的账号。
  /*
    模板列表：`account()` 已给就用它；没有再单独问一次；**问不到就保持"没读到"**（`null`），
    不写成 `[]`（2026-10-15 审计 F7）——`[]` 读起来是"这个账号没有模板"这个**结论**，
    而真相可能是"这次没读到"。用它的地方只有展示（判据是 `acct.domainBlockers`，见下），
    所以 `null` 只会让输出多一句"没读到"，不会挡住任何能跑的账号。
  */
  const tpls = acct.domainTemplates ?? (await provider.domainTemplates?.().catch(() => null)) ?? null;
  out.domainTemplates = tpls;
  /*
    "域名要不要买"看的是**解析区**（可注册的那一级），不是节点用的主机名 ——
    `--domain shop.example.com` 而账号里有 `example.com` 时，域名是**已有**的，不该要求 --buy。
    判据与 up 走同一个 resolveZone（lib/zone.mjs），不在这里再推一遍。
  */
  const zoneName = resolveZone({ domain: o.domain, zone: o.zone });
  const domainOwned = domains.some((d) => d.name === zoneName);
  out.domain = { name: o.domain, zone: zoneName, owned: domainOwned, templates: tpls };
  if (!domainOwned) {
    const price = await provider.domainPrice({ domain: zoneName, years: o.years }).catch((e) => ({ error: describe(e), kind: e.kind }));
    out.domain.price = price;
    if (price.error) log(`  ⚠ 域名 ${zoneName} 询价失败：${price.error}`);
    else log(`  域名 ${zoneName}：${price.available ? '可注册' : '不可注册'}，${price.yearly ?? '?'} ${price.currency ?? ''}/年`);
    if ((acct.domainBlockers ?? []).length) {
      out.gates.push({
        kind: 'account_not_ready',
        why: acct.domainBlockers,
        fix: '按上面那条去控制台办完，或 --domain 换成已有的域名',
      });
    }
  } else {
    log(`  域名 ${o.domain} 已在账号里（不会花钱注册）`);
  }
  if (acct.balance != null && acct.balance <= 0) {
    out.gates.push({ kind: 'insufficient_balance', why: [`余额为 ${acct.balance}`], fix: '先充值' });
  }
  /*
    备案这条**必须说准**（阿里云备案文档原文）："托管于中国内地服务器的网站需完成工信部 ICP 备案，
    托管于非中国内地服务器的网站**无需工信部备案但需完成公安联网备案**"。
    我们的组合（非大陆机器 + 境外注册商域名）确实免掉了 ICP，但**公安联网备案仍然适用** ——
    少说这一句就是把一项法律义务说没了。所以这里只陈述事实，不替用户下"什么都不用办"的结论。
  */
  out.filing = {
    icp: 'not-required',
    reason: '域名解析指向非中国内地服务器 ⇒ 无需工信部 ICP 备案（阿里云备案文档口径）',
    policeNetworkFiling: '适用：托管于非中国内地服务器的网站仍需完成公安联网备案（同一份文档）',
  };
  log('  备案：无需工信部 ICP 备案（机器在非中国大陆区域 + 域名走境外注册商）');
  log('        ⚠ 公安联网备案仍然适用 —— 网站开办后按当地公安要求办理（法律义务，不是本工具的步骤）');
  log('');
  log(out.gates.length ? `结论：**还不能开工** —— ${out.gates.map((g) => g.fix).join('；')}` : '结论：账号与域名就绪，可以跑 plan/up。');
  return out;
}

async function cmdPlan(o, log) {
  const provider = await buildProvider(o);
  /*
    budget 的三样判据（闸门 enforce / 每月折合 / 域名单价该取哪个）在**函数开头**导入一次：
    它们在下面多处使用，而 `const {…} = await import(…)` 有 TDZ —— 写在首次使用之后会抛
    `Cannot access '…' before initialization`（2026-10-15 被 CLI 用例当场抓过一次）。
  */
  const { domainPriceOf, enforce, monthlyEquivalent } = await import('./lib/budget.mjs');
  const plan = { provider: provider.describe(), domain: o.domain, steps: [], cost: null, blockers: [] };
  const acct = await provider.account();
  plan.account = { balance: acct.balance, currency: acct.currency, warnings: acct.warnings ?? [] };
  log(`账号：${provider.label}   余额：${acct.balance ?? '取不到'} ${acct.currency ?? ''}`);
  for (const w of acct.warnings ?? []) log(`  ⚠ ${w}`);
  const domains = await provider.listDomains().catch(() => null);
  // 与 cmdCheck / up 同一个判据：看的是解析区（可注册的那一级），不是节点用的主机名
  const zoneName = resolveZone({ domain: o.domain, zone: o.zone });
  /*
    三态：读不到域名列表时**不猜**（旧实现 `.catch(() => [])` 会把"读不到"变成"不在账号里"，
    于是 plan 给出"要加 --buy"的建议，而 up 更会在这种情况下真的去买一个账号里已有的域名）。
    计划里的结论必须与 up 的执行判据同源：`null` ⇒ 记一条 blockers，说明"读数不可用、先重跑"。
  */
  const owned = domains === null ? null : domains.some((d) => d.name === zoneName);

  // ① 域名
  let domainTotal = 0;
  let domainYearly = 0;
  let domainSource = '账号里已有（0 元）';
  let domainCurrency = 'CNY';
  if (owned === null) {
    plan.blockers.push({
      kind: 'unavailable',
      why: [`读不到该账号的域名列表，无法判断 ${zoneName} 是否已经在账号里`],
      fix: '这通常只是那一次请求失败（限流/网络/权限）——重跑一次；读数恢复前不会给出"要不要买"的结论',
    });
  } else if (!owned) {
    if (!o.buy) {
      plan.blockers.push({ kind: 'invalid', why: [`${o.domain} 不在账号里，且没有 --buy`], fix: '加 --buy，或 --domain 换成已有的域名' });
    } else if ((acct.domainBlockers ?? []).length) {
      plan.blockers.push({ kind: 'account_not_ready', why: acct.domainBlockers, fix: '去控制台办完信息模板实名审核，或 --domain 换成已有的域名' });
    } else {
      // 询价币种跟着账号走（中国站=CNY、国际站=USD），报成别的币种时闸门会要求人自己换算
      const p = await provider.domainPrice({ domain: o.domain, years: o.years });
      plan.steps.push({ step: 'buy-domain', domain: zoneName, years: o.years, available: p.available, price: p });
      /*
        域名单价取哪个：判据在 `budget.domainPriceOf`（与 up 共用一处，2026-10-15 审计 F10）。
        旧实现是本文件自己判"服务商有价就照用"（哪怕币种是美元），把币种问题留给预算闸门——
        于是 plan 说"币种不对"、up 说"请用 --price-domain 给个元价"：同一件事两句话，
        用户先看 plan 再跑 up 会以为其中一个坏了。现在两边**同一句**，且都说清怎么修。
      */
      const choice = domainPriceOf({ price: p, priceDomain: o.priceDomain });
      if (choice.ok) {
        domainYearly = choice.yearly;
        domainTotal = choice.yearly * o.years;
        domainCurrency = choice.currency;
        domainSource = choice.source;
      } else {
        plan.blockers.push({ kind: 'invalid', why: [choice.reason], fix: '照上面那句话给一个元价（--price-domain <元/年>）' });
        domainYearly = 0;
        domainTotal = 0;
        domainCurrency = p.currency ?? null;
        domainSource = p.source;
      }
      if (!p.available) plan.blockers.push({ kind: 'invalid', why: [`${o.domain} 不可注册：${p.reason ?? '未说明'}`], fix: '换一个域名' });
    }
  } else {
    plan.steps.push({ step: 'reuse-domain', domain: o.domain });
  }

  // ② 机器
  const region = o.region || provider.defaultRegion;
  const image = await provider.resolveImage(region);
  let serverMonthly = null;
  // 这个价是谁给的（服务商实时询价 / 人填）：闸门要如实知道它判的是哪一种
  let serverPricedBy = 'provider';
  let serverCurrency = 'CNY';
  let serverSource = null;
  let instanceType = o.instanceType ?? null;
  const candidates = o.instanceType ? [o.instanceType] : provider.describe().instanceTypes;
  for (const t of candidates) {
    try {
      const pr = await provider.serverMonthlyPrice({ region, instanceType: t, imageId: image.id });
      serverMonthly = pr.monthly;
      serverCurrency = pr.currency ?? 'CNY';
      serverSource = pr.source;
      instanceType = t;
      break;
    } catch (e) {
      plan.steps.push({ step: 'instance-type-unavailable', instanceType: t, kind: e.kind, why: e.message.split('\n')[0] });
    }
  }
  if (serverMonthly == null && o.priceServer > 0) {
    serverMonthly = o.priceServer;
    serverPricedBy = 'user';
    serverCurrency = 'CNY';
    serverSource = `你给的价（--price-server ${o.priceServer}）`;
    instanceType = instanceType ?? candidates[0];
  }
  if (serverMonthly == null) {
    plan.blockers.push({
      kind: 'unavailable',
      why: ['没有可用的机型：都询价失败（AWS 没有按需询价接口，这是预期的）'],
      fix: '用 --price-server <元/月> 给出你接受的月价，并用 --instance-type 指定一个机型',
    });
  }
  plan.steps.push({ step: 'create-server', region, instanceType, image: image.id, imageName: image.name });

  plan.cost = {
    serverMonthly,
    serverCurrency: serverCurrency ?? 'CNY',
    serverSource,
    domainTotal,
    domainYearly,
    domainCurrency,
    domainSource,
    /*
      每月折合成本走**唯一实现** `budget.monthlyEquivalent`（2026-10-15 审计 F10）：
      这里原本把公式又抄了一遍（`serverMonthly + domainTotal / ((years||1)*12)`）——
      而闸门比较用的正是 budget 里那一份。两份公式一旦漂移，plan 打印的"折合 X 元/月"
      与闸门实际判的数就不是一回事（用户按打印值判断"还能不能再加点东西"）。
    */
    monthlyEquivalent: serverMonthly == null ? null : +monthlyEquivalent({ serverMonthly, domainTotal, domainYears: o.years }).toFixed(2),
  };

  const gate = enforce({
    maxMonthly: o.maxMonthly,
    maxDomainYear: o.maxDomainYear,
    cost: {
      // 没价就传 0：闸门会因此拒绝（"拿不到价就不许买"），而不是退化成"0 元 ≤ 额度"的假通过
      serverMonthly: serverMonthly ?? 0,
      serverPricedBy,
      serverCurrency: serverCurrency ?? 'CNY',
      domainTotal,
      domainYears: o.years || 1,
      domainYearly,
      domainCurrency,
      serverSource: serverSource ?? '',
      domainSource,
    },
  });
  plan.budget = o.maxMonthly > 0 ? gate : { ok: null, why: '未给 --max-monthly：up 会直接拒绝创建任何资源' };

  /*
    人看的版本在这里打印（--json 时 main 会把 log 接到 stderr，所以两条路都只有一份输出）。
    计划必须**能被人读懂**：这个命令的用途就是"先看看要花多少、会动什么"，只回一个 JSON 的话，
    真人和 AI 都得再去解析一遍才能做决定。
  */
  log('');
  log(`计划：${plan.steps.map((s) => s.step).join(' → ')}`);
  log(`  区域：${region}   机型：${instanceType ?? '（未知）'}   镜像：${image.name}`);
  log(`  成本：机器 ${serverMonthly ?? '?'} 元/月（${serverSource ?? '未知来源'}）` + (domainTotal ? ` + 域名 ${domainTotal} 元/${o.years} 年（${domainSource}）` : ' + 域名 ¥0（已在账号里）'));
  log(`        折合 ${plan.cost.monthlyEquivalent ?? '?'} 元/月 ≤ 授权 ${o.maxMonthly ?? '（未给）'} 元/月 ${plan.budget.ok === true ? '✓' : ''}`);
  if (plan.blockers.length) for (const b of plan.blockers) log(`  ✗ ${b.why.join('；')} —— ${b.fix}`);
  if (plan.budget.ok === false) log(`  ✗ ${plan.budget.why}`);
  if (plan.budget.ok !== false && !plan.blockers.length) log('\n把 plan 换成 up（参数照抄）就会真的下单。');
  return plan;
}

async function cmdVerify(o, log) {
  const st = loadState(REPO_ROOT, o.shop);
  if (!st) throw Object.assign(new Error(`没有状态文件（--shop ${o.shop}）：先跑 up`), { gate: true });
  if (!st.server?.publicIp || !st.domain) throw Object.assign(new Error(`状态文件不完整（缺 IP 或域名）—— 先跑 up`), { gate: true });
  const { probe, run } = await import('./lib/ssh.mjs');
  const host = st.server.publicIp;
  const user = st.ssh.user;
  const out = { shop: o.shop, host, domain: st.domain, local: null, publicHttps: null };
  const local = run({ keyPath: st.ssh.keyPath, user, host, command: 'curl -s -m 8 http://127.0.0.1:8090/healthz', check: false }).out;
  try {
    out.local = JSON.parse(local);
    log(`  机器本机 /healthz：code=${out.local.code}`);
  } catch {
    out.local = { error: local.slice(0, 300) };
    log(`  ⚠ 机器本机 /healthz 读不到：${out.local.error}`);
  }
  /*
    URL 主机名**永远**是 `--domain` 给的那个名字（节点的对外身份），与解析区无关：
    区与记录名只是"这个名字在 DNS 里怎么落"，两者相等与否都不改变要访问的主机名。
    旧实现写成 `st.dns?.zoneName ? (st.dns.zoneName === st.domain ? st.domain : st.domain) : st.domain`
    —— 两个分支一模一样，读起来像还有别的可能（2026-10-15 审计 F10）。
  */
  const hostname = st.domain;
  try {
    const r = await fetch(`https://${hostname}/healthz`, { signal: AbortSignal.timeout(10_000) });
    out.publicHttps = { status: r.status, body: await r.json() };
    log(`  公网 https://${hostname}/healthz：HTTP ${r.status} code=${out.publicHttps.body?.code}`);
  } catch (e) {
    out.publicHttps = { error: e.cause?.code ?? e.name ?? String(e) };
    log(`  ⚠ 公网 https 不通：${out.publicHttps.error}`);
  }
  const expected = st.verified?.healthz?.escrowAddress;
  if (expected && out.publicHttps?.body?.data?.escrowAddress && out.publicHttps.body.data.escrowAddress !== expected) {
    out.drift = { escrowAddress: { expected, got: out.publicHttps.body.data.escrowAddress } };
    log(`  ⚠ 合约地址与部署时不一致：${out.drift.escrowAddress.got} ≠ ${expected}`);
  }
  return out;
}

/* ── 主入口 ──────────────────────────────────────────────────────────────── */
async function main() {
  const argv = process.argv.slice(2);
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`[用法错] ${e.message}\n\n${usage()}`);
    return 2;
  }
  const cmd = o._[0];
  if (o.help || !cmd) {
    console.log(usage());
    return o.help ? 0 : 2;
  }
  if (!COMMANDS.includes(cmd)) {
    console.error(`[用法错] 未知命令：${cmd}\n\n${usage()}`);
    return 2;
  }
  const json = !!o.json;
  // --json 时把进度日志压到 stderr，stdout 只放结果（让 AI/脚本能直接 JSON.parse）
  const log = json ? (m) => process.stderr.write(`${m}\n`) : (m) => console.log(m);

  try {
    requireFor(cmd, o);
    let result;
    if (cmd === 'providers') result = await cmdProviders(o, log);
    else if (cmd === 'check') result = await cmdCheck(o, log);
    else if (cmd === 'plan') result = await cmdPlan(o, log);
    else if (cmd === 'up') result = await up({ provider: await buildProvider(o), options: o, repoRoot: REPO_ROOT, log });
    else if (cmd === 'verify') result = await cmdVerify(o, log);
    else if (cmd === 'destroy') result = await destroy({ options: o, repoRoot: REPO_ROOT, log });

    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result && typeof result === 'object') log('');

    // 计划里有 blocker ⇒ 与 up 一样属于"闸门拒绝"，用同一个退出码
    if (result?.blockers?.length) return 3;
    if (result?.budget && result.budget.ok === false) return 3;
    if (result?.gates?.length) return 3;
    return 0;
  } catch (e) {
    const usageErr = e?.usage === true;
    /*
      "闸门拒绝"（退出码 3）的判据是：**重跑同样的命令不会变好**，得先去改点东西
      （充值、办实名、补权限、换一把 key、给额度）。
      这不是分类学洁癖 —— 上层脚本/AI 就靠这个码决定"该原样重试还是该停下来问人"。
      所以 AUTH 也算闸门：密钥不对时反复重试是最没意义的动作。
    */
    const gate =
      e?.gate === true ||
      [KIND.INVALID, KIND.ACCOUNT_NOT_READY, KIND.FORBIDDEN, KIND.INSUFFICIENT_BALANCE, KIND.AUTH].includes(e?.kind);
    /*
      凭据缺失时，错误信息**本身就是那份"怎么拿 key"的说明书**。
      这时不能再补一句泛泛的"密钥无效或已过期" —— 那两句会互相打架：
      用户明明还没配 key，却被叫去检查 key 是不是抄漏了。
    */
    const noCreds = /缺少 .*的凭据/.test(e?.message ?? '');
    /*
      "本地决定停下"这一类（同名机器、认领参数不对、续跑参数漂移、预算被拦）**不是云服务商的错**，
      它们的错误信息里已经写清该怎么办。这时再补一句 `ADVICE[INVALID]`（"请求被服务商拒绝…按它调整参数"）
      就是答非所问 —— 用户会去翻云控制台的配额，而问题其实在他自己的命令行上。
      判据：这条错误是不是适配器发请求时产生的（`CloudError` 带 action/code）。
    */
    const localDecision = e instanceof CloudError && !e.action && !e.code;
    process.stderr.write(`\n[失败] ${e?.message ?? describe(e)}\n`);
    if (noCreds) {
      if (!/怎么拿/.test(e.message)) process.stderr.write(`        处理：${ADVICE[KIND.AUTH]}\n`);
    } else if (!localDecision) {
      if (e instanceof CloudError && ADVICE[e.kind]) process.stderr.write(`        处理：${ADVICE[e.kind]}\n`);
      if (e?.raw) process.stderr.write(`        原始响应：${JSON.stringify(e.raw).slice(0, 500)}\n`);
    }
    return usageErr ? 2 : gate ? 3 : 1;
  }
}

// JSON 输出里可能含未转义的 BigInt（云 API 偶尔给），统一兜住，别让"结果打印"这一步把整个流程判失败
BigInt.prototype.toJSON = function toJSON() {
  return this.toString();
};

/*
  直接 `node provision/cli.mjs …` 时自己跑；被测试 import 时不跑。
  判据用 `import.meta.url === pathToFileURL(argv[1])` —— 这是 Node 里唯一稳的"我是不是入口"判法。
  别用 `argv[2]`（那要看 node 怎么切参数，跨平台/跨形态不一致，实测会漏），也别用 realpathSync(argv[1])
  （在 `node -e` 下 argv[1] 是个不存在的路径，会直接抛 ENOENT）。
*/
let isEntry = false;
try {
  isEntry = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
} catch {
  isEntry = false;
}
if (isEntry) {
  // 用 exitCode 而不是 process.exit()：后者会**截断还没 flush 的 stdout**
  // （Windows 上管道输出尤其明显：脚本明明跑完了，终端上一片空白）
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main, parseArgs, usage, FLAGS, requireFor };
