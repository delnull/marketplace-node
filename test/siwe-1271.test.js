/**
 * SIWE 的合约账户分支（ERC-1271）：登录挑战不是 EOA personal_sign，节点必须把
 * `hashMessage(message)` 交给标准 1271、把 **message 原文** 交给 Safe legacy；
 * 两种语义都失败时 fail-closed（nonce 不被消费，但也不签发令牌）。
 *
 * 这里起一个本地假 JSON-RPC（与 order-sync-paths.test.js 同款）：ethers 在 Node 下走
 * node:http，不经过 globalThis.fetch；桩只回答 eth_getCode / eth_call，并**逐字断言**
 * 节点送进来的 digest 与 Safe legacy 的 message 字节，防止"只测到有代码就放行"。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface, getBytes, hashMessage } from 'ethers';
import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { app, request } = ctx;
const { default: config } = await import('../src/config.js');

const IFACE = new Interface([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function isValidSignature(bytes data, bytes signature) view returns (bytes4)',
]);
const STANDARD = '0x1000000000000000000000000000000000000001';
const SAFE = '0x1000000000000000000000000000000000000002';
const BAD = '0x1000000000000000000000000000000000000003';
const CONTRACTS = new Set([STANDARD.toLowerCase(), SAFE.toLowerCase(), BAD.toLowerCase()]);

let expectedMessage = '';
let expectedSig = '';

function magic(fragment, value) {
  return IFACE.encodeFunctionResult(fragment, [value]);
}

function handleRpc(j) {
  const method = String(j?.method || '');
  if (method === 'eth_chainId') return { result: '0xbb7' }; // 2999
  if (method === 'eth_blockNumber') return { result: '0x1' };
  if (method === 'eth_getCode') {
    const addr = String(j?.params?.[0] || '').toLowerCase();
    return { result: CONTRACTS.has(addr) ? '0x60006000' : '0x' };
  }
  if (method !== 'eth_call') {
    return { error: { code: -32601, message: `unit-test: 未预期的 RPC 方法 ${method}` } };
  }

  const to = String(j?.params?.[0]?.to || '').toLowerCase();
  const data = String(j?.params?.[0]?.data || '');
  const selector = data.slice(0, 10).toLowerCase();

  if (to === BAD.toLowerCase()) {
    return { result: magic('isValidSignature(bytes32,bytes)', '0xffffffff') };
  }

  if (to === STANDARD.toLowerCase()) {
    assert.equal(selector, '0x1626ba7e', '标准 1271 必须先走 bytes32 重载');
    const tx = IFACE.parseTransaction({ data });
    assert.equal(tx.args[0], hashMessage(expectedMessage), '标准 1271 的 digest 必须是 hashMessage(message)');
    assert.equal(tx.args[1], expectedSig, '签名必须原样传给合约账户');
    return { result: magic('isValidSignature(bytes32,bytes)', '0x1626ba7e') };
  }

  if (to === SAFE.toLowerCase()) {
    if (selector === '0x1626ba7e') {
      return { result: magic('isValidSignature(bytes32,bytes)', '0xffffffff') };
    }
    assert.equal(selector, '0x20c13b0b', 'Safe 必须走 legacy bytes 重载');
    const tx = IFACE.parseTransaction({ data });
    assert.equal(
      Buffer.from(getBytes(tx.args[0])).toString('utf8'),
      expectedMessage,
      'Safe legacy 必须收到 message 原文，不能把 digest 再包一层'
    );
    assert.equal(tx.args[1], expectedSig);
    return { result: magic('isValidSignature(bytes,bytes)', '0x20c13b0b') };
  }

  return { error: { code: -32601, message: `unit-test: 未预期的 eth_call to ${to} selector ${selector}` } };
}

const rpcServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const out = Array.isArray(parsed)
      ? parsed.map((j) => ({ jsonrpc: '2.0', id: j?.id ?? 1, ...handleRpc(j) }))
      : { jsonrpc: '2.0', id: parsed?.id ?? 1, ...handleRpc(parsed) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r));
config.chain.rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
after(() => rpcServer.close());

async function loginAsContract(address, signature) {
  const nonce = await request(app).get(`/api/auth/nonce?address=${address}`).expect(200);
  const message = nonce.body.data.message;
  expectedMessage = message;
  expectedSig = signature;
  return request(app).post('/api/auth/login').send({ address, message, signature });
}

test('SIWE：标准 EIP-1271 合约账户可登录（digest = hashMessage(message)）', async () => {
  const res = await loginAsContract(STANDARD, '0xdeadbeef');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.data?.token, '登录成功必须签发令牌');
});

test('SIWE：Safe signMessage(message) 走 legacy bytes 重载可登录', async () => {
  const res = await loginAsContract(SAFE, '0x5afe');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.data?.token);
});

test('SIWE：两种 1271 语义都不认 ⇒ 401，不签发令牌', async () => {
  const res = await loginAsContract(BAD, '0xbad');
  assert.equal(res.status, 401);
  assert.ok(!res.body.data?.token);
});
