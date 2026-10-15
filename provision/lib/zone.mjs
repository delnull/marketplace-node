/**
 * 解析区（= 可注册的那一级 = 在注册商那里真正要买的那个名字）的唯一判据。
 *
 * ── 为什么必须是唯一一层 ──────────────────────────────────────────────────────
 * `--domain shop.example.com` 是**买家访问的名字**，而注册商只卖**可注册的那一级**
 * （`example.com`）。这两件事在 plan / up / buy / DNS 四处都要用到，各自推一次就是四处口径，
 * 而推错的症状是"去买一个买不到的名字"或"解析建了但永远不生效"（都不报错，只是结果不对）。
 *
 * 只对两段名字有把握（`shop.example.com` → `example.com`）；多段的地方必须让人显式给 `--zone`：
 * 公共后缀表是另一份会过期的真相 —— `shop.example.co.uk` 的可注册后缀不是"取后两段"。
 */
import { CloudError } from './errors.mjs';

/**
 * @param {{ domain?: string, zone?: string }} o
 * @returns {string} 解析区名
 */
export function resolveZone({ domain, zone }) {
  const d = String(domain ?? '');
  if (!d) throw new CloudError('invalid', '缺少域名：用 --domain shop.example.com 指定');
  const resolved = (() => {
    if (zone) {
      if (zone !== d && !d.endsWith(`.${zone}`)) {
        throw new CloudError('invalid', `--zone ${zone} 不是 ${d} 的上级域名 —— 换一个能对上的（域名本身就是解析区时用 --zone ${d}）`);
      }
      return zone;
    }
    const parts = d.split('.');
    if (parts.length <= 2) return d;
    if (parts.length > 3) {
      throw new CloudError(
        'invalid',
        `${d} 的层级多于三层，无法可靠地推出"可注册的那一级"（公共后缀表是另一份会过期的真相）。\n` +
          '        请显式指定解析区：--zone <可注册的那一级，例如 example.com>'
      );
    }
    return parts.slice(-2).join('.');
  })();
  /*
    ── 解析区必须是**可注册形状**（至少两段），不能是 TLD（2026-10-15 审计 F9）──────────
    `--zone com --domain shop.example.com` 此前被放行（上面只查了"是上级域名"这一条），
    而后果不在报错里、在 DNS 里：`recordName` 反推出 `shop.example`，于是往 **com 区**写一条
    名为 `shop.example` 的 A 记录——`shop.example.com` 全链路都按这个名字走，而那条记录
    对它的主人毫无意义（`com` 不是他的区，调用要么权限失败、要么写进一个跟他无关的区）。
    为什么判据只到"至少两段"、不要求"必须是主机名的直接上级"：DNS 里多标签记录名（`a.b`
    在 `example.com` 区里）是**合法**的，`--domain a.b.example.com --zone example.com` 两边
    都是店主自己的名字、写进去就能生效——把它也拒掉就是顺手收紧了没被触发的路径。
    这一条同时是"买域名"那一步的前置：本工具会去买缺失的区，而 TLD 永远买不到。
  */
  if (!resolved.includes('.')) {
    throw new CloudError(
      'invalid',
      `--zone ${resolved} 是一个顶级域，不是可注册的那一级：解析记录会被写进 ${resolved} 区，` +
        `而这个区不属于你（记录要么建不了、要么对 ${d} 永远不生效）。\n` +
        `        请给可注册的那一级，例如 --zone ${d.split('.').slice(-2).join('.')}`
    );
  }
  return resolved;
}

/** 主机名在解析区里的记录名（`shop.example.com` @ `example.com` → `shop`；域名本身就是区 → `@`） */
export function recordName({ domain, zone }) {
  return zone === domain ? '@' : String(domain).slice(0, -(zone.length + 1));
}
