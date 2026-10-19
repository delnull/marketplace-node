import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { ethers } from "ethers";
/*
  店铺编号算法（链上铸造的 9 位编号）的**唯一实现**在 `shared/shopCode.js`：合约、节点与前端共用它，
  并做跨语言对拍。本文件只改"去哪找"，不改任何判据。

  两种目录布局都要能跑（取决于本目录在仓库里的层级）：
    · `../../shared/shopCode.js`：上面还有别的包（contracts/、frontend/）的那种布局；
    · `../shared/shopCode.js`：公开节点仓里只有节点这一份代码时（`node/**` 被摊到仓库根）。
  ethers 按包名解析：它是节点自己的生产依赖，两种布局下都成立。
*/
const SHARED_URL = [
  new URL('../../shared/shopCode.js', import.meta.url),
  new URL('../shared/shopCode.js', import.meta.url),
].find((u) => existsSync(u));
assert.ok(SHARED_URL, '找不到 shared/shopCode.js（上面两种目录布局都试过了）');
const {
  encodeShopCodeFromHash, verifyShopCode, isShopCode, isShopCodeShape, SHOP_CODE_LEN,
} = await import(SHARED_URL.href);

/**
 * **合约 fixture**——逐字来自 `contracts/test/ShopCode.t.sol` 的
 * `testFixturesMatchJsImplementation()`（链上那一侧的 `_enc(seq) = ShopCode.encode(2999, REG, seq)`，
 * `REG = 0x3333…3333`）。
 *
 * 为什么必须是**字面量**、而不是"用本文件的算法再算一遍"：下面其余用例断言的是**性质**
 * （长度 9、互不相同、前缀分散、校验位挡敲错），而性质在两侧算法**各改各的**时候依然成立——
 * 合约改字母表、JS 改加权和、两边各自与自己的副本一致 ⇒ 全绿，而链上铸造的编号与前端解析的
 * 编号已经分叉，症状是"编号能查到节点、查不到店"。只有把同一组输入的**输出**钉成字符串，
 * 两侧断言的才是同一个东西。
 *
 * 改动这张表的唯一合法理由：合约 fixture 变了（先改 `ShopCode.t.sol`，再同步这里）。
 */
const FIXTURES = [
  // chainId  registry                                      seq   编号（合约 ShopCode.encode 的输出）
  { chainId: 2999, registry: '0x3333333333333333333333333333333333333333', seq: 1, code: 'RRSFVVB8G' },
  // 校验位落在扩展符号集（第 9 位是 `~`，不是 Base32 字符）：覆盖"编号第 9 位可以不是字母数字"
  { chainId: 2999, registry: '0x3333333333333333333333333333333333333333', seq: 2, code: 'HBBG60HF~' },
  { chainId: 2999, registry: '0x3333333333333333333333333333333333333333', seq: 3, code: 'TDN4J1K26' },
  { chainId: 2999, registry: '0x3333333333333333333333333333333333333333', seq: 42, code: '2EGBK5NES' },
  { chainId: 2999, registry: '0x3333333333333333333333333333333333333333', seq: 1000, code: 'ZMDZRWYWZ' },
];
/** fixture 的链与合约实例（上下两组用例共用，表是唯一来源） */
const CHAIN_ID = FIXTURES[0].chainId;
const REGISTRY = FIXTURES[0].registry;

/**
 * 序号 → 哈希输入：`keccak256(abi.encode(chainId, registry, seq))`，与合约 `ShopCode._dataOf`
 * 同一算式（**必须是 abi.encode 补 32 字节，不是 solidityPacked**——两者哈希输入完全不同，
 * 混用会让同一序号在链上与链下算出不同编号）。
 *
 * 为什么这一层留在测试里而不是收进 `shared/shopCode.js`：那份实现刻意零依赖（哈希由各运行时
 * 用自己手上的 ethers 算好传进去），而"算什么哈希"正是跨语言对拍要对照的**输入**——把它收进
 * 被测实现就等于让被测方自己出题。所以它是全仓 JS 侧唯一一处，且只服务下面两组用例。
 */
const hashOf = (seq, { chainId = CHAIN_ID, registry = REGISTRY } = {}) =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "uint64"], [chainId, registry, seq])
  );
/** 唯一入口：`shared/shopCode.js` 的 `encodeShopCodeFromHash`（哈希层之上的一切都归它） */
const codeOf = (seq, env) => encodeShopCodeFromHash(hashOf(seq, env));

test('店铺编号：与合约 fixture 逐字对拍（contracts/test/ShopCode.t.sol 的 5 组输入）', () => {
  for (const { chainId, registry, seq, code } of FIXTURES) {
    assert.equal(
      codeOf(seq, { chainId, registry }),
      code,
      `(chainId=${chainId}, registry=${registry}, seq=${seq}) 的编号与合约不一致——` +
        `两侧算法已经分叉（改算法必须同时改 ShopCode.t.sol 与本表）`
    );
    // 反向：合约产出的编号必须过 JS 的校验位（前端 `verifyShopCode` 挡在解析之前）
    assert.equal(verifyShopCode(code), code, `合约产出的编号 ${code} 过不了 JS 校验位`);
  }
});

test('店铺编号：形状、唯一、不可猜、校验位能挡住敲错', () => {
  const codes = [];
  for (let i = 1; i <= 50; i += 1) codes.push(codeOf(i));
  for (const c of codes) {
    assert.equal(c.length, SHOP_CODE_LEN, "长度 9（8 数据 + 1 校验）");
    assert.ok(verifyShopCode(c), `校验通过：${c}`);
    assert.equal(verifyShopCode(c.toLowerCase()), c, "大小写不敏感 → 归一化为大写");
  }
  assert.equal(new Set(codes).size, codes.length, "前 50 个编号互不相同");
  assert.ok(!codes[0].startsWith("0000000"), `不是顺序编号：${codes[0]}`);
  assert.ok(new Set(codes.slice(0, 10).map((c) => c.slice(0, 4))).size > 5, "前缀足够分散（不可猜）");

  const ok = codes[5];
  const bad = (ok[0] === "0" ? "1" : "0") + ok.slice(1);
  assert.equal(verifyShopCode(bad), null, "单字符错误被拒绝");
  const swapped = ok[1] + ok[0] + ok.slice(2);
  if (swapped !== ok) assert.equal(verifyShopCode(swapped), null, "相邻换位被拒绝");
  assert.equal(verifyShopCode(ok.slice(0, 8)), null, "少一位被拒绝");
  assert.equal(isShopCodeShape(ok.slice(0, 8) + "!"), false, "含非法字符时形状检查为假");
  /*
    源码审计 2026-09：扩展符号（-._~,）只允许出现在第 9 位校验位。出现在数据位时
    `isShopCodeShape` 会通过（字符集包含扩展符号），此前 `encodeShopCodeFromData` 直接
    **抛异常**——调用方（前端把 URL 段喂进来）从「编号抄错了」升级成未捕获异常/白屏。
    修复后必须按文档契约返回 null。
  */
  for (const badCode of ["1234567-9", "12345,789", "1234567~9", "123456.79"]) {
    assert.equal(verifyShopCode(badCode), null, `数据位含扩展符号应返回 null（不得抛错）：${badCode}`);
  }
  assert.equal(isShopCode(ok), true, "合法编号仍通过（回归：收口不得误伤正常编号）");

  // 哈希掺入 chainId 与合约地址：同字节码在别的链/别处部署不会产出相同序列（防跨链撞号）
  assert.notEqual(codeOf(1), codeOf(1, { chainId: 1 }), "不同链 → 不同序列");
  assert.notEqual(
    codeOf(1),
    codeOf(1, { registry: "0x4444444444444444444444444444444444444444" }),
    "不同合约 → 不同序列"
  );
});
