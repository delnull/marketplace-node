/**
 * 管理审计查询（P1-④）：
 *  GET /api/shop/audit?page=&pageSize=&action=&actor= → 本店审计（ownerOnly）
 *    {total, page, pageSize, items:[{id, at(ISO-8601), actor, actorRole, action, targetType, targetId, detail(对象), ip}]}
 *  GET /api/shop/audit/node?…                        → **节点级**审计（**hostOnly**：节点资料、开店审批、
 *    保留期触发、系统动作——这些事件不属于任何一家店，`shop_code IS NULL`）
 *  GET /api/shop/audit/node/self?…                   → **自己的**节点级审计（nodeAdmin：节点主 ∪ 员工；
 *    `actor = 登录地址 AND shop_code IS NULL`——员工能操作、就该能回看自己那一行）
 *  GET /api/shop/audit/node.csv?action=&actor=       → 节点级审计 **CSV 全量导出**（hostOnly）
 *
 * 时间与 detail 的形状由 `audit.js` 的 `queryAudit` 决定（`at` 是 `DATETIME(3)` → `Date` → ISO，
 * `detail` 是 JSON 列 → 对象）：本文件只做分页参数、鉴权与 CSV 编码，不重新解释那一行。
 *
 * ## 为什么按读者/范围拆成三条**列表**路由，而不是一条按请求头切换范围的
 *
 * CSV 是节点级列表的导出变体（同一 `hostOnly`、同一 `shop_code IS NULL` 范围），不是第四个范围。
 *
 * 范围取决于**这一行的归属**，而归属只有两种：某家店，或不属于任何店。两种范围的读者也不同
 * （店主 vs 节点主），判据只有一处（行上的 shop_code，见 audit.js 的 queryAudit）：
 *   · `ownerOnly` 只回答"你是不是请求头那家店的店主"——**节点主读租户店的审计不在授权范围内**
 *     （他能读的是节点级那一份），所以节点级列表单独一条节点级路由；
 *   · 反过来，节点级那一份**不对店主可见**：那里有各店申请的审批记录与节点级动作，
 *     要让店主看得见就等于把"节点"当成"另一家店"。
 *   · 2026-10-18 再收一档（**hostOnly**，仅节点主）：nodeAdmin 扩到"节点主 ∪ 节点员工"之后，
 *     员工能看到全节点的审计行（含各租户动作的 IP/操作者与开店审批）——那是节点主视角，
 *     不是运营动作。员工与节点主同权限不包含"读全节点审计"。
 *   · 2026-10-26 补 `node/self`：员工不能读全节点，但能暂停店铺/下架商品，至少要能回看
 *     **自己**做过什么。范围由服务端强制（actor=登录地址），不信任查询参数里的 actor。
 * 旧形状（一条 ownerOnly 路由 + 不过滤）的实际效果是**任一店店主读到整个节点的审计**：
 * 别的店的订单号与变更摘要。那是数据模型缺了一维，不是权限配置漏了一项。
 *
 * ## `targetShop`：节点级行里"指向某家店"的那些
 *
 * 节点级行的 `shop_code` 恒为 NULL（店主不该看到节点主对它的处置），但店铺详情需要回答
 * "这家店被谁、什么时候暂停/恢复/下架过什么"。归属在 target/detail 里（见 audit.js 的
 * auditWhere）：店铺动作是 target_id，商品动作是 detail.shopCode，审批通过是 detail.code。
 * 它是**节点级查询的附加过滤**，不是把那些行改判给店铺；CSV 导出不带它。
 */
import { Router } from 'express';
import { verifyToken } from '../auth.js';
import { fail, ok, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { exportAudit, logAudit, queryAudit } from '../audit.js';
import { sendCsv } from '../csv.js';
import { isShopCodeShape } from '../shops.js';

const router = Router();
// 审计行含 IP/操作者/被操作对象：店铺级私域，只认该店店主（节点主看节点级那份，见 GET /node）
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true });
// 节点级审计：仅节点主（节点主可以一家店都没有，不要求也不消费请求头）
const hostOnly = makeAuthMiddleware(verifyToken, { hostOnly: true });
// 节点管理员（节点主 ∪ 员工）：只用于"自己的"节点级审计，不放开全节点视图
const nodeAdmin = makeAuthMiddleware(verifyToken, { nodeAdmin: true });

/** 分页与可选过滤（三条列表路由共用，避免几处各解一次参数而漂移） */
function listParams(req) {
  return {
    page: Math.max(1, parseInt(req.query.page, 10) || 1),
    pageSize: Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30)),
    action: String(req.query.action || '') || undefined,
    actor: String(req.query.actor || '') || undefined,
  };
}

/** 节点级行"指向某家店"的过滤参数：形状非法直接 400（不把抄错的编号当成 0 条） */
function targetShopParam(req) {
  const raw = String(req.query.targetShop || '').trim().toUpperCase();
  if (!raw) return { value: undefined };
  if (!isShopCodeShape(raw)) return { error: 'targetShop 需为 9 位店铺编号' };
  return { value: raw };
}

/**
 * 审计 CSV 导出限流：全量读 + 逐行 JSON 序列化，单次比列表重；节点主导出是低频动作。
 * 与列表共用同一张表但不同额度：列表是浏览，导出是拿走一份文件。
 */
const auditCsvLimiter = simpleRateLimit({
  windowMs: 60_000,
  max: 10,
  message: '审计导出过于频繁（每分钟至多 10 次）：请稍后再试',
});

router.get('/', ownerOnly, wrap(async (req, res) => {
  ok(res, await queryAudit({ ...listParams(req), shopCode: req.shop.code }));
}));

router.get('/node', hostOnly, wrap(async (req, res) => {
  const target = targetShopParam(req);
  if (target.error) return fail(res, target.error, 400, 400);
  ok(res, await queryAudit({ ...listParams(req), shopCode: null, targetShop: target.value }));
}));

/**
 * 节点管理员：**自己的**节点级审计（actor 由服务端强制为登录地址）。
 *
 * 为什么不是把 `/node` 放开给 nodeAdmin：那会连带各租户动作的 IP/操作者与开店审批；
 * 员工只需要能回看自己做过什么（暂停店铺、下架商品、生成提货争议参数…）。
 * 查询参数里的 `actor` 在这里被覆盖——范围只能由令牌回答，不能由调用方指定。
 */
router.get('/node/self', nodeAdmin, wrap(async (req, res) => {
  const actor = String(req.auth?.address || '').toLowerCase();
  // 空地址会让 queryAudit 跳过 actor 条件（= 读到全节点）；鉴权已保证非空，这里再挡一次
  if (!actor) return fail(res, '登录地址缺失', 401, 401);
  ok(res, await queryAudit({ ...listParams(req), shopCode: null, actor }));
}));

/**
 * 节点级审计 CSV（hostOnly）：全量、非分页，按 id 升序（证据文件按发生顺序读）。
 * `action` / `actor` 与列表同一组过滤参数；**列里不带 prev_hash/entry_hash**——
 * 节点级子集的相邻行本来就不相接（各店的行被过滤掉了），把哈希带进文件只会制造假断裂。
 * 导出动作本身也写一条节点级审计（`export.node_audit`），但它不在本次文件里（先读后写）。
 */
router.get('/node.csv', hostOnly, auditCsvLimiter, wrap(async (req, res) => {
  const { action, actor } = listParams(req);
  const rows = await exportAudit({ action, actor, shopCode: null });
  await logAudit({
    req,
    actor: req.auth?.address,
    actorRole: 'host',
    shopCode: null,
    action: 'export.node_audit',
    targetType: 'export',
    targetId: '-',
    detail: { rows: rows.length, action: action || '', actor: actor || '' },
  });
  const headers = ['id', 'at', 'actor', 'actor_role', 'action', 'target_type', 'target_id', 'detail', 'ip'];
  const csvRows = rows.map((r) => [
    r.id,
    r.at instanceof Date ? r.at.toISOString() : String(r.at ?? ''),
    r.actor,
    r.actorRole,
    r.action,
    r.targetType,
    r.targetId,
    JSON.stringify(r.detail ?? {}),
    r.ip,
  ]);
  sendCsv(res, `node-audit-${new Date().toISOString().slice(0, 10)}.csv`, headers, csvRows);
}));

export default router;
