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
 *  DELETE /api/products/:slug/codes        店主清空整个码池（ownerOnly；?confirm=1；含已用记录——历史订单凭证在交付子表不受影响）
 *  POST   /api/products/:slug/tokens       店主/操作员（staff）导入 NFT 交付池 {tokens: string[]}（NFT 商品）
 *  GET    /api/products/:slug/tokens       店主/操作员查看 NFT 交付池 {status? page?}（读取入审计）
 *  DELETE /api/products/:slug/tokens/:id   店主/操作员（staff）删除单个未用 tokenId
 *  DELETE /api/products/:slug/tokens       店主清空整个交付池（ownerOnly；?confirm=1；含已交付记录——凭证在交付子表不受影响）
 *
 * 码池模型：数字商品由卖家导入一批兑换码；发货时若未手动填交付内容，
 * orders 发货流程自动分配一个未用码（事务防重）。码池对公开接口完全不可见，
 * 仅 staff（店主/操作员）令牌可读写；订单交付后买家经订单接口按身份可见。
 *
 * NFT 交付池模型：NFT 商品（kind='nft'，nft_contract=合约地址、nft_standard=erc721/erc1155）
 * 由卖家导入一批 tokenId 作为交付库存（每行一个：十进制 / 0x hex / a-b 范围展开）；发货由卖家在钱包
 * 把池内 NFT 转给买家后提交 tokenId+txHash，节点按 nft_standard 核验链上转账事件后置 shipped（见 orders.js）：
 * erc721 兼容 ERC721A 的 Transfer 单枚事件；erc1155 支持 TransferSingle 与 TransferBatch（批量一次多枚），
 * 同 tokenId 多份（value>1 或批量重复 id）不支持（每件 = 一个独立 tokenId 恰一份）。
 * 池空时新订单被拦截（视为售罄）；池内 tokenId 对公开接口不可见，仅 staff（店主/操作员）令牌可读写。
 *
 * 快照哈希：对固定字段顺序的规范化 JSON（UTF-8）做 keccak256，
 * 上架/改价后重算并存 snapshot_hash；下单时锁定该哈希——买家可在前端
 * 用同一算法复算校验成交时刻的商品内容（规范化见 computeSnapshotHash，
 * 字段顺序为约定契约，前端 utils/snapshot.ts 保持一致，勿随意调整）。
 *
 * **快照契约（唯一权威顺序）**：
 *   slug / title / description / description_blocks / images / kind /
 *   shipping_fee_cny_fen / age_restricted / specs / skus
 *   kind='nft' 时再追加 nft_contract、nft_standard（nft_contract 在前）。
 *   追加/改动键必须在**同一位置**同时改本文件与前端 utils/snapshot.ts，
 *   否则每个买家都会看到假的「商品内容已被修改」告警。
 *   运费与年龄限制必须在快照里：否则店主可以在买家下单前事后加价运费、
 *   或把限制商品悄悄摘掉限制，而买家手上的哈希不变。
 *   （历史契约曾把 nft 两键描述为"追加在 price_cny_fen 之后"——价格早已下沉到
 *   skus，该措辞已失效，此处按当前实现重写。）
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { ethers } from 'ethers';
import { getDb, txBegin, txCommit, txRollback } from '../db.js';
import { getRates } from '../rates.js';
import { verifyToken } from '../auth.js';
import { isAddress, isZeroAddress } from '../chain.js';
import { ok, fail, wrap, makeAuthMiddleware, bearerToken } from '../http.js';
import { productReviews, productReviewSummary } from '../reviews.js';
import { logAudit } from '../audit.js';
import { roleOf, isStaff } from '../auth.js';
import { newProductSlug } from '../ids.js';
import { normalizeBlocks, deriveDescription, parseBlocks } from '../describeBlocks.js';
import { tryAutoDeliverPendingForProduct } from '../autoDeliver.js';
// 金额展示口径的唯一实现（yuanOf / goodsFenOf）——不要再手写 (fen/100).toFixed(2)
import { yuanOf } from '../money.js';
// 订单状态集合的唯一出处（"在途需求"核算用的是"草稿+在途"那一套）
import { DRAFT_OR_ACTIVE_IN } from '../orderStatus.js';

/** 管理审计便捷包装（仅 staff 记录；detail 不含码原文/收货地址） */
const audit = (req, action, targetType, targetId, detail) =>
  logAudit({ req, actor: req.auth?.address, actorRole: roleOf(req.auth?.address || ''), action, targetType, targetId, detail });

const router = Router();
const staffOnly = makeAuthMiddleware(verifyToken, { staffOnly: true }); // P1-⑤：商品经营面=店主+操作员
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true }); // 池清空/敏感资源批量作废=仅店主

// ── 快照与展示 ──

/**
 * 快照里的非负整数列归一：缺列（老调用方手搓的行对象）/脏数据一律归 0。
 * 归一在这里（而不是只在写入路径）是刻意的——`computeSnapshotHash` 会丢掉
 * `undefined` 键，若只在写入时归一，任何手搓快照对象算出的哈希都会与库里的值不同，
 * 于是"校验失败"变成噪音而不是信号。
 */
function snapshotNonNegInt(v) {
  const n = Number(v ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** 快照规范化字段（顺序固定，勿改动）：
 *  slug / title / description / description_blocks / images / kind /
 *  shipping_fee_cny_fen / age_restricted / specs / skus；
 *  kind='nft' 时追加 nft_contract、nft_standard（nft_contract 在前）。
 *  新键插在 kind 之后、specs 之前，前端 utils/snapshot.ts 必须同位置同键。
 *
 *  价格不在商品级 —— 每个组合的单价都在 skus 里（[[sku_key, price_cny_fen], …] 按 key 升序），
 *  买家据此核验「所选规格的价格」没有被事后改动。
 *  运费（shipping_fee_cny_fen）与年龄限制（age_restricted）**必须**在快照里：
 *  前者是钱（事后加价运费等于改价），后者是商品属性（上架后静默增删限制，买家无从察觉）。 */
export function snapshotObject(row) {
  let images = [];
  try {
    images = JSON.parse(row.images || '[]');
  } catch {
    images = [];
  }
  const skuRows = Array.isArray(row.skus) ? row.skus : [];
  const snap = {
    slug: row.slug,
    title: row.title,
    description: row.description,
    // 详情块是商品详情的**权威内容**，必须入快照 —— 否则店主事后往说明里插一张图，
    // 买家手上的哈希不变，等于详情可被无声篡改。
    description_blocks: parseBlocks(row.description_blocks),
    images,
    kind: row.kind,
    // 运费（CNY 分，按单收取一次；0=包邮）——买家据此核验「锁定的运费」没被事后改价
    shipping_fee_cny_fen: snapshotNonNegInt(row.shipping_fee_cny_fen),
    // 年龄限制（0/1）——买家据此核验「下单那一刻这件商品是否声明了未成年人禁止购买」
    age_restricted: row.age_restricted ? 1 : 0,
    specs: parseSpecsColumn(row),
    skus: [...skuRows]
      .sort((a, b) => (a.sku_key < b.sku_key ? -1 : a.sku_key > b.sku_key ? 1 : 0))
      .map((s) => [s.sku_key, s.price_cny_fen]),
  };
  if (row.kind === 'nft') {
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
    images: snap.images,
    kind: snap.kind,
    // 与 snapshotObject 同键同位（契约：见文件头快照契约）。手搓对象缺这两键时归一为默认值，
    // 保证「同一件商品」无论经哪条路径规范化都得到同一个哈希。
    shipping_fee_cny_fen: snapshotNonNegInt(snap.shipping_fee_cny_fen),
    age_restricted: snap.age_restricted ? 1 : 0,
    // 价格不在商品级：每个组合的单价都在 skus 里（[[sku_key, price_cny_fen], …]，按 key 升序）
    specs: snap.specs,
    skus: snap.skus,
  };
  if ('nft_contract' in snap) {
    o.nft_contract = snap.nft_contract;
    o.nft_standard = snap.nft_standard;
  }
  const canonical = JSON.stringify(o);
  return ethers.keccak256(ethers.toUtf8Bytes(canonical));
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

/** 组合 → 稳定标识：按 specs 声明顺序拼接（改选项名才变，改顺序不变）；无规格为 '' */
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
    if (seen.has(key)) {
      errors.push(`SKU 重复：${key || '(默认)'}`);
      continue;
    }
    seen.add(key);
    const price = Number(rawSku?.priceCnyFen);
    if (!Number.isInteger(price) || price <= 0 || price > 100000000000) {
      errors.push(`SKU「${key || '(默认)'}」价格需为 1..1e11 的整数（单位：分）`);
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
    skus.push({ key, specs: expected.get(key), priceCnyFen: price, capacity: cap, active });
  }
  return { errors, skus };
}

/** 读库：某商品的 SKU 行（按 sku_key 排序，输出稳定） */
export function loadSkus(productId) {
  return getDb().prepare('SELECT * FROM product_skus WHERE product_id = ? ORDER BY sku_key').all(productId);
}

/** 给商品行挂上 skus（快照与 DTO 都要用；已挂则直接返回） */
function withSkus(row) {
  if (!row) return row;
  if (Array.isArray(row.skus)) return row;
  return { ...row, skus: loadSkus(row.id) };
}

/** 解析商品的 specs 列（容错：脏数据当作无规格） */
function parseSpecsColumn(row) {
  try {
    const v = JSON.parse(row.specs || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 写库：全量替换某商品的 SKU 行（**保留同 key 的 committed** —— 编辑商品不该把已售数量清零） */
function saveSkus(productId, skus, now) {
  const db = getDb();
  const prev = new Map(
    db.prepare('SELECT sku_key, committed FROM product_skus WHERE product_id = ?').all(productId).map((r) => [r.sku_key, { committed: r.committed }])
  );
  db.prepare('DELETE FROM product_skus WHERE product_id = ?').run(productId);
  const ins = db.prepare(
    'INSERT INTO product_skus (product_id, sku_key, specs_json, price_cny_fen, capacity, committed, active, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const s of skus) {
    ins.run(
      productId,
      s.key,
      JSON.stringify(s.specs),
      s.priceCnyFen,
      s.capacity,
      prev.get(s.key)?.committed || 0,
      s.active === false ? 0 : 1,
      now,
      now
    );
  }
}

/** DB 行 → 对外字段（camelCase）。价格与库存**一律来自 Skus**，商品级字段只是汇总值：
 *  - priceCnyFen/priceCny = 各组合最低价（列表页「起价」展示用；成交价一律取所选 SKU）
 *  - capacity/committed    = 各组合之和；任一组合不限量则 capacity 为 null（整体视为不限量）
 *  - available             = null 或 总量 − 已占位
 *  行需先经 withSkus() 挂上 skus。 */
function rowToPublic(row) {
  const r = withSkus(row);
  const snap = snapshotObject(r);
  const skus = (r.skus || []).map((s) => ({
    key: s.sku_key,
    specs: (() => {
      try {
        return JSON.parse(s.specs_json || '{}');
      } catch {
        return {};
      }
    })(),
    priceCnyFen: s.price_cny_fen,
    priceCny: yuanOf(s.price_cny_fen),
    capacity: s.capacity,
    committed: s.committed || 0,
    available: s.capacity === null ? null : Math.max(0, s.capacity - (s.committed || 0)),
    active: !!s.active,
  }));
  const unlimited = skus.some((s) => s.capacity === null);
  const capacity = skus.length && !unlimited ? skus.reduce((n, s) => n + s.capacity, 0) : null;
  const committed = skus.reduce((n, s) => n + s.committed, 0);
  const minFen = skus.length ? Math.min(...skus.map((s) => s.priceCnyFen)) : 0;
  return {
    slug: r.slug,
    title: r.title,
    description: r.description,
    /** 详情块（权威内容）：[{type:'text',text} | {type:'image',url}]；空数组时前端按 description 纯文本渲染 */
    descriptionBlocks: parseBlocks(r.description_blocks),
    images: snap.images,
    kind: r.kind,
    /**
     * 运费（实物）：**按单收取一次**（不随件数翻倍），0 = 包邮。
     * 数字 / NFT 商品恒为 0（运费列只对 physical 生效，见 validateProduct）。
     * 该值入快照——买家据此核验锁定的运费没被事后改价。
     */
    shippingFeeCnyFen: r.shipping_fee_cny_fen || 0,
    shippingFeeCny: yuanOf(r.shipping_fee_cny_fen),
    freeShipping: !(r.shipping_fee_cny_fen > 0),
    /** 未成年人禁止购买（0/1）：下单必须带买家显式确认（ageAck）；入快照，上架后不可静默增删 */
    ageRestricted: !!r.age_restricted,
    nftContract: r.nft_contract || null,
    nftStandard: r.nft_standard || 'erc721',
    specs: parseSpecsColumn(r),
    skus,
    // 汇总口径（列表页展示；逐组合的权威值在 skus 里）
    priceCnyFen: minFen,
    priceCny: yuanOf(minFen),
    priceFromFen: minFen,
    unlimited,
    available: capacity === null ? null : Math.max(0, capacity - committed),
    capacity,
    committed,
    outOfStock: skus.length > 0 && skus.every((s) => !s.active || (s.capacity !== null && s.available <= 0)),
    active: !!r.active,
    snapshotHash: r.snapshot_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
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
  if (!Array.isArray(v.images)) errors.push('images 需为图片 URL 字符串数组');
  let images = [];
  if (Array.isArray(v.images)) {
    if (v.images.length > 9) errors.push('images 最多 9 张');
    images = v.images.slice(0, 9).map((u) => String(u).slice(0, 500));
    // 协议白名单（纵深防御）：仅 http/https 图片 URL——javascript:/data: 等一旦进入未来的
    // 富文本/新渲染上下文可能被利用（当前 CSS url() 上下文执行面≈0，仍收口防漂移）
    if (images.some((u) => !/^https?:\/\//i.test(u))) errors.push('图片 URL 仅支持 http/https');
  }
  const kind = String(v.kind ?? '');
  if (!['digital', 'physical', 'nft'].includes(kind)) errors.push('kind 需为 digital / physical / nft');
  // NFT 商品：nft_contract 必填（0x 小写归一）+ nft_standard 必填合法（erc721/erc1155，缺省 erc721）；
  // 其他类型强制清空（改回普通商品时随 UPDATE 落默认值）
  let nftContract = '';
  let nftStandard = 'erc721';
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
  // 低库存提醒阈值：余量 ≤ 阈值时卖家面板警示；空/0 视为不提醒
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
    运费（实物，按单收取一次，CNY 分）：
     - 非负整数，上限 100000 分 = ¥1000（比价上限还高一个量级即为误填/攻击面，明确拒绝而不是截断）；
     - 只有实物商品有运费语义：数字/NFT 商品携带非 0 值**显式拒绝**（而不是静默归零）——
       静默归零会让店主以为"我设了运费"，实际一分钱没收到；
     - 空/未提交 = 0（包邮）。
  */
  let shippingFeeCnyFen = 0;
  if (v.shippingFeeCnyFen !== undefined && v.shippingFeeCnyFen !== null && v.shippingFeeCnyFen !== '') {
    const fee = Number(v.shippingFeeCnyFen);
    if (!Number.isInteger(fee) || fee < 0 || fee > 100000) {
      errors.push('shippingFeeCnyFen（运费）需为 0..100000 的整数（单位：分，即 ¥0..¥1000；0 = 包邮）');
    } else if (kind !== 'physical' && fee > 0) {
      errors.push('仅实物商品可设置运费（数字 / NFT 商品运费恒为 0）');
    } else {
      shippingFeeCnyFen = fee;
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
  return {
    errors,
    value: {
      title,
      // 有块时 description 降级为派生摘要；无块时就是店主填的纯文本（保持原有观感）
      description: blocks.length ? deriveDescription(blocks) : description,
      descriptionBlocks: blocks,
      images,
      kind,
      shippingFeeCnyFen,
      ageRestricted,
      nftContract,
      nftStandard,
      specs,
      skus,
      autoDeliver,
      stockAlertAt,
      active,
    },
  };
}

// ── 路由 ──

/** 商品分页列表（仅上架商品；附汇率快照 rates，供前端统一换算展示）。
 *
 *  可选 q    ：标题/描述关键词搜索（SQL LIKE 参数化，%/_ 转义为字面量防通配放大）
 *  可选 order：asc（默认，保持既有行为）| desc（**最新上架优先**——聚合前端首屏
 *              必须用它，否则展示的是每家店最早上架的商品）
 *  可选 kind ：逗号分隔的商品类型分面（physical/digital/nft），非法值静默忽略
 *
 *  游标语义：两种方向都以 id 为 keyset 游标，只是比较方向相反——
 *  asc 用 `id > cursor`、desc 用 `id < cursor`；cursor=0 表示首屏无游标。
 *  `nextCursor` 仅在**确有下一页**时非空（多取一行做前瞻判定），
 *  调用方据此即可准确判断到底，无需再发一次空请求。 */
const PRODUCT_KINDS = new Set(['digital', 'physical', 'nft']);

router.get('/', wrap(async (req, res) => {
  const cursor = Math.max(0, parseInt(req.query.cursor, 10) || 0);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  const q = String(req.query.q ?? '').trim().slice(0, 60);
  const order = String(req.query.order ?? '').toLowerCase() === 'desc' ? 'desc' : 'asc';
  const kinds = String(req.query.kind ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => PRODUCT_KINDS.has(s));

  const db = getDb();
  const where = ['active = 1'];
  const args = [];
  if (cursor > 0) {
    where.push(order === 'desc' ? 'id < ?' : 'id > ?');
    args.push(cursor);
  }
  if (q) {
    // LIKE 通配符转义（ESCAPE '\\'）
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  if (kinds.length) {
    where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    args.push(...kinds);
  }

  // 多取一行用于「是否还有下一页」的精确判定（避免满页到底时多一次空请求）
  const raw = db
    .prepare(
      `SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`
    )
    .all(...args, pageSize + 1);
  const hasMore = raw.length > pageSize;
  const rows = hasMore ? raw.slice(0, pageSize) : raw;

  const products = rows.map((row) => {
    const base = rowToPublic(row);
    return base;
  });
  // 商品卡社会信号（P 评审 B12）：列表批量附评价聚合（一次 GROUP BY；avg/count 供卡片展示）
  if (rows.length) {
    const marks = rows.map(() => '?').join(',');
    const agg = db
      .prepare(
        `SELECT product_id AS pid, COUNT(*) AS c, COALESCE(SUM(rating), 0) AS s FROM reviews WHERE product_id IN (${marks}) GROUP BY product_id`
      )
      .all(...rows.map((r) => r.id));
    const bySlug = new Map();
    for (const a of agg) {
      const row = rows.find((r) => r.id === a.pid);
      if (row) bySlug.set(row.slug, { count: a.c, avg: a.c > 0 ? Math.round((a.s / a.c) * 10) / 10 : null });
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
  ok(res, { products, nextCursor: last, rates: rates ? { available: true, ...rates } : null });
}));

/** 店主全量列表（含已下架，卖家面板管理用；需 owner 登录）—— 必须在 /:slug 之前注册。
 *  额外附池口径统计（poolBuilt/poolUnused，仅 digital/nft）：卖家设的总量承诺 vs
 *  码池/NFT 交付池实际未用资源——供面板做「口径冲突预警」（池未用 < 可售余量提示补货）。
 *  公开列表/详情不返回该字段（交付池资源是店主持有信息）。 */
router.get('/all', staffOnly, wrap(async (req, res) => {
  const cursor = Math.max(0, parseInt(req.query.cursor, 10) || 0);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  const rows = getDb()
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM product_codes c WHERE c.product_id = p.id) AS codes_built,
         (SELECT COUNT(*) FROM product_codes c WHERE c.product_id = p.id AND c.status = 'unused') AS codes_unused,
         (SELECT COUNT(*) FROM product_nft_tokens t WHERE t.product_id = p.id) AS tokens_built,
         (SELECT COUNT(*) FROM product_nft_tokens t WHERE t.product_id = p.id AND t.status = 'unused') AS tokens_unused
       FROM products p WHERE p.id > ? ORDER BY p.id ASC LIMIT ?`
    )
    .all(cursor, pageSize);
  // 池口径：poolBuilt=已建池资源总数（0=未建池，手动交付型）；poolUnused=未用数（0 且已建池=池空）
  const products = rows.map((r) => {
    const base = rowToPublic(r);
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
      ...(r.kind === 'digital'
        ? { poolBuilt: r.codes_built, poolUnused: r.codes_unused }
        : r.kind === 'nft'
          ? { poolBuilt: r.tokens_built, poolUnused: r.tokens_unused }
          : { poolBuilt: null, poolUnused: null }),
    };
  });
  const last = rows.length ? rows[rows.length - 1].id : null;
  ok(res, { products, nextCursor: last, rates: null });
}));

/** 商品详情（公开；已下架商品仅店主/操作员登录可见——匿名与第三人 404，防下架内容被探测/收录） */
router.get('/:slug', wrap(async (req, res) => {
  const row = getDb().prepare('SELECT * FROM products WHERE slug = ?').get(String(req.params.slug || ''));
  if (!row) return fail(res, '商品不存在', 404, 404);
  if (!row.active) {
    let authed = null;
    try {
      const t = bearerToken(req);
      if (t) authed = verifyToken(t);
    } catch {
      authed = null;
    }
    if (!authed || !isStaff(authed.address)) return fail(res, '商品不存在或已下架', 404, 404);
  }
  const r = rowToPublic(row);
  const stats = productReviewSummary(row.id);
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
  const data = productReviews(req.params.slug, page, pageSize, filter, sort);
  if (!data) return fail(res, '商品不存在', 404, 404);
  ok(res, data);
}));

/** 店主上架 */
router.post('/', staffOnly, wrap(async (req, res) => {
  const { errors, value } = validateProduct(req.body || {});
  if (errors.length) return fail(res, errors.join('；'));
  const db = getDb();
  /*
    商品标识 = `P` + 10 位 Crockford Base32 随机（11 字符、无连字符，见 src/ids.js）。
    它是对外的稳定标识（URL / 快照 / 评价都挂在它上面），所以：
      · 不掺标题（中文标题转写千奇百怪，改标题也不该改标识）；
      · 不带时间（会向无关的人泄露"何时上架"，同批上架的还会前缀雷同）；
      · 只用不容易念错的字符集（无 I/L/O/U）。
    历史上生成的 `p-<12hex>` 继续有效——这里只定新格式，不做形状校验。
  */
  const slug = newProductSlug();
  const now = Date.now();
  // 一次写入（snapshot_hash NOT NULL）：先由规范化字段算好哈希（kind='nft' 时快照含 nft_contract/nft_standard 键；
  // 运费与年龄限制同键同位进快照——契约见文件头）
  const hash = computeSnapshotHash(
    snapshotObject({
      slug,
      title: value.title,
      description: value.description,
      description_blocks: JSON.stringify(value.descriptionBlocks),
      images: JSON.stringify(value.images),
      kind: value.kind,
      shipping_fee_cny_fen: value.shippingFeeCnyFen,
      age_restricted: value.ageRestricted,
      specs: JSON.stringify(value.specs),
      // 快照与 DB 行同形（sku_key / price_cny_fen），便于同一套规范化逻辑复用
      skus: value.skus.map((s) => ({ sku_key: s.key, price_cny_fen: s.priceCnyFen })),
      nft_contract: value.nftContract,
      nft_standard: value.nftStandard,
    })
  );
  db.prepare(
    'INSERT INTO products (slug, title, description, description_blocks, images, kind, shipping_fee_cny_fen, age_restricted, nft_contract, nft_standard, specs, auto_deliver, stock_alert_at, snapshot_hash, active, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
  ).run(
    slug, value.title, value.description, JSON.stringify(value.descriptionBlocks), JSON.stringify(value.images),
    value.kind, value.shippingFeeCnyFen, value.ageRestricted, value.nftContract, value.nftStandard,
    JSON.stringify(value.specs), value.autoDeliver, value.stockAlertAt, hash, now, now
  );
  saveSkus(db.prepare('SELECT id FROM products WHERE slug = ?').get(slug).id, value.skus, now);
  audit(req, 'product.create', 'product', slug, { kind: value.kind, skuCount: value.skus.length, specs: value.specs.map((s) => s.name), shippingFeeCnyFen: value.shippingFeeCnyFen, ageRestricted: value.ageRestricted });
  ok(res, rowToPublic(db.prepare('SELECT * FROM products WHERE slug = ?').get(slug)), '上架成功');
}));

/** 店主批量更新（P1-②：改价/上下架/经营开关；安全字段子集——不动 kind/合约/池语义）。
 *  patch 字段非法 → 整体拒绝；个别 slug 不存在 → 记 failed 并跳过（成功行照常写入，逐行快照重算）。 */
router.patch('/batch', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const slugs = [...new Set((req.body?.slugs || []).map((x) => String(x)).filter(Boolean))];
  // 超限显式拒绝而非静默截断与 batch-ship「超限即拒」原则一致——
  // 静默截断会让卖家误以为跨页全选 >100 件已全部生效）
  if (slugs.length > 100) {
    return fail(res, `批量修改单次上限 100 件（实际 ${slugs.length} 件）——请分批操作`);
  }
  if (!slugs.length) return fail(res, 'slugs 需为非空数组（≤100）');
  const b = req.body?.patch || {};
  if (typeof b !== 'object' || !Object.keys(b).length) return fail(res, 'patch 需为 {priceCnyFen?/active?/autoDeliver?/stockAlertAt?}');
  // 字段合法性（整体校验）
  if (b.priceCnyFen !== undefined) {
    const fen = Number(b.priceCnyFen);
    if (!Number.isInteger(fen) || fen <= 0 || fen > 100000000000) return fail(res, 'priceCnyFen 需为 1..1e11 整数');
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
    const row = db.prepare('SELECT * FROM products WHERE slug = ?').get(slug);
    if (!row) {
      failed.push({ slug, reason: '商品不存在' });
      continue;
    }
    const next = {
      // 批量改价：作用于该商品的**全部组合**（批量页不展开规格明细；
      // 需要逐组合定价时走单个 PATCH /:slug）
      priceCnyFen: b.priceCnyFen !== undefined ? Number(b.priceCnyFen) : null,
      active: b.active !== undefined ? (b.active === false || b.active === 0 ? 0 : 1) : row.active,
      autoDeliver: b.autoDeliver !== undefined ? Number(b.autoDeliver) : row.auto_deliver,
      stockAlertAt: b.stockAlertAt !== undefined ? (b.stockAlertAt === null || b.stockAlertAt === '' ? null : Number(b.stockAlertAt)) : row.stock_alert_at,
    };
    // 改价：逐组合写入；未指定价格时保持各组合原价
    const skuRows = loadSkus(row.id);
    if (next.priceCnyFen !== null) {
      const up = db.prepare('UPDATE product_skus SET price_cny_fen = ?, updated_at = ? WHERE product_id = ?');
      up.run(next.priceCnyFen, Date.now(), row.id);
    }
    // 快照哈希重算（价格属快照字段；其余 batch 字段不入快照）。
    // 运费/年龄限制取自**当前行**（batch 不改这两项）——漏传会被归一为 0，
    // 于是"批量改个价"就把有运费商品的快照悄悄改成包邮版本，买家全部校验失败。
    const hash = computeSnapshotHash(
      snapshotObject({
        slug: row.slug,
        title: row.title,
        description: row.description,
        images: row.images,
        kind: row.kind,
        shipping_fee_cny_fen: row.shipping_fee_cny_fen,
        age_restricted: row.age_restricted,
        specs: row.specs,
        skus: next.priceCnyFen !== null
          ? skuRows.map((s) => ({ sku_key: s.sku_key, price_cny_fen: next.priceCnyFen }))
          : skuRows,
        nft_contract: row.nft_contract,
        nft_standard: row.nft_standard,
      })
    );
    db.prepare(
      'UPDATE products SET active = ?, auto_deliver = ?, stock_alert_at = ?, snapshot_hash = ?, updated_at = ? WHERE id = ?'
    ).run(next.active, next.autoDeliver, next.stockAlertAt, hash, Date.now(), row.id);
    updated.push(slug);
  }
  ok(res, { updated, failed }, updated.length ? `已更新 ${updated.length} 个商品` : '无商品被更新');
  audit(req, 'product.batch', 'product', updated.join(',') || '-', { updated: updated.length, failed: failed.length });
}));

/** 店主更新（改价/改描述/下架 active=false 等；快照字段变更后自动重算 hash） */
router.patch('/:slug', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM products WHERE slug = ?').get(String(req.params.slug || ''));
  if (!row) return fail(res, '商品不存在', 404, 404);
  const b = req.body || {};
  let baseImages = [];
  try {
    baseImages = JSON.parse(row.images || '[]');
  } catch {
    baseImages = [];
  }
  const prevSkuMap = new Map(loadSkus(row.id).map((s) => [s.sku_key, s]));
  const merged = {
    title: b.title !== undefined ? b.title : row.title,
    description: b.description !== undefined ? b.description : row.description,
    // 详情块：未提交则沿用现有（DB 行 → API 形状）。有块时 description 由块派生。
    descriptionBlocks: b.descriptionBlocks !== undefined ? b.descriptionBlocks : parseBlocks(row.description_blocks),
    images: b.images !== undefined ? b.images : baseImages,
    kind: b.kind !== undefined ? b.kind : row.kind,
    // 运费（按单收取一次；0=包邮）与年龄限制：未提交则沿用现值——它们是快照字段，
    // 漏传等于把商品悄悄改回包邮/无限制（买家手里的哈希随即对不上）
    shippingFeeCnyFen: b.shippingFeeCnyFen !== undefined ? b.shippingFeeCnyFen : row.shipping_fee_cny_fen,
    ageRestricted: b.ageRestricted !== undefined ? b.ageRestricted : row.age_restricted,
    nftContract: b.nftContract !== undefined ? b.nftContract : row.nft_contract,
    nftStandard: b.nftStandard !== undefined ? b.nftStandard : row.nft_standard,
    // 规格与 SKU：未提交则沿用现有（DB 行 → API 形状）
    specs:
      b.specs !== undefined
        ? b.specs
        : (() => {
            try {
              return JSON.parse(row.specs || '[]');
            } catch {
              return [];
            }
          })(),
    // SKU 支持**部分更新**：只提交要改的组合即可（按 key 覆盖到现有列表上）；
    // 省略 priceCnyFen / capacity 时沿用该组合的现值。
    // 只改某组合库存时不必重发全部组合与价格——重发既啰嗦，也容易把别的组合写错。
    skus:
      b.skus !== undefined
        ? (() => {
            const base = loadSkus(row.id).map((s) => ({
              key: s.sku_key,
              priceCnyFen: s.price_cny_fen,
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
            }));
            const byKey = new Map(base.map((s) => [s.key, s]));
            for (const s of Array.isArray(b.skus) ? b.skus : []) {
              const key = String(s?.key ?? '').trim();
              const prev = byKey.get(key) || { priceCnyFen: undefined, capacity: null, active: true };
              byKey.set(key, {
                key,
                priceCnyFen: s?.priceCnyFen !== undefined ? s.priceCnyFen : prev.priceCnyFen,
                capacity: s?.capacity !== undefined ? s.capacity : prev.capacity,
                // 停售：该组合不再可下单，但不影响其它组合（与「售罄」是两回事）
                active: s?.active !== undefined ? !!s.active : (prev.active !== false),
              });
            }
            // specs 一旦变更，组合集合必须由提交方完整给出（否则会残留已不存在的旧组合）
            return b.specs !== undefined ? b.skus : [...byKey.values()];
          })()
        : // 整体更新（未提交 skus）同样要带上 active：否则每个组合都被当成"要上架"
          loadSkus(row.id).map((s) => ({
            key: s.sku_key,
            priceCnyFen: s.price_cny_fen,
            capacity: s.capacity,
            active: s.active !== 0,
          })),
    autoDeliver: b.autoDeliver !== undefined ? b.autoDeliver : row.auto_deliver,
    stockAlertAt: b.stockAlertAt !== undefined ? b.stockAlertAt : row.stock_alert_at,
    active: b.active !== undefined ? b.active : !!row.active,
  };
  // 已建交付池的商品禁止跨类型变更（码池/tokenId 池与 kind 绑定，避免履约语义错乱）；
  // 清空池 = DELETE /api/products/:slug/codes 或 /tokens（ownerOnly，见文件头与对应路由）
  if (merged.kind !== row.kind) {
    if (row.kind === 'digital') {
      const pool = db.prepare('SELECT COUNT(*) AS c FROM product_codes WHERE product_id = ?').get(row.id);
      if (pool.c > 0) return fail(res, '该数字商品已配置兑换码池，不可变更类型；请先清空码池（DELETE /api/products/:slug/codes?confirm=1）');
    }
    if (row.kind === 'nft') {
      const pool = db.prepare('SELECT COUNT(*) AS c FROM product_nft_tokens WHERE product_id = ?').get(row.id);
      if (pool.c > 0) return fail(res, '该 NFT 商品已配置交付池，不可变更类型；请先清空交付池（DELETE /api/products/:slug/tokens?confirm=1）');
    }
  }
  // NFT 商品已建交付池后禁止变更 NFT 标准（交付核验语义与池内库存绑定，避免 erc721/erc1155 错配）
  if (row.kind === 'nft' && merged.kind === 'nft' && merged.nftStandard !== row.nft_standard) {
    const pool = db.prepare('SELECT COUNT(*) AS c FROM product_nft_tokens WHERE product_id = ?').get(row.id);
    if (pool.c > 0) {
      return fail(res, '该 NFT 商品已配置交付池，不可变更 NFT 标准（erc721/erc1155）；请先清空交付池（DELETE /api/products/:slug/tokens?confirm=1）');
    }
  }
  // NFT 商品中途更换合约地址同样禁止（与 nft_standard 同规则）：订单快照锁定旧合约、
  // 池内 tokenId 也属旧合约，换址后旧快照订单永远无法通过核验交付（僵死 escrowed）
  if (
    row.kind === 'nft' && merged.kind === 'nft' &&
    String(merged.nftContract || '').toLowerCase() !== String(row.nft_contract || '').toLowerCase()
  ) {
    const pool = db.prepare('SELECT COUNT(*) AS c FROM product_nft_tokens WHERE product_id = ?').get(row.id);
    if (pool.c > 0) {
      return fail(res, '该 NFT 商品已配置交付池，不可更换 NFT 合约地址；请先清空交付池（DELETE /api/products/:slug/tokens?confirm=1）');
    }
  }
  const { errors, value } = validateProduct(merged);
  if (errors.length) return fail(res, errors.join('；'));
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
    const held = db
      .prepare(
        `SELECT sku_key, COUNT(*) AS c, SUM(quantity) AS q FROM orders
          WHERE product_id = ? AND hold_qty > 0 AND released_at IS NULL
            AND status IN ${DRAFT_OR_ACTIVE_IN}
          GROUP BY sku_key`
      )
      .all(row.id)
      .filter((r) => !newKeys.has(String(r.sku_key ?? '')));
    if (held.length) {
      const detail = held.map((r) => `「${r.sku_key || '默认'}」${r.c} 单/${r.q} 件`).join('、');
      return fail(
        res,
        `规格组合将被删除，但仍有在途订单占着这些组合的库存：${detail}。` +
          '改规格选项名会改变组合标识，这些单的占位将失去对应库存行（余量虚高 → 超卖）。' +
          '请先让这些订单走完（发货确认 / 取消 / 退款 / 超时释放），或保留原选项名只改价格与库存。'
      );
    }
  }
  // 编辑的是总量，不是余量：每个组合的总量不得小于该组合的已占位数
  // （committed 只由订单生命周期驱动——取消/退款/超时自动释放，编辑不释放，
  // 改小即制造矛盾账目）
  const prevSkus = prevSkuMap;
  for (const s of value.skus) {
    const cm = prevSkus.get(s.key)?.committed || 0;
    if (s.capacity !== null && cm > s.capacity) {
      return fail(
        res,
        `组合「${s.key || '默认'}」总库存不能小于已占位/已售 ${cm} 件（销量随订单取消/退款/超时自动释放，编辑不释放）`
      );
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
    const IN_FLIGHT = `(
      o.status IN ${DRAFT_OR_ACTIVE_IN}
      OR (
        o.status = 'refunded'
        AND NOT EXISTS (SELECT 1 FROM order_returns r WHERE r.order_id = o.id AND r.received_at IS NOT NULL)
        AND (o.shipped_at IS NOT NULL OR COALESCE(o.tracking_no, '') <> '' OR EXISTS (SELECT 1 FROM order_delivery_items d WHERE d.order_id = o.id))
      )
    )`;
    // 先整体算一遍在途量，任一组合放不下就整体拒绝（不留部分生效）
    const plans = [];
    for (const s of willRestrict) {
      const inFlight = db
        .prepare(`SELECT COALESCE(SUM(quantity), 0) AS total FROM orders o WHERE o.product_id = ? AND o.sku_key = ? AND o.hold_qty = 0 AND ${IN_FLIGHT}`)
        .get(row.id, s.key).total;
      const cm = prevSkus.get(s.key)?.committed || 0;
      if (cm + inFlight > s.capacity) {
        return fail(
          res,
          `组合「${s.key || '默认'}」切回限量失败：在途/待回收订单尚有 ${inFlight} 件，加已占位/已售 ${cm} 件共需 ${cm + inFlight} 件容量，超过你设置的 ${s.capacity} 件——请提高总量，或先处理在途订单（取消草稿/等待终结/确认回收退货）`
        );
      }
      plans.push({ key: s.key, inFlight });
    }
    // 补记 hold_qty 与 committed 同事务（进程中断不留半写状态：
    // 只补 hold_qty 未加 committed 会造成占位虚高）；
    // SAVEPOINT 嵌套：若调用方已有外层分组，本块自动降级为内层保存点
    txBegin();
    try {
      const addCommitted = db.prepare('UPDATE product_skus SET committed = committed + ? WHERE product_id = ? AND sku_key = ?');
      // 补记 hold_qty 时**必须同时清 released_at**（源码审计 2026-09 修复）：该列是
      // 「本行已释放」的幂等标记，releaseCore 只处理 released_at IS NULL 的行
      //（stockHold.js）。而 hold_qty=0 ∧ released_at 非空 这一组合是 restockOrder 在
      // 「组合当前不限量」分支下**刻意**产生的（占位作废但保留已释放语义）。若此处只补
      // hold_qty 不清标记，该行将永远无法再被释放：后续取消/退款/超时时 releaseCore 直接跳过，
      // committed 永久虚高 1 件（= 一件货再也卖不出去，且没有任何订单与之对应）。
      const markHeld = db.prepare(
        `UPDATE orders AS o SET hold_qty = quantity, released_at = NULL WHERE o.product_id = ? AND o.sku_key = ? AND o.hold_qty = 0 AND ${IN_FLIGHT}`
      );
      for (const p of plans) {
        if (p.inFlight > 0) {
          markHeld.run(row.id, p.key);
          addCommitted.run(p.inFlight, row.id, p.key);
        }
      }
      txCommit();
    } catch (e) {
      txRollback();
      throw e;
    }
  }

  const hash = computeSnapshotHash(
    snapshotObject({
      slug: row.slug,
      title: value.title,
      description: value.description,
      description_blocks: JSON.stringify(value.descriptionBlocks),
      images: JSON.stringify(value.images),
      kind: value.kind,
      shipping_fee_cny_fen: value.shippingFeeCnyFen,
      age_restricted: value.ageRestricted,
      specs: JSON.stringify(value.specs),
      skus: value.skus.map((s) => ({ sku_key: s.key, price_cny_fen: s.priceCnyFen })),
      nft_contract: value.nftContract,
      nft_standard: value.nftStandard,
    })
  );
  db.prepare(
    'UPDATE products SET title = ?, description = ?, description_blocks = ?, images = ?, kind = ?, shipping_fee_cny_fen = ?, age_restricted = ?, nft_contract = ?, nft_standard = ?, specs = ?, auto_deliver = ?, stock_alert_at = ?, active = ?, snapshot_hash = ?, updated_at = ? ' +
      'WHERE id = ?'
  ).run(value.title, value.description, JSON.stringify(value.descriptionBlocks), JSON.stringify(value.images), value.kind, value.shippingFeeCnyFen, value.ageRestricted, value.nftContract, value.nftStandard, JSON.stringify(value.specs), value.autoDeliver, value.stockAlertAt, value.active, hash, Date.now(), row.id);
  // 写 SKU（保留同 key 的 committed，编辑商品不该把已售数量清零）
  saveSkus(row.id, value.skus, Date.now());

  audit(req, 'product.update', 'product', row.slug, { fields: Object.keys(b).filter((k) => ['title','description','descriptionBlocks','specs','skus','autoDeliver','stockAlertAt','active','kind','shippingFeeCnyFen','ageRestricted'].includes(k)) });
  ok(res, rowToPublic(db.prepare('SELECT * FROM products WHERE id = ?').get(row.id)), '已更新');
}));

// ── 兑换码池（数字商品）──

/** 码池统计（供导入/查看接口复用） */
function codeStats(db, productId) {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS c FROM product_codes WHERE product_id = ? GROUP BY status')
    .all(productId);
  const stats = { total: 0, unused: 0, used: 0 };
  for (const r of rows) {
    stats.total += r.c;
    if (r.status === 'unused') stats.unused += r.c;
    else stats.used += r.c;
  }
  return stats;
}

/** 店主导入兑换码（每行一个码，去空白；同商品重复码自动跳过） */
router.post('/:slug/codes', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(String(req.params.slug || ''));
  if (!product) return fail(res, '商品不存在', 404, 404);
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
  const now = Date.now();
  let imported = 0;
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO product_codes (product_id, code, created_at) VALUES (?, ?, ?)'
  );
  // 整批同事务（防进程中断半写：只导入一半 → 返回计数与实际不符、补跑被跳过一半）
  txBegin();
  try {
    for (const code of codes) {
      imported += stmt.run(product.id, code, now).changes;
    }
    txCommit();
  } catch (e) {
    txRollback();
    throw e;
  }
  const stats = codeStats(db, product.id);
  // skipped = 去重后条目中未导入的（超长被过滤 + 与库内重复）
  const skipped = dedup.length - imported;
  // 码池补货后的待交付补跑：此前因池空滞留 escrowed 的自动交付订单（有支付凭证）立即补发。
  // 该函数会逐单做**链上复核**（getOrder：仅 Created 且未申请退款才发），故为 async（见 autoDeliver.js）。
  let autoDelivered = 0;
  if (imported > 0) {
    autoDelivered = await tryAutoDeliverPendingForProduct(product.id);
    if (autoDelivered > 0) {
      console.log(`[autoDeliver] 码池补货后自动补发 ${autoDelivered} 个滞留订单（product=${product.slug}）`);
    }
  }
  ok(
    res,
    { slug: product.slug, imported, skipped, stats, autoDelivered },
    `导入 ${imported} 条，跳过 ${skipped} 条${tooLongCount ? `（其中超长 ${tooLongCount} 条：单条码 ≤200 字符）` : ''}${autoDelivered > 0 ? `；已自动补发 ${autoDelivered} 个待交付订单` : ''}`
  );
  audit(req, 'code.import', 'product', product.slug, { imported, skipped, autoDelivered }); // 不落码原文
}));

/** 店主/操作员查看码池（码为敏感资源：staff 可读——处理退款/对码需要，读取入审计；status 过滤 + id 倒序分页） */
router.get('/:slug/codes', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(String(req.params.slug || ''));
  if (!product) return fail(res, '商品不存在', 404, 404);
  const status = String(req.query.status || 'unused');
  if (!['unused', 'used', 'all'].includes(status)) return fail(res, 'status 需为 unused / used / all');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const where = status === 'all' ? 'product_id = ?' : 'product_id = ? AND status = ?';
  const params = status === 'all' ? [product.id] : [product.id, status];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM product_codes WHERE ${where}`).get(...params).c;
  const codes = db
    .prepare(`SELECT id, code, status, order_id, created_at, used_at FROM product_codes WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  // 码原文为敏感资源：staff 读取（翻页式拉取等价于导出）入审计——只记计数与过滤条件，detail 不含码原文
  audit(req, 'code.read', 'product', product.slug, { status, rows: codes.length });
  ok(res, {
    slug: product.slug,
    stats: codeStats(db, product.id),
    total,
    page,
    pageSize,
    codes: codes.map((c) => ({
      id: c.id,
      code: c.code,
      status: c.status,
      orderId: c.order_id,
      createdAt: c.created_at,
      usedAt: c.used_at,
    })),
  });
}));

/** 店主删除单个码（仅未用码可删——已分配码需先让买家正常使用/退款收回） */
router.delete('/:slug/codes/:id', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(String(req.params.slug || ''));
  if (!product) return fail(res, '商品不存在', 404, 404);
  const row = db
    .prepare('SELECT * FROM product_codes WHERE id = ? AND product_id = ?')
    .get(Number(req.params.id) || 0, product.id);
  if (!row) return fail(res, '码不存在', 404, 404);
  if (row.status !== 'unused') return fail(res, '仅可删除未分配状态的码');
  db.prepare('DELETE FROM product_codes WHERE id = ?').run(row.id);
  audit(req, 'code.delete', 'product', product.slug, { codeId: row.id });
  ok(res, { slug: product.slug, deleted: row.id, stats: codeStats(db, product.id) }, '已删除');
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
 * 同时它让 `check:integrity` 的判据②（池里 used 却无交付行）与判据①长期互相打架。
 * 保留 `used` 行 = 该码在本店**永不复用**的墓碑，与"码不回池复用"的既有安全语义一致。
 * 代价如实写明：`used` 行会一直留在池里计入 `total`，店主看到的总数是"含历史"的；
 * 需要彻底清掉请先确认无历史订单依赖，再走库级维护（OPS_RUNBOOK）。
 */
router.delete('/:slug/codes', ownerOnly, wrap(async (req, res) => {
  if (req.query.confirm !== '1') return fail(res, '清空码池为整批不可逆操作，需带 ?confirm=1 二次确认');
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(String(req.params.slug || ''));
  if (!product) return fail(res, '商品不存在', 404, 404);
  if (product.kind !== 'digital') return fail(res, '仅数字商品有兑换码池');
  const stats = codeStats(db, product.id);
  const removed = db.prepare("DELETE FROM product_codes WHERE product_id = ? AND status = 'unused'").run(product.id).changes;
  audit(req, 'code.clear', 'product', product.slug, { deleted: removed, keptUsed: stats.used });
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
function nftStats(db, productId) {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS c FROM product_nft_tokens WHERE product_id = ? GROUP BY status')
    .all(productId);
  const stats = { total: 0, unused: 0, used: 0 };
  for (const r of rows) {
    stats.total += r.c;
    if (r.status === 'unused') stats.unused += r.c;
    else stats.used += r.c;
  }
  return stats;
}

/** 单次导入展开后的 tokenId 条数上限 */
const NFT_MAX_IMPORT = 500;

/**
 * 解析单条 tokenId 输入：`123` / `0x1F` / 闭区间范围 `10-20`。
 * 返回 { ok: true, values: bigint[] } 或 { ok: false, error }。
 * 数值须在 uint256 内且展开不超过单次上限（防范围炸弹）。
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
  const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(String(req.params.slug || ''));
  if (!product) return fail(res, '商品不存在', 404, 404);
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
  const now = Date.now();
  let imported = 0;
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO product_nft_tokens (product_id, token_id, created_at) VALUES (?, ?, ?)'
  );
  // 整批同事务（防进程中断半写：tokenId 池只入一半 → 统计与可交付量错位）
  txBegin();
  try {
    for (const tokenId of values) {
      imported += stmt.run(product.id, tokenId, now).changes;
    }
    txCommit();
  } catch (e) {
    txRollback();
    throw e;
  }
  const stats = nftStats(db, product.id);
  const skipped = values.length - imported;
  ok(res, { slug: product.slug, imported, skipped, stats }, `导入 ${imported} 个 tokenId，跳过 ${skipped} 个（重复）`);
  audit(req, 'token.import', 'product', product.slug, { imported, skipped });
}));

/** 店主/操作员查看 NFT 交付池（tokenId 为交付库存，staff 可读——处理退款/对码需要，读取入审计；status 过滤 + id 倒序分页） */
router.get('/:slug/tokens', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(String(req.params.slug || ''));
  if (!product) return fail(res, '商品不存在', 404, 404);
  const status = String(req.query.status || 'unused');
  if (!['unused', 'used', 'all'].includes(status)) return fail(res, 'status 需为 unused / used / all');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const where = status === 'all' ? 'product_id = ?' : 'product_id = ? AND status = ?';
  const params = status === 'all' ? [product.id] : [product.id, status];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM product_nft_tokens WHERE ${where}`).get(...params).c;
  const tokens = db
    .prepare(`SELECT id, token_id, status, order_id, created_at, used_at FROM product_nft_tokens WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  // tokenId 交付池为敏感资源：staff 读取入审计（只记计数与过滤条件，detail 不含 tokenId 列表）
  audit(req, 'token.read', 'product', product.slug, { status, rows: tokens.length });
  ok(res, {
    slug: product.slug,
    stats: nftStats(db, product.id),
    total,
    page,
    pageSize,
    tokens: tokens.map((t) => ({
      id: t.id,
      tokenId: t.token_id,
      status: t.status,
      orderId: t.order_id,
      createdAt: t.created_at,
      usedAt: t.used_at,
    })),
  });
}));

/** 店主删除单个未用 tokenId（已交付的需买家正常收货/退款收回后另行处理） */
router.delete('/:slug/tokens/:id', staffOnly, wrap(async (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(String(req.params.slug || ''));
  if (!product) return fail(res, '商品不存在', 404, 404);
  const row = db
    .prepare('SELECT * FROM product_nft_tokens WHERE id = ? AND product_id = ?')
    .get(Number(req.params.id) || 0, product.id);
  if (!row) return fail(res, 'tokenId 不存在', 404, 404);
  if (row.status !== 'unused') return fail(res, '仅可删除未交付状态的 tokenId');
  db.prepare('DELETE FROM product_nft_tokens WHERE id = ?').run(row.id);
  audit(req, 'token.delete', 'product', product.slug, { tokenId: row.id });
  ok(res, { slug: product.slug, deleted: row.id, stats: nftStats(db, product.id) }, '已删除');
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
  const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(String(req.params.slug || ''));
  if (!product) return fail(res, '商品不存在', 404, 404);
  if (product.kind !== 'nft') return fail(res, '仅 NFT 商品有 tokenId 交付池');
  const stats = nftStats(db, product.id);
  db.prepare('DELETE FROM product_nft_tokens WHERE product_id = ?').run(product.id);
  audit(req, 'token.clear', 'product', product.slug, { deleted: stats.total });
  ok(res, { slug: product.slug, cleared: stats.total }, stats.total ? `已清空交付池（${stats.total} 条，含已交付记录；历史订单凭证不受影响）` : '交付池已为空');
}));

export default router;
