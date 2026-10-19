/**
 * 内容哈希规范与存证：
 *  - contentHashOf 确定性、区分 order/kind/role/content，且**域**（chainId + Registry 地址）进 preimage。
 *
 * 注：/api/shop/notary-info 端点已随 MK_NOTARY_ADDRESS 配置移除——存证入口由前端
 * VITE_NOTARY_ADDRESS 决定、哈希以本地复算为准（节点返回的哈希仅作对照，且同样带域）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CONTENT_HASH_DOMAIN, reviewContentHash, evidenceContentHash, contentHashOf, contentHashDomainErrorOf } =
  await import('../src/notary.js');

/** 与 `frontend/test/notaryCore.test.ts` 里同名常量**逐字相同**：定点向量的输入之一 */
const DOMAIN = { chainId: 2999, registryAddress: '0x' + '11'.repeat(20) };

/** 域齐全时必须算出哈希；否则测试当场红 */
const hashOf = (orderId, kind, role, content) => {
  const r = contentHashOf(DOMAIN, orderId, kind, role, content);
  assert.equal(r.error, null, '域齐全时不得返回"无法计算"');
  return r.hash;
};

test('CONTENT_HASH_DOMAIN：固定域常量（与 frontend/src/utils/notaryCore.ts 同值）', () => {
  // DOMAIN = keccak256(bytes("bityuan.fedmall.review-notary.v1"))；两侧各钉一次，改字符串即红。
  assert.equal(CONTENT_HASH_DOMAIN, '0xbf0d17c0e63d12bda563d71f0ec86433c84780538cdac70be092384fbefd28e1');
});

test('contentHashOf：确定性且区分 orderId/kind/role/content', () => {
  const a = reviewContentHash(DOMAIN, 'order-1', '内容甲');
  assert.equal(a.hash, reviewContentHash(DOMAIN, 'order-1', '内容甲').hash, '同输入哈希确定');
  assert.match(a.hash, /^0x[0-9a-f]{64}$/, 'keccak256 输出格式');

  assert.notEqual(a.hash, reviewContentHash(DOMAIN, 'order-2', '内容甲').hash, '区分 orderId');
  assert.notEqual(a.hash, reviewContentHash(DOMAIN, 'order-1', '内容乙').hash, '区分 content');
  assert.notEqual(a.hash, evidenceContentHash(DOMAIN, 'order-1', 'buyer', '内容甲').hash, '区分 kind');
  assert.notEqual(
    evidenceContentHash(DOMAIN, 'order-1', 'buyer', '内容甲').hash,
    evidenceContentHash(DOMAIN, 'order-1', 'seller', '内容甲').hash,
    '区分 role'
  );
  assert.notEqual(hashOf('order-1', 'review', 'buyer', ''), hashOf('order-1', 'review', 'buyer', 'x'), '空内容也有唯一哈希');
});

// ── P2：域分隔（chainId + Registry 地址必须进 preimage） ──

test('contentHashOf：域隔离——换链 / 换联邦（Registry）必须得到不同哈希', () => {
  // 回归点：orderId 是节点自编号（order_no），跨节点不唯一；域不在 preimage 里时
  // 两个节点（或重部署后的另一个联邦）上「同名单号 + 同样内容」会算出同一个哈希。
  const a = hashOf('ORDER-1', 'review', 'buyer', '内容甲');
  const otherChain = contentHashOf({ ...DOMAIN, chainId: 2998 }, 'ORDER-1', 'review', 'buyer', '内容甲');
  const otherRegistry = contentHashOf(
    { ...DOMAIN, registryAddress: '0x' + '22'.repeat(20) },
    'ORDER-1',
    'review',
    'buyer',
    '内容甲'
  );
  assert.equal(otherChain.error, null);
  assert.equal(otherRegistry.error, null);
  assert.notEqual(a, otherChain.hash, '换链必须换哈希');
  assert.notEqual(a, otherRegistry.hash, '换联邦（Registry）必须换哈希');
});

test('contentHashOf：未配置域 ⇒ 带原因的"无法计算"（不编一个无域哈希）', () => {
  const noAddress = reviewContentHash({ chainId: 2999, registryAddress: '' }, 'order-1', '内容甲');
  assert.equal(noAddress.hash, null);
  assert.match(noAddress.error, /无法计算.*MK_REGISTRY_ADDRESS/);

  const noChain = reviewContentHash({ chainId: 0, registryAddress: DOMAIN.registryAddress }, 'order-1', '内容甲');
  assert.equal(noChain.hash, null);
  assert.match(noChain.error, /无法计算.*chainId/);

  const noDomain = reviewContentHash(undefined, 'order-1', '内容甲');
  assert.equal(noDomain.hash, null);
  assert.match(noDomain.error, /无法计算/);

  // 判据本身也单独可测（routes 用它区分"域缺失"与"内容问题"，不靠近似）
  assert.match(contentHashDomainErrorOf({ chainId: 2999, registryAddress: '0x1234' }), /MK_REGISTRY_ADDRESS/);
  assert.equal(contentHashDomainErrorOf(DOMAIN), null);
});

// ── 源码审计 2026-09：变长字段拼接歧义（encodePacked → abi.encode） ──

test('contentHashOf：拼接歧义回归——移动切分点不得产生同哈希', () => {
  // 修复前（encodePacked 直拼）：('AB','review','buyer') 与 ('A','Breview','buyer') 同哈希，
  // 已存证的哈希可被张冠李戴到另一个订单/类型（存证证明力被架空）
  const a = hashOf('AB', 'review', 'buyer', '同内容');
  const b = hashOf('A', 'Breview', 'buyer', '同内容');
  assert.notEqual(a, b, '切分点不同必须得到不同哈希');
  // kind/role 同理（('review','buyer') vs ('reviewb','uyer')）
  assert.notEqual(
    hashOf('o', 'evidence', 'buyer', 'x'),
    hashOf('o', 'evidenceb', 'uyer', 'x'),
    'kind/role 边界移动必须得到不同哈希'
  );
});

test('contentHashOf：跨语言 fixture（跨语言对拍锚点；前端 utils/notary.ts 必须算出一致值）', () => {
  /*
    这组期望值由本实现产出，并与 `frontend/test/notaryCore.test.ts` 里的同一组字面量逐字节对齐；
    两侧字段顺序/类型漂移会让任一测试变红。

    **改前（无域公式 keccak256(abi.encode(orderId, kind, role, sha256(content)))）的同输入对照**：
      ('order-1','review','buyer','内容甲')                → 0x118071728dfb0740ac2e69663ea934e0ea05b66ccc71bdb0696eb0b0d5d51bbd
      ('order-1','evidence','buyer','内容甲')               → 0xbe51b7594fcc5e0b2451a5573666a2def72747f1cc9d36957bcd7417b5f26f32
      ('B-FIXTURE-1','review','buyer','fixture-content')   → 0xc07906d078c1279cee22d5eb944ea245b7031d547cf976427b708600a64d909b
    改后三值全部不同（下方即改后值），证明域确实进了 preimage；旧值只作对照，不留在运行代码里。
  */
  assert.equal(hashOf('order-1', 'review', 'buyer', '内容甲'), '0xee426c67e827e683653e3b980444464279a4ce81d42e4b2ed3b703c56871e548');
  assert.equal(
    hashOf('order-1', 'evidence', 'buyer', '内容甲'),
    '0x3e3e3998bd7bf8977e92992db7977d2d076ed98db578cbf0c9bd6387f15e51cf'
  );
  assert.equal(
    hashOf('B-FIXTURE-1', 'review', 'buyer', 'fixture-content'),
    '0xc58daec7eee6b563215fa6af8ecd2aad89b3aba67354bfea9955ace606ee54b1'
  );
});
