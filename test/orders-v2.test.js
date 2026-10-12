/**
 * 订单 v2 数量模型（B2）：quantity 贯穿金额/限量占位/码池按量分配/手动交付行数校验；
 * 每买家活跃草稿上限（防注册地址批量占位 DoS）；NFT 申报集合边界。
 * 交付核验成功路径依赖链上 RPC（单测禁网），此处只覆盖链上核验前的可测边界；
 * 核验通过路径由 B3 纯函数单测与 B7 全链路演示覆盖。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { assertOk, login, makeCtx, productPayload, skuInv } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const buyer2 = Wallet.createRandom();

let ownerToken;
let buyerToken;
// 模拟链上规范哈希（escrowed 必有支付凭证，发货防呆要求）
let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  buyerToken = (await login(ctx, buyer)).token;
  assert.ok(ownerToken && buyerToken);
});

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

/** 下单（买家本人登录，带 quantity），返回响应体 data */
async function createDraft(slug, quantity, who = buyer.address) {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${who === buyer.address ? buyerToken : ownerToken}`)
    .send({ productSlug: slug, quantity, buyer: who })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 直接置 escrowed 并落支付凭证（模拟 watcher/paid 已回写，跳过链上） */
function escrowed(order) {
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(payHash(), Date.now(), order.id);
}

const itemsOf = (id) =>
  db.prepare('SELECT kind, value, tx_hash FROM order_delivery_items WHERE order_id = ? ORDER BY id ASC').all(id);

const blocked = (res) => {
  assert.notEqual(res.body.code, 0, '应被拒');
  return res.body.message || '';
};

// ── quantity 参数校验 ──

test('quantity 参数校验：非整数/越界（0、-1、100、1.5、非数字）均被拒', async () => {
  const p = await listProduct(productPayload({ title: '数量校验商品' }));
  for (const q of [0, -1, 100, 1.5, 'x']) {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productSlug: p.slug, quantity: q })
      .expect(200);
    assert.match(blocked(res), /quantity/, `quantity=${q} 应报参数错误`);
  }
  // 缺省 quantity=1
  const ok = await createDraft(p.slug);
  assert.equal(ok.quantity, 1);
});

// ── quantity 金额与限量占位 ──

test('quantity=3 下单：金额与 USDT 展示串均为 3 倍；限量商品按量占位（余量按件扣）', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '按量占位商品', priceUsdtMicro: 88_000_000, capacity: 5 }));
  const o = await createDraft(p.slug, 3);

  assert.equal(o.quantity, 3);
  assert.equal(o.usdtMicro, 88_000_000 * 3, '锁定金额（微 USDT）= 单价 × 数量');
  assert.equal(o.usdt, '264', '展示串去净尾零：264 USDT 写作 264（不是 264.00）');
  // 汇率锁定口径：兜底汇率 1 BTY = 0.1 USDT ⇒ 264 USDT = 2640 BTY（向上取整）
  const bty = Number(o.amountWei) / 1e18;
  assert.ok(Math.abs(bty - 2640) < 1e-9, `应付 BTY 应≈2640，实际 ${bty}`);
  // 数量为 3 时的应付应明显大于数量为 1 的单倍应付（期望值同样取自节点自己的折算函数）
  const { getRates, usdtMicroToPayWei } = await import('../src/rates.js');
  const oneWei = BigInt(usdtMicroToPayWei(88_000_000, await getRates()));
  assert.ok(BigInt(o.amountWei) > oneWei * 2n, '应付随数量放大');
  // 限量占位按件：capacity 5 − 3 = 2
  const r = skuInv(db, p.slug);
  assert.equal(r.committed, 3, '销量按 quantity 累加');
  assert.equal(r.capacity - r.committed, 2, '余量按件扣减');

  // 同买家再下 quantity=3：余量 2 不足 → 拒（占位不越界）
  const again = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: p.slug, quantity: 3 })
    .expect(200);
  assert.match(blocked(again), /售罄/);
  assert.equal(skuInv(db, p.slug).committed, 3, '拒单不得再扣减');
});

// ── 码池按量分配 / 手动交付行数 ──

test('digital quantity=2：自动分配 2 个码（2 行交付）；手动交付行数必须=数量', async () => {
  const p = await listProduct(productPayload({ title: '按量码池商品' }));
  const importRes = await request(app)
    .post(`/api/products/${p.slug}/codes`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ codes: ['Q1', 'Q2'] })
    .expect(200);
  assertOk(importRes);

  const o = await createDraft(p.slug, 2);
  escrowed(o);
  const ship = await request(app)
    .post(`/api/orders/${o.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({})
    .expect(200);
  assertOk(ship);
  assert.equal(ship.body.data.status, 'shipped');
  assert.deepEqual(
    ship.body.data.deliveries.map((d) => d.value).sort(),
    ['Q1', 'Q2'],
    '自动分配应按 quantity 整批取码'
  );
  const pid = db.prepare('SELECT id FROM products WHERE slug = ?').get(p.slug).id;
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM product_codes WHERE product_id = ? AND status = 'unused'").get(pid).c,
    0
  );

  // 手动交付：行数 ≠ quantity 拒绝；= quantity 成功（无池商品走手动交付型，码池不影响）
  const manualP = await listProduct(productPayload({ title: '手动交付商品' }));
  const manual = await createDraft(manualP.slug, 2, buyer2.address);
  escrowed(manual);
  const oneLine = await request(app)
    .post(`/api/orders/${manual.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ deliveryCode: 'M-1' })
    .expect(200);
  assert.match(blocked(oneLine), /恰好 2 行/);

  const twoLine = await request(app)
    .post(`/api/orders/${manual.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ deliveryCode: 'M-1\nM-2' })
    .expect(200);
  assertOk(twoLine);
  assert.equal(twoLine.body.data.deliveries.length, 2, '手动交付每行落一条交付记录');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(manual.id).status, 'shipped');
});

// ── NFT 申报集合边界（核验前拦截）──

test('NFT quantity=2：同单 tokenId 重复申报 / 一次超量申报 → 链上核验前即被拒', async () => {
  const NFT_CONTRACT = '0x' + '5'.repeat(40);
  const p = await listProduct({
    title: '集合边界 NFT',
    description: 'd',
    images: ['https://example.com/n.jpg'],
    kind: 'nft',
    nftContract: NFT_CONTRACT,
    // 价格与库存逐组合给出：无规格商品就是 key='' 的唯一组合
    specs: [],
    skus: [{ key: '', priceUsdtMicro: 66_000_000, capacity: null }],
  });
  const importRes = await request(app)
    .post(`/api/products/${p.slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ tokens: ['11', '12', '13'] })
    .expect(200);
  assertOk(importRes);

  const o = await createDraft(p.slug, 2);
  escrowed(o);
  const txHash = '0x' + 'a'.repeat(64);

  // 同单 tokenId 重复（每件一枚的集合语义）
  const dup = await request(app)
    .post(`/api/orders/${o.id}/nft-deliveries`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ deliveries: [{ tokenId: '11', txHash }, { tokenId: '11', txHash }] })
    .expect(200);
  assert.match(blocked(dup), /不得重复/);

  // 一次申报 3 条 > quantity 2 → 超量拒绝（早期参数校验拦截，核验前）
  const over = await request(app)
    .post(`/api/orders/${o.id}/nft-deliveries`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ deliveries: [{ tokenId: '11', txHash }, { tokenId: '12', txHash }, { tokenId: '13', txHash }] })
    .expect(200);
  assert.match(blocked(over), /需提交 1\.\.2 条交付记录/, '超量申报应在早期被拒');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status, 'escrowed', '拒绝不改变状态');
  assert.deepEqual(itemsOf(o.id), [], '拒绝不产生交付行');
});

// ── 草稿上限（每买家活跃 draft ≤ 10）──

test('活跃草稿上限：同买家 draft ≥10 后新下单被拒；取消一个后恢复', async () => {
  const p = await listProduct(productPayload({ kind: 'physical', title: '草稿上限商品', capacity: 100 }));
  // 独立买家造满 10 个草稿（不受前面测试残留草稿影响；店主代下单）
  const heavy = Wallet.createRandom();
  const created = [];
  for (let i = 0; i < 10; i++) {
    created.push(await createDraft(p.slug, 1, heavy.address));
  }
  const blockedRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ productSlug: p.slug, quantity: 1, buyer: heavy.address })
    .expect(200);
  assert.match(blocked(blockedRes), /草稿过多/);
  /*
    闸拒绝时**必须已回滚**（源码评审 2026-09）：两道闸现在跑在 txBegin() 之后
    （读计数与插单要原子），漏掉 txRollback 就会把 SAVEPOINT 悬在这条连接上——
    该连接后续所有写都落在这个永不提交的事务里（进程活着看不到、重启即全部丢失）。
    断言取 node:sqlite 的 isTransaction：它由连接自身报告，改不动、装不出来。
  */
  assert.equal(db.isTransaction, false, '草稿上限拒绝后不得残留打开的事务');

  // 取消一个（店主可取消任意买家草稿）→ 恢复下单能力
  const cancel = await request(app)
    .post(`/api/orders/${created[0].id}/cancel`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assertOk(cancel);
  const again = await createDraft(p.slug, 1, heavy.address);
  assert.equal(again.status, 'draft', '取消后草稿数回落，可再下单');
});

/*
  ── 草稿占用合计上限（同买家同商品 ≤99 件）──
  这道闸此前**没有任何测试**（源码评审 2026-09 补）：它是"免费草稿锁库存"DoS 的主要收敛手段
  （单地址同商品锁库能力从 990 件收到 99 件），却只靠人工走查。这里把两侧边界都钉住：
  99 件刚好放行、100 件必须拒，且拒绝要回滚事务。
*/
test('草稿占用合计上限：同买家同商品 99 件放行、100 件被拒且回滚事务', async () => {
  // capacity 200 让"占满 99 件"这一步不被商品库存先拦住（本用例只测草稿闸本身）
  const p = await listProduct(productPayload({ kind: 'physical', title: '草稿合计占用商品', capacity: 200 }));
  const heavy = Wallet.createRandom();
  for (let i = 0; i < 4; i++) await createDraft(p.slug, 20, heavy.address); // 合计 80 件
  const tryDraft = async (quantity) =>
    request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ productSlug: p.slug, quantity, buyer: heavy.address })
      .expect(200);

  // 越过上限：80 + 20 = 100 > 99
  const over = await tryDraft(20);
  assert.match(blocked(over), /未支付草稿合计已达 80\/99/);
  assert.equal(db.isTransaction, false, '合计上限拒绝后不得残留打开的事务');
  assert.equal(
    // 直接查库要用小写地址：orders.buyer 存的是 lowercase（Wallet.address 是大小写混合的校验和形式）
    db
      .prepare("SELECT COALESCE(SUM(quantity),0) AS u FROM orders WHERE buyer = ? AND status = 'draft'")
      .get(heavy.address.toLowerCase()).u,
    80,
    '被拒的那单不得落库（合计仍是 80）'
  );

  // 正好补到上限：80 + 19 = 99 ⇒ 放行
  const exact = await createDraft(p.slug, 19, heavy.address);
  assert.equal(exact.quantity, 19);
  assert.equal(skuInv(db, p.slug).committed, 99, '放行的那单确实占了库存（99/200）');

  // 上限之上哪怕 1 件也拒
  assert.match(blocked(await tryDraft(1)), /未支付草稿合计已达 99\/99/);
  assert.equal(db.isTransaction, false, '第二次拒绝后同样不得残留事务');
});

/*
  ── 回归（源码评审 2026-10，P0）：合计越过 JS 安全整数的单必须被**明确拒掉**，而不是落库 ──

  为什么这条值得一个用例：`orders.usdt_micro` 是 SQLite INTEGER 列，而 node:sqlite 读一个
  > Number.MAX_SAFE_INTEGER(9.007e15) 的整数会**直接抛 RangeError**（实测 `SELECT *` 与
  `SUM()` 都炸）——不是"算得不准"，而是这一行会让订单详情/列表/流水/两个 CSV/仲裁队列/通知
  全部 500，且它已提交（txCommit 在 findOrder 之前）、`cancel` 也走 findOrder ⇒ 接口层无法自救。
  商品侧上限（PRICE_MAX_MICRO）已收窄到"最坏合计仍在安全区内"，这里再用**直接改库**模拟
  历史脏数据（绕过校验的旧行），验证下单路由那道 isSafeInteger 兜底闸真的拦得住。
*/
test('回归：SKU 单价被改成超过安全整数上限的脏数据时，下单必须被明确拒绝且不落库', async () => {
  const p = await listProduct(productPayload({ title: '脏价格商品', capacity: null }));
  // 直接改库模拟"绕过商品校验写进来的历史行"：1e15 微 = 1e9 USDT（旧上限），×99 件即越过 2^53
  db.prepare('UPDATE product_skus SET price_usdt_micro = ? WHERE product_id = (SELECT id FROM products WHERE slug = ?)')
    .run(1_000_000_000_000_000, p.slug);

  const before = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE product_slug = ?').get(p.slug).c;
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${buyerToken}`)
    .send({ productSlug: p.slug, quantity: 99, buyer: buyer.address })
    .expect(200);

  const msg = blocked(res);
  assert.match(msg, /超出可精确表示的上限/, `应给出可行动的中文原因，实际：${msg}`);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM orders WHERE product_slug = ?').get(p.slug).c,
    before,
    '被拒的单不得落库（否则那一行会让所有 SELECT * 永久 500）'
  );
  assert.equal(db.isTransaction, false, '拒绝后不得残留打开的事务');
  // 直接证明"这条脏价格确实会让 SELECT * 炸"——用例的前提成立，而不是在防一个不存在的情况
  assert.equal(Number.isSafeInteger(1_000_000_000_000_000 * 99), false);
});
