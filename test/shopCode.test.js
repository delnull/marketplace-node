import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { ethers } from "ethers";
/*
  店铺编号算法（链上铸造的 9 位编号）的**唯一实现**在 `shared/shopCode.js`：合约、节点与前端共用它，
  并做跨语言对拍。本文件只改"去哪找"，不改任何判据。

  两种目录布局都要能跑（取决于本目录在仓库里的层级）：
    · `../../shared/shopCode.js`：上面还有别的包（contracts/、frontend/）的那种布局；
    · `../shared/shopCode.js`：仓库里只有节点这一份代码时。
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

const REG = "0x3333333333333333333333333333333333333333";
/** 与合约一致：keccak256(abi.encode(chainId, registry, counter)) */
const hashOf = (seq, { chainId = 2999, registry = REG } = {}) =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "uint64"], [chainId, registry, seq])
  );
const codeOf = (seq, env) => encodeShopCodeFromHash(hashOf(seq, env));

test("店铺编号：形状、唯一、不可猜、校验位能挡住敲错", () => {
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

  assert.notEqual(codeOf(1), codeOf(1, { chainId: 1 }), "不同链 → 不同序列");
  assert.notEqual(
    codeOf(1),
    codeOf(1, { registry: "0x4444444444444444444444444444444444444444" }),
    "不同合约 → 不同序列"
  );
});
