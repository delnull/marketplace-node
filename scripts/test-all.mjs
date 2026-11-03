#!/usr/bin/env node
/**
 * 逐文件跑 node 测试。
 *
 * 为什么不用 `node --test test/*.test.js` 一次拉起全部文件：本仓每个测试文件自己建一个
 * `mk_test_<pid>_<random>` 库并在 after 里删掉；Node 的跨文件 test runner 在本机
 * （Windows 与 Linux 测试服务器都复现）会在某一两个文件后卡住，单个文件跑全部通过。
 * 这不是跳过测试：每个文件仍然用 `node --test` 独立执行，失败/超时都会让 npm test 非 0。
 * 一次只跑一个文件，进程退出即释放连接与句柄；超时 180s 防止某个文件把整条命令挂死。
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const TEST_DIR = path.join(process.cwd(), 'test');
let files = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

/*
  TEST_FROM 只用于长跑续跑（例如服务器上 1..75 已全绿、被环境打断）。
  正常 `npm test` 不设它，仍然从第一个文件跑到最后一个；它不跳过任何未跑文件。
*/
const from = String(process.env.TEST_FROM || '').trim();
if (from) {
  const i = files.indexOf(from);
  if (i < 0) {
    console.error(`TEST_FROM=${from} 不在 test/*.test.js 里`);
    process.exit(2);
  }
  files = files.slice(i);
}

const failed = [];
for (const file of files) {
  const abs = path.join(TEST_DIR, file);
  process.stdout.write(`\n──── ${file} ────\n`);
  const child = spawn(
    process.execPath,
    ['--env-file-if-exists=.env.test', '--test', '--test-force-exit', abs],
    { stdio: 'inherit', env: process.env, detached: process.platform !== 'win32' }
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    /*
      只 kill `node --test` 不够：它会再 spawn 测试文件进程，孙进程可能还握着
      继承来的句柄，父进程的 close 事件就永远不来。Linux 用进程组，Windows 用
      taskkill /T 连整棵树一起收掉；否则超时形同虚设。
    */
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }, 180_000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  if (code !== 0) failed.push(`${file}${timedOut ? '（超时）' : `（exit ${code}）`}`);
}

console.log(`\n════ 逐文件测试：${files.length} 个文件，失败 ${failed.length} 个 ════`);
if (failed.length) {
  for (const f of failed) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('  全部通过');
