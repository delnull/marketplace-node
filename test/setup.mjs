/**
 * 测试装配（node --test 每个测试文件独立进程、并行执行，env 互不干扰）。
 *
 * ## 库名必须在**本模块求值的第一行**指认
 *
 * SQLite 时期每个进程开自己的 `:memory:`，天然互不可见；换成 MySQL 之后所有进程默认连的是
 * 同一个 `marketplace_node`——并行跑的上百个测试文件会互相删对方的行、还抢同一把全局写锁，
 * 表现是随机失败（最难查的那一类），更糟的是这批流量会打到真库上。
 * 所以每个进程领一个自己的库名，落点只能在**模块求值的最前面**：`node --test` 按 import 的
 * 书写顺序求值依赖，测试文件把 `./setup.mjs` 写在任何 `../src/…` 之前，这个名字才一定先于
 * 业务模块生效。该顺序不靠"大家记得"，判据是 test/db-isolation.test.js（它会红）。
 * `config.db.name` 是 getter（见 src/config.js），所以这里设过之后谁在什么时候读都是这个名字。
 *
 * ⚠️ 库名**不能只用 pid**：MySQL 是**共享服务器**，几台机器/容器（CI 的每个 job、本机与远端回归台）
 * 常常连的是同一台，而 pid 各自从 1 开始编号——两台机器上同一个 pid 会领到同一个库名。
 * 后果不是"随机失败"那么轻：先结束的那个进程会把库**删掉**，另一个进程正在用的库当场消失，
 * 报出来的是 `Unknown database 'mk_test_6112'` 后面跟着一串 401 与 500（真因被埋在中间）。
 * 所以名字里再混 4 字节随机：pid 负责"同机上互不相同"，随机段负责"跨机/跨容器也不撞"。
 *
 * ## 收尾：清库 + 让进程退得出去
 *
 *  · **清库**：不清就留下上百个测试库（每次运行一批）。库名带随机段，撞不上下一轮，
 *    但残留会一直堆在服务器上（占空间、干扰"这库是谁的"判断），所以照删。
 *  · **退出**：`initDb()` 持有两条**永不主动断开**的连接（读连接池 + 实例锁，见 src/db.js），
 *    socket 挂在事件循环上 ⇒ 用例全部跑完、报告也打完了，进程照样不退。
 *    实测此时 `beforeExit` 与 `exit` 都不触发，所以收尾只能放在 `after()` 钩子里
 *    （那是唯一"用例已跑完、进程还活着"的时刻）。不靠 `--test-force-exit`：那要改
 *    package.json 的 test 脚本，而库仍然没人清。
 *  · 删库**尽力而为**：失败只告警，绝不让清理的结果决定测试结论。
 *
 * 注意：业务模块必须动态 import——config/db 等在模块顶层读取 process.env，
 * 需确保 env 在模块首次求值前已设置。汇率外部网络被禁用（mock fetch 抛错），
 * 统一走 config 兜底汇率（stale=true），保证测试不依赖公网。
 *
 * 另外装一个**交付闸的默认链上桩**（见下方 setChainOrderFetcher）：交付类端点现在按链上真值放行，
 * 而单测的 RPC 是拒连的——没有这个桩，所有发货用例都会以"读不到链上状态"被正确地拒绝。
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { after } from 'node:test';
import mysql from 'mysql2/promise';
import { Wallet } from 'ethers';
import request from 'supertest';

/**
 * 本进程**自己起的**库名（外部已指定 MK_DB_NAME 时它是别人的库，不归本进程清）。
 * 只算一次放在这里，下面紧接着把它写进 env——**这是本模块的第一处副作用**。
 */
const OWN_DB_NAME = `mk_test_${process.pid}_${randomBytes(4).toString('hex')}`;
process.env.MK_DB_NAME = process.env.MK_DB_NAME || OWN_DB_NAME;
const ownsDbName = process.env.MK_DB_NAME === OWN_DB_NAME;

/** 本进程的库与连接参数：建库前填上（没建过库就没有可清的）；见 dropTestDatabase */
let testDb = null;
let dropState = 'idle'; // idle → running → done | failed

/**
 * 当前测试的**店铺句柄**（卖家面请求的 `X-Mk-Shop` 取值）= 下面那张店铺行的**编号**。
 *
 * 为什么用可变对象而不是让每个用例自己拼：卖家面接口现在**必须**指明"哪一家店"
 * （多店之下没有合理默认值，缺失即 400）。句柄只有一种拼写——店铺编号
 * （2026-10-16 起："用店主地址指代"那条路随"自营店"这个特例一起删掉了：
 * 开节点与开店铺是两个独立动作，一行店铺只在链上登记之后才存在，而编号由链上铸造）。
 * 用例只写 `.set('X-Mk-Shop', shopRef.value)`，不必各自去问 makeCtx 要。
 */
export const shopRef = { value: '' };

/**
 * 测试用的店铺编号（9 位 Crockford Base32 形状，与 shared/shopCode.js 的校验一致）。
 *
 * **导出是刻意的**：句柄与店铺行必须指同一个编号——用例若自己另编一个编号写进 `shops.code`，
 * 而 `shopRef.value` 还停在旧值上，卖家面请求就会一路 404（"这家店不存在"），
 * 而现象看起来像鉴权坏了。要用别的编号的用例请**同时**改 `shopRef.value`。
 */
export const TEST_SHOP_CODE = '0000TEST1';

export async function makeCtx() {
  const owner = Wallet.createRandom();
  const buyer = Wallet.createRandom();
  process.env.MK_SHOP_OWNER = owner.address;
  shopRef.value = TEST_SHOP_CODE;
  // 虚拟托管地址：仅用于"已接入链上托管"分支（paid 的链上校验不在单测覆盖）
  process.env.MK_ESCROW_ADDRESS = '0x2222222222222222222222222222222222222222';
  process.env.MK_FALLBACK_BTY_USDT = '0.1'; // 1 BTY = 0.1 USDT（唯一的行情腿：USDT→BTY）
  process.env.MK_TOKEN_SECRET = 'unit-test-secret-0123456789abcdef';
  /*
    汇率 TTL 设 0 = **每次请求都刷新**（`config.js` 用 `intEnvAllowZero` 解析，0 是有效值）。
    本套件其实不依赖它：下面把 `globalThis.fetch` 禁掉之后汇率一律走 config 兜底值（stale=true），
    刷新一次和刷一百次拿到的是同一个数字。留着 0 是为了让"禁用外部网络"这件事在语义上彻底
    ——没有任何一条用例可能因为缓存命中的旧值而侥幸通过。要验缓存/降级行为请见
    test/rates.test.js（那里自己装可控的假上游）。
  */
  process.env.MK_BTY_TTL_MS = '0';

  // 禁用外部网络：汇率走兜底（stale=true）
  globalThis.fetch = async () => {
    throw new Error('unit-test: 外部网络已禁用');
  };
  /*
    ⚠️ 上面这句**管不到链上读取路径**：ethers v6 在 Node 下用 node:http/node:https 发 JSON-RPC，
    不经过 globalThis.fetch（源码：ethers/src.ts/utils/fetch.ts "In NodeJS, the default uses the
    http and https libraries"）。而 MK_RPC_URL 缺省指向 BTY 主网 ⇒ 测试里任何链上调用
    （paid/sync 的 getOrder、getArbiterAddress、账本的全局兜底口径）都会真的打一次公网。
    这里指向一个必然"连接被拒"的本地端口：链上路径快速失败，与真实 RPC 不可达时同形
    （各处都已 try/catch 降级），测试不再触网也不再被外网抖动拖慢。
    需要"链上可用"的用例请自建本地假 JSON-RPC 服务器并改写 config.chain.rpcUrl——
    见 test/order-sync-paths.test.js 与 test/fees-per-order.test.js。
  */
  process.env.MK_RPC_URL = 'http://127.0.0.1:1/';

  const { initDb, getDb } = await import('../src/db.js');
  const { default: config } = await import('../src/config.js');
  /*
    记在 initDb **之前**：它会 auto-create 建库，而后面几步（必备列门禁、实例锁被占）都会
    process.exit(1)——库那时已经建出来了，收尾的 exit 兜底必须知道该删哪个（见 dropTestDatabase）。
  */
  if (ownsDbName) {
    testDb = { name: config.db.name, host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password };
  }
  await initDb();
  /*
    **店铺行必须由测试自己造**：节点不再在启动时替节点主开一家"自营店"。
    这是模型的一部分而不是测试的麻烦——开节点与开店铺是两个独立动作，一行店铺只在
    "链上已经有了这家店"之后才存在（落库走 routes/shops.js 的 verify-onchain）。
    seller = 节点主，抽成 0（节点主自己开的店，收款人恒为节点地址 = 他自己）。

    ⚠️ 新 schema 下 `shops` 没有 host 列（一库一节点，节点主在 node.owner）、
    `pending_*` 的"没有待决提案"是 **NULL**（不是 0/空串）、时间由服务器盖章所以不传。
    `code` 是 CHAR(9) 且有外键引用它（products/orders/siwe/...）——
    这个 fixture 造出来的这一行，就是全测试套件里**唯一合法的店铺归属**。
  */
  await getDb().run(
    `INSERT INTO shops (code, seller, name, notice, listed, commission_bps)
     VALUES (?, ?, '', '', 1, 0)
     ON DUPLICATE KEY UPDATE seller = seller`,
    TEST_SHOP_CODE, owner.address.toLowerCase()
  );
  /*
    交付闸的默认链上桩（2026-10-14）：`/ship`、`/seller/batch-ship`、`/:id/nft-deliveries` 与自动交付
    现在一律经 `chainOrder.deliveryGate` 读**链上真值**（status=Created 且 refundRequested=false；
    读不到即拒绝）。单测默认的 MK_RPC_URL 指向一个必然拒连的本地端口，所以这里装一个
    "链上确实有这一单、仍在托管、未被申请退款"的读数桩：按 escrow_order_id 回读本地行并原样回显
    buyer/seller/amount —— 这正是 chainParamsMatch 期待的"链上就是这一单"的正常形态。
    需要"链上冻结 / 已终局 / 读不到 / 诱饵单"这些档的用例自己调 setChainOrderFetcher 覆盖
    （见 test/delivery-gate.test.js 与 test/auto-deliver.test.js，传 null 恢复本桩）。
  */
  const { setChainOrderFetcher } = await import('../src/chainOrder.js');
  setChainOrderFetcher(async (orderIdHex) => {
    /*
      读**聚合读模型** `v_orders` 而不是 `orders`：链上单号住在 1:1 子表 order_chain 里，
      `orders` 表已经没有这一列（见 src/db.js 的三表拆分）。
    */
    const row = await getDb().get(
      `SELECT buyer, seller, amount_wei, commission_quoted_to, commission_quoted_bps, timeout_blocks
         FROM v_orders WHERE escrow_order_id = ?`,
      String(orderIdHex || '').toLowerCase()
    );
    if (!row) throw new Error('unit-test 链上桩：链上没有这一单');
    return {
      status: 'Created',
      refundRequested: false,
      refundRejected: false,
      refundedAmount: '0',
      buyer: row.buyer,
      seller: row.seller,
      amount: row.amount_wei,
      /*
        交付闸会核对**报价条款**（抽成收款人/比例、验货窗口）。默认桩回"链上与本地报价一致"的
        读数；要验"买家签了另一份条款"的用例自己覆盖 `commissionTerms` / `timeoutBlocks`。
      */
      timeoutBlocks: Number(row.timeout_blocks),
      commissionTerms: {
        commissionTo: String(row.commission_quoted_to ?? '').toLowerCase(),
        commissionBps: Number(row.commission_quoted_bps) || 0,
      },
    };
  });
  /*
    店铺员工的链上治理身份判据：单测 RPC 拒连，而 `PUT /staff` / `roleOf` 现在要求
    `isProtocolGovernance` 可读（读不到 = 拒绝）。默认桩回答 false（测试里的地址都不是治理 owner），
    需要验证角色互斥的用例自己 `setProtocolGovernanceReader` 覆盖。
  */
  const { setProtocolGovernanceReader, setForceClosedReader } = await import('../src/chain.js');
  setProtocolGovernanceReader(async () => false);
  /*
    强制关闭状态（`Registry.isForceClosed`）：单测 RPC 拒连 ⇒ 默认桩回答"没人被强制关闭"。
    这条判据在被 forceClose 的员工鉴权、`isNodeAdmin`、`PUT /staff` 三处都是 fail-closed，
    没有这个默认桩，普通员工用例会全部掉成 user（看起来像鉴权坏了）。需要验证拒绝路径的
    用例自己 `setForceClosedReader` 覆盖。
  */
  setForceClosedReader(async () => false);
  const { createApp } = await import('../src/app.js');
  return { app: createApp(), db: getDb(), owner, buyer, request };
}

/**
 * 一条**不属于连接池**的临时连接，用来删本进程的库。
 *
 * 为什么不复用池子：删库之后池子里那几条连接指向的库就没了（后续语句全报 Unknown database），
 * 而池子归 src/db.js 管、本模块只拿得到一个门面，没有"关池"的接口。临时连接用完即断，
 * 与池子互不干扰。
 *
 * `lock_wait_timeout` 压到 5 秒：库里若还留着一条没关的事务（那本身是用例失败），
 * DROP 会去等它的元数据锁——清理绝不能把测试进程拖到超时。
 */
async function dropWithThrowawayConnection({ name, host, port, user, password }) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`库名不是安全标识符，拒绝拼接：${name}`);
  const conn = await mysql.createConnection({ host, port, user, password, connectTimeout: 5000 });
  try {
    await conn.query('SET SESSION lock_wait_timeout = 5');
    await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  } finally {
    await conn.end().catch(() => {});
  }
}

/**
 * 删掉本进程建的库（尽力而为；失败只告警）。幂等：exit 兜底与 after 钩子都会调它。
 */
async function dropTestDatabase() {
  if (dropState !== 'idle' || !testDb) return;
  dropState = 'running';
  try {
    await dropWithThrowawayConnection(testDb);
    dropState = 'done';
  } catch (e) {
    dropState = 'failed';
    console.warn(`[setup] 测试库 ${testDb.name} 清理失败（不影响测试结论）：${e?.message || e}`);
  }
}

/*
  唯一的收尾点（见文件头"收尾"）：先清库，再让进程真的退出去。
  不给 process.exit 传 0——传 `process.exitCode`，让"有用例失败"这件事如实变成退出码；
  实测 node:test 自己也会在收尾时按结果覆盖它，所以更不会被这里抹平。
*/
after(async () => {
  await dropTestDatabase();
  process.exit(process.exitCode ?? 0);
});

/*
  `exit` 兜底：正常路径（上面的 after 钩子）已经把库删掉了，能走到这里只有一种情况——
  进程在 initDb **之后**自己 exit（src/db.js 的两条 fail-fast：必备列缺失、实例锁被别的进程占着），
  此时 after 钩子根本没机会跑，而库已经 auto-create 出来了。

  `exit` 里不能 await，所以交给一个**同步等待**的子进程去删（spawnSync 不需要事件循环）。
  子进程 cwd 设在 node/：那里才有 node_modules，`import('mysql2/promise')` 才解析得到。
  这一步失败一律静默——进程正在退出，告警也未必有人看，而它本来就是兜底。
*/
process.on('exit', () => {
  if (dropState !== 'idle' || !testDb) return;
  dropState = 'running';
  const { name, host, port, user, password } = testDb;
  if (!/^[A-Za-z0-9_]+$/.test(name)) return;
  const snippet = `import('mysql2/promise').then(async (m) => {
    const c = await m.createConnection(${JSON.stringify({ host, port, user, password })});
    await c.query(${JSON.stringify(`DROP DATABASE IF EXISTS \`${name}\``)});
    await c.end();
  }).catch(() => {});`;
  try {
    spawnSync(process.execPath, ['-e', snippet], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
      timeout: 10_000,
    });
  } catch {
    /* 进程正在退出，忽略 */
  }
});

/** SIWE 登录流程，返回 `{ token, address, isHost, shops }`（`shops` = 这个地址能经营的店与**各自**角色） */
export async function login(ctx, wallet) {
  /*
    **登录是节点级的**：一次登录就应当能访问本节点内有权的全部信息，
    而不是"每进一家店再登录一次"。所以这里**不带**店铺编号 ——
    `siwe` 的主键只有地址（见 db.js），令牌也不绑店铺。
    "这个地址能对哪家店做什么"是**授权**问题，由 shops.seller / shop_operators
    在每次操作时按目标店铺判定，与登录无关。

    历史（别改回去）：这里一度必须带 `shop`，因为 `siwe` 的主键曾是 (address, shop_code)
    且 shop_code 有外键指向 shops(code) —— 那是把"授权范围"烧进了"身份"的形状里，
    后果是账号级槽位在库里无处存放。漏传的症状是 400、`nonce.body.data` 为 null ⇒
    解构抛 TypeError，表现成"每个用 login() 的用例都炸"。
  */
  const nonce = await ctx.request(ctx.app)
    .get(`/api/auth/nonce?address=${wallet.address}`)
    .expect(200);
  const { message } = nonce.body.data;
  const signature = await wallet.signMessage(message);
  const res = await ctx.request(ctx.app)
    .post('/api/auth/login')
    .send({ address: wallet.address, message, signature })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 断言统一响应 {code:0} */
export function assertOk(res) {
  if (res.body.code !== 0) {
    throw new Error(`期望 code=0，实际 code=${res.body.code} message=${res.body.message}`);
  }
}

/**
 * 商品入参样例（88 USDT = 88000000 微 USDT）。
 *
 * 接口形状是「specs + skus」：价格与库存**逐组合**给出。
 * 为了不让每个用例都写一遍 skus，这里保留了 `priceUsdtMicro` / `capacity` 两个便捷键，
 * 由本函数展开成「无规格商品的唯一组合（key=''）」—— 这是**测试侧的书写便利**，
 * 不是产品代码里的兼容分支：服务端只认 specs + skus。
 *
 * 单位是**微 USDT**（1 USDT = 1e6 微）：88 USDT 写 88000000。
 * 旧的 2 位小数标价单位已整体作废，数字不是"改个名字"那么轻——一律 ×10000。
 *
 * 需要测多规格时直接传 specs + skus：
 *   productPayload({ specs: [{name:'颜色',options:['黑','白']}],
 *                    skus: [{key:'黑',priceUsdtMicro:88000000},{key:'白',priceUsdtMicro:99000000}] })
 */
export function productPayload(overrides = {}) {
  const { priceUsdtMicro = 88_000_000, capacity = null, specs, skus, ...rest } = overrides;
  return {
    title: '测试数字商品',
    description: '单测上架的商品描述，用于校验快照与下单流程。',
    media: [{ type: 'image', url: 'https://example.com/a.jpg' }],
    kind: 'digital',
    specs: specs ?? [],
    skus: skus ?? [{ key: '', priceUsdtMicro, capacity }],
    ...rest,
  };
}

/**
 * 默认组合（sku_key=''）的库存行 —— 价格与库存现在都在 product_skus 上。
 * 无规格商品的唯一组合就是它，所以单规格用例仍可像以前一样读「这个商品的库存」。
 * 多规格用例请直接查 product_skus 并带上具体 sku_key。
 */
export async function skuInv(db, slug) {
  const r = await db.get(`SELECT s.capacity AS capacity, s.committed AS committed
         FROM product_skus s JOIN products p ON p.id = s.product_id
        WHERE p.slug = ? AND s.sku_key = ''`, slug);
  return r || { capacity: null, committed: 0 };
}

/**
 * 把草稿"做旧" ms 毫秒（清扫器用例的前置）——**必须同时回拨 `created_mono`**：
 * 清扫判据对"本次运行创建的草稿"只看单调锚点（见 `src/monotonicClock.js` 与 `src/orderSweeper.js`），
 * 只改 `created_at` 在新判据下不再等于"这单很老"（那正是这轮修复的意义）。
 * 想模拟"上一次运行遗留的草稿"请改 `created_boot`（跨运行的单调读数不可比，走墙钟判据）。
 *
 * ⚠️ 两处随 MySQL 重设计变了形状，都是**必须**变的：
 *   · `created_at` 是 `DATETIME(3)`，`created_at - ?` 会把整形参数当数字去减一个日期
 *     （得到 NULL 或荒谬值，且不报错）——时间减法只能写成 `INTERVAL ? MICROSECOND`；
 *   · 主键不再是那串字符串 id，对外标识是 `order_no`（参数就是从接口拿到的那个 id）。
 */
export async function ageDrafts(db, orderNos, ms) {
  const list = Array.isArray(orderNos) ? orderNos : [orderNos];
  const marks = list.map(() => '?').join(', ');
  await db.run(
    `UPDATE orders SET created_at = created_at - INTERVAL ? MICROSECOND, created_mono = created_mono - ?
      WHERE order_no IN (${marks})`,
    ms * 1000, ms, ...list
  );
}

/* ───────────────────────── 订单 / 商品的夹具（行形状的唯一实现）───────────────────────── */

/*
  订单是**三张 1:1 表**（事实 / 个人信息 / 链上镜像，判据见 src/db.js 的文件头）。
  在它们之前，二十来个测试文件各自手写一份 `INSERT INTO orders (…)` 的扁平列清单——
  那是同一份行形状的二十来份私有副本：列一搬家就同时失效，而且每处都得自己判断
  "这个字段现在住哪张表"。`insertOrder` 把"字段去哪张表"只实现一次，
  用例只声明它要的事实。**刻意不做"新旧两种规格都认"的兼容层**：那样两套形状会永远并存。

  下面三张 map 就是那份行形状本身：规格键（camelCase）→ 列名。
  `orders` 的时间列也在这里，但只写调用方显式给出的（见 insertOrder 的时间口径）。
*/
const ORDER_SPEC_COLUMNS = {
  orderNo: 'order_no',
  shopCode: 'shop_code',
  productId: 'product_id',
  productSlug: 'product_slug',
  productSnapshot: 'product_snapshot',
  snapshotHash: 'snapshot_hash',
  skuKey: 'sku_key',
  skuSpecs: 'sku_specs',
  buyer: 'buyer',
  seller: 'seller',
  quantity: 'quantity',
  status: 'status',
  amountWei: 'amount_wei',
  usdtMicro: 'usdt_micro',
  shippingFeeUsdtMicro: 'shipping_fee_usdt_micro',
  btyUsdtRate: 'bty_usdt_rate',
  feeBps: 'fee_bps',
  feeCollectorAtCreate: 'fee_collector_at_create',
  commissionBps: 'commission_bps',
  commissionTo: 'commission_to',
  commissionQuotedBps: 'commission_quoted_bps',
  commissionQuotedTo: 'commission_quoted_to',
  holdQty: 'hold_qty',
  releasedAt: 'released_at',
  trackingNo: 'tracking_no',
  carrier: 'carrier',
  shippedAt: 'shipped_at',
  timeoutBlocks: 'timeout_blocks',
  ageAck: 'age_ack',
  /*
    `invoice_needed`（"这单要不要开票"）是**订单事实**，住 `orders` —— 不在 `order_shipping`。
    它曾经在个人信息那一行上，于是擦除会把这份事实一起抹掉（导出让这单读成"没要求开票"）；
    现在擦除碰不到它（见 db.js 的建表注释与 test/pii-erase.test.js 的用例）。
    抬头/税号才是个人信息，它们仍按 `SHIPPING_SPEC_COLUMNS` 落到那一行上。
  */
  invoiceNeeded: 'invoice_needed',
  createdBoot: 'created_boot',
  createdMono: 'created_mono',
  piiErasedAt: 'pii_erased_at',
  piiCleanupPending: 'pii_cleanup_pending',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

/** `order_shipping` = **全部个人信息**（键沿用 v_orders 里的 shipping_* 命名） */
const SHIPPING_SPEC_COLUMNS = {
  shippingName: 'name',
  shippingPhone: 'phone',
  shippingAddress: 'address',
  note: 'note',
  invoiceTitle: 'invoice_title',
  invoiceTaxNo: 'invoice_tax_no',
  shippingEditCount: 'edit_count',
};

/** `order_chain` = 链上镜像（`escrow_order_id` 是这一行的身份，单独处理，见 insertOrder） */
const CHAIN_SPEC_COLUMNS = {
  paidTxHash: 'paid_tx_hash',
  refundStatus: 'refund_status',
  refundRequestedAt: 'refund_requested_at',
  refundRejectedAt: 'refund_rejected_at',
  refundedAmountWei: 'refunded_amount_wei',
  acceptedPartialRefundWei: 'accepted_partial_refund_wei',
  afterSaleStatus: 'after_sale_status',
  afterSaleOpenedAt: 'after_sale_opened_at',
  afterSaleOpenedBlock: 'after_sale_opened_block',
  afterSaleClosedAt: 'after_sale_closed_at',
  afterSaleNote: 'after_sale_note',
  events: 'events',
};

const PRODUCT_SPEC_COLUMNS = {
  slug: 'slug',
  shopCode: 'shop_code',
  title: 'title',
  description: 'description',
  descriptionBlocks: 'description_blocks',
  media: 'media',
  kind: 'kind',
  shippingFeeUsdtMicro: 'shipping_fee_usdt_micro',
  ageRestricted: 'age_restricted',
  nftContract: 'nft_contract',
  nftStandard: 'nft_standard',
  specs: 'specs',
  attributes: 'attributes',
  terms: 'terms',
  tags: 'tags',
  snapshotHash: 'snapshot_hash',
  autoDeliver: 'auto_deliver',
  stockAlertAt: 'stock_alert_at',
  active: 'active',
  publishedAt: 'published_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

/** 时间列：值必须是 `Date`（毫秒整数会被 MySQL 当数字字面量解析，写进荒谬时间且不报错） */
const ORDER_DATE_KEYS = ['releasedAt', 'shippedAt', 'piiErasedAt', 'createdAt', 'updatedAt'];
const CHAIN_DATE_KEYS = ['refundRequestedAt', 'refundRejectedAt', 'afterSaleOpenedAt', 'afterSaleClosedAt'];
const PRODUCT_DATE_KEYS = ['publishedAt', 'createdAt', 'updatedAt'];
/** DECIMAL 金额列：只收 string / bigint（number 会让 38 位 wei 静默取整） */
const ORDER_DECIMAL_KEYS = ['amountWei', 'btyUsdtRate'];
const CHAIN_DECIMAL_KEYS = ['refundedAmountWei', 'acceptedPartialRefundWei'];
/** JSON 列：收对象/数组，由夹具 stringify */
const ORDER_JSON_KEYS = ['skuSpecs'];
const PRODUCT_JSON_KEYS = ['descriptionBlocks', 'media', 'specs', 'attributes', 'terms', 'tags'];

/**
 * 按 `columns` 挑出规格里**声明过**的字段。
 *
 * `undefined` = 没声明 ⇒ 这一列根本不进 INSERT（交给列默认值 / 三态 NULL）；
 * 显式 `null` = 就是要写 NULL（"没有这个事实"），与"没声明"不是一回事。
 * 唯一例外是 JSON 列：本 schema 里那些列都是 `NOT NULL DEFAULT ('[]')`，"写 NULL"不可表达，
 * 所以 `null` 在那里与"没声明"同义（落在默认的空数组上）——旧形状里它们是可空 TEXT，
 * 于是 `events: null` 曾是"没有事件史"的写法，那个写法在新库里只会撞 NOT NULL 报错。
 * 另外两类值在这里做**类型门禁**（它们是静默失败的高发区，见各自的报错文案）：
 * 时间必须是 `Date`、DECIMAL 金额必须是字符串。
 */
function pickSpec(spec, columns, { dates = [], decimals = [], json = [] } = {}) {
  const cols = [];
  const values = [];
  for (const [key, column] of Object.entries(columns)) {
    const v = spec[key];
    if (v === undefined) continue;
    if (json.includes(key) && v === null) continue;
    if (dates.includes(key) && v !== null && !(v instanceof Date)) {
      throw new Error(
        `insertOrder/insertProduct: ${key} 必须是 Date，收到 ${typeof v}。` +
          '传毫秒整数会被 MySQL 当成数字字面量解析——写进一个荒谬的时间，而且**不报错**；' +
          '要覆盖服务器盖章的时间请传 new Date(ms)（显式 null = 这一列就是"没有这个时刻"）。'
      );
    }
    if (decimals.includes(key) && typeof v !== 'string' && typeof v !== 'bigint') {
      throw new Error(
        `insertOrder: ${key} 必须是字符串，收到 ${v === null ? 'null' : typeof v}。wei 是 DECIMAL(38,0)，` +
          'number 装不下 38 位，会静默取整——本仓最不能接受的那类失败；' +
          "没有发生过的金额写 '0'（这一列是 NOT NULL，0 就是它的「从未发生」档）。"
      );
    }
    cols.push(column);
    values.push(json.includes(key) && v !== null ? JSON.stringify(v) : decimals.includes(key) ? String(v) : v);
  }
  return { cols, values };
}

/** 即时生成一个唯一的链上托管单号（`order_chain.escrow_order_id` 是 CHAR(66) 且唯一） */
function randomEscrowOrderId() {
  return `0x${randomBytes(32).toString('hex')}`;
}

/**
 * 造一行订单（**测试侧建单的唯一入口**）。
 *
 * ## 写哪些行
 *
 * `orders` 行总是写；`order_shipping` 与 `order_chain` **只在调用方真的给了那张表上的字段时才建行**
 * （字段清单见上面三张 map）。刻意不默认建，代价与理由：
 *   · 没有收货信息的草稿不该有 PII 行——"这一行还在不在"正是擦除承诺的判据，
 *     凭空建一行等于让每个用例都从"还没擦"开始；
 *   · 没有链上事实的单不该有链上镜像行——`chainAnchor.inflightChainOrders()` 按
 *     `JOIN order_chain` 数在途单，凭空建一行会让"草稿不算在途"这条断言失去意义。
 *   代价如实写：想读 `refund_status` 却忘了给 `escrowOrderId` 的用例会在视图里读到 NULL
 *   （LEFT JOIN 没命中）——那是**如实**的 NULL（"这单没有链上镜像"），不是被夹具吞掉的值。
 *
 * 链上字段给了、`escrowOrderId` 没给 ⇒ 自动生成一个（`order_chain.escrow_order_id` 是 NOT NULL，
 * 链上事实不可能没有单号）；显式 `escrowOrderId: null` 又要写链上字段 ⇒ **抛错**：
 * 那种组合在 schema 里不可表达，静默丢掉字段会让用例在一个假前提上通过。
 *
 * ## 时间 / 金额口径
 *
 * 时间一律 `Date`：不传 = 由服务器 `DEFAULT CURRENT_TIMESTAMP(3)` 盖章（应用端时钟错了也写不错）。
 * `amountWei` / `refundedAmountWei` / `acceptedPartialRefundWei` / `btyUsdtRate` 只收字符串
 * （或 bigint）——收 number 就等于让 38 位 wei 悄悄被 double 取整。
 *
 * @param {object} db `makeCtx()` 给的查询门面
 * @param {object} spec 见上面三张列 map；`buyer`/`seller` 必给
 * @returns {Promise<{orderId: number, orderNo: string, escrowOrderId: string|null}>}
 *   `orderId` = 内部主键（**子表外键**、`WHERE order_id = ?` 用它）；
 *   `orderNo` = 对外单号（接口上的 `id`、`WHERE order_no = ?` 用它）。
 *   `escrowOrderId` = null 表示这单没有链上镜像行。
 */
export async function insertOrder(db, spec = {}) {
  const { buyer, seller } = spec;
  if (!buyer || !seller) {
    throw new Error(
      'insertOrder: 必须给 buyer 与 seller。当事人是订单的事实，猜一个默认地址会让 ' +
        "`WHERE buyer = ?` 悄悄查错行（或查不到）——宁可在这里响亮失败。"
    );
  }
  /*
    三段写入包在**一个事务**里（作用域由回调界定，见 src/db.js 的 withTransaction）。
    为什么必须：旧形状是一次扁平 INSERT，天然原子；拆成三张表之后不包事务，
    "父行写进去了、子行被唯一索引/外键拒掉"就会在库里留下一条**没有链上镜像的单**——
    而这类残留会改变后续用例的计数（order-cancel 的"重复 escrow_order_id 被拒"用例正踩在这里：
    被拒之后仍多出一行）。夹具必须与旧形状一样是全有或全无。
  */
  const { withTransaction } = await import('../src/db.js');
  return await withTransaction(async () => {
    /*
      单号 / 商品标识由 src/ids.js 生成（**唯一实现**）：夹具自己拼一串会造出格式不合法的标识，
      而接口、前端倒计时、按前缀检索都依赖那个格式（`B` + 10 时间 + 10 随机）。
      调用方给了就照用——有钉"单号形态"的用例需要自己指定。
    */
    const { newOrderId, newProductSlug } = await import('../src/ids.js');
    const row = {
      shopCode: TEST_SHOP_CODE,
      productSlug: newProductSlug(),
      productSnapshot: '{}',
      snapshotHash: '0x00',
      skuKey: '',
      quantity: 1,
      status: 'draft',
      amountWei: '0',
      usdtMicro: 0,
      /*
        **条款报价的默认值**（2026-10-18）：交付闸现在对"本单没有报价快照"是 fail-closed
        （`termsMismatchOf` 返回 unreadable），而直插夹具的行通常只关心别的列。默认写一份
        "与当前店铺条款一致"的报价：抽成 0、收款人 = 卖家（夹具店的 seller 就是节点主），
        验货窗口取默认 7 天。要验"未报价/不一致"的用例显式传 null / 别的值覆盖。
      */
      commissionQuotedBps: 0,
      commissionQuotedTo: String(seller).toLowerCase(),
      timeoutBlocks: 120960,
      ...spec,
      orderNo: spec.orderNo ?? newOrderId(),
      buyer,
      seller,
    };
    const picked = pickSpec(row, ORDER_SPEC_COLUMNS, { dates: ORDER_DATE_KEYS, decimals: ORDER_DECIMAL_KEYS, json: ORDER_JSON_KEYS });
    const marks = picked.cols.map(() => '?').join(', ');
    const ins = await db.run(`INSERT INTO orders (${picked.cols.join(', ')}) VALUES (${marks})`, ...picked.values);
    /*
      `insertId` = 这条 INSERT 分配到的 `orders.id`，两张 1:1 子表的外键就是它。
      刻意不用 `SELECT MAX(id)` 回查：那靠"中间没有别人插行"的时序巧合成立。
    */
    const orderId = Number(ins.insertId);

    const ship = pickSpec(spec, SHIPPING_SPEC_COLUMNS);
    if (ship.cols.length) {
      const shipMarks = ship.cols.map(() => '?').join(', ');
      await db.run(`INSERT INTO order_shipping (order_id, ${ship.cols.join(', ')}) VALUES (?, ${shipMarks})`, orderId, ...ship.values);
    }

    // `escrowOrderId` 单独处理（它是链上镜像行的身份，不在 CHAIN_SPEC_COLUMNS 里）
    const chain = pickSpec({ ...spec, escrowOrderId: undefined }, CHAIN_SPEC_COLUMNS, {
      dates: CHAIN_DATE_KEYS,
      decimals: CHAIN_DECIMAL_KEYS,
      json: ['events'],
    });
    const declaredEscrowId = spec.escrowOrderId === undefined ? undefined : spec.escrowOrderId;
    if (declaredEscrowId === null && chain.cols.length) {
      throw new Error(
        'insertOrder: escrowOrderId: null 与链上字段（paidTxHash / refund* / afterSale* / events）不能同时出现——' +
          'order_chain.escrow_order_id 是 NOT NULL，这个组合在 schema 里不可表达；' +
          '静默丢掉那些字段会让用例在一个假前提上通过。'
      );
    }
    let escrowOrderId = null;
    if (declaredEscrowId !== null && (declaredEscrowId !== undefined || chain.cols.length)) {
      escrowOrderId = declaredEscrowId ?? randomEscrowOrderId();
      const chainMarks = chain.cols.map(() => ', ?').join('');
      await db.run(
        `INSERT INTO order_chain (order_id, escrow_order_id${chain.cols.length ? `, ${chain.cols.join(', ')}` : ''}) VALUES (?, ?${chainMarks})`,
        orderId,
        escrowOrderId,
        ...chain.values
      );
    }
    return { orderId, orderNo: row.orderNo, escrowOrderId };
  });
}

/**
 * 造一行商品（+ 可选的 SKU 行），返回 `{ productId, slug }`。
 *
 * 存在的理由与 `insertOrder` 同一条：商品行的形状（`shop_code` 外键、`description` 无默认值、
 * `slug` 是 CHAR(11)、`kind='nft'` 与 `nft_contract` 必须同真同假）散在几个文件里手写，
 * 下一次加列就是下一次逐个文件改。`skus` 里的每一项展开成一行 `product_skus`
 * （价格与库存在那张表上，见 setup.mjs 里 skuInv 的说明）。
 */
export async function insertProduct(db, spec = {}) {
  const { newProductSlug } = await import('../src/ids.js');
  // 与 insertOrder 同一条纪律：商品行与它的 SKU 行同批（一个事务），不许留下"有商品没库存行"的半写状态
  const { withTransaction } = await import('../src/db.js');
  return await withTransaction(async () => {
  const row = {
    shopCode: TEST_SHOP_CODE,
    title: '测试商品',
    description: '',
    kind: 'digital',
    snapshotHash: '0x00',
    descriptionBlocks: [],
    media: [],
    specs: [],
    attributes: [],
    terms: {},
    tags: [],
    ...spec,
    slug: spec.slug ?? newProductSlug(),
  };
  const picked = pickSpec(row, PRODUCT_SPEC_COLUMNS, { dates: PRODUCT_DATE_KEYS, json: PRODUCT_JSON_KEYS });
  const marks = picked.cols.map(() => '?').join(', ');
  const ins = await db.run(`INSERT INTO products (${picked.cols.join(', ')}) VALUES (${marks})`, ...picked.values);
  const productId = Number(ins.insertId);
  for (const sku of spec.skus ?? []) {
    await db.run(
      `INSERT INTO product_skus (product_id, sku_key, specs_json, price_usdt_micro, image_url, capacity, committed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      productId,
      sku.key ?? '',
      JSON.stringify(sku.specsJson ?? {}),
      sku.priceUsdtMicro ?? 0,
      sku.imageUrl ?? '',
      sku.capacity ?? null,
      sku.committed ?? 0
    );
  }
  return { productId, slug: row.slug };
  });
}

/**
 * 对外订单号 → **内部主键**（`orders.id` / `v_orders.order_id`）。
 *
 * 为什么需要它：接口上的 `id` 是 `order_no`，而所有子表外键（`order_delivery_items` /
 * `dispute_evidence` / `evidence_files` / `order_returns` / `reviews` / `product_codes.order_id`…）
 * 与告警去重表 `order_alerts.order_id` 要的都是**数字主键**。旧形状里这两者是同一个字符串，
 * 于是"拿接口给的 id 去查子表"曾经天然成立；现在它必须显式转一次——写出一行
 * `WHERE order_id = <order_no>` 在 v_orders 上查不到东西，而在子表上只会永远命中 0 行（静默为空）。
 */
export async function orderIdOf(db, orderNo) {
  const row = await db.get('SELECT order_id FROM v_orders WHERE order_no = ?', String(orderNo || ''));
  if (!row) throw new Error(`orderIdOf: 找不到订单号 ${String(orderNo)}（子表外键需要一个真实存在的内部主键）`);
  return row.order_id;
}

/**
 * 由 API 返回的商品构造「DB 行形状」的对象，供测试复算快照哈希。
 * 快照契约（**键序即契约**，两端必须逐字一致，见 node/src/routes/products.js 的 snapshotObject
 * 与 frontend/src/utils/snapshot.ts）：slug / title / description / description_blocks /
 * media / kind / shipping_fee_usdt_micro / age_restricted / specs / skus（nft 商品在**末尾**
 * 追加 nft_contract、nft_standard）——价格不在商品级，每个组合的单价在 skus 里。
 */
export function rowLikeOf(p) {
  return {
    slug: p.slug,
    title: p.title,
    description: p.description,
    // **每个快照键都要在这里**：这个助手是"公开字段 → 可复算的哈希"的判据输入，
    // 漏一个键就会让"哈希对不对"这条断言悄悄失去意义（曾经漏过 description_blocks：
    // 带详情块的商品复算必然不一致，而用例只报哈希不同、看不出是谁漏了）。
    /*
      ⚠️ 这些 JSON 列**不 stringify**：`rowLikeOf` 只用来喂 `snapshotObject()` 复算哈希，
      而 JSON 列经驱动读回来已经是**解析好的数组/对象**，快照投影（parseBlocks/parseSpecsColumn…）
      现在只收这个形状——传字符串会被 `assertParsedJsonColumn` 响亮拒绝（那是刻意的：
      传字符串只可能是调用方拿的是列原文，静默当"没有内容"会让哈希算错而看不出原因）。
      本函数从不用于 INSERT，所以不需要为写库做序列化。
    */
    description_blocks: p.descriptionBlocks || [],
    media: p.media || [],
    kind: p.kind,
    shipping_fee_usdt_micro: p.shippingFeeUsdtMicro ?? 0,
    age_restricted: p.ageRestricted ? 1 : 0,
    specs: p.specs || [],
    skus: (p.skus || []).map((s) => ({
      sku_key: s.key,
      price_usdt_micro: s.priceUsdtMicro,
      image_url: s.imageUrl || '',
    })),
    attributes: p.attributes || [],
    terms: p.terms || {},
    nft_contract: p.nftContract || '',
    nft_standard: p.nftStandard || 'erc721',
  };
}
