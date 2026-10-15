/**
 * 测试装配（node --test 每个测试文件独立进程，env 互不干扰）。
 *
 * 注意：业务模块必须动态 import——config/db 等在模块顶层读取 process.env，
 * 需确保 env 在模块首次求值前已设置。汇率外部网络被禁用（mock fetch 抛错），
 * 统一走 config 兜底汇率（stale=true），保证测试不依赖公网。
 *
 * 另外装一个**交付闸的默认链上桩**（见下方 setChainOrderFetcher）：交付类端点现在按链上真值放行，
 * 而单测的 RPC 是拒连的——没有这个桩，所有发货用例都会以"读不到链上状态"被正确地拒绝。
 */
import { Wallet } from 'ethers';
import request from 'supertest';

export async function makeCtx() {
  const owner = Wallet.createRandom();
  const buyer = Wallet.createRandom();
  process.env.MK_SHOP_OWNER = owner.address;
  // 虚拟托管地址：仅用于"已接入链上托管"分支（paid 的链上校验不在单测覆盖）
  process.env.MK_ESCROW_ADDRESS = '0x2222222222222222222222222222222222222222';
  process.env.MK_FALLBACK_BTY_USDT = '0.1'; // 1 BTY = 0.1 USDT（唯一的行情腿：USDT→BTY）
  process.env.MK_TOKEN_SECRET = 'unit-test-secret-0123456789abcdef';
  /*
    汇率 TTL 设 0 = **每次请求都刷新**（`config.js` 用 `intEnvAllowZero` 解析，0 是有效值）。
    本套件其实不依赖它：下面把 `globalThis.fetch` 禁掉之后汇率一律走 config 兜底值（stale=true），
    刷新一次和刷一百次拿到的是同一个数字。留着 0 是为了让"禁用外部网络"这件事在语义上彻底
    ——没有任何一条用例可能因为缓存命中的旧值而侥幸通过。要验缓存/降级行为请见
    test/rates.test.js（那里自己装可控的假上游）。
  */
  process.env.MK_BTY_TTL_MS = '0';

  // 禁用外部网络：汇率走兜底（stale=true）
  globalThis.fetch = async () => {
    throw new Error('unit-test: 外部网络已禁用');
  };
  /*
    ⚠️ 上面这句**管不到链上读取路径**：ethers v6 在 Node 下用 node:http/node:https 发 JSON-RPC，
    不经过 globalThis.fetch（源码：ethers/src.ts/utils/fetch.ts "In NodeJS, the default uses the
    http and https libraries"）。而 MK_RPC_URL 缺省指向 BTY 主网 ⇒ 测试里任何链上调用
    （paid/sync 的 getOrder、getArbiterAddress、账本的全局兜底口径）都会真的打一次公网。
    这里指向一个必然"连接被拒"的本地端口：链上路径快速失败，与真实 RPC 不可达时同形
    （各处都已 try/catch 降级），测试不再触网也不再被外网抖动拖慢。
    需要"链上可用"的用例请自建本地假 JSON-RPC 服务器并改写 config.chain.rpcUrl——
    见 test/order-sync-paths.test.js 与 test/fees-per-order.test.js。
  */
  process.env.MK_RPC_URL = 'http://127.0.0.1:1/';

  const { initDb, getDb } = await import('../src/db.js');
  initDb(':memory:');
  /*
    交付闸的默认链上桩（2026-10-14）：`/ship`、`/seller/batch-ship`、`/:id/nft-deliveries` 与自动交付
    现在一律经 `chainOrder.deliveryGate` 读**链上真值**（status=Created 且 refundRequested=false；
    读不到即拒绝）。单测默认的 MK_RPC_URL 指向一个必然拒连的本地端口，所以这里装一个
    "链上确实有这一单、仍在托管、未被申请退款"的读数桩：按 escrow_order_id 回读本地行并原样回显
    buyer/seller/amount —— 这正是 chainParamsMatch 期待的"链上就是这一单"的正常形态。
    需要"链上冻结 / 已终局 / 读不到 / 诱饵单"这些档的用例自己调 setChainOrderFetcher 覆盖
    （见 test/delivery-gate.test.js 与 test/auto-deliver.test.js，传 null 恢复本桩）。
  */
  const { setChainOrderFetcher } = await import('../src/chainOrder.js');
  setChainOrderFetcher((orderIdHex) => {
    const row = getDb()
      .prepare('SELECT buyer, seller, amount_wei FROM orders WHERE escrow_order_id = ?')
      .get(String(orderIdHex || '').toLowerCase());
    if (!row) throw new Error('unit-test 链上桩：链上没有这一单');
    return {
      status: 'Created',
      refundRequested: false,
      refundRejected: false,
      refundedAmount: '0',
      buyer: row.buyer,
      seller: row.seller,
      amount: row.amount_wei,
    };
  });
  const { createApp } = await import('../src/app.js');
  return { app: createApp(), db: getDb(), owner, buyer, request };
}

/** SIWE 登录流程，返回 { token, address, isOwner } */
export async function login(ctx, wallet) {
  const nonce = await ctx.request(ctx.app)
    .get(`/api/auth/nonce?address=${wallet.address}`)
    .expect(200);
  const { message } = nonce.body.data;
  const signature = await wallet.signMessage(message);
  const res = await ctx.request(ctx.app)
    .post('/api/auth/login')
    .send({ address: wallet.address, message, signature })
    .expect(200);
  assertOk(res);
  return res.body.data;
}

/** 断言统一响应 {code:0} */
export function assertOk(res) {
  if (res.body.code !== 0) {
    throw new Error(`期望 code=0，实际 code=${res.body.code} message=${res.body.message}`);
  }
}

/**
 * 商品入参样例（88 USDT = 88000000 微 USDT）。
 *
 * 接口形状是「specs + skus」：价格与库存**逐组合**给出。
 * 为了不让每个用例都写一遍 skus，这里保留了 `priceUsdtMicro` / `capacity` 两个便捷键，
 * 由本函数展开成「无规格商品的唯一组合（key=''）」—— 这是**测试侧的书写便利**，
 * 不是产品代码里的兼容分支：服务端只认 specs + skus。
 *
 * 单位是**微 USDT**（1 USDT = 1e6 微）：88 USDT 写 88000000。
 * 旧的 2 位小数标价单位已整体作废，数字不是"改个名字"那么轻——一律 ×10000。
 *
 * 需要测多规格时直接传 specs + skus：
 *   productPayload({ specs: [{name:'颜色',options:['黑','白']}],
 *                    skus: [{key:'黑',priceUsdtMicro:88000000},{key:'白',priceUsdtMicro:99000000}] })
 */
export function productPayload(overrides = {}) {
  const { priceUsdtMicro = 88_000_000, capacity = null, specs, skus, ...rest } = overrides;
  return {
    title: '测试数字商品',
    description: '单测上架的商品描述，用于校验快照与下单流程。',
    media: [{ type: 'image', url: 'https://example.com/a.jpg' }],
    kind: 'digital',
    specs: specs ?? [],
    skus: skus ?? [{ key: '', priceUsdtMicro, capacity }],
    ...rest,
  };
}

/**
 * 默认组合（sku_key=''）的库存行 —— 价格与库存现在都在 product_skus 上。
 * 无规格商品的唯一组合就是它，所以单规格用例仍可像以前一样读「这个商品的库存」。
 * 多规格用例请直接查 product_skus 并带上具体 sku_key。
 */
export function skuInv(db, slug) {
  const r = db
    .prepare(
      `SELECT s.capacity AS capacity, s.committed AS committed
         FROM product_skus s JOIN products p ON p.id = s.product_id
        WHERE p.slug = ? AND s.sku_key = ''`
    )
    .get(slug);
  return r || { capacity: null, committed: 0 };
}

/**
 * 把草稿"做旧" ms 毫秒（清扫器用例的前置）——**必须同时回拨 `created_mono`**：
 * 清扫判据对"本次运行创建的草稿"只看单调锚点（见 `src/monotonicClock.js` 与 `src/orderSweeper.js`），
 * 只改 `created_at` 在新判据下不再等于"这单很老"（那正是这轮修复的意义）。
 * 想模拟"上一次运行遗留的草稿"请改 `created_boot`（跨运行的单调读数不可比，走墙钟判据）。
 */
export function ageDrafts(db, ids, ms) {
  const list = Array.isArray(ids) ? ids : [ids];
  const marks = list.map(() => '?').join(', ');
  db.prepare(
    `UPDATE orders SET created_at = created_at - ?, created_mono = created_mono - ? WHERE id IN (${marks})`
  ).run(ms, ms, ...list);
}

/**
 * 由 API 返回的商品构造「DB 行形状」的对象，供测试复算快照哈希。
 * 快照契约（**键序即契约**，两端必须逐字一致，见 node/src/routes/products.js 的 snapshotObject
 * 与 frontend/src/utils/snapshot.ts）：slug / title / description / description_blocks /
 * media / kind / shipping_fee_usdt_micro / age_restricted / specs / skus（nft 商品在**末尾**
 * 追加 nft_contract、nft_standard）——价格不在商品级，每个组合的单价在 skus 里。
 */
export function rowLikeOf(p) {
  return {
    slug: p.slug,
    title: p.title,
    description: p.description,
    // **每个快照键都要在这里**：这个助手是"公开字段 → 可复算的哈希"的判据输入，
    // 漏一个键就会让"哈希对不对"这条断言悄悄失去意义（曾经漏过 description_blocks：
    // 带详情块的商品复算必然不一致，而用例只报哈希不同、看不出是谁漏了）。
    description_blocks: JSON.stringify(p.descriptionBlocks || []),
    media: JSON.stringify(p.media || []),
    kind: p.kind,
    shipping_fee_usdt_micro: p.shippingFeeUsdtMicro ?? 0,
    age_restricted: p.ageRestricted ? 1 : 0,
    specs: JSON.stringify(p.specs || []),
    skus: (p.skus || []).map((s) => ({
      sku_key: s.key,
      price_usdt_micro: s.priceUsdtMicro,
      image_url: s.imageUrl || '',
    })),
    attributes: JSON.stringify(p.attributes || []),
    terms: JSON.stringify(p.terms || {}),
    nft_contract: p.nftContract || '',
    nft_standard: p.nftStandard || 'erc721',
  };
}
