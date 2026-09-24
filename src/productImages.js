/**
 * 商品图片存储（本地磁盘）。
 *
 * 为什么是「上传到节点」而不是让店主填外链：
 * 联邦制下每家店自己持有自己的资源才叫联邦 —— 外链商品图一旦对方图床挂掉/改图，
 * 买家看到的商品与下单时锁定的快照就脱钩了（快照哈希只覆盖 URL 字符串，覆盖不到图内容）。
 * 落盘到本节点后，URL 与内容是同一份事实，节点在则图在。
 *
 * 存储布局：<库文件所在目录>/uploads/<uuid>.<ext>
 *  - 与证据附件同款（见 evidenceFiles.js）：按库目录定位，删库即清干净、不会散落在 cwd
 *  - 文件名用随机 UUID，不用原始名：防路径穿越、防覆盖、防原始名泄露店主本地信息
 *
 * 安全约定：
 *  - 类型白名单（png/jpeg/webp/gif）—— 不收 svg（可内嵌脚本，<img> 加载虽不执行脚本，
 *    但一旦将来被用在 <object>/直接打开就是 XSS 面），也不收 pdf/任意二进制
 *  - 单文件 2MB；解析在路由层（自带 body 限制，见 app.js 的 1MB 豁免）
 *  - 落盘用 flag 'wx'（不覆盖已存在文件）
 *  - 对外只返回**相对路径** `/api/uploads/<file>`，由前端按商品所属节点拼成绝对 URL ——
 *    节点换域名/迁移时历史数据不用回填
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';

/** 单张商品图上限（2MB）：商品图是缩略展示用，再大属于店主没压缩 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** 对外 URL 前缀 */
export const UPLOAD_URL_PREFIX = '/api/uploads/';

const ALLOWED = {
  'image/png': { ext: 'png', magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  'image/jpeg': { ext: 'jpg', magic: [[0xff, 0xd8, 0xff]] },
  // WEBP = "RIFF" + 4 字节长度 + "WEBP"
  'image/webp': { ext: 'webp', magic: [[0x52, 0x49, 0x46, 0x46]], magicOffset: [[8, [0x57, 0x45, 0x42, 0x50]]] },
  'image/gif': { ext: 'gif', magic: [[0x47, 0x49, 0x46, 0x38]] },
};

/**
 * 魔数校验（源码审计 2026-09 复审，P2）：**不要只信调用方声明的 MIME**。
 *
 * 兄弟实现 `evidenceFiles.js` 早就嗅探魔数，商品图上却没有——于是任何拿到 staff 令牌的人
 * 都能把任意字节以 `.png` 落盘，并经公开的 `GET /api/uploads/:name` 原样取回
 * （一个后缀是 .png 的 HTML/ZIP）。当前不构成 XSS（Content-Type 由扩展名推导 + 全局 nosniff），
 * 但"类型白名单"这条不变量实际上不成立，而它正是上面那段文件头承诺的东西。
 */
export function sniffImageMime(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  for (const [mime, spec] of Object.entries(ALLOWED)) {
    const headOk = spec.magic.some((sig) => sig.every((byte, i) => b[i] === byte));
    if (!headOk) continue;
    const tailOk = (spec.magicOffset || []).every(([off, sig]) => sig.every((byte, i) => b[off + i] === byte));
    if (tailOk) return mime;
  }
  return null;
}

/** 上传目录（跟随库文件位置；内存库（测试）落到 cwd 下的 .uploads） */
export function uploadsDir() {
  const dbFile = config.db.file;
  const base = !dbFile || dbFile === ':memory:' ? process.cwd() : path.dirname(path.resolve(dbFile));
  return path.join(base, dbFile === ':memory:' ? '.uploads' : 'uploads');
}

/** 校验图片元信息；返回 { ok, mime, ext, rawName } 或 { error } */
export function validateImageMeta({ name, mime, size }) {
  const m = String(mime || '').toLowerCase().trim();
  if (!ALLOWED[m]) {
    return { error: `图片类型不支持（${m || '未知'}）：仅支持 png / jpeg / webp / gif` };
  }
  if (!Number.isInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) {
    return { error: `图片大小需为 1B..${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB` };
  }
  const rawName = String(name || '')
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_')
    .trim()
    .slice(0, 120);
  return { ok: true, mime: m, ext: ALLOWED[m].ext, rawName };
}

/**
 * 落盘一张商品图。
 * @param {{ mime: string, data: Buffer }}  已通过 validateImageMeta 的元信息与解码后的字节
 * @returns {{ url: string, sha256: string, size: number }}
 *
 * **写盘前再嗅一次魔数**（源码审计 2026-09 复审，P2）：声明的 MIME 与真实字节必须一致，
 * 否则拒绝落盘（不做静默改写后缀——那会留下"声明 png、实为 html"的怪异文件）。
 */
export function storeProductImage({ mime, data }) {
  const sniffed = sniffImageMime(data);
  if (sniffed !== mime) {
    throw new Error(
      `图片内容与声明的类型不符（声明 ${mime || '未知'}，实际 ${sniffed || '无法识别的格式'}）：仅接受 png / jpeg / webp / gif 的真实图片字节`
    );
  }
  const ext = ALLOWED[mime].ext;
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${crypto.randomUUID()}.${ext}`;
  const disk = path.join(dir, stored);
  // 'wx'：同名即失败（UUID 撞名本不该发生；真发生了宁可报错也不覆盖别人的图）
  fs.writeFileSync(disk, data, { flag: 'wx' });
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  return { url: `${UPLOAD_URL_PREFIX}${stored}`, sha256, size: data.length };
}

/**
 * 按对外文件名定位磁盘文件。只接受 `uuid.ext` 形状 ——
 * 直接把用户输入拼进路径是最经典的穿越漏洞来源，这里用白名单正则收口。
 */
export function findProductImage(name) {
  const base = String(name || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/.test(base)) {
    return null;
  }
  const disk = path.join(uploadsDir(), base);
  // 再确认解析后的路径确实还在上传目录内（双保险）
  if (path.dirname(path.resolve(disk)) !== path.resolve(uploadsDir())) return null;
  if (!fs.existsSync(disk)) return null;
  const ext = base.split('.').pop();
  const mime = ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/gif';
  return { disk, mime };
}

/**
 * 对外图片地址 → 可渲染的绝对 URL。
 *  - 已是 http(s) 外链：原样返回（店主自备图床仍是合法选择）
 *  - `/api/uploads/...` 这类节点相对路径：按**商品所属节点**的 origin 拼绝对地址
 * 这样同一份商品数据在不同节点/不同前端下都能正确显示。
 */
export function resolveImageUrl(url, origin) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/') && origin) return String(origin).replace(/\/+$/, '') + u;
  return u;
}
