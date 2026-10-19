/**
 * **公开仓布局自检**：只把 `node/**` 摊到仓库根（公开节点仓的真实形状）时，依赖"整棵源码树"的
 * 三份守卫必须 **skip**，而不是在模块加载期抛 ENOENT 让 `npm test` 变红。
 *
 * 为什么需要一条测试来守测试自己：`abi-consistency.test.js` 曾把
 * `readdirSync(path.join(ROOT, 'contracts/src'))` 放在模块顶层——注释写着"公开节点仓里跳过"，
 * 而模块**加载**阶段就已经 ENOENT，整份文件失败。这种缺陷在任何"整棵树都在"的布局下
 * 都看不见：只有把代码摊成公开节点仓的形状真跑一次才会露出来。
 *
 * 双向：本仓布局下这三份文件的用例必须**真的在跑**（pass > 0），否则判据被改死
 * （永远 false）时全都 skip 也是一种"绿"。
 *
 * 代价：一次 `node/**` 的临时拷贝（跳过 node_modules，用目录联接指回本仓的依赖）+
 * 两次布局各跑一遍子进程；临时目录在 finally 里删掉，仓库里不留任何东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `test/` 的上一级 = 节点包根：完整仓库里是 `node/`，公开节点仓里是仓库根 */
const NODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 需要"整棵源码树"的三份守卫（`FULL_TREE` 判据在各自文件顶部） */
const GUARDS = ['test/abi-consistency.test.js', 'test/dev-scripts-supply.test.js', 'test/deploy-plan.test.js'];

/**
 * 在 `cwd` 下跑一份测试文件，返回 TAP 摘要里的计数。
 *
 * 为什么用子进程而不是 `import()`：要观察的失败形状正是"模块顶层抛 ENOENT"，
 * 而 `import()` 会把它揉成"本文件的某个用例失败"，分不清是布局问题还是判据问题。
 * TAP 的 `# tests / # pass / # fail / # skipped` 是 node:test 的对外契约
 * （skip 的那条计 pass=0、skipped=N），比解析人读的 `ℹ` 行稳。
 */
function tapCounts(cwd, rel) {
  /*
    `NODE_TEST_CONTEXT` 必须摘掉：本文件自己就跑在 `node --test` 里，子进程会继承这个变量，
    node:test 于是认定"已经在测试子进程里"并**拒绝再跑文件**（警告：run() is being called
    recursively），结果是一份空摘要 —— 那不是任何判据的结论。
  */
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', rel], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const num = (key) => {
    const m = out.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return { status: r.status, tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'), out };
}

/**
 * 在 `dest` 建出一份公开节点仓布局：`node/**` 摊到根 + `shared/shopCode.js`。
 *
 * 依赖不发布（店主那边是自己 `npm install`），这里用**目录联接**指回本仓已装好的那份：
 * 拷 node_modules 要 5 秒、20 多 MB，而这三个守卫要的只是 `ethers`。
 */
function buildMirrorLayout(dest) {
  const EXCLUDED = new Set(['node_modules', 'data', 'uploads', '.uploads']);
  fs.cpSync(NODE_ROOT, dest, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (EXCLUDED.has(name)) return false;
      // 公开节点仓只发布 `.env.example`（其余 `.env*` 是本机配置，可能含私密值）
      return name !== '.env' && (!name.startsWith('.env.') || name === '.env.example');
    },
  });
  fs.symlinkSync(
    path.join(NODE_ROOT, 'node_modules'),
    path.join(dest, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const shared = [path.join(NODE_ROOT, 'shared', 'shopCode.js'), path.join(NODE_ROOT, '..', 'shared', 'shopCode.js')].find(
    (p) => fs.existsSync(p)
  );
  assert.ok(shared, '找不到 shared/shopCode.js：公开节点仓布局建不出来（它也被发布到公开节点仓根）');
  fs.mkdirSync(path.join(dest, 'shared'), { recursive: true });
  fs.copyFileSync(shared, path.join(dest, 'shared', 'shopCode.js'));
}

/** 本仓布局（整棵源码树在）：`node/` 的上一级有 `contracts/src` */
const FULL_TREE = fs.existsSync(path.join(NODE_ROOT, '..', 'contracts', 'src'));

test(
  '本仓布局：三份跨树守卫真的在跑（pass > 0，不是被自己的判据吞成 skip）',
  { skip: FULL_TREE ? false : '只有节点这一份代码（公开节点仓布局）：这三份守卫本来就该 skip' },
  () => {
    for (const rel of GUARDS) {
      const c = tapCounts(NODE_ROOT, rel);
      assert.equal(c.status, 0, `${rel} 在本仓布局下没有通过：\n${c.out}`);
      assert.ok(c.pass > 0, `${rel} 一条用例都没跑：整树判据被改死了（公开节点仓里才该整组 skip）`);
      assert.equal(c.fail, 0, `${rel} 有失败用例：\n${c.out}`);
    }
  }
);

test('镜像布局（node/** 摊到仓库根）：三份守卫整组 skip，没有一条失败', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mirror-'));
  try {
    buildMirrorLayout(tmp);
    for (const rel of GUARDS) {
      const c = tapCounts(tmp, rel);
      assert.equal(c.status, 0, `${rel} 在镜像布局下没有变成 skip（status=${c.status}）：\n${c.out}`);
      assert.equal(c.fail, 0, `${rel} 在镜像布局下有失败用例（"这棵树里跑不了"不等于"判据不成立"）：\n${c.out}`);
      assert.equal(c.pass, 0, `${rel} 在镜像布局下跑了 ${c.pass} 条用例（整组都该 skip，否则说明它还在读不存在的树）：\n${c.out}`);
      assert.ok(c.skipped > 0, `${rel} 在镜像布局下一条用例都没登记（skip=0）：模块提前退出了，而不是按 skip 注册`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
