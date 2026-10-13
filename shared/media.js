/**
 * 商品媒体（主图区的图片与视频）——**字节判据、类型上限与 URL 规则的唯一实现**。
 *
 * 为什么单独一份、放在 shared/：节点要拿它校验/落盘，前端要拿它做 `<input accept>`、
 * 提交前预检与上限提示。两边各写一份的下场在本仓已经出现过（图片白名单曾同时存在于
 * `node/src/productImages.js`、`node/src/evidenceFiles.js`、`frontend/src/pages/seller/shared.ts`
 * 与 `frontend/src/components/EvidenceModal.tsx` 四处），改一处漏一处就是"前端允许传、后端拒收"
 * 或反过来的静默漂移。这里与 `shared/shopCode.js` 同一取向：**规则只留一份**，
 * 前端 `src/**` 直接 import（见 `frontend/vite.config.ts` 的 `server.fs.allow`），
 * 测试侧读源码文本对拍（测试构建的 rootDir 出不了 frontend/，见 `tsconfig.test.json`）。
 *
 * ── 两条口径 ────────────────────────────────────────────────────────────────
 *  1. **类型由字节判定，不由客户端声明的 MIME 决定**（`sniffMediaMime`）。
 *     声明只用来给错误文案加一点上下文；谁能落盘、落成什么扩展名，一律看真实字节。
 *  2. **容器可判、编码不可判**：`ftyp` / EBML 能判出"这是一个 MP4/WebM 容器"，
 *     但判不出里面的编码是不是浏览器放得了（HEVC-in-MP4 会通过嗅探而在部分浏览器黑屏）。
 *     服务端不引 ffmpeg（不转码、不抽帧），能不能播由**店主上传时的封面抓帧自检**兜住
 *     ——那一步失败就说明这段视频在店主这台设备上解不出来，表单不给保存。
 */

/** 单张商品图上限（2MB）：商品图是缩略展示用，再大属于店主没压缩 */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** 单个商品视频上限（50MB）：够一段 30~60 秒的手机短视频，又不至于把节点磁盘吃穿 */
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 主图区条目上限：合计 ≤10 项、其中视频 ≤3 个。
 * 为什么合计给 10（旧口径是图片 9 张）：主图区是"买家第一眼"，视频占位后仍要留够图片位；
 * 为什么视频只给 3：不转码的前提下，每段视频都是一份原始码流，三个已经是"一段主视频 + 两段补充"。
 */
export const MAX_MEDIA_ITEMS = 10;
export const MAX_VIDEO_ITEMS = 3;

/**
 * 单次上传的**传输上限**（= 表内最大者）。
 *
 * 为什么不是"按声明的类型分开限"：类型要等字节到了才知道（口径 1），
 * 而流式上传必须在**读之前**就定下"读到多少字节必须掐断"。若按声明类型限，
 * 一个把视频声明成 image/png 的客户端会在 2MB 处被掐断，报出来的错还是"图片超限"——
 * 那正是"信声明"的旧毛病。代价如实写：一次垃圾上传最多能写 50MB 才被丢弃，
 * 由路由侧的请求限流 + 临时文件即删兜住。
 */
export const MAX_UPLOAD_BYTES = VIDEO_MAX_BYTES;

/**
 * 字节签名表：`at` 是固定偏移处的字节，`window` 是"在 [from,to) 区间内出现过"。
 * 元素可以是数字数组，也可以是字符串（按 latin1 逐字符比较）。
 *
 * 视频只收 MP4 容器（偏移 4 处必须是 `ftyp` box）与 WebM（EBML 头 + 前 64 字节内出现 `webm`）。
 * 刻意不收 mkv（EBML 同头但 DocType 是 `matroska`，浏览器放不了）、
 * 不收 3gp/avi/flv 这类容器。`docType` 判据让 mkv 被如实拒绝，而不是被当成 webm 落盘。
 */
export const MEDIA = {
  'image/png': {
    kind: 'image',
    ext: 'png',
    maxBytes: IMAGE_MAX_BYTES,
    at: [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]],
  },
  'image/jpeg': { kind: 'image', ext: 'jpg', maxBytes: IMAGE_MAX_BYTES, at: [[0, [0xff, 0xd8, 0xff]]] },
  // WEBP = "RIFF" + 4 字节长度 + "WEBP"
  'image/webp': {
    kind: 'image',
    ext: 'webp',
    maxBytes: IMAGE_MAX_BYTES,
    at: [
      [0, 'RIFF'],
      [8, 'WEBP'],
    ],
  },
  'image/gif': { kind: 'image', ext: 'gif', maxBytes: IMAGE_MAX_BYTES, at: [[0, 'GIF8']] },
  // MP4：偏移 4 起是 box 类型 `ftyp`（前 4 字节是 box 长度，不参与判据）
  'video/mp4': { kind: 'video', ext: 'mp4', maxBytes: VIDEO_MAX_BYTES, at: [[4, 'ftyp']] },
  // WebM：EBML 魔数 + 头部 DocType 必须是 webm（mkv 的 DocType 是 matroska ⇒ 落到下一个分支判不中）
  'video/webm': {
    kind: 'video',
    ext: 'webm',
    maxBytes: VIDEO_MAX_BYTES,
    at: [[0, [0x1a, 0x45, 0xdf, 0xa3]]],
    window: [[0, 64, 'webm']],
  },
  // PDF 只服务证据附件（商品媒体不收）：放进同一张表的理由是"字节 → 类型"这件事只有一处实现，
  // 谁允许收是各路自己 policiy（见 node/src/evidenceFiles.js）。
  'application/pdf': { kind: 'document', ext: 'pdf', maxBytes: null, at: [[0, '%PDF']] },
};

/** 商品媒体白名单（主图区）：图片 + 视频，按表内声明顺序 */
export const PRODUCT_MEDIA_MIMES = Object.keys(MEDIA).filter((m) => MEDIA[m].kind !== 'document');

/** 上传对外 URL 前缀（节点相对路径：节点换域名/迁移时历史数据不用回填） */
export const UPLOAD_URL_PREFIX = '/api/uploads/';

/** `<input accept>` 用：MIME 列表 + 扩展名（部分安卓/桌面文件选择器只认扩展名） */
function acceptOf(mimes) {
  const exts = mimes.filter((m) => MEDIA[m]).map((m) => `.${MEDIA[m].ext}`);
  return [...mimes, ...exts].join(',');
}

export const IMAGE_ACCEPT = acceptOf(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const VIDEO_ACCEPT = acceptOf(['video/mp4', 'video/webm']);
export const MEDIA_ACCEPT = acceptOf(PRODUCT_MEDIA_MIMES);

/** 逐字节比较（字符串按 latin1） */
function bytesAt(buf, off, sig) {
  if (!buf || buf.length < off + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    const want = typeof sig === 'string' ? sig.charCodeAt(i) : sig[i];
    if (buf[off + i] !== want) return false;
  }
  return true;
}

function foundInWindow(buf, from, to, sig) {
  const end = Math.min(buf.length, to);
  for (let i = from; i + sig.length <= end; i += 1) if (bytesAt(buf, i, sig)) return true;
  return false;
}

/**
 * 真实字节 → MIME（认不出来返回 null）。
 *
 * 这是**唯一**的"这段字节是什么"判据：落盘前的校验、读取时的 Content-Type、
 * 证据附件与商品媒体都走它。表内的顺序即优先级（当前各签名互不重叠）。
 */
export function sniffMediaMime(buf) {
  // 用 Uint8Array 而不是 node 的 Buffer：本文件前后端共用，前端没有 Buffer 这个全局。
  // node 的 Buffer 本身就是 Uint8Array 的子类，传进来照样按索引比较。
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
  for (const [mime, spec] of Object.entries(MEDIA)) {
    if (!(spec.at || []).every(([off, sig]) => bytesAt(b, off, sig))) continue;
    if (!(spec.window || []).every(([from, to, sig]) => foundInWindow(b, from, to, sig))) continue;
    return mime;
  }
  return null;
}

/** MIME → 单文件上限（表里没有的类型返回 null） */
export function mediaMaxBytes(mime) {
  const spec = MEDIA[String(mime || '').toLowerCase()];
  return spec ? spec.maxBytes : null;
}

/** MIME → 存储扩展名（表里没有的类型返回 null） */
export function mediaExt(mime) {
  const spec = MEDIA[String(mime || '').toLowerCase()];
  return spec ? spec.ext : null;
}

/**
 * 商品媒体 URL 规则（**唯一判据**）：只接受 http(s) 外链或本站上传路径。
 *
 * 为什么必须收口：`javascript:` / `data:` 这类 scheme 一旦进入未来的富文本或别的渲染上下文
 * 就可能被利用（当前 `<img>`/`<video>` 的 src 上下文执行面≈0，但判据不该依赖"当前怎么渲染"）。
 * 商品主图、详情块图片走的是同一个函数——同一条规则只有一处。
 */
export function mediaUrlAllowed(url) {
  const u = String(url || '').trim();
  return /^https?:\/\//i.test(u) || u.startsWith(UPLOAD_URL_PREFIX);
}

/** 校验结果里的 URL 归一（trim + 截断），与 `mediaUrlAllowed` 配套使用 */
export function normalizeMediaUrl(url) {
  return String(url ?? '').trim().slice(0, 500);
}

/**
 * 主图区数组 → 第一项的**缩略图 URL**（图片取 url、视频取 poster）；空/形状不对返回 null。
 *
 * 跨端共用的读取口径：卡片缩略图、订单行、结算页、仲裁队列都只想要"一张能当缩略图的图"，
 * 各自去写 `media[0].url` 的话，视频项会被渲染成裂图（它的 url 是 mp4）。
 * 返回的是**节点原始值**（可能是 `/api/uploads/…` 相对路径），绝对化由展示层的解析函数负责。
 */
export function firstMediaThumb(media) {
  const first = Array.isArray(media) ? media[0] : null;
  if (!first || typeof first !== 'object') return null;
  const url = first.type === 'video' ? first.poster : first.url;
  return typeof url === 'string' && url ? url : null;
}
