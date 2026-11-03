/**
 * NFT 发布期的 ERC165 标准检测：
 * 只允许“恰好一个”ERC721/ERC1155 接口；检测值与卖家声明不一致必须拒绝；
 * RPC 读不到时 retryable（路由 503），不把“不知道”放行成发布成功。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  checkNftStandard,
  detectNftStandard,
  ERC1155_INTERFACE_ID,
  ERC721_INTERFACE_ID,
} from '../src/nftStandard.js';

const CONTRACT = '0x' + 'ab'.repeat(20);

function readerFor(ids) {
  return async (id) => ids.includes(String(id).toLowerCase());
}

test('标准检测：只声明 ERC721 或只声明 ERC1155 时唯一判定', async () => {
  assert.deepEqual(
    await detectNftStandard(CONTRACT, { reader: readerFor([ERC721_INTERFACE_ID]) }),
    { ok: true, standard: 'erc721' }
  );
  assert.deepEqual(
    await detectNftStandard(CONTRACT, { reader: readerFor([ERC1155_INTERFACE_ID]) }),
    { ok: true, standard: 'erc1155' }
  );
});

test('真实 ethers Contract 路径：provider.call 的 supportsInterface 返回值被正确解码', async () => {
  const iface = new ethers.Interface(['function supportsInterface(bytes4 interfaceId) view returns (bool)']);
  const provider = {
    getCode: async () => '0x60016000',
    call: async (tx) => {
      const parsed = iface.parseTransaction({ data: tx.data });
      const id = String(parsed.args[0]).toLowerCase();
      return iface.encodeFunctionResult('supportsInterface', [id === ERC1155_INTERFACE_ID]);
    },
  };
  assert.deepEqual(await detectNftStandard(CONTRACT, { provider }), { ok: true, standard: 'erc1155' });
});

test('标准检测：两个都声明/都不声明/无 ERC165 都不放行', async () => {
  for (const ids of [
    [ERC721_INTERFACE_ID, ERC1155_INTERFACE_ID],
    [],
    ['0x01ffc9a7'],
  ]) {
    const r = await detectNftStandard(CONTRACT, { reader: readerFor(ids) });
    assert.equal(r.ok, false, ids.join(','));
    assert.equal(r.retryable, false);
  }
});

test('标准检测：地址没有代码/RPC 读不到分别明确拒绝，后者 retryable', async () => {
  const noCode = await detectNftStandard(CONTRACT, {
    provider: { getCode: async () => '0x' },
  });
  assert.equal(noCode.ok, false);
  assert.equal(noCode.retryable, false);
  assert.match(noCode.reason, /没有代码/);

  const rpcDown = await detectNftStandard(CONTRACT, {
    provider: {
      getCode: async () => {
        throw new Error('rpc down');
      },
    },
  });
  assert.equal(rpcDown.ok, false);
  assert.equal(rpcDown.retryable, true);
  assert.match(rpcDown.reason, /RPC|rpc down/);
});

test('声明与实际标准不一致必须给出可执行拒绝', async () => {
  const r = await checkNftStandard(CONTRACT, 'erc721', {
    reader: readerFor([ERC1155_INTERFACE_ID]),
  });
  assert.equal(r.ok, false);
  assert.equal(r.standard, 'erc1155');
  assert.match(r.reason, /实际为 ERC1155/);
});

test('supportsInterface 调用遇到超时/网络错误 ⇒ retryable，而不是误报“没有标准”', async () => {
  const err = Object.assign(new Error('RPC timeout'), { code: 'TIMEOUT' });
  const r = await detectNftStandard(CONTRACT, {
    reader: async () => {
      throw err;
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.match(r.reason, /RPC timeout/);
});

test('声明本身非法时直接拒绝', async () => {
  const r = await checkNftStandard(CONTRACT, 'erc20', {
    reader: readerFor([ERC721_INTERFACE_ID]),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /erc721 或 erc1155/);
});
