/**
 * 出站 HTTP 目标安全校验（SSRF 防护，2026-09 修复）：
 * 卖家 webhook URL 由店主配置、节点代为 POST——若允许指向内网/回环/云元数据地址，
 * 节点可被当作对内网与云厂商元数据（169.254.169.254 等）的盲 POST 源
 * （webhook 令牌被窃/多租户宿主上恶意店主/被诱导配置均可能触发）。
 *
 * 校验在「每次投递时」执行（URL 存 kv 可随时变更，校验点必须与投递点重合），
 * 同时校验主机名全部解析结果——防 DNS 指向内网（含 DNS rebinding 的大部场景；
 * 解析与连接之间的竞态窗口由本函数返回的 addresses + pinnedRequest 的地址钉死闭合，见下）。
 *
 * 2026-09 修复（地址钉死 / connection pinning）：只把"解析后的地址都是公网"告诉调用方是不够的——
 * 调用方若随后交给 `fetch(url)`，**fetch 会自己再解析一次**，被控 DNS 可以在第二次解析时返回
 * 127.0.0.1 / 169.254.169.254，于是校验被绕过（校验的地址 ≠ 连接的地址）。所以本函数除了
 * 判定，还**返回本次校验通过的那批地址**（字面量 IP 也返回自己），由调用方（pinnedRequest.js）
 * 把这批字面量钉进 socket 的 `lookup`，杜绝第二次解析。
 *
 * 规则：
 *  - 协议仅 http/https（调用方另行偏好 https）；
 *  - 主机名/IP 字面量解析后的任一地址命中保留段（IPv4 回环/私有/链路本地/CGNAT/
 *    文档/基准/组播/保留、IPv6 回环/未指定/ULA/链路本地/IPv4 映射）即拒绝。
 */
import dns from 'node:dns';
import net from 'node:net';

let _lookupAll = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** 测试注入主机名解析器（默认 node:dns 全量解析；返回 [{address}] 或抛错） */
export function setLookupAll(fn) {
  _lookupAll = fn;
}

/** IPv4 是否命中保留/内网段 */
export function isPrivateIpv4(ip) {
  const parts = String(ip).split('.').map((s) => Number(s));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 私有
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // 127/8 回环
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私有
  if (a === 192 && b === 168) return true; // 192.168/16 私有
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF 协议分配
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试
  if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // 组播 224/4 与保留 240/4、广播
  return false;
}

/**
 * IPv6 是否命中回环/未指定/内网/映射段。
 *
 * **2026-09 复审重写：先把地址展开成 8 个 16 位组，再按前缀判定**。
 * 旧实现是按**字符串前缀**逐段判断的，于是所有"写法与规范化形式不同"的保留地址都漏网：
 *   · `::127.0.0.1`（URL 规范化成 `::7f00:1`）——`::/96` 里的 IPv4 兼容地址；
 *   · `::a9fe:a9fe`（云元数据 169.254.169.254 的兼容形式）、`::ffff:0:127.0.0.1`；
 *   · `ff02::1`（IPv6 **组播**——IPv4 那边 `a >= 224` 是拦的，IPv6 这边完全没判）；
 *   · `2002:a9fe:a9fe::`（6to4，内嵌 IPv4 169.254.169.254）。
 * 这些地址会作为"已校验的公网目标"进入 `pinnedRequest` 的连接（没有第二道校验）。
 * 实测当前主流系统不路由 `::/96` 与 `::ffff:0:0/96`（`ENETUNREACH`），所以**不是可利用的 SSRF**，
 * 是纵深防御缺口——但"判据与被判对象必须同一套表示"这件事本身就该做对：
 * 按**数值段**判，而不是按**字符串形状**判；改完所有字面量写法自动归一，不会再漏一类。
 */
export function isPrivateIpv6(ip) {
  const groups = expandIpv6(ip);
  if (!groups) return null; // 非法字面量：交给调用方按"非法"处理（不是"公网"）
  const [g0, g1] = groups;
  // 未指定 :: / 回环 ::1
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  // IPv4 映射 ::ffff:0:0/96（URL 会规范成 ::ffff:x:y 或保持点分式）
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isPrivateIpv4(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`);
  }
  /*
    IPv4 **兼容**地址 ::a.b.c.d（::/96，且不是 :: 与 ::1）与 IPv4 转译 ::ffff:0:a.b.c.d
    （前缀 ::ffff:0:0:0/96）：两者都内嵌一个 IPv4，按 IPv4 规则判定。
    注：`::/96` 已被 IANA 标记为保留（除 :: 与 ::1），这里连"保留"一起拒掉。
  */
  if (groups.slice(0, 6).every((g) => g === 0)) {
    return true; // ::x:y 形式（含 ::127.0.0.1 → ::7f00:1）
  }
  if (groups.slice(0, 4).every((g) => g === 0) && groups[4] === 0xffff && groups[5] === 0) {
    return true; // ::ffff:0:a.b.c.d
  }
  // 链路本地 fe80::/10（0xfe80..0xfebf）；站点本地 fec0::/10（已废弃）
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true;
  if (g0 >= 0xfec0 && g0 <= 0xfeff) return true;
  // ULA fc00::/7
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // IPv6 组播 ff00::/8（含 ff02::1 全节点、ff05::1 等）
  if ((g0 & 0xff00) === 0xff00) return true;
  // NAT64 64:ff9b::/96 与 64:ff9b:1::/48（内嵌/映射目标可能是内网）
  if (g0 === 0x0064 && g1 === 0xff9b) return true;
  // 文档前缀 2001:db8::/32
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  // 6to4 2002::/16：内嵌的 IPv4 若是保留段，转发目标就是内网
  if (g0 === 0x2002) {
    return isPrivateIpv4(`${groups[1] >> 8}.${groups[1] & 0xff}.${groups[2] >> 8}.${groups[2] & 0xff}`);
  }
  return false;
}

/**
 * 把 IPv6 字面量展开成 8 个 16 位组（数值）。
 * 支持：`::` 缩写、内嵌点分式 IPv4（`::ffff:127.0.0.1`）、混合写法。
 * 非法输入返回 `null`（调用方按"非法"处理，绝不按"公网"放行）。
 */
export function expandIpv6(ip) {
  let s = String(ip || '').toLowerCase().trim();
  if (!s) return null;
  // 去掉可能的方括号与区域号（fe80::1%eth0）
  s = s.replace(/^\[|\]$/g, '').split('%')[0];
  // 末尾的点分式 IPv4 → 两个 16 位组
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${s.slice(0, dotted.index)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => {
    if (!part) return [];
    const out = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null; // `::` 至少要代表一组
  return [...head, ...new Array(fill).fill(0), ...tail];
}

/** 判断单个 IP 是否命中保留/内网段（IPv4/IPv6/字面量非法返回 null 之外的结果） */
export function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) return isPrivateIpv4(ip);
  if (net.isIP(ip) === 6) return isPrivateIpv6(ip);
  return null;
}

/**
 * 校验出站 HTTP(S) 目标是否安全（公网可达）。
 *
 * 通过时**必须**返回 `addresses`：那是本次校验判定为公网的那批字面量 IP，调用方应当（经
 * pinnedRequest）把连接钉死在这批地址上——校验与连接之间若再解析一次，就是 DNS rebinding 窗口。
 *
 * @param {string} url
 * @returns {Promise<{ ok: true; host: string; port: string; protocol: string; addresses: string[] }
 *                  | { ok: false; message: string }>}
 *   host=主机名（IPv6 去方括号）/port=URL 里的端口原文（缺省为空串）/protocol='http:'|'https:'
 */
export async function assertPublicHttpTarget(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, message: 'URL 格式非法' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, message: '仅支持 http/https 协议' };
  }
  if (u.username || u.password) {
    return { ok: false, message: 'URL 不允许携带用户信息（user:pass@）' };
  }
  // 方括号只是 URL 语法（http://[::1]/）：判定与钉住地址都用裸地址
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const base = { host, port: u.port, protocol: u.protocol };
  // 字面量 IP：直接判定（钉住地址就是它自己，无需再解析）
  const literal = isPrivateIp(host);
  if (literal !== null) {
    if (literal) return { ok: false, message: `目标地址为内网/保留地址（${host}），已拒绝投递` };
    return { ok: true, ...base, addresses: [host] };
  }
  // 主机名：全量解析并逐个判定（任一解析命中保留段即拒绝）
  try {
    const rows = await _lookupAll(host);
    const addrs = Array.isArray(rows) ? rows.map((r) => (typeof r === 'string' ? r : r.address)) : [];
    if (!addrs.length) return { ok: false, message: '目标域名解析结果为空' };
    for (const a of addrs) {
      if (isPrivateIp(a)) {
        return { ok: false, message: `目标域名解析到内网/保留地址（${host} → ${a}），已拒绝投递` };
      }
    }
    // 全部为公网：把这批地址交给调用方钉死（本次解析结果即连接目标，不再给 DNS 第二次机会）
    return { ok: true, ...base, addresses: addrs };
  } catch (e) {
    return { ok: false, message: `目标域名解析失败：${e?.message || e}` };
  }
}
