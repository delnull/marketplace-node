/**
 * **跨语言共享 fixture**：商品快照契约（node ↔ frontend）——源码审计 2026-09 补的覆盖缺口。
 *
 * 为什么单独钉这一份：快照契约的键序/归一规则有**两份实现**（本文件的 `snapshotObject`/
 * `computeSnapshotHash`，与 `frontend/src/utils/snapshot.ts` 的同名函数）。两侧原先各自只钉自己那份
 * （node 手写规范化 JSON 复算、前端另写 `CONTRACT_KEYS`）——**单侧"改实现 + 改自己的 fixture"
 * 不会惊动另一侧**，两端可以静默漂移，而漂移的表现是每个买家都看到假的「商品内容已被修改」。
 *
 * 这里钉的是**语言中立**的两样东西：规范化 JSON 串与它的 keccak256。
 * 侧别差异只允许存在于**输入形状**（node 吃 DB 行：snake_case + JSON 字符串列；前端吃 camelCase 的
 * `Product` 对象），输出必须逐字节相同。
 *
 * 对应的前端断言在 `frontend/test/snapshot.test.ts` 的
 * 「跨语言共享 fixture」用例里，**同名同值**——改一侧就必有一侧变红，这是刻意的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './setup.mjs';

// 先建临时库/注入环境，再动态 import 路由模块（它经 config/db 读环境，与其它用例同一套底座）
await makeCtx();
const { snapshotObject, computeSnapshotHash } = await import('../src/routes/products.js');

/** 与 frontend/test/snapshot.test.ts 的同名常量**必须逐字一致** */
const CROSS_LANG_FIXTURE = {
  canonical:
    '{"slug":"p-fix-1","title":"测试 \\"商品\\" & co","description":"desc\\nline2","description_blocks":[],' +
    '"images":["https://a/b.png"],"kind":"physical","shipping_fee_cny_fen":500,"age_restricted":1,' +
    '"specs":[{"name":"颜色","options":["黑","白"]},{"name":"尺寸","options":["M"]}],' +
    '"skus":[["尺寸=M|颜色=白",1200],["尺寸=M|颜色=黑",1000]]}',
  hash: '0x6660c7ec0eccc51751d929b62ed90f732af6429c80355762e51aca25448a1cda',
  /** NFT 单：两个键**追加在 skus 之后**（顺序错了哈希就变，而没人会报错） */
  nftCanonical:
    '{"slug":"p-fix-nft","title":"NFT 商品","description":"","description_blocks":[],"images":[],' +
    '"kind":"nft","shipping_fee_cny_fen":0,"age_restricted":0,"specs":[],"skus":[["",300]],' +
    '"nft_contract":"0xabc0000000000000000000000000000000000001","nft_standard":"erc1155"}',
  nftHash: '0x2b8647765df6127becb6fcb5f278414826e148027fcc03e480370781452f0808',
};

test('snapshot 契约：跨语言共享 fixture —— 与前端断言同一个 keccak（两侧必须逐字节一致）', () => {
  // node 输入形状：DB 行（snake_case；images/description_blocks/specs 是 JSON 字符串列）
  const row = {
    slug: 'p-fix-1',
    title: '测试 "商品" & co', // 含引号与 &：转义差异会立刻改变 JSON
    description: 'desc\nline2', // 含换行：\n 的写法必须一致
    description_blocks: '[]',
    images: JSON.stringify(['https://a/b.png']),
    kind: 'physical',
    shipping_fee_cny_fen: 500, // 运费必须进快照（否则店主可在下单前事后加价）
    age_restricted: 1, // 年龄限制必须进快照
    // skus 故意乱序传入：实现必须按 sku_key 升序排（顺序影响哈希）
    specs: JSON.stringify([
      { name: '颜色', options: ['黑', '白'] },
      { name: '尺寸', options: ['M'] },
    ]),
    skus: [
      { sku_key: '尺寸=M|颜色=白', price_cny_fen: 1200 },
      { sku_key: '尺寸=M|颜色=黑', price_cny_fen: 1000 },
    ],
  };

  const snap = snapshotObject(row);
  assert.equal(JSON.stringify(snap), CROSS_LANG_FIXTURE.canonical, '规范化 JSON 与共享常量逐字节一致');
  assert.equal(computeSnapshotHash(snap), CROSS_LANG_FIXTURE.hash, 'keccak256 与共享常量一致');
});

test('snapshot 契约：NFT 单的两键追加在 skus 之后（与前端同一 fixture）', () => {
  const row = {
    slug: 'p-fix-nft',
    title: 'NFT 商品',
    description: '',
    description_blocks: '[]',
    images: '[]',
    kind: 'nft',
    shipping_fee_cny_fen: 0,
    age_restricted: 0,
    specs: '[]',
    skus: [{ sku_key: '', price_cny_fen: 300 }],
    // 故意大写：实现必须归一成小写（否则同一件商品会得到两个哈希）
    nft_contract: '0xAbC0000000000000000000000000000000000001',
    nft_standard: 'erc1155',
  };
  const snap = snapshotObject(row);
  assert.equal(JSON.stringify(snap), CROSS_LANG_FIXTURE.nftCanonical);
  assert.equal(computeSnapshotHash(snap), CROSS_LANG_FIXTURE.nftHash);
});
