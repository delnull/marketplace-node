/**
 * NFT 交付登记的**成功路径**单测（`POST /api/orders/:id/nft-deliveries` 走完事务并返回）。
 *
 * 为什么单独立这一份（2026-10-14）：`test/nft.test.js` 覆盖的是**失败路径**（参数非法、
 * tokenId 不在池、收据核验不过）——它的文件头就写着"链上收据拉取不依赖测试网络"。
 * 于是"验签通过 → 事务落交付行 → 置 shipped → **提交后的通知/审计/响应**"这一段没有任何单测，
 * 而恰恰是在这一段里出过一次只有真链剧本才抓到的缺陷：把提交后的副作用搬出事务 try 时，
 * `total` / `toStatus` 留在了块内的 `const` 里（块外引用 = ReferenceError；
 * `node --check` 与 tsc 都看不出来，只有真的交付成功一次才会 500）。
 *
 * 做法：起一个只回答 `eth_getTransactionReceipt` 的假 JSON-RPC 服务器（与
 * `test/order-sync-paths.test.js`、`test/fees-per-order.test.js` 同一手法；ethers 用
 * `staticNetwork: true`，所以不需要协商网络），回一个含一条 ERC-721 Transfer 日志的收据。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface, Wallet } from 'ethers';
import { assertOk, login, makeCtx, shopRef, orderIdOf } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;
const buyer = Wallet.createRandom();

const config = (await import('../src/config.js')).default;

const NFT_CONTRACT = '0x' + '9'.repeat(40);
const TRANSFER_IFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);

let seq = 0;
const payHash = () => '0x' + String(++seq).padStart(64, '0');
const txHashOf = () => '0x' + String(9000 + ++seq).padStart(64, 'a');

/**
 * 假 RPC：默认回"从店主转给买家、tokenId=1"的收据；`receiptTokenIdByHash` 可按 txHash
 * 指定 tokenId（部分交付并发用例要一次交多枚）。
 */
const receiptTokenIdByHash = new Map();
let rpcCalls = 0;

/**
 * 回执屏障：并发交付用例把 N 个已到服务器的回执**扣住**，等 N 个都到齐再一起放行——
 * 这样三个请求会几乎同时进入"检查已交付数 → 插入交付行"的事务段，
 * 事务缺串行化（无行锁）时三个都会通过；加了 FOR UPDATE 后只会有两个成功。
 * 5s 自动放行是防死锁兜底（真失败时让断言变红，而不是把测试挂住）。
 */
let receiptBarrier = null;

/** 单个 JSON-RPC 请求 → 一条"店主转给买家"的收据响应（tokenId 可按 txHash 指定） */
function receiptResponseFor(j) {
  const txHash = String(j.params?.[0] ?? '0x' + 'c'.repeat(64)).toLowerCase();
  const tokenId = receiptTokenIdByHash.get(txHash) ?? 1n;
  const log = {
    address: NFT_CONTRACT,
    topics: [
      TRANSFER_IFACE.getEvent('Transfer').topicHash,
      '0x' + owner.address.toLowerCase().slice(2).padStart(64, '0'),
      '0x' + buyer.address.toLowerCase().slice(2).padStart(64, '0'),
      '0x' + tokenId.toString(16).padStart(64, '0'),
    ],
    data: '0x',
    blockNumber: '0x10',
    blockHash: '0x' + 'b'.repeat(64),
    transactionHash: txHash,
    transactionIndex: '0x0',
    removed: false,
    logIndex: '0x0',
  };
  return {
    jsonrpc: '2.0',
    id: j.id ?? 1,
    result: {
      transactionHash: log.transactionHash,
      transactionIndex: '0x0',
      blockHash: log.blockHash,
      blockNumber: '0x10',
      from: owner.address,
      to: NFT_CONTRACT,
      cumulativeGasUsed: '0x5208',
      gasUsed: '0x5208',
      contractAddress: null,
      logs: [log],
      logsBloom: '0x' + '0'.repeat(512),
      status: '0x1',
      type: '0x2',
      effectiveGasPrice: '0x1',
    },
  };
}

/**
 * 回执屏障：把已到服务器的回执**扣住**，等累计 N 条都到齐再一起放行。
 * 注意 ethers 会把并发读打包成**批量 JSON-RPC**（一个 HTTP body 是数组），所以这里按
 * "响应条数"而不是"HTTP 请求数"计数；放行时按原请求形状回数组/单对象。
 */
function holdOrSend(res, responses, batch) {
  const barrier = receiptBarrier;
  if (!barrier) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(batch ? responses : responses[0]));
    return;
  }
  barrier.waiting.push({ res, responses, batch });
  const total = barrier.waiting.reduce((n, w) => n + w.responses.length, 0);
  if (total >= barrier.expected) {
    clearTimeout(barrier.timer);
    receiptBarrier = null;
    for (const w of barrier.waiting) {
      w.res.setHeader('content-type', 'application/json');
      w.res.end(JSON.stringify(w.batch ? w.responses : w.responses[0]));
    }
  }
}

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    rpcCalls += 1;
    const parsed = JSON.parse(body || '{}');
    const batch = Array.isArray(parsed);
    const list = batch ? parsed : [parsed];
    holdOrSend(res, list.map(receiptResponseFor), batch);
  });
});
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
after(() => rpcServer.close());

const ownerToken = (await login(ctx, owner)).token;

/** NFT 商品（单 SKU）+ 导入一枚 tokenId，再给一张"已托管"的订单 */
async function nftOrderInEscrow() {
  const made = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({
      title: '成功路径 NFT',
      description: 'd',
      media: [{ type: 'image', url: 'https://example.com/n.jpg' }],
      kind: 'nft',
      nftContract: NFT_CONTRACT,
      specs: [],
      skus: [{ key: '', priceUsdtMicro: 66_000_000, capacity: null }],
    })
    .expect(200);
  assertOk(made);
  const slug = made.body.data.slug;
  await request(app)
    .post(`/api/products/${slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ tokens: ['1'] })
    .expect(200);

  const draft = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, buyer: buyer.address })
    .expect(200);
  assertOk(draft);
  const id = draft.body.data.id;
  await db.run("UPDATE orders SET status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), id);
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', payHash(), id);
  return id;
}

test('NFT 交付成功路径：核验通过 → 落交付行 → 置 shipped → 响应与库内一致', async () => {
  const id = await nftOrderInEscrow();
  const txHash = txHashOf();
  const res = await request(app)
    .post(`/api/orders/${id}/nft-deliveries`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ deliveries: [{ tokenId: '1', txHash }] })
    .expect(200);

  assert.equal(res.body.code, 0, `交付应成功，实际：${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.status, 'shipped', '数量到齐 ⇒ 置 shipped');
  assert.equal(res.body.data.delivered, 1);
  assert.equal(res.body.data.deliveries[0].value, '1');
  assert.ok(rpcCalls > 0, '确实去链上拉了收据');

  // 库内：状态、发货标记、交付行、池行占用（提交后的副作用与事务内容一致）
  const row = await db.get('SELECT status, shipped_at FROM v_orders WHERE order_no = ?', id);
  assert.equal(row.status, 'shipped');
  assert.ok(row.shipped_at, 'shipped_at 必须落库（"已交付事实"的三要素之一）');
  const items = await db.all("SELECT kind, value, tx_hash FROM order_delivery_items WHERE order_id = ?", await orderIdOf(db, id));
  assert.equal(items.length, 1);
  assert.equal(items[0].value, '1');
  assert.equal(items[0].tx_hash, txHash.toLowerCase());
  const pool = await db.get("SELECT status, order_id FROM product_nft_tokens WHERE order_id = ?", await orderIdOf(db, id));
  assert.equal(pool.status, 'used', '池内 tokenId 被本单占用');
});

test('镜像停在 requested 而链上已解冻：NFT 交付照常成功（事务里不许再拿镜像判一次）', async () => {
  /*
    回归：交付判据只在进事务前由 `deliveryGate` 按**链上真值**判一次。
    旧实现在事务内的 UPDATE 上还挂着 `AND refund_status != 'requested'`——镜像滞后
    （卖家 `rejectRefund` 之后、或 `RefundRejected` 事件漏扫）时它会把一次合法交付挡回去，
    并给出一个与链上相反的理由（"退款申请已在核验期间落地"）。2026-10-15 评审实测到过。
  */
  const id = await nftOrderInEscrow();
  await db.run("UPDATE order_chain SET refund_status = 'requested' WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)", id); // 镜像停在"待处理"
  const res = await request(app)
    .post(`/api/orders/${id}/nft-deliveries`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ deliveries: [{ tokenId: '1', txHash: txHashOf() }] })
    .expect(200);

  assert.equal(res.body.code, 0, `链上没冻结就该能交付，实际：${JSON.stringify(res.body)}`);
  assert.equal((await db.get('SELECT status FROM v_orders WHERE order_no = ?', id)).status, 'shipped');
  assert.equal((await db.get("SELECT COUNT(*) AS c FROM order_delivery_items WHERE order_id = ?", await orderIdOf(db, id))).c, 1);
});

/**
 * **P3-2：部分交付的"已交付数 ≤ quantity"必须在同一订单上串行化**。
 *
 * 旧实现只在事务里做了一次 `COUNT(*)`（REPEATABLE READ 快照读）：三个并发请求各自读到
 * "已交付 0"、各自插入一行，最终交付行 3 > quantity 2，而状态可能仍停在 escrowed。
 * 现在事务开头 `SELECT … FOR UPDATE` 锁订单行，后到者的计数一定包含先到者已提交的行。
 *
 * 做法：假 RPC 扣住三个回执，等三个请求都到齐再一起放行——让它们尽可能同时进入事务段。
 * 没有行锁时三条都会成功；有行锁时恰好两条成功、第三条以"超量交付"被拒。
 */
test('NFT 部分交付并发：三笔同时登记 1 枚（quantity=2）⇒ 只有两笔成功，交付行不超量', async () => {
  const made = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({
      title: '并发部分交付 NFT',
      description: 'd',
      media: [{ type: 'image', url: 'https://example.com/n3.jpg' }],
      kind: 'nft',
      nftContract: NFT_CONTRACT,
      specs: [],
      skus: [{ key: '', priceUsdtMicro: 66_000_000, capacity: null }],
    })
    .expect(200);
  assertOk(made);
  const slug = made.body.data.slug;
  await request(app)
    .post(`/api/products/${slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ tokens: ['1-3'] })
    .expect(200);
  const draft = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, buyer: buyer.address })
    .expect(200);
  assertOk(draft);
  const id = draft.body.data.id;
  await db.run("UPDATE orders SET quantity = 2, status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), id);
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', payHash(), id);

  const txHashes = [1, 2, 3].map(() => txHashOf());
  txHashes.forEach((h, i) => receiptTokenIdByHash.set(h.toLowerCase(), BigInt(i + 1)));
  receiptBarrier = {
    expected: 3,
    waiting: [],
    timer: setTimeout(() => {
      // 兜底：真挂住时放行，让断言给出失败原因而不是让测试无限等待
      const b = receiptBarrier;
      receiptBarrier = null;
      if (!b) return;
      for (const w of b.waiting) {
        w.res.setHeader('content-type', 'application/json');
        w.res.end(JSON.stringify({ jsonrpc: '2.0', id: w.j.id ?? 1, result: w.receipt }));
      }
    }, 5000),
  };
  receiptBarrier.timer.unref?.();

  let responses;
  try {
    responses = await Promise.all(
      [1, 2, 3].map((tokenId, i) =>
        request(app)
          .post(`/api/orders/${id}/nft-deliveries`)
          .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
          .send({ deliveries: [{ tokenId: String(tokenId), txHash: txHashes[i] }] })
          .expect(200)
      )
    );
  } finally {
    if (receiptBarrier) clearTimeout(receiptBarrier.timer);
    receiptBarrier = null;
  }

  const okCount = responses.filter((r) => r.body.code === 0).length;
  assert.equal(okCount, 2, `quantity=2，三笔并发各交 1 枚只能成功 2 笔（实际 ${okCount}，响应 ${JSON.stringify(responses.map((r) => r.body.message))}）`);
  const rows = await db.all('SELECT value FROM order_delivery_items WHERE order_id = ? ORDER BY id', await orderIdOf(db, id));
  assert.equal(rows.length, 2, '交付行不得超量（旧实现会落 3 行）');
  assert.equal((await db.get('SELECT status FROM v_orders WHERE order_no = ?', id)).status, 'shipped', '正好交齐 ⇒ shipped');
  const used = await db.get("SELECT COUNT(*) AS c FROM product_nft_tokens WHERE product_id = (SELECT product_id FROM orders WHERE order_no = ?) AND status = 'used'", id);
  assert.equal(Number(used.c), 2, '只占用两枚池内 token');
});

test('NFT 部分交付（未到数量）：交付行照常落，订单保持 escrowed（等剩余额度）', async () => {
  // 两枚的单：先交 1 枚
  const made = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({
      title: '部分交付 NFT',
      description: 'd',
      media: [{ type: 'image', url: 'https://example.com/n2.jpg' }],
      kind: 'nft',
      nftContract: NFT_CONTRACT,
      specs: [],
      skus: [{ key: '', priceUsdtMicro: 66_000_000, capacity: null }],
    })
    .expect(200);
  assertOk(made);
  const slug = made.body.data.slug;
  await request(app)
    .post(`/api/products/${slug}/tokens`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ tokens: ['1-2'] })
    .expect(200);
  const draft = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ productSlug: slug, buyer: buyer.address })
    .expect(200);
  assertOk(draft);
  const id = draft.body.data.id;
  await db.run("UPDATE orders SET quantity = 2, status = 'escrowed', updated_at = ? WHERE order_no = ?", new Date(), id);
  await db.run('UPDATE order_chain SET paid_tx_hash = ? WHERE EXISTS (SELECT 1 FROM orders o WHERE o.id = order_chain.order_id AND o.order_no = ?)', payHash(), id);

  const first = await request(app)
    .post(`/api/orders/${id}/nft-deliveries`)
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send({ deliveries: [{ tokenId: '1', txHash: txHashOf() }] })
    .expect(200);
  assert.equal(first.body.code, 0, JSON.stringify(first.body));
  assert.equal(first.body.data.status, 'escrowed', '未交齐 ⇒ 保持 escrowed（部分交付）');
  assert.equal((await db.get('SELECT status FROM v_orders WHERE order_no = ?', id)).status, 'escrowed');
});
