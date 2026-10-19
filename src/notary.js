/**
 * 内容哈希规范（ReviewNotary 存证用）：
 *
 * **跨语言契约**（下面 7 个字段的顺序/类型与 `frontend/src/utils/notaryCore.ts` 的同一段逐字相同；
 * 改字段/顺序/类型必须同批改两侧，并同时更新两侧测试里的定点向量，否则任一侧都会红）：
 *
 *   DOMAIN    = keccak256(bytes("bityuan.fedmall.review-notary.v1"))        // bytes32
 *   preimage  = abi.encode(
 *     bytes32 DOMAIN,
 *     uint256 chainId,
 *     address registryAddress,
 *     string  orderId,
 *     string  kind,
 *     string  role,
 *     bytes32 sha256(bytes(content))
 *   )
 *   contentHash = keccak256(preimage)
 *
 * 为什么域必须在 preimage 里（源码审计 2026-10，P2）：orderId 是**本节点自编号**（`order_no`，
 * 形如 `B01M…`），跨节点不保证唯一；没有域时「另一个节点 / 另一套重部署的 ReviewNotary 上的
 * 同名单号 + 同样内容」会算出同一个 contentHash ⇒ 链上的存在性证明与前端"节点是否篡改"的
 * 对照都失去了作用域（一份存证可以被冒充成另一个合约/另一条链上的存证）。
 *
 * 为什么用 Registry 地址而不是 Notary 地址定"哪个联邦"：Registry 是该联邦的目录锚，
 * ReviewNotary 与它同批部署、地址一一对应，两者都足以定实例；而节点**刻意不读**
 * MK_NOTARY_ADDRESS（它是部署脚本做幂等跳过用的键，见 server.js 的废弃键告警），
 * 为域把它加回 config 等于反转那条决定。Registry 地址节点本来就配置（MK_REGISTRY_ADDRESS），
 * 语义也更贴切：这份存证属于"哪条链上的哪一个联邦"。DOMAIN 定协议版本，chainId 定链，
 * registryAddress 定联邦——三者合起来才是"这条哈希的户口"。
 * 代价：同一联邦内的两个节点仍可能撞单号；单号本身带毫秒前缀 + 随机后缀（21 字符），
 * 不属于本条要解决的跨联邦/跨链/重部署作用域问题。
 *
 * 为什么字段顺序是「定宽在前、变长在后」：bytes32/uint256/address 都是定宽，后面三个
 * string 带长度前缀（abi.encode，非 encodePacked），切分点唯一；旧实现用 encodePacked 直拼
 * 变长字段，`('AB','review',…)` 与 `('A','Breview',…)` 会撞出同一个哈希。
 *
 * 代价（如实写明）：**旧公式算出的哈希一律作废**。已经上链的旧存证无法与新哈希对上——
 * 这是有意的，不写双读/双算兼容路径；保留旧哈希等于把"跨节点可冒充"的洞继续留在链上。
 * 换链、换 Registry（= 另一个联邦）、升 DOMAIN 版本同样让存量存证失效，所以三者都不该随手改。
 *
 * 域从 `config.chain` 读（`chainId` / `registryAddress`）；读不到时**不计算**"没有域的哈希"，
 * 由 `contentHashOf` 返回带原因的 `{ hash: null, error }`，调用点把"无法计算"如实下发
 * （见 `routes/orders.js` 的 `contentHashError`）。
 */
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import config from './config.js';

export const CONTENT_HASH_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes('bityuan.fedmall.review-notary.v1'));

const sha256Hex = (text) => crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

/** 合约地址形状的唯一判据（与前端 `notaryCore.ts` 同一条正则） */
const CHAIN_ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * 内容哈希的域：哪条链上的哪个**联邦**（Registry 地址；ReviewNotary 与它同批部署）。
 * `registryAddress` 未配置时是 `undefined`/空串，由 `contentHashOf` 归成"无法计算"，
 * **不会**退化成无域公式。
 */
export function configNotaryDomain() {
  return { chainId: config.chain.chainId, registryAddress: config.chain.registryAddress };
}

/**
 * 域缺失时返回**带原因**的错误文案；返回 null = 域齐全。
 * 不抛异常：调用点要按两态处理（算出 / 无法计算），抛错会把一份辅助证明变成整个订单详情的 500。
 */
export function contentHashDomainErrorOf(domain) {
  const chainId = Number(domain?.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) return '这份存证无法计算（未配置 chainId）';
  if (!CHAIN_ADDRESS_SHAPE.test(String(domain?.registryAddress ?? ''))) {
    return '这份存证无法计算（未配置联邦目录合约地址 MK_REGISTRY_ADDRESS）';
  }
  return null;
}

/**
 * 内容哈希。返回值恒为 `{ hash: string|null, error: string|null }` 两态之一：
 *   · 域齐全 ⇒ `{ hash, error: null }`；
 *   · 域缺失 ⇒ `{ hash: null, error: '这份存证无法计算（未配置 …）' }`。
 * 调用点只允许把 `hash` 下发给前端对照，`error` 一并下发——不能把 null 说成"哈希为空"。
 */
export function contentHashOf(domain, orderId, kind, role, content) {
  const error = contentHashDomainErrorOf(domain);
  if (error) return { hash: null, error };
  // sha256 32B → bytes32；abi.encode 定界编码（变长字段带长度前缀，杜绝拼接歧义）
  const inner = `0x${sha256Hex(content)}`;
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'address', 'string', 'string', 'string', 'bytes32'],
    [
      CONTENT_HASH_DOMAIN,
      Number(domain.chainId),
      String(domain.registryAddress).toLowerCase(),
      String(orderId ?? ''),
      String(kind ?? ''),
      String(role ?? ''),
      inner,
    ]
  );
  return { hash: ethers.keccak256(encoded), error: null };
}

/** 买家评价内容哈希（kind='review'） */
export function reviewContentHash(domain, orderId, content) {
  return contentHashOf(domain, orderId, 'review', 'buyer', content);
}

/** 争议陈述内容哈希（kind='evidence'；role 取实际提交角色） */
export function evidenceContentHash(domain, orderId, role, content) {
  return contentHashOf(domain, orderId, 'evidence', role === 'seller' ? 'seller' : 'buyer', content);
}
