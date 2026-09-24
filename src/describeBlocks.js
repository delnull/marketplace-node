/**
 * 商品详情块（文字 + 图片混排）。
 *
 * 模型：`[{ type:'text', text } | { type:'image', url }]` —— **结构化块而非富文本/HTML**。
 * 这是刻意的选择：
 *  - HTML 需要一套 sanitizer 才能安全渲染，而 sanitizer 的绕过史就是一部 XSS 史；
 *    结构化块没有「可执行内容」这个类别，渲染时是纯粹的 React 元素，不存在注入面。
 *  - 块是数据，能安全地参与快照哈希、能被未来的导出/迁移直接消费。
 *
 * 与 `description`（纯文本）的关系：
 *  - `description` 保留，但降级为**由块派生的可搜索摘要**（服务端写入时派生）
 *    —— 商品搜索走 SQL LIKE，用户输入的是文字，不该去匹配 JSON 里的引号与 url
 *  - 块为空时，`description` 就是店主填的纯文本，前端直接按段落渲染（保持原有观感）
 */
import { UPLOAD_URL_PREFIX } from './productImages.js';

export const MAX_BLOCKS = 40;
export const MAX_TEXT_LEN = 2000;
/** 派生摘要上限：够搜索用，又不是把整篇富文本塞进列表接口 */
export const MAX_DERIVED_DESC = 5000;

/**
 * 规范化详情块：
 *  - 丢弃空块（空文字、空 URL）
 *  - 合并相邻文字块（前端一次换行编辑容易产生碎块，留着只会让渲染结果多出空行）
 *  - 校验图片 URL（只接受 http(s) 外链与本站上传路径 —— 与商品图同一条白名单，
 *    挡 javascript:/data: 这类将来可能被用在其它渲染上下文的 scheme）
 * @returns {{ errors: string[], blocks: Array }}
 */
export function normalizeBlocks(input) {
  const errors = [];
  if (input === undefined || input === null) return { errors, blocks: [] };
  if (!Array.isArray(input)) {
    errors.push('descriptionBlocks 需为数组（[{type:"text"|"image", ...}]）');
    return { errors, blocks: [] };
  }
  if (input.length > MAX_BLOCKS) {
    errors.push(`详情块最多 ${MAX_BLOCKS} 个`);
    return { errors, blocks: [] };
  }
  const blocks = [];
  for (const raw of input) {
    const type = String(raw?.type || '');
    if (type === 'text') {
      const text = String(raw?.text ?? '').replace(/\r\n/g, '\n').trim();
      if (!text) continue;
      if (text.length > MAX_TEXT_LEN) {
        errors.push(`单个文字块不超过 ${MAX_TEXT_LEN} 字`);
        continue;
      }
      const last = blocks[blocks.length - 1];
      // 相邻文字块合并（保留换行语义）
      if (last && last.type === 'text') last.text = `${last.text}\n${text}`;
      else blocks.push({ type: 'text', text });
    } else if (type === 'image') {
      const url = String(raw?.url ?? '').trim().slice(0, 500);
      if (!url) continue;
      const okScheme = /^https?:\/\//i.test(url) || url.startsWith(UPLOAD_URL_PREFIX);
      if (!okScheme) {
        errors.push('详情图片仅支持 http/https 外链或本站上传的图片');
        continue;
      }
      blocks.push({ type: 'image', url });
    } else if (type) {
      errors.push(`不支持的详情块类型：${type}`);
    }
  }
  return { errors, blocks };
}

/** 由块派生纯文本摘要（供 SQL LIKE 搜索；图片块以占位符保留段落节奏） */
export function deriveDescription(blocks) {
  const text = (blocks || [])
    .map((b) => (b.type === 'text' ? b.text : '[图片]'))
    .join('\n')
    .trim();
  return text.slice(0, MAX_DERIVED_DESC);
}

/** 解析库里的块 JSON（容错：脏数据当作无块） */
export function parseBlocks(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
