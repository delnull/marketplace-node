/**
 * 释放：把这次买的东西拆掉。
 *
 * 为什么必须有：这个流程会**按小时计费地**开一台机器。没有一键释放的部署脚本等于
 * "用户忘了就等于一直扣钱"——那是把成本挂在了"人记得"这个维度上（本仓最忌讳的形状）。
 *
 * 三条刻意的取舍：
 *   1. **默认保留域名**：域名是年付的、注册后 60 天内不能转出（ICANN 规则），
 *      删解析区也不会退钱。所以"释放"只释放**按量计费**的那部分。
 *   2. **数据必须先导出**：商品/订单/附件只活在那台机器的数据卷里，删机器 = 数据没了。
 *      所以默认**先试着导出**（docker 还在的话），导出成功才继续；导不出就明确告诉你，
 *      并要求 `--i-know-data-is-lost` 才继续删。
 *   3. **不删安全组/密钥对/域名**：它们不产生费用（或已付费），而删掉不可逆；
 *      留下的东西在 check 里看得见，用户想清可以自己去控制台。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadState, saveState, stateDir } from './state.mjs';
import { bashScript, run } from './ssh.mjs';
import { loadProvider } from '../providers/index.mjs';
import { ensureCreds } from './creds.mjs';

/**
 * @param {object} o
 * @param {object} o.options CLI 选项（shop / iKnowDataIsLost / …）
 * @param {string} o.repoRoot
 * @param {(m:string)=>void} o.log
 * @param {object} [o.io] 外部世界注入点（测试用）：{ run, loadProvider }。默认就是真的那一套。
 */
export async function destroy({ options: o, repoRoot, log, io = {} }) {
  const { run: sshRun = run, loadProvider: loadProv = loadProvider, ensureCreds: credsFn = ensureCreds } = io;
  const st = loadState(repoRoot, o.shop);
  if (!st) throw Object.assign(new Error(`没有状态文件（--shop ${o.shop}）—— 没有本工具创建的东西可释放`), { gate: true });
  if (!st.server) {
    log('状态文件里没有机器，无需释放');
    return { ok: true, released: null };
  }

  const host = st.server.publicIp;
  const user = st.ssh?.user ?? 'root';
  const keyPath = st.ssh?.keyPath;
  const out = { shop: o.shop, server: st.server.id, released: false, backup: null, domainKept: true };

  /* ── ① 数据：先导出，再删（顺序不能颠倒）──────────────────────────────── */
  const backupDir = path.join(stateDir(repoRoot), 'backups');
  const backupFile = `${backupDir}/${o.shop}-node-data-${new Date().toISOString().slice(0, 10)}.tar.gz`;
  if (keyPath && host) {
    log(`① 尝试导出数据卷（商品/订单/附件只在这台机器的卷里）…`);
    const script = `set -uo pipefail
sudo docker volume inspect marketplace-node-data >/dev/null 2>&1 || { echo "NO_VOLUME"; exit 0; }
sudo docker run --rm -v marketplace-node-data:/data --entrypoint tar marketplace-node:latest czf - -C /data . 2>/dev/null | base64 -w0
`;
    /*
      远端脚本经 `bashScript()`（= `bash -lc <单引号包裹的脚本>`）送达。
      旧写法是 `bash -lc ${JSON.stringify(script)}`（双引号包裹），在真 bash 上**跑不起来**：
      JSON 把换行写成 `\n` 两个字面字符，整段脚本被拼成一行（`set: pipefailnVALUE=…`，exit 2），
      而 `$`/反引号会被外层 shell 先展开。这条路径是"释放机器前先把数据卷导出来"，
      失败信息却长得像"远端脚本自己有语法错"（2026-10-15 审计实测，见 lib/ssh.mjs 的 shellQuote）。
    */
    const res = sshRun({ keyPath, user, host, command: bashScript(script), check: false, timeoutMs: 300_000 });
    const b64 = res.out.trim();
    if (res.status === 0 && b64 && !b64.includes('NO_VOLUME')) {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(backupFile, Buffer.from(b64, 'base64'), { mode: 0o600 });
      out.backup = backupFile;
      log(`   已导出：${backupFile}（${(fs.statSync(backupFile).size / 1024).toFixed(0)} KB）`);
    } else {
      log(`   ⚠ 导出没成功（这台机器可能已经连不上，或卷不存在）`);
    }
  }
  if (!out.backup && !o.iKnowDataIsLost) {
    throw Object.assign(
      new Error(
        '没能导出数据卷，但删除机器会**永久丢掉**商品/订单/附件（它们只在那台机器的卷里，没有第三方副本）。\n' +
          '  先自己抢救：ssh ' + `${user}@${host}` + ' 然后导出卷（命令见 node/README.md「备份」一行）；\n' +
          '  确实不要这些数据了，加 --i-know-data-is-lost 再跑一次。'
      ),
      { gate: true }
    );
  }

  /* ── ② 机器 ─────────────────────────────────────────────────────────────── */
  log(`② 释放机器 ${st.server.id}（${st.server.region}）`);
  const provider = await loadProv(st.provider, await credsFn(st.provider, { region: st.server.region }));
  await provider.deleteServer({ region: st.server.region, id: st.server.id });
  out.released = true;
  log('   已提交释放');

  /* ── ③ 域名/解析：默认留着 ─────────────────────────────────────────────── */
  // 这一项没有开关可关：域名是年付的、注册后 60 天内不可转出，删解析区也不会退钱；
  // 而且"删域名"必须人工确认转让锁，本工具不做（它会按年自动续费，这是能在控制台关掉的）。
  log(`③ 域名 ${st.domain} 保留（年付且注册后 60 天内不可转出，删解析区不退钱）`);
  if (st.dns?.recordId) log(`   它还在指向 ${host}（已释放的机器）；下次部署会改写这条 A 记录`);
  if (st.dns?.zoneName && st.dns?.nameservers?.length) log(`   解析区 ${st.dns.zoneName} 的 NS：${st.dns.nameservers.join(', ')}（保留，不删）`);

  const next = saveState(repoRoot, o.shop, { ...st, server: { ...st.server, releasedAt: new Date().toISOString() }, verified: null });
  return { ...out, stateFile: path.join(stateDir(repoRoot), `${o.shop}.json`), stateServerReleasedAt: next.server.releasedAt };
}
