/**
 * deploy-constants.json 的自检：Docker 的停机宽限期必须大于节点自己等待在途请求的上限，
 * 否则宽限期一到 SIGKILL 会把优雅关闭截断（日志还会写“已关闭”）。
 *
 * 这条约束以前只在部署脚本注释里声称由 test/deploy-plan.test.js 守着，但文件不存在。
 * 这里补上可执行判据；改任一边界都会红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const constants = JSON.parse(
  readFileSync(fileURLToPath(new URL('../deploy-constants.json', import.meta.url)), 'utf8')
);

test('stopGraceSeconds 的毫秒数必须大于 MK_SHUTDOWN_DRAIN_MS', () => {
  const graceMs = Number(constants.runtime?.stopGraceSeconds) * 1000;
  const drainMs = Number(constants.appDefaults?.MK_SHUTDOWN_DRAIN_MS);
  assert.ok(Number.isFinite(graceMs) && graceMs > 0, 'stopGraceSeconds 必须是正数');
  assert.ok(Number.isFinite(drainMs) && drainMs > 0, 'MK_SHUTDOWN_DRAIN_MS 必须是正数');
  assert.ok(graceMs > drainMs, `停机宽限期 ${graceMs}ms 必须大于在途请求上限 ${drainMs}ms`);
});
