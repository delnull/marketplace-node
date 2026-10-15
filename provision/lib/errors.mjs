/**
 * 云服务商错误的**唯一分类层**。
 *
 * 为什么要有这一层：三家（阿里云/腾讯云/AWS）把"同一件事"编成三套完全不同的错误码
 * —— 密钥无效在阿里云是 `InvalidAccessKeyId.NotFound`、腾讯云是 `AuthFailure.SignatureFailure`、
 * 在 AWS 是 `AuthFailure`/`InvalidClientTokenId`。
 * 若把这些判断散在各个适配器的调用点，那么"余额不足要停下来问人"这条规则就会在三家各写一遍，
 * 而且**新增一家必然漏一处**（本仓反复踩的"判据挂错层"）。
 *
 * 所以判据只在这里成立一次：适配器把原始错误码丢给 `classify()`，全仓只认这几个 kind。
 * 调用方（预算门禁、CLI 退出码、重试策略）只看 kind，永远不看原始码。
 */

/** 全仓唯一的一组失败语义。调用方只认这几种。 */
export const KIND = Object.freeze({
  /** 密钥无效/签名不对/STS 过期 —— 用户需要换一把 key */
  AUTH: 'auth',
  /** 密钥有效但**没有这个权限**（RAM/CAM/IAM 策略没给）—— 用户需要改策略 */
  FORBIDDEN: 'forbidden',
  /** 欠费/余额不足/信用额度用尽 —— 需要充值 */
  INSUFFICIENT_BALANCE: 'insufficient_balance',
  /** 账号本身还没就绪（实名认证未过、信息模板未审核、风控拦截）—— 改权限没用，要去控制台办 */
  ACCOUNT_NOT_READY: 'account_not_ready',
  /** 请求本身不合法（参数、配额、可用区无货） */
  INVALID: 'invalid',
  /** 限流 —— 可重试 */
  THROTTLED: 'throttled',
  /** 服务端 5xx / 网络 —— 可重试 */
  UNAVAILABLE: 'unavailable',
  /** 资源不存在（按 ID 查不到） */
  NOT_FOUND: 'not_found',
  /** 上面都不是：原样上抛，不做猜测 */
  UNKNOWN: 'unknown',
});

export class CloudError extends Error {
  /**
   * @param {string} kind   KIND 之一
   * @param {string} message 给人看的一句话（含服务商的原始码与 requestId，便于查文档/开工单）
   * @param {{ provider?: string, action?: string, code?: string, requestId?: string, status?: number, raw?: unknown }} [meta]
   */
  constructor(kind, message, meta = {}) {
    super(message);
    this.name = 'CloudError';
    this.kind = kind;
    Object.assign(this, meta);
  }
}

/*
  码表按 **前缀/精确串** 匹配。刻意不做正则模糊匹配：
  "看起来像鉴权失败"这种判断会把 `Forbidden.RiskControl`（风控拦截，改权限没用）
  误判成 FORBIDDEN 而给出错误的处置建议 —— 宁可落到 UNKNOWN 原样上抛。
  key 统一小写比较，因为 AWS 的码是大驼峰、阿里云/腾讯云是点分。
*/
const TABLE = [
  /*
    ── 账号状态：**必须排在"没权限"前面** ──
    这一类不能并进 FORBIDDEN：改 RAM 策略解决不了实名认证，给出错误的处置比不给出更糟。
    顺序也是判据的一部分 —— 表是**首个前缀命中即返回**，而 `Forbidden.RiskControl` 同时命中
    `Forbidden`，把它放在后面就会被吞成 forbidden（这条有单测钉着）。
  */
  ['RealNameAuthenticationError', KIND.ACCOUNT_NOT_READY],
  ['UnsupportedOperation.AccountRealName', KIND.ACCOUNT_NOT_READY],
  ['ResourceNotFound.ApprovedTemplateNotFound', KIND.ACCOUNT_NOT_READY], // 腾讯云：模板未实名
  ['FailedOperation.VerifyUinIsRealname', KIND.ACCOUNT_NOT_READY],
  ['InvalidParameter.UnrealNameUser', KIND.ACCOUNT_NOT_READY],
  ['FailedOperation.NotRealNamedUser', KIND.ACCOUNT_NOT_READY],
  ['RegistrantProfileNotApproved', KIND.ACCOUNT_NOT_READY],
  ['SecurityRisk.3DVerification', KIND.ACCOUNT_NOT_READY],
  ['Forbidden.RiskControl', KIND.ACCOUNT_NOT_READY], // 风控拦截：与"改权限"无关

  // ── 鉴权：密钥本身不对 ──
  ['InvalidAccessKeyId.NotFound', KIND.AUTH],
  ['InvalidAccessKeyId.Inactive', KIND.AUTH],
  ['InvalidAccessKeyId', KIND.AUTH],
  ['SignatureDoesNotMatch', KIND.AUTH],
  ['InvalidSecurity', KIND.AUTH],
  ['InvalidClientTokenId', KIND.AUTH],
  ['UnrecognizedClientException', KIND.AUTH],
  ['AuthFailure.SignatureFailure', KIND.AUTH],
  ['AuthFailure.SignatureExpire', KIND.AUTH],
  ['AuthFailure.SecretIdNotFound', KIND.AUTH],
  ['AuthFailure.TokenFailure', KIND.AUTH],
  ['AuthFailure.MFAFailure', KIND.AUTH],
  ['AuthFailure.UnauthorizedOperation', KIND.FORBIDDEN],
  ['AuthFailure', KIND.AUTH],
  ['401', KIND.AUTH],

  // ── 鉴权通过但没权限 ──
  ['Forbidden.RAM', KIND.FORBIDDEN],
  ['Forbidden', KIND.FORBIDDEN],
  ['NoPermission', KIND.FORBIDDEN],
  ['NotAuthorized', KIND.FORBIDDEN],
  ['UnauthorizedOperation', KIND.FORBIDDEN],
  ['UnauthorizedOperation.', KIND.FORBIDDEN],
  ['OptInRequired', KIND.FORBIDDEN], // AWS：这个 Region/服务没开通
  ['AccessDenied', KIND.FORBIDDEN],
  ['AccessDeniedException', KIND.FORBIDDEN],
  ['403', KIND.FORBIDDEN],

  // ── 余额/额度 ──
  ['InvalidAccountStatus.NotEnoughBalance', KIND.INSUFFICIENT_BALANCE],
  ['InvalidAccountStatus', KIND.INSUFFICIENT_BALANCE],
  ['InvalidAccount.InsufficientBalance', KIND.INSUFFICIENT_BALANCE], // 腾讯云
  ['InvalidAccount.UnpaidOrder', KIND.INSUFFICIENT_BALANCE],
  ['Account.Arrearage', KIND.INSUFFICIENT_BALANCE], // 阿里云：账号欠费
  ['PaymentMethodNotFound', KIND.INSUFFICIENT_BALANCE],
  ['InvalidPayMethod', KIND.INSUFFICIENT_BALANCE],
  ['InsufficientBalance', KIND.INSUFFICIENT_BALANCE],
  ['FailedOperation.BalanceNotEnough', KIND.INSUFFICIENT_BALANCE],
  ['FailedOperation.InsufficientBalance', KIND.INSUFFICIENT_BALANCE],
  ['ResourceInsufficient.BalanceNotEnough', KIND.INSUFFICIENT_BALANCE],
  ['ResourceInsufficient.InsufficientQuota', KIND.INVALID],
  ['ResourceInsufficient', KIND.INVALID],
  ['ACCOUNT_ARREARS', KIND.INSUFFICIENT_BALANCE],
  ['NotEnoughBalance', KIND.INSUFFICIENT_BALANCE],
  ['insufficient', KIND.INSUFFICIENT_BALANCE],

  // ── 不存在 ──
  ['InvalidInstanceId.NotFound', KIND.NOT_FOUND],
  ['InvalidInstanceID.NotFound', KIND.NOT_FOUND],
  ['InvalidDomainName.NotFound', KIND.NOT_FOUND],
  ['InvalidDomain.NotFound', KIND.NOT_FOUND],
  ['ResourceNotFound', KIND.NOT_FOUND],
  ['NoSuchHostedZone', KIND.NOT_FOUND],
  ['InvalidDomainName', KIND.INVALID],
  ['404', KIND.NOT_FOUND],

  // ── 限流 / 服务不可用 ──
  ['Throttling', KIND.THROTTLED],
  ['ThrottlingException', KIND.THROTTLED],
  ['RequestLimitExceeded', KIND.THROTTLED],
  ['RequestLimitExceeded.', KIND.THROTTLED],
  ['TooManyRequests', KIND.THROTTLED],
  ['429', KIND.THROTTLED],
  ['RequestTimeout', KIND.UNAVAILABLE],
  ['ServiceUnavailable', KIND.UNAVAILABLE],
  ['InternalError', KIND.UNAVAILABLE],
  ['InternalServerError', KIND.UNAVAILABLE],
  ['500', KIND.UNAVAILABLE],
  ['502', KIND.UNAVAILABLE],
  ['503', KIND.UNAVAILABLE],
  ['ServerError', KIND.UNAVAILABLE],
  ['ECONNRESET', KIND.UNAVAILABLE],
  ['ETIMEDOUT', KIND.UNAVAILABLE],
  ['EAI_AGAIN', KIND.UNAVAILABLE],
  ['ENOTFOUND', KIND.UNAVAILABLE],
  ['fetch failed', KIND.UNAVAILABLE],
  /*
    网络层失败在 Node 上不是"服务商的错误码"，而是 fetch/undici 抛出的异常：
    `AbortSignal.timeout` 超时是 `TimeoutError`（DOMException），连接层是 `fetch failed`
    且真码在 `e.cause.code`（ECONNRESET/ETIMEDOUT/…）。以前这里只喂 `e.name`，
    于是上面那几条几乎取不到，**一次超时就直接抛**（重试形同虚设）。
    这几条按"错误来源"补在同一个码表里（分类只有这一处），而不是在调用点各判一次。
  */
  ['TimeoutError', KIND.UNAVAILABLE],
  ['AbortError', KIND.UNAVAILABLE],
  ['HeadersTimeoutError', KIND.UNAVAILABLE],
  ['BodyTimeoutError', KIND.UNAVAILABLE],
  ['ConnectTimeoutError', KIND.UNAVAILABLE],
  ['UND_ERR_CONNECT_TIMEOUT', KIND.UNAVAILABLE],
  ['UND_ERR_HEADERS_TIMEOUT', KIND.UNAVAILABLE],
  ['UND_ERR_BODY_TIMEOUT', KIND.UNAVAILABLE],
  ['UND_ERR_SOCKET', KIND.UNAVAILABLE],

  // ── 请求不合法（含配额、无货、不支持）──
  ['InvalidParameter', KIND.INVALID],
  ['InvalidParameterValue', KIND.INVALID],
  ['MissingParameter', KIND.INVALID],
  ['InvalidAction', KIND.INVALID],
  ['UnsupportedOperation', KIND.INVALID],
  ['Unsupported', KIND.INVALID],
  ['InvalidRegion', KIND.INVALID],
  ['QuotaExceeded', KIND.INVALID],
  ['ZoneNotSupported', KIND.INVALID],
  ['OperationDenied', KIND.INVALID],
  ['InvalidDomainStatus', KIND.INVALID],
  ['DomainLimitExceeded', KIND.INVALID],
  ['TLDRulesViolation', KIND.INVALID],
  ['UnsupportedTLD', KIND.INVALID],
  ['InvalidInput', KIND.INVALID],
];

/**
 * 唯一的分类实现。
 * @param {string} rawCode 服务商原始错误码
 * @param {number} [status] HTTP 状态（有些服务只给状态码）
 * @returns {string} KIND 之一
 */
export function classify(rawCode, status) {
  const code = String(rawCode ?? '').trim();
  if (code) {
    const lower = code.toLowerCase();
    for (const [needle, kind] of TABLE) {
      if (lower === needle.toLowerCase() || lower.startsWith(needle.toLowerCase())) return kind;
    }
  }
  if (status) {
    const byStatus = TABLE.find(([needle]) => needle === String(status));
    if (byStatus) return byStatus[1];
  }
  return KIND.UNKNOWN;
}

/**
 * 一个异常可能同时带好几个候选码（网络层尤其如此：`name` 是 DOMException 的名字、
 * `code` 是内建错误码、`cause.code` 才是真正的套接字错误）。逐个按 `classify` 的规则判，
 * 取第一个能认出来的。
 *
 * 为什么不在调用点拼成一整行字符串再交给 `classify`：`classify` 的判据是"**等于或以此开头**"，
 * 拼成一行的结果必然以第一个片段开头（`'TypeError ECONNRESET'` 既不是 `ECONNRESET`
 * 也不以它开头）⇒ 后面的片段永远匹配不上，重试判断再次形同虚设。
 */
export function classifyAny(codes, status) {
  for (const c of codes ?? []) {
    if (!c) continue;
    const kind = classify(c);
    if (kind !== KIND.UNKNOWN) return kind;
  }
  return classify(undefined, status);
}

/** 人可以照着做的下一步。CLI 只打印这里的话，不再各自编措辞。 */
export const ADVICE = Object.freeze({
  [KIND.AUTH]: '密钥无效或已过期。检查 AccessKey/SecretKey 是否复制完整、是否属于当前账号、是否被禁用或轮换过。',
  [KIND.FORBIDDEN]: '密钥有效但没有这项权限。到 RAM/CAM/IAM 给这把 key 补上对应的策略（本脚本需要的权限见 provision --help）。',
  [KIND.INSUFFICIENT_BALANCE]: '账号余额不足。先充值（或改用预付费/代金券），再重跑。',
  [KIND.ACCOUNT_NOT_READY]:
    '账号本身还没就绪（实名认证/信息模板/风控）。这不是权限问题，改 RAM 策略解决不了：按上面的原始信息去服务商控制台办完，再重跑。',
  [KIND.INVALID]: '请求被服务商拒绝（参数/配额/该可用区无货）。上面的原始错误码就是原因，按它调整参数或换区域。',
  [KIND.THROTTLED]: '被限流。等一会儿重跑同样的命令即可（脚本不会重复买资源：已创建的东西记在状态文件里）。',
  [KIND.UNAVAILABLE]: '服务商侧不可用或网络不通。稍后重跑；已完成的部分会从状态文件继续。',
  [KIND.NOT_FOUND]: '按 ID 查不到该资源：可能已被删除，或密钥属于另一个账号。',
  [KIND.UNKNOWN]: '未识别的错误，原样上抛不做猜测（避免按错误的分类给出错误的处置）。',
});

/** 把任意异常写成一行给人看的话（不吞掉原始内容）。 */
export function describe(err) {
  if (err instanceof CloudError) {
    const bits = [err.message];
    if (err.code) bits.push(`code=${err.code}`);
    if (err.requestId) bits.push(`requestId=${err.requestId}`);
    return bits.join(' ');
  }
  return err?.message || String(err);
}
