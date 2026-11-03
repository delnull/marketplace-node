/**
 * 续跑与"要不要用已有机器"的唯一判据。
 *
 * ── 为什么单独一层 ────────────────────────────────────────────────────────────
 * "这次要不要再开一台机器"是**会花钱**的判断，而它有几个信息来源：本地状态文件、云上账号里
 * 已有的机器、命令行的 `--adopt`。这三者一旦各判一次，就会出现"某条路忘了判"的洞，
 * 代价是买重复的机器（而且第二台还会和第一台抢同一个域名/同名容器）。
 * 所以判据只在这里成立一次，`up()` 只拿结论。
 *
 * ── 两条硬规矩 ────────────────────────────────────────────────────────────────
 * 1. **名字是身份，不许有两台同名**：允许"再开一台同名的"就等于让"按名字找机器"有两个答案，
 *    之后每一次判断都可能指到错的那台。要开第二家店就换名字。
 * 2. **只认领，不替你挑**：账号里可能有好几台机器（你自己的、别的项目留下的、上次装到一半的）。
 *    挑错一台的后果是"把商城装到了另一台机器上"，而那种错很难一眼看出来。所以脚本把
 *    **能用的都列出来**（并标出哪几台我们连得上），让你点名 `--adopt <id>` 或用 `--server-name` 开新的。
 *
 * ── 为什么要连一遍 SSH ───────────────────────────────────────────────────────
 * "这台上已经有一台机器"与"这台机器我们能装上去"是两件事：认领的前提是**我们的密钥能登进去**
 * （云端没有"给已有实例补一把公钥"的接口）。所以候选会被探一次（并行、超时很短），
 * 结果直接标在清单上 —— 否则用户会照着清单填了 ID，然后失败在一个与他的判断无关的地方。
 */
import { CloudError } from './errors.mjs';

/** 这台机器现在能被我们接手吗（只看与"能不能用"有关的客观条件，不看它叫什么） */
export function adoptable(s) {
  if (!s?.publicIp) return { ok: false, why: '没有公网 IP（拿不到 IP 就没法接管）' };
  if (/terminated|shutting-down|shutting/i.test(s.status ?? '')) return { ok: false, why: `状态是 ${s.status}` };
  if (/stopped|stopping/i.test(s.status ?? '')) return { ok: false, why: `状态是 ${s.status}（先开机）` };
  return { ok: true };
}

/**
 * @param {object} o CLI 选项
 * @param {Array} existing 账号里已有的机器（限定在目标区域）
 * @param {object|null} st 本地状态
 * @param {(s:object)=>Promise<boolean>} [probe] 探一次"我们的密钥能不能登进去"
 * @param {(m:string)=>void} [log]
 */
export async function decideServer({ o, existing, st, serverName, probe, log = () => {} }) {
  /*
    ── ① 状态文件里已经记了**还活着的**机器 ⇒ 续跑，绝不再买 ──────────────────
    `releasedAt` 是 `destroy` 写下的"这台机器已经释放掉了"的标记（2026-10-15 修一处致命漏读）：
    旧实现写完这个字段**没有任何判据读它**，于是 `up → destroy → up` 会走"续跑"分支，打印
    "机器已有（i-xxx / 1.2.3.4）—— 复用"，然后对着一个已经释放的 IP 建 A 记录、等 SSH 超时。
    更糟的是没有出路：`--adopt`（本文件下方那条路径，自称"状态没写成时的唯一安全出路"）
    被这个早返回挡在后面，用户只能手工删状态文件。
    现在的判据：**只有"没有 releasedAt"的 server 才算续跑对象**；已释放的按"状态里没有机器"处理
    （往下走 ②--adopt / ③同名检查 / ④下单），并在日志里说清为什么忽略它。
  */
  if (st?.server?.id && st.server.releasedAt) {
    log(
      `   状态文件里的机器 ${st.server.id} 已由 destroy 释放（${st.server.releasedAt}）——不当作可续跑的机器；` +
        '下面按"还没有机器"继续（要认领别的机器请用 --adopt <id>）'
    );
  }
  if (st?.server?.id && !st.server.releasedAt) {
    // 但要防"参数被改过"：换域名/换区域/换机器名时，续跑会把新参数套到旧机器上，
    // 而那台机器上跑的东西是按旧参数装的 —— 静默套上去 = 两套真相。
    const drift = [];
    if (o.domain && st.domain && o.domain !== st.domain) drift.push(`域名（状态里是 ${st.domain}，这次给的是 ${o.domain}）`);
    if (o.region && st.server.region && o.region !== st.server.region) drift.push(`区域（状态里是 ${st.server.region}）`);
    if (o.serverName && st.server.name && o.serverName !== st.server.name) drift.push(`机器名（状态里是 ${st.server.name}）`);
    /*
      **店主地址也要比**：它是店铺的身份锚点（节点的 MK_SHOP_OWNER，上架/发货都用它签名登录）。
      续跑时把 owner 换掉，会把新参数静默套到按旧 owner 装好的节点上 —— 而那台机器上的店
      已经属于旧地址了。这类错误事后极难纠正（本仓对 operator 落错店的判据是"拒绝"）。
    */
    if (o.owner && st.owner && o.owner.toLowerCase() !== st.owner.toLowerCase()) {
      drift.push(`店主地址（状态里是 ${st.owner}，这次给的是 ${o.owner}）`);
    }
    if (drift.length) {
      throw new CloudError(
        'invalid',
        `状态文件里已经有一台机器，但这次给的参数与它不一致：${drift.join('、')}。\n` +
          `        续跑只接受**同样的参数**；要换一套参数就换个店铺名（--shop <新名字>）重新开，\n` +
          `        或者先释放旧机器：node provision/cli.mjs destroy --shop ${st.shop}`,
        { provider: o.provider }
      );
    }
    return { action: 'reuse', server: st.server, why: '状态文件里记着这台机器 ⇒ 续跑，不再下单' };
  }

  // ── ② 显式认领 ────────────────────────────────────────────────────────────
  if (o.adopt) {
    const hit = existing.find((s) => s.id === o.adopt) ?? existing.find((s) => s.publicIp === o.adopt);
    if (!hit) {
      throw new CloudError(
        'invalid',
        `--adopt ${o.adopt}：在 ${o.region || '默认区域'} 里找不到这台机器。\n` +
          `        账号里现在有：\n${listing(existing)}\n` +
          '        换区域请加 --region；确认 ID/IP 有没有抄错。',
        { provider: o.provider }
      );
    }
    const can = adoptable(hit);
    if (!can.ok) throw new CloudError('invalid', `--adopt ${hit.id}：${can.why}`, { provider: o.provider });
    if (probe) {
      const reachable = await probe(hit);
      // 连不上不直接拒绝：用户可能自己知道怎么处理（比如他手上还有当初那把密钥）。
      // 但要**明确警告**——认领的下一步就是 SSH 上去装东西，连不上就装不了。
      log(
        reachable
          ? `   ${hit.id} 我们的密钥可以登录 ✓`
          : `   ⚠ ${hit.id} 我们的密钥登不进去（云端没有"给已有实例补公钥"的接口）——除非你还有它当初那把密钥，否则装不上去`
      );
      return {
        action: 'adopt',
        server: { ...adoptRecord(hit, o), reachable },
        why: `按 --adopt 认领已有机器 ${hit.id}`,
      };
    }
    return { action: 'adopt', server: adoptRecord(hit, o), why: `按 --adopt 认领已有机器 ${hit.id}` };
  }

  // ── ③ 同名机器：这是**我们上次可能开过**的那台，优先处理 ────────────────────
  const sameName = existing.filter((s) => s.name === serverName);
  if (sameName.length) {
    throw new CloudError(
      'invalid',
      `账号里已经有 ${sameName.length} 台叫 ${serverName} 的机器，**没有自动挑一台**给你用：\n${listing(sameName)}\n` +
        '        三条路，自己选一条（脚本不替你猜）：\n' +
        `          ① 就用上面某台继续部署：--adopt ${sameName[0].id}\n` +
        '          ② 再开一台（给新店换个名字）：--server-name <别的名字>\n' +
        '          ③ 只想看现状、不动手：node provision/cli.mjs check',
      { provider: o.provider }
    );
  }

  // ── ④ 有别的机器（名字不同）：列出来问一句，但**不替你挑** ────────────────────
  const usable = existing.filter((s) => adoptable(s).ok);
  if (usable.length) {
    // 探一遍"我们能不能登进去"，把结论直接标在清单上：用户照着填 ID 之前就该知道结果
    const marks = new Map();
    if (probe) {
      const results = await Promise.all(
        usable.map(async (s) => {
          try {
            return [s.id, await probe(s)];
          } catch {
            return [s.id, false];
          }
        })
      );
      for (const [id, ok] of results) marks.set(id, ok);
    }
    const lines = usable.map((s) => {
      const mark = marks.has(s.id) ? (marks.get(s.id) ? '  ✓ 我们的密钥可登录' : '  （我们的密钥登不进去）') : '';
      return `    ${s.id}  ${s.name ?? '(未命名)'}  ${s.status ?? '?'}  ${s.publicIp}${mark}`;
    });
    const reachable = [...marks.values()].filter(Boolean).length;
    throw new CloudError(
      'invalid',
      // 刻意不写"哪个区域"：各家的列表覆盖面不一样（阿里云/腾讯云是逐区域查的合并结果，AWS 只查一个区域），
      // 写一个具体区域名就可能是假话；上面那行"已有服务器（…）"才是这个列表的准确出处。
      `账号里已经有 ${usable.length} 台可以用的机器：\n${lines.join('\n')}\n` +
        '        用哪台？自己点名（脚本不替你猜——挑错一台就是把商城装到了另一台机器上）：\n' +
        `          ① 用上面某台：--adopt ${usable[0].id}\n` +
        `          ② 都不用、另开一台：--server-name ${serverName}（账号里没有这个名字就会新开一台）\n` +
        (reachable
          ? `        标"我们的密钥可登录"的（${reachable} 台）可以直接接管。`
          : '        这几台都登不进去：接管要求**我们的密钥能登进去**（云端没有"给已有实例补一把公钥"的接口）。\n' +
            '        除非你还有它当初那把密钥，否则①走不通，直接用②。') +
        '\n        另外：用不到的机器记得在控制台停掉/释放 —— 它们还在按小时计费。',
      { provider: o.provider }
    );
  }

  return { action: 'create', server: null, why: '账号里没有可用机器 ⇒ 这一步要新开一台' };
}

/** 把云上那条记录转成状态里的形状（多一个 adopted 标记：别假装这台是我们开的） */
function adoptRecord(hit, o) {
  return {
    id: hit.id,
    name: hit.name ?? o.serverName,
    region: o.region || null,
    instanceType: hit.instanceType ?? null,
    publicIp: hit.publicIp,
    adopted: true,
  };
}

function listing(servers) {
  if (!servers.length) return '    （没有）';
  return servers.map((s) => `    ${s.id}  ${s.name ?? '(未命名)'}  ${s.status ?? '?'}  ${s.publicIp ?? '（暂无公网 IP）'}`).join('\n');
}

/** 把"现状 + 下一步会做什么"印出来（`up` 开头与 `check` 都用同一份，避免两处口径不一致） */
export function describeResume(st) {
  if (!st) return ['本地没有这个店铺的状态文件 ⇒ 这次会从零开始（机器与域名都还没买）'];
  const lines = [];
  const done = [];
  const todo = [];
  (st.server?.id ? done : todo).push(st.server?.id ? `机器 ${st.server.id}（${st.server.publicIp ?? 'IP 待查'}${st.server.adopted ? '，认领的' : ''}）` : '机器');
  (st.domainPurchase?.bought || st.domain ? done : todo).push(st.domain ? `域名 ${st.domain}` : '域名');
  (st.dns?.recordId ? done : todo).push('解析');
  (st.ssh?.keyPath ? done : todo).push('SSH 密钥');
  (st.node?.deployedRev ? done : todo).push('节点容器');
  lines.push(`本地状态：已完成 ${done.length ? done.join('、') : '（无）'}`);
  lines.push(`          待完成 ${todo.length ? todo.join('、') : '（无）'}`);
  if (st.verified?.at) lines.push(`上次验收：${st.verified.at}（${st.verified.httpsOk ? '公网 https 通' : '未通过'}）`);
  return lines;
}
