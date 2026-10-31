/**
 * Redis：跨进程共享的限流计数与短缓存。
 *
 * 为什么需要（审计 P1/P8）：原限流是进程内 Map，多实例/多进程部署时每个进程各算一份，
 * 匿名读的预算被实例数放大；token 白名单缓存也只在单进程命中。Redis 不是"可选装饰"：
 * 生产多实例必须配置 `MK_REDIS_URL`；测试/单机可不配，走内存兜底。
 *
 * 连接是**懒加载**且只建一次；Redis 故障时调用方回退内存，不让一次缓存抖动把 API 打挂。
 * 日志只报错误消息，不打印 URL（可能含密码）。
 */
import { createClient } from 'redis';
import config from './config.js';

let _client = null;
let _connecting = null;
let _warned = false;

export function redisConfigured() {
  return !!config.redisUrl;
}

/** 连接（或返回 null）：只尝试一次；失败后 5s 内不重复打连接，避免每个请求都重连 */
let _retryAfter = 0;
export async function getRedis() {
  if (!config.redisUrl) return null;
  if (_client?.isReady) return _client;
  if (_connecting) return _connecting;
  if (Date.now() < _retryAfter) return null;
  _connecting = (async () => {
    const c = createClient({ url: config.redisUrl });
    c.on('error', (e) => {
      if (!_warned) {
        _warned = true;
        console.warn(`[redis] 连接/运行失败：${e?.message || e}（限流/缓存暂时回退内存）`);
      }
    });
    try {
      await c.connect();
      _client = c;
      _warned = false;
      return c;
    } catch (e) {
      _retryAfter = Date.now() + 5_000;
      if (!_warned) {
        _warned = true;
        console.warn(`[redis] 连接失败：${e?.message || e}（限流/缓存暂时回退内存）`);
      }
      try { c.destroy(); } catch { /* ignore */ }
      return null;
    } finally {
      _connecting = null;
    }
  })();
  return _connecting;
}

function keyOf(kind, key) {
  return `${config.redisPrefix}:${config.db.name}:${kind}:${String(key)}`;
}

/**
 * 固定窗口计数：INCR + 首次 PEXPIRE。返回 null = Redis 不可用（调用方回退）。
 * @returns {Promise<{count:number, ttlMs:number}|null>}
 */
export async function redisHit(key, windowMs) {
  const c = await getRedis();
  if (!c) return null;
  const k = keyOf('rl', key);
  const count = await c.incr(k);
  if (count === 1) await c.pExpire(k, windowMs);
  let ttlMs = await c.pTTL(k);
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    await c.pExpire(k, windowMs);
    ttlMs = windowMs;
  }
  return { count, ttlMs };
}

export async function redisGetJson(key) {
  const c = await getRedis();
  if (!c) return null;
  const raw = await c.get(keyOf('cache', key));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function redisSetJson(key, value, ttlMs) {
  const c = await getRedis();
  if (!c) return null;
  await c.set(keyOf('cache', key), JSON.stringify(value), { PX: Math.max(1, Math.floor(ttlMs)) });
  return true;
}

export async function redisDel(key) {
  const c = await getRedis();
  if (!c) return null;
  await c.del(keyOf('cache', key));
  return true;
}

/** 健康检查读数（不阻塞：Redis 未配置/不可用只报状态） */
export async function redisHealth() {
  if (!config.redisUrl) return { configured: false, connected: false };
  const c = await Promise.race([
    getRedis(),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 300);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
  return { configured: true, connected: !!c?.isReady };
}
