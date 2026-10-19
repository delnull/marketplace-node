/**
 * `POST /api/shops/applications/:id/verify-onchain` 的**事件级**回执核验（P3-6）。
 *
 * 旧实现只判"回执日志里出现过 Registry 地址"：暂停店铺、改费率、停用节点、甚至别人的开店
 * 交易都满足这一条，于是节点会把一个**与本次申请无关**的 txHash 记成 `registered_tx`
 * （本地出现一家链上并不属于你的店，且 txHash 看起来"已上链"）。
 *
 * 现在必须解码回执里的 `ShopRegistered(host, seller, code, commissionBps)` 并逐项对上：
 *   · host/seller/佣金 == 申请行；
 *   · code == 链上 `ShopInfo.code`（9 位字符串，唯一转换点 shopCodeFromChain）。
 * 任何一项不符/没有这条事件 ⇒ 拒绝且不落库。
 */
process.env.MK_REGISTRY_ADDRESS = '0x000000000000000000000000000000000000dEaD';
process.env.MK_CHAIN_ID = '31337';

const { test, before } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const http = await import('node:http');
const { Interface, Wallet, encodeBytes32String } = await import('ethers');
const { makeCtx, login, assertOk } = await import('./setup.mjs');

const ctx = await makeCtx();
const { app, request, db, owner } = ctx;

const { default: config } = await import('../src/config.js');
const { REGISTRY_ABI } = await import('../src/chain.js');
const { shopTicketDigest } = await import('../src/shops.js');
const iface = new Interface(REGISTRY_ABI);
const REGISTRY = config.chain.registryAddress.toLowerCase();
const OWNER = owner.address.toLowerCase();

/** 当前场景：回执日志 + 链上 ShopInfo */
let receiptLogs = [];
let shopInfo = null;

function shopRegisteredLog({ host, seller, code, commissionBps }) {
  const ev = iface.encodeEventLog(iface.getEvent('ShopRegistered'), [host, seller, code, commissionBps]);
  return {
    address: REGISTRY,
    topics: ev.topics,
    data: ev.data,
    blockNumber: '0x10',
    blockHash: '0x' + 'b'.repeat(64),
    transactionHash: '0x' + 'a1'.repeat(32),
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };
}

function handleRpc(j) {
  try {
    if (j.method === 'eth_chainId') return { result: '0x' + Number(config.chain.chainId).toString(16) };
    if (j.method === 'eth_blockNumber') return { result: '0x64' };
    if (j.method === 'eth_getTransactionReceipt') {
      return {
        result: {
          hash: '0x' + 'a1'.repeat(32),
          transactionIndex: '0x0',
          blockHash: '0x' + 'b'.repeat(64),
          blockNumber: '0x10',
          from: OWNER,
          to: REGISTRY,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          contractAddress: null,
          logs: receiptLogs,
          logsBloom: '0x' + '00'.repeat(256),
          status: '0x1',
          type: '0x0',
          effectiveGasPrice: '0x1',
        },
      };
    }
    if (j.method === 'eth_call' && String(j.params?.[0]?.to || '').toLowerCase() === REGISTRY) {
      const data = String(j.params?.[0]?.data || '');
      const selector = data.slice(0, 10);
      if (selector === iface.getFunction('getShop').selector) {
        const [seller] = iface.decodeFunctionData('getShop', data);
        const isMine = shopInfo && String(seller).toLowerCase() === shopInfo.seller;
        return {
          result: iface.encodeFunctionResult('getShop', [
            [
              isMine ? shopInfo.host : OWNER,
              String(seller).toLowerCase(),
              isMine ? shopInfo.commissionBps : 0,
              isMine ? shopInfo.registeredAtBlock : 0,
              0,
              isMine ? shopInfo.exitedAtBlock : 0,
              isMine ? encodeBytes32String(shopInfo.code) : encodeBytes32String(''),
            ],
          ]),
        };
      }
      if (selector === iface.getFunction('shopListed').selector) return { result: iface.encodeFunctionResult('shopListed', [true]) };
      return { error: { code: -32601, message: `unit-test: 未预期 selector ${selector}` } };
    }
    return { error: { code: -32601, message: `unit-test: 未预期 RPC 方法 ${j.method}` } };
  } catch (e) {
    return { error: { code: -32000, message: String(e?.message || e) } };
  }
}

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const one = (x) => ({ jsonrpc: '2.0', id: x?.id ?? 1, ...handleRpc(x) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
  });
});
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
test.after(() => rpcServer.close());

let ownerToken;
before(async () => {
  ownerToken = (await login(ctx, owner)).token;
});

let seq = 0;
/** 造一条 approved 申请（店主签名有效、节点主签名非空）；`verify-onchain` 才会走到回执核验 */
async function approvedApplication({ commissionBps = 250 } = {}) {
  const seller = Wallet.createRandom();
  const deadline = new Date(Date.now() + 3600_000);
  const { digest } = shopTicketDigest({
    host: OWNER,
    seller: seller.address,
    commissionBps,
    deadline,
  });
  // 钱包 personal_sign(内层) 与 `signingKey.sign(两层摘要)` 等价（见 shop-applications.test.js
  // 的 walletSign 说明）；`signMessage(digest)` 会**多包一层**、恢复出别人。
  const sellerSig = seller.signingKey.sign(digest).serialized;
  seq += 1;
  const ins = await db.run(
    `INSERT INTO shop_applications (seller, host, name, notice, commission_to, commission_bps, deadline, status, seller_sig, host_sig)
     VALUES (?, ?, '', '', NULL, ?, ?, 'approved', ?, ?)`,
    seller.address.toLowerCase(),
    OWNER,
    commissionBps,
    deadline,
    sellerSig,
    '0x' + '11'.repeat(65)
  );
  return { id: Number(ins.insertId), seller: seller.address.toLowerCase(), commissionBps };
}

let txSeq = 0;
/**
 * 每次用一个**新的 txHash**：ethers 的 provider 会按哈希缓存回执，若所有用例共用
 * `0xa1…`，第二条用例读到的仍是上一条的日志（症状是"回执里没有 ShopRegistered"）。
 * 假 RPC 对任意哈希都返回当前 `receiptLogs`，所以哈希只需要唯一。
 */
const nextTxHash = () => '0x' + (++txSeq).toString(16).padStart(64, '0');
const verify = (id, txHash = nextTxHash()) =>
  request(app)
    .post(`/api/shops/applications/${id}/verify-onchain`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ txHash });

test('回执带匹配的 ShopRegistered ⇒ 落库并记下该 txHash', async () => {
  const appRow = await approvedApplication({ commissionBps: 250 });
  const code = '0000NEW11';
  shopInfo = { seller: appRow.seller, host: OWNER, commissionBps: 250, registeredAtBlock: 10, exitedAtBlock: 0, code };
  receiptLogs = [shopRegisteredLog({ host: OWNER, seller: appRow.seller, code, commissionBps: 250 })];
  const txHash = nextTxHash();
  const res = await verify(appRow.id, txHash).expect(200);
  assertOk(res);
  assert.equal(res.body.data.code, code);
  const row = await db.get('SELECT code, registered_tx FROM shops WHERE seller = ?', appRow.seller);
  assert.ok(row, '匹配的回执才允许落本地店铺行');
  assert.equal(row.code, code);
  assert.equal(String(row.registered_tx).toLowerCase(), txHash);
});

test('回执只有"别的店/别的动作"的 Registry 日志 ⇒ 拒绝且不落库', async () => {
  const appRow = await approvedApplication({ commissionBps: 300 });
  const code = '0000NEW12';
  shopInfo = { seller: appRow.seller, host: OWNER, commissionBps: 300, registeredAtBlock: 11, exitedAtBlock: 0, code };
  // 一条 Registry 地址发出的日志，但**不是 ShopRegistered**（未知 topic，解析不出事件）
  // ——旧实现只判"日志地址 == Registry"，会把它当成"上链成功"
  receiptLogs = [
    {
      address: REGISTRY,
      topics: ['0x' + 'de'.repeat(32)],
      data: '0x',
      blockNumber: '0x10',
      blockHash: '0x' + 'b'.repeat(64),
      transactionHash: '0x' + 'a1'.repeat(32),
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed: false,
    },
  ];
  const res = await verify(appRow.id).expect(200);
  assert.notEqual(res.body.code, 0);
  assert.match(String(res.body.message), /ShopRegistered/);
  assert.equal(await db.get('SELECT code FROM shops WHERE seller = ?', appRow.seller), undefined, '不得落库');
});

test('ShopRegistered 的 seller/host/佣金与本申请不符 ⇒ 拒绝（不能拿别人的开店交易冒充）', async () => {
  const appRow = await approvedApplication({ commissionBps: 400 });
  const other = Wallet.createRandom().address.toLowerCase();
  const code = '0000NEW13';
  shopInfo = { seller: appRow.seller, host: OWNER, commissionBps: 400, registeredAtBlock: 12, exitedAtBlock: 0, code };
  receiptLogs = [shopRegisteredLog({ host: OWNER, seller: other, code, commissionBps: 400 })];
  const res = await verify(appRow.id).expect(200);
  assert.notEqual(res.body.code, 0);
  assert.match(String(res.body.message), /不是本申请/);
  assert.equal(await db.get('SELECT code FROM shops WHERE seller = ?', appRow.seller), undefined);

  // 换成佣金不一致同样拒绝（同一道判据）
  receiptLogs = [shopRegisteredLog({ host: OWNER, seller: appRow.seller, code, commissionBps: 999 })];
  const res2 = await verify(appRow.id).expect(200);
  assert.notEqual(res2.body.code, 0);
  assert.match(String(res2.body.message), /不是本申请/);
});

test('事件里的 code 与链上 ShopInfo.code 不一致 ⇒ 拒绝（两次读数必须对得上）', async () => {
  const appRow = await approvedApplication({ commissionBps: 200 });
  shopInfo = { seller: appRow.seller, host: OWNER, commissionBps: 200, registeredAtBlock: 13, exitedAtBlock: 0, code: '0000NEW14' };
  receiptLogs = [shopRegisteredLog({ host: OWNER, seller: appRow.seller, code: '0000OTHR1', commissionBps: 200 })];
  const res = await verify(appRow.id).expect(200);
  assert.notEqual(res.body.code, 0);
  assert.match(String(res.body.message), /编号/);
  assert.equal(await db.get('SELECT code FROM shops WHERE seller = ?', appRow.seller), undefined);
});
