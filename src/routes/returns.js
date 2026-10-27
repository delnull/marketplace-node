/**
 * 退货单路由（P0-4，挂 /api/orders 前缀，在 ordersRouter 之后注册——无路径冲突）：
 *  POST /:orderNo/return             店主创建退货单（幂等返回既有单）
 *  POST /:orderNo/return/tracking    买家回填退回物流单号
 *  POST /:orderNo/return/receive     店主确认收到退货（释放占位时机）
 *  POST /:orderNo/return/waive       店主放弃追索（等价 receive，标注 waived）
 * 门控与语义见 src/returns.js；链上资金流不变（approveRefund 仍由店主钱包发起）。
 *
 * ⚠️ 路径段是**对外订单号 `order_no`**；内部订单键（`orders.id` = 视图的 `order_id`）
 * 只用于子表（`order_returns.order_id` 是它的外键），不出现在 URL 里。
 */
import { Router } from 'express';
import { getDb } from '../db.js';
import { verifyToken, roleOf } from '../auth.js';
import { ok, fail, wrap, makeAuthMiddleware } from '../http.js';
import { logAudit } from '../audit.js';
import { createReturn, requestReturn, setReturnAddress, setReturnTracking, settleReturn, returnToPublic } from '../returns.js';
import { findOrderInShop } from '../orderScope.js';

const router = Router();
const requireAuth = makeAuthMiddleware(verifyToken);
const staffOnly = makeAuthMiddleware(verifyToken, { staffOnly: true });

/**
 * 店主面的三条路由都必须是**本店**的订单（见 src/orderScope.js）：退货的 `receive/waive`
 * 会**回补库存占位**（`settleReturn`），而占位是按商品计的——别店店主能替别店"确认收到退货"，
 * 就等于凭空释放别店的库存额度 ⇒ **超卖**（且所有写操作都会成功）。
 * 买家面那条（`/tracking`）按买家身份门控，不需要店铺作用域（身份判据在 `setReturnTracking` 里，
 * 它比对的就是订单行自己的 `buyer`），所以它按订单号读整张订单即可。
 */
const findOrderForBuyer = async (orderNo) => await getDb().get('SELECT * FROM v_orders WHERE order_no = ?', String(orderNo || ''));

/**
 * 管理审计便捷包装（仅 staff 记录；角色按**本店**算，漏传店铺编号会让审计行静默消失）。
 * 三条退货路由都是 `staffOnly`（各自校验过"这一单属于本店"），所以归属恒为 `req.shop.code`。
 */
const audit = async (req, action, targetId, detail) =>
  logAudit({
    req,
    actor: req.auth?.address,
    actorRole: req.shopRole && req.shopRole !== 'user' ? req.shopRole : await roleOf(req.auth?.address || '', req.shop.code),
    shopCode: req.shop.code,
    action,
    targetType: 'return',
    targetId,
    detail,
  });

/**
 * "这一单是刚刚建的，还是本来就有"——用于回执文案。
 * `created_at` 是 `DATETIME(3)` → `Date`，所以判据是**时刻比较**（`Date.now() - created_at < 5s`），
 * 不是数值比较（旧形状把毫秒整数直接比大小；换成 Date 之后 `>=` 会退化成"字符串/对象比较"，
 * 永远为假——那会让每一次新建都被说成"已存在"）。
 */
const isJustCreated = (row, now = Date.now()) => row?.created_at instanceof Date && now - row.created_at.getTime() < 5000;

/** 店主创建退货单 */
/**
 * 买家发起退货申请：只创建 open 的空地址退货单，seller 补地址后买家再填回寄单号。
 * 这是退货的**发起权**归买家；卖家仍可用下面 `POST /return` 直接建单（历史路径）。
 */
router.post('/:orderNo/return/request', requireAuth, wrap(async (req, res) => {
  const order = await findOrderForBuyer(req.params.orderNo);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const r = await requestReturn({
    order,
    buyer: req.auth.address,
    note: req.body?.note,
  });
  if (r.error) return fail(res, r.error, r.forbidden ? 403 : r.notFound ? 404 : 1, r.forbidden ? 403 : r.notFound ? 404 : 200);
  await logAudit({
    req,
    actor: req.auth.address,
    actorRole: 'buyer',
    shopCode: order.shop_code,
    action: 'return.request',
    targetType: 'order',
    targetId: order.order_no,
    detail: { status: r.data.status },
  });
  ok(res, returnToPublic(r.data), '退货申请已提交，等待卖家填写退货地址');
}));

router.post('/:orderNo/return', staffOnly, wrap(async (req, res) => {
  const order = await findOrderInShop(req.params.orderNo, req.shop.code);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const r = await createReturn({ order, address: req.body?.address, note: req.body?.note });
  if (r.error) return fail(res, r.error, r.notFound ? 404 : 1, r.notFound ? 404 : 200);
  await audit(req, 'return.create', order.order_no, { status: r.data.status }); // 不落退货地址
  const created = isJustCreated(r.data);
  ok(res, returnToPublic(r.data), created ? '退货单已创建' : '退货单已存在');
}));

/** 买家回填退回物流单号（可带承运方名称；归一与上限见 src/returns.js → src/shipping.js） */
/** 卖家填写/修改退货地址（买家发起申请后；只允许 open）。 */
router.patch('/:orderNo/return/address', staffOnly, wrap(async (req, res) => {
  const order = await findOrderInShop(req.params.orderNo, req.shop.code);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const returnRow = await getDb().get('SELECT * FROM order_returns WHERE order_id = ?', order.order_id);
  const r = await setReturnAddress({ returnRow, address: req.body?.address });
  if (r.error) return fail(res, r.error);
  await audit(req, 'return.address', order.order_no, {});
  ok(res, returnToPublic(r.data), '退货地址已保存');
}));

router.post('/:orderNo/return/tracking', requireAuth, wrap(async (req, res) => {  const order = await findOrderForBuyer(req.params.orderNo);
  if (!order) return fail(res, '订单不存在', 404, 404);
  // `order_returns.order_id` 是内部订单键（子表外键），所以这里用视图的 `order_id`
  const returnRow = await getDb().get('SELECT * FROM order_returns WHERE order_id = ?', order.order_id);
  const r = await setReturnTracking({
    order,
    returnRow,
    buyer: req.auth.address,
    trackingNo: req.body?.trackingNo,
    carrier: req.body?.carrier,
  });
  if (r.error) return fail(res, r.error, r.forbidden ? 403 : 1, r.forbidden ? 403 : 200);
  ok(res, returnToPublic(r.data), '已记录退回物流单号');
}));

/** 店主确认收到退货 */
router.post('/:orderNo/return/receive', staffOnly, wrap(async (req, res) => {
  const order = await findOrderInShop(req.params.orderNo, req.shop.code);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const returnRow = await getDb().get('SELECT * FROM order_returns WHERE order_id = ?', order.order_id);
  const r = await settleReturn({ order, returnRow, waived: false });
  if (r.error) return fail(res, r.error);
  await audit(req, 'return.receive', order.order_no, {});
  ok(res, returnToPublic(r.data), '已确认收到退货（库存额度已回补，可再次销售）');
}));

/** 店主放弃追索（未实际收到货，但确认不再追回——等价释放额度；未建单时自动建单再放弃） */
router.post('/:orderNo/return/waive', staffOnly, wrap(async (req, res) => {
  const order = await findOrderInShop(req.params.orderNo, req.shop.code);
  if (!order) return fail(res, '订单不存在', 404, 404);
  let returnRow = await getDb().get('SELECT * FROM order_returns WHERE order_id = ?', order.order_id);
  if (!returnRow) {
    // 无既有退货单：先建（门控：已交付 + 状态窗口），再置放弃
    const created = await createReturn({ order, address: req.body?.address ?? '', note: req.body?.note ?? '卖家放弃追索' });
    if (created.error) return fail(res, created.error, created.notFound ? 404 : 1, created.notFound ? 404 : 200);
    returnRow = created.data;
  }
  const r = await settleReturn({ order, returnRow, waived: true });
  if (r.error) return fail(res, r.error);
  await audit(req, 'return.waive', order.order_no, {});
  ok(res, returnToPublic(r.data), '已放弃追索（额度释放；如需追回请线下处理）');
}));

export default router;
