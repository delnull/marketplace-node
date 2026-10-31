/**
 * 个人信息擦除 + 保留期（PIPL 式删除请求）单测：
 *  - POST /api/shop/orders/:id/erase-pii（ownerOnly）：终局才可擦、幂等、返回计数不返回内容；
 *  - 擦除后金额/状态/链上托管单号/支付凭证/事件史/评价（无 PII）必须原样保留；
 *  - 证据附件：DB 行与磁盘文件一并删除（只删行 = 数据还在磁盘上，是最常见的假删除）；
 *  - 审计：action=order.erase_pii 落表，detail 只有计数（不得把擦掉的内容抄进审计）；
 *  - 保留期：runPiiRetention 只碰"终局且静置超过阈值"的订单；days=0 = 关闭；
 *    POST /api/shop/retention/run 为同一实现的 **hostOnly** 手动入口（擦的是全节点到期的单，
 *    所以只有节点主能触发——别家店的店主不行，那条越权用第二家店的店主钉着）；周期扫描接线可用。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload, shopRef, orderIdOf } from './setup.mjs';

// 附件目录（独立临时目录；擦除用例要验证"磁盘文件真的没了"，不能用共享目录）
process.env.MK_ATTACH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-pii-'));

/*
  **保留期运行的结果复用窗口拉长到 60 秒**（默认 2 秒，见 config 的 PII_RETENTION_REUSE_MS）：
  "复用上次结果"那条用例在两次请求之间还要造一张新的到期单（建草稿 → 托管 → 应用链上事件 →
  改时间），那段准备在共享 MySQL 上可能超过 2 秒 —— 于是断言会因为**用例自己的准备耗时**
  随机变红，与产品行为无关（本会话实测踩到一次：769 例里就它一条红）。
  拉长窗口之后，那条判据只回答"复用机制在不在"，不回答"这台机器多快"。
  ⚠️ 必须设在 `makeCtx()`（它会装配 app、读 config）**之前**。
*/
process.env.MK_PII_RETENTION_REUSE_MS = '60000';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const operator = Wallet.createRandom();

const { applyEvent } = await import('../src/escrowWatcher.js');
const { eraseOrderPii, runPiiRetention, startPiiRetentionSweep, PII_TOMBSTONE, PII_ERASABLE_STATUS, PII_PROTECTED_STATUS } = await import('../src/piiErase.js');
// ORDER_STATUS：可擦 ∪ 受保护必须等于全部状态（本文件末尾的用例拿它对拍）
const { ORDER_STATUS } = await import('../src/orderStatus.js');
const { PII_RETENTION_DAYS, default: appConfig } = await import('../src/config.js');

let ownerToken;
let buyerToken;
let operatorToken;

/**
 * 第二家店的编号：用来拿一个"只经营自己那家店、但不是节点主"的店主（见 retention/run 那条用例）。
 * ⚠️ 必须落在 `node/src/shopCode.js` 的字母表里（`0-9 A-Z` 去掉易混的 `I/L/O/U`）——
 * 写成含 `O` 的编号会被 `isShopCodeShape` 拒掉，请求头因此解析不到（404），
 * 于是一条本该 403 的越权用例会以 404 通过，看起来还挺像"挡住了"。
 */
const NON_HOST_SHOP_CODE = '0000NTHST';

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  operatorToken = (await login(ctx, operator)).token;
  // 店员（operator）：能做发货/退款，但删除个人信息是不可逆的店主级动作
  const r = await request(app)
    .put('/api/shop/staff')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ action: 'add', address: operator.address })
    .expect(200);
  assertOk(r);
});

let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

const pngBytes = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8, 1)]);

async function listProduct(payload) {
  const res = await request(app).post('/api/products').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send(payload).expect(200);
  assertOk(res);
  return res.body.data;
}

async function createDraft(slug, extra = {}) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, ...extra })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 本地镜像"买家已托管"（链上校验不在单测范围，仅置状态与凭证） */
  async function escrowed(order) {
    await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), order.id);
    await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', payHash(), order.id);
  }

/** 把订单静置 days 天（保留期扫描以 updated_at 为锚点）；参数是**对外订单号** */
  async function ageOrder(orderNo, days) {
    await db.run('UPDATE orders SET updated_at = ? WHERE order_no = ?', new Date(Date.now() - days * 86_400_000), orderNo);
  }

  /** 按**对外订单号**读整单（读模型把三张表合起来读） */
  const rowOf = async (orderNo) => await db.get('SELECT * FROM v_orders WHERE order_no = ?', orderNo);
  // 子表外键要的是**内部主键**：接口给的订单号先转一次（见 setup.mjs 的 orderIdOf）
  const orderIdOfNo = async (orderNo) => await orderIdOf(db, orderNo);
  const attachRows = async (orderNo) => await db.all('SELECT * FROM evidence_files WHERE order_id = ?', await orderIdOfNo(orderNo));
  const evidenceRows = async (orderNo) => await db.all('SELECT * FROM dispute_evidence WHERE order_id = ? ORDER BY id ASC', await orderIdOfNo(orderNo));
/*
  ⚠️ 目录名是**内部订单键**（`evidence_files.order_id` 那个值），不是对外单号——
  附件目录直接用文件行里的外键，于是下载/擦除都不用 JOIN。
  传单号进来不会报错，只会指向一个不存在的目录 ⇒ 断言变成"文件不存在"，
  看起来像"文件被删了/没落盘"，实际是路径拼错了。
*/
const diskPath = (orderId, storedName) => path.join(process.env.MK_ATTACH_DIR, String(orderId), storedName);

const eraseViaApi = (orderId, token = ownerToken) =>
  request(app).post(`/api/shop/orders/${orderId}/erase-pii`).set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value).send({});

/** 见证"已收款 + 有售后陈述 + 有附件"的订单（附件只能挂在退款申请阶段） */
async function draftWithEvidenceAndFile(slug, shipping, note, title) {
  const order = await createDraft(slug, { shipping, note });
  await escrowed(order);
  assert.equal(await applyEvent('RefundRequested', { orderId: order.escrowOrderId }), 1);
  const ev = await request(app)
    .post(`/api/orders/${order.id}/evidence`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ phase: 'refund_request', content: `${title}：收到的货与描述不符` })
    .expect(200);
  assertOk(ev);
  const evId = ev.body.data.evidenceId;
  const up = await request(app)
    .post(`/api/orders/${order.id}/evidence/${evId}/files`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ files: [{ name: 'receipt.png', mime: 'image/png', dataB64: pngBytes().toString('base64') }] })
    .expect(200);
  assertOk(up);
  const stored = (await attachRows(order.id))[0].stored_name;
  assert.ok(fs.existsSync(diskPath(await orderIdOfNo(order.id), stored)), '上传后附件文件应落盘');
  return { order, evId, stored };
}

test('erase-pii：在途单拒绝；终局擦除（含附件行与磁盘文件）；金额/托管单号/凭证/事件史/评价保留；重复调用幂等', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 擦除实物商品' }));
  const { order, evId, stored } = await draftWithEvidenceAndFile(
    p.slug,
    { name: '张三', phone: '13800000000', address: '北京市朝阳区某路 1 号 101 室' },
    '请放门口，到达前电话联系',
    '开箱不符'
  );
  const beforeRow = await rowOf(order.id);
  assert.equal(beforeRow.shipping_name, '张三');
  assert.equal(beforeRow.note, '请放门口，到达前电话联系');

  // ── 在途（escrowed）：拒绝擦除——卖家还得靠收货信息发货 ──
  const inflight = await eraseViaApi(order.id);
  assert.notEqual(inflight.body.code, 0);
  assert.match(inflight.body.message, /资金流未终结/);
  assert.equal((await rowOf(order.id)).shipping_name, '张三', '在途单的收货信息必须原样保留');

  // 匿名 / 店员均不可擦（ownerOnly）
  const anon = await request(app).post(`/api/shop/orders/${order.id}/erase-pii`).send({}).expect(401);
  assert.notEqual(anon.body.code, 0);
  const staff = await eraseViaApi(order.id, operatorToken);
  assert.equal(staff.status, 403);

  // ── 终局：买家确认收货（confirmed）+ 提交评价（无 PII，擦除后必须保留）──
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 7 }), 1);
  const rev = await request(app)
    .post(`/api/orders/${order.id}/review`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ rating: 5, content: '沟通顺畅' })
    .expect(200);
  assertOk(rev);

  // 擦除前的终局快照：擦除只许动 PII，账目/链上凭证/状态一个字段都不许变
  const preErase = await rowOf(order.id);
  const res = await eraseViaApi(order.id);
  assertOk(res);
  assert.equal(res.body.data.alreadyErased, false);
  /*
    计数是**按行**的（`{shippingRows, evidenceContents, attachmentRows, attachmentFiles}`）：
    擦除 = 删掉 `order_shipping` 那一行，于是"收货人/电话/地址/备注擦没擦"这个问题不存在了
    ——行要么在、要么不在。`shippingRows: 1` 比旧的 `shippingFields: 4` 更强（它可证明）：
    旧形状靠"六个列各改一次"，漏一列就是静默留下的个人数据；行数拼不出第三种可能。
    代价如实写：`invoiceFields` 这个读数**整体消失**——抬头/税号与收货信息同住那一行，
    行删了就一起没了，"擦了几项开票信息"无从单独计数（也不需要：行没了就是没了）。
  */
  assert.deepEqual(res.body.data.erased, {
    shippingRows: 1,
    claimPii: 0,
    evidenceContents: 1,
    attachmentRows: 1,
    attachmentFiles: 1,
    reviewImages: 0,
  });
  // 响应只给计数，不给被擦除的内容（否则等于把 PII 又发了一遍）
  assert.ok(!JSON.stringify(res.body).includes('张三'), '响应不得回显被擦除的内容');
  assert.ok(!JSON.stringify(res.body).includes('13800000000'), '响应不得回显被擦除的字段值');

  // ── 数据面：PII 没了，账目/链上凭证/评价一个不少 ──
  const after = await rowOf(order.id);
  // 擦除 = 删掉 order_shipping 那一行：读回来是 NULL（旧形状是把六列都改成空串，
  // 于是"擦过了"与"本来就填的空"在库里同形——新形状让承诺可证明）
  assert.equal(after.shipping_name, null);
  assert.equal(after.shipping_phone, null);
  assert.equal(after.shipping_address, null);
  assert.equal(after.note, null);
  assert.equal(after.status, preErase.status, '状态不变（终态）');
  assert.equal(after.amount_wei, preErase.amount_wei, '金额保留（账目不可删）');
  assert.equal(after.escrow_order_id, preErase.escrow_order_id, '链上托管单号保留');
  assert.equal(after.paid_tx_hash, preErase.paid_tx_hash, '支付凭证哈希保留');
  assert.equal(after.refunded_amount_wei, preErase.refunded_amount_wei);
  // `onchain_events` 是 `order_chain.events`（JSON 列）：驱动读回来**已是数组**，不再 JSON.parse
  assert.ok((after.onchain_events || []).length >= 2, '链上事件史保留（OrderCreated + 确认）');
  assert.equal((await db.get('SELECT COUNT(*) AS c FROM reviews WHERE order_id = ?', await orderIdOfNo(order.id))).c, 1, '评价（无 PII）保留');

  /*
    擦除是**终态**：不能再通过评价/追评/评价图把新的个人信息写回同一订单。
    旧实现只在 evidence 路径挡了"擦后重写"，评价三入口都能绕过删除承诺并把图片重新公开落盘。
  */
  const reviewAfterErase = await request(app)
    .post(`/api/orders/${order.id}/review`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ rating: 4, content: '擦除后又写回' });
  assert.notEqual(reviewAfterErase.body.code, 0, '擦除后不得再提交评价');
  const followupAfterErase = await request(app)
    .post(`/api/orders/${order.id}/review/followup`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ content: '擦除后又追评' });
  assert.notEqual(followupAfterErase.body.code, 0, '擦除后不得再追评');
  const imageAfterErase = await request(app)
    .post(`/api/orders/${order.id}/review/images`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .set('Content-Type', 'image/png')
    .send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.notEqual(imageAfterErase.body.code, 0, '擦除后不得再上传评价图');
  assert.equal((await db.get('SELECT COUNT(*) AS c FROM reviews WHERE order_id = ?', await orderIdOfNo(order.id))).c, 1, '评价行数量不变');

  // 陈述行保留（时间线事实），只有正文换成墓碑
  const evRows = await evidenceRows(order.id);
  assert.equal(evRows.length, 1, '陈述行不删（谁在何时提交过是争议事实）');
  assert.equal(evRows[0].content, PII_TOMBSTONE);
  assert.equal(evRows[0].role, 'buyer');
  assert.equal(evRows[0].phase, 'refund_request');

  // 附件行与磁盘文件都消失
  assert.equal((await attachRows(order.id)).length, 0, '附件行已删除');
  assert.equal(fs.existsSync(diskPath(await orderIdOfNo(order.id), stored)), false, '磁盘文件已删除（不能只删行）');

  // 审计入账：detail 只有计数与来源
  const audit = await db.get("SELECT * FROM audit_logs WHERE action = 'order.erase_pii' AND target_id = ? ORDER BY id DESC LIMIT 1", order.id);
  assert.ok(audit, '擦除必须写审计');
  // `audit_logs.detail` 是 JSON 列：驱动读回来已是对象（旧形状是 TEXT，得自己 JSON.parse）
  const detail = audit.detail;
  assert.equal(detail.trigger, 'request');
  assert.equal(detail.shippingRows, 1);
  assert.equal(detail.attachmentRows, 1);
  assert.ok(!JSON.stringify(detail).includes('张三'), '审计 detail 不得含被擦除的内容');
  // 显式删除请求是**本店**的动作（端点是 ownerOnly + findOrderInShop 保证本单属于本店）
  assert.equal(audit.shop_code, shopRef.value, '显式擦除的行归本店');

  // ── 幂等：重复调用不报错、不重复计数、不再产生变更 ──
  const again = await eraseViaApi(order.id);
  assertOk(again);
  assert.equal(again.body.data.alreadyErased, true);
  assert.deepEqual(again.body.data.erased, {
    shippingRows: 0,
    claimPii: 0,
    evidenceContents: 0,
    attachmentRows: 0,
    attachmentFiles: 0,
    reviewImages: 0,
  });
  assert.equal((await evidenceRows(order.id))[0].content, PII_TOMBSTONE);
});

test('erase-pii：终局 NFT 提货声明的收货信息同事务清空；在途声明拒绝整单擦除', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 提货声明商品' }));
  const order = await createDraft(p.slug, { shipping: { name: '张三', phone: '13800000000', address: '北京市朝阳区某路 1 号' } });
  await escrowed(order);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 9 }), 1);
  const internalId = await orderIdOfNo(order.id);
  const insertClaim = async (claimNo, tokenId, status) => {
    await db.run(
      `INSERT INTO nft_claims
        (claim_no, shop_code, product_id, product_slug, order_id, order_no, seller,
         token_contract, token_id, claimant, status, shipping_name, shipping_phone, shipping_address, note)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, '张三', '13800000000', '北京市朝阳区某路 1 号', '放门口')`,
      claimNo,
      order.shopCode,
      order.productSlug,
      internalId,
      order.id,
      order.seller.toLowerCase(),
      '0x' + 'ab'.repeat(20),
      String(tokenId),
      order.buyer.toLowerCase(),
      status
    );
  };

  await insertClaim('C' + '1'.repeat(20), '1', 'fulfilled');
  const term = await eraseViaApi(order.id);
  assertOk(term);
  assert.equal(term.body.data.erased.claimPii, 1);
  const claim = await db.get("SELECT * FROM nft_claims WHERE claim_no = ?", 'C' + '1'.repeat(20));
  assert.equal(claim.shipping_name, '');
  assert.equal(claim.shipping_phone, '');
  assert.equal(claim.shipping_address, '');
  assert.equal(claim.note, '');
  assert.equal(claim.reject_reason, '');

  // 另一单：在途 claim 的地址正在用于履约，不能把订单那一行删掉后报“已擦干净”
  const order2 = await createDraft(p.slug, { shipping: { name: '李四', phone: '13900000000', address: '上海市某路 2 号' } });
  await escrowed(order2);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: order2.escrowOrderId }, { txHash: payHash(), block: 10 }), 1);
  await db.run(
    `INSERT INTO nft_claims
      (claim_no, shop_code, product_id, product_slug, order_id, order_no, seller,
       token_contract, token_id, claimant, status, shipping_name, shipping_phone, shipping_address, note)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '2', ?, 'requested', '李四', '13900000000', '上海市某路 2 号', '')`,
    'C' + '2'.repeat(20),
    order2.shopCode,
    order2.productSlug,
    await orderIdOfNo(order2.id),
    order2.id,
    order2.seller.toLowerCase(),
    '0x' + 'cd'.repeat(20),
    order2.buyer.toLowerCase()
  );
  const blocked = await eraseViaApi(order2.id);
  assert.notEqual(blocked.body.code, 0);
  assert.match(blocked.body.message, /在途的 NFT 提货声明/);
  assert.equal((await rowOf(order2.id)).shipping_name, '李四', '在途 claim 的地址不能只删订单副本');
  assert.equal((await db.get("SELECT * FROM nft_claims WHERE claim_no = ?", 'C' + '2'.repeat(20))).shipping_name, '李四');
});

test('erase-pii：附件行已删但磁盘残留孤儿文件时，重复调用仍会清掉目录（幂等自愈）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 孤儿附件商品' }));
  const { order, stored } = await draftWithEvidenceAndFile(p.slug, { name: '李四', phone: '13900000000', address: '上海市某路 2 号' }, '备注', '孤儿');
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 8 }), 1);
  // 模拟"上次调用删了 DB 行、删文件阶段失败"：手工删行、留文件
  await db.run('DELETE FROM evidence_files WHERE order_id = ?', await orderIdOfNo(order.id));
  assert.ok(fs.existsSync(diskPath(await orderIdOfNo(order.id), stored)));
  const res = await eraseViaApi(order.id);
  assertOk(res);
  assert.equal(res.body.data.erased.attachmentRows, 0, '已无附件行');
  assert.equal(res.body.data.erased.attachmentFiles, 1, '孤儿文件仍被本次调用清掉');
  assert.equal(fs.existsSync(diskPath(await orderIdOfNo(order.id), stored)), false);
});

test('保留期：终局且静置超过阈值才擦；在途与未到期一律不动；days=0 = 关闭', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 保留期商品' }));
  // ① 终局 + 超期（200 天）：应被擦
  const stale = await createDraft(p.slug, { shipping: { name: '王五', phone: '13700000000', address: '广州市某路 3 号' }, note: '超期单' });
  await escrowed(stale);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: stale.escrowOrderId }, { txHash: payHash(), block: 9 }), 1);
  await ageOrder(stale.id, 200);
  // ② 终局但未超期（刚更新）：不擦
  const fresh = await createDraft(p.slug, { shipping: { name: '赵六', phone: '13600000000', address: '深圳市某路 4 号' }, note: '新单' });
  await escrowed(fresh);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: fresh.escrowOrderId }, { txHash: payHash(), block: 10 }), 1);
  // ③ 在途（escrowed）且极旧：不擦（卖家要按地址发货）
  const inflight = await createDraft(p.slug, { shipping: { name: '钱七', phone: '13500000000', address: '杭州市某路 5 号' }, note: '在途单' });
  await escrowed(inflight);
  await ageOrder(inflight.id, 400);

  const rowBeforeErase = await rowOf(stale.id);
  const r = await runPiiRetention({ days: 180 });
  assert.equal(r.erased, 1);
  // 对外回的是**订单号**（`orderNos`），不是内部主键：保留期是对"用户认得的那个单号"的承诺
  assert.deepEqual(r.orderNos, [stale.id], '只有终局且静置 > 180 天的订单被擦');
  assert.equal(r.candidates, 1, '在途单不进候选（SQL 层已按终局状态过滤）');
  assert.equal(r.counts.shippingRows, 1, '擦除的计数按**行**：这一单的个人信息行被删掉了');
  assert.equal((await rowOf(stale.id)).shipping_name, null);
  assert.equal((await rowOf(fresh.id)).shipping_name, '赵六', '未到期订单保留');
  assert.equal((await rowOf(inflight.id)).shipping_name, '钱七', '在途订单保留');
  assert.equal((await rowOf(inflight.id)).note, '在途单');
  // 保留期擦除逐单入审计（detail.trigger 区分来源）
  const audit = await db.get("SELECT * FROM audit_logs WHERE action = 'order.erase_pii' AND target_id = ? ORDER BY id DESC LIMIT 1", stale.id);
  assert.ok(audit, '保留期擦除同样入审计');
  assert.equal(audit.detail.trigger, 'retention', 'detail 是 JSON 列，驱动读回来已是对象');
  /*
    归属 = **被擦那一单所属的店**（不是"谁触发的"，也不是节点级）：保留期扫描是节点级动作，
    但它擦的是某家店的订单——那家店的店主必须在自己那份审计里看得见。挂成节点级就等于
    把这件事从受影响那家店的视野里拿掉（一轮扫全节点，各家店一无所知）。
  */
  assert.equal(audit.shop_code, shopRef.value, '保留期擦除的行归**被擦那一单所属的店**');

  /*
    幂等：已擦净的行**写的是 pii_erased_at**（擦除锚点），`updated_at` 一个字节都不动——
    两者都要断言，因为旧实现正是靠刷新 updated_at 实现幂等的，而那会让一笔 200 天前的成交额
    重新落进"最近 30 天"的报表窗口（见下一条用例）。
    时间列是 DATETIME(3) → 读回来是 `Date`：比较时刻用 `.getTime()`（两个 Date 实例永远不 `==`）。
  */
  const erasedRow = await rowOf(stale.id);
  assert.ok(erasedRow.pii_erased_at instanceof Date && erasedRow.pii_erased_at.getTime() > 0, '擦除必须写 pii_erased_at 作为保留期锚点');
  assert.equal(
    erasedRow.updated_at.getTime(),
    rowBeforeErase.updated_at.getTime(),
    '擦除不得改写 updated_at（入账/争议起始时刻的口径）'
  );
  const second = await runPiiRetention({ days: 180 });
  assert.equal(second.erased, 0);
  assert.equal(second.candidates, 0, '擦过的单不再进候选（锚点仍是擦除时刻，不会重复占批量上限）');

  // 0 = 关闭（MK_PII_RETENTION_DAYS=0 的语义）：不扫描、不擦除
  const off = await runPiiRetention({ days: 0 });
  assert.equal(off.disabled, true);
  assert.equal(off.erased, 0);
  assert.equal(off.candidates, 0);
  // 非法天数直接抛（路由层另有校验）
  await assert.rejects(async () => await runPiiRetention({ days: -1 }), /保留期天数无效/);

  // 配置默认值：MK_PII_RETENTION_DAYS 未设置 → 180 天
  assert.equal(PII_RETENTION_DAYS, 180, '默认保留期为 180 天');
  // 擦除面与保护面互斥且覆盖全部订单状态：日后新增状态时必须显式决定它属于哪一侧
  const ALL_STATUS = ['draft', 'escrowed', 'shipped', 'confirmed', 'disputed', 'settled', 'refunded', 'expired', 'cancelled'];
  assert.deepEqual([...PII_ERASABLE_STATUS, ...PII_PROTECTED_STATUS].sort(), [...ALL_STATUS].sort());
  assert.ok(PII_ERASABLE_STATUS.includes('refunded'));
  assert.ok(!PII_ERASABLE_STATUS.includes('escrowed'), '在途状态不可擦');
});

test('保留期擦除不得把旧成交额挪进近期报表窗口（入账口径 = updated_at，2026-09 复审修复）', async () => {
  /*
    业务危害（源码评审 2026-09，P1）：流水页 / 看板 GMV / 趋势日桶 / ledger.csv 全按
    `orders.updated_at` 分窗（routes/orders.js 的 INCOME_STATUS 窗口、stats.js、routes/export.js）。
    旧实现在保留期扫描里把 `updated_at` 刷成擦除当天，于是一笔 200 天前的成交额会在被擦那个月
    **重新落进"最近 30 天"**，同一笔钱跨月各出现一次——不报错，只是对不上账。
    这里直接按"最近 30 天入账窗口"的判据断言擦除前后口径不变。
  */
  const p = await listProduct(productPayload({ kind: 'physical', title: '入账口径商品' }));
  const o = await createDraft(p.slug, { shipping: { name: '吴九', phone: '13300000000', address: '南京市某路 7 号' }, note: '入账口径单' });
  await escrowed(o);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: o.escrowOrderId }, { txHash: payHash(), block: 12 }), 1);
  await ageOrder(o.id, 200); // 200 天前终局（入账时刻）

  // 与 routes/orders.js 的流水窗口同判据：终局状态 + updated_at >= 窗口起点
  const win30 = Date.now() - 30 * 86_400_000;
  const inIncomeWindow = async (id) =>
    !!await db.get("SELECT 1 FROM v_orders WHERE order_no = ? AND status IN ('confirmed','settled','expired') AND updated_at >= ?", id, new Date(win30));
  assert.equal(await inIncomeWindow(o.id), false, '200 天前的成交不该落在最近 30 天窗口');

  const r = await runPiiRetention({ days: 180 });
  assert.deepEqual(r.orderNos, [o.id], '该单应被保留期扫描命中');
  assert.equal(await inIncomeWindow(o.id), false, '擦除后它仍然不在最近 30 天窗口（旧实现在这里会变成 true）');

  // 反向断言：入账时刻确实没被动过（而不是"窗口查询恰好没命中"）
  const row = await db.get('SELECT updated_at, created_at, pii_erased_at FROM v_orders WHERE order_no = ?', o.id);
  assert.ok(row.updated_at.getTime() < win30, 'updated_at 仍是 200 天前那一刻');
  assert.ok(row.pii_erased_at.getTime() > win30, '锚点列是"刚刚擦除"，与账目列互不干扰');
});

test('POST /api/shop/retention/run：hostOnly；缺省用配置阈值；可显式覆盖天数；入审计', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 保留期端点商品' }));
  const order = await createDraft(p.slug, { shipping: { name: '孙八', phone: '13400000000', address: '成都市某路 6 号' }, note: '端点保留期单' });
  await escrowed(order);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 11 }), 1);
  await ageOrder(order.id, 30); // 30 天：按默认 180 天不动，按显式 7 天该擦

  const anon = await request(app).post('/api/shop/retention/run').send({}).expect(401);
  assert.notEqual(anon.body.code, 0);
  const staff = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${operatorToken}`).set('X-Mk-Shop', shopRef.value).send({}).expect(403);
  assert.notEqual(staff.body.code, 0);
  /*
    ⚠️ 下面这条**才是**把 hostOnly 与 ownerOnly 分开的判据。

    `ownerToken` 同时是节点主**和**本店店主，所以它在两种权威下都会 200 —— 只用它测，
    这条越权在**改前改后都一样绿**（这正是它此前静默存在的原因：没有任何用例会因此变红）。
    要证明"权威随作用域"，必须拿一个**只经营自己那家店、但不是节点主**的店主来试：
    旧形状下他一次请求就能让**别家店**的到期个人信息立刻被擦掉，现在应当 403。
  */
  const nonHostOwner = Wallet.createRandom();
  await db.run(
    `INSERT INTO shops (code, seller, name, notice, listed) VALUES (?, ?, '', '', 1)
     ON DUPLICATE KEY UPDATE seller = seller`,
    NON_HOST_SHOP_CODE,
    nonHostOwner.address.toLowerCase()
  );
  const nonHostToken = (await login(ctx, nonHostOwner)).token;
  const notHost = await request(app)
    .post('/api/shop/retention/run')
    .set('Authorization', `Bearer ${nonHostToken}`)
    .set('X-Mk-Shop', NON_HOST_SHOP_CODE)
    .send({})
    .expect(403);
  assert.notEqual(notHost.body.code, 0, '节点级擦除只能由节点主触发：别家店的店主不能让别人家的个人信息提前消失');

  // 缺省阈值 = config.pii.retentionDays（测试环境 = 180）
  const def = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send({}).expect(200);
  assertOk(def);
  assert.equal(def.body.data.days, 180);
  assert.equal(def.body.data.erased, 0);
  assert.equal((await rowOf(order.id)).shipping_name, '孙八', '30 天 < 180 天：不擦');

  // 显式收紧到 7 天：同一订单立刻到期
  const run = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send({ days: 7 }).expect(200);
  assertOk(run);
  assert.equal(run.body.data.days, 7);
  assert.equal(run.body.data.erased, 1);
  assert.deepEqual(run.body.data.orderNos, [order.id]);
  assert.equal(run.body.data.counts.shippingRows, 1);
  assert.equal((await rowOf(order.id)).shipping_name, null);
  assert.equal((await rowOf(order.id)).status, 'confirmed', '终态与账目不变');

  // 非法天数拒绝
  const bad = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send({ days: -1 }).expect(200);
  assert.notEqual(bad.body.code, 0);
  // 手动运行本身入审计（action=retention.run）
  /*
    ⚠️ 这条断言在 2026-10-16 加了店铺维度之后**改了结论**（不是放宽）：`retention.run` 是
    **节点级**动作——`runPiiRetention` 的候选面没有店铺条件（保留期是节点级配置，周期扫描同样是
    节点级），所以这一行 `shop_code IS NULL`、只有节点主看得见，`target_type/target_id` 也从
    'shop'/本店编号改成 'node'/'node'。原先它记的是 `target_id = req.shop.code`，那会同时说两句假话：
    归属假（这次擦的可能全是别家店的单）与读数假（`erased/candidates` 是**节点合计**，摆到某家店的
    列表里就是把别家店的量给它看）。被擦的每一单仍各自写一行归**该单所属的店**（上面那条用例钉着）。
    触发者留在 `actor` 上（节点主排障用）。**不再记 `triggeredByShop`**：这条路由是 hostOnly，
    请求头只是回声（节点主可以一家店都没有），把它记成"哪家店触发的"是一句假话。
  */
  const runRow = await db.get("SELECT * FROM audit_logs WHERE action = 'retention.run' ORDER BY id DESC LIMIT 1");
  assert.ok(runRow, '手动运行入审计');
  assert.equal(runRow.shop_code, null, '节点级动作不属于任何一家店（显式 NULL，不是空串、也不挂到触发者那家店）');
  assert.equal(runRow.target_type, 'node');
  assert.equal(runRow.actor_role, 'host', '这一动只有节点主能做 ⇒ 角色恒为 host（不是"他在某家店里是什么角色"）');
  assert.equal(runRow.detail.triggeredByShop, undefined, '不再记触发店铺：节点级动作与请求头无关');
});

/**
 * 手动保留期端点的**单飞 + 结果复用**（T3）：
 * runPiiRetention 是全同步重活（一次最多擦 200 单，期间独占事件循环），重复点击/脚本重放
 * 只会在队列里再排一次同样的活。故：距上次结束 < 2 秒且 days 相同 → 复用上次结果并标注
 * `reused: true`，**不重复擦**；days 不同 = 货真价实的另一次运行，不复用。
 * 证伪方式：先跑一次擦掉到期单，再在同一窗口内新建一张到期单并重复请求——
 * 若没有单飞，第二次会把它也擦掉（erased 变 2、该单的收货信息被清空）。
 */
test('POST /api/shop/retention/run 单飞：2 秒内的重复请求复用上次结果（不重复跑重活）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 单飞商品' }));
  const first = await createDraft(p.slug, { shipping: { name: '陈一', phone: '13000000001', address: '天津市某路 1 号' } });
  await escrowed(first);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: first.escrowOrderId }, { txHash: payHash(), block: 21 }), 1);
  await ageOrder(first.id, 205); // 205 天：用 days=200 的窗口擦它

  const run1 = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send({ days: 200 }).expect(200);
  assertOk(run1);
  assert.equal(run1.body.data.days, 200);
  assert.equal(run1.body.data.erased, 1);
  assert.deepEqual(run1.body.data.orderNos, [first.id]);
  assert.equal(run1.body.data.reused, undefined, '首次运行不是复用');
  assert.equal((await rowOf(first.id)).shipping_name, null, '到期单已擦（个人信息整行删除 ⇒ 读回 NULL，不是空串）');

  // 同一窗口内再造一张到期单：如果单飞失效，第二次运行会把它擦掉
  const second = await createDraft(p.slug, { shipping: { name: '陈二', phone: '13000000002', address: '天津市某路 2 号' } });
  await escrowed(second);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: second.escrowOrderId }, { txHash: payHash(), block: 22 }), 1);
  await ageOrder(second.id, 205);

  const run2 = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send({ days: 200 }).expect(200);
  assertOk(run2);
  assert.equal(run2.body.data.reused, true, '2 秒内的重复请求复用上次结果');
  assert.equal(run2.body.data.erased, 1, '复用上次结果（未再跑一遍）');
  assert.match(run2.body.message, /复用/);
  assert.equal((await rowOf(second.id)).shipping_name, '陈二', '第二次没有真的运行 ⇒ 新到期单仍在（这正是单飞的意义）');

  // 不同 days = 另一次运行（不复用）：收紧到 100 天后第二张单立刻到期
  const run3 = await request(app).post('/api/shop/retention/run').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).send({ days: 100 }).expect(200);
  assertOk(run3);
  assert.equal(run3.body.data.reused, undefined, 'days 不同不复用');
  assert.equal(run3.body.data.days, 100);
  assert.equal(run3.body.data.erased, 1);
  assert.equal((await rowOf(second.id)).shipping_name, null, '这一次真的运行了');
});

test('周期扫描接线：startPiiRetentionSweep 启动即收敛一次并返回定时器', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 周期扫描商品' }));
  const order = await createDraft(p.slug, { shipping: { name: '周九', phone: '13300000000', address: '南京市某路 7 号' }, note: '周期单' });
  await escrowed(order);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 12 }), 1);
  await ageOrder(order.id, 365);
  const timer = startPiiRetentionSweep();
  assert.ok(timer, '已启用保留期时应返回定时器');
  clearInterval(timer);
  /*
    首轮 tick 现在是**异步**的（`runPiiRetention` 要读库，MySQL 迁移后不再同步执行），
    所以"启动即收敛"不能靠"`startPiiRetentionSweep()` 返回时已经擦完"来断言——那是 SQLite
    同步执行时期的事实。这里等的是**那一轮本身**，用的是内核自己的单飞语义：
    正在跑的那一轮，第二个调用者拿到的是**同一轮的结果**（见 runPiiRetention 的单飞闸）。
    于是断言读到的正是首轮 tick 的读数——既不是"再跑一轮"，也不是一个拍脑袋的等待时长。
    （两次调用之间没有 await，单飞闸必然已合上，这个等待是确定的。）
  */
  const firstTick = await runPiiRetention();
  assert.ok(firstTick.orderNos.includes(order.id), '首轮 tick 必须真的收敛（不只是被启动了）');
  assert.equal((await rowOf(order.id)).shipping_name, null, '启动即收敛：超期订单在首轮 tick 已擦除');
});

/**
 * 开票信息（C）同样是个人信息：抬头常是真实姓名、税号指向具体主体。
 * 擦除把 `order_shipping` 整行删掉（抬头/税号就在那一行里）。
 *
 * ⚠️ 曾经的代价已经还清（2026-10-16 重设计）：`invoice_needed` 曾住在 `order_shipping` 那一行上，
 * 于是擦除会把它一起抹掉——而"这单要不要开票"是**订单事实**、不是个人信息，后果是导出让这单
 * 读成"没要求开票"（与事实相反）。现在它住 `orders`（见 db.js 的建表注释），擦除**碰不到它**。
 * 本用例把新旧两半都钉住：抬头/税号随 PII 行消失，而 `invoice_needed` 原样保留。
 */
test('开票信息（抬头/税号）随 PII 行删除一并消失；invoice_needed 住在 orders 上、擦除后保留；幂等且不污染审计', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 开票商品' }));
  const order = await createDraft(p.slug, {
    shipping: { name: '吴十', phone: '13200000000', address: '武汉市某路 8 号' },
    invoice: { needed: true, title: '某某科技有限公司', taxNo: '91310000MA1K35XXXX' },
  });
  assert.equal((await rowOf(order.id)).invoice_needed, 1);
  assert.equal((await rowOf(order.id)).invoice_title, '某某科技有限公司');
  assert.equal((await rowOf(order.id)).invoice_tax_no, '91310000MA1K35XXXX');

  // 在途单不可擦（发票信息与收货信息同受资金流未终结的约束）
  const inflight = await eraseViaApi(order.id);
  assert.notEqual(inflight.body.code, 0);
  assert.equal((await rowOf(order.id)).invoice_title, '某某科技有限公司', '在途单的开票信息保留（店主还要开票）');

  await escrowed(order);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: order.escrowOrderId }, { txHash: payHash(), block: 13 }), 1);

  const res = await eraseViaApi(order.id);
  assertOk(res);
  /*
    一次擦除 = 删掉那一行 `order_shipping`：收货三列、备注、抬头、税号**同生共死**，
    所以只有一个读数 `shippingRows: 1`。旧形状分开数 `shippingFields: 3` / `invoiceFields: 2`
    是"六个列各改一次"时代的产物——那种数法在行已删的新形状下算不出真值（列都没有了）。
  */
  assert.equal(res.body.data.erased.shippingRows, 1);
  assert.ok(!JSON.stringify(res.body).includes('某某科技'), '响应不得回显被擦除的开票抬头');
  assert.ok(!JSON.stringify(res.body).includes('91310000MA1K35XXXX'), '响应不得回显被擦除的税号');

  const after = await rowOf(order.id);
  assert.equal(after.invoice_title, null);
  assert.equal(after.invoice_tax_no, null);
  assert.equal(after.invoice_needed, 1, '开票标记住在 orders 上：它是订单事实，不随个人信息行消失');
  assert.equal(after.amount_wei, (await rowOf(order.id)).amount_wei, '金额不变');

  const audit = await db.get("SELECT * FROM audit_logs WHERE action = 'order.erase_pii' AND target_id = ? ORDER BY id DESC LIMIT 1", order.id);
  assert.equal(audit.detail.shippingRows, 1);
  assert.ok(!JSON.stringify(audit.detail).includes('某某科技'), '审计 detail 不得含被擦除的开票信息');

  // 幂等：重复调用不报错、不重复计数
  const again = await eraseViaApi(order.id);
  assertOk(again);
  assert.equal(again.body.data.alreadyErased, true);
  assert.equal(again.body.data.erased.shippingRows, 0);

  // 保留期通道同口径：带开票信息的终局单到期后同样被清
  const stale = await createDraft(p.slug, {
    shipping: { name: '郑十一', phone: '13100000000', address: '西安市某路 9 号' },
    invoice: { needed: true, title: '某某商贸行', taxNo: '91440300MA5FXXXXXX' },
  });
  await escrowed(stale);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: stale.escrowOrderId }, { txHash: payHash(), block: 14 }), 1);
  await ageOrder(stale.id, 200);
  const sweep = await runPiiRetention({ days: 180 });
  assert.ok(sweep.orderNos.includes(stale.id), '到期单进保留期擦除');
  assert.equal((await rowOf(stale.id)).invoice_title, null, '保留期通道同样删掉个人信息行');
  assert.equal((await rowOf(stale.id)).invoice_tax_no, null);
  assert.equal((await rowOf(stale.id)).invoice_needed, 1, '保留期通道同样不碰 orders 上的开票标记');
});

test('保留期让路：有在途售后案件的终局单不自动擦除（证据要留给仲裁），结案后照常到期即擦', async () => {
  /*
    售后案件只存在于**终局**单上（链上要求 Settled），而终局单正是保留期扫描的候选面——
    案件又往往在成交很久之后才被开出来（窗口上限 360 天），所以"到期就擦"会把双方刚提交的
    after_sale 陈述正文、证据附件与收货信息一起销毁，而仲裁人还要靠它们裁决。
    显式删除请求（erase-pii）同样必须让路：它由店主发起，而店主正是售后案件可能被罚的一方；
    让店主在开案后擦掉双方陈述/附件，等于把裁决证据先销毁。结案后才回到正常擦除。
  */
  const p = await listProduct(productPayload({ kind: 'physical', title: 'PII 案件让路商品' }));
  const o = await createDraft(p.slug, { shipping: { name: '孙十二', phone: '13900000000', address: '成都市某路 10 号' }, note: '售后案件中' });
  await escrowed(o);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: o.escrowOrderId }, { txHash: payHash(), block: 15 }), 1);
  // 终局后买家开案（链上 openAfterSale 的本地镜像）
  assert.equal(await applyEvent('AfterSaleOpened', { orderId: o.escrowOrderId }, { block: 16 }), 1);
  await ageOrder(o.id, 200); // 成交已超保留期

  const sweep = await runPiiRetention({ days: 180 });
  assert.ok(!sweep.orderNos.includes(o.id), '在途案件的单不进擦除清单');
  assert.equal((await rowOf(o.id)).shipping_name, '孙十二', '收货信息保留（案件未了结）');
  assert.equal((await rowOf(o.id)).note, '售后案件中');
  assert.equal((await rowOf(o.id)).pii_erased_at, null, '没擦过就不该有擦除锚点');

  // 在途案件也不接受店主的显式删除：陈述/附件是裁决证据，且店主正是可能被罚的一方
  const manual = await eraseViaApi(o.id);
  assert.equal(manual.status, 409, 'case_open 必须是 409，不能静默擦');
  assert.notEqual(manual.body.code, 0);
  assert.match(String(manual.body.message), /售后案件/);
  assert.equal((await rowOf(o.id)).shipping_name, '孙十二', '案件在途时收货信息也必须留到结案');
  assert.equal((await rowOf(o.id)).pii_erased_at, null, '拒绝时不得写擦除锚点');

  // 结案后回到正常保留期语义：到期即擦
  const o2 = await createDraft(p.slug, { shipping: { name: '周十三', phone: '13800000000', address: '武汉市某路 11 号' } });
  await escrowed(o2);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: o2.escrowOrderId }, { txHash: payHash(), block: 17 }), 1);
  assert.equal(await applyEvent('AfterSaleOpened', { orderId: o2.escrowOrderId }, { block: 18 }), 1);
  assert.equal(await applyEvent('AfterSaleClosed', { orderId: o2.escrowOrderId, note: '已线下和解' }, { block: 19 }), 1);
  await ageOrder(o2.id, 200);
  const sweep2 = await runPiiRetention({ days: 180 });
  assert.ok(sweep2.orderNos.includes(o2.id), '结案后不再让路：到期即擦（保留期的最终效果不变）');
  assert.equal((await rowOf(o2.id)).shipping_name, null);
});

/*
  ── 2026-10-14：**删盘失败那条分支**必须真的可达、而且不许被报成"已擦除"──────────────
  为什么这条单独成文：这个分支此前是**死代码**（判据写的是 `attachmentFiles.failed > 0`，而该字段
  从来不存在 ⇒ `undefined > 0` 恒 false），于是磁盘上的证据附件（真正的个人数据）一个都没删掉时，
  手动端点照样回"个人信息已擦除"、保留期扫描照样写审计、`/healthz` 也不报错。
  修法是让 `ok` 由**事实产出方**给出的残留数派生（`remaining !== 0`，含"目录列不出来"的 -1 哨兵）。
  但"修好了"这件事必须由测试守：这里用一次故意的删盘失败（patch `fs.rmSync` 只让它失败一次）
  把三条结论一次钉住：
    ① 响应必须说"没删净"（`ok:false` + 残留数 + 可读的 `error`），不能说"已擦除"；
    ② 擦除锚点 `pii_erased_at` **不得前移**（否则保留期扫描再也不会重试 ⇒ 盘上的数据永远留着）；
    ③ 目录恢复后重试必须成功（锚点落定、残留归零）——即"失败是**可见的**未完成，而不是静默的成功"。
  这三条正是界面文案 `piiEraseOutcomeText` 依赖的契约（它按这三个读数分叉，不接受"已擦除"以外的猜）。
*/
test('删盘失败：响应必须说"没删净"、锚点不得前移，且重试能自愈（三条一起守）', async () => {
  const fsMod = await import('node:fs');
  const realRm = fsMod.default.rmSync;

  const p = await listProduct(productPayload({ kind: 'physical', title: '删盘失败用例商品' }));
  const { order: o, stored } = await draftWithEvidenceAndFile(
    p.slug,
    { name: '删盘失败', phone: '13600000002', address: '删盘地址-1' },
    '删盘失败用例备注',
    '删盘失败陈述'
  );
  assert.ok(stored && fs.existsSync(diskPath(await orderIdOfNo(o.id), stored)), '前置：这一单的附件必须真的在盘上');
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: o.escrowOrderId }, { txHash: payHash(), block: 96 }), 1);

  // 故意让"删附件目录"失败**一次**：其余 fs 调用照旧（只拦 rmSync）
  let failedOnce = false;
  fsMod.default.rmSync = (...args) => {
    if (!failedOnce) {
      failedOnce = true;
      throw new Error('EBUSY: 文件被占用（本用例故意构造）');
    }
    return realRm(...args);
  };
  let first;
  try {
    first = await eraseViaApi(o.id);
  } finally {
    fsMod.default.rmSync = realRm;
  }

  assert.ok(first, '请求本身仍应成功返回（失败由响应体如实表达，不是 HTTP 错误）');
  const d = first.body?.data || {};
  assert.equal(d.attachmentFilesRemaining > 0, true, `必须报出磁盘残留数（实际 ${d.attachmentFilesRemaining}）`);
  assert.equal(d.attachmentFilesRemoved, false, '三态读数必须明确说"确认没删净"（不是 null、更不是 true）');
  assert.match(String(d.error || ''), /还剩|无法读取/, 'error 必须是一句可读的原因，界面要原样展示它');
  assert.equal(d.cleanupFailed, true, '清理未完成（附件那条腿）要有一个明确的布尔');
  assert.equal(d.cleanupPending, true, '必须记成"仍欠一次清理"');
  assert.equal((await rowOf(o.id)).pii_cleanup_pending, 1, '待清理标记要落库——保留期扫描据此重试');
  /*
    锚点**照常落定**（2026-10-15 改口径）：`pii_erased_at` 的语义是"库内那批字段已擦"（这是事实，
    库内确实没有个人信息了），它的活是给保留期扫描去重与排序；"还欠一次清理"由 `pii_cleanup_pending`
    单独表达。旧实现靠"把锚点回退成 NULL"来表达未完成，于是同一个语义有两个机制，
    而那个机制**根本不起作用**（候选判据是纯时间的，回退锚点不会让这一单重新入选——见下面那段）。
    真正的判据在下一段：不推进任何时间，保留期扫描必须把这一单当候选。
  */
  assert.ok((await rowOf(o.id)).pii_erased_at, '锚点落定（= 库内已擦这个事实），未完成由 pii_cleanup_pending 表达');
  assert.equal((await rowOf(o.id)).shipping_name, null, '库内那一行该删的仍要删（只有磁盘那部分没做成）');

  /*
    ── "系统会在下一轮保留期扫描中自动重试"这句承诺必须是真的（2026-10-15 修）──────────
    旧实现把重试寄托在"锚点回退"上，而候选判据是**纯时间**的（MAX(锚点, updated_at) <= 截止）：
    这一单的 updated_at 就是刚才那一下 ⇒ 要等整个保留期（默认 180 天）才可能被扫到，
    MK_PII_RETENTION_DAYS=0 时则永远等不到。现在"还欠清理"是独立的一列，候选判据里有
    `OR pii_cleanup_pending = 1`，所以**不推进任何时间**、直接跑一轮保留期扫描，它就必须进候选。

    这一轮故意**继续让删盘失败**（fs 仍被拦着）：于是 `erased` 会是 0 —— 而路由不许把这说成
    "无到期订单"（运维按 node/docs/OPERATIONS.md 正是先跑这个接口再归档，看到"没有到期单"就会把还留着
    个人数据的卷归档走）。这是 D2 那条谎报的现场。
  */
  let failedAgain = false;
  fsMod.default.rmSync = (...args) => {
    if (!failedAgain) {
      failedAgain = true;
      throw new Error('EBUSY: 文件被占用（本用例故意构造第二轮）');
    }
    return realRm(...args);
  };
  let retention;
  try {
    retention = await request(app)
      .post('/api/shop/retention/run')
      .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
      .send({ days: 180 })
      .expect(200);
  } finally {
    fsMod.default.rmSync = realRm;
  }
  assertOk(retention);
  const rd = retention.body?.data || {};
  assert.ok(rd.candidates >= 1, `欠清理的单必须在同一时间点就成为候选（实际 ${rd.candidates}）`);
  assert.equal(rd.erased, 0, '这一轮磁盘那条腿仍失败 ⇒ 一单都没擦干净');
  assert.ok(rd.cleanupPending >= 1, `必须如实给出"还欠清理"的单数（实际 ${rd.cleanupPending}）`);
  assert.ok(rd.diskFailed >= 1, '半成功的单数也要下发（运维据此决定要不要去清目录）');
  assert.match(String(retention.body.message || ''), /没清完|欠清理|重试/, '文案要说清"有候选、但没清干净"');
  assert.doesNotMatch(String(retention.body.message || ''), /无到期订单/, '有候选却报"无到期订单"就是谎报（运维据此归档）');
  assert.equal((await rowOf(o.id)).pii_cleanup_pending, 1, '这一轮失败后仍欠清理（不会因为"试过了"就丢掉）');

  // 目录/占用恢复后重试：必须成功、标记归零、锚点落定（"失败是可见的未完成"这条承诺的后半句）
  const second = await eraseViaApi(o.id);
  const d2 = second.body?.data || {};
  assert.equal(d2.attachmentFilesRemaining, 0, '重试后磁盘必须干净');
  assert.equal(d2.attachmentFilesRemoved, true, '重试后必须明确说"确认删净"');
  assert.equal(d2.cleanupPending, false, '重试成功后不该再挂待清理');
  assert.equal((await rowOf(o.id)).pii_cleanup_pending, 0, '待清理标记要归零（有界重试，不是反复入选）');
  assert.ok((await rowOf(o.id)).pii_erased_at, '重试成功 ⇒ 锚点落定');
});

/*
  ── 2026-10-14：擦除入口的**可见性判据**必须在出参里（前端不许自己按状态猜）──────────
  背景：节点早有 ownerOnly 的擦除端点，但店主面板上**没有入口**（前端全仓 0 处引用 erase-pii），
  而使用指南却写着"店主可在卖家面板执行擦除"——把读者支到一个不存在的按钮上。
  修法不是在前端补一个 `status === 'confirmed' || …` 数组：可擦状态集合的唯一出处在
  `src/orderStatus.js`（`PII_ERASABLE_STATUS`），前端再抄一份，集合一改就是**静默漂移**
  （多出一个必败按钮，或少一个本该存在的入口）。所以由节点算好 `piiErasable` 下发，
  这里守两件事：① 它确实是"状态能否擦"的忠实映射（逐状态对拍同一份集合）；
  ② 它在**卖家列表出参**里真的带着（前端拿的就是这个列表）。
  权限（ownerOnly）不在这里表达——那是登录角色的事，前端另行门控（见 utils/piiEraseAction）。
*/
test('订单出参带 piiErasable：与可擦状态集合逐状态一致，且在卖家列表里真实下发', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '可擦判据商品' }));
  const o = await createDraft(p.slug, {
    shipping: { name: '判据甲', phone: '13700000001', address: '判据地址-1' },
  });
  await escrowed(o);

  /** 把这一单改成某状态后，从**卖家列表**（前端唯一取数入口）读回它的可擦判据 */
  const erasableViaSellerList = async (status) => {
    await db.run('UPDATE orders SET status = ? WHERE order_no = ?', status, o.id);
    const r = await request(app).get('/api/orders/seller?pageSize=100').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
    assertOk(r);
    const row = r.body.data.orders.find((x) => x.id === o.id);
    assert.ok(row, `订单应出现在卖家列表里（status=${status}）`);
    return row.piiErasable;
  };

  for (const status of PII_ERASABLE_STATUS) {
    assert.equal(await erasableViaSellerList(status), true, `${status} 应可擦（在 PII_ERASABLE_STATUS 里）`);
  }
  for (const status of PII_PROTECTED_STATUS) {
    assert.equal(
      await erasableViaSellerList(status),
      false,
      `${status} 不可擦（在途单要按地址发货/联系买家）——界面据此不渲染入口`
    );
  }
  // 两份集合的并集必须是全部状态：漏掉一个状态会让那一类单**永远**既不可擦也不被拦（静默）
  assert.deepEqual(
    [...PII_ERASABLE_STATUS, ...PII_PROTECTED_STATUS].sort(),
    [...ORDER_STATUS].sort(),
    '可擦 ∪ 受保护 = 全部订单状态'
  );
  // 擦除后仍可再次调用（幂等），但锚点会前移——界面用 piiErasedAt 显示"已擦过"而不是隐藏入口
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: o.escrowOrderId }, { txHash: payHash(), block: 95 }), 1);
  const erased = await eraseViaApi(o.id);
  assertOk(erased);
  const after = await request(app).get('/api/orders/seller?pageSize=100').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  const row = after.body.data.orders.find((x) => x.id === o.id);
  assert.equal(row.piiErasable, true, '已擦过的单在状态上仍属"可擦"（重复调用幂等，不是错误）');
  assert.ok(row.piiErasedAt, '擦除锚点必须下发，界面才不会把"已擦过"说成"从没擦过"');
});

/*
  ── "刻意保留"的那一半必须有**行为**判据（2026-10-15 审计 D7）────────────────────
  承诺清单（`piiErase.js` 文件头 + 三份文档）由 `pii-scope-consistency.test.js` 守文字的**一致性**，
  而"擦除动作真的没碰那些列/表"此前只被断了一部分（金额/托管单号/凭证/事件史/评价）。
  清单里剩下的几类——平台费率快照与净额口径、物流单号、退货单地址与备注、已交付的码/ tokenId、
  售后结案说明——一旦被某次改动顺手清掉，文字守卫**不会红**，而当事人按承诺行事就会踩空。这里逐项钉住。
  （`invoice_needed` 已**移出**这份清单的对立面：它现在住 `orders`，是订单事实，擦除必须保留它
  ——上面两条用例把它两个方向都钉住了。）
*/
test('擦除只动 PII：保留清单里的每一类都逐项验一遍（不是只验金额与凭证）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '保留清单逐项商品' }));
  const o = await createDraft(p.slug, {
    shipping: { name: '保留甲', phone: '13500000001', address: '保留地址-1' },
    note: '保留备注-1',
    // 开票信息里**只有抬头/税号**是个人信息；"要不要开票"（invoice_needed）是订单事实，
    // 所以下面那条"前置：确实要求开票"必须真的成立——不填 invoice 的话它恒为 0，断言就是空转。
    invoice: { needed: true, title: '保留乙', taxNo: '91310000MA1K35ZZZZ' },
  });
  await escrowed(o);
  assert.equal(await applyEvent('ReceiptConfirmed', { orderId: o.escrowOrderId }, { txHash: payHash(), block: 120 }), 1);

  const before = await rowOf(o.id);
  // 逐项铺上"保留清单"里的数据（都走真实写入路径能写到的列/表）
  const keepId = await orderIdOfNo(o.id);
  await db.run(`UPDATE orders SET tracking_no = ?, carrier = ?, shipping_fee_usdt_micro = 0, shipped_at = ?
      WHERE order_no = ?`, 'SF1234567890', '顺丰', new Date(), o.id);
  await db.run('UPDATE order_chain SET after_sale_note = ? WHERE order_id = ?', '结案说明：双方已协商一致（链上公开文本）', keepId);
  await db.run(`INSERT INTO order_returns (order_id, status, address, note, tracking_no, carrier)
     VALUES (?, 'shipped', '退货地址-保留', '退货说明-保留', 'RTN998877', '中通')`, keepId);
  await db.run(`INSERT INTO order_delivery_items (order_id, kind, value) VALUES (?, 'code', 'CODE-KEEP-1')`, keepId);

const kept = await db.get(`SELECT tracking_no, carrier, invoice_needed, after_sale_note, shipped_at,
              amount_wei, escrow_order_id, paid_tx_hash FROM v_orders WHERE order_no = ?`, o.id);
  assertOk(await eraseViaApi(o.id));

const after = await db.get(`SELECT tracking_no, carrier, invoice_needed, after_sale_note, shipped_at,
              amount_wei, escrow_order_id, paid_tx_hash, shipping_name FROM v_orders WHERE order_no = ?`, o.id);
  // 擦除 = 删掉 order_shipping 那一行 ⇒ LEFT JOIN 读不到 ⇒ NULL（旧形状是"把六列都改成空串"）
  assert.equal(after.shipping_name, null, '前置：PII 确实被擦了（否则下面的"保留"是空转）');
  for (const col of ['tracking_no', 'carrier', 'after_sale_note', 'shipped_at', 'amount_wei', 'escrow_order_id', 'paid_tx_hash']) {
    assert.deepEqual(after[col], kept[col], `${col} 属于"刻意保留"，擦除不许碰它`);
  }
  /*
    `invoice_needed` 现在**属于"刻意保留"那一类**：它已从 `order_shipping` 挪进 `orders`
    （见 db.js 的建表注释——"这单要不要开票"是订单事实，不是个人信息）。旧口径下它会随行消失，
    这条断言因此从"钉住欠账"翻成"钉住已还清"：擦除之后它必须**原样还在**。
  */
  assert.equal(kept.invoice_needed, 1, '前置：擦除前确实要求开票');
  assert.equal(after.invoice_needed, 1, '开票标记住在 orders 上，擦除不许碰它');
const ret = await db.get('SELECT * FROM order_returns WHERE order_id = ?', keepId);
  assert.ok(ret, '退货单行必须保留（售后事实记录）');
  assert.equal(ret.address, '退货地址-保留');
  assert.equal(ret.note, '退货说明-保留');
  assert.equal(ret.tracking_no, 'RTN998877', '买家回填的退回物流单号同样保留');
const del = await db.all('SELECT * FROM order_delivery_items WHERE order_id = ?', keepId);
  assert.equal(del.length, 1, '已交付的码必须保留（"这个东西已经给他了"的证据）');
  assert.equal(del[0].value, 'CODE-KEEP-1');
  assert.ok(before.amount_wei, '前置：金额本来就有值');
});
