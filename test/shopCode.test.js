/**
 * 店铺编号：**生产生成器**（node/src/ids.js 的 newShopCode）与**同一目录的校验实现**
 * （node/src/shopCode.js，公开节点仓自带）必须对得上。
 *
 * 旧文件测的是已删除的“哈希铸造”算法和已删除的合约 fixture，生产生成器反而没人测——
 * 于是校验位漂移不会红。这里直接对 newShopCode 做性质与逐值断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newShopCode } from '../src/ids.js';

const { encodeShopCodeFromData, isShopCodeShape, verifyShopCode } = await import('../src/shopCode.js');

test('固定数据位 → 固定编号（加权校验）', () => {
  assert.equal(encodeShopCodeFromData('00000001'), '000000018');
  const ok = '000000018';
  assert.equal(verifyShopCode(ok), ok);
  assert.equal(verifyShopCode(ok.toLowerCase()), ok, '大小写不敏感，归一化为大写');
});

test('单字符错误与换位都被校验位拒绝', () => {
  const ok = '000000018';
  assert.equal(verifyShopCode('00000001A'), null, '校验位错');
  assert.equal(verifyShopCode('00000011'), null, '数据位错');
  assert.equal(verifyShopCode('00000081'), null, '换位');
  assert.equal(verifyShopCode(ok.slice(0, 8)), null, '少一位');
  assert.equal(isShopCodeShape(ok.slice(0, 8) + '!'), false, '非法字符');
});

test('形状检查与完整校验分开：扩展符号只在第 9 位合法', () => {
  // 数据位出现扩展符号：形状通过，但 verify 必须返回 null（不得抛错）
  const bad = '0000000-8';
  assert.equal(isShopCodeShape(bad), true);
  assert.equal(verifyShopCode(bad), null);
});

test('newShopCode 生成的编号全部能通过共享校验，且形状稳定', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const code = newShopCode();
    assert.equal(code.length, 9);
    assert.match(code, /^[0-9A-HJKMNP-TV-Z.\-_~,]{9}$/);
    assert.equal(verifyShopCode(code), code, `生产编号 ${code} 过不了共享校验`);
    assert.equal(seen.has(code), false, `重复编号 ${code}`);
    seen.add(code);
  }
});
