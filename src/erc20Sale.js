/**
 * ERC20 商品：合约识别与交付收据核验（方案 A：卖家转币 + 节点核对 Transfer）。
 *
 * BTY 的 EVM 交易会同时存在 Chain33 哈希与 EVM 哈希（浏览器两个哈希都能查到同一笔交易）。
 * 卖家提交任一哈希；这里先查回执，再用交易对象拿到**回执的 canonical 哈希**，
 * 交付记录按 canonical 哈希去重，避免同一笔转账被两个订单各认领一次。
 */
import { Contract, isAddress } from 'ethers';
import { getProvider, rpcRequest } from './chain.js';

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** 带超时的 Promise（RPC 挂起必须失败，不能把请求线程挂死） */
function timeout(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * 校验商家填的地址是**可识别 ERC20 合约**：有代码，且 decimals/symbol 读得出来。
 * 允许任意 ERC20（不做白名单）；只把"不是合约 / 不是标准 ERC20"挡在上架阶段。
 * @returns {Promise<{ok:true, contract:string, decimals:number, symbol:string} | {ok:false, retryable:boolean, reason:string}>}
 */
export async function checkErc20Contract(address) {
  const contract = String(address || '').trim().toLowerCase();
  if (!isAddress(contract)) return { ok: false, retryable: false, reason: 'ERC20 合约地址非法（需 0x 开头的 40 位十六进制）' };
  const provider = getProvider();
  let code;
  try {
    code = await Promise.race([provider.getCode(contract), timeout(8_000, '读取合约代码超时')]);
  } catch (e) {
    console.error('[erc20Sale] 读取合约代码失败：', e?.message || e);
    return { ok: false, retryable: true, reason: `读不到合约代码（链上节点读取失败），请核对合约地址与节点配置` };
  }
  if (!code || code === '0x') return { ok: false, retryable: false, reason: '该地址没有合约代码，不是 ERC20 合约' };
  const token = new Contract(contract, ERC20_ABI, provider);
  let decimals;
  let symbol;
  try {
    [decimals, symbol] = await Promise.race([
      Promise.all([token.decimals(), token.symbol()]),
      timeout(8_000, '读取 ERC20 元数据超时'),
    ]);
  } catch (e) {
    console.error('[erc20Sale] 读取代币元数据失败：', e?.message || e);
    return {
      ok: false,
      retryable: true,
      reason: `该合约没有返回标准代币的小数位与符号，请核对合约地址`,
    };
  }
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 36) {
    return { ok: false, retryable: false, reason: `代币小数位非法（${String(decimals)}，需 0 到 36）` };
  }
  const s = String(symbol || '').trim();
  if (!s || s.length > 32) return { ok: false, retryable: false, reason: '代币符号为空或超过 32 个字符' };
  return { ok: true, contract, decimals: d, symbol: s };
}

/** 把一个 BTY/Chain33 或 EVM 交易哈希解析成回执 + canonical 哈希。 */
export async function resolveTxReceipt(txHash) {
  const input = String(txHash || '').trim().toLowerCase();
  if (!TX_HASH_RE.test(input)) return { ok: false, notFound: true, reason: '交易哈希格式非法（需 0x 开头的 64 位十六进制）' };
  let receipt;
  try {
    receipt = await rpcRequest('eth_getTransactionReceipt', [input], { timeoutMs: 15_000 });
  } catch (e) {
    return { ok: false, retryable: true, reason: `查询交易回执失败：${String(e?.message || e).slice(0, 120)}` };
  }
  if (!receipt) {
    // BTY 的另一个哈希：用交易对象反查 canonical hash，再取回执。
    let tx;
    try {
      tx = await rpcRequest('eth_getTransactionByHash', [input], { timeoutMs: 15_000 });
    } catch (e) {
      return { ok: false, retryable: true, reason: `查询交易对象失败：${String(e?.message || e).slice(0, 120)}` };
    }
    const canonical = String(tx?.hash || '').toLowerCase();
    if (canonical && canonical !== input) {
      try {
        receipt = await rpcRequest('eth_getTransactionReceipt', [canonical], { timeoutMs: 15_000 });
      } catch (e) {
        return { ok: false, retryable: true, reason: `查询交易回执失败：${String(e?.message || e).slice(0, 120)}` };
      }
    }
  }
  if (!receipt) return { ok: false, notFound: true, reason: '交易不存在或尚未上链' };
  const canonical = String(receipt.transactionHash || receipt.hash || input).toLowerCase();
  if (!TX_HASH_RE.test(canonical)) return { ok: false, retryable: true, reason: '回执缺少有效的交易哈希' };
  const blockNumber = Number(receipt.blockNumber);
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) return { ok: false, retryable: true, reason: '回执缺少有效区块高度（可能尚未确认）' };
  return { ok: true, receipt, canonical, input, blockNumber };
}

/**
 * 核验一笔卖家→买家的 ERC20 Transfer。
 * 返回 `{ok:true, txHash, inputHash, blockNumber, amount}`；amount 为 raw uint256 十进制字符串。
 */
export async function verifyErc20Transfer(txHash, { token, from, to }) {
  const contract = String(token || '').trim().toLowerCase();
  if (!isAddress(contract)) return { ok: false, reason: '商品快照缺少合法的 ERC20 合约地址' };
  const got = await resolveTxReceipt(txHash);
  if (!got.ok) return got;
  const status = got.receipt.status;
  const success = status === true || Number(status) === 1 || String(status).toLowerCase() === '0x1';
  if (!success) return { ok: false, retryable: false, reason: '该交易执行失败（未成功）' };

  const fromTopic = `0x${String(from).toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const toTopic = `0x${String(to).toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  let amount = 0n;
  for (const log of Array.isArray(got.receipt.logs) ? got.receipt.logs : []) {
    if (String(log?.address || '').toLowerCase() !== contract) continue;
    const topics = Array.isArray(log?.topics) ? log.topics.map((t) => String(t).toLowerCase()) : [];
    if (topics[0] !== TRANSFER_TOPIC) continue;
    if (topics[1] !== fromTopic || topics[2] !== toTopic) continue;
    const data = String(log?.data || '0x');
    if (!/^0x[0-9a-fA-F]*$/.test(data) || data === '0x') continue;
    amount += BigInt(data);
  }
  if (amount <= 0n) {
    return {
      ok: false,
      retryable: false,
      reason: `收据里没有该 ERC20 从卖家转到买家的转账记录`,
    };
  }
  return {
    ok: true,
    txHash: got.canonical,
    inputHash: got.input,
    blockNumber: got.blockNumber,
    amount: amount.toString(),
  };
}
