/**
 * 个人信息删除/保留期路由（挂 /api/shop 前缀）。两个端点的**权威不同，因为作用域不同**：
 *
 *  POST /orders/:orderNo/erase-pii   显式删除请求（PIPL 式）：立即擦除**那一单**的个人信息
 *                              （收货信息整行/买家备注/售后陈述正文/证据附件；金额与链上凭证保留）
 *                              ⇒ **ownerOnly**（本店店主）
 *  POST /retention/run          手动跑一次保留期擦除（阈值缺省 MK_PII_RETENTION_DAYS；
 *                              周期自动扫描见 src/piiErase.js 与 server.js 的接线）
 *                              ⇒ **hostOnly**（仅节点主，不可下放给节点员工）
 *
 * ⚠️ 路径里是**对外订单号 `order_no`**（用户认得的那个标识），不是内部自增键：
 * 擦除是对"这个单号"做出的承诺，而内部键不出本节点（见 db.js 的读模型说明）。
 *
 * 为什么 erase-pii 是 ownerOnly：删除不可逆，且它同时抹掉卖家侧履约所需的信息（收货信息一旦
 * 擦除，该单此后只能按链上记录处理）；店员能做发货/退款，不应能一个人把证据清空。
 *
 * 为什么 retention/run 是 **hostOnly**（2026-10-18 收口；此前是 nodeAdmin）：
 * **权威必须与作用域相等**。这一跑不是"擦这家店"——`runPiiRetention` 的候选面**没有店铺条件**
 * （保留期是**节点级**配置，周期扫描同样是节点级，响应里的 `candidates/erased` 也是节点合计）。
 * 挂 ownerOnly 的实际后果是：**任一店店主都能让别家店的到期个人信息立刻被擦掉**。
 * 2026-10-18 把 nodeAdmin 扩到"节点主 ∪ 节点员工"之后，同一类越权从"别家店主"变成"节点员工"：
 * 员工与节点主同权限是运营授权，而**跨租户、不可逆的个人信息擦除不属于运营动作**——
 * 一次误操作之后没有撤销出口。所以这条恢复为仅节点主（`hostOnly`，与店铺面的 ownerOnly 分开：
 * 后者回答"你是不是这家店的店主"，不是"你是不是这台机器的主人"）。
 * 被擦的每一单仍各自写一行审计、归**该单所属的店**，所以各店不会因此失去自己的记录
 * （谁触发的记在 `actor` 上）。
 * 插曲：这条此前一直是 ownerOnly，而它触发的动作从来就是节点级的——**判据挂在"谁在查"上
 * 而不是"这一动是谁的范围"上**，于是越权是静默的（没有任何测试或日志会因此变红）。
 *
 * 擦除范围与保留口径全部在 src/piiErase.js 里（唯一实现）。
 * 两个端点各自按 IP 限流（重同步操作，见下方常量注释）；手动保留期运行另加单飞。
 */
import { Router } from 'express';
import config, { PII_RETENTION_REUSE_MS } from '../config.js';
import { ok, fail, wrap, makeAuthMiddleware, simpleRateLimit } from '../http.js';
import { verifySession, roleOf, isHost } from '../auth.js';
import { logAudit } from '../audit.js';
import { eraseOrderPii, runPiiRetention } from '../piiErase.js';
import { findOrderInShop } from '../orderScope.js';

const router = Router();
const ownerOnly = makeAuthMiddleware(verifySession, { ownerOnly: true });
const hostOnly = makeAuthMiddleware(verifySession, { hostOnly: true });

/** 手动保留期运行的响应里最多回列多少个订单号（防一次 1000 单的响应体把面板撑爆） */
const MAX_REPORTED_NOS = 50;

/*
  这两个端点此前都**没有节点内限流**，而它们是全站最重的写路径：
   · /retention/run 一次最多擦 200 单，每一单都是「事务 + 目录删除」，期间连接与事件循环都忙着；
   · /orders/:orderNo/erase-pii 单次擦除含磁盘目录递归删除。
  数值依据：两者都是**店主手动、低频**动作（保留期另有 6 小时一轮的周期扫描兜底），
  一分钟 20 / 30 次已远超任何正常操作（连点也不会超过个位数）；限流只挡脚本与重放。
*/
const erasePiiLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: '个人信息擦除请求过于频繁，请稍后再试' });
const retentionLimiter = simpleRateLimit({ windowMs: 60_000, max: 20, message: '保留期擦除运行过于频繁，请稍后再试' });

/**
 * 保留期运行的**结果复用窗口**（同一 days 的重复请求在 2 秒内直接拿上次结果）：
 * 前端超时重试/连点会让同一份重活跑第二遍，而第二遍通常什么都擦不到。
 *
 * ⚠️ 它**不是**单飞闸。真正的单飞必须在**内核**（`piiErase.runPiiRetention` 的调用方共用一条
 * in-flight 记录）：本模块与周期扫描（`startPiiRetentionSweep` 的定时器）是两个入口，
 * 路由里再放一把标志只能盖住"本端点的两次调用"，盖不住"手动那轮与定时器那轮同时在路上"，
 * 而那种情形下两边会选中同一批候选行各擦一遍（内核对第二遍返回"已擦过"，所以不会重复记账，
 * 但白跑一轮全表扫描 + 逐单事务）。复用窗口只解决"同一秒内的重复请求"。
 */
const RETENTION_REUSE_WINDOW_MS = PII_RETENTION_REUSE_MS;
let retentionLast = null; // { at:number(ms), days, data, message }

/**
 * 显式删除请求：擦除单个终局订单的个人信息（幂等；重复调用无第二次变更）。
 *
 * ⚠️ **必须是本店的订单**：`ownerOnly` 只回答"你是不是请求头那家店的店主"，
 * 而只按订单号取行 ⇒ 任一店店主可擦**别店任意终局单**的收货信息/备注/发票/陈述正文
 * 并删掉证据附件，且**不可逆**。归属判据只有一处（`src/orderScope.js`）。
 * 返回"订单不存在"而不是"不是你的单"：后者等于确认该单号存在。
 */
router.post('/orders/:orderNo/erase-pii', ownerOnly, erasePiiLimiter, wrap(async (req, res) => {
  const order = await findOrderInShop(req.params.orderNo, req.shop.code);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const r = await eraseOrderPii(order.order_no);
  // 在途单拒绝擦除（draft/escrowed/shipped/disputed 的收货信息是履约必需）——错误信息里说明出口。
  // ⚠️ 判据是结果方给的 `code`（'not_found' / 'not_terminal' = **什么也没擦**），
  // 不是"有没有 error 字段"：删盘失败（**擦了一半**）也带 error，用字段存在性判会把两种结论
  // 混成一支，那一支不下发读数——界面恰好在这一刻读不到"盘上还剩几个文件"。
  if (r.code) {
    const status = r.code === 'not_found' ? 404 : r.code === 'case_open' ? 409 : 200;
    return fail(res, r.message || '个人信息擦除失败', 1, status);
  }
  /*
    ── 成功与"擦了一半"必须**同一个形状** ────────────────────────────
    此前删盘失败走的是业务错误分支（`fail(res, …, 1)`），那个分支**不下发读数**——
    而界面（`utils/piiEraseAction.piiEraseOutcomeText`）正是按 `attachmentFilesRemaining` /
    `residual` / `alreadyErased` 三个读数决定说什么。于是最需要读数的时刻（盘上还有个人数据）
    恰恰读不到，界面只能退化成一句通用文案，还可能被读成"已擦除"。
    修法：payload 只构造一次，成功与失败走同一份字段集，差别只在 `cleanupFailed`。
  */
  const payload = {
    orderNo: r.orderNo,
    status: r.status,
    alreadyErased: !r.changed,
    erased: r.counts,
    /*
      **擦得干不干净**必须由这两个读数回答，不能由 `changed` 回答。
      `changed` 是"本次有没有改动"，而删除请求问的是"数据还在不在"：
      · `attachmentFilesRemaining`：磁盘上还剩几个附件文件（0 = 干净；<0 = 目录读不出来）；
      · `residual`：**库服务器侧**还剩什么（二进制日志是否还开着、本次擦除语句是否会把原文写进
        日志、日志保留多久）——那一段在本节点控制之外，节点删不掉，只能如实作答。
      旧实现只回 `attachmentFilesRemoved`，且它是从**恒真**的判据派生的（已修），
      于是"盘上还有文件"这件事在响应里看不出来。
    */
    attachmentFilesRemaining: r.attachmentFilesRemaining,
    /* 三态布尔（与读数同款）：true 确认删净 / false 确认没删净 / null 目录读不出来 ⇒ 不敢说。
       它与 `attachmentFilesRemaining` 一起给出，界面不必自己把残留数翻译成结论。 */
    attachmentFilesRemoved: r.attachmentFilesRemoved,
    /*
      **库服务器侧的残留读数**（`piiErase.residualReport()` 的原文，形状与措辞只在那里定义）：
      它回答"库里的那一行删掉了，但数据库自己的日志/备份里还有没有原文"。
      这一档刻意**不折成"没问题"**：读不到就是 null（见 db.js 的 serverCapabilities 同款口径），
      而节点对"更早写入的原文仍留在二进制日志里"这件事**无能为力**——不承诺、也不假装干净。
      旧响应里那个 `walTruncated` 随 SQLite 一起消失：WAL 是本地文件，截断它曾是一条真腿；
      二进制日志是数据库服务器的事，没有等价动作可做，所以只剩"如实报告"。
    */
    residual: r.residual ?? null,
    /*
      这一单是否**仍欠一次清理**（附件文件未删净）。它由内核的 `pii_cleanup_pending` 列回答，
      而那一列现在只由**附件这一条腿**驱动（库内个人数据已随事务删除；日志侧的残留删不掉，
      重试也没有意义，不参与 pending）。它是界面该看的那个结论，且三态同款：pending=true
      表示"已排队等下一轮重试"（候选判据里有 `OR pii_cleanup_pending = 1`），不是"永远不会重来"。
    */
    cleanupPending: r.cleanupPending,
    /* 清理未完成（等价于 !ok；名字说清它不只指附件索引，而是"这一单还有没做完的清理工作"） */
    cleanupFailed: !r.ok,
    /* 未清干净时原样给出原因（它比通用文案具体到是哪条腿、下一步该做什么） */
    ...(r.ok ? {} : { error: r.error }),
  };
  // 管理审计：detail 只记**计数**与来源，绝不把擦掉的内容再抄进审计表（那就等于没擦）
  await logAudit({
    req,
    actor: req.auth?.address,
    // 角色取**这家店里的**身份（漏传店铺编号会得到 'user'，而 logAudit 对 'user' 直接返回——
    // 审计行会静默消失，责任人查无此人）
    actorRole: req.shopRole && req.shopRole !== 'user' ? req.shopRole : await roleOf(req.auth?.address || '', req.shop.code),
    // 擦除的是**本店这一单**（上面 findOrderInShop 已校验归属），所以这一行归本店
    shopCode: req.shop.code,
    action: 'order.erase_pii',
    targetType: 'order',
    targetId: r.orderNo,
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
      residual: r.residual ?? null,
    },
  });
  if (!r.ok) {
    /*
      没清干净：**业务码非 0**（调用方据此知道"这次没做成"），但读数照给。
      文案直接用内核给的那句，不再在这里写死"磁盘上的附件文件没能删掉"——
      这一屏是店主判断"要不要去清目录"的唯一依据。
    */
    return fail(res, r.error || '个人信息的清理没能完成，请稍后重试', 1, 200, payload);
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
 * 单飞 + 结果复用窗口（`MK_PII_RETENTION_REUSE_MS`，默认 2 秒）见文件上方 RETENTION_REUSE_WINDOW_MS 的说明。
 */
router.post('/retention/run', hostOnly, retentionLimiter, wrap(async (req, res) => {
  let days = config.pii.retentionDays;
  const raw = req.body?.days;
  if (raw !== undefined && raw !== null && raw !== '') {
    days = Number(raw);
    if (!Number.isInteger(days) || days < 0) return fail(res, 'days 需为 ≥ 0 的整数（保留天数；0 = 关闭自动擦除）');
  }
  if (retentionLast && retentionLast.days === days && Date.now() - retentionLast.at < RETENTION_REUSE_WINDOW_MS) {
    return ok(
      res,
      { ...retentionLast.data, reused: true },
      `刚刚（${Math.max(1, Math.round((Date.now() - retentionLast.at) / 1000))} 秒内）已运行过同一强度的保留期擦除，本次复用那次结果：${retentionLast.message}`
    );
  }
  const r = await runPiiRetention({ days });
  /*
    这一行是**节点级**的（`shopCode: null`，只有节点主看得见），因为这次动作的**范围**就是节点：
    `runPiiRetention` 的候选面来自 v_orders，没有店铺条件（保留期是节点级配置
    MK_PII_RETENTION_DAYS，周期扫描同样是节点级）。挂到 `req.shop` 上会说出两句假话：
      · 归属假：这一次擦的可能全是别家店的单；
      · 读数假：`candidates/erased/...` 是**节点合计**，写进某家店的列表就是把别家店的量
        摆到它眼前看——那正好是这次要消灭的那类跨店泄露（旧形状连 action 范围都没标对）。
    各家店不会因此失去记录：被擦的每一单都单独写一行 `order.erase_pii`，那一行归**该单所属的店**
    （见 src/piiErase.js），店主的列表里看得见自己的订单被擦了。

    ⚠️ `actorRole` 由 `isHost(actor)` 现算（本路由是 hostOnly ⇒ 这里恒为 `'host'`），
    而不是写死一个字符串：节点级路由只有 host/staff 两种角色，写死的那一份一旦与中间件
    漂移就会记错责任主体（员工动作记成节点主）。也**不再取 `req.shop`**：hostOnly 之下
    请求头只是回声，节点主可以一家店都没有，把它记成"哪家店触发的"是一句假话
    （这一动从来不属于任何一家店）。`actor` 就是"谁按的这个按钮"，那才是排障要的事实。
  */
  await logAudit({
    req,
    actor: req.auth?.address,
    actorRole: (await isHost(req.auth?.address)) ? 'host' : 'staff',
    shopCode: null,
    action: 'retention.run',
    targetType: 'node',
    targetId: 'node',
    detail: { days: r.days, disabled: r.disabled, candidates: r.candidates, erased: r.erased, diskFailed: r.diskFailed, cleanupPending: r.cleanupPending, ...r.counts },
  });
  const data = {
    days: r.days,
    disabled: r.disabled,
    candidates: r.candidates,
    erased: r.erased,
    /*
      半成品的两个读数必须下发：旧实现在 `erased === 0` 时一律回
      「无到期订单（…为 0）」，而"有候选、但每一单的附件都没删净"正是 `erased === 0`
      的常见形态之一 —— 运维按 node/docs/OPERATIONS.md 先跑这个接口再归档，于是**在盘上还留着个人数据时
      被告知"没有到期订单"**。这两个数也是运维判断"要不要去清目录权限"的唯一依据。
    */
    diskFailed: r.diskFailed,
    cleanupPending: r.cleanupPending,
    truncated: r.truncated,
    counts: r.counts,
    orderNos: r.orderNos.slice(0, MAX_REPORTED_NOS),
    orderNosOmitted: Math.max(0, r.orderNos.length - MAX_REPORTED_NOS),
  };
  const message = r.disabled
    ? '自动擦除已关闭（MK_PII_RETENTION_DAYS=0）：本次未擦除任何数据；如需立即执行，请在请求体给出天数（如 {"days":180}）'
    : r.erased > 0
      ? `已擦除 ${r.erased} 个终局订单的个人信息（资金流终结且静置 > ${r.days} 天）${r.truncated ? '；本次达到单轮上限，可再次运行处理剩余订单' : ''}${r.cleanupPending > 0 ? `；另有 ${r.cleanupPending} 单只擦了一半（附件文件未删净），已排队等待下一轮重试` : ''}`
      : r.candidates > 0
        ? `本次扫到 ${r.candidates} 单到期，但一单都没能擦干净（${r.cleanupPending} 单只擦了一半：附件文件未删净）——这些单仍欠清理，已排队等待下一轮重试；若是目录权限/文件占用，请先处理附件目录`
        : `无到期订单（终局且静置 > ${r.days} 天的订单为 0）`;
  // 记下这次运行，供 2 秒内的重复请求复用（见文件上方说明）
  retentionLast = { at: Date.now(), days, data, message };
  ok(res, data, message);
}));

export default router;
