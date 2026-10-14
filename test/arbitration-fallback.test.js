/**
 * 仲裁人视角安全降级：节点未配置 MK_ARBITER_ADDRESS 且 RPC 不可达时，
 * getArbiterAddress 返回 null——详情接口不把任何登录地址视为仲裁人，
 * 宁可拒绝开放视角（交付码不泄露），店主兜底视角不受影响。
 * 状态推进不经真实链上（单测无 RPC）——与 watcher.test 同款：直调 applyEvent。
 *
 * 2026-10-14 补第二条：**"读到过一次、之后读不到"**也必须拒绝。
 * 旧实现在失败时回退"上一次成功读到的地址"，而负缓存窗口也照样刷新 ⇒ 只要 RPC 一直不可用，
 * 它就一直把那个旧地址当成当前仲裁人。两个消费方都是鉴权（详情开码 `routes/orders.js`
 * 与附件下载 `routes/evidenceFiles.js`），于是 `Escrow.setArbiter` 轮换掉一个仲裁人之后，
 * **被撤掉的密钥在 RPC 故障期间仍能读到收货信息、交付码与双方售后陈述**。
 * 下面第二条用例用本地假 JSON-RPC 精确构造这一幕：
 * 先成功读到 A（缓存 60s）→ 轮换成 B 且 RPC 读不到 → A 必须不再被当成仲裁人。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Wallet, Interface } from 'ethers';
import { makeCtx, login, assertOk, productPayload } from './setup.mjs';

// 刻意不设 MK_ARBITER_ADDRESS：走 RPC 读取路径（本文件用本地假 JSON-RPC 回答 arbiter()）
const ctx = await makeCtx();
const { app, request, db, owner, buyer } = ctx;
const arbiter = Wallet.createRandom();
/** 链上 arbiter() 被读成这个地址（= 上面那把密钥，用来验证"确证时确实开放"） */
const arbiterOnchain = arbiter.address.toLowerCase();

const { ESCROW_ABI, getArbiterAddress, arbiterStatus, __resetArbiterCacheForTest, __expireArbiterCacheForTest } =
  await import('../src/chain.js');
const config = (await import('../src/config.js')).default;
const iface = new Interface(ESCROW_ABI);
const SEL_ARBITER = iface.getFunction('arbiter').selector;

/** true = 模拟"轮换之后 RPC 持续读不到" */
let arbiterReadFails = false;

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      parsed = {};
    }
    const one = (j) => {
      // ethers 的 provider 初始化会先要一次链 ID（chain.js 用 staticNetwork + chainId 断言）
      if (j?.method === 'eth_chainId') return { result: `0x${Number(config.chain.chainId).toString(16)}` };
      if (j?.method === 'eth_call' && String(j?.params?.[0]?.data || '').slice(0, 10).toLowerCase() === SEL_ARBITER) {
        if (arbiterReadFails) return { error: { code: -32000, message: 'unit-test: RPC 读不到 arbiter()' } };
        return { result: iface.encodeFunctionResult('arbiter', [arbiterOnchain]) };
      }
      return { error: { code: -32601, message: `unit-test: 未预期的 RPC 方法 ${j?.method}` } };
    };
    const out = Array.isArray(parsed)
      ? parsed.map((j) => ({ jsonrpc: '2.0', id: j?.id ?? 1, ...one(j) }))
      : { jsonrpc: '2.0', id: parsed?.id ?? 1, ...one(parsed) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
after(() => rpcServer.close());

let ownerToken;
let arbiterToken;

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
  arbiterToken = (await login(ctx, arbiter)).token;
  assert.ok(ownerToken && arbiterToken);
});

const { applyEvent } = await import('../src/escrowWatcher.js');

/** 造一张"已交付码 + 已进入争议"的单（码仅在确证仲裁人后开放） */
let paySeq = 0;
async function disputedOrderWithCode(title) {
  const res0 = await request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send(productPayload({ title }))
    .expect(200);
  assertOk(res0);
  const draftRes = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ productSlug: res0.body.data.slug, buyer: buyer.address })
    .expect(200);
  assertOk(draftRes);
  const order = draftRes.body.data;
  // 模拟 watcher/paid 回写：escrowed 必落链上支付凭证（发货防呆要求，见 orders.js 头注释）。
  // 哈希必须**逐单不同**：paid_tx_hash 上有唯一索引（同一笔链上托管只能确认一单）。
  paySeq += 1;
  db.prepare("UPDATE orders SET status = 'escrowed', paid_tx_hash = ?, updated_at = ? WHERE id = ?")
    .run(`0x${String(paySeq).padStart(64, 'e')}`, Date.now(), order.id);
  // 卖家手动交付码后买家发起争议（shipped → disputed，含码的争议单）
  const shipRes = await request(app)
    .post(`/api/orders/${order.id}/ship`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ deliveryCode: 'CARD-888' })
    .expect(200);
  assertOk(shipRes);
  assert.equal(applyEvent('DisputeRequested', { orderId: order.escrowOrderId }), 1);
  return order;
}

/** 取详情并断言 code=0 */
async function detailAs(token, id) {
  const r = await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${token}`).expect(200);
  assertOk(r);
  return r.body.data;
}

test('RPC 不可达且无仲裁人配置：仲裁人登录也不开放交付码（安全降级）', async () => {
  __resetArbiterCacheForTest(); // 每个用例从"没读到过"开始（60s 缓存是生产语义，用例不该互相继承）
  arbiterReadFails = true; // 本用例的现场：读不到
  const order = await disputedOrderWithCode('降级仲裁数字商品');

  // 待仲裁列表正常公开（降级只影响「仲裁人视角」的数据开放，不影响公开摘要）
  const pendRes = await request(app).get('/api/arbitration/pending').expect(200);
  assertOk(pendRes);
  assert.equal(pendRes.body.data.total, 1);
  assert.equal(pendRes.body.data.disputes[0].delivered, true);

  // 仲裁人令牌访问详情：RPC 不可达 → 无法确证其为链上仲裁人 → 码不开放
  const arbDetail = await detailAs(arbiterToken, order.id);
  assert.equal(arbDetail.status, 'disputed', '公开字段仍可读');
  assert.deepEqual(arbDetail.deliveries, [], '未确证仲裁人身份前不泄露码');

  // 店主兜底不受影响（卖家本来持有码，追索/回收权限不依赖仲裁人判定）
  const ownerDetail = await detailAs(ownerToken, order.id);
  assert.equal(ownerDetail.deliveries[0].value, 'CARD-888', '店主视角不受降级影响');
});

/**
 * 这条是 2026-10-14 修的缺陷的回归闸：**"读到过一次、之后读不到"不得沿用旧值**。
 * 三段断言缺一不可：
 *   ① 确证能读到 A 时 A 确实开放（否则这条用例可能因为"根本没读到过"而侥幸通过）；
 *   ② 轮换成 B 且读不到之后，A 不再被当成仲裁人（旧实现在这里仍然开放）；
 *   ③ 诊断读数如实说"读不到"，而不是把它显示成某个具体地址。
 */
test('读到过一次之后 RPC 故障：不得把上一次成功读到的仲裁人当成当前仲裁人', async () => {
  // 从干净的缓存开始：否则上一条用例留下的"负缓存"会让本用例的第一步直接命中缓存、
  // 连 RPC 都不发——那样它测的就不是"读到过一次之后"了
  __resetArbiterCacheForTest();
  arbiterReadFails = false; // 现场 ①：确证读得到
  const order = await disputedOrderWithCode('轮换后降级数字商品');

  assert.equal(await getArbiterAddress(), arbiterOnchain, '确证能读到');
  const confirmed = await detailAs(arbiterToken, order.id);
  assert.equal(confirmed.deliveries[0]?.value, 'CARD-888', '确证为仲裁人时，争议单的码对它开放');

  /*
    现场 ②：先让 60s 正缓存自然过期**而不清史**（`lastOk` 必须留着），再让 RPC 开始持续失败。
    顺序是关键：这条用例要验证的正是"缓存跨过一次成功、一次失败之后"的表现——
    如果在失败前把史也清了，就退化成上一条用例（从未读到过），
    断言③里"最后一次成功读数可查"那句也就失去意义了。
  */
  __expireArbiterCacheForTest();
  arbiterReadFails = true;

  // ② 读不到 ⇒ 谁都不是仲裁人（旧实现在这里会拿 ① 的地址顶上，仍然开放）
  assert.equal(await getArbiterAddress(), null, '读不到 ⇒ 判定值必须是 null，不是上次成功值');
  const afterFail = await detailAs(arbiterToken, order.id);
  assert.deepEqual(afterFail.deliveries, [], '旧仲裁人密钥在 RPC 故障期间不得再读到交付码');

  // ③ 诊断读数：known=false；lastOk 只作"最后读到过谁"的排障线索，不参与判定
  const st = arbiterStatus();
  assert.equal(st.known, false, '读不到必须能作为一个独立结论被看见');
  assert.equal(st.arbiter, null, '判定值不得显示成某个具体地址');
  assert.equal(st.lastOk?.addr, arbiterOnchain, '最后一次成功读数留作排障线索');
});
