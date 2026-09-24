/**
 * 卖家通知（P0-3）：订单关键事件 webhook（店主自接机器人/IM/邮件网关）。
 *
 * 设计（见 docs/ARCHITECTURE.md §3.1.1 与 DECISIONS.md）：
 *  - URL/签名密钥为经营参数：存 kv，卖家面板「店铺设置-通知配置」网页维护，动态读取即改即生效；
 *  - payload 最小化：**不含收货地址/交付码/NFT tokenId/买家完整地址**（隐私边界与公开列表一致）；
 *  - 本地状态迁移成功后触发（watcher 事件与本地动作两个挂载点，不推中间态）；
 *  - fire-and-forget + 内存重试（2 次，退避 MK_WEBHOOK_RETRY_MS×[1,5]）；最终失败 console.error
 *    （不落盘持久化——一期取舍，订单事件史可对账）；
 *  - deliver 返回 `Promise<boolean>`（**最终结算**时 resolve：成功 true / 重试耗尽 false /
 *    未配置 URL false）：调用方若需要"投递成功后才做某事"（如写一次性告警的幂等标记，
 *    见 alertAck.js），靠这个 Promise，而不是猜投递结果；
 *  - setWebhookSender 供测试注入捕获；默认实现是 pinnedRequest.postPinned——
 *    校验拿到的地址被钉进 socket lookup（2026-09 修复 DNS rebinding 窗口），超时 MK_WEBHOOK_TIMEOUT_MS。
 */
import crypto from 'node:crypto';
import config from './config.js';
import { getDb, kvGet } from './db.js';
import { assertPublicHttpTarget } from './netguard.js';
import { postPinned } from './pinnedRequest.js';

const KV_WEBHOOK_URL = 'mk:webhook_url';
const KV_WEBHOOK_SECRET = 'mk:webhook_secret';

/** 通知配置动态读取（kv；未配置返回 { url: '', secret: '' }） */
export function webhookConfig() {
  return { url: kvGet(KV_WEBHOOK_URL) || '', secret: kvGet(KV_WEBHOOK_SECRET) || '' };
}

/** 事件 → 最小 payload（不含隐私字段）；ref 可为本地订单 id 或链上 escrow_order_id */
function buildPayload(type, ref) {
  const key = String(ref || '');
  const db = getDb();
  let row = db.prepare('SELECT * FROM orders WHERE id = ?').get(key);
  if (!row) row = db.prepare('SELECT * FROM orders WHERE escrow_order_id = ?').get(key.toLowerCase());
  if (!row) return null;
  /*
    字段逐项白名单（不是"整行减几个键"）：订单表现有 shipping 三列 / note / age_ack /
    invoice 三列等个人信息列，payload 一旦改用展开写法就会把它们成批送出去。新增列时
    **不需要**动这里，这正是白名单的意义——但要记得：加法在这里是刻意的遗漏
    （发票抬头/税号属个人信息，需要开票信息的店主应到面板/订单详情查看，而不是让它进 webhook 日志）。
    金额口径：amountWei = 商品 + 运费（运费按单收取一次，见 routes/orders.js）。
  */
  return {
    eventId: crypto.randomUUID(), // 幂等键：接收方按 eventId 去重（重试可能重复投递）
    type,
    orderId: row.id,
    escrowOrderId: row.escrow_order_id || null,
    productSlug: row.product_slug,
    quantity: row.quantity || 1,
    amountWei: row.amount_wei,
    status: row.status,
    refundStatus: row.refund_status || 'none',
    at: Date.now(),
  };
}

/**
 * 发送器注入点（测试用；null = 默认的钉住请求实现，见 pinnedSender）。
 * 注入的发送器签名与默认实现一致：`(url, init) => Promise<{ ok?: boolean; status: number }>`；
 * `init` 里带着本次校验通过的 `addresses`（默认实现据此钉住连接目标）与 `signal`/`timeoutMs`。
 */
let _sender = null;
export function setWebhookSender(fn) {
  _sender = fn;
}

/**
 * 默认发送器 = 钉住请求实现（postPinned）：只连 sendOnce 刚校验过的那批地址。
 * 单独具名导出，是为了让"默认路径确实走钉住实现"这件事本身可被测试——否则把它改回
 * `fetch(url)` 这类回归在 SSRF 守卫存在时无法端到端复现（回环/内网地址在守卫处就被拒了，
 * 测不到"连接阶段又解析了一次"这一步）。
 */
export function pinnedSender(url, init) {
  return postPinned(url, init);
}

async function sendOnce(url, payload) {
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  const { secret } = webhookConfig();
  if (secret) {
    headers['x-mk-signature'] = crypto.createHmac('sha256', secret).update(body).digest('hex');
  }
  // SSRF 防护（2026-09 修复）：URL 存 kv、随时可变，必须在每次投递前校验目标
  // （协议/内网/回环/链路本地/云元数据段，主机名按全量解析结果判定）；
  // redirect:'manual'——禁止跟随重定向（外部 https 可 302 到内网端点，逐跳重校验
  // 复杂且难闭环，直接拒绝 3xx 由店主改用直达地址）
  const target = await assertPublicHttpTarget(url);
  if (!target.ok) throw new Error(`webhook 目标校验未通过：${target.message}`);
  const sender = _sender || pinnedSender;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.webhook.timeoutMs);
  try {
    /*
      addresses：本次校验通过的**字面量地址**。默认发送器只连这些地址（socket lookup 被换掉），
      校验与连接之间不再解析——没这道钉死，被控 DNS 就能在第二次解析时把连接换到 127.0.0.1/
      169.254.169.254（云元数据），SSRF 校验形同虚设。Host 头与 TLS SNI 仍在 pinnedRequest 内
      按原主机名设置（钉住的是 IP，不是身份）。
    */
    const res = await sender(url, {
      method: 'POST',
      headers,
      body,
      signal: ctrl.signal,
      redirect: 'manual',
      timeoutMs: config.webhook.timeoutMs,
      addresses: target.addresses,
    });
    if (!res) throw new Error('no-response');
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`HTTP ${res.status}（重定向已禁用：请配置直达地址，勿依赖 3xx 跳转）`);
    }
    /*
      按**状态码**判定成败，不用 `res.ok`（源码审计 2026-09 复审，P1）。
      默认发送器是钉住实现 `postPinned`，它只结算 `{ status }`（见 pinnedRequest.js）——
      没有 `ok` 字段，于是 `!res.ok` 对**任何**响应都为真：真实 HTTP 200 也被判失败。
      后果是一整条通知链静默失效：① 每次通知都要重试 2 次、白等约 1.2s 才 resolve(false)；
      ② `alertAck` 只在投递结算为 true 时写幂等标记，于是 `order.pool_empty` /
      `order.hold_missing` / `order.chain_missing` / `order.chain_repaired` **永不写标记、
      每轮无限重发**；③ 设置页「发送测试事件」永远显示失败（假故障）。
      单测此前全部通过 `setWebhookSender` 注入 `{ok:true}`，永远走不到默认路径，所以没被发现。
    */
    const status = Number(res.status);
    if (!(status >= 200 && status < 300)) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 投递结果留痕（**店主可见**）。
 *
 * 原来投递失败只 `console.error`：店主在设置页看到「保存即生效」，却不知道自己的
 * 机器人到底收没收到——URL 写错、内网被 SSRF 拦下、签名密钥不匹配，全都静默失败。
 * 这里记录最近若干次的**结果**（不含 payload 正文，避免把订单内容写进状态里），
 * 由 `GET /api/shop/webhook-status` 暴露给设置页；内存态、进程重启即清空
 * （只用于"最近一次到底成没成"，不是审计日志——审计走 audit_log）。
 */
const DELIVERY_LOG_MAX = 20;
/** @type {{ at:number, type:string, ok:boolean, status:number|null, error:string|null, label:string }[]} */
const deliveries = [];

function recordDelivery(entry) {
  deliveries.unshift(entry);
  if (deliveries.length > DELIVERY_LOG_MAX) deliveries.length = DELIVERY_LOG_MAX;
}

/** 最近投递记录（最新在前）+ 汇总；未配置 URL 时 recent 为空 */
export function webhookStatus() {
  const { url, secret } = webhookConfig();
  const last = deliveries[0] || null;
  return {
    url,
    hasSecret: !!secret,
    configured: !!url,
    last,
    recent: deliveries.slice(0, 10),
    okCount: deliveries.filter((d) => d.ok).length,
    failCount: deliveries.filter((d) => !d.ok).length,
  };
}

/** 仅供测试：清空投递记录 */
export function resetWebhookStatus() {
  deliveries.length = 0;
}

/**
 * 通用投递内核（fire-and-forget + 重试 2 次；SSRF 防护/禁重定向/地址钉死在 sendOnce 内）。
 *
 * 返回 `Promise<boolean>`：**最终结算**时 resolve（成功 true；重试耗尽 false；
 * 未配置 URL 也 false）。调用方仍可不理它（fire-and-forget 语义不变），但需要"投递成功
 * 才落幂等标记"的告警路径（poolAlert / chainReconcile / escrowWatcher 的 hold_missing）
 * 必须依赖它——否则投递失败也会把标记写死，店主永远收不到"钱已收、货发不出"这类告警。
 * 未配置 URL 返回 false 而不是 true：标记不写，店主以后配好 webhook 还能收到这条历史告警。
 */
function deliver(payload, label) {
  const { url } = webhookConfig();
  if (!url) return Promise.resolve(false);
  return new Promise((resolve) => {
    let attempts = 0;
    const run = () => {
      sendOnce(url, payload)
        .then(() => {
          recordDelivery({ at: Date.now(), type: payload.type, ok: true, status: 200, error: null, label });
          resolve(true);
        })
        .catch((e) => {
          attempts += 1;
          if (attempts <= 2) {
            const delay = config.webhook.retryBaseMs * (attempts === 1 ? 1 : 5);
            setTimeout(run, delay);
          } else {
            const msg = String(e.message || e);
            recordDelivery({ at: Date.now(), type: payload.type, ok: false, status: null, error: msg, label });
            console.error(`[webhook] 通知失败（已重试 2 次）type=${payload.type} ${label}:`, msg);
            resolve(false);
          }
        });
    };
    run();
  });
}

/**
 * 测试事件投递（设置页「发送测试事件」用）：**同步等结果**，好把失败原因直接显示出来。
 * 与正式通知走完全相同的 SSRF 校验/签名/超时逻辑，所以"测试通过"能代表真实投递可达。
 * @returns {Promise<{ok:boolean, error:string|null, status:number|null}>}
 */
export async function sendTestEvent() {
  const { url } = webhookConfig();
  if (!url) return { ok: false, status: null, error: '尚未配置通知地址' };
  const payload = { eventId: crypto.randomUUID(), type: 'webhook.test', at: Date.now() };
  try {
    await sendOnce(url, payload);
    recordDelivery({ at: Date.now(), type: payload.type, ok: true, status: 200, error: null, label: 'test' });
    return { ok: true, status: 200, error: null };
  } catch (e) {
    const msg = String(e.message || e);
    recordDelivery({ at: Date.now(), type: payload.type, ok: false, status: null, error: msg, label: 'test' });
    return { ok: false, status: null, error: msg };
  }
}

/**
 * 通知入口（调用方在状态迁移成功后调用；幂等性由调用方"仅成功后触发"保证）。
 * fire-and-forget：不阻塞主流程；未配置 URL 时零开销（配置动态读取）。
 * @returns {Promise<boolean>} 投递最终结算结果（见 deliver；忽略返回值的调用点行为不变）
 */
export function notify(type, orderId) {
  const payload = buildPayload(type, orderId);
  if (!payload) return Promise.resolve(false); // 本地查不到该单：没有可投递的内容，视同未投递
  return deliver(payload, `order=${orderId}`);
}

/**
 * 通用事件通知（2026-09 新增）：非订单事件（如店主登录告警）的最小 payload 投递——
 * 与订单通知同构：{ eventId, type, ...data, at }，走同一套 SSRF 防护/签名/重试。
 * @param {string} type 事件类型（如 'auth.owner_login'）
 * @param {object} data 附加字段（调用方自行控制隐私边界；勿放收货地址/码原文）
 * @returns {Promise<boolean>} 投递最终结算结果（未配置 URL / 重试耗尽 = false）
 */
export function notifyRaw(type, data = {}) {
  return deliver({ eventId: crypto.randomUUID(), type, ...data, at: Date.now() }, type);
}

/**
 * 链上事件名 → 通知类型（escrowWatcher 迁移成功后调用）。
 *
 * 刻意**不映射** `PartialRefundAccepted`（买家对具体金额的部分退款授权，契约 2026-09 新增）：
 * 它不是状态通知——订单状态、资金、售后标记一个都没动（授权不转移资金、不冻结订单），
 * 店主不需要为此收到一次"什么都没发生"的告警；授权额由订单详情的
 * `acceptedPartialRefundWei/Decimal` 如实下发（面板按需读，不必推送）。
 * 与 RefundRequested/RefundRejected 的区别：那两者会改变店主**必须处理**的事（冻结/解锁争议资格），
 * 授权额只是挂在单上的一个可选数字。
 */
export function typeForChainEvent(name, args = {}) {
  switch (name) {
    case 'OrderCreated':
      return 'order.escrowed';
    case 'ReceiptConfirmed':
      return 'order.confirmed';
    case 'DisputeRequested':
      return 'order.disputed';
    case 'OrderExpiredReleased':
      return 'order.expired';
    case 'Arbitrated':
      // refundWei=0 全额判卖家；>0 时买家已拿回一部分（含全额退款）——通知语义按「是否退到钱」分派
      return Number(args.refundWei || 0) > 0 ? 'order.refunded' : 'order.settled';
    case 'RefundRequested':
      return 'refund.requested';
    case 'RefundRejected':
      return 'refund.rejected';
    case 'RefundApproved':
      return 'order.refunded';
    default:
      return null;
  }
}
