/**
 * 四个计数器不变量的对拍（`integrity.js` 的 ⑥）。
 *
 * 这四个值是"先读计数再写"落成可条件更新计数器之后新增的状态：
 *   products.reserved_codes / reserved_tokens（池占位）、product_skus.committed（限量占位）、
 *   orders.hold_qty（这一单押着几件）。
 * 它们漂移时**没有任何一条会报错**：偏大就是货永远卖不出去，偏小就是超卖，hold_qty 错就是
 * 释放/恢复按错的数量加减。所以判据只能是"全表对拍"，实现只能在 integrity（唯一能读全表的层）。
 *
 * 每个用例都造出**生产路径造不出的账**（直接改计数器/造半个占位），再断言体检把它指出来；
 * 正向基线则断言"账自洽时一条噪声都没有"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, insertProduct, insertOrder } from './setup.mjs';

const ctx = await makeCtx();
const { db, owner, buyer } = ctx;
const { findIntegrityIssues } = await import('../src/integrity.js');

const BUYER = buyer.address.toLowerCase();
const SELLER = owner.address.toLowerCase();

/** 造商品（physical 走限量占位，digital/nft 走池占位） */
async function makeProduct(spec = {}) {
  return await insertProduct(db, {
    kind: 'digital',
    skus: [],
    ...spec,
  });
}

/** 造一行订单（夹具直接插行，绕开下单路径；调用方自己决定要不要把计数器补成一致） */
async function makeOrder(spec = {}) {
  return await insertOrder(db, {
    status: 'draft',
    quantity: 1,
    buyer: BUYER,
    seller: SELLER,
    amountWei: '0',
    usdtMicro: 0,
    ...spec,
  });
}

/** 只看四个计数器相关的 issue（这个文件之外没有别的故障源，但显式过滤让断言更稳） */
const COUNTER_KINDS = [
  'reserved-codes-drift',
  'reserved-tokens-drift',
  'committed-drift',
  'hold-qty-mismatch',
  'hold-without-sku',
  'counter-not-comparable',
];

test('账自洽时一条计数器噪声都没有（正向基线，防"见谁都报"）', async () => {
  const p = await makeProduct({ kind: 'physical', title: '限量实物', skus: [{ key: '', priceUsdtMicro: 1_000_000, capacity: 5, committed: 1 }] });
  await makeOrder({ productId: p.productId, productSlug: p.slug, skuKey: '', quantity: 1, holdQty: 1 });
  const { issues, counts, checked } = await findIntegrityIssues(db);
  assert.deepEqual(
    issues.filter((i) => COUNTER_KINDS.includes(i.kind)),
    [],
    `自洽的账不该报：${JSON.stringify(issues)}`
  );
  assert.equal(counts.reservedCodesDrift + counts.committedDrift + counts.holdQtyMismatch, 0);
  assert.ok(checked.productCounters >= 1 && checked.skuCounters >= 1 && checked.ordersWithHold >= 1);
});

test('reserved_codes 偏大（没有任何在途订单却记着 3 个占位）⇒ 报漂移', async () => {
  const p = await makeProduct({ kind: 'digital', title: '码池商品' });
  await db.run('UPDATE products SET reserved_codes = 3 WHERE id = ?', p.productId);
  const { issues, counts } = await findIntegrityIssues(db);
  const hit = issues.find((i) => i.kind === 'reserved-codes-drift' && i.resource === p.slug);
  assert.ok(hit, `必须报出 reserved_codes 漂移：${JSON.stringify(issues)}`);
  assert.match(hit.detail, /reserved_codes=3/);
  assert.match(hit.detail, /差 \+3/);
  assert.ok(counts.reservedCodesDrift >= 1);
});

test('reserved_tokens 偏小（在途 NFT 订单 2 枚，计数器却是 0）⇒ 报漂移（方向是超卖）', async () => {
  const p = await makeProduct({ kind: 'nft', title: 'NFT 商品', nftContract: '0x2222222222222222222222222222222222222222', nftStandard: 'erc721' });
  await makeOrder({ productId: p.productId, productSlug: p.slug, quantity: 2, holdQty: 0 });
  const { issues } = await findIntegrityIssues(db);
  const hit = issues.find((i) => i.kind === 'reserved-tokens-drift' && i.resource === p.slug);
  assert.ok(hit, `必须报出 reserved_tokens 漂移：${JSON.stringify(issues)}`);
  assert.match(hit.detail, /reserved_tokens=0/);
  assert.match(hit.detail, /差 -2/);
});

test('product_skus.committed 与"仍押着的占位"不一致 ⇒ 报漂移（它正是"还剩几件"的唯一读数）', async () => {
  const p = await makeProduct({ kind: 'physical', title: '实物商品', skus: [{ key: '红', priceUsdtMicro: 1_000_000, capacity: 9, committed: 2 }] });
  await makeOrder({ productId: p.productId, productSlug: p.slug, skuKey: '红', quantity: 1, holdQty: 1 });
  const { issues } = await findIntegrityIssues(db);
  const hit = issues.find((i) => i.kind === 'committed-drift' && i.resource === p.slug);
  assert.ok(hit, `必须报出 committed 漂移：${JSON.stringify(issues)}`);
  assert.match(hit.detail, /committed=2/);
  assert.match(hit.detail, /组合「红」/);
});

test('hold_qty 不是 0 也不是 quantity ⇒ 报漂移（释放/恢复会按错的数量加减 committed）', async () => {
  const p = await makeProduct({ kind: 'physical', title: '数量不一致', skus: [{ key: '', priceUsdtMicro: 1_000_000, capacity: 9 }] });
  const o = await makeOrder({ productId: p.productId, productSlug: p.slug, skuKey: '', quantity: 2, holdQty: 3 });
  const { issues } = await findIntegrityIssues(db);
  const hit = issues.find((i) => i.kind === 'hold-qty-mismatch' && i.orderId === o.orderNo);
  assert.ok(hit, `必须报出 hold_qty 形状错误：${JSON.stringify(issues)}`);
  assert.match(hit.detail, /hold_qty=3/);
  assert.match(hit.detail, /quantity=2/);
});

test('押着占位却找不到 SKU 行（组合键被改/商品被删）⇒ 报出来而不是当成 0', async () => {
  const p = await makeProduct({ kind: 'physical', title: '组合丢了', skus: [{ key: '旧组合', priceUsdtMicro: 1_000_000, capacity: 9 }] });
  const o = await makeOrder({ productId: p.productId, productSlug: p.slug, skuKey: '新组合', quantity: 1, holdQty: 1 });
  // 让 (商品, 新组合) 没有 SKU 行：占位不属于任何 committed 计数器
  const { issues } = await findIntegrityIssues(db);
  const hit = issues.find((i) => i.kind === 'hold-without-sku' && i.orderId === o.orderNo);
  assert.ok(hit, `必须报出无主的占位：${JSON.stringify(issues)}`);
  assert.match(hit.detail, /SKU 行已不存在/);
});

test('product_id 为 NULL 的占位 ⇒ 如实报"不可对拍"，不折成 0', async () => {
  const o = await makeOrder({ productId: null, quantity: 1, holdQty: 1 });
  const { issues, counts } = await findIntegrityIssues(db);
  const hit = issues.find((i) => i.kind === 'counter-not-comparable' && i.orderId === o.orderNo);
  assert.ok(hit, `无法对拍的行必须被报出来：${JSON.stringify(issues)}`);
  assert.match(hit.detail, /无法与任何 SKU 的 committed 对拍/);
  assert.ok(counts.counterNotComparable >= 1, '计数里必须能看到"不可对拍"的数量，而不是 0');
});
