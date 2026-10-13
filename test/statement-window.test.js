/**
 * 陈述时限（双方举证窗口；`MK_DISPUTE_STATEMENT_DAYS`，默认 7，0 = 关闭）。
 *
 * 本文件钉住的是"窗口这件事只有一处判据"以及它的三态与边界：
 *  1. **唯一门控**：时限与阶段/身份/条数同处 `evidencePhaseError`——陈述端点与附件上传端点
 *     对同一张过期单必须给出**逐字相同**的拒因（附件那侧只多一句后缀，见 evidence-guard 的先例）；
 *  2. **两个阶段**：争议（锚点 = 进入争议时刻 `orders.updated_at`）与售后案件（锚点 = 开案时刻
 *     `after_sale_opened_at`）都受窗口约束，且**各用各的锚点**（案件不动 updated_at）；
 *  3. **边界**：恰好到点仍可提交，过点即拒；拒因可读（含"第 N 天"与"过期视为放弃举证"）；
 *  4. **三态**：`0` = 关闭（不限时，DTO 字段为 `null`）；阶段不成立时给的是阶段语义的拒因，
 *     而不是"时限已过"；锚点读不到 → 没有窗口（不假装已过期）；
 *  5. **配置解析**：缺失/空串/非法/负数回退默认 7 天，不静默变成 0（那等于把窗口关掉）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, login, assertOk } from './setup.mjs';

// 附件目录（附件端点也要走到同一道门控，这里验证"被拒时真的没落盘"）
process.env.MK_ATTACH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-stmt-'));

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const { evidencePhaseError, statementWindowOf, statementFieldsOf } = await import('../src/evidenceFiles.js');
const config = (await import('../src/config.js')).default;

const DAY = 24 * 3600 * 1000;
const SELLER = owner.address.toLowerCase();

let ownerToken;
let buyerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
});

let seq = 0;
/** 直接插订单行（本文件关心门控，不关心下单流程）；返回 id 与插入时用到的锚点值 */
function insertOrder({
  status = 'disputed',
  updatedAt = Date.now(),
  refundStatus = 'none',
  afterSaleStatus = 'none',
  afterSaleOpenedAt = null,
} = {}) {
  seq += 1;
  const id = `sw-${seq}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, usdt_micro, bty_usdt_rate, status, escrow_order_id, paid_tx_hash,
       refund_status, after_sale_status, after_sale_opened_at, created_at, updated_at)
     VALUES (?, 'p-sw', '{}', '0x00', '', ?, ?, '1000', 1000000, '0.1', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    buyer.address.toLowerCase(),
    SELLER,
    status,
    `0x${String(seq).padStart(64, '0')}`,
    `0x${String(seq).padStart(64, 'a')}`,
    refundStatus,
    afterSaleStatus,
    afterSaleOpenedAt,
    now,
    updatedAt
  );
  return { id, updatedAt };
}

function insertEvidence(orderId, { role = 'buyer', phase = 'arbitration', content = '既有陈述' } = {}) {
  const r = db
    .prepare('INSERT INTO dispute_evidence (order_id, role, phase, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(orderId, role, phase, content, Date.now());
  return Number(r.lastInsertRowid);
}

const rowOf = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const evidenceCount = (id) => db.prepare('SELECT COUNT(*) AS c FROM dispute_evidence WHERE order_id = ?').get(id).c;
const setUpdatedAt = (id, ms) => db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(ms, id);

const postEvidence = (orderId, body, token = buyerToken) =>
  request(app).post(`/api/orders/${orderId}/evidence`).set('Authorization', `Bearer ${token}`).send(body);
const pngB64 = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8, 1)]).toString('base64');
const uploadFile = (orderId, evidenceId, token = buyerToken) =>
  request(app)
    .post(`/api/orders/${orderId}/evidence/${evidenceId}/files`)
    .set('Authorization', `Bearer ${token}`)
    .send({ files: [{ name: 'proof.png', mime: 'image/png', dataB64: pngB64() }] });
const detail = (orderId) => request(app).get(`/api/orders/${orderId}`).expect(200);

/** 临时改配置（getter 动态读 env，见 config.dispute.statementDays）；返回恢复函数 */
function withStatementDays(value) {
  const prev = process.env.MK_DISPUTE_STATEMENT_DAYS;
  if (value === undefined) delete process.env.MK_DISPUTE_STATEMENT_DAYS;
  else process.env.MK_DISPUTE_STATEMENT_DAYS = value;
  return () => {
    if (prev === undefined) delete process.env.MK_DISPUTE_STATEMENT_DAYS;
    else process.env.MK_DISPUTE_STATEMENT_DAYS = prev;
  };
}

test('默认 7 天：争议中可提交，订单 DTO 下发举证截止时刻（供界面倒计时）', async () => {
  const o = insertOrder({ status: 'disputed' });
  assertOk(await postEvidence(o.id, { phase: 'arbitration', content: '买家陈述：未收到货' }));

  const d = (await detail(o.id)).body.data;
  assert.equal(d.statementDeadlineAt, o.updatedAt + 7 * DAY, '截止 = 进入争议时刻 + 7 天（锚点就是 updated_at）');
  assert.ok(d.statementDeadlineAt > Date.now(), '期内：截止时刻在将来（前端据此显示倒计时）');
  assert.equal('statementWindows' in d, false, '契约是**一个扁平字段**（frontend/src/types.ts 的 Order.statementDeadlineAt）');

  // 非争议、无案件的单：没有受时限约束的阶段 ⇒ 字段为 null（不是"已过期"）
  const plain = insertOrder({ status: 'escrowed' });
  assert.equal((await detail(plain.id)).body.data.statementDeadlineAt, null);
});

test('边界：恰好到点之前仍可提交；一过点即拒，拒因可读（第 N 天 + 过期视为放弃举证）', async () => {
  const o = insertOrder({ status: 'disputed', updatedAt: Date.now() - 7 * DAY + 5000 });
  assertOk(await postEvidence(o.id, { phase: 'arbitration', content: '压哨陈述' }));
  const before = evidenceCount(o.id);

  setUpdatedAt(o.id, Date.now() - 7 * DAY - 1000); // 过点 1 秒
  const late = await postEvidence(o.id, { phase: 'arbitration', content: '过期还想补' });
  assert.notEqual(late.body.code, 0, '过期提交必须被拒');
  assert.match(late.body.message, /陈述时限已过/);
  assert.match(late.body.message, /第 7 天/, '拒因要说清"第几天"');
  assert.match(late.body.message, /过期视为放弃举证/);
  assert.match(late.body.message, /进入争议/, '拒因要说清从哪一刻起算');
  assert.equal(evidenceCount(o.id), before, '被拒的陈述没有落库');

  // DTO 里的截止时刻仍在（阶段还在争议中）：只是已经落在过去 ⇒ 前端禁用提交并写明原因
  const d = (await detail(o.id)).body.data;
  assert.ok(d.statementDeadlineAt < Date.now(), '"已截止"表示为过去的截止时刻，而不是把字段变成 null');
  assert.equal(d.statementDeadlineAt, rowOf(o.id).updated_at + 7 * DAY);
});

test('唯一门控：附件上传与陈述共用同一判据，过期后一并被拒且文案逐字同源', async () => {
  const o = insertOrder({ status: 'disputed', updatedAt: Date.now() - 9 * DAY });
  const evId = insertEvidence(o.id, { phase: 'arbitration' });
  const stmt = await postEvidence(o.id, { phase: 'arbitration', content: '过期陈述' });
  assert.notEqual(stmt.body.code, 0);
  const up = await uploadFile(o.id, evId);
  assert.notEqual(up.body.code, 0, '附件端点必须同样被拒（否则举证期后还能追加 20MB 个人数据）');
  assert.equal(up.body.message, stmt.body.message + '（附件同证据阶段门控）', '拒因逐字来自同一个 evidencePhaseError');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM evidence_files WHERE order_id = ?').get(o.id).c, 0, '被拒的附件没有落盘');
});

test('售后案件阶段同样受窗口约束，且锚点是开案时刻（不是 orders.updated_at）', async () => {
  // 开案 8 天前（超过 7 天），但订单 updated_at 很新：锚点若取错就会放行
  const old = insertOrder({ status: 'confirmed', updatedAt: Date.now(), afterSaleStatus: 'open', afterSaleOpenedAt: Date.now() - 8 * DAY });
  const late = await postEvidence(old.id, { phase: 'after_sale', content: '案件过期后的陈述' });
  assert.notEqual(late.body.code, 0);
  assert.match(late.body.message, /陈述时限已过/);
  assert.match(late.body.message, /案件开案/, '售后阶段的起算点是"案件开案"');

  // 开案 1 天前的案件照常受理（买卖双方都可以说话）
  const fresh = insertOrder({ status: 'settled', afterSaleStatus: 'open', afterSaleOpenedAt: Date.now() - DAY });
  assertOk(await postEvidence(fresh.id, { phase: 'after_sale', content: '买家：换货请求' }));
  assertOk(await postEvidence(fresh.id, { phase: 'after_sale', content: '店主：同意换货' }, ownerToken));
  const d = (await detail(fresh.id)).body.data;
  assert.equal(d.statementDeadlineAt, rowOf(fresh.id).after_sale_opened_at + 7 * DAY, '案件阶段的截止 = 开案时刻 + 7 天');
  assert.ok(d.statementDeadlineAt > Date.now());
});

test('0 = 关闭：不限时（过期单照样受理），且订单 DTO 的截止时刻为 null', async () => {
  const restore = withStatementDays('0');
  try {
    const o = insertOrder({ status: 'disputed', updatedAt: Date.now() - 90 * DAY });
    assertOk(await postEvidence(o.id, { phase: 'arbitration', content: '关了窗口就能随时陈述' }));
    const d = (await detail(o.id)).body.data;
    assert.equal(d.statementDeadlineAt, null, '关闭时字段为 null（与加配置之前的形状一致）');

    const caseRow = insertOrder({ status: 'confirmed', afterSaleStatus: 'open', afterSaleOpenedAt: Date.now() - 90 * DAY });
    assertOk(await postEvidence(caseRow.id, { phase: 'after_sale', content: '案件也不限时' }));
    assert.equal((await detail(caseRow.id)).body.data.statementDeadlineAt, null);
  } finally {
    restore();
  }
  // 恢复默认后，同一张单立刻恢复拒收（证明读的是**实时**配置，不是启动快照）
  const o2 = insertOrder({ status: 'disputed', updatedAt: Date.now() - 90 * DAY });
  assert.notEqual((await postEvidence(o2.id, { phase: 'arbitration', content: '再试' })).body.code, 0);
  assert.ok((await detail(o2.id)).body.data.statementDeadlineAt < Date.now());
});

test('自定义天数（1 天）：窗口按配置收窄，拒因里的天数跟着变', async () => {
  const restore = withStatementDays('1');
  try {
    const o = insertOrder({ status: 'disputed', updatedAt: Date.now() - 2 * DAY });
    const late = await postEvidence(o.id, { phase: 'arbitration', content: '第 2 天了' });
    assert.notEqual(late.body.code, 0);
    assert.match(late.body.message, /第 1 天/);
    assert.equal((await detail(o.id)).body.data.statementDeadlineAt, o.updatedAt + DAY);
  } finally {
    restore();
  }
});

test('配置解析：缺失/空串/非法/负数一律回退 7 天，显式 0 才是关闭', () => {
  for (const [raw, expect] of [
    [undefined, 7],
    ['', 7],
    ['abc', 7],
    ['-3', 7],
    ['0', 0],
    ['3', 3],
    ['7', 7],
  ]) {
    const restore = withStatementDays(raw);
    try {
      assert.equal(
        config.dispute.statementDays,
        expect,
        `MK_DISPUTE_STATEMENT_DAYS=${raw === undefined ? '(未设置)' : JSON.stringify(raw)} 应解析为 ${expect}`
      );
    } finally {
      restore();
    }
  }
});

test('判据顺序：阶段语义先于时限——非争议单收到的是"仅限争议中"，已结案的案件不谈时限', async () => {
  // escrowed 单（未进入争议）即便"很久没动"也不是时限问题
  const notDisputed = insertOrder({ status: 'escrowed', updatedAt: Date.now() - 30 * DAY });
  const r1 = await postEvidence(notDisputed.id, { phase: 'arbitration', content: '试探' });
  assert.notEqual(r1.body.code, 0);
  assert.match(r1.body.message, /仅限争议中/);
  assert.ok(!/陈述时限已过/.test(r1.body.message), '不该拿"时限已过"去回答一个根本没有窗口的阶段');

  // 已结案的售后案件：拒因是"案件不在途"，不是时限
  const closed = insertOrder({ status: 'settled', afterSaleStatus: 'closed', afterSaleOpenedAt: Date.now() - 30 * DAY });
  const r2 = await postEvidence(closed.id, { phase: 'after_sale', content: '试探' });
  assert.notEqual(r2.body.code, 0);
  assert.match(r2.body.message, /已结案|仅在售后案件在途时/);
  assert.ok(!/陈述时限已过/.test(r2.body.message));
});

test('退款两阶段不受陈述时限约束（那是"申请-答复"的即时往来，链上另有自己的时序）', async () => {
  const o = insertOrder({ status: 'escrowed', refundStatus: 'requested', updatedAt: Date.now() - 30 * DAY });
  assertOk(await postEvidence(o.id, { phase: 'refund_request', content: '买家：货不对版，申请退款' }));
  assertOk(await postEvidence(o.id, { phase: 'refund_reply', content: '店主：请提供照片' }, ownerToken));
  assert.equal((await detail(o.id)).body.data.statementDeadlineAt, null, '退款阶段不产生截止时刻（没有受约束的阶段）');
});

test('纯函数边界：锚点读不到 → 无窗口（不假装已过期）；关闭 → 无窗口；过期仍是过去的时刻', () => {
  const now = Date.now();
  // 锚点缺失/非法：没有窗口可言（三态里的"不适用"）
  assert.equal(statementWindowOf({ status: 'disputed' }, 'arbitration', now), null);
  assert.equal(statementWindowOf({ status: 'disputed', updated_at: 0 }, 'arbitration', now), null);
  // 不设窗口的阶段（退款两阶段）恒为 null
  assert.equal(statementWindowOf({ updated_at: now }, 'refund_request', now), null);
  // 已过期：仍返回窗口对象（界面要能显示"举证已截止"）
  const win = statementWindowOf({ updated_at: now - 10 * DAY }, 'arbitration', now);
  assert.equal(win.expired, true);
  assert.equal(win.remainingMs, 0);
  assert.equal(win.days, 7);
  // DTO：阶段不成立 ⇒ 字段 null；两阶段各自的截止时刻各用各的锚点
  assert.deepEqual(statementFieldsOf({ status: 'escrowed', updated_at: now }, now), { statementDeadlineAt: null });
  assert.equal(
    statementFieldsOf({ status: 'disputed', updated_at: now - 1000 }, now).statementDeadlineAt,
    now - 1000 + 7 * DAY
  );
  assert.equal(
    statementFieldsOf({ status: 'confirmed', after_sale_status: 'open', after_sale_opened_at: now - 2000 }, now).statementDeadlineAt,
    now - 2000 + 7 * DAY
  );
  // 矛盾数据（既 disputed 又在途案件——链上不可能同时成立）：以争议为准，不编折中值
  assert.equal(
    statementFieldsOf({ status: 'disputed', updated_at: now - 1000, after_sale_status: 'open', after_sale_opened_at: now - 2000 }, now)
      .statementDeadlineAt,
    now - 1000 + 7 * DAY
  );
});

test('门控函数本身（不经路由）：过期返回业务拒绝形状，未过期返回 null', () => {
  const now = Date.now();
  const expired = evidencePhaseError({ status: 'disputed', updated_at: now - 8 * DAY, after_sale_status: 'none' }, 'arbitration', 'buyer', { now });
  assert.equal(expired.code, 1);
  assert.equal(expired.http, 200);
  assert.match(expired.message, /陈述时限已过/);
  const okRow = evidencePhaseError({ status: 'disputed', updated_at: now - 1000, after_sale_status: 'none' }, 'arbitration', 'buyer', { now });
  assert.equal(okRow, null);
  // 仲裁阶段双方都可陈述：未过期时卖家同样放行（时限不改变"谁能在哪个阶段说话"）
  const sellerOk = evidencePhaseError({ status: 'disputed', updated_at: now - 1000, after_sale_status: 'none' }, 'arbitration', 'seller', { now });
  assert.equal(sellerOk, null);
  // 过期对双方一视同仁：卖家也一样被拒（举证窗口是**双方**的窗口）
  const sellerLate = evidencePhaseError({ status: 'disputed', updated_at: now - 8 * DAY, after_sale_status: 'none' }, 'arbitration', 'seller', { now });
  assert.equal(sellerLate.code, 1);
  assert.match(sellerLate.message, /陈述时限已过/);
  const arb = evidencePhaseError({ status: 'escrowed', refund_status: 'requested', updated_at: now }, 'refund_request', 'seller', { now });
  assert.equal(arb.code, 403, '退款理由仅买家可提交（与时限无关）');
});
