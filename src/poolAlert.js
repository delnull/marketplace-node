/**
 * 池式商品「已收款但无货可交」主动告警（2026-09）。
 *
 * 问题：数字商品（码池 product_codes）与 NFT 商品（tokenId 池 product_nft_tokens）是
 * **下单不占位**的池式交付（无限量、下单时只锁价不锁资源），池子可能在「买家建草稿」与
 * 「链上托管落定」之间被别的订单掏空。此时买家已经付了钱、链上也已 OrderCreated，而卖家
 * 无从自动交付——此前只有卖家面板里的 `poolEmpty` 字段标着，**卖家不去看就不会知道**，
 * 而买家那边钱已经出去了。本模块在订单进入 escrowed 的那一刻主动推店主 webhook。
 *
 * 为什么要有这个模块而不是在 orders.js 里就地判断：
 *  - 判定口径（哪些商品算池式、需求量怎么算、池里可用量怎么读）必须与卖家面板的
 *    `poolEmpty` **完全一致**（见 poolShortfallOf），否则会出现"面板显示缺货但没告警"或反之；
 *  - 两条触发路径（paid 快路径与 watcher 事件回写）都要告警，只能有一份实现。
 *
 * 告警只发一次（`order_alerts(order_id, kind='pool_empty')` 的主键去重，见 alertAck.js）：
 * 池子空了是持续状态，每轮轮询都推一次会把店主的机器人刷爆。
 * 但预占行**只在投递成功后**才留下（2026-09 修复，见 alertAck.js）：投递失败/未配置通知地址时
 * 预占被释放，下一轮复查自然重试——"已收款却无货可交"这条必须至少送达一次。
 * payload 只含订单号/链上单号/原因——不含收货信息、买家地址（与 webhook.js 的隐私边界一致）。
 *
 * 快照读不到时**不当作"没有池"**（2026-10 修复）：订单快照 `orders.product_snapshot` 解析失败
 * 原先被折成 `{}` ⇒ `poolBacked=false` ⇒ 缺货告警与卖家面板 `poolEmpty` 一起静默消失
 * （买家钱已上链、货交不出，却没有任何人被告知）。现在走"读不到池快照"的分支：
 * console.warn 指明哪张快照/哪一单/什么错，且在 escrowed（钱已锁）时照样**至少告警一次**
 * （reason 如实说"读不到快照、无法确认可交付"，**不编**缺货数量）。见 poolShortfallOf。
 * 代价（如实写）：读不到与缺货共用同一个去重行（每单至多一次成功投递）——快照后来修好、
 * 这一单确实缺货时不会再补推一条；第一次的告警已经要求店主人工核对本单，故不再区分两条。
 *
 * ## 键的形状（2026-10 MySQL 重设计）
 *
 * 入参一律是**订单内部键** `orders.id`（调用方手里那一行叫 `v_orders.order_id`，路由传的就是它）：
 * 去重表 `order_alerts.order_id` 是外键指向 `orders(id)`，它**不是**订单号也不是链上单号。
 * 旧实现按"本地 id 或链上单号"两种拼写查同一个订单，现在只剩一种——链上单号是
 * `order_chain.escrow_order_id`，要按它查就得先 JOIN 一次，而两条调用路径（/paid 与 watcher）
 * 手里都已经握着本地行，没有理由再留第二种拼写。
 *
 * 整单读走读模型 `v_orders`（`orders` + `order_shipping` + `order_chain` 三表合一）：
 * 缺货判据要同时看到订单状态、数量、商品快照与链上单号，视图一次给全。
 */
import { getDb } from './db.js';
import { notifyRaw } from './webhook.js';
import { alertOnceDelivered } from './alertAck.js';

/**
 * 池式交付的缺口核算（**唯一实现**；卖家面板 poolEmpty 与主动告警共用）。
 * @param {object} order `v_orders` 行（需 order_id / order_no / status / quantity / product_id / product_snapshot）
 * @returns {{poolBacked:boolean|null, kind:'digital'|'nft'|null, need:number, available:number, short:boolean}}
 *  need：digital 一次性需 quantity 个；nft 按剩余需求 = quantity − 已交付行数（支持分批交付）。
 *  available：池内 status='unused' 的资源数（池式商品无限量，池即库存）。
 *  poolBacked 三态（**读不到与确证是两件事**）：
 *   · `true`  快照可读且 kind 是池式（digital/nft）⇒ need/available/short 是**读数**；
 *   · `false` 快照可读但确证不是池式商品，或订单不在 escrowed（未托管/已交付/已终局）——
 *     此时**没有缺口语义**（钱没锁，或本来就没有池）；
 *   · `null`  **读不到快照**（JSON 解析失败 / 不是 JSON 对象）。
 *     旧实现把这一种折成 `{}` ⇒ `poolBacked=false` ⇒ 缺货告警与卖家面板 `poolEmpty`
 *     **一起静默消失**：买家钱已上链、货交不出，却没有任何人被告知（本模块存在的唯一理由）。
 *     所以这里不再兜：读不到就报读不到（console.warn 说明是哪张快照、什么错），
 *     并在 escrowed（钱已锁）时把 short 置 true——"无法确认可交付"必须有人处理，不沉默。
 *  short：**本单是否需要店主处置**。确证池式且 available < need ⇒ true；
 *     读不到快照且已 escrowed ⇒ true（无法确认可交付）；其余（确证够货/确证非池式/非 escrowed）⇒ false。
 */
export async function poolShortfallOf(order) {
  const none = { poolBacked: false, kind: null, need: 0, available: 0, short: false };
  if (!order) return none;
  let snap = null;
  let snapError = null;
  try {
    const parsed = JSON.parse(order.product_snapshot);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) snap = parsed;
    else {
      const shape = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
      snapError = new Error(`快照不是 JSON 对象（${shape}）`);
    }
  } catch (e) {
    snapError = e;
  }
  if (!snap) {
    /*
      "读不到"而不是"没有池"：console.warn 指明是哪张快照（orders.product_snapshot）、哪一单、
      什么错（含原文片段，便于直接定位那一行）——否则运维只能看到一个消失的告警，无从查起。
      代价（如实写）：本函数在列表接口里**逐行**调用，坏行多时日志会重复（这是刻意的：
      快照读不到是数据完整性问题，必须响亮，直到有人修好那一行；正常写入路径不会产生这种行）。
    */
    const raw = order.product_snapshot;
    console.warn(
      `[poolAlert] 读不到订单快照 orders.product_snapshot（order=${order.order_no} status=${order.status} 原文=${
        raw === undefined ? '(列缺失)' : JSON.stringify(String(raw).slice(0, 120))
      }）：${snapError?.message || '不是 JSON 对象'}——不当作"该单没有池"（那会让缺货告警与面板 poolEmpty 一起静默消失）`
    );
    // escrowed = 买家钱已锁：无法确认可交付 ⇒ 需要店主处置；其余状态没有缺口语义
    return order.status === 'escrowed'
      ? { poolBacked: null, kind: null, need: 0, available: 0, short: true }
      : { poolBacked: null, kind: null, need: 0, available: 0, short: false };
  }
  if (order.status !== 'escrowed' || (snap.kind !== 'digital' && snap.kind !== 'nft')) return none;
  const qty = order.quantity || 1;
  let need = qty;
  if (snap.kind === 'nft') {
    // 子表外键指向 orders.id（读模型里叫 order_id），不是订单号
    const delivered = (await getDb().get("SELECT COUNT(*) AS c FROM order_delivery_items WHERE order_id = ? AND kind = 'nft'", order.order_id)).c;
    need = Math.max(0, qty - delivered);
    if (need === 0) return { poolBacked: true, kind: 'nft', need: 0, available: 0, short: false };
  }
  const table = snap.kind === 'digital' ? 'product_codes' : 'product_nft_tokens';
  const available = (await getDb().get(`SELECT COUNT(*) AS c FROM ${table} WHERE product_id = ? AND status = 'unused'`, order.product_id)).c;
  return { poolBacked: true, kind: snap.kind, need, available, short: available < need };
}

/**
 * 卖家面板/买家详情的 `poolEmpty` 字段（布尔，**无法表达三态**）。
 * 判据只有一处（上面的 poolShortfallOf），这里只是取它的结果：
 * 确证缺货 → true；读不到快照且已 escrowed → 也 true（否则就是"钱已付、货可能交不出却没人被告知"）。
 * 代价（如实写）：这一格是布尔，读不到快照时界面文案说的是"交付资源用尽/正在补货"——
 * 比真实情况更具体（真相是"读不到快照，无法确认"）。精确原因在下发它的那条 webhook 的
 * reason 与 console.warn 里；要在这张卡片上如实说"读不到"，得给 DTO 与前端加第三态。
 */
export async function isPoolEmpty(order) {
  return (await poolShortfallOf(order)).short;
}

/**
 * 托管落定后的池缺口告警（每个订单至多一次**成功投递**）。
 * 供两条路径调用：POST /:id/paid 快路径（提交后）与 escrowWatcher 的 OrderCreated 分支
 * （COMMIT 之后，见 applyEvent 的 afterCommit 约定——回滚了就不该告警）。
 * 不阻塞调用方：预占与释放都在 alertAck 里结算，HTTP 响应不等店主服务器。
 * @param {number} orderId 订单**内部键**（`orders.id` / `v_orders.order_id`；见文件头的键形状说明）
 * @returns {Promise<boolean>} 本次是否已发起告警（false = 已告过 / 投递进行中 / 非缺货场景）
 */
export async function alertPoolEmptyForOrder(orderId) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`[poolAlert] 需要订单内部键（orders.id），收到 ${JSON.stringify(orderId)}`);
  }
  const db = getDb();
  const order = await db.get('SELECT * FROM v_orders WHERE order_id = ?', id);
  if (!order) return false;
  const s = await poolShortfallOf(order);
  if (!s.short) return false; // 池子够（或已交付/已终局）：不是缺货告警场景
  /*
    两种 short 的措辞必须分开（**读不到 ≠ 缺货**）：读不到快照时若照抄"仅剩 X 个、仍需 Y 个"，
    就是拿 0/0 编了一个具体的缺货数字给店主——那正是本模块要消灭的东西。
  */
  const readUnknown = s.poolBacked === null;
  const short = String(order.order_no).slice(0, 8);
  /*
    payload 的 `orderId` 是**对外订单号**（order_no）：接收方（店主机器人/对账脚本）拿它去查单，
    而内部键 `orders.id` 不是任何人的标识（见 db.js 的 v_orders 说明）。去重行用的是内部键。
  */
  return await alertOnceDelivered({
    orderId: id,
    kind: 'pool_empty',
    label: '[poolAlert]',
    what: readUnknown
      ? `（order=${short}…，快照读不到：无法确认可交付资源）`
      : `（order=${short}…，缺货：可用 ${s.available} / 需 ${s.need}）`,
    send: () =>
      notifyRaw('order.pool_empty', {
        // ⚠️ 必填：`webhook.deliver()` 按 `payload.shopCode` 查 `shop_webhook`（一行一店）；
        // 缺了它投递会一次都不发就 resolve(false)，而日志写"未配置通知地址"（误导）。
        shopCode: order.shop_code,
        orderId: order.order_no,
        escrowOrderId: order.escrow_order_id || null,
        /*
          事件类型沿用 order.pool_empty（店主机器人按它订阅"钱已付、可能交不出货"这一类待办），
          但 reason 必须如实说明是哪一种：读不到快照时**不报**缺货数量（那会是编的）。
        */
        reason: readUnknown
          ? `买家已托管付款，但本单的商品快照读不到（orders.product_snapshot 无法解析）——` +
            `无法确认这是不是池式交付、也无法核对可交付资源：请人工核对该单（读订单详情/商品来源），` +
            `确认无货可交就立即补货或与买家协商退款，勿让订单悬置`
          : `买家已托管付款，但该${s.kind === 'digital' ? '数字兑换码' : 'NFT tokenId'}池仅剩 ${s.available} 个可用资源、` +
            `本单仍需 ${s.need} 个——请立即补货（导入${s.kind === 'digital' ? '兑换码' : ' tokenId'}）或与买家协商退款，勿让订单悬置`,
      }),
  });
}

/**
 * 仅供测试：清掉某单的 `pool_empty` 去重行（不改业务语义，仅让用例可重复验证"只告警一次"）。
 *
 * 不做 try/catch：它是 DB 支撑的去重行，读不到库时"清标记"会**静默失效**，
 * 而用例会因此把"重复告警"读成通过——测试辅助同样要响亮失败。
 * @param {number} orderId 订单内部键（同 alertPoolEmptyForOrder）
 */
export async function resetPoolAlertFlag(orderId) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`[poolAlert] resetPoolAlertFlag 需要订单内部键（orders.id），收到 ${JSON.stringify(orderId)}`);
  }
  await getDb().run("DELETE FROM order_alerts WHERE order_id = ? AND kind = 'pool_empty'", id);
}
