/**
 * **退出路径**（`src/shutdown.js`）——判据在这里，因为它是纯模块（依赖全部注入）。
 *
 * ## 为什么值得这样测
 *
 * 这一段此前**完全不存在**：Node 对 `SIGTERM` 默认立即终止，于是每次 `docker stop` /
 * `systemctl stop` / 编排滚动更新都是硬杀 —— 在途请求被掐断、起了一半的事务被回滚，
 * 而且**不留日志边界**，事后无从判断当时做到哪一步。
 *
 * 补上它之后，"写了那几行"与"接上去了、退出码对"是两件事，所以本文件两组判据都要：
 *
 *   ① **内核层**（本文件，注入假 process/server/clock）：顺序（先停监听 → 再关库 → 退出）、
 *      退出码（信号 0 / 崩溃非 0）、超时之后照常往下走、重复信号只走一遍；
 *   ② **进程层**（`test/shutdown-process.test.js`，起真进程）：真的起得来、真的排空在途请求、
 *      端口真的不再接受连接。
 *
 * ## 为什么"信号投递"这一跳不在单测里
 *
 * Windows 上 `child.kill('SIGTERM')` **不会**触发 JS 的 `'SIGTERM'` 监听器 ——
 * 它直接把进程打死（实测最小复现：`code=null signal=SIGTERM`，handler 一行都没打）。
 * 所以本文件把"信号到达之后做什么"（可测）与"信号怎么到达"（平台相关）分开：
 * 前者在这里钉死，后者由真进程用例在 Linux 上覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdown } from '../src/shutdown.js';

/** 造一个可观测的假环境：记录调用顺序、退出码，并可让 server.close 永不回调（模拟卡住的连接） */
function harness({ drainMs = 50, closeNeverCallsBack = false, openTx = 0, closeDbThrows = false } = {}) {
  const calls = [];
  const exits = [];
  const logs = [];
  const errors = [];
  const handlers = new Map();
  const io = {
    server: {
      close: (cb) => {
        calls.push('server.close');
        if (!closeNeverCallsBack) setTimeout(() => cb(), 1);
      },
    },
    closeDb: async () => {
      calls.push('closeDb');
      if (closeDbThrows) throw new Error('注入的关库失败');
      return { openTx };
    },
    config: { shutdownDrainMs: drainMs },
    proc: {
      exit: (code) => {
        calls.push(`exit:${code}`);
        exits.push(code);
      },
      on: (ev, fn) => handlers.set(ev, fn),
    },
    log: (...a) => logs.push(a.join(' ')),
    error: (...a) => errors.push(a.join(' ')),
  };
  return { io, calls, exits, logs, errors, handlers, vm: createShutdown(io) };
}

test('正常停机：**先停监听 → 再关库 → 退出**，且退出码 0（顺序错了在途请求会拿到 500）', async () => {
  const h = harness();
  await h.vm.shutdown('SIGTERM', 0);
  assert.deepEqual(
    h.calls,
    ['server.close', 'closeDb', 'exit:0'],
    '顺序必须是 stop-listening → close-db → exit（先关库会让在途请求全部拿到 "db not initialized"）'
  );
  assert.match(h.logs.join('\n'), /已关闭（原因：SIGTERM/, '退出前必须留下一行可读边界');
});

test('信号接线：SIGTERM / SIGINT 都退 0；未捕获异常与未处理拒绝都退**非 0**', async () => {
  for (const [ev, code] of [
    ['SIGTERM', 0],
    ['SIGINT', 0],
  ]) {
    const h = harness();
    assert.ok(h.handlers.has(ev), `${ev} 必须被接住（否则 Node 默认立即终止 = 硬杀）`);
    h.handlers.get(ev)();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(h.exits, [code], `${ev} 必须退 ${code}`);
  }
  for (const ev of ['uncaughtException', 'unhandledRejection']) {
    const h = harness();
    assert.ok(h.handlers.has(ev), `${ev} 必须有 handler`);
    h.handlers.get(ev)(new Error('注入的崩溃'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.exits.length, 1);
    assert.notEqual(h.exits[0], 0, `${ev} 必须退非 0——编排据此重启，退 0 会被当成正常下线`);
    assert.match(h.errors.join('\n'), /注入的崩溃/, '崩溃现场必须留下原始错误信息（否则只剩一个退出码）');
  }
});

test('排空超时：照常往下走（关库 + 退出），并在日志里说明"可能未排空"', async () => {
  // server.close 永不回调 = 一个卡住的 keep-alive 连接；没有超时机制时进程会永远挂着
  const h = harness({ drainMs: 30, closeNeverCallsBack: true });
  const t0 = Date.now();
  await h.vm.shutdown('SIGTERM', 0);
  const ms = Date.now() - t0;
  assert.ok(ms >= 25 && ms < 1000, `必须等满 drainMs 再放弃（实测 ${ms}ms）`);
  assert.deepEqual(h.calls, ['server.close', 'closeDb', 'exit:0'], '超时之后仍必须关库并退出');
  assert.match(h.logs.join('\n'), /可能未排空/, '超时必须在日志里说出来（否则"优雅关闭"只是自我感觉）');
});

test('仍有事务开着 ⇒ 明确警告（它们是唯一一类"关进程会让结局不确定"的东西）', async () => {
  const h = harness({ openTx: 2 });
  await h.vm.shutdown('SIGTERM', 0);
  assert.match(h.errors.join('\n'), /2 个数据库事务仍开着/, '必须说出来，否则事后无法解释"某个写入为什么没落库"');
});

test('关库失败不许把退出吞掉：照常退出，且把原因打进日志', async () => {
  const h = harness({ closeDbThrows: true });
  await h.vm.shutdown('SIGTERM', 0);
  assert.deepEqual(h.calls, ['server.close', 'closeDb', 'exit:0'], '关库失败也必须退出（否则进程挂着而端口已关）');
  assert.match(h.errors.join('\n'), /关闭数据库时出错/, '失败原因必须留痕');
});

test('重复信号只走一遍：第二个退出码不得覆盖第一个（先到的原因才是真的）', async () => {
  const h = harness({ drainMs: 500 });
  const first = h.vm.shutdown('SIGTERM', 0);
  const second = h.vm.shutdown('uncaughtException', 1); // 关到一半时崩溃
  await Promise.all([first, second]);
  assert.deepEqual(h.exits, [0], '只应退出一次，且用先到的那个码（0 = 停机时不把崩溃算成失败）');
  assert.equal(h.calls.filter((c) => c === 'closeDb').length, 1, '关库只应发生一次');
  assert.equal(h.vm.isShuttingDown(), true);
});
