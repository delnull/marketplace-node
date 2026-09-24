/**
 * 单调时钟（src/monotonicClock.js）：正常流逝跟着走、墙上时钟向前跳不跟跳、
 * 向后跳不倒退、同一进程内单调不减。
 *
 * 全部用注入的假时间源构造跳变场景（毫秒级完成，不等待真实时间、不依赖 jest）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, monotonicNow, processClock } from '../src/monotonicClock.js';

const HOUR = 3600_000;
const YEAR = 365 * 24 * HOUR;
const BASE_WALL = 1_700_000_000_000; // 固定基准，避免用例依赖运行时刻

/** 假时间源：墙钟与单调钟各自可手动推进（单调钟起点为 0，与 performance.now() 同形） */
function fakeTime(wall0 = BASE_WALL, mono0 = 0) {
  const s = { wall: wall0, mono: mono0 };
  return {
    s,
    wallNow: () => s.wall,
    monoNow: () => s.mono,
    /** 两边一起推进（时间正常流逝） */
    advance(ms) {
      s.wall += ms;
      s.mono += ms;
    },
    /** 只推墙钟（NTP step / 快照恢复 / 手改时间：单调钟不动） */
    jumpWall(ms) {
      s.wall += ms;
    },
  };
}

test('时间正常流逝：now() 跟着走（毫秒口径与 Date.now() 一致，可直接比库里的墙上时间戳）', () => {
  const src = fakeTime();
  const clock = createClock(src);
  assert.equal(clock.now(), BASE_WALL, '刚建立时等于基准墙钟');
  src.advance(90_000);
  assert.equal(clock.now(), BASE_WALL + 90_000, '正常流逝 90s 就前进 90s');
  src.advance(1);
  assert.equal(clock.now(), BASE_WALL + 90_001, '毫秒级也要跟住');
  assert.equal(clock.driftMs(), 0, '未跳变时漂移为 0');
});

test('墙上时钟向前跳一年：now() 不跟跳，只走单调流逝的 5 分钟', () => {
  const src = fakeTime();
  const clock = createClock(src);
  const before = clock.now();
  src.advance(5 * 60_000); // 单调：真的过了 5 分钟
  src.jumpWall(YEAR); // 墙钟：向前跳一年（单调钟不受影响）

  assert.equal(clock.now() - before, 5 * 60_000, '只跟单调流逝，绝不跟墙钟向前跳');
  // 非空验证：时钟确实「看到」了这次跳变（诊断读数），只是不据此前进
  assert.equal(clock.driftMs(), YEAR, '墙钟已领先整整一年，被有意忽略');
  assert.ok(clock.now() < src.s.wall - 300 * 24 * HOUR, 'now() 仍远落后于被跳快的墙钟');
});

test('墙上时钟向后跳 3 小时：now() 不倒退，同一进程内单调不减', () => {
  const src = fakeTime();
  const clock = createClock(src);
  const t1 = clock.now();
  src.jumpWall(-3 * HOUR); // 墙钟回拨 3 小时
  assert.equal(clock.now(), t1, '墙钟回拨不得让 now() 倒退');
  src.advance(60_000);
  assert.equal(clock.now(), t1 + 60_000, '回拨之后仍按单调流逝前进');
  assert.equal(clock.driftMs(), -3 * HOUR, '诊断读数如实反映墙钟落后');
});

test('单调不减：连续读数（含抖动/非有限值）都不回退，也不返回 NaN', () => {
  let mono = 0;
  let flaky = false;
  const clock = createClock({ wallNow: () => BASE_WALL, monoNow: () => (flaky ? NaN : mono) });
  let last = clock.now();
  for (let i = 0; i < 200; i++) {
    // 故意让单调读数抖动/回退/变成 NaN：时钟必须靠历史最大值兜住（净额仍是前进）
    mono += i % 3 === 0 ? -5 : 10;
    flaky = i % 17 === 0;
    const t = clock.now();
    assert.ok(Number.isFinite(t), 'now() 必须是有限数（NaN 会让 created_at <= cutoff 恒 false）');
    assert.ok(t >= last, `now() 不得回退：${t} < ${last}`);
    last = t;
  }
  // 非有限读数视为「没有流逝」：只停留在上一个值，不会被 NaN 污染
  mono = NaN;
  assert.equal(clock.now(), last);
});

test('进程级 monotonicNow()：与墙上时钟同口径，且短期读数单调不减', async () => {
  const t0 = monotonicNow();
  assert.ok(Number.isFinite(t0) && Number.isInteger(t0), '必须是整数毫秒');
  assert.ok(Math.abs(t0 - Date.now()) < 2000, '基准取自墙上时钟，量级一致（不跳变时不发散）');
  await new Promise((r) => setTimeout(r, 20));
  const t1 = monotonicNow();
  assert.ok(t1 > t0, '真实时间流逝 20ms 后必须前进');
  assert.ok(t1 - t0 < 2000, '正常流逝不得暴涨（跳变才可能暴涨）');
  assert.ok(processClock.anchorWall <= t0, '进程时钟基准在首次读数之前建立');
});
