/**
 * 卡密自动交付（autoDeliver）：数字商品（卡密/兑换码）订单进入 escrowed 后
 * 自动从码池分配未用码置 shipped——无需卖家手动发货。
 *
 * 覆盖两条触发路径：
 *  - watcher 权威路径：applyEvent('OrderCreated') 回写 escrowed 后自动发码（异步）；
 *  - paid 快路径：与 POST /:id/paid 调**同一个** `tryAutoDeliverByEscrowOrder`（见 deliveryOnPaid）。
 * 并验证不自动交付场景（无码池/实物/MK_AUTO_DELIVER=0）与幂等性。
 *
 * 2026-10-14：`tryAutoDeliverById`（按**本地 id** 发码、只读镜像 `refund_status`）已整条删除。
 * 它不是一个"少一层校验"的变体，而是同一个问题的**第二个答案层**——`/paid` 按镜像判、
 * watcher 按链上判，而两者在 `finalityBlocks` 那个窗口里必然给出相反结论。用例里不再有
 * 按本地 id 发码的入口，交付的输入统一是**链上单号**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
// 同买家同商品可多次购买（v2：orderId 含 UUID 随机化）
const buyer2 = Wallet.createRandom();
// 模拟链上规范哈希（watcher 落库与 paid 收据同值）
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');
// 注意：须在 makeCtx（注入测试 env）之后动态 import，config 单例才会读到测试店主地址
const { applyEvent } = await import('../src/escrowWatcher.js');
const { tryAutoDeliverByEscrowOrder } = await import('../src/autoDeliver.js');
/** 链上真值注入点（唯一实现见 src/chainOrder.js）：补货补跑要按链上当前状态决定发不发码 */
const { setChainOrderFetcher } = await import('../src/chainOrder.js');

/**
 * `/paid` 快路径实际调用的就是这一句（见 routes/orders.js 的 paid 分支）：
 * 按**链上单号**走唯一的交付入口，而不是按本地 id。
 *
 * 交付现在**必须**先读一次链上真值，所以本进程默认装了链上桩（见下方 `setChainOrderFetcher`）。
 */
const deliveryOnPaid = (order) => tryAutoDeliverByEscrowOrder(order.escrowOrderId);

/**
 * 默认把"链上真值"设为「仍在托管、未申请退款」——补货补跑会逐单复核链上状态，
 * 没有这个桩时它会因为读不到链而**跳过**（fail-safe），那样测的就不是补发逻辑了。
 * 需要伪造"链上已申请退款/读不到"的用例自行覆盖并还原。
 */
const chainSaysOpen = () => ({ status: 'Created', refundRequested: false, refundRejected: false, refundedAmount: '0' });

/*
  本进程的**默认**链上桩（见上）。交付与补货补跑都要先读链上真值，而单测里
  `MK_RPC_URL=127.0.0.1:1` 必然连不上 ⇒ 不装桩就全都走 fail-safe 分支，
  测的就不再是交付逻辑了。用例要伪造别的链上状态就在自己内部覆盖，结束时还原成它。
*/
setChainOrderFetcher(chainSaysOpen);

/**
 * 等一次**异步**自动交付落定（2026-10-13 起 watcher 路径要先读一次链上真值再决定发不发码，
 * 所以 afterCommit 里那次交付不再是同步完成的）。轮询而不是固定 sleep：机器快慢不影响结论。
 */
async function waitStatus(id, want, ms = 800) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (rowOf(id).status === want) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return rowOf(id).status === want;
}

/** 上架数字商品并返回 { ownerToken, slug } */
async function listDigital(overrides = {}) {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send(productPayload(overrides))
    .expect(200);
  assertOk(res);
  return { ownerToken: ownerLogin.token, slug: res.body.data.slug };
}

/** 给商品导入码池，返回导入的码数组 */
async function importCodes(ownerToken, slug, codes) {
  const res = await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes })
    .expect(200);
  assertOk(res);
  return codes.slice(0, res.body.data.imported);
}

/** 下单返回订单（含 escrowOrderId/status）；店主代买家下单 */
async function createDraft(slug, who = buyer.address) {
  const ownerLogin = await login(ctx, owner);
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerLogin.token}`)
    .send({ productSlug: slug, buyer: who })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 下单后置 escrowed 并落支付凭证哈希（模拟 watcher/paid 已回写——escrowed 必有凭证，见 orders.js 头注释） */
async function escrowedOrder(slug, who = buyer.address) {
  const order = await createDraft(slug, who);
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), order.id);
  return order;
}

function rowOf(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

/** 订单交付行内容列表（v2 子表，按登记序） */
function itemsOf(id) {
  return db
    .prepare('SELECT value FROM order_delivery_items WHERE order_id = ? ORDER BY id ASC')
    .all(id)
    .map((r) => r.value);
}

// ── watcher 权威路径：OrderCreated 回写 → 自动发码 ──

test('watcher 路径：OrderCreated 回写 escrowed 后，数字商品自动从码池发码置 shipped', async () => {
  const { ownerToken, slug } = await listDigital();
  await importCodes(ownerToken, slug, ['AUTO-KEY-1', 'AUTO-KEY-2']);

  const draft = await createDraft(slug);
  assert.equal(draft.status, 'draft');

  // 模拟 watcher 轮询到链上 OrderCreated 事件（draft → escrowed 且自动交付；
  // 事件带链上交易哈希，回写时同步落为支付凭证）。
  // 2026-10-13 起这条路径会**先读一次链上真值**（Created 且未申请退款）才发码，故注入链上桩。
  setChainOrderFetcher(chainSaysOpen);
  const changed = applyEvent('OrderCreated', { orderId: draft.escrowOrderId }, { txHash: payHash(), block: 100 });
  assert.equal(changed, 1);
  assert.ok(await waitStatus(draft.id, 'shipped'), '卡密订单托管成功应自动置 shipped');
  setChainOrderFetcher(chainSaysOpen);

  const row = rowOf(draft.id);
  const vals = itemsOf(draft.id);
  assert.equal(vals.length, 1, '数量 1 自动交付 1 行');
  assert.ok(['AUTO-KEY-1', 'AUTO-KEY-2'].includes(vals[0]), '应分配码池内未用码');
  assert.equal(row.tracking_no, null);

  // 池内该码应标记 used 并关联本单
  const used = db
    .prepare('SELECT * FROM product_codes WHERE code = ? AND status = ?')
    .get(vals[0], 'used');
  assert.ok(used, '自动交付后码应标记 used');
  assert.equal(used.order_id, draft.id);

  // 买家本人登录可见码
  const buyerLogin = await login(ctx, buyer);
  const mine = await request(app)
    .get(`/api/orders/${draft.id}`)
    .set('Authorization', `Bearer ${buyerLogin.token}`)
    .expect(200);
  assert.equal(mine.body.data.status, 'shipped');
  assert.equal(mine.body.data.deliveries[0].value, vals[0]);
});

/**
 * 源码评审 2026-10-13（P1）：watcher 的 OrderCreated 路径此前是**唯一**不做链上复核的自动交付入口，
 * 只读本地镜像 `refund_status`。而镜像天然滞后：扫描上界是 `head − finalityBlocks`（默认 12 块），
 * 买家付款后在 `N+1…N+12` 里补一笔 `requestRefund` 时，本地镜像仍是 `none`、`behind` 也为假
 * ⇒ 码照发、钱却冻在托管里（`refundRequested` 让 `releaseExpired` 一直 revert），正是本仓
 * 注释里写的"双损"。
 *
 * 2026-10-14 补：当时只把这条路径改成读链上，**`/paid` 那条仍然是按本地镜像判的**，
 * 而 `/paid` 恰恰是唯一落在那个滞后窗口正中间的入口 ⇒ 同一个洞从另一个入口原样复现。
 * 现在交付入口只剩"按链上单号"这一个（见下方 paid 快路径的用例）。
 */
test('watcher 路径：链上已申请退款（本地镜像尚未落地）不得自动发码', async () => {
  const { ownerToken, slug } = await listDigital({ title: 'watcher 冻结商品' });
  await importCodes(ownerToken, slug, ['FROZEN-KEY-1']);

  const draft = await createDraft(slug);
  // 链上说"已冻结"，而本地镜像仍是 none —— 这正是那 12 块窗口里的真实状态
  setChainOrderFetcher(() => ({ status: 'Created', refundRequested: true, refundRejected: false, refundedAmount: '0' }));
  assert.equal(applyEvent('OrderCreated', { orderId: draft.escrowOrderId }, { txHash: payHash(), block: 100 }), 1);
  assert.equal(await waitStatus(draft.id, 'shipped', 120), false, '链上已冻结：不得置 shipped');
  setChainOrderFetcher(chainSaysOpen);

  assert.equal(rowOf(draft.id).status, 'escrowed', '链上已申请退款 ⇒ 不得发码，保留 escrowed 等卖家处置');
  assert.deepEqual(itemsOf(draft.id), [], '不得写入任何交付行');
  const stillUnused = db.prepare("SELECT status FROM product_codes WHERE code = 'FROZEN-KEY-1'").get();
  assert.equal(stillUnused.status, 'unused', '码必须留在池里');
});

test('watcher 路径：链上真值读不到时**不发码**（fail-safe，宁可留给卖家手动交付）', async () => {
  const { ownerToken, slug } = await listDigital({ title: 'watcher 读不到链商品' });
  await importCodes(ownerToken, slug, ['NORPC-KEY-1']);

  const draft = await createDraft(slug);
  setChainOrderFetcher(() => {
    throw new Error('rpc down');
  });
  assert.equal(applyEvent('OrderCreated', { orderId: draft.escrowOrderId }, { txHash: payHash(), block: 100 }), 1);
  await new Promise((r) => setTimeout(r, 40));
  setChainOrderFetcher(chainSaysOpen);

  assert.equal(rowOf(draft.id).status, 'escrowed', '看不清链上状态时不发码');
  assert.deepEqual(itemsOf(draft.id), []);
});

// ── paid 快路径（与 POST /:id/paid 钩子同逻辑）──

test('paid 快路径：escrowed 后按链上单号自动发码，两单各得一码不重复', async () => {
  const { ownerToken, slug } = await listDigital();
  const codes = await importCodes(ownerToken, slug, ['PAID-KEY-1', 'PAID-KEY-2']);
  assert.equal(codes.length, 2);

  const o1 = await escrowedOrder(slug);
  assert.equal(await deliveryOnPaid(o1), true, 'paid 钩子应触发自动交付');
  const r1 = rowOf(o1.id);
  assert.equal(r1.status, 'shipped');

  const o2 = await escrowedOrder(slug, buyer2.address); // 同商品第二单：任意买家均可重复下单（v2 无防重）
  assert.equal(await deliveryOnPaid(o2), true);
  const r2 = rowOf(o2.id);
  assert.equal(r2.status, 'shipped');
  assert.notEqual(itemsOf(o1.id)[0], itemsOf(o2.id)[0], '两单不应收到同一码');

  const left = db
    .prepare("SELECT COUNT(*) AS c FROM product_codes WHERE product_id = ? AND status = 'unused'")
    .get(r1.product_id).c;
  assert.equal(left, 0, '池内两码应全部发放完毕');
});

// ── 不自动交付的场景 ──

/**
 * `/paid` 快路径的判据**必须在链上**（2026-10-14，本文件要钉住的那条不变量）。
 *
 * 现场：买家 `createOrder` 之后、`/paid` 返回之前补一笔 `requestRefund`。那一刻本地镜像
 * 按定义还没跟上（watcher 的扫描上界是 `head − finalityBlocks`，默认 12 块 ≈ 1 分钟），
 * 所以"链上已冻结、镜像仍是 none"是这条路上**正常**的状态，不是异常。
 *
 * 现场此前会发出码：`/paid` 调的是按**本地 id** 的 `tryAutoDeliverById`（只读镜像）。
 * 现在交付只有"按链上单号"这一个入口 —— 这条用例把镜像故意留在 `none`，
 * 断言码**留在池里、订单留在 escrowed**。
 */
test('paid 快路径：链上已申请退款而本地镜像尚未落地时，不得自动发码（判据在链上）', async () => {
  const { ownerToken, slug } = await listDigital({ title: 'paid 冻结商品' });
  await importCodes(ownerToken, slug, ['PAID-FROZEN-1']);
  const order = await escrowedOrder(slug);

  // 链上真值：买家已 requestRefund；本地镜像**刻意不动**（仍是 none）——正是那 12 块的现场
  setChainOrderFetcher(() => ({ status: 'Created', refundRequested: true, refundRejected: false, refundedAmount: '0' }));
  try {
    assert.equal(rowOf(order.id).refund_status, 'none', '前置：本地镜像尚未落地（这就是滞后窗口）');
    assert.equal(await deliveryOnPaid(order), false, '链上已冻结 ⇒ /paid 不得发码');
  } finally {
    setChainOrderFetcher(chainSaysOpen);
  }

  assert.equal(rowOf(order.id).status, 'escrowed', '订单保持 escrowed 等卖家处置');
  assert.deepEqual(itemsOf(order.id), [], '不得写入任何交付行');
  assert.equal(
    db.prepare("SELECT status FROM product_codes WHERE code = 'PAID-FROZEN-1'").get().status,
    'unused',
    '码必须留在池里'
  );
});

test('paid 快路径：链上真值读不到时不发码（fail-safe，宁可留给卖家手动交付）', async () => {
  const { ownerToken, slug } = await listDigital({ title: 'paid 读不到链商品' });
  await importCodes(ownerToken, slug, ['PAID-NORPC-1']);
  const order = await escrowedOrder(slug);

  setChainOrderFetcher(() => {
    throw new Error('rpc down');
  });
  try {
    assert.equal(await deliveryOnPaid(order), false, '看不清链上状态时不发码');
  } finally {
    setChainOrderFetcher(chainSaysOpen);
  }
  assert.equal(rowOf(order.id).status, 'escrowed');
  assert.deepEqual(itemsOf(order.id), []);
});

test('审计 P1-1：退款冻结期（refund_status=requested）不自动交付（补跑/paid/watcher 同守卫）', async () => {
  const { ownerToken, slug } = await listDigital();
  await importCodes(ownerToken, slug, ['FROZEN-KEY-1']);
  const order = await escrowedOrder(slug);

  // 买家链上申请退款（watcher 回写 refund_status=requested——资金冻结，超时释放被禁）
  const { applyEvent } = await import('../src/escrowWatcher.js');
  applyEvent('RefundRequested', { orderId: order.escrowOrderId });
  const fr = rowOf(order.id);
  assert.equal(fr.refund_status, 'requested');
  // 链上真值同步（申请待决 ⇒ refundRequested=true）：交付判据在链上，桩必须说同一件事
  setChainOrderFetcher(() => ({ status: 'Created', refundRequested: true, refundRejected: false, refundedAmount: '0' }));

  // paid 钩子路径：冻结期不得自动发码（此前卖家 approveRefund = 钱退+码送出双损）
  assert.equal(await deliveryOnPaid(order), false, '冻结期自动交付应被拦截');
  assert.equal(rowOf(order.id).status, 'escrowed', '冻结期订单保持 escrowed 等待卖家决策');

  // 码池补货补跑路径同守卫（tryAutoDeliverPendingForProduct 遍历同样走 tryAutoDeliverOrder）
  const { tryAutoDeliverPendingForProduct } = await import('../src/autoDeliver.js');
  assert.equal(await tryAutoDeliverPendingForProduct(fr.product_id), 0, '补跑不得向冻结期订单发码');

  // 卖家拒绝退款（rejected，解锁争议资格）后恢复可自动交付（与 /ship 门控一致：
  // 仅 requested 冻结期拒发；rejected 后订单重回可发货态）
  applyEvent('RefundRejected', { orderId: order.escrowOrderId });
  assert.equal(rowOf(order.id).refund_status, 'rejected');
  setChainOrderFetcher(chainSaysOpen); // 链上不再冻结（申请表已清）
  assert.equal(await deliveryOnPaid(order), true, '拒绝退款后恢复自动交付');
  assert.equal(rowOf(order.id).status, 'shipped');
});

test('无码池数字商品：保持 escrowed 等待卖家手动交付（交付表单兜底）', async () => {
  const { slug } = await listDigital(); // 未导入任何码
  const order = await escrowedOrder(slug);
  assert.equal(await deliveryOnPaid(order), false);
  assert.equal(rowOf(order.id).status, 'escrowed', '无码池不得自动发货');
});

test('实物商品：永不自动交付（需卖家后台填物流发货）', async () => {
  const { slug } = await listDigital({ kind: 'physical', priceUsdtMicro: 88_000_000 });
  const order = await escrowedOrder(slug);
  assert.equal(await deliveryOnPaid(order), false);
  assert.equal(rowOf(order.id).status, 'escrowed');
});

test('MK_AUTO_DELIVER=0 全局关闭：escrowed 有码也不自动交付', async () => {
  const { ownerToken, slug } = await listDigital();
  await importCodes(ownerToken, slug, ['OFF-KEY-1']);

  const order = await escrowedOrder(slug);
  process.env.MK_AUTO_DELIVER = '0'; // 关闭（getter 动态读取）
  try {
    assert.equal(await deliveryOnPaid(order), false, '开关关闭时不得自动交付');
    assert.equal(rowOf(order.id).status, 'escrowed');
  } finally {
    delete process.env.MK_AUTO_DELIVER;
  }

  // 恢复后同单可正常自动交付（幂等路径验证开关是动态读取的）
  assert.equal(await deliveryOnPaid(order), true);
  assert.equal(rowOf(order.id).status, 'shipped');
});

// ── 幂等 ──

test('幂等：已 shipped 订单重复触发不重发码、不覆盖原交付码', async () => {
  const { ownerToken, slug } = await listDigital();
  await importCodes(ownerToken, slug, ['IDEM-KEY-1']);
  const draft = await createDraft(slug);
  // 交付的输入是"链上已托管且本地落了支付凭证"（escrowed 必有 paid_tx_hash，见 orders.js 头注释）——
  // 交付入口现在按链上单号在库里筛的正是这两条，少了凭证就筛不到（不是"发不出去"）
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), draft.id);

  assert.equal(await deliveryOnPaid(draft), true);
  const once = itemsOf(draft.id)[0];

  // 重复触发：false 且码不变、池状态不变
  assert.equal(await deliveryOnPaid(draft), false, '已 shipped 订单不可再次交付');
  assert.equal(itemsOf(draft.id)[0], once, '重复触发不得覆盖原交付行');
  const usedCount = db
    .prepare("SELECT COUNT(*) AS c FROM product_codes WHERE order_id = ?")
    .get(draft.id).c;
  assert.equal(usedCount, 1, '一单只占一个码');
});

// ── watcher 既有分支不受影响（无码池快照不得误自动交付）──

test('watcher 钩子不误伤：无码池订单 OrderCreated 仅置 escrowed', async () => {
  const { slug } = await listDigital();
  const draft = await createDraft(slug);
  assert.equal(applyEvent('OrderCreated', { orderId: draft.escrowOrderId }, { txHash: payHash(), block: 101 }), 1);
  assert.equal(rowOf(draft.id).status, 'escrowed', '无码池订单停留在 escrowed 等手动交付');
});

// ── P1-③ 商品级自动交付开关（-1 跟随全局 / 0 关 / 1 强制开）──

async function patchProduct(ownerToken, slug, body) {
  const res = await request(app)
    .patch(`/api/products/${slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(body)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

test('autoDeliver=-1 跟随全局；=0 行级关闭（全局开也不交付）；=1 行级强制开（全局关也交付）', async () => {
  // -1（默认）：跟随全局（全局默认开）→ 自动交付
  const def = await listDigital({ title: '行级默认' });
  await importCodes(def.ownerToken, def.slug, ['ROW-DEF']);
  let order = await escrowedOrder(def.slug);
  assert.equal(await deliveryOnPaid(order), true, '-1 跟随全局（开）');
  assert.equal(rowOf(order.id).status, 'shipped');

  // 0：行级关闭（全局仍开）→ 不交付
  const off = await listDigital({ title: '行级关闭' });
  await importCodes(off.ownerToken, off.slug, ['ROW-OFF']);
  await patchProduct(off.ownerToken, off.slug, { autoDeliver: 0 });
  order = await escrowedOrder(off.slug);
  assert.equal(await deliveryOnPaid(order), false, 'autoDeliver=0 行级关闭');
  assert.equal(rowOf(order.id).status, 'escrowed');

  // 1：行级强制开，即使全局关闭
  const on = await listDigital({ title: '行级强制' });
  await importCodes(on.ownerToken, on.slug, ['ROW-ON']);
  await patchProduct(on.ownerToken, on.slug, { autoDeliver: 1 });
  order = await escrowedOrder(on.slug);
  process.env.MK_AUTO_DELIVER = '0';
  try {
    assert.equal(await deliveryOnPaid(order), true, 'autoDeliver=1 无视全局关闭');
    assert.equal(rowOf(order.id).status, 'shipped');
  } finally {
    delete process.env.MK_AUTO_DELIVER;
  }
});

test('经营字段（autoDeliver/stockAlertAt/lowStock）仅店主 /all 输出；不入快照哈希', async () => {
  const { ownerToken, slug } = await listDigital({ title: '经营字段商品', capacity: 10 });
  const before = await request(app)
    .get(`/api/products/${slug}`)
    .expect(200);
  const hashBefore = before.body.data.snapshotHash;

  // 设低库存阈值 3：余量 10 > 3 → lowStock=false；卖 8 件后余量 2 ≤ 3 → true
  await patchProduct(ownerToken, slug, { stockAlertAt: 3, autoDeliver: 0 });
  const after = await request(app).get(`/api/products/${slug}`).expect(200);
  assert.equal(after.body.data.snapshotHash, hashBefore, '经营配置不入快照（哈希不变）');

  const all = async () => {
    const res = await request(app).get('/api/products/all').set('Authorization', `Bearer ${ownerToken}`).expect(200);
    return res.body.data.products.find((x) => x.slug === slug);
  };
  const r0 = await all();
  assert.equal(r0.autoDeliver, 0);
  assert.equal(r0.stockAlertAt, 3);
  assert.equal(r0.lowStock, false, '余量 10 > 阈值 3 不警示');

  for (let i = 0; i < 8; i++) {
    const d = await createDraft(slug);
    db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
      .run(payHash(), Date.now(), d.id);
  }
  const r1 = await all();
  assert.equal(r1.lowStock, true, '余量 2 ≤ 阈值 3 触发低库存');

  // 公开列表不带经营字段
  const pub = await request(app).get('/api/products').expect(200);
  const pubRow = pub.body.data.products.find((x) => x.slug === slug);
  assert.ok(!('autoDeliver' in pubRow) && !('lowStock' in pubRow) && !('stockAlertAt' in pubRow), '公开列表不暴露经营字段');
});

// ── 码池补货自动补发（review 2026 新增）：池空滞留 escrowed 的订单在导码后被自动交付 ──

test('码池补货自动补发：池空滞留的 escrowed 订单在导入码后被自动交付（响应含 autoDelivered）', async () => {
  setChainOrderFetcher(chainSaysOpen); // 链上仍在托管且未申请退款（补跑会逐单复核链上真值）
  const { ownerToken, slug } = await listDigital(); // autoDeliver=-1 跟随全局（默认开）
  const order = await escrowedOrder(slug); // 支付已落、码池为空 → 自动交付失败滞留 escrowed
  assert.equal(rowOf(order.id).status, 'escrowed', '池空时订单滞留待发货');

  // 店主导入一个码：导入路由应触发补发（tryAutoDeliverPendingForProduct）
  const res = await request(app)
    .post(`/api/products/${slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['REFILL-KEY-1'] })
    .expect(200);
  assertOk(res);
  assert.equal(res.body.data.autoDelivered, 1, '导入响应应报告自动补发 1 单');

  const row = rowOf(order.id);
  assert.equal(row.status, 'shipped', '补货后滞留订单自动置 shipped');
  assert.deepEqual(itemsOf(order.id), ['REFILL-KEY-1'], '分配的正是新导入的码');
  const used = db
    .prepare('SELECT status, order_id FROM product_codes WHERE code = ?')
    .get('REFILL-KEY-1');
  assert.equal(used.status, 'used');
  assert.equal(used.order_id, order.id);

  // 行级关闭（autoDeliver=0）的商品：补货不自动补发（保持 escrowed 由卖家手动交付）
  const off = await listDigital({ title: '补货不自动补发商品' });
  await patchProduct(off.ownerToken, off.slug, { autoDeliver: 0 });
  const offOrder = await escrowedOrder(off.slug);
  const resOff = await request(app)
    .post(`/api/products/${off.slug}/codes`)
    .set('Authorization', `Bearer ${off.ownerToken}`)
    .send({ codes: ['OFF-REFILL-1'] })
    .expect(200);
  assertOk(resOff);
  assert.equal(resOff.body.data.autoDelivered, 0, '行级关闭不自动补发');
  assert.equal(rowOf(offOrder.id).status, 'escrowed', '行级关闭订单保持 escrowed');
  setChainOrderFetcher(chainSaysOpen); // 还原默认桩
});

/**
 * 源码评审 2026-09（P1）：补货补跑曾经只看**本地镜像**（`refund_status === 'requested'`），
 * 而镜像有 15s 轮询 + 12 块确认深度的滞后窗口。买家已在链上申请退款、watcher 还没落地的这段时间里，
 * 店主一导入码就会把码发给一个即将退款的买家（卖家随后 approveRefund ⇒ 钱退+码送出，双损）。
 * 本用例把"链上说已申请退款、本地镜像仍说 none"这个**真实窗口**造出来：
 * 不带链上复核的实现会在这里发出码（autoDelivered=1），修好后必须是 0。
 */
test('码池补货补跑：链上已申请退款（镜像尚未落地）不得发码', async () => {
  const { ownerToken, slug } = await listDigital({ title: '链上已退款补货商品' });
  const order = await escrowedOrder(slug); // 支付已落、池空滞留 escrowed
  assert.equal(rowOf(order.id).refund_status, 'none', '本地镜像尚无退款标记（滞后窗口内）');

  // 链上真值：买家已 requestRefund（镜像还没跟上）
  setChainOrderFetcher(() => ({ status: 'Created', refundRequested: true, refundRejected: false, refundedAmount: '0' }));
  try {
    const res = await request(app)
      .post(`/api/products/${slug}/codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ codes: ['LATE-REFUND-1'] })
      .expect(200);
    assertOk(res);
    assert.equal(res.body.data.autoDelivered, 0, '链上已申请退款 ⇒ 不得补发');
    assert.equal(rowOf(order.id).status, 'escrowed', '订单保持 escrowed，等卖家决策');
    const code = db.prepare('SELECT status FROM product_codes WHERE code = ?').get('LATE-REFUND-1');
    assert.equal(code.status, 'unused', '码不能被占用（否则退款后买家白拿码）');
  } finally {
    setChainOrderFetcher(chainSaysOpen);
  }
});

test('码池补货补跑：链上读不到 ⇒ 不发码（fail-safe，留给手动交付）', async () => {
  const { ownerToken, slug } = await listDigital({ title: '链读失败补货商品' });
  const order = await escrowedOrder(slug);
  setChainOrderFetcher(() => {
    throw new Error('rpc down');
  });
  try {
    const res = await request(app)
      .post(`/api/products/${slug}/codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ codes: ['CHAIN-DOWN-1'] })
      .expect(200);
    assertOk(res);
    assert.equal(res.body.data.autoDelivered, 0, '看不清链上状态时不发码');
    assert.equal(rowOf(order.id).status, 'escrowed');
  } finally {
    setChainOrderFetcher(chainSaysOpen);
  }
});
