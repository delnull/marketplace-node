/**
 * 买家收藏（店铺 / 商品）—— **每节点各存一份**。
 *
 *  GET    /api/favorites?address=0x…   公开读：按地址返回本节点已收藏的店铺与商品
 *  PUT    /api/favorites               登录写：{kind:'shop'|'product', code, slug?}
 *  DELETE /api/favorites               登录删：同上
 *
 * 读不需要登录（买家连钱包后按地址恢复收藏）；
 * 写必须登录：身份取令牌里的地址，**不认 body 里的 address**——否则任何人都能替别人改收藏。
 */
import { Router } from 'express';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { verifyToken } from '../auth.js';
import { getDb, withTransaction } from '../db.js';
import { isShopCodeShape } from '../shops.js';

const router = Router();
const requireAuth = makeAuthMiddleware(verifyToken);
// 公开按地址读可以被枚举，写又带一次登录；两条路径都限速，避免用收藏接口打库。
router.use(simpleRateLimit({ windowMs: 60_000, max: 120 }));

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const SLUG_RE = /^[A-Za-z0-9_-]{1,128}$/;

function normAddress(raw) {
  const address = String(raw ?? '').trim().toLowerCase();
  return ADDRESS_RE.test(address) ? address : '';
}

function shapeOf(body) {
  const kind = body?.kind === 'shop' ? 'shop' : body?.kind === 'product' ? 'product' : '';
  const code = String(body?.code ?? '').trim().toUpperCase();
  const slug = String(body?.slug ?? '').trim();
  if (!kind) return { error: 'kind 只能是 shop 或 product' };
  if (!isShopCodeShape(code)) return { error: '店铺编号形状不对' };
  if (kind === 'shop') {
    if (slug) return { error: '店铺收藏不带 slug' };
    return { kind, code, slug: '' };
  }
  if (!SLUG_RE.test(slug)) return { error: '商品 slug 形状不对' };
  return { kind, code, slug };
}

async function assertTarget({ kind, code, slug }) {
  const db = getDb();
  const shop = await db.get('SELECT code FROM shops WHERE code = ?', code);
  if (!shop) return { error: '店铺不存在', notFound: true };
  if (kind === 'product') {
    const product = await db.get('SELECT slug FROM products WHERE shop_code = ? AND slug = ?', code, slug);
    if (!product) return { error: '这家店没有这个商品', notFound: true };
  }
  return { ok: true };
}

router.get('/', wrap(async (req, res) => {
  // 按钱包地址的偏好：即使接口公开，也不能进共享缓存。
  res.setHeader('Cache-Control', 'private, no-store');
  const address = normAddress(req.query.address);
  if (!address) return fail(res, 'address 需为 0x 开头的 40 位地址', 400, 400);
  const rows = await getDb().all(
    `SELECT f.kind, f.shop_code, f.product_slug
       FROM buyer_favorites f
       LEFT JOIN products p ON p.shop_code = f.shop_code AND p.slug = f.product_slug
      WHERE f.buyer = ? AND (f.kind = 'shop' OR p.id IS NOT NULL)
      ORDER BY f.created_at ASC, f.shop_code ASC, f.product_slug ASC`,
    address
  );
  ok(res, {
    shops: rows.filter((r) => r.kind === 'shop').map((r) => String(r.shop_code)),
    products: rows
      .filter((r) => r.kind === 'product')
      .map((r) => ({ code: String(r.shop_code), slug: String(r.product_slug) })),
  });
}));

router.put('/', requireAuth, wrap(async (req, res) => {
  const shape = shapeOf(req.body);
  if (shape.error) return fail(res, shape.error, 400, 400);
  const result = await withTransaction(async () => {
    /*
      先锁住这个买家的收藏行，再做孤儿清理/配额/插入：同一买家的并发 PUT
      从这里开始串行，且不会出现“先删孤儿、后锁范围”的相反加锁顺序。
    */
    await getDb().all(
      'SELECT kind, shop_code, product_slug FROM buyer_favorites WHERE buyer = ? FOR UPDATE',
      req.auth.address
    );
    await getDb().run(
      `DELETE f FROM buyer_favorites f
        LEFT JOIN products p ON p.shop_code = f.shop_code AND p.slug = f.product_slug
       WHERE f.buyer = ? AND f.kind = 'product' AND p.id IS NULL`,
      req.auth.address
    );
    const rows = await getDb().all(
      'SELECT kind, shop_code, product_slug FROM buyer_favorites WHERE buyer = ?',
      req.auth.address
    );
    const exists = rows.some(
      (r) => r.kind === shape.kind && r.shop_code === shape.code && r.product_slug === shape.slug
    );
    if (exists) return { favorite: true };

    const target = await assertTarget(shape);
    if (target.error) return { error: target.error, notFound: target.notFound };
    if (rows.length >= 200) return { error: '收藏最多 200 条，请先取消一些' };

    await getDb().run(
      `INSERT INTO buyer_favorites (buyer, kind, shop_code, product_slug)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE created_at = created_at`,
      req.auth.address,
      shape.kind,
      shape.code,
      shape.slug
    );
    return { favorite: true };
  });
  if (result.error) {
    return fail(res, result.error, result.notFound ? 404 : 400, result.notFound ? 404 : 400);
  }
  ok(res, { favorite: true, ...shape }, '已收藏');
}));

router.delete('/', requireAuth, wrap(async (req, res) => {
  const shape = shapeOf(req.body);
  if (shape.error) return fail(res, shape.error, 400, 400);
  await getDb().run(
    `DELETE FROM buyer_favorites
      WHERE buyer = ? AND kind = ? AND shop_code = ? AND product_slug = ?`,
    req.auth.address,
    shape.kind,
    shape.code,
    shape.slug
  );
  ok(res, { favorite: false, ...shape }, '已取消收藏');
}));

export default router;
