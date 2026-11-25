/**
 * 评价图治理（节点管理员）：有图评价队列 + 评价级逐图下架。
 *
 * 为什么治理单元是**评价**而不是订单：
 *  - 评价图挂在 `reviews` 行上（一组首评、一组追评 JSON），评价 id 本来就在公开评价 DTO 里；
 *  - 订单号只是报告里常见的搜索键。以订单为入口时，"在商品页看到一张图"或"只拿到图链接"
 *    的人必须先找到订单号，而那个号不在公开评价界面里；
 *  - 队列因此按评价读：店铺/商品/订单号都只是筛选条件，订单号不再出现在响应里，
 *    只进审计与通知。
 *
 * 路由与读者：
 *  GET    /api/shop/review-images?page&pageSize&shopCode&productSlug&orderNo
 *         → 有图评价队列（nodeAdmin）
 *  GET    /api/shop/reviews/:id/images（nodeAdmin）
 *         → 一条评价的两组图（不含订单号/买家/正文）
 *  DELETE /api/shop/reviews/:id/images（nodeAdmin）
 *         → 逐图下架，body `{kind, url, reason}`；原因必填
 *
 * 审计：动作仍是 `review.image.remove`，`target_type='order'`、`target_id=order_no`、
 * `detail.shopCode` 保持原形状——店铺详情的节点治理记录靠 `targetShop` 过滤找它
 * （见 node/src/audit.js 的 auditWhere）。新增 `reviewId` / `reason` / `url`，
 * 让"哪条评价、为什么下架"可回看。
 *
 * 删除内核仍只有 `reviews.removeReviewImage` 一处：本文件只负责定位评价、校验原因与写审计。
 */
import { Router } from 'express';
import { verifySession, isHost } from '../auth.js';
import { fail, ok, wrap, makeAuthMiddleware } from '../http.js';
import { logAudit } from '../audit.js';
import { notifyRaw } from '../webhook.js';
import { isShopCodeShape } from '../shops.js';
import { verifyShopCode } from '../shopCode.js';
import { normalizeId } from '../ids.js';
import {
  findReviewImageById,
  reviewImageDto,
  reviewImageQueue,
  removeReviewImage,
} from '../reviews.js';

const router = Router();
const nodeAdmin = makeAuthMiddleware(verifySession, { nodeAdmin: true });

/** 分页（与其它管理列表同一口径：页码有上限，防止 `(page-1)*pageSize` 把 SQL 变成 500） */
function listParams(req) {
  return {
    page: Math.min(1000, Math.max(1, parseInt(req.query.page, 10) || 1)),
    pageSize: Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 10)),
  };
}

/** 评价内部键：正安全整数；形状不对返回错误（不和"没有这条评价"混成同一句话） */
function reviewIdParam(req) {
  const raw = String(req.params.id || '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return { error: '评价编号不对' };
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) return { error: '评价编号不对' };
  return { value: id };
}

/** 店铺筛选：形状 + 校验位错都 400，不把抄错的编号当成"没有记录" */
function shopCodeParam(req) {
  const raw = String(req.query.shopCode || '').trim().toUpperCase();
  if (!raw) return { value: undefined };
  if (!isShopCodeShape(raw)) return { error: '店铺编号必须是 9 位' };
  if (!verifyShopCode(raw)) return { error: '店铺编号校验位不对：请核对店铺编号' };
  return { value: raw };
}

/**
 * 节点级动作审计（节点主 host / 员工 staff）。目标店写在 detail.shopCode，
 * shop_code 仍为 NULL——这是节点处置，不是那家店的经营动作。
 */
const nodeAudit = async (req, action, targetType, targetId, detail) =>
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

router.get('/review-images', nodeAdmin, wrap(async (req, res) => {
  const shop = shopCodeParam(req);
  if (shop.error) return fail(res, shop.error, 400, 400);
  const productSlug = normalizeId(String(req.query.productSlug || ''));
  const orderNo = normalizeId(String(req.query.orderNo || ''));
  ok(
    res,
    await reviewImageQueue({
      ...listParams(req),
      shopCode: shop.value,
      productSlug: productSlug || undefined,
      orderNo: orderNo || undefined,
    })
  );
}));

router.get('/reviews/:id/images', nodeAdmin, wrap(async (req, res) => {
  const id = reviewIdParam(req);
  if (id.error) return fail(res, id.error, 400, 400);
  const row = await findReviewImageById(id.value);
  if (!row) return fail(res, '没有这条评价', 404, 404);
  ok(res, reviewImageDto(row));
}));

router.delete('/reviews/:id/images', nodeAdmin, wrap(async (req, res) => {
  const id = reviewIdParam(req);
  if (id.error) return fail(res, id.error, 400, 400);
  const row = await findReviewImageById(id.value);
  if (!row) return fail(res, '没有这条评价', 404, 404);

  const reason = String(req.body?.reason || '').trim();
  if (!reason) return fail(res, '下架原因必填（≤200 字）', 400, 400);
  if (reason.length > 200) return fail(res, '下架原因不能超过 200 字', 400, 400);
  const kind = String(req.body?.kind || '');
  if (kind !== 'review' && kind !== 'followup') {
    return fail(res, '评价类型必须是评价或追评', 400, 400);
  }
  const url = String(req.body?.url || '').trim();
  if (!url) return fail(res, '要下架的图片地址不能为空', 400, 400);
  if (url.length > 200) return fail(res, '要下架的图片地址不对', 400, 400);

  const removed = await removeReviewImage({ orderId: row.order_id, kind, url });
  if (removed.error) return fail(res, removed.error, removed.notFound ? 404 : 1, removed.notFound ? 404 : 200);

  await nodeAudit(req, 'review.image.remove', 'order', row.order_no, {
    shopCode: row.shop_code,
    orderNo: row.order_no,
    reviewId: Number(row.id),
    kind,
    url,
    reason,
    remaining: removed.remaining,
  });
  /*
    店主 webhook：评价图在店主商品页上消失，店主至少应知道"被节点下架了、为什么"。
    fire-and-forget；未配置 URL 时零开销，投递失败不影响已完成的治理动作。
  */
  void notifyRaw('review.image.remove', {
    shopCode: row.shop_code,
    orderNo: row.order_no,
    reviewId: Number(row.id),
    kind,
    reason,
  });
  ok(res, { remaining: removed.remaining }, '评价图已下架');
}));

export default router;
