/**
 * 死锁有界重试（`withDeadlockRetry`）的单元判据。
 *
 * 背景：两个事务并发导入同一批副本行时会在 `NOT EXISTS` 插入上互锁；MySQL 回滚其中一个，
 * 旧实现把它映射成 503 让客户端重试——而这是一个**幂等导入**，服务端重跑一次就能收敛
 * （第二次事务看到行已存在，imported=0）。重试必须发生在**事务边界**：死锁后事务已回滚，
 * 拿着旧快照继续写只会更糟。
 *
 * 判据：
 *   ① 死锁在前两次失败、第三次成功 ⇒ 返回第三次的结果（且调用者只看到一次成功）；
 *   ② 非并发冲突的错误（业务 400、外键错误）⇒ **不重试**，原样上抛；
 *   ③ 一直死锁 ⇒ 用尽 attempts 后抛最后一个死锁错误（不无限重试）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDeadlockRetry, isDeadlockError } from '../src/dbErrors.js';

const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock'), {
  code: 'ER_LOCK_DEADLOCK',
  errno: 1213,
});
const foreignKey = () => Object.assign(new Error('Cannot add or update a child row'), {
  code: 'ER_NO_REFERENCED_ROW_2',
  errno: 1452,
});

test('死锁：前两次失败、第三次成功 ⇒ 返回结果，调用方只看到成功', async () => {
  let calls = 0;
  const out = await withDeadlockRetry(async () => {
    calls += 1;
    if (calls < 3) throw deadlock();
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(calls, 3, '必须真的重跑事务，而不是骗过调用方');
});

test('非并发冲突的错误不重试（业务失败不能被当成"再试一次"吞掉）', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withDeadlockRetry(async () => {
        calls += 1;
        throw foreignKey();
      }),
    /Cannot add or update a child row/
  );
  assert.equal(calls, 1, '外键/校验类错误重试只会重复同样的失败');
});

test('一直死锁：用尽 attempts 后抛最后一个死锁错误（有界，不无限重试）', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withDeadlockRetry(
        async () => {
          calls += 1;
          throw deadlock();
        },
        { attempts: 3, baseDelayMs: 1 }
      ),
    (e) => isDeadlockError(e),
  );
  assert.equal(calls, 3);
});

test('判据本身：MySQL 1213/1205 与驱动 code 都认', () => {
  assert.equal(isDeadlockError(deadlock()), true);
  assert.equal(isDeadlockError(Object.assign(new Error('x'), { errno: 1205 })), true);
  assert.equal(isDeadlockError(Object.assign(new Error('x'), { code: 'ER_LOCK_WAIT_TIMEOUT' })), true);
  assert.equal(isDeadlockError(new Error('x')), false);
  assert.equal(isDeadlockError(null), false);
});
