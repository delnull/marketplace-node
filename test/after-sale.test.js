/**
 * 确认收货后的**售后案件**（契约 2026-10 第二批：`Escrow.openAfterSale/closeAfterSale`）在节点侧的
 * 全部落地路径。逐条都能证伪——把对应实现回退掉就会变红：
 *
 *  1. **事件路径**（`escrowWatcher`）：`EVENTS` 清单含两个事件（漏挂 = pollOnce 永远不为它发
 *     queryFilter，链上开了案本地毫无痕迹）；`AfterSaleOpened/Closed` 只写售后案件那几列，
 *     **`orders.status` 与 `updated_at` 一个字节都不动**（案件是叠加在终局上的第二层）；重放幂等；
 *     结案说明按 500 字符截断；本地无此单 → 0 行；链上真值不符（诱饵单）→ 不落地。
 *  2. **DTO**：订单详情下发 afterSaleStatus/OpenedAt/OpenedBlock/ClosedAt/Note。
 *  3. **证据阶段**：`phase='after_sale'` 在案件在途时受理（买卖双方），结案/无案件时拒绝且文案可读；
 *     与既有三阶段共用同一个 `evidencePhaseError`。
 *  4. **退货单窗口**：终局单**当且仅当**有在途案件时可建退货单（且仍要求已交付）。
 *  5. **仲裁数据面**：`/api/arbitration/after-sales` 只列在途案件，带 `kind='after_sale'`、
 *     待办计数与最久等待时长；`/pending` 也补上了最久等待读数。
 *  6. **人工 sync 回填**：链上真值（afterSaleOpen/afterSaleOpenedAtBlock）能修事件漏扫，
 *     方向双向（补开案 / 补结案）；链上查不到该单时不乱改。
 *
 * 链上读取怎么伪造：与 test/order-sync-paths.test.js 同款——ethers v6 在 Node 下用 node:http 发
 * JSON-RPC，故起一个本地假 JSON-RPC 服务器，按**生产 ABI**（chain.js 的 ESCROW_ABI）的 selector 分发。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';
import { makeCtx, login, assertOk, shopRef, insertOrder as insertOrderRow } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, buyer, owner } = ctx;

const { applyEvent, EVENTS } = await import('../src/escrowWatcher.js');
const { ESCROW_ABI } = await import('../src/chain.js');
const { AFTER_SALE_NOTE_MAX, AFTER_SALE_STATUS, AFTER_SALE_ELIGIBLE_STATUS } = await import('../src/afterSale.js');
const { EVIDENCE_PHASES, EVIDENCE_LIMIT_BY_PHASE, EVIDENCE_PHASE_LABEL, evidencePhaseError } = await import('../src/evidenceFiles.js');
const { createReturn } = await import('../src/returns.js');
const config = (await import('../src/config.js')).default;

const BUYER = buyer.address.toLowerCase();
const SELLER = owner.address.toLowerCase();
const AMOUNT = '1000000000000000000';
const STATUS_INDEX = { None: 0, Created: 1, Disputed: 2, Settled: 3, Refunded: 4 };

// ── 假 JSON-RPC（/sync 的链上读数；按生产 ABI 的 selector 分发）──
const iface = new Interface(ESCROW_ABI);
/** 当前用例的链上售后案件真值（open/openedAtBlock + getOrder 侧字段） */
let chainCase = { open: false, openedAtBlock: 0, status: 'Settled', buyer: BUYER, seller: SELLER, amount: AMOUNT };

function handleRpc(j) {
  try {
    const to = String(j.params?.[0]?.to || '').toLowerCase();
    if (j.method !== 'eth_call' || to !== String(config.chain.escrowAddress).toLowerCase()) {
      return { error: { code: -32601, message: `unit-test: 未预期的 RPC 调用 ${j.method}` } };
    }
    const data = String(j.params?.[0]?.data || '');
    const selector = data.slice(0, 10);
    if (selector === iface.getFunction('getOrder').selector) {
      return {
        result: iface.encodeFunctionResult('getOrder', [
          chainCase.buyer,
          chainCase.seller,
          BigInt(chainCase.amount),
          120960n, // timeoutBlocks
          7n, // createdAtBlock
          false, // refundRequested
          false, // refundRejected
          chainCase.status === 'Refunded' ? BigInt(chainCase.amount) : 0n,
          STATUS_INDEX[chainCase.status],
          true, // buyerConfirmed：售后案件正是"买家确认过之后"的救济路径
        ]),
      };
    }
    if (selector === iface.getFunction('orderToken').selector) {
      // 这些夹具都是原生单；ERC20 身份由 chain-amounts.test 专门覆盖
      return {
        result: iface.encodeFunctionResult('orderToken', ['0x0000000000000000000000000000000000000000']),
      };
    }
    if (selector === iface.getFunction('acceptedPartialRefund').selector) {
      return { result: iface.encodeFunctionResult('acceptedPartialRefund', [0n]) };
    }
    if (selector === iface.getFunction('afterSaleOpen').selector) {
      return { result: iface.encodeFunctionResult('afterSaleOpen', [!!chainCase.open]) };
    }
    if (selector === iface.getFunction('afterSaleOpenedAtBlock').selector) {
      return { result: iface.encodeFunctionResult('afterSaleOpenedAtBlock', [BigInt(chainCase.openedAtBlock || 0)]) };
    }
    return { error: { code: -32601, message: `unit-test: 未预期的 selector ${selector}` } };
  } catch (e) {
    return { error: { code: -32000, message: String(e?.message || e) } };
  }
}

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const out = Array.isArray(parsed)
      ? parsed.map((j) => ({ jsonrpc: '2.0', id: j?.id ?? 1, ...handleRpc(j) }))
      : { jsonrpc: '2.0', id: parsed?.id ?? 1, ...handleRpc(parsed) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});
after(() => rpcServer.close());

let buyerToken;
let ownerToken;
/*
  假 RPC 的接线与登录都在**一个 before() 里**完成：node:test 在本文件还没求值完就可能开始跑已注册的
  用例，顶层的 `config.chain.rpcUrl = …` 会与用例体的第一次 `await` 交错（写进来的时机不确定）。
  多个顶层 before 之间也存在并发交错（见仓库测试惯例），所以只留一个。
*/
before(async () => {
  await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
  config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
  buyerToken = (await login(ctx, buyer)).token;
  ownerToken = (await login(ctx, owner)).token;
});

let seq = 0;
/**
 * 夹具：直接插订单行（状态/交付事实/案件状态由用例给）。
 *
 * 行形状交给 setup.mjs 的 `insertOrder`（订单是三张 1:1 表，`after_sale_*` / `refund_*` / 事件史
 * 住在 `order_chain`）；本文件只保留自己的默认值——终局状态、一条发货事实、每单一个唯一的链上单号。
 *
 * 返回 `{ orderId, orderNo, escrowOrderId }`：`orderId` 是内部数字主键（`v_orders` 读与子表外键用它），
 * `orderNo` 才是对外单号（接口 URL / 通知 payload 里的 `orderId` 都是它）。
 */
async function insertOrder({
  status = 'settled',
  afterSaleStatus = 'none',
  afterSaleOpenedAt = null,
  afterSaleOpenedBlock = null,
  afterSaleClosedAt = null,
  afterSaleNote = null,
  shippedAt = null,
  trackingNo = 'SF-AF-1',
  events = null,
  buyerAddr = BUYER,
  paidTxHash = undefined,
} = {}) {
  seq += 1;
  return await insertOrderRow(db, {
    buyer: buyerAddr,
    seller: SELLER,
    status,
    escrowOrderId: `0x${String(seq).padStart(64, '0')}`,
    paidTxHash: paidTxHash === undefined ? `0x${String(seq).padStart(64, 'f')}` : paidTxHash,
    productSlug: 'p-af',
    amountWei: AMOUNT,
    usdtMicro: 1000000,
    btyUsdtRate: '0.1',
    trackingNo,
    shippedAt,
    afterSaleStatus,
    afterSaleOpenedAt,
    afterSaleOpenedBlock,
    afterSaleClosedAt,
    afterSaleNote,
    events,
  });
}

const rowOf = async (orderId) => await db.get('SELECT * FROM v_orders WHERE order_id = ?', orderId);
// 事件史是 JSON 列：驱动读回来已是数组（旧形状是 TEXT，那时才需要 JSON.parse）
const eventNamesOf = async (orderId) => ((await rowOf(orderId)).onchain_events || []).map((e) => e.name);

// ── ① ABI / 事件清单 ──

test('两个售后案件事件都在生产 ABI 与 watcher 的 EVENTS 清单里（漏挂事件 = 永远扫不到）', () => {
  for (const name of ['AfterSaleOpened', 'AfterSaleClosed']) {
    assert.ok(iface.getEvent(name), `ESCROW_ABI 必须声明事件 ${name}（node/src/chain.js 须与 contracts/src/Escrow.sol 对齐）`);
    assert.ok(EVENTS.includes(name), `EVENTS 清单必须含 ${name}：${EVENTS.join(',')}`);
  }
  // 事件签名（topic0）与合约一致：写错签名 → 过滤器永远匹配不到日志（本仓踩过的静默失效）
  assert.equal(
    iface.getEvent('AfterSaleOpened').topicHash,
    new Interface(['event AfterSaleOpened(bytes32 indexed orderId, address indexed buyer, address indexed seller)']).getEvent('AfterSaleOpened').topicHash
  );
  assert.deepEqual(iface.getEvent('AfterSaleClosed').inputs.map((i) => i.type), ['bytes32', 'address', 'string']);
  // 只读视图也要在 ABI 里（/sync 与对账都靠它们读链上真值）
  for (const fn of ['afterSaleOpen', 'afterSaleOpenedAtBlock']) {
    assert.ok(iface.getFunction(fn), `ESCROW_ABI 必须声明只读函数 ${fn}`);
  }
});

test('本地状态域与库的 ENUM 同值（新状态必须显式归类，这里钉住顺序与取值）', async () => {
  assert.deepEqual([...AFTER_SALE_STATUS], ['none', 'open', 'closed']);
  /*
    售后案件那五列住在 `order_chain`（链上镜像表），不再在 `orders` 上——列的家就是这条断言的判据：
    它是"建表语句与启动期自检必须同步"的那道门禁，查错表会让它永远绿。
  */
  const cols = (await db.all(
    'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    'order_chain'
  )).map((c) => c.name);
  for (const c of ['after_sale_status', 'after_sale_opened_at', 'after_sale_opened_block', 'after_sale_closed_at', 'after_sale_note']) {
    assert.ok(cols.includes(c), `order_chain 缺列 ${c}（建表语句与启动期自检都必须同步）`);
  }
  const o = await insertOrder();
  /*
    越界值必须被**库**拒绝：`after_sale_status` 是 ENUM，STRICT 模式下越界写报 Data truncated
    （旧形状是 CHECK 约束，报的是 CHECK 失败）。db.run 返回 promise，所以断言用 rejects。
  */
  await assert.rejects(
    () => db.run("UPDATE order_chain SET after_sale_status = 'bogus' WHERE order_id = ?", o.orderId),
    /Data truncated|Incorrect|CHECK/i
  );
  // 契约允许开案的本地终局集合（refunded 永不可能：链上 NotSettledForAfterSale）
  assert.deepEqual([...AFTER_SALE_ELIGIBLE_STATUS], ['confirmed', 'settled', 'expired']);
});

// ── ② 事件路径 ──

test('AfterSaleOpened：只置 open + 时刻/区块，**不动 status/updated_at**；重放幂等、结案后不可重开', async () => {
  const o = await insertOrder({ status: 'settled' });
  const before = await rowOf(o.orderId);
  assert.equal(await applyEvent('AfterSaleOpened', { orderId: o.escrowOrderId }, { txHash: '0x' + 'a'.repeat(64), block: 777 }), 1);
  let row = await rowOf(o.orderId);
  assert.equal(row.after_sale_status, 'open');
  assert.ok(row.after_sale_opened_at instanceof Date);
  assert.equal(row.after_sale_opened_block, 777, '开案区块是链上 afterSaleOpenedAtBlock 的镜像');
  assert.equal(row.after_sale_closed_at, null);
  assert.equal(row.after_sale_note, null);
  // 这是本用例存在的核心理由：案件是叠加在终局上的第二层，不许把订单拉回在途
  assert.equal(row.status, 'settled', '售后案件不得改写 orders.status（链上 Order.status 全程停在 Settled）');
  assert.equal(row.updated_at.getTime(), before.updated_at.getTime(), '不得动 updated_at（那是入账窗口/排序锚点）');
  assert.ok((await eventNamesOf(o.orderId)).includes('AfterSaleOpened'), '链上凭证要落事件史');

  // 幂等：同一事件重放（重组回退/失败重试）不重复记账
  assert.equal(await applyEvent('AfterSaleOpened', { orderId: o.escrowOrderId }, { txHash: '0x' + 'a'.repeat(64), block: 777 }), 0);
  assert.equal((await eventNamesOf(o.orderId)).filter((n) => n === 'AfterSaleOpened').length, 1);

  // 结案是终态：链上 afterSaleClosedAtBlock 不可清除，不能再开案
  assert.equal(await applyEvent('AfterSaleClosed', { orderId: o.escrowOrderId, note: '双方和解' }, { block: 800 }), 1);
  assert.equal(await applyEvent('AfterSaleOpened', { orderId: o.escrowOrderId }, { block: 900 }), 0, '已结案的行不能被开案事件改回 open');
  row = await rowOf(o.orderId);
  assert.equal(row.after_sale_status, 'closed');
  assert.equal(row.after_sale_opened_block, 777, '旧开案区块不被重开事件覆盖');
  assert.ok(row.after_sale_closed_at instanceof Date, '结案时刻保留');
  assert.equal(row.after_sale_note, '双方和解', '结案说明保留');
  assert.equal(row.status, 'settled');
});

test('AfterSaleClosed：置 closed + 说明（截断 500）且不改状态；重放幂等；本地无此单不落地', async () => {
  const o = await insertOrder({ status: 'confirmed', afterSaleStatus: 'open', afterSaleOpenedAt: new Date(Date.now() - 1000), afterSaleOpenedBlock: 10 });
  const before = await rowOf(o.orderId);
  const longNote = 'x'.repeat(900);
  assert.equal(await applyEvent('AfterSaleClosed', { orderId: o.escrowOrderId, note: longNote }, { block: 900 }), 1);
  const row = await rowOf(o.orderId);
  assert.equal(row.after_sale_status, 'closed');
  assert.equal(row.after_sale_note.length, AFTER_SALE_NOTE_MAX, `结案说明必须截断到 ${AFTER_SALE_NOTE_MAX}（用户文本，写入口只截一次）`);
  assert.ok(row.after_sale_closed_at instanceof Date);
  assert.equal(row.status, 'confirmed', '结案同样不改订单状态');
  assert.equal(row.updated_at.getTime(), before.updated_at.getTime(), '结案同样不动 updated_at');
  // 幂等：重复投递不覆盖已有说明与时刻
  assert.equal(await applyEvent('AfterSaleClosed', { orderId: o.escrowOrderId, note: '另一份说明' }, { block: 901 }), 0);
  assert.equal((await rowOf(o.orderId)).after_sale_note.length, AFTER_SALE_NOTE_MAX);

  // 本地无此单：与其它事件分支同口径（不猜、不建行、不报错）
  assert.equal(await applyEvent('AfterSaleOpened', { orderId: '0x' + 'de'.repeat(32) }, { block: 5 }), 0);
  assert.equal(await applyEvent('AfterSaleClosed', { orderId: '0x' + 'de'.repeat(32), note: 'n' }, { block: 6 }), 0);
});

test('链上真值不符（诱饵单）：售后案件事件不落地', async () => {
  const o = await insertOrder({ status: 'settled' });
  const changed = await applyEvent(
    'AfterSaleOpened',
    { orderId: o.escrowOrderId },
    { block: 42, chainParams: { buyer: '0x' + '11'.repeat(20), seller: SELLER, amount: AMOUNT } }
  );
  assert.equal(changed, 0, '买家与本地锁定不一致 → 整条事件不落地');
  assert.equal((await rowOf(o.orderId)).after_sale_status, 'none');
});

test('开案区块只落"能安全表示"的值：ABI 解码错位送来的巨数不写库（写了就读不回精确值）', async () => {
  const { applyAfterSaleOpened } = await import('../src/afterSale.js');
  const o = await insertOrder({ status: 'settled' });
  // 这个数是"把 20 字节地址当 uint64 解"的典型产物：> 2^53，写进库之后每一次 SELECT * 都读回一个
  // 不精确的值（MySQL 驱动会把它当字符串给回来），而区块号是要拿去和链上比的读数，错一位就是对不上。
  const garbage = 8471082295291484160;
  assert.equal(await applyAfterSaleOpened(o.escrowOrderId, { block: garbage }), 1);
  const row = await rowOf(o.orderId); // 读得回来才说明库里没有超大整数
  assert.equal(row.after_sale_status, 'open');
  assert.equal(row.after_sale_opened_block, null, '不合法区块号如实落 null（区块未知），不塞进库');
  // 合法区块号照常落库
  assert.equal(await applyAfterSaleOpened(o.escrowOrderId, { block: 123456 }), 1);
  assert.equal((await rowOf(o.orderId)).after_sale_opened_block, 123456);
});

test('开案/结案都要通知店主（这笔已结清的钱可能被从保证金罚没），且 payload 不含结案说明等文本', async () => {
  const { typeForChainEvent, setWebhookSender } = await import('../src/webhook.js');
  assert.equal(typeForChainEvent('AfterSaleOpened'), 'order.after_sale_opened');
  assert.equal(typeForChainEvent('AfterSaleClosed', { note: 'x' }), 'order.after_sale_closed');

  // 真的派发一次：注入捕获型 sender（与 webhook.test.js 同款），走的是 watcher 的提交后通知路径
  const { setWebhookConfig } = await import('../src/webhook.js');
  await setWebhookConfig(shopRef.value, { url: 'https://93.184.216.34/hook/af' });
  const sent = [];
  setWebhookSender(async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  });
  const o = await insertOrder({ status: 'confirmed' });
  assert.equal(await applyEvent('AfterSaleOpened', { orderId: o.escrowOrderId }, { txHash: '0x' + 'b'.repeat(64), block: 900 }), 1);
  const t0 = Date.now();
  while (!sent.some((b) => b.type === 'order.after_sale_opened') && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const body = sent.find((b) => b.type === 'order.after_sale_opened');
  assert.ok(body, `开案必须推 order.after_sale_opened（否则店主不知道可能被罚没）：${JSON.stringify(sent)}`);
  assert.equal(body.orderId, o.orderNo);
  assert.equal(body.status, 'confirmed', 'payload 里的 status 仍是订单终局状态（案件不改它）');
  assert.ok(!('afterSaleNote' in body) && !('shippingAddress' in body), '通知 payload 走字段白名单');
});

// ── ③ DTO ──

test('订单详情下发售后案件字段（含结案说明；状态仍是终局）', async () => {
  const closed = await insertOrder({
    status: 'settled',
    afterSaleStatus: 'closed',
    afterSaleOpenedAt: new Date(1_700_000_000_000),
    afterSaleOpenedBlock: 12345,
    afterSaleClosedAt: new Date(1_700_000_100_000),
    afterSaleNote: '仲裁人：证据不足，双方线下协商',
  });
  const res = await request(app).get(`/api/orders/${closed.orderNo}`).set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(res);
  const d = res.body.data;
  assert.equal(d.status, 'settled', '案子已结，订单状态仍是终局');
  assert.equal(d.afterSaleStatus, 'closed');
  // 时间列的接口口径是 ISO-8601（库里 DATETIME(3) → 代码里 Date → JSON 按 Date.prototype.toJSON）
  assert.equal(d.afterSaleOpenedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(d.afterSaleOpenedBlock, 12345);
  assert.equal(d.afterSaleClosedAt, new Date(1_700_000_100_000).toISOString());
  assert.equal(d.afterSaleNote, '仲裁人：证据不足，双方线下协商');
  // 未开过案的单：显式 none 而不是 undefined（前端不必区分"老响应"）
  const none = await insertOrder({ status: 'escrowed' });
  const res2 = await request(app).get(`/api/orders/${none.orderNo}`).expect(200);
  assertOk(res2);
  assert.equal(res2.body.data.afterSaleStatus, 'none');
  assert.equal(res2.body.data.afterSaleNote, null);
});

// ── ④ 证据阶段 ──

test('phase=after_sale 在案件在途时买卖双方均可提交，结案/无案件时拒绝（与三阶段同一门控）', async () => {
  assert.ok(EVIDENCE_PHASES.includes('after_sale'), 'after_sale 必须进阶段白名单（同时是 DB CHECK 的取值）');
  assert.equal(EVIDENCE_PHASE_LABEL.after_sale, '售后陈述');
  assert.equal(EVIDENCE_LIMIT_BY_PHASE.after_sale, EVIDENCE_LIMIT_BY_PHASE.arbitration, '条数上限与仲裁同级（双方多次交锋）');

  const o = await insertOrder({ status: 'settled', afterSaleStatus: 'open', afterSaleOpenedAt: new Date(Date.now()), afterSaleOpenedBlock: 50 });
  const submit = (token, phase, content) =>
    request(app).post(`/api/orders/${o.orderNo}/evidence`).set('Authorization', `Bearer ${token}`).set('X-Mk-Shop', shopRef.value).send({ phase, content });

  const byBuyer = await submit(buyerToken, 'after_sale', '收到货发现是翻新机，附对比图').expect(200);
  assertOk(byBuyer);
  const byOwner = await submit(ownerToken, 'after_sale', '本店商品均为全新，愿提供进货凭证').expect(200);
  assertOk(byOwner);
  // 终局单上只放行 after_sale：退款理由/仲裁陈述仍按各自判据拒绝
  const refundPhase = await submit(buyerToken, 'refund_request', '想退款').expect(200);
  assert.notEqual(refundPhase.body.code, 0);
  const arbPhase = await submit(buyerToken, 'arbitration', '请仲裁').expect(200);
  assert.notEqual(arbPhase.body.code, 0);

  // 结案后立即停止受理（拒它的理由是"案件已结案"，不是含糊的状态文案）
  await applyEvent('AfterSaleClosed', { orderId: o.escrowOrderId, note: '已线下解决' }, { block: 60 });
  const afterClose = await submit(buyerToken, 'after_sale', '再补一句').expect(200);
  assert.notEqual(afterClose.body.code, 0);
  assert.match(afterClose.body.message, /已结案/);

  // 无案件的终局单：状态门控先拒绝（可读文案，不是"phase 不对"）
  const plain = await insertOrder({ status: 'settled' });
  const noCase = await request(app)
    .post(`/api/orders/${plain.orderNo}/evidence`)
    .set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ phase: 'after_sale', content: '无案件' })
    .expect(200);
  assert.notEqual(noCase.body.code, 0);
  assert.match(noCase.body.message, /不接受新的售后陈述/);

  // 纯函数口径（附件端点共用同一实现）
  assert.equal(evidencePhaseError(await rowOf(o.orderId), 'after_sale', 'buyer').code, 1, '已结案 → 拒绝');
  assert.equal(evidencePhaseError(await rowOf(plain.orderId), 'after_sale', 'buyer').code, 1, '无案件 → 拒绝');
});

// ── ⑤ 退货单窗口 ──

test('退货单窗口：终局单当且仅当有在途案件时可建（其它终局单给出可读拒绝原因）', async () => {
  const withCase = await insertOrder({ status: 'settled', afterSaleStatus: 'open', afterSaleOpenedAt: new Date(Date.now()), afterSaleOpenedBlock: 7 });
  const ok = await createReturn({ order: await rowOf(withCase.orderId), address: '退货仓 A', note: '请原包装退回' });
  assert.equal(ok.ok, true, '有在途案件的终局单必须能建退货单（货要寄回、需要留痕）');
  assert.equal(ok.data.status, 'open');

  const confirmedCase = await insertOrder({ status: 'confirmed', afterSaleStatus: 'open', afterSaleOpenedAt: new Date(Date.now()) });
  assert.equal((await createReturn({ order: await rowOf(confirmedCase.orderId), address: 'x' })).ok, true, 'confirmed + 案件同样放行');

  const expiredCase = await insertOrder({ status: 'expired', afterSaleStatus: 'open', afterSaleOpenedAt: new Date(Date.now()) });
  assert.equal((await createReturn({ order: await rowOf(expiredCase.orderId), address: 'x' })).ok, true, '超时释放（链上同样 Settled）也能开案');

  const noCase = await insertOrder({ status: 'settled' });
  const rejected = await createReturn({ order: await rowOf(noCase.orderId), address: 'x' });
  assert.ok(rejected.error, '无案件的终局单仍拒绝');
  assert.match(rejected.error, /在途售后案件/, '拒绝原因是可读中文，且指明唯一放行条件');

  // 已交付仍是前置：未交付的终局单即便有案件也先按"无交付记录"拒绝（占位由退款路径回补）
  const undelivered = await insertOrder({ status: 'settled', afterSaleStatus: 'open', afterSaleOpenedAt: new Date(Date.now()), trackingNo: null, shippedAt: null });
  const noDeliver = await createReturn({ order: await rowOf(undelivered.orderId), address: 'x' });
  assert.match(noDeliver.error, /无交付记录/);
});

// ── ⑥ 仲裁数据面 ──

test('仲裁台售后案件队列：只列在途案件 + 待办计数 + 最久等待时长；disputed 列表也有等待读数', async () => {
  // 同一文件里前面的用例也开过案（DB 是共享的），所以按**增量**断言队列口径
  const before = (await request(app).get('/api/arbitration/after-sales').expect(200)).body.data;
  const openOld = await insertOrder({ status: 'settled', afterSaleStatus: 'open', afterSaleOpenedAt: new Date(Date.now() - 3 * 3600_000), afterSaleOpenedBlock: 100 });
  const openNew = await insertOrder({ status: 'confirmed', afterSaleStatus: 'open', afterSaleOpenedAt: new Date(Date.now() - 60_000), afterSaleOpenedBlock: 200 });
  const closedOne = await insertOrder({ status: 'settled', afterSaleStatus: 'closed', afterSaleOpenedAt: new Date(Date.now() - 9000), afterSaleClosedAt: new Date(Date.now()), afterSaleNote: '已和解' });
  const disputed = await insertOrder({ status: 'disputed' });

  const res = await request(app).get('/api/arbitration/after-sales').expect(200);
  assertOk(res);
  const data = res.body.data;
  assert.equal(data.total, before.total + 2, '只多出 2 单在途案件（已结案的不入列）');
  // 匿名队列只给链上公开事实；本地订单号（可继续探测的句柄）只对已确证为链上仲裁人的身份下发
  const ids = data.afterSales.map((r) => r.escrowOrderId);
  assert.ok(ids.includes(openOld.escrowOrderId) && ids.includes(openNew.escrowOrderId));
  assert.ok(!ids.includes(closedOne.escrowOrderId), '结案 → 出列');
  assert.ok(!ids.includes(disputed.escrowOrderId), '争议单不进售后案件队列（两套流程互斥）');
  assert.ok(data.afterSales.every((r) => r.orderNo === null), '匿名队列不下发本地订单号');

  const row = data.afterSales.find((r) => r.escrowOrderId === openOld.escrowOrderId);
  assert.equal(row.kind, 'after_sale');
  assert.equal(row.afterSaleStatus, 'open');
  assert.equal(row.afterSaleOpenedBlock, 100);
  assert.equal(row.afterSaleNote, null);
  // 字段风格与争议队列一致（共用同一个行映射）：金额拆分/双方地址/事件史一个不少
  for (const k of ['escrowOrderId', 'buyer', 'seller', 'usdtMicro', 'goodsUsdtMicro', 'amountWei', 'refundedAmountWei', 'delivered', 'evidenceCount', 'onchainEvents']) {
    assert.ok(k in row, `售后案件条目缺字段 ${k}（必须与 /pending 同口径）`);
  }
  assert.equal(row.delivered, true, '已交付事实按 shipped_at/tracking_no/交付行三要素判');

  // 待办计数与最久等待时长：最久的那单是 3 小时前开的
  assert.equal(data.waiting.count, data.total, '待办计数 = 整队列（不分页）');
  assert.ok(!Number.isNaN(Date.parse(data.waiting.oldestAt)), '最久等待时刻对外是 ISO-8601（时长才是毫秒数）');
  assert.ok(data.waiting.oldestWaitingMs >= 3 * 3600_000 - 5000, `最久等待需覆盖 3 小时：${data.waiting.oldestWaitingMs}`);
  // 倒序：最近的在前
  assert.ok(data.afterSales[0].afterSaleOpenedAt >= data.afterSales[1].afterSaleOpenedAt);

  // disputed 列表的等待读数（轻量、只读）
  const p = await request(app).get('/api/arbitration/pending').expect(200);
  assertOk(p);
  assert.equal(p.body.data.waiting.count, p.body.data.total, '等待读数覆盖整队列（与分页 total 同源）');
  assert.ok(p.body.data.waiting.oldestWaitingMs >= 0);
  assert.equal(p.body.data.disputes[0].kind, 'dispute', '争议条目也带判别位（同一份字段口径）');
  assert.equal(p.body.data.disputes[0].afterSaleStatus, 'none', '争议单的售后案件字段恒为 none（两套流程互斥）');
});

test('卖家待办徽标含在途售后案件数（终局单不会出现在 byStatus 里）', async () => {
  const o = await insertOrder({ status: 'settled', afterSaleStatus: 'open', afterSaleOpenedAt: new Date(Date.now()) });
  const res = await request(app).get('/api/orders/seller/status-counts').set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(res);
  assert.ok(res.body.data.pendingAfterSale >= 1, `徽标必须能看见在途案件：${JSON.stringify(res.body.data)}`);
  assert.equal(res.body.data.byStatus.settled >= 1, true);

  // 徽标上的数字要能点进去：afterSale=open 列表直达在途案件（这些单的 status 是终局，按状态筛不到）
  const list = await request(app)
    .get('/api/orders/seller?afterSale=open&pageSize=100')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assertOk(list);
  const ids = list.body.data.orders.map((r) => r.id);
  assert.ok(ids.includes(o.orderNo), '在途案件必须出现在 afterSale=open 列表里');
  assert.ok(list.body.data.orders.every((r) => r.afterSaleStatus === 'open'));
  const bad = await request(app)
    .get('/api/orders/seller?afterSale=bogus')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .expect(200);
  assert.notEqual(bad.body.code, 0, '非法筛选值如实拒绝');
  assert.equal(o.after_sale_status, undefined); // insertOrder 返回的是 { orderId, orderNo, escrowOrderId }，这里只是防误用
});

// ── ⑦ 人工 sync 回填（链上真值，双向） ──

test('POST /:id/sync 按链上真值双向回填售后案件（漏扫 AfterSaleOpened/Closed 的人工兜底）', async () => {
  const o = await insertOrder({ status: 'settled' });
  // 链上已有在途案件（本地漏扫了 AfterSaleOpened）→ sync 补开案并落区块
  chainCase = { open: true, openedAtBlock: 4242, status: 'Settled', buyer: BUYER, seller: SELLER, amount: AMOUNT };
  const r1 = await request(app).post(`/api/orders/${o.orderNo}/sync`).set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(r1);
  let row = await rowOf(o.orderId);
  assert.equal(row.after_sale_status, 'open');
  assert.equal(row.after_sale_opened_block, 4242);
  assert.equal(row.status, 'settled', 'sync 回填也不动订单状态');
  assert.equal(r1.body.data.afterSaleStatus, 'open', 'DTO 同步反映');

  // 链上已结案（本地漏扫 AfterSaleClosed）→ sync 关案；链上视图没有说明，note 如实留空
  chainCase = { open: false, openedAtBlock: 0, status: 'Settled', buyer: BUYER, seller: SELLER, amount: AMOUNT };
  const r2 = await request(app).post(`/api/orders/${o.orderNo}/sync`).set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(r2);
  row = await rowOf(o.orderId);
  assert.equal(row.after_sale_status, 'closed');
  assert.ok(row.after_sale_closed_at instanceof Date);
  assert.equal(row.after_sale_note, null, '链上只读视图没有结案说明（说明只在事件里）——不编造');

  // 幂等：链上真值未变时不再改（避免噪音写）
  const closedAt = row.after_sale_closed_at;
  await request(app).post(`/api/orders/${o.orderNo}/sync`).set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assert.equal((await rowOf(o.orderId)).after_sale_closed_at.getTime(), closedAt.getTime());
});

test('sync 的安全边界：链上查不到该单时不改动本地案件状态', async () => {
  const o = await insertOrder({ status: 'settled', afterSaleStatus: 'open', afterSaleOpenedAt: new Date(Date.now()), afterSaleOpenedBlock: 11 });
  chainCase = { open: false, openedAtBlock: 0, status: 'None', buyer: BUYER, seller: SELLER, amount: AMOUNT };
  // 链上 None：sync 自身会拒绝推进（该 escrowOrderId 无托管记录），但**绝不能**顺手把案件关掉
  const res = await request(app).post(`/api/orders/${o.orderNo}/sync`).set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assert.notEqual(res.body.code, 0, '链上无该托管单：同步如实报错');
  assert.equal((await rowOf(o.orderId)).after_sale_status, 'open', '读不到 ≠ 没有案件：本地案件状态必须原样保留');
});

test('sync 不得凭空造出"已结案"：链上说无案件、本地也从未开案 ⇒ 保持 none', async () => {
  // 一次链上快照分不清"从未开案"与"开过又结了"，照写 closed 就是给每张普通终局单盖一条假历史
  const plain = await insertOrder({ status: 'settled' });
  chainCase = { open: false, openedAtBlock: 0, status: 'Settled', buyer: BUYER, seller: SELLER, amount: AMOUNT };
  const res = await request(app).post(`/api/orders/${plain.orderNo}/sync`).set('Authorization', `Bearer ${buyerToken}`).set('X-Mk-Shop', shopRef.value).expect(200);
  assertOk(res);
  const row = await rowOf(plain.orderId);
  assert.equal(row.after_sale_status, 'none', '从未开案的单同步后仍是 none');
  assert.equal(row.after_sale_closed_at, null, '不得写入结案时刻（那是一条并不存在的历史）');
  assert.equal(res.body.data.afterSaleStatus, 'none');
});
