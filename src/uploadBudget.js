/**
 * 按人的**小时字节额度**（商品媒体上传）——预留 / 结算 / 释放的唯一实现。
 *
 * 旧形状是"上传前查一次已用字节、成功后再记账"：查与写之间隔着整段流式上传（最长 50MB），
 * 并发请求各自读到同一个旧合计 ⇒ 都能通过，实际用量可以超出上限最多"每个并发请求一个
 * MAX_UPLOAD_BYTES"。额度是磁盘成本的闸，靠调用方"记得先查"就不是闸。
 *
 * 现在把**预留**放在流式上传之前：`reserve()` 在同一个同步段里做完"清算窗口 + 判上限 + 占位"
 * （JS 单线程，中间没有 await ⇒ 两个请求不可能同时通过），成功后才开始读请求体。
 * 上传结束：
 *   · 成功 ⇒ `commit(reservation, actualBytes)` 把占位**下调**到实际字节（多留的立即归还）；
 *   · 失败 ⇒ `release(reservation)` 全额归还（类型不符/超限/连接中断都不该吃掉额度）。
 *
 * 为什么只下调、不上调：单次上传的硬上限就是预留值（`MAX_UPLOAD_BYTES`），实际字节不可能更大；
 * 若真出现更大值，说明媒体层的上限判据漏了——此时把它夹在预留值内（额度仍不越界），
 * 由媒体层自己负责拒绝（`productMedia.storeMediaStream` 已按同一常量在写盘前拒绝）。
 *
 * 全部状态在**进程内**（与请求限流同款取舍）：多实例部署需网关层按账号限速；进程重启清零
 * 的代价是"重启后额度重新计算"，不会把磁盘用量放大到无界（孤儿媒体另有运维清理口径）。
 */
export class UploadByteBudget {
  /**
   * @param {{limitBytes:number, windowMs?:number, now?:() => number}} opts
   *   limitBytes = 窗口内允许的字节上限；now 可注入（测试用，生产走 Date.now）
   */
  constructor({ limitBytes, windowMs = 3_600_000, now = () => Date.now() } = {}) {
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
      throw new Error('UploadByteBudget: limitBytes 必须是正数（额度为 0 会让所有上传静默失败）');
    }
    this.limitBytes = Math.floor(limitBytes);
    this.windowMs = windowMs;
    this._now = now;
    this._entries = new Map(); // actor → [{ id, at, bytes }]
    this._seq = 0;
  }

  /** 该 actor 在窗口内**已占用的字节数**（含尚未结算的预留；过期条目顺手清掉） */
  used(actor) {
    const key = String(actor || '');
    return this._rows(key, this._now()).reduce((n, r) => n + r.bytes, 0);
  }

  _rows(actor, now) {
    const rows = (this._entries.get(actor) || []).filter((r) => now - r.at < this.windowMs);
    if (rows.length) this._entries.set(actor, rows);
    else this._entries.delete(actor);
    return rows;
  }

  /**
   * 预留一次上传的额度（**同步**、在开始读请求体之前调用）。
   * @param {string} actor 上传者地址（额度按人计，不按 IP）
   * @param {number} bytes 预留字节数（应传单次上传硬上限 `MAX_UPLOAD_BYTES`）
   * @returns {{ok:true, reservation:{id:number, bytes:number}} | {ok:false, used:number, limitBytes:number}}
   *   `ok:false` 时**不产生任何占位**，调用方应直接拒绝（连请求体都不要读）。
   */
  reserve(actor, bytes) {
    const key = String(actor || '');
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) throw new Error('UploadByteBudget.reserve: bytes 必须是正数');
    const now = this._now();
    const rows = this._rows(key, now);
    const used = rows.reduce((sum, r) => sum + r.bytes, 0);
    if (used + n > this.limitBytes) return { ok: false, used, limitBytes: this.limitBytes };
    const reservation = { id: ++this._seq, bytes: Math.floor(n), actor: key };
    rows.push({ id: reservation.id, at: now, bytes: reservation.bytes });
    this._entries.set(key, rows);
    return { ok: true, reservation };
  }

  /** 上传成功：把预留**下调**为实际字节（只减不增，见文件头） */
  commit(reservation, actualBytes) {
    if (!reservation) return;
    const rows = this._entries.get(reservation.actor);
    if (!rows) return;
    const row = rows.find((r) => r.id === reservation.id);
    if (!row) return;
    const actual = Number(Math.max(0, Math.floor(Number(actualBytes) || 0)));
    row.bytes = Math.min(row.bytes, actual);
  }

  /** 上传失败：全额归还这次预留（不留下"上传失败却吃掉额度"的账） */
  release(reservation) {
    if (!reservation) return;
    const rows = this._entries.get(reservation.actor);
    if (!rows) return;
    const i = rows.findIndex((r) => r.id === reservation.id);
    if (i >= 0) rows.splice(i, 1);
    if (!rows.length) this._entries.delete(reservation.actor);
  }

  /** 仅供测试：清空全部占位 */
  reset() {
    this._entries.clear();
  }
}
