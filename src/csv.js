/**
 * CSV 生成工具（P1-②，无依赖）：
 *  - 字段转义（引号包裹含 逗号/引号/换行 的字段）；
 *  - UTF-8 BOM（Excel 中文兼容）+ CRLF 行尾；
 *  - 行列由调用方提供（数组行），逐行 join。
 */
const BOM = '\uFEFF';

/**
 * 公式注入防护前缀：Excel/Sheets 对 = + - @ 与 tab 开头的单元格按公式执行。
 * 2026-09 加固：行首空白（空格/NBSP/U+FEFF BOM/制表/回车）后再跟公式字符同样会被
 * 部分电子表格引擎规范化后执行——统一按「去除前导空白后的首字符 ∈ 公式字符集」判定。
 */
const FORMULA_RE = /^[\s\uFEFF\u00A0]*[=+\-@]/;

/**
 * CSV 字段转义。
 * @param formulaGuard 对以 = + - @ 等开头（含前导空白后跟公式符）的单元格加 ' 前缀
 *  （防公式注入）；外部可控输入（收货姓名/地址/备注等）必须开启；码等资源原样导出时可关闭（值完整性优先）。
 */
export function csvEscape(value, { formulaGuard = true } = {}) {
  let s = String(value ?? '');
  if (formulaGuard && FORMULA_RE.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 生成 CSV 文本（含 BOM）；opts.formulaGuard=false 关闭公式前缀（码等资源原样导出） */
export function toCsv(headers, rows, opts = {}) {
  const esc = (v) => csvEscape(v, { formulaGuard: opts.formulaGuard !== false });
  const lines = [headers.map(esc).join(',')];
  for (const row of rows) lines.push(row.map(esc).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

/** 路由直接写文件响应（Content-Type text/csv; charset=utf-8 + 附件下载名） */
export function sendCsv(res, filename, headers, rows, opts = {}) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.end(toCsv(headers, rows, opts));
}
