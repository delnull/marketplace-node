/**
 * ERC20 商品上架：商家填的地址必须是**标准 ERC20 合约**（有代码 + decimals/symbol 可读）；
 * 一个商品一个合约，SKU 必须给出每份交付的 raw 数量。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeCtx, login, productPayload, shopRef } from './setup.mjs';

const ctx = await makeCtx();
const config = (await import('../src/config.js')).default;
const { __resetProviderForTest } = await import('../src/chain.js');
const { app, owner } = ctx;
let ownerToken;
const realUrls = config.chain.rpcUrls;

const TOKEN = '0x1111111111111111111111111111111111111111';
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const abiString = (s) => {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return `0x${(32).toString(16).padStart(64, '0')}${(hex.length / 2).toString(16).padStart(64, '0')}${hex.padEnd(64, '0')}`;
};

const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    const one = (q) => {
      if (q.method === 'eth_chainId') return { result: `0x${Number(config.chain.chainId).toString(16)}` };
      if (q.method === 'eth_getCode') return { result: '0x6000' };
      if (q.method === 'eth_call') {
        const data = String(q.params?.[0]?.data || '').toLowerCase();
        if (data.startsWith('0x313ce567')) return { result: word(18) };
        if (data.startsWith('0x95d89b41')) return { result: abiString('TKN') };
      }
      return { error: { code: -32601, message: 'unit-test: unexpected' } };
    };
    const out = Array.isArray(j) ? j.map((q) => ({ jsonrpc: '2.0', id: q.id, ...one(q) })) : { jsonrpc: '2.0', id: j.id, ...one(j) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
config.chain.rpcUrls = [`http://127.0.0.1:${rpc.address().port}`];
__resetProviderForTest();

before(async () => {
  ownerToken = (await login(ctx, owner)).token;
});
after(() => {
  rpc.close();
  config.chain.rpcUrls = realUrls;
  __resetProviderForTest();
});

test('ERC20 商品：地址必须是合约；SKU 必须带每份 raw 数量；快照/详情带 token 元数据', async () => {
  const created = await ctx.request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({
      kind: 'erc20',
      title: '100 TKN 商品',
      tokenContract: TOKEN,
      specs: [{ name: '面额', options: ['100', '500'] }],
      skus: [
        { key: '100', priceUsdtMicro: 10_000_000, capacity: 2, tokenAmount: '100000000000000000000' },
        { key: '500', priceUsdtMicro: 50_000_000, capacity: 1, tokenAmount: '500000000000000000000' },
      ],
    }))
    .expect(200);
  assert.equal(created.body.code, 0, created.body.message);
  assert.equal(created.body.data.kind, 'erc20');
  assert.equal(created.body.data.tokenContract, TOKEN);
  assert.equal(created.body.data.tokenSymbol, 'TKN');
  assert.equal(created.body.data.tokenDecimals, 18);
  assert.equal(created.body.data.skus[0].tokenAmount, '100000000000000000000');

  const detail = await ctx.request(app).get(`/api/products/${created.body.data.slug}`).expect(200);
  assert.equal(detail.body.data.tokenContract, TOKEN);
  assert.equal(detail.body.data.skus[1].tokenAmount, '500000000000000000000');
});

test('ERC20 元数据预检：返回合约精度/符号，供前端把人类单位换算成 raw', async () => {
  const r = await ctx.request(app)
    .get(`/api/products/token-meta?address=${TOKEN}`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(r.body.code, 0, r.body.message);
  assert.equal(r.body.data.contract, TOKEN);
  assert.equal(r.body.data.decimals, 18);
  assert.equal(r.body.data.symbol, 'TKN');
});

test('ERC20 商品缺少 tokenAmount / 地址不是合约都拒绝', async () => {  const noAmount = await ctx.request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'erc20', title: '缺数量', tokenContract: TOKEN, skus: [{ key: '', priceUsdtMicro: 1 }] }))
    .expect(200);
  assert.notEqual(noAmount.body.code, 0);
  assert.match(noAmount.body.message, /tokenAmount/);

  const zero = await ctx.request(app)
    .post('/api/products')
    .set('Authorization', `Bearer ${ownerToken}`).set('X-Mk-Shop', shopRef.value)
    .send(productPayload({ kind: 'erc20', title: '零地址', tokenContract: '0x0000000000000000000000000000000000000000', skus: [{ key: '', priceUsdtMicro: 1, tokenAmount: '1' }] }))
    .expect(200);
  assert.notEqual(zero.body.code, 0);
});
