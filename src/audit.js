/**
 * 管理审计（P1-④）：记录店主/店员（staff）的管理写操作与敏感导出。
 *
 * 约定：
 *  - 仅 staff 动作入审计（owner/operator；买家动作不进——资金/退款链上行为由事件史与证据覆盖）；
 *  - detail 为调用方提供的 JSON 变更摘要，**禁止包含码原文/完整收货地址/令牌**（各调用点遵守）；
 *  - actor_role 由调用方按当前角色判定（路由层已做鉴权；`host`/`owner`/`staff` 三值逐字落库）；
 *  - **shop_code 由调用方显式给出**（`null` = 节点级）——这一行"归谁看"由它决定，见 logAudit；
 *  - 每行入**哈希链**（prev_hash/entry_hash）：算法、值的规范形、三态纪律与"能查出什么/查不出什么"
 *    全部写在 `auditChain.js` 文件头——本文件只负责把链头读对、和插入放进同一个事务。
 *
 * 时间列 `at` **不由本文件赋值**：它是 `DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)`，
 * 由服务器盖章（应用端时钟错了也写不错，运维能直接 `WHERE at >= '2026-10-01'`）。
 * 哈希是在**回读之后**算的（见下），所以"服务器盖的那个时刻"就是被绑进哈希的那一个。
 *
 * ── 店铺维度（2026-10-16 补上）──
 * 一节点 N 家店，而审计行原先没有任何店铺标识：读的判据只剩 `ownerOnly`，于是**任一店店主
 * 都能读到整个节点的审计行**——包括别家店的订单号与变更摘要。这是数据模型错，不是权限没配好：
 * "这家店发生过什么"必须由行自己回答，而不是由"谁在查"去猜。
 */
import { getDb, withTransaction } from './db.js';
import { auditEntryHash, chainHead } from './auditChain.js';
// 来源 IP 的唯一入口：clientIp 消费 Express 的 trust proxy 解析结果（见 http.js）。
// 在这里再读一次 req.ip 就是在同一件事上多出一个判据，它会与限流键/请求日志漂移。
import { clientIp } from './http.js';

/**
 * 撞 `uq_audit_head`（链头刚被别人推进）时的重试上限。5 次足够让"两个写者同时进来"这种
 * 一过性碰撞收敛（每次重试都会看到更新的链头）；一直撞说明链本身有问题，那时如实告警。
 */
const AUDIT_APPEND_ATTEMPTS = 5;

/**
 * 写一行审计。
 *
 * @param {string|null} shopCode **必填**：这一行所属店铺的编号；`null` = 节点级（不属于任何店）。
 *   `undefined`（调用方没表态）与 `''`（"空店铺"）都**抛错**，不落库。
 *
 * 为什么把"没给"与"节点级"分开：`NULL` 是一个**明确结论**（节点级事件：节点资料、开店审批、
 * 保留期触发、系统动作），拿它当"调用方忘了给"的兜底就是本表栽过的那类折叠——`head_slot`
 * 曾经把"未哈希的历史行"与"链首"折进同一个槽位，于是此后再也写不进任何审计行（见 db.js）。
 * 一个归属不明的审计行只能有两种结局：被当成节点级（只有节点主看得见，那家店永远查不到
 * 自己店里发生过什么），或被当成某家店（把别家店的事记到它头上）。两种都是假的。
 *
 * 为什么抛错而不是"告警后照写"：订单面那 9 个调用点此前正是这个形态——`roleOf(addr, '')`
 * 恒为 `'user'`，本函数直接 return，**一条审计都不落**，日志里一个字都没有（前端还挂着
 * order.ship / order.cancel 这些动作的中文标签，看起来一切正常）。审计是非关键路径，
 * 但"这一行根本不会被写出来"不是运行期故障，是代码错：它要响，而且要在**写库之前**响
 * （下面 try 里的运行期失败照旧只告警，业务动作不受影响）。
 */
export async function logAudit({ req, actor, actorRole, action, targetType, targetId, detail = {}, shopCode }) {
  if (shopCode === undefined || shopCode === '') {
    throw new TypeError(
      `logAudit 缺少 shopCode（action=${action}）：这家店的动作传店铺编号，节点级动作**显式**传 null。` +
        '归属决定这一行谁能看见，猜一个就是伪造一条审计。'
    );
  }
  const shop = shopCode === null ? null : String(shopCode);
  // 仅店主/店员的管理动作入审计（买家动作不进——资金/退款由链上事件史与证据覆盖）
  if (actorRole === 'user') return;
  /*
    角色**逐字落库**（host/owner/staff），不再把非 owner 一律折成 operator。
    多店之后"以什么身份动的手"是审计要回答的核心问题之一：同一个地址可以是
    A 店的店主、B 店的店员（或节点主），折成两个值就等于把这条信息丢掉。
    取值不在枚举内（调用方没传/传错）时按 owner 落库并**告警**——审计行不能因为
    一个角色字段写不进去就整条丢掉，但也不能静默地把一次身份不明的动作说成正常。
    （列是 ENUM('host','owner','staff')：给一个枚举外的值，MySQL STRICT 模式会直接拒绝整行。）
  */
  const role = ['host', 'owner', 'staff'].includes(String(actorRole)) ? String(actorRole) : '';
  if (!role) {
    console.warn(`[audit] 调用方未给出合法 actorRole（${actorRole}），本次按 owner 落库：${action}`);
  }
  try {
    const db = getDb();
    /*
      链头读取与插入**必须在同一个事务里**（`withTransaction` 的回调就是事务的作用域；
      已在事务中时自动降级为 SAVEPOINT，故路由层的事务分组不受影响）。否则两个写者/两次交错写入
      会读到同一个链头、各自插一行指向它——链在此分叉（而它们谁都没被改）。

      ⚠️ **撞键必须重试**（2026-10-16 删掉全局写锁之后，这一步是承重的）：两个并发写者仍会
      读到同一个链头（一致读不加锁），而"两行指认同一个前驱"由 `uq_audit_head` 拦下 ——
      第二个 INSERT 得到 `ER_DUP_ENTRY`。撞键的含义是**链头刚被别人推进了**，正确处置是
      **重读链头再插一次**（旧实现靠全局写锁串行化，所以不必重试；锁没了，不重试就等于
      静默丢掉一条审计行——审计是非关键路径，异常只会打一行日志，没人会注意到）。
      重试有界：一直撞说明链本身有问题，交给下面那句告警如实说"这次没落上"。

      第二道网是**列上的约束**（`uq_audit_head`：`IFNULL(prev_hash,'')` 上的唯一索引）——
      分叉（含"两行自称链首"）在 INSERT 那一步就失败，而不是留下一段事后才能发现的断裂。

      注意：事务区段内没有 await 数据库以外的东西（RPC/网络调用一律在外），符合 db.js 的事务纪律。
    */
    for (let attempt = 1; ; attempt += 1) {
      try {
        await withTransaction(async () => {
          /*
            链头必须在 INSERT **之前**读出来，并在 INSERT 时就把 `prev_hash` 写进去。

            为什么不能"先插入 NULL 前驱、再 UPDATE 补上"：`audit_logs.head_slot`
            是 `IFNULL(prev_hash,'')` 的生成列，上面有 UNIQUE（`uq_audit_head`）——
            "没有前驱"被折成一个常量，所以**全表至多一行** prev_hash 为 NULL。
            先插 NULL 再补，等于在事务中间让两行同时"自称链首"，那条 INSERT 会当场
            被唯一索引拒绝（实测：`Duplicate entry '' for key 'audit_logs.uq_audit_head'`）——
            这正是我们要的保护（分叉在落库这一步不可表达），代价是新行的前驱必须**已知**。
          */
          const prevHash = await chainHead(db);
          const ins = await db.run(
            'INSERT INTO audit_logs (actor, actor_role, shop_code, action, target_type, target_id, detail, ip, prev_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            String(actor || '').toLowerCase(),
            role || 'owner',
            shop,
            String(action || ''),
            String(targetType || ''),
            String(targetId || '').slice(0, 120),
            // JSON 列：传 JSON 文本，由服务器解析并规范化（键序/空白由它定，回读得到的就是那一份）
            JSON.stringify(detail || {}),
            clientIp(req).slice(0, 64),
            prevHash
          );
          const id = Number(ins.insertId);
          /*
            先插、回读、再落哈希：`id` 由 AUTO_INCREMENT 分配而它参与哈希，只能在插入后才知道它。
            回读（而不是拿内存里的入参）是刻意的——被哈希的字节必须与校验器将来 SELECT 到的是
            **同一份**，否则驱动的取值转换（`at` 是 `Date`、`detail` 是 JSON 解出的对象、
            BIGINT 走 number/string 两档、列宽与排序规则）会变成两套口径，而症状是校验器把干净的链
            报成断裂。回读把"库里存了什么"变成哈希的唯一输入。
            代价：每行两次写（INSERT + UPDATE，同一事务内，外部读者看不到中间态）。审计只有 staff
            写操作才落一行，这点开销换"行号也绑进哈希"（否则把某行内容原样搬到另一个 id 上连哈希
            都不用重算，见 auditChain.js 文件头）。行不会被 UPDATE 之外的路径改：全仓只有本函数写审计。
            （`prev_hash` 不在这条 UPDATE 里：它在 INSERT 时就定下来了，见上。）
          */
          const row = await db.get('SELECT * FROM audit_logs WHERE id = ?', id);
          await db.run('UPDATE audit_logs SET entry_hash = ? WHERE id = ?', auditEntryHash(row.prev_hash ?? null, row), id);
        });
        return;
      } catch (e) {
        const forked = /ER_DUP_ENTRY|Duplicate entry/i.test(`${e?.code || ''} ${e?.message || ''}`);
        if (forked && attempt < AUDIT_APPEND_ATTEMPTS) continue; // 链头被人推进了：重读再插
        throw e;
      }
    }
  } catch (e) {
    /*
      外键（`fk_audit_shop`）失败 = 这个 shop_code 指不到任何一家店：**调用方的错**，
      原样抛出去（与上面缺 shopCode 同一条判据）。吞掉它的后果是永久且静默的——
      这类事件从此一条审计都没有，而库里看不到任何痕迹。
      其余失败（库不可达、撞键重试耗尽）仍按"审计为非关键路径"只告警，绝不影响业务动作的成败。
    */
    if (/ER_NO_REFERENCED_ROW/i.test(`${e?.code || ''} ${e?.message || ''}`)) throw e;
    console.error('[audit] 写入失败（不影响业务）:', action, e.message || e);
  }
}

/**
 * 审计**列表**查询（按店铺维度过滤；分页倒序；action/actor 可选过滤）。
 *
 * @param {string|null} shopCode **必填**（与 logAudit 同一口径）：9 位编号 = 那家店的审计行；
 *   `null` = **节点级**行（不属于任何店）。`undefined` 抛错——"忘了给"不等于"节点级"：
 *   前者会把别家店的行读出来，正是这次要消灭的那个洞。
 *
 * ── 为什么过滤只加在列表上，链仍然是节点级的 ──
 * 链（`auditChain.js`）是**节点级证据**：`uq_audit_head` 只认 prev_hash，`verifyAuditChain` 全表一遍。
 * 按店过滤之后看到的是链上一个**带空洞**的子集（相邻两行之间隔着别家店的行），任何"重算上一行
 * entry_hash"的校验都会把这些空洞报成 `audit-prev-hash-mismatch`——**假警报**。假警报比原来的越权更糟：
 * 真断裂会淹没在噪声里，而运维会去查一个不存在的篡改。所以：
 *   · 校验只有 `verifyAuditChain` 一处，它**没有店铺参数，也不该有**（分店校验 = 制造假警报）；
 *   · 本函数只管列表，且 DTO 里**不出现** prev_hash/entry_hash —— 读者手里根本没有链的相邻关系，
 *     也就无从把"别家店的行被过滤掉了"读成"链条断了"。
 * 代价如实写：单独一家店**无法自证**自己那批审计行没被删（它看到的是子集），而"某家店的行整段
 * 消失"在节点级校验里表现为"相邻行接不上"（能查到，但只有 host/运维跑校验时才看得到）。
 * 分店建链是被否掉的那条路：它让"把一行改判给另一家店""跨店删/插"从每条分链上都消失，
 * 且"全表至多一行自称链首"这条分叉保护会退化成"每家店至多一行"。
 *
 * DTO 里**不带** shop_code：一次查询只可能是"这家店"或"节点级"两种范围之一，逐行再抄一遍那个
 * 编号是同一事实的第二份副本（而且它会诱使前端按行再筛一次——那正是"渲染层当安全边界"的形状，
 * 本仓在订单列表那里已经明确否掉过）。
 */
export async function queryAudit({ page = 1, pageSize = 30, action, actor, shopCode }) {
  if (shopCode === undefined) {
    throw new TypeError(
      'queryAudit 缺少 shopCode：本店审计传店铺编号，节点级审计**显式**传 null。' +
        '漏给等于把整个节点的审计行读出来——这正是这次要消灭的那个洞。'
    );
  }
  const where = [shopCode === null ? 'shop_code IS NULL' : 'shop_code = ?'];
  const params = shopCode === null ? [] : [String(shopCode)];
  if (action) {
    where.push('action = ?');
    params.push(String(action));
  }
  if (actor) {
    where.push('actor = ?');
    params.push(String(actor).toLowerCase());
  }
  const db = getDb();
  const whereSql = 'WHERE ' + where.join(' AND ');
  const total = Number((await db.get(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`, ...params)).c);
  const rows = await db.all(`SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
  return {
    total,
    page,
    pageSize,
    items: rows.map((r) => ({
      id: r.id,
      // `at` 是 DATETIME(3) → `Date`：对外 JSON 自动是 ISO-8601（与全仓时间口径一致）
      at: r.at,
      actor: r.actor,
      actorRole: r.actor_role,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      // JSON 列由驱动解成对象（db.js 的 baseConnectionOptions 没开 jsonStrings）。
      // 旧实现这里 JSON.parse 一次——那是 detail 还是 TEXT 时的形状；换成 JSON 列之后
      // 再 parse 一个对象会抛，而抛在这里等于整个审计列表 500。
      detail: r.detail ?? {},
      ip: r.ip,
    })),
  };
}
