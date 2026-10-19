/**
 * 买家履约信号（`GET /api/shop/buyer-signal`，ownerOnly，**本店视角**）。
 *
 * 本文件钉住四件容易做错、且做错了不会报错的事：
 *  1. **三态**（读不到 ≠ 0 ≠ 缺失）："已终局但一条链上事件都没镜像过"的单必须单列进
 *     `unverified.terminalWithoutEventMirror`，**既不进分子分母、也不当成"没有争议/没有超时"**；
 *  2. **样本不足不下发比率**：成交样本 < 3 张时四个比率全为 null 并给出可读 note
 *     （"1 张单 1 次退款"读出来是 100%，那是指数级误导）；样本够时**分子 ⊆ 分母**（比率恒 ≤ 1），
 *     且每个计数都能由用例自己按"链上事实"重算一遍（口径可独立复算）；
 *  3. **只做本店视角**：响应自报 `scope:'this_shop_only'`，其它买家的单不进本读数，
 *     且整条路径不触链、不查其它节点（测试环境里 RPC 指向必然拒绝的端口，能返回就说明没触网）；
 *  4. **文案纪律**：只有计数与比率，没有判定词——这是"可疑信号，不是结论"。
 *
 * 形状契约：`frontend/src/types.ts` 的 `BuyerSignal`（前端 utils/buyerSignal 消费同名扁平字段）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, shopRef, insertOrder as insertOrderRow } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const { computeBuyerSignal, SIGNAL_MIN_SAMPLES } = await import('../src/buyerSignal.js');

const SELLER = owner.address.toLowerCase();

let ownerToken;
let buyerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
});

let seq = 0;
/** 事件史构造（与 watcher 落库同构：{name,txHash,block,at}） */
const ev = (name, at) => ({ name, txHash: '0x' + 'f'.repeat(64), block: 1, at });

/**
 * 直接插订单行（本文件关心**读数的口径**，不是下单流程）。行形状交给 setup.mjs 的 `insertOrder`
 * （`paid_tx_hash` / `refund_*` / `after_sale_*` / 事件史住在 `order_chain`）。
 * `paid: true` = 有链上支付凭证（**样本判据**）；不给 `events` = 事件史那一列停在默认的空数组
 * （它现在是 `NOT NULL DEFAULT ('[]')`，"没有事件"就是空数组）。
 */
async function insertOrder({
  buyerAddr = buyer.address.toLowerCase(),
  status = 'confirmed',
  paid = true,
  events = null,
  refundStatus = 'none',
  refundRequestedAt = null,
  refundedAmountWei = '0',
  afterSaleStatus = 'none',
  afterSaleOpenedAt = null,
} = {}) {
  seq += 1;
  return await insertOrderRow(db, {
    buyer: buyerAddr,
    seller: SELLER,
    status,
    productSlug: 'p-bs',
    amountWei: '1000',
    usdtMicro: 1000000,
    btyUsdtRate: '0.1',
    // 草稿期就已生成链上单号（所以它不能当"成交"判据）
    escrowOrderId: `0x${String(seq).padStart(64, '0')}`,
    paidTxHash: paid ? `0x${String(seq).padStart(64, 'a')}` : null,
    refundStatus,
    refundRequestedAt,
    refundedAmountWei,
    afterSaleStatus,
    afterSaleOpenedAt,
    events,
  });
}

const getSignal = (address = buyer.address, token = ownerToken) =>
  request(app).get(`/api/shop/buyer-signal?address=${address}`).set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value);

test('鉴权：ownerOnly（无令牌 401 / 买家令牌 403），地址非法一律明确拒绝', async () => {
  await request(app).get(`/api/shop/buyer-signal?address=${buyer.address}`).expect(401);
  const asBuyer = await getSignal(buyer.address, buyerToken);
  assert.equal(asBuyer.body.code, 403, '买家（非店主）不得读运营面读数');
  for (const bad of ['', 'not-an-address', '0x0000000000000000000000000000000000000000']) {
    const r = await getSignal(bad);
    assert.notEqual(r.body.code, 0, `address=${bad || '(空)'} 必须被拒`);
    assert.equal(r.body.data, null, '被拒时不返回任何读数');
  }
});

test('纯函数：空样本 → 计数全 0 + 比率全 null + 样本不足说明（不编造 0 比率）', () => {
  const s = computeBuyerSignal([], { address: buyer.address });
  /*
    这里**不再断 `available`**（2026-10-15 删）：本读数全部来自本地镜像、对合法地址恒可读，
    所以"不提供"这个状态不存在；旧字段恒为 true，前端却按它分了一条永远不会发生的分支。
    "确实没有成交"由 `sample: 0` 表达，"请求失败"由载荷为空表达——各有各的位置。
  */
  assert.equal('available' in s, false, '不该再有恒真的 available 字段（它的分支是死路径）');
  assert.equal(s.sample, 0);
  assert.equal(s.localOrders, 0);
  for (const k of ['settledToSeller', 'refundedToBuyer', 'disputed', 'afterSaleOpen', 'afterSaleClosed', 'expiredReleased']) {
    assert.equal(s[k], 0, `${k} 应为 0（本地确实一单都没有）`);
  }
  for (const k of ['confirmRate', 'refundRate', 'refundRequestRate', 'disputeRate']) {
    assert.equal(s[k], null, `${k} 在 0 样本时必须是 null——0 张单谈不上比率`);
  }
  assert.equal(s.minSamples, SIGNAL_MIN_SAMPLES);
  assert.match(s.note, /不足/);
  assert.equal(s.scope, 'this_shop_only');
});

test('样本判据是"真实发生过托管"（paid_tx_hash），草稿/取消单只进 localOrders 不进分母', async () => {
  const b = Wallet.createRandom().address.toLowerCase();
  const at = Date.now() - 5000;
  await insertOrder({ buyerAddr: b, status: 'confirmed', paid: true, events: [ev('OrderCreated', at), ev('ReceiptConfirmed', at + 1)] });
  // 三张从未付款的单：草稿期就已生成 escrow_order_id，拿它当"成交"会把它们算进分母
  await insertOrder({ buyerAddr: b, status: 'draft', paid: false });
  await insertOrder({ buyerAddr: b, status: 'cancelled', paid: false });
  await insertOrder({ buyerAddr: b, status: 'escrowed', paid: false });
  const d = (await getSignal(b)).body.data;
  assert.equal(d.localOrders, 4, '本地订单数如实给（含未付款的）');
  assert.equal(d.sample, 1, '样本 = 真实发生过托管的单（paid_tx_hash 非空）');
  assert.equal(d.settledToSeller, 1);
  assert.equal(d.confirmRate, null, '样本 1 < 3 ⇒ 比率置 null');
});

test('三态：已终局但没有事件史的单进 unverified（不计入 disputed/expiredReleased，也不当作"没发生"）', async () => {
  const b = Wallet.createRandom().address.toLowerCase();
  const at = Date.now() - 9000;
  // 1 张可复算的争议单
  await insertOrder({
    buyerAddr: b,
    status: 'disputed',
    events: [ev('OrderCreated', at), ev('DisputeRequested', at + 1)],
  });
  // 2 张读不到的终局单：事件史为空数组（那一列从未写过）/ 事件史存在但没有 OrderCreated/DisputeRequested
  await insertOrder({ buyerAddr: b, status: 'settled', events: null });
  await insertOrder({ buyerAddr: b, status: 'refunded', events: [ev('PartialRefundAccepted', at + 2)] });
  const d = (await getSignal(b)).body.data;
  assert.equal(d.sample, 3);
  assert.equal(d.disputed, 1, '读不到的那两张**不进**分子（也不当作 0 争议）');
  assert.equal(d.unverified.terminalWithoutEventMirror, 2, '它们必须被单列出来');
  assert.match(d.unverified.note, /读不到/);
  assert.match(d.caveats.join('\n'), /当前 2 单/, '边界说明里写明有多少单读不到（下界）');
});

test('unverified 与 disputed 是两件独立的事：丢了 OrderCreated 镜像的争议单，两边都要计', async () => {
  const b = Wallet.createRandom().address.toLowerCase();
  const at = Date.now() - 3000;
  /*
    病（2026-10-15 审计 D9）：`unverified` 的说明写着"已终局、却没有 OrderCreated 镜像的单数"，
    而实现把它写成挂在"争议"那一支后面的 `else if` ⇒ **有争议、又恰好丢了镜像的单**判成"已验证"。
    镜像缺失与争议史互相独立：知道"它争过"并不会让"复算链条断了一截"这件事消失
    （这正是本读数自称下界的那个原因）。
  */
  await insertOrder({ buyerAddr: b, status: 'disputed', events: [ev('DisputeRequested', at)] });
  const d = (await getSignal(b)).body.data;
  assert.equal(d.disputed, 1, '争议计数照给（判据是状态 ∨ 事件）');
  assert.equal(d.unverified.terminalWithoutEventMirror, 1, '同一张单也要出现在"镜像缺失"里');
});

test('计数可独立复算：与"按链上事实手算"的结果逐项相同（分子 ⊆ 分母，比率 ≤ 1）', async () => {
  const b = Wallet.createRandom().address.toLowerCase();
  const at = Date.now() - 60_000;
  // ① 买家确认收货；② 退款申请后卖家全额退款（无争议）；③ 仲裁拆分（判卖家，退了一部分）；④ 超时释放；⑤ 在途售后案件
  await insertOrder({ buyerAddr: b, status: 'confirmed', events: [ev('OrderCreated', at), ev('ReceiptConfirmed', at + 1)] });
  await insertOrder({
    buyerAddr: b,
    status: 'refunded',
    refundStatus: 'requested',
    refundRequestedAt: new Date(at + 2),
    refundedAmountWei: '1000',
    events: [ev('OrderCreated', at), ev('RefundRequested', at + 2), ev('RefundApproved', at + 3)],
  });
  await insertOrder({
    buyerAddr: b,
    status: 'settled',
    refundedAmountWei: '400',
    events: [ev('OrderCreated', at), ev('DisputeRequested', at + 4), ev('Arbitrated', at + 5)],
  });
  await insertOrder({ buyerAddr: b, status: 'expired', events: [ev('OrderCreated', at), ev('OrderExpiredReleased', at + 6)] });
  await insertOrder({
    buyerAddr: b,
    status: 'confirmed',
    afterSaleStatus: 'open',
    afterSaleOpenedAt: new Date(at + 7),
    events: [ev('OrderCreated', at), ev('ReceiptConfirmed', at + 1)],
  });

  const d = (await getSignal(b)).body.data;
  // 手算（独立复算：只用本地行 + 链上事实的定义）
  const rows = await db.all('SELECT * FROM v_orders WHERE buyer = ? AND paid_tx_hash IS NOT NULL', b);
  const manual = {
    sample: rows.length,
    settledToSeller: rows.filter((r) => ['confirmed', 'settled', 'expired'].includes(r.status)).length,
    refundedToBuyer: rows.filter((r) => BigInt(r.refunded_amount_wei || '0') > 0n).length,
    confirmed: rows.filter((r) => r.status === 'confirmed').length,
    refundRequested: rows.filter((r) => r.refund_requested_at instanceof Date).length,
    // 事件史是 JSON 列：驱动读回来**已是数组**（旧形状是 TEXT，得自己 JSON.parse）。
    // `String(数组)` 只会得到 "[object Object]"，所以判据必须逐条看 name——旧写法会静默恒假。
    disputed: rows.filter((r) => r.status === 'disputed' || (r.onchain_events || []).some((e) => e?.name === 'DisputeRequested')).length,
    expiredReleased: rows.filter((r) => r.status === 'expired' || (r.onchain_events || []).some((e) => e?.name === 'OrderExpiredReleased')).length,
    afterSaleOpen: rows.filter((r) => r.after_sale_status === 'open').length,
  };
  assert.equal(d.sample, manual.sample);
  assert.equal(d.settledToSeller, manual.settledToSeller, '判给店主 = confirmed/settled/expired（链上 Settled）');
  assert.equal(d.refundedToBuyer, manual.refundedToBuyer, '退给买家 = refundedAmount > 0（含部分退款）');
  assert.equal(d.confirmed, manual.confirmed);
  assert.equal(d.refundRequested, manual.refundRequested);
  assert.equal(d.disputed, manual.disputed);
  assert.equal(d.expiredReleased, manual.expiredReleased);
  assert.equal(d.afterSaleOpen, manual.afterSaleOpen);
  assert.deepEqual(d.confirmRate, Math.round((manual.confirmed / manual.sample) * 10000) / 10000);
  assert.equal('ratios' in d, false, '比率是**扁平字段**（前端契约），不再包一层 ratios 对象');
  for (const k of ['confirmRate', 'refundRate', 'refundRequestRate', 'disputeRate']) {
    assert.ok(d[k] >= 0 && d[k] <= 1, `${k} 必须 ∈ [0,1]（分子分母同源）`);
  }
  assert.equal(d.refundRate, 0.4, '退过款的 2 单 / 5 单（含部分退款）');
  assert.equal(d.refundRequestRate, 0.2, '申请过退款的 1 单 / 5 单（与"退了款"不同义）');
  assert.equal(d.disputeRate, 0.2);
  assert.equal(d.confirmRate, 0.4);
});

test('售后案件：afterSaleOpen/Closed 取本地列（案件不动 orders.status）', async () => {
  const b = Wallet.createRandom().address.toLowerCase();
  const at = Date.now() - 3000;
  // 两个时刻列都是 DATETIME(3)：传毫秒整数会被 MySQL 当数字字面量解析（写进荒谬时间且不报错）。
  // `events` 里的 `at` 是 JSON 文档里的毫秒数，不折。
  await insertOrder({ buyerAddr: b, status: 'confirmed', afterSaleStatus: 'open', afterSaleOpenedAt: new Date(at), events: [ev('OrderCreated', at)] });
  await insertOrder({ buyerAddr: b, status: 'settled', afterSaleStatus: 'closed', afterSaleOpenedAt: new Date(at - 1000), events: [ev('OrderCreated', at - 1000)] });
  const d = (await getSignal(b)).body.data;
  assert.equal(d.afterSaleOpen, 1);
  assert.equal(d.afterSaleClosed, 1);
  assert.match(d.caveats.join('\n'), /afterSaleClosed 也是下界/);
});

test('只做本店视角：其它买家的单不进读数，且响应自报 scope/shopOwner 与边界说明', async () => {
  const mine = Wallet.createRandom().address.toLowerCase();
  const other = Wallet.createRandom().address.toLowerCase();
  const at = Date.now() - 3000;
  await insertOrder({ buyerAddr: mine, status: 'disputed', events: [ev('OrderCreated', at), ev('DisputeRequested', at + 1)] });
  for (let i = 0; i < 5; i++) {
    await insertOrder({ buyerAddr: other, status: 'disputed', events: [ev('OrderCreated', at), ev('DisputeRequested', at + 1)] });
  }
  const d = (await getSignal(mine)).body.data;
  assert.equal(d.localOrders, 1, '只数本店与该买家的单');
  assert.equal(d.disputed, 1, '别的买家的争议不进本读数');
  assert.equal(d.scope, 'this_shop_only');
  assert.equal(d.shopOwner, SELLER);
  assert.match(d.scopeNote, /本店/);
  assert.match(d.scopeNote, /不会为任意地址去其他店铺查询/);
});

test('文案纪律：只有计数与比率，没有任何判定词；并显式声明"可疑信号，不是结论"', async () => {
  const b = Wallet.createRandom().address.toLowerCase();
  const at = Date.now() - 2000;
  await insertOrder({ buyerAddr: b, status: 'refunded', refundStatus: 'requested', refundRequestedAt: new Date(at), refundedAmountWei: '1000', events: [ev('OrderCreated', at)] });
  const d = (await getSignal(b)).body.data;
  const text = JSON.stringify(d);
  for (const word of ['骗子', '恶意', '欺诈', '黑名单', '拉黑', '封禁该']) {
    assert.ok(!text.includes(word), `响应里不得出现判定词「${word}」`);
  }
  assert.match(d.signalNote, /可疑信号，不是结论/);
  assert.match(d.signalNote, /不应作为自动拒单/);
  assert.ok(Array.isArray(d.caveats) && d.caveats.length >= 3, '边界说明随响应下发（下界/裁剪/分母口径）');
});

test('读数不触链：RPC 指向必然拒绝的端口时照样给出完整读数（本店视角是纯本地计算）', async () => {
  const cfg = (await import('../src/config.js')).default;
  assert.match(String(cfg.chain.rpcUrl), /127\.0\.0\.1:1/, '本套件的前提是 RPC 不可达（不会真的触网）');
  const b = Wallet.createRandom().address.toLowerCase();
  const at = Date.now() - 5000;
  await insertOrder({ buyerAddr: b, status: 'confirmed', events: [ev('OrderCreated', at), ev('ReceiptConfirmed', at + 1)] });
  const res = await getSignal(b);
  assertOk(res);
  assert.equal(res.body.data.sample, 1, '链不可用不影响本读数（它只读本地镜像）');
});
