/**
 * 有限库存防超卖（总量 capacity / 销量 committed 占位与释放）单测：
 *  - 下单（草稿创建）对限量商品原子占位，余量耗尽拒单（并发不超卖）；
 *  - 终结未成交态自动回补：草稿超时取消 / 仲裁退款 / 超时释放；
 *  - 成交态不释放：确认收货 / 仲裁判付 / 草稿转正（escrowed）；
 *  - 不限量（capacity NULL）与池式商品（数字码池/NFT 交付池）不参与占位；
 *  - 卖家/详情接口 poolEmpty 提示（数字码池/NFT 池无未用资源）。
 * 状态迁移不经真实链上（单测无 RPC）——与 watcher.test 同款：直调 applyEvent。
 */
import { test, before } from 'node:test';

/** 全额退款事件参数（Escrow.Arbitrated/RefundApproved 现带 refundWei）：测试内订单金额恒为 1e18 */
const FULL_REFUND = '1000000000000000000';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { ageDrafts, assertOk, login, makeCtx, productPayload, skuInv } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
// 同买家同商品可多次购买（v2：orderId 含 UUID 随机化，无共享单号）——多买家仅用于并发多单
const buyers = [buyer, Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
// 模拟链上规范哈希（escrowed 必有支付凭证，发货防呆要求）
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

const NFT_CONTRACT = '0x' + '9'.repeat(40);

function nftPayload(overrides = {}) {
  const { priceCnyFen = 6600, capacity = null, specs, skus, ...rest } = overrides;
  return {
    title: '占位测试 NFT',
    description: 'capacity 占位单测 NFT 商品。',
    images: ['https://example.com/n.jpg'],
    kind: 'nft',
    nftContract: NFT_CONTRACT,
    // 价格与库存逐组合给出；无规格商品就是 key='' 的唯一组合
    specs: specs ?? [],
    skus: skus ?? [{ key: '', priceCnyFen, capacity }],
    ...rest,
  };
}

const invRow = (slug) => skuInv(db, slug);
/** 可售余量（DB 列：总量 capacity − 销量 committed；null=不限量） */
const availOf = (slug) => {
  const r = invRow(slug);
  return r.capacity === null ? null : Math.max(0, r.capacity - (r.committed || 0));
};
/** 总量（capacity 列，卖家编辑口径） */
const capOf = (slug) => invRow(slug).capacity;
/** 销量/已占位（committed 列，订单驱动） */
const commOf = (slug) => invRow(slug).committed || 0;

/** 上架商品（owner），返回产物 */
async function listProduct(payload) {
  const res = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(payload)
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 店主代买家下单草稿（返回 superagent 响应） */
async function createDraft(slug, who = buyer.address) {
  return request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ productSlug: slug, buyer: who })
    .expect(200);
}

/** 直接置为 escrowed 并落支付凭证（模拟 watcher/paid 已回写，跳过链上） */
function escrowed(order) {
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), order.id);
}

/**
 * 注（2026-09）：原先这里有两个「共享 escrow_order_id 的存量多行」用例（幽灵行清理/混行释放）。
 * 「一单一号」现由 `orders(escrow_order_id)` 唯一索引在写入时强制（见 order-cancel.test.js 的
 * 数据完整性回归），那种脏数据状态不再可能存在，故用例连同 helper 一并删除——
 * 保留它们只会保护一个不可能发生的场景，并给人「多行共享单号是被支持的」的错觉。
 */
let ownerToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  assert.ok(ownerToken);
});

const { applyEvent } = await import('../src/escrowWatcher.js');
const { sweepExpiredDrafts } = await import('../src/orderSweeper.js');

// ── 占位 ──

test('限量商品下单原子占位，余量耗尽后拒单', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '限量占位商品', capacity: 3 }));
  assert.equal(availOf(p.slug), 3);

  // 同商品连续多单（各买家独立下单）
  for (let i = 0; i < 3; i++) {
    const res = await createDraft(p.slug, buyers[i].address);
    assertOk(res);
    assert.equal(availOf(p.slug), 2 - i, `第 ${i + 1} 单应扣减 1`);
  }
  const fourth = await createDraft(p.slug, buyers[3].address);
  assert.notEqual(fourth.body.code, 0, '余量耗尽第 4 单应被拒');
  assert.match(fourth.body.message || '', /售罄/);
  assert.equal(availOf(p.slug), 0, '拒单不得再扣减');
});

test('不限量商品（capacity NULL）下单不占位', async () => {
  const p = await listProduct(productPayload({ title: '无限量商品' }));
  const res = await createDraft(p.slug);
  assertOk(res);
  assert.equal(availOf(p.slug), null, '不限量商品 capacity 保持 NULL');
});

// ── 释放：草稿超时取消 ──

test('草稿超时取消回补占位库存', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '取消回补商品', capacity: 2 }));
  const d1 = (await createDraft(p.slug)).body.data;
  const d2 = (await createDraft(p.slug, buyers[1].address)).body.data;
  assert.equal(availOf(p.slug), 0, '两单占满');
  ageDrafts(db, [d1.id, d2.id], 2 * 3600_000); // 做旧（含单调锚点：判据只看它）

  assert.equal(sweepExpiredDrafts(), 2, '两单同时超时关闭');
  assert.equal(availOf(p.slug), 2, '取消后额度全部回补');
  assert.equal(sweepExpiredDrafts(), 0, '清扫幂等不再回补');
  assert.equal(availOf(p.slug), 2, '幂等清扫不得重复回补');
});

// ── 释放：仲裁退款 / 超时释放；成交不释放 ──

test('仲裁退款（disputed→refunded）回补；仲裁判付（settled）不释放', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '仲裁退款商品', capacity: 2 }));
  const d1 = (await createDraft(p.slug)).body.data;
  const d2 = (await createDraft(p.slug, buyers[1].address)).body.data;
  escrowed(d1);
  escrowed(d2);

  // d1 争议 → 仲裁判退款：应回补 1
  assert.equal(applyEvent('DisputeRequested', { orderId: d1.escrowOrderId }), 1);
  assert.equal(applyEvent('Arbitrated', { orderId: d1.escrowOrderId, refundWei: d1.amountWei }), 1);
  assert.equal(availOf(p.slug), 1, '退款单回补 1');

  // d2 争议 → 仲裁判付卖家：钱货两清，不释放
  assert.equal(applyEvent('DisputeRequested', { orderId: d2.escrowOrderId }), 1);
  assert.equal(applyEvent('Arbitrated', { orderId: d2.escrowOrderId, refundWei: 0n }), 1);
  assert.equal(availOf(p.slug), 1, '判付单不释放');

  const st = Object.fromEntries(
    db.prepare('SELECT id, status FROM orders WHERE id IN (?, ?)').all(d1.id, d2.id).map((r) => [r.id, r.status])
  );
  assert.equal(st[d1.id], 'refunded');
  assert.equal(st[d2.id], 'settled');
});

test('超时释放（escrowed→expired）回补；确认收货（→confirmed）不释放', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '超时/确认商品', capacity: 2 }));
  const e1 = (await createDraft(p.slug)).body.data;
  const e2 = (await createDraft(p.slug, buyers[1].address)).body.data;
  escrowed(e1);
  escrowed(e2);

  // escrowed → expired（超时释放给卖家，货物从未交付）：回补
  assert.equal(applyEvent('OrderExpiredReleased', { orderId: e1.escrowOrderId }), 1);
  assert.equal(availOf(p.slug), 1, '超时释放单回补 1');

  // escrowed → confirmed（买家确认收货）：不释放
  assert.equal(applyEvent('ReceiptConfirmed', { orderId: e2.escrowOrderId }), 1);
  assert.equal(availOf(p.slug), 1, '确认收货不释放');
});

// ── 释放不越界 ──

test('草稿转正（escrowed）不回补（占位随订单存活）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '转正保留商品', capacity: 1 }));
  const d = (await createDraft(p.slug)).body.data;
  escrowed(d);
  assert.equal(availOf(p.slug), 0, 'escrowed 保持扣减');
  applyEvent('ReceiptConfirmed', { orderId: d.escrowOrderId });
  assert.equal(availOf(p.slug), 0, 'confirmed 不释放');
});

// ── poolEmpty 提示 ──

test('卖家列表 poolEmpty：数字码池空为 true，导入后 false；实物恒 false', async () => {
  // autoDeliver=0（本测试只验证 poolEmpty 口径提示，不被「导入后自动补发」特性改变订单状态；
  // 补货自动补发行为见 auto-deliver.test.js「码池补货自动补发」用例）
  const p = await listProduct(productPayload({ title: '码池提示商品', autoDeliver: 0 }));
  const d = (await createDraft(p.slug)).body.data;
  escrowed(d);

  const listEmpty = await request(app)
    .get('/api/orders/seller?status=escrowed')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(listEmpty);
  const found1 = listEmpty.body.data.orders.find((o) => o.id === d.id);
  assert.ok(found1, '卖家列表应含该单');
  assert.equal(found1.poolEmpty, true, '未建码池的数字订单提示缺货');

  const importRes = await request(app)
    .post(`/api/products/${p.slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['CARD-001'] })
    .expect(200);
  assertOk(importRes);

  const listFull = await request(app)
    .get('/api/orders/seller?status=escrowed')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const found2 = listFull.body.data.orders.find((o) => o.id === d.id);
  assert.equal(found2.poolEmpty, false, '码池有未用码后不再提示');

  // 实物商品恒不提示（非池式商品）
  const ph = await listProduct(productPayload({ kind: 'physical', title: '实物提示对照', capacity: 5 }));
  const dp = (await createDraft(ph.slug)).body.data;
  escrowed(dp);
  const list3 = await request(app)
    .get('/api/orders/seller?status=escrowed')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const found3 = list3.body.data.orders.find((o) => o.id === dp.id);
  assert.equal(found3.poolEmpty, false, '实物无池概念，恒 false');
});

test('卖家列表 poolEmpty：NFT 交付池空为 true，导入 tokenId 后 false', async () => {
  const p = await listProduct(nftPayload());
  const d = (await createDraft(p.slug)).body.data;
  escrowed(d);

  const empty = await request(app)
    .get('/api/orders/seller?status=escrowed')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const f1 = empty.body.data.orders.find((o) => o.id === d.id);
  assert.equal(f1.poolEmpty, true, '未建 NFT 交付池提示缺货');

  const imp = await request(app)
    .post(`/api/products/${p.slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokens: ['42'] })
    .expect(200);
  assertOk(imp);

  const full = await request(app)
    .get('/api/orders/seller?status=escrowed')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const f2 = full.body.data.orders.find((o) => o.id === d.id);
  assert.equal(f2.poolEmpty, false, '池内有未用 tokenId 后不再提示');
});

test('订单详情附带 poolEmpty（买家可感知待补货）', async () => {
  const p = await listProduct(productPayload({ title: '详情提示商品' }));
  const d = (await createDraft(p.slug)).body.data;
  escrowed(d);
  const res = await request(app).get(`/api/orders/${d.id}`).expect(200);
  assertOk(res);
  assert.equal(res.body.data.poolEmpty, true, '数字无池订单详情应提示');
});

// ── 编辑=总量语义（防「编辑触达占位/释放」）──

test('编辑填的是总量不是余量：占位列不被触碰；总量下限 = 已占位；释放只减占位', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '编辑总量商品', capacity: 5 }));
  assert.equal(p.capacity, 5, '商品输出携带总库存字段');
  const d1 = (await createDraft(p.slug)).body.data;
  const d2 = (await createDraft(p.slug, buyers[1].address)).body.data;
  assert.equal(commOf(p.slug), 2, '两单锁定占位');
  assert.equal(availOf(p.slug), 3);

  // 只改标题（不传 capacity）：总量/占位/余量全部不变——编辑绝不触发任何释放/回补
  const rename = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ title: '编辑总量商品-改' })
    .expect(200);
  assertOk(rename);
  assert.equal(capOf(p.slug), 5, '编辑不改总量');
  assert.equal(commOf(p.slug), 2, '编辑不改占位');
  assert.equal(availOf(p.slug), 3, '编辑不改余量');

  // 总量改小到低于已占位 → 拒绝（防止「总量 < 销量」的矛盾账目）
  const tooSmall = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ skus: [{ key: '', capacity: 1 }] })
    .expect(200);
  assert.notEqual(tooSmall.body.code, 0);
  assert.match(tooSmall.body.message || '', /总量|已占位|已售/);
  assert.equal(capOf(p.slug), 5, '被拒后总量不变');

  // 总量调到 4（≥ 已占 2）→ 成功：余量 = 4 − 2 = 2，占位不动
  const shrink = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ skus: [{ key: '', capacity: 4 }] })
    .expect(200);
  assertOk(shrink);
  assert.equal(capOf(p.slug), 4);
  assert.equal(commOf(p.slug), 2, '编辑不释放占位');
  assert.equal(availOf(p.slug), 2, '余量随总量收缩');

  // 取消一单释放占位 → committed 减 1、余量回到 3——回补只作用于销量列，永不超过总量
  ageDrafts(db, d1.id, 2 * 3600_000); // 做旧（含单调锚点：判据只看它）
  assert.equal(sweepExpiredDrafts(), 1);
  assert.equal(commOf(p.slug), 1, '取消释放占位');
  assert.equal(availOf(p.slug), 3);
});

// ── 释放单点：共享 escrow_order_id 多行同批迁出聚合回补 ──

// ── 口径冲突预警：卖家列表附池资源统计（poolBuilt/poolUnused）──

test('卖家列表（/all）附池口径统计；公开列表不带；池用尽后未用=0', async () => {
  const p = await listProduct(productPayload({ kind: 'digital', title: '口径对照商品', capacity: 10 }));

  const pub = await request(app).get('/api/products').expect(200);
  const pubRow = pub.body.data.products.find((x) => x.slug === p.slug);
  assert.ok(!('poolBuilt' in pubRow), '公开列表不暴露池资源口径');

  const sellerRow = async () => {
    const res = await request(app)
      .get('/api/products/all')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return res.body.data.products.find((x) => x.slug === p.slug);
  };

  const r0 = await sellerRow();
  assert.equal(r0.poolBuilt, 0, '未建池 poolBuilt=0（手动交付型，无口径约束）');
  assert.equal(r0.poolUnused, 0);

  const imp = await request(app)
    .post(`/api/products/${p.slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['B-1', 'B-2', 'B-3'] })
    .expect(200);
  assertOk(imp);
  const r1 = await sellerRow();
  assert.equal(r1.poolBuilt, 3, '导入 3 码后池总量=3');
  assert.equal(r1.poolUnused, 3);

  // 交付 1 单消耗 1 码：池未用 2 < 可售余量 9 → 前端据此提示「总量承诺超出池交付能力」
  const d = (await createDraft(p.slug)).body.data;
  escrowed(d);
  const ship = await request(app)
    .post(`/api/orders/${d.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({})
    .expect(200);
  assertOk(ship);
  const r2 = await sellerRow();
  assert.equal(r2.poolBuilt, 3, '发货不改变池总量');
  assert.equal(r2.poolUnused, 2, '发货消耗 1 个未用码');
  assert.equal(r2.committed, 1);
  assert.equal(r2.available, 9, '余量仍按总量−销量计算——两口径并存即预警触发面');
});

// ── v2 逐单占位记账（hold_qty + released_at）新语义 ──

test('sweeper 关单后链上托管落定：watcher 自动恢复为 escrowed 并回补占位', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '自动恢复商品', capacity: 3 }));
  const d = (await createDraft(p.slug)).body.data;
  assert.equal(commOf(p.slug), 1);
  // sweeper 超时关单（取消并释放占位）
  ageDrafts(db, d.id, 2 * 3600_000); // 做旧（含单调锚点：判据只看它）
  assert.equal(sweepExpiredDrafts(), 1);
  assert.equal(commOf(p.slug), 0, '关单释放占位');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(d.id).status, 'cancelled');

  // 链上托管事件落定（金额/卖家/买家全匹配）→ watcher 自动恢复：restock 回补 + 置 escrowed + 落凭证
  const changed = applyEvent(
    'OrderCreated',
    {
      orderId: d.escrowOrderId,
      buyer: buyer.address.toLowerCase(),
      seller: owner.address.toLowerCase(),
      amount: BigInt(d.amountWei),
    },
    { txHash: payHash(), block: 120 }
  );
  assert.equal(changed, 1, '已取消行收到匹配托管事件应自动恢复');
  const row = db.prepare('SELECT status, paid_tx_hash FROM orders WHERE id = ?').get(d.id);
  assert.equal(row.status, 'escrowed');
  assert.ok(row.paid_tx_hash, '恢复时落支付凭证');
  assert.equal(commOf(p.slug), 1, '恢复时按 hold_qty 回补占位');
  assert.equal(availOf(p.slug), 2);
});

test('不限量期下单 → 切回限量：在途未占位单纳入占位；容量不足拒绝切换', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '切换限量商品', capacity: null }));
  // 不限量期下单：不占位（hold_qty=0）
  const d = (await createDraft(p.slug)).body.data;
  assert.equal(db.prepare('SELECT hold_qty FROM orders WHERE id = ?').get(d.id).hold_qty, 0);

  // 切回限量但容量不足覆盖在途（在途 1 件 > 容量 0）→ 拒绝（提示在途件数）
  const tooSmall = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ skus: [{ key: '', capacity: 0 }] })
    .expect(200);
  assert.notEqual(tooSmall.body.code, 0);
  assert.match(tooSmall.body.message || '', /在途/);
  assert.equal(commOf(p.slug), 0, '被拒后占位不变');

  // 容量足以覆盖在途 → 成功：在途单补记占位（hold_qty=quantity），committed 纳入
  const ok = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ skus: [{ key: '', capacity: 2 }] })
    .expect(200);
  assertOk(ok);
  assert.equal(commOf(p.slug), 1, '在途未占位单切限量后纳入 committed');
  assert.equal(availOf(p.slug), 1);
  assert.equal(db.prepare('SELECT hold_qty FROM orders WHERE id = ?').get(d.id).hold_qty, 1, '行补记 hold_qty');

  // 该单随后取消 → 正常释放（不会出现「从未占位却被扣减」的账目漂移）
  const cancel = await request(app)
    .post(`/api/orders/${d.id}/cancel`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(cancel);
  assert.equal(commOf(p.slug), 0);
  assert.equal(availOf(p.slug), 2);
});

test('限量下单 → 改不限量 → 取消：hold 记账照常回补，无幻影占额滞留', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '放开限量商品', capacity: 2 }));
  const d = (await createDraft(p.slug)).body.data;
  assert.equal(commOf(p.slug), 1);
  assert.equal(db.prepare('SELECT hold_qty FROM orders WHERE id = ?').get(d.id).hold_qty, 1);

  // 卖家改不限量（编辑不触碰 committed/hold_qty——放开的是承诺上限，不是已占位）
  const open = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ skus: [{ key: '', capacity: null }] })
    .expect(200);
  assertOk(open);
  assert.equal(commOf(p.slug), 1);

  // 不限量窗口内取消 → 按行 hold_qty 回补（不再因「当前不限量」跳过 → 无幻影）
  const cancel = await request(app)
    .post(`/api/orders/${d.id}/cancel`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(cancel);
  assert.equal(commOf(p.slug), 0, '取消回补不依赖当前是否限量');

  // 再切回限量：无在途 → 直接可用，占位未被幻影占用
  const back = await request(app)
    .patch(`/api/products/${p.slug}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ skus: [{ key: '', capacity: 2 }] })
    .expect(200);
  assertOk(back);
  assert.equal(commOf(p.slug), 0);
  assert.equal(availOf(p.slug), 2, '切回限量后余量全量可用（无幻影滞留）');
});

test('部分交付（escrowed 已有交付行）超时释放：不回补占位（与退款/成交口径一致）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '部分交付超时商品', capacity: 5 }));
  const d = (await createDraft(p.slug)).body.data;
  escrowed(d);
  assert.equal(commOf(p.slug), 1, '下单占位 1 件');
  // 卖家已部分交付（NFT 形态的部分交付行；此处直接落一条交付行模拟 escrowed + 有交付记录）
  db.prepare(
    "INSERT INTO order_delivery_items (order_id, kind, value, created_at) VALUES (?, 'code', 'PARTIAL-1', ?)"
  ).run(d.id, Date.now());

  // 链上超时释放事件：escrowed（有交付记录）→ expired——已交付部分不可回补再售，占位保留
  assert.equal(applyEvent('OrderExpiredReleased', { orderId: d.escrowOrderId }, { txHash: payHash(), block: 130 }), 1);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(d.id).status, 'expired');
  assert.equal(commOf(p.slug), 1, '有交付记录的 escrowed 行超时不回补（防已交付资源再售）');
  assert.equal(availOf(p.slug), 4);
});

test('confirmed 残镜像 + 自提交付（shipped_at 非空、无单号、无交付行）超时释放：**不得**回补占位（源码审计 2026-09 修复）', async () => {
  /*
    这一条钉的是超时释放的「已交付事实」判据必须**包含 shipped_at**，与 db.js 的列注释、
    stockHold.js / returns.hasDelivered 同口径。
    为什么必须用 `confirmed` 残镜像来测、而不是直接测 shipped：`shipped` 状态本身就在排除集里，
    所以"自提单超时释放"在修复前后都通过——**测不出任何东西**。真正会炸的是这个组合：
    本地已被旧版 `/sync` 焊成 `confirmed`（历史数据形态）而货其实已经交付（自提、空物流单号），
    此时旧判据 `.filter(r => r.status !== 'shipped' && !r.tracking_no && !r.items)` 三项全过
    → **占位被回补**，已经交到买家手里的货重新变成可售库存 → 超卖。
  */
  const p = await listProduct(productPayload({ kind: 'physical', title: '自提残镜像超时商品', capacity: 5 }));
  const d = (await createDraft(p.slug)).body.data;
  escrowed(d);
  // 空物流单号发货（自提 / 线下交付——前端明确支持留空）⇒ 落 shipped_at，无 tracking_no、无交付行
  const ship = await request(app)
    .post(`/api/orders/${d.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ trackingNo: '' })
    .expect(200);
  assertOk(ship);
  const shipped = db.prepare('SELECT status, shipped_at, tracking_no FROM orders WHERE id = ?').get(d.id);
  assert.equal(shipped.status, 'shipped');
  assert.ok(shipped.shipped_at > 0, '自提交付的交付证据是 shipped_at');
  assert.ok(!shipped.tracking_no, '空单号');
  // 模拟历史残镜像：旧版 /sync 把链上 Settled 一律焊成 confirmed（状态离开了 shipped，但货已交付）
  db.prepare("UPDATE orders SET status = 'confirmed' WHERE id = ?").run(d.id);
  assert.equal(commOf(p.slug), 1, '前置：占位仍在');

  assert.equal(applyEvent('OrderExpiredReleased', { orderId: d.escrowOrderId }, { txHash: payHash(), block: 132 }), 1);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(d.id).status, 'expired');
  assert.equal(
    commOf(p.slug),
    1,
    'shipped_at 必须计入「已交付事实」——否则已交到买家手里的货被回补成可售库存（超卖）'
  );
  assert.equal(availOf(p.slug), 4, '余量不得虚高');
});