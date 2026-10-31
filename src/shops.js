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
 * ## 店铺是**节点链下**的事实
 *
 * 平台 Registry 只登记节点（operator/escrow/staking/endpoint），**没有店铺**、没有店里员工名单、
 * 没有费率。店铺由店主向本节点申请、节点主/员工审批后由本节点铸造编号并插入 `shops` 行
 * （见 routes/shops.js）。因此：
 *   · `shops.code` 是**本节点**铸造的 9 位编号（src/ids.js 的 `newShopCode`），不是链上返回值；
 *   · 没有"链上镜像"字段（registered_tx / registered_at_block / exited_at_block / synced_at 全部删除）；
 *   · `listed` 是**节点侧**唯一开关（节点主/员工暂停），不是任何链上状态的镜像。
 *
 * ## 店铺句柄（X-Mk-Shop 头）只有一种拼写
 *
 * **店铺编号**（9 位 Crockford Base32，带加权校验位）。一家店先被本节点批准、才有这一行、
 * 才有编号。`shops.code` **恒非空**，于是"编号为空的那一行"这一整类分支——鉴权、订单归属、
 * 存储键、文件归属、可售判据——全部消失。
 *
 * ## 节点主（旧称 host）住在 `node` 表，不在 `shops`
 *
 * `shops` 那一列 `host` 已随重设计删除：**一个库就是一个节点**，所有店铺行再各存一份
 * "本店挂在谁那儿"就是同一事实的 N 份副本（而副本必然漂移）。节点主地址的唯一家是
 * `node.owner`（单例行），本模块的 `nodeRow()/nodeOwner()` 是读它的唯一入口；
 * 对外 DTO 里的 `host` 都从那一行现算，本地不留第二份。
 * 节点的对外名称/公告同样住那一行（`node.name` / `node.notice`）——它不是"某家店的名字"。
 *
 * ## listed 的口径（最容易被误读的一条）
 *
 * `listed = 0` 只意味着**不能接单 + 不进前端聚合**（节点主/员工暂停）。
 * 它**不是**"店下线"：该店的发货、同意/拒绝退款、售后案件、个人信息擦除、自有资料维护
 * **全部照常可用**。把 listed=0 做成"拒绝一切卖家面请求"会让店主在被暂停之后连已托管的单子
 * 都没法处理。落实方式：只有**影响未来销售**的动作（上架/改价/码池与 token 池导入、建单）
 * 检查 `assertSellable`，履约类动作一律不检查。
 */
import { DEFAULT_NODE_NAME, resolveNodeDomain } from './config.js';
import { getDb } from './db.js';
import { isAddress, isZeroAddress } from './chain.js';
import { tanxinAddressOf } from './tanxin.js';
import { isShopCodeShape } from './shopCode.js';

/** 店铺句柄的请求头（卖家面的**范围提示**：带了必须指得中；不带则取唯一经营的那家，多店时必须点名——见 http.js） */
export const SHOP_HEADER = 'x-mk-shop';

/**
 * 是不是一个**形状合法**的店铺编号（**唯一实现**：./shopCode.js）。
 * 只判形状、不判存在；编码/解析入口用 `verifyShopCode`（含校验位）。
 */
export { isShopCodeShape };

/* ─────────────────────────── 节点单例（node 表）─────────────────────────── */

/**
 * 节点主的**同步投影**（进程内缓存，初值空串）。
 *
 * `node.owner` 是唯一真相（`node` 单例行，由 `db.js` 的 `initDb()` 种入并在每次启动时按
 * `MK_SHOP_OWNER` 刷新），但它只能异步读；而少数同步上下文（`hostOperator()`）需要那个地址。
 * 这里只缓存**那一个身份**：`nodeRow()` 每次调用都会刷新它，而它在一次进程生命周期内不会变
 * （换节点 operator = 换一台机器）。所以"缓存"不会变成第二份真相——它只是同一行的同步投影。
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
 * 仅服务同步调用点（把 `node` 行已经读出来的路由不必为同一个值再查一次库）。
 * 要在**判定**里用节点主身份（鉴权）请走 `auth.isHost()`。
 * ⚠️ 它在**任何一次 `nodeRow()` 之前**是空串，所以 `server.js` 在 `initDb()` 之后立刻读一次
 * 那一行（唯一的暖机点）。
 */
export function hostOperator() {
  return cachedNodeOwner;
}

/* ─────────────────────────── 店铺行 ─────────────────────────── */

/**
 * 展示用**店名**（**唯一实现**；DTO 与设置页共用）。
 *
 * 没有默认名：店名是店铺在目录里的身份，两条写入口（开店申请、店铺资料编辑）
 * 都拒绝空名，所以"没有名字的店"在接口层不可达。
 * ⚠️ 节点名走 `nodeDisplayName()`：节点与店铺是两个实体，默认名也各是各的。
 */
export function shopDisplayName(row) {
  return String(row?.name || '');
}

/**
 * 展示用**节点名**（**唯一实现**；健康检查、公开 DTO 与设置页共用）。
 *
 * 回退顺序：`node.name` → 节点自己的对外域名（`MK_SIWE_DOMAIN` / `MK_REGISTER_ENDPOINT`，
 * 也就是链上登记 endpoint 的同一个身份）→ 中性占位 `DEFAULT_NODE_NAME`。
 * 没有域名（内网/裸机）时不编造——**绝不回退成店铺默认名**。
 */
export function nodeDisplayName(row) {
  const v = String(row?.name || '');
  if (v !== '') return v;
  return resolveNodeDomain()?.domain || DEFAULT_NODE_NAME;
}

/** 展示用公告（**唯一实现**；`''` = 没设置过） */
export function shopDisplayNotice(row) {
  return String(row?.notice || '');
}

/**
 * 一行 shops → 对外形状（**唯一一份**：公开列表、店铺详情、卖家面板共用）。
 *
 * `nodeAddr` = 节点主地址（`hostOperator()` 或 `await nodeOwner()`）。它是"这家店挂在哪台机器下"
 * 的答案（一库一节点，所有店铺同值），联邦目录靠它把店铺与节点对上——店铺自己不再存一份。
 */
export function shopDto(row, nodeAddr) {
  if (!row) return null;
  const node = String(nodeAddr || '').trim().toLowerCase();
  return {
    code: row.code || '',
    seller: row.seller,
    host: node || null,
    name: shopDisplayName(row),
    notice: shopDisplayNotice(row),
    tanxinAddress: tanxinAddressOf(row),
    listed: Number(row.listed) === 1,
    /** 暂停原因（`''` = 当前没有暂停）；店主在设置页读它，节点管理面在店铺行读它 */
    listedReason: String(row.listed_reason || ''),
    /**
     * 最近一次切换接单状态的时刻：**只在暂停时下发**（在售店的公开行不暴露内部处置时间；
     * 暂停店本来就不进公开聚合面，只有店主与节点管理员读得到）。
     */
    listedAt: Number(row.listed) === 1 ? null : (row.listed_at ?? null),
  };
}

/** 全部店铺行（按开店顺序） */
export async function listShopRows() {
  return await getDb().all('SELECT * FROM shops ORDER BY created_at ASC, code ASC');
}

/**
 * 节点管理面的店铺行：全部店铺 + 三个按店聚合的商品读数。
 *
 * 只给 `nodeAdmin` 用：`hidden_product_count` 是节点处置的读数，不是买家该看到的经营数据。
 * 三个 COUNT 放在同一句里（相关子查询各走一次 `idx_products_shop`），避免逐店 N+1。
 */
export async function listShopRowsWithCounts() {
  return await getDb().all(`SELECT s.*,
         (SELECT COUNT(*) FROM products p WHERE p.shop_code = s.code) AS product_count,
         (SELECT COUNT(*) FROM products p
           WHERE p.shop_code = s.code AND p.active = 1 AND p.node_hidden = 0) AS listed_product_count,
         (SELECT COUNT(*) FROM products p
           WHERE p.shop_code = s.code AND p.node_hidden = 1) AS hidden_product_count
       FROM shops s ORDER BY s.created_at ASC, s.code ASC`);
}

/** 只出**在售**店铺（公开聚合面用；listed=0 的店不进聚合） */
export async function listListedShopRows() {
  return await getDb().all('SELECT * FROM shops WHERE listed = 1 ORDER BY created_at ASC, code ASC');
}

/**
 * 按编号读一行（读不到返回 undefined；调用方按"没有这家店"处理，**不猜**）。
 *
 * `code` **恒非空**：一行店铺只在审批通过时被本节点铸造编号后写入。空值因此就是"没给编号"。
 */
export async function shopRowByCode(code) {
  const c = String(code ?? '').trim();
  if (!c) return undefined;
  return await getDb().get('SELECT * FROM shops WHERE code = ?', c);
}

/** 批量版（订单列表用）：一次读回本页所有店铺行，返回 `code → row`。 */
export async function shopRowsByCodes(codes) {
  const list = [...new Set((codes || []).map((x) => String(x ?? '').trim()).filter(Boolean))];
  if (!list.length) return new Map();
  const placeholders = list.map(() => '?').join(',');
  const rows = await getDb().all(`SELECT * FROM shops WHERE code IN (${placeholders})`, ...list);
  return new Map(rows.map((r) => [String(r.code), r]));
}

/** 按店主地址读一行（大小写由列的排序规则折；读不到返回 undefined） */
export async function shopRowBySeller(seller) {
  const s = String(seller || '').trim().toLowerCase();
  if (!isAddress(s)) return undefined;
  /*
    写入侧一律小写落库（`shops.seller` 的不变量，与 orders.seller / products.shop_code 同规约）。
    ⚠️ **地址类列是大小写敏感的**（`utf8mb4_0900_as_cs`）：在 as_cs 下，大小写不同的两行是
    **两个不同的键**，所以"写入侧一律小写"是**唯一的不变量**、不是可以靠排序规则兜住的安全网。
    函数包住列会让 `uq_shops_seller` 用不上——每次鉴权都变成全表扫描，所以保持裸等值。
  */
  return await getDb().get('SELECT * FROM shops WHERE seller = ?', s);
}

/**
 * 店铺句柄 → 一行店铺（**唯一实现**）。
 *
 * 句柄只有一种拼写：**店铺编号**。查不到一律返回 `null`，
 * **绝不回退到"本节点唯一那家店"**——那会让一个抄错的编号静默打开别人家的店。
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
 * 只有一个来源：`listed` 列——本节点唯一的开关（节点主/员工暂停）。
 */
export function shopSellable(row) {
  if (!row) return false;
  return Number(row.listed) === 1;
}

/** 不能卖时的可读拒因（**唯一一份文案**：下单闸与商品闸共用，避免两处各说一句） */
export function notSellableReason() {
  return '该店铺已暂停接单（被节点主/节点员工暂停）；在途订单不受影响';
}

/**
 * "影响未来销售"的动作的统一闸（**唯一实现**）：上架商品、改价、导入码池/token 池、
 * 建新订单都要过它。返回 null 表示放行，否则返回可读拒因。
 *
 * ⚠️ 它**只该**挂在这类动作上。发货、同意/拒绝退款、售后案件、PII 擦除、店铺资料维护
 * **一律不检查** `listed`：`listed = 0` 只是"暂停接单 + 退出聚合"，不是"店下线"。
 */
export function sellableError(row) {
  return shopSellable(row) ? null : notSellableReason(row);
}

/**
 * **商品自身可售**的 SQL 判据（唯一实现；`alias` 为空时用裸列名）。
 *
 * 两个条件缺一不可：店主侧 `active`（愿意卖）与节点侧 `node_hidden=0`（允许卖）。
 * 它回答的是"这件商品能不能成交"，不回答"这家店能不能接单"——后者由
 * `productPublicSql` 里的店铺子查询、以及建单闸的 `sellableError` 分别回答。
 * 新增一个"公开可见"查询却漏掉 node_hidden，就是给节点处置留了一个后门（商品被下架了还能搜到/下单）。
 */
export function productSellableSql(alias = '') {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  return `${col('active')} = 1 AND ${col('node_hidden')} = 0`;
}

/** **公开可见商品**的完整 SQL 判据：商品可售 + 所属店铺当前接单（两个正交判据的唯一拼法）。 */
export function productPublicSql(alias = '') {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  return `${productSellableSql(alias)} AND ${col('shop_code')} IN (SELECT code FROM shops WHERE listed = 1)`;
}
