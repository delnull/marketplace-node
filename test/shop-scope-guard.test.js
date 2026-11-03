/**
 * **跨店作用域守卫**（多租户节点）：卖家面的入口必须回答"这一单/这件商品属于这家店吗"。
 *
 * ## 为什么要有它（它守的是一次真链实测出来的事故）
 *
 * 一个节点上有多家店，而卖家面的入口只回答了"**你是不是请求头那家店的店主/店员**"，
 * 没有回答"**你要动的东西属于那家店吗**"。2026-10-15 的真链实测里，凭据属于 A 店的人
 * 对 B 店的东西动手，**五条全部成功**：给别店的托管单发货（数字商品连兑换码原文一起回）、
 * 批量发货、导出别店订单 CSV（含买家姓名/电话/地址）、擦除别店订单 PII（不可逆）、
 * 用别店商品建单（收款人写自己、库存/码池是别店的）。
 *
 * 判据已收成一个：`src/orderScope.js` 的 `findOrderInShop(id, req.shop.code)`——
 * **挂在"取订单"这个动作上**，而不是"取到之后再判一次"（后者只要有人忘了判就漏）。
 * 这条守卫就是把"有人忘了用那个函数"变成红的：它不需要起服务、不需要链，每次 `npm test` 都跑。
 *
 * ## 例外表
 *
 * 确实有不按"订单归属"门控的卖家面路由（例如 `requireAuth` 的买家/店主共用入口，
 * 它们按"本人的单或本店的人"判，是**另一条**判据）。例外必须写进 `EXEMPT` 并给理由——
 * "漏了"与"决定不这么判"在代码上必须长得不一样。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 被扫的路由文件：卖家面（店主/店员）与 PII 面 */
const ROUTE_FILES = ['node/src/routes/orders.js', 'node/src/routes/returns.js', 'node/src/routes/pii.js'];

/**
 * 例外（每条必须带理由）：按 `:id` 取订单但**不**按订单归属门控的卖家面路由。
 * 理由说的是"这条路由的判据是什么"，不是"先这样"。
 */
const EXEMPT = {
  // 'orders.js POST /:id/xxx': '这条按买家的单判（req.auth.address === order.buyer），不是卖家面',
};

const SELLER_MW = /\b(staffOnly|ownerOnly)\b/;

/** 把源码切成"每条路由 = 声明行 + 它的 handler 体"，返回 `{file, method, path, body}` */
function routesOf(file, src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/router\.(get|post|patch|put|delete)\(\s*'([^']+)'/);
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/router\.(get|post|patch|put|delete)\(\s*'/.test(lines[j])) {
        end = j;
        break;
      }
    }
    out.push({ file, method: m[1], path: m[2], head: lines[i], body: lines.slice(i, end).join('\n') });
  }
  return out;
}

test('卖家面按 :id 取订单的路由必须经 findOrderInShop（跨店越权的唯一收口）', () => {
  const bad = [];
  let scoped = 0;
  for (const file of ROUTE_FILES) {
    if (!fs.existsSync(path.join(ROOT, file))) continue;
    for (const r of routesOf(file, read(file))) {
      if (!r.path.includes(':id')) continue;
      // 卖家面判据只认**声明行**上的中间件（handler 里出现同名字符串不算）
      if (!SELLER_MW.test(r.head)) continue;
      const key = `${path.basename(file)} ${r.method.toUpperCase()} ${r.path}`;
      if (EXEMPT[key]) continue;
      if (!r.body.includes('findOrderInShop(')) {
        bad.push(`${key}（该路由是店主/店员面却直接取订单：请改用 src/orderScope.js 的 findOrderInShop，或在 EXEMPT 里写明理由）`);
        continue;
      }
      if (/(^|[^n])findOrder\(req\.params\.id\)/.test(r.body)) {
        bad.push(`${key}（同一路由里既有 findOrderInShop 又有不受限的 findOrder(req.params.id)——后者是漏点）`);
        continue;
      }
      scoped += 1;
    }
  }
  assert.deepEqual(bad, [], `卖家面存在未按店铺作用域取订单的路由：\n  ${bad.join('\n  ')}`);
  assert.ok(scoped >= 3, `只检查到 ${scoped} 条受作用域保护的卖家面路由——守卫本身可能失配（路由写法变了？）`);
});

test('下单时的店铺只有一个来源：商品行的 shop_code（收款人与库存不可能分属两家）', () => {
  const draft = routesOf('orders.js', read('node/src/routes/orders.js')).find((r) => r.method === 'post' && r.path === '/');
  assert.ok(draft, 'orders.js 里找不到 POST /（建草稿）这条路由——守卫本身可能失配（路由写法变了？）');
  assert.match(
    draft.body,
    /shopRowByCode\(product\.shop_code\)/,
    '建草稿没有从商品行取店铺：收款人（shops.seller）与库存/码池必须读同一列'
  );
  assert.match(draft.body, /shop\.seller,\s*shop\.code/, '订单落库的卖家与店铺编号必须来自同一行');
  /*
    `X-Mk-Shop` 现在是**范围提示**，不是买家动作的输入（见 http.js）：店铺从目标推导，
    一次登录就能买本节点任何一家店的东西。旧形状要求买家先声明一家店、再校验它与商品的
    shop_code 一致——那是"两个可以不一致的输入必须相等"，于是"带 B 店的头发 A 店的货 /
    钱付给 B"在形状上可表达（2026-10-15 真链实测的五条越权之一）。这条断言钉的是
    那层声明不许回来：建草稿的 handler 里不得出现 req.shop。
  */
  assert.ok(
    !/req\.shop\b/.test(draft.body),
    '建草稿读了请求头指的那家店（req.shop）：店铺因此有了两个来源，跨店错配重新变得可表达'
  );
});

test('ownerOnly 的导出查询必须带店铺过滤（否则一家店主能导出全节点的订单与卡密）', () => {
  const src = read('node/src/routes/export.js');
  /*
    ⚠️ 必须把读模型 `v_orders` 也算进来：订单拆成三张表之后，`export.js` 的查询一律读
    **聚合读模型**（`v_orders`），不再 `FROM orders`。只匹配 `orders|products` 会让这条守卫
    在"一条查询都没匹配到"的情况下**静默通过**——那正是它要防的事。匹配不到就是红，不是绿。
  */
  const queries = [...src.matchAll(/FROM\s+(v_orders|orders|products)\b[\s\S]{0,400}?(?=`|'|"|\);)/g)]
    .map((m) => m[0])
    .filter((q) => q.trim().length > 20); // 切分产生的空片不算查询（否则"漏了一条"会被空串掩盖）
  assert.ok(queries.length >= 3, `export.js 里只切出 ${queries.length} 条查询——切分方式可能失配`);
  const leak = queries.filter((q) => !/shop_code/.test(q));
  assert.deepEqual(leak, [], `export.js 里这 ${leak.length} 条查询没有店铺过滤（ownerOnly 只回答"你是不是这家店的店主"）：\n  ${leak.map((q) => q.replace(/\s+/g, ' ').slice(0, 120)).join('\n  ')}`);
});
