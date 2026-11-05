/**
 * 审计的改前/改后（`src/auditDiff.js`）。
 *
 * 判据：
 *   · 只把**真的变了**的键放进 `fields/changes`（提交了但值没变的不算）；
 *   · 对象键序不影响比较（`{a,b}` 与 `{b,a}` 是同一份值）；
 *   · `undefined` 与 `null` 在审计口径下相同；
 *   · 超长字符串/结构化值被截断并留下标记，不能把截断后的内容当成完整值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_TRUNCATED, auditChanges, boundAuditValue, sameAuditValue } from '../src/auditDiff.js';

test('只保留真的变了的键（提交过但值没变的不算）', () => {
  const d = auditChanges(
    { title: '旧标题', price: 100, tags: ['a'] },
    { title: '新标题', price: 100, tags: ['a'] },
    ['title', 'price', 'tags']
  );
  assert.deepEqual(d.fields, ['title']);
  assert.deepEqual(d.changes, { title: { from: '旧标题', to: '新标题' } });
});

test('对象键序无关；undefined 与 null 视为相同', () => {
  assert.equal(sameAuditValue({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(sameAuditValue({ a: [{ x: 1, y: 2 }] }, { a: [{ y: 2, x: 1 }] }), true);
  assert.equal(sameAuditValue(undefined, null), true);
  assert.equal(sameAuditValue(0, false), false, '0 与 false 不是同一个值');
  assert.equal(sameAuditValue(1, '1'), false, '数字 1 与字符串 "1" 不是同一个值');
});

test('project：派生键不参与比较/入库（attributes 的 pair）', () => {
  const project = { attrs: (v) => v.map((x) => ({ name: x.name, value: x.value })) };
  const d = auditChanges(
    { attrs: [{ name: '成色', value: '全新', pair: '成色\0全新' }] },
    { attrs: [{ name: '成色', value: '全新', pair: '成色\0全新（重新算过）' }] },
    ['attrs'],
    { project }
  );
  assert.deepEqual(d.fields, [], 'pair 变化不是用户可见变更');
  const changed = auditChanges(
    { attrs: [{ name: '成色', value: '全新', pair: 'a' }] },
    { attrs: [{ name: '成色', value: '二手', pair: 'b' }] },
    ['attrs'],
    { project }
  );
  assert.deepEqual(changed.changes.attrs.to, [{ name: '成色', value: '二手' }]);
});

test('超长字符串截断并留下标记（不是原样入库，也不冒充完整值）', () => {
  const long = 'x'.repeat(600);
  const d = auditChanges({ title: long }, { title: `${long}y` }, ['title']);
  assert.equal(d.changes.title.from[AUDIT_TRUNCATED], true);
  assert.equal(typeof d.changes.title.from.preview, 'string');
  assert.ok(String(d.changes.title.from.preview).endsWith('…'));
  assert.ok(String(d.changes.title.to.preview).endsWith('…'));
});

test('结构化值超长时换成带 preview 的截断标记', () => {
  const big = Array.from({ length: 100 }, (_, i) => ({ i, text: 'x'.repeat(100) }));
  const bounded = boundAuditValue(big);
  assert.equal(bounded[AUDIT_TRUNCATED], true);
  assert.equal(typeof bounded.preview, 'string');
  assert.ok(bounded.preview.length <= 4001);
  const d = auditChanges({ skus: [] }, { skus: big }, ['skus']);
  assert.equal(d.changes.skus.to[AUDIT_TRUNCATED], true);
});
