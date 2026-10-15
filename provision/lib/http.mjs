/**
 * 云 API 的 HTTP 客户端 —— **本工具唯一发出网络请求的地方**。
 *
 * 为什么收敛到一处：四家服务商的响应形状不同（阿里云把结果摊在顶层、腾讯云包一层 `Response`、
 * AWS 直接给 `__type`），但"超时、重试、限流退避、错误归类"
 * 这四件事对四家是同一件事。散到各适配器里就会出现"AWS 那个适配器忘了设超时"这种漏点，
 * 而症状是**脚本在某些网络上永远挂着**（没人盯终端时这不叫等待，叫挂死）。
 *
 * 只依赖 Node 内建的 fetch / crypto（Node ≥ 23，与 node/ 的 engines 一致）。
 */
import { CloudError, classify, classifyAny } from './errors.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
/** 这些 kind 值得重试：它们与请求内容无关（限流/服务端抖动/网络），重试不会重复花钱。 */
const RETRYABLE = new Set(['throttled', 'unavailable']);

/**
 * 网络层异常的归类 —— **唯一判据在 errors.mjs 的码表**，这里只负责把"异常的形状"喂全。
 *
 * 一个 Node 网络异常可能把真码放在三个地方，只取一个必然漏掉另一类：
 *   · `e.name`        —— AbortSignal 超时（DOMException `TimeoutError`）、undici 的 `HeadersTimeoutError`
 *   · `e.code`        —— 部分内建错误（`ECONNRESET` 等）
 *   · `e.cause.code`  —— `TypeError('fetch failed')` 里包着的真因（undici 一直是这个形状）
 * 合并成一行字符串交给分类器：分类器按子串匹配，命中任意一个即可。
 */
function classifyNetworkError(e) {
  return classifyAny([e?.cause?.code, e?.code, e?.cause?.name, e?.name, 'fetch failed']);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把 URL 交给可替换的 fetch —— **测试注入点**。
 *
 * 为什么需要它：这个工具的每一条路径都要发真实请求（下单、买域名），而"没有真实云账号"
 * 不等于"这些路径无法被测"。有了这个注入点，测试可以拿**各家文档里抄下来的真实响应样例**
 * 喂给适配器，验证的是"解析对不对、判据落在不在对的地方"，而不是"mock 调用了几次"。
 *
 * 生产环境下它就是 `globalThis.fetch`，没有任何行为差异（不是"降级路径"，也不是开关）。
 */
export function setFetch(fn) {
  fetchImpl = fn;
}
let fetchImpl = globalThis.fetch;

/**
 * 把所有云 API 的请求**指向同一个本地假云**（测试用），原主机名放进 `x-mock-host` 头。
 *
 * 为什么用环境变量而不是"注入一个 URL 参数"：适配器里写的是各家真实的 endpoint
 * （`ecs.cn-hongkong.aliyuncs.com` 这种），它们**必须**保持真实 —— 如果给适配器加一个
 * "可替换的 base url"参数，那这个参数在真实运行时就是一条能被指错的路。
 * 所以这里只在发请求的那一刻改写，且**强制带上原主机名**：假云据此分派，测试也能断言目标。
 *
 * 这个开关**只在测试里设**（test/*.test.mjs）；正常运行时为空，走的就是 globalThis.fetch。
 */
function withMockBase(rawUrl) {
  const base = process.env.PROVISION_API_BASE;
  if (!base) return { url: rawUrl, headers: {} };
  const original = new URL(rawUrl);
  const target = new URL(original.pathname + original.search, new URL(base));
  return { url: target.toString(), headers: { 'x-mock-host': original.host } };
}

/**
 * 发一次带签名的请求。
 * @param {object} o
 * @param {string} o.provider   适配器名（只用于错误信息）
 * @param {string} o.action     动作名（只用于错误信息）
 * @param {string} o.url
 * @param {string} [o.method]   默认 GET
 * @param {Record<string,string>} [o.headers]
 * @param {string|undefined} [o.body]
 * @param {number} [o.timeoutMs]
 * @param {number} [o.attempts] 总尝试次数（含首次）；默认 3
 * @param {(res: Response, text: string) => any} [o.parse] 把响应体转成对象（默认 JSON.parse）
 * @param {(obj: any) => string|null} [o.errorCode] 从解析后的对象里取服务商错误码
 * @returns {Promise<any>}
 */
export async function apiCall(o) {
  const attempts = o.attempts ?? 3;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    let res;
    let text = '';
    const target = withMockBase(o.url);
    try {
      res = await fetchImpl(target.url, {
        method: o.method ?? 'GET',
        headers: { ...o.headers, ...target.headers },
        body: o.body,
        signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (e) {
      /*
        网络层失败（DNS/连接/超时）：抛的是 fetch/undici 的异常，**不是一个错误码**。
        `AbortSignal.timeout` 给的是 DOMException（`name='TimeoutError'`），
        连接层是 `TypeError('fetch failed')` 而真码藏在 `e.cause.code`（ECONNRESET/ETIMEDOUT…）。
        所以这里要把 name / code / cause.code **一起**交给分类器 —— 只喂一个必然漏掉另一类，
        而漏掉的后果是"一次超时就直接抛"，重试那套退避等于没写。
      */
      const kind = classifyNetworkError(e);
      lastErr = new CloudError(kind, `${o.provider}:${o.action} 请求失败：${e?.message || e}`, {
        provider: o.provider,
        action: o.action,
      });
      if (i < attempts && RETRYABLE.has(kind)) {
        await sleep(500 * i);
        continue;
      }
      throw lastErr;
    }

    let parsed;
    try {
      parsed = o.parse ? o.parse(res, text) : text ? JSON.parse(text) : {};
    } catch {
      // 非预期响应体（HTML 错误页 / 网关页）：**保留前 300 字**，否则现场只剩一句"解析失败"
      parsed = { __raw: text.slice(0, 300) };
    }

    if (res.ok) return parsed;

    const code = o.errorCode ? o.errorCode(parsed) : parsed?.Code || parsed?.code || parsed?.error_code || parsed?.__type;
    const kind = classify(code, res.status);
    const detail = parsed?.Message || parsed?.message || parsed?.error_msg || parsed?.__raw || text.slice(0, 300);
    lastErr = new CloudError(kind, `${o.provider}:${o.action} 失败（HTTP ${res.status}）：${code ? code + ' ' : ''}${detail}`, {
      provider: o.provider,
      action: o.action,
      code: code ? String(code) : undefined,
      requestId: parsed?.RequestId || parsed?.request_id || parsed?.Response?.RequestId,
      status: res.status,
      raw: parsed,
    });
    if (RETRYABLE.has(kind) && i < attempts) {
      await sleep(1000 * i);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

/** URL 查询串：RFC3986 编码，空格必须是 %20（阿里云的签名按字面校验，`+` 会被判签名错） */
export function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** 表单体（POST body 用）：与 qs 同一套编码，但空值**要保留**（`Key=` 与"没有这个键"在协议上是两回事） */
export function formBody(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}
