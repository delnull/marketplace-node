/**
 * 下单风控闸（order gate，2026-09 新增）：**可选、默认关闭**的建单前准入钩子。
 *
 * 为什么要它（"允许，不强制"）：本协议是联邦 + 刻意匿名的市场，节点**不做**身份核验——
 * 平台不该把 KYC/准入强加给任何店主。但一个恰好是持牌主体的运营方（或只是想给自己的店
 * 加一条黑名单/地域限制/限购/内部 KYC 的店主）此前没有任何"在门口拦一单"的手段：
 * 本地只有通用规则（限流/草稿上限/库存），没有"这一单卖不卖由我说了算"的点。
 * 于是形状定为：**店主自配一个 URL，节点在建单前问一句**——应答放行就照常建单，
 * 应答拒绝就不建单。默认不配 = 行为与从前一字不差（零开销、零网络）。
 *
 * 边界（必须在实现里守住，否则这个钩子会变成协议级的身份审查）：
 *  - 只存在于**运营方自己的**服务之间：节点不内置任何风控服务、不下发策略、不参与判定；
 *  - 数据最小化：只发订单的交易要素（商品/规格/数量/金额/买卖双方地址/时间），
 *    **永不**发收货人姓名/电话/地址/买家备注——见下方 payload 白名单；
 *  - 未配置 URL 时零开销（连函数体都不进），未开启风控的部署行为完全不变。
 *
 * fail-closed（刻意的取舍）：URL 一旦配置，风控服务不可达 / 超时 / 返回无法识别的应答
 * 一律**拒单**。理由：店主开风控的目的就是"拦住不该卖的单"，若服务挂了就静默放行，
 * 风控在最需要它的时刻（服务异常/被攻击/网络抖动）恰好失效，等于没开。
 * 代价是"风控服务一挂，全店下不了单"——这是店主自己选的可观测故障（启动日志会说明），
 * 逃生通道也很直白：**清空/删掉 MK_ORDER_GATE_URL** 即恢复"不过闸"的默认行为。
 *
 * 安全实现与 webhook 同款（复用 netguard + pinnedRequest）：
 *  - 目标地址**每次**校验（URL 是运维参数、可随时改），禁内网/回环/链路本地/云元数据段；
 *  - **校验的地址就是连接的地址**（2026-09 续）：默认发送器走 `postPinned`，把校验通过的那批地址
 *    钉进 socket 的 `lookup`——原先用 `fetch(url)` 会在连接阶段**再解析一次**，被控 DNS 可以先回
 *    公网 IP 过校验、再回 127.0.0.1/169.254.169.254（DNS rebinding），节点就成了对内网的盲 POST 源；
 *  - 不跟随重定向（node:http 本就不跟随）——3xx 视为失败（外站可 302 到内网端点，逐跳重校验
 *    复杂且难闭环）；
 *  - 超时（`postPinned` 内部定时器 + AbortController 双保险）；
 *  - 本模块**永不向调用方抛错**：任何异常都转成 { ok:false, reason } —— 下单路径只需看 ok。
 *  - 拒单必留痕（console.warn，含商品 slug 与原因）：店主要能从日志看出"为什么卖不出去"。
 */
import crypto from 'node:crypto';
import config from './config.js';
import { assertPublicHttpTarget } from './netguard.js';
import { postPinned } from './pinnedRequest.js';

let _sender = null; // 测试注入；null = 默认钉住发送器（与 webhook.setWebhookSender 同款注入点）
export function setOrderGateSender(fn) {
  _sender = fn;
}

/**
 * 默认发送器：钉住已校验地址 + 把响应体读回来（风控要读 `{"allow":…}` 应答）。
 * 形状与注入的 sender 一致（`(url, init) => { status, json()/text() }`），因此注入点不必知道
 * 底层是 fetch 还是 node:http。
 */
export async function pinnedGateSender(url, init = {}) {
  const r = await postPinned(url, {
    headers: init.headers,
    body: init.body,
    addresses: init.addresses,
    timeoutMs: init.timeoutMs,
    signal: init.signal,
    readBody: true,
  });
  return {
    status: r.status,
    text: async () => r.body ?? '',
    // 与 fetch 的 Response 同形：非 JSON 时**抛错**（orderGate.readJson 会捕获成 null ⇒ 按
    // "无法识别的应答"拒单），不要把解析失败悄悄变成一个空对象。
    json: async () => JSON.parse(r.body ?? ''),
  };
}

/** 仅供测试：还原注入的 sender（不碰配置——配置全在 env getter 里，测试自行恢复） */
export function resetOrderGate() {
  _sender = null;
}

/**
 * 风控闸是否开启：URL 非空且为 http(s)。
 * 只看"配了个地址"这一件事——非法 URL（拼错/少了 scheme）不算开启，否则会变成
 * "以为开了风控其实每次下单都被 fail-closed 拒掉"的静默故障。
 */
export function orderGateEnabled() {
  const url = config.orderGate.url;
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 读取 JSON 应答（非 JSON/空体/读取失败一律 null → 调用方按"无法识别的应答"拒单） */
async function readJson(res) {
  try {
    if (typeof res.json === 'function') return await res.json();
    if (typeof res.text === 'function') return JSON.parse(await res.text());
  } catch {
    return null;
  }
  return null;
}

/**
 * 建单前问一次店主的风控服务。
 *
 * @param {{buyer:string, seller:string, productSlug:string, skuKey?:string, quantity?:number,
 *          amountWei?:string, cnyFen?:number, shippingFeeCnyFen?:number, note?:string}} input
 * @returns {Promise<{ok:true} | {ok:false, reason:string}>}
 */
export async function checkOrderGate({
  buyer,
  seller,
  productSlug,
  skuKey,
  quantity,
  amountWei,
  cnyFen,
  shippingFeeCnyFen,
  note,
} = {}) {
  // 默认部署（未配置 URL）：直接放行，无网络、无日志、无状态
  if (!orderGateEnabled()) return { ok: true };
  /*
    note（买家给卖家的备注）在签名里被显式接收，但**不入 payload**：白名单在下面，
    由本模块（唯一实现）决定"发什么"，调用点无法"顺手"把 PII 带出去。
    void 只是把"刻意不用"写明白——将来谁想把它发出去，得先改这里的白名单，而不是改调用点。
  */
  void note;
  const slug = String(productSlug || '');
  /** 拒单统一出口：留痕 + 返回原因（文案面向买家，店主在日志里看同一条） */
  const deny = (reason) => {
    console.warn(`[orderGate] 下单被风控拒绝 productSlug=${slug || '?'} reason=${reason}`);
    return { ok: false, reason };
  };
  const url = config.orderGate.url;
  /*
    交易要素白名单（不是"展开整个订单对象"）：收货人姓名/电话/地址、买家备注、发票抬头/税号
    都是个人信息，风控服务不该拿到——一旦用展开写法，订单表加一列就会自动外泄一列。
    新增字段时**不需要**动这里，这正是白名单的意义（与 webhook.buildPayload 同一取舍）。
  */
  const payload = {
    event: 'order.gate',
    buyer,
    seller,
    productSlug: slug,
    skuKey,
    quantity,
    amountWei,
    cnyFen,
    shippingFeeCnyFen,
    at: Date.now(),
  };
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  const secret = config.orderGate.secret;
  if (secret) {
    headers['x-mk-signature'] = crypto.createHmac('sha256', secret).update(body).digest('hex');
  }
  const sender = _sender || pinnedGateSender;
  const timeoutMs = config.orderGate.timeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // SSRF 防护：与 webhook 同一套（协议/内网/回环/链路本地/云元数据，主机名按全量解析判定）。
    // 必须**每次**校验：URL 由运维配置、进程运行中可改，"配置时校验一次"挡不住后来指向内网。
    const target = await assertPublicHttpTarget(url);
    if (!target.ok) return deny(`风控目标校验未通过：${target.message}`);
    const res = await sender(url, {
      method: 'POST',
      headers,
      body,
      // 校验通过的地址交给发送器钉住（默认发送器会把它写进 socket 的 lookup）：
      // 这一步是"校验的地址 == 连接的地址"的接线点，缺了它就又退回"连接时再解析一次"。
      addresses: target.addresses,
      timeoutMs,
      signal: ctrl.signal,
      redirect: 'manual',
    });
    if (!res) return deny('风控服务无应答');
    // 3xx：重定向已禁用（见文件头）——单独给可行动的文案，避免店主以为是服务故障
    if (res.status >= 300 && res.status < 400) {
      return deny(`风控服务返回重定向 HTTP ${res.status}（重定向已禁用：请配置直达地址）`);
    }
    // 只有 200 是有效应答：204/5xx/网关页等一律拒单（fail-closed，不猜"可能也算通过"）
    if (res.status !== 200) {
      return deny(`风控服务返回 HTTP ${res.status}（仅接受 200 + JSON {"allow":true}）`);
    }
    const data = await readJson(res);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      // 含三种形态：体不是 JSON（网关错误页等）、JSON 但不是对象、对象为空——都算"无法识别"而拒单
      return deny(`风控服务应答非 JSON 对象（HTTP ${res.status}）`);
    }
    if (data.allow === true) return { ok: true };
    if (data.allow === false) {
      // 店主提供的理由原样透传给买家（便于买家自己联系店主复核），空/非字符串回退通用文案
      const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 200) : '';
      return deny(reason || '本店暂不销售该订单');
    }
    return deny(`风控服务应答无法识别（HTTP ${res.status}：allow 字段缺失或非布尔值）`);
  } catch (e) {
    /*
      fail-closed：网络/超时/校验异常都判"不可达"→ 拒单（见文件头取舍）。
      拒单文案要能区分超时与连接失败，运维据此排查是风控服务慢还是根本没起来。
    */
    if (e?.name === 'AbortError') return deny(`风控服务不可达（请求超时 > ${timeoutMs}ms）`);
    return deny(`风控服务不可达（${String((e && e.message) || e)}）`);
  } finally {
    clearTimeout(timer);
  }
}
