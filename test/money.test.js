/**
 * 金额展示口径（`src/money.js`）单测。
 *
 * 这个模块存在的理由就是"只有一个实现"：`(fen / 100).toFixed(2)` 与
 * "商品金额 = 总额 − 运费"原先在 orders / arbitration / products 三个路由里各抄了几遍，
 * 任意一处改动都会让同一个数在不同接口里不一样。所以这里把规则本身钉死：
 * 分是整数单位、元固定两位小数、运费按单一次、负数带号、非有限值按 0。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goodsFenOf, yuanOf } from '../src/money.js';

test('money: yuanOf 固定两位小数（整数拆位，不经过浮点除法的尾差）', () => {
  assert.equal(yuanOf(2500), '25.00');
  assert.equal(yuanOf(1250), '12.50');
  assert.equal(yuanOf(5), '0.05');
  assert.equal(yuanOf(0), '0.00');
  assert.equal(yuanOf(99), '0.99');
  assert.equal(yuanOf(100), '1.00');
  assert.equal(yuanOf(-1250), '-12.50');
  // 大额不丢精度：浮点 (1e15/100).toFixed(2) 会先损失有效位
  assert.equal(yuanOf(123456789012345), '1234567890123.45');
});

test('money: yuanOf 对读不到/坏值按 0.00，绝不输出 NaN', () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, 'abc', {}]) {
    assert.equal(yuanOf(bad), '0.00', `坏值应格式化 0：${String(bad)}`);
  }
  // 数字串按数字处理（DB 里 cny_fen 可能是 TEXT 列）
  assert.equal(yuanOf('2500'), '25.00');
  // 入参单位是**分**（整数）：小数分按截断处理（12.5 分 → 12 分 → '0.12'），不四舍五入造钱
  assert.equal(yuanOf('12.5'), '0.12');
});

test('money: goodsFenOf = 总额 − 运费（夹到 ≥ 0），数字单运费为 0 时等于总额', () => {
  assert.equal(goodsFenOf(2500, 500), 2000); // 2 件 ¥10 + 运费 ¥5
  assert.equal(goodsFenOf(2500, 0), 2500); // 包邮/数字商品：总额即商品金额（旧语义）
  assert.equal(goodsFenOf(2500), 2500); // 缺运费字段同上
  assert.equal(goodsFenOf(300, 500), 0); // 坏数据（运费比总额还大）夹到 0，不产生负数商品价
  assert.equal(goodsFenOf(undefined, 500), 0);
  assert.equal(goodsFenOf('2500', '500'), 2000);
  // 拆分必须能拼回总额——这是「商品 + 运费 = 应付」能被买家逐项核对的前提
  assert.equal(goodsFenOf(2500, 500) + 500, 2500);
  assert.equal(yuanOf(goodsFenOf(2500, 500)), '20.00');
  assert.equal(yuanOf(500), '5.00');
});
