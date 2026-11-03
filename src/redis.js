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
import { randomUUID } from 'node:crypto';
import config from './config.js';

let _client = null;
let _connecting = null;
let _warned = false;
let _failedAt = 0;

function unavailable(message) {
  const e = new Error(message);
  e.code = 'REDIS_UNAVAILABLE';
  return e;
}

/** 测试注入：只替换客户端，不改变真实代码路径。 */
export function __setRedisClientForTest(client) {
  _client = client;
  _connecting = null;
  _warned = false;
  _failedAt = 0;
}

/** 测试注入：读回当前客户端，用于替换后还原（生产代码不读）。 */
export function __getRedisClientForTest() {
  return _client;
}

export async function getRedis() {
  if (_client?.isReady) return _client;
  if (_connecting) return _connecting;
  if (Date.now() < _failedAt) throw unavailable('Redis 最近连接失败，短暂熔断中');
  if (!config.redisUrl) {
    throw unavailable('MK_REDIS_URL 未配置：节点运行时必须提供 Redis');
  }
  _connecting = (async () => {
    let c;
    try {
      c = createClient({
        url: config.redisUrl,
        /*
          连接超时与命令挂起都要有界，但**不能靠 5 秒 socketTimeout 当空闲超时**：
          那会在没有请求的 5 秒后主动断开，下一次请求再重连（多后端/低流量下持续抖动）。
          空闲保活交给 pingInterval；60 秒 socketTimeout 只兜住真正卡死的连接。
        */
        socket: { connectTimeout: 3_000, reconnectStrategy: false, socketTimeout: 60_000 },
        pingInterval: 30_000,
        // 只用 RESP2：节点不需要 RESP3 特性，测试里的最小 Redis 协议桩也只需实现这一层。
        RESP: 2,
        disableClientInfo: true,
        // Redis socket 卡住时命令不能无界排队：上限 + 离线队列关闭，失败由调用方 fail-closed。
        commandsQueueMaxLength: 1_000,
        disableOfflineQueue: true,
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
      _failedAt = 0;
      return c;
    } catch (e) {
      try { c.destroy(); } catch { /* ignore */ }
      // 失败熔断 5s：Redis 掉线时不要让每个请求都等一次 3s 连接。
      _failedAt = Date.now() + 5_000;
      throw unavailable(`Redis 连接失败：${e?.message || e}`);
    } finally {
      _connecting = null;
    }
  })();
  return _connecting;
}

/** 启动自检：连不上就拒绝启动，而不是带着一个静默失效的限流器对外服务。 */
export async function assertRedisReady() {
  const c = await getRedis();
  try {
    await c.ping();
    return true;
  } catch (e) {
    throw unavailable(`Redis PING 失败：${e?.message || e}`);
  }
}

function keyOf(kind, key) {
  // 节点身份必须进键：两个节点可能都叫 marketplace_node 却共用 Redis；
  // Escrow 地址是链相关缓存（pay-support/chain-code）的唯一节点锚。
  const nodeKey = String(config.chain?.escrowAddress || config.chain?.stakingAddress || 'unconfigured').toLowerCase();
  return `${config.redisPrefix}:${config.db.name}:${nodeKey}:${kind}:${String(key)}`;
}

/**
 * 固定窗口计数：INCR + 首次 PEXPIRE。Redis 故障直接抛错（调用方 fail-closed）。
 *
 * 两条命令必须原子：旧实现 `INCR` 后单独 `PEXPIRE`，进程在两步之间退出会留下无 TTL
 * 的计数键（下一次请求把整个窗口重新延长，限流窗口漂移）。Lua 让“计数 + 首次设置 TTL”
 * 在一次脚本执行里完成；已经是固定窗口语义，不做滑动窗口。
 * @returns {Promise<{count:number, ttlMs:number}>}
 */
const HIT_SCRIPT = `
-- MK_RL_HIT
local n = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {n, ttl}
`;

export async function redisHit(key, windowMs) {
  const c = await getRedis();
  try {
    const k = keyOf('rl', key);
    const [count, ttlMs] = await c.eval(HIT_SCRIPT, {
      keys: [k],
      arguments: [String(Math.max(1, Math.floor(windowMs)))],
    });
    return { count: Number(count), ttlMs: Number(ttlMs) };
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`Redis 限流命令失败：${e?.message || e}`);
  }
}

export async function redisGetJson(key) {
  const c = await getRedis();
  try {
    const raw = await c.get(keyOf('cache', key));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`Redis 缓存读取失败：${e?.message || e}`);
  }
}

export async function redisSetJson(key, value, ttlMs) {
  const c = await getRedis();
  try {
    await c.set(keyOf('cache', key), JSON.stringify(value), { PX: Math.max(1, Math.floor(ttlMs)) });
    return true;
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`Redis 缓存写入失败：${e?.message || e}`);
  }
}

export async function redisDel(key) {
  const c = await getRedis();
  try {
    await c.del(keyOf('cache', key));
    return true;
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`Redis 缓存删除失败：${e?.message || e}`);
  }
}

const RELEASE_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

const RENEW_LOCK = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

/**
 * 跨进程后台任务锁：`SET NX PX` 获取，Lua 比 token 释放。
 *
 * 后台扫描（watcher / 对账 / 清扫）是**状态写入者**；多实例同时跑会重复打 RPC、
 * 竞争游标，甚至把两轮结果交叉写回。Redis 是节点硬依赖，锁也**不回退进程内 Map**：
 * Redis 不可用就抛错，由 tick 的 catch 下轮重试。
 *
 * `renewMs > 0` 时在任务执行期间续租，锁 TTL 只需覆盖一次 Redis 往返，不覆盖整轮扫描；
 * 进程崩溃后锁最多存活 `ttlMs`，而不是整轮任务时长。
 *
 * @returns {Promise<{acquired:true,value:any}|{acquired:false,held:boolean}>}
 *   `held=true` = 锁当前被另一个进程持有（调用方是 standby，不是故障）；
 *   `held=false` = 锁当前空闲却没抢到（SET NX 竞争/Redis 抖动，调用方应下轮重试）。
 */
export async function withRedisLock(name, ttlMs, fn, { renewMs = 0 } = {}) {
  const c = await getRedis();
  const key = keyOf('lock', name);
  const token = randomUUID();
  let acquired;
  try {
    acquired = await c.set(key, token, { NX: true, PX: Math.max(1_000, Math.floor(ttlMs)) });
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`Redis 锁获取失败：${e?.message || e}`);
  }
  if (String(acquired) !== 'OK') {
    /*
      失败后立刻看一眼锁还在不在：这一步把"另一后端正常持锁（standby）"与"锁空闲但 SET 失败
      （竞争/Redis 抖动）"分开——/healthz 对前者的判据是健康，对后者才是不健康。
      查询本身失败不改变获取失败的事实，按 held=false 处理（下轮重试）。
    */
    let held = false;
    try {
      held = Number(await c.exists(key)) === 1;
    } catch {
      held = false;
    }
    return { acquired: false, held };
  }
  let renewTimer = null;
  if (renewMs > 0) {
    renewTimer = setInterval(() => {
      c.eval(RENEW_LOCK, { keys: [key], arguments: [token, String(Math.max(1_000, Math.floor(ttlMs)))] }).catch(() => {});
    }, Math.max(1_000, renewMs));
    if (typeof renewTimer.unref === 'function') renewTimer.unref();
  }
  try {
    return { acquired: true, value: await fn() };
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    try {
      await c.eval(RELEASE_LOCK, { keys: [key], arguments: [token] });
    } catch {
      /* 锁会按 TTL 自动释放；释放失败不能覆盖任务结果 */
    }
  }
}

/* ─────────────────── SIWE 挑战（一次性、短 TTL）─────────────────── */

/**
 * SIWE 挑战：`SET NX PX` 一地址一条，未过期的挑战**不被新请求顶掉**（防覆盖 DoS）。
 *
 * 为什么放 Redis 而不是 `siwe` 表：挑战是**一次性、短 TTL、无审计价值**的临时状态，
 * 正好是 Redis 的语义；放库还要一个清理定时器，且多后端下每轮登录都写一次库。
 * 键按节点身份隔离（`keyOf` 已带 db/合约前缀），多后端共享同一个 Redis。
 *
 * @returns {Promise<string>} 本次生效的签名原文（已有未过期挑战时返回**那一条**）
 */
export async function redisIssueChallenge(address, message, ttlMs) {
  const c = await getRedis();
  const key = keyOf('siwe', String(address).toLowerCase());
  const px = Math.max(1_000, Math.floor(ttlMs));
  try {
    for (let i = 0; i < 2; i++) {
      const ok = await c.set(key, message, { NX: true, PX: px });
      if (String(ok) === 'OK') return message;
      const existing = await c.get(key);
      if (existing != null) return existing;
      // SET 与 GET 之间刚好过期：重试一次；仍拿不到就如实失败，不返回未落库的原文
    }
    throw unavailable('SIWE 挑战写入竞争失败（请重试）');
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`SIWE 挑战写入失败：${e?.message || e}`);
  }
}

/** 读当前挑战（不存在/已过期 = null）。 */
export async function redisGetChallenge(address) {
  const c = await getRedis();
  try {
    return await c.get(keyOf('siwe', String(address).toLowerCase()));
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`SIWE 挑战读取失败：${e?.message || e}`);
  }
}

const CONSUME_CHALLENGE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/**
 * 一次性消费：只有**当前值仍等于这份原文**时才删除（原子比较 + 删除）。
 * 两个并发登录带同一份签名时，只有一个能删到（返回 true），另一个必须失败。
 */
export async function redisConsumeChallenge(address, message) {
  const c = await getRedis();
  try {
    const n = await c.eval(CONSUME_CHALLENGE, {
      keys: [keyOf('siwe', String(address).toLowerCase())],
      arguments: [message],
    });
    return Number(n) === 1;
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`SIWE 挑战消费失败：${e?.message || e}`);
  }
}

/** 删除挑战（测试/运维强制失效；生产登录只走 consume）。 */
export async function redisDeleteChallenge(address) {
  const c = await getRedis();
  try {
    await c.del(keyOf('siwe', String(address).toLowerCase()));
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`SIWE 挑战删除失败：${e?.message || e}`);
  }
}

/* ─────────────────── 上传字节额度（窗口内共享计数）─────────────────── */

const RESERVE_BUDGET = `
-- MK_BUDGET_RESERVE
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local n = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if used + n > limit then
  return {0, used}
end
local value = redis.call('INCRBY', KEYS[1], n)
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
end
return {1, value}
`;

const ADJUST_BUDGET = `
-- MK_BUDGET_ADJUST
local delta = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local value = redis.call('INCRBY', KEYS[1], delta)
if value < 0 then
  redis.call('SET', KEYS[1], '0', 'PX', ttl)
  value = 0
elseif redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
end
return value
`;

/**
 * 上传字节额度的**预留**（原子）：窗口内已用 + 本次预留 > 上限 ⇒ 拒绝，不占位。
 * 用 Redis 而不是进程内 Map：多后端共享同一份额度；Lua 保证并发请求不会都读到旧值。
 */
export async function redisReserveUpload(actor, bytes, limitBytes, windowMs, bucket) {
  const c = await getRedis();
  try {
    const [ok, used] = await c.eval(RESERVE_BUDGET, {
      keys: [keyOf('budget', `${actor}:${bucket}`)],
      arguments: [String(bytes), String(limitBytes), String(windowMs)],
    });
    return { ok: Number(ok) === 1, used: Number(used) };
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`上传额度预留失败：${e?.message || e}`);
  }
}

/** 结算/归还：delta 为负（下调或全额释放），结果夹在 0 以上。 */
export async function redisAdjustUpload(actor, delta, windowMs, bucket) {
  const c = await getRedis();
  try {
    return Number(await c.eval(ADJUST_BUDGET, {
      keys: [keyOf('budget', `${actor}:${bucket}`)],
      arguments: [String(delta), String(windowMs)],
    }));
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`上传额度结算失败：${e?.message || e}`);
  }
}

/* ─────────────────── 登录会话（可撤销令牌 jti）─────────────────── */

/** 签发会话：键 TTL 与令牌 exp 同寿命；Redis 里"键在 = 未撤销且未过期"。 */
export async function redisIssueSession(jti, ttlMs) {
  const c = await getRedis();
  try {
    await c.set(keyOf('session', jti), '1', { PX: Math.max(1_000, Math.floor(ttlMs)) });
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`登录会话写入失败：${e?.message || e}`);
  }
}

export async function redisSessionActive(jti) {
  const c = await getRedis();
  try {
    return Number(await c.exists(keyOf('session', jti))) === 1;
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`登录会话读取失败：${e?.message || e}`);
  }
}

/** 撤销会话（退出登录）；幂等。 */
export async function redisRevokeSession(jti) {
  const c = await getRedis();
  try {
    return Number(await c.del(keyOf('session', jti)));
  } catch (e) {
    if (e?.code === 'REDIS_UNAVAILABLE') throw e;
    throw unavailable(`登录会话撤销失败：${e?.message || e}`);
  }
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
