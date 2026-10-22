import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sellerOrderFilters } from '../src/sellerOrderFilters.js';

/*
  本函数只返回**筛选条件**：店铺作用域是安全边界，必须由每条 SQL 字面写出
  `shop_code = ?`（列表与导出的静态守卫都钉这一条）。所以这里的断言刻意不要求
  `where` 以 `shop_code` 开头——它若“自带”店铺，调用点反而看不出边界还在不在。
*/
test('卖家筛选：无参数时是中性的 1=1，店铺作用域由调用方 SQL 写死', () => {
  const f = sellerOrderFilters({});
  assert.ok(!('error' in f));
  assert.equal(f.where, '1=1');
  assert.deepEqual(f.params, []);
});

test('卖家筛选：状态参数绑定顺序一致', () => {
  const f = sellerOrderFilters({ status: 'shipped' });
  assert.ok(!('error' in f));
  assert.equal(f.where, '1=1 AND status = ?');
  assert.deepEqual(f.params, ['shipped']);
});

test('卖家筛选：退款待处理带 ACTIVE_IN，和徽标同一谓词', () => {
  const f = sellerOrderFilters({ refund: 'requested' });
  assert.ok(!('error' in f));
  assert.match(f.where, /refund_status = \?/);
  assert.match(f.where, /status IN \(/);
});

test('卖家筛选：检索词转义 LIKE 通配符，并带 COLLATE', () => {
  const f = sellerOrderFilters({ q: 'A%B_C' });
  assert.ok(!('error' in f));
  assert.match(f.where, /COLLATE utf8mb4_0900_ai_ci/);
  assert.equal(f.params[0], 'a%b_c');
  assert.equal(f.params[1], '%a\\%b\\_c%');
});

test('卖家筛选：非法参数返回错误而不是静默忽略', () => {
  assert.match(sellerOrderFilters({ status: 'nope' }).error, /status 无效/);
  assert.match(sellerOrderFilters({ refund: 'nope' }).error, /refund/);
  assert.match(sellerOrderFilters({ q: '   ' }).error, /q 不能为空/);
  assert.match(sellerOrderFilters({ afterSale: 'nope' }).error, /afterSale/);
});
