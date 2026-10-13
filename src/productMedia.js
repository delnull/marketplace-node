/**
 * 商品媒体（主图区图片 + 视频）的落盘与读取。
 *
 * ── 为什么是「上传到节点」而不是让店主填外链 ────────────────────────────────
 * 联邦制下每家店自己持有自己的资源才叫联邦 —— 外链商品图一旦对方图床挂掉/改图，
 * 买家看到的商品与下单时锁定的快照就脱钩了（快照哈希只覆盖 URL 字符串，覆盖不到内容）。
 * 落盘到本节点后，URL 与内容是同一份事实，节点在则媒体在。
 *
 * 存储布局：<库文件所在目录>/uploads/<uuid>.<ext>
 *  - 与证据附件同款（见 evidenceFiles.js）：按库目录定位，删库即清干净、不会散落在 cwd
 *  - 文件名用随机 UUID，不用原始名：防路径穿越、防覆盖、防原始名泄露店主本地信息
 *
 * 安全约定：
 *  - **类型由字节判定**（`shared/media.js` 的 `sniffMediaMime`）：白名单是
 *    png/jpeg/webp/gif 图片与 mp4/webm 视频；不收 svg（可内嵌脚本）、不收 pdf/任意二进制、
 *    不收 mkv（EBML 同头但 DocType 是 matroska，浏览器放不了）。
 *  - 单文件上限按类型（图片 2MB / 视频 50MB）；**传输上限**是表内最大者，
 *    超出即断流并删除临时文件（见 `storeMediaStream`）。
 *  - 落盘用 flag 'wx'（不覆盖已存在文件）；上传先写同目录临时文件，校验通过后 rename
 *    —— 同目录 rename 是原子的，读取方永远不会看到"半个文件"。
 *  - 对外只返回**相对路径** `/api/uploads/<file>`，由前端按媒体所属节点的 origin 拼绝对地址。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';
import {
  MEDIA,
  PRODUCT_MEDIA_MIMES,
  MAX_UPLOAD_BYTES,
  UPLOAD_URL_PREFIX,
  mediaExt,
  sniffMediaMime,
} from './mediaKinds.js';

export { UPLOAD_URL_PREFIX };

/** 上传失败的业务错误（路由层按"用户可修"处理，别冒成 500） */
export class MediaUploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaUploadError';
    this.code = code;
  }
}

const MB = (n) => Math.round(n / 1024 / 1024);

/**
 * 嗅探需要的最大字节数：表内固定偏移最深 12 字节（webp 的 'WEBP' 在 8..11），
 * webm 的 DocType 扫描窗口到 64。取 64 即可覆盖全部签名——**读头一次就够**，
 * 不必为了判类型把整段视频读进内存。
 */
const SNIFF_BYTES = 64;

/** 上传目录（跟随库文件位置；内存库（测试）落到 cwd 下的 .uploads） */
export function uploadsDir() {
  const dbFile = config.db.file;
  const base = !dbFile || dbFile === ':memory:' ? process.cwd() : path.dirname(path.resolve(dbFile));
  return path.join(base, dbFile === ':memory:' ? '.uploads' : 'uploads');
}

/** 读文件头（判定用），文件比 SNIFF_BYTES 短就按实际长度读 */
function readHead(disk) {
  const fd = fs.openSync(disk, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** 临时文件路径（同目录：rename 才是原子的） */
function tempPath(dir) {
  return path.join(dir, `.tmp-${crypto.randomUUID()}.part`);
}

/**
 * 校验并落盘一个已写满的临时文件。
 * @returns {{ url: string, kind: 'image'|'video', mime: string, size: number, sha256: string }}
 */
function finalize({ dir, tmp, size, sha256 }) {
  if (!size) {
    discard(tmp);
    throw new MediaUploadError('empty', '上传内容为空');
  }
  const mime = sniffMediaMime(readHead(tmp));
  if (!mime || !PRODUCT_MEDIA_MIMES.includes(mime)) {
    discard(tmp);
    throw new MediaUploadError(
      'unsupported',
      '无法识别的文件内容：主图区只收 png / jpeg / webp / gif 图片，或 mp4 / webm 视频'
    );
  }
  const spec = MEDIA[mime];
  if (spec.maxBytes && size > spec.maxBytes) {
    discard(tmp);
    const what = spec.kind === 'video' ? '视频' : '图片';
    throw new MediaUploadError(
      'too_large',
      `${what}超过 ${MB(spec.maxBytes)}MB 上限（当前 ${(size / 1024 / 1024).toFixed(1)}MB）`
    );
  }
  const stored = `${crypto.randomUUID()}.${spec.ext}`;
  fs.renameSync(tmp, path.join(dir, stored));
  return { url: `${UPLOAD_URL_PREFIX}${stored}`, kind: spec.kind, mime, size, sha256 };
}

function discard(disk) {
  try {
    fs.rmSync(disk, { force: true });
  } catch {
    /* 删不掉就算了：临时文件是 `.tmp-*.part`，读取端按 UUID.ext 白名单取文件，永远不会被读到 */
  }
}

/**
 * 把请求体**流式**写入上传目录，边写边计字节数与 sha256，写完再按字节判类型与上限。
 *
 * 为什么不用 base64 JSON（旧实现）：base64 再膨胀 33%，50MB 的视频要变成 ~67MB 的字符串，
 * 而且整份内容要在内存里待两遍。流式写入的内存占用是常量，代价是"类型要等字节到了才知道"
 * ⇒ 传输上限只能取表内最大者（见 shared/media.js 的 MAX_UPLOAD_BYTES 注释）。
 *
 * @param {import('node:stream').Readable} stream 请求体（req）
 * @returns {Promise<{url:string,kind:string,mime:string,size:number,sha256:string}>}
 */
export function storeMediaStream(stream) {
  return new Promise((resolve, reject) => {
    const dir = uploadsDir();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = tempPath(dir);
    let settled = false;
    let size = 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(tmp, { flags: 'wx' });

    const fail = (err) => {
      if (settled) return;
      settled = true;
      stream.unpipe?.(out);
      stream.destroy?.();
      out.destroy();
      discard(tmp);
      reject(err);
    };

    stream.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        fail(new MediaUploadError('too_large', `上传内容超过 ${MB(MAX_UPLOAD_BYTES)}MB 上限`));
        return;
      }
      hash.update(chunk);
      // 背压：磁盘写不动就暂停读，别把整段视频堆在内存里
      if (!out.write(chunk)) {
        stream.pause();
        out.once('drain', () => stream.resume());
      }
    });
    stream.on('error', (e) => fail(new MediaUploadError('io', `上传中断：${e?.message || e}`)));
    stream.on('close', () => {
      // 客户端中途断开：读完（readableEnded）才算正常结束，否则别把半个文件当成品
      if (!settled && !stream.readableEnded) fail(new MediaUploadError('io', '上传中断（连接被关闭）'));
    });
    out.on('error', (e) => fail(new MediaUploadError('io', `写入失败：${e?.message || e}`)));
    stream.on('end', () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        settled = true;
        try {
          resolve(finalize({ dir, tmp, size, sha256: hash.digest('hex') }));
        } catch (e) {
          reject(e);
        }
      });
    });
  });
}

/** 一次性写入（测试与脚本用；生产路径是 `storeMediaStream`） */
export function storeMediaBuffer(data) {
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tempPath(dir);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  fs.writeFileSync(tmp, buf, { flag: 'wx' });
  return finalize({ dir, tmp, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
}

/** uuid.(png|jpg|webp|gif|mp4|webm) → 扩展名白名单（与类型表同源，改表即改这里） */
const STORED_NAME_RE = new RegExp(
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(${[
    ...new Set(PRODUCT_MEDIA_MIMES.map((m) => mediaExt(m))),
  ].join('|')})$`
);

/**
 * 按对外文件名定位磁盘文件。只接受 `uuid.ext` 形状 ——
 * 直接把用户输入拼进路径是最经典的穿越漏洞来源，这里用白名单正则收口。
 * @returns {{ disk: string, mime: string, kind: string } | null}
 */
export function findMedia(name) {
  const base = String(name || '');
  if (!STORED_NAME_RE.test(base)) return null;
  const disk = path.join(uploadsDir(), base);
  // 再确认解析后的路径确实还在上传目录内（双保险）
  if (path.dirname(path.resolve(disk)) !== path.resolve(uploadsDir())) return null;
  if (!fs.existsSync(disk)) return null;
  const ext = base.split('.').pop();
  const mime = PRODUCT_MEDIA_MIMES.find((m) => mediaExt(m) === ext);
  if (!mime) return null;
  return { disk, mime, kind: MEDIA[mime].kind };
}

/**
 * 上传目录用量（{ files, bytes }），60 秒缓存。
 *
 * 为什么要暴露它：孤儿媒体**刻意不删**（订单快照锁的是 URL 字符串，删文件会让历史订单变裂图），
 * 而视频把单个孤儿的成本从 2MB 抬到 50MB —— 磁盘成了这个功能新引入的失败面，
 * 运维必须能在 `/healthz` 上看见它（否则只有"写满磁盘那天"才发现）。
 */
let usageCache = { at: 0, value: { files: 0, bytes: 0 } };
export function mediaUsage({ ttlMs = 60_000, now = Date.now() } = {}) {
  if (now - usageCache.at < ttlMs) return usageCache.value;
  let files = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(uploadsDir())) {
      if (name.startsWith('.tmp-')) continue;
      try {
        const st = fs.statSync(path.join(uploadsDir(), name));
        if (st.isFile()) {
          files += 1;
          bytes += st.size;
        }
      } catch {
        /* 并发删除：跳过 */
      }
    }
  } catch {
    /* 目录还不存在 = 用量为 0 */
  }
  usageCache = { at: now, value: { files, bytes } };
  return usageCache.value;
}
