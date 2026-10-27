/**
 * 退出路径的**进程层**验证：起一个真节点进程，验"收到停信号之后会排空在途请求再退出"。
 *
 * ## 与 `shutdown.test.js` 的分工
 *
 * 那一份测**内核**（顺序、退出码、超时、重复信号），靠注入的假 process/server；
 * 这一份测**真进程**：真的连库、真的监听端口、真的把在途请求应答完、真的不再收新连接，
 * 并真的以退出码 0 结束。两者缺一不可 —— 内核对了但没接上线，运维照样被硬杀。
 *
 * ## 为什么用 stdin EOF 而不是 `child.kill('SIGTERM')`
 *
 * Windows 上 `child.kill('SIGTERM')` **不会触发** JS 的 `'SIGTERM'` 监听器
 * （实测最小复现：`code=null signal=SIGTERM`，handler 一行都没打）——它是"直接打死"。
 * 而 stdin EOF 在两个平台上都能触发，走的是**同一个** `shutdown()` 内核，
 * 所以这条用例在两个平台上都验得到"排空 + 退 0"。
 *
 * ⚠️ 另一半（真实 SIGTERM 投递）在 Linux 上才有意义，且**必须**在部署验收里跑：
 * 容器里 PID 1 的 Node 收不到它自己安装的默认信号处理器（内核不给 PID 1 投递未显式安装的信号），
 * 所以那种形态只能靠"停一次容器、看日志里有没有那一行『已关闭（原因：SIGTERM』"来验。
 * 这条用例把它写成一句可照做的动作，而不是假装已经覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_DIR = path.resolve(HERE, '..');
const DB_NAME = `mk_test_shutproc_${process.pid}_${randomBytes(3).toString('hex')}`;
const DB = {
  host: process.env.MK_DB_HOST || '192.168.122.11',
  port: Number(process.env.MK_DB_PORT || 3306),
  user: process.env.MK_DB_USER || 'root',
  password: process.env.MK_DB_PASSWORD || '',
};
const PORT = 19000 + (process.pid % 1500);

async function dropDb() {
  const conn = await mysql.createConnection({ host: DB.host, port: DB.port, user: DB.user, password: DB.password });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
  } finally {
    await conn.end();
  }
}

function startNode(extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: NODE_DIR,
    env: {
      ...process.env,
      MK_DB_NAME: DB_NAME,
      MK_DB_HOST: DB.host,
      MK_DB_PORT: String(DB.port),
      MK_DB_USER: DB.user,
      MK_DB_PASSWORD: DB.password,
      MK_PORT: String(PORT),
      MK_TOKEN_SECRET: 'shutdown-proc-secret-0123456789abcdef',
      MK_SHOP_OWNER: '0x' + '11'.repeat(20),
      // 不接链：本用例测退出路径，链上部分只拖慢启动并引入外部依赖
      MK_ESCROW_ADDRESS: '',
      MK_PII_RETENTION_DAYS: '0',
      MK_SHUTDOWN_DRAIN_MS: '5000',
      MK_SHUTDOWN_ON_STDIN_EOF: '1',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  const ready = (ms = 40_000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (/已启动 http:\/\/0\.0\.0\.0:/.test(out)) return resolve();
        if (child.exitCode !== null) return reject(new Error(`节点启动即退出（code=${child.exitCode}）：\n${out.slice(-2000)}`));
        if (Date.now() - t0 > ms) {
          /*
            这条断言判的是**退出行为**，不是启动时延——所以超时只说明"在给定预算内没看到启动行"。
            子进程一个字都没打时，最有用的信息是"它卡在哪儿"：本仓的启动前段只有建库/结构指纹
            与链上自检，而整套测试共用一台 MySQL（每个文件一套库 + 一次结构指纹），并行度过高时
            会堵在这里。故把 pid、预算与"可能的资源争用"一并写进消息；并发度由 `npm test` 的
            `--test-concurrency` 兜住（见 package.json 的说明）。
          */
          return reject(
            new Error(
              `等启动超时（${ms}ms，pid=${child.pid}）：子进程未打印启动行；` +
                `若这是整套「npm test」，优先怀疑 MySQL 连接/DDL 被并行用例拖住。输出：\n${out.slice(-2000)}`
            )
          );
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  const exited = (ms = 30_000) =>
    new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
      const timer = setTimeout(() => reject(new Error(`等进程退出超时：\n${out.slice(-2000)}`)), ms);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  return { child, ready, exited, log: () => out };
}

test.after(async () => {
  await dropDb();
});

test('真进程：收到停信号 ⇒ 在途请求被应答完、不再接受新连接、自己退出且退出码 0', async () => {
  const n = startNode();
  try {
    await n.ready();

    /*
      在途请求：发出去之后**立刻**触发停机，然后断言它仍然拿到 200。
      这正是"排空"与"掐断"的分界 —— 没有信号处理时这个响应会半途消失。
    */
    const inflight = fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.status);
    await new Promise((r) => setTimeout(r, 30));
    n.child.stdin.end();

    const status = await inflight.catch(() => 'aborted');
    assert.equal(status, 200, '在途请求必须被应答完（硬杀会让它半途消失）');

    const { code, signal } = await n.exited();
    assert.equal(signal, null, '必须是"自己退出"而不是被信号打死');
    assert.equal(code, 0, `正常停机必须退 0（实际 ${code}）`);
    assert.match(n.log(), /已关闭（原因：stdin-EOF/, '必须留下可读的退出边界（含原因与耗时）');

    // 端口已关：新连接必须失败
    await assert.rejects(() => fetch(`http://127.0.0.1:${PORT}/healthz`), '停机之后不得再接受新连接');
  } finally {
    if (n.child.exitCode === null) n.child.kill('SIGKILL');
  }
});

test('真进程：未捕获异常 ⇒ 自己退出且退出码**非 0**（崩溃不能被当成正常下线）', async () => {
  /*
    注入的崩溃**由测试按键触发**（stdin 收到数据就抛），不是"启动后 N 秒抛"。

    为什么不能用固定延时（第一版是 9000ms）：节点要先连库、跑迁移、取实例锁，
    启动耗时**取决于机器**（本机实测 2–12 秒不等），于是"抛在就绪之前"时有发生 ——
    那时走的是 **Node 默认崩溃路径**（打印堆栈 + 退 1），用例红在一个与被测行为无关的地方。
    改成按键之后，`ready()` 保证 `server.js` 已求值完毕（handler 已注册），再抛。

    另两个细节也不能省：
      · 预载脚本在 `server.js` **之前**求值，所以它只能挂监听、不能立即抛；
      · 注入模块的 URL 在 Windows 上必须是 `file://`（给 `G:/…` 会报
        `ERR_UNSUPPORTED_ESM_URL_SCHEME`，表现为"节点启动即退出"，看起来像被测代码坏了）。
  */
  const fs = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const inject = path.join(NODE_DIR, '.tmp-throw-proc.mjs');
  fs.writeFileSync(
    inject,
    "process.stdin.resume();\n" +
      "process.stdin.once('data', () => { throw new Error('注入的未捕获异常（进程层用例）'); });\n"
  );
  const n = startNode({ NODE_OPTIONS: `--import=${pathToFileURL(inject).href}` });
  try {
    await n.ready(); // 走到这里 ⇒ server.js 求值完（handler 已注册），再按键
    n.child.stdin.write('boom\n');
    const { code, signal } = await n.exited();
    assert.equal(signal, null, '崩溃也必须走"自己退出"（否则库连接是被掐断的）');
    assert.notEqual(code, 0, '崩溃必须退非 0（退 0 会被编排当成正常下线，于是不重启）');
    assert.match(n.log(), /未捕获异常/, '必须把异常原文打进日志（否则崩溃现场只剩一个退出码）');
    assert.match(n.log(), /注入的未捕获异常/, '日志里要有原始错误信息');
    assert.match(n.log(), /原因：uncaughtException/, '"已关闭"那一行要说清是哪条路径触发的');
  } finally {
    if (n.child.exitCode === null) n.child.kill('SIGKILL');
    fs.rmSync(inject, { force: true });
  }
});
