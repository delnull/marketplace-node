/**
 * 退货单路由（P0-4，挂 /api/orders 前缀，在 ordersRouter 之后注册——无路径冲突）：
 *  POST /:id/return             店主创建退货单（幂等返回既有单）
 *  POST /:id/return/tracking    买家回填退回物流单号
 *  POST /:id/return/receive     店主确认收到退货（释放占位时机）
 *  POST /:id/return/waive       店主放弃追索（等价 receive，标注 waived）
 * 门控与语义见 src/returns.js；链上资金流不变（approveRefund 仍由店主钱包发起）。
 */
import { Router } from 'express';
import { getDb } from '../db.js';
import config from '../config.js';
import { verifyToken, roleOf } from '../auth.js';
import { ok, fail, wrap, makeAuthMiddleware } from '../http.js';
import { logAudit } from '../audit.js';
import { createReturn, setReturnTracking, settleReturn, returnToPublic } from '../returns.js';

const router = Router();
const requireAuth = makeAuthMiddleware(verifyToken);
const staffOnly = makeAuthMiddleware(verifyToken, { staffOnly: true }); // P1-⑤

const findOrder = (id) => getDb().prepare('SELECT * FROM orders WHERE id = ?').get(String(id || ''));

/** 店主创建退货单 */
/** 管理审计便捷包装（仅 staff 记录） */
const audit = (req, action, targetId, detail) =>
  logAudit({ req, actor: req.auth?.address, actorRole: roleOf(req.auth?.address || ''), action, targetType: 'return', targetId, detail });

router.post('/:id/return', staffOnly, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const r = createReturn({ order, address: req.body?.address, note: req.body?.note });
  if (r.error) return fail(res, r.error, r.notFound ? 404 : 1, r.notFound ? 404 : 200);
  audit(req, 'return.create', order.id, { status: r.data.status }); // 不落退货地址
  ok(res, returnToPublic(r.data), r.data.status === 'open' && r.data.created_at >= Date.now() - 5000 ? '退货单已创建' : '退货单已存在');
}));

/** 买家回填退回物流单号 */
router.post('/:id/return/tracking', requireAuth, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const returnRow = getDb().prepare('SELECT * FROM order_returns WHERE order_id = ?').get(order.id);
  const r = setReturnTracking({ order, returnRow, buyer: req.auth.address, trackingNo: req.body?.trackingNo });
  if (r.error) return fail(res, r.error, r.forbidden ? 403 : 1, r.forbidden ? 403 : 200);
  ok(res, returnToPublic(r.data), '已记录退回物流单号');
}));

/** 店主确认收到退货 */
router.post('/:id/return/receive', staffOnly, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const returnRow = getDb().prepare('SELECT * FROM order_returns WHERE order_id = ?').get(order.id);
  const r = settleReturn({ order, returnRow, waived: false });
  if (r.error) return fail(res, r.error);
  audit(req, 'return.receive', order.id, {});
  ok(res, returnToPublic(r.data), '已确认收到退货（库存额度已回补，可再次销售）');
}));

/** 店主放弃追索（未实际收到货，但确认不再追回——等价释放额度；未建单时自动建单再放弃） */
router.post('/:id/return/waive', staffOnly, wrap(async (req, res) => {
  const order = findOrder(req.params.id);
  if (!order) return fail(res, '订单不存在', 404, 404);
  let returnRow = getDb().prepare('SELECT * FROM order_returns WHERE order_id = ?').get(order.id);
  if (!returnRow) {
    // 无既有退货单：先建（门控：已交付 + 状态窗口），再置放弃
    const created = createReturn({ order, address: req.body?.address ?? '', note: req.body?.note ?? '卖家放弃追索' });
    if (created.error) return fail(res, created.error, created.notFound ? 404 : 1, created.notFound ? 404 : 200);
    returnRow = created.data;
  }
  const r = settleReturn({ order, returnRow, waived: true });
  if (r.error) return fail(res, r.error);
  audit(req, 'return.waive', order.id, {});
  ok(res, returnToPublic(r.data), '已放弃追索（额度释放；如需追回请线下处理）');
}));

export default router;
