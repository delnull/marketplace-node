/**
 * 汇率路由：GET /api/rates
 * 返回当前 BTY-USDT / USDT-CNY 及 CNY → BTY/USDT 换算系数；
 * 数据源（官方 BTY ticker + 公开 USDT-CNY 源）不可用时自动降级（stale=true / fallback），
 * 完全不可用时 available=false，前端仅展示 CNY 标价。
 */
import { Router } from 'express';
import { getRates } from '../rates.js';
import { ok, wrap } from '../http.js';

const router = Router();

router.get('/', wrap(async (req, res) => {
  const rates = await getRates();
  if (!rates) {
    ok(res, { available: false, message: '汇率数据源暂不可用（未配置兜底汇率）' });
    return;
  }
  ok(res, { available: true, ...rates });
}));

export default router;
