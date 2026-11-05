/**
 * 待审批的撤资申请（节点主视图，`GET /api/shop/staking/requests`）。
 *
 * 为什么需要它：`Staking` 没有"列出所有 pending"的读法（pending 在 mapping 里），
 * 节点也没有索引 `UnstakeRequested` 事件。于是店主申请撤资后，节点主只能等对方
 * 线下告知地址，再手填进「管理卖家保证金」——这是这条资金路径上唯一的断点。
 *
 * 这里换一个不依赖事件历史的口径：节点知道自己名下所有店铺的 `seller`，
 * 逐个读 `Staking.unstakeState(seller)`，`pending > 0` 的就是待办。
 *   · 不依赖事件扫描 ⇒ 重启、换 RPC、超出回看窗口都不会漏；
 *   · 代价是每个 seller 一次 `eth_call`（按店铺数量，通常几十个），30 秒记忆化；
 *   · 单个地址读失败**不假装它没有申请**：返回 `partial: true` + `failed` 计数，
 *     界面必须显示"有 N 个地址没读到，列表可能不完整"（三态纪律）。
 */
import { ethers } from 'ethers';
import config from './config.js';
import { getProvider, isAddress } from './chain.js';
import { getDb } from './db.js';

const ABI = [
  'function unstakeState(address operator) view returns (uint256 pending, uint64 releaseAt, bool approved, bool autoApproveArmed, uint256 autoApproveAt)',
  /* 批准还要过冻结/出金下限；只看 releaseAt 会让队列把“冻着/低于下限”的地址也标成可批准 */
  'function unstakeGate(address operator) view returns (bool canRequest, bool canApprove, string reason)',
];

/** 池额/申请都是低频变化量；审批面板打开时拉一次，30 秒内不重复打 RPC */
const TTL_MS = 30_000;
/** 店铺数量上限：再多的节点也不该在一次请求里打几千个 eth_call */
const MAX_SELLERS = 500;
/** 并发上限：一次 8 个 eth_call，避免把节点 RPC 打满 */
const CONCURRENCY = 8;

let cache = { at: 0, key: '', value: null };

function unavailable(reason) {
  return {
    available: false,
    reason,
    stakingAddress: config.chain.stakingAddress || null,
    requests: [],
    checkedAt: null,
    partial: false,
    failed: 0,
  };
}

/**
 * @returns {Promise<{
 *   available: boolean,
 *   reason?: string,
 *   stakingAddress: string|null,
 *   requests: { seller: string, pendingWei: string, releaseAt: number, ready: boolean,
 *               blockReason: string, autoApproveArmed: boolean, autoApproveAt: number }[],
 *   checkedAt: string|null,
 *   partial: boolean,
 *   failed: number,
 * }>}
 */
export async function pendingUnstakeRequests() {
  const staking = String(config.chain.stakingAddress || '').toLowerCase();
  if (!staking) return unavailable('未配置 Staking 合约（MK_STAKING_ADDRESS）');
  if (cache.value && cache.key === staking && Date.now() - cache.at < TTL_MS) return cache.value;

  let sellers;
  try {
    const rows = await getDb().all('SELECT DISTINCT seller FROM shops ORDER BY seller LIMIT ?', MAX_SELLERS);
    sellers = [...new Set(rows.map((r) => String(r.seller || '').toLowerCase()).filter(isAddress))];
  } catch (e) {
    return unavailable(`店铺列表读取失败：${e?.message || e}`);
  }

  const c = new ethers.Contract(staking, ABI, getProvider());
  const requests = [];
  let failed = 0;
  const nowSec = Math.floor(Date.now() / 1000);

  for (let i = 0; i < sellers.length; i += CONCURRENCY) {
    const part = sellers.slice(i, i + CONCURRENCY);
    await Promise.all(
      part.map(async (seller) => {
        try {
          const [s, gate] = await Promise.all([c.unstakeState(seller), c.unstakeGate(seller)]);
          const pending = BigInt(s.pending ?? s[0] ?? 0);
          if (pending <= 0n) return;
          const releaseAt = Number(s.releaseAt ?? s[1] ?? 0);
          const canApprove = Boolean(gate.canApprove ?? gate[1]);
          requests.push({
            seller,
            pendingWei: pending.toString(),
            releaseAt,
            ready: releaseAt > 0 && nowSec >= releaseAt && canApprove,
            /** 冷却已满但仍不可批准的原因（冻着 / 低于出金下限 / 其它链上闸门） */
            blockReason:
              releaseAt > 0 && nowSec >= releaseAt && !canApprove
                ? String(gate.reason ?? gate[2] ?? '').trim() || 'blocked'
                : '',
            autoApproveArmed: Boolean(s.autoApproveArmed ?? s[3]),
            autoApproveAt: Number(s.autoApproveAt ?? s[4] ?? 0),
          });
        } catch {
          failed += 1;
        }
      })
    );
  }

  requests.sort((a, b) => a.releaseAt - b.releaseAt || a.seller.localeCompare(b.seller));
  const value = {
    available: true,
    stakingAddress: staking,
    requests,
    checkedAt: new Date().toISOString(),
    partial: failed > 0,
    failed,
  };
  cache = { at: Date.now(), key: staking, value };
  return value;
}
