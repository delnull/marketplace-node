/**
 * webhook 投递的两条契约（2026-09 修复）——与 pinned-request.test.js（真实服务器上的钉住实现）
 * 互补，这一层钉的是 **sendOnce / deliver 的对外契约**：
 *
 *  1. 地址钉死：sendOnce **只解析一次**，把"校验通过的那批地址"交给发送器（默认实现据此把 socket
 *     钉死）。等价断言：DNS 在两次解析之间换答案（第一次公网、第二次回环）也影响不到连接目标。
 *  2. 校验在连接之前：主机名解析到内网时，一个连接都不许发出——服务器侧零连接（用真能解析到
 *     127.0.0.1 的 `localhost`，不依赖注入点），注入的发送器侧也零调用。
 *  3. deliver 的**最终结算**（Promise<boolean>）：成功 true / 重试耗尽 false / 未配置 URL false。
 *     三处一次性告警（pool_empty / chain_missing / hold_missing）据此决定要不要写幂等标记：只有
 *     true 才写，false 说明下次还得再投（at-least-once，见 alertAck.js）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';

// 重试退避调小（运维参数，config 顶层求值时读取——必须在本文件任何业务模块 import 之前设置）
process.env.MK_WEBHOOK_RETRY_MS = '20';

import { makeCtx } from './setup.mjs';

const ctx = await makeCtx();
const { db } = ctx;
const { kvSet } = await import('../src/db.js');
const { setWebhookSender, notify, notifyRaw, webhookStatus, resetWebhookStatus, pinnedSender } = await import('../src/webhook.js');
const { setLookupAll } = await import('../src/netguard.js');

/** netguard 的默认解析器（注入后必须还原，避免污染同文件后续用例） */
const defaultLookup = (h) => dns.promises.lookup(h, { all: true, verbatim: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 直接插一张草稿单（notify 只按 id 组装 payload，草稿足够——与 webhook.test.js 同款装配） */
let seq = 0;
function insertOrder() {
  seq += 1;
  const id = `wp-${seq}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (id, product_slug, product_snapshot, snapshot_hash, sku_key, buyer, seller,
       amount_wei, cny_fen, bty_usdt_rate, usdt_cny_rate, status, escrow_order_id, created_at, updated_at)
     VALUES (?, 'p-x', '{}', '0x00', '', '0x00000000000000000000000000000000000000aa', '0x00000000000000000000000000000000000000bb',
       '1000000000000000000', 100, '0.1', '7.2', 'draft', ?, ?, ?)`
  ).run(id, `0x${String(seq).padStart(64, '0')}`, now, now);
  return { id };
}

test('地址钉死：整个投递只解析一次，交给发送器的是校验时那批地址（DNS 换答案进不来）', async () => {
  const o = insertOrder();
  kvSet('mk:webhook_url', 'https://rebind.example.com/hook');
  const calls = [];
  setWebhookSender(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  });
  let lookups = 0;
  setLookupAll(async () => {
    lookups += 1;
    // 第一次（校验）答公网；若谁在投递里再解析一次，就会拿到回环地址（DNS rebinding 的攻击形态）
    return lookups === 1 ? [{ address: '93.184.216.34' }] : [{ address: '127.0.0.1' }];
  });
  try {
    assert.equal(await notify('order.escrowed', o.id), true, '投递成功');
    assert.equal(lookups, 1, '一次投递只解析一次（校验那次），连接阶段不再问 DNS');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].init.addresses, ['93.184.216.34'], '发送器/钉住实现只拿到校验通过的那批地址');
    assert.equal(calls[0].init.redirect, 'manual', '不跟随重定向的语义保留');
    assert.equal(calls[0].url, 'https://rebind.example.com/hook', 'URL 原样传递（Host/SNI 由钉住实现按主机名设置）');
  } finally {
    setLookupAll(defaultLookup);
    setWebhookSender(null);
  }
});

test('解析到内网地址时一个连接都不许发出（服务器侧零连接；注入的发送器侧零调用）', async () => {
  let hits = 0;
  let connections = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.end('x');
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const o = insertOrder();
  try {
    /*
      URL 主机名用 `localhost`：它**真的**解析到 127.0.0.1（不依赖任何注入点），若校验被绕过或
      被挪到连接之后，这里就会实打实地连上服务器——"零连接"才是内容为真的断言。
    */
    kvSet('mk:webhook_url', `http://localhost:${port}/hook`);
    setWebhookSender(null); // 默认路径：真实 socket
    notify('order.escrowed', o.id); // fire-and-forget（忽略返回的 Promise）
    await sleep(250); // 覆盖 2 次重试窗口（retryBase=20ms）
    assert.equal(connections, 0, '目标解析到回环：一个 TCP 连接都不许建立');
    assert.equal(hits, 0, '服务器侧零请求');

    // 字面量内网/云元数据地址：校验在发送之前，注入的发送器同样一次都不该被调用
    const called = [];
    setWebhookSender(async (url) => {
      called.push(url);
      return { ok: true, status: 200 };
    });
    kvSet('mk:webhook_url', 'http://169.254.169.254/latest/meta-data/');
    notify('order.escrowed', o.id);
    await sleep(250);
    assert.equal(called.length, 0, '云元数据地址：注入的发送器零调用（校验先于发送）');
  } finally {
    setWebhookSender(null);
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('默认发送器就是钉住实现：不可解析主机名 + 钉住地址也能直达真实服务器（改回 fetch 必红）', async () => {
  const hosts = [];
  const server = http.createServer((req, res) => {
    hosts.push(req.headers.host);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    /*
      这条钉的是 webhook.js 与 pinnedRequest.js 之间的**接线**：sendOnce 未注入发送器时用的就是
      钉住实现。若默认发送器改回 `fetch(url)`（原缺陷形态），这里必然因 pinned.invalid 解析失败
      而红——"校验一次 → 钉住地址发请求"才是完整的修复，只有校验或只有钉住都不算。
    */
    const res = await pinnedSender(`http://pinned.invalid:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"type":"order.pool_empty"}',
      addresses: ['127.0.0.1'],
      timeoutMs: 2000,
    });
    assert.equal(res.status, 200, '默认发送器必须真的把请求送到钉住地址');
    assert.deepEqual(hosts, [`pinned.invalid:${port}`], 'Host 头仍是原主机名');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('deliver 的最终结算：成功 true、重试耗尽 false、未配置 URL false（3xx 直接算失败）', async () => {
  const o = insertOrder();
  resetWebhookStatus();
  kvSet('mk:webhook_url', 'https://93.184.216.34/hook');

  setWebhookSender(async () => ({ ok: true, status: 200 }));
  assert.equal(await notify('order.escrowed', o.id), true, '送达 ⇒ true（调用方才写幂等标记）');

  // 重试耗尽：3 次尝试（首次 + 2 次重试）后结算 false —— alertAck 据此"不写标记、下次再投"
  let attempts = 0;
  setWebhookSender(async () => {
    attempts += 1;
    throw new Error('connect ECONNREFUSED');
  });
  assert.equal(await notify('order.escrowed', o.id), false, '重试耗尽 ⇒ false');
  assert.equal(attempts, 3, '共 3 次尝试（首次 + 2 次重试）');

  // 3xx：语义与原来一致（redirect:manual + 显式拒绝），错误文案要能指导店主改成直达地址
  setWebhookSender(async () => ({ ok: false, status: 302 }));
  assert.equal(await notify('order.escrowed', o.id), false, '3xx ⇒ 失败（不跟随重定向）');
  assert.match(String(webhookStatus().last.error), /重定向已禁用/);

  // 未配置 URL：false（**不是** true）——标记不写，店主以后配好 webhook 还能收到这条历史告警
  kvSet('mk:webhook_url', '');
  let called = 0;
  setWebhookSender(async () => {
    called += 1;
    return { ok: true, status: 200 };
  });
  assert.equal(await notify('order.escrowed', o.id), false);
  assert.equal(await notifyRaw('order.hold_missing', { orderId: o.id }), false);
  assert.equal(called, 0, '未配置 URL：零调用');

  // 本地查不到订单（payload 组装不出来）：同样视同未投递，不产生外呼
  assert.equal(await notify('order.escrowed', 'no-such-order'), false);
  assert.equal(called, 0);
  setWebhookSender(null);
  kvSet('mk:webhook_url', '');
});
