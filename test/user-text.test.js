/**
 * 节点用户词表的**对拍**：运行时副本必须与前端唯一来源逐字段一致。
 *
 * 为什么需要它：节点镜像构建上下文是 `node/`，镜像里 import 不到 `../frontend`，
 * 所以副本是复制进来的。复制就会过期——没有这条测试，"前端把 Escrow 改成托管合约、
 * 节点还叫 Escrow"会一直静默存在，直到用户看到两套说法。
 *
 * 这条测试也负责挡住"在节点消息里新写一个英文标识符"：
 * 扫描 src 下所有用户可见消息（fail/message/reason/error），命中禁用词即红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMS, ENUMS, term, enumText, fmtBps, fmtTime, UNKNOWN_VALUE } from '../src/userText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_JSON = path.resolve(HERE, '../../frontend/src/utils/userText.zh.json');
const NODE_JSON = path.resolve(HERE, '../src/userText.zh.json');

test('userText: 节点副本与前端唯一来源逐字段一致（过期就重新 sync）', () => {
  const src = JSON.parse(readFileSync(SRC_JSON, 'utf8'));
  const copy = JSON.parse(readFileSync(NODE_JSON, 'utf8'));
  assert.deepEqual(copy, src, '节点 src/userText.zh.json 已过期：cd node && npm run sync:user-text');
  assert.deepEqual(TERMS, src.terms);
  assert.deepEqual(ENUMS, src.enums);
});

/** 用户消息里不允许出现的机器标识符（中文文案里的英文缩写） */
const BANNED = [
  /\bEscrow\b/,
  /\bStaking\b/,
  /\bRegistry\b/,
  /\boperator\b/,
  /\bendpoint\b/,
  /\barbiter\b/,
  /\bgovernor\b/,
  /\bwei\b/,
  /\bbps\b/,
  /\bRPC\b/,
  /\bABI\b/,
  /\bAPI\b/,
  /\btokenId\b/,
  /\bdecimals\b/,
  /\bnonce\b/,
  /\btxHash\b/,
  /\bchainId\b/,
  /\bgas\b/,
  /\bSettled\b/,
  /\bDisputed\b/,
  /\bCreated\b/,
  /\bRefunded\b/,
  /\brefundStatus\b/,
  /\bshop_code\b/,
  /\bpriceMicro\b/,
  /\bMK_[A-Z_]+\b/,
];

/** 用户消息里允许保留的专名/标准/格式（币种、标准、文件格式、协议名） */
const PROPER_NAMES = new Set([
  'BTY',
  'USDT',
  'NFT',
  'ERC20',
  'ERC721',
  'ERC721A',
  'ERC1155',
  'PDF',
  'CSV',
  'JSON',
  'HTTP',
  'HTTPS',
  'POST',
  'API',
  'ID',
  'IP',
  'HMAC',
  'SHA256',
  'BitYuan',
]);

/** 通用形状：camelCase / snake_case / 全大写缩写，不靠逐个列黑名单 */
const MACHINE_IDENT = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z][A-Z_]{2,}\b/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 只扫"用户可见消息"的字符串字面量：fail(...) / message: / reason: / error: */
function userMessageLiterals(src) {
  const out = [];
  const re = /\b(fail\(\s*res\s*,|errors\.push\(\s*|message\s*:|reason\s*:|error\s*:)\s*((?:'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)(?:\s*\+\s*(?:'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`))*)/g;
  let m;
  while ((m = re.exec(src))) {
    const chunk = m[2];
    // 模板里的 ${...} 变量不参与词表判断；只看静态文本
    for (const lit of chunk.matchAll(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
      out.push({ text: lit[0].slice(1, -1), index: m.index });
    }
  }
  return out;
}

/**
 * 节点运维读数/启动巡检模块：这些 `message` 只给节点运维看（/healthz、启动自检、监听状态），
 * 保留 `MK_*` 环境变量名与合约读法反而更有用（运维要照着改名/对账）。
 * 它们不进入买家/卖家的业务消息；业务消息仍由下面这条通用扫描兜住。
 */
const OPS_READOUT_FILES = new Set([
  'chain.js',
  'chainAnchor.js',
  'escrowWatcher.js',
  'server.js',
  'shutdown.js',
  'db.js',
  'redis.js',
  'config.js',
]);

test('userText: 节点用户消息里不得出现机器标识符或原始异常内插', () => {
  const files = walk(path.resolve(HERE, '../src'));
  const bad = [];
  for (const file of files) {
    if (OPS_READOUT_FILES.has(path.basename(file))) continue;
    const src = readFileSync(file, 'utf8');
    for (const { text } of userMessageLiterals(src)) {
      if (/\$\{\s*e(\?|\.)|\$\{\s*err(\?|\.)/.test(text)) {
        bad.push(`${path.relative(process.cwd(), file)}: 用户消息内插了异常原文：${text.slice(0, 80)}`);
        continue;
      }
      // 模板里的 ${...} 是变量名（operator/tokenId 等），不是给用户看的词；只看静态文本
      const literal = text.replace(/\$\{[^}]*\}/g, '');
      // 纯 ASCII 的 snake_case 是机器结果码（如 pool_empty / not_found），不是给用户看的文案
      if (!/[\u4e00-\u9fff]/.test(literal) && /^[a-z][a-z0-9_]*$/.test(literal)) continue;
      for (const re of BANNED) {
        if (re.test(literal)) bad.push(`${path.relative(process.cwd(), file)}: ${re} → ${text.slice(0, 80)}`);
      }
      for (const m of literal.matchAll(MACHINE_IDENT)) {
        if (PROPER_NAMES.has(m[0])) continue;
        bad.push(`${path.relative(process.cwd(), file)}: 标识符 ${m[0]} → ${text.slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('userText: 未知枚举值说"未识别"，绝不回落机器值', () => {
  assert.equal(enumText('orderStatus', 'settled'), '已结算（货款结算给店主）');
  assert.equal(enumText('orderStatus', 'future_status'), UNKNOWN_VALUE);
  assert.equal(enumText('claimStatus', 'requested'), '待处理');
  assert.equal(enumText('claimStatus', 'wat'), UNKNOWN_VALUE);
  assert.equal(enumText('rateSource', 'none'), 'BTY 直接定价');
});

test('userText: 术语取用户词；bps/时刻按人读格式输出', () => {
  assert.equal(term('escrow'), '托管合约');
  assert.equal(term('seller'), '店主');
  assert.equal(fmtBps(250), '2.5%');
  assert.equal(fmtBps(10000), '100%');
  assert.equal(fmtBps(null), '—');
  // 固定按中国时区：01:05Z ⇒ 09:05；16:00Z ⇒ 次日 00:00（h23，不印成 24:00）
  assert.equal(fmtTime('2026-11-04T01:05:00Z'), '2026-11-04 09:05');
  assert.equal(fmtTime('2026-11-03T16:00:00Z'), '2026-11-04 00:00');
  assert.equal(fmtTime(null), '—');
});
