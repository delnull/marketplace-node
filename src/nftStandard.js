/**
 * NFT 合约标准检测（发布/编辑商品时的前置校验）。
 *
 * 判据是 ERC165 `supportsInterface`：
 *   · ERC721  = 0x80ac58cd（ERC721A 也实现 ERC165，走同一个接口）
 *   · ERC1155 = 0xd9b67a26
 *
 * 为什么不能只信商品表单里的下拉框：标准决定交付时按哪套 Transfer 事件核验。
 * 卖家把 ERC1155 选成 ERC721 时，商品仍能上架、买家仍能付款，直到交付核验
 * 找不到对应事件才失败——那时资金已经在托管里。发布时先拒绝这个错配。
 *
 * 失败语义：
 * - 无代码、未实现 ERC165、两个接口都声明/都不声明 ⇒ 不可判定（4xx，用户换合约）；
 * - RPC 超时/不可达 ⇒ `retryable: true`，路由按 503 让用户稍后重试，不写半成品。
 * 链上 `supportsInterface` 仍可被恶意合约撒谎；交付事件核验才是最终判据。这里是
 * “发布期尽早发现错配”，不是替代交付核验。
 */
import { ethers } from 'ethers';
import { getProvider } from './chain.js';

export const ERC721_INTERFACE_ID = '0x80ac58cd';
export const ERC1155_INTERFACE_ID = '0xd9b67a26';
const ERC165_INTERFACE_ID = '0x01ffc9a7';
const SUPPORTS_ABI = ['function supportsInterface(bytes4 interfaceId) view returns (bool)'];
const RPC_TIMEOUT_MS = 8_000;
const PROBE_WINDOW_MS = 60_000;
const PROBE_MAX_PER_WINDOW = 20;
const PREVIEW_MAX_PER_WINDOW = 10;
const DETECTION_TTL_MS = 5 * 60_000;

const probeBudget = {
  write: { start: 0, count: 0, max: PROBE_MAX_PER_WINDOW },
  preview: { start: 0, count: 0, max: PREVIEW_MAX_PER_WINDOW },
};
/** contract(lower) -> { at, result }；标准只随合约代码变，短 TTL 同时挡住代理升级。 */
const detectionCache = new Map();
const DETECTION_CACHE_MAX = 500;

/**
 * 链上标准探测是共享 provider 上的 4 次读；商品写入口是 staff 可控的。
 * 在**唯一探测点**做进程内预算，而不是给每个路由复制一份限流：watcher/对账也用同一个
 * provider，不能让一次商品写循环把它拖住。测试注入的 `_check` 不走这里。
 *
 * 预检与发布使用**两个独立桶**：失焦预检不能耗尽发布额度（否则一个只读入口
 * 可以拒绝真实上架）；两者共享合约级检测缓存。
 */
function takeProbeBudget(kind = 'write') {
  const b = probeBudget[kind] || probeBudget.write;
  const now = Date.now();
  if (now - b.start >= PROBE_WINDOW_MS) {
    b.start = now;
    b.count = 0;
  }
  if (b.count >= b.max) return false;
  b.count += 1;
  return true;
}

let _check = null;

/**
 * 测试注入点：生产默认走 `detectNftStandard`。
 * 测试夹具默认把“声明值”当检测结果，避免所有商品用例依赖真实 RPC；
 * 专门测检测的用例用 `setNftStandardCheck(null)` 恢复真实实现或注入假 provider。
 */
export function setNftStandardCheck(fn) {
  _check = fn || null;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`NFT standard RPC timeout > ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function messageOf(e) {
  return String(e?.shortMessage || e?.message || e || '');
}

/** 合约 revert（没有这个函数 / 标准不支持）不是 RPC 故障；超时/网络错误才可重试 */
function isRevertError(e) {
  const text = `${String(e?.code || '')} ${messageOf(e)}`;
  return /CALL_EXCEPTION|BAD_DATA|EXECUTION_REVERTED|revert|invalid opcode/i.test(text);
}

/**
 * 直接读合约标准；`reader` 仅用于单测注入（`{interfaceId} => Promise<boolean>`）。
 *
 * @returns {Promise<{ok:true, standard:'erc721'|'erc1155'} |
 *   {ok:false, reason:string, retryable:boolean}>}
 */
export async function detectNftStandard(contract, { reader = null, provider = null } = {}) {
  const c = String(contract || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(c) || /^0x0{40}$/.test(c)) {
    return { ok: false, retryable: false, reason: 'NFT 商品需填写合法的合约地址（0x + 40 位十六进制，且不能为全零）' };
  }

  let supports;
  if (typeof reader === 'function') {
    supports = reader;
  } else {
    let p;
    try {
      p = provider || getProvider();
    } catch (e) {
      return { ok: false, retryable: true, reason: `读取 NFT 合约标准失败：${messageOf(e) || 'RPC 未配置'}` };
    }
    try {
      const code = await withTimeout(p.getCode(c), RPC_TIMEOUT_MS);
      if (!code || code === '0x') {
        return { ok: false, retryable: false, reason: `NFT 合约地址 ${c} 在当前链上没有代码——请核对地址与网络` };
      }
    } catch (e) {
      return { ok: false, retryable: true, reason: `读取 NFT 合约代码失败：${messageOf(e) || 'RPC 不可达'}` };
    }
    const contractReader = new ethers.Contract(c, SUPPORTS_ABI, p);
    supports = (interfaceId) => withTimeout(contractReader.supportsInterface(interfaceId), RPC_TIMEOUT_MS);
  }

  let is165 = null;
  let is721 = false;
  let is1155 = false;
  let supportError = null;
  try {
    is165 = !!(await supports(ERC165_INTERFACE_ID));
  } catch (e) {
    supportError = e;
    // 不实现 ERC165 的合约在这里就会 revert；先不立刻下结论，下面仍尝试两个标准接口
  }
  try {
    is721 = !!(await supports(ERC721_INTERFACE_ID));
  } catch (e) {
    supportError = supportError || e;
    is721 = false;
  }
  try {
    is1155 = !!(await supports(ERC1155_INTERFACE_ID));
  } catch (e) {
    supportError = supportError || e;
    is1155 = false;
  }

  if (is721 && is1155) {
    return { ok: false, retryable: false, reason: '该合约同时声明 ERC721 与 ERC1155 接口，无法唯一判定；请换用标准明确的合约' };
  }
  if (is721) return { ok: true, standard: 'erc721' };
  if (is1155) return { ok: true, standard: 'erc1155' };
  if (supportError && !isRevertError(supportError)) {
    return { ok: false, retryable: true, reason: `读取 NFT 合约标准失败：${messageOf(supportError)}` };
  }
  if (is165 === false) {
    return {
      ok: false,
      retryable: false,
      reason: '该合约未实现 ERC165（supportsInterface），无法确认是 ERC721 还是 ERC1155',
    };
  }
  return {
    ok: false,
    retryable: false,
    reason: '该合约未声明 ERC721（0x80ac58cd）或 ERC1155（0xd9b67a26）接口——请核对合约地址与标准',
  };
}

/**
 * 检测并核对卖家声明。`declared` 非法时也明确拒绝，不把“声明错”交给后面的
 * 交付核验才暴露。
 */
export async function checkNftStandard(contract, declared, opts = {}) {
  if (_check) return await _check({ contract, declared });
  const d = String(declared || '').trim().toLowerCase();
  if (d !== 'erc721' && d !== 'erc1155') {
    return { ok: false, retryable: false, reason: 'NFT 标准必须选择 erc721 或 erc1155' };
  }
  const key = String(contract || '').trim().toLowerCase();
  if (!opts.reader && !opts.provider) {
    const hit = detectionCache.get(key);
    if (hit && Date.now() - hit.at < DETECTION_TTL_MS) return finishCheck(hit.result, d);
  }
  if (!takeProbeBudget(opts.budget === 'preview' ? 'preview' : 'write')) {
    return { ok: false, retryable: true, reason: 'NFT 合约核验过于频繁，请稍后重试' };
  }
  const detected = await detectNftStandard(contract, opts);
  if (detected.ok) {
    if (detectionCache.size >= DETECTION_CACHE_MAX) {
      const oldest = detectionCache.keys().next().value;
      if (oldest !== undefined) detectionCache.delete(oldest);
    }
    detectionCache.set(key, { at: Date.now(), result: detected });
  }
  return finishCheck(detected, d);
}

/** 把“实际标准”与卖家声明对齐；检测缓存命中时也走同一处，避免两条判据。 */
function finishCheck(detected, declared) {
  if (!detected.ok) return detected;
  if (detected.standard !== declared) {
    return {
      ok: false,
      retryable: false,
      standard: detected.standard,
      reason: `该合约实际为 ${detected.standard.toUpperCase()}，与选择的 ${declared.toUpperCase()} 不一致——请按合约实际标准重新选择`,
    };
  }
  return { ok: true, standard: detected.standard };
}
