/**
 * 店铺信息与管理路由（经营参数全部网页化：kv 存储）。
 *
 * 配置文件只保留"身份与接线"（店主钱包/escrow/registry/端口等）；
 * 店名/公告/店员白名单/通知 webhook 均在卖家面板「店铺设置」维护（即改即生效，无需重启）。
 *
 *  GET  /                店铺展示信息（name/notice/owner/链配置——买家页面与下单核验用）
 *  GET  /registry-info   开店登记信息（owner/name/notice/escrow/registry；endpoint 由开店向导
 *                        网页填写——节点不预置对外地址；链上登记不含展示元数据，见合约注释）
 *  PUT  /                编辑店铺资料 {name?, notice?}（staffOnly；入审计）
 *  GET  /settings        店铺设置读取（ownerOnly：当前资料/店员列表/webhook 状态）
 *  PUT  /staff           店员管理 {action:'add'|'remove', address}（ownerOnly；入审计）
 *  PUT  /webhook         通知配置 {url, secret}（ownerOnly；secret 不回显，仅布尔状态）
 *  GET  /reputation      履约画像聚合统计（信誉索引，纯公开只读）
 *  GET  /staking         质押跌破注册门槛的店主清单（治理只读；口径见 src/stakingRisk.js）
 *  GET  /reviews/stats   店铺买家评价聚合（公开只读）
 *  GET  /buyer-signal    买家履约信号（ownerOnly；**本店视角**，口径见 src/buyerSignal.js）
 *  POST /claims          提交一条身份声明 {kind,value,issued,signature}（ownerOnly；签名核验见 src/claims.js）
 *  GET  /claims          公开列出**有效**声明（原样带 message/signature，供第三方离线核验；不标"认证"）
 *  POST /claims/:id/revoke  撤销一条声明（ownerOnly；已撤销的不再出现在公开列表；入审计）
 *  GET  /metrics         运营指标（ownerOnly；待办/超时/挂账/对账读数，口径见 src/opsMetrics.js）
 *  GET  /sla             卖家 SLA 读数（ownerOnly；三份待办清单 + 发货时长分布，同上）
 */
import { Router } from 'express';
import config, { DEFAULT_SHOP_NAME } from '../config.js';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { verifyToken, roleOf, getShopOperators } from '../auth.js';
import { kvGet, kvSet, getDb } from '../db.js';
import { logAudit } from '../audit.js';
import { isAddress, isZeroAddress } from '../chain.js';
// 店铺身份声明的唯一判据层：规范消息构造（**逐字**使用请求字段）/ 声明值校验（**拒绝**而非变换）/
// 签名核验（见 src/claims.js 文件头——那里写清了铁律"签名的字节就是提交的字节"，
// 以及"它证明什么、不证明什么"：对外口径必须是"店主签过这句话"，不是"官方认证"）
import { checkClaimValue, buildClaimMessage, verifyClaim } from '../claims.js';
import { reputationSummary } from '../reputation.js';
import { shopReviewStats } from '../reviews.js';
import { webhookStatus, sendTestEvent } from '../webhook.js';
import { shopCode, cachedShopCode } from '../shopCode.js';
import { overviewStats, trendStats, productStats, normalizeStatsDays } from '../stats.js';
import { refreshFeeCollector, feeStatus } from '../fees.js';
// 质押跌破注册门槛的读数（治理只读；事实源与取舍见 src/stakingRisk.js）
import { stakingShortfall } from '../stakingRisk.js';
// 买家履约信号（本店视角；口径、隐私边界与文案纪律见 src/buyerSignal.js 文件头）
import { buyerSignal } from '../buyerSignal.js';
// 运营读数与 SLA（待办谓词、托管超时、挂账、对账、发货时长的**唯一实现**）
import { opsMetrics, slaReading, SLA_LIMIT_DEFAULT, SLA_LIMIT_MAX } from '../opsMetrics.js';
// 对账运行状态快照（唯一事实源；opsMetrics 只做形状与三态标注，不 import 它是为了避免循环依赖）
import { chainReconcileStatus } from '../chainReconcile.js';

const router = Router();
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true });
// 店铺资料编辑（店名/公告）为经营面操作：店主与店员（网页授权白名单）均可（入审计）
const staffOnly = makeAuthMiddleware(verifyToken, { staffOnly: true });

// ── 店铺资料（kv 覆盖默认：网页「店铺设置」编辑，无需改 .env 重启）──
const KV_NAME = 'mk:shop_name';
const KV_NOTICE = 'mk:shop_notice';
const KV_OPERATORS = 'mk:shop_operators';
const KV_WEBHOOK_URL = 'mk:webhook_url';
const KV_WEBHOOK_SECRET = 'mk:webhook_secret';

export function shopName() {
  const v = kvGet(KV_NAME);
  return v !== null && v !== '' ? v : DEFAULT_SHOP_NAME;
}

export function shopNotice() {
  const v = kvGet(KV_NOTICE);
  return v !== null ? v : '';
}

const audit = (req, action, targetType, targetId, detail) =>
  logAudit({ req, actor: req.auth?.address, actorRole: roleOf(req.auth?.address || ''), action, targetType, targetId, detail });

/*
  公开只读聚合端点的限流（此前**完全无限流**，而它们都是 O(全表) 的）：
   · /reputation：reputationSummary 扫全表 orders 并对每行 JSON.parse(onchain_events)——
     单次就是一次全表解析，匿名脚本按秒轮询即可把 CPU 打满；
   · /reviews/stats：reviews 表聚合（较轻，但同样是公开面）。
  数值依据：联邦前端的目录页会对**每个可达节点**各打一次 reputation（useNodeDirectory 扇出，
  各家店同一 IP 从同一浏览器发出），商家主页另加一次——60 次/分足够"一屏几十家店 × 几次
  页面切换"，而脚本化 1 次/秒以下的全表扫描才可能碰到上限（2 次/秒即挡）。
  注意：与 simpleRateLimit 的其它用法一样是**单进程内存窗口**，多实例部署需网关层兜底。
*/
const reputationLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '店铺履约画像查询过于频繁，请稍后再试' });
const reviewsStatsLimiter = simpleRateLimit({ windowMs: 60_000, max: 120, message: '店铺评价统计查询过于频繁，请稍后再试' });

/** 店铺展示信息（买家店铺页/下单核验用） */
router.get('/', (req, res) => {
  /*
    店铺编号（链上铸造的 9 位标识 = 8 数据 + 1 加权校验）：前端用它把这家店写进 URL（`/shop/00000003`）。
    节点**自报**编号的意义——前端任何一次与某店交互都能顺带学会 `origin → code`，
    不必为全站 27 个链接点各发一次"问编号"的请求。
    这里读的是 30s 缓存（同步、不发请求），首次调用先暖一次缓存；读不到就是 null（不编造）。
  */
  void shopCode();
  ok(res, {
    owner: config.shop.owner || null,
    code: cachedShopCode() || null,
    name: shopName(),
    notice: shopNotice(),
    chainId: config.chain.chainId,
    escrowAddress: config.chain.escrowAddress || null,
    registryAddress: config.chain.registryAddress || null,
    timeoutBlocks: config.escrow.timeoutBlocks,
    version: '0.1.0',
  });
});

/**
 * 开店登记信息（公开只读）：前端「添加节点成为卖家」据此自动填充与**一致性校验**——
 * 节点 escrow/registry 必须与登记前端同网络（VITE_*），否则拒绝登记。
 * 注意：endpoint 不在节点预置——由开店向导网页填写（本节点可被任一前端访问时域名即 endpoint）。
 */
router.get('/registry-info', (req, res) => {
  const name = shopName();
  const notice = shopNotice();
  ok(res, {
    owner: config.shop.owner || null,
    name,
    notice,
    chainId: config.chain.chainId,
    escrowAddress: config.chain.escrowAddress || null,
    registryAddress: config.chain.registryAddress || null,
    canRegister: !!(config.shop.owner && config.chain.escrowAddress && config.chain.registryAddress),
    version: '0.1.0',
  });
});

/** 店主/店员编辑店铺资料（name/notice；入审计；无需改 .env 重启） */
router.put('/', staffOnly, wrap(async (req, res) => {
  const { name, notice } = req.body || {};
  const curName = shopName();
  const curNotice = shopNotice();
  const nextName = name !== undefined ? String(name).trim().slice(0, 60) : curName;
  const nextNotice = notice !== undefined ? String(notice).trim().slice(0, 500) : curNotice;
  if (name !== undefined && !nextName) return fail(res, '店铺名不能为空（≤60 字）');
  if (name !== undefined) kvSet(KV_NAME, nextName);
  if (notice !== undefined) kvSet(KV_NOTICE, nextNotice);
  audit(req, 'shop.update', 'shop', '-', { nameChanged: nextName !== curName, noticeChanged: nextNotice !== curNotice });
  ok(res, { name: nextName, notice: nextNotice }, '店铺资料已更新（买家店铺页即时生效；链上登记不含展示资料，无需同步）');
}));

/** 店铺设置读取（ownerOnly）：当前资料/店员列表/webhook 状态（secret 不回显） */
router.get('/settings', ownerOnly, (req, res) => {
  ok(res, {
    name: shopName(),
    notice: shopNotice(),
    operators: getShopOperators(),
    webhook: {
      url: kvGet(KV_WEBHOOK_URL) || '',
      hasSecret: !!(kvGet(KV_WEBHOOK_SECRET) || ''),
    },
  });
});

/** 店员管理（ownerOnly；白名单存 kv，鉴权实时读取；入审计） */
router.put('/staff', ownerOnly, wrap(async (req, res) => {
  const action = String(req.body?.action || '');
  const address = String(req.body?.address || '').trim().toLowerCase();
  if (!['add', 'remove'].includes(action)) return fail(res, 'action 需为 add / remove');
  if (!isAddress(address) || isZeroAddress(address)) return fail(res, 'address 需为 0x 开头的以太坊地址（零地址不可加入）');
  const owner = (config.shop.owner || '').toLowerCase();
  if (address === owner) return fail(res, '店主无需加入店员名单（店主权限恒高于店员）');
  const list = getShopOperators();
  const next = action === 'add' ? [...new Set([...list, address])] : list.filter((a) => a !== address);
  kvSet(KV_OPERATORS, JSON.stringify(next));
  audit(req, 'staff.' + action, 'shop', address, { operators: next.length });
  ok(res, { operators: next }, action === 'add' ? `已添加店员 ${address.slice(0, 10)}…（经营面可用，财务/审计面仍仅店主）` : `已移除店员 ${address.slice(0, 10)}…`);
}));

/** 通知 webhook 配置（ownerOnly；url 留空=停用通知；secret 留空=不签名） */
router.put('/webhook', ownerOnly, wrap(async (req, res) => {
  const { url, secret } = req.body || {};
  if (url === undefined && secret === undefined) return fail(res, '需提供 url 或 secret');
  const nextUrl = url !== undefined ? String(url).trim().slice(0, 500) : kvGet(KV_WEBHOOK_URL) || '';
  const nextSecret = secret !== undefined ? String(secret).trim().slice(0, 200) : kvGet(KV_WEBHOOK_SECRET) || '';
  if (nextUrl && !/^https?:\/\//i.test(nextUrl)) return fail(res, 'webhook url 需为 http(s):// 开头');
  kvSet(KV_WEBHOOK_URL, nextUrl);
  kvSet(KV_WEBHOOK_SECRET, nextSecret);
  audit(req, 'webhook.update', 'shop', '-', { urlSet: !!nextUrl, secretSet: !!nextSecret });
  ok(res, { url: nextUrl, hasSecret: !!nextSecret }, nextUrl ? '通知已启用（关键事件将 POST 到该地址；接收方应按 eventId 幂等）' : '通知已停用');
}));

/** 通知投递状态（ownerOnly）：最近若干次投递的结果——店主能看到"我的机器人到底收到没有" */
router.get('/webhook-status', ownerOnly, (req, res) => {
  ok(res, webhookStatus());
});

/** 发送一条测试事件（ownerOnly）：同步返回结果，失败原因直接显示在设置页 */
router.post('/webhook-test', ownerOnly, wrap(async (req, res) => {
  const r = await sendTestEvent();
  audit(req, 'webhook.test', 'shop', '-', { ok: r.ok });
  if (!r.ok) return ok(res, r, `测试事件投递失败：${r.error}`);
  ok(res, r, '测试事件投递成功（接收方应已收到 type=webhook.test 的 POST）');
}));

// ── 店铺身份声明（shop claim：店主钱包签名、可离线核验的外部身份声明）──
/*
  为什么要它：`code`（店铺编号）解决"唯一"，不解决"哪个才是官方那家"——编号本身不带外部身份。
  本组端点让店主用钱包**对一段规范消息签名**，把 domain / github / x / telegram 绑定到店铺地址上；
  任何人都能拿 message + signature 重算 `ethers.verifyMessage` 离线核验，**不需要信任节点**。
  节点只做存储与转发。⚠️ 它证明"某个地址签过这句话"，**不证明**那个域名/账号真的属于他——
  归属核验（DNS TXT / gist / OAuth）不在本机制内，故对外**不得**标成"已认证/官方"。
*/

/** 声明行的对外形状（公开列表与写回执共用一份，避免两处各拼一遍字段） */
function claimDto(row) {
  return {
    // id 是 SQLite 自增整数，但对外**下发字符串**：前端类型 `ShopClaim.id` 是 string
    // （撤销走 URL 路径段，字符串与数字都能拼，但类型不一致会让 TS 端在其它用法上出错）。
    id: String(row.id),
    kind: row.kind,
    value: row.value,
    address: row.address,
    // message 与 signature **原样**下发：第三方离线重算用的就是这两个字节，
    // 任何"顺手规整一下"（去尾换行、重排字段）都会让重算出的地址与 address 不一致。
    message: row.message,
    signature: row.signature,
    createdAt: row.created_at,
  };
}

/**
 * 解析"本店是谁"：operator + 店铺编号 —— **复用既有只读路径**，不新起第二个真相源。
 *
 * operator = `config.shop.owner`（本节点全部订单/鉴权/登记都已把它当店主地址，是唯一来源）；
 * 编号 = `src/shopCode.js` 的 `Registry.codeOf(operator)`（30s 缓存；读不到返回 ''，绝不编造——
 * RPC 失败时它会沿用 30 秒内**读到过**的那个编号，那仍是读到过的值，不是编造）。
 * 编号的意义在于：消息里要写 `code:` 行，**签名因此覆盖了"这条声明属于哪家店"**——
 * 换一家店的 code 就是另一段消息，签名对不上。
 *
 * 三态纪律：读不到就**如实报"暂无法核验店主身份"并拒绝落库**，绝不"先存着"——
 * 未经核验的声明一旦进了公开列表，第三方会把它当成"店主签过"（它并没有）。
 * @returns {Promise<{operator: string|null, code: string|null, reason: string|null}>}
 */
async function resolveShopIdentity() {
  const operator = String(config.shop.owner || '').trim().toLowerCase();
  if (!isAddress(operator) || isZeroAddress(operator)) {
    return { operator: null, code: null, reason: '节点未配置合法的店主地址（MK_SHOP_OWNER）' };
  }
  const code = await shopCode();
  if (!code) {
    return {
      operator,
      code: null,
      reason: '节点还没读到本店编号（Registry 不可达 / 本店尚未在链上登记 / 未配置 MK_REGISTRY_ADDRESS）',
    };
  }
  return { operator, code, reason: null };
}

/**
 * 公开列表的限流：与其他公开只读端点同款（联邦前端的店主主页会扇出到每个可达节点，
 * 60 次/分足够"一屏几十家店 × 几次页面切换"）。同样是**单进程内存窗口**，
 * 多实例部署需网关层兜底（见 docs/OPS_RUNBOOK §4）。
 */
const claimsLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '店铺身份声明查询过于频繁，请稍后再试' });

/**
 * 提交一条身份声明（ownerOnly）：`{kind, value, issued, signature}`。
 *
 * ⚠️ **签名的字节就是提交的字节**（铁律，见 src/claims.js 文件头）：`kind` / `value` / `issued`
 * **逐字**进消息——不 trim、不折大小写、不补当天。归一**只发生在拒绝这一侧**：
 * 值不是规范形就直接拒绝并告诉店主该写成什么、该对哪条消息重签；
 * 绝不允许"先替店主归一、再用归一后的值去验签"（那样客户端签原文永远验不过，
 * 而错误看起来只是"签名不对"，排查成本极高）。
 *
 * `issued` **必须由请求体给出**（`YYYY-MM-DD`）：它是被签名覆盖的文本的一部分，
 * 节点**不替客户端补当天**——日期是跨时区最容易漂移的一环（同一时刻两端可能不是同一天），
 * 节点自己生成会让"店主签的那天"与"节点算的那天"不同，表现是验签失败且极难定位。
 * 缺失/形状非法 ⇒ 报可读中文错（要求客户端显式给出）。
 *
 * 声明值长度上限：**逐字 ≤ 320 字符**（各类 kind 另有更紧的形状规则，见 src/claims.js），
 * 超限直接拒绝而不是截断——截断后的域名/仓库名会变成一个
 * "看起来合法但完全不是他声明的东西"。
 *
 * 幂等：同 (kind, value, address) 在库里只有一行（唯一索引）；完全相同的重发**不改行、不新增**，
 * 已撤销后重新声明则恢复生效（按新签名覆盖 message/signature 并刷新 createdAt）。
 * 每一种情况都写审计，detail 里带 duplicate/revived 以便区分"真的新声明"与"重复提交"。
 */
router.post('/claims', ownerOnly, wrap(async (req, res) => {
  const { kind, value, issued, signature } = req.body || {};
  const me = await resolveShopIdentity();
  if (me.reason) {
    return fail(res, `暂无法核验店主身份：${me.reason}——请稍后重试（未通过核验的声明一律不落库）`);
  }
  // ① 校验（**拒绝**而不是变换）：请求里的值必须**逐字**就是规范形，否则不进入验签
  const check = checkClaimValue(kind, value);
  if (!check.ok) {
    /*
      归一**只出现在这条错误信息里**：告诉店主该改成什么，并给出"改成规范形后应当签的那条消息"。
      这一段**不参与**验签，也绝不会被写进库——它只是让店主一次就能改对。
      （`canonical` 为 null 时连规范形都得不出来，例如非字符串/超长/空值，就只能给原因。）
    */
    const suggested =
      check.canonical === null
        ? null
        : (() => {
            try {
              return buildClaimMessage({ code: me.code, operator: me.operator, kind, value: check.canonical, issued });
            } catch {
              return null; // issued 也就缺/非法：先让店主把它补齐，下一步再报
            }
          })();
    return fail(
      res,
      suggested
        ? `${check.reason}。\n请改成规范形后，用店主钱包对下面这条消息原文重新签名：\n${suggested}`
        : check.reason
    );
  }
  // ② 用请求体**原样**字段构造消息（不归一、不生成日期）：kind/value/issued 逐字进消息
  let message;
  try {
    message = buildClaimMessage({ code: me.code, operator: me.operator, kind, value, issued });
  } catch (e) {
    return fail(res, e.message);
  }
  // ③ 验签：验的就是上面那条逐字拼出来的消息
  const v = verifyClaim({ message, signature, expectedOperator: me.operator });
  if (!v.ok) {
    /*
      验签失败时把**这条消息**回给店主：前端一旦按别的字节（例如自己先做了归一）去签，
      两边算出的消息就不是同一串。给出确切字节，店主重签一次即可，不必去猜"哪里不一样"。
      消息本身是公开信息（它最终要原样下发），不构成泄露。
    */
    return fail(
      res,
      `签名核验不通过：${v.reason}。\n签名覆盖的就是提交的字节（节点不做任何归一）。请用店主钱包对下面这条消息原文签名后重试：\n${message}`
    );
  }
  const db = getDb();
  const now = Date.now();
  /*
    落库口径：`value` 存**签名覆盖的那个原文**（校验通过时它就是规范形，二者相等——不存在
    "归一值"与"原文"两份真相）；`kind` 同理（校验已保证它是逐字的规范 kind）。
  */
  const signedValue = value;
  const signedKind = kind;
  const existing = db
    .prepare('SELECT * FROM shop_claims WHERE kind = ? AND value = ? AND address = ?')
    .get(signedKind, signedValue, me.operator);
  let id;
  let duplicate = false;
  let revived = false;
  if (!existing) {
    id = Number(
      db
        .prepare(
          'INSERT INTO shop_claims (kind, value, address, message, signature, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'
        )
        .run(signedKind, signedValue, me.operator, message, String(signature), now).lastInsertRowid
    );
  } else if (existing.revoked_at === null && existing.message === message && existing.signature === String(signature)) {
    // 完全相同的重发：**幂等**——不改行、不新增、不动 createdAt（否则每次重发都像"重新声明了一次"）
    id = existing.id;
    duplicate = true;
  } else {
    // 已撤销后重新声明（恢复生效）或换了一份新签名（issued 不同）：同一行按最新签名覆盖。
    // createdAt 也随之刷新：它表示"现在这一行的声明时刻"，而不是历史上第一次声明的时刻
    // （那一次的时间与撤销都留在审计里，见 action=shop.claim / shop.claim.revoke）。
    revived = existing.revoked_at !== null;
    id = existing.id;
    db.prepare('UPDATE shop_claims SET message = ?, signature = ?, created_at = ?, revoked_at = NULL WHERE id = ?').run(
      message,
      String(signature),
      now,
      id
    );
  }
  audit(req, 'shop.claim', 'shop_claim', String(id), { kind: signedKind, value: signedValue, duplicate, revived });
  const row = db.prepare('SELECT * FROM shop_claims WHERE id = ?').get(id);
  ok(
    res,
    claimDto(row),
    duplicate
      ? '该声明此前已提交过（幂等：未产生新记录）'
      : revived
        ? '该声明此前已撤销，现按新签名恢复生效'
        : '声明已记录：第三方可用 verifyMessage(message, signature) 离线核验其签名与 operator 是否一致'
  );
}));

/**
 * 公开列出**有效**声明（已撤销的不出现）。
 *
 * 只呈现**原始事实**：message / signature / address / kind / value / createdAt——
 * 刻意**不加**任何"已认证 / 官方 / verified"字段：节点能证明的只有"这个地址签过这句话"，
 * 证明不了"这个域名真是他的"（见文件头）。把它标成认证，就是在替第三方做一个做不了的判断。
 * 核验方式（响应 message 里也写了一遍，界面/脚本照做即可）：对每条重算
 * `ethers.verifyMessage(message, signature)`，与 address 比对。
 *
 * 形状 `{ claims: [...] }` 而不是裸数组：与其它列表端点一样留出扩展位（将来要加 total/截断标记
 * 时不至于为了一个字段改整个响应形状）。
 */
router.get('/claims', claimsLimiter, (req, res) => {
  const rows = getDb().prepare('SELECT * FROM shop_claims WHERE revoked_at IS NULL ORDER BY id ASC').all();
  ok(
    res,
    { claims: rows.map(claimDto) },
    '声明由店主钱包签名，可离线核验：重算 ethers.verifyMessage(message, signature) 并与 address 比对即可（无需信任本节点）；节点不判定域名/账号归属'
  );
});

/**
 * 撤销一条声明（ownerOnly）：置 `revoked_at`，此后不再出现在公开列表。写审计。
 * 幂等：已撤销的再撤一次只回执"此前已撤销"，不改行、不写第二条审计（没有发生变化）。
 * `id` 非法/不存在都如实报（404），不静默成功——店主以为撤了、实际没撤是最坏的形态。
 */
router.post('/claims/:id/revoke', ownerOnly, wrap(async (req, res) => {
  const id = Number(String(req.params.id ?? '').trim());
  if (!Number.isInteger(id) || id <= 0) return fail(res, 'id 需为声明的正整数编号');
  const db = getDb();
  const row = db.prepare('SELECT * FROM shop_claims WHERE id = ?').get(id);
  if (!row) return fail(res, '声明不存在', 404, 404);
  if (row.revoked_at !== null) {
    return ok(res, claimDto(row), '该声明此前已撤销（幂等：未产生新记录，也不重复写审计）');
  }
  const now = Date.now();
  db.prepare('UPDATE shop_claims SET revoked_at = ? WHERE id = ?').run(now, id);
  audit(req, 'shop.claim.revoke', 'shop_claim', String(id), { kind: row.kind, value: row.value });
  ok(res, claimDto(db.prepare('SELECT * FROM shop_claims WHERE id = ?').get(id)), '声明已撤销（不再出现在公开列表）');
}));

/** 履约画像（公开只读聚合统计，口径见 reputation.js 头注释——不下发单笔订单） */
router.get('/reputation', reputationLimiter, (req, res) => {
  ok(res, reputationSummary());
});

/**
 * 质押跌破注册门槛的店主清单（公开只读；口径、事实源与取舍见 src/stakingRisk.js 文件头）。
 *
 * 为什么是公开只读：数据全部来自链上公开状态（Registry 的活跃店主集合 + Staking.poolOf +
 * 门槛值），任何第三方扫链都能复算；把它藏起来只会让"这家店还够不够赔"变成只有平台知道的事。
 * 为什么挂在店铺面而不是新开一个 /api/governance：本仓"单节点 = 一家店"，治理读数的消费方
 * 就是店主面板/巡检脚本，已有 /reputation、/reviews/stats 这类公开读数都在这里。
 * 限流与缓存：端点自身走 stakingRisk 的 30s 记忆化（一轮 RPC 覆盖 30 秒内的所有请求），
 * 再加一层比 /reputation 更紧的限流——它每次读都是"1 + N"次链上调用（N = 全网活跃店数），
 * 比全表统计更贵。
 */
const stakingLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: '质押门槛读数查询过于频繁，请稍后再试' });
router.get('/staking', stakingLimiter, wrap(async (req, res) => {
  ok(res, await stakingShortfall({ force: String(req.query.refresh || '') === '1' }));
}));

/** 店铺买家评价聚合（公开只读：count/avg——与履约画像互补的主观质量信号） */
router.get('/reviews/stats', reviewsStatsLimiter, (req, res) => {
  ok(res, shopReviewStats());
});

// ── 运营读数（ownerOnly 私域；口径与唯一实现见 src/buyerSignal.js / src/opsMetrics.js）──

/*
  三个端点的限流：都只读本店数据，但都可能触链（metrics/sla 读释放阈值与挂账余额）或做全表聚合
  （buyer-signal 走履约画像的同一套事件解析）。店主面板按分钟级轮询，60/30 次每分钟留了几十倍余量；
  与既有只读端点一样是**单进程内存窗口**，多实例部署需网关层兜底（见 docs/OPS_RUNBOOK.md §4）。
*/
const buyerSignalLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '买家履约信号查询过于频繁，请稍后再试' });
const metricsLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: '运营指标查询过于频繁，请稍后再试' });
const slaLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: 'SLA 读数查询过于频繁，请稍后再试' });

/**
 * 买家履约信号（ownerOnly 只读）：**该买家在本店**的争议/退款/确认收货/超时释放分布。
 *
 * 为什么是 ownerOnly：它把"某个地址在这家店买过什么、退过什么款、有没有争议"摆在一起，
 * 是**店主视角的经营数据**，不是公开画像（公开画像只出聚合计数，见 /reputation，且不含买家维度）。
 * 为什么必须带 address：本读数就是"针对一个具体买家"的，没有缺省主体可言——
 * 缺参数/非法地址一律明确拒绝，不猜、不回落成"全部买家"。
 * 口径、隐私边界（**不为任意地址去查其它节点**）与文案纪律（可疑信号而非结论）见 buyerSignal.js。
 */
router.get('/buyer-signal', ownerOnly, buyerSignalLimiter, (req, res) => {
  const address = String(req.query.address || '').trim().toLowerCase();
  if (!isAddress(address) || isZeroAddress(address)) {
    return fail(res, 'address 需为 0x 开头的以太坊地址（零地址没有履约历史可谈）');
  }
  ok(res, buyerSignal(address));
});

/**
 * 运营指标（ownerOnly 只读）：待处理退款 / 在途售后案件 / 待仲裁争议（各带最久等待）、
 * 托管中与已超时单数、对账最近一轮与差异数、挂账余额、订单各状态计数。
 * 全部读数取自既有唯一实现（见 src/opsMetrics.js 文件头）；读不到的一律 available:false + reason。
 */
router.get('/metrics', ownerOnly, metricsLimiter, wrap(async (req, res) => {
  // 对账快照由路由取（唯一事实源），再交给 opsMetrics 组装——避免 opsMetrics ↔ routes/orders 循环依赖
  ok(res, await opsMetrics({ reconcile: chainReconcileStatus() }));
}));

/**
 * 卖家 SLA 读数（ownerOnly 只读）：未发货超期清单（最久的 N 条）、待店主回复的退款申请、
 * 在途售后案件，以及发货时长中位数/P90（样本不足置 null 并说明）。
 * "超期"以链上 `releaseNotBeforeBlock` 被当前块高跨过为准，不是本地按块时间估算（见 opsMetrics）。
 */
router.get('/sla', ownerOnly, slaLimiter, wrap(async (req, res) => {
  const raw = req.query.limit;
  const limit = raw === undefined || raw === '' ? SLA_LIMIT_DEFAULT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > SLA_LIMIT_MAX) {
    return fail(res, `limit 需为 1..${SLA_LIMIT_MAX} 的整数（缺省 ${SLA_LIMIT_DEFAULT}）`);
  }
  ok(res, await slaReading({ limit }));
}));

// ── 经营看板（P1-①，ownerOnly 私域；口径见 src/stats.js）──

/** 汇总卡（缺省 30；days=0 全量；D7 钳制与归一见 stats.normalizeStatsDays） */
router.get('/stats/overview', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 30);
  if (days === null) return fail(res, 'days 无效（需非负整数；0=全量；上限 366 天）');
  await refreshFeeCollector(); // 净额按每单的创建时收费方快照判定；全局口径只作兜底与披露（见 src/fees.js）
  ok(res, { ...overviewStats(days), ...feeStatus() });
}));

/** 最近 N 天趋势（缺省 14，补零；D6 自然日对齐见 stats.trendStats） */
router.get('/stats/trend', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 14);
  if (days === null) return fail(res, 'days 无效（需正整数；上限 366 天）');
  if (days === 0) return fail(res, 'trend 需正整数天数（不支持全量）');
  await refreshFeeCollector();
  ok(res, { days, items: trendStats(days) });
}));

/** 商品排行（sort=gmv|orders|refund；缺省 30 天；days=0 全量） */
router.get('/stats/products', ownerOnly, wrap(async (req, res) => {
  const days = normalizeStatsDays(req.query.days, 30);
  if (days === null) return fail(res, 'days 无效（需非负整数；0=全量；上限 366 天）');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  await refreshFeeCollector();
  ok(res, productStats(days, String(req.query.sort || 'gmv'), page, pageSize));
}));

export default router;
