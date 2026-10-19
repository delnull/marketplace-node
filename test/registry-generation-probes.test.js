/**
 * Registry **代次自检**（`chain.assertRegistryGeneration`）的判据。
 *
 * 为什么需要它（与 Escrow 代次自检同一条纪律）：节点除了托管合约，还会读 Registry 的
 * `ShopInfo` 元组（按位置解码）、员工名单（2026-10-18 新增）与 `shopListed`。接上更早一代
 * Registry 时节点**照常启动**，然后店铺对账每轮解码失败（本地 listed 永远不更新）、
 * 节点员工永远鉴权失败——日志里只有一句"读不到"，而 `/healthz` 一切正常。
 *
 * 本文件用 **mock provider** 走真实 ethers 解码路径：旧 ABI 的返回形状会让
 * `contract.getShop()` 在解码处直接抛错——那正是启动期要拒绝的形状。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contract, Interface, AbiCoder, ZeroAddress, ZeroHash } from 'ethers';
import { REGISTRY_ABI, assertRegistryGeneration } from '../src/chain.js';

const ADDR = '0x000000000000000000000000000000000000dEaD';
const iface = new Interface(REGISTRY_ABI);
const coder = AbiCoder.defaultAbiCoder();
const selector = (name) => iface.getFunction(name).selector;

/** 把 `selector → ABI 编码返回值` 包成一个 ethers Contract 能用的 provider（只实现 call） */
function contractWith(returns) {
  const provider = {
    call: async (tx) => {
      const data = returns[tx.data.slice(0, 10)];
      if (data === undefined) throw new Error('execution reverted: function selector was not recognized');
      return data;
    },
  };
  return new Contract(ADDR, REGISTRY_ABI, provider);
}

/** 当前这一代 Registry 的五个读数（`ShopInfo` 恰好 7 个字段） */
const currentReturns = {
  [selector('getShop')]: coder.encode(
    ['tuple(address,address,uint16,uint64,uint64,uint64,bytes32)'],
    [[ZeroAddress, ZeroAddress, 0, 0, 0, 0, ZeroHash]]
  ),
  [selector('staffNode')]: coder.encode(['address'], [ZeroAddress]),
  [selector('nodeStaff')]: coder.encode(['address[]'], [[]]),
  [selector('isForceClosed')]: coder.encode(['bool'], [false]),
  [selector('shopListed')]: coder.encode(['bool'], [false]),
};

test('当前代 Registry：五个读法齐全 + ShopInfo 7 字段 ⇒ 通过', async () => {
  const r = await assertRegistryGeneration(contractWith(currentReturns));
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  assert.equal(r.skipped, false);
  assert.equal(r.probed, 5);
});

test('旧 ABI（ShopInfo 少字段 / staffNode 不存在）⇒ 启动期必须被拒，并逐项点名', async () => {
  /*
    旧一代的两种真实形状：
      · `getShop` 返回 6 字段元组 ⇒ 本版本 ABI 按 7 字段解码，ethers 在解码处抛错；
      · 员工名单读法根本不存在（2026-10-18 才加）⇒ provider 回 revert。
    自检必须把两者都报成 missing（而不是只报第一个就放行）。
  */
  const legacyReturns = {
    [selector('getShop')]: coder.encode(
      ['tuple(address,address,uint16,uint64,uint64,uint64)'],
      [[ZeroAddress, ZeroAddress, 0, 0, 0, 0]]
    ),
  };
  const r = await assertRegistryGeneration(contractWith(legacyReturns));
  assert.equal(r.ok, false, '旧 ABI 必须被拒绝');
  const missing = r.missing.join('\n');
  assert.match(missing, /getShop\(address,address\)/, '必须点名 getShop 的形状问题');
  assert.match(missing, /staffNode\(address\)/, '必须点名缺失的员工读法');
  assert.match(missing, /nodeStaff\(address\)/);
  assert.match(missing, /isForceClosed\(address\)/, '必须点名缺失的强制关闭读法（否则被 forceClose 的员工仍可能通过鉴权）');
  assert.match(missing, /shopListed\(bytes32\)/);
});

test('getShop 返回形状不对的数据同样被拒（不因"调用没抛"就通过）', async () => {
  /*
    探针不只判"函数存不存在"，还判**返回值形状**：这里让 getShop 回一段无法解成
    ShopInfo 的数据（模拟另一代 Registry 的元组/返回值类型不同）。自检必须把它报成缺失，
    而不是因为"调用能发出去"就放行——那正是"接错代次却绿灯启动"的形状。
  */
  const r = await assertRegistryGeneration(contractWith({ ...currentReturns, [selector('getShop')]: coder.encode(['uint256'], [1]) }));
  assert.equal(r.ok, false);
  assert.match(r.missing.join('\n'), /getShop\(address,address\)/);
});
