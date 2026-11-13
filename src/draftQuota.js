/**
 * 「免费草稿锁库存」的两道闸——**计数器的加量半边**（唯一实现）：
 *
 *   闸 1：同一 **(发起人, 买家)** 活跃草稿 ≤ 10
 *   闸 2：同一 (发起人, 买家) 同一商品未支付草稿的件数合计 ≤ 99
 *
 * 形状是**计数器 + 带守卫的 UPDATE**：越界在**那条 UPDATE 自己**上失败（命中 0 行），
 * 不需要谁把写事务串行化——这正是 `db_write_lock` 删掉之后这两道闸仍然成立的原因。
 * 实测（真 MySQL，独立临时库）：40 并发 → 恰好 10 张通过；20 件 × 20 并发 → 恰好 4 张（80 件）。
 *
 * ## 额度属于**发起人与买家的这一对**，不属于被代下单的买家一个人（2026-10-20 修）
 *
 * `POST /orders` 允许店主替任意买家建草稿（代客单）。旧实现把额度记在 `orders.buyer` 上，
 * 于是店主可以用十张代客草稿占满某个买家的额度，让那位买家自己再也下不了单。
 * 现在两条路径各记各的：
 *   · 自购（`buyer === 发起人`）：`buyer_draft_quota` / `buyer_product_quota`；
 *   · 代客（`buyer !== 发起人`）：`seller_proxy_draft_quota` / `seller_proxy_product_quota`，
 *     键是 `(seller, buyer)`，并在同一事务里写 `proxy_drafts` 标记（触发器据此决定减哪一本账）。
 * 判据是**谁发起**，不是 `buyer != seller`：店主在别家店买东西时 buyer != seller，
 * 但那是自购，只能减买家自己的额度；而代客额度按 (店主, 买家) 成对记账，
 * 既不会把某个买家的额度占满，也不会让一个店主十张代客单就锁死自己所有客户的代客能力。
 *
 * ## 减量在**库侧的触发器**里，不在本文件（见 db.js 的 TRIGGER_DDL）
 *
 * ⚠️ 读这个文件的人最容易漏的就是这一句：`active_drafts` / `units` 的**减量没有任何调用点**，
 * 它由 `orders` 上的触发器在"status 离开 draft"那条语句的同一个事务里完成。
 * **不要在任何地方补一次减量**（那会减两遍）。
 * 为什么减量在库里：离开 draft 的写者有七八个（/paid、/cancel、清扫器、/sync、watcher 的四个分支、
 * 链上对账、测试夹具里直改 status 的 SQL）。判据挂调用点就永远漏得掉，而漏掉是**静默且永久**的：
 * 买家付过 10 笔款之后计数停在 10，他再也建不出草稿。不变量写在 `orders` 的建表注释里。
 *
 * ## 建行必须**无条件先做**（实测的两个坑，别改成"按需建行"）
 *
 *   ① 行不存在时守卫 UPDATE **静默命中 0 行**——按"foundRows === 1 才算占到位"读，等于把
 *      新买家的每一张草稿都当成"已超限"拒掉；
 *   ② "先跑守卫 UPDATE，命中 0 再按需建行"这个形状在 40 并发下会 `ER_LOCK_DEADLOCK`，
 *      而且那一轮只放过 1 个（重复键路径要在同一行上做 S→X 锁升级，几十个事务互相等成环）。
 * 所以先无条件建行（`ON DUPLICATE KEY UPDATE <key> = <key>`：幂等、且不像 `INSERT IGNORE`
 * 那样把"主键过长/类型不符"这类**真错误**降级成警告），再跑守卫 UPDATE。
 * 实测（真库，8 轮 × 40 并发）：每轮恰好 10 个成功、0 异常。
 *
 * ## 为什么不用 `INSERT … ON DUPLICATE KEY UPDATE … IF(… < 10, +1, …)` 直接当闸
 *
 * 实测它的 `affectedRows` 语义无法分辨三种结果：新行插入 = 1、已有行真的 +1 = 2、
 * 已有行**值未变**（= 超限被拒）= 1（CLIENT_FOUND_ROWS 下 1 而不是 0）。
 * "插入"与"被拒"撞在同一个读数上 ⇒ 闸不可判。故采用"建行 + 守卫 UPDATE"两步。
 */
import { getDb } from './db.js';

/** 同一起始人活跃草稿上限（张） */
export const MAX_ACTIVE_DRAFTS = 10;
/** 同一起始人同商品未支付草稿的件数合计上限（件） */
export const MAX_DRAFT_UNITS_PER_PRODUCT = 99;

/** 两道闸的拒因（唯一实现）：预检与事务内的守卫 UPDATE 必须说同一句话 */
function draftLimitFail() {
  return `你的未支付草稿过多（≥${MAX_ACTIVE_DRAFTS}），请先完成支付或取消旧草稿后再下单`;
}
function unitLimitFail(held) {
  return `你对该商品的未支付草稿合计已达 ${held}/${MAX_DRAFT_UNITS_PER_PRODUCT} 件上限——请先完成支付或取消旧草稿后再下单`;
}

/**
 * 额度账本的目标表/条件（唯一实现）：自购记买家账，代客记 (店主, 买家) 账。
 * 模板插值只来自本函数内的固定字符串，不来自请求。
 */
function quotaTargetsOf({ buyer, productId, proxySeller = null }) {
  const proxy = String(proxySeller || '').toLowerCase();
  const buyerKey = String(buyer || '').toLowerCase();
  if (!buyerKey) throw new Error('draftQuota 需要 buyer');
  if (proxy) {
    return {
      draftTable: 'seller_proxy_draft_quota',
      draftWhere: 'seller = ? AND buyer = ?',
      draftParams: [proxy, buyerKey],
      productTable: 'seller_proxy_product_quota',
      productWhere: 'seller = ? AND buyer = ? AND product_id = ?',
      productParams: [proxy, buyerKey, productId],
    };
  }
  return {
    draftTable: 'buyer_draft_quota',
    draftWhere: 'buyer = ?',
    draftParams: [buyerKey],
    productTable: 'buyer_product_quota',
    productWhere: 'buyer = ? AND product_id = ?',
    productParams: [buyerKey, productId],
  };
}

/**
 * 只读预检：在下单风控/汇率之前，先把**明显已经超限**的请求拒掉。
 *
 * 它不是判据——真正的占位仍是事务内的 `reserveDraftQuota`（带守卫 UPDATE，原子）。
 * 放在这里只是不让一个必然被拒的请求先花掉一次风控外呼（最多 10 秒）。
 * 并发下预检可能通过而占位失败：以事务内的结果为准。
 */
export async function precheckDraftQuota({ buyer, productId, units, proxySeller = null }) {
  const db = getDb();
  const qty = Number(units);
  const t = quotaTargetsOf({ buyer, productId, proxySeller });
  const drafts = await db.get(`SELECT active_drafts FROM ${t.draftTable} WHERE ${t.draftWhere}`, ...t.draftParams);
  if (Number(drafts?.active_drafts ?? 0) >= MAX_ACTIVE_DRAFTS) return { fail: draftLimitFail() };
  const row = await db.get(`SELECT units FROM ${t.productTable} WHERE ${t.productWhere}`, ...t.productParams);
  const held = Number(row?.units ?? 0);
  if (held + qty > MAX_DRAFT_UNITS_PER_PRODUCT) return { fail: unitLimitFail(held) };
  return null;
}

/**
 * 占一份草稿额度：活跃草稿 +1、同发起人同商品件数 +units。
 *
 * @param {{buyer: string, productId: number, units: number, proxySeller?: string|null}} args
 *        `buyer` = 小写买家地址；`proxySeller` = 代客下单的店主地址（null/空 = 买家自购）。
 *        `units` = 这一单的 quantity（1..99）
 * @returns {Promise<null | {fail: string}>} null = 放行；`{fail}` = 可读拒因，调用方应
 *          `abortTx({fail})`（**必须回滚**：闸 1 可能已经加过，拒单不能留下半次占位）
 *
 * ⚠️ 必须在**建单那个事务内**调用（占位与插单要么一起成立、要么一起没有）；
 * 事务外调用时 `exec` 会给它单开一个事务，那样"加量"与"插单"就不再是原子的。
 */
export async function reserveDraftQuota({ buyer, productId, units, proxySeller = null }) {
  const db = getDb();
  const qty = Number(units);
  const t = quotaTargetsOf({ buyer, productId, proxySeller });
  const { draftTable, draftWhere, draftParams, productTable, productWhere, productParams } = t;
  // 建行（无条件、幂等）。理由见文件头"建行必须无条件先做"。
  const proxy = String(proxySeller || '').toLowerCase();
  if (proxy) {
    await db.run(
      `INSERT INTO ${draftTable} (seller, buyer, active_drafts) VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE active_drafts = active_drafts`,
      ...draftParams
    );
    await db.run(
      `INSERT INTO ${productTable} (seller, buyer, product_id, units) VALUES (?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE units = units`,
      ...productParams
    );
  } else {
    await db.run(
      `INSERT INTO ${draftTable} (buyer, active_drafts) VALUES (?, 0)
       ON DUPLICATE KEY UPDATE active_drafts = active_drafts`,
      ...draftParams
    );
    await db.run(
      `INSERT INTO ${productTable} (buyer, product_id, units) VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE units = units`,
      ...productParams
    );
  }
  const drafts = await db.run(
    `UPDATE ${draftTable} SET active_drafts = active_drafts + 1 WHERE ${draftWhere} AND active_drafts < ?`,
    ...draftParams,
    MAX_ACTIVE_DRAFTS
  );
  if (drafts.foundRows !== 1) {
    return { fail: draftLimitFail() };
  }
  const unitRoom = await db.run(
    `UPDATE ${productTable} SET units = units + ? WHERE ${productWhere} AND units + ? <= ?`,
    qty,
    ...productParams,
    qty,
    MAX_DRAFT_UNITS_PER_PRODUCT
  );
  if (unitRoom.foundRows !== 1) {
    /*
      拒因里要给出"现在是多少"：读数在守卫失败之后取，值就是本事务里的真值
      （同一行的写者被这一行的锁串行化）。读不到（行被并发删掉）时按 0 兜底——拒因只是文案，
      判据是那条 UPDATE 的 `foundRows`。
    */
    const row = await db.get(`SELECT units FROM ${productTable} WHERE ${productWhere}`, ...productParams);
    const held = Number(row?.units ?? 0);
    return { fail: unitLimitFail(held) };
  }
  return null;
}
