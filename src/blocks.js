/**
 * 买家在本节点的屏蔽名单（持久化在节点 DB，不是浏览器 localStorage）。
 *
 * 语义：
 *  - 只对**当前节点**生效；同一买家换节点需要在该节点重新设置（联邦模型没有全局账户）。
 *  - `shop` 目标是本节点店铺编号；`seller` 目标是链上收款地址。
 *  - 订单历史不因屏蔽而消失；屏蔽只影响发现/店铺列表与下单入口。
 *  - 不存 `origin`/节点主：一台节点多店，按节点主屏蔽会连带隐藏无关店铺，产品上不做。
 */
import { getDb } from './db.js';
import { isShopCodeShape } from './shopCode.js';

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export function blockDto(row) {
  return {
    id: Number(row.id),
    targetType: row.target_type,
    target: row.target_value,
    shopCode: row.shop_code || null,
    reason: row.reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listBuyerBlocks(buyer) {
  const addr = String(buyer || '').toLowerCase();
  if (!ADDRESS_RE.test(addr)) return [];
  const rows = await getDb().all(
    'SELECT * FROM buyer_blocks WHERE buyer = ? ORDER BY id DESC',
    addr
  );
  return rows.map(blockDto);
}

/** 当前买家在本节点屏蔽的店铺编号集合（用于店铺目录过滤，不用于订单）。 */
export async function blockedShopCodes(buyer) {
  const addr = String(buyer || '').toLowerCase();
  if (!ADDRESS_RE.test(addr)) return new Set();
  const rows = await getDb().all(
    "SELECT target_value FROM buyer_blocks WHERE buyer = ? AND target_type = 'shop'",
    addr
  );
  return new Set(rows.map((r) => String(r.target_value)));
}

/** 当前买家在本节点屏蔽的卖家地址集合（seller 目标 + shop 目标所属店主）。 */
export async function blockedSellers(buyer) {
  const addr = String(buyer || '').toLowerCase();
  if (!ADDRESS_RE.test(addr)) return new Set();
  const rows = await getDb().all(
    `SELECT b.target_value AS value
       FROM buyer_blocks b
      WHERE b.buyer = ?
      UNION
     SELECT s.seller AS value
       FROM buyer_blocks b
       JOIN shops s ON s.code = b.shop_code
      WHERE b.buyer = ? AND b.target_type = 'shop'`,
    addr,
    addr
  );
  return new Set(rows.map((r) => String(r.value).toLowerCase()));
}

export async function addBuyerBlock({ buyer, targetType, target, reason } = {}) {
  const addr = String(buyer || '').toLowerCase();
  if (!ADDRESS_RE.test(addr)) return { error: '买家地址非法' };
  const type = String(targetType || '');
  if (type !== 'shop' && type !== 'seller') return { error: 'targetType 需为 shop / seller' };
  const raw = String(target || '').trim();
  const why = String(reason || '').trim().slice(0, 200);

  let shopCode = null;
  let value;
  if (type === 'shop') {
    value = String(raw ?? '').trim().toUpperCase();
    if (!isShopCodeShape(value)) return { error: '店铺编号非法' };
    const shop = await getDb().get('SELECT code FROM shops WHERE code = ?', value);
    if (!shop) return { error: '本节点没有这家店', notFound: true };
    shopCode = value;
  } else {
    value = raw.toLowerCase();
    if (!ADDRESS_RE.test(value)) return { error: '卖家地址非法' };
  }

  await getDb().run(
    `INSERT INTO buyer_blocks (buyer, target_type, target_value, shop_code, reason)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE reason = VALUES(reason), updated_at = CURRENT_TIMESTAMP(3)`,
    addr,
    type,
    value,
    shopCode,
    why
  );
  const row = await getDb().get(
    'SELECT * FROM buyer_blocks WHERE buyer = ? AND target_type = ? AND target_value = ?',
    addr,
    type,
    value
  );
  return { block: blockDto(row) };
}

export async function removeBuyerBlock({ buyer, id } = {}) {
  const addr = String(buyer || '').toLowerCase();
  const bid = Number(id);
  if (!ADDRESS_RE.test(addr)) return { error: '买家地址非法' };
  if (!Number.isSafeInteger(bid) || bid <= 0) return { error: '屏蔽 id 非法' };
  const changes = (await getDb().run('DELETE FROM buyer_blocks WHERE id = ? AND buyer = ?', bid, addr)).changes;
  return changes ? { removed: true } : { error: '没有这条屏蔽记录', notFound: true };
}
