/**
 * 测试用 Redis 假客户端：只实现 src/redis.js 用到的命令，带过期时间。
 *
 * 这不是运行时的内存回退——生产代码没有内存分支；这里只在 `node --test` 进程里替换
 * Redis 客户端，让限流/缓存走同一套 INCR/PEXPIRE/GET/SET 调用路径。
 */
export function createFakeRedis() {
  const strings = new Map(); // key -> { value, exp }
  const counters = new Map(); // key -> { value, exp }

  const alive = (m, k) => {
    const it = m.get(k);
    if (!it) return null;
    if (it.exp && it.exp <= Date.now()) {
      m.delete(k);
      return null;
    }
    return it;
  };

  return {
    isReady: true,
    on() {},
    destroy() {},
    async connect() {},
    async ping() { return 'PONG'; },
    async incr(k) {
      const it = alive(counters, k) || { value: 0, exp: 0 };
      it.value += 1;
      counters.set(k, it);
      return it.value;
    },
    async pExpire(k, ms) {
      const it = counters.get(k) || strings.get(k);
      if (!it) return 0;
      it.exp = Date.now() + Number(ms);
      return 1;
    },
    async pTTL(k) {
      const it = alive(counters, k) || alive(strings, k);
      if (!it) return -2;
      return it.exp ? Math.max(0, it.exp - Date.now()) : -1;
    },
    async get(k) {
      return alive(strings, k)?.value ?? null;
    },
    async set(k, value, opts = {}) {
      const px = opts.PX ?? opts.px ?? 0;
      strings.set(k, { value: String(value), exp: px ? Date.now() + Number(px) : 0 });
      return 'OK';
    },
    async del(k) {
      const had = strings.delete(k) || counters.delete(k);
      return had ? 1 : 0;
    },
  };
}
