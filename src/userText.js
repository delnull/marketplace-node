/**
 * 节点侧的**用户词表**（与前端 `utils/userTerms.ts` 同源）。
 *
 * 数据只有一份：`frontend/src/utils/userText.zh.json`。
 * 节点镜像的构建上下文是 `node/`，镜像里没有 `../frontend`，所以由
 * `scripts/sync-user-text.mjs` 复制成 `src/userText.zh.json`；
 * `test/user-text.test.js` 会逐字段对拍，副本过期即红。
 *
 * 用途只有两个：
 *   1. 给用户看的错误/提示消息（`fail()`、helper 返回的 `message`）；
 *   2. CSV 导出的表头与枚举值。
 * 日志、审计 detail、链上原始数据**不走这里**——它们可以保留技术英文。
 */
import data from './userText.zh.json' with { type: 'json' };

/** 术语表：label（用户词）/ hint（一句话解释） */
export const TERMS = data.terms;
/** 枚举表：域 → 值 → 中文 */
export const ENUMS = data.enums;

/** 未识别的枚举值：不把机器值印给用户，也不假装它不存在 */
export const UNKNOWN_VALUE = '未识别（可能是节点与本页版本不一致）';

/** 术语的用户词；未知 id 抛错（词表 id 是代码常量，不是外部输入） */
export function term(id) {
  const t = TERMS[id];
  if (!t) throw new Error(`userText: 未知术语 ${id}`);
  return t.label;
}

/** 枚举值 → 中文；未知值返回 UNKNOWN_VALUE（**不回落原值**） */
export function enumText(domain, value) {
  const table = ENUMS[domain];
  if (!table) throw new Error(`userText: 未知枚举域 ${domain}`);
  return table[String(value ?? '')] ?? UNKNOWN_VALUE;
}

/** 枚举值 → 中文；未知值返回 null（需要区分"未识别"的地方用） */
export function enumTextOrNull(domain, value) {
  const table = ENUMS[domain];
  if (!table) throw new Error(`userText: 未知枚举域 ${domain}`);
  return table[String(value ?? '')] ?? null;
}

/** 万分比 → 百分比（与前端同一口径：250 → 2.5%） */
export function fmtBps(bps) {
  const n = Number(bps);
  if (bps === null || bps === undefined || bps === '' || !Number.isFinite(n)) return '—';
  const pct = n / 100;
  if (Number.isInteger(pct)) return `${pct}%`;
  return `${pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/**
 * 时刻 → `YYYY-MM-DD HH:mm`（**默认按中国时区**，可用 `MK_TIMEZONE` 覆盖）。
 *
 * 为什么不能直接用服务器本地时区：节点跑在 `node:24-slim` 容器里，容器默认 UTC，
 * 而读这份 CSV/消息的是中国店主——`2026-11-04 12:00` 会看起来像"中午"，实际是北京时间 20:00。
 * 这不是"格式不好看"，是把一个**没有时区标记的时刻**说成了另一个时刻。
 *
 * 用户消息里也不再出现 ISO-8601 / UTC 串。`MK_TIMEZONE` 只接受 IANA 名称
 * （如 `Asia/Shanghai`）；非法值回落到默认并告警，不让一个配置错误把进程打挂。
 */
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
function makeTimeFormatter() {
  const zone = String(process.env.MK_TIMEZONE || DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE;
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    console.warn(`[userText] MK_TIMEZONE=${zone} 不是合法的 IANA 时区，已回落到 ${DEFAULT_TIME_ZONE}`);
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: DEFAULT_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
}
const TIME_FMT = makeTimeFormatter();

export function fmtTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = Object.fromEntries(TIME_FMT.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** 布尔/0-1 → 是/否（CSV 用） */
export function yesNo(value) {
  if (value === true || value === 1 || value === '1') return '是';
  if (value === false || value === 0 || value === '0') return '否';
  return '';
}
