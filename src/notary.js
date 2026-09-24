/**
 * 内容哈希规范（docs/ARCHITECTURE.md §2.3）：
 *   contentHash = keccak256(abi.encode(orderId, kind, role, sha256(bytes(content))))
 * 由当事人/节点/第三方按同一公式计算，供 ReviewNotary 合约存证（存在性 + 时间戳证明，
 * 防节点事后删改评价/证据）。kind：'review'（买家评价，role='buyer'）/ 'evidence'（争议陈述）。
 *
 * 为什么是 abi.encode 而不是 encodePacked（源码审计 2026-09 修复）：三个变长字段直接拼接
 * 存在「移动切分点」歧义——`('AB','review','buyer',c)` 与 `('A','Breview','buyer',c)` 会算出
 * **同一个哈希**，于是链上已存证的哈希可被张冠李戴到另一个订单/类型（存证的证明力被架空）。
 * abi.encode 给每个变长字段加长度前缀，歧义消除。前端 `utils/notary.ts` 必须同步改（同公式）。
 */
import crypto from 'node:crypto';
import { ethers } from 'ethers';

const sha256Hex = (text) => crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

export function contentHash(orderId, kind, role, content) {
  // sha256 32B → bytes32；abi.encode 定界编码（变长字段带长度前缀，杜绝拼接歧义）
  const inner = `0x${sha256Hex(content)}`;
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['string', 'string', 'string', 'bytes32'],
    [String(orderId ?? ''), String(kind ?? ''), String(role ?? ''), inner]
  );
  return ethers.keccak256(encoded);
}

/** 买家评价内容哈希（kind='review'） */
export function reviewContentHash(orderId, content) {
  return contentHash(orderId, 'review', 'buyer', content);
}

/** 争议陈述内容哈希（kind='evidence'；role 取实际提交角色） */
export function evidenceContentHash(orderId, role, content) {
  return contentHash(orderId, 'evidence', role === 'seller' ? 'seller' : 'buyer', content);
}
