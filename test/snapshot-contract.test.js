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
    '{"slug":"p-fix-1","title":"测试 \\"商品\\" & co","description":"desc\\nline2","description_blocks":[' +
    '],"media":[{"type":"image","url":"https://a/b.png"},{"type":"video","url":"/api/uploads/00000000' +
    '-0000-0000-0000-000000000000.mp4","poster":"/api/uploads/11111111-1111-1111-1111-111111111111.jp' +
    'g"}],"kind":"physical","shipping_fee_usdt_micro":5000000,"age_restricted":1,"specs":[{"name":"颜色' +
    '","options":["黑","白"]},{"name":"尺寸","options":["M"]}],"skus":[["尺寸=M|颜色=白",12000000],["尺寸=M|颜色=黑' +
    '",10000000]]}',
  hash: '0x19206bc018b76a2dcfc47377d50e450dbc9817e18426bb280585eaaed728a030',
  /** NFT 单：两个键**追加在 skus 之后**（顺序错了哈希就变，而没人会报错） */
  nftCanonical:
    '{"slug":"p-fix-nft","title":"NFT 商品","description":"","description_blocks":[],"media":[],"kind":' +
    '"nft","shipping_fee_usdt_micro":0,"age_restricted":0,"specs":[],"skus":[["",3000000]],"nft_contr' +
    'act":"0xabc0000000000000000000000000000000000001","nft_standard":"erc1155"}',
  nftHash: '0x0a3b3e6affba38ea4f3034c1f13f02a5a1c7b86520b58494d7320df6c0cbd00f',
};

test('snapshot 契约：跨语言共享 fixture —— 与前端断言同一个 keccak（两侧必须逐字节一致）', () => {
  // node 输入形状：DB 行（snake_case；media/description_blocks/specs 是 JSON 字符串列）
  const row = {
    slug: 'p-fix-1',
    title: '测试 "商品" & co', // 含引号与 &：转义差异会立刻改变 JSON
    description: 'desc\nline2', // 含换行：\n 的写法必须一致
    description_blocks: '[]',
    // 主图区：图片 + 视频各一。**元素里的键序也是契约**（type → url → poster）——
    // 写入路径重建对象时就是这个顺序，两端不能各按自己的写法序列化。
    media: JSON.stringify([
      { type: 'image', url: 'https://a/b.png' },
      {
        type: 'video',
        url: '/api/uploads/00000000-0000-0000-0000-000000000000.mp4',
        poster: '/api/uploads/11111111-1111-1111-1111-111111111111.jpg',
      },
    ]),
    kind: 'physical',
    shipping_fee_usdt_micro: 5_000_000, // 运费必须进快照（否则店主可在下单前事后加价）
    age_restricted: 1, // 年龄限制必须进快照
    // skus 故意乱序传入：实现必须按 sku_key 升序排（顺序影响哈希）
    specs: JSON.stringify([
      { name: '颜色', options: ['黑', '白'] },
      { name: '尺寸', options: ['M'] },
    ]),
    skus: [
      { sku_key: '尺寸=M|颜色=白', price_usdt_micro: 12_000_000 },
      { sku_key: '尺寸=M|颜色=黑', price_usdt_micro: 10_000_000 },
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
    media: '[]',
    kind: 'nft',
    shipping_fee_usdt_micro: 0,
    age_restricted: 0,
    specs: '[]',
    skus: [{ sku_key: '', price_usdt_micro: 3_000_000 }],
    // 故意大写：实现必须归一成小写（否则同一件商品会得到两个哈希）
    nft_contract: '0xAbC0000000000000000000000000000000000001',
    nft_standard: 'erc1155',
  };
  const snap = snapshotObject(row);
  assert.equal(JSON.stringify(snap), CROSS_LANG_FIXTURE.nftCanonical);
  assert.equal(computeSnapshotHash(snap), CROSS_LANG_FIXTURE.nftHash);
});
