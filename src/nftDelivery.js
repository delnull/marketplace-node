/**
 * NFT 交付核验（v2 集合语义）：卖家把池内未用 tokenId 转给买家后提交
 * deliveries: [{tokenId, txHash}]——多哈希（一枚一哈希，多次提交）与批量
 * （同 txHash 一次多枚：ERC721 同收据多笔 Transfer / ERC1155 TransferBatch）均支持。
 * 节点按 txHash 分组做一次集合核验：申报 tokenId 集合须 ⊆ 收据中该合约
 * from=店主、to=买家 的转移集合。
 *
 * 安全边界：事件只能由 NFT 合约自身 emit，from/to/tokenId 均为事件参数，
 * 链上无法伪造——核验通过即链上事实（卖家确实把这批 NFT 转给了买家）。
 * BTY 兼容层收据同样适用（logs 结构与标准 EVM 一致；事件解析不依赖 receipt.to）。
 *
 * 标准匹配：按商品快照锁定的 nft_standard 选择事件签名解析（erc721：Transfer，
 * 兼容 ERC721A；erc1155：TransferSingle/TransferBatch）。标准与合约不符
 * （如申报 erc1155 但合约实为 ERC721）将解析不到任何事件而明确拒绝——
 * 错误信息指引核对商品 NFT 标准。
 *
 * 每件恰一份的集合语义：同 tokenId 多份场景不支持（ERC1155 value>1、
 * TransferBatch 中重复 id 累计 >1、同一收据重复转同 id）——统一在收集后
 * 按 tokenId 累计份数检查，任何 >1 即拒绝（本地池模型每 tokenId 一行 = 一份，
 * 无同 id 多份的库存/账目概念）。
 */
import { ethers } from 'ethers';
import { getProvider } from './chain.js';

/** ERC721 Transfer 事件（indexed from/to/tokenId 三段 topic） */
export const ERC721_ABI = ['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'];
export const erc721Iface = new ethers.Interface(ERC721_ABI);

/** ERC1155 转移事件（单枚 TransferSingle / 批量 TransferBatch，ids/values 数组） */
export const ERC1155_ABI = [
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
];
export const erc1155Iface = new ethers.Interface(ERC1155_ABI);

/** bigint/其他 → 十进制字符串 */
const dec = (v) => (typeof v === 'bigint' ? v.toString() : String(v ?? ''));

/** 按 tokenId 排序展示（错误信息可读性） */
const sortedIds = (ids) => [...ids].sort((a, b) => (BigInt(a) > BigInt(b) ? 1 : -1)).join('、');

/**
 * 在收据日志中集合核验 NFT 转账（纯函数，供单测覆盖）。
 * @param logs 收据 logs（ethers 日志数组）
 * @param nftContract NFT 合约地址（商品快照锁定值）
 * @param expected { standard: 'erc721'|'erc1155', from, to, tokenIds: string[] }
 * @returns { ok: true } 或 { ok: false, reason }
 */
export function matchNftTransfers(logs, nftContract, expected) {
  const contract = String(nftContract || '').toLowerCase();
  const from = String(expected.from || '').toLowerCase();
  const to = String(expected.to || '').toLowerCase();
  const standard = expected.standard === 'erc1155' ? 'erc1155' : 'erc721';
  const want = new Set((expected.tokenIds || []).map((t) => String(t)));
  if (!want.size) return { ok: false, reason: '申报集合为空，无法核验' };
  const iface = standard === 'erc1155' ? erc1155Iface : erc721Iface;

  // 收集该合约中 from=店主 to=买家 的转移（tokenId → 累计份数）；无关日志（mint、
  // 其他 from/to 的流转）直接跳过——同收据可能混有其他与本单无关的转移
  const collected = new Map();
  for (const log of logs || []) {
    if (String(log.address || '').toLowerCase() !== contract) continue;
    let parsed = null;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (standard === 'erc721') {
      if (parsed.name !== 'Transfer') continue;
      const a = parsed.args;
      if (String(a.from || '').toLowerCase() !== from || String(a.to || '').toLowerCase() !== to) continue;
      const id = dec(a.tokenId);
      collected.set(id, (collected.get(id) || 0n) + 1n);
    } else if (parsed.name === 'TransferSingle') {
      const a = parsed.args;
      if (String(a.from || '').toLowerCase() !== from || String(a.to || '').toLowerCase() !== to) continue;
      const id = dec(a.id);
      collected.set(id, (collected.get(id) || 0n) + BigInt(a.value));
    } else if (parsed.name === 'TransferBatch') {
      const a = parsed.args;
      if (String(a.from || '').toLowerCase() !== from || String(a.to || '').toLowerCase() !== to) continue;
      const ids = a.ids;
      // ethers Result 的 values 为内置属性（与事件参数同名冲突），须按位置索引（4）取批量数量数组
      const vals = a[4];
      if (!Array.isArray(ids) || !Array.isArray(vals) || ids.length !== vals.length) {
        return { ok: false, reason: 'ERC1155 批量转账日志异常（ids/values 长度不一致）' };
      }
      for (let i = 0; i < ids.length; i++) {
        const id = dec(ids[i]);
        collected.set(id, (collected.get(id) || 0n) + BigInt(vals[i]));
      }
    }
  }
  if (!collected.size) {
    const evt =
      standard === 'erc1155' ? 'ERC1155 TransferSingle/TransferBatch' : 'ERC721 Transfer';
    return {
      ok: false,
      reason: `该交易中未找到该 NFT 合约（${evt}）且转出方=店主、接收方=买家的转账事件——请核对合约地址、商品 NFT 标准（erc721/erc1155）与转账交易`,
    };
  }
  // 每件恰一份：**累计份数必须恰为 1**（>1 = 多份、=0 = 空转账）即拒绝
  //
  // 为什么 `0` 也必须拒（源码审计 2026-09 复审，P0）：ERC1155 的 `value=0` 转移是
  // **合法的空转账** —— OpenZeppelin 的 `_update` 对 value=0 不做余额检查（`fromBalance < 0`
  // 恒假）且照样 `emit TransferSingle`，所以店主可以在**任意** ERC1155 合约上（连这枚 NFT
  // 都不持有）调 `safeTransferFrom(店主, 买家, id, 0, '0x')`，拿它的收据来"交付"。
  // 而旧实现只拦 `> 1n`：`collected.set(id, 0n)` 既不过 over（0 > 1 为假）、
  // 又让 `collected.has(id)` 为真而不过 missing —— **两道检查同时放行**，
  // 买家什么都没收到却被标记"已发货"；若未在超时窗口内发起争议，
  // 链上 `OrderExpiredReleased` 会把托管款判给店主 —— 托管的"防不发货"整层被绕过。
  const wrong = [...collected].filter(([, v]) => v !== 1n);
  if (wrong.length) {
    const zero = wrong.filter(([, v]) => v === 0n).map(([id]) => id);
    const over = wrong.filter(([, v]) => v > 1n).map(([id]) => id);
    const parts = [];
    if (zero.length) {
      parts.push(
        `tokenId ${sortedIds(zero)} 的转移数量为 0——ERC1155 的 value=0 是空转账，**不构成交付**（该枚 NFT 并未转移，请核对本次转账交易）`
      );
    }
    if (over.length) {
      parts.push(
        `tokenId ${sortedIds(over)} 在交易中累计转出多份——同 tokenId 多份场景不支持，每份须独立 tokenId 恰一次（value=1 且不重复）`
      );
    }
    return { ok: false, reason: parts.join('；') };
  }
  // 申报集合 ⊆ 收集集合
  const missing = [...want].filter((t) => !collected.has(t));
  if (missing.length) {
    return {
      ok: false,
      reason: `交易中缺少申报 tokenId ${sortedIds(missing)} 的转移记录（已找到：${sortedIds([...collected.keys()]) || '无'}）——请核对转账内容与本单申报一致（可分批多哈希，或同哈希一次批量转多枚）`,
    };
  }
  return { ok: true };
}

/** 拉取收据并集合核验 NFT 转账（BTY/标准 EVM 通用）。返回同上。 */
export async function verifyNftTransfersTx(txHash, nftContract, expected) {
  let receipt = null;
  try {
    receipt = await getProvider().getTransactionReceipt(txHash);
  } catch {
    return { ok: false, reason: '链上查询失败，请稍后重试' };
  }
  if (!receipt) return { ok: false, reason: '链上暂未检索到该交易，请确认转账已打包上链' };
  return matchNftTransfers(receipt.logs, nftContract, expected);
}
