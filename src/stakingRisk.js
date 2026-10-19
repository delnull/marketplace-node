/**
 * 质押跌破注册门槛的清单（治理/运维只读读数，2026-10 第二批）。
 *
 * 要回答的问题：**哪些已登记的店主，其保证金池已经低于 `Registry.minStakeToRegister`？**
 * 注册门槛（`_checkMinStake`）只在「注册 / 注销后重新激活 / 受让方接管」这三处校验，
 * 而池子里的钱会因为**罚没**（`Staking.penalize` 补偿买家）而下降——于是完全可能出现
 * "登记还在、门槛已经不满足"的状态：这家店继续接单，但真出事时保证金不够赔。
 * 联邦没有任何一处能自动发现它（合约不主动扫链、节点不主动读别家），所以需要一个只读读数。
 *
 * 事实源与取舍：
 *  - 门槛与"已登记"都从 **Registry** 读：`minStakeToRegister()`、`getActiveNodes()`
 *    （活跃登记集合）、以及 `stakingContract()`（门槛判定实际用的那个保证金合约地址）。
 *    **刻意不加 `MK_STAKING_ADDRESS` 环境变量**：门槛的判据链上是 `Registry.stakingContract`
 *    （owner 可改，且改门槛前必须先链接它），再配一个环境变量就是**第二个真相源**——
 *    配错/改链上地址后本地仍按旧地址算，读数会静默说谎。链上已经发布了权威地址，就用它。
 *  - 每读一个 operator 的 `Staking.poolOf(operator)`（= 质押 + 冷却中在担额，与注册门槛同口径）。
 *    成本 = 1 次 `getActiveNodes` + N 次 `poolOf`（N = 全网活跃店数）。N 大时逐次调用
 *    会明显变慢，所以：单次读数上限 `MAX_OPERATORS`（超出置 `truncated: true`，如实说明
 *    "只核了前 N 家"），结果 `TTL_MS` 内复用（同一个读数被面板/巡检脚本反复拉取时只打一轮 RPC）。
 *  - **降级取舍（如实写明）**：以上都读不到（未配 `MK_REGISTRY_ADDRESS`、RPC 不可达、合约未升级到
 *    有该函数的版本）时，返回 `available: false` + `reason`，**不下发任何"看起来像结论"的字段**
 *    ——"读不到"绝不能显示成"没有跌破门槛的店主"。调用方要自己比对时，`minStakeToRegisterWei`
 *    与每个 operator 的 `poolWei` 都在同一个响应里（两个数同源同刻，不会各说一套）。
 *  - 复算：本读数**完全由链上状态推出**（没有任何本地账参与），第三方可独立复算核对
 *    （`Registry.getActiveNodes()` 逐个 `Staking.poolOf`）。
 */
import { ethers } from 'ethers';
import config from './config.js';
import { getProvider, weiToDecimal } from './chain.js';

const REGISTRY_ABI = [
  'function minStakeToRegister() view returns (uint256)',
  'function stakingContract() view returns (address)',
  /*
    在册节点行（含 operator/endpoint/编号等）。**只声明本模块会读的那一个**（纪律同
    `Staking._probeEscrow`：探的/声明的必须是会调用的）。
    为什么不是 `getActiveNodes()`：那是一个"只返回地址数组"的读法，
    与 `getActiveNodes()` 的判据完全相同（同一份在册集合、同样剔除治理停用者），
    两份存在只会漂移；而 `MarketplaceRegistry` 贴着 EIP-170 的 24 576 字节上限，
    实测删掉它能省 368 字节（见合约里的说明）。这里取 `operator` 字段即可。
  */
  'function getActiveNodes() view returns (tuple(address operator, string endpoint, address escrowAddress, uint64 registeredAtBlock, uint64 updatedAtBlock, bool active, bool suspended, string code)[])',
];
const STAKING_ABI = ['function poolOf(address operator) view returns (uint256)'];

/** 读数缓存时长（与店铺编号同款思路）：阈值/池子都是低频变化量，面板轮询不该每次都打一轮 RPC */
const TTL_MS = 30_000;
/**
 * 单次读数最多核对的店主数（防"全网店数很大时一个匿名 GET 就打满 RPC 配额"）。
 * 超出部分如实标记 `truncated: true` —— 宁可说"没查完"，也不假装清单完整。
 */
const MAX_OPERATORS = 200;

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * 纯函数：给定 operator 列表、门槛与各自的池额 → 跌破门槛的清单（**不触链、可单测**）。
 *
 * @param {string[]} operators 活跃登记的店主地址
 * @param {string|bigint} minStakeWei 门槛（wei）
 * @param {Map<string, string|bigint>|Record<string, string|bigint>} pools operator(小写) → 池额
 * @returns {Array<{operator: string, poolWei: string, shortfallWei: string}>} 按缺口从大到小
 */
export function pickUnderStaked(operators, minStakeWei, pools) {
  const read = (k) => {
    if (pools instanceof Map) return pools.get(k);
    return pools?.[k];
  };
  /*
    门槛读不到/畸形时**不要**兜成 0：在这套语义里 `0` 等于"没有门槛"（合约语义），
    于是畸形值会被渲染成**"没有店跌破门槛"的假全清**。让 BigInt 直接抛出去，
    外层 catch 给出 available:false —— 读不到就说读不到，这是本文件自己立的规矩。
  */
  const min = BigInt(minStakeWei ?? 0);
  // 门槛为 0 时"跌破"不可能成立（合约语义：0 = 无门槛）：直接返回空清单，不去编造缺口
  if (min <= 0n) return [];
  const out = [];
  for (const op of operators || []) {
    const key = String(op || '').toLowerCase();
    if (!key) continue;
    /* 同上：脏池额**不许**按 0 报出去——那等于凭空指控这家店"池额 0"。
       抛给外层 ⇒ 整次读数 available:false（与同文件"不凭空指控"的口径一致）。 */
    const pool = BigInt(read(key) ?? 0);
    if (pool < min) out.push({ operator: key, poolWei: pool.toString(), shortfallWei: (min - pool).toString() });
  }
  // 缺口最大的排前面（运维先看最危险的那家）
  out.sort((a, b) => (BigInt(b.shortfallWei) > BigInt(a.shortfallWei) ? 1 : -1));
  return out;
}

/** 未配置/不可读时的统一形状（**不含 shortfall 字段**：读不到 ≠ 没有跌破门槛的店） */
function unavailable(reason) {
  return {
    available: false,
    reason,
    registryAddress: config.chain.registryAddress || null,
    stakingAddress: null,
    minStakeToRegisterWei: null,
    minStakeToRegisterDecimal: null,
    checked: 0,
    total: 0,
    truncated: false,
    shortfallCount: 0,
    shortfall: [],
    checkedAt: null,
  };
}

let cache = { at: 0, value: null };

/** 仅供测试：清空缓存 */
export function resetStakingRiskCache() {
  cache = { at: 0, value: null };
}

/**
 * 读取"跌破注册门槛"清单（带 30s 缓存；任何一步读不到都返回 available:false + reason）。
 * @param {{force?: boolean}} opts force = 忽略缓存（巡检脚本/测试用）
 */
export async function stakingShortfall({ force = false } = {}) {
  const registry = String(config.chain.registryAddress || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry)) {
    return unavailable('MK_REGISTRY_ADDRESS 未配置：无法读取注册门槛与已登记店主（本读数完全依赖链上状态）');
  }
  if (!force && cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const provider = getProvider();
    const reg = new ethers.Contract(registry, REGISTRY_ABI, provider);
    const [minRaw, stakingRaw, nodesRaw] = await Promise.all([
      reg.minStakeToRegister(),
      reg.stakingContract(),
      reg.getActiveNodes(),
    ]);
    const minStakeWei = BigInt(minRaw).toString();
    const stakingAddress = String(stakingRaw || '').toLowerCase();
    // 只取 operator 字段：本读数的判据是"谁在册"，行里其余字段与门槛无关
    const operators = (nodesRaw || [])
      .map((n) => String(n?.operator || '').toLowerCase())
      .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
    const truncated = operators.length > MAX_OPERATORS;
    const checked = operators.slice(0, MAX_OPERATORS);
    // 门槛为 0（默认）时无需再读池子：合约语义下"跌破"不成立
    if (BigInt(minStakeWei) <= 0n) {
      const value = {
        available: true,
        reason: null,
        registryAddress: registry,
        stakingAddress: stakingAddress === ZERO ? null : stakingAddress,
        minStakeToRegisterWei: minStakeWei,
        minStakeToRegisterDecimal: weiToDecimal(minStakeWei),
        checked: 0,
        total: operators.length,
        truncated,
        shortfallCount: 0,
        shortfall: [],
        checkedAt: Date.now(),
      };
      cache = { at: Date.now(), value };
      return value;
    }
    if (stakingAddress === ZERO) {
      // 门槛 >0 而保证金合约未链接：合约侧本身就不允许（setMinStakeToRegister 会 revert），
      // 真出现只说明这条链的配置不自洽——如实报"读不到判据"，不猜
      return unavailable('Registry 未链接保证金合约（stakingContract 为零地址），无法判定池额是否达标');
    }
    const staking = new ethers.Contract(stakingAddress, STAKING_ABI, provider);
    const pools = new Map();
    /*
      逐个读 poolOf。刻意**不**做并发上限之外的优化：ethers v6 会把同一 tick 发出的调用打包成
      一次 JSON-RPC 批量请求，所以这里的 Promise.all 在网络上是一次往返（受 batchMaxCount 约束，
      超出部分自动分批）——而 MAX_OPERATORS 已经把一批的上限钉住。
    */
    await Promise.all(
      checked.map(async (op) => {
        try {
          pools.set(op, BigInt(await staking.poolOf(op)).toString());
        } catch {
          // 单个 operator 读失败：不把它算作"跌破"（那会凭空指控一家店），也不静默吞掉——
          // 计入 checked 但池额缺失 ⇒ 该店不进清单；`reason` 里说明本轮有读失败的店。
          pools.set(op, null);
        }
      })
    );
    const failed = [...pools.values()].filter((v) => v === null).length;
    const under = pickUnderStaked(
      checked.filter((op) => pools.get(op) !== null),
      minStakeWei,
      pools
    );
    const value = {
      available: true,
      reason: failed > 0 ? `有 ${failed} 家店主的质押池读取失败（本轮未纳入清单，下轮重试）` : null,
      registryAddress: registry,
      stakingAddress,
      minStakeToRegisterWei: minStakeWei,
      minStakeToRegisterDecimal: weiToDecimal(minStakeWei),
      checked: checked.length,
      total: operators.length,
      truncated,
      shortfallCount: under.length,
      shortfall: under.map((u) => ({
        operator: u.operator,
        poolWei: u.poolWei,
        poolDecimal: weiToDecimal(u.poolWei),
        shortfallWei: u.shortfallWei,
        shortfallDecimal: weiToDecimal(u.shortfallWei),
      })),
      checkedAt: Date.now(),
    };
    cache = { at: Date.now(), value };
    return value;
  } catch (e) {
    // 读不到（RPC/ABI 不匹配）时**不写缓存**：下一轮请求立刻重试，而不是把失败钉住 30 秒
    console.warn('[stakingRisk] 质押门槛读数失败:', e?.message || e);
    return unavailable(`链上读取失败（RPC 不可达或合约未升级到含 minStakeToRegister/getActiveNodes 的版本）：${String(e?.message || e).slice(0, 160)}`);
  }
}
