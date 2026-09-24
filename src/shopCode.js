/**
 * 本节点的**店铺编号**（链上铸造的 9 位编号 = 8 位 Crockford Base32 数据 + 1 位加权校验位，
 * 见 shared/shopCode.js 与合约注释）。
 *
 * 为什么节点要自己知道并自报：
 *  - 前端要把"某家店"写进 URL（`/shop/00000003`），而它手上常常只有 origin
 *    （订单行、商品卡、流水跳转…）。如果每家店都得额外发一次请求去问编号，
 *    就不会有人愿意在 27 个链接点上都等一次往返；
 *  - 节点本来就知道自己是谁（配置里的 operator + registry 地址），
 *    在**它自己的响应里顺带带上编号**，前端任何一次交互都能学会 `origin → code` ✓
 *
 * 读法：`Registry.codeOf(operator)`，30 秒缓存（编号只在注册时铸造一次，且更新/重新登记
 * 都沿用原值，所以缓存非常安全）。未配置 registry/operator 或链不可达 → 返回 ''，
 * **绝不编造**编号（调用方按"未知编号"处理）。
 */
import { ethers } from 'ethers';
import config from './config.js';
import { getProvider } from './chain.js';

const ABI = ['function codeOf(address operator) view returns (string)'];
const TTL_MS = 30_000;

let cache = { at: 0, value: '' };

/** 读本店编号（带 30s 缓存；失败/未配置返回 ''） */
export async function shopCode() {
  const op = String(config.shop?.owner || '').toLowerCase();
  const registry = String(config.chain?.registryAddress || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(op) || !/^0x[0-9a-fA-F]{40}$/.test(registry)) return '';
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
 * 同步取**已缓存**的编号（不发请求）。
 *
 * 给"响应体里顺带带上编号"这种场景用：编号只在注册时铸造一次，缓存 30s 足够，
 * 首次调用（还没有缓存）返回 ''，调用方同时触发一次 `void shopCode()` 暖缓存即可 ——
 * 这样 `/api/shop` 不需要为了一个字段变成 async。
 */
export function cachedShopCode() {
  if (!cache.value || Date.now() - cache.at >= TTL_MS) return cache.value || '';
  return cache.value;
}
