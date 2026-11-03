/**
 * 预算闸门单测 —— 这是**唯一决定"能不能花这笔钱"的地方**，所以它的每条拒绝理由都要钉住。
 *
 * 这些用例全是"钱"的语言：没授权不许买、域名单价要单独授权、超上限要拦下。
 * 判据只有一处（budget.mjs），所以这里测到的就是真跑时的行为（up/plan 都调它）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainPriceOf, enforce, monthlyEquivalent } from '../lib/budget.mjs';

const cost = (over = {}) => ({
  serverMonthly: 50,
  domainTotal: 75,
  domainYears: 1,
  domainYearly: 75,
  serverSource: '测试',
  domainSource: '测试',
  ...over,
});

test('没给 --max-monthly：直接拒绝，且理由说清"这是支出授权"', () => {
  const r = enforce({ maxMonthly: undefined, maxDomainYear: 100, cost: cost() });
  assert.equal(r.ok, false);
  assert.match(r.why, /支出授权/);
  assert.match(r.why, /--max-monthly/);
});

test('maxMonthly 为 0 或负数时同样拒绝（0 不是"不限"，是"没授权"）', () => {
  assert.equal(enforce({ maxMonthly: 0, cost: cost() }).ok, false);
  assert.equal(enforce({ maxMonthly: -1, cost: cost() }).ok, false);
});

test('要买域名但没给 --max-domain-year：拒绝（域名是不可撤销支出，要单独授权）', () => {
  const r = enforce({ maxMonthly: 200, maxDomainYear: undefined, cost: cost() });
  assert.equal(r.ok, false);
  assert.match(r.why, /--max-domain-year/);
});

test('不买域名（domainTotal=0）时不需要 --max-domain-year', () => {
  const r = enforce({ maxMonthly: 200, maxDomainYear: undefined, cost: cost({ domainTotal: 0, domainYearly: 0 }) });
  assert.equal(r.ok, true);
});

test('域名单价超上限：拒绝，并给出两个数', () => {
  const r = enforce({ maxMonthly: 500, maxDomainYear: 50, cost: cost() });
  assert.equal(r.ok, false);
  assert.match(r.why, /75/);
  assert.match(r.why, /50/);
});

test('折合月成本包含域名摊销：机器 50/月 + 域名 1200/年 ⇒ 150/月', () => {
  assert.equal(monthlyEquivalent({ serverMonthly: 50, domainTotal: 1200, domainYears: 1 }), 150);
  // 一次买 2 年则摊到 24 个月
  assert.equal(monthlyEquivalent({ serverMonthly: 50, domainTotal: 1200, domainYears: 2 }), 100);
});

test('折合月成本刚好等于上限：通过（边界是"不超过"，不是"严格小于"）', () => {
  const r = enforce({ maxMonthly: 150, maxDomainYear: 1000, cost: cost({ serverMonthly: 50, domainTotal: 1200, domainYears: 1 }) });
  assert.equal(r.ok, true);
  assert.equal(r.monthly, 150);
});

test('机器月价超上限：拒绝，并说明明细来自哪里（实时价或人给的价）', () => {
  const r = enforce({
    maxMonthly: 40,
    maxDomainYear: 1000,
    cost: cost({ serverMonthly: 50, domainTotal: 0, domainYearly: 0, serverSource: '阿里云 DescribePrice 实时价' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /阿里云 DescribePrice 实时价/);
});

/*
  ── 域名单价取哪一个：**一处判据，plan 与 up 同一句话**（2026-10-15 审计 F10）────────
  此前 up 自己拼一份（服务商报非元价就要求 --price-domain）、plan 另拼一份（有价就照用，
  把币种问题留给闸门）⇒ 同一件事两句话，用户先看 plan 再跑 up 会以为其中一个坏了。
*/
test('domainPriceOf：服务商报元价 ⇒ 直接用；报外币/没价 ⇒ 要人给的元价；都没有 ⇒ 说清怎么修', () => {
  const cny = domainPriceOf({ price: { yearly: 55, currency: 'CNY', source: '阿里云 CheckDomain' } });
  assert.deepEqual(cny, { ok: true, yearly: 55, currency: 'CNY', source: '阿里云 CheckDomain', manual: false });

  // 外币报价：不许折算，要求 --price-domain；给了就按元用，并如实标明来源是人给的
  const usdNoManual = domainPriceOf({ price: { yearly: 13, currency: 'USD', source: 'Route 53 Domains' } });
  assert.equal(usdNoManual.ok, false);
  assert.match(usdNoManual.reason, /13\/USD/, '要把服务商报的数与币种说出来，用户才知道为什么不能用');
  assert.match(usdNoManual.reason, /--price-domain/, '要给出可照做的下一步');
  const usdManual = domainPriceOf({ price: { yearly: 13, currency: 'USD' }, priceDomain: 70 });
  assert.equal(usdManual.ok, true);
  assert.equal(usdManual.yearly, 70);
  assert.equal(usdManual.currency, 'CNY', '人给的价一律按元（不混币种）');
  assert.match(usdManual.source, /你给的价/);

  // 服务商查不到价：同样要人给
  assert.equal(domainPriceOf({ price: { yearly: null, currency: null } }).ok, false);
  assert.equal(domainPriceOf({ price: { yearly: null, currency: null }, priceDomain: 70 }).ok, true);

  // 币种缺失（'' / null）按元处理：CNY 集合里本来就含空值（见 budget.mjs）
  assert.equal(domainPriceOf({ price: { yearly: 55, currency: null } }).ok, true);
});
