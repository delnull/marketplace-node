/**
 * 资源状态：**唯一记住"这台机器是谁买的"的地方**。
 *
 * 为什么必须有：这个脚本的开头是"向服务商下单"——一次重跑就再买一台机器/再买一个域名。
 * 而现实里重跑是常态（SSH 断了、证书签发超时、用户手滑关了终端）。所以"这次要用的东西
 * 是不是已经买过了"必须能被回答，判据只能来自一份落盘的状态，不能来自"再调一次 API 猜"。
 *
 * 状态文件里**不存任何密钥**（AccessKey/SecretKey 只在内存里，从环境变量读）。
 * 但 SSH 私钥是个例外，它必须落盘：后续的 `verify` / `destroy` / 重跑都要用它连上那台机器。
 * 所以它单独放在 0600 的文件里，状态文件只记路径。
 */
import fs from 'node:fs';
import path from 'node:path';

export const STATE_VERSION = 1;

export function stateDir(root) {
  return path.join(root, '.provision');
}

/** 店铺名是唯一键：同机多店、多个域名各自一套状态，互不覆盖。 */
export function statePath(root, shop) {
  return path.join(stateDir(root), `${assertShop(shop)}.json`);
}

/**
 * 店铺名会**直接进文件名**（`.provision/<shop>.json`），所以它是唯一需要校验的输入：
 * `--shop ../../README` 这种值原本会让状态**写到仓库外面去**（`saveState` 是写文件的）。
 * 判据放在这里而不是 CLI：`statePath` 是所有读写的必经之处，校验落在这一层就挡住了全部入口
 * （saveState / loadState / destroy / verify 都走它）。
 */
function assertShop(shop) {
  const s = String(shop ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) || s.includes('..')) {
    throw new Error(
      `--shop 只能用小写字母/数字/点/下划线/短横线，且不能以点开头、不能含 ".."（收到：${JSON.stringify(shop)}）。\n` +
        '        它会直接进文件名（.provision/<shop>.json），所以不放行任何可能跳出这个目录的形状。'
    );
  }
  return s;
}

export function loadState(root, shop) {
  const p = statePath(root, shop);
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (raw.version !== STATE_VERSION) {
    throw new Error(
      `状态文件版本不符（${p} 里是 v${raw.version}，当前脚本是 v${STATE_VERSION}）。\n` +
        '本仓不做兼容读取：请删掉该文件重新部署，或用 `provision destroy --shop ' +
        shop +
        '` 先清掉旧资源。'
    );
  }
  return raw;
}

/** 原子写：先写临时文件再 rename —— 半截的 JSON 会让下次重跑直接解析失败。 */
export function saveState(root, shop, state) {
  const dir = stateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const p = statePath(root, shop);
  const next = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() };
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  return next;
}

/**
 * 空状态：**把这次要达成的形状先写清楚**，而不是每一步 `state.x = ...` 地长出来。
 * 后者的问题是"哪些字段本该有"没有一处说得出，漏写一个字段要等到用的时候才发现。
 */
export function newState({ shop, provider, providerLabel, region, domain, endpoint, owner }) {
  return {
    version: STATE_VERSION,
    shop,
    provider,
    providerLabel,
    region,
    domain,
    endpoint,
    owner,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    server: null, // { id, name, publicIp, privateIp, instanceType, imageId, zoneId? }
    dns: null, // { zoneId, zoneName, nameservers: string[], recordId }
    domainPurchase: null, // { bought, years, priceCny（闸门口径，元）, priceNative, currencyNative, taskId, ownedBefore }
    ssh: null, // { keyPath, keyId, user }
    // 实际写入方见 up.mjs 的 checkpoint：字段名是 `installDir`（旧注释写成 deployDir，已更正）
    node: null, // { runtime?, installDir, container, volume, tlsMode }
    verified: null, // { at, healthz, httpsOk }
  };
}
