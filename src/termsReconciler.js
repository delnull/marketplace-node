/**
 * 店铺镜像对账（`termsReconciler`）—— 把链上的**在售状态与当前费率**合进本地 `shops` 行。
 *
 * ## 为什么必须轮询
 *
 * 本节点不索引 Registry 的事件（那需要一整套从创世块起的日志扫描与重组处理），
 * 而"这家店现在能不能卖、费率是多少"完全由链上回答：`shopListed(code)` 与
 * `ShopInfo.commissionBps`。下单闸、商品聚合、卖家面板读的都是本地 `listed` 镜像，
 * 所以必须有一个轮询把链上结论抄回来——否则节点主在链上停了店，本地照卖。
 *
 * 2026-10-18：费率改由节点主单方设定（`setShopCommission`，无提案、无到期），
 * 于是"超时是惰性判定、只有轮询能发现"这条理由不再存在；轮询仍然保留，
 * **只是覆盖范围缩成"在售 + 当前费率"两项**。删掉待决提案后，`shops` 表也不再需要
 * `pending_*` 三列。
 *
 * ## 它写什么、不写什么
 *
 * 只把**链上权威读数**合进本地 `shops` 行（`applyChainShop` 是唯一写入点）；费率真的变了时，
 * 另外按文件头的规则作废该店未支付草稿（那是订单状态写入，不是店铺镜像，两者同一事务）。
 * 本地**不自己算**"能不能卖"——把 `shopListed` 的四个来源在链下再实现一遍，
 * 就是同一件事的第二份判据，两边迟早漂移。
 *
 * 读不到链上时**一个字节都不写**（与 `fees.js` 的三态纪律同款）：读不到 ≠ 已暂停。
 * 把读不到写成 listed=0 会让整条店铺在 RPC 抖动时被静默摘牌。
 *
 * ## 覆盖范围
 *
 * 本节点名下的**每一行 `shops`**。店的身份在链上是 **(店主钱包, 节点地址)** 这一对
 * （`Registry.getShop(seller, host)`），而一库一节点 ⇒ `host` 恒为 `node.owner`
 * （本节点主地址，`shops.host` 那一列已随重设计删除：它是第二份真相）。
 * 节点不是全网索引器：别人的店不归它管，也不该由它轮询（那是联邦前端的事）。
 *
 * ## 费率一变，**未支付草稿必须作废**
 *
 * 买家手里的草稿按创建时的费率报价（`orders.commission_quoted_bps`），而付款前端的校验是
 * "报价 == 店铺当前费率"。节点主在链上 `setShopCommission` 之后，这些草稿在新费率下**必然被拦**，
 * 但行仍留在列表里、仍可被反复打开——买家看到一张永远付不了的草稿，而节点没有任何动作。
 * 所以 `commission_bps` 真的变了的那一轮，把该店 `status='draft'` 且 `paid_tx_hash IS NULL`
 * 的订单**与店铺行同事务**置成 `cancelled` 并回补占位（`POST /:id/cancel` 的同一套语义）。
 * 已支付/已上链的行一律不碰：它们各自带着创建时的费率快照结算，改费率影响不到它们。
 * 取消逐单写审计（`order.cancel`，`detail.trigger='shop.commission_updated'`）——
 * `orders` 表没有取消原因列，原因与前后费率都记在审计行里，不是一次静默 UPDATE。
 */
import config from './config.js';
import { getDb, withTransaction } from './db.js';
import { getRegistry, getEscrow, shopCodeFromChain } from './chain.js';
import { listShopRows, applyChainShop, nodeOwner } from './shops.js';
import { notify, notifyRaw } from './webhook.js';
import { releaseHoldsForOrderIds } from './stockHold.js';
import { logAudit } from './audit.js';

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * 草稿作废前的链上真值读取（测试注入点）：返回 `{status}` 形态的订单。
 * 生产缺省走 `Escrow.getOrder`；单测不能起链时注入。
 */
let _draftChainOrderReader = null;
export function setDraftChainOrderReader(fn) {
  _draftChainOrderReader = typeof fn === 'function' ? fn : null;
}

/**
 * 这笔草稿的链上托管单是否已经存在。
 * @returns {Promise<boolean|null>} null = 读不到（调用方必须 fail-closed，不能拿"读不到"当"没上链"）
 */
async function chainOrderExists(escrowOrderId) {
  try {
    const read = _draftChainOrderReader
      ? _draftChainOrderReader(escrowOrderId)
      : getEscrow().getOrder(escrowOrderId);
    /*
      链上读取有显式上界：provider 默认无超时，一次黑洞 RPC 会让这一轮对账一直挂着
      （调度的下一轮/手动 `/reconcile` 都等它）。2s 是"正常情况下足够、故障时快速回落"的预算；
      超时按"读不到"处理 ⇒ 整行跳过（fail-closed），下一轮重试。
      **本读法只在事务之外调用**（计划阶段，见 planDraftInvalidation）：任何链上读都不得
      发生在持有 `FOR UPDATE` 行锁的事务里。
    */
    const got = await Promise.race([
      read,
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (!got) return null;
    return Number(got?.status ?? 0) !== 0;
  } catch {
    return null;
  }
}

let timer = null;
let status = {
  enabled: false,
  lastOkAt: null,
  lastError: null,
  lastChanged: 0,
  shops: 0,
  unreadable: 0,
  /**
   * **整轮一个链上读数都没拿到**（`unreadable === shops > 0`）。
   *
   * 为什么单列一个读数（2026-10-15 修 ABI 错型时补）：此前"单店读失败"只写进 `lastError`
   * 而 `lastOkAt` 照常刷新，于是一个**所有店铺都读不出来**的节点在 `/healthz` 上看起来是健康的
   * ——实测过一次：`getShopBySeller` 的元组末位类型错成 `string`（合约是 `bytes32`），
   * 每一次调用都抛 `could not decode result data`，于是链上条款/在售状态的镜像**从来没同步过**，
   * 而这条故障在读数里只是一句可以被忽略的 `lastError`。degraded 把它变成一个布尔事实：
   * "这台节点的链上店铺对账现在是全面失效的"。
   */
  degraded: false,
  intervalMs: DEFAULT_INTERVAL_MS,
};

/** `/healthz` 读数（与 watcher/reconcile/piiRetention 同列：三个后台任务都要能被看见） */
export function termsReconcileStatus() {
  return { ...status };
}

function intervalMs() {
  const v = Number(process.env.MK_TERMS_RECONCILE_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_INTERVAL_MS;
}

/** 费率变更作废草稿的取消原因（`orders` 没有取消原因列，落进审计 detail） */
const COMMISSION_CHANGE_CANCEL_REASON = '店铺费率已调整，请重新下单';

/**
 * 该店当前的未支付草稿候选（**纯本地读，不加锁**：计划阶段用）。
 *
 * 判据只有一条：`status='draft'` 且 `paid_tx_hash IS NULL`。草稿建行时就已经有
 * `order_chain.escrow_order_id`（本地生成的链上单号），所以"有没有上链"不能看那一列——
 * 看支付凭证。已支付/已上链的行为一律不在这里，它们按创建时快照结算。
 */
async function unpaidDraftCandidatesOfShop(row) {
  return await getDb().all(
    `SELECT o.id AS order_id, o.order_no, c.escrow_order_id
       FROM orders o
       LEFT JOIN order_chain c ON c.order_id = o.id
      WHERE o.shop_code = ? AND o.status = 'draft' AND c.paid_tx_hash IS NULL`,
    row.code
  );
}

/**
 * **计划**这一次费率变更要作废哪些草稿——所有链上读都发生在这里（事务之外）。
 *
 * 为什么必须挪出事务（P3-10）：旧实现在 `withTransaction` 里对每个草稿串行 `eth_call`
 * （`chainOrderExists` 已有 2s 上界，但 N 张草稿就是 N × 最长 2s），期间持有
 * `SELECT … FOR UPDATE` 的行锁与店铺行的写锁——一次 RPC 抖动会把 `/paid`、`/cancel`
 * 以及下一轮对账全部堵在锁上。链上读与 DB 写是两种代价，不能挂在一起。
 *
 * **作废前先看链上有没有这笔托管单**（2026-10-18 收口费率变更竞态）：
 * 买家可能已经在费率变更前把 `Escrow.createOrder` 打上链，只是 `/paid` 还没回写
 * （`paid_tx_hash` 仍 NULL）。此时若按本地草稿直接取消，链上已存在的托管单会被本地
 * 标成 cancelled，watcher 虽然能从 OrderCreated 自动恢复，但中间态会误导买家/客服。
 * 链上已有单（status != None）⇒ 跳过；链上读不到 ⇒ 返回 **null**：本轮**连店铺行都不写**
 * （fail-closed）——这样下一轮仍然看得到 `before.bps != after.bps`，会重新计划并重试。
 * 旧实现"只跳过取消、照写新费率"会让下一轮 before.bps == after.bps，那批草稿永远等不到
 * 第二次机会（注释承诺"下一轮再试"而代码再也不会试）。
 *
 * @returns {Promise<number[]|null>} 可作废的订单内部键；null = 链上读不到（本轮跳过该店）
 */
async function planDraftInvalidation(row) {
  const candidates = await unpaidDraftCandidatesOfShop(row);
  if (!candidates.length) return [];
  const live = [];
  for (const c of candidates) {
    const exists = await chainOrderExists(c.escrow_order_id);
    if (exists === null) return null;
    if (!exists) live.push(c);
  }
  return live.map((r) => r.order_id);
}

/**
 * 作废**已计划**的未支付草稿（调用方已开事务：店铺的新费率与这里的取消必须一起落定）。
 *
 * 计划阶段与这里之间隔着"链上读 → 开事务"的窗口：
 *   · `FOR UPDATE` 锁住计划里的订单行（锁的范围只覆盖本地 DB 写，不再包含任何 RPC）；
 *   · 状态/支付凭证守卫在 UPDATE 上**再判一次**（买家刚好在这一瞬间完成 `/paid` 时跳过）；
 *   · 取消与占位释放、退款镜像复位同事务。
 *
 * @param {number[]} plannedIds 计划阶段确认"链上没有托管单"的订单内部键
 * @returns {Promise<string[]>} 实际被取消的对外单号（提交后逐单写审计/通知）
 */
async function cancelUnpaidDraftsOfShop(row, plannedIds) {
  if (!plannedIds.length) return [];
  const db = getDb();
  const ids = plannedIds.map(Number);
  const marks = ids.map(() => '?').join(',');
  /*
    行锁只圈计划里的行：`shop_code`/`status` 再判一次（店铺可能在计划之后被换掉/草稿已迁移）。
    `order_chain` 的支付凭证不在这里 JOIN（避免多表 FOR UPDATE 的锁面含糊）——它由下面
    UPDATE 的 `NOT EXISTS(paid_tx_hash)` 守卫负责。
  */
  const locked = await db.all(
    `SELECT id, order_no FROM orders
      WHERE id IN (${marks}) AND shop_code = ? AND status = 'draft'
      FOR UPDATE`,
    ...ids, row.code
  );
  if (!locked.length) return [];
  const liveIds = locked.map((r) => r.id);
  const liveMarks = liveIds.map(() => '?').join(',');
  await db.run(
    `UPDATE orders o SET o.status = 'cancelled', o.updated_at = CURRENT_TIMESTAMP(3)
      WHERE o.id IN (${liveMarks}) AND o.status = 'draft'
        AND NOT EXISTS (SELECT 1 FROM order_chain c WHERE c.order_id = o.id AND c.paid_tx_hash IS NOT NULL)`,
    ...liveIds
  );
  // 取消是本地终局：与 POST /:id/cancel 同口径复位售后镜像（草稿正常不会有 requested，但状态与镜像不许留残影）
  await db.run(`UPDATE order_chain SET refund_status = 'none' WHERE order_id IN (${liveMarks}) AND refund_status != 'none'`, ...liveIds);
  // 占位与取消同事务（释放单点契约见 stockHold.js）
  await releaseHoldsForOrderIds(liveIds);
  const cancelled = await db.all(
    `SELECT id, order_no FROM orders WHERE id IN (${liveMarks}) AND status = 'cancelled'`,
    ...liveIds
  );
  return cancelled.map((r) => r.order_no);
}

/** 读一家店在链上的权威读数（读不到即抛错——调用方据此跳过，**不写库**） */

/**
 * 在跑的那一轮（**唯一单飞记录**）。为什么必须有它：
 *
 * 本函数有两个调用方——定时器（`tick`）与 `POST /api/shops/reconcile` / 开店审批后的即时同步
 * （routes/shops.js）。手动那条此前直接调本函数、绕开定时器的 `running` 标志，于是两轮可以
 * 同时在路上。而这一轮的全部判据是**读-比-写**：读链上 → 与本地行比 → 变了才写库并发事件。
 * 两个并发轮次读到的是同一份旧 `before`，各自都算出"变了"，于是**同一次状态变化被下发两遍**
 * （店主机器人收到两条 `shop.delisted`），而 `applyChainShop` 也被写两遍。
 *
 * 第二个调用者**等**在跑的那一轮（而不是另起一轮、也不是直接拒绝）：等待的代价是它可能带不回
 * 刚写下的那次变更（那一轮开始得更早），由下一轮定时器补上——比"把同一条事件发两遍"便宜得多。
 * 标志只在**进程内**：跨进程由启动时的实例独占锁排除（见 db.js 的 acquireInstanceLock）。
 */
let inflight = null;

/**
 * 跑一轮对账（**唯一入口**：定时器与手动触发都走它，见上）。
 * @returns {Promise<{checked:number, changed:number, skipped:number, unreadable:number}>}
 *          `skipped` = 未写库的行数（含"链上没有这家店"与"这次读不到"两种，都不落库）；
 *          `unreadable` = 其中**因为读不到链**而跳过的行数——两者的区别决定这是正常还是故障。
 */
export async function reconcileOnce() {
  if (inflight) return await inflight;
  inflight = reconcileOnceInner().finally(() => {
    inflight = null;
  });
  return await inflight;
}

async function reconcileOnceInner() {
  if (!config.chain.registryAddress) {
    return { checked: 0, changed: 0, skipped: 0, unreadable: 0 };
  }
  /*
    节点地址是**店的身份的另一半**（链上 `getShop(seller, host)`），来自 `node.owner`。
    读不到就**一个问题都问不了**（拿零地址去问只会得到"链上没有这家店"，那是编出来的结论），
    所以这里抛出而不是静默跳过：tick 会把它记进 lastError 并告警，/healthz 的 `degraded`
    随之可见——"本轮什么都没查"与"查了、一切正常"必须长得不一样。
  */
  const host = await nodeOwner();
  if (!host) {
    throw new Error(
      '读不到节点主地址（node.owner）：店的身份是 (店主, 节点) 这一对，没有它无法向链上核对任何一家店——本轮不写任何行'
    );
  }
  const c = getRegistry();
  const rows = await listShopRows();
  let changed = 0;
  let unreadable = 0;
  let notRegistered = 0;
  for (const row of rows) {
    try {
      const info = await c.getShop(row.seller, host); // 店的身份是 (店主, 节点) 这一对
      const registeredAtBlock = Number(info.registeredAtBlock) || 0;
      const exitedAtBlock = Number(info.exitedAtBlock) || 0;
      /*
        链上没有这家店（从未登记）：**什么都不写**。
        一行店铺只在链上登记之后才存在（落库走 routes/shops.js 的 verify-onchain），
        所以走到这里只有一种成因——对账落后于人工登记；没有链上事实就没有可写的东西。
      */
      if (registeredAtBlock === 0) {
        notRegistered += 1;
        continue;
      }
      /*
        **店主已退出（墓碑）**：链上 `ShopInfo.exitedAtBlock != 0`，`shopListed` 必然为假。
        旧实现把这一档与"从未登记"合在一起 continue 跳过，于是本地 `listed` 永远停在 1：
        店主注销后节点仍把它列在目录里、仍接单（下单会链上 revert，但界面显示在营业）。
        这里必须写 `listed=0`（同时把 `exited_at_block` 落成墓碑）——退出是**可读的链上事实**，
        不是"没有读数"。注意：仍然只在**确切读到 exitedAtBlock>0** 时才写，RPC 读不到时照旧跳过。
      */
      const exited = exitedAtBlock > 0;
      /*
        `shopListed` 的入参是**链上的 bytes32 形状**（不是 9 位字符串）：
        `info.code` 已经是解码出来的 bytes32，直接原样传回去；转成字符串再传会解出垃圾偏移量而 revert。
        判据参数是**编号**（一个店主在几个节点下就有几家店，地址回答不了"哪一家"）。
        已退出的行不调它：链上对退出店的编号解析路径已被清空，`shopListed(info.code)` 必然为假，
        直接写 false 与"再问一次"同值，且少一次 RPC。
      */
      const listed = exited ? false : await c.shopListed(info.code);
      /*
        **抽成收款人不在这里**：它不是链上可配字段，恒为店铺的 `host`（节点地址）。
        所以本地也不该有第二份真相（`shops.commission_to` 已随之下线），需要它的时候由
        `shops.shopDto(row, hostOperator())` 现算——见 `src/shops.js`。
      */
      const chain = {
        code: shopCodeFromChain(info.code),
        commissionBps: Number(info.commissionBps),
        listed: !!listed,
        registeredAtBlock,
        exitedAtBlock,
      };
      const before = { listed: Number(row.listed) === 1, code: row.code, bps: Number(row.commission_bps) || 0 };
      const after = { listed: chain.listed, code: chain.code, bps: chain.commissionBps };
      /*
        费率真的变了 ⇒ 先在**事务之外**把"哪些草稿链上确实没托管"读清楚（P3-10）。
        旧实现在事务/`FOR UPDATE` 里逐草稿发 RPC：一次黑洞 RPC 会把 `/paid`、`/cancel` 与下一轮
        对账全堵住。链上读不到 ⇒ 本轮**整行不写**（fail-closed）：否则新费率落库后
        before.bps == after.bps，那批旧费率草稿永远不会再被计划作废。
      */
      const bpsChanged = before.bps !== after.bps;
      let plannedDraftIds = [];
      if (bpsChanged) {
        plannedDraftIds = await planDraftInvalidation(row);
        if (plannedDraftIds === null) {
          unreadable += 1;
          status.lastError =
            `店铺 ${row.code} 的费率变更需要核对未支付草稿的链上托管状态，但读不到——` +
            '本轮不写该店铺行（下一轮重试；避免"费率已更新、旧草稿却永远不被作废"）';
          continue;
        }
      }
      // 新费率与"旧费率下创建的未支付草稿作废"必须同一事务落定：店铺行与取消要么一起成功，
      // 要么一起回滚（计划阶段的链上读已在事务之外完成，事务里只有本地 DB 写）。
      let cancelledDrafts = [];
      await withTransaction(async () => {
        await applyChainShop(row, chain);
        if (bpsChanged) cancelledDrafts = await cancelUnpaidDraftsOfShop(row, plannedDraftIds);
      });
      for (const orderNo of cancelledDrafts) {
        await logAudit({
          actor: host,
          actorRole: 'host',
          shopCode: row.code,
          action: 'order.cancel',
          targetType: 'order',
          targetId: orderNo,
          detail: {
            by: 'system',
            trigger: 'shop.commission_updated',
            commissionBpsFrom: before.bps,
            commissionBpsTo: after.bps,
            reason: COMMISSION_CHANGE_CANCEL_REASON,
          },
        });
        // 与 POST /:id/cancel 同款：卖家通知（未配置 webhook 时零开销）
        void notify('order.cancelled', orderNo);
      }
      if (cancelledDrafts.length > 0) {
        console.log(
          `[terms] 店铺 ${row.code} 费率 ${before.bps}→${after.bps}：作废 ${cancelledDrafts.length} 个未支付草稿（已逐个写审计）`
        );
      }
      if (before.listed !== after.listed || before.code !== after.code || before.bps !== after.bps) {
        changed += 1;
        /*
          下发事件：只在**真的变了**的时候发，且带前后两个状态。
          为什么带前后：接收方要能区分"暂停接单"与"恢复在售"而不必自己存上一次的值
          （那会变成第二份状态）。reason 说明是哪一档引起的，文案与 notSellableReason 同源。
          费率变化（bps 变了但 listed 没变）也发一条 `shop.commission_updated`——
          店主面板与账本按它刷新，不必等下一笔订单。
        */
        if (before.listed !== after.listed) {
          notifyRaw(after.listed ? 'shop.relisted' : 'shop.delisted', {
            shopCode: after.code || row.code,
            seller: row.seller,
            commissionTo: host, // 收款人恒为节点地址（见 chain 对象上方的说明）
            commissionBps: chain.commissionBps,
            note: after.listed
              ? '店铺已恢复接单与前端聚合'
              : '店铺已暂停接单并退出前端聚合（在途订单不受影响，发货/退款/售后照常）',
          });
        } else if (before.bps !== after.bps) {
          notifyRaw('shop.commission_updated', {
            shopCode: after.code || row.code,
            seller: row.seller,
            commissionTo: host,
            commissionBps: chain.commissionBps,
            note:
              cancelledDrafts.length > 0
                ? `节点费率已更新（${before.bps} → ${after.bps} bps）：旧费率下创建的 ${cancelledDrafts.length} 个未支付草稿已作废并释放占位，` +
                  '已支付/已上链订单一律不受影响（按各自创建时的快照结算）'
                : `节点费率已更新（${before.bps} → ${after.bps} bps）：当前没有需要作废的未支付草稿，` +
                  '此前创建的订单按各自创建时的快照结算，不受影响',
          });
        }
      }
    } catch (e) {
      // 单店失败不拖垮整轮：链上读不到就跳过它（本轮不写这一行）
      unreadable += 1;
      status.lastError = String(e?.message || e);
    }
  }
  return { checked: rows.length, changed, skipped: notRegistered + unreadable, unreadable };
}

async function tick() {
  try {
    const r = await reconcileOnce();
    const degraded = r.unreadable > 0 && r.unreadable === r.checked;
    status = {
      ...status,
      enabled: true,
      /*
        `lastOkAt` = "最后一次成功读到全部店铺"的时刻。整轮都读不到（degraded）时**不刷新**：
        刷新它等于把一次全面失效说成"刚刚成功过"，而 /healthz 的停滞判据正是按这个字段看的。
      */
      lastOkAt: degraded ? status.lastOkAt : Date.now(),
      lastChanged: r.changed,
      shops: r.checked,
      unreadable: r.unreadable,
      degraded,
      intervalMs: intervalMs(),
    };
    if (r.changed > 0) {
      console.log(`[terms] 佣金条款对账：${r.checked} 家店，${r.changed} 家状态有变化`);
    }
    /*
      全面读不到 ⇒ 每一轮都明确报出来（不是只有变化时才吭声）：
      "所有店铺的链上条款/在售状态都对不上账" 是必须被人看见的运营事实——它意味着
      本地 `shops.listed` 与佣金条款**可能已经与链上不一致**，而下单闸正是读它。
    */
    if (degraded) {
      console.error(
        `[terms] 链上店铺对账全面失败：${r.unreadable}/${r.checked} 家店读不到（本地 listed 与条款可能已与链上不一致）：${status.lastError}`
      );
    }
  } catch (e) {
    status = { ...status, enabled: true, lastError: String(e?.message || e), intervalMs: intervalMs() };
    console.warn(`[terms] 佣金条款对账失败：${status.lastError}`);
  }
}

/**
 * 启动周期对账。未配置 registry 时不启动（没有链上事实可对）——
 * 与 `startChainReconcile` 同款：不启动这件事本身已经在 `/healthz` 的 `enabled:false` 里可见。
 */
export function startTermsReconciler() {
  status = { ...status, enabled: !!config.chain.registryAddress, intervalMs: intervalMs() };
  if (!config.chain.registryAddress) return null;
  if (timer) return timer;
  void tick();
  timer = setInterval(() => void tick(), status.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/** 仅供测试：停掉定时器 */
export function stopTermsReconciler() {
  if (timer) clearInterval(timer);
  timer = null;
}
