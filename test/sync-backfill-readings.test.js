/**
 * P1：`/sync` 的三处补录失败必须**留痕并作为第三态读数下发**。
 *
 * 旧实现三处都是 `catch {}`：支付凭证补录、买家授权退款额读取、售后案件回填。
 * 而补支付凭证正是店主被 `/ship` 拒绝后的唯一自救动作——RPC 抖动时它照旧回答
 * "缺少支付凭证"，店主据此去取消重下，而真实原因只是这次没读到。
 *
 * 现在：warn 一条（带单号与原因）+ 响应 `syncBackfill` 三档读数
 * （read / recovered / present / missing / unreadable），文案明确
 * "这次读不到 ≠ 没有凭证"。本用例让三个补录全部失败（getOrder 正常，其余 RPC 全错）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface } from 'ethers';
import { makeCtx, login, assertOk, insertOrder } from './setup.mjs';

const ctx = await makeCtx();
const { app, request, db, buyer, owner } = ctx;

const { ESCROW_ABI } = await import('../src/chain.js');
const config = (await import('../src/config.js')).default;
const iface = new Interface(ESCROW_ABI);

const AMOUNT = '1000000000000000000';
const STATUS_INDEX = { Created: 1, Disputed: 2, Settled: 3, Refunded: 4 };
const FC = '0x3333333333333333333333333333333333333333';
const escrowOrderId = `0x${'77'.repeat(32)}`;

let buyerToken;

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const one = (j) => {
      if (j?.method === 'eth_chainId') return { result: `0x${Number(config.chain.chainId).toString(16)}` };
      if (j?.method === 'eth_blockNumber') return { result: '0x64' };
      if (j?.method === 'eth_getLogs') return { error: { code: -32000, message: 'unit-test: RPC 读不到日志' } };
      if (j?.method === 'eth_call') {
        const sel = String(j.params?.[0]?.data || '').slice(0, 10);
        if (sel === iface.getFunction('getOrder').selector) {
          return {
            result: iface.encodeFunctionResult('getOrder', [
              buyer.address,
              owner.address,
              BigInt(AMOUNT),
              0n,
              120960n,
              2n,
              false,
              false,
              0n,
              STATUS_INDEX.Created,
              FC,
              false,
            ]),
          };
        }
        if (sel === iface.getFunction('commissionTermsAtCreate').selector) {
          /*
            抽成条款的 payee 就是店铺 host，是订单身份的一部分：夹具的报价列 = 节点主（owner），
            所以链上真值必须回同一份。回零地址会让 `/sync` 正确地判成"另一家店/读不到条款"，
            本用例要测的三处补录（凭证/授权额/售后案件）就根本走不到。
          */
          return { result: iface.encodeFunctionResult('commissionTermsAtCreate', [owner.address, 0]) };
        }
        // acceptedPartialRefund / afterSaleOpen / afterSaleOpenedAtBlock：本用例模拟"这三个读不到"
        return { error: { code: -32000, message: 'unit-test: RPC 读不到这一项' } };
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

buyerToken = (await login(ctx, buyer)).token;

test('/sync：三处补录读不到 ⇒ 响应带 syncBackfill 第三态 + warn 留痕（不是"没有凭证/没有案件"）', async () => {
  const o = await insertOrder(db, {
    buyer: buyer.address.toLowerCase(),
    seller: owner.address.toLowerCase(),
    status: 'escrowed',
    amountWei: AMOUNT,
    escrowOrderId,
    paidTxHash: null, // 触发"补录支付凭证"分支
  });

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let res;
  try {
    res = await request(app)
      .post(`/api/orders/${o.orderNo}/sync`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({})
      .expect(200);
  } finally {
    console.warn = origWarn;
  }
  assertOk(res);

  assert.deepEqual(
    res.body.data.syncBackfill,
    { paidTxHash: 'unreadable', partialRefund: 'unreadable', afterSale: 'unreadable' },
    '三处补录都读不到时，读数必须是 unreadable（不是 missing/recovered/read）'
  );
  assert.equal(res.body.data.paidTxHash, null, '本地凭证原值不变（不写 0/空串冒充）');
  /*
    文案覆盖两种"没采用"：读不到，以及读到了但**不属于本单**（跨店/诱饵单）。
    两者都不是"没有"，都不能把本地原值改成一个假结论。
  */
  assert.match(String(res.body.message), /没能采用/, '响应文案必须说清"没采用 ≠ 没有"');
  assert.ok(
    String(res.body.message).includes('**不是**"没有"'),
    '必须明确否掉"没有"这个误读（原文里的强调写法是契约的一部分，界面按纯文本渲染）'
  );
  assert.match(String(res.body.message), /支付凭证补录/);
  assert.match(String(res.body.message), /售后案件回填/);

  const joined = warnings.join('\n');
  assert.match(joined, /支付凭证补录失败/, '支付凭证补录失败必须 warn 留痕');
  assert.match(joined, /授权部分退款额/, '授权退款额读取失败必须 warn 留痕');
  assert.match(joined, /售后案件/, '售后案件回填失败必须 warn 留痕');
  assert.match(joined, new RegExp(o.orderNo), '日志必须带单号（否则运维不知道是哪一单）');
  assert.ok(warnings.length >= 3, `三处失败各留一条 warn（实际 ${warnings.length} 条）`);
});
