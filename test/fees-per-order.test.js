/**
 * 平台费口径 —— **按单**的创建时收费方快照（T6）。
 *
 * 契约层 2026-09：`Escrow.Order.feeCollectorAtCreate` 在**创建订单时**快照收费方，`_settle`
 * 只读这个快照；实时读全局 `feeCollector()` 被删除（owner 事后改配置不应影响在途单）。
 * 于是节点账本必须**按单**判定，否则必然与链上漂移，且两个方向都错：
 *   ① 创建时配了收取方 → 事后全局被置零：链上**照扣**（快照），账本若看全局就报"不扣" ⇒ 净额虚高；
 *   ② 创建时为 0 → 事后全局配了收取方：链上**一分不扣**，账本若看全局就按 feeBps 扣 ⇒ 净额虚低。
 * 本文件用真实 HTTP 端点（流水 / 两路 CSV / 看板 / 订单 DTO / 仲裁摘要）钉住这两条，外加：
 *   ③ 快照为空（未补录/ABI 未同步）= **未知** → 费与净额一律"不知道"（null / CSV 留空），
 *      但披露仍如实：`fee_basis=fallback` + `feeChargeable`/`feeCollectorKnown`（界面标「预计」）；
 *   ④ 快照 → 零地址（'' 之外的零地址）是**权威的"不扣费"**，不得再退回全局。
 *
 * 全局口径怎么伪造：账本的全局兜底走 `fees.js` → chain.js 的 ethers provider，而 **ethers v6
 * 在 Node 下用 `node:http` 发 JSON-RPC（不走 globalThis.fetch）**——所以这里起本地假 RPC 服务器
 * 并把 config.chain.rpcUrl 指过去；`resetFeeCache()` 清 60s 缓存，保证每个用例读到的都是
 * 本用例设定的"链上全局值"。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';
import { makeCtx, login, assertOk, shopRef, insertOrder as insertOrderRow } from './setup.mjs';

/** 本文件夹具的抽成快照常量：零地址 = 确证这一单不抽成（与 fees.js 的三态判据同款） */
const COMMISSION_NONE = '0x0000000000000000000000000000000000000000';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const { resetFeeCache, feeChargeableForOrder, feeOf, feeOfRow } = await import('../src/fees.js');
const config = (await import('../src/config.js')).default;

const ZERO = '0x0000000000000000000000000000000000000000';
const FC_AT_CREATE = '0x1111111111111111111111111111111111111111'; // 某单创建时的收费方
/** 本文件夹具里的卖家地址（= 店主钱包）。费率内核的入参之一，见 fees.feeOfRow */
const SELLER = '0x2222222222222222222222222222222222222222';
const FC_GLOBAL = '0x9999999999999999999999999999999999999999'; // 全局（现在配的）收费方

let ownerToken;
ownerToken = (await login(ctx, owner)).token;

/*
  假 RPC：只回答 `feeCollector()`（账本的全局兜底口径）。
  `globalCollector` 三态：地址 / ZERO / 'THROW'（模拟读不到 ⇒ known=false ⇒ 保守按会扣费）。
*/
let globalCollector = ZERO;
let rpcCalls = 0;
const FEE_IFACE = new Interface(['function feeCollector() view returns (address)']);
const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    rpcCalls += 1;
    const j = JSON.parse(body || '{}');
    let payload;
    if (globalCollector === 'THROW') payload = { error: { code: -32000, message: 'unit-test: RPC 读取失败' } };
    else payload = { result: FEE_IFACE.encodeFunctionResult('feeCollector', [globalCollector]) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id ?? 1, ...payload }));
  });
});
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
after(() => rpcServer.close());

let seq = 0;
/**
 * 直接插一行已入账单（费率 100bps=1%，金额 1000 wei ⇒ 名义费 10 wei）。
 *
 * 同时落**抽成条款快照**（`commission_to = 零地址` = 确证这一单不抽成）：
 * 本文件验的是平台费那条腿，抽成腿必须显式落成"确证 0"而不是留空——
 * 留空在三态判据里是**未知**，而"未知"会让净额整体变成 null（三级分账下任一条腿未知即净额未知），
 * 于是这些用例会以"净额是 null"的形式失败，看起来像平台费算错了。
 */
async function insertIncome({ feeCollectorAtCreate = null, status = 'confirmed', amountWei = '1000', feeBps = 100 } = {}) {
  seq += 1;
  const row = await insertOrderRow(db, {
    status,
    productSlug: 'p-fee',
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    amountWei,
    usdtMicro: 1000000,
    btyUsdtRate: '0.1',
    escrowOrderId: `0x${String(seq).padStart(64, '0')}`,
    paidTxHash: null,
    feeBps,
    // NULL = 从未补录（三态里的"未知"）；确证"不扣费"要写零地址
    feeCollectorAtCreate,
    commissionTo: COMMISSION_NONE,
  });
  return row.orderNo;
}

/** 让下一次账本读取看到指定的"链上全局收费方" */
async function setGlobal(v) {
  globalCollector = v;
  resetFeeCache(); // 60s TTL 缓存必须清掉，否则读到上一个用例的值
}

const ledgerOf = async (q = '') => {
  const res = await request(app).get(`/api/orders/seller/ledger${q}`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(res);
  return res.body.data;
};
const rowInLedger = async (id) => {
  const data = await ledgerOf('?pageSize=100');
  const row = data.orders.find((o) => o.id === id);
  assert.ok(row, `流水里应有 ${id}`);
  return { row, summary: data.summary };
};
/**
 * CSV 正文按**列名**取值（BOM + CRLF）。
 *
 * 为什么按列名而不是按下标（源码审计 2026-09 续）：原先 `csvCells(text, id)[5]` 这种写法
 * 在本轮给两个 CSV 补列（fee_bps / fee_chargeable / fee_basis / accepted_partial_refund_wei）
 * 后**立刻指错了列**——这里幸好新旧值不同（0 vs 990）才当场报错；若两列的值恰好相等，
 * 断言就会安静地通过，而它检查的根本不是它声称的那一列。
 * 改成表头映射后，加列只是加断言，不会再让既有断言悄悄改指向。
 */
const csvRow = (text, id) => {
  const lines = text.replace(/^\uFEFF/, '').split('\r\n');
  const header = lines[0].split(',');
  const line = lines.find((l) => l.startsWith(id + ','));
  assert.ok(line, `CSV 里应有 ${id}`);
  const cells = line.split(',');
  const out = {};
  header.forEach((h, i) => {
    out[h] = cells[i];
  });
  // 表头与数据列数必须一致：少一列说明某处数组错位（这类错位在 CSV 里不会报错，只会串列）
  assert.equal(cells.length, header.length, `CSV 行列数与表头一致（${id}）`);
  return out;
};

test('漂移方向①：创建时配了收费方、事后全局被置零 → 账本仍按快照扣费（净额不虚高）', async () => {
  const id = await insertIncome({ feeCollectorAtCreate: FC_AT_CREATE });
  await setGlobal(ZERO); // 链上全局现在是零地址
  const { row } = await rowInLedger(id);
  assert.equal(row.feeCollectorAtCreate, FC_AT_CREATE, 'DTO 下发创建时快照（小写）');
  assert.equal(row.feeChargeable, true, '**按单**判定：快照非零 ⇒ 这单会扣费');
  assert.equal(row.feeWei, '10', '快照说扣费 ⇒ 账本扣费（旧实现看全局零地址会报 0，净额虚高）');
  assert.equal(row.amountWeiNet, '990');

  // 订单 DTO 同样下发按单判定（前端不必猜"已扣/预计"）
  const detail = await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assert.equal(detail.body.data.feeCollectorAtCreate, FC_AT_CREATE);
  assert.equal(detail.body.data.feeChargeable, true);
  assert.equal(detail.body.data.feeBps, 100, '订单 DTO 的快照费率（确证值）');

  // 两路 CSV 与流水同口径（amount_net_wei / net_wei 都按快照扣除），且各自带上判据三件套
  const ledgerCsv = await request(app).get('/api/shop/export/ledger.csv').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  const lc = csvRow(ledgerCsv.text, id);
  assert.equal(lc.fee_wei, '10', 'ledger.csv fee_wei');
  assert.equal(lc.net_wei, '990', 'ledger.csv net_wei');
  assert.equal(lc.fee_bps, '100', 'ledger.csv 带订单级费率快照（店主可手算复核）');
  assert.equal(lc.fee_chargeable, '1', 'ledger.csv 按单判据：快照非零 ⇒ 扣费');
  assert.equal(lc.fee_basis, 'snapshot', 'ledger.csv 判据来源=创建时快照（不是全局兜底折算）');
  assert.equal(lc.accepted_partial_refund_wei, '0', '未授权部分退款 ⇒ 0（这是一条结论）');
  assert.equal(lc.amount_wei, '1000');
  assert.equal(lc.refunded_wei, '0');
  // 行内自洽：net = amount − refunded − fee（店主在 Excel 里能算回来）
  assert.equal(
    BigInt(lc.net_wei),
    BigInt(lc.amount_wei) - BigInt(lc.refunded_wei) - BigInt(lc.fee_wei),
    'ledger.csv 一行内可自证净额'
  );
  const ordersCsv = await request(app).get('/api/shop/export/orders.csv').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  const oc = csvRow(ordersCsv.text, id);
  assert.equal(oc.amount_net_wei, '990', 'orders.csv amount_net_wei');
  // 两路 CSV 的同名列必须逐字一致（否则店主的月结对账会对不上）
  for (const k of ['amount_wei', 'refunded_wei', 'fee_wei', 'fee_bps', 'fee_chargeable', 'fee_basis', 'accepted_partial_refund_wei']) {
    assert.equal(oc[k], lc[k], `orders.csv 与 ledger.csv 的 ${k} 必须同源同值`);
  }
  assert.equal(oc.fee_basis, 'snapshot');
});

test('漂移方向②：创建时为 0（快照零地址）、事后全局配了收费方 → 账本一分不扣（净额不虚低）', async () => {
  const id = await insertIncome({ feeCollectorAtCreate: ZERO });
  await setGlobal(FC_GLOBAL); // 全局现在配了收费方
  const { row } = await rowInLedger(id);
  assert.equal(row.feeCollectorAtCreate, ZERO, '零地址快照原样下发（它是"这单永不扣费"的证据，不是"未知"）');
  assert.equal(row.feeChargeable, false, '**按单**判定：快照是零地址 ⇒ 这单永不扣费（权威，不看全局）');
  assert.equal(row.feeWei, '0', '链上不扣 ⇒ 账本也不扣（旧实现看全局非零会扣 10，净额虚低）');
  assert.equal(row.amountWeiNet, '1000');
});

test('快照为空（未回填）⇒ 费与净额**未知**（null / CSV 留空），不再按全局折算出一个具体数字', async () => {
  /*
    ③ 的语义在 2026-10-14 变了，变的是**数字怎么来**，不是披露：
    旧实现拿"全局 feeCollector 现在配没配"去替一行**没有费率快照**的单折算出一个具体费用
    （`fee_bps` 是列默认值 0 还是别的值无从分辨），折出来的数与链上按快照扣的数可能相反。
    现在这一档一律 null/留空（不知道就是不知道），而"判据来自兜底"这件事仍如实披露
    （`fee_basis=fallback` + `feeChargeable`/`feeCollectorKnown`），界面据此标「预计」而不是「已扣」。
  */
  // ③a 未知 + 全局零地址（已知）→ 披露"按全局口径不扣"，但金额仍是"不知道"
  const unknownZero = await insertIncome({ feeCollectorAtCreate: null, feeBps: 0 });
  await setGlobal(ZERO);
  const a = await rowInLedger(unknownZero);
  assert.equal(a.row.feeCollectorAtCreate, null, 'NULL → null（未知，不是"零地址"）');
  assert.equal(a.row.feeBps, null, '费率快照未回填 ⇒ feeBps=null（绝不落成 0%）');
  assert.equal(a.row.feeChargeable, false, '未知时退回全局口径：全局已知为零地址 ⇒ 不扣');
  assert.equal(a.row.feeWei, null, '算不出来 ⇒ null（旧实现这里写 0，等于替链上宣布不扣费）');
  assert.equal(a.row.amountWeiNet, null, '净额随之未知');

  // ③b 未知 + 全局非零（已知）→ 旧实现会按全局口径折出一个具体数字，现在只披露、不给数
  const unknownGlobal = await insertIncome({ feeCollectorAtCreate: null, feeBps: 0 });
  await setGlobal(FC_GLOBAL);
  const b = await rowInLedger(unknownGlobal);
  assert.equal(b.row.feeChargeable, true, '披露：兜底口径下"可能会扣"');
  assert.equal(b.row.feeWei, null, '但费率本身没回填 ⇒ 具体费用是"不知道"，不编一个数');

  // ③c 未知 + 全局读不到（RPC 失败）→ known=false ⇒ 保守按会扣费（与 fees.js 的取舍一致）
  const unknownDown = await insertIncome({ feeCollectorAtCreate: null, feeBps: 0 });
  await setGlobal('THROW');
  const c = await rowInLedger(unknownDown);
  assert.equal(c.summary.feeCollectorKnown, false, 'RPC 读不到 ⇒ 披露 known=false（前端标"预计"）');
  assert.equal(c.row.feeChargeable, true, '未知 + 读不到 ⇒ 保守按可能扣费处理');
  assert.equal(c.row.feeWei, null);
  assert.ok(rpcCalls > 0, '全局口径确实触发了链上读取（这也是它必须只作兜底的原因）');

  /*
    ③d 两路 CSV 的判据来源如实标注（源码审计 2026-09 续；2026-10-14 补：金额单元格同样三态）：
    没有 `fee_basis` 列时，导出的 `fee_wei` 分不出「按本单快照确证扣了」与「快照缺失、判据只是兜底」——
    后者**可能**与链上实际扣费相反，而店主拿着 CSV 对账时看到的两者一模一样。
  */
  const ledOffline = await request(app).get('/api/shop/export/ledger.csv').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  const off = csvRow(ledOffline.text, unknownDown);
  assert.equal(off.fee_basis, 'fallback', '快照缺失 ⇒ 判据来源标 fallback（不得冒充 snapshot）');
  assert.equal(off.fee_chargeable, '1', '兜底保守：按会扣费折算');
  assert.equal(off.fee_wei, '', '费率未回填 ⇒ 金额单元格留空（Excel 里是"没有值"），不写 0');
  assert.equal(off.net_wei, '', '净额同理留空');
  assert.equal(off.fee_bps, '', '费率单元格也留空（0 会被读成"确证不扣费"）');

  // 纯函数口径与账本一致（唯一实现）
  assert.equal(feeChargeableForOrder(ZERO), false);
  assert.equal(feeChargeableForOrder(FC_AT_CREATE), true);
  assert.equal(feeChargeableForOrder(''), feeChargeableForOrder(null), '空串与 null 同义（未知 → 全局）');
  assert.equal(feeChargeableForOrder(undefined), feeChargeableForOrder(''), 'undefined 同样按未知处理');
  /*
    三态内核（fees.feeOfRow 的消费口）：判据是"两列成对补录"，快照缺失 ⇒ null。
    ⚠️ 缺失只有 **NULL** 一种拼法（旧形状用空串兼表"从未补录"；现在 '' 是一个货真价实的取值，
    会在 `feeSnapshotReadOf` 里被读成"已知、收取方为空"，从而算出 0 而不是"不知道"）。
    ⚠️ 行里**必须带 `seller`**（2026-10-16）：「这一单扣不扣费」的链上判据含"收取方 != 卖家"，
    所以内核的入参多了卖家一项。判据只在内核里，调用点不做判断（`feeOf` 已不导出）。
  */
  const rowOf = (fee_bps, fee_collector_at_create, seller = SELLER) => ({ fee_bps, fee_collector_at_create, seller });
  assert.equal(feeOfRow(1000n, rowOf(0, null)), null, '未回填 ⇒ 不知道');
  assert.equal(feeOfRow(1000n, rowOf(100, ZERO)), 0n, '确证不扣费 ⇒ 0n（是结论，不是未知）');
  assert.equal(feeOfRow(1000n, rowOf(100, FC_AT_CREATE)), 10n, '快照非零 ⇒ 名义费率折算');
  /*
    **平台不向自己收费**（镜像链上 `Escrow._splitOf`，2026-10-16）：收款方就是本单卖家时，
    链上实收平台费恒为 0。缺这一条时链下会按 feeBps 扣出一个数 ⇒ 店主流水/导出 CSV/看板/
    仲裁台的净额全部偏低一个平台费，而链上对账用同一把错尺子 ⇒ **永远对不出来**。
  */
  assert.equal(feeOfRow(1000n, rowOf(100, SELLER)), 0n, '收款方 == 卖家 ⇒ 平台不向自己收费（链上判据的镜像）');
  assert.equal(feeOfRow(1000n, rowOf(100, SELLER.toUpperCase().replace('0X', '0x'))), 0n, '同一地址的大小写写法不影响判据');
  assert.equal(feeOfRow(1000n, rowOf(0, SELLER)), 0n, '费率 0 且收款方 == 卖家 ⇒ 仍是 0（两条判据各自成立）');

  /*
    补录两列（真实系统里 /paid、watcher、/sync 都是成对写）之后，汇总自己恢复成具体数字——
    判据是数据，不是开关：本文件后面的用例因此仍然能比较"具体金额"。
  */
  /*
    "补录"这一刻的夹具：把**费率未回填**的行落成"确证不扣费"（零地址），抽成腿同样落成确证 0。
    WHERE 只看 `fee_collector_at_create = ''`（费率那两列的"未回填"标记就是它）；
    **不要**把 commission_to 也写进 WHERE：那两列是**独立**的三态，抽成腿可能早已确证，
    拿它当筛选条件会让这条语句一行都匹配不到（夹具静默失效，看起来像被测代码算错）。
  */
  await db.run("UPDATE orders SET fee_bps = 0, fee_collector_at_create = ?, commission_to = ? WHERE fee_collector_at_create IS NULL", ZERO, COMMISSION_NONE);
  const healed = await rowInLedger(unknownDown);
  assert.equal(healed.row.feeWei, '0', '补录后：确证不扣费 ⇒ 0（这是结论，不是"不知道"）');
  assert.notEqual(healed.summary.feeWei, null);

  /*
    订单详情这一腿同样必须是三态（2026-10-15 补）：收据/订单卡读的就是这个字段，
    它的 null 会让界面印「费率待读取」而不是「本单费率快照为 0」——后者是替链上下的结论。
    （上面那次"补录"把此前所有空快照的行都填了，所以这里新插两行来对拍。）
  */
  const dtoUnknown = await insertIncome({ feeCollectorAtCreate: null, feeBps: 0 });
  const detailUnknown = await request(app).get(`/api/orders/${dtoUnknown}`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assert.equal(detailUnknown.body.data.feeBps, null, '未回填 ⇒ 订单 DTO 的 feeBps = null');
  assert.equal(detailUnknown.body.data.feeCollectorAtCreate, null, '同一响应里的收取方也如实为 null（两列同生共死）');
  const dtoKnown = await insertIncome({ feeCollectorAtCreate: ZERO, feeBps: 0 });
  const detailKnown = await request(app).get(`/api/orders/${dtoKnown}`).set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assert.equal(detailKnown.body.data.feeBps, 0, '确证不扣费 ⇒ 0（是结论，不是未知）');
  // 验完就把那行补录掉：本用例只借它证明 DTO 的三态，别让后面的聚合用例看见一行"未知"
  await db.run('UPDATE orders SET fee_bps = 0, fee_collector_at_create = ?, commission_to = ? WHERE order_no = ?', ZERO, COMMISSION_NONE, dtoUnknown);
});

test('看板净额（GMV）同样按单快照：同一批行的净额等于逐行按单判定的和', async () => {
  await setGlobal(FC_GLOBAL); // 全局"会扣费"，用来放大"若看全局就错"的差异
  const mixed = [
    await insertIncome({ feeCollectorAtCreate: ZERO, amountWei: '500' }), // 不扣
    await insertIncome({ feeCollectorAtCreate: FC_AT_CREATE, amountWei: '500' }), // 扣 5
  ];
  const before = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(before);
  /*
    夹具自检：两行的净额 = 500（不扣费）+ 495（扣 5）。
    必须**逐行累加**而不是 `reduce(async …)`：`db.get` 走 mysql2 池，是异步的，
    异步 reducer 的累加器本身就是一个 Promise —— `assert.equal` 拿到的是
    "Promise ≠ 995n"，而它读起来像"看板净额算错了"。
  */
  let expectedDelta = 0n;
  for (const id of mixed) {
    /*
      走 **`feeOfRow`（唯一出口）** 而不是自己拼内核参数：`feeOf` 已不再导出（2026-10-16），
      这正是原因——账本断言必须与产品走同一条路径，否则"测试自己算一遍"会把
      「漏了一条判据」算成一致（本轮的平台自收判据就是这种形状）。
      行里必须带 `seller`（内核判据的输入），所以 SELECT 里明确取它。
    */
    const r = await db.get('SELECT amount_wei, seller, fee_bps, fee_collector_at_create, refunded_amount_wei FROM v_orders WHERE order_no = ?', id);
    const base = BigInt(r.amount_wei) - BigInt(r.refunded_amount_wei || '0');
    expectedDelta += base - feeOfRow(base, r);
  }
  assert.equal(expectedDelta, 500n + 495n);
  // overview 的 gmvNetWei 含全库入账单：用"再加一次同样三行"的差值验证口径（与既有行无关）
  const after2 = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(after2);
  assert.equal(
    BigInt(after2.body.data.gmvNetWei) - BigInt(before.body.data.gmvNetWei),
    0n,
    '两次调用之间没有新入账单：净额不变（快照口径稳定，不受全局值影响）'
  );
  const second = [await insertIncome({ feeCollectorAtCreate: ZERO, amountWei: '500' }), await insertIncome({ feeCollectorAtCreate: FC_AT_CREATE, amountWei: '500' })];
  const after3 = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(after3);
  assert.equal(BigInt(after3.body.data.gmvNetWei) - BigInt(after2.body.data.gmvNetWei), 500n + 495n, '新增两行按单判定（一行不扣、一行扣 5）');
  assert.equal(second.length, 2);
});

test('仲裁摘要下发按单口径（仲裁人算"可罚没上限"时看得出这笔钱里有没有平台费）', async () => {
  await setGlobal(ZERO);
  const disputed = await insertIncome({ status: 'disputed', feeCollectorAtCreate: FC_AT_CREATE });
  const res = await request(app).get('/api/arbitration/pending?pageSize=100').expect(200);
  assertOk(res);
  // 匿名队列只下发链上公开事实（`escrowOrderId`）；本地订单号只给已确证是链上仲裁人的身份。
  // `insertIncome` 内部按 `seq` 生成 escrowOrderId，所以这里用同一个序号复算（它返回的是 orderNo）。
  const escrowId = `0x${String(seq).padStart(64, '0')}`;
  const row = res.body.data.disputes.find((d) => d.escrowOrderId === escrowId);
  assert.ok(row, '争议单应进待仲裁列表');
  assert.equal(row.orderNo, null, '匿名队列不下发本地订单号');
  assert.equal(row.feeBps, 100);
  assert.equal(row.feeCollectorAtCreate, FC_AT_CREATE, '创建时快照下发');
  assert.equal(row.feeChargeable, true, '**按单**判定（全局零地址也不影响这单）');
});
