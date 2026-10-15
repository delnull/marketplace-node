/**
 * 编排：**一条流程从 API key 走到"买家能打开你的店"**。
 *
 * 每一步的形状都是同一套：先问服务商"现状是什么" → 判断这一步要不要做 → 做 → 把结果写进状态。
 * 为什么要这么绕：这个流程里全是**花钱且不可撤销**的动作，而现实里它一定会被打断
 * （SSH 断、证书签发慢、用户 CTRL-C）。所以每一步都必须能从状态文件续跑，
 * 而不是"重跑就再买一台机器"。
 *
 * 花钱的两处（createServer / buyDomain）都先过 `enforce()`（唯一预算判据），
 * 取不到实时价就**停下来要人给价**，绝不猜。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CloudError } from './errors.mjs';
import { CNY, domainPriceOf, enforce, monthlyEquivalent } from './budget.mjs';
import { canBuyDomain } from './provider.mjs';
import { generateSshKey, probe, run, runScript, shellQuote, upload } from './ssh.mjs';
import { loadState, newState, saveState, stateDir } from './state.mjs';
import { recordName, resolveZone } from './zone.mjs';
import { decideServer, describeResume } from './resume.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 日志接口由 CLI 注入：编排层不直接 printf（测试里要能拿到完整决策序列） */
const defaultLog = (m) => console.log(m);

/**
 * @param {object} o
 * @param {object} o.provider   适配器实例
 * @param {object} o.options    CLI 参数（见 cli.mjs）
 * @param {string} o.repoRoot   仓库根（用于 git archive node/ 与写状态）
 * @param {(m:string)=>void} [o.log]
 * @param {object} [o.io]      外部世界注入点（测试用）：{ generateSshKey, probe, run, runScript, upload }。
 *                             默认就是真的那一套 —— 这条流程要连一台**刚买回来的机器**，
 *                             没有注入点就没法在 CI 里验编排（而编排恰恰是最容易写错的部分）。
 */
export async function up({ provider, options: o, repoRoot, log = defaultLog, io = {}, wait = {} }) {
  const {
    generateSshKey: genKey = generateSshKey,
    probe: sshProbe = probe,
    run: sshRun = run,
    runScript: sshRunScript = runScript,
    upload: sshUpload = upload,
  } = io;
  /**
   * "等"的节拍。默认值是给真实云的（机器要几分钟、解析要几分钟、证书要几分钟）。
   * 测试里全部调成 0 或极短：**等待的时长不是被验证的对象，"等的是哪一个外部事实"才是**。
   * 所以这里把节拍抽出来，而不是让测试真的等 5 分钟 DNS。
   */
  const {
    pollMs = 10_000,
    sshPollMs = 8_000,
    dnsPollMs = 5_000,
    httpsPollMs = 10_000,
    domainTaskPollMs = 15_000,
    timeoutMs = { server: 8 * 60_000, ssh: 6 * 60_000, dns: 5 * 60_000, https: 6 * 60_000 },
    resolve4 = defaultResolve4,
  } = wait;
  const t0 = Date.now();
  const shop = o.shop;
  /*
    `--dry-run` 的**唯一出口**：还没有读过状态、更没有发过任何请求。
    原来这个出口在"机器"那一段里，于是"域名不在账号里 + --buy"会**先真的把域名买下来**
    （注册商那边钱已扣），再打印"没有创建任何资源"。承诺与实际相反，且那笔钱不可撤销。
    判据只能有一条：dry-run 在**任何可能花钱的动作之前**就结束 —— 所以它必须在函数开头，
    而不是在某个分支里。
  */
  if (o.dryRun) {
    log('--dry-run：只做只读检查，不创建、不修改任何东西（要看价格与闸门结论请用 provision plan）');
    return {
      dryRun: true,
      // 说清"到此为止做了什么、验证了什么"，而不是只说一句"没有创建"
      why: '只做了只读检查。价格与预算闸门的结论在 `provision plan` 里 —— 那条命令专管"先看花多少"，本命令专管"绝不写任何东西"（两件事分开，才不用在一条命令里同时兼顾"算准"与"不动手"）。',
      checks: ['账号可读（余额/权限）', '域名可注册性与报价', '机型询价与可用性', '预算闸门'],
      would: [
        ...(o.buy ? [`注册域名 ${o.domain ?? '(未给)'}（不可撤销的一次性支出）`] : []),
        '创建机器（按小时计费）',
        '建解析记录、装节点、申请证书',
      ],
      note: o.buy ? '注意：--dry-run 不会真的注册域名 —— 真要买就去掉 --dry-run 重跑。' : undefined,
    };
  }
  let st = loadState(repoRoot, shop);
  if (!st) {
    st = newState({
      shop,
      provider: provider.id,
      providerLabel: provider.label,
      region: o.region || provider.defaultRegion,
      domain: o.domain || null,
      endpoint: o.domain ? `https://${o.domain}` : null,
      owner: o.owner,
    });
  }
  const checkpoint = (patch) => {
    Object.assign(st, patch);
    saveState(repoRoot, shop, st);
  };

  /*
    开头先把"这次是从哪继续的"讲清楚。
    断了之后重跑的人最需要知道的就是"哪些已经做完了" —— 不讲的话他会怀疑是不是又要买一遍，
    于是可能去控制台手动删东西（那是更糟的结果）。
  */
  log(`续跑检查（店铺 ${shop}）：`);
  for (const line of describeResume(st)) log(`   ${line}`);
  log('');

  /* ── ① 账号：余额 + 权限 + 已有的机器/域名 ─────────────────────────────── */
  log(`① 检查账号（${provider.label}）`);
  // AWS 注册域名要完整联系人：在**花钱之前**把参数补齐，缺了就别走到下单那一步
  if (o.buy && o.contactFirstName) {
    for (const k of ['contactLastName', 'contactPhone', 'contactAddress', 'contactCity', 'contactCountry', 'contactZip']) {
      if (!o[k]) throw new CloudError('invalid', `给了 --contact-first-name 就必须把联系人补全，缺 --${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`);
    }
    o.contact = { firstName: o.contactFirstName, lastName: o.contactLastName, phone: o.contactPhone, address: o.contactAddress, city: o.contactCity, country: o.contactCountry, zip: o.contactZip, email: o.email };
  }
  const acct = await provider.account();
  if (acct.balance != null) {
    log(`   余额：${acct.balance} ${acct.currency ?? ''}${acct.owed ? `（欠费 ${acct.owed}）` : ''}`);
    if (acct.balance <= 0 && !o.allowZeroBalance) {
      throw new CloudError('insufficient_balance', `账号余额为 ${acct.balance} ${acct.currency ?? ''}：先充值再跑（或加 --allow-zero-balance 表示你清楚余额为 0/走的是后付费）`);
    }
  } else {
    log(`   ⚠ 余额取不到：${acct.warnings?.join('; ') ?? '未说明'}`);
  }
  for (const w of acct.warnings ?? []) log(`   ⚠ ${w}`);

  const existingServers = await provider.listServers(o.region || provider.defaultRegion);
  /*
    ── "账号里有没有这个域名"必须**三态**，不能把"没读到"当成"没有" ──────────────
    旧实现在这里 `.catch(() => [])`（同形状还在 cli.mjs 的两处），于是 `QueryDomainList`
    这一次失败（403/限流/网络）时：列表变成空 ⇒ 判成"账号里没有这个域名" ⇒ 若用户带了 `--buy`
    **就真的去下单买一个他账号里已经有的域名**（授权额度内的错额支出，而且买回来是第二个同名区）。
    三态：数组 = 读到了（可能为空）；`null` = 读不到。
      读不到时：**不许买**（宁可停下让人重跑），也不许说"这个域名不在账号里"。
  */
  const existingDomains = await provider.listDomains().catch(() => null);
  log(`   已有服务器（${o.region || provider.defaultRegion}）：${existingServers.length} 台${existingServers.length ? ` —— ${existingServers.map((s) => `${s.name || s.id}(${s.status})`).join(', ')}` : ''}`);
  log(
    existingDomains === null
      ? '   已有域名：读不到（服务商域名列表接口失败）——本工具不会替你判断"账号里有没有这个域名"，也不会替你买'
      : `   已有域名：${existingDomains.length} 个${existingDomains.length ? ` —— ${existingDomains.slice(0, 8).map((d) => d.name).join(', ')}${existingDomains.length > 8 ? ' …' : ''}` : ''}`
  );
  /*
    "这次要不要再开一台机器"由 resume.mjs **一处**判定
    （续跑 / 认领 / 同名停下 / 列出别的机器问一句 / 新开）。
    放在这里而不是塞进下面的 ③，是因为它同时决定"要不要花钱"，而花钱的判断只该有一个出处。
    传进去的 probe 是"我们的密钥能不能登进这台机器"：云端没有"给已有实例补一把公钥"的接口，
    所以能不能接手只能靠试 —— 试的结果会直接标在清单上，用户照着填 ID 之前就能看到。
  */
  const decision = await decideServer({
    o,
    existing: existingServers,
    st,
    serverName: o.serverName,
    probe: (s) => sshProbe({ keyPath: path.join(stateDir(repoRoot), 'ssh', `${shop}.key`), user: o.sshUser, host: s.publicIp }),
    log,
  });
  log(`   机器决策：${decision.why}`);

  /* ── ② 域名：已有就用，没有就买（买之前必须过两道预算闸）────────────── */
  if (!o.domain) {
    throw new CloudError('invalid', '缺少域名：用 --domain shop.example.com 指定（要买就加 --buy）');
  }
  /*
    解析区在**这一步**就定下来（而不是等到第 ④ 步再算）：它决定"要买哪一个域名"
    —— zone 才是可注册的那一级。若放到第 ④ 步才算，一个推导不出来的域名会先在"买域名"
    那一步报出别的错（"不在账号里、要加 --buy"），把真原因盖掉。
  */
  const zoneName = resolveZone({ domain: o.domain, zone: o.zone });
  /*
    读不到域名列表时**必须停下**（而不是猜"没有"）：猜错的两个方向都要花钱或骗人——
    「其实有、判成没有」⇒ 带 --buy 就重复买一个已在账号里的域名；
    「其实没有、判成有」⇒ 跳过购买、后面建 A 记录时才发现区不存在。
    这一条挡在预算闸之前，所以它拦下时**一分钱都还没花**。
  */
  if (existingDomains === null && !st.domainPurchase) {
    throw new CloudError(
      'unavailable',
      `读不到该账号的域名列表，无法判断 ${zoneName} 是否已经在账号里。\n` +
        '        本工具不猜：这可能只是刚才那次请求失败（限流/网络/权限），重跑一次通常就好；\n' +
        '        要跳过这个判断、直接用你手上已有的域名，请等接口恢复后重跑（--buy 在读数恢复前一律不执行）。'
    );
  }
  const domainOwned = (existingDomains ?? []).some((d) => d.name === zoneName) || !!st.domainPurchase;
  // priceCny 是**闸门口径**（元）；priceNative/currencyNative 只是把服务商的原报价留档备查 —— 两者不能混用
    let purchase = st.domainPurchase ?? { bought: false, years: o.years, priceCny: 0, priceNative: null, currencyNative: null, ownedBefore: domainOwned };
  if (!domainOwned) {
    if (!o.buy) {
      throw new CloudError(
        'invalid',
        // 说的是 **zoneName**（可注册的那一级），不是 o.domain：域名注册商只卖 zone，
        // 而节点名通常挂在子域上 —— 说成"--domain 不在账号里"会让人去买一个买不到的名字。
        `域名 ${zoneName} 不在这个账号的域名列表里${zoneName === o.domain ? '' : `（${o.domain} 挂在它下面，注册商只卖 ${zoneName} 这一级）`}。\n` +
          '        要买就加 --buy（会走预算闸门）；或者把域名先转到/注册到这个账号，或改用 --domain <账号里已有的域名>。'
      );
    }
    if (!canBuyDomain(provider)) {
      throw new CloudError('invalid', `${provider.label} 这家适配器没有域名注册能力，买不了 ${zoneName}`);
    }
    // 账号级前置（实名模板等）：**在花钱之前**问清楚，而不是等下单失败
    if (acct.domainBlockers?.length) {
      throw new CloudError('account_not_ready', `这个账号现在买不了域名：\n        - ${acct.domainBlockers.join('\n        - ')}`, { provider: provider.id });
    }
    log(`② 域名 ${zoneName} 不在账号里 → 准备注册${zoneName === o.domain ? '' : `（节点用 ${o.domain}）`}`);
    const price = await provider.domainPrice({ domain: zoneName, years: o.years });
    /*
      价格与币种必须**成对**地看：
        · 服务商按元报价 → 直接用它的价；
        · 服务商按别的币种报价（阿里云国际站的 CheckDomain 固定按 USD）→ **只能**用人给的 --price-domain（元）。
      两条判据绑在一起，就不会出现"币种还是 USD 但金额已经换成人给的元价"这种自相矛盾的状态
      （那会让闸门一边说币种不对、一边拿元价去比，谁都看不懂自己在比什么）。
    */
    /*
      ── 域名单价取哪一个：判据在 `budget.domainPriceOf`（plan 与 up 共用一处）────────
      旧实现是本文件自己拼的 `!(price.yearly > 0) || !pricedInYuan`，而 plan 里另有一份
      形状不同的判据（服务商有价就照用，把币种问题留给闸门）——同一件事两句话，
      用户先看 plan 再跑 up 会以为其中一个坏了（2026-10-15 审计 F10）。
    */
    const choice = domainPriceOf({ price, priceDomain: o.priceDomain });
    if (!choice.ok) throw new CloudError('invalid', choice.reason);
    const yearly = choice.yearly;
    const total = yearly * o.years;
    const currency = choice.currency;
    const priceSource = choice.source;
    log(`   可注册：${price.available ? '是' : `否（${price.reason ?? '未说明'}）`}   ${yearly} ${currency}/年   来源：${priceSource}`);
    if (!price.available) {
      throw new CloudError('invalid', `${o.domain} 现在注册不了：${price.reason ?? '服务商未说明原因'}（换一个名字，或 --domain 用已有的域名）`);
    }
    const gate = enforce({
      maxMonthly: o.maxMonthly,
      maxDomainYear: o.maxDomainYear,
      scope: 'domain-only', // 这一步只授权域名：机器还没询价，也不该在这里被考核
      cost: {
        serverMonthly: 0,
        domainTotal: total,
        domainYears: o.years,
        domainYearly: yearly,
        domainCurrency: currency,
        serverSource: '（本步不涉及）',
        domainSource: priceSource,
      },
    });
    if (!gate.ok) throw new CloudError('invalid', `域名这步被预算闸门拦下：\n        ${gate.why}`);
    /*
      ── 模板读数缺失时要说出来（2026-10-15 审计 F7）────────────────────────────
      `acct.domainTemplates` 缺席有两种成因：**账号本来就用不着模板**（AWS 走联系人字段），
      以及**那一次读取失败**（适配器读不到列表时会置 `domainTemplates: undefined` 并在
      `warnings` 里说明，见 providers/aliyun.mjs）。旧实现 `?? []` 把两者都说成"无可用模板"，
      而"无可用模板"读起来像一个**结论**（这个账号买不了域名）——用户于是去控制台白折腾一遍。
      判据：缺席时**不替它下结论**，只说"这次没读到"；真正的拦截仍由适配器给的
      `domainBlockers` 负责（那是唯一判据，本文件不重判）。
    */
    const tpls = acct.domainTemplates;
    const tplOk = (tpls ?? []).find((t) => /^(SUCCEED|Approved)$/.test(t.status) && t.valid !== false);
    log(
      `   信息模板：${
        tplOk ? `${tplOk.id}（${tplOk.status}）` : tpls === undefined ? '这次没读到（服务商要求实名模板时，下单会带原始错误码）' : '无可用模板'
      }`
    );
    const bought = await provider.buyDomain({ domain: o.domain, years: o.years, templateId: tplOk?.id, contact: o.contact });
    purchase = { bought: true, years: o.years, priceCny: total, priceNative: price.total, currencyNative: price.currency, taskId: bought.taskId, ownedBefore: false, at: new Date().toISOString() };
    checkpoint({ domain: o.domain, endpoint: `https://${o.domain}`, domainPurchase: purchase });
    log(`   已提交注册任务${bought.taskId ? `（taskId=${bought.taskId}）` : ''} —— 支付 ≠ 注册成功，注册局审核可能要 1~3 个工作日`);
    if (provider.domainTask && bought.taskId) {
      /*
        ── "读不到任务状态" ≠ "任务结束"（2026-10-15 审计 F7）────────────────────────
        旧实现 `.catch(() => null)` 之后 `if (!t) break;`：一次读失败就**静默跳出轮询**，
        而上面刚打印过「已提交注册任务」——用户看到的是"流程走完了"，
        真相是"状态一次都没读到"。钱已经花了（下单已提交），所以这里不改流程，
        只把"读不到"与"读到了终态"分开：读失败就记一笔、继续看下一次，
        整轮都没读到就在最后**明说一次**（附 taskId，告诉用户复查哪一条命令，且不会重复下单）。
      */
      let last = null;
      for (let i = 0; i < 10; i++) {
        let t = null;
        try {
          t = await provider.domainTask({ taskId: bought.taskId, domain: o.domain });
        } catch (e) {
          log(`   ⚠ 注册任务状态这次没读到（${e?.message || e}）——这不代表任务失败，继续看下一次`);
        }
        if (t) {
          last = t;
          log(`   注册任务状态：${t.status}${t.error ? `（${t.error}）` : ''}`);
          if (/SUCCESS/i.test(t.status)) break;
          if (/FAILURE|FAIL/i.test(t.status)) throw new CloudError('invalid', `域名注册任务失败：${t.error ?? '服务商未给出原因'}`);
        }
        await sleep(15_000);
      }
      if (!last) {
        log(
          `   ⚠ 注册任务状态始终没读到（taskId=${bought.taskId}）：任务已提交、仍在注册局那边排队，` +
            '但本工具**无法确认**它成功——请稍后用它复查（同一命令不会重复下单）'
        );
      }
    }
  } else {
    log(`② 域名 ${o.domain} 已在账号里（不花钱注册）`);
    checkpoint({ domain: o.domain, endpoint: `https://${o.domain}`, domainPurchase: purchase });
  }

  /* ── ③ 机器：先定价 → 过闸 → 才下单 ───────────────────────────────────── */
  const region = o.region || st.region || provider.defaultRegion;
  if (decision.action === 'adopt') {
    // 认领：把已有机器写进状态，然后走与续跑**完全同一条路**（不重新下单、不新建安全组/密钥）
    log(`③ 认领已有机器（${decision.server.id} / ${decision.server.publicIp}）`);
    const { keyPath, publicKey } = genKey(path.join(stateDir(repoRoot), 'ssh', `${shop}.key`), { type: o.sshKeyType });
    checkpoint({
      region,
      domain: o.domain,
      endpoint: `https://${o.domain}`,
      server: decision.server,
      // 认领时机器上**可能已经有** `authorized_keys`（上一次装到一半）：把我们的公钥补上去，
      // 否则后面的 SSH 会因为"密钥对不匹配"而失败，看起来像"认证问题"
      ssh: { keyPath, keyId: null, user: o.sshUser },
    });
    await ensureOurKeyAt({ keyPath, user: o.sshUser, host: decision.server.publicIp, log, probeFn: sshProbe });
  } else if (!st.server) {
    log(`③ 机器（${provider.label} / ${region}）`);
    const image = await provider.resolveImage(region);
    log(`   镜像：${image.name}`);
    let picked = null;
    const tried = [];
    for (const type of o.instanceType ? [o.instanceType] : provider.describe().instanceTypes) {
      try {
        const price = await provider.serverMonthlyPrice({ region, instanceType: type, imageId: image.id });
        picked = { type, price };
        break;
      } catch (e) {
        tried.push(`${type}: ${e.kind}`);
        log(`   ⚠ 机型 ${type} 不可用（${e.kind}）：${e.message.split('\n')[0].slice(0, 160)}`);
        if (o.instanceType) break; // 用户点名要的机型不可用就别继续试别的
      }
    }
    // 服务商没有询价接口时（AWS），由用户显式给价 —— 闸门仍然成立，只是判据来自人
    if (!picked && o.priceServer > 0) {
      picked = {
        type: o.instanceType ?? provider.describe().instanceTypes[0],
        price: { monthly: o.priceServer, currency: 'CNY', pricedBy: 'user', source: `你给的价（--price-server ${o.priceServer}）` },
      };
    }
    if (!picked) {
      throw new CloudError('invalid', `没有可用的机型（试过：${tried.join('；')}）。用 --instance-type <机型> 指定一个该区域有货的，并加 --price-server <元/月> 给出月价。`);
    }
    log(`   机型：${picked.type}   约 ${picked.price.monthly} ${picked.price.currency}/月（来源：${picked.price.source}）`);

    const gate = enforce({
      maxMonthly: o.maxMonthly,
      maxDomainYear: o.maxDomainYear,
      cost: {
        serverMonthly: picked.price.monthly,
        serverPricedBy: picked.price.pricedBy ?? 'provider',
        serverCurrency: picked.price.currency,
        domainTotal: purchase.bought ? purchase.priceCny ?? 0 : 0,
        domainYears: purchase.years ?? 1,
        domainYearly: purchase.bought ? (purchase.priceCny ?? 0) / (purchase.years || 1) : 0,
        domainCurrency: 'CNY', // 上面那个数已经是元（priceCny），币种不能再从服务商那边带过来
        serverSource: picked.price.source,
        domainSource: purchase.bought ? '本次已注册的域名' : '域名已在账号里（0 元）',
      },
    });
    if (!gate.ok) throw new CloudError('invalid', `机器这步被预算闸门拦下：\n        ${gate.why}`);
    log(`   预算闸门：折合 ${gate.monthly.toFixed(2)} 元/月 ≤ 授权 ${o.maxMonthly} 元/月 ✓`);

    /*
      dry-run 在函数开头就返回了，这里**不该**再有一条出口。
      留着它等于把"承诺不花钱"这条判据挂在两个地方，而其中一个（原来这个）晚于买域名
      ⇒ 用户的钱已经花掉，屏幕上却写着"没有创建任何资源"。所以这里只做断言，不做分支。
    */
    if (o.dryRun) throw new Error('内部错误：dry-run 的出口必须只有函数开头那一个（否则会先花钱再报"没花钱"）');

    const { keyPath, publicKey } = genKey(path.join(stateDir(repoRoot), 'ssh', `${shop}.key`), { type: o.sshKeyType });
    checkpoint({ ssh: { keyPath, keyId: null, user: o.sshUser } });

    const sg = await provider.ensureSecurityGroup({ region, name: o.serverName });
    log(`   安全组：${sg.id}（放行 22/80/443）`);
    const created = await provider.createServer({
      region,
      name: o.serverName,
      instanceType: picked.type,
      sshPublicKey: publicKey,
      securityGroupId: sg.id,
      imageId: image.id,
      userData: o.userData ?? undefined,
    });
    checkpoint({ server: { id: created.id, name: o.serverName, region, instanceType: picked.type, imageId: image.id, publicIp: null, keyId: created.keyId ?? null, createdAt: new Date().toISOString() }, ssh: { ...st.ssh, keyId: created.keyId ?? null } });
    log(`   已下单：${created.id}（按量付费；用 provision destroy --shop ${shop} 释放）`);

    log('   等待机器进入 running 并拿到公网 IP …');
    const ip = await waitForPublicIp(provider, region, created.id, log, { timeoutMs: timeoutMs.server, pollMs });
    checkpoint({ server: { ...st.server, publicIp: ip } });
    log(`   公网 IP：${ip}`);
  } else {
    log(`③ 机器已有（${st.server.id} / ${st.server.publicIp ?? 'IP 待查'}）—— 复用，不再下单`);
  }

  const host = st.server.publicIp;
  const keyPath = st.ssh.keyPath;
  const user = o.sshUser;

  /* ── ④ 解析：把域名指到这台机器，然后**真的去问权威 NS** ──────────────── */
  log('④ DNS 解析');
  // zone 是"在哪建解析区"（注册域名本身，如 example.com），hostname 是"买家访问的名字"（如 shop.example.com）。
  // 两者刻意分开：买域名只能买可注册的那一级，而节点通常挂在子域上；混为一谈会出现"去买 shop.example.com"这种下单。
  // zoneName 在第 ② 步就定下来了（它同时决定"买哪个域名"），这里只是使用它，不再推导一遍
  const rr = recordName({ domain: o.domain, zone: zoneName });
  const hostname = zoneName === o.domain ? o.domain : `${rr}.${zoneName}`;
  const zone = await provider.ensureZone({ domain: zoneName });
  const record = await provider.upsertARecord({ zoneName: zone.name, rr, value: host });
  log(`   解析：${hostname} → ${host}（${record.changed ? '已更新' : '本来就是'}）  区：${zone.name}`);
  if (zone.nameservers?.length) log(`   该 DNS 区的 NS：${zone.nameservers.join(', ')}`);
  checkpoint({ dns: { zoneId: zone.id, zoneName: zone.name, nameservers: zone.nameservers ?? [], recordId: record.id } });

  await waitForDns(hostname, host, log, { timeoutMs: timeoutMs.dns, pollMs: dnsPollMs, resolve4 });

  /* ── ⑤ 部署节点 ───────────────────────────────────────────────────────── */
  log('⑤ 部署店铺节点（上传提交内容 → 服务器上跑店主脚本 deploy.sh）');
  const tarball = packNode(repoRoot, o.rev, log);
  await waitForSsh({ keyPath, user, host }, log, sshProbe, { timeoutMs: timeoutMs.ssh, pollMs: sshPollMs });
  sshUpload({ keyPath, user, host, local: tarball, remote: '/tmp/mk-node.tgz' });

  const deployLog = [];
  const remote = deployNodeScript({ host, owner: o.owner, domain: hostname, email: o.email, installDir: o.installDir });
  const res = sshRunScript({
    keyPath,
    user,
    host,
    script: remote,
    check: false,
    onLine: (line) => {
      deployLog.push(line);
      log(`   │ ${line}`);
    },
  });
  if (res.status !== 0) {
    /*
      失败路径**也要落盘日志**（2026-10-15 审计 F5.1）：旧实现的这句话指着
      `<state>/<shop>.deploy.log`，而写那个文件在下面（成功才走到）—— 于是部署失败时
      用户被告知去读一个**并不存在**的文件，真现场（远端输出）反而只留在终端回滚区里。
      现在失败时先落盘再报错，并且由脚本自己保证"日志文件确实存在"这件事。
    */
    fs.mkdirSync(stateDir(repoRoot), { recursive: true });
    const failLog = path.join(stateDir(repoRoot), `${shop}.deploy.log`);
    fs.writeFileSync(failLog, deployLog.join('\n'), { mode: 0o600 });
    throw new CloudError(
      'unavailable',
      `节点部署失败（远端 exit=${res.status}）—— 从头重跑同一条命令即可续上（机器与域名不会重复购买）。完整日志见 ${failLog}`
    );
  }
  fs.mkdirSync(stateDir(repoRoot), { recursive: true });
  fs.writeFileSync(path.join(stateDir(repoRoot), `${shop}.deploy.log`), deployLog.join('\n'), { mode: 0o600 });
  checkpoint({
    node: { runtime: 'docker', installDir: o.installDir, container: 'marketplace-node', volume: 'marketplace-node-data', tlsMode: 'caddy', deployedRev: o.rev, package: path.basename(tarball) },
  });

  /* ── ⑥ 验收：从公网看，而不是从机器上自己看自己 ───────────────────────── */
  log('⑥ 验收（从本机走公网 DNS + HTTPS）');
  const verification = await verifyFromOutside({ hostname, user, host, keyPath, log, sshRun, timeoutMs: timeoutMs.https, pollMs: httpsPollMs });
  checkpoint({ verified: { at: new Date().toISOString(), ...verification } });

  log('');
  log(`完成，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  log(`  节点对外地址：https://${hostname}`);
  log(`  健康检查：    https://${hostname}/healthz`);
  log(`  机器：        ${st.server.id}（${host}，${region}）`);
  log(`  数据卷：      marketplace-node-data（在这台机器的 Docker 卷里，容器删了重建数据也在）`);
  log('');
  log('  还差一步（刻意不自动做）：链上登记。');
  log('    买家要能发现这家店，必须由**店主钱包**在前端签名登记 endpoint；');
  log('    本流程不接管店主私钥，所以这一步留给你：');
  log(`      https://fedmall.bityuan.com →「开店/登记我的节点」→ 填 https://${hostname} → 钱包签名`);
  return { ok: true, endpoint: `https://${hostname}`, host, ...verification };
}

/**
 * 认领一台已有机器之后，先解决"我们连得上吗"。
 *
 * 认领这条路的使用场景是"机器开出来了，但状态没写成"——那时机器上可能已经有我们的公钥
 * （开机注入成功了），也可能什么都没有（上一个进程死在建密钥之前）；机器也可能刚创建、
 * sshd 还没起来。所以这里**等一小段**（复用正式那套等待，超时值调短），
 * 连不上就停下来说清三种可能，而不是让它变成"等了 6 分钟然后报一句连不上"——那既慢又没法定位。
 */
async function ensureOurKeyAt({ keyPath, user, host, log, probeFn, timeoutMs = 90_000, pollMs = 5_000 }) {
  try {
    await waitForSsh({ keyPath, user, host }, log, probeFn, { timeoutMs, pollMs });
    return true;
  } catch {
    throw new CloudError(
      'invalid',
      `认领的机器 ${host} 用我们这把新密钥连不上（${user}@${host}:22）。三种常见原因：\n` +
        '        · 机器刚创建、sshd 还没起来 ⇒ 等一分钟重跑同一条命令\n' +
        '        · 这台机器创建时用的**不是**这把密钥（云端没有"补一把公钥到已有实例"的接口）\n' +
        '          ⇒ 若你手上还有它当初的密钥：ssh -i <那把> ' + `${user}@${host}` + ' 进去手工部署；\n' +
        '          ⇒ 或者放掉它重新开一台：node provision/cli.mjs destroy --shop <shop>（数据导不出时会拒绝，见它的提示）\n' +
        '        · 安全组没放行 22 ⇒ 控制台放行后重跑同一条命令（会从状态文件续上）',
      { provider: 'unknown' }
    );
  }
}

/* ── 下面都是"等"：每一条都等的是一个**外部事实**，不是固定时长 ────────────── */

/** 系统解析器（默认实现）。抽成函数是为了测试能注入一个"立刻返回正确 IP"的解析器 */
async function defaultResolve4(hostname) {
  const { Resolver } = await import('node:dns/promises');
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  return resolver.resolve4(hostname);
}

async function waitForPublicIp(provider, region, id, log, { timeoutMs = 8 * 60_000, pollMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const s = await provider.serverPublicIp({ region, id });
    if (s.publicIp && /running/i.test(s.status ?? '')) return s.publicIp;
    if (/failed|error|terminated/i.test(s.status ?? '')) {
      throw new CloudError('invalid', `机器进入 ${s.status} 状态 —— 去控制台看创建失败原因（常见：该可用区无货、配额不足）`, { provider: provider.id });
    }
    if (s.status !== last) {
      log(`   …机器状态：${s.status}${s.publicIp ? `  公网 IP：${s.publicIp}` : ''}`);
      last = s.status;
    }
    await sleep(pollMs);
  }
  throw new CloudError('unavailable', `等了 ${timeoutMs / 60000} 分钟机器还没 running —— 去控制台看这台 ${id} 的状态（脚本会从状态文件续跑，不会重复下单）`);
}

async function waitForSsh({ keyPath, user, host }, log, probeFn, { timeoutMs = 6 * 60_000, pollMs = 8_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < deadline) {
    if (probeFn({ keyPath, user, host })) {
      log(`   SSH 已就绪（${user}@${host}）`);
      return;
    }
    if (n++ % 3 === 0) log(`   …等待 sshd（云控制台显示 running ≠ sshd 已就绪）`);
    await sleep(pollMs);
  }
  throw new CloudError('unavailable', `等了 ${timeoutMs / 60000} 分钟还连不上 ${user}@${host}:22 —— 检查安全组是否放行 22（本工具会自己建/改安全组，若你用的是已有安全组请手动放行）`);
}

/**
 * 等权威 NS 真的返回这条 A 记录。
 * 为什么必须等：Caddy 申请 Let's Encrypt 证书时，ACME 服务器会去查这个域名的权威 NS；
 * 解析没生效就去申请，失败次数多了会被**限流**（同一域名一周内失败次数有上限），
 * 那是一种要等一整周才能恢复的失败 —— 所以这里宁可多等几分钟。
 */
async function waitForDns(hostname, expectIp, log, { timeoutMs = 5 * 60_000, pollMs = 5_000, resolve4 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const addrs = await resolve4(hostname);
      if (addrs.includes(expectIp)) {
        log(`   解析已生效：${hostname} → ${addrs.join(', ')}`);
        return true;
      }
      last = addrs.join(', ');
    } catch (e) {
      last = e.code ?? e.message;
    }
    await sleep(pollMs);
  }
  // 超时不判失败：权威 NS 已写入，只是还没传播到本机解析器时，Caddy 那边通常已经能签下证书
  log(`   ⚠ 本机还解析不到 ${hostname}（当前：${last}）—— 继续部署；验收阶段会从公网再确认一次`);
  return false;
}

async function verifyFromOutside({ hostname, user, host, keyPath, log, sshRun, timeoutMs = 6 * 60_000, pollMs = 10_000, fetchImpl = globalThis.fetch }) {
  const deadline = Date.now() + timeoutMs;
  // 验收地址默认就是买家会打开的那个 https 域名；测试里可用 PROVISION_HEALTH_BASE 指向本地
  // （与 PROVISION_API_BASE 同一套做法：只在发请求那一刻改写，生产不设就是真实地址）
  const healthBase = process.env.PROVISION_HEALTH_BASE ?? `https://${hostname}`;
  let health = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetchImpl(`${healthBase}/healthz`, { signal: AbortSignal.timeout(10_000) });
      const text = await r.text();
      if (r.ok && text.includes('"code":0')) {
        health = JSON.parse(text);
        break;
      }
      log(`   …https /healthz 还没通（HTTP ${r.status}）—— Caddy 可能正在申请证书`);
    } catch (e) {
      log(`   …https /healthz 还没通（${e.cause?.code ?? e.name}）`);
    }
    await sleep(pollMs);
  }
  if (!health) {
    /*
      证书没签下来时给出**可照做**的下一步，而不是一句"验收失败"。
      取日志这个动作本身不能失败：`sshRun` 在 ssh 都起不来时拿不到 stdout，
      原来 `.out.split(...)` 会抛 TypeError，把"为什么 https 没起来"整个盖掉 ——
      失败路径里再抛一个无关的异常，是排障时最贵的一种错。
    */
    const caddyLogs = String(
      sshRun({ keyPath, user, host, command: 'sudo docker logs --tail 40 marketplace-node-caddy 2>&1 || true', check: false })?.out ?? '(取不到日志：这台机器上 ssh 都不通)'
    );
    throw new CloudError(
      'unavailable',
      `等了 ${timeoutMs / 60000} 分钟 https://${hostname}/healthz 仍然不通。\n` +
        `        节点本身大概率是好的（先在机器上确认：curl -s http://127.0.0.1:8090/healthz）。\n` +
        `        HTTPS 没起来的常见原因：域名解析还没生效 / 80 端口没放行 / 该域名已被 Let's Encrypt 限流。\n` +
        `        Caddy 最近 40 行日志：\n${caddyLogs.split('\n').slice(-40).join('\n')}`
    );
  }
  const local = String(sshRun({ keyPath, user, host, command: 'curl -s -m 8 http://127.0.0.1:8090/healthz', check: false })?.out ?? '');
  let localJson = null;
  try {
    localJson = JSON.parse(local);
  } catch {
    /* 本机探活失败不影响"从公网验收通过"这个结论，但要如实记下来 */
  }
  log('   公网 https /healthz：code=0 ✓');
  return {
    healthz: { code: health.code, escrowAddress: health.data?.escrowAddress ?? health.escrowAddress, owner: health.data?.owner ?? health.owner },
    localHealthz: localJson ? { code: localJson.code } : { error: local.slice(0, 200) },
    httpsOk: true,
  };
}

/**
 * 打包节点代码：**两种仓库布局都要成立**，而且产出的包形状必须一致。
 *
 * 形状必须一致，因为服务器上的 `deploy.sh` 按 `$DIR/node` 找代码 —— 包里必须有一个 `node/`
 * 目录，`node/deploy.sh` 才在预期位置。两种布局：
 *   · 开发仓（`node/` 是子目录）：树是 `<rev>:node`；
 *   · 公开仓（仓库根**就是**节点本身，店主克隆的就是它）：树就是 `<rev>`。
 *
 * ⚠️ **前缀必须显式加**（`--prefix=node/`），不能指望"archive 子树会自带前缀"：
 *   实测（2026-10-15）`git archive <rev>:node` 产出的包**把子树内容放在根上**，没有 `node/` 这一层。
 *   原来那句注释与事实相反，而后果是服务器上 `$DIR/node/deploy.sh` 不存在 ——
 *   用户在部署阶段收到一个"文件找不到"，真因（包形状不对）在几十行之外。
 *   现在两种布局都显式带 `--prefix=node/`，包形状只有一种。
 *
 * 用 git 而不是直接 tar 工作区：发布物可复现，且未提交的改动不该上线（与 deploy-node.ps1 同口径）。
 */
export function packNode(repoRoot, rev, log) {
  const outDir = path.join(repoRoot, '.provision', 'pack');
  fs.mkdirSync(outDir, { recursive: true });
  const git = (args) => spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  const revOut = git(['rev-parse', '--short', rev]);
  if (revOut.status !== 0) throw new Error(`找不到提交：${rev}`);
  const short = revOut.stdout.trim();
  const tarball = path.join(outDir, `node-${short}.tgz`);
  // 判据看**提交树**而不是工作区文件：工作区里恰好有个 node/ 目录，不代表这个提交里有。
  // 公开仓布局下 `short:node` 不存在 ⇒ 用 `short`，也就是把**整个仓库根**打包成 node/ ——
  // 那个仓的根本来就**只是**节点（它的提交信息也是"同步 node 源码"），所以这是准确的。
  const asSubtree = git(['cat-file', '-e', `${short}:node/package.json`]).status === 0;
  const tree = asSubtree ? `${short}:node` : short;
  const arch = git(['archive', '--format=tgz', '--prefix=node/', '-o', tarball, tree]);
  if (arch.status !== 0) throw new Error(`git archive 失败（${tree}）：${arch.stderr}`);
  const dirty = git(['status', '--porcelain', '--', asSubtree ? 'node' : '.']).stdout.trim();
  if (dirty) log(`   ⚠ 有未提交改动，**不会**被发布（发的是提交 ${short} 的内容）—— 想发就先 commit`);
  log(`   打包：node-${short}.tgz（${(fs.statSync(tarball).size / 1024).toFixed(0)} KB，取自 ${asSubtree ? 'node/ 子树' : '仓库根（公开仓布局）'}）`);
  return tarball;
}

/**
 * 服务器上要跑的东西。三条纪律：
 *   1. 只在 $DIR 下动文件（宿主上除了 Docker 与一个数据卷不多留东西）；
 *   2. 调的是**店主脚本** node/deploy.sh（同一个脚本店主自己也在用），不另写一份部署逻辑；
 *   3. 用 `--tls-mode caddy`：新机器干净、80/443 空闲，Caddy 自己申请并续期证书，
 *      这样"买家看到的 endpoint 是 https"这条硬要求在第一步就成立。
 *
 * 包里带 `node/` 前缀（`packNode` 用 `--prefix=node/` **显式**加上 —— `git archive <rev>:node`
 * 不会自带前缀，实测过），所以解到 $DIR 之后脚本在 $DIR/node/deploy.sh，
 * 用 `--dir $DIR/node` 让安装目录就是那份代码本身
 * （deploy.sh 的 `IN_REPO` 判据要求 package.json 与 src/server.js 就在 --dir 里）。
 * 紧接着那句 `test -f "$SRC/deploy.sh"` 是这一步的哨兵：包形状错了就**在这里**停下，
 * 而不是让 deploy.sh 在更深的地方报一个与真因无关的错。
 */
function deployNodeScript({ owner, domain, email, installDir }) {
  const src = `${installDir}/node`;
  return `set -Eeuo pipefail
DIR=${shellQuote(installDir)}
SRC=${shellQuote(src)}
sudo mkdir -p "$DIR"
sudo chown "$(id -u):$(id -g)" "$DIR"
tar xzf /tmp/mk-node.tgz -C "$DIR"
rm -f /tmp/mk-node.tgz
test -f "$SRC/deploy.sh" || { echo "包里没有 deploy.sh —— 打包内容不对（$SRC）" >&2; exit 1; }
# deploy.sh 自己会装 Docker（若没有）、构建镜像、建数据卷、起容器、探活、起 Caddy 申请证书
cd "$SRC"
bash deploy.sh --owner ${shellQuote(owner)} --domain ${shellQuote(domain)} \\
  --email ${shellQuote(email)} --tls-mode caddy --dir "$SRC" \\
  --service marketplace-node --volume marketplace-node-data --port 8090 --no-register --yes
`;
}
