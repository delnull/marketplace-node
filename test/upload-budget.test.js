/**
 * 上传小时额度的**预留**内核（P3-8）。
 *
 * 旧实现"上传前查一次、成功后记账"：检查与写入之间隔着整段流式上传（最长 50MB），
 * 并发请求各自读到同一个旧合计，于是用量可以超出上限最多 N × 50MB。
 * 现在 `reserve()` 同步完成"清算 + 判上限 + 占位"，成功后才读请求体；
 * `commit()` 把占位下调为实际字节，`release()` 在失败时全额归还。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UploadByteBudget } from '../src/uploadBudget.js';

const LIMIT = 100;
const WINDOW = 1000;

function makeBudget() {
  let now = 1_000_000;
  const b = new UploadByteBudget({ limitBytes: LIMIT, windowMs: WINDOW, now: () => now });
  return { b, advance: (ms) => (now += ms) };
}

test('预留是同步判据：并发请求不可能同时越过上限（旧 check-then-act 会超）', () => {
  const { b } = makeBudget();
  const a = b.reserve('alice', 60);
  assert.equal(a.ok, true);
  const c = b.reserve('alice', 60); // 旧实现两次都能通过（各自读到 used=0）
  assert.equal(c.ok, false, '第二笔预留必须失败：60 + 60 > 100');
  assert.equal(c.used, 60);
  assert.equal(b.used('alice'), 60, '被拒的预留不得留下占位');
  // 别人的额度不受影响
  assert.equal(b.reserve('bob', 100).ok, true);
});

test('commit 下调为实际字节：多留的额度立即归还；只减不增（夹在预留值内）', () => {
  const { b } = makeBudget();
  const r = b.reserve('alice', 80);
  assert.equal(r.ok, true);
  assert.equal(b.used('alice'), 80);
  b.commit(r.reservation, 10);
  assert.equal(b.used('alice'), 10, '实际 10 字节 ⇒ 只占 10');
  const again = b.reserve('alice', 90);
  assert.equal(again.ok, true, '10 + 90 = 100（恰好到上限允许）');
  assert.equal(b.reserve('alice', 1).ok, false);

  // 实际字节大于预留（媒体层上限失效的异常形状）⇒ 夹在预留值内，额度不越界
  const r2 = b.reserve('bob', 40);
  b.commit(r2.reservation, 9_999);
  assert.equal(b.used('bob'), 40, '只减不增：异常大的实际值不得把用量抬高');
});

test('release 全额归还：失败的上传不吃额度；窗口过期自动清算', () => {
  const { b, advance } = makeBudget();
  const r = b.reserve('alice', 100);
  assert.equal(b.reserve('alice', 1).ok, false);
  b.release(r.reservation);
  assert.equal(b.used('alice'), 0, '失败释放后额度归零');
  assert.equal(b.reserve('alice', 100).ok, true);

  advance(1001);
  assert.equal(b.used('alice'), 0, '超出小时窗口的占位被清掉');
  assert.equal(b.reserve('alice', 100).ok, true);
});

test('参数防线：限定额/预留字节非法时响亮失败（不静默变成 0 额度）', () => {
  assert.throws(() => new UploadByteBudget({ limitBytes: 0 }), /limitBytes/);
  const { b } = makeBudget();
  for (const bad of [0, -1, NaN, undefined, 'abc']) {
    assert.throws(() => b.reserve('alice', bad), /bytes/);
  }
});
