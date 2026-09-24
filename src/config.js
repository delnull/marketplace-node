/**
 * 节点配置：全部经环境变量注入（.env / docker env），并提供默认值。
 *
 * 店铺模型：一个节点实例 = 一家店；SHOP_OWNER 为该店的钱包地址，
 * 商品上架/发货等写操作要求 SIWE 签名地址 == SHOP_OWNER。
 *
 * 环境变量注入：启动时经 `node --env-file-if-exists=.env` 加载（见 package.json scripts）。
 */

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

/** 店铺默认名（首启/未在网页设置时使用；展示参数一律存 kv、网页编辑，不入配置文件） */
export const DEFAULT_SHOP_NAME = '我的联邦小店';

/**
 * PII 保留期（天，MK_PII_RETENTION_DAYS，默认 180；显式 0 = 关闭周期擦除）。
 * 语义：**资金流已终结**的订单（confirmed/settled/refunded/expired/cancelled）静置超过 N 天后，
 * 其收货信息/买家备注/售后陈述正文/证据附件由 src/piiErase.js 自动擦除（金额、状态、链上单号、
 * 支付哈希、事件史与不带 PII 的评价一律保留——账目与链上凭证不可删）。
 * 非终局订单（draft/escrowed/shipped/disputed）**永不**自动擦除：卖家还得靠收货信息发货。
 * 单独具名导出：piiErase.js 与单测直接读它，不必为改一个阈值去重载整个 config。
 */
export const PII_RETENTION_DAYS = intEnvAllowZero('MK_PII_RETENTION_DAYS', 180);

const config = {
  port: intEnv('MK_PORT', 8080),

  shop: {
    // 店主钱包地址（0x...），必填——卖家身份锚点（SIWE 鉴权/收款人）。
    // 唯一不可网页改的身份项：换店主=节点易主，走链上 transferNode 或关店重开。
    owner: process.env.MK_SHOP_OWNER || '',
    // 店名/公告/店员白名单/通知 webhook 等经营参数：见 docs/DECISIONS.md——
    // 一律存 kv 并在卖家面板「店铺设置」网页维护，不在配置文件出现。
  },

  chain: {
    rpcUrl: process.env.MK_RPC_URL || 'https://mainnet.bityuan.com/eth',
    chainId: intEnv('MK_CHAIN_ID', 2999),
    // 托管/注册合约地址：本仓库代码尚未部署到 2999 主网，代码中不含任何默认地址，
    // 必须由部署方部署后经 .env 注入（部署与登记见 docs/DEPLOY_NODE.md §4）；
    // 留空 = 未接入对应能力（无 escrow 时仅浏览展示，不可下单）
    // 支付币种全局约定为原生 BTY（2026-09 收敛：BTY 主网无 USDT/USDC 稳定币、
    // WBTY 同名合约泛滥，不再支持 ERC20 支付配置，消除假币/approve 攻击面）
    escrowAddress: process.env.MK_ESCROW_ADDRESS || '',
    registryAddress: process.env.MK_REGISTRY_ADDRESS || '',
    // 链上仲裁人地址（可选）：配置后免 RPC 即可开放订单详情「仲裁人视角」（裁决证据）；
    // 未配置时运行时读合约 arbiter() 并短缓存（RPC 失败安全降级：不开放视角）。
    // 注意：本配置只影响数据开放，链上裁决权限仍由合约 arbiter 唯一决定。
    arbiterAddress: process.env.MK_ARBITER_ADDRESS || '',
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

  // 证据附件存储目录（P0-2；默认 <db 目录>/attachments）
  attachDir: process.env.MK_ATTACH_DIR || '',

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
    「允许，不强制」的准入形状——联邦协议本身不做身份核验（匿名市场，见 docs/ARCHITECTURE.md），
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
      两条腿的缓存 TTL **分开**（2026-09）：BTY-USDT 与 USDT→CNY 是两种完全不同的上游，
      合成一个 TTL 必然二选一地吃亏（要么把官方 ticker 缓存到 15 分钟，要么为跟紧 BTY 把
      三家公共汇率接口打成每 3 分钟一轮）。
        · btyTtlMs（MK_BTY_TTL_MS，默认 60 秒）：官方 mainnet.bityuan.com/tapi/ticker 是
          **我们自己的**行情端点，且它直接决定"买家要付多少 BTY"，要跟得紧；
        · usdtCnyTtlMs（MK_RATES_TTL_MS，默认 30 分钟）：USDT→CNY 要打 3 家**免密钥公共接口**
          （Coinbase / er-api / frankfurter），缓存就是可用性——公共接口最容易因高频调用被限速，
          而人民币汇率本身一天动不了几个点。TTL 就是"每源每天多少请求"的分母：
          30 分钟 = 48 次/天，15 分钟 = 96 次/天，3 分钟 = 480 次/天（调小才容易被限速）。
      两者都可解析为 0 = 该腿每次请求都刷新（排障用，注意会打满对应上游）。
      解析器用 intEnvAllowZero 而不是 intEnv：后者把 0 当成"没给"并回退默认值，
      于是 `MK_RATES_TTL_MS=0` 会**静默变成默认值**（历史真事，test/setup.mjs 里记过一笔）。
      代价（明确记录）：USDT→CNY 最多滞后 30 分钟，行情剧烈波动时展示价与锁定价可能短期偏离；
      下单时草稿会锁定当次汇率，最终以买家签名的金额为准。
    */
    btyTtlMs: intEnvAllowZero('MK_BTY_TTL_MS', 60000),
    usdtCnyTtlMs: intEnvAllowZero('MK_RATES_TTL_MS', 1800000),
    // 手工兜底汇率（行情源不可用时回退，并标记 stale）
    fallback: {
      // 1 BTY = x USDT
      btyUsdt: Number(process.env.MK_FALLBACK_BTY_USDT || 0),
      // 1 USDT = x CNY
      usdtCny: Number(process.env.MK_FALLBACK_USDT_CNY || 0),
    },
  },

  siwe: {
    // nonce 有效期（秒）
    ttlSeconds: intEnv('MK_SIWE_TTL', 600),
    // 登录令牌有效期（秒）
    tokenTtlSeconds: intEnv('MK_TOKEN_TTL', 86400),
    // HMAC 签名密钥（生产必须设置强随机值）
    secret: process.env.MK_TOKEN_SECRET || 'dev-insecure-secret-change-me',
  },

  db: {
    // SQLite 文件路径（docker 部署挂卷到 /data）
    file: process.env.MK_DB_FILE || 'marketplace-node.db',
  },

  corsOrigin: process.env.MK_CORS_ORIGIN || '*',

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
