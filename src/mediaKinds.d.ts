/**
 * `node/src/mediaKinds.js` 的类型声明 —— 前端（TypeScript）能直接 import 同一份实现。
 *
 * 为什么不是"前端再写一份常量"：商品媒体的白名单（png/jpeg/webp/gif + mp4/webm）、
 * 单文件上限（图片 2MB / 视频 50MB）、主图区条数上限（合计 10 项、视频 3 个）与 URL 规则
 * 必须与节点**逐字一致**；两份副本的下场是"前端允许传、后端拒收"（或反过来）的静默漂移。
 * 与 `node/src/shopCode.js` + `node/src/shopCode.d.ts` 同一取向：规则一份，声明跟着实现走
 * （这份规则为什么住在节点包里而不是节点包：见 `mediaKinds.js` 文件头）。
 *
 * 声明与 `node/src/mediaKinds.js` 的导出逐字对应；改 JS 导出必须同步本文件。
 */

/** 媒体类型（图片 / 视频 / 文档） */
export type MediaKind = 'image' | 'video' | 'document';

/** 类型表的一行：谁能落盘、落成什么扩展名、单文件上限、字节签名 */
export interface MediaSpec {
  kind: MediaKind;
  ext: string;
  maxBytes: number | null;
  /** 固定偏移处的字节签名：[偏移, 字节或字符串] */
  at?: [number, string | number[]][];
  /** 窗口内出现即命中：[起点, 终点, 字节或字符串] */
  window?: [number, number, string | number[]][];
}

export declare const IMAGE_MAX_BYTES: number;
export declare const VIDEO_MAX_BYTES: number;
export declare const MAX_MEDIA_ITEMS: number;
export declare const MAX_VIDEO_ITEMS: number;
export declare const MAX_UPLOAD_BYTES: number;
export declare const MEDIA: Record<string, MediaSpec>;
export declare const PRODUCT_MEDIA_MIMES: string[];
export declare const UPLOAD_URL_PREFIX: string;
export declare const IMAGE_ACCEPT: string;
export declare const VIDEO_ACCEPT: string;
export declare const MEDIA_ACCEPT: string;

/** 真实字节 → MIME（认不出来返回 null）。**唯一**的"这段字节是什么"判据 */
export declare function sniffMediaMime(buf: Uint8Array | number[]): string | null;

/** MIME → 存储扩展名（表里没有的类型返回 null） */
export declare function mediaExt(mime: string): string | null;

/** 商品媒体 URL 规则（http(s) 外链或本站上传路径） */
export declare function mediaUrlAllowed(url: unknown): boolean;

/** URL 归一（trim + 截断） */
export declare function normalizeMediaUrl(url: unknown): string;

/** 主图区数组 → 第一项的缩略图 URL（图片取 url、视频取 poster）；空/形状不对返回 null */
export declare function firstMediaThumb(media: unknown): string | null;
