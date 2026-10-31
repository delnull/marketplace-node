/**
 * 证据附件路由（P0-2，挂 /api/orders 前缀）：
 *  POST /:orderNo/evidence/:evidenceId/files   上传（base64 JSON；白名单+魔数+配额；与 evidence 同门控）
 *  GET  /:orderNo/evidence/:evidenceId/files/:fileId  鉴权下载（图片 inline / PDF attachment）
 *
 * ⚠️ 路径段是**对外订单号 `order_no`**（URL 里的那个标识）；内部自增键只用于子表外键与磁盘目录
 * （`evidence_files.order_id`、`orderAttachDir`），不出现在任何 URL 里。
 *
 * 全局 express.json 1MB 限制对该上传路径豁免（见 app.js isFilesUpload），本路由自带 18MB 解析。
 */
import fs from 'node:fs';
import express from 'express';
import { Router } from 'express';
import { getDb } from '../db.js';
import { verifySession, roleOf, isStaff } from '../auth.js';
import { logAudit } from '../audit.js';
import { ok, fail, wrap, asyncMiddleware, bearerToken, makeAuthMiddleware, simpleRateLimit, isProdLike, clientIp } from '../http.js';
import { isArbiterForOrder } from '../chain.js';
// 确认收货后的售后案件：在途判据的唯一实现（与订单详情的仲裁人视角共用同一处判断）
import { isAfterSaleOpen } from '../afterSale.js';
import {
  storeFiles,
  fileDiskPath,
  findFileById,
  evidencePhaseError,
  MAX_BYTES_PER_ORDER,
  MAX_FILES_PER_EVIDENCE,
} from '../evidenceFiles.js';

const router = Router();
const requireAuth = makeAuthMiddleware(verifySession);
// 附件上传/下载按 IP 限流（上传先于 18MB body 解析：防未认证/认证后的大体积刷量；
// 下载防脚本化拖取——配额已按订单约束，此处挡单 IP 高频滥用）
const uploadLimiter = simpleRateLimit({ windowMs: 60_000, max: 30, message: '附件上传过于频繁，请稍后再试' });
const downloadLimiter = simpleRateLimit({ windowMs: 60_000, max: 600, message: '附件下载过于频繁，请稍后再试' });

/** 按对外单号读整张订单（**读模型视图**：事实/收货/链上镜像三表各一份，见 db.js） */
const findOrder = async (orderNo) => await getDb().get('SELECT * FROM v_orders WHERE order_no = ?', String(orderNo || ''));
const findEvidence = async (id) => await getDb().get('SELECT * FROM dispute_evidence WHERE id = ?', Number(id) || 0);

/**
 * 单请求体上限（base64 JSON 形态的天然上界：4/3 × 单附件上限 + 一点 JSON 外壳余量）。
 *
 * 为什么要有**容量**这一层闸：限流只按**次数**（30 次/分钟/IP），
 * 同一瞬间发 30 个请求会全部放行，而每个请求的 body 都要先被完整缓冲再 `JSON.parse`
 * （base64 在 V8 里是 UTF-16，常驻堆约为明文的 2 倍）⇒ 单 IP 一分钟内可造出 GB 级瞬时占用，
 * 小规格 VPS 直接被 OOM 杀掉（进程退出 = 全店不可用 + watcher 停摆漏扫）。
 * 次数限流挡不住"同一瞬间的 N 个大请求"；容量闸才挡得住。
 * 判据取自同一份配额常量（`MAX_BYTES_PER_ORDER` 是单订单累计上限），
 * 所以"能塞进一个请求的最大字节"与"一个订单最多能存多少"同源，改配额时不会两处漂移。
 */
export const FILES_BODY_LIMIT = `${MAX_BYTES_PER_ORDER}b`;

/**
 * 上传前置门控（**中间件**，刻意排在 body 解析之前）。
 *
 * 判据全部只依赖 URL 参数与 `req.auth`，与请求体无关——所以没有任何理由先收 18MB 再判。
 * 旧实现把这一整段放在 `express.json({limit:'18mb'})` **之后**：
 * 任何人自助登录（nonce+login，签名免费、无地址白名单）后，用 30 个并发的 18MB 请求
 * （甚至 order_no 根本不存在）就能让节点在解析阶段 OOM。现在不存在的订单/无权上传
 * 在**第一个字节被读进内存之前**就被拒。
 *
 * 把结果挂在 `req.evidenceCtx` 上而不是再查一遍库：判据只有一处实现，
 * 下面的 handler 直接消费它——两处各查一次必然漂移（而漂移的后果是"门控放行、
 * handler 按别的条件处理"）。
 */
const gateEvidenceUpload = asyncMiddleware(async (req, res, next) => {
  const order = await findOrder(req.params.orderNo);
  if (!order) return fail(res, '订单不存在', 404, 404);
  const evidence = await findEvidence(req.params.evidenceId);
  // 归属比较用**内部订单键**（`dispute_evidence.order_id` 就是它）——这正是"子表外键"的用处
  if (!evidence || Number(evidence.order_id) !== Number(order.order_id)) return fail(res, '证据记录不存在', 404, 404);
  /*
    ⚠️ `isStaff` 必须带**本单所属店铺**（`order.shop_code`，恒非空）：单参数形式默认 `shopCode = ''`，
    而 `roleOf('')` 恒为 `user` ⇒ 那个默认值会让**任何登录用户**在"取不到店铺编号"的路径上
    拿到 seller 角色（可给别店的证据条目追加附件）。店铺编号是订单行自己的列，这里必须用它。
  */
  const role = req.auth.address === order.buyer ? 'buyer' : (await isStaff(req.auth.address, order.shop_code || '', { force: true })) ? 'seller' : null;
  if (!role) return fail(res, '仅本单买家或店主/操作员可上传证据附件', 403, 403);
  if (role !== evidence.role) return fail(res, '只能向本人提交的证据条目追加附件', 403, 403);
  const gate = evidencePhaseError(order, evidence.phase, role);
  if (gate) return fail(res, gate.message + '（附件同证据阶段门控）', gate.code, gate.http);
  req.evidenceCtx = { order, evidence, role };
  next();
});

/**
 * 中间件顺序即安全判据（改动前先读这一段）：
 *   ① `requireAuth` —— 401 时不触发任何 body 解析；
 *   ② `uploadLimiter` —— 按 IP 的**次数**闸；
 *   ③ `gateEvidenceUpload` —— 订单/证据/角色/阶段四道判据，**只用 URL 参数**；
 *   ④ `express.json({limit: FILES_BODY_LIMIT})` —— 到这里才收字节，且容量有界。
 * 顺序反了就等于"先让陌生人把内存塞满，再决定他有没有资格"。
 */
router.post(
  '/:orderNo/evidence/:evidenceId/files',
  requireAuth,
  uploadLimiter,
  gateEvidenceUpload,
  express.json({ limit: FILES_BODY_LIMIT }),
  wrap(async (req, res) => {
  // 门控已在上面的中间件里判完（唯一实现）；这里只消费它的结论
  const { order, evidence } = req.evidenceCtx;

  const raw = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!raw.length) return fail(res, 'files 需为非空数组 [{name, mime, dataB64}]');
  /*
    **条数闸必须在 I/O 之前**：20MB body 上限只约束字节，不约束 JSON entry 数量。
    一个最小 PNG entry 约 56 字节，单个 20MB 请求可带约 30 万条；全部同步写盘后
    再被 `file_count + n <= 6` 拒掉，再同步删 30 万个文件——事件循环被占住，
    watcher/healthz 一起停。这里先按同一常量拒掉，和 storeFiles 的配额读取同一个上限。
  */
  if (raw.length > MAX_FILES_PER_EVIDENCE) {
    return fail(res, `单条陈述至多 ${MAX_FILES_PER_EVIDENCE} 个附件（本次 ${raw.length} 个）——请在客户端先裁剪`);
  }
  /*
    配额（单条陈述 ≤6 个 / ≤20MB、单订单累计 ≤20MB）**只在 `storeFiles` 里判一次**：
    那两处判据分别是 `dispute_evidence` 上的条件 UPDATE（越界在语句自己身上失败）与一次
    订单级合计，且都在写事务（全局写锁）之内。路由再数一遍的后果是"一侧拒了、另一侧照收"
    （本仓已有的教训）——而且路由的读发生在事务之外，数与写之间还有窗口。
  */
  try {
    const created = await storeFiles({
      // 内部订单键：evidence_files.order_id 是它的外键，附件目录名也是它（见 evidenceFiles.js 文件头）
      orderId: order.order_id,
      // 证据行**整行**传入（不是只传 id）：storeFiles 用它的 order_id 断言归属不变量
      evidence,
      files: raw,
    });
    await logAudit({
      req,
      actor: req.auth?.address,
      // 角色按**本单所属店铺**算（漏传店铺编号 → 'user' → logAudit 直接返回，审计行静默消失）
      actorRole: await roleOf(req.auth?.address || '', order.shop_code || ''),
      // 归属 = 这一单所属的店（不是请求头指向的店）：附件是**订单**的证据，别家店主看不到
      shopCode: order.shop_code || '',
      action: 'evidence.upload',
      targetType: 'evidence',
      targetId: String(evidence.id),
      detail: { orderNo: order.order_no, files: created.length, bytes: created.reduce((a, f) => a + f.size, 0) },
    });
    ok(res, { uploaded: created }, '附件已上传（sha256 已登记，可在详情时间线查看）');
  } catch (e) {
    /*
      不要把 fs/db 的原始异常原文直接回给客户端：`fs.writeFileSync`
      的 message 含**服务器绝对路径**（`ENOENT: no such file or directory, open '/srv/…/x.png'`），
      而且这里连服务端日志都没留——正是 http.js 要消灭的那种"用户看得见内部细节、运维却看不见"。
      校验类/配额类失败（`expose: true`，消息是我们自己写的）照常原样回：那是用户可以自行修复的输入问题。
      其余：详情进服务端日志，响应按 `isProdLike()` 给通用文案（开发环境保留原文便于定位）。
    */
    console.error('[evidenceFiles] 附件保存失败:', e?.message || e);
    if (e?.expose) return fail(res, e.message);
    const detail = isProdLike() ? null : String(e?.message || '');
    fail(res, detail || '附件保存失败（服务器无法写入附件目录，请联系店铺运维）');
  }
}));

/**
 * 附件下载的**统一 404**：存在性与权限不再可区分。
 *
 * 旧形状是"订单/证据/文件不存在 ⇒ 404，存在但无权 ⇒ 403"——于是 403 本身成了确认器：
 * 匿名/第三人可以用它证明"某单 + 某证据 + 某附件确实存在"（order_no 不可枚举，
 * 但它会出现在分享链接、日志、前端缓存里）。`orderScope.js` 已有口径：
 * "没有这一单"与"这一单不是你的"必须回同一个 null/404，全仓不该有第二种回答。
 *
 * 拒因（哪一段不存在、谁无权）只进服务端日志——运维据此排查；响应体与"确实不存在"
 * 逐字相同。**有权者不受影响**：权限通过之后的失败（如文件被清理）仍带可读原因，
 * 见下面 `fileDiskPath` 分支。
 */
const DOWNLOAD_NOT_FOUND = '附件不存在';

function denyDownload(req, res, reason) {
  console.warn(
    `[evidenceFiles] 附件下载拒绝（统一 404）：${reason}；order=${String(req.params.orderNo)} ` +
      `evidence=${String(req.params.evidenceId)} file=${String(req.params.fileId)} ip=${clientIp(req)}`
  );
  return fail(res, DOWNLOAD_NOT_FOUND, 404, 404);
}

/**
 * 鉴权下载：可见矩阵与 evidence 一致（buyer/owner；arbiter 仅 disputed 或**有在途售后案件**）；
 * 文件归属逐级校验（订单 → 证据条目 → 附件）。所有"不存在/无权"一律同一个 404（见 denyDownload）。
 */
router.get('/:orderNo/evidence/:evidenceId/files/:fileId', downloadLimiter, wrap(async (req, res) => {
  const order = await findOrder(req.params.orderNo);
  if (!order) return denyDownload(req, res, '订单不存在');
  const evidence = await findEvidence(req.params.evidenceId);
  // 归属比较用**内部订单键**（`dispute_evidence.order_id` 就是它）
  if (!evidence || Number(evidence.order_id) !== Number(order.order_id)) {
    return denyDownload(req, res, '证据记录不存在或不属于该订单');
  }
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) return denyDownload(req, res, '附件 id 非法');
  const file = await findFileById(fileId);
  if (!file || Number(file.evidence_id) !== Number(evidence.id)) {
    return denyDownload(req, res, '附件不存在或不属于该证据');
  }
  const token = bearerToken(req);
  let auth = null;
  try {
    auth = token ? await verifySession(token) : null;
  } catch {
    auth = null;
  }
  let allowed = false;
  if (auth) {
    if (auth.address === order.buyer || (await isStaff(auth.address, order.shop_code || '', { force: true }))) allowed = true;
    /*
      仲裁人：争议单（disputed）**或**确认收货后有在途售后案件的终局单——
      后者是契约 2026-10 第二批的裁决面：案件由仲裁人结案、罚没（Staking.penalize）的资格门槛
      就是"案件在链上处于开启状态"，所以他必须能读到双方 after_sale 陈述的附件。
      判据与订单详情的 `as='arbiter'`（routes/orders.js）**同一处**：afterSale.isAfterSaleOpen。
      案件结案后立即收回（与 disputed 终局后收回同口径）。
      `isArbiterForOrder()` 在**委员会读不到**时恒 false（"不知道现在是谁"）⇒ 拒绝下载
      （2026-10-14：此前它会回退上次成功值——轮换过仲裁人之后，旧密钥在 RPC
      故障期间仍能下载收货信息与售后附件，而注释写的安全方向恰恰相反）。
      2026-10：判据只认**当前委员会名单**（不再按订单快照届次）：换届/吊销后旧成员立即
      失去资格，当前成员可以处理旧单。
      `force:true`（本轮）：这是读 PII 的路径，换届/撤权的链上事件到达后缓存里的旧名单
      不能继续放行；订单级快照之外的回退（epoch=0）必须现读当前届。
    */
    else if ((order.status === 'disputed' || isAfterSaleOpen(order)) && (await isArbiterForOrder(auth.address, order.escrow_order_id, { force: true }))) allowed = true;
  }
  // 注意：这里**不能**回 403——匿名/第三人要拿到的与"不存在"是同一个 404（见 denyDownload）；
  // 谁被拒、为什么被拒只写日志。
  if (!allowed) {
    return denyDownload(
      req,
      res,
      auth
        ? `无权：actor=${String(auth.address || '')}（需买家本人/店主/操作员/争议或售后案件的仲裁人）`
        : '匿名或令牌无效'
    );
  }

  const disk = fileDiskPath(file);
  // 权限已通过：这里的失败原因对调用方是可读的（他确实有权知道"文件被清理了"）
  if (!disk) return fail(res, '附件文件缺失（存储可能被清理）', 404, 404);
  const isImage = file.mime.startsWith('image/');
  res.setHeader('Content-Type', file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 敏感证据内容：禁止任何缓存（含私有缓存）
  res.setHeader('Cache-Control', 'private, no-store');
  // RFC 6266：ASCII fallback + filename*（UTF-8 中文文件名正确显示）
  res.setHeader(
    'Content-Disposition',
    `${isImage ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.filename)}`
  );
  fs.createReadStream(disk).on('error', () => {
    if (!res.headersSent) fail(res, '附件读取失败', 1, 500);
    else res.end();
  }).pipe(res);
}));

export default router;
