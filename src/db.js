/**
 * MySQL 8 数据层（mysql2 连接池）。**本文件是 schema 与连接口径的唯一真相。**
 *
 * ## 读写分离：读走池、写并发——**每道闸自己成立，没有全局写锁**
 *
 * 旧实现是 SQLite 单连接 + 同步执行：同时只可能有一笔事务，于是所有"先读计数、再写入"
 * 的判定（同买家草稿上限、池式商品可用量、证据附件配额……）由单写者锁**免费**串行化。
 * 换成连接池之后这些请求会真的并发跑在不同连接上，读到的旧计数让每一道闸形同虚设。
 *
 * 中间态曾用过一把全局写锁（`db_write_lock` 的那一行）：写事务之间完全串行，先把"不错"
 * 钉住，再逐道闸把它落成约束。**那把锁连同那张表已经删掉了**——现在每道闸都自己成立：
 *
 *   · 同买家活跃草稿 ≤10、同买家同商品草稿占位 ≤99：`buyer_draft_quota` /
 *     `buyer_product_quota` 两个计数器 + 带守卫的 UPDATE（加量在 src/draftQuota.js）；
 *   · 池式商品（码池 / NFT 池）可用量：`products.reserved_codes` / `reserved_tokens`
 *     （加量在 src/poolQuota.js；减量：交付一件减一件、订单离开在途集合减剩余需求）；
 *   · 证据附件配额：每条陈述的 `dispute_evidence.file_count/file_bytes` 与每张订单的
 *     `orders.evidence_bytes`（各自一条守卫 UPDATE，见 src/evidenceFiles.js）；
 *   · 库存占位本来就是那个形状：`product_skus.committed` + `orders.hold_qty/released_at`
 *     （src/stockHold.js；释放先 `SELECT … FOR UPDATE` 锁候选行——那是**行级**锁，不是全局锁）；
 *   · 审计链靠 `prev_hash` 唯一（分叉写不进去，撞键重读链头即可）。
 *
 * **减量半边落在触发器里**（见 TRIGGER_DDL），不在调用点上。理由：`orders.status` 与
 * `order_delivery_items` 的写者有七八个（/paid、/cancel、清扫器、/sync、watcher 的四个分支、
 * 链上对账，以及测试夹具里直改 status 的那些 SQL），判据挂到调用点就意味着**每个写者都得
 * 自己记得减一次，新增一个写者就多一个漏点**；漏掉的后果是静默且永久的（买家付过 10 笔款
 * 之后草稿计数器停在 10，他再也建不出草稿，日志里一个字都没有）。触发器挂在表上，
 * 任何写者都绕不过去，而且与那条状态迁移在**同一个事务**里。
 *
 * 代价如实写：① 这是**库侧的隐含控制流**——读 `UPDATE orders SET status = …` 的人在调用点
 * 看不见有计数器在动，所以 `orders` 的建表注释、每个触发器旁边、以及应用里的加量处都把这件事
 * 写明（一处隐含，三处显式）；② 计数器是**新增状态**，必须与它们的真相同批移动，漏一处就是
 * 永久漂移；③ 夹具/直连 SQL 造出来、从未加过量的行会被减量按 0 兜底（`GREATEST`）——
 * 方向是安全侧，但那些行上的计数不等于真值。
 *
 * ## 事务的作用域由 `withTransaction(fn)` 的回调界定
 *
 * 没有 `txBegin/txCommit/txRollback` 三个必须成对调用的原语：事务连接挂在
 * AsyncLocalStorage 上，作用域就是那个回调——**泄漏事务在形状上不可表达**
 * （回调抛错或提前返回都必然走到同一个 finally）。嵌套调用自动降级为 SAVEPOINT。
 *
 * ## 三条贯穿全层的口径（细则见 SCHEMA_DDL 头部）
 *
 *   · **时间**：库里 `DATETIME(3)`、代码里 `Date`、接口上 ISO-8601。
 *     写库一律传 `Date`；传毫秒整数会被 MySQL 当成数字字面量解析（写进一个荒谬的时间且不报错）。
 *   · **钱**：wei 是 `DECIMAL(38,0)` 且**以字符串进出**（38 位装不进 JS number）；
 *     `SUM()`/`AVG()` 也返回字符串（`decimalNumbers:false`）——消费方必须显式 `Number(...)`。
 *   · **三态**：`NULL` 表示"没有 / 从未记录"，不再用空串冒充。
 *   · **改动时刻由库盖**：除 `orders` 之外的每个 `updated_at` 都是
 *     `DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`。
 *     它是入账窗口、争议陈述窗口、对账游标的唯一时间基准，所以这条判据**必须挂在列上**，
 *     不能靠在调用点各自记得写一次——那种形状下，任何新写者漏写一次就是静默的账目错位
 *     （旧成交额落错报表窗口、对账游标跳过该行），而且库里没有任何兜底。
 *     与"减量半边落触发器"是同一条取向：**判据落在任何写者都绕不过去的那一层**。
 *
 *     ⚠️ **`orders` 是刻意的例外**（见该列的注释）：那一张表的 `updated_at` 同时是**业务时间**
 *     （入账窗口/争议起点/对账游标），而个人信息擦除承诺**不动它**；`ON UPDATE` 是列级属性，
 *     没法声明"除这次写入之外都自动" ⇒ 自动盖章会把那句承诺变成假话（实测：加上之后
 *     `pii-erase.test.js` 两条断言当场变红）。所以这一列继续由写者显式盖章。
 *     判据："自动盖章会不会把一句承诺变成假话"——别的表不会，这一张会。
 *     代价如实写：写者仍显式 SET `updated_at = ?` 的那些语句现在**冗余**（值相同，结果不变）。
 */
import mysql from 'mysql2/promise';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import config from './config.js';

/** 当前异步上下文里的事务（`withTransaction` 安装；层外为 undefined） */
const als = new AsyncLocalStorage();

/**
 * **库级排序规则**（唯一常量：建库语句与启动自检读同一个值）。
 *
 * 为什么必须是 `_as_cs`：库级排序规则是**不带 COLLATE 的新表、新列、表达式与字面量比较**的默认值。
 * `_ai_ci` 会让 'ABC' 与 'abc' 相等——店铺编号 / 订单号 / 兑换码 / 交易哈希全是"只差大小写就是
 * 两个东西"的标识，一次默认值选错就让它们变成同一个。表级显式 as_cs 只保护**已经写出来的那几张表**，
 * 下一张新表、或一条漏写 COLLATE 的谓词就会静默变成大小写不敏感。所以判据挂在库上，并在启动时核对。
 */
const DB_COLLATION = 'utf8mb4_0900_as_cs';

let pool = null;
/** 服务器能力读数（启动时探测一次，见 probeServerCapabilities） */
let serverCaps = null;
/** 仍开着事务的连接（见 openTransactions） */
const activeTx = new Set();
/** 实例独占锁那条连接（进程存活期间不归还，见 acquireInstanceLock） */
let instanceLockConn = null;

/* ─────────────────────────── 连接池 ─────────────────────────── */

/**
 * 连接池的**有界排队 + 获取超时 + 深度读数**（唯一实现）。
 *
 * 旧口径是 `queueLimit: 0`（无限排队）且没有获取超时：池子被占满时，请求会**无限期**挂在
 * `getConnection()` 上——进程看起来健康、端口还在接连接，但每个请求都在等一条永远不会先到的
 * 连接；超时只能靠上游反代/客户端自行放弃。这里把"等"变成有限资源：
 *   · 排队上限 = 连接数 × {@link POOL_QUEUE_FACTOR}：到顶立即失败（比"所有人一起挂住"好）；
 *   · 单次获取超时 {@link POOL_ACQUIRE_TIMEOUT_MS}：超时立刻失败，**并归还之后才到的那条连接**
 *     （不归还就是另一条泄漏：连接被取走却永远没人 release）；
 *   · 读数进 `poolDepth()`（`/healthz` 的 capabilities 里可见）：`inUse` 恒应 ≤ connectionLimit，
 *     它长期不等就是泄漏信号（与 `openTransactions()` 同一种用途）。
 *
 * **系数为什么是 64 而不是个位数**（2026-10 修）：这个上限是**泄漏护栏**，不是并发节流阀。
 * 本仓的读面天然是"一行一查"的扇出（例如仲裁队列逐行取金额/证据数，行数上界就是 `pageSize`
 * 的 100），所以一个合法的 100 行页面在 2 条连接的池上会产生 ~100 个并发取连接。系数取小
 * （4 ⇒ 池 2 时上限 8）会把**正常请求**判成泄漏：实测仲裁队列直接 500。
 * 真正的保护是那 10 秒获取超时（每个等待者都有明确截止时刻）；这里的上限只负责兜住
 * "某个新调用点无限并发取连接"这种结构性泄漏——它一旦发生，128/640 这个量级照样会撞上。
 *
 * 代价如实写：突发流量下超过排队上限的请求会**明确失败**（500）而不是慢慢等；这是把
 * "整个节点静默挂死"换成"一部分请求失败"。上限与超时不设环境变量：配置文件不在这层，
 * 由这里按连接数派生，运维调 `MK_DB_POOL_SIZE` 时两者一起变。
 */
const POOL_QUEUE_FACTOR = 64;
const POOL_ACQUIRE_TIMEOUT_MS = 10_000;

let poolLimit = Math.max(1, Math.floor(config.db.poolSize));
const poolState = {
  waiting: 0,
  inUse: 0,
  acquired: 0,
  released: 0,
  timedOut: 0,
  queueFull: 0,
  lastWaitMs: 0,
  maxWaitMs: 0,
};

/** 连接池深度读数（**唯一实现**；`/healthz` 的 capabilities 与测试都读它） */
export function poolDepth() {
  return {
    connectionLimit: poolLimit,
    queueLimit: poolLimit * POOL_QUEUE_FACTOR,
    acquireTimeoutMs: POOL_ACQUIRE_TIMEOUT_MS,
    waiting: poolState.waiting,
    inUse: poolState.inUse,
    acquired: poolState.acquired,
    released: poolState.released,
    timedOut: poolState.timedOut,
    queueFull: poolState.queueFull,
    lastWaitMs: poolState.lastWaitMs,
    maxWaitMs: poolState.maxWaitMs,
  };
}

function poolQueueLimit() {
  return poolLimit * POOL_QUEUE_FACTOR;
}

/** 池取不到连接的错误：带 code，方便调用方/测试区分"池满"与"超时" */
function poolError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** 把一条借出的连接计入 inUse，并把 release/destroy 各包一层（只减一次） */
function trackCheckedOut(conn) {
  poolState.inUse += 1;
  poolState.acquired += 1;
  let returned = false;
  const release = conn.release.bind(conn);
  const destroy = conn.destroy.bind(conn);
  const settle = () => {
    if (returned) return;
    returned = true;
    poolState.inUse -= 1;
    poolState.released += 1;
  };
  conn.release = () => {
    settle();
    return release();
  };
  conn.destroy = () => {
    settle();
    return destroy();
  };
  return conn;
}

/**
 * 取一条连接：有界排队 + 获取超时。超时之后才到的连接会被立即归还（见上）。
 *
 * 注意 `pending.then(...)` 的注册**早于** `Promise.race`：两者都在同一个微任务队列里，
 * 若连接先到，这里先看到 `expired === false` 直接放行；若超时先到，这里看到 `true` 就归还。
 */
async function acquirePooledConnection(origGetConnection) {
  if (poolState.waiting >= poolQueueLimit()) {
    poolState.queueFull += 1;
    throw poolError(
      'MK_DB_POOL_QUEUE_FULL',
      `连接池排队已满（等待 ${poolState.waiting}，上限 ${poolQueueLimit()}，连接数 ${poolLimit}）：` +
        '这是"整个节点在等库"的保护阀——请查慢查询/长事务，或调大 MK_DB_POOL_SIZE'
    );
  }
  poolState.waiting += 1;
  const startedAt = Date.now();
  let expired = false;
  let timer = null;
  const pending = origGetConnection();
  pending.then(
    (late) => {
      if (expired) late.release();
    },
    () => {
      /* 失败由 Promise.race 那条路径报出，这里只负责不让它变成 unhandled rejection */
    }
  );
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      poolState.timedOut += 1;
      reject(
        poolError(
          'MK_DB_POOL_ACQUIRE_TIMEOUT',
          `等待数据库连接超过 ${POOL_ACQUIRE_TIMEOUT_MS}ms（连接数 ${poolLimit}，排队 ${poolState.waiting}）：` +
            '宁可让这一个请求明确失败，也不让整个节点挂在 getConnection 上'
        )
      );
    }, POOL_ACQUIRE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
    poolState.waiting -= 1;
    const waited = Date.now() - startedAt;
    poolState.lastWaitMs = waited;
    if (waited > poolState.maxWaitMs) poolState.maxWaitMs = waited;
  }
}

/**
 * 每条连接建立时要跑的会话设置与借还记账。**必须在任何业务语句之前生效**，所以用
 * `pool.on('connection')` 把结果存成 promise，取到连接后先 await 它。
 *
 * `binlog_row_image=MINIMAL`：这是"个人信息擦除"在 MySQL 下唯一还能守住的那条腿。
 * 本机 binlog 默认 `ROW + FULL`，UPDATE 的 **before-image** 会把被擦掉的手机号/地址原样
 * 写进二进制日志——库里的字段清空了，日志里还留着，与旧实现里"WAL 帧留着原文"是同一个洞。
 * MINIMAL 让 UPDATE 只记录主键（before）与被改动的列（after），擦除语句本身不再写入原文。
 * 设置失败不阻断启动（只影响承诺的成色），由 probeServerCapabilities 如实记录。
 */
const SESSION_SETUP = [
  "SET SESSION binlog_row_image = 'MINIMAL'",
  `SET SESSION innodb_lock_wait_timeout = ${Math.max(1, Math.floor(config.db.lockWaitSeconds))}`,
  "SET SESSION time_zone = '+00:00'",
];

function baseConnectionOptions() {
  return {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    charset: 'utf8mb4',
    /*
      **DECIMAL 一律以字符串返回**（驱动默认）。

      为什么必须这样（2026-10-16 重设计时实测到的）：金额现在是 `DECIMAL(38,0)`，
      而 wei 的值域远超 JS 安全整数。打开 decimalNumbers 会得到：
          写入 12345678901234567890123456789012345678
          读回 1.2345678901234568e+37          ← **精度已丢，而且不报任何错**
      这正是本仓最不能接受的那种失败（金额悄悄错掉）。字符串会让 `v + 1` 立刻现形；
      而且本仓的 wei 本来就是按字符串处理的（见 src/money.js 的 BigInt 口径），两边口径一致。

      代价如实写：MySQL 的 SUM()/AVG() 也返回 DECIMAL，于是聚合值**也**变成字符串，
      调用方要自己 `Number(...)`。这是刻意选择——让"聚合结果的精度"逐个显式表态，
      而不是让金额去冒静默取整的风险。凡消费聚合的地方都必须显式转换。
    */
    decimalNumbers: false,
    /*
      超过 2^53 的整数**绝不静默给一个错的 number**：转成字符串返回。
      本仓的纪律是"宁可响亮地失败"——字符串会让 `row.v + 1` 立刻现形，
      而精度丢失只会让金额悄悄错掉。schema 里的 CHECK 已经让这条路径不可达，
      这里是第二道网（列被后人加出来时仍然安全）。
      为什么不做成"永远返回字符串"：那会让每一处 id/计数的 === 比较全部失效。
    */
    supportBigNumbers: true,
    bigNumberStrings: false,
    /*
      **时间：库里 DATETIME(3)，代码里 Date，接口上 ISO-8601 字符串。三层各用各的原生表示。**

      为什么不是"库用 DATETIME、出口再转回毫秒整数"：那是**兼容垫片**——让库看起来还像
      旧的毫秒世界，于是"时间"这件事永远有第二种表示在流通。本仓的取向是让形状只有一个：
        · 库：DATETIME(3)，DEFAULT CURRENT_TIMESTAMP(3) 由**服务器**盖章，
          应用端时钟错了也写不错；运维能直接写 WHERE created_at >= '2026-10-01'；
        · 代码：`Date`（JS 对时间的原生类型），不再有"这个整数到底是秒还是毫秒"的猜测；
        · 接口：`Date.prototype.toJSON()` 天然给出 ISO-8601 字符串，前端按 ISO 解析。
      代价如实写：这是**破坏性接口变更**，前端与所有 DTO 同批改（本仓口径：破坏性变更
      一次切到位，不留"两种都认"的过渡形状）。

      时区必须一起钉死：会话 time_zone='+00:00'（见 SESSION_SETUP），驱动这边声明
      timezone:'Z'，两边一致，Date 才不会在往返中被本地时区平移。
    */
    timezone: 'Z',
    dateStrings: false,
    // SQL 注入的第二道网：本层从不拼接多语句
    multipleStatements: false,
    namedPlaceholders: false,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  };
}

function attachPoolManagement(target, connectionLimit) {
  poolLimit = Math.max(1, Math.floor(connectionLimit));
  const origGetConnection = target.getConnection.bind(target);
  target.getConnection = async () => {
    const conn = trackCheckedOut(await acquirePooledConnection(origGetConnection));
    try {
      if (!conn.__mkSessionReady) {
        /*
          三条语句**逐条下发**：连接是 `multipleStatements: false` 的（业务语句一律单条，
          见 baseConnectionOptions），拼成一条会被服务器判为语法错误。
          三条同时发而不是串行 await：mysql2 在单条连接上按命令队列顺序执行，并发下发只花一个往返。
        */
        conn.__mkSessionReady = Promise.all(SESSION_SETUP.map((sql) => conn.query(sql))).catch((e) => {
          conn.__mkSessionReady = null;
          throw e;
        });
      }
      await conn.__mkSessionReady;
      return conn;
    } catch (e) {
      // 会话设置失败时必须把连接还回去：不还的话池子少一条，连续失败几次就能把整个节点耗死
      try {
        conn.release();
      } catch {
        /* 连接本身可能已断，忽略 */
      }
      throw e;
    }
  };
  return target;
}

/* ─────────────────────────── 初始化 ─────────────────────────── */

/** 库就在本机吗（空口令只在这一档成立，见 assertDbConfigured） */
function isLoopbackDbHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '127.0.0.1') return true;
  // 127.0.0.0/8 整段都是回环
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * **数据库配置门禁**（启动时第一道，早于任何连接尝试）。
 *
 * 判据是"这台节点的库接在哪"——它是**接线**，接线不留默认值：
 * `MK_DB_HOST` / `MK_DB_USER` / `MK_DB_NAME` 缺失或为空就带着处置说明拒绝启动。
 *
 * 为什么不能给 `127.0.0.1` + `root` 这种默认值：那样一个**根本没配过数据库**的节点
 * 会静默连到"本机碰巧在跑、账号碰巧对得上"的库上（多节点部署时更糟：两个节点
 * 会去抢同一个库），或者以一句 `ECONNREFUSED` / `Access denied` 失败——
 * 而这两种现象都指不出真正的原因（"我还没配数据库"）。与 `MK_TOKEN_SECRET`
 * 缺失即拒绝启动是同一道纪律。
 *
 * 口令单独一条规则：**空口令只在库就在本机（回环地址）时成立**。
 * 对着一台远程库配空口令不是"简化配置"，是把它当成没有认证的库在用——
 * 那种组合一律拒绝，并在文案里说清为什么。
 *
 * 唯一实现：`initDb()` 与两个只读运维脚本（体检 / 对账）都调它，
 * 于是"能用哪套配置连上库"只有一处判据。
 */
export function assertDbConfigured() {
  const missing = [];
  if (!config.db.host) missing.push('MK_DB_HOST（数据库服务器地址）');
  if (!config.db.user) missing.push('MK_DB_USER（连接账号）');
  if (!config.db.name) missing.push('MK_DB_NAME（**本节点自己的库名**）');
  if (missing.length) {
    console.error(`[db] 数据库未配置，缺少：${missing.join('、')}`);
    console.error('[db] 本节点需要一个 MySQL 8：一个节点一个库，节点里的店铺都在这个库里');
    console.error('[db] （同一台服务器跑多个节点 ⇒ 每个节点填**不同的** MK_DB_NAME，共用一个 MySQL 实例即可）。');
    console.error('[db] 请把下面四行填进 node/.env（键名与说明见 node/.env.example 的「MySQL」一段）：');
    console.error('[db]   MK_DB_HOST=数据库服务器地址      # 容器里不能写 127.0.0.1，那是容器自己');
    console.error('[db]   MK_DB_USER=连接账号');
    console.error('[db]   MK_DB_PASSWORD=口令');
    console.error('[db]   MK_DB_NAME=本节点的库名          # 首次启动会自动建这个库，不必手工 CREATE DATABASE');
    console.error('[db] 本机还没有 MySQL：起一个（docker run mysql:8.0 或装发行版包）再回来填上面几行；');
    console.error('[db] 运维步骤（含备份/恢复）见 docs/DEPLOY_NODE.md 与 node/docs/OPERATIONS.md。');
    process.exit(1);
  }
  if (!config.db.password && !isLoopbackDbHost(config.db.host)) {
    console.error(`[db] MK_DB_PASSWORD 为空，而 MK_DB_HOST=${config.db.host} 不是本机地址——已拒绝启动。`);
    console.error('[db] 对着一台远程库用空口令等于把它当成没有认证的库在用。空口令只在库就在本机时允许。');
    console.error('[db] 处置：给这个节点建一个专属账号并设口令（推荐库级授权，它仍能自建自己那个库）：');
    console.error(`[db]   CREATE DATABASE IF NOT EXISTS \`${config.db.name}\` CHARACTER SET utf8mb4 COLLATE ${DB_COLLATION};`);
    console.error(`[db]   CREATE USER 'mk_node'@'%' IDENTIFIED BY '<强口令>';`);
    console.error(`[db]   GRANT ALL PRIVILEGES ON \`${config.db.name}\`.* TO 'mk_node'@'%';`);
    console.error(`[db]   -- 启动时的结构自检要在临时库 ${probeDatabaseName()} 里把建表语句全量执行一遍，`);
    console.error(`[db]   -- 因此账号还需要这个临时库的权限（库名由本节点库名派生，固定不变）：`);
    console.error(`[db]   GRANT ALL PRIVILEGES ON \`${probeDatabaseName()}\`.* TO 'mk_node'@'%';`);
    process.exit(1);
  }
}

/**
 * 建库（若不存在）→ 库级排序规则门禁 → 结构指纹门禁 → 建表/重建触发器 → 节点单例行。
 *
 * 建库这一步是为了"人人可部署"：连不上目标库时先 `CREATE DATABASE IF NOT EXISTS`
 * 再重试一次。它对权限不足的账号会失败，失败信息原样上抛（不猜、不降级）。
 */
export async function initDb() {
  if (pool) return pool;
  assertDbConfigured();
  await ensureDatabase();
  pool = attachPoolManagement(
    mysql.createPool({
      ...baseConnectionOptions(),
      database: config.db.name,
      waitForConnections: true,
      connectionLimit: config.db.poolSize,
      // 有界排队：到顶由 acquirePooledConnection 明确失败（见该函数的说明）
      queueLimit: Math.max(1, Math.floor(config.db.poolSize)) * POOL_QUEUE_FACTOR,
    }),
    config.db.poolSize
  );
  await acquireInstanceLock();
  serverCaps = await probeServerCapabilities();
  await assertDatabaseCollation();
  /*
    **结构门禁在 migrate 之前跑**（老库）：migrate 每次启动都 DROP+CREATE 触发器，
    先建表就等于先把触发器那部分差异抹掉——指纹里的"触发器语句一致"会永远成立。
    新库（一张声明过的表都还没有）例外：由 inspectSchemaStructure 先建出来再对拍。
  */
  const structure = await inspectSchemaStructure();
  if (!structure.ok) {
    reportSchemaStructureFailure(structure.diffs, structure.repairs);
    process.exit(1);
  }
  // 新库的建表已经由 inspectSchemaStructure 的 fresh 分支做完；老库在这里重建触发器（幂等）
  if (!structure.fresh) await migrate();
  await ensureNodeRow();
  await assertChangesSemantics();
  return pool;
}

/**
 * **一库一进程**的独占锁（启动门禁）。
 *
 * 为什么必须显式加这一道：旧实现用 SQLite 文件，操作系统层面的文件锁天然让
 * "两个进程写同一个库"不可能发生；MySQL 没有这层保护，而本进程里有大量
 * **进程内**的单飞标志与状态——托管事件轮询的游标、库位告警去重、条款对账、
 * 保留期扫描、以及"事务深度"这一类推理。两个进程接同一个库 ⇒ 事件被应用两次、
 * 占位被回补两次、审计哈希链分叉，而且**不会有任何一条错误日志**。
 *
 * 用 MySQL 的具名咨询锁（GET_LOCK）把它补回来：锁挂在本进程持有的一条专用连接上，
 * 进程退出（含崩溃）时连接断开、锁自动释放——不会像心跳表那样在崩溃后留下假占用。
 * 拿不到锁说明另一实例正在用同一个库，**拒绝启动并写明怎么处置**。
 */
async function acquireInstanceLock() {
  const name = `mk:instance:${config.db.name}`;
  const conn = await mysql.createConnection({ ...baseConnectionOptions(), database: config.db.name });
  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, 0) AS ok', [name]);
    if (Number(rows[0]?.ok) !== 1) {
      await conn.end();
      console.error(`[db] 数据库 \`${config.db.name}\` 已被另一个节点进程占用（实例锁 ${name} 取不到）。`);
      console.error('[db] 本节点是**单进程**设计：事件轮询游标、告警去重、事务串行都靠进程内状态，');
      console.error('[db] 两个进程接同一个库会让链上事件被应用两次、库存占位被重复回补，且不会报任何错。');
      console.error('[db] 本仓的数据模型是**一个节点一个库，节点里的店铺都在这个库里**——');
      console.error(`[db] 所以同一台服务器上跑第二个节点时，请给它换一个库名（现在是 MK_DB_NAME=${config.db.name}）。`);
      console.error('[db] 处置：确认没有残留的旧进程（ps / docker ps）后重启本进程；');
      console.error('[db]      多节点部署请各自使用**不同的 MK_DB_NAME**（共用一个 MySQL 实例没问题）。');
      process.exit(1);
    }
    instanceLockConn = conn;
    const release = () => { try { conn.destroy(); } catch { /* 进程正在退出，忽略 */ } };
    process.once('exit', release);
    process.once('SIGINT', release);
    process.once('SIGTERM', release);
  } catch (e) {
    await conn.end().catch(() => {});
    throw e;
  }
}

/**
 * **关闭数据库这一侧**（供优雅关闭调用；唯一实现）。
 *
 * 三件事，顺序不能反：
 *   ① 先看有没有**开着的事务**（`openTransactions()`）——有就如实告诉调用方；
 *   ② `pool.end()`：它**等所有借出的连接归还**，所以必须先保证没有事务卡在半路
 *      （否则 end() 会一直等，而优雅关闭的超时会先到）；
 *   ③ 释放实例锁那条专用连接（`GET_LOCK` 挂在它上面，连接一断锁自动释放）。
 *
 * ⚠️ **必须在退出之前调用**：不调用时进程退出会让池连接被一并掐掉，而"起了一半的那条语句"
 * 是成功还是回滚由服务端决定。显式 `end()` 让这一轮写入有一个确定的结局
 * （InnoDB 会回滚未提交事务，但那要求连接以正常方式断开）。
 *
 * @returns {Promise<{closed:boolean, openTx:number}>} `openTx > 0` = 关之前还有事务开着
 */
export async function closeDb() {
  const openTx = activeTx.size;
  if (pool) {
    const p = pool;
    // 先摘掉引用：关闭期间进来的请求会拿到明确的 "db not initialized"，
    // 而不是一条被复用的半死连接（那种失败看起来像"库偶发故障"）
    pool = null;
    try {
      await p.end();
    } catch (e) {
      console.error('[db] 关闭连接池失败（继续释放实例锁）:', e?.message || e);
    }
  }
  if (instanceLockConn) {
    try {
      instanceLockConn.destroy();
    } catch {
      /* 进程正在退出，忽略 */
    }
    instanceLockConn = null;
  }
  return { closed: true, openTx };
}

async function ensureDatabase() {
  let conn;
  try {
    conn = await mysql.createConnection({ ...baseConnectionOptions(), database: config.db.name });
  } catch (e) {
    if (e.code !== 'ER_BAD_DB_ERROR') throw e;
    const admin = await mysql.createConnection(baseConnectionOptions());
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.name}\` CHARACTER SET utf8mb4 COLLATE ${DB_COLLATION}`);
    } finally {
      await admin.end();
    }
    conn = await mysql.createConnection({ ...baseConnectionOptions(), database: config.db.name });
  }
  await conn.end();
}

/**
 * 库级排序规则读数（**唯一判据**，`initDb` 与测试都读它）。
 *
 * `@@collation_database` 是"当前连接选中的那个库"的默认排序规则——与建库时写进
 * `SCHEMATA.DEFAULT_COLLATION_NAME` 的是同一个事实。用会话变量而不是 information_schema，
 * 是因为它能一次回答"这个节点现在连着的库是不是 as_cs"，且不受 schema 名拼写影响。
 */
export async function databaseCollationReport() {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT @@collation_database AS c');
    const actual = rows[0]?.c ?? null;
    return { ok: actual === DB_COLLATION, actual, expected: DB_COLLATION };
  } finally {
    conn.release();
  }
}

/**
 * 库级排序规则门禁。老库（历史上用 ai_ci 建的）在这里拒绝启动，而不是让它带着
 * "大小写不敏感的默认值"继续跑——判据只有这一处（见 DB_COLLATION 的说明）。
 */
async function assertDatabaseCollation() {
  const r = await databaseCollationReport();
  if (r.ok) return;
  console.error(`[db] 库 \`${config.db.name}\` 的默认排序规则是 ${r.actual ?? '（读不到）'}，本库要求 ${r.expected}。`);
  console.error('[db] 为什么：库默认值是"不带 COLLATE 的新表/新列/表达式比较"的默认值。');
  console.error('[db] ai_ci 让 ABC 与 abc 相等——店铺编号/订单号/兑换码/交易哈希都是只差大小写就算两个东西的标识。');
  console.error(`[db] 处置（只改库默认值，不改已有表/列；本项目每张表每列都显式写了 ${r.expected}）：`);
  console.error(`[db]   ALTER DATABASE \`${config.db.name}\` CHARACTER SET utf8mb4 COLLATE ${r.expected};`);
  process.exit(1);
}

/**
 * 服务器能力读数（**唯一实现**，启动时探一次）。
 *
 * 读的是"这次部署到底能不能兑现承诺"：
 *   · `binlogRowImageMinimal`：擦除语句会不会把原文写进二进制日志；
 *   · `logBin`：二进制日志是否开着（开着就存在"历史帧里仍有原文"的窗口）。
 * 这两个结论会进 `/healthz` 与擦除接口的返回体——**读不到就如实说读不到**，
 * 不把它折成"没问题"（本仓对"读不到"的一贯口径）。
 */
async function probeServerCapabilities() {
  const caps = { logBin: null, binlogRowImage: null, binlogRowImageMinimal: null, binlogExpireSeconds: null, probedAt: Date.now() };
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      "SHOW SESSION VARIABLES WHERE Variable_name IN ('log_bin','binlog_row_image','binlog_expire_logs_seconds')"
    );
    for (const r of rows) {
      if (r.Variable_name === 'log_bin') caps.logBin = String(r.Value).toUpperCase() === 'ON';
      if (r.Variable_name === 'binlog_row_image') caps.binlogRowImage = String(r.Value).toUpperCase();
      if (r.Variable_name === 'binlog_expire_logs_seconds') caps.binlogExpireSeconds = Number(r.Value);
    }
    caps.binlogRowImageMinimal = caps.binlogRowImage === 'MINIMAL';
  } catch (e) {
    console.warn(`[db] 服务器能力探测失败（不影响读写）：${e?.message || e}`);
  } finally {
    conn.release();
  }
  return caps;
}

/**
 * 服务器能力读数（未初始化时为 null）。`pool` 是**当前**连接池深度（不是启动时的快照），
 * 与 binlog 那几项一起进 `/healthz` 的 capabilities：`pool.inUse` 长期等于 connectionLimit
 * 或 `waiting` 持续非零，就是"请求在等库"的可观测证据（见 poolDepth 的说明）。
 */
export function serverCapabilities() {
  return serverCaps ? { ...serverCaps, pool: poolDepth() } : null;
}

/**
 * 值未变的 UPDATE 必须报 `changes = 1`（SQLite 的语义）。
 *
 * 为什么在启动时钉一次：全仓有几十处 `if (changes === 1)` 守卫（订单状态迁移、
 * 占位释放、卡密占用……），它们成立的前提正是"SQLite 对值未变的 UPDATE 也返回 1"。
 * mysql2 默认带 CLIENT_FOUND_ROWS（= 命中行数），与 SQLite 一致——
 * 但这是**驱动的默认值**，换个版本或换个人传一个 flags 就会静默变成"改变行数"，
 * 而后果是这些守卫集体失效（例如每次 sync 都被误判为"迁移成功"）。
 * 所以这里实测一次，不一致就**拒绝启动**：这是判据，不是可以商量的地方。
 */
async function assertChangesSemantics() {
  const conn = await pool.getConnection();
  try {
    await conn.query('CREATE TEMPORARY TABLE mk_changes_probe (id INT PRIMARY KEY, v INT)');
    await conn.query('INSERT INTO mk_changes_probe VALUES (1, 5)');
    const [r] = await conn.query('UPDATE mk_changes_probe SET v = 5 WHERE id = 1');
    if (Number(r.affectedRows) !== 1) {
      throw new Error(
        `驱动的 UPDATE 计数语义与 SQLite 不一致（值未变时 affectedRows=${r.affectedRows}，本仓要求 1）。` +
          '全仓的 `changes === 1` 守卫依赖"命中即 1"，请检查 mysql2 的 flags 是否被改成了不带 CLIENT_FOUND_ROWS。'
      );
    }
  } finally {
    conn.release();
  }
}

/* ─────────────────────────── 事务 ─────────────────────────── */

/** `withTransaction` 里抛出它 ⇒ 回滚并把 value 作为结果返回（见 abortTx） */
class TxAbort extends Error {
  constructor(value) {
    super('transaction aborted');
    this.name = 'TxAbort';
    this.value = value;
  }
}

/**
 * 在回调里回滚当前事务，并把 `value` 作为 `withTransaction` 的结果返回。
 *
 * 用途：调用方已经写好响应（`fail(res, …)`）或已经算出返回值，但这次事务里
 * 有过**必须丢弃的写入**。没有写入时不必调它——回调正常返回即提交，代价为零。
 */
export function abortTx(value) {
  throw new TxAbort(value);
}

/**
 * 事务的**唯一入口**：回调的作用域就是事务的作用域。
 *
 * - 顶层调用：从池里取一条连接 → `BEGIN`；回调返回即 `COMMIT`，抛错即 `ROLLBACK`，
 *   两条路径都会释放连接（**泄漏事务在形状上不可表达**）。
 * - 嵌套调用（回调里再次 `withTransaction`）：降级为 `SAVEPOINT`，内层回滚不伤外层。
 *
 * ⚠️ 回调里**不得 await 数据库以外的东西**（RPC / 网络 / 计时器）：事务期间握着行锁，
 * 一次外呼就把这些锁的持有时间拉长。没有全局锁不等于没有代价——挡住别人的从"全站"变成了
 * "这一行/这一批行"，链上读一律在进入本函数之前完成（见 routes/orders.js 与 chainReconcile.js）。
 */
export async function withTransaction(fn) {
  const outer = als.getStore();
  /* 已结束的作用域不是外层事务：它的连接已经归还池子，绝不能拿来开 SAVEPOINT（见 exec 的说明） */
  if (outer && !outer.closed) {
    outer.depth += 1;
    const name = `mk_sp_${outer.depth}`;
    await outer.conn.query(`SAVEPOINT ${name}`);
    try {
      const value = await fn();
      await outer.conn.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (e) {
      if (e instanceof TxAbort) {
        await outer.conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await outer.conn.query(`RELEASE SAVEPOINT ${name}`);
        return e.value;
      }
      await outer.conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await outer.conn.query(`RELEASE SAVEPOINT ${name}`);
      throw e;
    } finally {
      outer.depth -= 1;
    }
  }
  if (!pool) throw new Error('db not initialized');
  const conn = await pool.getConnection();
  const store = { conn, depth: 1, closed: false };
  activeTx.add(store);
  try {
    return await als.run(store, async () => {
      await conn.beginTransaction();
      try {
        const value = await fn();
        await conn.commit();
        return value;
      } catch (e) {
        await conn.rollback();
        if (e instanceof TxAbort) return e.value;
        throw e;
      }
    });
  } finally {
    /*
      **先作废作用域，再归还连接**（2026-10-22 复审）。

      归还之后这条连接会被池子交给别的请求，而它的对象引用仍留在 AsyncLocalStorage 里：
      事务回调里起过、没有 await 的 promise 链（`alertAck` 的投递后续就是一处）会在提交之后
      继续用 `store.conn` 执行 SQL——轻则写进一个已经结束的事务（连接已回到 autocommit），
      重则**混进另一个请求正在开的事务**（跟着别人的 ROLLBACK 一起消失，或把别人的锁带超时）。
      `closed` 让这些续作不再被当成"仍在事务里"（见 exec：此后读走池子、写各自开一笔新事务），
      于是**没有任何路径会再用那条已归还的连接**。
    */
    store.closed = true;
    activeTx.delete(store);
    conn.release();
  }
}

/**
 * 当前**仍开着事务**的连接数（测试用的读数）。
 *
 * 为什么值得暴露：`withTransaction` 的 finally 一定归还连接，所以这个数在正常路径上
 * 恒为 0；它非 0 只可能是"回调把连接带走没还"这类结构性破坏——那种情况下必须能看见，
 * 而不是让后续请求静默地排队等一条永远不归还的连接（池子只有那几条）。
 */
export function openTransactions() {
  return activeTx.size;
}

/* ─────────────────────────── 查询门面 ─────────────────────────── */

/**
 * 取查询门面。**全仓唯一的数据库入口**（`getDb().get/all/run`）。
 *
 * 事务内的调用自动落到事务那条连接上（凭 AsyncLocalStorage），事务外走池。
 * 这就是为什么没有"传 connection 参数"这种形状：需要它的地方一定会有人忘。
 */
export function getDb() {
  if (!pool) throw new Error('db not initialized');
  return facade;
}

const facade = {
  /** 单行（无行时 undefined，与旧实现一致） */
  async get(sql, ...params) {
    const rows = await exec(sql, params);
    return rows[0];
  },
  /** 多行 */
  async all(sql, ...params) {
    return exec(sql, params);
  },
  /**
   * 写入。返回 `{ changes, insertId }`。
   *
   * `changes` = **命中行数**（不是改变行数），与 SQLite 的 `changes` 同义；
   * 这一点由 `assertChangesSemantics` 在启动时实测钉住。
   * `insertId` = AUTO_INCREMENT 分配到的 id（无自增列时为 0）。
   */
  async run(sql, ...params) {
    const r = await exec(sql, params, true);
    return { changes: Number(r.affectedRows), insertId: Number(r.insertId) };
  },
};

/** 写语句的动词（只用于判定"这句要不要自己开事务"，见 exec 的说明） */
const WRITE_VERB = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

async function exec(sql, params, wantMeta = false) {
  const store = als.getStore();
  /*
    **已结束的事务作用域一律不认**（2026-10-22 复审）。

    事务提交后连接会归还池子，此时 AsyncLocalStorage 里仍留着那个 store：事务回调里起过、
    没有 await 的 promise 链（通知投递的后续、告警的结算）会带着它继续跑。若继续用 `store.conn`，
    写下去的东西要么落在一个已经结束的事务里，要么**混进另一个请求正在开的事务**
    （跟着别人的 ROLLBACK 一起消失，或把别人的锁拖到超时）。
    语义上此刻已经没有事务可加入，所以这里把它当作"没有事务上下文"：读走池子、写各自开一笔
    新事务。**绝不再碰那条已归还的连接。**
  */
  const tx = store && !store.closed ? store : null;
  if (tx?.conn) {
    const [rows] = await tx.conn.query(sql, params);
    return wantMeta ? rows : rows;
  }
  /*
    **没有事务上下文的写入，自己开一个事务。**

    为什么仍然这样：裸的 autocommit 写不参与调用方的事务，于是它能正好插进另一个事务
    "闸通过 → 落行"的窗口里 —— 草稿闸读到 9 张、这一句又插进一张、闸再插一张，上限 10
    就守不住了。而每条写都过 `withTransaction` 是本层的**唯一判据**：把"读计数/占位/插单"
    关进同一个事务是调用方的责任，"忘了包事务"不能是第二种写路径。
    代价：单条写入多一次 BEGIN/COMMIT 往返；换来的是"每条写都在一个明确作用域里"。
  */
  if (WRITE_VERB.test(sql)) return withTransaction(() => exec(sql, params, wantMeta));
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    conn.release();
  }
}

/* ─────────────────────────── 结构门禁：SCHEMA_DDL 的指纹 ─────────────────────────── */

/**
 * 结构门禁（**唯一实现**）。
 *
 * ## 为什么不是"必备列清单"
 *
 * `migrate()` 执行的全是 `CREATE TABLE IF NOT EXISTS`，对**已存在**的表是 no-op：列在不在
 * 看得见，而 CHECK / 索引 / 生成列表达式 / 列宽 / 外键删除规则都不在任何清单里。实测（测试机
 * 旧库）：缺 `ck_skus_committed`（`committed <= capacity`）⇒ `committed > capacity` 可表达
 * ⇒ **静默超卖**，而启动过程一切正常。列清单本身还是第二份真相：新增一列忘了登记，门禁就
 * 在那个缺口上放行——这正是要消灭的那一类错误。
 *
 * ## 判据的形状
 *
 * 把 `SCHEMA_DDL` + `TRIGGER_DDL` 在一座**临时库**里全量执行一遍（期望形状 = 建表语句本身），
 * 再用 `information_schema` 与真实库逐项对拍：
 *   · `COLUMNS`：类型/长度/可空/默认值/EXTRA（含生成列）/字符集与排序规则；
 *   · `STATISTICS`：索引名/列序/唯一性/表达式索引；
 *   · `TABLE_CONSTRAINTS` + `CHECK_CONSTRAINTS`：CHECK 名与表达式；
 *   · `KEY_COLUMN_USAGE` + `REFERENTIAL_CONSTRAINTS`：外键列序与删除规则；
 *   · `VIEWS`：读模型定义；
 *   · `TRIGGERS`：名/时机/事件/语句。
 *
 * 对拍范围**只包含 SCHEMA_DDL 声明过的对象**：运维自己的表、视图、触发器不在断言范围内
 * （真实库比建表语句多是正常状态）。触发器只断言"声明过的那些在不在、语句一不一致"。
 *
 * 有差异 ⇒ 打印"表.对象：缺/多/不同"与一份**幂等**修复清单（每条都先判存在，可重复运行），
 * 然后拒绝启动（exit 1）。修复清单由期望形状生成（`SHOW CREATE TABLE` 里的原始行），
 * 不是让人照着建表语句手抄。
 *
 * ## 顺序
 *
 * 老库在 `migrate()` **之前**对拍：migrate 每次启动都 DROP+CREATE 触发器，先建表就等于先把
 * 触发器那部分差异抹掉。新库（一张声明过的表都没有）由 `inspectSchemaStructure` 先建再对拍。
 */

const SCHEMA_PROBE_PREFIX = 'mk_schema_probe_';
/** 临时库名会拼进 SQL 标识符：只允许安全字符（库名来自配置，不能假设它干净） */
const SAFE_IDENT = /^[A-Za-z0-9_$]+$/;

/**
 * 结构自检用的临时库名（**确定性**：同一个节点库名恒得到同一个临时库名）。
 *
 * 为什么不是随机名：库级授权是按名字给的（`GRANT ALL ON db.*` 不会顺带允许建另一个库），
 * 运维必须能预先知道这个名字并单独授权；随机名只能在报错里事后告诉人，每次还要再改一次授权。
 * 并发安全由**实例锁**保证（同一节点库同时只有一个进程），残留库每次启动先 DROP 再建。
 *
 * 为什么是 `mk_schema_probe_<hash>` 而不是 `<节点库名>__schema_probe` 这种可读派生：这个函数
 * 的返回值会被 `DROP DATABASE IF EXISTS` 直接执行，**名字必须不可能是人建的库**。可读派生名
 * 恰好是可猜的（运维完全可能建一个 `foo__schema_probe`），猜中就等于启动时删掉一个真库。
 * 前缀 + 哈希不认识、猜不中；具体名字由拒绝启动时的报错原样打印（连同该给的 GRANT）。
 */
function probeDatabaseName() {
  const base = String(config.db.name || '');
  const name = `${SCHEMA_PROBE_PREFIX}${crypto.createHash('sha1').update(base).digest('hex').slice(0, 16)}`;
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`结构自检的临时库名不是安全标识符（来自 MK_DB_NAME=${JSON.stringify(base)}）：${JSON.stringify(name)}`);
  }
  return name;
}

/** SQL 文本归一：只折叠空白。它只用于"语义一致"的比较，不改变大小写与任何标识符/字面量 */
function normalizeSqlText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 触发器语句的归一：折叠空白 + **去掉结尾的分号**。
 *
 * 为什么去分号：MySQL 把 `CREATE TRIGGER … FOR EACH ROW <body>` 的 body 按原文存进
 * `ACTION_STATEMENT`，而多语句包（`TRIGGER_DDL.join(';\n')`）里**最后一条**触发器不带分隔符，
 * 其余带——于是"同一个 body、数组里换了位置"会让文本差一个 `;`，那是纯粹的书写差异
 * （语义相同），不该让老库在启动时被判成结构不一致。
 */
function normalizeTriggerStatement(text) {
  return normalizeSqlText(text).replace(/;+$/, '');
}

/** 去掉视图定义里的库名前缀（临时库与真实库的库名不同，名称本身不是结构差异） */
function stripSchemaQualifier(text, schema) {
  return normalizeSqlText(String(text ?? '').split(`\`${schema}\`.`).join(''));
}

/** 一行的若干个"形状字段"里哪些不同（列/索引/CHECK/FK 共用） */
function changedFields(expected, actual, keys) {
  return keys.filter((k) => JSON.stringify(expected[k] ?? null) !== JSON.stringify(actual[k] ?? null));
}

/**
 * 把 `SHOW CREATE TABLE` 的结果拆成"列定义 / 键与约束定义"，用于生成修复语句。
 * 只取行首形态（MySQL 的输出格式稳定：列行以反引号开头，键/约束行以 PRIMARY/KEY/CONSTRAINT 开头）。
 */
function parseCreateTable(createSql) {
  const columns = new Map();
  const keys = new Map();
  let tableOptions = '';
  for (const raw of String(createSql || '').split('\n')) {
    const line = raw.trim().replace(/,$/, '');
    if (!line) continue;
    if (line.startsWith('`')) {
      const m = /^`([^`]+)`/.exec(line);
      if (m) columns.set(m[1], line);
      continue;
    }
    if (/^PRIMARY KEY\b/.test(line)) {
      keys.set('PRIMARY', line);
      continue;
    }
    const key = /^(?:UNIQUE )?KEY `([^`]+)`/.exec(line);
    if (key) {
      keys.set(key[1], line);
      continue;
    }
    const constraint = /^CONSTRAINT `([^`]+)`/.exec(line);
    if (constraint) {
      keys.set(constraint[1], line);
      continue;
    }
    if (line.startsWith(')')) tableOptions = line;
  }
  return { columns, keys, tableOptions };
}

/**
 * 读一个库的完整结构指纹（**对拍两侧共用同一份读法**：临时库与真实库没有第二套判断）。
 *
 * `includeDefinitions` 只在期望侧开启：修复语句要用 `SHOW CREATE TABLE` 的原始定义行，
 * 而真实库不需要（它的定义就是"待修"的那一份）。
 */
async function collectSchemaFingerprint(conn, schema, { includeDefinitions = false } = {}) {
  const query = async (sql, params) => (await conn.query(sql, params))[0];
  const fingerprint = { tables: {}, triggers: {} };

  const tableRows = await query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_COLLATION AS collation
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [schema]
  );
  for (const t of tableRows) {
    fingerprint.tables[t.name] = {
      name: t.name,
      type: t.type,
      engine: t.engine ?? null,
      collation: t.collation ?? null,
      columns: [],
      indexes: {},
      checks: {},
      fks: {},
      view: null,
      definitions: null,
    };
  }

  for (const c of await query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, GENERATION_EXPRESSION AS generation,
            CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema]
  )) {
    const table = fingerprint.tables[c.tableName];
    if (!table) continue;
    table.columns.push({
      name: c.name,
      columnType: c.columnType,
      nullable: c.nullable,
      defaultValue: c.defaultValue ?? null,
      extra: c.extra,
      generation: normalizeSqlText(c.generation),
      charset: c.charset ?? null,
      collation: c.collation ?? null,
    });
  }

  for (const s of await query(
    `SELECT TABLE_NAME AS tableName, INDEX_NAME AS name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq,
            COLUMN_NAME AS columnName, EXPRESSION AS expression, SUB_PART AS subPart,
            COLLATION AS collation, INDEX_TYPE AS indexType, IS_VISIBLE AS visible
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [schema]
  )) {
    const table = fingerprint.tables[s.tableName];
    if (!table) continue;
    if (!table.indexes[s.name]) {
      table.indexes[s.name] = {
        name: s.name,
        nonUnique: Number(s.nonUnique),
        indexType: s.indexType,
        visible: s.visible,
        parts: [],
      };
    }
    table.indexes[s.name].parts.push({
      column: s.columnName ?? null,
      expression: s.expression === null || s.expression === undefined ? null : normalizeSqlText(s.expression),
      subPart: s.subPart === null || s.subPart === undefined ? null : Number(s.subPart),
      collation: s.collation ?? null,
    });
  }

  for (const c of await query(
    `SELECT tc.TABLE_NAME AS tableName, tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause, tc.ENFORCED AS enforced
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE = 'CHECK'
      ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME`,
    [schema]
  )) {
    const table = fingerprint.tables[c.tableName];
    if (!table) continue;
    table.checks[c.name] = { name: c.name, clause: normalizeSqlText(c.clause), enforced: c.enforced };
  }

  for (const f of await query(
    `SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS name, REFERENCED_TABLE_NAME AS refTable,
            DELETE_RULE AS deleteRule, UPDATE_RULE AS updateRule, MATCH_OPTION AS matchOption
       FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?
      ORDER BY TABLE_NAME, CONSTRAINT_NAME`,
    [schema]
  )) {
    const table = fingerprint.tables[f.tableName];
    if (!table) continue;
    table.fks[f.name] = {
      name: f.name,
      refTable: f.refTable,
      deleteRule: f.deleteRule,
      updateRule: f.updateRule,
      matchOption: f.matchOption,
      columns: [],
    };
  }
  for (const k of await query(
    `SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS name, COLUMN_NAME AS columnName,
            REFERENCED_COLUMN_NAME AS refColumn
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    [schema]
  )) {
    const fk = fingerprint.tables[k.tableName]?.fks?.[k.name];
    if (fk) fk.columns.push({ column: k.columnName, refColumn: k.refColumn });
  }

  for (const v of await query(
    'SELECT TABLE_NAME AS name, VIEW_DEFINITION AS definition FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?',
    [schema]
  )) {
    const table = fingerprint.tables[v.name];
    if (table) table.view = stripSchemaQualifier(v.definition, schema);
  }

  for (const t of await query(
    `SELECT TRIGGER_NAME AS name, EVENT_MANIPULATION AS event, EVENT_OBJECT_TABLE AS tableName,
            ACTION_TIMING AS timing, ACTION_STATEMENT AS statement
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
    [schema]
  )) {
    fingerprint.triggers[t.name] = {
      name: t.name,
      event: t.event,
      tableName: t.tableName,
      timing: t.timing,
      statement: normalizeTriggerStatement(t.statement),
    };
  }

  if (includeDefinitions) {
    for (const table of Object.values(fingerprint.tables)) {
      if (!SAFE_IDENT.test(table.name)) {
        throw new Error(`结构自检取建表语句时遇到不安全的表名：${JSON.stringify(table.name)}`);
      }
      const rows = await query(`SHOW CREATE TABLE \`${schema}\`.\`${table.name}\``);
      const createSql = Object.values(rows[0] || {})[1];
      table.definitions = {
        createSql: String(createSql || ''),
        ...(table.type === 'VIEW' ? { columns: new Map(), keys: new Map(), tableOptions: '' } : parseCreateTable(createSql)),
      };
    }
  }

  return fingerprint;
}

/**
 * 对拍两个指纹，只断言**期望侧声明过的对象**。
 *
 * 差异的形状固定为 `{ kind, table?, object?, fields?, expected?, actual? }`——打印与修复清单
 * 都只读这几个字段，不再各自解析文本。
 */
function diffSchemaFingerprints(expected, actual) {
  const diffs = [];
  const COLUMN_FIELDS = ['columnType', 'nullable', 'defaultValue', 'extra', 'generation', 'charset', 'collation'];
  const INDEX_FIELDS = ['nonUnique', 'indexType', 'visible', 'parts'];
  const CHECK_FIELDS = ['clause', 'enforced'];
  const FK_FIELDS = ['refTable', 'deleteRule', 'updateRule', 'matchOption', 'columns'];

  for (const [name, exp] of Object.entries(expected.tables)) {
    const act = actual.tables[name];
    if (!act) {
      diffs.push({ kind: exp.type === 'VIEW' ? 'view-missing' : 'table-missing', table: name });
      continue;
    }
    if (exp.type !== act.type) {
      diffs.push({ kind: 'table-kind', table: name, expected: exp.type, actual: act.type });
      continue;
    }
    if (exp.type === 'VIEW') {
      if (exp.view !== act.view) diffs.push({ kind: 'view-diff', table: name, expected: exp.view, actual: act.view });
      continue;
    }
    if (exp.engine !== act.engine || exp.collation !== act.collation) {
      diffs.push({ kind: 'table-option', table: name, fields: ['engine', 'collation'], expected: [exp.engine, exp.collation], actual: [act.engine, act.collation] });
    }

    const actColumns = new Map(act.columns.map((c) => [c.name, c]));
    const expColumnNames = new Set(exp.columns.map((c) => c.name));
    for (const e of exp.columns) {
      const a = actColumns.get(e.name);
      if (!a) {
        diffs.push({ kind: 'column-missing', table: name, object: e.name });
        continue;
      }
      const fields = changedFields(e, a, COLUMN_FIELDS);
      if (fields.length) diffs.push({ kind: 'column-diff', table: name, object: e.name, fields });
    }
    for (const a of act.columns) {
      if (!expColumnNames.has(a.name)) diffs.push({ kind: 'column-extra', table: name, object: a.name });
    }

    for (const [objName, e] of Object.entries(exp.indexes)) {
      const a = act.indexes[objName];
      if (!a) {
        diffs.push({ kind: 'index-missing', table: name, object: objName });
        continue;
      }
      const fields = changedFields(e, a, INDEX_FIELDS);
      if (fields.length) diffs.push({ kind: 'index-diff', table: name, object: objName, fields });
    }
    for (const objName of Object.keys(act.indexes)) {
      if (!exp.indexes[objName]) diffs.push({ kind: 'index-extra', table: name, object: objName });
    }

    for (const [objName, e] of Object.entries(exp.checks)) {
      const a = act.checks[objName];
      if (!a) {
        diffs.push({ kind: 'check-missing', table: name, object: objName, expected: e.clause });
        continue;
      }
      const fields = changedFields(e, a, CHECK_FIELDS);
      if (fields.length) diffs.push({ kind: 'check-diff', table: name, object: objName, fields, expected: e.clause, actual: a.clause });
    }
    for (const objName of Object.keys(act.checks)) {
      if (!exp.checks[objName]) diffs.push({ kind: 'check-extra', table: name, object: objName });
    }

    for (const [objName, e] of Object.entries(exp.fks)) {
      const a = act.fks[objName];
      if (!a) {
        diffs.push({ kind: 'fk-missing', table: name, object: objName });
        continue;
      }
      const fields = changedFields(e, a, FK_FIELDS);
      if (fields.length) diffs.push({ kind: 'fk-diff', table: name, object: objName, fields });
    }
    for (const objName of Object.keys(act.fks)) {
      if (!exp.fks[objName]) diffs.push({ kind: 'fk-extra', table: name, object: objName });
    }
  }

  // 触发器同样只查声明过的（额外触发器是运维的自由，不报错）
  for (const [name, exp] of Object.entries(expected.triggers)) {
    const act = actual.triggers[name];
    if (!act) {
      diffs.push({ kind: 'trigger-missing', object: name });
      continue;
    }
    const fields = changedFields(exp, act, ['event', 'tableName', 'timing', 'statement']);
    if (fields.length) diffs.push({ kind: 'trigger-diff', object: name, fields });
  }

  return diffs;
}

/** 把一段 SQL 变成 MySQL 字符串字面量（用于 PREPARE 的动态语句） */
function sqlStringLiteral(text) {
  return `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * 生成一条**幂等**修复：先判断"还差这一步吗"，再执行。
 *
 * MySQL 8 没有 `ADD COLUMN IF NOT EXISTS` / `DROP INDEX IF EXISTS`，所以用
 * `PREPARE` + `IF(条件, 语句, 'SELECT 1')`：重复执行时条件是"已经是期望状态"，
 * 实际只跑一句空转。条件里用 `DATABASE()`，操作符在目标库上执行即可。
 */
function guardedFix(neededCondition, ddl) {
  return (
    `SET @mk_fix := IF((${neededCondition}), ${sqlStringLiteral(ddl)}, 'SELECT 1');\n` +
    'PREPARE mk_schema_fix FROM @mk_fix;\n' +
    'EXECUTE mk_schema_fix;\n' +
    'DEALLOCATE PREPARE mk_schema_fix;'
  );
}

/**
 * information_schema 里的"某个对象存在吗"（**带括号的子查询**，条件里再拼 `= 0/1`）。
 * 括号不能省：`… WHERE CONSTRAINT_TYPE = 'CHECK' = 0` 会被解析成 `(… = 'CHECK') = 0`，
 * 即把 `= 0` 吃进 WHERE 里，计数恒为 0 ⇒ 修复要么永远不执行，要么每次执行。
 */
const objectExists = {
  column: (t, c) =>
    `(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${sqlStringLiteral(t)} AND COLUMN_NAME = ${sqlStringLiteral(c)})`,
  index: (t, c) =>
    `(SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${sqlStringLiteral(t)} AND INDEX_NAME = ${sqlStringLiteral(c)})`,
  check: (t, c) =>
    `(SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${sqlStringLiteral(t)} AND CONSTRAINT_NAME = ${sqlStringLiteral(c)} AND CONSTRAINT_TYPE = 'CHECK')`,
  fk: (t, c) =>
    `(SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ${sqlStringLiteral(t)} AND CONSTRAINT_NAME = ${sqlStringLiteral(c)})`,
};

/** 差异 → 一条可照做的修复（缺/多/不同各自能表达成什么，就生成什么） */
function repairSqlFor(diff, expected) {
  const table = diff.table ? expected.tables[diff.table] : null;
  const defs = table?.definitions;
  const header = `-- ${diff.table ? `${diff.table}.${diff.object ?? ''}` : diff.object}：${diffLabel(diff)}`;
  const line = (key, fallback) => {
    const found = defs?.keys?.get(key) || defs?.columns?.get(key);
    if (!found) return `${fallback}（取不到期望定义，见 SCHEMA_DDL）`;
    return found;
  };

  switch (diff.kind) {
    case 'table-missing': {
      if (!defs?.createSql) return `${header}\n-- 取不到期望建表语句，见 SCHEMA_DDL`;
      const create = defs.createSql.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ').replace(/ AUTO_INCREMENT=\d+/, '');
      return `${header}\n${create};`;
    }
    case 'view-missing':
    case 'view-diff':
      return `${header}\nCREATE OR REPLACE VIEW \`${diff.table}\` AS ${table.view};`;
    case 'table-kind':
      return `${header}\n-- 表/视图的类型变了，无法用 ALTER 表达；按 SCHEMA_DDL 重建该对象（先备份数据）`;
    case 'table-option':
      return `${header}\nALTER TABLE \`${diff.table}\` ENGINE=InnoDB COLLATE ${DB_COLLATION};`;
    case 'column-missing':
      return `${header}\n${guardedFix(`${objectExists.column(diff.table, diff.object)} = 0`, `ALTER TABLE \`${diff.table}\` ADD COLUMN ${line(diff.object, '`' + diff.object + '`')}`)}`;
    case 'column-diff':
      return `${header}\nALTER TABLE \`${diff.table}\` MODIFY COLUMN ${line(diff.object, '`' + diff.object + '`')};`;
    case 'column-extra':
      return `${header}\n${guardedFix(`${objectExists.column(diff.table, diff.object)} = 1`, `ALTER TABLE \`${diff.table}\` DROP COLUMN \`${diff.object}\``)}`;
    case 'index-missing':
      return `${header}\n${guardedFix(`${objectExists.index(diff.table, diff.object)} = 0`, `ALTER TABLE \`${diff.table}\` ADD ${line(diff.object, `KEY \`${diff.object}\``)}`)}`;
    case 'index-diff':
      // 由 buildRepairPlan 拆成"先删、后建"两条（见 repairDropSql/repairAddSql 的说明）
      return `${repairDropSql(diff, expected)}\n${repairAddSql(diff, expected)}`;
    case 'index-extra':
      if (diff.object === 'PRIMARY') return `${header}\n-- 主键不可能"多出来"；请人工核对`;
      return `${header}\n${guardedFix(`${objectExists.index(diff.table, diff.object)} = 1`, `ALTER TABLE \`${diff.table}\` DROP INDEX \`${diff.object}\``)}`;
    case 'check-missing':
      return `${header}\n${guardedFix(`${objectExists.check(diff.table, diff.object)} = 0`, `ALTER TABLE \`${diff.table}\` ADD ${line(diff.object, `CONSTRAINT \`${diff.object}\` CHECK`)}`)}`;
    case 'check-diff':
      return `${repairDropSql(diff, expected)}\n${repairAddSql(diff, expected)}`;
    case 'check-extra':
      return `${header}\n${guardedFix(`${objectExists.check(diff.table, diff.object)} = 1`, `ALTER TABLE \`${diff.table}\` DROP CHECK \`${diff.object}\``)}`;
    case 'fk-missing':
      return `${header}\n${guardedFix(`${objectExists.fk(diff.table, diff.object)} = 0`, `ALTER TABLE \`${diff.table}\` ADD ${line(diff.object, `CONSTRAINT \`${diff.object}\` FOREIGN KEY`)}`)}`;
    case 'fk-diff':
      return `${repairDropSql(diff, expected)}\n${repairAddSql(diff, expected)}`;
    case 'fk-extra':
      return `${header}\n${guardedFix(`${objectExists.fk(diff.table, diff.object)} = 1`, `ALTER TABLE \`${diff.table}\` DROP FOREIGN KEY \`${diff.object}\``)}`;
    case 'trigger-missing':
    case 'trigger-diff': {
      const t = expected.triggers[diff.object];
      if (!t) return `${header}\n-- 取不到期望触发器定义，见 TRIGGER_DDL`;
      /*
        复合触发器体（BEGIN/END）含内部分号：`mysql` 客户端会按分号切语句，粘进交互式
        session 时 CREATE 会被切成几段。所以这一类必须整条发送（mysql 客户端用 DELIMITER，
        编程客户端用单条 query）——修复清单把这句话写在语句前面，免得人照着执行却得到
        "语法错误"而以为修复本身是错的。
      */
      const compound = /^BEGIN\b/i.test(String(t.statement || ''))
        ? '\n-- 复合触发器体（BEGIN/END）：请把下面这条 CREATE 作为**单条语句**发送（mysql 客户端需先 DELIMITER）'
        : '';
      return `${header}${compound}\nDROP TRIGGER IF EXISTS \`${t.name}\`;\nCREATE TRIGGER \`${t.name}\` ${t.timing} ${t.event} ON \`${t.tableName}\` FOR EACH ROW ${t.statement};`;
    }
    default:
      return `${header}\n-- 没有可自动生成的修复；按 SCHEMA_DDL 重建该对象`;
  }
}

/**
 * 修复语句的**执行阶段**（数字小的先执行；同阶段保持指纹/差异顺序）。
 *
 * 为什么必须排序（真实可踩的顺序错误）：MySQL 8 在 DROP COLUMN 时如果该列被 CHECK 约束
 * 引用，会以 `Check constraint 'x' uses column 'y', hence column cannot be dropped` 拒绝；
 * 被索引/外键引用同样会失败。而指纹差异的顺序是"先列后索引、再 CHECK、最后外键"
 * （`diffSchemaFingerprints` 的分组顺序），直接 map 成修复清单就会先给出 DROP COLUMN。
 * 运维照着执行会在第一条就失败，而"修复清单不能直接执行"等于把最后一道自救手段废掉。
 *
 * 分档（每一档内部不互相依赖）：
 *   0 表/视图级（缺表、表选项、视图替换）
 *   1 **DROP** 约束/索引/外键 —— 必须在删列之前
 *   2 多出的列（DROP COLUMN）
 *   3 列定义变更（MODIFY COLUMN；依赖列已存在）
 *   4 缺列（ADD COLUMN；后续约束依赖它）
 *   5 ADD 约束/索引/外键
 *   6 触发器（可能引用新列/新表，最后建）
 * `index-diff`/`check-diff`/`fk-diff` 含 DROP + ADD：`buildRepairPlan` 把它们**拆成两条**
 * （DROP 在阶段 1、ADD 在阶段 5），否则"删列前要删旧约束"与"建新约束要等新列"无法同时成立。
 */
const REPAIR_PHASE = {
  'table-missing': 0,
  'table-kind': 0,
  'table-option': 0,
  'view-missing': 0,
  'view-diff': 0,
  'index-extra': 1,
  'index-diff': 1,
  'check-extra': 1,
  'check-diff': 1,
  'fk-extra': 1,
  'fk-diff': 1,
  'column-extra': 2,
  'column-diff': 3,
  'column-missing': 4,
  'index-missing': 5,
  'check-missing': 5,
  'fk-missing': 5,
  'trigger-missing': 6,
  'trigger-diff': 6,
};

/**
 * `*‑diff` 类差异的**删除半边**（DROP INDEX / DROP CHECK / DROP FOREIGN KEY）。
 *
 * 为什么把 diff 拆成两条：它本来是一条 `DROP … , ADD …`。指纹差异里"列多出来/缺列"与
 * "约束定义不同"可以同时出现，而 MySQL 对被引用列拒绝 DROP COLUMN——DROP 那半边必须在
 * 所有列删除之前，ADD 那半边必须在新列加好之后。合成一条时无论排在哪个阶段都会有一类旧库失败。
 */
function repairDropSql(diff, expected) {
  const table = diff.table ? expected.tables[diff.table] : null;
  const header = `-- ${diff.table}.${diff.object}：${diffLabel(diff)}（先删旧定义）`;
  if (diff.kind === 'index-diff') {
    if (diff.object === 'PRIMARY') return `${header}\nALTER TABLE \`${diff.table}\` DROP PRIMARY KEY;`;
    return `${header}\n${guardedFix(
      `${objectExists.index(diff.table, diff.object)} = 1`,
      `ALTER TABLE \`${diff.table}\` DROP INDEX \`${diff.object}\``
    )}`;
  }
  if (diff.kind === 'check-diff') {
    return `${header}\n${guardedFix(
      `${objectExists.check(diff.table, diff.object)} = 1`,
      `ALTER TABLE \`${diff.table}\` DROP CHECK \`${diff.object}\``
    )}`;
  }
  if (diff.kind === 'fk-diff') {
    return `${header}\n${guardedFix(
      `${objectExists.fk(diff.table, diff.object)} = 1`,
      `ALTER TABLE \`${diff.table}\` DROP FOREIGN KEY \`${diff.object}\``
    )}`;
  }
  return null;
}

/** `*‑diff` 类差异的**新增半边**（ADD INDEX / ADD CONSTRAINT …），必须在列增删之后执行 */
function repairAddSql(diff, expected) {
  const table = diff.table ? expected.tables[diff.table] : null;
  const defs = table?.definitions;
  const header = `-- ${diff.table}.${diff.object}：${diffLabel(diff)}（再建新定义）`;
  const line = (key, fallback) => {
    const found = defs?.keys?.get(key) || defs?.columns?.get(key);
    if (!found) return `${fallback}（取不到期望定义，见 SCHEMA_DDL）`;
    return found;
  };
  if (diff.kind === 'index-diff') {
    return `${header}\nALTER TABLE \`${diff.table}\` ADD ${line(diff.object, diff.object === 'PRIMARY' ? 'PRIMARY KEY' : `KEY \`${diff.object}\``)};`;
  }
  if (diff.kind === 'check-diff') {
    return `${header}\nALTER TABLE \`${diff.table}\` ADD ${line(diff.object, `CONSTRAINT \`${diff.object}\` CHECK`)};`;
  }
  if (diff.kind === 'fk-diff') {
    return `${header}\nALTER TABLE \`${diff.table}\` ADD ${line(diff.object, `CONSTRAINT \`${diff.object}\` FOREIGN KEY`)};`;
  }
  return null;
}

/**
 * 差异 → **可照着执行**的修复清单（顺序见 `REPAIR_PHASE`）。
 * 纯函数（不读库）；顺序由 `test/schema-fingerprint.test.js` 用真实旧 schema 钉住。
 */
function buildRepairPlan(diffs, expected) {
  /** @type {{phase:number, sql:string}[]} */
  const steps = [];
  for (const d of diffs) {
    if (d.kind === 'index-diff' || d.kind === 'check-diff' || d.kind === 'fk-diff') {
      const drop = repairDropSql(d, expected);
      const add = repairAddSql(d, expected);
      if (drop) steps.push({ phase: 1, sql: drop });
      if (add) steps.push({ phase: 5, sql: add });
      continue;
    }
    steps.push({ phase: REPAIR_PHASE[d.kind] ?? 9, sql: repairSqlFor(d, expected) });
  }
  // Array.prototype.sort 是稳定排序：同阶段保持指纹差异顺序（输出可预期、可对拍）
  return steps.sort((a, b) => a.phase - b.phase).map((s) => s.sql);
}

/** 差异的一句话形态（打印与修复注释共用，保证两处不会各说一套） */
function diffLabel(diff) {
  switch (diff.kind) {
    case 'table-missing': return '缺（整张表）';
    case 'view-missing': return '缺（视图）';
    case 'view-diff': return '不同（视图定义）';
    case 'table-kind': return '不同（表/视图类型）';
    case 'table-option': return '不同（引擎/排序规则）';
    case 'column-missing': return '缺列';
    case 'column-extra': return '多出的列';
    case 'column-diff': return `不同（${diff.fields.join('/')}）`;
    case 'index-missing': return '缺索引';
    case 'index-extra': return '多出的索引';
    case 'index-diff': return `不同（${diff.fields.join('/')}）`;
    case 'check-missing': return '缺 CHECK 约束';
    case 'check-extra': return '多出的 CHECK 约束';
    case 'check-diff': return `不同（${diff.fields.join('/')}）`;
    case 'fk-missing': return '缺外键';
    case 'fk-extra': return '多出的外键';
    case 'fk-diff': return `不同（${diff.fields.join('/')}）`;
    case 'trigger-missing': return '缺触发器';
    case 'trigger-diff': return `不同（${diff.fields.join('/')}）`;
    default: return diff.kind;
  }
}

function describeSchemaDiff(diff) {
  const where = diff.table ? `${diff.table}.${diff.object ?? '（表）'}` : diff.object;
  return `${where}：${diffLabel(diff)}`;
}

/**
 * 在临时库里把 `SCHEMA_DDL` 全量执行一遍，得到**期望形状**。
 *
 * 临时库名确定性、每次先 DROP 再建（上一次崩在中间留下的半成品不能参与对拍）。
 * 账号没有建库权限时**拒绝启动**：结构自检兑现不了，就等于回到"老库带着缺口跑起来"，
 * 而那种失败是静默的（超卖/静默关闭的检测），比"运维要加一条 GRANT"贵得多。
 *
 * 只借**一条**连接（先 CREATE DATABASE 再 USE 过去）：节点是单进程、测试是上百个进程并行，
 * 每次启动多占两条连接会在并发启动时顶到 MySQL 的 max_connections。
 */
async function withProbeSchema(fn) {
  const probe = probeDatabaseName();
  const conn = await mysql.createConnection({ ...baseConnectionOptions(), multipleStatements: true });
  try {
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${probe}\``);
      await conn.query(`CREATE DATABASE \`${probe}\` CHARACTER SET utf8mb4 COLLATE ${DB_COLLATION}`);
    } catch (e) {
      if (!['ER_DBACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_CANT_CREATE_DB'].includes(e.code)) throw e;
      console.error(`[db] 结构自检需要在一个临时库里把建表语句全量执行一遍，但当前账号建不了它：${e.message}`);
      console.error(`[db] 临时库名（由本节点库名派生，固定）：\`${probe}\``);
      console.error('[db] 没有它就无法核对真实库的结构（CHECK/索引/生成列/列宽都不在 CREATE TABLE IF NOT EXISTS 的射程内），');
      console.error('[db] 因此拒绝启动——否则就是一个"看起来启动成功、实际带着结构缺口"的库。');
      console.error('[db] 处置：给节点账号加这个临时库的权限，例如：');
      console.error(`[db]   GRANT ALL PRIVILEGES ON \`${probe}\`.* TO '<节点账号>'@'%';`);
      process.exit(1);
    }
    try {
      await conn.query(`USE \`${probe}\``);
      await conn.query(SCHEMA_DDL);
      await conn.query(TRIGGER_DDL.join(';\n'));
      return await fn(conn, probe);
    } finally {
      try {
        await conn.query(`DROP DATABASE IF EXISTS \`${probe}\``);
      } catch (e) {
        console.error(`[db] 结构自检的临时库 \`${probe}\` 清理失败（不影响本次结论）：${e?.message || e}`);
      }
    }
  } finally {
    await conn.end().catch(() => {});
  }
}

/** 真实库的指纹读法（池上一条连接；连接用完即还） */
async function readRealSchemaFingerprint() {
  const conn = await pool.getConnection();
  try {
    return await collectSchemaFingerprint(conn, config.db.name);
  } finally {
    conn.release();
  }
}

/**
 * 结构自检（**返回结论，不退出**；门禁的 exit 在 initDb 里，测试因此能直接断言）。
 *
 * 新库（一张声明过的表都没有）在这里先建出来再对拍；老库直接对拍（见 initDb 的顺序说明）。
 *
 * @returns {Promise<{ok:boolean, diffs:Array<object>, repairs:string[], fresh:boolean}>}
 */
export async function inspectSchemaStructure() {
  const expected = await withProbeSchema((conn, probe) => collectSchemaFingerprint(conn, probe, { includeDefinitions: true }));
  let actual = await readRealSchemaFingerprint();
  const fresh = !Object.keys(expected.tables).some((name) => actual.tables[name]);
  if (fresh) {
    await migrate();
    actual = await readRealSchemaFingerprint();
  }
  const diffs = diffSchemaFingerprints(expected, actual);
  const repairs = buildRepairPlan(diffs, expected);
  return { ok: diffs.length === 0, diffs, repairs, fresh };
}

/** 打印结构差异 + 修复清单（**只由 diff 的固定形状生成**，不在这里另做判断） */
function reportSchemaStructureFailure(diffs, repairs) {
  console.error(`[db] 数据库结构自检未通过：真实库与 SCHEMA_DDL 的形状不一致（${diffs.length} 处），已拒绝启动。`);
  for (const d of diffs) console.error(`[db]   ${describeSchemaDiff(d)}`);
  console.error('[db] 期望形状的唯一真相是 src/db.js 的 SCHEMA_DDL / TRIGGER_DDL（在临时库里全量执行一遍得到），不存在第二份清单。');
  console.error('[db] 运维自己的表/视图/触发器不在对拍范围内（不会因此报错）。');
  console.error('[db] 处置：在目标库上依次执行下面的修复（每条都先判存在，可重复运行；执行前先备份）：');
  for (const sql of repairs) console.error(sql);
  console.error('[db] 修复后重新启动。若差异来自误删/手工改表，也可以按 node/docs/OPERATIONS.md 重建库（会丢数据）。');
}

/* ─────────────────────────── 建表 ─────────────────────────── */

/**
 * 建库结构（幂等；**直接建最终结构，不做存量迁移**）。
 *
 * ⚠️ 它只对**新库**与**已通过结构门禁的库**执行：`CREATE TABLE IF NOT EXISTS` 对已存在的表
 * 是 no-op，老库缺的 CHECK/索引/列宽它一个都补不上——那些缺口由 `inspectSchemaStructure`
 * 在启动时拒绝（并给出修复清单），不是靠这里"再执行一遍建表语句"蒙混过去。
 */
async function migrate() {
  /*
    建表走**一条临时连接**，且只在这一条上开 `multipleStatements`：
    业务池一律关着它（SQL 注入的第二道网，见 baseConnectionOptions），
    整段 DDL 因此不能从池上发。这条连接只服务这一次建表，用完即关。
  */
  const conn = await mysql.createConnection({
    ...baseConnectionOptions(),
    database: config.db.name,
    multipleStatements: true,
  });
  try {
    await conn.query(SCHEMA_DDL);
    /*
      触发器与建表同一批下发（同样只有这一条连接允许多语句）：它们是 schema 的一部分，
      不是可选的加固——缺了它们，配额计数器的减量半边就不存在（见 TRIGGER_DDL 的说明）。
      `DROP … IF EXISTS` + `CREATE` 保证每次启动都重建一次（幂等）。
    */
    await conn.query(TRIGGER_DDL.join(';\n'));
  } finally {
    await conn.end();
  }
}

/**
 * 全库 DDL。多语句一次性下发（只有这里允许；业务语句一律单条——见 baseConnectionOptions
 * 的 `multipleStatements: false`）。
 */
const SCHEMA_DDL = `
  /*    ════════════════════════════════════════════════════════════════════════════
    提示：本段整块位于 JS 模板字面量里 —— 注释中**不得出现反引号**。
    ════════════════════════════════════════════════════════════════════════════

    MySQL 8 原生 schema（**不是 SQLite 设计的翻译**）。六条贯穿全库的形状规则：

    R1 代理键：每张表 id BIGINT UNSIGNED AUTO_INCREMENT 作聚簇主键；业务标识各自 UNIQUE。
       唯一例外是 shops.code CHAR(9)——它 9 字节、**由本节点铸造**、不可变，再套一层代理键只会多一次 JOIN。
       （旧形状是 orders.id VARCHAR(40) 当主键，5 张子表各背 40 字节外键。）
    R2 类型按语义精确：地址 CHAR(42)、交易哈希/托管单号 CHAR(66)、店铺编号 CHAR(9)、
       订单号 CHAR(21)、商品标识 CHAR(11)；wei 金额 DECIMAL(38,0)、微 USDT BIGINT UNSIGNED、
       汇率 DECIMAL(20,10)。
       （旧形状把 9 位编号放进 VARCHAR(64)、把地址与金额放进 TEXT。）

    R2b **地址与店铺编号的大小写是库级约束，不是调用点纪律**：库级排序规则 as_cs 下
       '0xAbc…' 与 '0xabc…' 是两个不同的键，而"写入前一律折小写"只活在每个写者手里。
       任何直连 SQL / 导入脚本写进一个带校验和的地址，那一行对所有小写查询**永久不可见**
       且不报错（本仓实测过这一类）。所以判据挂在列上：每个 CHAR(42) 地址列带
       CHECK (col = LOWER(col))，每个 CHAR(9) 店铺编号列带 CHECK (col = UPPER(col))
       （Crockford Base32 的唯一规范形是大写，编号由本节点铸造）。新增地址/店铺编号列
       必须同批带上这条约束——test/schema-identity-case.test.js 从本段 DDL 派生清单并在
       缺一条时变红。
    R3 闭合集合用 ENUM：值域写在列定义里、占 1 字节、SHOW COLUMNS 自带文档。
    R4 真 JSON 列 + 多值索引（MEMBER OF / JSON_CONTAINS 都走索引，实测）。
       旧形状是 JSON 存 TEXT + 两张镜像表（product_tags / product_attributes）。
    R5 排序规则**库级一种**（utf8mb4_0900_as_cs，建库时定）；需要大小写不敏感时
       在**谓词上**写 COLLATE utf8mb4_0900_ai_ci。旧形状是逐列混用 _bin / _ai_ci，
       例外藏在列定义里看不见，而且两张不同排序规则的表一 JOIN 就报 Illegal mix of collations。
    R6 归属关系一律落成外键。旧形状全靠应用层，于是"没有归属的订单"能悄悄存在
       （实测：加外键后 shop_code 为空串或不存在的编号**插不进去**）。

    三处**刻意保留的"不标准"**，各自守着一件类型换不来的东西：
      · product_snapshot 用 MEDIUMTEXT 而不是 JSON：MySQL 的 JSON 会规范化
        （键重排、去空格、重复键去重，实测），而快照哈希是给第三方核验的契约，字节必须由应用决定；
      · created_boot / created_mono 保持 BIGINT：它们是**单调时钟读数**，不是墙上时间；
      · sku_key / 码 / tokenId 保持区分大小写（库级 as_cs 已覆盖，不再逐列声明）。

    时间一律 DATETIME(3)：DEFAULT CURRENT_TIMESTAMP(3) 由**服务器**盖章，
    应用时钟错了也写不错；读出来是 Date、出口是 ISO-8601 —— 这是**破坏性的接口变更**，
    前端与所有 DTO 同批改（不做 typeCast 折回毫秒：那是让库迁就旧代码的兼容垫片）。
    单调锚点仍是 BIGINT（它们是单调时钟读数，不是墙上时间）。
  */

  /* ── 节点自身（一库一节点）──
     旧形状把这些塞在 kv 的两列里（EAV）：对外店名与公告、合约地址锚、轮询游标、隔离事件。
     它们是**已知的几个单例**，就该是带类型的列，而不是字符串键值。 */
  CREATE TABLE IF NOT EXISTS node (
    id            TINYINT UNSIGNED NOT NULL DEFAULT 1,
    owner         CHAR(42) NOT NULL,                    -- 节点主钱包（小写）
    name          VARCHAR(60) NOT NULL DEFAULT '',      -- 节点对外名称（公开可见；空 = 没设置过，展示时回退域名/中性占位）
    notice        VARCHAR(500) NOT NULL DEFAULT '',     -- 节点公告（公开可见）
    /*
      谈信地址（公开客服联系方式）：0x… 或 1… 两种写法，**原样保存**。
      不用 CHAR(42)/LOWER CHECK：1 开头的 BTY 地址是 base58、区分大小写，长度也不是 42；
      形状校验的唯一入口是 src/tanxin.js（写入口），库列只负责存。
    */
    tanxin_address VARCHAR(64) NULL,
    escrow_address CHAR(42) NULL,                       -- 托管合约地址锚（换址门禁读它）
    /*
      本节点的保证金合约地址锚（MK_STAKING_ADDRESS）。它与 escrow 一对一（链上 Registry
      登记时校验 escrow.staking() / staking.escrow() 互为对方），节点只读它算出金下限。
      留空 = 未接入保证金层（卖家不能质押，罚没/提货赔付路径不可用）。
    */
    staking_address CHAR(42) NULL,
    watcher_block BIGINT UNSIGNED NULL,                 -- 事件轮询游标（已处理到的块）
    watcher_hash  CHAR(66) NULL,                        -- 该块的哈希（短重组回退用）
    auto_flush_pending TINYINT(1) NOT NULL DEFAULT 0,   -- 轮询落后时挂起、下一趟补扫的标记
    /*
      两个对账游标是 **(updated_at, id) 键集分页对**，不是块号。
      为什么是两列而不是一个 BIGINT：对账按 orders.updated_at 升序遍历，而 updated_at 可以相同
      （同一毫秒里改了两单），只记时间会漏单或重复，只记 id 又用不上时间索引；
      两列一起才是"上次读到哪儿"的完整答案，并与 ORDER BY updated_at, id 的顺序一致。
      NULL = 从未对账过（**不是 0**：0 会被读成"从时间原点开始"，那是一次全表扫描）。
    */
    reconcile_at DATETIME(3) NULL,
    reconcile_order_id BIGINT UNSIGNED NULL,
    reconcile_after_sale_at DATETIME(3) NULL,
    reconcile_after_sale_order_id BIGINT UNSIGNED NULL,
    /*
      **是对象不是数组**：隔离清单按"事件指纹 → 重试次数/时刻"索引
      （Object.entries / Object.fromEntries）。若默认成空数组，JS 侧往数组上挂非索引属性
      仍然"能跑"，但 JSON.stringify 对数组**只序列化索引元素**——隔离记录会被静默丢光，
      而失败事件因此被无限重试。默认值与用法必须同形。
    */
    quarantined_events JSON NOT NULL DEFAULT ('{}'),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    CONSTRAINT ck_node_singleton CHECK (id = 1),
    CONSTRAINT ck_node_owner_lower CHECK (owner = LOWER(owner)),
    CONSTRAINT ck_node_escrow_address_lower CHECK (escrow_address = LOWER(escrow_address)),
    CONSTRAINT ck_node_staking_address_lower CHECK (staking_address = LOWER(staking_address))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* ── 节点级 ERC20 支付资产 ──
     这是**节点自己的经营配置**（收哪些币、按什么价折算），不是店铺配置；只有节点主能改。
     链上 Escrow.supportedToken 仍是"能不能收"的唯一授权：本表只决定"节点愿不愿意报价"，
     公开支付方式接口会把本表与链上 supportedToken 取交集。两处职责不同，不互为真相。
     mode='oracle' 时 fixed 是行情源失败时的兜底价（可空；空 = 行情不可用时该币不可支付）。 */
  CREATE TABLE IF NOT EXISTS payment_tokens (
    address       CHAR(42) NOT NULL,                    -- token 合约地址（小写）
    symbol        VARCHAR(20) NOT NULL,
    decimals      TINYINT UNSIGNED NOT NULL,
    mode          ENUM('fixed','oracle') NOT NULL DEFAULT 'fixed',
    fixed_usdt_micro_per_token DECIMAL(38,0) NULL,      -- 1 个整 token = 多少微 USDT（fixed 必填；oracle 为兜底）
    price_url     VARCHAR(2048) NULL,                   -- oracle 行情源（https）
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (address),
    CONSTRAINT ck_payment_tokens_address_lower CHECK (address = LOWER(address)),
    CONSTRAINT ck_payment_tokens_decimals CHECK (decimals <= 36),
    CONSTRAINT ck_payment_tokens_fixed_positive CHECK (
      fixed_usdt_micro_per_token IS NULL OR fixed_usdt_micro_per_token > 0
    ),
    CONSTRAINT ck_payment_tokens_mode_rate CHECK (
      (mode = 'fixed' AND fixed_usdt_micro_per_token IS NOT NULL)
      OR (mode = 'oracle' AND price_url IS NOT NULL AND price_url <> '')
    )
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* ── 店铺（租户表）──
     店铺是**节点链下**的事实：平台目录只登记节点（operator/escrow/staking/endpoint），
     不登记店铺；因此 code 由**本节点**铸造（9 位 Crockford Base32，见 src/ids.js 的
     newShopCode），不是任何链上返回值，也没有"链上镜像"字段可对账。
     去掉 host 列：一库一节点，节点主就在 node 表那一行里，店铺行再存一遍是第二份真相。
     店名/公告也回到这里（旧形状把它们放在 kv，那是"配置极简"时代的形状，不是数据模型）。 */
  CREATE TABLE IF NOT EXISTS shops (
    code          CHAR(9) NOT NULL,                     -- 本节点铸造：8 位数据 + 1 位加权校验
    seller        CHAR(42) NOT NULL,                    -- 店主钱包（小写）= 订单的 seller
    name          VARCHAR(60) NOT NULL DEFAULT '',
    notice        VARCHAR(500) NOT NULL DEFAULT '',
    /* 本店谈信地址（公开客服联系方式）；形状与保存口径见 node 表的同名列说明 */
    tanxin_address VARCHAR(64) NULL,
    /*
      listed = 0 = **不能接单 + 不进前端聚合**（节点主/员工暂停）。
      它不是"店下线"：该店的发货、同意/拒绝退款、售后案件、个人信息擦除、自有资料维护
      全部照常可用（见 shops.js 文件头）。
      listed_reason / listed_at 是**暂停这一动作**的两个事实：原因给店主看（他要知道该找谁、
      改什么），时间给节点管理面排序。恢复接单时原因清空、时间保留为"最近一次切换"。
    */
    listed        TINYINT(1) NOT NULL DEFAULT 1,
    listed_reason VARCHAR(200) NOT NULL DEFAULT '',
    listed_at     DATETIME(3) NULL,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (code),
    /*
      **一个地址在一个节点上只能开一家店**——这条由本唯一键在库里钉死（不是靠应用记得判）。
      本表：seller 唯一 ⇒ 本节点内一个地址最多一行 ⇒ 最多一家店。
      "可经营多家店"只可能来自另一个来源：这个地址被**另一家店**写进了店员名单
      （shop_operators 表）。见 http.js 的 soleOperatedShop。
    */
    UNIQUE KEY uq_shops_seller (seller),
    KEY idx_shops_listed (listed, code),
    CONSTRAINT ck_shops_code_upper CHECK (code = UPPER(code)),
    CONSTRAINT ck_shops_seller_lower CHECK (seller = LOWER(seller)),
    CONSTRAINT ck_shops_listed_bool CHECK (listed IN (0, 1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /*
    开店申请（**节点链下审批流**）。不是店铺的第二份真相：店存不存在只由 shops 回答，
    审批通过时由同一事务铸造编号并插入 shops 行。
    没有双签票据/费率/链上交易哈希：这些概念随"店铺上链"一起删除了。
  */
  CREATE TABLE IF NOT EXISTS shop_applications (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    seller        CHAR(42) NOT NULL,
    name          VARCHAR(60) NOT NULL DEFAULT '',
    notice        VARCHAR(500) NOT NULL DEFAULT '',
    status        ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    reject_reason VARCHAR(200) NOT NULL DEFAULT '',
    reviewed_at   DATETIME(3) NULL,                     -- 审批/驳回时刻（NULL = 还没人看过）
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    -- 一个钱包只允许一条**未终结**的申请；被拒之后改名再申请仍然可行（旧行走 rejected）。
    -- approved 也算未终结：审批通过即已建店，这条申请到此为止，不再占用"可再次申请"的位子。
    UNIQUE KEY uq_applications_open ((IF(status = 'pending', seller, NULL))),
    KEY idx_applications_status (status, id),
    CONSTRAINT ck_shop_applications_seller_lower CHECK (seller = LOWER(seller))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 店员白名单：**一行一人**。
     旧形状是 kv 里的一份 JSON 数组，于是"加一个/删一个"是读-改-写，
     两个并发请求会互相覆盖（被移除的店员仍然有权限，且静默）。一行一人之后，
     增删各是一条语句，丢更新在形状上不可表达。

     ⚠️ **主键是 (店铺, 地址)，所以同一个地址可以在多行里出现**——这正是"一人可经营多家店"
     的**唯一来源**（一个地址在一个节点上只能开一家店，见 shops 的 uq_shops_seller）：
     我在 A 店是店主、同时被 B 店与 C 店列为店员 ⇒ 三个店铺编号都算"我能经营"。
     于是"这次操作哪一家"在这种账号下没有合理默认值，节点会要求 X-Mk-Shop
     （见 http.js 的 soleOperatedShop）——那不是缺陷，是这个模型的必然推论。 */
  CREATE TABLE IF NOT EXISTS shop_operators (
    shop_code CHAR(9) NOT NULL,
    address   CHAR(42) NOT NULL,
    added_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (shop_code, address),
    CONSTRAINT ck_shop_operators_shop_code_upper CHECK (shop_code = UPPER(shop_code)),
    CONSTRAINT ck_shop_operators_address_lower CHECK (address = LOWER(address)),
    CONSTRAINT fk_operators_shop FOREIGN KEY (shop_code) REFERENCES shops (code) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 店主对外身份声明（EOA 可离线 verifyMessage；合约账户走 1271）。证明"某地址签过这句话"，**不证明**域名/GitHub 归他。 */
  CREATE TABLE IF NOT EXISTS shop_claims (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    shop_code  CHAR(9) NOT NULL,
    kind       ENUM('domain','github','x','telegram') NOT NULL,
    value      VARCHAR(320) NOT NULL,                   -- 规范形（归一与上限的唯一实现在 src/claims.js）
    address    CHAR(42) NOT NULL,
    message    TEXT NOT NULL,                           -- 逐字节原样（核验的唯一输入）
    signature  VARCHAR(200) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    revoked_at DATETIME(3) NULL,                        -- NULL = 有效
    PRIMARY KEY (id),
    UNIQUE KEY uq_claims_identity (kind, value, shop_code),
    KEY idx_claims_active (revoked_at, id),
    CONSTRAINT ck_shop_claims_shop_code_upper CHECK (shop_code = UPPER(shop_code)),
    CONSTRAINT ck_shop_claims_address_lower CHECK (address = LOWER(address)),
    CONSTRAINT fk_claims_shop FOREIGN KEY (shop_code) REFERENCES shops (code) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 通知 webhook 配置：**一行一店**。secret 单独成表，便于只对它收紧读权限与审计。 */
  CREATE TABLE IF NOT EXISTS shop_webhook (
    shop_code CHAR(9) NOT NULL,
    url       VARCHAR(500) NOT NULL DEFAULT '',
    secret    VARCHAR(200) NOT NULL DEFAULT '',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (shop_code),
    CONSTRAINT ck_shop_webhook_shop_code_upper CHECK (shop_code = UPPER(shop_code)),
    CONSTRAINT fk_webhook_shop FOREIGN KEY (shop_code) REFERENCES shops (code) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* ── 节点员工（链下名单，一行一人；见 auth.js 的 isNodeStaffOf）──
     节点级动作（审批开店、停用店铺、看节点级读数）是**这台机器**的运营权限，与平台合约无关，
     所以名单住这里。真正的鉴权判据只有 auth.isNodeAdmin（operator ∪ 本表）；
     节点后台权限不读 Registry。 */
  CREATE TABLE IF NOT EXISTS node_staff (
    address   CHAR(42) NOT NULL,
    added_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (address),
    CONSTRAINT ck_node_staff_address_lower CHECK (address = LOWER(address))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* ── 商品 ── */
  CREATE TABLE IF NOT EXISTS products (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    slug          CHAR(11) NOT NULL,                    -- P + 10 位 Crockford Base32（url 友好，全节点唯一）
    shop_code     CHAR(9) NOT NULL,
    title         VARCHAR(200) NOT NULL,
    description   MEDIUMTEXT NOT NULL,                  -- 由详情块派生（供 SQL LIKE 搜索）
    description_blocks JSON NOT NULL DEFAULT ('[]'),                   -- [{type:'text',text}|{type:'image',url}]，入快照
    media         JSON NOT NULL DEFAULT ('[]'),                        -- 主图区（**数组顺序即展示顺序**），入快照
    kind          ENUM('digital','physical','nft') NOT NULL,
    shipping_fee_usdt_micro BIGINT UNSIGNED NOT NULL DEFAULT 0,
    age_restricted TINYINT(1) NOT NULL DEFAULT 0,
    nft_contract  CHAR(42) NULL,                        -- kind='nft' 必填（小写）
    nft_standard  ENUM('erc721','erc1155') NULL,
    specs         JSON NOT NULL DEFAULT ('[]'),                        -- [{name,options[]}]，入快照
    /*
      attributes 的 pair 是**刻意冗余**：多值索引只能索引"JSON 里已存在的数组元素"，
      而按 (参数名,值) 精确筛选需要把两者拼成一个可索引的键。冗余放在**同一列**里，
      一次写入即原子 —— 这正是旧形状那两张镜像表（product_tags / product_attributes）
      做不到的：它们要求调用方"记得同批写"，漏一处就静默漂移。
    */
    attributes    JSON NOT NULL DEFAULT ('[]'),                        -- [{name,value,pair}]，入快照
    terms         JSON NOT NULL DEFAULT ('{}'),                        -- {handling_days,return_policy,…}，入快照
    tags          JSON NOT NULL DEFAULT ('[]'),                        -- [{key,display}]，**不入快照**（检索维度）
    snapshot_hash CHAR(66) NOT NULL,
    auto_deliver  TINYINT NOT NULL DEFAULT -1,          -- -1 跟随全局 / 0 关 / 1 开
    /*
      **提货声明**（NFT 商品：买家买的是一枚 token，实物/服务由卖家在链下兑付）。
      四个列只对 kind='nft' 有意义，但**不进商品快照**：它们是履约政策，改了不该让
      已成交订单的快照哈希失效。判据与流程见 src/nftClaim.js。
       · claimable = 1 才允许 POST /api/claims；0 = 这枚 token 只是收藏品，没有线下兑付；
       · claim_window_days：自**交付该 token 的订单终局**起算的声明窗口（NULL = 不限期）；
       · claim_instructions 是给持有人的兑付说明（纯文本，≤500 字）。
    */
    claimable     TINYINT(1) NOT NULL DEFAULT 0,
    claim_type    ENUM('physical','digital','service') NOT NULL DEFAULT 'physical',
    claim_window_days INT UNSIGNED NULL,                -- NULL = 不限期；>0 = 自订单终局起 N 天
    claim_instructions VARCHAR(500) NOT NULL DEFAULT '',
    stock_alert_at INT UNSIGNED NULL,                   -- NULL = 不提醒
    -- 池式商品的**已占位未交付**计数：把"检查池量再插单"落成一个可条件更新的计数器
    reserved_codes  INT UNSIGNED NOT NULL DEFAULT 0,
    reserved_tokens INT UNSIGNED NOT NULL DEFAULT 0,
    active        TINYINT(1) NOT NULL DEFAULT 1,        -- 店主侧的可见性：1=在售，0=草稿/已下架
    /*
      **节点侧强制下架**：与 active 正交——店主可以改 active，但改不动这一列。
      两个判据各自回答不同的问题：active 是"店主愿不愿意卖"，node_hidden 是"本节点允不允许卖"。
      公开列表/详情/下单必须同时满足，任一为 0 都不可售；恢复只能由节点管理员操作。
      reason 给店主看（他要知道为什么被下架、该改什么），at 给管理面排序。
    */
    node_hidden   TINYINT(1) NOT NULL DEFAULT 0,
    node_hidden_reason VARCHAR(200) NOT NULL DEFAULT '',
    node_hidden_at DATETIME(3) NULL,
    published_at  DATETIME(3) NULL,                     -- 首次上架时刻（NULL = 从未发布过）
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_products_slug (slug),
    KEY idx_products_shop (shop_code, active),
    KEY idx_products_public (active, node_hidden, id),
    KEY idx_products_tags ((CAST(tags->'$[*].key' AS CHAR(64) ARRAY))),
    KEY idx_products_attrs ((CAST(attributes->'$[*].pair' AS CHAR(128) ARRAY))),
    CONSTRAINT fk_products_shop FOREIGN KEY (shop_code) REFERENCES shops (code),
    CONSTRAINT ck_products_nft CHECK ((kind = 'nft') = (nft_contract IS NOT NULL)),
    CONSTRAINT ck_products_shop_code_upper CHECK (shop_code = UPPER(shop_code)),
    CONSTRAINT ck_products_nft_contract_lower CHECK (nft_contract = LOWER(nft_contract)),
    CONSTRAINT ck_products_node_hidden_bool CHECK (node_hidden IN (0, 1))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  CREATE TABLE IF NOT EXISTS product_skus (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_id    BIGINT UNSIGNED NOT NULL,
    sku_key       VARCHAR(62) NOT NULL,                 -- 按 specs 声明顺序用 '|' 拼接；无规格为 ''
    specs_json    JSON NOT NULL DEFAULT ('{}'),
    price_usdt_micro BIGINT UNSIGNED NOT NULL,
    image_url     VARCHAR(500) NOT NULL DEFAULT '',
    capacity      INT UNSIGNED NULL,                    -- NULL = 不限量
    committed     INT UNSIGNED NOT NULL DEFAULT 0,      -- 已占位件数（占位/释放的权威值）
    active        TINYINT(1) NOT NULL DEFAULT 1,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_skus_product_key (product_id, sku_key),
    CONSTRAINT fk_skus_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
    CONSTRAINT ck_skus_price CHECK (price_usdt_micro <= 9007199254740991),
    -- 防超卖的**唯一权威**在库里，不在调用点（2026-10-16 补）：判据此前只活在
    -- src/stockHold.js 的两条条件 UPDATE 里（committed + ? <= capacity），于是任何第三个写者
    -- ——导入脚本、夹具、运维 SQL、将来新增的交付路径——都能造出 committed > capacity，
    -- 而 committed 正是"还剩几件"的唯一读数（超卖是静默的，只有买家付款后才发现）。
    -- MySQL 8.0.16+ 完全能表达这条不变量，所以它该在库里：让"超卖"不可表达。
    -- 应用侧那两条守卫**保留**：库约束给的是"绝不越界"的保证，条件 UPDATE 给的是
    -- "越界时这一笔失败而不是整条路径炸掉"的可读错误。两者不是二选一。
    CONSTRAINT ck_skus_committed CHECK (capacity IS NULL OR committed <= capacity)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

      /* ── 订单 ──
     拆成三张 1:1，判据是**谁写它**与**它是什么**，不是"读起来顺不顺"：
       orders          订单事实与履约（路由写）
       order_shipping  **个人信息**（买家/卖家写；擦除时整行删除）
       order_chain     链上镜像（watcher 独占写，高频）
     拆 shipping 的理由是**承诺**：擦除从"六列都改对了吗"变成"那一行还在不在"，可以证明。
     拆 chain 的理由是**锁**：watcher 高频回写的那一行，不再与买家/卖家读写的行是同一行。

     ⚠️ **本表的状态列牵着三张配额表，改它的人必须知道**（隐含控制流写在这里，见 TRIGGER_DDL）：
       · status 从 'draft' 变到别的值 ⇒ 该买家的 buyer_draft_quota.active_drafts 减 1、
         该 (买家, 商品) 的 buyer_product_quota.units 减这张单的 quantity；
         **不变量：active_drafts = 该买家 status='draft' 的行数，units = 该 (买家,商品)
         未支付草稿的 quantity 合计。**
       · status 从「draft/escrowed/shipped/disputed」变到集合外 ⇒ 该商品
         products.reserved_codes/reserved_tokens 减去这张单**尚未交付**的件数。
     这三件事由**触发器**做（同一条 UPDATE 的同一个事务），所以这里、应用里的加量处、
     以及触发器旁边各写了一遍：**不要在任何调用点再补一次**（那会减两遍）。
     为什么不在应用里：status 的写者有七八个（/paid、/cancel、清扫器、/sync、watcher、
     链上对账、测试夹具），判据挂调用点就永远漏得掉，而漏掉是静默且永久的。 */
  CREATE TABLE IF NOT EXISTS orders (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_no      CHAR(21) NOT NULL,                    -- B + 10 位时间 + 10 位随机；对外标识
    shop_code     CHAR(9) NOT NULL,
    product_id    BIGINT UNSIGNED NULL,                 -- 商品删除后置 NULL（快照仍在）
    product_slug  CHAR(11) NOT NULL,                    -- 下单时的商品标识（历史事实）
    product_snapshot MEDIUMTEXT NOT NULL,               -- 冻结快照（**字节精确**，哈希的输入）
    snapshot_hash CHAR(66) NOT NULL,
    sku_key       VARCHAR(62) NOT NULL,
    sku_specs     JSON NOT NULL DEFAULT ('{}'),
    buyer         CHAR(42) NOT NULL,
    seller        CHAR(42) NOT NULL,
    quantity      TINYINT UNSIGNED NOT NULL,
    status        ENUM('draft','escrowed','shipped','confirmed','disputed','settled','refunded','expired','cancelled')
                  NOT NULL DEFAULT 'draft',
    -- 金额：建单时冻结。**零费模型**：没有平台费、没有节点抽成，
    -- 结算只有买家/卖家两条腿 ⇒ 本地只记毛额（本列）与链上已退额（order_chain.refunded_amount_wei），
    -- 净额 = amount_wei − refunded_amount_wei（读模型 v_orders.amount_net_wei 现算）。
    amount_wei    DECIMAL(38,0) NOT NULL,               -- 支付资产最小单位（原生 wei 或 ERC20 token 单位）
    payment_token CHAR(42) NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
    payment_symbol VARCHAR(20) NOT NULL DEFAULT 'BTY',
    payment_decimals TINYINT UNSIGNED NOT NULL DEFAULT 18,
    token_usdt_micro_per_token DECIMAL(38,0) NOT NULL DEFAULT 0,
    payment_rate_source ENUM('bty','fixed','oracle') NOT NULL DEFAULT 'bty',
    -- 行情源失败后按 fixed 兜底时必须如实标记；否则订单会声称"这是 oracle 报价"
    payment_rate_stale TINYINT(1) NOT NULL DEFAULT 0,
    payment_rate_quoted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    usdt_micro    BIGINT UNSIGNED NOT NULL,             -- 成交时微 USDT（1 USDT = 1e6）
    shipping_fee_usdt_micro BIGINT UNSIGNED NOT NULL DEFAULT 0,
    bty_usdt_rate DECIMAL(20,10) NOT NULL DEFAULT 0,
    -- 履约
    hold_qty      TINYINT UNSIGNED NOT NULL DEFAULT 0,
    released_at   DATETIME(3) NULL,                     -- 释放幂等标记（非空 = 已释放）
    tracking_no   VARCHAR(100) NULL,
    carrier       VARCHAR(40) NULL,                     -- NULL = 店主没填（三态：没填就是没有这个事实）
    shipped_at    DATETIME(3) NULL,                     -- 已交付事实（含自提/线下交付的空单号形态）
    timeout_blocks INT UNSIGNED NULL,
    age_ack       TINYINT(1) NOT NULL DEFAULT 0,        -- 买家点过确认（**不是**年龄证明）
    /*
      "这单要不要开票"是**订单事实**，不是个人信息，所以它住 orders 而不是 order_shipping。
      为什么必须分开：擦除的判据是"删掉 order_shipping 那一行"，凡住在那一行里的东西都会跟着消失。
      它曾经住在那里，后果是擦除后 CSV 把这单导成"没要求开票"——与事实相反。抬头与税号才是个人信息。
    */
    invoice_needed TINYINT(1) NOT NULL DEFAULT 0,
    -- 草稿 TTL 的**单调锚点**（见 src/monotonicClock.js）：不是墙上时间，所以仍是 BIGINT
    created_boot  CHAR(64) NOT NULL DEFAULT '',
    created_mono  BIGINT NULL,
    -- 个人信息擦除的记账
    pii_erased_at DATETIME(3) NULL,
    pii_cleanup_pending TINYINT(1) NOT NULL DEFAULT 0,  -- 1 = 还欠一次清理（附件文件未删净）
    /*
      证据附件的**订单级**累计字节数（计数器，不是"插行前 SUM 一次"）。
      为什么必须有这一列：dispute_evidence 上的计数器只管**一条陈述**（≤6 件 / ≤20MB），
      而"一个订单所有陈述加起来 ≤20MB"此前是"SUM(size) 之后再插行"——那种判据靠写事务串行化
      才成立（旧的全局写锁），锁一删，两条并发陈述各自读到旧合计就都能通过（每条陈述上限
      6 件×2MB，两条即可越过订单级 20MB），而磁盘是节点最贵的失败面。
      加减**只在 src/evidenceFiles.js（加）与 src/piiErase.js（清零）**：同一条守卫 UPDATE
      里判上限，越界在语句自己身上失败；擦除时与附件行同事务清零（行删了而计数留着 = 一份
      指向不存在文件的账，这单此后再也收不了附件）。
    */
    evidence_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    /*
      ⚠️ **orders.updated_at 刻意没有 ON UPDATE**（2026-10-16，这是全库唯一的例外，
      理由不是"忘了改"）：它**不只是"最后一次改动时刻"，它同时是业务时间的口径**——
      入账窗口（流水页、看板 GMV、趋势日桶都按 updated_at 归桶）、争议陈述窗口的起点、
      对账游标的排序键。自动盖章会让**任何**一次写入都把它前移，而其中有一类写入恰恰承诺不动它：
      **个人信息擦除**。擦除只写 pii_erased_at 与几个计数器（见 src/piiErase.js 文件头），
      若 updated_at 被连带刷新，一笔 400 天前的旧成交额会在擦除那一刻被算进"最近 30 天"
      ——账目凭空变化，且不留痕迹。实测：给这一列加上 ON UPDATE 之后
      pii-erase.test.js 的两条断言（"擦除不得改写 updated_at"、"不得把旧成交额挪进近期窗口"）当场变红。
      MySQL 的 ON UPDATE 是**列级属性**，没法声明"除这次写入之外都自动"，所以这一列继续由
      写者显式盖章——那是它原本的形状，也是 escrowWatcher 与 routes/orders 里那些
      显式 SET updated_at = ? 存在的原因。判据不是"两种风格哪个好看"，而是
      **"自动盖章会不会把一句承诺变成假话"**：这一列会，所以它不要那个属性。
    */
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_orders_no (order_no),
    KEY idx_orders_shop (shop_code, created_at),
    KEY idx_orders_buyer (buyer, created_at),
    KEY idx_orders_product (product_id, status),
    /*
      保留期扫描的候选/排序判据是
        GREATEST(COALESCE(pii_erased_at, updated_at), updated_at) 与 (pii_cleanup_pending = 1)
      ——**两个都是表达式**，普通列索引用不上；idx_orders_pii_cleanup 只在
      「(… OR pii_cleanup_pending = 1)」的一个分支里出现，而另一分支没有索引，优化器无法
      index_merge，只能全表扫描 ⇒ 那个索引从未被用过，已删。代价如实写：「WHERE
      pii_cleanup_pending = 1」这类人工诊断查询会全表扫描（低频读，不值得每次订单写都维护
      一条 B-tree 项）。idx_orders_pii_anchor (pii_erased_at, updated_at) 对表达式排序同样
      帮不上忙（见本次交付说明的残余项：要真正消掉那次 filesort 得改查询或建表达式索引）。
    */
    KEY idx_orders_pii_anchor (pii_erased_at, updated_at),
    /*
      idx_orders_status **保留**（虽然基数低）：它是全库唯一以 status 打头的索引，仲裁列表/
      仲裁计数与按状态 GROUP BY 都是「跨店只看某个状态」——新加的
      (shop_code, status, updated_at) 以 shop_code 打头，服务不了它们；而这类查询命中的
      恰恰是最稀有的那几个状态（disputed 等），ref 访问读的行数很小。删它会让这些查询退化成
      全表扫描。合并方向是「带上 updated_at 消掉仲裁列表的 filesort」（(status, updated_at)），
      但那属于另一次以查询为准的索引调整，不在本次改造里顺手做。
    */
    KEY idx_orders_status (status),
    /* 对账巡检的键集分页是 ORDER BY updated_at, id（见 chainReconcile 的游标）；没有它这条
       查询是 type=ALL + filesort。保留期扫描不接受它（排序键是表达式，理由见上）。 */
    KEY idx_orders_updated (updated_at, id),
    /* 导出/看板/流水：WHERE shop_code = ? AND status IN (…) ORDER BY updated_at [DESC]。
       idx_orders_shop (shop_code, created_at) 服务不了这个排序（列不同 ⇒ filesort）。 */
    KEY idx_orders_shop_status_updated (shop_code, status, updated_at),
    CONSTRAINT fk_orders_shop FOREIGN KEY (shop_code) REFERENCES shops (code),
    CONSTRAINT fk_orders_product FOREIGN KEY (product_id) REFERENCES products (id),
    CONSTRAINT ck_orders_shop_code_upper CHECK (shop_code = UPPER(shop_code)),
    CONSTRAINT ck_orders_buyer_lower CHECK (buyer = LOWER(buyer)),
    CONSTRAINT ck_orders_seller_lower CHECK (seller = LOWER(seller)),
    CONSTRAINT ck_orders_payment_token_lower CHECK (payment_token = LOWER(payment_token)),
    CONSTRAINT ck_orders_payment_decimals CHECK (payment_decimals <= 36),
    CONSTRAINT ck_orders_qty CHECK (quantity BETWEEN 1 AND 99),
    CONSTRAINT ck_orders_money CHECK (usdt_micro <= 9007199254740991 AND shipping_fee_usdt_micro <= 9007199254740991),
    -- 第二道网：计数器被绕过时（直连 SQL / 未来的新写入点）也存不下越界的账
    CONSTRAINT ck_orders_evidence_bytes CHECK (evidence_bytes <= 20971520)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 个人信息（**擦除 = 删掉这一行**）。1:1，随订单级联删除。
     这张表里的东西**全部**是"删掉就应该没有"的：收货三列、买家备注、开票抬头与税号。
     不是个人信息的订单事实（要不要开票、金额、状态）一律住 orders —— 判据只有一个：
     "擦除之后还应不应该读得到"。 */
  CREATE TABLE IF NOT EXISTS order_shipping (
    order_id      BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(60) NOT NULL DEFAULT '',
    phone         VARCHAR(30) NOT NULL DEFAULT '',
    address       VARCHAR(300) NOT NULL DEFAULT '',
    note          VARCHAR(200) NOT NULL DEFAULT '',      -- 买家备注
    invoice_title VARCHAR(100) NOT NULL DEFAULT '',
    /*
      ⚠️ 宽度必须与**校验层**一致（routes/orders.js 收 ≤40 字符）。
      它曾经是 CHAR(20)：21–40 字的税号能过应用校验，然后在插库时被严格模式拒绝，
      对外表现成一个 500「服务内部错误」——**校验通过却存不下**，是这个仓库最不该有的那种错。
      宽度是业务规则的一部分，改校验上限时这一列要同批改。

      ⚠️ 列宽是**结构指纹**的一部分：启动自检对拍 COLUMN_TYPE，老库这一列仍是 20 宽
      （症状与上面那条一样，但只在长税号上出现）就**拒绝启动**并给出 MODIFY COLUMN 的修复语句。
    */
    invoice_tax_no VARCHAR(40) NOT NULL DEFAULT '',
    edit_count    TINYINT UNSIGNED NOT NULL DEFAULT 0,   -- 发货前最多改 1 次
    PRIMARY KEY (order_id),
    CONSTRAINT fk_shipping_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 链上镜像（watcher 独占写）。paid_tx_hash 用 NULL 表达"未支付"之后，
     那条 IF(paid_tx_hash IS NULL OR paid_tx_hash = '', NULL, …) 的函数索引可以删掉：
     普通 UNIQUE 就够（MySQL 的唯一索引允许多个 NULL）。 */
  CREATE TABLE IF NOT EXISTS order_chain (
    order_id      BIGINT UNSIGNED NOT NULL,
    escrow_order_id CHAR(66) NOT NULL,                  -- keccak256 hex，一单一号
    paid_tx_hash  CHAR(66) NULL,                        -- NULL = 未支付
    refund_status ENUM('none','requested','rejected') NOT NULL DEFAULT 'none',
    refund_requested_at DATETIME(3) NULL,
    refund_rejected_at  DATETIME(3) NULL,
    refunded_amount_wei DECIMAL(38,0) NOT NULL DEFAULT 0,
    accepted_partial_refund_wei DECIMAL(38,0) NOT NULL DEFAULT 0, -- 买家链上精确授权过的那个数
    after_sale_status ENUM('none','open','closed') NOT NULL DEFAULT 'none',
    after_sale_opened_at DATETIME(3) NULL,
    after_sale_opened_block BIGINT UNSIGNED NULL,
    after_sale_closed_at DATETIME(3) NULL,
    after_sale_note VARCHAR(500) NULL,                  -- 链上公开文本（前端必须按**纯文本**渲染）
    events        JSON NOT NULL DEFAULT ('[]'),                        -- 事件史（有界，由写入方截断）
    PRIMARY KEY (order_id),
    UNIQUE KEY uq_chain_escrow (escrow_order_id),
    UNIQUE KEY uq_chain_paid (paid_tx_hash),
    KEY idx_chain_after_sale (after_sale_status, after_sale_opened_at),
    KEY idx_chain_refund (refund_status, refund_requested_at),
    CONSTRAINT fk_chain_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /*
    ── NFT 提货声明（**节点链下**；链上只有"提货争议"那一步，见 Escrow.ClaimCase）──

    流程：持有人对"某枚已被卖家在已完成订单里交付过的 token"提交兑付声明（收货信息），
    卖家 approve → shipped → fulfilled，或 rejected；提交人在提交后绑定（A-policy），
    卖家发货前可复核链上持有人，若 token 已转手则取消（新持有人可再声明）。

    为什么 claim_no 与 id 分开：id 是内部主键（子表/日志用），claim_no 是给持有人报的
    对外标识（与订单号同一套 Crockford 格式，不可枚举）。
    dispute_claim_id 是链上 ClaimCase 的键（bytes32）——只有节点主钱包能开案
    （openClaimDispute 是 onlyOwner），节点**不持私钥**，所以这里只是"这次开案用的是哪个 id"
    的记账；watcher 按它把 ClaimDisputeOpened/ClaimClosed 的结论写回这一行。
  */
  CREATE TABLE IF NOT EXISTS nft_claims (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    claim_no      CHAR(21) NOT NULL,                    -- C + 10 位时间 + 10 位随机（与订单号同一套格式）
    shop_code     CHAR(9) NOT NULL,
    product_id    BIGINT UNSIGNED NULL,                 -- 商品删除后置 NULL（slug/快照仍在）
    product_slug  CHAR(11) NOT NULL,
    order_id      BIGINT UNSIGNED NOT NULL,             -- 交付这枚 token 的订单（必须是终局成交态）
    order_no      CHAR(21) NOT NULL,
    seller        CHAR(42) NOT NULL,                    -- 该订单的卖家（提货由他兑付；= orders.seller 快照）
    token_contract CHAR(42) NOT NULL,                   -- NFT 合约（小写）
    token_id      VARCHAR(78) NOT NULL,                 -- 十进制字符串（防 uint256 精度丢失）
    /*
      提交人 = **提交那一刻**的链上持有人（A-policy：声明与提交人绑定，不随后续转手漂移）。
      之后 token 若已转手，卖家可在发货前复核并取消；新持有人可以另提一条声明。
    */
    claimant      CHAR(42) NOT NULL,
    status        ENUM('requested','approved','shipped','fulfilled','rejected','cancelled','expired')
                  NOT NULL DEFAULT 'requested',
    -- 收货信息（个人信息）：声明终局（fulfilled/rejected/cancelled/expired）后随订单擦除清空；
    -- 仍在 requested/approved/shipped 时整单擦除被拒（地址正在用于履约）
    shipping_name    VARCHAR(60) NOT NULL DEFAULT '',
    shipping_phone   VARCHAR(30) NOT NULL DEFAULT '',
    shipping_address VARCHAR(300) NOT NULL DEFAULT '',
    note          VARCHAR(200) NOT NULL DEFAULT '',
    reject_reason VARCHAR(200) NOT NULL DEFAULT '',
    tracking_no   VARCHAR(100) NULL,                    -- 发货单号（NULL = 还没发）
    -- 链上提货争议（节点侧发起，Escrow 裁决）
    claim_amount_wei DECIMAL(38,0) NULL,                -- 争议金额上限（NULL = 未申请）
    dispute_claim_id CHAR(66) NULL,
    dispute_state ENUM('none','opened','closed','cancelled') NOT NULL DEFAULT 'none',
    dispute_opened_at DATETIME(3) NULL,
    dispute_closed_at DATETIME(3) NULL,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_claims_no (claim_no),
    /*
      **一枚 token 同时只能有一条未完结的声明**（A-policy 的另一半）：
      requested/approved/shipped 占位；fulfilled 是"已兑付"的终局，同样占位（同一枚 token
      不能被兑付两次）；rejected/cancelled/expired 让位——token 转手后新持有人要能再声明。
      MySQL 没有部分唯一索引，用函数索引把"已让位"的行折成 NULL。
    */
    UNIQUE KEY uq_claims_active_token
      ((IF(status IN ('requested','approved','shipped','fulfilled'), CONCAT(token_contract, ':', token_id), NULL))),
    KEY idx_claims_shop (shop_code, status, id),
    KEY idx_claims_claimant (claimant, id),
    KEY idx_claims_order (order_id),
    KEY idx_claims_dispute (dispute_claim_id),
    KEY idx_claims_seller (seller, status, id),
    CONSTRAINT fk_nft_claims_shop FOREIGN KEY (shop_code) REFERENCES shops (code) ON DELETE CASCADE,
    CONSTRAINT fk_nft_claims_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL,
    CONSTRAINT fk_nft_claims_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT ck_nft_claims_shop_code_upper CHECK (shop_code = UPPER(shop_code)),
    CONSTRAINT ck_nft_claims_seller_lower CHECK (seller = LOWER(seller)),
    CONSTRAINT ck_nft_claims_token_contract_lower CHECK (token_contract = LOWER(token_contract)),
    CONSTRAINT ck_nft_claims_claimant_lower CHECK (claimant = LOWER(claimant)),
    CONSTRAINT ck_nft_claims_amount CHECK (claim_amount_wei IS NULL OR claim_amount_wei > 0)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

/*
  买家在本节点的屏蔽（**不是浏览器本地名单**）：拉黑的对象只在本节点生效；
  同一买家在别的节点要重新设置。节点目录/店铺列表按登录买家过滤，订单历史不隐藏。
  · target_type='shop'：target_value = 本节点店铺编号（shop_code 同步存一份便于 JOIN）
  · target_type='seller'：target_value = 链上收款地址
  · 不存 origin/owner：一台节点多店，拉黑节点主会连带无关店铺，已有产品取舍明确不做。
*/
CREATE TABLE IF NOT EXISTS buyer_blocks (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    buyer         CHAR(42) NOT NULL,
    target_type   ENUM('shop','seller') NOT NULL,
    target_value  VARCHAR(42) NOT NULL,
    shop_code     CHAR(9) NULL,
    reason        VARCHAR(200) NOT NULL DEFAULT '',
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_buyer_block (buyer, target_type, target_value),
    KEY idx_buyer_blocks_buyer (buyer, id),
    KEY idx_buyer_blocks_shop (shop_code),
    CONSTRAINT fk_buyer_blocks_shop FOREIGN KEY (shop_code) REFERENCES shops (code) ON DELETE CASCADE,
    CONSTRAINT ck_buyer_blocks_buyer_lower CHECK (buyer = LOWER(buyer)),
    CONSTRAINT ck_buyer_blocks_shop_code_upper CHECK (shop_code = UPPER(shop_code)),
    CONSTRAINT ck_buyer_blocks_target CHECK (
      (target_type = 'shop' AND shop_code IS NOT NULL AND target_value = shop_code)
      OR (target_type = 'seller' AND shop_code IS NULL AND target_value = LOWER(target_value))
    )
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS product_codes (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_id    BIGINT UNSIGNED NOT NULL,
    code          VARCHAR(200) NOT NULL,                -- 兑换码原文（库级 as_cs：只差大小写的两个码是两个）
    status        ENUM('unused','used') NOT NULL DEFAULT 'unused',
    order_id      BIGINT UNSIGNED NULL,                 -- 分配到的订单（NULL = 未分配）
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    used_at       DATETIME(3) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_codes_product_code (product_id, code),
    KEY idx_codes_status (product_id, status),
    CONSTRAINT fk_codes_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
    CONSTRAINT fk_codes_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS product_nft_tokens (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_id    BIGINT UNSIGNED NOT NULL,
    token_id      VARCHAR(78) NOT NULL,                 -- 十进制字符串（防精度丢失；uint256 最长 78 位）
    status        ENUM('unused','used') NOT NULL DEFAULT 'unused',
    order_id      BIGINT UNSIGNED NULL,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    used_at       DATETIME(3) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_nft_tokens_product_token (product_id, token_id),
    KEY idx_nft_tokens_status (product_id, status),
    CONSTRAINT fk_nft_tokens_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
    CONSTRAINT fk_nft_tokens_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 交付物（一个订单可交付多行：数字多码 / NFT 多枚）
   *
   * ⚠️ **"同一单同一类交付值只能出现一次"没有长在这张表上，而在 order_delivery_claims 里**。
   * 为什么不能直接加 UNIQUE (order_id, kind, value)：value 对**池内资源**（码/ tokenId）才是标识，
   * 对"池外自由文本"只是说明。手动交付允许"每行一件"，同一句说明写两行（例如同一份下载链接
   * 交付两件）是合法写入；把唯一键直接压在这张表上会让那种输入在**校验通过之后**被库拒掉
   * （也就是本仓最不该有的"通过了却存不下"）。所以约束只压在"值确实是池内资源"的那些行上：
   * 由 order_delivery_claims + 触发器在**同一条语句**里维护（见 TRIGGER_DDL 的 ③'）。
   */
  CREATE TABLE IF NOT EXISTS order_delivery_items (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id      BIGINT UNSIGNED NOT NULL,
    kind          ENUM('code','nft') NOT NULL,
    value         VARCHAR(200) NOT NULL,                -- 码原文 / NFT tokenId（十进制字符串）
    tx_hash       CHAR(66) NULL,                        -- NFT 转账凭证（code 行为 NULL）
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_delivery_items_order (order_id, created_at),
    -- NFT 交付凭证**全局一次性**：同一笔转账里的同一个 tokenId 只能被认领一次。
    -- code 行 tx_hash 为 NULL，而唯一索引不约束 NULL ⇒ 与旧的部分索引（kind='nft'）等价。
    UNIQUE KEY uq_delivery_nft_tx_value (tx_hash, value),
    CONSTRAINT fk_delivery_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 池内资源的**交付认领账**（"一码一次"的库侧判据，唯一键在下面）。
   *
   * 为什么不是给 order_delivery_items 直接加唯一键：见那张表的注释（自由文本不是标识）。
   * 这里只收"值确实是本商品池里的一行"的交付行——码行对 product_codes、NFT 行对
   * product_nft_tokens。唯一键因此表达的是"同一个订单不可能把同一个池内资源交付两次"，
   * 而自由文本重复多少行都不受约束。
   *
   * 为什么可以是一张**派生表**而不是第二份真相：它只有触发器一个写入口（插入交付行时收、
   * 删除交付行时退），与 order_delivery_items 在同一条语句/同一个事务里移动；而触发器本身
   * 又由启动时的结构指纹保证存在且语句一致（见 inspectSchemaStructure）。手工 INSERT 一行
   * 交付行想绕过它是不可能的——唯一键在它身上。 */
  CREATE TABLE IF NOT EXISTS order_delivery_claims (
    order_id   BIGINT UNSIGNED NOT NULL,
    kind       ENUM('code','nft') NOT NULL,
    value      VARCHAR(200) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (order_id, kind, value),
    CONSTRAINT fk_delivery_claim_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 退货单（已交付订单退款前的线下追回协调；纯本地数据面） */
  CREATE TABLE IF NOT EXISTS order_returns (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id      BIGINT UNSIGNED NOT NULL,
    status        ENUM('open','shipped','received') NOT NULL DEFAULT 'open',
    waived        TINYINT(1) NOT NULL DEFAULT 0,        -- 卖家放弃追索（确认释放额度）
    address       VARCHAR(300) NOT NULL DEFAULT '',
    note          VARCHAR(1000) NOT NULL DEFAULT '',
    tracking_no   VARCHAR(100) NULL,
    carrier       VARCHAR(40) NULL,                     -- 归一在 src/shipping.js（同一条路不留半条）
    received_at   DATETIME(3) NULL,                     -- 卖家确认收到（占位释放凭据）
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_returns_order (order_id),
    CONSTRAINT fk_returns_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 告警去重：**一行一次已投递的告警**。
     旧形状是 kv 里的一堆 mk:xxx:orderId = '1' 键 + 一个进程内 Set，
     于是"只告警一次"要靠 read-then-write 加锁。主键唯一之后，去重就是一条 INSERT 的成败。 */
  CREATE TABLE IF NOT EXISTS order_alerts (
    order_id   BIGINT UNSIGNED NOT NULL,
    kind       ENUM('pool_empty','chain_missing','hold_missing') NOT NULL,
    sent_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (order_id, kind),
    CONSTRAINT fk_alerts_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 售后证据（退款理由 / 卖家回复 / 仲裁陈述 / 售后陈述） */
  CREATE TABLE IF NOT EXISTS dispute_evidence (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id      BIGINT UNSIGNED NOT NULL,
    role          ENUM('buyer','seller') NOT NULL,
    phase         ENUM('refund_request','refund_reply','arbitration','after_sale') NOT NULL,
    content       VARCHAR(2000) NOT NULL,
    -- 附件配额计数器：把"检查配额再插入"落成可条件更新的列（见 routes/evidenceFiles.js）
    file_count    TINYINT UNSIGNED NOT NULL DEFAULT 0,
    file_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_evidence_order (order_id, created_at),
    CONSTRAINT fk_evidence_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT ck_evidence_quota CHECK (file_count <= 6 AND file_bytes <= 20971520)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 证据附件（白名单 png/jpeg/webp/pdf；单文件 ≤2MB；磁盘名 uuid 隔离，sha256 存证） */
  CREATE TABLE IF NOT EXISTS evidence_files (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    evidence_id  BIGINT UNSIGNED NOT NULL,
    order_id     BIGINT UNSIGNED NOT NULL,
    filename     VARCHAR(120) NOT NULL,                 -- 原始文件名（清洗后，仅展示）
    stored_name  VARCHAR(64) NOT NULL,                  -- uuid.安全扩展名（磁盘名，与原始名隔离）
    mime         VARCHAR(64) NOT NULL,
    size         INT UNSIGNED NOT NULL,
    sha256       CHAR(64) NOT NULL,
    created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_evidence_files_ev (evidence_id),
    KEY idx_evidence_files_order (order_id),
    CONSTRAINT fk_evidence_files_evidence FOREIGN KEY (evidence_id) REFERENCES dispute_evidence (id) ON DELETE CASCADE,
    CONSTRAINT fk_evidence_files_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 买家评价（一单一评 + 店主单次回复） */
  CREATE TABLE IF NOT EXISTS reviews (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id      BIGINT UNSIGNED NOT NULL,
    product_id    BIGINT UNSIGNED NOT NULL,             -- 冗余商品维度（商品下架后评价仍可展示）
    buyer         CHAR(42) NOT NULL,
    rating        TINYINT UNSIGNED NOT NULL,
    content       VARCHAR(1000) NOT NULL DEFAULT '',
    /* 评价图（最多 3 张；节点相对 URL /api/uploads/<uuid>.<ext>）。 */
    images        JSON NOT NULL DEFAULT ('[]'),
    /* 追评（一次；可带图）。followup_at IS NULL = 还没追评。 */
    followup_content VARCHAR(1000) NOT NULL DEFAULT '',
    followup_images  JSON NOT NULL DEFAULT ('[]'),
    followup_at     DATETIME(3) NULL,
    reply_content VARCHAR(1000) NOT NULL DEFAULT '',
    reply_at      DATETIME(3) NULL,
    created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_reviews_order (order_id),
    KEY idx_reviews_product (product_id, created_at),
    CONSTRAINT fk_reviews_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT ck_reviews_buyer_lower CHECK (buyer = LOWER(buyer)),
    CONSTRAINT ck_reviews_rating CHECK (rating BETWEEN 1 AND 5)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /* 管理审计 + 哈希链。
     每行带 prev_hash（上一行的 entry_hash，链首为 NULL）与 entry_hash；
     **前驱唯一**使分叉在落库这一步不可表达（旧形状靠事后校验发现断裂）。

     shop_code 是这一行的**店铺维度**（一节点 N 家店，审计是最后该跨店的东西）：
       · 可空是必须的，不是省事：节点级事件（节点资料、开店审批、保留期触发、系统动作）
         本来就不属于任何一家店。填 '' 会把"节点级"与"某家店"折成同一个值——
         本表已经栽过一次同类折叠（见下面 head_slot 的注释：未哈希的历史行与链首折进同一槽位，
         于是此后再也写不进任何审计行）。三态照旧：NULL = 不属于任何店。
       · 外键（同 products/orders 的 shop_code，R6）：编号抄错/店不存在在落库那一步就失败，
         而不是写出一行谁都看不见的审计（那种行只有"永久无主"这一种结局）。
         刻意不加 ON DELETE CASCADE：审计行是证据，不能因为删了店铺就跟着消失。
       · 链**不分店**：head_slot 只由 prev_hash 决定（见下），校验器 verifyAuditChain 全表一遍。
         分店建链会让"某家店的行被搬到另一家店"从证据里消失，且跨店删/插在每条分链上都看不见；
         只有**列表**按 shop_code 过滤（SQL 在 src/audit.js 的 queryAudit，那里的注释写了代价）。

     ⚠️ **本表是 append-only，判据在 TRIGGER_DDL 的 ⑩⑪**（读这段的人必须知道）：唯一允许的
     UPDATE 是 logAudit 的 entry_hash 回填（NULL → 非 NULL，其余列不变），DELETE 一律拒绝。
     为什么在库里：哈希链校验器只能事后发现断裂，而"任何持库凭据的人一条 UPDATE 就能改掉
     一行"根本不经过应用——判据挂表上之后，改 action/detail/at、二次回填、删行都在语句自己
     身上失败。代价：① 库侧的隐含控制流（与 orders 的配额触发器同款，调用点看不见）；
     ② 触发器管不到 DDL：TRUNCATE/DROP 要收权限，校验器与盘外链头是那一层的兜底。 */
  CREATE TABLE IF NOT EXISTS audit_logs (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    actor       CHAR(42) NOT NULL,
    actor_role  ENUM('host','owner','staff') NOT NULL,
    action      VARCHAR(64) NOT NULL,
    target_type VARCHAR(32) NOT NULL,
    target_id   VARCHAR(120) NOT NULL,
    shop_code   CHAR(9) NULL,                           -- NULL = 节点级（不属于任何一家店）
    detail      JSON NOT NULL DEFAULT ('{}'),                          -- 变更摘要（**不含码原文/完整收货地址**）
    ip          VARCHAR(64) NOT NULL DEFAULT '',
    prev_hash   CHAR(64) NULL,                          -- NULL = 链首（或早于哈希链的历史行）
    entry_hash  CHAR(64) NULL,                          -- NULL = 未哈希（三态之一）
    /*
      链首槽位：把"没有前驱"折成一个**常量**再建唯一索引。

      为什么不能只对 prev_hash 建唯一索引（实测踩到）：MySQL 的唯一索引**不约束 NULL**，
      而链首的 prev_hash 就是 NULL ⇒ 12 个并发写入者可以同时插入 12 行"链首"，
      即 12 条互不相接的链——**分叉保护恰恰在最该生效的地方（第一条）失效**。

      ⚠️ 但**只折 prev_hash 又会折过头**（实测踩到，比上一条更隐蔽）：prev_hash IS NULL
      有两种完全不同的行——「链首」（还没接上前驱）与「未哈希的历史行」（早于哈希链，
      entry_hash IS NULL）。把两者都折成 '' 之后，只要库里存在**一条**历史行，
      它就永久占住唯一槽位 ⇒ **此后再也写不进任何审计行**；而 logAudit 重试几次后
      只打一行 console.error 就吞掉（审计是非关键路径，没人会注意到）。
      所以槽位必须把"未哈希"排除掉：entry_hash IS NULL ⇒ 槽位 NULL ⇒ 不参与唯一约束
      （历史行因此可以有任意多条），而真正的链首仍然至多一行。
    */
    head_slot   CHAR(64) AS (IF(entry_hash IS NULL, NULL, IFNULL(prev_hash, ''))) STORED,
    PRIMARY KEY (id),
    UNIQUE KEY uq_audit_head (head_slot),
    -- 审计列表按 (shop_code, id 倒序) 分页：索引带 id 让每个店的行本身有序，不必再排序
    KEY idx_audit_shop (shop_code, id),
    KEY idx_audit_at (at),
    CONSTRAINT ck_audit_logs_actor_lower CHECK (actor = LOWER(actor)),
    CONSTRAINT ck_audit_logs_shop_code_upper CHECK (shop_code = UPPER(shop_code)),
    CONSTRAINT fk_audit_shop FOREIGN KEY (shop_code) REFERENCES shops (code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /*
    登录 nonce（一次挑战一次消费）。主键只有地址 —— **登录是节点级的**。

    为什么不含店铺编号：一个人登录**这家节点**之后，就应当能访问他在本节点内有权的全部信息
    （自己的订单、自己经营的那家或那几家店），而不是"每进一家店再登录一次"。
    把店铺编号放进主键会把登录降级成"某家店的会话"，于是同一个人在同一节点里
    被迫对每家店各签一次名 —— 那是把**授权范围**错当成了**身份**。

    "这个地址能对哪家店做什么"由 shops.seller 与 shop_operators 回答，
    那是**授权**问题，在每次操作时按目标店铺判定；它不该被烧进会话的形状里。
    （早先这里有过 shop_code + 外键，代价是账号级登录在库里无处存放，于是 /nonce 被迫要求 shop。）
  */
  CREATE TABLE IF NOT EXISTS siwe (
    address    CHAR(42) NOT NULL,
    message    TEXT NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    PRIMARY KEY (address),
    KEY idx_siwe_expires (expires_at),
    CONSTRAINT ck_siwe_address_lower CHECK (address = LOWER(address))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /*
    ── 免费草稿配额（把"先读计数再插入"落成可条件更新的计数器）──
    旧形状是事务内 SELECT COUNT(*)（再靠一把全局写锁串行化，那把锁已经删了）。
    计数器 + 带守卫的 UPDATE 是 MySQL 的做法：越界在**那条 UPDATE 自己**上就失败了，
    不需要谁来串行化——实测 40 并发恰好 10 张通过、20 件×20 并发恰好 4 张（80 件）。
    代价如实写：计数器是新增状态，必须与它描述的那组订单**同批移动**，漏一处就是永久漂移
    （本仓最怕的那类静默错账）。所以两个方向各只有一个实现：
      · 加量在 src/draftQuota.js（守卫 UPDATE，命中 1 行才算占到位）；
      · 减量在 TRIGGER_DDL（订单离开 draft 时减，见 orders 的建表注释）。
    */
  CREATE TABLE IF NOT EXISTS buyer_draft_quota (
    buyer         CHAR(42) NOT NULL,
    active_drafts SMALLINT UNSIGNED NOT NULL DEFAULT 0,   -- = 该买家 status='draft' 的行数（触发器维护）
    PRIMARY KEY (buyer),
    CONSTRAINT ck_buyer_draft_quota_buyer_lower CHECK (buyer = LOWER(buyer))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  CREATE TABLE IF NOT EXISTS buyer_product_quota (
    buyer      CHAR(42) NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    units      SMALLINT UNSIGNED NOT NULL DEFAULT 0,      -- = 该 (买家,商品) 未支付草稿的 quantity 合计
    PRIMARY KEY (buyer, product_id),
    CONSTRAINT ck_buyer_product_quota_buyer_lower CHECK (buyer = LOWER(buyer)),
    CONSTRAINT fk_bpq_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /*
    店主**代客下单**的草稿配额（与买家自己的草稿配额分开记账）。

    为什么必须分开：「POST /orders」允许店主替任意买家建草稿（代客单），而旧实现把额度记在
    「buyer」上——店主可以拿十张代客草稿把某个买家的额度占满，让那位买家自己再也下不了单。
    额度属于**发起人与买家的这一对**：代客单记在 (店主, 买家) 名下，自购单记在买家名下。

    「proxy_drafts」是"这一行是代客单"的唯一标记（触发器据此决定减哪一本账）；
    它随订单级联删除。不要把"buyer != seller"当成判据：一个店主完全可以在别家店买东西，
    那时 buyer != seller，但那是自购、只能减买家自己的额度。
  */
  CREATE TABLE IF NOT EXISTS proxy_drafts (
    order_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (order_id)
    /*
      刻意**不加** 「ON DELETE CASCADE」：删除订单时，减哪一本额度账必须靠这一行判断；
      而级联删除发生在 「AFTER DELETE」 触发器之前——marker 若被级联先删掉，触发器就只能
      去减买家那本账（代客单从没加过它），买家的额度会被凭空扣掉。marker 由删除触发器在
      四本账都处理完之后显式删除（见 TRIGGER_DDL 的删除触发器）。
    */
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  CREATE TABLE IF NOT EXISTS seller_proxy_draft_quota (
    seller        CHAR(42) NOT NULL,
    buyer         CHAR(42) NOT NULL,
    active_drafts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (seller, buyer),
    CONSTRAINT ck_seller_proxy_draft_quota_seller_lower CHECK (seller = LOWER(seller)),
    CONSTRAINT ck_seller_proxy_draft_quota_buyer_lower CHECK (buyer = LOWER(buyer))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  CREATE TABLE IF NOT EXISTS seller_proxy_product_quota (
    seller     CHAR(42) NOT NULL,
    buyer      CHAR(42) NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    units      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (seller, buyer, product_id),
    CONSTRAINT ck_seller_proxy_product_quota_seller_lower CHECK (seller = LOWER(seller)),
    CONSTRAINT ck_seller_proxy_product_quota_buyer_lower CHECK (buyer = LOWER(buyer)),
    CONSTRAINT fk_sppq_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

  /*
    ── 订单聚合的**读模型** ──

    orders 拆成三张表之后，"把一张订单读全"是一次三表 JOIN。**读**统一走它，
    **写**一律直接命中具体那张表（视图带 JOIN，在 MySQL 里本来就不可更新——
    写错表会在 SQL 层当场报错，而不是悄悄写进一张不该写的表）。

    两个刻意的列名选择：
      · 内部主键在这里叫 order_id（不叫 id）。旧的读法 row.id 会拿到**数字**，
        而对外标识是 order_no；把内部键叫 id 会让"拿内部键当对外单号"这种错误
        静默发生。叫 order_id 之后，row.id 直接是 undefined —— 响亮地失败。
      · shipping_* / escrow_order_id / after_sale_* 等名字保持领域里的叫法：
        它们描述的东西没变，只是搬到了该在的表里。
  */
  CREATE OR REPLACE VIEW v_orders AS
  SELECT
    o.id AS order_id, o.order_no, o.shop_code, o.product_id, o.product_slug,
    o.product_snapshot, o.snapshot_hash, o.sku_key, o.sku_specs,
    o.buyer, o.seller, o.quantity, o.status,
    o.amount_wei, o.payment_token, o.payment_symbol, o.payment_decimals, o.token_usdt_micro_per_token,
    o.payment_rate_source, o.payment_rate_stale, o.payment_rate_quoted_at,
    o.usdt_micro, o.shipping_fee_usdt_micro, o.bty_usdt_rate,
    /*
      **净额 = amount_wei − refunded_amount_wei**（零费模型：没有平台费、没有节点抽成，
      结算只有退款 + 卖家两条腿）。退款额住在 order_chain（链上镜像表，LEFT JOIN 可能为 NULL），
      所以用 COALESCE 兜成 0：**"这单没有链上镜像"时净额就是毛额**（一分钱都还没退过），
      这与链上"未退款托管单"的语义一致，不是把"读不到"当 0。
    */
    o.amount_wei - COALESCE(c.refunded_amount_wei, 0) AS amount_net_wei,
    o.hold_qty, o.released_at, o.tracking_no, o.carrier, o.shipped_at,
    o.timeout_blocks, o.age_ack, o.created_boot, o.created_mono,
    o.pii_erased_at, o.pii_cleanup_pending, o.created_at, o.updated_at,
    s.name            AS shipping_name,
    s.phone           AS shipping_phone,
    s.address         AS shipping_address,
    s.note,
    o.invoice_needed, s.invoice_title, s.invoice_tax_no,
    s.edit_count      AS shipping_edit_count,
    c.escrow_order_id, c.paid_tx_hash,
    c.refund_status, c.refund_requested_at, c.refund_rejected_at,
    c.refunded_amount_wei, c.accepted_partial_refund_wei,
    c.after_sale_status, c.after_sale_opened_at, c.after_sale_opened_block,
    c.after_sale_closed_at, c.after_sale_note, c.events AS onchain_events
  FROM orders o
  LEFT JOIN order_shipping s ON s.order_id = o.id
  LEFT JOIN order_chain    c ON c.order_id = o.id;

`;

/**
 * 配额计数器的**库侧半边**：`orders` / `order_delivery_items` 一变，对应的计数器就在
 * **同一条语句、同一个事务**里跟着动。
 *
 * 分工（哪一半在应用、哪一半在这里）：
 *   · 免费草稿两道闸（`buyer_draft_quota` / `buyer_product_quota`）：**加量在应用**
 *     （src/draftQuota.js 的守卫 UPDATE，那就是闸本身），**减量在这里**（①②）。
 *   · 池式商品占位（`products.reserved_codes` / `reserved_tokens`）：**下单时的加量在应用**
 *     （src/poolQuota.js 的守卫 UPDATE，那就是闸本身）；**恢复时的加量在这里**（⑤）；
 *     两处减量都在这里（③交付一件减一件、④离开在途集合减剩余需求）。
 *     恢复之所以不留给应用：它是 `cancelled → escrowed` 的**后果**而不是一个决定，
 *     三条恢复路径（watcher / `/sync` / 链上对账）调用时机还不一样，应用层拿不到
 *     与顺序无关的"只做一次"凭据；那条状态迁移本身就是凭据（见⑤的注释）。
 *   · 证据附件配额（`dispute_evidence.file_count/file_bytes`、`orders.evidence_bytes`）：
 *     加减都只在 src/evidenceFiles.js 与 src/piiErase.js（写者只有这两个，不需要触发器）。
 *
 * ## 为什么"减量"不留在应用（这是刻意的，不是漏改）
 *
 * **加量（闸）为什么在应用**：业务拒绝必须是应用读得懂的**可读结果**——守卫 UPDATE 命中 0 行
 * ⇒ 回一句"草稿过多"给买家。做成触发器就只能 `SIGNAL` 成一个 SQL 错误，应用还得把错误码
 * 翻译回业务语义，那等于把限额这层策略搬进 schema 的错误码里。
 *
 * **减量为什么在库里**：`orders.status` 与 `order_delivery_items` 的写者有七八个——
 * `/paid`、`/cancel`、草稿清扫器、`/sync`、watcher 的四个分支（→escrowed / →disputed /
 * →confirmed / →expired）、`settleByRefundSplit`、链上对账，以及测试夹具里直改 status 的 SQL。
 * 判据挂在**调用点**上时，每个写者都得自己记得减一次，而**新增一个写者就多一个漏点**；
 * 漏掉的后果是静默且永久的：买家付过 10 笔款之后 `active_drafts` 停在 10，他**再也建不出草稿**，
 * 日志里一个字都没有。触发器挂在表上，任何写者都绕不过去，而且与那条状态迁移**同一个事务**——
 * "计数器与它的真相同批移动"由形状保证，不靠谁记得。
 * 顺带一个别人给不了的好处：夹具/运维 SQL 直改 status 的那些行也会自动结清，
 * 于是"测试世界"与"生产世界"的计数器口径不会分家（否则绿灯不算数）。
 *
 * ## 代价（读这段的人必须知道的）
 *
 * 这是**库侧的隐含控制流**：读 `UPDATE orders SET status = …` 的人在调用点看不见有计数器在动。
 * 所以同一件事在三处显式写着——`orders` 的建表注释、下面每个触发器旁边、应用里的加量处
 * （都带一句"减量在库侧，不要在这里补一次"）。另外：夹具/直连 SQL 造出来、从未加过量的行
 * 会被这里的减量按 0 兜底（`GREATEST`），方向是安全侧，但那些行上的计数不等于真值。
 *
 * ## 语句形式
 *
 * 配额触发器绝大多数是**单语句体**：读的人一眼能看全，也便于从启动失败时的修复清单里
 * 原样复制。唯一的复合体是"整单删除"那一支（四本额度账 + 删除代客 marker 必须按序完成；
 * 拆成多个同事件触发器时，第一个删掉 marker 之后后面的就只能误减买家账）。
 * 审计守卫必须表达"不满足条件就拒绝"，那在 MySQL 里只有 `IF … THEN SIGNAL`
 * 一条路（复合体）。实测（8.0.46）：复合体与其它 DDL 一起用 `multipleStatements` 下发
 * **不会**被拆散——服务器按完整语法解析 `BEGIN … END`，内部分号属于复合体的语句列表。
 * `DROP … IF EXISTS` + `CREATE` 是幂等的：MySQL 的 `CREATE TRIGGER` 没有 IF NOT EXISTS。
 * 触发器的写**不影响外层语句的 `affectedRows`**（实测：`changes === 1` 的守卫语义原样保持）。
 *
 * ## 审计表是 append-only（`audit_logs` 的两条守卫）
 *
 * 审计行由 `src/audit.js` **先 INSERT（`entry_hash` 为 NULL）再回填哈希**（同事务）——
 * 那一行因此必然经历一次 UPDATE。除这次回填之外，UPDATE 与 DELETE 一律拒绝：
 * 哈希链校验器只能**事后**发现断裂，而"持库凭据的人直接改一行"根本不经过应用；
 * 把判据挂在表上之后，改 `action`/`detail`/`at`、二次回填、删行都在语句自己身上失败。
 * 代价如实写：① 这是库侧的隐含控制流（与配额触发器同款），`audit_logs` 的建表注释里
 * 写明；② 触发器的射程到 DML 为止——`TRUNCATE`/`DROP` 是 DDL，触发不了（那要收权限，
 * 不是触发器能表达的），校验器与盘外链头仍然是那一层的兜底。
 *
 * ⚠️ **减量必须写成 `GREATEST(0, CAST(列 AS SIGNED) - CAST(n AS SIGNED))`，两边的 CAST 一个都不能省**
 * （2026-10-16 实测踩了两次）：这些计数器都是 `UNSIGNED` 列，而 MySQL 的算术规则是
 * **只要有一个操作数是 UNSIGNED，结果就是 UNSIGNED** —— 于是"减到负数"这一步在进入 `GREATEST`
 * 之前就抛 `BIGINT UNSIGNED value is out of range`，整条业务语句（取消订单 / 记录交付 /
 * 状态迁移）跟着一起失败。`GREATEST` 只夹得住**结果**，夹不住**中间值**；
 * 只 CAST 被减数也不够（`CAST(x AS SIGNED) - 无符号列` 仍然是 UNSIGNED）。
 * 什么时候会减到 0 以下：计数器已经被结清过的那一行——测试夹具与运维/直连 SQL 造出来的订单
 * 从未加过量，却同样会走到这里的减量（所以"从没加过量"必须被当作**可能**，而不是不可能）。
 */
const TRIGGER_DDL = [
  // ①② 订单离开 draft ⇒ 两道免费草稿闸各还一份额度（不变量见 orders 的建表注释）
  `DROP TRIGGER IF EXISTS trg_orders_draft_quota_release`,
  `CREATE TRIGGER trg_orders_draft_quota_release AFTER UPDATE ON orders FOR EACH ROW
     UPDATE buyer_draft_quota SET active_drafts = GREATEST(0, CAST(active_drafts AS SIGNED) - 1)
      WHERE buyer = OLD.buyer AND OLD.status = 'draft' AND NEW.status <> 'draft'
        AND NOT EXISTS (SELECT 1 FROM proxy_drafts p WHERE p.order_id = OLD.id)`,
  /*
    代客草稿的额度记在 **(店主, 买家)** 名下，不能减到买家自己的账上：否则十张代客草稿就能把
    某个买家的额度占满（见 proxy_drafts 的说明）。两组触发器各自只在自己的账本上动作。
  */
  `DROP TRIGGER IF EXISTS trg_orders_proxy_draft_quota_release`,
  `CREATE TRIGGER trg_orders_proxy_draft_quota_release AFTER UPDATE ON orders FOR EACH ROW
     UPDATE seller_proxy_draft_quota SET active_drafts = GREATEST(0, CAST(active_drafts AS SIGNED) - 1)
      WHERE seller = OLD.seller AND buyer = OLD.buyer AND OLD.status = 'draft' AND NEW.status <> 'draft'
        AND EXISTS (SELECT 1 FROM proxy_drafts p WHERE p.order_id = OLD.id)`,
  `DROP TRIGGER IF EXISTS trg_orders_product_quota_release`,
  `CREATE TRIGGER trg_orders_product_quota_release AFTER UPDATE ON orders FOR EACH ROW
     UPDATE buyer_product_quota
        SET units = GREATEST(0, CAST(units AS SIGNED) - CAST(OLD.quantity AS SIGNED))
      WHERE buyer = OLD.buyer AND product_id = OLD.product_id
        AND OLD.status = 'draft' AND NEW.status <> 'draft'
        AND NOT EXISTS (SELECT 1 FROM proxy_drafts p WHERE p.order_id = OLD.id)`,
  `DROP TRIGGER IF EXISTS trg_orders_proxy_product_quota_release`,
  `CREATE TRIGGER trg_orders_proxy_product_quota_release AFTER UPDATE ON orders FOR EACH ROW
     UPDATE seller_proxy_product_quota
        SET units = GREATEST(0, CAST(units AS SIGNED) - CAST(OLD.quantity AS SIGNED))
      WHERE seller = OLD.seller AND buyer = OLD.buyer AND product_id = OLD.product_id
        AND OLD.status = 'draft' AND NEW.status <> 'draft'
        AND EXISTS (SELECT 1 FROM proxy_drafts p WHERE p.order_id = OLD.id)`,
  /*
    ③ 交付一件 ⇒ 该商品池的占位减 1（这一件不再需要从池里留着了）。
    「交付行」是**所有**交付路径的唯一共同事实（池自动分配 / 手动填码 / 自由文本 / NFT 登记），
    所以挂在这里等于把三条（以后可能更多）交付路径一次覆盖。`product_id` 已置 NULL 时子查询
    给出 NULL ⇒ `p.id = NULL` 不匹配任何行 ⇒ 静默无操作（商品删了，池也随级联没了）。
  */
  `DROP TRIGGER IF EXISTS trg_delivery_pool_release`,
  `CREATE TRIGGER trg_delivery_pool_release AFTER INSERT ON order_delivery_items FOR EACH ROW
     UPDATE products p
        SET p.reserved_codes = GREATEST(0, CAST(p.reserved_codes AS SIGNED) - IF(NEW.kind = 'code', 1, 0)),
            p.reserved_tokens = GREATEST(0, CAST(p.reserved_tokens AS SIGNED) - IF(NEW.kind = 'nft', 1, 0))
      WHERE p.id = (SELECT o.product_id FROM orders o WHERE o.id = NEW.order_id)`,
  /*
    ③' 交付一件**池内资源** ⇒ 记进认领账（唯一键在 order_delivery_claims 上）。
    "一码一次"此前只靠两个调用点的条件 UPDATE（`product_codes.status='unused'` 的守卫），
    而交付行本身没有唯一键：`(tx_hash, value)` 对 code 行无效（tx_hash 为 NULL，唯一索引不约束
    NULL），于是同一个码/ tokenId 在同一单上出现两行只有调用点自觉才会被挡住。
    为什么约束收在"池内资源"而不是所有交付行：自由文本（说明型交付）的 value 不是标识，
    同一句说明写两行是合法交付；直接给 order_delivery_items 加唯一键会让那种输入在**校验通过
    之后**被库拒掉（见那张表的注释）。判据"这个值是不是本商品池里的一行"在这里一次说完。
  */
  `DROP TRIGGER IF EXISTS trg_delivery_pool_claim`,
  `CREATE TRIGGER trg_delivery_pool_claim AFTER INSERT ON order_delivery_items FOR EACH ROW
     INSERT INTO order_delivery_claims (order_id, kind, value)
     SELECT NEW.order_id, NEW.kind, NEW.value FROM orders o
      WHERE o.id = NEW.order_id
        AND ((NEW.kind = 'code' AND EXISTS (SELECT 1 FROM product_codes pc
                                             WHERE pc.product_id = o.product_id AND pc.code = NEW.value))
          OR (NEW.kind = 'nft' AND EXISTS (SELECT 1 FROM product_nft_tokens pt
                                            WHERE pt.product_id = o.product_id AND pt.token_id = NEW.value)))`,
  /*
    ④ 订单离开「draft/escrowed/shipped/disputed」⇒ 池占位减去**尚未交付**的件数。
    为什么是"剩余"而不是 quantity：交付时已经按件减过了（②），这里只结清剩下没人再会去取的那部分。
    两半相加恰好等于下单时加的量（quantity），于是"占位 = 在途订单尚未交付的需求"这条不变量
    与旧的派生口径（SUM(quantity − 已交付行数)）逐字等价。disputed 仍在集合内：争议中仍可能交付。
  */
  `DROP TRIGGER IF EXISTS trg_orders_pool_codes_release`,
  `CREATE TRIGGER trg_orders_pool_codes_release AFTER UPDATE ON orders FOR EACH ROW
     UPDATE products p
        SET p.reserved_codes = GREATEST(0, CAST(p.reserved_codes AS SIGNED) - GREATEST(
              CAST(OLD.quantity AS SIGNED) - (
                SELECT COUNT(*) FROM order_delivery_items d
                 WHERE d.order_id = OLD.id AND d.kind = 'code'), 0))
      WHERE p.id = OLD.product_id AND p.kind = 'digital'
        AND OLD.status IN ('draft','escrowed','shipped','disputed')
        AND NEW.status NOT IN ('draft','escrowed','shipped','disputed')`,
  `DROP TRIGGER IF EXISTS trg_orders_pool_tokens_release`,
  `CREATE TRIGGER trg_orders_pool_tokens_release AFTER UPDATE ON orders FOR EACH ROW
     UPDATE products p
        SET p.reserved_tokens = GREATEST(0, CAST(p.reserved_tokens AS SIGNED) - GREATEST(
              CAST(OLD.quantity AS SIGNED) - (
                SELECT COUNT(*) FROM order_delivery_items d
                 WHERE d.order_id = OLD.id AND d.kind = 'nft'), 0))
      WHERE p.id = OLD.product_id AND p.kind = 'nft'
        AND OLD.status IN ('draft','escrowed','shipped','disputed')
        AND NEW.status NOT IN ('draft','escrowed','shipped','disputed')`,
  /*
    ⑤ 订单从「已结清」回到在途（cancelled → escrowed：买家在草稿被清扫/取消之后才完成支付；
    cancelled → disputed：支付晚到后先进入争议，watcher / `/sync` / 链上对账都会恢复）⇒ 把池占位**占回来**。
    为什么这一处也在触发器里、而不是 `stockHold.restockOrder`：它能拿到的"只做一次"凭据
    （`orders.released_at`）是**限量占位**那一套的标记，池式订单的 hold_qty 恒 0、那一列根本不参与；
    而三条恢复路径的调用时机还不一样（watcher/`/sync` 在状态迁移**之前**调、对账在**之后**调），
    应用层拿不到一个与顺序无关的认领。触发器不认时机：`→ escrowed/disputed` 这条迁移本身
    就是凭据（每条迁移只发生一次），所以"恢复时把占位占回来"恰好执行一次。
    没有守卫（不像下单那样可能被拒）：钱已经在链上了，订单必须恢复；池不够时由既有的
    池空告警（`order.pool_empty`）暴露给店主——方向安全（占位偏多 ⇒ 少卖，而不是超卖）。
  */
  `DROP TRIGGER IF EXISTS trg_orders_pool_codes_restore`,
  `CREATE TRIGGER trg_orders_pool_codes_restore AFTER UPDATE ON orders FOR EACH ROW
     UPDATE products p
        SET p.reserved_codes = p.reserved_codes + GREATEST(CAST(OLD.quantity AS SIGNED) - (
              SELECT COUNT(*) FROM order_delivery_items d
               WHERE d.order_id = OLD.id AND d.kind = 'code'), 0)
      WHERE p.id = OLD.product_id AND p.kind = 'digital'
        AND OLD.status NOT IN ('draft','escrowed','shipped','disputed')
        AND NEW.status IN ('escrowed','disputed')`,
  `DROP TRIGGER IF EXISTS trg_orders_pool_tokens_restore`,
  `CREATE TRIGGER trg_orders_pool_tokens_restore AFTER UPDATE ON orders FOR EACH ROW
     UPDATE products p
        SET p.reserved_tokens = p.reserved_tokens + GREATEST(CAST(OLD.quantity AS SIGNED) - (
              SELECT COUNT(*) FROM order_delivery_items d
               WHERE d.order_id = OLD.id AND d.kind = 'nft'), 0)
      WHERE p.id = OLD.product_id AND p.kind = 'nft'
        AND OLD.status NOT IN ('draft','escrowed','shipped','disputed')
        AND NEW.status IN ('escrowed','disputed')`,
  /*
    ── ⑥⑦⑧ **删除**这一侧（2026-10-16 补，此前一条都没有）────────────────────────
    上面六条全是 `AFTER UPDATE` / `AFTER INSERT`，于是 `DELETE` 是一条**静默的口径分叉**：
    行没了、配额没还。三条真实入口都会踩到：

      · 订单被删（`order_delivery_items` 随外键级联删）⇒ 交付行那条减量触发器不触发
        ⇒ `products.reserved_codes` 只增不减，「占位 = 在途订单尚未交付的需求」这条不变量
        被破坏，而**症状是店主发现池子永远是满的**（新单被判超卖），库里却查不出任何原因
        ——正与小节 ④ 自己警告的"没有减量半边"同形；
      · `draft` 订单被删（草稿清扫、测试夹具、运维清理）⇒ 两条免费草稿闸（①②）不触发
        ⇒ `buyer_draft_quota` / `buyer_product_quota` 永久占着额度，买家**再也下不了单**；
      · 在途订单被删 ⇒ 池占位不减（同第一条）。

    判据的形状与 UPDATE 那六条**逐字同源**（同一列、同一夹逼、同一 `GREATEST(... - COUNT(...))`），
    只是 `NEW` 换成"没有新行"：删除意味着"这一行不再需要任何占位"。写成"另一套算法"
    才是真正的危险 —— 两份口径迟早分叉，而分叉的症状是**账目慢慢偏掉**，不是报错。

    ⚠️ **交付行被删时不把池占位"占回来"**：那要求"删交付行"总是意味着"这件回到未交付"，
    而当前的删除路径只有订单级联（整单一起没了 ⇒ 该走 ⑧ 的整单结清）与测试夹具。多一条
    "往回加"的路径就多一个 `GREATEST` 夹不住中间值的地方（见本节开头的 UNSIGNED 说明），
    而它服务的场景不存在。真出现"单独撤一件交付"的需求时，正确做法是在**应用层**用一个明确的
    动作表达，并同批补触发器 + 用例，而不是在这里预留。
    唯一的 `AFTER DELETE ON order_delivery_items` 是下面那条：它只**退回认领账**
    （order_delivery_claims），不碰任何计数器，所以没有 `GREATEST`/UNSIGNED 的问题；不退回的话，
    直连 SQL 删掉一行交付行再重新交付同一个池内资源会被认领账挡住——账与交付行就此分家。
  */
  `DROP TRIGGER IF EXISTS trg_orders_delete_quota_release`,
  `DROP TRIGGER IF EXISTS trg_orders_delete_proxy_quota_release`,
  `DROP TRIGGER IF EXISTS trg_orders_delete_product_quota_release`,
  `DROP TRIGGER IF EXISTS trg_orders_delete_proxy_product_quota_release`,
  /*
    整单删除：**一个复合体**处理四本账，然后才删代客标记。
    为什么必须是一个触发器：删除订单时"这一行是不是代客单"只能靠 proxy_drafts 回答；
    如果把四本账拆成多个 AFTER DELETE 触发器，第一个把标记删掉之后，后面的触发器就只能
    误减买家那本账（代客单从没加过它）。复合体里四本账都处理完，最后一行才删标记。
    为什么 proxy_drafts 没有 ON DELETE CASCADE：级联在 AFTER DELETE 触发器之前发生，
    marker 会先消失——这正是上面那个"误减买家账"的形状。
  */
  `CREATE TRIGGER trg_orders_delete_quota_release AFTER DELETE ON orders FOR EACH ROW
   BEGIN
     UPDATE buyer_draft_quota SET active_drafts = GREATEST(0, CAST(active_drafts AS SIGNED) - 1)
      WHERE buyer = OLD.buyer AND OLD.status = 'draft'
        AND NOT EXISTS (SELECT 1 FROM proxy_drafts p WHERE p.order_id = OLD.id);
     UPDATE seller_proxy_draft_quota SET active_drafts = GREATEST(0, CAST(active_drafts AS SIGNED) - 1)
      WHERE seller = OLD.seller AND buyer = OLD.buyer AND OLD.status = 'draft'
        AND EXISTS (SELECT 1 FROM proxy_drafts p WHERE p.order_id = OLD.id);
     UPDATE buyer_product_quota
        SET units = GREATEST(0, CAST(units AS SIGNED) - CAST(OLD.quantity AS SIGNED))
      WHERE buyer = OLD.buyer AND product_id = OLD.product_id
        AND OLD.status = 'draft'
        AND NOT EXISTS (SELECT 1 FROM proxy_drafts p WHERE p.order_id = OLD.id);
     UPDATE seller_proxy_product_quota
        SET units = GREATEST(0, CAST(units AS SIGNED) - CAST(OLD.quantity AS SIGNED))
      WHERE seller = OLD.seller AND buyer = OLD.buyer AND product_id = OLD.product_id
        AND OLD.status = 'draft'
        AND EXISTS (SELECT 1 FROM proxy_drafts p WHERE p.order_id = OLD.id);
     DELETE FROM proxy_drafts WHERE order_id = OLD.id;
   END`,
  /*
    ⑧ 整单删除 ⇒ 池占位结清「尚未交付」的件数（与 ④ 同一算式、同一个"剩余"口径）。
    用 `OLD.status` 而不是"无条件减"：已终结的单在 ④ 那一刻就已经结清过，
    再减一次就是**减两遍**（那是把账目拉向另一边，同样查不出来）。在途四态之外的状态
    一律不动作 —— 与 ④ 的 `NEW.status NOT IN (...)` 是同一集合的另一侧。
  */
  `DROP TRIGGER IF EXISTS trg_orders_delete_pool_release`,
  `CREATE TRIGGER trg_orders_delete_pool_release AFTER DELETE ON orders FOR EACH ROW
     UPDATE products p
        SET p.reserved_codes = GREATEST(0, CAST(p.reserved_codes AS SIGNED) - GREATEST(
              CAST(OLD.quantity AS SIGNED) - (
                SELECT COUNT(*) FROM order_delivery_items d
                 WHERE d.order_id = OLD.id AND d.kind = 'code'), 0)),
            p.reserved_tokens = GREATEST(0, CAST(p.reserved_tokens AS SIGNED) - GREATEST(
              CAST(OLD.quantity AS SIGNED) - (
                SELECT COUNT(*) FROM order_delivery_items d
                 WHERE d.order_id = OLD.id AND d.kind = 'nft'), 0))
      WHERE p.id = OLD.product_id AND OLD.status IN ('draft','escrowed','shipped','disputed')`,
  /*
    ⑨ 交付行被删 ⇒ 退回它的认领（只动 order_delivery_claims，不动任何计数器，理由见 ⑥⑦⑧ 的末段）。
    订单级联删除**不会经过这里**（MySQL 的级联动作不触发触发器），但认领账自己也有
    ON DELETE CASCADE，所以两条路径的结果一致。
  */
  `DROP TRIGGER IF EXISTS trg_delivery_pool_claim_release`,
  `CREATE TRIGGER trg_delivery_pool_claim_release AFTER DELETE ON order_delivery_items FOR EACH ROW
     DELETE FROM order_delivery_claims
      WHERE order_id = OLD.order_id AND kind = OLD.kind AND value = OLD.value`,
  /*
    ── ⑩⑪ 审计表 append-only（见本节开头"审计表是 append-only"）────────────────────
    ⑩ 唯一允许的那次 UPDATE 是 logAudit 的**哈希回填**：旧值 entry_hash 为 NULL、新值非 NULL，
       且其余每一个可写列都与 OLD 逐字相等（用 `<=>` 做 NULL 安全比较——`shop_code` 本来就可空，
       普通 `=` 会让"两边都是 NULL"判成不相等）。生成列 head_slot 不参与比较：它的值由
       entry_hash/prev_hash 派生，回填时本来就会变。
    ⑪ 删除一律拒绝：审计行是证据，删掉之后链上只剩一个接不上的 prev_hash。
       触发器射程到 DML 为止：TRUNCATE/DROP 是 DDL（见本节开头代价②）。
  */
  `DROP TRIGGER IF EXISTS trg_audit_logs_hash_backfill_only`,
  `CREATE TRIGGER trg_audit_logs_hash_backfill_only BEFORE UPDATE ON audit_logs FOR EACH ROW
BEGIN
  IF NOT (OLD.entry_hash IS NULL AND NEW.entry_hash IS NOT NULL)
     OR NOT (OLD.id <=> NEW.id)
     OR NOT (OLD.at <=> NEW.at)
     OR NOT (OLD.actor <=> NEW.actor)
     OR NOT (OLD.actor_role <=> NEW.actor_role)
     OR NOT (OLD.action <=> NEW.action)
     OR NOT (OLD.target_type <=> NEW.target_type)
     OR NOT (OLD.target_id <=> NEW.target_id)
     OR NOT (OLD.shop_code <=> NEW.shop_code)
     OR NOT (OLD.detail <=> NEW.detail)
     OR NOT (OLD.ip <=> NEW.ip)
     OR NOT (OLD.prev_hash <=> NEW.prev_hash)
  THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs 只允许把 entry_hash 从 NULL 回填一次，其它列一律不得改';
  END IF;
END`,
  `DROP TRIGGER IF EXISTS trg_audit_logs_no_delete`,
  `CREATE TRIGGER trg_audit_logs_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs 是证据，不可删除';
END`,
];

/**
 * 节点自身那一行（**单行表**，`CHECK (id = 1)` 保证存在且只有一行）。
 *
 * `owner` 是**配置的镜像**（`MK_SHOP_OWNER`），每次启动刷新：配置是节点身份的唯一真相
 * （节点 operator 是链上 Registry 的登记主体，不是网页能改的），库里这一份的用处是让
 * "这台机器是谁的"有一个可审计的落点。
 *
 * 其余几列（合约地址锚、两个轮询游标、隔离事件）**只种不覆盖**：
 * 它们记的是运行状态，拿配置去覆盖等于每次重启都把进度清零。
 */
async function ensureNodeRow() {
  const owner = String(config.shop.owner || '').trim().toLowerCase();
  if (!owner) {
    /*
      没有节点主就没有这家节点的身份：店铺、鉴权、订单全都挂在它下面。
      这里**不猜、也不填占位地址**——占位地址会让"已配置"看起来成立，
      而后面每一处 hostOnly 判定都会静默地判给一个不存在的身份。与 MK_TOKEN_SECRET 同款 fail-fast。
    */
    console.error('[db] MK_SHOP_OWNER 未配置：节点主是这家节点的身份锚（店铺、鉴权、订单都挂在它下面）。');
    console.error('[db] 请在 node/.env 填 MK_SHOP_OWNER=<店主钱包地址> 后重新启动。');
    process.exit(1);
  }
  /*
    形状也要在启动期拦：`0x123` / 零地址这类值能通过"非空"，却会让 nodeOwnerOf 判非法后返回空，
    于是节点以"无主"状态运行（所有 nodeAdmin/hostOnly 恒 403、开店申请无人受理、/nonce 可能 500），
    而运维看到的启动日志一切正常。与"缺库列/弱密钥/合约锚不符"同一道 fail-fast。
  */
  if (!/^0x[0-9a-f]{40}$/.test(owner) || /^0x0{40}$/.test(owner)) {
    console.error(`[db] MK_SHOP_OWNER 形状非法：${JSON.stringify(config.shop.owner)}（需为 0x 开头的 40 位十六进制地址，且不能是零地址）。`);
    console.error('[db] 请修正 node/.env 的 MK_SHOP_OWNER 后重新启动。');
    process.exit(1);
  }
  await getDb().run(
    `INSERT INTO node (id, owner) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE owner = VALUES(owner)`,
    owner
  );
}

/* 时间：库里 DATETIME(3)，代码里 `Date`。写库直接把 Date 当参数传即可——
   不要传毫秒整数（MySQL 会把它当数字字面量去解析，写进一个荒谬的时间，且不报错）。 */

/* ─────────────────────────── 结构化状态的去向 ─────────────────────────── */

/*
  kv 表已随重设计删除（它是 EAV：店员名单/webhook/游标/告警标记全塞在两列字符串里）。
  替代物是各自有类型的表：node（单例）、shop_operators、shop_webhook、order_alerts。
  这里**刻意不提供**通用的键值读写——留着它就等于留了一条"再往字符串里塞结构化数据"的路。
*/

export default { initDb, getDb, withTransaction, abortTx };
