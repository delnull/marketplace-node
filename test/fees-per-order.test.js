/**
 * 平台费口径 —— **按单**的创建时收费方快照（T6）。
 *
 * 契约层 2026-09：`Escrow.Order.feeCollectorAtCreate` 在**创建订单时**快照收费方，`_settle`
 * 只读这个快照；实时读全局 `feeCollector()` 被删除（owner 事后改配置不应影响在途单）。
 * 于是节点账本必须**按单**判定，否则必然与链上漂移，且两个方向都错：
 *   ① 创建时配了收取方 → 事后全局被置零：链上**照扣**（快照），账本若看全局就报"不扣" ⇒ 净额虚高；
 *   ② 创建时为 0 → 事后全局配了收取方：链上**一分不扣**，账本若看全局就按 feeBps 扣 ⇒ 净额虚低。
 * 本文件用真实 HTTP 端点（流水 / 两路 CSV / 看板 / 订单 DTO / 仲裁摘要）钉住这两条，外加：
 *   ③ 快照为空（未补录/ABI 未同步）= 未知 → 退回全局口径（保守：全局也读不到时按"会扣费"）；
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
import { makeCtx, login, assertOk } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;

const { resetFeeCache, feeChargeableForOrder, feeOf } = await import('../src/fees.js');
const config = (await import('../src/config.js')).default;

const ZERO = '0x0000000000000000000000000000000000000000';
const FC_AT_CREATE = '0x1111111111111111111111111111111111111111'; // 某单创建时的收费方
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
/** 直接插一行已入账单（费率 100bps=1%，金额 1000 wei ⇒ 名义费 10 wei） */
function insertIncome({ feeCollectorAtCreate = '', status = 'confirmed', amountWei = '1000', feeBps = 100 } = {}) {
  seq += 1;
  const id = `fee-${String(seq).padStart(3, '0')}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, cny_fen, bty_usdt_rate, usdt_cny_rate, status, escrow_order_id, paid_tx_hash,
       fee_bps, fee_collector_at_create, created_at, updated_at)
     VALUES (?, 'p-fee', '{}', '0x00', '', ?, ?, ?, 100, '0.1', '7.2', ?, ?, NULL, ?, ?, ?, ?)`
  ).run(id, buyer.address.toLowerCase(), owner.address.toLowerCase(), amountWei, status, `0x${String(seq).padStart(64, '0')}`, feeBps, feeCollectorAtCreate, now, now);
  return id;
}

/** 让下一次账本读取看到指定的"链上全局收费方" */
async function setGlobal(v) {
  globalCollector = v;
  resetFeeCache(); // 60s TTL 缓存必须清掉，否则读到上一个用例的值
}

const ledgerOf = async (q = '') => {
  const res = await request(app).get(`/api/orders/seller/ledger${q}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
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
  const id = insertIncome({ feeCollectorAtCreate: FC_AT_CREATE });
  await setGlobal(ZERO); // 链上全局现在是零地址
  const { row } = await rowInLedger(id);
  assert.equal(row.feeCollectorAtCreate, FC_AT_CREATE, 'DTO 下发创建时快照（小写）');
  assert.equal(row.feeChargeable, true, '**按单**判定：快照非零 ⇒ 这单会扣费');
  assert.equal(row.feeWei, '10', '快照说扣费 ⇒ 账本扣费（旧实现看全局零地址会报 0，净额虚高）');
  assert.equal(row.amountWeiNet, '990');

  // 订单 DTO 同样下发按单判定（前端不必猜"已扣/预计"）
  const detail = await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assert.equal(detail.body.data.feeCollectorAtCreate, FC_AT_CREATE);
  assert.equal(detail.body.data.feeChargeable, true);

  // 两路 CSV 与流水同口径（amount_net_wei / net_wei 都按快照扣除），且各自带上判据三件套
  const ledgerCsv = await request(app).get('/api/shop/export/ledger.csv').set('Authorization', `Bearer ${ownerToken}`).expect(200);
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
  const ordersCsv = await request(app).get('/api/shop/export/orders.csv').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  const oc = csvRow(ordersCsv.text, id);
  assert.equal(oc.amount_net_wei, '990', 'orders.csv amount_net_wei');
  // 两路 CSV 的同名列必须逐字一致（否则店主的月结对账会对不上）
  for (const k of ['amount_wei', 'refunded_wei', 'fee_wei', 'fee_bps', 'fee_chargeable', 'fee_basis', 'accepted_partial_refund_wei']) {
    assert.equal(oc[k], lc[k], `orders.csv 与 ledger.csv 的 ${k} 必须同源同值`);
  }
  assert.equal(oc.fee_basis, 'snapshot');
});

test('漂移方向②：创建时为 0（快照零地址）、事后全局配了收费方 → 账本一分不扣（净额不虚低）', async () => {
  const id = insertIncome({ feeCollectorAtCreate: ZERO });
  await setGlobal(FC_GLOBAL); // 全局现在配了收费方
  const { row } = await rowInLedger(id);
  assert.equal(row.feeCollectorAtCreate, ZERO, '零地址快照原样下发（它是"这单永不扣费"的证据，不是"未知"）');
  assert.equal(row.feeChargeable, false, '**按单**判定：快照是零地址 ⇒ 这单永不扣费（权威，不看全局）');
  assert.equal(row.feeWei, '0', '链上不扣 ⇒ 账本也不扣（旧实现看全局非零会扣 10，净额虚低）');
  assert.equal(row.amountWeiNet, '1000');
});

test('快照为空（未知）→ 退回全局口径；全局也读不到时按"可能扣费"保守折算', async () => {
  // ③a 未知 + 全局零地址（已知）→ 按全局口径：不扣
  const unknownZero = insertIncome({ feeCollectorAtCreate: '' });
  await setGlobal(ZERO);
  const a = await rowInLedger(unknownZero);
  assert.equal(a.row.feeCollectorAtCreate, null, '空串 → null（未知，不是"零地址"）');
  assert.equal(a.row.feeChargeable, false, '未知时退回全局口径：全局已知为零地址 ⇒ 不扣');
  assert.equal(a.row.feeWei, '0');

  // ③b 未知 + 全局非零（已知）→ 按全局口径：扣
  const unknownGlobal = insertIncome({ feeCollectorAtCreate: '' });
  await setGlobal(FC_GLOBAL);
  const b = await rowInLedger(unknownGlobal);
  assert.equal(b.row.feeChargeable, true);
  assert.equal(b.row.feeWei, '10');

  // ③c 未知 + 全局读不到（RPC 失败）→ known=false ⇒ 保守按会扣费（与 fees.js 的取舍一致）
  const unknownDown = insertIncome({ feeCollectorAtCreate: '' });
  await setGlobal('THROW');
  const c = await rowInLedger(unknownDown);
  assert.equal(c.summary.feeCollectorKnown, false, 'RPC 读不到 ⇒ 披露 known=false（前端标"预计"）');
  assert.equal(c.row.feeChargeable, true, '未知 + 读不到 ⇒ 保守按可能扣费处理');
  assert.equal(c.row.feeWei, '10');
  assert.ok(rpcCalls > 0, '全局口径确实触发了链上读取（这也是它必须只作兜底的原因）');

  /*
    ③d 两路 CSV 的判据来源如实标注（源码审计 2026-09 续）：
    没有这一列时，导出的 `fee_wei` 分不出「按本单快照确证扣了」与「快照缺失、按全局保守口径折算」——
    后者**可能**与链上实际扣费相反，而店主拿着 CSV 对账时看到的两者一模一样。
  */
  const ledOffline = await request(app).get('/api/shop/export/ledger.csv').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  const off = csvRow(ledOffline.text, unknownDown);
  assert.equal(off.fee_basis, 'fallback', '快照缺失 ⇒ 判据来源标 fallback（不得冒充 snapshot）');
  assert.equal(off.fee_chargeable, '1', '兜底保守：按会扣费折算');
  assert.equal(off.fee_wei, '10');

  // 纯函数口径与账本一致（唯一实现）
  assert.equal(feeChargeableForOrder(ZERO), false);
  assert.equal(feeChargeableForOrder(FC_AT_CREATE), true);
  assert.equal(feeChargeableForOrder(''), feeChargeableForOrder(null), '空串与 null 同义（未知 → 全局）');
  assert.equal(feeChargeableForOrder(undefined), feeChargeableForOrder(''), 'undefined 同样按未知处理');
  assert.equal(feeOf(1000n, 100, ZERO), 0n, '按单快照零地址 ⇒ 恒 0');
  assert.equal(feeOf(1000n, 100, FC_AT_CREATE), 10n, '按单快照非零 ⇒ 名义费率折算');
});

test('看板净额（GMV）同样按单快照：同一批行的净额等于逐行按单判定的和', async () => {
  await setGlobal(FC_GLOBAL); // 全局"会扣费"，用来放大"若看全局就错"的差异
  const mixed = [
    insertIncome({ feeCollectorAtCreate: ZERO, amountWei: '500' }), // 不扣
    insertIncome({ feeCollectorAtCreate: FC_AT_CREATE, amountWei: '500' }), // 扣 5
    insertIncome({ feeCollectorAtCreate: '', amountWei: '500' }), // 未知 → 全局兜底 → 扣 5
  ];
  const before = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(before);
  const expectedDelta = mixed.reduce((sum, id) => {
    const r = db.prepare('SELECT amount_wei, fee_bps, fee_collector_at_create, refunded_amount_wei FROM orders WHERE id = ?').get(id);
    const base = BigInt(r.amount_wei) - BigInt(r.refunded_amount_wei || '0');
    return sum + base - feeOf(base, r.fee_bps, r.fee_collector_at_create);
  }, 0n);
  assert.equal(expectedDelta, 500n + 495n + 495n);
  // overview 的 gmvNetWei 含全库入账单：用"再加一次同样三行"的差值验证口径（与既有行无关）
  const after2 = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(after2);
  assert.equal(
    BigInt(after2.body.data.gmvNetWei) - BigInt(before.body.data.gmvNetWei),
    0n,
    '两次调用之间没有新入账单：净额不变（快照口径稳定，不受全局值影响）'
  );
  const second = [insertIncome({ feeCollectorAtCreate: ZERO, amountWei: '500' }), insertIncome({ feeCollectorAtCreate: FC_AT_CREATE, amountWei: '500' })];
  const after3 = await request(app).get('/api/shop/stats/overview?days=0').set('Authorization', `Bearer ${ownerToken}`).expect(200);
  assertOk(after3);
  assert.equal(BigInt(after3.body.data.gmvNetWei) - BigInt(after2.body.data.gmvNetWei), 500n + 495n, '新增两行按单判定（一行不扣、一行扣 5）');
  assert.equal(second.length, 2);
});

test('仲裁摘要下发按单口径（仲裁人算"可罚没上限"时看得出这笔钱里有没有平台费）', async () => {
  await setGlobal(ZERO);
  const disputed = insertIncome({ status: 'disputed', feeCollectorAtCreate: FC_AT_CREATE });
  const res = await request(app).get('/api/arbitration/pending?pageSize=100').expect(200);
  assertOk(res);
  const row = res.body.data.disputes.find((d) => d.id === disputed);
  assert.ok(row, '争议单应进待仲裁列表');
  assert.equal(row.feeBps, 100);
  assert.equal(row.feeCollectorAtCreate, FC_AT_CREATE, '创建时快照下发');
  assert.equal(row.feeChargeable, true, '**按单**判定（全局零地址也不影响这单）');
});
