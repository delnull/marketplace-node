/**
 * 标识符格式（src/ids.js）。
 *
 * 这组断言是**给别人看的契约**：订单号/商品标识会出现在聊天记录、客服工单、
 * 纸质单据与搜索框里，所以"长度固定、只有不易念错的字符、没有连字符"是产品要求，
 * 不是实现细节——将来有人想换回 UUID 时，这里会先红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { newClaimNo, newOrderId, newProductSlug, normalizeId } from '../src/ids.js';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

test('订单号：21 字符、B 开头、无连字符、只用 Crockford 字符集', () => {
  for (let i = 0; i < 200; i += 1) {
    const id = newOrderId();
    assert.equal(id.length, 21);
    assert.equal(id[0], 'B');
    assert.ok(CROCKFORD.test(id), `出现字符集外的字符：${id}`);
  }
});

test('商品标识：11 字符、P 开头、无连字符', () => {
  for (let i = 0; i < 200; i += 1) {
    const slug = newProductSlug();
    assert.equal(slug.length, 11);
    assert.equal(slug[0], 'P');
    assert.ok(CROCKFORD.test(slug));
  }
});

test('提货声明号：21 字符、C 开头、与订单号同一套字符集', () => {
  for (let i = 0; i < 200; i += 1) {
    const claimNo = newClaimNo();
    assert.equal(claimNo.length, 21);
    assert.equal(claimNo[0], 'C');
    assert.ok(CROCKFORD.test(claimNo));
  }
});

test('订单号前缀：同一毫秒前缀相同、不同毫秒不同，字典序即时间序', () => {
  const t1 = Date.UTC(2026, 8, 16, 3, 0, 0);
  const t2 = t1 + 3600_000;
  const a = newOrderId(t1);
  const b = newOrderId(t2);
  assert.ok(a < b, '同一毫秒之后的下单，单号字典序应当更大（日志/列表可直接按单号排序）');
  // B + 10 位时间前缀：同一毫秒的单号前 11 位必须相同，不同毫秒必须不同
  assert.equal(a.slice(0, 11), newOrderId(t1).slice(0, 11));
  assert.notEqual(a.slice(0, 11), b.slice(0, 11));
});

test('订单号前缀就是 10 位 base32 毫秒时间戳（独立已知向量）', () => {
  assert.equal(newOrderId(0).slice(0, 11), 'B0000000000');
  assert.equal(newOrderId(32).slice(0, 11), 'B0000000010');
  assert.equal(newOrderId(33).slice(0, 11), 'B0000000011');
});

test('随机段足够宽：同毫秒 5 万次生成无重复', () => {
  const t = Date.now();
  const seen = new Set();
  for (let i = 0; i < 50_000; i += 1) seen.add(newOrderId(t));
  assert.equal(seen.size, 50_000);
});

test('normalizeId：去空白、折大写、Crockford 别名；非字符串一律空串', () => {
  assert.equal(normalizeId('  b0v3k7q1z  '), 'B0V3K7Q1Z');
  assert.equal(normalizeId('B0V3K7QIZ'), 'B0V3K7Q1Z', 'I 读成 1');
  assert.equal(normalizeId('B0V3K7QLZ'), 'B0V3K7Q1Z', 'L 读成 1');
  assert.equal(normalizeId('BOV3K7Q1Z'), 'B0V3K7Q1Z', 'O 读成 0');
  // Unicode 折叠是可预期的（toUpperCase 后再做 Crockford 别名）；它不是形状校验器，不能当安全过滤用
  assert.equal(normalizeId('ſ'), 'S');
  assert.equal(normalizeId('ı'), '1');
  assert.equal(normalizeId(''), '');
  assert.equal(normalizeId('   '), '');
  for (const bad of [null, undefined, 123, true, [], {}, ['B0V3K7Q1Z']]) {
    assert.equal(normalizeId(bad), '', `${JSON.stringify(bad)} 不是字符串`);
  }
});

test('生成端产出的标识归一化后不变（归一化只影响抄写错误，不改变身份）', () => {
  for (let i = 0; i < 200; i += 1) {
    const order = newOrderId();
    const slug = newProductSlug();
    const claim = newClaimNo();
    assert.equal(normalizeId(order), order);
    assert.equal(normalizeId(slug), slug);
    assert.equal(normalizeId(claim), claim);
  }
});
