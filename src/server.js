/**
 * 节点服务入口：初始化 DB → 启动链上事件轮询（若已配置托管合约）→ 监听 HTTP。
 * 环境变量经 `node --env-file-if-exists=.env` 注入（见 package.json scripts）。
 */
import config from './config.js';
import { initDb, getDb } from './db.js';
import { startWatcher } from './escrowWatcher.js';
import { startChainReconcile } from './chainReconcile.js';
import { startOrderSweeper } from './orderSweeper.js';
import { startPiiRetentionSweep } from './piiErase.js';
import { cleanupExpiredSiwe } from './auth.js';
import { createApp } from './app.js';
import { shopName } from './routes/shop.js';
// 下单风控闸（可选，默认关闭）：启动日志 + 启动门禁（URL 非空但非法 ⇒ 拒绝启动）
import { orderGateEnabled, orderGateStartupError } from './orderGate.js';
import { applyEscrowAnchor } from './chainAnchor.js';

initDb();

/*
  库结构自检（源码评审 2026-10，P1）：本项目的约定是"全新项目、无存量数据，不做兼容/迁移，
  删库重建"（见 db.js 文件头）——**建表语句就是最终结构**，`CREATE TABLE IF NOT EXISTS` 对已存在的表
  是空操作。拿旧库（Docker 命名卷里的 `/data/marketplace-node.db`、或宿主机上的 `marketplace-node.db`）
  跑新镜像时，表里没有新列，而节点会"启动正常"却处处错位：商品价格显示 0、快照校验失败
  （买家看到假的「商品内容已被修改」）、售后案件状态永远是 none（仲裁队列空着而链上有案件）、
  缺列的那条 SQL 直接抛错——故障现象与原因相隔十万八千里。
  历史上标价单位由 CNY（分）改微 USDT 时就是这么爆的（当时只补了那几列）。所以这里的判据是
  **结构性的**：凡"当前代码必须存在"的列都在清单里，缺任何一列就拒绝启动，并把"怎么办"写进日志。
  ⚠️ 加了新列就要加进本清单（否则旧库会带着缺列的 schema 静默跑起来）。
*/
const REQUIRED_COLUMNS = {
  // media = 主图区（图片 + 视频）；旧库里的列叫 images ⇒ 缺 media 即拒绝启动（重建库 + 重新上架）
  products: ['shipping_fee_usdt_micro', 'media'],
  product_skus: ['price_usdt_micro'],
  // after_sale_* = 确认收货后的售后案件（契约 2026-10 第二批，见 src/afterSale.js）
  /*
    refunded_amount_wei / accepted_partial_refund_wei（2026-10 补进清单）：
    这两列缺席时**不会**像其它列那样当场炸出 "no such column"——订单 DTO 走的是 `SELECT *`，
    缺列只是让 `o.refunded_amount_wei === undefined`，而 DTO 里曾用 `|| '0'` 把它说成
    "链上确证没退过款"：面板净额虚高、卖家授权额显示为"未授权"，一切看起来正常。
    这正是本清单存在的意义（"凡当前代码必须存在的列都在清单里"）：缺列 ⇒ 拒绝启动，
    而不是让某一层凭一次读不到的读出一个结论。
  */
  orders: ['usdt_micro', 'shipping_fee_usdt_micro', 'after_sale_status', 'after_sale_opened_at', 'refunded_amount_wei', 'accepted_partial_refund_wei'],
};
{
  const db = getDb();
  const missing = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (have.size === 0) {
      missing.push(`${table}（表不存在）`);
      continue;
    }
    for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  if (missing.length) {
    console.error(`[server] 本地库结构过旧，缺少列：${missing.join('、')}`);
    console.error('[server] 本项目的建表语句即最终结构，不做存量迁移（见 src/db.js 文件头）。');
    console.error('[server] 请删库重建：停节点 → 删除数据库文件（默认 marketplace-node.db；Docker 部署在命名卷里）→ 重新启动。');
    console.error('[server] 删库不可逆，先备份；步骤见 docs/OPS_RUNBOOK.md。');
    process.exit(1);
  }
}

startOrderSweeper();
// 个人信息保留期擦除（MK_PII_RETENTION_DAYS，默认 180 天；显式 0 = 关闭自动擦除）：
// 终局订单静置超期后自动擦除收货信息/备注/售后陈述正文/证据附件——"存着不删"本身
// 就是合规风险，不能指望店主记得手工执行（显式删除请求走 POST /api/shop/orders/:id/erase-pii）
startPiiRetentionSweep();

// 过期 SIWE nonce 定期清理（每 10 分钟；登录成功会删当前行，此处兜底防表膨胀）
cleanupExpiredSiwe();
const siweTimer = setInterval(() => cleanupExpiredSiwe(), 10 * 60_000);
if (typeof siweTimer.unref === 'function') siweTimer.unref();

if (config.chain.escrowAddress) {
  /*
    托管合约地址锚点（源码评审 2026-09，P0 的运行时那一半）：订单行不存合约地址，所以"换
    MK_ESCROW_ADDRESS"会让本地那批指向旧实例的在途单**静默失联**（查不到、对不了账，店主
    以为还在等发货，钱在旧合约里）。首次启动记地址；地址变了而本地还有在途链上单 ⇒ 默认
    拒绝启动，除非显式 MK_ESCROW_CHANGE_ACK=1（处置步骤见 src/chainAnchor.js 的报错正文）。
  */
  const anchor = applyEscrowAnchor({
    envAddress: config.chain.escrowAddress,
    ack: String(process.env.MK_ESCROW_CHANGE_ACK || '') === '1',
  });
  if (!anchor.ok) {
    console.error(`[server] 托管合约地址锚定未通过：\n  ${anchor.reason}`);
    process.exit(1);
  }
  if (anchor.level !== 'ok' && anchor.level !== 'skip') {
    console.log(`[marketplace-node] 托管合约地址锚点：${anchor.reason}`);
  }
  // 启动期链 ID 自检：RPC 指错链会让别处的同名合约事件驱动本地状态（见 chain.assertChainId）
  const { assertChainId } = await import('./chain.js');
  try {
    const cid = await assertChainId();
    console.log(`[marketplace-node] RPC 链 ID 自检通过（chainId ${cid}）`);
  } catch (e) {
    console.error(`[server] ${e.message}`);
    process.exit(1);
  }
  /*
    启动期**合约代次自检**（2026-10-13，与"库缺一列拒绝启动"同一道纪律）。
    见 chain.assertEscrowGeneration 的完整说明：链上 Escrow 必须是含 2026-10 加固的那一代，
    否则本版本代码会把它缺的那几条能力静默降级（超时看板读不到、售后案件永远为空、
    下单最小超时窗口与释放静置期缺席），而日志里一个字都不会说。
    逃生口 MK_CONTRACT_GEN_ACK=1：显式声明"我知道它是旧实例，仍要以只读方式接"。
  */
  const { assertEscrowGeneration } = await import('./chain.js');
  const gen = await assertEscrowGeneration();
  if (!gen.ok) {
    const why =
      `链上托管合约（${config.chain.escrowAddress}）缺少本版本代码需要的入口：\n` +
      `    - ${gen.missing.join('\n    - ')}\n` +
      `  这说明它是一个**更早一代**的实例。旧实例缺 2026-10 的全部加固（确认收货后的售后案件、\n` +
      `  拒绝退款后的释放静置期、下单最小超时窗口、三个资金出口参数的可调与按单快照），\n` +
      `  节点照常跑起来只会把这些能力静默降级。\n` +
      `  处置：把 MK_ESCROW_ADDRESS / MK_REGISTRY_ADDRESS / MK_ESCROW_START_BLOCK 三个值同批换成\n` +
      `  当前这一批（见 deploy/README.md §1.3），然后**重建容器**（改 .env 后 docker restart 读不到）；\n` +
      `  若确实要以只读方式接旧实例，设 MK_CONTRACT_GEN_ACK=1 显式声明。`;
    if (String(process.env.MK_CONTRACT_GEN_ACK || '') !== '1') {
      console.error(`[server] 托管合约代次自检未通过：\n  ${why}`);
      process.exit(1);
    }
    console.warn(`[server] 托管合约代次自检未通过（MK_CONTRACT_GEN_ACK=1 已显式放行）：\n  ${why}`);
  } else {
    console.log('[marketplace-node] 托管合约代次自检通过（2026-10 加固的入口齐全）');
  }
  /*
    启动期**下单超时窗口自检**（2026-10-14，见 chain.checkOrderTimeoutBounds）：
    `MK_ESCROW_TIMEOUT_BLOCKS` 是本节点自己填进草稿的值，合约对它另有常量上下界。
    配越界时节点会**绿灯启动**，而全网每一笔下单都在买家钱包里 revert ——
    运营方看到的现象是"没人下单"，与真实原因（一个环境变量）相隔十万八千里。
    与"库缺一列/密钥是占位值/合约代次不对"同一道纪律：要么可用，要么拒绝启动并写明怎么改。
    逃生口沿用 MK_CONTRACT_GEN_ACK（与代次自检同一个"我确实知道"的声明）。
  */
  const { checkOrderTimeoutBounds } = await import('./chain.js');
  const bounds = await checkOrderTimeoutBounds();
  if (!bounds.ok) {
    const why =
      `${bounds.message}\n` +
      `  影响：下单草稿里写的就是这个值，买家的 createOrder 必然回滚——店面能浏览、但一单也成不了。\n` +
      `  处置：改 .env 里的 MK_ESCROW_TIMEOUT_BLOCKS 后**重建容器**（docker restart 读不到新 .env）。`;
    if (String(process.env.MK_CONTRACT_GEN_ACK || '') !== '1') {
      console.error(`[server] 下单超时窗口自检未通过：\n  ${why}`);
      process.exit(1);
    }
    console.warn(`[server] 下单超时窗口自检未通过（MK_CONTRACT_GEN_ACK=1 已显式放行）：\n  ${why}`);
  } else {
    console.log(`[marketplace-node] 下单超时窗口自检通过（${bounds.message}）`);
  }
  startWatcher();
  // 链上状态对账（兜底）：watcher 只正向回放、从不回滚，事件漏扫一次就会让订单永久停在
  // 非终态（链上早已终局）——本扫描按 MK_CHAIN_RECONCILE_MS（默认 10 分钟）复查滞留住
  // 并复用 watcher 的映射修复；MK_ESCROW_ADDRESS 未配置时不启动（本分支即该条件）
  startChainReconcile();
} else {
  console.warn('[server] MK_ESCROW_ADDRESS 未配置：跳过 Escrow 事件轮询（仅商品浏览/展示模式，不可下单）');
}
if (!config.shop.owner) {
  console.warn('[server] MK_SHOP_OWNER 未配置：本节点不可上架商品/发货（写操作要求店主 SIWE）');
}
// 仓库公开的占位/默认密钥一律拒绝启动（默认值 + .env.example 示例值，均可在仓库内查到——
// 任何人都能用它们离线伪造店主令牌；弱密钥同样拒绝）
const INSECURE_SECRETS = new Set([
  // 代码里的默认值（config.js）与仓库 .env.example 的示例值——都在仓库里可查，必须一律拒绝
  'dev-insecure-secret-change-me',
  'change-me-to-a-long-random-secret',
]);
// 密钥强度（2026-09 修复）：占位串黑名单之外，长度 < 32 或纯重复字符/纯数字串一律拒绝——
// HMAC 令牌 = base64url(JSON).HMAC(secret)，任何人拿到弱密钥即可离线伪造任意角色令牌
// （含店主）。>=32 字符随机值（如 openssl rand -base64 32）为最低要求。
const secret = config.siwe.secret || '';
const looksRepeated = /^(.)\1{15,}$/.test(secret); // 16+ 相同字符
const looksNumericOnly = /^[0-9]{16,}$/.test(secret); // 16+ 纯数字（含顺序键盘串）
const weakSecret = !secret || INSECURE_SECRETS.has(secret) || secret.length < 32 || looksRepeated || looksNumericOnly;
// NODE_ENV 未显式设置时按生产语义处理（systemd/direct 部署常见 NODE_ENV 缺省——
// 弱密钥/测试模式配置不应在"看起来是生产"的环境里静默生效）
/*
  这里**不再**自己算一份"是否类生产"（源码评审 2026-09）：旧代码留的
  `const isProdLike = nodeEnv !== 'test' && nodeEnv !== 'development'` 从来没有被使用过
  （死代码），而真正需要这个判据的 `app.js` 的 CORS 判定用的是另一套写法（`!== 'production'`）
  ⇒ 裸机没设 NODE_ENV 时两处结论相反。判据已收进 `http.js` 的 `isProdLike()`（唯一实现，
  未设 NODE_ENV 也算生产），需要时从那import。
*/
if (weakSecret) {
  console.error('[server] MK_TOKEN_SECRET 缺失/过短（需 ≥32 字符强随机值）/仍为仓库示例占位值/弱模式，已拒绝启动——请设置强随机密钥（如 openssl rand -base64 32）');
    process.exit(1);
}

/*
  下单风控闸配置门禁（2026-10）：MK_ORDER_GATE_URL **非空但非法** ⇒ 拒绝启动。
  旧行为是把它静默折成"未开启风控"（orderGateEnabled() === false）⇒ 店主以为开了风控，
  实际每一单都直接放行，而日志里一个字都没有——"读不到一个可用的风控目标"被说成了
  "店主没有开风控"。这里与密钥/库结构/合约锚点同一道启动门禁：要么配置可用，
  要么拒绝启动并写明"改 URL 或清空该键（=关闭风控）"。判定在 src/orderGate.js（唯一实现）。
*/
const orderGateError = orderGateStartupError();
if (orderGateError) {
  console.error(`[server] 下单风控闸配置非法，已拒绝启动：${orderGateError}`);
  process.exit(1);
}


// 配置极简升级提示：已删除的经营键若仍残留在 .env，节点静默忽略会让运维误以为"配置生效"
//（实际店名回默认常量、店员名单清空、通知停发、登记 endpoint 失效）——启动时显式告警。
// 注意 `MK_NOTARY_ADDRESS` 属**部署脚本**用键（scripts/deploy-mainnet.cjs 用它做 ReviewNotary
// 幂等跳过），节点自身已不读取——所以告警文案对它要说清作用域，免得运维以为整条链路都不用它。
const LEGACY_ENV_KEYS = [
  'MK_SHOP_NAME',
  'MK_SHOP_NOTICE',
  'MK_SHOP_META',
  'MK_NODE_ENDPOINT',
  'MK_OPERATORS',
  'MK_WEBHOOK_URL',
  'MK_WEBHOOK_SECRET',
  'MK_NOTARY_ADDRESS',
  'MK_PAY_TOKEN',
  'MK_PAY_TOKEN_DECIMALS',
];
for (const k of LEGACY_ENV_KEYS) {
  if (process.env[k] !== undefined && process.env[k] !== '') {
    console.warn(`[server] .env 含已废弃键 ${k}（配置极简后**节点**不再读取）：店名/公告/店员/通知请在卖家面板「店铺设置」网页维护，登记 endpoint 在开店向导填写${k === 'MK_NOTARY_ADDRESS' ? '；该键仍被部署脚本（scripts/deploy-mainnet.cjs）用于 ReviewNotary 的幂等跳过，若你不用部署脚本可以删掉这一行' : '——请删除该行，或运行 node scripts/deploy.mjs 重新生成 .env'}`);
  }
}

/*
  已删除的**行情**键（2026-10 标价单位由 CNY 改为 USDT）：USDT→CNY 那条法币腿连同它的
  缓存 TTL 与手工兜底汇率一起删掉了。残留这两行不会让节点报错，但会让运维以为
  "我配过兜底汇率"——实际一个都不读，行情源挂掉时就是没有价格（无法下单）。
  单独一条告警而不是混进上面那条：上面那句会把人指向"卖家面板的网页开关"，
  而这两个键没有任何网页替代品（它们对应的功能已经不存在了）。
*/
const LEGACY_RATE_ENV_KEYS = ['MK_RATES_TTL_MS', 'MK_FALLBACK_USDT_CNY'];
for (const k of LEGACY_RATE_ENV_KEYS) {
  if (process.env[k] !== undefined && process.env[k] !== '') {
    console.warn(
      `[server] .env 含已删除键 ${k}（标价单位改为 USDT 后 USDT→CNY 汇率腿整体移除，节点不再读取任何法币汇率）：请删除该行；BTY 行情仍由 MK_BTY_TTL_MS / MK_FALLBACK_BTY_USDT 控制`
    );
  }
}

const app = createApp();
app.listen(config.port, () => {
  console.log(`[marketplace-node] 联邦商城节点已启动 http://0.0.0.0:${config.port}`);
  console.log(`[marketplace-node] 店主=${config.shop.owner || '(未配置)'} 店铺=${shopName()}`);
  console.log(`[marketplace-node] 托管合约=${config.chain.escrowAddress || '(未配置)'} 支付币种=原生 BTY`);
  /*
    下单风控闸（可选，默认关闭）：开启时**必须**在启动日志里说出来。
    fail-closed 意味着"风控服务一挂，全店下不了单"——运维要能立刻从日志判断
    "卖不出去"是不是风控在拦，以及逃生通道（清空 MK_ORDER_GATE_URL）在哪。
    未配置时完全静默：默认部署不该为没开的功能多一行噪声。
  */
  if (orderGateEnabled()) {
    console.log(
      `[marketplace-node] 下单风控闸=开启（${config.orderGate.url}）——建单前需该服务放行，服务不可达/超时/应答异常一律拒单（fail-closed）；清空 MK_ORDER_GATE_URL 即关闭`
    );
  }
});
