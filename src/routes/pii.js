/**
 * 个人信息删除/保留期路由（挂 /api/shop 前缀；两个端点均 ownerOnly）。
 *
 *  POST /orders/:id/erase-pii   显式删除请求（PIPL 式）：立即擦除该单的个人信息
 *                              （收货信息/买家备注/售后陈述正文/证据附件；金额与链上凭证保留）
 *  POST /retention/run          手动跑一次保留期擦除（阈值缺省 MK_PII_RETENTION_DAYS；
 *                              周期自动扫描见 src/piiErase.js 与 server.js 的接线）
 *
 * 为什么只有店主可用（ownerOnly 而非 staffOnly）：删除是不可逆操作，且它同时抹掉卖家侧
 * 履约所需的信息（收货信息一旦擦除，该单此后只能按链上记录处理）；店员能做发货/退款，
 * 不应能一个人把证据清空。擦除范围与保留口径全部在 src/piiErase.js 里（唯一实现）。
 * 两个端点各自按 IP 限流（重同步操作，见下方常量注释）；手动保留期运行另加单飞。
 */
import { Router } from 'express';
import config from '../config.js';
import { getDb } from '../db.js';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { verifyToken, roleOf } from '../auth.js';
import { logAudit } from '../audit.js';
import { eraseOrderPii, runPiiRetention } from '../piiErase.js';

const router = Router();
const ownerOnly = makeAuthMiddleware(verifyToken, { ownerOnly: true });

/** 手动保留期运行的响应里最多回列多少个订单号（防一次 1000 单的响应体把面板撑爆） */
const MAX_REPORTED_IDS = 50;

/*
  这两个端点此前都**没有节点内限流**，而它们是全站最重的同步写路径：
   · /retention/run 一次最多擦 200 单，每一单都是「SQLite 事务 + 目录删除」全同步执行，
     期间整个事件循环被占住（HTTP 全部排队）；
   · /orders/:id/erase-pii 单次擦除含磁盘目录递归删除。
  数值依据：两者都是**店主手动、低频**动作（保留期另有 6 小时一轮的周期扫描兜底），
  一分钟 20 / 30 次已远超任何正常操作（连点也不会超过个位数）；限流只挡脚本与重放。
*/
const erasePiiLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: '个人信息擦除请求过于频繁，请稍后再试' });
const retentionLimiter = simpleRateLimit({ windowMs: 60_000, max: 20, message: '保留期擦除运行过于频繁，请稍后再试' });

/**
 * 保留期运行的**单飞**状态（同一时刻只允许一次；同一进程内）：
 *  · running：正在跑 → 第二个请求直接回可读错误，不排队（见下）；
 *  · last：刚刚跑完（< RETENTION_REUSE_WINDOW_MS）且 days 相同 → 复用上次结果并标注 `reused`。
 *
 * 为什么需要：runPiiRetention 是**全同步**的（SQLite + fs），一次最多处理 200 单、期间
 * 事件循环被独占。此刻到达的重复请求不会失败，而是排队等主线程空出来——于是同一次
 * "清一下到期数据"的连点/前端超时重试会把同一份重活跑第二遍（第二遍通常什么都擦不到，
 * 纯属白占一次主线程）。`running` 覆盖"真的并发进入"的情形（若将来擦除改成分片异步，
 * 这里就是硬闸）；同进程内的同步实现里，能被观察到的其实是 `last` 那条复用窗口
 *（同一秒内的重复请求直接拿上次结果，不再跑一遍）。
 *
 * 复用的边界：只在 days **相同**时复用——不同的 days 是货真价实的另一次运行
 *（例：先按缺省 180 天跑一次，再收紧到 7 天补扫，见 test/pii-erase.test.js）。
 */
const RETENTION_REUSE_WINDOW_MS = 2000;
let retentionRunning = false;
let retentionLast = null; // { at, days, data, message }

/** 显式删除请求：擦除单个终局订单的个人信息（幂等；重复调用无第二次变更） */
router.post('/orders/:id/erase-pii', ownerOnly, erasePiiLimiter, wrap(async (req, res) => {
  const order = getDb().prepare('SELECT id FROM orders WHERE id = ?').get(String(req.params.id || ''));
  if (!order) return fail(res, '订单不存在', 404, 404);
  const r = eraseOrderPii(order.id);
  // 在途单拒绝擦除（draft/escrowed/shipped/disputed 的收货信息是履约必需）——错误信息里说明出口。
  // ⚠️ 判据是结果方给的 `code`（'not_found' / 'not_terminal' = **什么也没擦**），
  // 不是"有没有 error 字段"：删盘失败（**擦了一半**）也带 error，用字段存在性判会把两种结论
  // 混成一支，那一支不下发读数——界面恰好在这一刻读不到"盘上还剩几个文件"（2026-10-14 修）。
  if (r.code) return fail(res, r.message || '个人信息擦除失败', 1, r.code === 'not_found' ? 404 : 200);
  /*
    ── 成功与"擦了一半"必须**同一个形状**（2026-10-14 修）────────────────────────
    此前删盘失败走的是业务错误分支（`fail(res, …, 1)`），那个分支**不下发读数**——
    而界面（`utils/piiEraseAction.piiEraseOutcomeText`）正是按 `attachmentFilesRemaining` /
    `walTruncated` / `alreadyErased` 三个读数决定说什么。于是最需要读数的时刻（盘上还有个人数据）
    恰恰读不到，界面只能退化成一句通用文案，还可能被读成"已擦除"。
    修法：payload 只构造一次，成功与失败走同一份字段集，差别只在 `attachmentFailed`。
  */
  const payload = {
    orderId: r.orderId,
    status: r.status,
    alreadyErased: !r.changed,
    erased: r.counts,
    /*
      **擦得干不干净**必须由这两个读数回答，不能由 `changed` 回答（2026-10-14 修订）。
      `changed` 是"本次有没有改动"，而删除请求问的是"数据还在不在"：
      · `attachmentFilesRemaining`：磁盘上还剩几个附件文件（0 = 干净；<0 = 目录读不出来）；
      · `walTruncated`：WAL 是否已截断（false = 原文可能仍留在 `<db>-wal` 里）。
      旧实现只回 `attachmentFilesRemoved`，且它是从**恒真**的判据派生的（已修），
      于是"盘上还有文件"这件事在响应里看不出来。
    */
    attachmentFilesRemaining: r.attachmentFilesRemaining,
    /* 三态布尔（与读数同款）：true 确认删净 / false 确认没删净 / null 目录读不出来 ⇒ 不敢说。
       它与 `attachmentFilesRemaining` 一起给出，界面不必自己把残留数翻译成结论。 */
    attachmentFilesRemoved: r.attachmentFilesRemoved,
    walTruncated: r.walTruncated,
    /* 盘上没删净：界面要原样展示 `error` 那句（它比通用文案具体到原因） */
    attachmentFailed: !r.ok,
    ...(r.ok ? {} : { error: r.error }),
  };
  // 管理审计：detail 只记**计数**与来源，绝不把擦掉的内容再抄进审计表（那就等于没擦）
  logAudit({
    req,
    actor: req.auth?.address,
    actorRole: roleOf(req.auth?.address || ''),
    action: 'order.erase_pii',
    targetType: 'order',
    targetId: r.orderId,
    /*
      审计只记**计数与结果读数**，绝不把擦掉的内容再抄进审计表（那就等于没擦）。
      `attachmentsRemaining` 用残留数而不是一个布尔：审计要能回答"那次到底删干净了没有"，
      而布尔在读的时候永远不知道它是从哪个判据派生的（旧实现就派生于一个恒真的字段名）。
    */
    detail: {
      trigger: 'request',
      ...r.counts,
      alreadyErased: !r.changed,
      attachmentsRemaining: r.attachmentFilesRemaining,
      walTruncated: r.walTruncated,
    },
  });
  if (!r.ok) {
    /*
      删盘失败：**业务码非 0**（调用方据此知道"这次没做成"），但读数照给。
      文案必须与"盘上到底还有没有东西"一致：擦除失败时锚点会被回退以便自动重试，
      于是下一次调用 `changed` 可能是 0——旧文案会把它说成"此前已擦除（幂等）"，
      而真相是"上一轮没删干净"。谎报比不报更糟，所以这里按失败态单独给一句。
    */
    return fail(
      res,
      '库内的收货信息/备注/陈述正文/附件索引已清空，但**磁盘上的附件文件没能删掉**——请检查附件目录权限/占用后重试（系统会在下一轮保留期扫描中自动重试）',
      1,
      200,
      payload
    );
  }
  return ok(
    res,
    payload,
    r.changed
      ? '个人信息已擦除（金额/订单状态/链上托管单号/支付凭证/事件史/交付行/评价保留不变）'
      : '该订单的个人信息此前已擦除（本次无内容变更；重复调用幂等）'
  );
}));

/**
 * 手动运行保留期擦除（店主点一下就把到期的存量清掉，不必等周期扫描）。
 * 阈值缺省取 config.pii.retentionDays；请求体可传 days 覆盖（便于按需收紧一次），
 * days=0 表示"关闭"——手动运行不会偷偷改成别的语义，只如实回报"已关闭"。
 * 单飞 + 2 秒结果复用见文件上方 RETENTION_REUSE_WINDOW_MS 的说明。
 */
router.post('/retention/run', ownerOnly, retentionLimiter, wrap(async (req, res) => {
  let days = config.pii.retentionDays;
  const raw = req.body?.days;
  if (raw !== undefined && raw !== null && raw !== '') {
    days = Number(raw);
    if (!Number.isInteger(days) || days < 0) return fail(res, 'days 需为 ≥ 0 的整数（保留天数；0 = 关闭自动擦除）');
  }
  if (retentionRunning) {
    return fail(res, '保留期擦除正在运行中（同一时刻只允许一次）：请等本次结束——结果会在响应/服务日志里给出');
  }
  if (retentionLast && retentionLast.days === days && Date.now() - retentionLast.at < RETENTION_REUSE_WINDOW_MS) {
    return ok(
      res,
      { ...retentionLast.data, reused: true },
      `刚刚（${Math.max(1, Math.round((Date.now() - retentionLast.at) / 1000))} 秒内）已运行过同一强度的保留期擦除，本次复用那次结果：${retentionLast.message}`
    );
  }
  retentionRunning = true;
  let r;
  try {
    r = runPiiRetention({ days });
  } finally {
    retentionRunning = false; // 异常也要放闸：否则一次失败会把端点永久钉在"运行中"
  }
  logAudit({
    req,
    actor: req.auth?.address,
    actorRole: roleOf(req.auth?.address || ''),
    action: 'retention.run',
    targetType: 'shop',
    targetId: '-',
    detail: { days: r.days, disabled: r.disabled, candidates: r.candidates, erased: r.erased, ...r.counts },
  });
  const data = {
    days: r.days,
    disabled: r.disabled,
    candidates: r.candidates,
    erased: r.erased,
    truncated: r.truncated,
    counts: r.counts,
    orderIds: r.orderIds.slice(0, MAX_REPORTED_IDS),
    orderIdsOmitted: Math.max(0, r.orderIds.length - MAX_REPORTED_IDS),
  };
  const message = r.disabled
    ? '自动擦除已关闭（MK_PII_RETENTION_DAYS=0）：本次未擦除任何数据；如需立即执行，请在请求体给出天数（如 {"days":180}）'
    : r.erased > 0
      ? `已擦除 ${r.erased} 个终局订单的个人信息（资金流终结且静置 > ${r.days} 天）${r.truncated ? '；本次达到单轮上限，可再次运行处理剩余订单' : ''}`
      : `无到期订单（终局且静置 > ${r.days} 天的订单为 0）`;
  // 记下这次运行，供 2 秒内的重复请求复用（见文件上方单飞说明）
  retentionLast = { at: Date.now(), days, data, message };
  ok(res, data, message);
}));

export default router;
