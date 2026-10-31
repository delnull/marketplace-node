/**
 * Redis：跨进程共享的限流计数与短缓存。
 *
 * 这是节点运行时的**硬依赖**，不是可选装饰：匿名读限流、支付 token 白名单缓存都在 Redis 里，
 * 没有 Redis 就没有唯一的计数/缓存来源。`MK_REDIS_URL` 未配置或连不上时启动直接失败，
 * 请求路径也**不回退进程内 Map**（回退会让多实例各自计数，等于把限流关掉）。
 *
 * 连接懒加载且只建一次；日志只报错误消息，不打印 URL（可能含密码）。
 * 测试用 `__setRedisClientForTest` 注入内存假客户端，生产代码不读这个入口。
 */
import { createClient } from 'redis';
import config from './config.js';

let _client = null;
let _connecting = null;
let _warned = false;

/** 测试注入：只替换客户端，不改变真实代码路径。 */
export function __setRedisClientForTest(client) {
  _client = client;
  _connecting = null;
  _warned = false;
}

export async function getRedis() {
  if (_client?.isReady) return _client;
  if (_connecting) return _connecting;
  if (!config.redisUrl) {
    throw new Error('MK_REDIS_URL 未配置：节点运行时必须提供 Redis');
  }
  _connecting = (async () => {
    let c;
    try {
      c = createClient({
        url: config.redisUrl,
        // 启动/请求都不能挂在无限重连上：连不上就失败，由 startup/健康检查 loud 地报出来。
        socket: { connectTimeout: 3_000, reconnectStrategy: false },
      });
    } catch (e) {
      throw new Error(`Redis 客户端创建失败：${e?.message || e}`);
    }
    c.on('error', (e) => {
      if (!_warned) {
        _warned = true;
        console.warn(`[redis] 运行错误：${e?.message || e}`);
      }
    });
    c.on('end', () => {
      if (_client === c) _client = null;
    });
    try {
      await c.connect();
      _client = c;
      _warned = false;
      return c;
    } catch (e) {
      try { c.destroy(); } catch { /* ignore */ }
      throw new Error(`Redis 连接失败：${e?.message || e}`);
    } finally {
      _connecting = null;
    }
  })();
  return _connecting;
}

/** 启动自检：连不上就拒绝启动，而不是带着一个静默失效的限流器对外服务。 */
export async function assertRedisReady() {
  const c = await getRedis();
  await c.ping();
  return true;
}

function keyOf(kind, key) {
  return `${config.redisPrefix}:${config.db.name}:${kind}:${String(key)}`;
}

/**
 * 固定窗口计数：INCR + 首次 PEXPIRE。Redis 故障直接抛错（调用方 fail-closed）。
 * @returns {Promise<{count:number, ttlMs:number}>}
 */
export async function redisHit(key, windowMs) {
  const c = await getRedis();
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
  await c.set(keyOf('cache', key), JSON.stringify(value), { PX: Math.max(1, Math.floor(ttlMs)) });
  return true;
}

export async function redisDel(key) {
  const c = await getRedis();
  await c.del(keyOf('cache', key));
  return true;
}

/** 健康检查读数：未配置/不可用只报状态，不抛错。 */
export async function redisHealth() {
  if (!config.redisUrl) return { configured: false, connected: false };
  const p = getRedis();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Redis 健康检查超时')), 300);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const c = await Promise.race([p, timeout]);
    return { configured: true, connected: !!c?.isReady };
  } catch {
    p.catch(() => {});
    return { configured: true, connected: false };
  } finally {
    clearTimeout(timer);
  }
}
