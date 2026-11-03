/**
 * 店铺身份自主声明（shop claim）的**唯一判据层**：规范消息构造 + 声明值校验 + 签名核验。
 *
 * 要解决的问题：`code`（本节点生成的 9 位编号）只解决"唯一"（节点本地一店一号），**不解决"哪个才是官方那家"**
 * ——编号本身不携带任何外部身份信息。店主用钱包私钥对一段**规范消息**签名，把
 * "域名 / GitHub / X / Telegram" 这些外部身份绑定到店铺地址上，此后第三方可核验：
 *   · EOA：拿 `message` + `signature` 重算 `ethers.verifyMessage`，与 `address` 比对；
 *   · 合约账户（Safe/多签）：对 `address` 调标准 EIP-1271 digest，或 Safe legacy
 *     `isValidSignature(bytes,bytes)`；**不能**用 EOA 的离线复算。
 * 节点只做两件事：存储与转发（`message`/`signature` 原样落库、原样下发）。
 *
 * ⚠️ 它证明什么、不证明什么（必须原样传达给用户，**不得**标成"已认证/官方"）：
 *   证明：**某个地址签过这段话**，且该地址是这段话里 `code` 所对应店铺的 operator
 *         （签名覆盖了 `code:` 行，所以"这条声明属于这家店"是被签进来的，不是节点贴上去的）。
 *   不证明：这个域名/GitHub 账号**真的属于他**。归属核验是另一件事（域名要 DNS TXT 记录、
 *         GitHub 要 gist 或 OAuth），都不在本机制内，节点与第三方都没有这项能力。
 *         所以对外只能呈现"签名有效 + 店主声明了 X"，不能写成"官方认证 / 已验证所有权"。
 *
 * ── 规范消息格式（**确定性**：同一组入参逐字节相同）──
 *
 *   BTY marketplace shop claim
 *   code: <店铺编号>
 *   operator: <0x 小写地址>
 *   kind: <domain|github|x|telegram>
 *   value: <声明值>
 *   issued: <YYYY-MM-DD>
 *
 * 即「标题行 + 5 个字段行」= **实际字节 6 行、5 个 `\n`**、无尾随换行、无 BOM、UTF-8 编码。
 * （口径核对：口语里常把它说成"5 行"，数的是 5 个字段行；**以本文件与 test/shop-claims.test.js
 * 钉住的字节为准**——多一个尾随 `\n` 就与前端镜像实现算出的消息不是同一串，全体店主签名不通过。）
 * 刻意**不用 JSON**：JSON 的对象键序、空格、Unicode 转义在同一份数据上可以合法地产生多种字节序列，
 * 于是"店主签的"与"节点算的"可能在两端各自序列化后不相等，而这类不一致只会在用户签名失败时
 * 暴露（最难排查的一类）。逐行拼接 + 固定字段顺序没有这个自由度。
 *
 * ⚠️ **字节格式变更必须跨端同批**：前端有一份镜像实现（构造同一段消息给钱包签）与对应的字节单测，
 * 改这里就要同批改那里，否则表现是"所有店主都签不过"——而错误信息只会说签名不匹配。
 *
 * ══ 铁律：**签名的字节就是提交的字节** ══
 * 归一只能发生在**拒绝**这一侧，绝不能发生在"构造被签名内容"这一侧。具体是：
 *   · `buildClaimMessage` **逐字**使用入参（`kind`/`value`/`issued` 一个字符都不改、不 trim、
 *     不折大小写、不补当天）；它只做"字段存在且形状能拼成 6 行"的检查，拼不出就抛错。
 *   · `checkClaimValue` 是**校验器**（返回"是否已是规范形 + 原因"），**不返回**"我替你改好了"的值
 *     去参与验签——请求里的 `value` 不是规范形就直接**拒绝**，并在错误里告诉店主该写成什么。
 *   · 于是"客户端签什么、服务端验什么"永远一致：任何"需要归一才能验过"的输入都不会被静默接受
 *     （旧形状正是这样：节点先归一再用归一后的值验签 ⇒ 客户端签原文必然验不过，而错误只说
 *     "签名不对"，排查成本极高）。
 *   · 落库口径同理：`shop_claims.value` 存**签名覆盖的那个原文**，`message` 存拼出的原文；
 *     校验通过时原文 === 规范形，**不存在**"归一值"与"原文"两份真相。
 *
 * 本模块是**纯函数**（只用 ethers 的离线密码学能力，不碰 DB/网络/时钟）：
 * 时间（`issued`）由**调用方从请求体带来**，本模块不生成日期（见 buildClaimMessage）。
 */
import { ethers } from 'ethers';
import { isValidContractSignature } from './chain.js';
import { verifyShopCode } from './shopCode.js';

/** 允许的声明类型（顺序即报错文案里的顺序）。每种类型的值规则见 RULES */
export const CLAIM_KINDS = Object.freeze(['domain', 'github', 'x', 'telegram']);

/** 规范消息的标题行（第三方核验时据此确认"这确实是一条声明消息"） */
export const CLAIM_MESSAGE_HEADER = 'BTY marketplace shop claim';

/**
 * 声明值（**逐字**）的字符上限。
 * 依据：最长的一类是 domain（主机名形态上限 253 字符），320 是"绝无合法值会被它挡住"的宽松上界，
 * 同时挡住把整段说明文字塞进 value。超限**直接拒绝**而不是截断——截断后的域名/仓库名会变成一个
 * **看起来合法但完全不是他声明的东西**，比报错危险得多。
 */
export const CLAIM_VALUE_MAX = 320;

/** `issued` 的形状（YYYY-MM-DD；只校验形状与日历合法性，不改写它） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 小写 0x 地址（消息里 `operator:` 行的**逐字**形态；大写/校验和形态一律拒绝，不替调用方改写） */
const LOWER_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** ASCII 折小写（只折 A-Z；其它语系原样——与"域名/handle 大小写不敏感"的真实语义一致） */
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** 去掉一个前导 '@'（`@handle` 是最常见的书写习惯，其规范形唯一，不构成歧义） */
const stripAt = (s) => (s.startsWith('@') ? s.slice(1) : s);

/**
 * 日历合法性（`2026-02-30` 这种形状合法但日期不存在的必须被拒——
 * 它会原样进消息，成为一段"看着像日期、其实不是"的文本）。
 * 用 UTC 构造 + 回读比对，避免本地时区把 `Date.parse` 的解释带偏。
 */
function isRealDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/**
 * 各类声明值的规则（**唯一实现**）：`hint` 进报错文案，`canonical` 只用来回答
 * **"该写成什么"**（进错误信息给店主看 / 供前端预检对齐）——**绝不**用来构造被签名的内容。
 * 所有规则都只接受"规范书写"，不做静默清洗（不截断、不去空白、不猜意图）。
 * 唯一的例外是前导 `@`（见 stripAt）：它是书写习惯而不是值本身，规范形唯一。
 */
const RULES = {
  domain: {
    hint: '域名（主机名形态，如 shop.example.com）：小写字母/数字/连字符，至少两段，不含协议前缀、端口、路径',
    // 主机名形态：≥2 段，每段 1..63 字符 [a-z0-9-] 且不以连字符开头/结尾，总长 ≤253，
    // **末段（TLD）必须是 ≥2 位纯字母**——与前端 utils/shopClaim 的 DOMAIN_RE 同形。
    // 两端同形的意义：前端预检放过的值节点一定收，不会出现"用户白签一次名"；
    // 这条也顺带排除了 1.2.3.4（IPv4 不是域名，声明 IP 没有身份含义）与 example.co1 这类不存在的形态。
    canonical(v) {
      const s = asciiLower(v);
      if (s.length > 253) return null;
      const labels = s.split('.');
      if (labels.length < 2) return null;
      for (const l of labels) {
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
      }
      if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return null;
      return s;
    },
  },
  github: {
    hint: 'GitHub 用户名或 owner/repo（如 octocat 或 octocat/Hello-World），提交时用小写、不带 @ 与网址前缀',
    // owner：1..39 位 [a-z0-9-]，不以连字符开头/结尾（与前端 GITHUB_RE 同形——刻意**不**额外禁
    // "连续连字符"：那会让前端预检放过的 `a--b/repo` 到节点才被拒，用户白签一次名）。
    // repo：1..100 位 [a-z0-9._-]，且不能是 '.' / '..'（路径穿越形态不是仓库名）。
    // 裸用户名（`octocat`）是本节点**额外**允许的形态（口径要求"owner/repo 或用户名"）：
    // 节点是接受面的超集，不会出现"前端放过、节点拒收"。
    canonical(v) {
      const s = stripAt(asciiLower(v));
      const parts = s.split('/');
      if (parts.length > 2) return null;
      const [owner, repo] = parts;
      if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(owner || '')) return null;
      if (repo === undefined) return owner; // 只声明用户名：合法
      if (repo === '' || repo === '.' || repo === '..') return null;
      if (!/^[a-z0-9._-]{1,100}$/.test(repo)) return null;
      return `${owner}/${repo}`;
    },
  },
  x: {
    hint: 'X（Twitter）用户名（如 jack）：1..15 位小写字母/数字/下划线，提交时**不带** @',
    canonical(v) {
      const s = stripAt(asciiLower(v));
      return /^[a-z0-9_]{1,15}$/.test(s) ? s : null;
    },
  },
  telegram: {
    hint: 'Telegram 用户名（如 durov）：5..32 位小写字母/数字/下划线，提交时**不带** @',
    // 5..32 是 Telegram 官方上限；刻意**不**额外要求首字符为字母——
    // 宁可漏挡一种形状，也不误拒一个真实存在的用户名（误拒的表现是"店主永远声明不了"）。
    canonical(v) {
      const s = stripAt(asciiLower(v));
      return /^[a-z0-9_]{5,32}$/.test(s) ? s : null;
    },
  },
};

/**
 * 声明值**校验器**（**不返回**任何"替你改好了"的值去参与验签——见文件头铁律）。
 *
 * 返回值：
 *   · `{ ok: true, value }` —— 入参**逐字**就是规范形；`value` 与入参恒等（原样回给调用方落库/拼消息）；
 *   · `{ ok: false, canonical, reason }` —— 拒绝；`canonical` 是该输入的规范形（仅用于在错误信息里
 *     告诉店主"该写成什么"，`null` 表示连规范形都得不出来，例如非字符串/超长/空值）。
 *
 * 三态纪律：`kind` 缺省/非法、`value` 缺省/空串/非字符串都**拒绝**，不回落成任何默认值——
 * "没填"与"填错"对店主是两个不同的动作，静默取其一都会让他以为声明生效了。
 *
 * @param {unknown} kind 必须是**逐字**的 domain|github|x|telegram（大小写不折：消息逐字构造）
 * @param {unknown} value 请求体里的原文（**不 trim、不折大小写**）
 * @returns {{ok: true, value: string, canonical: string} | {ok: false, canonical: string|null, reason: string}}
 */
export function checkClaimValue(kind, value) {
  if (!CLAIM_KINDS.includes(kind)) {
    return {
      ok: false,
      canonical: null,
      reason: `kind 需逐字为 ${CLAIM_KINDS.join(' / ')} 之一（节点不做大小写归一：消息里的每个字节都要与签名时一致）`,
    };
  }
  const hint = RULES[kind].hint;
  if (typeof value !== 'string') {
    return { ok: false, canonical: null, reason: `${kind} 的声明值（value）需为字符串，${hint}` };
  }
  if (value === '' || value.trim() === '') {
    return { ok: false, canonical: null, reason: `${kind} 的声明值（value）不能为空，${hint}` };
  }
  if ([...value].length > CLAIM_VALUE_MAX) {
    return { ok: false, canonical: null, reason: `声明值超过 ${CLAIM_VALUE_MAX} 字符上限（当前 ${[...value].length} 字符），${hint}` };
  }
  if (/[\r\n]/.test(value)) {
    return { ok: false, canonical: null, reason: '声明值不能包含换行——规范消息按行构造，换行会改变被签名的字节' };
  }
  const canonical = RULES[kind].canonical(value);
  // "该写成什么"取两个候选：入参本身的规范形、去掉首尾空白后的规范形（后者覆盖 `" shop.example.com "`
  // 这类"形状其实对、只是多打了空格"的输入——只用于错误信息，绝不参与验签）。
  const fix = canonical ?? RULES[kind].canonical(value.trim());
  if (fix === null) {
    return { ok: false, canonical: null, reason: `「${value}」不是合法的 ${kind}，${hint}` };
  }
  if (fix !== value) {
    // 这里**只拒绝、不改写**：节点若替店主归一，签名覆盖的字节就与节点用来验签的字节不是同一串
    return {
      ok: false,
      canonical: fix,
      reason: `${kind} 的声明值需**逐字**写成规范形「${fix}」（提交的是「${value}」）——签名覆盖的就是提交的字节，节点不会替你归一`,
    };
  }
  return { ok: true, value, canonical };
}

/**
 * 规范消息构造（**唯一实现**：节点侧所有地方都用它，包括错误信息里回给店主的那一段）。
 *
 * **逐字**使用 `kind` / `value` / `issued`：不 trim、不折大小写、不补当天、不替换任何字符
 * （见文件头铁律）。因此它只做"字段存在且形状能拼成 6 行"的检查，拼不出就抛错：
 *   · `code`：非空、无空白无换行（编号是**本节点**铸造的 `shops.code`，形状/校验位契约在
 *     ./shopCode.js；这里再写一遍校验规则就是第二套判据——它一旦漂移，合法编号会被拒）；
 *   · `operator`：必须是**已小写**的 0x 地址（大写/校验和形态不替调用方改写，否则两端字节不同）；
 *   · `kind`：必须逐字在 {@link CLAIM_KINDS} 内；
 *   · `value`：非空、不含换行（形状检查；**是否规范形由调用方先过 checkClaimValue 决定**——
 *     本函数刻意不校验形态，它只负责"把给我的字节拼成消息"）；
 *   · `issued`：`YYYY-MM-DD` 且日期真实存在（**必须由调用方给出**，本模块不读时钟：
 *     日期是跨时区最容易漂移的一环，节点自己"补今天"会让店主签的那天与节点算的那天不是同一天）。
 *
 * @param {{code: unknown, operator: unknown, kind: unknown, value: unknown, issued: unknown}} claim
 * @returns {string} 规范消息（LF 连接、无尾随换行）
 * @throws {Error} 任一字段缺失/形状非法（错误信息是给店主看的中文）
 */
export function buildClaimMessage({ code, operator, kind, value, issued } = {}) {
  const c = verifyShopCode(code);
  if (!c) {
    throw new Error('店铺编号不合法（本店铺行的编号未通过 9 位校验；空值说明此时无法核验店主身份）');
  }
  const op = String(operator ?? '');
  if (!LOWER_ADDRESS_RE.test(op) || op === ethers.ZeroAddress) {
    throw new Error('operator 需为**小写**的 0x 以太坊地址（消息逐字构造：节点不改写任何被签字段）');
  }
  const k = String(kind ?? '');
  if (!CLAIM_KINDS.includes(k)) {
    throw new Error(`kind 需逐字为 ${CLAIM_KINDS.join(' / ')} 之一（消息逐字构造，节点不做大小写归一）`);
  }
  const v = String(value ?? '');
  if (v === '' || /[\r\n]/.test(v)) {
    throw new Error('声明值（value）不能为空、不能包含换行——规范消息按行构造，换行会改变被签名的字节');
  }
  const d = String(issued ?? '');
  if (!DATE_RE.test(d) || !isRealDate(d)) {
    throw new Error('issued 需为 YYYY-MM-DD 形状的合法日期（由客户端显式给出并签名，节点不会替你补当天）');
  }
  return [CLAIM_MESSAGE_HEADER, `code: ${c}`, `operator: ${op}`, `kind: ${k}`, `value: ${v}`, `issued: ${d}`].join('\n');
}

/**
 * 解析规范消息 → 各字段（形状不合规返回 null）。
 *
 * 为什么需要一个解析器：`verifyClaim` 要能回答"这条签名确实是对**这样一条声明消息**做的"，
 * 而不只是"对某个字符串做的"——否则把任意一段别处签过的文本塞进来也能通过（判据就不完整了）。
 * 行数、行序、字段名都固定（见文件头），多一行/少一行/换序一律 null。
 *
 * 刻意**不**在这里做"值是否符合该 kind 的规范形"的判断：解析回答的是"这是不是一条声明消息"，
 * 形态策略在写入路径的 `checkClaimValue`（核验方只关心"签名覆盖了这些字节"）。
 *
 * @param {unknown} message
 * @returns {{code: string, operator: string, kind: string, value: string, issued: string}|null}
 */
export function parseClaimMessage(message) {
  if (typeof message !== 'string') return null;
  const lines = message.split('\n');
  // 6 行 = 标题行 + 5 个字段行（见文件头）。行数不对（含被追加/删掉尾行）一律不是本店消息。
  if (lines.length !== 6) return null;
  if (lines[0] !== CLAIM_MESSAGE_HEADER) return null;
  const out = {};
  const keys = ['code', 'operator', 'kind', 'value', 'issued'];
  for (let i = 0; i < keys.length; i += 1) {
    const prefix = `${keys[i]}: `;
    const line = lines[i + 1];
    if (!line.startsWith(prefix)) return null;
    const val = line.slice(prefix.length);
    if (!val) return null;
    out[keys[i]] = val;
  }
  if (!CLAIM_KINDS.includes(out.kind)) return null;
  return out;
}

/**
 * 签名核验（**唯一判据**）：这条 `signature` 是不是 `expectedOperator` 对这条规范声明消息的签名？
 *
 * 三步，缺一不可：
 *  1. 消息必须是**本店的规范声明消息**（parseClaimMessage 通过）——否则"签名有效"证明的
 *     只是"他签过某个字符串"，与店铺身份无关；
 *  2. 消息里的 `operator:` 行必须等于 `expectedOperator`（本店 operator）——防"拿 A 店的消息
 *     来 B 店登记"（消息里绑定了 code/operator，签名覆盖了它们）；
 *  3. EOA 用 `verifyMessage` 恢复；合约账户（Safe/多签）用标准 EIP-1271 或 Safe legacy
 *     `isValidSignature` 验，标准路径失败后回退到 Safe `signMessage(message)` 的 bytes 重载。
 *
 * 返回值刻意是 `{ok, signer, reason}` 而不是抛错：调用方需要把"签名者是谁"如实报出来
 * （"签名者不是本店 operator"与"签名格式不合法"是两种完全不同的处置）。
 *
 * `provider` 仅供测试注入；生产传 null，走节点默认 RPC。EOA 命中时不需要 RPC。
 *
 * @param {{message: unknown, signature: unknown, expectedOperator: unknown, provider?: object|null}} args
 * @returns {Promise<{ok: boolean, signer: string|null, reason: string|null}>}
 */
export async function verifyClaim({ message, signature, expectedOperator, provider = null } = {}) {
  const want = asciiLower(String(expectedOperator ?? '').trim());
  if (!ethers.isAddress(want) || want === ethers.ZeroAddress) {
    return { ok: false, signer: null, reason: 'operator 地址不合法（无法判定签名者应该是谁）' };
  }
  const parsed = parseClaimMessage(message);
  if (!parsed) {
    return { ok: false, signer: null, reason: '消息不是本店规范声明消息（6 行、固定字段顺序，见 src/claims.js 文件头）' };
  }
  if (parsed.operator !== want) {
    return { ok: false, signer: null, reason: `消息里的 operator 是 ${parsed.operator}，不是本店 operator ${want}` };
  }
  let signer = '';
  try {
    signer = asciiLower(ethers.verifyMessage(message, String(signature ?? '')));
  } catch {
    signer = '';
  }
  if (signer === want) return { ok: true, signer, reason: null };
  /*
    非 EOA：先试标准 1271 digest，再试 Safe `signMessage(message)` 的 legacy bytes。
    失败是 fail-closed；EOA 错签名也会走到这里，但合约调用会返回 false，不会误放行。
  */
  const contractOk = await isValidContractSignature(
    want,
    ethers.toUtf8Bytes(message),
    ethers.hashMessage(message),
    String(signature ?? ''),
    provider
  );
  if (contractOk) return { ok: true, signer: want, reason: null };
  if (!signer) {
    return {
      ok: false,
      signer: null,
      reason: '签名格式不合法（需 65 字节 0x hex 的 EOA personal_sign 签名，或合约账户的 EIP-1271 签名）',
    };
  }
  return { ok: false, signer, reason: `签名者是 ${signer}，不是本店 operator ${want}` };
}
