/**
 * 管理审计查询（P1-④）：
 *  GET /api/shop/audit?page=&pageSize=&action=&actor= → 本店审计（ownerOnly）
 *    {total, page, pageSize, items:[{id, at(ISO-8601), actor, actorRole, action, targetType, targetId, detail(对象), ip}]}
 *  GET /api/shop/audit/node?…                        → **节点级**审计（**hostOnly**：节点资料、开店审批、
 *    保留期触发、系统动作——这些事件不属于任何一家店，`shop_code IS NULL`）
 *
 * 时间与 detail 的形状由 `audit.js` 的 `queryAudit` 决定（`at` 是 `DATETIME(3)` → `Date` → ISO，
 * `detail` 是 JSON 列 → 对象）：本文件只做分页参数与鉴权，不重新解释那一行。
 *
 * ## 为什么是两条路由，而不是一条按请求头切换范围的
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
 * 旧形状（一条 ownerOnly 路由 + 不过滤）的实际效果是**任一店店主读到整个节点的审计**：
 * 别的店的订单号与变更摘要。那是数据模型缺了一维，不是权限配置漏了一项。
 */
import { Router } from 'express';
import { verifyToken } from '../auth.js';
import { ok, wrap, makeAuthMiddleware } from '../http.js';
import { queryAudit } from '../audit.js';

const router = Router();
// 审计行含 IP/操作者/被操作对象：店铺级私域，只认该店店主（节点主看节点级那份，见 GET /node）
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true });
// 节点级审计：仅节点主（节点主可以一家店都没有，不要求也不消费请求头）
const hostOnly = makeAuthMiddleware(verifyToken, { hostOnly: true });

/** 分页与可选过滤（两条路由共用，避免两处各解一次参数而漂移） */
function listParams(req) {
  return {
    page: Math.max(1, parseInt(req.query.page, 10) || 1),
    pageSize: Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30)),
    action: String(req.query.action || '') || undefined,
    actor: String(req.query.actor || '') || undefined,
  };
}

router.get('/', ownerOnly, wrap(async (req, res) => {
  ok(res, await queryAudit({ ...listParams(req), shopCode: req.shop.code }));
}));

router.get('/node', hostOnly, wrap(async (req, res) => {
  ok(res, await queryAudit({ ...listParams(req), shopCode: null }));
}));

export default router;
