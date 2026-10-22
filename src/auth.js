/**
 * SIWE (EIP-4361) 签名认证 + 轻量 HMAC 会话令牌。
 *
 * SIWE（EIP-4361）流程（BTY 主网 chainId 2999 取硬编码常量，不信任客户端声明），
 * 差异：nonce 落库（`siwe` 表，无 Redis 依赖）；登录成功签发 HMAC 令牌，
 * 供商品上架/发货等写操作鉴权（Bearer header）。
 *
 * ## 登录是**节点级**的：一次登录，这个地址在本节点上被授权的信息全部可达
 *
 * 挑战的键就是**地址**（`siwe` 表没有 `shop_code` 列，见 db.js 的建表说明），
 * 令牌里也没有店铺声明。所以：
 *  1. GET  /api/auth/nonce?address=0x... -> { message }（含 nonce，存表，TTL）
 *  2. POST /api/auth/login {address, message, signature}
 *     -> 验签恢复地址 == 声明的 address；若 == node.owner 标记 isHost
 *     -> 返回 { token, address, isHost, shops }（`shops` = 这个地址能经营的店与各自角色）
 *
 * 旧形状把挑战槽位定成 `(address, shop_code)` 并给 `shop_code` 加外键指向 `shops(code)`——
 * 于是"为某个地址签发一条挑战"**只能发生在某家真实存在的店铺里**：一家店都还没有的节点
 * 连登录都发不出去，而"登录"这件事在语义上从来与某一家店无关（能经营哪些店是**授权**，
 * 由 `shops.seller` 与 `shop_operators` 回答，不是"你是谁"）。这正是本次要删掉的形状。
 *
 * 代价如实写：同一地址同一时刻只有一条挑战（不再是"每店一条"）。这本来就是 nonce 的语义
 * （一次性、短 TTL），而"切一家店要重新取挑战、令牌只在签发那家店有效"这一整类
 * 用户可见的怪现象随之消失。
 *
 * ## nonce 不得被未过期的新挑战顶掉（2026-09 修复，判据已下沉到语句里）
 *
 * 否则任何人对受害者地址 GET 一次 /nonce 就能顶掉其进行中的登录（受害者签名后回传必失败）。
 * 见 `issueSiwe`：判据在 `ON DUPLICATE KEY UPDATE` 的条件表达式里，与调用顺序无关。
 */
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { getDb } from './db.js';
import config, { resolveNodeDomain } from './config.js';
// 店铺行的唯一读入口（本文件不直接碰 shops 表：租户事实源只有 src/shops.js 一处）
import { shopRowByCode, nodeOwner, nodeRow, hostOperator } from './shops.js';
import { isNodeStaffOf, isProtocolGovernanceAddress, isForceClosedAddress, isValidContractSignature } from './chain.js';

// ── 店员白名单（`shop_operators`：**一行一人**）──
/*
  旧形状是 kv 里的一份 JSON 数组（键 `shop:<编号>:operators`），于是"加一个/删一个"是
  读-改-写：两个并发请求各自读到旧名单、各自写回，后写者把前者的改动整个盖掉——
  **被移除的店员仍然有权限，而且静默**。
  现在一行一人，增删各是一条语句，丢更新在形状上不可表达（见 db.js 的建表说明）。

  白名单**按店铺分**（列就是 shop_code，且有外键）：店员是"这家店授权他可以上架/发货"，
  而不是"他可以经营这台机器上的所有店"。单表时 A 店店员在 B 店同样是 staff——
  那是一份 B 店店主从未给过、也看不见、更撤不掉的授权。
*/

/** 某店的店员白名单（小写地址数组；网页增删，见 routes/shop.js PUT /staff） */
export async function getShopOperators(shopCode) {
  const code = String(shopCode || '');
  if (!code) return [];
  const rows = await getDb().all('SELECT address FROM shop_operators WHERE shop_code = ? ORDER BY address ASC', code);
  return rows.map((r) => String(r.address).toLowerCase());
}

/**
 * 该地址是不是这家店的店员（**鉴权路径专用**：存在性查询，不把整份名单读进内存）。
 * 每次请求都会走一次（`roleOf`），所以这里刻意是最便宜的那条语句。
 */
export async function isShopOperator(shopCode, address) {
  const code = String(shopCode || '');
  const addr = String(address || '').toLowerCase();
  if (!code || !addr) return false;
  const row = await getDb().get('SELECT 1 AS hit FROM shop_operators WHERE shop_code = ? AND address = ?', code, addr);
  return !!row;
}

/** 加入一名店员（幂等：已在名单里时那条语句自己什么都不改） */
export async function addShopOperator(shopCode, address) {
  await getDb().run(
    'INSERT INTO shop_operators (shop_code, address) VALUES (?, ?) ON DUPLICATE KEY UPDATE address = address',
    String(shopCode || ''),
    String(address || '').toLowerCase()
  );
}

/** 移除一名店员；返回是否真的移除了（false = 本来就不在名单里，调用方据此如实回话） */
export async function removeShopOperator(shopCode, address) {
  const { changes } = await getDb().run(
    'DELETE FROM shop_operators WHERE shop_code = ? AND address = ?',
    String(shopCode || ''),
    String(address || '').toLowerCase()
  );
  return changes === 1;
}

// SIWE 消息中的 Chain ID：谈信 H5 钱包 / BTY 主网固定 2999（EIP-4361 语义）
const SIWE_CHAIN_ID = 2999;

/**
 * 节点 SIWE 身份解析（2026-09 修复：登录签名原文不再硬编码 marketplace.local/http://localhost——
 * 原文身份应指向「本节点后端 API」，钱包弹窗据此可辨识、消息哈希随节点而异）。
 * 取值链（第一个非空生效）：
 *   1) MK_SIWE_DOMAIN：节点对外 API 域名（部署向导填写；可带协议，host[:port] 亦可）；
 *   2) MK_REGISTER_ENDPOINT：链上登记的节点 endpoint（本质即 API 根地址）；
 *      前两档的**解析只有一份**（`config.resolveNodeDomain()`）——节点没设置过名字时
 *      目录里显示的默认名读的也是它，两处各解析一次必然漂移成"钱包里一个域名、目录里另一个"；
 *   3) `node.owner`（同步投影 hostOperator）：店主地址小写——无域名的直连/内网部署以节点主地址
 *      为节点身份锚（0x+40hex 为合法 host 标签，消息可正常解析验签；钱包展示为地址串，可区分各节点）。
 * 每请求动态读取（env 变更即生效，测试可注入）。
 *
 * （2026-10-16 删掉"纯浏览模式节点回退 marketplace.local"那一档：`node.owner` 是 NOT NULL 的
 * 节点身份接线，缺它节点根本起不来（见 server.js 的启动门禁），所以"没有身份锚"不可达。
 * 留着那个占位常量只会让两个节点在钱包里显示成同一个域名。）
 */
export function resolveSiweIdentity() {
  // 1) 显式域名/登记端点优先（MK_SIWE_DOMAIN → MK_REGISTER_ENDPOINT）：
  //    解析的唯一实现在 `config.resolveNodeDomain()`（节点默认名读的是同一份，
  //    两处各写一遍迟早会出现"钱包弹窗一个域名、联邦目录另一个名字"）
  const identity = resolveNodeDomain();
  if (identity) return identity;
  // 2) 节点主地址兜底：0x+40hex 形态会被 WHATWG URL 解析器当作非法数字型 host 抛错，
  //    且地址本就是"节点身份锚"而非站点——直接构造 domain/URI，不经 URL 解析。
  //    取值走 `hostOperator()`（**`node.owner` 的同步投影**），不是配置里的那一份：
  //    配置只用来种那一行，读的时候只有一处真相（见 src/shops.js）。
  const owner = String(hostOperator() || '').trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(owner)) {
    return { domain: owner, uri: `https://${owner}/` };
  }
  /*
    两档都拿不到：只有"MK_SHOP_OWNER 配错了但节点还是起来了"才可能走到这里（启动门禁会先拦），
    所以这里**不编一个域名**（编出来的域名会让两台不同的节点在钱包弹窗里长得一样），
    而是让登录接口如实报错。
  */
  throw new Error('本节点没有可用的 SIWE 身份锚：MK_SIWE_DOMAIN 未配置，且 node.owner 不是合法地址');
}

/** RFC 3339 UTC 时间戳（EIP-4361 规范；严格 SIWE 库按 UTC 解析，带 Z 避免 +8 墙钟被误判超前 8h） */
function rfc3339Utc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildMessage(address) {
  // 节点场景以地址为准，验签不依赖域名；但签名原文身份（domain/URI）必须反映本节点
  // （见 resolveSiweIdentity——防统一占位文案掩盖跨店/仿冒 UI）
  const { domain, uri } = resolveSiweIdentity();
  const nonce = crypto.randomBytes(16).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.siwe.ttlSeconds * 1000);
  // 消息里给的是**秒级** RFC 3339 文本（EIP-4361 的 Expiration Time 形如 2026-10-16T05:31:24Z）
  const message =
    `${domain} wants you to sign in with your Ethereum account:\n` +
    `${address}\n\n` +
    `欢迎使用去中心化商城节点\n\n` +
    `URI: ${uri}\n` +
    `Version: 1\n` +
    `Chain ID: ${SIWE_CHAIN_ID}\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${rfc3339Utc(now.getTime())}\n` +
    `Expiration Time: ${rfc3339Utc(expiresAt.getTime())}`;
  return { message, nonce, expiresAt };
}

/**
 * 生成并存储 SIWE 原文（**一地址一条挑战**；槽位里已有未过期挑战时原样返回它）。
 *
 * 2026-09 修复（nonce 防覆盖 DoS）：未过期挑战不得被覆盖——否则任何人
 * 对受害者地址 GET /nonce 一次即可顶掉其进行中的登录（受害者钱包签名后回传必失败，
 * 需重新发起；重复触发即成骚扰型 DoS）。
 *
 * 2026-10 收口：判据从"先读再决定写不写"下沉到 `ON DUPLICATE KEY UPDATE` 里的条件表达式。
 * 旧形状是 check-then-act：两个并发请求都能读到"已过期"，后者把前者刚发出去的挑战顶掉，
 * 于是**同一条承诺在任何交错下都不成立**（只是窗口更小）。下沉之后"不覆盖未过期挑战"
 * 由那一条语句自己保证，与调用顺序无关。
 * 条件的方向（写反过，实测由验收脚本逮到）：**存活者优先**——那一行还没过期
 * （`siwe.expires_at > now`）就原样保留它，否则才换成本次生成的原文。
 * 代价：每次取 nonce 多一次回读（要返回**库里那一行**的字节，而不是本次生成的原文——
 * 返回一段没落库的原文，客户端拿到的报错会是"签名原文不匹配"，离真实原因很远）。
 *
 * ⚠️ 这里**不查任何店铺**：挑战与店铺无关，零店铺的节点也能正常签发（旧形状下这件事不可表达）。
 */
export async function issueSiwe(address) {
  const addr = String(address).toLowerCase();
  /*
    先读一次 `node` 行：签名原文的身份兜底要用节点主地址，而那份取值是 `node.owner` 的
    **同步投影**（见 shops.js 的 hostOperator）——这一次读顺带把它刷新到最新。
  */
  await nodeRow();
  const now = new Date();
  const { message, expiresAt } = buildMessage(addr);
  await getDb().run(
    `INSERT INTO siwe (address, message, expires_at) VALUES (?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE
         message    = IF(siwe.expires_at > ?, siwe.message, new.message),
         expires_at = IF(siwe.expires_at > ?, siwe.expires_at, new.expires_at)`,
    addr, message, expiresAt, now, now
  );
  const row = await getDb().get('SELECT message FROM siwe WHERE address = ?', addr);
  return row.message;
}

/**
 * 验证 SIWE 签名，成功返回恢复出的地址（校验 message 与地址匹配且未过期），
 * 并**一次性消费**该挑战：只有条件 DELETE 恰好命中 1 行才返回成功。
 */
export async function verifySiwe(address, message, signature) {
  const addr = String(address).toLowerCase();
  const now = new Date();
  const row = await getDb().get('SELECT message, expires_at FROM siwe WHERE address = ?', addr);
  if (!row) throw new Error('nonce 不存在，请重新获取签名原文');
  if (row.message !== message) throw new Error('签名原文不匹配，请重新获取');
  if (row.expires_at.getTime() < now.getTime()) throw new Error('签名原文已过期，请重新获取');

  /*
    EOA 走离线 ECDSA；合约账户走标准 1271 或 Safe legacy。
    EOA 的 personal_sign 签名是 `verifyMessage(message)`；标准 1271 对
    `hashMessage(message)` 验，Safe `signMessage(message)` 则要对 **message 原文** 走
    legacy bytes 重载。先试离线恢复，未命中再问 1271——普通钱包登录不依赖 RPC。
  */
  let recovered = '';
  try {
    recovered = ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    recovered = '';
  }
  if (recovered !== addr) {
    const ok = await isValidContractSignature(
      addr,
      ethers.toUtf8Bytes(message),
      ethers.hashMessage(message),
      signature
    );
    if (!ok) {
      if (!recovered) throw new Error('签名格式无效');
      throw new Error('签名地址与声明地址不一致');
    }
    recovered = addr;
  }

  /*
    一次性消费 = **条件 DELETE**，并要求恰好命中 1 行才签发令牌。
    旧形状是"先读、验签、再 DELETE"：两个并发登录携带**同一份签名**时都能通过读与验签、
    各自 DELETE 一次、各自拿到令牌——同一份签名换了两个会话，而"nonce 一次性"的全部意义
    就是它只能换一个。判据落在这条 DELETE 的 `changes` 上之后，"一份签名签出两个令牌"
    在形状上不可表达（调用方必须在拿到令牌之前看到这里的成功返回）。
    过期判据在 WHERE 里重复一遍（不是冗余）：从上面的读到这条 DELETE 之间可能跨过 TTL 边界，
    而"过期"与"已被用掉"对用户是同一句可自修的话。
  */
  const consumed = await getDb().run(
    'DELETE FROM siwe WHERE address = ? AND message = ? AND expires_at >= ?',
    addr, message, new Date()
  );
  if (consumed.changes !== 1) throw new Error('签名原文已被使用或已过期，请重新获取签名原文后再登录');
  return recovered;
}

/** 清理过期 nonce（登录成功会删当前行，此处兜底防表无限膨胀）。返回清理行数。 */
export async function cleanupExpiredSiwe(now = new Date()) {
  const { changes } = await getDb().run('DELETE FROM siwe WHERE expires_at < ?', now);
  return changes;
}

/**
 * 是否节点主本人（`node.owner`）——**独立判据**，不是"角色之一"。
 *
 * 为什么必须与 `roleOf` 分开：两种身份可以**同时**成立——节点主在自己那家店里既是节点主、
 * 又是那家店的店主（"自己那家店"与其他店在数据上没有区别，只是抽成被合约钉成 0；
 * 他甚至可能一家店都没有，而节点级动作照样要能做）。把两者塞进一个枚举里，就必然要选一个：
 *   · 短路成 host ⇒ 他在自己的店里被 `ownerOnly` 403（管不了自己的流水与设置）；
 *   · 短路成 owner ⇒ `hostOnly` 的节点级动作（开店申请队列）把他自己挡在门外。
 * 所以"是不是节点主"回答一个是非题，"在这家店里是什么角色"回答另一个，两者各自成判据。
 *
 * 异步的原因：节点主的家在 `node.owner`（单例行），而 `shops.host` 已随重设计删除——
 * 留一个同步的本地常量就是同一事实的第二份副本（副本漂移的症状是"节点主自己进不了节点级动作"）。
 */
export async function isHost(address, { force = false } = {}) {
  const addr = String(address || '').toLowerCase();
  const owner = await nodeOwner();
  if (!owner || addr !== owner) return false;
  /*
    forceCloseNode 后节点主本人也失去 host 权限：node.owner 是启动时从 env 载入的，
    不会随链上治理自动刷新；只比对字符串会让被撤销的节点主继续调用 hostOnly 的
    节点级 PII/审计入口。未接入 Registry 时 isForceClosedAddress 返回 false（能力未接入），
    配了但读不到返回 null —— 这里只认 false，读不到一律 fail-closed。
  */
  const closed = await isForceClosedAddress(owner, { force });
  return closed === false;
}

/**
 * 解析地址在**某家店**里的角色（**唯一判据**）：owner > staff > user。
 *
 * 为什么需要店铺维度：多店之前"是不是店主"是一次与全局常量的比较，谁都能算；
 * 多店之后同一台机器上有 N 个店主，而"他能不能动这家店"只有把地址与**那一行店铺**
 * 放在一起才能回答。判据留在这一处，其余地方（http 中间件、路由、审计）只消费结论。
 *
 * ⚠️ **节点主不在这里返回特权角色**：他拥有这台机器，但不因此拥有别家店的经营数据
 * （租户店铺的流水/订单/导出/擦除只有该店 seller 能读，见 http.js 的说明）。
 * 他在**自己那家店**里的身份就是 `owner`（那家店的 seller 正是他），不需要额外分支——
 * "节点主给自己开的那家店"与其他店在数据上没有任何区别，只是抽成被合约钉成 0。
 * 节点级动作用 `isHost` 单独判。
 *
 * `shopCode` 缺省（'' ）= 无店铺上下文 ⇒ 恒 `user`（调用方按"还没有店铺上下文"处理）。
 *
 * @param {{force?: boolean}} [opts] `force=true` 让**链上员工名单**跳过缓存重读（写请求与
 *   读 PII 的路径用）。店铺店主/店员那两层本来每次查库，没有缓存可绕。
 */
export async function roleOf(address, shopCode = '', { force = false } = {}) {
  const addr = String(address || '').toLowerCase();
  const code = String(shopCode ?? '');
  const row = await shopRowByCode(code);
  if (!row) return 'user';
  if (addr === String(row.seller || '').toLowerCase()) return 'owner';
  if (await isShopOperator(code, addr)) {
    /*
      **店员名单是链下事实，链上角色互斥看不到它**——所以这里每请求补一次链上判据：
        · `isProtocolGovernance`：当前届仲裁人、四个治理 owner（Escrow/Registry/Blocklist/Staking）
          都不能是店铺员工；
        · `isForceClosed`：被节点主**永久强制关闭**的员工同样不能继续经营（`_forceClose` 只清链上
          `staffNode`，清不到 `shop_operators`）。`isProtocolGovernance` 对被强制关闭的仲裁人
          已返回 false，所以不能拿它代替这一条。
      只在 `shop_operators` 命中时才多打 RPC（普通用户/店主路径不付这个成本）；
      写请求用 `force` 绕过 15s 缓存，读请求最多 15s 收敛。任一读不到（`null`）按 `user` 处理：
      宁可让店员重试，也不让一个无法确认身份的人拿到店员权限。
    */
    const [gov, forceClosed] = await Promise.all([
      isProtocolGovernanceAddress(addr, { force }),
      isForceClosedAddress(addr, { force }),
    ]);
    if (gov !== false || forceClosed !== false) return 'user';
    return 'staff';
  }
  /*
    **节点员工**在本节点**自营店**（seller == node.owner）里按 staff 处理（2026-10-18）。

    员工被授予的是"和节点主一样的运营权限"：审批开店、停用/恢复店铺、上架/下架商品。
    前两件是节点级动作（走 `isNodeAdmin`），第三件是店铺级动作，而员工不是任何一家店的
    `shop_operators` 成员——若不在这里给 staff，员工连"和节点主一样上架商品"都做不到。
    边界（刻意）：只对**自营店**生效。租户店的经营数据仍然只有该店店主/店员能碰——
    节点员工不是"这台机器上所有店的店员"，那是租户从未给过、也看不见的授权。
    节点主的**店主专属**权限（资金/设置/导出/擦除）也不在这里授予：员工拿到的只是 staff 档。
  */
  const owner = await nodeOwner();
  if (owner && String(row.seller || '').toLowerCase() === owner && (await isNodeStaffOf(addr, owner, { force }))) {
    /*
      与店铺员工同一道纵深：链上员工名单命中也必须再问一次治理身份**与强制关闭状态**。
      合约 setNodeStaff 已拒绝 current arbiter/owner，这里防的是缓存/链上状态被打破后
      "节点员工在自营店又拿到 staff 档"；`_forceClose` 清的是链上的 `staffNode` 行，但
      forceclose 之后到缓存失效前、或本地库另有残留时，这条路径仍可能命中旧读数——
      所以强制关闭必须**独立**再判一次。任一读不到 ⇒ user（fail-closed）。
    */
    const [gov, forceClosed] = await Promise.all([
      isProtocolGovernanceAddress(addr, { force }),
      isForceClosedAddress(addr, { force }),
    ]);
    return gov === false && forceClosed === false ? 'staff' : 'user';
  }
  return 'user';
}

/**
 * 是否**节点管理员**（节点主 ∪ 节点员工）：节点级端点（开店审批、节点资料、节点审计、
 * 保留期扫描、佣金对账）的唯一鉴权判据。员工与节点主同权限见 `chain.isNodeStaffOf`。
 *
 * 为什么员工名单不落库：员工要在**链上**签开店票据、停用店铺，链下名单授权不了那些交易；
 * 两份名单必然漂移（`staffNode` 是唯一事实源，节点只读、带 15s 缓存）。
 *
 * @param {{force?: boolean}} [opts] 写请求传 `force:true`：链上刚移除的员工不能靠缓存里的
 *   `true` 继续通过节点级鉴权。
 */
export async function isNodeAdmin(address, { force = false } = {}) {
  const addr = String(address || '').toLowerCase();
  const owner = await nodeOwner();
  if (!owner) return false;
  /*
    **节点主被强制关闭 ⇒ 整台节点的节点级权限失效**（fail-closed）：这是"这台机器不再被
    网络承认"在鉴权层的镜像；读不到也按否处理。节点主本人只在"未被关闭且确证"时才通过。
  */
  const hostForceClosed = await isForceClosedAddress(owner, { force });
  if (hostForceClosed !== false) return false;
  if (addr === owner) return true;
  /*
    员工：链上 `staffNode` 命中**还不够**——`_forceClose` 的语义是"这个人被强制解除"，
    而节点侧可能是缓存里的旧名单（15s）或本地库残留。被关闭/读不到一律不是管理员。
  */
  const [staff, staffForceClosed] = await Promise.all([
    isNodeStaffOf(addr, owner, { force }),
    isForceClosedAddress(addr, { force }),
  ]);
  return staff && staffForceClosed === false;
}

/**
 * 是否该店的经营人员（seller ∪ 该店店员白名单）。
 * **刻意不含 host**：节点主不是租户店铺的经营人员（他能做的只有"停用这家店"，
 * 那是治理动作，不走经营面）。他自己那家店的 seller 就是他，所以不受影响。
 */
export async function isStaff(address, shopCode = '', { force = false } = {}) {
  const role = await roleOf(address, shopCode, { force });
  return role === 'owner' || role === 'staff';
}

/**
 * 该地址在本节点**可以经营的店铺编号**（`shops.seller` ∪ `shop_operators.address`
 * ∪ 节点员工在其自营店里的 staff 档）。
 *
 * 这是**授权事实**，不是身份：令牌只说"这个地址登录了本节点"，"他能动哪几家店"每次都要
 * 回到这几张表/链上读数来问（店主换人、店员被移出、员工被解除后旧令牌立刻不越权）。
 *
 * **节点员工的本节点自营店（seller == node.owner）也算"可经营"**（2026-10-18）：
 * 员工被授予"和节点主一样的运营权限"，而自营店是节点主自己的店——员工在那家店里是 staff
 * （`roleOf` 同一判据）。这一条必须住在**本函数**里（而不是登录回执另补一次）：`X-Mk-Shop`
 * 的默认店铺选择（http.js 的 `soleOperatedShop`）与登录回执的 `shops[]` 都消费它，
 * 两处各补一次就会出现"登录看得见、鉴权选不中"或相反的漂移。
 * 边界（刻意）：只加**自营店**一家；租户店铺的经营数据仍只有该店店主/店员能碰。
 *
 * 为什么需要"一家都不止"这个读数：`X-Mk-Shop` 现在是**范围提示**，不是登录的前置条件。
 * 地址只经营一家店时那家店就是唯一可能的答案（不必要求带请求头）；经营多家时"哪一家"
 * 没有合理默认值——给一个默认会让请求方以为自己在动 A 店、实际动了 B 店，而所有写操作都
 * 成功、没有任何报错。所以中间件要能数出这个集合的大小。
 *
 * 两个 `=` 比较依赖"地址列一律小写落库"这条既有不变量（见 shops.js 的 shopRowBySeller 说明）；
 * 大小写不敏感的比较会让 `uq_shops_seller` 这一侧的索引失效，而每次卖家面请求都要走这里。
 */
export async function operatedShopCodes(address, { force = false } = {}) {
  const addr = String(address || '').toLowerCase();
  if (!addr) return [];
  /*
    `UNION`（不是 `UNION ALL`）是**判据的一部分**：同一个地址同时是某店的 seller 又被写进
    该店店员名单时，重复的一行会让"只经营一家店"被数成两家——于是那家店唯一的店主
    在没有请求头时反而收到"请指明哪一家"的 400。去重让"集合大小"就是能经营的店数。
    `ORDER BY code`：编号是链上铸造的，排序即登记顺序（同一份清单在登录回执里也稳定可读）。
  */
  const rows = await getDb().all(
    `SELECT code FROM (
       SELECT code FROM shops WHERE seller = ?
       UNION
       SELECT shop_code AS code FROM shop_operators WHERE address = ?
     ) AS operated ORDER BY code ASC`,
    addr,
    addr
  );
  const codes = rows.map((r) => String(r.code));
  /*
    节点员工 ↔ 自营店：员工名单的唯一事实源在链上（`Registry.staffNode`，15s 缓存），
    而"自营店"= `shops.seller == node.owner` 的那一行。读不到员工名单按"不是员工"处理
    （权限方向 fail-closed，见 `isNodeStaffOf`）。
    先查"节点主有没有开自营店"再问链：没有那家店时这个推断不可能改变结果，省掉每次
    卖家面请求的一次链上读（员工名单 15s 缓存之外的那一下）。
  */
  const owner = await nodeOwner();
  if (owner) {
    const own = await getDb().get('SELECT code FROM shops WHERE seller = ?', owner);
    if (own && (await isNodeStaffOf(addr, owner, { force }))) {
      const code = String(own.code);
      if (!codes.includes(code)) {
        codes.push(code);
        codes.sort();
      }
    }
  }
  return codes;
}

// ── HMAC 令牌 ──
function signPayload(payloadB64) {
  return crypto.createHmac('sha256', config.siwe.secret).update(payloadB64).digest('base64url');
}

/**
 * 签发令牌：base64url(JSON{address,exp}) . sig —— **令牌不携带任何店铺声明**。
 *
 * 它回答的唯一问题是"这个地址登录了本节点"。旧形状把"这次登录针对哪家店"（`code`）
 * 与当时的角色（`role`）签进令牌，于是令牌成了第二个授权事实源：它必须与请求头比对，
 * 前端也必须按店各存一份令牌。现在授权只有一个来源——`roleOf(address, shopCode)`
 * 每次按当前数据实时重算（见 http.js 的 makeAuthMiddleware，那里回答"这次请求动的是哪家店"）。
 * 删掉 `role` 是同一件事的另一半：没有店铺维度的角色没有意义，留着它只会让人以为
 * 服务端认这个快照。
 *
 * `exp` 是 **unix 秒（数字）**，不是时间戳列：令牌有效期是**时长**（`MK_TOKEN_TTL` 秒），
 * 与库里那些 `DATETIME(3)` 列无关——本仓"时间一律 Date"的口径针对的是**进 SQL 列的值**
 * 与**下发的报文**，令牌内部的过期判定是它自己的协议（与 SIWE 消息里的 RFC 3339 文本同理）。
 */
export function issueToken(address) {
  const payload = {
    address: address.toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + config.siwe.tokenTtlSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

/** 校验令牌；失败抛 Error，成功返回 {address, exp} */
export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw new Error('令牌格式无效');
  const [payloadB64, sig] = parts;
  const expect = signPayload(payloadB64);
  // 恒定时间比较
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('令牌签名无效');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('令牌已过期');
  return payload;
}
