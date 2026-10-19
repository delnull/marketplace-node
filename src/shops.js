/**
 * 店铺（租户）访问层 —— **"这个请求属于哪家店"的唯一判据**，同时也是**节点单例（`node` 表）的读入口**。
 *
 * ## 为什么必须有这一个模块
 *
 * 在它之前，"这家店是谁"由 `config.shop.owner` 一个全局常量回答。于是"一节点一店"
 * 被写死在四个地方：鉴权（`ownerOnly`/`staffOnly` 比同一个常量）、商品归属（`products`
 * 表连卖家列都没有）、订单卖家（`orders.seller` 恒等于那个常量）、以及全部统计口径。
 * 多店之后这四件事必须由**同一行数据**回答，否则每一处都要自己再判一次，而"新增一个
 * 调用点就多一个漏点"——本仓把这种形状叫"判据挂错了层"。
 *
 * 所以：`shops` 表是唯一的租户事实源，本模块是读它的唯一入口，
 * `resolveShopRef` 是"一个句柄 → 一行店铺"的**唯一实现**。
 *
 * ## 店铺句柄（X-Mk-Shop 头）只有一种拼写
 *
 * **店铺编号**（链上铸造的 9 位 Crockford Base32，见 shared/shopCode.js）。
 * 一家店先有链上登记、才有这一行、才有编号——所以句柄永远能是编号，不需要第二种拼写。
 * （2026-10-16 删掉"用店主地址指代"那条路：它存在的唯一理由是"自营店在节点主登记之前
 * 没有编号"，而**自营店这个特例已经删掉了**——开节点与开店铺是两个独立动作。
 * 这条口径的收益是结构性的：`shops.code` **恒非空**，于是"编号为空的那一行"
 * 这一整类分支——鉴权、订单归属、存储键、文件归属、可售判据——全部消失。）
 *
 * ## 节点主（旧称 host）住在 `node` 表，不在 `shops`
 *
 * `shops` 那一列 `host` 已随重设计删除：**一个库就是一个节点**，所有店铺行再各存一份
 * "本店挂在谁那儿"就是同一事实的 N 份副本（而副本必然漂移）。节点主地址的唯一家是
 * `node.owner`（单例行），本模块的 `nodeRow()/nodeOwner()` 是读它的唯一入口；
 * 对外 DTO 里的 `host` / `commissionTo` 都从那一行现算，本地不留第二份。
 * 节点的对外名称/公告同样住那一行（`node.name` / `node.notice`）——它不是"某家店的名字"。
 *
 * ## listed 的口径（最容易被误读的一条）
 *
 * `listed = 0` 只意味着**不能接单 + 不进前端聚合**（链上 `shopListed` 的镜像：节点主/员工暂停、
 * 节点不在册/被停用、协议侧黑名单、或店主已退出）。它**不是**"店下线"：该店的发货、同意/拒绝退款、
 * 售后案件、个人信息擦除、自有资料维护**全部照常可用**。把 listed=0 做成"拒绝一切卖家面请求"
 * 会让店主在店铺被暂停之后连已托管的单子都没法处理——那正是合约注释里明确否掉的东西。
 * 落实方式：只有**影响未来销售**的动作（上架/改价/码池与 token 池导入）检查 `assertSellable`，
 * 履约类动作一律不检查。
 *
 * ## 时间列一律 `DATETIME(3)`（`Date` 进、`Date` 出）
 *
 * 本模块只做一件事：把**链上读数**（unix 秒/BigInt）与**库列**（`Date`）接起来。
 * 库列一律要求 `Date`：传毫秒整数时 MySQL 会把它当数字字面量去解析，写进一个荒谬的时间
 * 而**不报错**（见 db.js 的说明），所以这些入口用 `requireDate` 把它变成响亮失败。
 */
import { ethers } from 'ethers';
import config, { DEFAULT_SHOP_NAME } from './config.js';
import { getDb } from './db.js';
import { isAddress, isZeroAddress } from './chain.js';
import { tanxinAddressOf } from './tanxin.js';

/** 店铺句柄的请求头（卖家面的**范围提示**：带了必须指得中；不带则取唯一经营的那家，多店时必须点名——见 http.js） */
export const SHOP_HEADER = 'x-mk-shop';

/** 店铺编号的形状（9 位；字符集见 shared/shopCode.js——校验位可能落在 -._~, 上） */
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z.\-_~,]{9}$/i;

/**
 * 是不是一个**形状合法**的店铺编号（**唯一实现**：`resolveShopRef` 的句柄形状判据，
 * `isShopCodeShape` 只判形状、不判存在）。
 *
 * 只判形状、不判存在：存在性只有库能回答（`shopRowByCode`）。分成两层是因为两处的失败
 * 语义不同——"抄错了形状"是 400（参数问题），"没有这家店"是 404（事实问题）。
 */
export function isShopCodeShape(v) {
  return CODE_SHAPE.test(String(v ?? '').trim());
}

/**
 * `DATETIME(3)` 列的参数门禁（**唯一实现**）：只接受 `Date`。
 *
 * 为什么要有它：这两个入口的值来自**链上读数**（termsReconciler 传进来的 unix 秒或 BigInt），
 * 而 MySQL 对"数字进 DATETIME 列"不报错——它把数字当字面量解析，落进一个与真实时刻无关的时间。
 * 那种错误不会当场现形，只会在几周后表现为"时间列读出来的时刻与链上差了若干年"。
 * 让它在**数据入口**响亮失败，比在每个消费点各猜一次类型便宜得多。
 */
function requireDate(v, what) {
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) {
    throw new Error(`${what} 必须是 Date（链上 unix 秒请在链上读数那一层换算成 Date；DATETIME(3) 列收不了数字）`);
  }
  return v;
}

/* ─────────────────────────── 节点单例（node 表）─────────────────────────── */

/**
 * 节点主的**同步投影**（进程内缓存，初值空串）。
 *
 * `node.owner` 是唯一真相（`node` 单例行，由 `db.js` 的 `initDb()` 种入并在每次启动时按
 * `MK_SHOP_OWNER` 刷新），但它只能异步读；而 `src/shopCode.js` 必须在**同步**上下文里拿到
 * 节点主地址（`Registry.codeOf(host)` 的缓存键）。这里只缓存**那一个身份**：
 * `nodeRow()` 每次调用都会刷新它，而它在一次进程生命周期内不会变（换节点主 = 换一台机器）。
 * 所以"缓存"不会变成第二份真相——它只是同一行的同步投影。
 */
let cachedNodeOwner = '';

/** 一行 `node`（单例行；读不到返回 undefined——**不猜**、不建行，建行是 `db.js` 启动期的事） */
export async function nodeRow() {
  const row = await getDb().get('SELECT * FROM node WHERE id = 1');
  cachedNodeOwner = nodeOwnerOf(row);
  return row;
}

/** 一行 `node` → 节点主地址（小写）；空/非法/零地址一律空串 = "读不到"，不编一个值 */
export function nodeOwnerOf(row) {
  const v = String(row?.owner || '').trim().toLowerCase();
  return isAddress(v) && !isZeroAddress(v) ? v : '';
}

/** 节点主地址（读库；读不到返回空串——调用方按"这台机器还没有身份"处理） */
export async function nodeOwner() {
  return nodeOwnerOf(await nodeRow());
}

/**
 * 节点主地址（**同步**；= 最近一次读到的 `node.owner`）。
 *
 * 仅服务同步调用点：`src/shopCode.js` 的 `nodeCode()`，以及把 `node` 行已经读出来的路由
 * （那样不必为同一个值再查一次库）。要在**判定**里用节点主身份（鉴权）请走 `auth.isHost()`。
 * ⚠️ 它在**任何一次 `nodeRow()` 之前**是空串，所以 `server.js` 在 `initDb()` 之后立刻读一次
 * 那一行（唯一的暖机点；漏掉它的症状是节点级 DTO 里"收款人读不到"而启动毫无提示）。
 */
export function hostOperator() {
  return cachedNodeOwner;
}

/* ─────────────────────────── 店铺行 ─────────────────────────── */

/**
 * 展示用店名（**唯一实现**：`shops.name` / `node.name` 两处同名同规则，DTO 与设置页共用）。
 * `''` = **没设置过** ⇒ 回默认名；默认名只是**展示默认值**，不是第二份真相
 * （它不落库，所以"没设置过"这个事实没有被抹掉）。
 */
export function shopDisplayName(row) {
  const v = String(row?.name || '');
  return v !== '' ? v : DEFAULT_SHOP_NAME;
}

/** 展示用公告（**唯一实现**；`''` = 没设置过） */
export function shopDisplayNotice(row) {
  return String(row?.notice || '');
}

/**
 * 一行 shops → 对外形状（**唯一一份**：公开列表、店铺详情、卖家面板共用，避免三处各拼一遍）。
 *
 * `nodeAddr` = 节点主地址（`hostOperator()` 或 `await nodeOwner()`）。它**必须传**：
 * 抽成收款人恒为该地址（链上 `ShopInfo` 里没有这一列，本地也没有第二份），
 * 且**零费率时也要给**：链上 `Escrow._checkShopListed` 用 `(seller, commissionTo)` 定位是哪一家店，
 * 空串/零地址会让每一笔零费率订单都判 `ShopNotListed`。所以 `bps > 0` 而地址读不到时**抛错**
 * （响亮失败），不静默降级。
 */
export function shopDto(row, nodeAddr) {
  if (!row) return null;
  const bps = Number(row.commission_bps) || 0;
  const node = String(nodeAddr || '').trim().toLowerCase();
  if (bps > 0 && !isAddress(node)) {
    throw new Error('抽成收款人 = 本节点主地址（node.owner），当前读不到，无法给出确证的抽成条款');
  }
  /*
    2026-10-18：删掉"待决佣金提案"整条形状（链上已没有 propose→accept/reject）。
    费率只有节点主能改（`Registry.setShopCommission`，立即生效），本地只镜像最终值；
    店主的表达只有退出（`deregisterShop`），没有"提案待决"这个中间态。
  */
  return {
    code: row.code || '',
    seller: row.seller,
    /*
      `host` = **本节点的节点主地址**（一库一节点，所有店铺同值）。
      它不是店铺的字段（`shops.host` 已删），而是"这家店挂在哪台机器下"的答案——
      联邦目录要靠它把店铺与节点对上，所以在这里如实给出，不让每个前端各猜一次。
    */
    host: node || null,
    name: shopDisplayName(row),
    notice: shopDisplayNotice(row),
    /**
     * 本店谈信地址（公开客服联系方式）：`null` = 没设置过。
     * 原样下发（不折小写）：1 开头的 base58 地址区分大小写；前端只负责展示与把字符串
     * 交给谈信 App 的 `openChat`，不在这里判断它像不像地址。
     */
    tanxinAddress: tanxinAddressOf(row),
    /** 抽成条款：收款人 = 本店的节点地址（**恒为节点主，零费率也给**——链上用它对定位店铺） */
    commissionTo: node,
    commissionBps: bps,
    listed: Number(row.listed) === 1,
    registeredAtBlock: Number(row.registered_at_block) || 0,
    registeredTx: row.registered_tx || null,
    syncedAt: row.synced_at ?? null,
  };
}

/** 全部店铺行（按链上登记顺序：`code` 是链上铸造的，排序即登记顺序） */
export async function listShopRows() {
  return await getDb().all('SELECT * FROM shops ORDER BY created_at ASC, code ASC');
}

/** 只出**在售**店铺（公开聚合面用；listed=0 的店不进聚合） */
export async function listListedShopRows() {
  return await getDb().all('SELECT * FROM shops WHERE listed = 1 ORDER BY created_at ASC, code ASC');
}

/**
 * 按编号读一行（读不到返回 undefined；调用方按"没有这家店"处理，**不猜**）。
 *
 * `code` **恒非空**：一行店铺只在"链上已经有了这家店"之后才存在（落库走
 * `routes/shops.js` 的 verify-onchain 与 `termsReconciler`），而编号是链上铸造的。
 * 空值因此就是"没给编号"，直接查不到。
 */
export async function shopRowByCode(code) {
  const c = String(code ?? '').trim();
  if (!c) return undefined;
  return await getDb().get('SELECT * FROM shops WHERE code = ?', c);
}

/** 按店主地址读一行（大小写由列的排序规则折；读不到返回 undefined） */
export async function shopRowBySeller(seller) {
  const s = String(seller || '').trim().toLowerCase();
  if (!isAddress(s)) return undefined;
  /*
    写入侧一律小写落库（`shops.seller` 的不变量，与 orders.seller / products.shop_code 同规约），
    读取侧因此直接 `seller = ?`。

    为什么不再写 `lower(seller) = ?`（2026-10-16 改）：那是 SQLite 时期的必要形状——
    它的字符串比较区分大小写，而**存量行里混进过带校验和的写法**（演示种子脚本直接照抄
    chain.json 的 `address` 字段），于是 `WHERE seller = ?` 对那一行彻底不可见（节点自己发出的
    句柄自己不认：`GET /api/shop` 发出去的 seller 回填成 `X-Mk-Shop` 就是 404）。
    函数包住列会让 `uq_shops_seller` 用不上——每次鉴权（每请求一次 `resolveShopRef`）都变成
    全表扫描，所以列比较保持裸等值。
    ⚠️ **地址类列是大小写敏感的**（`utf8mb4_0900_as_cs`，与库级排序规则一致，2026-10 更正：
    此前这段注释写的是"刻意保留 ai_ci，漏归一化也不会错"——**那是假话**）。在 as_cs 下，
    大小写不同的两行是**两个不同的键**：`WHERE seller = ?` 对它们各自只命中自己。
    所以"写入侧一律小写"是**唯一的不变量**、不是可以靠排序规则兜住的安全网。
  */
  return await getDb().get('SELECT * FROM shops WHERE seller = ?', s);
}

/**
 * 店铺句柄 → 一行店铺（**唯一实现**）。
 *
 * 句柄只有一种拼写：**店铺编号**（链上铸造）。查不到一律返回 `null`，
 * **绝不回退到"本节点唯一那家店"**——那会让一个抄错的编号静默打开别人家的店
 * （本仓在 URL 解析层已经为同一件事否掉过一次"猜"）。
 */
export async function resolveShopRef(value) {
  const v = String(value || '').trim();
  if (!isShopCodeShape(v)) return null;
  return (await shopRowByCode(v.toUpperCase())) || null;
}

/**
 * 从请求解析店铺上下文（**唯一入口**：公开面与鉴权中间件都走它）。
 *
 * **不做任何兜底**：缺头返回 null（由中间件决定是"这个地址唯一经营的那家"还是"全部在售店"），
 * 给了头但解析不到返回 `{ unresolved }`（由中间件决定 404——"你指的是哪家店"与
 * "这家店不存在"是两种不同的失败，混成一个会让排查方向错掉）。
 * @returns {{shop: object|null, unresolved: boolean, provided: boolean}}
 */
export async function shopContextOf(req) {
  const raw = req?.headers?.[SHOP_HEADER];
  const provided = raw !== undefined && String(raw).trim() !== '';
  if (!provided) return { shop: null, unresolved: false, provided: false };
  const row = await resolveShopRef(raw);
  return { shop: row, unresolved: !row, provided: true };
}

/**
 * 该店现在能不能卖（本地判据）。
 *
 * 只有一个来源：`listed` 列——它是链上 `shopListed` 的镜像，由 `termsReconciler` 写入。
 * （2026-10-16 删掉"自营店在链上登记前按能卖处理"那一档：一行店铺只在链上已经有这家店
 * 之后才存在，所以"没有链上读数可问"这种状态**不可表达**。）
 */
export function shopSellable(row) {
  if (!row) return false;
  return Number(row.listed) === 1;
}

/** 不能卖时的可读拒因（**唯一一份文案**：下单闸与商品闸共用，避免两处各说一句） */
export function notSellableReason(row) {
  // 2026-10-18：只剩"节点主/员工暂停"与"节点不在册/被停用/被拉黑"两种来源（协商费率已删）
  return '该店铺已暂停接单（被节点主/节点员工暂停，或所属节点不在册/被治理停用，或被协议侧列入黑名单）；在途订单不受影响';
}

/**
 * "影响未来销售"的动作的统一闸（**唯一实现**）：上架商品、改价、导入码池/token 池、
 * 建新订单都要过它。返回 null 表示放行，否则返回可读拒因。
 *
 * ⚠️ 它**只该**挂在这类动作上。发货、同意/拒绝退款、售后案件、PII 擦除、店铺资料维护
 * **一律不检查** `listed`：`listed = 0` 只是"暂停接单 + 退出聚合"，不是"店下线"，
 * 店主必须还能处理已经托管的单子（合约注释与 PRODUCT_BOUNDARIES 都写明了这一条）。
 */
export function sellableError(row) {
  return shopSellable(row) ? null : notSellableReason(row);
}

/**
 * 该店在**创建订单**时要写进 `Escrow.createOrder` 的条款参数（**唯一实现**）。
 *
 * ⚠️ 键名与 `node/src/routes/orders.js` 的 DTO **刻意不同**，两处都别改错（这是踩过的地方）：
 *   · 本函数（喂给 `escrow.createOrder` 的参数）= `{ commissionTo, commissionBps }`；
 *   · 订单 DTO 下发的 `order.commission` = `{ to, bps }`（给前端/脚本读的那一份）。
 * 按 DTO 的键名去读本函数的返回值（或反过来）都会拿到 `undefined`，而**症状不是报错**：
 * `Number(undefined) || 0` 一路静默成"这单不抽成"，链上照 `commissionBps = 0` 建单——
 * 于是抽成腿整条消失，而每一处日志看上去都正常。
 *
 * `bps = 0` **也返回节点主地址**（2026-10-18 更正）：合约用 `(seller, commissionTo)` 定位
 * 店铺，零费率时收款人同样是店铺键的一部分（`_checkShopListed`），归一成零地址会让每一笔
 * 零费率订单都判 `ShopNotListed`；`_splitOf` 在 bps=0 时算出 0，整条抽成腿自然跳过。
 * 旧注释写的"合约零费率不校验收款人、快照归一成零地址"已不成立（合约与 0 bps 一起校验）。
 *
 * **收款人 = 本店的节点地址**（2026-10-16）：它不再是链上可配字段（`ShopInfo` 里没有这一列），
 * 也不是本地可配列（`shops.commission_to` 已下线）——`node.owner` 就是唯一答案，谁提供基础设施，
 * 抽成就给谁。所以这里从 `hostOperator()`（`node.owner` 的同步投影）现算，
 * 而不是读一个可能与链上不一致的副本；读不到且确实要抽成时**抛错**（见 shopDto 的同款理由）。
 */
export function orderTermsOf(row) {
  const bps = Number(row?.commission_bps) || 0;
  /*
    2026-10-18：**零费率也要返回节点主**。`(seller, commissionTo)` 是链上的店铺主键
    （`Escrow._checkShopListed` 用它问 Registry 这是哪一家店），零地址会让每一笔零费率订单
    都判 `ShopNotListed`。`commissionBps` 才是"抽不抽"，收款人只是"哪家店"。
  */
  const node = hostOperator();
  if (!isAddress(node)) {
    throw new Error('抽成收款人 = 本节点主地址（node.owner），当前读不到——拒绝建单，避免把抽成腿静默写成 0');
  }
  return { commissionTo: node, commissionBps: bps };
}

/* ── 开店票据（registerShop 的双签摘要）───────────────────────────────── */

/**
 * 双签票据摘要（**唯一实现**，与合约 `_shopTicketDigest` 逐字对应）：
 *
 *     inner  = keccak256(abi.encode(host, seller, commissionBps, deadline, chainId, registry))
 *     digest = ethers.hashMessage(inner)     ← EIP-191（= 合约的 toEthSignedMessageHash）
 *
 * **两层都要算**。方向不是风格选择，而是"浏览器钱包能不能签"这条硬约束 ——
 * 实测三种组合（forge 与 ethers 各跑过一遍，只有中间那一种成立）：
 *
 * | 合约 digest | 钱包的动作 | `digest.recover(sig)` |
 * |---|---|---|
 * | 内层（一层） | `personal_sign(内层)` | 恢复出**别人** |
 * | **两层（本实现）** | **`personal_sign(内层)`** | **恢复出签名者** ✅ |
 * | 两层 | `personal_sign(两层)` | 恢复出别人（多包一层） |
 *
 * 原因：EIP-1193 只暴露 `personal_sign`（**总会**加前缀）⇒ 钱包签的原文是**内层**；
 * 而合约 `digest.recover` 内部又做一次 `toEthSignedMessageHash(digest)`。两边对上，
 * 当且仅当 `digest` = "内层 + 前缀"。所以本函数返回两层，而**签名方签的是内层**
 * （`frontend/src/utils/shopRegistration.signShopTicket` 的 `signMessage(内层)`）。
 *
 * 三端只有这一种对应关系（改任何一处都要同批改另两处）：
 *   合约 `_shopTicketDigest` = 本函数 = 前端 `chain.shopTicketDigest`（**两层**）；
 *   签名 = 钱包 `personal_sign(内层)`；链上验签 = `digest.recover(sig)`；节点验签 = 见下。
 * 跨端对拍见 `node/test/abi-consistency.test.js`（fixture 从合约打印，不是从 JS 抄的）。
 *
 * `deadline` 是 `Date`（库列 `shop_applications.deadline` 是 `DATETIME(3)`），
 * 而 ABI 里是 **uint64 unix 秒**——这两个表示之间的换算**只在这里**发生一次：
 * 路由与对账都传库里的那个 `Date`，谁都不必自己 `Math.floor(x/1000)`（那种散落的换算
 * 迟早会有人对毫秒下手，而症状是"签名验不过"且看不出为什么）。
 *
 * ⚠️ `chainId` / `registry` 是**显式入参**（默认取 config），不是"在这里读 config"：
 * 读 config 会把判据绑在**模块求值时刻**上——而 `config` 在 import 时就固化了 env。
 * 于是"喂一份 fixture 再算一遍"这种跨端对拍**做不到**（改了 env 也没用，模块早就缓存了旧值），
 * 而三端摘要同构恰恰是最需要拿真值算的东西。显式入参之后它是**纯函数**，判据与调用时刻无关。
 *
 * @param {{host:string, seller:string, commissionBps:number, deadline:Date,
 *          chainId?:number, registry?:string}} input
 */
export function shopTicketDigest({ host, seller, commissionBps, deadline, chainId, registry: registryIn }) {
  const registry = String(registryIn ?? config.chain.registryAddress ?? '');
  if (!isAddress(registry)) {
    throw new Error('未配置 MK_REGISTRY_ADDRESS，无法生成开店票据（登记上链是店铺编号的唯一来源）');
  }
  const chain = chainId === undefined || chainId === null ? Number(config.chain.chainId) : Number(chainId);
  if (!Number.isInteger(chain) || chain <= 0) throw new Error(`chainId 非法：${String(chainId)}`);
  const deadlineSec = BigInt(Math.floor(requireDate(deadline, '票据 deadline').getTime() / 1000));
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint16', 'uint64', 'uint256', 'address'],
    [host, seller, commissionBps, deadlineSec, BigInt(chain), registry]
  );
  const inner = ethers.keccak256(encoded);
  const digest = ethers.hashMessage(ethers.getBytes(inner));
  /*
    `innerHash` 是**内层**（诊断与跨端对拍用）——签名方要签的原文就是它，
    而路由下发的是 `digest`（两层）。两个字段指两件事，名字必须如实。
  */
  return { digest, innerHash: inner, registry };
}

/**
 * 验签：摘要（**两层那个值**）+ 签名 → 恢复地址（失败返回 null，**不抛错**——调用方要给出可读拒因）。
 *
 * ⚠️ **必须用 `recoverAddress`（裸恢复），不能用 `verifyMessage`**（2026-10-16 修一个致命缺陷）。
 *
 * 合约那一侧是 `digest.recover(sig)` = `ECDSA.recover(bytes32 digest, sig)` —— 对摘要做**裸恢复**，
 * 不再哈希（前缀已经在 `digest` 里了）。而 ethers 的 `verifyMessage(msg, sig)` 语义是
 * "msg 是**原文**"：它对 32 字节的 msg 会**再哈希一层** ⇒ 与链上要验的不是同一个值。
 * 实测（都是 `digest` = 两层那个值、`sig` = 钱包对**内层**的 personal_sign）：
 *
 *   · `recoverAddress(digest, sig)` → **签名者** ✅（与 `digest.recover` 同一条路径）
 *   · `verifyMessage(digest, sig)`  → 别人 ❌
 *
 * 旧实现用的正是后者 ⇒ **节点算摘要与节点验签互相不自洽**：没有任何钱包能签出让本函数
 * 接受的签名（链上同样必然 `BadSignature`）——整条开店流是死的。之所以长期没被发现：
 * 它在界面上**没有入口**（`/api/shops/applications*` 零调用点），而既有测试也从没写过
 * "签一次再验回来"的往返。现在两个方向都由 `node/test/abi-consistency.test.js` 钉住
 * （fixture 从合约打印）。
 */
export function recoverTicketSigner(digest, signature) {
  try {
    return String(ethers.recoverAddress(String(digest), String(signature))).trim().toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 把链上权威读数合进本地行（**唯一写入点**，由 termsReconciler 调用）。
 *
 * 判据方向只有一条：**链上是真相，本地是镜像**。链上读不到时调用方不得调用本函数
 * （那会把"读不到"写成某个具体结论）。
 *
 * 2026-10-18：删掉 `pending_*` 三个字段（链上已没有提案流程）；现在只镜像
 * "是否在售"与"当前费率"——费率由节点主单方调整（`setShopCommission`），
 * 本地跟着链上走即可，不存在"待决"这一态。
 *
 * **本地编号不可变**：一行店铺只在链上已经有了这家店之后才存在（`code` 就是链上铸造的），
 * 所以旧实现那段"编号从空串回填、顺带把 products/orders 的 shop_code 一起补上"整段删掉了——
 * 现在 `products.shop_code` / `orders.shop_code` 都是**外键**指向 `shops(code)`，
 * 改一个编号会让子表跟着换一家店，而那件事根本不该发生。链上读数与本地编号不一致时
 * 这里抛错（数据完整性事故，由调用方按"这一行不是那家店"处理），不静默改写。
 */
export async function applyChainShop(row, chain) {
  const db = getDb();
  const bps = Number(chain.commissionBps) || 0;
  const nextCode = String(chain.code || '');
  if (nextCode && nextCode !== row.code) {
    throw new Error(
      `链上店铺编号 ${nextCode} 与本地这一行的 ${row.code} 不一致（seller=${row.seller}）：` +
        '编号是链上铸造的、建行时就写死了，改它等于把本地这一行换成另一家店。请核对链上登记与本地库，不要在本函数里改编号。'
    );
  }
  /*
    `exited_at_block` 是**墓碑镜像**（链上 `ShopInfo.exitedAtBlock`）：>0 = 店主已退出。
    它必须落库：reconciler 读到退出时要写 `listed=0`，而"能不能重新开店申请"也要靠它区分
    "已退出（可重开）"与"只是被暂停（不能另开一家）"。仅凭 listed=0 分不开这两档。
  */
  const exitedAtBlock = Number(chain.exitedAtBlock) || 0;
  await db.run(
    `UPDATE shops SET commission_bps = ?, listed = ?, registered_at_block = ?, exited_at_block = ?,
       synced_at = ?, updated_at = ? WHERE seller = ?`,
    bps,
    chain.listed ? 1 : 0,
    Number(chain.registeredAtBlock) || 0,
    exitedAtBlock,
    new Date(),
    new Date(),
    row.seller
  );
  return shopRowBySeller(row.seller);
}
