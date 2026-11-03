/**
 * 买家在本节点的屏蔽名单（`/api/me/blocks`，requireAuth）。
 *
 *  GET    /        我的屏蔽
 *  POST   /        {targetType:'shop'|'seller', target, reason?}
 *  DELETE /:id     只能删自己的
 *
 * 节点后端持久化；不是 localStorage、不是平台全局名单。换节点需重新设置。
 */
import { Router } from 'express';
import { ok, fail, wrap, makeAuthMiddleware } from '../http.js';
import { verifySession } from '../auth.js';
import { addBuyerBlock, listBuyerBlocks, removeBuyerBlock } from '../blocks.js';

const router = Router();
const requireAuth = makeAuthMiddleware(verifySession);

router.get('/', requireAuth, wrap(async (req, res) => {
  ok(res, { blocks: await listBuyerBlocks(req.auth.address) });
}));

router.post('/', requireAuth, wrap(async (req, res) => {
  const r = await addBuyerBlock({
    buyer: req.auth.address,
    targetType: req.body?.targetType,
    target: req.body?.target,
    reason: req.body?.reason,
  });
  if (r.error) return fail(res, r.error, r.notFound ? 404 : 400, r.notFound ? 404 : 400);
  ok(res, r.block, '已在当前节点屏蔽');
}));

router.delete('/:id', requireAuth, wrap(async (req, res) => {
  const r = await removeBuyerBlock({ buyer: req.auth.address, id: req.params.id });
  if (r.error) return fail(res, r.error, r.notFound ? 404 : 400, r.notFound ? 404 : 400);
  ok(res, { removed: true }, '已解除屏蔽');
}));

export default router;
