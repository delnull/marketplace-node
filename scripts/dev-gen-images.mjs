/**
 * 演示图生成：手写最小 PNG 编码器（零依赖）。
 *
 * 为什么不用 picsum 这类外链：联邦制商城的演示应当走**本节点托管**这条真实链路 ——
 * 外链图既验证不到上传/静态服务，也让演示依赖公网（断网就是一片裂图）。
 *
 * 生成的是一张带对角渐变 + 色块的图，不是纯色方块：纯色在列表里看着像「加载失败」，
 * 有渐变与色块才像一张真的商品图，走查时更容易判断布局对不对。
 */
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 生成一张 w×h 的 RGB PNG；paint(x,y,w,h) → [r,g,b] */
export function makePng(w, h, paint) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = paint(x, y, w, h);
      const o = y * stride + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** 简易确定性伪随机（同一 seed 出同一张图，演示数据可复现） */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 一张「像商品图」的占位图：主色对角渐变 + 两个对比色块 + 底部暗带。
 * @param {number} seed 决定配色与色块位置
 */
export function makeProductPng(seed, size = 600) {
  const r = rng(seed);
  // 用 HSL 思路取一组协调的色：主色相 + 邻近色相，避免随机 RGB 那种脏色
  const hue = Math.floor(r() * 360);
  const hsl = (h, s, l) => {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = l - c / 2;
    const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hp) % 6];
    return seg.map((v) => Math.round((v + m) * 255));
  };
  const c1 = hsl(hue, 0.45, 0.62);
  const c2 = hsl(hue + 40, 0.55, 0.35);
  const c3 = hsl(hue + 180, 0.4, 0.78);

  // 色块位置（相对坐标）
  const bx = 0.15 + r() * 0.4;
  const by = 0.2 + r() * 0.35;
  const bw = 0.2 + r() * 0.25;
  const bh = 0.15 + r() * 0.3;
  const cx = 0.4 + r() * 0.4;
  const cy = 0.5 + r() * 0.3;
  const cr = 0.08 + r() * 0.12;

  return makePng(size, size, (x, y, w, h) => {
    const u = x / w;
    const v = y / h;
    // 对角渐变
    const t = Math.min(1, Math.max(0, (u + v) / 2));
    let out = [0, 1, 2].map((i) => Math.round(c1[i] + (c2[i] - c1[i]) * t));
    // 圆角色块
    if (u > bx && u < bx + bw && v > by && v < by + bh) out = c3;
    const dx = u - cx;
    const dy = v - cy;
    if (dx * dx + dy * dy < cr * cr) out = c2.map((c) => Math.round(c * 0.85));
    // 底部暗带（模拟商品图的景深/台面）
    if (v > 0.86) out = out.map((c) => Math.round(c * 0.55));
    return out;
  });
}
