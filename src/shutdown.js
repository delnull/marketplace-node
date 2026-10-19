/**
 * **退出路径的唯一实现**（`server.js` 只负责接线）。
 *
 * 为什么单独一个模块而不是写在入口文件里：入口文件**不能被 import**（它一被求值就
 * `initDb` + `listen`），于是那里的逻辑在测试里**永远测不到** —— 只能靠源码级断言，
 * 而源码级断言证明不了"接上去了、退出码对"。这一段决定的事又恰好是运维能直接感觉到的：
 *
 *   ① 没有信号处理时，Node 对 `SIGTERM` 就是立即终止 ⇒ `docker stop` / `systemctl stop` /
 *      编排滚动更新每次都**掐断在途请求与起了一半的事务**，而且不留任何日志边界；
 *   ② 退出码必须区分"正常停机"（0）与"崩溃"（非 0）：编排据前者不重启、据后者重启，
 *      而"崩溃也退 0"会让一台已经不自洽的进程被当成正常下线；
 *   ③ 关闭顺序必须是 **先停止收新连接 → 等在途响应 → 再关库**。反过来（先关库）
 *      会让在途请求全部拿到 "db not initialized" —— 那是自己制造的 500。
 *
 * 依赖全部由调用方传入（`io`），所以这个模块**没有副作用、可以被单测直接驱动**：
 * 假 process 记录退出码、假 server 记录 close 调用、假 clock 让超时不用真等。
 *
 * ## 为什么未捕获异常要**退出**而不是"记一条日志继续跑"
 *
 * 对一个管钱的进程，未捕获异常意味着"某处状态没走到它该到的形状"：事务可能提交了一半、
 * 内存里的单飞标志可能永远立着、游标可能跳过了区间。继续跑的代价是**静默错账**
 * （本仓反复列为最坏形态），而重启的代价是几十秒不可用 —— 且恢复靠的是**库里的持久状态**
 * （游标、幂等标记、隔离清单都在库里）。所以选择大声失败：打完日志、走一遍有界的关闭、退非 0。
 */
/**
 * @param {object} io
 * @param {{close:(cb:(err?:Error)=>void)=>void}} io.server  真 server 实例（`app.listen` 的返回）
 * @param {() => Promise<{openTx?:number}>} io.closeDb       关库（唯一实现在 db.js）
 * @param {{shutdownDrainMs:number}} io.config
 * @param {{exit:(code:number)=>void, on:(ev:string,fn:Function)=>void}} io.proc
 * @param {(...a:unknown[])=>void} [io.log]   信息日志（默认 console.log）
 * @param {(...a:unknown[])=>void} [io.error] 错误日志（默认 console.error）
 * @returns {{shutdown:(reason:string, code:number)=>Promise<void>, isShuttingDown:()=>boolean}}
 */
export function createShutdown(io) {
  const { server, closeDb, config, proc } = io;
  const log = io.log || ((...a) => console.log(...a));
  const error = io.error || ((...a) => console.error(...a));
  let shuttingDown = false;

  async function shutdown(reason, code) {
    /*
      两条信号（或"信号 + 崩溃"）同时到达时只走一遍：否则第二遍会在第一遍已经
      `closeDb()`（池置空）之后再关一次库，并且**用第二个退出码**覆盖第一个 ——
      而真正该被记住的是先到的那个原因。
    */
    if (shuttingDown) return;
    shuttingDown = true;
    const t0 = Date.now();

    /*
      停止接受新连接。`server.close()` 的回调在**所有连接都关掉之后**才触发，
      所以不能等它来决定超时 —— 否则一个 keep-alive 连接就能把退出拖到编排的宽限期之外。
      这里让两者赛跑，超时后照常往下走（并在收尾日志里说明"可能未排空"）。
    */
    let drained = true;
    try {
      await Promise.race([
        new Promise((resolve) => server.close(() => resolve(true))),
        new Promise((resolve) => setTimeout(() => { drained = false; resolve(false); }, config.shutdownDrainMs)),
      ]);
    } catch (e) {
      drained = false;
      error(`[server] 停止监听时出错：${e?.message || e}`);
    }

    let openTx = 0;
    try {
      ({ openTx = 0 } = await closeDb());
    } catch (e) {
      error(`[server] 关闭数据库时出错：${e?.message || e}`);
    }

    if (openTx > 0) {
      /*
        事务还开着就说出来：它们是**唯一**一类"关掉进程会让结局不确定"的东西
        （InnoDB 会回滚未提交事务，但那要求连接正常断开 —— 而这里最多只等到 drainMs）。
        这一行是事后排查"某个写入为什么没有落库"的唯一线索。
      */
      error(`[server] 关闭时有 ${openTx} 个数据库事务仍开着——它们会被服务端回滚（未提交的事务不会落库）`);
    }
    log(
      `[server] 已关闭（原因：${reason}；耗时 ${Date.now() - t0}ms；在途连接${drained ? '已排空' : '可能未排空'}）`
    );
    /*
      ⚠️ 这一句是**必须**的，不是"保险起见"：后台还有 unref 过的定时器与 keep-alive 连接，
      事件循环不保证会自己空掉。少了它，`server.close()` 之后进程可能永远挂着 ——
      那比硬杀更糟：编排看到"还在跑"，于是既不重启也不新起，而端口已经不再接受连接。
    */
    proc.exit(code);
  }

  /** 接线：正常停机退 0；崩溃退非 0（编排据此重启）。 */
  proc.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  proc.on('SIGINT', () => void shutdown('SIGINT', 0));
  proc.on('unhandledRejection', (reason) => {
    error('[server] 未处理的 Promise 拒绝（这不是"记一条日志就好"的那类错误，见 src/shutdown.js 的说明）：');
    error(reason instanceof Error ? reason.stack || reason.message : String(reason));
    void shutdown('unhandledRejection', 1);
  });
  proc.on('uncaughtException', (err) => {
    error('[server] 未捕获异常：');
    error(err instanceof Error ? err.stack || err.message : String(err));
    void shutdown('uncaughtException', 1);
  });

  /*
    ── 一个**明确标注为测试钩子**的退出触发点（`MK_SHUTDOWN_ON_STDIN_EOF=1`）────────────
    为什么需要它：容器里 PID 1 的 Node **收不到**它自己安装的默认信号处理器
    （内核不给 PID 1 投递未显式安装的信号），于是最真实的停容器形态在本地**无法复现** ——
    而"进程收到停信号之后到底会不会排空在途请求再退出"这件事必须能被验证，
    否则这一段就只剩"看起来写对了"。

    stdin 关闭是 POSIX 下"发生了一件外部事件"的常见形态，在 Windows 上也能触发
    （父进程关掉管道即 EOF），所以同一个开关在两个平台上都可用。默认关闭：
    它只服务于测试，绝不该在生产里因为"stdin 恰好是 /dev/null"而触发一次退出。
  */
  if (String(proc.env?.MK_SHUTDOWN_ON_STDIN_EOF || '') === '1') {
    proc.stdin?.resume?.();
    proc.stdin?.on?.('end', () => void shutdown('stdin-EOF', 0));
  }

  return { shutdown, isShuttingDown: () => shuttingDown };
}
