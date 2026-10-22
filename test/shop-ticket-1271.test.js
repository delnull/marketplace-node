/**
 * 票据验签的 1271 分支（节点侧）：
 *   · EOA 走离线 ECDSA，**不依赖 RPC**（节点离线时普通钱包仍能验）；
 *   · 标准 1271 验 digest（`0x1626ba7e`）；
 *   · Safe v1.3 `signMessage(inner)` 走 legacy `isValidSignature(bytes,bytes)`（`0x20c13b0b`）；
 *   · 读不到 / 返回错魔数 / 调用 revert 一律 false（fail-closed）。
 *
 * 链上对应 `MarketplaceRegistry._isValidSignature`；两边判据必须同构。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Wallet, hashMessage, keccak256, toUtf8Bytes } from 'ethers';

process.env.MK_REGISTRY_ADDRESS = '0x000000000000000000000000000000000000dEaD';
process.env.MK_CHAIN_ID = '31337';

const { isValidTicketSignature } = await import('../src/shops.js');

const inner = keccak256(toUtf8Bytes('1271-inner'));
const digest = hashMessage(inner);
const erc1271 = new Interface([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function isValidSignature(bytes data, bytes signature) view returns (bytes4)',
]);

test('EOA：离线 ECDSA 恢复命中，不需要 provider', async () => {
  const w = Wallet.createRandom();
  const sig = w.signingKey.sign(digest).serialized;
  assert.equal(await isValidTicketSignature(w.address, inner, digest, sig, null), true);
  assert.equal(await isValidTicketSignature(Wallet.createRandom().address, inner, digest, sig, null), false);
});

test('标准 1271：getCode 有代码 + bytes32 重载返回魔数 ⇒ 通过', async () => {
  const w = Wallet.createRandom();
  const signer = w.address;
  const sig = w.signingKey.sign(digest).serialized;
  const provider = {
    getCode: async () => '0x60006000',
    call: async ({ to, data }) => {
      assert.equal(String(to).toLowerCase(), signer.toLowerCase());
      assert.ok(String(data).startsWith('0x1626ba7e'), '标准路径必须先调 bytes32 重载');
      return erc1271.encodeFunctionResult('isValidSignature(bytes32,bytes)', ['0x1626ba7e']);
    },
  };
  assert.equal(await isValidTicketSignature(signer, inner, digest, sig, provider), true);
});

test('Safe legacy：bytes32 重载失败、bytes 重载把 inner 当 SafeMessage ⇒ 通过', async () => {
  const signer = Wallet.createRandom().address;
  const sig = '0x5afe';
  let standardCalls = 0;
  const provider = {
    getCode: async () => '0x60006000',
    call: async ({ to, data }) => {
      assert.equal(String(to).toLowerCase(), signer.toLowerCase());
      const selector = String(data).slice(0, 10).toLowerCase();
      if (selector === '0x1626ba7e') {
        standardCalls += 1;
        return erc1271.encodeFunctionResult('isValidSignature(bytes32,bytes)', ['0xffffffff']);
      }
      assert.equal(selector, '0x20c13b0b', 'Safe fallback 必须走 bytes 重载');
      return erc1271.encodeFunctionResult('isValidSignature(bytes,bytes)', ['0x20c13b0b']);
    },
  };
  assert.equal(await isValidTicketSignature(signer, inner, digest, sig, provider), true);
  assert.equal(standardCalls, 1, '标准路径先试一次，失败后才走 Safe legacy');
});

test('合约账户：魔数不对 / 调用抛错 / 无代码 ⇒ 拒绝', async () => {
  // 故意用**别的钱包**的签名：本地 ECDSA 恢复不中，才会进入 1271 分支
  const signer = Wallet.createRandom().address;
  const sig = Wallet.createRandom().signingKey.sign(digest).serialized;

  const badMagic = {
    getCode: async () => '0x60006000',
    call: async () => erc1271.encodeFunctionResult('isValidSignature(bytes32,bytes)', ['0xffffffff']),
  };
  assert.equal(await isValidTicketSignature(signer, inner, digest, sig, badMagic), false);

  const throws = {
    getCode: async () => '0x60006000',
    call: async () => {
      throw new Error('rpc down');
    },
  };
  assert.equal(await isValidTicketSignature(signer, inner, digest, sig, throws), false);

  const eoa = {
    getCode: async () => '0x',
    call: async () => {
      throw new Error('must not be called');
    },
  };
  assert.equal(await isValidTicketSignature(signer, inner, digest, sig, eoa), false);
});

test('畸形签名 / 零地址不入 1271 分支', async () => {
  const provider = {
    getCode: async () => {
      throw new Error('must not be called');
    },
    call: async () => {
      throw new Error('must not be called');
    },
  };
  assert.equal(await isValidTicketSignature('0x0000000000000000000000000000000000000000', inner, digest, '0x12', provider), false);
  assert.equal(await isValidTicketSignature('not-an-address', inner, digest, '0x12', provider), false);
  assert.equal(await isValidTicketSignature('0x0000000000000000000000000000000000000001', inner, digest, '0x', provider), false);
});

test('空签名必须早退，不进入 1271', async () => {
  const provider = {
    getCode: async () => {
      throw new Error('must not be called');
    },
    call: async () => {
      throw new Error('must not be called');
    },
  };
  assert.equal(await isValidTicketSignature('0x0000000000000000000000000000000000000001', inner, digest, '', provider), false);
});
