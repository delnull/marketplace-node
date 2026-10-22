/**
 * 店铺目录与开店申请（挂 `/api/shops`）。
 *
 *  GET  /                    公开：本节点**在售**店铺列表（编号/店名/卖家地址/抽成比例/在售状态）
 *  GET  /admin/all           节点管理员：本节点**全部**店铺（含暂停接单，用于节点主恢复）
 *  GET  /:code               公开：单店详情（含在售状态与当前登记费率）
 *  POST /applications        店主提交开店申请（需登录；只有店名/公告，不填抽成、不签名）
 *  GET  /applications/list   节点主/员工查看申请队列（nodeAdmin）
 *  GET  /applications/mine   店主查看**自己**的申请进展（需登录；提交之后唯一的反馈渠道）
 *  POST /applications/:id/review   节点主/员工审批（nodeAdmin）：设置抽成并通过 ⇒ **返回待签票据**；驳回 ⇒ 记原因
 *  POST /applications/:id/seller-sign 店主对节点主设置的票据签名（requireAuth，仅申请人本人）
 *  POST /applications/:id/sign     节点主/员工回传他对同一张票据的签名（nodeAdmin）
 *  POST /applications/:id/verify-onchain  按交易哈希核验已上链（nodeAdmin）⇒ 落本地店铺行
 *  POST /reconcile           手动跑一轮佣金条款对账（nodeAdmin；与后台任务是同一个实现）
 *
 * ## 为什么节点不替任何人签名（这是本模块最重要的一个设计决定）
 *
 * `MarketplaceRegistry.registerShop` 的第一行是 `_actingHost()`，且随后校验
 * `nodes[host]` 在册——也就是说**链上交易只能由节点主或其节点员工的钱包提交**。而节点进程
 * **不持有任何私钥**（全仓唯一的秘密是 `MK_TOKEN_SECRET` 这个 HMAC 会话密钥，链上只有
 * 只读 provider）。于是本模块的定位是**协调 + 验签**，永不是签名：
 *
 *   1. 店主先提交申请（不填抽成、不签名）；抽成是节点主的基础设施费，**由节点主设置**；
 *   2. 节点主/员工审批时填 `commissionBps`，节点算出**票据摘要**（与合约 `_shopTicketDigest`
 *      逐字对应）并回给店主；店主用自己的钱包对这张票据签名，表示接受节点主设置的条款；
 *   3. 节点主/员工再对**同一张摘要**签第二个名，然后由持有钱包的一方广播
 *      `registerShop`（gas 由发起人付——这是合约语义决定的，不是实现偷懒）；节点按交易哈希核验。
 *
 * **被否掉的替代方案**：给节点加 `MK_HOST_PRIVATE_KEY` 让它直接签并广播。
 * 代价是节点进程里出现一把能注册任意店铺、能 suspend/forceClose 的**治理热钥**——
 * 拿"省一次钱包签名"换"新增一个被盗即全网受害的单点"，不划算。理由与 USER 面的代价
 * （审批要签一次名 + 发一笔交易）都写在这里，不藏。
 *
 * ## 没有开店费
 *
 * 收入腿只有**按订单抽成**（链上 `Escrow._settle` 的中间那条），所以申请流程里
 * **没有缴费环节**：节点主设置抽成并审批 ⇒ 店主签条款 ⇒ 节点主/员工签票 ⇒ 上链。
 * 此后的费率调整由节点主在链上 `Registry.setShopCommission` 单方生效：已支付/已上链的单
 * 按各自创建时的快照结算，不受影响；而旧费率下创建的**未支付草稿**会被 `termsReconciler`
 * 与店铺行同事务作废（`cancelled` + 逐单审计），否则买家手里那张草稿永远付不了款、
 * 还会一直留在列表里（见该模块文件头）。
 *
 * ## 时间：`deadline` 是 `Date` ↔ `DATETIME(3)` ↔ 接口上的 ISO-8601
 *
 * 票据有效期（缺省 7 天）在库里是 `shop_applications.deadline DATETIME(3)`，接口上收发
 * **ISO-8601 字符串**，而合约的 `_shopTicketDigest` 里是 **uint64 unix 秒**——
 * 那次换算只发生在 `shops.js` 的 `shopTicketDigest` 一处（见那里的说明）。
 */
import { Router } from 'express';
import config from '../config.js';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { verifyToken, isHost } from '../auth.js';
import { getDb } from '../db.js';
import { logAudit } from '../audit.js';
import { isAddress, isZeroAddress, getProvider, getRegistry, nodeStaffList, shopCodeFromChain, shopRegisteredEventFromLogs } from '../chain.js';
import {
  nodeOwner,
  listListedShopRows,
  listShopRows,
  shopDto,
  shopRowByCode,
  shopRowBySeller,
  resolveShopRef,
  shopTicketDigest,
  isValidTicketSignature,
} from '../shops.js';
import { reconcileOnce, termsReconcileStatus } from '../termsReconciler.js';

const router = Router();
const requireAuth = makeAuthMiddleware(verifyToken);
const nodeAdmin = makeAuthMiddleware(verifyToken, { nodeAdmin: true });
// 开店申请是免费 SIWE 的写入口：不限流时可用大量地址填满申请队列与库（节点主审核面 DoS）
const applicationLimiter = simpleRateLimit({ windowMs: 60_000, max: 60, message: '开店申请过于频繁，请稍后再试' });

/** 票据有效期（天）：7 天。票据带时效是刻意的（泄露的票据不该永久有效），与费率改动无关。 */
const TICKET_TTL_DAYS = 7;

/**
 * 审计便捷包装（本文件只有 nodeAdmin 路由：开店治理）。
 *
 * 这三条（approve/reject/registered）**都是节点级**，`shopCode: null`：
 *  · 申请不是一家店——编号由链上在 registerShop 时才铸造，审批时它还不存在；
 *  · 这是节点主的治理动作，而治理记录必须留给**节点主**看（审计列表按店过滤之后，
 *    挂到某家店名下的行只有那家店的店主看得到——节点主自己的动作反而从自己的视野里消失）；
 *  · 编号确实存在的那个时刻记在 `detail.code` 里（registered），不是这一行的归属。
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
 * MySQL 唯一键冲突（`ER_DUP_ENTRY`）判定 —— **唯一实现**。
 *
 * 为什么把"一个钱包只能有一条未终结申请"交给**库约束**而不是先查后插：
 * schema 上有函数唯一索引 `uq_applications_open ((IF(status IN ('pending','approved'), seller, NULL)))`
 * ——"同一钱包两条未终结申请"在落库那一步就写不进去。而"先 SELECT 再 INSERT"是两个时刻，
 * 并发两次提交都能读到"没有"，于是两条都插进去，之后审批队列里出现两张同一家店的票据
 * （`registerShop` 第二笔必然 revert，而运营方看不出哪张是哪张）。
 * 这里只把库给出的冲突翻译成一句能照着做的话（409），判据仍然只有那一处。
 */
function isDuplicateKey(e) {
  return e?.code === 'ER_DUP_ENTRY' || Number(e?.errno) === 1062;
}

/** 申请行的对外形状（**唯一一份**：队列与单条回执共用） */
function applicationDto(row, nodeAddr) {
  const bps = Number(row.commission_bps) || 0;
  let digest = null;
  try {
    ({ digest } = shopTicketDigest({
      host: row.host,
      seller: row.seller,
      commissionBps: bps,
      deadline: row.deadline,
    }));
  } catch {
    digest = null;
  }
  return {
    id: String(row.id),
    seller: row.seller,
    /** 本申请的节点主；店主签票据/回执展示都需要这个地址 */
    host: row.host,
    name: row.name || '',
    notice: row.notice || '',
    // 收款人恒为本节点主（链上与本地都只有这一份真相，见 src/shops.js 的 orderTermsOf）；
    // `commission_to` 那一列记的是**审批时的回显**（恒为节点主），bps=0 时为 NULL（没有抽成腿；
    // 它不在票据摘要里——摘要只绑定 host/seller/bps/deadline）
    commissionTo: bps > 0 ? row.commission_to || nodeAddr || '' : '',
    commissionBps: bps,
    /** 票据失效时刻（`Date` → 对外 ISO-8601；链上摘要在秒精度上取用，见 shopTicketDigest） */
    deadline: row.deadline,
    /** 当前条款摘要（`seller` 在这一步签它；节点主之后签同一张） */
    digest,
    status: row.status,
    hasSellerSig: !!row.seller_sig,
    hasHostSig: !!row.host_sig,
    rejectReason: row.reject_reason || '',
    txHash: row.tx_hash || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 申请行里的店主签名是否仍然对得上**当前**票据（返回可读拒因；null = 通过）。
 *
 * 为什么每次都要重算：`seller_sig` 是"店主同意了这一组条款"的唯一凭证，而签名之后
 * `commission_bps` / `deadline` / `seller` 都是普通列——任何能改库的路径（或直接 UPDATE）
 * 都能让"票据内容"与"签名覆盖的内容"分叉。`/sign` 把节点主签名交出去、`/verify-onchain`
 * 据此落本地店铺行，两处都必须在**使用这份签名之前**按同一函数复算摘要并裸恢复地址：
 *   · 只信列 ⇒ 被篡改的申请能拿到一份"节点主签过的"交易参数；
 *   · 只在 submit 验一次 ⇒ 审批/核验之间那段窗口里的改动不会被发现。
 * 判据只有这一处，两个调用点都只消费它的结论。
 */
async function sellerSignatureError(row) {
  const seller = String(row?.seller || '').toLowerCase();
  if (!seller || !String(row?.seller_sig || '').trim()) return '申请缺少店主签名（sellerSig）';
  let digest;
  let innerHash;
  try {
    ({ digest, innerHash } = shopTicketDigest({
      host: row.host,
      seller,
      commissionBps: Number(row.commission_bps),
      deadline: row.deadline,
    }));
  } catch (e) {
    return `无法重算票据摘要：${e?.message || e}`;
  }
  if (!(await isValidTicketSignature(seller, innerHash, digest, row.seller_sig))) {
    return '申请里的店主签名与当前票据不符（票据绑定 host/seller/费率/deadline）——请驳回后让店主重新提交申请';
  }
  return null;
}

/** 公开：本节点在售店铺列表（`listed = 0` 的店**不进**这个列表——它已经不接单也不该被聚合） */
router.get('/', wrap(async (req, res) => {
  const nodeAddr = await nodeOwner();
  const rows = await listListedShopRows();
  ok(res, {
    host: nodeAddr || null,
    shops: rows.map((r) => shopDto(r, nodeAddr)),
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
  const rows = await listShopRows();
  ok(res, {
    host: nodeAddr || null,
    shops: rows.map((r) => shopDto(r, nodeAddr)),
  });
}));

/**
 * 公开：单店详情。
 * **暂停接单的店对匿名访问按"不存在"处理**（404）：公开详情若仍可读，等于把"暂停接单"
 * 做成"只是不显示在列表里"。店主/店员要读自己的店走带鉴权的 `/api/shop/settings`。
 *
 * 两次查找**都必须 await**：`shopRowByCode(...) || resolveShopRef(...)` 里的 `||` 作用在
 * Promise 上时左侧恒真（哪怕店铺不存在），于是"没有这家店"这条 404 永远不会走到，
 * 而未解析的 Promise 会被当成行对象往下用（`Number(row.listed)` = NaN ⇒ 同样 404，
 * 但原因完全不同——真正的那一次查找根本没执行）。
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
 * 请求体：`{name, notice}`（`name` **必填**：店名是店铺在联邦目录里的身份，没有默认名；
 * **不含抽成/签名**；抽成由节点主审批时设置）
 *   · `seller` 取**登录地址**（不由请求体给）：申请是"我请求在你的节点下开店"，
 *     让别人代提申请没有意义，也给了冒名占位的面；
 *   · 抽成是**节点主设置**的基础设施费，不是店主在申请里自报的数字；
 *   · **没有收款人参数**：抽成恒打给本节点的节点主——谁提供基础设施，抽成就给谁。
 *     这不是"少一个字段"，而是把"钱给谁"从可配参数降成身份的推论。
 */
router.post('/applications', requireAuth, applicationLimiter, wrap(async (req, res) => {
  const hostAddr = await nodeOwner();
  if (!hostAddr) return fail(res, '本节点未配置节点主地址（MK_SHOP_OWNER），无法受理开店申请');
  if (!config.chain.registryAddress) {
    return fail(res, '本节点未配置 Registry 合约地址（MK_REGISTRY_ADDRESS）：店铺编号只能由链上铸造，无法开店');
  }
  const seller = String(req.auth?.address || '').toLowerCase();
  if (!isAddress(seller) || isZeroAddress(seller)) return fail(res, '登录地址非法');
  const { name, notice } = req.body || {};
  const nameText = String(name ?? '').trim().slice(0, 60);
  const noticeText = String(notice ?? '').trim().slice(0, 500);
  // 店名**必填**：它是一家店在联邦目录里的身份，没有默认名可回退。
  // 不在这里拦，空名会一路进到 shops 行，买家在目录里看到一个没有名字的店铺（或各家同名的占位）。
  if (!nameText) return fail(res, '店名不能为空（≤60 字）：店铺在联邦目录里靠它被买家识别');
  const deadline = new Date(Date.now() + TICKET_TTL_DAYS * 86_400_000);

  const db = getDb();
  /*
    一个钱包全局只能开一家店（与链上 _shopOfSeller 同一条约束）——先给一句可读的话，
    真正的判据仍是 `shops.uq_shops_seller`（并发下也拦得住）。

    例外：**墓碑行**（`exited_at_block > 0`，店主已退出）不占位——链上 `registerShop`
    对已退出的行允许重开（且沿用原编号），本地这一行也会在核验/对账时回到在售。
    不加这一档时，退出过的店主永远无法重新申请（他"已有一家店"）。
  */
  const existing = await shopRowBySeller(seller);
  if (existing && !(Number(existing.exited_at_block) > 0)) {
    return fail(res, '该钱包在本节点已有店铺（一个钱包全局只能开一家店）', 409, 409);
  }
  let id;
  try {
    id = Number(
      (await db.run(`INSERT INTO shop_applications
             (seller, host, name, notice, commission_to, commission_bps, deadline, status, seller_sig)
           VALUES (?, ?, ?, ?, NULL, 0, ?, 'pending', '')`, seller, hostAddr, nameText, noticeText, deadline))
        .insertId
    );
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    // 库里已经有这个钱包的未终结申请（函数唯一索引 uq_applications_open 拒绝第二条）
    const dup = await db.get("SELECT id FROM shop_applications WHERE seller = ? AND status IN ('pending','approved')", seller);
    return fail(res, `你已有一条未终结的开店申请（#${dup ? dup.id : '?'}），请等待节点主处理或先撤回`, 409, 409);
  }
  ok(
    res,
    applicationDto(await db.get('SELECT * FROM shop_applications WHERE id = ?', id), hostAddr),
    '申请已提交。节点主/员工审批时会设置节点抽成并回一张票据，你需要对那张票据再签一次；之后节点主/员工签名并广播 registerShop'
  );
}));

/** 申请队列（nodeAdmin）：默认只出未终结的（pending/approved），`?all=1` 出全部历史 */
router.get('/applications/list', nodeAdmin, wrap(async (req, res) => {
  const hostAddr = await nodeOwner();
  const all = String(req.query.all || '') === '1';
  const db = getDb();
  const rows = all
    ? await db.all('SELECT * FROM shop_applications WHERE host = ? ORDER BY id DESC', hostAddr)
    : await db.all("SELECT * FROM shop_applications WHERE host = ? AND status IN ('pending','approved') ORDER BY id ASC", hostAddr);
  ok(res, { applications: rows.map((r) => applicationDto(r, hostAddr)) });
}));

/**
 * **我自己的申请**（需登录）：店主提交之后到编号铸造之间那条缝里唯一能看进展的地方。
 *
 * 为什么必须有这一条：提交（`POST /applications`）之后店主拿不到任何反馈渠道 ——
 * 队列接口是 `nodeAdmin`（节点主的治理视图），而店主既不知道节点主看没看到、也不知道
 * 自己被拒了还是还在等。没有它，四步流程（提交 → 审批 → 双签 → 上链）在申请人那一侧
 * **只有第一步可见**，于是"到底卡在哪"只能靠去问节点主（本仓把"能不能自证"当判据，
 * 见 `/healthz` 那一批）。
 *
 * 范围按**登录地址**收窄（不按请求头/店铺头）：申请是"这个钱包请求在这台节点下开店"，
 * 与店无关（编号还没铸造）。`?all=1` 出历史（被拒的原因就在历史行里）。
 */
router.get('/applications/mine', requireAuth, wrap(async (req, res) => {
  const hostAddr = await nodeOwner();
  const seller = String(req.auth?.address || '').toLowerCase();
  const all = String(req.query.all || '') === '1';
  const db = getDb();
  const rows = all
    ? await db.all('SELECT * FROM shop_applications WHERE host = ? AND seller = ? ORDER BY id DESC', hostAddr, seller)
    : await db.all(
        "SELECT * FROM shop_applications WHERE host = ? AND seller = ? AND status IN ('pending','approved') ORDER BY id DESC",
        hostAddr,
        seller
      );
  ok(res, { applications: rows.map((r) => applicationDto(r, hostAddr)) });
}));

/**
 * 审批（nodeAdmin：节点主或本节点员工）。
 *   · `{action:'reject', reason}` ⇒ 置 rejected（申请人可换条款再申请：那条函数唯一索引
 *     只约束**未终结**状态，被拒的行不占位）；
 *   · `{action:'approve'}` ⇒ 置 approved，并**返回待签票据**（摘要 + 各项参数）——
 *     节点主用自己的钱包对它 `personal_sign`，然后把签名回传给 `/sign`。
 *
 * ⚠️ 这里**不产生链上交易**：`registerShop` 的 msg.sender 必须是节点主，节点不持钥。
 */
router.post('/applications/:id/review', nodeAdmin, wrap(async (req, res) => {
  const id = Number(String(req.params.id ?? '').trim());
  if (!Number.isInteger(id) || id <= 0) return fail(res, 'id 需为申请的正整数编号');
  const hostAddr = await nodeOwner();
  const db = getDb();
  const row = await db.get('SELECT * FROM shop_applications WHERE id = ?', id);
  if (!row) return fail(res, '申请不存在', 404, 404);
  if (row.host !== hostAddr) return fail(res, '该申请不属于本节点', 403, 403);
  const action = String(req.body?.action || '');
  if (action === 'reject') {
    if (row.status === 'registered') return fail(res, '该申请对应的店铺已经上链，不能再驳回（要停用请走 suspendShop）');
    const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
    await db.run("UPDATE shop_applications SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?", reason,
      new Date(),
      id);
    await audit(req, 'shop.application.reject', 'shop_application', String(id), { seller: row.seller, reason });
    return ok(res, applicationDto(await db.get('SELECT * FROM shop_applications WHERE id = ?', id), hostAddr), '已驳回（申请人可修改条款后重新申请）');
  }
  if (action !== 'approve') return fail(res, 'action 需为 approve / reject');
  if (row.status === 'registered') return fail(res, '该申请已经上链，无需再次审批');
  /*
    **抽成由节点主设置**：申请里没有费率，节点主在审批时填 `commissionBps`。
    节点主签的票据和店主随后签的是**同一张**；所以在店主签名之前可以重设，
    一旦 `seller_sig` 已存在就不能再改（要改必须驳回，让店主对新条款重签）。
  */
  if (row.seller_sig) {
    return fail(res, '店主已经对当前条款签名，不能再改抽成；如需调整请驳回后让店主重新申请', 409, 409);
  }
  const bps = Number(req.body?.commissionBps);
  if (!Number.isInteger(bps) || bps < 0 || bps > 1000) {
    return fail(res, '节点主必须设置 commissionBps（0..1000 的整数；0 = 不抽成）');
  }
  if (bps > 0 && String(row.seller).toLowerCase() === String(hostAddr).toLowerCase()) {
    return fail(res, '自营店（店主 = 节点主）不能设置大于 0 的抽成');
  }
  // `deadline` 是 DATETIME(3) → Date；票据带时效是刻意的（泄露的票据不该永久有效）
  if (row.deadline.getTime() < Date.now()) {
    return fail(res, '该申请的票据已过期，请驳回后让店主重新提交（票据带时效是刻意的：泄露的票据不该永久有效）');
  }
  await db.run(
    `UPDATE shop_applications
        SET status = 'approved', commission_bps = ?, commission_to = ?,
            seller_sig = '', host_sig = '', updated_at = ?
      WHERE id = ?`,
    bps,
    bps > 0 ? hostAddr : null,
    new Date(),
    id
  );
  await audit(req, 'shop.application.approve', 'shop_application', String(id), { seller: row.seller, commissionBps: bps });
  const { digest, registry } = shopTicketDigest({
    host: row.host,
    seller: row.seller,
    commissionBps: bps,
    deadline: row.deadline,
  });
  ok(
    res,
    {
      application: applicationDto(await db.get('SELECT * FROM shop_applications WHERE id = ?', id), hostAddr),
      ticket: {
        chainId: config.chain.chainId,
        registry,
        host: row.host,
        seller: row.seller,
        // 收款人不在摘要里（恒为节点主，见 shops.js 的 shopTicketDigest）：这里回显的是给人看的那一份
        commissionTo: row.host,
        commissionBps: bps,
        deadline: row.deadline,
        digest,
      },
    },
    '已设置抽成并通过。请让店主先对这张票据签名；店主签完后节点主/员工再签同一张 digest，最后广播 registerShop'
  );
}));

/**
 * 店主对**节点主设置的条款**签名（requireAuth，仅申请人本人）。
 *
 * 顺序刻意是“节点主先设置抽成并回票据 → 店主签 → 节点主签 → 广播”：
 * 抽成是节点主的基础设施费，店主不能在申请里自报；但店主必须对最终数字签字，
 * 否则节点主可以单方面改费率。这里就是那道同意。
 */
router.post('/applications/:id/seller-sign', requireAuth, wrap(async (req, res) => {
  const id = Number(String(req.params.id ?? '').trim());
  if (!Number.isInteger(id) || id <= 0) return fail(res, 'id 需为申请的正整数编号');
  const seller = String(req.auth?.address || '').toLowerCase();
  const db = getDb();
  const row = await db.get('SELECT * FROM shop_applications WHERE id = ?', id);
  if (!row) return fail(res, '申请不存在', 404, 404);
  if (String(row.seller).toLowerCase() !== seller) return fail(res, '仅申请人本人可以签署这份开店条款', 403, 403);
  if (row.status !== 'approved') return fail(res, `当前状态(${row.status})不可签条款；需等节点主审批并设置抽成`, 409, 409);
  if (row.host_sig) return fail(res, '节点主已经签名，条款不能再改；如需调整请驳回后重新申请', 409, 409);
  if (row.deadline.getTime() < Date.now()) {
    return fail(res, '票据已过期，请让节点主驳回后重新审批（票据带时效是刻意的）', 409, 409);
  }
  const sellerSig = String(req.body?.sellerSig || '').trim();
  if (!sellerSig) return fail(res, '缺少 sellerSig：请对当前票据摘要签名后再提交');
  const { digest, innerHash } = shopTicketDigest({
    host: row.host,
    seller: row.seller,
    commissionBps: Number(row.commission_bps),
    deadline: row.deadline,
  });
  if (!(await isValidTicketSignature(seller, innerHash, digest, sellerSig))) {
    return fail(res, 'sellerSig 不是该登录地址的合法签名（票据绑定 host/seller/比例/deadline，换一项都要重签）');
  }
  await db.run('UPDATE shop_applications SET seller_sig = ?, updated_at = ? WHERE id = ?', sellerSig, new Date(), id);
  await audit(req, 'shop.application.seller_sign', 'shop_application', String(id), {
    seller,
    commissionBps: Number(row.commission_bps),
  });
  ok(res, applicationDto(await db.get('SELECT * FROM shop_applications WHERE id = ?', id), await nodeOwner()), '条款已签署；等待节点主/员工签名并广播 registerShop');
}));

/** 节点主/员工回传他对同一张票据的签名（nodeAdmin）：节点验签后暂存，供广播 `registerShop` 使用 */
router.post('/applications/:id/sign', nodeAdmin, wrap(async (req, res) => {
  const id = Number(String(req.params.id ?? '').trim());
  if (!Number.isInteger(id) || id <= 0) return fail(res, 'id 需为申请的正整数编号');
  const hostAddr = await nodeOwner();
  const db = getDb();
  const row = await db.get('SELECT * FROM shop_applications WHERE id = ?', id);
  if (!row) return fail(res, '申请不存在', 404, 404);
  if (row.host !== hostAddr) return fail(res, '该申请不属于本节点', 403, 403);
  /*
    **先重验店主那一半签名**（见 sellerSignatureError）。节点主签名是对"这张票据"的同意，
    若票据内容已被改过（库里 bps/deadline/seller 与 seller_sig 不匹配），把节点主签名交出去
    等于让节点主替一份店主没同意过的条款背书。判据在 helper 里，拒绝是 409（资源状态冲突）。
  */
  if (row.status !== 'approved') return fail(res, '只能对**已通过**的申请补签名（先走 /review approve）');
  if (!row.seller_sig) {
    return fail(res, '等待店主签署条款：节点主设置抽成后，申请人必须先对同一张票据签名，节点主才能签', 409, 409);
  }
  const sellerErr = await sellerSignatureError(row);
  if (sellerErr) return fail(res, sellerErr, 409, 409);
  // 过期票据不再返回可广播的 call：链上必然 ShopTicketExpired，先在这里挡住白付 gas
  if (row.deadline.getTime() <= Date.now()) {
    return fail(res, '票据已过期，不能再补签名/广播；请驳回后让申请人重新提交（新票据带新 deadline）', 409, 409);
  }
  const hostSig = String(req.body?.hostSig || '').trim();
  if (!hostSig) return fail(res, '缺少 hostSig');
  const { digest, innerHash } = shopTicketDigest({
    host: row.host,
    seller: row.seller,
    commissionBps: Number(row.commission_bps),
    deadline: row.deadline,
  });
  /*
    签名者可以是**节点主本人**，也可以是**本节点员工**（2026-10-18：员工与节点主同权限，
    审批开店就是他们被授予的动作之一）。签名判据统一走 `isValidTicketSignature`：
    EOA 走 ECDSA，合约账户走标准 1271 / Safe legacy；链上 `registerShop` 在执行时会再验一次，
    被解除的员工拿着旧签名回来登记会被拒。员工名单读不到时按"没有员工"处理（fail-closed）。
  */
  let hostSigned = await isValidTicketSignature(row.host, innerHash, digest, hostSig);
  if (!hostSigned) {
    const staff = await nodeStaffList(row.host);
    for (const s of staff || []) {
      if (await isValidTicketSignature(s, innerHash, digest, hostSig)) {
        hostSigned = true;
        break;
      }
    }
  }
  if (!hostSigned) {
    return fail(res, 'hostSig 的签名者不是本节点主或本节点员工（票据绑定 host/seller/费率/deadline 四项，换一项都要重签）');
  }
  await db.run('UPDATE shop_applications SET host_sig = ?, updated_at = ? WHERE id = ?', hostSig, new Date(), id);
  const next = await db.get('SELECT * FROM shop_applications WHERE id = ?', id);
  ok(
    res,
    {
      ...(applicationDto(next, hostAddr)),
      // 回执里带上两张签名与全部参数：持有节点主/员工钱包的一方据此直接组 `registerShop` 交易
      call: {
        fn: 'registerShop',
        // 链上参数是 **unix 秒**（uint64）——这里是"库列（Date）→ 链上参数"的唯一一次换算
        args: [row.seller, Number(row.commission_bps), Math.floor(row.deadline.getTime() / 1000), hostSig, row.seller_sig],
      },
    },
    '双签齐了。请用节点主或本节点员工钱包广播 registerShop（参数见 call），完成后调用 /verify-onchain 让本节点落库'
  );
}));

/**
 * 按交易哈希核验已上链（nodeAdmin）⇒ 落本地店铺行。
 *
 * **核验分两层，缺一不可**：
 *  ① 交易本身：哈希能在链上取到、状态成功，且回执里有**本节点 Registry 的 `ShopRegistered`**
 *     事件，其 `(host, seller, commissionBps)` 与本申请一致、`code` 与链上 `ShopInfo.code` 一致
 *     （防"给一个不相干的哈希"——只判"碰过 Registry"会把暂停/改费率/别人的店也认成开店）；
 *  ② **链上状态才是真相**：`getShop(seller, host)` 必须真的有这一行（且没被店主退出）、
 *     host 对得上、条款与申请逐字一致。这一层是权威判据——就算 ① 被伪造（哈希本来就公开可查），
 *     ② 也骗不过去：店铺是否存在只有链上说了算，本地表是**镜像**。
 * 两层都过才写库；本地行由 `applyChainShop` 用链上读数写入（同一个函数，不另算一份）。
 */
router.post('/applications/:id/verify-onchain', nodeAdmin, wrap(async (req, res) => {
  const id = Number(String(req.params.id ?? '').trim());
  if (!Number.isInteger(id) || id <= 0) return fail(res, 'id 需为申请的正整数编号');
  const txHash = String(req.body?.txHash || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return fail(res, 'txHash 需为 0x 开头的 64 位十六进制');
  const hostAddr = await nodeOwner();
  const db = getDb();
  const row = await db.get('SELECT * FROM shop_applications WHERE id = ?', id);
  if (!row) return fail(res, '申请不存在', 404, 404);
  if (row.host !== hostAddr) return fail(res, '该申请不属于本节点', 403, 403);
  /*
    与 /sign 同一道判据（见 sellerSignatureError）：落库前必须确认"这张票据"仍是店主签过的那一张。
    只信申请行里的列 ⇒ 一次直接 UPDATE 就能让节点把（被改过条款的）申请登记成一家真实店铺。
  */
  const sellerErr = await sellerSignatureError(row);
  if (sellerErr) return fail(res, sellerErr, 409, 409);
  if (row.status === 'registered') return ok(res, applicationDto(row, hostAddr), '该申请已核验过（幂等）');
  if (!row.host_sig) return fail(res, '还缺节点主的签名：先走 /sign 把双签补齐，再广播 registerShop');

  // ① 交易层：回执 + **开店事件**（只认 ShopRegistered，不认"碰过 Registry"）
  let registeredEvent;
  try {
    const receipt = await getProvider().getTransactionReceipt(txHash);
    if (!receipt) return fail(res, '链上查不到这笔交易（可能还没被打包，或哈希不对）', 404, 404);
    if (Number(receipt.status) !== 1) return fail(res, '该交易在链上失败了（status != 1），没有产生任何店铺');
    const registryAddr = String(config.chain.registryAddress || '').toLowerCase();
    registeredEvent = shopRegisteredEventFromLogs(receipt.logs, registryAddr);
    if (!registeredEvent) {
      return fail(
        res,
        '该交易里没有本节点 Registry 的 ShopRegistered 事件——它不是一次开店登记（暂停/改费率/别的店的交易都不能作为本申请的上链凭证），不落库'
      );
    }
    if (
      registeredEvent.host !== String(row.host).toLowerCase() ||
      registeredEvent.seller !== String(row.seller).toLowerCase() ||
      Number(registeredEvent.commissionBps) !== Number(row.commission_bps)
    ) {
      return fail(
        res,
        '该交易登记的不是本申请：ShopRegistered 的 host/seller/佣金与本申请不一致——不落库（拿别的开店交易冒充会让本地出现一家链上并不属于你的店）'
      );
    }
  } catch (e) {
    return fail(res, `读不到交易回执（RPC 不可达）：${e?.message || e}——本次不落库，请稍后重试`);
  }

  // ② 链上状态层（**权威**）
  let info;
  try {
    info = await getRegistry().getShop(row.seller, row.host); // 店的身份是 (店主, 节点) 这一对
  } catch (e) {
    return fail(res, `读不到链上店铺登记（RPC 不可达）：${e?.message || e}——本次不落库，请稍后重试`);
  }
  if (Number(info.registeredAtBlock) === 0 || Number(info.exitedAtBlock) !== 0) {
    return fail(res, '链上还没有这家店（或店主已退出）：请确认广播的交易确实执行了 registerShop（且 seller 与申请一致）');
  }
  if (String(info.host).toLowerCase() !== String(row.host).toLowerCase()) {
    return fail(res, `链上该店的 host 是 ${info.host}，与本申请不符——不落库`);
  }
  // 链上条款只有**比例**一项可比（收款人恒为节点主，上面已经比过 host 了）
  if (Number(info.commissionBps) !== Number(row.commission_bps)) {
    return fail(res, '链上条款与申请里的条款不一致——不落库（条款是双签覆盖的，对不上说明签的不是这一份）');
  }
  const existing = await shopRowBySeller(row.seller);
  // 链上 `ShopInfo.code` 是 bytes32，落库/回显要的是 9 位编号字符串（唯一转换点）
  const onchainCode = shopCodeFromChain(info.code);
  if (!onchainCode) return fail(res, '链上这家店没有编号（ShopInfo.code 为空）——不落库，请核对该交易');
  /*
    事件里的编号必须与链上 `ShopInfo.code` **逐字**一致：这是"这笔交易创建的就是这一行"的
    最后一道对拍。事件 code 是 9 位字符串，结构体里是 bytes32，唯一转换点见 shopCodeFromChain。
  */
  if (registeredEvent.code !== onchainCode) {
    return fail(
      res,
      `交易事件里的店铺编号 ${registeredEvent.code || '(空)'} 与链上 ShopInfo 的 ${onchainCode} 不一致——不落库，请核对该交易`
    );
  }
  /*
    **墓碑行可以重开**（2026-10-18）：店主的 `deregisterShop` 把链上行留成墓碑（`exitedAtBlock != 0`），
    链上 `registerShop` 允许对已退出的行重新登记，且**沿用原编号**（`_mintShopCode(s.code)`）。
    本地这一行也必须跟着回到在售，否则"链上已重开、本地永远 listed=0"。
    - 非墓碑行 ⇒ 拒绝：一个钱包在本节点只能有一家在营店铺（与 `uq_shops_seller` 同一条）；
    - 编号必须一致：链上重开不会换号；若不一致说明这条本地行不是那家店（或库被手工改过），
      改 `shops.code` 会让 products/orders 的外键整体换一家店——不猜，拒绝并让人核对。
  */
  const tombstone = !!existing && Number(existing.exited_at_block) > 0;
  if (existing && !tombstone) {
    return fail(res, '该钱包在本节点已有在营店铺（未退出）：请用原店铺继续经营，不能登记成第二家', 409, 409);
  }
  if (tombstone) {
    if (existing.code !== onchainCode) {
      return fail(
        res,
        `链上重开的编号 ${onchainCode} 与本地这一行（${existing.code}）不一致——不落库。` +
          '链上对已退出的行沿用原编号；编号对不上说明这两行不是同一家店（或本地库被手工改过），请先核对',
        409,
        409
      );
    }
    await db.run(
      `UPDATE shops SET name = ?, notice = ?, listed = 1, commission_bps = ?,
         registered_tx = ?, registered_at_block = ?, exited_at_block = 0, synced_at = NULL, updated_at = ?
       WHERE code = ?`,
      row.name || '',
      row.notice || '',
      Number(info.commissionBps),
      txHash,
      Number(info.registeredAtBlock) || 0,
      new Date(),
      existing.code
    );
  } else {
    /*
      列清单写全：`shops` 里没有默认值的列漏一个就会在解析阶段报
      `Field 'x' doesn't have a default value`（与 db.js 的建表语句同形）。
      - `registered_at_block` 写**链上真值**（不是 0）：0 在读数里表示"没登记过"，
        写 0 会让"这家店登记在哪个区块"这件事在本地失真；
      - `exited_at_block` 默认 0 = 在营（墓碑只在店主退出/对账读到 exitedAtBlock 时写入）；
      - `synced_at` 留 NULL = **从未对账过**（紧接着的 reconcileOnce 会盖章）；
      - **没有 host 列**（一库一节点，节点主在 `node.owner`）。
    */
    await db.run(`INSERT INTO shops
        (code, seller, name, notice, listed, commission_bps, registered_tx, registered_at_block)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`, onchainCode,
      row.seller,
      row.name || '',
      row.notice || '',
      Number(info.commissionBps),
      txHash,
      Number(info.registeredAtBlock) || 0);
  }
  await db.run("UPDATE shop_applications SET status = 'registered', tx_hash = ?, updated_at = ? WHERE id = ?", txHash, new Date(), id);
  await audit(req, 'shop.application.registered', 'shop_application', String(id), { seller: row.seller, code: onchainCode, txHash });
  // 立即跑一轮条款对账：把 listed/条款按链上真值补齐（与后台任务是同一个实现）
  try {
    await reconcileOnce();
  } catch {
    /* 对账失败不影响"已上链"这个结论本身；下一轮后台任务会补上 */
  }
  ok(
    res,
    { ...(applicationDto(await db.get('SELECT * FROM shop_applications WHERE id = ?', id), hostAddr)), code: onchainCode },
    `店铺已上链并落库，编号 ${onchainCode}（编号由链上铸造，与节点编号是两条独立序列）`
  );
}));

/** 手动跑一轮佣金条款对账（nodeAdmin）：与后台任务是同一个实现，供运维在改完条款后立即刷新 */
router.post('/reconcile', nodeAdmin, wrap(async (req, res) => {
  const r = await reconcileOnce();
  await audit(req, 'shops.terms.reconcile', 'node', 'node', { ...r, status: termsReconcileStatus() });
  ok(res, { ...r, status: termsReconcileStatus() }, '已按链上真值对账（读不到的店铺本轮跳过，保持本地原值）');
}));

export default router;

