/**
 * 节点服务入口：初始化 DB → 启动链上事件轮询（若已配置托管合约）→ 监听 HTTP。
 * 环境变量经 `node --env-file-if-exists=.env` 注入（见 package.json scripts）。
 */
import config from './config.js';
import { initDb } from './db.js';
import { startWatcher } from './escrowWatcher.js';
import { startChainReconcile } from './chainReconcile.js';
import { startOrderSweeper } from './orderSweeper.js';
import { startPiiRetentionSweep } from './piiErase.js';
import { cleanupExpiredSiwe } from './auth.js';
import { createApp } from './app.js';
import { shopName } from './routes/shop.js';
// 下单风控闸（可选，默认关闭）：仅用于启动日志——开启时必须让运维一眼看到
import { orderGateEnabled } from './orderGate.js';
import { applyEscrowAnchor } from './chainAnchor.js';

initDb();
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
  'dev-insecure-secret-change-me',
  'change-me-to-a-long-random-secret',
  // docker-compose.yml 演示节点示例密钥（仓库公开，任何人均可离线伪造对应演示节点店主令牌）
  'demo-node-a-secret-change-me',
  'demo-node-b-secret-change-me',
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
    console.warn(`[server] .env 含已废弃键 ${k}（配置极简后**节点**不再读取）：店名/公告/店员/通知请在卖家面板「店铺设置」网页维护，登记 endpoint 在开店向导填写${k === 'MK_NOTARY_ADDRESS' ? '；该键仍被部署脚本（scripts/deploy-mainnet.cjs）用于 ReviewNotary 的幂等跳过，若你不用部署脚本可以删掉这一行' : '——请删除该行，或运行 node scripts/deploy.mjs 重新生成 .env'}（见 docs/DECISIONS.md）`);
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
