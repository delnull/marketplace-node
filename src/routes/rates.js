/**
 * 汇率路由：GET /api/rates
 * 返回当前 BTY-USDT 行情与 USDT → BTY 换算系数（1 USDT = x BTY）；
 * 唯一数据源（官方 BTY ticker）不可用时自动降级（stale=true / 手工兜底值 fallback=true），
 * 完全不可用时 available=false，前端只展示 USDT 标价（不显示 BTY 估算）。
 * 标价单位已是 USDT，因此不再有任何法币（CNY）汇率腿。
 *
 * 降级分支**也返回同一组键**（值置 null / true）：形状不一致时，任何读 `rates.error`/`rates.stale`
 * 的消费方拿到的是 `undefined`，而 `frontend/src/types.ts` 把这几项声明为非可选——
 * 那种"今天不炸、明天换个人读就炸"的接口比慢一点报错更贵（源码评审 2026-10，P2）。
 */
import { Router } from 'express';
import { getRates } from '../rates.js';
import { ok, wrap } from '../http.js';

const router = Router();

/** 完全不可用时的应答（键集合与可用时一致，只是没有数）。导出是为了让测试钉住"两分支同形状" */
export const UNAVAILABLE = {
  available: false,
  btyUsdt: null,
  usdtToBty: null,
  stale: true,
  fallback: false,
  error: '汇率数据源暂不可用（未配置兜底汇率）',
  updatedAt: null,
};

router.get('/', wrap(async (req, res) => {
  const rates = await getRates();
  if (!rates) {
    ok(res, UNAVAILABLE);
    return;
  }
  ok(res, { available: true, ...rates });
}));

export default router;
