/**
 * 「地址钉死」（connection pinning）的出站 POST（2026-09 修复 DNS rebinding 窗口）。
 *
 * 问题：店主 webhook 的投递原来是 `await assertPublicHttpTarget(url)` → `fetch(url)`。
 * 校验（第一次解析）与连接（fetch 内部**再解析一次**）之间隔着一次可控的解析机会：
 * 被控/恶意 DNS 第一次返回公网 IP 通过校验，第二次返回 127.0.0.1 或 169.254.169.254，
 * 节点就成了对内网与云元数据的盲 POST 源——校验的地址 ≠ 连接的地址。
 *
 * 修法：校验函数把**通过校验的那批地址**交回来（netguard.assertPublicHttpTarget 的
 * `addresses`），这里用 node:http / node:https 直接发请求，并把 socket 的 `lookup` 换成一个
 * **只回答这批字面量**的函数——DNS 在连接阶段不再被咨询，第二次解析没有发生的机会。
 * 其余口径与原来一致：
 *  - `Host` 头仍是**原主机名**（含端口），https 的 SNI `servername` 同样是原主机名：
 *    钉住的是"连到哪个 IP"，不是"以谁的名义请求"（虚拟主机/证书校验都必须照旧）；
 *  - 超时（`timeoutMs`，webhook 传 config.webhook.timeoutMs）到点即销毁请求并报错；
 *  - **不跟随重定向**：node:http 本就不跟随，3xx 只作为状态码返回，由调用方按失败处理
 *    （与原先 `redirect:'manual'` + 显式拒绝 3xx 的语义一致）。
 *
 * 无已校验地址时**拒绝发请求**（fail-closed）：没有钉住地址就没有"校验过的目标"，
 * 此时宁可失败也不能退回"让系统再解析一次"。
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/** 钉住 lookup：只回答给定字面量地址，永不咨询 DNS */
function pinnedLookup(addresses) {
  const entries = addresses.map((address) => ({ address, family: net.isIP(address) }));
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options || {};
    // family 提示（4/6）优先，但只在校验过的地址里有该族时才用（绝不因此新解析）
    const want = opts.family === 4 || opts.family === 6 ? entries.filter((e) => e.family === opts.family) : [];
    const list = want.length ? want : entries;
    /*
      node:net 在 autoSelectFamily（Node ≥ 20 默认开）下会带 `all: true` 询问全部候选，
      此时回调必须是数组形态；否则是 (err, address, family) 单值形态。两种都要答对，
      否则 socket 会退回到系统解析器——那正是本模块要消灭的那次解析。
    */
    if (opts.all) {
      cb(null, list);
      return;
    }
    cb(null, list[0].address, list[0].family);
  };
}

/**
 * 钉住地址的 POST（只发一次，不重试、不跟随重定向；重试由调用方 webhook.deliver 负责）。
 * @param {string} url 原始 URL（Host 头与 SNI 用它的主机名）
 * @param {{ headers?: object, body?: string, addresses?: string[], timeoutMs?: number, signal?: AbortSignal,
 *           readBody?: boolean, maxBodyBytes?: number }} opts
 *        addresses：已由 netguard 校验为公网的地址（空 = 拒绝发送）
 *        readBody：是否把响应体读回来（webhook 不需要——它只看状态码；下单风控要读 JSON 应答）
 * @returns {Promise<{status:number, body?:string}>} 3xx/4xx/5xx 都原样作为 status 返回（由调用方判失败）
 */
export function postPinned(
  url,
  { headers = {}, body = '', addresses = [], timeoutMs = 5000, signal, readBody = false, maxBodyBytes = 64 * 1024 } = {}
) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error('URL 格式非法'));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('仅支持 http/https 协议'));
      return;
    }
    const hostname = u.hostname.replace(/^\[|\]$/g, ''); // 方括号是 URL 语法，connect/lookup 用裸地址
    const pinned = (Array.isArray(addresses) ? addresses : []).filter((a) => net.isIP(a) === 4 || net.isIP(a) === 6);
    if (!pinned.length) {
      // fail-closed：没有"校验过的地址"就没有可钉住的目标
      reject(new Error('缺少已校验的公网地址（拒绝在未钉住地址的情况下发请求）'));
      return;
    }
    const isHttps = u.protocol === 'https:';
    const isIpHost = net.isIP(hostname) !== 0;
    const options = {
      method: 'POST',
      hostname,
      port: u.port ? Number(u.port) : isHttps ? 443 : 80,
      path: `${u.pathname}${u.search}`,
      // Host 头保持原主机名（含非默认端口）：钉住的是 IP，不是虚拟主机身份
      headers: { ...headers, host: u.host },
      lookup: pinnedLookup(pinned),
      // 每次投递用独立连接：不复用 keep-alive 连接池里"上一次校验"建立的连接，
      // 目标地址与本次校验结果的对应关系在每次投递内都是新鲜的
      agent: false,
    };
    if (isHttps) {
      // SNI/证书校验仍按原主机名；字面量 IP 不发 SNI（与 fetch/curl 的默认行为一致）
      options.servername = isIpHost ? '' : hostname;
    }
    const mod = isHttps ? https : http;
    let timer = null;
    const onAbort = () => req.destroy(new Error(`请求已中止（> ${timeoutMs}ms）`));
    /** 结算一次：清掉超时与 abort 监听（防请求结束后仍持有定时器/监听器） */
    const settle = (fn) => (v) => {
      if (timer) clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const ok = settle(resolve);
    const fail = settle(reject);

    const req = mod.request(options, (res) => {
      /*
        结算形状固定为 `{ status, ok, body? }`（源码审计 2026-09 复审）：
        `ok` 是按状态码算出来的**布尔**，不是 fetch 的 `Response.ok` 访问器——
        调用方（webhook.js）此前写 `if (!res.ok)` 就踩了"字段不存在 ⇒ 恒为真"的坑，
        让真实 HTTP 200 被判成投递失败。这里把该字段补齐，防下一个调用方再踩。
      */
      const statusOk = res.statusCode >= 200 && res.statusCode < 300;
      if (!readBody) {
        res.resume(); // 丢弃响应体：只关心状态码（店主接收端可能回大 JSON，不必读）
        ok({ status: res.statusCode, ok: statusOk });
        return;
      }
      /*
        读响应体（下单风控要读 {"allow":true} 应答）：**限量**收集——对方可以回一个无限流，
        我们不因此把内存吃光；超限后停止累积（截断的 JSON 解析必然失败 ⇒ 调用方按 fail-closed 拒单，
        这正是风控要的方向）。已收下的部分照常返回。
      */
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        // 逐块截断到上限（不是"超了才停"）：单块本身可能就很大，不做切片等于把内存交给对方
        const room = maxBodyBytes - size;
        if (room <= 0) return;
        size += Math.min(room, c.length);
        chunks.push(room >= c.length ? c : c.subarray(0, room));
      });
      res.on('end', () => ok({ status: res.statusCode, ok: statusOk, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', fail);
    });
    req.on('error', fail);
    if (timeoutMs > 0) {
      timer = setTimeout(() => req.destroy(new Error(`请求超时（> ${timeoutMs}ms）`)), timeoutMs);
    }
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('请求已中止'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end(body);
  });
}
