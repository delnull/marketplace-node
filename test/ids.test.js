/**
 * 标识符格式（src/ids.js）。
 *
 * 这组断言是**给别人看的契约**：订单号/商品标识会出现在聊天记录、客服工单、
 * 纸质单据与搜索框里，所以"长度固定、只有不易念错的字符、没有连字符"是产品要求，
 * 不是实现细节——将来有人想换回 UUID 时，这里会先红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { newOrderId, newProductSlug, isNewOrderId, isNewProductSlug, orderIdTime } from '../src/ids.js';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

test('订单号：21 字符、无连字符、只用 Crockford 字符集', () => {
  for (let i = 0; i < 200; i += 1) {
    const id = newOrderId();
    assert.equal(id.length, 21);
    assert.equal(id[0], 'B');
    assert.ok(CROCKFORD.test(id), `出现字符集外的字符：${id}`);
    assert.ok(!id.includes('-'), `不应含连字符：${id}`);
    assert.ok(isNewOrderId(id));
  }
});

test('商品标识：11 字符、P 开头、无连字符', () => {
  for (let i = 0; i < 200; i += 1) {
    const slug = newProductSlug();
    assert.equal(slug.length, 11);
    assert.equal(slug[0], 'P');
    assert.ok(CROCKFORD.test(slug));
    assert.ok(isNewProductSlug(slug));
  }
});

test('订单号前缀编码下单时刻，且字典序 = 时间序', () => {
  const t1 = Date.UTC(2026, 8, 16, 3, 0, 0);
  const t2 = t1 + 3600_000;
  const a = newOrderId(t1);
  const b = newOrderId(t2);
  assert.equal(orderIdTime(a), t1);
  assert.equal(orderIdTime(b), t2);
  assert.ok(a < b, '同一毫秒之后的下单，单号字典序应当更大（日志/列表可直接按单号排序）');
});

test('随机段足够宽：同毫秒 5 万次生成无重复', () => {
  const t = Date.now();
  const seen = new Set();
  for (let i = 0; i < 50_000; i += 1) seen.add(newOrderId(t));
  assert.equal(seen.size, 50_000);
});

test('历史标识继续可用：不认识的形状不会被判成非法', () => {
  // 校验函数只用于展示层判断，不能变成"拒绝老数据"的闸门
  assert.equal(isNewOrderId('ae9c128c-6a90-4989-87e5-7dd7c5b57482'), false);
  assert.equal(isNewProductSlug('p-3f9a2b7c1d4e'), false);
  assert.equal(orderIdTime('ae9c128c-6a90-4989-87e5-7dd7c5b57482'), null);
});
