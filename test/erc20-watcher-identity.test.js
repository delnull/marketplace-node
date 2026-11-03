/**
 * ERC20 订单的 watcher 身份回归（P0）：
 *  - `chainParamsMatch` 在本地缺 `payment_token` 时必须 fail-closed，不能再把“SELECT 漏列”
 *    伪装成原生单（旧写法 `|| ZERO_ADDRESS`）；
 *  - watcher 的 `localRowOf` 与 reconcile 的候选 SELECT 必须带 payment_token——这三条 SELECT
 *    是链上事件能否驱动本地状态的唯一取数入口，漏一列就会让 ERC20 单永久停在 draft。
 *
 * 这是结构性探针（读源码文本），因为真正的 `pollOnce` 需要整套 RPC/日志桩；它钉住的正是
 * “漏列不会报错”的那个形状。行为测试见 reviews/payment-tokens 与全量用例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainParamsMatch } from '../src/chainOrder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const watcher = fs.readFileSync(path.join(here, '..', 'src', 'escrowWatcher.js'), 'utf8');
const reconcile = fs.readFileSync(path.join(here, '..', 'src', 'chainReconcile.js'), 'utf8');

test('chainParamsMatch：本地缺 payment_token 时 ERC20 单必须 fail-closed', () => {
  const zero = '0x0000000000000000000000000000000000000000';
  const token = '0x1111111111111111111111111111111111111111';
  const base = {
    buyer: '0x0000000000000000000000000000000000000002',
    seller: '0x0000000000000000000000000000000000000003',
    amount_wei: '1000',
    timeout_blocks: 10,
  };
  const p = {
    buyer: base.buyer,
    seller: base.seller,
    amount: '1000',
    timeoutBlocks: 10,
    token,
  };
  assert.equal(chainParamsMatch({ ...base, payment_token: token }, p), true);
  assert.equal(
    chainParamsMatch(base, p),
    false,
    '本地缺 payment_token 时不能把 token 单当成原生单放行'
  );
  assert.equal(
    chainParamsMatch({ ...base, payment_token: zero }, p),
    false,
    '同数字的原生灰尘单不能顶替 ERC20 单'
  );
});

test('watcher/reconcile 的订单取数 SELECT 必须带 payment_token', () => {
  assert.match(
    watcher,
    /SELECT o\.id AS order_id[\s\S]*?payment_token[\s\S]*?FROM order_chain c JOIN orders o/,
    'escrowWatcher.localRowOf 漏了 o.payment_token'
  );
  const reconcileSelects = [...reconcile.matchAll(/SELECT o\.order_id[\s\S]*?FROM v_orders o/g)].map(
    (m) => m[0]
  );
  assert.ok(reconcileSelects.length >= 3, 'chainReconcile 的候选 SELECT 数量变了，请同步检查');
  for (const sql of reconcileSelects) {
    assert.match(sql, /\bpayment_token\b/, `chainReconcile 候选 SELECT 漏了 payment_token：${sql.slice(0, 80)}…`);
  }
});
