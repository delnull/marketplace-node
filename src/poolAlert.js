/**
 * 池式商品「已收款但无货可交」主动告警（2026-09）。
 *
 * 问题：数字商品（码池 product_codes）与 NFT 商品（tokenId 池 product_nft_tokens）是
 * **下单不占位**的池式交付（无限量、下单时只锁价不锁资源），池子可能在「买家建草稿」与
 * 「链上托管落定」之间被别的订单掏空。此时买家已经付了钱、链上也已 OrderCreated，而卖家
 * 无从自动交付——此前只有卖家面板里的 `poolEmpty` 字段标着，**卖家不去看就不会知道**，
 * 而买家那边钱已经出去了。本模块在订单进入 escrowed 的那一刻主动推店主 webhook。
 *
 * 为什么要有这个模块而不是在 orders.js 里就地判断：
 *  - 判定口径（哪些商品算池式、需求量怎么算、池里可用量怎么读）必须与卖家面板的
 *    `poolEmpty` **完全一致**（见 poolShortfallOf），否则会出现"面板显示缺货但没告警"或反之；
 *  - 两条触发路径（paid 快路径与 watcher 事件回写）都要告警，只能有一份实现。
 *
 * 告警只发一次（kv 标记，键按本地订单 id，与 escrowWatcher 的 order.hold_missing 同款）：
 * 池子空了是持续状态，每轮轮询都推一次会把店主的机器人刷爆。
 * 但标记**只在投递成功后**才写（2026-09 修复，见 alertAck.js）：投递失败/未配置通知地址时
 * 不写标记，下一轮复查自然重试——"已收款却无货可交"这条必须至少送达一次。
 * payload 只含订单号/链上单号/原因——不含收货信息、买家地址（与 webhook.js 的隐私边界一致）。
 */
import { getDb } from './db.js';
import { notifyRaw } from './webhook.js';
import { alertOnceDelivered } from './alertAck.js';

/** 已告警标记的 kv 前缀（键 = 前缀 + 本地订单 id） */
const ALERT_KEY_PREFIX = 'mk:order_pool_empty:';

/**
 * 池式交付的缺口核算（**唯一实现**；卖家面板 poolEmpty 与主动告警共用）。
 * @param {object} order orders 行
 * @returns {{poolBacked:boolean, kind:'digital'|'nft'|null, need:number, available:number, short:boolean}}
 *  need：digital 一次性需 quantity 个；nft 按剩余需求 = quantity − 已交付行数（支持分批交付）。
 *  available：池内 status='unused' 的资源数（池式商品无限量，池即库存）。
 *  非 escrowed（未托管 / 已交付 / 已终局）或非池式商品时 poolBacked=false——此时无缺口语义。
 */
export function poolShortfallOf(order) {
  const none = { poolBacked: false, kind: null, need: 0, available: 0, short: false };
  if (!order) return none;
  let snap = {};
  try {
    snap = JSON.parse(order.product_snapshot || '{}');
  } catch {
    snap = {};
  }
  if (order.status !== 'escrowed' || (snap.kind !== 'digital' && snap.kind !== 'nft')) return none;
  const qty = order.quantity || 1;
  let need = qty;
  if (snap.kind === 'nft') {
    const delivered = getDb()
      .prepare("SELECT COUNT(*) AS c FROM order_delivery_items WHERE order_id = ? AND kind = 'nft'")
      .get(order.id).c;
    need = Math.max(0, qty - delivered);
    if (need === 0) return { poolBacked: true, kind: 'nft', need: 0, available: 0, short: false };
  }
  const table = snap.kind === 'digital' ? 'product_codes' : 'product_nft_tokens';
  const available = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE product_id = ? AND status = 'unused'`)
    .get(order.product_id).c;
  return { poolBacked: true, kind: snap.kind, need, available, short: available < need };
}

/** 卖家面板提示（订单列表/详情附加字段口径不变：池式且可用量不足需求） */
export function isPoolEmpty(order) {
  return poolShortfallOf(order).short;
}

/**
 * 托管落定后的池缺口告警（每个订单至多一次**成功投递**）。
 * 供两条路径调用：POST /:id/paid 快路径（提交后）与 escrowWatcher 的 OrderCreated 分支
 * （COMMIT 之后，见 applyEvent 的 afterCommit 约定——回滚了就不该告警）。
 * 不阻塞调用方：标记在投递结算的后台任务里写（见 alertAck.js），HTTP 响应不等店主服务器。
 * @param {string} idOrEscrowId 本地订单 id 或链上 escrow_order_id
 * @returns {boolean} 本次是否已发起告警（false = 已告警过 / 投递进行中 / 非缺货场景）
 */
export function alertPoolEmptyForOrder(idOrEscrowId) {
  const key = String(idOrEscrowId || '');
  if (!key) return false;
  const db = getDb();
  // 优先按本地 id 命中（paid 路径），其次按链上单号（watcher 路径）
  const order =
    db.prepare('SELECT * FROM orders WHERE id = ?').get(key) ||
    db.prepare('SELECT * FROM orders WHERE escrow_order_id = ?').get(key.toLowerCase());
  if (!order) return false;
  const s = poolShortfallOf(order);
  if (!s.short) return false; // 池子够（或已交付/已终局）：不是缺货告警场景
  try {
    const short = order.id.slice(0, 8);
    return alertOnceDelivered({
      ackKey: ALERT_KEY_PREFIX + order.id,
      label: '[poolAlert]',
      what: `（order=${short}…，缺货：可用 ${s.available} / 需 ${s.need}）`,
      send: () =>
        notifyRaw('order.pool_empty', {
          orderId: order.id,
          escrowOrderId: order.escrow_order_id || null,
          reason:
            `买家已托管付款，但该${s.kind === 'digital' ? '数字兑换码' : 'NFT tokenId'}池仅剩 ${s.available} 个可用资源、` +
            `本单仍需 ${s.need} 个——请立即补货（导入${s.kind === 'digital' ? '兑换码' : ' tokenId'}）或与买家协商退款，勿让订单悬置`,
        }),
    });
  } catch (e) {
    // 告警失败不影响订单状态（console 已留痕）；未写标记 ⇒ 下次复查会再试
    console.error(`[poolAlert] 缺货告警发送失败（order=${order.id.slice(0, 8)}…）:`, e?.message || e);
    return false;
  }
}

/** 仅供测试：清掉某单的已告警标记（不改业务语义，仅让用例可重复验证"只告警一次"） */
export function resetPoolAlertFlag(orderId) {
  try {
    getDb().prepare('DELETE FROM kv WHERE key = ?').run(ALERT_KEY_PREFIX + String(orderId || ''));
  } catch {
    /* 无库/无表时忽略 */
  }
}
