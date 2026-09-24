/**
 * 管理审计（P1-④）：记录店主/操作员（staff）的管理写操作与敏感导出。
 *
 * 约定：
 *  - 仅 staff 动作入审计（owner/operator；买家动作不进——资金/退款链上行为由事件史与证据覆盖）；
 *  - detail 为调用方提供的 JSON 变更摘要，**禁止包含码原文/完整收货地址/令牌**（各调用点遵守）；
 *  - actor_role 由调用方按当前角色判定（路由层已做鉴权）；
 *  - 每行入**哈希链**（prev_hash/entry_hash）：算法、三态纪律与"能查出什么/查不出什么"
 *    全部写在 `auditChain.js` 文件头——本文件只负责把链头读对、和插入放进同一个事务。
 */
import { getDb, txBegin, txCommit, txRollback } from './db.js';
import { auditEntryHash, chainHead } from './auditChain.js';

export function logAudit({ req, actor, actorRole, action, targetType, targetId, detail = {} }) {
  // 仅店主/操作员的管理动作入审计（买家动作不进——资金/退款由链上事件史与证据覆盖）
  if (actorRole === 'user') return;
  try {
    const db = getDb();
    /*
      链头读取与插入**必须在同一个事务里**（db.js 的 txBegin/txCommit/txRollback；已在事务中时
      自动降级为 SAVEPOINT，故路由层的事务分组不受影响）。否则两个写者/两次交错写入会读到同一个
      链头、各自插一行指向它——链在此分叉，此后每一行都会被校验器报成断裂（而它们谁都没被改）。
      注意：事务区段内没有 await（RPC/网络调用一律在外），符合 db.js 的事务纪律。
    */
    txBegin();
    try {
      const prevHash = chainHead(db);
      const ins = db
        .prepare(
          'INSERT INTO audit_logs (at, actor, actor_role, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          Date.now(),
          String(actor || '').toLowerCase(),
          actorRole === 'operator' ? 'operator' : 'owner',
          String(action || ''),
          String(targetType || ''),
          String(targetId || '').slice(0, 120),
          JSON.stringify(detail || {}),
          String(req?.ip || req?.socket?.remoteAddress || '').slice(0, 64)
        );
      const id = Number(ins.lastInsertRowid);
      /*
        先插、回读、再落哈希：`id` 由 AUTOINCREMENT 分配而它参与哈希，只能在插入后才知道它。
        回读（而不是拿内存里的入参）是刻意的——被哈希的字节必须与校验器将来 SELECT 到的是
        **同一份**，否则 SQLite 的存储类转换/截断会变成两套口径。
        代价：每行两次写（INSERT + UPDATE，同一事务内，外部读者看不到中间态）。审计只有 staff
        写操作才落一行，这点开销换"行号也绑进哈希"（否则把某行内容原样搬到另一个 id 上连哈希
        都不用重算，见 auditChain.js 文件头）。行不会被 UPDATE 之外的路径改：全仓只有本函数写审计。
      */
      const row = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(id);
      db.prepare('UPDATE audit_logs SET prev_hash = ?, entry_hash = ? WHERE id = ?').run(
        prevHash,
        auditEntryHash(prevHash, row),
        id
      );
      txCommit();
    } catch (e) {
      txRollback();
      throw e;
    }
  } catch (e) {
    // 审计为非关键路径：失败仅告警，绝不影响业务动作的成败
    console.error('[audit] 写入失败（不影响业务）:', action, e.message || e);
  }
}

/** 审计查询（分页倒序；action/actor 可选过滤） */
export function queryAudit({ page = 1, pageSize = 30, action, actor }) {
  const where = [];
  const params = [];
  if (action) {
    where.push('action = ?');
    params.push(String(action));
  }
  if (actor) {
    where.push('actor = ?');
    params.push(String(actor).toLowerCase());
  }
  const db = getDb();
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`).get(...params).c;
  const rows = db
    .prepare(`SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return {
    total,
    page,
    pageSize,
    items: rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: r.actor,
      actorRole: r.actor_role,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      detail: (() => {
        try {
          return JSON.parse(r.detail || '{}');
        } catch {
          return {};
        }
      })(),
      ip: r.ip,
    })),
  };
}
