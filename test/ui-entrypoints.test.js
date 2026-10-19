/**
 * **每个"用户能触发的接口"都必须有界面出口** —— 判据级守卫。
 *
 * ## 为什么需要它（这一条是上一批审计挖出来的真缺口）
 *
 * `node/src/routes/shops.js` 里那 7 个开店接口（提交申请 / 队列 / 审批 / 回签 / 核验上链）
 * 在节点侧**全都有实现、全都有注释、全都有权限判据**，而前端**零调用点**：
 * 后端有能力、网页没有入口、文档却承诺"申请 → 审批 → 双签上链"。
 * 用户侧的后果是无法完成一件产品定义里的事；而**没有任何测试会红**
 * —— 节点测试自己构造请求，前端测试不读节点路由，两边各自全绿。
 * 这正是"判据挂错了层"的典型：`/healthz` 那次是"探活只看进程在不在"，
 * 这一次是"接口有没有入口没人回答"。
 *
 * ## 判据
 *
 * 逐个解析 `node/src/routes/*.js` 里的**写方法**路由（POST/PUT/PATCH/DELETE），
 * 拼出完整路径（前缀取自 `app.js` 的 `app.use('/api/…', xxxRouter)`），
 * 然后要求它在**前端 API 层**以真实调用出现：
 *
 *     http.post<…>(normOrigin(origin), '/api/…', …)
 *
 * 判据刻意收在"**这一行里有这个路径**"而不是"全仓某处出现过这个字样"：
 * 后者会被注释、文档、恰好同名的别的路径骗过（本仓踩过——`readDdl` 用一个反引号当右界，
 * 于是注释里的反引号让两条断言同时沉默）。所以下面按**行**匹配 `http.<method>`，
 * 并且路径要在同一行上。
 *
 * ## 例外必须是"这个接口不该有界面出口"，而不是"暂时还没做"
 *
 * `EXEMPT` 每一条都要写清**为什么它不该有界面**。加一条例外的成本必须高于补一个入口
 * ——否则这个守卫会退化成"把没做的接口列进来就绿了"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const NODE_SRC = path.join(REPO, 'node', 'src');
const FRONTEND_API = path.join(REPO, 'frontend', 'src', 'api');

/**
 * 例外：**不该**有网页入口的接口 + 理由（不是"还没做"）。
 *
 * 每条都要能回答"谁会调它、为什么不是浏览器"。
 */
const EXEMPT = {
  '/api/uploads': '只读 GET 由 <img src> 直接取，不经 API 层的 http.get（见 EXEMPT_GET）',
};

/** GET 也一并覆盖（读接口没有界面出口同样是缺口），例外的只放"不经 API 层"的那些 */
const EXEMPT_GET = {
  // 图片本身由浏览器直接请求（`<img src>`），不走 api 层的 http.get
  '/api/uploads/:code/:file': '由 <img src> 直接加载，不经 fetch 封装',
  '/api/uploads/:code': '同上（按商品取图列表在页面里用 fetchImage 拼 URL）',
  // 健康探针由运维/容器编排调用，不是用户操作
  '/healthz': '容器 HEALTHCHECK 与部署脚本的探活，不是用户操作',
  '/api/readyz': '同上',
};

/**
 * 写方法（REST 只有这四个会改状态）。
 *
 * ⚠️ 方法名在两侧**不同名**：节点路由叫 `router.delete`，而前端 http 客户端把 DELETE 叫
 * `http.del`（`delete` 是 JS 保留字，`http.delete(...)` 那种属性名写法在这个代码风格里不出现）。
 * 少这一条映射时，四条"删码 / 删 NFT 行"的接口会被**误报成没有出口**（实测踩到）。
 */
const WRITE_METHODS = ['post', 'put', 'patch', 'delete'];

/** 路由方法 → 前端 http 客户端的方法名（只有 DELETE 这一处不同名） */
const CLIENT_METHOD = { delete: 'del' };

/** 读出 `app.use('/api/xxx', yyyRouter)` 的前缀映射 */
function mountPrefixes() {
  const app = fs.readFileSync(path.join(NODE_SRC, 'app.js'), 'utf8');
  const map = new Map();
  for (const m of app.matchAll(/app\.use\('([^']+)',\s*(\w+Router)\)/g)) {
    const [, prefix, routerVar] = m;
    const list = map.get(routerVar) || [];
    list.push(prefix);
    map.set(routerVar, list);
  }
  return map;
}

/** `xxxRouter` ← 哪个 routes/*.js 文件 */
function routerFiles() {
  const app = fs.readFileSync(path.join(NODE_SRC, 'app.js'), 'utf8');
  const out = [];
  for (const m of app.matchAll(/import\s+(\w+Router)\s+from\s+'\.\/routes\/([\w.-]+)\.js'/g)) {
    out.push({ routerVar: m[1], file: `${m[2]}.js` });
  }
  return out;
}

/**
 * 路由里的一条路由：方法、路径（**已拼接挂载前缀**）。
 *
 * 只认字面量路径：`router.get('/applications/list', …)`。带正则/变量的路径这里不解析，
 * 而那种写法在本仓不存在——真出现了也不要静默跳过，所以下面统计"解析不到字面量路径"的条数。
 */
function routesOf(file) {
  const src = fs.readFileSync(path.join(NODE_SRC, 'routes', file), 'utf8');
  const out = [];
  for (const method of [...WRITE_METHODS, 'get']) {
    for (const m of src.matchAll(new RegExp(`router\\.${method}\\(\\s*'([^']*)'`, 'g'))) {
      out.push({ method, p: m[1] });
    }
  }
  return out;
}

/**
 * 前端 API 层全文（各文件按行拼起来：按行匹配才不会把注释当调用）。
 *
 * 只需覆盖 `api/` 下的文件：那些是**唯一**拥有令牌与店铺上下文的层
 * （`X-Mk-Shop` 由 `api/http.ts` 从会话补），所以"这个接口有没有界面出口"
 * 在第一近似上就是"api 层有没有调它"。
 */
function frontendApiLines() {
  const files = fs.readdirSync(FRONTEND_API).filter((f) => f.endsWith('.ts'));
  return files.flatMap((f) => fs.readFileSync(path.join(FRONTEND_API, f), 'utf8').split('\n'));
}

/**
 * 前端**页面/工具**层里那些"不经过 api 层封装"的直接下载调用。
 *
 * 为什么需要这一组：四条 CSV 导出（`/api/shop/export/*.csv`）走的是 `fetchExportCsv`
 * ——它在页面里被调用并把路径**拼在页面文件里**（`Orders.tsx` / `Products.tsx` /
 * `PoolModal.tsx` / `Ledger.tsx`），所以 api 层里读不到那四个字面量。
 * 本守卫第一版因此把它们误报成"没有界面出口"，而实际上**入口一直都在**
 * （导出按钮就在订单页/商品页/码池弹窗/财务页上）。
 *
 * ⚠️ 判据必须仍然是"**这一行是一次下载调用**"，不能放宽成"全仓某处出现过这个路径"——
 * 后者会被注释与文档骗过（本仓踩过同款：`readDdl` 用反引号当右界，注释里的反引号
 * 让两条断言同时沉默）。所以这里只认 `fetchExportCsv(` / `saveBlob(` 出现的调用行窗口，
 * 与 `hasCall` 的窗口规则同款。
 */
function frontendPageLines() {
  const files = walk(path.join(REPO, 'frontend', 'src')).filter((f) => /\.tsx?$/.test(f));
  return files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n'));
}

/** 递归列出目录下的文件（`.ts` / `.tsx`） */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * **直接下载函数**：不走 `{code,message,data}` JSON 封装、自己 `fetch` 取字节流的那几个。
 *
 * 本仓目前三处（都在 `api/node.ts`）：
 *   · `fetchExportCsv` —— 四条 CSV 导出的公共底层；
 *   · `exportLedgerCsv` —— 按业务封装的流水导出（带"毫秒 → ISO"的换算）；
 *   · `downloadEvidenceFile` —— 争议证据附件（图片 inline / PDF attachment）。
 *
 * 为什么识别它们就够：这几个函数的**函数体里就有路径字面量**，所以"这个接口有没有出口"
 * 等价于"这个函数有没有被页面（或 api 层别处）调用"。
 *
 * 反过来，把路径拼成变量的写法（`const path = \`/api/…\`; fetchExportCsv(origin, path, …)`）
 * 会**两条判据都不满足** —— 那正是我们要它红的形状：四条导出原先就是这么写的，
 * 本守卫第一次跑就把它们指了出来（而其中一条还带出一个真缺陷：见 Ledger 的毫秒/ISO 混用）。
 */
const DOWNLOAD_CALLS = ['fetchExportCsv', 'exportLedgerCsv', 'downloadEvidenceFile'];

/**
 * 把 Express 风格路径转成"能出现在 URL 模板里"的形状。
 *
 * `:id` 这类参数段要同时接受三种真实写法（本仓三种都有）：
 *   · 模板插值           `` `/api/shops/applications/${id}/review` ``
 *   · 编码调用           `` `/api/products/${encodeURIComponent(slug)}/reviews` ``
 *   · 直接拼接           `'/api/shop/claims/' + encodeURIComponent(id) + '/revoke'`
 * 所以参数段匹配"不含斜杠的一段"，而不是某个具体形状。**字面量段照旧逐字匹配**
 * （大小写敏感），这才是它拦住"路径写错"的地方。
 */
function urlRe(p) {
  const body = p
    .split('/')
    .map((seg) => (seg.startsWith(':') ? "[^/'`]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  /*
    ⚠️ **结尾边界不能省**：路径后面只能接"URL 里合法的那种字符"（引号、反引号、`?`、`#`、
    空白、`$` 模板插值、`/`），否则子串匹配会把 `/api/shop/staking-typo` 判成
    `/api/shop/staking` 的命中 —— 变异测试（把路径改一个字母）第一版就是这么**假通过**的，
    而"改错一个字母"正是这个守卫最该抓的形状。
  */
  return new RegExp(body + "(?=['\"`?#\\s$/]|$)");
}

/**
 * 某条路径在前端 API 层是否有**真实调用**。
 *
 * 判据形状：先找**一次 http 客户端调用**，再看那条**路径**是否出现在它前后 `WINDOW` 行之内。
 *
 * 为什么要窗口而不是"同一行"：本仓三种写法都有 ——
 *
 *     return http.get<T>(normOrigin(origin), '/api/shop/claims');   // 单行
 *     return http.get<T>(                                           // 多行
 *       normOrigin(origin),
 *       `/api/shops/applications/list${all ? '?all=1' : ''}`,
 *       token
 *     );
 *     return http                                                  // 链式（跨行）
 *       .get<T>(normOrigin(origin), '/api/shop/claims')
 *       .then(…);
 *
 * 所以"调用点"识别两种结尾：`http.<method>`，以及 `http` 换行之后的 `.<method><泛型?>(`
 * ——后者正是 `http` / `.get<T>(…)` 那两行里的第二行（第一版只认前者，
 * 于是把 `.get<T>(…)` 这种写法全判成"没有调用"，一口气误报 12 条）。
 *
 * ⚠️ 为什么不等于"全仓出现过这个字样"：`调用点`必须真的是一次网络调用。
 * 注释里写 `// 见 /api/shop/claims` 不算（那一行不是调用），文档同理。
 * 本仓在这一处踩过同款坑：`readDdl` 用一个反引号当右界，于是注释里的反引号让两条断言
 * 同时沉默 —— 判据必须钉在"**这一行做的事**"，而不是"某个字符串在某处出现过"。
 */
const WINDOW = 6;
/** 跨行链式形态：`  .get<T>(` / `  .del(…` */
const CHAINED_CALL = /^\s*\.[a-z]+(<[^>]*>)?\(/;

/** 这一行是不是一次 http 客户端调用（`prevLine` 用来认跨行链式的第一行 `return http`） */
function isHttpCallLine(line, prevLine, method) {
  if (line.includes(`http.${method}`)) return true;
  return (
    CHAINED_CALL.test(line) &&
    line.includes(`.${method}`) &&
    (line.includes('http') || String(prevLine || '').includes('http'))
  );
}

/** 页面层里"把这份文件下载下来"的调用（判据同款：调用行 + 窗口内的路径） */
function isDownloadCallLine(line) {
  return DOWNLOAD_CALLS.some((c) => line.includes(c));
}

function hasCall(lines, method, p) {
  const re = urlRe(p);
  for (let i = 0; i < lines.length; i++) {
    if (!isHttpCallLine(lines[i], lines[i - 1], method)) continue;
    const from = Math.max(0, i - WINDOW);
    const to = Math.min(lines.length, i + WINDOW + 1);
    for (let j = from; j < to; j++) if (re.test(lines[j])) return true;
  }
  return false;
}

function hasDownloadCall(lines, p) {
  const re = urlRe(p);
  /*
    ⚠️ 窗口刻意放大到 `WINDOW × 2`：下载函数的函数体普遍是"多行 fetch" ——
    路径在 `fetch(` 那几行**里面**，而"直接下载函数"的**声明**离它还有一段距离
    （`export async function downloadEvidenceFile(` 与那句 fetch 相隔 5 行以上）。
    按 6 行取时 `downloadEvidenceFile` 会被误判成"没有出口"（实测踩到）。
    这也说明这一类判据的固有边界：它是**近似**，所以它只在"路径被拼成变量"这种
    真正无法回答的形状上红，而不去猜运行期会请求什么。
  */
  const W = WINDOW * 2;
  for (let i = 0; i < lines.length; i++) {
    if (!isDownloadCallLine(lines[i])) continue;
    const from = Math.max(0, i - W);
    const to = Math.min(lines.length, i + W + 1);
    for (let j = from; j < to; j++) if (re.test(lines[j])) return true;
  }
  return false;
}

/**
 * 一个接口算不算"有界面出口"：api 层的 `http.<method>(…)`，或页面层的**下载**调用。
 *
 * 三条判据，**都要求"这一行真的在做那件事"**：
 *   ① api 层里有一次 `http.<method>` 调用，窗口内有这条路径；
 *   ② 页面层里有一次下载调用，窗口内有这条路径；
 *   ③ api 层里这个**路径字面量本身**是某次下载调用的实参 —— 即
 *      `return fetchExportCsv(origin, '/api/shop/export/products.csv', token)` 这种薄封装。
 *
 * ③ 为什么必须独立成一条：`exportProductsCsv` 把路径交给自研的下载函数，而那个函数
 * 定义在文件另一处（**不在同一个窗口里**）。没有 ③ 时这层薄封装会被判成"没有出口"，
 * 而它存在的意义恰恰是"路径只有一处真相"。
 *
 * ⚠️ ③ 与"全仓出现过这个字样"的区别：它要求那一行**是下载调用的实参**，
 * 注释里写一句 `// 见 /api/shop/export/products.csv` 不算（注释里不写 `fetchExportCsv(`）。
 *
 * ⚠️ 下载调用**刻意不看方法**：`fetchExportCsv` 内部就是一次 GET，而调用点写的是
 * `fetchExportCsv(origin, '/api/shop/export/orders.csv', token)` —— 路径在那儿、方法不在。
 * 要求"这一行也必须出现 get"会把四条**本来就有入口**的导出误判成缺失（第一版正是这么误报的）。
 */
function hasEntry(method, p) {
  if (hasCall(frontendApiLines(), method, p)) return true;
  if (hasDownloadCall(frontendPageLines(), p)) return true;
  return hasDownloadCall(frontendApiLines(), p);
}

test('节点每个写接口都在前端 API 层有真实调用（没有"只有后端会做的事"）', () => {
  const prefixes = mountPrefixes();
  const missing = [];
  let checked = 0;

  for (const { routerVar, file } of routerFiles()) {
    const mounts = prefixes.get(routerVar) || [];
    for (const r of routesOf(file)) {
      if (!WRITE_METHODS.includes(r.method)) continue;
      for (const prefix of mounts) {
        // Express 路径里的 `/` 结尾与空串：拼出来去掉尾斜杠，与前端写法对齐
        const full = `${prefix}${r.p}`.replace(/\/+$/, '') || prefix;
        if (EXEMPT[full]) continue;
        checked += 1;
        if (!hasEntry(CLIENT_METHOD[r.method] || r.method, full)) {
          missing.push(`${r.method.toUpperCase()} ${full}   （${file}）`);
        }
      }
    }
  }

  assert.ok(checked >= 40, `只解析出 ${checked} 条写接口，解析器疑似坏了（路由写法变了？）`);
  assert.deepEqual(
    [...new Set(missing)],
    [],
    '以下写接口在 frontend/src/api/*.ts 里没有真实调用 ⇒ 用户无法从网页完成这件事。\n' +
      '要么补界面入口，要么在 EXEMPT 里写清"为什么它不该有界面"：\n  ' +
      [...new Set(missing)].join('\n  ')
  );
});

test('节点读接口同样要有出口（图片/探活这类"不经 API 层"的写在 EXEMPT_GET 里）', () => {
  const prefixes = mountPrefixes();
  const missing = [];
  let checked = 0;

  /*
    ⚠️ 读接口的例外只能写"**不经 API 层**"（浏览器直接取图、容器探活），
    不能写"这个页面还没做" —— 那正是本守卫要抓的东西。
  */
  for (const { routerVar, file } of routerFiles()) {
    const mounts = prefixes.get(routerVar) || [];
    for (const r of routesOf(file)) {
      if (r.method !== 'get') continue;
      for (const prefix of mounts) {
        const full = `${prefix}${r.p}`.replace(/\/+$/, '') || prefix;
        if (EXEMPT[full] || EXEMPT_GET[full]) continue;
        // 路由挂载在 `/api/uploads` 下的两条（见 EXEMPT_GET）按前缀跳过
        if (Object.keys(EXEMPT_GET).some((k) => full.startsWith(k))) continue;
        checked += 1;
        if (!hasEntry('get', full)) missing.push(`GET ${full}   （${file}）`);
      }
    }
  }

  assert.ok(checked > 30, `只解析出 ${checked} 条读接口，解析器疑似坏了`);
  assert.deepEqual([...new Set(missing)], [], '以下读接口没有前端调用：\n  ' + [...new Set(missing)].join('\n  '));
});
