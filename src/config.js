/**
 * 节点配置：全部经环境变量注入（.env / docker env），并提供默认值。
 *
 * 店铺模型：一个节点实例 = **一库多店**。`node.owner`（由 MK_SHOP_OWNER 种入 `node` 单例行）
 * 是**节点 operator**——本节点 Escrow/Staking 的 owner；店铺是独立租户行
 * （`shops.seller` 才是店主），**由本节点审批创建**，全部在链下。
 * 节点不读取任何 Registry；目录登记由 operator 钱包在客户端按目标目录完成。
 * 商品上架/发货等写操作由 `roleOf(address, shopCode)` 判"他在**这家店**里是什么角色"。
 *
 * 零费模型：没有平台费、没有节点抽成；托管结算只有买家/卖家两条腿。
 *
 * 环境变量注入：启动时经 `node --env-file-if-exists=.env` 加载（见 package.json scripts）。
 */
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 同 intEnv，但允许显式 0（0 = 关闭该特性；缺失/非法才回退默认值） */
function intEnvAllowZero(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

/**
 * 已配置的合约地址必须是**非零的 20 字节 hex**（唯一判据）。
 *
 * 为什么在配置入口响亮失败：`MK_ESCROW_ADDRESS=0x000…0`（或少一位、粘进一段说明文字）时
 * 节点会**照常启动**——watcher 起来了、每轮也扫，但永远扫不到任何事件（零地址上没有代码），
 * 表现为"节点是活的、订单永远不推进"，日志里一个字都没有。README/.env.example 里那句
 * "不要填零地址"是文档，不是判据；判据必须先于任何消费点成立。
 *
 * 空串是合法的：它明确表示"未接入该能力"（纯展示节点），由各功能自行降级并如实说明。
 */
const CHAIN_ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
function chainAddressOf(name, raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return '';
  if (!CHAIN_ADDRESS_SHAPE.test(v)) {
    throw new Error(
      `${name}=${JSON.stringify(v)} 不是合法的合约地址：需要 0x + 40 位十六进制（20 字节）。` +
        '这一项决定节点连的是哪个合约；填错的症状是"节点照常启动、但永远读不到链上事件"，所以拒绝启动。'
    );
  }
  if (v.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      `${name} 是零地址（0x000…0）：零地址上没有合约代码，节点会启动但永远扫不到任何事件。` +
        '若只是暂不接入该能力，请把它留空（= 未配置），不要填零地址。'
    );
  }
  return v;
}

/**
 * 反向代理信任边界（`MK_TRUST_PROXY`）——**X-Forwarded-For 的唯一解析点**。
 *
 * 默认关闭（`false`）：相信任意客户端自带的 XFF 等于让任何人伪造来源 IP（限流换桶、
 * 审计里写假地址）。取值：
 *   · 留空            ⇒ 不信任任何代理（`req.ip` = TCP 对端地址）；
 *   · `loopback`      ⇒ 只信任本机回环上的代理（本机 Caddy/nginx 的场景）；
 *   · CIDR/IP 列表    ⇒ 例如 `10.0.0.0/8,172.17.0.0/16`（逗号分隔）；
 *     也接受单个 IP。非法值在配置入口抛错：让 Express 在请求期才抛（或更糟：静默按
 *     不匹配处理）都会把"反代之后所有人共用一个限流桶"变成看不见的现场。
 *
 * 代价如实写明：不配置时，反代后面的节点把**所有匿名客户端**记成同一个 IP——
 * 一人刷满 `/login` 60 次/分即全网登不上，审计里的 ip 也恒为代理地址。
 * 所以 `clientIp()` 在第一次收到带 XFF 的请求时会大声告警（见 src/http.js）。
 */
function trustProxyOf(raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return false;
  if (v === 'loopback') return 'loopback';
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  for (const p of parts) {
    // Express 的 trust proxy 数组同时接受 'loopback' 和 CIDR；混合写法是默认部署拓扑。
    if (p === 'loopback') continue;
    const pieces = p.split('/');
    if (pieces.length > 2 || !pieces[0] || !isIP(pieces[0])) {
      throw new Error(
        `MK_TRUST_PROXY=${JSON.stringify(v)} 非法：只支持空（关闭）、loopback、或逗号分隔的 IP/CIDR 列表。` +
          `无法解析的项是 ${JSON.stringify(p)}。`
      );
    }
    if (pieces.length === 2) {
      const max = isIP(pieces[0]) === 6 ? 128 : 32;
      const bits = Number(pieces[1]);
      if (!Number.isInteger(bits) || bits < 0 || bits > max) {
        throw new Error(
          `MK_TRUST_PROXY 的网段 ${JSON.stringify(p)} 非法：前缀长度需为 0..${max}（IPv${isIP(pieces[0])}）。`
        );
      }
    }
  }
  return parts;
}

/**
 * 配置层的**版本唯一真相**：`node/package.json` 的 `version`。
 *
 * `/healthz`、`/api/shop`、`/api/shop/node-identity` 都读 `config.version`，
 * 不在各接口里抄字面量——抄三份的结果是版本一升，某一个接口继续报旧版本（静默假话）。
 */
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * 节点默认名：只在"没设置过节点名、也没有对外域名"时用。
 *
 * 为什么不编一个固定的中文默认名：联邦目录里"这台机器叫什么"必须能区分不同节点，
 * 所有没设置过的节点印同一句话等于没有名字；而域名正是这台机器在链上登记的 endpoint
 * 与 SIWE 签名原文里用的**同一个身份**（见 `resolveNodeDomain()`），不再另造第二个标识。
 */
export const DEFAULT_NODE_NAME = '未命名节点';

/**
 * 节点对外域名的**唯一解析**（`MK_SIWE_DOMAIN` → `MK_REGISTER_ENDPOINT`，第一个非空生效）。
 *
 * 两个消费点必须同源，否则同一台机器会在钱包弹窗里叫一个域名、在目录里叫另一个名字：
 *   · `auth.js` 的 `resolveSiweIdentity()`：SIWE 签名原文里的 domain/URI；
 *   · `shops.js` 的 `nodeDisplayName()`：节点没设置过名字时的默认名。
 *
 * 为什么不是"import 时读一次存常量"：测试进程各自注入环境变量（见 db 那几个 getter 的说明），
 * 每次调用动态读环境变量，测试才能注入；部署期改 `.env` 也立刻生效。
 *
 * 返回值：`{ domain, uri }`（`domain` = host[:port]，`uri` = `<协议>//<host>/`）；
 * 没有或解析不了返回 `null`——**不编一个域名**（编出来的域名会让两台不同的节点长得一样）。
 */
export function resolveNodeDomain() {
  const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/i;
  const raw =
    String(process.env.MK_SIWE_DOMAIN || '').trim() || String(process.env.MK_REGISTER_ENDPOINT || '').trim();
  if (!raw) return null;
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const u = new URL(withScheme);
    const host = u.host; // host[:port]（URL 自动小写 hostname）
    const uri = `${u.protocol}//${u.host}/`;
    // 域名形态健全性：host[:port]、无路径/query/userinfo；异常值按"没有域名"处理
    if (host && HOST_RE.test(host)) return { domain: host, uri };
  } catch {
    /* raw 无法解析为 URL：按"没有域名"处理，由调用方走各自的兜底 */
  }
  return null;
}

/**
 * PII 保留期（天，MK_PII_RETENTION_DAYS，默认 180；显式 0 = 关闭周期擦除）。
 * 语义：**资金流已终结**的订单（confirmed/settled/refunded/expired/cancelled）静置超过 N 天后，
 * 其收货信息/买家备注/售后陈述正文/证据附件由 src/piiErase.js 自动擦除（金额、状态、链上单号、
 * 支付哈希、事件史与不带 PII 的评价一律保留——账目与链上凭证不可删）。
 * 非终局订单（draft/escrowed/shipped/disputed）**永不**自动擦除：卖家还得靠收货信息发货。
 * 单独具名导出：piiErase.js 与单测直接读它，不必为改一个阈值去重载整个 config。
 */
export const PII_RETENTION_DAYS = intEnvAllowZero('MK_PII_RETENTION_DAYS', 180);

/**
 * `POST /api/shop/retention/run` 的**结果复用窗口**（毫秒，`MK_PII_RETENTION_REUSE_MS`，默认 2000）。
 *
 * 同一 `days` 的重复请求在这个窗口内直接拿上次结果——它挡的是"前端超时重试/连点"，那会让
 * 同一份重活跑第二遍而第二遍通常什么都擦不到。**它不是单飞闸**（真正的单飞在内核里，
 * 见 routes/pii.js 的说明）。
 *
 * 为什么做成配置而不是写死在路由里：**测试要能把它拉长**。它是个时间窗，而测试在它两侧还要
 * 造一张新的到期单（建草稿 → 托管 → 应用链上事件 → 改时间），那段准备在共享 MySQL 上
 * 可能超过 2 秒 —— 于是"复用"那条断言会因为**测试自己的准备耗时**而随机变红，
 * 与产品行为无关（本会话实测踩到过一次：769 例里就它一条红）。拉长窗口让判据
 * 只回答"复用机制在不在"，不回答"这台机器多快"。
 */
export const PII_RETENTION_REUSE_MS = intEnvAllowZero('MK_PII_RETENTION_REUSE_MS', 2000);

/**
 * **优雅关闭的等待上限**（毫秒，`MK_SHUTDOWN_DRAIN_MS`，默认 10000）。
 *
 * 收到 SIGTERM/SIGINT 后：立刻停止接受新连接 → 等在途请求把响应写完 → 关连接池 → 退出。
 * 超过这个上限就**强制退出**（并在日志里说"有几个请求没写完"）。
 *
 * 为什么要上限：没有它，一次卡住的请求（客户端读得极慢、或某个 handler 卡在未超时的
 * 外部调用上）会让进程**永远不退出**，而容器编排在宽限期过后还是会 SIGKILL ——
 * 结果是"我们自己以为在优雅关闭，实际什么都没关成"。上限让"优雅"这件事有界。
 *
 * 为什么默认 10 秒：与常见编排的默认宽限期同量级（Docker 10s、k8s 30s）。
 * 调大它的前提是宽限期也一起调大，否则等于没调。
 */
export const SHUTDOWN_DRAIN_MS = intEnv('MK_SHUTDOWN_DRAIN_MS', 10_000);

const config = {
  /** 对外声称的版本号（唯一真相 = `package.json`，见 `PKG_VERSION` 的说明） */
  version: PKG_VERSION,

  port: intEnv('MK_PORT', 8080),

  /** 优雅关闭的等待上限（见 `SHUTDOWN_DRAIN_MS` 的说明）。放进 config 是为了让 server.js 与
   *  `/healthz` 之外的运维脚本读同一个值，而不是各自 `process.env` 解析一遍。 */
  shutdownDrainMs: SHUTDOWN_DRAIN_MS,

  shop: {
    // 节点 operator 钱包地址（0x...），必填——Escrow/Staking 的 owner，
    // 也是节点级鉴权（isHost）的唯一锚点。节点不向任何 Registry 自报身份；
    // 换 operator = 换一台机器（重新部署 + 各目录自行登记）。
    owner: process.env.MK_SHOP_OWNER || '',
    // 店名/公告/店员名单/通知 webhook 等经营参数一律是库里的列/行，
    // 在卖家面板「店铺设置」网页维护，不在配置文件出现。
  },

  /**
   * 开店申请准入。免费 SIWE 的写入口：限流按 IP 挡不住"多 IP、多钱包"，
   * 待审批队列必须有一个节点级容量上限，否则审核面会被灌到不可用。
   * `0` = 不设上限（只建议在受控测试环境使用）。
   */
  applications: {
    maxPending: intEnvAllowZero('MK_MAX_PENDING_APPLICATIONS', 500),
  },

  chain: {
    rpcUrl: process.env.MK_RPC_URL || 'https://node1.bityuan.com/eth',
    chainId: intEnv('MK_CHAIN_ID', 2999),
    // 托管/注册合约地址：代码不写死任何默认地址，由部署方经 .env 注入
    // （本节点只读自己的 Escrow/Staking；不读 Registry，目录登记由 operator 钱包在客户端完成）；
    // 留空 = 未接入对应能力（无 escrow 时仅浏览展示，不可下单）
    // 托管地址；支付资产是原生 BTY + 由节点库 payment_tokens / Escrow.supportedToken 双重准入的 ERC20
    escrowAddress: chainAddressOf('MK_ESCROW_ADDRESS', process.env.MK_ESCROW_ADDRESS),
    /*
      本节点的保证金合约（节点部署，与 escrow 一对一）。留空 = 未接入保证金层：
      卖家不能质押，罚没/提货赔付路径不可用；节点仍可下单（托管本身不依赖 staking）。
    */
    stakingAddress: chainAddressOf('MK_STAKING_ADDRESS', process.env.MK_STAKING_ADDRESS),
    /*
      2026-10-18：删掉 `MK_ARBITER_ADDRESS`。仲裁人是**链上当前届委员会**（多个地址 + 阈值），
      节点侧只读 `Escrow.arbiters()`（见 chain.getCommittee）；留一份本地配置就是第二份真相——
      它会让"已经解除的仲裁人"在节点侧继续被当成仲裁人，而链上早已不能裁决。
    */
  },

  escrow: {
    // 托管超时（区块数）：BTY 5 秒/块 → 7 天 ≈ 120960 块
    timeoutBlocks: intEnv('MK_ESCROW_TIMEOUT_BLOCKS', 120960),
    // 事件轮询间隔（毫秒）
    pollIntervalMs: intEnv('MK_ESCROW_POLL_MS', 15000),
    // 起始扫描块：部署后按需调整（0 = 从最新块开始）
    startBlock: intEnv('MK_ESCROW_START_BLOCK', 0),
    /*
      确认深度（区块数）：只处理「链头 − N 块」之前的事件，默认 12 块。
      BTY 约 5 秒/块 ⇒ 约 1 分钟的安全余量，用来**消灭短重组造成的镜像错位**：
      重组只回放日志、不回滚已落地的终态（本地无反向迁移路径），所以「先落地再被重组掉」
      的事件会让订单永久停在错误终态（如 phantom refunded）。等待 N 块再处理即从源头规避。
      代价：状态回写延迟约 N×5 秒（本地 anvil 演示设 0 以获得即时回写，见 scripts/dev/dev-demo.mjs）。
      设 0 = 关闭（恢复到「事件一进块就处理」的旧行为）。
    */
    finalityBlocks: intEnvAllowZero('MK_ESCROW_FINALITY_BLOCKS', 12),
  },

  // 草稿订单（已锁定未支付）自动关闭 TTL（分钟）；超时未支付视为取消
  draftTtlMinutes: intEnv('MK_DRAFT_TTL_MINUTES', 30),

  review: {
    // 成交订单可评价窗口（天）：终局（confirmed/settled/expired）起 N 天内买家可提交评价
    ttlDays: intEnv('MK_REVIEW_TTL_DAYS', 30),
  },

  /*
    陈述时限（双方举证窗口；MK_DISPUTE_STATEMENT_DAYS，默认 7 天，0 = 关闭）。

    语义：**自"进入争议"或"售后案件开案"那一刻起 N 天内**可提交陈述**与证据附件**（两者同一道门控），
    过期提交被拒、拒因可读（判据本体只有一处：src/evidenceFiles.js 的 evidencePhaseError，
    不在路由层各判一次——陈述端点与附件上传端点必须同时收口，否则一侧拒了、另一侧照收 20MB 个人数据）。

    时间基准取**本地已镜像的链上时刻**，不另算一套：
      · 争议  = orders.updated_at（watcher 回写 disputed 的时刻，与仲裁队列的 disputedAt 同一口径）；
      · 案件  = orders.after_sale_opened_at（链上 AfterSaleOpened 的落库时刻）。
    只作用于**争议（arbitration）与售后案件（after_sale）**两个阶段：退款理由/退款回复是"申请-答复"
    的即时往来，链上另有它自己的时序，不套这条窗口。

    0 = 关闭该特性（陈述不限时，与加这个配置之前的行为逐字一致；订单 DTO 的倒计时字段同时为 null）；
    缺失/非法（空串、非数字、负数）回退默认 7。
    getter 动态读取（与 autoDeliver 同款）：改 env 即改即生效，测试也能在同一进程里切换两种口径。
  */
  dispute: {
    get statementDays() {
      return intEnvAllowZero('MK_DISPUTE_STATEMENT_DAYS', 7);
    },
  },

  // 个人信息保留期（PIPL 式删除请求的自动化那一半，见 src/piiErase.js）：
  // 显式删除请求走 POST /api/shop/orders/:id/erase-pii 立即生效，本键只管"到期自动擦除"
  pii: {
    retentionDays: PII_RETENTION_DAYS,
  },

  /*
    链上状态对账（src/chainReconcile.js）：watcher 只回放日志、从不回滚，链上已终局而本地
    仍停在非终态的订单会永久滞留（卖家发货/退款面板上一直是"待处理"）。对账轮询按间隔复查
    这类订单并以 watcher 同一套映射修复。间隔放宽到 10 分钟——对账是兜底路径（正常收敛由
    事件回写完成），间隔越短只是越早发现异常，代价是 RPC 读取次数。
  */
  reconcile: {
    intervalMs: intEnv('MK_CHAIN_RECONCILE_MS', 600_000),
  },

  webhook: {
    // 通知 URL/签名密钥为经营参数（kv + 店铺设置网页维护，见 webhook.js 动态读取）；
    // 此处仅保留投递运行参数
    timeoutMs: intEnv('MK_WEBHOOK_TIMEOUT_MS', 5000),
    // 失败重试退避基数（毫秒；测试可调小）
    retryBaseMs: intEnv('MK_WEBHOOK_RETRY_MS', 2000),
    // 店主（owner）登录即推 webhook 告警（'1' 开启；auth.owner_login 事件，含地址与来源 IP——
    // 店主自配的接收端；防钓鱼中继冒领 owner 令牌后不知情）
    get ownerLoginAlert() {
      return process.env.MK_OWNER_LOGIN_ALERT === '1';
    },
  },


  // 卡密自动交付：数字商品买家托管成功后，若码池有未用码则自动发码置 shipped
  //（免卖家手动发货）；'0' 关闭。getter 动态读取便于测试切换。
  get autoDeliver() {
    return process.env.MK_AUTO_DELIVER !== '0';
  },

  /*
    下单风控闸（MK_ORDER_GATE_URL，**默认关闭** = 留空）：
    「允许，不强制」的准入形状——联邦协议本身不做身份核验（匿名市场），
    但店主若恰好是持牌主体、或只是想加自己的风控（黑名单/地域/限购/内部 KYC），
    可以在建单前把这一单交给自己配置的服务问一句，服务说不行就不卖。
    这是**运营方自己的**策略执行点：节点只是把请求转发过去、按应答放行或拒单，平台不参与也不提供风控。

    数据最小化：只发订单本身的交易要素（商品/规格/数量/金额/买家卖家地址/时间），
    **永不**发收货人姓名/电话/地址/买家备注——风控服务不能变成个人信息外流通道（见 src/orderGate.js 白名单）。

    getter 动态读取（与 webhook.ownerLoginAlert / autoDeliver 同款）：URL 是运维参数，
    改 env 即改即生效；URL 非空即等于"本店已开启风控"，且**fail-closed**——
    风控服务不可达/超时/应答异常一律拒单（宁可少卖，也不在风控失效时静默放行）。
    不再需要风控请清空本键（留空 = 关闭，行为与未配置完全一致）。
  */
  orderGate: {
    get url() {
      return (process.env.MK_ORDER_GATE_URL || '').trim();
    },
    // 签名密钥（选填）：配置后请求带 x-mk-signature = HMAC-SHA256(密钥, 请求体原文)，
    // 与卖家通知 webhook（src/webhook.js）同一套方案——风控服务只需实现一个校验器
    get secret() {
      return process.env.MK_ORDER_GATE_SECRET || '';
    },
    // 单次请求超时（毫秒）：超时按"不可达"处理 → 拒单（fail-closed）；0/非法回退默认值
    get timeoutMs() {
      return intEnv('MK_ORDER_GATE_TIMEOUT_MS', 3000);
    },
  },

  rates: {
    /*
      只有一条腿（2026-10 标价单位由 CNY 改为 USDT 之后）：
      USDT 标价 → 原生 BTY 应付，唯一的换算是「USDT → BTY」，数据源是官方
      mainnet.bityuan.com/tapi/ticker（BTY-USDT）。它直接决定"买家要付多少 BTY"，要跟得紧，
      所以 TTL 默认 60 秒（MK_BTY_TTL_MS）。
      解析器用 intEnvAllowZero 而不是 intEnv：后者把 0 当成"没给"并回退默认值，
      于是 `MK_BTY_TTL_MS=0` 会**静默变成默认值**（历史真事，test/setup.mjs 里记过一笔）。
      0 = 每次请求都刷新（排障用，注意会打满上游）。
      已删除的键（旧实现里为"CNY 标价"服务的 USDT→CNY 法币腿）：
      MK_RATES_TTL_MS、MK_FALLBACK_USDT_CNY——USDT 标价不再需要任何法币汇率。
    */
    btyTtlMs: intEnvAllowZero('MK_BTY_TTL_MS', 60000),
    // 手工兜底汇率（行情源不可用时回退，并标记 stale）
    fallback: {
      // 1 BTY = x USDT
      btyUsdt: Number(process.env.MK_FALLBACK_BTY_USDT || 0),
    },
  },

  siwe: {
    // nonce 有效期（秒）
    ttlSeconds: intEnv('MK_SIWE_TTL', 600),
    /*
      登录令牌有效期（秒）。默认 30 天：前端把会话存在**本机**（localStorage），
      所以"这台设备上签一次名"的窗口就是它；1 天会让每天第一次打开都要再签一次。

      代价：令牌是无状态的 HMAC，服务端没有"吊销单个令牌"的入口——有效期多长，
      一枚泄露的令牌就能用多长（能力仍受每个请求的实时角色/链上状态约束，动钱仍要钱包签名）。
      要立刻让全部令牌失效只有换 `MK_TOKEN_SECRET`（所有人重新登录）。不想要这么长就调小。
    */
    tokenTtlSeconds: intEnv('MK_TOKEN_TTL', 2592000),
    /*
      HMAC 签名密钥（生产必须设置强随机值）。
      **刻意没有默认值**：留空即走 server.js 的 fail-fast（<32 字符 / 缺失一律 exit(1)）。
      这里曾经填过 `dev-insecure-secret-change-me`——那是仓库里可查的字面量，
      谁拿到都能离线伪造任意角色（含店主）的令牌；留着它只会让"默认能跑起来"变成一个陷阱。
    */
    secret: process.env.MK_TOKEN_SECRET || '',
  },

  /*
    MySQL 连接参数（**全节点唯一的持久化依赖**）。

    为什么把端口/账号/池大小都做成配置：旧实现是一个 SQLite 文件，连接参数不存在；
    换成 MySQL 之后这些值直接决定"能不能连上"和"能扛多少并发读"，必须可运维。

    ## 节点的数据模型：**一个节点一个库，节点里的店铺都在这个库里**

    库名（MK_DB_NAME）就是这个节点在那台 MySQL 上的身份，**不是**每家店一个库：
    店铺是库里的行（`shops` 表 + 商品/订单上的 `shop_code`），一库多店由租户表承担。
    同一台服务器上跑多个节点 ⇒ 每个节点填**不同的库名**，共用一个 MySQL 实例即可。
    "两个节点接同一个库"会被 db.js 的实例锁**拒绝启动**（见那里的说明）——那不是可配项。

    ## 这四个键**没有默认值**（缺失即拒绝启动，与 MK_TOKEN_SECRET 同款）

    `MK_DB_HOST` / `MK_DB_USER` / `MK_DB_NAME` 缺失或为空 ⇒ db.js 的 `assertDbConfigured()`
    带处置说明退出。为什么不给 `127.0.0.1` / `root` 这种"看起来能跑"的默认值：
    那会让一个**根本没配过数据库**的节点连到某台碰巧在本机、碰巧账号也对得上的库上，
    或者以一句 `ECONNREFUSED` /`Access denied` 失败——运维看不出"我还没配数据库"。
    数据库服务器是**接线**，接线必须显式（本仓口径：配置极简 = 只放身份与接线，而接线不留默认）。
  */
  db: {
    /*
      ⚠️ 这几个键一律走 **getter 动态读取**（与 autoDeliver / orderGate.url 同款），
      不是一次性快照。原因是测试：`node --test` 每个测试文件一个进程，各进程要把库名
      改成自己专属的那一个（`mk_test_<pid>_<随机>`）来互不干扰，而测试文件之间的 import 顺序
      并不能保证 config 先于别的业务模块被求值——快照式读取会让某个文件的库名悄悄回落到默认值，
      于是两个测试进程写同一个库（表现为随机失败，最难查的那一类）。
    */
    get host() { return (process.env.MK_DB_HOST || '').trim(); },
    // 端口不是身份，3306 是标准端口 ⇒ 保留默认值（只有它保留）
    get port() { return intEnv('MK_DB_PORT', 3306); },
    get user() { return (process.env.MK_DB_USER || '').trim(); },
    /*
      口令：空值**只在库就在本机时**才允许（见 db.js 的 assertDbConfigured）。
      远程库配一个空口令不是"简化"，是把它当成没有认证的库在用——那道门禁会拦下来。
    */
    get password() { return process.env.MK_DB_PASSWORD ?? ''; },
    /*
      本节点的库名。首次启动会自动建库（见 db.js 的 ensureDatabase），
      所以运维**不需要**预先手工 CREATE DATABASE——但库名必须由他指定。
    */
    get name() { return (process.env.MK_DB_NAME || '').trim(); },
    /*
      连接池大小。写事务现在**真的会并发**跑在不同连接上（没有全局写锁了，见 db.js 文件头），
      所以这个数同时决定了写并发度；调大到超过 MySQL 的 max_connections 会把节点自己挡在门外。
    */
    get poolSize() { return intEnv('MK_DB_POOL_SIZE', 10); },
    /*
      等**行锁**的上限（秒）。超过就报错而不是无限等——
      旧实现设的是 5 秒的 busy_timeout，语义相同（宁可让请求明确失败，也不要挂住整个节点）。
    */
    get lockWaitSeconds() { return intEnv('MK_DB_LOCK_WAIT_SECONDS', 10); },
  },

  /*
    证据附件的落盘根目录。旧实现默认"取数据库文件所在目录"，
    而 MySQL 没有库文件——留空时由 evidenceFiles.js 回落到进程工作目录下的 attachments/，
    容器部署必须用 MK_ATTACH_DIR 显式指向挂载卷。
  */
  get attachDir() { return process.env.MK_ATTACH_DIR || ''; },

  corsOrigin: process.env.MK_CORS_ORIGIN || '*',

  /**
   * 反向代理信任边界（见 `trustProxyOf` 的说明）。默认关闭；
   * `app.js` 用 `app.set('trust proxy', config.trustProxy)` 把它接到 Express——
   * 这是 XFF 的**唯一**解析点，限流/审计/请求日志都只消费解析后的 `req.ip`。
   */
  trustProxy: trustProxyOf(process.env.MK_TRUST_PROXY),

  /**
   * 允许在**类生产环境**下也反射任意 Origin（默认关）。
   *
   * 为什么需要这个开关（源码审计 2026-09 复审，P1）：`MK_CORS_ORIGIN` 缺省与 `.env.example`
   * 里都是 `*`，而 `*` 只在**非生产**生效（见 app.js 的 `isProdLike` 判定）——于是裸机/systemd
   * 部署（没设 NODE_ENV）会得到 `cors({origin:false})`，**完全不发 `Access-Control-Allow-Origin`**。
   * 而联邦前端/仲裁台本来就是从浏览器**跨域**轮询各家节点的，`docs/DEPLOY_NODE.md` 又写着
   * "默认 `*`"——照文档部署的结果是所有跨域调用被浏览器静默拦截、服务端零日志，故障形态是
   * "页面空白"。这里保留"生产不反射任意来源"的安全默认（接口用 Bearer 令牌、无 Cookie，
   * 但收紧仍是更好的默认），同时给出**显式**的放开开关，并让启动日志把当前口径喊出来。
   */
  corsAllowAll: process.env.MK_CORS_ALLOW_ALL === '1',
};

export default config;
