/**
 * 卖家通知（P0-3）：订单关键事件 webhook（店主自接机器人/IM/邮件网关）。
 *
 * 设计：
 *  - URL/签名密钥为经营参数：存 `shop_webhook`（**一行一店**），卖家面板「店铺设置-通知配置」
 *    网页维护，每次投递前动态读取（即改即生效）；
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
import { getDb } from './db.js';
import { assertPublicHttpTarget } from './netguard.js';
import { postPinned } from './pinnedRequest.js';

/**
 * 某店的通知配置（未配置返回 { url: '', secret: '' }）。
 *
 * `shop_webhook` 的主键就是 `shop_code`（外键指向 `shops(code)`），所以"一行一店"是**列约束**，
 * 不是调用方的纪律：旧形状把 url/secret 放在 kv 的两个键里（`shop:<编号>:webhook_url` / `:secret`），
 * 于是"读的键"与"写的键"可以各自演化成两种形状——而那种不一致的症状是
 * **通知静默停发、日志里一个字都没有**。现在键只可能是店铺编号本身。
 */
export async function webhookConfig(shopCode) {
  const code = String(shopCode || '');
  if (!code) return { url: '', secret: '' };
  const row = await getDb().get('SELECT url, secret FROM shop_webhook WHERE shop_code = ?', code);
  return row ? { url: row.url || '', secret: row.secret || '' } : { url: '', secret: '' };
}

/**
 * 写某店的通知配置（**唯一写入点**）。
 *
 * 两项**同一条语句**落库（`INSERT … ON DUPLICATE KEY UPDATE`）：旧形状是"两个 kv 键各写一次"，
 * 于是并发的一次"换 URL"与一次"换密钥"会各写一半，落成一对谁也没配过的组合。
 * 一条语句之后，"半套配置"在形状上不可表达——要么是这一次给的这一对，要么还是原来那一对。
 *
 * 调用方（`PUT /api/shop/webhook`）负责把"只改其中一项"合并成完整的一对再传进来：
 * 那两个值来自同一次事务内的读-改-写（见 routes/shop.js）。
 */
export async function setWebhookConfig(shopCode, { url, secret }) {
  await getDb().run(
    `INSERT INTO shop_webhook (shop_code, url, secret, updated_at) VALUES (?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE url = new.url, secret = new.secret, updated_at = new.updated_at`,
    String(shopCode || ''),
    String(url ?? ''),
    String(secret ?? ''),
    new Date()
  );
}

/**
 * 事件 → 最小 payload（不含隐私字段）；ref 可为**对外订单号**（`order_no`）或链上 `escrow_order_id`。
 * 内部自增键（`orders.id`）不是对外标识，这里刻意不认（见 notify 的说明）。
 */
async function buildPayload(type, ref) {
  const key = String(ref || '');
  const db = getDb();
  let row = await db.get('SELECT * FROM v_orders WHERE order_no = ?', key);
  if (!row) row = await db.get('SELECT * FROM v_orders WHERE escrow_order_id = ?', key.toLowerCase());
  if (!row) return null;
  /*
    字段逐项白名单（不是"整行减几个键"）：订单的收货信息三列 / note / invoice 三列都在
    `order_shipping`（读模型视图把它们暴露成 shipping_*），payload 一旦改用展开写法
    就会把它们成批送出去。新增列时**不需要**动这里，这正是白名单的意义——但要记得：
    加法在这里是刻意的遗漏（发票抬头/税号属个人信息，需要开票信息的店主应到面板/订单详情查看，
    而不是让它进 webhook 日志）。
    金额口径：amountWei = 商品 + 运费（运费按单收取一次，见 routes/orders.js）。
    时间口径：`at` 是 ISO-8601 字符串——接收端拿到的是一个**没有歧义的时刻**（旧形状给毫秒整数，
    而"这个数到底是秒还是毫秒"要靠约定去猜）。
  */
  return {
    eventId: crypto.randomUUID(), // 幂等键：接收方按 eventId 去重（重试可能重复投递）
    type,
    // 哪一家店的事件：接收端可能是多店共用一个机器人，必须能分辨（它同时是投递目标的选择键）
    shopCode: row.shop_code || '',
    /*
      ⚠️ 键名仍是 `orderId`（接收端契约不动），但**值是 `order_no`**（对外单号，CHAR(21)）——
      旧形状给的是本地自增 id。这两者长得完全不同（`B…`  vs 纯数字），接收端若按数字解析
      会在第一时间现形，而不是静默错单。内部自增键不出本节点（见 db.js 的读模型说明）。
    */
    orderId: row.order_no,
    escrowOrderId: row.escrow_order_id || null,
    productSlug: row.product_slug,
    quantity: row.quantity || 1,
    amountWei: row.amount_wei,
    paymentToken: row.payment_token || null,
    paymentSymbol: row.payment_symbol || null,
    paymentDecimals: row.payment_decimals ?? null,
    paymentRateSource: row.payment_rate_source || null,
    paymentRateStale: !!row.payment_rate_stale,
    tokenUsdtMicroPerToken: row.token_usdt_micro_per_token ?? null,
    paymentRateQuotedAt: row.payment_rate_quoted_at || null,
    status: row.status,
    refundStatus: row.refund_status || 'none',
    at: new Date(),
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

async function sendOnce(url, payload, shopCode) {
  const body = JSON.stringify(payload);
  /*
    只投 https：HMAC 能防篡改，但防不了明文链路上的窃听/重放组合；公开 http 端点让
    “签名正确”变成一句在攻击者面前成立的话。测试里的回环 http 会在下面 SSRF 前就失败。
  */
  if (new URL(url).protocol !== 'https:') throw new Error('webhook 只支持 https 目标');
  const headers = { 'content-type': 'application/json' };
  const { secret } = await webhookConfig(shopCode);
  if (secret) {
    /*
      时间戳进入签名原文（`timestamp.body`）。只签 body 时，攻击者拿到一条合法请求可以
      原样重放任意次；接收方用 `X-Mk-Timestamp` 做窗口校验（±5 分钟）即可拒绝旧包。
    */
    const ts = String(Math.floor(Date.now() / 1000));
    headers['x-mk-timestamp'] = ts;
    headers['x-mk-signature'] = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  }
  // SSRF 防护（2026-09 修复）：URL 是店主随时可改的经营参数（`shop_webhook.url`），
  // 必须在每次投递前校验目标
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
      const err = new Error(`HTTP ${res.status}（重定向已禁用：请配置直达地址，勿依赖 3xx 跳转）`);
      err.status = Number(res.status);
      throw err;
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
    if (!(status >= 200 && status < 300)) {
      // 把**实际状态码**挂到错误上：投递日志要记它（不是恒记 200/null），排障时也能区分 4xx/5xx
      const err = new Error(`HTTP ${res.status}`);
      err.status = status;
      throw err;
    }
    // 实际状态码交给调用方记录（200/201/204 都是成功；投递日志不虚构 200）
    return { status };
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
 *
 * `at` 用 `Date`（对外 JSON 是 ISO-8601）：这是**时间读数**，与库里那些列的形态保持一致——
 * 同一份响应里出现两种时间表示（毫秒整数 + ISO）是前端最容易读错的一类形状。
 */
const DELIVERY_LOG_MAX = 20;
/** @type {{ at:Date, type:string, ok:boolean, status:number|null, error:string|null, label:string, shopCode:string }[]} */
const deliveries = [];

function recordDelivery(entry) {
  deliveries.unshift(entry);
  if (deliveries.length > DELIVERY_LOG_MAX) deliveries.length = DELIVERY_LOG_MAX;
}

/**
 * 最近投递记录（最新在前）+ 汇总；未配置 URL 时 recent 为空。
 * **按店铺过滤**：投递日志是"我这家的机器人收到没有"，别家的投递记录不该出现在这里
 * （它带别家的单号与金额）。
 */
export async function webhookStatus(shopCode = '') {
  const code = String(shopCode || '');
  const { url, secret } = await webhookConfig(code);
  const mine = deliveries.filter((d) => String(d.shopCode || '') === code);
  const last = mine[0] || null;
  return {
    url,
    hasSecret: !!secret,
    configured: !!url,
    last,
    recent: mine.slice(0, 10),
    okCount: mine.filter((d) => d.ok).length,
    failCount: mine.filter((d) => !d.ok).length,
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
const errorStatus = (e) => (Number.isInteger(e?.status) ? e.status : null);

/**
 * 投递失败留痕的**唯一收口**：同步段异常 / 重试耗尽 / 未配置地址都走这里，且自己绝不抛错
 * （投递是 fire-and-forget 的旁路，任何一个异常都不该升级成进程级 unhandledRejection）。
 */
function recordDeliveryFailure(payload, label, e) {
  const msg = String(e?.message || e);
  try {
    recordDelivery({
      at: new Date(),
      type: payload?.type || '',
      shopCode: payload?.shopCode || '',
      ok: false,
      status: errorStatus(e),
      error: msg,
      label,
    });
  } catch {
    /* 记录失败不得反过来弄挂调用方 */
  }
  console.error(`[webhook] 通知失败 type=${payload?.type || '?'} ${label}:`, msg);
  return false;
}

/**
 * 通用投递内核（fire-and-forget + 重试 2 次；SSRF 防护/禁重定向/地址钉死在 sendOnce 内）。
 *
 * **永不 reject**（2026-10-18 修）：最外层的 `try/catch` 覆盖同步段（读通知配置碰库——
 * DB 连接池超时会直接 reject）与重试链；失败一律记入投递日志并 resolve(false)。
 * 调用方（watcher/sync/告警）大量是 `void notify(...)`/不 await 的 fire-and-forget，
 * 而 `shutdown.js` 把任何 unhandledRejection 当致命错误 `exit(1)`——一次 DB 抖动就能
 * 因为"通知发不出去"把整台节点停掉这条路径必须从源头消失。
 *
 * 返回 `Promise<boolean>`：最终结算（成功 true；未配置 URL / 重试耗尽 false）。
 * 调用方若需要"投递成功后才做某事"（写一次性告警的幂等标记，见 alertAck.js）靠这个 Promise。
 */
async function deliver(payload, label) {
  try {
    const { url } = await webhookConfig(payload?.shopCode);
    if (!url) return false;
    return await new Promise((resolve) => {
      let attempts = 0;
      const run = () => {
        sendOnce(url, payload, payload?.shopCode)
          .then((res) => {
            recordDelivery({
              at: new Date(),
              type: payload.type,
              shopCode: payload.shopCode || '',
              ok: true,
              status: Number(res?.status) || null, // 实际状态码（不再硬编码 200）
              error: null,
              label,
            });
            resolve(true);
          })
          .catch((e) => {
            attempts += 1;
            if (attempts <= 2) {
              const delay = config.webhook.retryBaseMs * (attempts === 1 ? 1 : 5);
              setTimeout(run, delay);
            } else {
              recordDeliveryFailure(payload, label, e);
              resolve(false);
            }
          });
      };
      run();
    });
  } catch (e) {
    return recordDeliveryFailure(payload, label, e);
  }
}

/**
 * 测试事件投递（设置页「发送测试事件」用）：**同步等结果**，好把失败原因直接显示出来。
 * 与正式通知走完全相同的 SSRF 校验/签名/超时逻辑，所以"测试通过"能代表真实投递可达。
 * @returns {Promise<{ok:boolean, error:string|null, status:number|null}>}
 */
export async function sendTestEvent(shopCode = '') {
  const code = String(shopCode || '');
  const { url } = await webhookConfig(code);
  if (!url) return { ok: false, status: null, error: '尚未配置通知地址' };
  const payload = { eventId: crypto.randomUUID(), type: 'webhook.test', shopCode: code, at: new Date() };
  try {
    const { status } = await sendOnce(url, payload, code);
    // 实际状态码（200/201/204 都算成功）——设置页显示的就是接收端的真实回答
    recordDelivery({ at: new Date(), type: payload.type, shopCode: code, ok: true, status: Number(status) || null, error: null, label: 'test' });
    return { ok: true, status: Number(status) || null, error: null };
  } catch (e) {
    const msg = String(e.message || e);
    const status = errorStatus(e);
    recordDelivery({ at: new Date(), type: payload.type, shopCode: code, ok: false, status, error: msg, label: 'test' });
    return { ok: false, status, error: msg };
  }
}

/**
 * 通知入口（调用方在状态迁移成功后调用；幂等性由调用方"仅成功后触发"保证）。
 * fire-and-forget：不阻塞主流程；未配置 URL 时零开销（配置动态读取）。
 *
 * ⚠️ `orderRef` 只认两种拼写：**对外订单号 `order_no`** 或**链上托管单号 `escrow_order_id`**。
 * 内部自增键（`orders.id`）刻意不接受——它不出本节点，而"哪个键是哪个"在这里猜错的症状是
 * **通知静默不发**（`buildPayload` 查不到就返回 null，投递被当成"没有可投递的内容"）。
 * @returns {Promise<boolean>} 投递最终结算结果（见 deliver；忽略返回值的调用点行为不变）
 */
export async function notify(type, orderRef) {
  try {
    const payload = await buildPayload(type, orderRef);
    if (!payload) return false; // 本地查不到该单：没有可投递的内容，视同未投递
    return await deliver(payload, `order=${orderRef}`);
  } catch (e) {
    /*
      `buildPayload` 也会碰库（读 v_orders）：DB 超时等异常不能变成一个 unhandledRejection
      （调用点几乎都是 fire-and-forget）。记一条失败留痕，返回 false。
    */
    return recordDeliveryFailure({ type, shopCode: '' }, `order=${orderRef}`, e);
  }
}

/**
 * 通用事件通知（2026-09 新增）：非订单事件（如店主登录告警）的最小 payload 投递——
 * 与订单通知同构：{ eventId, type, ...data, at }，走同一套 SSRF 防护/签名/重试。
 * @param {string} type 事件类型（如 'auth.owner_login'）
 * @param {object} data 附加字段（调用方自行控制隐私边界；勿放收货地址/码原文）
 * @returns {Promise<boolean>} 投递最终结算结果（未配置 URL / 重试耗尽 = false）
 */
export async function notifyRaw(type, data = {}) {
  const payload = { eventId: crypto.randomUUID(), type, ...data, at: new Date() };
  try {
    return await deliver(payload, type);
  } catch (e) {
    // deliver 已自己收口；这里是最后一道：任何实现失误都不得把异常抛给 fire-and-forget 调用方
    return recordDeliveryFailure(payload, type, e);
  }
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
/**
 * 结算类事件（`Arbitrated` / `RefundApproved`）的通知类型：**从退款额与托管额推导**，
 * 与本地终态（`settleByRefundSplit` / `mapChainTerminal`）用同一组语义：
 *   · refundWei == 0                ⇒ 全额判卖家 ⇒ `order.settled`
 *   · 0 < refundWei < amount        ⇒ 拆分结算（买家拿回一部分，余额给卖家）⇒ 本地是 settled，
 *                                      所以通知也用 `order.settled`（P3-5：旧实现把它映射成
 *                                      `order.refunded`，而 payload 里的 status 是 settled——
 *                                      类型与状态互相矛盾，接收端无法按类型分流）
 *   · refundWei >= amount           ⇒ 全额退款（链上 Refunded）⇒ `order.refunded`
 * 读不到金额（amount 缺失/畸形）⇒ **null = 不猜、不通知**：一个错误的类型比一条迟到的通知更糟。
 */
function refundSplitEventType(refundWeiArg, amountWeiArg) {
  if (refundWeiArg === undefined || refundWeiArg === null) return null;
  let refundWei;
  let amount;
  try {
    refundWei = BigInt(refundWeiArg);
  } catch {
    return null;
  }
  try {
    amount = amountWeiArg === undefined || amountWeiArg === null ? null : BigInt(amountWeiArg);
  } catch {
    return null;
  }
  if (refundWei === 0n) return 'order.settled';
  if (amount === null || amount <= 0n) return null;
  return refundWei >= amount ? 'order.refunded' : 'order.settled';
}

/**
 * @param {string} name 链上事件名
 * @param {object} args 事件参数
 * @param {{amountWei?: string|number|bigint}} [context] 本单托管额（结算类事件用来区分
 *   "全额退款"与"拆分结算"——事件本身只带 refundWei，不含 amount）
 */
export function typeForChainEvent(name, args = {}, { amountWei } = {}) {
  switch (name) {
    case 'OrderCreated':
      return 'order.escrowed';
    case 'ReceiptConfirmed':
      return 'order.confirmed';
    case 'DisputeRequested':
      return 'order.disputed';
    case 'OrderExpiredReleased':
      return 'order.expired';
    /*
      裁决/卖家同意退款：事件只带退款额，必须结合本单托管额才能分清"全额退款"与"拆分"。
      `0` 与"全额"是两种确证语义，`0 < refund < amount` 是结算向的部分退款（本地 settled）。
    */
    case 'Arbitrated':
    case 'RefundApproved':
      return refundSplitEventType(args?.refundWei, amountWei);
    case 'RefundRequested':
      return 'refund.requested';
    case 'RefundRejected':
      return 'refund.rejected';
    /*
      确认收货后的售后案件（契约 2026-10 第二批）：**必须通知店主**——它不是"什么都没发生"的事件。
      买家在确认收货之后开案，意味着这笔仍在售后留存期的货款可能被判给买家，不足部分还可能
      从**卖家保证金**补足（Staking.penalize 的资格门槛正是"本案在链上处于开启状态"），店主需要知道并去处理
      （线下换货/转账和解，或等仲裁）。与 PartialRefundAccepted 的区别正在于此：那个只是挂一个
      可选数字，这个改变的是"店主必须处理的事"。
      结案同样通知：案件从"可能被罚没"变成"已了结"，店主面板上的待办要能收敛。
      payload 走 buildPayload 的字段白名单（不含结案说明与收货信息），说明请到订单详情看。
    */
    case 'AfterSaleOpened':
      return 'order.after_sale_opened';
    case 'AfterSaleClosed':
      return 'order.after_sale_closed';
    default:
      return null;
  }
}
