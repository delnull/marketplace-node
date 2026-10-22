/**
 * 部署常量的单向性守卫：`deploy-constants.json` 是**唯一真相**，
 * `deploy.sh`（Linux/macOS 容器路径）与 `deploy.ps1`（Windows 原生路径）都必须从它读。
 *
 * 为什么这条要机械守卫（而不是写进文档让人记住）：
 *   两条部署路径要装出**同一个**节点，而"接错托管合约"的表现是静默的——节点照常启动、
 *   商品照常展示，只有买家付款路径指向别处；运行参数写偏了同样不报错，只会让某个后台任务
 *   悄悄不跑。各写一份常量，换批时必然分叉，而分叉当天不一定有人发现。
 *   所以判据挂在**代码形状**上：脚本里不允许出现第二批字面量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSTANTS = JSON.parse(fs.readFileSync(path.join(NODE_DIR, 'deploy-constants.json'), 'utf8'));
const DEPLOY_SH = fs.readFileSync(path.join(NODE_DIR, 'deploy.sh'), 'utf8');

test('deploy-constants.json：合约四项要么全空（本批未部署），要么三者形状俱全', () => {
  /*
    ⚠️ **"留空"是一个合法状态**（2026-10-16 改判据）：`contracts` 记的是**本批部署产物**，
    只有真部署过才知道；而此前每一批都已整体作废（缺当前源码里店主分账所需的读法，
    节点的启动期代次自检会判定代次不符并拒绝工作）。留空时 `deploy.sh` 的结构门禁会当场
    拒绝部署（见那里的 `[deploy.sh] 拒绝执行` 分支）——**空值响亮地停下，旧值静默地接错**，
    所以"空"必须被允许，而不是被这条测试逼着填一个已作废的地址进去。
    真正不许出现的是**半填**：有地址却没哈希（那样"接的是哪一代"无法机械核验）。
    `escrowCodeHash` 与本地编译产物的一致性由 `deploy-plan.test.js` 守。
  */
  const { escrow, registry, startBlock, escrowCodeHash } = CONSTANTS.contracts;
  const allEmpty = !escrow && !registry && !escrowCodeHash && Number(startBlock) === 0;
  if (allEmpty) return;
  assert.match(escrow, /^0x[0-9a-fA-F]{40}$/, 'Escrow 必须是合法地址');
  assert.match(registry, /^0x[0-9a-fA-F]{40}$/, 'Registry 必须是合法地址');
  assert.ok(Number.isInteger(startBlock) && startBlock > 0, 'startBlock 必须是正整数：0 表示从最新块开始 ⇒ 漏扫历史事件且不报错');
  assert.match(String(escrowCodeHash), /^0x[0-9a-fA-F]{64}$/, '填了地址就必须给出该批 Escrow 的运行时字节码哈希（否则无法机械核验代次）');
});

test('deploy-constants.json：网络与前端来源在，且 chainId 与 RPC 是主网口径', () => {
  assert.equal(CONSTANTS.network.chainId, 2999, 'BTY EVM 主网 chainId');
  assert.match(CONSTANTS.network.rpcUrl, /^https:\/\//, 'RPC 必须走 https');
  assert.match(CONSTANTS.network.frontendOrigin, /^https:\/\//, '前端来源必须是 https（CORS 白名单与 SIWE 都用它）');
});

test('deploy.sh 从 JSON 读合约三项 —— 不允许自己留一份字面量', () => {
  /*
    判据：脚本里有 `ESCROW="$(const escrow)"` 这类取值。
    **`escrowCodeHash` 不在此列，而且是刻意的**：`deploy.sh` 装出来的节点**不需要**它——
    链上那两个 immutable 锚（`Registry.CANONICAL_ESCROW_CODE_HASH`、
    `Staking.CANONICAL_ESCROW_CODE_HASH`）已经把这个哈希钉死了，节点自己的启动期代次自检
    逐条探读法（`ESCROW_GENERATION_PROBES`）也足够回答"接的是不是这一代"。
    它的消费方是**仓库自己**：`deploy-plan.test.js` 拿它与本地编译产物比对，
    让"改了合约却没换批"当场变红。给脚本加一条读了不用的赋值，正好是本仓反对的那种形状。
  */
  for (const [key, field] of [['ESCROW', 'escrow'], ['REGISTRY', 'registry'], ['START_BLOCK', 'startBlock']]) {
    assert.match(
      DEPLOY_SH,
      new RegExp(`^${key}="\\$\\(const ${field}\\)"$`, 'm'),
      `${key} 应从 deploy-constants.json 读（const ${field}）`
    );
  }
  /*
    脚本里不许出现**任何** 40 位十六进制地址字面量（连注释里的示例也算：注释会漂移，
    换批时没人会去改它）。判据从"不含某一个具体地址"升级成"不含任何一个地址"——
    前者在常量留空时退化成恒真（`''.split(…)` 命中 53286 次，本会话实测），等于没守。
    唯一的例外是**全零地址**：它不是"某个合约的地址"，而是"没有地址"的写法
    （owner 校验里用它挡占位值），留着一个具体地址才会漂移。
  */
  const ZERO = '0x0000000000000000000000000000000000000000';
  const addrLiterals = [...DEPLOY_SH.matchAll(/0x[0-9a-fA-F]{40}\b/g)]
    .map((m) => m[0])
    .filter((a) => a.toLowerCase() !== ZERO);
  assert.deepEqual(
    [...new Set(addrLiterals)],
    [],
    'deploy.sh 里不该出现合约地址字面量（注释里的示例也算）——它必须从 deploy-constants.json 读'
  );
});

test('deploy.sh 的运行参数逐个来自 appDefaults —— 写死的数字会在换批时漂移', () => {
  /*
    MK_BTY_TTL_MS 是**例外**，而且是刻意的：脚本重跑时要沿用店主在现有 .env 里手改过的行情缓存，
    只有"没有旧值"时才回落到常量（KEEP_BTY_TTL）。强行要求它 `$(constN …)` 会把店主的改动冲掉。
    这里的判据是"它的**缺省值**来自 JSON"，不是"脚本直接读它"。
  */
  const FROM_EXISTING_ENV = new Set(['MK_BTY_TTL_MS']);
  for (const key of Object.keys(CONSTANTS.appDefaults)) {
    if (FROM_EXISTING_ENV.has(key)) {
      assert.match(DEPLOY_SH, new RegExp(`KEEP_BTY_TTL=[^\\n]*`), '沿用已有值的那条路必须在');
      assert.match(DEPLOY_SH, /KEEP_BTY_TTL="\$\(env_val MK_BTY_TTL_MS\)"/, '缺省值应取自常量 JSON');
      continue;
    }
    // 硬判据两条，一起构成"没有第二份真相"：
    //   ① 该键必须通过 $(constN KEY) 从 JSON 取值；
    //   ② 该键不许同时以 `KEY=123` 这种字面量出现。
    assert.match(DEPLOY_SH, new RegExp(`\\$\\(constN ${key}\\)`), `${key} 应通过 $(constN ${key}) 从 JSON 取值`);
    assert.doesNotMatch(DEPLOY_SH, new RegExp(`^${key}=\\d+$`, 'm'), `${key} 不许写成字面量（那就是第二份真相）`);
  }
});

test('appDefaults 的值都是数字 —— 它们要裸着写进 .env 的 here-doc', () => {
  for (const [k, v] of Object.entries(CONSTANTS.appDefaults)) {
    assert.ok(Number.isFinite(v), `${k} 必须是数字（here-doc 里裸写的值会被当算术表达式展开，非数字会静默变 0）`);
  }
});
