/**
 * 按人的**窗口字节额度**（商品媒体/评价图）——Redis 共享计数，预留/结算/释放的唯一实现。
 *
 * 旧形状是"上传前查一次已用字节、成功后再记账"：查与写之间隔着整段流式上传（最长 50MB），
 * 并发请求各自读到同一个旧合计 ⇒ 都能通过，实际用量可以超出上限最多"每个并发请求一个
 * MAX_UPLOAD_BYTES"。额度是磁盘成本的闸，靠调用方"记得先查"就不是闸。
 *
 * 现在预留在 **Redis Lua** 里原子完成（`INCRBY` 前判上限），成功后才开始读请求体；
 * 多后端共享同一份额度，不再有"N 个后端 = N 倍额度"的缺口。
 * 上传结束：成功 `commit` 把占位下调到实际字节；失败 `release` 全额归还。
 *
 * 窗口是**墙钟对齐的固定窗口**（`bucket = floor(Date.now()/windowMs)`），不是滑动窗口：
 * 同一额度在窗口边界前后各用一次，会各占满一份（固定窗口的固有代价）。它防的是持续超量，
 * 不承诺任意连续 60 分钟严格 ≤ 上限。跨窗口的 commit/release 按 reservation.bucket 隔离，
 * 不会给新窗口凭空加额度。键按节点身份隔离（见 redis.js 的 keyOf）。
 */
import { redisReserveUpload, redisAdjustUpload } from './redis.js';

const DEFAULT_WINDOW_MS = 3_600_000;

function positive(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`uploadBudget: ${name} 必须是正数`);
  return Math.floor(n);
}

/**
 * 预留一次上传的额度（**在开始读请求体之前 await**）。
 * @returns {Promise<{ok:true, reservation:{actor:string, bytes:number, windowMs:number}, used:number, limitBytes:number}
 *   | {ok:false, used:number, limitBytes:number}>}
 */
export async function reserveUploadBytes(actor, bytes, limitBytes, windowMs = DEFAULT_WINDOW_MS) {
  const a = String(actor || '');
  const n = positive('bytes', bytes);
  const limit = positive('limitBytes', limitBytes);
  const win = positive('windowMs', windowMs);
  /*
    固定窗口键带 bucket：跨窗口的 commit/release 只会落到**它自己那一格**，
    不会去减新一格里的额度（否则窗口边界上的一次失败上传会给下一窗口凭空加额度）。
    bucket 取应用时钟；多后端靠 NTP 对齐，偏差只影响窗口边界附近的额度，不影响原子性。
  */
  const bucket = Math.floor(Date.now() / win);
  const r = await redisReserveUpload(a, n, limit, win, bucket);
  if (!r.ok) return { ok: false, used: r.used, limitBytes: limit };
  return { ok: true, used: r.used, limitBytes: limit, reservation: { actor: a, bytes: n, windowMs: win, bucket } };
}

/** 上传成功：把预留**下调**为实际字节（只减不增，异常大的值被夹在预留内）。 */
export async function commitUploadBytes(reservation, actualBytes) {
  if (!reservation) return;
  const actual = Math.max(0, Math.floor(Number(actualBytes) || 0));
  const delta = Math.min(0, actual - reservation.bytes);
  if (delta !== 0) await redisAdjustUpload(reservation.actor, delta, reservation.windowMs, reservation.bucket);
}

/** 上传失败：全额归还预留（不留下"上传失败却吃掉额度"的账）。 */
export async function releaseUploadBytes(reservation) {
  if (!reservation) return;
  await redisAdjustUpload(reservation.actor, -reservation.bytes, reservation.windowMs, reservation.bucket);
}
