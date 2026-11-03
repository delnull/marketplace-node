/**
 * 预算闸门 —— **"能不能花这笔钱"只有这一处判据**。
 *
 * 为什么必须是一个闸门而不是每个 provider 里各判一次：
 * 这个脚本会**真的下单**（开机器、买域名都是不可撤销的支出）。判据一旦散开，就会出现
 * "阿里云那条路记得查额度、AWS 那条忘了"这种洞，而代价是用户的钱。
 * 所以：所有花钱的入口（`createServer` / `buyDomain`）都从 `enforce()` 拿到许可才动，
 * 且 `enforce()` 只有一种"通过"的形状 —— 带了明确的额度上限。
 *
 * 三条刻意写死的规则：
 *   1. **没给额度就不许买**（不是"默认放行"，也不是"默认拦死"）：不给 `--max-monthly`
 *      就没有任何支出授权，直接拒绝。理由是本仓的老账：兜底默认值会把真原因盖掉，
 *      而这里的真原因是"没人授权花这笔钱"。
 *   2. **价格取不到就不许买**：宁可停下来让人给个价（`--price-*`），也不拿一张会过期的
 *      硬编码价目表冒充"实时价格" —— 那张表既是第二份真相，又会随服务商调价变成假话。
 *      provider 的实时询价失败时，只能由人显式给出价格，脚本才继续。
 *   3. **不混币种**：全仓唯一的金额口径是**元（CNY）**，`--max-*` 也是元。
 *      服务商按别的币种报价（阿里云的域名价、AWS 的美元价）时，这里**拒绝**并要人自己换算，
 *      绝不按某个内置汇率折算 —— 汇率是会变的第二份真相，而算错的后果是"以为没超预算"。
 *
 * ── 把钱挂到**报价**上，而不是挂到"用户填的数字"上 ────────────────────────────
 * 这里必须承认一个不变量：**能过闸门的前提是有一个可核对的价**。
 * 只要 `serverMonthly > 0` 就放行，那么把数字填小（`--price-server 1`）就能让额度形同虚设
 * —— 而"按最坏情况判"是这个工具唯一的承诺，破了它就等于没有闸门。
 * 所以机器价必须 `> 0`（没有就拒绝，不退化成一个 0 元的假通过）。
 *
 * 代价写明：这条挡不住"用户故意少填"（脚本无法核对机器的真实价）。它挡住的是另外两类，
 * 而那两类才是真正常见的：① 忘了给价导致退化成 0 元的**假通过**；② 以为自己给了价、
 * 其实服务商询价失败了（"我觉得应该是这个价"与"服务商说要这个价"是两件事）。
 */

/** 每月折合成本（元/月）：机器按月 + 域名摊到每月。唯一用于闸门比较的口径。 */
export function monthlyEquivalent({ serverMonthly, domainTotal, domainYears }) {
  const years = Math.max(1, domainYears || 1);
  return serverMonthly + (domainTotal || 0) / (years * 12);
}

export const CNY = new Set(['CNY', 'RMB', '元', '', null, undefined]);

/**
 * 域名单价取哪一个——**唯一判据**（plan 与 up 共用；2026-10-15 审计 F10）。
 *
 * 此前两处各写一份、形状还不一样：`up.mjs` 是
 * `!(price.yearly > 0) || !pricedInYuan` ⇒ 服务商报美元时**要求** `--price-domain`；
 * `cli.mjs` 是 `!(domainYearly > 0) && o.priceDomain > 0` ⇒ 服务商有价就照用（哪怕币种是美元），
 * 把币种问题留给预算闸门。两边最终都会拒绝，但**说出来的话不一样**：
 * 一个说"请用 --price-domain 给个元价"，一个说"币种不对"——同一件事两句话，
 * 而用户往往是先看 plan 再跑 up（看到的两条建议不一致时，他会以为其中一个坏了）。
 *
 * 判据（只有三种结果）：
 *   · 服务商报价能直接用（有价 **且** 币种按元计）⇒ 用它；
 *   · 否则用户给了 `--price-domain`（按元）⇒ 用它，来源如实写"你给的价"；
 *   · 否则 ⇒ **没有可用的价**：调用方各自决定怎么表达（up 抛错、plan 记 blocker），
 *     但"为什么没有"由本函数给出（`reason`），两侧说同一句。
 *
 * 为什么不内置汇率折算：本仓的额度是元，折算率是另一份会过期、且会悄悄改变授权含义的真相
 * ——宁可让用户自己给一个他接受的价格（见 budget.mjs 里"不混币种"那段）。
 *
 * @param {{ price?: { yearly?: number|null, currency?: string|null, source?: string }, priceDomain?: number }} o
 * @returns {{ ok:true, yearly:number, currency:'CNY', source:string, manual:boolean } | { ok:false, reason:string }}
 */
export function domainPriceOf({ price, priceDomain }) {
  const yearlyApi = Number(price?.yearly);
  const currency = String(price?.currency ?? '').toUpperCase();
  if (Number.isFinite(yearlyApi) && yearlyApi > 0 && CNY.has(currency)) {
    return { ok: true, yearly: yearlyApi, currency: 'CNY', source: price?.source ?? '服务商报价', manual: false };
  }
  const manual = Number(priceDomain);
  if (Number.isFinite(manual) && manual > 0) {
    return { ok: true, yearly: manual, currency: 'CNY', source: `你给的价（--price-domain ${manual} 元/年）`, manual: true };
  }
  const quoted = Number.isFinite(yearlyApi) && yearlyApi > 0 ? `${yearlyApi}/${price?.currency ?? '未知币种'}` : '未取到价格';
  return {
    ok: false,
    reason:
      `域名报价来自服务商（${quoted}），而本工具的额度是**元**；查不到元价时不许猜：` +
      '请用 --price-domain <元/年> 给出你接受的价格（例如 --price-domain 70），闸门再按它判',
  };
}

/**
 * 花钱前的唯一判据。
 *
 * @param {object} o
 * @param {number|undefined} o.maxMonthly      用户授权的每月上限（元/月）
 * @param {number|undefined} o.maxDomainYear   用户授权的域名单价上限（元/年）
 * @param {{ serverMonthly:number, serverCurrency?:string, serverPricedBy:'provider'|'user', domainTotal:number, domainYears:number, domainYearly:number, domainCurrency?:string, domainPricedBy?:'provider'|'user', serverSource:string, domainSource:string }} o.cost
 * @returns {{ ok:true, monthly:number } | { ok:false, why:string }}
 */
export function enforce({ maxMonthly, maxDomainYear, cost, scope = 'full' }) {
  if (!(maxMonthly > 0)) {
    return {
      ok: false,
      why:
        '没有支出授权：必须显式给出每月上限（--max-monthly <元/月>）才会创建任何资源。\n' +
        '        这不是形式：脚本会真的下单（机器按小时计费、域名一次性扣费，都不可撤销）。\n' +
        '        先跑 `provision plan` 看这次要花多少，再带着额度跑 `provision up`。',
    };
  }
  /*
    机器必须先有一个**可核对的价**（见文件头"把钱挂到报价上"）：
    空价会退化成"0 元/月 ≤ 额度"，那样额度就从判据变成了装饰。
    例外只有一种，而且必须由调用方**显式声明**：`scope: 'domain-only'` ——
    买域名那一步的闸门只授权域名，机器还没询价、也不该在这一步被考核。
    靠"默认值恰好是 0"来跳过检查是隐式豁免，而隐式豁免迟早会漏到别的调用点上。
  */
  if (scope === 'full' && !(cost.serverMonthly > 0)) {
    return {
      ok: false,
      why:
        '机器的价格还拿不到（服务商询价失败，也没给 --price-server），所以无法判断会不会超预算 —— 停在这里，不猜。\n' +
        '        Aliyun/Tencent 能实时询价，换这两家通常就有价；AWS 没有询价接口，只能自己给：\n' +
        '        --price-server <元/月>（按你这台机器的实际月成本填，别填一个"能过闸门"的数）。',
    };
  }
  if (cost.domainTotal > 0 && !(maxDomainYear > 0)) {
    return {
      ok: false,
      why:
        `这次包含买域名（${cost.domainTotal} / ${cost.domainYears} 年），但没有给域名单价上限。\n` +
        '        买域名是不可撤销的支出，必须单独授权：--max-domain-year <元/年>。\n' +
        '        不打算买域名就把域名换成已有的：--domain <已在你账号里的域名>。',
    };
  }
  /*
    币种判在额度和单价之后：先回答"有没有授权买"，再回答"这个价格能不能用"。
    反过来会让"根本没给额度"的人看到一句"币种不对"，那与他的实际问题无关。
  */
  for (const [what, cur, flag] of [
    ['机器', cost.serverCurrency, '--price-server'],
    ['域名', cost.domainTotal > 0 ? cost.domainCurrency : null, '--price-domain'],
  ]) {
    if (cur && !CNY.has(String(cur).toUpperCase())) {
      return {
        ok: false,
        why:
          `${what}的报价是 ${cur}，而本工具的额度（--max-*）是**元**。不做汇率折算：\n` +
          `        请自己换算成元后用 ${flag} <元> 给出你接受的价格，或换一个按人民币计费的站点/账号。\n` +
          '        （内置汇率是第二份真相，而且会变；算错的后果是"以为没超预算"。）',
      };
    }
  }
  if (cost.domainTotal > 0 && cost.domainYearly > maxDomainYear + 0.01) {
    return {
      ok: false,
      why: `域名单价 ${cost.domainYearly} 元/年 超过授权上限 ${maxDomainYear} 元/年（--max-domain-year）。`,
    };
  }
  const monthly = monthlyEquivalent(cost);
  if (monthly > maxMonthly + 0.01) {
    return {
      ok: false,
      why:
        `这次折合 ${monthly.toFixed(2)} 元/月，超过授权上限 ${maxMonthly} 元/月（--max-monthly）。\n` +
        `        明细：机器 ${cost.serverMonthly} 元/月（来源：${cost.serverSource}）` +
        (cost.domainTotal > 0 ? ` + 域名 ${cost.domainTotal} 元/${cost.domainYears} 年（来源：${cost.domainSource}）` : ''),
    };
  }
  return { ok: true, monthly };
}
