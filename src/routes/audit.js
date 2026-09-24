/**
 * 管理审计查询（P1-④，ownerOnly）：
 *  GET /api/shop/audit?page=&pageSize=&action=&actor= → {total, page, items:[{at,actor,actorRole,action,targetType,targetId,detail,ip}]}
 */
import { Router } from 'express';
import { verifyToken } from '../auth.js';
import { ok, wrap, makeAuthMiddleware } from '../http.js';
import { queryAudit } from '../audit.js';

const router = Router();
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true });

router.get('/', ownerOnly, wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
  const action = String(req.query.action || '') || undefined;
  const actor = String(req.query.actor || '') || undefined;
  ok(res, queryAudit({ page, pageSize, action, actor }));
}));

export default router;
