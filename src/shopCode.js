/**
 * **节点编号**（链上铸造的 9 位编号 = 8 位 Crockford Base32 数据 + 1 位加权校验位，
 * 见 shared/shopCode.js 与合约注释）。
 *
 * ⚠️ 节点编号与**店铺编号**是两条独立的链上序列（合约 `_mintNodeCode` / `_mintShopCode`）：
 *   · 节点编号 = `Registry.codeOf(host)` —— 标识"这台机器在目录里的位置"；
 *   · 店铺编号 = `shops.code`（链上 `ShopInfo.code`）—— 标识"这家店"，来自
 *     `Registry.getShop(seller, host).code`，由 src/termsReconciler.js 对账进本地。
 * 两者长得一样（都是 9 位 Crockford Base32），但**不可互换**：混用会让链接指向一个
 * 不存在的店，或别人的店。
 *
 * 为什么节点要自报节点编号：前端把"这台机器"写进 `/nodes/<节点编号>` 时，手上常常只有 origin
 * （目录行、订单行、流水跳转…）。节点在自己的响应里顺带带上它，前端任何一次交互都能学会
 * `origin → 节点编号`，不必为每个链接点各发一次请求。
 *
 * 读法带 30 秒缓存（节点编号只在注册时铸造一次，更新/重新登记都沿用原值，缓存因此非常安全）。
 * 未配置 registry/host 或链不可达 → 返回 ''，**绝不编造**（调用方按"未知编号"处理）。
 */
import { ethers } from 'ethers';
import config from './config.js';
import { getProvider } from './chain.js';
import { hostOperator } from './shops.js';

const ABI = ['function codeOf(address operator) view returns (string)'];
const TTL_MS = 30_000;

let cache = { at: 0, value: '' };

/** 读本节点的**节点编号**（带 30s 缓存；失败/未配置返回 ''） */
export async function nodeCode() {
  const op = hostOperator();
  const registry = String(config.chain?.registryAddress || '');
  if (!op || !/^0x[0-9a-fA-F]{40}$/.test(registry)) return '';
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const c = new ethers.Contract(registry, ABI, getProvider());
    const v = String(await c.codeOf(op));
    cache = { at: Date.now(), value: v };
    return v;
  } catch {
    return cache.value || ''; // 链不可达：沿用上次读到的（有就给，没有就空）
  }
}

/** 仅供测试：清空缓存 */
export function resetShopCodeCache() {
  cache = { at: 0, value: '' };
}

/**
 * 同步取**已缓存**的节点编号（不发请求）。
 *
 * 给"响应体里顺带带上编号"这种场景用：编号只在注册时铸造一次（更新/重新登记都沿用），
 * 所以缓存里的值一旦拿到就不会再变——这里只回答"读到过没有"，**不判断 TTL**。
 * 旧实现写成 `if (!value || 过期) return value || ''; return value;`：两个出口返回同一个值，
 * 过期分支是死代码，读的人却会以为"过期后会返回空"。TTL 只属于 `nodeCode()`（它决定要不要重读链）。
 *
 * 首次调用（还没预热）返回 ''，调用方同时触发一次 `void nodeCode()` 暖缓存即可
 * （`app.js` 启动时已预热）——这样 `/api/shop` 不需要为了一个展示字段变成 async。
 */
export function cachedShopCode() {
  return cache.value || '';
}

/** 仅供测试：直接写入缓存（模拟"已预热"；没有它就只能起假 RPC 才能验同步读法） */
export function __setCachedShopCodeForTest(value) {
  cache = { at: Date.now(), value: String(value || '') };
}
