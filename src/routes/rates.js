/**
 * 汇率路由：GET /api/rates
 * 返回当前 BTY-USDT 行情与 USDT → BTY 换算系数（1 USDT = x BTY）；
 * 唯一数据源（官方 BTY ticker）不可用时自动降级（stale=true / 手工兜底值 fallback=true），
 * 完全不可用时 available=false，USDT 定价单不显示 BTY 估算；BTY 定价单本就不读行情。
 * USDT 定价单的标价单位是 USDT，因此不再有任何法币（CNY）汇率腿。
 *
 * 降级分支**也返回同一组键**（值置 null / true）：形状不一致时，任何读 `rates.error`/`rates.stale`
 * 的消费方拿到的是 `undefined`，而 `frontend/src/types.ts` 把这几项声明为非可选——
 * 那种"今天不炸、明天换个人读就炸"的接口比慢一点报错更贵（源码评审 2026-10，P2）。
 */
import { Router } from 'express';
import { getRates } from '../rates.js';
import { ok, simpleRateLimit, wrap } from '../http.js';

const router = Router();

/*
  汇率是匿名只读端点，且上游慢时一次请求会等满 15 秒。没有限流时它就是一个可被用来
  占连接的公开入口（每 IP 每分钟 120 次与公开商品列表同档，正常首页/商品页远低于它）。
*/
const ratesLimiter = simpleRateLimit({ windowMs: 60_000, max: 120, message: '汇率查询过于频繁，请稍后再试' });

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

router.get('/', ratesLimiter, wrap(async (req, res) => {
  const rates = await getRates();
  if (!rates) {
    ok(res, UNAVAILABLE);
    return;
  }
  ok(res, { available: true, ...rates });
}));

export default router;
