/**
 * 内容哈希规范与存证（ARCHITECTURE.md §2.3 §3.1）：
 *  - contentHash 确定性、区分 order/kind/role/content。
 *
 * 注：/api/shop/notary-info 端点已随 MK_NOTARY_ADDRESS 配置移除——存证入口由前端
 * VITE_NOTARY_ADDRESS 决定、哈希以本地复算为准（节点返回值仅作对照），见
 * docs/DECISIONS.md。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { reviewContentHash, evidenceContentHash, contentHash } = await import('../src/notary.js');

test('contentHash：确定性且区分 orderId/kind/role/content', () => {
  const a = reviewContentHash('order-1', '内容甲');
  const b = reviewContentHash('order-1', '内容甲');
  assert.equal(a, b, '同输入哈希确定');
  assert.match(a, /^0x[0-9a-f]{64}$/, 'keccak256 输出格式');

  assert.notEqual(reviewContentHash('order-1', '内容甲'), reviewContentHash('order-2', '内容甲'), '区分 orderId');
  assert.notEqual(reviewContentHash('order-1', '内容甲'), reviewContentHash('order-1', '内容乙'), '区分 content');
  assert.notEqual(reviewContentHash('order-1', '内容甲'), evidenceContentHash('order-1', 'buyer', '内容甲'), '区分 kind');
  assert.notEqual(
    evidenceContentHash('order-1', 'buyer', '内容甲'),
    evidenceContentHash('order-1', 'seller', '内容甲'),
    '区分 role'
  );
  assert.notEqual(contentHash('order-1', 'review', 'buyer', ''), contentHash('order-1', 'review', 'buyer', 'x'), '空内容也有唯一哈希');
});

// ── 源码审计 2026-09：变长字段拼接歧义（encodePacked → abi.encode） ──

test('contentHash：拼接歧义回归——移动切分点不得产生同哈希', () => {
  // 修复前（encodePacked 直拼）：('AB','review','buyer') 与 ('A','Breview','buyer') 同哈希，
  // 已存证的哈希可被张冠李戴到另一个订单/类型（存证证明力被架空）
  const a = contentHash('AB', 'review', 'buyer', '同内容');
  const b = contentHash('A', 'Breview', 'buyer', '同内容');
  assert.notEqual(a, b, '切分点不同必须得到不同哈希');
  // kind/role 同理（('review','buyer') vs ('reviewb','uyer')）
  assert.notEqual(
    contentHash('o', 'evidence', 'buyer', 'x'),
    contentHash('o', 'evidenceb', 'uyer', 'x'),
    'kind/role 边界移动必须得到不同哈希'
  );
});

test('contentHash：固定 fixture（跨语言对拍锚点；前端 utils/notary.ts 必须算出一致值）', () => {
  // 该值锚定前端 utils/notary.ts 的 contentHashOf——改公式必须同步两侧并更新本 fixture。
  // （已人工核对：前端实现用 ethers.sha256 + AbiCoder.encode，与本文件同公式，输出一致）
  assert.equal(
    contentHash('B-FIXTURE-1', 'review', 'buyer', 'fixture-content'),
    '0xc07906d078c1279cee22d5eb944ea245b7031d547cf976427b708600a64d909b'
  );
});
