/**
 * 商品路由（本节点 = 一家店，商品由店主维护）。
 *
 *  GET    /api/products            公开分页列表（附汇率快照，供前端换算展示）
 *  GET    /api/products/:slug      公开详情（含快照字段，买家可本地校验 snapshotHash；已下架商品匿名 404，仅 staff 登录可预览）
 *  POST   /api/products            店主/操作员（staff）上架（SIWE Bearer）
 *  PATCH  /api/products/:slug      店主/操作员（staff）更新/上下架
 *  POST   /api/products/:slug/codes        店主/操作员导入兑换码池 {codes: string[]}（staff，数字商品）
 *  GET    /api/products/:slug/codes        店主/操作员查看码池 {status? cursor?}（码为敏感资源，staff 可读——处理退款/对码需要；读取入审计）
 *  DELETE /api/products/:slug/codes/:id    店主/操作员（staff）删除单个未用码
 *  DELETE /api/products/:slug/codes        店主清空整个码池（ownerOnly；?confirm=1；只删未用码——已用行是"永不复用"的墓碑）
 *  POST   /api/products/:slug/tokens       店主/操作员（staff）导入 NFT 交付池 {tokens: string[]}（NFT 商品）
 *  GET    /api/products/:slug/tokens       店主/操作员查看 NFT 交付池 {status? page?}（读取入审计）
 *  DELETE /api/products/:slug/tokens/:id   店主/操作员（staff）删除单个未用 tokenId
 *  DELETE /api/products/:slug/tokens       店主清空整个交付池（ownerOnly；?confirm=1；含已交付记录——凭证在交付子表不受影响）
 *
 * 码池模型：数字商品由卖家导入一批兑换码；发货时若未手动填交付内容，
 * orders 发货流程自动分配一个未用码（事务防重）。码池对公开接口完全不可见，
 * 仅 staff（店主/操作员）令牌可读写；订单交付后买家经订单接口按身份可见。
 * `product_codes.order_id` 是**内部外键**（orders.id，NULL = 未分配），下发给店主的是对外订单号（见 GET 的说明）。
 *
 * NFT 交付池模型：NFT 商品（kind='nft'，nft_contract=合约地址、nft_standard=erc721/erc1155）
 * 由卖家导入一批 tokenId 作为交付库存（每行一个：十进制 / 0x hex / a-b 范围展开）；发货由卖家在钱包
 * 把池内 NFT 转给买家后提交 tokenId+txHash，节点按 nft_standard 核验链上转账事件后置 shipped（见 orders.js）：
 * erc721 兼容 ERC721A 的 Transfer 单枚事件；erc1155 支持 TransferSingle 与 TransferBatch（批量一次多枚），
 * 同 tokenId 多份（value>1 或批量重复 id）不支持（每件 = 一个独立 tokenId 恰一份）。
 * 池空时新订单被拦截（视为售罄）；池内 tokenId 对公开接口不可见，仅 staff（店主/操作员）令牌可读写。
 *
 * ── 快照哈希算的是**读回值**（2026-10-16 MySQL 重设计的核心约束）─────────────
 * 商品侧的结构化字段（description_blocks / media / specs / attributes / terms）现在是**真 JSON 列**，
 * 而 MySQL 的 JSON 类型会**规范化**：对象键按键长/字节重排、去掉空白差异、重复键去重。
 * 于是"写进去的字节"与"读回来的字节"不是同一份，而快照哈希认的必须是**买家能读到的那一份**：
 *   · 哈希**只在读回之后**算（`refreshSnapshotHash`）：三个写入口落库后先读回整行 + SKU 行，
 *     再按固定键序序列化取 keccak256。拿提交的载荷直接算，会让每个买家都看到假的
 *     「商品内容已被修改」——前端/订单复算的都是读回值。
 *   · DTO 与快照**共用同一批投影函数**（parseBlocks / parseMediaColumn / parseSpecsColumn /
 *     parseAttributesColumn / parseTermsColumn）：JSON 内容里的键序只有一处定义，
 *     否则"页面显示的"与"哈希锁住的"会各说一套。
 *   · 订单上的 `product_snapshot` 仍是 MEDIUMTEXT（字节精确，见 db.js 的说明），
 *     由 orders.js 用同一个 `snapshotObject` 序列化 ⇒ "哈希"与"存下的那份字节"天然一致。
 *
 * **快照契约（唯一权威顺序）**：
 *   slug / title / description / description_blocks / media / kind /
 *   shipping_fee_usdt_micro / age_restricted / specs / skus / attributes / terms / sku_images
 *   kind='nft' 时再追加 nft_contract、nft_standard（nft_contract 在前）。
 *   追加/改动键必须在**同一位置**同时改本文件与前端 utils/snapshot.ts，
 *   否则每个买家都会看到假的「商品内容已被修改」告警。
 *   运费与年龄限制必须在快照里：否则店主可以在买家下单前事后加价运费、
 *   或把限制商品悄悄摘掉限制，而买家手上的哈希不变。
 *   主图区（media）同样必须在快照里：它就是买家看到的商品本身，
 *   事后换一张图/换一段视频而哈希不变，等于主图可被无声替换。
 */
import { Router } from 'express';
import { ethers } from 'ethers';
import config from '../config.js';
import { getDb, withTransaction, abortTx } from '../db.js';
import { getRates } from '../rates.js';
import { verifyToken } from '../auth.js';
import { isAddress, isZeroAddress, blockedProductSlugs } from '../chain.js';
import { ok, fail, wrap, makeAuthMiddleware, bearerToken, listedShopScope } from '../http.js';import { productReviews, productReviewSummary } from '../reviews.js';
import { logAudit } from '../audit.js';
import { roleOf, isStaff } from '../auth.js';
// 店铺判据（"能不能卖"的唯一实现与唯一文案）：上架/改价/导池的闸都接它
import { sellableError, notSellableReason, shopRowByCode } from '../shops.js';
import { newProductSlug } from '../ids.js';
import { normalizeBlocks, deriveDescription, parseBlocks } from '../describeBlocks.js';
import { tryAutoDeliverPendingForProduct } from '../autoDeliver.js';
// 金额展示口径的唯一实现（usdtOf）——不要再手写 (micro/1e6).toFixed(2)
import { usdtOf } from '../money.js';
// 「这一单还占着库存」的唯一谓词（2026-10-14）：改名守卫与 willRestrict 的补记核算共用它，
// 不再各自拼状态白名单——状态集每加一个终态就会漏一次，而漏的后果是超卖。
import { stockPromiseSql, uncommittedPromiseSql } from '../stockHold.js';
// 商品标签（类目）的键/展示形/归一化 —— **唯一实现**（两个写入入口、列表筛选与标签清单共用，见 src/tags.js 文件头）
import { assertParsedJsonColumn, cleanLabel, normalizeTags, parseTagsColumn, tagKeyOf } from '../tags.js';
// 商品参数（键值对）与商品级承诺（受控枚举 + 数字）—— **各自唯一实现**，两个写入入口共用
import { attrPairOf, normalizeAttributes, parseAttributesColumn } from '../attributes.js';
import { EMPTY_TERMS, normalizeTerms, parseTermsColumn } from '../productTerms.js';
// 主图区（图片 + 视频）的字节判据、上限与 URL 规则 —— **唯一实现**（与前端共用同一份常量）
import {
  MAX_MEDIA_ITEMS,
  MAX_VIDEO_ITEMS,
  UPLOAD_URL_PREFIX,
  mediaUrlAllowed,
  normalizeMediaUrl,
} from '../mediaKinds.js';

/*
  价格与运费的闸门（**微 USDT**，1 USDT = 1e6）。

  单价上限 **1e13 微 = 1e7 USDT**。这个数不是随手取的：
  订单与商品金额一律用 JS `Number` 承载，而 `Number.MAX_SAFE_INTEGER` 是 9.007e15
  （db.js 的 `ck_orders_money` / `ck_skus_price` 把这条上界写进了 schema：读不回来的值在库里根本存不下）。
  一单最多 99 件（`orders.quantity` CHECK 1..99）、运费最多 1e9 微 ⇒ 最坏合计 = 单价 × 99 + 运费；
  取 1e13 时最坏 9.9e14，离 9.007e15 还有 9 倍余量（改这个常量前先读 routes/orders.js 的同名兜底闸）。

  运费上限 1e9 微 = 1000 USDT。
*/
export const PRICE_MAX_MICRO = 10_000_000_000_000; // 1e7 USDT
export const SHIPPING_FEE_MAX_MICRO = 1_000_000_000; // 1000 USDT
/** 给店主看的单价上限（USDT 整数串；报错文案里不要直接甩 1e13 这种微整数） */
const PRICE_MAX_USDT = '10000000';

/**
 * 插入 `products` 时 `snapshot_hash` 的占位值。
 *
 * 真值必须在**读回之后**才算得出来（JSON 列由 MySQL 规范化，见文件头），所以先写空串，
 * 再由 `refreshSnapshotHash` 在**同一个事务**里覆盖它——事务提交时它一定已经是 66 位哈希
 * （列是 `CHAR(66) NOT NULL`，空串只是这条语句到那条语句之间的一个瞬间，且失败即整体回滚）。
 */
const SNAPSHOT_HASH_UNSET = '';

/**
 * 「首次上架时刻」的**唯一拼法**（三个写入口共用同一段 SQL）。
 *
 * 规则（三态在这一行里闭合，见 PATCH 的说明）：
 *   · 已有值 ⇒ 永远保留（它回答"有没有发布过"，不是"最后一次上架"）；
 *   · 没有值且本次在售 ⇒ 由**服务器**盖章（`CURRENT_TIMESTAMP(3)`）；
 *   · 没有值且本次未上架 ⇒ 保持 NULL（还没发布过）。
 * 为什么是 SQL 而不是 JS 算一个毫秒数传进来：时间是 `DATETIME(3)`，服务器盖章就不受应用端时钟影响，
 * 也不用担心"把毫秒整数当时间传进去"（MySQL 会照数字字面量解析，写进一个荒谬的时间且不报错）。
 */
const PUBLISHED_AT_FIRST = 'IF(?, CURRENT_TIMESTAMP(3), NULL)';
const PUBLISHED_AT_KEEP = 'COALESCE(published_at, IF(?, CURRENT_TIMESTAMP(3), NULL))';

/** 管理审计便捷包装（仅 staff 记录；detail 不含码原文/收货地址）
 *  ⚠️ `roleOf` 是 async（要读店铺行与店员白名单），本包装因此也是 async：调用方**必须 await**。
 *  归属恒为本店（`req.shop.code`，由鉴权中间件解析、`requireShopProduct` 已校验过商品属于它）：
 *  商品经营面的每一个入口都是"本店"的动作。 */
const audit = async (req, action, targetType, targetId, detail) =>
  logAudit({
    req,
    actor: req.auth?.address,
    // 角色取**这家店**里的角色：多店之后同一地址在不同店里身份可以不同，
    // 而"他在哪家店、以什么身份上架/改价"正是审计要回答的问题
    actorRole: await roleOf(req.auth?.address || '', req.shop.code),
    shopCode: req.shop.code,
    action,
    targetType,
    targetId,
    detail,
  });

const router = Router();
const staffOnly = makeAuthMiddleware(verifyToken, { staffOnly: true }); // P1-⑤：商品经营面=店主+店员
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true }); // 池清空/敏感资源批量作废=仅店主

/**
 * 卖家面按 slug 取商品行 —— **唯一入口**（取行 + 归属校验 + 写动作的"能不能卖"闸一起做）。
 *
 * 为什么必须收成一处：多店之前"按 slug 取行"就够（一个节点只有一个卖家），多店之后
 * 每个卖家面入口都要回答"这件商品是不是**本店**的"，而把这条判断抄在 10 个调用点上
 * 必然漏一个——新增一个入口就多一个漏点，且漏掉时的表现是"操作成功了"，没有任何报错。
 *
 * 判据是 `products.shop_code == req.shop.code`（后者由鉴权中间件解析出来：请求头指的那家，
 * 或这个地址唯一经营的那家——单店卖家不必带请求头，多店则必须点名，见 http.js）。
 * 失败时**已经把响应写出去**，调用方只需 `if (!x) return;`。
 * 读不到与不属于本店刻意给**不同**的结论（404 / 403）：前者是标识抄错了，后者是越权——
 * 混成一个会让排查方向错掉。
 *
 * ## 写动作的闸也在这里（2026-10 收口）
 *
 * `PATCH /:slug`、`POST /:slug/codes`、`POST /:slug/tokens` 三个写入口此前各自忘挂
 * `requireSellable`，于是同一件事（改价/备货）在上架与批量入口被拒、在这里成功。
 * 闸按方法下沉到**唯一的取行函数**：新增一个写入口只要用 `requireShopProduct`，
 * 就自动带上"暂停接单的店铺不能影响未来销售"这条判据——不需要记得再补一行。
 * `GET` 刻意不过闸：码池/交付池的**读取**是店主处理退款、对码所需的履约动作，
 * `listed = 0` 只是暂停接单，不是店下线（见 shops.js 的说明）。
 */
async function requireShopProduct(req, res) {
  const row = await getDb().get('SELECT * FROM products WHERE slug = ?', String(req.params.slug || ''));
  if (!row) {
    fail(res, '商品不存在', 404, 404);
    return null;
  }
  if (String(row.shop_code) !== String(req.shop.code)) {
    fail(res, '该商品不属于本店', 403, 403);
    return null;
  }
  if (req.method !== 'GET' && !requireSellable(req, res)) return null;
  return row;
}

/**
 * "影响未来销售"的动作的统一闸（上架/改价/导池）。
 * 判据与文案都来自 `src/shops.js` 的 `sellableError`（唯一实现）——这里只把它接到响应上。
 * ⚠️ **不要**给履约类动作（发货/退款/售后）加这道闸：`listed = 0` 只是暂停接单、退出聚合，
 * 不是店下线，店主必须还能处理已经托管的单子（合约注释与 PRODUCT_BOUNDARIES 都写明了）。
 */
function requireSellable(req, res) {
  const why = sellableError(req.shop);
  if (why) {
    fail(res, why, 403, 403);
    return false;
  }
  return true;
}

// ── 快照与展示 ──

/**
 * 快照里的非负整数列归一：缺字段（手搓的行对象）/脏数据一律归 0。
 * 归一在这里（而不是只在写入路径）是刻意的——`computeSnapshotHash` 会丢掉
 * `undefined` 键，若只在写入时归一，任何手搓快照对象算出的哈希都会与库里的值不同，
 * 于是"校验失败"变成噪音而不是信号。前端 `utils/snapshot.ts` 的 `shipMicro` 是同一条归一。
 */
function snapshotNonNegInt(v) {
  const n = Number(v ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * 解析库里的主图区（`products.media`，JSON 列）→ 数组。
 *
 * **刻意不做归一、不清洗、不补默认值**：快照哈希认的就是库里存的那一份字节，
 * 任何"顺手规整"都会让 DTO 与快照算出的哈希不一致（买家看到假的「商品内容已被修改」）。
 * 形状的保证在写入路径（`validateProduct` 的 media 分支），不在这里。
 * （传进来一个字符串要报错：那是列原文，不是读回值——见 `assertParsedJsonColumn`。）
 */
function parseMediaColumn(raw) {
  const v = assertParsedJsonColumn(raw, 'products.media');
  return Array.isArray(v) ? v : [];
}

/** 快照规范化字段（顺序固定，勿改动）：
 *  slug / title / description / description_blocks / media / kind /
 *  shipping_fee_usdt_micro / age_restricted / specs / skus / attributes / terms / sku_images；
 *  kind='nft' 时追加 nft_contract、nft_standard（nft_contract 在前）。
 *
 *  价格不在商品级 —— 每个组合的单价都在 skus 里（[[sku_key, price_usdt_micro], …] 按 key 升序），
 *  买家据此核验「所选规格的价格」没有被事后改动。
 *  运费（shipping_fee_usdt_micro）与年龄限制（age_restricted）**必须**在快照里：
 *  前者是钱（事后加价运费等于改价），后者是商品属性（上架后静默增删限制，买家无从察觉）。
 *  主图区（media）**必须**在快照里：它是买家看到的那件商品本身。
 *
 *  ── 2026-10-15 新增的三键（attributes / terms / sku_images），判据是同一条 ──
 *  「**买家据以付款的东西必须被哈希钉住**」：
 *   · attributes   = 这件货**是什么**（成色/材质/产地/型号/批次/保质期）——"货不对板"争议的对照物；
 *   · terms        = 店主**承诺了什么**（多久发出/退换规则/退换窗口/退货运费谁承担）——
 *                   本商城的裁决不做事实调查，条款不进快照就等于没有客观判据；
 *   · sku_images   = **所选规格**的那张图（选"黑色"看到的那张）——事后换图而哈希不变即所见非所得。
 *  三者都**恒存在**（没有时是 `[]` / 空承诺对象，不是缺键）：键的存在性不再承担版本语义，
 *  唯一的例外仍是 NFT 两键（它们的键存在性 = kind='nft'，语义来自商品类型而不是契约版本）。
 *
 *  ⚠️ 入参必须是**读回的整行**（`SELECT *` 的结果，JSON 列已由驱动解析）+ 挂上的 skus
 *  （`withSkus` / `loadSkus`）。三个写入口都经 `refreshSnapshotHash` 走这条路。
 */
export function snapshotObject(row) {
  const skuRows = Array.isArray(row.skus) ? row.skus : [];
  const sortedSkus = [...skuRows].sort((a, b) => (a.sku_key < b.sku_key ? -1 : a.sku_key > b.sku_key ? 1 : 0));
  const snap = {
    slug: row.slug,
    title: row.title,
    description: row.description,
    // 详情块是商品详情的**权威内容**，必须入快照 —— 否则店主事后往说明里插一张图，
    // 买家手上的哈希不变，等于详情可被无声篡改。
    description_blocks: parseBlocks(row.description_blocks),
    // 主图区（图片 + 视频，顺序即展示顺序）。**逐字入快照**：元素里的 url/poster 就是
    // 校验输入，展示层的绝对化改写绝不允许回写到这里（见前端 utils/media.ts 的解析函数）。
    media: parseMediaColumn(row.media),
    kind: row.kind,
    // 运费（微 USDT，按单收取一次；0=包邮）——买家据此核验「锁定的运费」没被事后改价
    shipping_fee_usdt_micro: snapshotNonNegInt(row.shipping_fee_usdt_micro),
    // 年龄限制（0/1）——买家据此核验「下单那一刻这件商品是否声明了未成年人禁止购买」
    age_restricted: row.age_restricted ? 1 : 0,
    specs: parseSpecsColumn(row),
    skus: sortedSkus.map((s) => [s.sku_key, s.price_usdt_micro]),
    // 商品参数：逐条入快照（顺序 = 店主书写顺序，与库里一致；投影只有 parseAttributesColumn 一处）
    attributes: parseAttributesColumn(row.attributes),
    // 承诺：**归一后**入快照（`parseTermsColumn` 只做形状兜底，不重新校验——判据在写入路径）
    terms: parseTermsColumn(row.terms),
  };
  /*
    SKU 图单独一键（而不是把 `skus` 的二元组改成三元组）：
    二元组是"所选规格的锁定价"这条核验的既有形状，商品快照的消费方（仲裁台按 key 反查锁定价）
    都按 `[key, price]` 解构；把图塞进同一个元组会让**所有**按位置解码的地方同批改一遍，
    而它们中的多数根本不关心图。独立键按 key 关联，读图的地方自己查一次即可。
  */
  snap.sku_images = sortedSkus.filter((s) => s.image_url).map((s) => [s.sku_key, String(s.image_url)]);
  if (row.kind === 'nft') {
    /*
      两键的归一必须与前端 `productToSnapshot` 逐字一致（那里是 `p.nftContract ? … : ''`
      与 `p.nftStandard || 'erc721'`）。
      库里 `ck_products_nft` 保证 kind='nft' 时 nft_contract 非空，所以 `|| ''` 只为
      **手搓的行对象**存在；取值与前端相同才不会让同一件商品在两端算出不同的哈希
      （"节点说被改过、前端说没改"是这条契约最贵的失败形态）。
    */
    snap.nft_contract = String(row.nft_contract || '').toLowerCase();
    snap.nft_standard = row.nft_standard === 'erc1155' ? 'erc1155' : 'erc721';
  }
  return snap;
}

/** 规范化 JSON（UTF-8）→ keccak256（0x hex，与 Solidity keccak256 一致）。入参为规范化对象 */
export function computeSnapshotHash(snap) {
  const o = {
    slug: snap.slug,
    title: snap.title,
    description: snap.description,
    description_blocks: snap.description_blocks,
    // 主图区**逐字透传**：元素里的 url/poster 不在这里归一/补默认值 ——
    // 快照哈希算的是"服务端存的那一份"，任何就地改写都会让两端算出不同的哈希。
    media: snap.media,
    kind: snap.kind,
    // 与 snapshotObject 同键同位（契约：见文件头快照契约）。手搓对象缺这两键时归一为默认值，
    // 保证「同一件商品」无论经哪条路径规范化都得到同一个哈希。
    shipping_fee_usdt_micro: snapshotNonNegInt(snap.shipping_fee_usdt_micro),
    age_restricted: snap.age_restricted ? 1 : 0,
    // 价格不在商品级：每个组合的单价都在 skus 里（[[sku_key, price_usdt_micro], …]，按 key 升序）
    specs: snap.specs,
    skus: snap.skus,
    /*
      下面三键与 snapshotObject 同键同位。**逐字透传**（不在这里补默认值）：
      缺键时补成 `[]`/空承诺会让"手搓对象"与"库里那一份"算出同一个哈希——
      听起来无害，实则把"这份快照丢了字段"这件事从哈希里抹掉（哈希就不再是完整内容的承诺）。
      写入路径保证它们恒存在（snapshotObject 恒产出这三键），所以缺键只可能来自测试手搓对象。
    */
    attributes: snap.attributes,
    terms: snap.terms,
    sku_images: snap.sku_images,
  };
  if ('nft_contract' in snap) {
    o.nft_contract = snap.nft_contract;
    o.nft_standard = snap.nft_standard;
  }
  const canonical = JSON.stringify(o);
  return ethers.keccak256(ethers.toUtf8Bytes(canonical));
}

/**
 * 重算并写回 `products.snapshot_hash` —— **唯一实现**（上架 POST / 编辑 PATCH / 批量 PATCH 三处共用）。
 *
 * 为什么是"先写库、再读回来算"（而不是拿提交的载荷算）：
 * 商品侧的 JSON 列由 MySQL 规范化（对象键重排、去空白），**写进去的字节不是读回来的字节**，
 * 而买家/前端/订单复算的都是读回值（见文件头）。拿载荷算出来的哈希与 DTO 复算的结果不同，
 * 症状是每个买家都看到假的「商品内容已被修改」。
 *
 * 代价如实写：每次写入多两次读（整行 + SKU 行）与一次 UPDATE。换来的是"哈希的定义只有一处、
 * 且它就是买家能读到的那一份"——比省一次往返重要得多。
 *
 * ⚠️ 必须在**调用方的事务内**调用（三个写入口都在 `withTransaction` 里）：
 * 写与算之间若插进另一次编辑，写下去的哈希描述的就是另一份内容。
 * @returns {Promise<string>} 本次写回的哈希
 */
async function refreshSnapshotHash(productId) {
  const db = getDb();
  const row = await db.get('SELECT * FROM products WHERE id = ?', productId);
  if (!row) throw new Error(`商品不存在（id=${productId}）：无法重算快照哈希`);
  const hash = computeSnapshotHash(snapshotObject({ ...row, skus: await loadSkus(productId) }));
  await db.run('UPDATE products SET snapshot_hash = ? WHERE id = ?', hash, productId);
  return hash;
}

// ══ SKU（规格组合）═══════════════════════════════════════════════════
// 模型：**每个商品恒有 ≥1 个组合**。无规格商品就是「只有一个 sku_key='' 的组合」，
// 因此全链路只有一条代码路径，不存在 if (有规格) 的分叉。

/** 规格定义规范化：[{ name, options[] }]，最多 3 维、每维 2..20 个选项 */
function normalizeSpecs(input) {
  const errors = [];
  if (input === undefined || input === null) return { errors, specs: [] };
  if (!Array.isArray(input)) {
    errors.push('specs 需为数组（[{ name, options: [] }]）');
    return { errors, specs: [] };
  }
  if (input.length > 3) {
    errors.push('规格最多 3 个维度（如 颜色 / 尺寸 / 材质）');
    return { errors, specs: [] };
  }
  const specs = [];
  const names = new Set();
  for (const rawSpec of input) {
    const name = String(rawSpec?.name ?? '').trim();
    if (!name || name.length > 20) {
      errors.push('规格名必填且不超过 20 字符');
      continue;
    }
    if (names.has(name)) {
      errors.push(`规格名重复：${name}`);
      continue;
    }
    names.add(name);
    const rawOpts = Array.isArray(rawSpec?.options) ? rawSpec.options : [];
    const options = [...new Set(rawOpts.map((o) => String(o).trim()).filter(Boolean))];
    if (options.length < 2) {
      errors.push(`规格「${name}」至少需要 2 个选项`);
      continue;
    }
    if (options.length > 20) {
      errors.push(`规格「${name}」最多 20 个选项`);
      continue;
    }
    if (options.some((o) => o.length > 20)) {
      errors.push(`规格「${name}」的单个选项名不超过 20 字符`);
      continue;
    }
    specs.push({ name, options });
  }
  return { errors, specs };
}

/** 规格的全部组合（笛卡尔积）；specs 为空返回 [{}]（无规格商品的唯一组合） */
export function skuCombos(specs) {
  if (!specs.length) return [{}];
  return specs.reduce((acc, s) => acc.flatMap((combo) => s.options.map((o) => ({ ...combo, [s.name]: o }))), [{}]);
}

/**
 * 组合 → 稳定标识：按 specs 声明顺序用 '|' 拼接（改选项名才变，改顺序不变）；无规格为 ''。
 *
 * 长度上界就是列宽：3 维 × 每维最多 20 字 + 2 个分隔符 = **62 字**，正是 `product_skus.sku_key`
 * 的 `VARCHAR(62)`（校验里的 3/20 两个上限和它是同一件事，改一处就要改另一处）。
 */
export function skuKeyOf(specs, combo) {
  return specs.map((s) => combo[s.name]).join('|');
}

/** SKU 列表校验：必须**恰好覆盖**全部组合（无规格商品 = 恰好 1 条 key='' 的） */
function normalizeSkus(input, specs) {
  const errors = [];
  const combos = skuCombos(specs);
  const list = Array.isArray(input) ? input : [];
  if (list.length !== combos.length) {
    errors.push(`SKU 需覆盖全部规格组合（当前应为 ${combos.length} 个，收到 ${list.length} 个）`);
    return { errors, skus: [] };
  }
  const expected = new Map(combos.map((cm) => [skuKeyOf(specs, cm), cm]));
  const skus = [];
  const seen = new Set();
  for (const rawSku of list) {
    const key = String(rawSku?.key ?? '').trim();
    if (!expected.has(key)) {
      errors.push(`SKU「${key || '(空)'}」不属于当前规格的任一组合`);
      continue;
    }
    /*
      组合条目只认这五个键。多一个键（例如把商品级的 `capacity` 写进组合、或拼错 `imageUrl`）
      的表现同样是"提交了但没生效"，所以与顶层字段一样**带字段名拒绝**。
    */
    const unknownSkuKeys = Object.keys(rawSku || {}).filter(
      (k) => !['key', 'priceUsdtMicro', 'capacity', 'active', 'imageUrl'].includes(k)
    );
    if (unknownSkuKeys.length) {
      errors.push(
        `SKU「${key || '(默认)'}」不认识这些字段：${unknownSkuKeys.map((k) => `「${k}」`).join('、')}（每个组合只认 key / priceUsdtMicro / capacity / active / imageUrl）`
      );
      continue;
    }
    if (seen.has(key)) {
      errors.push(`SKU 重复：${key || '(默认)'}`);
      continue;
    }
    seen.add(key);
    const price = Number(rawSku?.priceUsdtMicro);
    if (!Number.isInteger(price) || price <= 0 || price > PRICE_MAX_MICRO) {
      errors.push(
        `SKU「${key || '(默认)'}」价格需为 1..${PRICE_MAX_MICRO} 的整数（单位：微 USDT，1 USDT = 1e6，即最多 ${PRICE_MAX_USDT} USDT）`
      );
      continue;
    }
    let cap = null;
    if (rawSku?.capacity !== undefined && rawSku?.capacity !== null && rawSku?.capacity !== '') {
      cap = Number(rawSku.capacity);
      if (!Number.isInteger(cap) || cap < 0 || cap > 10000000) {
        errors.push(`SKU「${key || '(默认)'}」库存需为 0..1e7 整数，留空表示不限量`);
        continue;
      }
    }
    // active=false 表示该组合停售 —— 与「售罄」是两回事：
    // 售罄可能补货，停售是店主不打算再卖。二者对买家的含义不同，故独立成字段。
    const active = rawSku?.active === undefined ? true : !!rawSku.active;
    /*
      该组合的主图（可选）：与商品主图**同一条 URL 判据**（`mediaUrlAllowed` + `normalizeMediaUrl`）——
      两处白名单各写一份必然漂移，而漂移的表现是"主图区能用的地址，SKU 图用不了"（或反过来更糟：
      一个 `javascript:` 从这里溜进渲染路径）。空/缺省 = 没有独立图（买家侧就显示商品主图区）。
      它**入快照**（`sku_images` 键）：选"黑色"看到的图事后被换掉而哈希不变，等于所见非所得。
    */
    const imageUrl = normalizeMediaUrl(rawSku?.imageUrl);
    if (imageUrl && !mediaUrlAllowed(imageUrl)) {
      errors.push(`SKU「${key || '(默认)'}」的图只支持 http/https 外链或本站上传路径`);
      continue;
    }
    skus.push({ key, specs: expected.get(key), priceUsdtMicro: price, capacity: cap, active, imageUrl });
  }
  return { errors, skus };
}

/** 读库：某商品的 SKU 行（按 sku_key 排序，输出稳定） */
export async function loadSkus(productId) {
  return await getDb().all('SELECT * FROM product_skus WHERE product_id = ? ORDER BY sku_key', productId);
}

/** 给商品行挂上 skus（快照与 DTO 都要用；已挂则直接返回）。
 *  async：读的是异步数据层，返回 Promise——调用方**必须 await**（漏了的话快照里的 skus/sku_images
 *  会是空数组，买家侧立刻报假的「商品内容已被修改」）。 */
async function withSkus(row) {
  if (!row) return row;
  if (Array.isArray(row.skus)) return row;
  return { ...row, skus: await loadSkus(row.id) };
}

/** 解析商品的规格定义（`products.specs`，JSON 列；形状不对当作无规格） */
function parseSpecsColumn(row) {
  const v = assertParsedJsonColumn(row?.specs, 'products.specs');
  return Array.isArray(v) ? v : [];
}

/** 写库：全量替换某商品的 SKU 行（**保留同 key 的 committed** —— 编辑商品不该把已售数量清零） */
async function saveSkus(productId, skus) {
  const db = getDb();
  /*
    「读旧 committed → DELETE → 逐行 INSERT + 继承」必须关在**同一个事务**里。

    为什么：买家下单的占位（`stockHold`）是 `UPDATE product_skus SET committed = committed + ?`。
    读在事务之外时，一笔占位可以落在「读回旧值」与「DELETE/INSERT」之间，而 INSERT 写的是
    **读回来的那个旧值** ⇒ 那一件占位被静默抹掉：卖家改一次商品，买家手里的单就少一件占位
    （余量虚高 ⇒ 同一件货被再卖一次），或已占位的那一件回来一看变成「已售罄」。
    MySQL 下并发的写事务真的会落在不同连接上（所以这里必须显式成组）。

    本函数自己开事务 ⇒ 在上架/编辑这类**已有外层事务**的路径里自动降级为 SAVEPOINT（见 db.js）。
    `created_at` / `updated_at` 不传：两列都是 `DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)`，
    由服务器盖章（应用端时钟错了也写不错）。
  */
  return await withTransaction(async () => {
    const prev = new Map(
      (await db.all('SELECT sku_key, committed FROM product_skus WHERE product_id = ?', productId)).map((r) => [r.sku_key, { committed: r.committed }])
    );
    await db.run('DELETE FROM product_skus WHERE product_id = ?', productId);
    const insSql =
      'INSERT INTO product_skus (product_id, sku_key, specs_json, price_usdt_micro, image_url, capacity, committed, active) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    for (const s of skus) {
      await db.run(insSql, productId, s.key, JSON.stringify(s.specs || {}), s.priceUsdtMicro, s.imageUrl || '', s.capacity, prev.get(s.key)?.committed || 0, s.active === false ? 0 : 1);
    }
  });
}

/** DB 行 → 对外字段（camelCase）。价格与库存**一律来自 Skus**，商品级字段只是汇总值：
 *  - priceUsdtMicro/priceUsdt = 各组合最低价（列表页「起价」展示用；成交价一律取所选 SKU）
 *  - capacity/committed    = 各组合之和；任一组合不限量则 capacity 为 null（整体视为不限量）
 *  - available             = null 或 总量 − 已占位
 *  行需先经 withSkus() 挂上 skus —— 本函数因此是 async（读 skus 要 await，见 withSkus）。 */
async function rowToPublic(row) {
  const r = await withSkus(row);
  const snap = snapshotObject(r);
  const skus = (r.skus || []).map((s) => ({
    key: s.sku_key,
    // `specs_json` 是 JSON 列（驱动已解析成对象）；无规格商品是 {}。
    // 形状兜底只为手搓行对象——快照不含该字段，所以这里归一不影响哈希。
    specs: s.specs_json && typeof s.specs_json === 'object' && !Array.isArray(s.specs_json) ? s.specs_json : {},
    priceUsdtMicro: s.price_usdt_micro,
    priceUsdt: usdtOf(s.price_usdt_micro),
    /** 该组合的主图（空串 = 没有独立图）；与商品主图同一套 URL 判据，入快照的 `sku_images` */
    imageUrl: s.image_url,
    capacity: s.capacity,
    committed: s.committed,
    available: s.capacity === null ? null : Math.max(0, s.capacity - s.committed),
    active: !!s.active,
  }));
  const unlimited = skus.some((s) => s.capacity === null);
  const capacity = skus.length && !unlimited ? skus.reduce((n, s) => n + s.capacity, 0) : null;
  const committed = skus.reduce((n, s) => n + s.committed, 0);
  const minMicro = skus.length ? Math.min(...skus.map((s) => s.priceUsdtMicro)) : 0;
  return {
    slug: r.slug,
    /**
     * 这件商品属于**哪家店**（链上店铺编号）。
     *
     * 商品行原本只带 `slug`，于是聚合首页面对"一个节点下有多家店"时无法回答这件货是谁的：
     * `utils/shopRowCode` 只在该节点**恰有一家店**时才敢回退，多店节点只能把卡片渲染成
     * 无店名、无链接的裸商品——同一件货在两列里并排出现，其中一列连店都指不出来。
     * 归属在库里本来就有（`products.shop_code`），在 DTO 这一层如实带出去，
     * 卡片才能用目录行解析店名并构造 `/product/<店铺编号>/<slug>`。
     *
     * 它**不进快照**：归属是发布位置，买了什么由快照回答；改归属不应让老订单报"内容被修改"。
     */
    shopCode: r.shop_code,
    title: r.title,
    description: r.description,
    /** 详情块（权威内容）：[{type:'text',text} | {type:'image',url}]；空数组时前端按 description 纯文本渲染 */
    descriptionBlocks: parseBlocks(r.description_blocks),
    /** 主图区（顺序即展示顺序）：[{type:'image',url} | {type:'video',url,poster}] */
    media: snap.media,
    kind: r.kind,
    /**
     * 运费（实物）：**按单收取一次**（不随件数翻倍），0 = 包邮。
     * 数字 / NFT 商品恒为 0（运费列只对 physical 生效，见 validateProduct）。
     * 该值入快照——买家据此核验锁定的运费没被事后改价。
     */
    shippingFeeUsdtMicro: r.shipping_fee_usdt_micro,
    shippingFeeUsdt: usdtOf(r.shipping_fee_usdt_micro),
    freeShipping: !(r.shipping_fee_usdt_micro > 0),
    /** 未成年人禁止购买（0/1）：下单必须带买家显式确认（ageAck）；入快照，上架后不可静默增删 */
    ageRestricted: !!r.age_restricted,
    /**
     * NFT 合约地址与标准：**三态（值为 NULL，不是空串）**。
     * kind='nft' 时两者必非空（建表 CHECK 保证）；其余类型恒为 NULL——"没有这个字段"与
     * "填了个空串"在库里是两件事，DTO 如实转发 NULL，消费方不必再判空串。
     */
    nftContract: r.nft_contract,
    nftStandard: r.nft_standard,
    specs: parseSpecsColumn(r),
    /**
     * 商品标签（类目）：**恒为数组**，空数组 = 无标签（**不是 null**——标签本来就是可选项，
     * "没有标签"与"读不出标签"对检索/展示的影响相同，故 DTO 契约恒定，消费方不必再判 null）。
     * 下发的是**展示形**（店主写入时的原样：`RTX 5090` 就是 `RTX 5090`，不折小写；
     * 只做过去控制/零宽、空白折叠、trim 的清洗，见 src/tags.js）。
     * 而"是不是同一个标签"由**键**决定（ASCII 折小写，与展示形同住在 `products.tags` 的 JSON 里），
     * 筛选与聚合都走键（`? MEMBER OF (tags->'$[*].key')`，多值索引）——
     * 所以卡片上显示 `RTX 5090`，点它（或手输 `rtx 5090`）都能搜到同一批商品。
     * 标签**不入快照**（改标签不改"买到的是什么"）。
     */
    tags: parseTagsColumn(r.tags),
    /**
     * 商品**参数**（[{name, value}]，≤20 条）：这件货**是什么**（成色/材质/产地/型号/批次/保质期）。
     * 恒为数组、空数组 = 没有参数（**不是 null**，与 tags 同一条 DTO 契约）。
     * 与 tags 的分工：标签是检索维度（不进快照），参数是商品本身（**进快照**，见文件头快照契约）。
     * 库里的第三条冗余 `pair`（多值索引用的 nameKey+NUL+valueKey）不下发，见 src/attributes.js。
     */
    attributes: parseAttributesColumn(r.attributes),
    /**
     * 商品级**承诺**（handling_days / return_policy / return_window_days / return_freight）。
     * 恒为对象、未声明时是"空承诺"（各键为 null / `unspecified`）——**不是 null**：
     * "店主没声明"与"读不出来"在展示与仲裁上同形，消费方不必再判一次 null。
     * 键名保持 snake_case 且键序固定（与库/快照逐字一致，见 src/productTerms.js）。
     */
    terms: parseTermsColumn(r.terms),
    skus,
    // 汇总口径（列表页展示；逐组合的权威值在 skus 里）
    priceUsdtMicro: minMicro,
    priceUsdt: usdtOf(minMicro),
    priceFromMicro: minMicro,
    unlimited,
    available: capacity === null ? null : Math.max(0, capacity - committed),
    capacity,
    committed,
    outOfStock: skus.length > 0 && skus.every((s) => !s.active || (s.capacity !== null && s.available <= 0)),
    active: !!r.active,
    /**
     * 首次上架时刻（ISO-8601 字符串，`Date.prototype.toJSON()`；`null` = **从未发布过**）。
     * 它不是状态：可见性只看 `active`；这一列只让界面把"未上架"分成两档——
     * 从未发布（草稿）与已下架（曾发布）。下架不清空（"卖过"这件事不因撤下而消失）。
     */
    publishedAt: r.published_at,
    snapshotHash: r.snapshot_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/*
  ── 商品写入口认识的字段（**唯一实现**：上架 POST / 编辑 PATCH / 批量 PATCH 三处共用）──

  为什么必须有这道门：`validateProduct` 只从入参里**挑**它认识的键，于是"提交了本接口不处理的
  字段"的表现是 **200 OK 且什么也没发生**——店主以为设了、实际没设。三种形态同形且都无痕：
  字段名拼错、把只读的汇总字段当成可写字段、将来新增字段时老调用方继续提交旧名。

  本仓对这类失败的口径是"绝不静默"：认识就处理，不认识就**带字段名拒绝**并说清去哪提交。

  ⚠ 下面两个**不是**商品写入口的字段，它们由 `skus` 派生、只读（`rowToPublic` 的汇总口径）：
    · `priceUsdtMicro` —— 商品级价 = 各组合最低价；只读汇总。批量改价端点 `/batch` 收它
      （语义是"把全部组合统一改成这个价"），单个商品的上架/编辑不收；
    · `capacity` —— 商品级库存 = 各组合之和；逐组合库存在 `skus[].capacity`。
  把它们放进 `ProductInput`（前端类型）曾让"提交了但不生效"成为常态，故两份集合同批对齐。
*/
const PRODUCT_WRITE_KEYS = new Set([
  'title',
  'description',
  'descriptionBlocks',
  'media',
  'kind',
  'nftContract',
  'nftStandard',
  'specs',
  'skus',
  'tags',
  'attributes',
  'terms',
  'shippingFeeUsdtMicro',
  'ageRestricted',
  'autoDeliver',
  'stockAlertAt',
  'active',
]);

/** 批量修改的 patch 键（同一道门的第二个入口；集合不同——批量不展开规格明细） */
const PRODUCT_BATCH_PATCH_KEYS = new Set(['priceUsdtMicro', 'active', 'autoDeliver', 'stockAlertAt']);

/**
 * 未知键检查（**唯一实现**；三个写入口共用）。
 * @param {unknown} body 请求体
 * @param {Set<string>} allowed 该入口认识的键
 * @param {string} where 人类可读的入口名（错误里要指出"是哪个接口不认识"）
 * @returns {string|null} 可读中文错（含字段名与处置办法）；null = 全部认识
 */
function unknownKeysError(body, allowed, where) {
  const bad = Object.keys(body || {}).filter((k) => !allowed.has(k));
  if (!bad.length) return null;
  return (
    `${where}不认识这些字段：${bad.map((k) => `「${k}」`).join('、')}——` +
    '请检查字段名（提交了不生效的字段多半是拼写或接口用错）。' +
    `本接口接受：${[...allowed].join(' / ')}`
  );
}

/**
 * 商品字段校验（POST 全量 / PATCH 基于现有行合并后全量校验）。
 * 返回 { errors: string[], value: 规范化后的写库字段 }
 */
function validateProduct(v) {
  const errors = [];
  const title = String(v.title ?? '').trim();
  if (!title || title.length > 120) errors.push('title 必填且不超过 120 字符');
  const description = String(v.description ?? '').slice(0, 5000);
  /*
    主图区（media）：**数组顺序即展示顺序**，元素是判别联合
      { type:'image', url }  |  { type:'video', url, poster }

    - 上限（合计 ≤10 项、视频 ≤3）来自 `mediaKinds.js` —— 与前端预检**同一份常量**，
      不在两边各写一个数字；
    - URL 规则走唯一判据 `mediaUrlAllowed`（http(s) 外链或本站 /api/uploads/…），
      与详情块图片同一条；图片允许外链（店主自备图床是既有能力），
      **视频只收本站上传**：外链视频会绕过"类型由字节判定"这条判据（服务端从没见过那些字节），
      而主图区视频要进快照、要长期可播，不该建立在别人图床挂不挂上；
    - poster（封面）必填：它同时是画廊缩略图与"这段视频在店主本机放得了"的证据
      （前端抓首帧生成，抓不到就不给保存 —— 服务端不判编码，见 mediaKinds.js 的口径 2）。
  */
  let media = [];
  if (!Array.isArray(v.media)) {
    errors.push('media 需为主图区数组（[{type:"image",url} | {type:"video",url,poster}]）');
  } else {
    if (v.media.length > MAX_MEDIA_ITEMS) errors.push(`主图区最多 ${MAX_MEDIA_ITEMS} 项（图片 + 视频合计）`);
    let videos = 0;
    media = v.media.slice(0, MAX_MEDIA_ITEMS).flatMap((raw) => {
      const type = String(raw?.type || '');
      const url = normalizeMediaUrl(raw?.url);
      if (type === 'image') {
        if (!url) return [];
        if (!mediaUrlAllowed(url)) {
          errors.push('图片 URL 仅支持 http/https 外链或本站上传路径');
          return [];
        }
        return [{ type: 'image', url }];
      }
      if (type === 'video') {
        videos += 1;
        if (videos > MAX_VIDEO_ITEMS) {
          errors.push(`视频最多 ${MAX_VIDEO_ITEMS} 个`);
          return [];
        }
        if (!url.startsWith(UPLOAD_URL_PREFIX)) {
          errors.push('视频仅支持上传到本站（不收外链视频）');
          return [];
        }
        const poster = normalizeMediaUrl(raw?.poster);
        if (!poster || !mediaUrlAllowed(poster)) {
          errors.push('每个视频都要有封面图（上传时由浏览器抓首帧生成）');
          return [];
        }
        return [{ type: 'video', url, poster }];
      }
      errors.push('主图区条目的 type 只能是 image 或 video');
      return [];
    });
  }
  const kind = String(v.kind ?? '');
  if (!['digital', 'physical', 'nft'].includes(kind)) errors.push('kind 需为 digital / physical / nft');
  /*
    NFT 两列的**三态形状是 NULL，不是空串**（建表 CHECK `(kind='nft') = (nft_contract IS NOT NULL)`
    让"非 NFT 却留着一个合约地址"、以及"是 NFT 却没有合约"在库里都不可表达）：
      · kind='nft'  ⇒ nft_contract 必填（0x 小写归一，不可为 0x0）+ nft_standard（erc721/erc1155，缺省 erc721）；
      · 其余类型    ⇒ 两列都写 NULL（改回普通商品时随 UPDATE 一起清空，不留半截身份）。
  */
  let nftContract = null;
  let nftStandard = null;
  if (kind === 'nft') {
    const c = String(v.nftContract ?? '').trim().toLowerCase();
    if (!isAddress(c) || isZeroAddress(c)) errors.push('NFT 商品需填写合法的 NFT 合约地址（0x 开头，不可为 0x0）');
    else nftContract = c;
    const s = String(v.nftStandard ?? '').trim().toLowerCase() || 'erc721';
    if (!['erc721', 'erc1155'].includes(s)) errors.push('nftStandard 需为 erc721（兼容 ERC721A）/ erc1155');
    else nftStandard = s;
  }
  // 价格与库存下沉到 SKU：specs 定义维度，skus 必须**恰好覆盖**全部组合
  // （无规格商品 = 恰好 1 条 key='' 的组合，与有规格商品走同一条校验路径）
  const { errors: specErrs, specs } = normalizeSpecs(v.specs);
  errors.push(...specErrs);
  const { errors: skuErrs, skus } = normalizeSkus(v.skus, specs);
  errors.push(...skuErrs);
  // 详情块（文字 + 图片混排）。description 由块派生 —— 搜索走 LIKE 匹配文字，
  // 不该去匹配 JSON 里的引号与 url。
  const { errors: blockErrs, blocks } = normalizeBlocks(v.descriptionBlocks);
  errors.push(...blockErrs);
  // 数字商品自动交付：-1=跟随全局 MK_AUTO_DELIVER / 0=关闭 / 1=强制开启（经营配置，不入快照）
  let autoDeliver = -1;
  if (v.autoDeliver !== undefined && v.autoDeliver !== null) {
    autoDeliver = Number(v.autoDeliver);
    if (![-1, 0, 1].includes(autoDeliver)) errors.push('autoDeliver 需为 -1（跟随全局）/ 0（关闭）/ 1（开启）');
  }
  // 低库存提醒阈值：余量 ≤ 阈值时卖家面板警示；空/0 视为不提醒（列是 NULL = 不提醒，三态不落空串）
  let stockAlertAt = null;
  if (v.stockAlertAt !== undefined && v.stockAlertAt !== null && v.stockAlertAt !== '') {
    stockAlertAt = Number(v.stockAlertAt);
    if (!Number.isInteger(stockAlertAt) || stockAlertAt < 0 || stockAlertAt > 10000000) {
      errors.push('stockAlertAt（低库存阈值）需为 0..1e7 整数，留空表示不提醒');
    }
    if (stockAlertAt === 0) stockAlertAt = null;
  }
  const active = v.active === false || v.active === 0 ? 0 : 1;
  /*
    运费（实物，按单收取一次，微 USDT）：
     - 非负整数，上限 1e9 微 = 1000 USDT（比价上限还高一个量级即为误填/攻击面，明确拒绝而不是截断）；
     - 只有实物商品有运费语义：数字/NFT 商品携带非 0 值**显式拒绝**（而不是静默归零）——
       静默归零会让店主以为"我设了运费"，实际一分钱没收到；
     - 空/未提交 = 0（包邮）。
  */
  let shippingFeeUsdtMicro = 0;
  if (v.shippingFeeUsdtMicro !== undefined && v.shippingFeeUsdtMicro !== null && v.shippingFeeUsdtMicro !== '') {
    const fee = Number(v.shippingFeeUsdtMicro);
    if (!Number.isInteger(fee) || fee < 0 || fee > SHIPPING_FEE_MAX_MICRO) {
      errors.push(
        `shippingFeeUsdtMicro（运费）需为 0..${SHIPPING_FEE_MAX_MICRO} 的整数（单位：微 USDT，即 0..1000 USDT；0 = 包邮）`
      );
    } else if (kind !== 'physical' && fee > 0) {
      errors.push('仅实物商品可设置运费（数字 / NFT 商品运费恒为 0）');
    } else {
      shippingFeeUsdtMicro = fee;
    }
  }
  /*
    未成年人禁止购买（机制，不是政策）：0/1。只接受布尔或 0/1——不给字符串留位置，
    因为"on"/"yes"这类值在两端序列化后含义会漂移，而它要进快照参与哈希。
    ⚠️ 具体哪些商品属于年龄限制商品由运营方自行界定（软件只提供机制，政策文本在 docs/）。
  */
  let ageRestricted = 0;
  if (v.ageRestricted !== undefined && v.ageRestricted !== null) {
    if (![true, false, 0, 1].includes(v.ageRestricted)) {
      errors.push('ageRestricted（未成年人禁止购买）需为布尔值（true/false 或 1/0）');
    } else {
      ageRestricted = v.ageRestricted === true || v.ageRestricted === 1 ? 1 : 0;
    }
  }
  /*
    商品标签（类目）：可选字段（`undefined`/`null` = 无标签）。归一化/上限/去重全部在
    src/tags.js（**唯一实现**，上架与编辑两个写入入口共用），这里只负责把它的可读中文错
    合并进 errors —— 与其它字段一致：**有错就整体拒绝**，不留半写状态（哪怕只有一个标签超长）。
    产出形状是 `[{key, display}]`（键与展示形同住一列 JSON，一次写入即原子）。
  */
  let tags = [];
  try {
    tags = normalizeTags(v.tags);
  } catch (e) {
    errors.push(e.message);
  }
  /*
    商品参数（attributes）：可选字段（`undefined`/`null` = 无参数）。归一化/上限/去重/键口径
    全部在 src/attributes.js（**唯一实现**，与标签共用 tags.js 的清洗）。**入快照**（见 snapshotObject）：
    它是店主对"这件货是什么"的陈述，是"货不对板"争议里唯一能被逐条对照的东西。
  */
  let attributes = [];
  try {
    attributes = normalizeAttributes(v.attributes);
  } catch (e) {
    errors.push(e.message);
  }
  /*
    商品承诺（terms）：可选字段（`undefined`/`null` = 未声明）。唯一实现在 src/productTerms.js。
    **入快照**：它是条款本身——本商城的裁决不做事实调查，承诺不进快照就等于"晚发货/不给退"
    在机制内没有客观判据（见 src/productTerms.js 文件头）。
  */
  let terms = { ...EMPTY_TERMS };
  try {
    terms = normalizeTerms(v.terms);
  } catch (e) {
    errors.push(e.message);
  }
  return {
    errors,
    value: {
      title,
      // 有块时 description 降级为派生摘要；无块时就是店主填的纯文本（保持原有观感）
      description: blocks.length ? deriveDescription(blocks) : description,
      descriptionBlocks: blocks,
      media,
      kind,
      shippingFeeUsdtMicro,
      ageRestricted,
      nftContract,
      nftStandard,
      specs,
      skus,
      tags,
      attributes,
      terms,
      autoDeliver,
      stockAlertAt,
      active,
    },
  };
}

// ── 路由 ──

/** 商品分页列表（仅上架商品；附汇率快照 rates，供前端统一换算展示）。
 *
 *  可选 q    ：**本店检索**（"这一家店里有没有这个词"）——标题/描述的大小写不敏感包含匹配
 *              （SQL LIKE，ASCII 大小写不敏感；中文按字面包含），SQL LIKE 参数化，
 *              %/_ 转义为字面量防通配放大。
 *              规则写清：先 `trim()`；**空串/纯空白 = 不按关键词过滤**（退化为全列表，与"没传"同义）；
 *              长度上限 **60 字符**，超出按前 60 字符匹配（**刻意保留截断**：搜索是尽力而为的过滤、
 *              不是写入形状，把它变成报错只会让"粘贴一整段话去搜"直接失败；写入侧的标签超限则必须报错，
 *              见 src/tags.js）。**联邦跨店搜索由前端扇出**（对每家可达节点各发一次本接口），
 *              节点**不代查**别家店——那是把"多店节点"的边界抹掉。
 *  可选 tag  ：按**标签键精确匹配**（先归一化入参成键，再走多值索引 `tags->'$[*].key'`；
 *              不归一化就只能全表 LIKE，且 `GPU`/`gpu` 会各搜一半）。入参可以是**任意写法**：
 *              卡片上的展示形（`RTX 5090`）、用户手输（`rtx 5090`）、多打了空格（`RTX  5090`）
 *              都归一成同一个键，命中同一批商品。入参非法/超长**按"查不到"处理并说明**
 *              （`tagError` + message，结果为空），既不静默忽略也不 500。
 *              缺省/纯空白 = 不按标签过滤（与 q 同口径）。
 *  可选 attr ：`参数名:值` 的**精确匹配**，与 tag 同一套口径（两侧都折成键，再拼成索引键
 *              `pair = nameKey + NUL + valueKey`，走多值索引 `attributes->'$[*].pair'`）。
 *              分隔符是**第一个**冒号（值里可以再出现冒号），三种失败都进 `attrError` 且结果为空。
 *  可选 order：asc（默认，保持既有行为）| desc（**最新上架优先**——聚合前端首屏
 *              必须用它，否则展示的是每家店最早上架的商品）
 *  可选 kind ：逗号分隔的商品类型分面（physical/digital/nft）。非法值**不静默**：
 *              进 `kindError` 且结果为空（与 tag/attr 同款三态——"没按类型过滤"/"参数写错了"
 *              /"没有这种商品"是三件事，混成一件会让 `?kind=digial` 拿到全站商品）。
 *
 *  四个过滤维度（q / tag / attr / kind）与光标分页、order **正交**：都是同一组 WHERE 条件，
 *  每页都是过滤后的结果。
 *
 *  ⚠️ **目录面与店铺面是同一个端点的两个作用域**（2026-10-18 收口）：
 *    · 不带 `X-Mk-Shop` ⇒ 全节点在售商品（目录/首页）；
 *    · 带 `X-Mk-Shop` ⇒ **只返回该店铺自己的商品**，且该店必须当前可售（`listedShopScope` 对暂停店
 *      返回 409，与商品详情看不了的理由同源）。旧实现只校验头、不按 `shop_code` 过滤，于是
 *      `/shop/<code>` 会显示同节点其它店的商品——页面身份与商品归属对不上。
 *
 *  游标语义：两种方向都以 id 为 keyset 游标，只是比较方向相反——
 *  asc 用 `id > cursor`、desc 用 `id < cursor`；cursor=0 表示首屏无游标。
 *  `nextCursor` 仅在**确有下一页**时非空（多取一行做前瞻判定），
 *  调用方据此即可准确判断到底，无需再发一次空请求。 */
const PRODUCT_KINDS = new Set(['digital', 'physical', 'nft']);

router.get('/', listedShopScope, wrap(async (req, res) => {
  const cursor = Math.max(0, parseInt(req.query.cursor, 10) || 0);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  const q = String(req.query.q ?? '').trim().slice(0, 60);
  const order = String(req.query.order ?? '').toLowerCase() === 'desc' ? 'desc' : 'asc';
  /*
    `?kind=` 的**非法值与 tag/attr 同一套口径**（2026-10-16 收口）：
    此前这里是 `.filter((s) => PRODUCT_KINDS.has(s))` —— 认不出的值被**静默丢弃**，
    于是 `?kind=digial`（拼错）退化成"不加过滤"，调用方拿到**全站在售商品**，
    却分不清"没有这种商品"与"参数写错了"（买家用它筛数字商品时会以为全站都是数字商品）。
    三种过滤里只有 kind 是静默的，另外两种各自带 `tagError`/`attrError` —— 现在一致：
    非法值进 `kindError`、SQL 上加恒假条件（空结果，但**不静默**，响应形状不变）。
  */
  const rawKinds = String(req.query.kind ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
  const badKinds = rawKinds.filter((s) => !PRODUCT_KINDS.has(s));
  const kinds = rawKinds.filter((s) => PRODUCT_KINDS.has(s));
  const kindError = badKinds.length
    ? `kind 取值非法：${[...new Set(badKinds)].join('、')}（可用值：${[...PRODUCT_KINDS].join(' / ')}）`
    : null;
  /*
    标签入参归一成**键**：唯一实现在 src/tags.js（与写入侧同一个模块）——
    所以"店主写进去的标签"与"买家搜的标签"必然落在同一个键上（展示形怎么写都不影响命中）。
    三种失败都按"查不到"处理并把原因放在 tagError 里（不静默忽略、也不 500）：
      · 抛错（超长/非字符串…）：把中文原因原样报出；
      · 归一化后为空（纯控制字符等）：说明它不是一个可用标签；
      · 重复给了多个 tag（`?tag=a&tag=b` ⇒ Express 给数组）：明确说"一次只能给一个"，
        否则它会被当成一个名叫 "a,b" 的标签而静默查不到。
  */
  const rawTagParam = req.query.tag;
  const rawTag = rawTagParam === undefined || rawTagParam === null ? '' : String(rawTagParam);
  let tagKey = null;
  let tagError = null;
  if (Array.isArray(rawTagParam)) {
    tagError = 'tag 一次只能给一个（多个标签请分次查询，或与 kind/q 组合）';
  } else if (rawTag.trim() !== '') {
    try {
      const display = normalizeTags([rawTag])[0] ?? null; // 先过一遍写入侧同款校验（长度/空值口径一致）
      if (display === null) tagError = '标签去掉控制字符与空白后为空，不是一个可用标签';
      else tagKey = display.key; // 键由 tags.js 现算，与库里的 key 同一个函数
    } catch (e) {
      tagError = e.message;
    }
  }

  /*
    参数筛选 `?attr=参数名:值`。
    与标签同一套口径（唯一实现在 src/tags.js 的 cleanLabel/tagKeyOf）：两侧都归一成**键**，
    再由 `attrPairOf` 拼成索引键——**与写入侧同一个函数**，所以"店主写 `成色: 全新未拆封`"
    与"买家筛 `成色:全新未拆封`"必然落在同一个 pair 上（值里的写法差异已被键吸收）。
    分隔符是**第一个**冒号：值里可以再出现冒号（"接口: USB-C: 3.2"这种写法不该被截断成两个字段）。
    三种失败都按"查不到"处理并把原因放进 attrError（不静默忽略、也不 500），与 tagError 同款：
      · 没有冒号 / 任一侧为空 ⇒ 说清正确形状；
      · 重复给了多个 attr（`?attr=a:b&attr=c:d`）⇒ 明确说"一次只能给一个"；
      · 超长/非法字符（cleanLabel 之后为空）⇒ 原样报出中文原因。
  */
  const rawAttrParam = req.query.attr;
  let attrPair = null;
  let attrKeys = null;
  let attrDisplay = null;
  let attrError = null;
  if (Array.isArray(rawAttrParam)) {
    attrError = 'attr 一次只能给一个（多个参数请分次查询，或与 kind/q/tag 组合）';
  } else if (rawAttrParam !== undefined && rawAttrParam !== null && String(rawAttrParam).trim() !== '') {
    const s = String(rawAttrParam);
    const i = s.indexOf(':');
    if (i < 0) {
      attrError = 'attr 的形状是「参数名:值」，例如 attr=成色:全新未拆封（这次没找到冒号）';
    } else {
      const name = cleanLabel(s.slice(0, i));
      const value = cleanLabel(s.slice(i + 1));
      if (!name || !value) {
        attrError = 'attr 的参数名与值都不能为空（形状是「参数名:值」）';
      } else {
        attrKeys = { nameKey: tagKeyOf(name), valueKey: tagKeyOf(value) };
        attrPair = attrPairOf(attrKeys.nameKey, attrKeys.valueKey);
        attrDisplay = `${name}:${value}`;
      }
    }
  }

  const db = getDb();
  /*
    公开聚合列表的**两个正交判据**（缺一不可，不是替换关系）：
      · `active = 1` —— 商品自己有没有上架（既有的判据，店主/店员在商品管理里控制）；
      · `shops.listed = 1` —— **所属店铺**现在能不能接单（链上 `shopListed` 的镜像，
        由 termsReconciler 写入；暂停接单的店铺，它的商品不进聚合）。
    两条各自回答不同的问题：一件"已上架"的商品完全可能属于一家"已暂停接单"的店
    （佣金条款谈崩就是这种情况），那时买家不该再看到它——否则点进去也下不了单。
    **不在这里判店铺黑名单**：链上 `shopListed` 已经把黑名单算进去了（合约侧唯一判据），
    再判一次就是第二处判据。
  */
  const where = ['active = 1', "shop_code IN (SELECT code FROM shops WHERE listed = 1)"];
  const args = [];
  // 店铺作用域：带了 X-Mk-Shop 就只出这一家店的商品（listedShopScope 已保证该店可售）。
  if (req.shop) {
    where.push('shop_code = ?');
    args.push(String(req.shop.code));
  }
  if (cursor > 0) {
    where.push(order === 'desc' ? 'id < ?' : 'id > ?');
    args.push(cursor);
  }
  if (q) {
    /*
      LIKE 通配符转义（`ESCAPE '\\'`：MySQL 的字符串字面量里反斜杠要写两个，
      所以 JS 源码里是四个——少一个就是 ER_PARSE_ERROR，见下方同类处）

      ⚠️ **必须显式写 `COLLATE utf8mb4_0900_ai_ci`**：本库的排序规则是
      `utf8mb4_0900_as_cs`（区分大小写，R5 的库级统一选择），于是不写 COLLATE 的 LIKE
      会让**搜索变成大小写敏感**——`?q=ASUS` 命中而 `?q=asus` 空。买家搜不到自己看得见的商品，
      且不报错。"大小写不敏感"是搜索这个动作的语义，所以它属于**谓词**，必须写在谓词上
      （这正是选 as_cs 作库级规则时定下的例外方式：库级只有一种，例外在查询里看得见）。
    */
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    where.push(
      "(title COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\' OR description COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\')"
    );
    args.push(like, like);
  }
  if (tagKey) {
    // 标签走**多值索引**（`idx_products_tags` = CAST(tags->'$[*].key' AS CHAR(64) ARRAY)）：
    // tagKey 已是规范形，MEMBER OF 与索引里的字节**全等**（JSON 里的字符串是 utf8mb4_bin，
    // 实测大小写/全角都不会被折），不对 title/description 做全表 LIKE。
    where.push("? MEMBER OF (tags->'$[*].key')");
    args.push(tagKey);
  }
  if (attrPair) {
    // 参数同样走多值索引（`idx_products_attrs`，索引键就是写入时由 attrPairOf 拼的那一份）：
    // 一对键拼成的 pair 全等才算命中（名/值里的写法差异已被键吸收）
    where.push("? MEMBER OF (attributes->'$[*].pair')");
    args.push(attrPair);
  }
  if (tagError || attrError || kindError) {
    /*
      非法/超长标签或非法 kind = **查不到**（空结果），但绝不静默：结果里带 tagError/attrError/
      kindError、message 里说明，调用方不会把"参数写错了"误读成"这家店没有这个类目"。
      空结果的实现方式是在 SQL 上加恒假条件（而不是提前 return）——保证响应形状与正常路径
      完全一致（products/nextCursor/rates/tag/tagError/kindError 一个不少）。
    */
    where.push('0 = 1');
  }
  if (kinds.length) {
    where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    args.push(...kinds);
  }
  /*
    **链上名单的商品类条目**（`Blocklist` 的 `Product` 类，2026-10）。

    为什么过滤必须落在 SQL 而不是取回来再筛：列表是**游标分页**（`LIMIT pageSize + 1`），
    在内存里丢掉几行会让这一页少几件、`nextCursor` 仍指向正确位置，但"这一页有几件"与
    "还有没有下一页"就开始互相矛盾（满页到底会多一次空请求、而少件会让买家以为卖完了）。
    放进 `where` 之后，分页与计数仍然由数据库回答，与 `active`/`listed` 两个判据同一层。

    三态纪律（与 `chain.blockPlacard` 的其它读法一致）：未配置合约 ⇒ 这道闸整体不生效（不查、不报错）；
    配置了但读不到 ⇒ **拒绝返回列表**（fail-closed，理由可读）——"读不到名单"与"名单里没有它"是两件事，
    把前者当后者就是让被冻结的商品照常出现在聚合页上。

    条数上限：`Blocklist.MAX_BATCH` 是单次批量写的上限（100），而名单总量由 owner 控制。
    这里对"单次查询能带的参数个数"设一个显式上限（500）：超了就有界失败并说清怎么办，
    而不是让驱动在某个不可预期的条数上抛参数上限错误（那种失败发生在最不该出错的读路径上）。
  */
  if (config.chain.blocklistAddress) {
    let blockedSlugs;
    try {
      blockedSlugs = await blockedProductSlugs();
    } catch (e) {
      return fail(
        res,
        `读不到链上黑名单（${e?.message || e}）：无法确认哪些商品已被全网冻结，本次按 fail-closed 不返回列表。` +
          `请稍后重试；若确实不读链上名单，清空 MK_BLOCKLIST_ADDRESS（留空即关闭这道过滤）`,
        503,
        503
      );
    }
    if (blockedSlugs.size > 500) {
      return fail(
        res,
        `链上黑名单的商品类条目有 ${blockedSlugs.size} 条，超过本节点单次过滤上限（500 条）——` +
          `请在治理侧收敛名单，或先清空 MK_BLOCKLIST_ADDRESS（那会让商品类过滤整体不生效，如实告知）`,
        503,
        503
      );
    }
    if (blockedSlugs.size > 0) {
      where.push(`slug NOT IN (${[...blockedSlugs].map(() => '?').join(',')})`);
      args.push(...blockedSlugs);
    }
  }

  // 多取一行用于「是否还有下一页」的精确判定（避免满页到底时多一次空请求）
  const raw = await db.all(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`, ...args, pageSize + 1);
  const hasMore = raw.length > pageSize;
  const rows = hasMore ? raw.slice(0, pageSize) : raw;

  const products = await Promise.all(rows.map((row) => rowToPublic(row)));
  // 商品卡社会信号（P 评审 B12）：列表批量附评价聚合（一次 GROUP BY；avg/count 供卡片展示）
  if (rows.length) {
    const marks = rows.map(() => '?').join(',');
    const agg = await db.all(`SELECT product_id AS pid, COUNT(*) AS c, COALESCE(SUM(rating), 0) AS s FROM reviews WHERE product_id IN (${marks}) GROUP BY product_id`, ...rows.map((r) => r.id));
    const bySlug = new Map();
    for (const a of agg) {
      // COUNT 是整数，SUM 是 DECIMAL ⇒ 驱动给的是**字符串**（decimalNumbers:false，见 db.js）。
      // 不显式转换的话这里的除法会靠 JS 隐式转型跑通，而 `count` 会以 "3" 的形状下发。
      const c = Number(a.c);
      const s = Number(a.s);
      const row = rows.find((r) => r.id === a.pid);
      if (row) bySlug.set(row.slug, { count: c, avg: c > 0 ? Math.round((s / c) * 10) / 10 : null });
    }
    for (const p of products) {
      const sm = bySlug.get(p.slug);
      if (sm) p.reviewSummary = sm;
    }
  }
  const last = hasMore && rows.length ? rows[rows.length - 1].id : null;
  const rates = await getRates();
  // 形状与 GET /api/rates 对齐：列表接口的 rates 一旦非空即代表可用，
  // 因此显式补 available:true（此前缺失该键，消费方按 RatesData 类型判断
  // `rates.available` 时会误判为不可用而丢弃整个汇率快照）。
  ok(
    res,
    {
      products,
      nextCursor: last,
      rates: rates ? { available: true, ...rates } : null,
      // 本次实际生效的标签**键**（规范形，就是拿去做 `MEMBER OF` 匹配的那个字节）与未生效的原因：
      // 三态纪律——"没按标签过滤"（null）与"按标签过滤了但查不到"（key 非空、结果空）
      // 与"标签写错了"（tagError 非空）是三件事。回显的是**键**而不是展示形：
      // 展示形可以有很多种写法，键才是这次查询真正使用的东西（调用方要用它做后续判断）。
      tag: tagKey,
      tagError,
      // 本次实际生效的参数筛选（键对 + 展示形）与未生效的原因：与 tag/tagError 同一套三态
      attr: attrKeys ? { nameKey: attrKeys.nameKey, valueKey: attrKeys.valueKey, display: attrDisplay } : null,
      attrError,
      // 本次实际生效的 kind 过滤（规范形）与未生效的原因：与 tag/attr 同一套三态
      //（三态纪律：`kind` 为空数组 = **没按类型过滤**，`kindError` 非空 = **参数写错了**，
      //  两者都不是"没有这种商品"）
      kind: kinds.length ? kinds : null,
      kindError,
    },
    kindError
      ? `类型筛选未生效：${kindError}（本次结果为空，请改用合法取值）`
      : tagError
        ? `标签未生效：${tagError}（本次结果为空，请改用合法标签）`
        : attrError
          ? `参数筛选未生效：${attrError}（本次结果为空，请改用「参数名:值」的形状）`
          : 'success'
  );
}));

/**
 * 本店在用标签清单（公开只读）：**只统计上架商品在用到的标签**，供目录页做筛选面。
 *
 * 口径（每一段都要说清，否则"少了一个标签"没法判断是实现错还是本来就该少）：
 *  1. **只数上架商品**（`products.active = 1`）：下架商品不进筛选面，否则点进去必然空列表；
 *  2. **不按 SKU 库存过滤**（售罄仍在架的商品标签照算）：库存是暂时的、类目不是——
 *     售罄补货后标签不变，若按库存摘标签，同一标签搜到的集合会随库存抖动；
 *  3. `count` = 用到该标签**键**的上架商品数（不是标签出现次数：一个商品同一个键在
 *     `products.tags` 里只有一项——{@link normalizeTags} 按键去重，重复在写入侧就已不可表达）；
 *  4. 每项同时给 `key`（规范形，`?tag=` 匹配用的就是它）与 `tag`（**展示形**，界面直接显示）。
 *
 * **展示形的选取规则（必须确定、可复现）**：同一个键下可能同时存在多种写法
 * （`RTX 5090` 与 `rtx 5090` 是同一个键），取
 *   **出现次数最多的那种写法**（按用它作展示形的商品数计）；**并列时取字典序最小的那个**。
 * 为什么这么定：
 *   · 不能是"任意一条"——同一批数据每次查询必须给出同一个展示形，否则目录页的标签条
 *     会在刷新之间跳来跳去（用户看到的标签自己改名）；
 *   · 不能取 MIN()/最早一条——那样"多数商品怎么写"就没有发言权：一家店 5 个商品写 `iPhone`、
 *     1 个写 `iphone`，界面却可能显示那个孤例；
 *   · 并列时用字典序兜底，让"次数说不出谁更代表"时仍有唯一答案（同样可复现）。
 *     这里的"字典序"= **UTF-8 字节序**（大写字母排在小写之前）——JSON_TABLE 抽出来的字符串
 *     默认跟着**连接**的排序规则（case-insensitive），那样 `RTX 5090` 与 `rtx 5090` 会判为相等、
 *     ROW_NUMBER 取谁都"合法"，展示形就在两次查询之间抖动。所以下面每个列都显式声明
 *     `COLLATE utf8mb4_bin`：规则完全可预期，`iPhone 15` 与 `iphone 15` 并列时展示 `iPhone 15`。
 * 排序：`count` 降序、同 count 按 **`key`** 升序（**稳定**：同库多次调用结果逐字相同）。
 * 刻意不按展示形排序：展示形会随写法与次数变化，用它排序会让列表顺序随拼写漂移；
 * 前端的联邦合并也是按**键**归并的（`utils/productTags.cmpTag`），两边顺序才对得上。
 *
 * 分页与三态：`limit` 缺省 {@link TAGS_LIMIT_DEFAULT}、上限 {@link TAGS_LIMIT_MAX}（非法值**明确拒绝**，
 * 不静默钳制——调用方以为"这就是全部标签"而实际被截断是目录页最难发现的错）；
 * 响应 `{ tags: [{ tag, key, count }], total, truncated }`：`total` = **按键去重后的在用标签总数**，
 * `truncated` = 是否因 limit 未返回全部。裸数组会让界面静默少报（读不到 ≠ 0 ≠ 缺失）。
 *
 * 代价如实写：这条查询要**扫全部上架商品并展开各自的标签数组**（旧形状是镜像表上一句
 * 覆盖索引的 GROUP BY）。分面是运营侧的读，不在下单/列表的关键路径上；换来的是
 * "键与展示形同住一列、不可能漂移"。真要更快，正确做法是加一张**物化**的分面读数表，
 * 而不是把镜像表加回来（那会重新引入"两份真相必须同批写"）。
 */
const TAGS_LIMIT_DEFAULT = 100;
const TAGS_LIMIT_MAX = 200;

/** 分面展开用的一段 JSON_TABLE 子查询（`p.tags` → 行；键与展示形都按字节序比较，见上面的说明）。
 *  `jt.k IS NOT NULL` = 与 `parseTagsColumn` 同一条口径（缺键的元素在 DTO 侧也被丢掉）：
 *  元素形状不对只可能来自绕过写入路径的手写 SQL，而"卡片上没有它、筛选面里却有它"是这里最该避免的分叉。 */
const TAGS_FACET_FROM = `products p
       JOIN JSON_TABLE(p.tags, '$[*]' COLUMNS (
              k       VARCHAR(64)  COLLATE utf8mb4_bin PATH '$.key',
              display VARCHAR(128) COLLATE utf8mb4_bin PATH '$.display')) AS jt`;

router.get('/tags', listedShopScope, wrap(async (req, res) => {
  const raw = req.query.limit;
  const limit = raw === undefined || raw === '' ? TAGS_LIMIT_DEFAULT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > TAGS_LIMIT_MAX) {
    return fail(res, `limit 需为 1..${TAGS_LIMIT_MAX} 的整数（缺省 ${TAGS_LIMIT_DEFAULT}）`);
  }
  const db = getDb();
  // 带 X-Mk-Shop ⇒ 只统计这一家店；不带 ⇒ 全节点（目录面）。
  const shopSql = req.shop ? ' AND p.shop_code = ?' : '';
  const shopArgs = req.shop ? [String(req.shop.code)] : [];
  /*
    一条 SQL 里做完"按键计数 + 选展示形"，与上面那段规则一一对应：
      active  只取上架商品的 (键, 展示形) 行（JSON_TABLE 把标签数组摊成行）
      counts  按 (键, 展示形) 各自计数
      best    ROW_NUMBER() 按「次数降序、展示形升序（字节序）」编号 ⇒ rn=1 即"多数写法，并列取字典序最小"
      totals  按键求和 ⇒ count（= 用到该键的上架商品数）
    多取一行做前瞻判定（与商品列表 nextCursor 同款）：省掉一次 COUNT(DISTINCT) 全表聚合。
  */
  const rows = await db.all(`WITH active AS (
         SELECT jt.k AS tag_key, jt.display AS tag_display
           FROM ${TAGS_FACET_FROM}
          WHERE p.active = 1 AND jt.k IS NOT NULL
            AND p.shop_code IN (SELECT code FROM shops WHERE listed = 1)${shopSql}
       ),
       counts AS (
         SELECT tag_key, tag_display, COUNT(*) AS c FROM active GROUP BY tag_key, tag_display
       ),
       best AS (
         SELECT tag_key, tag_display,
                ROW_NUMBER() OVER (PARTITION BY tag_key ORDER BY c DESC, tag_display ASC) AS rn
           FROM counts
       ),
       totals AS (
         SELECT tag_key, SUM(c) AS count FROM counts GROUP BY tag_key
       )
       SELECT b.tag_display AS tag, t.tag_key AS \`key\`, t.count AS count
         FROM totals t JOIN best b ON b.tag_key = t.tag_key AND b.rn = 1
        ORDER BY count DESC, \`key\` ASC
        LIMIT ?`, ...shopArgs, limit + 1);
  const truncated = rows.length > limit;
  // SUM() 是 DECIMAL ⇒ 驱动给的是字符串（decimalNumbers:false，见 db.js）：显式转换，别让 "3" 流到 DTO
  const tags = (truncated ? rows.slice(0, limit) : rows).map((r) => ({ tag: r.tag, key: r.key, count: Number(r.count) }));
  // total 只在被截断时才需要（未截断时 total === tags.length），避免每次请求都多一次聚合。
  // COUNT(DISTINCT) 跟着列声明的 utf8mb4_bin 走 ⇒ 与"键"的粒度一致（不会被大小写/全角合并）。
  const total = truncated
    ? Number((await db.get(`SELECT COUNT(DISTINCT jt.k) AS c FROM ${TAGS_FACET_FROM} WHERE p.active = 1 AND jt.k IS NOT NULL AND p.shop_code IN (SELECT code FROM shops WHERE listed = 1)${shopSql}`, ...shopArgs)).c)
    : tags.length;
  ok(res, { tags, total, truncated });
}));

/**
 * 本店在用**商品参数**清单（公开只读）：供店铺页做参数筛选面（"成色 → 全新未拆封 ×3"）。
 *
 * 与 `/tags` 同一套口径与同一条展示形选取规则（只数上架商品、不按库存过滤、
 * 展示形取"多数写法，并列取字典序最小"、排序稳定、**列一律声明 utf8mb4_bin**），
 * 差别只有两处：
 *   1. **参数是二维的**（名字 × 值），所以按 `(name_key, value_key)` 成对计数，
 *      每项同时给名与值两侧的键（`?attr=名:值` 用的就是这一对）与展示形（界面直接显示）；
 *   2. 两个键**不是独立的列**，而是从索引键 `pair`（`nameKey + NUL + valueKey`）里切出来的：
 *      `SUBSTRING_INDEX(pair, CHAR(0), 1 / -1)`。为什么不去 `LOWER(name)` 现折：
 *      那会引入**第二个**折大小写的实现（MySQL 的 LOWER 连全角/西里尔一起折），
 *      与 `src/tags.js` 的口径分叉——切 `pair` 用的则是写入时那一份键，天然同源。
 *      切分无歧义的前提是名/值里不可能出现 NUL（cleanLabel 把控制字符折成空格，见 src/attributes.js）。
 *
 * 排序：`name_key` 升序 → `count` 降序 → `value_key` 升序。
 * 为什么按**名**先排（而不是像标签那样按 count）：界面是按参数名分组的（成色一组、产地一组），
 * 先按名排才能让同名的值稳定地连在一起；组内按出现次数排，最常出现的值排最前。
 * 仍然是全序、仍然不含展示形——同库多次调用逐字相同。
 *
 * 分页与三态：`limit` 缺省 {@link ATTRS_LIMIT_DEFAULT}、上限 {@link ATTRS_LIMIT_MAX}（非法值明确拒绝）；
 * 响应 `{ attributes: [{ name, nameKey, value, valueKey, count }], total, truncated }`，
 * `total` = **按 (名,值) 对去重后的总数**（截断时前端必须知道还有多少没显示）。
 */
const ATTRS_LIMIT_DEFAULT = 200;
const ATTRS_LIMIT_MAX = 500;

/** 分面展开用的一段 JSON_TABLE 子查询（`p.attributes` → 行；三个列都按字节序，见 /tags 的说明）。
 *  `jt.pair IS NOT NULL` 与 /tags 的 `jt.k IS NOT NULL` 同一条口径：形状不对的元素
 *  （只可能来自手写 SQL）在 DTO 侧也进不了列表，分面不该单独把它们算进去。 */
const ATTRS_FACET_FROM = `products p
       JOIN JSON_TABLE(p.attributes, '$[*]' COLUMNS (
              pair  VARCHAR(128) COLLATE utf8mb4_bin PATH '$.pair',
              name  VARCHAR(64)  COLLATE utf8mb4_bin PATH '$.name',
              value VARCHAR(128) COLLATE utf8mb4_bin PATH '$.value')) AS jt`;

router.get('/attributes', listedShopScope, wrap(async (req, res) => {
  const raw = req.query.limit;
  const limit = raw === undefined || raw === '' ? ATTRS_LIMIT_DEFAULT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > ATTRS_LIMIT_MAX) {
    return fail(res, `limit 需为 1..${ATTRS_LIMIT_MAX} 的整数（缺省 ${ATTRS_LIMIT_DEFAULT}）`);
  }
  const db = getDb();
  const shopSql = req.shop ? ' AND p.shop_code = ?' : '';
  const shopArgs = req.shop ? [String(req.shop.code)] : [];
  const rows = await db.all(`WITH active AS (
         SELECT SUBSTRING_INDEX(jt.pair, CHAR(0), 1) AS name_key, jt.name AS name_display,
                SUBSTRING_INDEX(jt.pair, CHAR(0), -1) AS value_key, jt.value AS value_display
           FROM ${ATTRS_FACET_FROM}
          WHERE p.active = 1 AND jt.pair IS NOT NULL
              AND p.shop_code IN (SELECT code FROM shops WHERE listed = 1)${shopSql}
       ),
       counts AS (
         SELECT name_key, name_display, value_key, value_display, COUNT(*) AS c
           FROM active GROUP BY name_key, name_display, value_key, value_display
       ),
       best AS (
         SELECT name_key, name_display, value_key, value_display, c,
                ROW_NUMBER() OVER (PARTITION BY name_key, value_key ORDER BY c DESC, name_display ASC, value_display ASC) AS rn
           FROM counts
       ),
       /* counts 是按「键 + 展示形」分组的，同一对键可能有多种写法（iPhone 15 / iphone 15）——
          总数必须**按键对求和**，否则 count 只等于"被选中的那种写法"的条数（测试抓过：3 件写成两种写法时印 2）。
          这与 /tags 的 totals CTE 是同一个理由。 */
       totals AS (
         SELECT name_key, value_key, SUM(c) AS count FROM counts GROUP BY name_key, value_key
       )
       SELECT b.name_display AS name, t.name_key AS nameKey,
              b.value_display AS value, t.value_key AS valueKey, t.count AS count
         FROM totals t JOIN best b ON b.name_key = t.name_key AND b.value_key = t.value_key AND b.rn = 1
        ORDER BY t.name_key ASC, t.count DESC, t.value_key ASC
        LIMIT ?`, ...shopArgs, limit + 1);
  const truncated = rows.length > limit;
  // SUM() 是 DECIMAL ⇒ 字符串；显式转换（与 /tags 同一条纪律）
  const attributes = (truncated ? rows.slice(0, limit) : rows).map((r) => ({
    name: r.name,
    nameKey: r.nameKey,
    value: r.value,
    valueKey: r.valueKey,
    count: Number(r.count),
  }));
  const total = truncated
    ? // 派生表必须有别名（MySQL 硬性要求：`Every derived table must have its own alias`）
      Number((await db.get(`SELECT COUNT(*) AS c FROM (
             SELECT SUBSTRING_INDEX(jt.pair, CHAR(0), 1) AS name_key, SUBSTRING_INDEX(jt.pair, CHAR(0), -1) AS value_key
               FROM ${ATTRS_FACET_FROM}
              WHERE p.active = 1 AND jt.pair IS NOT NULL
              AND p.shop_code IN (SELECT code FROM shops WHERE listed = 1)${shopSql} GROUP BY name_key, value_key) AS pairs`, ...shopArgs)).c)
    : attributes.length;
  ok(res, { attributes, total, truncated });
}));

/**
 * 「这件商品**还缺什么**」的**唯一判据**（SQL 表达式，别名 `p`）。
 *
 * 为什么是 SQL 而不是 JS：它有两个消费方——卖家列表的筛选（`?incomplete=1`，服务端分页过滤）
 * 与逐行提示。写在 JS 里就只能先把整页取回来再过滤，于是"筛出来的条数"与"翻页"两套语义
 * （返回不满一页但后面还有）。写成一段表达式则两个用途读的是同一份判据，不可能说岔。
 *
 * 判据（每一条都对应"买家看不到/看不懂就会问店主"的东西）：
 *  · `media`        没有主图——商品卡与详情页都是一张占位图；
 *  · `description`  没有说明（纯文本摘要为空；详情块为空时 DTO 的 description 就是它）；
 *  · `attributes`   没有参数——"这货是什么"只剩自由文本，仲裁时无法逐条对照；
 *  · `handling_days` 未承诺发货时效（**仅实物**：数字/NFT 没有"发货"这件事）。
 *
 * 空串 = 资料齐全。键名是稳定标识（前端映射成中文标签，措辞只有一处）。
 *
 * 两处 MySQL 形状值得写下来（都是"看起来等价、其实不是"的类型）：
 *  · 数组长度用 `JSON_LENGTH`（不是 SQLite 的 `json_array_length`），且**不需要 COALESCE**：
 *    这几列都是 `JSON NOT NULL DEFAULT ('[]')`——"读不到"在 schema 层就不可表达；
 *  · `handling_days` 判空必须同时看两种空：`JSON_EXTRACT(...) IS NULL`（键缺失 ⇒ SQL NULL）
 *    与 `JSON_TYPE(...) = 'NULL'`（`normalizeTerms` 把"未声明"写成 **JSON null**，
 *    而 MySQL 的 `JSON_EXTRACT(...) IS NULL` 对 JSON null 为**假**）。
 *    只写前者的话，未承诺发货时效的实物商品会**静默不再被筛出来**（"资料不全"队列少一批）。
 */
export const COMPLETENESS_MISSING_SQL = `TRIM(CONCAT(
  CASE WHEN JSON_LENGTH(p.media) = 0 THEN 'media ' ELSE '' END,
  CASE WHEN TRIM(p.description) = '' THEN 'description ' ELSE '' END,
  CASE WHEN JSON_LENGTH(p.attributes) = 0 THEN 'attributes ' ELSE '' END,
  CASE WHEN p.kind = 'physical' AND (JSON_EXTRACT(p.terms, '$.handling_days') IS NULL
                                     OR JSON_TYPE(JSON_EXTRACT(p.terms, '$.handling_days')) = 'NULL')
       THEN 'handling_days ' ELSE '' END
))`;

/**
 * 店主全量列表（含已下架与草稿，卖家面板管理用；需 owner 登录）—— 必须在 /:slug 之前注册。
 *  额外附池口径统计（poolBuilt/poolUnused，仅 digital/nft）：卖家设的总量承诺 vs
 *  码池/NFT 交付池实际未用资源——供面板做「口径冲突预警」（池未用 < 可售余量提示补货）。
 *  公开列表/详情不返回该字段（交付池资源是店主持有信息）。
 *
 *  可选 `q`：标题/标识的模糊搜索。**为什么在服务端**：面板是分页拉的，前端过滤只能搜到
 *  "已加载的那几页"——商品一多就等于搜不到（与本仓"没拉到 ≠ 没有"的三态纪律同一取向）。
 *
 *  额外附 `pendingPromises`（**仅 staff 视图**）：该商品每个组合上"库存承诺还没结清"的单数与件数
 *  （判据是 `stockHold.stockPromiseSql` 的唯一实现）。它是商品编辑表单"改规格选项名之前该先看一眼"
 *  的读数：改选项名会换掉组合键，而服务端会**拒绝**删除仍被在途订单占用的组合
 *  （见 PATCH 的规格键守卫）。前端据此**提前**提示，而不是等保存时才撞上拒绝——
 *  判据仍只有服务端一处，这里只是把它下发给店主看。 */
router.get('/all', staffOnly, wrap(async (req, res) => {
  const cursor = Math.max(0, parseInt(req.query.cursor, 10) || 0);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  const q = String(req.query.q ?? '').trim().slice(0, 60);
  /*
    只看"资料不全"的（店主补资料的工作队列）。判据是 COMPLETENESS_MISSING_SQL 那一处——
    与行内下发的 `missing` 同源，所以"筛出来 3 条"与"这 3 条各自缺什么"必然一致。
  */
  const incompleteOnly = String(req.query.incomplete ?? '') === '1';
  /*
    店铺维度是**安全边界**（与公开列表相反：这里是"只看本店"）：
    `GET /all` 是店主的商品管理列表，多店之下不加这一条就会把**别家店**的商品
    （含未上架的草稿与池口径读数）一并列出来。判据放第一个，参数顺序与 SQL 一致。
  */
  const where = ['p.id > ?', 'p.shop_code = ?'];
  const args = [cursor, String(req.shop.code)];
  if (incompleteOnly) where.push(`(${COMPLETENESS_MISSING_SQL}) != ''`);
  if (q) {
    /*
      LIKE 通配符转义（与公开列表同一口径）。
      **店主侧的搜索面比买家侧宽**：买家按标题/描述找货，店主是在自己店里找"那一件"
      ——他手里的线索可能是标题、对外标识（分享链接里那串）、描述里的一句话，或参数里的值
      （"上次那件成色全新未拆封的"）。四种都命中，否则他只能一页页翻。
      参数与承诺是 JSON 列：这里对**列文本**做 LIKE，不解析。文本形态由 MySQL 决定——对象键按键长/字节
      重排、`": "` 之间**带空格**、控制字符转义成 `\uXXXX`（实测 `"name": "成色"` 命中、`"name":"成色"` 不命中）。
      所以能可靠搜到的是**字段值**（"全新未拆封"、"no-reason"）——那正是店主的用法（他记得的是那句话，
      不是 JSON 的标点）；带标点的片段只在碰巧与 MySQL 的写法逐字相同时才命中，不当承诺用。

      ⚠️ **五个谓词各自都要 `COLLATE utf8mb4_0900_ai_ci`**（2026-10-16 补，与公开列表 `:1014` 同规约）：
      本库的库级排序规则是 `utf8mb4_0900_as_cs`，不写 COLLATE 的 LIKE 就是**大小写敏感**的
      ——`?q=asus` 空、`?q=ASUS` 命中。店主照着商品标题的小写去搜自己的商品会搜不到，且不报错；
      而"搜索"这个动作的语义本来就是大小写不敏感，所以它属于**谓词**，必须写在谓词上
      （R5 选 as_cs 作库级规则时定下的例外方式：库级只有一种，例外在查询里看得见）。
      **`p.slug` 也一并写**：slug 是 Crockford 大写，店主从小写化的分享链接里粘过来时同样要命中。
    */
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    where.push(
      "(p.title COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\'" +
        " OR p.slug COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\'" +
        " OR p.description COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\'" +
        " OR p.attributes COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\'" +
        " OR p.terms COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\')"
    );
    args.push(like, like, like, like, like);
  }
  const rows = await getDb().all(`SELECT p.*, (${COMPLETENESS_MISSING_SQL}) AS missing_keys,
         (SELECT COUNT(*) FROM product_codes c WHERE c.product_id = p.id) AS codes_built,
         (SELECT COUNT(*) FROM product_codes c WHERE c.product_id = p.id AND c.status = 'unused') AS codes_unused,
         (SELECT COUNT(*) FROM product_nft_tokens t WHERE t.product_id = p.id) AS tokens_built,
         (SELECT COUNT(*) FROM product_nft_tokens t WHERE t.product_id = p.id AND t.status = 'unused') AS tokens_unused
       FROM products p WHERE ${where.join(' AND ')} ORDER BY p.id ASC LIMIT ?`, ...args, pageSize);
  /*
    在途承诺：一次 GROUP BY 取回本页全部商品（不逐行查 = 不引入 N+1）。
    没结清的单一件都没有 → 该商品不下发这个键之外的空数组（前端拿到 [] 即"改规格无阻碍"）。
  */
  const pendingByProduct = new Map();
  if (rows.length) {
    const marks = rows.map(() => '?').join(',');
    const pending = await getDb().all(`SELECT o.product_id AS pid, o.sku_key AS sku_key, COUNT(*) AS orders, COALESCE(SUM(o.quantity), 0) AS units
           FROM orders o
          WHERE o.product_id IN (${marks}) AND ${stockPromiseSql('o')}
          GROUP BY o.product_id, o.sku_key`, ...rows.map((r) => r.id));
    for (const p of pending) {
      const list = pendingByProduct.get(p.pid) || [];
      // COUNT 是整数、SUM 是 DECIMAL（驱动给字符串）——两个都显式转换，别让 "3" 流到店主的界面上
      list.push({ key: String(p.sku_key ?? ''), orders: Number(p.orders), units: Number(p.units) });
      pendingByProduct.set(p.pid, list);
    }
  }
  // 池口径：poolBuilt=已建池资源总数（0=未建池，手动交付型）；poolUnused=未用数（0 且已建池=池空）
  const products = await Promise.all(rows.map(async (r) => {
    const base = await rowToPublic(r);
    const alert = r.stock_alert_at;
    // 低库存：**任一组合**余量 ≤ 阈值即算（价格与库存逐组合不同，只看商品级汇总
    // 会把「A 组合还剩 1 件、B 组合还很多」的情况漏掉——那恰恰是最该提醒的）
    const lowStock =
      alert !== null &&
      base.skus.some((s) => s.capacity !== null && s.capacity - s.committed <= alert);
    return {
      ...base,
      // 经营配置（仅店主视图）：自动交付行级开关/低库存阈值/低库存标记
      autoDeliver: r.auto_deliver,
      stockAlertAt: r.stock_alert_at,
      lowStock,
      pendingPromises: pendingByProduct.get(r.id) ?? [],
      /*
        这件商品还缺哪些资料（空数组 = 齐全）。键名是稳定标识，中文标签由前端一处映射；
        判据就是筛选用的那一段 SQL（`missing_keys` 列）——"筛出来的是这几条"与"它们各自缺什么"
        因此必然一致，不需要两处判断。
      */
      missing: String(r.missing_keys || '').trim() ? String(r.missing_keys).trim().split(/\s+/) : [],
      ...(r.kind === 'digital'
        ? { poolBuilt: Number(r.codes_built), poolUnused: Number(r.codes_unused) }
        : r.kind === 'nft'
          ? { poolBuilt: Number(r.tokens_built), poolUnused: Number(r.tokens_unused) }
          : { poolBuilt: null, poolUnused: null }),
    };
  }));
  const last = rows.length ? rows[rows.length - 1].id : null;
  ok(res, { products, nextCursor: last, rates: null });
}));

/**
 * 公开读的可见性判据（**商品详情与评价列表共用**，2026-10-22 复审）。
 *
 * 商品从公开视野消失有三条独立路径：店主下架（`active = 0`）、协议侧链上冻结
 * （Blocklist 的 Product 类）、所属店铺暂停/退出（`shops.listed != 1`）。
 * 详情页三条都查，而评价列表此前只查"这一行存在"⇒ 下架/冻结商品的评价仍能被匿名读取，
 * 且 200/404 的差别成了一个"这件商品存在过"的 oracle。
 *
 * 返回 `null` = 可见；否则返回给调用方的拒绝描述。`mine`（本店经营人员）只有详情页会传：
 * 店主必须看得见自己被冻结/下架的商品；评价列表是匿名读，没有这个豁免。
 */
async function publicProductGate(row, { mine = false } = {}) {
  if (!row.active && !mine) return { status: 404, code: 404, message: '商品不存在或已下架' };
  if (mine) return null;
  /*
    链上名单的商品类条目（**详情页同样要查**，2026-10 自审补）：
    只在列表里过滤 = 半个过滤——列表看不到、直链进来照样能下单，
    而被冻结的正是"要通过直链传播"的那类商品。判据与列表共用同一份名单与同一段读法。
    读不到名单 ⇒ 与列表同一条纪律：**拒绝**，不按"名单里没有它"放行。
  */
  if (config.chain.blocklistAddress) {
    let hit;
    try {
      hit = (await blockedProductSlugs()).has(String(row.slug));
    } catch (e) {
      return {
        status: 404,
        code: 404,
        message: `读不到链上黑名单（${e?.message || e}）：无法确认这件商品是否已被全网冻结，本次按 fail-closed 不返回内容`,
      };
    }
    if (hit) return { status: 404, code: 404, message: '该商品已被全网冻结，不再展示' };
  }
  const shop = await shopRowByCode(row.shop_code);
  if (!shop || Number(shop.listed) !== 1) {
    return { status: 200, code: 200, message: notSellableReason(shop) };
  }
  return null;
}

/**
 * 商品详情（公开；已下架商品仅本店店主/店员登录可见——匿名与第三人 404，防下架内容被探测/收录）。
 *
 * ⚠️ 这是**公开**端点，所以**不能**用 `requireShopProduct`（那个按请求解析出的店铺上下文判归属）：
 * 匿名请求根本没有店铺上下文。归属在这里是另一件事——"这件商品属于哪家店"由 `row.shop_code`
 * 回答，而"谁能预览未上架/已停售的东西"由 `isStaff(addr, row.shop_code)` 回答。
 *
 * 三种不可见要分开说（`listed = 0` 与"商品已下架"是两件事，混成一句会让店主去改错地方）：
 *   · 商品没上架 → 404（既有语义：下架内容不该被探测）；
 *   · 所属店铺暂停接单 → **可读原因**（不是 404）：买家点进一个已经发出去的链接时，
 *     要能知道"这家店暂时不接单了"，而不是以为链接坏了或商品没了。
 */
router.get('/:slug', wrap(async (req, res) => {
  const row = await getDb().get('SELECT * FROM products WHERE slug = ?', String(req.params.slug || ''));
  if (!row) return fail(res, '商品不存在', 404, 404);
  let authed = null;
  try {
    const t = bearerToken(req);
    if (t) authed = verifyToken(t);
  } catch {
    authed = null;
  }
  const mine = !!authed && (await isStaff(authed.address, row.shop_code));
  const gate = await publicProductGate(row, { mine });
  if (gate) return fail(res, gate.message, gate.status, gate.code);
  const r = await rowToPublic(row);
  const stats = await productReviewSummary(row.id);
  ok(res, { ...r, reviewSummary: stats });
}));

/** 商品评价列表（公开；**服务端**筛选 + 排序 + 分页，见 src/reviews.js） */
router.get('/:slug/reviews', wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 10));
  const filter = ['all', 'good', 'bad'].includes(String(req.query.filter))
    ? String(req.query.filter)
    : 'all';
  const sort = ['new', 'old', 'high', 'low'].includes(String(req.query.sort))
    ? String(req.query.sort)
    : 'new';
  /*
    公开读的可见性判据与详情页**共用一处**（`publicProductGate`）：评价列表不能成为
    "商品还在不在"的第二条信息通道——下架/被链上冻结的商品，评价同样不可匿名读取。
    这里没有 `mine` 豁免（匿名接口），**隐藏类**拒绝一律按 404 处理：
      · 下架 / 链上冻结 / 店铺已退出（`status:404`）⇒ 404，不泄露存在性；
      · 店铺**暂停接单**（`status:200`）⇒ 详情页本来就按"可读原因"展示这件商品，
        评价随详情一起保持可见（隐藏它反而与详情页自相矛盾，也不是本判据要挡的泄露面）。
  */
  const row = await getDb().get('SELECT * FROM products WHERE slug = ?', String(req.params.slug || ''));
  if (!row) return fail(res, '商品不存在', 404, 404);
  const gate = await publicProductGate(row);
  if (gate && gate.status === 404) return fail(res, gate.message, 404, 404);
  const data = await productReviews(row.slug, page, pageSize, filter, sort);
  if (!data) return fail(res, '商品不存在', 404, 404);
  ok(res, data);
}));

/** 店主上架（**暂停接单的店铺不能上架**：那是"影响未来销售"的动作，判据见 requireSellable） */
router.post('/', staffOnly, wrap(async (req, res) => {
  if (!requireSellable(req, res)) return;
  const unknown = unknownKeysError(req.body, PRODUCT_WRITE_KEYS, '上架商品（POST /api/products）');
  if (unknown) return fail(res, unknown);
  const { errors, value } = validateProduct(req.body || {});
  if (errors.length) return fail(res, errors.join('；'));
  const db = getDb();
  /*
    商品标识 = `P` + 10 位 Crockford Base32 随机（11 字符、无连字符，见 src/ids.js）。
    它是对外的稳定标识（URL / 快照 / 评价都挂在它上面），也是 `products.slug CHAR(11)` 的**全部取值**：
       · 不掺标题（中文标题转写千奇百怪，改标题也不该改标识）；
       · 不带时间（会向无关的人泄露"何时上架"，同批上架的还会前缀雷同）；
       · 只用不容易念错的字符集（无 I/L/O/U）。
    旧形状里存在过的 `p-<12hex>` 之类的标识不必再兼容：本库没有历史数据，slug 一律由这里生成。
  */
  const slug = newProductSlug();
  /*
    商品行与它的 SKU 行**同一次提交**：分开写时任何一步失败都留下"有商品行、没有 SKU 行"的半成品——
    它在列表里看得见、点进去却下不了单（没有可选组合），而错只出现在那一次响应里。
    标签与参数不存在"另写一处镜像"的问题：它们与商品行同列，`JSON.stringify` 一起进去。
    `insertId` 取 AUTO_INCREMENT 分配到的 id，不再回读 `SELECT id … WHERE slug`（那多一次往返）。
    归属来自**鉴权中间件解析出的店铺上下文**（请求头指的、或这个地址唯一经营的那家）：
    多店之后"这件货是谁家的"只能由那家店回答，而它同时是授权判据（见 requireShopProduct），
    也是 `shops(code)` 的外键。
  */
  await withTransaction(async () => {
    const ins = await db.run(
      'INSERT INTO products (slug, shop_code, title, description, description_blocks, media, kind, ' +
        'shipping_fee_usdt_micro, age_restricted, nft_contract, nft_standard, specs, attributes, terms, tags, ' +
        `snapshot_hash, auto_deliver, stock_alert_at, active, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${PUBLISHED_AT_FIRST})`,
      slug,
      String(req.shop.code),
      value.title, value.description, JSON.stringify(value.descriptionBlocks), JSON.stringify(value.media),
      value.kind, value.shippingFeeUsdtMicro, value.ageRestricted, value.nftContract, value.nftStandard,
      JSON.stringify(value.specs), JSON.stringify(value.attributes), JSON.stringify(value.terms),
      JSON.stringify(value.tags),
      // 占位：真哈希由下面这句按**读回值**算出并覆盖（见 refreshSnapshotHash 的说明）
      SNAPSHOT_HASH_UNSET, value.autoDeliver, value.stockAlertAt, value.active,
      // 首次上架时刻只在这两种情况下写：建单时就是"在售"（→ 服务器盖章），或建单时是草稿（→ NULL，等第一次上架再写）
      value.active
    );
    await saveSkus(ins.insertId, value.skus);
    await refreshSnapshotHash(ins.insertId);
  });
  await audit(req, 'product.create', 'product', slug, { kind: value.kind, skuCount: value.skus.length, specs: value.specs.map((s) => s.name), tags: value.tags.map((t) => t.display), shippingFeeUsdtMicro: value.shippingFeeUsdtMicro, ageRestricted: value.ageRestricted, active: value.active });
  ok(
    res,
    await rowToPublic(await db.get('SELECT * FROM products WHERE slug = ?', slug)),
    value.active ? '上架成功' : '已存为草稿（买家看不到；在商品列表里点「上架」后才会出现在聚合首页）'
  );
}));

/** 店主批量更新（P1-②：改价/上下架/经营开关；安全字段子集——不动 kind/合约/池语义）。
 *  patch 字段非法 → 整体拒绝；个别 slug 不存在 → 记 failed 并跳过（成功行照常写入，逐行快照重算）。 */
router.patch('/batch', staffOnly, wrap(async (req, res) => {
  if (!requireSellable(req, res)) return;
  const db = getDb();
  const slugs = [...new Set((req.body?.slugs || []).map((x) => String(x)).filter(Boolean))];
  // 超限显式拒绝而非静默截断与 batch-ship「超限即拒」原则一致——
  // 静默截断会让卖家误以为跨页全选 >100 件已全部生效）
  if (slugs.length > 100) {
    return fail(res, `批量修改单次上限 100 件（实际 ${slugs.length} 件）——请分批操作`);
  }
  if (!slugs.length) return fail(res, 'slugs 需为非空数组（≤100）');
  const b = req.body?.patch || {};
  if (typeof b !== 'object' || !Object.keys(b).length) return fail(res, 'patch 需为 {priceUsdtMicro?/active?/autoDeliver?/stockAlertAt?}');
  const unknownPatch = unknownKeysError(b, PRODUCT_BATCH_PATCH_KEYS, '批量修改（PATCH /api/products/batch 的 patch）');
  if (unknownPatch) return fail(res, unknownPatch);
  // 字段合法性（整体校验）
  if (b.priceUsdtMicro !== undefined) {
    const micro = Number(b.priceUsdtMicro);
    if (!Number.isInteger(micro) || micro <= 0 || micro > PRICE_MAX_MICRO) {
      return fail(res, `priceUsdtMicro 需为 1..${PRICE_MAX_MICRO} 整数（单位：微 USDT，即最多 ${PRICE_MAX_USDT} USDT）`);
    }
  }
  if (b.active !== undefined && ![true, false, 0, 1].includes(b.active)) return fail(res, 'active 需为布尔');
  if (b.autoDeliver !== undefined && ![-1, 0, 1].includes(Number(b.autoDeliver))) return fail(res, 'autoDeliver 需为 -1/0/1');
  if (b.stockAlertAt !== undefined && b.stockAlertAt !== null && b.stockAlertAt !== '') {
    const n = Number(b.stockAlertAt);
    if (!Number.isInteger(n) || n < 0 || n > 10000000) return fail(res, 'stockAlertAt 需为 0..1e7 整数');
  }

  const failed = [];
  const updated = [];
  for (const slug of slugs) {
    /*
      每个商品的处理（取行 → 改价 → **读回后重算快照哈希** → 写回）关在**同一个事务**里：
      读在事务外时，并发的 PATCH /:slug（改规格/改价/停售某组合）可以落在"读 SKU 行"与
      "写 snapshot_hash"之间，于是写下去的哈希描述的是**另一份内容**——买家侧立刻报
      「商品内容已被修改」，而店主只是点了批量改价。判据挂在事务上，不挂在调用点记得先读。
    */
    const r = await withTransaction(async () => {
      const row = await db.get('SELECT * FROM products WHERE slug = ?', slug);
      if (!row) return { failed: '商品不存在' };
      /*
        归属校验**逐件**做（同一处判据：`products.shop_code == req.shop.code`）：
        批量接口的入参是 slug 列表，全部来自调用方——不校验就等于给了"用别人的 slug 改价"一条路。
        与单个 PATCH 的差别只是失败粒度（这里进 failed[] 而不是整批 403），判据本身同源。
      */
      if (String(row.shop_code) !== String(req.shop.code)) {
        return { failed: '该商品不属于本店' };
      }
      const nextActive = b.active !== undefined ? (b.active === false || b.active === 0 ? 0 : 1) : row.active;
      const nextAutoDeliver = b.autoDeliver !== undefined ? Number(b.autoDeliver) : row.auto_deliver;
      const nextStockAlertAt =
        b.stockAlertAt !== undefined
          ? b.stockAlertAt === null || b.stockAlertAt === ''
            ? null
            : Number(b.stockAlertAt)
          : row.stock_alert_at;
      // 批量改价：作用于该商品的**全部组合**（批量页不展开规格明细；逐组合定价走单个 PATCH /:slug）
      if (b.priceUsdtMicro !== undefined) {
        await db.run('UPDATE product_skus SET price_usdt_micro = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = ?', Number(b.priceUsdtMicro), row.id);
      }
      /*
        首次上架时刻与单商品 PATCH 共用同一段 SQL（见 PUBLISHED_AT_KEEP）：已有值保留、
        无值且在售则服务器盖章、无值且未上架保持 NULL。
      */
      await db.run(
        `UPDATE products SET active = ?, auto_deliver = ?, stock_alert_at = ?, published_at = ${PUBLISHED_AT_KEEP}, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        nextActive, nextAutoDeliver, nextStockAlertAt, nextActive, row.id
      );
      /*
        快照哈希**在这一步之后按读回值重算**：直接读整行 + SKU 行交给 snapshotObject。
        这里曾经手挑字段（只列了 slug/title/description/images/kind/… 与改价后的 sku 行），
        漏 description_blocks 会让"带详情块的商品一改价就报内容被改"，漏 image_url 会让
        "批量改一次价，所有规格图从快照里消失"——两种都是同一类错误：**哈希的输入与 DTO 的输入不是同一份**。
        现在哈希的输入只有 refreshSnapshotHash 一处，那条错误路径在形状上不可表达。
      */
      await refreshSnapshotHash(row.id);
      return { updated: true };
    });
    if (r.failed) failed.push({ slug, reason: r.failed });
    else updated.push(slug);
  }
  /*
    审计必须在**写响应之前**：反过来的顺序（旧形状）让"响应之后还能抛错"成为一条真实路径——
    `logAudit` 里少数会抛的错（shop_code 指向不存在的店、调用方漏给归属）会在 `ok()` 之后
    冒出 ERR_HTTP_HEADERS_SENT，进而变成 unhandledRejection 把整个进程带下去。
  */
  await audit(req, 'product.batch', 'product', updated.join(',') || '-', { updated: updated.length, failed: failed.length });
  ok(res, { updated, failed }, updated.length ? `已更新 ${updated.length} 个商品` : '无商品被更新');
}));

/** 店主更新（改价/改描述/下架 active=false 等；快照字段变更后自动重算 hash） */
router.patch('/:slug', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const row0 = await requireShopProduct(req, res);
  if (!row0) return;
  const b = req.body || {};
  const unknown = unknownKeysError(b, PRODUCT_WRITE_KEYS, `编辑商品（PATCH /api/products/${req.params.slug}）`);
  if (unknown) return fail(res, unknown);
  /*
    ── 整段「读 → 判 → 写」必须在**同一个事务**里 ──

    这条路径上有三处**先读后写**的判据，读与写之间不能有别的写者插进来：
      1. `product_skus` 的旧行（`prevSkuMap`：capacity 与 committed）——它同时决定
         「库存不得改小于已占位」这道闸与 `saveSkus` 继承多少 committed；
      2. `willRestrict` 的**在途量**（`inFlight`）——它决定 `committed` / `hold_qty` 这一次补记多少；
      3. 交付池的 `COUNT(*)`（kind / nft_standard / nft_contract 三个变更闸）——它决定「这次改型
         会不会让在途 NFT 单再也交付不了」。
    读在事务外时，一次并发的**导池**或**买家下单占位**可以落在读与写之间：闸按旧计数放行、
    写按旧值落库 ⇒ 超卖（1、2）或把在途 NFT 单变成永远交付不了的僵死单（3），
    而三条路径都不会报任何错。MySQL 下写事务真的会并发跑在不同连接上，所以判据必须由
    **行级锁**串起来（2026-10-16 起没有全局写锁了）：本事务先锁住商品行与组合行，
    读与写之间就没有别的写者能改动这三处读数（见下面的取锁语句）。

    商品行本身同样要在事务内**重读**（下面那句）：本次编辑是"基于现有行做部分更新"，
    拿进事务之前取的那一行拼 merged，会把并发的另一次 PATCH 已改过的字段整批盖回去（丢更新）。
    身份字段（id / slug / shop_code）不会变，`row0` 只用来定位与做归属校验。

    事务回调里**不得 await 数据库以外的东西**（RPC/网络/计时器，见 db.js）：本段全是纯 JS 校验
    与本地读写，符合这条约束。下面的提前返回一律走 `abortTx`——走到那里时还没有任何写入，
    回滚零代价，但语义明确："这次编辑整体没有发生"。
  */
  const out = await withTransaction(async () => {
    /*
      **先锁住商品行与组合行**（行级锁；全局写锁已删，这三处"先读后判"的判据必须由行锁串起来）：
        · 商品行 `FOR UPDATE` —— 导池（往 product_codes / product_nft_tokens 插行时取**外键共享锁**）
          与本锁互斥，于是下面"池里到底有没有资源"这个读数在"改型/换合约"落库之前不会被推翻；
        · 组合行 `FOR UPDATE` —— 下单占位与释放（`holdStock` / `releaseCore` 都改 product_skus）
          与本锁互斥，于是"已占位多少 / 在途多少"这两个读数同样不会被推翻。
      锁序固定为「商品行 → 组合行」：下单路径（池占位改商品行、限量占位改组合行）也是这个顺序，
      两条路径因此不会互等成环。代价：本事务期间这几行被别人挡住——它们本来就要被这次编辑改。
    */
    const row = await db.get('SELECT * FROM products WHERE id = ? FOR UPDATE', row0.id);
    if (!row) return abortTx({ fail: '商品不存在' });
    await db.all('SELECT id FROM product_skus WHERE product_id = ? FOR UPDATE', row.id);
    const prevSkuRows = await loadSkus(row.id);
    const prevSkuMap = new Map(prevSkuRows.map((s) => [s.sku_key, s]));
    const merged = {
      title: b.title !== undefined ? b.title : row.title,
      description: b.description !== undefined ? b.description : row.description,
      // 详情块：未提交则沿用现有（DB 读回值 → API 形状）。有块时 description 由块派生。
      descriptionBlocks: b.descriptionBlocks !== undefined ? b.descriptionBlocks : parseBlocks(row.description_blocks),
      media: b.media !== undefined ? b.media : parseMediaColumn(row.media),
      kind: b.kind !== undefined ? b.kind : row.kind,
      // 运费（按单收取一次；0=包邮）与年龄限制：未提交则沿用现值——它们是快照字段，
      // 漏传等于把商品悄悄改回包邮/无限制（买家手里的哈希随即对不上）
      shippingFeeUsdtMicro: b.shippingFeeUsdtMicro !== undefined ? b.shippingFeeUsdtMicro : row.shipping_fee_usdt_micro,
      ageRestricted: b.ageRestricted !== undefined ? b.ageRestricted : row.age_restricted,
      // NFT 两列是**三态**（NULL = 非 NFT，不是空串）：未提交就沿用现值，
      // 校验层再按 kind 决定最终写什么（非 NFT 一律写回 NULL）
      nftContract: b.nftContract !== undefined ? b.nftContract : row.nft_contract,
      nftStandard: b.nftStandard !== undefined ? b.nftStandard : row.nft_standard,
      // 规格与 SKU：未提交则沿用现有（DB 行 → API 形状）
      specs: b.specs !== undefined ? b.specs : parseSpecsColumn(row),
      // SKU 支持**部分更新**：只提交要改的组合即可（按 key 覆盖到现有列表上）；
      // 省略 priceUsdtMicro / capacity 时沿用该组合的现值。
      // 只改某组合库存时不必重发全部组合与价格——重发既啰嗦，也容易把别的组合写错。
      skus:
        b.skus !== undefined
          ? (() => {
              const base = prevSkuRows.map((s) => ({
                key: s.sku_key,
                priceUsdtMicro: s.price_usdt_micro,
                capacity: s.capacity,
                /*
                  **必须带上 active**（源码审计 2026-09 复审，P1）：漏掉它时 `prev.active` 是
                  `undefined`，而下面那句 `prev.active !== false` 对 undefined 为**真** ⇒
                  未显式提交 active 的组合被当作"要上架"，最终 `saveSkus` 按
                  「`rawSku?.active === undefined ? true : …`」落库 active=1。
                  触发路径是前端真实操作：卖家单独停售某规格后，点一次商品上下架
                  （前端只发 `{active:false}` / `{active:true}`）就把它**静默重新上架**。
                */
                active: s.active !== 0,
                // 同理必须带上 imageUrl：它是快照字段（`sku_images`），漏了就等于"改一次库存把规格图全删了"
                imageUrl: s.image_url,
              }));
              const byKey = new Map(base.map((s) => [s.key, s]));
              for (const s of Array.isArray(b.skus) ? b.skus : []) {
                const key = String(s?.key ?? '').trim();
                const prev = byKey.get(key) || { priceUsdtMicro: undefined, capacity: null, active: true, imageUrl: '' };
                byKey.set(key, {
                  key,
                  priceUsdtMicro: s?.priceUsdtMicro !== undefined ? s.priceUsdtMicro : prev.priceUsdtMicro,
                  capacity: s?.capacity !== undefined ? s.capacity : prev.capacity,
                  // 停售：该组合不再可下单，但不影响其它组合（与「售罄」是两回事）
                  active: s?.active !== undefined ? !!s.active : (prev.active !== false),
                  imageUrl: s?.imageUrl !== undefined ? s.imageUrl : prev.imageUrl,
                });
              }
              // specs 一旦变更，组合集合必须由提交方完整给出（否则会残留已不存在的旧组合）
              return b.specs !== undefined ? b.skus : [...byKey.values()];
            })()
          : // 整体更新（未提交 skus）同样要带上 active：否则每个组合都被当成"要上架"
            prevSkuRows.map((s) => ({
              key: s.sku_key,
              priceUsdtMicro: s.price_usdt_micro,
              capacity: s.capacity,
              active: s.active !== 0,
              imageUrl: s.image_url,
            })),
      autoDeliver: b.autoDeliver !== undefined ? b.autoDeliver : row.auto_deliver,
      stockAlertAt: b.stockAlertAt !== undefined ? b.stockAlertAt : row.stock_alert_at,
      // 标签：未提交则沿用现有（DB 读回值 → 展示形数组，再经写入侧归一现算键）；提交 `[]` = 显式清空
      // （与 media 同款三态：未提交=不动、提交空数组=清空）。归一化在 validateProduct → src/tags.js（唯一实现）
      tags: b.tags !== undefined ? b.tags : parseTagsColumn(row.tags),
      // 参数与承诺：三态与 media/tags 同款（未提交=不动、提交空数组/空对象=清空、提交内容=覆盖）。
      // 未提交时**必须**沿用现有值：它们是快照字段，漏传等于把商品悄悄改回"没有参数、没有承诺"
      // （买家手里的哈希随即对不上，而店主只是改了个标题）。
      attributes: b.attributes !== undefined ? b.attributes : parseAttributesColumn(row.attributes),
      terms: b.terms !== undefined ? b.terms : parseTermsColumn(row.terms),
      active: b.active !== undefined ? b.active : !!row.active,
    };
    // 已建交付池的商品禁止跨类型变更（码池/tokenId 池与 kind 绑定，避免履约语义错乱）；
    // 清空池 = DELETE /api/products/:slug/codes 或 /tokens（ownerOnly，见文件头与对应路由）
    if (merged.kind !== row.kind) {
      if (row.kind === 'digital') {
        const pool = await db.get('SELECT COUNT(*) AS c FROM product_codes WHERE product_id = ?', row.id);
        if (Number(pool.c) > 0) return abortTx({ fail: '该数字商品已配置兑换码池，不可变更类型；请先清空码池（DELETE /api/products/:slug/codes?confirm=1）' });
      }
      if (row.kind === 'nft') {
        const pool = await db.get('SELECT COUNT(*) AS c FROM product_nft_tokens WHERE product_id = ?', row.id);
        if (Number(pool.c) > 0) return abortTx({ fail: '该 NFT 商品已配置交付池，不可变更类型；请先清空交付池（DELETE /api/products/:slug/tokens?confirm=1）' });
      }
    }
    // NFT 商品已建交付池后禁止变更 NFT 标准（交付核验语义与池内库存绑定，避免 erc721/erc1155 错配）
    if (row.kind === 'nft' && merged.kind === 'nft' && merged.nftStandard !== row.nft_standard) {
      const pool = await db.get('SELECT COUNT(*) AS c FROM product_nft_tokens WHERE product_id = ?', row.id);
      if (Number(pool.c) > 0) {
        return abortTx({ fail: '该 NFT 商品已配置交付池，不可变更 NFT 标准（erc721/erc1155）；请先清空交付池（DELETE /api/products/:slug/tokens?confirm=1）' });
      }
    }
    // NFT 商品中途更换合约地址同样禁止（与 nft_standard 同规则）：订单快照锁定旧合约、
    // 池内 tokenId 也属旧合约，换址后旧快照订单永远无法通过核验交付（僵死 escrowed）
    if (
      row.kind === 'nft' && merged.kind === 'nft' &&
      String(merged.nftContract || '').toLowerCase() !== String(row.nft_contract || '').toLowerCase()
    ) {
      const pool = await db.get('SELECT COUNT(*) AS c FROM product_nft_tokens WHERE product_id = ?', row.id);
      if (Number(pool.c) > 0) {
        return abortTx({ fail: '该 NFT 商品已配置交付池，不可更换 NFT 合约地址；请先清空交付池（DELETE /api/products/:slug/tokens?confirm=1）' });
      }
    }
    const { errors, value } = validateProduct(merged);
    if (errors.length) return abortTx({ fail: errors.join('；') });
    /*
      ── 规格键变更必须被拦住（源码审计 2026-09 复审，P1）──

      `sku_key` 由规格选项值按声明顺序拼接（`skuKeyOf`）。**改一个选项名就换了一把键**，
      而 `saveSkus` 是按**同 key** 继承 `committed`（`prev.get(s.key)?.committed || 0`）：
         · 旧键那一行的 `committed`（已占位/已售）被静默丢弃 —— 新键从 0 起算；
         · 在途订单仍持**旧键**，既不在下面 `capacity >= committed` 的校验里（它只比同名键），
           也不在 `willRestrict` 的在途核算里（那个分支要求 `prevSkus` 里有同键条目）；
         · 这些单日后释放占位时 `(product_id, sku_key) IN (…)` 匹配不到 SKU 行，静默无操作。
      净效果：`capacity=2 / committed=0` 而 3 张在途单各持 1 件 → 再卖 2 件 = **5 件承诺对 2 件容量**。
      这正是文件下方那段注释（"否则余量虚高 → 超卖"）要防的事，只是被"换键"从旁边绕过了。

      修法：**只要还有订单占着即将消失的组合键，就拒绝这次规格变更**，并把计数与处置办法说清楚。
      不做"自动搬迁到新键"——旧键到新键之间没有可靠映射（可能是改名，也可能是拆分/合并），
      猜错就是替店主改了库存账。店主随时可以等这些单终结后再改。
    */
    {
      const newKeys = new Set(value.skus.map((s) => s.key));
      /*
        判据 = 「**这一单的库存承诺还没结清**」（`stockHold.stockPromiseSql` 的唯一实现），
        **不是**一串状态白名单。
        为什么（真实缺陷）：旧实现是 `hold_qty > 0 AND released_at IS NULL AND status IN DRAFT_OR_ACTIVE_IN`，
        漏掉了「**已交付后退款、货未回收**」的单（`releaseRefundedEscrow` 刻意不释放它——
        货在买家手里，需线下回收）。于是店主把规格选项名从「红」改成「深红」时，
        `saveSkus` 按**同 key** 继承 `committed` 继承不到，那一行的已占位数**静默归零**，
        同一件实物可被再卖一次（超卖）；触发者是店主的正常编辑动作，受害方是下一个买家，
        且没有任何错误码或审计痕迹。
        现状判据是并集（在途状态 ∨ 占位在册且退货未收到），方向安全：多算 ⇒ 更容易拒绝这次改名，
        而不是让 `committed` 变小（那才会超卖）。状态集今后增删也不会再漏。
      */
      const held = (await db.all(`SELECT sku_key, COUNT(*) AS c, SUM(quantity) AS q FROM orders o
            WHERE o.product_id = ? AND ${stockPromiseSql('o')}
            GROUP BY sku_key`, row.id))
        .filter((r) => !newKeys.has(String(r.sku_key ?? '')));
      if (held.length) {
        // SUM(quantity) 是 DECIMAL ⇒ 字符串（decimalNumbers:false）：显式转换后再进文案
        const detail = held.map((r) => `「${r.sku_key || '默认'}」${Number(r.c)} 单/${Number(r.q)} 件`).join('、');
        return abortTx({
          fail:
            `规格组合将被删除，但仍有在途订单占着这些组合的库存：${detail}。` +
            '改规格选项名会改变组合标识，这些单的占位将失去对应库存行（余量虚高 → 超卖）。' +
            '请先让这些订单走完（发货确认 / 取消 / 退款 / 超时释放），或保留原选项名只改价格与库存。',
        });
      }
    }
    // 编辑的是总量，不是余量：每个组合的总量不得小于该组合的已占位数
    // （committed 只由订单生命周期驱动——取消/退款/超时自动释放，编辑不释放，
    // 改小即制造矛盾账目）
    const prevSkus = prevSkuMap;
    for (const s of value.skus) {
      const cm = prevSkus.get(s.key)?.committed || 0;
      if (s.capacity !== null && cm > s.capacity) {
        return abortTx({
          fail: `组合「${s.key || '默认'}」总库存不能小于已占位/已售 ${cm} 件（销量随订单取消/退款/超时自动释放，编辑不释放）`,
        });
      }
    }
    // ── 限量恢复（NULL → 数值），**逐组合**处理 ──
    // 不限量期间下单的活跃行从未占位（hold_qty=0），切回限量时必须把它们的在途量
    // 纳入 committed 并补记 hold_qty（逐单占位记账，否则余量虚高 → 对已承诺订单超卖）。
    // 承诺量集合 = 在途行 ∪「不限量窗口内已交付后退款、退货未确认收到」的行：
    // 后者货仍在买家侧（未回收），同样必须计入 committed，防对缺货商品超卖承诺；
    // 待店主 receive/waive 后由 stockHold 释放（released_at 幂等，见 stockHold.js）。
    const willRestrict = value.skus.filter((s) => {
      const prev = prevSkus.get(s.key);
      return prev && prev.capacity === null && s.capacity !== null;
    });
    if (willRestrict.length) {
      /*
        在途/未回收的承诺量 = 「**还押着占位**」**且** `hold_qty = 0` 的行。
        为什么必须带 `hold_qty = 0`：不限量期间下单的行从未占位，它们的承诺量没记进 `committed`，
        切回限量时要现补（这是本段存在的理由）。而"已交付+退款+退货未收到"那类行的占位
        **已经记在 `committed` 里**（只是没释放），把它算进来会重复计入 ⇒ `committed` 虚高 ⇒ 商品卖不出去。
        两个谓词都来自 `stockHold` 的唯一实现，不在路由里手写状态白名单。
      */
      const IN_FLIGHT = `${uncommittedPromiseSql('o')} AND ${stockPromiseSql('o')}`;
      // 先整体算一遍在途量，任一组合放不下就整体拒绝（不留部分生效）
      const plans = [];
      for (const s of willRestrict) {
        /*
          ⚠️ `COALESCE(SUM(quantity), 0)` 是 **DECIMAL ⇒ 字符串**（db.js 的 decimalNumbers:false）。
          不转数字的话下面 `cm + inFlight` 会先拼成字符串（0 + "3" = "03"），
          与容量比较时再被隐式转回数字——判断在多数取值上恰好成立，在边界上静默失效。
          这正是"凡消费聚合的地方都必须显式 Number(...)"那条纪律的由来。
        */
        const inFlight = Number((await db.get(`SELECT COALESCE(SUM(quantity), 0) AS total FROM orders o WHERE o.product_id = ? AND o.sku_key = ? AND o.hold_qty = 0 AND ${IN_FLIGHT}`, row.id, s.key)).total);
        const cm = prevSkus.get(s.key)?.committed || 0;
        if (cm + inFlight > s.capacity) {
          return abortTx({
            fail: `组合「${s.key || '默认'}」切回限量失败：在途/待回收订单尚有 ${inFlight} 件，加已占位/已售 ${cm} 件共需 ${cm + inFlight} 件容量，超过你设置的 ${s.capacity} 件——请提高总量，或先处理在途订单（取消草稿/等待终结/确认回收退货）`,
          });
        }
        plans.push({ key: s.key, inFlight });
      }
      /*
        补记 hold_qty 与 committed 在**本事务内**（进程中断不留半写状态：只补 hold_qty 未加
        committed 会造成占位虚高）。这两条判据的读数（`inFlight`）与写入现在同处一个事务，
        并发的买家下单占位不可能落在它们之间。
      */
      const addCommittedSql = 'UPDATE product_skus SET committed = committed + ? WHERE product_id = ? AND sku_key = ?';
      /*
        补记 hold_qty 时**必须同时清 released_at**（源码审计 2026-09 修复）：该列是
        「本行已释放」的幂等标记，releaseCore 只处理 released_at IS NULL 的行
        （stockHold.js）。而 hold_qty=0 ∧ released_at 非空 这一组合是 restockOrder 在
        「组合当前不限量」分支下**刻意**产生的（占位作废但保留已释放语义）。若此处只补
        hold_qty 不清标记，该行将永远无法再被释放：后续取消/退款/超时时 releaseCore 直接跳过，
        committed 永久虚高 1 件（= 一件货再也卖不出去，且没有任何订单与之对应）。
      */
      const markHeldSql = `UPDATE orders AS o SET hold_qty = quantity, released_at = NULL WHERE o.product_id = ? AND o.sku_key = ? AND o.hold_qty = 0 AND ${IN_FLIGHT}`;
      for (const p of plans) {
        if (p.inFlight > 0) {
          await db.run(markHeldSql, row.id, p.key);
          await db.run(addCommittedSql, p.inFlight, row.id, p.key);
        }
      }
    }

    /*
      落库：商品行（含标签/参数/承诺三列 JSON）+ SKU 行，随后按**读回值**重算快照哈希。
      `updated_at` 与 `published_at` 都由服务器盖章（不传 JS 时间，见 PUBLISHED_AT_KEEP 的说明）；
      标签与参数不再有"另一处镜像要记得同批写"——它们就在这一条 UPDATE 里。
    */
    await db.run(
      'UPDATE products SET title = ?, description = ?, description_blocks = ?, media = ?, kind = ?, ' +
        'shipping_fee_usdt_micro = ?, age_restricted = ?, nft_contract = ?, nft_standard = ?, specs = ?, ' +
        `attributes = ?, terms = ?, tags = ?, auto_deliver = ?, stock_alert_at = ?, active = ?, published_at = ${PUBLISHED_AT_KEEP}, updated_at = CURRENT_TIMESTAMP(3) ` +
        'WHERE id = ?',
      value.title, value.description, JSON.stringify(value.descriptionBlocks), JSON.stringify(value.media), value.kind,
      value.shippingFeeUsdtMicro, value.ageRestricted, value.nftContract, value.nftStandard, JSON.stringify(value.specs),
      JSON.stringify(value.attributes), JSON.stringify(value.terms), JSON.stringify(value.tags),
      value.autoDeliver, value.stockAlertAt, value.active, value.active, row.id
    );
    // 写 SKU（保留同 key 的 committed，编辑商品不该把已售数量清零）
    await saveSkus(row.id, value.skus);
    // 快照哈希最后算：它认的是上面这些列**读回来**的样子（JSON 列由 MySQL 规范化，见文件头）
    await refreshSnapshotHash(row.id);
    return { ok: true };
  });
  if (out.fail) return fail(res, out.fail);
  await audit(req, 'product.update', 'product', row0.slug, { fields: Object.keys(b).filter((k) => ['title','description','descriptionBlocks','specs','skus','tags','attributes','terms','autoDeliver','stockAlertAt','active','kind','shippingFeeUsdtMicro','ageRestricted'].includes(k)) });
  ok(res, await rowToPublic(await db.get('SELECT * FROM products WHERE id = ?', row0.id)), '已更新');
}));

// ── 兑换码池（数字商品）──

/** 码池统计（供导入/查看接口复用） */
async function codeStats(db, productId) {
  const rows = await db.all('SELECT status, COUNT(*) AS c FROM product_codes WHERE product_id = ? GROUP BY status', productId);
  const stats = { total: 0, unused: 0, used: 0 };
  for (const r of rows) {
    const n = Number(r.c);
    stats.total += n;
    if (r.status === 'unused') stats.unused += n;
    else stats.used += n;
  }
  return stats;
}

/** 店主导入兑换码（每行一个码，去空白；同商品重复码自动跳过） */
router.post('/:slug/codes', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const product = await requireShopProduct(req, res);
  if (!product) return;
  if (product.kind !== 'digital') return fail(res, '仅数字商品可配置兑换码池');
  const raw = Array.isArray(req.body?.codes) ? req.body.codes : [];
  if (!raw.length) return fail(res, 'codes 需为非空字符串数组');
  if (raw.length > 500) return fail(res, '单次导入最多 500 条');
  const dedup = [...new Set(raw.map((c) => String(c).trim()).filter(Boolean))];
  if (!dedup.length) return fail(res, '未解析到有效码（去除空白后为空）');
  // 超长行按既有契约静默跳过并计入 skipped，但成功文案明确数量与行上限（卖家侧审计 ③：
  // 不整批拒绝——旧行为被单测锁定；用提示替代行号，seller 可据此排查输入）
  const tooLongCount = dedup.filter((c) => c.length > 200).length;
  const codes = dedup.filter((c) => c.length <= 200);
  if (!codes.length) return fail(res, '未解析到有效码（去除空白后为空或全部超长，单条 ≤200 字符）');
  /*
    整批导入 + 统计读数**在同一个事务里**（防进程中断半写：只导入一半 → 返回计数与实际不符、
    补跑被跳过一半）。与 PATCH /:slug 的**池计数闸**靠**商品行**串行（插子表行时取的外键共享锁
    与那条闸的 `FOR UPDATE` 互斥；全局写锁已删，见那条路径的取锁说明）：那条闸读
    `COUNT(*)` 之后才改 kind / nft_standard / nft_contract，若导入能落在读与写之间，
    一次"改型"就会让在途 NFT 单找不到池里的 tokenId（永远交付不了的僵死单）。

    `changes === 0` 必须**如实表示"这个码已经在池里"**（该计数直接印给店主看，
    见下方 `skipped`），所以去重靠 `INSERT … SELECT … WHERE NOT EXISTS`，
    **不用** `INSERT IGNORE`——后者会把外键违规、超长截断一并降级成警告，
    那种"静默丢数据"换来的 0 分不清是重复还是写入失败。
    `created_at` 不传：列是 `DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)`，由服务器盖章。
  */
  const imported0 = await withTransaction(async () => {
    /*
      事务内重读 kind：上面那次 `product.kind !== 'digital'` 的判定在事务**之外**，
      并发的 PATCH /:slug 可以在那之后把这个商品改成别的类型（那条路径的闸读的正是本池计数，
      两者靠**商品行**上的外键共享锁与排他锁串行——这就是本事务存在的意义之一）。
    */
    const fresh = await db.get('SELECT kind FROM products WHERE id = ?', product.id);
    if (fresh?.kind !== 'digital') return abortTx({ fail: '仅数字商品可配置兑换码池' });
    let n = 0;
    const insSql =
      'INSERT INTO product_codes (product_id, code) ' +
      'SELECT ?, ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM product_codes WHERE product_id = ? AND code = ?)';
    for (const code of codes) {
      n += (await db.run(insSql, product.id, code, product.id, code)).changes;
    }
    return { imported: n, stats: await codeStats(db, product.id) };
  });
  if (imported0.fail) return fail(res, imported0.fail);
  const { imported, stats } = imported0;
  // skipped = 去重后条目中未导入的（超长被过滤 + 与库内重复）
  const skipped = dedup.length - imported;
  // 码池补货后的待交付补跑：此前因池空滞留 escrowed 的自动交付订单（有支付凭证）立即补发。
  // 该函数会逐单做**链上复核**（getOrder：仅 Created 且未申请退款才发），故为 async（见 autoDeliver.js）。
  // ⚠️ 必须在事务**之外**（回调里不得 await 数据库以外的东西，见 db.js）。
  let autoDelivered = 0;
  if (imported > 0) {
    autoDelivered = await tryAutoDeliverPendingForProduct(product.id);
    if (autoDelivered > 0) {
      console.log(`[autoDeliver] 码池补货后自动补发 ${autoDelivered} 个滞留订单（product=${product.slug}）`);
    }
  }
  // 审计先于响应：响应之后没有"还能把错误说出来"的地方（见 PATCH /batch 同款说明）
  await audit(req, 'code.import', 'product', product.slug, { imported, skipped, autoDelivered }); // 不落码原文
  ok(
    res,
    { slug: product.slug, imported, skipped, stats, autoDelivered },
    `导入 ${imported} 条，跳过 ${skipped} 条${tooLongCount ? `（其中超长 ${tooLongCount} 条：单条码 ≤200 字符）` : ''}${autoDelivered > 0 ? `；已自动补发 ${autoDelivered} 个待交付订单` : ''}`
  );
}));

/** 店主/操作员查看码池（码为敏感资源：staff 可读——处理退款/对码需要，读取入审计；status 过滤 + id 倒序分页） */
router.get('/:slug/codes', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const product = await requireShopProduct(req, res);
  if (!product) return;
  const status = String(req.query.status || 'unused');
  if (!['unused', 'used', 'all'].includes(status)) return fail(res, 'status 需为 unused / used / all');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const where = status === 'all' ? 'pc.product_id = ?' : 'pc.product_id = ? AND pc.status = ?';
  const params = status === 'all' ? [product.id] : [product.id, status];
  const total = Number((await db.get(`SELECT COUNT(*) AS c FROM product_codes pc WHERE ${where}`, ...params)).c);
  /*
    池行上的 `order_id` 是**内部外键**（orders.id），而店主能用的句柄是**对外订单号**：
    界面显示/复制的一律是 `order_no`（CHAR(21)），下面下发的 `orderId` 因此取订单号，
    而不是那个内部数字键——把内部键当单号发出去，调用方拿它去查订单只会查不到，
    而症状是"这条码显示有订单，点进去却不存在"。
  */
  const codes = await db.all(`SELECT pc.id, pc.code, pc.status, pc.order_id, o.order_no, pc.created_at, pc.used_at
         FROM product_codes pc LEFT JOIN orders o ON o.id = pc.order_id
        WHERE ${where} ORDER BY pc.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
  // 码原文为敏感资源：staff 读取（翻页式拉取等价于导出）入审计——只记计数与过滤条件，detail 不含码原文
  await audit(req, 'code.read', 'product', product.slug, { status, rows: codes.length });
  ok(res, {
    slug: product.slug,
    stats: await codeStats(db, product.id),
    total,
    page,
    pageSize,
    codes: codes.map((c) => ({
      id: c.id,
      code: c.code,
      status: c.status,
      orderId: c.order_no ?? null,
      createdAt: c.created_at,
      usedAt: c.used_at,
    })),
  });
}));

/** 店主删除单个码（仅未用码可删——已分配码需先让买家正常使用/退款收回） */
router.delete('/:slug/codes/:id', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const product = await requireShopProduct(req, res);
  if (!product) return;
  const row = await db.get('SELECT * FROM product_codes WHERE id = ? AND product_id = ?', Number(req.params.id) || 0, product.id);
  if (!row) return fail(res, '码不存在', 404, 404);
  if (row.status !== 'unused') return fail(res, '仅可删除未分配的码');
  /*
    删除**必须带 status = 'unused' 条件**，并要求恰好命中 1 行。

    上面那次读只是"给人看的"预判：读与删之间，一笔并发的交付占用可以把这一行翻成 `used`
    （`UPDATE product_codes SET status = 'used' … WHERE id = ? AND status = 'unused'`，见 orders.js
    的交付路径）。无条件删就删掉了那条 **used 墓碑**——店主再把同一批码导进来，这个码会以
    unused 回到池里并**发给第二个买家**（一码两卖，两边都"成功"且没有任何错误码）。
    墓碑存在的唯一理由就是挡住这件事（见下方清空码池的说明），所以判据必须在 DELETE 自己的
    WHERE 里，而不是在它之前的一次读里：这就是"一个码能到两个买家手里"的唯一路径。
  */
  const del = await db.run("DELETE FROM product_codes WHERE id = ? AND product_id = ? AND status = 'unused'", row.id, product.id);
  if (del.changes !== 1) return fail(res, '仅可删除未分配的码（该码刚被分配给订单，请刷新码池后重试）');
  await audit(req, 'code.delete', 'product', product.slug, { codeId: row.id });
  ok(res, { slug: product.slug, deleted: row.id, stats: await codeStats(db, product.id) }, '已删除');
}));

/**
 * 清空整个码池（仅 owner；需 ?confirm=1 二次确认）。
 * 适用：停售/改型前整批作废。
 *
 * **只删未用码**（源码审计 2026-09 复审，P2）：旧实现 `DELETE ... WHERE product_id = ?` 把
 * `used`（已交付）行一起删了，而注释却写着"码原文已冗余保存在 order_delivery_items，
 * 历史订单展示/追溯不受影响"——那句话只对**展示**成立，对**再交付**不成立：
 * 码池唯一约束是 `(product_id, code)`，店家把同一批码重新导入之后，那些"已交付过"的码
 * 会以 `unused` 回到池里，而自动交付/手动交付只按 `(product_id, code)` 命中池行、
 * **不查交付子表** ⇒ 已经发给过第一个买家的码会被再发给第二个买家。
 * 保留 `used` 行 = 该码在本店**永不复用**的墓碑（删除它的路径只有下面这条显式动作）。
 * 代价如实写明：`used` 行会一直留在池里计入 `total`，店主看到的总数是"含历史"的；
 * 需要彻底清掉请先确认无历史订单依赖，再走库级维护（见 node/docs/OPERATIONS.md）。
 */
router.delete('/:slug/codes', ownerOnly, wrap(async (req, res) => {
  if (req.query.confirm !== '1') return fail(res, '清空码池为整批不可逆操作，需带 ?confirm=1 二次确认');
  const db = getDb();
  const product = await requireShopProduct(req, res);
  if (!product) return;
  if (product.kind !== 'digital') return fail(res, '仅数字商品有兑换码池');
  const stats = await codeStats(db, product.id);
  const removed = (await db.run("DELETE FROM product_codes WHERE product_id = ? AND status = 'unused'", product.id)).changes;
  await audit(req, 'code.clear', 'product', product.slug, { deleted: removed, keptUsed: stats.used });
  ok(
    res,
    { slug: product.slug, cleared: removed, keptUsed: stats.used },
    removed
      ? `已清空码池中的 ${removed} 条未用码` +
          (stats.used ? `；保留 ${stats.used} 条已交付记录作为"该码永不复用"的墓碑（重新导入同批码也不会再发出去）` : '')
      : stats.used
        ? `没有可清空的未用码；${stats.used} 条已交付记录保留（该码永不复用）`
        : '码池已为空'
  );
}));

// ── NFT 交付池（NFT 商品）──

/** 交付池统计（供导入/查看接口复用） */
async function nftStats(db, productId) {
  const rows = await db.all('SELECT status, COUNT(*) AS c FROM product_nft_tokens WHERE product_id = ? GROUP BY status', productId);
  const stats = { total: 0, unused: 0, used: 0 };
  for (const r of rows) {
    const n = Number(r.c);
    stats.total += n;
    if (r.status === 'unused') stats.unused += n;
    else stats.used += n;
  }
  return stats;
}

/** 单次导入展开后的 tokenId 条数上限 */
const NFT_MAX_IMPORT = 500;

/**
 * 解析单条 tokenId 输入：`123` / `0x1F` / 闭区间范围 `10-20`。
 * 返回 { ok: true, values: bigint[] } 或 { ok: false, error }。
 * 数值须在 uint256 内且展开不超过单次上限（防范围炸弹）。
 *
 * 落库一律转**十进制字符串**（`product_nft_tokens.token_id VARCHAR(78)`，uint256 最长 78 位）：
 * 大整数在 JS 里只有 BigInt 能精确表示，而在 SQL/JSON 里用十进制字符串就不会有精度问题。
 */
export function parseTokenSpec(spec) {
  const s = String(spec ?? '').trim();
  if (!s) return { ok: false, error: '空条目' };
  const parseOne = (t) => {
    if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(t)) return null;
    const b = BigInt(t);
    return b >= 0n && b < 1n << 256n ? b : null;
  };
  const parts = s.split('-');
  if (parts.length === 1) {
    const v = parseOne(parts[0]);
    return v === null ? { ok: false, error: `「${s}」不是合法 tokenId（需十进制或 0x hex，且 < 2^256）` } : { ok: true, values: [v] };
  }
  if (parts.length === 2) {
    const a = parseOne(parts[0]);
    const b = parseOne(parts[1]);
    if (a === null || b === null || a > b) return { ok: false, error: `范围「${s}」非法（需 a-b 且 a <= b）` };
    if (b - a + 1n > BigInt(NFT_MAX_IMPORT)) return { ok: false, error: `范围「${s}」展开超过单次上限 ${NFT_MAX_IMPORT} 条` };
    const values = [];
    for (let i = a; i <= b; i += 1n) values.push(i);
    return { ok: true, values };
  }
  return { ok: false, error: `「${s}」无法解析（支持单个 tokenId 或 a-b 范围）` };
}

/** 店主导入 NFT tokenId 交付库存（每行一个：十进制 / 0x hex / a-b 范围；同商品重复自动跳过） */
router.post('/:slug/tokens', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const product = await requireShopProduct(req, res);
  if (!product) return;
  if (product.kind !== 'nft') return fail(res, '仅 NFT 商品可配置 tokenId 交付池');
  const raw = Array.isArray(req.body?.tokens) ? req.body.tokens : [];
  if (!raw.length) return fail(res, 'tokens 需为非空字符串数组');
  if (raw.length > NFT_MAX_IMPORT) return fail(res, `单次导入最多 ${NFT_MAX_IMPORT} 行`);
  const seen = new Set();
  const values = [];
  // 循环内累计判总展开上限（防先全量展开再判上限的内存峰值——卖家侧审计待确认 b）
  for (let i = 0; i < raw.length; i++) {
    const r = parseTokenSpec(raw[i]);
    if (!r.ok) return fail(res, `第 ${i + 1} 行：${r.error}`);
    if (values.length + r.values.length > NFT_MAX_IMPORT) {
      return fail(res, `第 ${i + 1} 行起展开将超过单次上限 ${NFT_MAX_IMPORT} 条：请缩小导入范围`);
    }
    for (const v of r.values) {
      const key = v.toString();
      if (!seen.has(key)) {
        seen.add(key);
        values.push(key);
      }
    }
  }
  if (!values.length) return fail(res, '未解析到有效 tokenId');
  if (values.length > NFT_MAX_IMPORT) return fail(res, `tokenId 展开后超过单次上限 ${NFT_MAX_IMPORT} 条`);
  /*
    整批导入 + 统计读数**在同一个事务里**（防进程中断半写：tokenId 池只入一半 →
    统计与可交付量错位），并与 PATCH /:slug 的池计数闸靠**商品行**上的锁串行（同兑换码池那边）：
    那条闸读 `COUNT(*)` 之后才允许改 kind / nft_standard / nft_contract，导入若能落在读与写之间，
    一次"换合约/换标准"就会让池里的 tokenId 与在途订单的核验口径错配（永远交付不了的僵死单）。
    去重靠 `INSERT … SELECT … WHERE NOT EXISTS`：`changes === 0` 必须**如实**表示"池里已有这个
    tokenId"（这个计数印给店主看），而 `INSERT IGNORE` 会把外键/截断一并降级成警告。
    `created_at` 不传：列是 `DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)`，由服务器盖章。
  */
  const imported0 = await withTransaction(async () => {
    /*
      事务内重读 kind：上面那次 `product.kind !== 'nft'` 的判定在事务**之外**，并发的
      PATCH /:slug 可以在那之后改类型/换合约（那条路径的闸读的正是本池计数，两者靠商品行上的锁串行）。
    */
    const fresh = await db.get('SELECT kind FROM products WHERE id = ?', product.id);
    if (fresh?.kind !== 'nft') return abortTx({ fail: '仅 NFT 商品可配置 tokenId 交付池' });
    let n = 0;
    const insSql =
      'INSERT INTO product_nft_tokens (product_id, token_id) ' +
      'SELECT ?, ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM product_nft_tokens WHERE product_id = ? AND token_id = ?)';
    for (const tokenId of values) {
      n += (await db.run(insSql, product.id, tokenId, product.id, tokenId)).changes;
    }
    return { imported: n, stats: await nftStats(db, product.id) };
  });
  if (imported0.fail) return fail(res, imported0.fail);
  const { imported, stats } = imported0;
  const skipped = values.length - imported;
  // 审计先于响应：响应之后没有"还能把错误说出来"的地方（见 PATCH /batch 同款说明）
  await audit(req, 'token.import', 'product', product.slug, { imported, skipped });
  ok(res, { slug: product.slug, imported, skipped, stats }, `导入 ${imported} 个 tokenId，跳过 ${skipped} 个（重复）`);
}));

/** 店主/操作员查看 NFT 交付池（tokenId 为交付库存，staff 可读——处理退款/对码需要，读取入审计；status 过滤 + id 倒序分页） */
router.get('/:slug/tokens', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const product = await requireShopProduct(req, res);
  if (!product) return;
  const status = String(req.query.status || 'unused');
  if (!['unused', 'used', 'all'].includes(status)) return fail(res, 'status 需为 unused / used / all');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const where = status === 'all' ? 'pt.product_id = ?' : 'pt.product_id = ? AND pt.status = ?';
  const params = status === 'all' ? [product.id] : [product.id, status];
  const total = Number((await db.get(`SELECT COUNT(*) AS c FROM product_nft_tokens pt WHERE ${where}`, ...params)).c);
  // `orderId` 同码池：下发**对外订单号**而不是内部外键（见 GET /:slug/codes 的说明）
  const tokens = await db.all(`SELECT pt.id, pt.token_id, pt.status, pt.order_id, o.order_no, pt.created_at, pt.used_at
         FROM product_nft_tokens pt LEFT JOIN orders o ON o.id = pt.order_id
        WHERE ${where} ORDER BY pt.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
  // tokenId 交付池为敏感资源：staff 读取入审计（只记计数与过滤条件，detail 不含 tokenId 列表）
  await audit(req, 'token.read', 'product', product.slug, { status, rows: tokens.length });
  ok(res, {
    slug: product.slug,
    stats: await nftStats(db, product.id),
    total,
    page,
    pageSize,
    tokens: tokens.map((t) => ({
      id: t.id,
      tokenId: t.token_id,
      status: t.status,
      orderId: t.order_no ?? null,
      createdAt: t.created_at,
      usedAt: t.used_at,
    })),
  });
}));

/** 店主删除单个未用 tokenId（已交付的需买家正常收货/退款收回后另行处理） */
router.delete('/:slug/tokens/:id', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const product = await requireShopProduct(req, res);
  if (!product) return;
  const row = await db.get('SELECT * FROM product_nft_tokens WHERE id = ? AND product_id = ?', Number(req.params.id) || 0, product.id);
  if (!row) return fail(res, 'tokenId 不存在', 404, 404);
  if (row.status !== 'unused') return fail(res, '仅可删除未交付状态的 tokenId');
  /*
    与 DELETE /:slug/codes/:id 同一条纪律：删除**必须带 status = 'unused' 条件**
    并要求恰好命中 1 行。上面那次读会被一笔并发交付（`UPDATE product_nft_tokens SET status='used' …
    WHERE id = ? AND status = 'unused'`，见 orders.js）超越——无条件删就抹掉了那条 used 墓碑，
    店主把同一批 tokenId 重新导入后，同一枚 NFT 会被"交付"给第二个买家（链上那枚早已转给第一个）。
  */
  const del = await db.run("DELETE FROM product_nft_tokens WHERE id = ? AND product_id = ? AND status = 'unused'", row.id, product.id);
  if (del.changes !== 1) return fail(res, '仅可删除未交付状态的 tokenId（该枚刚被分配给订单，请刷新交付池后重试）');
  await audit(req, 'token.delete', 'product', product.slug, { tokenId: row.id });
  ok(res, { slug: product.slug, deleted: row.id, stats: await nftStats(db, product.id) }, '已删除');
}));

/**
 * 清空整个 NFT 交付池（仅 owner；需 ?confirm=1 二次确认）。
 * 适用：停售/改型/换合约地址前整批作废。已交付（used）行也可删除——交付凭证已冗余
 * 保存在订单交付子表（order_delivery_items，含 tx_hash），历史订单展示/追溯不受影响。
 * 请确认无「待交付」在途 NFT 单依赖该池（池空时新单已被售罄拦截，在途单需手动交付或退款）。
 */
router.delete('/:slug/tokens', ownerOnly, wrap(async (req, res) => {
  if (req.query.confirm !== '1') return fail(res, '清空交付池为整批不可逆操作，需带 ?confirm=1 二次确认');
  const db = getDb();
  const product = await requireShopProduct(req, res);
  if (!product) return;
  if (product.kind !== 'nft') return fail(res, '仅 NFT 商品有 tokenId 交付池');
  const stats = await nftStats(db, product.id);
  await db.run('DELETE FROM product_nft_tokens WHERE product_id = ?', product.id);
  await audit(req, 'token.clear', 'product', product.slug, { deleted: stats.total });
  ok(res, { slug: product.slug, cleared: stats.total }, stats.total ? `已清空交付池（${stats.total} 条，含已交付记录；历史订单凭证不受影响）` : '交付池已为空');
}));

export default router;
