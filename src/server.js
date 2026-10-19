/**
 * 节点服务入口：初始化 DB → 启动链上事件轮询（若已配置托管合约）→ 监听 HTTP。
 * 环境变量经 `node --env-file-if-exists=.env` 注入（见 package.json scripts）。
 */
import config from './config.js';
import { initDb } from './db.js';
import { startWatcher } from './escrowWatcher.js';
import { startChainReconcile } from './chainReconcile.js';
import { startTermsReconciler } from './termsReconciler.js';
import { startOrderSweeper } from './orderSweeper.js';
import { startPiiRetentionSweep } from './piiErase.js';
import { cleanupExpiredSiwe } from './auth.js';
// 优雅关闭的库那一侧（关池 + 放实例锁）：唯一实现在 db.js，理由见那里的说明
import { closeDb } from './db.js';
// 退出路径内核（纯模块，可单测；理由见那里的文件头）
import { createShutdown } from './shutdown.js';
import { createApp } from './app.js';
// 启动日志里的"本机叫什么"取**节点资料**（`node` 单例行的 name/notice，与任何一家店无关：
// 开节点与开店铺是两个独立动作）。
// ⚠️ `nodeNameOf` 的实现住在**路由层**（`routes/shop.js`：店名是"列 + 默认名"的一次读，
// 而那张表的访问器就在那个文件里），它不是 `shops.js`（店铺行的访问层）的导出。
// 这里此前写的是 `from './shops.js'`，而 ESM 对**不存在的具名导出**是**加载期直接抛错**：
// 节点整台起不来（`SyntaxError: The requested module './shops.js' does not provide an export named 'shopNameOf'`）。
// 七百多条接口测试全绿也照样漏掉——它们 import 的是 `app.js`，不经过本文件。
import { nodeNameOf } from './routes/shop.js';
// `node` 行的同步投影（`hostOperator()`）暖机点：见下方紧跟 initDb 的说明
import { nodeRow, nodeOwnerOf } from './shops.js';
// 下单风控闸（可选，默认关闭）：启动日志 + 启动门禁（URL 非空但非法 ⇒ 拒绝启动）
import { orderGateEnabled, orderGateStartupError } from './orderGate.js';
import { applyEscrowAnchor } from './chainAnchor.js';

/*
  初始化顺序**必须由 await 界定**（2026-10，MySQL 迁移）：`initDb` 现在是异步的
  （建库 → 实例锁 → 服务器能力探测 → 建表与建触发器 → 必备列门禁 → 节点行 → 校验 changes 语义）。
  旧实现（SQLite、同步）里它一返回就是"库已就绪"，本文件因此可以裸调用；
  不 await 的话后面每一句都跑在**库还没就绪**的时候（`db not initialized`）、
  `createApp()` 之后的请求撞上没建的表，而启动日志看起来一切正常。
  这里是 ESM 入口，顶层 await 会阻塞模块求值直到库就绪（listen 在文件末尾，天然排在后面）。
*/
await initDb();

/*
  **暖 `node` 行的同步投影**（唯一的暖机点）。
  `node`（owner/合约锚/游标/隔离事件/节点资料）是单例行，由 `initDb()` 种入；
  而 `shops.js` 的 `hostOperator()` 是 `node.owner` 的**同步**投影（`src/shopCode.js` 必须在
  同步上下文里拿它做 `codeOf` 的缓存键）——它在任何一次读那一行之前是空串。
  空串的后果不是"少一个字段"：`shopDto`/`orderTermsOf` 在"要抽成却读不到收款人"时**抛错**
  （刻意的响亮失败，见那里的说明），所以这里先读一次，让第一批请求拿到真实身份。
*/
await nodeRow();

/*
  结构门禁在 `db.js` 的 `initDb` 里跑（结构指纹：把 `SCHEMA_DDL` + `TRIGGER_DDL` 在一座临时库里
  全量执行一遍得到期望形状，再与真实库逐项对拍；有差异就 exit(1) 并打印一份幂等的修复清单）：
  它守的是"真实库的形状与建表语句一致"（列类型/可空/默认值/生成列/索引/CHECK/外键/视图/触发器），
  而建表/建索引是**同一层**的事——门禁必须与建表语句住在同一处，否则中间夹一段 DDL 就会让
  依赖较新列的语句（例如给新列建索引）**抢在门禁之前**失败：用户拿到的是一句 `SQL logic error`，
  而不是"缺什么、执行哪几条修复 SQL"的可照做清单。这个顺序由 db.js 那一处独占地保证。
*/

startOrderSweeper();
// 个人信息保留期擦除（MK_PII_RETENTION_DAYS，默认 180 天；显式 0 = 关闭自动擦除）：
// 终局订单静置超期后自动擦除收货信息整行/备注/售后陈述正文/证据附件——"存着不删"本身
// 就是合规风险，不能指望店主记得手工执行（显式删除请求走 POST /api/shop/orders/:orderNo/erase-pii）
startPiiRetentionSweep();

// 过期 SIWE nonce 定期清理（每 10 分钟；登录成功会删当前行，此处兜底防表膨胀）
await cleanupExpiredSiwe();
const siweTimer = setInterval(() => {
  // 兜底清理也是异步的：失败只告警——表膨胀是慢问题，不该让一次库抖动把进程带崩
  cleanupExpiredSiwe().catch((e) => console.error('[auth] 过期 nonce 清理失败（下轮重试）:', e?.message || e));
}, 10 * 60_000);
if (typeof siweTimer.unref === 'function') siweTimer.unref();

if (config.chain.escrowAddress) {
  /*
    托管合约地址锚点（源码评审 2026-09，P0 的运行时那一半）：订单行不存合约地址，所以"换
    MK_ESCROW_ADDRESS"会让本地那批指向旧实例的在途单**静默失联**（查不到、对不了账，店主
    以为还在等发货，钱在旧合约里）。首次启动记地址；地址变了而本地还有在途链上单 ⇒ 默认
    拒绝启动，除非显式 MK_ESCROW_CHANGE_ACK=1（处置步骤见 src/chainAnchor.js 的报错正文）。
  */
  // 必须 await：锚定要读 `node.escrow_address` 与在途单计数（异步库调用），不 await 时
  // `anchor.ok` 读的是 Promise（恒真），"有在途单就拒绝启动"那条分支永远走不到
  // （见 chainAnchor.applyEscrowAnchor 的说明）
  const anchor = await applyEscrowAnchor({
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
  const { assertEscrowGeneration, assertRegistryGeneration } = await import('./chain.js');
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
    **Registry 代次自检**（与 Escrow 自检同批）：节点还会读 Registry 的 `ShopInfo` 元组、
    员工名单（`staffNode` / `nodeStaff`）与按编号的在售判据（`shopListed`）。接上更早一代
    Registry 时节点照样启动，然后店铺对账每轮解码失败、员工永远鉴权失败，日志里只有"读不到"。
    判据见 chain.assertRegistryGeneration；未配置 Registry 时返回 skipped（纯浏览节点）。
  */
  const regGen = await assertRegistryGeneration();
  if (!regGen.skipped && !regGen.ok) {
    const why =
      `链上店铺登记合约（${config.chain.registryAddress}）缺少本版本代码需要的入口：\n` +
      `    - ${regGen.missing.join('\n    - ')}\n` +
      `  这说明 Registry 是更早/更晚的一代（或地址指错了实例）。节点照常跑起来只会让\n` +
      `  店铺对账与节点员工鉴权静默失效。\n` +
      `  处置：把 MK_REGISTRY_ADDRESS / MK_ESCROW_ADDRESS / MK_ESCROW_START_BLOCK 同批换成当前\n` +
      `  这一批并**重建容器**；若确实要以只读方式接旧实例，设 MK_CONTRACT_GEN_ACK=1 显式声明。`;
    if (String(process.env.MK_CONTRACT_GEN_ACK || '') !== '1') {
      console.error(`[server] Registry 代次自检未通过：\n  ${why}`);
      process.exit(1);
    }
    console.warn(`[server] Registry 代次自检未通过（MK_CONTRACT_GEN_ACK=1 已显式放行）：\n  ${why}`);
  } else if (!regGen.skipped) {
    console.log(`[marketplace-node] Registry 代次自检通过（${regGen.probed} 个读法齐全）`);
  } else {
    console.log('[marketplace-node] 未配置 MK_REGISTRY_ADDRESS：跳过 Registry 代次自检（纯浏览模式）');
  }
  /*
    启动期**下单超时窗口自检**（2026-10-14，见 chain.checkOrderTimeoutBounds）：
    `MK_ESCROW_TIMEOUT_BLOCKS` 是本节点自己填进草稿的值，合约对它另有常量上下界。
    配越界时节点会**绿灯启动**，而全网每一笔下单都在买家钱包里 revert ——
    运营方看到的现象是"没人下单"，与真实原因（一个环境变量）相隔十万八千里。
    与"库缺一列/密钥是占位值/合约代次不对"同一道纪律：配错就拒绝启动并写明怎么改。

    **只有"读到了界、且确实越界"才拒绝启动**（verdict='blocked'）；`verdict='unknown'`
    （读不到链上界 / 配置值本身非法）**只大声告警、照常启动**——把"读不到"升格成停服，
    等于让一次 RPC 抖动停掉一个本来配置正确的节点（缺省值 120960 本就在合法区间内）。
    那一档的结论留在 `orderTimeoutSelfCheck()` 里，由 /healthz 与这行告警说出来。

    逃生口：MK_CONTRACT_GEN_ACK=1。⚠️ 它与**合约代次自检**共用同一个变量（见上面的 gen 分支）
    ——放行这一条会**同时**放行代次不符，而那正是"旧一代 Escrow 没有 minTimeoutBlocks /
    MAX_TIMEOUT_BLOCKS、因而在本闸报 unknown"的同一批实例。
  */
  const { checkOrderTimeoutBounds, setOrderTimeoutSelfCheck } = await import('./chain.js');
  const bounds = await checkOrderTimeoutBounds();
  setOrderTimeoutSelfCheck(bounds);
  if (bounds.verdict === 'blocked') {
    const why =
      `${bounds.message}\n` +
      `  影响：下单草稿里写的就是这个值，买家的 createOrder 必然回滚——店面能浏览、但一单也成不了。\n` +
      `  处置：改 .env 里的 MK_ESCROW_TIMEOUT_BLOCKS 后**重建容器**（docker restart 读不到新 .env）。\n` +
      `  注意：MK_CONTRACT_GEN_ACK=1 会**同时**放行合约代次自检，别为一个环境变量把它一起关掉。`;
    if (String(process.env.MK_CONTRACT_GEN_ACK || '') !== '1') {
      console.error(`[server] 下单超时窗口自检未通过（配置确定越界）：\n  ${why}`);
      process.exit(1);
    }
    console.warn(`[server] 下单超时窗口自检未通过（MK_CONTRACT_GEN_ACK=1 已显式放行）：\n  ${why}`);
  } else if (bounds.verdict === 'unknown') {
    console.warn(
      `[server] 下单超时窗口**这次没能校验**（不阻断启动）：${bounds.message}\n` +
        `  含义：无法确认 MK_ESCROW_TIMEOUT_BLOCKS=${bounds.configured} 是否落在链上允许区间内。\n` +
        `  若它其实越界，下单会全部失败而店面看起来正常——请核对 /healthz 的 orderTimeout 字段，或重启一次让本闸重跑。`
    );
  } else {
    console.log(`[marketplace-node] 下单超时窗口自检通过（${bounds.message}）`);
  }
  startWatcher();
  // 佣金条款/在售状态对账（多店改造）：把链上 `shopListed` 与当前 `commissionBps` 抄回本地镜像。
  // 费率由节点主链上单方调整，节点只读链、不索引事件——不轮询就永远不知道本地那一份已经过期。
  // 不启动时 /healthz 的 terms.enabled=false，运维看得见。
  startTermsReconciler();
  // 链上状态对账（兜底）：watcher 只正向回放、从不回滚，事件漏扫一次就会让订单永久停在
  // 非终态（链上早已终局）——本扫描按 MK_CHAIN_RECONCILE_MS（默认 10 分钟）复查滞留住
  // 并复用 watcher 的映射修复；MK_ESCROW_ADDRESS 未配置时不启动（本分支即该条件）
  startChainReconcile();
} else {
  console.warn('[server] MK_ESCROW_ADDRESS 未配置：跳过 Escrow 事件轮询（仅商品浏览/展示模式，不可下单）');
}
if (!config.shop.owner) {
  /*
    节点主地址是这台机器的**身份接线**（`node.owner`，与 `MK_DB_HOST` 同级）：
    它既决定"谁能做节点级动作"，也是抽成收款人（`commissionTo`）的唯一答案。
    缺失时 db.js 的建行那一步会如实拒绝启动；这里再喊一句是为了让"我还没配身份"
    在日志里一眼可见，而不是只看到一句来自库层的报错。
  */
  console.warn('[server] MK_SHOP_OWNER 未配置：本节点没有身份（node.owner）——节点级动作与抽成收款人都无从判定');
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
const server = app.listen(config.port, async () => {
  // 身份与展示资料都从 `node` 那一行读（不留"配置里一份、库里一份"）
  const node = await nodeRow();
  console.log(`[marketplace-node] 联邦商城节点已启动 http://0.0.0.0:${config.port}`);
  console.log(`[marketplace-node] 节点主=${nodeOwnerOf(node) || '(未配置)'} 节点名=${await nodeNameOf()}`);
  console.log(`[marketplace-node] 托管合约=${config.chain.escrowAddress || '(未配置)'} 支付币种=原生 BTY`);
  /*
    反向代理信任边界：默认关闭。反代之后（本机 Caddy/nginx 是默认拓扑）不配置它，
    所有匿名客户端会共用代理那一个限流桶，audit_logs.ip 也恒为代理地址——
    这两件事都不会自己报错，所以在启动日志里把当前口径说出来。
  */
  console.log(
    `[marketplace-node] 反向代理信任边界（MK_TRUST_PROXY）=${
      config.trustProxy ? JSON.stringify(config.trustProxy) : '未启用（按 TCP 对端地址记来源 IP）'
    }`
  );
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

/*
  退出路径：**接线**在这里，实现与全部理由在 `src/shutdown.js`（那是个纯模块，可被单测直接驱动
  —— 本文件不能被 import，一被求值就会 initDb + listen，所以逻辑留在这里就等于测不到）。
  三件事按顺序：停止收新连接 → 等在途响应 → 关库 → 退出；正常停机 0、崩溃非 0。
*/
createShutdown({ server, closeDb, config, proc: process });