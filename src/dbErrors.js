/**
 * 数据库**并发冲突**的判据与重试（不依赖连接池）。
 *
 * MySQL 的死锁（1213）与等锁超时（1205）都属于"换个时序可能成功"：当前事务已被数据库回滚，
 * 既不是业务失败，也不是服务内部错误。判据有两类消费方，必须同一处：
 *   · `http.js`：映射成 503 + "请稍后重试"（不能含糊成 500，也不能在那里静默重放事务回调——
 *     回调里可能已有业务副作用，盲目重跑不安全）；
 *   · `withDeadlockRetry`：在**显式声明可重试**的事务边界上做有界重试。
 * 各处各写一遍 `errno === 1213 || …` 的话，漏一处就多一个"重试语义只覆盖一半"的入口：
 * 某个路由自己重试、另一个只回 503，客户端看到的行为随路由而变。
 *
 * 为什么本文件不 import `db.js`：判据与重试只依赖"错误长什么样"，不需要连接池。
 * 放进 db.js 会让只测这段逻辑的用例被迫在导入 db.js 之前先导入测试装配（库名必须在
 * db.js 模块加载时就已经设好，见 test/db-isolation.test.js 的守卫）——那是把连接层的
 * 初始化顺序强加给一个纯函数。
 */

export function isDeadlockError(e) {
  return (
    e?.code === 'ER_LOCK_DEADLOCK' ||
    e?.code === 'ER_LOCK_WAIT_TIMEOUT' ||
    Number(e?.errno) === 1213 ||
    Number(e?.errno) === 1205
  );
}

/**
 * 在**事务边界**上有界重试死锁。
 *
 * 只包裹整个 `withTransaction(...)` 调用，不在事务内部 `continue`：死锁发生时 MySQL 已经把
 * 整个事务回滚了，重试必须从 `BEGIN` 重新读状态——否则就是拿着一个已死的快照继续写。
 *
 * 什么时候该用：**整段事务只写库、且重跑安全**的幂等入口（池导入、配额加量、状态回写）。
 * 什么时候不该用：回调里有外部副作用（外呼、发通知）——重试会重复副作用；
 * 以及"冲突本身就是业务结果"的地方（例如抢同一个坑位，失败方应如实拿到冲突）。
 *
 * 代价：同一请求最多多跑 `attempts - 1` 次整段事务（这些尝试本来也会失败）；
 * 退避是毫秒级抖动，不是"把超时调大"——把冲突推给别人只是把死锁换成更长的等待。
 */
export async function withDeadlockRetry(fn, { attempts = 3, baseDelayMs = 5 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      if (!isDeadlockError(e)) throw e;
      lastErr = e;
      if (i < attempts) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * i * (0.5 + Math.random())));
      }
    }
  }
  throw lastErr;
}
