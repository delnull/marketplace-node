/**
 * 「这个地址在本节点能经营的店铺（含暂停接单）」——**唯一实现**。
 *
 * 两个入口必须回答同一件事，而且必须是**当下**的事实：
 *   · `POST /api/auth/login` 回执的 `shops[]`：前端据此画店铺切换器、记角色；
 *   · `GET /api/shops` 的 `operatedShops`：卖家面板据此读店名/头像/接单状态。
 *
 * 此前两处各拼一次，而登录回执那一份在**登录那一刻**定格：店铺歇业后它仍说
 * `listed: true`，头像/谈信等字段还会在第二份拼装里丢掉（暂停店不进公开在售列表，
 * 卖家面板只能拿回执里的行）。于是"已经歇业的店显示经营中、按钮还在让你歇业、头像变回色块"。
 *
 * 事实每次现读 `shops` 行 + `roleOf`，调用方不要缓存本函数的返回值，也不要在调用点补字段。
 */
import { operatedShopCodes, roleOf } from './auth.js';
import { nodeOwner, shopDto, shopRowByCode } from './shops.js';

/**
 * @param {string} address 已登录的钱包地址
 * @param {string} [nodeAddr] 节点 operator（调用方通常刚读过 `nodeOwner()`；不传则现读）
 * @returns {Promise<Array<object>>} 店铺 DTO + 该地址在该店的角色（`owner` / `staff`）
 */
export async function operatedShops(address, nodeAddr) {
  const addr = String(address || '').toLowerCase();
  if (!addr) return [];
  const host = nodeAddr === undefined ? await nodeOwner() : nodeAddr;
  const out = [];
  for (const code of await operatedShopCodes(addr)) {
    const row = await shopRowByCode(code);
    if (!row) continue;
    const role = await roleOf(addr, code);
    if (role !== 'owner' && role !== 'staff') continue;
    out.push({ ...shopDto(row, host), role });
  }
  return out;
}
