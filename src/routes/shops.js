/**
 * 店铺目录与开店审批（挂 `/api/shops`）——**店铺完全在节点链下**。
 *
 *  GET  /                    公开：本节点**在售**店铺列表（编号/店名/卖家地址/在售状态）
 *  GET  /admin/all           节点管理员：本节点**全部**店铺（含暂停接单，用于节点主恢复）
 *  PATCH /admin/listing       节点管理员：批量暂停/恢复接单 {codes, listed, reason}
 *  PATCH /admin/:code/listing 节点管理员：暂停/恢复一家店的接单（原因必填）
 *  GET  /:code               公开：单店详情（含在售状态）
 *  POST /applications        店主提交开店申请（需登录；只有店名/公告）
 *  GET  /applications/list   节点主/员工查看申请队列（nodeAdmin；page/pageSize/q，返回 total）
 *  GET  /applications/mine   店主查看**自己**的申请进展（需登录）
 *  POST /applications/:id/review   节点主/员工审批（nodeAdmin）：通过 ⇒ **本节点铸造编号并建店**；驳回 ⇒ 记原因
 *  POST /applications/batch-review 节点主/员工**批量**审批（nodeAdmin）：整批通过/整批驳回，任一条不满足则整批不写
 *
 * ## 平台没有店铺
 *
 * 平台唯一合约（`MarketplaceRegistry`）只登记节点（operator/escrow/staking/endpoint），
 * 没有 `registerShop`、没有双签票据、没有费率、没有"店铺上链"这回事。店铺是本节点的租户行：
 *   · 审批通过时由**本节点**铸造 9 位编号（`src/ids.js` 的 `newShopCode`）并插入 `shops`；
 *   · `listed` 是本节点自己的开关（节点主/员工暂停）；
 *   · 没有链上交易、没有 gas、没有需要钱包签名的步骤——因此这里只有"提交/审批"两步。
 *
 * ## 没有抽成
 *
 * 零费模型：平台不收、节点也不收，托管结算只有买家/卖家两条腿。申请里没有费率字段，
 * 审批也不设置费率——钱的分配在链上（`Escrow._settle`）只有退款与卖家两笔。
 */
import { Router } from 'express';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit, bearerToken } from '../http.js';
import { verifyToken, isHost } from '../auth.js';
import config from '../config.js';
import { getDb, withTransaction, abortTx } from '../db.js';
import { logAudit } from '../audit.js';
import { isAddress, isZeroAddress } from '../chain.js';
import { newShopCode } from '../ids.js';
import { blockedSellers, blockedShopCodes } from '../blocks.js';
import { notifyRaw } from '../webhook.js';
import {
  nodeOwner,
  listListedShopRows,
  listShopRowsWithCounts,
  shopDto,
  shopRowByCode,
  shopRowBySeller,
  resolveShopRef,
  isShopCodeShape,
} from '../shops.js';

const router = Router();
const requireAuth = makeAuthMiddleware(verifyToken);
const nodeAdmin = makeAuthMiddleware(verifyToken, { nodeAdmin: true });
// 开店申请是免费 SIWE 的写入口：不限流时可用大量地址填满申请队列与库（节点主审核面 DoS）
const applicationLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '开店申请过于频繁，请稍后再试' });

/** 可选登录：目录公开可读，但带买家令牌时按该买家在本节点的屏蔽过滤。 */
function optionalBuyer(req) {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    const payload = verifyToken(token);
    return String(payload?.address || '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * 审计便捷包装（本文件只有 nodeAdmin 路由：开店与店铺治理）。
 * 这些动作**都是节点级**，`shopCode: null`：
 *  · 申请不是一家店——编号在审批通过那一刻才由本节点铸造；
 *  · 这是节点主的治理动作，而治理记录必须留给**节点主**看（审计列表按店过滤之后，
 *    挂到某家店名下的行只有那家店的店主看得到——节点主自己的动作反而从自己的视野里消失）；
 *  · 编号确实存在的那个时刻记在 `detail.code` 里（created），不是这一行的归属。
 */
const audit = async (req, action, targetType, targetId, detail) =>
  logAudit({
    req,
    actor: req.auth?.address,
    actorRole: (await isHost(req.auth?.address)) ? 'host' : 'staff',
    shopCode: null,
    action,
    targetType,
    targetId,
    detail,
  });

/**
 * **店铺接单状态的唯一写内核**：单品与批量共用。
 *
 * 一次事务里锁行、判状态、写状态；事务提交后逐店写节点级审计并推卖家 webhook。
 * 单品与批量因此在"原因清空、时间戳、审计字段、通知"上不可能漂移。
 *
 * 返回 `{ missing }` = 有编号不存在（**整批不写**）；否则 `{ changed }` 只含真正
 * 从目标状态反转的行（已在目标状态的店不重复写、不重复通知）。
 */
async function setShopsListing({ req, codes, listed, reason, batch = false }) {
  const out = await withTransaction(async () => {
    const marks = codes.map(() => '?').join(',');
    const rows = await getDb().all(
      `SELECT code, seller, name, notice, tanxin_address, listed, listed_reason, listed_at
         FROM shops WHERE code IN (${marks}) FOR UPDATE`,
      ...codes
    );
    const found = new Set(rows.map((r) => String(r.code)));
    const missing = codes.filter((c) => !found.has(c));
    if (missing.length) return { missing };
    const changed = rows.filter((r) => (Number(r.listed) === 1) !== listed);
    for (const r of changed) {
      await getDb().run(
        'UPDATE shops SET listed = ?, listed_reason = ?, listed_at = CURRENT_TIMESTAMP(3) WHERE code = ?',
        listed ? 1 : 0,
        listed ? '' : reason,
        r.code
      );
    }
    return { changed };
  });

  if (out.missing) return out;
  for (const r of out.changed) {
    await audit(req, listed ? 'shop.resume' : 'shop.suspend', 'shop', r.code, {
      code: r.code,
      name: r.name,
      reason: listed ? '' : reason,
      ...(batch ? { batch: true, batchSize: out.changed.length } : {}),
    });
    // 店主应该立刻知道自己的店被暂停/恢复（而不是下次打开面板才发现）。fire-and-forget：
    // 未配置 webhook 时零开销；投递失败由 webhook 自己留痕，不回滚这次治理动作。
    void notifyRaw(listed ? 'shop.resume' : 'shop.suspend', {
      shopCode: r.code,
      code: r.code,
      name: r.name,
      reason: listed ? '' : reason,
    });
  }
  return out;
}

/**
 * MySQL 唯一键冲突（`ER_DUP_ENTRY`）判定 —— **唯一实现**。
 *
 * "一个钱包只能有一条未终结申请"交给**库约束**（`uq_applications_open`）而不是先查后插：
 * "先 SELECT 再 INSERT"是两个时刻，并发两次提交都能读到"没有"，于是两条都插进去，
 * 之后审批队列里出现两张同一家店的申请。这里只把库给出的冲突翻译成一句能照着做的话（409）。
 */
function isDuplicateKey(e) {
  return e?.code === 'ER_DUP_ENTRY' || Number(e?.errno) === 1062;
}

/**
 * 申请行的对外形状（**唯一一份**：队列、我的申请与单条回执共用）。
 *
 * `shopCode` 只对 approved 下发：它回答"这条申请开出了哪家店"。pending / rejected 时
 * 这个钱包可能恰有一家店（由别的路径开出），但那不是**这条申请**的结果，不能挂在它头上。
 * 读查询用 `applicationRows()` 的 LEFT JOIN 提供；单条回执由调用方把刚铸造的编号传进来。
 */
function applicationDto(row, shopCode = null) {
  const approved = row.status === 'approved';
  return {
    id: String(row.id),
    seller: row.seller,
    name: row.name || '',
    notice: row.notice || '',
    status: row.status,
    rejectReason: row.reject_reason || '',
    /** approved ⇒ 本节点为这个钱包建出的店铺编号；其余状态恒为 null */
    shopCode: approved ? (shopCode || row.shop_code || null) : null,
    reviewedAt: row.reviewed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 申请行 + 已开出的店铺编号（**唯一读形状**：队列与我的申请共用）。
 *
 * 为什么 JOIN 而不是另查一次：一个钱包在本节点只有一家店（`uq_shops_seller`），
 * 所以 `shops.seller` 就是这条申请的结果归属；两处各写一句 SELECT 只会在加字段时漂移。
 * JOIN 列 `shop_code` 只有 approved 行有意义，由 `applicationDto` 按状态收口。
 *
 * `whereOrderSql` 只接**静态片段**，值一律走 `...params`（与全仓 SQL 拼接纪律一致）。
 */
async function applicationRows(whereOrderSql, ...params) {
  return await getDb().all(
    `SELECT a.*, s.code AS shop_code
       FROM shop_applications a
       LEFT JOIN shops s ON s.seller = a.seller
      ${whereOrderSql}`,
    ...params
  );
}

/** 公开：本节点在售店铺列表（`listed = 0` 的店**不进**这个列表——它已经不接单也不该被聚合） */
router.get('/', wrap(async (req, res) => {
  const nodeAddr = await nodeOwner();
  const buyer = optionalBuyer(req);
  let rows = await listListedShopRows();
  const totalListed = rows.length;
  if (buyer) {
    const [codes, sellers] = await Promise.all([blockedShopCodes(buyer), blockedSellers(buyer)]);
    rows = rows.filter((r) => !codes.has(String(r.code)) && !sellers.has(String(r.seller || '').toLowerCase()));
  }
  ok(res, {
    host: nodeAddr || null,
    shops: rows.map((r) => shopDto(r, nodeAddr)),
    /** 该买家在本节点设置的屏蔽导致目录隐藏的店铺数（不是全节点统计） */
    hiddenBlocked: totalListed - rows.length,
  });
}));

/**
 * 节点管理员：本节点**全部**店铺（含 `listed = 0` 的暂停接单店）。
 *
 * 为什么必须单独一条鉴权路由，而不是给公开 `/` 加 `?all=1`：
 * 暂停接单的店在公开面按"不存在"处理（单店详情 404），公开列表不能因为一个查询参数
 * 就把它重新列出来。节点主恢复店铺需要看到它，判据是**节点管理员身份**（节点主或员工）。
 */
router.get('/admin/all', nodeAdmin, wrap(async (req, res) => {
  const nodeAddr = await nodeOwner();
  const rows = await listShopRowsWithCounts();
  ok(res, {
    host: nodeAddr || null,
    shops: rows.map((r) => ({
      ...shopDto(r, nodeAddr),
      /** 节点管理面才用的开店时刻（公开 DTO 不暴露内部时序） */
      createdAt: r.created_at,
      productCount: Number(r.product_count),
      listedProductCount: Number(r.listed_product_count),
      hiddenProductCount: Number(r.hidden_product_count),
    })),
  });
}));

/**
 * 节点管理员：**批量**暂停 / 恢复店铺接单（`PATCH /admin/listing`）。
 *
 * 与单品同一套状态与审计，只是把「一次请求 N 家」收成一个事务：
 *   · 全部编号必须存在（缺一家就整批拒绝，不出现"成功 7 家、失败 3 家"的模糊结果）；
 *   · 已在目标状态的店计入 `unchanged`，不重复写、不重复通知；
 *   · 暂停必填原因，恢复清空原因；上限 100 与商品批量同口径。
 */
router.patch('/admin/listing', nodeAdmin, wrap(async (req, res) => {
  const raw = req.body?.codes;
  if (!Array.isArray(raw)) return fail(res, 'codes 需为店铺编号数组（1..100）', 400, 400);
  const codes = [...new Set(raw.map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean))];
  if (!codes.length) return fail(res, 'codes 需为非空数组（1..100）', 400, 400);
  if (codes.length > 100) return fail(res, `批量处置单次上限 100 家（实际 ${codes.length} 家）——请分批操作`, 400, 400);
  const bad = codes.filter((c) => !isShopCodeShape(c));
  if (bad.length) return fail(res, `店铺编号形状非法：${bad.slice(0, 10).join('、')}`, 400, 400);
  const listed = req.body?.listed;
  if (typeof listed !== 'boolean') return fail(res, 'listed 需为布尔值（true=恢复接单，false=暂停接单）', 400, 400);
  const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
  if (!listed && !reason) return fail(res, '暂停接单必须填写原因（≤200 字，店主会在店铺设置页看到）', 400, 400);

  const out = await setShopsListing({ req, codes, listed, reason, batch: true });
  if (out.missing) {
    const shown = out.missing.slice(0, 10).join('、');
    return fail(res, `这些店铺不存在（整批未执行）：${shown}${out.missing.length > 10 ? ' …' : ''}`, 404, 404);
  }
  const changed = out.changed || [];
  ok(
    res,
    { listed, updated: changed.map((r) => r.code), unchanged: codes.length - changed.length },
    changed.length
      ? `${listed ? '已恢复' : '已暂停'} ${changed.length} 家店铺${codes.length > changed.length ? `（${codes.length - changed.length} 家已在目标状态）` : ''}`
      : '所选店铺都已在目标状态，无需操作'
  );
}));

/**
 * 节点管理员：暂停 / 恢复一家店的接单（`PATCH /admin/:code/listing`）。
 *
 * 请求体：`{listed: boolean, reason?: string}`。
 *   · `listed=false` 必须给原因：店主会在设置页看到它，否则"为什么不能卖"只能靠猜；
 *   · `listed=true` 清空原因（店已恢复，旧原因不该继续挂在店上）。
 *
 * 为什么是节点级动作而不是店主自助：暂停接单的判据是"本节点允不允许这家店继续接单"，
 * 与店主自己的经营意愿是两件事。`listed` 只影响**未来销售**（聚合面 + 建单闸）；
 * 在途订单、退款、售后、数据导出全部照常，因此不需要停机、也不碰任何链上状态。
 */
router.patch('/admin/:code/listing', nodeAdmin, wrap(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const listed = req.body?.listed;
  if (typeof listed !== 'boolean') return fail(res, 'listed 需为布尔值（true=恢复接单，false=暂停接单）', 400, 400);
  const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
  if (!listed && !reason) return fail(res, '暂停接单必须填写原因（≤200 字，店主会在店铺设置页看到）', 400, 400);

  const out = await setShopsListing({ req, codes: [code], listed, reason });
  if (out.missing) return fail(res, '店铺不存在', 404, 404);
  const fresh = await shopRowByCode(code);
  if (!out.changed.length) {
    return ok(
      res,
      shopDto(fresh, await nodeOwner()),
      listed ? '该店已在接单，无需恢复' : '该店已暂停接单，无需重复暂停'
    );
  }
  ok(
    res,
    shopDto(fresh, await nodeOwner()),
    listed ? '已恢复接单（商品重新进入聚合面）' : `已暂停接单：${reason}`
  );
}));

/**
 * 公开：单店详情。
 * **暂停接单的店对匿名访问按"不存在"处理**（404）：公开详情若仍可读，等于把"暂停接单"
 * 做成"只是不显示在列表里"。店主/店员要读自己的店走带鉴权的 `/api/shop/settings`。
 *
 * 两次查找**都必须 await**：`shopRowByCode(...) || resolveShopRef(...)` 里的 `||` 作用在
 * Promise 上时左侧恒真（哪怕店铺不存在），于是"没有这家店"这条 404 永远不会走到。
 */
router.get('/:code', wrap(async (req, res) => {
  const ref = String(req.params.code || '');
  const row = (await shopRowByCode(ref.toUpperCase())) || (await resolveShopRef(ref));
  if (!row || Number(row.listed) !== 1) {
    return fail(res, '没有这家店（或该店已暂停接单）', 404, 404);
  }
  ok(res, shopDto(row, await nodeOwner()));
}));

/**
 * 提交开店申请（需登录）。
 *
 * 请求体：`{name, notice}`（`name` **必填**：店名是店铺在目录里的身份，没有默认名）。
 *   · `seller` 取**登录地址**（不由请求体给）：申请是"我请求在你的节点下开店"，
 *     让别人代提申请没有意义，也给了冒名占位的面；
 *   · 没有费率、没有签名、没有票据：这些概念随"店铺上链"一起删除了。
 */
router.post('/applications', requireAuth, applicationLimiter, wrap(async (req, res) => {
  const hostAddr = await nodeOwner();
  if (!hostAddr) return fail(res, '本节点未配置节点主地址（MK_SHOP_OWNER），无法受理开店申请');
  const seller = String(req.auth?.address || '').toLowerCase();
  if (!isAddress(seller) || isZeroAddress(seller)) return fail(res, '登录地址非法');
  const { name, notice } = req.body || {};
  const nameText = String(name ?? '').trim().slice(0, 60);
  const noticeText = String(notice ?? '').trim().slice(0, 500);
  // 店名**必填**：它是一家店在目录里的身份，没有默认名可回退。
  if (!nameText) return fail(res, '店名不能为空（≤60 字）：店铺在目录里靠它被买家识别');

  const db = getDb();
  /*
    一个钱包在本节点只能开一家店（`shops.uq_shops_seller` 是真正的判据）：先给一句可读的话。
    没有"墓碑重开"这一档——店铺不注销，只是 `listed=0`，那一行仍然占着 seller。
  */
  const existing = await shopRowBySeller(seller);
  if (existing) {
    return fail(res, '该钱包在本节点已有店铺（一个钱包只能开一家店）', 409, 409);
  }
  /*
    队列容量是**节点级**的准入判据：count 与 insert 必须在同一个事务、同一把锁下完成，
    否则 N 个并发提交会各自看到"还没满"而一起插进去。锁 `node` 单例行（不是全表）：
    所有提交都走这一条路径，短暂串行换"上限真的成立"。
    `maxPending = 0` 表示不设上限（受控测试环境）。
  */
  const maxPending = config.applications.maxPending;
  let id;
  try {
    const out = await withTransaction(async () => {
      if (maxPending > 0) {
        await db.get('SELECT id FROM node WHERE id = 1 FOR UPDATE');
        const pending = Number(
          (await db.get("SELECT COUNT(*) AS c FROM shop_applications WHERE status = 'pending'")).c
        );
        if (pending >= maxPending) return { full: pending };
      }
      const ins = await db.run(
        'INSERT INTO shop_applications (seller, name, notice, status) VALUES (?, ?, ?, ?)',
        seller,
        nameText,
        noticeText,
        'pending'
      );
      return { id: Number(ins.insertId) };
    });
    if (out.full !== undefined) {
      return fail(
        res,
        `待审批队列已满（${out.full}/${maxPending} 条）：请等待节点处理后再申请`,
        503,
        503
      );
    }
    id = out.id;
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    // 库里已经有这个钱包的未终结申请（函数唯一索引 uq_applications_open 拒绝第二条）
    const dup = await db.get("SELECT id FROM shop_applications WHERE seller = ? AND status = 'pending'", seller);
    return fail(res, `你已有一条待审批的开店申请（#${dup ? dup.id : '?'}），请等待节点主处理`, 409, 409);
  }
  ok(
    res,
    applicationDto(await db.get('SELECT * FROM shop_applications WHERE id = ?', id)),
    '申请已提交。节点主/员工审批通过后，本节点会为该钱包开店并分配编号'
  );
}));

/**
 * 申请队列（nodeAdmin）：默认只出待审批的，`?all=1` 出全部历史。
 *
 * 分页（`page` / `pageSize`，默认 30、上限 100）而不是一次全出：申请是免费 SIWE 的写入口，
 * 限流挡不住"多 IP、多钱包"把待审批队列灌大；管理页拿到几千行再全量渲染，先垮的是审核面。
 * 返回 `total` 让界面能说清"还有多少条没载入"（`applications` 只是本页）。
 * 排序：待审批按 id 升序（先来先审）；历史按 id 降序（最近处理在前）。
 *
 * `q` 搜店名或店主地址（≤60 字，大小写不敏感）：地址列是 `as_cs`，所以要显式 `COLLATE
 * utf8mb4_0900_ai_ci` 才搜得到大小写不同的写法；LIKE 的 `%`/`_`/`\` 与商品搜索同一套转义。
 * 过滤条件同时作用于 COUNT 与列表——否则 `total` 会把没显示的行算进来。
 */
router.get('/applications/list', nodeAdmin, wrap(async (req, res) => {
  const all = String(req.query.all || '') === '1';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  const q = String(req.query.q ?? '').trim().slice(0, 60);
  const where = [];
  const args = [];
  if (!all) where.push("a.status = 'pending'");
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    where.push(
      "(a.name COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\'" +
        " OR a.seller COLLATE utf8mb4_0900_ai_ci LIKE ? ESCAPE '\\\\')"
    );
    args.push(like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    (await getDb().get(`SELECT COUNT(*) AS c FROM shop_applications a ${whereSql}`, ...args)).c
  );
  const rows = await applicationRows(
    `${whereSql} ORDER BY a.id ${all ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`,
    ...args,
    pageSize,
    (page - 1) * pageSize
  );
  ok(res, {
    applications: rows.map((row) => applicationDto(row)),
    total,
    page,
    pageSize,
  });
}));

/**
 * **我自己的申请**（需登录）：店主提交之后唯一的反馈渠道。
 *
 * 为什么必须有这一条：队列接口是 `nodeAdmin`（节点主的治理视图），而店主既不知道节点主
 * 看没看到、也不知道自己被拒了还是还在等。范围按**登录地址**收窄（不按请求头/店铺头）：
 * 申请是"这个钱包请求在这台节点下开店"，与店无关（编号还没铸造）。
 */
router.get('/applications/mine', requireAuth, wrap(async (req, res) => {
  const seller = String(req.auth?.address || '').toLowerCase();
  const all = String(req.query.all || '') === '1';
  const rows = all
    ? await applicationRows('WHERE a.seller = ? ORDER BY a.id DESC', seller)
    : await applicationRows("WHERE a.seller = ? AND a.status = 'pending' ORDER BY a.id DESC", seller);
  ok(res, { applications: rows.map((row) => applicationDto(row)) });
}));

/**
 * **开店审批的唯一写内核**：单品 `POST /applications/:id/review` 与批量
 * `POST /applications/batch-review` 共用。
 *
 * 一次事务里锁申请行、判状态、判店主是否已有店、建店（仅 approve）并置状态；事务提交后
 * 逐条写节点级审计。单品与批量因此在"并发下只批一次、编号冲突重试、原因清空、审计字段"
 * 上不可能漂移——新增第三个入口只要调用它，就自动具备同一套语义。
 *
 * 返回（前三种都**不写库**）：
 *   · `{ missing }`   申请不存在；
 *   · `{ stale }`     已不是 pending（并发审批 / 已处理过）；
 *   · `{ exists }`    该钱包在本节点已有店铺（仅 approve）；
 *   · `{ approved }` / `{ rejected }` 成功。
 *
 * 批量语义是**整批**：只要有一条不满足就整批不执行（与店铺暂停、商品下架同一口径），
 * 不出现"成功 7 条、失败 3 条"这种让操作者以为都办好了的结果。
 */
async function reviewApplications({ req, ids, action, reason, batch = false }) {
  const db = getDb();
  const actor = String(req.auth?.address || '').toLowerCase();
  /*
    节点主可以审批自己的申请：节点主就是这台机器的最高治理者，没有更高的“上级”可批。
    员工不行——员工用自己的钱包申请再自批，会把运营权限变成自己的收款店铺。
  */
  const actorIsHost = await isHost(actor);
  const out = await withTransaction(async () => {
    const marks = ids.map(() => '?').join(',');
    /*
      锁行顺序按 id：两个批量请求（或批量与单品交错）以同一顺序取锁，避免死锁；
      锁住之后再看状态，"并发的两次审批只有一个能建成店"这条判据才成立。
    */
    const rows = await db.all(
      `SELECT id, seller, name, notice, status FROM shop_applications
        WHERE id IN (${marks}) ORDER BY id FOR UPDATE`,
      ...ids
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) return { missing };
    const stale = ids
      .filter((id) => byId.get(id).status !== 'pending')
      .map((id) => ({ id, status: byId.get(id).status }));
    if (stale.length) return { stale };
    const ordered = ids.map((id) => byId.get(id));
    const reviewedAt = new Date();
    /*
      运营权限不能变成自己的收款店铺：员工用自己的钱包申请、再自己批准，会直接拿到一个
      `shops.seller = 自己` 的永久租户（`uq_shops_seller` 还让节点主之后也无法再给该地址开店）。
      员工自己的申请必须由节点主批准；节点主自己的申请由节点主批准（没有更高审批人）。
    */
    if (action === 'approve') {
      const self = ordered.find((r) => String(r.seller).toLowerCase() === actor);
      if (self && !actorIsHost) return { self: [Number(self.id)] };
    }

    if (action === 'reject') {
      const updateMarks = ids.map(() => '?').join(',');
      await db.run(
        `UPDATE shop_applications SET status = 'rejected', reject_reason = ?, reviewed_at = ?
          WHERE id IN (${updateMarks})`,
        reason, reviewedAt, ...ids
      );
      return { rejected: ordered.map((r) => ({ id: Number(r.id), seller: String(r.seller).toLowerCase(), name: String(r.name || '') })) };
    }

    /*
      一个钱包只能开一家店：真正的判据是 `uq_shops_seller`。这里先读一次只是为了给
      "整批未执行"一个可读原因；读与写在同一事务、申请行已锁，正常路径不会漂移。
    */
    const sellers = [...new Set(ordered.map((r) => String(r.seller).toLowerCase()))];
    const shopMarks = sellers.map(() => '?').join(',');
    const existing = await db.all(`SELECT seller FROM shops WHERE seller IN (${shopMarks})`, ...sellers);
    if (existing.length) return { exists: existing.map((r) => String(r.seller)) };

    const approved = [];
    for (const app of ordered) {
      const seller = String(app.seller).toLowerCase();
      /*
        编号冲突（同一毫秒随机撞车，概率极低但必须处理）：唯一键拒绝后换一个编号重试。
        重试放在**同一事务**里：任一次成功即建店，全部失败则整笔回滚（不会留下半行）。
        撞的若是 `uq_shops_seller`（同一钱包已有店），换编号不会成功：整批回滚并如实返回。
      */
      let code = '';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = newShopCode();
        try {
          await db.run(
            `INSERT INTO shops (code, seller, name, notice, listed) VALUES (?, ?, ?, ?, 1)`,
            candidate, seller, app.name || '', app.notice || ''
          );
          code = candidate;
          break;
        } catch (e) {
          if (!isDuplicateKey(e)) throw e;
          if (/uq_shops_seller/.test(String(e?.message || ''))) return abortTx({ exists: [seller] });
        }
      }
      if (!code) throw new Error('店铺编号连续冲突（5 次）：请重试');
      await db.run(
        "UPDATE shop_applications SET status = 'approved', reviewed_at = ? WHERE id = ?",
        reviewedAt, app.id
      );
      approved.push({ id: Number(app.id), seller, code, name: String(app.name || '') });
    }
    return { approved };
  });

  if (out.missing || out.stale || out.exists || out.self) return out;
  if (action === 'reject') {
    for (const r of out.rejected) {
      await audit(req, 'shop.application.reject', 'shop_application', String(r.id), {
        seller: r.seller,
        name: r.name,
        reason,
        ...(batch ? { batch: true, batchSize: out.rejected.length } : {}),
      });
    }
    return out;
  }
  for (const r of out.approved) {
    await audit(req, 'shop.application.approve', 'shop_application', String(r.id), {
      seller: r.seller,
      name: r.name,
      code: r.code,
      ...(batch ? { batch: true, batchSize: out.approved.length } : {}),
    });
  }
  return out;
}

/**
 * 审批（nodeAdmin：节点主或本节点员工）。
 *   · `{action:'reject', reason}` ⇒ 置 rejected（申请人可改名再申请：唯一索引只约束 pending）；
 *   · `{action:'approve'}` ⇒ **同一个事务里**铸造编号、插入 `shops` 行、把申请置 approved。
 *
 * 为什么建店与置状态必须在同一个事务：两个都是"审批通过"的后果；只做一半会留下
 * "申请还挂着 pending、店却已经能卖"（或反过来"申请已通过、店不存在"，店主永远开不了店）。
 */
router.post('/applications/:id/review', nodeAdmin, wrap(async (req, res) => {
  const id = Number(String(req.params.id ?? '').trim());
  if (!Number.isInteger(id) || id <= 0) return fail(res, 'id 需为申请的正整数编号');
  const action = String(req.body?.action || '');
  if (action !== 'approve' && action !== 'reject') return fail(res, 'action 需为 approve / reject');
  const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
  if (action === 'reject' && !reason) {
    return fail(res, '驳回开店申请必须填写原因（≤200 字，申请人会看到）', 400, 400);
  }

  const out = await reviewApplications({ req, ids: [id], action, reason });
  if (out.missing) return fail(res, '申请不存在', 404, 404);
  if (out.stale) return fail(res, `该申请已经是「${out.stale[0].status}」，不能重复审批`, 409, 409);
  if (out.exists) return fail(res, '该钱包在本节点已有店铺（一个钱包只能开一家店）', 409, 409);
  if (out.self) {
    await audit(req, 'shop.application.self_approve_blocked', 'shop_application', String(out.self[0]), {});
    return fail(res, '不能审批自己的开店申请：员工申请须由节点主审批', 409, 409);
  }

  const fresh = applicationDto(
    await getDb().get('SELECT * FROM shop_applications WHERE id = ?', id),
    action === 'approve' ? out.approved[0].code : null
  );
  if (action === 'reject') return ok(res, fresh, '已驳回（申请人可修改店名后重新申请）');

  const code = out.approved[0].code;
  const shop = await shopRowByCode(code);
  return ok(
    res,
    { application: fresh, shop: shopDto(shop, await nodeOwner()) },
    `已开店，编号 ${code}（店主刷新后即可在卖家面板经营）`
  );
}));

/**
 * **批量**审批（nodeAdmin）：`{ids, action, reason?}`。
 *
 * 与单品共用 `reviewApplications`；批量的语义是**整批**：
 *   · 任一条申请不存在（404）／已被处理（409）／钱包已有店铺（409）⇒ 整批不写；
 *   · 驳回必须给原因，且这一条原因记到每条申请上（申请人看到的是同一句）；
 *   · 通过时每条各建一家店、各留一条节点级审计（`detail.batch` 标出这是一批里的）。
 *
 * 上限 100 与店铺暂停、商品下架同口径：超过就明确拒绝，不静默截断。
 */
router.post('/applications/batch-review', nodeAdmin, wrap(async (req, res) => {
  const raw = req.body?.ids;
  if (!Array.isArray(raw)) return fail(res, 'ids 需为申请编号数组（1..100）', 400, 400);
  if (raw.length > 100) return fail(res, `批量审批单次上限 100 条（实际 ${raw.length} 条）——请分批操作`, 400, 400);
  const ids = [];
  const seen = new Set();
  for (const v of raw) {
    const n = Number(String(v ?? '').trim());
    if (!Number.isInteger(n) || n <= 0) return fail(res, `申请编号非法：${String(v)}`, 400, 400);
    if (seen.has(n)) continue;
    seen.add(n);
    ids.push(n);
  }
  if (!ids.length) return fail(res, 'ids 需为非空的申请编号数组（1..100）', 400, 400);
  const action = String(req.body?.action || '');
  if (action !== 'approve' && action !== 'reject') return fail(res, 'action 需为 approve / reject', 400, 400);
  const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
  if (action === 'reject' && !reason) {
    return fail(res, '驳回开店申请必须填写原因（≤200 字，申请人会看到）', 400, 400);
  }

  const out = await reviewApplications({ req, ids, action, reason, batch: true });
  if (out.missing) {
    const shown = out.missing.slice(0, 10).join('、');
    return fail(res, `这些申请不存在（整批未执行）：${shown}${out.missing.length > 10 ? ' …' : ''}`, 404, 404);
  }
  if (out.stale) {
    const shown = out.stale.slice(0, 10).map((r) => `#${r.id}（${r.status}）`).join('、');
    return fail(res, `这些申请已被处理（整批未执行）：${shown}${out.stale.length > 10 ? ' …' : ''}`, 409, 409);
  }
  if (out.exists) {
    const shown = out.exists.slice(0, 10).join('、');
    return fail(res, `这些钱包在本节点已有店铺（整批未执行）：${shown}${out.exists.length > 10 ? ' …' : ''}`, 409, 409);
  }
  if (out.self) {
    await audit(req, 'shop.application.self_approve_blocked', 'shop_application', String(out.self[0]), { batch: true });
    return fail(res, '不能审批自己的开店申请：员工申请须由节点主审批（整批未执行）', 409, 409);
  }

  if (action === 'reject') {
    const rejected = out.rejected.map((r) => String(r.id));
    return ok(
      res,
      { action, approved: [], rejected },
      `已驳回 ${rejected.length} 条开店申请（原因已记录，申请人可修改店名后重新申请）`
    );
  }
  const approved = out.approved.map((r) => ({ id: String(r.id), code: r.code }));
  const codes = approved.map((r) => r.code);
  return ok(
    res,
    { action, approved, rejected: [] },
    `已通过 ${approved.length} 条开店申请并建店：${codes.slice(0, 5).join('、')}${codes.length > 5 ? ' …' : ''}`
  );
}));

export default router;
